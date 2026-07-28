/**
 * Unified Cache Service
 *
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │  Uses Upstash Redis (REST API — works from Vercel serverless          │
 * │  functions without a persistent connection) when                     │
 * │  UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are set.           │
 * │  Falls back to a bounded in-process Map when they're not (local dev  │
 * │  without Upstash configured) or when NODE_ENV === 'test' (so the     │
 * │  unit suite never depends on a live network service).                │
 * │                                                                       │
 * │  This distinction matters in production: the in-process fallback is  │
 * │  NOT shared across Vercel serverless instances — cacheDelete/        │
 * │  cacheDeletePattern only clear the instance that handled the         │
 * │  request. Cross-instance invalidation (e.g. a revoked permission     │
 * │  taking effect immediately, not after up to 10 minutes) requires     │
 * │  the Redis path to actually be configured, which is why it's wired   │
 * │  up here rather than left as a documented-but-unused .env pair.      │
 * └───────────────────────────────────────────────────────────────────────┘
 */

import { Redis } from '@upstash/redis';

const MAX_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES) || 1_000;

const redisConfigured = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
const useRedis = redisConfigured && process.env.NODE_ENV !== 'test';

const redis = useRedis
    ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
    : null;

if (!useRedis && process.env.NODE_ENV !== 'test') {
    console.warn('[cache] UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN not set — falling back to in-process cache (NOT shared across serverless instances).');
}

// ── Redis health circuit breaker ────────────────────────────────────────────
// A misconfigured/deleted Upstash instance (bad host, expired token) must not
// turn into a per-request network timeout forever — that would silently add
// multi-second latency to every request for the lifetime of the process
// (confirmed empirically: an unreachable host added ~9s per request when
// every cache call retried the failed lookup). Probe once per process
// lifetime with a short deadline; on failure, latch to Map fallback for the
// rest of this instance's life and never touch the network again.
let redisHealthy = redis ? null : false; // null = unknown, true/false = decided
let redisHealthCheck = null;
const REDIS_PROBE_TIMEOUT_MS = 2_000;

async function redisIsHealthy() {
    if (redisHealthy !== null) return redisHealthy;
    if (!redisHealthCheck) {
        redisHealthCheck = (async () => {
            try {
                await Promise.race([
                    redis.ping(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('probe timeout')), REDIS_PROBE_TIMEOUT_MS)),
                ]);
                redisHealthy = true;
            } catch (err) {
                redisHealthy = false;
                console.error(`[cache] Upstash Redis unreachable (${err.message}) — falling back to in-process cache for the rest of this instance's lifetime.`);
            }
            return redisHealthy;
        })();
    }
    return redisHealthCheck;
}

// ── In-process fallback store ───────────────────────────────────────────────
// We use a plain Map, which preserves insertion order in V8.
// On every SET we evict the oldest entry if we're over MAX_ENTRIES.

const store = new Map(); // key → { value, expiry }

function _evictExpired() {
    const now = Date.now();
    for (const [key, entry] of store) {
        if (now > entry.expiry) store.delete(key);
    }
}

function _lruEvict() {
    if (store.size >= MAX_ENTRIES) {
        // Delete the first (oldest) entry — Map preserves insertion order
        const firstKey = store.keys().next().value;
        if (firstKey !== undefined) store.delete(firstKey);
    }
}

// Run expiry sweep every 60 s to prevent unbounded growth (fallback path only —
// harmless no-op when Redis is healthy and the Map stays empty; started
// unconditionally since Redis health isn't known synchronously at load time).
setInterval(_evictExpired, 60_000).unref();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get a cached value.
 * Returns null on miss or expiry.
 */
export async function cacheGet(key) {
    if (!key) return null;
    if (redis && await redisIsHealthy()) {
        try {
            const value = await redis.get(key);
            return value === null || value === undefined ? null : value;
        } catch (err) {
            console.error('[cache] redis get failed, treating as miss:', err.message);
            return null;
        }
    }
    const entry = store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiry) {
        store.delete(key);
        return null;
    }
    // Refresh position in Map (LRU touch)
    store.delete(key);
    store.set(key, entry);
    return entry.value;
}

