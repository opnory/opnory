import { describe, it, expect } from "bun:test";
import { loadConfig } from "../src/index.js";
describe("Config Package", () => {
    it("should load config from environment", () => {
        process.env.NODE_ENV = "development";
        process.env.PORT = "3000";
        process.env.LOG_LEVEL = "INFO";
        process.env.SLACK_SIGNING_SECRET = "test-secret";
        process.env.SLACK_BOT_TOKEN = "xoxb-test";
        process.env.DATABASE_URL = "postgresql://localhost:5432/opnory";
        process.env.VECTOR_STORE_TYPE = "memory";
        process.env.LLM_PROVIDER = "openai";
        process.env.LLM_MODEL = "gpt-4";
        process.env.LLM_API_KEY = "test-key";
        process.env.EMBEDDING_PROVIDER = "openai";
        process.env.EMBEDDING_MODEL = "text-embedding-3-small";
        process.env.EMBEDDING_API_KEY = "test-key";
        process.env.EMBEDDING_DIMENSIONS = "1536";
        process.env.ESCALATION_CONFIDENCE_THRESHOLD = "0.7";
        const cfg = loadConfig();
        expect(cfg.env).toBe("development");
        expect(cfg.port).toBe(3000);
        expect(cfg.logLevel).toBe("INFO");
        expect(cfg.slack.signingSecret).toBe("test-secret");
        expect(cfg.slack.botToken).toBe("xoxb-test");
        expect(cfg.database.url).toBe("postgresql://localhost:5432/opnory");
        expect(cfg.vectorStore.type).toBe("memory");
        expect(cfg.llm.provider).toBe("openai");
        expect(cfg.llm.model).toBe("gpt-4");
        expect(cfg.llm.apiKey).toBe("test-key");
        expect(cfg.embedding.provider).toBe("openai");
        expect(cfg.embedding.model).toBe("text-embedding-3-small");
        expect(cfg.embedding.dimensions).toBe(1536);
        expect(cfg.escalation.confidenceThreshold).toBe(0.7);
    });
});
//# sourceMappingURL=index.test.js.map