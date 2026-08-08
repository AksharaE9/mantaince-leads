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
    parseFlexibleDate,
} from '../services/rawDataImportSchema.js';
import { buildXlsxTemplate } from '../services/leadImportTemplate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// CSV formula-injection guard
const sanitizeCsvValue = (val) => {
    const s = String(val ?? '');
    return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
};

let rawDataSchemaReady = false;
async function ensureRawDataSchema() {
    if (rawDataSchemaReady) return;
    try {
        await query(`
            CREATE TABLE IF NOT EXISTS raw_data (
                id UUID PRIMARY KEY,
                vertical_id UUID NOT NULL REFERENCES verticals(id) ON DELETE CASCADE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            ALTER TABLE raw_data ADD COLUMN IF NOT EXISTS sub_vertical_id UUID REFERENCES sub_verticals(id) ON DELETE CASCADE;
            ALTER TABLE raw_data ADD COLUMN IF NOT EXISTS assigned_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
            ALTER TABLE raw_data ADD COLUMN IF NOT EXISTS date DATE;
            ALTER TABLE raw_data ADD COLUMN IF NOT EXISTS product_service VARCHAR(255);
            ALTER TABLE raw_data ADD COLUMN IF NOT EXISTS lead_name VARCHAR(255);
            ALTER TABLE raw_data ADD COLUMN IF NOT EXISTS contact_person VARCHAR(255);
            ALTER TABLE raw_data ADD COLUMN IF NOT EXISTS phone_number VARCHAR(50);
            ALTER TABLE raw_data ADD COLUMN IF NOT EXISTS alternate_number VARCHAR(50);
            ALTER TABLE raw_data ADD COLUMN IF NOT EXISTS city VARCHAR(255);
            ALTER TABLE raw_data ADD COLUMN IF NOT EXISTS area VARCHAR(255);
            ALTER TABLE raw_data ADD COLUMN IF NOT EXISTS map_location TEXT;
            ALTER TABLE raw_data ADD COLUMN IF NOT EXISTS call_status VARCHAR(100);
            ALTER TABLE raw_data ADD COLUMN IF NOT EXISTS customer_response TEXT;
            ALTER TABLE raw_data ADD COLUMN IF NOT EXISTS follow_up_required VARCHAR(50);
            ALTER TABLE raw_data ADD COLUMN IF NOT EXISTS follow_up_date DATE;
            ALTER TABLE raw_data ADD COLUMN IF NOT EXISTS follow_up_time VARCHAR(100);
            ALTER TABLE raw_data ADD COLUMN IF NOT EXISTS next_action VARCHAR(255);
            ALTER TABLE raw_data ADD COLUMN IF NOT EXISTS remarks TEXT;
            ALTER TABLE raw_data ADD COLUMN IF NOT EXISTS converted VARCHAR(50);
            ALTER TABLE raw_data ADD COLUMN IF NOT EXISTS custom_data JSONB DEFAULT '{}'::jsonb;
            ALTER TABLE raw_data ADD COLUMN IF NOT EXISTS business_type VARCHAR(255);
            ALTER TABLE raw_data ADD COLUMN IF NOT EXISTS business_name VARCHAR(255);
            ALTER TABLE raw_data ADD COLUMN IF NOT EXISTS address TEXT;
            ALTER TABLE raw_data ADD COLUMN IF NOT EXISTS appointment_date DATE;
            ALTER TABLE raw_data ADD COLUMN IF NOT EXISTS appointment_timings VARCHAR(100);
            ALTER TABLE raw_data ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'single_add';
            ALTER TABLE raw_data ADD COLUMN IF NOT EXISTS csv_batch_id UUID;
            ALTER TABLE raw_data ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
            ALTER TABLE raw_data ADD COLUMN IF NOT EXISTS employee_name_raw VARCHAR(255);
            ALTER TABLE raw_data ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;
            ALTER TABLE raw_data ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

            CREATE INDEX IF NOT EXISTS idx_raw_data_subvertical ON raw_data(sub_vertical_id);
            CREATE INDEX IF NOT EXISTS idx_raw_data_phone ON raw_data(vertical_id, phone_number);
            CREATE INDEX IF NOT EXISTS idx_raw_data_vertical_subvertical_phone ON raw_data(vertical_id, sub_vertical_id, phone_number);
        `);
        rawDataSchemaReady = true;
    } catch (err) {
        console.error('⚠️ ensureRawDataSchema error:', err.message);
    }
}

/**
 * GET /raw-data
 */
