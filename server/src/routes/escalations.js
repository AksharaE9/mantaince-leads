import express from 'express';
import {
  createEscalation,
  getCostConversionEscalations,
  getAdminEscalationsInbox,
  resolveEscalation,
  rejectEscalation
} from '../controllers/escalations.js';
import authenticate from '../middleware/authenticate.js';
import attachRole from '../middleware/attachRole.js';
import checkPermission from '../middleware/checkPermission.js';

const router = express.Router();

// Cost Conversion scoped escalations
router.post('/cost-conversions/:id/escalations', authenticate, attachRole, checkPermission(['leads:update', 'leads:update_own']), createEscalation);
router.get('/cost-conversions/:id/escalations', authenticate, attachRole, checkPermission(['leads:read', 'leads:read_own']), getCostConversionEscalations);

// Admin Inbox
router.get('/admin/escalations/inbox', authenticate, attachRole, checkPermission('reports:read'), getAdminEscalationsInbox);

// Escalation Actions
router.put('/escalations/:id/resolve', authenticate, attachRole, checkPermission('leads:update'), resolveEscalation);
router.put('/escalations/:id/reject', authenticate, attachRole, checkPermission('leads:update'), rejectEscalation);

export default router;
