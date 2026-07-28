import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runInBackground } from '../utils/background.js';
import { query } from '../config/db.js';
import { isValidUUID } from '../utils/validators/index.js';
import { sendControllerError } from '../utils/dbErrors.js';
import { operationError, ErrorCodes } from '../utils/operationError.js';
import { logAudit } from '../services/audit.js';
import { broadcastToAll } from '../services/assignmentBroadcaster.js';
import {
    RAW_DATA_FIELDS,
    validateRawDataRow,
    getAssignableAgents,
    getKnownBusinessTypes,
    buildRawDataFilters,
    resolveRawDataSortColumn,
} from '../services/rawDataImportSchema.js';
import { buildXlsxTemplate } from '../services/leadImportTemplate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── CSV formula-injection guard (H5) ────────────────────────────────────────
// Prefix any value whose first character Excel/Sheets treats as a formula
// trigger (=, +, -, @, tab, CR) with a literal single-quote BEFORE the
// normal quote-doubling/wrapping runs, so a value like `=cmd|'/c calc'!A1`
// downloads as literal text instead of executing as a formula when an admin
// opens the exported file.
const sanitizeCsvValue = (val) => {
    const s = String(val ?? '');
    return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
};

/**
 * GET /raw-data
 * Same empty/omitted-query-param safety as getCostConversions — none of
 * these ever reach a WHERE clause unless present and well-formed.
 */
export const getRawData = async (req, res) => {
    const { verticalId, page = 1, limit = 25, sortBy, sortDir } = req.query;
    try {
        if (!verticalId || !isValidUUID(verticalId)) {
            return res.status(200).json({ success: true, data: [], meta: { total: 0, totalPages: 0 } });
        }
        if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(verticalId))) {
            return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });
        }

        const params = [verticalId];
        const wheres = ['r.vertical_id = $1', 'r.is_deleted = false'];
        const filters = buildRawDataFilters(req.query, 2);
        wheres.push(...filters.clauses);
        params.push(...filters.params);
        const pIdx = filters.nextIdx;

        const limitNum = Math.min(parseInt(limit, 10) || 25, 100);
        const pageNum = Math.max(parseInt(page, 10) || 1, 1);
        const offset = (pageNum - 1) * limitNum;
        const sortCol = resolveRawDataSortColumn(sortBy);
        const sortDirection = sortDir === 'asc' ? 'ASC' : 'DESC';

        const sql = `
            SELECT r.*, u.name AS assignee_name
            FROM raw_data r
            LEFT JOIN users u ON u.id = r.assigned_user_id
            WHERE ${wheres.join(' AND ')}
            ORDER BY ${sortCol} ${sortDirection}
            LIMIT $${pIdx} OFFSET $${pIdx + 1}
        `;
        params.push(limitNum, offset);

        const countSql = `SELECT COUNT(*) FROM raw_data r WHERE ${wheres.join(' AND ')}`;

        const [rowsRes, countRes] = await Promise.all([
            query(sql, params),
            query(countSql, params.slice(0, pIdx - 1)),
        ]);

        const total = parseInt(countRes.rows[0].count, 10);
        return res.status(200).json({
            success: true,
            data: rowsRes.rows,
            meta: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) || 1 },
        });
    } catch (error) {
        return sendControllerError(res, error, 'getRawData');
    }
};

/**
 * GET /raw-data/export/csv — exports the same rows the list endpoint would
 * return for the given filters (minus pagination), using the exact same
 * `buildRawDataFilters` builder so export and list can never disagree about
 * what a filter matches. Simple string-build, not a DB-cursor stream —
 * proportionate to this entity's expected row counts (see leadImportTemplate
 * / costConversions.js's streaming export, which is sized for a much larger
 * dataset than Raw Data currently has).
 */
const RAW_DATA_EXPORT_MAPPERS = {
    date: r => r.date_str,
    employeeName: r => r.assignee_name,
    businessType: r => r.business_type,
    businessName: r => r.business_name,
    area: r => r.area,
    city: r => r.city,
    phoneNumber: r => r.phone_number,
    address: r => r.address,
    appointmentDate: r => r.appointment_date_str,
    appointmentTimings: r => r.appointment_timings,
    remarks: r => r.remarks,
};

