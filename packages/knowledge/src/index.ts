import { z } from "zod";
import { getLogger } from "@opnory/observability";
import {
  type Document,
  type SearchResult,
  type DocumentId,
  type WorkspaceId,
  DocumentSchema,
  SearchResultSchema,
} from "@opnory/types";

const logger = getLogger().child({ component: "knowledge" });

// Common stop words to filter from search queries
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by",
  "from", "up", "about", "into", "through", "during", "before", "after", "above", "below",
  "between", "among", "this", "that", "these", "those", "what", "which", "who", "whom",
  "whose", "where", "when", "why", "how", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could", "should", "may",
  "might", "must", "can", "need", "dare", "ought", "i", "you", "he", "she", "it", "we",
  "they", "me", "him", "her", "us", "them", "my", "your", "his", "its", "our", "their",
  "mine", "yours", "hers", "ours", "theirs",
]);

export interface VectorStore {
  upsert(documents: Document[]): Promise<void>;
  search(query: string, workspaceId: WorkspaceId, topK: number): Promise<SearchResult[]>;
  delete(documentIds: DocumentId[]): Promise<void>;
  get(documentId: DocumentId): Promise<Document | null>;
}

export class InMemoryVectorStore implements VectorStore {
  private documents = new Map<DocumentId, Document>();
  private workspaceIndex = new Map<WorkspaceId, Set<DocumentId>>();

  async upsert(documents: Document[]): Promise<void> {
    for (const doc of documents) {
      const validated = DocumentSchema.parse(doc);
      this.documents.set(validated.id, validated);

      if (!this.workspaceIndex.has(validated.workspaceId)) {
        this.workspaceIndex.set(validated.workspaceId, new Set());
      }
      this.workspaceIndex.get(validated.workspaceId)!.add(validated.id);
    }
    logger.debug({ count: documents.length }, "Upserted documents");
  }

  async search(query: string, workspaceId: WorkspaceId, topK: number): Promise<SearchResult[]> {
    const docIds = this.workspaceIndex.get(workspaceId);
    if (!docIds || docIds.size === 0) {
      return [];
    }

    const queryTerms = query.toLowerCase()
      .split(/\s+/)
      .filter(t => t.length > 2)
      .filter(t => !STOP_WORDS.has(t));
    const results: SearchResult[] = [];

    for (const docId of docIds) {
      const doc = this.documents.get(docId);
      if (!doc) continue;

      const content = (doc.title + " " + doc.content).toLowerCase();
      let score = 0;
      const matchedExcerpts: string[] = [];

      for (const term of queryTerms) {
        if (content.includes(term)) {
          score += 1;
          const idx = content.indexOf(term);
          const start = Math.max(0, idx - 100);
          const end = Math.min(content.length, idx + 200);
          matchedExcerpts.push(content.slice(start, end));
        }
      }

      if (score > 0 && queryTerms.length > 0) {
        const normalizedScore = Math.min(score / queryTerms.length, 1);
        results.push({
          document: doc,
          score: normalizedScore,
          matchedExcerpts: matchedExcerpts.slice(0, 3),
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  async delete(documentIds: DocumentId[]): Promise<void> {
    for (const id of documentIds) {
      const doc = this.documents.get(id);
      if (doc) {
        this.documents.delete(id);
        this.workspaceIndex.get(doc.workspaceId)?.delete(id);
      }
    }
    logger.debug({ count: documentIds.length }, "Deleted documents");
  }

  async get(documentId: DocumentId): Promise<Document | null> {
    return this.documents.get(documentId) || null;
  }
}

let vectorStoreInstance: VectorStore | null = null;

export function getVectorStore(): VectorStore {
  if (!vectorStoreInstance) {
    vectorStoreInstance = new InMemoryVectorStore();
    logger.info("Initialized in-memory vector store");
  }
  return vectorStoreInstance;
}

export function setVectorStore(store: VectorStore): void {
  vectorStoreInstance = store;
}

export const SEARCH_TOP_K = 5;
export const RELEVANCE_THRESHOLD = 0.3;

export async function retrieveKnowledge(
  query: string,
  workspaceId: WorkspaceId
): Promise<SearchResult[]> {
  const store = getVectorStore();
  const results = await store.search(query, workspaceId, SEARCH_TOP_K);
  const filtered = results.filter(r => r.score >= RELEVANCE_THRESHOLD);

  logger.debug(
    { query, workspaceId, totalResults: results.length, filteredCount: filtered.length },
    "Knowledge retrieval complete"
  );

  return filtered;
}

export async function indexDocument(doc: Document): Promise<void> {
  const store = getVectorStore();
  await store.upsert([doc]);
  logger.info({ documentId: doc.id, workspaceId: doc.workspaceId }, "Document indexed");
}

export async function indexDocuments(docs: Document[]): Promise<void> {
  const store = getVectorStore();
  await store.upsert(docs);
  logger.info({ count: docs.length }, "Documents indexed");
}

export { type Document, type SearchResult, type DocumentId, type WorkspaceId } from "@opnory/types";

export const VPN_DOCUMENT_ID = "550e8400-e29b-41d4-a716-446655440001";

export const canonicalVpnDocument: Document = {
  id: VPN_DOCUMENT_ID,
  workspaceId: "opnory-internal",
  title: "macOS VPN Connection Guide",
  content: `To connect to the corporate VPN on macOS:

1. Open GlobalProtect from Applications folder
2. Enter portal: vpn.company.com
3. Sign in with your SSO credentials (Okta/Entra ID)
4. Click Connect

If connection fails:
- Check System Extensions in System Settings > Privacy & Security
- Ensure GlobalProtect system extension is allowed
- Verify you have internet connectivity
- Try disconnecting and reconnecting

For split-tunnel issues, contact IT support.`,
  source: "it-docs",
  sourceUrl: "https://wiki.company.com/it/macos-vpn",
  tags: ["vpn", "macos", "globalprotect", "network"],
  createdAt: "2026-01-15T10:00:00.000Z",
  updatedAt: "2026-01-15T10:00:00.000Z",
  version: 1,
};

export async function seedCanonicalDocuments(): Promise<void> {
  const store = getVectorStore();
  await store.upsert([canonicalVpnDocument]);
  logger.info({ documentId: VPN_DOCUMENT_ID }, "Seeded canonical VPN document");
}