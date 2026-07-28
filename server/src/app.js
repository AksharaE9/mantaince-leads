import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import { PORT, CLIENT_URL } from './config/env.js';
import pool, { connectDB } from './config/db.js';
import performanceMonitor from './middleware/performance.js';
import { timingMiddleware } from './middleware/timing.js';
import { sendControllerError } from './utils/dbErrors.js';

// Route imports
import authRouter from './routes/auth.js';
import usersRouter from './routes/users.js';
import verticalsRouter from './routes/verticals.js';
import configsRouter from './routes/configs.js';
import costConversionsRouter from './routes/costConversions.js';
import escalationsRouter from './routes/escalations.js';
import auditRouter from './routes/audit.js';
import reportsRouter from './routes/reports.js';
import assignmentsRouter from './routes/assignments.js';
import adminRouter from './routes/admin.js';
import followUpsRouter from './routes/followUps.js';
import rawDataRouter from './routes/rawData.js';
import deliveryDataRouter from './routes/deliveryData.js';
import { startImportWorkerLoop } from './jobs/worker.js';
import authenticate from './middleware/authenticate.js';
import attachRole from './middleware/attachRole.js';
import checkPermission from './middleware/checkPermission.js';
import path from 'path';
import { fileURLToPath } from 'url';
import net from 'net';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// 1. Performance and Optimization Middleware
app.use(performanceMonitor);
app.use(timingMiddleware);
app.use(compression({
  threshold: 1024,
  level: 6,
  filter: (req, res) => {
    if (req.headers.accept === 'text/event-stream') {
      return false;
    }
    return compression.filter(req, res);
  }
}));

// Vary: Accept-Encoding & Security Headers
app.use((req, res, next) => {
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

console.log('✓ Compression: gzip active (threshold 1KB)');

// 2. Establish DB Connections
connectDB();

// 3. Register Security & Parsing Middlewares
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"]
    }
  }
}));

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) {
      return callback(null, true);
    }

    // Dev-only convenience: localhost/127.0.0.1 on any port. Never allowed
    // in production, since the refresh-token cookie is sameSite:'none' in
    // prod and a permissive origin check here would let any site read it
    // via a credentialed fetch.
    const isLocalhost =
      process.env.NODE_ENV !== 'production' && (
        origin.startsWith('http://localhost:') ||
        origin.startsWith('http://127.0.0.1:') ||
        origin === 'http://localhost' ||
        origin === 'http://127.0.0.1'
      );

    // Explicit allow-list of the real production frontend origin(s) only —
    // NOT a `.vercel.app` suffix match, which would let any attacker's
    // free Vercel deployment pass `credentials: true` CORS checks.
    const isAllowed =
      origin === CLIENT_URL ||
      origin === 'https://mantaince-leads.vercel.app' ||
      isLocalhost;

    if (isAllowed) {
      callback(null, true);
    } else {
      console.error(`❌ CORS blocked origin: ${origin}`);
      callback(new Error(`Not allowed by CORS: ${origin}`));
    }
  },
  credentials: true
}));

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// ETag support: enables 304 Not Modified for unchanged GET responses (browser cache)
app.set('etag', 'weak');

// MongoDB Compatibility Helper: Recursively copy 'id' to '_id' and convert snake_case to camelCase keys
const camelCaseCache = {};
const toCamelCase = (str) => {
  if (!str.includes('_')) return str;
  if (camelCaseCache[str]) return camelCaseCache[str];
  const camel = str.replace(/_([a-z])/g, (g) => g[1].toUpperCase());
  camelCaseCache[str] = camel;
  return camel;
};

const mapIdToUnderscoreId = (obj) => {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) {
    return obj.map(mapIdToUnderscoreId);
  }
  if (typeof obj === 'object') {
    if (obj.constructor && obj.constructor.name !== 'Object' && obj.constructor.name !== 'Array') {
      return obj;
    }
    const newObj = {};
    for (const key of Object.keys(obj)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      const camelKey = toCamelCase(key);
      const mappedVal = mapIdToUnderscoreId(obj[key]);
      newObj[key] = mappedVal;
      if (camelKey !== key && camelKey !== '__proto__' && camelKey !== 'constructor' && camelKey !== 'prototype') {
        newObj[camelKey] = mappedVal;
      }
    }
    if (obj.id !== undefined && obj._id === undefined) {
      newObj._id = obj.id;
    }
    return newObj;
  }
  return obj;
};