export const getRawData = async (req, res) => {
    const { verticalId, page = 1, limit = 25, sortBy, sortDir } = req.query;
    try {
        await ensureRawDataSchema();
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
            SELECT r.*, 
                   COALESCE(r.lead_name, r.business_name) AS display_name,
                   COALESCE(r.product_service, r.business_type) AS display_product,
                   COALESCE(r.map_location, r.address) AS display_location,
                   COALESCE(r.follow_up_date, r.appointment_date) AS display_follow_up_date,
                   COALESCE(r.follow_up_time, r.appointment_timings) AS display_follow_up_time,
                   u.name AS assignee_name,
                   sv.name AS sub_vertical_name
            FROM raw_data r
            LEFT JOIN users u ON u.id = r.assigned_user_id
            LEFT JOIN sub_verticals sv ON sv.id = r.sub_vertical_id
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
 * GET /raw-data/export/csv
 */
const RAW_DATA_EXPORT_MAPPERS = {
    date: r => r.date_str || '',
    employeeName: r => r.assignee_name || r.employee_name_raw || '',
    productService: r => r.product_service || r.business_type || '',
    leadName: r => r.lead_name || r.business_name || '',
    contactPerson: r => r.contact_person || '',
    phoneNumber: r => r.phone_number || '',
    alternateNumber: r => r.alternate_number || '',
    city: r => r.city || '',
    area: r => r.area || '',
    mapLocation: r => r.map_location || r.address || '',
    callStatus: r => r.call_status || '',
    customerResponse: r => r.customer_response || '',
    followUpRequired: r => r.follow_up_required || '',
    followUpDate: r => r.follow_up_date_str || r.appointment_date_str || '',
    followUpTime: r => r.follow_up_time || r.appointment_timings || '',
    nextAction: r => r.next_action || '',
    remarks: r => r.remarks || '',
    converted: r => r.converted || '',
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

        const rowsRes = await query(`
            SELECT r.*, u.name AS assignee_name,
                to_char(r.date, 'YYYY-MM-DD') AS date_str,
                to_char(r.follow_up_date, 'YYYY-MM-DD') AS follow_up_date_str,
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
 * Single-Add endpoint
 */
export const createRawData = async (req, res) => {
    const { verticalId, subVerticalId } = req.body;
    try {
        if (!verticalId || !isValidUUID(verticalId)) {
            return operationError(res, { code: ErrorCodes.INVALID_FORMAT, message: 'A valid verticalId is required', section: 'raw_data', operation: 'single_add', field: 'verticalId' });
        }
        if (subVerticalId && !isValidUUID(subVerticalId)) {
            return operationError(res, { code: ErrorCodes.INVALID_FORMAT, message: 'Invalid subVerticalId format', section: 'raw_data', operation: 'single_add', field: 'subVerticalId' });
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
            productService: req.body.productService || req.body.businessType,
            leadName: req.body.leadName || req.body.businessName,
            contactPerson: req.body.contactPerson,
            phoneNumber: req.body.phoneNumber || req.body.mobileNumber,
            alternateNumber: req.body.alternateNumber,
            city: req.body.city,
            area: req.body.area,
            mapLocation: req.body.mapLocation || req.body.address,
            callStatus: req.body.callStatus,
            customerResponse: req.body.customerResponse,
            followUpRequired: req.body.followUpRequired,
            followUpDate: req.body.followUpDate || req.body.appointmentDate,
            followUpTime: req.body.followUpTime || req.body.appointmentTimings,
            nextAction: req.body.nextAction,
            remarks: req.body.remarks,
            converted: req.body.converted,
        };

        const { errors, warnings, assignedUserId, employeeNameRaw } = validateRawDataRow(row, { agents, knownBusinessTypes });
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
        let dupRes;
        if (subVerticalId) {
            dupRes = await query(
                'SELECT id, lead_name, business_name, contact_person FROM raw_data WHERE vertical_id = $1 AND sub_vertical_id = $2 AND phone_number = $3 AND is_deleted = false LIMIT 1',
                [verticalId, subVerticalId, phone]
            );
        } else {
            dupRes = await query(
                'SELECT id, lead_name, business_name, contact_person FROM raw_data WHERE vertical_id = $1 AND phone_number = $2 AND is_deleted = false LIMIT 1',
                [verticalId, phone]
            );
        }
        if (dupRes.rows.length > 0) {
            const conflictName = dupRes.rows[0].lead_name || dupRes.rows[0].business_name || dupRes.rows[0].contact_person || 'existing record';
            return operationError(res, {
                status: 409, code: ErrorCodes.DUPLICATE_PHONE,
                message: `Mobile number ${phone} already exists in Raw Data for this section (conflicts with "${conflictName}")`,
                section: 'raw_data', operation: 'single_add', field: 'phoneNumber', recordId: dupRes.rows[0].id,
            });
        }

        const id = crypto.randomUUID();
        const leadNameVal = row.leadName || null;
        const prodVal = row.productService || null;
        const mapVal = row.mapLocation || null;
        const followUpDateVal = parseFlexibleDate(row.followUpDate);
        const followUpTimeVal = row.followUpTime || null;

        const insertRes = await query(`
            INSERT INTO raw_data (
                id, vertical_id, sub_vertical_id, assigned_user_id, date,
                product_service, lead_name, contact_person, phone_number, alternate_number,
                city, area, map_location, call_status, customer_response,
                follow_up_required, follow_up_date, follow_up_time, next_action,
                remarks, converted, business_type, business_name, address,
                appointment_date, appointment_timings, source, created_by, employee_name_raw
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,'single_add',$27,$28)
            RETURNING *
        `, [
            id, verticalId, subVerticalId || null, assignedUserId, parseFlexibleDate(row.date),
            prodVal, leadNameVal, row.contactPerson || null, phone, row.alternateNumber || null,
            row.city || null, row.area || null, mapVal, row.callStatus || null, row.customerResponse || null,
            row.followUpRequired || null, followUpDateVal, followUpTimeVal, row.nextAction || null,
            row.remarks || null, row.converted || null, prodVal, leadNameVal, mapVal,
            followUpDateVal, followUpTimeVal, req.user.sub, employeeNameRaw || null,
        ]);

        logAudit(req, { action: 'raw_data.create', targetCollection: 'raw_data', targetId: id, after: insertRes.rows[0] });
        broadcastToAll({ type: 'RAW_DATA_MUTATED', verticalId, action: 'create' });

        return res.status(201).json({ success: true, data: insertRes.rows[0], warnings });
    } catch (error) {
        return sendControllerError(res, error, 'createRawData', { section: 'raw_data', operation: 'single_add' });
    }
};

/**
 * GET /raw-data/import-template
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
            date: '24-07-2026',
            employeeName: 'Jane Doe',
            productService: 'Software Solutions',
            leadName: 'Acme Enterprises',
            contactPerson: 'John Smith',
            phoneNumber: '9876543210',
            alternateNumber: '9123456780',
            city: 'Bengaluru',
            area: 'Whitefield',
            mapLocation: 'https://maps.google.com/?q=12.9716,77.5946',
            callStatus: 'Connected',
            customerResponse: 'Interested in demo',
            followUpRequired: 'Yes',
            followUpDate: '01-08-2026',
            followUpTime: '11:00 AM',
            nextAction: 'Schedule product demo',
            remarks: 'High potential lead',
            converted: 'N',
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
 * GET /raw-data/schema
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
 */
export const uploadRawDataCsv = async (req, res) => {
    const { verticalId, subVerticalId } = req.body;
    const file = req.file;
    try {
        if (!file) return operationError(res, { code: ErrorCodes.MISSING_REQUIRED_FIELD, message: 'A CSV or Excel file is required', section: 'raw_data', operation: 'bulk_upload', field: 'file' });
        if (!verticalId || !isValidUUID(verticalId)) {
            return operationError(res, { code: ErrorCodes.INVALID_FORMAT, message: 'A valid verticalId is required', section: 'raw_data', operation: 'bulk_upload', field: 'verticalId' });
        }
        if (subVerticalId && !isValidUUID(subVerticalId)) {
            return operationError(res, { code: ErrorCodes.INVALID_FORMAT, message: 'Invalid subVerticalId format', section: 'raw_data', operation: 'bulk_upload', field: 'subVerticalId' });
        }
        if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(verticalId))) {
            return operationError(res, { status: 403, code: ErrorCodes.FORBIDDEN, message: 'Access forbidden: you do not have access to this business vertical', section: 'raw_data', operation: 'bulk_upload' });
        }

        const logId = crypto.randomUUID();
        const fileExt = path.extname(file.originalname).toLowerCase() || '.csv';
        const fileName = `${logId}${fileExt}`;

        if (process.env.VERCEL) {
            const logRes = await query(`
                INSERT INTO csv_upload_logs (id, uploaded_by, vertical_id, sub_vertical_id, file_name, original_file_name, status, entity_type)
                VALUES ($1, $2, $3, $4, $5, $6, 'processing', 'raw_data')
                RETURNING *
            `, [logId, req.user.sub, verticalId, subVerticalId || null, fileName, file.originalname]);

            const uploadLog = logRes.rows[0];

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
                    subVerticalId: subVerticalId || null,
                    uploadedBy: req.user.sub,
                    fileExt
                },
                progress: async (value) => {
                    console.log(`[Vercel Inline Worker] Job ${uploadLog.id} progress: ${value}%`);
                }
            };

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
            INSERT INTO csv_upload_logs (id, uploaded_by, vertical_id, sub_vertical_id, file_name, original_file_name, status, entity_type)
            VALUES ($1, $2, $3, $4, $5, $6, 'queued', 'raw_data')
            RETURNING *
        `, [logId, req.user.sub, verticalId, subVerticalId || null, fileName, file.originalname]);

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
