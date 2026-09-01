// packages/integration-runtime/src/plugin.ts
// Plugin contract — provider-neutral, frozen interface for first-party integration plugins

import type { Capability, ProviderRef, ResolutionContext } from "./capability.js";
import type { EntitlementRef } from "./types.js";

// Re-export Capability so first-party plugins can import it from this module
// (they construct Capability[] in their activate() results).
export type { Capability };

/** Unique identifier for a plugin */
export type PluginId = string & { readonly __brand: unique symbol };

/** Helper to create a branded PluginId */
export function pluginId(id: string): PluginId {
  // SAFETY: branded nominal type over a plain string — the cast is the entire
  // point of the factory; callers pass an untyped identifier and receive the
  // typed token, establishing ownership of the brand at this single boundary.
  return id as PluginId;
}

/** Unique identifier for a capability contract (semver-compatible) */
export type CapabilityContractId = string & { readonly __brand: unique symbol };

/** Helper to create a branded CapabilityContractId */
export function capabilityContractId(id: string): CapabilityContractId {
  // SAFETY: branded nominal type factory — establishes the CapabilityContractId
  // brand over a plain string at this single ownership boundary.
  return id as CapabilityContractId;
}

/** Unique identifier for a dependency on a core service */
export type CoreServiceId = string & { readonly __brand: unique symbol };

/** Helper to create a branded CoreServiceId */
export function coreServiceId(id: string): CoreServiceId {
  // SAFETY: branded nominal type factory — establishes the CoreServiceId brand
  // over a plain string at this single ownership boundary.
  return id as CoreServiceId;
}

/** Unique identifier for a tenant */
export type TenantId = string & { readonly __brand: unique symbol };

/** Helper to create a branded TenantId */
export function tenantId(id: string): TenantId {
  // SAFETY: branded nominal type factory — establishes the TenantId brand over
  // a plain string at this single ownership boundary.
  return id as TenantId;
}

/** Plugin scope — tenant-scoped plugins get isolated credential/instance context */
export type PluginScope = "tenant" | "global";

/** Lifecycle state of a plugin instance */
export type PluginInstanceState =
  | "discovered"
  | "validated"
  | "dependencies-resolved"
  | "activating"
  | "active"
  | "degraded"
  | "suspending"
  | "suspended"
  | "disposing"
  | "disposed"
  | "error";

/** Capability contract version — separate from plugin package semver */
export interface CapabilityContract {
  readonly id: CapabilityContractId;
  readonly version: string; // e.g., "1.0.0"
  readonly description: string;
}

/** Core service dependency declaration */
export interface CoreServiceDependency {
  readonly id: CoreServiceId;
  readonly version: string; // semver range, e.g., "^1.0.0"
  readonly required: boolean;
}

/** Secret/credential requirement for a plugin */
export interface SecretRequirement {
  readonly key: string;
  readonly description: string;
  readonly required: boolean;
}

/** Network/egress requirement for a plugin */
export interface NetworkRequirement {
  readonly host: string;
  readonly port?: number;
  readonly protocol: "https" | "http" | "tcp";
  readonly description: string;
}

/** Plugin manifest — declares identity, capabilities, dependencies, and requirements */
export interface PluginManifest {
  /** Unique plugin identifier (e.g., "okta", "entra") */
  readonly name: PluginId;
  /** Semantic version of the plugin package (independent of capability contracts) */
  readonly version: string;
  /** Human-readable description */
  readonly description: string;
  /** Capability contracts this plugin provides */
  readonly provides: readonly CapabilityContract[];
  /** Core service dependencies this plugin requires */
  readonly requires: readonly CoreServiceDependency[];
  /** Whether this plugin is tenant-scoped (default: "tenant") */
  readonly scope: PluginScope;
  /** Secrets this plugin needs at activation time */
  readonly secrets: readonly SecretRequirement[];
  /** Network egress this plugin needs */
  readonly network: readonly NetworkRequirement[];
  /** Minimum integration-runtime API version */
  readonly minRuntimeVersion: string;
}

/** Credential handle — opaque reference, not raw secret material */
export interface CredentialHandle {
  readonly id: string;
  readonly type: "api-token" | "client-secret" | "certificate" | "oauth-token" | "custom";
  readonly expiresAt?: Date;
}

/** Core credential provider — plugins receive handles, not raw env access */
export interface CredentialProvider {
  resolve(
    tenantId: TenantId,
    integration: PluginId,
    secretKey: string,
  ): Promise<CredentialHandle | null>;
}

/** Core HTTP client factory — plugins receive configured clients, not raw fetch */
export interface HttpClientFactory {
  create(baseUrl: string, credentials: CredentialHandle): HttpClient;
}

/** HTTP client interface provided by core */
export interface HttpClient {
  get<T>(path: string, options?: RequestOptions): Promise<T>;
  post<T>(path: string, body: unknown, options?: RequestOptions): Promise<T>;
  put<T>(path: string, body: unknown, options?: RequestOptions): Promise<T>;
  patch<T>(path: string, body: unknown, options?: RequestOptions): Promise<T>;
  delete<T>(path: string, options?: RequestOptions): Promise<T>;
}

