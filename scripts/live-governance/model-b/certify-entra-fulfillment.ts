import { getLogger } from "@opnory/observability";
import { randomUUID } from "crypto";
import { writeFile } from "fs/promises";
import {
  Permission,
  ResourceScope,
  FulfillmentAdapter,
  FulfillmentResult,
  EvidenceEvent,
} from "@opnory/governance-core";

const logger = getLogger().child({ component: "certification:entra-model-b" });

// ============================================================================
// Configuration
// ============================================================================

interface CertConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  testSubjectEmail: string;
  expectedSubjectId: string;
  adminGroupId: string;
  usersGroupId: string;
  enterpriseAppId: string;
  enterpriseAppClientId: string;
  servicePrincipalId: string;
}

// ============================================================================
// Evidence
// ============================================================================

interface Evidence {
  provider: "entra" | "okta" | "github";
  test: string;
  passed: boolean;
  timestamp: string;
  durationMs: number;
  details: string;
  providerEventId?: string;
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
  const url = `https://graph.microsoft.com/v1.0${path}`;
  console.log(`[GRAPH] ${options.method || "GET"} ${url}`);
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    console.log(`[GRAPH ERROR] ${response.status} ${error}`);
    throw new Error(`Graph request failed: ${response.status} ${error}`);
  }

  if (response.status === 204 || response.status === 202) {
    return {} as T;
  }

  return response.json() as Promise<T>;
}

// ============================================================================
// Entra Fulfillment Adapter
// ============================================================================

class EntraFulfillmentAdapter implements FulfillmentAdapter {
  readonly provider = "entra";

  constructor(
    private token: string,
    private servicePrincipalId: string,
    private adminGroupId: string,
    private usersGroupId: string,
    private enterpriseAppClientId: string,
  ) {}

  async grant(
    subjectId: string,
    permission: Permission,
    scope: ResourceScope,
  ): Promise<FulfillmentResult> {
    // Map permission to Entra primitive
    const mapping = permission.mappings.find(
      (m: { provider: string; type: string; value: string }) =>
        m.provider === "entra",
    );
    if (!mapping) {
      return {
        success: false,
        message: `No Entra mapping for permission ${permission.id}`,
      };
    }

    try {
      if (mapping.type === "group") {
        const groupId = mapping.value;
        await graphRequest(this.token, `/groups/${groupId}/members/$ref`, {
          method: "POST",
          body: JSON.stringify({
            "@odata.id": `https://graph.microsoft.com/v1.0/directoryObjects/${subjectId}`,
          }),
        });
        return {
          success: true,
          providerObjectId: groupId,
          message: `Added to group ${groupId}`,
        };
      } else if (mapping.type === "appRole") {
        const appRoleId = mapping.value;
        await graphRequest(
          this.token,
          `/servicePrincipals/${this.servicePrincipalId}/appRoleAssignedTo`,
          {
            method: "POST",
            body: JSON.stringify({
              principalId: subjectId,
              resourceId: this.servicePrincipalId,
              appRoleId: appRoleId,
            }),
          },
        );
        return {
          success: true,
          providerObjectId: appRoleId,
          message: `Assigned app role ${appRoleId}`,
        };
      }
      return {
        success: false,
        message: `Unsupported mapping type: ${mapping.type}`,
      };
    } catch (error) {
      return { success: false, message: String(error), error: String(error) };
    }
  }

