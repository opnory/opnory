// packages/observability-bench/src/bench/freshness.ts
// Freshness probe: create fresh telemetry, poll the read API until it appears.
// Write-to-readable lag matters because an agent/reconciliation worker may
// immediately need telemetry from something it just executed.

import type { CandidateProvider, RetrievedSpan } from "../provider.js";
import type { FreshnessResult } from "../rubric.js";
import { percentile, median } from "./stats.js";

export interface FreshnessInput {
  /** a trace the harness emits fresh (writer, not reader) */
  emitFreshTrace: () => Promise<{ correlationId: string; tenantId: string }>;
  /** poll interval ms */
  pollIntervalMs: number;
  /** per-sample timeout ms */
  timeoutMs: number;
  /** number of samples */
  samples: number;
}

export async function probeFreshness(
  provider: CandidateProvider,
  input: FreshnessInput,
): Promise<FreshnessResult> {
  const lags: number[] = [];
  let timeouts = 0;

  for (let i = 0; i < input.samples; i++) {
    const fresh = await input.emitFreshTrace();

    const start = performance.now();
    let found = false;
    let firstAppearanceMs = -1;

    while (performance.now() - start < input.timeoutMs) {
      const result = await provider.reader.governanceLookup({ correlationId: fresh.correlationId });
      if (result.rows.some((r) => "spanId" in (r as RetrievedSpan))) {
        firstAppearanceMs = performance.now() - start;
        found = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, input.pollIntervalMs));
    }

    if (found) {
      lags.push(firstAppearanceMs);
    } else {
      timeouts++;
    }
  }

  const sorted = [...lags].sort((a, b) => a - b);
  return {
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    timeoutFraction: input.samples === 0 ? 0 : timeouts / input.samples,
    samples: input.samples,
  };
}