export const exportRawDataCsv = async (req, res) => {
    const { verticalId, sortBy, sortDir } = req.query;
    try {
        if (!verticalId || !isValidUUID(verticalId)) {
            return res.status(400).json({ success: false, error: 'A valid verticalId is required' });
        }
        if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(verticalId))) {
            return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });
        }

        const params = [verticalId];
        const wheres = ['r.vertical_id = $1', 'r.is_deleted = false'];
        const filters = buildRawDataFilters(req.query, 2);
        wheres.push(...filters.clauses);
        params.push(...filters.params);

        const sortCol = resolveRawDataSortColumn(sortBy);
        const sortDirection = sortDir === 'asc' ? 'ASC' : 'DESC';

        // to_char formats dates server-side in SQL — avoids re-interpreting a
        // pg DATE-typed Date object through a JS timezone (see CLAUDE.md's
        // documented exceljs date gotcha; same class of bug, avoided the
        // same way here).
        const rowsRes = await query(`
            SELECT r.*, u.name AS assignee_name,
                to_char(r.date, 'YYYY-MM-DD') AS date_str,
                to_char(r.appointment_date, 'YYYY-MM-DD') AS appointment_date_str
            FROM raw_data r
            LEFT JOIN users u ON u.id = r.assigned_user_id
            WHERE ${wheres.join(' AND ')}
            ORDER BY ${sortCol} ${sortDirection}
        `, params);

        const csvLine = (vals) => vals.map(v => `"${sanitizeCsvValue(v).replace(/"/g, '""')}"`).join(',');
        const headers = RAW_DATA_FIELDS.map(f => f.label);
        const lines = [csvLine(headers)];
        for (const row of rowsRes.rows) {
            lines.push(csvLine(RAW_DATA_FIELDS.map(f => RAW_DATA_EXPORT_MAPPERS[f.key](row))));
        }

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=raw-data-export-${Date.now()}.csv`);
        return res.status(200).send(lines.join('\n') + '\n');
    } catch (error) {
        return sendControllerError(res, error, 'exportRawDataCsv');
    }
};

/**
 * POST /raw-data
 * Single-Add — runs through the exact same validateRawDataRow() the bulk
 * upload path uses, so the two can never disagree about what's valid.
 */
export const createRawData = async (req, res) => {
    const { verticalId } = req.body;
    try {
        if (!verticalId || !isValidUUID(verticalId)) {
            return operationError(res, { code: ErrorCodes.INVALID_FORMAT, message: 'A valid verticalId is required', section: 'raw_data', operation: 'single_add', field: 'verticalId' });
        }
        if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(verticalId))) {
            return operationError(res, { status: 403, code: ErrorCodes.FORBIDDEN, message: 'Access forbidden: you do not have access to this business vertical', section: 'raw_data', operation: 'single_add' });
        }

        const [agents, knownBusinessTypes] = await Promise.all([
            getAssignableAgents(verticalId),
            getKnownBusinessTypes(verticalId),
        ]);

        const row = {
            date: req.body.date,
            employeeName: req.body.employeeName,
            businessType: req.body.businessType,
            businessName: req.body.businessName,
            area: req.body.area,
            city: req.body.city,
            phoneNumber: req.body.phoneNumber,
            address: req.body.address,
            appointmentDate: req.body.appointmentDate,
            appointmentTimings: req.body.appointmentTimings,
            remarks: req.body.remarks,
        };

        const { errors, warnings, assignedUserId } = validateRawDataRow(row, { agents, knownBusinessTypes });
        if (errors.length > 0) {
            return operationError(res, {
                status: 422, code: ErrorCodes.VALIDATION_FAILED,
                message: errors.map(e => e.message).join('; '),
                section: 'raw_data', operation: 'single_add',
                field: errors.length === 1 ? errors[0].field : undefined,
                fields: errors,
            });
        }

        const phone = (row.phoneNumber || '').replace(/[^\d+]/g, '');
        const dupRes = await query(
            'SELECT id FROM raw_data WHERE vertical_id = $1 AND phone_number = $2 AND is_deleted = false LIMIT 1',
            [verticalId, phone]
        );
        if (dupRes.rows.length > 0) {
            return operationError(res, {
                status: 409, code: ErrorCodes.DUPLICATE_PHONE,
                message: `Phone number ${phone} already exists in Raw Data for this vertical`,
                section: 'raw_data', operation: 'single_add', field: 'phoneNumber', recordId: dupRes.rows[0].id,
            });
        }

        const id = crypto.randomUUID();
        const insertRes = await query(`
            INSERT INTO raw_data (
                id, vertical_id, assigned_user_id, date, business_type, business_name,
                area, city, phone_number, address, appointment_date, appointment_timings,
                remarks, source, created_by
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'single_add',$14)
            RETURNING *
        `, [
            id, verticalId, assignedUserId,
            row.date || null, row.businessType || null, row.businessName,
            row.area || null, row.city || null, phone, row.address || null,
            row.appointmentDate || null, row.appointmentTimings || null,
            row.remarks || null, req.user.sub,
        ]);

        logAudit(req, { action: 'raw_data.create', targetCollection: 'raw_data', targetId: id, after: insertRes.rows[0] });
        broadcastToAll({ type: 'RAW_DATA_MUTATED', verticalId, action: 'create' });

        return res.status(201).json({ success: true, data: insertRes.rows[0], warnings });
    } catch (error) {
        return sendControllerError(res, error, 'createRawData', { section: 'raw_data', operation: 'single_add' });
    }
};

/**
 * GET /raw-data/import-template — dynamic CSV/XLSX template, same schema
 * the bulk validator enforces. Vertical is only used to resolve the live
 * Employee Name dropdown list — it is never a column in the template.
 */
export const downloadRawDataTemplate = async (req, res) => {
    const { verticalId } = req.query;
    try {
        if (!verticalId || !isValidUUID(verticalId)) {
            return res.status(400).json({ success: false, error: 'A valid verticalId is required' });
        }
        if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(verticalId))) {
            return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });
        }

        const sampleValues = {
            date: '2026-07-24', employeeName: 'Jane Doe', businessType: 'Retail',
            businessName: 'Acme Traders', area: 'Whitefield', city: 'Bengaluru',
            phoneNumber: '9876543210', address: '123 Main Street',
            appointmentDate: '2026-08-01', appointmentTimings: '11:00 AM', remarks: 'Interested',
        };

        if (req.query.format === 'xlsx') {
            const agents = await getAssignableAgents(verticalId);
            const workbook = await buildXlsxTemplate(RAW_DATA_FIELDS, agents.map(a => a.name), sampleValues);
            const buffer = await workbook.xlsx.writeBuffer();
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', 'attachment; filename=raw-data-template.xlsx');
            return res.status(200).send(Buffer.from(buffer));
        }

        const headers = RAW_DATA_FIELDS.map(f => f.csvHeader);
        const sampleRow = RAW_DATA_FIELDS.map(f => sampleValues[f.key] ?? '');
        const csvLine = (vals) => vals.map(v => `"${sanitizeCsvValue(v).replace(/"/g, '""')}"`).join(',');
        const csvContent = csvLine(headers) + '\n' + csvLine(sampleRow) + '\n';

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=raw-data-template.csv');
        return res.status(200).send(csvContent);
    } catch (error) {
        return sendControllerError(res, error, 'downloadRawDataTemplate');
    }
};

