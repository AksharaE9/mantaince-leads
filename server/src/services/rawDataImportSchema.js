import { query } from '../config/db.js';
import { isValidUUID } from '../utils/validators/index.js';
import { resolveEmployeeName as resolveEmployeeNameShared } from '../utils/employeeMatch.js';

/**
 * Shared schema for the "Raw Data" import feature — single source of truth
 * for the downloadable template (CSV + XLSX) AND the row validator, exactly
 * like server/src/services/leadImportSchema.js for the Leads/Positives
 * import. Fields, order, and column headers come directly from the
 * template file the user supplied in the Excel photos.
 *
 * Mandatory policy:
 * - `phoneNumber` (Mobile Number) is the ONLY `required: true` field in this schema;
 *   it acts as the primary key for duplicate detection.
 * - Every other field (including Date, Lead Name, etc.) is optional and, if present
 *   but unparseable/invalid, degrades to a warning rather than a hard reject.
 */

export const RAW_DATA_FIELDS = [
    { key: 'date', label: 'Date', csvHeader: 'Date', type: 'date', required: false },
    { key: 'employeeName', label: 'Employee Name', csvHeader: 'Employee Name', type: 'string', required: false, resolvesToUser: true },
    { key: 'productService', label: 'Product/Service', csvHeader: 'Product/Service', type: 'string', required: false },
    { key: 'leadName', label: 'Lead Name', csvHeader: 'Lead Name', type: 'string', required: false, maxLength: 255 },
    { key: 'contactPerson', label: 'Contact Person', csvHeader: 'Contact Person', type: 'string', required: false, maxLength: 255 },
    { key: 'phoneNumber', label: 'Mobile Number', csvHeader: 'Mobile Number', type: 'phone', required: true, unique: true },
    { key: 'alternateNumber', label: 'Alternate Number(If Any)', csvHeader: 'Alternate Number(If Any)', type: 'string', required: false },
    { key: 'city', label: 'City', csvHeader: 'City', type: 'string', required: false },
    { key: 'area', label: 'Area', csvHeader: 'Area', type: 'string', required: false },
    { key: 'mapLocation', label: 'Map Location', csvHeader: 'Map Location', type: 'string', required: false },
    { key: 'callStatus', label: 'Call Status', csvHeader: 'Call Status', type: 'enum', options: ['Connected', 'Busy', 'Not Reachable', 'Switched Off', 'Callback Requested', 'Wrong Number', 'Disconnected'], required: false },
    { key: 'customerResponse', label: 'Customer Response', csvHeader: 'Customer Response', type: 'string', required: false },
    { key: 'followUpRequired', label: 'Follow-up Required', csvHeader: 'Follow-up Required', type: 'enum', options: ['Yes', 'No'], required: false },
    { key: 'followUpDate', label: 'Follow-up Date', csvHeader: 'Follow-up Date', type: 'date', required: false },
    { key: 'followUpTime', label: 'Follow-up Time', csvHeader: 'Follow-up Time', type: 'string', required: false },
    { key: 'nextAction', label: 'Next Action', csvHeader: 'Next Action', type: 'string', required: false },
    { key: 'remarks', label: 'Remarks', csvHeader: 'Remarks', type: 'string', required: false, maxLength: 500 },
    { key: 'converted', label: 'Converted (Y/N)', csvHeader: 'Converted (Y/N)', type: 'enum', options: ['Y', 'N', 'Yes', 'No'], required: false },
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
        `SELECT DISTINCT COALESCE(product_service, business_type) AS val FROM raw_data
         WHERE vertical_id = $1 AND is_deleted = false AND (product_service IS NOT NULL OR business_type IS NOT NULL)`,
        [verticalId]
    );
    return new Set(res.rows.map(r => (r.val || '').toLowerCase()).filter(Boolean));
}

/**
 * Resolves a free-text employee name to zero or one user. Delegates to the
 * shared matcher (server/src/utils/employeeMatch.js) so Raw Data, Delivery
 * Data, and COS/Positives bulk upload can never disagree about what counts
 * as a confident match.
 */
export const resolveEmployeeName = resolveEmployeeNameShared;

const PHONE_REGEX = /^\+?\d{7,15}$/;

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

    // dd/mm/yyyy or dd-mm-yyyy (4-digit year)
    const dmy4 = /^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$/.exec(str);
    if (dmy4) {
        const day = +dmy4[1], month = +dmy4[2], year = +dmy4[3];
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
            const d = new Date(Date.UTC(year, month - 1, day));
            return Number.isNaN(d.getTime()) ? null : d;
        }
    }

    // dd/mm/yy or dd-mm-yy (2-digit year)
    const dmy2 = /^(\d{1,2})[/\-](\d{1,2})[/\-](\d{2})$/.exec(str);
    if (dmy2) {
        const day = +dmy2[1], month = +dmy2[2], yy = +dmy2[3];
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
            const year = yy < 70 ? 2000 + yy : 1900 + yy;
            const d = new Date(Date.UTC(year, month - 1, day));
            return Number.isNaN(d.getTime()) ? null : d;
        }
    }

    // Excel serial-date number
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
 * Validates one normalized row (schema key -> raw value) against RAW_DATA_FIELDS.
 * Returns { errors: [{field,message}], warnings: [{field,message}], assignedUserId, employeeNameRaw }.
 */
