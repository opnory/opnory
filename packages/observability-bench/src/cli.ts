// packages/observability-bench/src/cli.ts
// Entrypoint: `generate` (deterministic corpus + manifest) and `bench`
// (run probes against every registered provider, emit JSON evidence then
// Markdown derived from it).
//
// Deliberately dependency-free: no Opnory runtime imports. Only node:crypto
// and node:fs, plus the intra-package modules.

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { generateCorpusWithManifest, serializeCorpus } from "./dataset/generate.js";
import { runBenchmark, renderMarkdown } from "./report.js";
import { listProviders, getProvider } from "./provider.js";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

function requireNum(args: Record<string, string>, key: string, def: number): number {
  const v = args[key];
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    console.error(`--${key} must be a number, got "${v}"`);
    process.exit(2);
  }
  return n;
}

async function cmdGenerate(args: Record<string, string>): Promise<void> {
  const seed = requireNum(args, "seed", 12345);
  const anchorEpochMs = requireNum(args, "anchor", 1725000000000);
  const traceCount = requireNum(args, "traces", 100);
  const tenantsArg = args["tenants"] || "tenant-a,tenant-b";

  const tenantIds = tenantsArg.split(",").map((s) => s.trim()).filter(Boolean);

  const { corpus, manifest } = generateCorpusWithManifest({ seed, anchorEpochMs, traceCount, tenantIds });

  const outDir = args["out"] || "fixtures/corpus";
  mkdirSync(outDir, { recursive: true });

  const payload = serializeCorpus(corpus);
  writeFileSync(join(outDir, "traces.otlp.json"), payload, "utf8");
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  console.log(`Generated ${manifest.traceCount} traces / ${manifest.spanCount} spans`);
  console.log(`seed=${manifest.seed} anchor=${manifest.anchorEpochMs} sha256=${manifest.sha256}`);
  console.log(`Wrote ${join(outDir, "traces.otlp.json")} and ${join(outDir, "manifest.json")}`);
}

async function cmdBench(args: Record<string, string>): Promise<void> {
  const names = listProviders();
  if (names.length === 0) {
    console.error("No providers registered. Register adapters before running `bench`.");
    process.exit(2);
  }

  const providers = names.map((n) => getProvider(n)).filter((p): p is NonNullable<typeof p> => p !== undefined);
  const seed = requireNum(args, "seed", 12345);
  const anchorEpochMs = requireNum(args, "anchor", 1725000000000);
  const traceCount = requireNum(args, "traces", 100);
  const tenantsArg = args["tenants"] || "tenant-a,tenant-b";
  const tenantIds = tenantsArg.split(",").map((s) => s.trim()).filter(Boolean);

  const results = await runBenchmark(providers, {
    seed,
    anchorEpochMs,
    traceCount,
    tenantIds,
    warmup: requireNum(args, "warmup", 5),
    measured: requireNum(args, "measured", 30),
  });

  const outDir = args["out"] || "results";
  mkdirSync(outDir, { recursive: true });

  const json = JSON.stringify({ providers: results }, null, 2);
  writeFileSync(join(outDir, "evidence.json"), json, "utf8");
  const md = renderMarkdown(results);
  writeFileSync(join(outDir, "report.md"), md, "utf8");

  console.log(`Wrote ${join(outDir, "evidence.json")} and ${join(outDir, "report.md")}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const sub = argv.find((a) => !a.startsWith("-")) ?? "bench";

  switch (sub) {
    case "generate":
      await cmdGenerate(args);
      break;
    case "bench":
      await cmdBench(args);
      break;
    default:
      console.error(`Unknown command "${sub}". Use "generate" or "bench".`);
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});