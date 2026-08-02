import { query } from '../config/db.js';

/**
 * GET /audit-logs
 * Optimized for PostgreSQL and handles execution_time_ms metrics.
 */
export const getAuditLogs = async (req, res) => {
  const { page = 1, limit = 25, action, targetId, actorId, slowOnly } = req.query;
  try {
    // RBAC: Non-admin users are restricted to target-based audit lookups for leads they can access
    if (req.role.name !== 'super_admin' && req.role.name !== 'vertical_admin') {
      if (!targetId) {
        return res.status(403).json({ success: false, error: 'Forbidden: targetId is required' });
      }
      const costConversionCheck = await query('SELECT vertical_id, is_deleted FROM cost_conversions WHERE id = $1', [targetId]);
      const costConversion = costConversionCheck.rows[0];
      if (!costConversion || costConversion.is_deleted) {
        return res.status(404).json({ success: false, error: 'Cost/Conversion not found' });
      }
      if (!req.user.verticalAccess || !req.user.verticalAccess.includes(costConversion.vertical_id)) {
        return res.status(403).json({ success: false, error: 'Access forbidden: you do not have access to this business vertical' });
      }
    }
    let sql = `
      SELECT a.*, u.name as actor_name, u.email as actor_email 
      FROM audit_logs a
      LEFT JOIN users u ON a.actor_id = u.id
    `;
    const params = [];
    let whereClauses = [];
    let paramIndex = 1;

    if (action) {
      whereClauses.push(`a.action = $${paramIndex++}`);
      params.push(action);
    }
    if (targetId) {
      whereClauses.push(`a.target_id = $${paramIndex++}`);
      params.push(targetId);
    }
    if (actorId) {
      whereClauses.push(`a.actor_id = $${paramIndex++}`);
      params.push(actorId);
    }
    if (slowOnly === 'true') {
      whereClauses.push(`a.execution_time_ms > 500`);
    }

    if (whereClauses.length > 0) {
      sql += ' WHERE ' + whereClauses.join(' AND ');
    }

    // Pagination
    const limitNum = parseInt(limit, 10);
    const offset = (parseInt(page, 10) - 1) * limitNum;

    // Total Count
    const countSql = sql.replace('SELECT a.*, u.name as actor_name, u.email as actor_email', 'SELECT COUNT(*)');
    const totalRes = await query(countSql, params);
    const total = parseInt(totalRes.rows[0].count, 10);

    // Sorting and Final Query
    sql += ` ORDER BY a.created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(limitNum, offset);

    const logsRes = await query(sql, params);

    return res.status(200).json({
      success: true,
      data: logsRes.rows,
      meta: {
        page: parseInt(page, 10),
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};
export default getAuditLogs;