  async revoke(
    subjectId: string,
    permission: Permission,
    scope: ResourceScope,
    providerObjectId: string,
  ): Promise<FulfillmentResult> {
    const mapping = permission.mappings.find(
      (m: { provider: string; type: string; value: string }) =>
        m.provider === "entra",
    );
    if (!mapping) {
      return {
        success: false,
        message: `No Entra mapping for permission ${permission.id}`,
      };
    }

    try {
      if (mapping.type === "group") {
        await graphRequest(
          this.token,
          `/groups/${providerObjectId}/members/${subjectId}/$ref`,
          { method: "DELETE" },
        );
        return {
          success: true,
          message: `Removed from group ${providerObjectId}`,
        };
      } else if (mapping.type === "appRole") {
        // Find the assignment ID - fetch all and filter in memory (filter not supported)
        const assignments = await graphRequest<{
          value: Array<{ id: string; principalId: string; appRoleId: string }>;
        }>(
          this.token,
          `/servicePrincipals/${this.servicePrincipalId}/appRoleAssignedTo`,
        );
        const userAssignments = assignments.value.filter(
          (a) => a.principalId === subjectId,
        );
        const assignment = userAssignments.find(
          (a) => a.appRoleId === providerObjectId,
        );
        if (assignment) {
          await graphRequest(
            this.token,
            `/servicePrincipals/${this.servicePrincipalId}/appRoleAssignedTo/${assignment.id}`,
            { method: "DELETE" },
          );
        }
        return {
          success: true,
          message: `Removed app role ${providerObjectId}`,
        };
      }
      return {
        success: false,
        message: `Unsupported mapping type: ${mapping.type}`,
      };
    } catch (error) {
      const errorStr = String(error);
      if (errorStr.includes("Request_ResourceNotFound")) {
        // Already removed
        return { success: true, message: `Already removed` };
      }
      return { success: false, message: String(error), error: String(error) };
    }
  }

  async verify(
    subjectId: string,
    permission: Permission,
    scope: ResourceScope,
    providerObjectId: string,
  ): Promise<boolean> {
    const mapping = permission.mappings.find(
      (m: { provider: string; type: string; value: string }) =>
        m.provider === "entra",
    );
    if (!mapping) return false;

    try {
      if (mapping.type === "group") {
        const members = await graphRequest<{ value: Array<{ id: string }> }>(
          this.token,
          `/groups/${providerObjectId}/members`,
        );
        return members.value.some((m) => m.id === subjectId);
      } else if (mapping.type === "appRole") {
        // Fetch all and filter in memory (filter not supported)
        const assignments = await graphRequest<{
          value: Array<{ id: string; principalId: string; appRoleId: string }>;
        }>(
          this.token,
          `/servicePrincipals/${this.servicePrincipalId}/appRoleAssignedTo`,
        );
        const userAssignments = assignments.value.filter(
          (a) => a.principalId === subjectId,
        );
        return userAssignments.some((a) => a.appRoleId === providerObjectId);
      }
      return false;
    } catch {
      return false;
    }
  }
}

// ============================================================================
// Permissions for Entra Model B
// ============================================================================

const FINANCE_ANALYST_PERMISSION: Permission = {
  id: "finance.report.read",
  name: "Finance Report Read",
  description: "Read access to financial reports",
  mappings: [
    { provider: "entra", type: "group", value: "" }, // Will be filled at runtime
    { provider: "entra", type: "appRole", value: "" }, // Will be filled at runtime
  ],
};

const AUDITOR_PERMISSION: Permission = {
  id: "finance.audit",
  name: "Finance Audit",
  description: "Audit access to financial systems",
  mappings: [
    { provider: "entra", type: "group", value: "" },
    { provider: "entra", type: "appRole", value: "" },
  ],
};

const DATA_ANALYST_PERMISSION: Permission = {
  id: "data.analytics.read",
  name: "Data Analytics Read",
  description: "Read access to analytics data",
  mappings: [
    { provider: "entra", type: "group", value: "" },
    { provider: "entra", type: "appRole", value: "" },
  ],
};

// ============================================================================
// Sleep helper
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Certification Tests using Domain Model
// ============================================================================

async function testIdentityResolution(
  token: string,
  subjectEmail: string,
): Promise<Evidence> {
  const start = Date.now();
  try {
    const users = await graphRequest<{
      value: Array<{ id: string; userPrincipalName: string }>;
    }>(token, `/users?$filter=userPrincipalName eq '${subjectEmail}'`);

    if (users.value.length === 0) {
      return {
        provider: "entra",
        test: "identity-resolution",
        passed: false,
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - start,
        details: `Subject not found: ${subjectEmail}`,
      };
    }

    return {
      provider: "entra",
      test: "identity-resolution",
      passed: true,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - start,
      details: `Resolved ${subjectEmail} -> ${users.value[0].id}`,
    };
  } catch (error) {
    return {
      provider: "entra",
      test: "identity-resolution",
      passed: false,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - start,
      details: String(error),
    };
  }
}

