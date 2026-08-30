// packages/observability-bench/src/bench/query.ts
// Query probes: filtered_scan, aggregation, full_export. Measures the median
// of N calls, separating query execution time from wall time (so rate-limit
// pacing is not confused with query-engine latency — the agents_otel_data
// lesson).

import type { CandidateProvider } from "../provider.js";
import type { LatencyResult, ExportResult } from "../rubric.js";
import { summarize, median } from "./stats.js";

export interface QueryProbeOptions {
  tenantId: string;
  windowStartEpochMs: number;
  windowEndEpochMs: number;
  warmup?: number;
  measured?: number;
}

interface ProbeSample {
  queryTimeMs: number;
  wallTimeMs: number;
  rateLimited: boolean;
  responseBytes: number;
}

async function probeFilteredScan(
  provider: CandidateProvider,
  opts: QueryProbeOptions,
): Promise<ProbeSample> {
  const t0 = performance.now();
  const result = await provider.reader.filteredScan({
    tenantId: opts.tenantId,
    provider: "okta",
    outcome: "failed",
    windowStartEpochMs: opts.windowStartEpochMs,
    windowEndEpochMs: opts.windowEndEpochMs,
  });
  const wallTimeMs = performance.now() - t0;
  return {
    queryTimeMs: result.queryTimeMs,
    wallTimeMs,
    rateLimited: result.rateLimited,
    responseBytes: result.responseBytes,
  };
}

export async function probeLatency(
  provider: CandidateProvider,
  opts: QueryProbeOptions,
): Promise<LatencyResult> {
  const queryTimes: number[] = [];
  const wallTimes: number[] = [];
  let errors = 0;
  let rateLimited = 0;
  let bytes = 0;

  const warmup = opts.warmup ?? 5;
  const measured = opts.measured ?? 30;

  for (let i = 0; i < warmup; i++) {
    await probeFilteredScan(provider, opts).catch(() => {});
  }

  for (let i = 0; i < measured; i++) {
    try {
      const sample = await probeFilteredScan(provider, opts);
      queryTimes.push(sample.queryTimeMs);
      wallTimes.push(sample.wallTimeMs);
      if (sample.rateLimited) rateLimited++;
      bytes += sample.responseBytes;
    } catch {
      errors++;
    }
  }

  const qStats = summarize(queryTimes);
  return {
    p50Ms: qStats.p50,
    p95Ms: qStats.p95,
    p99Ms: qStats.p99,
    minMs: qStats.min,
    maxMs: qStats.max,
    errorRate: measured === 0 ? 0 : errors / measured,
    rateLimit429Rate: measured === 0 ? 0 : rateLimited / measured,
    queryTimeMs: median(queryTimes),
    wallTimeMs: median(wallTimes),
    responseBytes: bytes,
  };
}

export async function probeExport(
  provider: CandidateProvider,
  opts: QueryProbeOptions,
  expectedSpanCount: number,
): Promise<ExportResult> {
  const t0 = performance.now();
  const result = await provider.reader.fullExport({
    tenantId: opts.tenantId,
    windowStartEpochMs: opts.windowStartEpochMs,
    windowEndEpochMs: opts.windowEndEpochMs,
  });
  const wallMs = performance.now() - t0;

  const rows = result.rows.length;
  const rowsPerSecond = wallMs <= 0 ? 0 : (rows / wallMs) * 1000;

  return {
    rowsRetrieved: rows,
    rowsPerSecond,
    paginated: result.paginated,
    pageCount: result.pageCount,
    complete: rows >= expectedSpanCount,
  };
}