import { query } from '../config/db.js';
import { isValidUUID } from '../utils/validators/index.js';
import { resolveEmployeeName as resolveEmployeeNameShared } from '../utils/employeeMatch.js';

/**
 * Shared schema for the "Raw Data" import feature — single source of truth
 * for the downloadable template (CSV + XLSX) AND the row validator, exactly
 * like server/src/services/leadImportSchema.js for the Leads/Positives
 * import. Fields, order, and column headers come directly from the
 * template file the user supplied.
 *
 * Product decisions made explicitly (not silently):
 * - The source file spells column H "Adress" (missing a 'd') and column E
 *   "Area " (trailing space). The internal schema `key` is clean either
 *   way ("address" / "area"); for the *label* shown to users, this is a
 *   brand-new dynamically-generated template (not a legacy file field
 *   staff have memorized), so we correct both: label is "Address" and
 *   "Area" (trimmed). If field staff push back because they specifically
 *   recognize "Adress", flip DISPLAY_ADRESS_AS_TYPO below to true.
 * - Business Type has no canonical list anywhere in this codebase (verified
 *   against field_configs and the DB) — treated as free text. New values
 *   are accepted and returned as a `warnings` entry (not rejected) so an
 *   admin notices them and can decide whether to formalize an enum later.
 * - "Appointment Date before Date" is downgraded to a *warning*, not a hard
 *   reject — there's no existing business-rule precedent in this app to
 *   confirm a hard block is correct, and the prompt's own fallback for an
 *   unconfirmed rule is to warn rather than block.
 * - Phone-number-only-mandatory policy (see CLAUDE.md / diagnosis of the
 *   55-row Delivery Data upload failure): Date and Business Name used to be
 *   `required: true` here. A real bulk upload with valid data (dash-format
 *   dates the old parser didn't handle, and business names that were
 *   present) was rejected wholesale by this over-strict rule combined with
 *   a parser gap — not by genuinely bad source data. `phoneNumber` is now
 *   the only `required: true` field in this schema; every other field
 *   (including Date and Business Name) is optional and, if present but
 *   unparseable/invalid, degrades to a warning rather than a hard reject.
 */
const DISPLAY_ADRESS_AS_TYPO = false;

export const RAW_DATA_FIELDS = [
    { key: 'date', label: 'Date', csvHeader: 'Date', type: 'date', required: false },
    { key: 'employeeName', label: 'Employee Name', csvHeader: 'Employee Name', type: 'string', required: false, resolvesToUser: true },
    { key: 'businessType', label: 'Business Type', csvHeader: 'Business Type', type: 'string', required: false },
    { key: 'businessName', label: 'Business Name', csvHeader: 'Business Name', type: 'string', required: false, maxLength: 255 },
    { key: 'area', label: 'Area', csvHeader: 'Area', type: 'string', required: false },
    { key: 'city', label: 'City', csvHeader: 'City', type: 'string', required: false },
    { key: 'phoneNumber', label: 'Phone Number', csvHeader: 'Phone Number', type: 'phone', required: true },
    { key: 'address', label: DISPLAY_ADRESS_AS_TYPO ? 'Adress' : 'Address', csvHeader: DISPLAY_ADRESS_AS_TYPO ? 'Adress' : 'Address', type: 'string', required: false },
    { key: 'appointmentDate', label: 'Appointment Date', csvHeader: 'Appointment Date', type: 'date', required: false },
    { key: 'appointmentTimings', label: 'Appointment Timings', csvHeader: 'Appointment Timings', type: 'string', required: false },
    { key: 'remarks', label: 'Remarks', csvHeader: 'Remarks', type: 'string', required: false, maxLength: 500 },
];

export async function getAssignableAgents(verticalId) {
    const res = await query(
        'SELECT id, name FROM users WHERE is_active = true AND is_approved = true AND $1 = ANY(vertical_access) ORDER BY name ASC',
        [verticalId]
    );
    return res.rows;
}

export async function getKnownBusinessTypes(verticalId) {
    const res = await query(
        `SELECT DISTINCT business_type FROM raw_data
         WHERE vertical_id = $1 AND is_deleted = false AND business_type IS NOT NULL AND business_type <> ''`,
        [verticalId]
    );
    return new Set(res.rows.map(r => r.business_type.toLowerCase()));
}

