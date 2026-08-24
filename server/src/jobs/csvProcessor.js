import { query } from '../config/db.js';
import crypto from 'crypto';
import { invalidateOnLeadChange, cacheSet } from '../services/cache.js';
import { broadcastToAll } from '../services/assignmentBroadcaster.js';
import { parseUploadBuffer } from '../services/spreadsheetParser.js';
import { ErrorCodes } from '../utils/operationError.js';
import { logger } from '../lib/logger.js';
import { hasFollowupData, extractFollowupFields, INTERACTION_OUTCOMES } from '../services/interactionLogImportSchema.js';

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
            row.id || crypto.randomUUID(),
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
    `;
    return { sql, params };
}

/**
 * Emit a progress snapshot to the in-process cache.
 * Called only at batch boundaries (not per-row) to avoid cache churn.
 */
// `failedCountOverride`: the cached snapshot's `failed_count` normally
// equals `errorsArr.length`, which is correct while `errorsArr` only ever
// holds genuine blocking failures. The final 'done' snapshot below passes an
// `errorsArr` that also includes non-blocking warnings (so a client reading
// from cache sees the same warnings the persisted DB report has — see the
// phone-number-only-mandatory policy note above `warnings` at the top of
// this file); pass the real failed-row count explicitly there so it isn't
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

// All the normalized header aliases that can resolve to the phone (contact)
// field for COS/Positives imports. Used by the upfront header validator
// to produce a single file-level error instead of N per-row failures.
const PHONE_HEADER_ALIASES = new Set([
    'contact number', 'contact', 'contact no', 'contact no.', 'number', 'phone', 'mobile',
    'mobile number', 'phone number', 'contact number', 'mobile no', 'mobile no.', 'phone no', 'phone no.',
]);

// Aliases for the business name column — used to detect if the column exists.
const BUSINESS_NAME_HEADER_ALIASES = new Set([
    'business/person/shop/company name',
    'business/person/shop/company name',
    'business person, shop, and company name',
    'name', 'business name', 'business', 'lead name', 'company name',
]);

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
 * Upfront header check for COS/Positives — runs BEFORE any row-level
 * processing. Returns { ok: false, fatalError } if no phone column can
 * be found at all, otherwise { ok: true } plus non-blocking notices.
 */
function validateCsvFileHeaders(rawRows, leadType) {
    if (!rawRows || rawRows.length === 0) return { ok: true };

    const originalHeaders = Object.keys(rawRows[0]).filter(h => !h.startsWith('_'));
    const normalizedHeaders = originalHeaders.map(h =>
        h.toLowerCase().trim().replace(/\r?\n/g, ' ').replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ')
    );

    const hasPhone = normalizedHeaders.some(h => PHONE_HEADER_ALIASES.has(h));
    if (!hasPhone) {
        const section = leadType === 'POSITIVE' ? 'Positives & Follow-ups' : 'COS';
        const foundList = originalHeaders.join(', ');
        const expectedPhoneAliases = 'Contact Number, Mobile Number, Phone Number, Mobile, Phone';
        
        // Find best suggestions from unmapped headers
        let suggestions = '';
        let bestMatch = null;
        let highestSimilarity = 0.0;
        for (const unmatched of originalHeaders) {
            const sim = getSimilarity('Contact Number', unmatched);
            if (sim > highestSimilarity) {
                highestSimilarity = sim;
                bestMatch = unmatched;
            }
        }
        if (highestSimilarity > 0.6 && bestMatch) {
            suggestions = ` Did you mean '${bestMatch}'?`;
        }

        return {
            ok: false,
            fatalError: {
                row: 0,
                code: 'FILE_STRUCTURE_ERROR',
                reason:
                    `This file doesn't match the ${section} template. ` +
                    `Missing required column: 'Contact Number' (also accepted as: ${expectedPhoneAliases}).${suggestions} ` +
                    `Found columns: ${foundList}. ` +
                    `Please download the current template and re-upload.`,
            },
        };
    }

    // Informational: report any unrecognized columns
    const KNOWN_HEADERS_CALL = new Set([
        'date', 'employee name', 'business type',
        'business/person/shop/company name', 'name', 'business name',
        'contact number', 'contact', 'phone', 'mobile', 'mobile number', 'phone number',
        'point of contact', 'pointofcontact', 'area', 'city',
        'link address', 'delivered location', 'address', 'map location link/address', 'map location link / address',
        'remarks', 'recordings',
        'appointment type (yes or no)', 'appointment type', 'appointment date', 'appointment time', 'appointment timings',
        'requirement order if any', 'requirement',
        'notes to the cos if any', 'notes',
        'follow up require (yes/no)', 'follow-up require (yes/no)', 'follow-up required',
        'follow up date', 'follow-up date', 'follow-up dates',
        'follow up remarks', 'follow-up remarks',
        // Ignored columns
        'sl no', 'sl. no', 's no', 's. no', 'serial no', 'serial number',
        // Interaction log columns (appended by getLeadImportSchema)
        'follow-up date', 'follow-up time', 'follow-up remarks', 'follow-up outcome', 'next follow-up date',
        'followup date', 'followup time', 'followup remarks', 'followup outcome', 'next followup date',
    ]);
    const KNOWN_HEADERS_POSITIVE = new Set([
        'date', 'employee name', 'business type',
        'business/person/shop/company name', 'name', 'business name',
        'area', 'city', 'contact number', 'contact', 'phone', 'mobile', 'mobile number', 'phone number',
        'point of contact', 'pointofcontact', 'remarks', 'recordings',
        'follow-up required', 'follow-ups', 'follow-up dates', 'follow-up remarks',
        'follow up require (yes/no)', 'follow-up require (yes/no)', 'follow up date', 'follow-up date', 'follow up remarks', 'follow-up remarks',
        'requirement if any', 'requirement', 'requirement order if any',
        'a notes to the cos team only', 'notes', 'notes to the cos if any',
        'link address', 'delivered location', 'address', 'map location link/address', 'map location link / address',
        'positive(y/n)', 'positive', 'positive yn', 'converted (y/n)', 'converted', 'appointment date', 'appointment time', 'appointment timings',
        // Ignored columns
        'sl no', 'sl. no', 's no', 's. no', 'serial no', 'serial number',
        // Interaction log columns (appended by getLeadImportSchema)
        'follow-up date', 'follow-up time', 'follow-up remarks', 'follow-up outcome', 'next follow-up date',
        'followup date', 'followup time', 'followup remarks', 'followup outcome', 'next followup date',
    ]);
    const knownSet = leadType === 'POSITIVE' ? KNOWN_HEADERS_POSITIVE : KNOWN_HEADERS_CALL;
    const extraColumns = originalHeaders.filter((h, i) => {
        const normalized = normalizedHeaders[i];
        if (normalized === 'sl no' || normalized === 'sl. no' || normalized === 's no' || normalized === 's. no' || normalized === 'serial no' || normalized === 'serial number') return false;
        return !knownSet.has(normalized);
    });
    return { ok: true, extraColumns };
}

