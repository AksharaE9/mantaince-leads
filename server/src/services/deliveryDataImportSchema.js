import { query } from '../config/db.js';
import { isValidUUID } from '../utils/validators/index.js';
import {
    RAW_DATA_FIELDS,
    validateRawDataRow,
    getAssignableAgents,
    parseFlexibleDate,
} from './rawDataImportSchema.js';

/**
 * Shared schema for the "Delivery Data" import feature — a sibling of Raw
 * Data, not a variant of it. Fields 1-11 are the exact same fields as
 * RAW_DATA_FIELDS (spread from that module, not copy-pasted, so a future
 * change to a shared field's validation rule is inherited automatically).
 * Fields 12-13 (Delivery Date, Delivery Time) are appended at the end.
 *
 * Product decisions made explicitly (not silently):
 * - Delivery Time has no "flexible time-range parser" to reuse — Appointment
 *   Timings (the field this was modeled after) doesn't have one either, it's
 *   a plain required-less text field. Delivery Time follows the same real
 *   precedent: a required text field, no format enforcement beyond length.
 * - Delivery Date earlier than the visit Date or Appointment Date is a
 *   *warning*, not a hard reject — mirrors the existing Raw Data precedent
 *   for "Appointment Date before Date" (see rawDataImportSchema.js).
 * - Unlike Raw Data (one canonical record per phone number, hard-rejects
 *   duplicates), Delivery Data models a delivery *event log* — the same
 *   business can receive many deliveries over time. There is deliberately no
 *   phone-uniqueness rule here; duplicate detection in the bulk processor
 *   uses a composite key (phone + deliveryDate + deliveryTime) instead, to
 *   catch accidental re-uploads of the same event without blocking
 *   legitimate repeat business.
 */
export const DELIVERY_DATA_FIELDS = [
    ...RAW_DATA_FIELDS,
    { key: 'deliveryDate', label: 'Delivery Date', csvHeader: 'Delivery Date', type: 'date', required: false },
    { key: 'deliveryTime', label: 'Delivery Time', csvHeader: 'Delivery Time', type: 'string', required: false, maxLength: 100 },
];

export async function getKnownBusinessTypes(verticalId) {
    const res = await query(
        `SELECT DISTINCT business_type FROM delivery_data
         WHERE vertical_id = $1 AND is_deleted = false AND business_type IS NOT NULL AND business_type <> ''`,
        [verticalId]
    );
    return new Set(res.rows.map(r => r.business_type.toLowerCase()));
}

// Re-exported so controllers/processors only need to import from this one
// module, mirroring the ergonomics of rawDataImportSchema.js.
export { getAssignableAgents };

/**
 * Validates one normalized row (schema key -> raw value) against
 * DELIVERY_DATA_FIELDS. Delegates the 11 shared fields to
 * validateRawDataRow() so the two features can never disagree about what's
 * valid for fields they hold in common, then validates the 2 new fields and
 * the Delivery Date consistency rule on top.
 */
export function validateDeliveryDataRow(row, { agents, knownBusinessTypes }) {
    const { errors, warnings, assignedUserId, employeeNameRaw } = validateRawDataRow(row, { agents, knownBusinessTypes });

    const deliveryDateRaw = row.deliveryDate;
    const deliveryDateValue = deliveryDateRaw === undefined || deliveryDateRaw === null ? '' : String(deliveryDateRaw).trim();
    // Present-but-unparseable is a warning, not a hard reject — same
    // phone-number-only-mandatory policy as every other date field.
    if (deliveryDateValue && !parseFlexibleDate(deliveryDateValue)) {
        warnings.push({ field: 'deliveryDate', message: `Delivery Date ("${deliveryDateValue}") could not be parsed as a date — accepted, left blank` });
    }

    const deliveryTimeRaw = row.deliveryTime;
    const deliveryTimeValue = deliveryTimeRaw === undefined || deliveryTimeRaw === null ? '' : String(deliveryTimeRaw).trim();
    if (deliveryTimeValue && deliveryTimeValue.length > 100) {
        errors.push({ field: 'deliveryTime', message: 'Delivery Time exceeds 100 characters' });
    }

    // Delivery Date vs visit Date / Appointment Date — warning only, same
    // fallback rule Raw Data already uses for Appointment-Date-vs-Date.
    const deliveryDateParsed = parseFlexibleDate(deliveryDateValue);
    const dateParsed = parseFlexibleDate(row.date);
    const apptParsed = parseFlexibleDate(row.appointmentDate);
    if (deliveryDateParsed && dateParsed && deliveryDateParsed < dateParsed) {
        warnings.push({ field: 'deliveryDate', message: 'Delivery Date is earlier than the visit Date — accepted, please verify' });
    }
    if (deliveryDateParsed && apptParsed && deliveryDateParsed < apptParsed) {
        warnings.push({ field: 'deliveryDate', message: 'Delivery Date is earlier than the Appointment Date — accepted, please verify' });
    }

    return { errors, warnings, assignedUserId, employeeNameRaw };
}

// ── linkedRawDataId auto-matching ───────────────────────────────────────────
// Never guesses on an ambiguous match (same philosophy as Employee Name
// resolution in rawDataImportSchema.js): multiple candidates = not linked,
// with a warning explaining why, rather than picking one silently.

/**
 * Batched lookup for the bulk processor — one query per key across the
 * whole file, not one query per row (same discipline as the existing
 * phone-dedup batching in rawDataProcessor.js).
 */
