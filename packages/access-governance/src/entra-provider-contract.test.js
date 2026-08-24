import { describe, it, expect, beforeEach, vi } from "bun:test";
import { EntraGovernanceProvider } from "@opnory/access-governance";
import { randomUUID } from "crypto";
// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;
describe("EntraGovernanceProvider Contract Tests", () => {
    let provider;
    const testConfig = {
        tenantId: "test-tenant-id",
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
    };
    const testSubject = {
        id: "entra-user-123",
        displayName: "Test User",
        email: "test@example.com",
        source: "entra",
        raw: { userPrincipalName: "test@example.com" },
    };
    const testEntitlement = {
        entitlementId: "123e4567-e89b-12d3-a456-426614174001",
        authority: "entra",
        externalId: "access-package-789",
        externalName: "Test Access Package",
        metadata: { system: "test", accessPackageId: "access-package-789" },
    };
    const testEntitlementRef = {
        id: "123e4567-e89b-12d3-a456-426614174000",
        name: "Test Access Package",
        system: "entra",
        governance: {
            provider: "entra",
            tenantId: "test-tenant-id",
            accessPackageId: "access-package-789",
            assignmentPolicyId: "policy-123",
        },
    };
    const testExternalIdentities = {
        github: { login: "testuser", verified: false, source: "admin" },
    };
    beforeEach(() => {
        vi.clearAllMocks();
        provider = new EntraGovernanceProvider(testConfig);
    });
    describe("Authentication", () => {
        it("should request token from Microsoft identity platform", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ access_token: "test-access-token", expires_in: 3600 }),
            });
            const token = await provider.getAccessToken();
            expect(token).toBe("test-access-token");
            expect(mockFetch).toHaveBeenCalledWith("https://login.microsoftonline.com/test-tenant-id/oauth2/v2.0/token", expect.objectContaining({
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
            }));
        });
        it("should cache token until near expiry", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ access_token: "cached-token", expires_in: 3600 }),
            });
            // First call
            await provider.getAccessToken();
            // Second call (should use cache)
            const token = await provider.getAccessToken();
            expect(token).toBe("cached-token");
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });
    });
    describe("submitRequest()", () => {
        it("should POST to /identityGovernance/entitlementManagement/assignmentRequests", async () => {
            const testProvider = new EntraGovernanceProvider({
                tenantId: "test-tenant-id",
                clientId: "test-client-id",
                clientSecret: "test-client-secret",
            });
            mockFetch
                .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ access_token: "test-token", expires_in: 3600 }),
            })
                .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    id: "assignment-request-123",
                    requestStatus: "PendingApproval",
                    createdDateTime: "2024-01-15T10:00:00Z",
                }),
            });
            const request = {
                requestId: randomUUID(),
                subject: testSubject,
                entitlement: testEntitlement,
                justification: "Need access for project",
                requestedDuration: "P30D",
            };
            const result = await testProvider.submitRequest(request);
            expect(result.externalRequestId).toBe("assignment-request-123");
            expect(result.authority).toBe("entra");
            expect(result.status).toBe("PENDING");
            expect(result.metadata?.opnoryRequestId).toBe(request.requestId);
            // Verify the Graph API call
            const graphCall = mockFetch.mock.calls[1];
            expect(graphCall[0]).toBe("https://graph.microsoft.com/v1.0/identityGovernance/entitlementManagement/assignmentRequests");
            expect(graphCall[1].method).toBe("POST");
            const body = JSON.parse(graphCall[1].body);
            expect(body.accessPackageId).toBe("access-package-789");
            expect(body.subjectId).toBe("entra-user-123");
            expect(body.assignmentType).toBe("UserAdd");
            expect(body.justification).toBe("Need access for project");
            expect(body.schedule).toBeDefined();
        });
        it("should include duration in schedule when requestedDuration provided", async () => {
            const testProvider = new EntraGovernanceProvider({
                tenantId: "test-tenant-id",
                clientId: "test-client-id",
                clientSecret: "test-client-secret",
            });
            mockFetch
                .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "t", expires_in: 3600 }) })
                .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "req-1", requestStatus: "PendingApproval", createdDateTime: new Date().toISOString() }) });
            await testProvider.submitRequest({
                requestId: randomUUID(),
                subject: testSubject,
                entitlement: testEntitlement,
                justification: "Test",
                requestedDuration: "P90D",
            });
            const body = JSON.parse(mockFetch.mock.calls[1][1].body);
            expect(body.schedule).toEqual({
                type: "Once",
                startDateTime: expect.any(String),
                endDateTime: expect.any(String),
            });
        });
    });
    describe("getRequestStatus()", () => {
        it("should GET /identityGovernance/entitlementManagement/assignmentRequests/{id}?$expand=assignment", async () => {
            const testProvider = new EntraGovernanceProvider({
                tenantId: "test-tenant-id",
                clientId: "test-client-id",
                clientSecret: "test-client-secret",
            });
            mockFetch
                .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "t", expires_in: 3600 }) })
                .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    id: "assignment-request-123",
                    requestStatus: "Delivered",
                    assignment: { id: "assignment-456", endDateTime: "2024-04-15T10:00:00Z" },
                    createdDateTime: "2024-01-15T10:00:00Z",
                }),
            });
            const result = await testProvider.getRequestStatus("assignment-request-123");
            expect(result.externalRequestId).toBe("assignment-request-123");
            expect(result.status).toBe("APPROVED");
            expect(result.assignmentId).toBe("assignment-456");
            expect(result.assignmentExpiresAt).toBe("2024-04-15T10:00:00Z");
            const graphCall = mockFetch.mock.calls[1];
            expect(graphCall[0]).toContain("assignmentRequests/assignment-request-123?$expand=assignment");
        });
        it("should return FAILED on API error", async () => {
            const testProvider = new EntraGovernanceProvider({
                tenantId: "test-tenant-id",
                clientId: "test-client-id",
                clientSecret: "test-client-secret",
            });
            mockFetch
                .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "t", expires_in: 3600 }) })
                .mockResolvedValueOnce({ ok: false, status: 404, text: async () => "Not found" });
            const result = await testProvider.getRequestStatus("invalid-id");
            expect(result.status).toBe("FAILED");
            expect(result.rawResponse).toBeUndefined();
        });
        it("should map Entra states correctly", async () => {
            const testCases = [
                { entraStatus: "PendingApproval", expected: "PENDING" },
                { entraStatus: "Delivering", expected: "APPROVED" },
                { entraStatus: "PartiallyDelivered", expected: "APPROVED" },
                { entraStatus: "Delivered", expected: "APPROVED" },
                { entraStatus: "Denied", expected: "DENIED" },
                { entraStatus: "Expired", expected: "CANCELLED" },
                { entraStatus: "Canceled", expected: "CANCELLED" },
            ];
            for (const { entraStatus, expected } of testCases) {
                vi.clearAllMocks();
                // Clear token cache by creating new provider instance
                const testProvider = new EntraGovernanceProvider({
                    tenantId: "test-tenant-id",
                    clientId: "test-client-id",
                    clientSecret: "test-client-secret",
                });
                mockFetch
                    .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "t", expires_in: 3600 }) })
                    .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({ id: "req-1", requestStatus: entraStatus, createdDateTime: new Date().toISOString() }),
                });
                const result = await testProvider.getRequestStatus("req-1");
                expect(result.status).toBe(expected);
            }
        });
    });
    describe("getAssignment()", () => {
        it("should GET /identityGovernance/entitlementManagement/assignments with filter", async () => {
            const testProvider = new EntraGovernanceProvider({
                tenantId: "test-tenant-id",
                clientId: "test-client-id",
                clientSecret: "test-client-secret",
            });
            mockFetch
                .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "t", expires_in: 3600 }) })
                .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    value: [{
                            id: "assignment-456",
                            accessPackageId: "access-package-789",
                            targetId: "entra-user-123",
                            schedule: { endDateTime: "2024-04-15T10:00:00Z" },
                            status: "Delivered",
                            assignmentType: "UserAdd",
                        }],
                }),
            });
            const result = await testProvider.getAssignment(testSubject, testEntitlement);
            expect(result).not.toBeNull();
            expect(result.assignmentId).toBe("assignment-456");
            expect(result.status).toBe("ACTIVE");
            expect(result.expiresAt).toBe("2024-04-15T10:00:00Z");
            const graphCall = mockFetch.mock.calls[1];
            expect(graphCall[0]).toContain("assignments?$filter=targetId eq 'entra-user-123' and accessPackageId eq 'access-package-789'");
        });
        it("should return null when no assignment found", async () => {
            const testProvider = new EntraGovernanceProvider({
                tenantId: "test-tenant-id",
                clientId: "test-client-id",
                clientSecret: "test-client-secret",
            });
            mockFetch
                .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "t", expires_in: 3600 }) })
                .mockResolvedValueOnce({ ok: true, json: async () => ({ value: [] }) });
            const result = await testProvider.getAssignment(testSubject, testEntitlement);
            expect(result).toBeNull();
        });
    });
    describe("revokeAssignment()", () => {
        it("should POST adminRemove to /identityGovernance/entitlementManagement/assignmentRequests", async () => {
            const testProvider = new EntraGovernanceProvider({
                tenantId: "test-tenant-id",
                clientId: "test-client-id",
                clientSecret: "test-client-secret",
            });
            mockFetch
                .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "t", expires_in: 3600 }) })
                .mockResolvedValueOnce({ ok: true, status: 202 });
            const assignment = {
                assignmentId: "assignment-456",
                subject: testSubject,
                entitlement: testEntitlement,
                authority: "entra",
                grantedAt: "2024-01-15T10:00:00Z",
                expiresAt: "2024-04-15T10:00:00Z",
                status: "ACTIVE",
            };
            const result = await testProvider.revokeAssignment(assignment);
            expect(result.success).toBe(true);
            expect(result.authority).toBe("entra");
            expect(result.assignmentId).toBe("assignment-456");
            expect(result.message).toBe("Entra assignment revocation requested");
            const graphCall = mockFetch.mock.calls[1];
            expect(graphCall[0]).toBe("https://graph.microsoft.com/v1.0/identityGovernance/entitlementManagement/assignmentRequests");
            expect(graphCall[1].method).toBe("POST");
            const body = JSON.parse(graphCall[1].body);
            expect(body.requestType).toBe("adminRemove");
            expect(body.assignment).toEqual({ id: "assignment-456" });
        });
        it("should return failure result on API error", async () => {
            const testProvider = new EntraGovernanceProvider({
                tenantId: "test-tenant-id",
                clientId: "test-client-id",
                clientSecret: "test-client-secret",
            });
            mockFetch
                .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "t", expires_in: 3600 }) })
                .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "Internal error" });
            const assignment = {
                assignmentId: "assignment-456",
                subject: testSubject,
                entitlement: testEntitlement,
                authority: "entra",
                grantedAt: "2024-01-15T10:00:00Z",
                status: "ACTIVE",
            };
            const result = await testProvider.revokeAssignment(assignment);
            expect(result.success).toBe(false);
            expect(result.error).toBeDefined();
        });
    });
    describe("resolveSubject()", () => {
        it("should find user by email in Entra", async () => {
            const testProvider = new EntraGovernanceProvider({
                tenantId: "test-tenant-id",
                clientId: "test-client-id",
                clientSecret: "test-client-secret",
            });
            mockFetch
                .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "t", expires_in: 3600 }) })
                .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    value: [{ id: "entra-user-123", displayName: "Test User", mail: "test@example.com", userPrincipalName: "test@example.com" }],
                }),
            });
            const result = await testProvider.resolveSubject({
                requesterId: "opnory-user-1",
                requesterEmail: "test@example.com",
                externalIdentities: testExternalIdentities,
            });
            expect(result.id).toBe("entra-user-123");
            expect(result.source).toBe("entra");
            expect(result.email).toBe("test@example.com");
        });
        it("should fall back to manual when user not found", async () => {
            const testProvider = new EntraGovernanceProvider({
                tenantId: "test-tenant-id",
                clientId: "test-client-id",
                clientSecret: "test-client-secret",
            });
            mockFetch
                .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "t", expires_in: 3600 }) })
                .mockResolvedValueOnce({ ok: true, json: async () => ({ value: [] }) });
            const result = await testProvider.resolveSubject({
                requesterId: "opnory-user-1",
                requesterEmail: "unknown@example.com",
                externalIdentities: testExternalIdentities,
            });
            expect(result.id).toBe("opnory-user-1");
            expect(result.source).toBe("manual");
        });
    });
    describe("resolveEntitlement()", () => {
        it("should map entitlement to access package ID from governance config", async () => {
            const result = await provider.resolveEntitlement(testEntitlementRef);
            expect(result.entitlementId).toBe("123e4567-e89b-12d3-a456-426614174000");
            expect(result.authority).toBe("entra");
            expect(result.externalId).toBe("access-package-789");
            expect(result.metadata?.accessPackageId).toBe("access-package-789");
        });
        it("should throw when governance config missing or wrong provider", async () => {
            const badEntitlement = { ...testEntitlementRef, governance: undefined };
            await expect(provider.resolveEntitlement(badEntitlement)).rejects.toThrow("missing or invalid entra governance config");
            const wrongProvider = { ...testEntitlementRef, governance: { ...testEntitlementRef.governance, provider: "okta" } };
            await expect(provider.resolveEntitlement(wrongProvider)).rejects.toThrow("missing or invalid entra governance config");
        });
    });
});
//# sourceMappingURL=entra-provider-contract.test.js.map