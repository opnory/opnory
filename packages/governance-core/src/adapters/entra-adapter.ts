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

const log = console;

export interface EntraAdapterConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  servicePrincipalId: string;
  enterpriseAppObjectId: string;
}

interface GraphError extends Error {
  status?: number;
  code?: string;
}

export class EntraAdapter implements FulfillmentAdapter {
  readonly provider = "entra";
  private config: EntraAdapterConfig;
  private token: string | null = null;

  constructor(config: EntraAdapterConfig) {
    this.config = config;
  }

  private async getGraphToken(): Promise<string> {
    if (this.token) return this.token;

    const params = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    });

    const response = await fetch(
      `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
      },
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Graph token request failed: ${response.status} ${error}`,
      );
    }

    const data = (await response.json()) as { access_token: string };
    this.token = data.access_token;
    return this.token;
  }

  private async graphRequest<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const token = await this.getGraphToken();
    const response = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      const err: GraphError = new Error(
        `Graph request failed: ${response.status} ${error}`,
      );
      err.status = response.status;
      try {
        const parsed = JSON.parse(error);
        err.code = parsed.error?.code;
      } catch {
        // ignore parse error
      }
      throw err;
    }

    if (response.status === 204 || response.status === 202) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  async resolveSubject(subject: SubjectRef): Promise<ResolvedSubject> {
    if (subject.type === "user") {
      // Resolve by UPN
      const users = await this.graphRequest<{ value: Array<{ id: string }> }>(
        `/users?$filter=userPrincipalName eq '${subject.identifier}'&$select=id`,
      );
      if (!users.value || users.value.length === 0) {
        throw new Error(`User not found: ${subject.identifier}`);
      }
      return {
        provider: "entra",
        providerSubjectId: users.value[0].id,
      };
    }

    // For service principals and groups, assume identifier is objectId
    return {
      provider: "entra",
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

    try {
      const mapping = permission.mappings.find((m) => m.provider === "entra");
      if (!mapping) {
        return {
          status: "failed",
          mutated: false,
          provider: "entra",
          providerObjectId: undefined,
          error: `No Entra mapping found for permission ${permission.id}`,
          correlationId,
        };
      }

      if (mapping.type === "group") {
        await this.graphRequest(`/groups/${mapping.value}/members/$ref`, {
          method: "POST",
          body: JSON.stringify({
            "@odata.id": `https://graph.microsoft.com/v1.0/directoryObjects/${resolvedSubject.providerSubjectId}`,
          }),
        });
        return {
          status: "succeeded",
          mutated: true,
          provider: "entra",
          providerObjectId: mapping.value,
          correlationId,
        };
      } else if (mapping.type === "appRole") {
        const appRoleId = mapping.value;
        // Use servicePrincipalId (app registration) for app role assignments
        await this.graphRequest(
          `/servicePrincipals/${this.config.servicePrincipalId}/appRoleAssignedTo`,
          {
            method: "POST",
            body: JSON.stringify({
              principalId: resolvedSubject.providerSubjectId,
              resourceId: this.config.servicePrincipalId,
              appRoleId,
            }),
          },
        );
        return {
          status: "succeeded",
          mutated: true,
          provider: "entra",
          providerObjectId: this.config.servicePrincipalId,
          correlationId,
        };
      }

      return {
        status: "failed",
        mutated: false,
        provider: "entra",
        providerObjectId: undefined,
        error: `Unsupported mapping type: ${mapping.type}`,
        correlationId,
      };
    } catch (error: any) {
      return {
        status: "failed",
        mutated: false,
        provider: "entra",
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
      const mapping = permission.mappings.find((m) => m.provider === "entra");
      if (!mapping) {
        return {
          status: "failed",
          provider: "entra",
          providerObjectId: undefined,
          error: `No Entra mapping found for permission ${permission.id}`,
          correlationId,
        };
      }

      if (mapping.type === "group") {
        // Fetch all and filter in memory (filter query may not work reliably)
        const members = await this.graphRequest<{
          value: Array<{ id: string }>;
        }>(
          `/groups/${mapping.value}/members?$select=id`,
        );
        const found = members.value && members.value.some((m) => m.id === resolvedSubject.providerSubjectId);
        return {
          status:
            found
              ? "verified"
              : "not-found",
          provider: "entra",
          providerObjectId: mapping.value,
          correlationId,
        };
      } else if (mapping.type === "appRole") {
        // Use servicePrincipalId for app role assignments
        const assignments = await this.graphRequest<{
          value: Array<{ id: string; principalId: string; appRoleId: string }>;
        }>(
          `/servicePrincipals/${this.config.servicePrincipalId}/appRoleAssignedTo`,
        );
        const found = assignments.value?.some(
          (a) =>
            a.principalId === resolvedSubject.providerSubjectId &&
            a.appRoleId === mapping.value,
        );
        return {
          status: found ? "verified" : "not-found",
          provider: "entra",
          providerObjectId: this.config.servicePrincipalId,
          correlationId,
        };
      }

      return {
        status: "failed",
        provider: "entra",
        providerObjectId: undefined,
        error: `Unsupported mapping type: ${mapping.type}`,
        correlationId,
      };
    } catch (error: any) {
      return {
        status: "failed",
        provider: "entra",
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
      const mapping = permission.mappings.find((m) => m.provider === "entra");
      if (!mapping) {
        return {
          status: "failed",
          mutated: false,
          provider: "entra",
          providerObjectId: undefined,
          error: `No Entra mapping found for permission ${permission.id}`,
          correlationId,
        };
      }

      if (mapping.type === "group") {
        try {
          await this.graphRequest(
            `/groups/${mapping.value}/members/${resolvedSubject.providerSubjectId}/$ref`,
            {
              method: "DELETE",
            },
          );
          return {
            status: "succeeded",
            mutated: true,
            provider: "entra",
            providerObjectId: mapping.value,
            correlationId,
          };
        } catch (error: any) {
          if (
            error.status === 404 ||
            error.code === "Request_ResourceNotFound"
          ) {
            return {
              status: "succeeded",
              mutated: false,
              provider: "entra",
              providerObjectId: mapping.value,
              correlationId,
            };
          }
          throw error;
        }
      } else if (mapping.type === "appRole") {
        // Use servicePrincipalId for app role assignments
        const assignments = await this.graphRequest<{
          value: Array<{ id: string; principalId: string; appRoleId: string }>;
        }>(
          `/servicePrincipals/${this.config.servicePrincipalId}/appRoleAssignedTo`,
        );
        const found = assignments.value?.find(
          (a) =>
            a.principalId === resolvedSubject.providerSubjectId &&
            a.appRoleId === mapping.value,
        );

        if (!found) {
          return {
            status: "succeeded",
            mutated: false,
            provider: "entra",
            providerObjectId: this.config.servicePrincipalId,
            correlationId,
          };
        }

        try {
          await this.graphRequest(
            `/servicePrincipals/${this.config.servicePrincipalId}/appRoleAssignedTo/${found.id}`,
            {
              method: "DELETE",
            },
          );
          return {
            status: "succeeded",
            mutated: true,
            provider: "entra",
            providerObjectId: this.config.servicePrincipalId,
            correlationId,
          };
        } catch (error: any) {
          if (
            error.status === 404 ||
            error.code === "Request_ResourceNotFound"
          ) {
            return {
              status: "succeeded",
              mutated: false,
              provider: "entra",
              providerObjectId: this.config.servicePrincipalId,
              correlationId,
            };
          }
          throw error;
        }
      }

      return {
        status: "failed",
        mutated: false,
        provider: "entra",
        providerObjectId: undefined,
        error: `Unsupported mapping type: ${mapping.type}`,
        correlationId,
      };
    } catch (error: any) {
      return {
        status: "failed",
        mutated: false,
        provider: "entra",
        providerObjectId: undefined,
        error: error.message,
        correlationId,
      };
    }
  }
}
