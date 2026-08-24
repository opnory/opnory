#!/usr/bin/env bun

// Destroy Entra Governance Package (Model A)
// Cleans up Entra Access Package, Assignment Policy, and related resources
// Run with: OPNORY_ENTRA_TENANT_ID=... OPNORY_ENTRA_CLIENT_ID=... OPNORY_ENTRA_CLIENT_SECRET=... OPNORY_ENTRA_SANDBOX_CONFIRM=true bun run this-file.ts

import { getLogger } from "@opnory/observability";
import { getEnv, requireEnvVars, requireSandboxConfirmation } from "./common";

const log = getLogger("destroy-entra-governance");

async function main() {
  requireEnvVars([
    "OPNORY_ENTRA_TENANT_ID",
    "OPNORY_ENTRA_CLIENT_ID",
    "OPNORY_ENTRA_CLIENT_SECRET",
  ]);
  requireSandboxConfirmation("entra-governance");

  log.info("Destroying Entra Governance Package resources...");

  // Note: This is a placeholder for Model A destruction
  // Actual implementation will clean up:
  // - Access Package
  // - Assignment Policy
  // - Catalog
  // - Connected organizations (if created)

  log.warn(
    "Model A destroy not yet implemented - resources may remain in tenant",
  );
}

main().catch((err) => {
  log.error({ err }, "Destroy failed");
  process.exit(1);
});
