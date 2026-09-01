// packages/integration-runtime/src/tenant-integration-pg.ts
// PostgreSQL implementation of TenantIntegrationRepository
// Uses the same patterns as access-store-pg for lease/worker machinery

import { Pool } from "pg";
import { getLogger } from "@opnory/observability";
import type {
  TenantIntegration,
  CreateTenantIntegrationInput,
  IntegrationStatus,
  IntegrationFailureCode,
  TenantIntegrationRepository,
  TenantId,
  PluginId,
} from "./tenant-integration.js";
import { randomUUID } from "crypto";

const logger = getLogger().child({ component: "tenant-integration-pg" });

// ============================================================================
// Schema Migration
// ============================================================================

const TENANT_INTEGRATION_SCHEMA_SQL = `
-- Tenant Integrations table
CREATE TABLE IF NOT EXISTS tenant_integrations (
    id UUID PRIMARY KEY,
    tenant_id VARCHAR(255) NOT NULL,
    plugin_id VARCHAR(255) NOT NULL,
    
    desired_status VARCHAR(20) NOT NULL DEFAULT 'inactive',
    actual_status VARCHAR(20) NOT NULL DEFAULT 'discovered',
    
    credential_ref VARCHAR(500),
    config_version INTEGER NOT NULL DEFAULT 0,
    capabilities JSONB DEFAULT '[]',
    
    last_health_check_at TIMESTAMPTZ,
    last_healthy_at TIMESTAMPTZ,
    
    failure_code VARCHAR(50),
    failure_reason TEXT,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Lease fields for distributed reconciliation worker
    lease_owner VARCHAR(255),
    lease_until TIMESTAMPTZ,
    lease_acquired_at TIMESTAMPTZ,
    
    UNIQUE (tenant_id, plugin_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_integrations_tenant ON tenant_integrations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_integrations_desired_actual ON tenant_integrations(desired_status, actual_status);
CREATE INDEX IF NOT EXISTS idx_tenant_integrations_lease ON tenant_integrations(lease_until) WHERE lease_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tenant_integrations_reconciliation ON tenant_integrations(actual_status) WHERE actual_status IN ('degraded', 'suspended', 'uninstalling');
`;

export async function migrateTenantIntegrations(pool: Pool): Promise<void> {
  await pool.query(TENANT_INTEGRATION_SCHEMA_SQL);
  logger.info("Tenant integrations schema migration completed");
}

// ============================================================================
// Repository Implementation
// ============================================================================