/**
 * Queue processor function — called by worker.js for each queued CSV upload.
 */
const processCsvJob = async (job) => {
    const { batchId, fileBufferBase64, verticalId, uploadedBy, assignedTo, subVerticalId, leadType = 'CALL', fileExt = '.csv', sheetIndices = [0] } = job.data;

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
    const warnings = [];
    const validLeads = [];
    const pendingFollowups = [];

    // ── 2. Mark job as in-progress ────────────────────────────────────────────
    await query(
        'UPDATE csv_upload_logs SET status = $1, processing_started_at = NOW() WHERE id = $2',
        ['processing', batchId]
    );
    await emitProgress(batchId, uploadedBy, verticalId, 'processing', 0, 0, [], 0);

    try {
        // ── 3. Parse the uploaded file (CSV or Excel — format-agnostic from here on) ──
        const buffer = Buffer.from(fileBufferBase64, 'base64');
        const { rows, warnings: fileWarnings = [], sheetNames = [] } = await parseUploadBuffer(buffer, fileExt, sheetIndices);

        totalRows = rows.length;
        await query('UPDATE csv_upload_logs SET total_rows = $1 WHERE id = $2', [totalRows, batchId]);

        if (totalRows === 0) {
            await query(
                "UPDATE csv_upload_logs SET status = 'done', errors = $2, processing_finished_at = NOW() WHERE id = $1",
                [batchId, JSON.stringify(fileWarnings.map(w => ({ row: 0, code: 'FILE_WARNING', reason: w })))]
            );
            await emitProgress(batchId, uploadedBy, verticalId, 'done', 0, 0, fileWarnings.map(w => ({ row: 0, code: 'FILE_WARNING', reason: w })), 0);
            return;
        }

        // Sheet/format warnings ride along as informational, non-fatal row-0 entries.
        for (const w of fileWarnings) errors.push({ row: 0, code: 'FILE_WARNING', reason: w });

        await emitProgress(batchId, uploadedBy, verticalId, 'processing', totalRows, 0, errors, 0);

        // ── 4. Load field configs + agent map in parallel ─────────────────────
        const [configsRes, agentsRes] = await Promise.all([
            query(
                'SELECT field_key, csv_header, label FROM field_configs WHERE vertical_id = $1',
                [verticalId]
            ),
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
                row['contact number'] || row['phone number'] || row['mobile number'] ||
                row['contact'] || row['phone'] || row['mobile'] ||
                row['contact no'] || row['phone no'] || row['mobile no'] ||
                row['phone no.'] || row['mobile no.'] || row['contact no.'] ||
                row['number'] || ''
            );
            if (rawPhone) csvPhones.push(rawPhone);
        }

        // ── 6. Batch-lookup existing phones (single query) ────────────────────
        const uniqueCsvPhones = [...new Set(csvPhones)];
        let existingPhones = [];
        const conflictLabelByPhone = new Map();
        if (uniqueCsvPhones.length > 0) {
            const existingRes = await query(
                `SELECT phone, name, business_name FROM cost_conversions
                 WHERE vertical_id = $1 AND sub_vertical_id = $4 AND is_deleted = false
                   AND lead_type = $3
                   AND phone = ANY($2)`,
                [verticalId, uniqueCsvPhones, leadType, subVerticalId]
            );
            existingPhones = existingRes.rows.map(l => sanitizePhone(l.phone));
            for (const row of existingRes.rows) {
                conflictLabelByPhone.set(sanitizePhone(row.phone), row.business_name || row.name || null);
            }
        }
        // phoneSet tracks both DB duplicates AND within-CSV duplicates
        const phoneSet = new Set(existingPhones);
        const rowOutcomes = [];

        const activeSheets = sheetNames.length > 0 ? sheetNames : ['Sheet 1'];
        const sheetStats = new Map();
        activeSheets.forEach(sheetName => {
            sheetStats.set(sheetName, { success: 0, duplicates: 0, failed: 0, status: 'pending' });
        });

        // ── 7. Second pass: validate per sheet + build validLeads array ─────────────────
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

            // Upfront header check per sheet
            const csvHeaderCheck = validateCsvFileHeaders(sheetRows, leadType);
            if (!csvHeaderCheck.ok) {
                stats.status = 'failed';
                errors.push({
                    row: 0,
                    code: 'SHEET_ERROR',
                    reason: `Sheet "${sheetName}" failed template validation: ${csvHeaderCheck.fatalError.reason}`,
                    sheetName,
                    warning: false
                });
                continue;
            }

            // Unrecognized columns warning per sheet
            if (csvHeaderCheck.extraColumns && csvHeaderCheck.extraColumns.length > 0) {
                errors.push({
                    row: 0,
                    code: 'FILE_WARNING',
                    reason: `Sheet "${sheetName}": Unrecognized columns ignored: ${csvHeaderCheck.extraColumns.join(', ')}`,
                    sheetName,
                    warning: true,
                });
            }

            // Check if phone column is entirely empty in all rows
            const sheetNormalized = sheetRows.map(r => normalizeRowKeys(r));
            const hasAnyPhone = sheetNormalized.some(r => {
                const phoneKey = r['contact number'] || r['phone number'] || r['mobile number'] ||
                                 r['contact'] || r['phone'] || r['mobile'] ||
                                 r['contact no'] || r['phone no'] || r['mobile no'] ||
                                 r['phone no.'] || r['mobile no.'] || r['contact no.'] ||
                                 r['number'] || '';
                return phoneKey && sanitizePhone(phoneKey) !== '';
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

                const rawPhone = sanitizePhone(
                    row['contact number'] || row['phone number'] || row['mobile number'] ||
                    row['contact'] || row['phone'] || row['mobile'] ||
                    row['contact no'] || row['phone no'] || row['mobile no'] ||
                    row['phone no.'] || row['mobile no.'] || row['contact no.'] ||
                    row['number'] || ''
                );
                const rawName =
                    row['business/person/shop/company name'] ||
                    row['business person, shop, and company name'] ||
                    row['name'] || row['business'] || row['business name'] || '';
                const rawBusiness =
                    row['business/person/shop/company name'] ||
                    row['business person, shop, and company name'] ||
                    row['business'] || row['business name'] || '';

                if (!rawPhone) {
                    stats.failed++;
                    const reason = 'Missing contact number';
                    errors.push({ row: rowNum, code: ErrorCodes.MISSING_REQUIRED_FIELD, field: 'phone', reason, originalRow: rawRow, sheetName });
                    rowOutcomes.push({ row: rowNum, status: 'failed', reason, sheetName });
                    return;
                }

                if (!rawName.trim()) {
                    warnings.push({ row: rowNum, field: 'name', reason: `Sheet "${sheetName}": Business / Person / Shop / Company name is blank — accepted, left blank`, sheetName });
                }

                const rowHasFollowup = hasFollowupData(row);

                if (phoneSet.has(rawPhone)) {
                    if (rowHasFollowup) {
                        const fup = extractFollowupFields(row);
                        if (fup) {
                            pendingFollowups.push({
                                phone: rawPhone,
                                leadId: null, // resolved post-insert
                                section: leadType === 'POSITIVE' ? 'positives' : 'cos',
                                ...fup,
                                csvRowNum: rowNum,
                                _sheetName: sheetName
                            });
                            rowOutcomes.push({ row: rowNum, status: 'followup_appended', reason: `Interaction log entry queued for phone ${rawPhone}`, sheetName });
                        } else {
                            rowOutcomes.push({ row: rowNum, status: 'skipped', reason: `Skipped (same phone, no follow-up data after extraction)`, sheetName });
                        }
                        return;
                    }

                    // Genuine duplicate
                    duplicateCount++;
                    stats.duplicates++;
                    const conflictLabel = conflictLabelByPhone.get(rawPhone);
                    const reason = conflictLabel
                        ? `Duplicate: contact number already exists in this sub-vertical (conflicts with "${conflictLabel}")`
                        : `Duplicate: contact number already exists (also appears earlier in Sheet "${sheetName}")`;
                    errors.push({ row: rowNum, code: ErrorCodes.DUPLICATE_PHONE, field: 'phone', reason, originalRow: rawRow, sheetName });
                    rowOutcomes.push({ row: rowNum, status: 'duplicate', reason, sheetName });
                    return;
                }

                phoneSet.add(rawPhone);

                const dataMap = {};
                dataMap['date']              = row['date'] || '';
                dataMap['employeeName']      = defaultAssigneeName || row['employee name'] || '';
                dataMap['businessType']      = row['business type'] || '';
                dataMap['businessName']      = rawBusiness;
                dataMap['area']              = row['area'] || '';
                dataMap['city']              = row['city'] || '';
                dataMap['deliveredLocation'] = row['map location link/address'] || row['map location link / address'] || row['link address'] || row['delivered location'] || row['address'] || '';
                dataMap['requirement']       = row['requirement'] || row['requirement if any'] || row['requirement order if any'] || '';
                dataMap['remarks']           = row['remarks'] || '';
                dataMap['followUpRequired']  = row['follow up require (yes/no)'] || row['follow-up require (yes/no)'] || row['follow-up required'] || row['appointment type (yes or no)'] || row['appointment type'] || '';
                dataMap['followUpDate']      = row['follow up date'] || row['follow-up date'] || row['follow-up dates'] || row['appointment date'] || '';
                dataMap['followUpRemarks']   = row['follow up remarks'] || row['follow-up remarks'] || row['notes to the cos if any'] || row['a notes to the cos team only'] || row['notes'] || '';

                if (leadType === 'POSITIVE') {
                    dataMap['positive']          = row['positive(y/n)'] || row['positive'] || '';
                    dataMap['converted']         = row['converted (y/n)'] || row['converted'] || '';
                    dataMap['appointmentDate']   = row['appointment date'] || '';
                    dataMap['appointmentTime']   = row['appointment time'] || row['appointment timings'] || '';
                }

                for (const cfg of configs) {
                    const header = (cfg.csv_header || cfg.label).toLowerCase().trim();
                    const fieldKey = cfg.field_key;
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

                const empSpokenName = (row['employee name'] || '').toLowerCase().trim();
                const rowAssignedTo = assignedTo || agentMap.get(empSpokenName) || null;

                validLeads.push({
                    id:           crypto.randomUUID(),
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
                    _sheetName:   sheetName
                });

                const newLead = validLeads[validLeads.length - 1];
                if (rowHasFollowup) {
                    const fup = extractFollowupFields(row);
                    if (fup) {
                        pendingFollowups.push({
                            phone: rawPhone,
                            leadId: newLead.id,
                            section: leadType === 'POSITIVE' ? 'positives' : 'cos',
                            ...fup,
                            csvRowNum: rowNum,
                            _sheetName: sheetName
                        });
                    }
                }
            });
        }

        // ── 8. Bulk INSERT in BATCH_SIZE chunks ───────────────────────────────
        for (let i = 0; i < validLeads.length; i += BATCH_SIZE) {
            const chunk = validLeads.slice(i, i + BATCH_SIZE);
            try {
                const { sql, params } = buildBulkInsertSql(
                    chunk, verticalId, subVerticalId, assignedTo, uploadedBy, batchId
                );
                await query(sql, params);
                successCount += chunk.length;
                for (const lead of chunk) {
                    rowOutcomes.push({ row: lead.csvRowNum, status: 'success', id: lead.id, sheetName: lead._sheetName });
                    if (sheetStats.has(lead._sheetName)) {
                        sheetStats.get(lead._sheetName).success++;
                    }
                }
            } catch (chunkErr) {
                console.warn(`[CSV Processor] Bulk insert failed for rows ${i + 1}–${Math.min(i + BATCH_SIZE, validLeads.length)}, falling back to row-by-row.`);
                for (const lead of chunk) {
                    try {
                        const { sql, params } = buildBulkInsertSql(
                            [lead], verticalId, subVerticalId, assignedTo, uploadedBy, batchId
                        );
                        await query(sql, params);
                        successCount++;
                        rowOutcomes.push({ row: lead.csvRowNum, status: 'success', id: lead.id, sheetName: lead._sheetName });
                        if (sheetStats.has(lead._sheetName)) {
                            sheetStats.get(lead._sheetName).success++;
                        }
                    } catch (singleErr) {
                        const isDup = singleErr.code === '23505';
                        const reason = isDup ? 'Duplicate: contact number already exists' : singleErr.message;
                        if (isDup) {
                            duplicateCount++;
                            if (sheetStats.has(lead._sheetName)) {
                                sheetStats.get(lead._sheetName).duplicates++;
                            }
                            errors.push({ row: lead.csvRowNum, code: ErrorCodes.DUPLICATE_PHONE, field: 'phone', reason, originalRow: lead.originalRow, sheetName: lead._sheetName });
                            rowOutcomes.push({ row: lead.csvRowNum, status: 'duplicate', reason, sheetName: lead._sheetName });
                        } else {
                            if (sheetStats.has(lead._sheetName)) {
                                sheetStats.get(lead._sheetName).failed++;
                            }
                            errors.push({ row: lead.csvRowNum, code: ErrorCodes.DB_CONSTRAINT, reason, originalRow: lead.originalRow, sheetName: lead._sheetName });
                            rowOutcomes.push({ row: lead.csvRowNum, status: 'failed', reason, sheetName: lead._sheetName });
                        }
                    }
                }
            }

            const progress = Math.round(((i + chunk.length) / validLeads.length) * 100);
            await job.progress(progress);
            await emitProgress(batchId, uploadedBy, verticalId, 'processing', totalRows, successCount, errors, duplicateCount);
        }

        // ── 8.5. Insert pending interaction logs (follow-up appended rows) ──────
        if (pendingFollowups.length > 0) {
            const unresolvedPhones = [...new Set(
                pendingFollowups.filter(f => !f.leadId).map(f => f.phone)
            )];
            const phoneToLeadId = new Map();
            if (unresolvedPhones.length > 0) {
                const existingRes = await query(`
                    SELECT id, phone FROM cost_conversions
                    WHERE vertical_id = $1 AND sub_vertical_id = $2 AND lead_type = $3
                      AND phone = ANY($4) AND is_deleted = false
                `, [verticalId, subVerticalId, leadType, unresolvedPhones]);
                for (const row of existingRes.rows) {
                    phoneToLeadId.set(row.phone, row.id);
                }
            }

            const VALID_OUTCOMES_SET = new Set(['Interested', 'Not Reachable', 'Callback Requested', 'Not Interested', 'Converted']);

            const logValues = [];
            const logParams = [];
            let lp = 1;
            for (const fup of pendingFollowups) {
                const resolvedLeadId = fup.leadId || phoneToLeadId.get(fup.phone);
                if (!resolvedLeadId) {
                    errors.push({
                        row: fup.csvRowNum,
                        code: 'INTERACTION_LOG_ORPHAN',
                        reason: `Could not resolve lead for phone ${fup.phone} — interaction log entry skipped`,
                        warning: true,
                        sheetName: fup._sheetName
                    });
                    if (sheetStats.has(fup._sheetName)) {
                        sheetStats.get(fup._sheetName).failed++;
                    }
                    continue;
                }
                const dateVal = fup.interactionDate ? fup.interactionDate.toString().trim() : '';
                if (!dateVal) continue;

                const outcomeVal = fup.outcome && VALID_OUTCOMES_SET.has(fup.outcome) ? fup.outcome : null;

                logValues.push(`($${lp++}, $${lp++}, $${lp++}, $${lp++}, $${lp++}, $${lp++}, $${lp++}, $${lp++}, $${lp++}, 'bulk_upload')`);
                logParams.push(
                    crypto.randomUUID(),
                    resolvedLeadId,
                    fup.section,
                    dateVal,
                    fup.interactionTime || null,
                    fup.remarks || null,
                    outcomeVal,
                    fup.nextFollowupDate || null,
                    batchId,
                );
                if (sheetStats.has(fup._sheetName)) {
                    sheetStats.get(fup._sheetName).success++;
                }
            }

            if (logValues.length > 0) {
                try {
                    await query(`
                        INSERT INTO lead_interaction_logs
                            (id, lead_id, section, interaction_date, interaction_time,
                             remarks, outcome, next_followup_date, csv_batch_id, source)
                        VALUES ${logValues.join(', ')}
                    `, logParams);
                    console.log(`[CSV Processor] Inserted ${logValues.length} interaction log entries for batch ${batchId}`);
                } catch (logErr) {
                    console.error('[CSV Processor] Interaction log bulk insert failed (non-fatal):', logErr.message);
                    errors.push({
                        row: 0,
                        code: 'INTERACTION_LOG_INSERT_FAILED',
                        reason: `Some follow-up log entries could not be saved: ${logErr.message}`,
                        warning: true,
                    });
                }
            }
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
        const outcomeFailed = rowOutcomes.filter(o => o.status === 'failed').length;
        const outcomeFollowupAppended = rowOutcomes.filter(o => o.status === 'followup_appended').length;
        const outcomeSkipped = rowOutcomes.filter(o => o.status === 'skipped').length;
        const outcomeTotal = outcomeSuccess + outcomeDuplicate + outcomeFailed + outcomeFollowupAppended + outcomeSkipped;

        console.log(`[CSV Processor] Batch final report: total=${totalRows}, outcomes=${outcomeTotal} (success=${outcomeSuccess}, duplicates=${outcomeDuplicate}, failed=${outcomeFailed}, followup_appended=${outcomeFollowupAppended}, skipped=${outcomeSkipped})`);
        if (outcomeTotal !== totalRows) {
            console.error(`[CSV Processor] MISMATCH warning: totalRows (${totalRows}) !== outcomeTotal (${outcomeTotal})`);
        }

        // ── 9. Finalize ───────────────────────────────────────────────────────
        const persistedEntries = [...errors, ...warnings.map(w => ({ ...w, warning: true }))];
        await query(`
            UPDATE csv_upload_logs
            SET status = 'done', success_count = $1, failed_count = $2,
                duplicate_count = $3, errors = $4, processing_finished_at = NOW()
            WHERE id = $5
        `, [successCount, outcomeFailed, duplicateCount, JSON.stringify(persistedEntries), batchId]);

        await emitProgress(batchId, uploadedBy, verticalId, 'done', totalRows, successCount, persistedEntries, duplicateCount, outcomeFailed);

        invalidateOnLeadChange(verticalId, null).catch(() => {});

        try {
            broadcastToAll({ type: 'COST_CONVERSION_MUTATED', verticalId, action: 'csv_upload', batchId });
        } catch (broadcastErr) {
            console.error('[CSV Processor] SSE broadcast failed:', broadcastErr.message);
        }

        await job.progress(100);

    } catch (error) {
        logger.error({ correlationId: batchId, section: 'bulk_upload', operation: 'bulk_upload', verticalId, uploadedBy, err: { message: error.message, stack: error.stack } }, `[csvProcessor] job ${batchId} failed: ${error.message}`);
        const failedErrors = errors && errors.length > 0 ? errors : [{ row: 0, code: ErrorCodes.INTERNAL_ERROR, reason: error.message }];
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