/** Request options for core HTTP client */
export interface RequestOptions {
  readonly headers?: Record<string, string>;
  readonly timeout?: number;
  readonly retry?: RetryPolicy;
}

/** Retry policy for HTTP requests */
export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly backoffMs: number;
  readonly retryableStatuses?: readonly number[];
}

/** Core services injected into plugin activation context */
export interface CoreServices {
  readonly credentials: CredentialProvider;
  readonly http: HttpClientFactory;
  readonly logger: Logger;
  readonly events: RuntimeEventBus;
  readonly capabilities: CapabilityRegistry;
}

/** Logger interface provided by core */
export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** Runtime event bus — ephemeral, may disappear on restart */
export interface RuntimeEventBus {
  publish(event: RuntimeEvent): void;
  subscribe<T extends RuntimeEvent>(
    type: T["type"],
    handler: (event: T) => void | Promise<void>,
  ): () => void;
}

/** Runtime events — ephemeral, for observability only */
export type RuntimeEvent =
  | { readonly type: "plugin.activated"; readonly pluginId: PluginId; readonly tenantId: TenantId; readonly timestamp: Date }
  | { readonly type: "plugin.degraded"; readonly pluginId: PluginId; readonly tenantId: TenantId; readonly reason: string; readonly timestamp: Date }
  | { readonly type: "plugin.suspended"; readonly pluginId: PluginId; readonly tenantId: TenantId; readonly timestamp: Date }
  | { readonly type: "plugin.disposed"; readonly pluginId: PluginId; readonly tenantId: TenantId; readonly timestamp: Date }
  | { readonly type: "capability.available"; readonly capabilityName: string; readonly provider: string; readonly timestamp: Date }
  | { readonly type: "capability.unavailable"; readonly capabilityName: string; readonly provider: string; readonly timestamp: Date };

/** Plugin activation context — tenant-scoped, receives core services */
export interface PluginActivationContext {
  readonly tenantId: TenantId;
  readonly pluginId: PluginId;
  readonly manifest: PluginManifest;
  readonly services: CoreServices;
  readonly config: Readonly<Record<string, unknown>>;
}

/** Plugin lifecycle contract — implemented by each plugin */
export interface Plugin {
  readonly manifest: PluginManifest;

  /** Called once per tenant when plugin is activated */
  activate(ctx: PluginActivationContext): Promise<PluginActivationResult>;

  /** Called when plugin should degrade (e.g., provider unavailable) */
  degrade(ctx: PluginActivationContext): Promise<void>;

  /** Called when plugin should suspend (temporary pause) */
  suspend(ctx: PluginActivationContext): Promise<void>;

  /** Called when plugin is being disposed (cleanup) */
  dispose(ctx: PluginActivationContext): Promise<void>;
}

/** Result of plugin activation — capabilities registered with runtime */
export interface PluginActivationResult {
  /** Capabilities this plugin registers for the tenant */
  readonly capabilities: readonly Capability[];
  /** Any additional plugin-specific state to persist */
  readonly state?: Readonly<Record<string, unknown>>;
}

/** Plugin loader — orchestrates discovery, validation, activation lifecycle */
export interface PluginLoader {
  /** Discover available plugins from configured sources */
  discover(): Promise<readonly Plugin[]>;

  /** Validate a plugin manifest against runtime contracts */
  validate(plugin: Plugin): ValidationResult;

  /** Load and activate a plugin for a tenant */
  load(plugin: Plugin, tenantId: TenantId, config?: Record<string, unknown>): Promise<LoadedPlugin>;

  /** Unload a plugin for a tenant */
  unload(pluginId: PluginId, tenantId: TenantId): Promise<void>;

  /** Get all loaded plugins for a tenant */
  getLoaded(tenantId: TenantId): readonly LoadedPlugin[];
}

/** Validation result for plugin manifest */
export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ValidationError[];
  readonly warnings: readonly ValidationWarning[];
}

/** Validation error — blocks plugin loading */
export interface ValidationError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

/** Validation warning — non-blocking */
export interface ValidationWarning {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

/** Loaded plugin with runtime state */
export interface LoadedPlugin {
  readonly plugin: Plugin;
  readonly tenantId: TenantId;
  state: PluginInstanceState;
  readonly activatedAt: Date;
  capabilities: readonly Capability[];
  activationResult: PluginActivationResult;
}

/** Capability registry — extends existing with plugin registration */
export interface CapabilityRegistry {
  /** Register a capability provided by a plugin */
  register(capability: Capability, pluginId?: PluginId | null): void;

  /** Unregister a capability */
  unregister(capabilityName: string): void;

  /** Resolve provider for entitlement — CORE POLICY CALLS THIS */
  resolveProvider(
    entitlement: EntitlementRef,
    context: ResolutionContext,
  ): ProviderRef | null;

  /** Get all registered capabilities */
  getCapabilities(): ReadonlyMap<string, Capability>;

  /** Get capability by name */
  getCapability(name: string): Capability | undefined;

  /** Get capabilities provided by a specific plugin */
  getCapabilitiesByPlugin(pluginId: PluginId): readonly Capability[];
}