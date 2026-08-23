import { describe, it, expect, beforeEach } from "bun:test";
import { InMemoryVectorStore, canonicalVpnDocument, VPN_DOCUMENT_ID, seedCanonicalDocuments, retrieveKnowledge } from "../src/index.js";
import { DocumentSchema, type Document, type WorkspaceId } from "@opnory/types";

describe("Knowledge Package - Retrieval", () => {
  let store: InMemoryVectorStore;
  const workspaceId: WorkspaceId = "opnory-internal";

  beforeEach(() => {
    store = new InMemoryVectorStore();
  });

  it("should retrieve the canonical VPN document for VPN queries", async () => {
    await store.upsert([canonicalVpnDocument]);
    
    const results = await store.search("How do I connect to the VPN on my Mac?", workspaceId, 5);
    
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].document.id).toBe(VPN_DOCUMENT_ID);
    expect(results[0].document.title).toBe("macOS VPN Connection Guide");
    expect(results[0].score).toBeGreaterThan(0.3);
    expect(results[0].matchedExcerpts.length).toBeGreaterThan(0);
  });

  it("should retrieve VPN document for partial queries", async () => {
    await store.upsert([canonicalVpnDocument]);
    
    const results = await store.search("VPN Mac GlobalProtect", workspaceId, 5);
    
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].document.id).toBe(VPN_DOCUMENT_ID);
  });

  it("should return empty results for unrelated queries", async () => {
    await store.upsert([canonicalVpnDocument]);
    
    const results = await store.search("printer setup windows", workspaceId, 5);
    expect(results.length).toBe(0);
  });

  it("should filter by relevance threshold", async () => {
    await store.upsert([canonicalVpnDocument]);
    
    const results = await store.search("VPN", workspaceId, 5);
    const filtered = results.filter((r: { score: number }) => r.score >= 0.3);
    expect(filtered.length).toBeGreaterThan(0);
  });

  it("retrieveKnowledge should return only results above threshold", async () => {
    await seedCanonicalDocuments();
    
    const results = await retrieveKnowledge("How do I connect to the VPN on my Mac?", workspaceId);
    
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].document.id).toBe(VPN_DOCUMENT_ID);
    expect(results.every(r => r.score >= 0.3)).toBe(true);
  });
});