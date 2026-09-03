// packages/observability/src/otel.test.ts
// Regression coverage for authenticated OTLP header forwarding.
// Proves: standard OTel header-list parsing, trace-specific precedence,
// header forwarding on emit, and non-leakage of header values in errors.

import { describe, it, expect, beforeEach, afterEach, vi } from "bun:test";
import { parseOtelHeaders, resolveOtelHeaders, emitSpan } from "./otel.js";

describe("parseOtelHeaders", () => {
  it("parses comma-separated key=value pairs", () => {
    const h = parseOtelHeaders("Authorization=Basic%20abc,X-Tenant=t1");
    expect(h["Authorization"]).toBe("Basic abc");
    expect(h["X-Tenant"]).toBe("t1");
  });

  it("skips malformed pairs without throwing", () => {
    const h = parseOtelHeaders("=nokey,noval,  ,good=value");
    expect(h["good"]).toBe("value");
    expect(Object.keys(h).length).toBe(1);
  });

  it("returns empty map for empty/undefined input", () => {
    expect(parseOtelHeaders("")).toEqual({});
    expect(parseOtelHeaders(undefined)).toEqual({});
  });

  it("leaves non-percent-encoded values intact", () => {
    const h = parseOtelHeaders("a=b+c,d=%ZZ"); // %ZZ is invalid encoding
    expect(h["a"]).toBe("b+c");
    expect(h["d"]).toBe("%ZZ");
  });
});

describe("resolveOtelHeaders", () => {
  it("merges generic and trace-specific, trace wins", () => {
    // SAFETY: the partial object carries only the two OTel header vars the
    // resolver reads; `ProcessEnv` is a string map, so a literal subset is a
    // faithful, deliberately-underspecified stand-in for the real environment.
    const env = {
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic%20generic,X-A=1",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "Authorization=Basic%20traces,X-B=2",
    } as NodeJS.ProcessEnv;
    const h = resolveOtelHeaders(env);
    expect(h["Authorization"]).toBe("Basic traces"); // trace-specific precedence
    expect(h["X-A"]).toBe("1"); // generic preserved
    expect(h["X-B"]).toBe("2"); // trace-specific added
  });

  it("returns only generic when trace-specific unset", () => {
    // SAFETY: same as above — a one-field ProcessEnv subset for a focused test.
    const env = { OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic%20g" } as NodeJS.ProcessEnv;
    expect(resolveOtelHeaders(env)["Authorization"]).toBe("Basic g");
  });
});

describe("emitSpan authentication forwarding", () => {
  const savedEnv: Record<string, string | undefined> = {};
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  function setEnv(k: string, v: string) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    process.env[k] = v;
  }

  beforeEach(() => {
    setEnv("OPNORY_OTEL_TRACES_ENABLED", "1");
    setEnv("OTEL_EXPORTER_OTLP_HEADERS", "Authorization=Basic%20SECRETTOKEN,X-Env=prod");
    setEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:1");
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    for (const k of Object.keys(savedEnv)) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k]!;
    }
    for (const k of Object.keys(savedEnv)) delete savedEnv[k];
  });

  it("forwards parsed auth headers on emit", async () => {
    fetchSpy.mockResolvedValue(new Response("ok", { status: 200 }));
    await emitSpan({
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      name: "test.span",
      startUnixNano: 1n,
      endUnixNano: 2n,
      attributes: { "opnory.operation": "test" },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/v1/traces");
    // SAFETY: `emitSpan` constructs headers as a plain `Record<string,string>`
    // merged into the fetch init; the DOM `HeadersInit` union is narrowed here to
    // read individual values the emitter wrote.
    const headers = init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Basic SECRETTOKEN");
    expect(headers["X-Env"]).toBe("prod");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("never leaks header values into an error message", async () => {
    fetchSpy.mockResolvedValue(new Response("denied", { status: 401 }));
    let errMessage = "";
    try {
      await emitSpan({
        traceId: "c".repeat(32),
        spanId: "d".repeat(16),
        name: "test.span2",
        startUnixNano: 1n,
        endUnixNano: 2n,
        attributes: {},
      });
    } catch (e) {
      errMessage = e instanceof Error ? e.message : String(e);
    }
    expect(errMessage).toContain("401");
    expect(errMessage).not.toContain("SECRETTOKEN");
    expect(errMessage).not.toContain("Basic");
  });
});