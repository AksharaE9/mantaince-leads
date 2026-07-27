// Production-readiness test harness for bulk upload across all four sections
// (Leads, Positives & Follow-ups, Raw Data, Delivery Data).
//
// Deliberately kept OUTSIDE server/ and client/ so it can never ship as part
// of the deployed bundle (server/vercel.json only traces from src/app.js;
// the root build only emits client/dist) — see scripts/README or the repo's
// CLAUDE.md for the deploy-shape details. It is still a tracked file (unlike
// scratch/, which is gitignored), so it must never contain a real secret —
// credentials come from env vars, not literals.
//
// Talks to a real deployed instance (or local dev) over HTTP, exactly like a
// real client would — no direct DB shortcuts for the parts under test
// (that's the whole point of testing the real pipeline).
//
// Every row this script generates is tagged via the shared `remarks` field:
//   LOADTEST-<runId>-<section>-<n>
// so scripts/production-readiness-cleanup.js can remove exactly (and only)
// these rows afterward — see that file's header for why Raw Data/Delivery
// Data can only be cleaned up with direct DB access (no DELETE route exists
// for either), so never point this harness's Raw Data/Delivery Data paths at
// an environment you can't reach with a DB client.
//
// Required env vars: PRODREADY_EMAIL, PRODREADY_PASSWORD (an account with
// csv:upload/leads:create/csv:template/csv:logs — see rules in this repo's
// CLAUDE.md under "RBAC").
//
// Usage:
//   node scripts/production-readiness-test.js functional <baseUrl> <verticalId> <runId> [subVerticalId] [sections]
//   node scripts/production-readiness-test.js gen <section> <count> <runId> <outFile>
//   node scripts/production-readiness-test.js loadtest <baseUrl> <verticalId> <runId> [concurrency] [durationSec]
//     — reads/writes against a non-localhost baseUrl require PRODREADY_ALLOW_PROD=1,
//       since this fires `concurrency` workers back-to-back with no think-time.

import fs from 'fs';
import { pathToFileURL } from 'url';

const SECTIONS = ['leads', 'positives', 'rawData', 'deliveryData'];

// ── Field defs mirrored from server schemas (headers must match exactly) ───
const CALL_HEADERS = ['DATE','EMPLOYEE NAME','BUSINESS TYPE','BUSINESS / PERSON / SHOP / COMPANY NAME','CONTACT NUMBER','POINT OF CONTACT','AREA','CITY','LINK ADDRESS','REMARKS','RECORDINGS','APPOINTMENT TYPE (YES OR NO)','APPOINTMENT DATE','APPOINTMENT TIME','REQUIREMENT ORDER IF ANY','NOTES TO THE COS IF ANY'];
const POSITIVE_HEADERS = ['DATE','EMPLOYEE NAME','BUSINESS TYPE','BUSINESS / PERSON / SHOP / COMPANY NAME','AREA','CITY','CONTACT NUMBER','POINT OF CONTACT','REMARKS','RECORDINGS','FOLLOW-UP REQUIRED','FOLLOW-UPS','FOLLOW-UP DATES','FOLLOW-UP REMARKS','REQUIREMENT IF ANY','A NOTES TO THE COS TEAM ONLY'];
const RAW_DATA_HEADERS = ['Date','Employee Name','Business Type','Business Name','Area','City','Phone Number','Address','Appointment Date','Appointment Timings','Remarks'];
const DELIVERY_DATA_HEADERS = [...RAW_DATA_HEADERS, 'Delivery Date', 'Delivery Time'];

function csvEscape(v) {
    const s = v === undefined || v === null ? '' : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}
function rowsToCsv(headers, rows) {
    const lines = [headers.join(',')];
    for (const r of rows) lines.push(headers.map(h => csvEscape(r[h])).join(','));
    return lines.join('\n') + '\n';
}

