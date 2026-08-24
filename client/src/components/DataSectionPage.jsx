import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import {
  Filter, Download, Upload, Plus, ChevronLeft, ChevronRight, ChevronDown,
  FileSpreadsheet, AlertTriangle, Layers, MessageSquare, Calendar, Clock, Trash2, Edit,
} from 'lucide-react';
import toast from 'react-hot-toast';
import axios from '../api/axios.js';
import { useUiStore } from '../store/uiStore.js';
import { useAuthStore } from '../store/authStore.js';
import Loader from './Loader.jsx';
import VerticalSelectionBar from './VerticalSelectionBar.jsx';
import SearchableOperatorSelect from './SearchableOperatorSelect.jsx';

/**
 * Generic, config-driven "section" page shell — Raw Data and Delivery Data
 * are both thin instantiations of this (see pages/RawDataPage.jsx,
 * pages/DeliveryDataPage.jsx).
 */
export default function DataSectionPage({ config }) {
  const {
    title, description, icon: Icon, columns, detailFields = [], endpoints,
    ModalComponent, emptyStateText, sortableColumns = [], filenamePrefix = 'export',
  } = config;

  const navigate = useNavigate();
  const location = useLocation();
  const { activeVertical, setActiveVertical, leadsRefreshTrigger } = useUiStore();
  const { user } = useAuthStore();
  const [searchParams, setSearchParams] = useSearchParams();

  const isAdmin = user?.role === 'super_admin' || user?.role === 'vertical_admin';

  const [verticals, setVerticals] = useState([]);
  const [subVerticals, setSubVerticals] = useState([]);
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
  const [interactionCounts, setInteractionCounts] = useState({});

  const page = parseInt(searchParams.get('page') || '1', 10);
  const limit = parseInt(searchParams.get('limit') || '15', 10);
  const search = searchParams.get('q') || '';
  const sortBy = searchParams.get('sortBy') || 'createdAt';
  const sortDir = searchParams.get('sortDir') || 'desc';
  const subVerticalId = searchParams.get('subVerticalId') || '';
  const dateFrom = searchParams.get('dateFrom') || '';
  const dateTo = searchParams.get('dateTo') || '';
  const productService = searchParams.get('productService') || searchParams.get('businessType') || '';
  const city = searchParams.get('city') || '';
  const area = searchParams.get('area') || '';
  const callStatus = searchParams.get('callStatus') || '';
  const converted = searchParams.get('converted') || '';
  const assignedUserId = searchParams.get('assignedUserId') || '';

  const activeFiltersCount = [subVerticalId, dateFrom, dateTo, productService, city, area, callStatus, converted, assignedUserId].filter(Boolean).length;

  useEffect(() => { setSearchInput(search); }, [search]);

  const updateQueryParam = useCallback((key, value, options = { resetPage: true }) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value); else next.delete(key);
    if (options.resetPage) next.set('page', '1');
    setSearchParams(next);
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    let cancelled = false;
    axios.get('/api/v1/verticals').then(({ data }) => { if (!cancelled) setVerticals(data.data || []); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!activeVertical) {
      setSubVerticals([]);
      return;
    }
    let cancelled = false;
    axios.get(`/api/v1/verticals/${activeVertical._id}/sub-verticals`)
      .then(({ data }) => {
        if (!cancelled) setSubVerticals((data.data || []).filter(s => s.isActive !== false && s.is_active !== false));
      })
      .catch(() => { if (!cancelled) setSubVerticals([]); });
    return () => { cancelled = true; };
  }, [activeVertical]);

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
      if (!config.hideSubVerticals && subVerticalId) qParams.set('subVerticalId', subVerticalId);
      if (dateFrom) qParams.set('dateFrom', dateFrom);
      if (dateTo) qParams.set('dateTo', dateTo);
      if (productService) qParams.set('productService', productService);
      if (city) qParams.set('city', city);
      if (area) qParams.set('area', area);
      if (callStatus) qParams.set('callStatus', callStatus);
      if (converted) qParams.set('converted', converted);
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
  }, [activeVertical, page, limit, search, sortBy, sortDir, subVerticalId, dateFrom, dateTo, productService, city, area, callStatus, converted, assignedUserId, endpoints.list, title]);

  useEffect(() => { fetchRecords(); }, [fetchRecords]);

  useEffect(() => { if (leadsRefreshTrigger > 0) fetchRecords(); }, [leadsRefreshTrigger]);

  const refreshCounts = useCallback(() => {
    if (!records.length) { setInteractionCounts({}); return; }
    const ids = records.map(r => r.id || r._id).filter(Boolean);
    axios.post('/api/v1/interactionLogs/leads/batch-counts', { leadIds: ids })
      .then(res => setInteractionCounts(res.data.data || {}))
      .catch(() => {});
  }, [records]);

  useEffect(() => {
    refreshCounts();
  }, [records, refreshCounts]);

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
      if (!config.hideSubVerticals && subVerticalId) qParams.set('subVerticalId', subVerticalId);
      if (search) qParams.set('search', search);
      if (dateFrom) qParams.set('dateFrom', dateFrom);
      if (dateTo) qParams.set('dateTo', dateTo);
      if (productService) qParams.set('productService', productService);
      if (city) qParams.set('city', city);
      if (area) qParams.set('area', area);
      if (callStatus) qParams.set('callStatus', callStatus);
      if (converted) qParams.set('converted', converted);
      if (assignedUserId) qParams.set('assignedUserId', assignedUserId);
      let filename = `${filenamePrefix}-${activeVertical.slug || activeVertical._id}`;
      const subVerticalObj = subVerticals.find(s => s._id === subVerticalId);
      if (subVerticalObj) {
        filename += `_${subVerticalObj.slug || subVerticalObj.name}`;
      }
      if (activeFiltersCount > 0) {
        filename += '_filtered';
      }
      filename += `_${new Date().toISOString().split('T')[0]}`;
      const finalDownloadName = `${filename.replace(/[^a-zA-Z0-9_\-]/g, '_')}.csv`;

      const res = await axios.get(`${endpoints.exportCsv}?${qParams.toString()}`, { responseType: 'blob' });
      const blob = new Blob([res.data], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = finalDownloadName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      toast.success(`Successfully exported CSV: ${finalDownloadName}`);
    } catch (err) {
      console.error('Failed to export CSV:', err);
      let errorMsg = 'Failed to export CSV';
      let correlationId = '';

      if (err.response?.data instanceof Blob) {
        try {
          const text = await err.response.data.text();
          const parsed = JSON.parse(text);
          if (parsed.error) {
            if (typeof parsed.error === 'object') {
              errorMsg = parsed.error.message || errorMsg;
              correlationId = parsed.error.correlationId || correlationId;
            } else {
              errorMsg = parsed.error;
            }
          }
          if (parsed.correlationId) {
            correlationId = parsed.correlationId;
          }
        } catch (e) {
          // ignore parsing error, fallback to defaults
        }
      }

      if (correlationId) {
        toast.error(`${errorMsg} (ref: ${correlationId})`);
      } else {
        toast.error(errorMsg);
      }
    }
  };

  const [selectedRecord, setSelectedRecord] = useState(null);

  const openAdd = () => { setSelectedRecord(null); setModalMode('single'); setModalOpen(true); };
  const openImport = () => { setSelectedRecord(null); setModalMode('bulk'); setModalOpen(true); };
  const resetAllFilters = () => setSearchParams({ verticalId: activeVertical?._id || '' });

  const handleOpenEdit = (record) => {
    setSelectedRecord(record);
    setModalMode('edit');
    setModalOpen(true);
  };

  const handleCloseModal = () => {
    setSelectedRecord(null);
    setModalOpen(false);
    fetchRecords();
  };

  const handleSingleDelete = async (recordId) => {
    if (!window.confirm(`Are you sure you want to delete this ${title.toLowerCase()} record?`)) return;
    try {
      await axios.delete(`${config.endpoints.list}/${recordId}`);
      toast.success(`${title} record deleted successfully`);
      fetchRecords();
    } catch (err) {
      toast.error(err.response?.data?.error || `Failed to delete ${title.toLowerCase()} record`);
    }
  };

  const selectVertical = (v) => {
    setActiveVertical(v);
    setSearchInput('');
    navigate(`${location.pathname}?verticalId=${v._id}`);
  };

  const activeSubVerticalName = subVerticals.find(s => s._id === subVerticalId)?.name;

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
          <h1 className="text-2xl font-bold text-[--text-primary]">
            {activeSubVerticalName ? `${activeSubVerticalName} – ${title}` : `${activeVertical.name} – ${title}`}
          </h1>
          <p className="text-sm text-[--text-secondary] mt-1">
            {activeSubVerticalName ? `${description} (${activeSubVerticalName})` : description}
          </p>
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

      {!config.hideSubVerticals && subVerticals.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 pt-1 pb-1">
          <button
            type="button"
            onClick={() => updateQueryParam('subVerticalId', null)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all border ${
              !subVerticalId
                ? 'bg-[--accent] text-white border-[--accent] shadow-sm'
                : 'bg-white text-[--text-secondary] border-[--border] hover:bg-stone-50'
            }`}
          >
            All Sub-Verticals
          </button>
          {subVerticals.map((sv) => (
            <button
              key={sv._id}
              type="button"
              onClick={() => updateQueryParam('subVerticalId', sv._id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all border ${
                subVerticalId === sv._id
                  ? 'bg-[--accent] text-white border-[--accent] shadow-sm'
                  : 'bg-white text-[--text-secondary] border-[--border] hover:bg-stone-50'
              }`}
            >
              {sv.name}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-1.5 max-w-sm">
        <span className="text-[10px] font-black uppercase text-[--text-secondary]">Search</span>
        <input
          type="text"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search name, contact, mobile..."
          className="w-full"
        />
      </div>

      {showFilters && (
        <div className="glass-panel border border-[--border] bg-white p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 shadow-sm">
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
            <span className="text-[10px] font-black uppercase text-[--text-secondary]">Product / Service</span>
            <input type="text" value={productService} onChange={(e) => updateQueryParam('productService', e.target.value)} className="w-full" />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-black uppercase text-[--text-secondary]">City</span>
            <input type="text" value={city} onChange={(e) => updateQueryParam('city', e.target.value)} className="w-full" />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-black uppercase text-[--text-secondary]">Area</span>
            <input type="text" value={area} onChange={(e) => updateQueryParam('area', e.target.value)} className="w-full" />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-black uppercase text-[--text-secondary]">Call Status</span>
            <select value={callStatus} onChange={(e) => updateQueryParam('callStatus', e.target.value)} className="w-full">
              <option value="">All Call Statuses</option>
              <option value="Connected">Connected</option>
              <option value="Busy">Busy</option>
              <option value="Not Reachable">Not Reachable</option>
              <option value="Switched Off">Switched Off</option>
              <option value="Callback Requested">Callback Requested</option>
              <option value="Wrong Number">Wrong Number</option>
              <option value="Disconnected">Disconnected</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-black uppercase text-[--text-secondary]">Converted</span>
            <select value={converted} onChange={(e) => updateQueryParam('converted', e.target.value)} className="w-full">
              <option value="">All</option>
              <option value="Y">Y (Yes)</option>
              <option value="N">N (No)</option>
            </select>
          </div>
          <div className="lg:col-span-4 flex justify-end">
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
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {records.map((row) => {
                  const rowId = row.id || row._id;
                  const expanded = expandedRowId === rowId;
                  return (
                    <React.Fragment key={rowId}>
                      <tr className="border-b border-[--border] hover:bg-stone-50/60">
                        <td className="px-4 py-3 flex items-center gap-1.5 min-w-[70px]">
                          {detailFields.length > 0 && (
                            <button type="button" onClick={() => setExpandedRowId(expanded ? null : rowId)} className="text-[--text-muted] hover:text-[--text-primary]">
                              <ChevronRight size={14} className={`transition-transform ${expanded ? 'rotate-90' : ''}`} />
                            </button>
                          )}
                          {interactionCounts[rowId] > 0 && (
                            <span className="inline-flex items-center gap-0.5 bg-amber-100 text-amber-700 text-[9px] font-black px-1.5 py-0.5 rounded-full whitespace-nowrap" title={`${interactionCounts[rowId]} Logged Interactions`}>
                              📝 {interactionCounts[rowId]}
                            </span>
                          )}
                        </td>
                        {columns.map((col) => (
                          <td key={col.key} className="px-4 py-3 text-[--text-primary]">
                            {col.render ? col.render(row) : (row[col.key] || '-')}
                          </td>
                        ))}
                        <td className="px-4 py-3 text-right whitespace-nowrap space-x-1">
                          <button
                            type="button"
                            onClick={() => handleOpenEdit(row)}
                            className="p-1.5 border border-stone-200 rounded hover:bg-stone-50 inline-flex items-center justify-center"
                            title="Edit"
                          >
                            <Edit size={12} className="text-[--text-secondary]" />
                          </button>
                          {isAdmin && (
                            <button
                              type="button"
                              onClick={() => handleSingleDelete(rowId)}
                              className="p-1.5 border border-stone-200 rounded hover:bg-stone-50 text-red-500 inline-flex items-center justify-center"
                              title="Delete"
                            >
                              <Trash2 size={12} />
                            </button>
                          )}
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="bg-stone-50/50 border-b border-[--border]">
                          <td colSpan={columns.length + 2} className="px-8 py-5">
                            <div className="space-y-5">
                              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 text-xs">
                                {detailFields.map((f) => (
                                  <div key={f.key}>
                                    <span className="block font-black uppercase text-[9px] text-[--text-secondary]">{f.label}</span>
                                    <span className="text-[--text-primary] font-medium">{f.render ? f.render(row) : (row[f.key] || '-')}</span>
                                  </div>
                                ))}
                              </div>
                              <div className="border-t border-[--border]" />
                              <ExpandedRowInteractionHistory rowId={rowId} onMutated={refreshCounts} />
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
          onClose={handleCloseModal}
          vertical={activeVertical}
          subVerticals={subVerticals}
          defaultSubVerticalId={subVerticalId}
          agents={agents}
          initialMode={modalMode}
          onSaved={fetchRecords}
          record={selectedRecord}
        />
      )}
    </div>
  );
}

function ExpandedRowInteractionHistory({ rowId, onMutated }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  // Form State
  const [interactionDate, setInteractionDate] = useState('');
  const [interactionTime, setInteractionTime] = useState('');
  const [remarks, setRemarks] = useState('');
  const [outcome, setOutcome] = useState('');
  const [nextFollowupDate, setNextFollowupDate] = useState('');
  const [recordedByName, setRecordedByName] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchLogs = useCallback(async () => {
    try {
      const res = await axios.get(`/api/v1/interactionLogs/leads/${rowId}/interaction-logs`);
      setLogs(res.data.data || []);
    } catch (err) {
      console.error('Failed to load interaction logs:', err);
    } finally {
      setLoading(false);
    }
  }, [rowId]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!interactionDate) { toast.error('Follow-up Date is required'); return; }
    setSaving(true);
    try {
      await axios.post(`/api/v1/interactionLogs/leads/${rowId}/interaction-logs`, {
        interactionDate,
        interactionTime,
        remarks,
        outcome: outcome || null,
        nextFollowupDate: nextFollowupDate || null,
        recordedByName
      });
      toast.success('Interaction logged successfully');
      setShowForm(false);
      // Reset form
      setInteractionDate('');
      setInteractionTime('');
      setRemarks('');
      setOutcome('');
      setNextFollowupDate('');
      setRecordedByName('');
      fetchLogs();
      onMutated?.();
    } catch (err) {
      console.error('Failed to save interaction:', err);
      toast.error('Failed to log interaction');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (logId) => {
    if (!window.confirm('Are you sure you want to delete this interaction log?')) return;
    try {
      await axios.delete(`/api/v1/interactionLogs/interaction-logs/${logId}`);
      toast.success('Interaction log deleted');
      fetchLogs();
      onMutated?.();
    } catch (err) {
      console.error('Failed to delete interaction log:', err);
      toast.error('Failed to delete interaction log');
    }
  };

  const getOutcomeBadge = (ot) => {
    if (!ot) return null;
    const lower = ot.toLowerCase();
    let badgeClass = 'bg-stone-100 text-stone-700 border-stone-200';
    if (lower.includes('interested') || lower.includes('convert')) {
      badgeClass = 'bg-emerald-50 text-emerald-700 border-emerald-200';
    } else if (lower.includes('callback') || lower.includes('requested')) {
      badgeClass = 'bg-blue-50 text-blue-700 border-blue-200';
    } else if (lower.includes('reachable') || lower.includes('busy')) {
      badgeClass = 'bg-amber-50 text-amber-700 border-amber-200';
    } else if (lower.includes('not interested')) {
      badgeClass = 'bg-red-50 text-red-700 border-red-200';
    }
    return (
      <span className={`inline-block px-1.5 py-0.5 text-[9px] font-black uppercase rounded-full border ${badgeClass}`}>
        {ot}
      </span>
    );
  };

  return (
    <div className="bg-stone-50 border border-stone-200 rounded-lg p-4 space-y-4 max-w-4xl text-xs">
      <div className="flex items-center justify-between">
        <h4 className="font-bold text-[10px] uppercase text-[--text-secondary] flex items-center gap-1.5">
          <MessageSquare size={13} className="text-[--accent]" />
          <span>Interaction History Log</span>
        </h4>
        <button
          type="button"
          onClick={() => setShowForm(!showForm)}
          className="text-[10px] font-bold text-[--accent] hover:underline"
        >
          {showForm ? 'Cancel Add' : '+ Add Log'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="bg-white border border-stone-200 rounded-lg p-3 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-[9px] font-black uppercase text-stone-500">Date *</span>
              <input
                type="date"
                required
                className="p-1 border rounded text-[11px] bg-white w-full"
                value={interactionDate}
                onChange={(e) => setInteractionDate(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[9px] font-black uppercase text-stone-500">Time (Optional)</span>
              <input
                type="text"
                placeholder="e.g. 10:30 AM"
                className="p-1 border rounded text-[11px] bg-white w-full"
                value={interactionTime}
                onChange={(e) => setInteractionTime(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[9px] font-black uppercase text-stone-500">Outcome (Optional)</span>
              <select
                className="p-1 border rounded text-[11px] bg-white w-full"
                value={outcome}
                onChange={(e) => setOutcome(e.target.value)}
              >
                <option value="">-- Choose Outcome --</option>
                <option value="Interested">Interested</option>
                <option value="Not Reachable">Not Reachable</option>
                <option value="Callback Requested">Callback Requested</option>
                <option value="Not Interested">Not Interested</option>
                <option value="Converted">Converted</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[9px] font-black uppercase text-stone-500">Next Follow-up Date</span>
              <input
                type="date"
                className="p-1 border rounded text-[11px] bg-white w-full"
                value={nextFollowupDate}
                onChange={(e) => setNextFollowupDate(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[9px] font-black uppercase text-stone-500">Recorded By (Optional Name)</span>
              <input
                type="text"
                placeholder="e.g. Sneha"
                className="p-1 border rounded text-[11px] bg-white w-full"
                value={recordedByName}
                onChange={(e) => setRecordedByName(e.target.value)}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[9px] font-black uppercase text-stone-500">Remarks / Call Notes</span>
            <textarea
              rows={2}
              placeholder="Type detail notes here..."
              className="p-1 border rounded text-[11px] bg-white w-full"
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
            />
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={saving}
              className="px-3 py-1 bg-[--accent] hover:bg-[--accent-hover] text-white text-[10px] font-bold rounded"
            >
              {saving ? 'Saving...' : 'Save Log Entry'}
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="text-center py-2 text-stone-400">Loading history...</div>
      ) : logs.length === 0 ? (
        <div className="text-center py-3 text-stone-400 font-medium">No past interactions logged for this record.</div>
      ) : (
        <div className="space-y-2 max-h-[250px] overflow-y-auto pr-1">
          {logs.map((log) => (
            <div key={log.id} className="bg-white border border-stone-200 rounded-lg p-2.5 flex items-start justify-between gap-3 shadow-xs">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-bold text-stone-800 flex items-center gap-1">
                    <Calendar size={10} className="text-stone-400" />
                    {log.interaction_date ? log.interaction_date.slice(0, 10).split('-').reverse().join('-') : '-'}
                  </span>
                  {log.interaction_time && (
                    <span className="text-stone-500 font-mono flex items-center gap-0.5">
                      <Clock size={10} className="text-stone-400" />
                      {log.interaction_time}
                    </span>
                  )}
                  {getOutcomeBadge(log.outcome)}
                  {log.next_followup_date && (
                    <span className="text-[9px] bg-stone-100 text-stone-600 border border-stone-200 rounded px-1.5 py-0.5">
                      Next Fup: {log.next_followup_date.slice(0, 10).split('-').reverse().join('-')}
                    </span>
                  )}
                </div>
                {log.remarks && <p className="text-stone-700 leading-normal">{log.remarks}</p>}
                <div className="text-[9px] text-stone-400 flex items-center gap-1.5">
                  <span>Logged by: <strong className="text-stone-600">{log.recorded_by_name || log.recorded_by_raw_name || '—'}</strong></span>
                  <span>•</span>
                  <span>Source: <span className="font-mono">{log.source || '—'}</span></span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleDelete(log.id)}
                className="text-stone-400 hover:text-red-500 p-1"
                title="Delete Log"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
