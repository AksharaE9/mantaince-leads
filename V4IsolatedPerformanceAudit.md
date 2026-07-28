# v4 Isolated-Vertical Performance Audit (Lightweight)

**Date**: 2026-07-28
**Scope**: ~10-20 rows/section inside one isolated test vertical — a small-scale sanity/perf check, explicitly **not** a repeat of the earlier 50-concurrent-user/10,000-row load test (see `PerformanceAuditReport.md` for that one; its DB/caching/frontend architecture recommendations are unaffected by this run and still apply where not superseded below).
**Targets** (per task spec): list/filter/search < ~1-2s, real-time sync latency < ~5s, bulk processing well within Vercel's execution limits.

## 1. List / filter / search response times (4 samples each, test vertical, ~15-20 rows)

| Section | Plain list (ms) | Search-filtered (ms) |
|---|---|---|
| COS (Leads) | 641, 446, 449, 420 | 496, 449, 434, 437 |
| Positives | 424, 437, 423, 431 | 429, 433, 436, 458 |
| Raw Data | 436, 435, 455, 434 | 452, 431, 440, 442 |
| Delivery Data | 1321, 638, 633, 669 | 422, 433, 445, 437 |

**Verdict: PASS against the ~1-2s target**, with a call-out. Steady-state is ~420-670ms across the board — comfortably under target, but noticeably higher in absolute terms than the prior audit's ~100-200ms (`PerformanceAuditReport.md`'s "System Test" run hit the same `localhost:5000` target). The most likely explanation, confirmed by the server's own boot log, not guessed: this environment's Postgres is `leadsbase-db.c56mq42qi4nb.eu-north-1.rds.amazonaws.com` (AWS RDS, eu-north-1) — **not** the Neon endpoint `CLAUDE.md` currently documents as "the real DB." That doc is stale on this specific point (its own header warns it's a snapshot, not living truth) and worth a quick fix. Whatever the exact cause, `GET /` (all 4 sections' list route) shows `topBottleneck: "db"` in the app's own timing instrumentation (see §4) — i.e., this is round-trip/query time, not app-layer overhead, so it isn't a code regression from v4.

**Worth watching**: Delivery Data's list is consistently ~200-900ms slower than the other three (first sample 1321ms, a cold-cache/cold-connection outlier). `createDeliveryData`/`createRawData` also run two extra lookups per request (`getAssignableAgents`, `getKnownBusinessTypes`) that COS/Positives' single-add doesn't — this plausibly explains why Raw Data/Delivery Data single-add (below) also run slower than COS/Positives. Not a regression, just consistently heavier per-request work for those two sections; fine at this volume, worth a second look if Delivery Data's list ever needs to feel as snappy as the others at higher row counts.

## 2. Single-add create latency (per section, one sample each)

| Section | ms |
|---|---|
| COS | 452 |
| Positives | 434 |
| Raw Data | 843 |
| Delivery Data | 1060 |

Same explanation as above (extra `getAssignableAgents`/`getKnownBusinessTypes` lookups for Raw Data/Delivery Data). All single-digit-second, no user-facing concern at this volume.

## 3. Bulk upload processing time (16-row file, per section: accept → poll shows "done")

| Section | Accept response (ms) | Total until "done" (ms) |
|---|---|---|
| COS | 871 | 2880 |
| Positives | 900 | 2869 |
| Raw Data | 854 | 2898 |
| Delivery Data | 861 | 2859 |

**Verdict: PASS, well within Vercel's execution limits** for the sizes tested. The ~2.86-2.9s "total until done" is dominated by the worker's own idle-poll cadence (`server/src/jobs/worker.js` sleeps 2s between queue checks when idle — so worst-case pickup latency alone is ~2s), not per-row processing cost (16 rows processed in under ~1s once picked up).

**Scope caveat, not a finding**: this measured the **local/traditional-server** code path, where `server/src/app.js` runs `startImportWorkerLoop()` in-process (confirmed in the boot log: `👷 Centralized CSV DB-backed Queue Worker Polling Loop Started...`). On Vercel, that persistent loop does not run — bulk upload uses a separate, already-tested `process.env.VERCEL` inline-processing branch (`tests/integration/api/vercelInlineUpload.integration.test.js`). This audit ran with `VERCEL` unset, so that branch wasn't exercised here; it has its own dedicated regression coverage already and wasn't a target of this pass.

## 4. Real-time sync latency (server-truth: independent 2nd session polling at 250ms from a pre-mutation cursor)

| Mutation | Section | Latency (ms) |
|---|---|---|
| Single add | COS | 435 |
| Single add | Positives | 461 |
| Single add | Raw Data | 428 *(post-fix — see Test Audit §2)* |
| Single add | Delivery Data | 428 *(post-fix — see Test Audit §2)* |
| Bulk upload | COS | 426 |
| Bulk upload | Positives | 424 |
| Bulk upload | Raw Data | 420 |
| Bulk upload | Delivery Data | 398 |
| Promotion (COS side) | COS | 408 |
| Promotion (Follow-ups side) | Follow-ups | 432 |

