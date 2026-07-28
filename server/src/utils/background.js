import { waitUntil } from '@vercel/functions';
import { query } from '../config/db.js';

/**
 * True only when the Vercel Node runtime actually installed the request-context
 * bridge waitUntil() depends on (Fluid Compute). If this is false while
 * process.env.VERCEL is set, waitUntil() silently no-ops and background work
 * gets killed the instant the response flushes — the exact bug this helper
 * exists to prevent, so it's surfaced loudly instead of failing silently.
 */
function hasWaitUntilSupport() {
    return typeof globalThis[Symbol.for('@vercel/request-context')]?.get?.()?.waitUntil === 'function';
}

/**
 * Runs a background job (CSV/Raw Data/Delivery Data bulk-import processing)
 * to completion on Vercel instead of letting the function instance freeze
 * the moment the 202 response is sent. `jobPromise` must already resolve to
 * void/ignored — this only adds keep-alive + a last-resort failure marker,
 * it never changes what the job itself does on success.
 *
 * `markFailed` runs only if `jobPromise` rejects — it should mark the batch
 * failed WITHOUT clobbering any detailed per-row `errors` the job may have
 * already written before throwing (see csvProcessor.js, which sets
 * status='failed' with per-row errors and then rethrows).
 */
export function runInBackground(jobPromise, { batchId, label }) {
    if (process.env.VERCEL && !hasWaitUntilSupport()) {
        console.error(`[${label}] waitUntil unavailable in this runtime — background job for batch ${batchId} may be killed at response time. Check the Vercel Node runtime / Fluid Compute setting for this project.`);
    }

    const guarded = jobPromise.catch(async (err) => {
        console.error(`❌ ${label} background processing failed:`, err);
        await query(
            `UPDATE csv_upload_logs
             SET status = 'failed',
                 processing_finished_at = NOW(),
                 errors = CASE WHEN errors = '[]'::jsonb OR errors IS NULL THEN $2::jsonb ELSE errors END
             WHERE id = $1 AND status <> 'failed'`,
            [batchId, JSON.stringify([{ row: 0, reason: 'The upload could not be processed. Please retry — if it keeps failing, contact support with this batch ID.' }])]
        ).catch(() => {});
    });

    waitUntil(guarded);
    return guarded;
}

/** Batches stuck at 'processing' past this long get reaped as 'failed' on next status check. */
export const STALE_PROCESSING_MINUTES = 10;

/**
 * `csv_upload_logs.processing_started_at` is a Postgres `TIMESTAMP` (no time
 * zone) column, populated by `NOW()` under a UTC session — but `pg`'s default
 * parser for that type builds the JS `Date` from the raw wall-clock
 * components using the LOCAL constructor (`new Date(y,m,d,h,mi,s,ms)`), not
 * `Date.UTC(...)`. On any machine whose local zone isn't UTC, that silently
 * shifts every value by the local offset — on this codebase's own dev
 * environment (IST, UTC+5:30) a batch inserted milliseconds ago read back as
 * ~5.5 hours old, which made this exact reaper mark it 'failed' immediately
 * (caught via a real integration-test failure, not by inspection). Same bug
 * class as the exceljs local-timezone date gotcha already documented in this
 * repo's CLAUDE.md, mirrored on the read side. Re-interpreting the same
 * wall-clock components as UTC (instead of `.getTime()` on the mis-built
 * Date) recovers the correct absolute instant regardless of server TZ.
 */
function timestampColumnToUtcMs(value) {
    const d = value instanceof Date ? value : new Date(value);
    return Date.UTC(
        d.getFullYear(), d.getMonth(), d.getDate(),
        d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()
    );
}

/**
 * Self-healing check for the "waitUntil still wasn't enough" case (maxDuration
 * exceeded, instance recycled, etc.) — there is no persistent worker on Vercel
 * to retry a stuck batch, so the only recovery point is the next time someone
 * polls its status. Idempotent; safe to call on every getCsvLogById read.
 */
export async function reapIfStale(log) {
    if (log.status !== 'processing' || !log.processing_started_at) return log;
    const startedAt = timestampColumnToUtcMs(log.processing_started_at);
    if (Date.now() - startedAt < STALE_PROCESSING_MINUTES * 60 * 1000) return log;

    const res = await query(
        `UPDATE csv_upload_logs
         SET status = 'failed',
             processing_finished_at = NOW(),
             errors = CASE WHEN errors = '[]'::jsonb OR errors IS NULL THEN $2::jsonb ELSE errors END
         WHERE id = $1 AND status = 'processing'
         RETURNING *`,
        [log.id, JSON.stringify([{ row: 0, reason: `Upload stalled for over ${STALE_PROCESSING_MINUTES} minutes and was marked failed. Please retry the upload.` }])]
    );
    return res.rows[0] || log;
}
