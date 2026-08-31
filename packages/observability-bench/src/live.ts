// packages/observability-bench/src/live.ts
// Local-baseline end-to-end run: replay the deterministic corpus ONCE through
// the shared OTLP collector (which fans out to Jaeger/Tempo/Phoenix), then run
// the benchmark probes against each backend's read API.
//
// This is separate from the generic runBenchmark because the local baseline
// uses ONE collector as the ingest point for all three backends. Sending the
// corpus once per provider (sendToAll) would triple-ingest through the shared
// collector and corrupt parity. In production, SaaS backends each have their
// own ingest and sendToAll is correct — but here the writer is shared.

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { generateCorpusWithManifest, serializeCorpus } from "./dataset/generate.js";
import { verifyParity } from "./dataset/verify-parity.js";
import { checkTenantIsolation, buildIsolationGate } from "./bench/isolation.js";
import { checkRedaction } from "./rubric.js";
import { probeCompleteness } from "./bench/completeness.js";
import { probeFreshness } from "./bench/freshness.js";
import { probeLatency, probeExport } from "./bench/query.js";
import { probeFidelity, probeEvidenceCorrelation } from "./bench/fidelity.js";
import { renderMarkdown } from "./report.js";
import type { BenchmarkResult } from "./report.js";
import { buildJaeger, buildTempo, buildPhoenix } from "./providers/index.js";
import type { CandidateProvider, RetrievedSpan } from "./provider.js";
import { createHash } from "node:crypto";

const COLLECTOR_OTLP = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318";
const SEED = Number(process.env.BENCH_SEED ?? 12345);
const ANCHOR_MS = Number(process.env.BENCH_ANCHOR_MS ?? 1725000000000);
const TRACE_COUNT = Number(process.env.BENCH_TRACES ?? 5);
const TENANT_IDS = (process.env.BENCH_TENANTS ?? "tenant-a,tenant-b").split(",").map((s) => s.trim());

async function sendOnce(corpus: ReturnType<typeof generateCorpusWithManifest>["corpus"]): Promise<void> {
  // Reuse the OtlpHttpWriter's payload shape via a single direct POST.
  const { buildOtlpPayload } = await import("./providers/otlp-http-writer.js");
  const payload = buildOtlpPayload(corpus);
  const res = await fetch(`${COLLECTOR_OTLP}/v1/traces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`collector write failed (${res.status}): ${body.slice(0, 256)}`);
  }
}

async function ingestDelay(): Promise<void> {
  // Allow backends to index (Jaeger/Tempo are near-immediate; Phoenix batches).
  const waitMs = Number(process.env.BENCH_INGEST_DELAY_MS ?? 5000);
  await new Promise((r) => setTimeout(r, waitMs));
}

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

export async function runLocalBenchmark(): Promise<void> {
  const { corpus, manifest } = generateCorpusWithManifest({
    seed: SEED,
    anchorEpochMs: ANCHOR_MS,
    traceCount: TRACE_COUNT,
    tenantIds: TENANT_IDS,
  });
  const sha256 = createHash("sha256").update(serializeCorpus(corpus), "utf8").digest("hex");

  console.log(`corpus: ${manifest.traceCount} traces / ${manifest.spanCount} spans, sha256=${sha256.slice(0, 12)}`);

  // Ingest once through the shared collector.
  await sendOnce(corpus);
  console.log(`→ ingest sent to collector (${COLLECTOR_OTLP})`);
  await ingestDelay();

  const providers = [buildJaeger(), buildTempo(), buildPhoenix()];
  const results: BenchmarkResult[] = [];

  for (const provider of providers) {
    console.log(`\n=== ${provider.providerName} ===`);
    const notes: string[] = [];

    const parity = await verifyParity(provider, manifest);
    console.log(`  parity: ${parity.passed ? "PASS" : "FAIL"} (${parity.mechanism}) ${parity.observedSpanCount}/${parity.expectedSpanCount} spans`);

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

    const isolationRaw = await checkTenantIsolation(provider, manifest);
    const isolation = buildIsolationGate(isolationRaw);
    console.log(`  isolation: ${isolation.passed ? "PASS" : "FAIL"} (${isolationRaw.mechanism})`);

    const allSpans = await collectAllSpans(provider, manifest);
    const redaction = checkRedaction(allSpans);
    console.log(`  redaction: ${redaction.passed ? "PASS" : "FAIL"} (${allSpans.length} spans inspected)`);

    if (!isolation.passed || !redaction.passed) {
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
        notes,
      });
      continue;
    }

    const correlationId = corpus.traces[0].correlationId;
    const probeOpts = {
      tenantId: TENANT_IDS[0],
      windowStartEpochMs: ANCHOR_MS - 60_000,
      windowEndEpochMs: ANCHOR_MS + 3_600_000,
      warmup: 5,
      measured: 30,
    };

    const completeness = provider.capabilities.correlationLookup
      ? { status: "measured" as const, result: await probeCompleteness(provider, { correlationId, expectedSpans: ["opnory.request", "identity.resolve", "policy.evaluate", "fulfillment", "provider.grant", "provider.verify", "evidence.record"] }) }
      : { status: "unsupported" as const, result: null };

    const filteredQuery = provider.capabilities.attributeFiltering
      ? { status: "measured" as const, result: await probeLatency(provider, probeOpts) }
      : { status: "unsupported" as const, result: null };

    const freshness = { status: "measured" as const, result: await probeFreshness(provider, {
      emitFreshTrace: async () => {
        const c = generateCorpusWithManifest({ seed: SEED + 1, anchorEpochMs: Date.now(), traceCount: 1, tenantIds: TENANT_IDS });
        await sendOnce(c.corpus);
        return { correlationId: c.corpus.traces[0].correlationId, tenantId: c.corpus.traces[0].tenantId };
      },
      pollIntervalMs: 500,
      timeoutMs: 15_000,
      samples: 3,
    }) };

    const exp = provider.capabilities.fullExport
      ? { status: "measured" as const, result: await probeExport(provider, probeOpts, manifest.spanCount) }
      : { status: "unsupported" as const, result: null };

    const fidelity = provider.capabilities.traceLookup
      ? { status: "measured" as const, result: await probeFidelity(provider, { correlationId }) }
      : { status: "unsupported" as const, result: null };

    const evidence = provider.capabilities.correlationLookup
      ? { status: "measured" as const, result: await probeEvidenceCorrelation(provider, { correlationId }) }
      : { status: "unsupported" as const, result: null };

    results.push({
      providerName: provider.providerName,
      capabilities: provider.capabilities as unknown as Record<string, boolean>,
      parity: { passed: true, detail: parity.detail, mechanism: parity.mechanism },
      isolation: { passed: isolation.passed, detail: isolation.detail, mechanism: isolationRaw.mechanism },
      redaction: { passed: redaction.passed, detail: "no violations" },
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

  const outDir = process.env.BENCH_OUT ?? "results";
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, "evidence.json");
  const mdPath = join(outDir, "report.md");
  writeFileSync(jsonPath, JSON.stringify({ corpusSha256: sha256, manifest, providers: results }, null, 2), "utf8");
  writeFileSync(mdPath, renderMarkdown(results), "utf8");
  console.log(`\nwrote ${jsonPath} and ${mdPath}`);
}

// Invoked only when run directly (bun run src/live.ts).
runLocalBenchmark().catch((err) => {
  console.error(err);
  process.exit(1);
});