// packages/integration-runtime/src/capability.ts
// Provider-neutral capability contracts for the integration runtime spike

import type { FulfillmentAdapter, SubjectRef, ResourceScope, Permission, EntitlementRef } from "./types.js";

/**
 * Capability metadata describing provider-neutral properties
 */
export interface CapabilityMetadata {
  /** Whether this capability requires tenant-scoped credentials */
  readonly tenantScope: boolean;
  /** Secret keys this capability needs (referenced by name in secret store) */
  readonly requiredSecrets: readonly string[];
  /** Optional feature flags for provider-specific behaviors */
  readonly supports: CapabilitySupport;
}

/** Feature flags for provider capabilities */
export interface CapabilitySupport {
  /** Provider has eventual consistency replication delays (e.g., Entra Graph) */
  readonly eventualConsistency: boolean;
  /** Provider supports batch grant/revoke operations */
  readonly batchOperations: boolean;
  /** Provider supports dry-run verification without mutation */
  readonly dryRun: boolean;
}

/**
 * A capability is a provider-neutral wrapper around a FulfillmentAdapter
 * that adds lifecycle, metadata, and tenant-scoping.
 */
export interface Capability {
  /** Unique capability identifier (e.g., "identity.governance.entra") */
  readonly name: string;
  /** Semantic version of this capability implementation */
  readonly version: string;
  /** Provider identifier for conformance harness */
  readonly provider: string;
  /** The unchanged FulfillmentAdapter contract implementation */
  readonly fulfills: FulfillmentAdapter;
  /** Provider-neutral metadata */
  readonly metadata: CapabilityMetadata;
}

/**
 * Reference to a provider capability instance, resolved by the registry
 */
export interface ProviderRef {
  /** Capability name that provides this provider */
  readonly capabilityName: string;
  /** Tenant ID this instance is scoped to */
  readonly tenantId: string;
  /** Reference to credentials in secret store */
  readonly credentialsRef: string;
}

/**
 * Context for provider resolution by policy
 */
export interface ResolutionContext {
  readonly subject: SubjectRef;
  readonly requestedPermissions: readonly Permission[];
  /** Optional policy preferences (e.g., preferred provider ordering) */
  readonly policyPreferences?: PolicyPreferences;
}

/** Policy-driven preferences for provider selection */
export interface PolicyPreferences {
  /** Ordered list of preferred provider identifiers */
  readonly preferredProviders?: readonly string[];
  /** Whether the policy requires eventual consistency handling */
  readonly requireEventualConsistencyHandling?: boolean;
}

/** Runtime state of a capability instance */
export interface CapabilityInstance {
  readonly capability: Capability;
  readonly tenantId: string;
  readonly credentials: CapabilityCredentials;
  readonly state: InstanceState;
  readonly activatedAt: Date;
  readonly updatedAt: Date;
}

/** Credentials resolved at activation time */
export interface CapabilityCredentials {
  readonly secrets: Map<string, string>;
  readonly expiresAt?: Date;
}

/** Instance lifecycle state */
export type InstanceState = "activating" | "active" | "degraded" | "suspended" | "disposed";

/** Resolution strategy for when multiple capabilities can fulfill */
export type ResolutionStrategy = "first-match" | "policy-preferred";