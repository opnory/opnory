import { v4 as uuidv4 } from "uuid";
import { getLogger } from "@opnory/observability";
import { getVectorStore } from "@opnory/knowledge";
import { InMemoryEscalationService, InMemoryEscalationStore, EscalationReason } from "@opnory/escalation";
import {
  type NormalizedRequest,
  type AgentResponse,
  type AgentState,
  type RequestId,
  type WorkspaceId,
  type SearchResult,
  type Citation,
  type AgentOutput,
  NormalizedRequestSchema,
  AgentResponseSchema,
  AgentStateSchema,
  AgentStepSchema,
  CitationSchema,
  AgentOutputSchema,
} from "@opnory/types";

const logger = getLogger().child({ component: "agent" });

export interface AgentDependencies {
  vectorStore: ReturnType<typeof getVectorStore>;
  escalationService: InMemoryEscalationService;
}

export class OpnoryAgent {
  constructor(private readonly deps: AgentDependencies) {}

  async processRequest(request: NormalizedRequest): Promise<AgentResponse> {
    const correlationId = uuidv4();
    const traceLogger = logger.child({ 
      requestId: request.requestId, 
      workspaceId: request.workspaceId,
      correlationId 
    });

    traceLogger.info({ step: "normalize", correlationId }, "Processing request");

    // Step 1: Retrieve relevant knowledge
    traceLogger.info({ step: "retrieve", query: request.text, correlationId }, "Retrieving knowledge");
    const searchResults = await this.deps.vectorStore.search(request.text, request.workspaceId, 5);
    traceLogger.debug({ count: searchResults.length, correlationId }, "Retrieved search results");

    // Step 2: Build context from search results
    const context = this.buildContext(searchResults);
    traceLogger.debug({ contextLength: context.length, correlationId }, "Built context");

    // Step 3: Generate response using LLM (placeholder - deterministic for testing)
    traceLogger.info({ step: "reason", correlationId }, "Generating response");
    const agentOutput = await this.generateResponse(request, context, searchResults, correlationId);
    traceLogger.debug({ 
      status: agentOutput.status, 
      confidence: agentOutput.confidence, 
      correlationId 
    }, "Agent output generated");

    // Step 4: Check escalation
    traceLogger.info({ step: "decide", correlationId }, "Evaluating escalation");
    let escalationId: string | undefined;
    
    if (agentOutput.status === "escalated") {
      traceLogger.info({ reason: agentOutput.escalationReason, correlationId }, "Escalation triggered");
      const escalation = await this.deps.escalationService.createEscalation({
        requestId: request.requestId,
        workspaceId: request.workspaceId,
        reason: (agentOutput.escalationReason as EscalationReason) || "LOW_CONFIDENCE",
        context: {
          userQuestion: request.text,
          agentResponse: {
            requestId: request.requestId,
            answer: agentOutput.answer,
            citations: agentOutput.citations.map(c => ({
              documentId: c.documentId,
              excerpt: c.excerpt,
              relevanceScore: c.relevanceScore,
            })),
            confidence: agentOutput.confidence,
            shouldEscalate: true,
            escalationReason: agentOutput.escalationReason,
          },
          confidence: agentOutput.confidence,
        },
      });
      escalationId = escalation.id;
    }

    // Step 5: Return final response in AgentResponse format
    const response: AgentResponse = {
      requestId: request.requestId,
      answer: agentOutput.answer,
      citations: agentOutput.citations.map(c => ({
        documentId: c.documentId,
        excerpt: c.excerpt,
        relevanceScore: c.relevanceScore,
      })),
      confidence: agentOutput.confidence,
      shouldEscalate: agentOutput.status === "escalated",
      escalationReason: agentOutput.escalationReason,
    };

    traceLogger.info({ 
      step: "respond", 
      finalConfidence: agentOutput.confidence,
      escalationId,
      correlationId 
    }, "Request processing complete");

    return response;
  }

  private buildContext(results: SearchResult[]): string {
    if (results.length === 0) {
      return "No relevant documents found in the knowledge base.";
    }

    return results
      .map((r, i) => {
        const excerpts = r.matchedExcerpts.join(" ... ");
        return `--- DOCUMENT ${i + 1} (Relevance: ${(r.score * 100).toFixed(0)}%) ---
Title: ${r.document.title}
Source: ${r.document.source}
Content: ${r.document.content}
Matched Excerpts: ${excerpts}`;
      })
      .join("\n\n");
  }

