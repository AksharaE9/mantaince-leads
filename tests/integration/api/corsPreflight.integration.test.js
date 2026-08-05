import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../../../server/src/app.js';

// Regression coverage for the actual mechanism that broke in the reported
// incident (a real browser preflight blocked before the real request was
// ever sent) — not an indirect check on a config value. Exercises real
// OPTIONS + POST request pairs against the exported Express app, with the
// exact origin (https://mantaince-leads.vercel.app) and the exact header
// set the real browser sends (Authorization, Content-Type, X-Request-ID —
// see client/src/api/axios.js's request interceptor for where all three
// come from) against every mutating endpoint reachable cross-origin from
// the frontend. If a future change to app.js's cors() wiring, middleware
// order, or the origin allow-list ever regresses this, this test catches
// it directly rather than only observing it as a browser symptom two
// origins away.
const FRONTEND_ORIGIN = 'https://mantaince-leads.vercel.app';

const MUTATING_ENDPOINTS = [
  { path: '/api/v1/leads/csv/upload', label: 'CSV/Positives bulk upload' },
  { path: '/api/v1/leads/bulk', label: 'JSON bulk-add' },
  { path: '/api/v1/auth/refresh', label: 'auth refresh' },
  { path: '/api/v1/raw-data', label: 'Raw Data single add' },
];

describe('CORS preflight — the real frontend origin, the real header set', () => {
  it.each(MUTATING_ENDPOINTS)('$label ($path): OPTIONS preflight returns 2xx with the correct headers', async ({ path }) => {
    const res = await request(app)
      .options(path)
      .set('Origin', FRONTEND_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type,x-request-id');

    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    // Must echo the exact requesting origin (never a wildcard — credentials
    // are in play, and cors() can't legally combine '*' with credentials:true).
    expect(res.headers['access-control-allow-origin']).toBe(FRONTEND_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    // authorization and x-request-id are exactly the two headers a plain
    // Access-Control-Allow-Headers config (rather than cors()'s
    // reflect-the-request default) would most easily miss.
    expect(res.headers['access-control-allow-headers']).toContain('authorization');
    expect(res.headers['access-control-allow-headers']).toContain('x-request-id');
  });

  it('rejects a same-looking-but-wrong origin (trailing slash) — proves the match is exact, not fuzzy', async () => {
    const res = await request(app)
      .options('/api/v1/leads/csv/upload')
      .set('Origin', `${FRONTEND_ORIGIN}/`)
      .set('Access-Control-Request-Method', 'POST');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects an attacker-controlled *.vercel.app origin — proves the allow-list is not a suffix match', async () => {
    const res = await request(app)
      .options('/api/v1/leads/csv/upload')
      .set('Origin', 'https://attacker-clone.vercel.app')
      .set('Access-Control-Request-Method', 'POST');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('the actual POST also carries the correct CORS header, not just the preflight (a real gap if only OPTIONS were handled)', async () => {
    const res = await request(app)
      .post('/api/v1/leads/csv/upload')
      .set('Origin', FRONTEND_ORIGIN)
      .send({});

    // No auth provided — expect a 401, but the CORS header must still be
    // present on it (this exact class of gap — headers present on success,
    // silently absent on error paths — is what actually causes an opaque
    // "blocked by CORS policy" report for a request that in fact reached
    // the server and got a normal error response).
    expect(res.status).toBe(401);
    expect(res.headers['access-control-allow-origin']).toBe(FRONTEND_ORIGIN);
  });
});
