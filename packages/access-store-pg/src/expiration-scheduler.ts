import { Pool, PoolClient } from "pg";
import { getLogger } from "@opnory/observability";
import { loadConfig } from "@opnory/config";
import { 
  AccessRequest, 
  AccessRequestStatus, 
  FulfilledAccessRequest, 
  EntitlementRef,
  AccessExecutor
} from "@opnory/access-types";
import { AuditEventStore, AuditEventType } from "@opnory/access-audit";
import { randomUUID } from "crypto";

const logger = getLogger().child({ component: "expiration-scheduler" });

// ============================================================================
// Configuration
// ============================================================================

export interface SchedulerConfig {
  // Polling configuration
  pollIntervalMs: number;
  pollJitterMs: number;
  maxPollIntervalMs: number;
  minPollIntervalMs: number;
  
  // Lease configuration
  leaseDurationMs: number;
  leaseRenewalMarginMs: number;
  
  // Batch configuration
  batchSize: number;
  providerConcurrency: number;
  
  // Retry configuration
  maxRetries: number;
  baseRetryDelayMs: number;
  maxRetryDelayMs: number;
  jitterFactor: number;
  
  // Adaptive polling
  adaptivePolling: boolean;
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  pollIntervalMs: 5000,
  pollJitterMs: 2000,
  maxPollIntervalMs: 30000,
  minPollIntervalMs: 1000,
  leaseDurationMs: 60000, // 60 seconds
  leaseRenewalMarginMs: 10000, // Renew if less than 10s remaining
  batchSize: 50,
  providerConcurrency: 10,
  maxRetries: 3,
  baseRetryDelayMs: 5000,
  maxRetryDelayMs: 300000,
  jitterFactor: 0.2,
  adaptivePolling: true,
};

// ============================================================================
// Metrics
// ============================================================================

export interface SchedulerMetrics {
  // Expiration lag metrics
  expirationLagP50Ms: number;
  expirationLagP95Ms: number;
  expirationLagP99Ms: number;
  expirationLagMaxMs: number;
  oldestOverdueAgeMs: number;
  
  // Processing metrics
  claimsThisPoll: number;
  claimsTotal: number;
  successfulExpirations: number;
  skippedExpirations: number;
  retryScheduled: number;
  terminalFailures: number;
  
  // Polling metrics
  lastSuccessfulPoll: Date | null;
  lastPollDurationMs: number;
  consecutiveEmptyPolls: number;
  currentPollIntervalMs: number;
  
  // Lease metrics
  activeLeases: number;
  expiredLeases: number;
  leaseRenewals: number;
}

export interface ExpirationResult {
  requestId: string;
  status: "REVOKED" | "RETRY" | "REVOCATION_FAILED" | "SKIPPED";
  attemptCount: number;
  errorCode?: number;
  errorMessage?: string;
  nextAttemptAt?: Date;
}

// ============================================================================
// Expiration Scheduler
// ============================================================================

export class ExpirationScheduler {
  private pool: Pool;
  private executor: AccessExecutor;
  private auditStore: AuditEventStore;
  private config: SchedulerConfig;
  private workerId: string;
  private running = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private currentPollIntervalMs: number;
  private consecutiveEmptyPolls = 0;
  private metrics: SchedulerMetrics;
  private leaseRenewalTimer: NodeJS.Timeout | null = null;

  constructor(
    executor: AccessExecutor,
    auditStore: AuditEventStore,
    pool: Pool,
    config: Partial<SchedulerConfig> = {}
  ) {
    this.pool = pool;
    this.executor = executor;
    this.auditStore = auditStore;
    this.config = { ...DEFAULT_SCHEDULER_CONFIG, ...config };
    this.workerId = `${process.env.HOSTNAME || "worker"}-${process.pid}-${randomUUID().slice(0, 8)}`;
    this.currentPollIntervalMs = this.config.pollIntervalMs;
    this.metrics = this.initializeMetrics();
  }

