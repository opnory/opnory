# SEC-02 / Entra MFA — Consolidated Isolated Conditional Access Proof Plan (PLANNING ONLY)

**Status: BLOCKED — HUMAN ACTION REQUIRED.** No execution is permitted until the
human provisions an isolated proof tenant and authorizes the four mutations in
§11. See §12 for the final state.

Date: 2026-09-18
Synthesizer task: `t_7f85179a` (swarm root `t_c7281df4`, verifier `t_c19503c7` — gate PASS)
Base: `main` @ `89639f66`

This document consolidates three swarm lanes into one authoritative plan:

- `t_b6ed7a05` (opnory-security) — committed proof plan; used as the structural base.
- `t_48ccb4ae` (opnory-builder) — two-signal amr/acrs rubric, licensing and role
  minimums, deterministic policy naming; folded in.
- `t_025343a4` (opnory-architect) — architecture boundary review, role minimums,
  non-admin negative control; folded in.

Where lanes diverged, this document picks one answer and records the choice in
§13. No lane performed any Microsoft-side mutation.

**Non-claims (mandatory):**

- Zero Microsoft-side mutations were performed by this swarm.
- No tenant settings, Security Defaults, Conditional Access, licensing, consent,
  app registrations, identities, groups, secrets, or network ingress were changed.
- SEC-02 remains **UNPROVEN/PLANNED**. Nothing in this document upgrades it.
- Existing Gate 3 Entra OIDC evidence (`ops/gate3-entra/EVIDENCE.md`) and current
  Security Defaults behavior are preserved and not rewritten.
- The frozen files in `packages/governance-core/src/adapters/` are untouched.

---

## 1. Current factual state (reconciled against merged evidence)

Authoritative repo sources: `docs/security-soc2-readiness-control-matrix.md`,
`docs/security/gate3-sso-oidc-mfa-design.md` (D-1..D-6 locked 2026-09-13),
`ops/gate3-keycloak/EVIDENCE.md`, `ops/gate3-entra/EVIDENCE.md`,
`docs/observability-gate2-tls-live-proof.md`, `SECURITY.md`, `AGENTS.md`.

