// packages/observability-bench/src/dataset/generate.ts
// Deterministic seeded OTLP corpus generator.
//
// The corpus is the benchmark's control variable: generate once from a fixed
// seed + timestamp anchor, record counts/bounds in a manifest, and replay the
// SAME bytes to every backend. This removes SDK/instrumentation differences
// from the query comparison (the agents_otel_data parity lesson).

import { createHash } from "node:crypto";
import type {
  OpnorySpan,
  OpnoryTrace,
  TraceCorpus,
  CorpusManifest,
  SpanName,
} from "../trace-model.js";

// ============================================================================
// Seeded PRNG — mulberry32, deterministic across runs/platforms
// ============================================================================

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================================
// Scenario templates — the governance-aware trace story
// ============================================================================

interface SpanTemplate {
  name: SpanName;
  kind: "INTERNAL" | "SERVER" | "CLIENT";
  /** whether this stage has a designated child set */
  children?: SpanName[];
}

const SUPPORT_REQUEST: SpanTemplate = {
  name: "opnory.request",
  kind: "SERVER",
  children: ["identity.resolve", "retrieval.search", "gen_ai.inference", "policy.evaluate"],
};

const FULFILLMENT_TREE: SpanTemplate = {
  name: "fulfillment",
  kind: "INTERNAL",
  children: ["subject.resolve", "provider.grant", "provider.verify", "evidence.record", "reconciliation"],
};

// The canonical hierarchy (matches ADR 0007 trace story)
const HIERARCHY: Record<string, SpanName[]> = {
  "opnory.request": ["identity.resolve", "retrieval.search", "gen_ai.inference", "policy.evaluate", "fulfillment"],
  fulfillment: ["subject.resolve", "provider.grant", "provider.verify", "evidence.record", "reconciliation"],
};

// Phase 6 lifecycle scenario trees
const INTEGRATION_LIFECYCLE: Record<string, SpanName[]> = {
  "integration.install": ["credential.resolve", "integration.validate", "integration.activate", "capability.register"],
  "integration.health_check": ["credential.resolve"],
  "integration.degrade": ["capability.unregister"],
  "integration.recover": ["integration.activate", "capability.register"],
  "integration.suspend": [],
  "integration.uninstall": ["plugin.dispose", "capability.unregister"],
};

const WORKFLOW_TYPES = ["support-request", "access-grant", "access-revoke", "provider-failure-reconcile", "plugin-recovery"] as const;

const PROVIDERS = ["okta", "entra"] as const;
const PLUGINS = ["okta-plugin", "entra-plugin"] as const;
const CAPABILITIES = ["identity.resolve@v1", "identity.fulfill@v1"] as const;

// ============================================================================
// Attribute generation (redact-safe)
// ============================================================================

function randomHex(rng: () => number, bytes: number): string {
  const out: string[] = [];
  for (let i = 0; i < bytes; i++) {
    out.push(Math.floor(rng() * 256).toString(16).padStart(2, "0"));
  }
  return out.join("");
}

function genAttributes(
  rng: () => number,
  tenantId: string,
  correlationId: string,
  requestId: string,
  workflowType: string,
  spanName: SpanName,
): Record<string, string> {
  const provider = PROVIDERS[Math.floor(rng() * PROVIDERS.length)];
  const plugin = PLUGINS[Math.floor(rng() * PLUGINS.length)];
  const capability = CAPABILITIES[Math.floor(rng() * CAPABILITIES.length)];

  const attrs: Record<string, string> = {
    "opnory.tenant_id": tenantId,
    "opnory.correlation_id": correlationId,
    "opnory.request_id": requestId,
    "opnory.workflow_type": workflowType,
    "opnory.provider": provider,
    "opnory.plugin_id": plugin,
    "opnory.capability": capability,
  };

  // Fulfillment-specific attributes
  if (spanName === "provider.grant" || spanName === "provider.verify") {
    attrs["opnory.grant_action"] = spanName === "provider.grant" ? "grant" : "verify";
    attrs["opnory.mutated"] = rng() < 0.5 ? "true" : "false";
    attrs["opnory.provider_response_category"] = rng() < 0.9 ? "success" : "transient-error";
  }

  if (spanName === "policy.evaluate") {
    attrs["opnory.policy_result"] = rng() < 0.85 ? "approved" : "denied";
    attrs["opnory.approval_ref"] = `apr-${randomHex(rng, 6)}`;
  }

  if (spanName === "gen_ai.inference") {
    attrs["opnory.llm_model"] = ["gpt-4o", "claude-sonnet-4", "nemotron-ultra"][Math.floor(rng() * 3)];
    attrs["opnory.llm_token_usage_input"] = String(Math.floor(rng() * 8000));
    attrs["opnory.llm_token_usage_output"] = String(Math.floor(rng() * 2000));
    attrs["opnory.tool_calls"] = String(Math.floor(rng() * 4));
  }

  if (spanName === "reconciliation") {
    attrs["opnory.reconciliation_outcome"] = rng() < 0.9 ? "converged" : "drift";
    attrs["opnory.retry_count"] = String(Math.floor(rng() * 3));
  }

  if (spanName === "provider.grant") {
    attrs["opnory.retry_count"] = rng() < 0.1 ? "1" : "0";
  }

  // Final outcome on the root span
  if (spanName === "opnory.request") {
    attrs["opnory.final_outcome"] = rng() < 0.9 ? "fulfilled" : "failed";
    attrs["opnory.error_type"] = rng() < 0.1 ? "provider_unreachable" : "";
  }

  return attrs;
}

