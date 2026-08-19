import { z } from "zod";
import { getLogger } from "@opnory/observability";

const logger = getLogger().child({ component: "access-audit" });

// ============================================================================
// Audit Event Types
// ============================================================================

export const AuditEventTypeSchema = z.enum([
  "ACCESS_REQUEST_CREATED",
  "ENTITLEMENT_IDENTIFIED",
  "POLICY_EVALUATED",
  "APPROVAL_REQUESTED",
  "ACCESS_REQUEST_APPROVED",
  "ACCESS_REQUEST_DENIED",
  "FULFILLMENT_STARTED",
  "FULFILLMENT_SUCCEEDED",
  "FULFILLMENT_FAILED",
  "SELF_APPROVAL_ATTEMPT",
  "SELF_DENIAL_ATTEMPT",
  "CONFLICTING_DECISION",
  "MODEL_BYPASS_ATTEMPT",
  "IDEMPOTENCY_CHECK",
  "UNAUTHORIZED_APPROVAL_ATTEMPT",
  "ACCESS_REQUEST_CANCELLED",
  "REVOCATION_REQUESTED",
  "REVOCATION_STARTED",
  "REVOCATION_SUCCEEDED",
  "REVOCATION_FAILED",
]);

export type AuditEventType = z.infer<typeof AuditEventTypeSchema>;

export const AuditEventSchema = z.object({
  eventId: z.string().uuid(),
  requestId: z.string().uuid(),
  correlationId: z.string().uuid(),
  actor: z.string(),
  timestamp: z.string().datetime(),
  type: AuditEventTypeSchema,
  metadata: z.record(z.unknown()).default({}),
});

export type AuditEvent = z.infer<typeof AuditEventSchema>;

// ============================================================================
// Audit Event Store Interface
// ============================================================================

export interface AuditEventStore {
  append(event: AuditEvent): Promise<void>;
  getByRequestId(requestId: string): Promise<AuditEvent[]>;
  getAll(): Promise<AuditEvent[]>;
}

// ============================================================================
// In-Memory Implementation
// ============================================================================

export class InMemoryAuditEventStore implements AuditEventStore {
  private events: AuditEvent[] = [];

  async append(event: AuditEvent): Promise<void> {
    const validated = AuditEventSchema.parse(event);
    this.events.push(validated);
    logger.debug({ eventId: validated.eventId, type: validated.type }, "Audit event recorded");
  }

  async getByRequestId(requestId: string): Promise<AuditEvent[]> {
    return this.events.filter((e) => e.requestId === requestId);
  }

  async getAll(): Promise<AuditEvent[]> {
    return [...this.events];
  }
}

// ============================================================================
// Helper to record audit events
// ============================================================================

export async function recordAuditEvent(
  store: AuditEventStore,
  event: Omit<AuditEvent, "eventId"> & { eventId?: string }
): Promise<void> {
  const fullEvent: AuditEvent = {
    eventId: event.eventId || crypto.randomUUID(),
    requestId: event.requestId,
    correlationId: event.correlationId,
    actor: event.actor,
    timestamp: event.timestamp,
    type: event.type,
    metadata: event.metadata,
  };

  await store.append(fullEvent);
}