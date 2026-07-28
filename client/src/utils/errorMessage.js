/**
 * Extracts a displayable string from an API error response. Most endpoints
 * still return `error` as a plain string; the operations covered by the
 * standardized OperationError shape (single add / bulk upload / promote /
 * duplicate-scan — see server/src/utils/operationError.js) return `error` as
 * an object with {code, message, correlationId, ...}. This reads either
 * shape so call sites don't need to know which one a given endpoint uses,
 * and appends a correlationId reference when one is present so a user can
 * report "error ref: <id>" instead of just "it broke".
 */
export function extractErrorMessage(err, fallback = 'Something went wrong') {
  const data = err?.response?.data;
  const apiError = data?.error;

  if (!apiError) return fallback;
  if (typeof apiError === 'string') {
    return data?.correlationId ? `${apiError} (ref: ${data.correlationId})` : apiError;
  }
  const message = apiError.message || fallback;
  return apiError.correlationId ? `${message} (ref: ${apiError.correlationId})` : message;
}

export default extractErrorMessage;
