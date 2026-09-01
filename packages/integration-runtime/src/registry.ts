// packages/integration-runtime/src/registry.ts
// Capability registry - core-owned, policy-driven provider resolution

import type { Capability, ProviderRef, ResolutionContext } from "./capability.js";
import type { EntitlementRef } from "./types.js"; // local type for spike
import type { PluginId } from "./plugin.js";

/** Internal representation of a registered capability */
interface RegisteredCapability {
  capability: Capability;
  pluginId: PluginId | null; // track which plugin provided this capability
  instances: Map<string, CapabilityInstance>; // tenantId -> instance
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

/**
 * CapabilityRegistry - core-owned, policy-driven
 * 
 * The registry is the single source of truth for available capabilities.
 * Core POLICY chooses which provider is authoritative by calling resolveProvider().
 * The registry does NOT make authorization decisions.
 */
export interface CapabilityRegistry {
  /** Register a new capability (called at startup / plugin load) */
  register(capability: Capability, pluginId?: PluginId | null): void;
  
  /** Unregister a capability (cleanup) */
  unregister(capabilityName: string): void;
  
  /** 
   * Resolve the authoritative provider for an entitlement.
   * CORE POLICY CALLS THIS. The registry exposes eligible providers;
   * core policy chooses which provider is authoritative.
   */
  resolveProvider(
    entitlement: EntitlementRef,
    context: ResolutionContext
  ): ProviderRef | null;
  
  /** Get all registered capabilities */
  getCapabilities(): ReadonlyMap<string, Capability>;
  
  /** Get a specific capability by name */
  getCapability(name: string): Capability | undefined;

  /** Get capabilities provided by a specific plugin */
  getCapabilitiesByPlugin(pluginId: PluginId): readonly Capability[];

  // Lifecycle operations (runtime owns these)
  activate(tenantId: string, capabilityName: string, credentials: CapabilityCredentials): Promise<CapabilityInstance>;
  degrade(tenantId: string, capabilityName: string): Promise<void>;
  suspend(tenantId: string, capabilityName: string): Promise<void>;
  dispose(tenantId: string, capabilityName: string): Promise<void>;
  cleanup(tenantId: string): Promise<void>;
  
  // Instance queries
  getInstance(tenantId: string, capabilityName: string): CapabilityInstance | undefined;
  getInstancesForTenant(tenantId: string): CapabilityInstance[];
}

/** In-memory implementation for the spike */
export class InMemoryCapabilityRegistry implements CapabilityRegistry {
  private capabilities = new Map<string, RegisteredCapability>();
  private resolutionStrategy: ResolutionStrategy = "first-match"; // or "policy-preferred"

  constructor(resolutionStrategy: ResolutionStrategy = "first-match") {
    this.resolutionStrategy = resolutionStrategy;
  }

  register(capability: Capability, pluginId: PluginId | null = null): void {
    if (this.capabilities.has(capability.name)) {
      throw new Error(`Capability already registered: ${capability.name}`);
    }
    this.capabilities.set(capability.name, {
      capability,
      pluginId,
      instances: new Map(),
    });
  }

  unregister(capabilityName: string): void {
    const registered = this.capabilities.get(capabilityName);
    if (!registered) return;
    
    // Dispose all instances first
    for (const instance of registered.instances.values()) {
      // Best effort - don't throw on cleanup
      this.disposeInternal(instance.tenantId, capabilityName).catch(() => {});
    }
    
    this.capabilities.delete(capabilityName);
  }

  resolveProvider(
    entitlement: EntitlementRef,
    context: ResolutionContext
  ): ProviderRef | null {
    const candidates = this.getEligibleCapabilities(entitlement, context);
    
    if (candidates.length === 0) {
      return null;
    }

    // Apply resolution strategy
    const chosen = this.applyResolutionStrategy(candidates, context);
    if (!chosen) return null;

    // Return reference - actual instance activation is separate
    return {
      capabilityName: chosen.name,
      tenantId: "default", // In spike, single-tenant; multi-tenant would come from context
      credentialsRef: `${chosen.name}-credentials`,
    };
  }

  private getEligibleCapabilities(
    entitlement: EntitlementRef,
    context: ResolutionContext
  ): Capability[] {
    const eligible: Capability[] = [];
    
    for (const { capability } of this.capabilities.values()) {
      // Basic filter: capability must match the entitlement's provider
      // In reality, this would be more sophisticated (permission mappings, etc.)
      if (this.canFulfill(capability, entitlement, context)) {
        eligible.push(capability);
      }
    }
    
    return eligible;
  }

  private canFulfill(
    _capability: Capability,
    _entitlement: EntitlementRef,
    _context: ResolutionContext
  ): boolean {
    // For spike: simple provider match
    // Real implementation would check capability.metadata.supports,
    // permission mappings, etc.
    return true; // All registered capabilities are eligible in spike
  }

