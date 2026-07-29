import { query } from '../config/db.js';
import { runInBackground, reapIfStale } from '../utils/background.js';
import crypto from 'crypto';
import { logAudit } from '../services/audit.js';
import { cacheGet } from '../services/cache.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendControllerError } from '../utils/dbErrors.js';
import { operationError, ErrorCodes } from '../utils/operationError.js';
import { isValidUUID } from '../utils/validators/index.js';
import { getLeadImportSchema, getAssignableAgentNames } from '../services/leadImportSchema.js';
import { buildXlsxTemplate } from '../services/leadImportTemplate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── CSV formula-injection guard (H5) ────────────────────────────────────────
// Prefix any value whose first character Excel/Sheets treats as a formula
// trigger (=, +, -, @, tab, CR) with a literal single-quote BEFORE the
// normal quote-doubling/wrapping runs, so e.g. `=cmd|'/c calc'!A1` downloads
// as the literal text `'=cmd|'/c calc'!A1` instead of executing as a formula
// when an admin opens the exported/error-report file.
const sanitizeCsvValue = (val) => {
    const s = String(val ?? '');
    return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
};

const SAMPLE_VALUES = {
    date: '2026-07-24', employeeName: 'Jane Doe', businessType: 'Retail',
    businessName: 'Acme Traders', phone: '9876543210', pointOfContact: 'Rahul Sharma',
    area: 'Whitefield', city: 'Bengaluru', deliveredLocation: '123 Main Street',
    remarks: 'Interested, follow up next week', recordings: '',
    appointmentType: 'Yes', appointmentDate: '2026-08-01', appointmentTime: '11:00 AM',
    requirement: '50 units', notes: 'Prefers WhatsApp contact',
    followUpRequired: 'Yes', followUps: '1', followUpDates: '2026-08-05',
    followUpRemarks: 'Awaiting budget approval',
};

/**
 * GET /leads/csv/template/:verticalId
 *
 * Generates the download template (CSV, or XLSX via ?format=xlsx) directly
 * from the shared lead-import schema (services/leadImportSchema.js) — the
 * same schema the upload validator enforces — so the template can never
 * drift out of sync with what the backend actually accepts.
 *
 * ETag is derived from the header list fingerprint so browsers receive a
 * 304 Not Modified when nothing has changed.
 */
