// packages/observability-bench/src/providers/phoenix.ts
// Arize Phoenix read-API adapter (local REST).
//
// Read surfaces:
//   GET /v1/projects/{project}/spans?trace_id=..&parent_id=..&name=..
//       &filter=key:value&start_time=..&end_time=..&limit=..&cursor=..
//     → spans carry context.trace_id, context.span_id, attributes.
//
// Phoenix exposes the strongest span-level attribute filtering of the three
// (dot-path `key:value` filters) plus cursor pagination. Aggregation is NOT a
// first-class read primitive (SQL overlay is opt-in), so aggregation is
// reported unsupported unless proven server-side.

import type { RetrievedSpan, TraceReader, QueryResult } from "../provider.js";

interface PhoenixSpan {
  context?: {
    trace_id?: string;
    span_id?: string;
  };
  parent_id?: string | null;
  name?: string;
  attributes?: Record<string, unknown>;
  start_time?: string;
  end_time?: string;
}

interface PhoenixSpanListResponse {
  data?: PhoenixSpan[];
  next_cursor?: string | null;
  [key: string]: unknown;
}

function attrToString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function phoenixSpanToRetrieved(span: PhoenixSpan): RetrievedSpan | null {
  const traceId = span.context?.trace_id;
  const spanId = span.context?.span_id;
  if (!traceId || !spanId) return null;

  const attributes: Record<string, string> = {};
  for (const [k, v] of Object.entries(span.attributes ?? {})) {
    if (Array.isArray(v)) attributes[k] = v.map(attrToString).join(",");
    else attributes[k] = attrToString(v);
  }

  const start = span.start_time ? Date.parse(span.start_time) : 0;
  const end = span.end_time ? Date.parse(span.end_time) : start;
  const startNs = BigInt(start) * 1_000_000n;
  const durationNs = BigInt(Math.max(0, end - start)) * 1_000_000n;

  return {
    spanId,
    traceId,
    parentSpanId: span.parent_id ?? null,
    name: span.name ?? "",
    startEpochNanos: startNs,
    durationEpochNanos: durationNs,
    attributes,
  };
}

function dotFilter(key: string, value: string): string {
  // Phoenix filter syntax: dot-path key, JSON-parsed value. Plain strings are
  // quoted when they might otherwise parse as number/bool.
  if (/^-?\d+(\.\d+)?$/.test(value) || /^(true|false)$/i.test(value)) {
    return `${key}:${JSON.stringify(value)}`;
  }
  return `${key}:${value}`;
}

export class PhoenixReader implements TraceReader {
  readonly providerName = "phoenix";
  readonly readSurface: string;

  constructor(
    private readonly baseUrl: string,
    private readonly project: string,
  ) {
    this.readSurface = `GET ${baseUrl}/v1/projects/${project}/spans`;
  }

  private async get(path: string): Promise<{ body: unknown; bytes: number; ms: number; rateLimited: boolean }> {
    const t0 = performance.now();
    const res = await fetch(`${this.baseUrl}${path}`);
    const txt = await res.text();
    const ms = performance.now() - t0;
    const rateLimited = res.status === 429;
    if (!res.ok) throw new Error(`phoenix ${res.status}: ${txt.slice(0, 200)}`);
    let body: unknown = {};
    try {
      body = JSON.parse(txt);
    } catch {
      body = {};
    }
    return { body, bytes: Buffer.byteLength(txt), ms, rateLimited };
  }

  private async listSpans(query: string): Promise<{ rows: RetrievedSpan[]; bytes: number; ms: number; rateLimited: boolean }> {
    const { body, bytes, ms, rateLimited } = await this.get(
      `/v1/projects/${this.project}/spans?${query}`,
    );
    const resp = body as PhoenixSpanListResponse;
    const rows: RetrievedSpan[] = [];
    for (const span of resp.data ?? []) {
      const r = phoenixSpanToRetrieved(span);
      if (r) rows.push(r);
    }
    return { rows, bytes, ms, rateLimited };
  }

  private ser(v: string): string {
    return encodeURIComponent(v);
  }

  async filteredScan(params: {
    tenantId: string;
    provider: string;
    outcome: "failed" | "succeeded";
    windowStartEpochMs: number;
    windowEndEpochMs: number;
  }): Promise<QueryResult> {
    const outcomeValue = params.outcome === "failed" ? "failed" : "fulfilled";
    const filters = [
      dotFilter("attributes.opnory.tenant_id", params.tenantId),
      dotFilter("attributes.opnory.provider", params.provider),
      dotFilter("attributes.opnory.final_outcome", outcomeValue),
    ];
    const qs = filters.map((f) => `filter=${this.ser(f)}`).join("&");
    const { rows, bytes, ms, rateLimited } = await this.listSpans(`${qs}&limit=1000`);
    return {
      providerName: this.providerName,
      query: { kind: "filtered_scan", description: filters.join(" AND ") },
      rows,
      queryTimeMs: ms,
      wallTimeMs: ms,
      rateLimited,
      responseBytes: bytes,
      paginated: false,
      pageCount: 1,
    };
  }

