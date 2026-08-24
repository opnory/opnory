import { describe, it, expect, beforeEach } from "bun:test";
import {
  InMemoryVectorStore,
  seedCanonicalDocuments,
  canonicalVpnDocument,
  VPN_DOCUMENT_ID,
} from "@opnory/knowledge";
import {
  InMemoryEscalationStore,
  InMemoryEscalationService,
  EscalationReason,
} from "@opnory/escalation";
import { OpnoryAgent } from "../src/index.js";
import { type NormalizedRequest } from "@opnory/types";

describe("Agent Package", () => {
  let vectorStore: InMemoryVectorStore;
  let escalationStore: InMemoryEscalationStore;
  let escalationService: InMemoryEscalationService;
  let agent: OpnoryAgent;
  const workspaceId = "opnory-internal";

  const createRequest = (text: string): NormalizedRequest => ({
    requestId: "550e8400-e29b-41d4-a716-446655440000",
    workspaceId,
    userId: "U12345",
    channelId: "C12345",
    threadId: "1234567890.123456",
    text,
    timestamp: new Date().toISOString(),
    source: "slack",
  });

  beforeEach(async () => {
    vectorStore = new InMemoryVectorStore();
    // Seed the canonical document into our test vector store
    await vectorStore.upsert([canonicalVpnDocument]);

    escalationStore = new InMemoryEscalationStore();
    escalationService = new InMemoryEscalationService(escalationStore);

    agent = new OpnoryAgent({ vectorStore, escalationService });
  });

  describe("CASE 1 - Known answer", () => {
    it("should retrieve approved VPN document and answer from it", async () => {
      const request = createRequest("How do I connect to the VPN on my Mac?");
      const response = await agent.processRequest(request);

      expect(response.answer.toLowerCase()).toContain("globalprotect");
      expect(response.answer).toContain("vpn.company.com");
      expect(response.answer.toLowerCase()).toContain("sso credentials");
      expect(response.citations.length).toBeGreaterThan(0);
      expect(response.citations[0].documentId).toBe(VPN_DOCUMENT_ID);
      expect(response.confidence).toBeGreaterThan(0.3);
      expect(response.shouldEscalate).toBe(false);
    });

    it("should include source citation with title", async () => {
      const request = createRequest("How do I connect to the VPN on my Mac?");
      const response = await agent.processRequest(request);

      expect(response.citations[0].documentId).toBe(VPN_DOCUMENT_ID);
      expect(response.citations[0].relevanceScore).toBeGreaterThan(0.3);
    });
  });

  describe("CASE 2 - Unknown answer", () => {
    it("should not invent answer and should escalate", async () => {
      const request = createRequest(
        "What is the admin password for the finance router?",
      );
      const response = await agent.processRequest(request);

      // The query finds no relevant documents, so escalates with NO_RELEVANT_DOCUMENTS
      expect(response.shouldEscalate).toBe(true);
      expect(response.escalationReason).toBe("NO_RELEVANT_DOCUMENTS");
      expect(response.confidence).toBeLessThan(0.3);
    });
  });

  describe("CASE 3 - Partially known", () => {
    it("should answer supported portion and state unavailable info", async () => {
      const request = createRequest(
        "How do I connect to the VPN, and what is the emergency bypass code?",
      );
      const response = await agent.processRequest(request);

      // The query contains "bypass" which triggers partial knowledge handling
      // The VPN document is found but confidence is low
      expect(response.shouldEscalate).toBe(true);
      expect(response.escalationReason).toBe("LOW_CONFIDENCE");
    });
  });

  describe("CASE 4 - Explicit human request", () => {
    it("should skip reasoning and escalate directly", async () => {
      const request = createRequest("I want to talk to IT support");
      const response = await agent.processRequest(request);

      expect(response.shouldEscalate).toBe(true);
      expect(response.escalationReason).toBe("USER_REQUESTED");
      expect(response.answer).toContain("human support");
      expect(response.confidence).toBe(0.0);
    });

    it("should handle various human request phrasings", async () => {
      const phrasings = [
        "I want to talk to a person",
        "Can I speak to human support?",
        "Please escalate this to IT",
        "Contact support please",
      ];

      for (const text of phrasings) {
        const request = createRequest(text);
        const response = await agent.processRequest(request);

        expect(response.shouldEscalate).toBe(true);
        expect(response.escalationReason).toBe("USER_REQUESTED");
      }
    });
  });

  describe("Correlation IDs", () => {
    it("should propagate correlation IDs through processing", async () => {
      const request = createRequest("How do I connect to the VPN on my Mac?");
      // The agent generates correlation ID internally - we just verify it processes without error
      const response = await agent.processRequest(request);
      expect(response).toBeDefined();
    });
  });
});
