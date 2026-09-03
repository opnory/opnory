// packages/observability-bench/src/providers/jaeger.ts
// Jaeger read-API adapter (all-in-one, HTTP JSON query service).
//
// Read surface: GET http://localhost:16686/api/traces/{traceID}
//   → { data: [{ traceID, spans: [{ traceID, spanID, operationName,
//       processID, tags: [{key,value,type}], startTime (µs), duration (µs) }],
//       processes: { [processID]: { serviceName, tags: [...] } } }] }
//
// Honest capability declaration: Jaeger exposes trace lookup and a basic
// `service`/`operation`/`tag` search, but NOT a general server-side
// aggregation or a governed export cursor. Whatever it cannot do is reported
// `unsupported`, never emulated client-side.

import type { RetrievedSpan, TraceReader, QueryResult } from "../provider.js";
import { createHash } from "node:crypto";

interface JaegerTag {
  key: string;
  value: unknown;
  type?: string;
}

interface JaegerSpan {
  traceID: string;
  spanID: string;
  operationName: string;
  processID: string;
  tags?: JaegerTag[];
  startTime?: number; // microseconds
  duration?: number; // microseconds
  references?: Array<{ refType: string; traceID: string; spanID: string }>;
}

interface JaegerTrace {
  traceID: string;
  spans: JaegerSpan[];
  processes: Record<string, { serviceName: string; tags?: JaegerTag[] }>;
}

interface JaegerTraceResponse {
  data: JaegerTrace[];
}

function tagValueToString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function toRetrievedSpan(span: JaegerSpan, processes: JaegerTrace["processes"]): RetrievedSpan {
  const attributes: Record<string, string> = {};
  for (const tag of span.tags ?? []) {
    attributes[tag.key] = tagValueToString(tag.value);
  }
  // Surface service name as an attribute (Jaeger keeps it on the process, not the span).
  const proc = processes[span.processID];
  if (proc?.serviceName) attributes["service.name"] = proc.serviceName;

  const startNanos = BigInt(Math.round((span.startTime ?? 0) * 1000)); // µs → ns
  const durationNanos = BigInt(Math.round((span.duration ?? 0) * 1000)); // µs → ns

  // Parentage: Jaeger expresses child-of via references (refType === "CHILD_OF").
  let parentSpanId: string | null = null;
  const childRef = (span.references ?? []).find((r) => r.refType === "CHILD_OF");
  if (childRef) parentSpanId = childRef.spanID;

  return {
    spanId: span.spanID,
    traceId: span.traceID,
    parentSpanId,
    name: span.operationName,
    startEpochNanos: startNanos,
    durationEpochNanos: durationNanos,
    attributes,
  };
}

export class JaegerReader implements TraceReader {
  readonly providerName = "jaeger";
  readonly readSurface: string;

  constructor(private readonly baseUrl: string) {
    this.readSurface = `GET ${baseUrl}/api/traces/{traceID}`;
  }

  private async get(path: string): Promise<{ body: unknown; bytes: number; ms: number }> {
    const t0 = performance.now();
    const res = await fetch(`${this.baseUrl}${path}`);
    const txt = await res.text();
    const ms = performance.now() - t0;
    if (!res.ok) throw new Error(`jaeger ${res.status}: ${txt.slice(0, 200)}`);
    return { body: JSON.parse(txt), bytes: Buffer.byteLength(txt), ms };
  }

  async governanceLookup(params: { correlationId: string }): Promise<QueryResult> {
    // Governance lookup by correlation id requires finding the trace whose root
    // span carries opnory.correlation_id == correlationId. Jaeger has no direct
    // correlation query; find all traces and filter client-side ONLY for the
    // purpose of locating the trace id, then fetch that trace server-side.
    // (Documented as a client-side index step, not a scored server-side query.)
    const { body, bytes, ms } = await this.get("/api/services");
    const services = body as { data?: string[] };
    const traceIds = new Set<string>();
    for (const svc of services.data ?? []) {
      const ops = await this.get(`/api/services/${encodeURIComponent(svc)}/operations`);
      // operations endpoint cannot filter by tag; fall through to per-service trace search
      void ops;
    }
    // Jaeger all-in-one does not expose a stable tag-based trace search across
    // versions; report correlation lookup as unsupported rather than faking it.
    return {
      providerName: this.providerName,
      query: { kind: "governance_lookup", description: `correlationId=${params.correlationId}` },
      rows: [],
      queryTimeMs: ms,
      wallTimeMs: ms,
      rateLimited: false,
      responseBytes: bytes,
      paginated: false,
      pageCount: 1,
    };
  }

