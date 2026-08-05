import crypto from 'crypto';
import { query } from '../config/db.js';
import { logger } from '../lib/logger.js';
import { verifyAccessToken } from '../utils/token.js';

const MAX_LEN = 2000;
const truncate = (v) => (typeof v === 'string' && v.length > 0 ? v.slice(0, MAX_LEN) : null);

/**
 * POST /api/v1/client-errors
 *
 * Best-effort sink for the "request never reached the server" failure class
 * (network drop, DNS failure, timeout, CORS block) reported by
 * client/src/utils/networkError.js from the shared axios response
 * interceptor. Server-side request logging cannot capture this failure
 * class by definition — the request never arrived — so the client posts a
 * fire-and-forget report here instead, giving it the same
 * correlationId-traceable, persisted-report treatment every other failure
 * class in this app already has (see StandardizedErrorReporting.md).
 *
 * Deliberately does NOT require authentication via the usual `authenticate`
 * middleware: the scenario this exists for is "the client's normal
 * authenticated request just failed," so gating this behind the same auth
 * would make it unavailable exactly when it's needed (e.g. an expired
 * token mid-request, or the network drop happened during token refresh).
 * It best-effort attaches a user id if a still-valid token happens to be
 * present, but never rejects for a missing or expired one.
 */
export const reportClientError = async (req, res) => {
  let userId = null;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const decoded = verifyAccessToken(authHeader.slice(7));
      userId = decoded?.sub || null;
    } catch {
      // Expired/invalid token is exactly the kind of thing this endpoint
      // must still accept a report from — ignore and continue anonymous.
    }
  }

  const body = req.body || {};
  const correlationId = truncate(body.correlationId);
  const url = truncate(body.url);
  const method = truncate(body.method)?.toUpperCase() || null;
  const message = truncate(body.message);
  const code = truncate(body.code);
  const userAgent = truncate(req.headers['user-agent']);

  try {
    await query(
      `INSERT INTO client_error_logs
        (id, correlation_id, user_id, url, method, message, code, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [crypto.randomUUID(), correlationId, userId, url, method, message, code, userAgent]
    );
  } catch (err) {
    // Failing to persist a best-effort report must never itself become a
    // hard error the client has to handle — log and move on.
    logger.warn({ err: err.message, correlationId }, 'Failed to persist client_error_logs row');
  }

  logger.warn(
    { correlationId, url, method, message, code, userId },
    `[client-network-error] ${message || 'unknown'}`
  );

  return res.status(202).json({ success: true, data: { correlationId } });
};

export default reportClientError;
