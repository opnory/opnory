#!/usr/bin/env bun

// Entra Model B Certification via FulfillmentAdapter Conformance Harness
// Tests the governance lifecycle through the generic adapter contract
// Run with: OPNORY_ENTRA_TENANT_ID=... OPNORY_ENTRA_CLIENT_ID=... OPNORY_ENTRA_CLIENT_SECRET=... OPNORY_ENTRA_SANDBOX_CONFIRM=true bun run scripts/live-governance/model-b/certify-via-adapter.ts

import { getLogger } from "@opnory/observability";
import { writeFile } from "fs/promises";

import {
  SubjectRef,
  ResourceScope,
  Permission,
  EvidenceEvent,
} from "@opnory/governance-core";
import {
  EntraAdapter,
  EntraAdapterConfig,
  runFulfillmentAdapterCertification,
  ConformanceFixture,
  CertificationEvidenceProbe,
  ConformanceTiming,
} from "@opnory/governance-core";

const log = getLogger("certification:entra-adapter");

// ============================================================================
// Graph API Helpers
// ============================================================================

async function graphRequest<T>(token: string, path: string): Promise<T> {
  const response = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Graph request failed: ${response.status} ${body}`);
  }

  return response.json() as Promise<T>;
}

async function fetchGraphToken(
  tenantId: string,
  clientId: string,
  clientSecret: string
): Promise<string> {
  const response = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
        scope: "https://graph.microsoft.com/.default",
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Token request failed: ${response.status} ${body}`);
  }

  const data = await response.json();
  return data.access_token;
}

// ============================================================================
// Configuration
// ============================================================================

