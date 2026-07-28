import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { query } from '../config/db.js';
import { logAudit } from '../services/audit.js';
import { broadcastToAll } from '../services/assignmentBroadcaster.js';
import { cacheDelete } from '../services/cache.js';

/**
 * GET /users
 */
export const getUsers = async (req, res) => {
  const { role, vertical, active } = req.query;
  try {
    let sql = `
      SELECT u.id, u.name, u.email, u.role_id, u.vertical_access,
             u.is_active, u.is_approved, u.last_login_at, u.created_by, u.created_at, u.updated_at,
             r.name AS role_name,
             COALESCE(
               json_agg(
                 json_build_object(
                   'id', sv.id,
                   'name', sv.name,
                   'slug', sv.slug,
                   'verticalId', sv.vertical_id
                 )
               ) FILTER (WHERE sv.id IS NOT NULL),
               '[]'
             ) AS "assignedSubVerticals"
      FROM users u 
      JOIN roles r ON u.role_id = r.id
      LEFT JOIN user_assignments ua ON ua.user_id = u.id AND ua.is_active = true
      LEFT JOIN sub_verticals sv ON ua.sub_vertical_id = sv.id
    `;
    const params = [];
    let whereClauses = [];
    let paramIndex = 1;

    if (req.user.role === 'agent') {
      whereClauses.push(`u.is_active = true`);
    }

    if (role) {
      whereClauses.push(`r.name = $${paramIndex++}`);
      params.push(role);
    }
    if (active !== undefined) {
      whereClauses.push(`u.is_active = $${paramIndex++}`);
      params.push(active === 'true');
    }

    if (whereClauses.length > 0) {
      sql += ' WHERE ' + whereClauses.join(' AND ');
    }

    sql += ` GROUP BY u.id, r.name`;

    const usersRes = await query(sql, params);
    const users = usersRes.rows;

    return res.status(200).json({ success: true, data: users });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * POST /users/invite
 */
export const inviteUser = async (req, res) => {
  const { name, email, role, roleName, password, verticalAccess = [] } = req.body;
  try {
    const targetRole = roleName || role;
    if (!targetRole) {
      return res.status(400).json({ success: false, error: 'Role is required' });
    }

    const inviteToken = crypto.randomBytes(32).toString('hex');
    const inviteTokenExpiry = new Date(Date.now() + 86400000); // 24 hours

    const pwdToHash = password || crypto.randomUUID();

    const [existsRes, roleRes, passwordHash] = await Promise.all([
      query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]),
      query('SELECT id FROM roles WHERE name = $1', [targetRole]),
      bcrypt.hash(pwdToHash, 12)
    ]);

    if (existsRes.rows.length > 0) {
      return res.status(400).json({ success: false, error: 'User with this email already exists' });
    }

    const roleDoc = roleRes.rows[0];
    if (!roleDoc) {
      return res.status(400).json({ success: false, error: 'Role not found' });
    }

    const userId = crypto.randomUUID();
    
    const newUserRes = await query(`
      INSERT INTO users (id, name, email, password_hash, role_id, vertical_access, is_approved, created_by, invite_token, invite_token_expiry)
      VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8, $9)
      RETURNING id, name, email, role_id, vertical_access, is_active, is_approved, last_login_at, created_by, created_at, updated_at
    `, [
      userId, name, email.toLowerCase(), passwordHash, roleDoc.id, verticalAccess, req.user.sub, inviteToken, inviteTokenExpiry
    ]);

    const newUser = newUserRes.rows[0];

    await logAudit(req, {
      action: 'user.invite',
      targetCollection: 'users',
      targetId: newUser.id,
      after: { name, email, role: targetRole, verticalAccess }
    });

    broadcastToAll({ type: 'USER_MUTATED' });

    // Make sure inviteToken is returned in the response format expected by tests
    return res.status(201).json({
      success: true,
      data: {
        ...newUser,
        inviteToken
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * GET /users/:id
 */
export const getUserById = async (req, res) => {
  const { id } = req.params;
  try {
    const userRes = await query(`
      SELECT u.id, u.name, u.email, u.role_id, u.vertical_access,
             u.is_active, u.is_approved, u.last_login_at, u.created_by, u.created_at, u.updated_at,
             r.name AS role_name, r.permissions
      FROM users u 
      JOIN roles r ON u.role_id = r.id 
      WHERE u.id = $1
    `, [id]);
    const userDoc = userRes.rows[0];
    
    if (!userDoc) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const assignmentsRes = await query(`
      SELECT ua.user_id, sv.id, sv.name, sv.slug, sv.vertical_id
      FROM user_assignments ua
      JOIN sub_verticals sv ON ua.sub_vertical_id = sv.id
      WHERE ua.user_id = $1 AND ua.is_active = true
    `, [id]);

    userDoc.assignedSubVerticals = assignmentsRes.rows.map(row => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      verticalId: row.vertical_id
    }));

    return res.status(200).json({ success: true, data: userDoc });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * PATCH /users/:id
 */
export const updateUser = async (req, res) => {
  const { id } = req.params;
  const { name, email, isActive, isApproved } = req.body;
  try {
    const userRes = await query('SELECT * FROM users WHERE id = $1', [id]);
    const user = userRes.rows[0];
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const before = { ...user };
    let setClause = [];
    const params = [id];
    let paramIndex = 2;

    if (name) {
      setClause.push(`name = $${paramIndex++}`);
      params.push(name);
    }
    if (email) {
      setClause.push(`email = $${paramIndex++}`);
      params.push(email.toLowerCase());
    }
    if (isActive !== undefined) {
      setClause.push(`is_active = $${paramIndex++}`);
      params.push(isActive);
    }
    if (isApproved !== undefined) {
      setClause.push(`is_approved = $${paramIndex++}`);
      params.push(isApproved);
    }

    if (setClause.length === 0) {
      // No fields to change — still must not leak password_hash/invite_token
      // by returning the raw `SELECT *` row directly to the client.
      const { password_hash, invite_token, invite_token_expiry, ...safeUser } = user;
      return res.status(200).json({ success: true, data: safeUser });
    }

    const updateRes = await query(`
      UPDATE users SET ${setClause.join(', ')}, updated_at = NOW()
      WHERE id = $1 RETURNING id, name, email, role_id, vertical_access, is_active, is_approved, last_login_at, created_by, created_at, updated_at
    `, params);
    const updatedUser = updateRes.rows[0];

    await logAudit(req, {
      action: 'user.update',
      targetCollection: 'users',
      targetId: id,
      before,
      after: updatedUser
    });

    await cacheDelete(`user_profile:${id}`);

    broadcastToAll({ type: 'USER_MUTATED' });

    return res.status(200).json({ success: true, data: updatedUser });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * PATCH /users/:id/role
 */
export const changeUserRole = async (req, res) => {
  const { id } = req.params;
  const { role, adminPassword } = req.body;
  try {
    // Self-escalation guard: an admin must not be able to change their own
    // role (e.g. to grant themselves broader access, or to accidentally
    // strip their own super_admin access).
    if (id === req.user.sub) {
      return res.status(403).json({ success: false, error: 'You cannot change your own role' });
    }

    // Parallelize: admin password check + user/role fetches simultaneously
    const [adminRes, userRes, roleRes] = await Promise.all([
        query('SELECT password_hash FROM users WHERE id = $1', [req.user.sub]),
        query(`
          SELECT u.*, r.name AS current_role_name
          FROM users u
          JOIN roles r ON u.role_id = r.id
          WHERE u.id = $1
        `, [id]),
        query('SELECT id FROM roles WHERE name = $1', [role]),
    ]);

    const adminUser = adminRes.rows[0];
    const isMatch = await bcrypt.compare(adminPassword, adminUser.password_hash);
    if (!isMatch) {
      return res.status(401).json({ success: false, error: 'Invalid administrator password confirmation' });
    }

    const user = userRes.rows[0];
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const roleDoc = roleRes.rows[0];
    if (!roleDoc) {
      return res.status(400).json({ success: false, error: 'Target role not found' });
    }

    // Last-super-admin protection: refuse to move the last active
    // super_admin out of that role, which would lock the org out of
    // super-admin-only functionality.
    if (user.current_role_name === 'super_admin' && role !== 'super_admin') {
      const countRes = await query(`
        SELECT COUNT(*) FROM users u
        JOIN roles r ON u.role_id = r.id
        WHERE r.name = 'super_admin' AND u.is_active = true
      `);
      const superAdminCount = parseInt(countRes.rows[0].count, 10);
      if (superAdminCount <= 1) {
        return res.status(400).json({ success: false, error: 'Cannot change role: at least one super_admin must remain' });
      }
    }

    const before = { ...user };
    const updatedRes = await query(`
      UPDATE users SET role_id = $1, updated_at = NOW()
      WHERE id = $2 RETURNING id, name, email, role_id, vertical_access, is_active, is_approved, last_login_at, created_by, created_at, updated_at
    `, [roleDoc.id, id]);
    const updatedUser = updatedRes.rows[0];

    await logAudit(req, {
      action: 'user.role_change',
      targetCollection: 'users',
      targetId: id,
      before,
      after: updatedUser
    });

    await cacheDelete(`user_profile:${id}`);

    broadcastToAll({ type: 'USER_MUTATED' });

    return res.status(200).json({ success: true, data: updatedUser });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * PATCH /users/:id/verticals
 */
export const assignUserVerticals = async (req, res) => {
  const { id } = req.params;
  const { verticalAccess } = req.body;
  try {
    const userRes = await query('SELECT * FROM users WHERE id = $1', [id]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const before = userRes.rows[0];
    const updatedRes = await query(`
      UPDATE users SET vertical_access = $1, updated_at = NOW()
      WHERE id = $2 RETURNING id, name, email, role_id, vertical_access, is_active, is_approved, last_login_at, created_by, created_at, updated_at
    `, [verticalAccess, id]);
    const updatedUser = updatedRes.rows[0];

    await logAudit(req, {
      action: 'user.verticals_change',
      targetCollection: 'users',
      targetId: id,
      before,
      after: updatedUser
    });

    await cacheDelete(`user_profile:${id}`);

    broadcastToAll({ type: 'USER_MUTATED' });

    return res.status(200).json({ success: true, data: updatedUser });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * DELETE /users/:id
 */
export const deleteUser = async (req, res) => {
  const { id } = req.params;
  const { hard } = req.query;
  try {
    const userRes = await query('SELECT * FROM users WHERE id = $1', [id]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const before = userRes.rows[0];

    if (hard === 'true') {
      // 1-3. Run checks concurrently to minimize DB round-trip overhead
      const [leadsRes, uploadedRes, followUpsRes] = await Promise.all([
        query('SELECT COUNT(*) FROM cost_conversions WHERE assigned_to = $1 AND is_deleted = false', [id]),
        query('SELECT COUNT(*) FROM cost_conversions WHERE uploaded_by = $1', [id]),
        query('SELECT COUNT(*) FROM follow_ups WHERE assigned_to_id = $1 OR created_by_id = $1', [id])
      ]);

      const assignedLeadsCount = parseInt(leadsRes.rows[0].count, 10);
      if (assignedLeadsCount > 0) {
        return res.status(409).json({
          success: false,
          error: `Cannot delete user. User currently has ${assignedLeadsCount} active Cost/Conversions assigned.`
        });
      }

      const uploadedLeadsCount = parseInt(uploadedRes.rows[0].count, 10);
      if (uploadedLeadsCount > 0) {
        return res.status(409).json({
          success: false,
          error: `Cannot delete user. User has uploaded ${uploadedLeadsCount} Cost/Conversions to the system.`
        });
      }

      const followUpsCount = parseInt(followUpsRes.rows[0].count, 10);
      if (followUpsCount > 0) {
        return res.status(409).json({
          success: false,
          error: `Cannot delete user. User has ${followUpsCount} follow-ups associated with their account.`
        });
      }

      // 4. Perform permanent deletion
      await query('DELETE FROM users WHERE id = $1', [id]);

      await logAudit(req, {
        action: 'user.delete',
        targetCollection: 'users',
        targetId: id,
        before,
        after: null
      });

      await cacheDelete(`user_profile:${id}`);

      broadcastToAll({ type: 'USER_MUTATED' });

      return res.status(200).json({ success: true, data: { message: 'User deleted permanently' } });
    } else {
      // Soft deactivation (default)
      const leadsRes = await query('SELECT COUNT(*) FROM cost_conversions WHERE assigned_to = $1 AND is_deleted = false', [id]);
      const assignedLeadsCount = parseInt(leadsRes.rows[0].count, 10);
      if (assignedLeadsCount > 0) {
        return res.status(409).json({
          success: false,
          error: `Cannot deactivate user. User currently has ${assignedLeadsCount} active Cost/Conversions assigned.`
        });
      }

      const updatedRes = await query(`
        UPDATE users SET is_active = false, updated_at = NOW() 
        WHERE id = $1 RETURNING *
      `, [id]);
      const updatedUser = updatedRes.rows[0];

      await logAudit(req, {
        action: 'user.deactivate',
        targetCollection: 'users',
        targetId: id,
        before,
        after: updatedUser
      });

      await cacheDelete(`user_profile:${id}`);

      broadcastToAll({ type: 'USER_MUTATED' });

      return res.status(200).json({ success: true, data: { message: 'User deactivated successfully' } });
    }
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * PATCH /users/:id/approve
 */
export const approveUser = async (req, res) => {
  const { id } = req.params;
  try {
    const userRes = await query('SELECT * FROM users WHERE id = $1', [id]);
    const user = userRes.rows[0];
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const updatedRes = await query(`
      UPDATE users SET is_approved = true, updated_at = NOW()
      WHERE id = $1 RETURNING id, name, email, role_id, vertical_access, is_active, is_approved, last_login_at, created_by, created_at, updated_at
    `, [id]);
    const updatedUser = updatedRes.rows[0];

    await logAudit(req, {
      action: 'user.approve',
      targetCollection: 'users',
      targetId: id,
      before: user,
      after: updatedUser
    });

    await cacheDelete(`user_profile:${id}`);

    broadcastToAll({ type: 'USER_MUTATED' });

    return res.status(200).json({ success: true, data: updatedUser });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

