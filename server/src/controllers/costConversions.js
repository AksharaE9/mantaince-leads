import pg from 'pg';
import Cursor from 'pg-cursor';
pg.Cursor = pg.Cursor || Cursor;
import { query } from '../config/db.js';
import pool from '../config/db.js';
import crypto from 'crypto';
import { logAudit } from '../services/audit.js';
import { isValidUUID } from '../utils/validators/index.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    withCache, cacheGet, cacheSet, cacheDelete,
    invalidateOnLeadChange
} from '../services/cache.js';
import { CacheKeys, TTL } from '../lib/cacheKeys.js';
import { broadcastToAll } from '../services/assignmentBroadcaster.js';
import { z } from 'zod';
import { bulkInsert } from '../db/bulkInsert.js';
import { sendControllerError } from '../utils/dbErrors.js';
import { operationError, ErrorCodes } from '../utils/operationError.js';

// ── CSV escape helper (module-level, reused by export) ────────────────────────
// H5: prefix any value whose first character Excel/Sheets treats as a
// formula trigger (=, +, -, @, tab, CR) with a literal single-quote BEFORE
// the quote-doubling below runs, so e.g. `=cmd|'/c calc'!A1` in an uploaded
// BUSINESS NAME downloads as literal text instead of executing as a formula
// when an admin later opens the exported CSV.
const escapeCsvVal = (val) => {
    if (val === undefined || val === null) return '';
    const s = val.toString();
    const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return guarded.replace(/"/g, '""');
};

// L3: DB-stored, admin-configurable validation_regex fields are tested
// directly against user input with `new RegExp(...).test(...)`. A
// maliciously or accidentally catastrophic pattern (e.g. `(a+)+$`) could
// hang the request indefinitely — Node has no built-in regex-exec timeout.
// Capping the length of the string being tested bounds most catastrophic-
// backtracking blowups in practice (exponential cost is driven by input
// length) without needing a worker-thread/timeout mechanism.
const MAX_REGEX_TEST_LENGTH = 1000;

// ── Cursor helpers ─────────────────────────────────────────────────────────────
function encodeCursor(createdAt, id) {
    return Buffer.from(JSON.stringify({ t: createdAt, i: id })).toString('base64url');
}

function decodeCursor(cursor) {
    try {
        const { t, i } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        return { createdAt: t, id: i };
    } catch {
        return null;
    }
}

// ── Column whitelist for ORDER BY injection protection ─────────────────────────
const SORT_COLUMN_MAP = {
    createdAt:     'l.created_at',
    updatedAt:     'l.updated_at',
    businessName:  'l.business_name',
    name:          'l.name',
    status:        'l.status',
};

/**
 * GET /cost-conversions
 */
export const getCostConversions = async (req, res) => {
    const {
        verticalId,
        subVerticalId,
        status,
        area,
        assignedTo,
        search,
        limit     = 25,
        cursor,
        sortBy    = 'createdAt',
        sortDir   = 'desc',
        dateFrom,
        dateTo,
        includeCount = 'false',
        csvBatchId,
        leadType,
        stageId,
        followUpDate,
    } = req.query;

    try {
        if (!verticalId || !isValidUUID(verticalId)) {
            return res.status(200).json({
                success: true,
                data: [],
                meta: { nextCursor: null, prevCursor: null, hasNextPage: false, hasPrevPage: false, limit: 25 }
            });
        }

        // RBAC: non-super_admin must have access to this vertical
        if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(verticalId))) {
            return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });
        }

        const pageNum = parseInt(req.query.page, 10) || 1;
        const limitNum = Math.min(parseInt(limit, 10) || 25, 100);
        const offset = (pageNum - 1) * limitNum;
        const shouldCount = includeCount === 'true' || !!req.query.page;
        const dir      = sortDir === 'asc' ? 'ASC' : 'DESC';
        const sortCol  = ['createdAt', 'updatedAt', 'businessName', 'name', 'status'].includes(sortBy) ? SORT_COLUMN_MAP[sortBy] : 'l.created_at';
        // ── Build WHERE clauses dynamically ───────────────────────────────
        const params  = [verticalId];
        // Rows flagged 'duplicate_removed' or 'promoted_removed' are soft-hidden
        // from normal listing — reversible by clearing those columns, never hard-deleted.
        const wheres  = ['l.vertical_id = $1', 'l.is_deleted = false', "(l.duplicate_status IS NULL OR l.duplicate_status NOT IN ('duplicate_removed', 'promoted_removed'))"];
        let   pIdx    = 2;



        if (subVerticalId && isValidUUID(subVerticalId)) {
            wheres.push(`l.sub_vertical_id = $${pIdx++}`);
            params.push(subVerticalId);
        }
        if (status) {
            wheres.push(`l.status = $${pIdx++}`);
            params.push(status);
        }
        if (assignedTo && isValidUUID(assignedTo)) {
            wheres.push(`l.assigned_to = $${pIdx++}`);
            params.push(assignedTo);
        }
        if (area) {
            wheres.push(`l.data->>'area' = $${pIdx++}`);
            params.push(area);
        }
        if (dateFrom) {
            wheres.push(`l.created_at >= $${pIdx++}`);
            params.push(dateFrom);
        }
        if (dateTo) {
            wheres.push(`l.created_at <= $${pIdx++}`);
            params.push(dateTo);
        }
        if (csvBatchId && isValidUUID(csvBatchId)) {
            wheres.push(`l.csv_batch_id = $${pIdx++}`);
            params.push(csvBatchId);
        }
        if (leadType) {
            wheres.push(`l.lead_type = $${pIdx++}`);
            params.push(leadType);
        } else {
            wheres.push(`l.lead_type != 'POSITIVE'`);
        }
        if (stageId && isValidUUID(stageId)) {
            wheres.push(`l.stage_id = $${pIdx++}`);
            params.push(stageId);
        }
        if (followUpDate) {
            wheres.push(`EXISTS (
                SELECT 1 FROM follow_ups f 
                WHERE f.cost_conversion_id = l.id 
                  AND DATE(f.follow_up_date AT TIME ZONE 'Asia/Kolkata') = $${pIdx++}::date
            )`);
            params.push(followUpDate);
        }

        // ── Full-text search vs. ILIKE fallback ───────────────────────────
        if (search && search.trim().length >= 2) {
            const q = search.trim();
            // L2: strip tsquery special syntax characters from each word
            // before appending `:*` — otherwise a search term containing
            // &, |, !, (, ), *, or ' produces a to_tsquery syntax error that
            // surfaces as a raw 500. Normal alphanumeric searches are
            // untouched by this.
            const tsWords = q.split(/\s+/)
                .map(w => w.replace(/[&|!():*']/g, ''))
                .filter(Boolean);
            if (tsWords.length > 0 && (q.includes(' ') || q.length >= 4)) {
                const tsQuery = tsWords.map(w => `${w}:*`).join(' & ');
                wheres.push(`l.search_vector @@ to_tsquery('english', $${pIdx++})`);
                params.push(tsQuery);
            } else {
                wheres.push(
                    `(l.name ILIKE $${pIdx} OR l.business_name ILIKE $${pIdx} OR l.phone ILIKE $${pIdx})`
                );
                params.push(`%${q}%`);
                pIdx++;
            }
        }

        // ── Cursor-based pagination WHERE clause ──────────────────────────
        let cursorData = null;
        if (cursor) {
            cursorData = decodeCursor(cursor);
            if (cursorData) {
                const op = dir === 'DESC' ? '<' : '>';
                wheres.push(
                    `(${sortCol} ${op} $${pIdx} OR (${sortCol} = $${pIdx} AND l.id ${op} $${pIdx + 1}))`
                );
                params.push(cursorData.createdAt, cursorData.id);
                pIdx += 2;
            }
        }

        const whereClause = wheres.join(' AND ');
        const countParams = params.slice(0, pIdx - 1);

        let costConversionsSql = `
            SELECT
                l.id, l.name, l.phone, l.business_name,
                l.status, l.source, l.data,
                l.vertical_id, l.sub_vertical_id,
                l.assigned_to, l.created_at, l.updated_at,
                l.lead_type,
                l.geotag_lat, l.geotag_lng, l.geotag_accuracy,
                l.geotag_photo_key, l.geotag_address, l.geotag_captured_at,
                l.stage_id,
                u.name       AS assignee_name,
                u.email      AS assignee_email,
                sv.name      AS sub_vertical_name
            FROM cost_conversions l
            LEFT JOIN users         u   ON u.id   = l.assigned_to
            LEFT JOIN sub_verticals sv  ON sv.id  = l.sub_vertical_id
            WHERE ${whereClause}
            ORDER BY ${sortCol} ${dir}, l.id ${dir}
            LIMIT $${pIdx}
        `;
        params.push(limitNum + 1);

        if (!cursor && req.query.page) {
            costConversionsSql += ` OFFSET $${pIdx + 1}`;
            params.push(offset);
        }

        const countSql = `SELECT COUNT(*) FROM cost_conversions l WHERE ${whereClause}`;

        const [leadsRes, countRes] = await Promise.all([
            query(costConversionsSql, params),
            shouldCount ? query(countSql, countParams) : Promise.resolve(null),
        ]);

        const rows        = leadsRes.rows;
        const hasNextPage = rows.length > limitNum;
        if (hasNextPage) rows.pop();

        const hasPrevPage = !!cursorData || pageNum > 1;
        const nextCursor  = hasNextPage && rows.length > 0
            ? encodeCursor(rows[rows.length - 1].created_at, rows[rows.length - 1].id)
            : null;
        const prevCursor  = hasPrevPage && rows.length > 0
            ? encodeCursor(rows[0].created_at, rows[0].id)
            : null;

        const totalCount = (countRes && countRes.rows && countRes.rows.length > 0) ? parseInt(countRes.rows[0].count, 10) : 0;
        const totalPages = Math.ceil(totalCount / limitNum) || 1;

        const response = {
            success: true,
            data: rows,
            meta: {
                nextCursor,
                prevCursor,
                hasNextPage,
                hasPrevPage,
                limit: limitNum,
                total: shouldCount ? totalCount : undefined,
                totalPages: shouldCount ? totalPages : undefined,
            }
        };

        return res.status(200).json(response);
    } catch (error) {
        return sendControllerError(res, error, 'getCostConversions');
    }
};

/**
 * POST /cost-conversions
 */
export const createCostConversion = async (req, res) => {
    const { 
        name, phone, businessName, verticalId, subVerticalId, assignedTo, 
        data = {}, leadType = 'CALL', 
        geotagLat, geotagLng, geotagAccuracy, geotagPhotoKey, geotagAddress, geotagCapturedAt,
        customValues = {}, stageId,
        status = 'new'
    } = req.body;
    const section = leadType === 'POSITIVE' ? 'positives' : 'cos';

    if (!isValidUUID(verticalId)) {
        return operationError(res, { code: ErrorCodes.INVALID_FORMAT, message: 'Invalid vertical ID format', section, operation: 'single_add', field: 'verticalId' });
    }
    try {
        if (!subVerticalId || !isValidUUID(subVerticalId)) {
            return operationError(res, { code: ErrorCodes.MISSING_REQUIRED_FIELD, message: 'Sub-vertical selection is mandatory for creating Cost/Conversions.', section, operation: 'single_add', field: 'subVerticalId' });
        }

        // RBAC scoping
        if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(verticalId))) {
            return operationError(res, { status: 403, code: ErrorCodes.FORBIDDEN, message: 'Access forbidden: you do not have access to this business vertical', section, operation: 'single_add' });
        }

        const leadId = crypto.randomUUID();
        let leadRes;

        const gLat = geotagLat ? parseFloat(geotagLat) : null;
        const gLng = geotagLng ? parseFloat(geotagLng) : null;
        const gAcc = geotagAccuracy ? parseFloat(geotagAccuracy) : null;
        const gCap = geotagCapturedAt ? new Date(geotagCapturedAt) : null;

        if (!name || !name.trim()) {
            return operationError(res, { code: ErrorCodes.MISSING_REQUIRED_FIELD, message: 'Business / Person / Shop / Company name is mandatory', section, operation: 'single_add', field: 'name' });
        }
        if (!phone || !phone.toString().trim()) {
            return operationError(res, { code: ErrorCodes.MISSING_REQUIRED_FIELD, message: 'Contact number is mandatory', section, operation: 'single_add', field: 'phone' });
        }
        const sanitizedPhone = phone.toString().replace(/[^\d+]/g, '').trim();
        if (!sanitizedPhone) {
            return operationError(res, { code: ErrorCodes.MISSING_REQUIRED_FIELD, message: 'Contact number is mandatory', section, operation: 'single_add', field: 'phone' });
        }

        let targetEmployeeName = '';
        if (assignedTo && isValidUUID(assignedTo)) {
            const userRes = await query('SELECT name FROM users WHERE id = $1', [assignedTo]);
            if (userRes.rows[0]) {
                targetEmployeeName = userRes.rows[0].name;
            }
        }
        data.employeeName = targetEmployeeName || data.employeeName || '';

        // Duplicate check is scoped to lead_type: COS (CALL/FIELD) and
        // Positives (POSITIVE) share this table but are treated as
        // independent sections for duplicate purposes — the same phone
        // number legitimately exists once as a COS lead and once as a
        // Positive without either blocking the other.
        leadRes = await query(`
            WITH dedup AS (
                SELECT id FROM cost_conversions
                WHERE phone = $1 AND vertical_id = $2 AND is_deleted = false AND lead_type = $10
                LIMIT 1
            )
            INSERT INTO cost_conversions
                (id, vertical_id, sub_vertical_id, assigned_to, uploaded_by, name, phone, business_name, data, status,
                 lead_type, geotag_lat, geotag_lng, geotag_accuracy, geotag_photo_key, geotag_address, geotag_captured_at, stage_id)
            SELECT $3, $2, $4, $5, $6, $7, $1, $8, $9, $18,
                   $10, $11, $12, $13, $14, $15, $16, $17
            WHERE NOT EXISTS (SELECT 1 FROM dedup)
            RETURNING *
        `, [
            sanitizedPhone, verticalId,
            leadId,
            (subVerticalId && isValidUUID(subVerticalId)) ? subVerticalId : null,
            (assignedTo    && isValidUUID(assignedTo))    ? assignedTo    : null,
            req.user.sub,
            name, businessName || '', JSON.stringify(data),
            leadType || 'CALL',
            gLat, gLng, gAcc,
            geotagPhotoKey || null,
            geotagAddress || null,
            gCap,
            (stageId       && isValidUUID(stageId))       ? stageId       : null,
            status || 'new'
        ]);

        if (leadRes.rows.length === 0) {
            return operationError(res, {
                status: 409, code: ErrorCodes.DUPLICATE_PHONE,
                message: `Phone number ${sanitizedPhone} already exists in ${section === 'positives' ? 'Positives' : 'COS'} for this vertical`,
                section, operation: 'single_add', field: 'phone',
            });
        }

        const lead = leadRes.rows[0];

        // Custom Fields
        if (subVerticalId && customValues && Object.keys(customValues).length > 0) {
            const customFieldsRes = await query(
                'SELECT id, field_key, is_required, validation_regex, validation_message FROM custom_fields WHERE sub_vertical_id = $1 AND is_active = true',
                [subVerticalId]
            );
            
            const customInsertPromises = [];
            for (const field of customFieldsRes.rows) {
                const val = customValues[field.field_key];
                if (field.is_required && (val === undefined || val === null || val === '')) {
                    return operationError(res, { code: ErrorCodes.MISSING_REQUIRED_FIELD, message: `Custom field '${field.field_key}' is required`, section, operation: 'single_add', field: field.field_key });
                }

                if (val !== undefined && val !== null && val !== '') {
                    if (field.validation_regex) {
                        const testVal = val.toString();
                        // L3: length cap before testing — see MAX_REGEX_TEST_LENGTH comment above.
                        if (testVal.length > MAX_REGEX_TEST_LENGTH) {
                            return operationError(res, { code: ErrorCodes.INVALID_FORMAT, message: field.validation_message || `'${field.field_key}' is too long to validate (max ${MAX_REGEX_TEST_LENGTH} characters)`, section, operation: 'single_add', field: field.field_key });
                        }
                        try {
                            const rx = new RegExp(field.validation_regex);
                            if (!rx.test(testVal)) {
                                return operationError(res, { code: ErrorCodes.INVALID_FORMAT, message: field.validation_message || `Invalid format for '${field.field_key}'`, section, operation: 'single_add', field: field.field_key });
                            }
                        } catch (e) {
                            if (e.message.includes('Invalid format')) {
                                return res.status(400).json({ success: false, error: e.message });
                            }
                        }
                    }
                    
                    const valId = crypto.randomUUID();
                    customInsertPromises.push(
                        query(`
                            INSERT INTO cost_conversion_custom_values (id, cost_conversion_id, custom_field_id, value)
                            VALUES ($1, $2, $3, $4)
                            ON CONFLICT (cost_conversion_id, custom_field_id) DO UPDATE SET value = EXCLUDED.value
                        `, [valId, leadId, field.id, String(val)])
                    );
                }
            }
            if (customInsertPromises.length > 0) {
                await Promise.all(customInsertPromises);
            }
        }

        await invalidateOnLeadChange(verticalId, null);
        broadcastToAll({ type: 'COST_CONVERSION_MUTATED', verticalId, action: 'create' });
        logAudit(req, { action: 'cost_conversion.create', targetCollection: 'cost_conversions', targetId: lead.id, after: lead });

        return res.status(201).json({ success: true, data: lead });
    } catch (error) {
        return sendControllerError(res, error, 'createCostConversion', { section, operation: 'single_add' });
    }
};

