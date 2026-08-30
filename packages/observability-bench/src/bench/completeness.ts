// packages/observability-bench/src/bench/completeness.ts
// Completeness probe: can the read API reconstruct the full governance story?
// request → policy → fulfillment → verification → evidence + all attributes.

import type { CandidateProvider, RetrievedSpan } from "../provider.js";
import type { CompletenessResult } from "../rubric.js";
import { OPONORY_ATTRIBUTE_NAMES } from "../trace-model.js";

export interface CompletenessInput {
  /** a correlation id from the corpus (governance lookup anchor) */
  correlationId: string;
  /** expected span names for this workflow */
  expectedSpans: string[];
}

export async function probeCompleteness(
  provider: CandidateProvider,
  input: CompletenessInput,
): Promise<CompletenessResult> {
  const result = await provider.reader.governanceLookup({ correlationId: input.correlationId });

  const spans = result.rows.filter(isSpanRow) as RetrievedSpan[];
  const returnedNames = new Set(spans.map((s) => s.name));

  // Attribute coverage across all returned spans
  const attributeDetail: Record<string, boolean> = {};
  for (const attrName of OPONORY_ATTRIBUTE_NAMES) {
    attributeDetail[attrName] = spans.some((s) => attrName in s.attributes);
  }
  const attributeCoverage =
    OPONORY_ATTRIBUTE_NAMES.filter((a) => attributeDetail[a]).length / OPONORY_ATTRIBUTE_NAMES.length;

  // Span tree intact: root has null parent, others have non-null parent that
  // resolves to a present span.
  const spanIds = new Set(spans.map((s) => s.spanId));
  const spanTreeIntact = spans.every((s) =>
    s.parentSpanId === null ? true : spanIds.has(s.parentSpanId),
  );

  // Missing spans (expected but not returned)
  const missingSpans = input.expectedSpans.filter((n) => !returnedNames.has(n));

  return {
    attributeCoverage,
    attributeDetail,
    spanTreeIntact,
    missingSpans,
  };
}

function isSpanRow(row: RetrievedSpan | Record<string, unknown>): row is RetrievedSpan {
  return typeof (row as RetrievedSpan).spanId === "string";
}