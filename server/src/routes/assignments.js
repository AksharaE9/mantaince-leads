import express from 'express';
import { streamAssignments, bulkAssign, getMySubVerticals, getStreamTicket } from '../controllers/assignments.js';
import authenticate from '../middleware/authenticate.js';
import attachRole from '../middleware/attachRole.js';
import checkPermission from '../middleware/checkPermission.js';

const router = express.Router();

router.use(authenticate);
router.use(attachRole);

// SSE Stream Ticket Handshake
router.post('/stream/ticket', getStreamTicket);

// SSE Stream
router.get('/stream', streamAssignments);

// User's own assignments
router.get('/me', getMySubVerticals);

// Admin bulk assignments
router.post('/bulk', checkPermission('user:manage'), bulkAssign);

export default router;
