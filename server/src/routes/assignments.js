import express from 'express';
import { pollRealtimeEvents, bulkAssign, getMySubVerticals } from '../controllers/assignments.js';
import authenticate from '../middleware/authenticate.js';
import attachRole from '../middleware/attachRole.js';
import checkPermission from '../middleware/checkPermission.js';

const router = express.Router();

router.use(authenticate);
router.use(attachRole);

// Real-time sync polling (replaces the old SSE stream — see
// assignmentBroadcaster.js for why SSE never worked on Vercel)
router.get('/poll', pollRealtimeEvents);

// User's own assignments
router.get('/me', getMySubVerticals);

// Admin bulk assignments
router.post('/bulk', checkPermission('user:manage'), bulkAssign);

export default router;
