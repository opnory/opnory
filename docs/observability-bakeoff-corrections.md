# Observability backend bake-off — evidence corrections

This file is the living, dated record of capability conclusions that were
superseded by later evidence. It exists so the original ADRs keep their
point-in-time accuracy while the current understanding stays explicit.

## 2026-09-02 — Jaeger attribute filtering: capability correction

**Original local benchmark (ADR 0007):** Jaeger attribute filtering was declared
unsupported by the then-current adapter and was not proven. The ADR 0007
live-run findings table recorded Jaeger as
`attributeFiltering → unsupported on the JSON query path`.

**Phase 7 lifecycle bake-off:** native Jaeger tag filtering over
`opnory.tenant_hash` was subsequently proven against real Opnory spans; the
adapter was corrected accordingly (commit `f1743d8`).

What changed, precisely:

- Before: `JaegerReader.filteredScan` returned `unsupported`; the provider
  declared `attributeFiltering: false`.
- After: `filteredScan` implements server-side tag **equality** filtering via
  `GET /api/traces?service=opnory&tag=opnory.tenant_hash:<h>&tag=opnory.provider:<p>&tag=opnory.actual_state:<s>[&start=&end=]`
  and the provider declares `attributeFiltering: true`.

The scope of the corrected claim is deliberately narrow:

- **Equality only.** Jaeger's JSON query service supports `tag=key:value`
  equality with implicit conjunction. It does **not** support range (`>=`),
  regex, or negation operators, and the corrected capability claim does not
  assert any of those.
- **No OTel "resource" scoping.** Jaeger flattens all attributes to span tags;
  there is no distinct resource-attribute query dimension.
- **Time window supported** via `start`/`end` in microseconds (native, verified).

**What this correction does NOT imply:**

- The earlier run did not retroactively exercise code it never exercised. The
  ADR 0007 benchmark genuinely did not prove attribute filtering for Jaeger;
  its recorded "unsupported" was honest at the time.
- The strongest conclusion the new evidence supports is simpler than any
  synthetic-corpus explanation: **the earlier benchmark under-characterized
  Jaeger's native capability.** No claim is made that the synthetic corpus
  "carried attributes differently" — that was not inspected or proven.

## Scope and status

This document is **vendor/documentation + local-runtime evidence**, not a
production-backend selection. Hosted candidates must still prove the exact
Phase 7 corpus reconstruction, tenant isolation, redaction, structural
reproducibility, and failure-taxonomy fidelity before ADR 0009 (the selection
decision) is written.