interface CertConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  testSubjectEmail: string;
  adminGroupId: string;
  usersGroupId: string;
  servicePrincipalId: string;
  enterpriseAppObjectId: string;
  // App role IDs are now fetched dynamically
}

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} not set`);
  }
  return value;
}

// ============================================================================
// Test Permissions (Opnory domain objects — no Entra concepts leak out)
// ============================================================================

const ADMIN_GROUP_PERMISSION: Permission = {
  id: "entra-admin-group",
  name: "Entra Admin Group Membership",
  description: "Membership in Opnory-Certification-Admins group",
  mappings: [{ provider: "entra", type: "group", value: "" }],
};

const USERS_GROUP_PERMISSION: Permission = {
  id: "entra-users-group",
  name: "Entra Users Group Membership",
  description: "Membership in Opnory-Certification-Users group",
  mappings: [{ provider: "entra", type: "group", value: "" }],
};

const FINANCE_ANALYST_PERMISSION: Permission = {
  id: "entra-finance-analyst",
  name: "Entra FinanceAnalyst App Role",
  description: "App role assignment to FinanceAnalyst",
  mappings: [{ provider: "entra", type: "appRole", value: "" }],
};

const DATA_ANALYST_PERMISSION: Permission = {
  id: "entra-data-analyst",
  name: "Entra DataAnalyst App Role",
  description: "App role assignment to DataAnalyst",
  mappings: [{ provider: "entra", type: "appRole", value: "" }],
};

const AUDITOR_PERMISSION: Permission = {
  id: "entra-auditor",
  name: "Entra Auditor App Role",
  description: "App role assignment to Auditor",
  mappings: [{ provider: "entra", type: "appRole", value: "" }],
};

// ============================================================================
// Optional: Entra-specific evidence collection (directory audit logs)
// Kept outside the FulfillmentAdapter contract
// ============================================================================

class EntraEvidenceProbe implements CertificationEvidenceProbe {
  private adapter: EntraAdapter;
  private subjectId: string;
  private startTime: Date;

  constructor(adapter: EntraAdapter, subjectId: string) {
    this.adapter = adapter;
    this.subjectId = subjectId;
    this.startTime = new Date();
  }

  async collect(): Promise<EvidenceEvent[]> {
    // In a real implementation, this would query Microsoft Graph audit logs
    // For certification, we return the events we already captured during the run
    return [];
  }
}

// ============================================================================
// Main
// ============================================================================

async function fetchAppRoleIds(
  token: string,
  enterpriseAppObjectId: string
): Promise<{ financeAnalyst: string; dataAnalyst: string; auditor: string }> {
  const app = await graphRequest<{
    appRoles: Array<{ id: string; value: string; displayName: string }>;
  }>(token, `/applications/${enterpriseAppObjectId}`);
  
  const roles = app.appRoles;
  const financeAnalyst = roles.find(r => r.value === "FinanceAnalyst")?.id;
  const dataAnalyst = roles.find(r => r.value === "DataAnalyst")?.id;
  const auditor = roles.find(r => r.value === "Auditor")?.id;
  
  if (!financeAnalyst || !dataAnalyst || !auditor) {
    throw new Error("Could not find all required app roles (FinanceAnalyst, DataAnalyst, Auditor)");
  }
  
  return { financeAnalyst, dataAnalyst, auditor };
}

async function runCertification() {
  const startTime = Date.now();
  console.log("🔍 Entra Model B Certification via FulfillmentAdapter Conformance Harness");
  console.log("=".repeat(70));

  // Load config from environment
  const tenantId = getEnv("OPNORY_ENTRA_TENANT_ID");
  const clientId = getEnv("OPNORY_ENTRA_CLIENT_ID");
  const clientSecret = getEnv("OPNORY_ENTRA_CLIENT_SECRET");
  const testSubjectEmail = getEnv("OPNORY_ENTRA_TEST_SUBJECT_EMAIL");
  const adminGroupId = getEnv("OPNORY_ENTRA_ADMIN_GROUP_ID");
  const usersGroupId = getEnv("OPNORY_ENTRA_USERS_GROUP_ID");
  const servicePrincipalId = getEnv("OPNORY_ENTRA_SERVICE_PRINCIPAL_ID");
  const enterpriseAppObjectId = getEnv("OPNORY_ENTRA_ENTERPRISE_APP_OBJECT_ID");

  // Get Graph token to fetch app role IDs
  const token = await fetchGraphToken(tenantId, clientId, clientSecret);
  
  // Fetch app role IDs dynamically from the enterprise application
  console.log("\n📋 Fetching app role IDs from enterprise application...");
  const { financeAnalyst, dataAnalyst, auditor } = await fetchAppRoleIds(token, enterpriseAppObjectId);
  console.log(`   FinanceAnalyst: ${financeAnalyst}`);
  console.log(`   DataAnalyst: ${dataAnalyst}`);
  console.log(`   Auditor: ${auditor}`);

  // Fill permission mappings at runtime (provider-specific values)
  ADMIN_GROUP_PERMISSION.mappings.find((m: any) => m.type === "group")!.value =
    adminGroupId;
  USERS_GROUP_PERMISSION.mappings.find((m: any) => m.type === "group")!.value =
    usersGroupId;
  FINANCE_ANALYST_PERMISSION.mappings.find((m: any) => m.type === "appRole")!.value =
    financeAnalyst;
  DATA_ANALYST_PERMISSION.mappings.find((m: any) => m.type === "appRole")!.value =
    dataAnalyst;
  AUDITOR_PERMISSION.mappings.find((m: any) => m.type === "appRole")!.value =
    auditor;

  // Create adapter
  const adapterConfig: EntraAdapterConfig = {
    tenantId,
    clientId,
    clientSecret,
    servicePrincipalId,
    enterpriseAppObjectId,
  };

  const adapter = new EntraAdapter(adapterConfig);

  // Create subject reference
  const subjectRef: SubjectRef = {
    type: "user",
    identifier: testSubjectEmail,
    tenantId,
  };

  // Common scope
  const scope: ResourceScope = {
    tenantId,
  };

  // Fixtures — each permission + its RoleAssignment.roleId
  const fixtures: ConformanceFixture[] = [
    { permission: ADMIN_GROUP_PERMISSION, roleId: "admin-group" },
    { permission: USERS_GROUP_PERMISSION, roleId: "users-group" },
    { permission: FINANCE_ANALYST_PERMISSION, roleId: "finance-analyst" },
    { permission: DATA_ANALYST_PERMISSION, roleId: "data-analyst" },
    { permission: AUDITOR_PERMISSION, roleId: "auditor" },
  ];

  // Evidence probe (optional, provider-specific)
  const evidenceProbe = new EntraEvidenceProbe(adapter, ""); // subjectId filled after resolve

  // Run conformance harness
  console.log("\n▶ Running conformance suite...\n");

  // Provider-specific timing (Entra Model B)
  const entraTiming: ConformanceTiming = {
    verifyAttempts: 50,
    verifyIntervalMs: 5000,
    interFixtureDelayMs: 60000,
    postVerifyDelayMs: 15000,
  };

  const result = await runFulfillmentAdapterCertification({
    provider: "entra",
    adapter,
    subject: subjectRef,
    fixtures,
    scope,
    evidenceProbe,
    timing: entraTiming,
  });

  console.log("\n[DEBUG] Conformance result:", JSON.stringify(result, null, 2));

  // Report
  console.log("\n" + "=".repeat(70));
  console.log("📋 CERTIFICATION RESULT");
  console.log("=".repeat(70));
  console.log(`Provider:      ${result.provider}`);
  console.log(`Subject:       ${result.subject.providerSubjectId}`);
  console.log(`Overall:       ${result.passed ? "✅ PASSED" : "❌ FAILED"}`);
  console.log("");

  for (const fixture of result.fixtures) {
    const icon = fixture.passed ? "✅" : "❌";
    console.log(`${icon} ${fixture.permissionId} (roleId: ${fixture.roleId})`);
    if (!fixture.passed && fixture.error) {
      console.log(`   Error: ${fixture.error}`);
    }
    console.log(
      `   grant: ${fixture.grant.passed ? "✅" : "❌"} | verify: ${fixture.verifyAfterGrant.passed ? "✅" : "❌"} | grant-idempotent: ${fixture.grantIdempotent.passed ? "✅" : "❌"} | revoke: ${fixture.revoke.passed ? "✅" : "❌"} | verify-revoked: ${fixture.verifyAfterRevoke.passed ? "✅" : "❌"} | revoke-idempotent: ${fixture.revokeIdempotent.passed ? "✅" : "❌"}`,
    );
  }

  // Write evidence artifact
  const artifact = {
    provider: result.provider,
    subject: result.subject,
    passed: result.passed,
    fixtures: result.fixtures,
    evidence: result.evidence,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startTime,
    schemaVersion: "1",
  };

  const artifactPath = `.live-results/entra-adapter-certification-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await writeFile(artifactPath, JSON.stringify(artifact, null, 2));
  console.log(`\n📄 Evidence written to: ${artifactPath}`);

  if (!result.passed) {
    console.log("\n❌ Certification FAILED");
    process.exit(1);
  }

  console.log("\n✅ Certification PASSED");
  process.exit(0);
}

runCertification().catch((error) => {
  console.error("💥 Fatal error:", error);
  process.exit(1);
});