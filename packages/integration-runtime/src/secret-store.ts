// packages/integration-runtime/src/secret-store.ts
// Production secret boundary: SecretStore + scoped CredentialProvider.
//
// Authority split (ADR 0006):
//   - Core owns desired/actual integration state and stores ONLY credentialRef.
//   - SecretStore owns storage/retrieval/rotation/revocation semantics.
//   - CredentialProvider owns tenant/plugin scoping and converts a SecretRef
//     into the NARROW credential material a plugin may consume.
//   - Plugins never receive SecretStore access.
//
// Every SecretStore operation carries { tenantId, pluginId } scope so a bare
// globally-addressable secret reference is NOT sufficient to read a secret —
// the caller must also prove the owning tenant/plugin pair.

import type { PluginId, TenantId } from "./plugin.js";

// ============================================================================
// Types
// ============================================================================

/** Opaque reference to secret material (what Postgres retains). */
export type SecretRef = string;

/** The scope every secret operation must carry. */
export interface SecretScope {
  readonly tenantId: TenantId;
  readonly pluginId: PluginId;
}

/** Secret material is an opaque bag of key/value material, never logged. */
export type SecretMaterial = Readonly<Record<string, string>>;

/** The narrow credential shape a plugin may consume (opaque to core). */
export interface ScopedCredential {
  readonly type: "api-token" | "client-secret" | "certificate" | "oauth-token" | "custom";
  readonly material: SecretMaterial;
  readonly expiresAt?: Date;
}

// ============================================================================
// Deterministic failure taxonomy
// ============================================================================

/**
 * Failure modes for secret/credential resolution. Distinct codes so operators
 * and automation can react precisely (ADR 0006):
 *
 *   secret_ref_missing             → configuration_invalid
 *   tenant/plugin scope mismatch    → credential_invalid
 *   secret resolves but rejected    → credential_invalid
 *   secret backend unavailable      → credential_backend_unavailable  (NOT provider_unreachable)
 */
export type SecretStoreErrorCode =
  | "secret_ref_missing"
  | "scope_mismatch"
  | "backend_unavailable";

export class SecretStoreError extends Error {
  readonly code: SecretStoreErrorCode;
  readonly scope: SecretScope;
  readonly ref: SecretRef;

  constructor(code: SecretStoreErrorCode, scope: SecretScope, ref: SecretRef, message: string) {
    super(message);
    this.name = "SecretStoreError";
    this.code = code;
    this.scope = scope;
    this.ref = ref;
  }

  override toString(): string {
    // Never embed secret material in the error; only the code and (sanitized) ref.
    return `SecretStoreError[${this.code}] ref=${this.ref.slice(0, 8)}…`;
  }
}

// ============================================================================
// SecretStore interface
// ============================================================================

/**
 * Secret storage/retrieval/rotation/revocation, ALWAYS tenant/plugin-scoped.
 * Implementations: InMemorySecretStore (tests), EncryptedPgSecretStore
 * (production proof), and future Vault/KMS/cloud-secret-manager backends.
 */
export interface SecretStore {
  /** Store secret material under tenant/plugin scope; returns an opaque ref. */
  put(scope: SecretScope, material: SecretMaterial): Promise<SecretRef>;

  /** Retrieve secret material, proving tenant/plugin scope matches the stored one. */
  get(scope: SecretScope, ref: SecretRef): Promise<SecretMaterial>;

  /** Replace material atomically; returns the new ref (may equal old ref). */
  rotate(scope: SecretScope, ref: SecretRef, replacement: SecretMaterial): Promise<SecretRef>;

  /** Destroy material; subsequent get must fail as secret_ref_missing. */
  revoke(scope: SecretScope, ref: SecretRef): Promise<void>;
}

// ============================================================================
// InMemorySecretStore (tests only)
// ============================================================================

interface Entry {
  scope: SecretScope;
  material: SecretMaterial;
  ref: SecretRef;
}

/**
 * Test-only SecretStore with correct value semantics and scope enforcement.
 * `available` can be flipped to simulate a secret-backend outage.
 */
export class InMemorySecretStore implements SecretStore {
  private entries = new Map<SecretRef, Entry>();
  private counter = 0;
  /** When false, every operation throws `backend_unavailable`. */
  available = true;

  private nextRef(): SecretRef {
    this.counter += 1;
    return `secret_${this.counter.toString(16).padStart(8, "0")}`;
  }

  private assertAvailable(scope: SecretScope, ref: SecretRef): void {
    if (!this.available) {
      throw new SecretStoreError("backend_unavailable", scope, ref, "secret backend is unavailable");
    }
  }

  async put(scope: SecretScope, material: SecretMaterial): Promise<SecretRef> {
    this.assertAvailable(scope, "");
    const ref = this.nextRef();
    this.entries.set(ref, { scope: { ...scope }, material: { ...material }, ref });
    return ref;
  }

  async get(scope: SecretScope, ref: SecretRef): Promise<SecretMaterial> {
    this.assertAvailable(scope, ref);
    const entry = this.entries.get(ref);
    if (!entry) {
      throw new SecretStoreError("secret_ref_missing", scope, ref, "no secret under this ref");
    }
    if (entry.scope.tenantId !== scope.tenantId || entry.scope.pluginId !== scope.pluginId) {
      throw new SecretStoreError("scope_mismatch", scope, ref, "tenant/plugin scope does not match");
    }
    // Return a copy so callers cannot mutate persisted material (value semantics).
    return { ...entry.material };
  }

