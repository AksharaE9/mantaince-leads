# Standardized, Persistent Error & Exception Reporting — Deliverable

**Date**: 2026-07-28
**Scope**: COS, Positives & Follow-ups, Raw Data, Delivery Data × {single add, bulk upload} plus COS's {promote-to-follow-ups, duplicate-scan}.

## 1. Step 0 audit — before state

| Section | Operation | Specific/actionable message? | Correlation ID? | Persisted report? | Downloadable? |
|---|---|---|---|---|---|
| COS | single add | Partial — hand-written 400s for known cases ("Contact number is mandatory"); generic *"An internal server error occurred"* for anything else via `sendControllerError` | ❌ None | ❌ | ❌ |
| COS | bulk upload | ✅ Good — `csvProcessor.js` already wrote structured `{row, reason}` per failed row | ❌ None | ✅ `csv_upload_logs` | ✅ `streamFailedRows` |
| COS | duplicate-scan | Generic-only via `sendControllerError` on exception; no per-failure detail on the happy path (it's a bulk flag op) | ❌ None | ❌ — only an `audit_logs` entry on success, no failure trace | ❌ |
| COS | promote | **Worst finding**: raw `res.status(500).json({ error: error.message })` — leaked driver text directly to the client | ❌ None | ❌ — per-record `errors` collected in memory, discarded after the response | ❌ |
| Positives | single add / bulk upload | Same as COS (shares `costConversions.js`/`csvProcessor.js`) | ❌ None | Bulk: ✅ / Single: ❌ | Bulk: ✅ / Single: ❌ |
| Raw Data | single add | Decent field-level detail (`{field, message}[]`) but wrapped in a generic `"Validation failed"` envelope, no code, no correlation id | ❌ None | ❌ | ❌ |
| Raw Data | bulk upload | ✅ Good, same pattern as COS bulk | ❌ None | ✅ | ✅ |
| Delivery Data | single add / bulk upload | Same as Raw Data | ❌ None | Bulk: ✅ / Single: ❌ | Bulk: ✅ / Single: ❌ |

**Cross-cutting findings**:
- Two independent, drifting implementations of the same Postgres-error-code mapping existed (`server/src/utils/dbErrors.js` and `server/src/app.js`'s global error middleware).
- `server/src/lib/logger.js` — a fully configured `pino` structured logger — was a dependency of zero files anywhere in the codebase. `console.error` was used everywhere instead: unstructured, no bound fields, no correlation mechanism.
- `global.debugErrors` (an in-memory 50-entry ring buffer) was written to in two places but read by **no route** — dead code, and would be useless on Vercel anyway (fresh process per invocation).
- `followUps.js`'s 9 other CRUD/calendar endpoints (not just promote) all had the same raw `error.message`-leak pattern.
- No `correlationId` concept existed anywhere in the app.

## 2. Standard shape — confirmed applied identically across all 4 sections

`server/src/utils/operationError.js` (new) + `server/src/utils/dbErrors.js` (enhanced in place, same exported name so all ~30 existing call sites kept working):

```js
{
  code, message, section, operation,     // section: 'cos'|'positives'|'follow_ups'|'raw_data'|'delivery_data'
  row, field, recordId,                  // operation: 'single_add'|'bulk_upload'|'promote'|'duplicate_scan'
  correlationId, timestamp,
}
```

- **Every** genuine exception across every operation now routes through `sendControllerError`, which always generates a `correlationId`, logs full `{correlationId, section, operation, code, err:{message, stack, pgCode, pgDetail}}` via `pino`, and never returns a raw stack/driver string to the client.
- The consolidated PG-error-code mapping (unique violation / invalid input / FK violation / not-null violation) lives in exactly one place now; `app.js`'s global handler and every controller catch block both delegate to it.
- One deliberate, reasoned deviation from the prompt's literal `section` enum: added a distinct `'positives'` value (the prompt's sketch only listed `'follow_ups'`) — this app's real architecture has COS and Positives sharing one table via `lead_type`, and a genuinely separate `follow_ups` entity (documented in `CLAUDE.md`); collapsing Positives into `'follow_ups'` would have made reports for the two indistinguishable.
- Scope call: single-add gets the standardized *shape* only, not a persisted report row — the prompt's own Step 2.1 says "every **bulk** operation," and a 1-row "report" for a single add would be a report about nothing (matches how `csv_upload_logs` never had rows for single-add before this either).

## 3. Persisted reporting — reused, not duplicated

Extended the **existing** `csv_upload_logs` table (chosen over a new `operation_reports` table per your answer) with one additive column: `operation_type VARCHAR(30) NOT NULL DEFAULT 'bulk_upload'` (new values: `promote`, `duplicate_scan`). Added to `checkSchemaReady()` per this repo's own documented migration gotcha.

- `promoteCosLeadsToFollowUps` and `scanCosDuplicates` now each create a report row at the start of a **real** (non-dry-run) execution and update it with final counts + the per-record errors they already collected in memory — that data no longer disappears when the response closes.
- Bulk-upload processors (`csvProcessor.js`, `rawDataProcessor.js`, `deliveryDataProcessor.js`) gained a machine-readable `code` field on every pushed error entry, alongside the existing free-text `reason`.
- `getCsvLogs` gained optional `operationType`/`entityType`/`verticalId` filters (additive — every existing caller with neither param is unaffected) so it can back a general reports list, not just "my CSV uploads."
- **New frontend page**: `client/src/pages/OperationReportsPage.jsx` at `/admin/operation-reports` (admin-only nav entry next to Audit Logs) — filterable by operation type and section, expandable per-row error detail, one-click CSV download reusing the exact blob-download logic `CsvImportModal.jsx` already had (extracted into `client/src/utils/downloadReport.js` so it's one implementation, not two).

## 4. Deliberate-failure test results (per section × operation)

Run via a new `errorAudit` command on `scripts/v4-isolated-audit.js` (same isolated-test-vertical/tagging/cleanup infrastructure as the prior audit), against the real local server/DB. **26/26 passed.**

| Section | Deliberate failure | Result |
|---|---|---|
| COS | Missing name | 400, `MISSING_REQUIRED_FIELD`, *"Business / Person / Shop / Company name is mandatory"*, `correlationId: 638cff18-8e35-4e0a-b84b-ea507acf0228` |
| COS | Duplicate phone | 409, `DUPLICATE_PHONE`, *"Phone number 81985000701 already exists in COS for this vertical"*, `correlationId: 9c60c21a-fe86-4365-8660-21932dcbf0c3` |
| COS | Oversized field → genuine DB exception | 500, `INTERNAL_ERROR`, *"An internal server error occurred"* (raw Postgres text never leaked), `correlationId: e18fb706-49fa-452e-9ae4-81b1d6c17c1c` |
| COS | Bulk upload, malformed row | Persisted report, `error.code="MISSING_REQUIRED_FIELD"`, retrievable via `GET csv/logs/:batchId` with `operation_type="bulk_upload"` |
| Positives | Missing name | 400, `MISSING_REQUIRED_FIELD`, `correlationId: fe1f55ba-38fb-4155-af78-476dd38e0a59` |
| Positives | Duplicate phone | 409, `DUPLICATE_PHONE`, *"...already exists in Positives for this vertical"*, `correlationId: dd679f88-5644-4445-ab2e-6845d3f8f714` |
| Positives | Oversized field | 500, `INTERNAL_ERROR`, `correlationId: 93a86741-b5a1-43f0-85b4-fbd0b3b54e82` |
| Positives | Bulk upload, malformed row | Persisted report, coded, retrievable |
| Raw Data | Missing business name | 422, `VALIDATION_FAILED`, *"Business Name is required"*, `correlationId: fb70c140-3b47-4f49-a5b9-5cf9d1a6e779` |
| Raw Data | Duplicate phone | 409, `DUPLICATE_PHONE`, `correlationId: 684604f4-9162-4839-b294-70b3e245133f` |
| Raw Data | Oversized field | 422, `VALIDATION_FAILED` (app-level `maxLength` check catches it before the DB — a *different*, equally valid catch point from COS; see note below), `correlationId: 4f8f34a8-284c-47fb-9b83-309683a1cc47` |
| Raw Data | Bulk upload, malformed row | Persisted report, coded, retrievable |
| Delivery Data | Missing business name | 422, `VALIDATION_FAILED`, `correlationId: c9634d6b-e612-441f-87d4-24fa210439c8` |
| Delivery Data | Duplicate phone | **Not an error by design** — Delivery Data is an event log (repeat deliveries to the same phone are expected); confirmed 201 both times, not a bug |
| Delivery Data | Oversized field | 422, `VALIDATION_FAILED`, `correlationId: dba8f51c-bbb8-441b-8819-00232304f5bb` |
| Delivery Data | Bulk upload, malformed row | Persisted report, coded, retrievable |
| Promote | Invalid `verticalId` | 400, `INVALID_FORMAT`, `correlationId: 7c9586d1-3ca0-41f5-bca9-a449d88bccd2` |
| Promote | Real run (2 leads) | `reportId: 99f2736d-...`; retrieved via `GET csv/logs/:reportId` → `operation_type: "promote"`, `status: "done"`, `success_count: 2` |
| Duplicate Scan | Invalid `verticalId` | 400, `INVALID_FORMAT`, `correlationId: 953e4364-bd21-4e7d-b8b0-1ced350ceeba` |
| Duplicate Scan | Real run (1 duplicate pair) | `reportId: 8d2083e0-...`; retrieved → `operation_type: "duplicate_scan"`, `status: "done"` |

### What failed on the first pass, and what was fixed

1. **Real bug found**: the bulk-upload status-poll cache (`csv_progress:<batchId>`, written by each processor's `emitProgress()`) didn't include `operation_type` — a client polling status shortly after a bulk upload completed (the common case) would see the DB-correct value on a *fresh* fetch but a stale/missing one from cache. Fixed by adding `operation_type: 'bulk_upload'` to all three processors' cached shape. Re-verified passing.
2. **Test-only issues, not product bugs**: the Delivery Data duplicate-phone check initially asserted a 409 that Delivery Data intentionally never returns (event log, not a uniqueness-constrained entity — documented in the code itself). The "oversized field" check assumed every section reaches the DB layer to trigger a genuine exception; Raw Data/Delivery Data actually validate field length *before* the DB (better coverage than assumed). Both were harness assertion bugs, fixed to match actual, correct product behavior; re-verified passing.

## 5. New tables/routes/dependencies

- **Schema**: 1 new column (`csv_upload_logs.operation_type`), no new tables. No new npm dependency — `pino` was already installed and configured, just unused; now imported by `dbErrors.js`, `operationError.js`, and all three bulk processors.
- **Server**: new `server/src/utils/operationError.js`; `dbErrors.js` enhanced in place; `app.js`'s global handler simplified to delegate to the same module; `costConversions.js`, `rawData.js`, `deliveryData.js`, `followUps.js`, `csv.js`, and the 3 job processors all touched (error responses + a `code` field, no behavior change to the happy path).
- **Routes**: no new routes — `getCsvLogs` extended with optional filter params; `promote-to-follow-ups`/`duplicates/scan` responses gained a `reportId` field.
- **Frontend**: new `client/src/pages/OperationReportsPage.jsx`, `client/src/api/operationReports.js`, `client/src/utils/downloadReport.js`, `client/src/utils/errorMessage.js`; new admin-gated route/nav entry at `/admin/operation-reports`; toast call sites for COS/Positives/Raw Data/Delivery Data single-add and bulk upload updated to read the new shape (with a fallback for the still-plain-string shape everywhere else in the app, so nothing else broke).

## 6. Regression & performance

- **Regression**: re-ran the full 96-check functional/real-time/promotion/template suite from the prior v4 audit against the changed codebase — **96/96 still pass**. No behavior change to any happy path.
- **Performance**: list/filter/search response times unchanged (~400-650ms, same as the pre-change baseline). `POST /promote-to-follow-ups` p50 moved from 643ms → 1003ms and p95 from 3419ms → 3711ms — a modest, expected increase from the 2 extra sequential queries (1 `INSERT` + 1 `UPDATE` for the report row) layered on top of the already-existing per-record sequential-transaction loop (a pre-existing scaling concern, not introduced here — see the earlier v4 performance audit). `POST /duplicates/scan` p50 ≈1224ms, same story. Nothing crossed into "meaningful regression" territory at the tested volume (2-3 records); the report writes are 2 lightweight queries, not a new bottleneck class.
- **Cleanup**: same isolated-test-vertical pattern as before — before/after counts on every table outside the 2 test verticals were byte-for-byte identical (`leads_other: 5446`, `follow_ups_other: 2037`, `csv_logs_other: 103` unchanged before/after; `verticals_total` dropped by exactly 2).

## Summary

96/96 regression checks pass, 26/26 deliberate-failure checks pass. One real gap found and fixed (progress-cache missing `operation_type`). Every operation in every section now returns a specific, actionable, correlation-traceable error — and every bulk-shaped operation (bulk upload, promote, duplicate-scan) now writes a persisted, retrievable, downloadable report instead of losing that data the moment the response closes.
