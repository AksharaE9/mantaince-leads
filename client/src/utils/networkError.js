/**
 * Handles the "request never reached the server" failure class: network
 * drops, DNS failures, timeouts, and CORS blocks. These are structurally
 * different from a server-returned error status — axios gives you an
 * `error.request` with no `error.response`, so there is no body to parse
 * and no server-side log entry anywhere (the server never saw the request).
 * Without this module, every one of this app's ~70 `catch` blocks that read
 * `err.response?.data?.error || fallback` silently falls through to a
 * generic hardcoded string with no correlationId — indistinguishable from
 * "nothing happened" once the toast disappears. See CLAUDE.md's CORS
 * investigation note for how this was found (root cause was NOT a domain
 * misconfiguration — both `mantaince-leads.vercel.app` and
 * `mantaince-leads-sqvw.vercel.app` are correct, deployed, working — this
 * module exists so that whenever a request of this class DOES fail, for
 * any reason (real CORS regression, client machine offline, corporate
 * proxy, ad-blocker), it is never silent again).
 */

/** True when axios failed before any response was received. */
export function isNoResponseError(err) {
  return !!err && !err.response && (!!err.request || err.code === 'ERR_NETWORK' || err.message === 'Network Error');
}

function generateCorrelationId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for environments without Web Crypto (older browsers, some test runners)
  return `cid-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function buildNoResponseMessage(correlationId) {
  return `Could not reach the server. This may be a network or configuration issue. Please try again, and contact support with reference ${correlationId} if it continues.`;
}

/**
 * Best-effort, fire-and-forget persisted report of a client-side network
 * failure. Deliberately does not use the shared `instance` (would recurse
 * through this same interceptor if it also fails) and never throws or
 * blocks the caller — if the client genuinely has no connectivity, this
 * call fails too, and the console.error already emitted is all that's
 * recoverable. `postFn` is injected for testability.
 */
export function reportClientErrorBestEffort(details, apiBaseUrl, postFn) {
  try {
    const body = JSON.stringify({
      correlationId: details.correlationId,
      url: details.url,
      method: details.method,
      message: details.message,
      code: details.code,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    });
    const target = `${apiBaseUrl || ''}/api/v1/client-errors`;

    if (postFn) {
      postFn(target, body);
      return;
    }
    if (typeof fetch !== 'undefined') {
      fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true, // survives page navigation — this often fires right before a user gives up and leaves
      }).catch(() => {});
    }
  } catch {
    // Never let error reporting itself throw — this runs inside an error handler already.
  }
}

/**
 * Enriches an axios "no response received" error in place with a
 * correlationId and a response-shaped payload matching the app's existing
 * OperationError convention (`err.response.data.error` as a string), logs
 * it client-side (the only place this failure is ever observable), and
 * fires the best-effort persisted report. Every existing call site's
 * `err.response?.data?.error || fallback` / `extractErrorMessage(err, ...)`
 * pattern picks up the specific message automatically — no per-call-site
 * changes needed.
 */
export function enrichNoResponseError(error, apiBaseUrl, postFn) {
  const correlationId = generateCorrelationId();
  const message = buildNoResponseMessage(correlationId);
  const details = {
    correlationId,
    url: error?.config?.url,
    method: error?.config?.method,
    message: error?.message,
    code: error?.code,
  };

  console.error('[network-error]', { ...details, timestamp: new Date().toISOString() });
  reportClientErrorBestEffort(details, apiBaseUrl, postFn);

  error.correlationId = correlationId;
  error.isNetworkError = true;
  error.response = { data: { error: message } };
  return error;
}
