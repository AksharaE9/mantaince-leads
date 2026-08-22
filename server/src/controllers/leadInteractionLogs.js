import { query } from '../config/db.js';
import crypto from 'crypto';
import { logAudit } from '../services/audit.js';
import { broadcastToAll } from '../services/assignmentBroadcaster.js';
import { invalidateOnLeadChange } from '../services/cache.js';
import { isValidUUID } from '../utils/validators/index.js';
import { sendControllerError } from '../utils/dbErrors.js';
import { operationError, ErrorCodes } from '../utils/operationError.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runInBackground } from '../utils/background.js';
import { FOLLOWUP_ONLY_FIELDS } from '../services/interactionLogImportSchema.js';
import { buildXlsxTemplate } from '../services/leadImportTemplate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── CSV formula injection guard ────────────────────────────────────────────────
const escapeCsvVal = (val) => {
    if (val === undefined || val === null) return '';
    const s = val.toString();
    const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return guarded.replace(/"/g, '""');
};

// ── Date formatting helpers ────────────────────────────────────────────────────
function formatDateDMY(val) {
    if (!val) return '-';
    const d = new Date(val);
    if (Number.isNaN(d.getTime())) return String(val);
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = d.getUTCFullYear();
    return `${dd}-${mm}-${yyyy}`;
}

/**
 * Resolve a vertical_id and scoping check for a given lead.
 * Returns null if the lead does not exist or is deleted.
 */
async function resolveLeadScoping(leadId, user) {
    // 1. Try cost_conversions
    let res = await query(
        `SELECT id, vertical_id, sub_vertical_id, lead_type, business_name, name, phone
         FROM cost_conversions WHERE id = $1 AND is_deleted = false`,
        [leadId]
    );
    if (res.rows[0]) {
        const lead = res.rows[0];
        if (user.role !== 'super_admin' && (!user.verticalAccess || !user.verticalAccess.includes(lead.vertical_id))) {
            return { forbidden: true };
        }
        return lead;
    }

    // 2. Try raw_data
    res = await query(
        `SELECT id, vertical_id, sub_vertical_id, business_name, lead_name as name, phone_number as phone
         FROM raw_data WHERE id = $1 AND is_deleted = false`,
        [leadId]
    );
    if (res.rows[0]) {
        const lead = res.rows[0];
        lead.lead_type = 'RAW';
        if (user.role !== 'super_admin' && (!user.verticalAccess || !user.verticalAccess.includes(lead.vertical_id))) {
            return { forbidden: true };
        }
        return lead;
    }

    // 3. Try delivery_data
    res = await query(
        `SELECT id, vertical_id, sub_vertical_id, business_name, contact_person as name, phone_number as phone
         FROM delivery_data WHERE id = $1 AND is_deleted = false`,
        [leadId]
    );
    if (res.rows[0]) {
        const lead = res.rows[0];
        lead.lead_type = 'DELIVERY';
        if (user.role !== 'super_admin' && (!user.verticalAccess || !user.verticalAccess.includes(lead.vertical_id))) {
            return { forbidden: true };
        }
        return lead;
    }

    return null;
}

/**
 * GET /api/v1/interactionLogs/leads/:leadId/interaction-logs
 *
 * Returns all interaction log entries for one lead, newest first.
 * Includes resolved recorded_by name (or raw name if unresolved).
 */
export const getInteractionLogs = async (req, res) => {
    const { leadId } = req.params;
    if (!isValidUUID(leadId)) {
        return operationError(res, { code: ErrorCodes.INVALID_FORMAT, message: 'Invalid leadId', section: 'interaction_logs', operation: 'get_logs', field: 'leadId' });
    }
    try {
        const lead = await resolveLeadScoping(leadId, req.user);
        if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });
        if (lead.forbidden) return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });

        const result = await query(`
            SELECT
                l.id,
                l.lead_id,
                l.section,
                l.interaction_date,
                l.interaction_time,
                l.remarks,
                l.outcome,
                l.next_followup_date,
                l.recorded_by_raw_name,
                l.source,
                l.created_at,
                u.name AS recorded_by_name,
                u.email AS recorded_by_email
            FROM lead_interaction_logs l
            LEFT JOIN users u ON l.recorded_by = u.id
            WHERE l.lead_id = $1
            ORDER BY l.interaction_date DESC, l.created_at DESC
        `, [leadId]);

        return res.status(200).json({ success: true, data: result.rows });
    } catch (error) {
        return sendControllerError(res, error, 'getInteractionLogs', { section: 'interaction_logs', operation: 'get_logs', recordId: leadId });
    }
};

