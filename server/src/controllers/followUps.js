import { query } from '../config/db.js';
import crypto from 'crypto';
import { logAudit } from '../services/audit.js';
import { broadcastToAll } from '../services/assignmentBroadcaster.js';
import { cacheGet, cacheSet, cacheDelete, cacheDeletePattern } from '../services/cache.js';
import { isValidUUID } from '../utils/validators/index.js';

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
    return res.status(500).json({ success: false, error: error.message });
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
    return res.status(500).json({ success: false, error: error.message });
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
    return res.status(500).json({ success: false, error: error.message });
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
    return res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * GET /cost-conversions/:costConversionId/follow-ups/summary
 */
export const getFollowUpSummary = async (req, res) => {
  const { costConversionId } = req.params;
  try {
    const costConversionRes = await query('SELECT vertical_id, assigned_to FROM cost_conversions WHERE id = $1 AND is_deleted = false', [costConversionId]);
    const costConversion = costConversionRes.rows[0];
    if (!costConversion) {
      return res.status(404).json({ success: false, error: 'Cost/Conversion not found' });
    }

    // Scoping check
    if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(costConversion.vertical_id))) {
      return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });
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
    return res.status(500).json({ success: false, error: error.message });
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
    return res.status(500).json({ success: false, error: error.message });
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
    return res.status(500).json({ success: false, error: error.message });
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
      WHERE sv.vertical_id = $1
    `;
    const params = [verticalId, targetDate];

    if (subVerticalId) {
      sql += ` AND f.sub_vertical_id = $3`;
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
    return res.status(500).json({ success: false, error: error.message });
  }
};