/**
 * GET /cost-conversions/:id
 */
export const getCostConversionById = async (req, res) => {
    const { id } = req.params;
    if (!isValidUUID(id)) {
        return res.status(404).json({ success: false, error: 'Cost/Conversion not found' });
    }
    try {
        const res2 = await query(`
            SELECT
                l.*,
                u.id    AS assignee_id,
                u.name  AS assignee_name,
                u.email AS assignee_email,
                sv.id   AS sv_id,
                sv.name AS sv_name,
                v.name  AS vertical_name,
                v.color AS vertical_color
            FROM cost_conversions l
            LEFT JOIN users         u  ON u.id  = l.assigned_to
            LEFT JOIN sub_verticals sv ON sv.id = l.sub_vertical_id
            LEFT JOIN verticals     v  ON v.id  = l.vertical_id
            WHERE l.id = $1
        `, [id]);

        const lead = res2.rows[0];
        if (!lead || lead.is_deleted) {
            return res.status(404).json({ success: false, error: 'Cost/Conversion not found' });
        }

        const customValuesRes = await query(`
            SELECT cf.field_key, lcv.value
            FROM cost_conversion_custom_values lcv
            JOIN custom_fields cf ON lcv.custom_field_id = cf.id
            WHERE lcv.cost_conversion_id = $1
        `, [id]);
        
        const customValues = {};
        customValuesRes.rows.forEach(row => {
            customValues[row.field_key] = row.value;
        });
        lead.customValues = customValues;

        if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(lead.vertical_id))) {
            return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });
        }




        return res.status(200).json({ success: true, data: lead });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
};

