import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..", "..");

// ============================================================================
// Evidence Recording
// ============================================================================

export type EvidenceStatus = "PASS" | "FAIL" | "SKIP" | "WAITING";

export interface EvidenceStep {
  step: string;
  description: string;
  status: EvidenceStatus;
  timestamp: string;
  durationMs: number;
  metadata: Record<string, unknown>;
}

export interface EvidenceSummary {
  schemaVersion: number;
  provider: string;
  commitSha: string;
  sandboxTenant: string;
  steps: EvidenceStep[];
  startedAt: string;
  completedAt?: string;
  overallStatus: EvidenceStatus;
  mutationCounts: Record<string, number>;
  externalMutations: {
    providerRequestCreates: number;
    providerRevokeMutations: number;
    githubPuts: number;
    githubDeletes: number;
  };
  unexpectedStateTransitions: number;
  duplicateMutations: number;
  unclassifiedFailures: number;
  credentialLeakage: boolean;
}

export class EvidenceRecorder {
  private steps: EvidenceStep[] = [];
  private mutationCounts: Record<string, number> = {};
  private externalMutations = {
    providerRequestCreates: 0,
    providerRevokeMutations: 0,
    githubPuts: 0,
    githubDeletes: 0,
  };
  private unexpectedStateTransitions = 0;
  private duplicateMutations = 0;
  private unclassifiedFailures = 0;
  private credentialLeakage = false;
  private startedAt = new Date().toISOString();
  private stepStartTimes: Map<string, number> = new Map();

  constructor(
    public readonly provider: string,
    public readonly commitSha: string,
    public readonly sandboxTenant: string
  ) {}

  record(step: string, description: string, status: EvidenceStatus, metadata: Record<string, unknown> = {}): void {
    const sanitized = this.sanitizeMetadata(metadata);
    const startTime = this.stepStartTimes.get(step) || Date.now();
    this.steps.push({
      step,
      description,
      status,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      metadata: sanitized,
    });

    const icon = status === "PASS" ? "✅" : status === "FAIL" ? "❌" : status === "WAITING" ? "⏳" : "⏭️";
    console.log(`  ${icon} ${step}: ${description}`);
  }

  startStep(step: string, description: string): EvidenceStepHandle {
    this.stepStartTimes.set(step, Date.now());
    return new EvidenceStepHandle(this, step, description);
  }

  incrementExternalMutation(type: "providerRequestCreates" | "providerRevokeMutations" | "githubPuts" | "githubDeletes"): void {
    this.externalMutations[type]++;
  }

  incrementDuplicateMutation(): void {
    this.duplicateMutations++;
  }

  incrementUnexpectedStateTransition(): void {
    this.unexpectedStateTransitions++;
  }

  incrementUnclassifiedFailure(): void {
    this.unclassifiedFailures++;
  }

  private sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    const sensitivePatterns = [
      /\btoken\b/i, /\baccessToken\b/i, /\baccess_token\b/i,
      /\bclientSecret\b/i, /\bclient_secret\b/i,
      /\bprivateKey\b/i, /\bprivate_key\b/i,
      /\bsecret\b/i, /\bpassword\b/i, /\bpasswd\b/i,
      /\bauthorization\b/i, /\bAuthorization\b/i,
      /\bjwt\b/i, /\bassertion\b/i, /\bclientAssertion\b/i,
    ];