/**
 * GET /raw-data/schema — same schema JSON both the template and the
 * validator use, exposed so the frontend can pre-validate identically.
 */
export const getRawDataSchema = async (req, res) => {
    try {
        return res.status(200).json({ success: true, data: { fields: RAW_DATA_FIELDS } });
    } catch (error) {
        return sendControllerError(res, error, 'getRawDataSchema');
    }
};

/**
 * POST /raw-data/upload
 * Queues the file the same way uploadCsv (csv.js) does for Leads — same
 * csv_upload_logs table, discriminated by entity_type='raw_data' so the
 * shared worker loop and log/status/error-report endpoints all just work.
 */
export const uploadRawDataCsv = async (req, res) => {
    const { verticalId } = req.body;
    const file = req.file;
    try {
        if (!file) return operationError(res, { code: ErrorCodes.MISSING_REQUIRED_FIELD, message: 'A CSV or Excel file is required', section: 'raw_data', operation: 'bulk_upload', field: 'file' });
        if (!verticalId || !isValidUUID(verticalId)) {
            return operationError(res, { code: ErrorCodes.INVALID_FORMAT, message: 'A valid verticalId is required', section: 'raw_data', operation: 'bulk_upload', field: 'verticalId' });
        }
        if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(verticalId))) {
            return operationError(res, { status: 403, code: ErrorCodes.FORBIDDEN, message: 'Access forbidden: you do not have access to this business vertical', section: 'raw_data', operation: 'bulk_upload' });
        }

        const logId = crypto.randomUUID();
        const fileExt = path.extname(file.originalname).toLowerCase() || '.csv';
        const fileName = `${logId}${fileExt}`;

        if (process.env.VERCEL) {
            // Vercel Serverless environment: bypass disk writes and run processing inline
            const logRes = await query(`
                INSERT INTO csv_upload_logs (id, uploaded_by, vertical_id, file_name, original_file_name, status, entity_type)
                VALUES ($1, $2, $3, $4, $5, 'processing', 'raw_data')
                RETURNING *
            `, [logId, req.user.sub, verticalId, fileName, file.originalname]);

            const uploadLog = logRes.rows[0];

            // Never let an audit-log failure abort before the background job is
            // registered — that would strand the row at 'processing' forever.
            await logAudit(req, {
                action: 'raw_data.upload_processing_vercel',
                targetCollection: 'csv_upload_logs',
                targetId: uploadLog.id,
                after: { originalFileName: file.originalname, status: 'processing' },
            }).catch(err => console.error('⚠️ logAudit failed (non-fatal, upload proceeds):', err.message));

            const mockJob = {
                data: {
                    batchId: uploadLog.id,
                    fileBufferBase64: file.buffer.toString('base64'),
                    verticalId,
                    uploadedBy: req.user.sub,
                    fileExt
                },
                progress: async (value) => {
                    console.log(`[Vercel Inline Worker] Job ${uploadLog.id} progress: ${value}%`);
                }
            };

            // Kick off RawData processing in the background (non-blocking for
            // Vercel) — see server/src/utils/background.js for why this can't
            // be a bare unawaited promise.
            runInBackground(
                import('../jobs/rawDataProcessor.js').then(({ processRawDataJob }) => processRawDataJob(mockJob)),
                { batchId: uploadLog.id, label: 'RawData' }
            );

            return res.status(202).json({
                success: true,
                data: { batchId: uploadLog.id, status: 'processing', message: 'File uploaded and processed inline on Vercel.' },
            });
        }

        const uploadPath = path.join(__dirname, '../../uploads', fileName);
        const uploadDir = path.dirname(uploadPath);
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        fs.writeFileSync(uploadPath, file.buffer);

        const logRes = await query(`
            INSERT INTO csv_upload_logs (id, uploaded_by, vertical_id, file_name, original_file_name, status, entity_type)
            VALUES ($1, $2, $3, $4, $5, 'queued', 'raw_data')
            RETURNING *
        `, [logId, req.user.sub, verticalId, fileName, file.originalname]);

        const uploadLog = logRes.rows[0];
        await logAudit(req, {
            action: 'raw_data.upload_queued',
            targetCollection: 'csv_upload_logs',
            targetId: uploadLog.id,
            after: { originalFileName: file.originalname, status: 'queued' },
        });

        return res.status(202).json({
            success: true,
            data: { batchId: uploadLog.id, status: 'queued', message: 'File uploaded and queued for processing.' },
        });
    } catch (error) {
        return sendControllerError(res, error, 'uploadRawDataCsv', { section: 'raw_data', operation: 'bulk_upload' });
    }
};
