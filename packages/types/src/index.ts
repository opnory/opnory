import { z } from "zod";

// ============================================================================
// Core Domain Types
// ============================================================================

export const RequestIdSchema = z.string().uuid();
export type RequestId = z.infer<typeof RequestIdSchema>;

export const UserIdSchema = z.string().min(1);
export type UserId = z.infer<typeof UserIdSchema>;

export const WorkspaceIdSchema = z.string().min(1);
export type WorkspaceId = z.infer<typeof WorkspaceIdSchema>;

export const ChannelIdSchema = z.string().min(1);
export type ChannelId = z.infer<typeof ChannelIdSchema>;

export const ThreadIdSchema = z.string().min(1);
export type ThreadId = z.infer<typeof ThreadIdSchema>;

export const DocumentIdSchema = z.string().uuid();
export type DocumentId = z.infer<typeof DocumentIdSchema>;

export const IntegrationIdSchema = z.string().min(1);
export type IntegrationId = z.infer<typeof IntegrationIdSchema>;

// ============================================================================
// Request/Response Types
// ============================================================================

export const NormalizedRequestSchema = z.object({
  requestId: RequestIdSchema,
  workspaceId: WorkspaceIdSchema,
  userId: UserIdSchema,
  channelId: ChannelIdSchema,
  threadId: ThreadIdSchema.optional(),
  text: z.string().min(1).max(10000),
  timestamp: z.string().datetime(),
  source: z.enum(["slack", "api"]),
  metadata: z.record(z.unknown()).optional(),
});
export type NormalizedRequest = z.infer<typeof NormalizedRequestSchema>;

export const AgentResponseSchema = z.object({
  requestId: RequestIdSchema,
  answer: z.string(),
  citations: z.array(
    z.object({
      documentId: DocumentIdSchema,
      excerpt: z.string(),
      relevanceScore: z.number().min(0).max(1),
    }),
  ),
  confidence: z.number().min(0).max(1),
  shouldEscalate: z.boolean(),
  escalationReason: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type AgentResponse = z.infer<typeof AgentResponseSchema>;

// ============================================================================
// Knowledge Types
// ============================================================================

export const DocumentSchema = z.object({
  id: DocumentIdSchema,
  workspaceId: WorkspaceIdSchema,
  title: z.string(),
  content: z.string(),
  source: z.string(),
  sourceUrl: z.string().url().optional(),
  tags: z.array(z.string()).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  version: z.number().int().positive(),
  metadata: z.record(z.unknown()).optional(),
});
export type Document = z.infer<typeof DocumentSchema>;

export const SearchResultSchema = z.object({
  document: DocumentSchema,
  score: z.number().min(0).max(1),
  matchedExcerpts: z.array(z.string()),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

// ============================================================================
// Escalation Types
// ============================================================================

export const EscalationReasonSchema = z.enum([
  "LOW_CONFIDENCE",
  "NO_RELEVANT_DOCUMENTS",
  "POLICY_REQUIRES_HUMAN",
  "SENSITIVE_TOPIC",
  "USER_REQUESTED",
  "SYSTEM_ERROR",
]);
export type EscalationReason = z.infer<typeof EscalationReasonSchema>;

export const EscalationSchema = z.object({
  id: z.string().uuid(),
  requestId: RequestIdSchema,
  workspaceId: WorkspaceIdSchema,
  reason: EscalationReasonSchema,
  context: z.object({
    userQuestion: z.string(),
    agentResponse: AgentResponseSchema.optional(),
    confidence: z.number().min(0).max(1),
  }),
  status: z.enum(["PENDING", "ASSIGNED", "RESOLVED", "CLOSED"]),
  assigneeId: UserIdSchema.optional(),
  createdAt: z.string().datetime(),
  resolvedAt: z.string().datetime().optional(),
});
export type Escalation = z.infer<typeof EscalationSchema>;

// ============================================================================
// Integration Types
// ============================================================================

export const IntegrationTypeSchema = z.enum([
  "SLACK",
  "GITHUB",
  "JIRA",
  "OKTA",
  "ENTRA_ID",
  "AWS",
  "GOOGLE_WORKSPACE",
]);
export type IntegrationType = z.infer<typeof IntegrationTypeSchema>;

export const IntegrationConfigSchema = z.object({
  id: IntegrationIdSchema,
  workspaceId: WorkspaceIdSchema,
  type: IntegrationTypeSchema,
  name: z.string(),
  config: z.record(z.unknown()),
  isEnabled: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type IntegrationConfig = z.infer<typeof IntegrationConfigSchema>;

// ============================================================================
// Observability Types
// ============================================================================

export const LogLevelSchema = z.enum(["DEBUG", "INFO", "WARN", "ERROR"]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export const TraceContextSchema = z.object({
  traceId: z.string(),
  spanId: z.string(),
  parentSpanId: z.string().optional(),
});
export type TraceContext = z.infer<typeof TraceContextSchema>;

// ============================================================================
// Config Types
// ============================================================================

export const AppConfigSchema = z.object({
  env: z.enum(["development", "staging", "production"]),
  port: z.number().int().positive(),
  logLevel: LogLevelSchema,
  slack: z.object({
    signingSecret: z.string(),
    botToken: z.string(),
    appToken: z.string().optional(),
  }),
  database: z.object({
    url: z.string().url(),
  }),
  redis: z
    .object({
      url: z.string().url(),
    })
    .optional(),
  vectorStore: z.object({
    type: z.enum(["pinecone", "weaviate", "qdrant", "memory"]),
    config: z.record(z.unknown()),
  }),
  llm: z.object({
    provider: z.enum(["openai", "anthropic", "local"]),
    model: z.string(),
    apiKey: z.string().optional(),
    baseUrl: z.string().url().optional(),
  }),
  embedding: z.object({
    provider: z.enum(["openai", "local"]),
    model: z.string(),
    apiKey: z.string().optional(),
    baseUrl: z.string().url().optional(),
    dimensions: z.number().int().positive(),
  }),
  escalation: z.object({
    confidenceThreshold: z.number().min(0).max(1).default(0.7),
    defaultAssigneeId: UserIdSchema.optional(),
  }),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

// ============================================================================
// Agent Types
// ============================================================================

export const AgentStepSchema = z.enum([
  "NORMALIZE",
  "RETRIEVE",
  "REASON",
  "DECIDE",
  "RESPOND",
  "ESCALATE",
]);
export type AgentStep = z.infer<typeof AgentStepSchema>;

export const AgentStateSchema = z.object({
  requestId: RequestIdSchema,
  currentStep: AgentStepSchema,
  normalizedRequest: NormalizedRequestSchema.optional(),
  searchResults: z.array(SearchResultSchema).optional(),
  reasoning: z.string().optional(),
  response: AgentResponseSchema.optional(),
  error: z.string().optional(),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AgentState = z.infer<typeof AgentStateSchema>;

// ============================================================================
// Agent Output Types (Strict Schema)
// ============================================================================

export const CitationSchema = z.object({
  documentId: z.string().uuid(),
  title: z.string(),
  excerpt: z.string(),
  relevanceScore: z.number().min(0).max(1),
  sourceUrl: z.string().url().optional(),
});
export type Citation = z.infer<typeof CitationSchema>;

export const AgentOutputSchema = z.object({
  status: z.enum(["resolved", "escalated"]),
  answer: z.string(),
  citations: z.array(CitationSchema),
  confidence: z.number().min(0).max(1),
  escalationId: z.string().uuid().optional(),
  escalationReason: z.string().optional(),
});
export type AgentOutput = z.infer<typeof AgentOutputSchema>;
