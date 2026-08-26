import { OktaAdapter, OktaAdapterConfig } from "@opnory/governance-core";
import { SubjectRef, Permission, ResourceScope, RoleAssignment } from "@opnory/governance-core";
import { getEnv, getEnvOptional, requireEnvVars } from "@opnory/governance-core";
import { readFileSync } from "fs";
import { join } from "path";

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
  console.log("▶ Destroying Okta Model B sandbox primitives...\n");

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

  const config: OktaAdapterConfig = {
    orgUrl: getEnv("OPNORY_OKTA_ORG_URL"),
    clientId: getEnv("OPNORY_OKTA_CLIENT_ID"),
    privateKeyPath: getEnv("OPNORY_OKTA_PRIVATE_KEY_PATH"),
    privateKeyPassphrase: getEnvOptional("OPNORY_OKTA_PRIVATE_KEY_PASSPHRASE"),
  };

  const subjectRef: SubjectRef = {
    type: "user",
    identifier: getEnv("OPNORY_OKTA_TEST_USER_EMAIL"),
  };

  const permissions: Permission[] = [
    {
      id: "finance.analyst",
      name: "Finance Analyst",
      mappings: [
        { provider: "okta", type: "group", value: certEnv.OPNORY_OKTA_FINANCE_GROUP_ID },
        { provider: "okta", type: "application", value: certEnv.OPNORY_OKTA_FINANCE_APP_ID },
      ],
    },
    {
      id: "data.analyst",
      name: "Data Analyst",
      mappings: [
        { provider: "okta", type: "group", value: certEnv.OPNORY_OKTA_DATA_ANALYST_GROUP_ID },
        { provider: "okta", type: "application", value: certEnv.OPNORY_OKTA_DATA_ANALYST_APP_ID },
      ],
    },
    {
      id: "auditor",
      name: "Auditor",
      mappings: [
        { provider: "okta", type: "group", value: certEnv.OPNORY_OKTA_AUDITOR_GROUP_ID },
        { provider: "okta", type: "application", value: certEnv.OPNORY_OKTA_AUDITOR_APP_ID },
      ],
    },
  ];

  const scope: ResourceScope = {
    type: "tenant",
    identifier: config.orgUrl,
  };

  const adapter = new OktaAdapter(config);
  const resolvedSubject = await adapter.resolveSubject(subjectRef);

  console.log(`▶ Cleaning up assignments for subject: ${resolvedSubject.providerSubjectId}\n`);

  // Revoke all permissions
  for (const perm of permissions) {
    for (const mapping of perm.mappings) {
      const assignment: RoleAssignment = {
        permissionId: perm.id,
        scope,
        subject: subjectRef,
      };

      console.log(`  Revoking ${perm.id} (${mapping.type}: ${mapping.value})...`);
      
      const result = await adapter.revoke(assignment, perm, scope, resolvedSubject);
      
      if (result.status === "succeeded") {
        console.log(`    ✅ ${result.mutated ? "Mutated" : "Idempotent (already absent)"}`);
      } else {
        console.log(`    ❌ Failed: ${result.error}`);
      }
    }
  }

  // Final verification
  console.log("\n▶ Final verification...\n");
  let allClean = true;
  for (const perm of permissions) {
    for (const mapping of perm.mappings) {
      const assignment: RoleAssignment = {
        permissionId: perm.id,
        scope,
        subject: subjectRef,
      };

      const result = await adapter.verify(assignment, perm, scope, resolvedSubject);
      
      if (result.status === "not-found") {
        console.log(`  ✅ ${perm.id} (${mapping.type}: ${mapping.value}) - clean`);
      } else {
        console.log(`  ❌ ${perm.id} (${mapping.type}: ${mapping.value}) - STILL ASSIGNED (${result.status})`);
        allClean = false;
      }
    }
  }

  if (allClean) {
    console.log("\n✅ Okta sandbox fully cleaned\n");
  } else {
    console.log("\n❌ Some assignments remain\n");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ Destroy failed:", error.message);
  process.exit(1);
});