import { Pool } from "pg";
import { getLogger } from "@opnory/observability";
import { loadConfig } from "@opnory/config";
import {
  AccessRequest,
  AccessRequestStatus,
  GovernanceProvider,
  GovernanceReconciler,
  GovernanceRequestStatus,
  GovernanceAssignment,
  EntitlementRef,
  GovernedEntitlement,
  GovernanceSubject,
} from "@opnory/access-types";
import {
  AuditEventStore,
  AuditEventType,
  recordAuditEvent,
} from "@opnory/access-audit";
import { randomUUID } from "crypto";

const logger = getLogger().child({
  component: "governance-reconciliation-worker",
});

// ============================================================================
// Configuration
// ============================================================================

export interface ReconciliationWorkerConfig {
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

export const DEFAULT_RECONCILIATION_WORKER_CONFIG: ReconciliationWorkerConfig =
  {
    pollIntervalMs: 10000,
    pollJitterMs: 3000,
    maxPollIntervalMs: 60000,
    minPollIntervalMs: 2000,
    leaseDurationMs: 120000, // 2 minutes
    leaseRenewalMarginMs: 20000, // Renew if less than 20s remaining
    batchSize: 25,
    providerConcurrency: 5,
    maxRetries: 3,
    baseRetryDelayMs: 10000,
    maxRetryDelayMs: 600000,
    jitterFactor: 0.2,
    adaptivePolling: true,
  };

// ============================================================================
// Metrics
// ============================================================================

export interface ReconciliationWorkerMetrics {
  claimsThisPoll: number;
  claimsTotal: number;
  successfulReconciliations: number;
  skippedReconciliations: number;
  driftDetected: number;
  driftCorrected: number;
  retryScheduled: number;
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
  requestId: string;
  status:
    | "RECONCILED"
    | "DRIFT_DETECTED"
    | "DRIFT_CORRECTED"
    | "RETRY"
    | "RECONCILIATION_FAILED"
    | "SKIPPED";
  attemptCount: number;
  errorCode?: number;
  errorMessage?: string;
  nextAttemptAt?: Date;
  driftDetails?: {
    previousState: string;
    observedState: string;
    provider: string;
    externalAssignmentId: string;
  };
}

// ============================================================================
// Governance Reconciliation Worker
// ============================================================================

export class GovernanceReconciliationWorker {
  private pool: Pool;
  private reconciler: GovernanceReconciler;
  private auditStore: AuditEventStore;
  private config: ReconciliationWorkerConfig;
  private workerId: string;
  private running = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private currentPollIntervalMs: number;
  private consecutiveEmptyPolls = 0;
  private metrics: ReconciliationWorkerMetrics;
  private leaseRenewalTimer: NodeJS.Timeout | null = null;

  constructor(
    reconciler: GovernanceReconciler,
    auditStore: AuditEventStore,
    pool: Pool,
    config: Partial<ReconciliationWorkerConfig> = {},
  ) {
    this.pool = pool;
    this.reconciler = reconciler;
    this.auditStore = auditStore;
    this.config = { ...DEFAULT_RECONCILIATION_WORKER_CONFIG, ...config };
    this.workerId = `${process.env.HOSTNAME || "worker"}-${process.pid}-${randomUUID().slice(0, 8)}`;
    this.currentPollIntervalMs = this.config.pollIntervalMs;
    this.metrics = this.initializeMetrics();
  }