  private applyResolutionStrategy(
      candidates: Capability[],
      context: ResolutionContext
    ): Capability | null {
      if (candidates.length === 0) return null;

      // If policy has preferences, honor them
      if (context.policyPreferences?.preferredProviders) {
        for (const preferred of context.policyPreferences.preferredProviders) {
          const match = candidates.find(c => c.provider === preferred);
          if (match) return match;
        }
      }

      // Fallback: first match
      return candidates[0] ?? null;
    }

  getCapabilities(): ReadonlyMap<string, Capability> {
    const result = new Map<string, Capability>();
    for (const [name, { capability }] of this.capabilities) {
      result.set(name, capability);
    }
    return result;
  }

  getCapability(name: string): Capability | undefined {
    return this.capabilities.get(name)?.capability;
  }

  getCapabilitiesByPlugin(pluginId: PluginId): readonly Capability[] {
    const result: Capability[] = [];
    for (const { capability, pluginId: pId } of this.capabilities.values()) {
      if (pId === pluginId) {
        result.push(capability);
      }
    }
    return result;
  }

  async activate(
    tenantId: string,
    capabilityName: string,
    credentials: CapabilityCredentials
  ): Promise<CapabilityInstance> {
    const registered = this.capabilities.get(capabilityName);
    if (!registered) {
      throw new Error(`Capability not registered: ${capabilityName}`);
    }

    const existing = registered.instances.get(tenantId);
    if (existing && existing.state !== "disposed") {
      throw new Error(`Instance already active for tenant ${tenantId}: ${capabilityName}`);
    }

    const now = new Date();
    const instance: CapabilityInstance = {
      capability: registered.capability,
      tenantId,
      credentials,
      state: "activating",
      activatedAt: now,
      updatedAt: now,
    };

    registered.instances.set(tenantId, instance);
    
    // Simulate async activation
    await this.simulateActivation(instance);
    
    const updated: CapabilityInstance = {
      ...instance,
      state: "active",
      updatedAt: new Date(),
    };
    registered.instances.set(tenantId, updated);
    
    return updated;
  }

  private async simulateActivation(_instance: CapabilityInstance): Promise<void> {
    // In real implementation: validate credentials, establish connections, etc.
    // For spike: just a small delay
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  async degrade(tenantId: string, capabilityName: string): Promise<void> {
    const instance = this.getInstanceInternal(tenantId, capabilityName);
    if (!instance || instance.state === "disposed") return;

    const registered = this.capabilities.get(capabilityName)!;
    registered.instances.set(tenantId, {
      ...instance,
      state: "degraded",
      updatedAt: new Date(),
    });
  }

  async suspend(tenantId: string, capabilityName: string): Promise<void> {
    const instance = this.getInstanceInternal(tenantId, capabilityName);
    if (!instance || instance.state === "disposed") return;

    const registered = this.capabilities.get(capabilityName)!;
    registered.instances.set(tenantId, {
      ...instance,
      state: "suspended",
      updatedAt: new Date(),
    });
  }

  async dispose(tenantId: string, capabilityName: string): Promise<void> {
    await this.disposeInternal(tenantId, capabilityName);
  }

  private async disposeInternal(tenantId: string, capabilityName: string): Promise<void> {
    const registered = this.capabilities.get(capabilityName);
    if (!registered) return;

    const instance = registered.instances.get(tenantId);
    if (!instance) return;

    // In real implementation: close connections, revoke tokens, etc.
    await new Promise(resolve => setTimeout(resolve, 5));

    registered.instances.set(tenantId, {
      ...instance,
      state: "disposed",
      updatedAt: new Date(),
    });
  }

  async cleanup(tenantId: string): Promise<void> {
    for (const [capabilityName] of this.capabilities) {
      await this.disposeInternal(tenantId, capabilityName);
    }
  }

  getInstance(tenantId: string, capabilityName: string): CapabilityInstance | undefined {
    return this.getInstanceInternal(tenantId, capabilityName);
  }

  private getInstanceInternal(tenantId: string, capabilityName: string): CapabilityInstance | undefined {
    return this.capabilities.get(capabilityName)?.instances.get(tenantId);
  }

  getInstancesForTenant(tenantId: string): CapabilityInstance[] {
    const instances: CapabilityInstance[] = [];
    for (const { instances: instanceMap } of this.capabilities.values()) {
      const instance = instanceMap.get(tenantId);
      if (instance) instances.push(instance);
    }
    return instances;
  }
}

/** Resolution strategy for when multiple capabilities can fulfill */
export type ResolutionStrategy = "first-match" | "policy-preferred";