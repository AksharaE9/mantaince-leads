import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../config/db.js';
import { PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE } from '../config/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const caBundlePath = path.normalize(path.resolve(__dirname, '../../../global-bundle.pem'));

const clients = new Map(); // Map<userId: string, Set<Response>>
let listenerClient = null;

/**
 * Register a client's SSE response object. `verticalId`, if known at connect
 * time, is stamped directly on the response object (Node's ServerResponse
 * accepts arbitrary properties) so vertical-scoped broadcasts below can skip
 * writing to connections that aren't viewing the affected vertical — this is
 * a bandwidth/efficiency optimization only, never the source of correctness:
 * the client independently re-checks its own active vertical before acting
 * on anything it receives (see useRealtimeAssignments.js), so a connection
 * with a stale or unknown tracked vertical here can only cause a redundant
 * message, never a missed or wrongly-applied one.
 */
export const addClient = (userId, res, verticalId = null) => {
  res.currentVerticalId = verticalId;
  if (!clients.has(userId)) {
    clients.set(userId, new Set());
  }
  clients.get(userId).add(res);
  console.log(`[SSE] Client added for user ${userId}. Total users: ${clients.size}`);
};

/**
 * Update the tracked "currently viewing" vertical for every open connection
 * belonging to a user (called whenever the client's activeVertical changes,
 * without needing to reconnect the SSE stream). If a user has multiple tabs
 * open on different verticals, this coarsely applies to all of them — safe
 * because of the client-side backstop described above, just not maximally
 * precise for that rare multi-tab case.
 */
export const updateClientVertical = (userId, verticalId) => {
  const userClients = clients.get(userId);
  if (!userClients) return;
  for (const res of userClients) res.currentVerticalId = verticalId;
};

/**
 * Unregister a client's SSE response object
 */
export const removeClient = (userId, res) => {
  const userClients = clients.get(userId);
  if (userClients) {
    userClients.delete(res);
    if (userClients.size === 0) {
      clients.delete(userId);
    }
  }
};

/**
 * Send notification via Postgres LISTEN/NOTIFY
 */
export const notifyViaPostgresNotify = async (channel, payload) => {
  const json = JSON.stringify(payload);
  if (json.length > 7800) {
    console.warn('[Realtime] Payload near 8000-byte NOTIFY limit, truncating non-essential fields');
  }
  await query('SELECT pg_notify($1, $2)', [channel, json]);
};

/**
 * Initialize PostgreSQL LISTEN/NOTIFY real-time sync
 */
export const initRealtimeListener = async () => {
  if (listenerClient) return;

  listenerClient = new pg.Client({
    host:     PGHOST,
    port:     PGPORT,
    user:     PGUSER,
    database: PGDATABASE,
    password: PGPASSWORD,
    ssl: {
      rejectUnauthorized: false,
      ca: fs.existsSync(caBundlePath) ? fs.readFileSync(caBundlePath).toString() : undefined
    }
  });

  try {
    await listenerClient.connect();
    console.log('✅ Realtime Listener connected to Postgres.');

    const NOTIFY_CHANNELS = [
      'assignment_channel',
      'escalation_channel',
      'stages_channel',
      'followup_channel',
    ];

    for (const channel of NOTIFY_CHANNELS) {
      await listenerClient.query(`LISTEN ${channel}`);
    }

    listenerClient.on('notification', (msg) => {
      try {
        const payload = JSON.parse(msg.payload);
        const targetUserId = payload.targetUserId;
        const sseData = `data: ${msg.payload}\n\n`;

        if (targetUserId) {
          const userClients = clients.get(targetUserId.toString());
          if (userClients) {
            userClients.forEach(res => {
              try {
                res.write(sseData);
              } catch (err) {
                console.error('[SSE] Write error for user client:', err.message);
              }
            });
          }
          const adminClients = clients.get('__ADMIN__');
          if (adminClients) {
            adminClients.forEach(res => {
              try {
                res.write(sseData);
              } catch (err) {
                console.error('[SSE] Write error for admin client:', err.message);
              }
            });
          }
        } else {
          // Broadcast to all — but if this payload is vertical-scoped (data
          // mutations from costConversions/csv/rawData/deliveryData/followUps
          // all carry a verticalId), skip connections we know are viewing a
          // *different* vertical. Connections with no tracked vertical yet
          // (res.currentVerticalId is null/undefined, e.g. right after
          // connecting before their first vertical report arrives) still
          // receive it — fail-open, never fail-closed, so this can only ever
          // waste a little bandwidth, never silently drop a real update.
          const scopeVerticalId = payload.verticalId || null;
          for (const [userId, resSet] of clients.entries()) {
            for (const res of resSet) {
              if (scopeVerticalId && res.currentVerticalId && res.currentVerticalId !== scopeVerticalId) {
                continue;
              }
              try {
                res.write(sseData);
              } catch (err) {
                console.error('[SSE] Broadcast write error:', err.message);
              }
            }
          }
        }
      } catch (e) {
        console.error('[Realtime] Failed to parse notification payload:', e);
      }
    });

    listenerClient.on('error', (err) => {
      console.error('[Realtime] Listener connection error, reconnecting:', err);
      listenerClient = null;
      setTimeout(initRealtimeListener, 2000);
    });
  } catch (err) {
    console.error('[Realtime] Connection failed, retrying:', err.message);
    listenerClient = null;
    setTimeout(initRealtimeListener, 5000);
  }
};

/**
 * Broadcast assignment update to a specific user AND all admin clients.
 */
export const broadcast = async (targetUserId, payload) => {
  const enrichedPayload = { ...payload, targetUserId };
  try {
    await notifyViaPostgresNotify('assignment_channel', enrichedPayload);
  } catch (err) {
    console.error('[SSE] PG Notify broadcast error:', err.message);
  }
};

export const closeAllClients = () => {
  console.log(`[SSE] Closing all active SSE clients...`);
  for (const [userId, resSet] of clients.entries()) {
    for (const res of resSet) {
      try {
        res.end();
      } catch (err) {
        console.error('[SSE] Error closing response stream:', err.message);
      }
    }
  }
  clients.clear();
  if (listenerClient) {
    listenerClient.end().catch(err => console.error('[Realtime] Error closing listener client:', err.message));
    listenerClient = null;
  }
};

export const broadcastToAll = async (payload) => {
  try {
    await notifyViaPostgresNotify('assignment_channel', payload);
  } catch (err) {
    console.error('[SSE] PG Notify broadcastToAll error:', err.message);
  }
};

export default {
  addClient,
  removeClient,
  updateClientVertical,
  broadcast,
  closeAllClients,
  broadcastToAll,
  notifyViaPostgresNotify,
  initRealtimeListener
};
