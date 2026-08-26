import crypto from 'crypto';
import { query } from '../config/db.js';
import { cacheSet } from '../services/cache.js';
import { broadcastToAll } from '../services/assignmentBroadcaster.js';
import { parseUploadBuffer } from '../services/spreadsheetParser.js';
import {
    validateDeliveryDataRow,
    getAssignableAgents,
    getKnownBusinessTypes,
    findLinkedRawDataBatch,
    resolveLinkedRawDataId,
} from '../services/deliveryDataImportSchema.js';
import { parseFlexibleDate } from '../services/rawDataImportSchema.js';
import { bulkInsert } from '../db/bulkInsert.js';
import { ErrorCodes } from '../utils/operationError.js';
import { logger } from '../lib/logger.js';

const BATCH_SIZE = 500;

const DELIVERY_DATA_COLUMNS = [
    'id', 'vertical_id', 'assigned_user_id', 'date', 'business_type', 'business_name',
    'contact_person', 'phone_number', 'alternate_number',
    'area', 'city', 'address',
    'call_status', 'customer_response', 'follow_up_required',
    'follow_up_date', 'follow_up_time', 'next_action', 'remarks', 'converted',
    'appointment_date', 'appointment_timings',
    'delivery_date', 'delivery_time',
    'linked_raw_data_id', 'source', 'csv_batch_id', 'created_by', 'employee_name_raw',
];

function normalizeRowKeys(rawRow) {
    const row = {};
    for (const k of Object.keys(rawRow)) {
        const key = k.toLowerCase().trim().replace(/\r?\n/g, ' ').replace(/\s+/g, ' ');
        if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') {
            row[key] = rawRow[k];
        }
    }
    return row;
}

// ── Header alias maps ────────────────────────────────────────────────────────
// Two-tier matching strategy (same pattern as rawDataProcessor.js):
//
// Tier 1 — HEADER_KEY_MAP: exact matches on the normalized (lowercased, trimmed,
// whitespace-collapsed) header string. Catches every real column name seen in
// production uploads, including the canonical template name AND every common
// variant actually used by this customer's files.
//
// Tier 2 — CANONICAL_HEADER_MAP: fallback for headers that don't match Tier 1;
// normalizes further by stripping all non-alphanumeric characters before
// lookup. Catches punctuation differences ("phone/number" vs. "phone number"),
// spacing variations, and camel-cased header exports.
//
// Critical fix: 'mobile number' was missing from the original HEADER_KEY_MAP —
// this was the sole cause of every Delivery Data upload failing when the
// uploaded file used "Mobile Number" instead of "Phone Number".
const HEADER_KEY_MAP = {
    // ── Date / Employee ─────────────────────────────────────────────────────
    date: 'date',
    'employee name': 'employeeName',
    'agent name': 'employeeName',
    employee: 'employeeName',
    agent: 'employeeName',
    // ── Business Type / Business Name ────────────────────────────────────────
    'business type': 'businessType',
    'product/service': 'businessType',
    'product service': 'businessType',
    product: 'businessType',
    service: 'businessType',
    sector: 'businessType',
    'business name': 'businessName',
    'lead name': 'businessName',
    'business name/co name': 'businessName',
    'company name': 'businessName',
    'shop name': 'businessName',
    'business / person / shop / company name': 'businessName',
    'business/person/shop/company name': 'businessName',
    'business person, shop, and company name': 'businessName',
    business: 'businessName',
    'contact person': 'contactPerson',
    'point of contact': 'contactPerson',
    // ── Geography ───────────────────────────────────────────────────────────
    area: 'area',
    city: 'city',
    place: 'area',
    // ── Phone ───────────────────────────────────────────────────────────────
    'phone number': 'phoneNumber',
    'mobile number': 'phoneNumber',
    'contact number': 'phoneNumber',
    'contact number ': 'phoneNumber',
    'mobile no': 'phoneNumber',
    'mobile no.': 'phoneNumber',
    'phone no': 'phoneNumber',
    'phone no.': 'phoneNumber',
    'contact no': 'phoneNumber',
    'contact no.': 'phoneNumber',
    mobile: 'phoneNumber',
    phone: 'phoneNumber',
    contact: 'phoneNumber',
    'alternate number(if any)': 'alternateNumber',
    'alternate number (if any)': 'alternateNumber',
    'alternate number': 'alternateNumber',
    'alt number': 'alternateNumber',
    // ── Address ─────────────────────────────────────────────────────────────
    address: 'address',
    adress: 'address',                                        // tolerate template typo
    'map location': 'address',
    'map location link / address': 'address',
    'map location link/address': 'address',
    'link address': 'address',
    location: 'address',
    // ── Appointment ─────────────────────────────────────────────────────────
    'appointment date': 'appointmentDate',
    'appointment timings': 'appointmentTimings',
    'appointment time': 'appointmentTimings',
    'follow-up date': 'appointmentDate',
    'follow up date': 'appointmentDate',
    'follow-up time': 'appointmentTimings',
    'follow up time': 'appointmentTimings',
    // ── Remarks ─────────────────────────────────────────────────────────────
    remarks: 'remarks',
    notes: 'remarks',
    remark: 'remarks',
    // ── Delivery-specific ───────────────────────────────────────────────────
    'delivery date': 'deliveryDate',
    'delivery time': 'deliveryTime',
    // Ignored columns
    'sl no': 'ignore',
    'sl. no': 'ignore',
    's no': 'ignore',
    's. no': 'ignore',
    'serial no': 'ignore',
    'serial number': 'ignore',
};