// A hash-based phone generator has a real birthday-bound collision risk once
// row counts climb into the thousands (two different rows in one 10k-row
// batch landing on the same 10-digit number would silently look like a
// server-side duplicate-detection bug and isn't one). Phones are instead
// built from a deterministic per-runId digit prefix plus the row index — no
// collisions within one (runId, section) pair.
//
// section is folded in as its own fixed digit, not just mixed into the hash:
// Leads and Positives write to the *same* cost_conversions table (this repo's
// "Positives & Follow-ups" is the same create-lead pipeline with
// leadType=POSITIVE — see this repo's CLAUDE.md), and multiple checks reuse
// the identical runId suffix across sections (e.g. every section's "valid
// upload" check calls genRows(section, 5, `${runId}v`)). Without a
// per-section digit, leads and positives would generate the exact same
// phone numbers for their respective checks and collide as cross-section
// "duplicates" that have nothing to do with the behavior under test — this
// happened during a refactor of this file and looked exactly like a false
// positive of the duplicate-detection tests, only against harness data
// contaminating itself.
const SECTION_DIGIT = { leads: '1', positives: '2', rawData: '3', deliveryData: '4' };
function runIdDigits(runId) {
    let h = 0;
    for (let i = 0; i < String(runId).length; i++) { h = (h * 31 + String(runId).charCodeAt(i)) >>> 0; }
    return String(h % 1000).padStart(3, '0');
}
function phoneFor(runId, section, n) {
    // 11 digits: 7 + 1 section digit + 3-digit run prefix + 6-digit row
    // index. Every field the app validates as a phone number accepts 7-15
    // digits (see PHONE_REGEX in rawDataImportSchema.js), so 11 is safe. n
    // is expected to stay under 1,000,000 (this harness's largest batch is 10,000).
    return `7${SECTION_DIGIT[section] || '9'}${runIdDigits(runId)}${String(n).padStart(6, '0')}`;
}
function tag(runId, section, n) { return `LOADTEST-${runId}-${section}-${n}`; }

/**
 * Generates `count` rows for a section. opts:
 *   malformedAt: Set<n> -> row n gets required fields blanked out
 *   dupWithinFileAt: Map<n, sourceN> -> row n reuses row sourceN's phone
 *   employeeName: string used for a fraction of rows to exercise resolution
 */
function genRows(section, count, runId, opts = {}) {
    const rows = [];
    const today = new Date().toISOString().slice(0, 10);
    for (let n = 1; n <= count; n++) {
        const t = tag(runId, section, n);
        let phone = phoneFor(runId, section, n);
        if (opts.dupWithinFileAt?.has(n)) phone = phoneFor(runId, section, opts.dupWithinFileAt.get(n));

        const malformed = opts.malformedAt?.has(n);
        const employeeName = (opts.employeeName && n % 5 === 0) ? opts.employeeName : '';

        if (section === 'leads') {
            rows.push({
                'DATE': today, 'EMPLOYEE NAME': employeeName, 'BUSINESS TYPE': 'Retail',
                'BUSINESS / PERSON / SHOP / COMPANY NAME': malformed ? '' : `${t} Biz`,
                'CONTACT NUMBER': malformed ? '' : phone,
                'POINT OF CONTACT': 'Owner', 'AREA': 'Whitefield', 'CITY': 'Bengaluru',
                'LINK ADDRESS': '', 'REMARKS': t, 'RECORDINGS': '',
                'APPOINTMENT TYPE (YES OR NO)': '', 'APPOINTMENT DATE': '', 'APPOINTMENT TIME': '',
                'REQUIREMENT ORDER IF ANY': '', 'NOTES TO THE COS IF ANY': '',
            });
        } else if (section === 'positives') {
            rows.push({
                'DATE': today, 'EMPLOYEE NAME': employeeName, 'BUSINESS TYPE': 'Retail',
                'BUSINESS / PERSON / SHOP / COMPANY NAME': malformed ? '' : `${t} Biz`,
                'AREA': 'Whitefield', 'CITY': 'Bengaluru',
                'CONTACT NUMBER': malformed ? '' : phone,
                'POINT OF CONTACT': 'Owner', 'REMARKS': t, 'RECORDINGS': '',
                'FOLLOW-UP REQUIRED': 'Yes', 'FOLLOW-UPS': '', 'FOLLOW-UP DATES': '',
                'FOLLOW-UP REMARKS': '', 'REQUIREMENT IF ANY': '', 'A NOTES TO THE COS TEAM ONLY': t,
            });
        } else if (section === 'rawData') {
            rows.push({
                'Date': today, 'Employee Name': employeeName, 'Business Type': 'Retail',
                'Business Name': malformed ? '' : `${t} Biz`,
                'Area': 'Whitefield', 'City': 'Bengaluru',
                'Phone Number': malformed ? '' : phone,
                'Address': '123 Main St', 'Appointment Date': '', 'Appointment Timings': '',
                'Remarks': t,
            });
        } else if (section === 'deliveryData') {
            rows.push({
                'Date': today, 'Employee Name': employeeName, 'Business Type': 'Retail',
                'Business Name': malformed ? '' : `${t} Biz`,
                'Area': 'Whitefield', 'City': 'Bengaluru',
                'Phone Number': malformed ? '' : phone,
                'Address': '123 Main St', 'Appointment Date': '', 'Appointment Timings': '',
                'Remarks': t,
                'Delivery Date': today,
                'Delivery Time': malformed ? '' : '10:00 AM',
            });
        }
    }
    return rows;
}

