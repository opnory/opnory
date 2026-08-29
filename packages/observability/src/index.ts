import pino, { Logger, LoggerOptions } from "pino";
import { LogLevel, type TraceContext } from "@opnory/types";

let loggerInstance: Logger | null = null;

export function createLogger(options: LoggerOptions = {}): Logger {
  const config = {
    level: process.env.LOG_LEVEL || "info",
    formatters: {
      level: (label: string) => ({ level: label.toUpperCase() }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...options,
  };

  if (process.env.NODE_ENV === "development") {
    config.transport = {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss Z",
        ignore: "pid,hostname",
      },
    };
  }

  return pino(config);
}

export function getLogger(): Logger {
  if (!loggerInstance) {
    loggerInstance = createLogger();
  }
  return loggerInstance;
}

export function setLogger(logger: Logger): void {
  loggerInstance = logger;
}

export function createChildLogger(
  parent: Logger,
  // SAFETY: bindings is an intentionally open-ended structured logging payload;
  // callers must ensure serializable values at the log emission boundary
  bindings: Record<string, unknown>,
): Logger {
  return parent.child(bindings);
}

export function createTraceLogger(traceContext: TraceContext): Logger {
  return getLogger().child({
    traceId: traceContext.traceId,
    spanId: traceContext.spanId,
    parentSpanId: traceContext.parentSpanId,
  });
}

export function generateTraceId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function generateSpanId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function createTraceContext(parentSpanId?: string): TraceContext {
  return {
    traceId: generateTraceId(),
    spanId: generateSpanId(),
    parentSpanId,
  };
}

export type { LogLevel } from "@opnory/types";
