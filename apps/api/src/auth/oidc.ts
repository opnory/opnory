/**
 * apps/api auth boundary — Gate 3 authentication layer.
 *
 * Validates OIDC access tokens against a provider-neutral configuration:
 * issuer, audience, expiry, signature (via JWKS). Resolves IdP group claims
 * to Opnory roles at this boundary so that provider-specific identifiers never
 * enter authorization logic downstream.
 *
 * Design contract (docs/security/gate3-sso-oidc-mfa-design.md):
 *  - JWT access tokens only (Bearer). No ID tokens.
 *  - Local JWKS validation, no introspection round-trip.
 *  - Fail-closed: unknown issuer/audience/expired/wrong-kid → 401.
 *  - Roles come from the IdP groups claim mapped to Opnory role names.
 */

import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { getLogger } from "@opnory/observability";

const logger = getLogger().child({ component: "auth" });

/** Shape of jose error objects we rely on for claim diagnostics. */
const JoseClaimErrorSchema = z.object({ claim: z.string().optional() });

/** Parsed payload boundary: only claims we actually consume. */
const PayloadClaimsSchema = z.object({
  sub: z.string().optional(),
  groups: z.array(z.string()).optional(),
});

export type OpnoryRole = "platform-admin" | "access-approver" | "auditor-read-only";

export interface OidcAuthConfig {
  /** OIDC issuer URL, e.g. https://login.microsoftonline.com/<tenant>/v2.0 */
  issuer: string;
  /** Expected audience — the Opnory API's client ID / resource identifier. */
  audience: string;
  /** JWKS endpoint (usually `${issuer}/discovery/v2.0/keys`). */
  jwksUri: string;
  /**
   * Mapping from IdP group name (from `groups` claim) to Opnory role.
   * e.g. { "opnory-platform-admins": "platform-admin" }
   */
  roleGroupMap: Record<string, OpnoryRole>;
}

export interface TokenPrincipal {
  /** Opnory roles possessed by the caller. */
  roles: Set<OpnoryRole>;
  /** OIDC `sub` — synthetic identity only; kept out of authorization decisions. */
  subject: string;
}

export class AuthError extends Error {
  constructor(
    public readonly code:
      | "missing_token"
      | "malformed_token"
      | "wrong_issuer"
      | "wrong_audience"
      | "token_expired"
      | "invalid_signature"
      | "no_role",
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }

  get statusCode(): number {
    return this.code === "no_role" ? 403 : 401;
  }
}

export function createOidcValidator(config: OidcAuthConfig) {
  const jwks = createRemoteJWKSet(new URL(config.jwksUri));

  return async function validateToken(
    authorizationHeader: string | undefined,
  ): Promise<TokenPrincipal> {
    if (!authorizationHeader) {
      throw new AuthError("missing_token", "Authorization header required");
    }
    if (!authorizationHeader.startsWith("Bearer ")) {
      throw new AuthError("malformed_token", "Expected Bearer scheme");
    }
    const token = authorizationHeader.slice("Bearer ".length).trim();
    if (!token) {
      throw new AuthError("malformed_token", "Bearer token is empty");
    }

    let payload: { sub?: string; groups?: string[] };
    try {
      const result = await jwtVerify(token, jwks, {
        issuer: config.issuer,
        audience: config.audience,
      });
      const parsed = PayloadClaimsSchema.safeParse(result.payload);
      if (!parsed.success) {
        throw new AuthError("invalid_signature", "Token payload shape invalid");
      }
      payload = parsed.data;
    } catch (err) {
      if (err instanceof AuthError) throw err;
      if (err instanceof joseErrors.JWTExpired) {
        throw new AuthError("token_expired", "Token expired");
      }
      if (err instanceof joseErrors.JWTClaimValidationFailed) {
        const claimParsed = JoseClaimErrorSchema.safeParse(err);
        const claim = claimParsed.success ? claimParsed.data.claim : undefined;
        if (claim === "iss") {
          throw new AuthError("wrong_issuer", "Token issuer mismatch");
        }
        if (claim === "aud") {
          throw new AuthError("wrong_audience", "Token audience mismatch");
        }
        throw new AuthError("invalid_signature", `Claim validation failed: ${claim ?? "unknown"}`);
      }
      if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
        throw new AuthError("invalid_signature", "Signature verification failed");
      }
      logger.warn({ err }, "token verification failed");
      throw new AuthError("invalid_signature", "Token verification failed");
    }

    const groups = payload.groups ?? [];
    const roles = new Set<OpnoryRole>();
    for (const group of groups) {
      const role = config.roleGroupMap[group];
      if (role) roles.add(role);
    }

    return {
      roles,
      subject: payload.sub ?? "unknown",
    };
  };
}

/**
 * Helper: require a role on a route. Throws 401 if unauthenticated,
 * 403 if authenticated but without any of the required roles.
 */
export function requireRole(...allowed: OpnoryRole[]) {
  return async function requireRoleHook(
    request: FastifyRequest & { principal?: TokenPrincipal },
    reply: FastifyReply,
  ): Promise<void> {
    if (!request.principal) {
      throw new AuthError("missing_token", "Not authenticated");
    }
    for (const role of allowed) {
      if (request.principal.roles.has(role)) return;
    }
    throw new AuthError("no_role", `Required role not present (need one of: ${allowed.join(", ")})`);
  };
}
