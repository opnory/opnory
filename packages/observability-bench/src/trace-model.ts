// packages/observability-bench/src/trace-model.ts
// Governance-aware OTel trace model for the Opnory observability benchmark.
//
// The benchmark's source of truth is WHAT WE CAN RETRIEVE, not what we wrote.
// To score "retrieve" objectively we must first name, precisely, the span
// hierarchy and the attributes an observability backend must preserve across
// a write→read round-trip. This file is that contract.

// ============================================================================
// Span taxonomy
// ============================================================================

/**
 * Opnory span kinds. These are semantic stage markers, not OTel SpanKind.
 * They map 1:1 onto the governance-critical workflow described in ADR 0007:
 *
 *   opnory.request
 *     ├── identity.resolve
 *     ├── retrieval.search
 *     ├── gen_ai.inference
 *     ├── policy.evaluate
 *     └── fulfillment
 *           ├── subject.resolve
 *           ├── provider.grant
 *           ├── provider.verify
 *           ├── evidence.record
 *           └── reconciliation
 */
export type SpanName =
  | "opnory.request"
  | "identity.resolve"
  | "retrieval.search"
  | "gen_ai.inference"
  | "policy.evaluate"
  | "fulfillment"
  | "subject.resolve"
  | "provider.grant"
  | "provider.verify"
  | "evidence.record"
  | "reconciliation"
  // Phase 6 tenant-integration lifecycle spans (the first live scenario):
  | "integration.install"
  | "integration.validate"
  | "integration.activate"
  | "integration.health_check"
  | "integration.degrade"
  | "integration.recover"
  | "integration.suspend"
  | "integration.uninstall"
  | "credential.resolve"
  | "plugin.activate"
  | "plugin.dispose"
  | "capability.register"
  | "capability.unregister";

/**
 * The attributes that a successful read API must let an operator recover,
 * keyed by semantic name. These are the retrieval contract for the
 * `completeness` probe — a backend scores partial credit per attribute it
 * can surface intact.
 *
 * Every value here is deliberately REDACT-SAFE: no secrets, tokens, OAuth
 * assertions, DPoP proofs, or raw credential material. `gen_ai` prompt/response
 * content is represented by hash/summary only (see REDACTED_ATTRIBUTE set).
 */
export const OPONORY_ATTRIBUTE_NAMES = [
  // Identity / correlation (required for governance lookup)
  "opnory.tenant_id",
  "opnory.correlation_id",
  "opnory.request_id",
  "opnory.workflow_type",

  // Policy & approval
  "opnory.policy_result",
  "opnory.approval_ref",

  // Provider / plugin / capability
  "opnory.plugin_id",
  "opnory.provider",
  "opnory.capability",
  "opnory.operation",

  // Fulfillment semantics
  "opnory.grant_action", // "grant" | "verify" | "revoke"
  "opnory.mutated", // "true" | "false"
  "opnory.provider_response_category",

  // Resilience / reconciliation
  "opnory.retry_count",
  "opnory.reconciliation_outcome",

  // LLM attribution
  "opnory.llm_model",
  "opnory.llm_token_usage_input",
  "opnory.llm_token_usage_output",
  "opnory.tool_calls",

  // Outcome / error
  "opnory.error_type",
  "opnory.final_outcome",
] as const;

export type OpnoryAttributeName = (typeof OPONORY_ATTRIBUTE_NAMES)[number];

/**
 * Attributes that MUST NOT round-trip in plaintext. A provider that returns
 * any of these verbatim on read/export FAILS the redaction gate (hard gate).
 */
export const REDACTED_ATTRIBUTE_NAMES = [
  "opnory.secret",
  "opnory.access_token",
  "opnory.oauth_assertion",
  "opnory.dpop_proof",
  "opnory.credential_material",
  "opnory.prompt_raw",
  "opnory.response_raw",
] as const;

export type RedactedAttributeName = (typeof REDACTED_ATTRIBUTE_NAMES)[number];

// ============================================================================
// Span model (the corpus element)
// ============================================================================

export interface OpnorySpan {
  /** 32-hex-char trace id (OTel trace_id format, 16 bytes) */
  traceId: string;
  /** 16-hex-char span id (OTel span_id format, 8 bytes) */
  spanId: string;
  /** Parent span id, or null for the root span */
  parentSpanId: string | null;
  /** Semantic stage name (see SpanName) */
  name: SpanName;
  /** Start time as epoch nanoseconds (deterministic from the seed) */
  startEpochNanos: bigint;
  /** Duration in nanoseconds */
  durationEpochNanos: bigint;
  /** OTel SpanKind */
  kind: "INTERNAL" | "SERVER" | "CLIENT" | "PRODUCER" | "CONSUMER";
  /** Governance attributes (see OPONORY_ATTRIBUTE_NAMES) */
  attributes: Record<string, string>;
  /** Tenant this span belongs to (drives the isolation hard gate) */
  tenantId: string;
}

/**
 * A full Opnory workflow trace: a tree (well, a forest) of spans sharing
 * one traceId, rooted at an `opnory.request` span.
 */
export interface OpnoryTrace {
  traceId: string;
  tenantId: string;
  correlationId: string;
  requestId: string;
  workflowType: string;
  spans: OpnorySpan[];
}

// ============================================================================
// The corpus + manifest
// ============================================================================

/**
 * A deterministic trace corpus: the same seeded bytes replayed against every
 * candidate backend, so instrumentation differences cannot leak into the
 * comparison. Generated once, manifest records counts + bounds for the
 * parity gate.
 */
export interface TraceCorpus {
  seed: number;
  /** Fixed timestamp anchor (epoch millis) — all spans derive from this + seed */
  anchorEpochMs: number;
  traces: OpnoryTrace[];
}

/** Manifest: what the corpus claims to be, for the verify-parity gate. */
export interface CorpusManifest {
  seed: number;
  anchorEpochMs: number;
  /** Total span count */
  spanCount: number;
  /** Total trace count */
  traceCount: number;
  /** Distinct tenants (for isolation + parity checks) */
  tenantIds: string[];
  /** Span-name histogram: SpanName -> count */
  spanNameCounts: Record<string, number>;
  /** Sum of durations per span name (for aggregation parity) */
  spanNameDurationNanos: Record<string, string>;
  /** Byte length of the canonical serialized OTLP payload (for byte-identity) */
  serializedBytes: number;
  /** SHA-256 of the canonical serialized OTLP payload (for byte-identity) */
  sha256: string;
  /** Deterministic trace IDs (for findTrace-based parity on trace-centric backends) */
  traceIds: string[];
}