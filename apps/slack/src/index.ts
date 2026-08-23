import { App, ExpressReceiver } from "@slack/bolt";
import { getLogger } from "@opnory/observability";
import { loadConfig } from "@opnory/config";
import { getAccessService } from "@opnory/access-service";
import { getPool, closePool } from "@opnory/access-store-pg";
import { v4 as uuidv4 } from "uuid";
import {
  AccessRequest,
  AccessRequestStatus,
  ApprovalDecision,
  EntitlementRef,
} from "@opnory/access-types";
import { AuditEventType } from "@opnory/access-audit";

const logger = getLogger().child({ component: "slack" });

// ============================================================================
// Deterministic Manager Relationships (seeded for hardening slice)
// ============================================================================

const MANAGER_MAP: Record<string, string> = {
  "employee-a": "manager-a",
  "employee-b": "manager-a",
  "employee-c": "manager-b",
};

function getManagerFor(employeeId: string): string | undefined {
  return MANAGER_MAP[employeeId];
}

function isManagerOf(managerId: string, employeeId: string): boolean {
  return MANAGER_MAP[employeeId] === managerId;
}

// ============================================================================
// Slack User ID -> Opnory Identity Mapping
// ============================================================================

const SLACK_TO_OPNORY: Record<string, { userId: string; email: string }> = {
  "U1111111111": { userId: "employee-a", email: "employee-a@opnory.com" },
  "U2222222222": { userId: "manager-a", email: "manager-a@opnory.com" },
  "U3333333333": { userId: "employee-b", email: "employee-b@opnory.com" },
  "U4444444444": { userId: "manager-b", email: "manager-b@opnory.com" },
  "U5555555555": { userId: "employee-c", email: "employee-c@opnory.com" },
};

function resolveOpnoryIdentity(slackUserId: string): { userId: string; email: string } | undefined {
  return SLACK_TO_OPNORY[slackUserId];
}

// ============================================================================
// Approval Button Action IDs
// ============================================================================

const APPROVE_ACTION = "access_approve";
const DENY_ACTION = "access_deny";

function parseActionPayload(actionValue: string): { requestId: string; decision: "APPROVE" | "DENY" } | null {
  try {
    const parsed = JSON.parse(actionValue);
    return { requestId: parsed.r, decision: parsed.d };
  } catch {
    return null;
  }
}

function createActionValue(requestId: string, decision: "APPROVE" | "DENY"): string {
  return JSON.stringify({ r: requestId, d: decision });
}

// ============================================================================
// Block Kit Message Builder
// ============================================================================

function buildApprovalMessage(request: AccessRequest): any[] {
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "🔐 Access Request Pending Approval",
        emoji: true,
      },
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Requester:*\n${request.requesterEmail} (${request.requesterId})`,
        },
        {
          type: "mrkdwn",
          text: `*Entitlement:*\n${request.entitlement.name}`,
        },
      ],
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*System:*\n${request.entitlement.system}`,
        },
        {
          type: "mrkdwn",
          text: `*Duration:*\n90 days`,
        },
      ],
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Policy:*\nManager approval required`,
        },
        {
          type: "mrkdwn",
          text: `*Reason:*\n${request.reason}`,
        },
      ],
    },
    {
      type: "divider",
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "✅ Approve",
            emoji: true,
          },
          style: "primary",
          action_id: APPROVE_ACTION,
          value: createActionValue(request.id, "APPROVE"),
        },
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "❌ Deny",
            emoji: true,
          },
          style: "danger",
          action_id: DENY_ACTION,
          value: createActionValue(request.id, "DENY"),
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Request ID: \`${request.id}\` | Only the assigned manager can approve.`,
        },
      ],
    },
  ];
}

