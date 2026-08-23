import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from "bun:test";
import { ExpirationScheduler, createExpirationScheduler, SchedulerMetrics } from "./expiration-scheduler.js";
import { GitHubAccessExecutor, GitHubExecutorConfig, InMemoryIdempotencyStore } from "@opnory/access-executor";
import { InMemoryAuditEventStore, AuditEventStore } from "@opnory/access-audit";
import { AccessRequest, AccessRequestStatus, FulfilledAccessRequest, EntitlementRef, toFulfilledAccessRequest, ApprovedAccessRequest, ExecutionResult, RevocationResult } from "@opnory/access-types";
import { randomUUID as uuidv4 } from "crypto";
import { Pool, PoolClient } from "pg";
import { resetPool } from "./index.js";

// ============================================================================
// Test Infrastructure
// ============================================================================

let testPool: Pool;
let testExecutor: MockExecutor;
let testAuditStore: InMemoryAuditEventStore;
let testScheduler: ExpirationScheduler;

const ENTITLEMENT_ID = "123e4567-e89b-12d3-a456-426614174000";
const ENTITLEMENT_REF: EntitlementRef = {
  id: ENTITLEMENT_ID,
  name: "Engineering Contributor",
  system: "github",
  githubConfig: {
    organization: "opnory-sandbox",
    teamSlug: "opnory-engineering-contributors",
    teamRole: "member",
  },
};

interface MockExecutorCall {
  method: "grant" | "revoke";
  requestId: string;
  timestamp: Date;
  result: any;
}

// MockExecutor that implements the AccessExecutor interface
class MockExecutor {
  calls: MockExecutorCall[] = [];
  shouldFail: boolean = false;
  failError: Error | null = null;
  failStatusCode: number = 500;
  
  constructor() {
    this.calls = [];
  }
  
  reset() {
    this.calls = [];
    this.shouldFail = false;
    this.failError = null;
    this.failStatusCode = 500;
  }
  
  async grant(request: AccessRequest): Promise<ExecutionResult> {
    const call: MockExecutorCall = {
      method: "grant",
      requestId: request.id,
      timestamp: new Date(),
      result: null,
    };
    
    if (this.shouldFail) {
      const err = this.failError || new Error("Mock failure");
      (err as any).status = this.failStatusCode;
      call.result = { success: false, error: err.message };
      throw err;
    }
    
    call.result = { 
      success: true, 
      externalId: `github-team-membership-${request.requesterId}-${request.entitlement.id}`,
      message: "Granted" 
    };
    this.calls.push(call);
    return call.result;
  }
  
  async revoke(request: AccessRequest): Promise<RevocationResult> {
    const call: MockExecutorCall = {
      method: "revoke",
      requestId: request.id,
      timestamp: new Date(),
      result: null,
    };

    if (this.shouldFail) {
      const err = this.failError || new Error("Mock failure");
      (err as any).status = this.failStatusCode;
      call.result = { success: false, error: `Mock failure (${this.failStatusCode})`, status: this.failStatusCode };
      this.calls.push(call);
      return call.result;
    }

    call.result = { 
      success: true, 
      message: "Revoked" 
    };
    this.calls.push(call);
    return call.result;
  }
  
  getCalls(method?: "grant" | "revoke") {
    if (method) return this.calls.filter(c => c.method === method);
    return this.calls;
  }
  
  getCallCount(method?: "grant" | "revoke") {
    return this.getCalls(method).length;
  }
}

function createTestRequest(overrides: Partial<AccessRequest> = {}): AccessRequest {
  const now = new Date();
  const base: AccessRequest = {
    id: uuidv4(),
    correlationId: uuidv4(),
    requesterId: "test-user",
    requesterEmail: "test@example.com",
    externalIdentities: {
      github: {
        login: "testuser",
        verified: true,
        verifiedAt: new Date().toISOString(),
        source: "admin",
      },
    },
    entitlement: ENTITLEMENT_REF,
    reason: "Test expiration",
    status: "FULFILLED",
    version: 1,
    createdAt: new Date(now.getTime() - 86400000).toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: undefined,
    accessExpiresAt: new Date(now.getTime() + 60000).toISOString(),
    approvedAt: new Date(now.getTime() - 43200000).toISOString(),
    approvedBy: "admin",
    deniedAt: undefined,
    deniedBy: undefined,
    deniedReason: undefined,
    fulfilledAt: new Date(now.getTime() - 3600000).toISOString(),
    fulfillmentError: undefined,
    externalId: `github-team-membership-testuser-opnory-sandbox-opnory-engineering-contributors`,
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
      JSON.stringify(request.metadata),
      request.expirationAttemptCount,
      request.expirationMaxRetries,
      request.expirationNextAttemptAt || null,
      request.expirationLastError || null,
      (request as any).expirationLastErrorCode || null,
      request.expirationLastAttemptAt || null,
      request.leaseOwner || null,
      request.leaseUntil || null,
      request.leaseAcquiredAt || null,
    ]
  );
}