export function validateRawDataRow(row, { agents, knownBusinessTypes } = {}) {
    const errors = [];
    const warnings = [];

    for (const field of RAW_DATA_FIELDS) {
        if (field.resolvesToUser) continue; // handled separately below
        const raw = row[field.key];
        const value = raw === undefined || raw === null ? '' : String(raw).trim();

        // Phone-number-only-mandatory policy: `phoneNumber` is required
        if (field.required && !value) {
            errors.push({ field: field.key, message: `${field.label} is required` });
            continue;
        }
        if (!value) continue;

        if (field.type === 'phone' && !PHONE_REGEX.test(value.replace(/[^\d+]/g, ''))) {
            errors.push({ field: field.key, message: `${field.label} is not a valid phone number` });
        }
        // A present-but-unparseable date is a warning, not a hard reject
        if (field.type === 'date' && !parseFlexibleDate(value)) {
            warnings.push({ field: field.key, message: `${field.label} ("${value}") could not be parsed as a date — accepted, left blank` });
        }
        if (field.maxLength && value.length > field.maxLength) {
            errors.push({ field: field.key, message: `${field.label} exceeds ${field.maxLength} characters` });
        }
    }

    // Employee Name → assignedUserId, best-effort
    const nameResult = resolveEmployeeName(row.employeeName, agents);
    const assignedUserId = nameResult.userId;
    const employeeNameRaw = nameResult.rawName || '';
    if (nameResult.warning) {
        warnings.push({ field: 'employeeName', message: nameResult.warning });
    }

    // Product/Service / Business Type warning for unknown options (non-blocking)
    const productService = (row.productService || row.businessType || '').trim();
    if (productService && knownBusinessTypes && knownBusinessTypes.size > 0 && !knownBusinessTypes.has(productService.toLowerCase())) {
        warnings.push({ field: 'productService', message: `"${productService}" is a new Product/Service not seen before — accepted, flagged for review` });
    }

    // Follow-up Date vs Visit Date validation
    const dateVal = parseFlexibleDate(row.date);
    const followUpVal = parseFlexibleDate(row.followUpDate || row.appointmentDate);
    if (dateVal && followUpVal && followUpVal < dateVal) {
        warnings.push({ field: 'followUpDate', message: 'Follow-up Date is earlier than the record Date — accepted, please verify' });
    }

    return { errors, warnings, assignedUserId, employeeNameRaw };
}

// ── List/export filter & sort helpers ──────────────────────────────────────

const RAW_DATA_SORT_COLUMNS = {
    date: 'r.date',
    leadName: 'COALESCE(r.lead_name, r.business_name)',
    businessName: 'COALESCE(r.lead_name, r.business_name)',
    contactPerson: 'r.contact_person',
    phoneNumber: 'r.phone_number',
    city: 'r.city',
    area: 'r.area',
    callStatus: 'r.call_status',
    followUpDate: 'r.follow_up_date',
    converted: 'r.converted',
    createdAt: 'r.created_at',
};

export function resolveRawDataSortColumn(sortBy) {
    return RAW_DATA_SORT_COLUMNS[sortBy] || RAW_DATA_SORT_COLUMNS.createdAt;
}

/**
 * Builds additional WHERE clauses/params for raw_data queries.
 */
export function buildRawDataFilters(queryParams, startIdx) {
    const { subVerticalId, assignedUserId, search, dateFrom, dateTo, productService, businessType, city, area, callStatus, converted } = queryParams;
    const clauses = [];
    const params = [];
    let idx = startIdx;

    if (subVerticalId && isValidUUID(subVerticalId)) {
        clauses.push(`r.sub_vertical_id = $${idx++}`);
        params.push(subVerticalId);
    }
    if (assignedUserId && isValidUUID(assignedUserId)) {
        clauses.push(`r.assigned_user_id = $${idx++}`);
        params.push(assignedUserId);
    }
    if (search && search.trim().length >= 2) {
        clauses.push(`(r.lead_name ILIKE $${idx} OR r.business_name ILIKE $${idx} OR r.contact_person ILIKE $${idx} OR r.phone_number ILIKE $${idx} OR r.alternate_number ILIKE $${idx})`);
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
    const prod = productService || businessType;
    if (prod && prod.trim()) {
        clauses.push(`(r.product_service ILIKE $${idx} OR r.business_type ILIKE $${idx})`);
        params.push(`%${prod.trim()}%`);
        idx++;
    }
    if (city && city.trim()) {
        clauses.push(`r.city ILIKE $${idx++}`);
        params.push(`%${city.trim()}%`);
    }
    if (area && area.trim()) {
        clauses.push(`r.area ILIKE $${idx++}`);
        params.push(`%${area.trim()}%`);
    }
    if (callStatus && callStatus.trim()) {
        clauses.push(`r.call_status ILIKE $${idx++}`);
        params.push(`%${callStatus.trim()}%`);
    }
    if (converted && converted.trim()) {
        clauses.push(`r.converted ILIKE $${idx++}`);
        params.push(`%${converted.trim()}%`);
    }

    return { clauses, params, nextIdx: idx };
}

export default RAW_DATA_FIELDS;
