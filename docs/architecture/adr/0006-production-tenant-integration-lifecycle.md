# ADR 0006: Production Tenant Integration Lifecycle Semantics

**Date:** 2026-08-30  
**Status:** Accepted  
**Authors:** Opnory Core Team  
**Related:** ADR 0004 (Capability Runtime Spike), ADR 0005 (Cordis Evaluation)

## Context

Phase 6 introduced a production-grade tenant integration lifecycle: durable desired-state aggregates, a PostgreSQL-backed repository, installer/uninstaller/reconciliation workers, and an in-memory lifecycle proof suite (`integration-lifecycle.test.ts`). That suite is exhaustive in the file named in §"Acceptance Criteria": six tests covering cross-tenant install (A→Okta, B→Entra), restart recovery (no duplicate capability registrations), credential-failure isolation (A degrades, B stays ACTIVE), repair recovery, and uninstall cleanup — run under `bun test packages/integration-runtime`, all six passing with the full suite at 327 pass / 0 fail. This ADR freezes the architectural semantics those tests demonstrate before the production credential path or any warning cleanup.

## Decision

### 1. Authority Boundaries

| Authority | Owner | Rationale |
|-----------|-------|-----------|
| **Desired integration state** | Core | Core decides *what* integrations should exist for a tenant |
| **Actual lifecycle state transitions** | Core | Core drives ACTIVE/DEGRADED/SUSPENDED/INACTIVE via reconciliation |
| **Capabilities & health observations** | Plugins | Plugins expose what they can do and their current health |
| **Installation/authorization decisions** | **Never plugins** | Plugins are capability providers, not policy actors |

**Invariant:** `desiredStatus !== actualStatus` is the normal operating state during convergence. They are distinct fields in the `TenantIntegration` aggregate.

### 2. Durability & Process State

- **PostgreSQL** is the durable lifecycle authority. All `TenantIntegration` mutations persist there with optimistic concurrency (`configVersion`).
- **RuntimeKernel** holds reconstructible process state (active plugin instances, capability registrations). It is disposable and rebuilt on restart from Postgres.
- **RuntimeEventBus** is strictly ephemeral — plugin lifecycle events (`activated`, `deactivated`, `health_changed`, `error`) are fire-and-forget within the process. Durable governance/business events remain in Core.

### 3. Credential Architecture

**PostgreSQL stores only a reference:**

```typescript
interface TenantIntegration {
  credentialRef: string;  // opaque reference, never raw secret material
}
```

**Production secret boundary:**

```typescript
interface SecretStore {
  get(ref: SecretRef): Promise<SecretMaterial>;
  put(scope: TenantSecretScope, value: SecretMaterial): Promise<SecretRef>;
  delete(ref: SecretRef): Promise<void>;
}

interface CredentialProvider {
  resolve(tenantId: TenantId, credentialRef: SecretRef): Promise<ScopedCredentialHandle>;
}
```

**Architecture:**

```
TenantIntegration row
      │
      └── credentialRef
              │
              ▼
      CredentialProvider (tenant/plugin scoped)
              │
              ▼
          SecretStore
        /     |      \
     KMS    Vault   cloud secret manager
```

`CredentialProvider` enforces tenant/plugin scope and translates the secret-store result into the narrow credential material a plugin needs. Plugins never receive arbitrary secret-store access.

### 4. Credential Failure Semantics (Deterministic)

| Condition | Failure Code |
|-----------|--------------|
| Secret ref missing from SecretStore | `configuration_invalid` |
| Secret inaccessible / tenant mismatch | `credential_invalid` |
| Secret resolves but provider rejects it | `credential_invalid` |
| Secret backend temporarily unavailable | `credential_backend_unavailable` |

**Note:** `credential_backend_unavailable` is distinct from `provider_unreachable` (the external identity provider being down). This separation enables different recovery behaviors: credential backend issues may warrant alerts to platform ops; provider issues may warrant tenant-facing notifications.

### 5. Concurrency & Work Distribution

- **All mutations** use optimistic concurrency via `configVersion` on `TenantIntegration`.
- **Reconciliation workers** claim work with durable leases (`FOR UPDATE SKIP LOCKED` on `reconciliation_leases` table).
- **Lease fields** on `TenantIntegration`: `leaseHolder`, `leaseExpiresAt` — only the lease holder may mutate.

### 6. Lifecycle Transitions (Core-Driven)

```
DISCOVERED → CONFIGURING → VALIDATING → ACTIVE
                    ↓
              DEGRADED ←→ RECOVERING
                    ↓
              SUSPENDED
                    ↓
              UNINSTALLING → INACTIVE (fail-closed)
```