| Fact | Evidence |
|---|---|
| Gate 3 provider-neutral OIDC access-token validation is implemented and merged | PR #12 (`apps/api/src/auth/oidc.ts`) |
| Gate 3 route boundary is covered by automated contract tests | `apps/api/src/security-regression.test.ts`, `acceptance.test.ts` |
| Keycloak live-local OIDC proof (positive + negative route matrix, real JWKS) | PR #13, `ops/gate3-keycloak/EVIDENCE.md` |
| Entra live-local OIDC proof (real Entra user token → signature/issuer/audience/expiry → groups → role mapping → business handler) | PR #14, `ops/gate3-entra/EVIDENCE.md` |
| Entra `groups` claim → `roleGroupMap` → `platform-admin` traversal proven at the route boundary | `ops/gate3-entra/EVIDENCE.md` |
| Entra MFA | **UNPROVEN** — `ops/gate3-entra/EVIDENCE.md` records: Security Defaults blocked the device-code grant before any MFA challenge; no MFA claim is made |
| Entra tenant tier | Free; Conditional Access **not licensed**; CA policy list empty |
| Security Defaults | **ENABLED** (authoritative human read-only observation, 2026-09-18); current Graph grant cannot read it; preserved, not modified |
| 2026-09-13 readiness matrix | **Stale in part**: SEC-01 now has evidence (PRs #12/#13/#14); SEC-02 still PLANNED. Matrix is updated only after live SEC-02 evidence exists |
| Locked design D-4 | MFA = IdP-enforced, phishing-resistant (WebAuthn/passkeys) at Entra via Conditional Access; no app-built TOTP |
| Locked design D-5 | Break-glass (SEC-03) = dedicated emergency identities through the normal auth flow, physical-safe custody; not a DB/API bypass |

## 2. Decision-tree result: CASE 1

Security Defaults = ENABLED and Conditional Access = NOT LICENSED
implies **CASE 1: ISOLATED P1 PROOF TENANT RECOMMENDED**.

Security Defaults and Conditional Access are mutually exclusive tenant states.
Microsoft refuses CA policy creation while Security Defaults is on, and enabling
Security Defaults requires removing every CA policy. Proving SEC-02 in the
current tenant would require disabling Security Defaults, which is prohibited and
would weaken an established anchor. An isolated disposable tenant is the smallest
safe environment.

## 3. What remains unproven for SEC-02

1. A Conditional Access policy requiring MFA (preferably phishing-resistant
   authentication strength) actually challenges at sign-in.
2. The Opnory API path receives a token whose `amr` claim contains `mfa`
   (and, if phishing-resistant methods are used, a method like `fido2`,
   `windowshello`, or `x509`), obtained from a real Entra sign-in that
   traversed the CA policy.
3. A CA-side signal — `acrs` claim showing the authentication-strength policy
   ID, or the proof-tenant sign-in log showing the CA policy applied with
   result Success and authentication requirement = multifactor.
4. Negative control: a sign-in that does not satisfy the policy is refused
   (AADSTS50076 / AADSTS53003-class) and produces no usable access token.
5. Sanitized evidence retained in the repo sufficient to move SEC-02 from
   PLANNED to PROVEN for the proof environment.

The merged Entra proof deliberately did not assert any `amr`/MFA claim. SEC-02
evidence requires a new live exercise; existing artifacts stay as-is.

## 4. Proposed isolated-P1 proof topology

**Environment (all new, disposable, zero overlap with the current Opnory tenant):**

- One isolated Entra ID tenant (freshly created tenant + Entra ID P1 trial bound
  to it; trial gives 30 days of CA). A new tenant is required: no existing
  isolated P1-capable tenant is documented in the repo, and task rules prohibit
  assuming one.
- Identities (minimum set):
  - `ca-admin@<proof-tenant>` — proof administrator used only to configure CA;
    excluded from the policy itself.
  - `mfa-proof-user@<proof-tenant>` — the proof subject; the user the OIDC flow
    runs as. Registered with at least one phishing-resistant method
    (passkey/FIDO2; Microsoft Authenticator only as a documented deviation if
    hardware is unavailable).
  - `breakglass@<proof-tenant>` — emergency account, excluded from every CA
    policy, long random password stored offline; login verified before any
    policy is enabled. This is a configuration fact for the proof environment,
    not the SEC-03 control itself.
- One app registration: `opnory-sec02-proof` — public client, redirect
  `http://localhost:<port>/callback`, delegated `User.Read` plus the custom
  scope that mirrors the existing Gate 3 proof app pattern (`access_as_user`).
  No client secret, no certificates, no application permissions, no admin
  consent beyond the user's own grant.
- One group: `opnory-platform-admins` containing only `mfa-proof-user`, with
  `securityEnabled`, to exercise the groups-claim mapping already proven in
  PR #14.

**Licensing minimum:**

- Microsoft Entra ID **P1** only. P2 (PIM, Identity Protection) is not required
  for SEC-02 evidence.
- P1 licenses needed for exactly two identities: `ca-admin` and
  `mfa-proof-user`. The break-glass identity is excluded from CA and does not
  need a license for policy-exclusion mechanics.

**Role minimum (proof tenant):**

| Identity | Required role |
|---|---|
| `ca-admin` | `Conditional Access Administrator` + `Application Administrator` (use `Global Administrator` only for initial bootstrap; tighten to least privilege before evidence is captured) |
| `mfa-proof-user` | none — ordinary user |
| `breakglass` | `Global Administrator`, excluded from every CA policy |

**Conditional Access policy (single, deterministic):**

- Name: `SEC02-proof-require-mfa` (commit a date-stamped alias
  `opnory-sec02-mfa-proof-<iso-date>` if the proof run spans days; one policy
  only, never both).
- Users: include `mfa-proof-user` only. Do not target groups or All Users.
- Target resources: the `opnory-sec02-proof` app only. Do not target
  All cloud apps — that is the accidental-lockout footgun.
- Conditions: defaults (all client apps, any location).
- Grant: **Require authentication strength = Phishing-resistant MFA** if the
  trial surfaces authentication-strength controls (preferred per D-4);
  otherwise fall back to **Require multifactor authentication** and record the
  deviation.
- Session: none. State: report-only for one rehearsal pass, then **On**; sign-in
  logs are retained from both states.
- Exclusions: `breakglass` everywhere; no other exclusions.

**Authentication flow:**

Authorization code + PKCE (S256) against the proof app — the same flow proven
in `ops/gate3-entra/EVIDENCE.md`. Device-code is known-blocked and
inappropriate. The provider-neutral OIDC seam (`apps/api/src/auth/oidc.ts`)
consumes the resulting token unmodified; the proof tenant's issuer, JWKS,
audience, and group map are supplied via config. **No code change is required**
for the positive path (established by PR #14).

## 5. Proof matrix (positive and negative controls)

All API calls are on loopback only, same posture as the Gate 3 proofs. Ports
80/443 stay closed; Gate 2 ingress is untouched.

| # | Case | Expected result | Claim exercised |
|---|---|---|---|
| P1 | `mfa-proof-user`: fresh PKCE sign-in; CA prompts MFA; user satisfies it; token obtained | Token `amr` contains `mfa` (plus `fido2`/`windowshello`/`x509` if phishing-resistant); sign-in log shows the CA policy applied with result Success and authentication requirement = multifactor; `GET /v1/access/requests/:id` → 404 (auth+authz pass, handler reached) | SEC-02 positive |
| P2 | Same token after expiry (or fresh sign-in) | 401 on expired token | Baseline re-verified, unchanged from Gate 3 |
| N1 | `mfa-proof-user`: sign-in attempted, MFA challenge abandoned or failed | Token issuance fails (AADSTS50076 / AADSTS53003-class); no usable token reaches the API | SEC-02 negative: no MFA, no token |
| N2 | Sign-in where the policy targets the user but the grant cannot be satisfied; capture the sign-in log entry showing CA policy applied with result = failure and the AADSTS code | Sanitized log evidence retained | Policy actually fired, denial attributed to CA (not `notApplied`) |
| N3 | `ca-admin` (excluded) obtains a token for the proof app; its `amr` reflects its own auth; its group membership is unmapped; protected route returns 403 | Policy is scoped to `mfa-proof-user` only, not a tenant-wide accident | Scope control |
| N4 | Token issued for a different audience/scope presented to `apps/api` | 401 from the existing audience/issuer validation | Already covered by #12 contract tests; re-confirmed live |

**MFA-satisfaction rubric for P1 — all three required:**

1. Token `amr` claim contains at least one MFA-valued method.
2. Proof-tenant sign-in log shows the CA policy applied with result Success and
   authentication requirement = multifactor (and, when an auth-strength policy
   is used, the token's `acrs` references it).
3. API request traverses to the business handler (404 on the test route).

Receiving a token alone does not count as MFA proof.

## 6. Evidence retention and redaction plan

Commit one new file, `docs/security/sec-02-entra-mfa-proof.md`, following the
sanitization discipline in `ops/gate3-entra/EVIDENCE.md` and `SECURITY.md`:

- Tenant ID, client ID, user ObjectIDs, group ObjectID, CA policy ID,
  correlation IDs, subscription IDs, IPs — recorded only as `sha256:` digests.
- The P1/P2/N1/N2/N3/N4 result table with redacted sign-in log fields (policy
  name — which is a chosen non-identifier name — applied/failure result,
  AADSTS code class, authentication requirement).
- The full `amr` value list verbatim: claim values like `["pwd","mfa","fido2"]`
  are method constants, not identifiers, and are safe to record.
- A boundary statement: which identity was scoped, that the current Opnory
  tenant was untouched, and that the proof tenant was returned to a safe state.
- An explicit statement that the evidence covers the isolated proof environment;
  production applicability is tracked separately.
- Mode-0600 ephemeral capture files on the originator's machine, deleted at
  teardown; sign-in-log redacted screenshots stay out of the repo and are
  referenced by hash only.

Forbidden in the repo: tokens, refresh tokens, authorization codes, PKCE
verifiers, passwords, secrets, MFA seeds (TOTP secrets, passkey private
material), raw tenant/user/group/client IDs, raw IPs, raw emails.

## 7. Cleanup plan (return the proof tenant to a known-safe state)

1. Snapshot the proof tenant's final settings (local, out-of-repo).
2. Set `SEC02-proof-require-mfa` to Off, then delete it.
3. Remove license assignments from the test identities.
4. Delete the `opnory-sec02-proof` app registration and its service principal.
5. Delete `mfa-proof-user` and `ca-admin`. Retain `breakglass` only if the
   human elects to keep the tenant; otherwise delete the tenant outright.
6. Verify break-glass still authenticates before any deletion step that could
   orphan the tenant.
7. Cancel the P1 trial before its 30-day boundary; record the calendar date.
8. Query for and confirm zero residual guests, apps, service principals, or
   policies; record sanitized deletion evidence in an appendix to the proof
   document.
9. Delete all local mode-0600 capture files.
10. Commit the sanitized evidence file to this repo only.

## 8. Repository files that change only after a successful proof

- New: `docs/security/sec-02-entra-mfa-proof.md` — sanitized evidence.
- Update: `docs/security-soc2-readiness-control-matrix.md` — SEC-02 row moves
  to a proof-environment-backed state with the artifact linked; stale
  PLANNED phrasing on SEC-01 reconciled against PRs #12/#13/#14.
- Optional: `docs/security/gate3-sso-oidc-mfa-design.md` §7 status table note
  linking to the SEC-02 evidence document.
- No code changes. `apps/api/src/auth/oidc.ts` already consumes any
  issuer/JWKS/audience/group tuple (proven twice). If in-app `amr` enforcement
  is wanted later, that is a separate decision, not part of this proof.

## 9. SEC-03 / break-glass sequencing

SEC-03 does not block SEC-02. The proof uses a break-glass identity as a
CA-policy exclusion inside the proof tenant — a one-line configuration fact.
SEC-03's own evidence (custody, drill, audit) remains a separately bounded
follow-up against the production track and is outside this plan.

## 10. Lane-divergence decisions recorded

Where the three lanes gave different answers, this document picks one:

- **Target scope** — builder's "proof app only," not architect's "app OR All
  cloud apps." Reason: lockout risk dominates; All cloud apps is the documented
  footgun.
- **Policy grant** — prefer "Require authentication strength = Phishing-resistant
  MFA" when the trial surfaces it; fall back to plain "Require MFA" with a
  documented deviation. This keeps D-4 honored where possible without
  over-promising on trial capabilities.
- **Roles for `ca-admin`** — least-privilege pair (`Conditional Access
  Administrator` + `Application Administrator`) as the steady state; Global
  Administrator only during bootstrap. Architect's framing.
- **Authentication-strength policy ID** — the well-known multi-factor-strength
  policy ID `00000000-0000-0000-0000-000000000004` is a public Microsoft
  constant, not an identifier. The phishing-resistant-strength ID must be
  confirmed at proof time from the proof tenant and recorded as a digest.
- **Break-glass licensing** — excluded from CA and from P1 licensing unless a
  future control requires it; not needed for the exclusion mechanics at issue
  here.

## 11. HUMAN ACTION REQUIRED

The smallest exact action that unblocks execution:

> Provision an isolated, disposable Entra ID tenant for Opnory security proofs
> and authorize, in writing, these four mutations against that tenant only:
>
> a. Activate an Entra ID P1 trial on it.
> b. Create the three test identities (`ca-admin`, `mfa-proof-user`,
>    `breakglass`) and the `opnory-platform-admins` group.
> c. Create the `opnory-sec02-proof` app registration per §4.
> d. Create and enable the single CA policy `SEC02-proof-require-mfa` scoped
>    exactly per §4, with the cleanup steps in §7 scheduled at proof start.
>
> Then supply, via the existing credential channel and never via Git:
> confirmation that the tenant exists, a sanitized label for it, and
> credentials for one configured test identity.

Without that provisioning and written authorization, this work stays
**BLOCKED — HUMAN ACTION REQUIRED**. No execution path exists inside the stated
boundaries: the current tenant is read-only, and creating a new tenant is a
human decision.

## 12. Final state

**BLOCKED — HUMAN ACTION REQUIRED.** The plan is execution-ready pending
isolated-tenant provisioning and the scoped authorization above. Zero mutations
were performed by this synthesizer.

## 13. Mutations performed during this run

None outside this repository. Specifically:

- Zero Microsoft-side mutations (no tenant, licensing, consent, CA, app,
  identity, group, secret, or Security Defaults change; no Graph calls).
- Zero ingress or Gate 2 changes.
- Zero changes to frozen files, Gate 3 OIDC validation, or the existing merged
  evidence documents.
- One new planning document added in this worktree: this file.

## Syn reference

- Swarm root: `t_c7281df4` (CASE 1).
- Verifier: `t_c19503c7` — gate PASS, consolidator instruction recorded.
- Lanes: `t_b6ed7a05` (security, committed 2d561e92), `t_48ccb4ae` (builder),
  `t_025343a4` (architecture).
