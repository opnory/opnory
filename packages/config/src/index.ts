import { z } from "zod";
import { AppConfigSchema, type AppConfig } from "@opnory/types";

let configCache: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (configCache) {
    return configCache;
  }

  const rawConfig = {
    env: (process.env.NODE_ENV as "development" | "staging" | "production") || "development",
    port: parseInt(process.env.PORT || "3000", 10),
    logLevel: (process.env.LOG_LEVEL as "DEBUG" | "INFO" | "WARN" | "ERROR") || "INFO",
    slack: {
      signingSecret: process.env.SLACK_SIGNING_SECRET || "",
      botToken: process.env.SLACK_BOT_TOKEN || "",
      appToken: process.env.SLACK_APP_TOKEN,
    },
    database: {
      url: process.env.DATABASE_URL || "",
    },
    redis: process.env.REDIS_URL ? { url: process.env.REDIS_URL } : undefined,
    vectorStore: {
      type: (process.env.VECTOR_STORE_TYPE as "pinecone" | "weaviate" | "qdrant" | "memory") || "memory",
      config: parseJsonOrEmpty(process.env.VECTOR_STORE_CONFIG),
    },
    llm: {
      provider: (process.env.LLM_PROVIDER as "openai" | "anthropic" | "local") || "openai",
      model: process.env.LLM_MODEL || "gpt-4o-mini",
      apiKey: process.env.LLM_API_KEY,
      baseUrl: process.env.LLM_BASE_URL,
    },
    embedding: {
      provider: (process.env.EMBEDDING_PROVIDER as "openai" | "local") || "openai",
      model: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
      apiKey: process.env.EMBEDDING_API_KEY,
      baseUrl: process.env.EMBEDDING_BASE_URL,
      dimensions: parseInt(process.env.EMBEDDING_DIMENSIONS || "1536", 10),
    },
    escalation: {
      confidenceThreshold: parseFloat(process.env.ESCALATION_CONFIDENCE_THRESHOLD || "0.7"),
      defaultAssigneeId: process.env.DEFAULT_ASSIGNEE_ID,
    },
  };

  const result = AppConfigSchema.safeParse(rawConfig);
  if (!result.success) {
    const errors = result.error.errors.map(e => `${e.path.join(".")}: ${e.message}`).join("; ");
    throw new Error(`Invalid configuration: ${errors}`);
  }

  configCache = result.data;
  return configCache;
}

export function getConfig(): AppConfig {
  if (!configCache) {
    return loadConfig();
  }
  return configCache;
}

export function resetConfig(): void {
  configCache = null;
}

function parseJsonOrEmpty(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export { AppConfigSchema, type AppConfig } from "@opnory/types";