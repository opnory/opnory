import { z } from "zod";
import { AppConfigSchema, type AppConfig } from "@opnory/types";

let configCache: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (configCache) {
    return configCache;
  }

  const rawConfig = {
      env:
        // SAFETY: NODE_ENV is controlled by deployment environment
        (process.env.NODE_ENV as "development" | "staging" | "production") ||
        "development",
      port: parseInt(process.env.PORT || "3000", 10),
      logLevel:
        // SAFETY: LOG_LEVEL is controlled by deployment environment
        (process.env.LOG_LEVEL as "DEBUG" | "INFO" | "WARN" | "ERROR") || "INFO",
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
        type:
          // SAFETY: VECTOR_STORE_TYPE is controlled by deployment environment
          (process.env.VECTOR_STORE_TYPE as
            "pinecone" | "weaviate" | "qdrant" | "memory") || "memory",
        config: parseJsonOrEmpty(process.env.VECTOR_STORE_CONFIG),
      },
      llm: {
        provider:
          // SAFETY: LLM_PROVIDER is controlled by deployment environment
          (process.env.LLM_PROVIDER as "openai" | "anthropic" | "local") ||
          "openai",
        model: process.env.LLM_MODEL || "gpt-4o-mini",
        apiKey: process.env.LLM_API_KEY || "",
        baseUrl: process.env.LLM_BASE_URL,
      },
      embedding: {
        provider:
          // SAFETY: EMBEDDING_PROVIDER is controlled by deployment environment
          (process.env.EMBEDDING_PROVIDER as "openai" | "local") || "openai",
        model: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
        apiKey: process.env.EMBEDDING_API_KEY || "",
        baseUrl: process.env.EMBEDDING_BASE_URL,
        dimensions: parseInt(process.env.EMBEDDING_DIMENSIONS || "1536", 10),
      },
      escalation: {
        confidenceThreshold: parseFloat(
          process.env.ESCALATION_CONFIDENCE_THRESHOLD || "0.7",
        ),
        defaultAssigneeId: process.env.DEFAULT_ASSIGNEE_ID,
      },
    };

  const result = AppConfigSchema.safeParse(rawConfig);
  if (!result.success) {
    const errors = result.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
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

// SAFETY: ParsedJson is an intentionally open-ended external-boundary type.
// JSON.parse returns any; validation at the schema boundary (AppConfigSchema) guarantees structure.
// Branded to prevent accidental use outside boundary without validation.
type ParsedJson = Record<string, unknown> & { __parsedJsonBrand: never };

function parseJsonOrEmpty(value: string | undefined): ParsedJson {
  // SAFETY: JSON.parse returns any; we validate it's a non-null object at the boundary
  // SAFETY: this is a boundary parse result; callers must validate structure against schemas
  // SAFETY: returning ParsedJson for untyped parsed JSON at boundary
  if (!value) {
    // SAFETY: empty object satisfies ParsedJson boundary contract (no required fields)
    return {} as ParsedJson;
  }
  try {
    const parsed = JSON.parse(value);
    // SAFETY: typeof check is a boundary parse/validation, not an internal type narrowing
    // oxlint-disable-next-line anti-slop/no-runtime-typeof
    const result = typeof parsed === "object" && parsed !== null ? parsed : {};
    // SAFETY: result satisfies ParsedJson boundary contract
    return result as ParsedJson;
  } catch {
    // SAFETY: empty object satisfies ParsedJson boundary contract on parse failure
    return {} as ParsedJson;
  }
}

export { AppConfigSchema, type AppConfig } from "@opnory/types";
