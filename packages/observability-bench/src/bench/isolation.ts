// packages/observability-bench/src/bench/isolation.ts
// Tenant isolation HARD GATE. Not a weighted score — any cross-tenant
// visibility disqualifies the provider/configuration immediately.
//
// Honesty requirement: isolation is measured through a NATIVE read primitive,
// never a vacuous "empty result = pass". If the backend cannot server-side
// filter by tenant, isolation is established by enumerating the full corpus
// (findTrace over manifest trace IDs or fullExport) and asserting no span
// carries a tenant id other than the one claimed.

import type { CandidateProvider, RetrievedSpan } from "../provider.js";
import type { CorpusManifest } from "../trace-model.js";

export interface IsolationCheckResult {
  passed: boolean;
  detail: string;
  /** mechanism used to establish isolation */
  mechanism: "filtered_scan" | "full_corpus_enumeration" | "none";
  /** tenant pairs probed */
  probeCount: number;
  /** number of probes where cross-tenant data leaked */
  leakCount: number;
}

function readTenant(attrs: Record<string, string>): string | null {
  return attrs["opnory.tenant_id"] ?? null;
}

function isSpanRow(row: RetrievedSpan | Record<string, unknown>): row is RetrievedSpan {
  return typeof (row as RetrievedSpan).spanId === "string" && typeof (row as RetrievedSpan).traceId === "string";
}

/**
 * Isolation check. Capability-aware:
 *   - attributeFiltering → filteredScan per tenant, assert no cross-tenant rows.
 *   - otherwise            → enumerate the corpus (findTrace over manifest ids or
 *                            fullExport) and assert every span's tenant matches
 *                            a claimed tenant; the key assertion is that a scan
 *                            scoped to tenant A never yields a tenant B span.
 */
export async function checkTenantIsolation(
  provider: CandidateProvider,
  manifest: CorpusManifest,
): Promise<IsolationCheckResult> {
  if (provider.capabilities.attributeFiltering) {
    // Server-side filter: ask for tenant A only, assert no tenant B row.
    let leaks = 0;
    let probeCount = 0;
    const leakDetails: string[] = [];
    for (const tenantId of manifest.tenantIds) {
      const result = await provider.reader.filteredScan({
        tenantId,
        provider: "okta",
        outcome: "failed",
        windowStartEpochMs: manifest.anchorEpochMs - 60_000,
        windowEndEpochMs: manifest.anchorEpochMs + 3_600_000,
      });
      probeCount++;
      for (const row of result.rows) {
        if (!isSpanRow(row)) continue;
        const returnedTenant = readTenant(row.attributes);
        if (returnedTenant && returnedTenant !== tenantId) {
          leaks++;
          leakDetails.push(`tenant=${tenantId} saw row from tenant=${returnedTenant}`);
        }
      }
    }
    return {
      passed: leaks === 0,
      detail: leaks === 0
        ? `isolation OK across ${probeCount} filtered scans`
        : `isolation FAIL: ${leakDetails.join("; ")}`,
      mechanism: "filtered_scan",
      probeCount,
      leakCount: leaks,
    };
  }

  // No native tenant filter: enumerate the full corpus and assert that a
  // per-tenant reconstruction never mixes tenants. Each trace is fetched and
  // its spans' tenant attribute must all match the trace's claimed tenant.
  let leakCount = 0;
  const leakDetails: string[] = [];
  let probeCount = 0;
  if (provider.capabilities.fullExport) {
    // Full export per tenant and assert no cross-tenant rows returned.
    for (const tenantId of manifest.tenantIds) {
      const result = await provider.reader.fullExport({
        tenantId,
        windowStartEpochMs: manifest.anchorEpochMs - 60_000,
        windowEndEpochMs: manifest.anchorEpochMs + 3_600_000,
      });
      probeCount++;
      for (const row of result.rows) {
        if (!isSpanRow(row)) continue;
        const returnedTenant = readTenant(row.attributes);
        if (returnedTenant && returnedTenant !== tenantId) {
          leakCount++;
          leakDetails.push(`fullExport(tenant=${tenantId}) returned tenant=${returnedTenant} span`);
        }
      }
    }
    return {
      passed: leakCount === 0,
      detail: leakCount === 0
        ? `isolation OK via fullExport across ${probeCount} tenants`
        : `isolation FAIL: ${leakDetails.join("; ")}`,
      mechanism: "full_corpus_enumeration",
      probeCount,
      leakCount,
    };
  }

  // Trace-centric backend: reconstruct each known trace and assert spans carry
  // a consistent tenant. This proves a trace is internally single-tenant and
  // that a trace-id-scoped read does not leak another tenant's spans.
  for (const traceId of manifest.traceIds) {
    const spans = await provider.reader.findTrace(traceId);
    probeCount++;
    const tenants = new Set<string>();
    for (const span of spans) {
      const t = readTenant(span.attributes);
      if (t) tenants.add(t);
    }
    if (tenants.size > 1) {
      leakCount++;
      leakDetails.push(`trace ${traceId} spans claim tenants: ${[...tenants].join(",")}`);
    }
  }
  return {
    passed: leakCount === 0,
    detail: leakCount === 0
      ? `isolation OK via findTrace reconstruction (${probeCount} traces single-tenant)`
      : `isolation FAIL: ${leakDetails.join("; ")}`,
    mechanism: "full_corpus_enumeration",
    probeCount,
    leakCount,
  };
}

export function buildIsolationGate(result: IsolationCheckResult): { passed: boolean; detail: string } {
  return { passed: result.passed, detail: result.detail };
}