// Tier-2 fallback: strip all non-alphanumeric characters, lowercase.
// Catches e.g. "Phone/Number" → "phonenumber", "Mobile-Number" → "mobilenumber".
const CANONICAL_HEADER_MAP = {
    date: 'date',
    employeename: 'employeeName',
    agentname: 'employeeName',
    employee: 'employeeName',
    agent: 'employeeName',
    businesstype: 'businessType',
    productservice: 'businessType',
    sector: 'businessType',
    businessname: 'businessName',
    leadname: 'businessName',
    businessnameconame: 'businessName',
    companyname: 'businessName',
    shopname: 'businessName',
    businesspersonshopcompanyname: 'businessName',
    contactperson: 'contactPerson',
    pointofcontact: 'contactPerson',
    area: 'area',
    city: 'city',
    place: 'area',
    phonenumber: 'phoneNumber',
    mobilenumber: 'phoneNumber',
    contactnumber: 'phoneNumber',
    mobileno: 'phoneNumber',
    phoneno: 'phoneNumber',
    contactno: 'phoneNumber',
    mobile: 'phoneNumber',
    phone: 'phoneNumber',
    contact: 'phoneNumber',
    alternatenumberifany: 'alternateNumber',
    alternatenumber: 'alternateNumber',
    altnumber: 'alternateNumber',
    secondarynumber: 'alternateNumber',
    address: 'address',
    adress: 'address',
    maplocation: 'address',
    linkaddress: 'address',
    location: 'address',
    appointmentdate: 'appointmentDate',
    appointmenttimings: 'appointmentTimings',
    appointmenttime: 'appointmentTimings',
    followupdate: 'appointmentDate',
    followuptime: 'appointmentTimings',
    remarks: 'remarks',
    notes: 'remarks',
    remark: 'remarks',
    deliverydate: 'deliveryDate',
    deliverytime: 'deliveryTime',
    // Ignored columns
    slno: 'ignore',
    sno: 'ignore',
    serialno: 'ignore',
    serialnumber: 'ignore',
};

// Schema field labels for the upfront header validator error message.
const SCHEMA_FIELD_LABELS = {
    date: 'Date',
    employeeName: 'Employee Name',
    businessType: 'Business Type',
    businessName: 'Business Name',
    area: 'Area',
    city: 'City',
    phoneNumber: 'Contact Number',   // canonical label as shown in the template
    address: 'Address',
    appointmentDate: 'Appointment Date',
    appointmentTimings: 'Appointment Timings',
    remarks: 'Remarks',
    deliveryDate: 'Delivery Date',
    deliveryTime: 'Delivery Time',
};

// Required schema keys — only phoneNumber blocks a row (phone-number-only-mandatory policy).
const REQUIRED_SCHEMA_KEYS = new Set(['phoneNumber']);

