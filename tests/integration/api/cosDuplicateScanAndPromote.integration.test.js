import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import app from '../../../server/src/app.js';
import { query } from '../../../server/src/config/db.js';

// Coverage for two production-backfill features that previously had zero
// automated tests (only manually verified per their commit messages):
// scanCosDuplicates (POST /leads/duplicates/scan) and
// promoteCosLeadsToFollowUps (POST /followUps/promote-to-follow-ups).
describe('COS duplicate scan + promote to follow-ups', () => {
  let adminToken = '';
  let verticalId = '';
  let subVerticalId = '';
  let agentId = '';

  beforeAll(async () => {
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'adminofleads@gmail.com', password: 'hile@dsbase@123' });
    adminToken = loginRes.body.data?.accessToken;

    const vertRes = await request(app)
      .post('/api/v1/verticals')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `Scan Promote Test ${Date.now()}` });
    verticalId = vertRes.body.data?.id;

    const svRes = await request(app)
      .post(`/api/v1/verticals/${verticalId}/sub-verticals`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Standard' });
    subVerticalId = svRes.body.data?.id;

    const meRes = await query("SELECT id FROM users WHERE email = 'adminofleads@gmail.com'");
    agentId = meRes.rows[0]?.id;
  });

  afterAll(async () => {
    if (verticalId) {
      await query('DELETE FROM follow_ups WHERE cost_conversion_id IN (SELECT id FROM cost_conversions WHERE vertical_id = $1)', [verticalId]);
      await query('DELETE FROM audit_logs WHERE target_id = $1', [verticalId]);
      await query('DELETE FROM cost_conversions WHERE vertical_id = $1', [verticalId]);
      await request(app).delete(`/api/v1/verticals/${verticalId}`).set('Authorization', `Bearer ${adminToken}`);
    }
  });

  // Directly seeds a pre-existing duplicate pair (bypassing the API's own
  // dedup check, which already prevents this going forward) — this feature
  // exists specifically to clean up duplicates that already exist in the
  // table, so that's the scenario under test.
  async function seedDuplicatePair(phone, { leadType = 'CALL', assignedTo = null, uploadedBy } = {}) {
    uploadedBy = uploadedBy || agentId;
    const keptId = crypto.randomUUID();
    await query(
      `INSERT INTO cost_conversions (id, vertical_id, sub_vertical_id, assigned_to, uploaded_by, name, phone, business_name, status, lead_type, created_at)
       VALUES ($1, $2, $3, $4, $5, 'Kept (earliest)', $6, 'Biz A', 'new', $7, NOW() - INTERVAL '1 hour')`,
      [keptId, verticalId, subVerticalId, assignedTo, uploadedBy, phone, leadType]
    );
    const dupId = crypto.randomUUID();
    await query(
      `INSERT INTO cost_conversions (id, vertical_id, sub_vertical_id, assigned_to, uploaded_by, name, phone, business_name, status, lead_type, created_at)
       VALUES ($1, $2, $3, $4, $5, 'Duplicate (later)', $6, 'Biz B', 'new', $7, NOW())`,
      [dupId, verticalId, subVerticalId, assignedTo, uploadedBy, phone, leadType]
    );
    return { keptId, dupId };
  }

  describe('scanCosDuplicates', () => {
    it('dry run: finds the group, reports the earliest-created as kept, makes no writes', async () => {
      const { keptId, dupId } = await seedDuplicatePair('9700000001');

      const res = await request(app)
        .post('/api/v1/leads/duplicates/scan')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ verticalId })
        .expect(200);

      expect(res.body.data.dryRun).toBe(true);
      const group = res.body.data.groups.find(g => g.phone === '9700000001');
      expect(group).toBeTruthy();
      expect(group.kept.id).toBe(keptId);
      expect(group.duplicates.map(d => d.id)).toEqual([dupId]);

      const stillActive = await query('SELECT duplicate_status FROM cost_conversions WHERE id = $1', [dupId]);
      expect(stillActive.rows[0].duplicate_status).toBeNull();
    });

    it('real run: flags the duplicate (soft), keeps the earliest untouched, hides it from listing, writes an audit log', async () => {
      const { keptId, dupId } = await seedDuplicatePair('9700000002');

      const res = await request(app)
        .post('/api/v1/leads/duplicates/scan')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ verticalId, dryRun: false })
        .expect(200);

      expect(res.body.data.dryRun).toBe(false);
      expect(res.body.data.totalFlagged).toBeGreaterThanOrEqual(1);

      const dupRow = (await query('SELECT duplicate_status, duplicate_of_id FROM cost_conversions WHERE id = $1', [dupId])).rows[0];
      expect(dupRow.duplicate_status).toBe('duplicate_removed');
      expect(dupRow.duplicate_of_id).toBe(keptId);

      const keptRow = (await query('SELECT duplicate_status FROM cost_conversions WHERE id = $1', [keptId])).rows[0];
      expect(keptRow.duplicate_status).toBeNull();

      const listRes = await request(app)
        .get(`/api/v1/leads?verticalId=${verticalId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      const listedIds = listRes.body.data.map(l => l.id);
      expect(listedIds).not.toContain(dupId);
      expect(listedIds).toContain(keptId);

      const auditRes = await query(
        `SELECT * FROM audit_logs WHERE action = 'cost_conversion.duplicates_removed' AND target_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [verticalId]
      );
      expect(auditRes.rows.length).toBe(1);
    });

    it('is scoped to COS only — a Positive lead with the same phone is untouched', async () => {
      const phone = '9700000003';
      await query(
        `INSERT INTO cost_conversions (id, vertical_id, sub_vertical_id, uploaded_by, name, phone, business_name, status, lead_type, created_at)
         VALUES ($1, $2, $3, $4, 'COS Lead', $5, 'Biz', 'new', 'CALL', NOW() - INTERVAL '1 hour')`,
        [crypto.randomUUID(), verticalId, subVerticalId, agentId, phone]
      );
      const positiveId = crypto.randomUUID();
      await query(
        `INSERT INTO cost_conversions (id, vertical_id, sub_vertical_id, uploaded_by, name, phone, business_name, status, lead_type, created_at)
         VALUES ($1, $2, $3, $4, 'Positive Lead', $5, 'Biz', 'new', 'POSITIVE', NOW())`,
        [positiveId, verticalId, subVerticalId, agentId, phone]
      );

      const res = await request(app)
        .post('/api/v1/leads/duplicates/scan')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ verticalId, dryRun: false })
        .expect(200);

      const touchedPositive = res.body.data.groups.some(g =>
        g.phone === phone && (g.kept.id === positiveId || g.duplicates.some(d => d.id === positiveId))
      );
      expect(touchedPositive).toBe(false);

      const positiveRow = (await query('SELECT duplicate_status FROM cost_conversions WHERE id = $1', [positiveId])).rows[0];
      expect(positiveRow.duplicate_status).toBeNull();
    });

    it('agentId filters to only that agent\'s records (uploaded_by OR assigned_to)', async () => {
      await seedDuplicatePair('9700000004', { assignedTo: agentId });
      const otherPhone = '9700000005';
      const otherUploaderRes = await query("SELECT id FROM users WHERE email != 'adminofleads@gmail.com' LIMIT 1");
      const otherUploader = otherUploaderRes.rows[0]?.id || agentId;
      await query(
        `INSERT INTO cost_conversions (id, vertical_id, sub_vertical_id, uploaded_by, name, phone, business_name, status, lead_type, created_at)
         VALUES ($1, $2, $3, $4, 'No Agent A', $5, 'Biz', 'new', 'CALL', NOW() - INTERVAL '1 hour')`,
        [crypto.randomUUID(), verticalId, subVerticalId, otherUploader, otherPhone]
      );
      await query(
        `INSERT INTO cost_conversions (id, vertical_id, sub_vertical_id, uploaded_by, name, phone, business_name, status, lead_type, created_at)
         VALUES ($1, $2, $3, $4, 'No Agent B', $5, 'Biz', 'new', 'CALL', NOW())`,
        [crypto.randomUUID(), verticalId, subVerticalId, otherUploader, otherPhone]
      );

      const res = await request(app)
        .post('/api/v1/leads/duplicates/scan')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ verticalId, agentId })
        .expect(200);

      const phones = res.body.data.groups.map(g => g.phone);
      expect(phones).toContain('9700000004');
      expect(phones).not.toContain(otherPhone);
    });
  });

  describe('promoteCosLeadsToFollowUps', () => {
    async function createPromotableLead(phone) {
      const res = await request(app)
        .post('/api/v1/leads')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: `Promote Test ${phone}`, phone, verticalId, subVerticalId, leadType: 'CALL' });
      expect(res.status).toBe(201);
      return res.body.data.id;
    }

    it('dry run reports wouldPromote without creating any follow_ups rows', async () => {
      const leadId = await createPromotableLead('9700000010');

      const res = await request(app)
        .post('/api/v1/followUps/promote-to-follow-ups')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ verticalId, costConversionIds: [leadId] })
        .expect(200);

      expect(res.body.data.dryRun).toBe(true);
      expect(res.body.data.wouldFullyPromote).toBe(1);

      const followUpRows = await query('SELECT * FROM follow_ups WHERE cost_conversion_id = $1', [leadId]);
      expect(followUpRows.rows.length).toBe(0);
    });

    it('real run promotes a fresh lead, linking via cost_conversion_id without touching the source row', async () => {
      const leadId = await createPromotableLead('9700000011');

      const res = await request(app)
        .post('/api/v1/followUps/promote-to-follow-ups')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ verticalId, costConversionIds: [leadId], dryRun: false })
        .expect(200);

      expect(res.body.data.promoted).toBe(1);
      expect(res.body.data.failed).toBe(0);

      const followUpRows = await query('SELECT * FROM follow_ups WHERE cost_conversion_id = $1', [leadId]);
      expect(followUpRows.rows.length).toBe(1);
      expect(followUpRows.rows[0].status).toBe('PENDING');

      const sourceLead = await query('SELECT is_deleted, status FROM cost_conversions WHERE id = $1', [leadId]);
      expect(sourceLead.rows[0].is_deleted).toBe(false);
    });

    it('is idempotent: promoting an already-promoted lead again is skipped, not duplicated', async () => {
      const leadId = await createPromotableLead('9700000012');

      await request(app)
        .post('/api/v1/followUps/promote-to-follow-ups')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ verticalId, costConversionIds: [leadId], dryRun: false })
        .expect(200);

      const secondRes = await request(app)
        .post('/api/v1/followUps/promote-to-follow-ups')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ verticalId, costConversionIds: [leadId], dryRun: false })
        .expect(200);

      expect(secondRes.body.data.promoted).toBe(0);
      expect(secondRes.body.data.alreadyPromotedAndRemoved).toBe(1);

      const followUpRows = await query('SELECT * FROM follow_ups WHERE cost_conversion_id = $1', [leadId]);
      expect(followUpRows.rows.length).toBe(1);
    });

    it('excludes duplicate-flagged records from promotion', async () => {
      const { dupId } = await seedDuplicatePair('9700000013');
      await request(app)
        .post('/api/v1/leads/duplicates/scan')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ verticalId, dryRun: false })
        .expect(200);

      const res = await request(app)
        .post('/api/v1/followUps/promote-to-follow-ups')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ verticalId, costConversionIds: [dupId], dryRun: false })
        .expect(200);

      expect(res.body.data.promoted).toBe(0);
      expect(res.body.data.skippedDuplicate).toBe(1);

      const followUpRows = await query('SELECT * FROM follow_ups WHERE cost_conversion_id = $1', [dupId]);
      expect(followUpRows.rows.length).toBe(0);
    });
  });
});
