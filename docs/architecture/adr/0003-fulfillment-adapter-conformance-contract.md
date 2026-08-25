# ADR 0003: FulfillmentAdapter Conformance Contract

**Status**: Accepted
**Date**: 2026-08-25

## Context

Opnory Governance Engine executes access fulfillment across multiple identity providers (Microsoft Entra ID, Okta, GitHub, SCIM). The engine's core policy logic must remain provider-agnostic. ADR 0002 extracted the governance domain model (SubjectRef, RoleAssignment, Permission, ResourceScope) from Foursquare RBAC patterns. This ADR codifies the **contract** that all fulfillment adapters must satisfy so the governance engine can rely on consistent behavior regardless of provider.

The contract was proven by live Model B certification against Microsoft Entra ID (tag `entra-model-b-certified-2026-08-24`), then re-proven through the generic `FulfillmentAdapter` abstraction (tag `entra-adapter-contract-proven-2026-08-25`).

## Contract Guarantees

Every `FulfillmentAdapter` implementation MUST satisfy these invariants:

### 1. `grant` is idempotent
- Calling `grant` twice with the same assignment + permission produces the same result
- Second call returns `status: "succeeded", mutated: false` (desired state already present)
- Never throws on "already exists" conditions

### 2. `revoke` is idempotent
- Calling `revoke` twice with the same assignment + permission produces the same result
- Second call returns `status: "succeeded", mutated: false` (desired state already absent)
- Never throws on "already removed" conditions (e.g., Graph DELETE 404)

### 3. `verify` addresses exactly one subject + entitlement
- Returns `VerificationResult { status: "verified" | "not-found" | "failed" }`
- Does not aggregate or batch; single subject, single entitlement
- `providerObjectId` identifies the provider resource that was checked (group, app, etc.)

### 4. Successful desired state ≠ mutation
- `FulfillmentResult.mutated: boolean` is explicit
- `mutated: true` = provider state actually changed
- `mutated: false` = provider state already matched desired state
- Callers must not conflate success with mutation

### 5. Provider identifiers are confined to provider mappings and adapter state
- Policy decisions operate on Opnory entitlement/permission identifiers (`Permission.id`, `RoleAssignment.roleId`)
- `Permission.mappings[].value` carries provider-specific identifiers (Entra group ID, Okta group ID, GitHub team slug)
- Adapter internal state may hold provider IDs; they never leak into domain objects

### 6. Partial/provider errors fail closed
- Network errors, 4xx/5xx not representing "already exists/absent" → `status: "failed"`
- Adapter classifies provider errors; unknown errors are failures, not successes
- `FulfillmentResult.error` carries actionable detail for debugging

### 7. Certification must restore the original sandbox state
- Live certification against a provider MUST leave zero residue
- All grants verified, then revoked, then re-verified absent
- Final state = initial state (verified by certification harness)

### 8. Provider-specific behavior must not leak into policy decisions
- No Graph API quirks, Okta API pagination, GitHub team hierarchy in policy code
- All provider eccentricities absorbed by the adapter
- Certification harness tests the contract, not provider features

### 9. Eventual consistency is explicitly handled and never interpreted as immediate failure
- Provider convergence delays (Graph replication, Okta async) are acknowledged
- Convergence handling lives in the orchestration/reconciler layer (or shared utility)
- `verify()` remains a clean state observation; callers decide wait/retry policy

## Contract Surface

```typescript
interface FulfillmentAdapter {
  readonly provider: string;

  resolveSubject(subject: SubjectRef): Promise<ResolvedSubject>;
  grant(assignment: RoleAssignment, permission: Permission, scope: ResourceScope, resolvedSubject: ResolvedSubject): Promise<FulfillmentResult>;
  verify(assignment: RoleAssignment, permission: Permission, scope: ResourceScope, resolvedSubject: ResolvedSubject): Promise<VerificationResult>;
  revoke(assignment: RoleAssignment, permission: Permission, scope: ResourceScope, resolvedSubject: ResolvedSubject): Promise<FulfillmentResult>;
}

interface FulfillmentResult {
  status: "succeeded" | "failed";
  mutated: boolean;
  provider: string;
  providerObjectId?: string;
  error?: string;
  correlationId: string;
}

interface VerificationResult {
  status: "verified" | "not-found" | "failed";
  provider: string;
  providerObjectId?: string;
  error?: string;
  correlationId: string;
}
```

## Conformance Harness

The contract is validated by a provider-agnostic harness:

```typescript
await runFulfillmentAdapterCertification({
  provider: "entra" | "okta" | "github" | ...,
  adapter: FulfillmentAdapter,
  subject: SubjectRef,
  permissions: Permission[],      // each carries its own provider mappings
  evidenceProbe?: CertificationEvidenceProbe, // optional, provider-specific
});
```

The harness executes the same lifecycle for every permission:
1. Resolve subject
2. Verify absent (precondition)
3. Grant → verify present
4. Grant again → verify present + idempotent semantics (`mutated: false`)
5. Revoke → verify absent
6. Revoke again → verify absent + idempotent semantics (`mutated: false`)
7. Confirm clean final state

## Acceptance Criterion for New Providers

**The unchanged conformance harness passes against the new provider.**

This is stronger than "API calls work." It proves:
- Same domain objects flow through
- Same lifecycle executes
- Same evidence model captures results
- Same result semantics hold
- Only the adapter implementation differs

If a new provider forces a contract change, classify the difference:

| Difference Type | Resolution |
|-----------------|------------|
| Provider implementation detail | Absorb in adapter |
| Missing governance-domain concept | Evolve `governance-core` domain/contract (architectural event) |

## Evidence

- `entra-model-b-certified-2026-08-24` — Model B live certification (7 phases, direct Graph calls)
- `entra-adapter-contract-proven-2026-08-25` — Same 22 checks through `FulfillmentAdapter`
- `scripts/live-governance/model-b/certify-via-adapter.ts` — Adapter certification script
- `packages/governance-core/src/adapters/entra-adapter.ts` — EntraAdapter implementation
- `packages/governance-core/src/adapters/fulfillment.ts` — Contract + Zod schemas

## Consequences

- New providers implement only `FulfillmentAdapter` — no governance-core changes for provider quirks
- Policy/approval/reconciliation logic stays pure; only adapters touch provider APIs
- Certification becomes a conformance gate, not a per-provider bespoke script
- OktaAdapter, GitHubAdapter, SCIMAdapter can be added with high confidence