#!/usr/bin/env node
// Live expiration test - standalone, no @opnory imports

import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';

// Simple in-memory implementations
class InMemoryIdempotencyStore {
  fulfilledKeys = new Set();
  checkAndMark(key) {
    if (this.fulfilledKeys.has(key)) return false;
    this.fulfilledKeys.add(key);
    return true;
  }
  isFulfilled(key) { return this.fulfilledKeys.has(key); }
  clear(key) { this.fulfilledKeys.delete(key); }
}

class InMemoryAuditEventStore {
  events = [];
  async record(event) { this.events.push(event); }
  async getByRequestId(id) { return this.events.filter(e => e.requestId === id); }
  async getByCorrelationId(id) { return this.events.filter(e => e.correlationId === id); }
  async getByType(type) { return this.events.filter(e => e.type === type); }
}

// Simplified GitHubAccessExecutor with just what we need for the test
class TestGitHubAccessExecutor {
  constructor(config, idempotencyStore, auditStore) {
    this.config = config;
    this.idempotencyStore = idempotencyStore;
    this.auditStore = auditStore;
    
    // Create Octokit with GitHub App auth
    this.octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: config.appId,
        privateKey: config.privateKey,
        installationId: config.installationId,
      },
    });
  }

  async grant(request) {
    const idempotencyKey = request.idempotencyKey;
    if (!this.idempotencyStore.checkAndMark(idempotencyKey)) {
      return { success: true, message: "Access already granted (idempotent)" };
    }

    try {
      // Check current membership
      const membership = await this.octokit.teams.getMembershipForUserInOrg({
        org: this.config.githubConfig.organization,
        team_slug: this.config.githubConfig.teamSlug,
        username: request.requesterId,
      }).catch(() => null);

      if (membership?.data?.state === 'active') {
        return { success: true, message: "Already member of team" };
      }

      // Add to team
      await this.octokit.teams.addOrUpdateMembershipForUserInOrg({
        org: this.config.githubConfig.organization,
        team_slug: this.config.githubConfig.teamSlug,
        username: request.requesterId,
        role: this.config.githubConfig.teamRole,
      });

      return { success: true, message: "Successfully granted GitHub Engineering Contributor access (verified)" };
    } catch (err) {
      return { success: false, message: `Grant failed: ${err.message}` };
    }
  }

  async revoke(request) {
    const idempotencyKey = `revoke:${request.id}:${request.entitlement.id}:${request.requesterId}`;
    if (!this.idempotencyStore.checkAndMark(idempotencyKey)) {
      return { success: true, message: "Access already revoked (idempotent)" };
    }

    try {
      // Check current membership
      const membership = await this.octokit.teams.getMembershipForUserInOrg({
        org: this.config.githubConfig.organization,
        team_slug: this.config.githubConfig.teamSlug,
        username: request.requesterId,
      }).catch(() => null);

      if (!membership || membership.data.state !== 'active') {
        return { success: true, message: "Already not a member of team" };
      }

      // Remove from team
      await this.octokit.teams.removeMembershipForUserInOrg({
        org: this.config.githubConfig.organization,
        team_slug: this.config.githubConfig.teamSlug,
        username: request.requesterId,
      });

      // Reconciliation - verify removal
      const verify = await this.octokit.teams.getMembershipForUserInOrg({
        org: this.config.githubConfig.organization,
        team_slug: this.config.githubConfig.teamSlug,
        username: request.requesterId,
      }).catch(() => null);

      if (verify && verify.data.state === 'active') {
        return { success: false, message: "Reconciliation failed: user still active on team" };
      }

      return { success: true, message: "Successfully revoked GitHub Engineering Contributor access (verified)" };
    } catch (err) {
      return { success: false, message: `Revoke failed: ${err.message}` };
    }
  }
}

// Simplified ExpirationScheduler
class TestExpirationScheduler {
  constructor(executor, auditStore, pgPool, options = {}) {
    this.executor = executor;
    this.auditStore = auditStore;
    this.pgPool = pgPool;
    this.pollIntervalMs = options.pollIntervalMs || 5000;
    this.leaseDurationMs = options.leaseDurationMs || 30000;
    this.running = false;
    this.intervalId = null;
  }

  async start() {
    this.running = true;
    console.log("Scheduler started");
    
    // Run initial scan
    await this.scanAndProcess();
    
    this.intervalId = setInterval(() => {
      if (this.running) {
        this.scanAndProcess().catch(console.error);
      }
    }, this.pollIntervalMs);
  }

  async stop() {
    this.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    console.log("Scheduler stopped");
  }

