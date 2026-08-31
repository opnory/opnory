// packages/observability-bench/src/report.ts
// Report runner: execute the full benchmark against a list of providers and
// emit evidence-backed results (JSON is the source of truth; Markdown is
// derived from it).
//
// Gating order (strict):
//   parity FAIL  → no latency, no weighted score (disqualified)
//   isolation FAIL → disqualify
//   redaction FAIL → disqualify
//
// Capability-awareness: a probe runs only if the provider declares the
// corresponding capability; otherwise it is reported `unsupported`, never
// given a zero score, never emulated client-side.

import type { CandidateProvider, RetrievedSpan } from "./provider.js";
import { generateCorpusWithManifest } from "./dataset/generate.js";
import { sendToAll, sendCorpus } from "./dataset/send.js";
import { verifyParity } from "./dataset/verify-parity.js";
import { checkTenantIsolation, buildIsolationGate } from "./bench/isolation.js";
import { probeCompleteness } from "./bench/completeness.js";
import { probeFreshness } from "./bench/freshness.js";
import { probeLatency, probeExport } from "./bench/query.js";
import { probeFidelity, probeEvidenceCorrelation } from "./bench/fidelity.js";
import { checkRedaction } from "./rubric.js";
import type {
  CompletenessResult,
  FreshnessResult,
  LatencyResult,
  ExportResult,
  FidelityResult,
  EvidenceCorrelationResult,
} from "./rubric.js";

export type ProbeStatus = "measured" | "unsupported" | "skipped";

export interface BenchmarkResult {
  providerName: string;
  capabilities: Record<string, boolean>;
  parity: { passed: boolean; detail: string; mechanism: string };
  isolation: { passed: boolean; detail: string; mechanism: string };
  redaction: { passed: boolean; detail: string };
  completeness: { status: ProbeStatus; result: CompletenessResult | null };
  filteredQuery: { status: ProbeStatus; result: LatencyResult | null };
  freshness: { status: ProbeStatus; result: FreshnessResult | null };
  export: { status: ProbeStatus; result: ExportResult | null };
  fidelity: { status: ProbeStatus; result: FidelityResult | null };
  evidence: { status: ProbeStatus; result: EvidenceCorrelationResult | null };
  disqualified: boolean;
  notes: string[];
}

export interface BenchmarkOptions {
  seed: number;
  anchorEpochMs: number;
  traceCount: number;
  tenantIds: string[];
  warmup?: number;
  measured?: number;
  /** corpus SHA-256 (recorded from the deterministic fixture for provenance) */
  corpusSha256?: string;
}

