/* eslint-disable i18next/no-literal-string */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
} from '@tanstack/react-table';
import {
  AlertCircle,
  ArrowUpDown,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Download,
  Edit,
  FileSpreadsheet,
  Filter,
  Plus,
  Search,
  Trash2,
  Upload,
  CheckCircle2,
  X,
  Calendar,
  Layers,
} from 'lucide-react';
import axios from '../api/axios.js';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import Loader from '../components/Loader.jsx';
import { useAuthStore } from '../store/authStore.js';
import { useUiStore } from '../store/uiStore.js';
import toast from 'react-hot-toast';
import GeotagCapture from '../components/GeotagCapture.jsx';
import VerticalSelectionBar from '../components/VerticalSelectionBar.jsx';
import SearchableOperatorSelect from '../components/SearchableOperatorSelect.jsx';
import CsvImportModal from '../components/CsvImportModal.jsx';

const BASE_DYNAMIC_FIELDS = [
  { key: 'date', label: 'Date', type: 'date', defaultValue: '' },
  { key: 'businessType', label: 'Business Type', type: 'text', defaultValue: '' },
  { key: 'area', label: 'Area', type: 'text', defaultValue: '' },
  { key: 'city', label: 'City', type: 'text', defaultValue: '' },
  { key: 'pointOfContact', label: 'Point of Contact', type: 'text', defaultValue: '' },
  { key: 'remarks', label: 'Remarks', type: 'text', defaultValue: '' },
  { key: 'recordings', label: 'Recordings', type: 'text', defaultValue: '' },
  { key: 'followUpRequired', label: 'Follow-up required', type: 'text', defaultValue: '' },
  { key: 'followUps', label: 'Follow-ups', type: 'text', defaultValue: '' },
  { key: 'followUpDates', label: 'Follow-up dates', type: 'text', defaultValue: '' },
  { key: 'followUpRemarks', label: 'Follow-up remarks', type: 'text', defaultValue: '' },
  { key: 'requirement', label: 'Requirement if any', type: 'text', defaultValue: '' },
  { key: 'notes', label: 'A notes to the cos team only', type: 'text', defaultValue: '' },
];

const BASE_DYNAMIC_FIELD_KEYS = new Set([
  ...BASE_DYNAMIC_FIELDS.map((field) => field.key),
  'point_of_contact',
  'point_of_contact_name',
  'point_of_contact_number',
  'pointofcontact',
  'pointofcontactname',
  'pointofcontactnumber',
  'products',
  'product'
]);

const getLeadData = (lead, key, fallback = '') => {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return fallback;
  if (typeof key !== 'string') return fallback;
  const data = lead?.data || {};
  if (Object.prototype.hasOwnProperty.call(data, key)) {
    const value = data[key];
    return value === undefined || value === null ? fallback : value;
  }
  return fallback;
};

const formatDate = (value) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString();
};

const formatDynamicValue = (type, value) => {
  if (value === undefined || value === null || value === '') return '-';
  if (type === 'date') return formatDate(value);
  return String(value);
};

const createBaseDynamicDefaults = () =>
  BASE_DYNAMIC_FIELDS.reduce((acc, field) => {
    if (field.key !== '__proto__' && field.key !== 'constructor' && field.key !== 'prototype' && typeof field.key === 'string') {
      Object.defineProperty(acc, field.key, {
        value: field.defaultValue,
        writable: true,
        enumerable: true,
        configurable: true
      });
    }
    return acc;
  }, {});

const TableRow = React.memo(({ row, selected }) => {
  const isOptimistic = row.original?._optimistic;
  return (
    <tr className={`border-b border-[--border] hover:bg-stone-50/50 transition-all duration-200 ${isOptimistic ? 'opacity-60 bg-blue-50/20 border-dashed border-blue-200' : ''}`} style={isOptimistic ? { outline: '1.5px dashed rgba(99,102,241,0.35)' } : {}}>
      {row.getVisibleCells().map((cell) => (
        <td key={cell.id} className="px-4 py-3 text-[--text-primary] whitespace-nowrap text-xs">
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </td>
      ))}
    </tr>
  );
}, (prevProps, nextProps) => {
  return prevProps.selected === nextProps.selected &&
         prevProps.row.original === nextProps.row.original &&
         prevProps.row.original?._optimistic === nextProps.row.original?._optimistic;
});

