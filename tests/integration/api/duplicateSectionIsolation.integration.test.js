import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../../server/src/app.js';
import { query } from '../../../server/src/config/db.js';

// Regression coverage for the "duplicate detection must be strictly
// per-section" requirement: COS (cost_conversions, lead_type CALL/FIELD),
// Positives (cost_conversions, lead_type POSITIVE), Raw Data, and Delivery
// Data are four independent sections. The same phone number appearing in
// two DIFFERENT sections is expected and must not be blocked; the same
// phone number appearing twice WITHIN one section must be caught.
//
// This also covers a real bug found and fixed in this pass: COS and
// Positives share the literal `cost_conversions` table, and the dedup
// queries previously had no `lead_type` filter — a phone used by a COS lead
// would incorrectly block creating a Positive with that same phone, and
// vice versa.
describe('Duplicate detection: strict per-section isolation', () => {
    let adminToken = '';
    let verticalId = '';
    let subVerticalId = '';
    let agentId = '';

    beforeAll(async () => {
        const loginRes = await request(app)
            .post('/api/v1/auth/login')
            .send({ email: 'admin@gmail.com', password: 'admin123' });
        adminToken = loginRes.body.data?.accessToken;

        const vertRes = await request(app)
            .post('/api/v1/verticals')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ name: `Dup Isolation Test ${Date.now()}` });
        verticalId = vertRes.body.data?.id;

        const svRes = await request(app)
            .post(`/api/v1/verticals/${verticalId}/sub-verticals`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ name: 'Standard' });
        subVerticalId = svRes.body.data?.id;

        const meRes = await query("SELECT id FROM users WHERE email = 'admin@gmail.com'");
        agentId = meRes.rows[0]?.id;
        await query('UPDATE users SET vertical_access = array_append(vertical_access, $1) WHERE id = $2', [verticalId, agentId]);

        process.env.VERCEL = '1';
    });

    afterAll(async () => {
        delete process.env.VERCEL;
        if (verticalId) {
            await query('DELETE FROM csv_upload_logs WHERE vertical_id = $1', [verticalId]);
            await query('DELETE FROM cost_conversions WHERE vertical_id = $1', [verticalId]);
            await query('DELETE FROM raw_data WHERE vertical_id = $1', [verticalId]);
            if (agentId) await query('UPDATE users SET vertical_access = array_remove(vertical_access, $1) WHERE id = $2', [verticalId, agentId]);
            await request(app).delete(`/api/v1/verticals/${verticalId}`).set('Authorization', `Bearer ${adminToken}`);
        }
    });

    function createLead({ phone, leadType, name }) {
        return request(app)
            .post('/api/v1/leads')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
                name: name || `Isolation Test ${phone}`,
                phone,
                businessName: `Biz ${phone}`,
                verticalId,
                subVerticalId,
                leadType,
            });
    }

    it('same phone in COS then Positives: both succeed (no false cross-section duplicate)', async () => {
        const phone = '9800000001';

        const cosRes = await createLead({ phone, leadType: 'CALL' });
        expect(cosRes.status).toBe(201);

        const positiveRes = await createLead({ phone, leadType: 'POSITIVE' });
        expect(positiveRes.status).toBe(201);
    });

    it('same phone twice within COS: second is rejected as a duplicate', async () => {
        const phone = '9800000002';

        const first = await createLead({ phone, leadType: 'CALL' });
        expect(first.status).toBe(201);

        const second = await createLead({ phone, leadType: 'CALL' });
        expect(second.status).toBe(409);
    });

    it('same phone twice within Positives: second is rejected as a duplicate', async () => {
        const phone = '9800000003';

        const first = await createLead({ phone, leadType: 'POSITIVE' });
        expect(first.status).toBe(201);

        const second = await createLead({ phone, leadType: 'POSITIVE' });
        expect(second.status).toBe(409);
    });

    it('same phone in COS and Raw Data: both succeed (cross-section, unaffected by this fix)', async () => {
        const phone = '9800000004';

        const cosRes = await createLead({ phone, leadType: 'CALL' });
        expect(cosRes.status).toBe(201);

        const rawRes = await request(app)
            .post('/api/v1/raw-data')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
                verticalId,
                date: '2026-07-24',
                employeeName: 'Super Admin',
                businessName: `Raw Biz ${phone}`,
                area: 'Whitefield', city: 'Bengaluru',
                phoneNumber: phone,
                address: '123 Main St',
            });
        expect(rawRes.status).toBe(201);
    });

    // Column order genuinely differs between CALL and POSITIVE uploads (see
    // scripts/production-readiness-test.js's CALL_HEADERS/POSITIVE_HEADERS) —
    // CONTACT NUMBER sits in a different position, and POSITIVE has follow-up
    // columns CALL doesn't.
    const CALL_HEADER_ROW = 'DATE,EMPLOYEE NAME,BUSINESS TYPE,BUSINESS / PERSON / SHOP / COMPANY NAME,CONTACT NUMBER,POINT OF CONTACT,AREA,CITY,LINK ADDRESS,REMARKS,RECORDINGS,APPOINTMENT TYPE (YES OR NO),APPOINTMENT DATE,APPOINTMENT TIME,REQUIREMENT ORDER IF ANY,NOTES TO THE COS IF ANY\n';
    const POSITIVE_HEADER_ROW = 'DATE,EMPLOYEE NAME,BUSINESS TYPE,BUSINESS / PERSON / SHOP / COMPANY NAME,AREA,CITY,CONTACT NUMBER,POINT OF CONTACT,REMARKS,RECORDINGS,FOLLOW-UP REQUIRED,FOLLOW-UPS,FOLLOW-UP DATES,FOLLOW-UP REMARKS,REQUIREMENT IF ANY,A NOTES TO THE COS TEAM ONLY\n';

    function callCsvLine(phone, name) {
        return `2026-07-27,,Retail,${name},${phone},,Area,City,,,,,,,,\n`;
    }
    function positiveCsvLine(phone, name) {
        return `2026-07-27,,Retail,${name},Area,City,${phone},,,,Yes,,,,,\n`;
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

    it('bulk CSV: same phone uploaded once as COS and once as Positives — both succeed', async () => {
        const phone = '9800000005';

        const cosUpload = await request(app)
            .post('/api/v1/leads/csv/upload')
            .set('Authorization', `Bearer ${adminToken}`)
            .field('verticalId', verticalId)
            .field('subVerticalId', subVerticalId)
            .attach('file', Buffer.from(CALL_HEADER_ROW + callCsvLine(phone, 'CSV COS Biz')), { filename: 'cos.csv', contentType: 'text/csv' })
            .expect(202);
        const cosFinal = await pollFor(`/api/v1/leads/csv/logs/${cosUpload.body.data.batchId}`);
        expect(cosFinal.status).toBe('done');
        expect(cosFinal.successCount).toBe(1);

        const positiveUpload = await request(app)
            .post('/api/v1/leads/csv/upload')
            .set('Authorization', `Bearer ${adminToken}`)
            .field('verticalId', verticalId)
            .field('subVerticalId', subVerticalId)
            .field('leadType', 'POSITIVE')
            .attach('file', Buffer.from(POSITIVE_HEADER_ROW + positiveCsvLine(phone, 'CSV Positive Biz')), { filename: 'positive.csv', contentType: 'text/csv' })
            .expect(202);
        const positiveFinal = await pollFor(`/api/v1/leads/csv/logs/${positiveUpload.body.data.batchId}`);
        expect(positiveFinal.status).toBe('done');
        expect(positiveFinal.successCount).toBe(1);
        expect(positiveFinal.duplicateCount || 0).toBe(0);
    }, 30000);

    // Covers the updateCostConversion gap: this path checked phone
    // uniqueness without a lead_type filter, so editing a lead's phone to
    // match a same-phone row in the *other* lead_type incorrectly 409'd.
    it('editing a COS lead\'s phone to match a Positive\'s phone (different section) succeeds', async () => {
        const cosPhone = '9800000006';
        const positivePhone = '9800000007';

        const cosRes = await createLead({ phone: cosPhone, leadType: 'CALL' });
        expect(cosRes.status).toBe(201);
        const cosId = cosRes.body.data.id;

        const positiveRes = await createLead({ phone: positivePhone, leadType: 'POSITIVE' });
        expect(positiveRes.status).toBe(201);

        const updateRes = await request(app)
            .patch(`/api/v1/leads/${cosId}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ phone: positivePhone });
        expect(updateRes.status).toBe(200);
    });

    it('editing a COS lead\'s phone to match another COS lead\'s phone (same section) is rejected', async () => {
        const phoneA = '9800000008';
        const phoneB = '9800000009';

        const leadA = await createLead({ phone: phoneA, leadType: 'CALL' });
        expect(leadA.status).toBe(201);
        const leadB = await createLead({ phone: phoneB, leadType: 'CALL' });
        expect(leadB.status).toBe(201);

        const updateRes = await request(app)
            .patch(`/api/v1/leads/${leadB.body.data.id}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ phone: phoneA });
        expect(updateRes.status).toBe(409);
    });
});
