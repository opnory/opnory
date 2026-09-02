// packages/integration-runtime/src/integration-installer.ts
// Core-owned install workflow for tenant integrations
// State machine: DISCOVERED → CONFIGURING → VALIDATING → ACTIVE

import { getLogger } from "@opnory/observability";
import type {
  TenantIntegration,
  CreateTenantIntegrationInput,
  IntegrationTransitionResult,
  TenantIntegrationRepository,
  IntegrationHealthChecker,
  IntegrationInstaller,
  IntegrationStatus,
  IntegrationFailureCode,
  TenantId,
} from "./tenant-integration.js";
import type { ScopedCredentialHandle } from "./tenant-integration.js";

const logger = getLogger().child({ component: "integration-installer" });

export interface IntegrationInstallerConfig {
  maxRetries: number;
  baseRetryDelayMs: number;
  healthCheckTimeoutMs: number;
}

export const DEFAULT_INTEGRATION_INSTALLER_CONFIG: IntegrationInstallerConfig = {
  maxRetries: 3,
  baseRetryDelayMs: 5000,
  healthCheckTimeoutMs: 30000,
};

export class IntegrationInstallerImpl implements IntegrationInstaller {
  private repository: TenantIntegrationRepository;
  private healthChecker: IntegrationHealthChecker;
  private credentialProvider: {
    get(tenantId: TenantId, credentialRef: string): Promise<ScopedCredentialHandle | null>;
  };
  private config: IntegrationInstallerConfig;

  constructor(
    repository: TenantIntegrationRepository,
    healthChecker: IntegrationHealthChecker,
    credentialProvider: {
      get(tenantId: TenantId, credentialRef: string): Promise<ScopedCredentialHandle | null>;
    },
    config: Partial<IntegrationInstallerConfig> = {}
  ) {
    this.repository = repository;
    this.healthChecker = healthChecker;
    this.credentialProvider = credentialProvider;
    this.config = { ...DEFAULT_INTEGRATION_INSTALLER_CONFIG, ...config };
  }

  async install(input: CreateTenantIntegrationInput): Promise<IntegrationTransitionResult> {
    const warnings: string[] = [];

    // 1. Check if integration already exists
    const existing = await this.repository.getByTenantAndPlugin(input.tenantId, input.pluginId);

    if (existing) {
      // Idempotent: if already desired active, validate and return
      if (existing.desiredStatus === "active") {
        logger.info(
          { tenantId: input.tenantId, pluginId: input.pluginId, integrationId: existing.id },
          "Integration already exists with desiredStatus=active, validating"
        );

        const validationResult = await this.validateAndActivate(existing);
        return {
          integration: validationResult.integration,
          noOp: validationResult.noOp,
          warnings: [...warnings, ...validationResult.warnings],
        };
      }

      // Update existing record to desired active
      logger.info(
        { tenantId: input.tenantId, pluginId: input.pluginId, integrationId: existing.id },
        "Updating existing integration to desiredStatus=active"
      );

      existing.desiredStatus = "active";
      existing.credentialRef = input.credentialRef;
      existing.capabilities = input.capabilities;
      existing.configVersion += 1;

      const updated = await this.repository.update(existing, existing.configVersion - 1);
      return await this.validateAndActivate(updated);
    }

    // 2. Create new integration record in DISCOVERED state
    logger.info(
      { tenantId: input.tenantId, pluginId: input.pluginId },
      "Creating new integration record"
    );

    const integration = await this.repository.create(input);

    // 3. Validate and activate
    return await this.validateAndActivate(integration);
  }

  private async validateAndActivate(
    integration: TenantIntegration
  ): Promise<IntegrationTransitionResult> {
    const warnings: string[] = [];
    let current = integration;
    let noOp = false;

    try {
      // Step 1: CONFIGURING
      await this.transitionTo(current, "configuring");
      current = (await this.repository.getById(current.id))!;

      // Validate credential reference exists
      if (!current.credentialRef) {
        warnings.push("No credential reference provided");
      }

      // Step 2: VALIDATING
      await this.transitionTo(current, "validating");
      current = (await this.repository.getById(current.id))!;

      // Resolve credentials
      if (current.credentialRef) {
        const credentials = await this.credentialProvider.get(
          current.tenantId,
          current.credentialRef
        );

        if (!credentials) {
          throw new Error(`Failed to resolve credentials for ref: ${current.credentialRef}`);
        }
      } else {
        warnings.push("No credentials to validate - integration will be degraded");
      }

      // Step 3: Health probe
      if (current.credentialRef) {
        const health = await this.healthChecker.checkHealth(
          current.tenantId,
          current.pluginId,
          current.credentialRef
        );

        if (!health.healthy) {
          throw new Error(health.reason || "Health check failed during validation");
        }
      } else {
        warnings.push("Skipping health check - no credentials");
      }

      // Step 4: ACTIVE
      await this.transitionTo(current, "active");
      current = (await this.repository.getById(current.id))!;

      logger.info(
        { integrationId: current.id, tenantId: current.tenantId, pluginId: current.pluginId },
        "Integration installed and activated successfully"
      );

      return {
        integration: current,
        noOp,
        warnings,
      };
    } catch (error) {
      // On failure, transition to degraded
      const failureCode = this.classifyError(error);
      const now = new Date();

      await this.repository.updateActualStatus(
        current.id,
        "degraded",
        failureCode,
        String(error),
        now,
        null
      );

      throw new Error(
        `Integration install failed: ${String(error)}. Integration left in degraded state.`,
        { cause: error }
      );
    }
  }

  private async transitionTo(
    integration: TenantIntegration,
    status: IntegrationStatus
  ): Promise<void> {
    const now = new Date();
    await this.repository.updateActualStatus(
      integration.id,
      status,
      null,
      null,
      now,
      status === "active" ? now : null
    );
  }

  private classifyError(error: unknown): IntegrationFailureCode {
    // Secret-backend outage is a distinct taxonomy from credential-invalid and
    // provider-unreachable (ADR 0006): recognize the structured error before
    // falling through to string heuristics.
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { name?: unknown; code?: unknown }).name === "SecretStoreError" &&
      (error as { code?: unknown }).code === "backend_unavailable"
    ) {
      return "credential_backend_unavailable";
    }

    const message = String(error).toLowerCase();

    if (message.includes("credential") || message.includes("auth") || message.includes("unauthorized") || message.includes("401")) {
      return "credential_invalid";
    }
    if (message.includes("rate limit") || message.includes("429") || message.includes("throttle")) {
      return "provider_rate_limited";
    }
    if (message.includes("timeout") || message.includes("connect") || message.includes("unreachable") || message.includes("network")) {
      return "provider_unreachable";
    }
    if (message.includes("config") || message.includes("invalid") || message.includes("validation")) {
      return "configuration_invalid";
    }
    if (message.includes("capability") || message.includes("not found") || message.includes("404")) {
      return "capability_missing";
    }
    if (message.includes("activate") || message.includes("startup") || message.includes("initialization")) {
      return "activation_failed";
    }
    if (message.includes("health")) {
      return "health_check_failed";
    }

    return "provider_unreachable";
  }
}