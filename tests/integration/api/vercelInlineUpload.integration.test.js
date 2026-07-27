import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../../server/src/app.js';
import { query } from '../../../server/src/config/db.js';

// Regression coverage for the `process.env.VERCEL` branch in the three bulk
// upload controllers (csv.js, rawData.js, deliveryData.js) — previously
// untested, which is exactly why a real bug (background processing getting
// silently abandoned with no waitUntil()) shipped there undetected. `pollFor`
// below exercises the same status-polling contract the frontend relies on;
// it can't reproduce Vercel actually freezing the container (only a real
// deployment can), but it does catch logic regressions in this branch going
// forward — malformed uploads, error shapes, the stale-batch reaper, etc.
async function pollFor(path, token, { timeoutMs = 15000, intervalMs = 300 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const res = await request(app).get(path).set('Authorization', `Bearer ${token}`);
        const data = res.body?.data;
        if (data && (data.status === 'done' || data.status === 'failed')) return data;
        await new Promise(r => setTimeout(r, intervalMs));
    }
    throw new Error(`Timed out waiting for ${path} to reach a terminal status`);
}

describe('Vercel inline (process.env.VERCEL) upload branch', () => {
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
            .send({ name: `Vercel Inline Test ${Date.now()}` });
        verticalId = vertRes.body.data?.id;

        const svRes = await request(app)
            .post(`/api/v1/verticals/${verticalId}/sub-verticals`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ name: 'Standard' });
        subVerticalId = svRes.body.data?.id;

        const meRes = await query('SELECT id FROM users WHERE email = $1', ['admin@gmail.com']);
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
            await query('DELETE FROM delivery_data WHERE vertical_id = $1', [verticalId]);
            if (agentId) await query('UPDATE users SET vertical_access = array_remove(vertical_access, $1) WHERE id = $2', [verticalId, agentId]);
            await request(app).delete(`/api/v1/verticals/${verticalId}`).set('Authorization', `Bearer ${adminToken}`);
        }
    });

    it('Leads: processes inline, reaches done with correct counts, response is 202 with a batchId', async () => {
        const csv = 'DATE,EMPLOYEE NAME,BUSINESS TYPE,BUSINESS / PERSON / SHOP / COMPANY NAME,CONTACT NUMBER,POINT OF CONTACT,AREA,CITY,LINK ADDRESS,REMARKS,RECORDINGS,APPOINTMENT TYPE (YES OR NO),APPOINTMENT DATE,APPOINTMENT TIME,REQUIREMENT ORDER IF ANY,NOTES TO THE COS IF ANY\n'
            + '2026-07-27,,Retail,VercelBranch Biz 1,9000010001,,Area,City,,,,,,,,\n'
            + '2026-07-27,,Retail,,9000010002,,Area,City,,,,,,,,\n'; // row 2 missing required business name

        const uploadRes = await request(app)
            .post('/api/v1/leads/csv/upload')
            .set('Authorization', `Bearer ${adminToken}`)
            .field('verticalId', verticalId)
            .field('subVerticalId', subVerticalId)
            .attach('file', Buffer.from(csv), { filename: 'vercel_leads.csv', contentType: 'text/csv' })
            .expect(202);

        expect(uploadRes.body.data.batchId).toBeTruthy();
        expect(uploadRes.body.data.status).toBe('processing');

        const final = await pollFor(`/api/v1/leads/csv/logs/${uploadRes.body.data.batchId}`, adminToken);
        expect(final.status).toBe('done');
        expect(final.successCount).toBe(1);
        expect(final.failedCount).toBe(1);
        expect(final.errors[0]).toHaveProperty('row');
        expect(final.errors[0].reason).not.toContain('undefined');
    }, 30000);

    it('Raw Data: processes inline, reaches done with correct counts', async () => {
        const csv = 'Date,Employee Name,Business Type,Business Name,Area,City,Phone Number,Address,Appointment Date,Appointment Timings,Remarks\n'
            + '2026-07-27,,Retail,VercelBranch RawData 1,Area,City,9000020001,Addr,,,\n';

        const uploadRes = await request(app)
            .post('/api/v1/raw-data/upload')
            .set('Authorization', `Bearer ${adminToken}`)
            .field('verticalId', verticalId)
            .attach('file', Buffer.from(csv), { filename: 'vercel_rawdata.csv', contentType: 'text/csv' })
            .expect(202);

        const final = await pollFor(`/api/v1/raw-data/upload-logs/${uploadRes.body.data.batchId}`, adminToken);
        expect(final.status).toBe('done');
        expect(final.successCount).toBe(1);
    }, 30000);

    it('Delivery Data: processes inline, reaches done with correct counts', async () => {
        const csv = 'Date,Employee Name,Business Type,Business Name,Area,City,Phone Number,Address,Appointment Date,Appointment Timings,Remarks,Delivery Date,Delivery Time\n'
            + '2026-07-27,,Retail,VercelBranch Delivery 1,Area,City,9000030001,Addr,,,,2026-07-28,10:00 AM\n';

        const uploadRes = await request(app)
            .post('/api/v1/delivery-data/upload')
            .set('Authorization', `Bearer ${adminToken}`)
            .field('verticalId', verticalId)
            .attach('file', Buffer.from(csv), { filename: 'vercel_deliverydata.csv', contentType: 'text/csv' })
            .expect(202);

        const final = await pollFor(`/api/v1/delivery-data/upload-logs/${uploadRes.body.data.batchId}`, adminToken);
        expect(final.status).toBe('done');
        expect(final.successCount).toBe(1);
    }, 30000);

    it('stale-batch reaper: a batch stuck at processing past the threshold is flipped to failed on next status read', async () => {
        const logRes = await query(`
            INSERT INTO csv_upload_logs (id, uploaded_by, vertical_id, file_name, original_file_name, status, sub_vertical_id, total_rows, processing_started_at)
            VALUES (gen_random_uuid(), $1, $2, 'stale.csv', 'stale.csv', 'processing', $3, 1, NOW() - INTERVAL '11 minutes')
            RETURNING id
        `, [agentId, verticalId, subVerticalId]);
        const staleBatchId = logRes.rows[0].id;

        const res = await request(app)
            .get(`/api/v1/leads/csv/logs/${staleBatchId}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .expect(200);

        expect(res.body.data.status).toBe('failed');
        expect(res.body.data.errors[0].reason).toMatch(/stalled/i);
    });
});
