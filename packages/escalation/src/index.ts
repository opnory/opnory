import { v4 as uuidv4 } from "uuid";
import { getLogger } from "@opnory/observability";
import {
  type Escalation,
  type EscalationReason,
  type NormalizedRequest,
  type AgentResponse,
  type UserId,
  type WorkspaceId,
  type RequestId,
  EscalationSchema,
  EscalationReasonSchema,
} from "@opnory/types";

const logger = getLogger().child({ component: "escalation" });

export interface EscalationStore {
  set(id: string, escalation: Escalation): void;
  get(id: string): Escalation | undefined;
  delete(id: string): boolean;
  values(): IterableIterator<Escalation>;
  clear(): void;
}

export class InMemoryEscalationStore implements EscalationStore {
  private store = new Map<string, Escalation>();

  set(id: string, escalation: Escalation): void {
    this.store.set(id, escalation);
  }

  get(id: string): Escalation | undefined {
    return this.store.get(id);
  }

  delete(id: string): boolean {
    return this.store.delete(id);
  }

  values(): IterableIterator<Escalation> {
    return this.store.values();
  }

  clear(): void {
    this.store.clear();
  }
}

export interface EscalationService {
  createEscalation(params: CreateEscalationParams): Promise<Escalation>;
  getEscalation(id: string): Promise<Escalation | null>;
  updateEscalation(id: string, updates: Partial<Escalation>): Promise<Escalation | null>;
  listEscalations(workspaceId: WorkspaceId, status?: Escalation["status"]): Promise<Escalation[]>;
  shouldEscalate(response: AgentResponse, request: NormalizedRequest): Promise<EscalationDecision>;
}

export interface CreateEscalationParams {
  requestId: RequestId;
  workspaceId: WorkspaceId;
  reason: EscalationReason;
  context: {
    userQuestion: string;
    agentResponse?: AgentResponse;
    confidence: number;
  };
}

export interface EscalationDecision {
  shouldEscalate: boolean;
  reason: EscalationReason;
  confidence: number;
}

export class InMemoryEscalationService implements EscalationService {
  constructor(private readonly store: EscalationStore) {}

  async createEscalation(params: CreateEscalationParams): Promise<Escalation> {
    const id = uuidv4();
    const now = new Date().toISOString();

    const escalation: Escalation = {
      id,
      requestId: params.requestId,
      workspaceId: params.workspaceId,
      reason: params.reason,
      context: params.context,
      status: "PENDING",
      assigneeId: undefined,
      createdAt: now,
    };

    const validated = EscalationSchema.parse(escalation);
    this.store.set(id, validated);

    logger.info(
      { escalationId: id, requestId: params.requestId, reason: params.reason },
      "Escalation created"
    );

    return validated;
  }

  async getEscalation(id: string): Promise<Escalation | null> {
    return this.store.get(id) || null;
  }

  async updateEscalation(id: string, updates: Partial<Escalation>): Promise<Escalation | null> {
    const existing = this.store.get(id);
    if (!existing) return null;

    const updated = { ...existing, ...updates };
    const validated = EscalationSchema.parse(updated);
    this.store.set(id, validated);

    logger.info({ escalationId: id, updates: Object.keys(updates) }, "Escalation updated");
    return validated;
  }

  async listEscalations(workspaceId: WorkspaceId, status?: Escalation["status"]): Promise<Escalation[]> {
    const results: Escalation[] = [];
    for (const esc of this.store.values()) {
      if (esc.workspaceId === workspaceId && (!status || esc.status === status)) {
        results.push(esc);
      }
    }
    return results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  async shouldEscalate(response: AgentResponse, request: NormalizedRequest): Promise<EscalationDecision> {
    if (response.shouldEscalate) {
      return {
        shouldEscalate: true,
        reason: response.escalationReason ? EscalationReasonSchema.parse(response.escalationReason) : "LOW_CONFIDENCE",
        confidence: response.confidence,
      };
    }

    if (response.confidence < 0.7) {
      return {
        shouldEscalate: true,
        reason: "LOW_CONFIDENCE",
        confidence: response.confidence,
      };
    }

    if (response.citations.length === 0) {
      return {
        shouldEscalate: true,
        reason: "NO_RELEVANT_DOCUMENTS",
        confidence: response.confidence,
      };
    }

    return {
      shouldEscalate: false,
      reason: "LOW_CONFIDENCE",
      confidence: response.confidence,
    };
  }
}

export { type Escalation, type EscalationReason };