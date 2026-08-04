# Phone-Number-Only-Mandatory Policy — Diagnosis, Fix, and Regression Results

**Date**: 2026-08-04
**Trigger**: Delivery Data bulk upload, 55/55 rows failed with `Date is not a valid date`, `No matching employee found for "Ujwal"`, `Delivery Date is not a valid date` repeated across nearly every row.

## 1. Root cause — diagnosed with evidence, not assumed

Pulled the actual failed batch (`csv_upload_logs.errors`, batch `a7c9c72b-132d-4a20-a993-d45dbf292091`) and cross-checked against the live `users` table.

| Cause | Rows affected | Verdict |
|---|---|---|
| Date format (`Date` column, e.g. `"23-06-26"`) | 43/55 | **Our issue.** The old parser (`server/src/services/rawDataImportSchema.js`) only accepted ISO (`YYYY-MM-DD`) and `DD/MM/YYYY` with a **slash** separator and a 4-digit year. This file used dashes and, for `Date`, a 2-digit year. Genuinely valid dates, parser gap. |
| Delivery Date format (e.g. `"26-06-2026"`) | 12/55 | **Our issue**, same parser gap (dash separator, this column happened to have 4-digit years). |
| Employee match (`"Ujwal"` / `"Ujwal R"`) | 55/55 | Confirmed via `SELECT ... WHERE name ILIKE '%ujwal%'` — **zero** matching users exist. Genuinely unresolvable names, but the *design decision* to hard-block the entire row for this was ours, not a data problem — see below. Also: this vertical currently has **zero** assignable agents at all, which is the deeper reason nothing could ever match. |
| Phone number | 0/55 | Every phone in the batch was valid. Phone was never the actual problem. |
| Prior "Delivery Date optional" fix (`b34ad58`) | — | **Deployed** (confirmed live: `delivery_data.delivery_date`/`delivery_time` are nullable in the running DB). It fixed *blank* Delivery Date; it never touched *format parsing* of a present-but-differently-formatted value — a distinct bug, not a redeploy issue. |

**Conclusion**: This was overwhelmingly **our issue** — a date-parser format gap plus an all-or-nothing employee-match rule — not messy source data. Re-running the exact 55 failed rows through the fixed validator (see §4) confirms **55/55 now succeed**.

## 2. Policy change — phone number is the only mandatory field, everywhere

Applied identically across COS, Raw Data, Delivery Data, and Positives & Follow-ups:

- **Schema** (`leadImportSchema.js`, `rawDataImportSchema.js`, `deliveryDataImportSchema.js`): every field's `required` flag set to `false` except `phone`/`phoneNumber`. Confirmed this propagates automatically to template generation (`buildXlsxTemplate` reads `field.required`) and to the bulk-upload validator — both already schema-driven.
- **`csvProcessor.js` (COS/Positives)**: this is the one place the shared schema does *not* actually drive validation — it has its own hardcoded row checks. Its `if (!rawName.trim())` hard-reject was found and downgraded to a non-blocking warning to match the schema's new intent (the schema alone would **not** have changed live behavior here — confirmed by tracing the code, not assumed).
- **`createCostConversion`/`updateCostConversion` single-add** (COS/Positives controller): removed the hardcoded "Business/Person/Shop/Company name is mandatory" hard block on both create and edit.
- **`POST /cost-conversions/bulk`** (JSON-array bulk-add endpoint, separate from the CSV upload path): its `zod` schema had its own independent `name: z.string().min(1, ...)` — found and relaxed.
- **DB constraints**: `raw_data.business_name` and `delivery_data.business_name` still had `NOT NULL` left over from before — found and dropped via migration (same precedent as the earlier `delivery_date`/`delivery_time` fix). `cost_conversions.name`/`.business_name` were already nullable/defaulted to `''` at the app layer, so no migration was needed there.
- **Client forms**: removed `required`/`*` markers from Date, Employee Name, Business Name in `RawDataModal.jsx`, `DeliveryDataModal.jsx`, `LeadsPage.jsx`, `FollowUpsPositivesPage.jsx` — only Phone/Contact Number keeps one. Also removed a client-side `disabled={!assignedTo}` gate on the Raw Data/Delivery Data submit buttons that silently blocked submission without an employee selected — a client-only hard block the server-side policy never had.

## 3. Employee Name — soft match, never a hard block

`server/src/utils/employeeMatch.js` (new, shared by Raw Data and Delivery Data): `resolveEmployeeName(name, agents)` always returns `{ userId, rawName, warning? }`, never an error.