function headersFor(section) {
    return { leads: CALL_HEADERS, positives: POSITIVE_HEADERS, rawData: RAW_DATA_HEADERS, deliveryData: DELIVERY_DATA_HEADERS }[section];
}

const ENDPOINTS = {
    leads: { upload: '/api/v1/leads/csv/upload', status: (id) => `/api/v1/leads/csv/logs/${id}`, template: (v) => `/api/v1/leads/csv/template/${v}`, schema: (v) => `/api/v1/leads/csv/schema/${v}`, single: '/api/v1/leads' },
    positives: { upload: '/api/v1/leads/csv/upload', status: (id) => `/api/v1/leads/csv/logs/${id}`, single: '/api/v1/leads' },
    // template/schema for rawData/deliveryData require verticalId as a query
    // param, not a path segment (downloadRawDataTemplate/getRawDataSchema in
    // server/src/controllers/rawData.js both 400 without it) — unlike leads,
    // whose equivalent routes take it as a URL path segment.
    rawData: { upload: '/api/v1/raw-data/upload', status: (id) => `/api/v1/raw-data/upload-logs/${id}`, template: (v) => `/api/v1/raw-data/import-template?verticalId=${v}`, schema: (v) => `/api/v1/raw-data/schema?verticalId=${v}`, single: '/api/v1/raw-data' },
    deliveryData: { upload: '/api/v1/delivery-data/upload', status: (id) => `/api/v1/delivery-data/upload-logs/${id}`, template: (v) => `/api/v1/delivery-data/import-template?verticalId=${v}`, schema: (v) => `/api/v1/delivery-data/schema?verticalId=${v}`, single: '/api/v1/delivery-data' },
};

async function login(baseUrl) {
    const email = process.env.PRODREADY_EMAIL;
    const password = process.env.PRODREADY_PASSWORD;
    if (!email || !password) {
        throw new Error('Set PRODREADY_EMAIL and PRODREADY_PASSWORD env vars before running this harness (no credentials are hardcoded here).');
    }
    const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`Login failed: ${res.status} ${JSON.stringify(json)}`);
    return json.data.accessToken;
}

function assertTargetAllowed(baseUrl) {
    let isLocal = false;
    try {
        const host = new URL(baseUrl).hostname;
        isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    } catch {
        throw new Error(`Invalid baseUrl: ${baseUrl}`);
    }
    if (!isLocal && process.env.PRODREADY_ALLOW_PROD !== '1') {
        throw new Error(`Refusing to run against non-localhost target "${baseUrl}" without PRODREADY_ALLOW_PROD=1. This harness writes real rows and, for read-load tests, fires many requests with no think-time.`);
    }
}

