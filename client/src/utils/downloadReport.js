import axios from '../api/axios.js';

/**
 * Downloads a CSV report from an authenticated endpoint as a file — the same
 * blob-download pattern CsvImportModal.jsx's "Download Full Error Report"
 * button already used, extracted here so the new Operation Reports page
 * (client/src/pages/OperationReportsPage.jsx) can reuse it instead of
 * forking the same 12 lines a second time.
 */
export async function downloadCsvFromEndpoint(url, filename) {
  const res = await axios.get(url, { responseType: 'blob' });
  const blob = new Blob([res.data], { type: 'text/csv;charset=utf-8;' });
  const blobUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(blobUrl);
}

export default downloadCsvFromEndpoint;
