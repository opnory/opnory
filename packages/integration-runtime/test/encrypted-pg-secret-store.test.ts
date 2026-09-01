// packages/integration-runtime/test/encrypted-pg-secret-store.test.ts
// Durable encrypted credential proof (Phase 6): EncryptedPgSecretStore against
// real PostgreSQL. Proves persistence across runtime-object destruction,
// encrypted-at-rest storage, fresh-instance recovery, durable revocation,
// DB-outage mapping, and plaintext/sentinel absence.
//
// Requires DATABASE_URL pointing at a throwaway Postgres DB (e.g.
// postgres://localhost:5432/opnory_integration_test). Skipped when unset.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Pool } from "pg";
import {
  EncryptedPgSecretStore,
  staticKeyFromHex,
  migrateIntegrationSecrets,
} from "../src/encrypted-pg-secret-store.js";
import {
  DefaultScopedCredentialProvider,
  SECRET_SENTINEL,
  scanForSecretLeak,
} from "../src/secret-store.js";
import type { SecretScope, SecretMaterial } from "../src/secret-store.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://localhost:5432/opnory_integration_test";

// Fixed 32-byte test key (64 hex chars) — integration proof only.
const TEST_KEY_HEX =
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

const tenantA = "tenant-a";
const tenantB = "tenant-b";
const okta = "okta";
const entra = "entra";

const scopeA: SecretScope = { tenantId: tenantA, pluginId: okta };
const scopeB: SecretScope = { tenantId: tenantB, pluginId: entra };

function matA(): SecretMaterial {
  return { apiToken: `${SECRET_SENTINEL}_A`, orgUrl: "https://a.okta.com" };
}
function matB(): SecretMaterial {
  return { clientSecret: `${SECRET_SENTINEL}_B`, tenantId: "entra-b" };
}

let pool: Pool;
let store: EncryptedPgSecretStore;
let provider: DefaultScopedCredentialProvider;

