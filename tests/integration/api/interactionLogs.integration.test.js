import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../../server/src/app.js';
import { query } from '../../../server/src/config/db.js';
import crypto from 'crypto';

describe('Interaction Logs & Bulk Follow-up imports', () => {
    let adminToken = '';
    let verticalId = '';
    let subVerticalId = '';
    let agentId = '';
    let leadId = '';
    const leadPhone = '9991112222';

    beforeAll(async () => {
        // Log in
        const loginRes = await request(app)
            .post('/api/v1/auth/login')
            .send({ email: 'adminofleads@gmail.com', password: 'hile@dsbase@123' });
        adminToken = loginRes.body.data?.accessToken;

        // Fetch User ID
        const agentRes = await query("SELECT id FROM users WHERE email = 'adminofleads@gmail.com'");
        agentId = agentRes.rows[0].id;

        // Create Vertical
        const vertRes = await request(app)
            .post('/api/v1/verticals')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ name: `Interaction Test Vert ${Date.now()}` });
        verticalId = vertRes.body.data?.id;

        // Ensure vertical access
        await query('UPDATE users SET vertical_access = array_append(vertical_access, $1) WHERE id = $2', [verticalId, agentId]);

        // Create Sub-vertical
        const subRes = await request(app)
            .post(`/api/v1/verticals/${verticalId}/sub-verticals`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ name: 'Test Sub-Vertical' });
        subVerticalId = subRes.body.data?.id;

        // Create a Lead (COS)
        const leadRes = await request(app)
            .post('/api/v1/cost-conversions')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
                verticalId,
                subVerticalId,
                name: 'Test Business Inc',
                phone: leadPhone,
                businessName: 'Test Business Inc',
                status: 'new',
                leadType: 'CALL',
                data: {}
            })
            .expect(201);
        leadId = leadRes.body.data?.id;
    });

    afterAll(async () => {
        if (verticalId) {
            await query('DELETE FROM lead_interaction_logs WHERE lead_id IN (SELECT id FROM cost_conversions WHERE vertical_id = $1)', [verticalId]);
            await query('DELETE FROM cost_conversions WHERE vertical_id = $1', [verticalId]);
            await query('DELETE FROM sub_verticals WHERE vertical_id = $1', [verticalId]);
            await query('DELETE FROM csv_upload_logs WHERE vertical_id = $1', [verticalId]);
            await query('UPDATE users SET vertical_access = array_remove(vertical_access, $1) WHERE id = $2', [verticalId, agentId]);
            await request(app).delete(`/api/v1/verticals/${verticalId}`).set('Authorization', `Bearer ${adminToken}`);
        }
    });

    it('creates, reads, summarizes, and deletes single interaction log entries', async () => {
        // 1. Create entry
        const createRes = await request(app)
            .post(`/api/v1/interactionLogs/leads/${leadId}/interaction-logs`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
                interactionDate: '2026-08-22',
                interactionTime: '11:00 AM',
                remarks: 'Call 1: Spoke with owner, interested in product',
                outcome: 'Interested',
                nextFollowupDate: '2026-08-25',
                recordedByName: 'Super Admin'
            })
            .expect(201);

        const logId = createRes.body.data?.id;
        expect(logId).toBeDefined();

        // 2. Fetch list
        const listRes = await request(app)
            .get(`/api/v1/interactionLogs/leads/${leadId}/interaction-logs`)
            .set('Authorization', `Bearer ${adminToken}`)
            .expect(200);

        expect(listRes.body.data.length).toBe(1);
        expect(listRes.body.data[0].remarks).toBe('Call 1: Spoke with owner, interested in product');
        expect(listRes.body.data[0].outcome).toBe('Interested');

        // 3. Fetch summary
        const summaryRes = await request(app)
            .get(`/api/v1/interactionLogs/leads/${leadId}/interaction-logs/summary`)
            .set('Authorization', `Bearer ${adminToken}`)
            .expect(200);

        expect(summaryRes.body.data.count).toBe(1);
        expect(summaryRes.body.data.lastOutcome).toBe('Interested');

        // 4. Batch counts
        const batchCountsRes = await request(app)
            .post('/api/v1/interactionLogs/leads/batch-counts')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ leadIds: [leadId] })
            .expect(200);

        expect(batchCountsRes.body.data[leadId]).toBe(1);

        // 5. Delete entry
        await request(app)
            .delete(`/api/v1/interactionLogs/interaction-logs/${logId}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .expect(200);

        // Verify list is empty again
        const listAfterRes = await request(app)
            .get(`/api/v1/interactionLogs/leads/${leadId}/interaction-logs`)
            .set('Authorization', `Bearer ${adminToken}`);
        expect(listAfterRes.body.data.length).toBe(0);
    });

    it('processes bulk upload with multi-row same phone inline interactions', async () => {
        // Upload a CSV with 3 rows sharing the same phone
        // Row 1: creates the lead + initial interaction
        // Row 2 & 3: append additional interactions
        const csv = 
            'DATE,EMPLOYEE NAME,BUSINESS TYPE,BUSINESS / PERSON / SHOP / COMPANY NAME,AREA,CITY,CONTACT,MAP LOCATION LINK / ADDRESS,REQUIREMENT,REMARKS,FOLLOW UP REQUIRE (YES/NO),FOLLOW UP DATE,FOLLOW UP REMARKS,Follow-up Date,Follow-up Time,Follow-up Remarks,Follow-up Outcome,Next Follow-up Date\n' +
            `2026-08-22,Super Admin,Retail,MultiRowBiz,Whitefield,Bengaluru,9991113333,123 Main St,Units,Initial Lead creation,Yes,2026-08-25,Call back,2026-08-22,10:00 AM,Call 1: Spoke,Interested,2026-08-23\n` +
            `,,,,,,9991113333,,,,,,,2026-08-23,11:00 AM,Call 2: No answer,Not Reachable,2026-08-24\n` +
            `,,,,,,9991113333,,,,,,,2026-08-24,12:00 PM,Call 3: Spoke again,Callback Requested,2026-08-25\n`;


        const uploadRes = await request(app)
            .post('/api/v1/cost-conversions/csv/upload')
            .set('Authorization', `Bearer ${adminToken}`)
            .field('verticalId', verticalId)
            .field('subVerticalId', subVerticalId)
            .field('leadType', 'CALL')
            .attach('file', Buffer.from(csv), { filename: 'multi_row_interactions.csv', contentType: 'text/csv' })
            .expect(202);

        const batchId = uploadRes.body.data.batchId;
        expect(batchId).toBeDefined();

        let logRow = (await query('SELECT * FROM csv_upload_logs WHERE id = $1', [batchId])).rows[0];
        const filePath = `./server/uploads/${logRow.file_name}`;
        if (logRow.status === 'queued') {
            await query("UPDATE csv_upload_logs SET status = 'processing' WHERE id = $1", [batchId]);
            const buffer = fs.readFileSync(filePath);
            const mockJob = {
                data: {
                    batchId,
                    fileBufferBase64: buffer.toString('base64'),
                    verticalId,
                    subVerticalId,
                    uploadedBy: agentId,
                    leadType: 'CALL',
                    fileExt: '.csv'
                },
                progress: async () => {}
            };
            const { processCsvJob } = await import('../../../server/src/jobs/csvProcessor.js');
            await processCsvJob(mockJob);
        } else {
            // Wait for background worker
            for (let k = 0; k < 30; k++) {
                logRow = (await query('SELECT * FROM csv_upload_logs WHERE id = $1', [batchId])).rows[0];
                if (logRow.status === 'done' || logRow.status === 'failed') break;
                await new Promise(r => setTimeout(r, 500));
            }
        }

        // Fetch the created lead
        const leadDbRes = await query('SELECT id FROM cost_conversions WHERE phone = $1 AND vertical_id = $2 AND is_deleted = false', ['9991113333', verticalId]);
        expect(leadDbRes.rows.length).toBe(1);
        const newLeadId = leadDbRes.rows[0].id;

        // Fetch the interaction logs for this lead
        const logsRes = await query('SELECT * FROM lead_interaction_logs WHERE lead_id = $1 ORDER BY interaction_date ASC', [newLeadId]);
        // Expect 3 interaction logs!
        expect(logsRes.rows.length).toBe(3);

        expect(logsRes.rows[0].remarks).toBe('Call 1: Spoke');
        expect(logsRes.rows[0].outcome).toBe('Interested');
        expect(logsRes.rows[1].remarks).toBe('Call 2: No answer');
        expect(logsRes.rows[1].outcome).toBe('Not Reachable');
        expect(logsRes.rows[2].remarks).toBe('Call 3: Spoke again');
        expect(logsRes.rows[2].outcome).toBe('Callback Requested');

        // Cleanup local file
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    });

    it('processes dedicated follow-ups-only template upload', async () => {
        // Dedicated template fields: Contact Number, Follow-up Date, Follow-up Time, Follow-up Remarks, Follow-up Outcome, Next Follow-up Date
        const csv =
            'Contact Number,Follow-up Date,Follow-up Time,Follow-up Remarks,Follow-up Outcome,Next Follow-up Date\n' +
            `${leadPhone},2026-08-22,02:00 PM,Call from dedicated import,Interested,2026-08-26\n`;

        const uploadRes = await request(app)
            .post('/api/v1/interactionLogs/csv/upload')
            .set('Authorization', `Bearer ${adminToken}`)
            .field('verticalId', verticalId)
            .field('subVerticalId', subVerticalId)
            .field('leadType', 'CALL')
            .attach('file', Buffer.from(csv), { filename: 'followups_dedicated.csv', contentType: 'text/csv' })
            .expect(202);

        const batchId = uploadRes.body.data.batchId;
        expect(batchId).toBeDefined();

        let logRow = (await query('SELECT * FROM csv_upload_logs WHERE id = $1', [batchId])).rows[0];
        const filePath = `./server/uploads/${logRow.file_name}`;
        if (logRow.status === 'queued') {
            await query("UPDATE csv_upload_logs SET status = 'processing' WHERE id = $1", [batchId]);
            const buffer = fs.readFileSync(filePath);
            const mockJob = {
                data: {
                    batchId,
                    fileBufferBase64: buffer.toString('base64'),
                    verticalId,
                    subVerticalId,
                    uploadedBy: agentId,
                    leadType: 'CALL',
                    fileExt: '.csv'
                },
                progress: async () => {}
            };
            const { processInteractionLogJob } = await import('../../../server/src/jobs/interactionLogProcessor.js');
            await processInteractionLogJob(mockJob);
        } else {
            // Wait for background worker
            for (let k = 0; k < 30; k++) {
                logRow = (await query('SELECT * FROM csv_upload_logs WHERE id = $1', [batchId])).rows[0];
                if (logRow.status === 'done' || logRow.status === 'failed') break;
                await new Promise(r => setTimeout(r, 500));
            }
        }

        // Fetch logs for the existing lead
        const logsRes = await query('SELECT * FROM lead_interaction_logs WHERE lead_id = $1 AND source = $2', [leadId, 'bulk_upload']);
        expect(logsRes.rows.length).toBe(1);
        expect(logsRes.rows[0].remarks).toBe('Call from dedicated import');
        expect(logsRes.rows[0].outcome).toBe('Interested');

        // Cleanup local file
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    });
});

import fs from 'fs';
