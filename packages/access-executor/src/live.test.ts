import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  GitHubAccessExecutor,
  InMemoryIdempotencyStore,
  GitHubExecutorConfig,
} from "./index.js";
import { InMemoryAuditEventStore } from "@opnory/access-audit";
import { ApprovedAccessRequest, ExternalIdentity } from "@opnory/access-types";

const APP_ID = process.env.OPNORY_GITHUB_APP_ID;
const INSTALLATION_ID = process.env.OPNORY_GITHUB_INSTALLATION_ID;
const PRIVATE_KEY = process.env.OPNORY_GITHUB_PRIVATE_KEY;
const TEST_USER_A = process.env.OPNORY_GITHUB_TEST_USER_A;
const TEST_USER_B = process.env.OPNORY_GITHUB_TEST_USER_B;

const config: GitHubExecutorConfig = {
  appId: APP_ID!,
  installationId: INSTALLATION_ID!,
  privateKey: PRIVATE_KEY!,
  allowedOrganizations: ["opnory-sandbox"],
  allowedTeams: ["opnory-engineering-contributors"],
};

let executor: GitHubAccessExecutor;
let idempotencyStore: InMemoryIdempotencyStore;
let auditStore: InMemoryAuditEventStore;

const baseRequest = (
  overrides: Partial<ApprovedAccessRequest> = {},
): ApprovedAccessRequest => {
  const requestId = overrides.id || crypto.randomUUID();
  const entitlementId =
    overrides.entitlement?.id || "123e4567-e89b-12d3-a456-426614174002";
  const requesterId = overrides.requesterId || "user-789";

  return {
    id: requestId,
    correlationId: overrides.correlationId || crypto.randomUUID(),
    requesterId,
    requesterEmail: "user@example.com",
    entitlement: {
      id: entitlementId,
      name: "GitHub Engineering Contributor",
      system: "github",
      githubConfig: {
        organization: "opnory-sandbox",
        teamSlug: "opnory-engineering-contributors",
        teamRole: "member", // canonical entitlement role
      },
    },
    reason: "Need access to engineering repos",
    status: "APPROVED",
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    approvedAt: new Date().toISOString(),
    approvedBy: "manager@example.com",
    idempotencyKey: `${requestId}:${entitlementId}:${requesterId}`,
    metadata: {},
    externalIdentities: {
      github: {
        login: overrides.externalIdentities?.github?.login || TEST_USER_A!,
        verified: true,
        verifiedAt: new Date().toISOString(),
        source: "admin",
      },
    },
    ...overrides,
  };
};

describe.skipIf(!APP_ID || !INSTALLATION_ID || !PRIVATE_KEY || !TEST_USER_A)(
  "GitHubAccessExecutor - Live Sandbox Tests",
  () => {
    beforeAll(() => {
      idempotencyStore = new InMemoryIdempotencyStore();
      auditStore = new InMemoryAuditEventStore();
      executor = new GitHubAccessExecutor(config, idempotencyStore, auditStore);
    });

    it("Scenario 1: Existing org member (non-owner) not on team -> FULFILLED after PUT + reconciliation", async () => {
      // TEST_USER_A is an org member (not owner), so GitHub assigns member role
      // The canonical entitlement requests 'member' role
      // This should return success=true with verified message

      const request = baseRequest({
        externalIdentities: {
          github: {
            login: TEST_USER_A!,
            verified: true,
            verifiedAt: new Date().toISOString(),
            source: "admin",
          },
        },
      });

      const result = await executor.grant(request);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.message).toContain("Successfully granted");
    });

    it("Scenario 2: Same user again -> idempotent FULFILLED with zero PUT", async () => {
      const request = baseRequest({
        externalIdentities: {
          github: {
            login: TEST_USER_A!,
            verified: true,
            verifiedAt: new Date().toISOString(),
            source: "admin",
          },
        },
      });

      const result = await executor.grant(request);

      expect(result.success).toBe(true);
      expect(result.message).toContain("Already member");
    });

    describe.skipIf(!TEST_USER_B)(
      "Scenario 3: Outside-org user -> AWAITING_EXTERNAL_ACCEPTANCE (no false success)",
      () => {
        it("returns AWAITING_EXTERNAL_ACCEPTANCE for outside-org user", async () => {
          const request = baseRequest({
            externalIdentities: {
              github: {
                login: TEST_USER_B!,
                verified: true,
                verifiedAt: new Date().toISOString(),
                source: "admin",
              },
            },
          });

          const result = await executor.grant(request);

          // Should be pending external acceptance
          expect(result.success).toBe(false);
          expect(result.status).toBe("AWAITING_EXTERNAL_ACCEPTANCE");
          expect(result.message).toContain("pending");
        });
      },
    );
  },
);

describe.skipIf(!process.env.OPNORY_LIVE_GITHUB_TESTS)(
  "GitHubAccessExecutor - Live Test Configuration",
  () => {
    it("should have required environment variables", () => {
      expect(APP_ID).toBeDefined();
      expect(INSTALLATION_ID).toBeDefined();
      expect(PRIVATE_KEY).toBeDefined();
      expect(TEST_USER_A).toBeDefined();
    });

    it("should have valid App ID", () => {
      expect(APP_ID).toBe("4647201");
    });

    it("should have valid Installation ID", () => {
      expect(INSTALLATION_ID).toBe("154891672");
    });

    it("should have TEST_USER_A defined", () => {
      expect(TEST_USER_A).toBeTruthy();
    });
  },
);
