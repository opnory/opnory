// packages/integration-runtime/test/credential-lifecycle.test.ts
// Credential-lifecycle proof (Phase 6): tenant/plugin-scoped secret resolution
// through the SecretStore boundary, with rotation/revocation/recovery,
// backend-unavailable semantics, and a secret-leak sentinel scan.
//
// Structural guarantee under test (ADR 0006):
//   - Postgres/integration rows retain credentialRef only, never raw material.
//   - SecretStore owns storage/rotation/revocation, always scope-carrying.
//   - CredentialProvider maps SecretRef → narrow ScopedCredential.
//   - credential_backend_unavailable ≠ credential_invalid ≠ provider_unreachable.
//   - Tenant failures stay tenant-isolated; rotation/recovery is idempotent.

import { describe, test, expect } from "bun:test";
import {
  InMemorySecretStore,
  DefaultScopedCredentialProvider,
  SECRET_SENTINEL,
  scanForSecretLeak,
} from "../src/secret-store.js";
import type { SecretScope, SecretMaterial } from "../src/secret-store.js";

const tenantA = "tenant-a";
const tenantB = "tenant-b";
const okta = "okta";
const entra = "entra";

const scopeA: SecretScope = { tenantId: tenantA, pluginId: okta };
const scopeB: SecretScope = { tenantId: tenantB, pluginId: entra };

function materialA(): SecretMaterial {
  return { apiToken: `${SECRET_SENTINEL}_A`, orgUrl: "https://a.okta.com" };
}
function materialB(): SecretMaterial {
  return { clientSecret: `${SECRET_SENTINEL}_B`, tenantId: "entra-b" };
}