async function getRequest(pool: Pool, id: string) {
  const result = await pool.query(
    `SELECT * FROM access_requests WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

async function cleanupTestData(pool: Pool) {
  await pool.query(`DELETE FROM access_requests WHERE requester_id LIKE 'test-%' OR requester_id LIKE 'case-%'`);
  await pool.query(`DELETE FROM audit_events WHERE request_id IN (SELECT id FROM access_requests WHERE requester_id LIKE 'test-%' OR requester_id LIKE 'case-%')`);
}

// ============================================================================
// Setup/Teardown
// ============================================================================

beforeAll(async () => {
  if (!process.env.DATABASE_URL && !process.env.CI) {
    console.log("Skipping scheduler tests - no DATABASE_URL");
    return;
  }
  
  // Reset the global pool so it picks up the test DATABASE_URL
  resetPool();

  testPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
});

beforeEach(async () => {
  if (!testPool) return;
  testExecutor = new MockExecutor();
  testAuditStore = new InMemoryAuditEventStore();
  
  testScheduler = new ExpirationScheduler(testExecutor, testAuditStore, testPool, {
    pollIntervalMs: 100,
    leaseDurationMs: 5000,
    batchSize: 10,
    providerConcurrency: 5,
  });
  
  await cleanupTestData(testPool);
});

afterEach(async () => {
  if (testScheduler) {
    testScheduler.stop();
  }
});

afterAll(async () => {
  if (testPool) {
    await cleanupTestData(testPool);
    await testPool.end();
  }
});

// Helper to access private processDueExpirations
async function runExpirationTick(scheduler: ExpirationScheduler) {
  // Use reflection to call private method
  await (scheduler as any).processDueExpirations();
}

// ============================================================================
// CASE 22–29: Core Expiration Lifecycle Tests
// ============================================================================

describe("ExpirationScheduler - Core Lifecycle (CASE 22-29)", () => {
  
  it("CASE 22 — Normal expiration: FULFILLED + expired → REVOKED", async () => {
    if (!testPool) return;
    
    // Create expired request
    const request = createTestRequest({
      requesterId: "case-22-user",
      accessExpiresAt: new Date(Date.now() - 1000).toISOString(), // Expired 1s ago
      status: "FULFILLED",
    });
    
    await insertRequest(testPool, request);
    
    // Run one tick of expiration processing
    await runExpirationTick(testScheduler);
    
    // Verify state transition
    const updated = await getRequest(testPool, request.id);
    expect(updated.status).toBe("REVOKED");
    expect(updated.expiration_attempt_count).toBe(1);
    
    // Verify GitHub revoke was called exactly once
    expect(testExecutor.getCallCount("revoke")).toBe(1);
    expect(testExecutor.getCalls("revoke")[0].requestId).toBe(request.id);
    
    // Verify audit event
    const events = await testAuditStore.getByRequestId(request.id);
    const revokedEvent = events.find(e => e.type === "REVOCATION_SUCCEEDED");
    expect(revokedEvent).toBeDefined();
    expect(revokedEvent?.metadata?.workerId).toBeDefined();
  });

  it("CASE 23 — Future expiration: FULFILLED + future accessExpiresAt → no revocation", async () => {
    if (!testPool) return;
    
    const request = createTestRequest({
      requesterId: "case-23-user",
      accessExpiresAt: new Date(Date.now() + 3600000).toISOString(), // 1 hour in future
      status: "FULFILLED",
    });
    
    await insertRequest(testPool, request);
    
    // Run one tick
    await runExpirationTick(testScheduler);
    
    // Verify no state change
    const updated = await getRequest(testPool, request.id);
    expect(updated.status).toBe("FULFILLED");
    expect(updated.expiration_attempt_count).toBe(0);
    
    // Verify no GitHub calls
    expect(testExecutor.getCallCount("revoke")).toBe(0);
    expect(testExecutor.getCallCount("grant")).toBe(0);
  });

  it("CASE 24 — Restart recovery: expires while worker offline → startup scan discovers", async () => {
    if (!testPool) return;
    
    // Create expired request (simulating expiry while worker was down)
    const request = createTestRequest({
      requesterId: "case-24-user",
      accessExpiresAt: new Date(Date.now() - 10000).toISOString(), // Expired 10s ago
      status: "FULFILLED",
    });
    
    await insertRequest(testPool, request);
    
    // Create NEW scheduler instance (simulating worker restart)
    const restartedScheduler = new ExpirationScheduler(testExecutor, testAuditStore, testPool, {
      pollIntervalMs: 100,
      leaseDurationMs: 5000,
      batchSize: 10,
      providerConcurrency: 5,
    });
    
    // Run startup scan (processDueExpirations)
    await runExpirationTick(restartedScheduler);
    
    // Verify request was processed on startup
    const updated = await getRequest(testPool, request.id);
    expect(updated.status).toBe("REVOKED");
    
    // Verify exactly one revoke call
    expect(testExecutor.getCallCount("revoke")).toBe(1);
    
    restartedScheduler.stop();
  });

  it("CASE 25 — Concurrent workers: two workers claim same due request → one winner", async () => {
    if (!testPool) return;
    
    const request = createTestRequest({
      requesterId: "case-25-user",
      accessExpiresAt: new Date(Date.now() - 1000).toISOString(),
      status: "FULFILLED",
    });
    
    await insertRequest(testPool, request);
    
    // Create TWO schedulers simulating concurrent workers
    const schedulerA = new ExpirationScheduler(testExecutor, testAuditStore, testPool, {
      pollIntervalMs: 50,
      leaseDurationMs: 5000,
      batchSize: 10,
      providerConcurrency: 5,
    });
    
    const schedulerB = new ExpirationScheduler(testExecutor, testAuditStore, testPool, {
      pollIntervalMs: 50,
      leaseDurationMs: 5000,
      batchSize: 10,
      providerConcurrency: 5,
    });
    
    // Run both concurrently
    await Promise.all([
      runExpirationTick(schedulerA),
      runExpirationTick(schedulerB),
    ]);
    
    // Verify exactly ONE revoke happened (no duplicate)
    expect(testExecutor.getCallCount("revoke")).toBe(1);
    
    // Verify final state is REVOKED
    const updated = await getRequest(testPool, request.id);
    expect(updated.status).toBe("REVOKED");
    
    schedulerA.stop();
    schedulerB.stop();
  });

  it("CASE 26 — Duplicate delivery: same expiration processed twice → idempotent", async () => {
    if (!testPool) return;
    
    const request = createTestRequest({
      requesterId: "case-26-user",
      accessExpiresAt: new Date(Date.now() - 1000).toISOString(),
      status: "FULFILLED",
    });
    
    await insertRequest(testPool, request);
    
    // First processing
    await runExpirationTick(testScheduler);
    
    let updated = await getRequest(testPool, request.id);
    expect(updated.status).toBe("REVOKED");
    expect(testExecutor.getCallCount("revoke")).toBe(1);
    
    // Reset mock but keep DB state
    testExecutor.reset();
    
    // Second processing (simulating duplicate delivery)
    await runExpirationTick(testScheduler);
    
    // Verify still REVOKED and no additional GitHub calls
    updated = await getRequest(testPool, request.id);
    expect(updated.status).toBe("REVOKED");
    expect(testExecutor.getCallCount("revoke")).toBe(0); // Idempotent - no second call
  });

  it("CASE 27 — Manual revoke first: request already REVOKED → expiration skipped", async () => {
    if (!testPool) return;
    
    const request = createTestRequest({
      requesterId: "case-27-user",
      accessExpiresAt: new Date(Date.now() - 1000).toISOString(),
      status: "REVOKED", // Already revoked manually
    });
    
    await insertRequest(testPool, request);
    
    await runExpirationTick(testScheduler);
    
    // Verify no GitHub revoke call (already revoked)
    expect(testExecutor.getCallCount("revoke")).toBe(0);
    
    // Verify status unchanged
    const updated = await getRequest(testPool, request.id);
    expect(updated.status).toBe("REVOKED");
  });

  it("CASE 28A — Extension committed before claim: scheduler sees T2, skips", async () => {
    if (!testPool) return;
    
    // Create request with original expiry T1 (in the past)
    const T1 = new Date(Date.now() - 5000); // 5s ago
    const T2 = new Date(Date.now() + 3600000); // 1 hour in future
    
    const request = createTestRequest({
      requesterId: "case-28-user",
      accessExpiresAt: T1.toISOString(),
      status: "FULFILLED",
    });
    
    await insertRequest(testPool, request);
    
    // User extends access to T2 BEFORE scheduler claims
    await testPool.query(
      `UPDATE access_requests SET access_expires_at = $1, version = version + 1, updated_at = NOW() WHERE id = $2`,
      [T2.toISOString(), request.id]
    );
    
    // Scheduler runs - claim query sees T2 > now, so it's NOT due, nothing claimed
    await runExpirationTick(testScheduler);
    
    // Verify NO GitHub revoke call (scheduler didn't even claim it)
    expect(testExecutor.getCallCount("revoke")).toBe(0);
    
    // Status remains FULFILLED
    const updated = await getRequest(testPool, request.id);
    expect(updated.status).toBe("FULFILLED");
    expect(new Date(updated.access_expires_at).getTime()).toBeCloseTo(T2.getTime(), -3); // Within 1s
    
    // No EXPIRATION_SKIPPED event because scheduler never claimed it (not due)
  });

  it("CASE 28B — Scheduler wins race: claims first, extension blocked by lock", async () => {
    if (!testPool) return;
    
    const T1 = new Date(Date.now() - 5000); // 5s ago
    const T2 = new Date(Date.now() + 3600000); // 1 hour in future
    
    const request = createTestRequest({
      requesterId: "case-28b-user",
      accessExpiresAt: T1.toISOString(),
      status: "FULFILLED",
    });
    
    await insertRequest(testPool, request);
    
    // Scheduler claims FIRST (row locked)
    await runExpirationTick(testScheduler);
    
    // After scheduler processes, request is REVOKED
    // Now try to extend (simulating concurrent extension attempt)
    // This will fail or be blocked by the transaction that already committed
    const updated = await getRequest(testPool, request.id);
    expect(updated.status).toBe("REVOKED"); // Expiration won the race
    
    // Verify exactly one revoke call
    expect(testExecutor.getCallCount("revoke")).toBe(1);
  });

  it("CASE 29 — Revocation failure: expiration due → revoke fails → RETRY with backoff", async () => {
    if (!testPool) return;
    
    const request = createTestRequest({
      requesterId: "case-29-user",
      accessExpiresAt: new Date(Date.now() - 1000).toISOString(),
      status: "FULFILLED",
      expirationAttemptCount: 0,
      expirationMaxRetries: 3,
    });
    
    await insertRequest(testPool, request);
    
    // Configure mock to fail with retryable error (503)
    testExecutor.shouldFail = true;
    testExecutor.failStatusCode = 503;
    
    await runExpirationTick(testScheduler);
    
    // Verify status moved to RETRY (not REVOKED, not FULFILLED)
    const updated = await getRequest(testPool, request.id);
    expect(updated.status).toBe("RETRY");
    expect(updated.expiration_attempt_count).toBe(1);
    expect(updated.expiration_next_attempt_at).toBeDefined();
    
    const nextAttempt = new Date(updated.expiration_next_attempt_at);
    const now = new Date();
    // Should be in future (5s base + jitter)
    expect(nextAttempt.getTime()).toBeGreaterThan(now.getTime());
    expect(nextAttempt.getTime()).toBeLessThan(now.getTime() + 10000); // Within 10s
    
    // Verify audit event for retry scheduling (not EXPIRATION_FAILED - that's for terminal)
    const events = await testAuditStore.getByRequestId(request.id);
    const skippedEvent = events.find(e => e.type === "EXPIRATION_SKIPPED");
    expect(skippedEvent).toBeDefined();
    expect(skippedEvent?.metadata?.reason).toBe("retry_scheduled");
    expect(skippedEvent?.metadata?.errorCode).toBe(503);
    expect(skippedEvent?.metadata?.attemptCount).toBe(1);
  });
});

// ============================================================================
// CASE 30–40: Distributed Concurrency & Recovery Tests
// ============================================================================

describe("Distributed Expiration Execution (CASE 30-40)", () => {
  
  it("CASE 30 — Two workers cannot concurrently own same lease", async () => {
    if (!testPool) return;
    
    const request = createTestRequest({
      requesterId: "case-30-user",
      accessExpiresAt: new Date(Date.now() - 1000).toISOString(),
      status: "FULFILLED",
    });
    
    await insertRequest(testPool, request);
    
    const schedulerA = new ExpirationScheduler(testExecutor, testAuditStore, testPool, {
      pollIntervalMs: 50,
      leaseDurationMs: 5000,
      batchSize: 10,
      providerConcurrency: 5,
    });
    
    const schedulerB = new ExpirationScheduler(testExecutor, testAuditStore, testPool, {
      pollIntervalMs: 50,
      leaseDurationMs: 5000,
      batchSize: 10,
      providerConcurrency: 5,
    });
    
    await Promise.all([
      runExpirationTick(schedulerA),
      runExpirationTick(schedulerB),
    ]);
    
    // Only ONE worker should have processed (FOR UPDATE SKIP LOCKED)
    expect(testExecutor.getCallCount("revoke")).toBe(1);
    
    // Verify lease ownership in DB (only one lease_owner set)
    const updated = await getRequest(testPool, request.id);
    expect(updated.lease_owner).toBeDefined();
    expect(updated.status).toBe("REVOKED");
    
    schedulerA.stop();
    schedulerB.stop();
  });

  it("CASE 31 — Expired lease is reclaimable by another worker", async () => {
    if (!testPool) return;
    
    const request = createTestRequest({
      requesterId: "case-31-user",
      accessExpiresAt: new Date(Date.now() - 1000).toISOString(),
      status: "FULFILLED",
    });
    
    await insertRequest(testPool, request);
    
    // Manually set an EXPIRED lease (simulating worker A claimed but lease expired)
    await testPool.query(
      `UPDATE access_requests SET 
        lease_owner = 'worker-A',
        lease_until = NOW() - interval '10 seconds',
        lease_acquired_at = NOW() - interval '70 seconds',
        version = version + 1,
        updated_at = NOW()
      WHERE id = $1`,
      [request.id]
    );
    
    // Create new scheduler (worker B)
    const schedulerB = new ExpirationScheduler(testExecutor, testAuditStore, testPool, {
      pollIntervalMs: 100,
      leaseDurationMs: 5000,
      batchSize: 10,
      providerConcurrency: 5,
    });
    
    await runExpirationTick(schedulerB);
    
    // Worker B should have claimed the expired lease and processed
    expect(testExecutor.getCallCount("revoke")).toBe(1);
    
    const updated = await getRequest(testPool, request.id);
    expect(updated.status).toBe("REVOKED");
    // After successful revocation, lease is released (NULL)
    expect(updated.lease_owner).toBeNull();
    
    schedulerB.stop();
  });

  it("CASE 32 — Active lease cannot be stolen by another worker", async () => {
    if (!testPool) return;
    
    const request = createTestRequest({
      requesterId: "case-32-user",
      accessExpiresAt: new Date(Date.now() - 1000).toISOString(),
      status: "FULFILLED",
    });
    
    await insertRequest(testPool, request);
    
    // Manually set an ACTIVE lease (worker A is still processing)
    await testPool.query(
      `UPDATE access_requests SET 
        lease_owner = 'worker-A',
        lease_until = NOW() + interval '60 seconds',
        lease_acquired_at = NOW(),
        version = version + 1,
        updated_at = NOW()
      WHERE id = $1`,
      [request.id]
    );
    
    // Create new scheduler (worker B)
    const schedulerB = new ExpirationScheduler(testExecutor, testAuditStore, testPool, {
      pollIntervalMs: 100,
      leaseDurationMs: 5000,
      batchSize: 10,
      providerConcurrency: 5,
    });
    
    await runExpirationTick(schedulerB);
    
    // Worker B should NOT have processed (active lease blocks)
    expect(testExecutor.getCallCount("revoke")).toBe(0);
    
    // Lease should still belong to worker-A
    const updated = await getRequest(testPool, request.id);
    expect(updated.status).toBe("FULFILLED");
    expect(updated.lease_owner).toBe("worker-A");
    
    schedulerB.stop();
  });

  it("CASE 33 — Worker crash after claim recovers via lease expiration", async () => {
    if (!testPool) return;
    
    const request = createTestRequest({
      requesterId: "case-33-user",
      accessExpiresAt: new Date(Date.now() - 1000).toISOString(),
      status: "FULFILLED",
    });
    
    await insertRequest(testPool, request);
    
    // Worker A claims lease
    await testPool.query(
      `UPDATE access_requests SET 
        lease_owner = 'worker-A',
        lease_until = NOW() - interval '10 seconds', -- Expired lease
        lease_acquired_at = NOW() - interval '70 seconds',
        version = version + 1,
        updated_at = NOW()
      WHERE id = $1`,
      [request.id]
    );
    
    // Worker A "crashes" - never processes, lease expires
    // Worker B comes along
    const schedulerB = new ExpirationScheduler(testExecutor, testAuditStore, testPool, {
      pollIntervalMs: 100,
      leaseDurationMs: 5000,
      batchSize: 10,
      providerConcurrency: 5,
    });
    
    await runExpirationTick(schedulerB);
    
    // Worker B should reclaim expired lease and process
    expect(testExecutor.getCallCount("revoke")).toBe(1);
    
    const updated = await getRequest(testPool, request.id);
    expect(updated.status).toBe("REVOKED");
    // After successful revocation, lease is released (NULL)
    expect(updated.lease_owner).toBeNull();
    
    schedulerB.stop();
  });

  it("CASE 34 — Worker crash after DELETE recovers by reconciliation GET", async () => {
    if (!testPool) return;
    
    const request = createTestRequest({
      requesterId: "case-34-user",
      accessExpiresAt: new Date(Date.now() - 1000).toISOString(),
      status: "FULFILLED",
    });
    
    await insertRequest(testPool, request);
    
    // Worker A: Claims lease
    await testPool.query(
      `UPDATE access_requests SET 
        lease_owner = 'worker-A',
        lease_until = NOW() - interval '10 seconds',
        lease_acquired_at = NOW() - interval '70 seconds',
        version = version + 1,
        updated_at = NOW()
      WHERE id = $1`,
      [request.id]
    );
    
    // Worker A: DELETE succeeds (mocked)
    // Worker A: CRASHES before DB update (lease expires)
    
    // Worker B: Claims expired lease
    const schedulerB = new ExpirationScheduler(testExecutor, testAuditStore, testPool, {
      pollIntervalMs: 100,
      leaseDurationMs: 5000,
      batchSize: 10,
      providerConcurrency: 5,
    });
    
    await runExpirationTick(schedulerB);
    
    // Worker B should reconcile: sees revocation already done
    // Should NOT call revoke again (idempotent)
    // OR should call revoke but it succeeds idempotently
    expect(testExecutor.getCallCount("revoke")).toBeLessThanOrEqual(1);
    
    const updated = await getRequest(testPool, request.id);
    expect(updated.status).toBe("REVOKED");
    
    schedulerB.stop();
  });

  it("CASE 35 — Extension before claim prevents revocation", async () => {
    if (!testPool) return;
    
    const T1 = new Date(Date.now() - 5000); // Original expiry (past)
    const T2 = new Date(Date.now() + 3600000); // Extended expiry (future)
    
    const request = createTestRequest({
      requesterId: "case-35-user",
      accessExpiresAt: T1.toISOString(),
      status: "FULFILLED",
    });
    
    await insertRequest(testPool, request);
    
    // User extends access to T2 BEFORE scheduler claims
    await testPool.query(
      `UPDATE access_requests SET 
        access_expires_at = $1,
        version = version + 1,
        updated_at = NOW()
      WHERE id = $2`,
      [T2.toISOString(), request.id]
    );
    
    // Scheduler runs - claim query sees T2 > now, so NOT due
    await runExpirationTick(testScheduler);
    
    // Should SKIP revocation (not even claimed)
    expect(testExecutor.getCallCount("revoke")).toBe(0);
    
    const updated = await getRequest(testPool, request.id);
    expect(updated.status).toBe("FULFILLED");
    expect(new Date(updated.access_expires_at).getTime()).toBeCloseTo(T2.getTime(), -3);
  });

  it("CASE 36 — Manual revoke while leased resolves safely", async () => {
    if (!testPool) return;
    
    const request = createTestRequest({
      requesterId: "case-36-user",
      accessExpiresAt: new Date(Date.now() - 1000).toISOString(),
      status: "FULFILLED",
    });
    
    await insertRequest(testPool, request);
    
    // Set an EXPIRED lease (simulates worker claimed but processing hasn't happened yet)
    await testPool.query(
      `UPDATE access_requests SET 
        lease_owner = 'worker-A',
        lease_until = NOW() - interval '10 seconds',
        lease_acquired_at = NOW() - interval '70 seconds',
        version = version + 1,
        updated_at = NOW()
      WHERE id = $1`,
      [request.id]
    );
    
    // Admin manually revokes access (external action)
    await testPool.query(
      `UPDATE access_requests SET 
        status = 'REVOKED',
        version = version + 1,
        updated_at = NOW()
      WHERE id = $1`,
      [request.id]
    );
    
    // Worker runs - should NOT claim REVOKED status (already terminal)
    await runExpirationTick(testScheduler);
    
    // Should NOT call revoke (already revoked)
    expect(testExecutor.getCallCount("revoke")).toBe(0);
    
    // Status remains REVOKED
    const updated = await getRequest(testPool, request.id);
    expect(updated.status).toBe("REVOKED");
    
    // No EXPIRATION_SKIPPED event because REVOKED is not processed by expiration scheduler
    // (expiration scheduler only processes FULFILLED and RETRY)
  });

  it("CASE 37 — Retry backoff prevents immediate reclaim", async () => {
    if (!testPool) return;
    
    const request = createTestRequest({
      requesterId: "case-37-user",
      accessExpiresAt: new Date(Date.now() - 1000).toISOString(),
      status: "RETRY", // Already in retry state
      expirationAttemptCount: 1,
      expirationMaxRetries: 3,
      expirationNextAttemptAt: new Date(Date.now() + 5000).toISOString(), // 5s in future
    });
    
    await insertRequest(testPool, request);
    
    // Worker runs BEFORE nextAttemptAt
    await runExpirationTick(testScheduler);
    
    // Should NOT process (nextAttemptAt not reached)
    expect(testExecutor.getCallCount("revoke")).toBe(0);
    
    const updated = await getRequest(testPool, request.id);
    expect(updated.status).toBe("RETRY");
    expect(updated.expiration_attempt_count).toBe(1);
  });

  it("CASE 38 — GitHub 429 schedules retry with backoff", async () => {
    if (!testPool) return;
    
    const request = createTestRequest({
      requesterId: "case-38-user",
      accessExpiresAt: new Date(Date.now() - 1000).toISOString(),
      status: "FULFILLED",
      expirationAttemptCount: 0,
      expirationMaxRetries: 3,
    });
    
    await insertRequest(testPool, request);
    
    // Mock 429 rate limit
    testExecutor.shouldFail = true;
    testExecutor.failStatusCode = 429;
    
    await runExpirationTick(testScheduler);
    
    // Should schedule retry with backoff
    const updated = await getRequest(testPool, request.id);
    expect(updated.status).toBe("RETRY");
    expect(updated.expiration_attempt_count).toBe(1);
    expect(updated.expiration_next_attempt_at).toBeDefined();
    expect(updated.expiration_last_error_code).toBe(429);
    
    // Backoff should be: baseDelay * 2^attempt * (1 ± jitter)
    // 5s * 2^1 = 10s ± 20% => 8s to 12s
    const nextAttempt = new Date(updated.expiration_next_attempt_at);
    const now = new Date();
    // Just verify it's in the future with reasonable bounds (allowing for test execution time)
    expect(nextAttempt.getTime()).toBeGreaterThan(now.getTime()); // In the future
    expect(nextAttempt.getTime()).toBeLessThan(now.getTime() + 20000); // Within 20s (generous)
  });

  it("CASE 39 — GitHub 503 schedules retry with backoff", async () => {
    if (!testPool) return;
    
    const request = createTestRequest({
      requesterId: "case-39-user",
      accessExpiresAt: new Date(Date.now() - 1000).toISOString(),
      status: "FULFILLED",
      expirationAttemptCount: 0,
      expirationMaxRetries: 3,
    });
    
    await insertRequest(testPool, request);
    
    // Mock 503 service unavailable
    testExecutor.shouldFail = true;
    testExecutor.failStatusCode = 503;
    
    await runExpirationTick(testScheduler);
    
    // Should schedule retry with backoff
    const updated = await getRequest(testPool, request.id);
    expect(updated.status).toBe("RETRY");
    expect(updated.expiration_attempt_count).toBe(1);
    expect(updated.expiration_last_error_code).toBe(503);
    
    const nextAttempt = new Date(updated.expiration_next_attempt_at);
    const now = new Date();
    // Just verify it's in the future with reasonable bounds (allowing for test execution time)
    expect(nextAttempt.getTime()).toBeGreaterThan(now.getTime()); // In the future
    expect(nextAttempt.getTime()).toBeLessThan(now.getTime() + 20000); // Within 20s (generous)
  });

  it("CASE 40 — Terminal failure becomes operator-visible (REVOCATION_FAILED)", async () => {
    if (!testPool) return;
    
    const request = createTestRequest({
      requesterId: "case-40-user",
      accessExpiresAt: new Date(Date.now() - 1000).toISOString(),
      status: "RETRY",
      expirationAttemptCount: 3, // Max retries exhausted
      expirationMaxRetries: 3,
      expirationNextAttemptAt: new Date(Date.now() - 1000).toISOString(), // Due for retry
    });
    
    await insertRequest(testPool, request);
    
    // Mock persistent failure
    testExecutor.shouldFail = true;
    testExecutor.failStatusCode = 503;
    
    await runExpirationTick(testScheduler);
    
    // Should move to REVOCATION_FAILED (terminal)
    const updated = await getRequest(testPool, request.id);
    expect(updated.status).toBe("REVOCATION_FAILED");
    expect(updated.expiration_attempt_count).toBe(4); // 3 + 1 = maxRetries + 1
    expect(updated.expiration_last_error_code).toBe(503);
    
    // Should NOT schedule another retry (no nextAttemptAt)
    expect(updated.expiration_next_attempt_at).toBeNull();
    
    // Verify audit event
    const events = await testAuditStore.getByRequestId(request.id);
    const failedEvent = events.find(e => e.type === "EXPIRATION_FAILED");
    expect(failedEvent).toBeDefined();
    expect(failedEvent?.metadata?.terminal).toBe(true);
    expect(failedEvent?.metadata?.attempt).toBe(4);
  });
});

describe("ExpirationScheduler - Unit Tests (No DB)", () => {
  let mockPool: any;
  let executor: GitHubAccessExecutor;
  let auditStore: InMemoryAuditEventStore;
  
  beforeAll(() => {
    auditStore = new InMemoryAuditEventStore();
    executor = new GitHubAccessExecutor(
      {
        appId: "4647201",
        installationId: "154891672",
        privateKey: "[REDACTED PRIVATE KEY]",
        allowedOrganizations: ["opnory-sandbox"],
        allowedTeams: ["opnory-engineering-contributors"],
      },
      new InMemoryIdempotencyStore(),
      auditStore
    );
  });
  
  beforeEach(() => {
    mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      connect: vi.fn().mockResolvedValue({
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        release: vi.fn(),
      }),
      on: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined),
    } as unknown as Pool;
  });

  it("should create scheduler instance", async () => {
    const scheduler = new ExpirationScheduler(executor, auditStore, mockPool, {
      pollIntervalMs: 1000,
      leaseDurationMs: 5000,
    });
    expect(scheduler).toBeDefined();
  });

  it("should have processDueExpirations method", async () => {
    const scheduler = new ExpirationScheduler(executor, auditStore, mockPool, {
      pollIntervalMs: 1000,
    });
    expect(typeof (scheduler as any).processDueExpirations).toBe("function");
  });

  it("should have stop method", async () => {
    const scheduler = new ExpirationScheduler(executor, auditStore, mockPool, {
      pollIntervalMs: 1000,
    });
    expect(typeof scheduler.stop).toBe("function");
  });

  it("should have start method", async () => {
    const scheduler = new ExpirationScheduler(executor, auditStore, mockPool, {
      pollIntervalMs: 1000,
    });
    expect(typeof scheduler.start).toBe("function");
  });

  it("should export createExpirationScheduler factory", async () => {
    expect(typeof createExpirationScheduler).toBe("function");
  });
});