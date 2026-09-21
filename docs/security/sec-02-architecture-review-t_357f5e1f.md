# SEC-02 Architecture Review — Swarm t_fd4917c2 (lane: architecture-review)

Worker: t_357f5e1f (opnory-architect, role = independent architecture reviewer)
Date: 2026-09-19
Mode: READ-ONLY. Zero repository mutations. Zero Microsoft-side mutations.
Swarm root: t_fd4917c2. Siblings: t_2dd77f5b (security-review, done),
t_2e2a756e (implementation, blocked), t_39500000 (verify-gate, todo).

## 1. Scope and authority

Per the task body and AGENTS.md my role here is independent architecture
review: read-only analysis, evidence-grounded disagreement where warranted,
no implementation, no Microsoft mutation, no edit to frozen files. The swarm
's "Entra proof executor" role is the only lane allowed to mutate Microsoft
state, and only for the single REPORT-ONLY → ENABLED transition after the
reviewer gate. This lane performs zero mutations.

## 2. Repository truth (reconciled against canonical plan @ 8bb088ba)

- Canonical plan file referenced by the task body,
  `docs/security/sec-02-isolated-p1-proof-plan.md`, is NOT present on either
  `main` (head 89639f66) or this worktree's branch
  `opnory-2/t_357f5e1f-architecture-review`. It exists only in the
  historical commit 8bb088ba referenced in the task body. That is a
  documentation-integrity gap: the canonical instruction set the swarm was
  told to follow is not a live repository artifact. Reading it required
  `git show 8bb088ba:...`. Finding: see A-1 below.
- The same canonical plan has explicit reconciliation language for the
  grant-strength choice (§10 lane-divergence decisions): "prefer
  'Require authentication strength = Phishing-resistant MFA' when the trial
  surfaces it; fall back to plain 'Require MFA' with a documented
  deviation." The builder's blocked state is therefore not, strictly, a
  plan violation — it is the plan explicitly delegating the call to a
  human at proof time as a deviation decision. See A-3.

## 3. Sibling handoffs reviewed

### t_2dd77f5b (opnory-security) — status done
- Deliverable: `docs/security/sec-02-security-review-t_2dd77f5b.md` (in
  t_2dd77f5b worktree).
- SEC-02 status: UNPROVEN.
- Findings F1–F6, blockers: credential-channel handoff, expected-tenant
  fingerprint, proof-user stable identifier, human-MFA owner, written
  executor authorization.
- Microsoft mutations: 0. Consistent with role boundary.
- Architect assessment: handoff matches role (read-only adversarial
  review). The blocker list is the correct one for this swarm's design.

### t_2e2a756e (opnory-builder) — status blocked
- Performed tenant preflight (read-only) and emitted a sanitized snapshot
  at `ops/sec02-entra/preflight-snapshot.json` plus `BLOCKED.md` in the
  t_2e2a756e worktree.
- Microsoft mutations: 0. Caller: Global Administrator (az-ad-token).
- Verified: AAD Premium P2 enabled; all four Opnory groups exist;
  `opnory-sec02-proof-users` has exactly one member `sec02-proof`;
  proof user is in `opnory-platform-admins`; admin/caller not in proof
  group; CA policy "SEC-02 Conditional Access" exists with state =
  `enabledForReportingButNotEnforced`; includeGroups = only
  `opnory-sec02-proof-users`; includeApplications = only Opnory API;
  excludeUsers/Groups/Roles all empty.
- Mismatch: grantControls.authenticationStrength = built-in
  "Multifactor authentication" (allows sms/voice/softwareOath);
  requirementsSatisfied = mfa. Not phishing-resistant.
- Architect assessment: builder correctly declined to enable. The
  reviewer gate required approval of the serialized policy shape; the
  shape does not match the authorizing record. Action: correct.
- One observation on evidence hygiene: the snapshot's `includeGroup_displayName`
  and the BLOCKED.md narrative name groups/users/applications in plain
  text (`opnory-sec02-proof-users`, `sec02-proof`, `Opnory API`). The
  task body authorizes SHA-256-redacted identifiers and treats raw
  identifiers as sensitive. The builder did hash GUIDs/tenant ID/IDs,
  but display names of well-known Opnory-owned objects were apparently
  judged non-identifier metadata. I treat that as a documented,
  defensible call (these names are already in the canonical plan and
  in the task body itself), but flag it: the next executor lane should
  hold the line on GUID/tenant/user-ID hashing and must not extend
  plain-text naming to users' UPNs, emails, or any tenant-specific
  hostnames. Finding A-4.

## 4. Adversarial review of the blocked state

The single unresolved technical question is which authentication-strength
value the CA policy must carry before being enabled. Three considerations:

a. Authorizing record. The task body says the CA policy "requires the
   intended phishing-resistant MFA/authentication strength." Read
   strictly, the existing policy does not match.

