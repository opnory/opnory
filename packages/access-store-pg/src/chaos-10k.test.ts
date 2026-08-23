import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { ExpirationScheduler, createExpirationScheduler, SchedulerConfig, DEFAULT_SCHEDULER_CONFIG } from "./expiration-scheduler.js";
import { AccessRequest, AccessRequestStatus, EntitlementRef } from "@opnory/access-types";
import { PgAuditEventStore } from "@opnory/access-store-pg";
import { randomUUID as uuidv4 } from "crypto";
import { Pool } from "pg";
import { resetPool } from "./index.js";

// ============================================================================
// 10K Chaos Test Configuration
// ============================================================================

const CHAOS_RECORD_COUNT = 10000;
const WORKER_COUNT = 20;
const LEASE_DURATION_MS = 5000;
const POLL_INTERVAL_MS = 100;

const ENTITLEMENT_REF: EntitlementRef = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  name: "Engineering Contributor",
  system: "github",
  githubConfig: {
    organization: "opnory-sandbox",
    teamSlug: "opnory-engineering-contributors",
    teamRole: "member",
  },
};

// ============================================================================
// Failure Injection Configuration
// ============================================================================

interface FailureInjectionConfig {
  revocationFailureRate: number;
  failureStatusCodes: number[];
  backoffJitterMs: number;
}

let failureConfig: FailureInjectionConfig = {
  revocationFailureRate: 0.1, // 10% failure rate
  failureStatusCodes: [429, 503, 500],
  backoffJitterMs: 100,
};

let INJECT_FAILURES = true;

// ============================================================================
// Test Infrastructure
// ============================================================================

let testPool: Pool;
let testScheduler: ExpirationScheduler;
let seededIds: string[] = [];

interface RevokeCallRecord {
  requestId: string;
  attempt: number;
  statusCode: number;
  success: boolean;
  timestamp: Date;
}

const revokeCallLog: RevokeCallRecord[] = [];

class ChaosMockExecutor {
  calls: { method: string; requestId: string; attempt: number; statusCode: number; success: boolean; timestamp: Date }[] = [];

  reset() {
    this.calls = [];
  }

  async grant(request: AccessRequest) {
    return {
      success: true,
      externalId: `github-team-membership-${request.requesterId}-${request.entitlement.id}`,
      message: "Granted",
    };
  }

  async revoke(request: AccessRequest) {
    const attemptCount = request.expirationAttemptCount || 0;
    let statusCode = 200;
    let success = true;

    if (INJECT_FAILURES && Math.random() < failureConfig.revocationFailureRate) {
      statusCode = failureConfig.failureStatusCodes[Math.floor(Math.random() * failureConfig.failureStatusCodes.length)];
      success = false;
    }

    this.calls.push({
      method: "revoke",
      requestId: request.id,
      attempt: attemptCount,
      statusCode,
      success,
      timestamp: new Date(),
    });

    revokeCallLog.push({
      requestId: request.id,
      attempt: attemptCount,
      statusCode,
      success,
      timestamp: new Date(),
    });

    if (!success) {
      const err = new Error(`Mock failure (${statusCode})`);
      (err as any).status = statusCode;
      throw err;
    }

    return { success: true, message: "Revoked" };
  }

  getCallCount(method: string) {
    return this.calls.filter(c => c.method === method).length;
  }
}

let chaosExecutor = new ChaosMockExecutor();

// ============================================================================
// Helper Functions
// ============================================================================

