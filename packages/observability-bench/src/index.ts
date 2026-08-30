// packages/observability-bench/src/index.ts
// Package barrel for @opnory/observability-bench.
// Independent evaluation package — no Opnory runtime imports.

export type {
  OpnorySpan,
  OpnoryTrace,
  TraceCorpus,
  CorpusManifest,
  SpanName,
  OpnoryAttributeName,
  RedactedAttributeName,
} from "./trace-model.js";
export {
  OPONORY_ATTRIBUTE_NAMES,
  REDACTED_ATTRIBUTE_NAMES,
} from "./trace-model.js";

export type {
  TraceWriter,
  TraceReader,
  RetrievedSpan,
  QueryResult,
  CandidateProvider,
  ProviderCapabilities,
} from "./provider.js";
export {
  NO_CAPABILITIES,
  registerProvider,
  listProviders,
  getProvider,
} from "./provider.js";

export {
  generateCorpus,
  generateCorpusWithManifest,
  serializeCorpus,
} from "./dataset/generate.js";
export { sendCorpus, sendToAll } from "./dataset/send.js";
export type { SendResult } from "./dataset/send.js";
export { verifyParity } from "./dataset/verify-parity.js";
export type { ParityVerdict } from "./dataset/verify-parity.js";

export {
  hardGatesPassed,
  checkRedaction,
  DEFAULT_WEIGHTS,
  REQUIRED_ATTRIBUTES,
  FORBIDDEN_ATTRIBUTES,
} from "./rubric.js";
export type {
  HardGates,
  CompletenessResult,
  FreshnessResult,
  LatencyResult,
  ExportResult,
  FidelityResult,
  EvidenceCorrelationResult,
  ProviderScore,
  RubricWeights,
} from "./rubric.js";

export { runBenchmark, renderMarkdown } from "./report.js";
export type { BenchmarkResult, BenchmarkOptions } from "./report.js";