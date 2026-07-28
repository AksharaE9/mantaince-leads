/**
 * Unified Cache Service — In-Process LRU Edition
 *
 * ┌─────────────────────────────────────────────────────┐
 * │  No Redis required. Uses a bounded in-process Map   │
 * │  with TTL-aware expiry and LRU eviction.            │
 * │                                                     │
 * │  Max entries : 1 000 (configurable)                 │
 * │  Key spaces  : csv_progress:*, field_configs:*,     │
 * │                v1:leads:*, v1:reports:*,            │
 * │                verticals:*, v1:vertical:*,          │
 * │                v1:sv:vertical:*                     │
 * └─────────────────────────────────────────────────────┘
 *
 * NOT shared across Vercel serverless instances — cacheDelete/
 * cacheDeletePattern only clear the instance that handled the request.
 * A previous pass wired this up to Upstash Redis for real cross-instance
 * invalidation, but the credentials in .env point at an instance that no
 * longer resolves (DNS ENOTFOUND) — reverted back to this in-process-only
 * implementation rather than ship a cache backed by a dead endpoint.
 * Re-introduce a real shared cache once a working Redis instance is
 * provisioned; until then, a revoked permission can take up to
 * CACHE_MAX_ENTRIES-bounded TTL (up to 10 minutes for attachRole's
 * permission cache) to take effect on a different warm instance.
 */

const MAX_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES) || 1_000;

// ── Internal LRU Store ────────────────────────────────────────────────────────
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

// Run expiry sweep every 60 s to prevent unbounded growth
setInterval(_evictExpired, 60_000).unref();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get a cached value.
 * Returns null on miss or expiry.
 */
export async function cacheGet(key) {
    if (!key) return null;
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
    for (const key of keys) {
        if (key) store.delete(key);
    }
}

/**
 * Delete all keys that start with a given prefix.
 */
export async function cacheDeletePattern(prefix) {
    if (!prefix) return;
    // Strip trailing '*' wildcard if present (our patterns use '*' suffix)
    const cleanPrefix = prefix.endsWith('*') ? prefix.slice(0, -1) : prefix;
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
export function flushL1Cache() {
    store.clear();
}
