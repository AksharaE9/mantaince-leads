import { query } from '../config/db.js';
import crypto from 'crypto';
import { invalidateOnLeadChange, cacheSet } from '../services/cache.js';
import { broadcastToAll } from '../services/assignmentBroadcaster.js';
import { parseUploadBuffer } from '../services/spreadsheetParser.js';
import { ErrorCodes } from '../utils/operationError.js';
import { logger } from '../lib/logger.js';
import { hasFollowupData, extractFollowupFields, INTERACTION_OUTCOMES } from '../services/interactionLogImportSchema.js';

const BATCH_SIZE = 1_000;

const sanitizePhone = (phone) => {
    if (phone === undefined || phone === null) return '';
    let str = phone.toString().trim();
    if (!str) return '';
    const parts = str.split(/\/|,|;|\b(or|and)\b|\(/i);
    let mainPart = parts[0].trim();
    const subParts = mainPart.split(/\s+/);
    if (subParts.length > 1) {
        const cleanFirstSubpart = subParts[0].replace(/[^\d+]/g, '');
        if (cleanFirstSubpart.length >= 10 || (cleanFirstSubpart.startsWith('+') && cleanFirstSubpart.length >= 8)) {
            mainPart = subParts[0];
        }
    }
    return mainPart.replace(/[^\d+]/g, '');
};

function normalizeRowKeys(rawRow) {
    const row = {};
    for (const k of Object.keys(rawRow)) {
        const key = k.toLowerCase().trim()
            .replace(/\r?\n/g, ' ')
            .replace(/\s*\/\s*/g, '/')
            .replace(/\s+/g, ' ');
        if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') {
            row[key] = rawRow[k];
        }
    }
    return row;
}

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

const PHONE_HEADER_ALIASES = new Set([
    'contact number', 'contact', 'contact no', 'number', 'phone', 'mobile',
    'mobile number', 'phone number', 'mobile no', 'phone no',
]);

