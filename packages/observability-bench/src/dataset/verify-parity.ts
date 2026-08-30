// packages/observability-bench/src/dataset/verify-parity.ts
// The parity gate: refuse to compare query performance until every backend
// actually holds ~equivalent data. This is the agents_otel_data "parity gate"
// — no timing score may be published for a provider whose corpus is incomplete.

import type { CandidateProvider, RetrievedSpan } from "../provider.js";
import type { CorpusManifest } from "../trace-model.js";

export interface ParityVerdict {
  providerName: string;
  /** does the backend hold the corpus after a full export? */
  passed: boolean;
  /** span count observed vs expected */
  observedSpanCount: number;
  expectedSpanCount: number;
  /** trace count observed vs expected */
  observedTraceCount: number;
  expectedTraceCount: number;
  /** fraction of expected spans retrieved in a full export */
  coverage: number; // 0..1
  detail: string;
}

/**
 * Verify parity by doing a full export of every tenant and re-counting spans.
 * A provider whose observed span count is materially below the manifest count
 * (>1% shortfall) fails the gate.
 */
export async function verifyParity(
  provider: CandidateProvider,
  manifest: CorpusManifest,
  opts: { toleranceFraction?: number } = {},
): Promise<ParityVerdict> {
  const tolerance = opts.toleranceFraction ?? 0.01;

  let observedSpanCount = 0;
  const observedTraceIds = new Set<string>();
  let exportError: string | null = null;

  try {
    for (const tenantId of manifest.tenantIds) {
      const result = await provider.reader.fullExport({
        tenantId,
        windowStartEpochMs: manifest.anchorEpochMs - 60_000,
        windowEndEpochMs: manifest.anchorEpochMs + 3_600_000,
      });

      for (const row of result.rows) {
        if (isSpanRow(row)) {
          observedSpanCount++;
          observedTraceIds.add(row.traceId);
        }
      }
    }
  } catch (error) {
    exportError = String(error);
  }

  const coverage = manifest.spanCount === 0 ? 0 : observedSpanCount / manifest.spanCount;
  const shortfall = manifest.spanCount - observedSpanCount;
  const passed = exportError === null && shortfall <= manifest.spanCount * tolerance;

  return {
    providerName: provider.providerName,
    passed,
    observedSpanCount,
    expectedSpanCount: manifest.spanCount,
    observedTraceCount: observedTraceIds.size,
    expectedTraceCount: manifest.traceCount,
    coverage,
    detail: exportError
      ? `full export failed: ${exportError}`
      : passed
        ? `parity OK: ${observedSpanCount}/${manifest.spanCount} spans (${(coverage * 100).toFixed(1)}%)`
        : `parity FAIL: ${observedSpanCount}/${manifest.spanCount} spans (shortfall ${shortfall})`,
  };
}

function isSpanRow(row: RetrievedSpan | Record<string, unknown>): row is RetrievedSpan {
  return typeof (row as RetrievedSpan).spanId === "string" && typeof (row as RetrievedSpan).traceId === "string";
}