// src/utils/cache.js
// In-memory cache with TTL support and stale-while-revalidate pattern.
// Supports Redis-like interface for future migration.

/**
 * Simple in-memory cache store with TTL.
 * Production note: Replace with Redis for multi-instance deployments.
 */
class MemoryCache {
  constructor({ defaultTtlMs = 60_000, maxSize = 1000 } = {}) {
    this.store = new Map();
    this.defaultTtlMs = defaultTtlMs;
    this.maxSize = maxSize;
  }

  /**
   * Build a normalized cache key from components.
   * @param {string} prefix - Cache key prefix (e.g., "ranking:best-sellers")
   * @param {object} params - Key parameters
   * @returns {string} - Normalized cache key
   */
  static buildKey(prefix, params = {}) {
    const sorted = Object.entries(params)
      .filter(([, v]) => v != null && v !== "")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${String(v)}`)
      .join("&");
    return sorted ? `${prefix}:${sorted}` : prefix;
  }

  /**
   * Get a value from cache.
   * @param {string} key - Cache key
   * @returns {{ value: any, stale: boolean } | null}
   */
  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;

    const now = Date.now();
    const isExpired = now > entry.expiresAt;
    const isStale = now > entry.staleAt;

    if (isExpired) {
      this.store.delete(key);
      return null;
    }

    return {
      value: entry.value,
      stale: isStale,
    };
  }

  /**
   * Set a value in cache.
   * @param {string} key - Cache key
   * @param {any} value - Value to cache
   * @param {object} options - Cache options
   * @param {number} [options.ttlMs] - Time-to-live in milliseconds
   * @param {number} [options.staleMs] - Stale threshold in milliseconds (for stale-while-revalidate)
   */
  set(key, value, { ttlMs = this.defaultTtlMs, staleMs = null } = {}) {
    // Evict oldest entries if at capacity
    if (this.store.size >= this.maxSize) {
      const oldest = this.store.keys().next().value;
      if (oldest) this.store.delete(oldest);
    }

    const now = Date.now();
    const effectiveStaleMs = staleMs ?? Math.floor(ttlMs * 0.7);

    this.store.set(key, {
      value,
      createdAt: now,
      staleAt: now + effectiveStaleMs,
      expiresAt: now + ttlMs,
    });
  }

  /**
   * Delete a key from cache.
   * @param {string} key - Cache key
   * @returns {boolean} - Whether the key existed
   */
  delete(key) {
    return this.store.delete(key);
  }

  /**
   * Delete all keys matching a prefix.
   * @param {string} prefix - Key prefix to match
   * @returns {number} - Number of keys deleted
   */
  deleteByPrefix(prefix) {
    let deleted = 0;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        deleted++;
      }
    }
    return deleted;
  }

  /**
   * Clear all cache entries.
   */
  clear() {
    this.store.clear();
  }

  /**
   * Get cache stats.
   * @returns {{ size: number, maxSize: number }}
   */
  stats() {
    return {
      size: this.store.size,
      maxSize: this.maxSize,
    };
  }
}

// Redis cache state (optional)
let redisClient = null;
let redisInitPromise = null;
let redisReady = false;

function getRedisUrl() {
  return process.env.CACHE_REDIS_URL || process.env.REDIS_URL || "";
}

function buildCacheEntry(value, ttlMs, staleMs = null) {
  const now = Date.now();
  const ttl = Number(ttlMs);
  if (!Number.isFinite(ttl) || ttl <= 0) return null;

  const effectiveStaleMs =
    staleMs != null && Number.isFinite(Number(staleMs))
      ? Math.max(0, Number(staleMs))
      : Math.floor(ttl * 0.7);

  return {
    value,
    staleAt: now + effectiveStaleMs,
    expiresAt: now + ttl,
  };
}

async function getRedisClient() {
  if (redisClient && redisClient.isOpen) return redisClient;
  return null;
}

/**
 * Initialize Redis cache (optional).
 * Safe to call multiple times.
 */
export async function initRedisCache() {
  if (redisInitPromise) return redisInitPromise;

  redisInitPromise = (async () => {
    const redisUrl = getRedisUrl();
    if (!redisUrl) {
      redisReady = true;
      return { isRedis: false };
    }

    try {
      const { createClient } = await import("redis");
      redisClient = createClient({ url: redisUrl });
      redisClient.on("error", (err) => {
        console.warn("[cache] Redis client error:", String(err?.message || err));
      });

      await redisClient.connect();
      redisReady = true;
      console.info("[cache] Redis connected");
      return { isRedis: true };
    } catch (err) {
      console.warn("[cache] Redis init failed, using memory cache:", String(err?.message || err));
      redisClient = null;
      redisReady = true;
      return { isRedis: false };
    }
  })();

  return redisInitPromise;
}

// Singleton instance for ranking cache
// TTL: 60 seconds, stale after 40 seconds (allows stale-while-revalidate)
const rankingCache = new MemoryCache({
  defaultTtlMs: 60_000,
  maxSize: 500,
});

/**
 * Get cached value (Redis when available, otherwise memory).
 * @param {string} key
 * @returns {Promise<{ value: any, stale: boolean } | null>}
 */
export async function cacheGet(key) {
  if (!key) return null;

  const client = await getRedisClient();
  if (client) {
    try {
      const raw = await client.get(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;

      const now = Date.now();
      if (parsed.expiresAt && now > parsed.expiresAt) {
        client.del(key).catch(() => {});
        return null;
      }

      const stale = parsed.staleAt ? now > parsed.staleAt : false;
      return { value: parsed.value, stale: Boolean(stale) };
    } catch (err) {
      console.warn("[cache] Redis get failed, using memory cache:", String(err?.message || err));
    }
  }

  return rankingCache.get(key);
}

/**
 * Set cached value (Redis when available, otherwise memory).
 * @param {string} key
 * @param {any} value
 * @param {number} ttlMs
 * @param {number|null} [staleMs]
 */
export async function cacheSet(key, value, ttlMs, staleMs = null) {
  if (!key) return;

  const entry = buildCacheEntry(value, ttlMs, staleMs);
  if (!entry) return;

  const client = await getRedisClient();
  if (client) {
    try {
      await client.set(key, JSON.stringify(entry), { PX: Math.max(1, Number(ttlMs || 0)) });
      return;
    } catch (err) {
      console.warn("[cache] Redis set failed, using memory cache:", String(err?.message || err));
    }
  }

  rankingCache.set(key, value, { ttlMs, staleMs });
}

/**
 * Delete a cached key (Redis when available, otherwise memory).
 * @param {string} key
 */
export async function cacheDelete(key) {
  if (!key) return false;

  const client = await getRedisClient();
  if (client) {
    try {
      const res = await client.del(key);
      return res > 0;
    } catch (err) {
      console.warn("[cache] Redis delete failed, using memory cache:", String(err?.message || err));
    }
  }

  return rankingCache.delete(key);
}

/**
 * Cache wrapper with stale-while-revalidate support.
 * @param {string} key - Cache key
 * @param {Function} fetcher - Async function to fetch data if not cached
 * @param {object} options - Cache options
 * @returns {Promise<{ data: any, fromCache: boolean, stale: boolean }>}
 */
export async function withCache(key, fetcher, { ttlMs = 60_000, staleMs = null } = {}) {
  const cached = await cacheGet(key);

  if (cached && !cached.stale) {
    return { data: cached.value, fromCache: true, stale: false };
  }

  // If stale, return stale data but trigger background refresh
  if (cached && cached.stale) {
    // Fire-and-forget refresh
    setImmediate(async () => {
      try {
        const fresh = await fetcher();
        await cacheSet(key, fresh, ttlMs, staleMs);
      } catch (err) {
        console.warn(`[cache] Background refresh failed for ${key}:`, err?.message);
      }
    });

    return { data: cached.value, fromCache: true, stale: true };
  }

  // No cache, fetch fresh
  const data = await fetcher();
  await cacheSet(key, data, ttlMs, staleMs);

  return { data, fromCache: false, stale: false };
}

/**
 * Invalidate ranking cache by prefix.
 * @param {string} prefix - Cache key prefix (e.g., "ranking:best-sellers")
 */
export function invalidateRankingCache(prefix = "ranking") {
  return rankingCache.deleteByPrefix(prefix);
}

/**
 * Build a ranking cache key.
 * @param {string} endpoint - Endpoint name (e.g., "best-sellers")
 * @param {object} params - Query parameters
 * @returns {string}
 */
export function buildRankingCacheKey(endpoint, { page, limit, categoryId, lang } = {}) {
  return MemoryCache.buildKey(`ranking:${endpoint}`, { page, limit, categoryId, lang });
}

/**
 * Get cache statistics.
 */
export function getCacheStats() {
  return rankingCache.stats();
}

export { MemoryCache, rankingCache };
