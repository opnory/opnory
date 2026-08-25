import {
  RoleAssignment,
  Permission,
  ResourceScope,
  SubjectRef,
  ResolvedSubject,
  FulfillmentResult,
  VerificationResult,
  FulfillmentAdapter,
  EvidenceEvent,
} from "@opnory/governance-core";

/**
 * Conformance harness for FulfillmentAdapter implementations.
 *
 * Tests the contract guarantees without knowing provider-specific details.
 * Each permission carries its own provider mappings; the harness only knows
 * about Opnory domain objects (Permission, RoleAssignment, SubjectRef).
 */

export interface ConformanceFixture {
  permission: Permission;
  roleId: string; // RoleAssignment.roleId for this permission
}

export interface ConformanceOptions {
  provider: string;
  adapter: FulfillmentAdapter;
  subject: SubjectRef;
  fixtures: ConformanceFixture[];
  scope: ResourceScope;
  evidenceProbe?: CertificationEvidenceProbe;
  eventualConsistency?: {
    maxAttempts?: number;
    delayMs?: number;
    interFixtureDelayMs?: number;
  };
}

export interface CertificationEvidenceProbe {
  collect(): Promise<EvidenceEvent[]>;
}

export interface ConformanceResult {
  provider: string;
  subject: ResolvedSubject;
  passed: boolean;
  fixtures: FixtureResult[];
  evidence: EvidenceEvent[];
  error?: string;
}

export interface FixtureResult {
  permissionId: string;
  roleId: string;
  passed: boolean;
  grant: StepResult;
  verifyAfterGrant: StepResult;
  grantIdempotent: StepResult;
  revoke: StepResult;
  verifyAfterRevoke: StepResult;
  revokeIdempotent: StepResult;
  error?: string;
}

export interface StepResult {
  passed: boolean;
  result: FulfillmentResult | VerificationResult;
  details: string;
}

/**
 * Wait for verification to reach expected status (handles eventual consistency).
 * The convergence policy is deliberately outside the adapter — orchestration decides
 * how long to wait and when to give up.
 */
async function waitForVerification(
  adapter: FulfillmentAdapter,
  assignment: RoleAssignment,
  permission: Permission,
  scope: ResourceScope,
  resolvedSubject: ResolvedSubject,
  expectedStatus: "verified" | "not-found",
  maxAttempts: number,
  delayMs: number,
): Promise<VerificationResult> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await adapter.verify(assignment, permission, scope, resolvedSubject);
    if (result.status === expectedStatus) {
      return result;
    }
    if (attempt < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return adapter.verify(assignment, permission, scope, resolvedSubject); // final attempt
}

/**
 * Run the full fulfillment adapter conformance suite.
 *
 * For each fixture (permission):
 * 1. Resolve subject
 * 2. Verify absent (precondition)
 * 3. Grant → verify present
 * 4. Grant again → verify present + idempotent (mutated: false)
 * 5. Revoke → verify absent
 * 6. Revoke again → verify absent + idempotent (mutated: false)
 * 7. Confirm clean final state
 */