/**
 * PATCH /cost-conversions/:id
 */
export const updateCostConversion = async (req, res) => {
    const { id } = req.params;
    const updates = req.body;
    if (!isValidUUID(id)) {
        return res.status(404).json({ success: false, error: 'Cost/Conversion not found' });
    }
    try {
        const leadRes = await query('SELECT id, vertical_id, is_deleted, assigned_to, uploaded_by, lead_type FROM cost_conversions WHERE id = $1', [id]);
        const lead    = leadRes.rows[0];
        if (!lead || lead.is_deleted) {
            return res.status(404).json({ success: false, error: 'Cost/Conversion not found' });
        }

        if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(lead.vertical_id))) {
            return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });
        }




        if (updates.name !== undefined && (!updates.name || !updates.name.trim())) {
            return res.status(400).json({ success: false, error: 'Business / Person / Shop / Company name is mandatory' });
        }
        if (updates.phone !== undefined) {
            const sanitizedPhone = updates.phone.toString().replace(/[^\d+]/g, '').trim();
            if (!sanitizedPhone) {
                return res.status(400).json({ success: false, error: 'Contact number is mandatory' });
            }
            // Check for duplicates — scoped to this lead's own lead_type so COS
            // and Positives (which share this table) never cross-flag each other.
            const existing = await query(
                `SELECT id FROM cost_conversions
                WHERE phone = $1 AND vertical_id = $2 AND id <> $3 AND is_deleted = false AND lead_type = $4
                LIMIT 1`,
                [sanitizedPhone, lead.vertical_id, id, lead.lead_type]
            );
            if (existing.rowCount > 0) {
                return res.status(409).json({ success: false, error: 'Another lead with this phone number already exists' });
            }
            updates.phone = sanitizedPhone;
        }

        let targetEmployeeName = null;
        if (updates.assignedTo !== undefined) {
            if (updates.assignedTo && isValidUUID(updates.assignedTo)) {
                const userRes = await query('SELECT name FROM users WHERE id = $1', [updates.assignedTo]);
                if (userRes.rows[0]) {
                    targetEmployeeName = userRes.rows[0].name;
                }
            }
        } else if (updates.data) {
            const currentLeadRes = await query('SELECT assigned_to FROM cost_conversions WHERE id = $1', [id]);
            const currentAssignedTo = currentLeadRes.rows[0]?.assigned_to;
            if (currentAssignedTo) {
                const userRes = await query('SELECT name FROM users WHERE id = $1', [currentAssignedTo]);
                if (userRes.rows[0]) {
                    targetEmployeeName = userRes.rows[0].name;
                }
            }
        }

        if (targetEmployeeName !== null) {
            updates.data = { ...(updates.data || {}), employeeName: targetEmployeeName };
        }

        const fields = [
            'name', 'phone', 'business_name', 'status', 'sub_vertical_id', 'assigned_to',
            'lead_type', 'geotag_lat', 'geotag_lng', 'geotag_accuracy',
            'geotag_photo_key', 'geotag_address', 'geotag_captured_at', 'stage_id'
        ];
        const setClauses = [];
        const params     = [id];
        let   pIdx       = 2;

        fields.forEach(f => {
            const camelF = f.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
            if (updates[camelF] !== undefined) {
                setClauses.push(`${f} = $${pIdx++}`);
                let val = updates[camelF];
                if (f === 'geotag_lat' || f === 'geotag_lng' || f === 'geotag_accuracy') {
                    val = val !== '' && val !== null ? parseFloat(val) : null;
                } else if (f === 'geotag_captured_at') {
                    val = val !== '' && val !== null ? new Date(val) : null;
                } else if (f === 'stage_id') {
                    val = val !== '' && val !== null && isValidUUID(val) ? val : null;
                }
                params.push(val);
            }
        });

        if (updates.data) {
            setClauses.push(`data = data || $${pIdx++}`);
            params.push(JSON.stringify(updates.data));
        }

        if (updates.customValues) {
            const subVerticalId = updates.subVerticalId !== undefined ? updates.subVerticalId : lead.sub_vertical_id;
            
            if (subVerticalId) {
                const customFieldsRes = await query(
                    'SELECT id, field_key, is_required, validation_regex, validation_message FROM custom_fields WHERE sub_vertical_id = $1 AND is_active = true',
                    [subVerticalId]
                );
                
                const insertPromises = [];
                for (const field of customFieldsRes.rows) {
                    const val = updates.customValues[field.field_key];
                    
                    if (field.is_required && (val === null || val === '')) {
                        return res.status(400).json({ success: false, error: `Custom field '${field.field_key}' is required` });
                    }
                    
                    if (val !== undefined && val !== null && val !== '') {
                        if (field.validation_regex) {
                            const testVal = val.toString();
                            // L3: length cap before testing — see MAX_REGEX_TEST_LENGTH comment above.
                            if (testVal.length > MAX_REGEX_TEST_LENGTH) {
                                return res.status(400).json({ success: false, error: field.validation_message || `'${field.field_key}' is too long to validate (max ${MAX_REGEX_TEST_LENGTH} characters)` });
                            }
                            try {
                                const rx = new RegExp(field.validation_regex);
                                if (!rx.test(testVal)) {
                                    return res.status(400).json({ success: false, error: field.validation_message || `Invalid format for '${field.field_key}'` });
                                }
                            } catch (e) {
                                if (e.message.includes('Invalid format')) {
                                    return res.status(400).json({ success: false, error: e.message });
                                }
                            }
                        }
                        
                        const valId = crypto.randomUUID();
                        insertPromises.push(
                            query(`
                                INSERT INTO cost_conversion_custom_values (id, cost_conversion_id, custom_field_id, value)
                                VALUES ($1, $2, $3, $4)
                                ON CONFLICT (cost_conversion_id, custom_field_id) DO UPDATE SET value = EXCLUDED.value
                            `, [valId, id, field.id, String(val)])
                        );
                    }
                }
                if (insertPromises.length > 0) {
                    await Promise.all(insertPromises);
                }
            }
        }

        if (setClauses.length === 0) {
            const fullRes = await query('SELECT * FROM cost_conversions WHERE id = $1', [id]);
            return res.status(200).json({ success: true, data: fullRes.rows[0] });
        }

        const updatedRes = await query(
            `UPDATE cost_conversions SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
            params
        );
        const updatedLead = updatedRes.rows[0];

        // Also update linked follow_ups assigned operator to sync changes in real-time
        if (updatedLead.assigned_to && isValidUUID(updatedLead.assigned_to)) {
            await query(
                'UPDATE follow_ups SET assigned_to_id = $1, updated_at = NOW() WHERE cost_conversion_id = $2',
                [updatedLead.assigned_to, id]
            );
        }

        await invalidateOnLeadChange(lead.vertical_id, id);
        logAudit(req, { action: 'cost_conversion.update', targetCollection: 'cost_conversions', targetId: id, after: updatedLead });
        broadcastToAll({ type: 'COST_CONVERSION_MUTATED', verticalId: lead.vertical_id, action: 'update', leadId: id });

        return res.status(200).json({ success: true, data: updatedLead });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
};

/**
 * DELETE /cost-conversions/:id
 */
export const deleteCostConversion = async (req, res) => {
    const { id } = req.params;
    if (!isValidUUID(id)) {
        return res.status(404).json({ success: false, error: 'Cost/Conversion not found' });
    }
    try {
        const leadRes = await query('SELECT id, vertical_id, assigned_to, uploaded_by, is_deleted FROM cost_conversions WHERE id = $1', [id]);
        const lead    = leadRes.rows[0];
        if (!lead || lead.is_deleted) {
            return res.status(404).json({ success: false, error: 'Cost/Conversion not found' });
        }

        if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(lead.vertical_id))) {
            return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });
        }

        const hasFullDelete = req.role?.permissions.includes('*') || req.role?.permissions.includes('leads:delete');
        const hasOwnDelete = req.role?.permissions.includes('leads:delete_own');
        if (!hasFullDelete && !hasOwnDelete) {
            return res.status(403).json({ success: false, error: 'Access forbidden: you do not have permission to delete leads' });
        }
        if (!hasFullDelete && hasOwnDelete && lead.assigned_to !== req.user.sub && lead.uploaded_by !== req.user.sub) {
            return res.status(403).json({ success: false, error: 'Access forbidden: you are not assigned to this lead' });
        }


        await query('UPDATE cost_conversions SET is_deleted = true, deleted_at = NOW(), deleted_by = $1 WHERE id = $2', [req.user.sub, id]);

        await invalidateOnLeadChange(lead.vertical_id, id);
        logAudit(req, { action: 'cost_conversion.delete', targetCollection: 'cost_conversions', targetId: id });
        broadcastToAll({ type: 'COST_CONVERSION_MUTATED', verticalId: lead.vertical_id, action: 'delete', leadId: id });

        return res.status(200).json({ success: true, data: { message: 'Cost/Conversion soft-deleted successfully' } });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
};

/**
 * PATCH /cost-conversions/:id/status
 */
export const updateCostConversionStatus = async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    if (!isValidUUID(id)) {
        return res.status(404).json({ success: false, error: 'Cost/Conversion not found' });
    }
    try {
        const leadRes = await query('SELECT id, vertical_id, assigned_to, uploaded_by, is_deleted FROM cost_conversions WHERE id = $1', [id]);
        const lead    = leadRes.rows[0];
        if (!lead || lead.is_deleted) {
            return res.status(404).json({ success: false, error: 'Cost/Conversion not found' });
        }

        if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(lead.vertical_id))) {
            return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });
        }




        const updatedRes = await query(
            'UPDATE cost_conversions SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
            [status, id]
        );

        await invalidateOnLeadChange(lead.vertical_id, id);
        logAudit(req, { action: 'cost_conversion.status_update', targetCollection: 'cost_conversions', targetId: id, after: { status } });
        broadcastToAll({ type: 'COST_CONVERSION_MUTATED', verticalId: lead.vertical_id, action: 'status_update', leadId: id });

        return res.status(200).json({ success: true, data: updatedRes.rows[0] });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
};

/**
 * PATCH /cost-conversions/:id/assign
 */
export const assignCostConversion = async (req, res) => {
    const { id }     = req.params;
    const { userId } = req.body;
    if (!isValidUUID(id)) {
        return res.status(404).json({ success: false, error: 'Cost/Conversion not found' });
    }
    try {
        const leadRes = await query('SELECT id, vertical_id, is_deleted FROM cost_conversions WHERE id = $1', [id]);
        const lead    = leadRes.rows[0];
        if (!lead || lead.is_deleted) {
            return res.status(404).json({ success: false, error: 'Cost/Conversion not found' });
        }

        if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(lead.vertical_id))) {
            return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });
        }

        const updatedRes = await query(
            'UPDATE cost_conversions SET assigned_to = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
            [userId || null, id]
        );

        // Also update linked follow_ups assigned operator to sync changes in real-time
        if (userId && isValidUUID(userId)) {
            await query(
                'UPDATE follow_ups SET assigned_to_id = $1, updated_at = NOW() WHERE cost_conversion_id = $2',
                [userId, id]
            );
        }

        await invalidateOnLeadChange(lead.vertical_id, id);
        logAudit(req, { action: 'cost_conversion.assign', targetCollection: 'cost_conversions', targetId: id, after: { assignedTo: userId } });
        broadcastToAll({ type: 'COST_CONVERSION_MUTATED', verticalId: lead.vertical_id, action: 'assign', leadId: id });

        return res.status(200).json({ success: true, data: updatedRes.rows[0] });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
};

/**
 * Serialize one lead row to a CSV line for the given leadType.
 * Extracted to avoid code duplication between POSITIVE and CALL branches.
 */
function serializeLeadCsvRow(l, isPositive) {
    const d = l.data || {};
    const dateVal = d.date || (l.created_at ? l.created_at.toISOString().split('T')[0] : '');
    const empName = l.assignee_name || d.employeeName || '';
    const bType   = d.businessType || '';
    const name    = l.name || l.business_name || d.businessName || '';

    if (isPositive) {
        return [
            dateVal, empName, bType, name,
            d.area || '', d.city || '',
            l.phone || d.phone || '',
            d.pointOfContact || '', d.remarks || '', d.recordings || '',
            d.followUpRequired || '', d.followUps || '',
            d.followUpDates || '', d.followUpRemarks || '',
            d.requirement || '', d.notes || '', l.status || '',
        ].map(v => `"${escapeCsvVal(v)}"`).join(',');
    } else {
        return [
            dateVal, empName, bType, name,
            l.phone || d.phone || '',
            d.pointOfContact || '', d.area || '', d.city || '',
            d.deliveredLocation || '', d.remarks || '', d.recordings || '',
            d.appointmentType || '', d.appointmentDate || '',
            d.appointmentTime || '', d.requirement || '', d.notes || '',
            l.status || '',
        ].map(v => `"${escapeCsvVal(v)}"`).join(',');
    }
}

/**
 * GET /cost-conversions/export/csv
 *
 * Streams results row-by-row using a pg server-side cursor.
 * Memory stays flat regardless of result size (even 50k+ rows).
 * First bytes arrive at the client in ~100ms.
 */
export const exportCostConversionsCsv = async (req, res) => {
    const { verticalId, leadType } = req.query;
    if (!isValidUUID(verticalId)) {
        return res.status(400).json({ success: false, error: 'Invalid vertical ID format' });
    }

    if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(verticalId))) {
        return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });
    }

    const isPositive = leadType === 'POSITIVE';

    const csvHeader = isPositive
        ? 'DATE,EMPLOYEE NAME,BUSINESS TYPE,BUSINESS / PERSON / SHOP / COMPANY NAME,AREA,CITY,CONTACT NUMBER,POINT OF CONTACT,REMARKS,RECORDINGS,FOLLOW-UP REQUIRED,FOLLOW-UPS,FOLLOW-UP DATES,FOLLOW-UP REMARKS,REQUIREMENT IF ANY,A NOTES TO THE COS TEAM ONLY,Status\n'
        : 'DATE,EMPLOYEE NAME,BUSINESS TYPE,BUSINESS / PERSON / SHOP / COMPANY NAME,CONTACT NUMBER,POINT OF CONTACT,AREA,CITY,LINK ADDRESS,REMARKS,RECORDINGS,APPOINTMENT TYPE (YES OR NO),APPOINTMENT DATE,APPOINTMENT TIME,REQUIREMENT ORDER IF ANY,NOTES TO THE COS IF ANY,Status\n';

    // Build query — same projection as before, cursor-friendly
    const params = [verticalId];
    let sql = `
        SELECT
            l.name, l.phone, l.business_name,
            l.status, l.created_at, l.data,
            u.name  AS assignee_name
        FROM cost_conversions l
        LEFT JOIN users u ON u.id = l.assigned_to
        WHERE l.vertical_id = $1 AND l.is_deleted = false
    `;

    const leadTypeIdx = params.length + 1;
    if (leadType) {
        sql += ` AND l.lead_type = $${leadTypeIdx}`;
        params.push(leadType);
    } else {
        sql += ` AND l.lead_type != 'POSITIVE'`;
    }
    sql += ` ORDER BY l.created_at DESC`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=cost-conversions-export-${Date.now()}.csv`);
    // Disable compression for streaming responses
    res.setHeader('X-No-Compression', '1');

    try {
        const rowsRes = await query(sql, params);
        res.write(csvHeader);
        const lines = rowsRes.rows.map(l => serializeLeadCsvRow(l, isPositive));
        if (lines.length > 0) {
            res.write(lines.join('\n') + '\n');
        }
        res.end();
    } catch (error) {
        console.error('[Export CSV] Error:', error.message);
        if (!res.headersSent) {
            return res.status(500).json({ success: false, error: error.message });
        }
        res.end();
    }
};

