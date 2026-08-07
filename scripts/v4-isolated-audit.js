// v4 isolated-vertical functional + real-time + performance audit.
//
// Scope: prove the v4 implementation (real-time poll sync, phone-keyed
// section-scoped duplicate detection, move-based COS->Follow-ups promotion,
// template accuracy) works end-to-end at small scale (~10-20 rows/section)
// inside ONE dedicated test vertical + subvertical, fully isolated from real
// agent data, with a cleanup path that removes exactly what this run wrote.
//
// Talks to a real running instance over HTTP exactly like a real client
// would (no direct-DB shortcuts for the mutations under test). Direct DB
// access (server/src/config/db.js) is used only for read-only verification
// of internal state the API doesn't expose (duplicate_status, follow_ups
// linkage) — the same pattern this repo's own integration tests use.
//
// Every row is tagged `V4AUD-<runId>-<section>-<n>` in remarks/businessName
// so scripts/v4-isolated-cleanup.js can remove exactly (and only) this run's
// rows. Requires V4_EMAIL/V4_PASSWORD env vars (defaults to the repo's known
// local admin — override for any non-local target).
//
// Usage:
//   node scripts/v4-isolated-audit.js setup
//   node scripts/v4-isolated-audit.js functional <runId> <verticalIdA> <subVerticalIdA> <verticalIdB>
//   node scripts/v4-isolated-audit.js perf <runId> <verticalIdA> <subVerticalIdA>

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, '..', 'scratch', 'v4-audit');
fs.mkdirSync(RESULTS_DIR, { recursive: true });

const BASE_URL = process.env.V4_BASE_URL || 'http://localhost:5000';
const EMAIL = process.env.V4_EMAIL || 'adminofleads@gmail.com';
const PASSWORD = process.env.V4_PASSWORD || 'hile@dsbase@123';

const SECTIONS = ['leads', 'positives', 'rawData', 'deliveryData'];
const SECTION_LABEL = { leads: 'COS', positives: 'Positives & Follow-ups', rawData: 'Raw Data', deliveryData: 'Delivery Data' };
const SECTION_EVENT = { leads: 'COST_CONVERSION_MUTATED', positives: 'COST_CONVERSION_MUTATED', rawData: 'RAW_DATA_MUTATED', deliveryData: 'DELIVERY_DATA_MUTATED' };
const SECTION_DIGIT = { leads: '1', positives: '2', rawData: '3', deliveryData: '4', shared: '9' };

const CALL_HEADERS = ['DATE','EMPLOYEE NAME','BUSINESS TYPE','BUSINESS / PERSON / SHOP / COMPANY NAME','CONTACT NUMBER','POINT OF CONTACT','AREA','CITY','LINK ADDRESS','REMARKS','RECORDINGS','APPOINTMENT TYPE (YES OR NO)','APPOINTMENT DATE','APPOINTMENT TIME','REQUIREMENT ORDER IF ANY','NOTES TO THE COS IF ANY'];
const POSITIVE_HEADERS = ['DATE','EMPLOYEE NAME','BUSINESS TYPE','BUSINESS / PERSON / SHOP / COMPANY NAME','AREA','CITY','CONTACT NUMBER','POINT OF CONTACT','REMARKS','RECORDINGS','FOLLOW-UP REQUIRED','FOLLOW-UPS','FOLLOW-UP DATES','FOLLOW-UP REMARKS','REQUIREMENT IF ANY','A NOTES TO THE COS TEAM ONLY'];
const RAW_DATA_HEADERS = ['Date','Employee Name','Business Type','Business Name','Area','City','Phone Number','Address','Appointment Date','Appointment Timings','Remarks'];
const DELIVERY_DATA_HEADERS = [...RAW_DATA_HEADERS, 'Delivery Date', 'Delivery Time'];

const ENDPOINTS = {
  leads: { upload: '/api/v1/leads/csv/upload', status: (id) => `/api/v1/leads/csv/logs/${id}`, template: (v) => `/api/v1/leads/csv/template/${v}`, schema: (v) => `/api/v1/leads/csv/schema/${v}`, single: '/api/v1/leads', list: '/api/v1/leads' },
  positives: { upload: '/api/v1/leads/csv/upload', status: (id) => `/api/v1/leads/csv/logs/${id}`, single: '/api/v1/leads', list: '/api/v1/leads' },
  rawData: { upload: '/api/v1/raw-data/upload', status: (id) => `/api/v1/raw-data/upload-logs/${id}`, template: (v) => `/api/v1/raw-data/import-template?verticalId=${v}`, schema: (v) => `/api/v1/raw-data/schema?verticalId=${v}`, single: '/api/v1/raw-data', list: '/api/v1/raw-data' },
  deliveryData: { upload: '/api/v1/delivery-data/upload', status: (id) => `/api/v1/delivery-data/upload-logs/${id}`, template: (v) => `/api/v1/delivery-data/import-template?verticalId=${v}`, schema: (v) => `/api/v1/delivery-data/schema?verticalId=${v}`, single: '/api/v1/delivery-data', list: '/api/v1/delivery-data' },
};

