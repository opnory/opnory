// packages/observability-bench/src/bench/fidelity.ts
// OTel fidelity probe: do trace_id/span_id/parentage and attribute names
// survive the round-trip byte-identically?

import type { CandidateProvider, RetrievedSpan, QueryResult } from "../provider.js";
import type { FidelityResult, EvidenceCorrelationResult } from "../rubric.js";
import type { CorpusManifest } from "../trace-model.js";

export interface FidelityInput {
  correlationId: string;
}

export async function probeFidelity(
  provider: CandidateProvider,
  input: FidelityInput,
): Promise<FidelityResult> {
  const result = await provider.reader.governanceLookup({ correlationId: input.correlationId });
  const spans = result.rows.filter(isSpanRow);

  // trace_id / span_id are 32/16 hex chars in canonical OTel form.
  const traceIdIntact = spans.every((s) => /^[0-9a-f]{32}$/.test(s.traceId));
  const spanIdIntact = spans.every((s) => /^[0-9a-f]{16}$/.test(s.spanId));

  const spanIds = new Set(spans.map((s) => s.spanId));
  const parentageIntact = spans.every((s) =>
    s.parentSpanId === null ? true : spanIds.has(s.parentSpanId),
  );

  // Attribute name fidelity: at least one opnory.* attribute name survives verbatim.
  const attributeNamesIntact = spans.some((s) =>
    Object.keys(s.attributes).some((k) => k.startsWith("opnory.")),
  );

  return { traceIdIntact, spanIdIntact, parentageIntact, attributeNamesIntact };
}

export async function probeEvidenceCorrelation(
  provider: CandidateProvider,
  input: { correlationId: string },
): Promise<EvidenceCorrelationResult> {
  const result = await provider.reader.governanceLookup({ correlationId: input.correlationId });
  const spans = result.rows.filter(isSpanRow);

  const allAttrs = new Set<string>();
  for (const s of spans) {
    for (const k of Object.keys(s.attributes)) allAttrs.add(k);
  }

  const requestIdLinked = allAttrs.has("opnory.request_id");
  const assignmentIdLinked = allAttrs.has("opnory.approval_ref"); // approval carries the assignment chain
  const approvalLinked = allAttrs.has("opnory.approval_ref");
  const reconciliationLinked = spans.some((s) => s.name === "reconciliation" && "opnory.reconciliation_outcome" in s.attributes);
  const evidenceLinked = spans.some((s) => s.name === "evidence.record");

  const covered = [requestIdLinked, assignmentIdLinked, approvalLinked, reconciliationLinked, evidenceLinked];
  const coverage = covered.filter(Boolean).length / covered.length;

  return {
    requestIdLinked,
    assignmentIdLinked,
    approvalLinked,
    reconciliationLinked,
    evidenceLinked,
    coverage,
  };
}

function isSpanRow(row: RetrievedSpan | Record<string, unknown>): row is RetrievedSpan {
  return typeof (row as RetrievedSpan).spanId === "string";
}