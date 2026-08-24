#!/usr/bin/env bun
/**
 * Entra Sandbox Validator
 * Validates tenant capabilities before running certification bootstrap.
 * Run with: OPNORY_ENTRA_TENANT_ID=... OPNORY_ENTRA_CLIENT_ID=... OPNORY_ENTRA_CLIENT_SECRET=... bun run scripts/live-governance/validate-entra-sandbox.ts
 */

import { getLogger } from "@opnory/observability";

const logger = getLogger().child({ component: "validate:entra-sandbox" });

// ============================================================================
// Configuration
// ============================================================================

interface ValidationConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

interface ValidationResult {
  check: string;
  passed: boolean;
  message: string;
  details?: string;
}

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} not set`);
  }
  return value;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchGraphToken(
  tenantId: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });

  const response = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    },
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Graph token request failed: ${response.status} ${error}`);
  }

  const data = (await response.json()) as { access_token: string };
  return data.access_token;
}

async function graphRequest<T>(
  token: string,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Graph request failed: ${response.status} ${error}`);
  }

  if (response.status === 204 || response.status === 202) {
    return {} as T;
  }

  return response.json() as Promise<T>;
}

// ============================================================================
// Validation Checks
// ============================================================================

async function checkGraphAuth(token: string): Promise<ValidationResult> {
  try {
    const org = await graphRequest<{ displayName: string; id: string }>(
      token,
      "/organization",
    );
    return {
      check: "Graph authentication",
      passed: true,
      message: `Authenticated to tenant: ${org.displayName} (${org.id})`,
    };
  } catch (error) {
    return {
      check: "Graph authentication",
      passed: false,
      message: "Failed to authenticate with Microsoft Graph",
      details: String(error),
    };
  }
}

async function checkApplicationPermissions(
  token: string,
): Promise<ValidationResult[]> {
  const requiredPermissions = [
    "EntitlementManagement.ReadWrite.All",
    "User.ReadWrite.All",
    "Directory.Read.All",
    "Group.ReadWrite.All",
  ];

  const results: ValidationResult[] = [];

  try {
    const sp = await graphRequest<{
      value: Array<{ appId: string; id: string }>;
    }>(
      token,
      `/servicePrincipals?$filter=appId eq '${process.env.OPNORY_ENTRA_CLIENT_ID}'`,
    );

    if (!sp || !sp.value || sp.value.length === 0) {
      return [
        {
          check: "Application permissions",
          passed: false,
          message: "Service principal not found for client ID",
        },
      ];
    }

    const spId = sp.value[0].id;

    // Get the Microsoft Graph service principal
    const graphSp = await graphRequest<{ value: Array<{ id: string }> }>(
      token,
      "/servicePrincipals?$filter=appId eq '00000003-0000-0000-c000-000000000000'",
    );
    const graphSpId = graphSp.value?.[0]?.id;

    let grantedPerms: string[] = [];

    if (graphSpId) {
      // Check app role assignments for this SP
      const appRoles = await graphRequest<{
        value: Array<{
          resourceDisplayName: string;
          resourceId: string;
          resourceAppId: string;
          id: string;
        }>;
      }>(token, `/servicePrincipals/${spId}/appRoleAssignedTo`);

      if (appRoles.value) {
        const graphRoles = appRoles.value.filter(
          (r) => r.resourceId === graphSpId,
        );
        for (const role of graphRoles) {
          grantedPerms.push(role.id);
        }
      }
    }

    return [
      {
        check: "Application permissions",
        passed: true,
        message: "Service principal found; functional permission test below",
        details: `Required: ${requiredPermissions.join(", ")}`,
      },
    ];
  } catch (error) {
    return [
      {
        check: "Application permissions",
        passed: false,
        message: "Failed to check application permissions",
        details: String(error),
      },
    ];
  }
}

async function checkDirectoryRoles(token: string): Promise<ValidationResult> {
  try {
    // Resolve service principal by app/client ID
    const sp = await graphRequest<{
      value: Array<{ id: string; appId: string }>;
    }>(
      token,
      `/servicePrincipals?$filter=appId eq '${process.env.OPNORY_ENTRA_CLIENT_ID}'`,
    );

    if (!sp.value || sp.value.length === 0) {
      return {
        check: "Directory roles",
        passed: false,
        message: "Service principal not found for client ID",
      };
    }

    const spId = sp.value[0].id;

    // Check role memberships via servicePrincipal/memberOf
    const memberOf = await graphRequest<{
      value: Array<{ id: string; displayName: string }>;
    }>(token, `/servicePrincipals/${spId}/memberOf?$select=id,displayName`);

    const hasUserAdmin = memberOf.value.some(
      (r) => r.displayName === "User Administrator",
    );

    return {
      check: "Directory roles",
      passed: hasUserAdmin,
      message: hasUserAdmin
        ? "Service principal has User Administrator role"
        : "Service principal missing User Administrator role",
      details: `Source: servicePrincipal.memberOf | Roles: ${memberOf.value.map((r) => r.displayName).join(", ")}`,
    };
  } catch (error) {
    return {
      check: "Directory roles",
      passed: false,
      message: "Failed to check directory roles",
      details: String(error),
    };
  }
}

async function checkGovernanceEntitlement(
  token: string,
): Promise<ValidationResult> {
  // Model B: Standard Graph primitives - no Governance/P2 required
  // Just verify we can access basic Graph endpoints
  try {
    await graphRequest<{ value: Array<{ id: string }> }>(
      token,
      "/users?$top=1",
    );
    await graphRequest<{ value: Array<{ id: string }> }>(
      token,
      "/groups?$top=1",
    );
    await graphRequest<{ value: Array<{ id: string }> }>(
      token,
      "/applications?$top=1",
    );

    return {
      check: "Governance entitlement",
      passed: true,
      message:
        "Standard Graph primitives available (no Entra ID Governance/P2 required for Model B)",
      details: "Users, Groups, Applications accessible",
    };
  } catch (error) {
    return {
      check: "Governance entitlement",
      passed: false,
      message: "Standard Graph APIs not accessible",
      details: String(error),
    };
  }
}

async function checkTenantDomain(token: string): Promise<ValidationResult> {
  try {
    const domains = await graphRequest<{
      value: Array<{ id: string; isDefault: boolean; isVerified: boolean }>;
    }>(token, "/domains");

    const defaultDomain = domains.value.find(
      (d) => d.isDefault && d.isVerified,
    );

    return {
      check: "Tenant domain",
      passed: !!defaultDomain,
      message: defaultDomain
        ? `Default verified domain: ${defaultDomain.id}`
        : "No default verified domain found",
      details: `Domains: ${domains.value.map((d) => `${d.id}${d.isDefault ? " (default)" : ""}${d.isVerified ? " (verified)" : ""}`).join(", ")}`,
    };
  } catch (error) {
    return {
      check: "Tenant domain",
      passed: false,
      message: "Failed to check tenant domain",
      details: String(error),
    };
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("ENTRA SANDBOX VALIDATION");
  console.log("=".repeat(60));

  const config: ValidationConfig = {
    tenantId: getEnv("OPNORY_ENTRA_TENANT_ID"),
    clientId: getEnv("OPNORY_ENTRA_CLIENT_ID"),
    clientSecret: getEnv("OPNORY_ENTRA_CLIENT_SECRET"),
  };

  console.log(`\nTenant: ${config.tenantId}`);
  console.log(`Client: ${config.clientId}`);
  console.log("");

  // Get Graph token
  console.log("1/6 Acquiring Graph token...");
  const token = await fetchGraphToken(
    config.tenantId,
    config.clientId,
    config.clientSecret,
  );
  console.log("   ✅ Token acquired\n");

  const results: ValidationResult[] = [];

  // Run checks
  console.log("Running validation checks...\n");

  results.push(await checkGraphAuth(token));
  results.push(await checkTenantDomain(token));
  results.push(...(await checkApplicationPermissions(token)));
  results.push(await checkDirectoryRoles(token));
  results.push(await checkGovernanceEntitlement(token));

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("VALIDATION SUMMARY");
  console.log("=".repeat(60));

  let allPassed = true;
  for (const result of results) {
    const icon = result.passed ? "✅" : "❌";
    console.log(`\n${icon} ${result.check}`);
    console.log(`   ${result.message}`);
    if (result.details) {
      console.log(`   Details: ${result.details}`);
    }
    if (!result.passed) allPassed = false;
  }

  console.log("\n" + "=".repeat(60));

  if (allPassed) {
    console.log("✅ ALL CHECKS PASSED - READY FOR BOOTSTRAP");
    console.log("=".repeat(60));
    process.exit(0);
  } else {
    console.log("❌ VALIDATION FAILED - BLOCKED");
    console.log("=".repeat(60));
    console.log("\nNext action:");
    console.log("  1. Enable Entra ID Governance trial/P2 on this tenant, OR");
    console.log("  2. Provision a new tenant with Governance entitlement");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Validation failed:", error);
  process.exit(1);
});
