import crypto from 'crypto';
import { logger } from '../lib/logger.js';

export { sendControllerError } from './dbErrors.js';

/**
 * Machine-readable error codes used across the standardized OperationError
 * shape. Deliberately a plain object, not an enum library — this repo's own
 * convention (see roles.permissions) is plain strings checked by inclusion,
 * not a fixed type-level enum.
 */
export const ErrorCodes = {
  MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
  INVALID_FORMAT: 'INVALID_FORMAT',
  INVALID_ENUM: 'INVALID_ENUM',
  DUPLICATE_PHONE: 'DUPLICATE_PHONE',
  DUPLICATE_RECORD: 'DUPLICATE_RECORD',
  NOT_FOUND: 'NOT_FOUND',
  FORBIDDEN: 'FORBIDDEN',
  DB_CONSTRAINT: 'DB_CONSTRAINT',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
};

/**
 * For a KNOWN, already-diagnosed failure raised directly by controller logic
 * (not caught from a thrown exception) — e.g. "phone number is mandatory".
 * Always returns the standardized OperationError shape with a correlationId,
 * and always logs server-side via pino so the same correlationId can be
 * looked up later even though this isn't a genuine "error" (no stack to
 * capture, just a deliberate reject).
 *
 * section: 'cos' | 'positives' | 'follow_ups' | 'raw_data' | 'delivery_data'
 * operation: 'single_add' | 'bulk_upload' | 'promote' | 'duplicate_scan'
 */
export function operationError(res, { status = 400, code, message, section, operation, row, field, recordId, fields }) {
  const correlationId = crypto.randomUUID();

  logger.warn({
    correlationId, section, operation, code, row, field, recordId, status, fields,
  }, `[${section}:${operation}] ${message}`);

  return res.status(status).json({
    success: false,
    errors: fields || [],
    error: {
      code, message, section, operation, row, field, recordId, correlationId,
      timestamp: new Date().toISOString(),
      // Optional: the full per-field breakdown for a multi-field validation
      // failure (message above is these joined into one string). Lets a
      // form highlight/list each individual field problem instead of only
      // showing the combined sentence — see rawData.js/deliveryData.js
      // createRawData/createDeliveryData for the one caller that sets this.
      ...(fields ? { fields } : {}),
    },
  });
}

export default operationError;
