import { describe, it, expect, beforeEach } from "bun:test";
import {
  InMemoryEscalationService,
  InMemoryEscalationStore,
  EscalationReason,
} from "../src/index.js";

describe("Escalation Package", () => {
  let store: InMemoryEscalationStore;
  let service: InMemoryEscalationService;

  beforeEach(() => {
    store = new InMemoryEscalationStore();
    service = new InMemoryEscalationService(store);
  });

  it("should create an escalation", async () => {
    const escalation = await service.createEscalation({
      requestId: "550e8400-e29b-41d4-a716-446655440000",
      workspaceId: "test-workspace",
      reason: "LOW_CONFIDENCE" as EscalationReason,
      context: {
        userQuestion: "How do I connect to VPN?",
        confidence: 0.3,
      },
    });

    expect(escalation.id).toBeDefined();
    expect(escalation.requestId).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(escalation.workspaceId).toBe("test-workspace");
    expect(escalation.reason).toBe("LOW_CONFIDENCE");
    expect(escalation.status).toBe("PENDING");
    expect(escalation.createdAt).toBeDefined();
  });

  it("should get escalation by ID", async () => {
    const created = await service.createEscalation({
      requestId: "550e8400-e29b-41d4-a716-446655440000",
      workspaceId: "test-workspace",
      reason: "LOW_CONFIDENCE" as EscalationReason,
      context: {
        userQuestion: "How do I connect to VPN?",
        confidence: 0.3,
      },
    });

    const retrieved = await service.getEscalation(created.id);
    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe(created.id);
  });

  it("should list escalations with test isolation", async () => {
    await service.createEscalation({
      requestId: "550e8400-e29b-41d4-a716-446655440000",
      workspaceId: "test-workspace",
      reason: "LOW_CONFIDENCE" as EscalationReason,
      context: { userQuestion: "Q1", confidence: 0.3 },
    });
    await service.createEscalation({
      requestId: "550e8400-e29b-41d4-a716-446655440001",
      workspaceId: "test-workspace",
      reason: "USER_REQUESTED" as EscalationReason,
      context: { userQuestion: "Q2", confidence: 0.5 },
    });

    const results = await service.listEscalations("test-workspace");
    expect(results.length).toBe(2);
  });
});
