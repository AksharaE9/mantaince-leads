import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../../server/src/app.js';
import { query } from '../../../server/src/config/db.js';

describe('Bulk lead-import API (CSV/Excel) — regression coverage', () => {
  let adminToken = '';
  let verticalId = '';
  let subVerticalId = '';

  beforeAll(async () => {
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@gmail.com', password: 'admin123' });
    adminToken = loginRes.body.data?.accessToken;

    const vertRes = await request(app)
      .post('/api/v1/verticals')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `CSV Import Test ${Date.now()}` });
    verticalId = vertRes.body.data?.id;

    const subRes = await request(app)
      .post(`/api/v1/verticals/${verticalId}/sub-verticals`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Default' });
    subVerticalId = subRes.body.data?.id;
  });

  afterAll(async () => {
    if (verticalId) {
      await query('DELETE FROM verticals WHERE id = $1', [verticalId]);
    }
  });

  describe('GET /api/v1/leads (list/filter) — Bug A regression', () => {
    it('returns 200 when signedTo/search/status are all omitted', async () => {
      const res = await request(app)
        .get(`/api/v1/leads?verticalId=${verticalId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('returns 200 when assignedTo and search are empty strings, not 500', async () => {
      const res = await request(app)
        .get(`/api/v1/leads?verticalId=${verticalId}&assignedTo=&search=&status=`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(res.body.success).toBe(true);
    });

    it('returns 200 for a valid, real filter combination', async () => {
      const res = await request(app)
        .get(`/api/v1/leads?verticalId=${verticalId}&status=new&search=test`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(res.body.success).toBe(true);
    });

    it('returns 401 for unauthenticated requests, not a 500', async () => {
      await request(app)
        .get(`/api/v1/leads?verticalId=${verticalId}&assignedTo=&search=`)
        .expect(401);
    });
  });

  describe('POST /api/v1/leads/csv/upload — Bug B/C regression', () => {
    it('rejects a non-csv/xlsx file with a clean 400, not a bare 500', async () => {
      const res = await request(app)
        .post('/api/v1/leads/csv/upload')
        .set('Authorization', `Bearer ${adminToken}`)
        .field('verticalId', verticalId)
        .field('subVerticalId', subVerticalId)
        .field('leadType', 'CALL')
        .attach('file', Buffer.from('not a spreadsheet'), { filename: 'malware.exe', contentType: 'application/x-msdownload' })
        .expect(400);
      expect(res.body.success).toBe(false);
    });

    it('rejects a missing verticalId with 400, not 500', async () => {
      const res = await request(app)
        .post('/api/v1/leads/csv/upload')
        .set('Authorization', `Bearer ${adminToken}`)
        .field('subVerticalId', subVerticalId)
        .attach('file', Buffer.from('name,phone\nTest,9876543210\n'), { filename: 'leads.csv', contentType: 'text/csv' })
        .expect(400);
      expect(res.body.success).toBe(false);
    });

    it('rejects a malformed verticalId (not a UUID) with 400, not 500', async () => {
      const res = await request(app)
        .post('/api/v1/leads/csv/upload')
        .set('Authorization', `Bearer ${adminToken}`)
        .field('verticalId', 'not-a-uuid')
        .field('subVerticalId', subVerticalId)
        .attach('file', Buffer.from('name,phone\nTest,9876543210\n'), { filename: 'leads.csv', contentType: 'text/csv' })
        .expect(400);
      expect(res.body.success).toBe(false);
    });

    it('accepts a well-formed CSV upload and queues it (202)', async () => {
      const csv = 'BUSINESS / PERSON / SHOP / COMPANY NAME,CONTACT NUMBER\nAcme Traders,9876543210\n';
      const res = await request(app)
        .post('/api/v1/leads/csv/upload')
        .set('Authorization', `Bearer ${adminToken}`)
        .field('verticalId', verticalId)
        .field('subVerticalId', subVerticalId)
        .field('leadType', 'CALL')
        .attach('file', Buffer.from(csv), { filename: 'leads.csv', contentType: 'text/csv' })
        .expect(202);
      expect(res.body.success).toBe(true);
      expect(res.body.data.batchId).toBeTruthy();
    });

    it('accepts a well-formed .xlsx upload and queues it (202)', async () => {
      // Build the .xlsx via the app's own template builder (server/src/services)
      // rather than importing exceljs directly here — exceljs lives in
      // server/node_modules and isn't resolvable as a bare specifier from
      // the tests/ directory.
      const { buildXlsxTemplate } = await import('../../../server/src/services/leadImportTemplate.js');
      const minimalSchema = [
        { key: 'businessName', label: 'BUSINESS / PERSON / SHOP / COMPANY NAME', csvHeader: 'BUSINESS / PERSON / SHOP / COMPANY NAME', type: 'string', required: true },
        { key: 'phone', label: 'CONTACT NUMBER', csvHeader: 'CONTACT NUMBER', type: 'phone', required: true },
      ];
      const workbook = await buildXlsxTemplate(minimalSchema, [], { businessName: 'Acme Traders', phone: '9876543211' });
      const buffer = await workbook.xlsx.writeBuffer();

      const res = await request(app)
        .post('/api/v1/leads/csv/upload')
        .set('Authorization', `Bearer ${adminToken}`)
        .field('verticalId', verticalId)
        .field('subVerticalId', subVerticalId)
        .field('leadType', 'CALL')
        .attach('file', Buffer.from(buffer), { filename: 'leads.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
        .expect(202);
      expect(res.body.success).toBe(true);
      expect(res.body.data.batchId).toBeTruthy();
    });
  });

  describe('GET /api/v1/leads/csv/template/:verticalId — dynamic template', () => {
    it('generates a CSV template on the fly', async () => {
      const res = await request(app)
        .get(`/api/v1/leads/csv/template/${verticalId}?leadType=CALL`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.text).toContain('CONTACT NUMBER');
    });

    it('generates an .xlsx template on the fly', async () => {
      const res = await request(app)
        .get(`/api/v1/leads/csv/template/${verticalId}?leadType=CALL&format=xlsx`)
        .set('Authorization', `Bearer ${adminToken}`)
        .buffer(true)
        .parse((res, cb) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(res.headers['content-type']).toContain('spreadsheetml');
      expect(res.body.length).toBeGreaterThan(0);
    });
  });

  describe('GET /api/v1/leads/csv/schema/:verticalId — shared schema endpoint', () => {
    it('returns the field schema used by both template and validator', async () => {
      const res = await request(app)
        .get(`/api/v1/leads/csv/schema/${verticalId}?leadType=CALL`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.fields)).toBe(true);
      expect(res.body.data.fields.some((f) => f.key === 'phone' && f.required)).toBe(true);
    });
  });

  describe('Agent access to CSV upload logs by ID', () => {
    let agentToken = '';
    let agentUserId = '';
    const mockBatchId = '00000000-0000-0000-0000-111122223333';
    const otherMockBatchId = '00000000-0000-0000-0000-444455556666';

    beforeAll(async () => {
      // Create agent user with same password as admin ('admin123')
      const adminRes = await query('SELECT password_hash FROM users WHERE email = $1', ['admin@gmail.com']);
      const adminHash = adminRes.rows[0].password_hash;
      
      const agentRoleRes = await query("SELECT id FROM roles WHERE name = 'agent'");
      const agentRoleId = agentRoleRes.rows[0].id;
      
      agentUserId = '00000000-0000-0000-0000-999988887777';
      await query(`
        INSERT INTO users (id, name, email, password_hash, role_id, is_active, is_approved, vertical_access)
        VALUES ($1, $2, $3, $4, $5, true, true, $6)
      `, [agentUserId, 'Test Agent', 'agent-test@gmail.com', adminHash, agentRoleId, [verticalId]]);

      // Login as agent
      const loginRes = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'agent-test@gmail.com', password: 'admin123' });
      agentToken = loginRes.body.data?.accessToken;

      // Insert mock CSV upload log for the agent
      await query(`
        INSERT INTO csv_upload_logs (id, uploaded_by, vertical_id, file_name, original_file_name, status)
        VALUES ($1, $2, $3, 'test.csv', 'test.csv', 'done')
      `, [mockBatchId, agentUserId, verticalId]);

      // Insert mock CSV upload log for another user (e.g. adminId)
      const adminMe = await query('SELECT id FROM users WHERE email = $1', ['admin@gmail.com']);
      const adminId = adminMe.rows[0].id;
      await query(`
        INSERT INTO csv_upload_logs (id, uploaded_by, vertical_id, file_name, original_file_name, status)
        VALUES ($1, $2, $3, 'admin.csv', 'admin.csv', 'done')
      `, [otherMockBatchId, adminId, verticalId]);
    });

    afterAll(async () => {
      await query('DELETE FROM csv_upload_logs WHERE id IN ($1, $2)', [mockBatchId, otherMockBatchId]);
      if (agentUserId) {
        await query('DELETE FROM users WHERE id = $1', [agentUserId]);
      }
    });

    it('allows an agent user to retrieve their CSV upload log status by ID', async () => {
      const res = await request(app)
        .get(`/api/v1/leads/csv/logs/${mockBatchId}`)
        .set('Authorization', `Bearer ${agentToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(mockBatchId);
    });

    it('denies an agent user from retrieving another user\'s CSV upload log status by ID', async () => {
      await request(app)
        .get(`/api/v1/leads/csv/logs/${otherMockBatchId}`)
        .set('Authorization', `Bearer ${agentToken}`)
        .expect(403);
    });

    it('allows an agent user to download failed rows for their CSV log', async () => {
      // Mock log with errors to test download
      await query(`
        UPDATE csv_upload_logs 
        SET errors = $1 
        WHERE id = $2
      `, [JSON.stringify([{ row: 2, reason: 'invalid phone', originalRow: { name: 'Acme', phone: 'bad' } }]), mockBatchId]);

      const res = await request(app)
        .get(`/api/v1/leads/csv/logs/${mockBatchId}/failed-rows`)
        .set('Authorization', `Bearer ${agentToken}`)
        .expect(200);

      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.text).toContain('ERROR REASON');
    });

    it('denies an agent user from downloading failed rows for another user\'s CSV log', async () => {
      await request(app)
        .get(`/api/v1/leads/csv/logs/${otherMockBatchId}/failed-rows`)
        .set('Authorization', `Bearer ${agentToken}`)
        .expect(403);
    });

    it('allows an admin user to retrieve any user\'s CSV upload log status by ID', async () => {
      const res = await request(app)
        .get(`/api/v1/leads/csv/logs/${mockBatchId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(mockBatchId);
    });

    it('denies an agent from listing all CSV upload logs', async () => {
      await request(app)
        .get('/api/v1/leads/csv/logs')
        .set('Authorization', `Bearer ${agentToken}`)
        .expect(403);
    });
  });
});
