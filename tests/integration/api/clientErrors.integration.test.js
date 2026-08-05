import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../../server/src/app.js';
import { query } from '../../../server/src/config/db.js';

// Covers /api/v1/client-errors — the persisted-report sink for the
// "request never reached the server" failure class (network drop, CORS
// block, timeout), fired by client/src/utils/networkError.js. Server-side
// request logging cannot capture this failure class by definition (the
// request that failed never arrived), so this is the only place it's ever
// recorded — must work with or without a valid session, since the whole
// point is reporting that the client's normal authenticated request just
// failed.
describe('POST /api/v1/client-errors', () => {
    let adminToken = '';
    let adminUserId = '';
    const insertedCorrelationIds = [];

    beforeAll(async () => {
        const loginRes = await request(app)
            .post('/api/v1/auth/login')
            .send({ email: 'admin@gmail.com', password: 'admin123' });
        adminToken = loginRes.body.data?.accessToken;
        const meRes = await query("SELECT id FROM users WHERE email = 'admin@gmail.com'");
        adminUserId = meRes.rows[0]?.id;
    });

    afterAll(async () => {
        if (insertedCorrelationIds.length > 0) {
            await query('DELETE FROM client_error_logs WHERE correlation_id = ANY($1)', [insertedCorrelationIds]);
        }
    });

    it('accepts a report with no Authorization header at all — must work when the client cannot authenticate', async () => {
        const correlationId = `test-anon-${Date.now()}`;
        insertedCorrelationIds.push(correlationId);

        const res = await request(app)
            .post('/api/v1/client-errors')
            .send({
                correlationId,
                url: '/api/v1/leads/csv/upload',
                method: 'post',
                message: 'Network Error',
                code: 'ERR_NETWORK',
            });

        expect(res.status).toBe(202);
        expect(res.body.success).toBe(true);

        const row = await query('SELECT * FROM client_error_logs WHERE correlation_id = $1', [correlationId]);
        expect(row.rows.length).toBe(1);
        expect(row.rows[0].user_id).toBeNull();
        expect(row.rows[0].url).toBe('/api/v1/leads/csv/upload');
        expect(row.rows[0].code).toBe('ERR_NETWORK');
    });

    it('accepts a report with an EXPIRED/malformed token — must still work, since that can be exactly what triggered the failure', async () => {
        const correlationId = `test-expired-${Date.now()}`;
        insertedCorrelationIds.push(correlationId);
        // A syntactically-plausible but unverifiable bearer token — exercises
        // the same catch path an actually-expired token would (verifyAccessToken
        // throws), without this test depending on jsonwebtoken being resolvable
        // from the repo root (it's only installed under server/node_modules).
        const invalidToken = 'not.a.validtoken';

        const res = await request(app)
            .post('/api/v1/client-errors')
            .set('Authorization', `Bearer ${invalidToken}`)
            .send({ correlationId, url: '/api/v1/leads/csv/upload', method: 'post', message: 'Network Error' });

        expect(res.status).toBe(202);
        const row = await query('SELECT user_id FROM client_error_logs WHERE correlation_id = $1', [correlationId]);
        expect(row.rows[0].user_id).toBeNull(); // invalid/expired token — anonymous, not rejected
    });

    it('attaches the user id best-effort when a valid token is present', async () => {
        const correlationId = `test-authed-${Date.now()}`;
        insertedCorrelationIds.push(correlationId);

        const res = await request(app)
            .post('/api/v1/client-errors')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ correlationId, url: '/api/v1/leads/csv/upload', method: 'post', message: 'Network Error' });

        expect(res.status).toBe(202);
        const row = await query('SELECT user_id FROM client_error_logs WHERE correlation_id = $1', [correlationId]);
        expect(row.rows[0].user_id).toBe(adminUserId);
    });

    it('never 500s even with a malformed/empty body', async () => {
        const res = await request(app).post('/api/v1/client-errors').send({});
        expect(res.status).toBe(202);
    });
});
