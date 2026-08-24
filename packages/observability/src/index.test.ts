import { describe, it, expect } from "bun:test";
import { createLogger, getLogger } from "../src/index.js";

describe("Observability Package", () => {
  it("should create a logger", () => {
    const logger = createLogger({ level: "debug" });
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.error).toBe("function");
  });

  it("should return singleton logger", () => {
    const logger1 = getLogger();
    const logger2 = getLogger();
    expect(logger1).toBe(logger2);
  });
});