/**
 * Resolves a free-text employee name to zero or one user. Delegates to the
 * shared matcher (server/src/utils/employeeMatch.js) so Raw Data, Delivery
 * Data, and COS/Positives bulk upload can never disagree about what counts
 * as a confident match. Re-exported under this module's original name so
 * every existing import site keeps working unchanged.
 *
 * Phone-number-only-mandatory policy: this NEVER returns a hard rejection
 * anymore — an unresolved/ambiguous/blank name comes back as
 * `{ userId: null, warning }` and the row proceeds unassigned, not blocked.
 */
export const resolveEmployeeName = resolveEmployeeNameShared;

const PHONE_REGEX = /^\+?\d{7,15}$/;

// Excel's native serial-date encoding is days since 1899-12-30 (the
// standard correction that absorbs Excel's fictitious Feb-29-1900 leap
// day). Bounds chosen so a bare typed year ("2026") or a small quantity
// ("12") can never be misread as a serial date — real-world spreadsheet
// serials for 1928-2064 land in [10000, 60000).
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;

export function parseFlexibleDate(value) {
    if (value === undefined || value === null || value === '') return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

    const str = String(value).trim();
    if (!str) return null;

    // ISO / yyyy-mm-dd first (unambiguous)
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(str);
    if (iso) {
        const d = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
        return Number.isNaN(d.getTime()) ? null : d;
    }

    // dd/mm/yyyy or dd-mm-yyyy (4-digit year) — the rest of this app's date
    // filters use ISO inputs; for ambiguous separated dates we assume
    // DD-MM-YYYY (the locale field staff in this app's existing forms and
    // uploaded files use), not MM-DD-YYYY. Both '/' and '-' separators are
    // accepted — real uploads use both interchangeably (see the "23-06-26" /
    // "26-06-2026" real-world example that broke the old slash-only parser).
    const dmy4 = /^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$/.exec(str);
    if (dmy4) {
        const day = +dmy4[1], month = +dmy4[2], year = +dmy4[3];
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
            const d = new Date(Date.UTC(year, month - 1, day));
            return Number.isNaN(d.getTime()) ? null : d;
        }
    }

    // dd/mm/yy or dd-mm-yy (2-digit year) — this is the exact format the
    // real failed 55-row Delivery Data upload used for its "Date" column
    // ("23-06-26"). 2-digit years are windowed 1970-2069 (standard
    // POSIX/spreadsheet convention: <70 => 20xx, >=70 => 19xx).
    const dmy2 = /^(\d{1,2})[/\-](\d{1,2})[/\-](\d{2})$/.exec(str);
    if (dmy2) {
        const day = +dmy2[1], month = +dmy2[2], yy = +dmy2[3];
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
            const year = yy < 70 ? 2000 + yy : 1900 + yy;
            const d = new Date(Date.UTC(year, month - 1, day));
            return Number.isNaN(d.getTime()) ? null : d;
        }
    }

    // Excel serial-date number — happens when a CSV export (or an .xlsx
    // cell exceljs doesn't recognize as a Date-typed cell) carries the raw
    // numeric day-count instead of a formatted date string.
    if (/^\d+(\.\d+)?$/.test(str)) {
        const serial = parseFloat(str);
        if (serial >= 10000 && serial < 60000) {
            const d = new Date(EXCEL_EPOCH_MS + Math.round(serial) * MS_PER_DAY);
            return Number.isNaN(d.getTime()) ? null : d;
        }
    }

    const generic = new Date(str);
    return Number.isNaN(generic.getTime()) ? null : generic;
}

/**
 * Validates one normalized row (schema key -> raw value) against
 * RAW_DATA_FIELDS. `agents` and `knownBusinessTypes` are fetched once per
 * batch by the caller (never per-row) and passed in — this function is
 * pure otherwise, so it's unit-testable without a DB.
 *
 * Returns { errors: [{field,message}], warnings: [{field,message}], assignedUserId }.
 */
