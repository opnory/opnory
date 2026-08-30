// packages/observability-bench/src/bench/stats.ts
// Percentile + summary statistics for latency measurements.
// p50/p95/p99/min/max, computed exactly (no interpolation shortcuts).

export interface Stats {
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  count: number;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function summarize(samples: number[]): Stats {
  if (samples.length === 0) {
    return { p50: 0, p95: 0, p99: 0, min: 0, max: 0, count: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    count: samples.length,
  };
}

export function median(samples: number[]): number {
  if (samples.length === 0) return 0;
  const s = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/** Run a probe repeatedly, collecting the raw timing samples. */
export async function sampleProbe(
  fn: () => Promise<number>,
  opts: { warmup?: number; measured?: number } = {},
): Promise<{ samples: number[] }> {
  const warmup = opts.warmup ?? 5;
  const measured = opts.measured ?? 30;

  for (let i = 0; i < warmup; i++) {
    await fn();
  }

  const samples: number[] = [];
  for (let i = 0; i < measured; i++) {
    samples.push(await fn());
  }
  return { samples };
}