export const FollowUpsPositivesPage = () => {
  const { activeVertical, setActiveVertical, activeSubVertical, setActiveSubVertical, leadsRefreshTrigger } = useUiStore();
  const [verticals, setVerticals] = useState([]);
  const [showCalendar, setShowCalendar] = useState(false);
  const [todayCount, setTodayCount] = useState(0);

  // Calendar states
  const [currentDate, setCurrentDate] = useState(new Date());
  const [followUpsCalendar, setFollowUpsCalendar] = useState({});
  const [loadingCalendar, setLoadingCalendar] = useState(false);

  useEffect(() => {
    const fetchVerticals = async () => {
      try {
        const res = await axios.get('/api/v1/verticals');
        setVerticals(res.data.data || []);
      } catch (err) {
        console.error(err);
      }
    };
    fetchVerticals();
  }, []);

  const { user } = useAuthStore();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const STATUS_OPTIONS = useMemo(() => {
    return (activeVertical?.statuses && activeVertical.statuses.length > 0)
      ? activeVertical.statuses
      : [
          { value: 'new', label: 'New' },
          { value: 'contacted', label: 'Contacted' },
          { value: 'qualified', label: 'Qualified' },
          { value: 'visit_scheduled', label: 'Meeting Scheduled' },
          { value: 'visit_completed', label: 'Meeting Completed' },
          { value: 'negotiation', label: 'Negotiation' },
          { value: 'converted', label: 'Converted' },
          { value: 'lost', label: 'Lost' },
          { value: 'invalid', label: 'Invalid' },
        ];
  }, [activeVertical]);

  const page = parseInt(searchParams.get('page') || '1', 10);
  const limit = parseInt(searchParams.get('limit') || '15', 10);
  const search = searchParams.get('q') || '';
  const statusFilter = searchParams.get('status') || '';
  const subVerticalFilter = searchParams.get('subVerticalId') || '';
  const agentFilter = searchParams.get('assignedTo') || '';
  const dateFromFilter = searchParams.get('dateFrom') || '';
  const dateToFilter = searchParams.get('dateTo') || '';
  const sortBy = searchParams.get('sortBy') || 'createdAt';
  const sortDir = searchParams.get('sortDir') || 'desc';
  const csvBatchId = searchParams.get('csvBatchId') || '';
  const followUpDateFilter = searchParams.get('followUpDate') || '';

  const [leads, setLeads] = useState([]);
  const [totalLeads, setTotalLeads] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [configs, setConfigs] = useState([]);
  const [subVerticals, setSubVerticals] = useState([]);
  const [agents, setAgents] = useState([]);
  const [allAgents, setAllAgents] = useState([]);
  const [rowSelection, setRowSelection] = useState({});
  const [searchInput, setSearchInput] = useState(search);
  const [showFilters, setShowFilters] = useState(false);
  const [columnVisibility, setColumnVisibility] = useState({});

  const activeFiltersCount = useMemo(() => {
    return [
      statusFilter,
      dateFromFilter,
      dateToFilter,
      followUpDateFilter,
    ].filter(Boolean).length;
  }, [statusFilter, dateFromFilter, dateToFilter, followUpDateFilter]);

  const [bulkAssignModal, setBulkAssignModal] = useState(false);
  const [bulkStatusModal, setBulkStatusModal] = useState(false);
  const [bulkDeleteDialog, setBulkDeleteDialog] = useState(false);
  const [bulkAssignTarget, setBulkAssignTarget] = useState('');
  const [bulkStatusTarget, setBulkStatusTarget] = useState('new');

  const [leadModalOpen, setLeadModalOpen] = useState(false);
  const [selectedLead, setSelectedLead] = useState(null);
  const [leadFormName, setLeadFormName] = useState('');
  const [leadFormPhone, setLeadFormPhone] = useState('');
  const [leadFormBusiness, setLeadFormBusiness] = useState('');
  const [leadFormAssignedTo, setLeadFormAssignedTo] = useState('');
  const [leadFormDynamic, setLeadFormDynamic] = useState(createBaseDynamicDefaults());
  const [formErrors, setFormErrors] = useState([]);
  const [leadFormGeotagCoords, setLeadFormGeotagCoords] = useState(null);
  const [leadFormGeotagFile, setLeadFormGeotagFile] = useState(null);
  const [leadFormStatus, setLeadFormStatus] = useState('new');

  // CSV/Excel Import Modal (see components/CsvImportModal.jsx)
  const [csvImportModalOpen, setCsvImportModalOpen] = useState(false);
  const [leadFormSubVerticalId, setLeadFormSubVerticalId] = useState('');
  const [leadFormLeadType, setLeadFormLeadType] = useState('POSITIVE');

  const isAdmin = user?.role === 'super_admin' || user?.role === 'vertical_admin';

  const updateQueryParam = useCallback((key, value, options = { resetPage: true }) => {
    const nextParams = new URLSearchParams(searchParams);
    if (value) {
      nextParams.set(key, value);
    } else {
      nextParams.delete(key);
    }
    if (options.resetPage) nextParams.set('page', '1');
    setSearchParams(nextParams);
  }, [searchParams, setSearchParams]);

  const customConfigs = useMemo(
    () => configs.filter((config) => !BASE_DYNAMIC_FIELD_KEYS.has(config.fieldKey) && config.isActive !== false),
    [configs]
  );

  const buildInitialDynamic = useCallback((lead = null) => {
    const defaults = createBaseDynamicDefaults();
    customConfigs.forEach((config) => {
      const key = config.fieldKey;
      if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype' && typeof key === 'string') {
        Object.defineProperty(defaults, key, {
          value: config.defaultValue ?? '',
          writable: true,
          enumerable: true,
          configurable: true
        });
      }
    });
    return {
      ...defaults,
      ...(lead?.data || {}),
    };
  }, [customConfigs]);

  const fetchLeads = useCallback(async () => {
    if (!activeVertical) return;
    setLoading(true);
    try {
      const qParams = new URLSearchParams({
        verticalId: activeVertical._id,
        page: String(page),
        limit: String(limit),
        status: statusFilter,
        subVerticalId: subVerticalFilter,
        search,
        sortBy,
        sortDir,
        leadType: 'POSITIVE',
      });
      if (dateFromFilter) qParams.set('dateFrom', dateFromFilter);
      if (dateToFilter) qParams.set('dateTo', dateToFilter);
      if (csvBatchId) qParams.set('csvBatchId', csvBatchId);
      if (followUpDateFilter) qParams.set('followUpDate', followUpDateFilter);

      const response = await axios.get(`/api/v1/leads?${qParams.toString()}`);
      setLeads(response.data.data || []);
      setTotalLeads(response.data.meta?.total || 0);
      setTotalPages(response.data.meta?.totalPages || 1);
    } catch (err) {
      console.error('Error fetching leads:', err);
      toast.error(err.response?.data?.error || 'Failed to load positive leads list');
    } finally {
      setLoading(false);
    }
  }, [activeVertical, agentFilter, limit, page, search, sortBy, sortDir, statusFilter, subVerticalFilter, csvBatchId, dateFromFilter, dateToFilter, followUpDateFilter]);

  const fetchTodayCount = useCallback(async () => {
    if (!activeVertical?._id) return;
    try {
      const y = new Date().getFullYear();
      const m = String(new Date().getMonth() + 1).padStart(2, '0');
      const d = String(new Date().getDate()).padStart(2, '0');
      const todayStr = `${y}-${m}-${d}`;
      const res = await axios.get(`/api/v1/followUps/verticals/${activeVertical._id}/follow-ups/stats?date=${todayStr}`);
      setTodayCount(res.data.data?.daily?.total || 0);
    } catch (err) {
      console.error(err);
    }
  }, [activeVertical]);

  const fetchFollowUpsCalendar = useCallback(async () => {
    if (!activeVertical?._id) return;
    setLoadingCalendar(true);
    try {
      const year = currentDate.getFullYear();
      const month = currentDate.getMonth() + 1;
      
      const params = { year, month };
      if (subVerticalFilter) params.subVerticalId = subVerticalFilter;
      const res = await axios.get(
        `/api/v1/followUps/verticals/${activeVertical._id}/follow-ups/calendar`,
        { params }
      );
      setFollowUpsCalendar(res.data.data || {});
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingCalendar(false);
    }
  }, [activeVertical, currentDate, subVerticalFilter]);

  useEffect(() => {
    if (!activeVertical) return;

    const fetchMetadata = async () => {
      try {
        const [configsRes, subsRes] = await Promise.all([
          axios.get(`/api/v1/configs/verticals/${activeVertical._id}/fields`),
          axios.get(`/api/v1/verticals/${activeVertical._id}/sub-verticals`),
        ]);

        const nextConfigs = configsRes.data.data || [];
        setConfigs(nextConfigs);
        setSubVerticals((subsRes.data.data || []).filter((sub) => sub.isActive));

        const savedVisibility = localStorage.getItem(`cols_visible_positives_${activeVertical._id}`);
        if (savedVisibility) {
          setColumnVisibility(JSON.parse(savedVisibility));
        } else {
          const nextVisibility = {};
          nextConfigs.forEach((config) => {
            const key = config.fieldKey;
            if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') {
              nextVisibility[key] = config.isTableColumn;
            }
          });
          setColumnVisibility(nextVisibility);
        }
      } catch (err) {
        console.error('Error fetching layout metadata:', err);
      }
    };

    fetchMetadata();
  }, [activeVertical, isAdmin]);

  // Fetch ALL active users (always full list for operator dropdown)
  useEffect(() => {
    let cancelled = false;
    const fetchAgents = async () => {
      try {
        const res = await axios.get('/api/v1/users?active=true');
        if (!cancelled) {
          const list = (res.data.data || []).filter(u => u.is_active !== false && u.is_approved !== false);
          setAgents(list);
          setAllAgents(list);
        }
      } catch (err) {
        console.error('Error fetching agents:', err);
        if (!cancelled) setAgents([]);
      }
    };
    fetchAgents();
    return () => { cancelled = true; };
  }, [leadsRefreshTrigger]);

  useEffect(() => {
    fetchLeads();
    fetchTodayCount();
    setRowSelection({});
  }, [fetchLeads, fetchTodayCount, leadsRefreshTrigger]);

  useEffect(() => {
    if (showCalendar) {
      fetchFollowUpsCalendar();
    }
  }, [fetchFollowUpsCalendar, showCalendar, leadsRefreshTrigger]);

  useEffect(() => {
    const handler = setTimeout(() => {
      if (searchInput !== search) {
        updateQueryParam('q', searchInput);
      }
    }, 400);
    return () => clearTimeout(handler);
  }, [search, searchInput, updateQueryParam]);

  useEffect(() => {
    if (activeVertical) {
      localStorage.setItem(`cols_visible_positives_${activeVertical._id}`, JSON.stringify(columnVisibility));
    }
  }, [activeVertical, columnVisibility]);

  const handleSort = (field) => {
    const nextParams = new URLSearchParams(searchParams);
    if (sortBy === field) {
      nextParams.set('sortDir', sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      nextParams.set('sortBy', field);
      nextParams.set('sortDir', 'desc');
    }
    setSearchParams(nextParams);
  };

  const handleDynamicChange = (key, value) => {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype' || typeof key !== 'string') return;
    setLeadFormDynamic((prev) => {
      const next = { ...prev };
      Object.defineProperty(next, key, {
        value: value,
        writable: true,
        enumerable: true,
        configurable: true
      });
      return next;
    });
  };

  const handleOpenAdd = () => {
    setSelectedLead(null);
    setFormErrors([]);
    setLeadFormName('');
    setLeadFormPhone('');
    setLeadFormBusiness('');
    setLeadFormSubVerticalId('');
    setLeadFormAssignedTo('');
    setLeadFormGeotagCoords(null);
    setLeadFormGeotagFile(null);
    setLeadFormDynamic(buildInitialDynamic());
    setLeadFormStatus('new');
    setLeadFormLeadType('POSITIVE');
    setLeadModalOpen(true);
  };

  const handleOpenEdit = (lead) => {
    setSelectedLead(lead);
    setFormErrors([]);
    setLeadFormName(lead.name || '');
    setLeadFormPhone(lead.phone || '');
    setLeadFormBusiness(lead.businessName || lead.business_name || '');
    setLeadFormSubVerticalId(lead.subVerticalId?._id || lead.subVerticalId || lead.sub_vertical_id || '');
    setLeadFormAssignedTo(lead.assigned_to || lead.assignedTo || '');
    setLeadFormLeadType(lead.lead_type || lead.leadType || 'POSITIVE');
    setLeadFormGeotagCoords(
      lead.geotag_lat || lead.geotagLat
        ? {
            lat: lead.geotag_lat || lead.geotagLat,
            lng: lead.geotag_lng || lead.geotagLng,
            accuracy: lead.geotag_accuracy || lead.geotagAccuracy,
          }
        : null
    );
    setLeadFormGeotagFile(null);
    setLeadFormDynamic(buildInitialDynamic(lead));
    setLeadFormStatus(lead.status || 'new');
    setLeadModalOpen(true);
  };

  const handleLeadSubmit = async (event) => {
    event.preventDefault();
    setFormErrors([]);

    const payload = {
      name: leadFormName,
      phone: leadFormPhone,
      businessName: leadFormBusiness,
      verticalId: activeVertical._id,
      subVerticalId: leadFormSubVerticalId || subVerticalFilter || null,
      data: {
        ...leadFormDynamic,
      },
      assignedTo: leadFormAssignedTo || null,
      leadType: leadFormLeadType || 'POSITIVE',
      status: leadFormStatus,
    };

    if (leadFormGeotagCoords) {
      payload.geotagLat = leadFormGeotagCoords.lat;
      payload.geotagLng = leadFormGeotagCoords.lng;
      payload.geotagAccuracy = leadFormGeotagCoords.accuracy;
      payload.geotagCapturedAt = new Date().toISOString();
    }

    if (selectedLead) {
      payload.status = leadFormStatus;
      payload.subVerticalId = selectedLead.subVerticalId?._id || selectedLead.subVerticalId || leadFormSubVerticalId || null;
      payload.assignedTo = leadFormAssignedTo || null;
    }

    const previousLeads = [...leads];
    let tempId;

    if (selectedLead) {
      const updatedLeads = leads.map(l => l._id === selectedLead._id ? {
        ...l,
        name: payload.name,
        phone: payload.phone,
        businessName: payload.businessName,
        business_name: payload.businessName,
        status: payload.status,
        lead_type: payload.leadType,
        data: { ...l.data, ...payload.data },
        assigned_to: null,
        _optimistic: true
      } : l);
      setLeads(updatedLeads);
    } else {
      tempId = `optimistic-${Math.random().toString(36).substr(2, 9)}`;
      const optimisticLead = {
        _id: tempId,
        name: payload.name,
        phone: payload.phone,
        businessName: payload.businessName,
        business_name: payload.businessName,
        status: payload.status,
        lead_type: payload.leadType,
        data: payload.data,
        vertical_id: payload.verticalId,
        sub_vertical_id: payload.subVerticalId,
        assigned_to: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        _optimistic: true
      };
      setLeads([optimisticLead, ...leads]);
    }

    setLeadModalOpen(false);

    try {
      let savedLead;
      if (selectedLead) {
        const response = await axios.patch(`/api/v1/leads/${selectedLead._id}`, payload);
        savedLead = response.data.data;
        toast.success('Lead updated successfully.');
      } else {
        const response = await axios.post('/api/v1/leads', payload);
        savedLead = response.data.data;
        toast.success('New positive lead created.');
      }

      if (leadFormGeotagFile && savedLead && (savedLead._id || savedLead.id)) {
        const targetId = savedLead._id || savedLead.id;
        const formData = new FormData();
        formData.append('photo', leadFormGeotagFile);
        await axios.post(`/api/v1/leads/${targetId}/photo`, formData);
        toast.success('Field photo uploaded successfully.');
      }

      fetchLeads();
      fetchTodayCount();
    } catch (err) {
      setLeads(previousLeads);
      toast.error(err.response?.data?.error || 'Save failed.');
    }
  };

  const selectedRowIds = Object.keys(rowSelection)
    .map((index) => {
      const idx = parseInt(index, 10);
      if (idx >= 0 && idx < leads.length) {
        return leads[idx]?._id;
      }
      return null;
    })
    .filter(Boolean);

  const handleSingleDelete = (leadId) => {
    if (!window.confirm('Are you sure you want to delete this lead?')) return;
    const previousLeads = [...leads];
    setLeads(leads.filter(l => l._id !== leadId));
    axios.delete(`/api/v1/leads/${leadId}`)
      .then(() => {
        toast.success('Lead deleted successfully');
        fetchLeads();
        fetchTodayCount();
      })
      .catch((err) => {
        setLeads(previousLeads);
        toast.error(err.response?.data?.error || 'Failed to delete lead');
      });
  };

  const handleBulkDelete = async () => {
    const previousLeads = [...leads];
    setLeads(leads.filter(l => !selectedRowIds.includes(l._id)));
    setBulkDeleteDialog(false);
    setRowSelection({});
    try {
      await Promise.all(selectedRowIds.map((id) => axios.delete(`/api/v1/leads/${id}`)));
      toast.success(`Successfully deleted ${selectedRowIds.length} leads.`);
      fetchLeads();
      fetchTodayCount();
    } catch {
      setLeads(previousLeads);
      toast.error('Bulk deletion failed partially.');
    }
  };

  const handleBulkAssign = async () => {
    const previousLeads = [...leads];
    const targetAgent = allAgents.find(a => a.id === bulkAssignTarget) || agents.find(a => a.id === bulkAssignTarget);
    const targetName = targetAgent ? targetAgent.name : '';
    const targetEmail = targetAgent ? targetAgent.email : '';
    
    setLeads(leads.map(l => selectedRowIds.includes(l._id) ? {
      ...l,
      assigned_to: bulkAssignTarget || null,
      assignee_name: targetName,
      assignee_email: targetEmail,
      _optimistic: true
    } : l));
    setBulkAssignModal(false);
    setRowSelection({});
    
    try {
      await Promise.all(selectedRowIds.map((id) => axios.patch(`/api/v1/leads/${id}/assign`, { userId: bulkAssignTarget || null })));
      toast.success(`Successfully assigned ${selectedRowIds.length} leads.`);
      fetchLeads();
    } catch {
      setLeads(previousLeads);
      toast.error('Bulk assignment failed.');
    }
  };

  const handleBulkStatusChange = async () => {
    const previousLeads = [...leads];
    setLeads(leads.map(l => selectedRowIds.includes(l._id) ? {
      ...l,
      status: bulkStatusTarget,
      _optimistic: true
    } : l));
    setBulkStatusModal(false);
    setRowSelection({});
    
    try {
      await Promise.all(selectedRowIds.map((id) => axios.patch(`/api/v1/leads/${id}/status`, { status: bulkStatusTarget })));
      toast.success(`Successfully updated ${selectedRowIds.length} leads status.`);
      fetchLeads();
    } catch (err) {
      setLeads(previousLeads);
      toast.error(err.response?.data?.error || 'Bulk status update failed.');
    }
  };

  const handleCsvExport = async () => {
    if (!activeVertical) return;
    try {
      const qParams = new URLSearchParams({
        verticalId: activeVertical._id,
        status: statusFilter,
        subVerticalId: subVerticalFilter,
        assignedTo: agentFilter,
        search,
        leadType: 'POSITIVE',
      });
      if (dateFromFilter) qParams.set('dateFrom', dateFromFilter);
      if (dateToFilter) qParams.set('dateTo', dateToFilter);

      const response = await axios.get(`/api/v1/leads/export/csv?${qParams.toString()}`);
      const blob = new Blob([response.data], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', `positives-export-${activeVertical.slug}-${Date.now()}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch {
      toast.error('Failed to export CSV database.');
    }
  };

  const formatLocalDate = (date) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };

  const prevMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1));
  };

  const nextMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1));
  };

  const daysGrid = useMemo(() => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const firstDayIndex = new Date(year, month, 1).getDay();
    const totalDays = new Date(year, month + 1, 0).getDate();

    const grid = [];
    for (let i = 0; i < firstDayIndex; i++) {
      grid.push(null);
    }
    for (let d = 1; d <= totalDays; d++) {
      grid.push(new Date(year, month, d));
    }
    return grid;
  }, [currentDate]);

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const handleDateClick = (day) => {
    const dateKey = formatLocalDate(day);
    if (followUpDateFilter === dateKey) {
      updateQueryParam('followUpDate', '');
    } else {
      updateQueryParam('followUpDate', dateKey);
    }
  };

  const columns = useMemo(() => {
    const fixedColumns = [
      {
        id: 'select',
        header: ({ table }) => (
          <input
            type="checkbox"
            className="w-4 h-4 rounded accent-[--accent]"
            checked={table.getIsAllRowsSelected()}
            onChange={table.getToggleAllRowsSelectedHandler()}
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            className="w-4 h-4 rounded accent-[--accent]"
            checked={row.getIsSelected()}
            onChange={row.getToggleSelectedHandler()}
          />
        ),
      },
      {
        id: 'date',
        header: 'DATE',
        cell: ({ row }) => formatDynamicValue('date', getLeadData(row.original, 'date')),
      },

      {
        id: 'businessType',
        header: 'BUSINESS TYPE',
        cell: ({ row }) => formatDynamicValue('text', getLeadData(row.original, 'businessType')),
      },
      {
        accessorKey: 'name',
        header: 'BUSINESS / PERSON / SHOP / COMPANY NAME',
        cell: ({ row }) => (
          <button
            type="button"
            className="font-bold text-[--accent] hover:underline text-left text-xs bg-transparent border-0 outline-none p-0 cursor-pointer"
            onClick={() => navigate(`/leads/${row.original._id}`)}
          >
            {row.original.name || row.original.businessName || row.original.business_name}
          </button>
        ),
      },
      {
        id: 'area',
        header: 'AREA',
        cell: ({ row }) => formatDynamicValue('text', getLeadData(row.original, 'area')),
      },
      {
        id: 'city',
        header: 'CITY',
        cell: ({ row }) => formatDynamicValue('text', getLeadData(row.original, 'city')),
      },
      { accessorKey: 'phone', header: 'CONTACT' },
      {
        id: 'assigneeName',
        header: 'ASSIGNED TO',
        cell: ({ row }) => row.original.assigneeName || row.original.assignee_name || '-',
      },
      {
        id: 'deliveredLocation',
        header: 'MAP LOCATION LINK / ADDRESS',
        cell: ({ row }) => {
          const value = getLeadData(row.original, 'deliveredLocation');
          if (!value) return '-';
          if (value.startsWith('http://') || value.startsWith('https://')) {
            return (
              <a href={value} target="_blank" rel="noreferrer" className="text-[--accent] hover:underline flex items-center gap-1">
                <span>Location Link</span>
                <ExternalLink size={10} />
              </a>
            );
          }
          return formatDynamicValue('text', value);
        },
      },
      {
        id: 'requirement',
        header: 'REQUIREMENT',
        cell: ({ row }) => formatDynamicValue('text', getLeadData(row.original, 'requirement')),
      },
      {
        id: 'remarks',
        header: 'REMARKS',
        cell: ({ row }) => formatDynamicValue('text', getLeadData(row.original, 'remarks')),
      },
      {
        id: 'requireFollowUp',
        header: 'FOLLOW UP REQUIRE (YES/NO)',
        cell: ({ row }) => formatDynamicValue('text', getLeadData(row.original, 'requireFollowUp')),
      },
      {
        id: 'followUpDate',
        header: 'FOLLOW UP DATE',
        cell: ({ row }) => formatDynamicValue('date', getLeadData(row.original, 'followUpDate')),
      },
      {
        id: 'followUpRemarks',
        header: 'FOLLOW UP REMARKS',
        cell: ({ row }) => formatDynamicValue('text', getLeadData(row.original, 'followUpRemarks')),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        id: 'actions',
        header: 'Actions',
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate(`/leads/${row.original._id}#follow-ups`)}
              className="p-2 border border-stone-200 rounded-lg hover:bg-stone-50 text-[--accent]"
              title="Follow-up Leads"
            >
              <Calendar size={14} />
            </button>
            <button
              type="button"
              onClick={() => handleOpenEdit(row.original)}
              className="p-2 border border-stone-200 rounded-lg hover:bg-stone-50"
            >
              <Edit size={14} className="text-[--text-secondary]" />
            </button>
            {isAdmin && (
              <button
                type="button"
                onClick={() => handleSingleDelete(row.original._id)}
                className="p-2 border border-stone-200 rounded-lg hover:bg-stone-50 text-red-500"
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        ),
      },
    ];

    const customColumns = customConfigs
      .filter((config) => {
        const key = config.fieldKey;
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') return false;
        return columnVisibility[key] ?? config.isTableColumn;
      })
      .map((config) => ({
        id: config.fieldKey,
        header: config.label,
        cell: ({ row }) => formatDynamicValue(config.fieldType, getLeadData(row.original, config.fieldKey)),
      }));

    return [
      ...fixedColumns.slice(0, fixedColumns.length - 2),
      ...customColumns,
      ...fixedColumns.slice(fixedColumns.length - 2),
    ];
  }, [columnVisibility, customConfigs, navigate, isAdmin]);

  const table = useReactTable({
    data: leads,
    columns,
    state: {
      rowSelection,
    },
    enableRowSelection: true,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
  });

  if (!activeVertical) {
    return (
      <div className="space-y-6">
        <div className="flex justify-between items-center border-b border-[--border] pb-4">
          <div>
            <h1 className="text-2xl font-black text-[--text-primary] uppercase tracking-wider">Follow-ups & Positives</h1>
            <p className="text-xs text-[--text-secondary] mt-1">Select a vertical to view follow-up records</p>
          </div>
          <button
            type="button"
            onClick={() => navigate('/leads')}
            className="inline-flex items-center gap-2 px-4 py-2 border border-stone-300 hover:border-stone-500 text-[--text-secondary] bg-white rounded-lg font-bold text-sm hover:bg-stone-50 shadow-sm transition-all"
          >
            <span>← COS</span>
          </button>
        </div>

        <VerticalSelectionBar
          verticals={verticals}
          activeVerticalId={null}
          onSelect={(v) => {
            setActiveVertical(v);
            setActiveSubVertical(null);
            navigate(`/follow-ups-positives?verticalId=${v._id}`);
          }}
        />

        <div className="glass-panel border border-[--border] bg-white p-12 text-center text-xs text-[--text-secondary] flex items-center justify-center flex-col gap-2 shadow-sm min-h-[300px]">
          <Layers size={44} className="text-[--text-muted]/30 animate-pulse" />
          <h3 className="font-bold text-sm text-[--text-primary] mt-2">No Active Business Vertical</h3>
          <p className="max-w-xs leading-relaxed">
            Please select a business vertical from the selector above to view follow-up and positive lead records.
          </p>
        </div>
      </div>
    );
  }

  const activeSubVerticalName = activeSubVertical?.name || subVerticals.find(s => s._id === subVerticalFilter)?.name;

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      
      {/* Workspace Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[--border] pb-6">
        <div>
          <h2 className="text-2xl font-black text-[--text-primary] uppercase tracking-wider flex items-center gap-2">
            <Calendar className="text-[--accent]" size={26} />
            <span>Positives & Follow-up Leads</span>
          </h2>
          <p className="text-xs text-[--text-secondary] mt-1.5 font-medium">
            Workspace: <strong className="text-[--accent]">{activeVertical?.name || 'No workspace active'}</strong> | Filter, search, and manage positive leads database
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowCalendar(!showCalendar)}
            className={`flex items-center gap-2 px-4 py-2 border rounded-lg text-xs font-bold transition-all shadow-sm ${
              showCalendar
                ? 'border-[--accent] text-[--accent] bg-[--accent-light]'
                : 'border-[--border-strong] text-[--text-secondary] bg-white hover:bg-stone-50'
            }`}
          >
            <Calendar size={14} />
            <span>Calendar Grid ({todayCount})</span>
          </button>

          <button 
            type="button"
            onClick={() => navigate('/leads')}
            className="flex items-center gap-2 px-4 py-2 border border-[--border-strong] rounded-lg text-xs font-bold text-[--text-secondary] bg-white hover:bg-stone-50 shadow-sm transition-all"
          >
            <span>← COS</span>
          </button>
        </div>
      </div>

      <VerticalSelectionBar
        verticals={verticals}
        activeVerticalId={activeVertical?._id}
        onSelect={(v) => {
          setActiveVertical(v);
          setActiveSubVertical(null);
          setRowSelection({});
          setSearchParams({ verticalId: v._id });
        }}
      />

      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        {/* Search */}
        <div className="relative flex-1 max-w-md">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
          <input
            type="text"
            placeholder="Search positive leads by name, phone, business..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="w-full bg-[--bg-input] border border-[--border-strong] rounded-lg pl-9 pr-4 py-2 text-xs font-semibold focus:outline-none focus:border-[--accent]"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => { setSearchInput(''); updateQueryParam('q', ''); }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-[--text-primary] text-xs font-bold bg-transparent border-0 outline-none"
            >
              âœ•
            </button>
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2">
          {selectedRowIds.length > 0 && (
            <div className="flex items-center gap-2 bg-stone-50 border border-[--border] p-1.5 rounded-lg animate-in slide-in-from-right duration-250">
              <span className="text-[10px] font-black uppercase text-[--text-secondary] px-2">
                {selectedRowIds.length} selected
              </span>

              <button
                type="button"
                onClick={() => setBulkStatusModal(true)}
                className="px-3 py-1.5 border border-[--border-strong] rounded-md text-xs font-bold hover:bg-stone-100 bg-white"
              >
                Status
              </button>
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => setBulkDeleteDialog(true)}
                  className="px-3 py-1.5 border border-red-200 text-red-500 rounded-md text-xs font-bold hover:bg-red-50 bg-white"
                >
                  Delete
                </button>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={() => setShowFilters(!showFilters)}
            className={`flex items-center gap-1.5 px-4 py-2 border rounded-lg text-xs font-bold transition-all shadow-sm ${
              showFilters || activeFiltersCount > 0
                ? 'border-[--accent] text-[--accent] bg-[--accent-light]'
                : 'border-[--border-strong] text-[--text-secondary] bg-white hover:bg-stone-50'
            }`}
          >
            <Filter size={14} />
            <span>Filters</span>
            {activeFiltersCount > 0 && (
              <span className="w-5 h-5 rounded-full bg-[--accent] text-white flex items-center justify-center text-[9px] font-black">
                {activeFiltersCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={handleCsvExport}
            className="flex items-center gap-1.5 px-4 py-2 border border-[--border-strong] rounded-lg text-xs font-bold text-[--text-secondary] hover:bg-stone-50 shadow-sm bg-white"
          >
            <Download size={14} />
            <span>Export CSV</span>
          </button>

          <button
            type="button"
            onClick={() => setCsvImportModalOpen(true)}
            className="flex items-center gap-1.5 px-4 py-2 border border-[--border-strong] rounded-lg text-xs font-bold text-[--text-secondary] hover:bg-stone-50 shadow-sm bg-white"
          >
            <Upload size={14} />
            <span>Import CSV</span>
          </button>

          <button
            type="button"
            onClick={handleOpenAdd}
            className="flex items-center gap-1.5 px-4 py-2 bg-[--accent] hover:bg-[--accent-hover] text-white rounded-lg text-xs font-black uppercase tracking-wider transition-all shadow-sm"
          >
            <Plus size={14} />
            <span>Add Lead</span>
          </button>
        </div>
      </div>

      {/* Filter Options Panel */}
      {(showFilters || activeFiltersCount > 0) && (
        <div className="glass-panel border border-[--border] bg-white p-5 rounded-xl grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4 animate-in slide-in-from-top-3 duration-250">
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-black text-[--text-secondary] uppercase tracking-wider">Sub-Vertical</span>
            <select
              value={subVerticalFilter}
              onChange={(e) => updateQueryParam('subVerticalId', e.target.value)}
              className="bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-[--accent] font-semibold"
            >
              <option value="">All sub-verticals</option>
              {subVerticals.map(sub => (
                <option key={sub._id} value={sub._id}>{sub.name}</option>
              ))}
            </select>
          </div>


          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-black text-[--text-secondary] uppercase tracking-wider">Lead Status</span>
            <select
              value={statusFilter}
              onChange={(e) => updateQueryParam('status', e.target.value)}
              className="bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-[--accent] font-semibold"
            >
              <option value="">All statuses</option>
              {STATUS_OPTIONS.map(st => (
                <option key={st.value || st} value={st.value || st}>{st.label || st}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-black text-[--text-secondary] uppercase tracking-wider">Date Created</span>
            <div className="flex items-center gap-1">
              <input
                type="date"
                value={dateFromFilter}
                onChange={(e) => updateQueryParam('dateFrom', e.target.value)}
                className="bg-[--bg-input] border border-[--border-strong] rounded-lg px-2 py-1.5 text-[11px] focus:outline-none focus:border-[--accent] font-semibold flex-1 min-w-0"
              />
              <span className="text-stone-400 text-xs">-</span>
              <input
                type="date"
                value={dateToFilter}
                onChange={(e) => updateQueryParam('dateTo', e.target.value)}
                className="bg-[--bg-input] border border-[--border-strong] rounded-lg px-2 py-1.5 text-[11px] focus:outline-none focus:border-[--accent] font-semibold flex-1 min-w-0"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5 justify-end">
            <button
              type="button"
              onClick={() => {
                setSearchParams({ verticalId: activeVertical._id });
                setSearchInput('');
              }}
              className="w-full py-2 bg-stone-100 hover:bg-stone-200 text-stone-700 font-bold text-xs rounded-lg transition-all border border-stone-200"
            >
              Reset All Filters
            </button>
          </div>
        </div>
      )}

      {/* Date Filter Badge */}
      {followUpDateFilter && (
        <div className="flex items-center gap-2 bg-[--accent-light] text-[--accent] px-3 py-1.5 rounded-lg text-xs font-bold border border-[--accent-border] max-w-max animate-in fade-in duration-200">
          <span>Follow-up Date: {followUpDateFilter}</span>
          <button
            type="button"
            onClick={() => updateQueryParam('followUpDate', '')}
            className="hover:text-red-500 font-bold ml-1.5 bg-transparent border-0 outline-none p-0 cursor-pointer"
          >
            âœ•
          </button>
        </div>
      )}

      {/* Main Grid Layout: Table Left, Calendar Right */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        
        {/* Leads Table */}
        <div className={`${showCalendar ? 'lg:col-span-2' : 'lg:col-span-3'} space-y-4`}>
          {loading ? (
            <div className="glass-panel border border-[--border] bg-white py-24 flex items-center justify-center flex-col gap-3 shadow-sm min-h-[350px]">
              <Loader />
            </div>
          ) : leads.length === 0 ? (
            <div className="glass-panel border border-[--border] bg-white p-12 text-center text-xs text-[--text-secondary] flex items-center justify-center flex-col gap-2 shadow-sm min-h-[350px]">
              <FileSpreadsheet size={44} className="text-[--text-muted]/30" />
              <h3 className="font-bold text-sm text-[--text-primary] mt-2">No Positive Leads Found</h3>
              <p className="max-w-xs leading-relaxed">
                {activeSubVerticalName
                  ? `No positive records found in sub-category "${activeSubVerticalName}" matching current filters.`
                  : 'No positive records found matching current query filters.'
                }
              </p>
            </div>
          ) : (
            <div className="glass-panel border border-[--border] bg-white rounded-xl shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="bg-stone-50 border-b border-[--border] text-left">
                      {table.getHeaderGroups().map((hg) =>
                        hg.headers.map((header) => {
                          const isSortable = ['name', 'phone', 'businessName', 'status'].includes(header.id);
                          return (
                            <th
                              key={header.id}
                              className={`px-4 py-3 text-[10px] font-black uppercase tracking-wider text-[--text-secondary] select-none ${isSortable ? 'cursor-pointer hover:bg-stone-100 transition-colors' : ''}`}
                              onClick={() => isSortable && handleSort(header.id)}
                            >
                              <div className="flex items-center gap-1">
                                {flexRender(header.column.columnDef.header, header.getContext())}
                                {isSortable && <ArrowUpDown size={10} className="text-stone-400 shrink-0" />}
                              </div>
                            </th>
                          );
                        })
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {table.getRowModel().rows.map((row) => (
                      <TableRow key={row.id} row={row} selected={rowSelection[row.id]} />
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Table Pagination */}
              <div className="flex justify-between items-center px-4 py-3 border-t border-[--border] bg-stone-50/50">
                <div className="text-xs text-[--text-secondary] font-semibold">
                  Showing <strong className="text-[--text-primary]">{leads.length}</strong> of{' '}
                  <strong className="text-[--text-primary]">{totalLeads}</strong> leads
                </div>

                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-1.5 text-xs text-[--text-secondary] font-bold">
                    <span>Rows per page:</span>
                    <select
                      value={limit}
                      onChange={(e) => updateQueryParam('limit', e.target.value)}
                      className="bg-white border border-[--border-strong] rounded px-1.5 py-0.5 text-xs focus:outline-none"
                    >
                      <option value="15">15</option>
                      <option value="25">25</option>
                      <option value="50">50</option>
                    </select>
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={page <= 1}
                      onClick={() => updateQueryParam('page', String(page - 1), { resetPage: false })}
                      className="p-1 border border-[--border-strong] rounded hover:bg-white text-[--text-secondary] disabled:opacity-40 disabled:hover:bg-transparent bg-transparent cursor-pointer"
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <span className="text-xs text-[--text-secondary] font-bold select-none px-1">
                      Page {page} of {totalPages}
                    </span>
                    <button
                      type="button"
                      disabled={page >= totalPages}
                      onClick={() => updateQueryParam('page', String(page + 1), { resetPage: false })}
                      className="p-1 border border-[--border-strong] rounded hover:bg-white text-[--text-secondary] disabled:opacity-40 disabled:hover:bg-transparent bg-transparent cursor-pointer"
                    >
                      <ChevronRight size={16} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Side Calendar Grid */}
        {showCalendar && (
          <div className="lg:col-span-1 space-y-4">
            <div className="glass-panel border border-[--border] bg-white p-5 shadow-sm rounded-xl">
              
              {/* Calendar Controls */}
              <div className="flex justify-between items-center mb-6">
                <div>
                  <h3 className="text-sm font-black text-[--text-primary] uppercase tracking-wide">
                    {currentDate.toLocaleString('default', { month: 'long', year: 'numeric' })}
                  </h3>
                  <span className="text-[9px] uppercase font-bold text-[--text-muted] tracking-wider block mt-0.5">
                    Follow-ups Calendar Grid
                  </span>
                </div>
                
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={prevMonth}
                    className="p-1.5 border border-[--border-strong] rounded hover:bg-stone-50 text-[--text-secondary] transition-all bg-white cursor-pointer"
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => { setCurrentDate(new Date()); updateQueryParam('followUpDate', formatLocalDate(new Date())); }}
                    className="px-2 py-1 border border-[--border-strong] rounded hover:bg-stone-50 text-[--text-secondary] text-[10px] font-semibold uppercase bg-white cursor-pointer"
                  >
                    Today
                  </button>
                  <button
                    type="button"
                    onClick={nextMonth}
                    className="p-1.5 border border-[--border-strong] rounded hover:bg-stone-50 text-[--text-secondary] transition-all bg-white cursor-pointer"
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
              </div>

              {/* Calendar Grid Header */}
              <div className="grid grid-cols-7 gap-1">
                {dayNames.map(day => (
                  <div key={day} className="text-center font-bold text-[10px] text-[--text-secondary] py-1 uppercase tracking-wider select-none">
                    {day}
                  </div>
                ))}

                {/* Calendar Grid Cells */}
                {daysGrid.map((day, idx) => {
                  if (!day) {
                    return <div key={`empty-${idx}`} className="aspect-square bg-stone-50/40 border border-stone-100 rounded-lg" />;
                  }

                  const dateKey = formatLocalDate(day);
                  const isSelected = followUpDateFilter === dateKey;
                  const isToday = formatLocalDate(new Date()) === dateKey;
                  const fStats = followUpsCalendar[dateKey];
                  const hasFollowUps = fStats && fStats.total > 0;

                  return (
                    <div
                      key={dateKey}
                      onClick={() => handleDateClick(day)}
                      className={`aspect-square p-1 border rounded-lg cursor-pointer transition-all flex flex-col justify-between relative select-none ${
                        isSelected 
                          ? 'border-[--accent] bg-[--accent-light] shadow-sm scale-[1.02]' 
                          : 'border-[--border] hover:border-[--accent-border] hover:bg-stone-50/50 bg-white'
                      }`}
                    >
                      <div className="flex justify-between items-center w-full">
                        <span className={`text-[10px] font-bold ${
                          isToday 
                            ? 'bg-[--accent] text-white w-4.5 h-4.5 rounded-full flex items-center justify-center' 
                            : isSelected ? 'text-[--accent]' : 'text-[--text-primary]'
                        }`}>
                          {day.getDate()}
                        </span>

                        {hasFollowUps && (
                          <span className="text-[8px] font-black bg-stone-100 text-[--text-primary] px-1 rounded-full border border-stone-200 scale-90">
                            {fStats.total}
                          </span>
                        )}
                      </div>

                      {/* Indicator Dots */}
                      <div className="w-full mt-auto">
                        {hasFollowUps && (
                          <div className="flex flex-wrap gap-0.5 justify-center mt-0.5">
                            {fStats.items.slice(0, 3).map(item => (
                              <span 
                                key={item.id} 
                                className={`w-1 h-1 rounded-full ${
                                  item.status === 'COMPLETED' ? 'bg-emerald-500' :
                                  item.status === 'PENDING' ? 'bg-amber-500' :
                                  'bg-rose-500'
                                }`}
                              />
                            ))}
                            {fStats.total > 3 && <span className="text-[6px] text-[--text-muted] font-bold leading-none">+</span>}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Add/Edit Modal */}
      {leadModalOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000] p-4">
          <div className="bg-white rounded-xl max-w-xl w-full p-6 shadow-xl flex flex-col max-h-[90vh]">
            <div className="flex justify-between items-center border-b border-stone-200 pb-3 flex-shrink-0">
              <h3 className="text-base font-black uppercase text-[--text-primary]">
                {selectedLead ? 'Edit Positive Lead' : 'Add Positive Lead'}
              </h3>
              <button
                type="button"
                onClick={() => setLeadModalOpen(false)}
                className="text-stone-400 hover:text-stone-600 bg-transparent border-0 outline-none cursor-pointer"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleLeadSubmit} className="flex flex-col flex-1 overflow-hidden min-h-0">
              <div className="flex-1 overflow-y-auto pr-3 space-y-4 py-1">
                {/* Row 1: Date only */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] font-black uppercase text-[--text-secondary]">Date</span>
                    <input
                      type="date"
                      value={getLeadData({ data: leadFormDynamic }, 'date')}
                      onChange={(e) => handleDynamicChange('date', e.target.value)}
                      className="w-full bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-[--accent]"
                    />
                  </div>
                </div>

                {/* Row 2: Business Type + Business/Person/Shop/Company Name */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] font-black uppercase text-[--text-secondary]">Business Type</span>
                    <input
                      type="text"
                      value={getLeadData({ data: leadFormDynamic }, 'businessType')}
                      onChange={(e) => handleDynamicChange('businessType', e.target.value)}
                      className="w-full bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-[--accent]"
                      placeholder="e.g. Retail, Wholesale"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] font-black uppercase text-[--text-secondary]">BUSINESS / PERSON / SHOP / COMPANY NAME *</span>
                    <input
                      type="text"
                      required
                      value={leadFormName}
                      onChange={(e) => {
                        setLeadFormName(e.target.value);
                        setLeadFormBusiness(e.target.value);
                      }}
                      className="w-full bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-[--accent]"
                      placeholder="Enter name/business"
                    />
                  </div>
                </div>

                {/* Row 3: Area + City */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] font-black uppercase text-[--text-secondary]">Area</span>
                    <input
                      type="text"
                      value={getLeadData({ data: leadFormDynamic }, 'area')}
                      onChange={(e) => handleDynamicChange('area', e.target.value)}
                      className="w-full bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-[--accent]"
                      placeholder="Area / Locality"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] font-black uppercase text-[--text-secondary]">City</span>
                    <input
                      type="text"
                      value={getLeadData({ data: leadFormDynamic }, 'city')}
                      onChange={(e) => handleDynamicChange('city', e.target.value)}
                      className="w-full bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-[--accent]"
                      placeholder="City"
                    />
                  </div>
                </div>

                {/* Row 4: Contact Number */}
                <div className="grid grid-cols-1">
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] font-black uppercase text-[--text-secondary]">Contact Number *</span>
                    <input
                      type="text"
                      required
                      value={leadFormPhone}
                      onChange={(e) => setLeadFormPhone(e.target.value)}
                      className="w-full bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-[--accent]"
                      placeholder="Enter contact number"
                    />
                  </div>
                </div>

                {/* Row 5: Point of Contact Name + Point of Contact Number */}
                {/* Row 5: Point of Contact */}
                <div className="grid grid-cols-1">
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] font-black uppercase text-[--text-secondary]">Point of Contact</span>
                    <input
                      type="text"
                      value={getLeadData({ data: leadFormDynamic }, 'pointOfContact')}
                      onChange={(e) => handleDynamicChange('pointOfContact', e.target.value)}
                      className="w-full bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-[--accent]"
                      placeholder="Enter point of contact"
                    />
                  </div>
                </div>

                {/* Row 6: Remarks + Recordings */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] font-black uppercase text-[--text-secondary]">Remarks</span>
                    <input
                      type="text"
                      value={getLeadData({ data: leadFormDynamic }, 'remarks')}
                      onChange={(e) => handleDynamicChange('remarks', e.target.value)}
                      className="w-full bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-[--accent]"
                      placeholder="General remarks"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] font-black uppercase text-[--text-secondary]">Recordings</span>
                    <input
                      type="text"
                      value={getLeadData({ data: leadFormDynamic }, 'recordings')}
                      onChange={(e) => handleDynamicChange('recordings', e.target.value)}
                      className="w-full bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-[--accent]"
                      placeholder="Recordings link if any"
                    />
                  </div>
                </div>

                {/* Row 7: Follow-up required + Follow-ups */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] font-black uppercase text-[--text-secondary]">Follow-up required</span>
                    <input
                      type="text"
                      value={getLeadData({ data: leadFormDynamic }, 'followUpRequired')}
                      onChange={(e) => handleDynamicChange('followUpRequired', e.target.value)}
                      className="w-full bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-[--accent]"
                      placeholder="e.g. Yes/No"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] font-black uppercase text-[--text-secondary]">Follow-ups</span>
                    <input
                      type="text"
                      value={getLeadData({ data: leadFormDynamic }, 'followUps')}
                      onChange={(e) => handleDynamicChange('followUps', e.target.value)}
                      className="w-full bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-[--accent]"
                      placeholder="Follow-ups notes"
                    />
                  </div>
                </div>

                {/* Row 8: Follow-up dates + Follow-up remarks */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] font-black uppercase text-[--text-secondary]">Follow-up dates</span>
                    <input
                      type="text"
                      value={getLeadData({ data: leadFormDynamic }, 'followUpDates')}
                      onChange={(e) => handleDynamicChange('followUpDates', e.target.value)}
                      className="w-full bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-[--accent]"
                      placeholder="Target follow-up dates"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] font-black uppercase text-[--text-secondary]">Follow-up remarks</span>
                    <input
                      type="text"
                      value={getLeadData({ data: leadFormDynamic }, 'followUpRemarks')}
                      onChange={(e) => handleDynamicChange('followUpRemarks', e.target.value)}
                      className="w-full bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-[--accent]"
                      placeholder="Follow-up remarks"
                    />
                  </div>
                </div>

                {/* Row 9: Requirement if any + A notes to the cos team only */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] font-black uppercase text-[--text-secondary]">Requirement if any</span>
                    <input
                      type="text"
                      value={getLeadData({ data: leadFormDynamic }, 'requirement')}
                      onChange={(e) => handleDynamicChange('requirement', e.target.value)}
                      className="w-full bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-[--accent]"
                      placeholder="Requirement details"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] font-black uppercase text-[--text-secondary]">A notes to the cos team only</span>
                    <input
                      type="text"
                      value={getLeadData({ data: leadFormDynamic }, 'notes')}
                      onChange={(e) => handleDynamicChange('notes', e.target.value)}
                      className="w-full bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-[--accent]"
                      placeholder="Notes to the cos team"
                    />
                  </div>
                </div>

                {/* Assigning Section */}
                <div className="border-t border-stone-200 pt-4">
                  <span className="block text-[10px] font-black uppercase text-[--text-secondary] tracking-wider mb-2">
                    Assigning
                  </span>
                  <div className="grid grid-cols-2 gap-4">
                    {!subVerticalFilter && (
                      <div className="flex flex-col gap-1">
                        <span className="text-[10px] font-black uppercase text-stone-500">Sub-Vertical *</span>
                        <select
                          required
                          value={leadFormSubVerticalId}
                          onChange={(e) => setLeadFormSubVerticalId(e.target.value)}
                          className="w-full bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-[--accent] font-semibold"
                        >
                          <option value="">-- Choose Sub-vertical --</option>
                          {subVerticals.map(sub => (
                            <option key={sub._id} value={sub._id}>{sub.name}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    <div className="flex flex-col gap-1">
                      <span className="text-[10px] font-black uppercase text-stone-500">Assign Operator</span>
                      <SearchableOperatorSelect
                        agents={agents}
                        value={leadFormAssignedTo}
                        onChange={setLeadFormAssignedTo}
                        placeholder="-- Unassigned --"
                      />
                    </div>
                  </div>
                </div>

                {/* Dynamic configs (vertical-specific extra fields) */}
                {customConfigs.length > 0 && (
                  <div className="border-t border-stone-200 pt-4 space-y-4">
                    <span className="block text-[10px] font-black uppercase text-[--text-secondary] tracking-wider">
                      Custom Fields
                    </span>
                    <div className="grid grid-cols-2 gap-4">
                      {customConfigs.map(config => (
                        <div key={config.fieldKey} className="flex flex-col gap-1">
                          <span className="text-[10px] font-black uppercase text-stone-500">
                            {config.label} {config.isRequired && '*'}
                          </span>
                          <input
                            type={config.fieldType === 'number' ? 'number' : config.fieldType === 'date' ? 'date' : 'text'}
                            required={config.isRequired}
                            value={getLeadData({ data: leadFormDynamic }, config.fieldKey)}
                            onChange={(e) => handleDynamicChange(config.fieldKey, e.target.value)}
                            className="w-full bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-[--accent]"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Geotag section */}
                <div className="border-t border-stone-200 pt-4">
                  <span className="block text-[10px] font-black uppercase text-[--text-secondary] tracking-wider mb-2">
                    Check-in / Geotagging location
                  </span>
                  <GeotagCapture
                    onCapture={setLeadFormGeotagCoords}
                    onPhotoSelect={setLeadFormGeotagFile}
                    existingCoords={leadFormGeotagCoords}
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 border-t border-stone-200 pt-4 flex-shrink-0 mt-4">
                <button
                  type="button"
                  onClick={() => setLeadModalOpen(false)}
                  className="px-4 py-2 border border-stone-300 text-xs font-semibold rounded-lg hover:bg-stone-50 bg-white cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 bg-[--accent] hover:bg-[--accent-hover] text-white font-bold text-xs rounded-lg transition-all uppercase tracking-wide cursor-pointer"
                >
                  Save Lead
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CSV/Excel Import Modal — shared component, see components/CsvImportModal.jsx */}
      <CsvImportModal
        open={csvImportModalOpen}
        onClose={() => setCsvImportModalOpen(false)}
        vertical={activeVertical}
        subVerticals={subVerticals}
        defaultSubVerticalId={leadFormSubVerticalId || subVerticalFilter || ''}
        agents={agents}
        leadType="POSITIVE"
        filenamePrefix="positives"
        title="Import Positive Leads"
        onImportComplete={() => {
          fetchLeads();
          fetchTodayCount();
        }}
      />

      {/* Bulk Delete Confirm Dialog */}
      <ConfirmDialog
        isOpen={bulkDeleteDialog}
        onCancel={() => setBulkDeleteDialog(false)}
        onConfirm={handleBulkDelete}
        title="Confirm Bulk Deletion"
        description={`Are you absolutely sure you want to delete the ${selectedRowIds.length} selected positive leads? This action is permanent and cannot be undone.`}
        confirmLabel="Bulk Delete"
        danger
      />



      {/* Bulk Status Dialog */}
      {bulkStatusModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000] p-4">
          <div className="bg-white rounded-xl max-w-sm w-full p-5 space-y-4 shadow-xl">
            <div className="border-b border-stone-200 pb-2.5">
              <h4 className="text-sm font-black uppercase text-[--text-primary]">Bulk Update Status</h4>
            </div>
            <div className="space-y-3">
              <span className="text-[10px] font-black uppercase text-stone-500">Select Status</span>
              <select
                value={bulkStatusTarget}
                onChange={(e) => setBulkStatusTarget(e.target.value)}
                className="w-full bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-[--accent] font-semibold"
              >
                {STATUS_OPTIONS.map(st => (
                  <option key={st.value || st} value={st.value || st}>{st.label || st}</option>
                ))}
              </select>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-stone-100">
              <button
                type="button"
                onClick={() => setBulkStatusModal(false)}
                className="px-3.5 py-1.5 border border-stone-300 text-xs font-bold rounded-lg hover:bg-stone-50 bg-white cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleBulkStatusChange}
                className="px-4 py-1.5 bg-[--accent] hover:bg-[--accent-hover] text-white font-black text-xs rounded-lg uppercase tracking-wider cursor-pointer"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};

export default FollowUpsPositivesPage;
