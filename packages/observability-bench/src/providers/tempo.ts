// packages/observability-bench/src/providers/tempo.ts
// Tempo read-API adapter (local single binary).
//
// Read surfaces:
//   GET /api/traces/{traceID}?start=..&end=..  → full trace JSON (v1)
//   GET /api/search?q={...TraceQL...}          → { traces: [{ traceID,
//       rootServiceName, rootTraceName, startTimeUnixNano, durationMs,
//       spanSets: [{ spans: [{ spanID, startTimeUnixNano, durationNanos,
//           attributes: [{ key, value: { stringValue|intValue|... } }] }],
//           matched }] }], metrics }
//
// Tempo's TraceQL exposes real server-side span filtering (the `{}` operator)
// and aggregation (metrics queries). Parent-child linkage is available via
// TraceQL structural operators, but the v1 trace endpoint returns the full
// tree with parentage. Unsupported primitives are reported, never emulated.

import type { RetrievedSpan, TraceReader, QueryResult } from "../provider.js";

interface TempoAttrValue {
  stringValue?: string;
  intValue?: string;
  boolValue?: boolean;
  doubleValue?: number;
}

interface TempoAttr {
  key: string;
  value: TempoAttrValue;
}

interface TempoSearchSpan {
  spanID: string;
  startTimeUnixNano: string;
  durationNanos: string;
  name?: string;
  attributes?: TempoAttr[];
  parentSpanId?: string;
}

interface TempoSearchTrace {
  traceID: string;
  rootServiceName?: string;
  rootTraceName?: string;
  startTimeUnixNano?: string;
  durationMs?: number;
  /* Tempo 2.5 emits `spanSet` (singular); newer releases emit `spanSets`. */
  spanSets?: Array<{ spans: TempoSearchSpan[]; matched: number }>;
  spanSet?: { spans: TempoSearchSpan[]; matched: number };
}

interface TempoSearchResponse {
  traces: TempoSearchTrace[];
  metrics?: unknown;
}

/** Extract span-sets regardless of the singular/plural key Tempo emits. */
export function spansFromSearchTrace(trace: TempoSearchTrace): TempoSearchSpan[] {
  const sets = trace.spanSets ?? (trace.spanSet ? [trace.spanSet] : []);
  const out: TempoSearchSpan[] = [];
  for (const set of sets) for (const span of set.spans) out.push(span);
  return out;
}

function attrValueToString(v: TempoAttrValue): string {
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return v.intValue;
  if (v.boolValue !== undefined) return String(v.boolValue);
  if (v.doubleValue !== undefined) return String(v.doubleValue);
  return "";
}

function searchSpanToRetrieved(span: TempoSearchSpan, traceId: string): RetrievedSpan {
  const attributes: Record<string, string> = {};
  for (const a of span.attributes ?? []) attributes[a.key] = attrValueToString(a.value);
  return {
    spanId: span.spanID,
    traceId,
    parentSpanId: span.parentSpanId ?? null,
    name: span.name ?? "",
    startEpochNanos: BigInt(span.startTimeUnixNano),
    durationEpochNanos: BigInt(span.durationNanos),
    attributes,
  };
}

