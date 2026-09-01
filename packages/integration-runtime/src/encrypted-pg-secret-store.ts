// packages/integration-runtime/src/encrypted-pg-secret-store.ts
// EncryptedPgSecretStore — durable encrypted SecretStore implementation on
// PostgreSQL, proving the production secret boundary end-to-end (ADR 0006).
//
//   tenant_integrations.credential_ref  →  references integration_secrets.secret_ref
//   integration_secrets                 →  ciphertext/nonce/auth_tag/key_version only
//
// Security properties:
//   - AES-256-GCM authenticated encryption (confidentiality + integrity).
//   - SecretRef is an opaque, high-entropy random UUID — it encodes NO tenant,
//     plugin, secret type, or material hash.
//   - Every SQL lookup scopes at the persistence boundary (tenant_id AND
//     plugin_id), defense in depth on top of DefaultScopedCredentialProvider.
//   - Encryption-key boundary is separate (EncryptionKeyProvider); credential
//     rotation is distinct from encryption-key rotation.
//   - Plaintext never touches the row; only ciphertext/nonce/auth_tag.

import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { getLogger } from "@opnory/observability";
import type {
  SecretStore,
  SecretMaterial,
  SecretRef,
  SecretScope,
} from "./secret-store.js";
import { SecretStoreError } from "./secret-store.js";

const logger = getLogger().child({ component: "encrypted-pg-secret-store" });

// ============================================================================
// Encryption key boundary
// ============================================================================

/** An AES-256 key material, tagged with a version for key rotation. */
export interface EncryptionKey {
  readonly version: string;
  /** 32 raw bytes (hex string) for AES-256-GCM. */
  readonly keyHex: string;
}

/**
 * Provides the current encryption key and any historical key by version.
 * Production uses a KMS-backed implementation; the static provider is for
 * the integration proof only.
 */
export interface EncryptionKeyProvider {
  current(): Promise<EncryptionKey>;
  get(keyVersion: string): Promise<EncryptionKey>;
}

/**
 * Static 32-byte key — TEST/INTEGRATION PROOF ONLY. Never use a fixed key in
 * production; wire a KMS/HSM-backed provider instead.
 */
export class StaticTestKeyProvider implements EncryptionKeyProvider {
  constructor(private readonly key: EncryptionKey) {}

  async current(): Promise<EncryptionKey> {
    return this.key;
  }

  async get(keyVersion: string): Promise<EncryptionKey> {
    if (keyVersion !== this.key.version) {
      throw new Error(`unknown key version: ${keyVersion}`);
    }
    return this.key;
  }
}

/** Build a StaticTestKeyProvider from a 64-char hex string (32 bytes). */
export function staticKeyFromHex(version: string, keyHex: string): StaticTestKeyProvider {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error("static key must be 64 hex chars (32 bytes)");
  }
  return new StaticTestKeyProvider({ version, keyHex });
}

// ============================================================================
// AES-256-GCM helpers
// ============================================================================

const IV_BYTES = 12; // GCM recommended nonce size

interface Ciphertext {
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
  keyVersion: string;
}

function encrypt(material: SecretMaterial, key: EncryptionKey): Ciphertext {
  const nonce = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key.keyHex, "hex"), nonce);
  const plaintext = Buffer.from(JSON.stringify(material), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, nonce, authTag, keyVersion: key.version };
}

function decrypt(ct: Ciphertext, key: EncryptionKey): SecretMaterial {
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key.keyHex, "hex"), ct.nonce);
  decipher.setAuthTag(ct.authTag);
  const plaintext = Buffer.concat([decipher.update(ct.ciphertext), decipher.final()]);
  // SAFETY: encrypt() above always serializes a SecretMaterial via JSON.stringify,
  // so the authenticated decrypt round-trips the identical shape; AES-GCM auth-tag
  // verification (setAuthTag + final) rejects any tampered/replayed plaintext.
  return JSON.parse(plaintext.toString("utf8")) as SecretMaterial;
}

// ============================================================================
// Schema
// ============================================================================