/**
 * GET /api/v1/interactionLogs/leads/:leadId/interaction-logs/summary
 *
 * Returns a lightweight summary for badge/count display on list and detail pages.
 * { count, lastInteractionDate, lastOutcome }
 */
export const getInteractionLogSummary = async (req, res) => {
    const { leadId } = req.params;
    if (!isValidUUID(leadId)) {
        return operationError(res, { code: ErrorCodes.INVALID_FORMAT, message: 'Invalid leadId', section: 'interaction_logs', operation: 'get_summary', field: 'leadId' });
    }
    try {
        const lead = await resolveLeadScoping(leadId, req.user);
        if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });
        if (lead.forbidden) return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });

        const [countRes, lastRes] = await Promise.all([
            query(`SELECT COUNT(*)::int AS count FROM lead_interaction_logs WHERE lead_id = $1`, [leadId]),
            query(`
                SELECT interaction_date, outcome
                FROM lead_interaction_logs
                WHERE lead_id = $1
                ORDER BY interaction_date DESC, created_at DESC
                LIMIT 1
            `, [leadId]),
        ]);

        return res.status(200).json({
            success: true,
            data: {
                count: countRes.rows[0].count,
                lastInteractionDate: lastRes.rows[0]?.interaction_date || null,
                lastOutcome: lastRes.rows[0]?.outcome || null,
            },
        });
    } catch (error) {
        return sendControllerError(res, error, 'getInteractionLogSummary', { section: 'interaction_logs', operation: 'get_summary', recordId: leadId });
    }
};

/**
 * POST /api/v1/interactionLogs/leads/:leadId/interaction-logs
 *
 * Creates a single interaction log entry from the detail page UI.
 * interaction_date is required; all other fields optional.
 */
