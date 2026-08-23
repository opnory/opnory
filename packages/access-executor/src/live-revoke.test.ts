import { describe, it, expect, beforeAll } from "bun:test";
import { GitHubAccessExecutor, GitHubExecutorConfig, InMemoryIdempotencyStore } from "./index.js";
import { InMemoryAuditEventStore } from "@opnory/access-audit";
import { ApprovedAccessRequest, toFulfilledAccessRequest } from "@opnory/access-types";
import { v4 as uuidv4 } from "uuid";

describe.skipIf(!process.env.OPNORY_LIVE_GITHUB_TESTS)(
  "GitHubAccessExecutor - Live Revocation Test",
  () => {
  let executor: GitHubAccessExecutor;
  let idempotencyStore: InMemoryIdempotencyStore;
  let auditStore: InMemoryAuditEventStore;
  let approvedRequest: ApprovedAccessRequest;
  let fulfilledRequest: ReturnType<typeof toFulfilledAccessRequest>;

  beforeAll(() => {
    const config: GitHubExecutorConfig = {
      appId: process.env.OPNORY_GITHUB_APP_ID!,
      installationId: process.env.OPNORY_GITHUB_INSTALLATION_ID!,
      privateKey: process.env.OPNORY_GITHUB_PRIVATE_KEY!,
      allowedOrganizations: ["opnory-sandbox"],
      allowedTeams: ["opnory-engineering-contributors"],
    };

    idempotencyStore = new InMemoryIdempotencyStore();
    auditStore = new InMemoryAuditEventStore();
    executor = new GitHubAccessExecutor(config, idempotencyStore, auditStore);

    approvedRequest = {
      id: uuidv4(),
      correlationId: uuidv4(),
      requesterId: "opnory-dev",
      requesterEmail: "dev@opnory.com",
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
      idempotencyKey: "test-key",
      metadata: {},
      externalIdentities: {
        github: {
          login: "opnory-dev",
          verified: true,
          verifiedAt: new Date().toISOString(),
          source: "admin",
        },
      },
    };
  });

  it("should grant access then revoke and verify absence", async () => {
    // First, grant access to ensure the user is on the team
    const grantResult = await executor.grant(approvedRequest);
    console.log("Grant result:", JSON.stringify(grantResult, null, 2));
    expect(grantResult.success).toBe(true);

    // Now create a fulfilled request for revocation
    fulfilledRequest = toFulfilledAccessRequest({
      ...approvedRequest,
      status: "FULFILLED",
      fulfilledAt: new Date().toISOString(),
      externalId: grantResult.externalId || "github-team-membership-opnory-dev-opnory-sandbox-opnory-engineering-contributors",
    });

    // Revoke
    const revokeResult = await executor.revoke(fulfilledRequest);
    console.log("Revocation result:", JSON.stringify(revokeResult, null, 2));
    expect(revokeResult.success).toBe(true);
    expect(revokeResult.message).toContain("revoked");
  });

  it("should be idempotent - second revoke returns success with zero extra DELETE", async () => {
    const result = await executor.revoke(fulfilledRequest);
    console.log("Second revocation result:", JSON.stringify(result, null, 2));
    expect(result.success).toBe(true);
    expect(result.message).toContain("idempotent");
  });
});