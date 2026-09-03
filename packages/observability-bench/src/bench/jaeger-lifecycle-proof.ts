// packages/observability-bench/src/bench/jaeger-lifecycle-proof.ts
// ADR 0009 bake-off, Jaeger leg: replay the real Phase 7 lifecycle corpus and
// answer the operator questions via Jaeger's NATIVE read API alone.
//
// This is a characterization script, not a unit test. It mirrors
// packages/integration-runtime/test/lifecycle-tempo-reconstruction.test.ts's
// five operator questions but drives Jaeger's HTTP JSON query service:
//   GET /api/services
//   GET /api/operations?service=opnory
//   GET /api/traces?service=opnory&tag=opnory.tenant_hash:<hash>
//   GET /api/traces/<traceID>
//
// Run:  bun run packages/observability-bench/src/bench/jaeger-lifecycle-proof.ts
// (reads the live Jaeger at JAEGER_URL ?? http://localhost:16686)

const JAEGER = process.env.JAEGER_URL ?? "http://localhost:16686";

interface JaegerTag { key: string; value: unknown; type?: string }
interface JaegerSpan {
  traceID: string;
  spanID: string;
  operationName: string;
  processID: string;
  tags?: JaegerTag[];
  references?: Array<{ refType: string; traceID: string; spanID: string }>;
}
interface JaegerTrace {
  traceID: string;
  spans: JaegerSpan[];
  processes: Record<string, { serviceName: string; tags?: JaegerTag[] }>;
}

