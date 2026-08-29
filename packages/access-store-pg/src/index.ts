import { Pool, PoolClient, QueryResult } from "pg";
import { getLogger } from "@opnory/observability";
import { loadConfig } from "@opnory/config";
import {
  AccessRequest,
  ApprovedAccessRequest,
  AccessRequestStatus,
  ApprovalDecision,
  ExecutionResult,
  EntitlementRef,
  toApprovedAccessRequest,
} from "@opnory/access-types";
import {
  AuditEventStore,
  AuditEvent,
  AuditEventType,
} from "@opnory/access-audit";

const logger = getLogger().child({ component: "access-store-pg" });

// ============================================================================
// PostgreSQL Connection Pool (lazy, environment-bound)
// ============================================================================

let pgPool: Pool | undefined;

export function getPool(): Pool {
  if (!pgPool) {
    const databaseUrl = process.env.DATABASE_URL;

    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required but not set in environment");
    }

    pgPool = new Pool({
      connectionString: databaseUrl,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    pgPool.on("error", (err: Error) => {
      logger.error({ err }, "Unexpected error on idle PostgreSQL client");
    });
  }
  return pgPool;
}

export async function closePool(): Promise<void> {
  if (pgPool) {
    await pgPool.end();
    pgPool = undefined;
  }
}

export async function resetPool(): Promise<void> {
  if (pgPool) {
    await pgPool.end().catch(() => {});
    pgPool = undefined;
  }
}

// ============================================================================
// Schema Migration
// ============================================================================

const SCHEMA_SQL = `
-- Access Requests table
CREATE TABLE IF NOT EXISTS access_requests (
    id UUID PRIMARY KEY,
    correlation_id UUID NOT NULL,
    requester_id VARCHAR(255) NOT NULL,
    requester_email VARCHAR(255) NOT NULL,
    entitlement_id UUID NOT NULL,
    entitlement_name VARCHAR(255) NOT NULL,
    entitlement_system VARCHAR(100) NOT NULL,
    reason TEXT NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING_APPROVAL',
    version INTEGER NOT NULL DEFAULT 0,
    approved_at TIMESTAMPTZ,
    approved_by VARCHAR(255),
    denied_at TIMESTAMPTZ,
    denied_by VARCHAR(255),
    denied_reason TEXT,
    fulfilled_at TIMESTAMPTZ,
    fulfillment_error TEXT,
    access_expires_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    external_id VARCHAR(255),
    idempotency_key VARCHAR(500) UNIQUE NOT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Expiration retry fields
    expiration_attempt_count INTEGER NOT NULL DEFAULT 0,
    expiration_next_attempt_at TIMESTAMPTZ,
    expiration_max_retries INTEGER NOT NULL DEFAULT 3,
    expiration_last_error TEXT,
    expiration_last_error_code INTEGER,
    expiration_last_attempt_at TIMESTAMPTZ,
    -- Lease fields for distributed workers
    lease_owner VARCHAR(255),
    lease_until TIMESTAMPTZ,
    lease_acquired_at TIMESTAMPTZ,
    -- Governance fields
    governance_external_request_id VARCHAR(255),
    governance_authority VARCHAR(50),
    governance_assignment_id VARCHAR(255),
    governance_assignment_expires_at TIMESTAMPTZ,
    -- Reconciliation state fields
    governance_last_checked_at TIMESTAMPTZ,
    governance_next_check_at TIMESTAMPTZ,
    governance_retry_count INTEGER NOT NULL DEFAULT 0,
    governance_last_error TEXT,
    governance_last_error_code INTEGER,
    -- Governance lease fields for distributed reconciliation worker
    governance_lease_owner VARCHAR(255),
    governance_lease_until TIMESTAMPTZ,
    governance_lease_acquired_at TIMESTAMPTZ,
    governance_attempt_count INTEGER NOT NULL DEFAULT 0,
    governance_next_attempt_at TIMESTAMPTZ,
    governance_last_attempt_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_access_requests_requester ON access_requests(requester_id);
CREATE INDEX IF NOT EXISTS idx_access_requests_status ON access_requests(status);
CREATE INDEX IF NOT EXISTS idx_access_requests_correlation ON access_requests(correlation_id);
CREATE INDEX IF NOT EXISTS idx_access_requests_idempotency ON access_requests(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_access_requests_access_expires ON access_requests(access_expires_at);
CREATE INDEX IF NOT EXISTS idx_access_requests_expiration_retry ON access_requests(expiration_next_attempt_at) WHERE expiration_next_attempt_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_access_requests_expiration_lease ON access_requests(access_expires_at, expiration_next_attempt_at) WHERE access_expires_at IS NOT NULL AND status IN ('FULFILLED', 'RETRY');
CREATE INDEX IF NOT EXISTS idx_access_requests_lease ON access_requests(lease_until) WHERE lease_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_access_requests_governance_lease ON access_requests(governance_lease_until) WHERE governance_lease_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_access_requests_governance_next_check ON access_requests(governance_next_check_at) WHERE governance_next_check_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_access_requests_governance_retry ON access_requests(governance_next_attempt_at) WHERE governance_next_attempt_at IS NOT NULL;

-- Audit Events table
CREATE TABLE IF NOT EXISTS audit_events (
    event_id UUID PRIMARY KEY,
    request_id UUID NOT NULL,
    correlation_id UUID NOT NULL,
    actor VARCHAR(255) NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    type VARCHAR(100) NOT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_request ON audit_events(request_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_correlation ON audit_events(correlation_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_type ON audit_events(type);
CREATE INDEX IF NOT EXISTS idx_audit_events_timestamp ON audit_events(timestamp);

-- Idempotency Keys table
CREATE TABLE IF NOT EXISTS idempotency_keys (
    key VARCHAR(500) PRIMARY KEY,
    request_id UUID NOT NULL,
    result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expires_at);
`;

export async function migrate(): Promise<void> {
  const pool = getPool();
  await pool.query(SCHEMA_SQL);
  logger.info("PostgreSQL schema migration completed");
}

// ============================================================================
// Access Request Store (PostgreSQL)
// ============================================================================

export class PgAccessRequestStore {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
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
        metadata: row.metadata?.entitlementMetadata || {},
        governance: row.metadata?.governance,
      },
      reason: row.reason,
      // SAFETY: database schema enforces valid AccessRequestStatus enum values
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
      // Expiration retry fields
      expirationAttemptCount: row.expiration_attempt_count ?? 0,
      expirationNextAttemptAt: row.expiration_next_attempt_at?.toISOString(),
      expirationMaxRetries: row.expiration_max_retries ?? 3,
      expirationLastError: row.expiration_last_error,
      expirationLastAttemptAt: row.expiration_last_attempt_at?.toISOString(),
      // Lease fields for distributed workers
      leaseOwner: row.lease_owner,
      leaseUntil: row.lease_until?.toISOString(),
      leaseAcquiredAt: row.lease_acquired_at?.toISOString(),
      // Governance fields
      governanceExternalRequestId: row.governance_external_request_id,
      governanceAuthority: row.governance_authority,
      governanceAssignmentId: row.governance_assignment_id,
      governanceAssignmentExpiresAt:
        row.governance_assignment_expires_at?.toISOString(),
      // Reconciliation state fields
      governanceLastCheckedAt: row.governance_last_checked_at?.toISOString(),
      governanceNextCheckAt: row.governance_next_check_at?.toISOString(),
      governanceRetryCount: row.governance_retry_count ?? 0,
      governanceLastError: row.governance_last_error,
      governanceLastErrorCode: row.governance_last_error_code,
      // Governance lease fields
      governanceLeaseOwner: row.governance_lease_owner,
      governanceLeaseUntil: row.governance_lease_until?.toISOString(),
      governanceLeaseAcquiredAt:
        row.governance_lease_acquired_at?.toISOString(),
      governanceAttemptCount: row.governance_attempt_count ?? 0,
      governanceNextAttemptAt: row.governance_next_attempt_at?.toISOString(),
      governanceLastAttemptAt: row.governance_last_attempt_at?.toISOString(),
    };
  }

  async create(request: AccessRequest): Promise<void> {
    const sql = `
      INSERT INTO access_requests (
        id, correlation_id, requester_id, requester_email,
        entitlement_id, entitlement_name, entitlement_system,
        reason, status, version, idempotency_key, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `;
    await this.pool.query(sql, [
      request.id,
      request.correlationId,
      request.requesterId,
      request.requesterEmail,
      request.entitlement.id,
      request.entitlement.name,
      request.entitlement.system,
      request.reason,
      request.status,
      request.version,
      request.idempotencyKey,
      JSON.stringify(request.metadata),
    ]);
  }

  async getById(id: string): Promise<AccessRequest | undefined> {
    const result = await this.pool.query(
      "SELECT * FROM access_requests WHERE id = $1",
      [id],
    );
    if (result.rows.length === 0) return undefined;
    return this.mapRowToRequest(result.rows[0]);
  }

  async update(
    request: AccessRequest,
    expectedVersion?: number,
  ): Promise<void> {
    let sql: string;
    let params: any[];

    if (expectedVersion !== undefined) {
      sql = `
        UPDATE access_requests SET
          status = $2, version = $3, approved_at = $4, approved_by = $5,
          denied_at = $6, denied_by = $7, denied_reason = $8,
          fulfilled_at = $9, fulfillment_error = $10, access_expires_at = $11,
          external_id = $12, metadata = $13, updated_at = NOW(),
          expiration_attempt_count = $14, expiration_next_attempt_at = $15,
          expiration_max_retries = $16, expiration_last_error = $17,
          expiration_last_attempt_at = $18,
          lease_owner = $19, lease_until = $20, lease_acquired_at = $21,
          governance_external_request_id = $22, governance_authority = $23,
          governance_assignment_id = $24, governance_assignment_expires_at = $25,
          governance_last_checked_at = $26, governance_next_check_at = $27,
          governance_retry_count = $28, governance_last_error = $29,
          governance_last_error_code = $30
        WHERE id = $1 AND version = $31
      `;
      params = [
        request.id,
        request.status,
        request.version,
        request.approvedAt ? new Date(request.approvedAt) : null,
        request.approvedBy,
        request.deniedAt ? new Date(request.deniedAt) : null,
        request.deniedBy,
        request.deniedReason,
        request.fulfilledAt ? new Date(request.fulfilledAt) : null,
        request.fulfillmentError,
        request.accessExpiresAt ? new Date(request.accessExpiresAt) : null,
        request.externalId,
        JSON.stringify(request.metadata),
        request.expirationAttemptCount ?? 0,
        request.expirationNextAttemptAt
          ? new Date(request.expirationNextAttemptAt)
          : null,
        request.expirationMaxRetries ?? 3,
        request.expirationLastError,
        request.expirationLastAttemptAt
          ? new Date(request.expirationLastAttemptAt)
          : null,
        request.leaseOwner,
        request.leaseUntil ? new Date(request.leaseUntil) : null,
        request.leaseAcquiredAt ? new Date(request.leaseAcquiredAt) : null,
        request.governanceExternalRequestId,
        request.governanceAuthority,
        request.governanceAssignmentId,
        request.governanceAssignmentExpiresAt
          ? new Date(request.governanceAssignmentExpiresAt)
          : null,
        request.governanceLastCheckedAt
          ? new Date(request.governanceLastCheckedAt)
          : null,
        request.governanceNextCheckAt
          ? new Date(request.governanceNextCheckAt)
          : null,
        request.governanceRetryCount ?? 0,
        request.governanceLastError,
        request.governanceLastErrorCode,
        expectedVersion,
      ];
    } else {
      sql = `
        UPDATE access_requests SET
          status = $2, version = $3, approved_at = $4, approved_by = $5,
          denied_at = $6, denied_by = $7, denied_reason = $8,
          fulfilled_at = $9, fulfillment_error = $10, access_expires_at = $11,
          external_id = $12, metadata = $13, updated_at = NOW(),
          expiration_attempt_count = $14, expiration_next_attempt_at = $15,
          expiration_max_retries = $16, expiration_last_error = $17,
          expiration_last_attempt_at = $18,
          lease_owner = $19, lease_until = $20, lease_acquired_at = $21,
          governance_external_request_id = $22, governance_authority = $23,
          governance_assignment_id = $24, governance_assignment_expires_at = $25,
          governance_last_checked_at = $26, governance_next_check_at = $27,
          governance_retry_count = $28, governance_last_error = $29,
          governance_last_error_code = $30
        WHERE id = $1
      `;
      params = [
        request.id,
        request.status,
        request.version,
        request.approvedAt ? new Date(request.approvedAt) : null,
        request.approvedBy,
        request.deniedAt ? new Date(request.deniedAt) : null,
        request.deniedBy,
        request.deniedReason,
        request.fulfilledAt ? new Date(request.fulfilledAt) : null,
        request.fulfillmentError,
        request.accessExpiresAt ? new Date(request.accessExpiresAt) : null,
        request.externalId,
        JSON.stringify(request.metadata),
        request.expirationAttemptCount ?? 0,
        request.expirationNextAttemptAt
          ? new Date(request.expirationNextAttemptAt)
          : null,
        request.expirationMaxRetries ?? 3,
        request.expirationLastError,
        request.expirationLastAttemptAt
          ? new Date(request.expirationLastAttemptAt)
          : null,
        request.leaseOwner,
        request.leaseUntil ? new Date(request.leaseUntil) : null,
        request.leaseAcquiredAt ? new Date(request.leaseAcquiredAt) : null,
        request.governanceExternalRequestId,
        request.governanceAuthority,
        request.governanceAssignmentId,
        request.governanceAssignmentExpiresAt
          ? new Date(request.governanceAssignmentExpiresAt)
          : null,
        request.governanceLastCheckedAt
          ? new Date(request.governanceLastCheckedAt)
          : null,
        request.governanceNextCheckAt
          ? new Date(request.governanceNextCheckAt)
          : null,
        request.governanceRetryCount ?? 0,
        request.governanceLastError,
        request.governanceLastErrorCode,
      ];
    }

    const result = await this.pool.query(sql, params);
    if (expectedVersion !== undefined && result.rowCount === 0) {
      throw new Error(
        `Optimistic concurrency conflict: expected version ${expectedVersion}, found different`,
      );
    }
  }

  async getAll(): Promise<AccessRequest[]> {
    const result = await this.pool.query(
      "SELECT * FROM access_requests ORDER BY created_at DESC",
    );
    return result.rows.map((row) => this.mapRowToRequest(row));
  }

  async getByIdempotencyKey(key: string): Promise<AccessRequest | undefined> {
    const result = await this.pool.query(
      "SELECT * FROM access_requests WHERE idempotency_key = $1",
      [key],
    );
    if (result.rows.length === 0) return undefined;
    return this.mapRowToRequest(result.rows[0]);
  }
}

