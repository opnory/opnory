# ADR 0004: Capability Runtime Spike — Provider-Neutral Extensibility Without Governance Mutation

**Status**: Proposed (Spike Phase)
**Date**: 2026-08-28

## Context

Opnory has achieved two milestones:

1. **Dual-provider live proof** (`fulfillment-adapter-dual-provider-proven-2026-08-26`): Entra and Okta Model B certified via the `FulfillmentAdapter` contract and conformance harness.
2. **Static governance enforcement baseline** (`static-governance-baseline-2026-08-28`): Mechanical lint enforcement of authority boundaries, provider neutrality, evidence-backed fulfillment, and verified result construction — while the frozen contract/harness remain unchanged.

The next architectural move is **not** a broad integration rewrite. It is a **deliberately thin runtime spike** that proves the plugin layer can load Entra/Okta adapters without mutating certified governance semantics.

## Problem Statement

Current state:
- Adapters (`entra-adapter.ts`, `okta-adapter.ts`) are compiled into `governance-core`
- Adding a new provider requires modifying `governance-core` (registering the adapter, updating provider maps)
- The conformance harness runs against direct imports — no runtime loading path exists

Desired state:
- Provider adapters loaded dynamically through a capability runtime
- Core governance (policy, authorization, durable state, retries, leases, reconciliation, secrets authority, audit authority) remains unchanged
- The **same conformance harness** passes against both direct and runtime-loaded adapters
- New providers can be added without touching `governance-core` source

## Scope of the Spike

**In scope (thin, deliberate, time-boxed):**
- Provider-neutral capability contracts (`Capability`, `CapabilityRegistry`, `CapabilityPlugin`)
- Capability registry that exposes eligible providers; **core policy chooses** which provider is authoritative
- Runtime lifecycle semantics: `activate`, `degrade`, `suspend`, `dispose`, `cleanup`
- Credentialed plugin instances are **tenant-scoped**
- Runtime events are **ephemeral**; durable governance/business events stay in core audit
- Load existing `EntraAdapter` and `OktaAdapter` through the runtime without changing `FulfillmentAdapter`
- Run the **unchanged conformance harness** against both runtime-loaded adapters
- Cordis as an **implementation candidate** behind `packages/integration-runtime` — not an architectural dependency until the spike proves cleanup, isolation, and dependency behavior

**Explicitly out of scope (not in spike):**
- Policy engine changes
- Authorization logic changes
- Durable state schema changes
- Retry/lease/reconciliation changes
- Secrets authority changes
- Audit authority changes
- Conformance harness changes
- `FulfillmentAdapter` contract changes
- Multi-tenant orchestration (single-tenant spike only)
- Plugin marketplace / third-party loading

## Architecture Sketch

```
┌─────────────────────────────────────────────────────────────────┐
│                        GOVERNANCE CORE                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │   Policy    │  │ Authorization│  │  Durable State /       │ │
│  │   Engine    │  │   Boundary   │  │  Reconciliation /      │ │
│  │             │  │              │  │  Leases / Secrets /    │ │
│  └──────┬──────┘  └──────┬───────┘  │  Audit Authority       │ │
│         │                │          └────────────────────────┘ │
│         ▼                ▼                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │            CAPABILITY REGISTRY (core)                    │   │
│  │  - registerCapability(capability)                        │   │
│  │  - resolveProvider(entitlement, context) → ProviderRef   │   │
│  │  - policyChooses: core policy decides authority          │   │
│  └────────────────────────────┬────────────────────────────┘   │
│                               │                                │
│         ┌─────────────────────┼─────────────────────┐          │
│         ▼                     ▼                     ▼          │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    │
│  │  INTEGRATION │    │  INTEGRATION │    │  (future)    │    │
│  │   RUNTIME    │    │   RUNTIME    │    │  Plugins     │    │
│  │  (spike)     │    │  (spike)     │    │              │    │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘    │
│         │                   │                   │             │
│  ┌──────▼───────┐    ┌──────▼───────┐          │             │
│  │ EntraAdapter │    │ OktaAdapter  │          │             │
│  │ (wrapped)    │    │ (wrapped)    │          │             │
│  └──────────────┘    └──────────────┘          │             │
└─────────────────────────────────────────────────┘
```

### Capability Contract (provider-neutral)