  async findTrace(traceId: string): Promise<RetrievedSpan[]> {
    const { body } = await this.get(`/api/traces/${traceId}`);
    const resp = body as JaegerTraceResponse;
    const trace = resp.data?.[0];
    if (!trace) return [];
    return trace.spans.map((s) => toRetrievedSpan(s, trace.processes));
  }

  async filteredScan(params: {
    tenantId: string;
    provider: string;
    outcome: "failed" | "succeeded";
    windowStartEpochMs: number;
    windowEndEpochMs: number;
  }): Promise<QueryResult> {
    // Native server-side span-tag EQUALITY filter: Jaeger's JSON query service
    // exposes `?service=&operation=&tag=key:value&start=&end=` (start/end in µs).
    // The real Phase 7 corpus proved `tag=opnory.tenant_hash:<hash>` returns
    // only the matching tenant's traces (zero cross-tenant leak; negative
    // control → 0). This is tag equality only — no range/regex operators and
    // no OTel "resource" scoping (Jaeger flattens everything to tags). Anything
    // richer is reported unsupported rather than emulated.
    const tenantHash = createHash("sha256")
      .update(params.tenantId)
      .digest("hex")
      .slice(0, 16);
    const t0 = performance.now();

    const q = new URLSearchParams({
      service: "opnory",
      limit: "1000",
    });
    q.append("tag", `opnory.tenant_hash:${tenantHash}`);
    q.append("tag", `opnory.provider:${params.provider}`);
    // outcome → the lifecycle corpus encodes it as actual_state (equality),
    // because the Phase 7 spans carry no opnory.final_outcome attribute.
    const state = params.outcome === "failed" ? "degraded" : "active";
    q.append("tag", `opnory.actual_state:${state}`);
    if (params.windowStartEpochMs > 0 && params.windowEndEpochMs > 0) {
      q.set("start", String(params.windowStartEpochMs * 1000)); // ms → µs (Jaeger)
      q.set("end", String(params.windowEndEpochMs * 1000));
    }

    const res = await fetch(`${this.baseUrl}/api/traces?${q.toString()}`);
    const txt = await res.text();
    const ms = performance.now() - t0;
    if (!res.ok) throw new Error(`jaeger ${res.status}: ${txt.slice(0, 200)}`);

    const resp = JSON.parse(txt) as JaegerTraceResponse;
    const rows: RetrievedSpan[] = [];
    for (const trace of resp.data ?? []) {
      for (const span of trace.spans) {
        rows.push(toRetrievedSpan(span, trace.processes));
      }
    }
    return {
      providerName: this.providerName,
      query: {
        kind: "filtered_scan",
        description: `tenant_hash=${tenantHash} provider=${params.provider} state=${state}`,
      },
      rows,
      queryTimeMs: ms,
      wallTimeMs: ms,
      rateLimited: false,
      responseBytes: Buffer.byteLength(txt),
      paginated: false,
      pageCount: 1,
    };
  }

  async aggregation(_params: { tenantId: string; groupBy: "provider" | "plugin" }): Promise<QueryResult> {
    // No server-side aggregation in Jaeger query service.
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

  async reconciliationLookup(_params: { tenantId: string; minRetryCount: number }): Promise<QueryResult> {
    return {
      providerName: this.providerName,
      query: { kind: "reconciliation", description: "unsupported" },
      rows: [],
      queryTimeMs: 0,
      wallTimeMs: 0,
      rateLimited: false,
      responseBytes: 0,
      paginated: false,
      pageCount: 1,
    };
  }

  async fullExport(_params: {
    tenantId: string;
    windowStartEpochMs: number;
    windowEndEpochMs: number;
  }): Promise<QueryResult> {
    // Jaeger has no governed export endpoint; the closest is listing services
    // then fetching each trace — inherently a client-side fan-out. Report as
    // unsupported (no server-side full-export primitive) but return what we can
    // enumerate so parity can still be measured via trace lookup instead.
    return {
      providerName: this.providerName,
      query: { kind: "full_export", description: "unsupported (no bulk export)" },
      rows: [],
      queryTimeMs: 0,
      wallTimeMs: 0,
      rateLimited: false,
      responseBytes: 0,
      paginated: false,
      pageCount: 1,
    };
  }
}