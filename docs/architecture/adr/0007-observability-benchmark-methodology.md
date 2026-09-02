# ADR 0007: Observability Benchmark Methodology

**Status:** Accepted
**Date:** 2026-08-30
**Authors:** Opnory Observability / Platform

## Context

Opnory's value depends on its ability to *read back* operational truth through telemetry: request → policy → fulfillment → verification → evidence. A dashboard is not observability; a usable query-and-export surface is. Before selecting a production observability backend, we must know what real retrieval looks like at the read API, not at the write path.

The `packages/observability-bench` package proves that methodology with a deterministic seeded corpus replayed across three local backends (Jaeger, Tempo, Phoenix). Its live run produced evidence about each backend's native primitives, not its documentation.

**Proven evidence references (from the live run):**
- `packages/observability-bench/results/evidence.json` (committed fixture-derived run)
- Local Docker compose baseline: `docker compose -f docker/compose.yml up -d`
- Tag: `observability-benchmark-local-proven-2026-08-30`

This ADR freezes those methodology decisions. Instrumentation, production backend selection, and any SaaS bake-off are **out of scope** here.

## Decision

The benchmark methodology rests on these frozen rules. Any future benchmark extension must preserve them.

### 1. Corpus is deterministic and replayed identically

- Generated once from a fixed `seed` + `anchorEpochMs` + tenant list.
- Serialized OTLP bytes are byte-identical for every backend (no SDK differences permitted to leak into the comparison).
- The manifest records span counts, trace counts, tenant coverage, span-name histograms, per-name duration sums, serialized byte count, and SHA-256.

### 2. Parity gate comes first and is mechanism-agnostic

- Parity asks: *can the backend prove the corpus is retrievable through ANY declared native read primitive* — not "does it implement full export".
- The parity mechanism is `findTrace(traceId)` enumeration over the manifest's known trace IDs. This keeps parity honest for trace-centric backends that cannot bulk-export.
- Performance scores or weighted scores are **never computed** for a backend until parity PASSes. This rule protects against latency numbers becoming meaningless without equivalent data.
- A parity FAIL is a structural failure of the backend to store and retrieve the corpus — not a performance shortfall.

### 3. Capability probes are declared, never emulated

Each backend's `ProviderCapabilities` is the truth about its read-API surface:

| Capability | Meaning |
|---|---|
| `traceLookup` | fetch a trace by ID |
| `attributeFiltering` | server-side span filtering |
| `aggregation` | server-side aggregation over spans |
| `fullExport` | a governed, server-side bulk export of corpus rows |
| `pagination` | governed pagination (cursor/pages) on read |
| `correlationLookup` | find spans by a correlation/session key |

If the backend cannot perform a probe **natively**, it reports `unsupported`. Client-side fanning or post-processing is never used to "score" capability that the backend does not expose.

### 4. Hard gates are binary and disqualifying

| Gate | Rule | Effect of FAIL |
|---|---|---|
| Parity | corpus retrieval proven via known traces | no scores at all |
| Tenant isolation | a filtered scan returned cross-tenant spans | backend disqualified |
| Redaction | a forbidden attribute appeared in plaintext | backend disqualified |

A clean parity via `findTrace` with `supportedCapabilities` untouched by the fake-emulation rule is not a failure. It is evidence.

### 5. Freshness and latency are separate measurements

- **Freshness** measures write→readable lag with a fresh corpus trace, polled on a fixed interval until appearance. p50/p95 collected from real samples, not a single observation.
- **Query latency** measures the server-side filtered scan (`filteredScan`) or aggregation probe: warmup 5 runs, measured 30 runs, p50/p95/p99, error rate, 429 rate, response bytes. Query time (excluding pacing) and wall time (including pacing) are both recorded because some vendors pace rate-limited APIs.

### 6. Evidence is the only authority

- The benchmark produces **JSON** evidence (raw). Markdown is rendered from that JSON; never editable.
- Nothing in the report draws from vendor docs, assumptions, or "generally known" behavior.
- Rerun structure is stable: identical corpus SHA-256, identical counts, identical capability categories, identical gate outcomes across runs. Timing varies; structure may not.

## Live-run findings (what the backends actually did)

These are the observed behaviors from the proven live run. They stand as the baseline evidence for the benchmark.

| Backend | Parity (55/55 spans) | Isolation | Redaction | Notable limitations / dimensions |
|---|---|---|---|---|
| **Jaeger** | PASS via find_trace | PASS (full_corpus_enumeration) | PASS | aggregation/fullExport/pagination/correlationLookup all `unsupported` (by design; no server-side aggregation/export primitives); attributeFiltering also `unsupported` on the JSON query path |
| **Tempo** | PASS via find_trace | PASS (filtered_scan via TraceQL) | PASS | fullExport is `unsupported` — the TraceQL search returns only *matched* spans, not the full corpus; `start`/`end` nano-epoch params overflow in 2.5.0 (time-windowed variants omitted) |
| **Phoenix** | PASS via find_trace | **FAIL** (tenant isolation failed: fullExport returned cross-tenant rows) | PASS | `attributeFiltering` is documented but **silently ignored** in practice; returns all spans regardless of `filter=key:value`; `correlationLookup` consequently unavailable for the same reason; fullExport is cursor-based but not tenant-scoped |

All counts are observed spans vs. expected 55 from the manifest. The benchmark corpus used fixture `sha256 ce9cde15…`.

## Consequences

### Positive

- The benchmark methodology is self-verifying: parity is not optional.
- Each provider's strengths and limits are recorded from evidence, not docs.
- Unsupported capabilities are visible gaps, not invisible emulation.
- Production selection is constrained to backends that prove themselves under real retrieval semantics.

### Negative

- Jaeger and Tempo cannot complete the full weighted score on this corpus; they remain qualifying baselines only where their native primitives exist.
- Phoenix cannot qualify at all for tenant-isolated workloads under this run (hard-gate FAIL), regardless of any features.

### Neutral

- Time-based metrics (freshness p50/p95, query p50/p99) are recorded but do not predetermine selection while gates are open.
- Future benchmarks (e.g., `OpnoryScenarioGenerator` emitting from real Phase 6 lifecycle telemetry) can extend this without weakening the same rules.

## Next steps after this freeze

1. Instrument the real Opnory lifecycle with OTel, using the actual spans already modeled in the benchmark's corpus (`integration.install`, `credential.resolve`, `capability.register`, `reconciliation`, etc.).
2. Run the same corpus generation and parity/probe workflow against the real Opnory telemetry on a chosen backend.
3. Only then doing a self-hosted/SaaS bake-off is meaningful.