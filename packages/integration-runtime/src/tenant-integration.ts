// packages/integration-runtime/src/tenant-integration.ts
// Durable tenant integration aggregate — core authority for integration lifecycle
// This is the single source of truth for desired vs actual integration state.

export type { PluginId, TenantId } from "./plugin.js";

import type { PluginId, TenantId } from "./plugin.js";

/** Integration status enum — reflects both desired and actual state */
export type IntegrationStatus =
  | "discovered"
  | "configuring"
  | "validating"
  | "active"
  | "degraded"
  | "suspended"
  | "uninstalling"
  | "inactive";

/** Lease fields for distributed reconciliation worker */
export interface IntegrationLease {
  readonly leaseOwner: string | null;
  readonly leaseUntil: Date | null;
  readonly leaseAcquiredAt: Date | null;
}

/** Failure codes for deterministic recovery policy */
export type IntegrationFailureCode =
  | "credential_invalid"
  | "credential_backend_unavailable" // secret backend down — distinct from provider_unreachable (ADR 0006)
  | "provider_unreachable"
  | "provider_rate_limited"
  | "configuration_invalid"
  | "capability_missing"
  | "activation_failed"
  | "health_check_failed"
  | "cleanup_failed";

/**
 * TenantIntegration — the durable aggregate for a single tenant/plugin pair.
 * 
 * INVARIANT: Core authority owns this state. Plugins/runtime report observations;
 * they do not decide installation state. The reconciliation loop drives
 * actualStatus toward desiredStatus.
 */
export interface TenantIntegration {
  /** Unique identifier for this integration record */
  readonly id: string;

  /** Tenant this integration belongs to */
  readonly tenantId: TenantId;

  /** Plugin identifier (e.g., "okta", "entra") */
  readonly pluginId: PluginId;

  /** Desired state — controlled by core install/uninstall workflow */
  desiredStatus: "active" | "inactive";

  /** Actual state — observed by reconciliation worker from runtime */
  actualStatus: IntegrationStatus;

  /** Reference to credential in secret store (never raw secrets) */
  credentialRef: string | null;

  /** Incremented on each config change for optimistic concurrency */
  configVersion: number;

  /** Capability names registered by this integration */
  capabilities: string[];

  /** Last time health check was attempted */
  lastHealthCheckAt: Date | null;

  /** Last time integration was confirmed healthy */
  lastHealthyAt: Date | null;

  /** Failure code if actualStatus is degraded/suspended/error */
  failureCode: IntegrationFailureCode | null;

  /** Human-readable failure reason for observability */
  failureReason: string | null;

  /** Lease fields for distributed reconciliation worker */
  leaseOwner: string | null;
  leaseUntil: Date | null;
  leaseAcquiredAt: Date | null;

  /** Creation timestamp */
  readonly createdAt: Date;

  /** Last update timestamp */
  updatedAt: Date;
}

/** Input for creating a new integration record */
export interface CreateTenantIntegrationInput {
  tenantId: TenantId;
  pluginId: PluginId;
  credentialRef: string | null;
  capabilities: string[];
}

/** Result of an integration state transition */
export interface IntegrationTransitionResult {
  /** The integration after transition */
  integration: TenantIntegration;
  /** Whether the transition was a no-op (already in target state) */
  noOp: boolean;
  /** Any warnings generated during transition */
  warnings: string[];
}

/** Repository interface for durable TenantIntegration storage */
export interface TenantIntegrationRepository {
  /** Create a new integration record in DISCOVERED state */
  create(input: CreateTenantIntegrationInput): Promise<TenantIntegration>;

  /** Get integration by ID */
  getById(id: string): Promise<TenantIntegration | undefined>;

  /** Get integration by tenant + plugin (unique constraint) */
  getByTenantAndPlugin(tenantId: TenantId, pluginId: PluginId): Promise<TenantIntegration | undefined>;

  /** Get all integrations for a tenant */
  getByTenant(tenantId: TenantId): Promise<TenantIntegration[]>;

  /** Get all integrations needing reconciliation (actual != desired) */
  getDueForReconciliation(limit: number): Promise<TenantIntegration[]>;

  /** Update integration with optimistic concurrency control */
  update(
    integration: TenantIntegration,
    expectedVersion: number
  ): Promise<TenantIntegration>;

  /** Update just the actualStatus and failure fields (from reconciliation worker) */
  updateActualStatus(
    id: string,
    actualStatus: IntegrationStatus,
    failureCode: IntegrationFailureCode | null,
    failureReason: string | null,
    lastHealthCheckAt: Date | null,
    lastHealthyAt: Date | null
  ): Promise<void>;

  /** Delete integration record (only allowed when INACTIVE) */
  delete(id: string): Promise<void>;
}

/**
 * Core-owned install workflow — creates and validates integration record
 * State machine: DISCOVERED → CONFIGURING → VALIDATING → ACTIVE
 */
export interface IntegrationInstaller {
  /**
   * Install a plugin for a tenant.
   * Validates config, probes provider health, transitions to ACTIVE.
   * Idempotent: if integration exists with desiredStatus=active, validates and returns.
   */
  install(input: CreateTenantIntegrationInput): Promise<IntegrationTransitionResult>;
}

/**
 * Core-owned uninstall workflow — symmetric, fail-closed
 * State machine: ACTIVE → UNINSTALLING → INACTIVE
 */
export interface IntegrationUninstaller {
  /**
   * Uninstall a plugin for a tenant.
   * Disposes runtime instance, verifies zero capabilities/listeners/state,
   * transitions to INACTIVE. If cleanup cannot be proven, leaves in UNINSTALLING
   * with cleanup_failed reason.
   */
  uninstall(tenantId: TenantId, pluginId: PluginId): Promise<IntegrationTransitionResult>;
}

/**
 * Health check interface for provider-specific health probes
 */
export interface IntegrationHealthChecker {
  /**
   * Perform a health check for an active integration.
   * Returns { healthy: true } or { healthy: false, code, reason }.
   * Must not mutate state — reconciliation loop decides transitions.
   */
  checkHealth(
    tenantId: TenantId,
    pluginId: PluginId,
    credentialRef: string | null
  ): Promise<{ healthy: boolean; code?: IntegrationFailureCode; reason?: string }>;
}

/**
 * Credential provider abstraction — database stores only references
 */
export interface CredentialProvider {
  /**
   * Get a scoped credential handle for a tenant/integration.
   * The handle contains only the material needed for this plugin instance.
   * Never returns raw secrets to callers.
   */
  get(
    tenantId: TenantId,
    credentialRef: string
  ): Promise<ScopedCredentialHandle | null>;
}

/** Opaque credential handle — runtime receives only what it needs */
export interface ScopedCredentialHandle {
  readonly type: "api-token" | "client-secret" | "certificate" | "oauth-token" | "custom";
  readonly material: Readonly<Record<string, string>>; // e.g., { apiToken: "...", orgUrl: "..." }
  readonly expiresAt?: Date;
}

/**
 * Reconciliation loop — drives actualStatus toward desiredStatus
 * Reuses existing lease/worker machinery from access-store-pg
 */
export interface IntegrationReconciliationWorker {
  /** Start the reconciliation loop */
  start(): Promise<void>;

  /** Stop the reconciliation loop gracefully */
  stop(): Promise<void>;

  /** Run a single reconciliation cycle (for testing) */
  runOnce(): Promise<void>;
}