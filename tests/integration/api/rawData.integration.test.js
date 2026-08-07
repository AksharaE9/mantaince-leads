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
            .send({ email: 'adminofleads@gmail.com', password: 'hile@dsbase@123' });
        adminToken = loginRes.body.data?.accessToken;

        const vertRes = await request(app)
            .post('/api/v1/verticals')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ name: `Raw Data Test ${Date.now()}` });
        verticalId = vertRes.body.data?.id;

        // Reuse the logged-in admin as the "employee" for resolution tests —
        // avoids provisioning a whole new user just to test name matching.
        const meRes = await query('SELECT id, name FROM users WHERE email = $1', ['adminofleads@gmail.com']);
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

    describe('GET /api/v1/raw-data — filters, sort, totalPages, and CSV export (section-page promotion)', () => {
        // Own isolated fixture rows (unique "Filter Test" name prefix + unique
        // businessType markers) so assertions never depend on how many rows
        // other describe blocks in this file happen to have created first.
        beforeAll(async () => {
            const rows = [
                { date: '2026-07-01', businessName: 'Filter Test Alpha', businessType: 'FilterTestRetail', city: 'Chennai', phoneNumber: '9876504001' },
                { date: '2026-07-10', businessName: 'Filter Test Beta', businessType: 'FilterTestWholesale', city: 'Mumbai', phoneNumber: '9876504002' },
                { date: '2026-07-20', businessName: 'Filter Test Gamma', businessType: 'FilterTestRetail', city: 'Chennai', phoneNumber: '9876504003' },
            ];
            for (const row of rows) {
                await request(app)
                    .post('/api/v1/raw-data')
                    .set('Authorization', `Bearer ${adminToken}`)
                    .send({ verticalId, employeeName: 'Super Admin', ...row })
                    .expect(201);
            }
        });

        it('filters by businessType', async () => {
            const res = await request(app)
                .get(`/api/v1/raw-data?verticalId=${verticalId}&search=${encodeURIComponent('Filter Test')}&businessType=FilterTestRetail`)
                .set('Authorization', `Bearer ${adminToken}`)
                .expect(200);
            const names = res.body.data.map(r => r.business_name).sort();
            expect(names).toEqual(['Filter Test Alpha', 'Filter Test Gamma']);
        });

        it('filters by city', async () => {
            const res = await request(app)
                .get(`/api/v1/raw-data?verticalId=${verticalId}&search=${encodeURIComponent('Filter Test')}&city=Mumbai`)
                .set('Authorization', `Bearer ${adminToken}`)
                .expect(200);
            expect(res.body.data.map(r => r.business_name)).toEqual(['Filter Test Beta']);
        });

        it('filters by dateFrom/dateTo (on the visit Date column, not created_at)', async () => {
            const res = await request(app)
                .get(`/api/v1/raw-data?verticalId=${verticalId}&search=${encodeURIComponent('Filter Test')}&dateFrom=2026-07-05&dateTo=2026-07-15`)
                .set('Authorization', `Bearer ${adminToken}`)
                .expect(200);
            expect(res.body.data.map(r => r.business_name)).toEqual(['Filter Test Beta']);
        });

        it('filters by assignedUserId', async () => {
            const res = await request(app)
                .get(`/api/v1/raw-data?verticalId=${verticalId}&search=${encodeURIComponent('Filter Test')}&assignedUserId=${agentId}`)
                .set('Authorization', `Bearer ${adminToken}`)
                .expect(200);
            expect(res.body.data).toHaveLength(3);
        });

        it('sorts by date ascending and descending', async () => {
            const asc = await request(app)
                .get(`/api/v1/raw-data?verticalId=${verticalId}&search=${encodeURIComponent('Filter Test')}&sortBy=date&sortDir=asc`)
                .set('Authorization', `Bearer ${adminToken}`)
                .expect(200);
            expect(asc.body.data[0].business_name).toBe('Filter Test Alpha');
            expect(asc.body.data[asc.body.data.length - 1].business_name).toBe('Filter Test Gamma');

            const desc = await request(app)
                .get(`/api/v1/raw-data?verticalId=${verticalId}&search=${encodeURIComponent('Filter Test')}&sortBy=date&sortDir=desc`)
                .set('Authorization', `Bearer ${adminToken}`)
                .expect(200);
            expect(desc.body.data[0].business_name).toBe('Filter Test Gamma');
        });

        it('computes meta.totalPages from total/limit', async () => {
            const res = await request(app)
                .get(`/api/v1/raw-data?verticalId=${verticalId}&search=${encodeURIComponent('Filter Test')}&limit=2`)
                .set('Authorization', `Bearer ${adminToken}`)
                .expect(200);
            expect(res.body.meta.total).toBe(3);
            expect(res.body.meta.totalPages).toBe(2);
        });

        it('exports a CSV respecting the same filters as the list endpoint', async () => {
            const res = await request(app)
                .get(`/api/v1/raw-data/export/csv?verticalId=${verticalId}&search=${encodeURIComponent('Filter Test')}&businessType=FilterTestRetail`)
                .set('Authorization', `Bearer ${adminToken}`)
                .expect(200);
            expect(res.headers['content-type']).toContain('text/csv');
            expect(res.text).toContain('Filter Test Alpha');
            expect(res.text).toContain('Filter Test Gamma');
            expect(res.text).not.toContain('Filter Test Beta');
            expect(res.text.split('\n')[0]).toContain('Business Name');
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

        // Phone-number-only-mandatory policy (see CLAUDE.md / MissingFieldDataDiagnosis
        // follow-up on the 55-row Delivery Data upload failure): Business Name is no
        // longer required — Phone Number is the only field that still blocks a row.
        it('rejects with structured errors (422) when Phone Number is missing — never a bare 500', async () => {
            const res = await request(app)
                .post('/api/v1/raw-data')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ verticalId, employeeName: 'Super Admin' })
                .expect(422);
            expect(res.body.success).toBe(false);
            expect(Array.isArray(res.body.errors)).toBe(true);
            expect(res.body.errors.some(e => e.field === 'phoneNumber')).toBe(true);
        });

        it('accepts a blank Business Name — no longer a required field', async () => {
            const res = await request(app)
                .post('/api/v1/raw-data')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ verticalId, date: '2026-07-24', employeeName: 'Super Admin', phoneNumber: '9876500003' })
                .expect(201);
            expect(res.body.data.business_name).toBeNull();
        });

        // Step 2: an unresolved Employee Name is a non-blocking warning now,
        // never a hard reject — the row still inserts, unassigned, with the
        // originally-typed name preserved for audit.
        it('accepts (with a warning) an employee name that cannot be resolved, and preserves the raw text', async () => {
            const res = await request(app)
                .post('/api/v1/raw-data')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({
                    verticalId, date: '2026-07-24', employeeName: 'Totally Nobody',
                    businessName: 'Acme Traders', phoneNumber: '9876500002',
                })
                .expect(201);
            expect(res.body.data.assigned_user_id).toBeNull();
            expect(res.body.data.employee_name_raw).toBe('Totally Nobody');
            expect(res.body.warnings.some(w => w.field === 'employeeName')).toBe(true);
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

        it('accepts a well-formed CSV upload, queues it, and the processor inserts both rows — an unresolvable employee name is a warning, not a rejection', async () => {
            // The background worker loop is disabled under NODE_ENV=test (see
            // server/src/app.js), so this test drives the queue -> process
            // pipeline the same way worker.js does: queue via the real HTTP
            // endpoint, then invoke the real processor directly (not a mock)
            // against the same batch row.
            //
            // Phone-number-only-mandatory policy: "Nobody Matches" used to hard-
            // block this row (see MissingFieldDataDiagnosis.md's 55-row Delivery
            // Data upload — the same "No matching employee found" failure mode).
            // It's now a warning; the row inserts unassigned, with the raw name
            // preserved in employee_name_raw.
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
            expect(finalLog.success_count).toBe(2);
            expect(finalLog.failed_count).toBe(0);
            expect((finalLog.errors || []).some(e => e.warning && e.field === 'employeeName')).toBe(true);

            const inserted = await query('SELECT * FROM raw_data WHERE csv_batch_id = $1 ORDER BY business_name', [batchId]);
            expect(inserted.rows).toHaveLength(2);
            const resolved = inserted.rows.find(r => r.business_name === 'Bulk Acme');
            const unresolved = inserted.rows.find(r => r.business_name === 'Bad Row');
            expect(resolved.assigned_user_id).toBe(agentId);
            expect(unresolved.assigned_user_id).toBeNull();
            expect(unresolved.employee_name_raw).toBe('Nobody Matches');
        }, 20000);
    });
});
