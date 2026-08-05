import express from 'express';
import { reportClientError } from '../controllers/clientErrors.js';
import rateLimiter from '../middleware/rateLimit.js';

const router = express.Router();

// No `authenticate` gate — see controller doc comment for why. Rate-limited
// by IP (works whether or not a user is logged in) to bound abuse of a
// deliberately public endpoint: 30 reports/minute is generous for genuine
// client failures (a user is not going to generate 30 failed requests in a
// minute under normal use) while still blocking naive scripted abuse.
router.post('/', rateLimiter('client_error_report', 30, 60), reportClientError);

export default router;
