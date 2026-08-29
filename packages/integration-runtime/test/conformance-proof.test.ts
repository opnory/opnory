// packages/integration-runtime/test/conformance-proof.test.ts
// Conformance proof: runtime-loaded EntraAdapter and OktaAdapter pass the same harness as direct adapters

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { EntraAdapter } from "@opnory/governance-core/adapters";
import { OktaAdapter } from "@opnory/governance-core/adapters";
import { runFulfillmentAdapterCertification } from "@opnory/governance-core";
import type { FulfillmentAdapter, Permission, ResourceScope, SubjectRef, ResolvedSubject, EvidenceEvent } from "@opnory/governance-core";
import { CapabilityRegistry, InMemoryCapabilityRegistry } from "../src/registry";
import type { Capability } from "../src/capability";

describe("Conformance Proof: Runtime-loaded adapters pass unchanged harness", () => {
  let registry: CapabilityRegistry;
  
  beforeAll(() => {
    registry = new InMemoryCapabilityRegistry("policy-preferred");
  });

  afterAll(async () => {
    // Clean up any active instances
    await registry.cleanup("test-tenant");
  });

  beforeEach(async () => {
    // Clean up between tests to avoid registration conflicts
    await registry.cleanup("test-tenant");
    // Unregister all capabilities to ensure test isolation
    for (const name of registry.getCapabilities().keys()) {
      registry.unregister(name);
    }
  });

  describe("Direct adapter conformance (baseline)", () => {
    it("EntraAdapter passes conformance harness directly", async () => {
      // This requires live credentials - skipped in spike unless env vars present
      if (!process.env.OPNORY_ENTRA_TENANT_ID) {
        console.log("Skipping live Entra conformance - no credentials");
        return;
      }
      
      const adapter = new EntraAdapter({
        tenantId: process.env.OPNORY_ENTRA_TENANT_ID!,
        clientId: process.env.OPNORY_ENTRA_CLIENT_ID!,
        clientSecret: process.env.OPNORY_ENTRA_CLIENT_SECRET!,
      });
      
      const result = await runFulfillmentAdapterCertification({
        provider: "entra",
        adapter,
        subject: { type: "user", identifier: process.env.OPNORY_ENTRA_TEST_USER! },
        fixtures: [{ permission: { id: "test", name: "Test", description: "", mappings: [] }, roleId: "test-role" }],
        scope: { tenantId: process.env.OPNORY_ENTRA_TENANT_ID! },
      });
      
      expect(result.passed).toBe(true);
      expect(result.fixtures.length).toBeGreaterThan(0);
    });

    it("OktaAdapter passes conformance harness directly", async () => {
      // This requires live credentials - skipped in spike unless env vars present
      if (!process.env.OPNORY_OKTA_ORG_URL) {
        console.log("Skipping live Okta conformance - no credentials");
        return;
      }
      
      const adapter = new OktaAdapter({
        orgUrl: process.env.OPNORY_OKTA_ORG_URL!,
        apiToken: process.env.OPNORY_OKTA_API_TOKEN!,
      });
      
      const result = await runFulfillmentAdapterCertification({
        provider: "okta",
        adapter,
        subject: { type: "user", identifier: process.env.OPNORY_OKTA_TEST_USER! },
        fixtures: [{ permission: { id: "test", name: "Test", description: "", mappings: [] }, roleId: "test-role" }],
        scope: { tenantId: process.env.OPNORY_OKTA_ORG_URL! },
      });
      
      expect(result.passed).toBe(true);
      expect(result.fixtures.length).toBeGreaterThan(0);
    });
  });

  describe("Runtime-loaded adapter conformance (spike proof)", () => {
    it("EntraAdapter loaded through registry passes same harness", async () => {
      if (!process.env.OPNORY_ENTRA_TENANT_ID) {
        console.log("Skipping runtime Entra conformance - no credentials");
        return;
      }

      // Create capability wrapper for EntraAdapter
      const entraCapability: Capability = {
        name: "identity.governance.entra",
        version: "1.0.0",
        provider: "entra",
        fulfills: new EntraAdapter({
          tenantId: process.env.OPNORY_ENTRA_TENANT_ID!,
          clientId: process.env.OPNORY_ENTRA_CLIENT_ID!,
          clientSecret: process.env.OPNORY_ENTRA_CLIENT_SECRET!,
        }),
        metadata: {
          tenantScope: true,
          requiredSecrets: ["entra-client-secret"],
          supports: {
            eventualConsistency: true,
            batchOperations: false,
            dryRun: false,
          },
        },
      };

      registry.register(entraCapability);
      
      // Policy resolves provider (simulating core policy choosing Entra)
      const providerRef = registry.resolveProvider(
        { id: "test-entitlement" },
        { subject: { type: "user", identifier: "test" }, requestedPermissions: [] }
      );
      
      expect(providerRef).not.toBeNull();
      expect(providerRef!.capabilityName).toBe("identity.governance.entra");

      // Activate instance
      const instance = await registry.activate("test-tenant", "identity.governance.entra", {
        secrets: new Map([
          ["entra-client-secret", process.env.OPNORY_ENTRA_CLIENT_SECRET!],
        ]),
      });

      expect(instance.state).toBe("active");
      expect(instance.capability.provider).toBe("entra");

      // Run conformance harness on runtime-loaded adapter
      const result = await runFulfillmentAdapterCertification({
        provider: "entra",
        adapter: instance.capability.fulfills,
        subject: { type: "user", identifier: process.env.OPNORY_ENTRA_TEST_USER! },
        fixtures: [{ permission: { id: "test", name: "Test", description: "", mappings: [] }, roleId: "test-role" }],
        scope: { tenantId: process.env.OPNORY_ENTRA_TENANT_ID! },
      });
      
      expect(result.passed).toBe(true);
      expect(result.fixtures.length).toBeGreaterThan(0);

      // Cleanup
      await registry.dispose("test-tenant", "identity.governance.entra");
    });

    it("OktaAdapter loaded through registry passes same harness", async () => {
      if (!process.env.OPNORY_OKTA_ORG_URL) {
        console.log("Skipping runtime Okta conformance - no credentials");
        return;
      }

      // Create capability wrapper for OktaAdapter
      const oktaCapability: Capability = {
        name: "identity.governance.okta",
        version: "1.0.0",
        provider: "okta",
        fulfills: new OktaAdapter({
          orgUrl: process.env.OPNORY_OKTA_ORG_URL!,
          apiToken: process.env.OPNORY_OKTA_API_TOKEN!,
        }),
        metadata: {
          tenantScope: true,
          requiredSecrets: ["okta-api-token"],
          supports: {
            eventualConsistency: false,
            batchOperations: true,
            dryRun: true,
          },
        },
      };

      registry.register(oktaCapability);
      
      // Policy resolves provider (simulating core policy choosing Okta)
      const providerRef = registry.resolveProvider(
        { id: "test-entitlement" },
        { 
          subject: { type: "user", identifier: "test" }, 
          requestedPermissions: [],
          policyPreferences: { preferredProviders: ["okta"] }
        }
      );
      
      expect(providerRef).not.toBeNull();
      expect(providerRef!.capabilityName).toBe("identity.governance.okta");

      // Activate instance
      const instance = await registry.activate("test-tenant", "identity.governance.okta", {
        secrets: new Map([
          ["okta-api-token", process.env.OPNORY_OKTA_API_TOKEN!],
        ]),
      });

      expect(instance.state).toBe("active");
      expect(instance.capability.provider).toBe("okta");

      // Run conformance harness on runtime-loaded adapter
      const result = await runFulfillmentAdapterCertification({
        provider: "okta",
        adapter: instance.capability.fulfills,
        subject: { type: "user", identifier: process.env.OPNORY_OKTA_TEST_USER! },
        fixtures: [{ permission: { id: "test", name: "Test", description: "", mappings: [] }, roleId: "test-role" }],
        scope: { tenantId: process.env.OPNORY_OKTA_ORG_URL! },
      });
      
      expect(result.passed).toBe(true);
      expect(result.fixtures.length).toBeGreaterThan(0);

      // Cleanup
      await registry.dispose("test-tenant", "identity.governance.okta");
    });

    it("Registry policy-preferred resolution honors core policy choice", async () => {
      // Register both capabilities
      const entraCapability: Capability = {
        name: "identity.governance.entra",
        version: "1.0.0",
        provider: "entra",
        fulfills: {} as FulfillmentAdapter, // Mock for unit test
        metadata: {
          tenantScope: true,
          requiredSecrets: [],
          supports: { eventualConsistency: true, batchOperations: false, dryRun: false },
        },
      };

      const oktaCapability: Capability = {
        name: "identity.governance.okta",
        version: "1.0.0",
        provider: "okta",
        fulfills: {} as FulfillmentAdapter, // Mock for unit test
        metadata: {
          tenantScope: true,
          requiredSecrets: [],
          supports: { eventualConsistency: false, batchOperations: true, dryRun: true },
        },
      };

      registry.register(entraCapability);
      registry.register(oktaCapability);

      // Policy prefers Okta - registry should honor this
      const providerRef = registry.resolveProvider(
        { id: "test-entitlement" },
        { 
          subject: { type: "user", identifier: "test" }, 
          requestedPermissions: [],
          policyPreferences: { preferredProviders: ["okta"] }
        }
      );
      
      expect(providerRef!.capabilityName).toBe("identity.governance.okta");
      expect(providerRef!.capabilityName).not.toBe("identity.governance.entra");

      // Policy prefers Entra - registry should honor this
      const providerRef2 = registry.resolveProvider(
        { id: "test-entitlement" },
        { 
          subject: { type: "user", identifier: "test" }, 
          requestedPermissions: [],
          policyPreferences: { preferredProviders: ["entra"] }
        }
      );
      
      expect(providerRef2!.capabilityName).toBe("identity.governance.entra");
    });

    it("Registry does NOT make authorization decisions", () => {
      // The registry only exposes eligible providers and honors policy preferences
      // It never decides allow/deny - that's core policy's job
      const capability: Capability = {
        name: "identity.governance.entra.noauth",
        version: "1.0.0",
        provider: "entra",
        fulfills: {} as FulfillmentAdapter,
        metadata: {
          tenantScope: true,
          requiredSecrets: [],
          supports: { eventualConsistency: true, batchOperations: false, dryRun: false },
        },
      };

      registry.register(capability);

      // Registry returns a provider reference - NOT an authorization decision
      const providerRef = registry.resolveProvider(
        { id: "some-entitlement" },
        { subject: { type: "user", identifier: "test" }, requestedPermissions: [] }
      );

      // ProviderRef is just a reference to activate - no allow/deny semantics
      expect(providerRef).toBeDefined();
      expect(providerRef!.capabilityName).toBe("identity.governance.entra.noauth");
      // No "allowed", "denied", "approved" fields - those are PolicyEvaluationResult
    });

    it("Lifecycle operations: activate -> degrade -> suspend -> dispose -> cleanup", async () => {
      const capability: Capability = {
        name: "identity.governance.test.lifecycle",
        version: "1.0.0",
        provider: "test",
        fulfills: {} as FulfillmentAdapter,
        metadata: {
          tenantScope: true,
          requiredSecrets: [],
          supports: { eventualConsistency: false, batchOperations: false, dryRun: true },
        },
      };

      registry.register(capability);

      // Activate
      const instance = await registry.activate("test-tenant", "identity.governance.test.lifecycle", {
        secrets: new Map(),
      });
      expect(instance.state).toBe("active");

      // Degrade
      await registry.degrade("test-tenant", "identity.governance.test.lifecycle");
      const degraded = registry.getInstance("test-tenant", "identity.governance.test.lifecycle");
      expect(degraded!.state).toBe("degraded");

      // Suspend
      await registry.suspend("test-tenant", "identity.governance.test.lifecycle");
      const suspended = registry.getInstance("test-tenant", "identity.governance.test.lifecycle");
      expect(suspended!.state).toBe("suspended");

      // Dispose
      await registry.dispose("test-tenant", "identity.governance.test.lifecycle");
      const disposed = registry.getInstance("test-tenant", "identity.governance.test.lifecycle");
      expect(disposed!.state).toBe("disposed");

      // Cleanup (idempotent)
      await registry.cleanup("test-tenant");
      const afterCleanup = registry.getInstance("test-tenant", "identity.governance.test.lifecycle");
      expect(afterCleanup!.state).toBe("disposed");
    });

    it("Tenant-scoped instances are isolated", async () => {
      const capability: Capability = {
        name: "identity.governance.test.isolated",
        version: "1.0.0",
        provider: "test",
        fulfills: {} as FulfillmentAdapter,
        metadata: {
          tenantScope: true,
          requiredSecrets: [],
          supports: { eventualConsistency: false, batchOperations: false, dryRun: true },
        },
      };

      registry.register(capability);

      await registry.activate("tenant-a", "identity.governance.test.isolated", { secrets: new Map() });
      await registry.activate("tenant-b", "identity.governance.test.isolated", { secrets: new Map() });

      const tenantA = registry.getInstance("tenant-a", "identity.governance.test.isolated");
      const tenantB = registry.getInstance("tenant-b", "identity.governance.test.isolated");

      expect(tenantA).toBeDefined();
      expect(tenantB).toBeDefined();
      expect(tenantA).not.toBe(tenantB);

      // Degrade tenant A only
      await registry.degrade("tenant-a", "identity.governance.test.isolated");
      expect(registry.getInstance("tenant-a", "identity.governance.test.isolated")!.state).toBe("degraded");
      expect(registry.getInstance("tenant-b", "identity.governance.test.isolated")!.state).toBe("active");

      await registry.cleanup("tenant-a");
      await registry.cleanup("tenant-b");
    });
  });
});