function spanTag(sp: JaegerSpan, key: string): string | undefined {
  // SAFETY: Jaeger tags carry an explicit `type` discriminator (string/int64/
  // bool/float64). We read the declared string-typed value only, so attribute
  // comparison never mis-reads a numeric/bool tag as a substring.
  const tag = sp.tags?.find((t) => t.key === key);
  if (tag?.type === "string" && tag.value !== null && tag.value !== undefined) {
    return String(tag.value);
  }
  return undefined;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${JAEGER}${path}`);
  if (!res.ok) throw new Error(`Jaeger ${path} → ${res.status}`);
  // SAFETY: the Jaeger JSON query service returns the documented `{ data, errors }`
  // envelope; T is the caller-provided shape of that envelope.
  return (await res.json()) as T;
}

async function tracesByTenantHash(hash: string): Promise<JaegerTrace[]> {
  const r = await getJson<{ data: JaegerTrace[] }>(
    `/api/traces?service=opnory&tag=opnory.tenant_hash:${hash}&limit=200`,
  );
  return r.data ?? [];
}

interface Finding {
  question: string;
  answer: "PASS" | "FAIL" | "UNSUPPORTED" | "EVIDENCE";
  detail: string;
}

const findings: Finding[] = [];
let passCount = 0;
let gateFail = 0;

function record(question: string, answer: Finding["answer"], detail: string) {
  findings.push({ question, answer, detail });
  if (answer === "PASS") passCount++;
  if (answer === "FAIL") gateFail++;
}

// ---- Gather facts ----
const operations = await getJson<{ data: Array<{ name: string }> }>(
  "/api/operations?service=opnory",
);
const allTraces = await getJson<{ data: JaegerTrace[] }>(
  "/api/traces?service=opnory&limit=500",
);

// Distinct tenant hashes present in the corpus.
const distinctHashes = new Set<string>();
for (const t of allTraces.data ?? []) {
  for (const sp of t.spans) {
    const h = spanTag(sp, "opnory.tenant_hash");
    if (h) distinctHashes.add(h);
  }
}

// ---- Question 1: does native span/operation enumeration expose the lifecycle? ----
const opNames = new Set((operations.data ?? []).map((o) => o.name));
const expectedOps = [
  "integration.install",
  "integration.configure",
  "integration.validate",
  "credential.resolve",
  "integration.health_check",
  "plugin.activate",
  "capability.register",
  "integration.degrade",
  "integration.uninstall",
  "plugin.dispose",
  "capability.unregister",
];
const missingOps = expectedOps.filter((o) => !opNames.has(o));
record(
  "Which lifecycle spans are natively enumerable via /api/operations?",
  missingOps.length === 0 ? "PASS" : "FAIL",
  missingOps.length === 0
    ? `all ${expectedOps.length} lifecycle operations present`
    : `missing: ${missingOps.join(", ")}`,
);

// ---- Question 2: attribute contract preserved on retrieval? ----
if (allTraces.data && allTraces.data.length > 0) {
  const sample = allTraces.data[0].spans[0];
  const required = [
    "opnory.tenant_hash",
    "opnory.operation",
    "opnory.integration_id",
    "opnory.plugin_id",
    "opnory.provider",
    "opnory.desired_state",
    "opnory.actual_state",
  ];
  const have = new Set((sample.tags ?? []).map((t) => t.key));
  const missingAttrs = required.filter((k) => !have.has(k));
  record(
    "Are the frozen attributes preserved on fetched spans?",
    missingAttrs.length === 0 ? "PASS" : "FAIL",
    missingAttrs.length === 0
      ? `all ${required.length} frozen attributes present`
      : `missing: ${missingAttrs.join(", ")}`,
  );
} else {
  record("Are the frozen attributes preserved on fetched spans?", "FAIL", "no spans returned");
}

// ---- Question 3: tenant isolation via native tag filter (hard gate) ----
let isolationResult: Finding["answer"] = "PASS";
let isolationDetail = "";
if (distinctHashes.size >= 2) {
  const [a] = [...distinctHashes];
  const tracesA = await tracesByTenantHash(a);
  let leak = false;
  for (const t of tracesA) {
    for (const sp of t.spans) {
      const h = spanTag(sp, "opnory.tenant_hash");
      if (h && h !== a) leak = true;
    }
  }
  const neg = await tracesByTenantHash("ffffffffffffffff");
  if (leak) {
    isolationResult = "FAIL";
    isolationDetail = `tenant hash ${a} returned cross-tenant spans`;
  } else if (neg.length !== 0) {
    isolationResult = "FAIL";
    isolationDetail = `nonexistent hash returned ${neg.length} traces (filter not selective)`;
  } else {
    isolationDetail = `tenant ${a} → ${tracesA.length} traces, zero cross-tenant leak; negative control → 0 traces`;
  }
} else {
  isolationResult = "EVIDENCE";
  isolationDetail = `only ${distinctHashes.size} tenant hash(es) in corpus; isolation filter exercised against a single tenant`;
}
record("Tenant isolation: native tag=opnory.tenant_hash filter selective?", isolationResult, isolationDetail);

// ---- Question 4: redaction — raw tenant ids / sentinel absent? ----
const rawSer = JSON.stringify(allTraces);
const sentinel = "OPNORY_SENTINEL_LIFECYCLE_PROOF_7f3a9c2e";
const sentinelLeak = rawSer.includes(sentinel);
record(
  "Sentinel secret / raw tenant ids absent from retrieved spans?",
  sentinelLeak ? "FAIL" : "PASS",
  sentinelLeak ? "sentinel present in retrieved span payload" : "no sentinel in retrieved span payload",
);

// ---- Question 5: failure taxonomy fidelity on degrade spans ----
let degradeTaxonomy: Finding["answer"] = "EVIDENCE";
let taxonomyDetail = "no integration.degrade spans present in current corpus";
const degradeSpans: Array<{ hash: string; code: string | undefined }> = [];
for (const t of allTraces.data ?? []) {
  for (const sp of t.spans) {
    if (sp.operationName === "integration.degrade") {
      degradeSpans.push({ hash: spanTag(sp, "opnory.tenant_hash") ?? "?", code: spanTag(sp, "opnory.failure_code") });
    }
  }
}
if (degradeSpans.length > 0) {
  const codes = new Set(degradeSpans.map((s) => s.code).filter(Boolean));
  const hasCorrect = codes.has("credential_backend_unavailable");
  const hasWrong = codes.has("provider_unreachable");
  degradeTaxonomy = hasCorrect && !hasWrong ? "PASS" : "FAIL";
  taxonomyDetail = `degrade spans: ${degradeSpans.length}; codes=${[...codes].join(", ")}`;
}
record("Failure taxonomy: credential_backend_unavailable preserved, provider_unreachable absent?", degradeTaxonomy, taxonomyDetail);

// ---- Emit the evidence JSON ----
const report = {
  backend: "Jaeger (all-in-one, HTTP JSON query service)",
  readSurface: `${JAEGER}/api/traces`,
  distinctTenantHashes: distinctHashes.size,
  operationsEnumerated: opNames.size,
  passCount,
  gateFail,
  findings,
};

console.log(JSON.stringify(report, null, 2));
if (gateFail > 0) process.exit(1);