import { query } from '../config/db.js';
import pool from '../config/db.js';
import crypto from 'crypto';
import { logAudit } from '../services/audit.js';
import { broadcastToAll } from '../services/assignmentBroadcaster.js';
import { cacheGet, cacheSet, cacheDelete, cacheDeletePattern } from '../services/cache.js';
import { isValidUUID } from '../utils/validators/index.js';
import { sendControllerError } from '../utils/dbErrors.js';
import { operationError, ErrorCodes } from '../utils/operationError.js';

/**
 * GET /cost-conversions/:costConversionId/follow-ups
 */
export const getFollowUps = async (req, res) => {
  const { costConversionId } = req.params;
  const { status, assignedTo, from, to, search, sortBy = 'follow_up_date', sortDir = 'desc' } = req.query;
  try {
    // Check if cost conversion exists and get vertical scoping
    const costConversionRes = await query('SELECT vertical_id, assigned_to FROM cost_conversions WHERE id = $1 AND is_deleted = false', [costConversionId]);
    const costConversion = costConversionRes.rows[0];
    if (!costConversion) {
      return res.status(404).json({ success: false, error: 'Cost/Conversion not found' });
    }

    // Scoping check
    if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(costConversion.vertical_id))) {
      return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });
    }
    let sql = `
      SELECT f.*, 
             u_assign.name as assigned_to_name, u_assign.email as assigned_to_email,
             u_creator.name as creator_name, u_creator.email as creator_email
      FROM follow_ups f
      JOIN users u_assign ON f.assigned_to_id = u_assign.id
      JOIN users u_creator ON f.created_by_id = u_creator.id
      WHERE f.cost_conversion_id = $1
    `;
    const params = [costConversionId];
    let pIdx = 2;

    if (status) {
      sql += ` AND f.status = $${pIdx++}`;
      params.push(status);
    }
    
    const targetAssigned = assignedTo;
    if (targetAssigned && isValidUUID(targetAssigned)) {
      sql += ` AND f.assigned_to_id = $${pIdx++}`;
      params.push(targetAssigned);
    }
    if (from) {
      sql += ` AND f.follow_up_date >= $${pIdx++}`;
      params.push(from);
    }
    if (to) {
      sql += ` AND f.follow_up_date <= $${pIdx++}`;
      params.push(to);
    }
    if (search) {
      sql += ` AND (u_assign.name ILIKE $${pIdx} OR u_assign.email ILIKE $${pIdx})`;
      params.push(`%${search}%`);
      pIdx++;
    }

    const orderCol = sortBy === 'followUpDate' ? 'follow_up_date' : 'follow_up_date';
    const orderDir = sortDir === 'asc' ? 'ASC' : 'DESC';
    sql += ` ORDER BY f.${orderCol} ${orderDir}`;

    const result = await query(sql, params);
    return res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    return sendControllerError(res, error, 'getFollowUps', { section: 'follow_ups', operation: 'get_follow_ups' });
  }
};

/**
 * POST /cost-conversions/:costConversionId/follow-ups
 */