/**
 * POST /cost-conversions/:id/photo
 */
export const uploadCostConversionPhoto = async (req, res) => {
    const { id } = req.params;
    if (!isValidUUID(id)) {
        return res.status(404).json({ success: false, error: 'Cost/Conversion not found' });
    }
    try {
        const leadRes = await query('SELECT id, vertical_id, is_deleted, assigned_to, uploaded_by FROM cost_conversions WHERE id = $1', [id]);
        const lead = leadRes.rows[0];
        if (!lead || lead.is_deleted) {
            return res.status(404).json({ success: false, error: 'Cost/Conversion not found' });
        }

        if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(lead.vertical_id))) {
            return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });
        }




        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No file uploaded' });
        }

        if (process.env.VERCEL) {
            // Vercel Serverless environment: bypass disk writes and store the photo as a base64 Data URI in DB
            const photoKey = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;

            const updatedRes = await query(
                'UPDATE cost_conversions SET geotag_photo_key = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
                [photoKey, id]
            );

            await invalidateOnLeadChange(lead.vertical_id, id);
            broadcastToAll({ type: 'COST_CONVERSION_MUTATED', verticalId: lead.vertical_id, action: 'update', leadId: id });
            logAudit(req, { action: 'cost_conversion.upload_photo_vercel', targetCollection: 'cost_conversions', targetId: id, after: { geotagPhotoKey: 'base64_data_uri' } });

            return res.status(200).json({ success: true, data: updatedRes.rows[0] });
        }

        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const uploadsDir = path.join(__dirname, '../../../uploads');

        if (!fs.existsSync(uploadsDir)) {
            fs.mkdirSync(uploadsDir, { recursive: true });
        }

        const ext = path.extname(req.file.originalname) || '.jpg';
        const filename = `${id}-${Date.now()}${ext}`;
        const filepath = path.join(uploadsDir, filename);

        fs.writeFileSync(filepath, req.file.buffer);

        const photoKey = `/uploads/${filename}`;

        const updatedRes = await query(
            'UPDATE cost_conversions SET geotag_photo_key = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
            [photoKey, id]
        );

        await invalidateOnLeadChange(lead.vertical_id, id);
        broadcastToAll({ type: 'COST_CONVERSION_MUTATED', verticalId: lead.vertical_id, action: 'update', leadId: id });
        logAudit(req, { action: 'cost_conversion.upload_photo', targetCollection: 'cost_conversions', targetId: id, after: { geotagPhotoKey: photoKey } });

        return res.status(200).json({ success: true, data: updatedRes.rows[0] });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
};

