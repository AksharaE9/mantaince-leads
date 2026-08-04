import { query } from '../config/db.js';
import { withCache } from './cache.js';
import { CacheKeys, TTL } from '../lib/cacheKeys.js';

/**
 * Single source of truth for the lead-import field set.
 *
 * Both the downloadable template (CSV + XLSX) and the server-side upload
 * validator import this module, so the two can never drift apart the way
 * they used to when the header list lived twice: once as a Set of literal
 * strings in csv.js, and once again as ad-hoc `dataMap[...] =` assignments
 * in csvProcessor.js.
 *
 * Fixed columns are the same for every vertical (they map to the JSONB
 * `data` column on `cost_conversions`); per-vertical custom fields come
 * from `field_configs` and are appended dynamically so the template never
 * goes stale when an admin adds a new custom field.
 *
 * Phone-number-only-mandatory policy: `phone` is the only `required: true`
 * field below. `businessName` used to be required too; it's now optional
 * like every other field, matching Raw Data/Delivery Data (see
 * `rawDataImportSchema.js`'s file-header note and CLAUDE.md). NOTE: the
 * live bulk-upload pipeline (`server/src/jobs/csvProcessor.js`) has its own
 * hardcoded validation and does NOT call `validateRowAgainstSchema` below —
 * that function exists but isn't wired into the actual upload path, so this
 * schema change alone does not change bulk-upload behavior. The matching
 * hard-block in `csvProcessor.js` was removed separately; if a future
 * refactor makes `csvProcessor.js` call `validateRowAgainstSchema` instead,
 * this file is already correct for that.
 */

const BASE_FIELDS_CALL = [
    { key: 'date', label: 'Date', csvHeader: 'DATE', type: 'string', required: false },
    { key: 'employeeName', label: 'Employee Name', csvHeader: 'EMPLOYEE NAME', type: 'string', required: false },
    { key: 'businessType', label: 'Business Type', csvHeader: 'BUSINESS TYPE', type: 'string', required: false },
    { key: 'businessName', label: 'Business / Person / Shop / Company Name', csvHeader: 'BUSINESS / PERSON / SHOP / COMPANY NAME', type: 'string', required: false, maxLength: 255 },
    { key: 'phone', label: 'Contact Number', csvHeader: 'CONTACT NUMBER', type: 'phone', required: true, unique: true },
    { key: 'pointOfContact', label: 'Point of Contact', csvHeader: 'POINT OF CONTACT', type: 'string', required: false },
    { key: 'area', label: 'Area', csvHeader: 'AREA', type: 'string', required: false },
    { key: 'city', label: 'City', csvHeader: 'CITY', type: 'string', required: false },
    { key: 'deliveredLocation', label: 'Link Address', csvHeader: 'LINK ADDRESS', type: 'string', required: false },
    { key: 'remarks', label: 'Remarks', csvHeader: 'REMARKS', type: 'string', required: false },
    { key: 'recordings', label: 'Recordings', csvHeader: 'RECORDINGS', type: 'string', required: false },
    { key: 'appointmentType', label: 'Appointment Type (Yes or No)', csvHeader: 'APPOINTMENT TYPE (YES OR NO)', type: 'enum', options: ['Yes', 'No'], required: false },
    { key: 'appointmentDate', label: 'Appointment Date', csvHeader: 'APPOINTMENT DATE', type: 'string', required: false },
    { key: 'appointmentTime', label: 'Appointment Time', csvHeader: 'APPOINTMENT TIME', type: 'string', required: false },
    { key: 'requirement', label: 'Requirement Order if Any', csvHeader: 'REQUIREMENT ORDER IF ANY', type: 'string', required: false },
    { key: 'notes', label: 'Notes to the COS if Any', csvHeader: 'NOTES TO THE COS IF ANY', type: 'string', required: false },
];

const BASE_FIELDS_POSITIVE = [
    { key: 'date', label: 'Date', csvHeader: 'DATE', type: 'string', required: false },
    { key: 'employeeName', label: 'Employee Name', csvHeader: 'EMPLOYEE NAME', type: 'string', required: false },
    { key: 'businessType', label: 'Business Type', csvHeader: 'BUSINESS TYPE', type: 'string', required: false },
    { key: 'businessName', label: 'Business / Person / Shop / Company Name', csvHeader: 'BUSINESS / PERSON / SHOP / COMPANY NAME', type: 'string', required: false, maxLength: 255 },
    { key: 'area', label: 'Area', csvHeader: 'AREA', type: 'string', required: false },
    { key: 'city', label: 'City', csvHeader: 'CITY', type: 'string', required: false },
    { key: 'phone', label: 'Contact Number', csvHeader: 'CONTACT NUMBER', type: 'phone', required: true, unique: true },
    { key: 'pointOfContact', label: 'Point of Contact', csvHeader: 'POINT OF CONTACT', type: 'string', required: false },
    { key: 'remarks', label: 'Remarks', csvHeader: 'REMARKS', type: 'string', required: false },
    { key: 'recordings', label: 'Recordings', csvHeader: 'RECORDINGS', type: 'string', required: false },
    { key: 'followUpRequired', label: 'Follow-Up Required', csvHeader: 'FOLLOW-UP REQUIRED', type: 'enum', options: ['Yes', 'No'], required: false },
    { key: 'followUps', label: 'Follow-Ups', csvHeader: 'FOLLOW-UPS', type: 'string', required: false },
    { key: 'followUpDates', label: 'Follow-Up Dates', csvHeader: 'FOLLOW-UP DATES', type: 'string', required: false },
    { key: 'followUpRemarks', label: 'Follow-Up Remarks', csvHeader: 'FOLLOW-UP REMARKS', type: 'string', required: false },
    { key: 'requirement', label: 'Requirement if Any', csvHeader: 'REQUIREMENT IF ANY', type: 'string', required: false },
    { key: 'notes', label: 'A Notes to the COS Team Only', csvHeader: 'A NOTES TO THE COS TEAM ONLY', type: 'string', required: false },
];

