/* eslint-disable i18next/no-literal-string */
import React, { useEffect, useState } from 'react';
import {
  AlertTriangle, Filter, RefreshCw, Download, ChevronDown, ChevronUp,
  CheckCircle2, XCircle, Loader2, Copy,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { getOperationReports, failedRowsUrl } from '../api/operationReports.js';
import { downloadCsvFromEndpoint } from '../utils/downloadReport.js';
import { extractErrorMessage } from '../utils/errorMessage.js';

const t = (val) => val;

const OPERATION_LABELS = {
  bulk_upload: 'Bulk Upload',
  promote: 'Promote to Follow-ups',
  duplicate_scan: 'Duplicate Scan',
};

// entity_type + lead_type together disambiguate all 4 sections — see
// server/src/controllers/followUps.js/costConversions.js, which both write
// lead_type='CALL' for promote/duplicate_scan reports (COS-only operations,
// Positives leads are excluded from both by design).
function sectionLabel(report) {
  if (report.entity_type === 'raw_data') return 'Raw Data';
  if (report.entity_type === 'delivery_data') return 'Delivery Data';
  return report.lead_type === 'POSITIVE' ? 'Positives & Follow-ups' : 'COS';
}

const STATUS_STYLE = {
  done: 'bg-green-50 text-green-700 border-green-200',
  processing: 'bg-blue-50 text-blue-700 border-blue-200',
  queued: 'bg-stone-50 text-stone-700 border-stone-200',
  failed: 'bg-red-50 text-red-700 border-red-200',
};

export const OperationReportsPage = () => {
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [operationType, setOperationType] = useState('');
  const [entityType, setEntityType] = useState('');

  const LIMIT = 25;

  const fetchReports = async (targetPage = 1, append = false) => {
    setLoading(true);
    try {
      const res = await getOperationReports({ page: targetPage, limit: LIMIT, operationType: operationType || undefined, entityType: entityType || undefined });
      const rows = res.data.data || [];
      setReports((prev) => (append ? [...prev, ...rows] : rows));
      setHasMore(rows.length === LIMIT);
      setPage(targetPage);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Failed to load operation reports'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReports(1, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operationType, entityType]);

  const handleDownload = async (report) => {
    if (!report.errors || report.errors.length === 0) {
      toast.error('No errors to download for this report.');
      return;
    }
    try {
      await downloadCsvFromEndpoint(failedRowsUrl(report.id), `error-report-${report.id}.csv`);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Failed to download error report'));
    }
  };

  const copyCorrelationId = (id) => {
    navigator.clipboard?.writeText(id);
    toast.success('Report ID copied — use this as the correlation reference.');
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-black text-[--text-primary] uppercase tracking-wider flex items-center gap-2">
            <AlertTriangle size={22} className="text-[--accent]" />
            {t('Operation Reports')}
          </h2>
          <p className="text-xs text-[--text-secondary] mt-1">
            {t('Persisted results for bulk uploads, promotions, and duplicate scans across every section — every report is downloadable and every failure is traceable by its report ID.')}
          </p>
        </div>
        <button
          onClick={() => fetchReports(1, false)}
          className="flex items-center gap-1.5 px-3 py-2 bg-white hover:bg-stone-50 border border-[--border-strong] text-[--text-secondary] font-semibold text-xs rounded-lg transition-all shadow-sm self-start"
        >
          <RefreshCw size={13} />
          <span>{t('Refresh')}</span>
        </button>
      </div>

      <div className="glass-panel bg-white shadow-sm border border-[--border] p-6 space-y-4 rounded-xl">
        {/* Filter bar */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 bg-stone-50 p-4 rounded-xl border border-[--border]">
          <div className="flex flex-col gap-1.5 text-xs">
            <label className="font-bold text-[--text-secondary] uppercase flex items-center gap-1">
              <Filter size={12} className="text-[--text-muted]" />
              <span>{t('Operation Type')}</span>
            </label>
            <select
              value={operationType}
              onChange={(e) => setOperationType(e.target.value)}
              className="bg-white border border-[--border-strong] rounded-lg px-3 py-2 text-[--text-primary] focus:outline-none focus:border-[--accent] text-xs font-semibold"
            >
              <option value="">{t('All Operation Types')}</option>
              <option value="bulk_upload">{t('Bulk Upload')}</option>
              <option value="promote">{t('Promote to Follow-ups')}</option>
              <option value="duplicate_scan">{t('Duplicate Scan')}</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5 text-xs">
            <label className="font-bold text-[--text-secondary] uppercase flex items-center gap-1">
              <Filter size={12} className="text-[--text-muted]" />
              <span>{t('Section')}</span>
            </label>
            <select
              value={entityType}
              onChange={(e) => setEntityType(e.target.value)}
              className="bg-white border border-[--border-strong] rounded-lg px-3 py-2 text-[--text-primary] focus:outline-none focus:border-[--accent] text-xs font-semibold"
            >
              <option value="">{t('All Sections')}</option>
              <option value="lead">{t('COS / Positives & Follow-ups')}</option>
              <option value="raw_data">{t('Raw Data')}</option>
              <option value="delivery_data">{t('Delivery Data')}</option>
            </select>
          </div>
        </div>

        {/* Results table */}
        <div className="border border-[--border] rounded-xl overflow-hidden mt-4">
          <div className="overflow-x-auto max-h-[600px]">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-[--border-strong] bg-stone-50 text-[10px] text-[--text-secondary] font-bold uppercase tracking-wider select-none">
                  <th className="px-5 py-3">{t('Timestamp')}</th>
                  <th className="px-5 py-3">{t('Section')}</th>
                  <th className="px-5 py-3">{t('Operation')}</th>
                  <th className="px-5 py-3">{t('Initiated By')}</th>
                  <th className="px-5 py-3">{t('Status')}</th>
                  <th className="px-5 py-3 text-right">{t('Success')}</th>
                  <th className="px-5 py-3 text-right">{t('Failed')}</th>
                  <th className="px-5 py-3 text-right">{t('Duplicate')}</th>
                  <th className="px-5 py-3 text-right">{t('Actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[--border]">
                {reports.length === 0 && !loading ? (
                  <tr>
                    <td colSpan="9" className="text-center py-12 text-[--text-secondary] text-xs italic">
                      <AlertTriangle className="mx-auto mb-2 text-[--text-muted]/30" size={32} />
                      <span>{t('No operation reports found for these filters.')}</span>
                    </td>
                  </tr>
                ) : (
                  reports.map((report) => {
                    const isExpanded = expandedId === report.id;
                    const errors = report.errors || [];
                    return (
                      <React.Fragment key={report.id}>
                        <tr
                          onClick={() => setExpandedId(isExpanded ? null : report.id)}
                          className={`hover:bg-stone-50/50 cursor-pointer transition-all ${isExpanded ? 'bg-stone-50/60 font-medium' : ''}`}
                        >
                          <td className="px-5 py-3.5 text-[--text-secondary] font-mono whitespace-nowrap">
                            {new Date(report.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                          </td>
                          <td className="px-5 py-3.5 text-[--text-primary] font-bold">{sectionLabel(report)}</td>
                          <td className="px-5 py-3.5 text-[--text-secondary] font-semibold">{OPERATION_LABELS[report.operation_type] || report.operation_type}</td>
                          <td className="px-5 py-3.5 text-[--text-secondary]">{report.user_name || 'System'}</td>
                          <td className="px-5 py-3.5">
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[9px] font-bold rounded-md border font-mono uppercase ${STATUS_STYLE[report.status] || STATUS_STYLE.queued}`}>
                              {report.status === 'done' && <CheckCircle2 size={10} />}
                              {report.status === 'failed' && <XCircle size={10} />}
                              {(report.status === 'processing' || report.status === 'queued') && <Loader2 size={10} className="animate-spin" />}
                              {report.status}
                            </span>
                          </td>
                          <td className="px-5 py-3.5 text-right font-mono text-green-700 font-bold">{report.success_count ?? 0}</td>
                          <td className="px-5 py-3.5 text-right font-mono text-red-600 font-bold">{report.failed_count ?? 0}</td>
                          <td className="px-5 py-3.5 text-right font-mono text-amber-600 font-bold">{report.duplicate_count ?? 0}</td>
                          <td className="px-5 py-3.5 text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              {errors.length > 0 && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleDownload(report); }}
                                  title="Download full report as CSV"
                                  className="p-1.5 border border-[--border-strong] hover:bg-white text-[--text-secondary] rounded-lg transition-all shadow-sm"
                                >
                                  <Download size={13} />
                                </button>
                              )}
                              <button
                                onClick={(e) => { e.stopPropagation(); setExpandedId(isExpanded ? null : report.id); }}
                                className="p-1.5 border border-[--border-strong] hover:bg-white text-[--text-secondary] rounded-lg transition-all shadow-sm"
                              >
                                {isExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                              </button>
                            </div>
                          </td>
                        </tr>

                        {isExpanded && (
                          <tr className="bg-stone-50/20">
                            <td colSpan="9" className="px-6 py-4 border-t border-b border-stone-200/50">
                              <div className="space-y-3">
                                <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 text-[10px] text-[--text-secondary] font-mono">
                                  <span>{t('Total Rows')}: {report.total_rows ?? 0}</span>
                                  <span className="flex items-center gap-1">
                                    {t('Report ID (correlation reference)')}: {report.id}
                                    <button onClick={() => copyCorrelationId(report.id)} className="text-[--accent] hover:text-[--accent-hover]" title="Copy report ID">
                                      <Copy size={10} />
                                    </button>
                                  </span>
                                  {report.original_file_name && <span>{t('File')}: {report.original_file_name}</span>}
                                </div>

                                {errors.length === 0 ? (
                                  <p className="text-xs text-[--text-secondary] italic">{t('No per-row errors recorded for this operation.')}</p>
                                ) : (
                                  <div className="border border-[--border-strong] rounded-lg overflow-hidden max-h-[300px] overflow-y-auto">
                                    <table className="w-full text-left text-[11px] border-collapse">
                                      <thead className="sticky top-0 bg-stone-100">
                                        <tr className="text-[9px] text-[--text-secondary] font-bold uppercase">
                                          <th className="px-3 py-2">{t('Row')}</th>
                                          <th className="px-3 py-2">{t('Code')}</th>
                                          <th className="px-3 py-2">{t('Field')}</th>
                                          <th className="px-3 py-2">{t('Reason')}</th>
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-[--border]">
                                        {errors.slice(0, 200).map((e, idx) => (
                                          <tr key={idx}>
                                            <td className="px-3 py-1.5 font-mono">{e.row ?? '-'}</td>
                                            <td className="px-3 py-1.5 font-mono text-[--accent]">{e.code || '-'}</td>
                                            <td className="px-3 py-1.5 font-mono">{e.field || e.recordId || '-'}</td>
                                            <td className="px-3 py-1.5">{e.reason}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                    {errors.length > 200 && (
                                      <p className="text-[10px] text-[--text-muted] px-3 py-2 italic">
                                        {t('Showing first 200 of')} {errors.length} — {t('download the full report for all rows.')}
                                      </p>
                                    )}
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })
                )}

                {loading && (
                  <tr>
                    <td colSpan="9" className="text-center py-6">
                      <div className="flex justify-center items-center gap-2 text-xs text-[--text-secondary]">
                        <div className="spinner shrink-0"></div>
                        <span>{t('Loading operation reports...')}</span>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {hasMore && !loading && (
            <div className="p-3 border-t border-[--border] bg-stone-50/50 flex justify-center">
              <button
                onClick={() => fetchReports(page + 1, true)}
                className="px-4 py-2 bg-white hover:bg-stone-50 border border-[--border-strong] text-[--text-primary] text-xs font-bold rounded-lg transition-all shadow-sm uppercase flex items-center gap-1.5"
              >
                <RefreshCw size={13} className="text-[--accent]" />
                <span>{t('Load More Reports')}</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default OperationReportsPage;
