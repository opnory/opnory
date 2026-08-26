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
import { writeFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { getEnv, getEnvOptional, requireEnvVars } from "@opnory/governance-core";
import { EvidenceRecorder, verifyCommitSha } from "../common";

function loadCertificationEnv() {
  const envPath = join(process.cwd(), ".env.okta-certification");
  try {
    const content = readFileSync(envPath, "utf-8");
    const config: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^([A-Z_]+)="(.*)"$/);
      if (match) {
        const [, key, value] = match;
        config[key] = value;
      }
    }
    return config;
  } catch {
    return {};
  }
}

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

  // Load generated cert env (contains IDs from bootstrap)
  const certEnv = loadCertificationEnv();
  if (!certEnv.OPNORY_OKTA_TEST_SUBJECT_ID) {
    throw new Error(".env.okta-certification not found or incomplete. Run bootstrap first.");
  }

  // Require auth env vars
  requireEnvVars([
    "OPNORY_OKTA_ORG_URL",
    "OPNORY_OKTA_CLIENT_ID",
    "OPNORY_OKTA_PRIVATE_KEY_PATH",
    "OPNORY_OKTA_TEST_USER_EMAIL",
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

  // Permissions (Opnory permissions, not Okta operations) - IDs from bootstrap
  const financeAnalystPermission: Permission = {
    id: "finance.analyst",
    name: "Finance Analyst",
    mappings: [
      { provider: "okta", type: "group", value: certEnv.OPNORY_OKTA_FINANCE_GROUP_ID },
      { provider: "okta", type: "application", value: certEnv.OPNORY_OKTA_FINANCE_APP_ID },
    ],
  };

  const dataAnalystPermission: Permission = {
    id: "data.analyst",
    name: "Data Analyst",
    mappings: [
      { provider: "okta", type: "group", value: certEnv.OPNORY_OKTA_DATA_ANALYST_GROUP_ID },
      { provider: "okta", type: "application", value: certEnv.OPNORY_OKTA_DATA_ANALYST_APP_ID },
    ],
  };

  const auditorPermission: Permission = {
    id: "auditor",
    name: "Auditor",
    mappings: [
      { provider: "okta", type: "group", value: certEnv.OPNORY_OKTA_AUDITOR_GROUP_ID },
      { provider: "okta", type: "application", value: certEnv.OPNORY_OKTA_AUDITOR_APP_ID },
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

  // Verify subject matches expected from bootstrap
  if (resolvedSubject.providerSubjectId !== certEnv.OPNORY_OKTA_TEST_SUBJECT_ID) {
    throw new Error(
      `Subject ID mismatch: expected ${certEnv.OPNORY_OKTA_TEST_SUBJECT_ID}, got ${resolvedSubject.providerSubjectId}`,
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

  // Verify commit SHA for evidence
  const commitSha = verifyCommitSha();

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
  const evidence = new EvidenceRecorder("okta", commitSha, config.orgUrl);
  
  evidence.record("identity-resolution", "Identity resolution", "PASS", {
    provider: "okta",
    subjectId: resolvedSubject.providerSubjectId,
    subjectType: resolvedSubject.providerSubjectType,
  });

  for (const fixtureResult of result.fixtures) {
    const prefix = fixtureResult.fixture.name;
    evidence.record(`${prefix}.grant`, "Grant permission", fixtureResult.grant.passed ? "PASS" : "FAIL", {
      permission: fixtureResult.fixture.permission.id,
      mappings: fixtureResult.fixture.permission.mappings.map(m => `${m.type}:${m.value}`),
      mutated: fixtureResult.grant.mutated,
    });
    evidence.record(`${prefix}.verify`, "Verify after grant", fixtureResult.verify.passed ? "PASS" : "FAIL", {
      status: fixtureResult.verify.status,
    });
    evidence.record(`${prefix}.grant-idempotent`, "Idempotent grant", fixtureResult.grantIdempotent.passed ? "PASS" : "FAIL", {
      mutated: fixtureResult.grantIdempotent.mutated,
      expectedMutated: false,
    });
    evidence.record(`${prefix}.revoke`, "Revoke permission", fixtureResult.revoke.passed ? "PASS" : "FAIL", {
      mutated: fixtureResult.revoke.mutated,
    });
    evidence.record(`${prefix}.verify-removal`, "Verify removal", fixtureResult.verifyRemoval.passed ? "PASS" : "FAIL", {
      status: fixtureResult.verifyRemoval.status,
    });
    evidence.record(`${prefix}.revoke-idempotent`, "Idempotent revoke", fixtureResult.revokeIdempotent.passed ? "PASS" : "FAIL", {
      mutated: fixtureResult.revokeIdempotent.mutated,
      expectedMutated: false,
    });
    evidence.record(`${prefix}.final-clean`, "Final clean state", fixtureResult.finalClean.passed ? "PASS" : "FAIL", {
      status: fixtureResult.finalClean.status,
    });
  }

  evidence.record("conformance-overall", "Overall conformance", result.passed ? "PASS" : "FAIL", {
    passedFixtures: result.fixtures.filter(f => f.passed).length,
    totalFixtures: result.fixtures.length,
  });

  // Write evidence artifacts
  evidence.writeArtifacts();

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log(`   Certification: ${result.passed ? "PASSED ✅" : "FAILED ❌"}`);
  console.log(`   Fixtures: ${result.fixtures.filter(f => f.passed).length}/${result.fixtures.length} passed`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  if (!result.passed) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ Certification failed:", error.message);
  process.exit(1);
});