import {
  OktaAdapter,
  OktaAdapterConfig,
  runFulfillmentAdapterCertification,
  ConformanceFixture,
  CertificationEvidenceProbe,
  ConformanceTiming,
  ConformanceResult,
} from "@opnory/governance-core";
import { SubjectRef, Permission, ResourceScope, RoleAssignment } from "@opnory/governance-core";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { getEnv, getEnvOptional, requireEnvVars } from "@opnory/governance-core";
import { EvidenceRecorder } from "../common";

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("   Opnory Governance — Okta Model B Certification");
  console.log("   FulfillmentAdapter Conformance Harness");
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Require live test flag
  if (!process.env.OPNORY_LIVE_GOVERNANCE_TESTS) {
    throw new Error("OPNORY_LIVE_GOVERNANCE_TESTS must be set to run live certification");
  }
  if (!process.env.OPNORY_OKTA_LIVE_TEST_CONFIRMED) {
    throw new Error("OPNORY_OKTA_LIVE_TEST_CONFIRMED must be set to confirm Okta live test");
  }

  requireEnvVars([
    "OPNORY_OKTA_ORG_URL",
    "OPNORY_OKTA_CLIENT_ID",
    "OPNORY_OKTA_PRIVATE_KEY_PATH",
    "OPNORY_OKTA_TEST_USER_EMAIL",
    "OPNORY_OKTA_TEST_SUBJECT_ID",
    "OPNORY_OKTA_FINANCE_GROUP_ID",
    "OPNORY_OKTA_DATA_ANALYST_GROUP_ID",
    "OPNORY_OKTA_AUDITOR_GROUP_ID",
    "OPNORY_OKTA_FINANCE_APP_ID",
    "OPNORY_OKTA_DATA_ANALYST_APP_ID",
    "OPNORY_OKTA_AUDITOR_APP_ID",
  ]);

  // Config
  const config: OktaAdapterConfig = {
    orgUrl: getEnv("OPNORY_OKTA_ORG_URL"),
    clientId: getEnv("OPNORY_OKTA_CLIENT_ID"),
    privateKeyPath: getEnv("OPNORY_OKTA_PRIVATE_KEY_PATH"),
    privateKeyPassphrase: getEnvOptional("OPNORY_OKTA_PRIVATE_KEY_PASSPHRASE"),
  };

  // Subject
  const subjectRef: SubjectRef = {
    type: "user",
    identifier: getEnv("OPNORY_OKTA_TEST_USER_EMAIL"),
  };

  // Permissions (Opnory permissions, not Okta operations)
  const financeAnalystPermission: Permission = {
    id: "finance.analyst",
    name: "Finance Analyst",
    mappings: [
      { provider: "okta", type: "group", value: getEnv("OPNORY_OKTA_FINANCE_GROUP_ID") },
      { provider: "okta", type: "application", value: getEnv("OPNORY_OKTA_FINANCE_APP_ID") },
    ],
  };

  const dataAnalystPermission: Permission = {
    id: "data.analyst",
    name: "Data Analyst",
    mappings: [
      { provider: "okta", type: "group", value: getEnv("OPNORY_OKTA_DATA_ANALYST_GROUP_ID") },
      { provider: "okta", type: "application", value: getEnv("OPNORY_OKTA_DATA_ANALYST_APP_ID") },
    ],
  };

  const auditorPermission: Permission = {
    id: "auditor",
    name: "Auditor",
    mappings: [
      { provider: "okta", type: "group", value: getEnv("OPNORY_OKTA_AUDITOR_GROUP_ID") },
      { provider: "okta", type: "application", value: getEnv("OPNORY_OKTA_AUDITOR_APP_ID") },
    ],
  };

  const scope: ResourceScope = {
    type: "tenant",
    identifier: config.orgUrl,
  };

  // Create adapter
  const adapter = new OktaAdapter(config);

  // Resolve subject
  console.log("▶ Resolving test subject...\n");
  const resolvedSubject = await adapter.resolveSubject(subjectRef);
  console.log(`✅ Resolved: ${resolvedSubject.providerSubjectId} (${resolvedSubject.provider})\n`);

  // Verify subject matches expected
  if (resolvedSubject.providerSubjectId !== getEnv("OPNORY_OKTA_TEST_SUBJECT_ID")) {
    throw new Error(
      `Subject ID mismatch: expected ${getEnv("OPNORY_OKTA_TEST_SUBJECT_ID")}, got ${resolvedSubject.providerSubjectId}`,
    );
  }

  // Fixtures - one per permission (each tests group + app assignment)
  const fixtures: ConformanceFixture[] = [
    {
      name: "okta-finance-analyst",
      permission: financeAnalystPermission,
      description: "Finance Analyst via Okta group + app assignment",
    },
    {
      name: "okta-data-analyst",
      permission: dataAnalystPermission,
      description: "Data Analyst via Okta group + app assignment",
    },
    {
      name: "okta-auditor",
      permission: auditorPermission,
      description: "Auditor via Okta group + app assignment",
    },
  ];

  // Evidence probe (optional - for Okta System Log)
  const evidenceProbe: CertificationEvidenceProbe = async (fixtureName, step, assignment, permission, scope, resolvedSubject) => {
    // Could query Okta System Log here for independent verification
    // For now, return undefined (evidence kept outside adapter per ADR 0003)
    return undefined;
  };

  // Provider-specific timing (Okta Model B)
  const oktaTiming: ConformanceTiming = {
    verifyAttempts: 10,
    verifyIntervalMs: 2000,
    interFixtureDelayMs: 10000,
    postVerifyDelayMs: 3000,
    preIdempotentVerify: true,
  };

  // Run conformance harness
  console.log("▶ Running conformance suite...\n");
  const result = await runFulfillmentAdapterCertification({
    provider: "okta",
    adapter,
    subject: subjectRef,
    fixtures,
    scope,
    evidenceProbe,
    timing: oktaTiming,
  });

  // Generate evidence
  const evidence = new EvidenceRecorder("okta-model-b-certification");
  
  evidence.recordStep("identity-resolution", "PASS", {
    provider: "okta",
    subjectId: resolvedSubject.providerSubjectId,
    subjectType: resolvedSubject.providerSubjectType,
  });

  for (const fixtureResult of result.fixtures) {
    const prefix = fixtureResult.fixture.name;
    evidence.recordStep(`${prefix}.grant`, fixtureResult.grant.passed ? "PASS" : "FAIL", {
      permission: fixtureResult.fixture.permission.id,
      mappings: fixtureResult.fixture.permission.mappings.map(m => `${m.type}:${m.value}`),
      mutated: fixtureResult.grant.mutated,
    });
    evidence.recordStep(`${prefix}.verify`, fixtureResult.verify.passed ? "PASS" : "FAIL", {
      status: fixtureResult.verify.status,
    });
    evidence.recordStep(`${prefix}.grant-idempotent`, fixtureResult.grantIdempotent.passed ? "PASS" : "FAIL", {
      mutated: fixtureResult.grantIdempotent.mutated,
      expectedMutated: false,
    });
    evidence.recordStep(`${prefix}.revoke`, fixtureResult.revoke.passed ? "PASS" : "FAIL", {
      mutated: fixtureResult.revoke.mutated,
    });
    evidence.recordStep(`${prefix}.verify-removal`, fixtureResult.verifyRemoval.passed ? "PASS" : "FAIL", {
      status: fixtureResult.verifyRemoval.status,
    });
    evidence.recordStep(`${prefix}.revoke-idempotent`, fixtureResult.revokeIdempotent.passed ? "PASS" : "FAIL", {
      mutated: fixtureResult.revokeIdempotent.mutated,
      expectedMutated: false,
    });
    evidence.recordStep(`${prefix}.final-clean`, fixtureResult.finalClean.passed ? "PASS" : "FAIL", {
      status: fixtureResult.finalClean.status,
    });
  }

  evidence.recordStep("conformance-overall", result.passed ? "PASS" : "FAIL", {
    passedFixtures: result.fixtures.filter(f => f.passed).length,
    totalFixtures: result.fixtures.length,
  });

  // Write evidence artifacts
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const resultsDir = join(process.cwd(), ".live-results");
  mkdirSync(resultsDir, { recursive: true });

  const rawEvidencePath = join(resultsDir, `okta-certification-${timestamp}.json`);
  const publicEvidencePath = join(resultsDir, `okta-certification-${timestamp}-public.json`);

  writeFileSync(rawEvidencePath, JSON.stringify(evidence.getEvidence(), null, 2));
  writeFileSync(publicEvidencePath, JSON.stringify(evidence.getPublicEvidence(), null, 2));

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log(`   Certification: ${result.passed ? "PASSED ✅" : "FAILED ❌"}`);
  console.log(`   Fixtures: ${result.fixtures.filter(f => f.passed).length}/${result.fixtures.length} passed`);
  console.log(`   Raw evidence: ${rawEvidencePath}`);
  console.log(`   Public evidence: ${publicEvidencePath}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  if (!result.passed) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ Certification failed:", error.message);
  process.exit(1);
});