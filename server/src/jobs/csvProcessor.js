import { query } from '../config/db.js';
import crypto from 'crypto';
import { invalidateOnLeadChange, cacheSet } from '../services/cache.js';
import { broadcastToAll } from '../services/assignmentBroadcaster.js';
import { parseUploadBuffer } from '../services/spreadsheetParser.js';

// ── Batch sizing ───────────────────────────────────────────────────────────────
// 1000 rows per INSERT: matches bulkInsert.js CHUNK_SIZE, halves round-trips vs. 500.
// PostgreSQL limit is 65535 params; 12 cols × 1000 rows = 12000 params — well within limit.
const BATCH_SIZE = 1_000;

// ── Progress report interval ───────────────────────────────────────────────────
// Only write progress to cache at batch-insert milestones (not on every 100th validation row)
const PROGRESS_INTERVAL_ROWS = 500;

/**
 * CSV formula injection sanitizer
 */
const sanitizeFormula = (val) => {
    if (val === undefined || val === null) return '';
    const str = val.toString().trim();
    if (/^[+\-][\d\s()\-.]+$/.test(str)) return str; // Allow phone/numeric formats
    if (/^[=+\-@\t\r]/.test(str)) return ''; // Neutralize CSV injection
    return str;
};

/**
 * Coerces phone format — keeps only digits and leading +.
 * Handles multi-phone cells like "9876543210 / 9123456789" or "98765,91234"
 */
const sanitizePhone = (phone) => {
    if (phone === undefined || phone === null) return '';
    let str = phone.toString().trim();
    if (!str) return '';

    // Split by common delimiters like slash, comma, semicolon, "or"/"and" with word boundaries
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

/**
 * Normalize raw CSV row keys to lowercase, trimmed, newline-collapsed.
 */
function normalizeRowKeys(rawRow) {
    const row = {};
    for (const k of Object.keys(rawRow)) {
        let key = k.toLowerCase().trim()
            .replace(/\r?\n/g, ' ')
            .replace(/\s*\/\s*/g, '/')
            .replace(/\s+/g, ' ');
        // Prototype pollution guard
        if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') {
            row[key] = sanitizeFormula(rawRow[k]);
        }
    }
    return row;
}

/**
 * Build a multi-row VALUES SQL and params for bulk INSERT.
 * 12 columns per row × BATCH_SIZE = well below the 65535 pg param limit.
 */
function buildBulkInsertSql(rows, verticalId, subVerticalId, defaultAssignedTo, uploadedBy, batchId) {
    const COLS_PER_ROW = 12;
    const colNames = [
        'id', 'vertical_id', 'sub_vertical_id', 'assigned_to',
        'uploaded_by', 'name', 'phone', 'business_name',
        'data', 'csv_batch_id', 'lead_type', 'status'
    ];

    const valuePlaceholders = [];
    const params = [];
    let p = 1;

    for (const row of rows) {
        const placeholders = [];
        for (let i = 0; i < COLS_PER_ROW; i++) {
            placeholders.push(`$${p++}`);
        }
        valuePlaceholders.push(`(${placeholders.join(', ')})`);
        params.push(
            crypto.randomUUID(),
            verticalId,
            row.subVerticalId || subVerticalId || null,
            row.assignedTo || defaultAssignedTo || null,
            uploadedBy,
            row.name,
            row.phone,
            row.businessName,
            JSON.stringify(row.data),
            batchId,
            row.leadType || 'CALL',
            row.status || 'new'
        );
    }

    const sql = `
        INSERT INTO cost_conversions (${colNames.join(', ')})
        VALUES ${valuePlaceholders.join(', ')}
        ON CONFLICT DO NOTHING
    `;
    return { sql, params };
}

/**
 * Emit a progress snapshot to the in-process cache.
 * Called only at batch boundaries (not per-row) to avoid cache churn.
 */
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
    }, 3_600);
}

/**
 * Queue processor function — called by worker.js for each queued CSV upload.
 */
