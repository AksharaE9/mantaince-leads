import { query } from '../config/db.js';

/**
 * GET /assignments/poll
 *
 * Polling replacement for the old SSE stream (see assignmentBroadcaster.js
 * for why). Returns any realtime_events rows newer than `sinceId`, plus the
 * current max id as the client's next cursor. On the client's very first
 * call (no sinceId), returns no events — just the baseline cursor — so
 * connecting doesn't retroactively trigger a refresh for history that
 * predates the page load.
 */
export const pollRealtimeEvents = async (req, res) => {
  try {
    const sinceId = req.query.sinceId ? parseInt(req.query.sinceId, 10) : null;

    // Lazily prune old rows (~5% of calls) — this log only needs to cover
    // the polling window, not be a permanent history.
    if (Math.random() < 0.05) {
      query("DELETE FROM realtime_events WHERE created_at < NOW() - INTERVAL '2 days'").catch(err => {
        console.error('⚠️ Failed to prune old realtime_events:', err.message);
      });
    }

    if (!sinceId || Number.isNaN(sinceId)) {
      const latestRes = await query('SELECT COALESCE(MAX(id), 0) AS latest FROM realtime_events');
      return res.status(200).json({
        success: true,
        data: { latestId: Number(latestRes.rows[0].latest), events: [] }
      });
    }

    const eventsRes = await query(
      'SELECT id, type, vertical_id FROM realtime_events WHERE id > $1 ORDER BY id ASC LIMIT 200',
      [sinceId]
    );

    const latestId = eventsRes.rows.length > 0
      ? eventsRes.rows[eventsRes.rows.length - 1].id
      : sinceId;

    return res.status(200).json({
      success: true,
      data: {
        latestId: Number(latestId),
        events: eventsRes.rows.map(r => ({ type: r.type, verticalId: r.vertical_id }))
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * Bulk Assign Sub-Verticals to User (Deprecated - No-Op)
 */
export const bulkAssign = async (req, res) => {
  return res.status(200).json({
    success: true,
    data: []
  });
};

/**
 * Get current user's assigned sub-verticals (Deprecated - Returns empty array)
 */
export const getMySubVerticals = async (req, res) => {
  return res.status(200).json({
    success: true,
    data: []
  });
};