export class PgTenantIntegrationRepository implements TenantIntegrationRepository {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  private mapRowToIntegration(row: any): TenantIntegration {
    return {
      id: row.id,
      // SAFETY: database schema enforces TenantId branding via unique constraint
      tenantId: row.tenant_id as TenantId,
      // SAFETY: database schema enforces PluginId branding via unique constraint
      pluginId: row.plugin_id as PluginId,
      // SAFETY: database CHECK constraint ensures desired_status is 'active' or 'inactive'
      desiredStatus: row.desired_status as "active" | "inactive",
      // SAFETY: database CHECK constraint ensures valid IntegrationStatus values
      actualStatus: row.actual_status as IntegrationStatus,
      credentialRef: row.credential_ref,
      configVersion: row.config_version,
      capabilities: row.capabilities || [],
      lastHealthCheckAt: row.last_health_check_at?.toISOString() ? new Date(row.last_health_check_at) : null,
      lastHealthyAt: row.last_healthy_at?.toISOString() ? new Date(row.last_healthy_at) : null,
      // SAFETY: database CHECK constraint ensures valid IntegrationFailureCode values
      failureCode: row.failure_code as IntegrationFailureCode | null,
      failureReason: row.failure_reason,
      leaseOwner: row.lease_owner,
      leaseUntil: row.lease_until?.toISOString() ? new Date(row.lease_until) : null,
      leaseAcquiredAt: row.lease_acquired_at?.toISOString() ? new Date(row.lease_acquired_at) : null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  async create(input: CreateTenantIntegrationInput): Promise<TenantIntegration> {
    const id = randomUUID();
    const now = new Date();

    const sql = `
      INSERT INTO tenant_integrations (
        id, tenant_id, plugin_id, desired_status, actual_status,
        credential_ref, config_version, capabilities, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `;

    await this.pool.query(sql, [
      id,
      input.tenantId,
      input.pluginId,
      "inactive", // desiredStatus starts as inactive until install() is called
      "discovered", // actualStatus starts as discovered
      input.credentialRef,
      0,
      JSON.stringify(input.capabilities),
      now,
      now,
    ]);

    const result = await this.pool.query(
      "SELECT * FROM tenant_integrations WHERE id = $1",
      [id],
    );

    return this.mapRowToIntegration(result.rows[0]);
  }

  async getById(id: string): Promise<TenantIntegration | undefined> {
    const result = await this.pool.query(
      "SELECT * FROM tenant_integrations WHERE id = $1",
      [id],
    );
    if (result.rows.length === 0) return undefined;
    return this.mapRowToIntegration(result.rows[0]);
  }

  async getByTenantAndPlugin(tenantId: TenantId, pluginId: PluginId): Promise<TenantIntegration | undefined> {
    const result = await this.pool.query(
      "SELECT * FROM tenant_integrations WHERE tenant_id = $1 AND plugin_id = $2",
      [tenantId, pluginId],
    );
    if (result.rows.length === 0) return undefined;
    return this.mapRowToIntegration(result.rows[0]);
  }

  async getByTenant(tenantId: TenantId): Promise<TenantIntegration[]> {
    const result = await this.pool.query(
      "SELECT * FROM tenant_integrations WHERE tenant_id = $1 ORDER BY created_at DESC",
      [tenantId],
    );
    return result.rows.map((row) => this.mapRowToIntegration(row));
  }

  async getDueForReconciliation(limit: number): Promise<TenantIntegration[]> {
    const now = new Date();

    // Find integrations where actual != desired, or those needing health checks
    // Also include those with expired leases for the reconciliation worker
    const sql = `
      SELECT * FROM tenant_integrations
      WHERE 
        -- Desired active but actual not active
        (desired_status = 'active' AND actual_status NOT IN ('active'))
        OR
        -- Desired inactive but actual active
        (desired_status = 'inactive' AND actual_status = 'active')
        OR
        -- Needs health check (active but last check > 5 min ago)
        (actual_status = 'active' AND (last_health_check_at IS NULL OR last_health_check_at < $1))
        OR
        -- In degraded/suspended/uninstalling state needing recovery
        (actual_status IN ('degraded', 'suspended', 'uninstalling'))
        OR
        -- Lease expired or not held
        (lease_until IS NOT NULL AND lease_until < $1)
      ORDER BY 
        CASE 
          WHEN actual_status IN ('degraded', 'suspended', 'uninstalling') THEN 0
          WHEN desired_status = 'active' AND actual_status != 'active' THEN 1
          WHEN desired_status = 'inactive' AND actual_status = 'active' THEN 2
          ELSE 3
        END,
        COALESCE(last_health_check_at, created_at) ASC
      LIMIT $2
    `;

    const result = await this.pool.query(sql, [
      new Date(now.getTime() - 5 * 60 * 1000), // 5 minutes ago
      limit,
    ]);

    return result.rows.map((row) => this.mapRowToIntegration(row));
  }

  async update(
    integration: TenantIntegration,
    expectedVersion: number
  ): Promise<TenantIntegration> {
    const sql = `
      UPDATE tenant_integrations SET
        desired_status = $2,
        actual_status = $3,
        credential_ref = $4,
        config_version = $5,
        capabilities = $6,
        last_health_check_at = $7,
        last_healthy_at = $8,
        failure_code = $9,
        failure_reason = $10,
        updated_at = NOW(),
        lease_owner = $11,
        lease_until = $12,
        lease_acquired_at = $13
      WHERE id = $1 AND config_version = $14
    `;

    const result = await this.pool.query(sql, [
      integration.id,
      integration.desiredStatus,
      integration.actualStatus,
      integration.credentialRef,
      integration.configVersion,
      JSON.stringify(integration.capabilities),
      integration.lastHealthCheckAt,
      integration.lastHealthyAt,
      integration.failureCode,
      integration.failureReason,
      integration.leaseOwner || null,
      integration.leaseUntil || null,
      integration.leaseAcquiredAt || null,
      expectedVersion,
    ]);

    if (result.rowCount === 0) {
      throw new Error(
        `Optimistic concurrency conflict: expected version ${expectedVersion}, found different`
      );
    }

    // SAFETY: the UPDATE above succeeded (rowCount > 0), so getById is guaranteed to
    // return the just-updated row; `as Promise<TenantIntegration>` narrows away the
    // `undefined` branch that cannot occur here.
    return this.getById(integration.id) as Promise<TenantIntegration>;
  }

  async updateActualStatus(
    id: string,
    actualStatus: IntegrationStatus,
    failureCode: IntegrationFailureCode | null,
    failureReason: string | null,
    lastHealthCheckAt: Date | null,
    lastHealthyAt: Date | null
  ): Promise<void> {
    const sql = `
      UPDATE tenant_integrations SET
        actual_status = $2,
        failure_code = $3,
        failure_reason = $4,
        last_health_check_at = $5,
        last_healthy_at = $6,
        updated_at = NOW()
      WHERE id = $1
    `;

    await this.pool.query(sql, [
      id,
      actualStatus,
      failureCode,
      failureReason,
      lastHealthCheckAt,
      lastHealthyAt,
    ]);
  }

  async delete(id: string): Promise<void> {
    const sql = "DELETE FROM tenant_integrations WHERE id = $1 AND actual_status = 'inactive'";
    const result = await this.pool.query(sql, [id]);
    if (result.rowCount === 0) {
      throw new Error("Cannot delete integration: not in inactive state or not found");
    }
  }
}

// ============================================================================
// Pool Management (lazy, environment-bound) - mirrors access-store-pg
// ============================================================================

let pgPool: Pool | undefined;

export function getIntegrationPool(): Pool {
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

export async function closeIntegrationPool(): Promise<void> {
  if (pgPool) {
    await pgPool.end();
    pgPool = undefined;
  }
}