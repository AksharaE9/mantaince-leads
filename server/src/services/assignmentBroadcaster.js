import { query } from '../config/db.js';

/**
 * Real-time sync change log (polling-based).
 *
 * SSE was the original transport, but server/vercel.json's legacy
 * `builds`/`routes` @vercel/node config never actually streams responses —
 * Vercel buffers the whole function invocation, so an SSE handler that
 * intentionally never calls res.end() delivers zero bytes to the client no
 * matter how correct the broadcast logic is (confirmed empirically: a live
 * SSE connection against production received nothing — not the connection
 * ack, not the heartbeat, not a real broadcast event — while a control
 * request against a known-working public SSE feed from the same machine
 * worked instantly).
 *
 * Replacement: every mutation that used to call broadcastToAll() still does
 * — same call sites, same payload shape — but broadcastToAll() now inserts
 * a row into `realtime_events` instead of pg_notify. Clients poll
 * GET /assignments/poll?sinceId=... (see controllers/assignments.js) and
 * apply the same vertical-scoping logic client-side that useRealtimeAssignments.js
 * already had. Low-volume by design: callers already broadcast once per
 * completed operation/batch, not per row.
 */
export const broadcastToAll = async (payload) => {
  try {
    const type = payload?.type;
    const verticalId = payload?.verticalId || null;
    if (!type) return;
    await query(
      'INSERT INTO realtime_events (type, vertical_id) VALUES ($1, $2)',
      [type, verticalId]
    );
  } catch (err) {
    console.error('[Realtime] broadcastToAll insert error:', err.message);
  }
};

/**
 * Kept for escalations.js, which notifies via a plain Postgres NOTIFY
 * channel independent of the realtime_events polling log above (escalation
 * alerts were never wired into the client's real-time handler either way —
 * out of scope for the leads/raw-data/delivery-data sync fix). Harmless
 * no-listener no-op if nothing is LISTENing on the channel.
 */
export const notifyViaPostgresNotify = async (channel, payload) => {
  const json = JSON.stringify(payload);
  if (json.length > 7800) {
    console.warn('[Realtime] Payload near 8000-byte NOTIFY limit, truncating non-essential fields');
  }
  await query('SELECT pg_notify($1, $2)', [channel, json]);
};

export default {
  broadcastToAll,
  notifyViaPostgresNotify,
};