  private initializeMetrics(): SchedulerMetrics {
    return {
      expirationLagP50Ms: 0,
      expirationLagP95Ms: 0,
      expirationLagP99Ms: 0,
      expirationLagMaxMs: 0,
      oldestOverdueAgeMs: 0,
      claimsThisPoll: 0,
      claimsTotal: 0,
      successfulExpirations: 0,
      skippedExpirations: 0,
      retryScheduled: 0,
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

  // ============================================================================
  // Public API
  // ============================================================================

  async start(): Promise<void> {
    if (this.running) {
      logger.warn("Scheduler already running");
      return;
    }

    logger.info({ workerId: this.workerId, config: this.config }, "Starting expiration scheduler");
    this.running = true;
    
    // Run startup scan immediately
    await this.processDueExpirations();
    
    // Schedule recurring polls with jitter
    this.scheduleNextPoll();
    
    // Start lease renewal
    this.startLeaseRenewal();
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    logger.info({ workerId: this.workerId }, "Stopping expiration scheduler");
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

  getMetrics(): SchedulerMetrics {
    return { ...this.metrics };
  }

  getWorkerId(): string {
    return this.workerId;
  }

  // Public method for testing - runs a single poll cycle
  async runOnce(): Promise<void> {
    await this.processDueExpirations();
  }

  // ============================================================================
  // Core Processing Loop
  // ============================================================================

  private async processDueExpirations(): Promise<void> {
    const pollStart = Date.now();
    const now = new Date();

    try {
      // 1. CLAIM: Short transaction to claim due expirations
      const claimedRequests = await this.claimDueExpirations(now);
      
      this.metrics.claimsThisPoll = claimedRequests.length;
      this.metrics.claimsTotal += claimedRequests.length;
      
      if (claimedRequests.length === 0) {
        this.handleEmptyPoll();
        return;
      }

      this.metrics.consecutiveEmptyPolls = 0;
      this.metrics.activeLeases = claimedRequests.length;

      // 2. PROCESS: Execute GitHub API calls outside transaction
      const results = await this.processBatch(claimedRequests);

      // 3. FINALIZE: Write final results
      await this.finalizeBatch(results);

      // Update expiration lag metrics
      await this.updateExpirationLagMetrics(now);

    } catch (err) {
      logger.error({ err, workerId: this.workerId }, "Error processing expirations");
    } finally {
      this.metrics.lastPollDurationMs = Date.now() - pollStart;
      this.metrics.lastSuccessfulPoll = new Date();
      this.scheduleNextPoll();
    }
  }

  // ============================================================================
  // PHASE 1: CLAIM (Short transaction with FOR UPDATE SKIP LOCKED)
  // ============================================================================

  private async claimDueExpirations(now: Date): Promise<Array<{
    requestId: string;
    accessExpiresAt: Date;
    attemptCount: number;
    maxRetries: number;
    correlationId: string;
  }>> {
    const client = await this.pool.connect();
    
    try {
      await client.query("BEGIN");

      // Find due expirations that are not leased or have expired leases
      // For FULFILLED: check access_expires_at
      // For RETRY: check expiration_next_attempt_at (not original access_expires_at)
      const claimQuery = `
        SELECT id, correlation_id, access_expires_at, expiration_attempt_count, expiration_max_retries
        FROM access_requests
        WHERE 
          (
            (status = 'FULFILLED' AND access_expires_at IS NOT NULL AND access_expires_at <= $1)
            OR (status = 'RETRY' AND expiration_next_attempt_at IS NOT NULL AND expiration_next_attempt_at <= $1)
          )
          AND (lease_until IS NULL OR lease_until < $1)
        ORDER BY 
          CASE 
            WHEN status = 'FULFILLED' THEN access_expires_at
            WHEN status = 'RETRY' THEN expiration_next_attempt_at
          END ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $2
      `;

      const claimResult = await client.query(claimQuery, [now, this.config.batchSize]);
      const claimed = claimResult.rows;

      if (claimed.length > 0) {
        const leaseUntil = new Date(now.getTime() + this.config.leaseDurationMs);
        const leaseAcquiredAt = now;

        // Acquire leases
        const leaseQuery = `
          UPDATE access_requests
          SET 
            status = 'REVOCATION_PENDING',
            lease_owner = $1,
            lease_until = $2,
            lease_acquired_at = $3,
            version = version + 1,
            updated_at = NOW()
          WHERE id = ANY($4)
        `;

        await client.query(leaseQuery, [
          this.workerId,
          leaseUntil,
          leaseAcquiredAt,
          claimed.map(r => r.id)
        ]);

        // Record audit event for claim
        for (const request of claimed) {
          await this.recordAudit("EXPIRATION_DUE", request.id, {
            workerId: this.workerId,
            leaseUntil: leaseUntil.toISOString(),
            attemptCount: request.expiration_attempt_count,
            maxRetries: request.expiration_max_retries,
          }, request.correlation_id);
        }

        await client.query("COMMIT");
        
        logger.debug({ 
          workerId: this.workerId, 
          claimed: claimed.length,
          leaseUntil: leaseUntil.toISOString(),
        }, "Claimed expirations");
      } else {
        await client.query("COMMIT");
      }

      return claimed.map(r => ({
        requestId: r.id,
        accessExpiresAt: new Date(r.access_expires_at),
        attemptCount: r.expiration_attempt_count,
        maxRetries: r.expiration_max_retries,
        correlationId: r.correlation_id,
      }));

    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // ============================================================================
  // PHASE 2: PROCESS (GitHub API calls outside transaction)
  // ============================================================================

  private async processBatch(
    claimed: Array<{ requestId: string; accessExpiresAt: Date; attemptCount: number; maxRetries: number; correlationId: string }>
  ): Promise<ExpirationResult[]> {
    const results: ExpirationResult[] = [];
    
    // Process with controlled concurrency
    const concurrency = this.config.providerConcurrency;
    const queue = [...claimed];
    const running: Promise<void>[] = [];

    const processNext = async (): Promise<void> => {
      if (queue.length === 0) return;
      
      const item = queue.shift()!;
      const result = await this.processSingleExpiration(item);
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

  private async processSingleExpiration(item: {
    requestId: string;
    accessExpiresAt: Date;
    attemptCount: number;
    maxRetries: number;
    correlationId: string;
  }): Promise<ExpirationResult> {
    const attemptCount = item.attemptCount;
    const maxRetries = item.maxRetries;

    logger.info({
      workerId: this.workerId,
      requestId: item.requestId,
      attemptCount,
      maxRetries,
    }, "Processing expiration");

    try {
      // Fetch the full request
      const requestResult = await this.pool.query(
        "SELECT * FROM access_requests WHERE id = $1",
        [item.requestId]
      );

      if (requestResult.rows.length === 0) {
        logger.warn({ requestId: item.requestId }, "Request not found, skipping");
        return {
          requestId: item.requestId,
          status: "SKIPPED",
          attemptCount,
          errorCode: 404,
          errorMessage: "Request not found",
        };
      }

      const row = requestResult.rows[0];
      
      // Check if access was extended (accessExpiresAt is now in the future)
      const now = new Date();
      logger.debug({ 
        requestId: item.requestId,
        rowAccessExpiresAt: row.access_expires_at,
        now: now.toISOString(),
        isFuture: row.access_expires_at ? new Date(row.access_expires_at) > now : false
      }, "Checking extension");
      if (row.access_expires_at && new Date(row.access_expires_at) > now) {
        logger.info({ 
          requestId: item.requestId, 
          originalExpiry: item.accessExpiresAt.toISOString(),
          newExpiry: row.access_expires_at.toISOString(),
          now: now.toISOString(),
        }, "Access extended, skipping expiration");

        await this.recordAudit("EXPIRATION_SKIPPED", item.requestId, {
          reason: "extended",
          originalExpiry: item.accessExpiresAt.toISOString(),
          newExpiry: row.access_expires_at.toISOString(),
        }, row.correlation_id);

        return {
          requestId: item.requestId,
          status: "SKIPPED",
          attemptCount,
          errorCode: 0,
          errorMessage: "Access was extended",
        };
      }

      // Check if already revoked (manual revoke)
      if (row.status === "REVOKED") {
        logger.info({ requestId: item.requestId }, "Already revoked, skipping expiration");

        await this.recordAudit("EXPIRATION_SKIPPED", item.requestId, {
          reason: "already_revoked",
        }, row.correlation_id);

        return {
          requestId: item.requestId,
          status: "SKIPPED",
          attemptCount,
          errorCode: 0,
          errorMessage: "Already revoked",
        };
      }

      // Build FulfilledAccessRequest for executor
      const fulfilledRequest: FulfilledAccessRequest = {
        id: row.id,
        correlationId: row.correlation_id,
        requesterId: row.requester_id,
        requesterEmail: row.requester_email,
        externalIdentities: row.metadata?.externalIdentities || {},
        entitlement: {
          id: row.entitlement_id,
          name: row.entitlement_name,
          system: row.entitlement_system,
          githubConfig: row.metadata?.githubConfig,
          metadata: row.metadata?.entitlementMetadata || {},
          governance: row.metadata?.governance,
        },
        reason: row.reason,
        status: "FULFILLED",
        version: row.version,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        expiresAt: row.expires_at?.toISOString(),
        accessExpiresAt: row.access_expires_at?.toISOString(),
        approvedAt: row.approved_at?.toISOString(),
        approvedBy: row.approved_by,
        deniedAt: row.denied_at?.toISOString(),
        deniedBy: row.denied_by,
        deniedReason: row.denied_reason,
        fulfilledAt: row.fulfilled_at?.toISOString(),
        fulfillmentError: row.fulfillment_error,
        externalId: row.external_id,
        idempotencyKey: row.idempotency_key,
        metadata: row.metadata || {},
        expirationAttemptCount: row.expiration_attempt_count ?? 0,
        expirationMaxRetries: row.expiration_max_retries ?? 3,
        // Governance fields
        governanceExternalRequestId: row.governance_external_request_id,
        governanceAuthority: row.governance_authority,
        governanceAssignmentId: row.governance_assignment_id,
        governanceAssignmentExpiresAt: row.governance_assignment_expires_at?.toISOString(),
        // Reconciliation state fields
        governanceLastCheckedAt: row.governance_last_checked_at?.toISOString(),
        governanceNextCheckAt: row.governance_next_check_at?.toISOString(),
        governanceRetryCount: row.governance_retry_count ?? 0,
        governanceLastError: row.governance_last_error,
        governanceLastErrorCode: row.governance_last_error_code,
        // Governance lease fields
        governanceLeaseOwner: row.governance_lease_owner,
        governanceLeaseUntil: row.governance_lease_until?.toISOString(),
        governanceLeaseAcquiredAt: row.governance_lease_acquired_at?.toISOString(),
        governanceAttemptCount: row.governance_attempt_count ?? 0,
        governanceNextAttemptAt: row.governance_next_attempt_at?.toISOString(),
        governanceLastAttemptAt: row.governance_last_attempt_at?.toISOString(),
      };

      // Execute revocation
      const revokeResult = await this.executor.revoke(fulfilledRequest);

      if (revokeResult.success) {
        this.metrics.successfulExpirations++;
        return {
          requestId: item.requestId,
          status: "REVOKED",
          attemptCount: attemptCount + 1,
        };
      }

      // Determine if error is retryable
      const errorInfo = this.classifyError(revokeResult.error || revokeResult.message);
      
      if (errorInfo.isRetryable && attemptCount + 1 < maxRetries) {
        this.metrics.retryScheduled++;
        const delay = this.calculateBackoff(attemptCount + 1);
        const nextAttemptAt = new Date(Date.now() + delay);

        logger.info({
          requestId: item.requestId,
          attemptCount: attemptCount + 1,
          maxRetries,
          delayMs: delay,
          nextAttemptAt: nextAttemptAt.toISOString(),
          errorCode: errorInfo.errorCode,
        }, "Scheduling retry");

        await this.recordAudit("EXPIRATION_SKIPPED", item.requestId, {
          reason: "retry_scheduled",
          attemptCount: attemptCount + 1,
          maxRetries,
          nextAttemptAt: nextAttemptAt.toISOString(),
          errorCode: errorInfo.errorCode,
          errorMessage: errorInfo.errorMessage,
        }, row.correlation_id);

        return {
          requestId: item.requestId,
          status: "RETRY",
          attemptCount: attemptCount + 1,
          nextAttemptAt,
          errorCode: errorInfo.errorCode,
          errorMessage: errorInfo.errorMessage,
        };
      }

      // Terminal failure
      this.metrics.terminalFailures++;
      logger.error({
        requestId: item.requestId,
        attemptCount: attemptCount + 1,
        maxRetries,
        errorCode: errorInfo.errorCode,
        errorMessage: errorInfo.errorMessage,
      }, "Expiration failed permanently");

      await this.recordAudit("EXPIRATION_FAILED", item.requestId, {
        attemptCount: attemptCount + 1,
        attempt: attemptCount + 1,
        maxRetries,
        errorCode: errorInfo.errorCode,
        errorMessage: errorInfo.errorMessage,
        terminal: true,
      }, row.correlation_id);

      return {
        requestId: item.requestId,
        status: "REVOCATION_FAILED",
        attemptCount: attemptCount + 1,
        errorCode: errorInfo.errorCode,
        errorMessage: errorInfo.errorMessage,
      };

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error({ err, requestId: item.requestId }, "Unexpected error processing expiration");

      // Treat unexpected errors as retryable if we have retries left
      if (attemptCount + 1 < maxRetries) {
        const delay = this.calculateBackoff(attemptCount + 1);
        const nextAttemptAt = new Date(Date.now() + delay);

        await this.recordAudit("EXPIRATION_SKIPPED", item.requestId, {
          reason: "retry_scheduled",
          attemptCount: attemptCount + 1,
          maxRetries,
          nextAttemptAt: nextAttemptAt.toISOString(),
          errorCode: "UNEXPECTED_ERROR",
          errorMessage,
        }, randomUUID());

        return {
          requestId: item.requestId,
          status: "RETRY",
          attemptCount: attemptCount + 1,
          nextAttemptAt,
          errorCode: 0,
          errorMessage,
        };
      }

      this.metrics.terminalFailures++;
      await this.recordAudit("EXPIRATION_FAILED", item.requestId, {
        attemptCount: attemptCount + 1,
        maxRetries,
        errorCode: 0,
        errorMessage,
        terminal: true,
      }, randomUUID());

      return {
        requestId: item.requestId,
        status: "REVOCATION_FAILED",
        attemptCount: attemptCount + 1,
        errorCode: 0,
        errorMessage,
      };
    }
  }

  // ============================================================================
  // PHASE 3: FINALIZE (Write final results)
  // ============================================================================
  private async finalizeBatch(results: ExpirationResult[]): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      for (const result of results) {
        const now = new Date();

        switch (result.status) {
          case "REVOKED": {
            await client.query(
              `UPDATE access_requests SET
                status = 'REVOKED',
                version = version + 1,
                updated_at = NOW(),
                expiration_attempt_count = $2,
                lease_owner = NULL,
                lease_until = NULL,
                lease_acquired_at = NULL
              WHERE id = $1`,
              [result.requestId, result.attemptCount]
            );
            await this.recordAudit("REVOCATION_SUCCEEDED", result.requestId, {
              workerId: this.workerId,
              attemptCount: result.attemptCount,
            });
            break;
          }

          case "RETRY": {
            await client.query(
              `UPDATE access_requests SET
                status = 'RETRY',
                version = version + 1,
                updated_at = NOW(),
                expiration_attempt_count = $2,
                expiration_next_attempt_at = $3,
                expiration_last_error = $4,
                expiration_last_error_code = $5,
                expiration_last_attempt_at = $6,
                lease_owner = NULL,
                lease_until = NULL,
                lease_acquired_at = NULL
              WHERE id = $1`,
              [result.requestId, result.attemptCount, result.nextAttemptAt, result.errorCode, result.errorCode, now]
            );
            break;
          }

          case "REVOCATION_FAILED": {
            await client.query(
              `UPDATE access_requests SET
                status = 'REVOCATION_FAILED',
                version = version + 1,
                updated_at = NOW(),
                expiration_attempt_count = $2,
                expiration_next_attempt_at = NULL,
                expiration_last_error = $3,
                expiration_last_error_code = $4,
                expiration_last_attempt_at = $5,
                lease_owner = NULL,
                lease_until = NULL,
                lease_acquired_at = NULL
              WHERE id = $1`,
              [result.requestId, result.attemptCount, result.errorCode, result.errorCode, now]
            );
            break;
          }

          case "SKIPPED": {
            // Just release the lease
            await client.query(
              `UPDATE access_requests SET
                version = version + 1,
                updated_at = NOW(),
                lease_owner = NULL,
                lease_until = NULL,
                lease_acquired_at = NULL
              WHERE id = $1`,
              [result.requestId]
            );
            break;
          }
        }
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // ============================================================================
  // Lease Management
  // ============================================================================

  private startLeaseRenewal(): void {
    const renew = async () => {
      if (!this.running) return;

      try {
        const now = new Date();
        const margin = new Date(now.getTime() + this.config.leaseRenewalMarginMs);

        // Renew leases that are about to expire and still owned by us
        const result = await this.pool.query(
          `UPDATE access_requests SET
            lease_until = $1,
            lease_acquired_at = $2
          WHERE lease_owner = $3
            AND lease_until < $4
            AND lease_until > $5`,
          [
            new Date(now.getTime() + this.config.leaseDurationMs),
            now,
            this.workerId,
            margin,
            now
          ]
        );

        if (result.rowCount && result.rowCount > 0) {
          this.metrics.leaseRenewals += result.rowCount;
          logger.debug({ 
            workerId: this.workerId, 
            renewed: result.rowCount 
          }, "Renewed leases");
        }

        // Count expired leases (for metrics)
        const expiredResult = await this.pool.query(
          `SELECT COUNT(*) as count FROM access_requests 
           WHERE lease_owner = $1 AND lease_until < $2`,
          [this.workerId, now]
        );
        this.metrics.expiredLeases = parseInt(expiredResult.rows[0].count);

      } catch (err) {
        logger.error({ err, workerId: this.workerId }, "Error renewing leases");
      }

      // Schedule next renewal (every 15 seconds)
      if (this.running) {
        this.leaseRenewalTimer = setTimeout(renew, 15000);
      }
    };

    this.leaseRenewalTimer = setTimeout(renew, 15000);
  }

  private async releaseAllLeases(): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE access_requests SET
          lease_owner = NULL,
          lease_until = NULL,
          lease_acquired_at = NULL
        WHERE lease_owner = $1`,
        [this.workerId]
      );
      logger.info({ workerId: this.workerId }, "Released all leases on shutdown");
    } catch (err) {
      logger.error({ err, workerId: this.workerId }, "Error releasing leases");
    }
  }

  // ============================================================================
  // Metrics & Adaptive Polling
  // ============================================================================

  private async updateExpirationLagMetrics(now: Date): Promise<void> {
    try {
      const result = await this.pool.query(
        `SELECT 
           COALESCE(access_expires_at, expiration_next_attempt_at) as due_time
         FROM access_requests
         WHERE 
           (status = 'FULFILLED' AND access_expires_at IS NOT NULL AND access_expires_at <= $1)
           OR (status = 'RETRY' AND expiration_next_attempt_at IS NOT NULL AND expiration_next_attempt_at <= $1)
         ORDER BY due_time ASC
         LIMIT 1000`,
        [now]
      );

      if (result.rows.length > 0) {
        const lags = result.rows.map(r => now.getTime() - new Date(r.due_time).getTime());
        lags.sort((a, b) => a - b);

        this.metrics.oldestOverdueAgeMs = lags[lags.length - 1];
        this.metrics.expirationLagMaxMs = lags[lags.length - 1];
        this.metrics.expirationLagP50Ms = lags[Math.floor(lags.length * 0.5)];
        this.metrics.expirationLagP95Ms = lags[Math.floor(lags.length * 0.95)];
        this.metrics.expirationLagP99Ms = lags[Math.floor(lags.length * 0.99)];
      } else {
        this.metrics.oldestOverdueAgeMs = 0;
        this.metrics.expirationLagMaxMs = 0;
        this.metrics.expirationLagP50Ms = 0;
        this.metrics.expirationLagP95Ms = 0;
        this.metrics.expirationLagP99Ms = 0;
      }
    } catch (err) {
      logger.error({ err }, "Error updating expiration lag metrics");
    }
  }

  private handleEmptyPoll(): void {
    this.metrics.consecutiveEmptyPolls++;
    
    if (this.config.adaptivePolling) {
      // Adaptive backoff
      if (this.metrics.consecutiveEmptyPolls <= 2) {
        this.currentPollIntervalMs = Math.max(
          this.config.minPollIntervalMs,
          this.currentPollIntervalMs / 2
        );
      } else if (this.metrics.consecutiveEmptyPolls <= 5) {
        this.currentPollIntervalMs = Math.min(
          this.config.maxPollIntervalMs,
          this.currentPollIntervalMs * 1.5
        );
      } else {
        this.currentPollIntervalMs = this.config.maxPollIntervalMs;
      }
    }
  }

  private scheduleNextPoll(): void {
    if (!this.running) return;

    const jitter = (Math.random() - 0.5) * 2 * this.config.pollJitterMs;
    const delay = Math.max(this.config.minPollIntervalMs, this.currentPollIntervalMs + jitter);

    this.pollTimer = setTimeout(() => {
      if (this.running) {
        this.processDueExpirations();
      }
    }, delay);
  }

  // ============================================================================
  // Error Classification & Backoff
  // ============================================================================

  private classifyError(errorMessage: string): { isRetryable: boolean; errorCode: number; errorMessage: string } {
    // GitHub rate limit
    if (errorMessage.includes("429") || errorMessage.toLowerCase().includes("rate limit")) {
      return { isRetryable: true, errorCode: 429, errorMessage };
    }

    // GitHub server errors
    if (errorMessage.includes("500") || 
        errorMessage.includes("502") || 
        errorMessage.includes("503") || 
        errorMessage.includes("504")) {
      const match = errorMessage.match(/(5\d{2})/);
      return { isRetryable: true, errorCode: match ? parseInt(match[1]) : 500, errorMessage };
    }

    // Network errors
    if (errorMessage.includes("ETIMEDOUT") ||
        errorMessage.includes("ECONNRESET") ||
        errorMessage.includes("ENOTFOUND") ||
        errorMessage.includes("timeout") ||
        errorMessage.includes("network")) {
      return { isRetryable: true, errorCode: 0, errorMessage };
    }

    // Authentication/authorization - typically NOT retryable
    if (errorMessage.includes("401") || 
        errorMessage.includes("403") || 
        errorMessage.includes("authentication") ||
        errorMessage.includes("authorization")) {
      return { isRetryable: false, errorCode: 401, errorMessage };
    }

    // Not found - may be already revoked
    if (errorMessage.includes("404") || errorMessage.includes("not found")) {
      return { isRetryable: false, errorCode: 404, errorMessage };
    }

    // Default: retryable
    return { isRetryable: true, errorCode: 0, errorMessage };
  }

  private calculateBackoff(attempt: number): number {
    const delay = Math.min(
      this.config.baseRetryDelayMs * Math.pow(2, attempt - 1),
      this.config.maxRetryDelayMs
    );
    
    // Add jitter
    const jitter = delay * this.config.jitterFactor * (Math.random() * 2 - 1);
    return Math.floor(Math.max(0, delay + jitter));
  }

  // ============================================================================
  // Audit Recording
  // ============================================================================

  private async recordAudit(
    type: AuditEventType,
    requestId: string,
    metadata: Record<string, unknown>,
    correlationId?: string
  ): Promise<void> {
    try {
      await this.auditStore.append({
        eventId: randomUUID(),
        requestId,
        correlationId: correlationId || randomUUID(),
        actor: `scheduler:${this.workerId}`,
        timestamp: new Date().toISOString(),
        type,
        metadata,
      });
    } catch (err) {
      logger.error({ err, type, requestId }, "Failed to record audit event");
    }
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createExpirationScheduler(
  executor: AccessExecutor,
  auditStore: AuditEventStore,
  pool: Pool,
  config?: Partial<SchedulerConfig>
): ExpirationScheduler {
  return new ExpirationScheduler(executor, auditStore, pool, config);
}