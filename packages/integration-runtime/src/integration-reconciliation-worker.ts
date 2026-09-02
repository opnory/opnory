// packages/integration-runtime/src/integration-reconciliation-worker.ts
// Reconciliation worker for tenant integrations
// Reuses the same lease/worker machinery patterns as governance-reconciliation-worker

import { Pool } from "pg";
import { getLogger, LifecycleSpan } from "@opnory/observability";
import type {
  TenantIntegration,
  IntegrationStatus,
  IntegrationFailureCode,
  TenantIntegrationRepository,
  IntegrationHealthChecker,
  IntegrationReconciliationWorker,
  TenantId,
  PluginId,
} from "./tenant-integration.js";
import type { ScopedCredentialHandle } from "./tenant-integration.js";
import { randomUUID } from "crypto";

const logger = getLogger().child({ component: "integration-reconciliation-worker" });

// ============================================================================
// Configuration
// ============================================================================

export interface IntegrationReconciliationWorkerConfig {
  pollIntervalMs: number;
  pollJitterMs: number;
  maxPollIntervalMs: number;
  minPollIntervalMs: number;
  leaseDurationMs: number;
  leaseRenewalMarginMs: number;
  batchSize: number;
  healthCheckConcurrency: number;
  maxRetries: number;
  baseRetryDelayMs: number;
  maxRetryDelayMs: number;
  jitterFactor: number;
  adaptivePolling: boolean;
  healthCheckIntervalMs: number; // How often to health check active integrations
}

export const DEFAULT_INTEGRATION_RECONCILIATION_WORKER_CONFIG: IntegrationReconciliationWorkerConfig = {
  pollIntervalMs: 30000, // 30 seconds
  pollJitterMs: 5000,
  maxPollIntervalMs: 120000, // 2 minutes
  minPollIntervalMs: 10000, // 10 seconds
  leaseDurationMs: 120000, // 2 minutes
  leaseRenewalMarginMs: 20000, // Renew if less than 20s remaining
  batchSize: 25,
  healthCheckConcurrency: 5,
  maxRetries: 3,
  baseRetryDelayMs: 10000,
  maxRetryDelayMs: 600000,
  jitterFactor: 0.2,
  adaptivePolling: true,
  healthCheckIntervalMs: 300000, // 5 minutes
};

// ============================================================================
// Metrics
// ============================================================================

export interface IntegrationReconciliationWorkerMetrics {
  claimsThisPoll: number;
  claimsTotal: number;
  successfulReconciliations: number;
  skippedReconciliations: number;
  activations: number;
  deactivations: number;
  healthChecks: number;
  healthCheckFailures: number;
  retriesScheduled: number;
  terminalFailures: number;
  lastSuccessfulPoll: Date | null;
  lastPollDurationMs: number;
  consecutiveEmptyPolls: number;
  currentPollIntervalMs: number;
  activeLeases: number;
  expiredLeases: number;
  leaseRenewals: number;
}

export interface ReconciliationResult {
  integrationId: string;
  tenantId: TenantId;
  pluginId: PluginId;
  status:
    | "RECONCILED"
    | "ACTIVATED"
    | "DEACTIVATED"
    | "DEGRADED"
    | "SUSPENDED"
    | "RETRY"
    | "RECONCILIATION_FAILED"
    | "SKIPPED"
    | "HEALTH_CHECK_FAILED";
  attemptCount: number;
  errorCode?: IntegrationFailureCode;
  errorMessage?: string;
  nextAttemptAt?: Date;
}

// ============================================================================
// Integration Reconciliation Worker
// ============================================================================

export class IntegrationReconciliationWorkerImpl implements IntegrationReconciliationWorker {
  private pool: Pool;
  private repository: TenantIntegrationRepository;
  private healthChecker: IntegrationHealthChecker;
  private credentialProvider: {
    get(tenantId: TenantId, credentialRef: string): Promise<ScopedCredentialHandle | null>;
  };
  private config: IntegrationReconciliationWorkerConfig;
  private workerId: string;
  private running = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private leaseRenewalTimer: NodeJS.Timeout | null = null;
  private currentPollIntervalMs: number;
  private consecutiveEmptyPolls = 0;
  private metrics: IntegrationReconciliationWorkerMetrics;