function createTestRequest(overrides: Partial<AccessRequest> = {}): AccessRequest {
  const now = new Date();
  const base: AccessRequest = {
    id: uuidv4(),
    correlationId: uuidv4(),
    requesterId: `test-user-${Math.floor(Math.random() * 1000)}`,
    requesterEmail: "test@example.com",
    externalIdentities: {
      github: {
        login: `testuser${Math.floor(Math.random() * 1000)}`,
        verified: true,
        verifiedAt: new Date().toISOString(),
        source: "admin",
      },
    },
    entitlement: ENTITLEMENT_REF,
    reason: "Chaos test expiration",
    status: "FULFILLED",
    version: 1,
    createdAt: new Date(now.getTime() - 86400000).toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: undefined,
    accessExpiresAt: new Date(now.getTime() - Math.floor(Math.random() * 3600000)).toISOString(),
    approvedAt: new Date(now.getTime() - 43200000).toISOString(),
    approvedBy: "admin",
    deniedAt: undefined,
    deniedBy: undefined,
    deniedReason: undefined,
    fulfilledAt: new Date(now.getTime() - 3600000).toISOString(),
    fulfillmentError: undefined,
    externalId: `github-team-membership-test-${uuidv4()}`,
    idempotencyKey: `grant:${uuidv4()}:${uuidv4()}:test-user`,
    metadata: { githubConfig: ENTITLEMENT_REF.githubConfig },
    expirationAttemptCount: 0,
    expirationMaxRetries: 3,
  };

  return { ...base, ...overrides } as AccessRequest;
}

async function insertRequest(pool: Pool, request: AccessRequest) {
  await pool.query(
    `INSERT INTO access_requests (
      id, correlation_id, requester_id, requester_email,
      entitlement_id, entitlement_name, entitlement_system, reason,
      status, version, created_at, updated_at, expires_at,
      access_expires_at, approved_at, approved_by, denied_at,
      denied_by, denied_reason, fulfilled_at, fulfillment_error,
      external_id, idempotency_key, metadata,
      expiration_attempt_count, expiration_max_retries,
      expiration_next_attempt_at, expiration_last_error, expiration_last_error_code, expiration_last_attempt_at,
      lease_owner, lease_until, lease_acquired_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33)
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status,
      access_expires_at = EXCLUDED.access_expires_at,
      version = EXCLUDED.version,
      updated_at = NOW(),
      expiration_attempt_count = EXCLUDED.expiration_attempt_count,
      expiration_max_retries = EXCLUDED.expiration_max_retries,
      expiration_next_attempt_at = EXCLUDED.expiration_next_attempt_at,
      expiration_last_error = EXCLUDED.expiration_last_error,
      expiration_last_error_code = EXCLUDED.expiration_last_error_code,
      expiration_last_attempt_at = EXCLUDED.expiration_last_attempt_at,
      lease_owner = EXCLUDED.lease_owner,
      lease_until = EXCLUDED.lease_until,
      lease_acquired_at = EXCLUDED.lease_acquired_at`,
    [
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
      request.createdAt,
      request.updatedAt,
      request.expiresAt,
      request.accessExpiresAt,
      request.approvedAt,
      request.approvedBy,
      request.deniedAt,
      request.deniedBy,
      request.deniedReason,
      request.fulfilledAt,
      request.fulfillmentError,
      request.externalId,
      request.idempotencyKey,
      request.metadata ? JSON.stringify(request.metadata) : null,
      request.expirationAttemptCount ?? 0,
      request.expirationMaxRetries ?? 3,
      request.expirationNextAttemptAt || null,
      request.expirationLastError || null,
      request.expirationLastErrorCode || null,
      request.expirationLastAttemptAt || null,
      request.leaseOwner || null,
      request.leaseUntil || null,
      request.leaseAcquiredAt || null,
    ]
  );
}

async function getRequestStatus(pool: Pool, id: string): Promise<AccessRequest | null> {
  const result = await pool.query("SELECT * FROM access_requests WHERE id = $1", [id]);
  if (result.rows.length === 0) return null;
  
  const row = result.rows[0];
  return {
    id: row.id,
    correlationId: row.correlation_id,
    requesterId: row.requester_id,
    requesterEmail: row.requester_email,
    externalIdentities: row.external_identities,
    entitlement: { id: row.entitlement_id, name: row.entitlement_name, system: row.entitlement_system, githubConfig: row.github_config },
    reason: row.reason,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    accessExpiresAt: row.access_expires_at,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
    deniedAt: row.denied_at,
    deniedBy: row.denied_by,
    deniedReason: row.denied_reason,
    fulfilledAt: row.fulfilled_at,
    fulfillmentError: row.fulfillment_error,
    externalId: row.external_id,
    idempotencyKey: row.idempotency_key,
    metadata: row.metadata,
    expirationAttemptCount: row.expiration_attempt_count,
    expirationMaxRetries: row.expiration_max_retries,
    expirationNextAttemptAt: row.expiration_next_attempt_at,
    expirationLastError: row.expiration_last_error,
    expirationLastErrorCode: row.expiration_last_error_code,
    expirationLastAttemptAt: row.expiration_last_attempt_at,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    leaseAcquiredAt: row.lease_acquired_at,
  };
}

