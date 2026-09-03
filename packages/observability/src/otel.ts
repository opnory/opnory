// packages/observability/src/otel.ts
// OpenTelemetry trace emission for lifecycle/observability proofs.
// This is the narrow boundary through which core lifecycle spans reach OTLP.
// It does NOT replace the pino logger; it is a parallel emission path for spans.
// No OTel SDK dependency — the trace is the plain object, and the exporter is a
// single OTLP/HTTP call, consistent with the corpus-sync pattern.
//
// Authentication: honors the standard OTel env vars for OTLP/HTTP headers —
//   OTEL_EXPORTER_OTLP_HEADERS          key=value,key=value (comma-separated)
//   OTEL_EXPORTER_OTLP_TRACES_HEADERS   trace-signal-specific; takes precedence
// Header values are never logged or surfaced in error messages.

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

/** Header map built from OTLP header-list env vars (keys are signal-specific). */
export type OtelHeaderMap = Record<string, string>;

/**
 * Parse a standard OTel header list (`key=value,key=value`) into a header map.
 * Values are percent-decoded per the OTel SDK convention. This is a pure
 * function so it is unit-testable without network access.
 */
export function parseOtelHeaders(raw: string | undefined): OtelHeaderMap {
  const out: OtelHeaderMap = {};
  if (!raw) return out;
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue; // no key, or empty key — skip malformed pair
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!key) continue;
    // URL-decode the value (OTel env spec percent-encodes header values).
    let decoded = value;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      decoded = value; // not percent-encoded — use as-is
    }
    out[key] = decoded;
  }
  return out;
}

/**
 * Resolve the OTLP/HTTP request headers, honoring the trace-specific override.
 * Signal-specific (`..._TRACES_HEADERS`) wins over the generic
 * (`..._HEADERS`), per OTel env precedence. Header NAMES are known here but
 * VALUES are deliberately opaque to the rest of the module.
 */
export function resolveOtelHeaders(env: NodeJS.ProcessEnv = process.env): OtelHeaderMap {
  const generic = parseOtelHeaders(env.OTEL_EXPORTER_OTLP_HEADERS);
  const traces = parseOtelHeaders(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS);
  // Trace-specific entries take precedence; generic fills the remainder.
  return { ...generic, ...traces };
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
  const extraHeaders = resolveOtelHeaders();

  return fetch(`${OPNORY_OTLP_ENDPOINT}/v1/traces`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body,
  }).then(async (res) => {
    if (!res.ok) {
      // Consume the body but never surface it — it may carry a request id, not
      // our credential, but we leak neither. Expose only the status.
      await res.text().catch(() => "");
      throw new Error(`OTLP emit failed: status=${res.status}`);
    }
  });
}