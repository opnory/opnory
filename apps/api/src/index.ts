import fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { getLogger } from "@opnory/observability";
import { getConfig } from "@opnory/config";
import { getAgent } from "@opnory/agent";
import { getAccessService } from "@opnory/access-service";
import { v4 as uuidv4 } from "uuid";
import {
  type NormalizedRequest,
  type AgentResponse,
  NormalizedRequestSchema,
  AgentResponseSchema,
} from "@opnory/types";
import {
  AccessRequestSchema,
  ApprovalDecisionSchema,
  type AccessRequest,
  type ApprovalDecision,
} from "@opnory/access-types";

const logger = getLogger().child({ component: "api" });

export async function createApiServer(): Promise<FastifyInstance> {
  const config = getConfig();
  const agent = getAgent();

  const server = fastify({
    trustProxy: true,
  });

  // Register plugins
  await server.register(helmet);
  await server.register(cors, { origin: true });
  await server.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
  });

  // Health check
  server.get("/health", async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
  }));

  // Process support request endpoint (primary internal endpoint)
  server.post<{
    Body: NormalizedRequest;
    Reply: AgentResponse;
  }>(
    "/v1/support/requests",
    {
      schema: {
        body: {
          type: "object",
          required: [
            "requestId",
            "workspaceId",
            "userId",
            "channelId",
            "text",
            "timestamp",
            "source",
          ],
          properties: {
            requestId: { type: "string", format: "uuid" },
            workspaceId: { type: "string" },
            userId: { type: "string" },
            channelId: { type: "string" },
            threadId: { type: "string" },
            text: { type: "string", minLength: 1, maxLength: 10000 },
            timestamp: { type: "string", format: "date-time" },
            source: { type: "string", enum: ["slack", "api"] },
            metadata: { type: "object" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              requestId: { type: "string", format: "uuid" },
              answer: { type: "string" },
              citations: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    documentId: { type: "string", format: "uuid" },
                    excerpt: { type: "string" },
                    relevanceScore: { type: "number", minimum: 0, maximum: 1 },
                  },
                },
              },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              shouldEscalate: { type: "boolean" },
              escalationReason: { type: "string" },
              metadata: { type: "object" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const requestId = request.body.requestId || uuidv4();
      const traceLogger = logger.child({
        requestId,
        workspaceId: request.body.workspaceId,
      });

      traceLogger.info({ step: "api_receive" }, "Received API request");

      try {
        const validatedRequest = NormalizedRequestSchema.parse({
          ...request.body,
          requestId,
        });

        const response = await agent.processRequest(validatedRequest);
        const validatedResponse = AgentResponseSchema.parse(response);

        traceLogger.info(
          { step: "api_respond", confidence: response.confidence },
          "API request processed",
        );
        return validatedResponse;
      } catch (error) {
        traceLogger.error({ error }, "Error processing API request");
        reply.code(500);
        // SAFETY: error response structurally matches AgentResponse schema
        return {
          requestId,
          answer: "An error occurred processing your request.",
          citations: [],
          confidence: 0,
          shouldEscalate: true,
          escalationReason: "SYSTEM_ERROR",
        } as AgentResponse;
      }
    },
  );

  // Slack-specific endpoint - normalizes Slack payload to NormalizedRequest
  server.post<{
    Body: {
      text: string;
      userId: string;
      channelId: string;
      threadId?: string;
      workspaceId: string;
      requestId?: string;
    };
    Reply: AgentResponse;
  }>(
    "/v1/slack/commands",
    {
      schema: {
        body: {
          type: "object",
          required: ["text", "userId", "channelId", "workspaceId"],
          properties: {
            text: { type: "string", minLength: 1, maxLength: 10000 },
            userId: { type: "string" },
            channelId: { type: "string" },
            threadId: { type: "string" },
            workspaceId: { type: "string" },
            requestId: { type: "string", format: "uuid" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              requestId: { type: "string", format: "uuid" },
              answer: { type: "string" },
              citations: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    documentId: { type: "string", format: "uuid" },
                    excerpt: { type: "string" },
                    relevanceScore: { type: "number", minimum: 0, maximum: 1 },
                  },
                },
              },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              shouldEscalate: { type: "boolean" },
              escalationReason: { type: "string" },
              metadata: { type: "object" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { text, userId, channelId, threadId, workspaceId, requestId } =
        request.body;
      const finalRequestId = requestId || uuidv4();
      const traceLogger = logger.child({
        requestId: finalRequestId,
        workspaceId,
      });

      traceLogger.info({ step: "slack_receive" }, "Received Slack request");

      try {
        const normalizedRequest = NormalizedRequestSchema.parse({
          requestId: finalRequestId,
          workspaceId,
          userId,
          channelId,
          threadId,
          text,
          timestamp: new Date().toISOString(),
          source: "slack",
        });

        const response = await agent.processRequest(normalizedRequest);
        const validatedResponse = AgentResponseSchema.parse(response);

        traceLogger.info(
          { step: "slack_respond", confidence: response.confidence },
          "Slack request processed",
        );
        return validatedResponse;
      } catch (error) {
        traceLogger.error({ error }, "Error processing Slack request");
        reply.code(500);
        // SAFETY: error response structurally matches AgentResponse schema
        return {
          requestId: finalRequestId,
          answer: "An error occurred processing your request.",
          citations: [],
          confidence: 0,
          shouldEscalate: true,
          escalationReason: "SYSTEM_ERROR",
        } as AgentResponse;
      }
    },
  );

  // ============================================================================
  // Access Request Endpoints
  // ============================================================================

  const accessService = getAccessService();

  // POST /v1/access/requests - Create new access request
  server.post<{
    Body: {
      requesterId: string;
      requesterEmail: string;
      entitlementIdOrName: string;
      reason: string;
      // SAFETY: metadata is a flexible caller-provided payload at API boundary; validated by schema at consumption
      metadata?: Record<string, unknown>;
    };
    Reply: AccessRequest | { error: string };
  }>(
    "/v1/access/requests",
    {
      schema: {
        body: {
          type: "object",
          required: [
            "requesterId",
            "requesterEmail",
            "entitlementIdOrName",
            "reason",
          ],
          properties: {
            requesterId: { type: "string" },
            requesterEmail: { type: "string", format: "email" },
            entitlementIdOrName: { type: "string", minLength: 1 },
            reason: { type: "string", minLength: 1, maxLength: 2000 },
            metadata: { type: "object" },
          },
        },
        response: {
          200: { $ref: "AccessRequest#" },
          400: { type: "object", properties: { error: { type: "string" } } },
          404: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (request, reply) => {
      const traceLogger = logger.child({ component: "access-requests" });

      try {
        const accessRequest = await accessService.createAccessRequest({
          requesterId: request.body.requesterId,
          requesterEmail: request.body.requesterEmail,
          entitlementIdOrName: request.body.entitlementIdOrName,
          reason: request.body.reason,
          metadata: request.body.metadata,
        });

        traceLogger.info(
          { requestId: accessRequest.id },
          "Access request created",
        );
        return accessRequest;
      } catch (error) {
        traceLogger.error({ error }, "Error creating access request");
        if (error instanceof Error && error.message.includes("not found")) {
          reply.code(404);
          // SAFETY: error response matches { error: string } which is in Reply union
          return { error: error.message };
        }
        reply.code(400);
        // SAFETY: error response matches { error: string } which is in Reply union
        return {
          error: error instanceof Error ? error.message : "Invalid request",
        };
      }
    },
  );

  // GET /v1/access/requests/:id - Get access request status
  server.get<{
    Params: { id: string };
    Reply: AccessRequest | { error: string };
  }>(
    "/v1/access/requests/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string", format: "uuid" } },
          required: ["id"],
        },
        response: {
          200: { $ref: "AccessRequest#" },
          404: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (request, reply) => {
      const accessRequest = await accessService.getRequestById(
        request.params.id,
      );
      if (!accessRequest) {
        reply.code(404);
        return { error: "Access request not found" };
      }
      return accessRequest;
    },
  );

  // POST /v1/access/requests/:id/approve - Approve access request
  server.post<{
    Params: { id: string };
    Body: ApprovalDecision;
    Reply: AccessRequest | { error: string };
  }>(
    "/v1/access/requests/:id/approve",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string", format: "uuid" } },
          required: ["id"],
        },
        body: {
          type: "object",
          required: ["decision", "approverId", "approverEmail"],
          properties: {
            decision: { type: "string", enum: ["APPROVE", "DENY"] },
            approverId: { type: "string" },
            approverEmail: { type: "string", format: "email" },
            reason: { type: "string", maxLength: 2000 },
            timestamp: { type: "string", format: "date-time" },
          },
        },
        response: {
          200: { $ref: "AccessRequest#" },
          400: { type: "object", properties: { error: { type: "string" } } },
          404: { type: "object", properties: { error: { type: "string" } } },
          409: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (request, reply) => {
      const traceLogger = logger.child({
        requestId: request.params.id,
        component: "access-approval",
      });

      try {
        const decision = ApprovalDecisionSchema.parse(request.body);
        const correlationId = uuidv4();

        const updatedRequest = await accessService.decideAccessRequest(
          request.params.id,
          decision,
          correlationId,
        );

        traceLogger.info(
          { requestId: request.params.id, decision: decision.decision },
          "Access request decided",
        );
        return updatedRequest;
      } catch (error) {
        traceLogger.error({ error }, "Error deciding access request");
        if (error instanceof Error) {
          if (error.message.includes("not found")) {
            reply.code(404);
            // SAFETY: error response matches { error: string } which is in Reply union
            return { error: error.message };
          }
          if (
            error.message.includes("cannot approve") ||
            error.message.includes("transition")
          ) {
            reply.code(409);
            // SAFETY: error response matches { error: string } which is in Reply union
            return { error: error.message };
          }
        }
        reply.code(400);
        // SAFETY: error response matches { error: string } which is in Reply union
        return {
          error: error instanceof Error ? error.message : "Invalid decision",
        };
      }
    },
  );

  // POST /v1/access/requests/:id/deny - Deny access request (alias for approve with DENY)
  server.post<{
    Params: { id: string };
    Body: ApprovalDecision;
    Reply: AccessRequest | { error: string };
  }>(
    "/v1/access/requests/:id/deny",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string", format: "uuid" } },
          required: ["id"],
        },
        body: {
          type: "object",
          required: ["decision", "approverId", "approverEmail"],
          properties: {
            decision: { type: "string", enum: ["DENY"] },
            approverId: { type: "string" },
            approverEmail: { type: "string", format: "email" },
            reason: { type: "string", maxLength: 2000 },
            timestamp: { type: "string", format: "date-time" },
          },
        },
        response: {
          200: { $ref: "AccessRequest#" },
          400: { type: "object", properties: { error: { type: "string" } } },
          404: { type: "object", properties: { error: { type: "string" } } },
          409: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (request, reply) => {
      const traceLogger = logger.child({
        requestId: request.params.id,
        component: "access-approval",
      });

      try {
        const decision = ApprovalDecisionSchema.parse({
          ...request.body,
          decision: "DENY",
        });
        const correlationId = uuidv4();

        const updatedRequest = await accessService.decideAccessRequest(
          request.params.id,
          decision,
          correlationId,
        );

        traceLogger.info(
          { requestId: request.params.id, decision: "DENY" },
          "Access request denied",
        );
        return updatedRequest;
      } catch (error) {
        traceLogger.error({ error }, "Error denying access request");
        if (error instanceof Error) {
          if (error.message.includes("not found")) {
            reply.code(404);
            // SAFETY: error response matches { error: string } which is in Reply union
            return { error: error.message };
          }
          if (
            error.message.includes("cannot approve") ||
            error.message.includes("transition")
          ) {
            reply.code(409);
            // SAFETY: error response matches { error: string } which is in Reply union
            return { error: error.message };
          }
        }
        reply.code(400);
        // SAFETY: error response matches { error: string } which is in Reply union
        return {
          error: error instanceof Error ? error.message : "Invalid decision",
        };
      }
    },
  );

  // GET /v1/access/requests/:id/audit - Get audit trail for request
  server.get<{
    Params: { id: string };
    Reply: import("@opnory/access-audit").AuditEvent[] | { error: string };
  }>(
    "/v1/access/requests/:id/audit",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string", format: "uuid" } },
          required: ["id"],
        },
        response: {
          200: {
            type: "array",
            items: {
              type: "object",
              properties: {
                eventId: { type: "string", format: "uuid" },
                requestId: { type: "string", format: "uuid" },
                correlationId: { type: "string", format: "uuid" },
                actor: { type: "string" },
                timestamp: { type: "string", format: "date-time" },
                type: { type: "string" },
                metadata: { type: "object" },
              },
            },
          },
          404: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (request, reply) => {
      const accessRequest = await accessService.getRequestById(
        request.params.id,
      );
      if (!accessRequest) {
        reply.code(404);
        return { error: "Access request not found" };
      }

      const auditTrail = await accessService.getAuditTrail(request.params.id);
      return auditTrail;
    },
  );

  return server;
}

export async function startApiServer(): Promise<FastifyInstance> {
  const config = getConfig();
  const server = await createApiServer();

  try {
    await server.listen({ port: config.port, host: "0.0.0.0" });
    logger.info({ port: config.port }, "API server started");
  } catch (err) {
    logger.error(err, "Failed to start API server");
    process.exit(1);
  }

  return server;
}

// Start if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  startApiServer();
}