app.use((req, res, next) => {
  const originalJson = res.json;
  res.json = function (body) {
    if (body !== null && body !== undefined && typeof body === 'object') {
      if (body.success && body.data !== undefined) {
        body.data = mapIdToUnderscoreId(body.data);
      } else {
        body = mapIdToUnderscoreId(body);
      }
    }
    return originalJson.call(this, body);
  };
  next();
});

// Compression verification endpoint (placed before auth routers to avoid intercepting middlewares).
// Dev/staging diagnostic only — hidden entirely in production. The payload
// itself carries no sensitive data (a static filler string), so no
// auth/permission gate is added on top of the NODE_ENV check.
app.get('/api/v1/compression-test-payload', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ success: false, error: 'Not found' });
  }
  res.json({
    message: 'This is a large test payload to verify response compression is active on the server.',
    data: 'a'.repeat(2000)
  });
});

// 4. Register Routes
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/users', usersRouter);
app.use('/api/v1/verticals', verticalsRouter);
app.use('/api/v1/configs', configsRouter); // Support field endpoints directly
app.use('/api/v1/cost-conversions', costConversionsRouter);
// Backward-compatibility alias: /api/v1/leads → same router as /api/v1/cost-conversions
app.use('/api/v1/leads', costConversionsRouter);
app.use('/api/v1', escalationsRouter); // Mount directly to /api/v1 for standard routes
app.use('/api/v1/audit-logs', auditRouter);
app.use('/api/v1/reports', reportsRouter);
app.use('/api/v1/assignments', assignmentsRouter);
app.use('/api/v1/admin', adminRouter);
app.use('/api/v1/followUps', followUpsRouter);
app.use('/api/v1/raw-data', rawDataRouter);
app.use('/api/v1/delivery-data', deliveryDataRouter);

// Global list to store the last 50 server-side errors in memory for diagnostics
global.debugErrors = global.debugErrors || [];

// Dev/staging diagnostic only. Hidden entirely (404) in production before any
// auth work runs, and gated behind authenticate+attachRole+checkPermission
// (same pattern as other protected routes, e.g. server/src/routes/admin.js)
// for non-production environments, since it leaks stack traces, raw DB error
// detail, and env-var presence flags.
app.get(
  '/api/v1/debug-errors',
  (req, res, next) => {
    if (process.env.NODE_ENV === 'production') {
      return res.status(404).json({ success: false, error: 'Not found' });
    }
    next();
  },
  authenticate,
  attachRole,
  checkPermission('reports:read'),
  (req, res) => {
  res.status(200).json({
    success: true,
    vercel: !!process.env.VERCEL,
    env: {
      NODE_ENV: process.env.NODE_ENV,
      PGHOST: process.env.PGHOST ? 'DEFINED' : 'UNDEFINED',
      PGUSER: process.env.PGUSER ? 'DEFINED' : 'UNDEFINED',
      PGDATABASE: process.env.PGDATABASE ? 'DEFINED' : 'UNDEFINED',
      PGPORT: process.env.PGPORT ? 'DEFINED' : 'UNDEFINED',
      PORT: process.env.PORT ? 'DEFINED' : 'UNDEFINED',
      CLIENT_URL: process.env.CLIENT_URL,
      USE_RDS_IAM: process.env.USE_RDS_IAM
    },
    errors: global.debugErrors || []
  });
  }
);

// Serve static uploads with caching headers
app.use('/uploads', express.static(path.join(__dirname, '../../uploads'), {
  maxAge: '1d', // 1 day public cache
  etag: true,
  lastModified: true
}));

// Lightweight status checkpoint endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    success: true, 
    data: { 
      status: 'online', 
      time: new Date(),
      commitSha: process.env.VERCEL_GIT_COMMIT_SHA || 'local-dev',
      environment: process.env.NODE_ENV || 'development'
    } 
  });
});

app.get('/', (req, res) => {
  res.status(200).json({ success: true, message: 'LeadsBase API is operational. Access endpoints via /api/v1' });
});

