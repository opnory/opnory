# ADR 0008: Lifecycle Observability Contract

**Status:** Accepted
**Date:** 2026-09-02
**Authors:** Opnory Observability / Platform

## Context

Phase 6 froze the production tenant-integration lifecycle (ADR 0006): persistent
desired state, a credential control plane (`SecretStore` / `EncryptedPgSecretStore`),
health/reconciliation, install/uninstall, and a distinct `credential_backend_unavailable`
failure taxonomy. What it did not freeze is how an operator *reads back* operational
truth about that lifecycle.

ADR 0007 froze the benchmark methodology for judging observability backends. This ADR
closes the gap between those two: it instruments the real Phase 6 lifecycle with OTel
spans and proves, against a live backend, that operational state can be reconstructed
**without inspecting in-memory or durable state**.

The proof is `packages/integration-runtime/test/lifecycle-tempo-reconstruction.test.ts`,
gated on `OPNORY_OTEL_TRACES_ENABLED=1` + a reachable Tempo. It drives four real
lifecycle scenarios through the actual `IntegrationInstallerImpl` /
`IntegrationUninstallerImpl` / reconciliation worker, then answers every operator
question from Tempo's read API alone.

## Decision

### 1. One trace per lifecycle operation

`LifecycleSpan` (in `packages/observability/src/lifecycle-traces.ts`) emits one trace
per operation, phases child-spanned under the root:

```
integration.install
  integration.configure
  integration.validate
    credential.resolve
  integration.health_check
  plugin.activate
  capability.register
integration.degrade              (failure path, carries opnory.failure_code)
integration.recover             (DEGRADED → ACTIVE)
integration.uninstall
  plugin.dispose
  capability.unregister
  integration.uninstall_confirm  (carries opnory.verified)
reconciliation.run
```

Trace IDs are 32-hex, span IDs 16-hex (OTel-canonical). Emission is a single
dependency-free OTLP/HTTP POST (`otel.ts`), gated on `OPNORY_OTEL_TRACES_ENABLED=1`.
There is no OTel SDK dependency and no ambient production trace noise when the flag
is unset.

### 2. Frozen attribute contract

The minimum set an operator can rely on, emitted on the root span and available for
native filtering:

```
opnory.tenant_hash        SHA-256 hash of the tenant id (never the raw id)
opnory.integration_id     Opnory-internal identifier
opnory.plugin_id
opnory.provider
opnory.operation
opnory.desired_state
opnory.actual_state
opnory.config_version
opnory.failure_code       (only on degrade paths)
opnory.reconciliation_attempt
opnory.mutated
opnory.verified
opnory.credential_ref_hash (one-way hash; raw credentialRef is forbidden)
```

### 3. Redaction rules

- Raw tenant ids are never emitted; only `opnory.tenant_hash`.
- Raw `credentialRef`, secret material, tokens, request payloads, and provider object
  IDs are dropped before emission (defense in depth in `cleanAttrs`), and the
  adversarial test scans every emitted span for a planted sentinel.
- Durable governance/business events remain the authoritative record; OTel is
  operational reconstruction, **not** a replacement event log.

### 4. Reconstruction methodology

The proof answers, for a given tenant + integration, entirely from Tempo's read API
(TraceQL `/api/search` → per-trace `/api/traces/{traceID}` detail): which operation
ran; desired vs observed state; whether credential resolution succeeded; whether the
provider was health-reachable; whether activation completed; whether capabilities
registered; the deterministic failure code on degrade; whether a later reconciliation
recovered; whether uninstall was verified complete.

### 5. Hard gates

| Gate | Rule | Consequence |
|---|---|---|
| Tenant isolation | a tenant-A query returning tenant-B spans | hard fail |
| Redaction | sentinel secret or raw tenant id in any span | hard fail |
| Structural reproducibility | same span set / names / taxonomy / gate outcomes across runs | timing may vary, structure may not |

## Live-run findings

- **Two structurally-identical runs**: 74 assertions each, 5/5 scenarios pass, zero
  flake in span names / taxonomy / isolation / redaction. Timing varied (scenario 1
  in 1.0s vs 7.7s); structure did not.
- **Failure taxonomy fidelity**: `classifyError` now recognizes the structured
  `SecretStoreError(code = "backend_unavailable")` and maps it to
  `credential_backend_unavailable` *before* string heuristics (committed as `fix`,
  see below). The proof asserts `credential_backend_unavailable` is present and
  `provider_unreachable` is absent on a real secret-backend outage.
- **Tempo write→TraceQL visibility latency ≈ 7s locally.** The span is emitted (HTTP
  200) but not searchable by attribute until the ingester flushes its block. This is
  the `trace_idle_period` flush cycle; tightening it 10s→2s brought visibility within
  the proof's poll window. It is a characteristic of the local single-binary
  deployment, **not** a production prediction.

### What this does NOT claim

- It does **not** select Tempo as the production backend (ADR 0007's parity/capability
  bake-off is still pending, and Phoenix remains disqualified on tenant isolation).
- It does **not** make telemetry authoritative over durable business state.
- It does **not** turn a ~7s local flush latency into a hosted-production number.

## Consequences

- The Phase 6 + 7 baseline is stable under the real-PG gate: 342 tests pass with
  `OPNORY_RUN_PG_INTEGRATION_TESTS=1`.
- Lifecycle observability is reconstructable end-to-end from a native read API with
  tenant isolation and redaction holding.
- The span set and attribute contract are now frozen; any change is an architectural
  change requiring re-proof, not a cosmetic one.

## Next steps

1. Replay the real lifecycle corpus into Jaeger and any hosted Tempo candidates and
   make the production-backend decision from operational evidence (ADR 0007 rules).
2. Fix the Phoenix tenant-isolation failure or document its permanent exclusion.