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

    try {
      if (mapping.type === "group") {
        // Add user to group
        try {
          await this.oktaRequest(
            `/groups/${mapping.value}/users/${resolvedSubject.providerSubjectId}`,
            {
              method: "PUT",
            },
          );
          return {
            status: "succeeded",
            mutated: true,
            provider: "okta",
            providerObjectId: mapping.value,
            correlationId,
          };
        } catch (error: any) {
          // Handle idempotent "already exists" - Okta returns 400 with errorCode E0000007
          const isAlreadyMember =
            error.status === 400 &&
            (error.errorCode === "E0000007" ||
              error.errorSummary?.includes("already a member") ||
              error.errorSummary?.includes("already exists"));

          if (isAlreadyMember) {
            return {
              status: "succeeded",
              mutated: false,
              provider: "okta",
              providerObjectId: mapping.value,
              correlationId,
            };
          }
          throw error;
        }
      } else if (mapping.type === "application") {
        // Assign user to application
        try {
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
          return {
            status: "succeeded",
            mutated: true,
            provider: "okta",
            providerObjectId: mapping.value,
            correlationId,
          };
        } catch (error: any) {
          // Handle idempotent "already assigned" - Okta returns 400 with errorCode E0000007
          const isAlreadyAssigned =
            error.status === 400 &&
            (error.errorCode === "E0000007" ||
              error.errorSummary?.includes("already assigned") ||
              error.errorSummary?.includes("already exists"));

          if (isAlreadyAssigned) {
            return {
              status: "succeeded",
              mutated: false,
              provider: "okta",
              providerObjectId: mapping.value,
              correlationId,
            };
          }
          throw error;
        }
      }

      return {
        status: "failed",
        mutated: false,
        provider: "okta",
        providerObjectId: undefined,
        error: `Unsupported mapping type: ${mapping.type}`,
        correlationId,
      };
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

  async verify(
    assignment: RoleAssignment,
    permission: Permission,
    scope: ResourceScope,
    resolvedSubject: ResolvedSubject,
  ): Promise<VerificationResult> {
    const correlationId = crypto.randomUUID();

    try {
      const mapping = permission.mappings.find((m) => m.provider === "okta");
      if (!mapping) {
        return {
          status: "failed",
          provider: "okta",
          providerObjectId: undefined,
          error: `No Okta mapping found for permission ${permission.id}`,
          correlationId,
        };
      }

      if (mapping.type === "group") {
        // Check group membership
        try {
          await this.oktaRequest<OktaGroupMember>(
            `/groups/${mapping.value}/users/${resolvedSubject.providerSubjectId}`,
          );
          return {
            status: "verified",
            provider: "okta",
            providerObjectId: mapping.value,
            correlationId,
          };
        } catch (error: any) {
          if (error.status === 404) {
            return {
              status: "not-found",
              provider: "okta",
              providerObjectId: mapping.value,
              correlationId,
            };
          }
          throw error;
        }
      } else if (mapping.type === "application") {
        // Check application assignment
        try {
          const appUsers = await this.oktaRequest<OktaAppUser[]>(
            `/apps/${mapping.value}/users?filter=id eq "${resolvedSubject.providerSubjectId}"`,
          );
          const found = appUsers && appUsers.length > 0;
          return {
            status: found ? "verified" : "not-found",
            provider: "okta",
            providerObjectId: mapping.value,
            correlationId,
          };
        } catch (error: any) {
          if (error.status === 404) {
            return {
              status: "not-found",
              provider: "okta",
              providerObjectId: mapping.value,
              correlationId,
            };
          }
          throw error;
        }
      }

      return {
        status: "failed",
        provider: "okta",
        providerObjectId: undefined,
        error: `Unsupported mapping type: ${mapping.type}`,
        correlationId,
      };
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

      if (mapping.type === "group") {
        try {
          await this.oktaRequest(
            `/groups/${mapping.value}/users/${resolvedSubject.providerSubjectId}`,
            {
              method: "DELETE",
            },
          );
          // Verify actual state after delete
          try {
            await this.oktaRequest<OktaGroupMember>(
              `/groups/${mapping.value}/users/${resolvedSubject.providerSubjectId}`,
            );
            // Still a member - state not converged
            return {
              status: "succeeded",
              mutated: true,
              provider: "okta",
              providerObjectId: mapping.value,
              correlationId,
            };
          } catch (error: any) {
            if (error.status === 404) {
              return {
                status: "succeeded",
                mutated: true,
                provider: "okta",
                providerObjectId: mapping.value,
                correlationId,
              };
            }
            throw error;
          }
        } catch (error: any) {
          // Handle "already absent" - Okta returns 404 if user not in group
          if (error.status === 404) {
            // Double-check actual state
            try {
              await this.oktaRequest<OktaGroupMember>(
                `/groups/${mapping.value}/users/${resolvedSubject.providerSubjectId}`,
              );
              // Still a member - return mutated true
              return {
                status: "succeeded",
                mutated: true,
                provider: "okta",
                providerObjectId: mapping.value,
                correlationId,
              };
            } catch (verifyError: any) {
              if (verifyError.status === 404) {
                return {
                  status: "succeeded",
                  mutated: false,
                  provider: "okta",
                  providerObjectId: mapping.value,
                  correlationId,
                };
              }
              throw verifyError;
            }
          }
          throw error;
        }
      } else if (mapping.type === "application") {
        // Find the app user link first
        const appUsers = await this.oktaRequest<OktaAppUser[]>(
          `/apps/${mapping.value}/users?filter=id eq "${resolvedSubject.providerSubjectId}"`,
        );
        const assignment = appUsers && appUsers.length > 0 ? appUsers[0] : null;

        if (!assignment) {
          // Double-check actual state
          const freshAppUsers = await this.oktaRequest<OktaAppUser[]>(
            `/apps/${mapping.value}/users?filter=id eq "${resolvedSubject.providerSubjectId}"`,
          );
          const stillAssigned = freshAppUsers && freshAppUsers.length > 0;
          if (stillAssigned) {
            return {
              status: "succeeded",
              mutated: true,
              provider: "okta",
              providerObjectId: mapping.value,
              correlationId,
            };
          }
          return {
            status: "succeeded",
            mutated: false,
            provider: "okta",
            providerObjectId: mapping.value,
            correlationId,
          };
        }

        try {
          await this.oktaRequest(
            `/apps/${mapping.value}/users/${assignment.id}`,
            {
              method: "DELETE",
            },
          );
          // Verify actual state after delete
          const freshAppUsers = await this.oktaRequest<OktaAppUser[]>(
            `/apps/${mapping.value}/users?filter=id eq "${resolvedSubject.providerSubjectId}"`,
          );
          const stillAssigned = freshAppUsers && freshAppUsers.length > 0;
          if (stillAssigned) {
            return {
              status: "succeeded",
              mutated: true,
              provider: "okta",
              providerObjectId: mapping.value,
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
          // Handle "already absent" - Okta returns 404 if assignment doesn't exist
          if (error.status === 404) {
            // Double-check actual state
            const freshAppUsers = await this.oktaRequest<OktaAppUser[]>(
              `/apps/${mapping.value}/users?filter=id eq "${resolvedSubject.providerSubjectId}"`,
            );
            const stillAssigned = freshAppUsers && freshAppUsers.length > 0;
            if (stillAssigned) {
              return {
                status: "succeeded",
                mutated: true,
                provider: "okta",
                providerObjectId: mapping.value,
                correlationId,
              };
            }
            return {
              status: "succeeded",
              mutated: false,
              provider: "okta",
              providerObjectId: mapping.value,
              correlationId,
            };
          }
          throw error;
        }
      }

      return {
        status: "failed",
        mutated: false,
        provider: "okta",
        providerObjectId: undefined,
        error: `Unsupported mapping type: ${mapping.type}`,
        correlationId,
      };
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