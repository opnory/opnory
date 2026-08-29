// packages/integration-runtime/plugins/okta-plugin.ts
// Okta first-party plugin — wraps the certified OktaAdapter

import type {
  Plugin,
  PluginManifest,
  PluginActivationContext,
  PluginActivationResult,
  Capability,
  CredentialHandle,
  TenantId,
  PluginId,
} from "../src/plugin.js";
import type { FulfillmentAdapter } from "../src/types.js";
import { OktaAdapter } from "@opnory/governance-core/adapters";

export const oktaPluginManifest: PluginManifest = {
  name: "okta",
  version: "1.0.0",
  description: "Okta integration for identity governance",
  provides: [
    {
      id: "identity.resolve@v1",
      version: "1.0.0",
      description: "Resolves subjects in Okta (users, groups)",
    },
    {
      id: "fulfillment.access@v1",
      version: "1.0.0",
      description: "Grants/revokes Okta group memberships and app assignments",
    },
  ],
  requires: [
    {
      id: "core.secrets@v1",
      version: "^1.0.0",
      required: true,
    },
    {
      id: "core.http@v1",
      version: "^1.0.0",
      required: true,
    },
  ],
  scope: "tenant",
  secrets: [
    {
      key: "okta-org-url",
      description: "Okta organization URL (e.g., https://company.okta.com)",
      required: true,
    },
    {
      key: "okta-client-id",
      description: "Okta API Services app Client ID",
      required: true,
    },
    {
      key: "okta-private-key-path",
      description: "Path to Okta API Services app private key (PEM)",
      required: true,
    },
    {
      key: "okta-key-id",
      description: "Key ID (KID) registered in Okta API Services app Public Keys",
      required: true,
    },
    {
      key: "okta-private-key-passphrase",
      description: "Optional passphrase for the private key",
      required: false,
    },
  ],
  network: [
    {
      host: "*.okta.com",
      protocol: "https",
      description: "Okta API endpoints",
    },
    {
      host: "*.oktapreview.com",
      protocol: "https",
      description: "Okta preview API endpoints",
    },
  ],
  minRuntimeVersion: "0.1.0",
};

export const oktaPlugin: Plugin = {
  manifest: oktaPluginManifest,

  async activate(ctx: PluginActivationContext): Promise<PluginActivationResult> {
    const { tenantId, services } = ctx;

    // Resolve credentials from core credential provider
    const [orgUrlHandle, clientIdHandle, privateKeyPathHandle, keyIdHandle, passphraseHandle] = await Promise.all([
      services.credentials.resolve(tenantId, "okta", "okta-org-url"),
      services.credentials.resolve(tenantId, "okta", "okta-client-id"),
      services.credentials.resolve(tenantId, "okta", "okta-private-key-path"),
      services.credentials.resolve(tenantId, "okta", "okta-key-id"),
      services.credentials.resolve(tenantId, "okta", "okta-private-key-passphrase"),
    ]);

    if (!orgUrlHandle || !clientIdHandle || !privateKeyPathHandle || !keyIdHandle) {
      throw new Error("Missing required Okta credentials");
    }

    // Extract secret values from handles
    const orgUrl = orgUrlHandle.id;
    const clientId = clientIdHandle.id;
    const privateKeyPath = privateKeyPathHandle.id;
    const keyId = keyIdHandle.id;
    const privateKeyPassphrase = passphraseHandle?.id;

    // Create the certified OktaAdapter
    const adapter = new OktaAdapter({
      orgUrl,
      clientId,
      privateKeyPath,
      privateKeyPassphrase,
      keyId,
    });

    // Register capabilities
    const capabilities: Capability[] = [
      {
        name: "identity.governance.okta",
        version: "1.0.0",
        provider: "okta",
        fulfills: adapter,
        metadata: {
          tenantScope: true,
          requiredSecrets: ["okta-api-token", "okta-org-url"],
          supports: {
            eventualConsistency: false,
            batchOperations: true,
            dryRun: true,
          },
        },
      },
    ];

    return { capabilities };
  },

  async degrade(ctx: PluginActivationContext): Promise<void> {
    ctx.services.logger.warn("Okta plugin degraded", { tenantId: ctx.tenantId, pluginId: ctx.pluginId });
  },

  async suspend(ctx: PluginActivationContext): Promise<void> {
    ctx.services.logger.info("Okta plugin suspended", { tenantId: ctx.tenantId, pluginId: ctx.pluginId });
  },

  async dispose(ctx: PluginActivationContext): Promise<void> {
    ctx.services.logger.info("Okta plugin disposed", { tenantId: ctx.tenantId, pluginId: ctx.pluginId });
  },
};