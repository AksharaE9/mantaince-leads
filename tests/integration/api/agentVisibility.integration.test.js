import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import app from '../../../server/src/app.js';
import { query } from '../../../server/src/config/db.js';

describe('Agent Data Visibility Integration Tests', () => {
  let adminToken = '';
  let agentToken = '';
  let otherAgentToken = '';
  let agentId = '';
  let otherAgentId = '';
  let verticalId = '';
  let subVerticalId = '';
  let leadUploadedByAgent = '';
  let leadAssignedToAgent = '';
  let leadForOtherAgent = '';

  beforeAll(async () => {
    // 1. Login as admin
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'adminofleads@gmail.com', password: 'hile@dsbase@123' });
    adminToken = loginRes.body.data.accessToken;

    // Get a valid vertical ID from DB
    const vertRes = await query('SELECT id FROM verticals LIMIT 1');
    if (vertRes.rows.length > 0) {
      verticalId = vertRes.rows[0].id;
    } else {
      verticalId = crypto.randomUUID();
      await query(`
        INSERT INTO verticals (id, name, slug)
        VALUES ($1, 'Test Vertical', 'test-vertical-agent-vis')
      `, [verticalId]);
    }

    // Get a sub-vertical ID from vertical
    const subVertRes = await query('SELECT id FROM sub_verticals WHERE vertical_id = $1 LIMIT 1', [verticalId]);
    if (subVertRes.rows.length > 0) {
      subVerticalId = subVertRes.rows[0].id;
    } else {
      subVerticalId = crypto.randomUUID();
      await query(`
        INSERT INTO sub_verticals (id, vertical_id, name, slug)
        VALUES ($1, $2, 'Test Sub-vertical', 'test-sub')
      `, [subVerticalId, verticalId]);
    }

    // Get admin password hash to reuse
    const adminRes = await query('SELECT password_hash FROM users WHERE email = $1', ['adminofleads@gmail.com']);
    const adminHash = adminRes.rows[0].password_hash;

    // 2. Create Agent 1
    const agentRoleId = (await query("SELECT id FROM roles WHERE name = 'agent'")).rows[0].id;
    agentId = crypto.randomUUID();
    const agentEmail = `agent-${crypto.randomUUID()}@gmail.com`;
    await query(`
      INSERT INTO users (id, name, email, password_hash, role_id, vertical_access, is_active, is_approved)
      VALUES ($1, $2, $3, $4, $5, $6, true, true)
    `, [agentId, 'Agent One', agentEmail, adminHash, agentRoleId, [verticalId]]);

    // Insert user assignment so agent belongs to the sub-vertical
    await query(`
      INSERT INTO user_assignments (id, user_id, sub_vertical_id, is_active)
      VALUES ($1, $2, $3, true)
    `, [crypto.randomUUID(), agentId, subVerticalId]);

    const agentLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: agentEmail, password: 'hile@dsbase@123' });
    agentToken = agentLogin.body.data.accessToken;

    // 3. Create Agent 2
    otherAgentId = crypto.randomUUID();
    const otherAgentEmail = `agent-${crypto.randomUUID()}@gmail.com`;
    await query(`
      INSERT INTO users (id, name, email, password_hash, role_id, vertical_access, is_active, is_approved)
      VALUES ($1, $2, $3, $4, $5, $6, true, true)
    `, [otherAgentId, 'Agent Two', otherAgentEmail, adminHash, agentRoleId, [verticalId]]);

    const otherAgentLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: otherAgentEmail, password: 'hile@dsbase@123' });
    otherAgentToken = otherAgentLogin.body.data.accessToken;

    // 4. Create leads
    // Lead 1: uploaded_by Agent 1, assigned_to null
    leadUploadedByAgent = crypto.randomUUID();
    await query(`
      INSERT INTO cost_conversions (id, vertical_id, sub_vertical_id, uploaded_by, name, phone, business_name, lead_type)
      VALUES ($1, $2, $3, $4, 'Uploaded Lead', '1234567890', 'Agent1 Shop', 'CALL')
    `, [leadUploadedByAgent, verticalId, subVerticalId, agentId]);

    // Lead 2: uploaded_by Admin, assigned_to Agent 1
    leadAssignedToAgent = crypto.randomUUID();
    await query(`
      INSERT INTO cost_conversions (id, vertical_id, sub_vertical_id, uploaded_by, assigned_to, name, phone, business_name, lead_type)
      VALUES ($1, $2, $3, $4, $5, 'Assigned Lead', '9876543210', 'Agent1 Shop Assigned', 'CALL')
    `, [leadAssignedToAgent, verticalId, subVerticalId, loginRes.body.data.user.id, agentId]);

    // Lead 3: uploaded_by Agent 2, assigned_to Agent 2
    leadForOtherAgent = crypto.randomUUID();
    await query(`
      INSERT INTO cost_conversions (id, vertical_id, sub_vertical_id, uploaded_by, assigned_to, name, phone, business_name, lead_type)
      VALUES ($1, $2, $3, $4, $5, 'Other Lead', '5555555555', 'Agent2 Shop', 'CALL')
    `, [leadForOtherAgent, verticalId, subVerticalId, otherAgentId, otherAgentId]);
  });

  afterAll(async () => {
    // Cleanup users, assignments and leads
    if (leadUploadedByAgent && leadAssignedToAgent && leadForOtherAgent) {
      await query('DELETE FROM cost_conversions WHERE id IN ($1, $2, $3)', [leadUploadedByAgent, leadAssignedToAgent, leadForOtherAgent]);
    }
    if (agentId && otherAgentId) {
      await query('DELETE FROM user_assignments WHERE user_id IN ($1, $2)', [agentId, otherAgentId]);
      await query('DELETE FROM users WHERE id IN ($1, $2)', [agentId, otherAgentId]);
    }
  });

  describe('Leads Data Visibility', () => {
    it('agent should see all leads in their vertical (including other agents)', async () => {
      const res = await request(app)
        .get(`/api/v1/cost-conversions?verticalId=${verticalId}`)
        .set('Authorization', `Bearer ${agentToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      const leads = res.body.data;
      const leadIds = leads.map(l => l.id);

      expect(leadIds).toContain(leadUploadedByAgent);
      expect(leadIds).toContain(leadAssignedToAgent);
      expect(leadIds).toContain(leadForOtherAgent);
    });

    it('agent should be able to get detail of any lead in their vertical', async () => {
      const res = await request(app)
        .get(`/api/v1/cost-conversions/${leadForOtherAgent}`)
        .set('Authorization', `Bearer ${agentToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(leadForOtherAgent);
    });

    it('agent should be blocked from deleting any lead', async () => {
      await request(app)
        .delete(`/api/v1/cost-conversions/${leadUploadedByAgent}`)
        .set('Authorization', `Bearer ${agentToken}`)
        .expect(403);
    });
  });

  describe('Follow-up Summary Scoping', () => {
    it('agent should see follow-up summary for any lead in their vertical', async () => {
      const res = await request(app)
        .get(`/api/v1/followUps/cost-conversions/${leadForOtherAgent}/follow-ups/summary`)
        .set('Authorization', `Bearer ${agentToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('total');
    });
  });
});
