// packages/observability-bench/src/dataset/send.ts
// Replay the corpus to a provider. The SAME serialized bytes go to every
// backend — no per-vendor SDK differences leak into the query comparison.

import { createHash } from "node:crypto";
import type { CandidateProvider } from "../provider.js";
import type { TraceCorpus } from "../trace-model.js";
import { serializeCorpus } from "./generate.js";

export interface SendResult {
  providerName: string;
  /** byte length of the canonical serialized payload that was sent */
  serializedBytes: number;
  /** sha256 of the canonical payload */
  sha256: string;
  /** wall time (ms) to write the whole corpus */
  writeTimeMs: number;
}

export async function sendCorpus(
  provider: CandidateProvider,
  corpus: TraceCorpus,
): Promise<SendResult> {
  const serialized = serializeCorpus(corpus);
  const sha256 = createHash("sha256").update(serialized, "utf8").digest("hex");

  const start = performance.now();
  await provider.writer.writeCorpus(corpus);
  const writeTimeMs = performance.now() - start;

  return {
    providerName: provider.providerName,
    serializedBytes: Buffer.byteLength(serialized, "utf8"),
    sha256,
    writeTimeMs,
  };
}

/**
 * Send the corpus to every registered provider. Returns a map of results,
 * keyed by provider name, so verify-parity.ts can gate on them.
 */
export async function sendToAll(
  providers: CandidateProvider[],
  corpus: TraceCorpus,
): Promise<Map<string, SendResult>> {
  const results = new Map<string, SendResult>();
  for (const provider of providers) {
    const result = await sendCorpus(provider, corpus);
    results.set(provider.providerName, result);
  }
  return results;
}