// ============================================================================
// Audit Event Store (PostgreSQL)
// ============================================================================

export class PgAuditEventStore implements AuditEventStore {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async append(event: AuditEvent): Promise<void> {
    const sql = `
      INSERT INTO audit_events (event_id, request_id, correlation_id, actor, timestamp, type, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;
    await this.pool.query(sql, [
      event.eventId,
      event.requestId,
      event.correlationId,
      event.actor,
      new Date(event.timestamp),
      event.type,
      JSON.stringify(event.metadata),
    ]);
  }

  async getByRequestId(requestId: string): Promise<AuditEvent[]> {
    const result = await this.pool.query(
      "SELECT * FROM audit_events WHERE request_id = $1 ORDER BY timestamp ASC",
      [requestId],
    );
    return result.rows.map((row) => ({
      eventId: row.event_id,
      requestId: row.request_id,
      correlationId: row.correlation_id,
      actor: row.actor,
      timestamp: row.timestamp.toISOString(),
      // SAFETY: database schema enforces valid AuditEventType enum values
      type: row.type as AuditEventType,
      metadata: row.metadata || {},
    }));
  }

  async getAll(): Promise<AuditEvent[]> {
    const result = await this.pool.query(
      "SELECT * FROM audit_events ORDER BY timestamp DESC LIMIT 1000",
    );
    return result.rows.map((row) => ({
      eventId: row.event_id,
      requestId: row.request_id,
      correlationId: row.correlation_id,
      actor: row.actor,
      timestamp: row.timestamp.toISOString(),
      // SAFETY: database schema enforces valid AuditEventType enum values
      type: row.type as AuditEventType,
      metadata: row.metadata || {},
    }));
  }
}

// ============================================================================
// Idempotency Store (PostgreSQL)
// ============================================================================

export class PgIdempotencyStore {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async checkAndSet(key: string, ttlSeconds: number = 86400): Promise<boolean> {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    try {
      const result = await this.pool.query(
        `INSERT INTO idempotency_keys (key, request_id, expires_at) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO NOTHING
         RETURNING key`,
        [key, "pending", expiresAt],
      );
      return result.rows.length > 0;
    } catch (err) {
      throw err;
    }
  }

  async setResult(key: string, result: ExecutionResult): Promise<void> {
    await this.pool.query(
      `UPDATE idempotency_keys SET result = $1 WHERE key = $2`,
      [JSON.stringify(result), key],
    );
  }

  async getResult(key: string): Promise<ExecutionResult | undefined> {
    const result = await this.pool.query(
      `SELECT result FROM idempotency_keys WHERE key = $1`,
      [key],
    );
    if (result.rows.length === 0) return undefined;
    return result.rows[0].result;
  }

  async cleanupExpired(): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM idempotency_keys WHERE expires_at < NOW()`,
    );
    return result.rowCount ?? 0;
  }
}

// ============================================================================
// Exports
// ============================================================================

export {
  ExpirationScheduler,
  createExpirationScheduler,
  DEFAULT_SCHEDULER_CONFIG,
} from "./expiration-scheduler.js";

export type {
  SchedulerConfig,
  SchedulerMetrics,
} from "./expiration-scheduler.js";

export { GovernanceReconciliationWorker } from "./governance-reconciliation-worker.js";

export type { ReconciliationWorkerConfig } from "./governance-reconciliation-worker.js";
