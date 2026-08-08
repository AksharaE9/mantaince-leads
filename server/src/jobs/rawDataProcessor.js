import crypto from 'crypto';
import { query } from '../config/db.js';
import { cacheSet } from '../services/cache.js';
import { broadcastToAll } from '../services/assignmentBroadcaster.js';
import { parseUploadBuffer } from '../services/spreadsheetParser.js';
import { validateRawDataRow, getAssignableAgents, getKnownBusinessTypes, parseFlexibleDate } from '../services/rawDataImportSchema.js';
import { bulkInsert } from '../db/bulkInsert.js';
import { ErrorCodes } from '../utils/operationError.js';
import { logger } from '../lib/logger.js';

const BATCH_SIZE = 500;

const RAW_DATA_COLUMNS = [
    'id', 'vertical_id', 'sub_vertical_id', 'assigned_user_id', 'date',
    'product_service', 'lead_name', 'contact_person', 'phone_number', 'alternate_number',
    'city', 'area', 'map_location', 'call_status', 'customer_response',
    'follow_up_required', 'follow_up_date', 'follow_up_time', 'next_action', 'remarks',
    'converted', 'custom_data', 'business_type', 'business_name', 'address',
    'appointment_date', 'appointment_timings', 'source', 'csv_batch_id', 'created_by',
    'employee_name_raw',
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
    'product/service': 'productService',
    'product service': 'productService',
    product: 'productService',
    service: 'productService',
    'business type': 'productService',
    'lead name': 'leadName',
    'business name': 'leadName',
    'business / person / shop / company name': 'leadName',
    'contact person': 'contactPerson',
    'point of contact': 'contactPerson',
    'mobile number': 'phoneNumber',
    'phone number': 'phoneNumber',
    'contact number': 'phoneNumber',
    contact: 'phoneNumber',
    phone: 'phoneNumber',
    'alternate number(if any)': 'alternateNumber',
    'alternate number (if any)': 'alternateNumber',
    'alternate number': 'alternateNumber',
    'alt number': 'alternateNumber',
    city: 'city',
    area: 'area',
    'map location': 'mapLocation',
    'map location link / address': 'mapLocation',
    'link address': 'mapLocation',
    address: 'mapLocation',
    adress: 'mapLocation', // tolerate typo
    'call status': 'callStatus',
    status: 'callStatus',
    'customer response': 'customerResponse',
    response: 'customerResponse',
    'follow-up required': 'followUpRequired',
    'follow up required': 'followUpRequired',
    'follow-up require': 'followUpRequired',
    'follow up require (yes/no)': 'followUpRequired',
    'follow-up date': 'followUpDate',
    'follow up date': 'followUpDate',
    'follow-up dates': 'followUpDate',
    'follow-up time': 'followUpTime',
    'follow up time': 'followUpTime',
    'appointment date': 'followUpDate',
    'appointment timings': 'followUpTime',
    'next action': 'nextAction',
    remarks: 'remarks',
    'follow-up remarks': 'remarks',
    'follow up remarks': 'remarks',
    'converted (y/n)': 'converted',
    converted: 'converted',
    'converted(y/n)': 'converted',
    conversion: 'converted',
};

function toSchemaKeyedRow(normalizedRawRow) {
    const row = {};
    const extraCustom = {};
    for (const [rawHeader, rawVal] of Object.entries(normalizedRawRow)) {
        const schemaKey = HEADER_KEY_MAP[rawHeader];
        if (schemaKey) {
            if (row[schemaKey] === undefined) {
                row[schemaKey] = rawVal;
            }
        } else if (rawVal !== undefined && rawVal !== null && rawVal !== '') {
            extraCustom[rawHeader] = rawVal;
        }
    }
    if (Object.keys(extraCustom).length > 0) {
        row.customData = extraCustom;
    }
    return row;
}

const toDateOrNull = parseFlexibleDate;

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
 * Raw Data queue processor — processes bulk upload for Raw Data.
 */
