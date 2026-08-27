import {
  OktaAdapter,
  OktaAdapterConfig,
} from "@opnory/governance-core";
import { SubjectRef, Permission, ResourceScope } from "@opnory/governance-core";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { getEnv, getEnvOptional, requireEnvVars } from "../common";

interface OktaBootstrapConfig {
  orgUrl: string;
  clientId: string;
  privateKeyPath: string;
  privateKeyPassphrase?: string;
  testUserEmail: string;
}

const DETERMINISTIC_NAMES = {
  financeGroup: "Opnory-Finance-Analyst",
  dataAnalystGroup: "Opnory-Data-Analyst",
  auditorGroup: "Opnory-Auditor",
  financeApp: "Opnory-Finance-App",
  dataAnalystApp: "Opnory-Data-Analyst-App",
  auditorApp: "Opnory-Auditor-App",
} as const;

async function findOrCreateGroup(adapter: OktaAdapter, name: string): Promise<string> {
  // Try to find existing group by name
  try {
    const response = await adapter.rawRequest<any>(`/groups?q=${encodeURIComponent(name)}&limit=1`);
    if (response && response.length > 0) {
      return response[0].id;
    }
  } catch {
    // Ignore - we'll create
  }
  
  // Create new group
  const response = await adapter.rawRequest<any>("/groups", {
    method: "POST",
    body: JSON.stringify({ profile: { name, description: `Opnory certification: ${name}` } }),
  });
  return response.id;
}

async function findOrCreateApplication(adapter: OktaAdapter, name: string): Promise<string> {
  // Try to find existing app by label
  try {
    const response = await adapter.rawRequest<any>(`/apps?q=${encodeURIComponent(name)}&limit=1`);
    if (response && response.length > 0) {
      return response[0].id;
    }
  } catch {
    // Ignore - we'll create
  }
  
  // Create new app (OIDC Web App)
  const response = await adapter.rawRequest<any>("/apps", {
    method: "POST",
    body: JSON.stringify({
      name: "oidc_client",
      label: name,
      signOnMode: "OPENID_CONNECT",
      credentials: {
        oauthClient: {
          token_endpoint_auth_method: "client_secret_basic",
        },
      },
      settings: {
        oauthClient: {
          redirect_uris: ["https://opnory.com/callback"],
          response_types: ["code"],
          grant_types: ["authorization_code", "refresh_token"],
          application_type: "web",
        },
      },
    }),
  });
  return response.id;
}

