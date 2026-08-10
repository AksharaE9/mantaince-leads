import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../../server/src/app.js';
import { query } from '../../../server/src/config/db.js';

describe('Dashboard Stats Freshness & Isolation Integration', () => {
  let adminToken = '';
  
  // Tenant A config
  let tenantAId = '';
  let tenantASubId = '';
  
  // Tenant B config
  let tenantBId = '';
  let tenantBSubId = '';

  beforeAll(async () => {
    try {
      // 1. Admin login
      const loginRes = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'adminofleads@gmail.com', password: 'hile@dsbase@123' });
      adminToken = loginRes.body.data.accessToken;

      // 2. Setup Tenant A
      const aName = `Tenant-A-${Math.floor(Math.random() * 100000)}`;
      const aSlug = `tenant-a-${Math.floor(Math.random() * 100000)}`;
      const vARes = await request(app)
        .post('/api/v1/verticals')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: aName, slug: aSlug });
      tenantAId = vARes.body.data.id;

      const svARes = await request(app)
        .post(`/api/v1/verticals/${tenantAId}/sub-verticals`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Tenant A Sub' });
      tenantASubId = svARes.body.data.id;

      // 3. Setup Tenant B
      const bName = `Tenant-B-${Math.floor(Math.random() * 100000)}`;
      const bSlug = `tenant-b-${Math.floor(Math.random() * 100000)}`;
      const vBRes = await request(app)
        .post('/api/v1/verticals')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: bName, slug: bSlug });
      tenantBId = vBRes.body.data.id;

      const svBRes = await request(app)
        .post(`/api/v1/verticals/${tenantBId}/sub-verticals`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Tenant B Sub' });
      tenantBSubId = svBRes.body.data.id;

    } catch (err) {
      console.error('Test setup failed:', err.message);
    }
  });

  it('updates dashboard statistics immediately on lead writes and guarantees tenant isolation', async () => {
    // 1. Fetch initial stats from API
    const initialStatsRes = await request(app)
      .get('/api/v1/admin/dashboard-stats')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const initialA = initialStatsRes.body.data.find(v => v.id === tenantAId);
    const initialB = initialStatsRes.body.data.find(v => v.id === tenantBId);

    expect(initialA).toBeTruthy();
    expect(initialB).toBeTruthy();
    expect(initialA.totalLeads).toBe(0);
    expect(initialB.totalLeads).toBe(0);

    const initialTimeA = initialA.lastRefreshedAt ? new Date(initialA.lastRefreshedAt).getTime() : 0;
    const initialTimeB = initialB.lastRefreshedAt ? new Date(initialB.lastRefreshedAt).getTime() : 0;

    // Small delay to ensure timestamp increments on next update
    await new Promise(r => setTimeout(r, 1000));

    // 2. Insert a lead into Tenant A
    const phoneA = '+1555' + Math.floor(100000 + Math.random() * 900000);
    const createRes = await request(app)
      .post('/api/v1/cost-conversions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Tenant A Lead',
        phone: phoneA,
        businessName: 'A Corp',
        verticalId: tenantAId,
        subVerticalId: tenantASubId,
        leadType: 'CALL',
        data: { employeeName: 'shubhanga v' }
      })
      .expect(201);

    const leadId = createRes.body.data.id || createRes.body.data._id;
    expect(leadId).toBeTruthy();

    // 3. Query stats again
    const postInsertStatsRes = await request(app)
      .get('/api/v1/admin/dashboard-stats')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const postInsertA = postInsertStatsRes.body.data.find(v => v.id === tenantAId);
    const postInsertB = postInsertStatsRes.body.data.find(v => v.id === tenantBId);

    // Assert Tenant A statistics updated immediately (Real-time count + timestamp freshness)
    expect(postInsertA.totalLeads).toBe(1);
    expect(postInsertA.statusDistribution.new).toBe(1);
    expect(new Date(postInsertA.lastRefreshedAt).getTime()).toBeGreaterThan(initialTimeA);

    // Assert Tenant B remains completely untouched (Multi-tenant isolation)
    expect(postInsertB.totalLeads).toBe(0);
    if (initialTimeB > 0) {
      expect(new Date(postInsertB.lastRefreshedAt).getTime()).toBe(initialTimeB);
    }

    // 4. Update lead status in Tenant A to "won"
    await request(app)
      .patch(`/api/v1/cost-conversions/${leadId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'won' })
      .expect(200);

    // 5. Query stats again
    const postUpdateStatsRes = await request(app)
      .get('/api/v1/admin/dashboard-stats')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const postUpdateA = postUpdateStatsRes.body.data.find(v => v.id === tenantAId);
    const postUpdateB = postUpdateStatsRes.body.data.find(v => v.id === tenantBId);

    // Assert Tenant A reflects the status change
    expect(postUpdateA.totalLeads).toBe(1);
    expect(postUpdateA.statusDistribution.won).toBe(1);
    expect(postUpdateA.statusDistribution.new || 0).toBe(0);

    // Assert Tenant B remains isolated
    expect(postUpdateB.totalLeads).toBe(0);

    // 6. Delete the lead from Tenant A
    await query('DELETE FROM cost_conversions WHERE id = $1', [leadId]);
    
    // 7. Query stats one last time
    const finalStatsRes = await request(app)
      .get('/api/v1/admin/dashboard-stats')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const finalA = finalStatsRes.body.data.find(v => v.id === tenantAId);
    const finalB = finalStatsRes.body.data.find(v => v.id === tenantBId);

    expect(finalA.totalLeads).toBe(0);
    expect(finalB.totalLeads).toBe(0);
  });

  afterAll(async () => {
    // Clean up test data
    if (tenantAId) {
      await query('DELETE FROM verticals WHERE id = $1', [tenantAId]);
    }
    if (tenantBId) {
      await query('DELETE FROM verticals WHERE id = $1', [tenantBId]);
    }
  });
});