function toSchemaKeyedRow(normalizedRawRow) {
    const row = {};
    for (const [rawHeader, rawVal] of Object.entries(normalizedRawRow)) {
        if (rawHeader.startsWith('_')) continue;
        // Tier 1: exact normalized header match
        const tier1Key = HEADER_KEY_MAP[rawHeader];
        if (tier1Key) {
            if (tier1Key === 'ignore') continue;
            if (row[tier1Key] === undefined) row[tier1Key] = rawVal;
            continue;
        }
        // Tier 2: strip all non-alphanumeric characters, lowercase
        const canonical = rawHeader.replace(/[^a-z0-9]/g, '');
        const tier2Key = CANONICAL_HEADER_MAP[canonical];
        if (tier2Key && row[tier2Key] === undefined) {
            if (tier2Key === 'ignore') continue;
            row[tier2Key] = rawVal;
        }
        // Unrecognized columns are silently ignored (reported at file level)
    }
    return row;
}

function getSimilarity(s1, s2) {
    const a = String(s1 || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const b = String(s2 || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (a === b) return 1.0;
    const track = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));
    for (let i = 0; i <= a.length; i += 1) track[0][i] = i;
    for (let j = 0; j <= b.length; j += 1) track[j][0] = j;
    for (let j = 1; j <= b.length; j += 1) {
        for (let i = 1; i <= a.length; i += 1) {
            const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
            track[j][i] = Math.min(
                track[j][i - 1] + 1, // deletion
                track[j - 1][i] + 1, // insertion
                track[j - 1][i - 1] + indicator // substitution
            );
        }
    }
    const distance = track[b.length][a.length];
    const maxLength = Math.max(a.length, b.length);
    return maxLength === 0 ? 1.0 : 1.0 - distance / maxLength;
}

/**
 * Upfront header validation — runs BEFORE any row-level processing.
 *
 * Returns:
 *   { ok: false, fatalError } when a required column cannot be found at all
 *     (caller should abort with fatalError as a file-level error entry).
 *   { ok: true, aliasMatches, extraColumns, missingOptional } otherwise;
 *     caller should push these as FILE_INFO / FILE_WARNING entries (non-blocking).
 *
 * This is the key fix: previously a missing phone column produced one
 * "Mobile Number is required" error per row. Now it produces exactly one
 * FILE_STRUCTURE_ERROR with a clear explanation and the found/expected column
 * lists, and row processing never runs.
 */
