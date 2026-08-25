import { z } from "zod";

// ============================================================================
// Public Certification Schema (sanitized - no tenant identifiers)
// ============================================================================

export const PublicCertificationSchema = z.object({
  provider: z.string(),
  mode: z.enum(["model-a", "model-b"]),
  result: z.literal("PASS"),
  certificationSchemaVersion: z.string(),
  sourceCommit: z.string().optional(),
  sanitized: z.boolean(),
  capabilities: z.array(z.string()),
  licensingBoundary: z.object({
    entraGovernanceRequired: z.boolean(),
    testedCapabilities: z.string(),
  }),
  certifiedAt: z.string().datetime(),
  // No tenant IDs, object IDs, request IDs, or timestamps from audit logs
});

export type PublicCertification = z.infer<typeof PublicCertificationSchema>;

// ============================================================================
// Raw Evidence Schema (internal - contains tenant identifiers)
// ============================================================================

export const RawEvidenceSchema = z.object({
  provider: z.string(),
  test: z.string(),
  passed: z.boolean(),
  timestamp: z.string().datetime(),
  durationMs: z.number(),
  details: z.string(),
  // May contain Graph request IDs, object IDs, etc.
});

export type RawEvidence = z.infer<typeof RawEvidenceSchema>;

export const RawCertificationSchema = z.object({
  provider: z.string(),
  mode: z.enum(["model-a", "model-b"]),
  timestamp: z.string().datetime(),
  config: z.object({
    tenantId: z.string(),
    subject: z.string(),
    enterpriseApp: z.string(),
    // May contain other IDs
  }),
  evidence: z.array(RawEvidenceSchema),
});

export type RawCertification = z.infer<typeof RawCertificationSchema>;

export const sanitizeCertification = (
  raw: RawCertification,
  options?: { sourceCommit?: string; schemaVersion?: string },
): PublicCertification => {
  const capabilities = raw.evidence
    .filter((e) => e.passed)
    .map((e) => {
      const test = e.test;
      if (test === "identity-resolution") return "identity-resolution";
      if (test.startsWith("group-fulfillment")) return "group-fulfillment";
      if (test.startsWith("app-role-fulfillment")) return "app-role-assignment";
      if (test === "audit-log-evidence") return "audit-evidence";
      // Also check for revocation evidence
      if (test.includes("revoke")) return "revocation";
      return test;
    });

  // Deduplicate
  const uniqueCapabilities = [...new Set(capabilities)];

  // Explicitly include revocation if any grant+revoke tests passed
  const hasRevocation = raw.evidence.some(
    (e) =>
      e.passed &&
      (e.test.startsWith("group-fulfillment") ||
        e.test.startsWith("app-role-fulfillment")),
  );
  if (hasRevocation && !uniqueCapabilities.includes("revocation")) {
    uniqueCapabilities.push("revocation");
  }

  return {
    provider: raw.provider === "entra" ? "Microsoft Entra ID" : raw.provider,
    mode: raw.mode,
    result: "PASS",
    certificationSchemaVersion: options?.schemaVersion || "1",
    sourceCommit: options?.sourceCommit,
    sanitized: true,
    capabilities: uniqueCapabilities,
    licensingBoundary: {
      entraGovernanceRequired: false,
      testedCapabilities:
        "Microsoft Graph identity and access primitives (users, groups, appRoles)",
    },
    certifiedAt: new Date(raw.timestamp).toISOString(),
  };
};
