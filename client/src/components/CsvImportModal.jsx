import React, { useEffect, useState } from 'react';
import { Download, Upload, X, CheckCircle2, FileSpreadsheet, Eye } from 'lucide-react';
import * as XLSX from 'xlsx';
import toast from 'react-hot-toast';
import axios from '../api/axios.js';
import Loader from './Loader.jsx';
import SearchableOperatorSelect from './SearchableOperatorSelect.jsx';
import { normalizeHeaderKey, validateParsedRowsAgainstSchema } from '../utils/leadImportValidation.js';
import { downloadCsvFromEndpoint } from '../utils/downloadReport.js';
import { extractErrorMessage } from '../utils/errorMessage.js';

const ACCEPTED_EXTENSIONS = ['.csv', '.xlsx', '.xls'];

// Default endpoint shape matches the Leads/Positives import routes. Pass
// `endpoints` overrides to point this same modal at a different feature's
// routes (e.g. Raw Data) without forking the component.
const DEFAULT_ENDPOINTS = {
  schema: (verticalId, leadType) => `/api/v1/leads/csv/schema/${verticalId}?leadType=${leadType}`,
  template: (verticalId, leadType, format) => `/api/v1/leads/csv/template/${verticalId}?leadType=${leadType}${format === 'xlsx' ? '&format=xlsx' : ''}`,
  upload: () => '/api/v1/leads/csv/upload',
  log: (batchId) => `/api/v1/leads/csv/logs/${batchId}`,
  failedRows: (batchId) => `/api/v1/leads/csv/logs/${batchId}/failed-rows`,
};

const FilterInput = ({ label, children }) => (
  <div className="flex flex-col gap-1.5">
    <span className="text-[10px] font-black uppercase text-[--text-secondary]">{label}</span>
    {children}
  </div>
);

/**
 * Shared bulk-import modal: file picker (CSV/XLSX/XLS), dynamic template
 * download (CSV + XLSX with dropdowns), client-side preview validation
 * against the server's shared schema, upload + progress polling, and a
 * structured result + downloadable error report.
 */
