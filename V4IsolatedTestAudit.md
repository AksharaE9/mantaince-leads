# v4 Isolated-Vertical Test Audit

**Date**: 2026-07-28
**Target**: `http://localhost:5000/api/v1` (local dev server, real RDS Postgres DB — `leadsbase-db.c56mq42qi4nb.eu-north-1.rds.amazonaws.com`, same DB the deployed app uses)
**Scope**: COS, Positives & Follow-ups, Raw Data, Delivery Data — one isolated test vertical + subvertical, ~10-20 rows/section, full cleanup verified.

## 0. Skills searched and used

Searched the project's available skills for anything covering backend QA/perf auditing. None of the listed skills target a bespoke Node/Express/Postgres backend audit like this one (`webapp-testing` is Playwright-driven browser testing — not the right shape for an API-level, multi-session, DB-verified audit; `everything-claude-code:e2e-runner`/`tdd-guide` are for authoring a checked-in automated test suite, not a disposable live audit against real infra). No skill was invoked.

Instead, this repo already had the right pattern: `scripts/production-readiness-test.js` + `scripts/production-readiness-cleanup.js` (a prior 50-user/10,000-row load test) established the tagging scheme, phone-collision-safe generation, and dry-run-then-confirm cleanup convention this audit reuses at a much smaller scale, plus the integration tests under `tests/integration/api/` (`duplicateSectionIsolation`, `cosDuplicateScanAndPromote`, `realtimePoll`, `deliveryData`, `vercelInlineUpload`) for the exact request/response shapes and known edge cases. Two new scripts were written following that same convention: `scripts/v4-isolated-audit.js` (setup / functional / perf) and `scripts/v4-isolated-cleanup.js` (dry-run-by-default, `--confirm` to delete).

## 1. Setup (Step 0)