const INTEGRATION_SECRETS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS integration_secrets (
    secret_ref    VARCHAR(64) PRIMARY KEY,
    tenant_id     VARCHAR(255) NOT NULL,
    plugin_id     VARCHAR(255) NOT NULL,
    ciphertext    BYTEA NOT NULL,
    nonce         BYTEA NOT NULL,
    auth_tag      BYTEA NOT NULL,
    key_version   VARCHAR(64) NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    rotated_at    TIMESTAMPTZ,
    revoked_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_integration_secrets_scope
    ON integration_secrets(tenant_id, plugin_id);
`;

export async function migrateIntegrationSecrets(pool: Pool): Promise<void> {
  await pool.query(INTEGRATION_SECRETS_SCHEMA_SQL);
  logger.info("Integration secrets schema migration completed");
}

// ============================================================================
// EncryptedPgSecretStore
// ============================================================================

interface SecretRow {
  secret_ref: string;
  tenant_id: string;
  plugin_id: string;
  ciphertext: Buffer;
  nonce: Buffer;
  auth_tag: Buffer;
  key_version: string;
  revoked_at: Date | null;
}

/**
 * Durable encrypted SecretStore. Scope is enforced both in application code
 * and in the SQL WHERE clause (defense in depth).
 */
export class EncryptedPgSecretStore implements SecretStore {
  constructor(
    private readonly pool: Pool,
    private readonly keys: EncryptionKeyProvider,
  ) {}

  private async assertStoreAvailable(scope: SecretScope, ref: SecretRef): Promise<void> {
    try {
      // A trivial always-true query exercises the connection. If the DB is down
      // this throws, which callers map to credential_backend_unavailable.
      await this.pool.query("SELECT 1");
    } catch {
      // The specific error is irrelevant — any failure here means the secret
      // backend is unreachable, mapped uniformly to backend_unavailable.
      throw new SecretStoreError("backend_unavailable", scope, ref, "secret store postgres unavailable");
    }
  }

  async put(scope: SecretScope, material: SecretMaterial): Promise<SecretRef> {
    await this.assertStoreAvailable(scope, "");
    const ref = `sec_${randomUUID().replace(/-/g, "")}`; // opaque, high-entropy, no metadata
    const key = await this.keys.current();
    const ct = encrypt(material, key);

    await this.pool.query(
      `INSERT INTO integration_secrets
         (secret_ref, tenant_id, plugin_id, ciphertext, nonce, auth_tag, key_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [ref, scope.tenantId, scope.pluginId, ct.ciphertext, ct.nonce, ct.authTag, ct.keyVersion],
    );
    return ref;
  }

  private async loadRow(scope: SecretScope, ref: SecretRef): Promise<SecretRow> {
    const result = await this.pool.query(
      `SELECT secret_ref, tenant_id, plugin_id, ciphertext, nonce, auth_tag, key_version, revoked_at
         FROM integration_secrets
        WHERE secret_ref = $1
          AND tenant_id = $2
          AND plugin_id = $3`,
      [ref, scope.tenantId, scope.pluginId],
    );
    if (result.rows.length === 0) {
      throw new SecretStoreError("secret_ref_missing", scope, ref, "no secret under this ref/scope");
    }
    // SAFETY: the SELECT above names exactly the columns of SecretRow in order,
    // and the nonzero-row check guarantees rows[0] exists — the cast narrows pg's
    // untyped row to the schema-constrained shape we SELECTed.
    return result.rows[0] as SecretRow;
  }

  async get(scope: SecretScope, ref: SecretRef): Promise<SecretMaterial> {
    await this.assertStoreAvailable(scope, ref);
    const row = await this.loadRow(scope, ref).catch((e) => {
      // Distinguish "not found" (secret_ref_missing) from other DB errors.
      if (e instanceof SecretStoreError) throw e;
      throw new SecretStoreError("backend_unavailable", scope, ref, "secret store postgres unavailable");
    });
    if (row.revoked_at) {
      throw new SecretStoreError("secret_ref_missing", scope, ref, "secret revoked");
    }
    const key = await this.keys.get(row.key_version);
    return decrypt(
      { ciphertext: row.ciphertext, nonce: row.nonce, authTag: row.auth_tag, keyVersion: row.key_version },
      key,
    );
  }

  async rotate(scope: SecretScope, ref: SecretRef, replacement: SecretMaterial): Promise<SecretRef> {
    await this.assertStoreAvailable(scope, ref);
    const row = await this.loadRow(scope, ref).catch((e) => {
      if (e instanceof SecretStoreError) throw e;
      throw new SecretStoreError("backend_unavailable", scope, ref, "secret store postgres unavailable");
    });
    if (row.revoked_at) {
      throw new SecretStoreError("secret_ref_missing", scope, ref, "secret revoked");
    }
    const key = await this.keys.current();
    const ct = encrypt(replacement, key);
    // Atomic single-row update: replaces ciphertext + bumps rotated_at.
    await this.pool.query(
      `UPDATE integration_secrets
          SET ciphertext = $2, nonce = $3, auth_tag = $4, key_version = $5, rotated_at = NOW()
        WHERE secret_ref = $1`,
      [ref, ct.ciphertext, ct.nonce, ct.authTag, ct.keyVersion],
    );
    return ref;
  }

  async revoke(scope: SecretScope, ref: SecretRef): Promise<void> {
    await this.assertStoreAvailable(scope, ref);
    // Idempotent: mark revoked_at; a missing row is a no-op (already gone).
    await this.pool.query(
      `UPDATE integration_secrets SET revoked_at = NOW()
        WHERE secret_ref = $1 AND tenant_id = $2 AND plugin_id = $3 AND revoked_at IS NULL`,
      [ref, scope.tenantId, scope.pluginId],
    );
  }
}