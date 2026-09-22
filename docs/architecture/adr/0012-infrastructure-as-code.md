# ADR 0012 — Infrastructure as Code: layered authority model and provider contract

**Date:** 2026-09-22
**Status:** Accepted (Phase 1A — implementation verified, live reproducibility proof pending)
**Authors:** Opnory Core Team
**Related:** ADR 0002 (RBAC as Governance Foundation), ADR 0003 (Fulfillment
Adapter Conformance Contract), ADR 0006 (Production Tenant Integration
Lifecycle), ADR 0010 (AWS Compatibility through Floci), ARCHITECTURE_FREEZE.md

## Context

Opnory needs a reproducible, disposable one-host lab environment: an
infrastructure stack that can be created from zero, configured, deployed,
verified, destroyed, and recreated with no manual host configuration. This
precedes any live cloud mutation. Phase 1A builds and statically verifies the
repository-side implementation only; live proof is deferred to a later gated
phase (1B).

Existing operational material in `ops/self-hosted*` and `ops/gate3-*` are
historical, frozen evidence stacks. They record completed proofs and must not
be converted in place. This ADR establishes a new canonical infrastructure
layer under `infra/`, distinct from those evidence artifacts.

The repository today contains no cloud-provider credential configuration and
no committed provider integration for compute. Gate 2's TLS proof ran on a
home-lab bridged VM behind a residential router with temporary DNS records;
that pattern is a manual proof rig, not an IaC foundation.

## Decision

### 1. Layered authority model

Authority over the lab stack is partitioned across exactly five layers. Each
layer has one job. No layer may absorb the job of another.

| Layer | Authority over | Explicitly not responsible for |
|---|---|---|
| **OpenTofu** | Resource lifecycle: compute, network, disks, DNS records, infrastructure identity (service accounts, instance profiles) | Installing OS packages, deploying applications, firewall rule content beyond the cloud SG/minimum ingress, application configuration |
| **cloud-init** | First-boot bootstrap of a brand-new OS: deployment user creation, SSH public-key installation, prerequisites required for Ansible takeover, unavoidable one-time OS initialization | Deploying Opnory, owning firewall policy, containing Compose definitions, implementing backups, becoming a general installer script |
| **Ansible** | Repeatable host state: OS baseline, Docker Engine + Compose plugin, `/srv/opnory` layout, ownership and permissions, host firewall, systemd integration, log directories, backup timers/prerequisites, observability prerequisites | Resource lifecycle, application image/content decisions beyond enablement |
| **Docker Compose** | Application workload topology: which services run, their images, ports, networks, volumes, environment references | Provisioning hosts, cloud resources, host firewall |
| **Shell / Python / TypeScript** | Procedural glue: rendering templates, probes, destructive tests, evidence generation, preflight checks | Owning policy or durable state |

**GitHub Actions** orchestrates these layers and enforces policy gates (PR
checks, environment-protected apply, no fork-PR access to credentials).

**Invariant:** collapsing any two of these layers into one script or tool is
an architecture-freeze violation and must be rejected at review time.

### 2. Repository layout

```
infra/
├── README.md
├── modules/
│   ├── host-contract/      # the stable output contract every provider must expose
│   ├── dns/                # DNS record resources (provider-pluggable)
│   └── firewall-policy/    # minimal ingress policy
├── providers/
│   └── <initial-provider>/ # exactly one initial implementation in Phase 1A
│       ├── compute/
│       ├── network/
│       └── storage/
├── environments/
│   ├── lab/                # the only environment with real resources in Phase 1A
│   ├── staging/            # contracts/documentation/placeholders only
│   └── production/         # contracts/documentation/placeholders only
├── bootstrap/
│   └── cloud-init/
└── ansible/
    ├── inventories/
    ├── roles/
    │   ├── base/
    │   ├── docker/
    │   ├── firewall/
    │   ├── opnory/
    │   ├── observability/
    │   └── backup/
    └── site.yml
```

`environments/staging/` and `environments/production/` must not create
resources in Phase 1A. Their presence defines the named future environments
without granting authority over them.

### 3. Provider contract (the stable downstream interface)

Every compute implementation must expose only a small, stable set of outputs
needed by configuration/deployment:

| Output | Type | Purpose |
|---|---|---|
| `host_address` | string (IP or FQDN) | Reachable address Ansible and operators use |
| `private_address` | string | Internal-address for host-local service binding where needed |
| `dns_name` | string (FQDN) | Public name that resolves to `host_address` |
| `environment` | string (`lab` \| `staging` \| `production`) | Selection and tagging discriminator |
| `storage_ref` | optional opaque string | Reference to attached block/object storage **only when** downstream configuration genuinely requires it; a mount path or volume ID, not a credential |

**Forbidden as ordinary OpenTofu outputs or variables:**

- PostgreSQL connection URLs
- S3 credentials, access keys, secret keys
- provider API tokens
- SSH private keys
- application secrets of any kind
- passwords

