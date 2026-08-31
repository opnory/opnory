// packages/observability-bench/src/dataset/verify-parity.ts
// The parity gate: refuse to compare query performance until every backend
// actually holds ~equivalent data.
//
// Parity is capability-aware and uses the methodology distinction:
//
//   Corpus parity     = can the backend prove the known corpus is retrievable
//                       through ANY declared native read primitive?
//   Capability bench  = can the backend perform THIS operation natively?
//
// A trace-centric backend (Jaeger) proves parity by reconstructing the corpus
// from known manifest trace IDs via findTrace — NOT by a scored fullExport it
// does not have. That is not emulation; it is using the native read primitive
// to establish that the corpus arrived.

import type { CandidateProvider } from "../provider.js";
import type { CorpusManifest } from "../trace-model.js";

export interface ParityVerdict {
  providerName: string;
  /** does the backend hold the corpus? */
  passed: boolean;
  /** span count observed vs expected */
  observedSpanCount: number;
  expectedSpanCount: number;
  /** trace count observed vs expected */
  observedTraceCount: number;
  expectedTraceCount: number;
  /** fraction of expected spans retrieved */
  coverage: number; // 0..1
  /** which primitive proved parity */
  mechanism: "full_export" | "find_trace" | "none";
  detail: string;
}

/**
 * Verify parity, choosing the mechanism from the provider's declared
 * capabilities. A provider whose observed span count is materially below the
 * manifest count (>1% shortfall) fails the gate.
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
  let mechanism: ParityVerdict["mechanism"] = "none";

  // Corpus parity is ALWAYS established via findTrace enumeration over the
  // known manifest trace IDs — the universal full-trace primitive every
  // trace-centric backend exposes. This keeps parity unambiguous and immune to
  // export-vs-search semantic mismatches (Tempo's TraceQL search returns only
  // MATCHED spans; Phoenix's span list is not tenant-scoped; a full-export
  // count would under/over-count). fullExport remains a separate, scored
  // capability benchmark — never the parity mechanism.
  mechanism = "find_trace";
  try {
    for (const traceId of manifest.traceIds) {
      const spans = await provider.reader.findTrace(traceId);
      for (const span of spans) {
        observedSpanCount++;
        observedTraceIds.add(span.traceId);
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
    mechanism,
    detail: exportError
      ? `parity read failed (${mechanism}): ${exportError}`
      : passed
        ? `parity OK via ${mechanism}: ${observedSpanCount}/${manifest.spanCount} spans (${(coverage * 100).toFixed(1)}%)`
        : `parity FAIL via ${mechanism}: ${observedSpanCount}/${manifest.spanCount} spans (shortfall ${shortfall})`,
  };
}