    for (const [key, value] of Object.entries(metadata)) {
      if (sensitivePatterns.some(p => p.test(key))) {
        sanitized[key] = "[REDACTED]";
        this.credentialLeakage = true;
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  getSummary(): EvidenceSummary {
    const overallStatus = this.steps.some(s => s.status === "FAIL") ? "FAIL" : "PASS";
    return {
      schemaVersion: 1,
      provider: this.provider,
      commitSha: this.commitSha,
      sandboxTenant: this.sandboxTenant,
      steps: this.steps,
      startedAt: this.startedAt,
      completedAt: new Date().toISOString(),
      overallStatus,
      mutationCounts: this.mutationCounts,
      externalMutations: this.externalMutations,
      unexpectedStateTransitions: this.unexpectedStateTransitions,
      duplicateMutations: this.duplicateMutations,
      unclassifiedFailures: this.unclassifiedFailures,
      credentialLeakage: this.credentialLeakage,
    };
  }

  writeArtifacts(): void {
    const resultsDir = join(PROJECT_ROOT, ".live-results");
    if (!existsSync(resultsDir)) {
      mkdirSync(resultsDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const baseName = `${this.provider}-${timestamp}`;
    const jsonPath = join(resultsDir, `${baseName}.json`);
    const mdPath = join(resultsDir, `${baseName}.md`);

    const summary = this.getSummary();
    writeFileSync(jsonPath, JSON.stringify(summary, null, 2));

    // Generate markdown report
    const md = this.generateMarkdown(summary);
    writeFileSync(mdPath, md);

    console.log(`\n📄 Evidence written to:`);
    console.log(`   ${jsonPath}`);
    console.log(`   ${mdPath}`);
  }

  private generateMarkdown(summary: EvidenceSummary): string {
    const lines: string[] = [];
    lines.push(`# ${summary.provider.toUpperCase()} Live Governance Validation Report`);
    lines.push("");
    lines.push(`**Commit SHA:** \`${summary.commitSha}\``);
    lines.push(`**Sandbox Tenant/Org:** ${summary.sandboxTenant}`);
    lines.push(`**Started:** ${summary.startedAt}`);
    lines.push(`**Completed:** ${summary.completedAt}`);
    lines.push(`**Overall Status:** ${summary.overallStatus}`);
    lines.push("");

    lines.push("## Step Results");
    lines.push("");
    lines.push("| Step | Description | Status | Duration |");
    lines.push("|------|-------------|--------|----------|");
    for (const step of summary.steps) {
      lines.push(`| ${step.step} | ${step.description} | ${step.status} | ${step.durationMs}ms |`);
    }
    lines.push("");

    lines.push("## Mutation Counts");
    lines.push("");
    lines.push("| Type | Count |");
    lines.push("|------|-------|");
    lines.push(`| Provider Request Creates | ${summary.externalMutations.providerRequestCreates} |`);
    lines.push(`| Provider Revoke Mutations | ${summary.externalMutations.providerRevokeMutations} |`);
    lines.push(`| GitHub PUTs | ${summary.externalMutations.githubPuts} |`);
    lines.push(`| GitHub DELETEs | ${summary.externalMutations.githubDeletes} |`);
    lines.push("");

    lines.push("## Safety Checks");
    lines.push("");
    lines.push(`| Check | Result |`);
    lines.push(`|-------|--------|`);
    lines.push(`| Unexpected State Transitions | ${summary.unexpectedStateTransitions} |`);
    lines.push(`| Duplicate Mutations | ${summary.duplicateMutations} |`);
    lines.push(`| Unclassified Failures | ${summary.unclassifiedFailures} |`);
    lines.push(`| Credential Leakage Detected | ${summary.credentialLeakage ? "❌ YES" : "✅ NO"} |`);
    lines.push("");

    return lines.join("\n");
  }
}

export class EvidenceStepHandle {
  private ended = false;

  constructor(
    private recorder: EvidenceRecorder,
    private step: string,
    private description: string
  ) {}

  end(status: EvidenceStatus, metadata: Record<string, unknown> = {}): void {
    if (this.ended) return;
    this.ended = true;
    this.recorder.record(this.step, this.description, status, metadata);
  }
}

// ============================================================================
// Git/Commit Guards
// ============================================================================

export const EXPECTED_COMMIT_SHA = "5435a39686671b2b82fa7a0875ed1aa2ef4d7c91";

export function verifyCommitSha(): string {
  const sha = execSync("git rev-parse HEAD", { cwd: PROJECT_ROOT, encoding: "utf-8" }).trim();
  if (sha !== EXPECTED_COMMIT_SHA) {
    console.warn(`⚠️  COMMIT SHA MISMATCH`);
    console.warn(`   Expected: ${EXPECTED_COMMIT_SHA}`);
    console.warn(`   Actual:   ${sha}`);
    if (process.env.OPNORY_ALLOW_UNPINNED_LIVE_TEST !== "true") {
      throw new Error(`Commit SHA mismatch. Set OPNORY_ALLOW_UNPINNED_LIVE_TEST=true to override.`);
    }
  }
  return sha;
}

export function verifyCleanWorkingTree(): void {
  const status = execSync("git status --porcelain", { cwd: PROJECT_ROOT, encoding: "utf-8" }).trim();
  if (status && process.env.OPNORY_ALLOW_DIRTY_LIVE_TEST !== "true") {
    throw new Error(`Running live tests with dirty working tree. Set OPNORY_ALLOW_DIRTY_LIVE_TEST=true to override.`);
  }
}

// ============================================================================
// Environment Guards
// ============================================================================

export function requireEnvVars(names: string[]): void {
  const missing = names.filter(n => !process.env[n]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

export function requireSandboxConfirmation(provider: "entra" | "okta"): void {
  if (process.env.OPNORY_LIVE_GOVERNANCE_TESTS !== "true") {
    throw new Error(`Sandbox confirmation required. Set OPNORY_LIVE_GOVERNANCE_TESTS=true and OPNORY_${provider.toUpperCase()}_SANDBOX_CONFIRM=true`);
  }
  const confirmVar = `OPNORY_${provider.toUpperCase()}_SANDBOX_CONFIRM`;
  if (process.env[confirmVar] !== "true") {
    throw new Error(`Sandbox confirmation required. Set OPNORY_LIVE_GOVERNANCE_TESTS=true and ${confirmVar}=true`);
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

export async function pollWithTimeout<T>(
  predicate: () => Promise<T | null>,
  options: { intervalMs: number; timeoutMs: number; description: string }
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < options.timeoutMs) {
    const result = await predicate();
    if (result !== null) {
      return result;
    }
    await sleep(options.intervalMs);
  }
  throw new Error(`Timeout waiting for ${options.description} after ${options.timeoutMs}ms`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function parseDuration(str: string): number {
  const match = str.match(/^(\d+)([smh])$/);
  if (!match) return 0;
  const value = parseInt(match[1]);
  const unit = match[2];
  switch (unit) {
    case "s": return value * 1000;
    case "m": return value * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    default: return 0;
  }
}

export function newCorrelationId(): string {
  return randomUUID();
}

export function newIdempotencyKey(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} not set`);
  }
  return value;
}

export function getEnvOptional(name: string): string | undefined {
  return process.env[name];
}