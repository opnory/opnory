// packages/observability/src/otel.ts
// OpenTelemetry trace emission for lifecycle/observability proofs.
// This is the narrow boundary through which core lifecycle spans reach OTLP.
// It does NOT replace the pino logger; it is a parallel emission path for spans.
// No OTel SDK dependency — the trace is the plain object, and the exporter is a
// single OTLP/HTTP call, consistent with the corpus-sync pattern.

export interface OtelSpanInput {
  /** 32-hex trace ID (must match parent trace) */
  traceId: string;
  /** 16-hex span ID (generated here) */
  spanId: string;
  /** parent span ID, or undefined for the root lifecycle operation */
  parentSpanId?: string;
  /** operation name (the semantic phase, e.g. "integration.install") */
  readonly name: string;
  /** epoch nanos when the span started (recorded by caller) */
  startUnixNano: bigint;
  /** epoch nanos when the span ended (recorded by caller) */
  endUnixNano: bigint;
  /** tenant-scoped attributes (the frozen attribute contract) */
  attributes: Record<string, string>;
}

const OPNORY_OTLP_ENDPOINT =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318";

export function isOtelEnabled(): boolean {
  // Explicit opt-in only — avoids ambient production trace noise and surprises.
  return process.env.OPNORY_OTEL_TRACES_ENABLED === "1";
}

export function emitSpan(span: OtelSpanInput): Promise<void> {
  if (!isOtelEnabled()) {
    return Promise.resolve();
  }

  const resourceSpans = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "opnory" } },
            // The tenant hash is a resource attribute so every span is
            // searchable per tenant in the backend query surface without ever
            // exposing the raw tenant identifier.
            ...(span.attributes["opnory.tenant_hash"]
              ? [{ key: "opnory.tenant_hash", value: { stringValue: span.attributes["opnory.tenant_hash"] } }]
              : []),
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: span.traceId,
                spanId: span.spanId,
                parentSpanId: span.parentSpanId,
                name: span.name,
                kind: 1, // INTERNAL
                startTimeUnixNano: span.startUnixNano.toString(),
                endTimeUnixNano: span.endUnixNano.toString(),
                attributes: Object.entries(span.attributes).map(([key, value]) => ({
                  key,
                  value: { stringValue: value },
                })),
              },
            ],
          },
        ],
      },
    ],
  };

  const body = JSON.stringify(resourceSpans);

  return fetch(`${OPNORY_OTLP_ENDPOINT}/v1/traces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  }).then(async (res) => {
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `OTLP emit failed: status=${res.status}: body=${text.slice(0, 100)}`,
      );
    }
  });
}
