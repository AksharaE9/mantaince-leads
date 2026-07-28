import express from 'express';
import { 
  getVerticals, 
  createVertical, 
  getVerticalById, 
  updateVertical, 
  deleteVertical, 
  reorderVerticals,
  getSubVerticals,
  createSubVertical,
  updateSubVertical,
  deleteSubVertical,
  reorderSubVerticals,
  getSubVerticalById
} from '../controllers/verticals.js';
import authenticate from '../middleware/authenticate.js';
import attachRole from '../middleware/attachRole.js';
import checkPermission from '../middleware/checkPermission.js';

const router = express.Router();

router.use(authenticate);
router.use(attachRole);

// Verticals CRUD
router.get('/', getVerticals);
router.post('/', checkPermission('vertical:create'), createVertical);
router.get('/:id', getVerticalById);
router.patch('/reorder', checkPermission('vertical:reorder'), reorderVerticals);
router.patch('/:id', checkPermission('vertical:update'), updateVertical);
router.delete('/:id', checkPermission('vertical:delete'), deleteVertical);

// Nested Sub-Verticals CRUD
router.get('/:verticalId/sub-verticals', getSubVerticals);
router.post('/:verticalId/sub-verticals', checkPermission('sub_vertical:manage'), createSubVertical);
router.patch('/:verticalId/sub-verticals/reorder', checkPermission('sub_vertical:manage'), reorderSubVerticals);

// Specific sub-vertical endpoints
router.get('/sub-verticals/:subId', getSubVerticalById);
router.patch('/sub-verticals/:subId', checkPermission('sub_vertical:manage'), updateSubVertical);
router.delete('/sub-verticals/:subId', checkPermission('sub_vertical:manage'), deleteSubVertical);

export default router;