```typescript
// packages/integration-runtime/src/capability.ts

export interface Capability {
  readonly name: string;                    // e.g., "identity.governance.entra"
  readonly version: string;                 // semver
  readonly provider: string;                // "entra" | "okta" | "github" | ...
  readonly fulfills: FulfillmentAdapter;    // the unchanged contract
  readonly metadata: CapabilityMetadata;
}

export interface CapabilityMetadata {
  readonly tenantScope: boolean;            // true = tenant-scoped credentials
  readonly requiredSecrets: string[];       // secret keys this capability needs
  readonly supports: CapabilitySupport;     // optional feature flags
}

export interface CapabilitySupport {
  readonly eventualConsistency: boolean;    // provider has replication delays
  readonly batchOperations: boolean;        // provider supports batch grant/revoke
  readonly dryRun: boolean;                 // provider supports dry-run verification
}

export interface ProviderRef {
  readonly capabilityName: string;
  readonly tenantId: string;                // tenant-scoped instance
  readonly credentialsRef: string;          // reference to secret store
}
```

### Capability Registry (core-owned, policy-driven)

```typescript
// packages/integration-runtime/src/registry.ts

export interface CapabilityRegistry {
  // Registration (startup / plugin load)
  register(capability: Capability): void;
  unregister(capabilityName: string): void;

  // Resolution (policy calls this)
  resolveProvider(
    entitlement: EntitlementRef,
    context: ResolutionContext
  ): ProviderRef | null;

  // Lifecycle (runtime owns this)
  activate(tenantId: string, capabilityName: string): Promise<CapabilityInstance>;
  degrade(tenantId: string, capabilityName: string): Promise<void>;
  suspend(tenantId: string, capabilityName: string): Promise<void>;
  dispose(tenantId: string, capabilityName: string): Promise<void>;
  cleanup(tenantId: string): Promise<void>;
}

export interface ResolutionContext {
  readonly subject: SubjectRef;
  readonly requestedPermissions: Permission[];
  readonly policyPreferences?: PolicyPreferences;  // e.g., "prefer entra over okta"
}

export interface PolicyPreferences {
  readonly preferredProviders?: string[];
  readonly requireEventualConsistencyHandling?: boolean;
}
```

### Runtime Lifecycle (ephemeral events only)

```typescript
// packages/integration-runtime/src/runtime.ts

export interface CapabilityInstance {
  readonly capability: Capability;
  readonly tenantId: string;
  readonly credentials: CapabilityCredentials;  // resolved at activate time
  readonly state: InstanceState;
}

export type InstanceState = "activating" | "active" | "degraded" | "suspended" | "disposed";

export interface CapabilityCredentials {
  readonly secrets: Map<string, string>;        // tenant-scoped
  readonly expiresAt?: Date;
}

export interface RuntimeEvent {
  readonly type: "activated" | "degraded" | "suspended" | "disposed" | "error";
  readonly capabilityName: string;
  readonly tenantId: string;
  readonly timestamp: Date;
  readonly detail?: unknown;
}

// Ephemeral: emitted to event bus, NOT written to durable audit store
// Durable governance events (grant/revoke/verify) remain in core
export type RuntimeEventHandler = (event: RuntimeEvent) => void;
```

## Key Proof: Conformance Harness Unchanged

The spike succeeds **iff** this holds:

```text
direct EntraAdapter ───────────── PASS (existing cert)
runtime-loaded EntraAdapter ──── PASS (unchanged harness)

direct OktaAdapter ────────────── PASS (existing cert)
runtime-loaded OktaAdapter ───── PASS (unchanged harness)

same FulfillmentAdapter interface
same conformance.ts semantics
same governance authority boundary
```

The conformance harness (`packages/governance-core/src/adapters/conformance.ts`) is **not modified**. It receives a `FulfillmentAdapter` implementation — whether direct import or runtime-wrapped — and executes the identical lifecycle:

1. Resolve subject
2. Verify absent (precondition)
3. Grant → verify present
4. Grant again → verify present + idempotent (`mutated: false`)
5. Revoke → verify absent
6. Revoke again → verify absent + idempotent (`mutated: false`)
7. Confirm clean final state

If runtime-wrapped adapters pass this unchanged harness, the plugin layer has earned its place.

## Implementation Plan (Spike)

### 1. Scaffold `packages/integration-runtime`
```
packages/integration-runtime/
├── src/
│   ├── capability.ts          # Capability, CapabilityMetadata, CapabilitySupport
│   ├── registry.ts            # CapabilityRegistry interface + in-memory impl
│   ├── runtime.ts             # Instance lifecycle (activate/degrade/suspend/dispose)
│   ├── loader.ts              # Dynamic import / plugin loading (thin)
│   ├── index.ts               # Public exports
│   └── cordis-adapter.ts      # Cordis integration (optional, behind flag)
├── test/
│   ├── capability-contract.test.ts
│   ├── registry.test.ts
│   ├── runtime-lifecycle.test.ts
│   └── conformance-proof.test.ts   # THE KEY TEST: run harness against runtime-loaded
├── package.json
└── tsconfig.json
```

