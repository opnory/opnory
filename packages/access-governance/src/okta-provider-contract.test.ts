import { describe, it, expect, beforeEach, vi } from "bun:test";
import { OktaGovernanceProvider, OktaConfig } from "@opnory/access-governance";
import {
  GovernanceSubject,
  GovernedEntitlement,
  GovernedAccessRequest,
  GovernanceRequest,
  GovernanceRequestStatus,
  GovernanceAssignment,
  GovernanceRevocationResult,
  EntitlementRef,
  ExternalIdentity,
} from "@opnory/access-types";
import { randomUUID } from "crypto";

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("OktaGovernanceProvider Contract Tests", () => {
  let provider: OktaGovernanceProvider;
  const testConfig: OktaConfig = {
    orgUrl: "https://test-org.okta.com",
    clientId: "test-client-id",
    privateKey: "test-key", // Not used in tests due to token injection
    keyId: "test-key-id",
    requestConditionId: "request-condition-123",
    scopes: [
      "okta.accessRequests.request.read",
      "okta.accessRequests.request.manage",
      "okta.accessRequests.condition.read",
    ],
  };

  const testSubject: GovernanceSubject = {
    id: "okta-user-123",
    displayName: "Test User",
    email: "test@example.com",
    source: "okta",
    raw: { login: "testuser" },
  };

  const testEntitlement: GovernedEntitlement = {
    entitlementId: "123e4567-e89b-12d3-a456-426614174001",
    authority: "okta",
    externalId: "group-789",
    externalName: "Test Group",
    metadata: {
      system: "okta",
      groupId: "group-789",
      appId: "app-123",
      requestConditionId: "request-condition-123",
    },
  };

  const testEntitlementRef: EntitlementRef = {
    id: "123e4567-e89b-12d3-a456-426614174000",
    name: "Test Group",
    system: "okta",
    governance: {
      provider: "okta",
      orgUrl: "https://test-org.okta.com",
      appId: "app-123",
      groupId: "group-789",
    },
  };

  const testExternalIdentities: ExternalIdentity = {
    github: { login: "testuser", verified: false, source: "admin" },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset global fetch mock to the original vi.fn()
    global.fetch = mockFetch;
    mockFetch.mockClear();
    // Clear any pre-existing mock implementations
    mockFetch.mockReset();
    provider = new OktaGovernanceProvider(testConfig);
    // Inject test token provider to avoid JWT generation
    provider.__setTestTokenProvider(async () => "oauth-token");
  });

  describe("submitRequest()", () => {
    it("should POST to /governance/api/v2/requests", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "access-request-123",
          status: "PENDING_APPROVAL",
          state: "PENDING",
          created: "2024-01-15T10:00:00.000Z",
          target: { id: "target-456", type: "GROUP_MEMBERSHIP" },
          requestCondition: { id: "request-condition-123" },
        }),
      });

      const request: GovernedAccessRequest = {
        requestId: randomUUID(),
        subject: testSubject,
        entitlement: testEntitlement,
        justification: "Need access for project",
      };

      const result = await provider.submitRequest(request);

      expect(result.externalRequestId).toBe("access-request-123");
      expect(result.authority).toBe("okta");
      expect(result.status).toBe("PENDING");
      expect(result.assignmentId).toBe("target-456");
      expect(result.metadata?.requestConditionId).toBe("request-condition-123");

      const oktaCall = mockFetch.mock.calls[0];
      expect(oktaCall[0]).toBe(
        "https://test-org.okta.com/governance/api/v2/requests",
      );
      expect(oktaCall[1].method).toBe("POST");
      const body = JSON.parse(oktaCall[1].body as string);
      expect(body.requestConditionId).toBe("request-condition-123");
      expect(body.subjectId).toBe("okta-user-123");
      expect(body.justification).toBe("Need access for project");
    });

    it("should handle immediate approval (RESOLVED state)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "access-request-123",
          status: "APPROVED",
          state: "RESOLVED",
          created: "2024-01-15T10:00:00.000Z",
          target: { id: "membership-456", type: "GROUP_MEMBERSHIP" },
          requestCondition: { id: "request-condition-123" },
        }),
      });

      const request: GovernedAccessRequest = {
        requestId: randomUUID(),
        subject: testSubject,
        entitlement: testEntitlement,
        justification: "Test",
      };

      const result = await provider.submitRequest(request);

      expect(result.status).toBe("APPROVED");
    });
  });

  describe("getRequestStatus()", () => {
    it("should GET /governance/api/v2/requests/{id}", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "access-request-123",
          status: "APPROVED",
          state: "RESOLVED",
          created: "2024-01-15T10:00:00.000Z",
          target: {
            id: "membership-456",
            type: "GROUP_MEMBERSHIP",
            endDate: "2024-04-15T10:00:00.000Z",
          },
          resolved: "2024-01-15T10:05:00.000Z",
        }),
      });

      const result = await provider.getRequestStatus("access-request-123");

      expect(result.externalRequestId).toBe("access-request-123");
      expect(result.status).toBe("APPROVED");
      expect(result.assignmentId).toBe("membership-456");
      expect(result.assignmentExpiresAt).toBe("2024-04-15T10:00:00.000Z");

      const oktaCall = mockFetch.mock.calls[0];
      expect(oktaCall[0]).toBe(
        "https://test-org.okta.com/governance/api/v2/requests/access-request-123",
      );
    });

    it("should return FAILED on API error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => "Not found",
      });

      const result = await provider.getRequestStatus("invalid-id");

      expect(result.status).toBe("FAILED");
    });

    it("should map Okta OIG states correctly", async () => {
      const testCases = [
        { status: "PENDING_APPROVAL", state: "PENDING", expected: "PENDING" },
        { status: "PENDING_APPROVAL", state: "ACTIVE", expected: "PENDING" },
        { status: "APPROVED", state: "RESOLVED", expected: "APPROVED" },
        { status: "DENIED", state: "RESOLVED", expected: "DENIED" },
        { status: "REJECTED", state: "REJECTED", expected: "DENIED" },
        { status: "EXPIRED", state: "EXPIRED", expected: "CANCELLED" },
        { status: "CANCELLED", state: "CANCELLED", expected: "CANCELLED" },
      ];

      for (const { status, state, expected } of testCases) {
        vi.clearAllMocks();
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: "req-1",
            status,
            state,
            created: new Date().toISOString(),
          }),
        });

        const result = await provider.getRequestStatus("req-1");
        expect(result.status).toBe(
          expected as
            "PENDING" | "APPROVED" | "DENIED" | "CANCELLED" | "FAILED",
        );
      }
    });
  });

  describe("getAssignment()", () => {
    it("should check group membership via /api/v1/users/{userId}/groups", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { id: "group-789", profile: { name: "Test Group" } },
          ],
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [], // OIG requests fallback
        });

      const result = await provider.getAssignment(testSubject, testEntitlement);

      expect(result).not.toBeNull();
      expect(result!.assignmentId).toBe(
        "okta-group-membership-okta-user-123-group-789",
      );
      expect(result!.status).toBe("ACTIVE");
      expect(result!.raw?.groupId).toBe("group-789");
    });

    it("should fall back to OIG requests when group membership not found", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [{ id: "other-group", profile: { name: "Other" } }],
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            {
              id: "oig-request-123",
              status: "APPROVED",
              state: "RESOLVED",
              subjectId: "okta-user-123",
              requestConditionId: "request-condition-123",
              target: {
                id: "oig-assignment-456",
                type: "APP_ASSIGNMENT",
                endDate: "2024-04-15T10:00:00.000Z",
              },
            },
          ],
        });

      const result = await provider.getAssignment(testSubject, testEntitlement);

      expect(result).not.toBeNull();
      expect(result!.assignmentId).toBe("oig-assignment-456");
      expect(result!.expiresAt).toBe("2024-04-15T10:00:00.000Z");

      // Verify the calls (token, groups, OIG requests)
      expect(mockFetch.mock.calls[0][0]).toBe(
        "https://test-org.okta.com/api/v1/users/okta-user-123/groups",
      );
      expect(mockFetch.mock.calls[1][0]).toContain(
        "governance/api/v2/requests?subjectId=okta-user-123&requestConditionId=request-condition-123",
      );
    });

    it("should return null when no assignment found", async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => [] })
        .mockResolvedValueOnce({ ok: true, json: async () => [] });

      const result = await provider.getAssignment(testSubject, testEntitlement);
      expect(result).toBeNull();
    });
  });

  describe("revokeAssignment()", () => {
    it("should POST to revoke-principal-access when principalOrn and resourceOrn present (authoritative revocation)", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 204 }); // POST revoke-principal-access

      const assignment: GovernanceAssignment = {
        assignmentId: "okta-principal-access-grant-123",
        subject: testSubject,
        entitlement: testEntitlement,
        authority: "okta",
        grantedAt: "2024-01-15T10:00:00.000Z",
        status: "ACTIVE",
        raw: {
          groupId: "group-789",
          principalOrn: "okta:principal:user:123",
          resourceOrn: "okta:resource:group:789",
        },
      };

      const result = await provider.revokeAssignment(assignment);

      expect(result.success).toBe(true);
      expect(result.authority).toBe("okta");
      expect(result.message).toBe("Okta principal access revoked");

      // Should call documented Principal Access v2 revocation endpoint
      expect(mockFetch.mock.calls[0][0]).toBe(
        "https://test-org.okta.com/governance/api/v2/revoke-principal-access",
      );
      expect(mockFetch.mock.calls[0][1].method).toBe("POST");
      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.principalOrn).toBe("okta:principal:user:123");
      expect(body.actor).toBe("ADMIN");
      expect(body.revokeOrns).toEqual(["okta:resource:group:789"]);
    });

    it("should fall back to observe-only when revoke-principal-access fails (Beta endpoint unavailable)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => "Not found",
      });

      const assignment: GovernanceAssignment = {
        assignmentId: "okta-principal-access-grant-123",
        subject: testSubject,
        entitlement: testEntitlement,
        authority: "okta",
        grantedAt: "2024-01-15T10:00:00.000Z",
        status: "ACTIVE",
        raw: {
          groupId: "group-789",
          principalOrn: "okta:principal:user:123",
          resourceOrn: "okta:resource:group:789",
        },
      };

      const result = await provider.revokeAssignment(assignment);

      expect(result.success).toBe(true);
      expect(result.authority).toBe("okta");
      expect(result.message).toBe(
        "Okta governance revocation observed (revoke-principal-access unavailable; manual remediation may be required)",
      );
      expect(result.metadata).toEqual(
        expect.objectContaining({ fallback: true }),
      );
      expect(result.status).toBe("OBSERVE_ONLY");
      expect(result.authoritativeMutationPerformed).toBe(false);
      expect(result.fallbackReason).toBe("REVOCATION_API_UNAVAILABLE");
    });

    it("should observe governance revocation when no authoritative grant (no principalOrn/resourceOrn)", async () => {
      // No mock needed - no API calls beyond token (which is injected)

      const assignment: GovernanceAssignment = {
        assignmentId: "okta-group-membership-okta-user-123-group-789",
        subject: testSubject,
        entitlement: testEntitlement,
        authority: "okta",
        grantedAt: "2024-01-15T10:00:00.000Z",
        status: "ACTIVE",
        raw: { groupId: "group-789" }, // No principalOrn/resourceOrn
      };

      const result = await provider.revokeAssignment(assignment);

      expect(result.success).toBe(true);
      expect(result.authority).toBe("okta");
      expect(result.message).toBe(
        "Okta governance revocation observed (no authoritative grant to revoke)",
      );

      // Should NOT make any API call beyond token fetch (no DELETE on requests)
      expect(mockFetch.mock.calls.length).toBe(0);
    });
  });

  describe("resolveSubject()", () => {
    it("should find user by email in Okta", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            id: "okta-user-123",
            profile: {
              login: "testuser",
              email: "test@example.com",
              firstName: "Test",
              lastName: "User",
            },
          },
        ],
      });

      const result = await provider.resolveSubject({
        requesterId: "opnory-user-1",
        requesterEmail: "test@example.com",
        externalIdentities: testExternalIdentities,
      });

      expect(result.id).toBe("okta-user-123");
      expect(result.source).toBe("okta");
      expect(result.displayName).toBe("Test User");
    });

    it("should fall back to manual when user not found", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });

      const result = await provider.resolveSubject({
        requesterId: "opnory-user-1",
        requesterEmail: "unknown@example.com",
        externalIdentities: testExternalIdentities,
      });

      expect(result.id).toBe("opnory-user-1");
      expect(result.source).toBe("manual");
    });
  });

  describe("resolveEntitlement()", () => {
    it("should map entitlement to group ID from governance config", async () => {
      const result = await provider.resolveEntitlement(testEntitlementRef);

      expect(result.entitlementId).toBe("123e4567-e89b-12d3-a456-426614174000");
      expect(result.authority).toBe("okta");
      expect(result.externalId).toBe("group-789");
      expect(result.metadata?.groupId).toBe("group-789");
      expect(result.metadata?.requestConditionId).toBe("request-condition-123");
    });

    it("should throw when governance config missing or wrong provider", async () => {
      const badEntitlement = { ...testEntitlementRef, governance: undefined };
      await expect(provider.resolveEntitlement(badEntitlement)).rejects.toThrow(
        "missing or invalid okta governance config",
      );

      const wrongProvider = {
        ...testEntitlementRef,
        governance: {
          ...testEntitlementRef.governance!,
          provider: "entra" as const,
        },
      };
      await expect(provider.resolveEntitlement(wrongProvider)).rejects.toThrow(
        "missing or invalid okta governance config",
      );
    });
  });

  describe("Authentication headers", () => {
    it("should use Bearer OAuth token with private_key_jwt (not SSWS)", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] }); // groups

      await provider.getAssignment(testSubject, testEntitlement);

      const call = mockFetch.mock.calls[0]; // First call is the actual API call (token is injected)
      expect(call[1].headers).toEqual(
        expect.objectContaining({
          Authorization: "Bearer oauth-token",
          Accept: "application/json",
          "Content-Type": "application/json",
        }),
      );
    });
  });
});