- Exact match (case/whitespace-insensitive) → resolved, no warning.
- Blank → unresolved, no warning (blank is normal now).
- Unique substring match or a single confidently-close fuzzy match (Levenshtein ≤ 2) → resolved, with a "please verify" warning.
- Ambiguous or no match at all → left unresolved (`userId: null`), with an explanatory warning + suggestions. **Never guessed.**
- The originally-typed text is always returned as `rawName` and persisted to a new `employee_name_raw` column on `raw_data`/`delivery_data`, so it's never silently lost even when unresolved.

COS/Positives never had this hard-block problem in the first place — its bulk-upload `employeeName` is descriptive free text in the `data` JSONB column, resolved to an actual `assigned_to` only via an explicit "Assign Operator" selection, a separate concept.

## 4. Date parsing — robust, and never a hard block

`parseFlexibleDate()` now handles, in order: ISO (`YYYY-MM-DD`), `DD-MM-YYYY`/`DD/MM/YYYY` (4-digit year, either separator), `DD-MM-YY`/`DD/MM/YY` (2-digit year, windowed 1970–2069), and Excel's native serial-date number (bounded `[10000, 60000)` so a bare year or small quantity is never misread as a serial date). A present-but-still-unparseable date is now a **warning**, not a hard reject — the row inserts with that field left `null`. This is a deliberate, real behavior change (previously: hard reject).

Single-add controllers (`rawData.js`, `deliveryData.js`) were also switched from handing the raw string straight to Postgres's `DATE` column (whose parsing depends on server `DateStyle` and wasn't guaranteed to agree with this app's `DD-MM-YYYY` convention) to using the same `parseFlexibleDate()` the bulk path uses — closing a latent single-add-vs-bulk inconsistency.

## 5. Re-running the original failed file — real before/after numbers

Re-ran the actual 55 failed rows (from `csv_upload_logs.errors`, not a reconstruction) through the live, fixed `validateDeliveryDataRow()`, using the real agent list for that vertical:

| | Before | After |
|---|---|---|
| Rows passing | 0/55 | **55/55** |
| Blocked by phone | 0 | **0** (phone is the only thing that can still block a row, and none were invalid) |
| Rows with a date-parse warning (non-blocking) | 55 hard-rejected | **3** (the parser fix alone resolved 52 of the original 55 date-format failures outright) |
| Rows with an employee-unresolved warning (non-blocking) | 55 hard-rejected | **55** (this vertical has 0 assignable agents registered — a separate, real finding worth flagging to whoever manages it) |

Also reproduced the exact failure shape (`23-06-26` / `26-06-2026` dates, `"Ujwal"`/`"Ujwal R"`, blank Business Name) end-to-end through the real `processDeliveryDataJob` against a disposable test vertical on the live DB — both rows insert successfully. See `scripts/diag-rerun-fixed.mjs` and `scripts/diag-regression-phone-only.mjs`.

## 6. Console errors

- **`chrome-extension://invalid`**: zero references to `chrome-extension` anywhere in this app's own `client/src` or `server/src`. Confirmed browser-extension noise, not an app bug — reproduce in an incognito window/clean profile to verify it disappears.
- **Two `401`s on a hashed resource**: `client/src/api/axios.js` already has a dual-mode refresh-token interceptor (`c8e8017`, present on this branch) that silently retries a request after a 401 by refreshing the token. DevTools still logs the *initial* 401 in red even when the retry recovers transparently — this matches the documented, already-fixed token-expiry pattern. Could not confirm the exact resource without a live Network tab/response body; if it persists as a real (non-recovering) failure, it needs to be re-investigated with that evidence.

## 7. Regression results

- **Unit**: 89/89 pass (`tests/unit`), including 2 test files rewritten to assert the new soft-warning behavior instead of the old hard-reject behavior (a deliberate, expected change, not a regression).
- **Integration** (real Neon/RDS DB): 183/183 pass (`tests/unit` + `tests/integration` combined), after updating 3 integration test files whose assertions encoded the old policy.
- **Live end-to-end regression** (`scripts/diag-regression-phone-only.mjs`, disposable test vertical, cleaned up after): 10/10 — phone-only rows insert across all 4 sections' bulk paths, invalid/missing phone still blocks, malformed dates and unmatched employees degrade to warnings and still insert, `employee_name_raw` is preserved, no crash from `NOT NULL` constraints.
- **Found and fixed along the way**: the bulk-upload status-poll cache (`csv_progress:<batchId>`) didn't include merged warnings in its `errors` array, so a client polling immediately after a "done" status (the common case) wouldn't see warnings until the 1-hour cache entry expired and fell through to the DB. Fixed across all three processors (`csvProcessor.js`, `rawDataProcessor.js`, `deliveryDataProcessor.js`) by passing the merged array to the final cache write, with the real failed-row count passed explicitly so warnings never inflate `failed_count`. Also collapsed a pre-existing duplicate `emitProgress('done', ...)` call in `deliveryDataProcessor.js`.
