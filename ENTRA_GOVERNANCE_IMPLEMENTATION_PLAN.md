# Entra Governance Vertical Slice — Implementation Plan

## 1. CURRENT ARCHITECTURE FINDINGS

### Relevant Packages & Files

| Package               | Key Files      | Purpose                                                                                                                |
| --------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `access-types`        | `src/index.ts` | Core types: AccessRequest, EntitlementRef, GovernanceProvider, GovernanceAuthority, state machine, external identities |
| `access-entitlements` | `src/index.ts` | Entitlement catalog, canonical entitlements, GitHub-specific config                                                    |
| `access-policy`       | `src/index.ts` | PolicyEngine evaluates approval requirements based on entitlement approvalPolicy                                       |
| `access-approval`     | `src/index.ts` | ApprovalService manages PENDING_APPROVAL → APPROVED/DENIED with optimistic concurrency                                 |
| `access-service`      | `src/index.ts` | AccessRequestService orchestrates: create → policy → approval → executor                                               |
| `access-store-pg`     | `src/index.ts` | PostgreSQL persistence for AccessRequest, AuditEvent, idempotency                                                      |
| `access-audit`        | `src/index.ts` | AuditEventStore, event types including GOVERNANCE_REQUEST_SUBMITTED                                                    |
| `access-executor`     | `src/index.ts` | GitHubAccessExecutor (grant/revoke with reconciliation), FakeGitHubAccessExecutor                                      |
| `access-governance`   | `src/index.ts` | **NEW** GovernanceProvider interface + LocalGovernanceProvider + EntraGovernanceProvider + GovernanceService           |
| `apps/api`            | `src/index.ts` | Fastify endpoints: POST /v1/access/requests, POST /:id/approve, POST /:id/deny                                         |
| `apps/slack`          | `src/`         | Slack Bolt app (not yet inspected in detail)                                                                           |

### Current Access Lifecycle

```
User Intent (Slack/API)
    ↓
AccessRequestService.createAccessRequest()
    ↓
1. Identify Entitlement (catalog lookup)
2. Evaluate Policy (PolicyEngine) → APPROVAL_REQUIRED
3. Create AccessRequest (PENDING_APPROVAL)
4. Audit: ACCESS_REQUEST_CREATED, APPROVAL_REQUESTED
    ↓
POST /v1/access/requests/:id/approve (or /deny)
    ↓
ApprovalService.approve() / deny()
    ↓
Optimistic concurrency transition to APPROVED
    ↓
AccessRequestService.fulfillRequest()
    ↓
GitHubAccessExecutor.grant() (with reconciliation)
    ↓
FULFILLED (accessExpiresAt set to 90 days)
    ↓
ExpirationScheduler (distributed workers)
    ↓
Claim → Process → Revoke via executor
    ↓
REVOKED
```

### Current Identity Model

```typescript
// access-types: ExternalIdentitySchema
{
  github?: {
    login: string;
    verified: boolean;
    verifiedAt?: string;
    source: "admin" | "github" | "idp";
  }
  // Future: slack, google, entra, okta
}
```

- No Entra ID identity yet
- GitHub identity verified by admin or OAuth
- Slack user → Opnory identity via requesterId/requesterEmail

### Current Persistence Model

PostgreSQL `access_requests` table includes:

- Core fields: id, correlation_id, requester_id, entitlement_id, status, version
- Expiration retry fields: expiration_attempt_count, expiration_next_attempt_at, expiration_max_retries, expiration_last_error
- Lease fields: lease_owner, lease_until, lease_acquired_at
- **Governance fields already added**: governanceExternalRequestId, governanceAuthority, governanceAssignmentId, governanceAssignmentExpiresAt

---

## 2. MINIMUM DESIGN

### GovernanceProvider Interface (Refined)

```typescript
// access-types: already defined, minor refinements needed
interface GovernanceProvider {
  readonly authority: GovernanceAuthority; // "local" | "entra"

  resolveSubject(identity: OpnoryIdentity): Promise<GovernanceSubject>;
  resolveEntitlement(entitlement: EntitlementRef): Promise<GovernedEntitlement>;
  submitRequest(request: GovernedAccessRequest): Promise<GovernanceRequest>;
  getRequestStatus(externalRequestId: string): Promise<GovernanceRequestStatus>;
  getAssignment(
    subject: GovernanceSubject,
    entitlement: GovernedEntitlement,
  ): Promise<GovernanceAssignment | null>;
  revokeAssignment(
    assignment: GovernanceAssignment,
  ): Promise<GovernanceRevocationResult>;
}
```

**Refinements needed:**