**Verdict: PASS, comfortably under the 5s target** — all measurements are 400-460ms of server-truth latency (event visible via the poll endpoint). Two caveats worth stating plainly, not hidden in the number:

1. This measures how fast the event becomes *visible to a session that's already polling*. The real frontend (`useRealtimeAssignments.js`) only polls every **1.5s** (`POLL_INTERVAL_MS`) plus a 200ms refresh-debounce, so worst-case real-world UI latency is closer to **~1.5-2s**, not 400ms — still well under the 5s target, but the 400ms numbers above are a floor, not what a user actually experiences.
2. Before this audit, Raw Data/Delivery Data single-add had **no realtime latency at all** (no event ever fired) — see the Test Audit's §2 finding/fix. The 428ms figures above are post-fix.

## 5. DB query / N+1 sanity check (server's own `/api/v1/admin/timing-report`, before vs. after this session)

Selected routes relevant to the 4 sections, aggregated across this server process's lifetime (includes some pre-audit noise from earlier setup calls in this same process — the per-route shape is still informative):

| Route | Requests | p50 (ms) | p95 (ms) | p99 (ms) | >500ms | Top bottleneck |
|---|---|---|---|---|---|---|
| `GET /` (list, all 4 sections combined — router-relative path, not disambiguated by the instrumentation) | 112 | 423 | 637 | 687 | 12 | `db` |
| `GET /poll` | 42 | 419 | 454 | 506 | 1 | `db` |
| `POST /` (single add, all 4 sections combined) | 32 | 762 | 1587 | 2350 | 16 | none |
| `POST /csv/upload` | 6 | 867 | 1220 | 1220 | 6 | none |
| `POST /upload` (Raw Data/Delivery Data bulk) | 8 | 859 | 888 | 888 | 8 | none |
| `GET /csv/logs/:batchId` / `GET /upload-logs/:batchId` (status poll) | 17 / 24 | 217 / 211 | 510 / 441 | 510 / 474 | 1 / 0 | `db` |
| `POST /promote-to-follow-ups` | 6 | 643 | **3419** | **3419** | 6 | `db` |

**Flagging one thing as worth watching, even though it didn't fail anything at this volume**: `POST /promote-to-follow-ups` p95 jumps to ~3.4s against a p50 of 643ms, on only 3 records per real-run call. Reading the controller (`server/src/controllers/followUps.js`, `promoteCosLeadsToFollowUps`), the "full promote" path runs one `BEGIN`/`INSERT follow_ups`/`UPDATE cost_conversions`/`COMMIT` **per record, in a sequential `for` loop** (not batched, not `Promise.all`'d) — i.e. promoting N leads costs roughly 4×N sequential DB round trips. At 3 rows this is invisible; at the batch sizes a real "bulk promote" button implies (dozens to hundreds of leads), this will scale linearly and could become the slowest operation in the app. This is the same category of issue the prior `PerformanceAuditReport.md` already flagged generically ("some controllers use sequential `await` instead of `Promise.all`") — this run gives it a concrete, measured data point. Not fixed here (out of this audit's stated scope — it audits behavior, this is a scaling recommendation for a feature that behaved correctly at the tested size), but worth prioritizing before "Promote to Follow-ups" is used on a large batch in production.

No other route showed a `topBottleneck` other than `db`/`none` (i.e., nothing pointed at an app-layer hotspot), and no route's `over500ms` count was disproportionate to its request count at this data volume — no N+1 pattern evident beyond the promotion loop above.

## 6. Cleanup — exact before/after counts (Step 5)

| Table | Deleted (this run's tagged rows) |
|---|---|
| `cost_conversions` | 36 |
| `raw_data` | 17 |
| `delivery_data` | 16 |
| `follow_ups` | 3 |
| `csv_upload_logs` | 0 *(no leftover queue rows by cleanup time)* |
| `verticals` | 2 (the 2 test verticals themselves) |

| Metric (outside the 2 test verticals) | Before | After | Unchanged? |
|---|---|---|---|
| `cost_conversions` (`leads_other`) | 5446 | 5446 | ✅ |
| `raw_data` (`raw_data_other`) | 0 | 0 | ✅ |
| `delivery_data` (`delivery_data_other`) | 0 | 0 | ✅ |
| `follow_ups` (`follow_ups_other`) | 2037 | 2037 | ✅ |
| `csv_upload_logs` (`csv_logs_other`) | 103 | 103 | ✅ |
| `verticals` (total) | 11 | 9 | ✅ (exactly -2) |

Zero impact on real data, confirmed by exact count, not spot-check.

## Overall verdict

At this scale, every measured number is inside the stated targets (list/filter/search under 2s, realtime sync under 5s, bulk processing well within serverless limits). Two things worth carrying forward, not blockers: (1) the app's baseline per-query latency (~400-650ms) reflects real network RTT to an eu-north-1 RDS instance rather than an app-layer regression — confirm `CLAUDE.md`'s Neon claim is actually current, since this run's own boot log disagrees with it; (2) `promote-to-follow-ups`'s per-record sequential-transaction loop is fine at N=3 and will not stay fine at real bulk-promote batch sizes — worth batching before it's exercised at scale.