export const createFollowUp = async (req, res) => {
  const { costConversionId } = req.params;
  const { assignedToId, followUpDate, description, status = 'PENDING' } = req.body;

  if (!assignedToId || !followUpDate || !description) {
    return res.status(400).json({ success: false, error: 'assignedToId, followUpDate, and description are required' });
  }

  try {
    // Check if cost conversion exists and get sub_vertical_id
    const costConversionRes = await query('SELECT sub_vertical_id, vertical_id, assigned_to, business_name FROM cost_conversions WHERE id = $1 AND is_deleted = false', [costConversionId]);
    const costConversion = costConversionRes.rows[0];
    if (!costConversion) {
      return res.status(404).json({ success: false, error: 'Cost/Conversion not found' });
    }

    // Scoping check
    if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(costConversion.vertical_id))) {
      return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });
    }


    const subVerticalId = costConversion.sub_vertical_id;
    if (!subVerticalId) {
      return res.status(400).json({ success: false, error: 'Cost/Conversion must be assigned to a sub-vertical before creating follow-ups' });
    }

    const id = crypto.randomUUID();
    const insertRes = await query(`
      INSERT INTO follow_ups (id, cost_conversion_id, sub_vertical_id, assigned_to_id, created_by_id, follow_up_date, description, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [id, costConversionId, subVerticalId, assignedToId, req.user.sub, followUpDate, description, status]);

    const newFollowUp = insertRes.rows[0];

    await logAudit(req, {
      action: 'FOLLOWUP_CREATED',
      targetCollection: 'follow_ups',
      targetId: newFollowUp.id,
      entityLabel: costConversion.business_name,
      after: newFollowUp
    });

    // Invalidate calendar cache
    await cacheDeletePattern('calendar:*');

    // Notify clients of cost conversion mutation to trigger refresh
    broadcastToAll({ type: 'COST_CONVERSION_MUTATED', verticalId: costConversion.vertical_id, action: 'followup_create', costConversionId });

    return res.status(201).json({ success: true, data: newFollowUp });
  } catch (error) {
    return sendControllerError(res, error, 'createFollowUp', { section: 'follow_ups', operation: 'create_follow_up' });
  }
};

/**
 * PUT /follow-ups/:id
 */
export const updateFollowUp = async (req, res) => {
  const { id } = req.params;
  const { assignedToId, followUpDate, description, status, completedNote } = req.body;

  try {
    const followUpRes = await query('SELECT * FROM follow_ups WHERE id = $1', [id]);
    const followUp = followUpRes.rows[0];
    if (!followUp) {
      return res.status(404).json({ success: false, error: 'Follow-up not found' });
    }

    // Get cost conversion vertical_id and assigned operator
    const costConversionRes = await query('SELECT vertical_id, assigned_to, business_name FROM cost_conversions WHERE id = $1', [followUp.cost_conversion_id]);
    const costConversion = costConversionRes.rows[0];

    // Scoping check
    if (costConversion) {
      if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(costConversion.vertical_id))) {
        return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });
      }

    }

    const before = { ...followUp };
    const updates = [];
    const params = [id];
    let pIdx = 2;

    if (assignedToId) {
      updates.push(`assigned_to_id = $${pIdx++}`);
      params.push(assignedToId);
    }
    if (followUpDate) {
      updates.push(`follow_up_date = $${pIdx++}`);
      params.push(followUpDate);
    }
    if (description) {
      updates.push(`description = $${pIdx++}`);
      params.push(description);
    }
    if (status) {
      updates.push(`status = $${pIdx++}`);
      params.push(status);

      if (status === 'COMPLETED' && before.status !== 'COMPLETED') {
        updates.push(`completed_at = NOW()`);
      }
    }
    if (completedNote !== undefined) {
      updates.push(`completed_note = $${pIdx++}`);
      params.push(completedNote);
    }

    if (updates.length === 0) {
      return res.status(200).json({ success: true, data: followUp });
    }

    const updateRes = await query(`
      UPDATE follow_ups 
      SET ${updates.join(', ')}, updated_at = NOW() 
      WHERE id = $1 
      RETURNING *
    `, params);

    const updated = updateRes.rows[0];

    // Optional: Schedule NEXT follow-up automatically if details provided
    const { nextFollowUpDate, nextFollowUpDesc } = req.body;
    if (status === 'COMPLETED' && nextFollowUpDate && nextFollowUpDesc) {
      try {
        const nextId = crypto.randomUUID();
        await query(`
          INSERT INTO follow_ups (id, cost_conversion_id, sub_vertical_id, assigned_to_id, created_by_id, follow_up_date, description, status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING')
        `, [
          nextId, 
          followUp.cost_conversion_id, 
          followUp.sub_vertical_id, 
          followUp.assigned_to_id, 
          req.user.sub, 
          nextFollowUpDate, 
          nextFollowUpDesc
        ]);
      } catch (nextErr) {
        console.error('Failed to auto-schedule next follow-up:', nextErr);
      }
    }

    await logAudit(req, {
      action: status === 'COMPLETED' ? 'FOLLOWUP_COMPLETED' : 'FOLLOWUP_UPDATED',
      targetCollection: 'follow_ups',
      targetId: id,
      entityLabel: costConversion?.business_name,
      before,
      after: updated
    });

    // Invalidate calendar cache
    await cacheDeletePattern('calendar:*');

    // Notify clients of cost conversion mutation to trigger refresh
    if (costConversion) {
      broadcastToAll({ type: 'COST_CONVERSION_MUTATED', verticalId: costConversion.vertical_id, action: 'followup_update', costConversionId: followUp.cost_conversion_id });
    }

    return res.status(200).json({ success: true, data: updated });
  } catch (error) {
    return sendControllerError(res, error, 'updateFollowUp', { section: 'follow_ups', operation: 'update_follow_up', recordId: id });
  }
};

/**
 * DELETE /follow-ups/:id
 */
export const deleteFollowUp = async (req, res) => {
  const { id } = req.params;
  try {
    const followUpRes = await query('SELECT * FROM follow_ups WHERE id = $1', [id]);
    const followUp = followUpRes.rows[0];
    if (!followUp) {
      return res.status(404).json({ success: false, error: 'Follow-up not found' });
    }

    const costConversionRes = await query('SELECT vertical_id, assigned_to, business_name FROM cost_conversions WHERE id = $1', [followUp.cost_conversion_id]);
    const costConversion = costConversionRes.rows[0];

    // Scoping check
    if (costConversion) {
      if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(costConversion.vertical_id))) {
        return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });
      }

    }

    await query('DELETE FROM follow_ups WHERE id = $1', [id]);

    await logAudit(req, {
      action: 'FOLLOWUP_DELETED',
      targetCollection: 'follow_ups',
      targetId: id,
      entityLabel: costConversion?.business_name,
      before: followUp
    });

    // Invalidate calendar cache
    await cacheDeletePattern('calendar:*');

    // Notify clients of cost/conversion mutation to trigger refresh
    if (costConversion) {
      broadcastToAll({ type: 'COST_CONVERSION_MUTATED', verticalId: costConversion.vertical_id, action: 'followup_delete', costConversionId: followUp.cost_conversion_id });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    return sendControllerError(res, error, 'deleteFollowUp', { section: 'follow_ups', operation: 'delete_follow_up', recordId: id });
  }
};

/**
 * GET /cost-conversions/:costConversionId/follow-ups/summary
 */
export const getFollowUpSummary = async (req, res) => {
  const { costConversionId } = req.params;
  try {
    const costConversionRes = await query('SELECT vertical_id, assigned_to, uploaded_by FROM cost_conversions WHERE id = $1 AND is_deleted = false', [costConversionId]);
    const costConversion = costConversionRes.rows[0];
    if (!costConversion) {
      return res.status(404).json({ success: false, error: 'Cost/Conversion not found' });
    }

    // Scoping check
    if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(costConversion.vertical_id))) {
      return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });
    }

    const hasFullRead = req.role?.permissions.includes('*') || req.role?.permissions.includes('leads:read');
    if (!hasFullRead && req.role?.permissions.includes('leads:read_own') && costConversion.assigned_to !== req.user.sub && costConversion.uploaded_by !== req.user.sub) {
      return res.status(403).json({ success: false, error: 'Access forbidden: you are not assigned to this lead' });
    }


    const [pendingRes, totalRes, nextRes] = await Promise.all([
      query(`SELECT COUNT(*)::int as count FROM follow_ups WHERE cost_conversion_id = $1 AND status = 'PENDING'`, [costConversionId]),
      query(`SELECT COUNT(*)::int as count FROM follow_ups WHERE cost_conversion_id = $1`, [costConversionId]),
      query(`
        SELECT f.*, u.name as assigned_to_name 
        FROM follow_ups f 
        JOIN users u ON f.assigned_to_id = u.id 
        WHERE f.cost_conversion_id = $1 AND f.status = 'PENDING' 
        ORDER BY f.follow_up_date ASC 
        LIMIT 1
      `, [costConversionId])
    ]);

    return res.status(200).json({
      success: true,
      data: {
        pending: pendingRes.rows[0].count,
        total: totalRes.rows[0].count,
        nextFollowUp: nextRes.rows[0] || null
      }
    });
  } catch (error) {
    return sendControllerError(res, error, 'getFollowUpSummary', { section: 'follow_ups', operation: 'get_follow_up_summary' });
  }
};

/**
 * GET /verticals/:verticalId/follow-ups/calendar
 */
export const getCalendarGrid = async (req, res) => {
  const { verticalId } = req.params;
  const { year, month, assignedTo, subVerticalId } = req.query;

  if (!year || !month) {
    return res.status(400).json({ success: false, error: 'year and month are required' });
  }

  // Scoping check
  if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(verticalId))) {
    return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });
  }

  const targetAssigned = assignedTo;

  const cacheKey = `calendar:${verticalId}:${year}-${month}:${targetAssigned || 'all'}:${subVerticalId || 'all'}`;

  try {
    // Check Cache
    const cached = await cacheGet(cacheKey);
    if (cached) {
      return res.status(200).json({ success: true, data: cached });
    }

    // Build date bounds
    const formattedMonth = String(month).padStart(2, '0');
    const startOfMonth = `${year}-${formattedMonth}-01`;

    let sql = `
      SELECT
        f.id,
        f.status,
        f.description,
        f.follow_up_date,
        l.name AS lead_name,
        l.business_name AS lead_business,
        DATE(f.follow_up_date AT TIME ZONE 'Asia/Kolkata')::text AS date
      FROM follow_ups f
      JOIN sub_verticals sv ON f.sub_vertical_id = sv.id
      LEFT JOIN cost_conversions l ON f.cost_conversion_id = l.id
      WHERE sv.vertical_id = $1
        AND DATE_TRUNC('month', f.follow_up_date) = DATE_TRUNC('month', $2::date)
    `;
    const params = [verticalId, startOfMonth];
    let pIdx = 3;

    const hasFullRead = req.role?.permissions.includes('*') || req.role?.permissions.includes('leads:read');
    if (!hasFullRead && req.role?.permissions.includes('leads:read_own')) {
      sql += ` AND (f.assigned_to_id = $${pIdx} OR l.assigned_to = $${pIdx} OR l.uploaded_by = $${pIdx})`;
      params.push(req.user.sub);
      pIdx++;
    }

    if (targetAssigned && isValidUUID(targetAssigned)) {
      sql += ` AND f.assigned_to_id = $${pIdx++}`;
      params.push(targetAssigned);
    }
    if (subVerticalId) {
      sql += ` AND f.sub_vertical_id = $${pIdx++}`;
      params.push(subVerticalId);
    }

    sql += ` ORDER BY f.follow_up_date ASC`;

    const result = await query(sql, params);
    
    // Group by date: { [dateStr: string]: { pending, completed, missed, total, items: [...] } }
    const calendar = {};
    result.rows.forEach(r => {
      const dateStr = r.date;
      if (!calendar[dateStr]) {
        calendar[dateStr] = {
          pending: 0,
          completed: 0,
          missed: 0,
          total: 0,
          items: []
        };
      }
      calendar[dateStr].total++;
      if (r.status === 'PENDING') calendar[dateStr].pending++;
      else if (r.status === 'COMPLETED') calendar[dateStr].completed++;
      else if (r.status === 'MISSED') calendar[dateStr].missed++;
      
      calendar[dateStr].items.push({
        id: r.id,
        status: r.status,
        description: r.description,
        leadName: r.lead_name,
        leadBusiness: r.lead_business,
        followUpDate: r.follow_up_date
      });
    });

    // Save to Cache (2 minutes TTL)
    await cacheSet(cacheKey, calendar, 120);

    return res.status(200).json({ success: true, data: calendar });
  } catch (error) {
    return sendControllerError(res, error, 'getCalendarGrid', { section: 'follow_ups', operation: 'get_calendar_grid' });
  }
};

/**
 * GET /verticals/:verticalId/follow-ups/by-date
 */
export const getCalendarFollowUpsByDate = async (req, res) => {
  const { verticalId } = req.params;
  const { date, assignedTo, subVerticalId } = req.query;

  if (!date) {
    return res.status(400).json({ success: false, error: 'date query parameter is required' });
  }

  // Scoping check
  if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(verticalId))) {
    return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });
  }

  const targetAssigned = assignedTo;

  try {
    let sql = `
      SELECT f.*, 
             l.name as lead_name, l.business_name as lead_business,
             u_assign.name as assigned_to_name, u_assign.email as assigned_to_email,
             u_creator.name as creator_name, u_creator.email as creator_email,
             sv.name as sub_vertical_name
      FROM follow_ups f
      JOIN cost_conversions l ON f.cost_conversion_id = l.id
      JOIN users u_assign ON f.assigned_to_id = u_assign.id
      JOIN users u_creator ON f.created_by_id = u_creator.id
      JOIN sub_verticals sv ON f.sub_vertical_id = sv.id
      WHERE sv.vertical_id = $1
        AND DATE(f.follow_up_date AT TIME ZONE 'Asia/Kolkata') = $2::date
    `;
    const params = [verticalId, date];
    let pIdx = 3;

    const hasFullRead = req.role?.permissions.includes('*') || req.role?.permissions.includes('leads:read');
    if (!hasFullRead && req.role?.permissions.includes('leads:read_own')) {
      sql += ` AND (f.assigned_to_id = $${pIdx} OR l.assigned_to = $${pIdx} OR l.uploaded_by = $${pIdx})`;
      params.push(req.user.sub);
      pIdx++;
    }

    if (targetAssigned && isValidUUID(targetAssigned)) {
      sql += ` AND f.assigned_to_id = $${pIdx++}`;
      params.push(targetAssigned);
    }
    if (subVerticalId) {
      sql += ` AND f.sub_vertical_id = $${pIdx++}`;
      params.push(subVerticalId);
    }

    sql += ` ORDER BY f.follow_up_date ASC`;

    const result = await query(sql, params);
    return res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    return sendControllerError(res, error, 'getCalendarFollowUpsByDate', { section: 'follow_ups', operation: 'get_calendar_by_date' });
  }
};

/**
 * GET /verticals/:verticalId/follow-ups/stats
 */
export const getFollowUpVerticalStats = async (req, res) => {
  const { verticalId } = req.params;
  const { subVerticalId, date } = req.query;

  // Scoping check
  if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(verticalId))) {
    return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });
  }

  try {
    const targetDate = date || new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
    
    const hasFullRead = req.role?.permissions.includes('*') || req.role?.permissions.includes('leads:read');
    
    let sql = `
      SELECT 
        COUNT(*)::int AS all_total,
        COUNT(*) FILTER (WHERE f.status = 'PENDING')::int AS all_pending,
        COUNT(*) FILTER (WHERE f.status = 'COMPLETED')::int AS all_completed,
        COUNT(*) FILTER (WHERE f.status = 'MISSED')::int AS all_missed,
        
        COUNT(*) FILTER (WHERE DATE(f.follow_up_date AT TIME ZONE 'Asia/Kolkata') = $2::date)::int AS daily_total,
        COUNT(*) FILTER (WHERE f.status = 'PENDING' AND DATE(f.follow_up_date AT TIME ZONE 'Asia/Kolkata') = $2::date)::int AS daily_pending,
        COUNT(*) FILTER (WHERE f.status = 'COMPLETED' AND DATE(f.follow_up_date AT TIME ZONE 'Asia/Kolkata') = $2::date)::int AS daily_completed,
        COUNT(*) FILTER (WHERE f.status = 'MISSED' AND DATE(f.follow_up_date AT TIME ZONE 'Asia/Kolkata') = $2::date)::int AS daily_missed
      FROM follow_ups f
      JOIN sub_verticals sv ON f.sub_vertical_id = sv.id
    `;
    if (!hasFullRead && req.role?.permissions.includes('leads:read_own')) {
      sql += ` LEFT JOIN cost_conversions l ON f.cost_conversion_id = l.id `;
    }
    sql += ` WHERE sv.vertical_id = $1 `;
    
    const params = [verticalId, targetDate];
    let pIdx = 3;
    
    if (!hasFullRead && req.role?.permissions.includes('leads:read_own')) {
      sql += ` AND (f.assigned_to_id = $${pIdx} OR l.assigned_to = $${pIdx} OR l.uploaded_by = $${pIdx})`;
      params.push(req.user.sub);
      pIdx++;
    }

    if (subVerticalId) {
      sql += ` AND f.sub_vertical_id = $${pIdx++}`;
      params.push(subVerticalId);
    }

    const result = await query(sql, params);
    const row = result.rows[0] || {};

    return res.status(200).json({
      success: true,
      data: {
        daily: {
          total: row.daily_total || 0,
          pending: row.daily_pending || 0,
          completed: row.daily_completed || 0,
          missed: row.daily_missed || 0
        },
        allTime: {
          total: row.all_total || 0,
          pending: row.all_pending || 0,
          completed: row.all_completed || 0,
          missed: row.all_missed || 0
        }
      }
    });
  } catch (error) {
    return sendControllerError(res, error, 'getFollowUpVerticalStats', { section: 'follow_ups', operation: 'get_follow_up_stats' });
  }
};

/**
 * POST /api/v1/followUps/promote-to-follow-ups
 *
 * Bulk "Promote to Follow-ups": for each matching COS record, creates a
 * linked follow_ups row (cost_conversion_id references the source lead —
 * this is a genuinely separate table/entity, not a mutation of the COS
 * row itself, and is distinct from the duplicate-flagging in
 * scanCosDuplicates, a different operation entirely).
 *
 * Required follow_ups fields, for a record being promoted automatically
 * rather than scheduled by a human one at a time:
 *   - assigned_to_id: carried over from the source lead's own assigned_to;
 *     falls back to the promoting user if the lead has no assignee.
 *   - follow_up_date: today.
 *   - description: an auto-generated, clearly system-labeled note
 *     referencing the source lead's business name.
 *
 * Idempotent: a COS record that already has a linked follow_ups row is
 * skipped and reported, never double-created. Records flagged
 * duplicate_status='duplicate_removed' (see scanCosDuplicates) are
 * automatically excluded — dedupe first, promote second.
 *
 * `dryRun` (default true) previews counts with zero writes.
 */
export const promoteCosLeadsToFollowUps = async (req, res) => {
  const { verticalId, agentId, costConversionIds, dryRun = true } = req.body;
  let reportId = null;
  try {
    if (!isValidUUID(verticalId)) {
      return operationError(res, { code: ErrorCodes.INVALID_FORMAT, message: 'A valid verticalId is required', section: 'cos', operation: 'promote', field: 'verticalId' });
    }
    if (agentId && !isValidUUID(agentId)) {
      return operationError(res, { code: ErrorCodes.INVALID_FORMAT, message: 'agentId must be a valid UUID if provided', section: 'cos', operation: 'promote', field: 'agentId' });
    }
    if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(verticalId))) {
      return operationError(res, { status: 403, code: ErrorCodes.FORBIDDEN, message: 'Access forbidden: you do not have access to this business vertical', section: 'cos', operation: 'promote' });
    }

    const scopeWheres = ['c.vertical_id = $1', 'c.is_deleted = false', "c.lead_type != 'POSITIVE'"];
    const scopeParams = [verticalId];
    let pIdx = 2;
    if (agentId) {
      scopeWheres.push(`(c.uploaded_by = $${pIdx} OR c.assigned_to = $${pIdx})`);
      scopeParams.push(agentId);
      pIdx++;
    }
    if (Array.isArray(costConversionIds) && costConversionIds.length > 0) {
      scopeWheres.push(`c.id = ANY($${pIdx}::uuid[])`);
      scopeParams.push(costConversionIds);
      pIdx++;
    }

    // Count duplicate-flagged records separately for reporting — they are
    // excluded from promotion entirely (both full and soft-removal paths).
    const dupCountRes = await query(
      `SELECT COUNT(*) FROM cost_conversions c WHERE ${scopeWheres.join(' AND ')} AND c.duplicate_status = 'duplicate_removed'`,
      scopeParams
    );
    const skippedDuplicate = parseInt(dupCountRes.rows[0].count, 10);

    // Fetch all non-duplicate candidates with their current promotion state.
    // Three idempotency paths per record:
    //   already_removed   — duplicate_status = 'promoted_removed' → skip entirely
    //   linked_not_removed — has a follow_up but NOT soft-removed yet → soft-remove only
    //   needs_full_promote — no follow_up, not removed → full atomic create + remove
    const candidatesRes = await query(`
      SELECT c.id, c.business_name, c.phone, c.name, c.data, c.status,
             c.assigned_to, c.sub_vertical_id, c.vertical_id, c.duplicate_status,
             c.promoted_at,
             f.id AS existing_follow_up_id
      FROM cost_conversions c
      LEFT JOIN follow_ups f ON f.cost_conversion_id = c.id
      WHERE ${scopeWheres.join(' AND ')}
        AND (c.duplicate_status IS NULL OR c.duplicate_status != 'duplicate_removed')
    `, scopeParams);

    const alreadyRemoved = [];
    const linkedNotRemoved = [];
    const needsFullPromote = [];
    let skippedNoSubVertical = 0;

    for (const row of candidatesRes.rows) {
      if (row.duplicate_status === 'promoted_removed') {
        alreadyRemoved.push(row);
        continue;
      }
      if (!row.sub_vertical_id) {
        skippedNoSubVertical++;
        continue;
      }
      if (row.existing_follow_up_id) {
        linkedNotRemoved.push(row); // follow_up exists, COS not yet soft-removed
      } else {
        needsFullPromote.push(row); // no follow_up at all — needs full create+remove
      }
    }

    if (dryRun) {
      return res.status(200).json({
        success: true,
        data: {
          dryRun: true,
          wouldFullyPromote: needsFullPromote.length,
          wouldSoftRemoveOnly: linkedNotRemoved.length,
          alreadyPromotedAndRemoved: alreadyRemoved.length,
          skippedDuplicate,
          skippedNoSubVertical,
        },
      });
    }

    let promoted = 0;       // full create+remove
    let softRemovedOnly = 0; // soft-remove only (follow_up already existed)
    let failed = 0;
    const errors = [];
    const today = new Date().toISOString().slice(0, 10);
    const promotedIds = [];
    const softRemovedIds = [];

    // Persisted operation report (Step 2): reuses csv_upload_logs — the same
    // table/download machinery bulk CSV uploads already have — discriminated
    // via operation_type='promote'. Only real (non-dry-run) runs write one:
    // a dry run is a zero-write preview by design, so a report row for it
    // would be a report about nothing that actually happened. Created here
    // (not queued) since this operation runs synchronously in-request; its
    // own id doubles as the correlationId for every pino log line below.
    reportId = crypto.randomUUID();
    const totalCandidates = needsFullPromote.length + linkedNotRemoved.length + alreadyRemoved.length + skippedDuplicate + skippedNoSubVertical;
    await query(`
      INSERT INTO csv_upload_logs (id, uploaded_by, vertical_id, status, lead_type, entity_type, operation_type, total_rows)
      VALUES ($1, $2, $3, 'processing', 'CALL', 'lead', 'promote', $4)
    `, [reportId, req.user.sub, verticalId, totalCandidates]);

    // ── Path A: Full atomic move (create follow_up + soft-remove COS) ─────────
    for (const row of needsFullPromote) {
      const txClient = await pool.connect();
      try {
        await txClient.query('BEGIN');

        const followUpId = crypto.randomUUID();
        const assignedToId = row.assigned_to || req.user.sub;
        const description = `[System-promoted] From COS record "${row.business_name || row.name || 'Unnamed'}" — bulk promotion.`;

        await txClient.query(`
          INSERT INTO follow_ups (id, cost_conversion_id, sub_vertical_id, assigned_to_id, created_by_id, follow_up_date, description, status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING')
        `, [followUpId, row.id, row.sub_vertical_id, assignedToId, req.user.sub, today, description]);

        await txClient.query(`
          UPDATE cost_conversions
          SET duplicate_status = 'promoted_removed',
              promoted_at = NOW(),
              promoted_to_follow_up_id = $1,
              promoted_by = $2,
              updated_at = NOW()
          WHERE id = $3
        `, [followUpId, req.user.sub, row.id]);

        await txClient.query('COMMIT');
        promoted++;
        promotedIds.push(row.id);
      } catch (err) {
        await txClient.query('ROLLBACK').catch(() => {});
        failed++;
        errors.push({ recordId: row.id, code: ErrorCodes.DB_CONSTRAINT, reason: err.message });
      } finally {
        txClient.release();
      }
    }

    // ── Path B: Soft-remove only (follow_up already existed, COS not removed) ──
    // No new follow_up is created — the existing one is kept as-is.
    // This handles the legacy promotion runs that were link-only.
    for (const row of linkedNotRemoved) {
      try {
        await query(`
          UPDATE cost_conversions
          SET duplicate_status = 'promoted_removed',
              promoted_at = NOW(),
              promoted_to_follow_up_id = $1,
              promoted_by = $2,
              updated_at = NOW()
          WHERE id = $3
        `, [row.existing_follow_up_id, req.user.sub, row.id]);
        softRemovedOnly++;
        softRemovedIds.push(row.id);
      } catch (err) {
        failed++;
        errors.push({ recordId: row.id, code: ErrorCodes.DB_CONSTRAINT, reason: err.message, path: 'soft_remove_only' });
      }
    }

    await query(`
      UPDATE csv_upload_logs
      SET status = 'done', success_count = $1, failed_count = $2, duplicate_count = $3,
          errors = $4::jsonb, processing_started_at = NOW(), processing_finished_at = NOW()
      WHERE id = $5
    `, [promoted + softRemovedOnly, failed, skippedDuplicate, JSON.stringify(errors), reportId]);

    if (promoted > 0 || softRemovedOnly > 0) {
      await logAudit(req, {
        action: 'follow_up.bulk_promoted',
        targetCollection: 'cost_conversions',
        targetId: verticalId,
        after: {
          promoted,
          softRemovedOnly,
          promotedIds,
          softRemovedIds,
        },
        metadata: { agentId: agentId || null, reportId },
        awaitWrite: true,
      });
      await cacheDeletePattern('calendar:*');
      // Signal both sections — COS viewers see records disappear; Follow-ups viewers see new records
      broadcastToAll({ type: 'COST_CONVERSION_MUTATED', verticalId, action: 'bulk_promote_move' });
      broadcastToAll({ type: 'FOLLOWUP_CREATED', verticalId: null }); // unscoped — follow-ups page must refresh
    }

    return res.status(200).json({
      success: true,
      data: {
        dryRun: false,
        promoted,
        softRemovedOnly,
        alreadyPromotedAndRemoved: alreadyRemoved.length,
        skippedDuplicate,
        skippedNoSubVertical,
        failed,
        errors,
        reportId,
      },
    });
  } catch (error) {
    if (reportId) {
      await query(`UPDATE csv_upload_logs SET status = 'failed', errors = errors || $1::jsonb, processing_finished_at = NOW() WHERE id = $2`,
        [JSON.stringify([{ code: ErrorCodes.INTERNAL_ERROR, reason: error.message }]), reportId]).catch(() => {});
    }
    return sendControllerError(res, error, 'promoteCosLeadsToFollowUps', { section: 'cos', operation: 'promote', recordId: reportId });
  }
};

/**
 * GET /verticals/:verticalId/export/csv
 */
export const exportFollowUpsCsv = async (req, res) => {
  const { verticalId } = req.params;
  const { date, assignedTo, subVerticalId, status, search } = req.query;

  try {
    if (!verticalId || !isValidUUID(verticalId)) {
      return res.status(400).json({ success: false, error: 'A valid verticalId is required' });
    }
    if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(verticalId))) {
      return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });
    }

    let sql = `
      SELECT f.id,
             to_char(f.follow_up_date, 'YYYY-MM-DD HH24:MI') AS follow_up_date_str,
             to_char(f.completed_at, 'YYYY-MM-DD HH24:MI') AS completed_at_str,
             to_char(f.created_at, 'YYYY-MM-DD HH24:MI') AS created_at_str,
             f.description,
             f.status,
             f.completed_note,
             l.name as lead_name, l.business_name as lead_business,
             u_assign.name as assigned_to_name,
             u_creator.name as creator_name,
             sv.name as sub_vertical_name
      FROM follow_ups f
      JOIN cost_conversions l ON f.cost_conversion_id = l.id
      JOIN users u_assign ON f.assigned_to_id = u_assign.id
      JOIN users u_creator ON f.created_by_id = u_creator.id
      JOIN sub_verticals sv ON f.sub_vertical_id = sv.id
      WHERE sv.vertical_id = $1
    `;
    const params = [verticalId];
    let pIdx = 2;

    const hasFullRead = req.role?.permissions.includes('*') || req.role?.permissions.includes('leads:read');
    if (!hasFullRead && req.role?.permissions.includes('leads:read_own')) {
      sql += ` AND (f.assigned_to_id = $${pIdx} OR l.assigned_to = $${pIdx} OR l.uploaded_by = $${pIdx})`;
      params.push(req.user.sub);
      pIdx++;
    }

    if (date) {
      sql += ` AND DATE(f.follow_up_date AT TIME ZONE 'Asia/Kolkata') = $${pIdx++}::date`;
      params.push(date);
    }
    if (assignedTo && isValidUUID(assignedTo)) {
      sql += ` AND f.assigned_to_id = $${pIdx++}`;
      params.push(assignedTo);
    }
    if (subVerticalId && isValidUUID(subVerticalId)) {
      sql += ` AND f.sub_vertical_id = $${pIdx++}`;
      params.push(subVerticalId);
    }
    if (status && status !== 'ALL') {
      sql += ` AND f.status = $${pIdx++}`;
      params.push(status);
    }
    if (search) {
      sql += ` AND (l.business_name ILIKE $${pIdx} OR l.name ILIKE $${pIdx} OR l.phone ILIKE $${pIdx})`;
      params.push(`%${search}%`);
      pIdx++;
    }

    sql += ` ORDER BY f.follow_up_date ASC`;

    const result = await query(sql, params);

    // Escape CSV values
    const sanitizeCsvValue = (val) => {
      const s = String(val ?? '');
      const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return guarded.replace(/"/g, '""');
    };

    const csvLine = (vals) => vals.map(v => `"${sanitizeCsvValue(v)}"`).join(',');
    const headers = [
      'FOLLOW-UP DATE & TIME',
      'LEAD NAME',
      'BUSINESS NAME',
      'SUB-VERTICAL',
      'ASSIGNED EMPLOYEE',
      'CREATED BY',
      'VISIT INSTRUCTION / AGENDA',
      'STATUS',
      'VISIT OUTCOME REPORT',
      'COMPLETED AT',
      'CREATED AT'
    ];
    const lines = [csvLine(headers)];
    
    for (const row of result.rows) {
      lines.push(csvLine([
        row.follow_up_date_str || '',
        row.lead_name || '',
        row.lead_business || '',
        row.sub_vertical_name || '',
        row.assigned_to_name || '',
        row.creator_name || '',
        row.description || '',
        row.status || '',
        row.completed_note || '',
        row.completed_at_str || '',
        row.created_at_str || ''
      ]));
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=follow-ups-export-${Date.now()}.csv`);
    return res.status(200).send(lines.join('\n') + '\n');
  } catch (error) {
    return sendControllerError(res, error, 'exportFollowUpsCsv');
  }
};


