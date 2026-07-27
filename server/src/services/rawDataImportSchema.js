import { query } from '../config/db.js';
import { isValidUUID } from '../utils/validators/index.js';

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
 */
const DISPLAY_ADRESS_AS_TYPO = false;

export const RAW_DATA_FIELDS = [
    { key: 'date', label: 'Date', csvHeader: 'Date', type: 'date', required: true },
    { key: 'employeeName', label: 'Employee Name', csvHeader: 'Employee Name', type: 'string', required: true, resolvesToUser: true },
    { key: 'businessType', label: 'Business Type', csvHeader: 'Business Type', type: 'string', required: false },
    { key: 'businessName', label: 'Business Name', csvHeader: 'Business Name', type: 'string', required: true, maxLength: 255 },
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

// ── Levenshtein distance — used only to suggest "closest matches" for an
// unresolved Employee Name, never to auto-pick one. ─────────────────────────
function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[m][n];
}

/**
 * Resolves a free-text employee name to exactly one user, or returns a
 * rejection with suggestions. Never guesses when there's ambiguity.
 */
export function resolveEmployeeName(name, agents) {
    const clean = (name || '').trim().toLowerCase();
    if (!clean) return { error: 'Employee Name is required' };

    const exact = agents.filter(a => a.name.trim().toLowerCase() === clean);
    if (exact.length === 1) return { userId: exact[0].id };
    if (exact.length > 1) {
        return { error: `Multiple employees named "${name}" exist — cannot resolve unambiguously. Matches: ${exact.map(a => a.name).join(', ')}` };
    }

    const substring = agents.filter(a => a.name.toLowerCase().includes(clean) || clean.includes(a.name.toLowerCase()));
    if (substring.length === 1) return { userId: substring[0].id };
    if (substring.length > 1) {
        return { error: `No exact match for employee "${name}" — closest matches: ${substring.map(a => a.name).join(', ')}` };
    }

    // Rank all agents by edit distance and surface the closest few as suggestions.
    const ranked = agents
        .map(a => ({ agent: a, distance: levenshtein(clean, a.name.toLowerCase()) }))
        .sort((x, y) => x.distance - y.distance)
        .slice(0, 3)
        .filter(r => r.distance <= Math.max(3, Math.floor(clean.length / 2)));

    if (ranked.length > 0) {
        return { error: `No matching employee found for "${name}" — closest matches: ${ranked.map(r => r.agent.name).join(', ')}` };
    }
    return { error: `No matching employee found for "${name}"` };
}

const PHONE_REGEX = /^\+?\d{7,15}$/;

export function parseFlexibleDate(value) {
    if (!value) return null;
    const str = String(value).trim();
    // ISO / yyyy-mm-dd first (unambiguous)
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(str);
    if (iso) {
        const d = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
        return Number.isNaN(d.getTime()) ? null : d;
    }
    // dd/mm/yyyy — the rest of this app's date filters use ISO inputs; for
    // slash-separated dates we assume DD/MM/YYYY (the locale field staff in
    // this app's existing forms use), not MM/DD/YYYY.
    const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(str);
    if (slash) {
        const d = new Date(Date.UTC(+slash[3], +slash[2] - 1, +slash[1]));
        return Number.isNaN(d.getTime()) ? null : d;
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

        if (field.required && !value) {
            errors.push({ field: field.key, message: `${field.label} is required` });
            continue;
        }
        if (!value) continue;

        if (field.type === 'phone' && !PHONE_REGEX.test(value.replace(/[^\d+]/g, ''))) {
            errors.push({ field: field.key, message: `${field.label} is not a valid phone number` });
        }
        if (field.type === 'date' && !parseFlexibleDate(value)) {
            errors.push({ field: field.key, message: `${field.label} is not a valid date` });
        }
        if (field.maxLength && value.length > field.maxLength) {
            errors.push({ field: field.key, message: `${field.label} exceeds ${field.maxLength} characters` });
        }
    }

    // Employee Name → assignedUserId (never stored as free text)
    let assignedUserId = null;
    const nameResult = resolveEmployeeName(row.employeeName, agents);
    if (nameResult.error) {
        errors.push({ field: 'employeeName', message: nameResult.error });
    } else {
        assignedUserId = nameResult.userId;
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

    return { errors, warnings, assignedUserId };
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
