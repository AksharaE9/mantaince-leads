import express from 'express';
import multer from 'multer';
import { MAX_CSV_FILE_SIZE_MB } from '../config/env.js';
import {
    getInteractionLogs,
    getInteractionLogSummary,
    createInteractionLog,
    deleteInteractionLog,
    getInteractionLogBatchCounts,
    exportInteractionLogsCsv,
    downloadInteractionLogsTemplate,
    uploadInteractionLogsCsv,
} from '../controllers/leadInteractionLogs.js';
import authenticate from '../middleware/authenticate.js';
import attachRole from '../middleware/attachRole.js';
import checkPermission from '../middleware/checkPermission.js';

const IMPORT_FILE_EXTENSIONS = new Set(['.csv', '.xlsx', '.xls']);
const OBVIOUSLY_WRONG_MIME_PREFIXES = ['image/', 'video/', 'audio/', 'application/pdf', 'application/zip', 'application/x-msdownload'];
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: (MAX_CSV_FILE_SIZE_MB || 10) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = (file.originalname.match(/\.[^.]+$/)?.[0] || '').toLowerCase();
    const looksWrong = OBVIOUSLY_WRONG_MIME_PREFIXES.some(p => file.mimetype.startsWith(p));
    if (!IMPORT_FILE_EXTENSIONS.has(ext) || looksWrong) {
      const err = new Error('Only .csv, .xlsx, or .xls files are accepted');
      err.status = 400;
      return cb(err);
    }
    cb(null, true);
  }
});

const router = express.Router();

router.use(authenticate);
router.use(attachRole);

// ── Per-lead interaction log endpoints ─────────────────────────────────────────
// Mounted at /api/v1/interactionLogs; routes are /leads/:leadId/interaction-logs
// to mirror the established /api/v1/followUps/leads/:id/follow-ups convention.

// List all interaction logs for one lead (newest first)
router.get('/leads/:leadId/interaction-logs',
    checkPermission(['leads:read', 'leads:read_own']),
    getInteractionLogs
);

// Lightweight summary: count, lastInteractionDate, lastOutcome — for badges
router.get('/leads/:leadId/interaction-logs/summary',
    checkPermission(['leads:read', 'leads:read_own']),
    getInteractionLogSummary
);

// Create a single interaction log entry (from the detail page UI)
router.post('/leads/:leadId/interaction-logs',
    checkPermission(['leads:update', 'leads:update_own']),
    createInteractionLog
);

// Delete a single entry — admin or self only (enforced inside the controller)
router.delete('/interaction-logs/:id',
    checkPermission(['leads:update', 'leads:update_own']),
    deleteInteractionLog
);

// ── Batch count endpoint for list-view badges ──────────────────────────────────
// POST body: { leadIds: string[] }  →  { [leadId]: count }
// POST (not GET) because the lead IDs are an arbitrary array, not a querystring.
router.post('/leads/batch-counts',
    checkPermission(['leads:read', 'leads:read_own']),
    getInteractionLogBatchCounts
);

// ── Export ─────────────────────────────────────────────────────────────────────
// Separate CSV export — one-to-many doesn't flatten onto the main lead export.
// Mirrors the existing Follow-ups export at /followUps/verticals/:id/export/csv.
router.get('/export/csv',
    checkPermission(['leads:read', 'leads:read_own']),
    exportInteractionLogsCsv
);

// ── Dedicated Bulk Upload ──────────────────────────────────────────────────────
router.get('/csv/template/:verticalId',
    checkPermission('csv:template'),
    downloadInteractionLogsTemplate
);

router.post('/csv/upload',
    checkPermission('csv:upload'),
    csvUpload.single('file'),
    uploadInteractionLogsCsv
);

export default router;
