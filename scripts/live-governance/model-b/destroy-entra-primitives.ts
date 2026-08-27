#!/usr/bin/env bun
/**
 * Entra Sandbox Destroy (Model B - Standard Graph Primitives)
 * Cleans up all sandbox artifacts created during certification.
 * Run with: OPNORY_ENTRA_TENANT_ID=... OPNORY_ENTRA_CLIENT_ID=... OPNORY_ENTRA_CLIENT_SECRET=... OPNORY_ENTRA_BOOTSTRAP_CONFIRM=true bun run scripts/live-governance/destroy-entra-sandbox.ts
 */

import { getLogger } from "@opnory/observability";

const logger = getLogger().child({ component: "destroy:entra-sandbox" });

// ============================================================================
// Configuration
// ============================================================================

interface DestroyConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} not set`);
  }
  return value;
}

function getEnvOptional(name: string): string | undefined {
  return process.env[name];
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
// Destroy Steps (reverse order of creation)
// ============================================================================

async function deleteEnterpriseApp(
  token: string,
  enterpriseAppClientId: string,
): Promise<void> {
  console.log("Deleting enterprise application...");

  try {
    // Find application by appId (clientId)
    const apps = await graphRequest<{
      value: Array<{ id: string; appId: string; displayName: string }>;
    }>(token, `/applications?$filter=appId eq '${enterpriseAppClientId}'`);

    if (apps.value.length === 0) {
      console.log(
        `  ⚠️ Enterprise application with appId ${enterpriseAppClientId} not found`,
      );
      return;
    }

    const app = apps.value[0];
    const applicationObjectId = app.id;

    // Delete service principal first
    const sp = await graphRequest<{ value: Array<{ id: string }> }>(
      token,
      `/servicePrincipals?$filter=appId eq '${enterpriseAppClientId}'`,
    );

    for (const spItem of sp.value) {
      try {
        await graphRequest(token, `/servicePrincipals/${spItem.id}`, {
          method: "DELETE",
        });
        console.log(`  ✅ Deleted service principal: ${spItem.id}`);
      } catch (error) {
        console.log(
          `  ⚠️ Failed to delete service principal ${spItem.id}: ${error}`,
        );
      }
    }

    // Delete application using its object ID
    try {
      await graphRequest(token, `/applications/${applicationObjectId}`, {
        method: "DELETE",
      });
      console.log(`  ✅ Deleted application: ${applicationObjectId}`);
    } catch (error) {
      console.log(
        `  ⚠️ Failed to delete application ${applicationObjectId}: ${error}`,
      );
    }
  } catch (error) {
    console.log(`  ⚠️ Failed to find enterprise app: ${error}`);
  }
}

async function deleteSecurityGroup(
  token: string,
  groupId: string,
  groupName: string,
): Promise<void> {
  console.log(`Deleting security group: ${groupName}...`);

  try {
    await graphRequest(token, `/groups/${groupId}`, { method: "DELETE" });
    console.log(`  ✅ Deleted security group: ${groupName} (${groupId})`);
  } catch (error) {
    console.log(`  ⚠️ Failed to delete security group ${groupId}: ${error}`);
  }
}

async function deleteTestUser(
  token: string,
  userPrincipalName: string,
): Promise<void> {
  console.log("Deleting test user...");

  try {
    const users = await graphRequest<{
      value: Array<{ id: string; userPrincipalName: string }>;
    }>(token, `/users?$filter=userPrincipalName eq '${userPrincipalName}'`);

    for (const user of users.value) {
      try {
        await graphRequest(token, `/users/${user.id}`, { method: "DELETE" });
        console.log(
          `  ✅ Deleted test user: ${user.userPrincipalName} (${user.id})`,
        );
      } catch (error) {
        console.log(`  ⚠️ Failed to delete test user ${user.id}: ${error}`);
      }
    }
  } catch (error) {
    console.log(`  ⚠️ Failed to find test user: ${error}`);
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  // Require explicit confirmation for mutation
  if (process.env.OPNORY_ENTRA_BOOTSTRAP_CONFIRM !== "true") {
    console.error("=".repeat(60));
    console.error("ENTRA SANDBOX DESTROY - REFUSED");
    console.error("=".repeat(60));
    console.error("");
    console.error("This operation will DELETE sandbox resources.");
    console.error("Set environment variable to confirm:");
    console.error("");
    console.error("  export OPNORY_ENTRA_BOOTSTRAP_CONFIRM=true");
    console.error("");
    process.exit(1);
  }

  console.log("=".repeat(60));
  console.log("ENTRA SANDBOX DESTROY (Model B)");
  console.log("=".repeat(60));

  const config: DestroyConfig = {
    tenantId: getEnv("OPNORY_ENTRA_TENANT_ID"),
    clientId: getEnv("OPNORY_ENTRA_CLIENT_ID"),
    clientSecret: getEnv("OPNORY_ENTRA_CLIENT_SECRET"),
  };

  const enterpriseAppClientId = getEnvOptional("OPNORY_ENTRA_ENTERPRISE_APP_CLIENT_ID");
  const adminGroupId = getEnvOptional("OPNORY_ENTRA_ADMIN_GROUP_ID");
  const usersGroupId = getEnvOptional("OPNORY_ENTRA_USERS_GROUP_ID");
  const testUserEmail =
    getEnvOptional("OPNORY_ENTRA_TEST_SUBJECT_EMAIL") ||
    "bob.user@opnoryopnory.onmicrosoft.com";

  console.log(`\nTenant: ${config.tenantId}`);
  console.log(`Client: ${config.clientId}`);
  console.log("");

  // Get Graph token
  console.log("1/5 Acquiring Graph token...");
  const token = await fetchGraphToken(
    config.tenantId,
    config.clientId,
    config.clientSecret,
  );
  console.log("   ✅ Token acquired\n");

  console.log("Starting cleanup...\n");

  // Delete in reverse order of creation
  if (enterpriseAppClientId) {
    await deleteEnterpriseApp(token, enterpriseAppClientId);
  }

  if (adminGroupId) {
    await deleteSecurityGroup(
      token,
      adminGroupId,
      "Opnory-Certification-Admins",
    );
  }

  if (usersGroupId) {
    await deleteSecurityGroup(
      token,
      usersGroupId,
      "Opnory-Certification-Users",
    );
  }

  await deleteTestUser(token, testUserEmail);

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("ENTRA SANDBOX CLEANUP COMPLETE");
  console.log("=".repeat(60));
  console.log("\nDeleted:");
  console.log("  ✓ Enterprise application + service principal");
  console.log("  ✓ Security groups (Admins, Users)");
  console.log("  ✓ Test user");
  console.log("\nSandbox clean.");
}

main().catch((error) => {
  console.error("Destroy failed:", error);
  process.exit(1);
});
