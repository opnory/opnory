#!/usr/bin/env tsx
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Live expiration test - run directly with tsx
const index_js_1 = require("./packages/access-executor/src/index.js");
const index_js_2 = require("./packages/access-audit/src/index.js");
const expiration_scheduler_js_1 = require("./packages/access-store-pg/src/expiration-scheduler.js");
const index_js_3 = require("./packages/access-types/src/index.js");
const pg_1 = require("pg");
const crypto_1 = require("crypto");
const GITHUB_TOKEN = process.env.GITHUB_TEST_TOKEN;
if (!GITHUB_TOKEN) {
    console.error("GITHUB_TEST_TOKEN not set");
    process.exit(1);
}
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
        const response = await fetch(`https://api.github.com/orgs/opnory-sandbox/teams/opnory-engineering-contributors/memberships/${login}`, {
            headers: {
                Authorization: `Bearer ${GITHUB_TOKEN}`,
                Accept: "application/vnd.github+json",
            },
        });
        return response.status === 200;
    }
    catch {
        return false;
    }
}
async function runLiveExpirationTest() {
    console.log("=== LIVE EXPIRATION TEST ===\n");
    // Set up PostgreSQL pool
    const pgPool = new pg_1.Pool({
        connectionString: "postgresql://raelldottin@localhost:5432/opnory",
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    });
    const auditStore = new index_js_2.InMemoryAuditEventStore();
    const executor = new index_js_1.GitHubAccessExecutor({
        appId: "4647201",
        installationId: "154891672",
        privateKey: process.env.OPNORY_GITHUB_PRIVATE_KEY || "-----BEGIN RSA PRIVATE KEY-----\nMOCK_KEY\n-----END RSA PRIVATE KEY-----",
        allowedOrganizations: ["opnory-sandbox"],
        allowedTeams: ["opnory-engineering-contributors"],
    }, new index_js_1.InMemoryIdempotencyStore(), auditStore);
    // Create scheduler with fast polling (every 5 seconds for testing)
    const scheduler = new expiration_scheduler_js_1.ExpirationScheduler(executor, auditStore, pgPool, {
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
                id: (0, crypto_1.randomUUID)(),
                correlationId: (0, crypto_1.randomUUID)(),
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
                idempotencyKey: `grant:${(0, crypto_1.randomUUID)()}:${entitlementRef.id}:opnory-dev`,
                metadata: {},
            });
            await new Promise(r => setTimeout(r, 2000));
        }
        // Create a test request with short TTL (30 seconds)
        const testRequestId = (0, crypto_1.randomUUID)();
        const correlationId = (0, crypto_1.randomUUID)();
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
        await pgPool.query(`INSERT INTO access_requests (
        id, correlation_id, requester_id, requester_email,
        entitlement_id, entitlement_name, entitlement_system,
        reason, status, version, access_expires_at,
        approved_at, approved_by, fulfilled_at, external_id,
        idempotency_key, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`, [
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
        ]);
        console.log(`Created test request ${testRequestId} with expiry at ${accessExpiresAt.toISOString()}`);
        // Grant access via executor
        const fulfilledRequest = (0, index_js_3.toFulfilledAccessRequest)(request);
        const grantResult = await executor.grant(fulfilledRequest);
        console.log("Grant result:", grantResult.success ? "SUCCESS" : "FAILED", grantResult.message);
        // Wait for the expiration to trigger
        console.log("Waiting for expiration to trigger (up to 90 seconds)...");
        let revoked = false;
        const maxWaitMs = 90000;
        const startTime = Date.now();
        while (!revoked && Date.now() - startTime < maxWaitMs) {
            await new Promise(resolve => setTimeout(resolve, 5000));
            const result = await pgPool.query("SELECT status, access_expires_at FROM access_requests WHERE id = $1", [testRequestId]);
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
        const result2 = await pgPool.query("SELECT status FROM access_requests WHERE id = $1", [testRequestId]);
        console.log(`Request status: ${result2.rows[0].status}`);
        if (result2.rows[0].status !== "REVOKED") {
            console.error("FAIL: Request not in REVOKED state");
            process.exit(1);
        }
        console.log("✓ Idempotent check passed");
        // Test 3: Extension protection
        console.log("\n--- TEST 3: Extension protection ---");
        const testRequestId2 = (0, crypto_1.randomUUID)();
        const correlationId2 = (0, crypto_1.randomUUID)();
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
        await pgPool.query(`INSERT INTO access_requests (
        id, correlation_id, requester_id, requester_email,
        entitlement_id, entitlement_name, entitlement_system,
        reason, status, version, access_expires_at,
        approved_at, approved_by, fulfilled_at, external_id,
        idempotency_key, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`, [
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
        ]);
        // Grant access
        const fulfilledRequest2 = (0, index_js_3.toFulfilledAccessRequest)(request2);
        await executor.grant(fulfilledRequest2);
        console.log("Granted access for extension test");
        // Wait a bit then extend the accessExpiresAt to T2 (far future)
        await new Promise(resolve => setTimeout(resolve, 2000));
        const accessExpiresAtT2 = new Date(now2.getTime() + 300000); // 5 minutes
        await pgPool.query(`UPDATE access_requests SET access_expires_at = $1, version = version + 1, updated_at = NOW() WHERE id = $2`, [accessExpiresAtT2, testRequestId2]);
        console.log(`Extended accessExpiresAt to ${accessExpiresAtT2.toISOString()}`);
        // Wait for scheduler to process (it should see T2 and skip)
        await new Promise(resolve => setTimeout(resolve, 15000));
        // Verify request is still FULFILLED (not revoked)
        const result3 = await pgPool.query("SELECT status, access_expires_at FROM access_requests WHERE id = $1", [testRequestId2]);
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
        await executor.revoke(fulfilledRequest2);
        console.log("Cleaned up: manually revoked extension test request");
        // Verify cleaned up
        const cleanupResult = await pgPool.query("SELECT status FROM access_requests WHERE id = $1", [testRequestId2]);
        console.log(`Cleanup status: ${cleanupResult.rows[0].status}`);
        if (cleanupResult.rows[0].status !== "REVOKED") {
            console.error("FAIL: Cleanup didn't revoke");
            process.exit(1);
        }
        console.log("✓ Cleanup successful");
        console.log("\n=== ALL TESTS PASSED ===");
    }
    finally {
        await scheduler.stop();
        await pgPool.end();
    }
}
runLiveExpirationTest().catch(err => {
    console.error("Test failed:", err);
    process.exit(1);
});
//# sourceMappingURL=run-live-expiration.js.map