  private async generateResponse(
    request: NormalizedRequest,
    context: string,
    searchResults: SearchResult[],
    correlationId: string
  ): Promise<AgentOutput> {
    // Deterministic response for testing - simulates grounded LLM response
    // In production, this would call an actual LLM with structured output

    // Case 1: Explicit human request
    if (this.isHumanRequest(request.text)) {
      return {
        status: "escalated",
        answer: "I'll connect you with human support right away.",
        citations: [],
        confidence: 0.0,
        escalationId: undefined,
        escalationReason: "USER_REQUESTED",
      };
    }

    // Case 2: No relevant knowledge
    if (searchResults.length === 0) {
      return {
        status: "escalated",
        answer: "I couldn't find any relevant information in the company knowledge base to answer your question. This requires human support.",
        citations: [],
        confidence: 0.1,
        escalationId: undefined,
        escalationReason: "NO_RELEVANT_DOCUMENTS",
      };
    }

    // Case 3: Low relevance (top result below threshold)
    const topResult = searchResults[0];
    if (topResult.score < 0.3) {
      return {
        status: "escalated",
        answer: "I found some potentially related documents, but they don't contain enough information to confidently answer your question. Escalating to human support.",
        citations: [],
        confidence: topResult.score * 0.5,
        escalationId: undefined,
        escalationReason: "LOW_CONFIDENCE",
      };
    }

    // Case 4: Partial knowledge - answer what we know, escalate for the rest
    const hasCompleteAnswer = this.canAnswerFully(request.text, searchResults);
    if (!hasCompleteAnswer) {
      return this.buildPartialResponse(request.text, searchResults, correlationId);
    }

    // Case 5: Full grounded answer
    return this.buildGroundedResponse(request.text, searchResults, correlationId);
  }

  private isHumanRequest(text: string): boolean {
    const humanKeywords = [
      "talk to it",
      "talk to human",
      "talk to support",
      "human support",
      "escalate",
      "contact it",
      "contact support",
      "talk to a person",
      "speak to human",
      "speak to someone",
    ];
    const lowerText = text.toLowerCase();
    return humanKeywords.some(kw => lowerText.includes(kw));
  }

  private canAnswerFully(text: string, searchResults: SearchResult[]): boolean {
    // For testing: VPN queries can be fully answered
    // Queries asking for specific codes/passwords/secrets cannot
    const lowerText = text.toLowerCase();
    const sensitiveKeywords = [
      "password",
      "bypass",
      "admin",
      "secret",
      "emergency",
      "root",
      "credential",
    ];
    return !sensitiveKeywords.some(kw => lowerText.includes(kw));
  }

  private buildPartialResponse(
    text: string,
    searchResults: SearchResult[],
    correlationId: string
  ): AgentOutput {
    const topResult = searchResults[0];
    const answer = `Based on "${topResult.document.title}", here's what I found:\n\n${topResult.matchedExcerpts[0] || "See the document for details."}\n\nHowever, I don't have information about certain specifics you asked about (like emergency bypass codes or admin passwords). For those details, you'll need to contact IT support directly.\n\n[Source: ${topResult.document.title}]`;

    const citations: Citation[] = searchResults.slice(0, 3).map(r => ({
      documentId: r.document.id,
      title: r.document.title,
      excerpt: r.matchedExcerpts[0] || "",
      relevanceScore: r.score,
      sourceUrl: r.document.sourceUrl,
    }));

    const confidence = Math.min(topResult.score * 0.8 + (searchResults.length > 1 ? 0.1 : 0), 0.9);

    return {
      status: "escalated",
      answer,
      citations,
      confidence,
      escalationId: undefined,
      escalationReason: "LOW_CONFIDENCE", // Use valid enum value
    };
  }

  private buildGroundedResponse(
    text: string,
    searchResults: SearchResult[],
    correlationId: string
  ): AgentOutput {
    const topResult = searchResults[0];
    const answer = `Based on "${topResult.document.title}", here's what I found:\n\n${topResult.matchedExcerpts[0] || "See the document for details."}\n\n[Source: ${topResult.document.title}]`;

    const citations: Citation[] = searchResults.slice(0, 3).map(r => ({
      documentId: r.document.id,
      title: r.document.title,
      excerpt: r.matchedExcerpts[0] || "",
      relevanceScore: r.score,
      sourceUrl: r.document.sourceUrl,
    }));

    const confidence = Math.min(topResult.score * 0.85 + (searchResults.length > 1 ? 0.1 : 0), 0.95);

    return {
      status: "resolved",
      answer,
      citations,
      confidence,
      escalationId: undefined,
      escalationReason: undefined,
    };
  }
}

// Factory function for production (uses module singletons)
export function createAgent(deps?: Partial<AgentDependencies>): OpnoryAgent {
  const vectorStore = deps?.vectorStore ?? getVectorStore();
  const escalationStore = new InMemoryEscalationStore();
  const escalationService = deps?.escalationService ?? new InMemoryEscalationService(escalationStore);
  
  return new OpnoryAgent({ vectorStore, escalationService });
}

let agentInstance: OpnoryAgent | null = null;

export function getAgent(): OpnoryAgent {
  if (!agentInstance) {
    agentInstance = createAgent();
    logger.info("Initialized Opnory agent");
  }
  return agentInstance;
}

export function setAgent(agent: OpnoryAgent): void {
  agentInstance = agent;
}

export { type NormalizedRequest, type AgentResponse, type AgentState, type Citation, type AgentOutput } from "@opnory/types";