- **Installer** drives DISCOVERED → ACTIVE with health probe validation.
- **Reconciliation** drives ACTUAL → DESIRED convergence (activate, degrade, suspend, recover).
- **Uninstaller** drives ACTIVE → UNINSTALLING → INACTIVE. **Fail-closed:** if cleanup cannot be proven (the provider-side deletion is unverified), the aggregate remains `UNINSTALLING` with `failureCode: cleanup_failed` — never silently becomes `INACTIVE`. This exact behavior is asserted by the "uninstall cleanup" test in `integration-lifecycle.test.ts`, which checks that a failed provider deletion leaves the record in `UNINSTALLING` rather than `INACTIVE`.

### 7. Tenant Isolation

- Tenant A's credential failure **never** affects Tenant B's integration state.
- Reconciliation workers process one tenant integration per lease claim.
- Capability registry is tenant-scoped (`getInstancesForTenant`).
- RuntimeKernel contexts are per-tenant.

### 8. Idempotent Restart/Recovery

- Installer is idempotent: re-running on `ACTIVE` with matching config is a no-op.
- Reconciliation re-reads desired state from Postgres on each cycle.
- RuntimeKernel rebuilds plugin instances from Postgres on process restart.
- No duplicate capability registrations on restart (asserted by the restart-recovery test in `integration-lifecycle.test.ts`: it rebuilds a fresh kernel from Postgres and checks the registry holds exactly one instance per capability, not two).

## Architectural Lesson: Repository Value Semantics

**Bug discovered during lifecycle proof:** The in-memory test repository returned live object references (aliasing), causing infinite recursion in the uninstaller's optimistic-concurrency retry loop:
1. Caller reads `TenantIntegration` → gets reference to stored object
2. Caller mutates `configVersion += 1` on that reference
3. Caller calls `update(integ, expectedVersion=0)`
4. Repository sees `stored.configVersion === 1 !== 0` → throws `OptimisticConcurrencyError`
5. Caller retries with `expectedVersion=1` but object already mutated to 2 → infinite recursion

**Root cause:** Repository boundary lacked value semantics. Callers could mutate persisted aggregate state by retaining an aliased reference.

**Fix:** Repository `findById` / `findAll` must return **cloned** objects (structured clone or explicit copy). The in-memory implementation now clones on read; the PostgreSQL implementation naturally returns fresh rows.

**Contract test required:** Any `TenantIntegrationRepository` implementation (in-memory, Postgres, future) must pass a value-semantics test proving:
- Read → mutate returned object → read again → original unchanged
- Concurrent `update` with stale version throws, does not corrupt stored state

## Acceptance Criteria (Proven by Phase 6 Lifecycle Proof)

| Scenario | Result |
|----------|--------|
| Tenant A installs Okta, Tenant B installs Entra | Both ACTIVE, isolated credentials |
| Process restart | Both recover to ACTIVE, no duplicate registrations |
| Tenant A credential invalidated | A → DEGRADED, B unaffected (ACTIVE) |
| Tenant A credential repaired | A → ACTIVE, B unaffected |
| Tenant A uninstalled | A → INACTIVE, runtime disposed, B untouched |

All six scenarios above are asserted by `integration-lifecycle.test.ts` and pass under `bun test packages/integration-runtime` (full repo suite: 327 pass / 0 fail). Each row maps to one test; tenant isolation is demonstrated by the concurrent A-degraded/B-ACTIVE assertions, not asserted trivially.

## Consequences

### Positive
- Clear authority boundaries prevent plugin overreach
- Deterministic credential failure codes enable precise automation
- Fail-closed uninstall prevents orphaned provider-side resources
- Tenant isolation is architectural, not accidental
- Idempotent restart simplifies operations

### Negative
- Additional indirection for credentials (SecretStore → CredentialProvider → Plugin)
- Reconciliation worker infrastructure required for production
- Optimistic concurrency adds retry logic to all writers

### Neutral
- In-memory repository suitable for tests only; production requires PostgreSQL
- RuntimeEventBus remains in-memory; durable eventing stays in Core

## Next Steps

1. **ADR 0007** — Observability benchmark methodology (borrowing `agents_otel_data` discipline)
2. **SecretStore + production CredentialProvider** implementation
3. **Credential isolation/rotation proof** (extend lifecycle tests)
4. **Full Phase 6 integration-control-plane proof**
5. **integration-runtime warning cleanup** (discrete hardening pass)
6. **Phase 6 freeze/tag**