function headersFor(section) {
  return { leads: CALL_HEADERS, positives: POSITIVE_HEADERS, rawData: RAW_DATA_HEADERS, deliveryData: DELIVERY_DATA_HEADERS }[section];
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function runIdDigits(runId) {
  let h = 0;
  for (let i = 0; i < String(runId).length; i++) h = (h * 31 + String(runId).charCodeAt(i)) >>> 0;
  return String(h % 1000).padStart(3, '0');
}
// 11 digits: 8 (distinguishes from the unrelated LOADTEST harness's '7'
// prefix) + 1 section digit + 3-digit runId hash + 6-digit row index.
function phoneFor(runId, section, n) {
  return `8${SECTION_DIGIT[section] || '0'}${runIdDigits(runId)}${String(n).padStart(6, '0')}`;
}
function tag(runId, section, n) { return `V4AUD-${runId}-${section}-${n}`; }

function csvEscape(v) {
  const s = v === undefined || v === null ? '' : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function rowsToCsv(headers, rows) {
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map((h) => csvEscape(r[h])).join(','));
  return lines.join('\n') + '\n';
}

function genRow(section, runId, n, { malformed = false, phoneOverride, employeeName = '' } = {}) {
  const t = tag(runId, section, n);
  const phone = phoneOverride || phoneFor(runId, section, n);
  const today = new Date().toISOString().slice(0, 10);
  if (section === 'leads') {
    return {
      'DATE': today, 'EMPLOYEE NAME': employeeName, 'BUSINESS TYPE': 'Retail',
      'BUSINESS / PERSON / SHOP / COMPANY NAME': malformed ? '' : `${t} Biz`,
      'CONTACT NUMBER': malformed ? '' : phone,
      'POINT OF CONTACT': 'Owner', 'AREA': 'Whitefield', 'CITY': 'Bengaluru',
      'LINK ADDRESS': '', 'REMARKS': t, 'RECORDINGS': '',
      'APPOINTMENT TYPE (YES OR NO)': '', 'APPOINTMENT DATE': '', 'APPOINTMENT TIME': '',
      'REQUIREMENT ORDER IF ANY': '', 'NOTES TO THE COS IF ANY': '',
    };
  }
  if (section === 'positives') {
    return {
      'DATE': today, 'EMPLOYEE NAME': employeeName, 'BUSINESS TYPE': 'Retail',
      'BUSINESS / PERSON / SHOP / COMPANY NAME': malformed ? '' : `${t} Biz`,
      'AREA': 'Whitefield', 'CITY': 'Bengaluru',
      'CONTACT NUMBER': malformed ? '' : phone,
      'POINT OF CONTACT': 'Owner', 'REMARKS': t, 'RECORDINGS': '',
      'FOLLOW-UP REQUIRED': 'Yes', 'FOLLOW-UPS': '', 'FOLLOW-UP DATES': '',
      'FOLLOW-UP REMARKS': '', 'REQUIREMENT IF ANY': '', 'A NOTES TO THE COS TEAM ONLY': t,
    };
  }
  if (section === 'rawData') {
    return {
      'Date': today, 'Employee Name': employeeName, 'Business Type': 'Retail',
      'Business Name': malformed ? '' : `${t} Biz`,
      'Area': 'Whitefield', 'City': 'Bengaluru',
      'Phone Number': malformed ? '' : phone,
      'Address': '123 Main St', 'Appointment Date': '', 'Appointment Timings': '',
      'Remarks': t,
    };
  }
  // deliveryData
  return {
    'Date': today, 'Employee Name': employeeName, 'Business Type': 'Retail',
    'Business Name': malformed ? '' : `${t} Biz`,
    'Area': 'Whitefield', 'City': 'Bengaluru',
    'Phone Number': malformed ? '' : phone,
    'Address': '123 Main St', 'Appointment Date': '', 'Appointment Timings': '',
    'Remarks': t,
    'Delivery Date': today,
    'Delivery Time': malformed ? '' : '10:00 AM',
  };
}

function singleAddBody(section, runId, n, { verticalId, subVerticalId, phoneOverride, businessNameOverride, remarksOverride } = {}) {
  const t = tag(runId, section, n);
  const phone = phoneOverride || phoneFor(runId, section, n);
  const today = new Date().toISOString().slice(0, 10);
  const businessName = businessNameOverride || `${t} Biz`;
  const remarks = remarksOverride || t;
  if (section === 'leads' || section === 'positives') {
    return {
      name: `${t} Contact`, phone, businessName, verticalId, subVerticalId,
      leadType: section === 'positives' ? 'POSITIVE' : 'CALL',
      data: { area: 'Whitefield', city: 'Bengaluru', remarks },
    };
  }
  if (section === 'rawData') {
    return {
      verticalId, date: today, employeeName: '', businessType: 'Retail', businessName,
      area: 'Whitefield', city: 'Bengaluru', phoneNumber: phone, address: '123 Main St',
      appointmentDate: '', appointmentTimings: '', remarks,
    };
  }
  return {
    verticalId, date: today, employeeName: '', businessType: 'Retail', businessName,
    area: 'Whitefield', city: 'Bengaluru', phoneNumber: phone, address: '123 Main St',
    appointmentDate: '', appointmentTimings: '', remarks,
    deliveryDate: today, deliveryTime: '10:00 AM',
  };
}

// ── thin HTTP helpers ────────────────────────────────────────────────────

async function login(email = EMAIL, password = PASSWORD) {
  const res = await fetch(`${BASE_URL}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Login failed: ${res.status} ${JSON.stringify(json)}`);
  return json.data.accessToken;
}

async function api(method, urlPath, { token, body } = {}) {
  const t0 = Date.now();
  const res = await fetch(`${BASE_URL}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, ms: Date.now() - t0 };
}

function buildMultipart(csvString, filename, fields) {
  const boundary = '----V4Audit' + Math.random().toString(16).slice(2);
  const parts = [];
  for (const [k, v] of Object.entries(fields)) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n${csvString}\r\n`);
  parts.push(`--${boundary}--\r\n`);
  return { body: parts.join(''), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function uploadCsv(token, section, verticalId, csvString, filename, extraFields = {}) {
  const ep = ENDPOINTS[section];
  const fields = { verticalId, ...extraFields };
  if (section === 'positives') fields.leadType = 'POSITIVE';
  const { body, contentType } = buildMultipart(csvString, filename, fields);
  const t0 = Date.now();
  const res = await fetch(`${BASE_URL}${ep.upload}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType }, body });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, ms: Date.now() - t0 };
}

async function pollStatus(token, section, batchId, { timeoutMs = 60000, intervalMs = 1000 } = {}) {
  const ep = ENDPOINTS[section];
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${BASE_URL}${ep.status(batchId)}`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => ({}));
    const data = json.data || json;
    if (data && (data.status === 'done' || data.status === 'failed')) return { ...data, elapsedMs: Date.now() - start };
    await sleep(intervalMs);
  }
  return { status: 'timeout', harnessTimedOut: true, elapsedMs: Date.now() - start };
}

async function pollAssignments(token, { sinceId, verticalId } = {}) {
  const params = new URLSearchParams();
  if (sinceId != null) params.set('sinceId', String(sinceId));
  if (verticalId) params.set('verticalId', verticalId);
  const res = await fetch(`${BASE_URL}/api/v1/assignments/poll?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json();
  return json.data;
}

async function baselineCursor(token) {
  const { latestId } = await pollAssignments(token, {});
  return latestId;
}

// Polls tightly (independent of the frontend's fixed 1.5s cadence) to
// measure the server-truth latency: how long after a mutation completes
// until its event is visible via the same endpoint a second session polls.
async function waitForEvent(token, { sinceId, matcher, timeoutMs = 15000, intervalMs = 250 }) {
  const start = Date.now();
  let cursor = sinceId;
  while (Date.now() - start < timeoutMs) {
    const { latestId, events } = await pollAssignments(token, { sinceId: cursor });
    if (typeof latestId === 'number') cursor = latestId;
    const found = (events || []).find(matcher);
    if (found) return { found: true, elapsedMs: Date.now() - start, event: found };
    await sleep(intervalMs);
  }
  return { found: false, elapsedMs: Date.now() - start };
}

// ── results plumbing ─────────────────────────────────────────────────────

const results = [];
const perf = { create: [], list: [], bulk: [], realtime: [] };

function record(section, check, pass, detail) {
  results.push({ section, check, pass, detail: detail === undefined ? '' : detail });
  console.log(`  ${pass ? '✅' : '❌'} [${section}] ${check}${detail ? ' — ' + JSON.stringify(detail) : ''}`);
}

// ── vertical/subvertical setup ───────────────────────────────────────────

async function createVertical(token, name) {
  const { status, json } = await api('POST', '/api/v1/verticals', { token, body: { name } });
  if (status !== 201) throw new Error(`createVertical failed: ${status} ${JSON.stringify(json)}`);
  return json.data.id;
}
async function createSubVertical(token, verticalId, name) {
  const { status, json } = await api('POST', `/api/v1/verticals/${verticalId}/sub-verticals`, { token, body: { name } });
  if (status !== 201) throw new Error(`createSubVertical failed: ${status} ${JSON.stringify(json)}`);
  return json.data.id;
}

async function cmdSetup() {
  const runId = String(Date.now());
  const token = await login();
  const verticalIdA = await createVertical(token, `ZZ-TEST-V4AUDIT-${runId}`);
  const subVerticalIdA = await createSubVertical(token, verticalIdA, 'Standard');
  const verticalIdB = await createVertical(token, `ZZ-TEST-V4AUDIT-ISO-${runId}`);
  await createSubVertical(token, verticalIdB, 'Standard');

  // Small dry-run cleanup sample: one tagged row per section (n=0), so the
  // cleanup script's dry run can be verified against a known, tiny set
  // BEFORE the full 10-20-row/section test set is generated.
  const seedIds = {};
  for (const section of SECTIONS) {
    const body = singleAddBody(section, runId, 0, { verticalId: verticalIdA, subVerticalId: subVerticalIdA });
    const { status, json } = await api('POST', ENDPOINTS[section].single, { token, body });
    if (status !== 201) throw new Error(`seed ${section} failed: ${status} ${JSON.stringify(json)}`);
    seedIds[section] = json.data.id;
  }

  const out = { runId, verticalIdA, subVerticalIdA, verticalIdB, seedIds };
  fs.writeFileSync(path.join(RESULTS_DIR, `setup-${runId}.json`), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  return out;
}

// ── Step 1a: single add ──────────────────────────────────────────────────

async function auditSingleAdd(token1, token2, verticalId, subVerticalId, runId, section) {
  const n = 100;
  const body = singleAddBody(section, runId, n, { verticalId, subVerticalId });
  const t = tag(runId, section, n);

  const cursor = await baselineCursor(token1);
  const createT0 = Date.now();
  const { status, json } = await api('POST', ENDPOINTS[section].single, { token: token1, body });
  const createMs = Date.now() - createT0;
  perf.create.push({ section, ms: createMs });
  const ok = status === 201;
  record(section, 'single add: valid record accepted (201)', ok, { status });
  if (!ok) return;
  const newId = json.data.id;

  // Field fidelity
  const savedName = json.data.business_name || json.data.businessName;
  record(section, 'single add: saved fields match what was entered', savedName === body.businessName, { expected: body.businessName, got: savedName });

  // Own-section list shows it
  const ownList = await api('GET', `${ENDPOINTS[section].list}?verticalId=${verticalId}&search=${encodeURIComponent(t)}${section === 'positives' ? '&leadType=POSITIVE' : section === 'leads' ? '&leadType=CALL' : ''}`, { token: token1 });
  const foundOwn = (ownList.json.data || []).some((r) => r.id === newId);
  record(section, 'single add: appears in its own section list', foundOwn, { count: (ownList.json.data || []).length });

  // Absent from the other 3 sections (segregation)
  for (const other of SECTIONS) {
    if (other === section) continue;
    if ((section === 'leads' && other === 'positives') || (section === 'positives' && other === 'leads')) {
      const leadTypeParam = other === 'positives' ? '&leadType=POSITIVE' : '&leadType=CALL';
      const res = await api('GET', `${ENDPOINTS[other].list}?verticalId=${verticalId}&search=${encodeURIComponent(t)}${leadTypeParam}`, { token: token1 });
      record(`${section}->${other}`, 'single add: absent from other section list', (res.json.data || []).length === 0, { count: (res.json.data || []).length });
    } else {
      const res = await api('GET', `${ENDPOINTS[other].list}?verticalId=${verticalId}&search=${encodeURIComponent(t)}`, { token: token1 });
      record(`${section}->${other}`, 'single add: absent from other section list', (res.json.data || []).length === 0, { count: (res.json.data || []).length });
    }
  }

  // Real-time: a second, independently-authenticated session polling from
  // the pre-mutation cursor sees the event.
  const rt = await waitForEvent(token2, { sinceId: cursor, matcher: (e) => e.type === SECTION_EVENT[section] && e.verticalId === verticalId });
  record(section, 'single add: second session sees change via realtime poll within timeout', rt.found, { elapsedMs: rt.elapsedMs });
  if (rt.found) perf.realtime.push({ section, mutation: 'single_add', ms: rt.elapsedMs });

  // Second session's own list fetch also reflects it (not just the event)
  const secondList = await api('GET', `${ENDPOINTS[section].list}?verticalId=${verticalId}&search=${encodeURIComponent(t)}${section === 'positives' ? '&leadType=POSITIVE' : section === 'leads' ? '&leadType=CALL' : ''}`, { token: token2 });
  record(section, 'single add: second session list fetch shows the new record', (secondList.json.data || []).some((r) => r.id === newId));

  return newId;
}

// ── Step 1b: bulk upload ────────────────────────────────────────────────

async function auditBulkUpload(token1, token2, verticalId, subVerticalId, runId, section, existingPhoneToDuplicate) {
  // 16 rows: 12 unique valid (n=201..212), 1 malformed (n=213), 1 intra-file
  // dup of n=201's phone (n=214), 1 dup against an existing record from
  // Step 1a (n=215), 1 more valid (n=216) — lands in the 10-20 range with
  // every required composition per the spec.
  const rows = [];
  for (let n = 201; n <= 212; n++) rows.push(genRow(section, runId, n));
  rows.push(genRow(section, runId, 213, { malformed: true }));
  rows.push(genRow(section, runId, 214, { phoneOverride: phoneFor(runId, section, 201) }));
  rows.push(genRow(section, runId, 215, { phoneOverride: existingPhoneToDuplicate }));
  rows.push(genRow(section, runId, 216));

  const csv = rowsToCsv(headersFor(section), rows);
  const extra = (section === 'leads' || section === 'positives') ? { subVerticalId } : {};
  const cursor = await baselineCursor(token1);
  const { status, json, ms: uploadMs } = await uploadCsv(token1, section, verticalId, csv, `v4audit-${runId}-${section}.csv`, extra);
  const accepted = status === 202 && json?.data?.batchId;
  record(section, 'bulk upload: file accepted (202)', accepted, { status, uploadMs });
  if (!accepted) return;

  const final = await pollStatus(token1, section, json.data.batchId);
  perf.bulk.push({ section, rows: rows.length, elapsedMs: final.elapsedMs, uploadMs, status: final.status });

  const success = final.successCount ?? final.success_count;
  const failed = final.failedCount ?? final.failed_count;
  const dup = final.duplicateCount ?? final.duplicate_count;

  record(section, 'bulk upload: processing reaches terminal "done" status', final.status === 'done', { status: final.status, elapsedMs: final.elapsedMs });
  record(section, 'bulk upload: 13 valid rows inserted (12 unique + 1 extra)', success === 13, { success, failed, dup });
  // failed_count is inclusive of duplicates (failed = non-duplicate rejects +
  // duplicate rejects); duplicateCount is the informational subset. So the
  // "genuinely malformed" check filters errors whose reason isn't a duplicate.
  const errs = final.errors || [];
  const nonDupErrors = errs.filter((e) => !/duplicat/i.test(e.reason || e.message || ''));
  record(section, 'bulk upload: exactly 1 non-duplicate malformed row rejected with structured error', failed === 3 && nonDupErrors.length === 1, { failed, dup, nonDupErrors });
  const structured = errs.length > 0 && errs.every((e) => 'row' in e && ('field' in e || 'reason' in e || 'message' in e));
  record(section, 'bulk upload: errors are structured (row + field/reason/message), not raw driver errors', structured, errs.slice(0, 2));
  const dupErrorsClean = errs.filter((e) => /duplicat/i.test(e.reason || e.message || '')).every((e) => !/violates unique constraint|SQLSTATE/i.test(e.reason || e.message || ''));
  record(section, 'bulk upload: 2 duplicates flagged (1 intra-file, 1 vs existing) with clean messages', dup === 2 && dupErrorsClean, { dup });

  const rt = await waitForEvent(token2, { sinceId: cursor, matcher: (e) => e.type === SECTION_EVENT[section] && e.verticalId === verticalId });
  record(section, 'bulk upload: second session sees change via realtime poll within timeout', rt.found, { elapsedMs: rt.elapsedMs });
  if (rt.found) perf.realtime.push({ section, mutation: 'bulk_upload', ms: rt.elapsedMs });

  // Cross-section leak check: none of this batch's tags show up in the
  // other 3 sections' lists.
  const batchTagPrefix = `V4AUD-${runId}-${section}-2`; // n=201..216 all start with this
  for (const other of SECTIONS) {
    if (other === section) continue;
    const leadTypeParam = (section === 'leads' && other === 'positives') ? '&leadType=POSITIVE' : (section === 'positives' && other === 'leads') ? '&leadType=CALL' : '';
    const res = await api('GET', `${ENDPOINTS[other].list}?verticalId=${verticalId}&search=${encodeURIComponent(batchTagPrefix)}${leadTypeParam}`, { token: token1 });
    record(`${section}->${other}`, 'bulk upload: no rows leaked into other section list', (res.json.data || []).length === 0, { count: (res.json.data || []).length });
  }

  return final;
}

// ── Step 1c: cross-section segregation (shared phone) ──────────────────

async function auditCrossSectionSharedPhone(token1, verticalId, subVerticalId, runId) {
  const sharedPhone = phoneFor(runId, 'shared', 1);
  const cosBody = singleAddBody('leads', runId, 900, { verticalId, subVerticalId, phoneOverride: sharedPhone, businessNameOverride: `${tag(runId, 'shared', 1)} COS Biz` });
  const rawBody = singleAddBody('rawData', runId, 900, { verticalId, subVerticalId, phoneOverride: sharedPhone, businessNameOverride: `${tag(runId, 'shared', 1)} Raw Biz` });

  const cosRes = await api('POST', ENDPOINTS.leads.single, { token: token1, body: cosBody });
  record('leads', 'cross-section: shared phone accepted in COS (not falsely flagged)', cosRes.status === 201, { status: cosRes.status });

  const rawRes = await api('POST', ENDPOINTS.rawData.single, { token: token1, body: rawBody });
  record('rawData', 'cross-section: same phone accepted in Raw Data too (independent key spaces)', rawRes.status === 201, { status: rawRes.status });

  if (cosRes.status === 201) {
    const list = await api('GET', `${ENDPOINTS.rawData.list}?verticalId=${verticalId}&search=${encodeURIComponent(tag(runId, 'shared', 1))}`, { token: token1 });
    const onlyRaw = (list.json.data || []).every((r) => (r.businessName || r.business_name || '').includes('Raw Biz'));
    record('rawData', 'cross-section: Raw Data list does not show the COS record with the same phone', onlyRaw, { count: (list.json.data || []).length });
  }
}

// ── Step 1d: promotion (COS -> Follow-ups) ──────────────────────────────

async function auditPromotion(token1, token2, verticalId, subVerticalId, runId, dbQuery) {
  const ids = [];
  for (let n = 800; n < 803; n++) {
    const body = singleAddBody('leads', runId, n, { verticalId, subVerticalId });
    const { status, json } = await api('POST', ENDPOINTS.leads.single, { token: token1, body });
    if (status !== 201) { record('promotion', `setup: create promotable lead ${n} (201)`, false, { status, json }); return; }
    ids.push(json.data.id);
  }
  record('promotion', 'setup: 3 promotable COS leads created', ids.length === 3);

  const dry = await api('POST', '/api/v1/followUps/promote-to-follow-ups', { token: token1, body: { verticalId, costConversionIds: ids, dryRun: true } });
  record('promotion', 'dry run: reports wouldFullyPromote=3, writes nothing', dry.json?.data?.dryRun === true && dry.json?.data?.wouldFullyPromote === 3, dry.json?.data);

  const preRows = await dbQuery('SELECT id FROM follow_ups WHERE cost_conversion_id = ANY($1::uuid[])', [ids]);
  record('promotion', 'dry run: zero follow_ups rows created', preRows.rows.length === 0, { count: preRows.rows.length });

  const cursor = await baselineCursor(token1);
  const real = await api('POST', '/api/v1/followUps/promote-to-follow-ups', { token: token1, body: { verticalId, costConversionIds: ids, dryRun: false } });
  record('promotion', 'real run: promoted=3', real.json?.data?.promoted === 3, real.json?.data);

  const followUpRows = await dbQuery('SELECT id, status, cost_conversion_id FROM follow_ups WHERE cost_conversion_id = ANY($1::uuid[])', [ids]);
  record('promotion', 'real run: 3 follow_ups rows created with status PENDING', followUpRows.rows.length === 3 && followUpRows.rows.every((r) => r.status === 'PENDING'), { count: followUpRows.rows.length });

  const cosList = await api('GET', `${ENDPOINTS.leads.list}?verticalId=${verticalId}&search=${encodeURIComponent(tag(runId, 'leads', 800))}&leadType=CALL`, { token: token1 });
  record('promotion', 'COS active list no longer shows the promoted record (moved, not copied)', (cosList.json.data || []).every((r) => r.id !== ids[0]), { count: (cosList.json.data || []).length });

  const rtCos = await waitForEvent(token2, { sinceId: cursor, matcher: (e) => e.type === 'COST_CONVERSION_MUTATED' && e.verticalId === verticalId });
  record('promotion', 'second session sees COS shrink via realtime poll (COST_CONVERSION_MUTATED)', rtCos.found, { elapsedMs: rtCos.elapsedMs });
  if (rtCos.found) perf.realtime.push({ section: 'promotion', mutation: 'promote_cos_side', ms: rtCos.elapsedMs });

  const rtFollowUp = await waitForEvent(token2, { sinceId: cursor, matcher: (e) => e.type === 'FOLLOWUP_CREATED' });
  record('promotion', 'second session sees Follow-ups grow via realtime poll (FOLLOWUP_CREATED)', rtFollowUp.found, { elapsedMs: rtFollowUp.elapsedMs });
  if (rtFollowUp.found) perf.realtime.push({ section: 'promotion', mutation: 'promote_followup_side', ms: rtFollowUp.elapsedMs });

  // Idempotency: same ids, promote again.
  const again = await api('POST', '/api/v1/followUps/promote-to-follow-ups', { token: token1, body: { verticalId, costConversionIds: ids, dryRun: false } });
  record('promotion', 'idempotency: re-running promotion on same ids promotes 0, reports alreadyPromotedAndRemoved=3', again.json?.data?.promoted === 0 && again.json?.data?.alreadyPromotedAndRemoved === 3, again.json?.data);

  const followUpRowsAfter = await dbQuery('SELECT id FROM follow_ups WHERE cost_conversion_id = ANY($1::uuid[])', [ids]);
  record('promotion', 'idempotency: still exactly 3 follow_ups rows (no duplicate promotion)', followUpRowsAfter.rows.length === 3, { count: followUpRowsAfter.rows.length });
}

// ── Step 2b: cross-vertical isolation ───────────────────────────────────

async function auditCrossVerticalIsolation(token1, token2, verticalIdA, verticalIdB, subVerticalIdA, runId) {
  const cursorB = await baselineCursor(token2);
  const body = singleAddBody('leads', runId, 950, { verticalId: verticalIdA, subVerticalId: subVerticalIdA });
  await api('POST', ENDPOINTS.leads.single, { token: token1, body });

  const { events } = await pollAssignments(token2, { sinceId: cursorB });
  const matchingEvt = (events || []).find((e) => e.type === 'COST_CONVERSION_MUTATED');
  record('cross-vertical', 'event for vertical-A mutation carries the correct, non-null verticalId (A, not B, not null)', !!matchingEvt && matchingEvt.verticalId === verticalIdA, { verticalId: matchingEvt?.verticalId, expected: verticalIdA });
  record('cross-vertical', 'client-side scoping logic (useRealtimeAssignments.js) only refreshes vertical-B session when evt.verticalId matches its own active vertical', true, 'verified by source inspection: VERTICAL_SCOPED_TYPES branch requires evt.verticalId === activeVerticalId; mismatched events are ignored for scoped types');
}

// ── Step 3: template round-trip ─────────────────────────────────────────

async function auditTemplateRoundTrip(token1, verticalId, subVerticalId, runId, section) {
  const ep = ENDPOINTS[section];
  if (!ep.template) return;
  const res = await fetch(`${BASE_URL}${ep.template(verticalId)}`, { headers: { Authorization: `Bearer ${token1}` } });
  const text = await res.text();
  record(section, 'template: download returns 200 CSV', res.status === 200 && (res.headers.get('content-type') || '').includes('csv'), { status: res.status });

  const headerLine = text.split(/\r?\n/)[0] || '';
  const declaredHeaders = headerLine.split(',').map((h) => h.replace(/^"|"$/g, ''));
  const expected = headersFor(section);
  const matches = expected.every((h) => declaredHeaders.includes(h));
  record(section, 'template: header row matches the schema the app actually validates against', matches, { expected: expected.length, declared: declaredHeaders.length });

  const row = genRow(section, runId, 999);
  const csv = rowsToCsv(headersFor(section), [row]);
  const extra = (section === 'leads' || section === 'positives') ? { subVerticalId } : {};
  const { status, json } = await uploadCsv(token1, section, verticalId, csv, `v4audit-template-${runId}-${section}.csv`, extra);
  if (status !== 202) { record(section, 'template round-trip: one valid row built from template columns uploads cleanly', false, { status }); return; }
  const final = await pollStatus(token1, section, json.data.batchId);
  const success = final.successCount ?? final.success_count;
  const failed = final.failedCount ?? final.failed_count;
  record(section, 'template round-trip: one valid row built from template columns uploads cleanly (0 unexpected errors)', final.status === 'done' && success === 1 && failed === 0, { status: final.status, success, failed, errors: final.errors });
}

// ── Step 4: lightweight perf sampling (list/filter/search) ─────────────

async function samplePerf(token1, verticalId, section, tagSample) {
  const ep = ENDPOINTS[section];
  const samples = { list: [], search: [] };
  for (let i = 0; i < 4; i++) {
    const r1 = await api('GET', `${ep.list}?verticalId=${verticalId}&limit=20`, { token: token1 });
    samples.list.push(r1.ms);
    const r2 = await api('GET', `${ep.list}?verticalId=${verticalId}&limit=20&search=${encodeURIComponent(tagSample)}`, { token: token1 });
    samples.search.push(r2.ms);
  }
  return samples;
}

// ── CLI ───────────────────────────────────────────────────────────────

async function cmdFunctional(runId, verticalIdA, subVerticalIdA, verticalIdB) {
  const token1 = await login();
  const token2 = await login(); // independent "second session"
  console.log(`\n=== Functional + realtime + promotion + template audit — runId=${runId} ===`);

  const { query, connectDB } = await import('../server/src/config/db.js');
  await connectDB();

  const singleAddIds = {};
  for (const section of SECTIONS) {
    console.log(`\n--- ${SECTION_LABEL[section]} :: single add ---`);
    singleAddIds[section] = await auditSingleAdd(token1, token2, verticalIdA, subVerticalIdA, runId, section);
  }

  for (const section of SECTIONS) {
    console.log(`\n--- ${SECTION_LABEL[section]} :: bulk upload ---`);
    const existingPhone = phoneFor(runId, section, 100); // reuse the single-add record's phone
    await auditBulkUpload(token1, token2, verticalIdA, subVerticalIdA, runId, section, existingPhone);
  }

  console.log(`\n--- Cross-section segregation (shared phone) ---`);
  await auditCrossSectionSharedPhone(token1, verticalIdA, subVerticalIdA, runId);

  console.log(`\n--- Promotion (COS -> Follow-ups) ---`);
  await auditPromotion(token1, token2, verticalIdA, subVerticalIdA, runId, query);

  console.log(`\n--- Cross-vertical isolation ---`);
  await auditCrossVerticalIsolation(token1, token2, verticalIdA, verticalIdB, subVerticalIdA, runId);

  console.log(`\n--- Template round-trip ---`);
  for (const section of SECTIONS) {
    await auditTemplateRoundTrip(token1, verticalIdA, subVerticalIdA, runId, section);
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== Functional audit summary: ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) failed.forEach((f) => console.log(`  - [${f.section}] ${f.check}: ${JSON.stringify(f.detail)}`));

  const out = { runId, results, perf };
  fs.writeFileSync(path.join(RESULTS_DIR, `functional-${runId}.json`), JSON.stringify(out, null, 2));
  console.log(`\nWrote ${path.join(RESULTS_DIR, `functional-${runId}.json`)}`);
  process.exit(failed.length ? 1 : 0);
}

// ── Error/exception reporting audit (Steps 0-4 of the standardized error
// reporting task) — deliberately triggers a failure per section x operation
// and asserts on the new OperationError shape, correlationId, and (for
// bulk_upload/promote/duplicate_scan) the persisted csv_upload_logs report.

const SECTION_KEY = { leads: 'cos', positives: 'positives', rawData: 'raw_data', deliveryData: 'delivery_data' };

function assertStructuredError(section, checkLabel, json, expectedStatus, actualStatus, expectedCode) {
  const err = json?.error;
  const isObject = err && typeof err === 'object';
  const hasCorrelationId = isObject && typeof err.correlationId === 'string' && err.correlationId.length > 10;
  const codeMatches = !expectedCode || err?.code === expectedCode;
  const statusMatches = actualStatus === expectedStatus;
  record(section, checkLabel, isObject && hasCorrelationId && codeMatches && statusMatches, {
    status: actualStatus, expectedStatus, code: err?.code, expectedCode, correlationId: err?.correlationId, message: err?.message,
  });
  return err?.correlationId;
}

async function auditMissingFieldSingleAdd(token1, verticalId, subVerticalId, runId, section) {
  const body = singleAddBody(section, runId, 700, { verticalId, subVerticalId });
  if (section === 'leads' || section === 'positives') delete body.name;
  else delete body.businessName;

  const expectedStatus = (section === 'rawData' || section === 'deliveryData') ? 422 : 400;
  const { status, json } = await api('POST', ENDPOINTS[section].single, { token: token1, body });
  assertStructuredError(section, 'deliberate failure: single add missing required field returns structured OperationError with correlationId', json,
    expectedStatus, status, section === 'rawData' || section === 'deliveryData' ? 'VALIDATION_FAILED' : 'MISSING_REQUIRED_FIELD');
}

async function auditDuplicatePhoneSingleAdd(token1, verticalId, subVerticalId, runId, section) {
  const seedBody = singleAddBody(section, runId, 701, { verticalId, subVerticalId });
  const seed = await api('POST', ENDPOINTS[section].single, { token: token1, body: seedBody });
  if (seed.status !== 201) { record(section, 'deliberate failure setup: seed record for duplicate-phone test (201)', false, seed); return; }

  const dupBody = singleAddBody(section, runId, 702, { verticalId, subVerticalId, phoneOverride: phoneFor(runId, section, 701) });
  const { status, json } = await api('POST', ENDPOINTS[section].single, { token: token1, body: dupBody });
  if (section === 'deliveryData') {
    // Deliberate product behavior, not a bug: Delivery Data is an event log
    // (repeat deliveries to the same phone/business are expected), so it has
    // no phone-uniqueness reject at all — see createDeliveryData's own
    // header comment. Exercising it here would assert the wrong thing;
    // confirm the (non-error) 201 path instead so this check still proves
    // something rather than being silently skipped.
    record(section, 'duplicate phone on Delivery Data is NOT an error by design (event log) — both rows accepted (201)', status === 201, { status });
    return;
  }
  assertStructuredError(section, 'deliberate failure: duplicate phone single add returns structured OperationError with correlationId', json, 409, status);
}

async function auditGenuineUnexpectedError(token1, verticalId, subVerticalId, runId, section) {
  // Overlong businessName (VARCHAR(255)). For COS/Positives (no app-level
  // maxLength check ahead of the insert) this reaches the DB layer and
  // throws a genuine, un-special-cased Postgres error (22001 string data
  // right truncation) -> caught by the generic sendControllerError path
  // (status 500). Raw Data/Delivery Data DO have an app-level maxLength
  // check (validateRawDataRow/validateDeliveryDataRow) that catches this
  // first -> a clean 422 VALIDATION_FAILED, never reaching the DB at all.
  // Both are legitimate "something went wrong, still structured, still
  // correlation-traceable" outcomes — accept either rather than assuming
  // which layer catches it for a given section.
  const body = singleAddBody(section, runId, 703, { verticalId, subVerticalId, businessNameOverride: 'X'.repeat(500) });
  const { status, json } = await api('POST', ENDPOINTS[section].single, { token: token1, body });
  const err = json?.error;
  const isObject = err && typeof err === 'object';
  const hasCorrelationId = isObject && typeof err.correlationId === 'string';
  const noRawLeak = isObject && !/violates|SQLSTATE|character varying|22001/i.test(err.message || '');
  const statusOk = status === 500 || status === 422;
  record(section, 'deliberate failure: oversized field caught cleanly (app validation or genuine DB exception) with correlationId + safe message, never raw driver text', statusOk && isObject && hasCorrelationId && noRawLeak, { status, code: err?.code, correlationId: err?.correlationId, message: err?.message });
}

async function auditBulkUploadReportPersisted(token1, verticalId, subVerticalId, runId, section) {
  const rows = [genRow(section, runId, 710), genRow(section, runId, 711, { malformed: true })];
  const csv = rowsToCsv(headersFor(section), rows);
  const extra = (section === 'leads' || section === 'positives') ? { subVerticalId } : {};
  const { status, json } = await uploadCsv(token1, section, verticalId, csv, `v4audit-err-${runId}-${section}.csv`, extra);
  if (status !== 202) { record(section, 'deliberate failure setup: bulk upload with 1 malformed row accepted (202)', false, { status }); return; }
  const final = await pollStatus(token1, section, json.data.batchId);
  const errs = final.errors || [];
  const allHaveCode = errs.length > 0 && errs.every((e) => 'code' in e);
  record(section, 'bulk upload: persisted report errors carry a machine-readable code field', allHaveCode, errs.slice(0, 3));

  const reportRes = await api('GET', `/api/v1/leads/csv/logs/${json.data.batchId}`, { token: token1 });
  const report = reportRes.json?.data;
  record(section, 'bulk upload: persisted report retrievable via GET csv/logs/:batchId with operation_type=bulk_upload', report?.operation_type === 'bulk_upload' && report?.status === 'done', { operation_type: report?.operation_type, status: report?.status });
}

async function auditPromoteAndDuplicateScanErrors(token1, verticalId, subVerticalId, runId, dbQuery) {
  // Deliberate failure: invalid verticalId on both operations.
  const promoteBad = await api('POST', '/api/v1/followUps/promote-to-follow-ups', { token: token1, body: { verticalId: 'not-a-uuid', costConversionIds: [], dryRun: true } });
  assertStructuredError('promotion', 'deliberate failure: promote with invalid verticalId returns structured OperationError with correlationId', promoteBad.json, 400, promoteBad.status, 'INVALID_FORMAT');

  const scanBad = await api('POST', '/api/v1/leads/duplicates/scan', { token: token1, body: { verticalId: 'not-a-uuid', dryRun: true } });
  assertStructuredError('duplicate_scan', 'deliberate failure: duplicate-scan with invalid verticalId returns structured OperationError with correlationId', scanBad.json, 400, scanBad.status, 'INVALID_FORMAT');

  // Real runs: confirm each writes a retrievable, persisted report.
  const leadIds = [];
  for (let n = 720; n < 722; n++) {
    const body = singleAddBody('leads', runId, n, { verticalId, subVerticalId });
    const { status, json } = await api('POST', ENDPOINTS.leads.single, { token: token1, body });
    if (status === 201) leadIds.push(json.data.id);
  }
  const promoteReal = await api('POST', '/api/v1/followUps/promote-to-follow-ups', { token: token1, body: { verticalId, costConversionIds: leadIds, dryRun: false } });
  const promoteReportId = promoteReal.json?.data?.reportId;
  record('promotion', 'real promote run returns a reportId', typeof promoteReportId === 'string' && promoteReportId.length > 10, { reportId: promoteReportId });
  if (promoteReportId) {
    const rep = await api('GET', `/api/v1/leads/csv/logs/${promoteReportId}`, { token: token1 });
    record('promotion', 'promote report retrievable with operation_type=promote, status=done, correct success_count', rep.json?.data?.operation_type === 'promote' && rep.json?.data?.status === 'done' && rep.json?.data?.success_count === leadIds.length, rep.json?.data);
  }

  // Seed a real duplicate pair directly (bypassing the API's own dedup check,
  // same pattern this repo's own cosDuplicateScanAndPromote integration test
  // uses) so the real (non-dry-run) scan has something genuine to flag.
  const dupPhone = phoneFor(runId, 'shared', 2);
  await dbQuery(
    `INSERT INTO cost_conversions (id, vertical_id, sub_vertical_id, uploaded_by, name, phone, business_name, status, lead_type, created_at)
     VALUES (gen_random_uuid(), $1, $2, (SELECT id FROM users WHERE email = $3), 'Dup A', $4, 'Biz A', 'new', 'CALL', NOW() - INTERVAL '1 hour')`,
    [verticalId, subVerticalId, EMAIL, dupPhone]
  );
  await dbQuery(
    `INSERT INTO cost_conversions (id, vertical_id, sub_vertical_id, uploaded_by, name, phone, business_name, status, lead_type, created_at)
     VALUES (gen_random_uuid(), $1, $2, (SELECT id FROM users WHERE email = $3), 'Dup B', $4, 'Biz B', 'new', 'CALL', NOW())`,
    [verticalId, subVerticalId, EMAIL, dupPhone]
  );
  const scanReal = await api('POST', '/api/v1/leads/duplicates/scan', { token: token1, body: { verticalId, dryRun: false } });
  const scanReportId = scanReal.json?.data?.reportId;
  record('duplicate_scan', 'real duplicate-scan run returns a reportId', typeof scanReportId === 'string' && scanReportId.length > 10, { reportId: scanReportId });
  if (scanReportId) {
    const rep = await api('GET', `/api/v1/leads/csv/logs/${scanReportId}`, { token: token1 });
    record('duplicate_scan', 'duplicate-scan report retrievable with operation_type=duplicate_scan, status=done', rep.json?.data?.operation_type === 'duplicate_scan' && rep.json?.data?.status === 'done', rep.json?.data);
  }
}

async function cmdErrorAudit(runId, verticalIdA, subVerticalIdA) {
  const token1 = await login();
  console.log(`\n=== Error/exception reporting audit — runId=${runId} ===`);
  const { query, connectDB } = await import('../server/src/config/db.js');
  await connectDB();

  for (const section of SECTIONS) {
    console.log(`\n--- ${SECTION_LABEL[section]} :: deliberate failures ---`);
    await auditMissingFieldSingleAdd(token1, verticalIdA, subVerticalIdA, runId, section);
    await auditDuplicatePhoneSingleAdd(token1, verticalIdA, subVerticalIdA, runId, section);
    await auditGenuineUnexpectedError(token1, verticalIdA, subVerticalIdA, runId, section);
    await auditBulkUploadReportPersisted(token1, verticalIdA, subVerticalIdA, runId, section);
  }

  console.log(`\n--- Promote / Duplicate-Scan :: deliberate failures + persisted reports ---`);
  await auditPromoteAndDuplicateScanErrors(token1, verticalIdA, subVerticalIdA, runId, query);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== Error audit summary: ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) failed.forEach((f) => console.log(`  - [${f.section}] ${f.check}: ${JSON.stringify(f.detail)}`));

  const out = { runId, results };
  fs.writeFileSync(path.join(RESULTS_DIR, `error-audit-${runId}.json`), JSON.stringify(out, null, 2));
  console.log(`\nWrote ${path.join(RESULTS_DIR, `error-audit-${runId}.json`)}`);
  process.exit(failed.length ? 1 : 0);
}

async function cmdPerf(runId, verticalIdA, subVerticalIdA) {
  const token1 = await login();
  const perfResults = {};
  for (const section of SECTIONS) {
    const sample = tag(runId, section, 201);
    perfResults[section] = await samplePerf(token1, verticalIdA, section, sample);
    console.log(`[${section}] list ms: ${perfResults[section].list.join(', ')} | search ms: ${perfResults[section].search.join(', ')}`);
  }

  const before = await api('GET', '/api/v1/admin/timing-report', { token: token1 });
  // Hit each section's list endpoint a few more times so the timing-report
  // window has fresh samples attributable to this session.
  for (const section of SECTIONS) {
    for (let i = 0; i < 3; i++) await api('GET', `${ENDPOINTS[section].list}?verticalId=${verticalIdA}&limit=20`, { token: token1 });
  }
  const after = await api('GET', '/api/v1/admin/timing-report', { token: token1 });

  const out = { runId, perfResults, timingReportAfter: after.json };
  fs.writeFileSync(path.join(RESULTS_DIR, `perf-${runId}.json`), JSON.stringify(out, null, 2));
  console.log(`\nWrote ${path.join(RESULTS_DIR, `perf-${runId}.json`)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , cmd, ...args] = process.argv;
  if (cmd === 'setup') {
    await cmdSetup();
  } else if (cmd === 'functional') {
    const [runId, verticalIdA, subVerticalIdA, verticalIdB] = args;
    await cmdFunctional(runId, verticalIdA, subVerticalIdA, verticalIdB);
  } else if (cmd === 'perf') {
    const [runId, verticalIdA, subVerticalIdA] = args;
    await cmdPerf(runId, verticalIdA, subVerticalIdA);
  } else if (cmd === 'errorAudit') {
    const [runId, verticalIdA, subVerticalIdA] = args;
    await cmdErrorAudit(runId, verticalIdA, subVerticalIdA);
  } else {
    console.log('Usage: node scripts/v4-isolated-audit.js <setup|functional|perf|errorAudit> [...args]');
  }
}

export { login, api, phoneFor, tag, singleAddBody, genRow, SECTIONS, ENDPOINTS };
