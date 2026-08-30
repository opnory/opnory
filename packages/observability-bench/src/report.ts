// packages/observability-bench/src/report.ts
// Report runner: execute the full benchmark against registered providers
// and emit evidence-backed results.

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
import type { CompletenessResult, FreshnessResult, LatencyResult, ExportResult, FidelityResult, EvidenceCorrelationResult } from "./rubric.js";

export interface BenchmarkResult {
  providerName: string;
  parity: { passed: boolean; detail: string };
  isolation: { passed: boolean; detail: string };
  redaction: { passed: boolean; detail: string };
  completeness: CompletenessResult | null;
  freshness: FreshnessResult | null;
  latency: LatencyResult | null;
  export: ExportResult | null;
  fidelity: FidelityResult | null;
  evidence: EvidenceCorrelationResult | null;
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
      notes.push(`write: ${send.writeTimeMs.toFixed(1)}ms, ${send.serializedBytes}B`);
    }

    // Hard gate 1: parity
    const parity = await verifyParity(provider, manifest);
    if (!parity.passed) {
      results.push({
        providerName: provider.providerName,
        parity: { passed: parity.passed, detail: parity.detail },
        isolation: { passed: false, detail: "skipped (parity failed)" },
        redaction: { passed: false, detail: "skipped (parity failed)" },
        completeness: null, freshness: null, latency: null,
        export: null, fidelity: null, evidence: null,
        disqualified: true,
        notes: [...notes, `parity failed: ${parity.detail}`],
      });
      continue;
    }

    // Hard gate 2: tenant isolation
    const isolation = await checkTenantIsolation(provider, opts.tenantIds, {
      windowStartEpochMs: opts.anchorEpochMs - 60_000,
      windowEndEpochMs: opts.anchorEpochMs + 3_600_000,
    });
    const isolationGate = buildIsolationGate(isolation);

    // Hard gate 3: redaction
    const exportResult = await provider.reader.fullExport({
      tenantId: opts.tenantIds[0],
      windowStartEpochMs: opts.anchorEpochMs - 60_000,
      windowEndEpochMs: opts.anchorEpochMs + 3_600_000,
    });
    const spans = exportResult.rows.filter((r): r is RetrievedSpan =>
      typeof (r as RetrievedSpan).spanId === "string",
    );
    const redaction = checkRedaction(spans);

    if (!isolationGate.passed || !redaction.passed) {
      results.push({
        providerName: provider.providerName,
        parity: { passed: parity.passed, detail: parity.detail },
        isolation: { passed: isolationGate.passed, detail: isolationGate.detail },
        redaction: { passed: redaction.passed, detail: redaction.violations.join("; ") },
        completeness: null, freshness: null, latency: null,
        export: null, fidelity: null, evidence: null,
        disqualified: true,
        notes: [...notes, `hard gate failed: isolation=${isolationGate.passed}, redaction=${redaction.passed}`],
      });
      continue;
    }

    // Weighted probes
    const correlationId = corpus.traces[0].correlationId;
    const probeOpts = {
      tenantId: opts.tenantIds[0],
      windowStartEpochMs: opts.anchorEpochMs - 60_000,
      windowEndEpochMs: opts.anchorEpochMs + 3_600_000,
      warmup: opts.warmup,
      measured: opts.measured,
    };

    const completeness = await probeCompleteness(provider, {
      correlationId,
      expectedSpans: ["opnory.request", "identity.resolve", "policy.evaluate", "fulfillment", "provider.grant", "provider.verify", "evidence.record"],
    });

    const freshness = await probeFreshness(provider, {
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
      timeoutMs: 30_000,
      samples: 3,
    });

    const latency = await probeLatency(provider, probeOpts);
    const exp = await probeExport(provider, probeOpts, manifest.spanCount);
    const fidelity = await probeFidelity(provider, { correlationId });
    const evidence = await probeEvidenceCorrelation(provider, { correlationId });

    results.push({
      providerName: provider.providerName,
      parity: { passed: parity.passed, detail: parity.detail },
      isolation: { passed: isolationGate.passed, detail: isolationGate.detail },
      redaction: { passed: redaction.passed, detail: "no violations" },
      completeness,
      freshness,
      latency,
      export: exp,
      fidelity,
      evidence,
      disqualified: false,
      notes,
    });
  }

  return results;
}

export function renderMarkdown(results: BenchmarkResult[]): string {
  const lines: string[] = ["# Observability Benchmark Report", ""];
  for (const r of results) {
    lines.push(`## ${r.providerName}`);
    lines.push(`- Disqualified: ${r.disqualified}`);
    lines.push(`- Parity: ${r.parity.passed ? "PASS" : "FAIL"} — ${r.parity.detail}`);
    lines.push(`- Isolation: ${r.isolation.passed ? "PASS" : "FAIL"} — ${r.isolation.detail}`);
    lines.push(`- Redaction: ${r.redaction.passed ? "PASS" : "FAIL"} — ${r.redaction.detail}`);
    if (r.completeness != null) {
      lines.push(`- Completeness attribute coverage: ${r.completeness.attributeCoverage.toFixed(2)}`);
    }
    if (r.freshness != null) {
      lines.push(`- Freshness p50: ${r.freshness.p50Ms.toFixed(1)}ms, p95: ${r.freshness.p95Ms.toFixed(1)}ms, timeouts: ${(r.freshness.timeoutFraction * 100).toFixed(1)}%`);
    }
    if (r.latency != null) {
      lines.push(`- Query latency p50: ${r.latency.p50Ms.toFixed(1)}ms, p95: ${r.latency.p95Ms.toFixed(1)}ms, p99: ${r.latency.p99Ms.toFixed(1)}ms, errors: ${(r.latency.errorRate * 100).toFixed(1)}%`);
    }
    if (r.export != null) {
      lines.push(`- Export: ${r.export.rowsRetrieved} rows, ${r.export.rowsPerSecond.toFixed(1)} rows/s, complete: ${r.export.complete}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
