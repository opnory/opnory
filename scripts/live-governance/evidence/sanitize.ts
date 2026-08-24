#!/usr/bin/env bun

// Evidence Sanitizer
// Reads raw certification evidence and produces a sanitized public report
// Usage: bun run scripts/live-governance/evidence/sanitize.ts <input-file> <output-file>

import { readFile, writeFile } from "fs/promises";
import { execSync } from "child_process";
import {
  RawCertificationSchema,
  PublicCertificationSchema,
  sanitizeCertification,
  type PublicCertification,
} from "./schema";

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.error("Usage: bun run sanitize.ts <input-file> [output-file]");
    process.exit(1);
  }

  const inputFile = args[0];
  const outputFile = args[1] || inputFile.replace(/\.json$/, "-public.json");

  console.log(`Reading raw evidence from: ${inputFile}`);

  const rawContent = await readFile(inputFile, "utf-8");
  const raw = JSON.parse(rawContent);

  // Validate raw schema
  const parsed = RawCertificationSchema.safeParse(raw);
  if (!parsed.success) {
    console.error("Invalid raw certification format:", parsed.error);
    process.exit(1);
  }

  // Get git commit SHA
  let sourceCommit: string | undefined;
  try {
    sourceCommit = execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  } catch {
    console.warn("Could not determine git commit SHA");
  }

  const sanitized = sanitizeCertification(parsed.data, {
    sourceCommit,
    schemaVersion: "1",
  });

  // Validate sanitized schema
  const validated = PublicCertificationSchema.safeParse(sanitized);
  if (!validated.success) {
    console.error(
      "Sanitized certification validation failed:",
      validated.error,
    );
    process.exit(1);
  }

  await writeFile(outputFile, JSON.stringify(validated.data, null, 2));
  console.log(`Sanitized public report written to: ${outputFile}`);

  // Also print to stdout for CI/CD consumption
  console.log("\n--- PUBLIC CERTIFICATION REPORT ---");
  console.log(JSON.stringify(validated.data, null, 2));
}

main().catch(console.error);
