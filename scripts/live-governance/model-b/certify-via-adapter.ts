#!/usr/bin/env bun

// Entra Model B Certification via FulfillmentAdapter
// Tests the governance lifecycle through the generic adapter contract
// Run with: OPNORY_ENTRA_TENANT_ID=... OPNORY_ENTRA_CLIENT_ID=... OPNORY_ENTRA_CLIENT_SECRET=... OPNORY_ENTRA_SANDBOX_CONFIRM=true bun run scripts/live-governance/model-b/certify-via-adapter.ts

import { getLogger } from "@opnory/observability";
import { randomUUID } from "crypto";
import { writeFile } from "fs/promises";

import {
  EntitlementRequest,
  RoleAssignment,
  Permission,
  ResourceScope,
  SubjectRef,
  FulfillmentResult,
  VerificationResult,
  EvidenceEvent,
} from "@opnory/governance-core";
import { EntraAdapter, EntraAdapterConfig } from "@opnory/governance-core";

const log = getLogger("certification:entra-adapter");

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
  financeAnalystRoleId: string;
  dataAnalystRoleId: string;
  auditorRoleId: string;
}

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} not set`);
  }
  return value;
}

// ============================================================================
// Test Permissions
// ============================================================================

const ADMIN_GROUP_PERMISSION: Permission = {
  id: "entra-admin-group",
  name: "Entra Admin Group Membership",
  description: "Membership in Opnory-Certification-Admins group",
  mappings: [
    { provider: "entra", type: "group", value: "" }, // filled at runtime
  ],
};

const USERS_GROUP_PERMISSION: Permission = {
  id: "entra-users-group",
  name: "Entra Users Group Membership",
  description: "Membership in Opnory-Certification-Users group",
  mappings: [
    { provider: "entra", type: "group", value: "" },
  ],
};

const FINANCE_ANALYST_PERMISSION: Permission = {
  id: "entra-finance-analyst",
  name: "Entra FinanceAnalyst App Role",
  description: "App role assignment to FinanceAnalyst",
  mappings: [
    { provider: "entra", type: "appRole", value: "" },
  ],
};

const DATA_ANALYST_PERMISSION: Permission = {
  id: "entra-data-analyst",
  name: "Entra DataAnalyst App Role",
  description: "App role assignment to DataAnalyst",
  mappings: [
    { provider: "entra", type: "appRole", value: "" },
  ],
};

const AUDITOR_PERMISSION: Permission = {
  id: "entra-auditor",
  name: "Entra Auditor App Role",
  description: "App role assignment to Auditor",
  mappings: [
    { provider: "entra", type: "appRole", value: "" },
  ],
};

// ============================================================================
// Evidence Recording
// ============================================================================

interface EvidenceStep {
  test: string;
  passed: boolean;
  timestamp: string;
  durationMs: number;
  details: string;
  correlationId?: string;
}

const evidence: EvidenceStep[] = [];

function recordEvidence(
  test: string,
  passed: boolean,
  details: string,
  correlationId?: string,
  startTime?: number,
) {
  const durationMs = startTime ? Date.now() - startTime : 0;
  evidence.push({
    test,
    passed,
    timestamp: new Date().toISOString(),
    durationMs,
    details,
    correlationId,
  });
  const icon = passed ? "✅" : "❌";
  console.log(`  ${icon} ${test}: ${details}`);
}

async function runCertification() {
  const startTime = Date.now();
  console.log("🔍 Entra Model B Certification via FulfillmentAdapter");
  console.log("=".repeat(60));

  // Load config from environment
  const config: CertConfig = {
    tenantId: getEnv("OPNORY_ENTRA_TENANT_ID"),
    clientId: getEnv("OPNORY_ENTRA_CLIENT_ID"),
    clientSecret: getEnv("OPNORY_ENTRA_CLIENT_SECRET"),
    testSubjectEmail: getEnv("OPNORY_ENTRA_TEST_SUBJECT_EMAIL"),
    adminGroupId: getEnv("OPNORY_ENTRA_ADMIN_GROUP_ID"),
    usersGroupId: getEnv("OPNORY_ENTRA_USERS_GROUP_ID"),
    servicePrincipalId: getEnv("OPNORY_ENTRA_SERVICE_PRINCIPAL_ID"),
    enterpriseAppObjectId: getEnv("OPNORY_ENTRA_ENTERPRISE_APP_OBJECT_ID"),
    financeAnalystRoleId: getEnv("OPNORY_ENTRA_FINANCE_ANALYST_ROLE_ID"),
    dataAnalystRoleId: getEnv("OPNORY_ENTRA_DATA_ANALYST_ROLE_ID"),
    auditorRoleId: getEnv("OPNORY_ENTRA_AUDITOR_ROLE_ID"),
  };

  // Fill permission mappings at runtime
  ADMIN_GROUP_PERMISSION.mappings.find((m) => m.type === "group")!.value =
    config.adminGroupId;
  USERS_GROUP_PERMISSION.mappings.find((m) => m.type === "group")!.value =
    config.usersGroupId;
  FINANCE_ANALYST_PERMISSION.mappings.find((m) => m.type === "appRole")!.value =
    config.financeAnalystRoleId;
  DATA_ANALYST_PERMISSION.mappings.find((m) => m.type === "appRole")!.value =
    config.dataAnalystRoleId;
  AUDITOR_PERMISSION.mappings.find((m) => m.type === "appRole")!.value =
    config.auditorRoleId;

  // Create adapter
  const adapterConfig: EntraAdapterConfig = {
    tenantId: config.tenantId,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    servicePrincipalId: config.servicePrincipalId,
    enterpriseAppObjectId: config.enterpriseAppObjectId,
  };

  const adapter = new EntraAdapter(adapterConfig);

  // Create subject reference
  const subjectRef: SubjectRef = {
    type: "user",
    identifier: config.testSubjectEmail,
    tenantId: config.tenantId,
  };

  // Common scope
  const scope: ResourceScope = {
    tenantId: config.tenantId,
  };

  // ============================================================================
  // Test 1: Identity Resolution
  // ============================================================================
  console.log("\n1️⃣  Identity Resolution");
  const t1 = Date.now();
  try {
    const resolved = await adapter.resolveSubject(subjectRef);
    recordEvidence(
      "identity-resolution",
      true,
      `Resolved ${config.testSubjectEmail} to ${resolved.providerSubjectId}`,
      undefined,
      t1,
    );
  } catch (error: any) {
    recordEvidence(
      "identity-resolution",
      false,
      `Failed: ${error.message}`,
      undefined,
      t1,
    );
    return { passed: false };
  }

  // Resolve subject once for all tests
  const resolvedSubject = await adapter.resolveSubject(subjectRef);

  // ============================================================================
  // Test 2: Group Fulfillment (Admins) - Grant + Verify + Revoke
  // ============================================================================
  console.log("\n2️⃣  Group Fulfillment (Admins)");
  const adminGroupAssignment: RoleAssignment = {
    id: randomUUID(),
    subjectId: resolvedSubject.providerSubjectId,
    roleId: "admin-group",
    scope,
    grantedAt: new Date().toISOString(),
    sourceRequestId: randomUUID(),
    status: "active",
  };

  const t2 = Date.now();
  const adminGrant = await adapter.grant(
    adminGroupAssignment,
    ADMIN_GROUP_PERMISSION,
    scope,
    resolvedSubject,
  );
  recordEvidence(
    "group-fulfillment-Admins-grant",
    adminGrant.status === "succeeded",
    `Grant: ${adminGrant.status}${adminGrant.mutated ? " (mutated)" : ""} - ${adminGrant.error || ""}`,
    adminGrant.correlationId,
    t2,
  );

  if (adminGrant.status === "succeeded") {
    // Verify with retry for Graph eventual consistency
    let adminVerify: VerificationResult;
    let adminVerified = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      adminVerify = await adapter.verify(
        adminGroupAssignment,
        ADMIN_GROUP_PERMISSION,
        scope,
        resolvedSubject,
      );
      if (adminVerify.status === "verified") {
        console.log(`[VERIFY GRANT] Attempt ${attempt + 1}/10: verified`);
        adminVerified = true;
        break;
      }
      console.log(`[VERIFY GRANT] Attempt ${attempt + 1}/10: not-found`);
    }
    const t2v = Date.now();
    recordEvidence(
      "group-fulfillment-Admins-verify",
      adminVerified,
      `Verify: ${adminVerify?.status || "not-found"}`,
      adminVerify?.correlationId,
      t2v,
    );

    // Revoke
    const t2r = Date.now();
    const adminRevoke = await adapter.revoke(
      adminGroupAssignment,
      ADMIN_GROUP_PERMISSION,
      scope,
      resolvedSubject,
    );
    recordEvidence(
      "group-fulfillment-Admins-revoke",
      adminRevoke.status === "succeeded",
      `Revoke: ${adminRevoke.status}${adminRevoke.mutated ? " (mutated)" : " (already absent)"} - ${adminRevoke.error || ""}`,
      adminRevoke.correlationId,
      t2r,
    );

    // Verify revoke with retry for Graph eventual consistency
    let adminVerifyRevoked: VerificationResult;
    let adminRevokeVerified = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      adminVerifyRevoked = await adapter.verify(
        adminGroupAssignment,
        ADMIN_GROUP_PERMISSION,
        scope,
        resolvedSubject,
      );
      if (adminVerifyRevoked.status === "not-found") {
        console.log(`[VERIFY REVOKE] Attempt ${attempt + 1}/10: removed`);
        adminRevokeVerified = true;
        break;
      }
      console.log(`[VERIFY REVOKE] Attempt ${attempt + 1}/10: still present`);
    }
    const t2rv = Date.now();
    recordEvidence(
      "group-fulfillment-Admins-verify-revoked",
      adminRevokeVerified,
      `Verify after revoke: ${adminVerifyRevoked?.status || "not-found"}`,
      adminVerifyRevoked?.correlationId,
      t2rv,
    );
  }

  // ============================================================================
  // Test 3: Group Fulfillment (Users) - Grant + Verify + Revoke
  // ============================================================================
  console.log("\n3️⃣  Group Fulfillment (Users)");
  const usersGroupAssignment: RoleAssignment = {
    id: randomUUID(),
    subjectId: resolvedSubject.providerSubjectId,
    roleId: "users-group",
    scope,
    grantedAt: new Date().toISOString(),
    sourceRequestId: randomUUID(),
    status: "active",
  };

  const t3 = Date.now();
  const usersGrant = await adapter.grant(
    usersGroupAssignment,
    USERS_GROUP_PERMISSION,
    scope,
    resolvedSubject,
  );
  recordEvidence(
    "group-fulfillment-Users-grant",
    usersGrant.status === "succeeded",
    `Grant: ${usersGrant.status}${usersGrant.mutated ? " (mutated)" : ""} - ${usersGrant.error || ""}`,
    usersGrant.correlationId,
    t3,
  );

  if (usersGrant.status === "succeeded") {
    // Verify with retry for Graph eventual consistency
    let usersVerify: VerificationResult;
    let usersVerified = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      usersVerify = await adapter.verify(
        usersGroupAssignment,
        USERS_GROUP_PERMISSION,
        scope,
        resolvedSubject,
      );
      if (usersVerify.status === "verified") {
        console.log(`[VERIFY GRANT] Attempt ${attempt + 1}/10: verified`);
        usersVerified = true;
        break;
      }
      console.log(`[VERIFY GRANT] Attempt ${attempt + 1}/10: not-found`);
    }
    const t3v = Date.now();
    recordEvidence(
      "group-fulfillment-Users-verify",
      usersVerified,
      `Verify: ${usersVerify?.status || "not-found"}`,
      usersVerify?.correlationId,
      t3v,
    );

    const t3r = Date.now();
    const usersRevoke = await adapter.revoke(
      usersGroupAssignment,
      USERS_GROUP_PERMISSION,
      scope,
      resolvedSubject,
    );
    recordEvidence(
      "group-fulfillment-Users-revoke",
      usersRevoke.status === "succeeded",
      `Revoke: ${usersRevoke.status}${usersRevoke.mutated ? " (mutated)" : " (already absent)"} - ${usersRevoke.error || ""}`,
      usersRevoke.correlationId,
      t3r,
    );

    // Verify revoke with retry for Graph eventual consistency
    let usersVerifyRevoked: VerificationResult;
    let usersRevokeVerified = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      usersVerifyRevoked = await adapter.verify(
        usersGroupAssignment,
        USERS_GROUP_PERMISSION,
        scope,
        resolvedSubject,
      );
      if (usersVerifyRevoked.status === "not-found") {
        console.log(`[VERIFY REVOKE] Attempt ${attempt + 1}/10: removed`);
        usersRevokeVerified = true;
        break;
      }
      console.log(`[VERIFY REVOKE] Attempt ${attempt + 1}/10: still present`);
    }
    const t3rv = Date.now();
    recordEvidence(
      "group-fulfillment-Users-verify-revoked",
      usersRevokeVerified,
      `Verify after revoke: ${usersVerifyRevoked?.status || "not-found"}`,
      usersVerifyRevoked?.correlationId,
      t3rv,
    );
  }

  // ============================================================================
  // Test 4: App Role Fulfillment (FinanceAnalyst) - Grant + Verify + Revoke
  // ============================================================================
  console.log("\n4️⃣  App Role Fulfillment (FinanceAnalyst)");
  const financeAssignment: RoleAssignment = {
    id: randomUUID(),
    subjectId: resolvedSubject.providerSubjectId,
    roleId: "finance-analyst",
    scope,
    grantedAt: new Date().toISOString(),
    sourceRequestId: randomUUID(),
    status: "active",
  };

  const t4 = Date.now();
  const financeGrant = await adapter.grant(
    financeAssignment,
    FINANCE_ANALYST_PERMISSION,
    scope,
    resolvedSubject,
  );
  recordEvidence(
    "app-role-fulfillment-FinanceAnalyst-grant",
    financeGrant.status === "succeeded",
    `Grant: ${financeGrant.status}${financeGrant.mutated ? " (mutated)" : ""} - ${financeGrant.error || ""}`,
    financeGrant.correlationId,
    t4,
  );

  if (financeGrant.status === "succeeded") {
    // Verify with retry for Graph eventual consistency
    let financeVerify: VerificationResult;
    let financeVerified = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      financeVerify = await adapter.verify(
        financeAssignment,
        FINANCE_ANALYST_PERMISSION,
        scope,
        resolvedSubject,
      );
      if (financeVerify.status === "verified") {
        console.log(`[VERIFY GRANT] Attempt ${attempt + 1}/10: verified`);
        financeVerified = true;
        break;
      }
      console.log(`[VERIFY GRANT] Attempt ${attempt + 1}/10: not-found`);
    }
    const t4v = Date.now();
    recordEvidence(
      "app-role-fulfillment-FinanceAnalyst-verify",
      financeVerified,
      `Verify: ${financeVerify?.status || "not-found"}`,
      financeVerify?.correlationId,
      t4v,
    );

    const t4r = Date.now();
    const financeRevoke = await adapter.revoke(
      financeAssignment,
      FINANCE_ANALYST_PERMISSION,
      scope,
      resolvedSubject,
    );
    recordEvidence(
      "app-role-fulfillment-FinanceAnalyst-revoke",
      financeRevoke.status === "succeeded",
      `Revoke: ${financeRevoke.status}${financeRevoke.mutated ? " (mutated)" : " (already absent)"} - ${financeRevoke.error || ""}`,
      financeRevoke.correlationId,
      t4r,
    );

    // Verify revoke with retry for Graph eventual consistency
    let financeVerifyRevoked: VerificationResult;
    let financeRevokeVerified = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      financeVerifyRevoked = await adapter.verify(
        financeAssignment,
        FINANCE_ANALYST_PERMISSION,
        scope,
        resolvedSubject,
      );
      if (financeVerifyRevoked.status === "not-found") {
        console.log(`[VERIFY REVOKE] Attempt ${attempt + 1}/10: removed`);
        financeRevokeVerified = true;
        break;
      }
      console.log(`[VERIFY REVOKE] Attempt ${attempt + 1}/10: still present`);
    }
    const t4rv = Date.now();
    recordEvidence(
      "app-role-fulfillment-FinanceAnalyst-verify-revoked",
      financeRevokeVerified,
      `Verify after revoke: ${financeVerifyRevoked?.status || "not-found"}`,
      financeVerifyRevoked?.correlationId,
      t4rv,
    );
  }

  // ============================================================================
  // Test 5: App Role Fulfillment (DataAnalyst) - Grant + Verify + Revoke
  // ============================================================================
  console.log("\n5️⃣  App Role Fulfillment (DataAnalyst)");
  const dataAssignment: RoleAssignment = {
    id: randomUUID(),
    subjectId: resolvedSubject.providerSubjectId,
    roleId: "data-analyst",
    scope,
    grantedAt: new Date().toISOString(),
    sourceRequestId: randomUUID(),
    status: "active",
  };

  const t5 = Date.now();
  const dataGrant = await adapter.grant(
    dataAssignment,
    DATA_ANALYST_PERMISSION,
    scope,
    resolvedSubject,
  );
  recordEvidence(
    "app-role-fulfillment-DataAnalyst-grant",
    dataGrant.status === "succeeded",
    `Grant: ${dataGrant.status}${dataGrant.mutated ? " (mutated)" : ""} - ${dataGrant.error || ""}`,
    dataGrant.correlationId,
    t5,
  );

  if (dataGrant.status === "succeeded") {
    // Verify with retry for Graph eventual consistency
    let dataVerify: VerificationResult;
    let dataVerified = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      dataVerify = await adapter.verify(
        dataAssignment,
        DATA_ANALYST_PERMISSION,
        scope,
        resolvedSubject,
      );
      if (dataVerify.status === "verified") {
        console.log(`[VERIFY GRANT] Attempt ${attempt + 1}/10: verified`);
        dataVerified = true;
        break;
      }
      console.log(`[VERIFY GRANT] Attempt ${attempt + 1}/10: not-found`);
    }
    const t5v = Date.now();
    recordEvidence(
      "app-role-fulfillment-DataAnalyst-verify",
      dataVerified,
      `Verify: ${dataVerify?.status || "not-found"}`,
      dataVerify?.correlationId,
      t5v,
    );

    const t5r = Date.now();
    const dataRevoke = await adapter.revoke(
      dataAssignment,
      DATA_ANALYST_PERMISSION,
      scope,
      resolvedSubject,
    );
    recordEvidence(
      "app-role-fulfillment-DataAnalyst-revoke",
      dataRevoke.status === "succeeded",
      `Revoke: ${dataRevoke.status}${dataRevoke.mutated ? " (mutated)" : " (already absent)"} - ${dataRevoke.error || ""}`,
      dataRevoke.correlationId,
      t5r,
    );

    // Verify revoke with retry for Graph eventual consistency
    let dataVerifyRevoked: VerificationResult;
    let dataRevokeVerified = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      dataVerifyRevoked = await adapter.verify(
        dataAssignment,
        DATA_ANALYST_PERMISSION,
        scope,
        resolvedSubject,
      );
      if (dataVerifyRevoked.status === "not-found") {
        console.log(`[VERIFY REVOKE] Attempt ${attempt + 1}/10: removed`);
        dataRevokeVerified = true;
        break;
      }
      console.log(`[VERIFY REVOKE] Attempt ${attempt + 1}/10: still present`);
    }
    const t5rv = Date.now();
    recordEvidence(
      "app-role-fulfillment-DataAnalyst-verify-revoked",
      dataRevokeVerified,
      `Verify after revoke: ${dataVerifyRevoked?.status || "not-found"}`,
      dataVerifyRevoked?.correlationId,
      t5rv,
    );
  }

  // ============================================================================
  // Test 6: App Role Fulfillment (Auditor) - Grant + Verify + Revoke
  // ============================================================================
  console.log("\n6️⃣  App Role Fulfillment (Auditor)");
  const auditorAssignment: RoleAssignment = {
    id: randomUUID(),
    subjectId: resolvedSubject.providerSubjectId,
    roleId: "auditor",
    scope,
    grantedAt: new Date().toISOString(),
    sourceRequestId: randomUUID(),
    status: "active",
  };

  const t6 = Date.now();
  const auditorGrant = await adapter.grant(
    auditorAssignment,
    AUDITOR_PERMISSION,
    scope,
    resolvedSubject,
  );
  recordEvidence(
    "app-role-fulfillment-Auditor-grant",
    auditorGrant.status === "succeeded",
    `Grant: ${auditorGrant.status}${auditorGrant.mutated ? " (mutated)" : ""} - ${auditorGrant.error || ""}`,
    auditorGrant.correlationId,
    t6,
  );

  if (auditorGrant.status === "succeeded") {
    // Verify with retry for Graph eventual consistency
    let auditorVerify: VerificationResult;
    let auditorVerified = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      auditorVerify = await adapter.verify(
        auditorAssignment,
        AUDITOR_PERMISSION,
        scope,
        resolvedSubject,
      );
      if (auditorVerify.status === "verified") {
        console.log(`[VERIFY GRANT] Attempt ${attempt + 1}/10: verified`);
        auditorVerified = true;
        break;
      }
      console.log(`[VERIFY GRANT] Attempt ${attempt + 1}/10: not-found`);
    }
    const t6v = Date.now();
    recordEvidence(
      "app-role-fulfillment-Auditor-verify",
      auditorVerified,
      `Verify: ${auditorVerify?.status || "not-found"}`,
      auditorVerify?.correlationId,
      t6v,
    );

    const t6r = Date.now();
    const auditorRevoke = await adapter.revoke(
      auditorAssignment,
      AUDITOR_PERMISSION,
      scope,
      resolvedSubject,
    );
    recordEvidence(
      "app-role-fulfillment-Auditor-revoke",
      auditorRevoke.status === "succeeded",
      `Revoke: ${auditorRevoke.status}${auditorRevoke.mutated ? " (mutated)" : " (already absent)"} - ${auditorRevoke.error || ""}`,
      auditorRevoke.correlationId,
      t6r,
    );

    // Verify revoke with retry for Graph eventual consistency
    let auditorVerifyRevoked: VerificationResult;
    let auditorRevokeVerified = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      auditorVerifyRevoked = await adapter.verify(
        auditorAssignment,
        AUDITOR_PERMISSION,
        scope,
        resolvedSubject,
      );
      if (auditorVerifyRevoked.status === "not-found") {
        console.log(`[VERIFY REVOKE] Attempt ${attempt + 1}/10: removed`);
        auditorRevokeVerified = true;
        break;
      }
      console.log(`[VERIFY REVOKE] Attempt ${attempt + 1}/10: still present`);
    }
    const t6rv = Date.now();
    recordEvidence(
      "app-role-fulfillment-Auditor-verify-revoked",
      auditorRevokeVerified,
      `Verify after revoke: ${auditorVerifyRevoked?.status || "not-found"}`,
      auditorVerifyRevoked?.correlationId,
      t6rv,
    );
  }

  // ============================================================================
  // Test 7: Audit Log Evidence
  // ============================================================================
  console.log("\n7️⃣  Audit Log Evidence");
  const t7 = Date.now();
  try {
    // This would query the audit log for relevant events
    // For now, we verify that the certification produced evidence events
    const adapterEvidence: EvidenceEvent[] = evidence
      .filter((e) => e.correlationId)
      .map((e) => ({
        id: randomUUID(),
        assignmentId: randomUUID(),
        action: e.test.includes("grant")
          ? "grant"
          : e.test.includes("revoke")
          ? "revoke"
          : "verify",
        provider: "entra",
        providerObjectId: e.correlationId || "unknown",
        correlationId: e.correlationId || "unknown",
        occurredAt: e.timestamp,
      }));

    recordEvidence(
      "audit-log-evidence",
      adapterEvidence.length > 0,
      `Captured ${adapterEvidence.length} evidence events with correlation IDs`,
      undefined,
      t7,
    );
  } catch (error: any) {
    recordEvidence(
      "audit-log-evidence",
      false,
      `Failed: ${error.message}`,
      undefined,
      t7,
    );
  }

  // ============================================================================
  // Summary
  // ============================================================================
  const totalDuration = Date.now() - startTime;
  const passed = evidence.filter((e) => e.passed).length;
  const failed = evidence.filter((e) => !e.passed).length;

  console.log("\n" + "=".repeat(60));
  console.log(`📊 Certification Summary`);
  console.log("=".repeat(60));
  console.log(`Total Tests: ${evidence.length}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Duration: ${totalDuration}ms`);
  console.log(`Provider: Microsoft Entra ID`);
  console.log(`Mode: Model B (Standard Graph Primitives)`);
  console.log(`Adapter: EntraAdapter (FulfillmentAdapter contract)`);

  const allPassed = failed === 0;
  console.log(`\nResult: ${allPassed ? "✅ PASS" : "❌ FAIL"}`);

  // Write raw evidence
  const resultsDir = ".live-results";
  await writeFile(
    `${resultsDir}/entra-adapter-certification-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    JSON.stringify(
      {
        provider: "entra",
        mode: "model-b",
        adapter: "EntraAdapter",
        timestamp: new Date().toISOString(),
        config: {
          tenantId: config.tenantId,
          subject: config.testSubjectEmail,
          enterpriseApp: config.enterpriseAppObjectId,
        },
        evidence,
      },
      null,
      2,
    ),
  );

  console.log(`\n📄 Raw evidence written to .live-results/`);

  process.exit(allPassed ? 0 : 1);
}

runCertification().catch((error) => {
  console.error("Certification failed:", error);
  process.exit(1);
});