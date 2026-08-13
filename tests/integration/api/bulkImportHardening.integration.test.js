import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../../server/src/app.js';
import { query } from '../../../server/src/config/db.js';
import { processRawDataJob } from '../../../server/src/jobs/rawDataProcessor.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function generateCsv(rowCount, existingPhone, extraOptions = {}) {
    let csv = 'Date,Employee Name,Business Type,Business Name,Area,City,Phone Number,Address,Appointment Date,Appointment Timings,Remarks\n';
    for (let i = 1; i <= rowCount; i++) {
        let phone = `9000000${String(i).padStart(3, '0')}`;
        let name = `Bulk Biz ${i}`;
        let emp = 'Super Admin';
        
        if (i === 10 && extraOptions.malformed) {
            // Malformed row: missing phone and name
            phone = '';
            name = '';
        }
        if (i === 20 && extraOptions.duplicateDb) {
            // Duplicate against existing DB record
            phone = existingPhone;
        }
        if (i === 30 && extraOptions.duplicateWithinFile) {
            // Duplicate within the file itself (matches row 15)
            phone = `9000000015`;
        }
        csv += `2026-07-24,${emp},Retail,${name},Whitefield,Bengaluru,${phone},123 Main St,,,\n`;
    }
    return csv;
}

describe('Bulk Lead Import Pipeline Hardening', () => {
    let adminToken = '';
    let verticalId = '';
    let agentId = '';
    const existingDbPhone = '9876599999';

    beforeAll(async () => {
        const loginRes = await request(app)
            .post('/api/v1/auth/login')
            .send({ email: 'adminofleads@gmail.com', password: 'hile@dsbase@123' });
        adminToken = loginRes.body.data?.accessToken;

        const vertRes = await request(app)
            .post('/api/v1/verticals')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ name: `Bulk Hardening Test ${Date.now()}` });
        verticalId = vertRes.body.data?.id;

        const agentRes = await query("SELECT id FROM users WHERE email = 'adminofleads@gmail.com'");
        agentId = agentRes.rows[0].id;

        // Ensure Super Admin has vertical access so employee resolution passes
        await query('UPDATE users SET vertical_access = array_append(vertical_access, $1) WHERE id = $2', [verticalId, agentId]);

        // Insert a record to trigger a DB duplicate violation later
        await request(app)
            .post('/api/v1/raw-data')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
                verticalId,
                date: '2026-07-24',
                employeeName: 'Super Admin',
                businessName: 'Existing DB Biz',
                phoneNumber: existingDbPhone,
            })
            .expect(201);
    });

    afterAll(async () => {
        if (verticalId) {
            await query('DELETE FROM csv_upload_logs WHERE vertical_id = $1', [verticalId]);
            await query('DELETE FROM raw_data WHERE vertical_id = $1', [verticalId]);
            await query('UPDATE users SET vertical_access = array_remove(vertical_access, $1) WHERE id = $2', [verticalId, agentId]);
            await request(app).delete(`/api/v1/verticals/${verticalId}`).set('Authorization', `Bearer ${adminToken}`);
        }
    });

    it('processes a large batch (200+ rows) with mixed success, malformed, and duplicate rows, asserting outcome totals match', async () => {
        const csv = generateCsv(210, existingDbPhone, {
            malformed: true,            // row 10 has missing fields (fails)
            duplicateDb: true,          // row 20 is already in DB (duplicate)
            duplicateWithinFile: true,  // row 30 is a duplicate of row 15 (duplicate)
        });

        const uploadRes = await request(app)
            .post('/api/v1/raw-data/upload')
            .set('Authorization', `Bearer ${adminToken}`)
            .field('verticalId', verticalId)
            .attach('file', Buffer.from(csv), { filename: 'raw_large.csv', contentType: 'text/csv' })
            .expect(202);

        const batchId = uploadRes.body.data.batchId;
        const logRow = (await query('SELECT * FROM csv_upload_logs WHERE id = $1', [batchId])).rows[0];

        const fileBuffer = fs.readFileSync(path.join(__dirname, '../../../server/uploads', logRow.file_name));
        
        const startTime = Date.now();
        await processRawDataJob({
            data: {
                batchId, verticalId, uploadedBy: agentId,
                fileBufferBase64: fileBuffer.toString('base64'),
                fileExt: path.extname(logRow.file_name),
            },
            progress: async () => {},
        });
        const duration = Date.now() - startTime;
        console.log(`[Test] Processed 210 rows in ${duration}ms`);

        const updatedLog = (await query('SELECT * FROM csv_upload_logs WHERE id = $1', [batchId])).rows[0];
        expect(updatedLog.status).toBe('done');

        // Totals validation
        const success = updatedLog.success_count;
        const failed = updatedLog.failed_count;
        const duplicate = updatedLog.duplicate_count;
        const total = updatedLog.total_rows;

        // Row 10 failed, Row 20 duplicate, Row 30 duplicate.
        // Expected success: 210 - 3 = 207 rows.
        expect(success).toBe(207);
        expect(duplicate).toBe(2);
        expect(failed).toBe(1);
        expect(total).toBe(210);
        expect(success + failed + duplicate).toBe(total);

        // Verify no raw DB exceptions are returned in the errors array
        const errors = updatedLog.errors || [];
        errors.forEach(e => {
            if (e.reason.includes('Duplicate')) {
                expect(e.reason).toBe('Duplicate: mobile number already exists');
            } else {
                expect(e.reason).not.toContain('violates unique constraint');
                expect(e.reason).not.toContain('database');
            }
        });

        // Verify the database contains the correct count of records
        const dbRecords = await query('SELECT * FROM raw_data WHERE csv_batch_id = $1', [batchId]);
        expect(dbRecords.rows).toHaveLength(207);
    }, 30000);
});