  private initializeMetrics(): ReconciliationWorkerMetrics {
    return {
      claimsThisPoll: 0,
      claimsTotal: 0,
      successfulReconciliations: 0,
      skippedReconciliations: 0,
      driftDetected: 0,
      driftCorrected: 0,
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
      logger.warn("Governance reconciliation worker already running");
      return;
    }

    logger.info(
      { workerId: this.workerId, config: this.config },
      "Starting governance reconciliation worker",
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
      "Stopping governance reconciliation worker",
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

  getMetrics(): ReconciliationWorkerMetrics {
    return { ...this.metrics };
  }

  getWorkerId(): string {
    return this.workerId;
  }

  // Public method for testing - runs a single poll cycle
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
      const claimedRequests = await this.claimDueReconciliations(now);

      this.metrics.claimsThisPoll = claimedRequests.length;
      this.metrics.claimsTotal += claimedRequests.length;

      if (claimedRequests.length === 0) {
        this.handleEmptyPoll();
        return;
      }

      this.metrics.consecutiveEmptyPolls = 0;
      this.metrics.activeLeases = claimedRequests.length;

      // 2. PROCESS: Call provider APIs outside transaction
      const results = await this.processBatch(claimedRequests);

      // 3. FINALIZE: Write final results
      await this.finalizeBatch(results);
    } catch (err) {
      logger.error(
        { err, workerId: this.workerId },
        "Error processing governance reconciliations",
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
      requestId: string;
      governanceAuthority: string;
      governanceExternalRequestId: string;
      governanceAssignmentId: string | null;
      governanceNextCheckAt: Date | null;
      governanceNextAttemptAt: Date | null;
      governanceAttemptCount: number;
      governanceMaxRetries: number;
      status: AccessRequestStatus;
      correlationId: string;
    }>
  > {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      // Find due reconciliations that are not leased or have expired leases
      // Eligible states:
      // - AWAITING_AUTHORITY_DECISION + governanceNextCheckAt <= now
      // - FULFILLED with external governance + governanceNextCheckAt <= now (assignment drift check)
      // - RETRY/RECONCILIATION_FAILED + governanceNextAttemptAt <= now
      const claimQuery = `
        SELECT 
          id,
          correlation_id,
          status,
          governance_authority,
          governance_external_request_id,
          governance_assignment_id,
          governance_next_check_at,
          governance_next_attempt_at,
          governance_attempt_count,
          governance_max_retries
        FROM access_requests
        WHERE 
          (
            (status = 'AWAITING_AUTHORITY_DECISION' AND governance_next_check_at IS NOT NULL AND governance_next_check_at <= $1)
            OR (status = 'FULFILLED' AND governance_authority IN ('entra', 'okta') AND governance_next_check_at IS NOT NULL AND governance_next_check_at <= $1)
            OR (status IN ('RETRY', 'RECONCILIATION_FAILED') AND governance_next_attempt_at IS NOT NULL AND governance_next_attempt_at <= $1)
          )
          AND (governance_lease_until IS NULL OR governance_lease_until < $1)
        ORDER BY 
          COALESCE(governance_next_check_at, governance_next_attempt_at) ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $2
      `;

      const claimResult = await client.query(claimQuery, [
        now,
        this.config.batchSize,
      ]);
      const claimed = claimResult.rows;

      if (claimed.length > 0) {
        const leaseUntil = new Date(
          now.getTime() + this.config.leaseDurationMs,
        );
        const leaseAcquiredAt = now;

        const leaseQuery = `
          UPDATE access_requests
          SET 
            governance_lease_owner = $1,
            governance_lease_until = $2,
            governance_lease_acquired_at = $3,
            version = version + 1,
            updated_at = NOW()
          WHERE id = ANY($4)
        `;

        await client.query(leaseQuery, [
          this.workerId,
          leaseUntil,
          leaseAcquiredAt,
          claimed.map((r) => r.id),
        ]);

        // Record audit event for claim
        for (const request of claimed) {
          await recordAuditEvent(this.auditStore, {
            eventId: randomUUID(),
            requestId: request.id,
            correlationId: request.correlation_id,
            actor: "system",
            timestamp: now.toISOString(),
            type: "GOVERNANCE_RECONCILIATION_STARTED",
            metadata: {
              workerId: this.workerId,
              leaseUntil: leaseUntil.toISOString(),
              attemptCount: request.governance_attempt_count,
              maxRetries: request.governance_max_retries,
              status: request.status,
              governanceAuthority: request.governance_authority,
            },
          });
        }

        await client.query("COMMIT");

        logger.debug(
          {
            workerId: this.workerId,
            claimed: claimed.length,
            leaseUntil: leaseUntil.toISOString(),
          },
          "Claimed governance reconciliations",
        );
      } else {
        await client.query("COMMIT");
      }

      return claimed.map((r) => ({
        requestId: r.id,
        governanceAuthority: r.governance_authority,
        governanceExternalRequestId: r.governance_external_request_id,
        governanceAssignmentId: r.governance_assignment_id,
        governanceNextCheckAt: r.governance_next_check_at
          ? new Date(r.governance_next_check_at)
          : null,
        governanceNextAttemptAt: r.governance_next_attempt_at
          ? new Date(r.governance_next_attempt_at)
          : null,
        governanceAttemptCount: r.governance_attempt_count ?? 0,
        governanceMaxRetries: r.governance_max_retries ?? 3,
        status: r.status as AccessRequestStatus,
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
  // PHASE 2: PROCESS (Provider API calls outside transaction)
  // ============================================================================

  private async processBatch(
    claimed: Array<{
      requestId: string;
      governanceAuthority: string;
      governanceExternalRequestId: string;
      governanceAssignmentId: string | null;
      governanceNextCheckAt: Date | null;
      governanceNextAttemptAt: Date | null;
      governanceAttemptCount: number;
      governanceMaxRetries: number;
      status: AccessRequestStatus;
      correlationId: string;
    }>,
  ): Promise<ReconciliationResult[]> {
    const results: ReconciliationResult[] = [];

    // Process with controlled concurrency
    const concurrency = this.config.providerConcurrency;
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
    requestId: string;
    governanceAuthority: string;
    governanceExternalRequestId: string;
    governanceAssignmentId: string | null;
    governanceNextCheckAt: Date | null;
    governanceNextAttemptAt: Date | null;
    governanceAttemptCount: number;
    governanceMaxRetries: number;
    status: AccessRequestStatus;
    correlationId: string;
  }): Promise<ReconciliationResult> {
    const attemptCount = item.governanceAttemptCount;
    const maxRetries = item.governanceMaxRetries;
    const now = new Date();

    logger.info(
      {
        workerId: this.workerId,
        requestId: item.requestId,
        governanceAuthority: item.governanceAuthority,
        attemptCount,
        maxRetries,
        status: item.status,
      },
      "Processing governance reconciliation",
    );

    try {
      // Fetch the full request to validate it's still externally governed
      const requestResult = await this.pool.query(
        "SELECT * FROM access_requests WHERE id = $1",
        [item.requestId],
      );

      if (requestResult.rows.length === 0) {
        logger.warn(
          { requestId: item.requestId },
          "Request not found, skipping",
        );
        return {
          requestId: item.requestId,
          status: "SKIPPED",
          attemptCount,
          errorCode: 404,
          errorMessage: "Request not found",
        };
      }

      const row = requestResult.rows[0];

      // Re-validate: request must still be externally governed
      if (!row.governance_authority || row.governance_authority === "local") {
        logger.info(
          {
            requestId: item.requestId,
            authority: row.governance_authority,
          },
          "Request no longer externally governed, skipping",
        );
        return {
          requestId: item.requestId,
          status: "SKIPPED",
          attemptCount,
          errorCode: 0,
          errorMessage: "No longer externally governed",
        };
      }

      // Re-validate: status must still be eligible for reconciliation
      const eligibleStatuses = [
        "AWAITING_AUTHORITY_DECISION",
        "FULFILLED",
        "RETRY",
        "RECONCILIATION_FAILED",
      ];
      if (!eligibleStatuses.includes(row.status)) {
        logger.info(
          {
            requestId: item.requestId,
            status: row.status,
          },
          "Request status no longer eligible for reconciliation, skipping",
        );
        return {
          requestId: item.requestId,
          status: "SKIPPED",
          attemptCount,
          errorCode: 0,
          errorMessage: `Status ${row.status} not eligible for reconciliation`,
        };
      }

      // Get the provider
      const provider = this.getProvider(item.governanceAuthority);
      if (!provider) {
        throw new Error(
          `No provider for authority: ${item.governanceAuthority}`,
        );
      }

      // Route to appropriate reconciliation logic based on status
      if (item.status === "AWAITING_AUTHORITY_DECISION") {
        return await this.reconcilePendingRequest(item, provider, row);
      } else if (item.status === "FULFILLED") {
        return await this.reconcileAssignment(item, provider, row);
      } else {
        // RETRY or RECONCILIATION_FAILED
        return await this.reconcileRetry(item, provider, row);
      }
    } catch (err) {
      // Handle provider errors with retry logic
      const errorInfo = this.classifyError(err);

      if (attemptCount + 1 < maxRetries && errorInfo.retryable) {
        this.metrics.retryScheduled++;

        const backoffMs = Math.min(
          this.config.baseRetryDelayMs * Math.pow(2, attemptCount),
          this.config.maxRetryDelayMs,
        );
        const jitter = backoffMs * this.config.jitterFactor * Math.random();
        const nextAttemptAt = new Date(now.getTime() + backoffMs + jitter);

        logger.warn(
          {
            requestId: item.requestId,
            attemptCount: attemptCount + 1,
            maxRetries,
            nextAttemptAt: nextAttemptAt.toISOString(),
            errorCode: errorInfo.errorCode,
            errorMessage: errorInfo.errorMessage,
          },
          "Scheduling governance reconciliation retry",
        );

        await recordAuditEvent(this.auditStore, {
          eventId: randomUUID(),
          requestId: item.requestId,
          correlationId: item.correlationId,
          actor: "system",
          timestamp: now.toISOString(),
          type: "GOVERNANCE_RECONCILIATION_FAILED",
          metadata: {
            workerId: this.workerId,
            attemptCount: attemptCount + 1,
            maxRetries,
            nextAttemptAt: nextAttemptAt.toISOString(),
            errorCode: errorInfo.errorCode,
            errorMessage: errorInfo.errorMessage,
            retryable: true,
          },
        });

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
      logger.error(
        {
          requestId: item.requestId,
          attemptCount: attemptCount + 1,
          maxRetries,
          errorCode: errorInfo.errorCode,
          errorMessage: errorInfo.errorMessage,
        },
        "Governance reconciliation failed permanently",
      );

      await recordAuditEvent(this.auditStore, {
        eventId: randomUUID(),
        requestId: item.requestId,
        correlationId: item.correlationId,
        actor: "system",
        timestamp: now.toISOString(),
        type: "GOVERNANCE_RECONCILIATION_FAILED",
        metadata: {
          workerId: this.workerId,
          attemptCount: attemptCount + 1,
          maxRetries,
          errorCode: errorInfo.errorCode,
          errorMessage: errorInfo.errorMessage,
          retryable: false,
          terminal: true,
        },
      });

      return {
        requestId: item.requestId,
        status: "RECONCILIATION_FAILED",
        attemptCount: attemptCount + 1,
        errorCode: errorInfo.errorCode,
        errorMessage: errorInfo.errorMessage,
      };
    }
  }

  private async reconcilePendingRequest(
    item: any,
    provider: GovernanceProvider,
    row: any,
  ): Promise<ReconciliationResult> {
    // Poll the external authority for decision
    const status = await provider.getRequestStatus(
      item.governanceExternalRequestId,
    );

    const now = new Date();

    if (status.status === "APPROVED") {
      // External authority approved - transition to APPROVED
      await this.pool.query(
        `
        UPDATE access_requests
        SET 
          status = 'APPROVED',
          governance_assignment_id = $2,
          governance_assignment_expires_at = $3,
          governance_last_checked_at = $4,
          governance_next_check_at = NULL,
          version = version + 1,
          updated_at = NOW()
        WHERE id = $1
      `,
        [item.requestId, status.assignmentId, status.assignmentExpiresAt, now],
      );

      await recordAuditEvent(this.auditStore, {
        eventId: randomUUID(),
        requestId: item.requestId,
        correlationId: item.correlationId,
        actor: "system",
        timestamp: now.toISOString(),
        type: "GOVERNANCE_RECONCILIATION_SUCCEEDED",
        metadata: {
          workerId: this.workerId,
          governanceAuthority: item.governanceAuthority,
          externalRequestId: item.governanceExternalRequestId,
          previousState: "AWAITING_AUTHORITY_DECISION",
          newState: "APPROVED",
          assignmentId: status.assignmentId,
          assignmentExpiresAt: status.assignmentExpiresAt,
        },
      });

      this.metrics.successfulReconciliations++;
      return {
        requestId: item.requestId,
        status: "RECONCILED",
        attemptCount: item.governanceAttemptCount,
      };
    }

    if (status.status === "DENIED") {
      // External authority denied - transition to DENIED
      await this.pool.query(
        `
        UPDATE access_requests
        SET 
          status = 'DENIED',
          governance_last_checked_at = $2,
          governance_next_check_at = NULL,
          denied_at = $2,
          denied_by = 'external_authority',
          denied_reason = 'External governance authority denied request',
          version = version + 1,
          updated_at = NOW()
        WHERE id = $1
      `,
        [item.requestId, now],
      );

      await recordAuditEvent(this.auditStore, {
        eventId: randomUUID(),
        requestId: item.requestId,
        correlationId: item.correlationId,
        actor: "system",
        timestamp: now.toISOString(),
        type: "GOVERNANCE_RECONCILIATION_SUCCEEDED",
        metadata: {
          workerId: this.workerId,
          governanceAuthority: item.governanceAuthority,
          externalRequestId: item.governanceExternalRequestId,
          previousState: "AWAITING_AUTHORITY_DECISION",
          newState: "DENIED",
        },
      });

      this.metrics.successfulReconciliations++;
      return {
        requestId: item.requestId,
        status: "RECONCILED",
        attemptCount: item.governanceAttemptCount,
      };
    }

    if (status.status === "PENDING") {
      // Still pending - schedule next check
      const nextCheckAt = new Date(now.getTime() + this.config.pollIntervalMs);

      await this.pool.query(
        `
        UPDATE access_requests
        SET 
          governance_last_checked_at = $2,
          governance_next_check_at = $3,
          version = version + 1,
          updated_at = NOW()
        WHERE id = $1
      `,
        [item.requestId, now, nextCheckAt],
      );

      this.metrics.skippedReconciliations++;
      return {
        requestId: item.requestId,
        status: "SKIPPED",
        attemptCount: item.governanceAttemptCount,
        errorMessage: "Still pending, next check scheduled",
      };
    }

    // Unknown or failed status
    if (status.status === "FAILED") {
      throw new Error(`Provider returned FAILED status`);
    }
    throw new Error(`Unknown external status: ${status.status}`);
  }

  private async reconcileAssignment(
    item: any,
    provider: GovernanceProvider,
    row: any,
  ): Promise<ReconciliationResult> {
    // Check for assignment drift - call getAssignment on provider
    // We need to reconstruct subject and entitlement from the request
    const subject: GovernanceSubject = {
      id: row.requester_id,
      displayName: undefined,
      email: row.requester_email,
      source: "manual",
      raw: { requesterId: row.requester_id },
    };

    const entitlement: GovernedEntitlement = {
      entitlementId: row.entitlement_id,
      authority: item.governanceAuthority as any,
      externalId: row.governance_assignment_id || row.entitlement_id,
      externalName: row.entitlement_name,
      metadata: {},
    };

    const assignment = await provider.getAssignment(subject, entitlement);
    const now = new Date();

    if (!assignment) {
      // Assignment not found externally - DRIFT DETECTED
      logger.warn(
        {
          requestId: item.requestId,
          governanceAuthority: item.governanceAuthority,
          externalAssignmentId: item.governanceAssignmentId,
        },
        "External assignment not found - drift detected",
      );

      this.metrics.driftDetected++;

      await recordAuditEvent(this.auditStore, {
        eventId: randomUUID(),
        requestId: item.requestId,
        correlationId: item.correlationId,
        actor: "system",
        timestamp: now.toISOString(),
        type: "GOVERNANCE_DRIFT_DETECTED",
        metadata: {
          workerId: this.workerId,
          governanceAuthority: item.governanceAuthority,
          externalAssignmentId: item.governanceAssignmentId,
          previousState: "FULFILLED",
          observedState: "NOT_FOUND",
          driftType: "ASSIGNMENT_MISSING",
        },
      });

      // Determine correction based on ownership rules
      const governanceConfig = row.metadata?.governance;
      const fulfillmentOwner = governanceConfig?.fulfillmentOwner || "opnory";

      if (fulfillmentOwner === "opnory") {
        // Opnory owns fulfillment - transition to REVOCATION_PENDING
        await this.pool.query(
          `
          UPDATE access_requests
          SET 
            status = 'REVOCATION_PENDING',
            governance_last_checked_at = $2,
            governance_next_check_at = $3,
            version = version + 1,
            updated_at = NOW()
          WHERE id = $1
        `,
          [
            item.requestId,
            now,
            new Date(now.getTime() + this.config.pollIntervalMs),
          ],
        );

        this.metrics.driftCorrected++;

        await recordAuditEvent(this.auditStore, {
          eventId: randomUUID(),
          requestId: item.requestId,
          correlationId: item.correlationId,
          actor: "system",
          timestamp: now.toISOString(),
          type: "GOVERNANCE_STATE_CORRECTED",
          metadata: {
            workerId: this.workerId,
            governanceAuthority: item.governanceAuthority,
            previousState: "FULFILLED",
            newState: "REVOCATION_PENDING",
            correctionReason: "external_assignment_missing",
            fulfillmentOwner: "opnory",
          },
        });

        return {
          requestId: item.requestId,
          status: "DRIFT_CORRECTED",
          attemptCount: item.governanceAttemptCount,
          driftDetails: {
            previousState: "FULFILLED",
            observedState: "NOT_FOUND",
            provider: item.governanceAuthority,
            externalAssignmentId: item.governanceAssignmentId || "",
          },
        };
      } else {
        // External authority owns fulfillment - just update check time
        const nextCheckAt = new Date(
          now.getTime() + this.config.pollIntervalMs,
        );

        await this.pool.query(
          `
          UPDATE access_requests
          SET 
            governance_last_checked_at = $2,
            governance_next_check_at = $3,
            version = version + 1,
            updated_at = NOW()
          WHERE id = $1
        `,
          [item.requestId, now, nextCheckAt],
        );

        return {
          requestId: item.requestId,
          status: "DRIFT_DETECTED",
          attemptCount: item.governanceAttemptCount,
          driftDetails: {
            previousState: "FULFILLED",
            observedState: "NOT_FOUND",
            provider: item.governanceAuthority,
            externalAssignmentId: item.governanceAssignmentId || "",
          },
        };
      }
    }

    if (assignment.status === "REVOKED") {
      // External assignment revoked - DRIFT DETECTED
      logger.warn(
        {
          requestId: item.requestId,
          governanceAuthority: item.governanceAuthority,
          externalAssignmentId: item.governanceAssignmentId,
        },
        "External assignment revoked - drift detected",
      );

      this.metrics.driftDetected++;

      await recordAuditEvent(this.auditStore, {
        eventId: randomUUID(),
        requestId: item.requestId,
        correlationId: item.correlationId,
        actor: "system",
        timestamp: now.toISOString(),
        type: "GOVERNANCE_DRIFT_DETECTED",
        metadata: {
          workerId: this.workerId,
          governanceAuthority: item.governanceAuthority,
          externalAssignmentId: item.governanceAssignmentId,
          previousState: "FULFILLED",
          observedState: "REVOKED",
          driftType: "ASSIGNMENT_REVOKED",
        },
      });

      // Correct state based on ownership
      const governanceConfig = row.metadata?.governance;
      const fulfillmentOwner = governanceConfig?.fulfillmentOwner || "opnory";

      if (fulfillmentOwner === "opnory") {
        await this.pool.query(
          `
          UPDATE access_requests
          SET 
            status = 'REVOCATION_PENDING',
            governance_last_checked_at = $2,
            governance_next_check_at = $3,
            version = version + 1,
            updated_at = NOW()
          WHERE id = $1
        `,
          [
            item.requestId,
            now,
            new Date(now.getTime() + this.config.pollIntervalMs),
          ],
        );

        this.metrics.driftCorrected++;

        await recordAuditEvent(this.auditStore, {
          eventId: randomUUID(),
          requestId: item.requestId,
          correlationId: item.correlationId,
          actor: "system",
          timestamp: now.toISOString(),
          type: "GOVERNANCE_STATE_CORRECTED",
          metadata: {
            workerId: this.workerId,
            governanceAuthority: item.governanceAuthority,
            previousState: "FULFILLED",
            newState: "REVOCATION_PENDING",
            correctionReason: "external_assignment_revoked",
            fulfillmentOwner: "opnory",
          },
        });

        return {
          requestId: item.requestId,
          status: "DRIFT_CORRECTED",
          attemptCount: item.governanceAttemptCount,
          driftDetails: {
            previousState: "FULFILLED",
            observedState: "REVOKED",
            provider: item.governanceAuthority,
            externalAssignmentId: item.governanceAssignmentId || "",
          },
        };
      } else {
        const nextCheckAt = new Date(
          now.getTime() + this.config.pollIntervalMs,
        );

        await this.pool.query(
          `
          UPDATE access_requests
          SET 
            governance_last_checked_at = $2,
            governance_next_check_at = $3,
            version = version + 1,
            updated_at = NOW()
          WHERE id = $1
        `,
          [item.requestId, now, nextCheckAt],
        );

        return {
          requestId: item.requestId,
          status: "DRIFT_DETECTED",
          attemptCount: item.governanceAttemptCount,
          driftDetails: {
            previousState: "FULFILLED",
            observedState: "REVOKED",
            provider: item.governanceAuthority,
            externalAssignmentId: item.governanceAssignmentId || "",
          },
        };
      }
    }

    // Assignment still ACTIVE - just update check time
    const nextCheckAt = new Date(now.getTime() + this.config.pollIntervalMs);

    await this.pool.query(
      `
      UPDATE access_requests
      SET 
        governance_last_checked_at = $2,
        governance_next_check_at = $3,
        governance_assignment_id = $4,
        governance_assignment_expires_at = $5,
        version = version + 1,
        updated_at = NOW()
      WHERE id = $1
    `,
      [
        item.requestId,
        now,
        nextCheckAt,
        assignment.assignmentId,
        assignment.expiresAt,
      ],
    );

    this.metrics.successfulReconciliations++;
    return {
      requestId: item.requestId,
      status: "RECONCILED",
      attemptCount: item.governanceAttemptCount,
    };
  }

  private async reconcileRetry(
    item: any,
    provider: GovernanceProvider,
    row: any,
  ): Promise<ReconciliationResult> {
    // Retry the reconciliation based on the original status
    if (row.status === "FULFILLED" || row.governance_assignment_id) {
      return await this.reconcileAssignment(item, provider, row);
    } else {
      return await this.reconcilePendingRequest(item, provider, row);
    }
  }

  private getProvider(authority: string): GovernanceProvider | null {
    // This should be injected or resolved via a registry
    // For now, we access it through the reconciler
    return (this.reconciler as any).getProvider?.(authority) || null;
  }

  private classifyError(err: any): {
    retryable: boolean;
    errorCode: number;
    errorMessage: string;
  } {
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Network/timeout errors are retryable
    if (
      errorMessage.includes("timeout") ||
      errorMessage.includes("ECONNREFUSED") ||
      errorMessage.includes("ETIMEDOUT") ||
      errorMessage.includes("network")
    ) {
      return { retryable: true, errorCode: 503, errorMessage };
    }

    // Rate limiting is retryable
    if (errorMessage.includes("429") || errorMessage.includes("rate limit")) {
      return { retryable: true, errorCode: 429, errorMessage };
    }

    // Server errors are retryable
    if (
      errorMessage.includes("500") ||
      errorMessage.includes("502") ||
      errorMessage.includes("503")
    ) {
      return { retryable: true, errorCode: 500, errorMessage };
    }

    // Authentication/authorization errors are NOT retryable
    if (
      errorMessage.includes("401") ||
      errorMessage.includes("403") ||
      errorMessage.includes("unauthorized")
    ) {
      return { retryable: false, errorCode: 401, errorMessage };
    }

    // Not found - might be retryable (could be temporary)
    if (errorMessage.includes("404")) {
      return { retryable: true, errorCode: 404, errorMessage };
    }

    // Default: not retryable for unknown errors
    return { retryable: false, errorCode: 500, errorMessage };
  }

  // ============================================================================
  // PHASE 3: FINALIZE (Write results)
  // ============================================================================

  private async finalizeBatch(results: ReconciliationResult[]): Promise<void> {
    // For RECONCILED/DRIFT_DETECTED/DRIFT_CORRECTED, the state was already updated in processSingleReconciliation
    // For RETRY/RECONCILIATION_FAILED, update retry metadata

    for (const result of results) {
      if (result.status === "RETRY") {
        await this.pool.query(
          `
          UPDATE access_requests
          SET 
            status = 'RETRY',
            governance_attempt_count = $2,
            governance_next_attempt_at = $3,
            governance_last_attempt_at = $4,
            governance_last_error = $5,
            governance_last_error_code = $6,
            governance_lease_owner = NULL,
            governance_lease_until = NULL,
            governance_lease_acquired_at = NULL,
            version = version + 1,
            updated_at = NOW()
          WHERE id = $1
        `,
          [
            result.requestId,
            result.attemptCount,
            result.nextAttemptAt,
            new Date(),
            result.errorMessage,
            result.errorCode,
          ],
        );
      } else if (result.status === "RECONCILIATION_FAILED") {
        await this.pool.query(
          `
          UPDATE access_requests
          SET 
            status = 'RECONCILIATION_FAILED',
            governance_attempt_count = $2,
            governance_next_attempt_at = NULL,
            governance_last_attempt_at = $3,
            governance_last_error = $4,
            governance_last_error_code = $5,
            governance_lease_owner = NULL,
            governance_lease_until = NULL,
            governance_lease_acquired_at = NULL,
            version = version + 1,
            updated_at = NOW()
          WHERE id = $1
        `,
          [
            result.requestId,
            result.attemptCount,
            new Date(),
            result.errorMessage,
            result.errorCode,
          ],
        );
      } else if (
        result.status === "RECONCILED" ||
        result.status === "DRIFT_DETECTED" ||
        result.status === "DRIFT_CORRECTED"
      ) {
        // Release lease
        await this.pool.query(
          `
          UPDATE access_requests
          SET 
            governance_lease_owner = NULL,
            governance_lease_until = NULL,
            governance_lease_acquired_at = NULL,
            version = version + 1,
            updated_at = NOW()
          WHERE id = $1
        `,
          [result.requestId],
        );
      }
    }
  }

  // ============================================================================
  // Lease Renewal
  // ============================================================================

  private startLeaseRenewal(): void {
    const renewalInterval =
      this.config.leaseDurationMs - this.config.leaseRenewalMarginMs;

    this.leaseRenewalTimer = setInterval(async () => {
      if (!this.running) return;

      try {
        await this.renewLeases();
      } catch (err) {
        logger.error(
          { err, workerId: this.workerId },
          "Error renewing governance leases",
        );
      }
    }, renewalInterval);
  }

  private async renewLeases(): Promise<void> {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + this.config.leaseDurationMs);

    const result = await this.pool.query(
      `
      UPDATE access_requests
      SET 
        governance_lease_until = $1,
        governance_lease_acquired_at = $2,
        version = version + 1,
        updated_at = NOW()
      WHERE governance_lease_owner = $3
    `,
      [leaseUntil, now, this.workerId],
    );

    if (result.rowCount && result.rowCount > 0) {
      this.metrics.leaseRenewals += result.rowCount;
      logger.debug(
        {
          workerId: this.workerId,
          renewed: result.rowCount,
          leaseUntil: leaseUntil.toISOString(),
        },
        "Renewed governance leases",
      );
    }
  }

  private async releaseAllLeases(): Promise<void> {
    const now = new Date();

    await this.pool.query(
      `
      UPDATE access_requests
      SET 
        governance_lease_owner = NULL,
        governance_lease_until = NULL,
        governance_lease_acquired_at = NULL,
        version = version + 1,
        updated_at = NOW()
      WHERE governance_lease_owner = $1
    `,
      [this.workerId],
    );

    logger.info({ workerId: this.workerId }, "Released all governance leases");
  }

  // ============================================================================
  // Polling Helpers
  // ============================================================================

  private handleEmptyPoll(): void {
    this.metrics.consecutiveEmptyPolls++;

    if (this.config.adaptivePolling && this.consecutiveEmptyPolls > 3) {
      this.currentPollIntervalMs = Math.min(
        this.currentPollIntervalMs * 1.5,
        this.config.maxPollIntervalMs,
      );
    }

    this.scheduleNextPoll();
  }

  private scheduleNextPoll(): void {
    if (!this.running) return;

    let nextInterval = this.currentPollIntervalMs;

    if (this.config.pollJitterMs > 0) {
      const jitter = Math.random() * this.config.pollJitterMs;
      nextInterval += jitter;
    }

    this.metrics.currentPollIntervalMs = nextInterval;

    this.pollTimer = setTimeout(() => {
      if (this.running) {
        this.processDueReconciliations();
      }
    }, nextInterval);
  }
}
