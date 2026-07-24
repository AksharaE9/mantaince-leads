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

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB file limit
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
router.post('/csv/upload', checkPermission('csv:upload'), csvUpload.single('file'), uploadCsv);
router.get('/csv/logs', checkPermission('csv:logs'), getCsvLogs);
router.get('/csv/logs/:batchId', checkPermission('csv:logs'), getCsvLogById);
router.get('/csv/logs/:batchId/failed-rows', checkPermission('csv:logs'), streamFailedRows);

// Standard CostConversions routes
router.get('/', checkPermission(['leads:read', 'leads:read_own']), getCostConversions);
router.post('/', checkPermission('leads:create'), createCostConversion);
router.post('/bulk', checkPermission('leads:create'), createCostConversionBulk);
router.get('/export/csv', checkPermission(['leads:read', 'leads:read_own']), exportCostConversionsCsv);

router.get('/:id', checkPermission(['leads:read', 'leads:read_own']), getCostConversionById);
router.patch('/:id', checkPermission(['leads:update', 'leads:update_own']), updateCostConversion);
router.delete('/:id', checkPermission(['leads:delete', 'leads:delete_own']), deleteCostConversion);
router.post('/:id/photo', checkPermission(['leads:update', 'leads:update_own']), upload.single('photo'), uploadCostConversionPhoto);

router.patch('/:id/status', checkPermission(['leads:update', 'leads:update_own']), updateCostConversionStatus);
router.patch('/:id/assign', checkPermission('vertical:read'), assignCostConversion);

export default router;
