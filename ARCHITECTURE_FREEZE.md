# Architecture Freeze: FulfillmentAdapter Contract vs Conformance Harness

This document establishes the architectural freeze on two distinct but related components in the governance core. Both are frozen at the dual-provider certification baseline (tag `fulfillment-adapter-dual-provider-proven-2026-08-26`, commit `044a75a`).

## Frozen Components

### 1. FulfillmentAdapter Contract (`packages/governance-core/src/adapters/fulfillment.ts`)

**What it is**: The provider-agnostic interface that all fulfillment adapters must implement. It defines the contract between the governance engine and provider-specific fulfillment logic.

**Contents**:
- `FulfillmentAdapter` interface (the contract)
- `FulfillmentResult`, `VerificationResult`, `ResolvedSubject` types
- `SubjectRef`, `RoleAssignment`, `Permission`, `ResourceScope` types
- `fulfilledAfterVerification` / `failedFulfillment` factory functions
- `FulfillmentMutation` type ("performed" | "already-desired")

**Freeze semantics**: No semantic changes to the interface, types, or factory behaviors. The contract is proven by live certification against Entra and Okta Model B.

**Review rule**: Any change requires explicit architectural review. Changes must not break conformance harness expectations or certified adapter implementations.

---

### 2. Conformance Harness (`packages/governance-core/src/adapters/conformance.ts`)

**What it is**: The generic certification test harness that proves a `FulfillmentAdapter` implementation satisfies the contract. It is the *verification mechanism*, not the contract itself.

**Contents**:
- `runFulfillmentAdapterCertification` function
- Fixture definitions (shared across providers)
- Evidence collection and reporting
- Grant/verify/revoke/idempotent check orchestration

**Freeze semantics**: No changes to the harness logic, fixture structure, or evidence schema. The harness produces the live evidence artifacts (`.live-results/`) that certify both providers.

**Review rule**: Any change requires re-certification of both providers. Harness changes must not alter the definition of what "passing" means.

---

## Frozen Provider Adapters (Implementation Layer)

These are the *proven implementations* of the contract, certified by the harness:

| Adapter | File | Certification |
|---------|------|---------------|
| Entra | `packages/governance-core/src/adapters/entra-adapter.ts` | 5/5 fixtures, 30/30 checks |
| Okta | `packages/governance-core/src/adapters/okta-adapter.ts` | 3/3 fixtures, 24/24 checks |

**Freeze semantics**: No semantic changes. Bug fixes allowed only if they don't alter certified behavior. Any change triggers re-certification.

---

## Review Rules

### For FulfillmentAdapter Contract Changes
1. Propose change with rationale
2. Run full conformance harness against both providers
3. Evidence must show 5/5 Entra + 3/3 Okta fixtures still pass
4. Architectural review sign-off required
5. New certification tag created

### For Conformance Harness Changes
1. Propose change with rationale
2. Run full conformance harness against both providers
3. Evidence must show 5/5 Entra + 3/3 Okta fixtures still pass
4. Architectural review sign-off required
5. New certification tag created

### For Provider Adapter Changes
1. Propose change with rationale
2. Run conformance harness for that provider
4. Evidence must show all fixtures still pass
5. Architectural review sign-off required
6. New certification tag created (provider-specific or dual)

---

## Enforcement

- **Lint rules**: `opnory/no-unchecked-fulfillment-success` and `opnory/require-authoritative-result-construction` enforce factory usage (warn on frozen adapters, error elsewhere)
- **CI gate**: Certification scripts must pass on PRs that touch frozen files
- **Documentation**: This file is the authority for what is frozen and how to change it