export const downloadCsvTemplate = async (req, res) => {
    const { verticalId } = req.params;
    try {
        // Strict Vertical Scoping check
        if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(verticalId))) {
            return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });
        }

        const verticalRes = await query('SELECT id, slug FROM verticals WHERE id = $1', [verticalId]);
        const vertical = verticalRes.rows[0];
        if (!vertical) {
            return res.status(404).json({ success: false, error: 'Vertical not found' });
        }

        const leadType = req.query.leadType === 'POSITIVE' ? 'POSITIVE' : 'CALL';
        const schema = await getLeadImportSchema(verticalId, leadType);

        if (req.query.format === 'xlsx') {
            const agentNames = await getAssignableAgentNames(verticalId);
            const workbook = await buildXlsxTemplate(schema, agentNames, SAMPLE_VALUES);
            const buffer = await workbook.xlsx.writeBuffer();

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename=template-${vertical.slug}-${leadType.toLowerCase()}.xlsx`);
            res.setHeader('Cache-Control', 'private, max-age=300');
            return res.status(200).send(Buffer.from(buffer));
        }

        const headers = schema.map(f => f.csvHeader);
        const sampleRow = schema.map(f => SAMPLE_VALUES[f.key] ?? (f.type === 'enum' ? (f.options?.[0] || '') : ''));
        const csvLine = (vals) => vals.map(v => `"${sanitizeCsvValue(v).replace(/"/g, '""')}"`).join(',');
        const csvContent = csvLine(headers) + '\n' + csvLine(sampleRow) + '\n';

        // ETag based on the header list fingerprint — prevents re-download if configs haven't changed
        const etag = `"tpl-${Buffer.from(csvLine(headers)).toString('base64url').slice(0, 16)}"`;
        if (req.headers['if-none-match'] === etag) {
            return res.status(304).end();
        }

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=template-${vertical.slug}.csv`);
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'private, max-age=300'); // 5 min browser cache
        return res.status(200).send(csvContent);
    } catch (error) {
        return sendControllerError(res, error, 'downloadCsvTemplate');
    }
};

/**
 * GET /leads/csv/schema/:verticalId
 *
 * Exposes the shared import schema as JSON so the frontend can run the
 * exact same required/type/enum checks client-side (fast preview) that the
 * server enforces authoritatively on upload — no duplicated rule sets.
 */
export const getImportSchema = async (req, res) => {
    const { verticalId } = req.params;
    try {
        if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(verticalId))) {
            return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });
        }
        const leadType = req.query.leadType === 'POSITIVE' ? 'POSITIVE' : 'CALL';
        const schema = await getLeadImportSchema(verticalId, leadType);
        return res.status(200).json({ success: true, data: { leadType, fields: schema } });
    } catch (error) {
        return sendControllerError(res, error, 'getImportSchema');
    }
};

/**
 * POST /leads/csv/upload
 */
export const uploadCsv = async (req, res) => {
    const { verticalId, assignedTo, subVerticalId, leadType = 'CALL' } = req.body;
    const file = req.file;
    const section = leadType === 'POSITIVE' ? 'positives' : 'cos';

    try {
        if (!file) return operationError(res, { code: ErrorCodes.MISSING_REQUIRED_FIELD, message: 'A CSV or Excel file is required', section, operation: 'bulk_upload', field: 'file' });
        if (!verticalId || !isValidUUID(verticalId)) {
            return operationError(res, { code: ErrorCodes.INVALID_FORMAT, message: 'A valid verticalId is required', section, operation: 'bulk_upload', field: 'verticalId' });
        }
        if (!subVerticalId || !isValidUUID(subVerticalId)) {
            return operationError(res, { code: ErrorCodes.MISSING_REQUIRED_FIELD, message: 'Sub-vertical selection is mandatory for uploading leads.', section, operation: 'bulk_upload', field: 'subVerticalId' });
        }
        if (assignedTo && !isValidUUID(assignedTo)) {
            return operationError(res, { code: ErrorCodes.INVALID_FORMAT, message: 'Invalid assignedTo agent ID', section, operation: 'bulk_upload', field: 'assignedTo' });
        }

        // Strict Vertical Scoping check
        if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(verticalId))) {
            return operationError(res, { status: 403, code: ErrorCodes.FORBIDDEN, message: 'Access forbidden: you do not have access to this business vertical', section, operation: 'bulk_upload' });
        }

        const targetAssignedTo = (assignedTo && assignedTo.length > 0) ? assignedTo : null;

        const logId = crypto.randomUUID();
        const fileExt = path.extname(file.originalname).toLowerCase() || '.csv';
        const fileName = `${logId}${fileExt}`;

        if (process.env.VERCEL) {
            // Vercel Serverless environment: bypass disk writes and run processing inline
            const logRes = await query(`
                INSERT INTO csv_upload_logs (id, uploaded_by, vertical_id, file_name, original_file_name, status, sub_vertical_id, assigned_to, lead_type)
                VALUES ($1, $2, $3, $4, $5, 'processing', $6, $7, $8)
                RETURNING *
            `, [logId, req.user.sub, verticalId, fileName, file.originalname, subVerticalId, targetAssignedTo || null, leadType]);

            const uploadLog = logRes.rows[0];

            // Never let an audit-log failure abort before the background job is
            // registered — that would strand the row at 'processing' forever
            // with no batchId ever returned to the client to look it up.
            await logAudit(req, {
                action: 'csv.upload_processing_vercel',
                targetCollection: 'csv_upload_logs',
                targetId: uploadLog.id,
                after: { originalFileName: file.originalname, status: 'processing', file_name: fileName }
            }).catch(err => console.error('⚠️ logAudit failed (non-fatal, upload proceeds):', err.message));

            const mockJob = {
                data: {
                    batchId: uploadLog.id,
                    fileBufferBase64: file.buffer.toString('base64'),
                    verticalId,
                    subVerticalId,
                    uploadedBy: req.user.sub,
                    assignedTo: targetAssignedTo || null,
                    leadType,
                    fileExt
                },
                progress: async (value) => {
                    console.log(`[Vercel Inline Worker] Job ${uploadLog.id} progress: ${value}%`);
                }
            };

            // Kick off CSV processing in the background (non-blocking for Vercel).
            // runInBackground() uses waitUntil() to keep the function instance
            // alive until processing settles — without it, Vercel can freeze
            // the container right after the 202 response, silently stranding
            // the batch at status='processing' with 0 rows ever inserted
            // (reproduced empirically during production-readiness testing on
            // a 3,000-row upload). It never overwrites processCsvJob's own
            // detailed per-row errors if it already wrote status='failed'
            // before rethrowing.
            runInBackground(
                import('../jobs/csvProcessor.js').then(({ processCsvJob }) => processCsvJob(mockJob)),
                { batchId: uploadLog.id, label: 'CSV' }
            );

            return res.status(202).json({
                success: true,
                data: {
                    batchId: uploadLog.id,
                    status: 'processing',
                    message: 'File uploaded and processed inline on Vercel.'
                }
            });
        }

        const uploadPath = path.join(__dirname, '../../uploads', fileName);
        const uploadDir = path.dirname(uploadPath);
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }

        // Save uploaded file buffer to disk
        fs.writeFileSync(uploadPath, file.buffer);

        const logRes = await query(`
            INSERT INTO csv_upload_logs (id, uploaded_by, vertical_id, file_name, original_file_name, status, sub_vertical_id, assigned_to, lead_type)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *
        `, [logId, req.user.sub, verticalId, fileName, file.originalname, 'queued', subVerticalId, targetAssignedTo || null, leadType]);

        const uploadLog = logRes.rows[0];

        await logAudit(req, {
            action: 'csv.upload_queued',
            targetCollection: 'csv_upload_logs',
            targetId: uploadLog.id,
            after: { originalFileName: file.originalname, status: 'queued', file_name: fileName }
        });

        return res.status(202).json({
            success: true,
            data: {
                batchId: uploadLog.id,
                status: 'queued',
                message: 'File uploaded and queued for processing.'
            }
        });
    } catch (error) {
        return sendControllerError(res, error, 'uploadCsv', { section, operation: 'bulk_upload' });
    }
};

/**
 * GET /leads/csv/logs — also serves as the backing list endpoint for the
 * Operation Reports page (client/src/pages/OperationReportsPage.jsx), since
 * csv_upload_logs now persists reports for bulk_upload/promote/
 * duplicate_scan alike (operation_type column). `operationType`/`entityType`
 * are optional filters on top of the existing role-based vertical scoping —
 * additive, so every pre-existing caller (with neither param) is unaffected.
 * (No separate ownership/ uploaded_by check is needed here: this route is
 * gated by `checkPermission('csv:logs')` with no `csv:upload` fallback — see
 * routes/costConversions.js — so every caller who reaches this controller
 * already holds the full csv:logs permission, unlike getCsvLogById/
 * streamFailedRows below, which allow a plain uploader in via csv:upload
 * and must therefore restrict them to their own batches.)
 */
export const getCsvLogs = async (req, res) => {
    const { page = 1, limit = 15, operationType, entityType, verticalId } = req.query;
    try {
        let sql = 'SELECT l.*, v.name as vertical_name, u.name as user_name FROM csv_upload_logs l JOIN verticals v ON l.vertical_id = v.id JOIN users u ON l.uploaded_by = u.id';
        const wheres = [];
        const params = [];
        if (req.user.role === 'vertical_admin') {
            params.push(req.user.verticalAccess);
            wheres.push(`l.vertical_id = ANY($${params.length})`);
        }
        if (operationType) {
            params.push(operationType);
            wheres.push(`l.operation_type = $${params.length}`);
        }
        if (entityType) {
            params.push(entityType);
            wheres.push(`l.entity_type = $${params.length}`);
        }
        if (verticalId && isValidUUID(verticalId)) {
            params.push(verticalId);
            wheres.push(`l.vertical_id = $${params.length}`);
        }
        if (wheres.length > 0) sql += ' WHERE ' + wheres.join(' AND ');

        // M10: clamp to a sane upper bound and bind LIMIT/OFFSET as query
        // parameters instead of string-interpolating — matches rawData.js's
        // getRawData pattern. Prevents ?limit=99999999 (unbounded table
        // scan) and a non-numeric limit producing `LIMIT NaN` (a raw
        // Postgres syntax error surfaced as a bare 500).
        const limitNum = Math.min(parseInt(limit, 10) || 15, 100);
        const pageNum = Math.max(parseInt(page, 10) || 1, 1);
        const offset = (pageNum - 1) * limitNum;

        params.push(limitNum, offset);
        const limitIdx = params.length - 1;
        const offsetIdx = params.length;
        sql += ` ORDER BY l.created_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`;

        const logsRes = await query(sql, params);
        return res.status(200).json({ success: true, data: logsRes.rows });
    } catch (error) {
        return sendControllerError(res, error, 'getCsvLogs');
    }
};

/**
 * GET /leads/csv/logs/:batchId
 */
export const getCsvLogById = async (req, res) => {
    const { batchId } = req.params;
    try {
        // Check cache first (CSV progress updates come from the worker via cacheSet)
        const cached = await cacheGet(`csv_progress:${batchId}`);
        if (cached) {
            // Strict Vertical Scoping check
            if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(cached.vertical_id))) {
                return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });
            }
            // Strict Log Ownership check: if user lacks csv:logs permission, they must be the uploader
            const hasLogsPermission = req.user.role === 'super_admin' || (req.role && (req.role.permissions.includes('*') || req.role.permissions.includes('csv:logs')));
            if (!hasLogsPermission && cached.uploaded_by !== req.user.sub) {
                return res.status(403).json({ success: false, error: 'Access forbidden: you do not have permission to view other users\' upload logs' });
            }
            return res.status(200).json({ success: true, data: cached });
        }

        const logRes = await query('SELECT * FROM csv_upload_logs WHERE id = $1', [batchId]);
        let log = logRes.rows[0];
        if (!log) return res.status(404).json({ success: false, error: 'CSV log not found' });

        // M7: authorization MUST run before reapIfStale below — reapIfStale
        // issues a DB UPDATE, so running it before these checks would let an
        // unauthorized caller who merely guesses/obtains another tenant's
        // batchId flip that batch's status as a side effect of a request
        // that ultimately returns 403.
        // Strict Vertical Scoping check
        if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(log.vertical_id))) {
            return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });
        }
        // Strict Log Ownership check: if user lacks csv:logs permission, they must be the uploader
        const hasDbLogsPermission = req.user.role === 'super_admin' || (req.role && (req.role.permissions.includes('*') || req.role.permissions.includes('csv:logs')));
        if (!hasDbLogsPermission && log.uploaded_by !== req.user.sub) {
            return res.status(403).json({ success: false, error: 'Access forbidden: you do not have permission to view other users\' upload logs' });
        }

        // Self-healing: there's no persistent worker on Vercel to retry a batch
        // that's still 'processing' well past any realistic completion time
        // (e.g. waitUntil itself hit maxDuration) — the next status poll is the
        // only recovery point, so check and reap it here. Now runs only after
        // authorization has passed (see M7 note above).
        log = await reapIfStale(log);

        return res.status(200).json({ success: true, data: log });
    } catch (error) {
        return sendControllerError(res, error, 'getCsvLogById');
    }
};

/**
 * GET /leads/csv/logs/:batchId/failed-rows
 */
export const streamFailedRows = async (req, res) => {
    const { batchId } = req.params;
    try {
        const logRes = await query('SELECT * FROM csv_upload_logs WHERE id = $1', [batchId]);
        const log = logRes.rows[0];
        if (!log) return res.status(404).json({ success: false, error: 'CSV log not found' });

        // Strict Vertical Scoping check
        if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(log.vertical_id))) {
            return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });
        }
        // Strict Log Ownership check: if user lacks csv:logs permission, they must be the uploader
        const hasStreamLogsPermission = req.user.role === 'super_admin' || (req.role && (req.role.permissions.includes('*') || req.role.permissions.includes('csv:logs')));
        if (!hasStreamLogsPermission && log.uploaded_by !== req.user.sub) {
            return res.status(403).json({ success: false, error: 'Access forbidden: you do not have permission to view other users\' upload logs' });
        }

        const errors = log.errors || [];

        if (errors.length === 0) return res.status(400).json({ success: false, error: 'No errors found' });

        // Helper to extract Business Name from originalRow
        const extractBusinessName = (originalRow) => {
            if (!originalRow || typeof originalRow !== 'object') return '';
            const keys = Object.keys(originalRow);
            const normalizedKeys = keys.map(k => k.toLowerCase().trim().replace(/\r?\n/g, ' ').replace(/\s+/g, ' '));
            
            const matchKeys = [
                'business name',
                'business/person/shop/company name',
                'business person, shop, and company name',
                'business',
                'name'
            ];
            for (const mk of matchKeys) {
                const idx = normalizedKeys.indexOf(mk);
                if (idx !== -1) return originalRow[keys[idx]];
            }
            // Fallback: look for keys containing 'business' or 'name'
            for (let i = 0; i < keys.length; i++) {
                const k = normalizedKeys[i];
                if (k.includes('business') || k.includes('name')) {
                    return originalRow[keys[i]];
                }
            }
            return '';
        };

        // Helper to extract Phone Number from originalRow
        const extractPhoneNumber = (originalRow) => {
            if (!originalRow || typeof originalRow !== 'object') return '';
            const keys = Object.keys(originalRow);
            const normalizedKeys = keys.map(k => k.toLowerCase().trim().replace(/\r?\n/g, ' ').replace(/\s+/g, ' '));
            
            const matchKeys = [
                'contact number',
                'phone number',
                'contact',
                'contact no',
                'number',
                'phone',
                'mobile'
            ];
            for (const mk of matchKeys) {
                const idx = normalizedKeys.indexOf(mk);
                if (idx !== -1) return originalRow[keys[idx]];
            }
            // Fallback: look for keys containing 'phone', 'contact', 'mobile', or 'number'
            for (let i = 0; i < keys.length; i++) {
                const k = normalizedKeys[i];
                if (k.includes('phone') || k.includes('contact') || k.includes('mobile') || k.includes('number')) {
                    return originalRow[keys[i]];
                }
            }
            return '';
        };

        const csvHeader = 'Business Name,Phone Number,Reason for Failure\n';
        const csvRows = errors.map(e => {
            const bizName = extractBusinessName(e.originalRow);
            const phone = extractPhoneNumber(e.originalRow);
            const reason = e.reason || '';
            return `"${sanitizeCsvValue(bizName).replace(/"/g, '""')}","${sanitizeCsvValue(phone).replace(/"/g, '""')}","${sanitizeCsvValue(reason).replace(/"/g, '""')}"`;
        }).join('\n');

        const csvContent = csvHeader + csvRows + '\n';

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=failed-records-${batchId}.csv`);
        return res.status(200).send(csvContent);
    } catch (error) {
        return sendControllerError(res, error, 'streamFailedRows');
    }
};