function buildApprovalResultMessage(request: AccessRequest, approverEmail: string, approved: boolean): any[] {
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: approved ? "✅ Access Request Approved" : "❌ Access Request Denied",
        emoji: true,
      },
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Requester:*\n${request.requesterEmail}`,
        },
        {
          type: "mrkdwn",
          text: `*Entitlement:*\n${request.entitlement.name}`,
        },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Decided by:* ${approverEmail}\n*Status:* ${request.status}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Request ID: \`${request.id}\``,
        },
      ],
    },
  ];
}

function buildUnauthorizedApprovalMessage(requestId: string, reason: string): any[] {
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "🚫 Unauthorized Approval Attempt",
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `You are not authorized to approve this request.\n\n*Reason:* ${reason}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Request ID: \`${requestId}\``,
        },
      ],
    },
  ];
}

function buildErrorMessage(error: string): any[] {
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "⚠️ Error Processing Approval",
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: error,
      },
    },
  ];
}

// ============================================================================
// Slack App Setup
// ============================================================================

export async function startSlackApp(): Promise<App> {
  const config = loadConfig();
  
  // Use ExpressReceiver for web server
  const receiver = new ExpressReceiver({
    signingSecret: config.slack.signingSecret,
    endpoints: {
      commands: "/slack/commands",
      events: "/slack/events",
      interactions: "/slack/interactions",
    },
  });

  const app = new App({
    receiver,
    token: config.slack.botToken,
  });

  // Store for request-to-channel mapping (in production, use Redis/DB)
  const requestChannelMap = new Map<string, { channelId: string; threadTs: string }>();

  // ============================================================================
  // Slash Command: /access-request
  // ============================================================================
  app.command("/access-request", async ({ command, ack, respond, client }) => {
    await ack();

    const slackIdentity = resolveOpnoryIdentity(command.user_id);
    if (!slackIdentity) {
      await respond({
        text: "❌ Your Slack identity is not mapped to an Opnory user. Please contact IT.",
        response_type: "ephemeral",
      });
      return;
    }

    // Parse command text: /access-request "Engineering Contributor" "Need access to repo X"
    const text = command.text.trim();
    const match = text.match(/"([^"]+)"\s*"([^"]+)"/);
    if (!match) {
      await respond({
        text: "Usage: `/access-request \"Entitlement Name\" \"Reason for access\"`",
        response_type: "ephemeral",
      });
      return;
    }

    const [, entitlementName, reason] = match;

    try {
      const accessService = getAccessService();
      const request = await accessService.createAccessRequest({
        requesterId: slackIdentity.userId,
        requesterEmail: slackIdentity.email,
        entitlementIdOrName: entitlementName,
        reason,
        metadata: {
          slackUserId: command.user_id,
          slackChannelId: command.channel_id,
        },
      });

      // Send approval request to the manager
      const managerId = getManagerFor(slackIdentity.userId);
      if (!managerId) {
        await respond({
          text: "❌ No manager assigned for your account. Please contact IT.",
          response_type: "ephemeral",
        });
        return;
      }

      const managerSlackId = Object.entries(SLACK_TO_OPNORY).find(
        ([, v]) => v.userId === managerId
      )?.[0];

      if (!managerSlackId) {
        await respond({
          text: "❌ Manager not found in Slack. Please contact IT.",
          response_type: "ephemeral",
        });
        return;
      }

      // Open DM with manager and send approval request
      const dm = await client.conversations.open({ users: managerSlackId });
      if (!dm.channel || !dm.channel.id) {
        await respond({
          text: "❌ Could not open DM with manager.",
          response_type: "ephemeral",
        });
        return;
      }

      const blocks = buildApprovalMessage(request);
      const msg = await client.chat.postMessage({
        channel: dm.channel.id,
        blocks,
        text: `Access request from ${slackIdentity.email} for ${entitlementName}`,
      });

      // Store mapping for response handling
      requestChannelMap.set(request.id, {
        channelId: dm.channel.id,
        threadTs: msg.ts || "",
      });

      await respond({
        text: `✅ Access request submitted! Your manager (${managerId}) has been notified.`,
        response_type: "ephemeral",
      });

      logger.info({ requestId: request.id, requester: slackIdentity.userId }, "Access request created via Slack");
    } catch (error) {
      logger.error({ error, userId: slackIdentity.userId }, "Error creating access request");
      await respond({
        text: `❌ Error: ${error instanceof Error ? error.message : "Unknown error"}`,
        response_type: "ephemeral",
      });
    }
  });

  // ============================================================================
  // Interactive Components: Approval Buttons
  // ============================================================================
  app.action(APPROVE_ACTION, async ({ action, ack, respond, client, body }) => {
    await ack();

    const slackIdentity = resolveOpnoryIdentity(body.user.id);
    if (!slackIdentity) {
      await respond({
        replace_original: true,
        blocks: buildErrorMessage("Your Slack identity is not mapped to an Opnory user."),
      });
      return;
    }

    // Type narrowing for BlockAction
    if (!("value" in action) || !action.value) {
      await respond({
        replace_original: true,
        blocks: buildErrorMessage("Invalid action payload."),
      });
      return;
    }

    const parsed = parseActionPayload(action.value);
    if (!parsed) {
      await respond({
        replace_original: true,
        blocks: buildErrorMessage("Invalid action payload."),
      });
      return;
    }

    const { requestId, decision } = parsed;

    // Verify the Slack user is the assigned manager
    const accessService = getAccessService();
    const request = await accessService.getRequestById(requestId);
    if (!request) {
      await respond({
        replace_original: true,
        blocks: buildErrorMessage("Access request not found."),
      });
      return;
    }

    const requiredManagerId = getManagerFor(request.requesterId);
    if (!requiredManagerId || requiredManagerId !== slackIdentity.userId) {
      await respond({
        replace_original: true,
        blocks: buildUnauthorizedApprovalMessage(requestId, "You are not the assigned manager for this request."),
      });
      // Audit the unauthorized attempt
      await accessService.auditUnauthorizedApprovalAttempt(requestId, slackIdentity.userId);
      return;
    }

    try {
      const correlationId = uuidv4();
      const approvalDecision: ApprovalDecision = {
        decision: "APPROVE",
        approverId: slackIdentity.userId,
        approverEmail: slackIdentity.email,
        reason: "Approved via Slack",
        timestamp: new Date().toISOString(),
      };

      const updatedRequest = await accessService.decideAccessRequest(requestId, approvalDecision, correlationId);

      // Update the message to show result
      await respond({
        replace_original: true,
        blocks: buildApprovalResultMessage(updatedRequest, slackIdentity.email, true),
      });

      // Notify requester
      const requesterSlackId = Object.entries(SLACK_TO_OPNORY).find(
        ([, v]) => v.userId === request.requesterId
      )?.[0];
      if (requesterSlackId) {
        try {
          await client.chat.postMessage({
            channel: requesterSlackId,
            text: `✅ Your access request for *${request.entitlement.name}* has been *approved* by ${slackIdentity.email}!`,
          });
        } catch (notifyErr) {
          logger.warn({ error: notifyErr }, "Failed to notify requester");
        }
      }

      logger.info({ requestId, approver: slackIdentity.userId }, "Access request approved via Slack");
    } catch (error) {
      logger.error({ error, requestId, approver: slackIdentity.userId }, "Error approving request");
      await respond({
        replace_original: true,
        blocks: buildErrorMessage(`Error: ${error instanceof Error ? error.message : "Unknown error"}`),
      });
    }
  });

  app.action(DENY_ACTION, async ({ action, ack, respond, client, body }) => {
    await ack();

    const slackIdentity = resolveOpnoryIdentity(body.user.id);
    if (!slackIdentity) {
      await respond({
        replace_original: true,
        blocks: buildErrorMessage("Your Slack identity is not mapped to an Opnory user."),
      });
      return;
    }

    // Type narrowing for BlockAction
    if (!("value" in action) || !action.value) {
      await respond({
        replace_original: true,
        blocks: buildErrorMessage("Invalid action payload."),
      });
      return;
    }

    const parsed = parseActionPayload(action.value);
    if (!parsed) {
      await respond({
        replace_original: true,
        blocks: buildErrorMessage("Invalid action payload."),
      });
      return;
    }

    const { requestId, decision } = parsed;

    // Verify the Slack user is the assigned manager
    const accessService = getAccessService();
    const request = await accessService.getRequestById(requestId);
    if (!request) {
      await respond({
        replace_original: true,
        blocks: buildErrorMessage("Access request not found."),
      });
      return;
    }

    const requiredManagerId = getManagerFor(request.requesterId);
    if (!requiredManagerId || requiredManagerId !== slackIdentity.userId) {
      await respond({
        replace_original: true,
        blocks: buildUnauthorizedApprovalMessage(requestId, "You are not the assigned manager for this request."),
      });
      // Audit the unauthorized attempt
      await accessService.auditUnauthorizedApprovalAttempt(requestId, slackIdentity.userId);
      return;
    }

    try {
      const correlationId = uuidv4();
      const approvalDecision: ApprovalDecision = {
        decision: "DENY",
        approverId: slackIdentity.userId,
        approverEmail: slackIdentity.email,
        reason: "Denied via Slack",
        timestamp: new Date().toISOString(),
      };

      const updatedRequest = await accessService.decideAccessRequest(requestId, approvalDecision, correlationId);

      // Update the message to show result
      await respond({
        replace_original: true,
        blocks: buildApprovalResultMessage(updatedRequest, slackIdentity.email, false),
      });

      // Notify requester
      const requesterSlackId = Object.entries(SLACK_TO_OPNORY).find(
        ([, v]) => v.userId === request.requesterId
      )?.[0];
      if (requesterSlackId) {
        try {
          await client.chat.postMessage({
            channel: requesterSlackId,
            text: `❌ Your access request for *${request.entitlement.name}* has been *denied* by ${slackIdentity.email}.`,
          });
        } catch (notifyErr) {
          logger.warn({ error: notifyErr }, "Failed to notify requester");
        }
      }

      logger.info({ requestId, approver: slackIdentity.userId }, "Access request denied via Slack");
    } catch (error) {
      logger.error({ error, requestId, approver: slackIdentity.userId }, "Error denying request");
      await respond({
        replace_original: true,
        blocks: buildErrorMessage(`Error: ${error instanceof Error ? error.message : "Unknown error"}`),
      });
    }
  });

  // ============================================================================
  // Slash Command: /access-status
  // ============================================================================
  app.command("/access-status", async ({ command, ack, respond }) => {
    await ack();

    const slackIdentity = resolveOpnoryIdentity(command.user_id);
    if (!slackIdentity) {
      await respond({
        text: "❌ Your Slack identity is not mapped to an Opnory user.",
        response_type: "ephemeral",
      });
      return;
    }

    const accessService = getAccessService();
    const requests = await accessService.getRequestsByRequester(slackIdentity.userId);

    if (requests.length === 0) {
      await respond({
        text: "You have no access requests.",
        response_type: "ephemeral",
      });
      return;
    }

    const blocks = requests.map((req) => ({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${req.entitlement.name}* (${req.status})\n${req.reason}`,
      },
    }));

    await respond({
      blocks: [
        { type: "header", text: { type: "plain_text", text: "📋 Your Access Requests" } },
        ...blocks,
      ],
      response_type: "ephemeral",
    });
  });

  // Start the receiver (Express server)
  const port = config.port + 1; // Use port+1 for Slack
  await receiver.start(port);

  logger.info({ port }, "Slack app started");
  return app;
}

// Graceful shutdown
process.on("SIGTERM", async () => {
  logger.info("SIGTERM received, closing Slack app...");
  await closePool();
  process.exit(0);
});

process.on("SIGINT", async () => {
  logger.info("SIGINT received, closing Slack app...");
  await closePool();
  process.exit(0);
});