- Test vertical: `ZZ-TEST-V4AUDIT-1785252303390` (id `a2c1fb3b-cbcc-4f81-878c-7498e2b9d8f6`), subvertical `Standard`.
- Isolation vertical (second, equally isolated test vertical, used only to prove cross-vertical scoping without touching any real vertical): `ZZ-TEST-V4AUDIT-ISO-1785252303390` (id `f2364ce1-b4bb-4090-9ff4-4e92d0a60b33`).
- Every row tagged `V4AUD-1785252303390-<section>-<n>` in `businessName`/`remarks`, phone numbers built from a deterministic per-run/per-section digit prefix (zero collision risk with real data or the unrelated `LOADTEST-*` harness's phone space).
- **Cleanup script written first**, dry-run against a 4-row seed sample (one row per section) **before** generating the full test set — matched exactly 4 rows (2 `cost_conversions` [COS+Positives share the table], 1 `raw_data`, 1 `delivery_data`), nothing more. Confirmed a second time on the real run's own 4-row seed with the same exact-match result.

## 2. A real bug found, fixed, and re-verified

**Finding**: Single-add (`POST /api/v1/raw-data`, `POST /api/v1/delivery-data`) never called `broadcastToAll(...)`. Only the *bulk-upload* paths for those two sections did (`rawDataProcessor.js` / `deliveryDataProcessor.js`). Net effect: a second session would **not** see a manually-added Raw Data or Delivery Data row until it manually refreshed — real-time sync silently didn't cover the single-add path for those two sections, only for COS/Positives (`costConversions.js` already broadcasts on single create) and only for bulk uploads everywhere.

**Fix**: added `broadcastToAll({ type: 'RAW_DATA_MUTATED', verticalId, action: 'create' })` / `broadcastToAll({ type: 'DELIVERY_DATA_MUTATED', verticalId, action: 'create' })` right after the insert in `server/src/controllers/rawData.js` and `server/src/controllers/deliveryData.js` (mirroring the existing pattern in `costConversions.js`'s `createCostConversion`). Two lines + one import per file.

**Re-verified**: single-add real-time checks for Raw Data and Delivery Data both pass in the run below (428ms and 428ms server-truth latency respectively — see Performance Audit).

This fix is **uncommitted** in the working tree (`server/src/controllers/rawData.js`, `server/src/controllers/deliveryData.js`) pending your review — not committed per instructions to only commit when asked.

## 3. Full pass/fail matrix

All 96 checks below are from the clean, final run (runId `1785252303390`). An earlier dry-run of the harness itself surfaced 4 false failures from a bug in the *test harness's* assertion (it assumed `failed_count` and `duplicate_count` were mutually exclusive; the API actually reports `failed_count` inclusive of duplicates, with `duplicate_count` as an informational subset — confirmed consistent across all 4 sections: `success=13, failed=3, dup=2` where 3 = 1 genuine validation error + 2 duplicates). Fixed in the harness, not the product; re-ran clean.

### 1a. Single Add — ×4 sections

| Section | Created (201) | Fields match | Shows in own list | Absent from other 3 | 2nd session sees via realtime poll | 2nd session list fetch |
|---|---|---|---|---|---|---|
| COS | ✅ | ✅ | ✅ | ✅ (×3) | ✅ (435ms) | ✅ |
| Positives & Follow-ups | ✅ | ✅ | ✅ | ✅ (×3) | ✅ (461ms) | ✅ |
| Raw Data | ✅ | ✅ | ✅ | ✅ (×3) | ✅ (428ms, post-fix) | ✅ |
| Delivery Data | ✅ | ✅ | ✅ | ✅ (×3) | ✅ (428ms, post-fix) | ✅ |

### 1b. Bulk Upload — ×4 sections (16-row file: 12 unique valid + 1 malformed + 1 intra-file dup + 1 dup-vs-existing + 1 extra valid)

| Section | Accepted (202) | Reaches "done" | 13 valid inserted | 1 malformed rejected, structured error | Errors structured (no raw driver leak) | 2 duplicates flagged, clean message | 2nd session sees via realtime poll | No leak into other 3 sections |
|---|---|---|---|---|---|---|---|---|
| COS | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (426ms) | ✅ (×3) |
| Positives & Follow-ups | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (424ms) | ✅ (×3) |
| Raw Data | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (420ms) | ✅ (×3) |
| Delivery Data | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (398ms) | ✅ (×3) |

A phone number already used in COS's own test data was deliberately **not** reused blind across other sections in the same batch (each section's bulk file used its own phone space) — cross-section phone reuse is covered explicitly in 1c below instead, so the two concerns (intra-file/vs-existing dup detection, and cross-section non-interference) are each tested cleanly in isolation.

### 1c. Cross-Section Segregation (same phone deliberately reused across 2 sections)

| Check | Result |
|---|---|
| Shared phone accepted in COS (not falsely flagged as duplicate) | ✅ |
| Same shared phone also accepted in Raw Data (independent key space) | ✅ |
| Raw Data's list does not show the COS record with that phone | ✅ |

(COS↔Positives cross-section-with-shared-phone and the `lead_type`-scoped dedup/edit-phone fix are already covered by this repo's own `duplicateSectionIsolation.integration.test.js`, which passes against current code — not re-derived here to avoid duplicating existing coverage.)

### 1d. Promotion (COS → Follow-ups, move semantics)

| Check | Result |
|---|---|
| 3 promotable COS leads created | ✅ |
| Dry run reports `wouldFullyPromote=3`, zero `follow_ups` rows written | ✅ |
| Real run: `promoted=3` | ✅ |
| 3 `follow_ups` rows created, `status='PENDING'` | ✅ |
| COS active list no longer shows the promoted records (moved, not copied — confirmed via `duplicate_status='promoted_removed'` soft-hide, not `is_deleted`) | ✅ |
| 2nd session sees COS shrink via realtime poll (`COST_CONVERSION_MUTATED`) | ✅ (408ms) |
| 2nd session sees Follow-ups grow via realtime poll (`FOLLOWUP_CREATED`, unscoped) | ✅ (432ms) |
| Idempotency: re-running promotion on the same IDs promotes 0, reports `alreadyPromotedAndRemoved=3` | ✅ |
| Idempotency: still exactly 3 `follow_ups` rows (no duplicate) | ✅ |

Note for future readers: `tests/integration/api/cosDuplicateScanAndPromote.integration.test.js`'s promotion assertions (`wouldPromote`, `promoted`/`alreadyPromoted`, `is_deleted`) target an **older** response shape than what `promoteCosLeadsToFollowUps` actually returns today (`wouldFullyPromote`/`wouldSoftRemoveOnly`, `promoted`/`softRemovedOnly`/`alreadyPromotedAndRemoved`, and `duplicate_status` rather than `is_deleted`). That checked-in test is very likely failing/stale against current `main` — worth a follow-up, flagged here rather than silently fixed since it's outside this audit's scope.

## 4. Real-time sync deep verification (Step 2)

All mutation types × all 4 sections measured — see Performance Audit for the actual numbers (all well under the 5s target). Mechanism note: this is poll-based (`GET /api/v1/assignments/poll?sinceId=...`, 1.5s client cadence), not push/SSE (SSE was already retired — doesn't stream on Vercel).

**Cross-vertical isolation**:

| Check | Result |
|---|---|
| Event for a vertical-A mutation carries the correct, non-null `verticalId` (A, never null, never B's id) | ✅ |
| Scoping enforcement mechanism confirmed | ✅ — by design, `GET /assignments/poll` does **not** filter server-side by `verticalId` (confirmed by reading `server/src/controllers/assignments.js`: the query param is accepted but unused in the SQL). All events are visible to every polling session; **isolation is entirely client-side** in `useRealtimeAssignments.js`, which only triggers a refetch for `COST_CONVERSION_MUTATED`/`RAW_DATA_MUTATED`/`DELIVERY_DATA_MUTATED` when `evt.verticalId === activeVerticalId`. This held correctly for every event generated in this audit (all carried the right vertical). One thing worth knowing, not a bug: if a future code path ever broadcasts one of these three types with `verticalId: null`, the client's own failsafe (documented in its comments) treats a missing `verticalId` as "refresh anyway" — so isolation depends on every relevant broadcast call continuing to stamp a real vertical id, which was independently confirmed by grepping every `broadcastToAll` call site in the codebase. |

Used a second, fully isolated test vertical (rather than a real production vertical) for this check, since a read-only `verticalId` filter parameter on the poll doesn't touch data either way — this proves the exact same scoping logic with zero risk to real data.

## 5. Template accuracy round-trip (Step 3)

| Section | Template downloads (200 CSV) | Header row matches app's actual validated schema | Fresh valid row from template columns uploads with 0 unexpected errors |
|---|---|---|---|
| COS (Leads) | ✅ | ✅ (16/16 headers) | ✅ |
| Positives | — (shares Leads' template/schema endpoint by design) | — | — |
| Raw Data | ✅ | ✅ (11/11 headers) | ✅ |
| Delivery Data | ✅ | ✅ (13/13 headers) | ✅ |

## 6. Cleanup verification (Step 5) — see Performance Audit doc for the full before/after table

All 36 `cost_conversions`, 17 `raw_data`, 16 `delivery_data`, 3 `follow_ups` rows tagged for this run were removed by exact ID match; both test verticals removed. Every count for data **outside** the 2 test verticals (`leads_other`, `raw_data_other`, `delivery_data_other`, `follow_ups_other`, `csv_logs_other`) was byte-for-byte identical before and after. `verticals_total` dropped from 11 to 9 — exactly the 2 test verticals, nothing else.

## Summary

**96/96 checks passed** in the final run. One real product gap was found (missing real-time broadcast on Raw Data/Delivery Data single-add) and fixed with a 2-line change per file, then re-verified passing. One pre-existing, unrelated stale integration test was identified (not fixed, flagged for follow-up) — its assertions target a superseded response shape of the promotion endpoint.
