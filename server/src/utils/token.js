import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { JWT_ACCESS_SECRET, JWT_REFRESH_SECRET } from '../config/env.js';

/**
 * Sign an access token (expires in 15 minutes)
 * Payload: { sub: userId, role: roleName, permissions: [], verticalAccess: [] }
 */
export const signAccessToken = (user, roleName, permissions) => {
  const payload = {
    sub: String(user.id),
    role: roleName,
    permissions,
    verticalAccess: Array.isArray(user.vertical_access) ? user.vertical_access.map(v => String(v)) : []
  };
  return jwt.sign(payload, JWT_ACCESS_SECRET, { expiresIn: '15m' });
};

/**
 * Sign a refresh token (expires in 7 days)
 */
export const signRefreshToken = (userId) => {
  return jwt.sign({ sub: String(userId), jti: crypto.randomUUID() }, JWT_REFRESH_SECRET, { expiresIn: '7d' });
};

/**
 * Generate a SHA-256 hash of a token
 */
export const hashToken = (token) => {
  return crypto.createHash('sha256').update(token).digest('hex');
};

/**
 * Verify Access Token
 * Normal access tokens (see signAccessToken) never carry a `type` field —
 * only special-purpose tokens (e.g. SSE tickets, type: 'sse_ticket') do.
 * Reject anything that isn't a plain access token so single-use/SSE-only
 * tokens can't be replayed as general bearer tokens.
 */
export const verifyAccessToken = (token) => {
  const decoded = jwt.verify(token, JWT_ACCESS_SECRET);
  if (decoded && typeof decoded === 'object' && decoded.type) {
    throw new jwt.JsonWebTokenError('Invalid access token type');
  }
  return decoded;
};

/**
 * Verify Refresh Token
 */
export const verifyRefreshToken = (token) => {
  return jwt.verify(token, JWT_REFRESH_SECRET);
};

/**
 * Sign a short-lived SSE connection ticket
 */
export const signSseTicket = (userId) => {
  return jwt.sign(
    { sub: String(userId), type: 'sse_ticket', jti: crypto.randomUUID() },
    JWT_ACCESS_SECRET,
    { expiresIn: '60s' }
  );
};
