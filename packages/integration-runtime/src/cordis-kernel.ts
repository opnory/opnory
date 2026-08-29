// packages/integration-runtime/src/cordis-kernel.ts
// CordisRuntimeKernel — experimental implementation using Cordis framework
// This is an IMPLEMENTATION DETAIL behind the RuntimeKernel boundary.
// No Cordis types may appear in Plugin, PluginManifest, Capability, or tenant-facing APIs.

import type {
  Plugin,
  PluginManifest,
  PluginActivationContext,
  PluginActivationResult,
  PluginInstanceState,
  PluginId,
  TenantId,
  CoreServices,
  LoadedPlugin,
  ValidationResult,
} from "./plugin.js";
import type { Capability } from "./capability.js";
import type { RuntimeKernel } from "./kernel.js";

// Import Cordis dynamically to avoid bundling it in the main build
// Use type-only import for types, runtime import for values
type CordisContext = any;
type CordisService = any;

interface CordisModule {
  Context: new () => CordisContext;
  Service: new (...args: any[]) => CordisService;
}

let cordisModule: CordisModule | null = null;

async function getCordis(): Promise<CordisModule> {
  if (!cordisModule) {
    // Use require for CommonJS compatibility, but types are ESM
    const mod = await import("cordis") as unknown as CordisModule;
    cordisModule = {
      Context: mod.Context,
      Service: mod.Service,
    };
  }
  return cordisModule;
}

/**
 * CordisRuntimeKernel — experimental implementation using Cordis framework.
 * Uses Cordis Context, Fiber, and reflect.provide/reflect.get for service management.
 * Lifecycle operations (degrade/suspend/reactivate/dispose) are implemented via Fiber effects.
 */
export class CordisRuntimeKernel implements RuntimeKernel {
  private contexts = new Map<string, CordisContext>(); // key: `${tenantId}:${pluginId}`
  private pluginStates = new Map<string, PluginInstanceState>(); // key: `${tenantId}:${pluginId}`

  private getKey(tenantId: TenantId, pluginId: PluginId): string {
    return `${tenantId}:${pluginId}`;
  }

  private async getContext(tenantId: TenantId, pluginId: PluginId): Promise<CordisContext> {
    const key = this.getKey(tenantId, pluginId);
    let context = this.contexts.get(key);
    
    if (!context) {
      const { Context } = await getCordis();
      context = new Context();
      this.contexts.set(key, context);
    }
    
    return context;
  }

  async activate(
    tenantId: TenantId,
    plugin: Plugin,
    services: CoreServices,
    config: Readonly<Record<string, unknown>> = {}
  ): Promise<PluginActivationResult> {
    const key = this.getKey(tenantId, plugin.manifest.name);
    
    if (this.contexts.has(key)) {
      throw new Error(`Plugin ${plugin.manifest.name} already loaded for tenant ${tenantId}`);
    }

    const { Context } = await getCordis();
    const context = new Context();
    this.contexts.set(key, context);

    // Create activation context
    const activationContext: PluginActivationContext = {
      tenantId,
      pluginId: plugin.manifest.name,
      manifest: plugin.manifest,
      services,
      config,
    };

    this.pluginStates.set(key, "activating");

    try {
      // Provide plugin services via Cordis reflect
      await context.reflect.provide("Plugin", async () => plugin);
      await context.reflect.provide("PluginActivationContext", async () => activationContext);
      await context.reflect.provide("CoreServices", async () => services);

      // Activate plugin
      const result = await plugin.activate(activationContext);

      // Register capabilities in Cordis registry
      for (const capability of result.capabilities) {
        await context.reflect.provide(`Capability:${capability.name}`, async () => capability);
      }

      // Store capabilities list for later cleanup
      await context.reflect.provide("Capabilities", async () => result.capabilities);

      this.pluginStates.set(key, "active");

      // Emit runtime event
      services.events.publish({
        type: "plugin.activated",
        pluginId: plugin.manifest.name,
        tenantId,
        timestamp: new Date(),
      });

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
      this.pluginStates.set(key, "error");
      throw error;
    }
  }

