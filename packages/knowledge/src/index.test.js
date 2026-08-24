import { describe, it, expect, beforeEach } from "bun:test";
import { InMemoryVectorStore } from "../src/index.js";
describe("Knowledge Package", () => {
    let store;
    const workspaceId = "test-workspace";
    const sampleDoc = {
        id: "550e8400-e29b-41d4-a716-446655440000",
        workspaceId,
        title: "Mac VPN Connection Guide",
        content: "To connect to the corporate VPN on Mac:\n1. Open GlobalProtect from Applications\n2. Enter portal: vpn.company.com\n3. Sign in with your SSO credentials\n4. Click Connect\n\nIf connection fails, check System Extensions in Security & Privacy settings.",
        source: "it-docs",
        sourceUrl: "https://wiki.company.com/vpn/mac",
        tags: ["vpn", "mac", "globalprotect"],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
    };
    beforeEach(() => {
        store = new InMemoryVectorStore();
    });
    it("should upsert and retrieve documents", async () => {
        await store.upsert([sampleDoc]);
        const results = await store.search("VPN Mac GlobalProtect", workspaceId, 5);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].document.id).toBe(sampleDoc.id);
        expect(results[0].score).toBeGreaterThan(0);
    });
    it("should return empty results for non-matching queries", async () => {
        await store.upsert([sampleDoc]);
        const results = await store.search("printer setup windows", workspaceId, 5);
        expect(results.length).toBe(0);
    });
    it("should filter by relevance threshold", async () => {
        await store.upsert([sampleDoc]);
        const results = await store.search("VPN", workspaceId, 5);
        const filtered = results.filter((r) => r.score >= 0.3);
        expect(filtered.length).toBeGreaterThan(0);
    });
    it("should delete documents", async () => {
        await store.upsert([sampleDoc]);
        await store.delete(["550e8400-e29b-41d4-a716-446655440000"]);
        const results = await store.search("VPN", workspaceId, 5);
        expect(results.length).toBe(0);
    });
    it("should get document by ID", async () => {
        await store.upsert([sampleDoc]);
        const doc = await store.get("550e8400-e29b-41d4-a716-446655440000");
        expect(doc).toBeDefined();
        expect(doc?.title).toBe(sampleDoc.title);
    });
});
//# sourceMappingURL=index.test.js.map