export function validateRawDataRow(row, { agents, knownBusinessTypes }) {
    const errors = [];
    const warnings = [];

    for (const field of RAW_DATA_FIELDS) {
        if (field.resolvesToUser) continue; // handled separately below
        const raw = row[field.key];
        const value = raw === undefined || raw === null ? '' : String(raw).trim();

        // Phone-number-only-mandatory policy: `required` today only ever
        // means `phoneNumber` (see RAW_DATA_FIELDS above) — kept generic
        // here rather than hardcoding the key, so a future required field
        // doesn't need this function edited too.
        if (field.required && !value) {
            errors.push({ field: field.key, message: `${field.label} is required` });
            continue;
        }
        if (!value) continue;

        if (field.type === 'phone' && !PHONE_REGEX.test(value.replace(/[^\d+]/g, ''))) {
            errors.push({ field: field.key, message: `${field.label} is not a valid phone number` });
        }
        // A present-but-unparseable date is a warning, not a hard reject —
        // the row still inserts with that field left null (see file header
        // "phone-number-only-mandatory policy" note).
        if (field.type === 'date' && !parseFlexibleDate(value)) {
            warnings.push({ field: field.key, message: `${field.label} ("${value}") could not be parsed as a date — accepted, left blank` });
        }
        if (field.maxLength && value.length > field.maxLength) {
            errors.push({ field: field.key, message: `${field.label} exceeds ${field.maxLength} characters` });
        }
    }

    // Employee Name → assignedUserId, best-effort. Never blocks the row:
    // unresolved/ambiguous/blank names come back as a warning (or nothing,
    // if blank) with assignedUserId left null, never an error.
    const nameResult = resolveEmployeeName(row.employeeName, agents);
    const assignedUserId = nameResult.userId;
    const employeeNameRaw = nameResult.rawName || '';
    if (nameResult.warning) {
        warnings.push({ field: 'employeeName', message: nameResult.warning });
    }

    // Business Type: accept-and-flag new values (no hard-reject — no canonical list exists)
    const businessType = (row.businessType || '').trim();
    if (businessType && knownBusinessTypes && !knownBusinessTypes.has(businessType.toLowerCase())) {
        warnings.push({ field: 'businessType', message: `"${businessType}" is a new Business Type not seen before — accepted, flagged for review` });
    }

    // Date vs Appointment Date — warning only, not a hard block (see file header decision)
    const dateVal = parseFlexibleDate(row.date);
    const apptVal = parseFlexibleDate(row.appointmentDate);
    if (dateVal && apptVal && apptVal < dateVal) {
        warnings.push({ field: 'appointmentDate', message: 'Appointment Date is earlier than the visit Date — accepted, please verify' });
    }

    return { errors, warnings, assignedUserId, employeeNameRaw };
}

// ── List/export filter & sort helpers ──────────────────────────────────────
// Shared by the GET /raw-data list endpoint and the GET /raw-data/export/csv
// endpoint (server/src/controllers/rawData.js), so a query string can never
// be filtered differently by the two — one builder, two callers.

const RAW_DATA_SORT_COLUMNS = {
    date: 'r.date',
    businessName: 'r.business_name',
    city: 'r.city',
    createdAt: 'r.created_at',
};

export function resolveRawDataSortColumn(sortBy) {
    return RAW_DATA_SORT_COLUMNS[sortBy] || RAW_DATA_SORT_COLUMNS.createdAt;
}

/**
 * Builds additional WHERE clauses/params for raw_data queries, on top of the
 * mandatory vertical_id/is_deleted clauses the caller already owns.
 * `startIdx` is the next free $N placeholder index.
 */
export function buildRawDataFilters(queryParams, startIdx) {
    const { assignedUserId, search, dateFrom, dateTo, businessType, city } = queryParams;
    const clauses = [];
    const params = [];
    let idx = startIdx;

    if (assignedUserId && isValidUUID(assignedUserId)) {
        clauses.push(`r.assigned_user_id = $${idx++}`);
        params.push(assignedUserId);
    }
    if (search && search.trim().length >= 2) {
        clauses.push(`(r.business_name ILIKE $${idx} OR r.phone_number ILIKE $${idx})`);
        params.push(`%${search.trim()}%`);
        idx++;
    }
    if (dateFrom) {
        clauses.push(`r.date >= $${idx++}`);
        params.push(dateFrom);
    }
    if (dateTo) {
        clauses.push(`r.date <= $${idx++}`);
        params.push(dateTo);
    }
    if (businessType && businessType.trim()) {
        clauses.push(`r.business_type ILIKE $${idx++}`);
        params.push(`%${businessType.trim()}%`);
    }
    if (city && city.trim()) {
        clauses.push(`r.city ILIKE $${idx++}`);
        params.push(`%${city.trim()}%`);
    }

    return { clauses, params, nextIdx: idx };
}

export default RAW_DATA_FIELDS;