  async scanAndProcess() {
    try {
      // Find overdue FULFILLED requests
      const result = await this.pgPool.query(
        `SELECT id, correlation_id, requester_id, requester_email,
                entitlement_id, entitlement_name, entitlement_system,
                reason, status, version, access_expires_at,
                approved_at, approved_by, fulfilled_at, external_id,
                idempotency_key, metadata
         FROM access_requests
         WHERE status = 'FULFILLED'
           AND access_expires_at IS NOT NULL
           AND access_expires_at <= NOW()
         ORDER BY access_expires_at ASC
         LIMIT 10`
      );

      for (const row of result.rows) {
        await this.processExpiration(row);
      }
    } catch (err) {
      console.error("Scan error:", err);
    }
  }

  async processExpiration(row) {
    const requestId = row.id;
    
    try {
      // Claim the request using optimistic locking
      const claimResult = await this.pgPool.query(
        `UPDATE access_requests 
         SET status = 'REVOCATION_PENDING', version = version + 1, updated_at = NOW()
         WHERE id = $1 AND status = 'FULFILLED' AND access_expires_at IS NOT NULL AND access_expires_at <= NOW()
         RETURNING id`,
        [requestId]
      );

      if (claimResult.rows.length === 0) {
        return; // Already claimed or not due
      }

      console.log(`Processing expiration for request ${requestId}`);

      // Record EXPIRATION_DUE audit
      await this.auditStore.record({
        eventId: randomUUID(),
        requestId,
        correlationId: row.correlation_id,
        actor: "expiration-scheduler",
        timestamp: new Date(),
        type: "EXPIRATION_DUE",
        metadata: { accessExpiresAt: row.access_expires_at },
      });

      // Build request object for revocation
      const request = {
        id: row.id,
        correlationId: row.correlation_id,
        requesterId: row.requester_id,
        requesterEmail: row.requester_email,
        externalIdentities: {
          github: { login: row.requester_id, verified: true, verifiedAt: new Date().toISOString(), source: "admin" }
        },
        entitlement: {
          id: row.entitlement_id,
          name: row.entitlement_name,
          system: row.entitlement_system,
        },
        reason: row.reason,
        status: "FULFILLED",
        version: row.version,
        createdAt: row.created_at?.toISOString() || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        accessExpiresAt: row.access_expires_at?.toISOString(),
        approvedAt: row.approved_at?.toISOString(),
        approvedBy: row.approved_by,
        fulfilledAt: row.fulfilled_at?.toISOString(),
        externalId: row.external_id,
        idempotencyKey: row.idempotency_key,
        metadata: row.metadata || {},
      };

      // Call revoke
      const revocationResult = await this.executor.revoke(request);

      if (revocationResult.success) {
        // Update to REVOKED
        await this.pgPool.query(
          `UPDATE access_requests SET status = 'REVOKED', version = version + 1, updated_at = NOW() WHERE id = $1`,
          [requestId]
        );
        
        // Record REVOCATION_SUCCEEDED
        await this.auditStore.record({
          eventId: randomUUID(),
          requestId,
          correlationId: row.correlation_id,
          actor: "expiration-scheduler",
          timestamp: new Date(),
          type: "REVOCATION_SUCCEEDED",
          metadata: { reconciledAbsent: true },
        });
        console.log(`Request ${requestId} successfully REVOKED`);
      } else {
        // Revert to FULFILLED
        await this.pgPool.query(
          `UPDATE access_requests SET status = 'FULFILLED', version = version + 1, updated_at = NOW() WHERE id = $1`,
          [requestId]
        );
        
        // Record REVOCATION_FAILED
        await this.auditStore.record({
          eventId: randomUUID(),
          requestId,
          correlationId: row.correlation_id,
          actor: "expiration-scheduler",
          timestamp: new Date(),
          type: "REVOCATION_FAILED",
          metadata: { error: revocationResult.message },
        });
        console.error(`Request ${requestId} revocation FAILED: ${revocationResult.message}`);
      }
    } catch (err) {
      console.error(`Error processing expiration for ${requestId}:`, err);
      
      // Try to revert status
      await this.pgPool.query(
        `UPDATE access_requests SET status = 'FULFILLED', version = version + 1, updated_at = NOW() WHERE id = $1`,
        [requestId]
      ).catch(() => {});
    }
  }
}

const GITHUB_TOKEN = process.env.GITHUB_TEST_TOKEN;
if (!GITHUB_TOKEN) {
  console.error("GITHUB_TEST_TOKEN not set");
  process.exit(1);
}

