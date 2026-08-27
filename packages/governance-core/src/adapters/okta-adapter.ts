import {
  RoleAssignment,
  Permission,
  ResourceScope,
  SubjectRef,
  ResolvedSubject,
  FulfillmentResult,
  VerificationResult,
  FulfillmentAdapter,
} from "@opnory/governance-core";

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

export interface OktaAdapterConfig {
  orgUrl: string; // e.g., "https://dev-123456.okta.com"
  clientId: string;
  privateKeyPath: string;
  privateKeyPassphrase?: string;
  keyId: string; // KID registered in the API Services app's Public Keys
}

interface OktaError extends Error {
  status?: number;
  errorCode?: string;
  errorSummary?: string;
}

interface OktaUser {
  id: string;
  profile: {
    login: string;
    email: string;
    firstName: string;
    lastName: string;
  };
}

interface OktaGroup {
  id: string;
  profile: {
    name: string;
    description: string;
  };
}

interface OktaApplication {
  id: string;
  label: string;
  signOnMode: string;
}

interface OktaGroupMember {
  id: string;
}

interface OktaAppUser {
  id: string;
  credentials: {
    userName: string;
  };
  profile: {
    firstName: string;
    lastName: string;
    email: string;
    login: string;
  };
  scope: string;
}

/**
 * Granular verification result — distinguishes why something is absent.
 * This prevents fail-open paths where "not found" is conflated with "successfully absent."
 */
type OktaVerificationState =
  | { state: "present" }
  | { state: "absent" }
  | { state: "subject-not-found" }
  | { state: "entitlement-not-found" };

export class OktaAdapter implements FulfillmentAdapter {
  readonly provider = "okta";
  private config: OktaAdapterConfig;
  private token: string | null = null;
  private tokenExpiresAt: number = 0;
  private privateKey: string;

  constructor(config: OktaAdapterConfig) {
    this.config = config;
    this.privateKey = this.loadPrivateKey(config.privateKeyPath);
  }

  // Expose oktaRequest for bootstrap script
  public async rawRequest<T>(path: string, options: Record<string, any> = {}): Promise<T> {
    return this.oktaRequest<T>(path, options);
  }

