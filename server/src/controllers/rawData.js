import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../config/db.js';
import { isValidUUID } from '../utils/validators/index.js';
import { sendControllerError } from '../utils/dbErrors.js';
import { logAudit } from '../services/audit.js';
import {
    RAW_DATA_FIELDS,
    validateRawDataRow,
    getAssignableAgents,
    getKnownBusinessTypes,
} from '../services/rawDataImportSchema.js';
import { buildXlsxTemplate } from '../services/leadImportTemplate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * GET /raw-data
 * Same empty/omitted-query-param safety as getCostConversions — none of
 * these ever reach a WHERE clause unless present and well-formed.
 */
export const getRawData = async (req, res) => {
    const { verticalId, search, assignedUserId, page = 1, limit = 25 } = req.query;
    try {
        if (!verticalId || !isValidUUID(verticalId)) {
            return res.status(200).json({ success: true, data: [], meta: { total: 0 } });
        }
        if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(verticalId))) {
            return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });
        }

        const params = [verticalId];
        const wheres = ['r.vertical_id = $1', 'r.is_deleted = false'];
        let pIdx = 2;

        if (assignedUserId && isValidUUID(assignedUserId)) {
            wheres.push(`r.assigned_user_id = $${pIdx++}`);
            params.push(assignedUserId);
        }
        if (search && search.trim().length >= 2) {
            wheres.push(`(r.business_name ILIKE $${pIdx} OR r.phone_number ILIKE $${pIdx})`);
            params.push(`%${search.trim()}%`);
            pIdx++;
        }

        const limitNum = Math.min(parseInt(limit, 10) || 25, 100);
        const pageNum = Math.max(parseInt(page, 10) || 1, 1);
        const offset = (pageNum - 1) * limitNum;

        const sql = `
            SELECT r.*, u.name AS assignee_name
            FROM raw_data r
            LEFT JOIN users u ON u.id = r.assigned_user_id
            WHERE ${wheres.join(' AND ')}
            ORDER BY r.created_at DESC
            LIMIT $${pIdx} OFFSET $${pIdx + 1}
        `;
        params.push(limitNum, offset);

        const countSql = `SELECT COUNT(*) FROM raw_data r WHERE ${wheres.join(' AND ')}`;

        const [rowsRes, countRes] = await Promise.all([
            query(sql, params),
            query(countSql, params.slice(0, pIdx - 1)),
        ]);

        return res.status(200).json({
            success: true,
            data: rowsRes.rows,
            meta: { total: parseInt(countRes.rows[0].count, 10), page: pageNum, limit: limitNum },
        });
    } catch (error) {
        return sendControllerError(res, error, 'getRawData');
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
            return res.status(400).json({ success: false, error: 'A valid verticalId is required' });
        }
        if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(verticalId))) {
            return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });
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
            return res.status(422).json({ success: false, error: 'Validation failed', errors });
        }

        const phone = (row.phoneNumber || '').replace(/[^\d+]/g, '');
        const dupRes = await query(
            'SELECT id FROM raw_data WHERE vertical_id = $1 AND phone_number = $2 AND is_deleted = false LIMIT 1',
            [verticalId, phone]
        );
        if (dupRes.rows.length > 0) {
            return res.status(409).json({ success: false, error: 'A raw data record with this phone number already exists' });
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

        return res.status(201).json({ success: true, data: insertRes.rows[0], warnings });
    } catch (error) {
        return sendControllerError(res, error, 'createRawData');
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
        const csvLine = (vals) => vals.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',');
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
        if (!file) return res.status(400).json({ success: false, error: 'A CSV or Excel file is required' });
        if (!verticalId || !isValidUUID(verticalId)) {
            return res.status(400).json({ success: false, error: 'A valid verticalId is required' });
        }
        if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(verticalId))) {
            return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });
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

            await logAudit(req, {
                action: 'raw_data.upload_processing_vercel',
                targetCollection: 'csv_upload_logs',
                targetId: uploadLog.id,
                after: { originalFileName: file.originalname, status: 'processing' },
            });

            const mockJob = {
                data: {
                    batchId: uploadLog.id,
                    fileBufferBase64: file.buffer.toString('base64'),
                    verticalId,
                    fileExt
                },
                progress: async (value) => {
                    console.log(`[Vercel Inline Worker] Job ${uploadLog.id} progress: ${value}%`);
                }
            };

            try {
                const { processRawDataJob } = await import('../jobs/rawDataProcessor.js');
                await processRawDataJob(mockJob);
            } catch (err) {
                console.error('❌ Vercel Inline RawData processing failed:', err);
                await query(
                    "UPDATE csv_upload_logs SET status = 'failed', errors = $2, processing_finished_at = NOW() WHERE id = $1",
                    [uploadLog.id, JSON.stringify([{ row: 0, reason: `Vercel inline processing failed: ${err.message}` }])]
                );
            }

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
        return sendControllerError(res, error, 'uploadRawDataCsv');
    }
};
