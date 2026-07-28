import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import {
  Filter, Download, Upload, Plus, ChevronLeft, ChevronRight, ChevronDown,
  FileSpreadsheet, AlertTriangle,
} from 'lucide-react';
import toast from 'react-hot-toast';
import axios from '../api/axios.js';
import { useUiStore } from '../store/uiStore.js';
import Loader from './Loader.jsx';
import VerticalSelectionBar from './VerticalSelectionBar.jsx';
import SearchableOperatorSelect from './SearchableOperatorSelect.jsx';

/**
 * Generic, config-driven "section" page shell — Raw Data and Delivery Data
 * are both thin instantiations of this (see pages/RawDataPage.jsx,
 * pages/DeliveryDataPage.jsx). It matches the *pattern* established by
 * LeadsPage.jsx / FollowUpsPositivesPage.jsx (URL-search-params-driven
 * server-side fetch, Prev/Next pagination, loading/empty states) without
 * sharing code with those two pages — they're large, deeply feature-specific
 * monoliths (custom fields, geotag photo upload, bulk status, a calendar
 * panel) that a live retrofit onto a shared shell would put at real
 * regression risk for zero functional gain. See the plan doc for the full
 * reasoning.
 *
 * `config` shape:
 * {
 *   title, description, icon,                    // header
 *   columns: [{ key, label, render?(row) }],      // visible-by-default columns
 *   detailFields: [{ key, label, render?(row) }], // rest, shown in an expandable row
 *   sortableColumns: ['date', 'businessName', ...],// must match the backend's sort whitelist
 *   endpoints: { list, exportCsv },                // base URL strings; query string is built here
 *   filenamePrefix,                                // exported CSV filename prefix
 *   ModalComponent,                                 // RawDataModal | DeliveryDataModal — reused as-is
 *   emptyStateText,
 * }
 *
 * Sorting/filtering/pagination are 100% server-side — the URL search params
 * are the canonical state, exactly like LeadsPage.jsx's `fetchLeads` pattern.
 * No client-side slicing/filtering of `records` happens anywhere here.
 */