export async function findLinkedRawDataBatch(verticalId, phones, businessNames) {
    const phoneMap = new Map();
    const nameMap = new Map();

    const uniquePhones = [...new Set(phones.filter(Boolean))];
    const uniqueNames = [...new Set(businessNames.map(n => (n || '').trim().toLowerCase()).filter(Boolean))];

    if (uniquePhones.length > 0) {
        const res = await query(
            'SELECT id, phone_number FROM raw_data WHERE vertical_id = $1 AND is_deleted = false AND phone_number = ANY($2)',
            [verticalId, uniquePhones]
        );
        for (const row of res.rows) {
            if (!phoneMap.has(row.phone_number)) phoneMap.set(row.phone_number, []);
            phoneMap.get(row.phone_number).push(row.id);
        }
    }
    if (uniqueNames.length > 0) {
        const res = await query(
            `SELECT id, lower(business_name) AS name FROM raw_data
             WHERE vertical_id = $1 AND is_deleted = false AND lower(business_name) = ANY($2)`,
            [verticalId, uniqueNames]
        );
        for (const row of res.rows) {
            if (!nameMap.has(row.name)) nameMap.set(row.name, []);
            nameMap.get(row.name).push(row.id);
        }
    }
    return { phoneMap, nameMap };
}

/**
 * Resolves a single row's linkedRawDataId from pre-fetched batch maps.
 * Phone match takes priority over business-name match.
 */
export function resolveLinkedRawDataId(phone, businessName, { phoneMap, nameMap }) {
    if (phone && phoneMap.has(phone)) {
        const ids = phoneMap.get(phone);
        if (ids.length === 1) return { linkedRawDataId: ids[0], matchType: 'phone', confidence: 'high' };
        return {
            linkedRawDataId: null, matchType: 'phone', confidence: 'ambiguous',
            warning: `Multiple Raw Data records share phone number "${phone}" — not auto-linked`,
        };
    }

    const name = (businessName || '').trim().toLowerCase();
    if (name && nameMap.has(name)) {
        const ids = nameMap.get(name);
        if (ids.length === 1) return { linkedRawDataId: ids[0], matchType: 'business_name', confidence: 'medium' };
        return {
            linkedRawDataId: null, matchType: 'business_name', confidence: 'ambiguous',
            warning: `Multiple Raw Data records share business name "${(businessName || '').trim()}" — not auto-linked`,
        };
    }

    return {
        linkedRawDataId: null, matchType: null, confidence: null,
        warning: 'No matching Raw Data record found by phone/business name — inserted as a standalone Delivery Data row',
    };
}

/**
 * Single-row convenience wrapper around the batched lookup, for the
 * single-add controller path (one row, so batching has no benefit there).
 */
export async function findLinkedRawData(verticalId, phoneNumber, businessName) {
    const phone = (phoneNumber || '').replace(/[^\d+]/g, '');
    const { phoneMap, nameMap } = await findLinkedRawDataBatch(verticalId, [phone], [businessName]);
    return resolveLinkedRawDataId(phone, businessName, { phoneMap, nameMap });
}

// ── List/export filter & sort helpers ──────────────────────────────────────
// Shared by the GET /delivery-data list endpoint and the
// GET /delivery-data/export/csv endpoint (server/src/controllers/deliveryData.js).
// Deliberately a separate (near-identical) builder from
// rawDataImportSchema.js#buildRawDataFilters rather than a shared generic
// one across both tables — same design stance as the rest of this module:
// Delivery Data and Raw Data are siblings with their own query surface, not
// one entity with optional columns.

const DELIVERY_DATA_SORT_COLUMNS = {
    date: 'd.date',
    businessName: 'd.business_name',
    city: 'd.city',
    createdAt: 'd.created_at',
    deliveryDate: 'd.delivery_date',
};

export function resolveDeliveryDataSortColumn(sortBy) {
    return DELIVERY_DATA_SORT_COLUMNS[sortBy] || DELIVERY_DATA_SORT_COLUMNS.createdAt;
}

/**
 * Builds additional WHERE clauses/params for delivery_data queries, on top
 * of the mandatory vertical_id/is_deleted clauses the caller already owns.
 * `startIdx` is the next free $N placeholder index.
 */
export function buildDeliveryDataFilters(queryParams, startIdx) {
    const { assignedUserId, search, dateFrom, dateTo, businessType, city } = queryParams;
    const clauses = [];
    const params = [];
    let idx = startIdx;

    if (assignedUserId && isValidUUID(assignedUserId)) {
        clauses.push(`d.assigned_user_id = $${idx++}`);
        params.push(assignedUserId);
    }
    if (search && search.trim().length >= 2) {
        clauses.push(`(d.business_name ILIKE $${idx} OR d.phone_number ILIKE $${idx})`);
        params.push(`%${search.trim()}%`);
        idx++;
    }
    if (dateFrom) {
        clauses.push(`d.date >= $${idx++}`);
        params.push(dateFrom);
    }
    if (dateTo) {
        clauses.push(`d.date <= $${idx++}`);
        params.push(dateTo);
    }
    if (businessType && businessType.trim()) {
        clauses.push(`d.business_type ILIKE $${idx++}`);
        params.push(`%${businessType.trim()}%`);
    }
    if (city && city.trim()) {
        clauses.push(`d.city ILIKE $${idx++}`);
        params.push(`%${city.trim()}%`);
    }

    return { clauses, params, nextIdx: idx };
}

export default DELIVERY_DATA_FIELDS;
