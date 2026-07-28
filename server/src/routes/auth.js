import express from 'express';
import { login, refresh, logout, me, forgotPassword, resetPassword, changePassword, register } from '../controllers/auth.js';
import authenticate from '../middleware/authenticate.js';
import rateLimiter from '../middleware/rateLimit.js';

const router = express.Router();

router.post('/login', rateLimiter('login', 10, 15 * 60), login);
router.post('/register', rateLimiter('register', 5, 60 * 60), register);
router.post('/refresh', refresh);
router.post('/logout', logout);
router.get('/me', authenticate, me);

router.post('/forgot-password', rateLimiter('forgot-password', 5, 60 * 60), forgotPassword);
router.post('/reset-password', rateLimiter('reset-password', 10, 60 * 60), resetPassword);
router.post('/change-password', authenticate, changePassword);
export default router;
