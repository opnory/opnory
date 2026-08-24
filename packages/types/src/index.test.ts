import { describe, it, expect } from "bun:test";
import { AppConfigSchema, type AppConfig } from "../src/index.js";

describe("Types Package", () => {
  it("should validate a valid AppConfig", () => {
    const config = {
      env: "development",
      port: 3000,
      logLevel: "INFO",
      slack: {
        signingSecret: "test-secret",
        botToken: "xoxb-test",
      },
      database: {
        url: "postgresql://localhost:5432/opnory",
      },
      vectorStore: {
        type: "memory",
        config: {},
      },
      llm: {
        provider: "openai",
        model: "gpt-4",
        apiKey: "test-key",
      },
      embedding: {
        provider: "openai",
        model: "text-embedding-3-small",
        apiKey: "test-key",
        dimensions: 1536,
      },
      escalation: {
        confidenceThreshold: 0.7,
      },
    };

    const result = AppConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("should reject invalid env", () => {
    const config = {
      env: "invalid",
      port: 3000,
      logLevel: "INFO",
      slack: {
        signingSecret: "test-secret",
        botToken: "xoxb-test",
      },
      database: {
        url: "postgresql://localhost:5432/opnory",
      },
      vectorStore: {
        type: "memory",
        config: {},
      },
      llm: {
        provider: "openai",
        model: "gpt-4",
        apiKey: "test-key",
      },
      embedding: {
        provider: "openai",
        model: "text-embedding-3-small",
        apiKey: "test-key",
        dimensions: 1536,
      },
      escalation: {
        confidenceThreshold: 0.7,
      },
    };

    const result = AppConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it("should validate NormalizedRequest", () => {
    const { NormalizedRequestSchema } = require("@opnory/types");
    const request = {
      requestId: "550e8400-e29b-41d4-a716-446655440000",
      workspaceId: "test-workspace",
      userId: "U12345",
      channelId: "C12345",
      threadId: "1234567890.123456",
      text: "How do I connect to VPN?",
      timestamp: new Date().toISOString(),
      source: "slack",
    };

    const result = NormalizedRequestSchema.safeParse(request);
    expect(result.success).toBe(true);
  });
});