- `OpnoryIdentity` type should be explicit (not `any`)
- `resolveEntitlement` parameter should be `EntitlementRef` not `any`
- Add `governance` field to `EntitlementRefSchema` with typed config:

```typescript
governance: z.object({
  authority: GovernanceAuthoritySchema,
  // Entra-specific config (only when authority === "entra")
  accessPackageId: z.string().optional(),
  assignmentPolicyId: z.string().optional(),
  // Who owns downstream fulfillment (GitHub team membership)
  fulfillmentOwner: z.enum(["local", "entra"]).default("local"),
}).optional();
```

### LocalGovernanceProvider Placement

- **Package**: `access-governance` (already created)
- **Wraps**: Current `ApprovalService` behavior
- **No rewrite** of existing approval logic
- Returns `GovernanceRequest` with internal tracking ID
- Status maps directly: PENDING_APPROVAL → APPROVED/DENIED

### EntraGovernanceProvider Placement

- **Package**: `access-governance` (already created, functional)
- **Implements**: Microsoft Graph Entitlement Management API
- **Configuration**: `EntraConfig` (tenantId, clientId, clientSecret)
- **Maps**: Entitlement → Access Package ID (from `entitlement.metadata.entraAccessPackageId`)
- **Never** invents Entra IDs — all from config or authoritative API

### Entitlement Ownership Schema

```typescript
// In EntitlementRefSchema (access-types)
governance: {
  authority: "local" | "entra",
  accessPackageId?: string,           // Required if authority === "entra"
  assignmentPolicyId?: string,        // Optional, for specific policy
  fulfillmentOwner: "local" | "entra" // Default "local"
}
```

- **Typed schema** — no arbitrary Record<string, unknown>
- **Validated at entitlement registration** — if authority=entra, accessPackageId required

### State Machine Changes

**Current states already include**: `AWAITING_EXTERNAL_ACCEPTANCE` (for GitHub pending invitations)

**Add one new state**:

```typescript
AccessRequestStatusSchema = z.enum([
  // ... existing ...
  "AWAITING_AUTHORITY_DECISION", // Entra-owned: submitted, awaiting Entra decision
]);
```

**Transitions for Entra-owned**:

```
PENDING_APPROVAL → AWAITING_AUTHORITY_DECISION (on submitRequest)
AWAITING_AUTHORITY_DECISION → APPROVED (Entra approves + assignment confirmed)
AWAITING_AUTHORITY_DECISION → DENIED (Entra denies)
AWAITING_AUTHORITY_DECISION → CANCELLED (timeout/expired)
```

**Critical invariant**: Local approve/deny endpoints MUST reject Entra-owned requests in AWAITING_AUTHORITY_DECISION.

### Identity Changes

```typescript
// Extend ExternalIdentitySchema
entra?: {
  objectId: string;           // Entra user objectId (authoritative)
  tenantId: string;           // Tenant ID for multi-tenant
  verified: boolean;
  verifiedAt?: string;
  source: "idp" | "admin";    // How this mapping was established
}
```

- **Authoritative**: `objectId` + `tenantId` (composite key)
- **Mapping**: Slack/API requesterEmail → Entra user via Graph API lookup
- **Absent mapping**: Fallback to manual (LocalGovernanceProvider) with audit warning

### Persistence Changes

