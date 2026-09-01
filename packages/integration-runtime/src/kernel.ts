// packages/integration-runtime/src/kernel.ts
// RuntimeKernel interface — internal seam for Cordis evaluation
// This is an IMPLEMENTATION DETAIL behind the PluginLoader boundary.
// No Cordis types may appear in Plugin, PluginManifest, Capability, or tenant-facing APIs.

import type {
  Plugin,
  PluginActivationContext,
  PluginActivationResult,
  PluginInstanceState,
  PluginId,
  TenantId,
  CoreServices,
} from "./plugin.js";
import type { Capability } from "./capability.js";

/**
 * Internal runtime kernel interface — isolates lifecycle machinery from loader.
 * All operations are tenant-scoped and receive CoreServices.
 * 
 * This interface MUST remain stable regardless of kernel implementation.
 * Cordis evaluation swaps the implementation behind this boundary.
 */
export interface RuntimeKernel {
  /**
   * Activate a plugin for a tenant.
   * Returns capabilities to register with the capability registry.
   */
  activate(
    tenantId: TenantId,
    plugin: Plugin,
    services: CoreServices,
    config?: Readonly<Record<string, unknown>>
  ): Promise<PluginActivationResult>;

  /**
   * Degrade a plugin instance (provider unavailable, reduced functionality).
   */
  degrade(tenantId: TenantId, pluginId: PluginId, services: CoreServices): Promise<void>;

  /**
   * Suspend a plugin instance (temporary pause).
   */
  suspend(tenantId: TenantId, pluginId: PluginId, services: CoreServices): Promise<void>;

  /**
   * Reactivate a suspended plugin instance.
   * Returns new capabilities to register (may differ from original activation).
   */
  reactivate(tenantId: TenantId, pluginId: PluginId, services: CoreServices): Promise<PluginActivationResult>;

  /**
   * Dispose a plugin instance — MUST be idempotent.
   * After dispose, zero capability registrations, listeners, timers/effects, or plugin-owned resources may remain.
   */
  dispose(tenantId: TenantId, pluginId: PluginId, services: CoreServices): Promise<void>;

  /**
   * Get the current state of a loaded plugin instance.
   */
  getState(tenantId: TenantId, pluginId: PluginId): PluginInstanceState | null;
}

/**
 * OpnoryRuntimeKernel — the current proven implementation.
 * Extracts lifecycle logic from DefaultPluginLoader for kernel swap evaluation.
 */
export class OpnoryRuntimeKernel implements RuntimeKernel {
  private loadedPlugins = new Map<string, {
    plugin: Plugin;
    state: PluginInstanceState;
    capabilities: readonly Capability[];
    activationResult: PluginActivationResult;
    activatedAt: Date;
  }>(); // key: `${tenantId}:${pluginId}`

  private getKey(tenantId: TenantId, pluginId: PluginId): string {
    return `${tenantId}:${pluginId}`;
  }

  async activate(
    tenantId: TenantId,
    plugin: Plugin,
    services: CoreServices,
    config: Readonly<Record<string, unknown>> = {}
  ): Promise<PluginActivationResult> {
    const key = this.getKey(tenantId, plugin.manifest.name);
    
    if (this.loadedPlugins.has(key)) {
      throw new Error(`Plugin ${plugin.manifest.name} already loaded for tenant ${tenantId}`);
    }

    const context: PluginActivationContext = {
      tenantId,
      pluginId: plugin.manifest.name,
      manifest: plugin.manifest,
      services,
      config,
    };

    // Update state: activating
    // SAFETY: these casts establish the well-formed initial placeholder before
    // real activation fills them — "activating" is a declared PluginInstanceState
    // member, [] is a valid readonly Capability[], and { capabilities: [] } is the
    // minimal PluginActivationResult (its other field `state` is optional).
    let loadedPlugin = {
      plugin,
      state: "activating" as PluginInstanceState,
      capabilities: [] as readonly Capability[],
      activationResult: { capabilities: [] } as PluginActivationResult,
      activatedAt: new Date(),
    };
    this.loadedPlugins.set(key, loadedPlugin);

    try {
      // Activate plugin
      const result = await plugin.activate(context);

      // Update state: active
      loadedPlugin.state = "active";
      loadedPlugin.capabilities = result.capabilities;
      loadedPlugin.activationResult = result;

      // Emit runtime event
      services.events.publish({
        type: "plugin.activated",
        pluginId: plugin.manifest.name,
        tenantId,
        timestamp: new Date(),
      });

      // Emit capability available events
      for (const capability of result.capabilities) {
        services.events.publish({
          type: "capability.available",
          capabilityName: capability.name,
          provider: capability.provider,
          timestamp: new Date(),
        });
      }

      return result;
    } catch (error) {
      loadedPlugin.state = "error";
      throw error;
    }
  }

