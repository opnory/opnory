# Grafana Cloud Traces — HOSTED LIVE lifecycle observability proof

**Evidence state:** `HOSTED LIVE`
**Date:** 2026-09-07
**Method:** unchanged Phase 7 lifecycle corpus replayed through the real
`IntegrationInstallerImpl` / `IntegrationUninstallerImpl` drivers (frozen span set +
attribute contract, commit `f34209a` emitter), read back exclusively through the
hosted Tempo read API (read-scoped credential only). No Grafana UI. No client-side
reconstruction presented as native capability. No credential values in this artifact.

```
Corpus parity:             PASS (run 1) / PASS (run 2)
Lifecycle reconstruction:  PASS (run 1) / PASS (run 2)
Tenant isolation:          PASS (run 1) / PASS (run 2)
Redaction:                 PASS (run 1) / PASS (run 2)
Failure taxonomy:          PASS (run 1) / PASS (run 2)
Structural reproducibility: PASS
```

## Hard-gate detail (both runs identical)

| Scenario | Result | Evidence |
|---|---|---|
| 1 — clean install | PASS | all 7 frozen spans (`integration.install`, `integration.configure`, `integration.validate`, `credential.resolve`, `integration.health_check`, `plugin.activate`, `capability.register`) reconstructed from hosted reads |
| 2 — credential outage | PASS | `opnory.failure_code = credential_backend_unavailable` present; `provider_unreachable` absent |
| 3 — recovery | PASS | `integration.degrade` → `plugin.activate` (DEGRADED → ACTIVE) |
| 4 — uninstall | PASS | `plugin.dispose` + `capability.unregister` + `integration.uninstall_confirm` (`opnory.verified=true`, `actual_state=inactive`) |
| 5 — tenant isolation | PASS | tenant-A predicate returned 7 tenant-A spans, zero cross-tenant leak; negative control (`ffffffffffffffff`) returned 0 |

## Redaction hard gate

Retrieved-trace payloads were scanned for: raw tenant ids, the planted sentinel
(`OPNORY_SENTINEL_LIFECYCLE_PROOF_7f3a9c2e`), the write/read tokens, both instance
ids, the Basic-auth base64, `Authorization`/`Bearer`/`Basic` headers, `glc_` token
prefixes, and raw `credentialRef` strings. **Result: CLEAN.**

The only `credential_*` attribute present is `opnory.credential_ref_hash` — the
one-way SHA-256 hash required by the frozen contract (ADR 0008); the raw
`credentialRef` never appears.

## Timing (separated, per methodology)

Write→queryable visibility:
  run 1: 26.5 s
  run 2: 27.8 s

Query execution latency (measured separately, after traces were queryable):
  p50 ≈ 36 ms, min ≈ 31 ms, max ≈ 99 ms (search round-trip)

## Observed operational constraints (recorded, not inferred)

- Hosted `/api/search` returns matched **traceIDs** and matched span attributes only;
  span **names and the full attribute set are absent** from the search response's
  `spanSets`. Full reconstruction requires the two-step search→detail flow
  (`/api/search` → `/api/traces/{traceID}`), which the ADR 0008 methodology already
  specifies.
- `/api/traces/{traceID}` on the hosted surface returns `200` with the complete
  named span tree and all frozen attributes. Span IDs are base64-encoded on the
  detail path (hex on the search path) — ID normalization, not emulation.
- No throttling (429), pagination limits, or API errors were encountered during the
  two runs.

## Scope / non-claims

- This leg proves **hosted lifecycle observability** for Grafana Cloud Traces. It
  does **not** select a backend (ADR 0009 is untouched) and does **not** rank
  Grafana against Honeycomb.
- Honeycomb still requires its own `HOSTED LIVE` leg before any selection.
- Write→queryable visibility (~27 s) is an observation on this hosted tier, not a
  corpus-wide characterization beyond the two recorded runs.