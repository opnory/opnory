# ADR 0002: RBAC as Governance Foundation

## Status

Accepted

## Context

Opnory manages identity governance workflows across multiple providers.

RBAC concepts such as roles, permissions, and assignments are necessary authorization primitives, but do not represent the complete governance lifecycle.

A role assignment without lifecycle metadata cannot answer:

- Who requested access?
- Who approved it?
- Why was access granted?
- Which provider fulfilled it?
- When should it expire?
- Was revocation verified?

## Decision

Opnory models governance as:

request → approve → fulfill → verify → revoke → evidence

RBAC provides the entitlement vocabulary:

Role
↓
Permission
↓
Provider mapping

Governance manages the lifecycle:

Subject
↓
RoleAssignment
↓
PolicyDecision
↓
Fulfillment
↓
EvidenceEvent

## Provider Boundary

Providers are fulfillment targets, not governance authorities.

Examples:

Entra:
Permission → Group membership / App role assignment

Okta:
Permission → Group membership / Application assignment

GitHub:
Permission → Team membership

## Consequences

Benefits:

- Provider-independent policy engine
- Consistent audit model
- Multi-provider lifecycle management
- Easier certification

Tradeoffs:

- More explicit domain modeling
- Provider adapters require mappings
- Governance state must be maintained by Opnory
