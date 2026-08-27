#!/usr/bin/env bun
/**
 * Entra Sandbox Bootstrap (Model B - Standard Graph Primitives)
 * Creates reproducible sandbox artifacts for Entra governance certification.
 * Uses only standard Microsoft Graph APIs - no Entra ID Governance/P2 required.
 * Run with: OPNORY_ENTRA_TENANT_ID=... OPNORY_ENTRA_CLIENT_ID=... OPNORY_ENTRA_CLIENT_SECRET=... OPNORY_ENTRA_BOOTSTRAP_CONFIRM=true bun run scripts/live-governance/bootstrap-entra-sandbox.ts
 */

import { getLogger } from "@opnory/observability";
import { randomUUID } from "crypto";
import { writeFile } from "fs/promises";

const logger = getLogger().child({ component: "bootstrap:entra-sandbox" });

// ============================================================================
// Configuration
// ============================================================================

interface BootstrapConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

interface BootstrapResult {
  testSubjectEmail: string;
  expectedSubjectId: string;
  catalogId: string;
  accessPackageId: string;
  assignmentPolicyId: string;
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
// Bootstrap Steps - Standard Graph Primitives (No Governance License)
// ============================================================================

async function getDefaultDomain(token: string): Promise<string> {
  const domains = await graphRequest<{
    value: Array<{ id: string; isDefault: boolean; isVerified: boolean }>;
  }>(token, "/domains");

  const defaultDomain = domains.value.find((d) => d.isDefault && d.isVerified);
  if (!defaultDomain) {
    const verifiedDomain = domains.value.find(
      (d) => d.id.endsWith(".onmicrosoft.com") && d.isVerified,
    );
    if (!verifiedDomain) {
      throw new Error("No verified onmicrosoft.com domain found in tenant");
    }
    return verifiedDomain.id;
  }
  return defaultDomain.id;
}

async function createTestUser(
  token: string,
  tenantDomain: string,
): Promise<{ email: string; objectId: string }> {
  const email = `bob.user@${tenantDomain}`;
  const password = randomUUID();

  logger.info({ email }, "Creating test user");

  try {
    const existing = await graphRequest<{
      value: Array<{ id: string; userPrincipalName: string }>;
    }>(token, `/users?$filter=userPrincipalName eq '${email}'`);

    if (existing.value.length > 0) {
      logger.info(
        { email, objectId: existing.value[0].id },
        "Test user already exists",
      );
      return { email, objectId: existing.value[0].id };
    }
  } catch (error) {
    logger.warn({ error }, "Failed to check existing user, attempting create");
  }

  const user = await graphRequest<{ id: string; userPrincipalName: string }>(
    token,
    "/users",
    {
      method: "POST",
      body: JSON.stringify({
        accountEnabled: true,
        displayName: "Opnory Sandbox Test User",
        mailNickname: "bob.user",
        userPrincipalName: email,
        passwordProfile: {
          forceChangePasswordNextSignIn: false,
          password: password,
        },
      }),
    },
  );

  logger.info({ email, objectId: user.id }, "Test user created");
  return { email, objectId: user.id };
}

async function createSecurityGroup(
  token: string,
  displayName: string,
  description: string,
): Promise<string> {
  logger.info({ displayName }, "Creating security group");

  try {
    const existing = await graphRequest<{
      value: Array<{ id: string; displayName: string }>;
    }>(token, `/groups?$filter=displayName eq '${displayName}'`);

    if (existing.value.length > 0) {
      logger.info(
        { displayName, objectId: existing.value[0].id },
        "Security group already exists",
      );
      return existing.value[0].id;
    }
  } catch (error) {
    logger.warn(
      { error, displayName },
      "Failed to check existing group, attempting create",
    );
  }

  const group = await graphRequest<{ id: string }>(token, "/groups", {
    method: "POST",
    body: JSON.stringify({
      displayName,
      description,
      securityEnabled: true,
      mailEnabled: false,
      mailNickname: displayName.toLowerCase().replace(/\s+/g, "-"),
      groupTypes: [],
    }),
  });

  logger.info({ displayName, groupId: group.id }, "Security group created");
  return group.id;
}

async function createEnterpriseApp(
  token: string,
  displayName: string,
  appRoles: Array<{
    displayName: string;
    id: string;
    value: string;
    description: string;
    allowedMemberTypes: string[];
  }>,
): Promise<{ appId: string; objectId: string; servicePrincipalId: string }> {
  logger.info({ displayName }, "Creating enterprise application");

  try {
    const existing = await graphRequest<{
      value: Array<{ appId: string; id: string; displayName: string }>;
    }>(token, `/applications?$filter=displayName eq '${displayName}'`);

    if (existing.value.length > 0) {
      const app = existing.value[0];
      logger.info(
        { displayName, appId: app.appId, objectId: app.id },
        "Enterprise app already exists",
      );

      // Check if service principal exists, create if missing
      const sp = await graphRequest<{ value: Array<{ id: string }> }>(
        token,
        `/servicePrincipals?$filter=appId eq '${app.appId}'`,
      );

      let servicePrincipalId: string;
      if (sp.value.length === 0) {
        logger.info(
          { appId: app.appId },
          "Service principal missing, creating...",
        );
        await waitForApplicationPropagation(token, app.appId);
        await createServicePrincipalWithRetry(token, app.appId);
        logger.info(
          { displayName, appId: app.appId },
          "Service principal created",
        );

        // Fetch the newly created SP
        const newSp = await graphRequest<{ value: Array<{ id: string }> }>(
          token,
          `/servicePrincipals?$filter=appId eq '${app.appId}'`,
        );
        servicePrincipalId = newSp.value[0].id;
      } else {
        servicePrincipalId = sp.value[0].id;
      }

      return { appId: app.appId, objectId: app.id, servicePrincipalId };
    }
  } catch (error) {
    logger.warn(
      { error, displayName },
      "Failed to check existing app, attempting create",
    );
  }

  // Create application
  const app = await graphRequest<{ appId: string; id: string }>(
    token,
    "/applications",
    {
      method: "POST",
      body: JSON.stringify({
        displayName,
        signInAudience: "AzureADMyOrg",
        web: {
          redirectUris: [],
        },
        requiredResourceAccess: [
          {
            resourceAppId: "00000003-0000-0000-c000-000000000000", // Microsoft Graph
            resourceAccess: [
              { id: "e1fe6dd8-ba31-4d61-89e7-88639da4683d", type: "Role" }, // User.Read.All
              { id: "df021288-bdef-4463-88db-98f22de89214", type: "Role" }, // Group.ReadWrite.All
              { id: "570282fd-fa5c-430d-a7fd-fc8dc98a9dca", type: "Role" }, // Directory.Read.All
            ],
          },
        ],
        appRoles,
      }),
    },
  );

  logger.info(
    { displayName, appId: app.appId, objectId: app.id },
    "Application created",
  );

  // Wait for application to propagate before creating service principal
  await waitForApplicationPropagation(token, app.appId);

  // Create service principal with retry
  await createServicePrincipalWithRetry(token, app.appId);

  logger.info({ displayName, appId: app.appId }, "Service principal created");

  // Fetch the service principal ID with retry (propagation can take time)
  let servicePrincipalId: string | undefined;
  for (let attempt = 0; attempt < 10; attempt++) {
    const sp = await graphRequest<{ value: Array<{ id: string }> }>(
      token,
      `/servicePrincipals?$filter=appId eq '${app.appId}'`,
    );
    if (sp.value.length > 0) {
      servicePrincipalId = sp.value[0].id;
      break;
    }
    await sleep(1000);
  }
  
  if (!servicePrincipalId) {
    throw new Error("Service principal not found after creation");
  }

  return { appId: app.appId, objectId: app.id, servicePrincipalId };
}

async function waitForApplicationPropagation(
  token: string,
  appId: string,
  timeoutMs: number = 30000,
): Promise<void> {
  const startedAt = Date.now();
  let delayMs = 500;

  while (Date.now() - startedAt < timeoutMs) {
    const response = await fetch(
      `https://graph.microsoft.com/v1.0/applications(appId='${appId}')`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    if (response.ok) {
      return;
    }

    if (response.status !== 404) {
      const body = await response.text();
      throw new Error(
        `Application propagation check failed: ${response.status} ${body}`,
      );
    }

    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, 4000);
  }

  throw new Error(
    `Application ${appId} did not become visible within ${timeoutMs}ms`,
  );
}

async function createServicePrincipalWithRetry(
  token: string,
  appId: string,
  timeoutMs: number = 30000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let delayMs = 500;

  while (true) {
    const response = await fetch(
      "https://graph.microsoft.com/v1.0/servicePrincipals",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ appId }),
      },
    );

    if (response.ok) {
      return;
    }

    const body = await response.text();

    const propagationRace =
      response.status === 400 && body.includes("NoBackingApplicationObject");

    if (!propagationRace || Date.now() >= deadline) {
      throw new Error(
        `Service principal creation failed: ${response.status} ${body}`,
      );
    }

    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, 4000);
  }
}

