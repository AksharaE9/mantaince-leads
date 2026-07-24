import express from 'express';
import multer from 'multer';
import {
  getRawData,
  createRawData,
  downloadRawDataTemplate,
  getRawDataSchema,
  uploadRawDataCsv,
} from '../controllers/rawData.js';
import { getCsvLogs, getCsvLogById, streamFailedRows } from '../controllers/csv.js';
import authenticate from '../middleware/authenticate.js';
import attachRole from '../middleware/attachRole.js';
import checkPermission from '../middleware/checkPermission.js';

const router = express.Router();

// Same allow-list as the Leads import (see routes/costConversions.js) —
// extension is the trusted signal, MIME is only used to reject obvious
// mismatches, since browsers report inconsistent MIME types for .csv.
const IMPORT_FILE_EXTENSIONS = new Set(['.csv', '.xlsx', '.xls']);
const OBVIOUSLY_WRONG_MIME_PREFIXES = ['image/', 'video/', 'audio/', 'application/pdf', 'application/zip', 'application/x-msdownload'];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
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

// Same permission keys as Add Lead / Import CSV — see investigation notes:
// raw_data is gated identically to Leads rather than a new permission key,
// so no existing role needs a manual grant to use it.
router.get('/', checkPermission(['leads:read', 'leads:read_own']), getRawData);
router.post('/', checkPermission('leads:create'), createRawData);

router.get('/import-template', checkPermission('csv:template'), downloadRawDataTemplate);
router.get('/schema', checkPermission('csv:template'), getRawDataSchema);
router.post('/upload', checkPermission('csv:upload'), upload.single('file'), uploadRawDataCsv);

// The csv_upload_logs status/log/error-report endpoints are entity-agnostic
// (they key off batchId, not entity_type) — reused as-is, no duplication.
router.get('/upload-logs', checkPermission('csv:logs'), getCsvLogs);
router.get('/upload-logs/:batchId', checkPermission('csv:logs'), getCsvLogById);
router.get('/upload-logs/:batchId/failed-rows', checkPermission('csv:logs'), streamFailedRows);

export default router;