function validateFileHeaders(rawRows) {
    if (!rawRows || rawRows.length === 0) {
        return { ok: true, aliasMatches: [], extraColumns: [], missingOptional: [] };
    }

    // Collect unique original (un-normalized) header names from the first row.
    const originalHeaders = Object.keys(rawRows[0]).filter(h => !h.startsWith('_'));
    const normalizedToOriginal = new Map();
    for (const h of originalHeaders) {
        const norm = h.toLowerCase().trim().replace(/\r?\n/g, ' ').replace(/\s+/g, ' ');
        if (!normalizedToOriginal.has(norm)) normalizedToOriginal.set(norm, h);
    }

    // Resolve which schema key each header maps to.
    const resolvedKeys = new Map(); // schemaKey → originalHeader
    const aliasMatches = []; // { originalHeader, schemaKey, schemaLabel } — for transparency
    const unmappedHeaders = [];

    for (const [norm, original] of normalizedToOriginal) {
        // Tier 1
        const tier1Key = HEADER_KEY_MAP[norm];
        if (tier1Key) {
            if (tier1Key === 'ignore') continue;
            if (!resolvedKeys.has(tier1Key)) {
                resolvedKeys.set(tier1Key, original);
                // Report alias if original header differs from schema's canonical label
                const canonicalLabel = SCHEMA_FIELD_LABELS[tier1Key];
                if (canonicalLabel && original.trim() !== canonicalLabel) {
                    aliasMatches.push({ originalHeader: original, schemaKey: tier1Key, schemaLabel: canonicalLabel });
                }
            }
            continue;
        }
        // Tier 2
        const canonical = norm.replace(/[^a-z0-9]/g, '');
        const tier2Key = CANONICAL_HEADER_MAP[canonical];
        if (tier2Key) {
            if (tier2Key === 'ignore') continue;
            if (!resolvedKeys.has(tier2Key)) {
                resolvedKeys.set(tier2Key, original);
                const canonicalLabel = SCHEMA_FIELD_LABELS[tier2Key];
                if (canonicalLabel && original.trim() !== canonicalLabel) {
                    aliasMatches.push({ originalHeader: original, schemaKey: tier2Key, schemaLabel: canonicalLabel });
                }
            }
            continue;
        }
        unmappedHeaders.push(original);
    }

    // Check that every required column was found.
    const missingRequired = [];
    for (const key of REQUIRED_SCHEMA_KEYS) {
        if (!resolvedKeys.has(key)) missingRequired.push(SCHEMA_FIELD_LABELS[key] || key);
    }

    if (missingRequired.length > 0) {
        const foundList = originalHeaders.join(', ');
        const expectedList = Object.values(SCHEMA_FIELD_LABELS).join(', ');

        // Find best suggestions from unmapped headers for each missing required column
        let suggestions = '';
        for (const missing of missingRequired) {
            let bestMatch = null;
            let highestSimilarity = 0.0;
            for (const unmatched of unmappedHeaders) {
                const sim = getSimilarity(missing, unmatched);
                if (sim > highestSimilarity) {
                    highestSimilarity = sim;
                    bestMatch = unmatched;
                }
            }
            if (highestSimilarity > 0.6 && bestMatch) {
                suggestions += ` Did you mean '${bestMatch}'?`;
            }
        }

        const fatalError = {
            row: 0,
            code: 'FILE_STRUCTURE_ERROR',
            reason:
                `This file doesn't match the Delivery Data template. ` +
                `Missing required column: '${missingRequired.join("', '")}'.${suggestions} ` +
                `Found columns: ${foundList}. ` +
                `Expected columns: ${expectedList}. ` +
                `Please download the current template and re-upload.`,
        };
        return { ok: false, fatalError };
    }

    // Identify extra (unrecognized) columns and missing optional columns.
    const extraColumns = unmappedHeaders;
    const missingOptional = Object.keys(SCHEMA_FIELD_LABELS)
        .filter(k => !REQUIRED_SCHEMA_KEYS.has(k) && !resolvedKeys.has(k))
        .map(k => SCHEMA_FIELD_LABELS[k]);

    return { ok: true, aliasMatches, extraColumns, missingOptional };
}

// See rawDataProcessor.js for why this delegates to the shared flexible
// parser instead of a local, weaker `new Date(value)`.
const toDateOrNull = parseFlexibleDate;

// Composite dedup key built from raw trimmed string values, deliberately not
// re-parsed to a Date object — sidesteps the exceljs local-timezone gotcha
// documented in CLAUDE.md, and is sufficient to catch the actual target case
// (the exact same file/row re-uploaded), which is all this key needs to do.
function deliveryDupKey(phone, deliveryDateValue, deliveryTimeValue) {
    const p = String(phone || '').replace(/[^\d+]/g, '');
    const d = String(deliveryDateValue || '').trim().toLowerCase();
    const t = String(deliveryTimeValue || '').trim().toLowerCase();
    return `${p}|${d}|${t}`;
}

// `failedCountOverride`: see csvProcessor.js's identical helper for why this
// exists — the final 'done' snapshot passes an `errorsArr` merged with
// non-blocking warnings so cache readers see the same report the DB has,
// and the real failed-row count must be passed explicitly so it isn't
// miscounted as `errors.length + warnings.length`.
async function emitProgress(batchId, uploadedBy, verticalId, status, totalRows, successCount, errorsArr, duplicateCount, failedCountOverride) {
    await cacheSet(`csv_progress:${batchId}`, {
        id: batchId,
        uploaded_by: uploadedBy,
        vertical_id: verticalId,
        status,
        total_rows: totalRows,
        success_count: successCount,
        failed_count: failedCountOverride ?? errorsArr.length,
        duplicate_count: duplicateCount,
        errors: errorsArr,
        operation_type: 'bulk_upload',
    }, 3_600);
}