/**
 * Store a value with a TTL (seconds).
 */
export async function cacheSet(key, value, ttlSeconds) {
    if (!key) return;
    if (redis && await redisIsHealthy()) {
        try {
            await redis.set(key, value, { ex: ttlSeconds });
        } catch (err) {
            console.error('[cache] redis set failed:', err.message);
        }
        return;
    }
    _lruEvict();
    store.set(key, {
        value,
        expiry: Date.now() + ttlSeconds * 1_000,
    });
}

/**
 * Delete one or more specific keys.
 */
export async function cacheDelete(...keys) {
    const valid = keys.filter(Boolean);
    if (!valid.length) return;
    if (redis && await redisIsHealthy()) {
        try {
            await redis.del(...valid);
        } catch (err) {
            console.error('[cache] redis del failed:', err.message);
        }
        return;
    }
    for (const key of valid) store.delete(key);
}

/**
 * Delete all keys that start with a given prefix.
 */
export async function cacheDeletePattern(prefix) {
    if (!prefix) return;
    // Strip trailing '*' wildcard if present (our patterns use '*' suffix)
    const cleanPrefix = prefix.endsWith('*') ? prefix.slice(0, -1) : prefix;
    if (redis && await redisIsHealthy()) {
        try {
            let cursor = 0;
            const matched = [];
            do {
                const [nextCursor, keys] = await redis.scan(cursor, { match: `${cleanPrefix}*`, count: 200 });
                matched.push(...keys);
                cursor = Number(nextCursor);
            } while (cursor !== 0);
            if (matched.length) await redis.del(...matched);
        } catch (err) {
            console.error('[cache] redis scan/del failed:', err.message);
        }
        return;
    }
    for (const key of store.keys()) {
        if (key.startsWith(cleanPrefix)) store.delete(key);
    }
}

// ── Cache-Aside Wrapper ───────────────────────────────────────────────────────

/**
 * Cache-aside pattern:
 *   1. Check cache — return hit immediately
 *   2. On miss, call fetcher(), store result, return it
 */
export async function withCache(key, ttlSeconds, fetcher) {
    const cached = await cacheGet(key);
    if (cached !== null) return cached;

    const value = await fetcher();
    await cacheSet(key, value, ttlSeconds);
    return value;
}

// ── Semantic Batch Invalidators ───────────────────────────────────────────────

/**
 * Invalidate all cache entries tied to a vertical's lead list and reports
 * when any lead is created, updated, or deleted.
 */
export async function invalidateOnLeadChange(verticalId, leadId) {
    const prefixes = [
        `v1:leads:${verticalId}:list:`,   // paginated lead list pages
        `v1:reports:${verticalId}:`,      // all report aggregations
    ];
    for (const prefix of prefixes) {
        await cacheDeletePattern(prefix + '*');
    }
    if (leadId) {
        await cacheDelete(`v1:lead:${leadId}:detail`);
    }
}

/**
 * Invalidate all cache entries tied to a vertical's taxonomy
 * when field configs, sub-verticals, or the vertical itself changes.
 */
export async function invalidateOnTaxonomyChange(verticalId) {
    const keys = [
        `field_configs:${verticalId}`,
        `v1:sv:vertical:${verticalId}`,
        `v1:vertical:${verticalId}:full`,
        'verticals:list',
    ];
    await cacheDelete(...keys);
    // Also bust any lead list pages since field configs affect column rendering
    await cacheDeletePattern(`v1:leads:${verticalId}:list:*`);
}

/**
 * Flush entire cache (testing / emergency use only).
 */
export async function flushL1Cache() {
    if (redis && await redisIsHealthy()) {
        try {
            await redis.flushdb();
        } catch (err) {
            console.error('[cache] redis flushdb failed:', err.message);
        }
    }
    // Always clear the local fallback store too, in case any entries were
    // written to it during the brief window before the health probe settled.
    store.clear();
}
