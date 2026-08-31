// packages/observability-bench/src/provider.ts
// Provider adapter interface — the single seam every candidate observability
// backend plugs into. The benchmark is credential-agnostic: adapters are
// constructed from a typed config and read API keys come from env vars at
// run time, never embedded in the benchmark.

import type { OpnorySpan, TraceCorpus } from "./trace-model.js";

// ============================================================================
// Write path (instrumentation side)
// ============================================================================

/**
 * Push the corpus to a backend. Implementations replay the SAME serialized
 * OTLP bytes (or an equivalent lossless form) so write differences are not
 * conflated with query differences. Returns a handle the parity gate uses
 * to confirm the backend actually received ~the whole corpus.
 */
export interface TraceWriter {
  readonly providerName: string;
  /** Instrumentation/endpoint identity — for the "benchmark the API you use" lesson */
  readonly endpointDescription: string;
  writeCorpus(corpus: TraceCorpus): Promise<void>;
}

// ============================================================================
// Read path (query side)
// ============================================================================

/** A single retrieved span, as the backend returned it (post-normalization). */
export interface RetrievedSpan {
  spanId: string;
  traceId: string;
  parentSpanId: string | null;
  name: string;
  startEpochNanos: bigint;
  durationEpochNanos: bigint;
  attributes: Record<string, string>;
}

/** Result of a query probe: the rows fetched plus how (and how fast) they came. */
export interface QueryResult {
  providerName: string;
  /** What the query was (human + machine-readable, for the report) */
  query: {
    kind: "filtered_scan" | "aggregation" | "governance_lookup" | "agent_lookup" | "reconciliation" | "full_export";
    description: string;
  };
  /** Rows retrieved (spans, or aggregated rows). */
  rows: RetrievedSpan[] | Record<string, unknown>[];
  /** Query execution time (ms) — excludes rate-limit pacing. */
  queryTimeMs: number;
  /** Total wall time (ms) — includes any required rate-limit pacing. */
  wallTimeMs: number;
  /** Was a 429 / rate-limit response observed? */
  rateLimited: boolean;
  /** Byte size of the response body. */
  responseBytes: number;
  /** Did pagination occur? (some backends silently truncate) */
  paginated: boolean;
  /** Number of pages fetched (for full_export) */
  pageCount: number;
}

/**
 * The read API adapter. Every candidate backend implements this; the
 * benchmark calls ONLY this interface, so "does vendor X support traces"
 * is never the question — the question is always Opnory's exact query.
 */
export interface TraceReader {
  readonly providerName: string;
  /** The exact endpoint/method/auth the adapter calls (provenance for evidence-only scoring). */
  readonly readSurface: string;

  /** Server-side filter: "failed Okta fulfillment ops for tenant X in the last hour". */
  filteredScan(params: {
    tenantId: string;
    provider: string;
    outcome: "failed" | "succeeded";
    windowStartEpochMs: number;
    windowEndEpochMs: number;
  }): Promise<QueryResult>;

  /** Server-side aggregation: failures/retries/p95 grouped by provider/plugin. */
  aggregation(params: { tenantId: string; groupBy: "provider" | "plugin" }): Promise<QueryResult>;

  /** Reconstruct the complete trace for one access request. */
  governanceLookup(params: { correlationId: string }): Promise<QueryResult>;

  /**
   * Fetch one trace by trace ID — the universal native read primitive for
   * trace-centric backends. Used for corpus parity when the backend exposes no
   * governed full-export (e.g. Jaeger): enumerate known manifest trace IDs and
   * reconstruct the corpus. This is NOT a scored query capability; it is the
   * parity mechanism.
   */
  findTrace(traceId: string): Promise<RetrievedSpan[]>;

  /** Find requests where the model invoked entitlement tools. */
  agentLookup(params: { tenantId: string; toolName: string }): Promise<QueryResult>;

  /** Find assignments where verification required >1 attempt. */
  reconciliationLookup(params: { tenantId: string; minRetryCount: number }): Promise<QueryResult>;

  /** Export the entire tenant/time-window corpus. */
  fullExport(params: { tenantId: string; windowStartEpochMs: number; windowEndEpochMs: number }): Promise<QueryResult>;
}

/**
 * A CandidateProvider couples a writer + reader (some platforms separate
 * ingest from read API creds) and declares the auth type it expects.
 */
export interface CandidateProvider {
  readonly providerName: string;
  readonly writer: TraceWriter;
  readonly reader: TraceReader;
  /**
   * What the read API can actually do. Different backends expose different
   * query primitives — that is useful data, not a reason to fake parity.
   * A benchmark must report `unsupported` for a capability the backend lacks,
   * never emulate it client-side and call it server-side performance.
   */
  readonly capabilities: ProviderCapabilities;
  /** Auth friction note (e.g. "read-scoped API key required", "OAuth client-credentials"). */
  readonly authDescription: string;
}

/**
 * Declared read-API capabilities. Each flag governs whether the corresponding
 * probe is run at all (false → reported `unsupported`, not a zero score).
 */
export interface ProviderCapabilities {
  traceLookup: boolean;
  attributeFiltering: boolean;
  aggregation: boolean;
  fullExport: boolean;
  pagination: boolean;
  correlationLookup: boolean;
}

export const NO_CAPABILITIES: ProviderCapabilities = {
  traceLookup: false,
  attributeFiltering: false,
  aggregation: false,
  fullExport: false,
  pagination: false,
  correlationLookup: false,
};

// ============================================================================
// Provider registry
// ============================================================================

const registry = new Map<string, CandidateProvider>();

export function registerProvider(provider: CandidateProvider): void {
  registry.set(provider.providerName, provider);
}

export function listProviders(): string[] {
  return Array.from(registry.keys());
}

export function getProvider(name: string): CandidateProvider | undefined {
  return registry.get(name);
}