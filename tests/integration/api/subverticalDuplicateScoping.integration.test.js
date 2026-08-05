import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../../server/src/app.js';
import { query } from '../../../server/src/config/db.js';

// Regression coverage for the reported bug: the same lead data uploaded
// successfully into one sub-vertical ("Specific Affiliate"), but uploading
// the same/overlapping data into a DIFFERENT sub-vertical under the SAME
// parent vertical was silently treated as a duplicate and blocked. Root
// cause: every duplicate check in costConversions.js/csvProcessor.js was
// scoped to vertical_id (and lead_type) but never to sub_vertical_id.
//
// Confirmed-correct behavior (see CLAUDE.md's established pattern of
// strict section-level isolation elsewhere in this app — COS/Raw
// Data/Delivery Data are independent sections, COS/Positives are
// independent via lead_type despite sharing one table): sub-verticals are
// independent for duplicate-detection purposes too. The same phone number
// legitimately exists once per sub-vertical; it must still be caught
// within one sub-vertical.
describe('Duplicate detection: strict sub-vertical isolation', () => {
    let adminToken = '';
    let verticalId = '';
    let subVerticalA = '';
    let subVerticalB = '';
    let otherVerticalId = '';
    let agentId = '';

    beforeAll(async () => {
        const loginRes = await request(app)
            .post('/api/v1/auth/login')
            .send({ email: 'admin@gmail.com', password: 'admin123' });
        adminToken = loginRes.body.data?.accessToken;

        const vertRes = await request(app)
            .post('/api/v1/verticals')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ name: `Subvertical Dup Test ${Date.now()}` });
        verticalId = vertRes.body.data?.id;

        const svARes = await request(app)
            .post(`/api/v1/verticals/${verticalId}/sub-verticals`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ name: 'Specific Affiliate' });
        subVerticalA = svARes.body.data?.id;

        const svBRes = await request(app)
            .post(`/api/v1/verticals/${verticalId}/sub-verticals`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ name: 'Standard' });
        subVerticalB = svBRes.body.data?.id;

        const otherVertRes = await request(app)
            .post('/api/v1/verticals')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ name: `Subvertical Dup Test Other Vertical ${Date.now()}` });
        otherVerticalId = otherVertRes.body.data?.id;

        const meRes = await query("SELECT id FROM users WHERE email = 'admin@gmail.com'");
        agentId = meRes.rows[0]?.id;
        await query('UPDATE users SET vertical_access = array_append(vertical_access, $1) WHERE id = $2', [verticalId, agentId]);
        await query('UPDATE users SET vertical_access = array_append(vertical_access, $1) WHERE id = $2', [otherVerticalId, agentId]);

        process.env.VERCEL = '1';
    });

    afterAll(async () => {
        delete process.env.VERCEL;
        for (const vid of [verticalId, otherVerticalId]) {
            if (!vid) continue;
            await query('DELETE FROM csv_upload_logs WHERE vertical_id = $1', [vid]);
            await query('DELETE FROM cost_conversions WHERE vertical_id = $1', [vid]);
            if (agentId) await query('UPDATE users SET vertical_access = array_remove(vertical_access, $1) WHERE id = $2', [vid, agentId]);
            await request(app).delete(`/api/v1/verticals/${vid}`).set('Authorization', `Bearer ${adminToken}`);
        }
    });

    function createLead({ phone, subVerticalId, name, leadType = 'CALL' }) {
        return request(app)
            .post('/api/v1/leads')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
                name: name || `Subvertical Test ${phone}`,
                phone,
                businessName: name || `Biz ${phone}`,
                verticalId,
                subVerticalId,
                leadType,
            });
    }

    it('same phone in sub-vertical A then sub-vertical B (same parent vertical): both succeed', async () => {
        const phone = '9700000001';

        const first = await createLead({ phone, subVerticalId: subVerticalA });
        expect(first.status).toBe(201);

        const second = await createLead({ phone, subVerticalId: subVerticalB });
        expect(second.status).toBe(201);
    });

    it('same phone twice within one sub-vertical: second is rejected as a duplicate, naming the conflicting record', async () => {
        const phone = '9700000002';

        const first = await createLead({ phone, subVerticalId: subVerticalA, name: 'Original Pooja Store' });
        expect(first.status).toBe(201);

        const second = await createLead({ phone, subVerticalId: subVerticalA, name: 'Duplicate Attempt' });
        expect(second.status).toBe(409);
        expect(second.body.error.code).toBe('DUPLICATE_PHONE');
        expect(second.body.error.message).toContain('sub-vertical');
        expect(second.body.error.message).toContain('Original Pooja Store');
        expect(second.body.error.correlationId).toBeTruthy();
    });

    it('same phone in two entirely different verticals: not blocked', async () => {
        const phone = '9700000003';

        const first = await createLead({ phone, subVerticalId: subVerticalA });
        expect(first.status).toBe(201);

        const otherSvRes = await request(app)
            .post(`/api/v1/verticals/${otherVerticalId}/sub-verticals`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ name: 'Other Vertical Sub' });
        const otherSubVerticalId = otherSvRes.body.data?.id;

        const second = await request(app)
            .post('/api/v1/leads')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
                name: `Cross Vertical ${phone}`, phone, businessName: `Biz ${phone}`,
                verticalId: otherVerticalId, subVerticalId: otherSubVerticalId, leadType: 'CALL',
            });
        expect(second.status).toBe(201);
    });

    it('editing a lead\'s phone to match a same-phone lead in a DIFFERENT sub-vertical succeeds', async () => {
        const phoneInA = '9700000004';
        const phoneInB = '9700000005';

        const leadA = await createLead({ phone: phoneInA, subVerticalId: subVerticalA });
        expect(leadA.status).toBe(201);
        const leadB = await createLead({ phone: phoneInB, subVerticalId: subVerticalB });
        expect(leadB.status).toBe(201);

        // Edit leadA's phone to match leadB's phone — different sub-verticals, must succeed.
        const updateRes = await request(app)
            .patch(`/api/v1/leads/${leadA.body.data.id}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ phone: phoneInB });
        expect(updateRes.status).toBe(200);
    });

    it('editing a lead\'s phone to match another lead\'s phone in the SAME sub-vertical is rejected with the conflicting record named', async () => {
        const phoneA = '9700000006';
        const phoneB = '9700000007';

        const leadA = await createLead({ phone: phoneA, subVerticalId: subVerticalA, name: 'Kept Record' });
        expect(leadA.status).toBe(201);
        const leadB = await createLead({ phone: phoneB, subVerticalId: subVerticalA });
        expect(leadB.status).toBe(201);

        const updateRes = await request(app)
            .patch(`/api/v1/leads/${leadB.body.data.id}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ phone: phoneA });
        expect(updateRes.status).toBe(409);
        expect(updateRes.body.error).toContain('Kept Record');
    });

    // ── Bulk CSV upload — the exact reported scenario ─────────────────────
    const CALL_HEADER_ROW = 'DATE,EMPLOYEE NAME,BUSINESS TYPE,BUSINESS / PERSON / SHOP / COMPANY NAME,CONTACT NUMBER,POINT OF CONTACT,AREA,CITY,LINK ADDRESS,REMARKS,RECORDINGS,APPOINTMENT TYPE (YES OR NO),APPOINTMENT DATE,APPOINTMENT TIME,REQUIREMENT ORDER IF ANY,NOTES TO THE COS IF ANY\n';
    function callCsvLine(phone, name) {
        return `2026-08-05,,Retail,${name},${phone},,Area,City,,,,,,,,\n`;
    }

    async function pollFor(path, { timeoutMs = 15000, intervalMs = 300 } = {}) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const res = await request(app).get(path).set('Authorization', `Bearer ${adminToken}`);
            const data = res.body?.data;
            if (data && (data.status === 'done' || data.status === 'failed')) return data;
            await new Promise(r => setTimeout(r, intervalMs));
        }
        throw new Error(`Timed out waiting for ${path} to reach a terminal status`);
    }

    it('bulk CSV: same phone uploaded into sub-vertical A, then the same phone uploaded into sub-vertical B — both succeed (the exact reported scenario)', async () => {
        const phone = '9700000008';

        const uploadA = await request(app)
            .post('/api/v1/leads/csv/upload')
            .set('Authorization', `Bearer ${adminToken}`)
            .field('verticalId', verticalId)
            .field('subVerticalId', subVerticalA)
            .attach('file', Buffer.from(CALL_HEADER_ROW + callCsvLine(phone, 'Pooja Store A')), { filename: 'batch-a.csv', contentType: 'text/csv' })
            .expect(202);
        const finalA = await pollFor(`/api/v1/leads/csv/logs/${uploadA.body.data.batchId}`);
        expect(finalA.status).toBe('done');
        expect(finalA.successCount).toBe(1);
        expect(finalA.duplicateCount || 0).toBe(0);

        const uploadB = await request(app)
            .post('/api/v1/leads/csv/upload')
            .set('Authorization', `Bearer ${adminToken}`)
            .field('verticalId', verticalId)
            .field('subVerticalId', subVerticalB)
            .attach('file', Buffer.from(CALL_HEADER_ROW + callCsvLine(phone, 'Pooja Store B')), { filename: 'batch-b.csv', contentType: 'text/csv' })
            .expect(202);
        const finalB = await pollFor(`/api/v1/leads/csv/logs/${uploadB.body.data.batchId}`);
        expect(finalB.status).toBe('done');
        expect(finalB.successCount).toBe(1);
        expect(finalB.duplicateCount || 0).toBe(0);
    }, 30000);

    it('bulk CSV: same phone uploaded twice into the SAME sub-vertical — second row flagged duplicate with the conflicting record named, not a silent skip', async () => {
        const phone = '9700000009';

        const uploadA = await request(app)
            .post('/api/v1/leads/csv/upload')
            .set('Authorization', `Bearer ${adminToken}`)
            .field('verticalId', verticalId)
            .field('subVerticalId', subVerticalA)
            .attach('file', Buffer.from(CALL_HEADER_ROW + callCsvLine(phone, 'First Upload Biz')), { filename: 'first.csv', contentType: 'text/csv' })
            .expect(202);
        const finalA = await pollFor(`/api/v1/leads/csv/logs/${uploadA.body.data.batchId}`);
        expect(finalA.status).toBe('done');
        expect(finalA.successCount).toBe(1);

        const uploadRepeat = await request(app)
            .post('/api/v1/leads/csv/upload')
            .set('Authorization', `Bearer ${adminToken}`)
            .field('verticalId', verticalId)
            .field('subVerticalId', subVerticalA)
            .attach('file', Buffer.from(CALL_HEADER_ROW + callCsvLine(phone, 'Second Upload Attempt')), { filename: 'repeat.csv', contentType: 'text/csv' })
            .expect(202);
        const finalRepeat = await pollFor(`/api/v1/leads/csv/logs/${uploadRepeat.body.data.batchId}`);
        expect(finalRepeat.status).toBe('done');
        expect(finalRepeat.successCount).toBe(0);
        expect(finalRepeat.duplicateCount).toBe(1);
        expect(finalRepeat.errors[0].reason).toContain('First Upload Biz');
    }, 30000);

    // ── JSON bulk-add endpoint (/api/v1/leads/bulk) — per-lead subVerticalId ──
    it('JSON bulk-add: two leads sharing a phone but different subVerticalId in one request both insert', async () => {
        const phone = '9700000010';

        const res = await request(app)
            .post('/api/v1/leads/bulk')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
                verticalId,
                leads: [
                    { phone, businessName: 'Bulk A', subVerticalId: subVerticalA },
                    { phone, businessName: 'Bulk B', subVerticalId: subVerticalB },
                ],
            })
            .expect(200);

        expect(res.body.data.inserted).toBe(2);
        expect(res.body.data.skipped).toBe(0);
    });

    it('JSON bulk-add: two leads sharing both phone and subVerticalId in one request — second flagged as duplicate, naming the conflict', async () => {
        const phone = '9700000011';

        const res = await request(app)
            .post('/api/v1/leads/bulk')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
                verticalId,
                leads: [
                    { phone, businessName: 'Bulk First', subVerticalId: subVerticalA },
                    { phone, businessName: 'Bulk Second', subVerticalId: subVerticalA },
                ],
            })
            .expect(200);

        expect(res.body.data.inserted).toBe(1);
        expect(res.body.data.skipped).toBe(1);
        expect(res.body.data.errors[0].reason).toContain('sub-vertical');
    });
});