const processCsvJob = async (job) => {
    const { batchId, fileBufferBase64, verticalId, uploadedBy, assignedTo, subVerticalId, leadType = 'CALL', fileExt = '.csv' } = job.data;

    // ── 1. Resolve default assignee name ─────────────────────────────────────
    let defaultAssigneeName = '';
    if (assignedTo) {
        try {
            const userRes = await query('SELECT name FROM users WHERE id = $1', [assignedTo]);
            if (userRes.rows[0]) defaultAssigneeName = userRes.rows[0].name;
        } catch (err) {
            console.error('[CSV Processor] Error fetching assignee name:', err.message);
        }
    }

    let totalRows = 0;
    let successCount = 0;
    let duplicateCount = 0;
    const errors = [];
    const validLeads = [];

    // ── 2. Mark job as in-progress ────────────────────────────────────────────
    await query(
        'UPDATE csv_upload_logs SET status = $1, processing_started_at = NOW() WHERE id = $2',
        ['processing', batchId]
    );
    await emitProgress(batchId, uploadedBy, verticalId, 'processing', 0, 0, [], 0);

    try {
        // ── 3. Parse the uploaded file (CSV or Excel — format-agnostic from here on) ──
        const buffer = Buffer.from(fileBufferBase64, 'base64');
        const { rows, warnings } = await parseUploadBuffer(buffer, fileExt);

        totalRows = rows.length;
        await query('UPDATE csv_upload_logs SET total_rows = $1 WHERE id = $2', [totalRows, batchId]);

        if (totalRows === 0) {
            await query(
                "UPDATE csv_upload_logs SET status = 'done', errors = $2, processing_finished_at = NOW() WHERE id = $1",
                [batchId, JSON.stringify(warnings.map(w => ({ row: 0, reason: w })))]
            );
            await emitProgress(batchId, uploadedBy, verticalId, 'done', 0, 0, warnings.map(w => ({ row: 0, reason: w })), 0);
            return;
        }

        // Sheet/format warnings (e.g. "only the first sheet was used") ride along
        // as informational, non-fatal row-0 entries in the same errors array.
        for (const w of warnings) errors.push({ row: 0, reason: w });

        await emitProgress(batchId, uploadedBy, verticalId, 'processing', totalRows, 0, errors, 0);

        // ── 4. Load field configs + agent map in parallel ─────────────────────
        const [configsRes, agentsRes] = await Promise.all([
            query(
                'SELECT field_key, csv_header, label FROM field_configs WHERE vertical_id = $1',
                [verticalId]
            ),
            // Use vertical_access UUID array column on users for agent lookup
            query(
                'SELECT id, name FROM users WHERE is_active = true AND is_approved = true AND $1 = ANY(vertical_access)',
                [verticalId]
            ),
        ]);
        const configs = configsRes.rows;
        const agentMap = new Map(agentsRes.rows.map(a => [a.name.toLowerCase().trim(), a.id]));

        // ── 5. First pass: normalize rows + collect phones ────────────────────
        const normalizedRows = [];
        const csvPhones = [];

        for (const rawRow of rows) {
            const row = normalizeRowKeys(rawRow);
            normalizedRows.push({ row, original: rawRow });

            const rawPhone = sanitizePhone(
                row['contact number'] || row['contact'] || row['contact no'] ||
                row['number'] || row['phone'] || row['mobile'] || ''
            );
            if (rawPhone) csvPhones.push(rawPhone);
        }

        // ── 6. Batch-lookup existing phones (single query) ────────────────────
        const uniqueCsvPhones = [...new Set(csvPhones)];
        let existingPhones = [];
        if (uniqueCsvPhones.length > 0) {
            const existingRes = await query(
                'SELECT phone FROM cost_conversions WHERE vertical_id = $1 AND is_deleted = false AND phone = ANY($2)',
                [verticalId, uniqueCsvPhones]
            );
            existingPhones = existingRes.rows.map(l => sanitizePhone(l.phone));
        }
        // phoneSet tracks both DB duplicates AND within-CSV duplicates
        const phoneSet = new Set(existingPhones);

        // ── 7. Second pass: validate + build validLeads array ─────────────────
        let rowNum = 0;
        for (const { row, original: rawRow } of normalizedRows) {
            rowNum++;

            const rawPhone = sanitizePhone(
                row['contact number'] || row['contact'] || row['contact no'] ||
                row['number'] || row['phone'] || row['mobile'] || ''
            );
            const rawName =
                row['business/person/shop/company name'] ||
                row['business person, shop, and company name'] ||
                row['name'] || '';
            const rawBusiness =
                row['business/person/shop/company name'] ||
                row['business person, shop, and company name'] ||
                row['business'] || row['business name'] || '';

            if (!rawPhone) {
                errors.push({ row: rowNum, reason: 'Missing contact number', originalRow: rawRow });
                continue;
            }

            if (!rawName.trim()) {
                errors.push({ row: rowNum, reason: 'Missing business / person / shop / company name', originalRow: rawRow });
                continue;
            }

            if (phoneSet.has(rawPhone)) {
                duplicateCount++;
                errors.push({ row: rowNum, reason: 'Duplicate: contact number already exists', originalRow: rawRow });
                continue;
            }

            // ── Mark this phone as seen (prevents within-CSV duplicates) ──────
            phoneSet.add(rawPhone);

            // ── Build data payload ────────────────────────────────────────────
            const dataMap = {};
            const isPositiveLead = leadType === 'POSITIVE';

            if (isPositiveLead) {
                dataMap['date']              = row['date'] || '';
                dataMap['employeeName']      = defaultAssigneeName || row['employee name'] || '';
                dataMap['businessType']      = row['business type'] || '';
                dataMap['businessName']      = rawBusiness;
                dataMap['area']              = row['area'] || '';
                dataMap['city']              = row['city'] || '';
                dataMap['pointOfContact']    = row['point of contact'] || row['pointofcontact'] || '';
                dataMap['remarks']           = row['remarks'] || '';
                dataMap['recordings']        = row['recordings'] || '';
                dataMap['followUpRequired']  = row['follow-up required'] || '';
                dataMap['followUps']         = row['follow-ups'] || '';
                dataMap['followUpDates']     = row['follow-up dates'] || '';
                dataMap['followUpRemarks']   = row['follow-up remarks'] || '';
                dataMap['requirement']       = row['requirement if any'] || row['requirement'] || '';
                dataMap['notes']             = row['a notes to the cos team only'] || row['notes'] || '';
            } else {
                dataMap['date']              = row['date'] || '';
                dataMap['employeeName']      = defaultAssigneeName || row['employee name'] || '';
                dataMap['businessType']      = row['business type'] || '';
                dataMap['businessName']      = rawBusiness;
                dataMap['area']              = row['area'] || '';
                dataMap['city']              = row['city'] || '';
                dataMap['pointOfContact']    = row['point of contact'] || row['pointofcontact'] || '';
                dataMap['deliveredLocation'] = row['link address'] || row['delivered location'] || row['address'] || '';
                dataMap['remarks']           = row['remarks'] || '';
                dataMap['recordings']        = row['recordings'] || '';
                dataMap['appointmentType']   = row['appointment type (yes or no)'] || row['appointment type'] || '';
                dataMap['appointmentDate']   = row['appointment date'] || '';
                dataMap['appointmentTime']   = row['appointment time'] || '';
                dataMap['requirement']       = row['requirement order if any'] || row['requirement'] || '';
                dataMap['notes']             = row['notes to the cos if any'] || row['notes'] || '';
            }

            // ── Map custom field configs from CSV headers ─────────────────────
            for (const cfg of configs) {
                const header = (cfg.csv_header || cfg.label).toLowerCase().trim();
                const fieldKey = cfg.field_key;
                // Prototype pollution guard
                if (
                    header !== '__proto__' && header !== 'constructor' && header !== 'prototype' &&
                    fieldKey !== '__proto__' && fieldKey !== 'constructor' && fieldKey !== 'prototype'
                ) {
                    if (row[header] !== undefined) {
                        dataMap[fieldKey] = row[header];
                    } else if (dataMap[fieldKey] === undefined) {
                        dataMap[fieldKey] = '';
                    }
                }
            }

            // ── Resolve per-row agent from "EMPLOYEE NAME" column ─────────────
            const empSpokenName = (row['employee name'] || '').toLowerCase().trim();
            const rowAssignedTo = assignedTo || agentMap.get(empSpokenName) || null;

            validLeads.push({
                name:         rawName,
                phone:        rawPhone,
                businessName: rawBusiness,
                data:         dataMap,
                assignedTo:   rowAssignedTo,
                subVerticalId,
                leadType,
                status:       'new',
                csvRowNum:    rowNum,
                originalRow:  rawRow,
            });
        }

        // ── 8. Bulk INSERT in BATCH_SIZE chunks ───────────────────────────────
        for (let i = 0; i < validLeads.length; i += BATCH_SIZE) {
            const chunk = validLeads.slice(i, i + BATCH_SIZE);
            try {
                const { sql, params } = buildBulkInsertSql(
                    chunk, verticalId, subVerticalId, assignedTo, uploadedBy, batchId
                );
                const result = await query(sql, params);
                successCount += result.rowCount;
            } catch (chunkErr) {
                console.warn(`[CSV Processor] Bulk insert failed for rows ${i + 1}–${Math.min(i + BATCH_SIZE, validLeads.length)}, falling back to row-by-row.`);
                for (const lead of chunk) {
                    try {
                        const { sql, params } = buildBulkInsertSql(
                            [lead], verticalId, subVerticalId, assignedTo, uploadedBy, batchId
                        );
                        const result = await query(sql, params);
                        successCount += result.rowCount;
                    } catch (singleErr) {
                        const reason = singleErr.code === '23505' ? 'Duplicate: contact number already exists' : singleErr.message;
                        errors.push({ row: lead.csvRowNum, reason: reason, originalRow: lead.originalRow });
                    }
                }
            }

            // Emit progress at every batch boundary (not per-row)
            const progress = Math.round(((i + chunk.length) / validLeads.length) * 100);
            await job.progress(progress);

            await emitProgress(batchId, uploadedBy, verticalId, 'processing', totalRows, successCount, errors, duplicateCount);
        }

        // ── 9. Finalize ───────────────────────────────────────────────────────
        await query(`
            UPDATE csv_upload_logs
            SET status = 'done', success_count = $1, failed_count = $2,
                duplicate_count = $3, errors = $4, processing_finished_at = NOW()
            WHERE id = $5
        `, [successCount, errors.length, duplicateCount, JSON.stringify(errors), batchId]);

        await emitProgress(batchId, uploadedBy, verticalId, 'done', totalRows, successCount, errors, duplicateCount);

        // Invalidate lead list + report caches for this vertical
        invalidateOnLeadChange(verticalId, null).catch(() => {});

        try {
            broadcastToAll({ type: 'COST_CONVERSION_MUTATED', verticalId, action: 'csv_upload', batchId });
        } catch (broadcastErr) {
            console.error('[CSV Processor] SSE broadcast failed:', broadcastErr.message);
        }

        await job.progress(100);

    } catch (error) {
        console.error('❌ CSV Job Processing Failed:', error.message);
        const failedErrors = errors && errors.length > 0 ? errors : [{ row: 0, reason: error.message }];
        await query(
            'UPDATE csv_upload_logs SET status = $1, errors = $2 WHERE id = $3',
            ['failed', JSON.stringify(failedErrors), batchId]
        );
        await emitProgress(batchId, uploadedBy, verticalId, 'failed', totalRows || 0, successCount || 0, failedErrors, duplicateCount || 0).catch(() => {});
        throw error;
    }
};

export { processCsvJob };
export default processCsvJob;