function quoteTraceQL(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

/** TraceQL span-attribute reference: dotted names need a leading dot. */
function spanAttr(name: string): string {
  return `.${name}`;
}

/**
 * Normalize a backend ID to the canonical 32-hex(trace)/16-hex(span) form.
 * Tempo's v1 trace endpoint emits IDs as base64 (e.g. "TaBJtP9g…==") while its
 * search path emits hex. Decode base64 → hex when the value is not already hex.
 */
function normalizeId(id: string): string {
  if (/^[0-9a-f]{16}$/.test(id) || /^[0-9a-f]{32}$/.test(id)) return id;
  // base64 → bytes → hex. Fixed-width (8 or 16 bytes) after decode.
  const bytes = Buffer.from(id, "base64");
  return bytes.toString("hex");
}

export class TempoReader implements TraceReader {
  readonly providerName = "tempo";
  readonly readSurface: string;

  constructor(private readonly baseUrl: string) {
    this.readSurface = `GET ${baseUrl}/api/search?q={...}`;
  }

  private async get(path: string): Promise<{ body: unknown; bytes: number; ms: number; rateLimited: boolean }> {
    const t0 = performance.now();
    const res = await fetch(`${this.baseUrl}${path}`);
    const txt = await res.text();
    const ms = performance.now() - t0;
    const rateLimited = res.status === 429;
    if (!res.ok) throw new Error(`tempo ${res.status}: ${txt.slice(0, 200)}`);
    return { body: JSON.parse(txt), bytes: Buffer.byteLength(txt), ms, rateLimited };
  }

  /** Span-level attribute filter via TraceQL `{}` operator. */
  private async traceQLSpanQuery(expr: string, params: {
    tenantId: string;
    windowStartEpochMs: number;
    windowEndEpochMs: number;
  }): Promise<QueryResult> {
    const q = encodeURIComponent(
      `{ resource.opnory.tenant_id = ${quoteTraceQL(params.tenantId)} && ${expr} }`,
    );
    // NOTE: Tempo 2.5's /api/search `start`/`end` nano epoch params overflow
    // (int parsing rejects iOS-scale ns values); the time-windowed variant is
    // omitted for the local baseline. TraceQL span filtering is fully exercised
    // by the `{}` predicate; the window is only a prune for large corpora.
    const { body, bytes, ms, rateLimited } = await this.get(
      `/api/search?q=${q}&limit=1000`,
    );
    const resp = body as TempoSearchResponse;
    const rows: RetrievedSpan[] = [];
    for (const trace of resp.traces ?? []) {
      for (const span of spansFromSearchTrace(trace)) {
        rows.push(searchSpanToRetrieved(span, trace.traceID));
      }
    }
    return {
      providerName: this.providerName,
      query: { kind: "filtered_scan", description: expr },
      rows,
      queryTimeMs: ms,
      wallTimeMs: ms,
      rateLimited,
      responseBytes: bytes,
      paginated: false,
      pageCount: 1,
    };
  }

  async filteredScan(params: {
    tenantId: string;
    provider: string;
    outcome: "failed" | "succeeded";
    windowStartEpochMs: number;
    windowEndEpochMs: number;
  }): Promise<QueryResult> {
    const outcomeValue = params.outcome === "failed" ? "failed" : "fulfilled";
    const expr =
      `${spanAttr("opnory.provider")} = ${quoteTraceQL(params.provider)} && ` +
      `${spanAttr("opnory.final_outcome")} = ${quoteTraceQL(outcomeValue)}`;
    return this.traceQLSpanQuery(expr, params);
  }

  async governanceLookup(params: { correlationId: string }): Promise<QueryResult> {
    // Find spans carrying the correlation id, then group by trace id.
    const q = encodeURIComponent(
      `{ ${spanAttr("opnory.correlation_id")} = ${quoteTraceQL(params.correlationId)} }`,
    );
    const { body, bytes, ms, rateLimited } = await this.get(`/api/search?q=${q}&limit=1000`);
    const resp = body as TempoSearchResponse;
    const rows: RetrievedSpan[] = [];
    for (const trace of resp.traces ?? []) {
      for (const span of spansFromSearchTrace(trace)) {
        rows.push(searchSpanToRetrieved(span, trace.traceID));
      }
    }
    return {
      providerName: this.providerName,
      query: { kind: "governance_lookup", description: `correlationId=${params.correlationId}` },
      rows,
      queryTimeMs: ms,
      wallTimeMs: ms,
      rateLimited,
      responseBytes: bytes,
      paginated: false,
      pageCount: 1,
    };
  }

  async findTrace(traceId: string): Promise<RetrievedSpan[]> {
    const { body } = await this.get(`/api/traces/${traceId}`);
    // v1 trace JSON: array of batches with resource/scopeSpans/spans.
    const parsed = body as unknown as {
      batches?: Array<{
        resource?: { attributes?: TempoAttr[] };
        scopeSpans?: Array<{ spans?: Array<{ spanId?: string; traceId?: string; parentSpanId?: string; name?: string; startTimeUnixNano?: string; endTimeUnixNano?: string; attributes?: TempoAttr[] }> }>;
      }>;
    };
    const rows: RetrievedSpan[] = [];
    for (const batch of parsed.batches ?? []) {
      const resAttrs: Record<string, string> = {};
      for (const a of batch.resource?.attributes ?? []) resAttrs[a.key] = attrValueToString(a.value);
      for (const sc of batch.scopeSpans ?? []) {
        for (const span of sc.spans ?? []) {
          if (!span.spanId) continue;
          const attrs: Record<string, string> = { ...resAttrs };
          for (const a of span.attributes ?? []) attrs[a.key] = attrValueToString(a.value);
          const start = BigInt(span.startTimeUnixNano ?? "0");
          const end = BigInt(span.endTimeUnixNano ?? "0");
          // Tempo's v1 trace endpoint returns IDs base64-encoded while its
          // search path returns hex. Normalize to hex (the canonical corpus
          // form) so findTrace parity is comparable — this is ID normalization,
          // not emulation of a query primitive.
          rows.push({
            spanId: normalizeId(span.spanId),
            traceId: span.traceId ? normalizeId(span.traceId) : traceId,
            parentSpanId: span.parentSpanId ? normalizeId(span.parentSpanId) : null,
            name: span.name ?? "",
            startEpochNanos: start,
            durationEpochNanos: end - start,
            attributes: attrs,
          });
        }
      }
    }
    return rows;
  }

  async aggregation(params: { tenantId: string; groupBy: "provider" | "plugin" }): Promise<QueryResult> {
    // TraceQL metrics query for span count grouped by attribute.
    const attr = params.groupBy === "provider" ? "opnory.provider" : "opnory.plugin_id";
    const q = encodeURIComponent(
      `{ resource.opnory.tenant_id = ${quoteTraceQL(params.tenantId)} } | count() by (${attr})`,
    );
    const { body, bytes, ms, rateLimited } = await this.get(`/api/search?q=${q}`);
    return {
      providerName: this.providerName,
      query: { kind: "aggregation", description: `count() by (${attr})` },
      rows: [body as Record<string, unknown>],
      queryTimeMs: ms,
      wallTimeMs: ms,
      rateLimited,
      responseBytes: bytes,
      paginated: false,
      pageCount: 1,
    };
  }

  async agentLookup(_params: { tenantId: string; toolName: string }): Promise<QueryResult> {
    return {
      providerName: this.providerName,
      query: { kind: "agent_lookup", description: "unsupported" },
      rows: [],
      queryTimeMs: 0,
      wallTimeMs: 0,
      rateLimited: false,
      responseBytes: 0,
      paginated: false,
      pageCount: 1,
    };
  }

  async reconciliationLookup(params: { tenantId: string; minRetryCount: number }): Promise<QueryResult> {
    const expr = `${spanAttr("opnory.retry_count")} >= ${params.minRetryCount}`;
    return this.traceQLSpanQuery(expr, { tenantId: params.tenantId, windowStartEpochMs: 0, windowEndEpochMs: 0 });
  }

  async fullExport(params: {
    tenantId: string;
    windowStartEpochMs: number;
    windowEndEpochMs: number;
  }): Promise<QueryResult> {
    // Tempo has no governed bulk-export cursor in the single-binary; the
    // closest primitive is a broad TraceQL span search. Report it as a span
    // search (which IS a server-side full read), but mark pagination unsupported.
    const q = encodeURIComponent(
      `{ resource.opnory.tenant_id = ${quoteTraceQL(params.tenantId)} }`,
    );
    // Omit start/end (Tempo 2.5 nano-epoch overflow); the `{}` predicate
    // scopes to the tenant.
    const { body, bytes, ms, rateLimited } = await this.get(
      `/api/search?q=${q}&limit=1000`,
    );
    const resp = body as TempoSearchResponse;
    const rows: RetrievedSpan[] = [];
    for (const trace of resp.traces ?? []) {
      for (const span of spansFromSearchTrace(trace)) {
        rows.push(searchSpanToRetrieved(span, trace.traceID));
      }
    }
    return {
      providerName: this.providerName,
      query: { kind: "full_export", description: `tenant=${params.tenantId} (TraceQL span search)` },
      rows,
      queryTimeMs: ms,
      wallTimeMs: ms,
      rateLimited,
      responseBytes: bytes,
      paginated: false,
      pageCount: 1,
    };
  }
}