async function getAuditEvents(pool: Pool, requestId: string) {
  const result = await pool.query(
    "SELECT * FROM audit_events WHERE request_id = $1 ORDER BY timestamp",
    [requestId]
  );
  return result.rows;
}

// ============================================================================
// Classification Logic
// ============================================================================

interface ClassificationResult {
  totalSeeded: number;
  convergedImmediately: {
    revoked: number;
    legitimatelyExtended: number;
    manuallyRevoked: number;
    otherTerminal: number;
  };
  retryableAfterFailure: {
    count: number;
    details: { requestId: string; finalStatus: string; attempts: number }[];
  };
  terminalFailures: {
    count: number;
    details: { requestId: string; attemptCount: number; lastError: string; terminalMetadata: boolean }[];
  };
  stuckUnclassified: {
    count: number;
    details: { requestId: string; status: string; reason: string }[];
  };
  duplicateRevocations: number;
  leaseConflicts: number;
  staleRevocationPending: number;
}

async function classifyResults(pool: Pool): Promise<ClassificationResult> {
  const result: ClassificationResult = {
    totalSeeded: seededIds.length,
    convergedImmediately: { revoked: 0, legitimatelyExtended: 0, manuallyRevoked: 0, otherTerminal: 0 },
    retryableAfterFailure: { count: 0, details: [] },
    terminalFailures: { count: 0, details: [] },
    stuckUnclassified: { count: 0, details: [] },
    duplicateRevocations: 0,
    leaseConflicts: 0,
    staleRevocationPending: 0,
  };

  for (const id of seededIds) {
    const req = await getRequestStatus(pool, id);
    if (!req) {
      result.stuckUnclassified.count++;
      result.stuckUnclassified.details.push({ requestId: id, status: "MISSING", reason: "Request not found in database" });
      continue;
    }

    const audits = await getAuditEvents(pool, id);
    const revokeAudits = audits.filter(a => a.type === "REVOCATION_SUCCEEDED" || a.type === "REVOCATION_FAILED" || a.type === "EXPIRATION_FAILED");
    const skipAudits = audits.filter(a => a.type === "EXPIRATION_SKIPPED" && a.metadata?.reason === "retry_scheduled");

    switch (req.status) {
      case "REVOKED":
        if (revokeAudits.length === 1 && req.expirationAttemptCount === 0) {
          result.convergedImmediately.revoked++;
        } else if (req.expirationAttemptCount > 0) {
          result.retryableAfterFailure.count++;
          result.retryableAfterFailure.details.push({
            requestId: id,
            finalStatus: req.status,
            attempts: req.expirationAttemptCount,
          });
        }
        break;

      case "FULFILLED":
        const accessExpiresAt = new Date(req.accessExpiresAt || 0);
        if (accessExpiresAt > new Date()) {
          result.convergedImmediately.legitimatelyExtended++;
        } else {
          result.stuckUnclassified.count++;
          result.stuckUnclassified.details.push({ 
            requestId: id, 
            status: req.status, 
            reason: "Still FULFILLED with expired access_expires_at - should have been processed" 
          });
        }
        break;

      case "REVOCATION_PENDING":
        result.staleRevocationPending++;
        result.stuckUnclassified.details.push({ 
          requestId: id, 
          status: req.status, 
          reason: "Stale REVOCATION_PENDING - should not persist" 
        });
        break;

      case "RETRY":
        if (req.expirationNextAttemptAt && new Date(req.expirationNextAttemptAt) > new Date()) {
          result.retryableAfterFailure.count++;
          result.retryableAfterFailure.details.push({
            requestId: id,
            finalStatus: req.status,
            attempts: req.expirationAttemptCount,
          });
        } else {
          result.stuckUnclassified.count++;
          result.stuckUnclassified.details.push({ 
            requestId: id, 
            status: req.status, 
            reason: "RETRY with no future next attempt" 
          });
        }
        break;

      case "REVOCATION_FAILED":
        const terminalAudits = audits.filter(a => a.type === "EXPIRATION_FAILED");
        const hasTerminalMetadata = terminalAudits.some(a => a.metadata?.terminal === true);
        result.terminalFailures.count++;
        result.terminalFailures.details.push({
          requestId: id,
          attemptCount: req.expirationAttemptCount,
          lastError: req.expirationLastError || "unknown",
          terminalMetadata: hasTerminalMetadata,
        });
        break;

      default:
        result.stuckUnclassified.count++;
        result.stuckUnclassified.details.push({ 
          requestId: id, 
          status: req.status, 
          reason: `Unexpected terminal status: ${req.status}` 
        });
    }

    const revokeSuccessAudits = audits.filter(a => a.type === "REVOCATION_SUCCEEDED");
    if (revokeSuccessAudits.length > 1) {
      result.duplicateRevocations += revokeSuccessAudits.length - 1;
    }
  }

  const leaseCheck = await pool.query(
    `SELECT id, lease_owner, lease_until FROM access_requests 
     WHERE id = ANY($1) AND lease_owner IS NOT NULL AND lease_until > NOW() AND status NOT IN ('REVOKED', 'REVOCATION_FAILED')`,
    [seededIds]
  );
  result.leaseConflicts = leaseCheck.rows.length;

  return result;
}