export default function CsvImportModal({
  open,
  onClose,
  vertical,
  subVerticals = [],
  defaultSubVerticalId = '',
  agents = [],
  leadType,
  leadTypeOptions, // e.g. [{ value: 'CALL', label: 'Calls' }, { value: 'FIELD', label: 'Field Visit' }]
  filenamePrefix = 'leads',
  title = 'Import Leads',
  onImportComplete,
  endpoints, // partial override of DEFAULT_ENDPOINTS
  showSubVertical = true,
  showAssignOperator = true,
}) {
  const ep = { ...DEFAULT_ENDPOINTS, ...endpoints };
  const [selectedFile, setSelectedFile] = useState(null);
  const [subVerticalId, setSubVerticalId] = useState(defaultSubVerticalId);
  const [currentLeadType, setCurrentLeadType] = useState(leadType || leadTypeOptions?.[0]?.value || 'CALL');
  const [assignTarget, setAssignTarget] = useState('');
  const [uploadStatus, setUploadStatus] = useState('idle'); // idle | uploading | processing | done | failed
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadResult, setUploadResult] = useState(null);
  const [filePreview, setFilePreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setSubVerticalId(defaultSubVerticalId || '');
      setCurrentLeadType(leadType || leadTypeOptions?.[0]?.value || 'CALL');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Client-side pre-validation preview — fast feedback only, never trusted.
  useEffect(() => {
    if (!selectedFile || !vertical?._id) {
      setFilePreview(null);
      return undefined;
    }
    let cancelled = false;

    (async () => {
      setPreviewLoading(true);
      try {
        const [schemaRes, buffer] = await Promise.all([
          axios.get(ep.schema(vertical._id, currentLeadType)),
          selectedFile.arrayBuffer(),
        ]);
        const schema = schemaRes.data.data.fields;
        const workbook = XLSX.read(buffer, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
        const normalizedRows = rawRows.map((r) => {
          const obj = {};
          Object.entries(r).forEach(([k, v]) => { obj[normalizeHeaderKey(k)] = v; });
          return obj;
        });
        const result = validateParsedRowsAgainstSchema(normalizedRows, schema);
        if (!cancelled) setFilePreview(result);
      } catch {
        if (!cancelled) setFilePreview({ previewFailed: true });
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [selectedFile, currentLeadType, vertical?._id]);

  if (!open) return null;

  const handleDownloadTemplate = async (format) => {
    if (!vertical) return;
    try {
      const response = await axios.get(
        ep.template(vertical._id, currentLeadType, format),
        { responseType: format === 'xlsx' ? 'arraybuffer' : 'text' }
      );
      const mime = format === 'xlsx'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'text/csv;charset=utf-8;';
      const blob = new Blob([response.data], { type: mime });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${filenamePrefix}-template-${vertical.slug}.${format}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Failed to download template');
    }
  };

  const handleClose = () => {
    setSelectedFile(null);
    setAssignTarget('');
    setUploadStatus('idle');
    setUploadProgress(0);
    setUploadResult(null);
    setFilePreview(null);
    onClose?.();
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!selectedFile) {
      toast.error('Please select a file first');
      return;
    }
    if (showSubVertical && !subVerticalId && subVerticals.length > 0) {
      toast.error('Please select a sub-vertical');
      return;
    }

    setUploadStatus('uploading');
    setUploadProgress(10);

    const formData = new FormData();
    formData.append('file', selectedFile);
    formData.append('verticalId', vertical._id);
    if (showSubVertical && subVerticalId) formData.append('subVerticalId', subVerticalId);
    formData.append('leadType', currentLeadType);
    if (showAssignOperator && assignTarget) formData.append('assignedTo', assignTarget);

    try {
      const res = await axios.post(ep.upload(), formData);
      const { batchId } = res.data.data;
      setUploadStatus('processing');
      setUploadProgress(40);

      const intervalId = setInterval(async () => {
        try {
          const logRes = await axios.get(ep.log(batchId));
          const log = logRes.data.data;

          if (log.status === 'done') {
            clearInterval(intervalId);
            setUploadProgress(100);
            setUploadStatus('done');
            setUploadResult({
              batchId: log.id,
              successCount: log.success_count || 0,
              failedCount: log.failed_count || 0,
              duplicateCount: log.duplicate_count || 0,
              errors: log.errors || [],
            });
            toast.success('Import completed.');
            onImportComplete?.();
          } else if (log.status === 'failed') {
            clearInterval(intervalId);
            setUploadStatus('failed');
            setUploadResult({
              batchId: log.id,
              successCount: log.success_count || 0,
              failedCount: log.failed_count || 0,
              duplicateCount: log.duplicate_count || 0,
              errors: log.errors || [{ row: 0, reason: 'Log entry marked failed' }],
            });
            toast.error('Import failed.');
          } else {
            setUploadProgress((prev) => Math.min(prev + 10, 95));
          }
        } catch {
          clearInterval(intervalId);
          setUploadStatus('failed');
          toast.error('Failed to retrieve processing status.');
        }
      }, 2000);
    } catch (err) {
      const message = extractErrorMessage(err, 'Failed to upload file');
      setUploadStatus('failed');
      setUploadResult({
        batchId: null,
        successCount: 0,
        failedCount: 0,
        duplicateCount: 0,
        errors: [{ row: 0, reason: message }],
      });
      toast.error(message);
    }
  };

  const downloadFailedRecords = async () => {
    try {
      await downloadCsvFromEndpoint(ep.failedRows(uploadResult.batchId), `failed-records-${uploadResult.batchId}.csv`);
    } catch {
      toast.error('Failed to download failed records report.');
    }
  };

  const isWide = filePreview?.previewMappedRows?.length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 backdrop-blur-sm p-4">
      <div className={`glass-panel w-full ${isWide ? 'max-w-3xl' : 'max-w-xl'} p-6 bg-white border border-[--border] text-[--text-primary] shadow-xl rounded-xl space-y-4 max-h-[90vh] overflow-y-auto transition-all`}>
        <div className="flex items-center justify-between border-b border-[--border] pb-3">
          <h3 className="text-lg font-bold text-[--text-primary] flex items-center gap-2">
            <FileSpreadsheet className="text-[--accent]" size={20} />
            <span>{title}</span>
          </h3>
          <button onClick={handleClose} className="p-1 border border-[--border-strong] rounded text-[--text-secondary] hover:bg-stone-50">
            <X size={16} />
          </button>
        </div>

        {uploadStatus === 'idle' && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div
              className="border-2 border-dashed border-[--border-strong] rounded-xl p-6 text-center bg-stone-50/50 hover:bg-stone-50 transition-all cursor-pointer relative"
              onClick={() => document.getElementById('bulk-import-file-picker').click()}
            >
              <input
                type="file"
                id="bulk-import-file-picker"
                accept={ACCEPTED_EXTENSIONS.join(',')}
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
                  if (!ACCEPTED_EXTENSIONS.includes(ext)) {
                    toast.error('Invalid file format. Please upload a .csv, .xlsx, or .xls file.');
                    setSelectedFile(null);
                    return;
                  }
                  const MAX_SIZE_MB = 4.5;
                  const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024;
                  if (file.size > MAX_SIZE_BYTES) {
                    toast.error(`File size (${(file.size / 1024 / 1024).toFixed(2)} MB) exceeds Vercel limit of ${MAX_SIZE_MB} MB. Please check for empty/ghost rows, trim the sheet, and try again.`);
                    setSelectedFile(null);
                    return;
                  }
                  setSelectedFile(file);
                }}
              />
              <Upload className="mx-auto text-[--text-muted] mb-2" size={28} />
              {selectedFile ? (
                <div>
                  <p className="text-sm font-semibold text-[--accent]">{selectedFile.name}</p>
                  <p className="text-xs text-[--text-secondary] mt-1">{(selectedFile.size / 1024).toFixed(1)} KB (Click to change)</p>
                </div>
              ) : (
                <div>
                  <p className="text-sm font-semibold text-[--text-primary]">Click to select a CSV or Excel file</p>
                  <p className="text-xs text-[--text-secondary] mt-1">Accepts .csv, .xlsx, or .xls</p>
                </div>
              )}
            </div>

            {previewLoading && (
              <p className="text-xs text-[--text-secondary]">Checking file against import rules…</p>
            )}

            {filePreview && !previewLoading && !filePreview.previewFailed && (
              <div className="space-y-2">
                <div className={`text-xs rounded-lg border p-3 space-y-1.5 ${filePreview.invalidCount > 0 ? 'border-amber-200 bg-amber-50/50' : 'border-emerald-200 bg-emerald-50/50'}`}>
                  <p className="font-semibold">
                    {filePreview.validCount} of {filePreview.totalRows} rows look valid
                    {filePreview.invalidCount > 0 ? `, ${filePreview.invalidCount} have problems.` : '.'}
                  </p>
                  {filePreview.invalidCount > 0 && (
                    <>
                      <p className="text-[--text-secondary]">
                        Invalid rows will be rejected server-side and listed in the error report after upload.
                      </p>
                      <div className="max-h-20 overflow-y-auto font-mono space-y-0.5 text-[11px]">
                        {filePreview.rowErrors.slice(0, 5).map((re, i) => (
                          <div key={i}>Row {re.row}: {re.errors.map((er) => er.message).join('; ')}</div>
                        ))}
                      </div>
                    </>
                  )}
                </div>

                {filePreview.previewMappedRows?.length > 0 && (
                  <div className="space-y-1.5 pt-1">
                    <div className="flex items-center gap-1 text-[10px] font-black uppercase text-[--text-secondary]">
                      <Eye size={12} className="text-[--accent]" />
                      <span>Extracted Data Preview (First {filePreview.previewMappedRows.length} Rows):</span>
                    </div>
                    <div className="overflow-x-auto border border-[--border] rounded-lg max-h-48 bg-stone-50/50 shadow-inner">
                      <table className="w-full text-[11px] text-left">
                        <thead>
                          <tr className="border-b border-[--border] bg-stone-100 text-[10px] uppercase font-bold text-[--text-secondary]">
                            {filePreview.schemaFields.map((f) => (
                              <th key={f.key} className="px-2.5 py-1.5 whitespace-nowrap">
                                {f.label}{f.required && ' *'}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {filePreview.previewMappedRows.map((row, idx) => (
                            <tr key={idx} className="border-b border-[--border] hover:bg-white transition-colors">
                              {filePreview.schemaFields.map((f) => (
                                <td key={f.key} className="px-2.5 py-1.5 whitespace-nowrap text-[--text-primary] font-mono text-[11px]">
                                  {row[f.key] ? (
                                    <span>{row[f.key]}</span>
                                  ) : (
                                    <span className="text-[--text-muted] italic opacity-50">-</span>
                                  )}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}

            {filePreview?.previewFailed && (
              <p className="text-xs text-[--text-muted]">Could not preview this file locally — it will still be validated when uploaded.</p>
            )}

            {(showSubVertical || leadTypeOptions) && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {showSubVertical && subVerticals.length > 0 && (
                  <FilterInput label="Select Target Sub-Vertical *">
                    <select value={subVerticalId} onChange={(e) => setSubVerticalId(e.target.value)} className="w-full">
                      <option value="">-- All Sub-Verticals / Unassigned --</option>
                      {subVerticals.map((sub) => (
                        <option key={sub._id} value={sub._id}>{sub.name}</option>
                      ))}
                    </select>
                  </FilterInput>
                )}

                {leadTypeOptions ? (
                  <FilterInput label="Which type of leads">
                    <select value={currentLeadType} onChange={(e) => setCurrentLeadType(e.target.value)} className="w-full font-semibold">
                      {leadTypeOptions.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </FilterInput>
                ) : null}
              </div>
            )}

            {showAssignOperator && (
              <FilterInput label="Assign Operator (optional)">
                <SearchableOperatorSelect agents={agents} value={assignTarget} onChange={setAssignTarget} placeholder="-- Unassigned --" />
              </FilterInput>
            )}

            <div className="flex items-center justify-between pt-2 border-t border-[--border]">
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => handleDownloadTemplate('xlsx')}
                  className="text-xs font-bold text-[--accent] hover:underline flex items-center gap-1 bg-transparent border-0 cursor-pointer"
                >
                  <Download size={13} />
                  <span>Excel Template</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleDownloadTemplate('csv')}
                  className="text-xs font-bold text-[--accent] hover:underline flex items-center gap-1 bg-transparent border-0 cursor-pointer"
                >
                  <Download size={13} />
                  <span>CSV Template</span>
                </button>
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleClose}
                  className="px-4 py-2 border border-[--border-strong] rounded-lg text-sm text-[--text-secondary] font-semibold bg-white hover:bg-stone-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!selectedFile}
                  className="px-4 py-2 bg-[--accent] text-white rounded-lg font-bold text-sm hover:bg-[--accent-hover] shadow-sm disabled:opacity-40"
                >
                  Import
                </button>
              </div>
            </div>
          </form>
        )}

        {(uploadStatus === 'uploading' || uploadStatus === 'processing') && (
          <div className="py-8 flex flex-col items-center justify-center space-y-4 text-center">
            <Loader />
            <div className="w-full max-w-xs space-y-1">
              <p className="text-sm font-semibold text-[--text-primary]">
                {uploadStatus === 'uploading' ? 'Uploading file to server...' : 'Processing in background...'}
              </p>
              <div className="w-full bg-stone-100 h-2 rounded-full overflow-hidden">
                <div className="bg-[--accent] h-full transition-all duration-300" style={{ width: `${uploadProgress}%` }}></div>
              </div>
              <p className="text-[10px] text-[--text-secondary] font-mono">{uploadProgress}% processed</p>
            </div>
          </div>
        )}

        {(uploadStatus === 'done' || uploadStatus === 'failed') && uploadResult && (
          <div className="space-y-4">
            <div className="flex flex-col items-center text-center space-y-2 py-4">
              <div className={`w-12 h-12 rounded-full flex items-center justify-center ${uploadStatus === 'done' ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-600'}`}>
                <CheckCircle2 size={28} />
              </div>
              <h4 className="text-md font-bold text-[--text-primary]">
                {uploadStatus === 'done' ? 'Import Completed' : 'Import Failed'}
              </h4>
            </div>

            <div className="grid grid-cols-3 gap-2 text-center text-xs">
              <div className="bg-green-50/50 border border-green-100 p-2.5 rounded-lg">
                <span className="block text-lg font-black text-green-600">{uploadResult.successCount}</span>
                <span className="text-[10px] text-[--text-secondary] font-semibold">Success</span>
              </div>
              <div className="bg-amber-50/50 border border-amber-100 p-2.5 rounded-lg">
                <span className="block text-lg font-black text-amber-500">{uploadResult.duplicateCount}</span>
                <span className="text-[10px] text-[--text-secondary] font-semibold">Skipped (Dup)</span>
              </div>
              <div className="bg-red-50/50 border border-red-100 p-2.5 rounded-lg">
                <span className="block text-lg font-black text-red-600">{uploadResult.failedCount}</span>
                <span className="text-[10px] text-[--text-secondary] font-semibold">Errors</span>
              </div>
            </div>

            {uploadResult.errors.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex justify-between items-center">
                  <span className="text-[10px] font-bold text-red-600 uppercase tracking-wider block">Error Log Summary:</span>
                  {uploadResult.batchId && (
                    <button
                      type="button"
                      onClick={downloadFailedRecords}
                      className="text-[10px] font-bold text-[--accent] hover:underline flex items-center gap-1 bg-transparent border-0 cursor-pointer"
                    >
                      <Download size={11} />
                      <span>Download Failed Records</span>
                    </button>
                  )}
                </div>
                <div className="border border-red-100 rounded-lg p-3 bg-red-50/20 max-h-[140px] overflow-y-auto text-xs font-mono text-red-600 space-y-1">
                  {uploadResult.errors.slice(0, 50).map((err, idx) => (
                    <div key={idx} className="flex gap-2">
                      <span className="font-bold">Row {err.row}:</span>
                      <span>{err.reason}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-end pt-2">
              <button
                onClick={handleClose}
                className="px-6 py-2 bg-[--accent] text-white font-bold rounded-lg text-sm hover:bg-[--accent-hover] shadow-sm"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
