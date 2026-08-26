import { query } from '../config/db.js';
import { withCache } from './cache.js';
import { CacheKeys, TTL } from '../lib/cacheKeys.js';
import { FOLLOWUP_APPEND_FIELDS } from './interactionLogImportSchema.js';

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

// Exported (not just module-private) so tests can assert directly on the
// required-field set without needing a DB connection (getLeadImportSchema
// itself queries field_configs) — see leadImportTemplate.test.js's
// phone-number-only-mandatory safeguard checks.
export const BASE_FIELDS_CALL = [
    { key: 'date', label: 'Date', csvHeader: 'Date', type: 'string', required: false,
        aliases: ['Date'] },
    { key: 'employeeName', label: 'Employee Name', csvHeader: 'Employee Name', type: 'string', required: false,
        aliases: ['Employee Name', 'Agent Name', 'Employee', 'Agent'] },
    { key: 'productService', label: 'Product/Service', csvHeader: 'Product/Service', type: 'string', required: false,
        aliases: ['Product/Service', 'Product Service', 'Business Type', 'Product', 'Service'] },
    { key: 'businessName', label: 'Lead Name', csvHeader: 'Lead Name', type: 'string', required: false, maxLength: 255,
        aliases: ['Lead Name', 'Business Name', 'Business / Person / Shop / Company Name', 'BUSINESS / PERSON / SHOP / COMPANY NAME', 'Company Name', 'Shop Name', 'Name'] },
    { key: 'contactPerson', label: 'Contact Person', csvHeader: 'Contact Person', type: 'string', required: false, maxLength: 255,
        aliases: ['Contact Person', 'Point of Contact'] },
    { key: 'phone', label: 'Contact Number', csvHeader: 'Contact Number', type: 'phone', required: true, unique: true,
        aliases: ['Contact Number', 'Mobile Number', 'CONTACT NUMBER', 'MOBILE NUMBER', 'PHONE NO', 'Phone Number', 'Mobile No', 'Mobile', 'Phone', 'Contact No', 'Contact'] },
    { key: 'alternateNumber', label: 'Alternate Number(If Any)', csvHeader: 'Alternate Number(If Any)', type: 'string', required: false,
        aliases: ['Alternate Number(If Any)', 'Alternate Number (If Any)', 'Alternate Number', 'Alt Number'] },
    { key: 'city', label: 'City', csvHeader: 'City', type: 'string', required: false,
        aliases: ['City'] },
    { key: 'area', label: 'Area', csvHeader: 'Area', type: 'string', required: false,
        aliases: ['Area'] },
    { key: 'deliveredLocation', label: 'Map Location', csvHeader: 'Map Location', type: 'string', required: false,
        aliases: ['Map Location', 'Map Location Link / Address', 'Link Address', 'Address', 'Adress'] },
    { key: 'callStatus', label: 'Call Status', csvHeader: 'Call Status', type: 'enum', options: ['Connected', 'Busy', 'Not Reachable', 'Switched Off', 'Callback Requested', 'Wrong Number', 'Disconnected'], required: false,
        aliases: ['Call Status', 'Status'] },
    { key: 'customerResponse', label: 'Customer Response', csvHeader: 'Customer Response', type: 'string', required: false,
        aliases: ['Customer Response', 'Response', 'Feedback'] },
    { key: 'followUpRequired', label: 'Follow-up Required', csvHeader: 'Follow-up Required', type: 'enum', options: ['Yes', 'No'], required: false,
        aliases: ['Follow-up Required', 'Follow Up Required', 'Follow-up Require', 'Follow Up Require (Yes/No)'] },
    { key: 'followUpDate', label: 'Follow-up Date', csvHeader: 'Follow-up Date', type: 'string', required: false,
        aliases: ['Follow-up Date', 'Follow Up Date', 'Follow-up Dates', 'Appointment Date'] },
    { key: 'followUpTime', label: 'Follow-up Time', csvHeader: 'Follow-up Time', type: 'string', required: false,
        aliases: ['Follow-up Time', 'Follow Up Time', 'Appointment Timings', 'Appointment Time'] },
    { key: 'nextAction', label: 'Next Action', csvHeader: 'Next Action', type: 'string', required: false,
        aliases: ['Next Action', 'Action'] },
    { key: 'remarks', label: 'Remarks', csvHeader: 'Remarks', type: 'string', required: false, maxLength: 500,
        aliases: ['Remarks', 'Remark', 'Notes', 'Follow-up Remarks', 'Follow Up Remarks'] },
];

export const BASE_FIELDS_POSITIVE = [
    ...BASE_FIELDS_CALL,
    { key: 'positive', label: 'Positive (Y/N)', csvHeader: 'Positive (Y/N)', type: 'enum', options: ['Y', 'N', 'Yes', 'No'], required: false,
        aliases: ['Positive (Y/N)', 'Positive(Y/N)', 'Positive', 'Positive Y/N'] },
    { key: 'converted', label: 'Converted (Y/N)', csvHeader: 'Converted (Y/N)', type: 'enum', options: ['Y', 'N', 'Yes', 'No'], required: false,
        aliases: ['Converted (Y/N)', 'Converted(Y/N)', 'Converted', 'Conversion'] },
    { key: 'appointmentDate', label: 'Appointment Date', csvHeader: 'Appointment Date', type: 'string', required: false,
        aliases: ['Appointment Date'] },
    { key: 'appointmentTime', label: 'Appointment Time', csvHeader: 'Appointment Time', type: 'string', required: false,
        aliases: ['Appointment Time', 'Appointment Timings'] },
    { key: 'followUpRemarks', label: 'Follow up Remarks', csvHeader: 'Follow up Remarks', type: 'string', required: false,
        aliases: ['Follow up Remarks', 'Follow-up Remarks'] },
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
    const baseHeaderSet = new Set(
        baseFields.flatMap(f => [
            (f.csvHeader || '').trim().toUpperCase(),
            ...(f.aliases || []).map(a => a.trim().toUpperCase())
        ])
    );

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

    return [...baseFields, ...customFields, ...FOLLOWUP_APPEND_FIELDS];
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
