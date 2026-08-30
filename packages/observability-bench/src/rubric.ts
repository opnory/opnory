// packages/observability-bench/src/rubric.ts
// Scoring rubric. Two kinds of result:
//   - HARD GATES: binary pass/fail. A FAIL removes the provider from score
//     contention entirely (tenant isolation, redaction, parity).
//   - WEIGHTED SCORES: the evidence-only dimensions.
//
// Weighting preserves the agents_otel_data categories (25 completeness,
// 20 query flexibility, 10 DX/error quality, 8 auth, 8 latency, 8 pagination,
// 8 export, 8 freshness, 5 OTel fidelity) and adds three Opnory-specific
// concerns: tenant isolation (hard gate), redaction (hard gate), and
// evidence correlation (weighted, replaces part of "completeness").

import type { RetrievedSpan } from "./provider.js";
import {
  OPONORY_ATTRIBUTE_NAMES,
  REDACTED_ATTRIBUTE_NAMES,
} from "./trace-model.js";

// ============================================================================
// Hard gates — binary, evidence-backed, no partial credit
// ============================================================================

export interface HardGates {
  /** Corpus parity: provider received ~equivalent data before any timing. */
  parity: { passed: boolean; detail: string };
  /** Tenant isolation: Tenant A telemetry is NEVER retrievable by Tenant B. */
  tenantIsolation: { passed: boolean; detail: string };
  /** Redaction: no restricted attribute round-trips in plaintext. */
  redaction: { passed: boolean; detail: string };
}

export function hardGatesPassed(gates: HardGates): boolean {
  return gates.parity.passed && gates.tenantIsolation.passed && gates.redaction.passed;
}

// ============================================================================
// Weighted dimensions
// ============================================================================

export interface CompletenessResult {
  /** Fraction of REQUIRED attributes recoverable across the retrieved spans. */
  attributeCoverage: number; // 0..1
  /** Per-attribute pass/fail detail */
  attributeDetail: Record<string, boolean>;
  /** Span-tree fidelity: did parent/child structure survive? */
  spanTreeIntact: boolean;
  /** Missing spans (names expected but not returned) */
  missingSpans: string[];
}

export interface FreshnessResult {
  /** p50 write→readable lag (ms) */
  p50Ms: number;
  /** p95 write→readable lag (ms) */
  p95Ms: number;
  /** Fraction of freshness probes that timed out before appearing */
  timeoutFraction: number;
  /** Number of probes */
  samples: number;
}

export interface LatencyResult {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
  errorRate: number;
  rateLimit429Rate: number;
  /** median query execution time (excludes pacing) */
  queryTimeMs: number;
  /** median wall time (includes pacing) */
  wallTimeMs: number;
  responseBytes: number;
}

export interface ExportResult {
  /** rows retrieved in full_export */
  rowsRetrieved: number;
  /** rows/second */
  rowsPerSecond: number;
  /** did the export require pagination? */
  paginated: boolean;
  /** pages fetched */
  pageCount: number;
  /** is the export complete (row count matches corpus manifest)? */
  complete: boolean;
}

export interface FidelityResult {
  /** trace_id survived byte-identically */
  traceIdIntact: boolean;
  /** span_id survived byte-identically */
  spanIdIntact: boolean;
  /** parent relationships survived */
  parentageIntact: boolean;
  /** gen_ai.* / opnory.* attribute names preserved verbatim */
  attributeNamesIntact: boolean;
}

export interface EvidenceCorrelationResult {
  /** durable request id recoverable from a trace */
  requestIdLinked: boolean;
  /** assignment id recoverable */
  assignmentIdLinked: boolean;
  /** approval reference recoverable */
  approvalLinked: boolean;
  /** reconciliation id recoverable */
  reconciliationLinked: boolean;
  /** evidence id recoverable */
  evidenceLinked: boolean;
  /** fraction of the 5 durable IDs linked */
  coverage: number; // 0..1
}

// ============================================================================
// Weights
// ============================================================================

export interface RubricWeights {
  completeness: number;
  queryFlexibility: number;
  dxErrorQuality: number;
  authAccess: number;
  latency: number;
  pagination: number;
  export: number;
  freshness: number;
  otelFidelity: number;
  evidenceCorrelation: number;
}

/**
 * agents_otel_data weights plus evidence-correlation. We add evidence
 * correlation (governance-critical) by folding it in as its own dimension
 * rather than inflating completeness — the total sums to 100.
 */
export const DEFAULT_WEIGHTS: RubricWeights = {
  completeness: 20, // was 25; 5 points moved to evidenceCorrelation
  queryFlexibility: 20,
  dxErrorQuality: 10,
  authAccess: 8,
  latency: 8,
  pagination: 8,
  export: 8,
  freshness: 8,
  otelFidelity: 5,
  evidenceCorrelation: 5,
};

// ============================================================================
// The report
// ============================================================================

export interface ProviderScore {
  providerName: string;
  hardGates: HardGates;
  /** If hard gates failed, this provider is OUT of contention. */
  disqualified: boolean;
  completeness: CompletenessResult;
  freshness: FreshnessResult;
  latency: LatencyResult;
  export: ExportResult;
  fidelity: FidelityResult;
  evidence: EvidenceCorrelationResult;
  /** Weighted total (0..100), only meaningful when hardGatesPassed. */
  weightedTotal: number;
  /** Raw notes for the report (evidence-only, never vendor docs). */
  notes: string[];
}

/**
 * Normalize a retrieved span into a plain key/value form for attribute
 * coverage checks. Backends may namespace attributes differently, so the
 * adapter is responsible for normalizing to Opnory semantic names.
 */
export function extractAttributes(span: RetrievedSpan): Record<string, string> {
  return span.attributes;
}

/** Required attributes that MUST be recoverable for full completeness credit. */
export const REQUIRED_ATTRIBUTES = OPONORY_ATTRIBUTE_NAMES;

/** Attributes that must never appear in plaintext (redaction gate). */
export const FORBIDDEN_ATTRIBUTES = REDACTED_ATTRIBUTE_NAMES;

/**
 * Redaction gate check: any retrieved span or export row that exposes a
 * forbidden attribute in plaintext is a FAIL. Content-capture opt-in is the
 * only exception the benchmark does NOT auto-grant — it must be reported and
 * scored manually.
 */
export function checkRedaction(spans: RetrievedSpan[]): { passed: boolean; violations: string[] } {
  const violations: string[] = [];
  for (const span of spans) {
    for (const key of Object.keys(span.attributes)) {
      if ((FORBIDDEN_ATTRIBUTES as readonly string[]).includes(key)) {
        violations.push(`${span.traceId}/${span.name}:${key}`);
      }
    }
  }
  return { passed: violations.length === 0, violations };
}