b. Canonical plan. §10 of the plan explicitly authorizes a documented
   deviation to "plain MFA" when the trial doesn't surface the
   phishing-resistant strength, with the deviation recorded. The builder's
   snapshot does not record whether the phishing-resistant strength is in
   fact absent or merely unselected. The two outcomes produce different
   architectural meaning:
   - If phishing-resistant is unavailable on this tenant: plan's
     deviation clause applies; the call is still a human call but the
     architecture no longer demands phishing-resistant as a hard gate.
   - If phishing-resistant is available: the existing policy is
     misconfigured relative to D-4 and the authorizing record; repairing
     it is a separate mutation the swarm is not authorized to perform.

c. Risk posture of each human option.
   1. Authorize strength change to Phishing-resistant MFA, then enable
      (2 mutations). Matches D-4 and the authorizing record. Highest
      assurance; smallest deviation from what's written in the swarm
      contract. Recommended.
   2. Accept built-in "Multifactor authentication" and enable (1
      mutation). Architecturally weaker — D-4's phishing-resistant goal
      is not met. The plan tolerates it only as a documented deviation
      and only when phishing-resistant is genuinely unavailable. Without
      the availability check, choosing this option has no documented
      justification chain.
   3. Repair manually in portal and re-run. Same end state as (1) but
      disperses the change outside the audit channel this swarm is
      building. Precedent cost.

   Architecture recommendation: option 1, with a one-line preflight
   addition that reads the tenant's available authentication strengths
   and attests the phishing-resistant strength exists. If that read shows
   the strength does not exist on this tenant, fall back to option 2 as
   the documented deviation per plan §10.

## 5. Architectural findings

A-1. Canonical plan missing from main
     docs/security/sec-02-isolated-p1-proof-plan.md is referenced as the
     canonical authority but exists only at 8bb088ba, not at main
     (89639f66). Either it was never merged, or was removed. The swarm
     task body quotes §D-4 / §10 from it. Architecture concern: a
     canonical contract must be a live artifact. Recommended: restore or
     re-land the plan file before the executor lane runs; treat 8bb088ba
     as a historical pointer, not the working copy.

A-2. Mutation authority is correctly scoped
     The builder's self-limitation to the reviewer-gated REPORT-ONLY →
     ENABLED single mutation, and its refusal to touch authenticationStrength
     without explicit authorization, is the right call and consistent with
     AGENTS.md §3's ownership/discipline rules. No remediation.

A-3. Plan vs. task-body: phishing-resistant is preferred, not absolute
     The canonical plan (§10) explicitly anticipates falling back to plain
     MFA with a documented deviation; the task body's stricter language
     ("the intended phishing-resistant ... strength") is the operational
     instruction the executor was told to apply. These two are reconcilable
     only by (i) checking phishing-resistant availability on the tenant,
     and (ii) if available, taking that path; if unavailable, recording
     the deviation. This is the only safe ordering.

A-4. Redaction at the display-name layer
     Builder's snapshot hashes GUIDs/tenant-id but leaves Opnory-owned
     display names in plain text. Given those names are already committed
     to the canonical plan and the task body, the practice is defensible
     for Opnory-specific nouns; it must not extend to user principals,
     UPNs, emails, IP addresses, tenant-specific hostnames, or anything
     identifying a real person or subscription. Add this rule to the
     executor's proof script before resumption.

A-5. No live-token / JWT evidence yet
     No lane can claim SEC-02 token-side or sign-in-side evidence: policy
     was never enabled; no proof user signed in; no MFA happened. SEC-02
     remains UNPROVEN on the evidence, correctly.

A-6. Frozen governance / Gate 3 OIDC code untouched
     Verified by git diff in this worktree: no changes to
     `packages/governance-core/src/adapters/*`, `apps/api/src/auth/oidc.ts`,
     or any other Gate 3 / frozen surface. Repository safety constraint
     satisfied so far.

## 6. What is NOT yet established (evidence we do not have)

- Phishing-resistant MFA authentication-strength availability on this
  tenant (not present in the preflight snapshot fields).
- Whether the JWT groups-claim mapping still agrees with current Opnory
  role mapping at runtime under the new tenant (Gate 3 proof was on the
  old tenant).
- Any negative-control result.
- Final CA policy disposition (post-proof state) — flagged in task body
  as requiring human decision.

## 7. Recommendation to verifier (t_39500000)

- Do not gate "pass". The implementation lane is blocked at a real
  human-action boundary: mutation authorization for CA-policy state change
  (and optionally strength change). The plan §10 availability question
  must be answered with evidence before any recommendation between
  options (1) and (2) is honest.
- Require the human to choose between the three documented options.
- If option (1) is chosen, require a supplementary preflight step that
  reads the tenant's authenticationStrength policies and records their
  hashed identifiers before mutation.
- If option (2) is chosen, require a written "phishing-resistant not
  available on this tenant" or "deviation accepted" note appended to the
  evidence chain, with no further strength claim.
- Block on A-1 (canonical plan file absent on main) before further
  executor work; the executor lane must reference a present, dated
  artifact rather than a commit hash.

## 8. Final state for this review

SEC-02 status: UNPROVEN. Builder's BLOCKED is architecturally correct.
No repository or Microsoft mutations performed by this lane.

Final state: BLOCKED — HUMAN ACTION REQUIRED (matches t_2e2a756e's
state; this review reinforces it with the plan-reconciliation note above
and an explicit ask on phishing-resistant-strength availability).
