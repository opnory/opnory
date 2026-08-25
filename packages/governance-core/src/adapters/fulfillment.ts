import { z } from "zod";

// ============================================================================
// Fulfillment Adapter Contract
// Generic interface for provider-specific fulfillment operations
// ============================================================================

import {
  RoleAssignment,
  Permission,
  ResourceScope,
  SubjectRef,
  ResolvedSubject,
  FulfillmentResult,
  VerificationResult,
  FulfillmentAdapter,
} from "../domain";

import { EntraAdapter, EntraAdapterConfig } from "./entra-adapter";
import { OktaAdapter, OktaAdapterConfig } from "./okta-adapter";

// ---------------------------------------------------------------------------
// Adapter Registry
// ---------------------------------------------------------------------------

export type AdapterFactory = (
  config: Record<string, string>,
) => FulfillmentAdapter;

const adapterRegistry = new Map<string, AdapterFactory>();

export function registerAdapter(
  provider: string,
  factory: AdapterFactory,
): void {
  adapterRegistry.set(provider, factory);
}

export function getAdapter(
  provider: string,
  config: Record<string, string>,
): FulfillmentAdapter {
  const factory = adapterRegistry.get(provider);
  if (!factory) {
    throw new Error(`No adapter registered for provider: ${provider}`);
  }
  return factory(config);
}

export function listAdapters(): string[] {
  return Array.from(adapterRegistry.keys());
}

// Register built-in adapters
registerAdapter("entra", (config) =>
  new EntraAdapter(config as unknown as EntraAdapterConfig),
);
registerAdapter("okta", (config) =>
  new OktaAdapter(config as unknown as OktaAdapterConfig),
);