### 2. Wrap existing adapters (zero changes to adapter source)
```typescript
// packages/integration-runtime/src/adapters/entra-runtime-adapter.ts
import { EntraAdapter } from "@opnory/governance-core/adapters/entra-adapter";
import { FulfillmentAdapter } from "@opnory/governance-core/adapters/fulfillment";

export function createEntraRuntimeAdapter(
  config: EntraConfig,
  credentials: CapabilityCredentials
): FulfillmentAdapter {
  const adapter = new EntraAdapter(config);
  // Credentials injected at activate time, not construction
  return {
    ...adapter,
    // credentials available via closure / context
  };
}
```

### 3. Conformance proof test
```typescript
// packages/integration-runtime/test/conformance-proof.test.ts
import { runFulfillmentAdapterCertification } from "@opnory/governance-core/adapters/conformance";
import { CapabilityRegistry } from "../src/registry";
import { createEntraRuntimeAdapter } from "../src/adapters/entra-runtime-adapter";

test("runtime-loaded EntraAdapter passes unchanged conformance harness", async () => {
  const registry = new CapabilityRegistry();
  registry.register({
    name: "identity.governance.entra",
    version: "1.0.0",
    provider: "entra",
    fulfills: createEntraRuntimeAdapter(entraConfig, testCredentials),
    metadata: { tenantScope: true, requiredSecrets: ["clientSecret"], supports: {...} }
  });

  const instance = await registry.activate("test-tenant", "identity.governance.entra");
  
  // SAME HARNESS, SAME FIXTURES, SAME ASSERTIONS
  await runFulfillmentAdapterCertification({
    provider: "entra",
    adapter: instance.capability.fulfills,
    subject: testSubject,
    permissions: testPermissions,
  });
});
```

### 4. Cordis integration (behind flag, not required for spike pass)
- If Cordis proves clean `activate/degrade/suspend/dispose/cleanup` with proper isolation, adopt
- If not, replace with minimal custom lifecycle — the contract doesn't require Cordis

## Acceptance Criteria for Spike Completion

| Criterion | Verification |
|-----------|--------------|
| Capability contracts defined and type-safe | `bun run typecheck` passes |
| Registry resolves providers; policy chooses | Unit tests + manual inspection |
| Runtime lifecycle semantics implemented | `activate → degrade → suspend → dispose → cleanup` tested |
| Tenant-scoped credentials work | Multi-tenant test scenario |
| Ephemeral events only; no durable event leakage | Audit store unchanged |
| **Unchanged conformance harness passes for runtime-loaded EntraAdapter** | `bun test conformance-proof.test.ts` |
| **Unchanged conformance harness passes for runtime-loaded OktaAdapter** | `bun test conformance-proof.test.ts` |
| Frozen contract/harness/adapters unmodified | `git diff -- packages/governance-core/src/adapters/` empty |
| All existing gates pass | `bun run lint && bun run build && bun run typecheck && bun test` |

## Consequences

**If spike succeeds:**
- ADR 0004 moves to **Accepted**
- First-party integration plugins (Entra, Okta, GitHub, SCIM) migrate behind `packages/integration-runtime`
- New providers added via capability registration, zero `governance-core` changes
- Plugin marketplace architecture becomes viable

**If spike fails:**
- Identify blocker (Cordis isolation? lifecycle semantics? conformance gap?)
- Document in ADR as **Rejected** with rationale
- Revert to direct-import architecture; plugin layer deferred

## Evidence (to be collected during spike)

- `packages/integration-runtime/test/conformance-proof.test.ts` results
- `git diff -- packages/governance-core/src/adapters/` showing zero changes
- Full gate run: `bun run lint && bun run build && bun run typecheck && bun test`
- Runtime event log showing ephemeral-only emission

## Related ADRs

- **ADR 0002**: RBAC as Governance Foundation (policy domain model)
- **ADR 0003**: FulfillmentAdapter Conformance Contract (frozen interface + harness)
- **This ADR**: Capability Runtime Spike (extensibility without mutation)

---

**Next seam**: After spike completion, update this ADR to **Accepted** or **Rejected** with evidence. If Accepted, the capability/runtime phase proceeds with migration of first-party adapters behind the runtime.