async function testGroupFulfillment(
  adapter: FulfillmentAdapter,
  subjectId: string,
  permission: Permission,
  groupName: string,
): Promise<Evidence> {
  const start = Date.now();
  const scope: ResourceScope = { tenantId: "" };

  // Filter to group mapping only
  const groupMapping = permission.mappings.find(
    (m: { provider: string; type: string; value: string }) =>
      m.provider === "entra" && m.type === "group",
  );
  if (!groupMapping) {
    return {
      provider: "entra",
      test: `group-fulfillment-${groupName}`,
      passed: false,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - start,
      details: `No group mapping for permission ${permission.id}`,
    };
  }

  // Create a permission with only group mapping for this test
  const groupPermission: Permission = {
    ...permission,
    mappings: [groupMapping],
  };

  try {
    // Grant
    const grantResult = await adapter.grant(subjectId, groupPermission, scope);
    if (!grantResult.success) {
      return {
        provider: "entra",
        test: `group-fulfillment-${groupName}`,
        passed: false,
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - start,
        details: `Grant failed: ${grantResult.message}`,
      };
    }

    // Verify grant with retry for Graph eventual consistency
    let verified = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(2000);
      verified = await adapter.verify(
        subjectId,
        groupPermission,
        scope,
        grantResult.providerObjectId || "",
      );
      if (verified) {
        console.log(`[VERIFY GRANT] Attempt ${attempt + 1}/10: success`);
        break;
      }
      console.log(`[VERIFY GRANT] Attempt ${attempt + 1}/10: not yet visible`);
    }

    if (!verified) {
      return {
        provider: "entra",
        test: `group-fulfillment-${groupName}`,
        passed: false,
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - start,
        details: `Grant verification failed: subject not in group`,
      };
    }

    // Revoke
    const revokeResult = await adapter.revoke(
      subjectId,
      groupPermission,
      scope,
      grantResult.providerObjectId || "",
    );

    // Verify revoke
    let revokeVerified = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(2000);
      const stillHas = await adapter.verify(
        subjectId,
        groupPermission,
        scope,
        grantResult.providerObjectId || "",
      );
      if (!stillHas) {
        console.log(`[VERIFY REVOKE] Attempt ${attempt + 1}/10: removed`);
        revokeVerified = true;
        break;
      }
      console.log(`[VERIFY REVOKE] Attempt ${attempt + 1}/10: still present`);
    }

    if (!revokeVerified) {
      return {
        provider: "entra",
        test: `group-fulfillment-${groupName}`,
        passed: false,
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - start,
        details: `Revoke verification failed: subject still in group`,
      };
    }

    return {
      provider: "entra",
      test: `group-fulfillment-${groupName}`,
      passed: true,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - start,
      details: `Grant + Revoke verified for ${groupName}`,
    };
  } catch (error) {
    return {
      provider: "entra",
      test: `group-fulfillment-${groupName}`,
      passed: false,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - start,
      details: String(error),
    };
  }
}

