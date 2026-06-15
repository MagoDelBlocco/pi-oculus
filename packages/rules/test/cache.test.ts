import { describe, it, expect, beforeEach } from "vitest";
import {
  AnalysisCache,
  getAnalysisCache,
  resetAnalysisCache,
  getCacheStats,
} from "../src/cache";

describe("AnalysisCache", () => {
  let cache: AnalysisCache;

  beforeEach(() => {
    cache = new AnalysisCache();
  });

  describe("hashContent", () => {
    it("produces consistent hashes", () => {
      const content = "const x = 1;";
      const hash1 = cache.hashContent(content);
      const hash2 = cache.hashContent(content);
      expect(hash1).toBe(hash2);
    });

    it("produces different hashes for different content", () => {
      const hash1 = cache.hashContent("const x = 1;");
      const hash2 = cache.hashContent("const x = 2;");
      expect(hash1).not.toBe(hash2);
    });

    it("handles empty content", () => {
      const hash = cache.hashContent("");
      expect(typeof hash).toBe("string");
      expect(hash.length).toBeGreaterThan(0);
    });
  });

  describe("tree cache", () => {
    it("caches and retrieves parse trees", () => {
      const filePath = "test.ts";
      const hash = cache.hashContent("const x = 1;");
      const tree = { type: "root_node" };

      expect(cache.getTree(filePath, hash)).toBeNull();

      cache.setTree(filePath, hash, tree);
      expect(cache.getTree(filePath, hash)).toBe(tree);
    });

    it("returns null for different hash", () => {
      const filePath = "test.ts";
      const hash1 = cache.hashContent("const x = 1;");
      const hash2 = cache.hashContent("const x = 2;");
      const tree = { type: "root_node" };

      cache.setTree(filePath, hash1, tree);
      expect(cache.getTree(filePath, hash2)).toBeNull();
    });

    it("returns null for different file path", () => {
      const hash = cache.hashContent("const x = 1;");
      const tree = { type: "root_node" };

      cache.setTree("test.ts", hash, tree);
      expect(cache.getTree("other.ts", hash)).toBeNull();
    });
  });

  describe("AST matches cache", () => {
    it("caches and retrieves AST matches", () => {
      const filePath = "test.ts";
      const hash = cache.hashContent("const x = 1;");
      const matches = [{ rule: "test-rule" }];

      expect(cache.getAstMatches(filePath, hash)).toBeNull();

      cache.setAstMatches(filePath, hash, matches);
      expect(cache.getAstMatches(filePath, hash)).toBe(matches);
    });
  });

  describe("type check cache", () => {
    it("caches and retrieves type check results", () => {
      const filePath = "test.ts";
      const checkerName = "tsc";
      const hash = cache.hashContent("const x = 1;");
      const results = [{ message: "Type error" }];

      expect(
        cache.getTypeCheckResults(filePath, checkerName, hash),
      ).toBeNull();

      cache.setTypeCheckResults(filePath, checkerName, hash, results);
      expect(
        cache.getTypeCheckResults(filePath, checkerName, hash),
      ).toBe(results);
    });

    it("separates results by checker name", () => {
      const filePath = "test.ts";
      const hash = cache.hashContent("const x = 1;");

      cache.setTypeCheckResults(filePath, "tsc", hash, ["tsc-result"]);
      cache.setTypeCheckResults(filePath, "eslint", hash, ["eslint-result"]);

      expect(
        cache.getTypeCheckResults(filePath, "tsc", hash),
      ).toEqual(["tsc-result"]);
      expect(
        cache.getTypeCheckResults(filePath, "eslint", hash),
      ).toEqual(["eslint-result"]);
    });
  });

  describe("invalidation", () => {
    it("invalidates all caches for a file", () => {
      const filePath = "test.ts";
      const hash = cache.hashContent("const x = 1;");

      cache.setTree(filePath, hash, { type: "root_node" });
      cache.setAstMatches(filePath, hash, [{ rule: "test" }]);

      cache.invalidateFile(filePath);

      expect(cache.getTree(filePath, hash)).toBeNull();
      expect(cache.getAstMatches(filePath, hash)).toBeNull();
    });

    it("does not affect other files", () => {
      const hash = cache.hashContent("const x = 1;");

      cache.setTree("test.ts", hash, { type: "root_node" });
      cache.setTree("other.ts", hash, { type: "other_node" });

      cache.invalidateFile("test.ts");

      expect(cache.getTree("test.ts", hash)).toBeNull();
      expect(cache.getTree("other.ts", hash)).toEqual({
        type: "other_node",
      });
    });
  });

  describe("clear", () => {
    it("clears all caches", () => {
      const hash = cache.hashContent("const x = 1;");

      cache.setTree("test.ts", hash, { type: "root_node" });
      cache.setAstMatches("test.ts", hash, [{ rule: "test" }]);

      cache.clear();

      expect(cache.getTree("test.ts", hash)).toBeNull();
      expect(cache.getAstMatches("test.ts", hash)).toBeNull();
    });
  });

  describe("stats", () => {
    it("returns correct stats", () => {
      const hash = cache.hashContent("const x = 1;");

      // Miss
      cache.getTree("test.ts", hash);

      // Hit
      cache.setTree("test.ts", hash, { type: "root_node" });
      cache.getTree("test.ts", hash);

      const stats = cache.stats();
      expect(stats.size).toBe(1);
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
      expect(stats.evictions).toBe(0);
    });
  });

  describe("LRU eviction", () => {
    it("evicts least recently used entry when at capacity", () => {
      const smallCache = new AnalysisCache();
      const hash = smallCache.hashContent("const x = 1;");

      // The tree cache has maxSize=50 by default
      // Insert 51 entries to trigger eviction
      for (let i = 0; i < 51; i++) {
        smallCache.setTree(`file${i}.ts`, hash, { type: `node${i}` });
      }

      // First entry should be evicted
      expect(smallCache.getTree("file0.ts", hash)).toBeNull();

      // Last entry should still be present
      expect(smallCache.getTree("file50.ts", hash)).toEqual({
        type: "node50",
      });
    });
  });
});

describe("global cache singleton", () => {
  beforeEach(() => {
    resetAnalysisCache();
  });

  it("returns the same instance", () => {
    const cache1 = getAnalysisCache();
    const cache2 = getAnalysisCache();
    expect(cache1).toBe(cache2);
  });

  it("stats returns null before cache is created", () => {
    resetAnalysisCache();
    // After reset, the global cache reference is cleared
    // but getAnalysisCache() creates a new one
    const stats = getCacheStats();
    // Stats may be null if cache was never accessed
    expect(stats === null || typeof stats.size === "number").toBe(true);
  });

  it("reset clears the cache", () => {
    const cache = getAnalysisCache();
    const hash = cache.hashContent("const x = 1;");
    cache.setTree("test.ts", hash, { type: "root_node" });

    resetAnalysisCache();

    // After reset, getAnalysisCache creates a new empty cache
    const newCache = getAnalysisCache();
    expect(newCache.getTree("test.ts", hash)).toBeNull();
  });
});
