"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const pg_1 = require("pg");
const databaseUrl = process.env.DATABASE_URL || "postgresql://raelldottin@localhost:5432/opnory";
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
    external_id VARCHAR(255),
    idempotency_key VARCHAR(500) UNIQUE NOT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Lease columns for distributed expiration
    expiration_lease_owner VARCHAR(255),
    expiration_lease_until TIMESTAMPTZ,
    expiration_lease_acquired_at TIMESTAMPTZ,

    -- Retry columns for bounded exponential backoff
    expiration_attempt_count INTEGER NOT NULL DEFAULT 0,
    expiration_max_retries INTEGER NOT NULL DEFAULT 3,
    expiration_next_attempt_at TIMESTAMPTZ,
    expiration_last_error TEXT,
    expiration_last_error_code INTEGER,
    expiration_last_attempt_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_access_requests_requester ON access_requests(requester_id);
CREATE INDEX IF NOT EXISTS idx_access_requests_status ON access_requests(status);
CREATE INDEX IF NOT EXISTS idx_access_requests_correlation ON access_requests(correlation_id);
CREATE INDEX IF NOT EXISTS idx_access_requests_idempotency ON access_requests(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_access_requests_access_expires ON access_requests(access_expires_at);

-- Lease and retry indexes for distributed expiration
CREATE INDEX IF NOT EXISTS idx_access_requests_lease ON access_requests(expiration_lease_until) WHERE expiration_lease_owner IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_access_requests_retry ON access_requests(expiration_next_attempt_at) WHERE status = 'RETRY';

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
async function runMigration() {
    const pool = new pg_1.Pool({
        connectionString: databaseUrl,
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    });
    try {
        await pool.query(SCHEMA_SQL);
        console.log("Migration completed successfully");
        await pool.end();
        process.exit(0);
    }
    catch (err) {
        console.error("Migration failed:", err);
        await pool.end();
        process.exit(1);
    }
}
runMigration();
//# sourceMappingURL=run-migrate-simple.js.map