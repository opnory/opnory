import { Pool, PoolClient } from "pg";
import { getLogger } from "@opnory/observability";
import { loadConfig } from "@opnory/config";
import { AccessRequest, AccessRequestStatus, FulfilledAccessRequest, toFulfilledAccessRequest } from "@opnory/access-types";
import { AuditEventStore, AuditEvent, AuditEventType } from "@opnory/access-audit";
import { AccessExecutor } from "@opnory/access-executor";
import { PgAccessRequestStore } from "./index.js";

const logger = getLogger().child({ component: "expiration-scheduler" });

// ============================================================================
// Expiration Scheduler
// ============================================================================

export interface ExpirationSchedulerConfig {
  pollIntervalMs: number;
  leaseDurationMs: number;
  maxRetries: number;
}

export interface ExpirationResult {
  requestId: string;
  status: "revoked" | "skipped_not_due" | "skipped_already_revoked" | "skipped_extended" | "skipped_not_fulfilled" | "revocation_failed";
  error?: string;
}

export class ExpirationScheduler {
  private pool: Pool;
  private store: PgAccessRequestStore;
  private auditStore: AuditEventStore;
  private executor: AccessExecutor;
  private config: ExpirationSchedulerConfig;
  private running: boolean = false;
  private intervalId: NodeJS.Timeout | null = null;

  constructor(
    executor: AccessExecutor,
    auditStore: AuditEventStore,
    pool?: Pool,
    config?: Partial<ExpirationSchedulerConfig>
  ) {
    this.pool = pool || this.createPool();
    this.store = new PgAccessRequestStore(this.pool);
    this.auditStore = auditStore;
    this.executor = executor;
    this.config = {
      pollIntervalMs: config?.pollIntervalMs ?? 60000, // 1 minute default
      leaseDurationMs: config?.leaseDurationMs ?? 300000, // 5 minutes
      maxRetries: config?.maxRetries ?? 3,
    };
  }

