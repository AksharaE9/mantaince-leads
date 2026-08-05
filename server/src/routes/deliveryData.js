import express from 'express';
import multer from 'multer';
import {
  getDeliveryData,
  createDeliveryData,
  downloadDeliveryDataTemplate,
  getDeliveryDataSchema,
  uploadDeliveryDataCsv,
  exportDeliveryDataCsv,
} from '../controllers/deliveryData.js';
import { getCsvLogs, getCsvLogById, streamFailedRows } from '../controllers/csv.js';
import authenticate from '../middleware/authenticate.js';
import attachRole from '../middleware/attachRole.js';
import checkPermission from '../middleware/checkPermission.js';
import { rateLimiter } from '../middleware/rateLimit.js';
import { MAX_CSV_FILE_SIZE_MB } from '../config/env.js';

const router = express.Router();

// Same allow-list as the Leads/Raw Data import (see routes/rawData.js) —
// extension is the trusted signal, MIME is only used to reject obvious
// mismatches, since browsers report inconsistent MIME types for .csv.
const IMPORT_FILE_EXTENSIONS = new Set(['.csv', '.xlsx', '.xls']);
const OBVIOUSLY_WRONG_MIME_PREFIXES = ['image/', 'video/', 'audio/', 'application/pdf', 'application/zip', 'application/x-msdownload'];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CSV_FILE_SIZE_MB * 1024 * 1024 },
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

router.use(authenticate);
router.use(attachRole);

// Same permission keys as Raw Data — Delivery Data is gated identically to
// Leads/Raw Data rather than a new permission key, so no existing role
// needs a manual grant to use it (see RBAC note in CLAUDE.md).
router.get('/', checkPermission(['leads:read', 'leads:read_own']), getDeliveryData);
router.post('/', checkPermission('leads:create'), createDeliveryData);
router.get('/export/csv', checkPermission(['leads:read', 'leads:read_own']), exportDeliveryDataCsv);

router.get('/import-template', checkPermission('csv:template'), downloadDeliveryDataTemplate);
router.get('/schema', checkPermission('csv:template'), getDeliveryDataSchema);
router.post('/upload', checkPermission('csv:upload'), rateLimiter('delivery_data_csv_upload', 20, 3600), upload.single('file'), uploadDeliveryDataCsv);

// The csv_upload_logs status/log/error-report endpoints are entity-agnostic
// (they key off batchId, not entity_type) — reused as-is, no duplication.
router.get('/upload-logs', checkPermission('csv:logs'), getCsvLogs);
router.get('/upload-logs/:batchId', checkPermission(['csv:logs', 'csv:upload']), getCsvLogById);
router.get('/upload-logs/:batchId/failed-rows', checkPermission(['csv:logs', 'csv:upload']), streamFailedRows);

export default router;