Application secrets are supplied independently of infrastructure state. They
travel through the existing `SecretStore`/`CredentialProvider` boundary on the
target host (see ADR 0006), referenced by opaque `credentialRef`, and never
enter `.tfstate`, plan files, or outputs.

### 4. Provider neutrality through contract, not abstraction

Provider neutrality is achieved through the stable `host-contract` module
boundary and the small output set above. **We do not build a universal
multi-cloud abstraction layer.** Each provider implementation lives under
`infra/providers/<name>/` and conforms to the contract. Swapping providers is
a deliberate, one-provider-at-a-time operation; it is not a runtime toggle.

Do not introduce generalized Azure/AWS/Hetzner/GCP compatibility shims in
Phase 1A.

### 5. Initial provider selection

**Status: unresolved — live execution blocked until resolved.**

Repository evidence shows no committed provider credential configuration and
no prior cloud-compute integration. Gate 2's TLS proof ran against a
manually-provisioned home-lab VM. Phase 1A therefore:

- implements the contract, modules, and environment scaffolding against a
  documented, explicitly-tagged **initial provider implementation**;
- the implementing worker (opnory-builder) may select exactly one provider
  based on existing repo research and operational constraints; if no provider
  can be responsibly selected from evidence, the implementation ships the
  contract plus a documented placeholder and **blocks live execution** rather
  than fabricating a choice.

Infrastructure identity and DNS for the lab follow the selected provider's
native primitives. If Cloudflare is confirmed as the authoritative DNS for
the relevant zone, DNS records are modelled through the Cloudflare provider
rather than via scripts.

### 6. Remote-execution and provisioner prohibition

OpenTofu `remote-exec` and large `provisioner` blocks are **prohibited**.
OpenTofu declares resources; cloud-init bootstraps once; Ansible converges
repeatable state. Any task that is neither "create a resource" nor "first-boot
bootstrap" belongs in Ansible.

cloud-init's allowed scope is exactly:

- create the deployment user;
- install the SSH public key;
- install only the prerequisites required for Ansible takeover (Python, pipx,
  etc.);
- perform unavoidable one-time OS initialization.

cloud-init must not deploy Opnory, own firewall policy, contain Compose
definitions, implement backups, or grow into a shell installer.

### 7. Historical evidence preservation

`ops/self-hosted/`, `ops/self-hosted-seaweedfs/`, `ops/gate3-*/`, and the
frozen Gate 2 branch are **unchanged evidence sources**. Phase 1A does not
convert, rename, or "modernize" them. The new canonical runtime Compose
stack lives under `infra/` (or a location the builder documents) and is a
fresh definition informed by — not a rename of — the historical stacks.

### 8. State, secrets, and trust boundaries

- OpenTofu state is out-of-band (remote backend) with server-side encryption
  and access logging. No `.tfstate`, plan binaries, generated inventory,
  runtime `.env`, storage credentials, SSH private material, or provider
  credentials are committed.
- GitHub OIDC federation is the preferred provider authentication where
  supported. Long-lived cloud keys in repo secrets are a fallback requiring
  explicit justification.
- A public-repository fork PR must never receive deployment credentials or an
  OIDC trust relationship capable of provisioning infrastructure. `apply`
  runs only under a protected GitHub Environment; merge-to-main alone is not
  cloud authority.
- Secret scanning and IaC static analysis run on every PR.

### 9. Compose runtime scope

The canonical runtime stack includes only the components the current Opnory
milestone actually requires. The candidate set (Opnory API/services, Slack
integration where required, PostgreSQL, Redis, Qdrant, SeaweedFS, Tempo,
Grafana, Caddy) is a **menu, not a mandate** — include only what is used.
OpenTofu never manages individual Docker containers.

### 10. Explicit non-goals for Phase 1A

- Kubernetes, managed Kubernetes, Packer, Terragrunt
- autoscaling, load balancers, multi-host runtime
- multi-node SeaweedFS, HA topologies
- managed PostgreSQL or other managed data services
- large platform abstractions

## Consequences

**Positive:**

- One disposable lab can be repeatedly created and destroyed from zero.
- Clear ownership boundaries prevent layering violations during parallel
  implementation.
- Provider contract isolates future provider swaps to a single directory.
- Historical evidence remains untouched and citable.

**Negative / deferred:**

- Live reproducibility is unproven until Phase 1B completes two
  create-verify-destroy cycles from zero.
- Initial provider choice is not yet validated against live credentials.
- Staging and production environments are placeholders only.

## Phase 1B gate

The strongest claim Phase 1A supports is:

> IAC PHASE 1A IMPLEMENTATION VERIFIED — LIVE REPRODUCIBILITY PROOF PENDING

Only after the two-cycle destructive acceptance run (apply → cloud-init →
Ansible convergence → Compose up → Opnory verification PASS → no-drift plan
→ idempotent second Ansible run → destroy → repeat from zero → PASS) does
the claim advance.