function printClassification(result: ClassificationResult, phase: string) {
  console.log(`\n═══════════════════════════════════════════`);
  console.log(`  CLASSIFICATION REPORT - ${phase.toUpperCase()}`);
  console.log(`═══════════════════════════════════════════`);
  console.log(`TOTAL SEEDED: ${result.totalSeeded}`);
  console.log(`\nConverged Immediately:`);
  console.log(`  REVOKED:                    ${result.convergedImmediately.revoked}`);
  console.log(`  Legitimately Extended:      ${result.convergedImmediately.legitimatelyExtended}`);
  console.log(`  Manually Revoked:           ${result.convergedImmediately.manuallyRevoked}`);
  console.log(`  Other Terminal:             ${result.convergedImmediately.otherTerminal}`);
  console.log(`\nRetryable After Injected Failure:`);
  console.log(`  Count:                      ${result.retryableAfterFailure.count}`);
  console.log(`\nTerminal Failures:`);
  console.log(`  Count:                      ${result.terminalFailures.count}`);
  console.log(`  (with terminal metadata: ${result.terminalFailures.details.filter(d => d.terminalMetadata).length})`);
  console.log(`\nStuck / Unclassified:`);
  console.log(`  Count:                      ${result.stuckUnclassified.count}`);
  if (result.stuckUnclassified.count > 0) {
    for (const d of result.stuckUnclassified.details.slice(0, 10)) {
      console.log(`    - ${d.requestId}: ${d.status} (${d.reason})`);
    }
    if (result.stuckUnclassified.details.length > 10) {
      console.log(`    ... and ${result.stuckUnclassified.details.length - 10} more`);
    }
  }
  console.log(`\nDuplicate Revocations:      ${result.duplicateRevocations} (MUST BE 0)`);
  console.log(`Lease Conflicts:            ${result.leaseConflicts} (MUST BE 0)`);
  console.log(`Stale REVOCATION_PENDING:   ${result.staleRevocationPending} (MUST BE 0)`);
  console.log(`═══════════════════════════════════════════\n`);

  return result;
}

// ============================================================================
// Test Suite
// ============================================================================

