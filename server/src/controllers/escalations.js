import { query } from '../config/db.js';
import crypto from 'crypto';
import { logAudit } from '../services/audit.js';
import { notifyViaPostgresNotify } from '../services/assignmentBroadcaster.js';

/**
 * POST /cost-conversions/:id/escalations
 */
export const createEscalation = async (req, res) => {
  const { id: costConversionId } = req.params;
  const { escalatedToId, reason } = req.body;

  if (!reason || reason.trim().length < 5) {
    return res.status(400).json({ success: false, error: 'A reason of at least 5 characters is required' });
  }

  try {
    // 1. Verify target user exists and has admin/super admin role
    const targetUserRes = await query(`
      SELECT u.id, u.is_active, r.name as role_name 
      FROM users u
      JOIN roles r ON u.role_id = r.id
      WHERE u.id = $1
    `, [escalatedToId]);

    const targetUser = targetUserRes.rows[0];
    if (!targetUser || !targetUser.is_active || (targetUser.role_name !== 'super_admin' && targetUser.role_name !== 'vertical_admin')) {
      return res.status(400).json({ success: false, error: 'Escalation target must be an active Admin or Super Admin' });
    }

    // 2. Verify cost conversion exists
    const costConversionRes = await query('SELECT id, name, business_name, vertical_id, assigned_to, uploaded_by FROM cost_conversions WHERE id = $1 AND is_deleted = false', [costConversionId]);
    const costConversion = costConversionRes.rows[0];
    if (!costConversion) {
      return res.status(404).json({ success: false, error: 'Cost/Conversion not found' });
    }

    if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(costConversion.vertical_id))) {
      return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });
    }

    const hasFullUpdate = req.role?.permissions.includes('*') || req.role?.permissions.includes('leads:update');
    if (!hasFullUpdate && req.role?.permissions.includes('leads:update_own') && costConversion.assigned_to !== req.user.sub && costConversion.uploaded_by !== req.user.sub) {
      return res.status(403).json({ success: false, error: 'Access forbidden: you are not assigned to this lead' });
    }

    // 3. Create escalation
    const id = crypto.randomUUID();
    const insertRes = await query(`
      INSERT INTO escalations (id, cost_conversion_id, escalated_by_id, escalated_to_id, reason, status)
      VALUES ($1, $2, $3, $4, $5, 'OPEN')
      RETURNING *
    `, [id, costConversionId, req.user.sub, escalatedToId, reason.trim()]);

    const escalation = insertRes.rows[0];

    // 4. Notify admin in real time
    await notifyViaPostgresNotify('escalation_channel', {
      type: 'ESCALATION_CREATED',
      escalationId: escalation.id,
      costConversionId,
      costConversionLabel: costConversion.business_name || costConversion.name,
      targetUserId: escalatedToId,
      escalatedByName: req.user.name || 'Agent',
      reason: escalation.reason,
    });

    // 5. Log audit trail
    await logAudit(req, {
      action: 'ESCALATION_CREATED',
      targetCollection: 'escalations',
      targetId: escalation.id,
      entityLabel: costConversion.business_name || costConversion.name,
      after: escalation
    });

    return res.status(201).json({ success: true, data: escalation });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

export const getCostConversionEscalations = async (req, res) => {
  const { id: costConversionId } = req.params;
  try {
    const costConversionRes = await query('SELECT vertical_id, assigned_to, uploaded_by FROM cost_conversions WHERE id = $1 AND is_deleted = false', [costConversionId]);
    const costConversion = costConversionRes.rows[0];
    if (!costConversion) {
      return res.status(404).json({ success: false, error: 'Cost/Conversion not found' });
    }

    if (req.user.role !== 'super_admin' && (!req.user.verticalAccess || !req.user.verticalAccess.includes(costConversion.vertical_id))) {
      return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });
    }

    const hasFullRead = req.role?.permissions.includes('*') || req.role?.permissions.includes('leads:read');
    if (!hasFullRead && req.role?.permissions.includes('leads:read_own') && costConversion.assigned_to !== req.user.sub && costConversion.uploaded_by !== req.user.sub) {
      return res.status(403).json({ success: false, error: 'Access forbidden: you are not assigned to this lead' });
    }

    const result = await query(`
      SELECT e.*, 
             u_by.name as escalated_by_name, u_by.email as escalated_by_email,
             u_to.name as escalated_to_name, u_to.email as escalated_to_email,
             u_res.name as resolved_by_name
      FROM escalations e
      JOIN users u_by ON e.escalated_by_id = u_by.id
      JOIN users u_to ON e.escalated_to_id = u_to.id
      LEFT JOIN users u_res ON e.resolved_by_id = u_res.id
      WHERE e.cost_conversion_id = $1
      ORDER BY e.created_at DESC
    `, [costConversionId]);

    return res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * GET /admin/escalations/inbox
 */
