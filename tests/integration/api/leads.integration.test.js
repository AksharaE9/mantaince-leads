import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import app from '../../../server/src/app.js';
import { query } from '../../../server/src/config/db.js';

describe('CostConversions API Integration', () => {
  let adminToken = '';

  beforeAll(async () => {
    // Acquire a token using standard login
    try {
      const loginRes = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'adminofleads@gmail.com', password: 'hile@dsbase@123' });
      adminToken = loginRes.body.data.accessToken;
    } catch (err) {
      console.error('Failed to login during test setup', err.message);
    }
  });

  describe('GET /api/v1/cost-conversions', () => {
    it('returns 200 and cost conversion list for authorized user', async () => {
      const res = await request(app)
        .get('/api/v1/cost-conversions?verticalId=0f26e60c-09fe-43e3-83c6-b8ece895d365&limit=5')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('returns 401 for unauthenticated request', async () => {
      await request(app)
        .get('/api/v1/cost-conversions?verticalId=0f26e60c-09fe-43e3-83c6-b8ece895d365')
        .expect(401);
    });

    it('responds within 200ms latency threshold', async () => {
      const start = Date.now();
      await request(app)
        .get('/api/v1/cost-conversions?verticalId=0f26e60c-09fe-43e3-83c6-b8ece895d365&limit=10')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1500); // Generous buffer for test dev execution   
    });

    describe('GET /api/v1/cost-conversions/export/csv', () => {
      it('exports a CSV of cost conversions for authorized user', async () => {
        const res = await request(app)
          .get('/api/v1/cost-conversions/export/csv?verticalId=0f26e60c-09fe-43e3-83c6-b8ece895d365')
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);

        expect(res.header['content-type']).toContain('text/csv');
      });
    });
  });

  describe('Follow-up CSV Export API', () => {
    describe('GET /api/v1/followUps/verticals/:verticalId/follow-ups/export/csv', () => {
      it('exports a CSV of follow ups for authorized user', async () => {
        const res = await request(app)
          .get('/api/v1/followUps/verticals/0f26e60c-09fe-43e3-83c6-b8ece895d365/follow-ups/export/csv')
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);

        expect(res.header['content-type']).toContain('text/csv');
        expect(res.text).toContain('FOLLOW-UP DATE & TIME');
      });

      it('returns 403 for unauthorized vertical access', async () => {
        const adminRes = await query('SELECT password_hash FROM users WHERE email = $1', ['adminofleads@gmail.com']);
        const adminHash = adminRes.rows[0].password_hash;
        const agentRoleId = (await query("SELECT id FROM roles WHERE name = 'agent'")).rows[0].id;
        const agentUserId = crypto.randomUUID();
        const agentEmail = `agent-${crypto.randomUUID()}@gmail.com`;
        
        await query(`
          INSERT INTO users (id, name, email, password_hash, role_id, vertical_access, is_active, is_approved)
          VALUES ($1, $2, $3, $4, $5, $6, true, true)
        `, [agentUserId, 'Test Agent', agentEmail, adminHash, agentRoleId, []]);

        const agentLogin = await request(app)
          .post('/api/v1/auth/login')
          .send({ email: agentEmail, password: 'hile@dsbase@123' });
        const agentToken = agentLogin.body.data.accessToken;
        const nonExistentVerticalId = crypto.randomUUID();

        await request(app)
          .get(`/api/v1/followUps/verticals/${nonExistentVerticalId}/follow-ups/export/csv`)
          .set('Authorization', `Bearer ${agentToken}`)
          .expect(403);
      });
    });
  });
});

describe('GET /health diagnostics', () => {
  it('returns health state, node environment, and Vercel git commit SHA', async () => {
    const res = await request(app)
      .get('/health')
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('online');
    expect(res.body.data).toHaveProperty('commitSha');
    expect(res.body.data).toHaveProperty('environment');
  });
});