describe("Credential lifecycle proof", () => {
  test("A resolves A and B resolves B (self-scope resolution)", async () => {
    const store = new InMemorySecretStore();
    const provider = new DefaultScopedCredentialProvider(store);

    const refA = await provider.provision(scopeA, materialA());
    const refB = await provider.provision(scopeB, materialB());

    const resA = await provider.resolve(scopeA, refA);
    const resB = await provider.resolve(scopeB, refB);

    expect(resA.ok).toBe(true);
    expect(resB.ok).toBe(true);
    if (resA.ok && resB.ok) {
      expect(resA.credential.material.apiToken).toContain(SECRET_SENTINEL);
      expect(resB.credential.material.clientSecret).toContain(SECRET_SENTINEL);
    }
  });

  test("A cannot resolve B ref; B cannot resolve A ref (cross-scope denial)", async () => {
    const store = new InMemorySecretStore();
    const provider = new DefaultScopedCredentialProvider(store);

    const refA = await provider.provision(scopeA, materialA());
    const refB = await provider.provision(scopeB, materialB());

    // A attempts B ref under A's scope → scope mismatch → credential_invalid.
    const aTriesB = await provider.resolve(scopeA, refB);
    expect(aTriesB.ok).toBe(false);
    if (!aTriesB.ok) expect(aTriesB.code).toBe("credential_invalid");

    // B attempts A ref under B's scope → scope mismatch → credential_invalid.
    const bTriesA = await provider.resolve(scopeB, refA);
    expect(bTriesA.ok).toBe(false);
    if (!bTriesA.ok) expect(bTriesA.code).toBe("credential_invalid");
  });

  test("restart-safe: a retained ref resolves through a NEW provider instance backed by the same durable store", async () => {
    // Durable-store simulation: the store OUTLIVES the provider (like Postgres
    // surviving a process restart). The integration row's credentialRef remains
    // valid because the store still holds the material under that ref.
    const durableStore = new InMemorySecretStore();
    const provider1 = new DefaultScopedCredentialProvider(durableStore);
    const refA = await provider1.provision(scopeA, materialA());
    const refB = await provider1.provision(scopeB, materialB());

    // "Restart": a NEW provider instance over the SAME durable store.
    const provider2 = new DefaultScopedCredentialProvider(durableStore);

    const resA = await provider2.resolve(scopeA, refA);
    const resB = await provider2.resolve(scopeB, refB);
    expect(resA.ok).toBe(true);
    expect(resB.ok).toBe(true);

    // A ref never stored anywhere must fail (not accidentally resolve).
    const unknown = await provider2.resolve(scopeA, "secret_ffffffff");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe("configuration_invalid");
  });

  test("rotate A: A uses replacement, B unchanged", async () => {
    const store = new InMemorySecretStore();
    const provider = new DefaultScopedCredentialProvider(store);

    const refA = await provider.provision(scopeA, materialA());
    const refB = await provider.provision(scopeB, materialB());

    const replacement: SecretMaterial = { apiToken: `${SECRET_SENTINEL}_A_ROTATED`, orgUrl: "https://a.okta.com" };
    const newRefA = await provider.rotate(scopeA, refA, replacement);

    const resA = await provider.resolve(scopeA, newRefA);
    const resB = await provider.resolve(scopeB, refB);

    expect(resA.ok).toBe(true);
    if (resA.ok) expect(resA.credential.material.apiToken).toContain("_ROTATED");
    expect(resB.ok).toBe(true);
    if (resB.ok) expect(resB.credential.material.clientSecret).toContain("_B");
  });

  test("revoke A: A degrades (resolves invalid), B remains active", async () => {
    const store = new InMemorySecretStore();
    const provider = new DefaultScopedCredentialProvider(store);

    const refA = await provider.provision(scopeA, materialA());
    const refB = await provider.provision(scopeB, materialB());

    await provider.revoke(scopeA, refA);

    const resA = await provider.resolve(scopeA, refA);
    const resB = await provider.resolve(scopeB, refB);

    expect(resA.ok).toBe(false);
    if (!resA.ok) expect(resA.code).toBe("configuration_invalid"); // ref missing
    expect(resB.ok).toBe(true);
  });

  test("recover A after revoke: re-provision + reconcile resolves A again (idempotent)", async () => {
    const store = new InMemorySecretStore();
    const provider = new DefaultScopedCredentialProvider(store);

    const refA = await provider.provision(scopeA, materialA());
    await provider.revoke(scopeA, refA);

    // Recover: provision fresh material, resolve succeeds.
    const recoveredRef = await provider.provision(scopeA, materialA());
    const resA = await provider.resolve(scopeA, recoveredRef);
    expect(resA.ok).toBe(true);

    // Re-revoking the OLD ref is idempotent (no throw, no effect on recovered).
    await provider.revoke(scopeA, refA);
    const resARecovered = await provider.resolve(scopeA, recoveredRef);
    expect(resARecovered.ok).toBe(true);
  });

  test("secret backend unavailable → credential_backend_unavailable (distinct from credential_invalid)", async () => {
    const store = new InMemorySecretStore();
    const provider = new DefaultScopedCredentialProvider(store);
    const refA = await provider.provision(scopeA, materialA());

    // Simulate backend outage.
    store.available = false;

    const res = await provider.resolve(scopeA, refA);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("credential_backend_unavailable");
      expect(res.code).not.toBe("credential_invalid");
      expect(res.code).not.toBe("provider_unreachable");
    }

    // Restore backend → resolves again (recovery).
    store.available = true;
    const recovered = await provider.resolve(scopeA, refA);
    expect(recovered.ok).toBe(true);
  });

  test("no raw secret leaks into error strings, refs, or scope (sentinel scan)", async () => {
    const store = new InMemorySecretStore();
    const provider = new DefaultScopedCredentialProvider(store);
    const refA = await provider.provision(scopeA, materialA());

    // Capture every surface: ref, scope, error strings, failed-resolve reason.
    const surfaces: string[] = [
      JSON.stringify(refA),
      JSON.stringify(scopeA),
    ];

    // Force a scope-mismatch error and capture its string form.
    const badScope: SecretScope = { tenantId: tenantB, pluginId: okta };
    const fail = await provider.resolve(badScope, refA);
    if (!fail.ok) surfaces.push(fail.reason);

    // Force a missing-ref error and capture.
    const missing = await provider.resolve(scopeA, "secret_deadbeef");
    if (!missing.ok) surfaces.push(missing.reason);

    // The sentinel must NOT appear in any captured surface (it lives only in
    // the secret-store fixture material itself, which we deliberately exclude).
    const leaks = scanForSecretLeak(...surfaces);
    expect(leaks).toEqual([]);
  });
});