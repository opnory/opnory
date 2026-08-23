import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { Pool } from "pg";
import { getLogger } from "@opnory/observability";
import { InMemoryAuditEventStore } from "@opnory/access-audit";
import { LocalGovernanceProvider } from "@opnory/access-governance";
import { 
  GovernanceProvider, 
  GovernanceSubject, 
  GovernedEntitlement, 
  GovernedAccessRequest,
  GovernanceRequest, 
  GovernanceRequestStatus, 
  GovernanceAssignment, 
  GovernanceRevocationResult, 
  GovernanceAuthority 
} from "@opnory/access-types";
import { GovernanceReconciliationWorker } from "./governance-reconciliation-worker";
import { randomUUID } from "crypto";

// ============================================================================
// Mock Provider for Reconciliation Worker Tests
// ============================================================================

function createMockReconciliationProvider(): GovernanceProvider & {
  preApproveRequest: (id: string, assignmentId?: string) => void;
  preDenyRequest: (id: string) => void;
  preRevokeAssignment: (id: string) => void;
  preSetAssignmentStatus: (id: string, status: string) => void;
  // Request-specific call tracking
  callsFor: (externalRequestId: string) => { getRequestStatus: number; getAssignment: number; revokeAssignment: number };
  resetCalls: (externalRequestId: string) => void;
} {
  const requests = new Map<string, GovernanceRequest>();
  const assignments = new Map<string, GovernanceAssignment>();
  let requestCounter = 0;
  
  // Request-specific call tracking
  const callCounts = new Map<string, { getRequestStatus: number; getAssignment: number; revokeAssignment: number }>();

  function trackCall(externalRequestId: string, method: "getRequestStatus" | "getAssignment" | "revokeAssignment") {
    const counts = callCounts.get(externalRequestId) || { getRequestStatus: 0, getAssignment: 0, revokeAssignment: 0 };
    counts[method]++;
    callCounts.set(externalRequestId, counts);
  }

  const provider: GovernanceProvider & {
    preApproveRequest: (id: string, assignmentId?: string) => void;
    preDenyRequest: (id: string) => void;
    preRevokeAssignment: (id: string) => void;
    preSetAssignmentStatus: (id: string, status: string) => void;
    callsFor: (externalRequestId: string) => { getRequestStatus: number; getAssignment: number; revokeAssignment: number };
    resetCalls: (externalRequestId: string) => void;
  } = {
    authority: "entra" as GovernanceAuthority,
    
    async resolveEntitlement(entitlement: GovernedEntitlement): Promise<GovernedEntitlement> {
      return entitlement;
    },
    
    async submitRequest(request: GovernedAccessRequest): Promise<GovernanceRequest> {
      requestCounter++;
      const externalRequestId = `entra-req-${requestCounter}`;
      const govRequest: GovernanceRequest = {
        externalRequestId,
        authority: "entra",
        status: "PENDING_APPROVAL",
        submittedAt: new Date().toISOString(),
        metadata: { subject: request.subject, entitlement: request.entitlement },
      };
      requests.set(externalRequestId, govRequest);
      // Initialize call tracking for this request
      callCounts.set(externalRequestId, { getRequestStatus: 0, getAssignment: 0, revokeAssignment: 0 });
      return govRequest;
    },
    
    async getRequestStatus(externalRequestId: string): Promise<GovernanceRequestStatus> {
      trackCall(externalRequestId, "getRequestStatus");
      const request = requests.get(externalRequestId);
      if (!request) {
        return { 
          externalRequestId, 
          status: "UNKNOWN", 
          lastPolledAt: new Date().toISOString(),
          rawResponse: { error: "Request not found" }
        };
      }
      return { 
        externalRequestId, 
        status: request.status, 
        assignmentId: request.assignmentId, 
        assignmentExpiresAt: request.assignmentExpiresAt,
        lastPolledAt: new Date().toISOString()
      };
    },
    
    async getAssignment(subject: GovernanceSubject, entitlement: GovernedEntitlement): Promise<GovernanceAssignment | null> {
      const key = `${subject.id}:${entitlement.entitlementId}`;
      trackCall(key, "getAssignment");
      const assignment = assignments.get(key);
      return assignment || null;
    },
    
    async revokeAssignment(assignmentId: string): Promise<GovernanceRevocationResult> {
      let found = false;
      for (const [key, assignment] of assignments.entries()) {
        if (assignment.assignmentId === assignmentId) {
          trackCall(key, "revokeAssignment");
          assignment.status = "REVOKED";
          found = true;
          break;
        }
      }
      return { 
        assignmentId, 
        success: found, 
        message: found ? "Revoked" : "Assignment not found",
        error: found ? undefined : "Assignment not found"
      };
    },
    
    preApproveRequest(externalRequestId: string, assignmentId?: string) {
      const request = requests.get(externalRequestId);
      if (request) {
        request.status = "APPROVED";
        request.decidedAt = new Date().toISOString();
        if (assignmentId) {
          request.assignmentId = assignmentId;
        }
      }
    },
    
    preDenyRequest(externalRequestId: string) {
      const request = requests.get(externalRequestId);
      if (request) {
        request.status = "DENIED";
        request.decidedAt = new Date().toISOString();
      }
    },
    
    preRevokeAssignment(assignmentId: string) {
      for (const [key, assignment] of assignments.entries()) {
        if (assignment.assignmentId === assignmentId) {
          assignment.status = "REVOKED";
        }
      }
    },
    
    preSetAssignmentStatus(assignmentId: string, status: string) {
      for (const [key, assignment] of assignments.entries()) {
        if (assignment.assignmentId === assignmentId) {
          assignment.status = status as any;
        }
      }
    },
    
    callsFor(externalRequestId: string) {
      return callCounts.get(externalRequestId) || { getRequestStatus: 0, getAssignment: 0, revokeAssignment: 0 };
    },
    
    resetCalls(externalRequestId: string) {
      callCounts.set(externalRequestId, { getRequestStatus: 0, getAssignment: 0, revokeAssignment: 0 });
    }
  };
  
  return provider;
}

