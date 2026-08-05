import { describe, it, expect } from 'vitest';
import { extractErrorMessage } from '../../../../client/src/utils/errorMessage.js';
import { enrichNoResponseError, buildNoResponseMessage } from '../../../../client/src/utils/networkError.js';

describe('extractErrorMessage', () => {
  it('falls back to the given default when there is no response at all and no enrichment has run', () => {
    const err = { request: {} }; // raw axios no-response error, unenriched
    expect(extractErrorMessage(err, 'Failed to upload file')).toBe('Failed to upload file');
  });

  it('reads the OperationError object shape (correlationId nested in the error object)', () => {
    const err = { response: { data: { error: { message: 'Phone number already exists', correlationId: 'op-1' } } } };
    expect(extractErrorMessage(err)).toBe('Phone number already exists (ref: op-1)');
  });

  it('reads the plain-string error shape used by ~most of this app\'s call sites', () => {
    const err = { response: { data: { error: 'Delete rejected' } } };
    expect(extractErrorMessage(err)).toBe('Delete rejected');
  });

  it('picks up the specific network-failure message automatically once the axios interceptor has enriched the error — no call-site changes needed', () => {
    const rawErr = { config: { url: '/api/v1/leads/csv/upload', method: 'post' }, message: 'Network Error', request: {} };
    const enriched = enrichNoResponseError(rawErr, '', () => {}); // postFn stub, no real network call in a unit test

    const shown = extractErrorMessage(enriched, 'Failed to upload file');
    expect(shown).toBe(buildNoResponseMessage(enriched.correlationId));
    expect(shown).not.toBe('Failed to upload file'); // must not silently fall back to the generic string
    expect(shown).toContain(enriched.correlationId);
  });
});