export const processInteractionLogJob = async (job) => {
    const { batchId, fileBufferBase64, verticalId, uploadedBy, subVerticalId, leadType = 'CALL', fileExt = '.csv' } = job.data;

    let totalRows = 0;
    let successCount = 0;
    let duplicateCount = 0;
    const errors = [];
    const warnings = [];
    const validLogs = [];

    // 1. Mark job as in-progress
    await query(
        'UPDATE csv_upload_logs SET status = $1, processing_started_at = NOW() WHERE id = $2',
        ['processing', batchId]
    );
    await emitProgress(batchId, uploadedBy, verticalId, 'processing', 0, 0, [], 0);

    try {
        const buffer = Buffer.from(fileBufferBase64, 'base64');
        const { rows, warnings: sheetWarnings } = await parseUploadBuffer(buffer, fileExt);

        totalRows = rows.length;
        await query('UPDATE csv_upload_logs SET total_rows = $1 WHERE id = $2', [totalRows, batchId]);

        if (totalRows === 0) {
            await query(
                "UPDATE csv_upload_logs SET status = 'done', errors = $2, processing_finished_at = NOW() WHERE id = $1",
                [batchId, JSON.stringify(sheetWarnings.map(w => ({ row: 0, code: 'FILE_WARNING', reason: w })))]
            );
            await emitProgress(batchId, uploadedBy, verticalId, 'done', 0, 0, sheetWarnings.map(w => ({ row: 0, code: 'FILE_WARNING', reason: w })), 0);
            return;
        }

        for (const w of sheetWarnings) errors.push({ row: 0, code: 'FILE_WARNING', reason: w });

        // Header Validation
        const originalHeaders = Object.keys(rows[0]);
        const normalizedHeaders = originalHeaders.map(h =>
            h.toLowerCase().trim().replace(/\r?\n/g, ' ').replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ')
        );
        const hasPhone = normalizedHeaders.some(h => PHONE_HEADER_ALIASES.has(h));
        if (!hasPhone) {
            const expectedPhoneAliases = 'Contact Number, Mobile Number, Phone Number, Mobile, Phone';
            throw new Error(`Missing required column: 'Contact Number' (accepted aliases: ${expectedPhoneAliases})`);
        }

        // Pass 1: Parse and normalize all row values
        const parsedRows = [];
        const phoneList = [];
        const rowOutcomes = [];

        for (let idx = 0; idx < rows.length; idx++) {
            const rawRow = rows[idx];
            const rowNum = idx + 1;
            const row = normalizeRowKeys(rawRow);

            let phoneHeader = '';
            for (const h of originalHeaders) {
                const norm = h.toLowerCase().trim().replace(/\r?\n/g, ' ').replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ');
                if (PHONE_HEADER_ALIASES.has(norm)) {
                    phoneHeader = h;
                    break;
                }
            }

            const rawPhone = sanitizePhone(rawRow[phoneHeader]);
            const fup = extractFollowupFields(row);

            if (!rawPhone) {
                const reason = 'Missing contact number';
                errors.push({ row: rowNum, code: ErrorCodes.MISSING_REQUIRED_FIELD, field: 'phone', reason, originalRow: rawRow });
                rowOutcomes.push({ row: rowNum, status: 'failed', reason });
                continue;
            }

            if (!fup) {
                const reason = 'Skipped: Row has no follow-up data (Date, Remarks, Time, Outcome, or Next Date)';
                warnings.push({ row: rowNum, field: 'followup', reason, warning: true });
                rowOutcomes.push({ row: rowNum, status: 'skipped', reason });
                continue;
            }

            parsedRows.push({
                rowNum,
                rawPhone,
                fup,
                rawRow
            });
            phoneList.push(rawPhone);
        }

        // Batch resolve phones to Lead IDs in one query
        const phoneToLeadId = new Map();
        if (phoneList.length > 0) {
            // Scoping: find active, non-deleted leads matching vertical, sub-vertical, and leadType
            const existingRes = await query(`
                SELECT id, phone FROM cost_conversions
                WHERE vertical_id = $1 AND sub_vertical_id = $2 AND lead_type = $3
                  AND phone = ANY($4) AND is_deleted = false
            `, [verticalId, subVerticalId, leadType, [...new Set(phoneList)]]);
            for (const r of existingRes.rows) {
                phoneToLeadId.set(r.phone, r.id);
            }
        }

        // Insert valid logs
        const VALID_OUTCOMES_SET = new Set(INTERACTION_OUTCOMES);
        const section = leadType === 'POSITIVE' ? 'positives' : 'cos';

        for (const pr of parsedRows) {
            const leadId = phoneToLeadId.get(pr.rawPhone);
            if (!leadId) {
                const reason = `No matching lead found for contact number "${pr.rawPhone}" in this sub-vertical`;
                errors.push({ row: pr.rowNum, code: 'LEAD_NOT_FOUND', field: 'phone', reason, originalRow: pr.rawRow });
                rowOutcomes.push({ row: pr.rowNum, status: 'failed', reason });
                continue;
            }

            const dateVal = pr.fup.interactionDate ? pr.fup.interactionDate.toString().trim() : '';
            if (!dateVal) {
                const reason = 'Missing Follow-up Date';
                errors.push({ row: pr.rowNum, code: ErrorCodes.MISSING_REQUIRED_FIELD, field: 'followupDate', reason, originalRow: pr.rawRow });
                rowOutcomes.push({ row: pr.rowNum, status: 'failed', reason });
                continue;
            }

            const outcomeVal = pr.fup.outcome && VALID_OUTCOMES_SET.has(pr.fup.outcome) ? pr.fup.outcome : null;

            validLogs.push({
                id: crypto.randomUUID(),
                leadId,
                section,
                interactionDate: dateVal,
                interactionTime: pr.fup.interactionTime || null,
                remarks: pr.fup.remarks || null,
                outcome: outcomeVal,
                nextFollowupDate: pr.fup.nextFollowupDate || null,
                csvRowNum: pr.rowNum,
                originalRow: pr.rawRow
            });
        }

        // Bulk insert chunks
        for (let i = 0; i < validLogs.length; i += BATCH_SIZE) {
            const chunk = validLogs.slice(i, i + BATCH_SIZE);
            const valStrings = [];
            const params = [];
            let p = 1;

            for (const log of chunk) {
                valStrings.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, 'bulk_upload')`);
                params.push(
                    log.id,
                    log.leadId,
                    log.section,
                    log.interactionDate,
                    log.interactionTime,
                    log.remarks,
                    log.outcome,
                    log.nextFollowupDate,
                    batchId
                );
            }

            if (params.length > 0) {
                try {
                    await query(`
                        INSERT INTO lead_interaction_logs
                            (id, lead_id, section, interaction_date, interaction_time,
                             remarks, outcome, next_followup_date, csv_batch_id, source)
                        VALUES ${valStrings.join(', ')}
                    `, params);
                    successCount += chunk.length;
                    for (const log of chunk) {
                        rowOutcomes.push({ row: log.csvRowNum, status: 'success', id: log.id });
                    }
                } catch (bulkErr) {
                    console.error('[Interaction Log Processor] Bulk insert chunk failed, falling back to row-by-row', bulkErr.message);
                    // Fallback to row-by-row
                    for (const log of chunk) {
                        try {
                            await query(`
                                INSERT INTO lead_interaction_logs
                                    (id, lead_id, section, interaction_date, interaction_time,
                                     remarks, outcome, next_followup_date, csv_batch_id, source)
                                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'bulk_upload')
                            `, [
                                log.id, log.leadId, log.section, log.interactionDate,
                                log.interactionTime, log.remarks, log.outcome,
                                log.nextFollowupDate, batchId
                            ]);
                            successCount++;
                            rowOutcomes.push({ row: log.csvRowNum, status: 'success', id: log.id });
                        } catch (singleErr) {
                            const reason = singleErr.message;
                            errors.push({ row: log.csvRowNum, code: ErrorCodes.DB_CONSTRAINT, reason, originalRow: log.originalRow });
                            rowOutcomes.push({ row: log.csvRowNum, status: 'failed', reason });
                        }
                    }
                }
            }
        }

        const outcomeSuccess = rowOutcomes.filter(o => o.status === 'success').length;
        const outcomeFailed = rowOutcomes.filter(o => o.status === 'failed').length;
        const outcomeSkipped = rowOutcomes.filter(o => o.status === 'skipped').length;
        const outcomeTotal = outcomeSuccess + outcomeFailed + outcomeSkipped;

        console.log(`[Interaction Log Processor] Batch final report: total=${totalRows}, outcomes=${outcomeTotal} (success=${outcomeSuccess}, failed=${outcomeFailed}, skipped=${outcomeSkipped})`);

        const persistedEntries = [...errors, ...warnings];
        await query(`
            UPDATE csv_upload_logs
            SET status = 'done', success_count = $1, failed_count = $2,
                duplicate_count = 0, errors = $3, processing_finished_at = NOW()
            WHERE id = $4
        `, [successCount, outcomeFailed, JSON.stringify(persistedEntries), batchId]);

        await emitProgress(batchId, uploadedBy, verticalId, 'done', totalRows, successCount, persistedEntries, 0, outcomeFailed);

        invalidateOnLeadChange(verticalId, null).catch(() => {});
        try {
            broadcastToAll({ type: 'COST_CONVERSION_MUTATED', verticalId, action: 'csv_upload', batchId });
        } catch (broadcastErr) {
            console.error('[Interaction Log Processor] SSE broadcast failed:', broadcastErr.message);
        }

    } catch (error) {
        logger.error({ correlationId: batchId, section: 'bulk_upload', operation: 'bulk_upload_interaction_logs', verticalId, uploadedBy, err: { message: error.message, stack: error.stack } }, `[interactionLogProcessor] job ${batchId} failed: ${error.message}`);
        const failedErrors = errors.length > 0 ? errors : [{ row: 0, code: ErrorCodes.INTERNAL_ERROR, reason: error.message }];
        await query(
            'UPDATE csv_upload_logs SET status = $1, errors = $2 WHERE id = $3',
            ['failed', JSON.stringify(failedErrors), batchId]
        );
        await emitProgress(batchId, uploadedBy, verticalId, 'failed', totalRows || 0, successCount || 0, failedErrors, 0).catch(() => {});
        throw error;
    }
};

export default processInteractionLogJob;
