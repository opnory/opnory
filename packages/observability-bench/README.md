# @opnory/observability-bench

An **independent evaluation package** for Opnory observability backends.

This package does not depend on Opnory production runtime code. It proves the
**methodology first, against local open-source backends**, before any SaaS vendor
or production telemetry is involved.

## The benchmark rule (non-negotiable)

> **No provider receives a performance score until corpus parity is proven.
> No capability is credited unless it is demonstrated through the provider's
> read API.**

Every claim in the report maps to captured API output. The Markdown comparison
is rendered from raw JSON evidence and is never the source of truth.

## Layers

```
synthetic corpus
      ↓
OTLP replay  (same serialized bytes to every backend)
      ↓
backend adapter  (read-oriented, no send() on the read surface)
      ↓
read/query benchmark
      ↓
evidence report  (JSON, then Markdown derived from it)
```

## Package shape

```
src/
├── trace-model.ts      # span taxonomy + attributes + redaction set (the retrieval contract)
├── provider.ts         # TraceWriter (write) / TraceReader (read) interfaces + registry
├── rubric.ts           # hard gates (parity, isolation, redaction) + weighted scores
├── report.ts           # benchmark runner + Markdown renderer
├── cli.ts              # entrypoint: `generate` (corpus) and `bench`
├── dataset/
│   ├── generate.ts     # deterministic seeded corpus (bagSplitMix64 PRNG)
│   ├── send.ts         # replay corpus to all providers
│   └── verify-parity.ts# parity gate: block timing until corpus is retrievable
└── bench/
    ├── stats.ts        # p50/p95/p99/min/max
    ├── completeness.ts # governance-story reconstruction
    ├── isolation.ts    # tenant isolation hard gate
    ├── freshness.ts    # write→readable lag
    ├── query.ts        # filtered scan + full export latency
    └── fidelity.ts     # trace/span id + parentage + attribute fidelity
```

## Hard gates (binary, disqualify on fail)

| Gate | What fails it |
|------|---------------|
| **Parity** | Backend cannot return ~the full corpus (span count within 1% of manifest) |
| **Tenant isolation** | Tenant A's filtered scan ever returns a Tenant B row |
| **Redaction** | Any restricted attribute (`opnory.secret`, `opnory.access_token`, …) round-trips in plaintext |

## Weighted scores (evidence-only, when hard gates pass)

completeness 20 · query flexibility 20 · DX/error 10 · auth 8 · latency 8 ·
pagination 8 · export 8 · freshness 8 · OTel fidelity 5 · evidence correlation 5

## Methodology invariants

1. **Deterministic corpus.** Fixed seed + fixed timestamp anchor, recorded in a
   manifest with counts, bounds, and a SHA-256 of the canonical serialized payload.
2. **Byte-identical replay.** The same serialized OTLP bytes go to every backend;
   ingestion happens through the common replay layer, never a per-vendor SDK.
3. **Parity before timing.** No latency number is published for a provider whose
   corpus is incomplete.
4. **Two clocks.** Query execution time (excludes pacing) is reported separately
   from wall time (includes rate-limit pacing/retries), so vendor rate limits are
   never conflated with query-engine latency.
5. **Unsupported ≠ emulated.** If a backend lacks a query primitive, report
   `unsupported`; do not emulate it client-side and call it server-side performance.
6. **No secrets, no real content.** The corpus uses neutral synthetic attributes.
   No tokens, JWTs, OAuth assertions, raw credential material, or real user/request
   content. LLM prompt/response appears as hashes/summaries only.

## Freshness measurement

`OTLP accepted → first successful read`, polled until appearance, reporting
`p50 / p95 / timeout percentage` across samples — not a single observation.

## Running

```bash
# generate a deterministic corpus + manifest
bun run generate -- --seed 12345 --anchor 1725000000000 --traces 100

# run the full benchmark against registered providers
bun run bench
```

## Local baseline

Backends (Jaeger, Tempo, Phoenix) run behind Docker Compose; the harness itself
is backend-neutral and talks only to the provider read APIs.

```bash
docker compose -f docker/compose.yml up -d
```

## Milestone 1 acceptance criteria

- [x] deterministic synthetic corpus generated once
- [ ] exact OTLP fixture committed/vendored
- [ ] local collector starts with one command
- [ ] Jaeger adapter works
- [ ] Tempo adapter works
- [ ] Phoenix adapter works
- [x] parity gate implemented
- [x] trace completeness test implemented
- [x] filtered-query benchmark implemented
- [x] freshness benchmark implemented
- [x] full-export benchmark implemented
- [ ] raw JSON evidence emitted
- [ ] Markdown comparison generated from evidence
- [x] zero SaaS credentials required
- [x] zero dependency on Opnory production runtime