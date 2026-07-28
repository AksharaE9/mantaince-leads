import express from 'express';
import { getUsers, inviteUser, getUserById, updateUser, changeUserRole, assignUserVerticals, deleteUser, approveUser } from '../controllers/users.js';
import authenticate from '../middleware/authenticate.js';
import attachRole from '../middleware/attachRole.js';
import checkPermission from '../middleware/checkPermission.js';

const router = express.Router();

// Apply auth protection globally to all user routes
router.use(authenticate);
router.use(attachRole);

// NOTE: 'leads:read_own' was previously OR'd in here, letting any agent
// enumerate the full user directory (emails, permission arrays) — that
// permission is meant for scoping lead visibility, not user-directory
// access. 'users:read' is an existing key (granted to vertical_admin and
// super_admin's '*' wildcard — see config/seed.js) already used elsewhere
// in this file; reused here rather than inventing a new permission string.
router.get('/', checkPermission('users:read'), getUsers);
router.post('/invite', checkPermission('users:invite'), inviteUser);
router.get('/:id', checkPermission('users:read'), getUserById);
router.patch('/:id', checkPermission('users:update'), updateUser);
router.patch('/:id/approve', checkPermission('users:update'), approveUser);
router.patch('/:id/role', checkPermission('users:role_change'), changeUserRole);
router.patch('/:id/verticals', checkPermission('users:verticals_change'), assignUserVerticals);
router.delete('/:id', checkPermission('users:delete'), deleteUser);

export default router;