// field_configs.field_type values (see CreateFieldConfigBody in validators/index.js)
// that carry a fixed option list and should render as a dropdown in the template.
const ENUM_FIELD_TYPES = new Set(['select', 'multiselect', 'boolean']);

/**
 * Returns the ordered field list for one vertical + lead type: fixed base
 * fields followed by that vertical's active, CSV-mapped custom fields.
 * Custom fields whose header collides with a base header are dropped to
 * avoid duplicate columns (mirrors the prior de-dup behavior in csv.js).
 */
export async function getLeadImportSchema(verticalId, leadType = 'CALL') {
    const isPositive = leadType === 'POSITIVE';
    const baseFields = isPositive ? BASE_FIELDS_POSITIVE : BASE_FIELDS_CALL;
    const baseHeaderSet = new Set(baseFields.map(f => f.csvHeader));

    const configs = await withCache(CacheKeys.fieldConfigs(verticalId), TTL.FIELD_CONFIGS, async () => {
        const r = await query(
            'SELECT field_key, csv_header, label, field_type, options, is_required, is_csv_mapped, display_order FROM field_configs WHERE vertical_id = $1 AND is_active = true ORDER BY display_order ASC',
            [verticalId]
        );
        return r.rows;
    });

    const customFields = configs
        .filter(c => c.is_csv_mapped)
        .map(c => {
            const header = (c.csv_header || c.label || '').trim().toUpperCase();
            return {
                key: c.field_key,
                label: c.label,
                csvHeader: header,
                type: ENUM_FIELD_TYPES.has(c.field_type) && c.options?.length ? 'enum' : (c.field_type === 'phone' || c.field_type === 'email' ? c.field_type : 'string'),
                options: c.options || undefined,
                required: !!c.is_required,
                custom: true,
            };
        })
        .filter(f => f.csvHeader && !baseHeaderSet.has(f.csvHeader));

    return [...baseFields, ...customFields];
}

/**
 * Fetches the live list of agents with access to this vertical, for the
 * "Employee Name" dropdown in the .xlsx template. Never hardcoded/cached
 * beyond field_configs' own TTL — new hires show up on the next download.
 */
export async function getAssignableAgentNames(verticalId) {
    const res = await query(
        'SELECT name FROM users WHERE is_active = true AND is_approved = true AND $1 = ANY(vertical_access) ORDER BY name ASC',
        [verticalId]
    );
    return res.rows.map(r => r.name);
}

const PHONE_REGEX = /^\+?\d{7,15}$/;

/**
 * Validates one already-normalized data-map (schema key -> value) against
 * the schema's `required`/`type` rules. Returns a list of
 * { field, message } errors (empty if the row is valid). Pure/no I/O so
 * it can run identically on the client (preview) and server (authoritative).
 */
export function validateRowAgainstSchema(dataMap, schema) {
    const errors = [];
    for (const field of schema) {
        const raw = dataMap[field.key];
        const value = raw === undefined || raw === null ? '' : String(raw).trim();

        if (field.required && !value) {
            errors.push({ field: field.key, message: `${field.label} is required` });
            continue;
        }
        if (!value) continue;

        if (field.type === 'phone' && !PHONE_REGEX.test(value.replace(/[^\d+]/g, ''))) {
            errors.push({ field: field.key, message: `${field.label} is not a valid phone number` });
        }
        if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
            errors.push({ field: field.key, message: `${field.label} is not a valid email address` });
        }
        if (field.type === 'enum' && field.options?.length && !field.options.some(o => o.toLowerCase() === value.toLowerCase())) {
            errors.push({ field: field.key, message: `"${value}" is not a valid ${field.label} option` });
        }
        if (field.maxLength && value.length > field.maxLength) {
            errors.push({ field: field.key, message: `${field.label} exceeds ${field.maxLength} characters` });
        }
    }
    return errors;
}
