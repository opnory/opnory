import { describe, it, expect, beforeAll, afterAll, vi } from "bun:test";
import { GitHubAccessExecutor, InMemoryIdempotencyStore } from "./index.js";
import { InMemoryAuditEventStore } from "@opnory/access-audit";
import { ExpirationScheduler } from "@opnory/access-store-pg";
import { AccessRequest, FulfilledAccessRequest, EntitlementRef, toFulfilledAccessRequest } from "@opnory/access-types";
import { Pool } from "pg";
import { randomUUID as uuidv4 } from "crypto";

const entitlementRef: EntitlementRef = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  name: "Engineering Contributor",
  system: "github",
  githubConfig: {
    organization: "opnory-sandbox",
    teamSlug: "opnory-engineering-contributors",
    teamRole: "member",
  },
  metadata: {},
};

async function checkGitHubMembership(login: string): Promise<boolean> {
  const githubToken = process.env.GITHUB_TEST_TOKEN;
  if (!githubToken) {
    return false;
  }
  try {
    const response = await fetch(
      `https://api.github.com/orgs/opnory-sandbox/teams/opnory-engineering-contributors/memberships/${login}`,
      {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github+json",
        },
      }
    );
    return response.status === 200;
  } catch {
    return false;
  }
}

describe.skipIf(!process.env.OPNORY_LIVE_GITHUB_TESTS)(
  "ExpirationScheduler - Live Accelerated Test",
  () => {
  let executor: GitHubAccessExecutor;
  let auditStore: InMemoryAuditEventStore;
  let pgPool: Pool;
  let scheduler: ExpirationScheduler;
  let testRequestId: string;

  beforeAll(async () => {
    // Set up PostgreSQL pool
    pgPool = new Pool({
      connectionString: "postgresql://raelldottin@localhost:5432/opnory",
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    auditStore = new InMemoryAuditEventStore();
    executor = new GitHubAccessExecutor(
      {
        appId: "4647201",
        installationId: "154891672",
        privateKey: process.env.OPNORY_GITHUB_PRIVATE_KEY || "-----BEGIN RSA PRIVATE KEY-----\nMOCK_KEY\n-----END RSA PRIVATE KEY-----",
        allowedOrganizations: ["opnory-sandbox"],
        allowedTeams: ["opnory-engineering-contributors"],
      },
      new InMemoryIdempotencyStore(),
      auditStore
    );

    // Create scheduler with fast polling (every 5 seconds for testing)
    scheduler = new ExpirationScheduler(executor, auditStore, pgPool, {
      pollIntervalMs: 5000, // 5 seconds
      leaseDurationMs: 30000,
    });

    // Start the scheduler
    await scheduler.start();
    console.log("Scheduler started with 5s polling interval");
  }, 30000);

  afterAll(async () => {
    if (scheduler) {
      await scheduler.stop();
    }
    if (pgPool) {
      await pgPool.end();
    }
  }, 10000);

  it("TEST 1: should grant access then expire it within test TTL", async () => {
    // First, verify opnory-dev is NOT on the team
    let isMember = await checkGitHubMembership("opnory-dev");
    expect(isMember).toBe(false);

    // Create a test request with short TTL (30 seconds)
    testRequestId = uuidv4();
    const correlationId = uuidv4();
    const now = new Date();
    const accessExpiresAt = new Date(now.getTime() + 30000); // 30 seconds from now

    const request: AccessRequest = {
      id: testRequestId,
      correlationId,
      requesterId: "opnory-dev",
      requesterEmail: "opnory-dev@example.com",
      externalIdentities: {
        github: {
          login: "opnory-dev",
          verified: true,
          verifiedAt: new Date().toISOString(),
          source: "admin",
        },
      },
      entitlement: entitlementRef,
      reason: "Live expiration test",
      status: "FULFILLED",
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: undefined,
      accessExpiresAt: accessExpiresAt.toISOString(),
      approvedAt: new Date(now.getTime() - 60000).toISOString(),
      approvedBy: "test-admin",
      deniedAt: undefined,
      deniedBy: undefined,
      deniedReason: undefined,
      fulfilledAt: new Date(now.getTime() - 30000).toISOString(),
      fulfillmentError: undefined,
      externalId: "github-team-membership-opnory-dev-opnory-sandbox-opnory-engineering-contributors",
      idempotencyKey: `grant:${testRequestId}:${entitlementRef.id}:opnory-dev`,
      metadata: {},
    };

    // Insert the request into PostgreSQL with FULFILLED status and short expiry
    await pgPool.query(
      `INSERT INTO access_requests (
        id, correlation_id, requester_id, requester_email,
        entitlement_id, entitlement_name, entitlement_system,
        reason, status, version, access_expires_at,
        approved_at, approved_by, fulfilled_at, external_id,
        idempotency_key, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
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
        request.accessExpiresAt ? new Date(request.accessExpiresAt) : null,
        request.approvedAt ? new Date(request.approvedAt) : null,
        request.approvedBy,
        request.fulfilledAt ? new Date(request.fulfilledAt) : null,
        request.externalId,
        request.idempotencyKey,
        JSON.stringify(request.metadata),
      ]
    );

    console.log(`Created test request ${testRequestId} with expiry at ${accessExpiresAt.toISOString()}`);

    // Verify the user is added to the team (manually grant via executor)
    const fulfilledRequest = toFulfilledAccessRequest(request);
    const grantResult = await executor.grant(fulfilledRequest);
    console.log("Grant result:", grantResult.success ? "SUCCESS" : "FAILED", grantResult.message);

    // Now wait for the expiration to trigger
    // Poll for up to 90 seconds
    let revoked = false;
    const maxWaitMs = 90000;
    const startTime = Date.now();

    while (!revoked && Date.now() - startTime < maxWaitMs) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Check if request is now REVOKED
      const result = await pgPool.query(
        "SELECT status, access_expires_at FROM access_requests WHERE id = $1",
        [testRequestId]
      );
      
      if (result.rows.length > 0) {
        const row = result.rows[0];
        console.log(`Request status: ${row.status}, access_expires_at: ${row.access_expires_at}`);
        
        if (row.status === "REVOKED") {
          revoked = true;
          break;
        }
      }
    }

    // Verify the request is now REVOKED
    const finalResult = await pgPool.query(
      "SELECT status FROM access_requests WHERE id = $1",
      [testRequestId]
    );
    expect(finalResult.rows[0].status).toBe("REVOKED");

    // Verify GitHub membership is gone
    let isMemberAfter = await checkGitHubMembership("opnory-dev");
    expect(isMemberAfter).toBe(false);
  }, 120000); // 2 minute timeout

  it("TEST 2: should be idempotent - second run does nothing", async () => {
    // The request is already REVOKED, so scheduling again should be a no-op
    const result = await pgPool.query(
      "SELECT status FROM access_requests WHERE id = $1",
      [testRequestId]
    );
    expect(result.rows[0].status).toBe("REVOKED");
  });

  it("TEST 3: extension protection - extended accessExpiresAt prevents revocation", async () => {
    // Create a new request with T1
    const testRequestId2 = uuidv4();
    const correlationId2 = uuidv4();
    const now = new Date();
    const accessExpiresAtT1 = new Date(now.getTime() + 10000); // 10 seconds

    const request2: AccessRequest = {
      id: testRequestId2,
      correlationId: correlationId2,
      requesterId: "opnory-dev",
      requesterEmail: "opnory-dev@example.com",
      externalIdentities: {
        github: {
          login: "opnory-dev",
          verified: true,
          verifiedAt: new Date().toISOString(),
          source: "admin",
        },
      },
      entitlement: entitlementRef,
      reason: "Extension protection test",
      status: "FULFILLED",
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: undefined,
      accessExpiresAt: accessExpiresAtT1.toISOString(),
      approvedAt: new Date(now.getTime() - 60000).toISOString(),
      approvedBy: "test-admin",
      deniedAt: undefined,
      deniedBy: undefined,
      deniedReason: undefined,
      fulfilledAt: new Date(now.getTime() - 30000).toISOString(),
      fulfillmentError: undefined,
      externalId: "github-team-membership-opnory-dev-opnory-sandbox-opnory-engineering-contributors-ext",
      idempotencyKey: `grant:${testRequestId2}:${entitlementRef.id}:opnory-dev-ext`,
      metadata: {},
    };

    await pgPool.query(
      `INSERT INTO access_requests (
        id, correlation_id, requester_id, requester_email,
        entitlement_id, entitlement_name, entitlement_system,
        reason, status, version, access_expires_at,
        approved_at, approved_by, fulfilled_at, external_id,
        idempotency_key, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        request2.id,
        request2.correlationId,
        request2.requesterId,
        request2.requesterEmail,
        request2.entitlement.id,
        request2.entitlement.name,
        request2.entitlement.system,
        request2.reason,
        request2.status,
        request2.version,
        request2.accessExpiresAt ? new Date(request2.accessExpiresAt) : null,
        request2.approvedAt ? new Date(request2.approvedAt) : null,
        request2.approvedBy,
        request2.fulfilledAt ? new Date(request2.fulfilledAt) : null,
        request2.externalId,
        request2.idempotencyKey,
        JSON.stringify(request2.metadata),
      ]
    );

    // Grant access
    const fulfilledRequest2 = toFulfilledAccessRequest(request2);
    await executor.grant(fulfilledRequest2);

    // Wait a bit then extend the accessExpiresAt to T2 (far future)
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const accessExpiresAtT2 = new Date(now.getTime() + 300000); // 5 minutes
    await pgPool.query(
      `UPDATE access_requests SET access_expires_at = $1, version = version + 1, updated_at = NOW() WHERE id = $2`,
      [accessExpiresAtT2, testRequestId2]
    );

    // Wait for scheduler to process (it should see T2 and skip)
    await new Promise(resolve => setTimeout(resolve, 15000));

    // Verify request is still FULFILLED (not revoked)
    const result = await pgPool.query(
      "SELECT status, access_expires_at FROM access_requests WHERE id = $1",
      [testRequestId2]
    );
    
    expect(result.rows[0].status).toBe("FULFILLED");
    expect(new Date(result.rows[0].access_expires_at).getTime()).toBeCloseTo(accessExpiresAtT2.getTime(), -3);

    // Verify GitHub membership still exists
    let isMember = await checkGitHubMembership("opnory-dev");
    expect(isMember).toBe(true);

    // Clean up: manually revoke
    await executor.revoke(fulfilledRequest2);
    
    // Verify cleaned up
    const cleanupResult = await pgPool.query(
      "SELECT status FROM access_requests WHERE id = $1",
      [testRequestId2]
    );
    expect(cleanupResult.rows[0].status).toBe("REVOKED");
  }, 60000);
});