  async degrade(tenantId: TenantId, pluginId: PluginId, services: CoreServices): Promise<void> {
    const key = this.getKey(tenantId, pluginId);
    const loadedPlugin = this.loadedPlugins.get(key);
    
    if (!loadedPlugin) {
      return; // Not loaded
    }

    const context: PluginActivationContext = {
      tenantId,
      pluginId,
      manifest: loadedPlugin.plugin.manifest,
      services,
      config: loadedPlugin.activationResult.state ?? {},
    };

    loadedPlugin.state = "degraded";
    await loadedPlugin.plugin.degrade(context);

    services.events.publish({
      type: "plugin.degraded",
      pluginId,
      tenantId,
      reason: "degraded by kernel",
      timestamp: new Date(),
    });
  }

  async suspend(tenantId: TenantId, pluginId: PluginId, services: CoreServices): Promise<void> {
    const key = this.getKey(tenantId, pluginId);
    const loadedPlugin = this.loadedPlugins.get(key);
    
    if (!loadedPlugin) {
      return; // Not loaded
    }

    const context: PluginActivationContext = {
      tenantId,
      pluginId,
      manifest: loadedPlugin.plugin.manifest,
      services,
      config: loadedPlugin.activationResult.state ?? {},
    };

    loadedPlugin.state = "suspending";
    await loadedPlugin.plugin.suspend(context);
    loadedPlugin.state = "suspended";

    services.events.publish({
      type: "plugin.suspended",
      pluginId,
      tenantId,
      timestamp: new Date(),
    });
  }

  async reactivate(
    tenantId: TenantId,
    pluginId: PluginId,
    services: CoreServices
  ): Promise<PluginActivationResult> {
    const key = this.getKey(tenantId, pluginId);
    const loadedPlugin = this.loadedPlugins.get(key);
    
    if (!loadedPlugin) {
      throw new Error(`Plugin ${pluginId} not loaded for tenant ${tenantId}`);
    }

    if (loadedPlugin.state !== "suspended") {
      throw new Error(`Plugin ${pluginId} for tenant ${tenantId} is not suspended (state: ${loadedPlugin.state})`);
    }

    const context: PluginActivationContext = {
      tenantId,
      pluginId,
      manifest: loadedPlugin.plugin.manifest,
      services,
      config: loadedPlugin.activationResult.state ?? {},
    };

    // Update state: activating
    loadedPlugin.state = "activating";

    try {
      // Reactivate plugin
      const result = await loadedPlugin.plugin.activate(context);

      // Update state: active
      loadedPlugin.state = "active";
      loadedPlugin.capabilities = result.capabilities;
      loadedPlugin.activationResult = result;

      // Emit runtime event
      services.events.publish({
        type: "plugin.activated",
        pluginId,
        tenantId,
        timestamp: new Date(),
      });

      // Emit capability available events
      for (const capability of result.capabilities) {
        services.events.publish({
          type: "capability.available",
          capabilityName: capability.name,
          provider: capability.provider,
          timestamp: new Date(),
        });
      }

      return result;
    } catch (error) {
      loadedPlugin.state = "error";
      throw error;
    }
  }

  async dispose(tenantId: TenantId, pluginId: PluginId, services: CoreServices): Promise<void> {
    const key = this.getKey(tenantId, pluginId);
    const loadedPlugin = this.loadedPlugins.get(key);
    
    if (!loadedPlugin) {
      return; // Idempotent: already disposed
    }

    const context: PluginActivationContext = {
      tenantId,
      pluginId,
      manifest: loadedPlugin.plugin.manifest,
      services,
      config: loadedPlugin.activationResult.state ?? {},
    };

    loadedPlugin.state = "disposing";

    try {
      // Dispose plugin
      await loadedPlugin.plugin.dispose(context);

      // Unregister capabilities
      for (const capability of loadedPlugin.capabilities) {
        services.capabilities.unregister(capability.name);
      }

      // Emit runtime events
      services.events.publish({
        type: "plugin.disposed",
        pluginId,
        tenantId,
        timestamp: new Date(),
      });

      for (const capability of loadedPlugin.capabilities) {
        services.events.publish({
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

  getState(tenantId: TenantId, pluginId: PluginId): PluginInstanceState | null {
    const key = this.getKey(tenantId, pluginId);
    const loadedPlugin = this.loadedPlugins.get(key);
    return loadedPlugin?.state ?? null;
  }
}