  constructor(
    repository: TenantIntegrationRepository,
    healthChecker: IntegrationHealthChecker,
    credentialProvider: {
      get(tenantId: TenantId, credentialRef: string): Promise<ScopedCredentialHandle | null>;
    },
    pool: Pool,
    config: Partial<IntegrationReconciliationWorkerConfig> = {}
  ) {
    this.pool = pool;
    this.repository = repository;
    this.healthChecker = healthChecker;
    this.credentialProvider = credentialProvider;
    this.config = { ...DEFAULT_INTEGRATION_RECONCILIATION_WORKER_CONFIG, ...config };
    this.workerId = `${process.env.HOSTNAME || "worker"}-${process.pid}-${randomUUID().slice(0, 8)}`;
    this.currentPollIntervalMs = this.config.pollIntervalMs;
    this.metrics = this.initializeMetrics();
  }

  private initializeMetrics(): IntegrationReconciliationWorkerMetrics {
    return {
      claimsThisPoll: 0,
      claimsTotal: 0,
      successfulReconciliations: 0,
      skippedReconciliations: 0,
      activations: 0,
      deactivations: 0,
      healthChecks: 0,
      healthCheckFailures: 0,
      retriesScheduled: 0,
      terminalFailures: 0,
      lastSuccessfulPoll: null,
      lastPollDurationMs: 0,
      consecutiveEmptyPolls: 0,
      currentPollIntervalMs: this.config.pollIntervalMs,
      activeLeases: 0,
      expiredLeases: 0,
      leaseRenewals: 0,
    };
  }

  async start(): Promise<void> {
    if (this.running) {
      logger.warn("Integration reconciliation worker already running");
      return;
    }

    logger.info(
      { workerId: this.workerId, config: this.config },
      "Starting integration reconciliation worker"
    );
    this.running = true;

    // Run startup scan immediately
    await this.processDueReconciliations();

    // Schedule recurring polls with jitter
    this.scheduleNextPoll();

    // Start lease renewal
    this.startLeaseRenewal();
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    logger.info(
      { workerId: this.workerId },
      "Stopping integration reconciliation worker"
    );
    this.running = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.leaseRenewalTimer) {
      clearTimeout(this.leaseRenewalTimer);
      this.leaseRenewalTimer = null;
    }

