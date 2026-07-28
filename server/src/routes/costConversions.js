import express from 'express';
import multer from 'multer';
import { 
  getCostConversions, 
  createCostConversion, 
  createCostConversionBulk,
  getCostConversionById, 
  updateCostConversion, 
  deleteCostConversion, 
  updateCostConversionStatus, 
  assignCostConversion, 
  exportCostConversionsCsv,
  uploadCostConversionPhoto
} from '../controllers/costConversions.js';
import {
  downloadCsvTemplate,
  getImportSchema,
  uploadCsv,
  getCsvLogs,
  getCsvLogById,
  streamFailedRows
} from '../controllers/csv.js';
import authenticate from '../middleware/authenticate.js';
import attachRole from '../middleware/attachRole.js';
import checkPermission from '../middleware/checkPermission.js';
import { rateLimiter } from '../middleware/rateLimit.js';

const router = express.Router();

// M9: geotag photo uploads only — unlike csvUpload below, this previously had
// no fileFilter at all, so any file type (including .svg/.html) could be
// uploaded and later served back as stored content (stored-XSS risk).
// Restricted to the standard raster image types the photo-capture UI
// actually produces.
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB file limit
  fileFilter: (req, file, cb) => {
    if (!IMAGE_MIME_TYPES.has(file.mimetype)) {
      const err = new Error('Only JPEG, PNG, WEBP, or GIF images are accepted');
      err.status = 400;
      return cb(err);
    }
    cb(null, true);
  }
});

// CSV/Excel lead-import uploads only — reject anything else with a clean 400
// instead of letting a bad file type fail deep inside the parser later.
// Extension is the trusted signal (browsers report wildly inconsistent
// MIME types for .csv in particular — text/csv, application/vnd.ms-excel,
// text/plain, application/octet-stream all show up in practice), so we
// gate hard on extension and only use MIME type to reject obvious
// mismatches (e.g. an .csv upload that is actually an image or executable).
const IMPORT_FILE_EXTENSIONS = new Set(['.csv', '.xlsx', '.xls']);
const OBVIOUSLY_WRONG_MIME_PREFIXES = ['image/', 'video/', 'audio/', 'application/pdf', 'application/zip', 'application/x-msdownload'];
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB file limit
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

// CSV Upload specific routes
router.get('/csv/template/:verticalId', checkPermission('csv:template'), downloadCsvTemplate);
router.get('/csv/schema/:verticalId', checkPermission('csv:template'), getImportSchema);
// C5: rate-limit bulk uploads — each one now holds a Vercel instance open
// via waitUntil, so unbounded uploads are also a cost-DoS vector, not just
// an abuse vector. 20/hour per user (falls back to IP for unauthenticated
// callers, though this route is already behind `authenticate`).
router.post('/csv/upload', checkPermission('csv:upload'), rateLimiter('leads_csv_upload', 20, 3600), csvUpload.single('file'), uploadCsv);
router.get('/csv/logs', checkPermission('csv:logs'), getCsvLogs);
router.get('/csv/logs/:batchId', checkPermission(['csv:logs', 'csv:upload']), getCsvLogById);
router.get('/csv/logs/:batchId/failed-rows', checkPermission(['csv:logs', 'csv:upload']), streamFailedRows);

// Standard CostConversions routes
router.get('/', checkPermission(['leads:read', 'leads:read_own']), getCostConversions);
router.post('/', checkPermission('leads:create'), createCostConversion);
router.post('/bulk', checkPermission('leads:create'), createCostConversionBulk);
router.get('/export/csv', checkPermission(['leads:read', 'leads:read_own']), exportCostConversionsCsv);

router.get('/:id', checkPermission(['leads:read', 'leads:read_own']), getCostConversionById);
router.patch('/:id', checkPermission(['leads:update', 'leads:update_own']), updateCostConversion);
router.delete('/:id', checkPermission(['leads:delete', 'leads:delete_own']), deleteCostConversion);
// C5: rate-limit photo uploads for the same cost-DoS/abuse reasons as the
// CSV upload route above.
router.post('/:id/photo', checkPermission(['leads:update', 'leads:update_own']), rateLimiter('leads_photo_upload', 20, 3600), upload.single('photo'), uploadCostConversionPhoto);

router.patch('/:id/status', checkPermission(['leads:update', 'leads:update_own']), updateCostConversionStatus);
router.patch('/:id/assign', checkPermission('vertical:read'), assignCostConversion);

export default router;
