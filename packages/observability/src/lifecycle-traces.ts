// packages/observability/src/lifecycle-traces.ts
// OTel lifecycle emission for the Phase 6/7 proof. One trace per lifecycle
// operation (install/reconcile/uninstall/health), phases child-spanned under
// the root. Trace IDs are 32-hex, span IDs 16-hex (OTel-canonical).
// Emission is gated on OPNORY_OTEL_TRACES_ENABLED (see otel.ts).
//
// Frozen attribute contract (ADR 0007 / lifecycle observability proof):
//   opnory.tenant_hash            one-way hash, never the raw tenant id
//   opnory.integration_id         opnory-internal identifier (not a provider id)
//   opnory.plugin_id
//   opnory.provider
//   opnory.operation
//   opnory.desired_state
//   opnory.actual_state
//   opnory.config_version
//   opnory.failure_code           (only when present)
//   opnory.reconciliation_attempt (only on reconciliation spans)
//   opnory.mutated
//   opnory.verified
//   opnory.credential_ref_hash    (one-way hash; raw credential_ref is forbidden)
//
// Raw tenant ids, credential refs, secret material, tokens, provider object
// ids, and request payloads must never appear in emitted attributes.

import { createHash, randomBytes } from "node:crypto";
import { emitSpan, isOtelEnabled } from "./otel.js";

export interface LifecycleAttributes {
  /** Raw tenant id — hashed before emission, never leaves the process. */
  readonly tenantId: string;
  readonly integrationId: string;
  readonly pluginId: string;
  readonly provider: string;
  readonly operation: string;
  readonly desiredState: string;
  readonly actualState: string;
  readonly configVersion: number;
  readonly mutated: string;
  readonly verified?: string;
  readonly failureCode?: string;
  readonly reconciliationAttempt?: string;
  /** Raw credential ref — hashed before emission if present. */
  readonly credentialRef?: string | null;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function cleanAttrs(attrs: LifecycleAttributes): Record<string, string> {
  const out: Record<string, string> = {
    "opnory.tenant_hash": hash(attrs.tenantId),
    "opnory.integration_id": attrs.integrationId,
    "opnory.plugin_id": attrs.pluginId,
    "opnory.provider": attrs.provider,
    "opnory.operation": attrs.operation,
    "opnory.desired_state": attrs.desiredState,
    "opnory.actual_state": attrs.actualState,
    "opnory.config_version": String(attrs.configVersion),
    "opnory.mutated": attrs.mutated,
  };
  if (attrs.verified !== undefined) out["opnory.verified"] = attrs.verified;
  if (attrs.failureCode) out["opnory.failure_code"] = attrs.failureCode;
  if (attrs.reconciliationAttempt)
    out["opnory.reconciliation_attempt"] = attrs.reconciliationAttempt;
  if (attrs.credentialRef)
    out["opnory.credential_ref_hash"] = hash(attrs.credentialRef);
  return out;
}

function newTraceId(): string {
  return randomBytes(16).toString("hex"); // 32 hex chars
}

function newSpanId(): string {
  return randomBytes(8).toString("hex"); // 16 hex chars
}

/**
 * One lifecycle trace. Construct once per operation:
 *   const t = new LifecycleSpan(attrs, "integration.install");
 *   await t.root();
 *   const configure = await t.child("integration.configure");
 *   await t.child("credential.resolve", configure);
 * Phases use the frozen span names emitted verbatim (except root, which is the
 * operation name). Spans share this.trace so the read side reconstructs the
 * operation tree by traceId alone.
 */
export class LifecycleSpan {
  readonly trace: string;
  private readonly rootSpanId: string;

  constructor(
    private readonly attrs: LifecycleAttributes,
    opName: string,
  ) {
    this.trace = newTraceId();
    this.rootSpanId = newSpanId();
    // Root span name is the operation itself.
    this.rootName = opName;
  }

  private readonly rootName: string;

  /** Emit the root span (no parent). */
  async root(): Promise<void> {
    if (!isOtelEnabled()) return;
    const now = BigInt(Date.now()) * 1000000n;
    await emitSpan({
      traceId: this.trace,
      spanId: this.rootSpanId,
      parentSpanId: undefined,
      name: this.rootName,
      startUnixNano: now,
      endUnixNano: now,
      attributes: cleanAttrs(this.attrs),
    });
  }

  /**
   * Emit a child phase. parentSpanId defaults to the root; pass the span ID
   * returned by an earlier child() to chain deeper. Per-span overrides merge
   * with the constructor attrs (used for failureCode on degrade, etc.).
   */
  async child(
    phase: string,
    parentSpanId?: string,
    overrides?: Partial<LifecycleAttributes>,
  ): Promise<string> {
    if (!isOtelEnabled()) return `disabled:${phase}`;
    const now = BigInt(Date.now()) * 1000000n;
    const id = newSpanId();
    await emitSpan({
      traceId: this.trace,
      spanId: id,
      parentSpanId: parentSpanId ?? this.rootSpanId,
      name: phase,
      startUnixNano: now,
      endUnixNano: now,
      attributes: cleanAttrs({ ...this.attrs, ...overrides }),
    });
    return id;
  }
}

export function isLifecycleOtelEnabled(): boolean {
  return isOtelEnabled();
}