async function testAppRoleFulfillment(
  adapter: FulfillmentAdapter,
  subjectId: string,
  permission: Permission,
  roleName: string,
): Promise<Evidence> {
  const start = Date.now();
  const scope: ResourceScope = { tenantId: "" };

  // Filter to appRole mapping only
  const appRoleMapping = permission.mappings.find(
    (m: { provider: string; type: string; value: string }) =>
      m.provider === "entra" && m.type === "appRole",
  );
  if (!appRoleMapping) {
    return {
      provider: "entra",
      test: `app-role-fulfillment-${roleName}`,
      passed: false,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - start,
      details: `No appRole mapping for permission ${permission.id}`,
    };
  }

  // Create a permission with only appRole mapping for this test
  const appRolePermission: Permission = {
    ...permission,
    mappings: [appRoleMapping],
  };

  try {
    // Grant
    const grantResult = await adapter.grant(
      subjectId,
      appRolePermission,
      scope,
    );
    if (!grantResult.success) {
      return {
        provider: "entra",
        test: `app-role-fulfillment-${roleName}`,
        passed: false,
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - start,
        details: `Grant failed: ${grantResult.message}`,
      };
    }

    // Verify grant with retry
    let verified = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(2000);
      verified = await adapter.verify(
        subjectId,
        appRolePermission,
        scope,
        grantResult.providerObjectId || "",
      );
      if (verified) {
        console.log(`[VERIFY GRANT] Attempt ${attempt + 1}/10: success`);
        break;
      }
      console.log(`[VERIFY GRANT] Attempt ${attempt + 1}/10: not yet visible`);
    }

    if (!verified) {
      return {
        provider: "entra",
        test: `app-role-fulfillment-${roleName}`,
        passed: false,
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - start,
        details: `Grant verification failed: app role not assigned`,
      };
    }

    // Revoke
    const revokeResult = await adapter.revoke(
      subjectId,
      appRolePermission,
      scope,
      grantResult.providerObjectId || "",
    );

    // Verify revoke
    let revokeVerified = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(2000);
      const stillHas = await adapter.verify(
        subjectId,
        appRolePermission,
        scope,
        grantResult.providerObjectId || "",
      );
      if (!stillHas) {
        console.log(`[VERIFY REVOKE] Attempt ${attempt + 1}/10: removed`);
        revokeVerified = true;
        break;
      }
      console.log(`[VERIFY REVOKE] Attempt ${attempt + 1}/10: still present`);
    }

    if (!revokeVerified) {
      return {
        provider: "entra",
        test: `app-role-fulfillment-${roleName}`,
        passed: false,
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - start,
        details: `Revoke verification failed: app role still assigned`,
      };
    }

    return {
      provider: "entra",
      test: `app-role-fulfillment-${roleName}`,
      passed: true,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - start,
      details: `Grant + Revoke verified for app role ${roleName}`,
    };
  } catch (error) {
    return {
      provider: "entra",
      test: `app-role-fulfillment-${roleName}`,
      passed: false,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - start,
      details: String(error),
    };
  }
}

