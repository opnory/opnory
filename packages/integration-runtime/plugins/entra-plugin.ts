// packages/integration-runtime/plugins/entra-plugin.ts
// Entra first-party plugin — wraps the certified EntraAdapter

import type {
  Plugin,
  PluginManifest,
  PluginActivationContext,
  PluginActivationResult,
  Capability,
} from "../src/plugin.js";
import { EntraAdapter } from "@opnory/governance-core/adapters";

export const entraPluginManifest: PluginManifest = {
  name: "entra",
  version: "1.0.0",
  description: "Microsoft Entra ID (Azure AD) integration for identity governance",
  provides: [
    {
      id: "identity.resolve@v1",
      version: "1.0.0",
      description: "Resolves subjects in Entra ID (users, groups, service principals)",
    },
    {
      id: "fulfillment.access@v1",
      version: "1.0.0",
      description: "Grants/revokes Entra ID group memberships and app role assignments",
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
      key: "entra-client-secret",
      description: "Entra ID application client secret",
      required: true,
    },
    {
      key: "entra-tenant-id",
      description: "Entra ID tenant ID",
      required: true,
    },
    {
      key: "entra-client-id",
      description: "Entra ID application client ID",
      required: true,
    },
    {
      key: "entra-service-principal-id",
      description: "Entra ID service principal object ID (for governance API)",
      required: true,
    },
    {
      key: "entra-enterprise-app-object-id",
      description: "Entra ID enterprise application object ID (for governance API)",
      required: true,
    },
  ],
  network: [
    {
      host: "graph.microsoft.com",
      protocol: "https",
      description: "Microsoft Graph API",
    },
    {
      host: "login.microsoftonline.com",
      protocol: "https",
      description: "Microsoft identity platform token endpoint",
    },
  ],
  minRuntimeVersion: "0.1.0",
};

export const entraPlugin: Plugin = {
  manifest: entraPluginManifest,

  async activate(ctx: PluginActivationContext): Promise<PluginActivationResult> {
    const { tenantId, services } = ctx;

    // Resolve credentials from core credential provider
    const [clientSecretHandle, tenantIdHandle, clientIdHandle, servicePrincipalIdHandle, enterpriseAppObjectIdHandle] = await Promise.all([
      services.credentials.resolve(tenantId, "entra", "entra-client-secret"),
      services.credentials.resolve(tenantId, "entra", "entra-tenant-id"),
      services.credentials.resolve(tenantId, "entra", "entra-client-id"),
      services.credentials.resolve(tenantId, "entra", "entra-service-principal-id"),
      services.credentials.resolve(tenantId, "entra", "entra-enterprise-app-object-id"),
    ]);

    if (!clientSecretHandle || !tenantIdHandle || !clientIdHandle || !servicePrincipalIdHandle || !enterpriseAppObjectIdHandle) {
      throw new Error("Missing required Entra credentials");
    }

    // Extract secret values from handles (in real implementation, handles would provide secure access)
    const clientSecret = clientSecretHandle.id;
    const tenantIdValue = tenantIdHandle.id;
    const clientIdValue = clientIdHandle.id;
    const servicePrincipalId = servicePrincipalIdHandle.id;
    const enterpriseAppObjectId = enterpriseAppObjectIdHandle.id;

    // Create the certified EntraAdapter
    const adapter = new EntraAdapter({
      tenantId: tenantIdValue,
      clientId: clientIdValue,
      clientSecret,
      servicePrincipalId,
      enterpriseAppObjectId,
    });

    // Register capabilities
    const capabilities: Capability[] = [
      {
        name: "identity.governance.entra",
        version: "1.0.0",
        provider: "entra",
        fulfills: adapter,
        metadata: {
          tenantScope: true,
          requiredSecrets: ["entra-client-secret", "entra-tenant-id", "entra-client-id"],
          supports: {
            eventualConsistency: true,
            batchOperations: false,
            dryRun: false,
          },
        },
      },
    ];

    return { capabilities };
  },

  async degrade(ctx: PluginActivationContext): Promise<void> {
    // Entra adapter degradation - could invalidate token cache, switch to degraded mode
    ctx.services.logger.warn("Entra plugin degraded", { tenantId: ctx.tenantId, pluginId: ctx.pluginId });
  },

  async suspend(ctx: PluginActivationContext): Promise<void> {
    // Suspend - temporary pause
    ctx.services.logger.info("Entra plugin suspended", { tenantId: ctx.tenantId, pluginId: ctx.pluginId });
  },

  async dispose(ctx: PluginActivationContext): Promise<void> {
    // Cleanup - EntraAdapter doesn't hold persistent connections, but log for audit
    ctx.services.logger.info("Entra plugin disposed", { tenantId: ctx.tenantId, pluginId: ctx.pluginId });
  },
};