  async rotate(scope: SecretScope, ref: SecretRef, replacement: SecretMaterial): Promise<SecretRef> {
    this.assertAvailable(scope, ref);
    const entry = this.entries.get(ref);
    if (!entry) {
      throw new SecretStoreError("secret_ref_missing", scope, ref, "no secret under this ref");
    }
    if (entry.scope.tenantId !== scope.tenantId || entry.scope.pluginId !== scope.pluginId) {
      throw new SecretStoreError("scope_mismatch", scope, ref, "tenant/plugin scope does not match");
    }
    // Rotate in place: same ref, replaced material (atomic under a single map set).
    entry.material = { ...replacement };
    return ref;
  }

  async revoke(scope: SecretScope, ref: SecretRef): Promise<void> {
    this.assertAvailable(scope, ref);
    const entry = this.entries.get(ref);
    if (!entry) return; // idempotent
    if (entry.scope.tenantId !== scope.tenantId || entry.scope.pluginId !== scope.pluginId) {
      throw new SecretStoreError("scope_mismatch", scope, ref, "tenant/plugin scope does not match");
    }
    this.entries.delete(ref);
  }
}

// ============================================================================
// Scoped credential provider
// ============================================================================

/**
 * Production CredentialProvider: wraps a SecretStore, enforces tenant/plugin
 * scope, and converts a SecretRef into the narrow ScopedCredential a plugin
 * may consume. It NEVER exposes the underlying SecretStore to plugins.
 */
export interface ScopedCredentialProvider {
  resolve(scope: SecretScope, ref: SecretRef): Promise<ResolveResult>;
  /** Store a credential (returns its ref) — used by the install workflow. */
  provision(scope: SecretScope, material: SecretMaterial): Promise<SecretRef>;
  /** Rotate a credential atomically. */
  rotate(scope: SecretScope, ref: SecretRef, replacement: SecretMaterial): Promise<SecretRef>;
  /** Revoke a credential. */
  revoke(scope: SecretScope, ref: SecretRef): Promise<void>;
}

export type ResolveResult =
  | { ok: true; credential: ScopedCredential }
  | {
      ok: false;
      code: "configuration_invalid" | "credential_invalid" | "credential_backend_unavailable";
      reason: string;
    };

/**
 * Default implementation backed by a SecretStore. Maps SecretStore errors to
 * the deterministic Opnory failure codes:
 *   secret_ref_missing → configuration_invalid
 *   scope_mismatch     → credential_invalid
 *   backend_unavailable→ credential_backend_unavailable
 *   (other/unknown)    → credential_invalid
 */
export class DefaultScopedCredentialProvider implements ScopedCredentialProvider {
  constructor(private readonly store: SecretStore) {}

  async resolve(scope: SecretScope, ref: SecretRef): Promise<ResolveResult> {
    let material: SecretMaterial;
    try {
      material = await this.store.get(scope, ref);
    } catch (error) {
      return mapStoreError(error, scope, ref);
    }

    // Material is present but malformed for a credential → credential_invalid.
    // SecretMaterial is statically a non-empty-capable Record<string,string>;
    // the only meaningful runtime validation is that it carries at least one key.
    if (Object.keys(material).length === 0) {
      return { ok: false, code: "credential_invalid", reason: "resolved material is empty" };
    }

    return {
      ok: true,
      credential: {
        type: inferCredentialType(material),
        material,
        expiresAt: undefined,
      },
    };
  }

  async provision(scope: SecretScope, material: SecretMaterial): Promise<SecretRef> {
    return this.store.put(scope, material);
  }

  async rotate(scope: SecretScope, ref: SecretRef, replacement: SecretMaterial): Promise<SecretRef> {
    return this.store.rotate(scope, ref, replacement);
  }

  async revoke(scope: SecretScope, ref: SecretRef): Promise<void> {
    return this.store.revoke(scope, ref);
  }
}

function mapStoreError(error: unknown, scope: SecretScope, ref: SecretRef): ResolveResult {
  if (error instanceof SecretStoreError) {
    switch (error.code) {
      case "secret_ref_missing":
        return { ok: false, code: "configuration_invalid", reason: `secret ref missing: ${ref.slice(0, 8)}…` };
      case "scope_mismatch":
        return { ok: false, code: "credential_invalid", reason: "tenant/plugin scope mismatch" };
      case "backend_unavailable":
        return { ok: false, code: "credential_backend_unavailable", reason: "secret backend unavailable" };
    }
  }
  return { ok: false, code: "credential_invalid", reason: "unknown secret resolution failure" };
}

function inferCredentialType(material: SecretMaterial): ScopedCredential["type"] {
  if ("clientSecret" in material || "client_id" in material) return "client-secret";
  if ("apiToken" in material) return "api-token";
  if ("certificate" in material) return "certificate";
  if ("accessToken" in material) return "oauth-token";
  return "custom";
}

// ============================================================================
// SENTINEL + leak scan (used by the credential-lifecycle proof)
// ============================================================================

/** An unmistakable marker embedded in test secrets to detect leaks. */
export const SECRET_SENTINEL = "OPNORY_SECRET_SENTINEL_DO_NOT_LOG";

/**
 * Scan arbitrary captured text (logs, events, error messages, persisted rows,
 * test artifacts) for the sentinel. Returns every match, so the proof gate can
 * fail if the sentinel appears anywhere except the secret-store fixture itself.
 */
export function scanForSecretLeak(...chunks: readonly (string | null | undefined)[]): string[] {
  const hits: string[] = [];
  for (const chunk of chunks) {
    if (!chunk) continue;
    if (chunk.includes(SECRET_SENTINEL)) hits.push(chunk);
  }
  return hits;
}