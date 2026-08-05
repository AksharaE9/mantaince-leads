import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isNoResponseError,
  buildNoResponseMessage,
  reportClientErrorBestEffort,
  enrichNoResponseError,
} from '../../../../client/src/utils/networkError.js';

// Covers the "request never reached the server" failure class (CORS block,
// network drop, DNS failure, timeout) that was the actual silent-failure
// bug behind the reported upload incident — see CLAUDE.md's CORS
// investigation note. This is pure logic (no React, no third-party client
// deps), which per this repo's documented test-environment constraints is
// the reliably-testable kind — see CLAUDE.md's "Test environment quirks".

describe('isNoResponseError', () => {
  it('is true for an axios error with a request but no response (network/CORS failure)', () => {
    const err = { request: {}, response: undefined };
    expect(isNoResponseError(err)).toBe(true);
  });

  it('is true for an axios ERR_NETWORK code even without an explicit request field', () => {
    const err = { code: 'ERR_NETWORK', response: undefined };
    expect(isNoResponseError(err)).toBe(true);
  });

  it('is true for the literal "Network Error" message axios uses in some browsers', () => {
    const err = { message: 'Network Error', response: undefined };
    expect(isNoResponseError(err)).toBe(true);
  });

  it('is false when a response was actually received (e.g. a 401 or 500)', () => {
    const err = { request: {}, response: { status: 401, data: {} } };
    expect(isNoResponseError(err)).toBe(false);
  });

  it('is false for a plain client-side validation error with neither request nor response', () => {
    const err = new Error('Please select a file first');
    expect(isNoResponseError(err)).toBe(false);
  });

  it('is false for null/undefined input', () => {
    expect(isNoResponseError(null)).toBe(false);
    expect(isNoResponseError(undefined)).toBe(false);
  });
});

describe('buildNoResponseMessage', () => {
  it('is specific and actionable, and embeds the correlationId so it survives call sites that show the string as-is', () => {
    const message = buildNoResponseMessage('abc-123');
    expect(message).toContain('reach the server');
    expect(message).toContain('abc-123');
    expect(message.toLowerCase()).not.toBe('something went wrong');
  });
});

describe('reportClientErrorBestEffort', () => {
  it('calls the injected postFn with the client-errors endpoint and a JSON body containing the correlationId', () => {
    const postFn = vi.fn();
    reportClientErrorBestEffort(
      { correlationId: 'cid-1', url: '/api/v1/leads/csv/upload', method: 'post', message: 'Network Error', code: 'ERR_NETWORK' },
      'https://mantaince-leads-sqvw.vercel.app',
      postFn
    );
    expect(postFn).toHaveBeenCalledTimes(1);
    const [target, body] = postFn.mock.calls[0];
    expect(target).toBe('https://mantaince-leads-sqvw.vercel.app/api/v1/client-errors');
    const parsed = JSON.parse(body);
    expect(parsed.correlationId).toBe('cid-1');
    expect(parsed.url).toBe('/api/v1/leads/csv/upload');
  });

  it('never throws even if postFn itself throws (best-effort must not compound a failure)', () => {
    const postFn = vi.fn(() => { throw new Error('offline'); });
    expect(() =>
      reportClientErrorBestEffort({ correlationId: 'cid-2' }, '', postFn)
    ).not.toThrow();
  });
});

describe('enrichNoResponseError', () => {
  let consoleErrorSpy;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('attaches a correlationId, isNetworkError flag, and a response-shaped message an existing call site can read', () => {
    const err = {
      config: { url: '/api/v1/leads/csv/upload', method: 'post' },
      message: 'Network Error',
      code: 'ERR_NETWORK',
      request: {},
    };
    const postFn = vi.fn();

    const enriched = enrichNoResponseError(err, '', postFn);

    expect(enriched.correlationId).toBeTruthy();
    expect(enriched.isNetworkError).toBe(true);
    // Matches the shape every existing `err.response?.data?.error || fallback`
    // call site in this app already reads — zero call-site changes needed.
    expect(typeof enriched.response.data.error).toBe('string');
    expect(enriched.response.data.error).toContain(enriched.correlationId);
  });

  it('logs the failure client-side, since the server never saw the request and cannot log it server-side', () => {
    const err = { config: { url: '/x', method: 'get' }, message: 'Network Error', request: {} };
    enrichNoResponseError(err, '', vi.fn());
    expect(consoleErrorSpy).toHaveBeenCalledWith('[network-error]', expect.objectContaining({
      url: '/x', method: 'get',
    }));
  });

  it('fires the best-effort persisted report exactly once per failure', () => {
    const postFn = vi.fn();
    const err = { config: { url: '/x', method: 'get' }, message: 'Network Error', request: {} };
    enrichNoResponseError(err, '', postFn);
    expect(postFn).toHaveBeenCalledTimes(1);
  });
});
