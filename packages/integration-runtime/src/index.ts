// packages/integration-runtime/src/index.ts
// Main entry point for @opnory/integration-runtime

// Core capability contracts
export type {
  Capability,
  CapabilityMetadata,
  CapabilitySupport,
  ProviderRef,
  ResolutionContext,
  PolicyPreferences,
  CapabilityInstance,
  CapabilityCredentials,
  InstanceState,
  ResolutionStrategy,
} from "./capability.js";

export { InMemoryCapabilityRegistry } from "./registry.js";
export type { CapabilityRegistry } from "./registry.js";

// Plugin contract
export type {
  PluginId,
  pluginId,
  CapabilityContractId,
  capabilityContractId,
  CoreServiceId,
  coreServiceId,
  TenantId,
  tenantId,
  PluginScope,
  PluginInstanceState,
  CapabilityContract,
  CoreServiceDependency,
  SecretRequirement,
  NetworkRequirement,
  PluginManifest,
  CredentialHandle,
  CredentialProvider,
  HttpClientFactory,
  HttpClient,
  RequestOptions,
  RetryPolicy,
  CoreServices,
  Logger,
  RuntimeEventBus,
  RuntimeEvent,
  PluginActivationContext,
  Plugin,
  PluginActivationResult,
  PluginLoader,
  ValidationResult,
  ValidationError,
  ValidationWarning,
  LoadedPlugin,
} from "./plugin.js";

export { DefaultPluginLoader } from "./loader.js";
export { InMemoryRuntimeEventBus } from "./loader.js";
export { InMemoryCredentialProvider } from "./loader.js";
export { DefaultHttpClientFactory } from "./loader.js";
export { ConsoleLogger } from "./loader.js";

// Runtime kernel (internal seam)
export type { RuntimeKernel } from "./kernel.js";
export { OpnoryRuntimeKernel } from "./kernel.js";

// Tenant integration lifecycle (Phase 6)
export type {
  IntegrationStatus,
  IntegrationFailureCode,
  TenantIntegration,
  CreateTenantIntegrationInput,
  IntegrationTransitionResult,
  TenantIntegrationRepository,
  IntegrationInstaller,
  IntegrationUninstaller,
  IntegrationHealthChecker,
  CredentialProvider as DurableCredentialProvider,
  ScopedCredentialHandle,
  IntegrationReconciliationWorker,
} from "./tenant-integration.js";

// Secret store + scoped credential provider (Phase 6 credential control plane)
export type {
  SecretRef,
  SecretScope,
  SecretMaterial,
  ScopedCredential,
  SecretStore,
  SecretStoreErrorCode,
  ScopedCredentialProvider,
  ResolveResult,
} from "./secret-store.js";
export {
  SecretStoreError,
  InMemorySecretStore,
  DefaultScopedCredentialProvider,
  SECRET_SENTINEL,
  scanForSecretLeak,
} from "./secret-store.js";