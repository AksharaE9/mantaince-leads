import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import app from '../../../server/src/app.js';
import { query } from '../../../server/src/config/db.js';
import { processRawDataJob } from '../../../server/src/jobs/rawDataProcessor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('Raw Data API', () => {
    let adminToken = '';
    let verticalId = '';
    let agentId = '';

    beforeAll(async () => {
        const loginRes = await request(app)
            .post('/api/v1/auth/login')
            .send({ email: 'admin@gmail.com', password: 'admin123' });
        adminToken = loginRes.body.data?.accessToken;

        const vertRes = await request(app)
            .post('/api/v1/verticals')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ name: `Raw Data Test ${Date.now()}` });
        verticalId = vertRes.body.data?.id;

        // Reuse the logged-in admin as the "employee" for resolution tests —
        // avoids provisioning a whole new user just to test name matching.
        const meRes = await query('SELECT id, name FROM users WHERE email = $1', ['admin@gmail.com']);
        agentId = meRes.rows[0]?.id;
        await query('UPDATE users SET vertical_access = array_append(vertical_access, $1) WHERE id = $2', [verticalId, agentId]);
    });

    afterAll(async () => {
        if (verticalId) {
            await query('DELETE FROM raw_data WHERE vertical_id = $1', [verticalId]);
            await request(app).delete(`/api/v1/verticals/${verticalId}`).set('Authorization', `Bearer ${adminToken}`);
            // vertical_access is a plain UUID[] with no FK/cascade — deleting
            // the vertical above does not remove it from here, so it must be
            // done explicitly or every run leaves a dangling id behind.
            if (agentId) {
                await query('UPDATE users SET vertical_access = array_remove(vertical_access, $1) WHERE id = $2', [verticalId, agentId]);
            }
        }
    });

    describe('GET /api/v1/raw-data — Bug A style regression (empty/omitted params never 500)', () => {
        it('returns 200 with omitted params', async () => {
            const res = await request(app)
                .get(`/api/v1/raw-data?verticalId=${verticalId}`)
                .set('Authorization', `Bearer ${adminToken}`)
                .expect(200);
            expect(res.body.success).toBe(true);
        });

        it('returns 200 when search/assignedUserId are empty strings', async () => {
            const res = await request(app)
                .get(`/api/v1/raw-data?verticalId=${verticalId}&search=&assignedUserId=`)
                .set('Authorization', `Bearer ${adminToken}`)
                .expect(200);
            expect(res.body.success).toBe(true);
        });

        it('returns 401 unauthenticated, not 500', async () => {
            await request(app).get(`/api/v1/raw-data?verticalId=${verticalId}`).expect(401);
        });
    });

    describe('GET /api/v1/raw-data/schema and /import-template — shared schema, dynamic template', () => {
        it('exposes the same 11-field schema used by the validator', async () => {
            const res = await request(app)
                .get('/api/v1/raw-data/schema')
                .set('Authorization', `Bearer ${adminToken}`)
                .expect(200);
            expect(res.body.data.fields.map(f => f.key)).toEqual([
                'date', 'employeeName', 'businessType', 'businessName', 'area', 'city',
                'phoneNumber', 'address', 'appointmentDate', 'appointmentTimings', 'remarks',
            ]);
        });

        it('generates a CSV template with no vertical column', async () => {
            const res = await request(app)
                .get(`/api/v1/raw-data/import-template?verticalId=${verticalId}`)
                .set('Authorization', `Bearer ${adminToken}`)
                .expect(200);
            expect(res.headers['content-type']).toContain('text/csv');
            expect(res.text).toContain('Business Name');
            expect(res.text.toLowerCase()).not.toContain('vertical');
        });

        it('generates an .xlsx template', async () => {
            const res = await request(app)
                .get(`/api/v1/raw-data/import-template?verticalId=${verticalId}&format=xlsx`)
                .set('Authorization', `Bearer ${adminToken}`)
                .buffer(true)
                .parse((res, cb) => {
                    const chunks = [];
                    res.on('data', (c) => chunks.push(c));
                    res.on('end', () => cb(null, Buffer.concat(chunks)));
                })
                .expect(200);
            expect(res.headers['content-type']).toContain('spreadsheetml');
            expect(res.body.length).toBeGreaterThan(0);
        });
    });

    describe('POST /api/v1/raw-data — Single Add (shares validateRawDataRow with bulk upload)', () => {
        it('creates a record when the employee name resolves and all required fields are present', async () => {
            const res = await request(app)
                .post('/api/v1/raw-data')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({
                    verticalId,
                    date: '2026-07-24',
                    employeeName: 'Super Admin',
                    businessName: 'Acme Traders',
                    phoneNumber: '9876500001',
                })
                .expect(201);
            expect(res.body.data.assigned_user_id).toBe(agentId);
        });

        it('rejects with structured errors (422) when required fields are missing — never a bare 500', async () => {
            const res = await request(app)
                .post('/api/v1/raw-data')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ verticalId, employeeName: 'Super Admin' })
                .expect(422);
            expect(res.body.success).toBe(false);
            expect(Array.isArray(res.body.errors)).toBe(true);
            expect(res.body.errors.some(e => e.field === 'businessName')).toBe(true);
        });

        it('rejects when the employee name cannot be resolved, naming the problem field', async () => {
            const res = await request(app)
                .post('/api/v1/raw-data')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({
                    verticalId, date: '2026-07-24', employeeName: 'Totally Nobody',
                    businessName: 'Acme Traders', phoneNumber: '9876500002',
                })
                .expect(422);
            expect(res.body.errors.some(e => e.field === 'employeeName')).toBe(true);
        });

        it('rejects a duplicate phone number within the same vertical', async () => {
            await request(app)
                .post('/api/v1/raw-data')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ verticalId, date: '2026-07-24', employeeName: 'Super Admin', businessName: 'Dup Co', phoneNumber: '9876500099' })
                .expect(201);

            const res = await request(app)
                .post('/api/v1/raw-data')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ verticalId, date: '2026-07-24', employeeName: 'Super Admin', businessName: 'Dup Co Again', phoneNumber: '9876500099' })
                .expect(409);
            expect(res.body.success).toBe(false);
        });
    });

    describe('POST /api/v1/raw-data/upload — Bulk Upload (Bug B/C style regression)', () => {
        it('rejects a non-csv/xlsx file with 400, not 500', async () => {
            const res = await request(app)
                .post('/api/v1/raw-data/upload')
                .set('Authorization', `Bearer ${adminToken}`)
                .field('verticalId', verticalId)
                .attach('file', Buffer.from('bad'), { filename: 'bad.exe', contentType: 'application/x-msdownload' })
                .expect(400);
            expect(res.body.success).toBe(false);
        });

        it('rejects a missing verticalId with 400', async () => {
            await request(app)
                .post('/api/v1/raw-data/upload')
                .set('Authorization', `Bearer ${adminToken}`)
                .attach('file', Buffer.from('Date,Employee Name\n2026-07-24,Super Admin\n'), { filename: 'raw.csv', contentType: 'text/csv' })
                .expect(400);
        });

        it('accepts a well-formed CSV upload, queues it, and the processor inserts valid rows while rejecting unresolvable ones', async () => {
            // The background worker loop is disabled under NODE_ENV=test (see
            // server/src/app.js), so this test drives the queue -> process
            // pipeline the same way worker.js does: queue via the real HTTP
            // endpoint, then invoke the real processor directly (not a mock)
            // against the same batch row.
            const csv = 'Date,Employee Name,Business Type,Business Name,Area,City,Phone Number,Address,Appointment Date,Appointment Timings,Remarks\n'
                + '2026-07-24,Super Admin,Retail,Bulk Acme,Whitefield,Bengaluru,9876511111,123 Main St,2026-08-01,10:00 AM,Test row\n'
                + '2026-07-24,Nobody Matches,Retail,Bad Row,Whitefield,Bengaluru,9876511112,123 Main St,,,\n';

            const uploadRes = await request(app)
                .post('/api/v1/raw-data/upload')
                .set('Authorization', `Bearer ${adminToken}`)
                .field('verticalId', verticalId)
                .attach('file', Buffer.from(csv), { filename: 'raw.csv', contentType: 'text/csv' })
                .expect(202);

            const batchId = uploadRes.body.data.batchId;
            const logRow = (await query('SELECT * FROM csv_upload_logs WHERE id = $1', [batchId])).rows[0];
            expect(logRow.entity_type).toBe('raw_data');

            const fileBuffer = fs.readFileSync(path.join(__dirname, '../../../server/uploads', logRow.file_name));
            await processRawDataJob({
                data: {
                    batchId, verticalId, uploadedBy: agentId,
                    fileBufferBase64: fileBuffer.toString('base64'),
                    fileExt: path.extname(logRow.file_name),
                },
                progress: async () => {},
            });

            const finalLog = (await query('SELECT * FROM csv_upload_logs WHERE id = $1', [batchId])).rows[0];
            expect(finalLog.status).toBe('done');
            expect(finalLog.success_count).toBe(1);
            expect(finalLog.failed_count).toBeGreaterThanOrEqual(1);

            const inserted = await query('SELECT * FROM raw_data WHERE csv_batch_id = $1', [batchId]);
            expect(inserted.rows).toHaveLength(1);
            expect(inserted.rows[0].assigned_user_id).toBe(agentId);
            expect(inserted.rows[0].business_name).toBe('Bulk Acme');
        }, 20000);
    });
});
