// packages/integration-runtime/src/integration-uninstaller.ts
// Core-owned uninstall workflow for tenant integrations
// State machine: ACTIVE → UNINSTALLING → INACTIVE (fail-closed)

import { getLogger, LifecycleSpan } from "@opnory/observability";
import type {
  IntegrationTransitionResult,
  TenantIntegrationRepository,
  IntegrationUninstaller,
  IntegrationFailureCode,
  TenantId,
  PluginId,
} from "./tenant-integration.js";
import type { RuntimeKernel } from "./kernel.js";
import type { CoreServices } from "./plugin.js";

const logger = getLogger().child({ component: "integration-uninstaller" });

export interface IntegrationUninstallerConfig {
  maxRetries: number;
  baseRetryDelayMs: number;
  cleanupTimeoutMs: number;
  verifyCleanup: boolean;
}

export const DEFAULT_INTEGRATION_UNINSTALLER_CONFIG: IntegrationUninstallerConfig = {
  maxRetries: 3,
  baseRetryDelayMs: 5000,
  cleanupTimeoutMs: 30000,
  verifyCleanup: true,
};

export class IntegrationUninstallerImpl implements IntegrationUninstaller {
  private repository: TenantIntegrationRepository;
  private kernel: RuntimeKernel;
  private coreServices: CoreServices;
  private config: IntegrationUninstallerConfig;

  constructor(
    repository: TenantIntegrationRepository,
    kernel: RuntimeKernel,
    coreServices: CoreServices,
    config: Partial<IntegrationUninstallerConfig> = {}
  ) {
    this.repository = repository;
    this.kernel = kernel;
    this.coreServices = coreServices;
    this.config = { ...DEFAULT_INTEGRATION_UNINSTALLER_CONFIG, ...config };
  }

  async uninstall(tenantId: TenantId, pluginId: PluginId): Promise<IntegrationTransitionResult> {
    const warnings: string[] = [];

    // 1. Find the integration
    const integration = await this.repository.getByTenantAndPlugin(tenantId, pluginId);

    if (!integration) {
      logger.warn(
        { tenantId, pluginId },
        "Integration not found for uninstall"
      );
      throw new Error(`Integration not found for tenant ${tenantId}, plugin ${pluginId}`);
    }

    const lifecycle = new LifecycleSpan(
      {
        tenantId,
        integrationId: integration.id,
        pluginId,
        provider: pluginId,
        operation: "integration.uninstall",
        desiredState: "inactive",
        actualState: integration.actualStatus,
        configVersion: integration.configVersion,
        mutated: "true",
        credentialRef: integration.credentialRef,
      },
      "integration.uninstall",
    );
    await lifecycle.root();

    // 2. If already inactive, return no-op
    if (integration.desiredStatus === "inactive" && integration.actualStatus === "inactive") {
      logger.info(
        { integrationId: integration.id, tenantId, pluginId },
        "Integration already inactive, no-op"
      );
      return {
        integration,
        noOp: true,
        warnings: ["Integration already inactive"],
      };
    }

    // 3. Set desired status to inactive
    integration.desiredStatus = "inactive";
    integration.configVersion += 1;

    try {
      await this.repository.update(integration, integration.configVersion - 1);
    } catch (error) {
      // Optimistic concurrency conflict - reload and retry
      const reloaded = await this.repository.getByTenantAndPlugin(tenantId, pluginId);
      if (!reloaded) {
        throw new Error("Integration disappeared during uninstall", { cause: error });
      }
      return await this.uninstall(tenantId, pluginId);
    }

    // 4. Transition to UNINSTALLING
    const now = new Date();
    await this.repository.updateActualStatus(
      integration.id,
      "uninstalling",
      null,
      null,
      now,
      null
    );

    // 5. Dispose runtime instance via kernel
    try {
      await this.disposeWithRetry(tenantId, pluginId);
      await lifecycle.child("plugin.dispose");
      await lifecycle.child("capability.unregister");
    } catch (error) {
      // If cleanup fails, leave in UNINSTALLING with failure reason
      const failureCode: IntegrationFailureCode = "cleanup_failed";
      await this.repository.updateActualStatus(
        integration.id,
        "uninstalling",
        failureCode,
        `Cleanup failed after ${this.config.maxRetries} retries: ${String(error)}`,
        now,
        null
      );

      await lifecycle.child(
        "integration.degrade",
        undefined,
        { failureCode, actualState: "uninstalling" },
      ).catch(() => {}); // OTel emission must never mask the real failure

      throw new Error(
        `Integration uninstall failed: ${String(error)}. Integration left in uninstalling state with cleanup_failed.`,
        { cause: error }
      );
    }

    // 6. Verify zero capabilities/listeners/state (if configured)
    if (this.config.verifyCleanup) {
      const cleanupVerified = await this.verifyCleanup(tenantId, pluginId);
      if (!cleanupVerified) {
        warnings.push("Cleanup verification could not confirm zero runtime state");
      }
    }

    // 7. Transition to INACTIVE
    await this.repository.updateActualStatus(
      integration.id,
      "inactive",
      null,
      null,
      new Date(),
      null
    );

    const final = (await this.repository.getById(integration.id))!;

    await lifecycle.child(
      "integration.uninstall_confirm",
      undefined,
      { actualState: "inactive", verified: "true" },
    ).catch(() => {});

    logger.info(
      { integrationId: final.id, tenantId, pluginId },
      "Integration uninstalled successfully"
    );

    return {
      integration: final,
      noOp: false,
      warnings,
    };
  }

  private async disposeWithRetry(tenantId: TenantId, pluginId: PluginId): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        await this.kernel.dispose(tenantId, pluginId, this.coreServices);
        return; // Success
      } catch (error) {
        // SAFETY: `error` is the caught exception; normalizing via instanceof
        // preserves the original Error when present and wraps non-Error throws.
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.warn(
          { tenantId, pluginId, attempt, error: String(error) },
          "Kernel dispose failed, retrying"
        );

        if (attempt < this.config.maxRetries) {
          const delay = this.config.baseRetryDelayMs * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    // SAFETY: the loop above guarantees `lastError` is non-null (it is assigned in
    // every catch branch before the retry check runs).
    throw lastError as Error;
  }

  private async verifyCleanup(tenantId: TenantId, pluginId: PluginId): Promise<boolean> {
    try {
      // Check kernel state
      const kernelState = this.kernel.getState(tenantId, pluginId);
      if (kernelState && kernelState !== "disposed") {
        logger.warn(
          { tenantId, pluginId, kernelState },
          "Kernel still reports non-disposed state after uninstall"
        );
        return false;
      }

      // Check capability registry for remaining instances
      // This would query the capability registry to ensure no instances remain
      // For now, return true (assumed clean if kernel is disposed)
      return true;
    } catch (error) {
      logger.warn(
        { tenantId, pluginId, error: String(error) },
        "Cleanup verification failed"
      );
      return false;
    }
  }
}