/**
 * Delivery Data queue processor — a parallel module to rawDataProcessor.js,
 * composing the same generic, already-tested pieces (parseUploadBuffer,
 * bulkInsert) rather than forcing delivery_data through raw_data-shaped
 * code. Two deliberate differences from rawDataProcessor.js:
 *  - duplicate detection uses a composite key (phone + deliveryDate +
 *    deliveryTime), not phone alone — Delivery Data is an event log, so the
 *    same business legitimately recurs across many rows.
 *  - each valid row is auto-matched against raw_data for linkedRawDataId,
 *    batched (one query per key across the whole file), never per-row.
 */
export const processDeliveryDataJob = async (job) => {
    const { batchId, fileBufferBase64, verticalId, uploadedBy, fileExt = '.csv', sheetIndices = [0], columnMapping = null } = job.data;

    let totalRows = 0;
    let successCount = 0;
    let duplicateCount = 0;
    const errors = [];
    const warnings = [];

    await query('UPDATE csv_upload_logs SET status = $1, processing_started_at = NOW() WHERE id = $2', ['processing', batchId]);
    await emitProgress(batchId, uploadedBy, verticalId, 'processing', 0, 0, [], 0);

    try {
        const buffer = Buffer.from(fileBufferBase64, 'base64');
        const { rows, warnings: fileWarnings, sheetNames = [] } = await parseUploadBuffer(buffer, fileExt, sheetIndices);
        for (const w of fileWarnings) errors.push({ row: 0, code: 'FILE_WARNING', reason: w });

        totalRows = rows.length;
        await query('UPDATE csv_upload_logs SET total_rows = $1 WHERE id = $2', [totalRows, batchId]);

        if (totalRows === 0) {
            await query("UPDATE csv_upload_logs SET status = 'done', errors = $2, processing_finished_at = NOW() WHERE id = $1",
                [batchId, JSON.stringify(errors)]);
            await emitProgress(batchId, uploadedBy, verticalId, 'done', 0, 0, errors, 0);
            return;
        }

        const [agents, knownBusinessTypes] = await Promise.all([
            getAssignableAgents(verticalId),
            getKnownBusinessTypes(verticalId),
        ]);

        const normalizedRows = rows.map(r => {
            if (columnMapping) {
                const row = {};
                for (const [fieldKey, fileHeader] of Object.entries(columnMapping)) {
                    if (fileHeader && r[fileHeader] !== undefined) {
                        row[fieldKey] = r[fileHeader];
                    } else {
                        row[fieldKey] = '';
                    }
                }
                return row;
            } else {
                return toSchemaKeyedRow(normalizeRowKeys(r));
            }
        });

        // Composite-key dedup: existing DB rows (fetched by phone superset) + within-file duplicates.
        const filePhones = normalizedRows.map(r => (r.phoneNumber || '').replace(/[^\d+]/g, '')).filter(Boolean);
        const uniquePhones = [...new Set(filePhones)];
        let existingDupKeys = new Set();
        if (uniquePhones.length > 0) {
            const existingRes = await query(
                `SELECT phone_number, to_char(delivery_date, 'YYYY-MM-DD') AS delivery_date_str, delivery_time
                 FROM delivery_data
                 WHERE vertical_id = $1 AND is_deleted = false
                   AND phone_number = ANY($2)`,
                [verticalId, uniquePhones]
            );
            existingDupKeys = new Set(existingRes.rows.map(r =>
                deliveryDupKey(r.phone_number, r.delivery_date_str, r.delivery_time)
            ));
        }
        const dupKeySet = new Set(existingDupKeys);
        const rowOutcomes = [];

        // linkedRawDataId — batched match against raw_data (one query per key, not per row).
        const businessNames = normalizedRows.map(r => r.businessName);
        const { phoneMap, nameMap } = await findLinkedRawDataBatch(verticalId, filePhones, businessNames);

        const activeSheets = sheetNames.length > 0 ? sheetNames : ['Sheet 1'];
        const sheetStats = new Map();
        activeSheets.forEach(sheetName => {
            sheetStats.set(sheetName, { success: 0, duplicates: 0, failed: 0, status: 'pending' });
        });

        const validRows = [];

        for (const sheetName of activeSheets) {
            const sheetRows = sheetNames.length > 0 ? rows.filter(r => r._sheetName === sheetName) : rows;
            const stats = sheetStats.get(sheetName);

            if (sheetRows.length === 0) {
                stats.status = 'empty';
                errors.push({
                    row: 0,
                    code: 'SHEET_ERROR',
                    reason: `Sheet "${sheetName}" is empty. No data imported.`,
                    sheetName,
                    warning: false
                });
                continue;
            }

            // Upfront header validation per sheet (only run if no manual mapping is provided)
            if (!columnMapping) {
                const headerCheck = validateFileHeaders(sheetRows);
                if (!headerCheck.ok) {
                    stats.status = 'failed';
                    errors.push({
                        row: 0,
                        code: 'SHEET_ERROR',
                        reason: `Sheet "${sheetName}" failed template validation: ${headerCheck.fatalError.reason}`,
                        sheetName,
                        warning: false
                    });
                    continue;
                }

                // Match alias matched notices
                for (const am of headerCheck.aliasMatches) {
                    errors.push({ row: 0, code: 'ALIAS_MATCH', reason: `Sheet "${sheetName}": Matched '${am.originalHeader}' → ${am.schemaLabel}`, sheetName, warning: true });
                }
                if (headerCheck.extraColumns.length > 0) {
                    errors.push({ row: 0, code: 'FILE_WARNING', reason: `Sheet "${sheetName}": Unrecognized columns ignored: ${headerCheck.extraColumns.join(', ')}`, sheetName, warning: true });
                }
                if (headerCheck.missingOptional.length > 0) {
                    errors.push({ row: 0, code: 'FILE_WARNING', reason: `Sheet "${sheetName}": Optional columns not found in file: ${headerCheck.missingOptional.join(', ')}`, sheetName, warning: true });
                }
            }

            // Check if required phoneNumber column is present but entirely empty in all rows
            const sheetNormalized = sheetRows.map(r => {
                if (columnMapping) {
                    const row = {};
                    const extraCustom = {};
                    const mappedHeaders = new Set(Object.values(columnMapping).filter(Boolean));
                    for (const [fieldKey, fileHeader] of Object.entries(columnMapping)) {
                        if (fileHeader && r[fileHeader] !== undefined) {
                            row[fieldKey] = r[fileHeader];
                        } else {
                            row[fieldKey] = '';
                        }
                    }
                    for (const [k, v] of Object.entries(r)) {
                        if (k.startsWith('_')) continue;
                        if (!mappedHeaders.has(k) && v !== undefined && v !== null && v !== '') {
                            extraCustom[k] = v;
                        }
                    }
                    if (Object.keys(extraCustom).length > 0) {
                        row.customData = extraCustom;
                    }
                    return row;
                } else {
                    return toSchemaKeyedRow(normalizeRowKeys(r));
                }
            });

            const hasAnyPhone = sheetNormalized.some(r => {
                const val = r.phoneNumber;
                return val !== undefined && val !== null && String(val).trim() !== '';
            });

            if (!hasAnyPhone) {
                stats.status = 'failed';
                errors.push({
                    row: 0,
                    code: 'COLUMN_EMPTY_ERROR',
                    reason: `The 'Contact Number' column was found in Sheet "${sheetName}" but is empty in all ${sheetRows.length} rows. Check that data is in the expected column, or that you selected the correct sheet.`,
                    sheetName,
                    warning: false
                });
                continue;
            }

            stats.status = 'processing';

            sheetRows.forEach((rawRow, idx) => {
                const rowNum = idx + 2; // +2: header row + 1-based index
                const row = sheetNormalized[idx];
                const { errors: rowErrors, warnings: rowWarnings, assignedUserId, employeeNameRaw } = validateDeliveryDataRow(row, { agents, knownBusinessTypes });

                for (const w of rowWarnings) warnings.push({ row: rowNum, field: w.field, reason: `Sheet "${sheetName}": ${w.message}`, sheetName });

                if (rowErrors.length > 0) {
                    stats.failed++;
                    const reason = rowErrors.map(e => e.message).join('; ');
                    errors.push({ row: rowNum, code: ErrorCodes.VALIDATION_FAILED, field: rowErrors.length === 1 ? rowErrors[0].field : undefined, reason, originalRow: rawRow, sheetName });
                    rowOutcomes.push({ row: rowNum, status: 'failed', reason, sheetName });
                    return;
                }

                const phone = (row.phoneNumber || '').replace(/[^\d+]/g, '');
                const dupKey = deliveryDupKey(phone, row.deliveryDate, row.deliveryTime);
                if (dupKeySet.has(dupKey)) {
                    duplicateCount++;
                    stats.duplicates++;
                    const reason = 'Duplicate: same phone number, delivery date, and delivery time already exists';
                    errors.push({ row: rowNum, code: ErrorCodes.DUPLICATE_RECORD, field: 'phoneNumber', reason, originalRow: rawRow, sheetName });
                    rowOutcomes.push({ row: rowNum, status: 'duplicate', reason, sheetName });
                    return;
                }
                dupKeySet.add(dupKey);

                const linkResult = resolveLinkedRawDataId(phone, row.businessName, { phoneMap, nameMap });
                if (linkResult.warning) warnings.push({ row: rowNum, field: 'linkedRawDataId', reason: `Sheet "${sheetName}": ${linkResult.warning}`, sheetName });

                validRows.push({
                    id: crypto.randomUUID(),
                    vertical_id: verticalId,
                    assigned_user_id: assignedUserId,
                    date: toDateOrNull(row.date),
                    business_type: row.businessType || null,
                    business_name: row.businessName || null,
                    contact_person: row.contactPerson || null,
                    phone_number: phone,
                    alternate_number: row.alternateNumber || null,
                    area: row.area || null,
                    city: row.city || null,
                    address: row.address || null,
                    call_status: row.callStatus || null,
                    customer_response: row.customerResponse || null,
                    follow_up_required: row.followUpRequired || null,
                    follow_up_date: toDateOrNull(row.followUpDate),
                    follow_up_time: row.followUpTime || null,
                    next_action: row.nextAction || null,
                    remarks: row.remarks || null,
                    converted: row.converted || null,
                    appointment_date: toDateOrNull(row.appointmentDate),
                    appointment_timings: row.appointmentTimings || null,
                    delivery_date: toDateOrNull(row.deliveryDate),
                    delivery_time: row.deliveryTime || null,
                    linked_raw_data_id: linkResult.linkedRawDataId,
                    source: 'bulk_upload',
                    csv_batch_id: batchId,
                    created_by: uploadedBy,
                    employee_name_raw: employeeNameRaw || null,
                    csvRowNum: rowNum,
                    originalRow: rawRow,
                    _sheetName: sheetName
                });
            });
        }

        for (let i = 0; i < validRows.length; i += BATCH_SIZE) {
            const chunk = validRows.slice(i, i + BATCH_SIZE);
            const chunkRows = chunk.map(r => DELIVERY_DATA_COLUMNS.map(c => r[c]));
            try {
                const inserted = await bulkInsert({ query }, 'delivery_data', DELIVERY_DATA_COLUMNS, chunkRows, { onConflict: '' });
                successCount += inserted.length;
                for (const r of chunk) {
                    rowOutcomes.push({ row: r.csvRowNum, status: 'success', id: r.id, sheetName: r._sheetName });
                    if (sheetStats.has(r._sheetName)) {
                        sheetStats.get(r._sheetName).success++;
                    }
                }
            } catch (chunkErr) {
                // Fall back row-by-row so one bad row never sinks the whole chunk.
                for (const r of chunk) {
                    try {
                        await bulkInsert({ query }, 'delivery_data', DELIVERY_DATA_COLUMNS, [DELIVERY_DATA_COLUMNS.map(c => r[c])], { onConflict: '' });
                        successCount += 1;
                        rowOutcomes.push({ row: r.csvRowNum, status: 'success', id: r.id, sheetName: r._sheetName });
                        if (sheetStats.has(r._sheetName)) {
                            sheetStats.get(r._sheetName).success++;
                        }
                    } catch (singleErr) {
                        const rawErr = singleErr.cause || singleErr;
                        const isDup = rawErr.code === '23505';
                        const reason = isDup ? 'Duplicate: same phone number, delivery date, and delivery time already exists' : rawErr.message;
                        if (isDup) {
                            duplicateCount++;
                            if (sheetStats.has(r._sheetName)) {
                                sheetStats.get(r._sheetName).duplicates++;
                            }
                            errors.push({ row: r.csvRowNum, code: ErrorCodes.DUPLICATE_RECORD, field: 'phoneNumber', reason, originalRow: r.originalRow, sheetName: r._sheetName });
                            rowOutcomes.push({ row: r.csvRowNum, status: 'duplicate', reason, sheetName: r._sheetName });
                        } else {
                            if (sheetStats.has(r._sheetName)) {
                                sheetStats.get(r._sheetName).failed++;
                            }
                            errors.push({ row: r.csvRowNum, code: ErrorCodes.DB_CONSTRAINT, reason: `Insert failed for ${r.business_name}: ${reason}`, originalRow: r.originalRow, sheetName: r._sheetName });
                            rowOutcomes.push({ row: r.csvRowNum, status: 'failed', reason, sheetName: r._sheetName });
                        }
                    }
                }
            }
            await emitProgress(batchId, uploadedBy, verticalId, 'processing', totalRows, successCount, errors, duplicateCount);
        }

        // Add SHEET_SUMMARY items to errors
        sheetStats.forEach((stats, name) => {
            if (stats.status === 'processing') {
                stats.status = 'done';
            }
            if (stats.status === 'done' || stats.status === 'failed' || stats.status === 'empty') {
                errors.push({
                    row: 0,
                    code: 'SHEET_SUMMARY',
                    reason: stats.status === 'empty'
                        ? `Sheet "${name}": Skipped (empty)`
                        : stats.status === 'failed' && stats.success === 0 && stats.failed === 0
                        ? `Sheet "${name}": Skipped (failed validation)`
                        : `Sheet "${name}": ${stats.success} imported, ${stats.duplicates} duplicates, ${stats.failed} errors`,
                    sheetName: name,
                    successCount: stats.success,
                    duplicateCount: stats.duplicates,
                    failedCount: stats.failed,
                    status: stats.status
                });
            }
        });

        const outcomeSuccess = rowOutcomes.filter(o => o.status === 'success').length;
        const outcomeDuplicate = rowOutcomes.filter(o => o.status === 'duplicate').length;
        const outcomeFailed = rowOutcomes.filter(o => o.status === 'failed' || o.status === 'sheet_failed').length;
        const outcomeTotal = outcomeSuccess + outcomeDuplicate + outcomeFailed;

        console.log(`[DeliveryData Processor] Batch final report: total=${totalRows}, outcomes=${outcomeTotal} (success=${outcomeSuccess}, duplicates=${outcomeDuplicate}, failed=${outcomeFailed})`);
        if (outcomeTotal !== totalRows) {
            console.error(`[DeliveryData Processor] MISMATCH warning: totalRows (${totalRows}) !== outcomeTotal (${outcomeTotal})`);
        }

        const persistedEntries = [...errors, ...warnings.map(w => ({ ...w, warning: true }))];
        await query(`
            UPDATE csv_upload_logs
            SET status = 'done', success_count = $1, failed_count = $2, duplicate_count = $3, errors = $4, processing_finished_at = NOW()
            WHERE id = $5
        `, [successCount, outcomeFailed, duplicateCount, JSON.stringify(persistedEntries), batchId]);

        await emitProgress(batchId, uploadedBy, verticalId, 'done', totalRows, successCount, persistedEntries, duplicateCount, outcomeFailed);
        broadcastToAll({ type: 'DELIVERY_DATA_MUTATED', verticalId, action: 'bulk_upload', batchId });
    } catch (error) {
        logger.error({ correlationId: batchId, section: 'delivery_data', operation: 'bulk_upload', verticalId, uploadedBy, err: { message: error.message, stack: error.stack } }, `[deliveryDataProcessor] job ${batchId} failed: ${error.message}`);
        const failedErrors = errors.length > 0 ? errors : [{ row: 0, code: ErrorCodes.INTERNAL_ERROR, reason: error.message }];
        await query('UPDATE csv_upload_logs SET status = $1, errors = $2 WHERE id = $3', ['failed', JSON.stringify(failedErrors), batchId]);
        await emitProgress(batchId, uploadedBy, verticalId, 'failed', totalRows, successCount, failedErrors, duplicateCount).catch(() => {});
        throw error;
    }
};

export default processDeliveryDataJob;