export async function runFulfillmentAdapterCertification(
  options: ConformanceOptions,
): Promise<ConformanceResult> {
  const {
    provider,
    adapter,
    subject,
    fixtures,
    scope,
    evidenceProbe,
    eventualConsistency = {},
  } = options;

  const maxAttempts = eventualConsistency.maxAttempts ?? 10;
  const delayMs = eventualConsistency.delayMs ?? 2000;
  const interFixtureDelayMs = eventualConsistency.interFixtureDelayMs ?? 20000;

  const allFixtureResults: FixtureResult[] = [];
  let overallPassed = true;
  let resolvedSubject: ResolvedSubject;

  try {
    // 1. Resolve subject
    resolvedSubject = await adapter.resolveSubject(subject);
  } catch (error: any) {
    return {
      provider,
      subject: { provider, providerSubjectId: "" },
      passed: false,
      fixtures: [],
      evidence: [],
      error: `Subject resolution failed: ${error.message}`,
    };
  }

  // Collect provider-specific evidence if probe provided
  const allEvidence: EvidenceEvent[] = [];
  if (evidenceProbe) {
    try {
      const probeEvidence = await evidenceProbe.collect();
      allEvidence.push(...probeEvidence);
    } catch {
      // Evidence collection is best-effort
    }
  }

  // Test each fixture
  for (const fixture of fixtures) {
    const { permission, roleId } = fixture;

    const assignment: RoleAssignment = {
      id: crypto.randomUUID(),
      subjectId: resolvedSubject.providerSubjectId,
      roleId,
      scope,
      grantedAt: new Date().toISOString(),
      sourceRequestId: crypto.randomUUID(),
      status: "active",
    };

    const fixtureResult: FixtureResult = {
      permissionId: permission.id,
      roleId,
      passed: false,
      grant: { passed: false, result: null as any, details: "" },
      verifyAfterGrant: { passed: false, result: null as any, details: "" },
      grantIdempotent: { passed: false, result: null as any, details: "" },
      revoke: { passed: false, result: null as any, details: "" },
      verifyAfterRevoke: { passed: false, result: null as any, details: "" },
      revokeIdempotent: { passed: false, result: null as any, details: "" },
    };

    try {
      // 2. Verify absent (precondition) - with eventual consistency handling
      const preVerify = await waitForVerification(
        adapter,
        assignment,
        permission,
        scope,
        resolvedSubject,
        "not-found",
        maxAttempts,
        delayMs,
      );
      if (preVerify.status !== "not-found") {
        fixtureResult.error = `Precondition failed: entitlement already present (${preVerify.status})`;
        allFixtureResults.push(fixtureResult);
        overallPassed = false;
        continue;
      }

      // 3. Grant → verify present
      const grant = await adapter.grant(assignment, permission, scope, resolvedSubject);
      fixtureResult.grant = {
        passed: grant.status === "succeeded",
        result: grant,
        details: `Grant: ${grant.status}${grant.mutated ? " (mutated)" : ""}`,
      };

      if (grant.status !== "succeeded") {
        fixtureResult.error = `Grant failed: ${grant.error}`;
        allFixtureResults.push(fixtureResult);
        overallPassed = false;
        continue;
      }

      const verifyAfterGrant = await waitForVerification(
        adapter,
        assignment,
        permission,
        scope,
        resolvedSubject,
        "verified",
        maxAttempts,
        delayMs,
      );
      fixtureResult.verifyAfterGrant = {
        passed: verifyAfterGrant.status === "verified",
        result: verifyAfterGrant,
        details: `Verify after grant: ${verifyAfterGrant.status}`,
      };

      if (verifyAfterGrant.status !== "verified") {
        fixtureResult.error = `Verification after grant failed: ${verifyAfterGrant.status}`;
        allFixtureResults.push(fixtureResult);
        overallPassed = false;
        continue;
      }

      // 4. Grant again → verify present + idempotent (mutated: false)
      const grantAgain = await adapter.grant(assignment, permission, scope, resolvedSubject);
      fixtureResult.grantIdempotent = {
        passed:
          grantAgain.status === "succeeded" &&
          grantAgain.mutated === false,
        result: grantAgain,
        details: `Grant (idempotent): ${grantAgain.status}${grantAgain.mutated ? " (mutated)" : " (already present)"}`,
      };

      if (grantAgain.status !== "succeeded" || grantAgain.mutated !== false) {
        fixtureResult.error = `Idempotent grant failed: status=${grantAgain.status}, mutated=${grantAgain.mutated}`;
        allFixtureResults.push(fixtureResult);
        overallPassed = false;
        continue;
      }

      // 5. Revoke → verify absent
      const revoke = await adapter.revoke(assignment, permission, scope, resolvedSubject);
      fixtureResult.revoke = {
        passed: revoke.status === "succeeded",
        result: revoke,
        details: `Revoke: ${revoke.status}${revoke.mutated ? " (mutated)" : " (already absent)"}`,
      };

      if (revoke.status !== "succeeded") {
        fixtureResult.error = `Revoke failed: ${revoke.error}`;
        allFixtureResults.push(fixtureResult);
        overallPassed = false;
        continue;
      }

      const verifyAfterRevoke = await waitForVerification(
        adapter,
        assignment,
        permission,
        scope,
        resolvedSubject,
        "not-found",
        maxAttempts,
        delayMs,
      );
      fixtureResult.verifyAfterRevoke = {
        passed: verifyAfterRevoke.status === "not-found",
        result: verifyAfterRevoke,
        details: `Verify after revoke: ${verifyAfterRevoke.status}`,
      };

      if (verifyAfterRevoke.status !== "not-found") {
        fixtureResult.error = `Verification after revoke failed: ${verifyAfterRevoke.status}`;
        allFixtureResults.push(fixtureResult);
        overallPassed = false;
        continue;
      }

      // 6. Revoke again → verify absent + idempotent (mutated: false)
      const revokeAgain = await adapter.revoke(assignment, permission, scope, resolvedSubject);
      fixtureResult.revokeIdempotent = {
        passed:
          revokeAgain.status === "succeeded" &&
          revokeAgain.mutated === false,
        result: revokeAgain,
        details: `Revoke (idempotent): ${revokeAgain.status}${revokeAgain.mutated ? " (mutated)" : " (already absent)"}`,
      };

      if (revokeAgain.status !== "succeeded" || revokeAgain.mutated !== false) {
        fixtureResult.error = `Idempotent revoke failed: status=${revokeAgain.status}, mutated=${revokeAgain.mutated}`;
        allFixtureResults.push(fixtureResult);
        overallPassed = false;
        continue;
      }

      // 7. Final clean state verification (with eventual consistency handling)
      const finalVerify = await waitForVerification(
        adapter,
        assignment,
        permission,
        scope,
        resolvedSubject,
        "not-found",
        maxAttempts,
        delayMs,
      );
      if (finalVerify.status !== "not-found") {
        fixtureResult.error = `Final state not clean: ${finalVerify.status}`;
        allFixtureResults.push(fixtureResult);
        overallPassed = false;
        continue;
      }

      fixtureResult.passed = true;
      allFixtureResults.push(fixtureResult);

      // Inter-fixture delay to let Graph propagate final state
      if (fixture !== fixtures[fixtures.length - 1]) {
        await new Promise((r) => setTimeout(r, interFixtureDelayMs));
      }
    } catch (error: any) {
      fixtureResult.error = `Unexpected error: ${error.message}`;
      allFixtureResults.push(fixtureResult);
      overallPassed = false;
    }
  }

  return {
    provider,
    subject: resolvedSubject,
    passed: overallPassed,
    fixtures: allFixtureResults,
    evidence: allEvidence,
  };
}