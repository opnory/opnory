#!/usr/bin/env node
/**
 * Expiration Operations CLI
 * 
 * Manual recovery commands for the expiration scheduler:
 * - expiration status <entitlement-id|request-id>  - Show status of an expiration
 * - expiration retry <entitlement-id|request-id>   - Manually retry a failed expiration
 * - expiration reconcile <entitlement-id|request-id> - Force reconciliation check
 * - expiration list-overdue                        - List all overdue/failed expirations
 * - expiration metrics                             - Show scheduler health metrics
 */

import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';

// ============================================================================
// Configuration
// ============================================================================

const GITHUB_TOKEN = process.env.GITHUB_TEST_TOKEN || process.env.GITHUB_TOKEN;
const PRIVATE_KEY = process.env.OPNORY_GITHUB_PRIVATE_KEY;
const APP_ID = process.env.OPNORY_GITHUB_APP_ID || "4647201";
const INSTALLATION_ID = process.env.OPNORY_GITHUB_INSTALLATION_ID || "154891672";
const DATABASE_URL = process.env.DATABASE_URL || "postgresql://raelldottin@localhost:5432/opnory";

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

if (!GITHUB_TOKEN) {
  console.error("Error: GITHUB_TEST_TOKEN or GITHUB_TOKEN environment variable required");
  process.exit(1);
}

if (!PRIVATE_KEY) {
  console.error("Error: OPNORY_GITHUB_PRIVATE_KEY environment variable required");
  process.exit(1);
}

// ============================================================================
// Database Pool
// ============================================================================

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// ============================================================================
// GitHub Client
// ============================================================================

const octokit = new Octokit({
  authStrategy: createAppAuth,
  auth: {
    appId: parseInt(APP_ID),
    privateKey: PRIVATE_KEY,
    installationId: parseInt(INSTALLATION_ID),
  },
});

// ============================================================================
// Helpers
// ============================================================================

async function findRequestByIdOrEntitlement(id) {
  // First try as request ID (UUID)
  let result = await pool.query(
    "SELECT * FROM access_requests WHERE id = $1",
    [id]
  );
  
  if (result.rows.length > 0) {
    return result.rows[0];
  }
  
  // Then try as entitlement ID - find latest request for that entitlement
  result = await pool.query(
    `SELECT * FROM access_requests 
     WHERE entitlement_id = $1 
     ORDER BY created_at DESC 
     LIMIT 1`,
    [id]
  );
  
  if (result.rows.length > 0) {
    return result.rows[0];
  }
  
  return null;
}

function mapRowToRequest(row) {
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
    status: row.status,
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
    expirationAttemptCount: row.expiration_attempt_count ?? 0,
    expirationNextAttemptAt: row.expiration_next_attempt_at?.toISOString(),
    expirationMaxRetries: row.expiration_max_retries ?? 3,
    expirationLastError: row.expiration_last_error,
    expirationLastAttemptAt: row.expiration_last_attempt_at?.toISOString(),
  };
}

async function checkGitHubMembership(login) {
  try {
    const response = await octokit.teams.getMembershipForUserInOrg({
      org: entitlementRef.githubConfig.organization,
      team_slug: entitlementRef.githubConfig.teamSlug,
      username: login,
    });
    return { exists: response.data.state === 'active', state: response.data.state };
  } catch (err) {
    if (err.status === 404) {
      return { exists: false, state: 'not_found' };
    }
    throw err;
  }
}

