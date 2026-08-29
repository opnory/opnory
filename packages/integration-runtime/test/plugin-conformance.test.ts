// packages/integration-runtime/test/plugin-conformance.test.ts
// Conformance proof: plugin-loaded Entra/Okta adapters pass the same harness as direct adapters

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { EntraAdapter } from "@opnory/governance-core/adapters";
import { OktaAdapter } from "@opnory/governance-core/adapters";
import { runFulfillmentAdapterCertification } from "@opnory/governance-core";
import type { FulfillmentAdapter } from "@opnory/governance-core";
import type { Capability } from "../src/capability.js";
import type { EntitlementRef } from "../src/types.js";
import {
  InMemoryCredentialProvider,
  InMemoryRuntimeEventBus,
  DefaultHttpClientFactory,
  ConsoleLogger,
} from "../src/loader.js";
import { InMemoryCapabilityRegistry } from "../src/registry.js";
import { DefaultPluginLoader } from "../src/loader.js";
import { entraPlugin } from "../plugins/entra-plugin.js";
import { oktaPlugin } from "../plugins/okta-plugin.js";
import { tenantId, pluginId } from "../src/plugin.js";
import type { TenantId, PluginId, CoreServices } from "../src/plugin.js";

describe("Conformance Proof: Plugin-loaded adapters pass unchanged harness", () => {
  let registry: InMemoryCapabilityRegistry;
  let credentialProvider: InMemoryCredentialProvider;
  let eventBus: InMemoryRuntimeEventBus;
  let httpFactory: DefaultHttpClientFactory;
  let logger: ConsoleLogger;
  let coreServices: CoreServices;
  let loader: DefaultPluginLoader;
  const TEST_TENANT = tenantId("test-tenant");

  beforeAll(() => {
    registry = new InMemoryCapabilityRegistry("policy-preferred");
    credentialProvider = new InMemoryCredentialProvider();
    eventBus = new InMemoryRuntimeEventBus();
    httpFactory = new DefaultHttpClientFactory();
    logger = new ConsoleLogger();

    coreServices = {
      credentials: credentialProvider,
      http: httpFactory,
      logger,
      events: eventBus,
      capabilities: registry,
    };

    loader = new DefaultPluginLoader(registry, coreServices);
    loader.registerPlugin(entraPlugin);
    loader.registerPlugin(oktaPlugin);
  });

  afterAll(async () => {
    await registry.cleanup(TEST_TENANT);
  });

  beforeEach(async () => {
    await registry.cleanup(TEST_TENANT);
    for (const name of registry.getCapabilities().keys()) {
      registry.unregister(name);
    }
  });

  describe("Direct adapter conformance (baseline)", () => {
    it("EntraAdapter passes conformance harness directly", async () => {
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

  describe("Plugin-loaded adapter conformance (first-party plugin proof)", () => {
    it("Entra plugin loaded through loader passes same harness", async () => {
      if (!process.env.OPNORY_ENTRA_TENANT_ID) {
        console.log("Skipping plugin Entra conformance - no credentials");
        return;
      }

      // Pre-populate credentials
      credentialProvider.setSecret(TEST_TENANT, "entra", "entra-client-secret", {
        id: process.env.OPNORY_ENTRA_CLIENT_SECRET!,
        type: "client-secret",
      } as any);
      credentialProvider.setSecret(TEST_TENANT, "entra", "entra-tenant-id", {
        id: process.env.OPNORY_ENTRA_TENANT_ID!,
        type: "custom",
      } as any);
      credentialProvider.setSecret(TEST_TENANT, "entra", "entra-client-id", {
        id: process.env.OPNORY_ENTRA_CLIENT_ID!,
        type: "custom",
      } as any);
      credentialProvider.setSecret(TEST_TENANT, "entra", "entra-service-principal-id", {
        id: process.env.OPNORY_ENTRA_SERVICE_PRINCIPAL_ID!,
        type: "custom",
      } as any);

      // Load plugin
      const loadedPlugin = await loader.load(entraPlugin, TEST_TENANT, {});

      expect(loadedPlugin.state).toBe("active");
      expect(loadedPlugin.capabilities.length).toBeGreaterThan(0);

      const capability = loadedPlugin.capabilities[0];
      expect(capability.provider).toBe("entra");
      expect(capability.fulfills).toBeInstanceOf(EntraAdapter);

      // Run conformance harness on plugin-loaded adapter
      const result = await runFulfillmentAdapterCertification({
        provider: "entra",
        adapter: capability.fulfills,
        subject: { type: "user", identifier: process.env.OPNORY_ENTRA_TEST_USER! },
        fixtures: [{ permission: { id: "test", name: "Test", description: "", mappings: [] }, roleId: "test-role" }],
        scope: { tenantId: process.env.OPNORY_ENTRA_TENANT_ID! },
      });

      expect(result.passed).toBe(true);
      expect(result.fixtures.length).toBeGreaterThan(0);

      // Unload plugin
      await loader.unload(pluginId("entra"), TEST_TENANT);
    });

    it("Okta plugin loaded through loader passes same harness", async () => {
      if (!process.env.OPNORY_OKTA_ORG_URL) {
        console.log("Skipping plugin Okta conformance - no credentials");
        return;
      }

      // Pre-populate credentials
      credentialProvider.setSecret(TEST_TENANT, "okta", "okta-org-url", {
        id: process.env.OPNORY_OKTA_ORG_URL!,
        type: "custom",
      } as any);
      credentialProvider.setSecret(TEST_TENANT, "okta", "okta-client-id", {
        id: process.env.OPNORY_OKTA_CLIENT_ID!,
        type: "custom",
      } as any);
      credentialProvider.setSecret(TEST_TENANT, "okta", "okta-private-key-path", {
        id: process.env.OPNORY_OKTA_PRIVATE_KEY_PATH!,
        type: "custom",
      } as any);
      credentialProvider.setSecret(TEST_TENANT, "okta", "okta-key-id", {
        id: process.env.OPNORY_OKTA_KEY_ID!,
        type: "custom",
      } as any);
      credentialProvider.setSecret(TEST_TENANT, "okta", "okta-private-key-passphrase", {
        id: process.env.OPNORY_OKTA_PRIVATE_KEY_PASSPHRASE || "",
        type: "custom",
      } as any);

      // Load plugin
      const loadedPlugin = await loader.load(oktaPlugin, TEST_TENANT, {});

      expect(loadedPlugin.state).toBe("active");
      expect(loadedPlugin.capabilities.length).toBeGreaterThan(0);

      const capability = loadedPlugin.capabilities[0];
      expect(capability.provider).toBe("okta");
      expect(capability.fulfills).toBeInstanceOf(OktaAdapter);

      // Run conformance harness on plugin-loaded adapter
      const result = await runFulfillmentAdapterCertification({
        provider: "okta",
        adapter: capability.fulfills,
        subject: { type: "user", identifier: process.env.OPNORY_OKTA_TEST_USER! },
        fixtures: [{ permission: { id: "test", name: "Test", description: "", mappings: [] }, roleId: "test-role" }],
        scope: { tenantId: process.env.OPNORY_OKTA_ORG_URL! },
      });

      expect(result.passed).toBe(true);
      expect(result.fixtures.length).toBeGreaterThan(0);

      // Unload plugin
      await loader.unload("okta", TEST_TENANT);
    });

    it("Both plugins can be loaded simultaneously for same tenant", async () => {
      // This test requires live credentials to instantiate the adapters
      // Skip if not available (unit test environment doesn't have mock key files)
      if (!process.env.OPNORY_ENTRA_TENANT_ID || !process.env.OPNORY_OKTA_ORG_URL) {
        console.log("Skipping simultaneous load test - no live credentials");
        return;
      }

      // Pre-populate credentials for Entra
      credentialProvider.setSecret(TEST_TENANT, "entra", "entra-client-secret", {
        id: process.env.OPNORY_ENTRA_CLIENT_SECRET!,
        type: "client-secret",
      } as any);
      credentialProvider.setSecret(TEST_TENANT, "entra", "entra-tenant-id", {
        id: process.env.OPNORY_ENTRA_TENANT_ID!,
        type: "custom",
      } as any);
      credentialProvider.setSecret(TEST_TENANT, "entra", "entra-client-id", {
        id: process.env.OPNORY_ENTRA_CLIENT_ID!,
        type: "custom",
      } as any);
      credentialProvider.setSecret(TEST_TENANT, "entra", "entra-service-principal-id", {
        id: process.env.OPNORY_ENTRA_SERVICE_PRINCIPAL_ID!,
        type: "custom",
      } as any);
      credentialProvider.setSecret(TEST_TENANT, "entra", "entra-enterprise-app-object-id", {
        id: process.env.OPNORY_ENTRA_ENTERPRISE_APP_OBJECT_ID!,
        type: "custom",
      } as any);

      // Pre-populate credentials for Okta
      credentialProvider.setSecret(TEST_TENANT, "okta", "okta-org-url", {
        id: process.env.OPNORY_OKTA_ORG_URL!,
        type: "custom",
      } as any);
      credentialProvider.setSecret(TEST_TENANT, "okta", "okta-client-id", {
        id: process.env.OPNORY_OKTA_CLIENT_ID!,
        type: "custom",
      } as any);
      credentialProvider.setSecret(TEST_TENANT, "okta", "okta-private-key-path", {
        id: process.env.OPNORY_OKTA_PRIVATE_KEY_PATH!,
        type: "custom",
      } as any);
      credentialProvider.setSecret(TEST_TENANT, "okta", "okta-key-id", {
        id: process.env.OPNORY_OKTA_KEY_ID!,
        type: "custom",
      } as any);
      credentialProvider.setSecret(TEST_TENANT, "okta", "okta-private-key-passphrase", {
        id: process.env.OPNORY_OKTA_PRIVATE_KEY_PASSPHRASE || "",
        type: "custom",
      } as any);

      // Load both plugins
      const entraLoaded = await loader.load(entraPlugin, TEST_TENANT, {});
      const oktaLoaded = await loader.load(oktaPlugin, TEST_TENANT, {});

      expect(entraLoaded.state).toBe("active");
      expect(oktaLoaded.state).toBe("active");
      expect(entraLoaded.capabilities[0].provider).toBe("entra");
      expect(oktaLoaded.capabilities[0].provider).toBe("okta");

      // Both capabilities registered
      const allCapabilities = registry.getCapabilities();
      expect(allCapabilities.has("identity.governance.entra")).toBe(true);
      expect(allCapabilities.has("identity.governance.okta")).toBe(true);

      // Policy resolution works
      const providerRef = registry.resolveProvider(
        { id: "test-entitlement", name: "test", system: "test" } as EntitlementRef,
        { subject: { type: "user", identifier: "test" }, requestedPermissions: [], policyPreferences: { preferredProviders: ["okta"] } }
      );
      expect(providerRef!.capabilityName).toBe("identity.governance.okta");

      // Cleanup
      await loader.unload(pluginId("entra"), TEST_TENANT);
      await loader.unload(pluginId("okta"), TEST_TENANT);
    });

    it("Plugin lifecycle events are emitted", async () => {
      // This test requires live credentials to instantiate the adapters
      // Skip if not available (unit test environment doesn't have mock key files)
      if (!process.env.OPNORY_ENTRA_TENANT_ID) {
        console.log("Skipping lifecycle events test - no live credentials");
        return;
      }

      const events: string[] = [];
      
      eventBus.subscribe("plugin.activated", (e) => events.push(`activated:${e.pluginId}`));
      eventBus.subscribe("plugin.degraded", (e) => events.push(`degraded:${e.pluginId}`));
      eventBus.subscribe("plugin.suspended", (e) => events.push(`suspended:${e.pluginId}`));
      eventBus.subscribe("plugin.disposed", (e) => events.push(`disposed:${e.pluginId}`));
      eventBus.subscribe("capability.available", (e) => events.push(`capability.available:${e.capabilityName}`));
      eventBus.subscribe("capability.unavailable", (e) => events.push(`capability.unavailable:${e.capabilityName}`));

      // Use live credentials
      credentialProvider.setSecret(TEST_TENANT, "entra", "entra-client-secret", {
        id: process.env.OPNORY_ENTRA_CLIENT_SECRET!,
        type: "client-secret",
      } as any);
      credentialProvider.setSecret(TEST_TENANT, "entra", "entra-tenant-id", {
        id: process.env.OPNORY_ENTRA_TENANT_ID!,
        type: "custom",
      } as any);
      credentialProvider.setSecret(TEST_TENANT, "entra", "entra-client-id", {
        id: process.env.OPNORY_ENTRA_CLIENT_ID!,
        type: "custom",
      } as any);
      credentialProvider.setSecret(TEST_TENANT, "entra", "entra-service-principal-id", {
        id: process.env.OPNORY_ENTRA_SERVICE_PRINCIPAL_ID!,
        type: "custom",
      } as any);
      credentialProvider.setSecret(TEST_TENANT, "entra", "entra-enterprise-app-object-id", {
        id: process.env.OPNORY_ENTRA_ENTERPRISE_APP_OBJECT_ID!,
        type: "custom",
      } as any);

      await loader.load(entraPlugin, TEST_TENANT, {});
      expect(events).toContain("activated:entra");
      expect(events).toContain("capability.available:identity.governance.entra");

      await loader.unload(pluginId("entra"), TEST_TENANT);
      expect(events).toContain("disposed:entra");
      expect(events).toContain("capability.unavailable:identity.governance.entra");
    });
  });
});