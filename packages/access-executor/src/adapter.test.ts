import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GitHubAccessExecutor, InMemoryIdempotencyStore, GitHubExecutorConfig } from "./index.js";
import { InMemoryAuditEventStore } from "@opnory/access-audit";
import { ApprovedAccessRequest } from "@opnory/access-types";

// Mock Octokit
const mockOctokitRequest = vi.fn();

vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    request: mockOctokitRequest,
  })),
}));

vi.mock("@octokit/auth-app", () => ({
  createAppAuth: vi.fn(),
}));

describe("GitHubAccessExecutor - Adapter Tests", () => {
  let executor: GitHubAccessExecutor;
  let idempotencyStore: InMemoryIdempotencyStore;
  let auditStore: InMemoryAuditEventStore;

  const baseConfig: GitHubExecutorConfig = {
    appId: "12345",
    installationId: "67890",
    privateKey: "-----BEGIN RSA PRIVATE KEY-----\nMOCK_KEY\n-----END RSA PRIVATE KEY-----",
    allowedOrganizations: ["opnory-sandbox"],
    allowedTeams: ["opnory-engineering-contributors"],
  };

  const baseRequest = (overrides: Partial<ApprovedAccessRequest> = {}): ApprovedAccessRequest => ({
    id: "123e4567-e89b-12d3-a456-426614174000",
    correlationId: "123e4567-e89b-12d3-a456-426614174001",
    requesterId: "user-789",
    requesterEmail: "user@example.com",
    entitlement: {
      id: "123e4567-e89b-12d3-a456-426614174002",
      name: "GitHub Engineering Contributor",
      system: "github",
      githubConfig: {
        organization: "opnory-sandbox",
        teamSlug: "opnory-engineering-contributors",
        teamRole: "member",
      },
    },
    reason: "Need access to engineering repos",
    status: "APPROVED",
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    approvedAt: new Date().toISOString(),
    approvedBy: "manager@example.com",
    idempotencyKey: "123e4567-e89b-12d3-a456-426614174000:123e4567-e89b-12d3-a456-426614174002:user-789",
    metadata: {},
    externalIdentities: {
      github: {
        login: "testuser",
        verified: true,
        verifiedAt: new Date().toISOString(),
        source: "admin",
      },
    },
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    idempotencyStore = new InMemoryIdempotencyStore();
    auditStore = new InMemoryAuditEventStore();
    
    // Create mock Octokit
    const mockOctokit = {
      request: mockOctokitRequest,
    };
    
    // Create executor with mocked Octokit
    executor = new GitHubAccessExecutor(baseConfig, idempotencyStore, auditStore, mockOctokit as any);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("Pre-flight checks", () => {
    it("should verify installation resolves to correct org", async () => {
      mockOctokitRequest
        .mockResolvedValueOnce({ data: { account: { login: "opnory-sandbox" } } }) // preflight installation check
        .mockRejectedValueOnce({ status: 404 }) // getTeamMembership - not found
        .mockResolvedValueOnce({ // putTeamMembership
          data: { state: "active", role: "member", user: { login: "testuser", id: 123 } },
        })
        .mockResolvedValueOnce({ // reconciliation GET
          data: { state: "active", role: "member", user: { login: "testuser", id: 123 } },
        });

      const request = baseRequest();
      const result = await executor.grant(request);
      
      expect(result.success).toBe(true);
      // Should have made installation verification call
      expect(mockOctokitRequest).toHaveBeenCalledWith(
        "GET /app/installations/{installation_id}",
        expect.objectContaining({ installation_id: 67890 })
      );
    });

    it("should fail if installation belongs to different org", async () => {
      mockOctokitRequest
        .mockResolvedValueOnce({ data: { account: { login: "wrong-org" } } }); // preflight

      const request = baseRequest();
      const result = await executor.grant(request);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain("belongs to wrong-org");
    });

    it("should fail if org not in allowlist", async () => {
      const request = baseRequest({
        entitlement: {
          ...baseRequest().entitlement,
          githubConfig: {
            organization: "evil-org",
            teamSlug: "opnory-engineering-contributors",
            teamRole: "member",
          },
        },
      });
      
      const result = await executor.grant(request);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain("not in the allowlist");
      // Should not make any API calls - allowlist check happens first
      expect(mockOctokitRequest).not.toHaveBeenCalled();
    });

    it("should fail if team not in allowlist", async () => {
      const request = baseRequest({
        entitlement: {
          ...baseRequest().entitlement,
          githubConfig: {
            organization: "opnory-sandbox",
            teamSlug: "evil-team",
            teamRole: "member",
          },
        },
      });
      
      const result = await executor.grant(request);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain("not in the allowlist");
    });

    it("should fail if github identity missing", async () => {
      const request = baseRequest({
        externalIdentities: {},
      });
      
      const result = await executor.grant(request);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain("missing github identity");
    });

    it("should fail if github identity not verified", async () => {
      const request = baseRequest({
        externalIdentities: {
          github: {
            login: "testuser",
            verified: false,
            source: "admin",
          },
        },
      });
      
      const result = await executor.grant(request);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain("not verified");
    });

    it("should fail if github login missing", async () => {
      const request = baseRequest({
        externalIdentities: {
          github: {
            login: "",
            verified: true,
            source: "admin",
          },
        },
      });
      
      const result = await executor.grant(request);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain("missing login");
    });
  });

  describe("Existing active/member → no PUT → idempotent success", () => {
    it("should return idempotent success when already member with correct role", async () => {
      mockOctokitRequest
        .mockResolvedValueOnce({ data: { account: { login: "opnory-sandbox" } } }) // preflight
        .mockResolvedValueOnce({ // getTeamMembership - already member
          data: {
            state: "active",
            role: "member",
            user: { login: "testuser", id: 123 },
          },
        });

      const request = baseRequest();
      const result = await executor.grant(request);
      
      expect(result.success).toBe(true);
      expect(result.message).toContain("Already member");
      // Should NOT call PUT
      const putCalls = mockOctokitRequest.mock.calls.filter(
        (call) => call[0]?.startsWith("PUT")
      );
      expect(putCalls.length).toBe(0);
    });

    it("should handle role mismatch - existing maintainer but requested member", async () => {
      mockOctokitRequest
        .mockResolvedValueOnce({ data: { account: { login: "opnory-sandbox" } } }) // preflight
        .mockResolvedValueOnce({ // getTeamMembership - maintainer
          data: {
            state: "active",
            role: "maintainer",
            user: { login: "testuser", id: 123 },
          },
        })
        .mockResolvedValueOnce({ // PUT to downgrade
          data: { state: "active", role: "member", user: { login: "testuser", id: 123 } },
        })
        .mockResolvedValueOnce({ // reconciliation GET
          data: { state: "active", role: "member", user: { login: "testuser", id: 123 } },
        });

      const request = baseRequest({
        entitlement: {
          ...baseRequest().entitlement,
          githubConfig: {
            organization: "opnory-sandbox",
            teamSlug: "opnory-engineering-contributors",
            teamRole: "member", // requested member
          },
        },
      });
      
      const result = await executor.grant(request);
      
      // Current behavior: PUT to update role, then reconciliation succeeds
      expect(result.success).toBe(true);
    });
  });

  describe("404 membership → PUT → GET active → success", () => {
    it("should add member when not found", async () => {
      mockOctokitRequest
        .mockResolvedValueOnce({ data: { account: { login: "opnory-sandbox" } } }) // preflight
        .mockResolvedValueOnce({ status: 404 }) // getTeamMembership - not found
        .mockResolvedValueOnce({ // putTeamMembership
          data: { state: "active", role: "member", user: { login: "testuser", id: 123 } },
        })
        .mockResolvedValueOnce({ // reconciliation GET
          data: { state: "active", role: "member", user: { login: "testuser", id: 123 } },
        });

      const request = baseRequest();
      const result = await executor.grant(request);
      
      expect(result.success).toBe(true);
      expect(result.message).toContain("Successfully granted");
      // Verify PUT was called
      const putCalls = mockOctokitRequest.mock.calls.filter(
        (call) => call[0]?.startsWith("PUT")
      );
      expect(putCalls.length).toBe(1);
    });
  });

  describe("PUT/GET returns pending → AWAITING_EXTERNAL_ACCEPTANCE", () => {
    it("should return AWAITING_EXTERNAL_ACCEPTANCE when membership pending after PUT", async () => {
      mockOctokitRequest
        .mockResolvedValueOnce({ data: { account: { login: "opnory-sandbox" } } }) // preflight
        .mockResolvedValueOnce({ status: 404 }) // getTeamMembership - not found
        .mockResolvedValueOnce({ // putTeamMembership
          data: { state: "pending", role: "member", user: { login: "testuser", id: 123 } },
        })
        .mockResolvedValueOnce({ // reconciliation GET
          data: { state: "pending", role: "member", user: { login: "testuser", id: 123 } },
        });

      const request = baseRequest();
      const result = await executor.grant(request);
      
      expect(result.success).toBe(true);
      expect(result.status).toBe("AWAITING_EXTERNAL_ACCEPTANCE");
      expect(result.message).toContain("awaiting user acceptance");
    });
  });

  describe("403 team-sync → EXTERNAL_AUTHORITY_MANAGED", () => {
    it("should detect team-sync error and return EXTERNAL_AUTHORITY_MANAGED", async () => {
      mockOctokitRequest
        .mockResolvedValueOnce({ data: { account: { login: "opnory-sandbox" } } }) // preflight
        .mockResolvedValueOnce({ status: 404 }) // getTeamMembership - not found
        .mockRejectedValueOnce(new Error("Team is managed by an external identity provider (team_sync)"));

      const request = baseRequest();
      const result = await executor.grant(request);
      
      expect(result.success).toBe(false);
      expect(result.reason).toBe("EXTERNAL_AUTHORITY_MANAGED");
      expect(result.authority).toBe("github-team-sync");
      expect(result.message).toContain("external identity provider");
    });

    it("should NOT classify generic 403 as team-sync", async () => {
      mockOctokitRequest
        .mockResolvedValueOnce({ data: { account: { login: "opnory-sandbox" } } }) // preflight
        .mockResolvedValueOnce({ status: 404 }) // getTeamMembership - not found
        .mockRejectedValueOnce(new Error("Forbidden: insufficient permissions"));

      const request = baseRequest();
      const result = await executor.grant(request);
      
      expect(result.success).toBe(false);
      expect(result.reason).toBeUndefined(); // Should NOT be EXTERNAL_AUTHORITY_MANAGED
      expect(result.authority).toBeUndefined();
    });
  });

  describe("404 team → FAILED with safe diagnostics", () => {
    it("should return FAILED when team not found", async () => {
      mockOctokitRequest
        .mockResolvedValueOnce({ data: { account: { login: "opnory-sandbox" } } }) // preflight
        .mockRejectedValueOnce(new Error("Not Found"));

      const request = baseRequest();
      const result = await executor.grant(request);
      
      expect(result.success).toBe(false);
      // Should include safe diagnostic metadata in audit
      // (verified via audit store in integration test)
    });
  });

  describe("Idempotency", () => {
    it("should return idempotent success on duplicate request", async () => {
      // First call - full flow
      mockOctokitRequest
        .mockResolvedValueOnce({ data: { account: { login: "opnory-sandbox" } } }) // preflight
        .mockRejectedValueOnce({ status: 404 }) // getTeamMembership
        .mockResolvedValueOnce({ // putTeamMembership
          data: { state: "active", role: "member", user: { login: "testuser", id: 123 } },
        })
        .mockResolvedValueOnce({ // reconciliation GET
          data: { state: "active", role: "member", user: { login: "testuser", id: 123 } },
        });

      const request = baseRequest();
      const result1 = await executor.grant(request); // First call
      
      expect(result1.success).toBe(true);
      
      // Second call - should hit idempotency check BEFORE any API calls
      // Reset mocks - idempotency should prevent ALL API calls
      vi.clearAllMocks();
      mockOctokitRequest.mockResolvedValue({ data: { account: { login: "opnory-sandbox" } } });
      
      const result2 = await executor.grant(request); // Second call
      
      expect(result2.success).toBe(true);
      expect(result2.message).toContain("idempotent");
      // Should not make ANY API calls due to idempotency check
      expect(mockOctokitRequest).toHaveBeenCalledTimes(0); // No calls at all
    });
  });

  describe("Reconciliation role mismatch", () => {
    it("should FAIL with RECONCILIATION_MISMATCH if reconciled role doesn't match requested", async () => {
      mockOctokitRequest
        .mockResolvedValueOnce({ data: { account: { login: "opnory-sandbox" } } }) // preflight
        .mockResolvedValueOnce({ status: 404 }) // getTeamMembership
        .mockResolvedValueOnce({ // putTeamMembership
          data: { state: "active", role: "maintainer", user: { login: "testuser", id: 123 } },
        })
        .mockResolvedValueOnce({ // reconciliation GET - role mismatch!
          data: { state: "active", role: "maintainer", user: { login: "testuser", id: 123 } },
        });

      const request = baseRequest({
        entitlement: {
          ...baseRequest().entitlement,
          githubConfig: {
            organization: "opnory-sandbox",
            teamSlug: "opnory-engineering-contributors",
            teamRole: "member", // requested member but got maintainer
          },
        },
      });
      
      const result = await executor.grant(request);
      
      // Should FAIL with RECONCILIATION_MISMATCH
      expect(result.success).toBe(false);
      expect(result.status).toBe("FAILED");
      expect(result.reason).toBe("RECONCILIATION_MISMATCH");
      expect(result.error).toContain("Reconciliation role mismatch");
      expect(result.error).toContain("member");
      expect(result.error).toContain("maintainer");
    });
  });

  describe("Revocation - CASE 15: Normal revocation", () => {
    it("should DELETE and reconcile absence for active member", async () => {
      // Mock for preflight, GET (active), DELETE, GET (404)
      mockOctokitRequest
        .mockResolvedValueOnce({ data: { account: { login: "opnory-sandbox" } } }) // preflight
        .mockResolvedValueOnce({ // getTeamMembership - active member
          data: { state: "active", role: "member", user: { login: "testuser", id: 123 } },
        })
        .mockResolvedValueOnce({}) // DELETE
        .mockRejectedValueOnce({ status: 404 }); // reconciliation GET - 404 (absent)

      const { toFulfilledAccessRequest } = await import("@opnory/access-types");
      const fulfilledRequest = toFulfilledAccessRequest({
        ...baseRequest(),
        status: "FULFILLED",
        fulfilledAt: new Date().toISOString(),
        externalId: "github-team-membership-testuser-opnory-sandbox-opnory-engineering-contributors",
      });

      const result = await executor.revoke(fulfilledRequest);

      expect(result.success).toBe(true);
      expect(result.message).toContain("revoked");
      // Should have called DELETE exactly once
      const deleteCalls = mockOctokitRequest.mock.calls.filter(
        (call) => call[0]?.startsWith("DELETE")
      );
      expect(deleteCalls.length).toBe(1);
    });
  });

  describe("Revocation - CASE 16: Already absent", () => {
    it("should return idempotent REVOKED when membership already absent", async () => {
      mockOctokitRequest
        .mockResolvedValueOnce({ data: { account: { login: "opnory-sandbox" } } }) // preflight
        .mockRejectedValueOnce({ status: 404 }); // getTeamMembership - already absent

      const { toFulfilledAccessRequest } = await import("@opnory/access-types");
      const fulfilledRequest = toFulfilledAccessRequest({
        ...baseRequest(),
        status: "FULFILLED",
        fulfilledAt: new Date().toISOString(),
        externalId: "github-team-membership-testuser-opnory-sandbox-opnory-engineering-contributors",
      });

      const result = await executor.revoke(fulfilledRequest);

      expect(result.success).toBe(true);
      expect(result.message).toContain("absent");
      // Should NOT call DELETE
      const deleteCalls = mockOctokitRequest.mock.calls.filter(
        (call) => call[0]?.startsWith("DELETE")
      );
      expect(deleteCalls.length).toBe(0);
    });
  });

  describe("Revocation - CASE 17: DELETE succeeds but membership remains", () => {
    it("should FAIL with REVOCATION_RECONCILIATION_FAILED when reconciliation shows still active", async () => {
      mockOctokitRequest
        .mockResolvedValueOnce({ data: { account: { login: "opnory-sandbox" } } }) // preflight
        .mockResolvedValueOnce({ // getTeamMembership - active
          data: { state: "active", role: "member", user: { login: "testuser", id: 123 } },
        })
        .mockResolvedValueOnce({}) // DELETE
        .mockResolvedValueOnce({ // reconciliation GET - still active!
          data: { state: "active", role: "member", user: { login: "testuser", id: 123 } },
        });

      const { toFulfilledAccessRequest } = await import("@opnory/access-types");
      const fulfilledRequest = toFulfilledAccessRequest({
        ...baseRequest(),
        status: "FULFILLED",
        fulfilledAt: new Date().toISOString(),
        externalId: "github-team-membership-testuser-opnory-sandbox-opnory-engineering-contributors",
      });

      const result = await executor.revoke(fulfilledRequest);

      expect(result.success).toBe(false);
      expect(result.reason).toBe("REVOCATION_RECONCILIATION_FAILED");
      expect(result.error).toContain("still has");
    });
  });

  describe("Revocation - CASE 18: Generic GitHub failure", () => {
    it("should not claim access removed on generic failure", async () => {
      mockOctokitRequest
        .mockResolvedValueOnce({ data: { account: { login: "opnory-sandbox" } } }) // preflight
        .mockResolvedValueOnce({ // getTeamMembership - active
          data: { state: "active", role: "member", user: { login: "testuser", id: 123 } },
        })
        .mockRejectedValueOnce(new Error("Network error")); // DELETE fails

      const { toFulfilledAccessRequest } = await import("@opnory/access-types");
      const fulfilledRequest = toFulfilledAccessRequest({
        ...baseRequest(),
        status: "FULFILLED",
        fulfilledAt: new Date().toISOString(),
        externalId: "github-team-membership-testuser-opnory-sandbox-opnory-engineering-contributors",
      });

      const result = await executor.revoke(fulfilledRequest);

      expect(result.success).toBe(false);
      expect(result.message).not.toContain("removed");
      expect(result.message).not.toContain("revoked");
    });
  });

  describe("Revocation - CASE 19: Team-sync/external authority", () => {
    it("should classify EXTERNAL_AUTHORITY_MANAGED and not mutate", async () => {
      mockOctokitRequest
        .mockResolvedValueOnce({ data: { account: { login: "opnory-sandbox" } } }) // preflight
        .mockResolvedValueOnce({ // getTeamMembership - active
          data: { state: "active", role: "member", user: { login: "testuser", id: 123 } },
        })
        .mockRejectedValueOnce(new Error("Team is managed by an external identity provider (team_sync)")); // DELETE fails with team-sync

      const { toFulfilledAccessRequest } = await import("@opnory/access-types");
      const fulfilledRequest = toFulfilledAccessRequest({
        ...baseRequest(),
        status: "FULFILLED",
        fulfilledAt: new Date().toISOString(),
        externalId: "github-team-membership-testuser-opnory-sandbox-opnory-engineering-contributors",
      });

      const result = await executor.revoke(fulfilledRequest);

      expect(result.success).toBe(false);
      expect(result.reason).toBe("EXTERNAL_AUTHORITY_MANAGED");
      expect(result.authority).toBe("github-team-sync");
    });
  });

  describe("Revocation - CASE 20: Duplicate revoke", () => {
    it("should be idempotent - second revoke returns success with zero extra DELETE", async () => {
      // First revoke - full flow
      mockOctokitRequest
        .mockResolvedValueOnce({ data: { account: { login: "opnory-sandbox" } } }) // preflight
        .mockResolvedValueOnce({ // getTeamMembership - active
          data: { state: "active", role: "member", user: { login: "testuser", id: 123 } },
        })
        .mockResolvedValueOnce({}) // DELETE
        .mockRejectedValueOnce({ status: 404 }); // reconciliation GET

      const { toFulfilledAccessRequest } = await import("@opnory/access-types");
      const fulfilledRequest = toFulfilledAccessRequest({
        ...baseRequest(),
        status: "FULFILLED",
        fulfilledAt: new Date().toISOString(),
        externalId: "github-team-membership-testuser-opnory-sandbox-opnory-engineering-contributors",
      });

      const result1 = await executor.revoke(fulfilledRequest);
      expect(result1.success).toBe(true);

      // Second revoke - should hit idempotency check
      vi.clearAllMocks();
      mockOctokitRequest.mockResolvedValue({ data: { account: { login: "opnory-sandbox" } } });

      const result2 = await executor.revoke(fulfilledRequest);
      expect(result2.success).toBe(true);
      expect(result2.message).toContain("idempotent");
      // Should not make ANY API calls
      expect(mockOctokitRequest).toHaveBeenCalledTimes(0);
    });
  });

  describe("Revocation - CASE 21: Wrong lifecycle state", () => {
    it("should reject revoke for PENDING_APPROVAL request", async () => {
      const { toFulfilledAccessRequest } = await import("@opnory/access-types");
      const notFulfilledRequest = {
        ...baseRequest(),
        status: "PENDING_APPROVAL" as const,
        approvedAt: new Date().toISOString(),
        approvedBy: "manager@example.com",
        fulfilledAt: undefined,
        externalId: undefined,
      };

      expect(() => toFulfilledAccessRequest(notFulfilledRequest)).toThrow("Must be FULFILLED");
    });

    it("should reject revoke for DENIED request", async () => {
      const { toFulfilledAccessRequest } = await import("@opnory/access-types");
      const deniedRequest = {
        ...baseRequest(),
        status: "DENIED" as const,
        approvedAt: new Date().toISOString(),
        approvedBy: "manager@example.com",
        deniedAt: new Date().toISOString(),
        deniedBy: "manager@example.com",
        fulfilledAt: undefined,
        externalId: undefined,
      };

      expect(() => toFulfilledAccessRequest(deniedRequest)).toThrow("Must be FULFILLED");
    });

    it("should reject revoke for FAILED request", async () => {
      const { toFulfilledAccessRequest } = await import("@opnory/access-types");
      const failedRequest = {
        ...baseRequest(),
        status: "FAILED" as const,
        approvedAt: new Date().toISOString(),
        approvedBy: "manager@example.com",
        fulfilledAt: undefined,
        externalId: undefined,
      };

      expect(() => toFulfilledAccessRequest(failedRequest)).toThrow("Must be FULFILLED");
    });

    it("should reject revoke for already REVOKED request", async () => {
      const { toFulfilledAccessRequest } = await import("@opnory/access-types");
      const revokedRequest = {
        ...baseRequest(),
        status: "REVOKED" as const,
        approvedAt: new Date().toISOString(),
        approvedBy: "manager@example.com",
        fulfilledAt: new Date().toISOString(),
        externalId: "some-external-id",
      };

      expect(() => toFulfilledAccessRequest(revokedRequest)).toThrow("Must be FULFILLED");
    });
  });
});