async function revokeViaGitHub(login) {
  try {
    await octokit.teams.removeMembershipForUserInOrg({
      org: entitlementRef.githubConfig.organization,
      team_slug: entitlementRef.githubConfig.teamSlug,
      username: login,
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function reconcileMembership(login) {
  const membership = await checkGitHubMembership(login);
  return membership.exists ? { active: true } : { active: false };
}

// ============================================================================
// Commands
// ============================================================================

async function cmdStatus(args) {
  const id = args[0];
  if (!id) {
    console.error("Usage: expiration status <request-id|entitlement-id>");
    process.exit(1);
  }

  const row = await findRequestByIdOrEntitlement(id);
  if (!row) {
    console.error(`No request found for: ${id}`);
    process.exit(1);
  }

  const request = mapRowToRequest(row);
  const membership = await checkGitHubMembership(request.requesterId);

  console.log("=== Expiration Status ===");
  console.log(`Request ID:        ${request.id}`);
  console.log(`Correlation ID:    ${request.correlationId}`);
  console.log(`Requester:         ${request.requesterId} (${request.requesterEmail})`);
  console.log(`Entitlement:       ${request.entitlement.name} (${request.entitlement.id})`);
  console.log(`Status:            ${request.status}`);
  console.log(`Version:           ${request.version}`);
  console.log(`Created:           ${request.createdAt}`);
  console.log(`Updated:           ${request.updatedAt}`);
  console.log(`Approved:          ${request.approvedAt || 'N/A'} by ${request.approvedBy || 'N/A'}`);
  console.log(`Fulfilled:         ${request.fulfilledAt || 'N/A'}`);
  console.log(`Access Expires:    ${request.accessExpiresAt || 'N/A'}`);
  console.log(`External ID:       ${request.externalId || 'N/A'}`);
  console.log(`Idempotency Key:   ${request.idempotencyKey}`);
  console.log("");
  console.log("=== Retry State ===");
  console.log(`Attempt Count:     ${request.expirationAttemptCount}`);
  console.log(`Max Retries:       ${request.expirationMaxRetries}`);
  console.log(`Next Attempt At:   ${request.expirationNextAttemptAt || 'N/A'}`);
  console.log(`Last Attempt At:   ${request.expirationLastAttemptAt || 'N/A'}`);
  console.log(`Last Error:        ${request.expirationLastError || 'N/A'}`);
  console.log("");
  console.log("=== GitHub Reconciliation ===");
  console.log(`Membership:        ${membership.exists ? 'ACTIVE' : 'ABSENT'} (${membership.state})`);
  console.log(`Team:              ${entitlementRef.githubConfig.teamSlug}`);
  console.log(`Org:               ${entitlementRef.githubConfig.organization}`);
  console.log(`Role:              ${entitlementRef.githubConfig.teamRole}`);
}

async function cmdRetry(args) {
  const id = args[0];
  if (!id) {
    console.error("Usage: expiration retry <request-id|entitlement-id>");
    process.exit(1);
  }

  const row = await findRequestByIdOrEntitlement(id);
  if (!row) {
    console.error(`No request found for: ${id}`);
    process.exit(1);
  }

  const request = mapRowToRequest(row);
  
  if (request.status === 'REVOKED') {
    console.log("Request is already REVOKED - nothing to retry");
    return;
  }

  if (request.status !== 'FULFILLED' && request.status !== 'EXPIRATION_FAILED') {
    console.error(`Cannot retry request in status: ${request.status}. Must be FULFILLED or EXPIRATION_FAILED`);
    process.exit(1);
  }

  console.log(`Retrying expiration for request ${request.id}...`);

  // Reset retry fields and set nextAttemptAt to now
  await pool.query(
    `UPDATE access_requests 
     SET status = 'FULFILLED',
         version = version + 1,
         updated_at = NOW(),
         expiration_attempt_count = 0,
         expiration_next_attempt_at = NOW(),
         expiration_last_error = NULL,
         expiration_last_attempt_at = NULL
     WHERE id = $1`,
    [request.id]
  );

  console.log("✓ Request reset for immediate retry");
  console.log("  The scheduler will pick it up on the next poll cycle");
}

async function cmdReconcile(args) {
  const id = args[0];
  if (!id) {
    console.error("Usage: expiration reconcile <request-id|entitlement-id>");
    process.exit(1);
  }

  const row = await findRequestByIdOrEntitlement(id);
  if (!row) {
    console.error(`No request found for: ${id}`);
    process.exit(1);
  }

  const request = mapRowToRequest(row);
  console.log(`Reconciling membership for ${request.requesterId}...`);

  const membership = await checkGitHubMembership(request.requesterId);
  
  console.log(`GitHub membership: ${membership.exists ? 'ACTIVE' : 'ABSENT'} (${membership.state})`);

  if (request.status === 'FULFILLED' && !membership.exists) {
    console.log("⚠️  Request is FULFILLED but GitHub membership is absent!");
    console.log("   This indicates the expiration was processed but not recorded.");
    
    // Auto-correct the database
    await pool.query(
      `UPDATE access_requests 
       SET status = 'REVOKED', version = version + 1, updated_at = NOW()
       WHERE id = $1`,
      [request.id]
    );
    console.log("✓ Database corrected to REVOKED");
  } else if (request.status === 'REVOKED' && membership.exists) {
    console.log("⚠️  Request is REVOKED but GitHub membership is still active!");
    console.log("   This indicates a reconciliation gap.");
  } else {
    console.log("✓ State is consistent");
  }
}

async function cmdListOverdue(args) {
  const result = await pool.query(
    `SELECT 
       id, requester_id, entitlement_id, status, access_expires_at,
       expiration_attempt_count, expiration_max_retries, expiration_next_attempt_at,
       expiration_last_error, expiration_last_attempt_at, updated_at
     FROM access_requests
     WHERE 
       (status = 'FULFILLED' AND access_expires_at IS NOT NULL AND access_expires_at <= NOW())
       OR (status = 'FULFILLED' AND expiration_next_attempt_at IS NOT NULL AND expiration_next_attempt_at <= NOW())
       OR status = 'EXPIRATION_FAILED'
     ORDER BY 
       COALESCE(access_expires_at, expiration_next_attempt_at) ASC
     LIMIT 100`
  );

  if (result.rows.length === 0) {
    console.log("No overdue or failed expirations found.");
    return;
  }

  console.log(`=== Overdue/Failed Expirations (${result.rows.length}) ===`);
  console.log("");

  for (const row of result.rows) {
    const isRetry = !!row.expiration_next_attempt_at;
    const dueTime = isRetry ? row.expiration_next_attempt_at : row.access_expires_at;
    const overdueMs = Date.now() - new Date(dueTime).getTime();
    const overdueStr = overdueMs > 0 ? `${Math.round(overdueMs / 1000 / 60)}min ago` : "not yet due";
    
    console.log(`Request: ${row.id}`);
    console.log(`  Requester:      ${row.requester_id}`);
    console.log(`  Entitlement:    ${row.entitlement_id}`);
    console.log(`  Status:         ${row.status}`);
    console.log(`  Due:            ${dueTime} (${overdueStr})`);
    console.log(`  Attempts:       ${row.expiration_attempt_count}/${row.expiration_max_retries}`);
    console.log(`  Next Retry:     ${row.expiration_next_attempt_at || 'N/A'}`);
    console.log(`  Last Attempt:   ${row.expiration_last_attempt_at || 'N/A'}`);
    console.log(`  Last Error:     ${row.expiration_last_error || 'N/A'}`);
    console.log(`  Updated:        ${row.updated_at}`);
    console.log("");
  }
}

async function cmdMetrics(args) {
  // Get various metrics
  const overdue = await pool.query(
    `SELECT COUNT(*) as count FROM access_requests
     WHERE (status = 'FULFILLED' AND access_expires_at IS NOT NULL AND access_expires_at <= NOW())
        OR (status = 'FULFILLED' AND expiration_next_attempt_at IS NOT NULL AND expiration_next_attempt_at <= NOW())`
  );

  const oldestOverdue = await pool.query(
    `SELECT MIN(COALESCE(access_expires_at, expiration_next_attempt_at)) as oldest
     FROM access_requests
     WHERE (status = 'FULFILLED' AND access_expires_at IS NOT NULL AND access_expires_at <= NOW())
        OR (status = 'FULFILLED' AND expiration_next_attempt_at IS NOT NULL AND expiration_next_attempt_at <= NOW())`
  );

  const failed = await pool.query(
    `SELECT COUNT(*) as count FROM access_requests WHERE status = 'EXPIRATION_FAILED'`
  );

  const revoked = await pool.query(
    `SELECT COUNT(*) as count FROM access_requests WHERE status = 'REVOKED'`
  );

  const byAttempt = await pool.query(
    `SELECT expiration_attempt_count, COUNT(*) as count 
     FROM access_requests 
     WHERE expiration_attempt_count > 0
     GROUP BY expiration_attempt_count
     ORDER BY expiration_attempt_count`
  );

  console.log("=== Scheduler Health Metrics ===");
  console.log(`Overdue Expirations:    ${overdue.rows[0].count}`);
  console.log(`Terminal Failures:      ${failed.rows[0].count}`);
  console.log(`Total Revoked:          ${revoked.rows[0].count}`);
  console.log(`Oldest Overdue:         ${oldestOverdue.rows[0].oldest || 'N/A'}`);
  console.log("");
  console.log("=== Retry Distribution ===");
  for (const row of byAttempt.rows) {
    console.log(`  Attempt ${row.expiration_attempt_count}: ${row.count} requests`);
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const [,, command, ...args] = process.argv;

  try {
    switch (command) {
      case 'status':
        await cmdStatus(args);
        break;
      case 'retry':
        await cmdRetry(args);
        break;
      case 'reconcile':
        await cmdReconcile(args);
        break;
      case 'list-overdue':
        await cmdListOverdue(args);
        break;
      case 'metrics':
        await cmdMetrics(args);
        break;
      default:
        console.log("Expiration Operations CLI");
        console.log("");
        console.log("Usage:");
        console.log("  expiration status <request-id|entitlement-id>    Show detailed status");
        console.log("  expiration retry <request-id|entitlement-id>     Manually retry failed expiration");
        console.log("  expiration reconcile <request-id|entitlement-id> Force reconciliation check");
        console.log("  expiration list-overdue                          List all overdue/failed");
        console.log("  expiration metrics                               Show scheduler health metrics");
        console.log("");
        console.log("Environment:");
        console.log("  GITHUB_TEST_TOKEN        GitHub token for API calls");
        console.log("  OPNORY_GITHUB_PRIVATE_KEY  GitHub App private key (PEM)");
        console.log("  OPNORY_GITHUB_APP_ID       GitHub App ID (default: 4647201)");
        console.log("  OPNORY_GITHUB_INSTALLATION_ID Installation ID (default: 154891672)");
        console.log("  DATABASE_URL               PostgreSQL connection string");
        process.exit(1);
    }
  } catch (err) {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();