async function main() {
  console.log("▶ Bootstrapping Okta Model B primitives...\n");

  requireEnvVars([
    "OPNORY_OKTA_ORG_URL",
    "OPNORY_OKTA_CLIENT_ID",
    "OPNORY_OKTA_KEY_ID",
    "OPNORY_OKTA_PRIVATE_KEY_PATH",
    "OPNORY_OKTA_TEST_USER_EMAIL",
  ]);

  const config: OktaBootstrapConfig = {
    orgUrl: getEnv("OPNORY_OKTA_ORG_URL"),
    clientId: getEnv("OPNORY_OKTA_CLIENT_ID"),
    privateKeyPath: getEnv("OPNORY_OKTA_PRIVATE_KEY_PATH"),
    privateKeyPassphrase: getEnvOptional("OPNORY_OKTA_PRIVATE_KEY_PASSPHRASE"),
    testUserEmail: getEnv("OPNORY_OKTA_TEST_USER_EMAIL"),
  };

  const adapter = new OktaAdapter({
    ...config,
    keyId: getEnv("OPNORY_OKTA_KEY_ID"),
  } as OktaAdapterConfig);

  // Resolve test subject
  const subjectRef: SubjectRef = {
    type: "user",
    identifier: config.testUserEmail,
  };

  const resolvedSubject = await adapter.resolveSubject(subjectRef);
  console.log(`✅ Resolved test subject: ${resolvedSubject.providerSubjectId}\n`);

  // Create/find groups
  console.log("▶ Creating/finding groups...");
  const financeGroupId = await findOrCreateGroup(adapter, DETERMINISTIC_NAMES.financeGroup);
  console.log(`  ✅ Finance group: ${financeGroupId}`);
  
  const dataAnalystGroupId = await findOrCreateGroup(adapter, DETERMINISTIC_NAMES.dataAnalystGroup);
  console.log(`  ✅ Data Analyst group: ${dataAnalystGroupId}`);
  
  const auditorGroupId = await findOrCreateGroup(adapter, DETERMINISTIC_NAMES.auditorGroup);
  console.log(`  ✅ Auditor group: ${auditorGroupId}`);

  // Create/find applications
  console.log("\n▶ Creating/finding applications...");
  const financeAppId = await findOrCreateApplication(adapter, DETERMINISTIC_NAMES.financeApp);
  console.log(`  ✅ Finance app: ${financeAppId}`);
  
  const dataAnalystAppId = await findOrCreateApplication(adapter, DETERMINISTIC_NAMES.dataAnalystApp);
  console.log(`  ✅ Data Analyst app: ${dataAnalystAppId}`);
  
  const auditorAppId = await findOrCreateApplication(adapter, DETERMINISTIC_NAMES.auditorApp);
  console.log(`  ✅ Auditor app: ${auditorAppId}`);

  // Verify clean state - no pre-existing memberships/assignments
  console.log("\n▶ Verifying clean initial state...");

  const permissions: Permission[] = [
    {
      id: "finance.analyst",
      name: "Finance Analyst",
      mappings: [
        { provider: "okta", type: "group", value: financeGroupId },
        { provider: "okta", type: "application", value: financeAppId },
      ],
    },
    {
      id: "data.analyst",
      name: "Data Analyst",
      mappings: [
        { provider: "okta", type: "group", value: dataAnalystGroupId },
        { provider: "okta", type: "application", value: dataAnalystAppId },
      ],
    },
    {
      id: "auditor",
      name: "Auditor",
      mappings: [
        { provider: "okta", type: "group", value: auditorGroupId },
        { provider: "okta", type: "application", value: auditorAppId },
      ],
    },
  ];

  const scope: ResourceScope = {
    type: "tenant",
    identifier: config.orgUrl,
  };

  for (const perm of permissions) {
    for (const mapping of perm.mappings) {
      if (mapping.type === "group") {
        try {
          const result = await adapter.verify(
            { permissionId: perm.id, scope } as any,
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
        }
      } else if (mapping.type === "application") {
        try {
          const result = await adapter.verify(
            { permissionId: perm.id, scope } as any,
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

  // Write .env.okta-certification file
  const envContent = `# .env.okta-certification
# Generated by bootstrap-okta-primitives.ts
# Source this file before running validate/certify/destroy

OPNORY_OKTA_TEST_SUBJECT_ID="${resolvedSubject.providerSubjectId}"

OPNORY_OKTA_FINANCE_GROUP_ID="${financeGroupId}"
OPNORY_OKTA_DATA_ANALYST_GROUP_ID="${dataAnalystGroupId}"
OPNORY_OKTA_AUDITOR_GROUP_ID="${auditorGroupId}"

OPNORY_OKTA_FINANCE_APP_ID="${financeAppId}"
OPNORY_OKTA_DATA_ANALYST_APP_ID="${dataAnalystAppId}"
OPNORY_OKTA_AUDITOR_APP_ID="${auditorAppId}"
`;

  const envPath = join(process.cwd(), ".env.okta-certification");
  writeFileSync(envPath, envContent);
  console.log(`✅ Written .env.okta-certification to ${envPath}\n`);

  // Output summary
  console.log("┌─────────────────────────────────────────────────────────────┐");
  console.log("│ Okta Model B Bootstrap Complete                             │");
  console.log("├─────────────────────────────────────────────────────────────┤");
  console.log(`│ Test Subject ID: ${resolvedSubject.providerSubjectId}`);
  console.log(`│ Finance Group:   ${financeGroupId}`);
  console.log(`│ Data Analyst Gp: ${dataAnalystGroupId}`);
  console.log(`│ Auditor Group:   ${auditorGroupId}`);
  console.log(`│ Finance App:     ${financeAppId}`);
  console.log(`│ Data Analyst App:${dataAnalystAppId}`);
  console.log(`│ Auditor App:     ${auditorAppId}`);
  console.log("└─────────────────────────────────────────────────────────────┘");
  console.log("\nNext steps:");
  console.log(`  source .env.okta-certification`);
  console.log(`  bun run okta:validate`);
  console.log(`  bun run okta:certify:model-b`);
  console.log(`  bun run okta:destroy:model-b`);
}

main().catch((error) => {
  console.error("❌ Bootstrap failed:", error.message);
  process.exit(1);
});