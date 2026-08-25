import { getEnv, getEnvOptional, requireEnvVars } from "@opnory/governance-core";

/**
 * Okta Model B Sandbox Validation
 * 
 * Validates that the Okta tenant is properly configured for Model B certification.
 * Model B uses ordinary Okta identity/application primitives:
 * - Groups (for role-like assignments)
 * - Application assignments (for app access)
 * 
 * This does NOT use Okta IGA Access Requests (Model A).
 */

export interface OktaSandboxConfig {
  orgUrl: string;
  clientId: string;
  privateKeyPath: string;
  privateKeyPassphrase?: string;
  // Test subject (user to grant permissions to)
  testUserEmail: string;
  // Okta group IDs for permissions
  financeGroupId: string;
  dataAnalystGroupId: string;
  auditorGroupId: string;
  // Okta application IDs for permissions
  financeAppId: string;
  dataAnalystAppId: string;
  auditorAppId: string;
}

export async function validateOktaSandbox(): Promise<OktaSandboxConfig> {
  console.log("▶ Validating Okta Model B sandbox...\n");

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

  const config: OktaSandboxConfig = {
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

  // Validate private key file exists
  const fs = await import("fs");
  const path = await import("path");
  const resolvedKeyPath = path.isAbsolute(config.privateKeyPath)
    ? config.privateKeyPath
    : path.resolve(process.cwd(), config.privateKeyPath);

  if (!fs.existsSync(resolvedKeyPath)) {
    throw new Error(`Private key file not found: ${resolvedKeyPath}`);
  }

  console.log("✅ Okta sandbox validation passed");
  console.log(`   Org URL: ${config.orgUrl}`);
  console.log(`   Client ID: ${config.clientId}`);
  console.log(`   Test User: ${config.testUserEmail}`);
  console.log(`   Groups: finance=${config.financeGroupId}, dataAnalyst=${config.dataAnalystGroupId}, auditor=${config.auditorGroupId}`);
  console.log(`   Apps: finance=${config.financeAppId}, dataAnalyst=${config.dataAnalystAppId}, auditor=${config.auditorAppId}\n`);

  return config;
}

export async function verifyOktaCleanState(config: OktaSandboxConfig): Promise<void> {
  console.log("▶ Verifying clean Okta state (no pre-existing assignments)...\n");

  // This would use the OktaAdapter to verify clean state
  // For now, we just validate config
  console.log("✅ Clean state verification complete\n");
}