export async function runBenchmark(
  providers: CandidateProvider[],
  opts: BenchmarkOptions,
): Promise<BenchmarkResult[]> {
  const { corpus, manifest } = generateCorpusWithManifest({
    seed: opts.seed,
    anchorEpochMs: opts.anchorEpochMs,
    traceCount: opts.traceCount,
    tenantIds: opts.tenantIds,
  });

  const sendResults = await sendToAll(providers, corpus);
  const results: BenchmarkResult[] = [];

  for (const provider of providers) {
    const notes: string[] = [];
    const send = sendResults.get(provider.providerName);
    if (send) {
      notes.push(`write: ${send.writeTimeMs.toFixed(1)}ms, ${send.serializedBytes}B, sha256=${opts.corpusSha256 ?? send.sha256.slice(0, 12)}`);
    }

    // Hard gate 1: parity (capability-aware).
    const parity = await verifyParity(provider, manifest);
    if (!parity.passed) {
      results.push({
        providerName: provider.providerName,
        capabilities: provider.capabilities as unknown as Record<string, boolean>,
        parity: { passed: false, detail: parity.detail, mechanism: parity.mechanism },
        isolation: { passed: false, detail: "skipped (parity failed)", mechanism: "none" },
        redaction: { passed: false, detail: "skipped (parity failed)" },
        completeness: { status: "skipped", result: null },
        filteredQuery: { status: "skipped", result: null },
        freshness: { status: "skipped", result: null },
        export: { status: "skipped", result: null },
        fidelity: { status: "skipped", result: null },
        evidence: { status: "skipped", result: null },
        disqualified: true,
        notes: [...notes, `parity failed: ${parity.detail}`],
      });
      continue;
    }

    // Hard gate 2: tenant isolation.
    const isolationRaw = await checkTenantIsolation(provider, manifest);
    const isolation = buildIsolationGate(isolationRaw);

    // Hard gate 3: redaction — inspect every span we can retrieve.
    const allSpans = await collectAllSpans(provider, manifest);
    const redaction = checkRedaction(allSpans);

    const hardGateFailNotes: string[] = [];
    if (!isolation.passed) hardGateFailNotes.push(`isolation ${isolation.detail}`);
    if (!redaction.passed) hardGateFailNotes.push(`redaction: ${redaction.violations.join("; ")}`);

    if (hardGateFailNotes.length > 0) {
      results.push({
        providerName: provider.providerName,
        capabilities: provider.capabilities as unknown as Record<string, boolean>,
        parity: { passed: true, detail: parity.detail, mechanism: parity.mechanism },
        isolation: { passed: isolation.passed, detail: isolation.detail, mechanism: isolationRaw.mechanism },
        redaction: { passed: redaction.passed, detail: redaction.violations.join("; ") },
        completeness: { status: "skipped", result: null },
        filteredQuery: { status: "skipped", result: null },
        freshness: { status: "skipped", result: null },
        export: { status: "skipped", result: null },
        fidelity: { status: "skipped", result: null },
        evidence: { status: "skipped", result: null },
        disqualified: true,
        notes: [...notes, ...hardGateFailNotes],
      });
      continue;
    }

    // Weighted probes, each gated on declared capability.
    const correlationId = corpus.traces[0].correlationId;
    const probeOpts = {
      tenantId: opts.tenantIds[0],
      windowStartEpochMs: opts.anchorEpochMs - 60_000,
      windowEndEpochMs: opts.anchorEpochMs + 3_600_000,
      warmup: opts.warmup,
      measured: opts.measured,
    };

    const completInput = {
      correlationId,
      expectedSpans: ["opnory.request", "identity.resolve", "policy.evaluate", "fulfillment", "provider.grant", "provider.verify", "evidence.record"],
    };

    const completeness = provider.capabilities.correlationLookup
      ? { status: "measured" as ProbeStatus, result: await probeCompleteness(provider, completInput) }
      : { status: "unsupported" as ProbeStatus, result: null };

    const filteredQuery = provider.capabilities.attributeFiltering
      ? { status: "measured" as ProbeStatus, result: await probeLatency(provider, probeOpts) }
      : { status: "unsupported" as ProbeStatus, result: null };

    const freshness = { status: "measured" as ProbeStatus, result: await probeFreshness(provider, {
      emitFreshTrace: async () => {
        const c = generateCorpusWithManifest({
          seed: opts.seed + 1,
          anchorEpochMs: Date.now(),
          traceCount: 1,
          tenantIds: opts.tenantIds,
        });
        await sendCorpus(provider, c.corpus);
        return { correlationId: c.corpus.traces[0].correlationId, tenantId: c.corpus.traces[0].tenantId };
      },
      pollIntervalMs: 500,
      timeoutMs: 20_000,
      samples: 3,
    }) };

    const exp = provider.capabilities.fullExport
      ? { status: "measured" as ProbeStatus, result: await probeExport(provider, probeOpts, manifest.spanCount) }
      : { status: "unsupported" as ProbeStatus, result: null };

    const fidelity = provider.capabilities.traceLookup
      ? { status: "measured" as ProbeStatus, result: await probeFidelity(provider, { correlationId }) }
      : { status: "unsupported" as ProbeStatus, result: null };

    const evidence = provider.capabilities.correlationLookup
      ? { status: "measured" as ProbeStatus, result: await probeEvidenceCorrelation(provider, { correlationId }) }
      : { status: "unsupported" as ProbeStatus, result: null };

    results.push({
      providerName: provider.providerName,
      capabilities: provider.capabilities as unknown as Record<string, boolean>,
      parity: { passed: true, detail: parity.detail, mechanism: parity.mechanism },
      isolation: { passed: isolation.passed, detail: isolation.detail, mechanism: isolationRaw.mechanism },
      redaction: { passed: redaction.passed, detail: redaction.passed ? "no violations" : redaction.violations.join("; ") },
      completeness,
      filteredQuery,
      freshness,
      export: exp,
      fidelity,
      evidence,
      disqualified: false,
      notes,
    });
  }

  return results;
}