// ============================================================================
// Test Setup Helpers - Schema Isolation
// ============================================================================

function getTestDbConfig() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL not set");
  }
  // Parse the URL to extract components
  const url = new URL(databaseUrl);
  return {
    host: url.hostname,
    port: parseInt(url.port || "5432"),
    database: url.pathname.slice(1),
    user: url.username,
    password: url.password,
    max: 5,
  };
}

async function createAdminPool(): Promise<Pool> {
  const config = getTestDbConfig();
  const pool = new Pool({ ...config, max: 2 });
  return pool;
}

async function runMigrations(pool: Pool): Promise<void> {
  await pool.query(`
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
      expiration_attempt_count INTEGER NOT NULL DEFAULT 0,
      expiration_next_attempt_at TIMESTAMPTZ,
      expiration_max_retries INTEGER NOT NULL DEFAULT 3,
      expiration_last_error TEXT,
      expiration_last_attempt_at TIMESTAMPTZ,
      lease_owner VARCHAR(255),
      lease_until TIMESTAMPTZ,
      lease_acquired_at TIMESTAMPTZ,
      governance_external_request_id VARCHAR(255),
      governance_authority VARCHAR(50),
      governance_assignment_id VARCHAR(255),
      governance_assignment_expires_at TIMESTAMPTZ,
      governance_last_checked_at TIMESTAMPTZ,
      governance_next_check_at TIMESTAMPTZ,
      governance_retry_count INTEGER NOT NULL DEFAULT 0,
      governance_last_error TEXT,
      governance_last_error_code INTEGER,
      governance_lease_owner VARCHAR(255),
      governance_lease_until TIMESTAMPTZ,
      governance_lease_acquired_at TIMESTAMPTZ,
      governance_attempt_count INTEGER NOT NULL DEFAULT 0,
      governance_next_attempt_at TIMESTAMPTZ,
      governance_last_attempt_at TIMESTAMPTZ,
      governance_max_retries INTEGER NOT NULL DEFAULT 3
    );
  `);
  
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_access_requests_governance_lease 
      ON access_requests(governance_lease_owner, governance_lease_until)
    WHERE governance_lease_until IS NOT NULL;
  `);
  
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_access_requests_governance_next_check 
      ON access_requests(governance_next_check_at)
    WHERE governance_next_check_at IS NOT NULL;
  `);
  
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_access_requests_governance_next_attempt 
      ON access_requests(governance_next_attempt_at)
    WHERE governance_next_attempt_at IS NOT NULL;
  `);
  
  await pool.query(`
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
  `);
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key VARCHAR(500) PRIMARY KEY,
      request_id UUID NOT NULL,
      result JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);
}

// ============================================================================
// Conformance Tests: Reconciliation Worker (CASE 65-72)
// ============================================================================

describe("Governance Reconciliation Worker Conformance (CASE 65-72)", () => {
  let adminPool: Pool;
  let pool: Pool;
  let auditStore: InMemoryAuditEventStore;
  let provider: ReturnType<typeof createMockReconciliationProvider>;
  let worker: GovernanceReconciliationWorker;
  let testSchemaName: string;
  
  const testSubject: GovernanceSubject = {
    id: "123e4567-e89b-12d3-a456-426614174000",
    displayName: "Test User",
    email: "test@example.com",
    source: "manual",
    raw: {},
  };
  
  const testEntitlement: GovernedEntitlement = {
    entitlementId: "123e4567-e89b-12d3-a456-426614174001",
    authority: "entra",
    externalId: "external-group-65",
    externalName: "Test Group",
    metadata: {},
  };

  beforeAll(async () => {
    adminPool = await createAdminPool();
    testSchemaName = `test_governance_reconciliation_${randomUUID().replaceAll("-", "")}`;
    
    await adminPool.query(`CREATE SCHEMA "${testSchemaName}"`);
    
    const dbConfig = getTestDbConfig();
    pool = new Pool({
      ...dbConfig,
      options: `-c search_path=${testSchemaName}`,
      max: 10,
    });
    
    await runMigrations(pool);
  });
  
  afterAll(async () => {
    await pool.end();
    await adminPool.query(`DROP SCHEMA "${testSchemaName}" CASCADE`);
    await adminPool.end();
  });

  beforeEach(async () => {
    // Truncate all tables in the test schema
    await pool.query(`
      TRUNCATE TABLE
        access_requests,
        audit_events,
        idempotency_keys
      RESTART IDENTITY CASCADE
    `);
    
    auditStore = new InMemoryAuditEventStore();
    provider = createMockReconciliationProvider();
    
    // Create a minimal reconciler that uses our mock provider
    const mockReconciler = {
      getProvider: (authority: string) => authority === "entra" ? provider : null,
    } as any;
    
    worker = new GovernanceReconciliationWorker(
      mockReconciler,
      auditStore,
      pool,
      {
        pollIntervalMs: 100,
        pollJitterMs: 0,
        maxPollIntervalMs: 5000,
        minPollIntervalMs: 100,
        leaseDurationMs: 5000,
        leaseRenewalMarginMs: 1000,
        batchSize: 10,
        providerConcurrency: 2,
        maxRetries: 3,
        baseRetryDelayMs: 100,
        maxRetryDelayMs: 1000,
        jitterFactor: 0,
        adaptivePolling: false,
      }
    );
  });
  
  afterEach(async () => {
    await worker.stop();
  });

  // Helper to insert a test request AND seed provider state
  async function insertTestRequest(overrides: Partial<{
    status: string;
    governanceAuthority: string;
    governanceExternalRequestId: string;
    governanceAssignmentId: string;
    governanceNextCheckAt: Date | null;
    governanceNextAttemptAt: Date | null;
    governanceAttemptCount: number;
    governanceMaxRetries: number;
  }> = {}) {
    const id = randomUUID();
    const correlationId = randomUUID();
    const now = new Date();
    // Default to overdue (past) so the worker claims the request
    const nextCheckAt = overrides.governanceNextCheckAt || new Date(now.getTime() - 1000);
    const nextAttemptAt = overrides.governanceNextAttemptAt || new Date(now.getTime() - 1000);
    
    // If external request ID not provided, generate one via provider
    let externalRequestId = overrides.governanceExternalRequestId;
    if (!externalRequestId) {
      const submitResult = await provider.submitRequest({
        requestId: randomUUID(),
        subject: testSubject,
        entitlement: testEntitlement,
        justification: "Test request",
      });
      externalRequestId = submitResult.externalRequestId;
    }
    
    await pool.query(`
      INSERT INTO access_requests (
        id, correlation_id, requester_id, requester_email,
        entitlement_id, entitlement_name, entitlement_system,
        reason, status, version, idempotency_key, metadata,
        governance_external_request_id, governance_authority,
        governance_assignment_id, governance_next_check_at,
        governance_next_attempt_at, governance_attempt_count,
        governance_max_retries
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
    `, [
      id,
      correlationId,
      testSubject.id,
      testSubject.email,
      testEntitlement.entitlementId,
      testEntitlement.externalName,
      "github",
      "Test reconciliation",
      overrides.status || "AWAITING_AUTHORITY_DECISION",
      0,
      `${id}:${testEntitlement.entitlementId}:${testSubject.id}`,
      JSON.stringify({ governance: { provider: overrides.governanceAuthority || "entra", fulfillmentOwner: "opnory" } }),
      externalRequestId,
      overrides.governanceAuthority || "entra",
      overrides.governanceAssignmentId || null,
      nextCheckAt,
      nextAttemptAt,
      overrides.governanceAttemptCount || 0,
      overrides.governanceMaxRetries || 3,
    ]);
    
    return { id, correlationId, externalRequestId };
  }

  // ============================================================================
  // CASE 65: Two workers race for same governance request → one provider call
  // ============================================================================
  describe("CASE 65 — Two workers race for same governance request", () => {
    it("should only make one provider call when two workers race", async () => {
      const { id, correlationId, externalRequestId } = await insertTestRequest({
        status: "AWAITING_AUTHORITY_DECISION",
      });
      
      provider.preApproveRequest(externalRequestId, "assignment-race-1");
      
      // Create two workers
      const mockReconciler = {
        getProvider: (authority: string) => authority === "entra" ? provider : null,
      } as any;
      
      const worker1 = new GovernanceReconciliationWorker(
        mockReconciler, auditStore, pool,
        { pollIntervalMs: 100, pollJitterMs: 0, batchSize: 1, providerConcurrency: 1, leaseDurationMs: 5000 }
      );
      
      const worker2 = new GovernanceReconciliationWorker(
        mockReconciler, auditStore, pool,
        { pollIntervalMs: 100, pollJitterMs: 0, batchSize: 1, providerConcurrency: 1, leaseDurationMs: 5000 }
      );
      
      // Run both workers
      await Promise.all([
        worker1.runOnce(),
        worker2.runOnce(),
      ]);
      
      await worker1.stop();
      await worker2.stop();
      
      // Verify only one provider call was made (status should be APPROVED)
      const result = await pool.query("SELECT status, governance_assignment_id FROM access_requests WHERE id = $1", [id]);
      expect(result.rows[0].status).toBe("APPROVED");
      expect(result.rows[0].governance_assignment_id).toBe("assignment-race-1");
      
      // Verify only one reconciliation succeeded audit event
      const events = await auditStore.getByRequestId(id);
      const succeededEvents = events.filter((e: any) => e.type === "GOVERNANCE_RECONCILIATION_SUCCEEDED");
      expect(succeededEvents.length).toBe(1);
      
      // Verify exactly one getRequestStatus call for the target request
      const calls = provider.callsFor(externalRequestId);
      expect(calls.getRequestStatus).toBe(1);
    });
  });

  // ============================================================================
  // CASE 66: Active foreign lease → zero processing
  // ============================================================================
  describe("CASE 66 — Active foreign lease → zero processing", () => {
    it("should skip requests leased by another worker", async () => {
      const { id, correlationId, externalRequestId } = await insertTestRequest({
        status: "AWAITING_AUTHORITY_DECISION",
      });
      
      // Manually lease to another worker
      await pool.query(`
        UPDATE access_requests 
        SET governance_lease_owner = 'other-worker', governance_lease_until = $1
        WHERE id = $2
      `, [new Date(Date.now() + 60000), id]);
      
      provider.preApproveRequest(externalRequestId, "assignment-foreign-1");
      
      await worker.runOnce();
      
      // Request should not be processed
      const result = await pool.query("SELECT status FROM access_requests WHERE id = $1", [id]);
      expect(result.rows[0].status).toBe("AWAITING_AUTHORITY_DECISION");
      
      // No provider call should have been made (status unchanged)
      // And no reconciliation audit event
      const events = await auditStore.getByRequestId(id);
      const reconciliationEvents = events.filter((e: any) => e.type.startsWith("GOVERNANCE_RECONCILIATION"));
      expect(reconciliationEvents.length).toBe(0);
    });
  });

  // ============================================================================
  // CASE 67: Expired lease → reclaim and continue
  // ============================================================================
  describe("CASE 67 — Expired lease → reclaim and continue", () => {
    it("should reclaim and process requests with expired leases", async () => {
      const { id, correlationId, externalRequestId } = await insertTestRequest({
        status: "AWAITING_AUTHORITY_DECISION",
      });
      
      // Manually lease to another worker but expired
      await pool.query(`
        UPDATE access_requests 
        SET governance_lease_owner = 'other-worker', governance_lease_until = $1
        WHERE id = $2
      `, [new Date(Date.now() - 10000), id]);
      
      provider.preApproveRequest(externalRequestId, "assignment-expired-1");
      
      await worker.runOnce();
      
      // Request should be processed despite expired foreign lease
      const result = await pool.query("SELECT status, governance_assignment_id FROM access_requests WHERE id = $1", [id]);
      expect(result.rows[0].status).toBe("APPROVED");
      expect(result.rows[0].governance_assignment_id).toBe("assignment-expired-1");
      
      // Verify exactly one getRequestStatus call for the target request
      const calls = provider.callsFor(externalRequestId);
      expect(calls.getRequestStatus).toBe(1);
    });
  });

  // ============================================================================
  // CASE 68: Provider timeout → retry metadata + backoff
  // ============================================================================
  describe("CASE 68 — Provider timeout → retry metadata + backoff", () => {
    it("should schedule retry with backoff on provider timeout", async () => {
      const { id, correlationId, externalRequestId } = await insertTestRequest({
        status: "AWAITING_AUTHORITY_DECISION",
        governanceAttemptCount: 0,
        governanceMaxRetries: 2,
      });
      
      // Create a provider that throws a timeout error immediately
      const timeoutProvider = {
        ...provider,
        async getRequestStatus(externalRequestId: string): Promise<GovernanceRequestStatus> {
          throw new Error("ETIMEDOUT: Connection timed out");
        },
      };
      
      const mockReconciler = {
        getProvider: (authority: string) => authority === "entra" ? timeoutProvider : null,
      } as any;
      
      const timeoutWorker = new GovernanceReconciliationWorker(
        mockReconciler, auditStore, pool,
        { 
          pollIntervalMs: 100, 
          pollJitterMs: 0, 
          batchSize: 1, 
          providerConcurrency: 1, 
          leaseDurationMs: 5000,
          maxRetries: 2,
          baseRetryDelayMs: 50,
          maxRetryDelayMs: 200,
          jitterFactor: 0,
        }
      );
      
      await timeoutWorker.runOnce();
      await timeoutWorker.stop();
      
      // Should be scheduled for retry
      const result = await pool.query(
        "SELECT status, governance_attempt_count, governance_next_attempt_at FROM access_requests WHERE id = $1", 
        [id]
      );
      
      expect(result.rows[0].status).toBe("RETRY");
      expect(result.rows[0].governance_attempt_count).toBe(1);
      expect(result.rows[0].governance_next_attempt_at).not.toBeNull();
      
      // Verify failure/retry audit emitted
      const events = await auditStore.getByRequestId(id);
      const failedEvents = events.filter((e: any) => e.type === "GOVERNANCE_RECONCILIATION_FAILED");
      expect(failedEvents.length).toBe(1);
    });
  });

  // ============================================================================
  // CASE 69: Restart finds overdue reconciliation
  // ============================================================================
  describe("CASE 69 — Restart finds overdue reconciliation", () => {
    it("should process overdue reconciliations on worker restart", async () => {
      const { id, correlationId, externalRequestId } = await insertTestRequest({
        status: "AWAITING_AUTHORITY_DECISION",
        governanceNextCheckAt: new Date(Date.now() - 10000), // Overdue
      });
      
      provider.preApproveRequest(externalRequestId, "assignment-restart-1");
      
      // Create new worker (simulating restart)
      const mockReconciler = {
        getProvider: (authority: string) => authority === "entra" ? provider : null,
      } as any;
      
      const newWorker = new GovernanceReconciliationWorker(
        mockReconciler, auditStore, pool,
        { pollIntervalMs: 100, pollJitterMs: 0, batchSize: 1, providerConcurrency: 1, leaseDurationMs: 5000 }
      );
      
      await newWorker.runOnce();
      await newWorker.stop();
      
      // Should process the overdue request
      const result = await pool.query("SELECT status, governance_assignment_id FROM access_requests WHERE id = $1", [id]);
      expect(result.rows[0].status).toBe("APPROVED");
      expect(result.rows[0].governance_assignment_id).toBe("assignment-restart-1");
    });
  });

  // ============================================================================
  // CASE 70: Request becomes local before processing → skip
  // ============================================================================
  describe("CASE 70 — Request becomes local before processing → skip", () => {
    it("should skip requests that are no longer externally governed", async () => {
      const { id, correlationId, externalRequestId } = await insertTestRequest({
        status: "AWAITING_AUTHORITY_DECISION",
        governanceAuthority: "entra",
      });
      
      // Change to local governance before processing
      await pool.query(`
        UPDATE access_requests 
        SET governance_authority = 'local', metadata = $1
        WHERE id = $2
      `, [JSON.stringify({ governance: { provider: "local" } }), id]);
      
      await worker.runOnce();
      
      // Should skip without error
      const result = await pool.query("SELECT status FROM access_requests WHERE id = $1", [id]);
      expect(result.rows[0].status).toBe("AWAITING_AUTHORITY_DECISION"); // Status unchanged
      
      // Should only have GOVERNANCE_RECONCILIATION_STARTED (claim) event, no SUCCEEDED/FAILED
      const events = await auditStore.getByRequestId(id);
      const reconciliationEvents = events.filter((e: any) => e.type.startsWith("GOVERNANCE_RECONCILIATION"));
      const startedEvents = events.filter((e: any) => e.type === "GOVERNANCE_RECONCILIATION_STARTED");
      const completedEvents = events.filter((e: any) => 
        e.type === "GOVERNANCE_RECONCILIATION_SUCCEEDED" || 
        e.type === "GOVERNANCE_RECONCILIATION_FAILED"
      );
      expect(startedEvents.length).toBe(1); // Claim was made
      expect(completedEvents.length).toBe(0); // But no completion
    });
  });

  // ============================================================================
  // CASE 71: Duplicate external approval observation → one transition/audit
  // ============================================================================
  describe("CASE 71 — Duplicate external approval observation", () => {
    it("should be idempotent for duplicate approval observations", async () => {
      const { id, correlationId, externalRequestId } = await insertTestRequest({
        status: "AWAITING_AUTHORITY_DECISION",
      });
      
      provider.preApproveRequest(externalRequestId, "assignment-duplicate-1");
      
      // Run worker twice
      await worker.runOnce();
      await worker.runOnce();
      
      // Should only transition once
      const result = await pool.query("SELECT status FROM access_requests WHERE id = $1", [id]);
      expect(result.rows[0].status).toBe("APPROVED");
      
      // Only one GOVERNANCE_RECONCILIATION_SUCCEEDED event
      const events = await auditStore.getByRequestId(id);
      const succeededEvents = events.filter((e: any) => e.type === "GOVERNANCE_RECONCILIATION_SUCCEEDED");
      expect(succeededEvents.length).toBe(1);
      
      // Verify exactly one getRequestStatus call for the target request (second run should be no-op)
      const calls = provider.callsFor(externalRequestId);
      expect(calls.getRequestStatus).toBe(1);
    });
  });

  // ============================================================================
  // CASE 72: Drift reconciliation runs once under concurrent workers
  // ============================================================================
  describe("CASE 72 — Drift reconciliation runs once under concurrent workers", () => {
    it("should detect drift only once when two workers race on FULFILLED assignment", async () => {
      const { id, correlationId, externalRequestId } = await insertTestRequest({
        status: "FULFILLED",
        governanceExternalRequestId: "drift-race-1",
        governanceAssignmentId: "assignment-drift-1",
        governanceAuthority: "entra",
        governanceNextCheckAt: new Date(Date.now() - 1000),
      });
      
      // External assignment is revoked
      provider.preSetAssignmentStatus("assignment-drift-1", "REVOKED");
      
      // Create two workers
      const mockReconciler = {
        getProvider: (authority: string) => authority === "entra" ? provider : null,
      } as any;
      
      const worker1 = new GovernanceReconciliationWorker(
        mockReconciler, auditStore, pool,
        { pollIntervalMs: 100, pollJitterMs: 0, batchSize: 1, providerConcurrency: 1, leaseDurationMs: 5000 }
      );
      
      const worker2 = new GovernanceReconciliationWorker(
        mockReconciler, auditStore, pool,
        { pollIntervalMs: 100, pollJitterMs: 0, batchSize: 1, providerConcurrency: 1, leaseDurationMs: 5000 }
      );
      
      // Run both workers concurrently
      await Promise.all([
        worker1.runOnce(),
        worker2.runOnce(),
      ]);
      
      await worker1.stop();
      await worker2.stop();
      
      // Should only detect drift once
      const events = await auditStore.getByRequestId(id);
      const driftEvents = events.filter((e: any) => e.type === "GOVERNANCE_DRIFT_DETECTED");
      expect(driftEvents.length).toBe(1);
      
      // Should only correct state once
      const correctionEvents = events.filter((e: any) => e.type === "GOVERNANCE_STATE_CORRECTED");
      expect(correctionEvents.length).toBe(1);
    });
  });
});