export default function DataSectionPage({ config }) {
  const {
    title, description, icon: Icon, columns, detailFields = [], endpoints,
    ModalComponent, emptyStateText, sortableColumns = [], filenamePrefix = 'export',
  } = config;

  const navigate = useNavigate();
  const location = useLocation();
  const { activeVertical, setActiveVertical, leadsRefreshTrigger } = useUiStore();
  const [searchParams, setSearchParams] = useSearchParams();

  const [verticals, setVerticals] = useState([]);
  const [agents, setAgents] = useState([]);
  const [records, setRecords] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [expandedRowId, setExpandedRowId] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState('single');
  const [searchInput, setSearchInput] = useState('');

  const page = parseInt(searchParams.get('page') || '1', 10);
  const limit = parseInt(searchParams.get('limit') || '15', 10);
  const search = searchParams.get('q') || '';
  const sortBy = searchParams.get('sortBy') || 'createdAt';
  const sortDir = searchParams.get('sortDir') || 'desc';
  const dateFrom = searchParams.get('dateFrom') || '';
  const dateTo = searchParams.get('dateTo') || '';
  const businessType = searchParams.get('businessType') || '';
  const city = searchParams.get('city') || '';
  const assignedUserId = searchParams.get('assignedUserId') || '';

  const activeFiltersCount = [dateFrom, dateTo, businessType, city, assignedUserId].filter(Boolean).length;

  useEffect(() => { setSearchInput(search); }, [search]);

  const updateQueryParam = useCallback((key, value, options = { resetPage: true }) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value); else next.delete(key);
    if (options.resetPage) next.set('page', '1');
    setSearchParams(next);
  }, [searchParams, setSearchParams]);

  // Same "fetch verticals for the landing selector" pattern as LeadsPage.jsx / FollowUpsPositivesPage.jsx.
  useEffect(() => {
    let cancelled = false;
    axios.get('/api/v1/verticals').then(({ data }) => { if (!cancelled) setVerticals(data.data || []); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Same global-agents fetch LeadsPage.jsx uses for its operator dropdowns.
  useEffect(() => {
    let cancelled = false;
    axios.get('/api/v1/users?active=true').then(({ data }) => {
      if (cancelled) return;
      setAgents((data.data || []).filter(u => u.is_active !== false && u.is_approved !== false));
    }).catch(() => { if (!cancelled) setAgents([]); });
    return () => { cancelled = true; };
  }, []);

  const fetchRecords = useCallback(async () => {
    if (!activeVertical) return;
    setLoading(true);
    setError('');
    try {
      const qParams = new URLSearchParams({
        verticalId: activeVertical._id, page: String(page), limit: String(limit),
        search, sortBy, sortDir,
      });
      if (dateFrom) qParams.set('dateFrom', dateFrom);
      if (dateTo) qParams.set('dateTo', dateTo);
      if (businessType) qParams.set('businessType', businessType);
      if (city) qParams.set('city', city);
      if (assignedUserId) qParams.set('assignedUserId', assignedUserId);

      const res = await axios.get(`${endpoints.list}?${qParams.toString()}`);
      setRecords(res.data.data || []);
      setTotal(res.data.meta?.total || 0);
      setTotalPages(res.data.meta?.totalPages || 1);
    } catch (err) {
      console.error(`Error fetching ${title}:`, err);
      const message = err.response?.data?.error || `Failed to load ${title}`;
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [activeVertical, page, limit, search, sortBy, sortDir, dateFrom, dateTo, businessType, city, assignedUserId, endpoints.list, title]);

  useEffect(() => { fetchRecords(); }, [fetchRecords]);

  // Real-time sync: a scoped, debounced poll signal (see useRealtimeAssignments.js)
  // bumps this same trigger LeadsPage/FollowUpsPositivesPage already use —
  // this page previously didn't react to it at all, so other users' bulk
  // uploads/edits here only appeared on manual refresh.
  useEffect(() => { if (leadsRefreshTrigger > 0) fetchRecords(); }, [leadsRefreshTrigger]);

  // Debounced search box -> URL, same 400ms convention as LeadsPage.jsx.
  useEffect(() => {
    const t = setTimeout(() => { if (searchInput !== search) updateQueryParam('q', searchInput); }, 400);
    return () => clearTimeout(t);
  }, [searchInput, search, updateQueryParam]);

  const handleSort = (key) => {
    if (!sortableColumns.includes(key)) return;
    const next = new URLSearchParams(searchParams);
    if (sortBy === key) {
      next.set('sortDir', sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      next.set('sortBy', key);
      next.set('sortDir', 'asc');
    }
    setSearchParams(next);
  };

  const handleExport = async () => {
    if (!activeVertical) return;
    try {
      const qParams = new URLSearchParams({ verticalId: activeVertical._id, sortBy, sortDir });
      if (search) qParams.set('search', search);
      if (dateFrom) qParams.set('dateFrom', dateFrom);
      if (dateTo) qParams.set('dateTo', dateTo);
      if (businessType) qParams.set('businessType', businessType);
      if (city) qParams.set('city', city);
      if (assignedUserId) qParams.set('assignedUserId', assignedUserId);
      const res = await axios.get(`${endpoints.exportCsv}?${qParams.toString()}`, { responseType: 'blob' });
      const blob = new Blob([res.data], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${filenamePrefix}-${activeVertical.slug || activeVertical._id}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Failed to export CSV');
    }
  };

  const openAdd = () => { setModalMode('single'); setModalOpen(true); };
  const openImport = () => { setModalMode('bulk'); setModalOpen(true); };
  const resetAllFilters = () => setSearchParams({ verticalId: activeVertical?._id || '' });

  const selectVertical = (v) => {
    setActiveVertical(v);
    navigate(`${location.pathname}?verticalId=${v._id}`);
  };

  // ── No vertical selected yet — same landing pattern as Leads/Follow-ups ──
  if (!activeVertical) {
    return (
      <div className="space-y-6">
        <div className="border-b border-[--border] pb-4">
          <h1 className="text-2xl font-black text-[--text-primary] uppercase tracking-wider">{title}</h1>
          <p className="text-xs text-[--text-secondary] mt-1">Select a vertical to view records</p>
        </div>
        <VerticalSelectionBar verticals={verticals} activeVerticalId={null} onSelect={selectVertical} />
        <div className="glass-panel border border-[--border] bg-white p-12 text-center text-xs text-[--text-secondary] flex items-center justify-center flex-col gap-2 shadow-sm min-h-[300px]">
          {Icon && <Icon size={44} className="text-[--text-muted]/30" />}
          <h3 className="font-bold text-sm text-[--text-primary] mt-2">No Active Business Vertical</h3>
          <p className="max-w-xs leading-relaxed">Please select a business vertical from the selector above.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[--text-primary]">{activeVertical.name} – {title}</h1>
          <p className="text-sm text-[--text-secondary] mt-1">{description}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {location.pathname !== '/leads' && (
            <button
              type="button"
              onClick={() => navigate(`/leads?verticalId=${activeVertical?._id}`)}
              className="inline-flex items-center gap-2 px-4 py-2 border border-emerald-300 hover:border-emerald-500 text-emerald-600 bg-white rounded-lg font-bold text-sm hover:bg-stone-50 shadow-sm transition-all"
            >
              <span>COS →</span>
            </button>
          )}
          {location.pathname !== '/follow-ups-positives' && (
            <button
              type="button"
              onClick={() => navigate(`/follow-ups-positives?verticalId=${activeVertical?._id}`)}
              className="inline-flex items-center gap-2 px-4 py-2 border border-emerald-300 hover:border-emerald-500 text-emerald-600 bg-white rounded-lg font-bold text-sm hover:bg-stone-50 shadow-sm transition-all"
            >
              <span>Positives & Follow-ups →</span>
            </button>
          )}
          {location.pathname !== '/raw-data' && (
            <button
              type="button"
              onClick={() => navigate(`/raw-data?verticalId=${activeVertical?._id}`)}
              className="inline-flex items-center gap-2 px-4 py-2 border border-emerald-300 hover:border-emerald-500 text-emerald-600 bg-white rounded-lg font-bold text-sm hover:bg-stone-50 shadow-sm transition-all"
            >
              <span>Raw Data →</span>
            </button>
          )}
          {location.pathname !== '/delivery-data' && (
            <button
              type="button"
              onClick={() => navigate(`/delivery-data?verticalId=${activeVertical?._id}`)}
              className="inline-flex items-center gap-2 px-4 py-2 border border-emerald-300 hover:border-emerald-500 text-emerald-600 bg-white rounded-lg font-bold text-sm hover:bg-stone-50 shadow-sm transition-all"
            >
              <span>Delivery Data →</span>
            </button>
          )}
          <button type="button" onClick={() => setShowFilters((s) => !s)}
            className="inline-flex items-center gap-2 px-4 py-2 border border-[--border-strong] rounded-lg hover:bg-stone-50 text-sm text-[--text-secondary] bg-white font-medium shadow-sm">
            <Filter size={16} /><span>Filters</span>
            {activeFiltersCount > 0 && (
              <span className="ml-1 px-1.5 py-0.5 bg-[--accent] text-white text-[10px] font-black rounded-full leading-none">{activeFiltersCount}</span>
            )}
          </button>
          <button type="button" onClick={handleExport}
            className="inline-flex items-center gap-2 px-4 py-2 border border-[--border-strong] rounded-lg hover:bg-stone-50 text-sm text-[--text-secondary] bg-white font-medium shadow-sm">
            <Download size={16} /><span>Export</span>
          </button>
          <button type="button" onClick={openImport}
            className="inline-flex items-center gap-2 px-4 py-2 border border-[--border-strong] rounded-lg hover:bg-stone-50 text-sm text-[--text-secondary] bg-white font-medium shadow-sm">
            <Upload size={16} /><span>Import</span>
          </button>
          <button type="button" onClick={openAdd}
            className="inline-flex items-center gap-2 px-4 py-2 bg-[--accent] text-white rounded-lg font-bold text-sm hover:bg-[--accent-hover] shadow-sm transition-all">
            <Plus size={16} /><span>Add</span>
          </button>
        </div>
      </div>

      <VerticalSelectionBar verticals={verticals} activeVerticalId={activeVertical._id} onSelect={selectVertical} />

      <div className="flex flex-col gap-1.5 max-w-sm">
        <span className="text-[10px] font-black uppercase text-[--text-secondary]">Search</span>
        <input
          type="text"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search business name or phone..."
          className="w-full"
        />
      </div>

      {showFilters && (
        <div className="glass-panel border border-[--border] bg-white p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 shadow-sm">
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-black uppercase text-[--text-secondary]">Date From</span>
            <input type="date" value={dateFrom} onChange={(e) => updateQueryParam('dateFrom', e.target.value)} className="w-full" />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-black uppercase text-[--text-secondary]">Date To</span>
            <input type="date" value={dateTo} onChange={(e) => updateQueryParam('dateTo', e.target.value)} className="w-full" />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-black uppercase text-[--text-secondary]">Employee</span>
            <SearchableOperatorSelect agents={agents} value={assignedUserId} onChange={(v) => updateQueryParam('assignedUserId', v)} placeholder="-- All employees --" />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-black uppercase text-[--text-secondary]">Business Type</span>
            <input type="text" value={businessType} onChange={(e) => updateQueryParam('businessType', e.target.value)} className="w-full" />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-black uppercase text-[--text-secondary]">City</span>
            <input type="text" value={city} onChange={(e) => updateQueryParam('city', e.target.value)} className="w-full" />
          </div>
          <div className="lg:col-span-5 flex justify-end">
            <button type="button" onClick={resetAllFilters}
              className="px-4 py-2 border border-[--border-strong] rounded-lg text-sm text-[--text-secondary] font-semibold bg-white hover:bg-stone-50">
              Reset All Filters
            </button>
          </div>
        </div>
      )}

      <div className="glass-panel overflow-hidden bg-white border border-[--border] shadow-sm">
        {loading ? (
          <div className="py-20 flex justify-center"><Loader /></div>
        ) : error ? (
          <div className="py-16 text-center text-[--text-secondary]">
            <AlertTriangle className="mx-auto text-red-300 mb-3" size={44} />
            <p className="text-sm font-semibold text-red-600">Failed to load {title}.</p>
            <p className="text-xs text-[--text-muted] mt-1">{error}</p>
            <button type="button" onClick={fetchRecords} className="mt-4 px-4 py-2 border border-[--border-strong] rounded-lg text-sm font-semibold bg-white hover:bg-stone-50">
              Retry
            </button>
          </div>
        ) : records.length === 0 ? (
          <div className="py-16 text-center text-[--text-secondary]">
            <FileSpreadsheet className="mx-auto text-[--text-muted]/30 mb-3" size={48} />
            <p className="text-sm font-semibold">{emptyStateText || 'No records yet — add one or import a file.'}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[--border] text-left text-[10px] uppercase font-black text-[--text-secondary]">
                  <th className="px-4 py-3 w-8"></th>
                  {columns.map((col) => (
                    <th key={col.key} className="px-4 py-3">
                      {sortableColumns.includes(col.key) ? (
                        <button type="button" onClick={() => handleSort(col.key)} className="inline-flex items-center gap-1 hover:text-[--text-primary]">
                          {col.label}
                          {sortBy === col.key && <ChevronDown size={12} className={sortDir === 'asc' ? 'rotate-180' : ''} />}
                        </button>
                      ) : col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {records.map((row) => {
                  const rowId = row.id || row._id;
                  const expanded = expandedRowId === rowId;
                  return (
                    <React.Fragment key={rowId}>
                      <tr className="border-b border-[--border] hover:bg-stone-50/60">
                        <td className="px-4 py-3">
                          {detailFields.length > 0 && (
                            <button type="button" onClick={() => setExpandedRowId(expanded ? null : rowId)} className="text-[--text-muted] hover:text-[--text-primary]">
                              <ChevronRight size={14} className={`transition-transform ${expanded ? 'rotate-90' : ''}`} />
                            </button>
                          )}
                        </td>
                        {columns.map((col) => (
                          <td key={col.key} className="px-4 py-3 text-[--text-primary]">
                            {col.render ? col.render(row) : (row[col.key] || '-')}
                          </td>
                        ))}
                      </tr>
                      {expanded && (
                        <tr className="bg-stone-50/50 border-b border-[--border]">
                          <td colSpan={columns.length + 1} className="px-8 py-4">
                            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-xs">
                              {detailFields.map((f) => (
                                <div key={f.key}>
                                  <span className="block font-black uppercase text-[9px] text-[--text-secondary]">{f.label}</span>
                                  <span className="text-[--text-primary]">{f.render ? f.render(row) : (row[f.key] || '-')}</span>
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-[--text-secondary] font-mono select-none">
          <span>Page {page} of {totalPages} (total {total} records)</span>
          <div className="flex gap-2">
            <button disabled={page <= 1} onClick={() => updateQueryParam('page', String(page - 1), { resetPage: false })}
              className="px-3 py-1.5 border border-[--border-strong] hover:bg-stone-50 rounded-lg disabled:opacity-30 bg-white">
              <ChevronLeft size={14} className="inline mr-1" /> Prev
            </button>
            <button disabled={page >= totalPages} onClick={() => updateQueryParam('page', String(page + 1), { resetPage: false })}
              className="px-3 py-1.5 border border-[--border-strong] hover:bg-stone-50 rounded-lg disabled:opacity-30 bg-white">
              Next <ChevronRight size={14} className="inline ml-1" />
            </button>
          </div>
        </div>
      )}

      {ModalComponent && (
        <ModalComponent
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          vertical={activeVertical}
          agents={agents}
          initialMode={modalMode}
          onSaved={fetchRecords}
        />
      )}
    </div>
  );
}