// ============================================================================
// Span building
// ============================================================================

interface SpanSeed {
  name: SpanName;
  parentSpanId: string | null;
  depth: number;
  startOffsetNanos: bigint;
}

function buildSpan(
  rng: () => number,
  tenantId: string,
  correlationId: string,
  requestId: string,
  workflowType: string,
  traceId: string,
  anchorEpochNs: bigint,
  seed: SpanSeed,
): OpnorySpan {
  const durationNanos = BigInt(Math.floor(rng() * 50_000_000) + 1_000_000); // 1ms..51ms
  return {
    traceId,
    spanId: randomHex(rng, 8),
    parentSpanId: seed.parentSpanId,
    name: seed.name,
    startEpochNanos: anchorEpochNs + seed.startOffsetNanos,
    durationEpochNanos: durationNanos,
    kind: seed.depth === 0 ? "SERVER" : "INTERNAL",
    attributes: genAttributes(rng, tenantId, correlationId, requestId, workflowType, seed.name),
    tenantId,
  };
}

function buildTraceTree(
  rng: () => number,
  tenantId: string,
  workflowType: string,
  traceId: string,
  anchorEpochNs: bigint,
): OpnoryTrace {
  const correlationId = `corr-${randomHex(rng, 8)}`;
  const requestId = `req-${randomHex(rng, 8)}`;

  const spans: OpnorySpan[] = [];
  // Root
  const root = buildSpan(rng, tenantId, correlationId, requestId, workflowType, traceId, anchorEpochNs, {
    name: "opnory.request",
    parentSpanId: null,
    depth: 0,
    startOffsetNanos: 0n,
  });
  spans.push(root);

  // Children of root (identity.resolve, retrieval.search, gen_ai.inference, policy.evaluate, fulfillment)
  const rootChildren: SpanName[] = ["identity.resolve", "retrieval.search", "gen_ai.inference", "policy.evaluate"];
  let offset = 1_000_000n;
  for (const childName of rootChildren) {
    const child = buildSpan(rng, tenantId, correlationId, requestId, workflowType, traceId, anchorEpochNs, {
      name: childName,
      parentSpanId: root.spanId,
      depth: 1,
      startOffsetNanos: offset,
    });
    offset += 1_000_000n;
    spans.push(child);
  }

  // fulfillment subtree
  const fulfillment = buildSpan(rng, tenantId, correlationId, requestId, workflowType, traceId, anchorEpochNs, {
    name: "fulfillment",
    parentSpanId: root.spanId,
    depth: 1,
    startOffsetNanos: offset,
  });
  offset += 1_000_000n;
  spans.push(fulfillment);

  const fulfillmentChildren: SpanName[] = ["subject.resolve", "provider.grant", "provider.verify", "evidence.record", "reconciliation"];
  for (const childName of fulfillmentChildren) {
    const child = buildSpan(rng, tenantId, correlationId, requestId, workflowType, traceId, anchorEpochNs, {
      name: childName,
      parentSpanId: fulfillment.spanId,
      depth: 2,
      startOffsetNanos: offset,
    });
    offset += 1_000_000n;
    spans.push(child);
  }

  return {
    traceId,
    tenantId,
    correlationId,
    requestId,
    workflowType,
    spans,
  };
}

