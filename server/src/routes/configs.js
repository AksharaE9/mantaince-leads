import express from 'express';
import { 
  getFieldConfigs, 
  createFieldConfig, 
  updateFieldConfig, 
  deleteFieldConfig, 
  reorderFieldConfigs,
  getCsvTemplateFields 
} from '../controllers/configs.js';
import authenticate from '../middleware/authenticate.js';
import attachRole from '../middleware/attachRole.js';
import checkPermission from '../middleware/checkPermission.js';

const router = express.Router();

router.use(authenticate);
router.use(attachRole);

// Custom Field Configuration endpoints
router.get('/verticals/:verticalId/fields', getFieldConfigs);
router.post('/verticals/:verticalId/fields', checkPermission('vertical:update'), createFieldConfig);
router.patch('/verticals/:verticalId/fields/:fieldId', checkPermission('vertical:update'), updateFieldConfig);
router.delete('/verticals/:verticalId/fields/:fieldId', checkPermission('vertical:update'), deleteFieldConfig);
router.patch('/verticals/:verticalId/fields/reorder', checkPermission('vertical:update'), reorderFieldConfigs);

router.get('/verticals/:verticalId/fields/csv-template', getCsvTemplateFields);

export default router;