export const createInteractionLog = async (req, res) => {
    const { leadId } = req.params;
    if (!isValidUUID(leadId)) {
        return operationError(res, { code: ErrorCodes.INVALID_FORMAT, message: 'Invalid leadId', section: 'interaction_logs', operation: 'create', field: 'leadId' });
    }

    const { interactionDate, interactionTime, remarks, outcome, nextFollowupDate, recordedByName } = req.body;

    if (!interactionDate) {
        return operationError(res, { code: ErrorCodes.MISSING_REQUIRED_FIELD, message: 'interactionDate is required', section: 'interaction_logs', operation: 'create', field: 'interactionDate' });
    }

    // Validate outcome if provided
    const VALID_OUTCOMES = new Set(['Interested', 'Not Reachable', 'Callback Requested', 'Not Interested', 'Converted']);
    if (outcome && !VALID_OUTCOMES.has(outcome)) {
        return operationError(res, { code: ErrorCodes.INVALID_FORMAT, message: `Invalid outcome. Must be one of: ${[...VALID_OUTCOMES].join(', ')}`, section: 'interaction_logs', operation: 'create', field: 'outcome' });
    }

    try {
        const lead = await resolveLeadScoping(leadId, req.user);
        if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });
        if (lead.forbidden) return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });

        // Determine section from lead_type
        let section = 'cos';
        if (lead.lead_type === 'POSITIVE') {
            section = 'positives';
        } else if (lead.lead_type === 'RAW') {
            section = 'raw_data';
        } else if (lead.lead_type === 'DELIVERY') {
            section = 'delivery_data';
        }

        // Resolve recordedBy: use current user (always), preserve raw name if provided
        const recordedBy = req.user.sub;
        const recordedByRaw = recordedByName || null;

        const id = crypto.randomUUID();
        const insertRes = await query(`
            INSERT INTO lead_interaction_logs
                (id, lead_id, section, interaction_date, interaction_time, remarks, outcome,
                 next_followup_date, recorded_by, recorded_by_raw_name, source)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'single_add')
            RETURNING *
        `, [
            id, leadId, section,
            interactionDate,
            interactionTime || null,
            remarks || null,
            outcome || null,
            nextFollowupDate || null,
            recordedBy,
            recordedByRaw,
        ]);

        const newLog = insertRes.rows[0];

        await logAudit(req, {
            action: 'INTERACTION_LOG_CREATED',
            targetCollection: 'lead_interaction_logs',
            targetId: leadId,
            entityLabel: lead.business_name || lead.name,
            after: newLog,
        });

        // Real-time sync — same signal as any other lead mutation
        invalidateOnLeadChange(lead.vertical_id, null).catch(() => {});
        broadcastToAll({ type: 'COST_CONVERSION_MUTATED', verticalId: lead.vertical_id, action: 'interaction_log_create', costConversionId: leadId });

        return res.status(201).json({ success: true, data: newLog });
    } catch (error) {
        return sendControllerError(res, error, 'createInteractionLog', { section: 'interaction_logs', operation: 'create', recordId: leadId });
    }
};

/**
 * DELETE /api/v1/interactionLogs/interaction-logs/:id
 *
 * Removes a single interaction log entry. Permitted for admins and the original recorder.
 */
export const deleteInteractionLog = async (req, res) => {
    const { id } = req.params;
    if (!isValidUUID(id)) {
        return operationError(res, { code: ErrorCodes.INVALID_FORMAT, message: 'Invalid interaction log id', section: 'interaction_logs', operation: 'delete', field: 'id' });
    }
    try {
        const logRes = await query('SELECT * FROM lead_interaction_logs WHERE id = $1', [id]);
        const log = logRes.rows[0];
        if (!log) return res.status(404).json({ success: false, error: 'Interaction log not found' });

        const lead = await resolveLeadScoping(log.lead_id, req.user);
        if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });
        if (lead.forbidden) return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });

        // Only super_admin, vertical_admin, or the original recorder may delete
        const isAdmin = req.user.role === 'super_admin' || req.user.role === 'vertical_admin';
        const isOwn = log.recorded_by === req.user.sub;
        if (!isAdmin && !isOwn) {
            return res.status(403).json({ success: false, error: 'You can only delete interaction logs you created' });
        }

        await query('DELETE FROM lead_interaction_logs WHERE id = $1', [id]);

        await logAudit(req, {
            action: 'INTERACTION_LOG_DELETED',
            targetCollection: 'lead_interaction_logs',
            targetId: log.lead_id,
            entityLabel: lead.business_name || lead.name,
            before: log,
        });

        invalidateOnLeadChange(lead.vertical_id, null).catch(() => {});
        broadcastToAll({ type: 'COST_CONVERSION_MUTATED', verticalId: lead.vertical_id, action: 'interaction_log_delete', costConversionId: log.lead_id });

        return res.status(200).json({ success: true });
    } catch (error) {
        return sendControllerError(res, error, 'deleteInteractionLog', { section: 'interaction_logs', operation: 'delete', recordId: id });
    }
};

/**
 * POST /api/v1/interactionLogs/leads/batch-counts
 *
 * Body: { leadIds: string[] }
 * Returns { [leadId]: count } for the given set of lead IDs.
 * Used by list pages to render follow-up count badges without
 * modifying the main list query (which has a complex cursor and
 * covering index that we must not disturb).
 */