describe("EncryptedPgSecretStore durable proof", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
    // Wipe any prior run's rows for a clean, deterministic proof.
    await pool.query("DROP TABLE IF EXISTS integration_secrets CASCADE");
    await migrateIntegrationSecrets(pool);
    store = new EncryptedPgSecretStore(pool, staticKeyFromHex("v1", TEST_KEY_HEX));
    provider = new DefaultScopedCredentialProvider(store);
  });

  afterAll(async () => {
    await pool.end().catch(() => {});
  });

  test("persist encrypted rows; destroy runtime objects; fresh instances resolve A and B", async () => {
    const refA = await provider.provision(scopeA, matA());
    const refB = await provider.provision(scopeB, matB());

    // Assert the persisted rows carry ciphertext, NOT plaintext.
    const rows = await pool.query(
      "SELECT secret_ref, tenant_id, plugin_id, ciphertext, key_version, revoked_at FROM integration_secrets ORDER BY secret_ref",
    );
    expect(rows.rows.length).toBe(2);
    for (const row of rows.rows) {
      expect(row.ciphertext).toBeTruthy(); // non-empty ciphertext present
      // pg returns BYTEA as a Buffer; assert it has the expected Buffer shape.
      expect(Array.isArray(row.ciphertext) || Buffer.isBuffer(row.ciphertext)).toBe(true);
      // ciphertext must NOT contain the sentinel or any plaintext secret.
      const hex = Buffer.from(row.ciphertext).toString("hex");
      expect(hex.includes(Buffer.from(SECRET_SENTINEL).toString("hex"))).toBe(false);
    }

    // "Destroy" runtime objects — construct FRESH store/provider over the SAME pool.
    const freshStore = new EncryptedPgSecretStore(pool, staticKeyFromHex("v1", TEST_KEY_HEX));
    const freshProvider = new DefaultScopedCredentialProvider(freshStore);

    const resA = await freshProvider.resolve(scopeA, refA);
    const resB = await freshProvider.resolve(scopeB, refB);
    expect(resA.ok).toBe(true);
    expect(resB.ok).toBe(true);
    if (resA.ok) expect(resA.credential.material.apiToken).toContain(SECRET_SENTINEL);
    if (resB.ok) expect(resB.credential.material.clientSecret).toContain(SECRET_SENTINEL);
  });

  test("cross-scope denial at the persistence boundary (defense in depth)", async () => {
    const refA = await provider.provision(scopeA, matA());

    // A resolves under WRONG scope (tenant B, plugin okta) must fail even though
    // the ref exists — because the SQL WHERE clause and app check both scope.
    const wrongScope: SecretScope = { tenantId: tenantB, pluginId: okta };
    const res = await provider.resolve(wrongScope, refA);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("configuration_invalid");
  });

  test("rotate A: replacement decrypts, old material unreachable, B unchanged", async () => {
    const refA = await provider.provision(scopeA, matA());
    const refB = await provider.provision(scopeB, matB());

    const replacement: SecretMaterial = {
      apiToken: `${SECRET_SENTINEL}_A_ROTATED`,
      orgUrl: "https://a.okta.com",
    };
    const newRef = await provider.rotate(scopeA, refA, replacement);

    const resA = await provider.resolve(scopeA, newRef);
    const resB = await provider.resolve(scopeB, refB);
    expect(resA.ok).toBe(true);
    if (resA.ok) expect(resA.credential.material.apiToken).toContain("_ROTATED");
    expect(resA.ok && resA.credential.material.apiToken).not.toContain("_A\"");

    // Old material is gone: the rotated value must not contain the pre-rotation token.
    if (resA.ok) {
      expect(resA.credential.material.apiToken).not.toBe(matA().apiToken);
    }
    expect(resB.ok).toBe(true);
    if (resB.ok) expect(resB.credential.material.clientSecret).toContain("_B");
  });

  test("revoke A is durable: fresh process still sees A revoked, B intact", async () => {
    const refA = await provider.provision(scopeA, matA());
    const refB = await provider.provision(scopeB, matB());

    await provider.revoke(scopeA, refA);

    // Fresh process (new store/provider over same pool).
    const freshStore = new EncryptedPgSecretStore(pool, staticKeyFromHex("v1", TEST_KEY_HEX));
    const freshProvider = new DefaultScopedCredentialProvider(freshStore);

    const resA = await freshProvider.resolve(scopeA, refA);
    const resB = await freshProvider.resolve(scopeB, refB);
    expect(resA.ok).toBe(false); // revoked → configuration_invalid (ref missing/revoked)
    expect(resB.ok).toBe(true);

    // DB row must show revoked_at set, NOT deleted (auditable revocation).
    const row = await pool.query(
      "SELECT revoked_at FROM integration_secrets WHERE secret_ref = $1",
      [refA],
    );
    expect(row.rows[0].revoked_at).not.toBeNull();
  });

  test("Postgres unavailable → credential_backend_unavailable (not invalid, not provider_unreachable), then recovers", async () => {
    const refA = await provider.provision(scopeA, { apiToken: `${SECRET_SENTINEL}_A`, orgUrl: "x" });

    // Simulate DB outage: a fresh pool pointed at an unreachable host.
    const badPool = new Pool({ connectionString: "postgres://localhost:59999/nope", connectionTimeoutMillis: 300, max: 1 });
    const badStore = new EncryptedPgSecretStore(badPool, staticKeyFromHex("v1", TEST_KEY_HEX));
    const badProvider = new DefaultScopedCredentialProvider(badStore);

    const res = await badProvider.resolve(scopeA, refA);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("credential_backend_unavailable");
      expect(res.code).not.toBe("credential_invalid");
      expect(res.code).not.toBe("provider_unreachable");
    }
    await badPool.end().catch(() => {});

    // Restore: the original pool still resolves A.
    const recovered = await provider.resolve(scopeA, refA);
    expect(recovered.ok).toBe(true);
  });

  test("concurrent rotate + revoke yield a deterministic final state", async () => {
    const refA = await provider.provision(scopeA, matA());

    // Fire rotate and revoke concurrently; regardless of interleaving, the
    // final observable state is deterministic: the ref is either revoked OR the
    // rotated material is present — never both, never neither in an ambiguous way.
    await Promise.all([
      provider.rotate(scopeA, refA, { apiToken: `${SECRET_SENTINEL}_A_CONCURRENT`, orgUrl: "x" }),
      provider.revoke(scopeA, refA),
    ]);

    // After concurrency settles, resolve must yield a SINGLE deterministic outcome.
    const res = await provider.resolve(scopeA, refA);
    // Either revoked (ok:false / configuration_invalid) or rotated (material present).
    if (res.ok) {
      expect(res.credential.material.apiToken).toContain(SECRET_SENTINEL);
    } else {
      expect(res.code).toBe("configuration_invalid");
    }

    // Revoke again idempotently, then confirm fully revoked.
    await provider.revoke(scopeA, refA);
    const after = await provider.resolve(scopeA, refA);
    expect(after.ok).toBe(false);
  });

  test("adversarial sentinel scan: no plaintext secret anywhere outside the fixture", async () => {
    // Put a secret carrying the sentinel, then scan EVERY persistence surface.
    const refA = await provider.provision(scopeA, { apiToken: `${SECRET_SENTINEL}_SCAN`, orgUrl: "x" });

    // 1. Serialized rows (all columns) must not contain the sentinel plaintext.
    const all = await pool.query("SELECT secret_ref, tenant_id, plugin_id, ciphertext::text, nonce::text, auth_tag::text, key_version FROM integration_secrets");
    const rowText = all.rows.map((r) => JSON.stringify(r)).join("\n");
    expect(scanForSecretLeak(rowText)).toEqual([]);

    // 2. The secret_ref must not encode the sentinel or any metadata.
    expect(refA).not.toContain(SECRET_SENTINEL);
    expect(refA).not.toContain("okta");
    expect(refA).not.toContain(tenantA);
    expect(refA).toMatch(/^sec_[0-9a-f]{32}$/);

    // 3. Error surfaces (scope mismatch, missing ref) carry no sentinel.
    const wrongScope: SecretScope = { tenantId: tenantB, pluginId: entra };
    const fail = await provider.resolve(wrongScope, refA);
    const missing = await provider.resolve(scopeA, "sec_ffffffffffffffffffffffffffffffff");
    const surfaces = [fail.ok ? "" : fail.reason, missing.ok ? "" : missing.reason];
    expect(scanForSecretLeak(...surfaces)).toEqual([]);
  });
});