export const getAdminEscalationsInbox = async (req, res) => {
  const { status = 'OPEN' } = req.query;
  try {
    let sql = `
      SELECT e.*, 
             cc.business_name as cost_conversion_business, cc.name as cost_conversion_name,
             u_by.name as escalated_by_name, u_by.email as escalated_by_email,
             u_to.name as escalated_to_name, u_to.email as escalated_to_email,
             u_res.name as resolved_by_name
      FROM escalations e
      JOIN cost_conversions cc ON e.cost_conversion_id = cc.id
      JOIN users u_by ON e.escalated_by_id = u_by.id
      JOIN users u_to ON e.escalated_to_id = u_to.id
      LEFT JOIN users u_res ON e.resolved_by_id = u_res.id
      WHERE cc.is_deleted = false
    `;
    const params = [];
    let pIdx = 1;

    if (status) {
      sql += ` AND e.status = $${pIdx++}`;
      params.push(status);
    }

    // Admins only see escalations sent to them, Super Admins see all
    if (req.role.name === 'vertical_admin') {
      sql += ` AND e.escalated_to_id = $${pIdx++}`;
      params.push(req.user.sub);
    }

    sql += ' ORDER BY e.created_at DESC';

    const result = await query(sql, params);
    return res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * PUT /escalations/:id/resolve
 */
export const resolveEscalation = async (req, res) => {
  const { id } = req.params;
  const { resolutionNote } = req.body;

  try {
    const escRes = await query('SELECT * FROM escalations WHERE id = $1', [id]);
    const escalation = escRes.rows[0];
    if (!escalation) {
      return res.status(404).json({ success: false, error: 'Escalation not found' });
    }

    // Role verification
    if (escalation.escalated_to_id !== req.user.sub && req.role.name !== 'super_admin') {
      return res.status(403).json({ success: false, error: 'Only the assigned admin or a super admin can resolve this escalation' });
    }

    const before = { ...escalation };
    const result = await query(`
      UPDATE escalations 
      SET status = 'RESOLVED', resolution_note = $1, resolved_by_id = $2, resolved_at = NOW(), updated_at = NOW()
      WHERE id = $3
      RETURNING *
    `, [resolutionNote || '', req.user.sub, id]);

    const updated = result.rows[0];

    // Notify original creator of resolution
    await notifyViaPostgresNotify('escalation_channel', {
      type: 'ESCALATION_RESOLVED',
      escalationId: id,
      costConversionId: escalation.cost_conversion_id,
      targetUserId: escalation.escalated_by_id,
    });

    await logAudit(req, {
      action: 'ESCALATION_RESOLVED',
      targetCollection: 'escalations',
      targetId: id,
      before,
      after: updated
    });

    return res.status(200).json({ success: true, data: updated });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * PUT /escalations/:id/reject
 */
export const rejectEscalation = async (req, res) => {
  const { id } = req.params;
  const { resolutionNote } = req.body;

  try {
    const escRes = await query('SELECT * FROM escalations WHERE id = $1', [id]);
    const escalation = escRes.rows[0];
    if (!escalation) {
      return res.status(404).json({ success: false, error: 'Escalation not found' });
    }

    // Role verification
    if (escalation.escalated_to_id !== req.user.sub && req.role.name !== 'super_admin') {
      return res.status(403).json({ success: false, error: 'Only the assigned admin or a super admin can reject this escalation' });
    }

    const before = { ...escalation };
    const result = await query(`
      UPDATE escalations 
      SET status = 'REJECTED', resolution_note = $1, resolved_by_id = $2, resolved_at = NOW(), updated_at = NOW()
      WHERE id = $3
      RETURNING *
    `, [resolutionNote || '', req.user.sub, id]);

    const updated = result.rows[0];

    // Notify original creator of rejection
    await notifyViaPostgresNotify('escalation_channel', {
      type: 'ESCALATION_REJECTED',
      escalationId: id,
      costConversionId: escalation.cost_conversion_id,
      targetUserId: escalation.escalated_by_id,
    });

    await logAudit(req, {
      action: 'ESCALATION_REJECTED',
      targetCollection: 'escalations',
      targetId: id,
      before,
      after: updated
    });

    return res.status(200).json({ success: true, data: updated });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};
