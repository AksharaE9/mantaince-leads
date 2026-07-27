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
 */
export const verifyAccessToken = (token) => {
  return jwt.verify(token, JWT_ACCESS_SECRET);
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
