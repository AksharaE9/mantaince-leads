import { query } from '../config/db.js';
import crypto from 'crypto';
import { broadcast, addClient, removeClient } from '../services/assignmentBroadcaster.js';
import { logAudit } from '../services/audit.js';
import { bulkInsert } from '../db/bulkInsert.js';
import { cacheDelete } from '../services/cache.js';
import { signSseTicket } from '../utils/token.js';

/**
 * SSE Stream Endpoint
 */
export const streamAssignments = (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); 
  res.flushHeaders();

  const userId = req.role.name === 'super_admin' ? '__ADMIN__' : req.user.sub;
  addClient(userId, res);

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeClient(userId, res);
    res.end();
  });
};

/**
 * Bulk Assign Sub-Verticals to User (Deprecated - No-Op)
 */
export const bulkAssign = async (req, res) => {
  return res.status(200).json({ 
    success: true, 
    data: [] 
  });
};

/**
 * Get current user's assigned sub-verticals (Deprecated - Returns empty array)
 */
export const getMySubVerticals = async (req, res) => {
  return res.status(200).json({ 
    success: true, 
    data: [] 
  });
};

/**
 * Mint a short-lived SSE connection ticket
 */
export const getStreamTicket = async (req, res) => {
  try {
    const ticket = signSseTicket(req.user.sub);
    return res.status(200).json({ success: true, ticket });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};
