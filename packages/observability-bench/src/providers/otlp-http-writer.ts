// packages/observability-bench/src/providers/otlp-http-writer.ts
// Common write path: push the deterministic corpus to the local OTLP collector
// over HTTP (/v1/traces, application/x-protobuf or JSON). Every backend receives
// the SAME serialized corpus through this single replay layer — no per-vendor
// SDK, so ingest differences cannot leak into the query comparison.
//
// Zero Opnory runtime imports; node:http only.

import type { TraceCorpus, OpnorySpan } from "../trace-model.js";
import type { TraceWriter } from "../provider.js";

/**
 * Minimal JSON OTLP trace envelope. Structure mirrors the OTLP protobuf wire
 * shape (ResourceSpans → ScopeSpans → Spans), reduced to what the collector
 * needs to accept and index the corpus. Span/event linkage is attribute-only;
 * timestamps are epoch nanos (as strings, per the corpus convention).
 */

interface OtlpAttribute {
  key: string;
  value: { stringValue?: string; intValue?: string };
}

interface OtlpSpan {
  traceId: string; // 32 hex chars
  spanId: string; // 16 hex chars
  parentSpanId?: string;
  name: string;
  kind: number; // OTel SpanKind enum
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
}

interface OtlpScopeSpans {
  spans: OtlpSpan[];
}

interface OtlpResourceSpans {
  scopeSpans: OtlpScopeSpans[];
  resource: {
    attributes: OtlpAttribute[];
  };
}

function encodeId(hex: string): string {
  // OTLP JSON expects base64-encoded bytes for trace/span IDs; we pass hex and
  // the collector's HTTP JSON endpoint accepts hex-encoded ID strings directly
  // when the field is `traceId`/`spanId` (hex form). Keep as hex.
  return hex;
}

function tagsToAttributes(attrs: Record<string, string>): OtlpAttribute[] {
  return Object.entries(attrs).map(([key, value]) => ({
    key,
    value: { stringValue: value },
  }));
}

function corpusToResourceSpans(corpus: TraceCorpus): OtlpResourceSpans[] {
  // One resource per tenant, carrying the tenant's resource attributes so
  // downstream backends can search by tenant.
  const byTenant = new Map<string, OpnorySpan[]>();
  for (const trace of corpus.traces) {
    const list = byTenant.get(trace.tenantId) ?? [];
    for (const span of trace.spans) list.push(span);
    byTenant.set(trace.tenantId, list);
  }

  const out: OtlpResourceSpans[] = [];
  for (const [tenantId, spans] of byTenant) {
    const otlpSpans: OtlpSpan[] = spans.map((s) => ({
      traceId: encodeId(s.traceId),
      spanId: encodeId(s.spanId),
      ...(s.parentSpanId ? { parentSpanId: encodeId(s.parentSpanId) } : {}),
      name: s.name,
      kind: spanKindToInt(s.kind),
      startTimeUnixNano: s.startEpochNanos.toString(),
      endTimeUnixNano: (s.startEpochNanos + s.durationEpochNanos).toString(),
      attributes: tagsToAttributes(s.attributes),
    }));

    out.push({
      scopeSpans: [{ spans: otlpSpans }],
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "opnory" } },
          { key: "opnory.tenant_id", value: { stringValue: tenantId } },
        ],
      },
    });
  }
  return out;
}

function spanKindToInt(kind: OpnorySpan["kind"]): number {
  // OTel SpanKind enum: UNSPECIFIED=0, INTERNAL=1, SERVER=2, CLIENT=3,
  // PRODUCER=4, CONSUMER=5.
  switch (kind) {
    case "INTERNAL":
      return 1;
    case "SERVER":
      return 2;
    case "CLIENT":
      return 3;
    case "PRODUCER":
      return 4;
    case "CONSUMER":
      return 5;
    default:
      return 1;
  }
}

export interface OtlpHttpWriterOptions {
  /** OTLP endpoint, e.g. http://localhost:4318 */
  endpoint: string;
  providerName: string;
}

/** The OTLP/JSON envelope for an entire corpus, exposed for single-send paths. */
export function buildOtlpPayload(corpus: TraceCorpus): { resourceSpans: unknown[] } {
  return { resourceSpans: corpusToResourceSpans(corpus) };
}

/**
 * A TraceWriter that POSTs the corpus to an OTLP/HTTP collector.
 */
export class OtlpHttpWriter implements TraceWriter {
  readonly providerName: string;
  readonly endpointDescription: string;

  private constructor(
    providerName: string,
    private readonly endpoint: string,
  ) {
    this.providerName = providerName;
    this.endpointDescription = `POST ${endpoint}/v1/traces (OTLP/HTTP JSON)`;
  }

  static create(opts: OtlpHttpWriterOptions): OtlpHttpWriter {
    return new OtlpHttpWriter(opts.providerName, opts.endpoint);
  }

  async writeCorpus(corpus: TraceCorpus): Promise<void> {
    const payload = JSON.stringify(buildOtlpPayload(corpus));

    const res = await fetch(`${this.endpoint}/v1/traces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OTLP write failed (${res.status}): ${body.slice(0, 256)}`);
    }
  }
}