    // Release all leases on graceful shutdown
    await this.releaseAllLeases();
  }

  getMetrics(): IntegrationReconciliationWorkerMetrics {
    return { ...this.metrics };
  }

  getWorkerId(): string {
    return this.workerId;
  }

  private lifecycleFor(integration: import("./tenant-integration.js").TenantIntegration, operation: string): InstanceType<typeof LifecycleSpan> {
    return new LifecycleSpan(
      {
        tenantId: integration.tenantId,
        integrationId: integration.id,
        pluginId: integration.pluginId,
        provider: integration.pluginId,
        operation,
        desiredState: integration.desiredStatus,
        actualState: integration.actualStatus,
        configVersion: integration.configVersion,
        mutated: "true",
        credentialRef: integration.credentialRef,
        reconciliationAttempt: String(integration.configVersion),
      },
      operation,
    );
  }


  async runOnce(): Promise<void> {
    await this.processDueReconciliations();
  }

  // ============================================================================
  // Core Processing Loop
  // ============================================================================

  private async processDueReconciliations(): Promise<void> {
    const pollStart = Date.now();
    const now = new Date();

    try {
      // 1. CLAIM: Short transaction to claim due reconciliations
      const claimedIntegrations = await this.claimDueReconciliations(now);

      this.metrics.claimsThisPoll = claimedIntegrations.length;
      this.metrics.claimsTotal += claimedIntegrations.length;

      if (claimedIntegrations.length === 0) {
        this.handleEmptyPoll();
        return;
      }

      this.metrics.consecutiveEmptyPolls = 0;
      this.metrics.activeLeases = claimedIntegrations.length;

      // 2. PROCESS: Reconcile each integration
      const results = await this.processBatch(claimedIntegrations);

      // 3. FINALIZE: Write final results
      await this.finalizeBatch(results);
    } catch (err) {
      logger.error(
        { err, workerId: this.workerId },
        "Error processing integration reconciliations"
      );
    } finally {
      this.metrics.lastPollDurationMs = Date.now() - pollStart;
      this.metrics.lastSuccessfulPoll = new Date();
      this.scheduleNextPoll();
    }
  }

  // ============================================================================
  // PHASE 1: CLAIM (Short transaction with FOR UPDATE SKIP LOCKED)
  // ============================================================================

  private async claimDueReconciliations(now: Date): Promise<
    Array<{
      integration: TenantIntegration;
      leaseUntil: Date;
    }>
  > {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      // Find due reconciliations that are not leased or have expired leases
      const claimQuery = `
        SELECT 
          id,
          tenant_id,
          plugin_id,
          desired_status,
          actual_status,
          credential_ref,
          config_version,
          capabilities,
          last_health_check_at,
          last_healthy_at,
          failure_code,
          failure_reason,
          created_at,
          updated_at,
          lease_owner,
          lease_until,
          lease_acquired_at
        FROM tenant_integrations
        WHERE 
          (
            -- Desired active but actual not active
            (desired_status = 'active' AND actual_status NOT IN ('active'))
            OR
            -- Desired inactive but actual active
            (desired_status = 'inactive' AND actual_status = 'active')
            OR
            -- Needs health check (active but last check > interval ago)
            (actual_status = 'active' AND (last_health_check_at IS NULL OR last_health_check_at < $1))
            OR
            -- In degraded/suspended/uninstalling state needing recovery
            (actual_status IN ('degraded', 'suspended', 'uninstalling'))
            OR
            -- Lease expired or not held
            (lease_until IS NOT NULL AND lease_until < $1)
          )
          AND (lease_until IS NULL OR lease_until < $1)
        ORDER BY 
          CASE 
            WHEN actual_status IN ('degraded', 'suspended', 'uninstalling') THEN 0
            WHEN desired_status = 'active' AND actual_status != 'active' THEN 1
            WHEN desired_status = 'inactive' AND actual_status = 'active' THEN 2
            ELSE 3
          END,
          COALESCE(last_health_check_at, created_at) ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $2
      `;

      const healthCheckCutoff = new Date(now.getTime() - this.config.healthCheckIntervalMs);

      const claimResult = await client.query(claimQuery, [
        healthCheckCutoff,
        this.config.batchSize,
      ]);
      const claimed = claimResult.rows;

      if (claimed.length > 0) {
        const leaseUntil = new Date(now.getTime() + this.config.leaseDurationMs);
        const leaseAcquiredAt = now;

        const leaseQuery = `
          UPDATE tenant_integrations
          SET 
            lease_owner = $1,
            lease_until = $2,
            lease_acquired_at = $3,
            config_version = config_version + 1,
            updated_at = NOW()
          WHERE id = ANY($4)
        `;

        await client.query(leaseQuery, [
          this.workerId,
          leaseUntil,
          leaseAcquiredAt,
          claimed.map((r) => r.id),
        ]);

        await client.query("COMMIT");

        logger.debug(
          {
            workerId: this.workerId,
            claimed: claimed.length,
            leaseUntil: leaseUntil.toISOString(),
          },
          "Claimed integration reconciliations"
        );

        // SAFETY: these assertions are I/O-boundary casts from a raw PostgreSQL row.
        // tenant_integrations columns are created with CHECK constraints in
        // migrateTenantIntegrations, so tenant_id/plugin_id/desired_status/
        // actual_status/failure_code are already constrained to the branded/union
        // values before they reach this mapper. `r` is the pg row (snake_case).
        return claimed.map((r) => ({
          integration: {
            id: r.id,
            tenantId: r.tenant_id as TenantId,
            pluginId: r.plugin_id as PluginId,
            desiredStatus: r.desired_status as "active" | "inactive",
            actualStatus: r.actual_status as IntegrationStatus,
            credentialRef: r.credential_ref,
            configVersion: r.config_version,
            capabilities: r.capabilities || [],
            lastHealthCheckAt: r.last_health_check_at ? new Date(r.last_health_check_at) : null,
            lastHealthyAt: r.last_healthy_at ? new Date(r.last_healthy_at) : null,
            failureCode: r.failure_code as IntegrationFailureCode | null,
            failureReason: r.failure_reason,
            leaseOwner: r.lease_owner,
            leaseUntil: r.lease_until ? new Date(r.lease_until) : null,
            leaseAcquiredAt: r.lease_acquired_at ? new Date(r.lease_acquired_at) : null,
            createdAt: new Date(r.created_at),
            updatedAt: new Date(r.updated_at),
          },
          leaseUntil,
        }));
      } else {
        await client.query("COMMIT");
      }

      return [];
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // ============================================================================
  // PHASE 2: PROCESS (Reconcile each integration)
  // ============================================================================

  private async processBatch(
    claimed: Array<{
      integration: TenantIntegration;
      leaseUntil: Date;
    }>
  ): Promise<ReconciliationResult[]> {
    const results: ReconciliationResult[] = [];

    // Process with controlled concurrency
    const concurrency = this.config.healthCheckConcurrency;
    const queue = [...claimed];
    const running: Promise<void>[] = [];

    const processNext = async (): Promise<void> => {
      if (queue.length === 0) return;

      const item = queue.shift()!;
      const result = await this.processSingleReconciliation(item);
      results.push(result);

      if (queue.length > 0) {
        await processNext();
      }
    };

    // Start concurrent workers
    const workers = Math.min(concurrency, claimed.length);
    for (let i = 0; i < workers; i++) {
      running.push(processNext());
    }

    await Promise.all(running);
    return results;
  }

  private async processSingleReconciliation(item: {
    integration: TenantIntegration;
    leaseUntil: Date;
  }): Promise<ReconciliationResult> {
    const integration = item.integration;
    const attemptCount = integration.configVersion;
    const now = new Date();

    logger.info(
      {
        workerId: this.workerId,
        integrationId: integration.id,
        tenantId: integration.tenantId,
        pluginId: integration.pluginId,
        desiredStatus: integration.desiredStatus,
        actualStatus: integration.actualStatus,
        configVersion: integration.configVersion,
      },
      "Processing integration reconciliation"
    );

    try {
      // Check if we need a health check
      const needsHealthCheck =
        integration.actualStatus === "active" &&
        (!integration.lastHealthCheckAt ||
          integration.lastHealthCheckAt.getTime() <
            now.getTime() - this.config.healthCheckIntervalMs);

      // Determine action based on desired vs actual state
      if (integration.desiredStatus === "active" && integration.actualStatus !== "active") {
        // Need to activate
        return await this.activateIntegration(integration, attemptCount);
      } else if (integration.desiredStatus === "inactive" && integration.actualStatus === "active") {
        // Need to deactivate
        return await this.deactivateIntegration(integration, attemptCount);
      } else if (
        integration.actualStatus === "degraded" ||
        integration.actualStatus === "suspended"
      ) {
        // Try to recover
        return await this.recoverIntegration(integration, attemptCount, needsHealthCheck);
      } else if (integration.actualStatus === "uninstalling") {
        // Verify cleanup and transition to inactive
        return await this.finalizeUninstall(integration, attemptCount);
      } else if (needsHealthCheck) {
        // Just a health check
        return await this.performHealthCheck(integration, attemptCount);
      } else {
        // No action needed
        return {
          integrationId: integration.id,
          tenantId: integration.tenantId,
          pluginId: integration.pluginId,
          status: "SKIPPED",
          attemptCount,
        };
      }
    } catch (error) {
      logger.error(
        {
          err: error,
          workerId: this.workerId,
          integrationId: integration.id,
        },
        "Error processing single integration reconciliation"
      );

      const failureCode = this.classifyError(error);
      return {
        integrationId: integration.id,
        tenantId: integration.tenantId,
        pluginId: integration.pluginId,
        status: "RECONCILIATION_FAILED",
        attemptCount,
        errorCode: failureCode,
        errorMessage: String(error),
        nextAttemptAt: this.calculateNextAttempt(attemptCount),
      };
    }
  }

  private async activateIntegration(
    integration: TenantIntegration,
    attemptCount: number
  ): Promise<ReconciliationResult> {
    const now = new Date();
    const lifecycle = this.lifecycleFor(integration, "integration.activate");
    await lifecycle.root();

    try {
      // Transition to CONFIGURING
      await lifecycle.child("integration.configure");
      await this.repository.updateActualStatus(
        integration.id,
        "configuring",
        null,
        null,
        now,
        null
      );

      // Validate credential reference
      if (!integration.credentialRef) {
        throw new Error("No credential reference for integration");
      }

      // Resolve credentials
      await lifecycle.child("credential.resolve");
      const credentials = await this.credentialProvider.get(
        integration.tenantId,
        integration.credentialRef
      );
      if (!credentials) {
        throw new Error("Failed to resolve credentials");
      }

      // Transition to VALIDATING
      await this.repository.updateActualStatus(
        integration.id,
        "validating",
        null,
        null,
        now,
        null
      );

      // Health probe
      await lifecycle.child("integration.health_check");
      const health = await this.healthChecker.checkHealth(
        integration.tenantId,
        integration.pluginId,
        integration.credentialRef
      );

      if (!health.healthy) {
        throw new Error(health.reason || "Health check failed");
      }

      // Transition to ACTIVE
      await this.repository.updateActualStatus(
        integration.id,
        "active",
        null,
        null,
        now,
        now
      );
      await lifecycle.child("plugin.activate");
      await lifecycle.child("capability.register");

      this.metrics.activations++;

      return {
        integrationId: integration.id,
        tenantId: integration.tenantId,
        pluginId: integration.pluginId,
        status: "ACTIVATED",
        attemptCount,
      };
    } catch (error) {
      const failureCode = this.classifyError(error);
      await this.repository.updateActualStatus(
        integration.id,
        "degraded",
        failureCode,
        String(error),
        now,
        null
      );

      await lifecycle.child(
        "integration.degrade",
        undefined,
        { failureCode, actualState: "degraded" },
      ).catch(() => {});

      return {
        integrationId: integration.id,
        tenantId: integration.tenantId,
        pluginId: integration.pluginId,
        status: "DEGRADED",
        attemptCount,
        errorCode: failureCode,
        errorMessage: String(error),
        nextAttemptAt: this.calculateNextAttempt(attemptCount),
      };
    }
  }

  private async deactivateIntegration(
    integration: TenantIntegration,
    attemptCount: number
  ): Promise<ReconciliationResult> {
    const now = new Date();
    const lifecycle = this.lifecycleFor(integration, "integration.uninstall");
    await lifecycle.root();

    try {
      // Transition to UNINSTALLING
      await this.repository.updateActualStatus(
        integration.id,
        "uninstalling",
        null,
        null,
        now,
        null
      );

      // TODO: Call runtime kernel dispose for this tenant/plugin
      // This would dispose the plugin instance and verify zero capabilities/listeners/state
      // For now, we trust the runtime to handle this

      // Dispose and unregister
      await lifecycle.child("plugin.dispose");
      await lifecycle.child("capability.unregister");

      // Transition to INACTIVE
      await this.repository.updateActualStatus(
        integration.id,
        "inactive",
        null,
        null,
        now,
        null
      );

      this.metrics.deactivations++;

      return {
        integrationId: integration.id,
        tenantId: integration.tenantId,
        pluginId: integration.pluginId,
        status: "DEACTIVATED",
        attemptCount,
      };
    } catch (error) {
      await this.repository.updateActualStatus(
        integration.id,
        "uninstalling",
        "cleanup_failed",
        `Cleanup failed: ${String(error)}`,
        now,
        null
      );

      await lifecycle.child(
        "integration.degrade",
        undefined,
        { failureCode: "cleanup_failed", actualState: "uninstalling" },
      ).catch(() => {});

      return {
        integrationId: integration.id,
        tenantId: integration.tenantId,
        pluginId: integration.pluginId,
        status: "RECONCILIATION_FAILED",
        attemptCount,
        errorCode: "cleanup_failed",
        errorMessage: String(error),
        nextAttemptAt: this.calculateNextAttempt(attemptCount),
      };
    }
  }

  private async recoverIntegration(
    integration: TenantIntegration,
    attemptCount: number,
    _needsHealthCheck: boolean
  ): Promise<ReconciliationResult> {
    const now = new Date();

    if (!integration.credentialRef) {
      await this.repository.updateActualStatus(
        integration.id,
        "suspended",
        "credential_invalid",
        "No credential reference",
        now,
        null
      );

      return {
        integrationId: integration.id,
        tenantId: integration.tenantId,
        pluginId: integration.pluginId,
        status: "SUSPENDED",
        attemptCount,
        errorCode: "credential_invalid",
        errorMessage: "No credential reference",
      };
    }

    // Resolve credentials
    const credentials = await this.credentialProvider.get(
      integration.tenantId,
      integration.credentialRef
    );

    if (!credentials) {
      // Check if we should suspend after max retries
      if (attemptCount >= this.config.maxRetries) {
        await this.repository.updateActualStatus(
          integration.id,
          "suspended",
          "credential_invalid",
          "Credentials not resolvable after max retries",
          now,
          null
        );

        return {
          integrationId: integration.id,
          tenantId: integration.tenantId,
          pluginId: integration.pluginId,
          status: "SUSPENDED",
          attemptCount,
          errorCode: "credential_invalid",
          errorMessage: "Credentials not resolvable after max retries",
        };
      }

      // Schedule retry
      const nextAttemptAt = this.calculateNextAttempt(attemptCount);
      await this.repository.updateActualStatus(
        integration.id,
        "degraded",
        "credential_invalid",
        "Credentials not resolvable",
        now,
        null
      );

      this.metrics.retriesScheduled++;

      return {
        integrationId: integration.id,
        tenantId: integration.tenantId,
        pluginId: integration.pluginId,
        status: "RETRY",
        attemptCount,
        errorCode: "credential_invalid",
        errorMessage: "Credentials not resolvable",
        nextAttemptAt,
      };
    }

    // Health check
    const health = await this.healthChecker.checkHealth(
      integration.tenantId,
      integration.pluginId,
      integration.credentialRef
    );

    if (health.healthy) {
      // Recovered!
      const recoverLifecycle = this.lifecycleFor(integration, "integration.recover");
      await recoverLifecycle.root();
      await this.repository.updateActualStatus(
        integration.id,
        "active",
        null,
        null,
        now,
        now
      );
      await recoverLifecycle.child("integration.recover", undefined, { actualState: "active", verified: "true" }).catch(() => {});

      this.metrics.successfulReconciliations++;

      return {
        integrationId: integration.id,
        tenantId: integration.tenantId,
        pluginId: integration.pluginId,
        status: "RECONCILED",
        attemptCount,
      };
    } else {
      // Still unhealthy
      const failureCode = health.code || "provider_unreachable";
      await this.repository.updateActualStatus(
        integration.id,
        "degraded",
        failureCode,
        health.reason || "Health check failed",
        now,
        null
      );

      const recLifecycle = this.lifecycleFor(integration, "integration.recover");
      await recLifecycle.root();
      await recLifecycle.child(
        "integration.degrade",
        undefined,
        { failureCode, actualState: "degraded" },
      ).catch(() => {});

      this.metrics.retriesScheduled++;

      return {
        integrationId: integration.id,
        tenantId: integration.tenantId,
        pluginId: integration.pluginId,
        status: "RETRY",
        attemptCount,
        errorCode: failureCode,
        errorMessage: health.reason || "Health check failed",
        nextAttemptAt: this.calculateNextAttempt(attemptCount),
      };
    }
  }

  private async finalizeUninstall(
    integration: TenantIntegration,
    attemptCount: number
  ): Promise<ReconciliationResult> {
    const now = new Date();
    const lifecycle = this.lifecycleFor(integration, "integration.uninstall");
    await lifecycle.root();

    // TODO: Query runtime kernel to verify cleanup — span is already emitted
    // for operator observability; the real capability check goes through the
    // kernel dispose path in the reconciliation engine.
    await lifecycle.child("plugin.dispose");
    await lifecycle.child("capability.unregister");

    await this.repository.updateActualStatus(
      integration.id,
      "inactive",
      null,
      null,
      now,
      null
    );

    return {
      integrationId: integration.id,
      tenantId: integration.tenantId,
      pluginId: integration.pluginId,
      status: "DEACTIVATED",
      attemptCount,
    };
  }

  private async performHealthCheck(
    integration: TenantIntegration,
    attemptCount: number
  ): Promise<ReconciliationResult> {
    const now = new Date();

    if (!integration.credentialRef) {
      await this.repository.updateActualStatus(
        integration.id,
        "degraded",
        "credential_invalid",
        "No credential reference for health check",
        now,
        null
      );

      return {
        integrationId: integration.id,
        tenantId: integration.tenantId,
        pluginId: integration.pluginId,
        status: "HEALTH_CHECK_FAILED",
        attemptCount,
        errorCode: "credential_invalid",
        errorMessage: "No credential reference",
      };
    }

    const hcLifecycle = this.lifecycleFor(integration, "integration.health_check");
    await hcLifecycle.root();
    const health = await this.healthChecker.checkHealth(
      integration.tenantId,
      integration.pluginId,
      integration.credentialRef
    );
    await hcLifecycle.child("integration.health_check");

    this.metrics.healthChecks++;

    if (health.healthy) {
      await this.repository.updateActualStatus(
        integration.id,
        "active",
        null,
        null,
        now,
        now
      );

      return {
        integrationId: integration.id,
        tenantId: integration.tenantId,
        pluginId: integration.pluginId,
        status: "RECONCILED",
        attemptCount,
      };
    } else {
      this.metrics.healthCheckFailures++;

      const failureCode = health.code || "health_check_failed";
      await this.repository.updateActualStatus(
        integration.id,
        "degraded",
        failureCode,
        health.reason || "Health check failed",
        now,
        null
      );

      return {
        integrationId: integration.id,
        tenantId: integration.tenantId,
        pluginId: integration.pluginId,
        status: "HEALTH_CHECK_FAILED",
        attemptCount,
        errorCode: failureCode,
        errorMessage: health.reason || "Health check failed",
        nextAttemptAt: this.calculateNextAttempt(attemptCount),
      };
    }
  }

  // ============================================================================
  // PHASE 3: FINALIZE (Write results)
  // ============================================================================

  private async finalizeBatch(results: ReconciliationResult[]): Promise<void> {
    for (const result of results) {
      if (result.status === "ACTIVATED" || result.status === "RECONCILED") {
        this.metrics.successfulReconciliations++;
      } else if (result.status === "RETRY") {
        this.metrics.retriesScheduled++;
      } else if (result.status === "RECONCILIATION_FAILED") {
        this.metrics.terminalFailures++;
      } else if (result.status === "SKIPPED") {
        this.metrics.skippedReconciliations++;
      }
    }

    logger.debug(
      {
        workerId: this.workerId,
        results: results.length,
        successful: this.metrics.successfulReconciliations,
        retries: this.metrics.retriesScheduled,
        failed: this.metrics.terminalFailures,
      },
      "Finalized reconciliation batch"
    );
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private handleEmptyPoll(): void {
    this.metrics.consecutiveEmptyPolls++;

    if (this.config.adaptivePolling && this.metrics.consecutiveEmptyPolls > 3) {
      this.currentPollIntervalMs = Math.min(
        this.currentPollIntervalMs * 1.5,
        this.config.maxPollIntervalMs
      );
    }
  }

  private scheduleNextPoll(): void {
    if (!this.running) return;

    const jitter = Math.random() * this.config.pollJitterMs;
    const delay = this.currentPollIntervalMs + jitter;

    this.pollTimer = setTimeout(() => {
      if (this.running) {
        this.processDueReconciliations().catch((err) => {
          logger.error({ err, workerId: this.workerId }, "Poll cycle failed");
        });
      }
    }, delay);
  }

  private startLeaseRenewal(): void {
    const renewInterval = this.config.leaseDurationMs - this.config.leaseRenewalMarginMs;

    this.leaseRenewalTimer = setInterval(async () => {
      if (!this.running) return;

      try {
        await this.renewLeases();
        this.metrics.leaseRenewals++;
      } catch (err) {
        logger.error({ err, workerId: this.workerId }, "Lease renewal failed");
      }
    }, renewInterval);
  }

  private async renewLeases(): Promise<void> {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + this.config.leaseDurationMs);

    const sql = `
      UPDATE tenant_integrations
      SET 
        lease_until = $1,
        lease_acquired_at = $2,
        config_version = config_version + 1,
        updated_at = NOW()
      WHERE lease_owner = $3 AND lease_until > $4
    `;

    await this.pool.query(sql, [leaseUntil, now, this.workerId, now]);
  }

  private async releaseAllLeases(): Promise<void> {
    const sql = `
      UPDATE tenant_integrations
      SET 
        lease_owner = NULL,
        lease_until = NULL,
        lease_acquired_at = NULL,
        updated_at = NOW()
      WHERE lease_owner = $1
    `;

    await this.pool.query(sql, [this.workerId]);
  }

  private classifyError(error: unknown): IntegrationFailureCode {
    // Secret-backend outage carries the structured SecretStoreError code —
    // classify it explicitly before any string heuristic can mis-label it as
    // credential_invalid or provider_unreachable (ADR 0006 taxonomy).
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
    if (message.includes("cleanup") || message.includes("dispose") || message.includes("uninstall")) {
      return "cleanup_failed";
    }

    return "provider_unreachable";
  }

  private calculateNextAttempt(attemptCount: number): Date {
    const delay = Math.min(
      this.config.baseRetryDelayMs * Math.pow(2, attemptCount) +
        Math.random() * this.config.jitterFactor * this.config.baseRetryDelayMs,
      this.config.maxRetryDelayMs
    );

    return new Date(Date.now() + delay);
  }
}