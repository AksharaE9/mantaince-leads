import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientSrc = (rel) => path.resolve(__dirname, '../../../client/src', rel);
const read = (rel) => readFileSync(clientSrc(rel), 'utf-8');

// Source-level structural checks, not full component renders — this repo's
// CLAUDE.md documents why full RTL renders of pages that import
// lucide-react/zustand/react-router-dom/etc are not currently feasible
// (two live React copies in one render tree). These guard specifically
// against the two regressions found during this investigation reappearing
// silently in a future edit.

describe('Regression guard: axios interceptor handles the no-response failure class', () => {
  const axiosSrc = read('api/axios.js');

  it('imports and calls enrichNoResponseError for errors with no response received', () => {
    expect(axiosSrc).toContain("enrichNoResponseError");
    expect(axiosSrc).toContain('!error.response');
  });
});

describe('Regression guard: CsvImportModal never renders blank after a failed upload', () => {
  const modalSrc = read('components/CsvImportModal.jsx');

  it('the upload catch block sets uploadResult, not just uploadStatus', () => {
    // Isolate just the handleSubmit catch block (the one guarding against a
    // network/CORS-layer failure with no err.response at all) rather than
    // matching any catch block anywhere in the file.
    const catchBlockMatch = modalSrc.match(/} catch \(err\) \{[\s\S]*?extractErrorMessage\(err, 'Failed to upload file'\)[\s\S]*?\n {4}\}/);
    expect(catchBlockMatch, 'expected to find the upload handleSubmit catch block').toBeTruthy();
    expect(catchBlockMatch[0]).toContain('setUploadResult(');
    expect(catchBlockMatch[0]).toContain('setUploadStatus(');
  });

  it('the result panel only renders once both uploadStatus and uploadResult are set — the actual invariant that made the blank-modal bug possible', () => {
    expect(modalSrc).toContain("(uploadStatus === 'done' || uploadStatus === 'failed') && uploadResult");
  });

  it('the failed-records download button is guarded on a real batchId, not shown for a batch that never reached the server', () => {
    expect(modalSrc).toContain('uploadResult.batchId && (');
  });
});

describe('Regression guard: every data-mutating handler in LeadsPage surfaces errors to the user', () => {
  const pageSrc = read('pages/LeadsPage.jsx');

  it('imports extractErrorMessage for the standardized error shape', () => {
    expect(pageSrc).toContain("from '../utils/errorMessage.js'");
  });

  // Deliberately scoped to the named data-mutating handlers (create/edit,
  // bulk delete, bulk assign, bulk status change) rather than every catch
  // block in the file — a background list-load's catch (e.g. fetchVerticals,
  // a GET) failing silently just leaves a list empty, which is not the
  // "user clicked an action and nothing visibly happened" failure mode this
  // guards against.
  const mutatingHandlers = ['handleLeadSubmit', 'handleBulkDelete', 'handleBulkAssign', 'handleBulkStatusChange'];

  function extractFunctionBody(src, fnName) {
    const startIdx = src.indexOf(`const ${fnName} = async`);
    expect(startIdx, `could not find handler "${fnName}" in LeadsPage.jsx — has it been renamed?`).toBeGreaterThan(-1);
    // Bound the slice at the next top-level "const handle"/"const fetch"
    // declaration after this one, or 3000 chars, whichever comes first —
    // generous enough to contain the whole handler body without pulling in
    // unrelated later handlers.
    const nextDeclIdx = src.indexOf('\n  const ', startIdx + 20);
    const endIdx = nextDeclIdx > -1 ? nextDeclIdx : startIdx + 3000;
    return src.slice(startIdx, endIdx);
  }

  it.each(mutatingHandlers)('%s calls toast.error on failure', (fnName) => {
    const body = extractFunctionBody(pageSrc, fnName);
    expect(body, `${fnName} has no catch block at all`).toMatch(/catch\s*(\(|\{)/);
    expect(body, `${fnName}'s catch block does not call toast.error(...)`).toContain('toast.error(');
  });
});
