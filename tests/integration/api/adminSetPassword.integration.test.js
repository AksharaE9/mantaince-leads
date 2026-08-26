import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import app from '../../../server/src/app.js';
import { query } from '../../../server/src/config/db.js';
import bcrypt from 'bcryptjs';

describe('Admin Set Password Integration Tests', () => {
  let adminToken = '';
  let agentToken = '';
  let agentId = '';
  let agentEmail = '';
  let agentRoleId = '';

  beforeAll(async () => {
    // 1. Login as Admin
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'adminofleads@gmail.com', password: 'hile@dsbase@123' });
    adminToken = loginRes.body.data?.accessToken;

    // 2. Fetch Agent Role
    const roleRes = await query("SELECT id FROM roles WHERE name = 'agent'");
    agentRoleId = roleRes.rows[0]?.id;

    // 3. Create a Test Agent
    agentId = crypto.randomUUID();
    agentEmail = `test-agent-${crypto.randomUUID()}@gmail.com`;
    const initialHash = await bcrypt.hash('initialAgentPassword123', 12);

    await query(`
      INSERT INTO users (id, name, email, password_hash, role_id, is_active, is_approved)
      VALUES ($1, $2, $3, $4, $5, true, true)
    `, [agentId, 'Test Agent One', agentEmail, initialHash, agentRoleId]);

    // 4. Log in as Agent once to establish a session
    const agentLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: agentEmail, password: 'initialAgentPassword123' });
    agentToken = agentLogin.body.data?.accessToken;
  });

  afterAll(async () => {
    // Clean up created user and sessions
    if (agentId) {
      await query('DELETE FROM sessions WHERE user_id = $1', [agentId]);
      await query('DELETE FROM users WHERE id = $1', [agentId]);
    }
  });

  it('gating: non-admin roles (Agent) receive a 403 when trying to set a password', async () => {
    const res = await request(app)
      .post(`/api/v1/admin/users/${agentId}/set-password`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ password: 'NewSecurePassword123!', confirmPassword: 'NewSecurePassword123!' });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('validation: rejects when password and confirmPassword do not match', async () => {
    const res = await request(app)
      .post(`/api/v1/admin/users/${agentId}/set-password`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ password: 'NewSecurePassword123!', confirmPassword: 'DifferentPassword123!' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('do not match');
  });

  it('validation: rejects weak/trivially short passwords', async () => {
    const res = await request(app)
      .post(`/api/v1/admin/users/${agentId}/set-password`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ password: '123', confirmPassword: '123' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('must be at least 8 characters');
  });

  it('validation: rejects passwords matching user email or name', async () => {
    // Match Email
    const resEmail = await request(app)
      .post(`/api/v1/admin/users/${agentId}/set-password`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ password: agentEmail, confirmPassword: agentEmail });
    expect(resEmail.status).toBe(400);

    // Match Name
    const resName = await request(app)
      .post(`/api/v1/admin/users/${agentId}/set-password`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ password: 'Test Agent One', confirmPassword: 'Test Agent One' });
    expect(resName.status).toBe(400);
  });

  it('success: admin successfully sets new password and invalidates agent sessions', async () => {
    // Check that session exists in DB before updating password
    const beforeSessionRes = await query('SELECT COUNT(*) FROM sessions WHERE user_id = $1', [agentId]);
    expect(parseInt(beforeSessionRes.rows[0].count, 10)).toBeGreaterThan(0);

    // Update password
    const newPassword = 'NewSecurePassword123!';
    const res = await request(app)
      .post(`/api/v1/admin/users/${agentId}/set-password`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ password: newPassword, confirmPassword: newPassword });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify DB sessions for agent are deleted
    const afterSessionRes = await query('SELECT COUNT(*) FROM sessions WHERE user_id = $1', [agentId]);
    expect(parseInt(afterSessionRes.rows[0].count, 10)).toBe(0);

    // Verify login with old password fails
    const oldLoginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: agentEmail, password: 'initialAgentPassword123' });
    expect(oldLoginRes.status).toBe(401);

    // Verify login with new password succeeds
    const newLoginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: agentEmail, password: newPassword });
    expect(newLoginRes.status).toBe(200);
    expect(newLoginRes.body.success).toBe(true);
  });
});
