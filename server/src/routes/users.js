import express from 'express';
import { getUsers, inviteUser, getUserById, updateUser, changeUserRole, assignUserVerticals, deleteUser, approveUser } from '../controllers/users.js';
import authenticate from '../middleware/authenticate.js';
import attachRole from '../middleware/attachRole.js';
import checkPermission from '../middleware/checkPermission.js';

const router = express.Router();

// Apply auth protection globally to all user routes
router.use(authenticate);
router.use(attachRole);

// NOTE: 'users:read' is required to read full user directory details.
// To allow agents to load list of active operators for assigning leads,
// we also accept 'leads:read' and 'leads:read_own'. The controller
// sanitizes the output fields when the caller lacks 'users:read'.
router.get('/', checkPermission(['users:read', 'leads:read', 'leads:read_own']), getUsers);
router.post('/invite', checkPermission('users:invite'), inviteUser);
router.get('/:id', checkPermission('users:read'), getUserById);
router.patch('/:id', checkPermission('users:update'), updateUser);
router.patch('/:id/approve', checkPermission('users:update'), approveUser);
router.patch('/:id/role', checkPermission('users:role_change'), changeUserRole);
router.patch('/:id/verticals', checkPermission('users:verticals_change'), assignUserVerticals);
router.delete('/:id', checkPermission('users:delete'), deleteUser);

export default router;