  async governanceLookup(params: { correlationId: string }): Promise<QueryResult> {
    const f = `filter=${this.ser(dotFilter("attributes.opnory.correlation_id", params.correlationId))}`;
    const { rows, bytes, ms, rateLimited } = await this.listSpans(`${f}&limit=1000`);
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
    const { rows } = await this.listSpans(`trace_id=${this.ser(traceId)}&limit=1000`);
    return rows;
  }

  async aggregation(_params: { tenantId: string; groupBy: "provider" | "plugin" }): Promise<QueryResult> {
    // Phoenix REST has no first-class server-side aggregation (SQL overlay is
    // opt-in and out of scope for the baseline). Report unsupported.
    return {
      providerName: this.providerName,
      query: { kind: "aggregation", description: "unsupported" },
      rows: [],
      queryTimeMs: 0,
      wallTimeMs: 0,
      rateLimited: false,
      responseBytes: 0,
      paginated: false,
      pageCount: 1,
    };
  }

  async agentLookup(params: { tenantId: string; toolName: string }): Promise<QueryResult> {
    const filters = [
      dotFilter("attributes.opnory.tenant_id", params.tenantId),
    ];
    // tool calls: find spans with opnory.tool_calls > 0 would be attribute, but
    // agent lookup (model invoked entitlement tools) is not a Phoenix primitive;
    // report filtered by tenant + tool name as a span-name filter, honestly.
    const qs = filters.map((f) => `filter=${this.ser(f)}`).join("&");
    const { rows, bytes, ms, rateLimited } = await this.listSpans(`${qs}&name=${this.ser(params.toolName)}&limit=1000`);
    return {
      providerName: this.providerName,
      query: { kind: "agent_lookup", description: `tool=${params.toolName}` },
      rows,
      queryTimeMs: ms,
      wallTimeMs: ms,
      rateLimited,
      responseBytes: bytes,
      paginated: false,
      pageCount: 1,
    };
  }

  async reconciliationLookup(params: { tenantId: string; minRetryCount: number }): Promise<QueryResult> {
    // opnory.retry_count is a string attribute; Numeric range comparison is not
    // a Phoenix filter primitive. Report the tenant filter and mark the retry
    // predicate unsupported.
    const f = `filter=${this.ser(dotFilter("attributes.opnory.tenant_id", params.tenantId))}`;
    const { rows, bytes, ms, rateLimited } = await this.listSpans(`${f}&limit=1000`);
    return {
      providerName: this.providerName,
      query: { kind: "reconciliation", description: `minRetryCount=${params.minRetryCount} (retry predicate unsupported)` },
      rows,
      queryTimeMs: ms,
      wallTimeMs: ms,
      rateLimited,
      responseBytes: bytes,
      paginated: false,
      pageCount: 1,
    };
  }

  async fullExport(params: {
    tenantId: string;
    windowStartEpochMs: number;
    windowEndEpochMs: number;
  }): Promise<QueryResult> {
    // Cursor-paginated span export, client-driven by the server's cursor.
    const f = `filter=${this.ser(dotFilter("attributes.opnory.tenant_id", params.tenantId))}`;
    const all: RetrievedSpan[] = [];
    let cursor: string | null = null;
    let pageCount = 0;
    let bytes = 0;
    let ms = 0;
    let rateLimited = false;
    const t0 = performance.now();
    do {
      const cursorParam = cursor ? `&cursor=${this.ser(cursor)}` : "";
      const { body, bytes: b, ms: m, rateLimited: rl } = await this.get(
        `/v1/projects/${this.project}/spans?${f}${cursorParam}&limit=1000`,
      );
      bytes += b;
      ms += m;
      rateLimited = rateLimited || rl;
      const resp = body as PhoenixSpanListResponse;
      for (const span of resp.data ?? []) {
        const r = phoenixSpanToRetrieved(span);
        if (r) all.push(r);
      }
      cursor = resp.next_cursor ?? null;
      pageCount++;
    } while (cursor);
    return {
      providerName: this.providerName,
      query: { kind: "full_export", description: `tenant=${params.tenantId} (cursor paginated)` },
      rows: all,
      queryTimeMs: ms,
      wallTimeMs: performance.now() - t0,
      rateLimited,
      responseBytes: bytes,
      paginated: pageCount > 1,
      pageCount,
    };
  }
}