function buildMultipart(csvString, filename, fields) {
    const boundary = '----ProdReady' + Math.random().toString(16).slice(2);
    const parts = [];
    for (const [k, v] of Object.entries(fields)) {
        parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
    }
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n${csvString}\r\n`);
    parts.push(`--${boundary}--\r\n`);
    return { body: parts.join(''), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function uploadCsv(baseUrl, token, section, verticalId, csvString, filename, extraFields = {}) {
    const ep = ENDPOINTS[section];
    const fields = { verticalId, ...extraFields };
    if (section === 'positives') fields.leadType = 'POSITIVE';
    if ((section === 'leads' || section === 'positives') && !fields.subVerticalId) {
        throw new Error('subVerticalId is required for leads/positives uploads');
    }
    const { body, contentType } = buildMultipart(csvString, filename, fields);
    const res = await fetch(`${baseUrl}${ep.upload}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': contentType },
        body,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
}

async function pollStatus(baseUrl, token, section, batchId, { timeoutMs = 120000, intervalMs = 1500 } = {}) {
    const ep = ENDPOINTS[section];
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const res = await fetch(`${baseUrl}${ep.status(batchId)}`, { headers: { 'Authorization': `Bearer ${token}` } });
        const json = await res.json().catch(() => ({}));
        const data = json.data || json;
        if (data && (data.status === 'done' || data.status === 'failed')) {
            return { ...data, elapsedMs: Date.now() - start };
        }
        await new Promise(r => setTimeout(r, intervalMs));
    }
    // Distinct from a server-reported status — this means the harness gave up
    // waiting, not that the server said anything. Kept as status:'timeout' too
    // for callers that only check `.status`, but harnessTimedOut is the
    // unambiguous field to branch on.
    return { status: 'timeout', harnessTimedOut: true, elapsedMs: Date.now() - start };
}

// ── Step 3: functional correctness audit ────────────────────────────────────

function record(results, section, check, pass, detail) {
    results.push({ section, check, pass, detail });
    console.log(`  ${pass ? '✅' : '❌'} [${section}] ${check}${detail ? ' — ' + detail : ''}`);
}

