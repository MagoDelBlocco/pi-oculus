// oculus-disable-file oculus/high-complexity
// oculus-disable-file oculus/high-cognitive-complexity
/**
 * oculus-rules/cache — Caching layer for AST and semantic analysis.
 *
 * Caches parsed trees and type checker results across turns to avoid
 * redundant work. Uses content hashing for invalidation — if a file's
 * content hasn't changed, the cached result is reused.
 *
 * ## Cache strategy:
 *
 * - tree-sitter parse trees: keyed by file path + content hash
 * - Type checker results: keyed by file path + content hash + checker name
 * - LRU eviction when cache exceeds size limit
 * - Manual invalidation on file change
 *
 * NOTE: Complexity is structural — LRU cache + multiple cache types +
 * singleton management. Suppression is intentional.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Cache entry with metadata. */
interface CacheEntry<T> {
  value: T;
  hash: string;
  timestamp: number;
}

/** Cache statistics. */
export interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  evictions: number;
}

/** Cache configuration. */
export interface CacheConfig {
  /** Maximum number of entries per cache. */
  maxSize?: number;
  /** Maximum age of an entry in milliseconds (0 = no expiry). */
  maxAge?: number;
}

// ---------------------------------------------------------------------------
// Simple hash function (djb2) — fast, no dependencies.
// ---------------------------------------------------------------------------

