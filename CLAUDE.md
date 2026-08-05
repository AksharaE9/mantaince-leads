# CLAUDE.md — Session Context for This Repository

This file exists so future Claude Code sessions don't have to re-derive
architecture facts that took real investigation to establish. Read this
before making changes.

## Repository reality check (do this before trusting folder names)

This repo contains **four** app-shaped directories, but only two are live:

- `server/` + `client/` — **the real, deployed app.** Express + raw `pg`
  (Postgres) on the backend, Vite/React on the frontend. Root
  `package.json`'s `dev`/`dev:server`/`dev:client` scripts only ever touch
  these two.
- `backend/` + `frontend/` — **orphaned duplicates.** Each has its own
  `package.json` and `node_modules`, but nothing in the root scripts,
  `docker-compose.yml`, or `vercel.json` ever runs them. Do not "fix bugs"
  in these unless the user explicitly asks about them by path — they're not
  what users hit in production.
- `server/src/lib/prisma.js` and the `prisma`/`mongoose` npm dependencies
  are dead code from a past migration off Prisma/Mongo onto raw `pg` +
  Postgres. The `MongoDB Compatibility Helper` (`mapIdToUnderscoreId`) in
  `server/src/app.js` is a leftover shim from that era, still active because
  the frontend still reads `_id`/camelCase in places.
- `docker-compose.yml` spins up Mongo + Redis, neither of which the live
  app's primary datastore actually uses (Postgres, via Neon, is the real
  DB — see `PGHOST` in `server/.env`). Caching goes through Upstash Redis
  (`server/src/services/cache.js`), not the docker-compose Redis.

