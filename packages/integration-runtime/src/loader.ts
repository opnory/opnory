// packages/integration-runtime/src/loader.ts
// Plugin loader — orchestrates discovery, validation, activation lifecycle

import type {
  Plugin,
  PluginManifest,
  PluginLoader,
  ValidationResult,
  ValidationError,
  ValidationWarning,
  LoadedPlugin,
  PluginInstanceState,
  PluginActivationContext,
  PluginActivationResult,
  CapabilityRegistry,
  CoreServices,
  TenantId,
  PluginId,
  RuntimeEventBus,
  RuntimeEvent,
  CredentialProvider,
  CredentialHandle,
  HttpClientFactory,
  HttpClient,
  RequestOptions,
  Logger,
} from "./plugin.js";
import { pluginId, tenantId } from "./plugin.js";
import type { Capability } from "./capability.js";
import type { FulfillmentAdapter } from "./types.js";
import { InMemoryCapabilityRegistry } from "./registry.js";

/** Default plugin loader implementation */
export class DefaultPluginLoader implements PluginLoader {
  private registry: CapabilityRegistry;
  private coreServices: CoreServices;
  private discoveredPlugins = new Map<PluginId, Plugin>();
  private loadedPlugins = new Map<string, LoadedPlugin>(); // key: `${pluginId}:${tenantId}`

  constructor(registry: CapabilityRegistry, coreServices: CoreServices) {
    this.registry = registry;
    this.coreServices = coreServices;
  }

  async discover(): Promise<readonly Plugin[]> {
    // In production, this would scan plugin directories, npm packages, etc.
    // For now, return manually registered plugins
    return Array.from(this.discoveredPlugins.values());
  }

  /** Register a plugin for discovery (manual registration for spike) */
  registerPlugin(plugin: Plugin): void {
    this.discoveredPlugins.set(plugin.manifest.name, plugin);
  }

  validate(plugin: Plugin): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    const manifest = plugin.manifest;

    // Validate required fields
    if (!manifest.name) {
      errors.push({ code: "MISSING_NAME", message: "Plugin manifest must have a name", path: "manifest.name" });
    }
    if (!manifest.version) {
      errors.push({ code: "MISSING_VERSION", message: "Plugin manifest must have a version", path: "manifest.version" });
    }
    if (!manifest.provides || manifest.provides.length === 0) {
      errors.push({ code: "MISSING_PROVIDES", message: "Plugin must declare at least one capability contract", path: "manifest.provides" });
    }
    if (!manifest.requires) {
      warnings.push({ code: "MISSING_REQUIRES", message: "Plugin declares no core service dependencies", path: "manifest.requires" });
    }
    if (!manifest.minRuntimeVersion) {
      warnings.push({ code: "MISSING_MIN_RUNTIME", message: "Plugin should declare minimum runtime version", path: "manifest.minRuntimeVersion" });
    }

    // Validate capability contracts
    for (const contract of manifest.provides) {
      if (!contract.id || !contract.version) {
        errors.push({ code: "INVALID_CONTRACT", message: "Capability contract must have id and version", path: `manifest.provides[${contract.id}]` });
      }
    }

    // Validate core service dependencies
    for (const dep of manifest.requires) {
      if (!dep.id || !dep.version) {
        errors.push({ code: "INVALID_DEPENDENCY", message: "Core service dependency must have id and version", path: `manifest.requires[${dep.id}]` });
      }
    }

    // Validate secrets requirements
    for (const secret of manifest.secrets) {
      if (!secret.key) {
        errors.push({ code: "INVALID_SECRET", message: "Secret requirement must have a key", path: `manifest.secrets[${secret.key}]` });
      }
    }

