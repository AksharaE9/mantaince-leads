import { query } from '../config/db.js';

/**
 * Check if the request is within rate limits.
 * Uses rate_limit_counters table in Aurora.
 */
export const checkRateLimit = async (userId, action, limit, windowSeconds) => {
  const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
  const bucketKey = `${action}:${userId}:${bucket}`;
  const expiresAt = new Date(Date.now() + windowSeconds * 1000);

  try {
    await query(`
      INSERT INTO rate_limit_counters (bucket_key, count, expires_at)
      VALUES ($1, 1, $2)
      ON CONFLICT (bucket_key)
      DO UPDATE SET count = rate_limit_counters.count + 1
    `, [bucketKey, expiresAt]);

    const res = await query(`
      SELECT count FROM rate_limit_counters 
      WHERE bucket_key = $1
    `, [bucketKey]);

    const count = res.rows[0]?.count || 0;
    return count <= limit;
  } catch (error) {
    console.error('Rate limiting database error (falling back to allowed):', error.message);
    return true;
  }
};

/**
 * Express middleware wrapper for rate limiting.
 */
export const rateLimiter = (action, limit, windowSeconds) => {
  return async (req, res, next) => {
    // Integration tests share one IP and re-authenticate constantly (see
    // this repo's CLAUDE.md — the admin login is reused across the whole
    // suite); a fixed-window, IP-keyed limiter would trip on test traffic
    // within minutes for reasons that have nothing to do with a real bug.
    // Same convention already used for the worker loop: disabled only under
    // NODE_ENV=test, fully active in dev/production.
    if (process.env.NODE_ENV === 'test') {
      return next();
    }
    // Use user ID (sub) if authenticated, otherwise request IP
    const userId = req.user?.sub || req.ip;
    const allowed = await checkRateLimit(userId, action, limit, windowSeconds);
    if (!allowed) {
      return res.status(429).json({ success: false, error: 'Too many requests. Please try again later.' });
    }
    next();
  };
};

export default rateLimiter;
