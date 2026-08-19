import { z } from "zod";
import { getLogger } from "@opnory/observability";

const logger = getLogger().child({ component: "access-entitlements" });

// ============================================================================
// Entitlement Types
// ============================================================================

export const EntitlementSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  system: z.string().min(1).max(50), // e.g., "github", "aws", "gcp", "datadog"
  description: z.string().min(1).max(500),
  durationDays: z.number().int().positive(),
  approvalPolicy: z.enum(["MANAGER", "AUTO", "SECURITY_REVIEW", "ADMIN"]),
  risk: z.enum(["low", "standard", "high", "critical"]),
  metadata: z.record(z.unknown()).optional().default({}),
  // GitHub-specific provisioning config (required when system === "github")
  githubConfig: z
    .object({
      organization: z.string().min(1), // e.g., "opnory-sandbox"
      teamSlug: z.string().min(1), // e.g., "opnory-engineering-contributors"
      teamRole: z.enum(["member", "maintainer"]).default("member"),
    })
    .optional(),
});

export type Entitlement = z.infer<typeof EntitlementSchema>;

// ============================================================================
// Entitlement Catalog
// ============================================================================

export class EntitlementCatalog {
  private entitlements: Map<string, Entitlement> = new Map();
  private entitlementsBySystem: Map<string, Entitlement[]> = new Map();

  constructor(entitlements: Entitlement[] = []) {
    for (const entitlement of entitlements) {
      this.register(entitlement);
    }
  }

  register(entitlement: Entitlement): void {
    const validated = EntitlementSchema.parse(entitlement);
    this.entitlements.set(validated.id, validated);

    const systemEntitlements = this.entitlementsBySystem.get(validated.system) || [];
    systemEntitlements.push(validated);
    this.entitlementsBySystem.set(validated.system, systemEntitlements);

    logger.info({ entitlementId: validated.id, system: validated.system }, "Entitlement registered");
  }

  getById(id: string): Entitlement | undefined {
    return this.entitlements.get(id);
  }

  getBySystem(system: string): Entitlement[] {
    return this.entitlementsBySystem.get(system) || [];
  }

  getAll(): Entitlement[] {
    return Array.from(this.entitlements.values());
  }

  findByName(name: string): Entitlement | undefined {
    for (const entitlement of this.entitlements.values()) {
      if (entitlement.name.toLowerCase() === name.toLowerCase()) {
        return entitlement;
      }
    }
    return undefined;
  }

  findByPartialMatch(query: string, system?: string): Entitlement[] {
    const candidates = system ? this.getBySystem(system) : this.getAll();
    const lowerQuery = query.toLowerCase();

    return candidates.filter((e) =>
      e.name.toLowerCase().includes(lowerQuery) ||
      e.description.toLowerCase().includes(lowerQuery) ||
      e.id.toLowerCase().includes(lowerQuery)
    );
  }
}

// ============================================================================
// Canonical Entitlements
// ============================================================================

export const ENGINEERING_CONTRIBUTOR_ENTITLEMENT_ID = "550e8400-e29b-41d4-a716-446655440101";

export const canonicalEngineeringContributorEntitlement: Entitlement = {
  id: ENGINEERING_CONTRIBUTOR_ENTITLEMENT_ID,
  name: "Engineering Contributor",
  system: "github",
  description: "Contributor access to approved engineering repositories via team membership",
  durationDays: 90,
  approvalPolicy: "MANAGER",
  risk: "standard",
  metadata: {
    repositories: ["opnory/*", "opnory-internal/*"],
    permissions: ["read", "write", "admin"],
    teams: ["engineering"],
  },
  githubConfig: {
    organization: "opnory-sandbox",
    teamSlug: "opnory-engineering-contributors",
    teamRole: "member",
  },
};

export function createDefaultCatalog(): EntitlementCatalog {
  return new EntitlementCatalog([canonicalEngineeringContributorEntitlement]);
}

export { EntitlementCatalog as EntitlementStore };