export const processRawDataJob = async (job) => {
    const { batchId, fileBufferBase64, verticalId, subVerticalId, uploadedBy, fileExt = '.csv' } = job.data;

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

        // Phone dedup: existing DB rows + within-file duplicates.
        const normalizedRows = rows.map(r => toSchemaKeyedRow(normalizeRowKeys(r)));
        const filePhones = normalizedRows.map(r => (r.phoneNumber || '').replace(/[^\d+]/g, '')).filter(Boolean);
        const uniquePhones = [...new Set(filePhones)];
        
        const conflictLabelByPhone = new Map();
        if (uniquePhones.length > 0) {
            let existingRes;
            if (subVerticalId) {
                existingRes = await query(
                    `SELECT phone_number, lead_name, business_name, contact_person FROM raw_data
                     WHERE vertical_id = $1 AND sub_vertical_id = $2 AND is_deleted = false
                       AND phone_number = ANY($3)`,
                    [verticalId, subVerticalId, uniquePhones]
                );
            } else {
                existingRes = await query(
                    `SELECT phone_number, lead_name, business_name, contact_person FROM raw_data
                     WHERE vertical_id = $1 AND is_deleted = false
                       AND phone_number = ANY($2)`,
                    [verticalId, uniquePhones]
                );
            }
            for (const r of existingRes.rows) {
                const p = r.phone_number.replace(/[^\d+]/g, '');
                conflictLabelByPhone.set(p, r.lead_name || r.business_name || r.contact_person || 'existing record');
            }
        }
        const phoneSet = new Set(conflictLabelByPhone.keys());
        const rowOutcomes = [];

        const validRows = [];
        rows.forEach((rawRow, idx) => {
            const rowNum = idx + 2; // +2: header row + 1-based
            const row = normalizedRows[idx];
            const { errors: rowErrors, warnings: rowWarnings, assignedUserId, employeeNameRaw } = validateRawDataRow(row, { agents, knownBusinessTypes });

            for (const w of rowWarnings) warnings.push({ row: rowNum, field: w.field, reason: w.message });

            if (rowErrors.length > 0) {
                const reason = rowErrors.map(e => e.message).join('; ');
                errors.push({ row: rowNum, code: ErrorCodes.VALIDATION_FAILED, field: rowErrors.length === 1 ? rowErrors[0].field : undefined, reason, originalRow: rawRow });
                rowOutcomes.push({ row: rowNum, status: 'failed', reason });
                return;
            }

            const phone = (row.phoneNumber || '').replace(/[^\d+]/g, '');
            if (phoneSet.has(phone)) {
                duplicateCount++;
                const conflict = conflictLabelByPhone.get(phone) || (row.leadName || row.businessName || 'prior row in file');
                const reason = `Duplicate: mobile number already exists (conflicts with "${conflict}")`;
                errors.push({ row: rowNum, code: ErrorCodes.DUPLICATE_PHONE, field: 'phoneNumber', reason, originalRow: rawRow });
                rowOutcomes.push({ row: rowNum, status: 'duplicate', reason });
                return;
            }
            phoneSet.add(phone);
            conflictLabelByPhone.set(phone, row.leadName || row.businessName || row.contactPerson || `Row ${rowNum}`);

            const parsedDate = toDateOrNull(row.date);
            const parsedFollowUpDate = toDateOrNull(row.followUpDate || row.appointmentDate);
            const leadNameVal = row.leadName || row.businessName || null;
            const prodServiceVal = row.productService || row.businessType || null;
            const mapLocVal = row.mapLocation || row.address || null;
            const followUpTimeVal = row.followUpTime || row.appointmentTimings || null;

            validRows.push({
                id: crypto.randomUUID(),
                vertical_id: verticalId,
                sub_vertical_id: subVerticalId || null,
                assigned_user_id: assignedUserId,
                date: parsedDate,
                product_service: prodServiceVal,
                lead_name: leadNameVal,
                contact_person: row.contactPerson || null,
                phone_number: phone,
                alternate_number: row.alternateNumber ? String(row.alternateNumber).trim() : null,
                city: row.city ? String(row.city).trim() : null,
                area: row.area ? String(row.area).trim() : null,
                map_location: mapLocVal,
                call_status: row.callStatus ? String(row.callStatus).trim() : null,
                customer_response: row.customerResponse ? String(row.customerResponse).trim() : null,
                follow_up_required: row.followUpRequired ? String(row.followUpRequired).trim() : null,
                follow_up_date: parsedFollowUpDate,
                follow_up_time: followUpTimeVal,
                next_action: row.nextAction ? String(row.nextAction).trim() : null,
                remarks: row.remarks ? String(row.remarks).trim() : null,
                converted: row.converted ? String(row.converted).trim() : null,
                custom_data: row.customData ? JSON.stringify(row.customData) : '{}',
                business_type: prodServiceVal,
                business_name: leadNameVal,
                address: mapLocVal,
                appointment_date: parsedFollowUpDate,
                appointment_timings: followUpTimeVal,
                source: 'bulk_upload',
                csv_batch_id: batchId,
                created_by: uploadedBy,
                employee_name_raw: employeeNameRaw || null,
                csvRowNum: rowNum,
                originalRow: rawRow,
            });
        });

        for (let i = 0; i < validRows.length; i += BATCH_SIZE) {
            const chunk = validRows.slice(i, i + BATCH_SIZE);
            const chunkRows = chunk.map(r => RAW_DATA_COLUMNS.map(c => r[c]));
            try {
                const inserted = await bulkInsert({ query }, 'raw_data', RAW_DATA_COLUMNS, chunkRows, { onConflict: '' });
                successCount += inserted.length;
                for (const r of chunk) {
                    rowOutcomes.push({ row: r.csvRowNum, status: 'success', id: r.id });
                }
            } catch {
                // Fall back row-by-row so one bad row never sinks the whole chunk.
                for (const r of chunk) {
                    try {
                        await bulkInsert({ query }, 'raw_data', RAW_DATA_COLUMNS, [RAW_DATA_COLUMNS.map(c => r[c])], { onConflict: '' });
                        successCount += 1;
                        rowOutcomes.push({ row: r.csvRowNum, status: 'success', id: r.id });
                    } catch (singleErr) {
                        const rawErr = singleErr.cause || singleErr;
                        const isDup = rawErr.code === '23505';
                        const reason = isDup ? 'Duplicate: mobile number already exists' : rawErr.message;
                        if (isDup) {
                            duplicateCount++;
                            errors.push({ row: r.csvRowNum, code: ErrorCodes.DUPLICATE_PHONE, field: 'phoneNumber', reason, originalRow: r.originalRow });
                            rowOutcomes.push({ row: r.csvRowNum, status: 'duplicate', reason });
                        } else {
                            errors.push({ row: r.csvRowNum, code: ErrorCodes.DB_CONSTRAINT, reason: `Insert failed for ${r.lead_name || r.phone_number}: ${reason}`, originalRow: r.originalRow });
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

        console.log(`[RawData Processor] Batch final report: total=${totalRows}, outcomes=${outcomeTotal} (success=${outcomeSuccess}, duplicates=${outcomeDuplicate}, failed=${outcomeFailed})`);

        const persistedEntries = [...errors, ...warnings.map(w => ({ ...w, warning: true }))];
        await emitProgress(batchId, uploadedBy, verticalId, 'done', totalRows, successCount, persistedEntries, duplicateCount, outcomeFailed);
        await query(`
            UPDATE csv_upload_logs
            SET status = 'done', success_count = $1, failed_count = $2, duplicate_count = $3, errors = $4, processing_finished_at = NOW()
            WHERE id = $5
        `, [successCount, outcomeFailed, duplicateCount, JSON.stringify(persistedEntries), batchId]);

        broadcastToAll({ type: 'RAW_DATA_MUTATED', verticalId, action: 'bulk_upload', batchId });
    } catch (error) {
        logger.error({ correlationId: batchId, section: 'raw_data', operation: 'bulk_upload', verticalId, uploadedBy, err: { message: error.message, stack: error.stack } }, `[rawDataProcessor] job ${batchId} failed: ${error.message}`);
        const failedErrors = errors.length > 0 ? errors : [{ row: 0, code: ErrorCodes.INTERNAL_ERROR, reason: error.message }];
        await query('UPDATE csv_upload_logs SET status = $1, errors = $2 WHERE id = $3', ['failed', JSON.stringify(failedErrors), batchId]);
        await emitProgress(batchId, uploadedBy, verticalId, 'failed', totalRows, successCount, failedErrors, duplicateCount).catch(() => {});
        throw error;
    }
};

export default processRawDataJob;