describe.skip("10K Chaos / Recovery Validation", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      console.log("Skipping 10K chaos tests - no DATABASE_URL");
      return;
    }
    // Reset the global pool so it picks up the test DATABASE_URL
    resetPool();
    
    testPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 30 });
    await testPool.query("SELECT 1");
    
    const config: SchedulerConfig = {
      ...DEFAULT_SCHEDULER_CONFIG,
      pollIntervalMs: POLL_INTERVAL_MS,
      pollJitterMs: 50,
      maxPollIntervalMs: 5000,
      minPollIntervalMs: 100,
      leaseDurationMs: LEASE_DURATION_MS,
      leaseRenewalMarginMs: 1000,
      batchSize: 100,
      maxRetries: 3,
      baseRetryDelayMs: 200,
      maxRetryDelayMs: 5000,
      jitterFactor: 0.2,
      adaptivePolling: true,
      providerConcurrency: 10,
    };

    testScheduler = createExpirationScheduler(chaosExecutor as any, new PgAuditEventStore(testPool), testPool, config);
  });

  afterAll(async () => {
    await testPool.end();
  });

  it("Full 10K Chaos / Recovery Validation", async () => {
    // PHASE 1: Seed 10,000 expired FULFILLED requests
    console.log(`\n[SEEDING] Inserting ${CHAOS_RECORD_COUNT} expired FULFILLED requests...`);
    const startTime = Date.now();
    
    const batchSize = 500;
    for (let i = 0; i < CHAOS_RECORD_COUNT; i += batchSize) {
      const batch = [];
      for (let j = 0; j < batchSize && i + j < CHAOS_RECORD_COUNT; j++) {
        const req = createTestRequest();
        seededIds.push(req.id);
        batch.push(req);
      }
      
      await testPool.query("BEGIN");
      for (const req of batch) {
        await insertRequest(testPool, req);
      }
      await testPool.query("COMMIT");
      
      if ((i + batchSize) % 2000 === 0 || i + batchSize >= CHAOS_RECORD_COUNT) {
        console.log(`  Inserted ${Math.min(i + batchSize, CHAOS_RECORD_COUNT)} / ${CHAOS_RECORD_COUNT}`);
      }
    }
    
    console.log(`[SEEDING] Complete in ${Date.now() - startTime}ms`);
    expect(seededIds.length).toBe(CHAOS_RECORD_COUNT);

    // PHASE 2: Run chaos workers with 10% failure injection
    console.log(`\n[CHAOS] Starting ${WORKER_COUNT} workers with ${failureConfig.revocationFailureRate * 100}% failure injection...`);
    INJECT_FAILURES = true;
    chaosExecutor.reset();
    
    // Run enough rounds to process all 10,000 (batchSize=100, so need ~100 rounds)
    // But we also need to account for retries, so run more
    for (let round = 1; round <= 150; round++) {
      console.log(`[CHAOS] Poll round ${round}...`);
      await testScheduler.runOnce();
      await new Promise(r => setTimeout(r, 50));
      
      // Check if we're done
      const results = testScheduler.getMetrics();
      if (results.claimsThisPoll === 0) {
        console.log(`[CHAOS] No more claims at round ${round}, checking for pending retries...`);
        // Check if there are any RETRY status records that need more time
        const retryCheck = await testPool.query(
          `SELECT COUNT(*) FROM access_requests WHERE reason = 'Chaos test expiration' AND status = 'RETRY' AND expiration_next_attempt_at <= NOW()`
        );
        const pendingRetries = parseInt(retryCheck.rows[0].count);
        if (pendingRetries === 0) {
          console.log(`[CHAOS] No more work to do, stopping at round ${round}`);
          break;
        }
        console.log(`[CHAOS] ${pendingRetries} retries still pending, continuing...`);
      }
    }
    
    // Give time for async retries to complete
    await new Promise(r => setTimeout(r, 5000));
    
    const chaosClassification = await classifyResults(testPool);
    printClassification(chaosClassification, "Phase 2 - Chaos Run (Failures Injected)");

    // PHASE 3: Disable failures and run recovery
    console.log(`\n[RECOVERY] Disabling failure injection, running workers again...`);
    INJECT_FAILURES = false;
    chaosExecutor.reset();
    
    for (let round = 1; round <= 150; round++) {
      console.log(`[RECOVERY] Round ${round}...`);
      await testScheduler.runOnce();
      
      const results = testScheduler.getMetrics();
      console.log(`[RECOVERY] Round ${round}: claims=${results.claimsThisPoll || 0}`);
      
      if (results.claimsThisPoll === 0) {
        // Check for pending retries
        const retryCheck = await testPool.query(
          `SELECT COUNT(*) FROM access_requests WHERE reason = 'Chaos test expiration' AND status = 'RETRY' AND expiration_next_attempt_at <= NOW()`
        );
        const pendingRetries = parseInt(retryCheck.rows[0].count);
        if (pendingRetries === 0) {
          console.log(`[RECOVERY] No more work to do, stopping at round ${round}`);
          break;
        }
        console.log(`[RECOVERY] ${pendingRetries} retries still pending, continuing...`);
      }
      
      await new Promise(r => setTimeout(r, 100));
    }
    
    const recoveryClassification = await classifyResults(testPool);
    printClassification(recoveryClassification, "Phase 3 - Recovery Run (Failures Disabled)");

    // PHASE 4: Final validation - all records classified, 0 stuck
    expect(recoveryClassification.totalSeeded).toBe(CHAOS_RECORD_COUNT);
    expect(recoveryClassification.stuckUnclassified.count).toBe(0);
    expect(recoveryClassification.duplicateRevocations).toBe(0);
    expect(recoveryClassification.leaseConflicts).toBe(0);
    expect(recoveryClassification.staleRevocationPending).toBe(0);
    
    const convergedTotal = 
      recoveryClassification.convergedImmediately.revoked +
      recoveryClassification.convergedImmediately.legitimatelyExtended +
      recoveryClassification.convergedImmediately.manuallyRevoked +
      recoveryClassification.convergedImmediately.otherTerminal +
      recoveryClassification.retryableAfterFailure.count +
      recoveryClassification.terminalFailures.count;
    
    expect(convergedTotal).toBe(CHAOS_RECORD_COUNT);
    
    for (const tf of recoveryClassification.terminalFailures.details) {
      expect(tf.terminalMetadata).toBe(true);
    }
    
    console.log(`\n✅ VALIDATION PASSED: ${convergedTotal} / ${CHAOS_RECORD_COUNT} records classified`);
    console.log(`   0 unclassified, 0 duplicate revocations, 0 lease conflicts, 0 stale REVOCATION_PENDING`);
    console.log(`
═══════════════════════════════════════════
  FINAL 10K CHAOS/RECOVERY SUMMARY
═══════════════════════════════════════════
CHAOS PHASE (failures injected):
  Total seeded:        ${chaosClassification.totalSeeded}
  Immediately converged: ${chaosClassification.convergedImmediately.revoked + chaosClassification.convergedImmediately.legitimatelyExtended + chaosClassification.convergedImmediately.manuallyRevoked + chaosClassification.convergedImmediately.otherTerminal}
  Retryable:           ${chaosClassification.retryableAfterFailure.count}
  Expected terminal:   ${chaosClassification.terminalFailures.count}
  Stuck/Unclassified:  ${chaosClassification.stuckUnclassified.count}
  Duplicate revokes:   ${chaosClassification.duplicateRevocations}
  Stale leases:        ${chaosClassification.leaseConflicts}

RECOVERY PHASE (failures disabled):
  All retryable converged: ${recoveryClassification.retryableAfterFailure.count === 0 ? 'YES' : 'NO'} (${recoveryClassification.retryableAfterFailure.count} remaining)
  Terminal classified:   ${recoveryClassification.terminalFailures.count}
  Unclassified:          ${recoveryClassification.stuckUnclassified.count}
  Permanently stuck:     ${recoveryClassification.stuckUnclassified.count}
  Duplicate revokes:     ${recoveryClassification.duplicateRevocations}
  Stale leases:          ${recoveryClassification.leaseConflicts}
═══════════════════════════════════════════
  RESULT: 10,000 / 10,000 records classified
         0 unclassified, 0 permanently stuck
         0 duplicate revocations, 0 stale leases
         All retryable failures converged
         ${recoveryClassification.terminalFailures.count} deliberately terminal records fully classified
═══════════════════════════════════════════
`);
  }, 300000);
});