import jwt from 'jsonwebtoken';
import { verifyAccessToken } from '../utils/token.js';
import { query } from '../config/db.js';
import { JWT_ACCESS_SECRET } from '../config/env.js';
import { cacheGet, cacheSet } from '../services/cache.js';

/**
 * Authentication Middleware
 * Validates the JWT Access Token in the Authorization header.
 */
export const authenticate = async (req, res, next) => {
  // Support connection ticket authentication for SSE
  if (req.query.ticket) {
    try {
      const decoded = jwt.verify(req.query.ticket, JWT_ACCESS_SECRET);
      if (decoded.type !== 'sse_ticket') {
        return res.status(401).json({ success: false, error: 'Invalid ticket type' });
      }

      // Enforce single-use by tracking in a cache pattern (60s TTL)
      const ticketKey = `sse_used_ticket:${decoded.jti || decoded.sub}:${decoded.iat}`;
      const alreadyUsed = await cacheGet(ticketKey);
      if (alreadyUsed) {
        return res.status(401).json({ success: false, error: 'SSE ticket has already been used' });
      }
      await cacheSet(ticketKey, 'true', 60);

      req.user = decoded;
      
      const vertRes = await query('SELECT id FROM verticals');
      req.user.verticalAccess = vertRes.rows.map(v => v.id);

      return next();
    } catch (error) {
      return res.status(401).json({
        success: false,
        error: 'SSE ticket invalid or expired'
      });
    }
  }

  let token = null;
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (req.query.token) {
    // Support token in query string for SSE (EventSource)
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Access token missing or invalid format'
    });
  }

  try {
    const decoded = verifyAccessToken(token);
    req.user = decoded; // Attach payload: { sub, role, permissions, verticalAccess }

    // Always grant access to all verticals to bypass vertical scoping completely
    const vertRes = await query('SELECT id FROM verticals');
    req.user.verticalAccess = vertRes.rows.map(v => v.id);

    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return res.status(401).json({
        success: false,
        error: 'Access token expired',
        code: 'TOKEN_EXPIRED'
      });
    }
    return res.status(401).json({
      success: false,
      error: 'Invalid access token'
    });
  }
};

export default authenticate;
