# AWS lab executor IAM policy (least privilege)

`opnory-lab-executor.policy.json` is the **sole attachment** for the dedicated
IAM user `opnory-lab-executor` that runs live lab proofs. It is committed with
placeholders — `<ACCOUNT_ID>`, `<CANONICAL_OWNER_ID>`, `<STATE_BUCKET>` — that
the human operator fills in at policy-creation time in the console. Real
values are never committed to this repository.

This policy is the corrected form of the Phase 1B-COST-SAFETY security design
(§3, worker t_79216dcd): 15 statements, 57 distinct Allow actions, every EC2
write ARN-scoped to `arn:aws:ec2:us-east-2:<ACCOUNT_ID>:<type>/*`.

## Hard prohibitions baked into this policy

- No `AdministratorAccess`, no `PowerUserAccess`, no managed policies, no
  groups carrying additional policies.
- No `iam:*` — the principal cannot modify itself or anything in IAM.
- No `organizations:*`, `controltower:*`, `savingsplans:*`, no
  `PurchaseReserved*`/`Purchase*` of any kind, no `aws-marketplace:*`.
- No billing/portal/account actions: `aws-portal:*`, `billing:*`, `account:*`
  are absent by omission (implicit deny).
- No Elastic IP (`ec2:AllocateAddress` absent), no NAT Gateway
  (`ec2:CreateNatGateway` absent), no ELB/ALB/NLB (`elasticloadbalancing:*`
  absent), no RDS, no EKS, no Route 53, no DynamoDB, no KMS.

## Cost-safety design points

- **Destroy is the cost-safety egress** (F1): `LabVpcDestroy` and the
  instance-terminate actions are granted unconditionally — no tag conditions
  on destroy-side statements, so a partial or untagged state can still be
  destroyed and never leaves metered compute running.
- **Instance pinning** (F4): `ec2:InstanceType=t3a.medium` and
  `ec2:MetadataHttpTokens=required` are IAM conditions on the `instance/*`
  half of `RunInstances`; the HCL variable validation pins the same values, so
  the two layers agree and a drift in either breaks the launch (fail closed).
- **AMI owner allow-list** (F3): the `image/*` half of `RunInstances` carries
  `ec2:Owner = <CANONICAL_OWNER_ID>`, plus an explicit **Deny** for
  `ec2:Owner = aws-marketplace`. Paid marketplace images are structurally
  unreachable.
- **S3 state surface**: exactly the five actions the OpenTofu S3 backend
  documents (`ListBucket`, `GetObject`, `PutObject`, `DeleteObject`,
  `PutObjectTagging`), scoped to the state bucket and the `lab.tfstate*`
  key prefix.

## Permissions that cannot be resource-scoped (documented, AWS-mandated)

| Action | Why `Resource: "*"` (or type-level ARNs) is unavoidable | Residual risk |
|---|---|---|
| `ec2:Describe*` (15 list-type actions) | List-type actions define no resource types in the AWS Service Authorization Reference; they cannot carry resource ARNs at all. | Read-only within one account; cannot mutate anything. |
| `sts:GetCallerIdentity` | Identity action returning the caller's own identity; supports no resource scoping. | None — it is itself the identity check. |
| `s3:ListBucket` | Bucket-level action; the bucket ARN is its only scoping (used). | None — scoped to the state bucket. |
| Create-actions (`CreateVpc`, `CreateSubnet`, `CreateInternetGateway`, `CreateRouteTable`, `CreateRoute`, `CreateSecurityGroup`, `ImportKeyPair`, `RunInstances`) | The resource does not exist at policy-evaluation time; the narrowest pre-creation scope AWS supports is `account:region:type/*`. | Bounded to one account, one region, one resource type per statement; `RunInstances` further conditioned on instance type, IMDSv2 and AMI owner. |
| `ec2:Authorize/RevokeSecurityGroup{Ingress,Egress}` on the `security-group-rule` half | The rule ID is service-generated; its ARN tail cannot be pre-pinned. | Bounded to `security-group-rule/*` in this account/region. |

Everything else in the policy is ARN-scoped.

## Operator procedure (human, out-of-band; this task creates nothing)

1. Console (root, MFA): create IAM user `opnory-lab-executor`,
   programmatic access only.
2. Copy `opnory-lab-executor.policy.json`, replace the three placeholders:
   - `<ACCOUNT_ID>` — the 12-digit lab account id;
   - `<CANONICAL_OWNER_ID>` — the Canonical owner id you verified in the
     console for the Ubuntu Noble 24.04 amd64 AMI (this is the same value
     you will pass as `ami_owner` tfvar and record as
     `allowed_provider_account_hint` context in the uncommitted target file);
   - `<STATE_BUCKET>` — the state bucket name.
3. Attach it as the sole inline/managed policy. Do not attach anything else.
4. Create ONE access key. Store it only in your shell environment
   (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION=us-east-2`) or a
   0600 profile outside the repo. Never commit it, never pass it via
   `-backend-config` (the S3 backend resolves credentials from the standard
   env chain only).
5. Create the S3 state bucket out-of-band per
   `infra/environments/lab/STATE-BACKEND.md` (versioning ON; deny
   non-TLS writes).

Root credentials: console-only, MFA-enabled, **never** access keys, never in
the environment, never used by OpenTofu. The live preflight enforces this by
refusing any `sts:GetCallerIdentity` ARN matching `arn:aws:iam::<acct>:root`.
