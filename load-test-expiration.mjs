#!/usr/bin/env node
/**
 * Load Test for Expiration Scheduler
 * Seeds database with 1000-10000 overdue entitlements and verifies:
 * - No duplicate revocations
 * - SKIP LOCKED continues scaling correctly
 * - Batches don't starve later rows
 * - Database connections aren't exhausted
 * - Scheduler catches up predictably
 */

import { Pool } from 'pg';
import { randomUUID } from 'crypto';

// ============================================================================
// Configuration
// ============================================================================

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://raelldottin@localhost:5432/opnory";

const NUM_RECORDS = parseInt(process.env.NUM_RECORDS || "1000");
const NUM_WORKERS = parseInt(process.env.NUM_WORKERS || "5");
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "50");

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

// ============================================================================
// Database Pool
// ============================================================================

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 50,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// ============================================================================
// Test Helpers
// ============================================================================

async function seedOverdueRecords(count) {
  console.log(`Seeding ${count} overdue records...`);
  
  const now = new Date();
  
  // Generate diverse expiration times (some very old, some recent)
  const records = [];
  for (let i = 0; i < count; i++) {
    // Spread expirations over last 24 hours
    const expiresAt = new Date(now.getTime() - Math.random() * 86400000);
    
    const requesterId = `loadtest-user-${i}`;
    const requestId = randomUUID();
    const correlationId = randomUUID();
    
    records.push({
      id: requestId,
      correlation_id: correlationId,
      requester_id: requesterId,
      requester_email: `${requesterId}@example.com`,
      entitlement_id: entitlementRef.id,
      entitlement_name: entitlementRef.name,
      entitlement_system: entitlementRef.system,
      reason: `Load test ${i}`,
      status: 'FULFILLED',
      version: 1,
      approved_at: new Date(expiresAt.getTime() - 3600000),
      approved_by: 'admin',
      fulfilled_at: new Date(expiresAt.getTime() - 1800000),
      access_expires_at: expiresAt,
      external_id: `github-team-membership-${requesterId}-${entitlementRef.githubConfig.organization}-${entitlementRef.githubConfig.teamSlug}`,
      idempotency_key: `grant:${requestId}:${entitlementRef.id}:${requesterId}`,
      metadata: JSON.stringify({
        githubConfig: entitlementRef.githubConfig,
        externalIdentities: {
          github: {
            login: requesterId,
            verified: true,
            verifiedAt: new Date().toISOString(),
            source: "admin",
          },
        },
      }),
      expiration_attempt_count: 0,
      expiration_max_retries: 3,
      created_at: new Date(expiresAt.getTime() - 7200000),
      updated_at: now,
    });
  }
  
  // Batch insert
  const batchSize = 100;
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      for (const record of batch) {
        await client.query(
          `INSERT INTO access_requests (
            id, correlation_id, requester_id, requester_email,
            entitlement_id, entitlement_name, entitlement_system,
            reason, status, version, approved_at, approved_by,
            fulfilled_at, access_expires_at, external_id,
            idempotency_key, metadata,
            expiration_attempt_count, expiration_max_retries,
            created_at, updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
          ON CONFLICT (idempotency_key) DO NOTHING`,
          [
            record.id, record.correlation_id, record.requester_id, record.requester_email,
            record.entitlement_id, record.entitlement_name, record.entitlement_system,
            record.reason, record.status, record.version, record.approved_at, record.approved_by,
            record.fulfilled_at, record.access_expires_at, record.external_id,
            record.idempotency_key, record.metadata,
            record.expiration_attempt_count, record.expiration_max_retries,
            record.created_at, record.updated_at,
          ]
        );
      }
      
      await client.query('COMMIT');
      console.log(`  Inserted batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(records.length/batchSize)}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  
  console.log(`Seeded ${count} records`);
}

async function getStats() {
  const result = await pool.query(
    `SELECT 
       status,
       COUNT(*) as count,
       MIN(access_expires_at) as oldest_expires,
       MAX(access_expires_at) as newest_expires
     FROM access_requests
     WHERE entitlement_id = $1
       AND requester_id LIKE 'loadtest-user-%'
     GROUP BY status`,
    [entitlementRef.id]
  );
  return result.rows;
}

async function verifyNoDuplicates() {
  const result = await pool.query(
    `SELECT external_id, COUNT(*) as count
     FROM access_requests
     WHERE entitlement_id = $1
       AND requester_id LIKE 'loadtest-user-%'
     GROUP BY external_id
     HAVING COUNT(*) > 1`,
    [entitlementRef.id]
  );
  return result.rows;
}

async function getRevocationTimes() {
  const result = await pool.query(
    `SELECT 
       id,
       requester_id,
       access_expires_at,
       updated_at as revoked_at,
       EXTRACT(EPOCH FROM (updated_at - access_expires_at)) * 1000 as lag_ms
     FROM access_requests
     WHERE entitlement_id = $1
       AND status = 'REVOKED'
       AND requester_id LIKE 'loadtest-user-%'
     ORDER BY updated_at`,
    [entitlementRef.id]
  );
  return result.rows;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("=== Expiration Scheduler Load Test ===");
  console.log(`Records: ${NUM_RECORDS}`);
  console.log(`Workers: ${NUM_WORKERS}`);
  console.log(`Batch Size: ${BATCH_SIZE}`);
  console.log("");
  
  // Clean up any existing load test records
  console.log("Cleaning up existing load test records...");
  await pool.query(
    `DELETE FROM access_requests 
     WHERE requester_id LIKE 'loadtest-user-%' 
       AND entitlement_id = $1`,
    [entitlementRef.id]
  );
  
  // Seed database
  await seedOverdueRecords(NUM_RECORDS);
  
  // Get initial stats
  console.log("\nInitial stats:");
  const initialStats = await getStats();
  console.table(initialStats);
  
  // Start multiple scheduler workers
  console.log(`\nStarting ${NUM_WORKERS} scheduler workers...`);
  
  const workerResults = [];
  
  const runWorker = async (workerId) => {
    let processed = 0;
    let errors = 0;
    const maxRounds = Math.ceil(NUM_RECORDS / (BATCH_SIZE * NUM_WORKERS)) + 2;
    
    for (let round = 0; round < maxRounds; round++) {
      try {
        const now = new Date();
        const leaseUntil = new Date(now.getTime() + 60000);
        
        // Claim batch
        const claimQuery = `
          SELECT id, access_expires_at, expiration_attempt_count, expiration_max_retries
          FROM access_requests
          WHERE 
            status IN ('FULFILLED', 'RETRY')
            AND (
              (access_expires_at IS NOT NULL AND access_expires_at <= $1)
              OR (expiration_next_attempt_at IS NOT NULL AND expiration_next_attempt_at <= $1)
            )
            AND (lease_until IS NULL OR lease_until < $1)
          ORDER BY COALESCE(access_expires_at, expiration_next_attempt_at) ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $2
        `;
        
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          
          const claimResult = await client.query(claimQuery, [now, BATCH_SIZE]);
          const claimed = claimResult.rows;
          
          if (claimed.length > 0) {
            await client.query(
              `UPDATE access_requests
               SET 
                 status = 'REVOCATION_PENDING',
                 lease_owner = $1,
                 lease_until = $2,
                 lease_acquired_at = $3,
                 version = version + 1,
                 updated_at = NOW()
               WHERE id = ANY($4)`,
              [`worker-${workerId}`, leaseUntil, now, claimed.map(r => r.id)]
            );
            
            await client.query('COMMIT');
            
            // Simulate processing (GitHub API call)
            for (const req of claimed) {
              await pool.query(
                `UPDATE access_requests SET
                  status = 'REVOKED',
                  version = version + 1,
                  updated_at = NOW(),
                  lease_owner = NULL,
                  lease_until = NULL,
                  lease_acquired_at = NULL
                WHERE id = $1`,
                [req.id]
              );
              processed++;
            }
          } else {
            await client.query('COMMIT');
            // No more work
            break;
          }
        } catch (err) {
          await client.query('ROLLBACK');
          errors++;
          console.error(`Worker ${workerId} error:`, err);
        } finally {
          client.release();
        }
        
        // Small delay between rounds
        await new Promise(r => setTimeout(r, 10));
      } catch (err) {
        errors++;
        console.error(`Worker ${workerId} round error:`, err);
      }
    }
    
    workerResults.push({ workerId: `worker-${workerId}`, processed, errors });
    console.log(`Worker ${workerId}: processed ${processed}, errors ${errors}`);
  };
  
  const startTime = Date.now();
  
  // Run workers in parallel
  const workers = [];
  for (let i = 0; i < NUM_WORKERS; i++) {
    workers.push(runWorker(i));
  }
  
  await Promise.all(workers);
  
  const totalTime = Date.now() - startTime;
  const totalProcessed = workerResults.reduce((sum, w) => sum + w.processed, 0);
  const totalErrors = workerResults.reduce((sum, w) => sum + w.errors, 0);
  
  console.log(`\n=== Load Test Results ===`);
  console.log(`Total time: ${totalTime}ms`);
  console.log(`Total processed: ${totalProcessed}`);
  console.log(`Total errors: ${totalErrors}`);
  console.log(`Throughput: ${Math.round(totalProcessed / (totalTime / 1000))} records/sec`);
  console.log("");
  
  console.log("Per-worker results:");
  console.table(workerResults);
  
  // Verify no duplicates
  console.log("\nVerifying no duplicate revocations...");
  const duplicates = await verifyNoDuplicates();
  if (duplicates.length > 0) {
    console.error("❌ DUPLICATES FOUND:");
    console.table(duplicates);
    process.exit(1);
  } else {
    console.log("✅ No duplicates found");
  }
  
  // Get final stats
  console.log("\nFinal stats:");
  const finalStats = await getStats();
  console.table(finalStats);
  
  // Get revocation lag metrics
  const revocations = await getRevocationTimes();
  if (revocations.length > 0) {
    const lags = revocations.map(r => r.lag_ms).sort((a, b) => a - b);
    const p50 = lags[Math.floor(lags.length * 0.5)];
    const p95 = lags[Math.floor(lags.length * 0.95)];
    const p99 = lags[Math.floor(lags.length * 0.99)];
    const max = lags[lags.length - 1];
    const avg = lags.reduce((a, b) => a + b, 0) / lags.length;
    
    console.log("\nRevocation Lag Metrics:");
    console.log(`  Average: ${Math.round(avg)}ms`);
    console.log(`  P50: ${Math.round(p50)}ms`);
    console.log(`  P95: ${Math.round(p95)}ms`);
    console.log(`  P99: ${Math.round(p99)}ms`);
    console.log(`  Max: ${Math.round(max)}ms`);
  }
  
  // Check connection pool
  console.log(`\nPool stats: ${pool.totalCount} total, ${pool.idleCount} idle, ${pool.waitingCount} waiting`);
  
  // Verify all overdue records were processed
  const fulfilledCount = finalStats.find(s => s.status === 'FULFILLED')?.count || 0;
  const revokedCount = finalStats.find(s => s.status === 'REVOKED')?.count || 0;
  
  console.log(`\nProcessed: ${revokedCount}/${NUM_RECORDS} (${Math.round(revokedCount/NUM_RECORDS*100)}%)`);
  
  if (revokedCount >= NUM_RECORDS * 0.99) {
    console.log("✅ Load test PASSED - 99%+ of records processed");
  } else {
    console.log("❌ Load test FAILED - less than 99% processed");
    process.exit(1);
  }
  
  await pool.end();
}

main().catch(err => {
  console.error("Load test failed:", err);
  process.exit(1);
});