    // Validate network requirements
    for (const net of manifest.network) {
      if (!net.host) {
        errors.push({ code: "INVALID_NETWORK", message: "Network requirement must have a host", path: `manifest.network[${net.host}]` });
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  async load(plugin: Plugin, tenantId: TenantId, config: Record<string, unknown> = {}): Promise<LoadedPlugin> {
    const validation = this.validate(plugin);
    if (!validation.valid) {
      throw new Error(`Plugin validation failed: ${validation.errors.map(e => e.message).join(", ")}`);
    }

    const key = `${plugin.manifest.name}:${tenantId}`;
    if (this.loadedPlugins.has(key)) {
      throw new Error(`Plugin ${plugin.manifest.name} already loaded for tenant ${tenantId}`);
    }

    // Create activation context
    const context: PluginActivationContext = {
      tenantId,
      pluginId: plugin.manifest.name,
      manifest: plugin.manifest,
      services: this.coreServices,
      config,
    };

    // Update state: activating
    let state: PluginInstanceState = "activating";
    const loadedPlugin: LoadedPlugin = {
      plugin,
      tenantId,
      state,
      activatedAt: new Date(),
      capabilities: [],
      activationResult: { capabilities: [] },
    };
    this.loadedPlugins.set(key, loadedPlugin);

    try {
      // Activate plugin
      const result = await plugin.activate(context);

      // Register capabilities with registry (with pluginId tracking)
      for (const capability of result.capabilities) {
        this.registry.register(capability, plugin.manifest.name);
      }

      // Update state: active
      state = "active";
      loadedPlugin.state = state;
      loadedPlugin.capabilities = result.capabilities;
      loadedPlugin.activationResult = result;

      // Emit runtime event
      this.coreServices.events.publish({
        type: "plugin.activated",
        pluginId: plugin.manifest.name,
        tenantId,
        timestamp: new Date(),
      });

      // Emit capability available events
      for (const capability of result.capabilities) {
        this.coreServices.events.publish({
          type: "capability.available",
          capabilityName: capability.name,
          provider: capability.provider,
          timestamp: new Date(),
        });
      }

      return loadedPlugin;
    } catch (error) {
      // Update state: error
      state = "error";
      loadedPlugin.state = state;
      throw error;
    }
  }

  async unload(pluginId: PluginId, tenantId: TenantId): Promise<void> {
    const key = `${pluginId}:${tenantId}`;
    const loadedPlugin = this.loadedPlugins.get(key);
    if (!loadedPlugin) {
      return; // Already unloaded
    }

    const plugin = loadedPlugin.plugin;
    const context: PluginActivationContext = {
      tenantId,
      pluginId,
      manifest: plugin.manifest,
      services: this.coreServices,
      config: loadedPlugin.activationResult.state as Record<string, unknown> || {},
    };

    // Update state: disposing
    loadedPlugin.state = "disposing";

    try {
      // Dispose plugin
      await plugin.dispose(context);

      // Unregister capabilities
      for (const capability of loadedPlugin.capabilities) {
        this.registry.unregister(capability.name);
      }

      // Emit runtime events
      this.coreServices.events.publish({
        type: "plugin.disposed",
        pluginId,
        tenantId,
        timestamp: new Date(),
      });

      for (const capability of loadedPlugin.capabilities) {
        this.coreServices.events.publish({
          type: "capability.unavailable",
          capabilityName: capability.name,
          provider: capability.provider,
          timestamp: new Date(),
        });
      }
    } finally {
      // Remove from loaded plugins
      this.loadedPlugins.delete(key);
    }
  }

  getLoaded(tenantId: TenantId): readonly LoadedPlugin[] {
    const result: LoadedPlugin[] = [];
    for (const [key, loaded] of this.loadedPlugins) {
      if (key.endsWith(`:${tenantId}`)) {
        result.push(loaded);
      }
    }
    return result;
  }
}

/** Simple in-memory runtime event bus for spike */
export class InMemoryRuntimeEventBus implements RuntimeEventBus {
  private handlers = new Map<string, Set<(event: RuntimeEvent) => void | Promise<void>>>();

  publish(event: RuntimeEvent): void {
    const handlers = this.handlers.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (error) {
          console.error(`Error in event handler for ${event.type}:`, error);
        }
      }
    }
  }

  subscribe<T extends RuntimeEvent>(
    type: T["type"],
    handler: (event: T) => void | Promise<void>,
  ): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler as (event: RuntimeEvent) => void | Promise<void>);
    
    return () => {
      this.handlers.get(type)?.delete(handler as (event: RuntimeEvent) => void | Promise<void>);
    };
  }
}

/** Simple in-memory credential provider for spike */
export class InMemoryCredentialProvider implements CredentialProvider {
  private secrets = new Map<string, Map<string, CredentialHandle>>(); // tenantId -> (secretKey -> handle)

  /** Pre-populate a secret for testing/spike */
  setSecret(tenantId: TenantId, integration: PluginId, secretKey: string, handle: CredentialHandle): void {
    if (!this.secrets.has(tenantId)) {
      this.secrets.set(tenantId, new Map());
    }
    this.secrets.get(tenantId)!.set(`${integration}:${secretKey}`, handle);
  }

  async resolve(
    tenantId: TenantId,
    integration: PluginId,
    secretKey: string,
  ): Promise<CredentialHandle | null> {
    const tenantSecrets = this.secrets.get(tenantId);
    if (!tenantSecrets) return null;
    return tenantSecrets.get(`${integration}:${secretKey}`) || null;
  }
}

/** Simple HTTP client factory for spike */
export class DefaultHttpClientFactory implements HttpClientFactory {
  create(baseUrl: string, credentials: CredentialHandle): HttpClient {
    return new DefaultHttpClient(baseUrl, credentials);
  }
}

/** Default HTTP client implementation */
class DefaultHttpClient implements HttpClient {
  constructor(
    private baseUrl: string,
    private credentials: CredentialHandle,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...options?.headers,
    };

    // Add authentication based on credential type
    if (this.credentials.type === "api-token") {
      headers["Authorization"] = `Bearer ${this.credentials.id}`;
    } else if (this.credentials.type === "oauth-token") {
      headers["Authorization"] = `Bearer ${this.credentials.id}`;
    }

    const controller = new AbortController();
    const timeoutId = options?.timeout ? setTimeout(() => controller.abort(), options.timeout) : null;

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (timeoutId) clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response.json() as Promise<T>;
    } catch (error) {
      if (timeoutId) clearTimeout(timeoutId);
      throw error;
    }
  }

  async get<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", path, undefined, options);
  }

  async post<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", path, body, options);
  }

  async put<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("PUT", path, body, options);
  }

  async patch<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("PATCH", path, body, options);
  }

  async delete<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("DELETE", path, undefined, options);
  }
}

/** Simple logger implementation */
export class ConsoleLogger implements Logger {
  debug(msg: string, meta?: Record<string, unknown>): void {
    console.debug(`[DEBUG] ${msg}`, meta || "");
  }
  info(msg: string, meta?: Record<string, unknown>): void {
    console.info(`[INFO] ${msg}`, meta || "");
  }
  warn(msg: string, meta?: Record<string, unknown>): void {
    console.warn(`[WARN] ${msg}`, meta || "");
  }
  error(msg: string, meta?: Record<string, unknown>): void {
    console.error(`[ERROR] ${msg}`, meta || "");
  }
}