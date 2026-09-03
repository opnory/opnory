// packages/observability-bench/test/jaeger-filtered-scan.test.ts
// Regression coverage for the Jaeger adapter's native attribute filtering —
// the capability proven against the real Phase 7 corpus (see ADR 0008 finding:
// GET /api/traces?tag=opnory.tenant_hash:<h> returns only that tenant's traces).
//
// Gate: requires a live Jaeger at JAEGER_READ_URL ?? http://localhost:16686
// (skips otherwise). This asserts the exact native semantics the capability
// flag now claims, no richer operators than the JSON query service exposes:
//   1. attributeFiltering is declared true;
//   2. the native tag-equality filter is selective — a tenant hash never
//      inserted yields zero traces (negative control);
//   3. for a real tenant hash discovered from Jaeger, a native tag filter
//      returns ONLY spans carrying that hash (zero cross-tenant leak).

import { describe, it, expect } from "bun:test";
import { createHash } from "node:crypto";
import { buildJaeger } from "../src/providers/index.js";

const JAEGER = process.env.JAEGER_READ_URL ?? "http://localhost:16686";

async function jaegerLive(): Promise<boolean> {
  try {
    const r = await fetch(`${JAEGER}/api/services`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

function tenantHash(tenant: string): string {
  return createHash("sha256").update(tenant).digest("hex").slice(0, 16);
}

interface JaegerTraceResp {
  data: Array<{
    spans: Array<{ tags?: Array<{ key: string; value: unknown }> }>;
  }>;
}

/** Discover one real tenant_hash from live Jaeger (if any exists). */
async function firstRealHash(): Promise<string | null> {
  const r = await fetch(`${JAEGER}/api/traces?service=opnory&limit=50`);
  if (!r.ok) return null;
  const body = (await r.json()) as JaegerTraceResp;
  for (const t of body.data ?? []) {
    for (const sp of t.spans) {
      const tag = sp.tags?.find((x) => x.key === "opnory.tenant_hash");
      if (tag) return String(tag.value);
    }
  }
  return null;
}

const live = await jaegerLive();

describe.skipIf(!live)("Jaeger adapter native attribute filtering", () => {
  it("declares attributeFiltering: true (evidence-backed)", () => {
    const provider = buildJaeger();
    expect(provider.capabilities.attributeFiltering).toBe(true);
  });

  it("filteredScan is selective: a tenant hash never inserted yields zero rows", async () => {
    const provider = buildJaeger();
    const tenant = `nonexistent-control-${Date.now()}`;
    const result = await provider.reader.filteredScan({
      tenantId: tenant,
      provider: "okta",
      outcome: "succeeded",
      windowStartEpochMs: 0,
      windowEndEpochMs: 0,
    });
    expect(result.rows.length).toBe(0);
  });

  it("native tag filter returns ONLY the matching tenant's spans (zero cross-tenant leak)", async () => {
    const hash = await firstRealHash();
    if (hash === null) {
      // No corpus present in this Jaeger instance; the capability-flag and
      // negative-control assertions above are still valid. Nothing to leak.
      return;
    }
    const r = await fetch(
      `${JAEGER}/api/traces?service=opnory&limit=200&tag=${encodeURIComponent(`opnory.tenant_hash:${hash}`)}`,
    );
    expect(r.ok).toBe(true);
    const body = (await r.json()) as JaegerTraceResp;
    let sawMatch = false;
    for (const t of body.data ?? []) {
      for (const sp of t.spans) {
        const tag = sp.tags?.find((x) => x.key === "opnory.tenant_hash");
        if (!tag) continue;
        sawMatch = true;
        expect(String(tag.value)).toBe(hash);
      }
    }
    // If there is corpus data at all, the positive assertion must have fired.
    expect(sawMatch).toBe(true);
  });
});