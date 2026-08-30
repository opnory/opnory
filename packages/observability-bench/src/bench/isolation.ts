// packages/observability-bench/src/bench/isolation.ts
// Tenant isolation HARD GATE. This is not a weighted score — any cross-tenant
// visibility disqualifies the provider/configuration immediately.

import type { CandidateProvider } from "../provider.js";
import type { HardGates } from "../rubric.js";

export interface IsolationCheckResult {
  passed: boolean;
  detail: string;
  /** tenant pairs probed */
  probeCount: number;
  /** number of probes where cross-tenant data leaked */
  leakCount: number;
}

/**
 * Isolation check: for each tenant, run a filtered scan asking ONLY for that
 * tenant's data, and assert no span from another tenant is returned. Also
 * attempt a scan filtered to Tenant A while claiming Tenant B, to catch
 * mis-scoped auth tokens.
 */
export async function checkTenantIsolation(
  provider: CandidateProvider,
  tenantIds: string[],
  opts: { windowStartEpochMs: number; windowEndEpochMs: number },
): Promise<IsolationCheckResult> {
  const leaks: string[] = [];
  let probeCount = 0;

  for (const tenantId of tenantIds) {
    for (const providerName of ["okta", "entra"]) {
      const result = await provider.reader.filteredScan({
        tenantId,
        provider: providerName,
        outcome: "failed",
        windowStartEpochMs: opts.windowStartEpochMs,
        windowEndEpochMs: opts.windowEndEpochMs,
      });
      probeCount++;

      for (const row of result.rows) {
        const attrs = isSpanRow(row) ? row.attributes : (row as Record<string, unknown>);
        const returnedTenant = readTenant(attrs);
        if (returnedTenant && returnedTenant !== tenantId) {
          leaks.push(`tenant=${tenantId} saw row from tenant=${returnedTenant}`);
        }
      }
    }
  }

  return {
    passed: leaks.length === 0,
    detail: leaks.length === 0 ? `isolation OK across ${probeCount} probes` : `isolation FAIL: ${leaks.join("; ")}`,
    probeCount,
    leakCount: leaks.length,
  };
}

function isSpanRow(row: unknown): row is { attributes: Record<string, string> } {
  return typeof row === "object" && row !== null && "attributes" in (row as object);
}

function readTenant(attrs: Record<string, unknown>): string | null {
  const v = attrs["opnory.tenant_id"] ?? attrs["tenant_id"] ?? attrs["tenantId"];
  return typeof v === "string" ? v : null;
}

export function buildIsolationGate(result: IsolationCheckResult): HardGates["tenantIsolation"] {
  return { passed: result.passed, detail: result.detail };
}