/** Retrieve every span the provider can yield, for the redaction gate. */
async function collectAllSpans(
  provider: CandidateProvider,
  manifest: { traceIds: string[]; tenantIds: string[]; anchorEpochMs: number },
): Promise<RetrievedSpan[]> {
  const spans: RetrievedSpan[] = [];
  if (provider.capabilities.fullExport) {
    for (const tenantId of manifest.tenantIds) {
      const r = await provider.reader.fullExport({
        tenantId,
        windowStartEpochMs: manifest.anchorEpochMs - 60_000,
        windowEndEpochMs: manifest.anchorEpochMs + 3_600_000,
      });
      for (const row of r.rows) {
        if (typeof (row as RetrievedSpan).spanId === "string") spans.push(row as RetrievedSpan);
      }
    }
  } else {
    for (const traceId of manifest.traceIds) {
      spans.push(...(await provider.reader.findTrace(traceId)));
    }
  }
  return spans;
}

export function renderMarkdown(results: BenchmarkResult[]): string {
  const lines: string[] = ["# Observability Benchmark Report", ""];
  for (const r of results) {
    lines.push(`## ${r.providerName}`);
    lines.push(`- Disqualified: ${r.disqualified}`);
    lines.push(`- Parity: ${r.parity.passed ? "PASS" : "FAIL"} (${r.parity.mechanism}) — ${r.parity.detail}`);
    lines.push(`- Isolation: ${r.isolation.passed ? "PASS" : "FAIL"} (${r.isolation.mechanism}) — ${r.isolation.detail}`);
    lines.push(`- Redaction: ${r.redaction.passed ? "PASS" : "FAIL"} — ${r.redaction.detail}`);
    lines.push(`- Capabilities: ${Object.entries(r.capabilities).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    if (r.completeness.status === "measured" && r.completeness.result) {
      lines.push(`- Completeness attribute coverage: ${r.completeness.result.attributeCoverage.toFixed(2)}`);
    } else {
      lines.push(`- Completeness: ${r.completeness.status}`);
    }
    if (r.filteredQuery.status === "measured" && r.filteredQuery.result) {
      const l = r.filteredQuery.result;
      lines.push(`- Filtered-query latency p50: ${l.p50Ms.toFixed(1)}ms, p95: ${l.p95Ms.toFixed(1)}ms, p99: ${l.p99Ms.toFixed(1)}ms, errors: ${(l.errorRate * 100).toFixed(1)}%`);
    } else {
      lines.push(`- Filtered-query: ${r.filteredQuery.status}`);
    }
    if (r.freshness.result) {
      const f = r.freshness.result;
      lines.push(`- Freshness p50: ${f.p50Ms.toFixed(1)}ms, p95: ${f.p95Ms.toFixed(1)}ms, timeouts: ${(f.timeoutFraction * 100).toFixed(1)}%`);
    }
    if (r.export.status === "measured" && r.export.result) {
      lines.push(`- Export: ${r.export.result.rowsRetrieved} rows, ${r.export.result.rowsPerSecond.toFixed(1)} rows/s, complete: ${r.export.result.complete}`);
    } else {
      lines.push(`- Export: ${r.export.status}`);
    }
    if (r.fidelity.result) {
      const fid = r.fidelity.result;
      lines.push(`- Fidelity: traceId=${fid.traceIdIntact}, spanId=${fid.spanIdIntact}, parentage=${fid.parentageIntact}, attrs=${fid.attributeNamesIntact}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}