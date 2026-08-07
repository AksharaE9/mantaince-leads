import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../../server/src/app.js';
import { query } from '../../../server/src/config/db.js';

// Replaces sse.integration.test.js: the SSE transport (GET /assignments/stream,
// the ticket handshake) never actually delivered data on Vercel — the legacy
// builds/routes @vercel/node config buffers whole responses instead of
// streaming them, confirmed empirically against production. GET
// /assignments/poll (backed by the realtime_events table) is the replacement;
// see assignmentBroadcaster.js and useRealtimeAssignments.js.
describe('Realtime poll endpoint', () => {
  let adminToken = '';
  let verticalId = '';
  let subVerticalId = '';

  beforeAll(async () => {
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'adminofleads@gmail.com', password: 'hile@dsbase@123' });
    adminToken = loginRes.body.data?.accessToken;

    const vertRes = await request(app)
      .post('/api/v1/verticals')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `Poll Test ${Date.now()}` });
    verticalId = vertRes.body.data?.id;

    const svRes = await request(app)
      .post(`/api/v1/verticals/${verticalId}/sub-verticals`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Standard' });
    subVerticalId = svRes.body.data?.id;
  });

  afterAll(async () => {
    if (verticalId) {
      await query('DELETE FROM cost_conversions WHERE vertical_id = $1', [verticalId]);
      await request(app).delete(`/api/v1/verticals/${verticalId}`).set('Authorization', `Bearer ${adminToken}`);
    }
  });

  it('rejects an unauthenticated poll request', async () => {
    await request(app).get('/api/v1/assignments/poll').expect(401);
  });

  it('with no sinceId, returns a baseline cursor and no events', async () => {
    const res = await request(app)
      .get('/api/v1/assignments/poll')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(typeof res.body.data.latestId).toBe('number');
    expect(res.body.data.events).toEqual([]);
  });

  it('a real mutation (lead create) is visible as an event after its sinceId cursor', async () => {
    const baseline = await request(app)
      .get('/api/v1/assignments/poll')
      .set('Authorization', `Bearer ${adminToken}`);
    const sinceId = baseline.body.data.latestId;

    const createRes = await request(app)
      .post('/api/v1/leads')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Poll Event Test Lead',
        phone: '9800000010',
        verticalId,
        subVerticalId,
        leadType: 'CALL',
      });
    expect(createRes.status).toBe(201);

    const polled = await request(app)
      .get(`/api/v1/assignments/poll?sinceId=${sinceId}&verticalId=${verticalId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(polled.body.data.latestId).toBeGreaterThan(sinceId);
    const match = polled.body.data.events.find(
      (e) => e.type === 'COST_CONVERSION_MUTATED' && e.verticalId === verticalId
    );
    expect(match).toBeTruthy();
  });

  it('polling again with the new cursor returns no repeated events', async () => {
    const first = await request(app)
      .get('/api/v1/assignments/poll')
      .set('Authorization', `Bearer ${adminToken}`);
    const latestId = first.body.data.latestId;

    const second = await request(app)
      .get(`/api/v1/assignments/poll?sinceId=${latestId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(second.body.data.events).toEqual([]);
    expect(second.body.data.latestId).toBe(latestId);
  });
});
