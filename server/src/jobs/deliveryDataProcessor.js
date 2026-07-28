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
import { bulkInsert } from '../db/bulkInsert.js';
import { ErrorCodes } from '../utils/operationError.js';
import { logger } from '../lib/logger.js';

const BATCH_SIZE = 500;

const DELIVERY_DATA_COLUMNS = [
    'id', 'vertical_id', 'assigned_user_id', 'date', 'business_type', 'business_name',
    'area', 'city', 'phone_number', 'address', 'appointment_date', 'appointment_timings',
    'remarks', 'delivery_date', 'delivery_time', 'linked_raw_data_id',
    'source', 'csv_batch_id', 'created_by',
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

const HEADER_KEY_MAP = {
    date: 'date',
    'employee name': 'employeeName',
    'business type': 'businessType',
    'business name': 'businessName',
    area: 'area',
    city: 'city',
    'phone number': 'phoneNumber',
    address: 'address',
    adress: 'address', // tolerate the source template's original typo on re-uploads
    'appointment date': 'appointmentDate',
    'appointment timings': 'appointmentTimings',
    remarks: 'remarks',
    'delivery date': 'deliveryDate',
    'delivery time': 'deliveryTime',
};

function toSchemaKeyedRow(normalizedRawRow) {
    const row = {};
    for (const [header, schemaKey] of Object.entries(HEADER_KEY_MAP)) {
        if (normalizedRawRow[header] !== undefined) row[schemaKey] = normalizedRawRow[header];
    }
    return row;
}

function toDateOrNull(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

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

async function emitProgress(batchId, uploadedBy, verticalId, status, totalRows, successCount, errorsArr, duplicateCount) {
    await cacheSet(`csv_progress:${batchId}`, {
        id: batchId,
        uploaded_by: uploadedBy,
        vertical_id: verticalId,
        status,
        total_rows: totalRows,
        success_count: successCount,
        failed_count: errorsArr.length,
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
    const { batchId, fileBufferBase64, verticalId, uploadedBy, fileExt = '.csv' } = job.data;

    let totalRows = 0;
    let successCount = 0;
    let duplicateCount = 0;
    const errors = [];
    const warnings = [];

    await query('UPDATE csv_upload_logs SET status = $1, processing_started_at = NOW() WHERE id = $2', ['processing', batchId]);
    await emitProgress(batchId, uploadedBy, verticalId, 'processing', 0, 0, [], 0);

    try {
        const buffer = Buffer.from(fileBufferBase64, 'base64');
        const { rows, warnings: fileWarnings } = await parseUploadBuffer(buffer, fileExt);
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

        const normalizedRows = rows.map(r => toSchemaKeyedRow(normalizeRowKeys(r)));

        // Composite-key dedup: existing DB rows (fetched by phone superset) + within-file duplicates.
        const filePhones = normalizedRows.map(r => (r.phoneNumber || '').replace(/[^\d+]/g, '')).filter(Boolean);
        const uniquePhones = [...new Set(filePhones)];
        let existingDupKeys = new Set();
        if (uniquePhones.length > 0) {
            // to_char formats the date server-side, in SQL — avoids any JS
            // Date-object timezone-reinterpretation ambiguity entirely.
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

        const validRows = [];
        rows.forEach((rawRow, idx) => {
            const rowNum = idx + 2; // +2: header row + 1-based
            const row = normalizedRows[idx];
            const { errors: rowErrors, warnings: rowWarnings, assignedUserId } = validateDeliveryDataRow(row, { agents, knownBusinessTypes });

            for (const w of rowWarnings) warnings.push({ row: rowNum, field: w.field, reason: w.message });

            if (rowErrors.length > 0) {
                const reason = rowErrors.map(e => e.message).join('; ');
                errors.push({ row: rowNum, code: ErrorCodes.VALIDATION_FAILED, field: rowErrors.length === 1 ? rowErrors[0].field : undefined, reason, originalRow: rawRow });
                rowOutcomes.push({ row: rowNum, status: 'failed', reason });
                return;
            }

            const phone = (row.phoneNumber || '').replace(/[^\d+]/g, '');
            const dupKey = deliveryDupKey(phone, row.deliveryDate, row.deliveryTime);
            if (dupKeySet.has(dupKey)) {
                duplicateCount++;
                const reason = 'Duplicate: same phone number, delivery date, and delivery time already exists';
                errors.push({ row: rowNum, code: ErrorCodes.DUPLICATE_RECORD, field: 'phoneNumber', reason, originalRow: rawRow });
                rowOutcomes.push({ row: rowNum, status: 'duplicate', reason });
                return;
            }
            dupKeySet.add(dupKey);

            const linkResult = resolveLinkedRawDataId(phone, row.businessName, { phoneMap, nameMap });
            if (linkResult.warning) warnings.push({ row: rowNum, field: 'linkedRawDataId', reason: linkResult.warning });

            validRows.push({
                id: crypto.randomUUID(),
                vertical_id: verticalId,
                assigned_user_id: assignedUserId,
                date: toDateOrNull(row.date),
                business_type: row.businessType || null,
                business_name: row.businessName,
                area: row.area || null,
                city: row.city || null,
                phone_number: phone,
                address: row.address || null,
                appointment_date: toDateOrNull(row.appointmentDate),
                appointment_timings: row.appointmentTimings || null,
                remarks: row.remarks || null,
                delivery_date: toDateOrNull(row.deliveryDate),
                delivery_time: row.deliveryTime,
                linked_raw_data_id: linkResult.linkedRawDataId,
                source: 'bulk_upload',
                csv_batch_id: batchId,
                created_by: uploadedBy,
                csvRowNum: rowNum,
                originalRow: rawRow,
            });
        });

        for (let i = 0; i < validRows.length; i += BATCH_SIZE) {
            const chunk = validRows.slice(i, i + BATCH_SIZE);
            const chunkRows = chunk.map(r => DELIVERY_DATA_COLUMNS.map(c => r[c]));
            try {
                const inserted = await bulkInsert({ query }, 'delivery_data', DELIVERY_DATA_COLUMNS, chunkRows, { onConflict: '' });
                successCount += inserted.length;
                for (const r of chunk) {
                    rowOutcomes.push({ row: r.csvRowNum, status: 'success', id: r.id });
                }
            } catch (chunkErr) {
                // Fall back row-by-row so one bad row never sinks the whole chunk.
                for (const r of chunk) {
                    try {
                        await bulkInsert({ query }, 'delivery_data', DELIVERY_DATA_COLUMNS, [DELIVERY_DATA_COLUMNS.map(c => r[c])], { onConflict: '' });
                        successCount += 1;
                        rowOutcomes.push({ row: r.csvRowNum, status: 'success', id: r.id });
                    } catch (singleErr) {
                        const rawErr = singleErr.cause || singleErr;
                        const isDup = rawErr.code === '23505';
                        const reason = isDup ? 'Duplicate: same phone number, delivery date, and delivery time already exists' : rawErr.message;
                        if (isDup) {
                            duplicateCount++;
                            errors.push({ row: r.csvRowNum, code: ErrorCodes.DUPLICATE_RECORD, field: 'phoneNumber', reason, originalRow: r.originalRow });
                            rowOutcomes.push({ row: r.csvRowNum, status: 'duplicate', reason });
                        } else {
                            errors.push({ row: r.csvRowNum, code: ErrorCodes.DB_CONSTRAINT, reason: `Insert failed for ${r.business_name}: ${reason}`, originalRow: r.originalRow });
                            rowOutcomes.push({ row: r.csvRowNum, status: 'failed', reason });
                        }
                    }
                }
            }
            await emitProgress(batchId, uploadedBy, verticalId, 'processing', totalRows, successCount, errors, duplicateCount);
        }

        const outcomeSuccess = rowOutcomes.filter(o => o.status === 'success').length;
        const outcomeDuplicate = rowOutcomes.filter(o => o.status === 'duplicate').length;
        const outcomeFailed = rowOutcomes.filter(o => o.status === 'failed').length;
        const outcomeTotal = outcomeSuccess + outcomeDuplicate + outcomeFailed;

        console.log(`[DeliveryData Processor] Batch final report: total=${totalRows}, outcomes=${outcomeTotal} (success=${outcomeSuccess}, duplicates=${outcomeDuplicate}, failed=${outcomeFailed})`);
        if (outcomeTotal !== totalRows) {
            console.error(`[DeliveryData Processor] MISMATCH warning: totalRows (${totalRows}) !== outcomeTotal (${outcomeTotal})`);
        }

        await emitProgress(batchId, uploadedBy, verticalId, 'done', totalRows, successCount, errors, duplicateCount);
        await query(`
            UPDATE csv_upload_logs
            SET status = 'done', success_count = $1, failed_count = $2, duplicate_count = $3, errors = $4, processing_finished_at = NOW()
            WHERE id = $5
        `, [successCount, outcomeFailed, duplicateCount, JSON.stringify([...errors, ...warnings.map(w => ({ ...w, warning: true }))]), batchId]);

        await emitProgress(batchId, uploadedBy, verticalId, 'done', totalRows, successCount, errors, duplicateCount);
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