**Neon SSL on Vercel** — `server/src/config/db.js` uses `rejectUnauthorized: false`
(the default) for the Neon PgBouncer pooler endpoint. Passing an explicit `ca`
cert does NOT work — it replaces Node's entire trusted CA store so the intermediate
certs (Let's Encrypt YR1/YR2) go missing and the handshake still fails. Neon
explicitly recommends `rejectUnauthorized: false` for their `-pooler` endpoints on
serverless runtimes (the connection is still TLS-encrypted; only chain verification
is skipped). To enable full cert verification for a direct RDS instance, set
`PGSSL_REJECT_UNAUTHORIZED=true` in Vercel's environment variables. Set
`PGSSL=false` to disable SSL entirely (local dev without SSL server).

**Before believing any of the above has changed, verify against
`server/src/app.js` (route mounts) and `server/src/config/db.js`
(migrations) — this file is a snapshot, not a live source of truth.**

## The "Leads" module is internally called `costConversions`

`/api/v1/leads` is a router alias (see `server/src/app.js`) for
`costConversionsRouter` (`server/src/routes/costConversions.js` →
`server/src/controllers/costConversions.js`). The DB table is
`cost_conversions`. This naming split is historical; don't be surprised
when "Leads" work touches files with "CostConversion" in the name.

`lead_type` on `cost_conversions` distinguishes CALL / FIELD / POSITIVE
rows — "Positives & Follow-ups" (`client/src/pages/FollowUpsPositivesPage.jsx`)
is the *same* create-new-lead pipeline as the main Leads page, just with
`leadType=POSITIVE` fixed and a different field mapping. It is **not** a
separate "update existing lead's outcome" feature — that's a common wrong
assumption. The actual per-lead follow-up log (a truly separate entity:
`follow_ups` table, `server/src/routes/followUps.js`) only has single-record
CRUD, no bulk import.

## DB migrations: inline, idempotent, and gated by a readiness check

There's no migration tool/files — `server/src/config/db.js`'s
`runMigrations()` runs a big block of `CREATE TABLE IF NOT EXISTS` /
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` on every `connectDB()` call.

**Critical gotcha:** `checkSchemaReady()` (same file) gates the *entire*
migration block behind a handful of hardcoded column-existence checks. If
you add a new table/column to the migration DDL but don't also add a check
for it in `checkSchemaReady()`, your migration will **silently never run**
against any database that already passes the existing checks — the code
will look correct and simply never execute. Always add your new
table/column to that readiness check when you add DDL.

## Duplicate detection is scoped to vertical + sub-vertical + lead_type (2026-08-05)

COS/Positives duplicate checks (single add, bulk upload, edit, and the
`/api/v1/leads/bulk` JSON endpoint) are scoped to the exact
`(vertical_id, sub_vertical_id, lead_type, phone)` combination — **not**
just `vertical_id`. It used to be vertical-only, which incorrectly blocked
uploading the same phone into a second, different sub-vertical under the
same parent vertical (confirmed root cause of a reported "upload silently
blocked" bug — the same data uploaded fine to one sub-vertical, then looked
silently rejected in another). Sub-verticals are independent sections for
duplicate purposes, consistent with this app's existing strict
section-level isolation elsewhere (COS/Raw Data/Delivery Data are
independent; COS/Positives are independent via `lead_type` despite sharing
one table — see the dedicated `duplicateSectionIsolation.integration.test.js`
and `subverticalDuplicateScoping.integration.test.js`). A genuine duplicate
rejection now also names the specific conflicting record (business name)
in its error message, not just "a duplicate exists somewhere". The manual,
opt-in "Find & Remove Duplicates" admin tool (`scanCosDuplicates`) was
deliberately left vertical-wide, not changed to sub-vertical-scoped — it
exists specifically to catch cross-sub-vertical accidental duplicates an
admin wants consolidated, a different purpose from the auto-block on
create/upload.

## Bulk import architecture (Leads, Positives, Raw Data)

Three features share one pipeline, built up over several sessions:

- `server/src/services/spreadsheetParser.js` — format-agnostic file
  parsing (CSV via `csv-parse`, `.xlsx`/`.xls` via `exceljs`). Returns
  `{ rows, warnings }` with **original header casing preserved** (don't
  re-lowercase here — a past bug did this and corrupted the
  downloadable error report's header text; case-insensitive matching
  happens downstream in each processor's own `normalizeRowKeys`).
  Handles the UTF-8 BOM, `\r\n`/`\n`, blank rows, merged cells, and
  formula-result cells correctly (verified empirically, not assumed —
  see git history for the specific edge-case tests).
  **Date cells**: exceljs builds `Date` objects using the *server's local
  timezone*, not UTC. Always read them back with local getters
  (`getFullYear()`/`getMonth()`/`getDate()`), never `.toISOString()` — the
  latter silently rolls the date back a day for any timezone ahead of UTC
  (this bit us once already; see `cellToString()` in that file).
- `server/src/services/leadImportTemplate.js` — `buildXlsxTemplate(schema,
  agentNames, sampleValues)`, fully generic: any field-schema array in the
  `{key,label,csvHeader,type,required,options}` shape produces a styled
  `.xlsx` with header/sample rows and dropdown validation. A field with
  `key === 'employeeName'` automatically gets an agent-name dropdown.
- `server/src/utils/dbErrors.js` — `sendControllerError(res, error,
  context)` maps known Postgres error codes to clean 4xx responses instead
  of leaking raw driver errors as bare 500s. Use this in every controller
  catch block for new features.
- `server/src/db/bulkInsert.js` — generic chunked parameterized INSERT
  helper (`bulkInsert(db, table, columns, rows, opts)`), already used by
  both Leads bulk-create and the Raw Data processor.
- Per-entity schema + validator modules (`leadImportSchema.js`,
  `rawDataImportSchema.js`) are **not** merged into one generic schema —
  each entity's fixed fields, required-ness, and business rules differ
  enough that forcing one shape would obscure more than it'd save. What
  *is* shared is the file-parsing/template/error-handling/insert
  machinery above.
- `csv_upload_logs` is the shared queue table for **all** bulk-upload
  entities, discriminated by an `entity_type` column (`'lead'` default,
  `'raw_data'` for Raw Data). `server/src/jobs/worker.js`'s polling loop
  dispatches to `csvProcessor.js#processCsvJob` or
  `rawDataProcessor.js#processRawDataJob` based on that column. The
  `getCsvLogs`/`getCsvLogById`/`streamFailedRows` endpoints
  (`server/src/controllers/csv.js`) are entity-agnostic (key off
  `batchId`, not `entity_type`) and are reused as-is by the Raw Data
  routes — don't duplicate them for a future entity either.
- **The background worker loop does not run when `NODE_ENV=test`** (see
  the guard in `server/src/app.js` and `worker.js`). Integration tests that
  need a queued job actually processed must call the processor function
  directly (`processCsvJob`/`processRawDataJob`) with a hand-built job
  object, the same shape `worker.js` constructs — see
  `tests/integration/api/rawData.integration.test.js` for the pattern.
- `client/src/components/CsvImportModal.jsx` is the **one** shared
  bulk-upload UI (file picker, template download, client-side preview,
  upload+poll, results, error report). It's parameterized via an
  `endpoints` prop (defaults point at the Leads routes) plus
  `showSubVertical`/`showAssignOperator` flags so a new feature can reuse
  it by passing different endpoint-building functions rather than forking
  the component. `client/src/components/RawDataModal.jsx` shows the
  pattern for a feature that needs "bulk upload" but not "sub-vertical
  selection" or "assign one operator to every row".

## RBAC

Permissions are plain strings in `roles.permissions` (a Postgres
`TEXT[]`), not a fixed enum in code — `checkPermission(key)` just checks
`role.permissions.includes(key)` (or the `'*'` wildcard). **Inventing a
new permission string for a new feature means every existing role is
locked out of it until someone manually updates the DB** — there's no
migration path that auto-grants new permission keys to existing roles.
When a new feature is "the same access level as X", reuse X's exact
permission keys (as Raw Data does with `leads:create`, `leads:read`/
`leads:read_own`, `csv:upload`, `csv:template`, `csv:logs`) rather than
minting new ones, unless the user explicitly wants a distinct permission
tier (in which case, flag that a role needs to be granted it before the
feature is usable).

`attachRole` caches the resolved role/permissions per user for 10 minutes
(`user_profile:<id>` cache key) — a permission change to a role won't take
effect for an already-logged-in user until that cache expires or they
re-authenticate.

## Test environment quirks (spend your effort elsewhere)

- **Root and `client/` have separate, non-hoisted `node_modules` with
  different major React versions** (root: React 19, `client/`: React 18).
  `vitest.config.js` aliases `react`/`react-dom` to root's copies so
  simple, dependency-free component tests work
  (`tests/unit/client/components/EmployeeDropdown.test.jsx` is the
  reference example). But **any component that imports something living
  only in `client/node_modules`** (lucide-react, zustand, react-router-dom,
  react-hot-toast, xlsx, …) crashes with "Invalid hook call" / "A React
  Element from an older version of React was rendered" — two live React
  copies in one render tree. This is a real, pre-existing structural gap,
  confirmed by direct experimentation (see git history around the Raw Data
  feature's test commit), not a one-off flake. Full-page RTL render tests
  (`LeadsPage`, `FollowUpsPositivesPage`, etc.) are **not currently
  feasible** without either monorepo-hoisting the dependency trees or
  mocking away every third-party import in the tree (rapidly not worth
  it). Prefer: (a) pure-logic unit tests for anything schema/validator
  shaped, (b) `supertest` integration tests against the real Express app
  for anything server-side, (c) structural/source-level checks for "does
  this JSX exist in the right place" rather than a full render, until this
  gets fixed properly.
- Integration tests hit the **real, live Neon Postgres DB** (not a
  disposable test container) — `tests/setup/globalSetup.js` claims to
  point at a different RDS host and run `prisma migrate deploy` +
  `TRUNCATE`, but that's dead config left over from the Prisma era; it
  silently no-ops (wrapped in try/catch) against the actual DB
  `server/src/config/db.js` connects to. **There is no automatic test-data
  cleanup mechanism** — every integration test must create its own
  disposable fixtures (a uniquely-named vertical is the usual pattern) and
  delete them in `afterAll`. Verify manually after a session that no stray
  test verticals/rows are left behind (`SELECT name FROM verticals WHERE
  name LIKE '%Test%'` is a quick check).
- The admin login used across integration tests: `admin@gmail.com` /
  `admin123` (super_admin role, has `'*'` permission wildcard).

## Known intentional product decisions (Raw Data feature)

- Template column "Adress" (source file typo) is displayed as **"Address"**
  and "Area " (trailing space) as **"Area"** — corrected, since this is a
  freshly-generated dynamic template rather than a legacy file field staff
  have memorized. See `DISPLAY_ADRESS_AS_TYPO` in
  `server/src/services/rawDataImportSchema.js` if this needs reverting.
- Business Type has no canonical enum anywhere in this app — treated as
  free text; new values are accepted and returned as a `warnings` entry
  (not rejected), so an admin can formalize an enum later if the observed
  values justify it.
- "Appointment Date before Date" is a **warning**, not a hard reject — no
  existing business-rule precedent to confirm a hard block is correct.
- Employee Name always resolves to a real user id (never stored as free
  text); ambiguous or unresolvable names are rejected with suggested
  closest matches (Levenshtein-ranked), never silently guessed.

## The two production domains are correct, deployed, and NOT a CORS bug (2026-08-05)

A user reported a browser console CORS error (`Access-Control-Allow-Origin`
missing + `net::ERR_FAILED`) blocking a CSV upload from
`mantaince-leads.vercel.app` calling `mantaince-leads-sqvw.vercel.app`. This
looks exactly like a stale-alias/wrong-domain bug and was investigated as
one. **It is not one — do not "fix" it by touching `server/src/app.js`'s
CORS allow-list or the client's `VITE_API_URL` without new evidence.**
Verified live, same day:
- `mantaince-leads.vercel.app` (frontend) and `mantaince-leads-sqvw.vercel.app`
  (backend) are two separate, legitimate Vercel projects — the app's real,
  working architecture, confirmed via the client's own built bundle
  (`baseURL: "https://mantaince-leads-sqvw.vercel.app"`).
- A live preflight AND a live actual request (including a deliberately
  unauthenticated 401 response) both returned the correct
  `Access-Control-Allow-Origin: https://mantaince-leads.vercel.app` header.
  CORS works on error responses too, not just success.
- The allow-list entry for `mantaince-leads.vercel.app` in `app.js`'s `cors()`
  origin callback has been there, unchanged, since commit `49da26f` (11 Jun
  2026) — not a recent regression.
- `/health`'s `commitSha` on the live backend matched local `HEAD` exactly
  at investigation time — production was not running stale code.

The console dump also contained a literal `net::ERR_INTERNET_DISCONNECTED`
line — real evidence of a client-machine connectivity drop during that
session. Chrome is known to report network-layer failures on cross-origin
requests using the same "blocked by CORS policy" wording as a genuine CORS
rejection, since JS can't distinguish the two cases (opaque failure either
way). The most likely explanation is a one-off local network blip, not a
code bug.

**What was a real, fixed bug**: regardless of what caused any specific
instance, the app had no handling at all for "request never reached the
server" (no `err.response`) — every existing `err.response?.data?.error ||
fallback` call site silently fell through to a generic string, and
`CsvImportModal.jsx`'s result-view state machine never even reached that
fallback (it rendered nothing at all — see `git log` around 2026-08-05 for
the fix). See `client/src/utils/networkError.js` and the axios response
interceptor in `client/src/api/axios.js` for the fix: every no-response
failure now gets a correlationId, a specific user-facing message, client-side
logging, and a best-effort persisted report via `POST /api/v1/client-errors`
→ `client_error_logs` — the one place this failure class is ever recorded,
since the server-side request/error logging everywhere else in this app
cannot capture a request that never arrived.

**Re-verified a second time same day**, after a report the identical CORS
error recurred on a *different* endpoint (Positives import) plus a new
`auth/refresh` 401 — this looked like the first fix "shipped to the wrong
call site only." It wasn't: the client has exactly one `axios.create`/
`baseURL` in the whole codebase (`client/src/api/axios.js`), and
`authStore.js`'s `refreshToken()` correctly imports that shared instance —
no wrong-domain reference anywhere to have missed. The recurrence is fully
explained by the *previous* fix (the paragraph above) having sat committed
but unpushed between sessions — confirmed directly, not inferred, since the
working tree still had it uncommitted when this was re-checked. Pushed as
commit `14f5b3c`.

**Re-verified a third time same day**, this time with a raw `OPTIONS`
preflight test using the *exact* header set the real browser sends
(`Authorization, Content-Type, X-Request-ID` — the axios request
interceptor adds `X-Request-ID` to every call) against every mutating
endpoint reachable cross-origin, plus explicit trailing-slash and
attacker-subdomain rejection checks. All correct. `auth/refresh` was
separately confirmed **not** a bug: a fresh login → fresh refresh against
production succeeds with a 200 and the real token pair — the earlier 401
was an artifact of testing with no token/cookie at all (expected behavior
for an unauthenticated refresh attempt), not a stale-session bug.
`tests/integration/api/corsPreflight.integration.test.js` now codifies
this mechanism directly (real OPTIONS+POST via supertest, not an indirect
config check) — confirmed to fail 5/7 when the origin allow-list entry is
removed and pass again when restored, so it has real teeth against a
future regression in `app.js`'s `cors()` wiring specifically.

**If this recurs a fourth time**: stop re-verifying the same CORS
mechanism (three independent live checks across two sessions have now
confirmed it correct) and instead capture a fresh browser HAR file /
Network tab export from the actual failing request — the remaining
unexplained variable is genuinely transient client-side network
conditions, which no amount of server-side re-testing can reproduce or
rule out further.
