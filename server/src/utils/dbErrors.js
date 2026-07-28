/**
 * Maps known Postgres error codes to clean 4xx JSON responses instead of
 * letting them fall through as bare 500s with raw driver messages leaked
 * to the client. Any error we don't recognize is logged with its full
 * stack server-side and returned as a generic, safe 500.
 */
export const sendControllerError = (res, error, context = '') => {
  if (context) {
    console.error(`❌ [${context}]`, error);
  } else {
    console.error('❌ Controller error:', error);
  }

  if (global.debugErrors) {
    global.debugErrors.unshift({
      timestamp: new Date().toISOString(),
      type: 'controller_error',
      context,
      message: error.message,
      stack: error.stack,
      code: error.code,
      detail: error.detail
    });
    if (global.debugErrors.length > 50) global.debugErrors.pop();
  }

  // Invalid input syntax (e.g. malformed UUID/date reaching the DB layer)
  if (error.code === '22P02') {
    return res.status(400).json({ success: false, error: 'Invalid request: malformed identifier or value' });
  }

  // Unique constraint violation
  if (error.code === '23505') {
    const detailMatch = error.detail?.match(/Key \((.*?)\)=\((.*?)\) already exists/);
    const field = detailMatch ? detailMatch[1] : 'field';
    return res.status(409).json({ success: false, error: `A record with this ${field} already exists` });
  }

  // Foreign key violation (e.g. referencing a deleted vertical/user)
  if (error.code === '23503') {
    return res.status(400).json({ success: false, error: 'Invalid request: referenced record does not exist' });
  }

  // Not-null violation
  if (error.code === '23502') {
    return res.status(400).json({ success: false, error: `Missing required field: ${error.column || 'unknown'}` });
  }

  // Full stack/message is logged server-side above (console.error)
  // regardless of environment; only non-production responses include it in
  // the JSON body sent to the client.
  const response = {
    success: false,
    error: 'An internal server error occurred'
  };
  if (process.env.NODE_ENV !== 'production') {
    response.details = error.stack || error.message;
  }
  return res.status(500).json(response);
};

export default sendControllerError;