export const getInteractionLogBatchCounts = async (req, res) => {
    const { leadIds } = req.body;
    if (!Array.isArray(leadIds) || leadIds.length === 0) {
        return res.status(200).json({ success: true, data: {} });
    }
    // Filter to valid UUIDs only — never let user input reach $ANY() directly
    const validIds = leadIds.filter(isValidUUID);
    if (validIds.length === 0) {
        return res.status(200).json({ success: true, data: {} });
    }
    try {
        const result = await query(`
            SELECT lead_id, COUNT(*)::int AS count
            FROM lead_interaction_logs
            WHERE lead_id = ANY($1::uuid[])
            GROUP BY lead_id
        `, [validIds]);

        const countsMap = {};
        for (const row of result.rows) {
            countsMap[row.lead_id] = row.count;
        }
        return res.status(200).json({ success: true, data: countsMap });
    } catch (error) {
        return sendControllerError(res, error, 'getInteractionLogBatchCounts', { section: 'interaction_logs', operation: 'batch_counts' });
    }
};

/**
 * GET /api/v1/interactionLogs/export/csv
 *
 * Exports all interaction logs for a vertical, respecting active filters.
 * One-to-many doesn't flatten onto the main lead export, so this is a
 * dedicated separate export — consistent with the Follow-ups export that
 * already exists at /api/v1/followUps/verticals/:verticalId/export/csv.
 *
 * Query params: verticalId (required), subVerticalId, section, outcome,
 *               dateFrom, dateTo, leadType
 */
