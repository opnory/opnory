// packages/observability-bench/src/providers/index.ts
// Wire each backend into a CandidateProvider (writer + reader + capabilities)
// and register it. The writer is shared OtlpHttpWriter — the SAME serialized
// corpus reaches every backend through the collector, so ingest differences
// cannot leak into the query comparison.

import type { CandidateProvider, ProviderCapabilities } from "../provider.js";
import { registerProvider, NO_CAPABILITIES } from "../provider.js";
import { OtlpHttpWriter } from "./otlp-http-writer.js";
import { JaegerReader } from "./jaeger.js";
import { TempoReader } from "./tempo.js";
import { PhoenixReader } from "./phoenix.js";

/** Local baseline defaults (matches docker/compose.yml published ports). */
const COLLECTOR_OTLP = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318";
const JAEGER_READ = process.env.JAEGER_READ_URL ?? "http://localhost:16686";
const TEMPO_READ = process.env.TEMPO_READ_URL ?? "http://localhost:3200";
const PHOENIX_READ = process.env.PHOENIX_READ_URL ?? "http://localhost:6006";
const PHOENIX_PROJECT = process.env.PHOENIX_PROJECT ?? "default";

const jaegerCapabilities: ProviderCapabilities = {
  traceLookup: true,
  attributeFiltering: false, // no stable server-side tag filter on JSON query service
  aggregation: false,
  fullExport: false, // no governed bulk export
  pagination: false,
  correlationLookup: false, // no correlation-indexed lookup
};

const tempoCapabilities: ProviderCapabilities = {
  traceLookup: true,
  attributeFiltering: true, // TraceQL {} operator
  aggregation: true, // TraceQL metrics / count() by
  fullExport: true, // broad TraceQL span search
  pagination: false, // single-binary search does not expose a governed cursor
  correlationLookup: true, // span attribute filter on correlation id
};

const phoenixCapabilities: ProviderCapabilities = {
  traceLookup: true,
  attributeFiltering: true, // dot-path filter=key:value
  aggregation: false, // no first-class REST aggregation (SQL overlay out of scope)
  fullExport: true, // cursor-paginated span list
  pagination: true, // cursor-based
  correlationLookup: true, // attribute filter on correlation id
};

export function registerLocalProviders(): void {
  registerProvider(buildJaeger());
  registerProvider(buildTempo());
  registerProvider(buildPhoenix());
}

export function buildJaeger(): CandidateProvider {
  return {
    providerName: "jaeger",
    writer: OtlpHttpWriter.create({ providerName: "jaeger", endpoint: COLLECTOR_OTLP }),
    reader: new JaegerReader(JAEGER_READ),
    capabilities: jaegerCapabilities,
    authDescription: "no auth (local all-in-one)",
  };
}

export function buildTempo(): CandidateProvider {
  return {
    providerName: "tempo",
    writer: OtlpHttpWriter.create({ providerName: "tempo", endpoint: COLLECTOR_OTLP }),
    reader: new TempoReader(TEMPO_READ),
    capabilities: tempoCapabilities,
    authDescription: "no auth (local single binary)",
  };
}

export function buildPhoenix(): CandidateProvider {
  return {
    providerName: "phoenix",
    writer: OtlpHttpWriter.create({ providerName: "phoenix", endpoint: COLLECTOR_OTLP }),
    reader: new PhoenixReader(PHOENIX_READ, PHOENIX_PROJECT),
    capabilities: phoenixCapabilities,
    authDescription: "no auth (local REST)",
  };
}

export { NO_CAPABILITIES };