// 5. Global Error Handling Middleware (Section 11 specifications)
//
// Routes through the same sendControllerError() every controller catch
// block uses (server/src/utils/dbErrors.js) — this used to duplicate that
// file's PG-error-code mapping independently (two implementations that
// could silently drift), and never attached a correlationId. The three
// cases below (file-size limit, malformed multipart, explicit 4xx) are
// genuinely specific to this being a top-level Express error handler
// (things a controller's own try/catch never sees) and stay here.
app.use((err, req, res, next) => {
  // Multer File Size Limit check
  if (err.code === 'LIMIT_FILE_SIZE') {
    return sendControllerError(res, err, 'globalErrorHandler', { status: 413, code: 'FILE_TOO_LARGE', message: 'File upload size exceeds the maximum limit (10MB).' });
  }

  // Malformed multipart body (e.g. missing/invalid boundary) — surfaces as a
  // plain busboy/multer error with no .status, not a genuine server fault.
  if (/multipart|boundary/i.test(err.message || '')) {
    return sendControllerError(res, err, 'globalErrorHandler', { status: 400, code: 'MALFORMED_UPLOAD', message: 'Malformed file upload request — please try again.' });
  }

  // Explicit 4xx raised deliberately by route/middleware logic (e.g. multer
  // fileFilter rejections) — surface the real message, not a generic 500.
  if (err.status && err.status >= 400 && err.status < 500) {
    return sendControllerError(res, err, 'globalErrorHandler', { status: err.status, code: 'REQUEST_REJECTED', message: err.message || 'Invalid request' });
  }

  return sendControllerError(res, err, 'globalErrorHandler');
});

// Register Aurora DB-backed Import Worker Loop in the server process to ensure it runs concurrently
if (process.env.NODE_ENV !== 'test' && !process.env.VERCEL) {
  console.log('👷 Centralized CSV DB-backed Queue Worker Initializing...');
  startImportWorkerLoop().catch(err => {
    console.error('❌ Failed to start CSV Import Worker Loop:', err.message);
  });
}

// ── Helper: free a TCP port by probing with a test socket ────────────────────
function isPortInUse(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once('error', () => resolve(true))
      .once('listening', () => { tester.close(); resolve(false); })
      .listen(port, '0.0.0.0');
  });
}

async function waitForPortFree(port, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const inUse = await isPortInUse(port);
    if (!inUse) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

// Start listening — with EADDRINUSE retry logic
if (process.env.NODE_ENV !== 'test' && !process.env.VERCEL) {
  let server;

  // Helper: immediately kill any process holding PORT
  const forceKillPort = () => {
    try {
      const output = execSync('netstat -ano', { encoding: 'utf8' });
      const pids = new Set();
      for (const line of output.split('\n')) {
        if (line.includes(`:${PORT}`) && line.includes('LISTENING')) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && /^\d+$/.test(pid)) pids.add(pid);
        }
      }
      for (const pid of pids) {
        try {
          execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
          console.log(`✅ Freed port ${PORT} (killed PID ${pid})`);
        } catch (_) {}
      }
    } catch (_) {}
  };

  const startServer = async (attempt = 1) => {
    if (attempt > 3) {
      console.error(`❌ Could not start server on port ${PORT} after 3 attempts. Exiting.`);
      process.exit(1);
    }

    const inUse = await isPortInUse(PORT);
    if (inUse) {
      console.warn(`⚠️  Port ${PORT} busy (attempt ${attempt}). Killing conflicting process...`);
      forceKillPort();
      // Wait for OS to release the socket
      await new Promise(r => setTimeout(r, 1000));
    }

    server = app.listen(PORT, () => {
      console.log(`🚀 LeadsBase API Listening in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`);
    });

    server.on('error', async (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`❌ EADDRINUSE on port ${PORT} (attempt ${attempt}). Killing and retrying...`);
        server.close();
        forceKillPort();
        await new Promise(r => setTimeout(r, 1500));
        await startServer(attempt + 1);
      } else {
        throw err;
      }
    });
  };

  await startServer();

  // Graceful shutdown handler
  const shutdown = async (signal) => {
    console.log(`🛑 ${signal} received — shutting down gracefully...`);

    // 1. Close HTTP server — stop accepting new connections
    if (server) {
      server.close(() => console.log('HTTP server closed.'));
    }

    // For nodemon SIGUSR2 — exit immediately so the port is released before restart
    if (signal === 'SIGUSR2') {
      console.log('Nodemon restart: exiting now to free port.');
      // Give server.close() ~100ms to actually free the socket
      await new Promise(r => setTimeout(r, 100));
      process.exit(0);
    }

    // 3. Close database connection pool (with 1s timeout)
    try {
      if (pool && typeof pool.end === 'function') {
        await Promise.race([
          pool.end(),
          new Promise(resolve => setTimeout(resolve, 1000))
        ]);
        console.log('Database connection pool closed.');
      }
    } catch (err) {
      console.error('Failed to close database pool:', err.message);
    }

    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.once('SIGUSR2', () => shutdown('SIGUSR2'));
}

export default app;
export { app };
