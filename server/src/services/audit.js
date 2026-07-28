import { query } from '../config/db.js';
import crypto from 'crypto';
import { runInBackground } from '../utils/background.js';

/**
 * Strips fields that must never be persisted into audit_logs.diff — most
 * importantly password_hash and invite_token/invite_token_expiry, since
 * audit rows are readable by roles (e.g. vertical_admin, via reports:read)
 * that should never be able to recover another account's password hash or
 * a still-live invite/reset token. Safe against null/undefined input.
 */
function redactSensitiveFields(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const clone = { ...obj };
  delete clone.password_hash;
  delete clone.invite_token;
  delete clone.invite_token_expiry;
  return clone;
}

/**
 * Log an audit trail entry.
 *
 * By default runs via runInBackground() (waitUntil-backed) instead of
 * setImmediate so the insert survives Vercel freezing/reusing the instance
 * right after the response is sent — the same failure mode runInBackground
 * was built to prevent for the upload pipeline (see utils/background.js,
 * csv.js). This is correct and intentional for routine per-request CRUD
 * audit logging, where added latency on every request is not worth it.
 *
 * Pass `awaitWrite: true` for rare, high-stakes bulk operations (e.g. the
 * duplicate-scan and promote-to-follow-ups bulk endpoints) where the audit
 * trail for that specific call must be guaranteed to exist before the
 * response returns — found necessary in practice: a short-lived caller
 * process exiting immediately after the last of several sequential bulk
 * calls lost the final call's fire-and-forget audit write entirely, since
 * nothing outside real Vercel infrastructure keeps `waitUntil()` promises
 * alive past process exit. The extra round-trip latency is negligible next
 * to these operations' own multi-second-to-minute runtime.
 */
export const logAudit = async (req, { action, targetCollection, targetId, before, after, metadata = {}, executionTimeMs = null, awaitWrite = false }) => {
  const auditId = crypto.randomUUID();

  // Determine actor
  let actorId = null;
  if (req && req.user) {
    actorId = req.user.sub;
  }

  // Capture request details
  const ip = req ? (req.ip || (req.headers ? req.headers['x-forwarded-for'] : null) || (req.socket ? req.socket.remoteAddress : null) || '') : '';

  const jobPromise = query(`
    INSERT INTO audit_logs (id, actor_id, action, target_collection, target_id, diff, ip, execution_time_ms)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [
    auditId,
    actorId || null,
    action,
    targetCollection,
    targetId ? String(targetId) : null,
    JSON.stringify({
      before: redactSensitiveFields(before),
      after: redactSensitiveFields(after),
      metadata
    }),
    String(ip).substring(0, 50),
    executionTimeMs
  ]).catch((error) => {
    console.error('❌ Failed to write audit log:', error.message);
    throw error;
  });

  if (awaitWrite) {
    await jobPromise.catch(() => {}); // already logged above; don't let a write failure break the caller
    return;
  }

  // Fire-and-forget from the caller's perspective (does not block the
  // request), but waitUntil() keeps the instance alive until it settles.
  runInBackground(jobPromise, { batchId: auditId, label: 'Audit' });
};
