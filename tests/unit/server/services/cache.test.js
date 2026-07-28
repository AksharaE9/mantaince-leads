import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cacheGet, cacheSet, cacheDelete, cacheDeletePattern, withCache, flushL1Cache } from '../../../../server/src/services/cache.js';

describe('cache service (In-Process LRU Edition)', () => {
  beforeEach(async () => {
    await flushL1Cache();
  });

  it('caches standard query keys', async () => {
    const mockVal = { data: 'cached' };
    await cacheSet('verticals:list', mockVal, 300);
    const res = await cacheGet('verticals:list');
    expect(res).toEqual(mockVal);
  });

  it('allows caching for csv_progress keys', async () => {
    const mockVal = { progress: 50 };
    await cacheSet('csv_progress:batch-123', mockVal, 300);
    const res = await cacheGet('csv_progress:batch-123');
    expect(res).toEqual(mockVal);
  });

  it('caches with withCache and uses cached value on subsequent calls', async () => {
    const fetcher = vi.fn().mockResolvedValue({ data: 'fresh' });
    
    // First call: calls fetcher and caches
    const result1 = await withCache('verticals:list', 300, fetcher);
    expect(result1).toEqual({ data: 'fresh' });
    expect(fetcher).toHaveBeenCalledOnce();

    // Second call: retrieves from cache without calling fetcher
    const result2 = await withCache('verticals:list', 300, fetcher);
    expect(result2).toEqual({ data: 'fresh' });
    expect(fetcher).toHaveBeenCalledOnce(); // Still called only once
  });

  it('supports deleting keys', async () => {
    await cacheSet('csv_progress:batch-123', 'val1', 300);
    await cacheDelete('csv_progress:batch-123');
    const res = await cacheGet('csv_progress:batch-123');
    expect(res).toBeNull();
  });
});


