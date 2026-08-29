# J-Space Workspace Ledger

## Goal
Phase 3: ADR 0004 + capability runtime spike — provider-neutral capability contracts, registry, lifecycle semantics; load Entra/Okta through runtime without changing FulfillmentAdapter; run unchanged conformance harness against runtime-loaded adapters.

## Core
- certified-core — FulfillmentAdapter contract and generic conformance semantics are frozen; static enforcement must adapt around them.
- phase-boundary — plugin-runtime work begins only after the static-governance baseline is committed and tagged.

## Verified
- ✓01 no-model-authorization-decision rule flags adapter imports in policy layer — verified by: oxlint test run on fixture covering the import case

## Open

## Next
Create ADR 0004 document and scaffold packages/integration-runtime with capability contracts, registry, and thin runtime spike.
