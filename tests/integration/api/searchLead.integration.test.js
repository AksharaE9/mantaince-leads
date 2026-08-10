import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import app from '../../../server/src/app.js';
import { query } from '../../../server/src/config/db.js';

describe('Search Lead by Phone Integration Tests', () => {
  let adminToken = '';
  let agentToken = '';
  let verticalAId = '';
  let verticalBId = '';
  let subVerticalAId = '';
  let subVerticalBId = '';
  let testLeadPhone = '';
  let agentUserId = '';

  beforeAll(async () => {
    // 1. Acquire admin token
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'adminofleads@gmail.com', password: 'hile@dsbase@123' });
    adminToken = loginRes.body.data?.accessToken;

    // 2. Create Verticals
    const vARes = await request(app)
      .post('/api/v1/verticals')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `Search Vert A ${Date.now()}` });
    verticalAId = vARes.body.data?.id;

    const vBRes = await request(app)
      .post('/api/v1/verticals')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `Search Vert B ${Date.now()}` });
    verticalBId = vBRes.body.data?.id;

    // 3. Create Sub-Verticals
    const svARes = await request(app)
      .post(`/api/v1/verticals/${verticalAId}/sub-verticals`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Sub A' });
    subVerticalAId = svARes.body.data?.id;

    const svBRes = await request(app)
      .post(`/api/v1/verticals/${verticalBId}/sub-verticals`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Sub B' });
    subVerticalBId = svBRes.body.data?.id;

    // 4. Create Lead in Vertical B
    testLeadPhone = `900${Math.floor(1000000 + Math.random() * 9000000)}`;
    await request(app)
      .post('/api/v1/leads')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Secret Business B',
        phone: testLeadPhone,
        businessName: 'Secret Business B',
        verticalId: verticalBId,
        subVerticalId: subVerticalBId,
        leadType: 'CALL',
        data: { remarks: 'Highly secret info' }
      });

    // 5. Create an agent user who only has access to Vertical A
    const adminHashRes = await query('SELECT password_hash FROM users WHERE email = $1', ['adminofleads@gmail.com']);
    const adminHash = adminHashRes.rows[0].password_hash;
    const agentRoleId = (await query("SELECT id FROM roles WHERE name = 'agent'")).rows[0].id;
    agentUserId = crypto.randomUUID();
    const agentEmail = `agent-${crypto.randomUUID()}@gmail.com`;

    await query(`
      INSERT INTO users (id, name, email, password_hash, role_id, vertical_access, is_active, is_approved)
      VALUES ($1, $2, $3, $4, $5, $6, true, true)
    `, [agentUserId, 'Agent Vert A Only', agentEmail, adminHash, agentRoleId, [verticalAId]]);

    const agentLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: agentEmail, password: 'hile@dsbase@123' });
    agentToken = agentLogin.body.data?.accessToken;

    process.env.VERCEL = '1';
  });

  afterAll(async () => {
    delete process.env.VERCEL;
    // Clean up cost conversions
    if (verticalAId) await query('DELETE FROM cost_conversions WHERE vertical_id = $1', [verticalAId]);
    if (verticalBId) await query('DELETE FROM cost_conversions WHERE vertical_id = $1', [verticalBId]);
    
    // Clean up users
    if (agentUserId) await query('DELETE FROM users WHERE id = $1', [agentUserId]);

    // Clean up verticals
    if (verticalAId) await request(app).delete(`/api/v1/verticals/${verticalAId}`).set('Authorization', `Bearer ${adminToken}`);
    if (verticalBId) await request(app).delete(`/api/v1/verticals/${verticalBId}`).set('Authorization', `Bearer ${adminToken}`);
  });

  describe('GET /api/v1/leads/check-phone', () => {
    it('returns 401 if unauthenticated', async () => {
      await request(app)
        .get(`/api/v1/leads/check-phone?phone=${testLeadPhone}`)
        .expect(401);
    });

    it('returns 400 if phone query param is missing', async () => {
      const res = await request(app)
        .get('/api/v1/leads/check-phone')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
      
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('required');
    });

    it('returns empty array if phone number is not found', async () => {
      const res = await request(app)
        .get('/api/v1/leads/check-phone?phone=9999999999')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });

    it('returns full lead details when searched by super admin', async () => {
      const res = await request(app)
        .get(`/api/v1/leads/check-phone?phone=${testLeadPhone}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBe(1);
      const lead = res.body.data[0];
      expect(lead.phone).toBe(testLeadPhone);
      expect(lead.business_name).toBe('Secret Business B');
      expect(lead.hasAccess).toBe(true);
      expect(lead.data.remarks).toBe('Highly secret info');
    });

    it('returns redacted lead details when searched by agent without access to Vertical B', async () => {
      const res = await request(app)
        .get(`/api/v1/leads/check-phone?phone=${testLeadPhone}`)
        .set('Authorization', `Bearer ${agentToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBe(1);
      const lead = res.body.data[0];
      expect(lead.phone).toBe(testLeadPhone);
      expect(lead.hasAccess).toBe(false);
      // Redacted fields should be missing/undefined
      expect(lead.business_name).toBeUndefined();
      expect(lead.name).toBeUndefined();
      expect(lead.data).toBeUndefined();
      // Basic info is present to warn them of presence
      expect(lead.vertical_name).toBeDefined();
      expect(lead.sub_vertical_name).toBeDefined();
      expect(lead.status).toBe('new');
    });
  });
});