async function auditSection(baseUrl, token, verticalId, runId, section, results, extra = {}) {
    console.log(`\n=== ${section} ===`);
    const ep = ENDPOINTS[section];

    // 1. Valid bulk upload
    {
        const rows = genRows(section, 5, `${runId}v`);
        const csv = rowsToCsv(headersFor(section), rows);
        const { status, json } = await uploadCsv(baseUrl, token, section, verticalId, csv, `LOADTEST-${runId}-${section}_valid.csv`, extra);
        const okAccepted = status === 202 && json?.data?.batchId;
        record(results, section, 'valid bulk upload accepted (202)', okAccepted, `status=${status}`);
        if (okAccepted) {
            const final = await pollStatus(baseUrl, token, section, json.data.batchId);
            const ok = final.status === 'done' && final.success_count === 5 && final.failed_count === 0 && final.duplicate_count === 0;
            record(results, section, 'all 5 valid rows land with 0 failed/duplicate', ok, JSON.stringify({ status: final.status, success: final.success_count, failed: final.failed_count, dup: final.duplicate_count, ms: final.elapsedMs }));
        }
    }

    // 2. Malformed rows -> structured errors, never bare 500
    {
        const rows = genRows(section, 6, `${runId}m`, { malformedAt: new Set([3]) });
        const csv = rowsToCsv(headersFor(section), rows);
        const { status, json } = await uploadCsv(baseUrl, token, section, verticalId, csv, `LOADTEST-${runId}-${section}_malformed.csv`, extra);
        const accepted = status === 202;
        record(results, section, 'malformed-row file still accepted (202), not 500', accepted, `status=${status}`);
        if (accepted) {
            const final = await pollStatus(baseUrl, token, section, json.data.batchId);
            const hasFailure = final.failed_count === 1;
            const errs = final.errors || [];
            const structured = errs.length > 0 && errs.every(e => 'row' in e && ('field' in e || 'reason' in e || 'message' in e));
            record(results, section, 'exactly 1 malformed row rejected with structured error (row/field/message)', hasFailure && structured, JSON.stringify(errs.slice(0, 2)));
        }
    }

    // 3a. Duplicate WITHIN the same file
    {
        const rows = genRows(section, 4, `${runId}dwf`, { dupWithinFileAt: new Map([[3, 1]]) });
        if (section === 'deliveryData') {
            // Delivery Data's duplicate rule is a composite key
            // (phone + deliveryDate + deliveryTime), not phone alone — so to
            // actually test "same phone, different event = accepted", row 3
            // needs a different Delivery Date, not just the same phone
            // dupWithinFileAt already gave it. Without this, row 3 matches
            // row 1 on phone AND date AND time (genRows uses a constant
            // `today` for every row), making it a genuine duplicate and this
            // check would be asserting the wrong thing.
            const nextDay = new Date();
            nextDay.setDate(nextDay.getDate() + 1);
            rows[2]['Delivery Date'] = nextDay.toISOString().slice(0, 10);
        }
        const csv = rowsToCsv(headersFor(section), rows);
        const { status, json } = await uploadCsv(baseUrl, token, section, verticalId, csv, `LOADTEST-${runId}-${section}_dupwithin.csv`, extra);
        if (status === 202) {
            const final = await pollStatus(baseUrl, token, section, json.data.batchId);
            if (section === 'deliveryData') {
                // Delivery Data is an event log — same phone, different
                // event (different delivery date here) is NOT a duplicate.
                record(results, section, 'same-phone-different-event rows both accepted (event log, not a hard dupe)', final.success_count === 4, JSON.stringify({ success: final.success_count, dup: final.duplicate_count }));
            } else {
                const errs = final.errors || [];
                const dupErr = errs.find(e => /duplicat/i.test(e.reason || e.message || ''));
                const clean = dupErr && !/violates unique constraint|syntax error|SQLSTATE/i.test(dupErr.reason || dupErr.message || '');
                record(results, section, 'intra-file duplicate phone caught with a clean, catchable message (not raw DB error)', final.duplicate_count >= 1 && clean, JSON.stringify(dupErr));
            }
        } else {
            record(results, section, 'intra-file duplicate upload accepted (202)', false, `status=${status}`);
        }
    }

    // 3b. Duplicate against an EXISTING record (upload one row, then re-upload same phone)
    {
        const seedPhone = phoneFor(runId, section, 99999);
        const seedRows = genRows(section, 1, `${runId}seed`);
        seedRows[0][section === 'leads' || section === 'positives' ? 'CONTACT NUMBER' : 'Phone Number'] = seedPhone;
        const seedCsv = rowsToCsv(headersFor(section), seedRows);
        const seedUp = await uploadCsv(baseUrl, token, section, verticalId, seedCsv, `LOADTEST-${runId}-${section}_seed.csv`, extra);
        if (seedUp.status === 202) await pollStatus(baseUrl, token, section, seedUp.json.data.batchId);

        const dupRows = genRows(section, 1, `${runId}dupex`);
        dupRows[0][section === 'leads' || section === 'positives' ? 'CONTACT NUMBER' : 'Phone Number'] = seedPhone;
        if (section === 'deliveryData') {
            // Force an identical event (same phone+deliveryDate+deliveryTime) to trigger Delivery Data's real dup rule.
            dupRows[0]['Delivery Date'] = seedRows[0]['Delivery Date'];
            dupRows[0]['Delivery Time'] = seedRows[0]['Delivery Time'];
        }
        const dupCsv = rowsToCsv(headersFor(section), dupRows);
        const { status, json } = await uploadCsv(baseUrl, token, section, verticalId, dupCsv, `LOADTEST-${runId}-${section}_dupexisting.csv`, extra);
        if (status === 202) {
            const final = await pollStatus(baseUrl, token, section, json.data.batchId);
            const errs = final.errors || [];
            const dupErr = errs.find(e => /duplicat/i.test(e.reason || e.message || ''));
            const clean = dupErr && !/violates unique constraint|SQLSTATE/i.test(dupErr.reason || dupErr.message || '');
            record(results, section, 'duplicate against existing DB record caught with clean message, reports which row', final.duplicate_count >= 1 && clean, JSON.stringify(dupErr));
        } else {
            record(results, section, 'duplicate-vs-existing upload accepted (202)', false, `status=${status}`);
        }
    }

    // 4. Single-add validation parity with bulk (same missing-field rejection).
    // Tagged defensively in the remarks field even though this is expected to
    // be rejected for missing required fields — if the endpoint were ever
    // lenient this would land as a cleanable row instead of an untagged one.
    {
        const single = { verticalId, remarks: tag(runId, section, 'single-add-parity') };
        const rejectRes = await fetch(`${baseUrl}${ep.single}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(single),
        });
        const rejectJson = await rejectRes.json().catch(() => ({}));
        const structuredReject = rejectRes.status === 400 || rejectRes.status === 422;
        record(results, section, 'single-add with missing required fields rejected with structured 4xx (not 500)', structuredReject, `status=${rejectRes.status} body=${JSON.stringify(rejectJson).slice(0, 150)}`);
    }

    // 5. Template/schema drift check
    if (ep.schema) {
        const schemaRes = await fetch(`${baseUrl}${ep.schema(verticalId)}`, { headers: { 'Authorization': `Bearer ${token}` } });
        const schemaJson = await schemaRes.json().catch(() => ({}));
        const fields = schemaJson?.data?.fields || [];
        const declaredHeaders = fields.map(f => f.csvHeader);
        const expected = headersFor(section);
        const matches = expected.every(h => declaredHeaders.includes(h));
        record(results, section, 'schema endpoint headers match harness/template expectations (no drift)', matches, `expected=${expected.length} declared=${declaredHeaders.length}`);
    }
    if (ep.template) {
        const templRes = await fetch(`${baseUrl}${ep.template(verticalId)}`, { headers: { 'Authorization': `Bearer ${token}` } });
        record(results, section, 'template download endpoint returns 200', templRes.status === 200, `status=${templRes.status} content-type=${templRes.headers.get('content-type')}`);
    }
}

async function runFunctionalAudit(baseUrl, verticalId, runId, sections = SECTIONS, extraBySection = {}) {
    assertTargetAllowed(baseUrl);
    const token = await login(baseUrl);
    console.log(`Logged in. Running functional audit against ${baseUrl}, vertical=${verticalId}, runId=${runId}`);
    const results = [];
    for (const section of sections) {
        await auditSection(baseUrl, token, verticalId, runId, section, results, extraBySection[section] || {});
    }
    const failed = results.filter(r => !r.pass);
    console.log(`\n=== Functional audit summary: ${results.length - failed.length}/${results.length} passed ===`);
    if (failed.length) {
        console.log('FAILED CHECKS:');
        failed.forEach(f => console.log(`  - [${f.section}] ${f.check}: ${f.detail}`));
    }
    return { results, failed };
}

// ── Step 4b: concurrency load test (native fetch + Promise pool, no k6 dep) ─

function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[Math.max(0, idx)];
}

function summarize(samples) {
    const ok = samples.filter(s => s.ok);
    const times = ok.map(s => s.ms).sort((a, b) => a - b);
    return {
        count: samples.length,
        errors: samples.length - ok.length,
        errorRate: samples.length ? (samples.length - ok.length) / samples.length : 0,
        p50: percentile(times, 50),
        p95: percentile(times, 95),
        p99: percentile(times, 99),
        max: times[times.length - 1] || 0,
    };
}

async function timedFetch(url, opts, samples, label, timeoutMs = 15000) {
    const t0 = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...opts, signal: controller.signal });
        // Drain body so keep-alive connections free up realistically.
        await res.text().catch(() => {});
        samples.push({ label, ms: Date.now() - t0, ok: res.status < 500, status: res.status });
        return res.status;
    } catch (err) {
        samples.push({ label, ms: Date.now() - t0, ok: false, status: 0, err: err.name === 'AbortError' ? `timeout>${timeoutMs}ms` : err.message });
        return 0;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Runs `concurrency` virtual users for `durationMs`, each looping over a mix
 * of read endpoints across all four sections, with a small jittered pause
 * between requests per worker so this approximates real user think-time
 * instead of firing back-to-back as fast as the event loop allows (the
 * latter is a self-inflicted DoS against whatever `baseUrl` points at).
 * Returns per-endpoint stats.
 */
async function runReadLoad(baseUrl, token, verticalId, { concurrency = 50, durationMs = 30000, thinkTimeMs = 250 } = {}) {
    assertTargetAllowed(baseUrl);
    const samples = [];
    const endpoints = [
        { label: 'leads:list', url: `${baseUrl}/api/v1/leads?verticalId=${verticalId}&limit=20` },
        { label: 'leads:search', url: `${baseUrl}/api/v1/leads?verticalId=${verticalId}&limit=20&search=a` },
        { label: 'rawData:list', url: `${baseUrl}/api/v1/raw-data?verticalId=${verticalId}&limit=20` },
        { label: 'deliveryData:list', url: `${baseUrl}/api/v1/delivery-data?verticalId=${verticalId}&limit=20` },
    ];
    const stop = Date.now() + durationMs;
    const worker = async () => {
        while (Date.now() < stop) {
            const ep = endpoints[Math.floor(Math.random() * endpoints.length)];
            await timedFetch(ep.url, { headers: { Authorization: `Bearer ${token}` } }, samples, ep.label);
            if (thinkTimeMs > 0) await new Promise(r => setTimeout(r, Math.random() * thinkTimeMs));
        }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));

    const byLabel = {};
    for (const label of [...new Set(samples.map(s => s.label))]) {
        byLabel[label] = summarize(samples.filter(s => s.label === label));
    }
    return { overall: summarize(samples), byLabel, raw: samples };
}

export {
    genRows, rowsToCsv, headersFor, phoneFor, tag, login, uploadCsv, pollStatus, ENDPOINTS, SECTIONS,
    runFunctionalAudit, runReadLoad, summarize, timedFetch,
};

// ── CLI ──────────────────────────────────────────────────────────────────
// Compared via pathToFileURL (not manual string concatenation) so this
// correctly matches on paths containing spaces or other characters
// import.meta.url percent-encodes but a naive `file://${path}` build won't.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [, , cmd, ...args] = process.argv;

    if (cmd === 'gen') {
        const [section, countStr, runId, outFile] = args;
        const rows = genRows(section, Number(countStr), runId);
        fs.writeFileSync(outFile, rowsToCsv(headersFor(section), rows));
        console.log(`Wrote ${rows.length} rows to ${outFile}`);
    } else if (cmd === 'functional') {
        const [baseUrl, verticalId, runId, subVerticalId, sectionsArg] = args;
        const sections = sectionsArg ? sectionsArg.split(',') : SECTIONS;
        const extraBySection = subVerticalId ? { leads: { subVerticalId }, positives: { subVerticalId } } : {};
        const { failed } = await runFunctionalAudit(baseUrl, verticalId, runId, sections, extraBySection);
        process.exit(failed.length ? 1 : 0);
    } else if (cmd === 'loadtest') {
        const [baseUrl, verticalId, runId, concurrencyStr, durationSecStr] = args;
        assertTargetAllowed(baseUrl);
        const token = await login(baseUrl);
        const concurrency = Number(concurrencyStr || 50);
        const durationMs = Number(durationSecStr || 30) * 1000;
        console.log(`Read-load: ${concurrency} concurrent users for ${durationMs}ms against ${baseUrl} (vertical=${verticalId})`);
        const results = await runReadLoad(baseUrl, token, verticalId, { concurrency, durationMs });
        console.log('\nOverall:', results.overall);
        for (const [label, stats] of Object.entries(results.byLabel)) console.log(`  ${label}:`, stats);
        process.exit(results.overall.errorRate > 0.01 ? 1 : 0);
    } else if (cmd === 'help' || !cmd) {
        console.log('Usage:');
        console.log('  node scripts/production-readiness-test.js gen <section> <count> <runId> <outFile>');
        console.log('  node scripts/production-readiness-test.js functional <baseUrl> <verticalId> <runId> [subVerticalId] [sections]');
        console.log('  node scripts/production-readiness-test.js loadtest <baseUrl> <verticalId> <runId> [concurrency] [durationSec]');
        console.log('\nRequires PRODREADY_EMAIL / PRODREADY_PASSWORD env vars. Non-localhost baseUrl requires PRODREADY_ALLOW_PROD=1.');
    }
}
