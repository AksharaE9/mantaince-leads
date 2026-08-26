import express from 'express';
import {
  getUsersBySubVertical,
  getCustomFields,
  createCustomField,
  updateCustomField,
  deleteCustomField,
  reorderCustomFields,
  getAdminAuditLogs,
  getSubVerticalStages,
  createSubVerticalStage,
  updateSubVerticalStage,
  deleteSubVerticalStage,
  reorderSubVerticalStages,
  getAdminDashboardStats,
  applyTemplateCustomFields,
  setPasswordByAdmin
} from '../controllers/admin.js';
import authenticate from '../middleware/authenticate.js';
import attachRole from '../middleware/attachRole.js';
import checkPermission from '../middleware/checkPermission.js';
import { timingReport } from '../middleware/timing.js';
import rateLimiter from '../middleware/rateLimit.js';

const router = express.Router();

router.use(authenticate);
router.use(attachRole);

// Set user password by admin (Super Admin only)
router.post('/users/:userId/set-password', checkPermission('users:update'), rateLimiter('set-password', 5, 60), setPasswordByAdmin);

// Sub-vertical custom fields CRUD
router.get('/sub-verticals/:subVerticalId/custom-fields', checkPermission(['vertical:read', 'leads:read_own', 'leads:read']), getCustomFields);
router.post('/sub-verticals/:subVerticalId/custom-fields', checkPermission('sub_vertical:manage'), createCustomField);
router.patch('/custom-fields/:id', checkPermission('sub_vertical:manage'), updateCustomField);
router.delete('/custom-fields/:id', checkPermission('sub_vertical:manage'), deleteCustomField);
router.patch('/sub-verticals/:subVerticalId/custom-fields/reorder', checkPermission('sub_vertical:manage'), reorderCustomFields);
router.post('/sub-verticals/:subVerticalId/custom-fields/apply-template', checkPermission('sub_vertical:manage'), applyTemplateCustomFields);

// Sub-vertical users
router.get('/sub-verticals/:subVerticalId/users', checkPermission(['vertical:read', 'leads:read_own']), getUsersBySubVertical);

// Sub-vertical workflow stages CRUD
router.get('/sub-verticals/:subVerticalId/stages', checkPermission(['vertical:read', 'leads:read_own', 'leads:read']), getSubVerticalStages);
router.post('/sub-verticals/:subVerticalId/stages', checkPermission('sub_vertical:manage'), createSubVerticalStage);
router.patch('/stages/:id', checkPermission('sub_vertical:manage'), updateSubVerticalStage);
router.delete('/stages/:id', checkPermission('sub_vertical:manage'), deleteSubVerticalStage);
router.patch('/sub-verticals/:subVerticalId/stages/reorder', checkPermission('sub_vertical:manage'), reorderSubVerticalStages);

// Visual Admin Audit Logs
router.get('/audit-logs', checkPermission('reports:read'), getAdminAuditLogs);
router.get('/dashboard-stats', checkPermission('reports:read'), getAdminDashboardStats);
router.get('/timing-report', checkPermission('reports:read'), timingReport);

export default router;
