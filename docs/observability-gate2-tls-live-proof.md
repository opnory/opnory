# Gate 2 — sanitized durable evidence for the completed TLS live proof

## Status of this document

This document is **durable, sanitized evidence** for a **temporary** TLS live
proof that has already been completed and torn down.

This document **records** the proof. It **does not** rerun it. The temporary
public DNS, temporary WAN forwarding, and temporary public TLS termination were
disassembled after the proof, as described in §9.

**Not claimed by this gate:** certificate HA, multi-node proxy availability,
SSO/auth/authz (that is Gate 3), overall observability production-readiness.

**Frozen Gate-2 implementation (reference only):**
`feat/observability-hardening-gate2-tls` at
`6077f30a3f89826230fea5a19b2a35efb8017a5a`. The frozen branch is **not**
modified by this evidence document; it is only **referenced** by SHA.

---

## 1. Frozen implementation

The proof was exercised from a detached, clean worktree of the frozen Gate-2
branch:

- Frozen branch: `feat/observability-hardening-gate2-tls`
- Frozen SHA: `6077f30a3f89826230fea5a19b2a35efb8017a5a`
- Frozen branch is equal to `origin/feat/observability-hardening-gate2-tls`.
- Frozen worktree (detached HEAD at `6077f30a3f89826230fea5a19b2a35efb8017a5a`)
  was clean.
- `ops/observability-gate2/` tree and assets were unchanged throughout the
  proof.

Frozen Gate-2 integrity is established by the frozen branch SHA, the
origin-equality check, the clean detached worktree, and the unchanged
`ops/observability-gate2/` tree. It is **not** derived from any unrelated
governance-core hash (e.g. `packages/governance-core/src/adapters/fulfillment.ts`),
which is a separate, unrelated frozen boundary and is deliberately not used
here as the integrity proof for Gate-2 assets.

## 2. Architecture exercised

```text
Internet
  -> public DNS ("DNS-only" A record for observability.opnory.com)
  -> IPv4 router forwarding TCP 80 + 443
  -> bridged Gate-2 VM
  -> Docker-aware host firewall
  -> Caddy TLS termination (ACME HTTP-01 issuance)
  -> private Grafana (container network)
  -> private Tempo   (container network)
  -> private SeaweedFS (container network)
```

IPv6 public ingress was intentionally excluded and blocked. There was no AAAA
record for the public hostname; the public proof was IPv4-only.

## 3. Certificate evidence

- Hostname: `observability.opnory.com`
- CA: Let's Encrypt
- Issuer: `YE1`
- Validity window:
  - Not Before: `2026-09-17T00:53:27Z`
  - Not After: `2026-12-16T00:53:26Z`
- Subject Alternative Name matched the hostname.
- System-trust verification succeeded.
- `openssl s_client -verify_return_error` succeeded.
- `openssl s_client -verify_hostname observability.opnory.com` succeeded.
- **No certificate and no private key was committed to the repository.**

## 4. TLS behavior

Exercised against the public hostname during the temporary proof window:

| Check                    | Result   |
| ------------------------ | -------- |
| `HTTPS /healthz`         | `200 ok` |
| `HTTP -> HTTPS` redirect | `308`    |
| TLS 1.2                  | accepted |
| TLS 1.3                  | accepted |
| TLS 1.0                  | rejected |
| TLS 1.1                  | rejected |
| SSLv3                    | rejected |

## 5. Negative public surface (externally absent)

Distributed off-LAN probes confirmed the following were **not** publicly
reachable during the proof:

- SSH `tcp/22`
- Grafana `tcp/3000`
- Tempo `tcp/3200`
- OTLP `tcp/4317`, `tcp/4318`
- SeaweedFS `tcp/8333`
- Docker management `tcp/2375`, `tcp/2376`

Raw probe-node source IP addresses are intentionally not included in this
document.

## 6. WAN-closure reconciliation

After the temporary Gate-2 forwarding rules were disabled/removed, distributed
off-LAN probes showed TCP 80 and 443 unreachable/filtered.

Separately, probes originating from the home LAN toward the WAN address could
reach the router's local administrative plane through hairpin/NAT reflection.
Those LAN-hairpin observations were **not** treated as evidence of Internet
exposure.

This document does **not** claim that the router admin service was publicly
reachable, and it does **not** claim that the only listener on the public IP
was the router.

## 7. Recovery

- The canonical frozen verifier restarted Caddy as part of its recovery check.
- HTTPS recovered afterward.
- **Recovery proven.**

Certificate HA is **not** claimed. Multi-node proxy availability is **not**
claimed.

## 8. Frozen verifier defect disclosure

The frozen verifier successfully exercised the TLS, certificate, protocol,
negative-port, and Caddy-restart checks. Its Git-hygiene section encountered
the known execution-location defect when run outside a Git checkout; the
equivalent Git-hygiene check was then run against the actual repository and
passed. Frozen verifier semantics were not modified.

(The phrase "canonical verifier passed end-to-end" is intentionally **not**
used.)

## 9. Post-proof teardown

After the proof, the temporary public exposure was torn down:

- Temporary public DNS A record for `observability.opnory.com` removed.
- Authoritative nameservers returned `NXDOMAIN`.
- Recursive DNS convergence confirmed.
- AAAA record absent.
- WAN Gate-2 80/443 unreachable externally.
- Caddy stopped.
- VM 80/443 listener absent.
- Caddy data/config volumes retained.
- Grafana / Tempo / SeaweedFS remained private throughout.

## 10. Git state at time of proof

No product/evidence dirty state remained; the only untracked path observed was
orchestration-owned `.worktrees/` metadata.

## 11. Frozen Gate-2 integrity

Gate-2 asset integrity is established by:

1. Frozen branch SHA `6077f30a3f89826230fea5a19b2a35efb8017a5a`.
2. Origin equality (`feat/observability-hardening-gate2-tls` ==
   `origin/feat/observability-hardening-gate2-tls`).
3. A clean detached frozen worktree.
4. An unchanged `ops/observability-gate2/` tree.

Governance-core frozen boundaries (`packages/governance-core/src/adapters/*`)
were separately untouched, but that fact is **not** used as the integrity
proof for Gate-2 assets and the two frozen boundaries are not conflated.

## 12. Sanitization statement

Consistent with `AGENTS.md` and `SECURITY.md`:

- No public/home WAN IP, LAN IPs, MAC addresses, global IPv6 addresses,
  router serial/device identifiers, private certificate/key material, ACME
  account material, packet-capture source addresses, credentials, or
  Cloudflare tokens are committed.
- The public hostname `observability.opnory.com` and the public certificate
  metadata (issuer, validity window) are retained because they are intrinsic
  to the public TLS claim.

## 13. Scope and non-claims

- Proof was **temporary**; WAN 80/443 were re-closed after the proof.
- No production-readiness, certificate HA, multi-node proxy HA, or SSO/authn/
  authz claim is made by this gate.
- Gate 3 is untouched.
- No infrastructure was modified to produce this document.
- The live proof was **not** rerun to produce this document.
