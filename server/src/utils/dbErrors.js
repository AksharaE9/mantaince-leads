import crypto from 'crypto';
import { logger } from '../lib/logger.js';

/**
 * Maps known Postgres error codes to a standardized {code, status, message,
 * field} shape. Returns null for anything unrecognized, which the caller
 * treats as a generic internal error.
 */
function mapPgError(error) {
  if (error?.code === '23505') {
    const detailMatch = error.detail?.match(/Key \((.*?)\)=\((.*?)\) already exists/);
    const field = detailMatch ? detailMatch[1] : undefined;
    const value = detailMatch ? detailMatch[2] : undefined;
    return {
      code: 'DUPLICATE_RECORD',
      status: 409,
      message: field ? `A record with this ${field}${value ? ` ("${value}")` : ''} already exists` : 'A record with this value already exists',
      field,
    };
  }
  if (error?.code === '22P02') {
    return { code: 'INVALID_FORMAT', status: 400, message: 'Invalid request: malformed identifier or value' };
  }
  if (error?.code === '23503') {
    return { code: 'DB_CONSTRAINT', status: 400, message: 'Invalid request: referenced record does not exist' };
  }
  if (error?.code === '23502') {
    return { code: 'MISSING_REQUIRED_FIELD', status: 400, message: `Missing required field: ${error.column || 'unknown'}`, field: error.column };
  }
  return null;
}

/**
 * The one standardized error responder for controllers. Always generates a
 * correlationId and logs full context + stack server-side via the app's
 * structured (pino) logger — never a raw stack or DB driver string reaches
 * the client.
 *
 * Two ways to call it:
 *  - sendControllerError(res, error, context) — unchanged from before:
 *    generic catch-all, maps known PG codes, otherwise a safe generic 500
 *    with a PLAIN STRING `error` (so every existing call site across the
 *    app, and every frontend toast reading `err.response.data.error` as a
 *    string, keeps working with zero changes) — now with a correlationId
 *    sibling field added to the response.
 *  - sendControllerError(res, error, context, meta) — meta may include
 *    {section, operation, row, field, recordId, code, message, status}.
 *    When BOTH meta.section and meta.operation are present, the response
 *    switches to the standardized OperationError shape (`error` becomes an
 *    object) — this is the shape used by the audited operations (single
 *    add / bulk upload / promote / duplicate-scan). Call sites outside that
 *    scope are unaffected.
 */
export const sendControllerError = (res, error, context = '', meta = {}) => {
  const correlationId = crypto.randomUUID();
  const pgMapped = mapPgError(error);

  const status = meta.status ?? pgMapped?.status ?? 500;
  const code = meta.code ?? pgMapped?.code ?? 'INTERNAL_ERROR';
  const field = meta.field ?? pgMapped?.field;
  const message = meta.message ?? pgMapped?.message ?? 'An internal server error occurred';

  logger.error({
    correlationId,
    context,
    section: meta.section,
    operation: meta.operation,
    row: meta.row,
    field,
    recordId: meta.recordId,
    code,
    status,
    err: { message: error?.message, stack: error?.stack, pgCode: error?.code, pgDetail: error?.detail },
  }, `[${context || 'controller_error'}] ${message}`);

  // Legacy in-memory debug ring buffer some old admin tooling wrote to but
  // nothing ever read (no route exposed it, confirmed by repo-wide grep) —
  // kept as a harmless best-effort mirror for any external tool that might
  // still poke at global.debugErrors, but pino + correlationId above is now
  // the real, persisted, greppable trace.
  if (global.debugErrors) {
    global.debugErrors.unshift({ timestamp: new Date().toISOString(), type: 'controller_error', context, correlationId, message: error?.message, stack: error?.stack, code: error?.code, detail: error?.detail });
    if (global.debugErrors.length > 50) global.debugErrors.pop();
  }

  if (meta.section && meta.operation) {
    return res.status(status).json({
      success: false,
      error: {
        code, message, section: meta.section, operation: meta.operation,
        row: meta.row, field, recordId: meta.recordId, correlationId,
        timestamp: new Date().toISOString(),
      },
    });
  }

  const response = { success: false, error: message, correlationId };
  if (process.env.NODE_ENV !== 'production') {
    response.details = error?.stack || error?.message;
  }
  return res.status(status).json(response);
};

export default sendControllerError;