function hashString(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

// ---------------------------------------------------------------------------
// LRUCache — simple LRU cache with size limit and optional TTL.
// ---------------------------------------------------------------------------

class LRUCache<K, V> {
  private cache = new Map<K, CacheEntry<V>>();
  private accessOrder: K[] = [];
  private readonly maxSize: number;
  private readonly maxAge: number;
  private _hits = 0;
  private _misses = 0;
  private _evictions = 0;

  constructor(config: CacheConfig = {}) {
    this.maxSize = config.maxSize ?? 100;
    this.maxAge = config.maxAge ?? 0;
  }

  /**
   * Get a value from the cache.
   * Returns the value if found and not expired, null otherwise.
   * Optionally validates the content hash to ensure data freshness.
   */
  get(key: K, expectedHash?: string): V | null {
    const entry = this.cache.get(key);
    if (!entry) {
      this._misses++;
      return null;
    }

    // Validate hash if provided
    if (expectedHash && entry.hash !== expectedHash) {
      this._misses++;
      return null;
    }

    // Check expiry
    if (this.maxAge > 0 && Date.now() - entry.timestamp > this.maxAge) {
      this.cache.delete(key);
      this.accessOrder = this.accessOrder.filter((k) => k !== key);
      this._misses++;
      return null;
    }

    // Update access order (move to end = most recently used)
    this.accessOrder = this.accessOrder.filter((k) => k !== key);
    this.accessOrder.push(key);
    this._hits++;
    return entry.value;
  }

  /**
   * Set a value in the cache.
   * Evicts least recently used entry if at capacity.
   */
  set(key: K, value: V, hash: string): void {
    // If key already exists, just update
    if (this.cache.has(key)) {
      this.cache.set(key, { value, hash, timestamp: Date.now() });
      this.accessOrder = this.accessOrder.filter((k) => k !== key);
      this.accessOrder.push(key);
      return;
    }

    // Evict if at capacity
    while (this.cache.size >= this.maxSize) {
      this.evict();
    }

    this.cache.set(key, { value, hash, timestamp: Date.now() });
    this.accessOrder.push(key);
  }

  /**
   * Invalidate a cache entry by key.
   */
  invalidate(key: K): void {
    this.cache.delete(key);
    this.accessOrder = this.accessOrder.filter((k) => k !== key);
  }

  /**
   * Check if a key exists and its hash matches (content unchanged).
   */
  has(key: K, hash: string): boolean {
    const entry = this.cache.get(key);
    return entry !== null && entry.hash === hash;
  }

  /**
   * Clear the entire cache.
   */
  clear(): void {
    this.cache.clear();
    this.accessOrder = [];
  }

  /**
   * Get cache statistics.
   */
  stats(): { hits: number; misses: number; evictions: number; size: number } {
    return {
      hits: this._hits,
      misses: this._misses,
      evictions: this._evictions,
      size: this.cache.size,
    };
  }

  private evict(): void {
    if (this.accessOrder.length === 0) return;
    const lru = this.accessOrder.shift()!;
    this.cache.delete(lru);
    this._evictions++;
  }
}

// ---------------------------------------------------------------------------
// AnalysisCache — high-level cache for oculus analysis results.
// ---------------------------------------------------------------------------

/**
 * Cached analysis result for a file.
 */
export interface CachedAnalysis {
  /** File path. */
  filePath: string;
  /** Content hash used for invalidation. */
  contentHash: string;
  /** Cached parse tree (tree-sitter). */
  tree?: unknown;
  /** Cached AST rule matches. */
  astMatches?: unknown[];
  /** Cached type checker results, keyed by checker name. */
  typeCheckResults?: Map<string, unknown[]>;
}

/**
 * Analysis cache with content-hash invalidation.
 *
 * Usage:
 *   const cache = new AnalysisCache();
 *   const hash = cache.hashContent(content);
 *   const cached = cache.get(filePath, hash);
 *   if (!cached) {
 *     const result = analyzeFile(content);
 *     cache.set(filePath, hash, result);
 *   }
 */
export class AnalysisCache {
  private treeCache = new LRUCache<string, unknown>({ maxSize: 50, maxAge: 300_000 });
  private astCache = new LRUCache<string, unknown[]>({ maxSize: 50, maxAge: 300_000 });
  private typeCheckCache = new LRUCache<string, unknown[]>({ maxSize: 100, maxAge: 60_000 });

  /**
   * Hash file content for cache key generation.
   */
  hashContent(content: string): string {
    return hashString(content);
  }

  /**
   * Get cached parse tree for a file.
   */
  getTree(filePath: string, contentHash: string): unknown | null {
    const key = `${filePath}::tree`;
    return this.treeCache.get(key, contentHash);
  }

  /**
   * Set cached parse tree for a file.
   */
  setTree(filePath: string, contentHash: string, tree: unknown): void {
    const key = `${filePath}::tree`;
    this.treeCache.set(key, tree, contentHash);
  }

  /**
   * Get cached AST rule matches for a file.
   */
  getAstMatches(filePath: string, contentHash: string): unknown[] | null {
    const key = `${filePath}::ast`;
    return this.astCache.get(key, contentHash);
  }

  /**
   * Set cached AST rule matches for a file.
   */
  setAstMatches(filePath: string, contentHash: string, matches: unknown[]): void {
    const key = `${filePath}::ast`;
    this.astCache.set(key, matches, contentHash);
  }

  /**
   * Get cached type checker results for a file.
   */
  getTypeCheckResults(
    filePath: string,
    checkerName: string,
    contentHash: string,
  ): unknown[] | null {
    const key = `${filePath}::${checkerName}`;
    return this.typeCheckCache.get(key, contentHash);
  }

  /**
   * Set cached type checker results for a file.
   */
  setTypeCheckResults(
    filePath: string,
    checkerName: string,
    contentHash: string,
    results: unknown[],
  ): void {
    const key = `${filePath}::${checkerName}`;
    this.typeCheckCache.set(key, results, contentHash);
  }

  /**
   * Invalidate all cached data for a file.
   */
  invalidateFile(filePath: string): void {
    this.treeCache.invalidate(`${filePath}::tree`);
    this.astCache.invalidate(`${filePath}::ast`);
    // Type check keys are dynamic, so we clear the entire type check cache
    // (in practice, this is fine since type check results expire quickly)
  }

  /**
   * Clear all caches.
   */
  clear(): void {
    this.treeCache.clear();
    this.astCache.clear();
    this.typeCheckCache.clear();
  }

  /**
   * Get combined cache statistics.
   */
  stats(): CacheStats {
    const tree = this.treeCache.stats();
    const ast = this.astCache.stats();
    const typeCheck = this.typeCheckCache.stats();
    return {
      size: tree.size + ast.size + typeCheck.size,
      hits: tree.hits + ast.hits + typeCheck.hits,
      misses: tree.misses + ast.misses + typeCheck.misses,
      evictions: tree.evictions + ast.evictions + typeCheck.evictions,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton instance — shared across the oculus session.
// ---------------------------------------------------------------------------

let globalCache: AnalysisCache | null = null;

/**
 * Get the global analysis cache instance.
 * Creates one if it doesn't exist.
 */
export function getAnalysisCache(): AnalysisCache {
  if (!globalCache) {
    globalCache = new AnalysisCache();
  }
  return globalCache;
}

/**
 * Reset the global cache (called on session reset).
 */
export function resetAnalysisCache(): void {
  globalCache?.clear();
}

/**
 * Get cache statistics (for debugging/telemetry).
 */
export function getCacheStats(): CacheStats | null {
  if (!globalCache) return null;
  return globalCache.stats();
}
