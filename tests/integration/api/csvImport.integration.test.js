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
});