export const exportInteractionLogsCsv = async (req, res) => {
    const { verticalId, subVerticalId, section, outcome, dateFrom, dateTo, leadType } = req.query;

    if (!verticalId || !isValidUUID(verticalId)) {
        return operationError(res, { code: ErrorCodes.INVALID_FORMAT, message: 'A valid verticalId is required', section: 'interaction_logs', operation: 'export' });
    }
    if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(verticalId))) {
        return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });
    }

    try {
        let sql = `
            SELECT
                l.id,
                l.interaction_date,
                l.interaction_time,
                l.remarks,
                l.outcome,
                l.next_followup_date,
                l.recorded_by_raw_name,
                l.source,
                l.created_at,
                COALESCE(u.name, l.recorded_by_raw_name, '-') AS recorded_by_display,
                c.business_name AS lead_business_name,
                c.name AS lead_name,
                c.phone AS lead_phone,
                c.lead_type,
                sv.name AS sub_vertical_name
            FROM lead_interaction_logs l
            JOIN cost_conversions c ON l.lead_id = c.id AND c.is_deleted = false
            LEFT JOIN users u ON l.recorded_by = u.id
            LEFT JOIN sub_verticals sv ON c.sub_vertical_id = sv.id
            WHERE c.vertical_id = $1
        `;
        const params = [verticalId];
        let pIdx = 2;

        if (subVerticalId && isValidUUID(subVerticalId)) {
            sql += ` AND c.sub_vertical_id = $${pIdx++}`;
            params.push(subVerticalId);
        }
        if (section) {
            sql += ` AND l.section = $${pIdx++}`;
            params.push(section);
        }
        if (outcome) {
            sql += ` AND l.outcome = $${pIdx++}`;
            params.push(outcome);
        }
        if (dateFrom) {
            sql += ` AND l.interaction_date >= $${pIdx++}`;
            params.push(dateFrom);
        }
        if (dateTo) {
            sql += ` AND l.interaction_date <= $${pIdx++}`;
            params.push(dateTo);
        }
        if (leadType) {
            sql += ` AND c.lead_type = $${pIdx++}`;
            params.push(leadType);
        }

        sql += ` ORDER BY l.interaction_date DESC, l.created_at DESC`;

        const result = await query(sql, params);

        const csvLine = (vals) => vals.map(v => `"${escapeCsvVal(v)}"`).join(',');
        const headers = [
            'INTERACTION DATE', 'TIME', 'LEAD NAME', 'BUSINESS NAME', 'PHONE',
            'SUB-VERTICAL', 'REMARKS', 'OUTCOME', 'NEXT FOLLOW-UP DATE',
            'LOGGED BY', 'SOURCE', 'CREATED AT',
        ];
        const lines = [csvLine(headers)];

        for (const row of result.rows) {
            lines.push(csvLine([
                formatDateDMY(row.interaction_date),
                row.interaction_time || '-',
                row.lead_name || '-',
                row.lead_business_name || '-',
                row.lead_phone || '-',
                row.sub_vertical_name || '-',
                row.remarks || '-',
                row.outcome || '-',
                formatDateDMY(row.next_followup_date),
                row.recorded_by_display || '-',
                row.source || '-',
                row.created_at ? new Date(row.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '-',
            ]));
        }

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=interaction-logs-${Date.now()}.csv`);
        return res.status(200).send(lines.join('\n') + '\n');
    } catch (error) {
        return sendControllerError(res, error, 'exportInteractionLogsCsv', { section: 'interaction_logs', operation: 'export' });
    }
};

/**
 * GET /api/v1/interactionLogs/csv/template/:verticalId
 *
 * Downloads the dedicated follow-ups-only import template.
 */
export const downloadInteractionLogsTemplate = async (req, res) => {
    const { verticalId } = req.params;
    try {
        if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(verticalId))) {
            return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });
        }

        const verticalRes = await query('SELECT id, slug FROM verticals WHERE id = $1', [verticalId]);
        const vertical = verticalRes.rows[0];
        if (!vertical) {
            return res.status(404).json({ success: false, error: 'Vertical not found' });
        }

        const leadType = req.query.leadType === 'POSITIVE' ? 'POSITIVE' : 'CALL';

        if (req.query.format === 'xlsx') {
            const workbook = await buildXlsxTemplate(FOLLOWUP_ONLY_FIELDS, [], {
                phone: '9876543210',
                followupDate: '24-07-2026',
                followupTime: '10:00 AM',
                followupRemarks: 'Spoke with customer, requested callback tomorrow',
                followupOutcome: 'Callback Requested',
                nextFollowupDate: '25-07-2026',
            });
            const buffer = await workbook.xlsx.writeBuffer();

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename=template-followups-${vertical.slug}-${leadType.toLowerCase()}.xlsx`);
            res.setHeader('Cache-Control', 'private, max-age=300');
            return res.status(200).send(Buffer.from(buffer));
        }

        const headers = FOLLOWUP_ONLY_FIELDS.map(f => f.csvHeader);
        const sampleRow = ['9876543210', '24-07-2026', '10:00 AM', 'Spoke with customer, requested callback tomorrow', 'Callback Requested', '25-07-2026'];
        const csvLine = (vals) => vals.map(v => `"${v.replace(/"/g, '""')}"`).join(',');
        const csvContent = csvLine(headers) + '\n' + csvLine(sampleRow) + '\n';

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=template-followups-${vertical.slug}.csv`);
        res.setHeader('Cache-Control', 'private, max-age=300');
        return res.status(200).send(csvContent);
    } catch (error) {
        return sendControllerError(res, error, 'downloadInteractionLogsTemplate');
    }
};

/**
 * POST /api/v1/interactionLogs/csv/upload
 *
 * Handles dedicated follow-ups-only upload.
 */
export const uploadInteractionLogsCsv = async (req, res) => {
    const { verticalId, subVerticalId, leadType = 'CALL' } = req.body;
    const file = req.file;
    const section = leadType === 'POSITIVE' ? 'positives' : 'cos';

    try {
        if (!file) {
            return operationError(res, { code: ErrorCodes.MISSING_REQUIRED_FIELD, message: 'A CSV or Excel file is required', section, operation: 'bulk_upload', field: 'file' });
        }
        if (!verticalId || !isValidUUID(verticalId)) {
            return operationError(res, { code: ErrorCodes.INVALID_FORMAT, message: 'A valid verticalId is required', section, operation: 'bulk_upload', field: 'verticalId' });
        }
        if (!subVerticalId || !isValidUUID(subVerticalId)) {
            return operationError(res, { code: ErrorCodes.MISSING_REQUIRED_FIELD, message: 'Sub-vertical selection is mandatory for uploading follow-ups.', section, operation: 'bulk_upload', field: 'subVerticalId' });
        }

        if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(verticalId))) {
            return operationError(res, { status: 403, code: ErrorCodes.FORBIDDEN, message: 'Access forbidden: you do not have access to this business vertical', section, operation: 'bulk_upload' });
        }

        const logId = crypto.randomUUID();
        const fileExt = path.extname(file.originalname).toLowerCase() || '.csv';
        const fileName = `${logId}${fileExt}`;

        if (process.env.VERCEL) {
            // Vercel serverless inline processing
            const logRes = await query(`
                INSERT INTO csv_upload_logs (id, uploaded_by, vertical_id, file_name, original_file_name, status, sub_vertical_id, lead_type, entity_type)
                VALUES ($1, $2, $3, $4, $5, 'processing', $6, $7, 'interaction_log')
                RETURNING *
            `, [logId, req.user.sub, verticalId, fileName, file.originalname, subVerticalId, leadType]);

            const uploadLog = logRes.rows[0];

            await logAudit(req, {
                action: 'csv.upload_processing_vercel',
                targetCollection: 'csv_upload_logs',
                targetId: uploadLog.id,
                after: { originalFileName: file.originalname, status: 'processing', file_name: fileName, entity_type: 'interaction_log' }
            }).catch(() => {});

            const mockJob = {
                data: {
                    batchId: uploadLog.id,
                    fileBufferBase64: file.buffer.toString('base64'),
                    verticalId,
                    subVerticalId,
                    uploadedBy: req.user.sub,
                    leadType,
                    fileExt
                },
                progress: async (value) => {
                    console.log(`[Vercel Inline Worker] Log Job ${uploadLog.id} progress: ${value}%`);
                }
            };

            runInBackground(
                import('../jobs/interactionLogProcessor.js').then(({ processInteractionLogJob }) => processInteractionLogJob(mockJob)),
                { batchId: uploadLog.id, label: 'InteractionCSV' }
            );

            return res.status(202).json({
                success: true,
                data: {
                    batchId: uploadLog.id,
                    status: 'processing',
                    message: 'Follow-ups file uploaded and processed inline on Vercel.'
                }
            });
        }

        const uploadPath = path.join(__dirname, '../../uploads', fileName);
        const uploadDir = path.dirname(uploadPath);
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }

        fs.writeFileSync(uploadPath, file.buffer);

        const logRes = await query(`
            INSERT INTO csv_upload_logs (id, uploaded_by, vertical_id, file_name, original_file_name, status, sub_vertical_id, lead_type, entity_type)
            VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7, 'interaction_log')
            RETURNING *
        `, [logId, req.user.sub, verticalId, fileName, file.originalname, subVerticalId, leadType]);

        const uploadLog = logRes.rows[0];

        await logAudit(req, {
            action: 'csv.upload_queued',
            targetCollection: 'csv_upload_logs',
            targetId: uploadLog.id,
            after: { originalFileName: file.originalname, status: 'queued', file_name: fileName, entity_type: 'interaction_log' }
        });

        return res.status(202).json({
            success: true,
            data: {
                batchId: uploadLog.id,
                status: 'queued',
                message: 'Follow-ups file uploaded and queued for processing.'
            }
        });

    } catch (error) {
        return sendControllerError(res, error, 'uploadInteractionLogsCsv', { section, operation: 'bulk_upload' });
    }
};

