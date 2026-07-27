import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import http from 'http';
import app from '../../../server/src/app.js';

describe('SSE Integration', () => {
  let adminToken = '';

  beforeAll(async () => {
    try {
      const loginRes = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'admin@gmail.com', password: 'admin123' });
      adminToken = loginRes.body.data.accessToken;
    } catch (err) {
      console.error('Failed to login during setup', err.message);
    }
  });

  it('keeps connection alive and responds with event-stream headers', async () => {
    // 1. Start express app on an ephemeral port
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    // 2. Make the HTTP request using native http.get
    await new Promise((resolve, reject) => {
      const options = {
        hostname: '127.0.0.1',
        port: port,
        path: '/api/v1/assignments/stream',
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${adminToken}`
        }
      };

      const req = http.request(options, (res) => {
        try {
          expect(res.statusCode).toBe(200);
          expect(res.headers['content-type']).toContain('text/event-stream');
          expect(res.headers['connection']).toBe('keep-alive');
          expect(res.headers['cache-control']).toContain('no-cache');
          
          // Clean up: destroy client connection and close server
          req.destroy();
          server.close(() => {
            resolve();
          });
        } catch (err) {
          req.destroy();
          server.close(() => {
            reject(err);
          });
        }
      });

      req.on('error', (err) => {
        // Native request may throw an ECONNRESET when we destroy it, which we ignore
        if (err.code === 'ECONNRESET') {
          resolve();
          return;
        }
        server.close(() => {
          reject(err);
        });
      });

      req.end();
    });
  });

  describe('SSE Tickets Handshake Flow', () => {
    it('allows an authenticated user to request a short-lived connection ticket', async () => {
      const res = await request(app)
        .post('/api/v1/assignments/stream/ticket')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(typeof res.body.ticket).toBe('string');
    });

    it('allows establishing an SSE stream using the connection ticket', async () => {
      // 1. Get ticket
      const ticketRes = await request(app)
        .post('/api/v1/assignments/stream/ticket')
        .set('Authorization', `Bearer ${adminToken}`);
      const ticket = ticketRes.body.ticket;

      // 2. Start server
      const server = http.createServer(app);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;

      // 3. Request stream with ticket
      await new Promise((resolve, reject) => {
        const options = {
          hostname: '127.0.0.1',
          port: port,
          path: `/api/v1/assignments/stream?ticket=${ticket}`,
          method: 'GET'
        };

        const req = http.request(options, (res) => {
          try {
            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toContain('text/event-stream');
            req.destroy();
            server.close(() => resolve());
          } catch (err) {
            req.destroy();
            server.close(() => reject(err));
          }
        });

        req.on('error', (err) => {
          if (err.code === 'ECONNRESET') {
            resolve();
            return;
          }
          server.close(() => reject(err));
        });

        req.end();
      });
    });

    it('rejects reusing the same ticket twice (single-use check)', async () => {
      // 1. Get ticket
      const ticketRes = await request(app)
        .post('/api/v1/assignments/stream/ticket')
        .set('Authorization', `Bearer ${adminToken}`);
      const ticket = ticketRes.body.ticket;

      // 2. Start server
      const server = http.createServer(app);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;

      // 3. Connect first time (should succeed)
      await new Promise((resolve, reject) => {
        const options = {
          hostname: '127.0.0.1',
          port: port,
          path: `/api/v1/assignments/stream?ticket=${ticket}`,
          method: 'GET'
        };

        const req = http.request(options, (res) => {
          try {
            expect(res.statusCode).toBe(200);
            req.destroy();
            resolve();
          } catch (err) {
            req.destroy();
            reject(err);
          }
        });

        req.on('error', (err) => {
          if (err.code === 'ECONNRESET') {
            resolve();
            return;
          }
          reject(err);
        });

        req.end();
      });

      // 4. Connect second time (should be invalid/used)
      const res = await request(app)
        .get(`/api/v1/assignments/stream?ticket=${ticket}`)
        .expect(401);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('used');

      await new Promise((resolve) => server.close(resolve));
    });

    it('rejects an invalid sse ticket', async () => {
      const res = await request(app)
        .get('/api/v1/assignments/stream?ticket=invalid-ticket-value')
        .expect(401);

      expect(res.body.success).toBe(false);
    });
  });
});