  async degrade(tenantId: TenantId, pluginId: PluginId, services: CoreServices): Promise<void> {
    const key = this.getKey(tenantId, pluginId);
    const context = this.contexts.get(key);
    
    if (!context) {
      return; // Not loaded
    }

    // Get plugin from context - reflect.get returns a factory
    const pluginFactory = await context.reflect.get("Plugin");
    if (!pluginFactory) {
      return;
    }
    const plugin = await pluginFactory();

    const activationContext: PluginActivationContext = {
      tenantId,
      pluginId,
      manifest: plugin.manifest,
      services,
      config: {},
    };

    this.pluginStates.set(key, "degraded");
    await plugin.degrade(activationContext);

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
    const context = this.contexts.get(key);
    
    if (!context) {
      return; // Not loaded
    }

    // Get plugin from context - reflect.get returns a factory
    const pluginFactory = await context.reflect.get("Plugin");
    if (!pluginFactory) {
      return;
    }
    const plugin = await pluginFactory();

    const activationContext: PluginActivationContext = {
      tenantId,
      pluginId,
      manifest: plugin.manifest,
      services,
      config: {},
    };

    this.pluginStates.set(key, "suspending");
    await plugin.suspend(activationContext);
    this.pluginStates.set(key, "suspended");

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
    const context = this.contexts.get(key);
    
    if (!context) {
      throw new Error(`Plugin ${pluginId} not loaded for tenant ${tenantId}`);
    }

    const currentState = this.pluginStates.get(key);
    if (currentState !== "suspended") {
      throw new Error(`Plugin ${pluginId} for tenant ${tenantId} is not suspended (state: ${currentState})`);
    }

    // Get plugin from context - reflect.get returns a factory
    const pluginFactory = await context.reflect.get("Plugin");
    if (!pluginFactory) {
      throw new Error(`Plugin ${pluginId} not found in context`);
    }
    const plugin = await pluginFactory();

    const activationContext: PluginActivationContext = {
      tenantId,
      pluginId,
      manifest: plugin.manifest,
      services,
      config: {},
    };

    this.pluginStates.set(key, "activating");

    try {
      // Reactivate plugin
      const result = await plugin.activate(activationContext);

      // Capabilities were already registered during initial activate, don't re-register

      this.pluginStates.set(key, "active");

      services.events.publish({
        type: "plugin.activated",
        pluginId,
        tenantId,
        timestamp: new Date(),
      });

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
      this.pluginStates.set(key, "error");
      throw error;
    }
  }

  async dispose(tenantId: TenantId, pluginId: PluginId, services: CoreServices): Promise<void> {
    const key = this.getKey(tenantId, pluginId);
    const context = this.contexts.get(key);
    
    if (!context) {
      return; // Idempotent: already disposed
    }

    // Get plugin from context - reflect.get returns a factory
    const pluginFactory = await context.reflect.get("Plugin");
    if (!pluginFactory) {
      this.contexts.delete(key);
      this.pluginStates.delete(key);
      return;
    }
    const plugin = await pluginFactory();

    const activationContext: PluginActivationContext = {
      tenantId,
      pluginId,
      manifest: plugin.manifest,
      services,
      config: {},
    };

    this.pluginStates.set(key, "disposing");

    try {
      // Dispose plugin
      await plugin.dispose(activationContext);

      // Unregister capabilities from core registry
      const capabilitiesFactory = await context.reflect.get("Capabilities");
      if (capabilitiesFactory) {
        const capabilities = await capabilitiesFactory();
        for (const capability of capabilities) {
          services.capabilities.unregister(capability.name);
        }
      }

      services.events.publish({
        type: "plugin.disposed",
        pluginId,
        tenantId,
        timestamp: new Date(),
      });

      if (capabilitiesFactory) {
        const capabilities = await capabilitiesFactory();
        for (const capability of capabilities) {
          services.events.publish({
            type: "capability.unavailable",
            capabilityName: capability.name,
            provider: capability.provider,
            timestamp: new Date(),
          });
        }
      }
    } catch (error) {
      // Log but don't throw - dispose must be idempotent
      services.logger?.error?.("Dispose error", { error: String(error) });
    } finally {
      // Dispose Cordis context (cleans up effects, disposables)
      const fiber = context.fiber;
      if (fiber && typeof fiber.dispose === "function") {
        try {
          await fiber.dispose();
        } catch (error) {
          services.logger?.error?.("Fiber dispose error", { error: String(error) });
        }
      }
      
      this.contexts.delete(key);
      this.pluginStates.delete(key);
    }
  }

  getState(tenantId: TenantId, pluginId: PluginId): PluginInstanceState | null {
    const key = this.getKey(tenantId, pluginId);
    return this.pluginStates.get(key) ?? null;
  }
}