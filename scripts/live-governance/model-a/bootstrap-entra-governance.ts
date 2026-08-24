#!/usr/bin/env bun
/**
 * Entra Sandbox Bootstrap
 * Creates reproducible sandbox artifacts for Entra governance certification.
 * Run with: OPNORY_ENTRA_TENANT_ID=... OPNORY_ENTRA_CLIENT_ID=... OPNORY_ENTRA_CLIENT_SECRET=... bun run scripts/live-governance/bootstrap-entra-sandbox.ts
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
  accessPackageId: string;
  assignmentPolicyId: string;
  catalogId: string;
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
// Bootstrap Steps
// ============================================================================

async function getDefaultDomain(token: string): Promise<string> {
  const domains = await graphRequest<{
    value: Array<{ id: string; isDefault: boolean }>;
  }>(token, "/domains");

  const defaultDomain = domains.value.find((d) => d.isDefault);
  if (!defaultDomain) {
    // Fallback: use first verified domain
    const verifiedDomain = domains.value.find((d) =>
      d.id.endsWith(".onmicrosoft.com"),
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
  const password = randomUUID(); // Not stored, just for creation

  logger.info({ email }, "Creating test user");

  try {
    // Check if user already exists
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

  // Create user
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

async function createAccessPackageCatalog(token: string): Promise<string> {
  const name = "Opnory Governance Certification Catalog";
  const description =
    "Sandbox catalog for Opnory Entra governance certification tests.";

  logger.info({ name }, "Creating/locating access package catalog");

  // Check for existing catalog
  const catalogs = await graphRequest<{
    value: Array<{ id: string; displayName: string }>;
  }>(
    token,
    "/identityGovernance/entitlementManagement/accessPackageCatalogs?$filter=displayName eq 'Opnory Governance Certification Catalog'",
  );

  if (catalogs.value.length > 0) {
    logger.info({ catalogId: catalogs.value[0].id }, "Catalog already exists");
    return catalogs.value[0].id;
  }

  // Create catalog
  const catalog = await graphRequest<{ id: string }>(
    token,
    "/identityGovernance/entitlementManagement/accessPackageCatalogs",
    {
      method: "POST",
      body: JSON.stringify({
        displayName: name,
        description,
      }),
    },
  );

  logger.info({ catalogId: catalog.id }, "Catalog created");
  return catalog.id;
}

async function createAccessPackage(
  token: string,
  catalogId: string,
): Promise<string> {
  const name = "Opnory Governance Certification Package";
  const description =
    "Sandbox package used for Opnory Entra governance certification tests.";

  logger.info({ name, catalogId }, "Creating access package");

  const accessPackage = await graphRequest<{ id: string }>(
    token,
    "/identityGovernance/entitlementManagement/accessPackages",
    {
      method: "POST",
      body: JSON.stringify({
        displayName: name,
        description,
        catalogId,
        isHidden: false,
      }),
    },
  );

  logger.info({ accessPackageId: accessPackage.id }, "Access package created");
  return accessPackage.id;
}

async function createAssignmentPolicy(
  token: string,
  accessPackageId: string,
  testSubjectId: string,
): Promise<string> {
  const name = "Opnory Certification Assignment Policy";
  const description =
    "Assignment policy for Opnory governance certification tests. Scoped to sandbox test user only.";

  logger.info({ name, accessPackageId }, "Creating assignment policy");

  const policy = await graphRequest<{ id: string }>(
    token,
    "/identityGovernance/entitlementManagement/accessPackageAssignmentPolicies",
    {
      method: "POST",
      body: JSON.stringify({
        displayName: name,
        description,
        accessPackageId,
        // Target the test user specifically
        requestorSettings: {
          scopeType: "SpecificDirectoryUsers",
          specificAllowedTargets: [{ objectId: testSubjectId }],
          enableTargetsToSelfAddAccess: true,
          enableTargetsToSelfUpdateAccess: true,
          enableTargetsToSelfRemoveAccess: true,
        },
        expiration: {
          type: "AfterDuration",
          duration: "P1D", // 1 day for sandbox
        },
        requestApprovalSettings: {
          isApprovalRequired: true,
          isApprovalRequiredForExtension: true,
          approvalMode: "Serial",
          approvalStages: [
            {
              durationBeforeAutomaticDenial: "P1D",
              isApproverJustificationRequired: false,
              isEscalationEnabled: false,
              primaryApprovers: [
                { objectId: testSubjectId }, // Self-approval for sandbox
              ],
            },
          ],
        },
      }),
    },
  );

  logger.info({ assignmentPolicyId: policy.id }, "Assignment policy created");
  return policy.id;
}

// ============================================================================
// Main
// ============================================================================

async function validateTenant(
  token: string,
): Promise<{ domain: string; licensed: boolean }> {
  // Check governance entitlement
  try {
    const response = await fetch(
      "https://graph.microsoft.com/beta/identityGovernance/entitlementManagement/accessPackageCatalogs",
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    if (response.status === 403) {
      const error = (await response.json()) as {
        error?: { code?: string; message?: string };
      };
      if (
        error.error?.code === "NoLicense" ||
        error.error?.message?.includes("license")
      ) {
        return { domain: "", licensed: false };
      }
    }
  } catch {
    // Ignore and check subscribed SKUs
  }

  // Check subscribed SKUs
  try {
    const skus = await graphRequest<{
      value: Array<{ skuId: string; skuPartNumber: string }>;
    }>(token, "/subscribedSkus");

    const hasP2 = skus.value.some(
      (s) =>
        s.skuPartNumber === "AAD_PREMIUM_P2" ||
        s.skuPartNumber === "EMSPREMIUM" ||
        s.skuPartNumber === "ENTERPRISEPREMIUM" ||
        s.skuPartNumber?.includes("P2") ||
        s.skuPartNumber?.includes("GOVERNANCE"),
    );

    // Get domain
    const domains = await graphRequest<{
      value: Array<{ id: string; isDefault: boolean; isVerified: boolean }>;
    }>(token, "/domains");

    const defaultDomain = domains.value.find(
      (d) => d.isDefault && d.isVerified,
    );
    return { domain: defaultDomain?.id || "", licensed: hasP2 };
  } catch {
    return { domain: "", licensed: false };
  }
}

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("ENTRA SANDBOX BOOTSTRAP");
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
  console.log("1/6 Acquiring Graph token...");
  const token = await fetchGraphToken(
    config.tenantId,
    config.clientId,
    config.clientSecret,
  );
  console.log("   ✅ Token acquired");

  // Validate tenant capabilities
  console.log("\n2/6 Validating tenant capabilities...");
  const { domain: defaultDomain, licensed } = await validateTenant(token);

  if (!licensed) {
    console.error("\n" + "=".repeat(60));
    console.error("BLOCKED: Entra Governance Unavailable");
    console.error("=".repeat(60));
    console.error("");
    console.error("The tenant authenticated successfully but does not have");
    console.error(
      "Identity Governance entitlement (Entra ID P2 / Governance).",
    );
    console.error("");
    console.error("Required:");
    console.error("  - Entra ID Governance / P2 license");
    console.error("  - EntitlementManagement.ReadWrite.All permission");
    console.error("");
    console.error("Next action:");
    console.error("  1. Activate Governance trial on this tenant, OR");
    console.error("  2. Provision a licensed certification tenant");
    console.error("=".repeat(60));
    process.exit(1);
  }

  console.log(`   ✅ Governance entitlement detected`);
  console.log(`   ✅ Default domain: ${defaultDomain}`);

  const testSubjectEmail =
    getEnvOptional("OPNORY_ENTRA_TEST_SUBJECT_EMAIL") ||
    `bob.user@${defaultDomain}`;

  let resolvedTestSubjectId = testSubjectId;

  if (!skipUserCreate) {
    // Create test user
    console.log("\n3/6 Creating test user...");
    const { email, objectId } = await createTestUser(token, defaultDomain);
    console.log(`   ✅ Test user: ${email} (${objectId})`);
    resolvedTestSubjectId = objectId;
  } else {
    if (!testSubjectId) {
      throw new Error(
        "OPNORY_SKIP_USER_CREATE=true but OPNORY_ENTRA_EXPECTED_SUBJECT_ID not set",
      );
    }
    console.log("\n3/6 Skipping user creation (using existing)");
    console.log(`   Test user: ${testSubjectEmail} (${testSubjectId})`);
    resolvedTestSubjectId = testSubjectId;
  }

  // Create catalog
  console.log("\n4/6 Creating access package catalog...");
  const catalogId = await createAccessPackageCatalog(token);
  console.log(`   ✅ Catalog: ${catalogId}`);

  // Create access package
  console.log("\n5/6 Creating access package...");
  const accessPackageId = await createAccessPackage(token, catalogId);
  console.log(`   ✅ Access Package: ${accessPackageId}`);

  // Create assignment policy
  console.log("\n6/6 Creating assignment policy...");
  const assignmentPolicyId = await createAssignmentPolicy(
    token,
    accessPackageId,
    resolvedTestSubjectId,
  );
  console.log(`   ✅ Assignment Policy: ${assignmentPolicyId}`);

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
  console.log(`export OPNORY_ENTRA_CATALOG_ID=${catalogId}`);
  console.log(`export OPNORY_ENTRA_ACCESS_PACKAGE_ID=${accessPackageId}`);
  console.log(`export OPNORY_ENTRA_ASSIGNMENT_POLICY_ID=${assignmentPolicyId}`);
  console.log("");
  console.log("Then add your GitHub fulfillment values:");
  console.log(`export OPNORY_ENTRA_GITHUB_ORG=opnory`);
  console.log(`export OPNORY_ENTRA_GITHUB_TEAM_SLUG=<your-team>`);
  console.log(`export OPNORY_ENTRA_FULFILLMENT_OWNER=opnory`);
  console.log("");
  console.log("Then run certification:");
  console.log("");
  console.log("  bun run scripts/live-governance/entra.ts");
  console.log("");

  // Write .env file for certification
  const envContent = [
    `OPNORY_ENTRA_TENANT_ID=${config.tenantId}`,
    `OPNORY_ENTRA_CLIENT_ID=${config.clientId}`,
    `OPNORY_ENTRA_CLIENT_SECRET=${config.clientSecret}`,
    `OPNORY_ENTRA_TEST_SUBJECT_EMAIL=${testSubjectEmail}`,
    `OPNORY_ENTRA_EXPECTED_SUBJECT_ID=${resolvedTestSubjectId}`,
    `OPNORY_ENTRA_CATALOG_ID=${catalogId}`,
    `OPNORY_ENTRA_ACCESS_PACKAGE_ID=${accessPackageId}`,
    `OPNORY_ENTRA_ASSIGNMENT_POLICY_ID=${assignmentPolicyId}`,
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