  private loadPrivateKey(keyPath: string): string {
    const resolvedPath = path.isAbsolute(keyPath)
      ? keyPath
      : path.resolve(process.cwd(), keyPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Private key file not found: ${resolvedPath}`);
    }
    return fs.readFileSync(resolvedPath, "utf-8");
  }

  private base64UrlEncode(input: Buffer | string): string {
    const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
    return buffer
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  }

  private async signJwt(payload: object): Promise<string> {
    const header = {
      alg: "RS256",
      typ: "JWT",
      kid: this.config.keyId,
    };

    const encodedHeader = this.base64UrlEncode(
      JSON.stringify(header),
    );
    const encodedPayload = this.base64UrlEncode(JSON.stringify(payload));
    const signingInput = `${encodedHeader}.${encodedPayload}`;

    // Use Node.js crypto for signing
    const sign = crypto.createSign("RSA-SHA256");
    sign.update(signingInput);
    sign.end();
    const signature = sign.sign({
      key: this.privateKey,
      passphrase: this.config.privateKeyPassphrase,
    });

    const encodedSignature = this.base64UrlEncode(signature);
    return `${signingInput}.${encodedSignature}`;
  }

  private async getOktaToken(): Promise<string> {
    // Check if token is still valid (with 30s buffer)
    if (this.token && Date.now() < this.tokenExpiresAt - 30000) {
      return this.token;
    }

    const orgUrl = this.config.orgUrl.replace(/\/+$/, "");
    const tokenEndpoint = `${orgUrl}/oauth2/v1/token`;
    const publicKeyJwk = this.getPublicKeyJwk();

    // DPoP flow: first request to get nonce, second request with nonce
    // We need to do two requests since the first response gives us the nonce
    let accessToken: string | null = null;
    let expiresIn = 3600;
    let nonce: string | null = null;

    // Maximum 2 attempts (first gets nonce, second uses it)
    for (let attempt = 0; attempt < 2; attempt++) {
          const now = Math.floor(Date.now() / 1000);

          // Create fresh client_assertion for each attempt (jti must be unique)
          const clientAssertion = await this.createClientAssertion(tokenEndpoint, now);

          // Create DPoP proof
          const dpopProof = await this.createDpopProof(tokenEndpoint, now, publicKeyJwk, nonce);

          const params = new URLSearchParams({
            grant_type: "client_credentials",
            scope: "okta.groups.manage okta.apps.manage okta.users.read",
            client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            client_assertion: clientAssertion,
          });

          const response = await fetch(tokenEndpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Accept: "application/json",
              "DPoP": dpopProof,
            },
            body: params,
          });

          const responseText = await response.text();

          if (!response.ok) {
            // If first attempt returns use_dpop_nonce, extract nonce and retry
            if (attempt === 0) {
              try {
                const errorData = JSON.parse(responseText);
                if (errorData.error === "use_dpop_nonce") {
                  nonce = response.headers.get("DPoP-Nonce");
                  if (nonce) {
                    continue; // retry with nonce
                  }
                }
              } catch {
                // Not JSON, fall through to error
              }
            }

            // Debug logging
            console.log("[DEBUG] Token response status:", response.status);
            console.log("[DEBUG] Token response body:", responseText);

            throw new Error(`Okta token request failed: ${response.status} ${responseText}`);
          }

      // Success
      const data = JSON.parse(responseText) as {
        access_token: string;
        expires_in: number;
        token_type: string;
      };
      
      accessToken = data.access_token;
      expiresIn = data.expires_in;
      break;
    }

    if (!accessToken) {
      throw new Error("Failed to acquire Okta access token after DPoP flow");
    }

    this.token = accessToken;
    this.tokenExpiresAt = Date.now() + expiresIn * 1000;
    return this.token;
  }

  private getPublicKeyJwk(): { kty: string; n: string; e: string } {
    // Derive JWK from private key
    const publicKey = crypto.createPublicKey({ key: this.privateKey, format: "pem" });
    const jwk = publicKey.export({ format: "jwk" });
    return {
      kty: jwk.kty as string,
      n: jwk.n as string,
      e: jwk.e as string,
    };
  }

  private async createClientAssertion(tokenEndpoint: string, now: number): Promise<string> {
    const payload = {
      iss: this.config.clientId,
      sub: this.config.clientId,
      aud: tokenEndpoint,
      iat: now,
      exp: now + 300, // 5 minutes
      jti: crypto.randomUUID(),
    };
    return this.signJwt(payload);
  }

  private async createDpopProof(
    tokenEndpoint: string,
    now: number,
    publicKeyJwk: { kty: string; n: string; e: string },
    nonce: string | null,
    method: string = "POST",
    accessToken?: string,
  ): Promise<string> {
    const header = {
      typ: "dpop+jwt",
      alg: "RS256",
      jwk: publicKeyJwk,
    };

    const payload: Record<string, any> = {
      htu: tokenEndpoint,
      htm: method,
      iat: now,
      jti: crypto.randomUUID(),
    };

    if (nonce) {
      payload.nonce = nonce;
    }

    // Add ath (access token hash) claim if accessToken provided
    if (accessToken) {
      const hash = crypto.createHash("sha256");
      hash.update(accessToken);
      const ath = this.base64UrlEncode(hash.digest());
      payload.ath = ath;
    }

    const encodedHeader = this.base64UrlEncode(JSON.stringify(header));
    const encodedPayload = this.base64UrlEncode(JSON.stringify(payload));
    const signingInput = `${encodedHeader}.${encodedPayload}`;

    // Debug: log DPoP header
    console.log('[DEBUG DPoP] Header:', JSON.stringify(header));
    console.log('[DEBUG DPoP] Payload:', JSON.stringify(payload));

    const sign = crypto.createSign("RSA-SHA256");
    sign.update(signingInput);
    sign.end();
    const signature = sign.sign({
      key: this.privateKey,
      passphrase: this.config.privateKeyPassphrase,
    });

    const encodedSignature = this.base64UrlEncode(signature);
    return `${signingInput}.${encodedSignature}`;
  }

  private async oktaRequest<T>(
      path: string,
      options: RequestInit = {},
    ): Promise<T> {
      const token = await this.getOktaToken();
      const tokenEndpoint = `${this.config.orgUrl.replace(/\/+$/, "")}/oauth2/v1/token`;
      const publicKeyJwk = this.getPublicKeyJwk();

      // DPoP proof for the API request - use the base API URL as htu (no query params)
      const now = Math.floor(Date.now() / 1000);
      const apiUrl = `${this.config.orgUrl}/api/v1${path}`;
      // htu should be the base path without query parameters per DPoP spec
      const baseApiUrl = apiUrl.split("?")[0];
      const method = options.method || "GET";
      const dpopProof = await this.createDpopProof(baseApiUrl, now, publicKeyJwk, null, method, token);

      console.log("[DEBUG oktaRequest] Path:", path);
      console.log("[DEBUG oktaRequest] API URL:", apiUrl);
      console.log("[DEBUG oktaRequest] Base API URL (htu):", baseApiUrl);
      console.log("[DEBUG oktaRequest] Method:", method);
      console.log("[DEBUG oktaRequest] Token type: DPoP");

      const response = await fetch(apiUrl, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "DPoP": dpopProof,
          ...options.headers,
        },
      });

      console.log("[DEBUG oktaRequest] Response status:", response.status);
      const responseText = await response.text();
      console.log("[DEBUG oktaRequest] Response body:", responseText);

      if (!response.ok) {
        const err: OktaError = new Error(
          `Okta request failed: ${response.status} ${responseText}`,
        );
        err.status = response.status;
        try {
          const parsed = JSON.parse(responseText);
          err.errorCode = parsed.errorCode;
          err.errorSummary = parsed.errorSummary;
        } catch {
          // ignore parse error
        }
        throw err;
      }

      if (response.status === 204) {
        return {} as T;
      }

      return JSON.parse(responseText) as T;
    }

  async resolveSubject(subject: SubjectRef): Promise<ResolvedSubject> {
    if (subject.type === "user") {
      // Resolve by email/login
      const users = await this.oktaRequest<OktaUser[]>(
        `/users?filter=profile.email eq "${subject.identifier}" or profile.login eq "${subject.identifier}"`,
      );
      if (!users || users.length === 0) {
        throw new Error(`User not found: ${subject.identifier}`);
      }
      return {
        provider: "okta",
        providerSubjectId: users[0].id,
      };
    }

    // For groups and service principals, assume identifier is Okta object ID
    return {
      provider: "okta",
      providerSubjectId: subject.identifier,
    };
  }

  /**
   * Internal verification with granular state.
   * Never maps 404 to success — caller decides semantics.
   */
  private async verifyInternal(
    permission: Permission,
    scope: ResourceScope,
    resolvedSubject: ResolvedSubject,
  ): Promise<OktaVerificationState> {
    const mapping = permission.mappings.find((m) => m.provider === "okta");
    if (!mapping) {
      return { state: "entitlement-not-found" };
    }

    if (mapping.type === "group") {
      try {
        // Okta doesn't support GET /groups/{id}/users/{userId} - use list endpoint
        const members = await this.oktaRequest<OktaGroupMember[]>(
          `/groups/${mapping.value}/users`,
        );
        const found = members && members.some((m) => m.id === resolvedSubject.providerSubjectId);
        if (found) return { state: "present" };
        
        // Membership absent — check if group exists
        try {
          await this.oktaRequest<OktaGroup>(
            `/groups/${mapping.value}`,
          );
          return { state: "absent" };
        } catch (groupError: any) {
          if (groupError.status === 404) {
            return { state: "entitlement-not-found" };
          }
          throw groupError;
        }
      } catch (error: any) {
        if (error.status === 404) {
          // Group might not exist
          return { state: "entitlement-not-found" };
        }
        throw error;
      }
    } else if (mapping.type === "application") {
      try {
        // List all app users and filter locally (filter query doesn't work reliably)
        const appUsers = await this.oktaRequest<OktaAppUser[]>(
          `/apps/${mapping.value}/users`,
        );
        const found = appUsers && appUsers.some((u) => u.id === resolvedSubject.providerSubjectId);
        if (found) return { state: "present" };
        // Assignment absent — check if app exists
        try {
          await this.oktaRequest<OktaApplication>(
            `/apps/${mapping.value}`,
          );
          return { state: "absent" };
        } catch (appError: any) {
          if (appError.status === 404) {
            return { state: "entitlement-not-found" };
          }
          throw appError;
        }
      } catch (error: any) {
        if (error.status === 404) {
          // App might not exist
          try {
            await this.oktaRequest<OktaApplication>(
              `/apps/${mapping.value}`,
            );
            return { state: "absent" };
          } catch (appError: any) {
            if (appError.status === 404) {
              return { state: "entitlement-not-found" };
            }
            throw appError;
          }
        }
        throw error;
      }
    }

    return { state: "entitlement-not-found" };
  }

  /** Verify with retry for Okta eventual consistency (max 3 attempts, 1s delay) */
  private async verifyWithRetry(
    permission: Permission,
    scope: ResourceScope,
    resolvedSubject: ResolvedSubject,
    attempts: number = 3,
    delayMs: number = 1000,
  ): Promise<OktaVerificationState> {
    for (let i = 0; i < attempts; i++) {
      const state = await this.verifyInternal(permission, scope, resolvedSubject);
      if (state.state === "present") return state;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    return { state: "absent" };
  }

  /** Verify absence with retry for Okta eventual consistency (max 3 attempts, 1s delay) */
  private async verifyWithRetryAbsent(
    permission: Permission,
    scope: ResourceScope,
    resolvedSubject: ResolvedSubject,
    attempts: number = 3,
    delayMs: number = 1000,
  ): Promise<OktaVerificationState> {
    for (let i = 0; i < attempts; i++) {
      const state = await this.verifyInternal(permission, scope, resolvedSubject);
      if (state.state === "absent") return state;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    return { state: "present" };
  }

  async grant(
    assignment: RoleAssignment,
    permission: Permission,
    scope: ResourceScope,
    resolvedSubject: ResolvedSubject,
  ): Promise<FulfillmentResult> {
    const correlationId = crypto.randomUUID();

    const mapping = permission.mappings.find((m) => m.provider === "okta");
    if (!mapping) {
      return {
        status: "failed",
        mutated: false,
        provider: "okta",
        providerObjectId: undefined,
        error: `No Okta mapping found for permission ${permission.id}`,
        correlationId,
      };
    }

    // Verify current state FIRST — authoritative source of truth
    const currentState = await this.verifyInternal(permission, scope, resolvedSubject);

    if (currentState.state === "present") {
      // Already present — idempotent success
      return {
        status: "succeeded",
        mutated: false,
        provider: "okta",
        providerObjectId: mapping.value,
        correlationId,
      };
    }

    if (currentState.state === "subject-not-found") {
      return {
        status: "failed",
        mutated: false,
        provider: "okta",
        providerObjectId: undefined,
        error: `Subject not found in Okta: ${resolvedSubject.providerSubjectId}`,
        correlationId,
      };
    }

    if (currentState.state === "entitlement-not-found") {
      return {
        status: "failed",
        mutated: false,
        provider: "okta",
        providerObjectId: undefined,
        error: `Target ${mapping.type} not found in Okta: ${mapping.value}`,
        correlationId,
      };
    }

    // State is "absent" — perform the grant
    try {
      if (mapping.type === "group") {
        await this.oktaRequest(
          `/groups/${mapping.value}/users/${resolvedSubject.providerSubjectId}`,
          {
            method: "PUT",
          },
        );
      } else if (mapping.type === "application") {
        await this.oktaRequest(
          `/apps/${mapping.value}/users`,
          {
            method: "POST",
            body: JSON.stringify({
              id: resolvedSubject.providerSubjectId,
              scope: "USER",
            }),
          },
        );
      } else {
        return {
          status: "failed",
          mutated: false,
          provider: "okta",
          providerObjectId: undefined,
          error: `Unsupported mapping type: ${mapping.type}`,
          correlationId,
        };
      }

      // Verify convergence after grant (with retry for eventual consistency)
      const afterState = await this.verifyWithRetry(permission, scope, resolvedSubject);
      if (afterState.state !== "present") {
        return {
          status: "failed",
          mutated: false,
          provider: "okta",
          providerObjectId: mapping.value,
          error: `Grant succeeded but state not converged to present`,
          correlationId,
        };
      }

      return {
        status: "succeeded",
        mutated: true,
        provider: "okta",
        providerObjectId: mapping.value,
        correlationId,
      };
    } catch (error: any) {
      // Handle 409 Conflict "Duplicate" — E0000062 for app assignment
      // (Group membership PUT typically succeeds or returns 404 if group/user missing,
      // which we already checked above)
      if (
        error.status === 409 &&
        error.errorCode === "E0000062"
      ) {
        // Race: another process created it. Verify.
        const afterState = await this.verifyInternal(permission, scope, resolvedSubject);
        if (afterState.state === "present") {
          return {
            status: "succeeded",
            mutated: false,
            provider: "okta",
            providerObjectId: mapping.value,
            correlationId,
          };
        }
        return {
          status: "failed",
          mutated: false,
          provider: "okta",
          providerObjectId: mapping.value,
          error: `Duplicate error but state not present`,
          correlationId,
        };
      }
      throw error;
    }
  }

  async verify(
    assignment: RoleAssignment,
    permission: Permission,
    scope: ResourceScope,
    resolvedSubject: ResolvedSubject,
  ): Promise<VerificationResult> {
    const correlationId = crypto.randomUUID();

    try {
      const internalState = await this.verifyInternal(
        permission,
        scope,
        resolvedSubject,
      );

      // Map internal state to public VerificationResult
      switch (internalState.state) {
        case "present":
          return {
            status: "verified",
            provider: "okta",
            providerObjectId: permission.mappings.find((m) => m.provider === "okta")?.value,
            correlationId,
          };
        case "absent":
          return {
            status: "not-found",
            provider: "okta",
            providerObjectId: permission.mappings.find((m) => m.provider === "okta")?.value,
            correlationId,
          };
        case "subject-not-found":
          return {
            status: "failed",
            provider: "okta",
            providerObjectId: undefined,
            error: `Subject not found in Okta: ${resolvedSubject.providerSubjectId}`,
            correlationId,
          };
        case "entitlement-not-found":
          return {
            status: "failed",
            provider: "okta",
            providerObjectId: undefined,
            error: `Target entitlement not found in Okta`,
            correlationId,
          };
      }
    } catch (error: any) {
      return {
        status: "failed",
        provider: "okta",
        providerObjectId: undefined,
        error: error.message,
        correlationId,
      };
    }
  }

  async revoke(
    assignment: RoleAssignment,
    permission: Permission,
    scope: ResourceScope,
    resolvedSubject: ResolvedSubject,
  ): Promise<FulfillmentResult> {
    const correlationId = crypto.randomUUID();

    try {
      const mapping = permission.mappings.find((m) => m.provider === "okta");
      if (!mapping) {
        return {
          status: "failed",
          mutated: false,
          provider: "okta",
          providerObjectId: undefined,
          error: `No Okta mapping found for permission ${permission.id}`,
          correlationId,
        };
      }

      // Verify current state FIRST
      const currentState = await this.verifyInternal(permission, scope, resolvedSubject);

      if (currentState.state === "absent") {
        // Already absent — idempotent success
        return {
          status: "succeeded",
          mutated: false,
          provider: "okta",
          providerObjectId: mapping.value,
          correlationId,
        };
      }

      if (currentState.state === "subject-not-found") {
        return {
          status: "failed",
          mutated: false,
          provider: "okta",
          providerObjectId: undefined,
          error: `Subject not found in Okta: ${resolvedSubject.providerSubjectId}`,
          correlationId,
        };
      }

      if (currentState.state === "entitlement-not-found") {
        return {
          status: "failed",
          mutated: false,
          provider: "okta",
          providerObjectId: undefined,
          error: `Target ${mapping.type} not found in Okta: ${mapping.value}`,
          correlationId,
        };
      }

      // State is "present" — perform the revoke
      try {
        if (mapping.type === "group") {
          await this.oktaRequest(
            `/groups/${mapping.value}/users/${resolvedSubject.providerSubjectId}`,
            {
              method: "DELETE",
            },
          );
        } else if (mapping.type === "application") {
          // Find the app user link first (list all and filter locally)
          const appUsers = await this.oktaRequest<OktaAppUser[]>(
            `/apps/${mapping.value}/users`,
          );
          const appAssignment = appUsers && appUsers.find((u) => u.id === resolvedSubject.providerSubjectId);

          if (!appAssignment) {
            // Should not happen since verifyInternal said "present"
            return {
              status: "failed",
              mutated: false,
              provider: "okta",
              providerObjectId: mapping.value,
              error: `Assignment disappeared before revoke`,
              correlationId,
            };
          }

          await this.oktaRequest(
            `/apps/${mapping.value}/users/${appAssignment.id}`,
            {
              method: "DELETE",
            },
          );
        } else {
          return {
            status: "failed",
            mutated: false,
            provider: "okta",
            providerObjectId: undefined,
            error: `Unsupported mapping type: ${mapping.type}`,
            correlationId,
          };
        }

        // Verify convergence after revoke (with retry for eventual consistency)
        const afterState = await this.verifyWithRetryAbsent(permission, scope, resolvedSubject);
        if (afterState.state !== "absent") {
          // API call succeeded but state not converged — fail closed
          return {
            status: "failed",
            mutated: false,
            provider: "okta",
            providerObjectId: mapping.value,
            error: `Revoke API succeeded but state not converged to absent (${afterState.state})`,
            correlationId,
          };
        }

        return {
          status: "succeeded",
          mutated: true,
          provider: "okta",
          providerObjectId: mapping.value,
          correlationId,
        };
      } catch (error: any) {
        // If revoke fails with 404, verify actual state
        if (error.status === 404) {
          const afterState = await this.verifyInternal(permission, scope, resolvedSubject);
          if (afterState.state === "absent") {
            return {
              status: "succeeded",
              mutated: false,
              provider: "okta",
              providerObjectId: mapping.value,
              correlationId,
            };
          }
          if (afterState.state === "subject-not-found" || afterState.state === "entitlement-not-found") {
            return {
              status: "failed",
              mutated: false,
              provider: "okta",
              providerObjectId: undefined,
              error: `Revoke 404 but target missing: ${afterState.state}`,
              correlationId,
            };
          }
          // DELETE said "not found", but assignment is still present.
          // Desired state has not been achieved — fail closed.
          return {
            status: "failed",
            mutated: false,
            provider: "okta",
            providerObjectId: mapping.value,
            error: `Provider state mismatch: DELETE 404 but assignment still present`,
            correlationId,
          };
        }
        throw error;
      }
    } catch (error: any) {
      return {
        status: "failed",
        mutated: false,
        provider: "okta",
        providerObjectId: undefined,
        error: error.message,
        correlationId,
      };
    }
  }
}