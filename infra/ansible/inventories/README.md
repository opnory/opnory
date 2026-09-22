# inventories/

`lab.yml` is **generated** from OpenTofu outputs — never hand-edit host IPs
here and never commit a rendered inventory that contains a real address
(`*.generated.yml` is gitignored; `lab.yml` below points at the generated
file).

Render:

```sh
cd infra/environments/lab   # after Phase 1B provider exists and apply ran
tofu output -json | ../../ansible/inventories/render_inventory.py \
    > ../../ansible/inventories/lab.generated.yml
```

Group `opnory_lab` members must expose host vars: `ansible_host`
(= contract `host_address`), `private_address`, `dns_name`, `environment`,
and optionally `storage_ref`.
