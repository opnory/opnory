// packages/integration-runtime/src/types.ts
// Local type definitions for the capability runtime spike
// Re-exports from governance-core and access-types for use within this package

import type { FulfillmentAdapter, SubjectRef, ResourceScope, Permission } from "@opnory/governance-core";
import type { EntitlementRef } from "@opnory/access-types";

export type { FulfillmentAdapter, SubjectRef, ResourceScope, Permission, EntitlementRef };

// Additional local types for the spike

/** Policy decision about which provider to use */
export interface PolicyProviderDecision {
  readonly chosenProvider: string;
  readonly reason: string;
  readonly alternativesConsidered: readonly string[];
}

/** Provider capability health status */
export interface CapabilityHealth {
  readonly capabilityName: string;
  readonly tenantId: string;
  readonly healthy: boolean;
  readonly lastCheck: Date;
  readonly details?: string;
}