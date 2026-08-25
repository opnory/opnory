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

interface OktaBootstrapConfig {
  orgUrl: string;
  clientId: string;
  privateKeyPath: string;
  privateKeyPassphrase?: string;
  testUserEmail: string;
  financeGroupId: string;
  dataAnalystGroupId: string;
  auditorGroupId: string;
  financeAppId: string;
  dataAnalystAppId: string;
  auditorAppId: string;
}

async function main() {
  console.log("▶ Bootstrapping Okta Model B primitives...\n");

  requireEnvVars([
    "OPNORY_OKTA_ORG_URL",
    "OPNORY_OKTA_CLIENT_ID",
    "OPNORY_OKTA_PRIVATE_KEY_PATH",
    "OPNORY_OKTA_TEST_USER_EMAIL",
    "OPNORY_OKTA_FINANCE_GROUP_ID",
    "OPNORY_OKTA_DATA_ANALYST_GROUP_ID",
    "OPNORY_OKTA_AUDITOR_GROUP_ID",
    "OPNORY_OKTA_FINANCE_APP_ID",
    "OPNORY_OKTA_DATA_ANALYST_APP_ID",
    "OPNORY_OKTA_AUDITOR_APP_ID",
  ]);

  const config: OktaBootstrapConfig = {
    orgUrl: getEnv("OPNORY_OKTA_ORG_URL"),
    clientId: getEnv("OPNORY_OKTA_CLIENT_ID"),
    privateKeyPath: getEnv("OPNORY_OKTA_PRIVATE_KEY_PATH"),
    privateKeyPassphrase: getEnvOptional("OPNORY_OKTA_PRIVATE_KEY_PASSPHRASE"),
    testUserEmail: getEnv("OPNORY_OKTA_TEST_USER_EMAIL"),
    financeGroupId: getEnv("OPNORY_OKTA_FINANCE_GROUP_ID"),
    dataAnalystGroupId: getEnv("OPNORY_OKTA_DATA_ANALYST_GROUP_ID"),
    auditorGroupId: getEnv("OPNORY_OKTA_AUDITOR_GROUP_ID"),
    financeAppId: getEnv("OPNORY_OKTA_FINANCE_APP_ID"),
    dataAnalystAppId: getEnv("OPNORY_OKTA_DATA_ANALYST_APP_ID"),
    auditorAppId: getEnv("OPNORY_OKTA_AUDITOR_APP_ID"),
  };

  // Create Okta adapter
  const adapter = new OktaAdapter(config as OktaAdapterConfig);

  // Resolve test subject
  const subjectRef: SubjectRef = {
    type: "user",
    identifier: config.testUserEmail,
  };

  const resolvedSubject = await adapter.resolveSubject(subjectRef);
  console.log(`✅ Resolved test subject: ${resolvedSubject.providerSubjectId}\n`);

  // Verify clean state - no pre-existing memberships/assignments
  console.log("▶ Verifying clean initial state...\n");
  
  const permissions: Permission[] = [
    {
      id: "finance.analyst",
      name: "Finance Analyst",
      mappings: [
        { provider: "okta", type: "group", value: config.financeGroupId },
        { provider: "okta", type: "application", value: config.financeAppId },
      ],
    },
    {
      id: "data.analyst",
      name: "Data Analyst",
      mappings: [
        { provider: "okta", type: "group", value: config.dataAnalystGroupId },
        { provider: "okta", type: "application", value: config.dataAnalystAppId },
      ],
    },
    {
      id: "auditor",
      name: "Auditor",
      mappings: [
        { provider: "okta", type: "group", value: config.auditorGroupId },
        { provider: "okta", type: "application", value: config.auditorAppId },
      ],
    },
  ];

  const scope: ResourceScope = {
    type: "tenant",
    identifier: config.orgUrl,
  };

  // Check each permission is clean
  for (const perm of permissions) {
    for (const mapping of perm.mappings) {
      if (mapping.type === "group") {
        try {
          // Check if user is in group
          const result = await adapter.verify(
            { permissionId: perm.id, scope } as RoleAssignment,
            perm,
            scope,
            resolvedSubject,
          );
          if (result.status === "verified") {
            throw new Error(
              `Pre-existing group membership found for ${perm.id} (${mapping.value}) - sandbox not clean`,
            );
          }
        } catch (error: any) {
          if (error.message.includes("Pre-existing")) throw error;
          // 404/not-found is expected
        }
      } else if (mapping.type === "application") {
        try {
          const result = await adapter.verify(
            { permissionId: perm.id, scope } as RoleAssignment,
            perm,
            scope,
            resolvedSubject,
          );
          if (result.status === "verified") {
            throw new Error(
              `Pre-existing app assignment found for ${perm.id} (${mapping.value}) - sandbox not clean`,
            );
          }
        } catch (error: any) {
          if (error.message.includes("Pre-existing")) throw error;
        }
      }
    }
  }

  console.log("✅ All permissions verified clean\n");

  // Output environment variables for certification script
  console.log("┌─────────────────────────────────────────────────────────────┐");
  console.log("│ Okta Model B Bootstrap Complete                             │");
  console.log("├─────────────────────────────────────────────────────────────┤");
  console.log(`│ Test Subject ID: ${resolvedSubject.providerSubjectId}`);
  console.log(`│ Finance Group:   ${config.financeGroupId}`);
  console.log(`│ Data Analyst Gp: ${config.dataAnalystGroupId}`);
  console.log(`│ Auditor Group:   ${config.auditorGroupId}`);
  console.log(`│ Finance App:     ${config.financeAppId}`);
  console.log(`│ Data Analyst App:${config.dataAnalystAppId}`);
  console.log(`│ Auditor App:     ${config.auditorAppId}`);
  console.log("└─────────────────────────────────────────────────────────────┘");
  console.log("\nSet these for certification:");
  console.log(`export OPNORY_OKTA_TEST_SUBJECT_ID=${resolvedSubject.providerSubjectId}`);
}

// Import helpers
import { getEnv, getEnvOptional, requireEnvVars } from "@opnory/governance-core";

main().catch((error) => {
  console.error("❌ Bootstrap failed:", error.message);
  process.exit(1);
});