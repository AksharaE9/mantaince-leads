import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import app from '../../../server/src/app.js';
import { query } from '../../../server/src/config/db.js';
import { processDeliveryDataJob } from '../../../server/src/jobs/deliveryDataProcessor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('Delivery Data API', () => {
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
            .send({ name: `Delivery Data Test ${Date.now()}` });
        verticalId = vertRes.body.data?.id;

        const meRes = await query('SELECT id, name FROM users WHERE email = $1', ['admin@gmail.com']);
        agentId = meRes.rows[0]?.id;
        await query('UPDATE users SET vertical_access = array_append(vertical_access, $1) WHERE id = $2', [verticalId, agentId]);
    });

    afterAll(async () => {
        if (verticalId) {
            await query('DELETE FROM delivery_data WHERE vertical_id = $1', [verticalId]);
            await query('DELETE FROM raw_data WHERE vertical_id = $1', [verticalId]);
            await request(app).delete(`/api/v1/verticals/${verticalId}`).set('Authorization', `Bearer ${adminToken}`);
            if (agentId) {
                await query('UPDATE users SET vertical_access = array_remove(vertical_access, $1) WHERE id = $2', [verticalId, agentId]);
            }
        }
    });

    describe('GET /api/v1/delivery-data — safety on empty/omitted params', () => {
        it('returns 200 with omitted params', async () => {
            const res = await request(app)
                .get(`/api/v1/delivery-data?verticalId=${verticalId}`)
                .set('Authorization', `Bearer ${adminToken}`)
                .expect(200);
            expect(res.body.success).toBe(true);
        });

        it('returns 401 unauthenticated, not 500', async () => {
            await request(app).get(`/api/v1/delivery-data?verticalId=${verticalId}`).expect(401);
        });
    });

    describe('GET /api/v1/delivery-data/schema and /import-template — shared schema, dynamic template', () => {
        it('exposes the 13-field schema (11 shared Raw Data fields + Delivery Date/Delivery Time)', async () => {
            const res = await request(app)
                .get('/api/v1/delivery-data/schema')
                .set('Authorization', `Bearer ${adminToken}`)
                .expect(200);
            expect(res.body.data.fields.map(f => f.key)).toEqual([
                'date', 'employeeName', 'businessType', 'businessName', 'area', 'city',
                'phoneNumber', 'address', 'appointmentDate', 'appointmentTimings', 'remarks',
                'deliveryDate', 'deliveryTime',
            ]);
        });

        it('generates a CSV template including the Delivery Date/Delivery Time columns, no vertical column', async () => {
            const res = await request(app)
                .get(`/api/v1/delivery-data/import-template?verticalId=${verticalId}`)
                .set('Authorization', `Bearer ${adminToken}`)
                .expect(200);
            expect(res.headers['content-type']).toContain('text/csv');
            expect(res.text).toContain('Delivery Date');
            expect(res.text).toContain('Delivery Time');
            expect(res.text.toLowerCase()).not.toContain('vertical');
        });

        it('generates an .xlsx template', async () => {
            const res = await request(app)
                .get(`/api/v1/delivery-data/import-template?verticalId=${verticalId}&format=xlsx`)
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

        it('regression: /api/v1/raw-data/schema is unaffected and still returns exactly its original 11 fields', async () => {
            const res = await request(app)
                .get('/api/v1/raw-data/schema')
                .set('Authorization', `Bearer ${adminToken}`)
                .expect(200);
            expect(res.body.data.fields.map(f => f.key)).toEqual([
                'date', 'employeeName', 'businessType', 'businessName', 'area', 'city',
                'phoneNumber', 'address', 'appointmentDate', 'appointmentTimings', 'remarks',
            ]);
        });
    });

    describe('GET /api/v1/delivery-data — filters, sort, totalPages, and CSV export (section-page promotion)', () => {
        // Own isolated "Filter Test" fixture rows, same pattern as
        // rawData.integration.test.js — assertions never depend on how many
        // rows other describe blocks in this file happen to have created.
        beforeAll(async () => {
            const rows = [
                { date: '2026-07-01', businessName: 'Filter Test Alpha', businessType: 'FilterTestRetail', city: 'Chennai', phoneNumber: '9876505001', deliveryDate: '2026-07-05', deliveryTime: '10 AM' },
                { date: '2026-07-10', businessName: 'Filter Test Beta', businessType: 'FilterTestWholesale', city: 'Mumbai', phoneNumber: '9876505002', deliveryDate: '2026-07-15', deliveryTime: '11 AM' },
                { date: '2026-07-20', businessName: 'Filter Test Gamma', businessType: 'FilterTestRetail', city: 'Chennai', phoneNumber: '9876505003', deliveryDate: '2026-07-25', deliveryTime: '12 PM' },
            ];
            for (const row of rows) {
                await request(app)
                    .post('/api/v1/delivery-data')
                    .set('Authorization', `Bearer ${adminToken}`)
                    .send({ verticalId, employeeName: 'Super Admin', ...row })
                    .expect(201);
            }
        });

        it('filters by businessType', async () => {
            const res = await request(app)
                .get(`/api/v1/delivery-data?verticalId=${verticalId}&search=${encodeURIComponent('Filter Test')}&businessType=FilterTestRetail`)
                .set('Authorization', `Bearer ${adminToken}`)
                .expect(200);
            const names = res.body.data.map(r => r.business_name).sort();
            expect(names).toEqual(['Filter Test Alpha', 'Filter Test Gamma']);
        });

        it('filters by city', async () => {
            const res = await request(app)
                .get(`/api/v1/delivery-data?verticalId=${verticalId}&search=${encodeURIComponent('Filter Test')}&city=Mumbai`)
                .set('Authorization', `Bearer ${adminToken}`)
                .expect(200);
            expect(res.body.data.map(r => r.business_name)).toEqual(['Filter Test Beta']);
        });

        it('filters by dateFrom/dateTo (on the visit Date column)', async () => {
            const res = await request(app)
                .get(`/api/v1/delivery-data?verticalId=${verticalId}&search=${encodeURIComponent('Filter Test')}&dateFrom=2026-07-05&dateTo=2026-07-15`)
                .set('Authorization', `Bearer ${adminToken}`)
                .expect(200);
            expect(res.body.data.map(r => r.business_name)).toEqual(['Filter Test Beta']);
        });

        it('sorts by deliveryDate ascending and descending', async () => {
            const asc = await request(app)
                .get(`/api/v1/delivery-data?verticalId=${verticalId}&search=${encodeURIComponent('Filter Test')}&sortBy=deliveryDate&sortDir=asc`)
                .set('Authorization', `Bearer ${adminToken}`)
                .expect(200);
            expect(asc.body.data[0].business_name).toBe('Filter Test Alpha');

            const desc = await request(app)
                .get(`/api/v1/delivery-data?verticalId=${verticalId}&search=${encodeURIComponent('Filter Test')}&sortBy=deliveryDate&sortDir=desc`)
                .set('Authorization', `Bearer ${adminToken}`)
                .expect(200);
            expect(desc.body.data[0].business_name).toBe('Filter Test Gamma');
        });

        it('computes meta.totalPages from total/limit', async () => {
            const res = await request(app)
                .get(`/api/v1/delivery-data?verticalId=${verticalId}&search=${encodeURIComponent('Filter Test')}&limit=2`)
                .set('Authorization', `Bearer ${adminToken}`)
                .expect(200);
            expect(res.body.meta.total).toBe(3);
            expect(res.body.meta.totalPages).toBe(2);
        });

        it('exports a CSV respecting the same filters as the list endpoint, including Delivery Date/Time columns', async () => {
            const res = await request(app)
                .get(`/api/v1/delivery-data/export/csv?verticalId=${verticalId}&search=${encodeURIComponent('Filter Test')}&businessType=FilterTestRetail`)
                .set('Authorization', `Bearer ${adminToken}`)
                .expect(200);
            expect(res.headers['content-type']).toContain('text/csv');
            expect(res.text).toContain('Filter Test Alpha');
            expect(res.text).toContain('Filter Test Gamma');
            expect(res.text).not.toContain('Filter Test Beta');
            const header = res.text.split('\n')[0];
            expect(header).toContain('Delivery Date');
            expect(header).toContain('Delivery Time');
        });
    });

    describe('POST /api/v1/delivery-data — Single Add (shares validateDeliveryDataRow with bulk upload)', () => {
        it('creates a record when the employee name resolves and all required fields (incl. Delivery Date/Time) are present', async () => {
            const res = await request(app)
                .post('/api/v1/delivery-data')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({
                    verticalId,
                    date: '2026-07-24',
                    employeeName: 'Super Admin',
                    businessName: 'Acme Traders',
                    phoneNumber: '9876500001',
                    deliveryDate: '2026-08-01',
                    deliveryTime: '2:00 PM - 3:00 PM',
                })
                .expect(201);
            expect(res.body.data.assigned_user_id).toBe(agentId);
            expect(res.body.data.delivery_time).toBe('2:00 PM - 3:00 PM');
        });

        it('rejects with structured errors (422) when Delivery Date/Delivery Time are missing — never a bare 500', async () => {
            const res = await request(app)
                .post('/api/v1/delivery-data')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({
                    verticalId, date: '2026-07-24', employeeName: 'Super Admin',
                    businessName: 'Acme Traders', phoneNumber: '9876500002',
                })
                .expect(422);
            expect(res.body.success).toBe(false);
            const fields = res.body.errors.map(e => e.field);
            expect(fields).toContain('deliveryDate');
            expect(fields).toContain('deliveryTime');
        });

        it('allows two Delivery Data rows with the same phone number — unlike Raw Data, this is an event log, not a hard reject', async () => {
            const payload = {
                verticalId, date: '2026-07-24', employeeName: 'Super Admin',
                businessName: 'Repeat Biz', phoneNumber: '9876500050',
                deliveryDate: '2026-08-01', deliveryTime: '10 AM - 11 AM',
            };
            await request(app).post('/api/v1/delivery-data').set('Authorization', `Bearer ${adminToken}`).send(payload).expect(201);
            const res2 = await request(app)
                .post('/api/v1/delivery-data')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ ...payload, deliveryDate: '2026-08-15', deliveryTime: '1 PM - 2 PM' })
                .expect(201);
            expect(res2.body.success).toBe(true);
        });

        it('auto-links to an existing Raw Data record by exact phone match', async () => {
            const rawId = crypto.randomUUID();
            await query(
                `INSERT INTO raw_data (id, vertical_id, business_name, phone_number, source, created_by)
                 VALUES ($1, $2, 'Linked Business', '9876500077', 'single_add', $3)`,
                [rawId, verticalId, agentId]
            );

            const res = await request(app)
                .post('/api/v1/delivery-data')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({
                    verticalId, date: '2026-07-24', employeeName: 'Super Admin',
                    businessName: 'Linked Business', phoneNumber: '9876500077',
                    deliveryDate: '2026-08-01', deliveryTime: '10 AM - 11 AM',
                })
                .expect(201);
            expect(res.body.data.linked_raw_data_id).toBe(rawId);
        });

        it('does not link (with a warning, not silently) when no Raw Data record matches', async () => {
            const res = await request(app)
                .post('/api/v1/delivery-data')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({
                    verticalId, date: '2026-07-24', employeeName: 'Super Admin',
                    businessName: 'Nobody Matches Ltd', phoneNumber: '9876500088',
                    deliveryDate: '2026-08-01', deliveryTime: '10 AM - 11 AM',
                })
                .expect(201);
            expect(res.body.data.linked_raw_data_id).toBeNull();
            expect(res.body.warnings.some(w => w.field === 'linkedRawDataId')).toBe(true);
        });
    });

    describe('POST /api/v1/delivery-data/upload — Bulk Upload', () => {
        it('rejects a non-csv/xlsx file with 400, not 500', async () => {
            const res = await request(app)
                .post('/api/v1/delivery-data/upload')
                .set('Authorization', `Bearer ${adminToken}`)
                .field('verticalId', verticalId)
                .attach('file', Buffer.from('bad'), { filename: 'bad.exe', contentType: 'application/x-msdownload' })
                .expect(400);
            expect(res.body.success).toBe(false);
        });

        it('accepts a well-formed CSV upload, queues it, and the processor inserts valid rows while rejecting unresolvable ones and detecting a same-event duplicate', async () => {
            // Background worker loop is disabled under NODE_ENV=test — drive the
            // queue -> process pipeline directly, same pattern as
            // rawData.integration.test.js.
            const header = 'Date,Employee Name,Business Type,Business Name,Area,City,Phone Number,Address,Appointment Date,Appointment Timings,Remarks,Delivery Date,Delivery Time\n';
            const csv = header
                + '2026-07-24,Super Admin,Retail,Bulk Delivery Co,Whitefield,Bengaluru,9876522222,123 Main St,2026-08-01,10:00 AM,Test row,2026-08-05,2:00 PM - 3:00 PM\n'
                + '2026-07-24,Nobody Matches,Retail,Bad Row,Whitefield,Bengaluru,9876522223,123 Main St,,,,2026-08-05,3:00 PM\n'
                + '2026-07-24,Super Admin,Retail,Bulk Delivery Co,Whitefield,Bengaluru,9876522222,123 Main St,2026-08-01,10:00 AM,Test row,2026-08-05,2:00 PM - 3:00 PM\n';

            const uploadRes = await request(app)
                .post('/api/v1/delivery-data/upload')
                .set('Authorization', `Bearer ${adminToken}`)
                .field('verticalId', verticalId)
                .attach('file', Buffer.from(csv), { filename: 'delivery.csv', contentType: 'text/csv' })
                .expect(202);

            const batchId = uploadRes.body.data.batchId;
            const logRow = (await query('SELECT * FROM csv_upload_logs WHERE id = $1', [batchId])).rows[0];
            expect(logRow.entity_type).toBe('delivery_data');

            const fileBuffer = fs.readFileSync(path.join(__dirname, '../../../server/uploads', logRow.file_name));
            await processDeliveryDataJob({
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
            expect(finalLog.duplicate_count).toBe(1);
            expect(finalLog.failed_count).toBe(1); // unresolvable employee (duplicates are tracked separately now)

            const inserted = await query('SELECT * FROM delivery_data WHERE csv_batch_id = $1', [batchId]);
            expect(inserted.rows).toHaveLength(1);
            expect(inserted.rows[0].assigned_user_id).toBe(agentId);
            expect(inserted.rows[0].business_name).toBe('Bulk Delivery Co');
            expect(inserted.rows[0].delivery_time).toBe('2:00 PM - 3:00 PM');
        }, 20000);
    });
});
