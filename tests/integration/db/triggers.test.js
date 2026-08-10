import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../../server/src/app.js';
import { query } from '../../../server/src/config/db.js';

describe('Database Triggers Integration', () => {
  let adminToken = '';
  let testVerticalId = '';
  let testSubVerticalId = '';

  beforeAll(async () => {
    try {
      const loginRes = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'adminofleads@gmail.com', password: 'hile@dsbase@123' });
      adminToken = loginRes.body.data.accessToken;

      const vName = `Trig-V-${Math.floor(Math.random() * 100000)}`;
      const vSlug = `trig-v-${Math.floor(Math.random() * 100000)}`;
      const vRes = await request(app)
        .post('/api/v1/verticals')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: vName, slug: vSlug });
      
      if (!vRes.body.success) throw new Error(JSON.stringify(vRes.body));
      testVerticalId = vRes.body.data.id;

      const svRes = await request(app)
        .post(`/api/v1/verticals/${testVerticalId}/sub-verticals`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Triggers Test Sub' });
        
      if (!svRes.body.success) throw new Error(JSON.stringify(svRes.body));
      testSubVerticalId = svRes.body.data.id;
    } catch (err) {
      console.error('Failed to login or setup vertical during setup:', err.message);
    }
  });

  it('automatically populates search_vector on cost_conversions insert', async () => {
    const randomPhone = '+1555' + Math.floor(100000 + Math.random() * 900000);
    // Create new cost conversion
    const res = await request(app)
      .post('/api/v1/cost-conversions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Triggy Test',
        phone: randomPhone,
        businessName: 'Triggy Corp',
        verticalId: testVerticalId,
        subVerticalId: testSubVerticalId,
        leadType: 'CALL',
        data: { employeeName: 'shubhanga v' }
      })
      .expect(201);

    const leadId = res.body.data.id || res.body.data._id;
    expect(leadId).toBeTruthy();

    // Query search_vector
    const dbRes = await query('SELECT search_vector::text FROM cost_conversions WHERE id = $1', [leadId]);
    expect(dbRes.rows[0].search_vector).toContain('triggi');

    // Clean up
    await query('DELETE FROM cost_conversions WHERE id = $1', [leadId]);
  });

  it('automatically refreshes mv_vertical_stats when a cost_conversion is inserted and deleted', async () => {
    // 1. Get initial stats
    const beforeRes = await query('SELECT * FROM mv_vertical_stats WHERE vertical_id = $1', [testVerticalId]);
    const beforeStats = beforeRes.rows[0] || { total_cost_conversions: '0' };
    const beforeCount = parseInt(beforeStats.total_cost_conversions || 0, 10);

    // 2. Insert new lead
    const randomPhone = '+1555' + Math.floor(100000 + Math.random() * 900000);
    const res = await request(app)
      .post('/api/v1/cost-conversions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Stats trigger test',
        phone: randomPhone,
        businessName: 'Stats trigger corp',
        verticalId: testVerticalId,
        subVerticalId: testSubVerticalId,
        leadType: 'CALL',
        data: { employeeName: 'shubhanga v' }
      })
      .expect(201);

    const leadId = res.body.data.id || res.body.data._id;
    expect(leadId).toBeTruthy();

    // 3. Query stats again
    const afterRes = await query('SELECT * FROM mv_vertical_stats WHERE vertical_id = $1', [testVerticalId]);
    const afterCount = parseInt(afterRes.rows[0]?.total_cost_conversions || 0, 10);
    expect(afterCount).toBe(beforeCount + 1);

    // 4. Delete the lead
    await query('DELETE FROM cost_conversions WHERE id = $1', [leadId]);

    // 5. Query stats again
    const finalRes = await query('SELECT * FROM mv_vertical_stats WHERE vertical_id = $1', [testVerticalId]);
    const finalCount = parseInt(finalRes.rows[0]?.total_cost_conversions || 0, 10);
    expect(finalCount).toBe(beforeCount);
  });

  afterAll(async () => {
    if (testVerticalId) {
      await query('DELETE FROM verticals WHERE id = $1', [testVerticalId]);
    }
  });
});