// ============================================================================
// Main
// ============================================================================

async function validateTenantCapabilities(
  token: string,
): Promise<{ domain: string }> {
  // Check basic Graph connectivity and get domain
  const domains = await graphRequest<{
    value: Array<{ id: string; isDefault: boolean; isVerified: boolean }>;
  }>(token, "/domains");

  const defaultDomain = domains.value.find((d) => d.isDefault && d.isVerified);
  if (!defaultDomain) {
    throw new Error("No verified default domain found in tenant");
  }

  // Verify basic permissions by checking we can read users
  await graphRequest<{ value: Array<{ id: string }> }>(token, "/users?$top=1");

  return { domain: defaultDomain.id };
}

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("ENTRA SANDBOX BOOTSTRAP (Model B - Standard Graph Primitives)");
  console.log("=".repeat(60));

  // Require explicit confirmation for mutation
  if (process.env.OPNORY_ENTRA_BOOTSTRAP_CONFIRM !== "true") {
    console.error("=".repeat(60));
    console.error("ENTRA SANDBOX BOOTSTRAP - REFUSED");
    console.error("=".repeat(60));
    console.error("");
    console.error("This operation will CREATE sandbox resources.");
    console.error("Set environment variable to confirm:");
    console.error("");
    console.error("  export OPNORY_ENTRA_BOOTSTRAP_CONFIRM=true");
    console.error("");
    process.exit(1);
  }

  // Load configuration
  const config: BootstrapConfig = {
    tenantId: getEnv("OPNORY_ENTRA_TENANT_ID"),
    clientId: getEnv("OPNORY_ENTRA_CLIENT_ID"),
    clientSecret: getEnv("OPNORY_ENTRA_CLIENT_SECRET"),
  };

  const skipUserCreate = process.env.OPNORY_SKIP_USER_CREATE === "true";
  const testSubjectId = getEnvOptional("OPNORY_ENTRA_EXPECTED_SUBJECT_ID");

  // Extract tenant domain from tenant ID (fallback only)
  const tenantDomain = `${config.tenantId}.onmicrosoft.com`;

  console.log(`\nTenant: ${config.tenantId}`);
  console.log(`Client: ${config.clientId}`);
  console.log(`Skip user create: ${skipUserCreate}`);
  console.log("");

  // Get Graph token
  console.log("1/7 Acquiring Graph token...");
  const token = await fetchGraphToken(
    config.tenantId,
    config.clientId,
    config.clientSecret,
  );
  console.log("   ✅ Token acquired");

  // Validate tenant capabilities
  console.log("\n2/7 Validating tenant capabilities...");
  const { domain: defaultDomain } = await validateTenantCapabilities(token);
  console.log(`   ✅ Default domain: ${defaultDomain}`);
  console.log(`   ✅ Standard Graph APIs accessible`);

  const testSubjectEmail =
    getEnvOptional("OPNORY_ENTRA_TEST_SUBJECT_EMAIL") ||
    `bob.user@${defaultDomain}`;

  let resolvedTestSubjectId = testSubjectId;

  if (!skipUserCreate) {
    // Create test user
    console.log("\n3/7 Creating test user...");
    const { email, objectId } = await createTestUser(token, defaultDomain);
    console.log(`   ✅ Test user: ${email} (${objectId})`);
    resolvedTestSubjectId = objectId;
  } else {
    if (!testSubjectId) {
      throw new Error(
        "OPNORY_SKIP_USER_CREATE=true but OPNORY_ENTRA_EXPECTED_SUBJECT_ID not set",
      );
    }
    console.log("\n3/7 Skipping user creation (using existing)");
    console.log(`   Test user: ${testSubjectEmail} (${testSubjectId})`);
    resolvedTestSubjectId = testSubjectId;
  }

  // Create security groups
  console.log("\n4/7 Creating security groups...");
  const adminGroupId = await createSecurityGroup(
    token,
    "Opnory-Certification-Admins",
    "Admin group for Opnory governance certification tests",
  );
  console.log(`   ✅ Admin group: ${adminGroupId}`);

  const usersGroupId = await createSecurityGroup(
    token,
    "Opnory-Certification-Users",
    "User group for Opnory governance certification tests",
  );
  console.log(`   ✅ Users group: ${usersGroupId}`);

  // Create enterprise application with app roles
  console.log("\n5/7 Creating enterprise application with app roles...");
  const appRoles = [
    {
      id: randomUUID(),
      displayName: "FinanceAnalyst",
      value: "FinanceAnalyst",
      description: "Finance Analyst access",
      allowedMemberTypes: ["User"],
    },
    {
      id: randomUUID(),
      displayName: "DataAnalyst",
      value: "DataAnalyst",
      description: "Data Analyst access",
      allowedMemberTypes: ["User"],
    },
    {
      id: randomUUID(),
      displayName: "Auditor",
      value: "Auditor",
      description: "Read-only audit access",
      allowedMemberTypes: ["User"],
    },
  ];

  const {
    appId,
    objectId: enterpriseAppId,
    servicePrincipalId,
  } = await createEnterpriseApp(token, "Opnory-Certification-App", appRoles);
  console.log(`   ✅ Enterprise app: ${enterpriseAppId} (appId: ${appId})`);
  console.log(`   ✅ Service principal: ${servicePrincipalId}`);
  console.log(`   ✅ App roles: ${appRoles.map((r) => r.value).join(", ")}`);

  // Output results
  console.log("\n" + "=".repeat(60));
  console.log("BOOTSTRAP COMPLETE");
  console.log("=".repeat(60));
  console.log("");
  console.log("Add these to your environment:");
  console.log("");
  console.log(`export OPNORY_ENTRA_TEST_SUBJECT_EMAIL=${testSubjectEmail}`);
  console.log(
    `export OPNORY_ENTRA_EXPECTED_SUBJECT_ID=${resolvedTestSubjectId}`,
  );
  console.log(`export OPNORY_ENTRA_ADMIN_GROUP_ID=${adminGroupId}`);
  console.log(`export OPNORY_ENTRA_USERS_GROUP_ID=${usersGroupId}`);
  console.log(`export OPNORY_ENTRA_ENTERPRISE_APP_ID=${enterpriseAppId}`);
  console.log(`export OPNORY_ENTRA_ENTERPRISE_APP_CLIENT_ID=${appId}`);
  console.log(`export OPNORY_ENTRA_SERVICE_PRINCIPAL_ID=${servicePrincipalId}`);
  console.log("");
  console.log("Then add your GitHub/Okta fulfillment values:");
  console.log(`export OPNORY_ENTRA_GITHUB_ORG=opnory`);
  console.log(`export OPNORY_ENTRA_GITHUB_TEAM_SLUG=<your-team>`);
  console.log(`export OPNORY_ENTRA_FULFILLMENT_OWNER=opnory`);
  console.log("");
  console.log("Then run certification:");
  console.log("");
  console.log("  bun run scripts/live-governance/entra-certification.ts");
  console.log("");

  // Write .env file for certification
  const envContent = [
    `OPNORY_ENTRA_TENANT_ID=${config.tenantId}`,
    `OPNORY_ENTRA_CLIENT_ID=${config.clientId}`,
    `OPNORY_ENTRA_CLIENT_SECRET=${config.clientSecret}`,
    `OPNORY_ENTRA_TEST_SUBJECT_EMAIL=${testSubjectEmail}`,
    `OPNORY_ENTRA_EXPECTED_SUBJECT_ID=${resolvedTestSubjectId}`,
    `OPNORY_ENTRA_ADMIN_GROUP_ID=${adminGroupId}`,
    `OPNORY_ENTRA_USERS_GROUP_ID=${usersGroupId}`,
    `OPNORY_ENTRA_ENTERPRISE_APP_ID=${enterpriseAppId}`,
    `OPNORY_ENTRA_ENTERPRISE_APP_CLIENT_ID=${appId}`,
    `OPNORY_ENTRA_SERVICE_PRINCIPAL_ID=${servicePrincipalId}`,
    "",
    "# Add these manually:",
    "OPNORY_ENTRA_GITHUB_ORG=opnory",
    "OPNORY_ENTRA_GITHUB_TEAM_SLUG=<your-team>",
    "OPNORY_ENTRA_FULFILLMENT_OWNER=opnory",
    "",
    "# Certification gates:",
    "OPNORY_ALLOW_UNPINNED_LIVE_TEST=true",
    "OPNORY_LIVE_GOVERNANCE_TESTS=true",
    "OPNORY_ENTRA_SANDBOX_CONFIRM=true",
    "OPNORY_ALLOW_DIRTY_LIVE_TEST=true",
  ].join("\n");

  await writeFile(".env.entra-certification", envContent);
  console.log("Wrote .env.entra-certification");
  console.log("");
}

main().catch((error) => {
  console.error("Bootstrap failed:", error);
  process.exit(1);
});
