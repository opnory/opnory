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

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: this.config.clientId,
      sub: this.config.clientId,
      aud: `${this.config.orgUrl}/oauth2/v1/token`,
      iat: now,
      exp: now + 3600, // 1 hour
      jti: crypto.randomUUID(),
    };

    const assertion = await this.signJwt(payload);

    const params = new URLSearchParams({
      grant_type: "client_credentials",
      scope: "okta.groups.manage okta.apps.manage okta.users.read",
      client_assertion_type:
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: assertion,
    });

    const response = await fetch(
      `${this.config.orgUrl}/oauth2/v1/token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: params,
      },
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Okta token request failed: ${response.status} ${error}`,
      );
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
      token_type: string;
    };

    this.token = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000;
    return this.token;
  }

  private async oktaRequest<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const token = await this.getOktaToken();
    const response = await fetch(`${this.config.orgUrl}/api/v1${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      const err: OktaError = new Error(
        `Okta request failed: ${response.status} ${errorText}`,
      );
      err.status = response.status;
      try {
        const parsed = JSON.parse(errorText);
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

    return response.json() as Promise<T>;
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
        await this.oktaRequest<OktaGroupMember>(
          `/groups/${mapping.value}/users/${resolvedSubject.providerSubjectId}`,
        );
        return { state: "present" };
      } catch (error: any) {
        if (error.status === 404) {
          // Distinguish: is the user missing, or the group missing?
          try {
            await this.oktaRequest<OktaUser>(
              `/users/${resolvedSubject.providerSubjectId}`,
            );
            // User exists, group exists, but membership absent
            return { state: "absent" };
          } catch (userError: any) {
            if (userError.status === 404) {
              return { state: "subject-not-found" };
            }
            throw userError;
          }
        }
        throw error;
      }
    } else if (mapping.type === "application") {
      try {
        const appUsers = await this.oktaRequest<OktaAppUser[]>(
          `/apps/${mapping.value}/users?filter=id eq "${resolvedSubject.providerSubjectId}"`,
        );
        const found = appUsers && appUsers.length > 0;
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

      // Verify convergence after grant
      const afterState = await this.verifyInternal(permission, scope, resolvedSubject);
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
          // Find the app user link first
          const appUsers = await this.oktaRequest<OktaAppUser[]>(
            `/apps/${mapping.value}/users?filter=id eq "${resolvedSubject.providerSubjectId}"`,
          );
          const appAssignment = appUsers && appUsers.length > 0 ? appUsers[0] : null;

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

        // Verify convergence after revoke
        const afterState = await this.verifyInternal(permission, scope, resolvedSubject);
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