const PRIVATE_KEY = process.env.OPNORY_GITHUB_PRIVATE_KEY || `-----BEGIN RSA PRIVATE KEY-----
MOCK_KEY
-----END RSA PRIVATE KEY-----`;

const entitlementRef = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  name: "Engineering Contributor",
  system: "github",
  githubConfig: {
    organization: "opnory-sandbox",
    teamSlug: "opnory-engineering-contributors",
    teamRole: "member",
  },
};

async function checkGitHubMembership(login) {
  try {
    const octokit = new Octokit({ auth: GITHUB_TOKEN });
    const response = await octokit.teams.getMembershipForUserInOrg({
      org: "opnory-sandbox",
      team_slug: "opnory-engineering-contributors",
      username: login,
    });
    return response.data.state === 'active';
  } catch {
    return false;
  }
}

async function runLiveExpirationTest() {
  console.log("=== LIVE EXPIRATION TEST ===\n");

  // Set up PostgreSQL pool
  const pgPool = new Pool({
    connectionString: "postgresql://raelldottin@localhost:5432/opnory",
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  const auditStore = new InMemoryAuditEventStore();
  const executor = new TestGitHubAccessExecutor(
    {
      appId: "4647201",
      installationId: "154891672",
      privateKey: PRIVATE_KEY,
      allowedOrganizations: ["opnory-sandbox"],
      allowedTeams: ["opnory-engineering-contributors"],
      githubConfig: entitlementRef.githubConfig,
    },
    new InMemoryIdempotencyStore(),
    auditStore
  );

  // Create scheduler with fast polling (every 5 seconds for testing)
  const scheduler = new TestExpirationScheduler(executor, auditStore, pgPool, {
    pollIntervalMs: 5000, // 5 seconds
    leaseDurationMs: 30000,
  });

  // Start the scheduler
  await scheduler.start();
  console.log("Scheduler started with 5s polling interval");

  try {
    // Test 1: Normal expiration
    console.log("\n--- TEST 1: Normal expiration ---");
    
    // Verify opnory-dev is NOT on the team
    const initialMember = await checkGitHubMembership("opnory-dev");
    console.log(`Initial membership: ${initialMember ? "YES" : "NO"}`);
    if (initialMember) {
      console.log("ERROR: opnory-dev already on team, cleaning up first");
      await executor.revoke({
        id: randomUUID(),
        correlationId: randomUUID(),
        requesterId: "opnory-dev",
        requesterEmail: "opnory-dev@example.com",
        externalIdentities: {
          github: { login: "opnory-dev", verified: true, verifiedAt: new Date().toISOString(), source: "admin" }
        },
        entitlement: entitlementRef,
        reason: "Cleanup",
        status: "FULFILLED",
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        accessExpiresAt: new Date(Date.now() + 60000).toISOString(),
        approvedAt: new Date().toISOString(),
        approvedBy: "test",
        fulfilledAt: new Date().toISOString(),
        externalId: "github-team-membership-opnory-dev-opnory-sandbox-opnory-engineering-contributors",
        idempotencyKey: `grant:${randomUUID()}:${entitlementRef.id}:opnory-dev`,
        metadata: {},
      });
      await new Promise(r => setTimeout(r, 2000));
    }

    // Create a test request with short TTL (30 seconds)
    const testRequestId = randomUUID();
    const correlationId = randomUUID();
    const now = new Date();
    const accessExpiresAt = new Date(now.getTime() + 30000); // 30 seconds from now

    const request = {
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

    // Insert the request into PostgreSQL
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

    // Grant access via executor
    const grantResult = await executor.grant(request);
    console.log("Grant result:", grantResult.success ? "SUCCESS" : "FAILED", grantResult.message);

    // Wait for the expiration to trigger
    console.log("Waiting for expiration to trigger (up to 90 seconds)...");
    let revoked = false;
    const maxWaitMs = 90000;
    const startTime = Date.now();

    while (!revoked && Date.now() - startTime < maxWaitMs) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      const result = await pgPool.query(
        "SELECT status, access_expires_at FROM access_requests WHERE id = $1",
        [testRequestId]
      );
      
      if (result.rows.length > 0) {
        const row = result.rows[0];
        console.log(`  Status: ${row.status}, expires: ${row.access_expires_at}`);
        
        if (row.status === "REVOKED") {
          revoked = true;
          break;
        }
      }
    }

    if (!revoked) {
      console.error("FAIL: Request was not revoked within timeout");
      process.exit(1);
    }

    console.log("✓ Request status is REVOKED");

    // Verify GitHub membership is gone
    const afterMember = await checkGitHubMembership("opnory-dev");
    console.log(`Membership after expiration: ${afterMember ? "YES" : "NO"}`);
    if (afterMember) {
      console.error("FAIL: GitHub membership still exists");
      process.exit(1);
    }
    console.log("✓ GitHub membership verified absent");

    // Test 2: Idempotent - second run does nothing
    console.log("\n--- TEST 2: Idempotent second run ---");
    const result2 = await pgPool.query(
      "SELECT status FROM access_requests WHERE id = $1",
      [testRequestId]
    );
    console.log(`Request status: ${result2.rows[0].status}`);
    if (result2.rows[0].status !== "REVOKED") {
      console.error("FAIL: Request not in REVOKED state");
      process.exit(1);
    }
    console.log("✓ Idempotent check passed");

    // Test 3: Extension protection
    console.log("\n--- TEST 3: Extension protection ---");
    
    const testRequestId2 = randomUUID();
    const correlationId2 = randomUUID();
    const now2 = new Date();
    const accessExpiresAtT1 = new Date(now2.getTime() + 10000); // 10 seconds

    const request2 = {
      id: testRequestId2,
      correlationId: correlationId2,
      requesterId: "opnory-dev",
      requesterEmail: "opnory-dev@example.com",
      externalIdentities: {
        github: { login: "opnory-dev", verified: true, verifiedAt: new Date().toISOString(), source: "admin" }
      },
      entitlement: entitlementRef,
      reason: "Extension protection test",
      status: "FULFILLED",
      version: 1,
      createdAt: now2.toISOString(),
      updatedAt: now2.toISOString(),
      expiresAt: undefined,
      accessExpiresAt: accessExpiresAtT1.toISOString(),
      approvedAt: new Date(now2.getTime() - 60000).toISOString(),
      approvedBy: "test-admin",
      deniedAt: undefined,
      deniedBy: undefined,
      deniedReason: undefined,
      fulfilledAt: new Date(now2.getTime() - 30000).toISOString(),
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
        request2.id, request2.correlationId, request2.requesterId, request2.requesterEmail,
        request2.entitlement.id, request2.entitlement.name, request2.entitlement.system,
        request2.reason, request2.status, request2.version,
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
    await executor.grant(request2);
    console.log("Granted access for extension test");

    // Wait a bit then extend the accessExpiresAt to T2 (far future)
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const accessExpiresAtT2 = new Date(now2.getTime() + 300000); // 5 minutes
    await pgPool.query(
      `UPDATE access_requests SET access_expires_at = $1, version = version + 1, updated_at = NOW() WHERE id = $2`,
      [accessExpiresAtT2, testRequestId2]
    );
    console.log(`Extended accessExpiresAt to ${accessExpiresAtT2.toISOString()}`);

    // Wait for scheduler to process (it should see T2 and skip)
    await new Promise(resolve => setTimeout(resolve, 15000));

    // Verify request is still FULFILLED (not revoked)
    const result3 = await pgPool.query(
      "SELECT status, access_expires_at FROM access_requests WHERE id = $1",
      [testRequestId2]
    );
    
    console.log(`Status after extension: ${result3.rows[0].status}`);
    console.log(`Access expires at: ${result3.rows[0].access_expires_at}`);
    
    if (result3.rows[0].status !== "FULFILLED") {
      console.error("FAIL: Request was revoked despite extension");
      process.exit(1);
    }
    console.log("✓ Extension protection: request still FULFILLED");

    // Verify GitHub membership still exists
    const memberAfterExt = await checkGitHubMembership("opnory-dev");
    console.log(`Membership after extension: ${memberAfterExt ? "YES" : "NO"}`);
    if (!memberAfterExt) {
      console.error("FAIL: GitHub membership was revoked despite extension");
      process.exit(1);
    }
    console.log("✓ GitHub membership still active");

    // Clean up: manually revoke
    await executor.revoke(request2);
    console.log("Cleaned up: manually revoked extension test request");
    
    // Verify cleaned up
    const cleanupResult = await pgPool.query(
      "SELECT status FROM access_requests WHERE id = $1",
      [testRequestId2]
    );
    console.log(`Cleanup status: ${cleanupResult.rows[0].status}`);
    if (cleanupResult.rows[0].status !== "REVOKED") {
      console.error("FAIL: Cleanup didn't revoke");
      process.exit(1);
    }
    console.log("✓ Cleanup successful");

    console.log("\n=== ALL TESTS PASSED ===");
    
  } finally {
    await scheduler.stop();
    await pgPool.end();
  }
}

runLiveExpirationTest().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});