// ============================================================================
// Manifest
// ============================================================================

function buildManifest(corpus: TraceCorpus, serializedBytes: number, sha256: string): CorpusManifest {
  const spanNameCounts: Record<string, number> = {};
  const spanNameDurationNanos: Record<string, string> = {};
  const tenantSet = new Set<string>();

  for (const trace of corpus.traces) {
    tenantSet.add(trace.tenantId);
    for (const span of trace.spans) {
      spanNameCounts[span.name] = (spanNameCounts[span.name] || 0) + 1;
      const prev = BigInt(spanNameDurationNanos[span.name] || "0");
      spanNameDurationNanos[span.name] = (prev + span.durationEpochNanos).toString();
    }
  }

  return {
    seed: corpus.seed,
    anchorEpochMs: corpus.anchorEpochMs,
    spanCount: corpus.traces.reduce((n, t) => n + t.spans.length, 0),
    traceCount: corpus.traces.length,
    tenantIds: Array.from(tenantSet).sort(),
    spanNameCounts,
    spanNameDurationNanos,
    serializedBytes,
    sha256,
    traceIds: corpus.traces.map((t) => t.traceId).sort(),
  };
}

// ============================================================================
// Serialization — the canonical OTLP payload (byte-identity anchor)
// ============================================================================

export function serializeCorpus(corpus: TraceCorpus): string {
  // Canonical JSON: stable key order, no timestamps from runtime. This is the
  // byte-identity anchor — replay the SAME string to every backend.
  // BigInts (startEpochNanos / durationEpochNanos) are emitted as decimal
  // strings, matching the manifest's string convention for durations, because
  // JSON cannot represent `bigint`.
  const ordered = corpus.traces
    .map((t) => t)
    .sort((a, b) => a.traceId.localeCompare(b.traceId));
  return JSON.stringify(
    ordered.map((t) => ({
      traceId: t.traceId,
      tenantId: t.tenantId,
      correlationId: t.correlationId,
      requestId: t.requestId,
      workflowType: t.workflowType,
      spans: t.spans
        .map((s) => s)
        .sort((a, b) => (a.startEpochNanos < b.startEpochNanos ? -1 : 1))
        .map((s) => ({
          traceId: s.traceId,
          spanId: s.spanId,
          parentSpanId: s.parentSpanId,
          name: s.name,
          startEpochNanos: s.startEpochNanos.toString(),
          durationEpochNanos: s.durationEpochNanos.toString(),
          kind: s.kind,
          attributes: s.attributes,
          tenantId: s.tenantId,
        })),
    })),
  );
}

// ============================================================================
// Public generator entrypoint
// ============================================================================

export interface GenerateOptions {
  seed: number;
  anchorEpochMs: number;
  /** number of traces to generate */
  traceCount: number;
  /** tenant ids to distribute across */
  tenantIds: string[];
}

export function generateCorpus(opts: GenerateOptions): TraceCorpus {
  const rng = mulberry32(opts.seed);
  const anchorEpochNs = BigInt(opts.anchorEpochMs) * 1_000_000n;

  const traces: OpnoryTrace[] = [];
  for (let i = 0; i < opts.traceCount; i++) {
    const tenantId = opts.tenantIds[Math.floor(rng() * opts.tenantIds.length)];
    const workflowType = WORKFLOW_TYPES[Math.floor(rng() * WORKFLOW_TYPES.length)];
    const traceId = randomHex(rng, 16);
    traces.push(buildTraceTree(rng, tenantId, workflowType, traceId, anchorEpochNs));
  }

  return {
    seed: opts.seed,
    anchorEpochMs: opts.anchorEpochMs,
    traces,
  };
}

export function generateCorpusWithManifest(opts: GenerateOptions): { corpus: TraceCorpus; manifest: CorpusManifest } {
  const corpus = generateCorpus(opts);
  const serialized = serializeCorpus(corpus);
  const sha256 = createHash("sha256").update(serialized, "utf8").digest("hex");
  const manifest = buildManifest(corpus, Buffer.byteLength(serialized, "utf8"), sha256);
  return { corpus, manifest };
}

// Re-export for the parity gate's convenience
export { SUPPORT_REQUEST, FULFILLMENT_TREE, HIERARCHY, INTEGRATION_LIFECYCLE, WORKFLOW_TYPES };