**Minimal PostgreSQL additions** (only what's needed for restart recovery & reconciliation):

```sql
-- Already exist in schema (verified):
governance_external_request_id  -- Entra request ID
governance_authority            -- "local" | "entra"
governance_assignment_id        -- Entra assignment ID
governance_assignment_expires_at -- From Entra assignment schedule

-- ADD: External governance status for reconciliation
external_governance_status      -- Current Entra status (PENDING_APPROVAL, APPROVED, DENIED, etc.)
external_governance_last_checked_at -- Last reconciliation timestamp
```

**Do NOT store**: Raw Graph API responses, OAuth tokens, client secrets.

### Audit Changes

**New event types** (add to `AuditEventTypeSchema` in `access-audit`):

```typescript
"GOVERNANCE_REQUEST_SUBMITTED",      // Already exists
"GOVERNANCE_DECISION_PENDING",       // Added: entered AWAITING_AUTHORITY_DECISION
"GOVERNANCE_REQUEST_APPROVED",       // Added: Entra approved
"GOVERNANCE_REQUEST_DENIED",         // Added: Entra denied
"GOVERNANCE_ASSIGNMENT_CONFIRMED",   // Added: Entra assignment active
"GOVERNANCE_RECONCILIATION_FAILED",  // Added: reconciliation error
"LOCAL_OVERRIDE_REJECTED",           // Added: security event for CASE 47
```

**Metadata fields** (standardized):

```typescript
{
  provider: "entra",
  accessPackageId: string,
  assignmentPolicyId?: string,
  externalRequestId: string,
  externalAssignmentId?: string,
  authoritativeStatus: string
}
```

---

## 3. FILE-BY-FILE IMPLEMENTATION PLAN

### access-types (`packages/access-types/src/index.ts`)

| Change                                                                   | Purpose                                          | Dependencies                                |
| ------------------------------------------------------------------------ | ------------------------------------------------ | ------------------------------------------- |
| Add `AWAITING_AUTHORITY_DECISION` to `AccessRequestStatusSchema`         | New state for Entra-owned requests               | State machine transitions                   |
| Add transitions for `AWAITING_AUTHORITY_DECISION` in `VALID_TRANSITIONS` | Define valid flows                               | `canTransition`, `transitionOrThrow`        |
| Extend `EntitlementRefSchema.governance` with typed fields               | Entra config (accessPackageId, fulfillmentOwner) | EntitlementCatalog registration validation  |
| Extend `ExternalIdentitySchema` with `entra` field                       | Store Entra identity mapping                     | `resolveSubject` in EntraGovernanceProvider |
| Ensure `OpnoryIdentity` type is explicit for `resolveSubject` param      | Type safety                                      | GovernanceProvider interface                |

### access-entitlements (`packages/access-entitlements/src/index.ts`)

| Change                                            | Purpose                                             | Dependencies      |
| ------------------------------------------------- | --------------------------------------------------- | ----------------- |
| Add validation in `EntitlementCatalog.register()` | Reject Entra entitlements missing `accessPackageId` | Governance schema |
| Export `createEntitlementWithGovernance()` helper | Ergonomic creation with governance config           | —                 |

### access-policy (`packages/access-policy/src/index.ts`)

| Change                                  | Purpose                               | Dependencies                   |
| --------------------------------------- | ------------------------------------- | ------------------------------ |
| **No change to PolicyEngine**           | Local approval policy unchanged       | —                              |
| Add `evaluateGovernancePolicy()` helper | Returns governance authority decision | Called by AccessRequestService |

### access-approval (`packages/access-approval/src/index.ts`)

| Change                           | Purpose                                | Dependencies            |
| -------------------------------- | -------------------------------------- | ----------------------- |
| **No change to ApprovalService** | Local approval logic preserved         | —                       |
| Add `canApprove()` guard method  | Check if request is locally approvable | Called by API endpoints |

### access-service (`packages/access-service/src/index.ts`)

| Change                                      | Purpose                                                                             | Dependencies                             |
| ------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------- |
| Inject `GovernanceService` into constructor | Orchestrate provider selection                                                      | access-governance                        |
| Modify `createAccessRequest()`              | After policy eval, if Entra-owned: submit to provider → AWAITING_AUTHORITY_DECISION | GovernanceProvider, GovernanceService    |
| Modify `decideAccessRequest()`              | **Reject** local approve/deny for Entra-owned requests                              | `canApprove` check                       |
| Add `reconcileGovernanceRequest()`          | Poll Entra status, transition to APPROVED/DENIED                                    | EntraGovernanceProvider.getRequestStatus |
| Add `getGovernanceProvider()`               | Select provider based on entitlement.governance.authority                           | GovernanceService                        |

### access-governance (`packages/access-governance/src/index.ts`)

| Change                                            | Purpose                                                          | Dependencies              |
| ------------------------------------------------- | ---------------------------------------------------------------- | ------------------------- |
| Complete `EntraGovernanceProvider` implementation | Already largely done                                             | Microsoft Graph SDK/types |
| Add `GovernanceService` method `submitAndTrack()` | Submit + schedule reconciliation                                 | AccessRequestService      |
| Add idempotency for `submitRequest`               | Use `request.idempotencyKey` to prevent duplicate Entra requests | InMemoryIdempotencyStore  |

### access-store-pg (`packages/access-store-pg/src/index.ts`)

| Change                                                                          | Purpose                                          | Dependencies         |
| ------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------- |
| Add `external_governance_status`, `external_governance_last_checked_at` columns | Persistence for reconciliation                   | Migration SQL        |
| Update `mapRowToRequest()` / `create()` / `update()`                            | Include new fields                               | PgAccessRequestStore |
| Add `getByGovernanceRequestId()` query                                          | Lookup by external request ID for reconciliation | —                    |

### access-audit (`packages/access-audit/src/index.ts`)

| Change                               | Purpose                 | Dependencies |
| ------------------------------------ | ----------------------- | ------------ |
| Add new `AuditEventType` enum values | See Audit Changes above | —            |

### access-executor (`packages/access-executor/src/index.ts`)

| Change                                | Purpose                                                               | Dependencies                   |
| ------------------------------------- | --------------------------------------------------------------------- | ------------------------------ |
| **No functional change**              | Entra-owned fulfillment depends on `fulfillmentOwner`                 | —                              |
| Add `canExecute()` guard on `grant()` | Return `EXTERNAL_AUTHORITY_MANAGED` if `fulfillmentOwner === "entra"` | Called by AccessRequestService |

### apps/api (`apps/api/src/index.ts`)

| Change                            | Purpose                                                | Dependencies                              |
| --------------------------------- | ------------------------------------------------------ | ----------------------------------------- |
| Modify `POST /:id/approve`        | Check `governanceAuthority === "entra"` → 409 CONFLICT | access-service                            |
| Modify `POST /:id/deny`           | Same guard                                             | access-service                            |
| Add `POST /:id/reconcile` (admin) | Manual reconciliation trigger                          | access-service.reconcileGovernanceRequest |

### apps/slack (`apps/slack/src/`)

| Change                                          | Purpose                         | Dependencies                           |
| ----------------------------------------------- | ------------------------------- | -------------------------------------- |
| Inspect Slack command handler                   | Apply same local-override guard | —                                      |
| Add Entra identity verification flow (optional) | `/verify-entra` command         | EntraGovernanceProvider.resolveSubject |

---

## 4. ACCEPTANCE TEST PLAN

### Core Cases (41–48)

| Case   | Scenario                      | Given                                                                             | When                                      | Then                                                                                                               |
| ------ | ----------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **41** | Known Entra entitlement       | Entitlement with `governance: { authority: "entra", accessPackageId: "pkg-123" }` | Create request                            | External request submitted to Entra; state = `AWAITING_AUTHORITY_DECISION`; Local ApprovalService NOT invoked      |
| **42** | Pending authority decision    | Request in `AWAITING_AUTHORITY_DECISION`                                          | Poll status via `getRequestStatus`        | Returns Entra status; GitHub executor NOT called                                                                   |
| **43** | Authoritative approval        | Entra returns `APPROVED` + assignment                                             | Reconciliation runs                       | State → `APPROVED`; if `fulfillmentOwner=local` → executor runs; if `fulfillmentOwner=entra` → executor NOT called |
| **44** | Authoritative denial          | Entra returns `DENIED`                                                            | Reconciliation runs                       | State → `DENIED`; executor NEVER called                                                                            |
| **45** | Unknown external entitlement  | Entitlement with `authority: "entra"` but NO `accessPackageId`                    | Create request                            | Error: "missing entraAccessPackageId"; NO external request submitted                                               |
| **46** | Restart recovery              | External request ID persisted in DB                                               | Process restarts, reconciliation job runs | Resumes polling same `externalRequestId`; NO duplicate Entra request                                               |
| **47** | Local override attempt        | Entra-owned request in `AWAITING_AUTHORITY_DECISION`                              | Call `POST /:id/approve`                  | 409 CONFLICT; state unchanged; audit `LOCAL_OVERRIDE_REJECTED`; executor NOT called                                |
| **48** | External expiration ownership | Entra entitlement with `fulfillmentOwner: "entra"` + Entra-managed duration       | Expiration scheduler runs                 | Scheduler does NOT claim this request (skips Entra-owned)                                                          |

### Additional Essential Cases

| Case   | Scenario                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------ |
| **49** | Duplicate submit idempotency — same request submitted twice → single Entra request                                 |
| **50** | Stale external state — Entra shows APPROVED but local still AWAITING_AUTHORITY_DECISION → reconciliation fixes     |
| **51** | Provider outage retry — Graph API 5xx → exponential backoff, max 3 retries, then alert                             |
| **52** | Conflicting provider responses — Entra says APPROVED, then DENIED on subsequent poll → audit alert, manual review  |
| **53** | Missing Entra identity mapping — requesterEmail not found in Entra → fallback to manual subject with audit warning |

---

## 5. SECURITY INVARIANTS

**The following MUST ALWAYS remain true:**

1. **No self-approval of Entra-governed entitlements**: `governance.authority === "entra"` → local approve/deny endpoints return 409, state unchanged, auditor notified.

2. **No invented Entra IDs**: `accessPackageId`, `assignmentPolicyId`, `externalRequestId`, `assignmentId` come ONLY from deterministic config or authoritative Graph API responses.

3. **No competing expiration authority**: If `governance.authority === "entra"` AND `fulfillmentOwner === "entra"`, Opnory's ExpirationScheduler MUST NOT claim/process the request.

4. **Downstream executor gating**: If `fulfillmentOwner === "entra"`, `GitHubAccessExecutor.grant()` is NEVER invoked. Returns `{ success: true, reason: "EXTERNAL_AUTHORITY_MANAGED" }`.

5. **External request ID survival**: `governanceExternalRequestId` persisted in PostgreSQL survives process restart; reconciliation uses it exclusively.

6. **Audit trail integrity**: All governance events include `provider`, `accessPackageId`, `externalRequestId` — never include tokens/secrets.

7. **Identity mapping verification**: Entra subject resolution requires `verified: true` OR explicit admin-created mapping. Unverified fallback is audited.

8. **Idempotency**: Duplicate Entra submissions for same Opnory request are prevented via `idempotencyKey`.

---

## 6. OPEN QUESTIONS

| #   | Question                                                                                        | Decision Required                                                                                    |
| --- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1   | **Tenant strategy**: Single-tenant or multi-tenant Entra config?                                | If multi-tenant, `tenantId` must be part of entitlement governance config, not just provider config. |
| 2   | **Assignment policy ID**: Is `assignmentPolicyId` needed in addition to `accessPackageId`?      | Entra allows multiple assignment policies per access package. If customer uses this, add to schema.  |
| 3   | **Fulfillment owner default**: Should default be `"local"` or `"entra"` for Entra entitlements? | Default `"local"` preserves current behavior; `"entra"` requires Entra Lifecycle Workflows.          |
| 4   | **Entra identity source**: How is Slack user → Entra objectId mapped initially?                 | Options: (a) admin CSV upload, (b) Entra Connect sync, (c) just-in-time lookup by email.             |
| 5   | **Reconciliation interval**: How often to poll Entra for status?                                | Suggest: 5 min initial, exponential backoff to 1 hr. Configurable?                                   |
| 6   | **Graph API version**: Use v1.0 or beta for Entitlement Management?                             | v1.0 has limited EM support; beta has full. Decision affects stability.                              |
| 7   | **Local vs Entra for same entitlement**: Can an entitlement switch authority?                   | If yes, need migration path for existing requests.                                                   |

---

## 7. RECOMMENDED IMPLEMENTATION ORDER

### Phase 1: Types & Contracts (No behavior change)

1. `access-types`: Add `AWAITING_AUTHORITY_DECISION` state + transitions
2. `access-types`: Extend `EntitlementRefSchema.governance` with typed fields
3. `access-types`: Extend `ExternalIdentitySchema` with `entra` field
4. `access-audit`: Add new governance audit event types
5. `access-entitlements`: Add registration validation for Entra entitlements

### Phase 2: LocalGovernanceProvider (Wrap existing)

6. `access-governance`: Finalize `LocalGovernanceProvider` wrapping `ApprovalService`
7. `access-governance`: Add idempotency to `submitRequest`
8. `access-service`: Inject `GovernanceService`, add `getGovernanceProvider()`

### Phase 3: EntraGovernanceProvider (Core integration)

9. `access-governance`: Complete `EntraGovernanceProvider` (Graph API calls, error handling, retries)
10. `access-governance`: Add `GovernanceService.submitAndTrack()` with reconciliation scheduling
11. `access-store-pg`: Add `external_governance_status`, `external_governance_last_checked_at` columns + migration

### Phase 4: Service Orchestration

12. `access-service`: Modify `createAccessRequest()` → submit to provider for Entra-owned
13. `access-service`: Add `reconcileGovernanceRequest()` polling logic
14. `access-service`: Modify `decideAccessRequest()` → reject local override for Entra-owned
15. `access-executor`: Add `fulfillmentOwner` guard on `grant()`

### Phase 5: API & Security Boundaries

16. `apps/api`: Add local-override guards on `/approve` and `/deny` endpoints
17. `apps/api`: Add `POST /:id/reconcile` admin endpoint
18. `apps/slack`: Apply same guards to Slack approval handlers

### Phase 6: Tests & Validation

19. Write executable tests for CASE 41–53
20. Run full test suite: `bun test`, `bun run typecheck`, `bun run build`
21. Verify baseline SHA unchanged for unrelated code

---

**Baseline SHA**: `307eace4d1150ebcda1dca5438cb7754df90bbde`  
**Current HEAD**: `57af56c51a6cda17540145be5eaea67cd11ada30` (includes scheduler/Bun work + governance package scaffold)  
**Test Baseline**: 121 pass, 30 fail (8 skip) — 5 Knowledge Package, 4 Live GitHub config, 2 Live Revocation, 4 Acceptance concurrency, 14 pre-existing executor failures