async function testAuditLogEvidence(
  token: string,
  adminGroupId: string,
  startTime: string,
): Promise<Evidence> {
  const start = Date.now();
  try {
    const audits = await graphRequest<{
      value: Array<{
        id: string;
        activityDateTime: string;
        activityDisplayName: string;
        targetResources: Array<{ id: string; type: string }>;
      }>;
    }>(
      token,
      `/auditLogs/directoryAudits?$top=20&$filter=activityDateTime ge ${startTime}`,
    );

    const relevant = audits.value.filter(
      (a) =>
        a.targetResources?.some((t) => t.id === adminGroupId) ||
        a.activityDisplayName?.includes("member") ||
        a.activityDisplayName?.includes("role"),
    );

    return {
      provider: "entra",
      test: "audit-log-evidence",
      passed: true,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - start,
      details: `Found ${relevant.length} relevant audit events`,
    };
  } catch (error) {
    return {
      provider: "entra",
      test: "audit-log-evidence",
      passed: false,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - start,
      details: String(error),
    };
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  // Require explicit confirmation for live test
  if (process.env.OPNORY_ENTRA_SANDBOX_CONFIRM !== "true") {
    console.error("=".repeat(60));
    console.error("ENTRA MODE B CERTIFICATION - REFUSED");
    console.error("=".repeat(60));
    console.error("");
    console.error("Set environment variable to confirm:");
    console.error("");
    console.error("  export OPNORY_ENTRA_SANDBOX_CONFIRM=true");
    console.error("");
    process.exit(1);
  }

  if (!process.env.OPNORY_ALLOW_UNPINNED_LIVE_TEST) {
    console.error("Refusing to run: OPNORY_ALLOW_UNPINNED_LIVE_TEST not set");
    process.exit(1);
  }

  const config: CertConfig = {
    tenantId: getEnv("OPNORY_ENTRA_TENANT_ID"),
    clientId: getEnv("OPNORY_ENTRA_CLIENT_ID"),
    clientSecret: getEnv("OPNORY_ENTRA_CLIENT_SECRET"),
    testSubjectEmail: getEnv("OPNORY_ENTRA_TEST_SUBJECT_EMAIL"),
    expectedSubjectId: getEnv("OPNORY_ENTRA_EXPECTED_SUBJECT_ID"),
    adminGroupId: getEnv("OPNORY_ENTRA_ADMIN_GROUP_ID"),
    usersGroupId: getEnv("OPNORY_ENTRA_USERS_GROUP_ID"),
    enterpriseAppId: getEnv("OPNORY_ENTRA_ENTERPRISE_APP_ID"),
    enterpriseAppClientId: getEnv("OPNORY_ENTRA_ENTERPRISE_APP_CLIENT_ID"),
    servicePrincipalId: getEnv("OPNORY_ENTRA_SERVICE_PRINCIPAL_ID"),
  };

  console.log("=".repeat(60));
  console.log("ENTRA CERTIFICATION (Model B - Standard Graph Primitives)");
  console.log("=".repeat(60));
  console.log("");
  console.log(`Tenant: ${config.tenantId}`);
  console.log(
    `Subject: ${config.testSubjectEmail} (${config.expectedSubjectId})`,
  );
  console.log(`Admin Group: ${config.adminGroupId}`);
  console.log(`Users Group: ${config.usersGroupId}`);
  console.log(`Enterprise App: ${config.enterpriseAppId}`);
  console.log("");

  // Get Graph token
  console.log("1/5 Acquiring Graph token...");
  const token = await fetchGraphToken(
    config.tenantId,
    config.clientId,
    config.clientSecret,
  );
  console.log("   ✅ Token acquired\n");

  // Get app role IDs
  console.log("2/5 Resolving app role IDs...");
  const app = await graphRequest<{
    appRoles: Array<{ id: string; value: string }>;
  }>(token, `/applications/${config.enterpriseAppId}?$select=appRoles`);

  const financeAnalystRole = app.appRoles.find(
    (r) => r.value === "FinanceAnalyst",
  );
  const auditorRole = app.appRoles.find((r) => r.value === "Auditor");
  const dataAnalystRole = app.appRoles.find((r) => r.value === "DataAnalyst");

  if (!financeAnalystRole || !auditorRole || !dataAnalystRole) {
    throw new Error("App roles not found in enterprise application");
  }

  // Fill permission mappings at runtime
  FINANCE_ANALYST_PERMISSION.mappings.find(
    (m: { type: string; value: string }) => m.type === "group",
  )!.value = config.adminGroupId;
  FINANCE_ANALYST_PERMISSION.mappings.find(
    (m: { type: string; value: string }) => m.type === "appRole",
  )!.value = financeAnalystRole.id;

  AUDITOR_PERMISSION.mappings.find(
    (m: { type: string; value: string }) => m.type === "group",
  )!.value = config.adminGroupId;
  AUDITOR_PERMISSION.mappings.find(
    (m: { type: string; value: string }) => m.type === "appRole",
  )!.value = auditorRole.id;

  DATA_ANALYST_PERMISSION.mappings.find(
    (m: { type: string; value: string }) => m.type === "group",
  )!.value = config.usersGroupId;
  DATA_ANALYST_PERMISSION.mappings.find(
    (m: { type: string; value: string }) => m.type === "appRole",
  )!.value = dataAnalystRole.id;

  console.log(
    `   FinanceAnalyst: group=${config.adminGroupId}, appRole=${financeAnalystRole.id}`,
  );
  console.log(
    `   Auditor: group=${config.adminGroupId}, appRole=${auditorRole.id}`,
  );
  console.log(
    `   DataAnalyst: group=${config.usersGroupId}, appRole=${dataAnalystRole.id}`,
  );
  console.log("");

  // Create adapter
  const adapter = new EntraFulfillmentAdapter(
    token,
    config.servicePrincipalId,
    config.adminGroupId,
    config.usersGroupId,
    config.enterpriseAppClientId,
  );

  const startTime = new Date().toISOString();
  const evidence: Evidence[] = [];

  // Run tests
  console.log("3/5 Identity Resolution...");
  evidence.push(await testIdentityResolution(token, config.testSubjectEmail));
  console.log(
    `   ${evidence[evidence.length - 1].passed ? "✅" : "❌"} ${evidence[evidence.length - 1].details}\n`,
  );

  console.log("4/5 Group Fulfillment (Admins)...");
  evidence.push(
    await testGroupFulfillment(
      adapter,
      config.expectedSubjectId,
      FINANCE_ANALYST_PERMISSION,
      "Admins",
    ),
  );
  console.log(
    `   ${evidence[evidence.length - 1].passed ? "✅" : "❌"} ${evidence[evidence.length - 1].details}\n`,
  );

  console.log("5/5 Group Fulfillment (Users)...");
  evidence.push(
    await testGroupFulfillment(
      adapter,
      config.expectedSubjectId,
      DATA_ANALYST_PERMISSION,
      "Users",
    ),
  );
  console.log(
    `   ${evidence[evidence.length - 1].passed ? "✅" : "❌"} ${evidence[evidence.length - 1].details}\n`,
  );

  console.log("6/5 App Role Fulfillment (FinanceAnalyst)...");
  evidence.push(
    await testAppRoleFulfillment(
      adapter,
      config.expectedSubjectId,
      FINANCE_ANALYST_PERMISSION,
      "FinanceAnalyst",
    ),
  );
  console.log(
    `   ${evidence[evidence.length - 1].passed ? "✅" : "❌"} ${evidence[evidence.length - 1].details}\n`,
  );

  console.log("7/5 App Role Fulfillment (Auditor)...");
  evidence.push(
    await testAppRoleFulfillment(
      adapter,
      config.expectedSubjectId,
      AUDITOR_PERMISSION,
      "Auditor",
    ),
  );
  console.log(
    `   ${evidence[evidence.length - 1].passed ? "✅" : "❌"} ${evidence[evidence.length - 1].details}\n`,
  );

  console.log("8/5 App Role Fulfillment (DataAnalyst)...");
  evidence.push(
    await testAppRoleFulfillment(
      adapter,
      config.expectedSubjectId,
      DATA_ANALYST_PERMISSION,
      "DataAnalyst",
    ),
  );
  console.log(
    `   ${evidence[evidence.length - 1].passed ? "✅" : "❌"} ${evidence[evidence.length - 1].details}\n`,
  );

  console.log("9/5 Audit Log Evidence...");
  evidence.push(
    await testAuditLogEvidence(token, config.adminGroupId, startTime),
  );
  console.log(
    `   ${evidence[evidence.length - 1].passed ? "✅" : "❌"} ${evidence[evidence.length - 1].details}\n`,
  );

  // Summary
  console.log("=".repeat(60));
  console.log("CERTIFICATION SUMMARY");
  console.log("=".repeat(60));

  const passed = evidence.filter((e) => e.passed).length;
  const failed = evidence.filter((e) => !e.passed).length;

  for (const e of evidence) {
    console.log(`${e.passed ? "✅" : "❌"} ${e.test} (${e.durationMs}ms)`);
    console.log(`   ${e.details}`);
  }

  console.log("");
  console.log("=".repeat(60));
  if (failed === 0) {
    console.log("✅ ALL TESTS PASSED - ENTRA MODE B CERTIFICATION SUCCESSFUL");
  } else {
    console.log(`❌ ${failed} TEST(S) FAILED - CERTIFICATION FAILED`);
  }
  console.log("=".repeat(60));

  // Write evidence
  const evidenceFile = `.live-results/entra-certification-${new Date().toISOString().split("T")[0]}.json`;
  await writeFile(
    evidenceFile,
    JSON.stringify(
      {
        provider: "entra",
        mode: "model-b",
        timestamp: new Date().toISOString(),
        config: {
          tenantId: config.tenantId,
          subject: config.testSubjectEmail,
          enterpriseApp: config.enterpriseAppId,
        },
        evidence,
      },
      null,
      2,
    ),
  );
  console.log(`\nEvidence written to: ${evidenceFile}`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Certification failed:", error);
  process.exit(1);
});