  private createPool(): Pool {
    const config = loadConfig();
    const databaseUrl = config.database?.url || "postgresql://opnory:***@localhost:5432/opnory";
    return new Pool({
      connectionString: databaseUrl,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Initial scan for overdue requests on startup
    await this.processDueExpirations();

    // Schedule periodic polling
    this.intervalId = setInterval(async () => {
      if (this.running) {
        try {
          await this.processDueExpirations();
        } catch (err) {
          logger.error({ err }, "Error processing expirations");
        }
      }
    }, this.config.pollIntervalMs);

    logger.info({ pollIntervalMs: this.config.pollIntervalMs }, "Expiration scheduler started");
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    await this.pool.end();
    logger.info("Expiration scheduler stopped");
  }

  private async processDueExpirations(): Promise<void> {
    const client = await this.pool.connect();
    try {
      // Find and claim due requests atomically using FOR UPDATE SKIP LOCKED
      const result = await client.query(
        `
        UPDATE access_requests
        SET 
          status = 'REVOCATION_PENDING',
          version = version + 1,
          updated_at = NOW()
        WHERE id IN (
          SELECT id FROM access_requests
          WHERE status = 'FULFILLED'
            AND access_expires_at IS NOT NULL
            AND access_expires_at <= NOW()
          ORDER BY access_expires_at ASC
          LIMIT 50
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id
        `
      );

      for (const row of result.rows) {
        await this.processSingleExpiration(row.id, client);
      }
    } finally {
      client.release();
    }
  }

  private async processSingleExpiration(requestId: string, client: PoolClient): Promise<ExpirationResult> {
    try {
      // Re-read the request inside a transaction to verify it's still expired
      const requestResult = await client.query(
        "SELECT * FROM access_requests WHERE id = $1 FOR UPDATE",
        [requestId]
      );

      if (requestResult.rows.length === 0) {
        return { requestId, status: "skipped_not_fulfilled", error: "Request not found" };
      }

      const request = this.mapRowToRequest(requestResult.rows[0]);

      // Verify preconditions before revoking
      const now = new Date();
      const currentStatus = request.status;

      if (currentStatus !== "FULFILLED") {
        // Another process already transitioned it
        await this.recordAudit("EXPIRATION_SKIPPED" as any, requestId, {
          reason: "not_fulfilled",
          currentStatus,
        });
        return { requestId, status: "skipped_not_fulfilled" };
      }

      if (!request.accessExpiresAt) {
        await this.recordAudit("EXPIRATION_SKIPPED" as any, requestId, {
          reason: "no_access_expires_at",
        });
        return { requestId, status: "skipped_not_due" };
      }

      const expiresAt = new Date(request.accessExpiresAt);
      if (expiresAt > now) {
        // Access was extended
        await this.recordAudit("EXPIRATION_SKIPPED" as any, requestId, {
          reason: "extended",
          accessExpiresAt: request.accessExpiresAt,
        });
        return { requestId, status: "skipped_extended" };
      }

      // Record that expiration is due and we're proceeding
      await this.recordAudit("EXPIRATION_DUE" as any, requestId, {
        accessExpiresAt: request.accessExpiresAt,
      });

      // Transition to REVOCATION_PENDING (already done in the claim query)
      // Now call the existing revocation path
      const fulfilledRequest = toFulfilledAccessRequest(request);
      const revocationResult = await this.executor.revoke(fulfilledRequest);

      if (!revocationResult.success) {
        // Revocation failed - revert status back to FULFILLED for retry
        await client.query(
          `UPDATE access_requests SET status = 'FULFILLED', version = version + 1, updated_at = NOW() WHERE id = $1`,
          [requestId]
        );

        await this.recordAudit("REVOCATION_FAILED" as any, requestId, {
          error: revocationResult.error,
          reason: revocationResult.reason,
        });

        return { requestId, status: "revocation_failed", error: revocationResult.error };
      }

      // Success - status is already REVOKED from the revoke() method
      await this.recordAudit("REVOCATION_SUCCEEDED" as any, requestId, {
        reconciledAbsent: true,
      });

      return { requestId, status: "revoked" };
    } catch (err) {
      logger.error({ err, requestId }, "Error processing single expiration");
      // Revert to FULFILLED on unexpected error
      try {
        await client.query(
          `UPDATE access_requests SET status = 'FULFILLED', version = version + 1, updated_at = NOW() WHERE id = $1`,
          [requestId]
        );
      } catch (revertErr) {
        logger.error({ revertErr, requestId }, "Failed to revert request status");
      }

      await this.recordAudit("REVOCATION_FAILED" as any, requestId, {
        error: err instanceof Error ? err.message : "Unknown error",
      });

      return { requestId, status: "revocation_failed", error: err instanceof Error ? err.message : "Unknown error" };
    }
  }

  private mapRowToRequest(row: any): AccessRequest {
    return {
      id: row.id,
      correlationId: row.correlation_id,
      requesterId: row.requester_id,
      requesterEmail: row.requester_email,
      externalIdentities: row.metadata?.externalIdentities || {},
      entitlement: {
        id: row.entitlement_id,
        name: row.entitlement_name,
        system: row.entitlement_system,
      },
      reason: row.reason,
      status: row.status as AccessRequestStatus,
      version: row.version,
      approvedAt: row.approved_at?.toISOString(),
      approvedBy: row.approved_by,
      deniedAt: row.denied_at?.toISOString(),
      deniedBy: row.denied_by,
      deniedReason: row.denied_reason,
      fulfilledAt: row.fulfilled_at?.toISOString(),
      fulfillmentError: row.fulfillment_error,
      accessExpiresAt: row.access_expires_at?.toISOString(),
      externalId: row.external_id,
      idempotencyKey: row.idempotency_key,
      metadata: row.metadata || {},
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private async recordAudit(
    type: "EXPIRATION_SCHEDULED" | "EXPIRATION_DUE" | "EXPIRATION_SKIPPED" | "REVOCATION_REQUESTED" | "REVOCATION_STARTED" | "REVOCATION_SUCCEEDED" | "REVOCATION_FAILED",
    requestId: string,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    const event: AuditEvent = {
      eventId: crypto.randomUUID(),
      requestId,
      correlationId: "", // Would need to fetch from request
      actor: "expiration-scheduler",
      timestamp: new Date().toISOString(),
      type: type as AuditEventType,
      metadata,
    };
    await this.auditStore.append(event);
  }
}

// ============================================================================
// Factory for creating a configured scheduler
// ============================================================================

export async function createExpirationScheduler(
  executor: AccessExecutor,
  auditStore: AuditEventStore,
  pool?: Pool,
  config?: Partial<ExpirationSchedulerConfig>
): Promise<ExpirationScheduler> {
  const scheduler = new ExpirationScheduler(executor, auditStore, pool, config);
  await scheduler.start();
  return scheduler;
}