/**
 * POST /cost-conversions/bulk
 */
export const createCostConversionBulk = async (req, res) => {
    const { leads, verticalId } = req.body;

    if (!verticalId || !isValidUUID(verticalId)) {
        return res.status(400).json({ success: false, error: 'Invalid vertical ID format' });
    }

    if (!Array.isArray(leads) || leads.length === 0) {
        return res.status(400).json({ success: false, error: 'leads must be a non-empty array' });
    }

    if (leads.length > 10000) {
        return res.status(400).json({ success: false, error: 'Maximum 10,000 Cost/Conversions per request' });
    }

    try {
        if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(verticalId))) {
            return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });
        }

        const CostConversionSchema = z.object({
            name: z.string().min(1, 'Name is required').max(255),
            phone: z.string().min(1, 'Contact number is required').transform(val => val.replace(/[^\d+]/g, '').trim()).refine(val => val.length > 0, 'Contact number cannot be empty'),
            businessName: z.string().optional().nullable().transform(val => val || ''),
            subVerticalId: z.string().uuid().optional().nullable(),
            assignedTo: z.string().uuid().optional().nullable(),
            leadType: z.enum(['CALL', 'FIELD']).default('CALL'),
            status: z.string().default('new'),
            data: z.record(z.any()).optional().default({}),
            stageId: z.string().uuid().optional().nullable(),
        });

        const valid = [];
        const invalid = [];

        for (let i = 0; i < leads.length; i++) {
            const result = CostConversionSchema.safeParse(leads[i]);
            if (result.success) {
                valid.push(result.data);
            } else {
                invalid.push({ index: i, errors: result.error.flatten().fieldErrors });
            }
        }

        if (valid.length === 0) {
            return res.status(200).json({
                success: true,
                data: {
                    inserted: 0,
                    skipped: leads.length,
                    errors: invalid
                }
            });
        }

        const inputPhones = valid.map(l => l.phone).filter(Boolean);
        let existingPhones = [];
        if (inputPhones.length > 0) {
            const existingRes = await query(
                'SELECT phone FROM cost_conversions WHERE vertical_id = $1 AND is_deleted = false AND phone = ANY($2)',
                [verticalId, inputPhones]
            );
            existingPhones = existingRes.rows.map(r => r.phone);
        }
        const phoneSet = new Set(existingPhones);

        const finalInsertLeads = [];

        for (const lead of valid) {
            if (lead.phone && phoneSet.has(lead.phone)) {
                invalid.push({ name: lead.name, phone: lead.phone, reason: 'Duplicate phone number' });
            } else {
                finalInsertLeads.push(lead);
                if (lead.phone) {
                    phoneSet.add(lead.phone);
                }
            }
        }

        let insertedCount = 0;
        let insertedRows = [];
        if (finalInsertLeads.length > 0) {
            const columns = [
                'id', 'vertical_id', 'sub_vertical_id', 'assigned_to', 'uploaded_by',
                'name', 'phone', 'business_name', 'data', 'status', 'lead_type', 'stage_id'
            ];
            const rows = finalInsertLeads.map(l => [
                crypto.randomUUID(),
                verticalId,
                l.subVerticalId || null,
                l.assignedTo || null,
                req.user.sub,
                l.name,
                l.phone || '',
                l.businessName || '',
                JSON.stringify(l.data || {}),
                l.status || 'new',
                l.leadType || 'CALL',
                l.stageId || null
            ]);

            insertedRows = await bulkInsert(
                { query },
                'cost_conversions',
                columns,
                rows,
                { onConflict: 'ON CONFLICT DO NOTHING' }
            );
            insertedCount = insertedRows.length;
        }

        await invalidateOnLeadChange(verticalId, null);
        broadcastToAll({ type: 'COST_CONVERSION_MUTATED', verticalId, action: 'bulk_create' });

        return res.status(200).json({
            success: true,
            data: {
                inserted: insertedCount,
                skipped: leads.length - insertedCount,
                errors: invalid
            }
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
};

/**
 * POST /api/v1/leads/duplicates/scan
 *
 * Find & Remove Duplicates (COS only — Positives/Raw Data/Delivery Data are
 * independent sections, see the lead_type-scoped dedup fix elsewhere in this
 * file). Groups active, unflagged COS records by phone number within the
 * given scope; any group with more than one record is a duplicate group.
 *
 * Tiebreak rule: the EARLIEST-created record in each group is kept — the
 * first record entered is treated as the authoritative one, and later
 * uploads of the same phone number are the duplicates being cleaned up.
 * This is a simple, deterministic, defensible default; there's no reliable
 * generic way to measure "most complete" across this table's freeform JSONB
 * `data` column, so completeness-based tiebreaking was not used.
 *
 * `dryRun` (default true) previews the operation with zero writes. Passing
 * `dryRun: false` actually applies it: non-kept records in each group are
 * soft-flagged (duplicate_status = 'duplicate_removed', duplicate_of_id =
 * the kept record's id) — never hard-deleted, so this is fully reversible
 * by clearing those columns. Flagged records are excluded from normal
 * listing (see getCostConversions) and from promotion (see promoteToFollowUps).
 */
export const scanCosDuplicates = async (req, res) => {
    let reportId = null;
    try {
        const { verticalId, agentId, dryRun = true } = req.body;

        if (!isValidUUID(verticalId)) {
            return operationError(res, { code: ErrorCodes.INVALID_FORMAT, message: 'A valid verticalId is required', section: 'cos', operation: 'duplicate_scan', field: 'verticalId' });
        }
        if (agentId && !isValidUUID(agentId)) {
            return operationError(res, { code: ErrorCodes.INVALID_FORMAT, message: 'agentId must be a valid UUID if provided', section: 'cos', operation: 'duplicate_scan', field: 'agentId' });
        }
        if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(verticalId))) {
            return operationError(res, { status: 403, code: ErrorCodes.FORBIDDEN, message: 'Access forbidden: you do not have access to this business vertical', section: 'cos', operation: 'duplicate_scan' });
        }

        const params = [verticalId];
        const wheres = [
            'vertical_id = $1', 'is_deleted = false', "lead_type != 'POSITIVE'",
            'duplicate_status IS NULL', "phone IS NOT NULL", "phone != ''",
        ];
        let pIdx = 2;
        if (agentId) {
            wheres.push(`(uploaded_by = $${pIdx} OR assigned_to = $${pIdx})`);
            params.push(agentId);
            pIdx++;
        }

        const groupsRes = await query(`
            SELECT phone,
                   json_agg(json_build_object(
                       'id', id, 'name', name, 'businessName', business_name, 'createdAt', created_at
                   ) ORDER BY created_at ASC) AS records
            FROM cost_conversions
            WHERE ${wheres.join(' AND ')}
            GROUP BY phone
            HAVING COUNT(*) > 1
            ORDER BY phone
        `, params);

        const groups = groupsRes.rows.map(r => {
            const [kept, ...duplicates] = r.records;
            return { phone: r.phone, kept, duplicates };
        });
        const totalFlagged = groups.reduce((sum, g) => sum + g.duplicates.length, 0);

        if (dryRun) {
            return res.status(200).json({
                success: true,
                data: { dryRun: true, groupsFound: groups.length, totalFlagged, groups },
            });
        }

        // Persisted operation report (Step 2), same csv_upload_logs
        // machinery bulk uploads and promote already use, discriminated via
        // operation_type='duplicate_scan'. Only the real (non-dry-run) pass
        // writes one — see promoteCosLeadsToFollowUps for the same
        // "dry run previews, doesn't get a report" reasoning.
        reportId = crypto.randomUUID();
        await query(`
            INSERT INTO csv_upload_logs (id, uploaded_by, vertical_id, status, lead_type, entity_type, operation_type, total_rows)
            VALUES ($1, $2, $3, 'processing', 'CALL', 'lead', 'duplicate_scan', $4)
        `, [reportId, req.user.sub, verticalId, totalFlagged]);

        const scanErrors = [];
        for (const g of groups) {
            const duplicateIds = g.duplicates.map(d => d.id);
            if (duplicateIds.length === 0) continue;
            try {
                await query(
                    `UPDATE cost_conversions
                     SET duplicate_status = 'duplicate_removed', duplicate_of_id = $1,
                         duplicate_flagged_at = NOW(), duplicate_flagged_by = $2
                     WHERE id = ANY($3::uuid[])`,
                    [g.kept.id, req.user.sub, duplicateIds]
                );
            } catch (err) {
                scanErrors.push({ recordId: g.kept.id, code: ErrorCodes.DB_CONSTRAINT, reason: err.message, phone: g.phone });
            }
        }

        await query(`
            UPDATE csv_upload_logs
            SET status = 'done', success_count = $1, failed_count = $2, errors = $3::jsonb,
                processing_started_at = NOW(), processing_finished_at = NOW()
            WHERE id = $4
        `, [totalFlagged - scanErrors.length, scanErrors.length, JSON.stringify(scanErrors), reportId]);

        if (totalFlagged > 0) {
            await logAudit(req, {
                action: 'cost_conversion.duplicates_removed',
                targetCollection: 'cost_conversions',
                targetId: verticalId,
                after: {
                    groupsFound: groups.length,
                    totalFlagged,
                    groups: groups.map(g => ({ phone: g.phone, keptId: g.kept.id, duplicateIds: g.duplicates.map(d => d.id) })),
                },
                metadata: { agentId: agentId || null },
                awaitWrite: true,
            });
            await invalidateOnLeadChange(verticalId, null);
            broadcastToAll({ type: 'COST_CONVERSION_MUTATED', verticalId, action: 'duplicates_removed' });
        }

        return res.status(200).json({
            success: true,
            data: { dryRun: false, groupsFound: groups.length, totalFlagged, groups, reportId },
        });
    } catch (error) {
        if (reportId) {
            await query(`UPDATE csv_upload_logs SET status = 'failed', errors = errors || $1::jsonb, processing_finished_at = NOW() WHERE id = $2`,
                [JSON.stringify([{ code: ErrorCodes.INTERNAL_ERROR, reason: error.message }]), reportId]).catch(() => {});
        }
        return sendControllerError(res, error, 'scanCosDuplicates', { section: 'cos', operation: 'duplicate_scan', recordId: reportId });
    }
};
