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
  X,
  Calendar,
  ExternalLink,
} from 'lucide-react';
import axios from '../api/axios.js';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import InteractiveStatusSelect from '../components/InteractiveStatusSelect.jsx';
import Loader from '../components/Loader.jsx';
import { useAuthStore } from '../store/authStore.js';
import { useUiStore } from '../store/uiStore.js';
import toast from 'react-hot-toast';
import GeotagCapture from '../components/GeotagCapture.jsx';
import VerticalSelectionBar from '../components/VerticalSelectionBar.jsx';
import SearchableOperatorSelect from '../components/SearchableOperatorSelect.jsx';
import CsvImportModal from '../components/CsvImportModal.jsx';
import { extractErrorMessage } from '../utils/errorMessage.js';

const BASE_DYNAMIC_FIELDS = [
  { key: 'date', label: 'Date', type: 'date', defaultValue: '' },
  { key: 'businessType', label: 'Business Type', type: 'text', defaultValue: '' },
  { key: 'area', label: 'Area', type: 'text', defaultValue: '' },
  { key: 'city', label: 'City', type: 'text', defaultValue: '' },
  { key: 'pointOfContactName', label: 'Point of Contact Name', type: 'text', defaultValue: '' },
  { key: 'pointOfContactNumber', label: 'Point of Contact Number', type: 'text', defaultValue: '' },
  { key: 'deliveredLocation', label: 'Link Address', type: 'text', defaultValue: '' },
  { key: 'remarks', label: 'Remarks', type: 'text', defaultValue: '' },
  { key: 'recordings', label: 'Recordings', type: 'text', defaultValue: '' },
  { key: 'appointmentType', label: 'Appointment type (yes or no)', type: 'select', defaultValue: '' },
  { key: 'appointmentDate', label: 'Appointment date', type: 'date', defaultValue: '' },
  { key: 'appointmentTime', label: 'Appointment time', type: 'text', defaultValue: '' },
  { key: 'requirement', label: 'Requirement order if any', type: 'text', defaultValue: '' },
  { key: 'notes', label: 'Notes to the cos if any', type: 'text', defaultValue: '' },
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

const getDynamicValue = (obj, key, fallback = '') => {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return fallback;
  if (typeof key !== 'string') return fallback;
  const target = obj || {};
  if (Object.prototype.hasOwnProperty.call(target, key)) {
    const value = target[key];
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

export const LeadsPage = () => {
  const { activeVertical, setActiveVertical, activeSubVertical, setActiveSubVertical, leadsRefreshTrigger } = useUiStore();
  const [verticals, setVerticals] = useState([]);

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
  const leadTypeFilter = searchParams.get('leadType') || '';
  const dateFromFilter = searchParams.get('dateFrom') || '';
  const dateToFilter = searchParams.get('dateTo') || '';
  const sortBy = searchParams.get('sortBy') || 'createdAt';
  const sortDir = searchParams.get('sortDir') || 'desc';
  const csvBatchId = searchParams.get('csvBatchId') || '';

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
      leadTypeFilter,
      dateFromFilter,
      dateToFilter,
    ].filter(Boolean).length;
  }, [statusFilter, leadTypeFilter, dateFromFilter, dateToFilter]);

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
  const [leadFormDynamic, setLeadFormDynamic] = useState(createBaseDynamicDefaults());
  const [formErrors, setFormErrors] = useState([]);
  const [leadFormLeadType, setLeadFormLeadType] = useState('CALL');
  const [leadFormGeotagCoords, setLeadFormGeotagCoords] = useState(null);
  const [leadFormGeotagFile, setLeadFormGeotagFile] = useState(null);
  const [leadFormStatus, setLeadFormStatus] = useState('new');
  const [leadFormAssignedTo, setLeadFormAssignedTo] = useState('');

  // CSV/Excel Import Modal (see components/CsvImportModal.jsx)
  const [csvImportModalOpen, setCsvImportModalOpen] = useState(false);
  const [leadFormSubVerticalId, setLeadFormSubVerticalId] = useState('');

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
        assignedTo: agentFilter,
        search,
        sortBy,
        sortDir,
      });
      if (leadTypeFilter) qParams.set('leadType', leadTypeFilter);
      if (dateFromFilter) qParams.set('dateFrom', dateFromFilter);
      if (dateToFilter) qParams.set('dateTo', dateToFilter);
      if (csvBatchId) {
        qParams.set('csvBatchId', csvBatchId);
      }

      const response = await axios.get(`/api/v1/leads?${qParams.toString()}`);
      setLeads(response.data.data || []);
      setTotalLeads(response.data.meta?.total || 0);
      setTotalPages(response.data.meta?.totalPages || 1);
    } catch (err) {
      console.error('Error fetching leads:', err);
      toast.error(err.response?.data?.error || 'Failed to load leads list');
    } finally {
      setLoading(false);
    }
  }, [activeVertical, agentFilter, limit, page, search, sortBy, sortDir, statusFilter, subVerticalFilter, csvBatchId, leadTypeFilter, dateFromFilter, dateToFilter]);

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

        const savedVisibility = localStorage.getItem(`cols_visible_${activeVertical._id}`);
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

        // Removed fallback user fetch from here to avoid redundancy
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
    setRowSelection({});
  }, [fetchLeads, leadsRefreshTrigger]);

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
      localStorage.setItem(`cols_visible_${activeVertical._id}`, JSON.stringify(columnVisibility));
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
    setLeadFormLeadType('CALL');
    setLeadFormGeotagCoords(null);
    setLeadFormGeotagFile(null);
    setLeadFormDynamic(buildInitialDynamic());
    setLeadFormStatus('new');
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
    setLeadFormLeadType(lead.lead_type || lead.leadType || 'CALL');
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
      leadType: leadFormLeadType,
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
      payload.leadType = leadFormLeadType;
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
        toast.success('New lead created.');
      }

      if (leadFormGeotagFile && savedLead && (savedLead._id || savedLead.id)) {
        const targetId = savedLead._id || savedLead.id;
        const formData = new FormData();
        formData.append('photo', leadFormGeotagFile);
        await axios.post(`/api/v1/leads/${targetId}/photo`, formData);
        toast.success('Field photo uploaded successfully.');
      }

      fetchLeads();
    } catch (err) {
      setLeads(previousLeads);
      toast.error(extractErrorMessage(err, 'Save failed.'));
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
      });
      if (leadTypeFilter) qParams.set('leadType', leadTypeFilter);
      if (dateFromFilter) qParams.set('dateFrom', dateFromFilter);
      if (dateToFilter) qParams.set('dateTo', dateToFilter);

      const response = await axios.get(`/api/v1/leads/export/csv?${qParams.toString()}`, { responseType: 'blob' });
      const blob = new Blob([response.data], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', `leads-export-${activeVertical.slug}-${Date.now()}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Failed to export CSV database.');
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
        accessorKey: 'status',
        header: 'Status',
        cell: ({ row }) => (
          <InteractiveStatusSelect
            leadId={row.original._id}
            currentStatus={row.original.status}
            statusOptions={STATUS_OPTIONS}
            onStatusUpdated={() => fetchLeads()}
          />
        ),
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
  }, [columnVisibility, customConfigs, navigate]);

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

  // If no vertical is active, show landing dashboard
  if (!activeVertical) {
    return (
      <div className="space-y-6">
        <div className="flex justify-between items-center border-b border-[--border] pb-4">
          <div>
            <h1 className="text-2xl font-black text-[--text-primary] uppercase tracking-wider">COS</h1>
            <p className="text-xs text-[--text-secondary] mt-1">Select a vertical to view client records</p>
          </div>
          <button
            type="button"
            onClick={() => navigate('/follow-ups-positives')}
            className="inline-flex items-center gap-2 px-4 py-2 border border-emerald-300 hover:border-emerald-500 text-emerald-600 bg-white rounded-lg font-bold text-sm hover:bg-stone-50 shadow-sm transition-all"
          >
            <span>Positives & Follow-ups →</span>
          </button>
        </div>

        <VerticalSelectionBar
          verticals={verticals}
          activeVerticalId={null}
          onSelect={(v) => {
            setActiveVertical(v);
            setActiveSubVertical(null);
            navigate(`/leads?verticalId=${v._id}`);
          }}
        />

        <div className="glass-panel border border-[--border] bg-white p-12 text-center text-xs text-[--text-secondary] flex items-center justify-center flex-col gap-2 shadow-sm min-h-[300px]">
          <FileSpreadsheet size={44} className="text-[--text-muted]/30 animate-pulse" />
          <h3 className="font-bold text-sm text-[--text-primary] mt-2">No Active Business Vertical</h3>
          <p className="max-w-xs leading-relaxed">
            Please select a business vertical from the selector above to view and manage cause & conversion records.
          </p>
        </div>
      </div>
    );
  }

  const activeSubVerticalName = activeSubVertical?.name || subVerticals.find(s => s._id === subVerticalFilter)?.name;

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      {/* Workspace Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[--text-primary]">
            {activeSubVerticalName ? `${activeSubVerticalName} – COS` : `${activeVertical.name} – COS`}
          </h1>
          <p className="text-sm text-[--text-secondary] mt-1">
            {activeSubVerticalName 
              ? `Manage cause/conversions for ${activeSubVerticalName} under ${activeVertical?.name || 'Workspace'}.`
              : `Manage cause/conversions for ${activeVertical.name}.`}
          </p>
        </div>

        <div className="flex flex-wrap gap-2 animate-none">
          <button
            type="button"
            onClick={() => navigate(`/follow-ups-positives?verticalId=${activeVertical?._id}`)}
            className="inline-flex items-center gap-2 px-4 py-2 border border-emerald-300 hover:border-emerald-500 text-emerald-600 bg-white rounded-lg font-bold text-sm hover:bg-stone-50 shadow-sm transition-all"
          >
            <span>Positives & Follow-ups →</span>
          </button>
          <button
            type="button"
            onClick={() => navigate(`/raw-data?verticalId=${activeVertical?._id}`)}
            className="inline-flex items-center gap-2 px-4 py-2 border border-emerald-300 hover:border-emerald-500 text-emerald-600 bg-white rounded-lg font-bold text-sm hover:bg-stone-50 shadow-sm transition-all"
          >
            <span>Raw Data →</span>
          </button>
          <button
            type="button"
            onClick={() => navigate(`/delivery-data?verticalId=${activeVertical?._id}`)}
            className="inline-flex items-center gap-2 px-4 py-2 border border-emerald-300 hover:border-emerald-500 text-emerald-600 bg-white rounded-lg font-bold text-sm hover:bg-stone-50 shadow-sm transition-all"
          >
            <span>Delivery Data →</span>
          </button>
          <button
            type="button"
            onClick={() => setShowFilters((prev) => !prev)}
            className="inline-flex items-center gap-2 px-4 py-2 border border-[--border-strong] rounded-lg hover:bg-stone-50 text-sm text-[--text-secondary] bg-white font-medium shadow-sm"
          >
            <Filter size={16} />
            <span>Filters</span>
            {activeFiltersCount > 0 && (
              <span className="ml-1 px-1.5 py-0.5 bg-[--accent] text-white text-[10px] font-black rounded-full leading-none">
                {activeFiltersCount}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={handleCsvExport}
            className="inline-flex items-center gap-2 px-4 py-2 border border-[--border-strong] rounded-lg hover:bg-stone-50 text-sm text-[--text-secondary] bg-white font-medium shadow-sm"
          >
            <Download size={16} />
            <span>Export</span>
          </button>
          <button
            type="button"
            onClick={() => setCsvImportModalOpen(true)}
            className="inline-flex items-center gap-2 px-4 py-2 border border-[--border-strong] rounded-lg hover:bg-stone-50 text-sm text-[--text-secondary] bg-white font-medium shadow-sm"
          >
            <Upload size={16} />
            <span>Import CSV</span>
          </button>
          <button
            type="button"
            onClick={handleOpenAdd}
            className="inline-flex items-center gap-2 px-4 py-2 bg-[--accent] text-white rounded-lg font-bold text-sm hover:bg-[--accent-hover] shadow-sm transition-all"
          >
            <Plus size={16} />
            <span>Add Lead (COS)</span>
          </button>
        </div>
      </div>

      <VerticalSelectionBar
        verticals={verticals}
        activeVerticalId={activeVertical._id}
        onSelect={(v) => {
          setActiveVertical(v);
          setActiveSubVertical(null);
          navigate(`/leads?verticalId=${v._id}`);
        }}
      />

      {csvBatchId && (
        <div className="flex items-center justify-between p-3 bg-[--accent-light] border border-[--accent-border] rounded-lg text-sm text-[--accent] mb-4">
          <div className="flex items-center gap-2">
            <AlertCircle size={16} />
            <span>Viewing leads imported in CSV Batch: <strong>{csvBatchId}</strong></span>
          </div>
          <button
            type="button"
            onClick={() => updateQueryParam('csvBatchId', null)}
            className="text-xs uppercase font-bold text-[--text-secondary] hover:text-[#ff4d4d] transition-all bg-transparent border-0 cursor-pointer p-0"
          >
            Clear Filter
          </button>
        </div>
      )}

      {showFilters && (
        <div className="glass-panel p-4 bg-white border border-[--border]">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            <FilterInput label="Search Leads">
              <div className="relative">
                <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[--text-muted]" />
                <input
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  className="w-full pl-10"
                  placeholder="Search by name or number"
                />
              </div>
            </FilterInput>

            <FilterInput label="Lead Status">
              <select value={statusFilter} onChange={(event) => updateQueryParam('status', event.target.value)} className="w-full">
                <option value="">All Statuses</option>
                {STATUS_OPTIONS.map((status) => (
                  <option key={status.value} value={status.value}>{status.label}</option>
                ))}
              </select>
            </FilterInput>


            <FilterInput label="Lead Type">
              <select value={leadTypeFilter} onChange={(event) => updateQueryParam('leadType', event.target.value)} className="w-full">
                <option value="">All Types</option>
                <option value="CALL">Call Inquiry (Remote)</option>
                <option value="FIELD">Field Visit (On-Site)</option>
              </select>
            </FilterInput>

            <FilterInput label="Date From">
              <input
                type="date"
                value={dateFromFilter}
                onChange={(event) => updateQueryParam('dateFrom', event.target.value)}
                className="w-full bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-1.5 focus:outline-none focus:border-[--accent] text-xs"
              />
            </FilterInput>

            <FilterInput label="Date To">
              <input
                type="date"
                value={dateToFilter}
                onChange={(event) => updateQueryParam('dateTo', event.target.value)}
                className="w-full bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-1.5 focus:outline-none focus:border-[--accent] text-xs"
              />
            </FilterInput>
          </div>
        </div>
      )}

      <div className="glass-panel overflow-hidden bg-white border border-[--border] shadow-sm">
        {loading ? (
          <div className="py-20 flex justify-center"><Loader /></div>
        ) : leads.length === 0 ? (
          <div className="py-16 text-center text-[--text-secondary]">
            <FileSpreadsheet className="mx-auto text-[--text-muted]/30 mb-3" size={48} />
            <p className="text-sm font-semibold">No lead records match your current filters.</p>
            <p className="text-xs text-[--text-muted] mt-1">Add a lead to start filling this list.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm border-collapse">
              <thead>
                <tr className="border-b border-[--border-strong] bg-stone-50">
                  {table.getHeaderGroups().map((group) => (
                    <React.Fragment key={group.id}>
                      {group.headers.map((header) => {
                        const isSortable = ['name', 'phone', 'status'].includes(header.column.id);
                        return (
                          <th key={header.id} className="px-4 py-3 text-xs uppercase font-bold text-[--text-secondary] tracking-wider whitespace-nowrap">
                            {header.isPlaceholder ? null : (
                              <div
                                className={`flex items-center gap-1 ${isSortable ? 'cursor-pointer select-none hover:text-[--text-primary]' : ''}`}
                                onClick={isSortable ? () => handleSort(header.column.id) : undefined}
                              >
                                {flexRender(header.column.columnDef.header, header.getContext())}
                                {isSortable && <ArrowUpDown size={10} />}
                              </div>
                            )}
                          </th>
                        );
                      })}
                    </React.Fragment>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id} row={row} selected={row.getIsSelected()} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {selectedRowIds.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-3 bg-[--accent] text-white font-bold text-xs">
            <div className="flex items-center gap-2">
              <CheckSquare size={16} />
              <span>{selectedRowIds.length} lead rows checked</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => setBulkStatusModal(true)} className="px-3 py-1.5 bg-black/10 hover:bg-black/20 rounded text-xs uppercase">Change Status</button>
              {isAdmin && (
                <>
                  <button onClick={() => setBulkAssignModal(true)} className="px-3 py-1.5 bg-black/10 hover:bg-black/20 rounded text-xs uppercase">Assign Operator</button>
                  <button onClick={() => setBulkDeleteDialog(true)} className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded text-xs uppercase">Delete</button>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-[--text-secondary] mt-4 font-mono select-none">
          <span>Page {page} of {totalPages} (total {totalLeads} records)</span>
          <div className="flex gap-2">
            <button
              disabled={page <= 1}
              onClick={() => updateQueryParam('page', String(page - 1), { resetPage: false })}
              className="px-3 py-1.5 border border-[--border-strong] hover:bg-stone-50 rounded-lg disabled:opacity-30 bg-white"
            >
              <ChevronLeft size={14} className="inline mr-1" /> Prev
            </button>
            <button
              disabled={page >= totalPages}
              onClick={() => updateQueryParam('page', String(page + 1), { resetPage: false })}
              className="px-3 py-1.5 border border-[--border-strong] hover:bg-stone-50 rounded-lg disabled:opacity-30 bg-white"
            >
              Next <ChevronRight size={14} className="inline ml-1" />
            </button>
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
        leadTypeOptions={[
          { value: 'CALL', label: 'Calls' },
          { value: 'FIELD', label: 'Field Visit' },
        ]}
        filenamePrefix="leads"
        title="Import Leads"
        onImportComplete={fetchLeads}
      />

      {leadModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 backdrop-blur-sm p-4">
          <div className="glass-panel w-full max-w-5xl p-6 bg-white border border-[--border] text-[--text-primary] shadow-xl flex flex-col max-h-[90vh]">
            <div className="flex items-start justify-between gap-4 mb-5 flex-shrink-0">
              <div>
                <h2 className="text-xl font-bold text-[--text-primary]">{selectedLead ? 'Edit COS' : 'Create COS'}</h2>
                <p className="text-xs text-[--text-secondary] mt-1">
                  Base COS fields stay at the top. Custom fields stay below so the panel stays clean.
                </p>
              </div>
              <button type="button" onClick={() => setLeadModalOpen(false)} className="px-3 py-1.5 border border-[--border-strong] hover:bg-stone-50 rounded-lg text-xs font-semibold text-[--text-secondary]">
                Close
              </button>
            </div>

            {formErrors.length > 0 && (
              <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-600 text-xs px-3 py-2 rounded-lg mb-4 flex-shrink-0">
                <AlertCircle size={14} />
                <span>{formErrors[0]}</span>
              </div>
            )}

            <form onSubmit={handleLeadSubmit} className="flex flex-col flex-1 overflow-hidden min-h-0">
              <div className="flex-1 overflow-y-auto pr-3 space-y-6 min-h-0 py-1">
                <FormSection title="Lead Fields">
                  <FormField label="Date">
                    <input
                      type="date"
                      value={getDynamicValue(leadFormDynamic, 'date')}
                      onChange={(event) => handleDynamicChange('date', event.target.value)}
                    />
                  </FormField>

                  <FormField label="Business Type">
                    <input
                      type="text"
                      placeholder="-"
                      value={getDynamicValue(leadFormDynamic, 'businessType')}
                      onChange={(event) => handleDynamicChange('businessType', event.target.value)}
                    />
                  </FormField>

                  <FormField label="BUSINESS / PERSON / SHOP / COMPANY NAME *">
                    <input
                      required
                      value={leadFormName}
                      onChange={(event) => {
                        setLeadFormName(event.target.value);
                        setLeadFormBusiness(event.target.value);
                      }}
                    />
                  </FormField>

                  <FormField label="Contact Number *">
                    <input
                      required
                      value={leadFormPhone}
                      onChange={(event) => setLeadFormPhone(event.target.value)}
                    />
                  </FormField>

                  <FormField label="Point of Contact">
                    <input
                      type="text"
                      placeholder="-"
                      value={getDynamicValue(leadFormDynamic, 'pointOfContact')}
                      onChange={(event) => handleDynamicChange('pointOfContact', event.target.value)}
                    />
                  </FormField>
                  <FormField label="Area">
                    <input
                      type="text"
                      placeholder="-"
                      value={getDynamicValue(leadFormDynamic, 'area')}
                      onChange={(event) => handleDynamicChange('area', event.target.value)}
                    />
                  </FormField>

                  <FormField label="City">
                    <input
                      type="text"
                      placeholder="-"
                      value={getDynamicValue(leadFormDynamic, 'city')}
                      onChange={(event) => handleDynamicChange('city', event.target.value)}
                    />
                  </FormField>

                  <FormField label="Link Address">
                    <input
                      type="text"
                      placeholder="-"
                      value={getDynamicValue(leadFormDynamic, 'deliveredLocation')}
                      onChange={(event) => handleDynamicChange('deliveredLocation', event.target.value)}
                    />
                  </FormField>

                  <FormField label="Remarks">
                    <input
                      type="text"
                      placeholder="-"
                      value={getDynamicValue(leadFormDynamic, 'remarks')}
                      onChange={(event) => handleDynamicChange('remarks', event.target.value)}
                    />
                  </FormField>

                  <FormField label="Recordings">
                    <input
                      type="text"
                      placeholder="-"
                      value={getDynamicValue(leadFormDynamic, 'recordings')}
                      onChange={(event) => handleDynamicChange('recordings', event.target.value)}
                    />
                  </FormField>

                  <FormField label="Appointment type (yes or no)">
                    <select
                      value={getDynamicValue(leadFormDynamic, 'appointmentType')}
                      onChange={(event) => handleDynamicChange('appointmentType', event.target.value)}
                    >
                      <option value="">-- Select --</option>
                      <option value="YES">YES</option>
                      <option value="NO">NO</option>
                    </select>
                  </FormField>

                  <FormField label="Appointment date">
                    <input
                      type="date"
                      value={getDynamicValue(leadFormDynamic, 'appointmentDate')}
                      onChange={(event) => handleDynamicChange('appointmentDate', event.target.value)}
                    />
                  </FormField>

                  <FormField label="Appointment time">
                    <input
                      type="text"
                      placeholder="-"
                      value={getDynamicValue(leadFormDynamic, 'appointmentTime')}
                      onChange={(event) => handleDynamicChange('appointmentTime', event.target.value)}
                    />
                  </FormField>

                  <FormField label="Requirement order if any">
                    <input
                      type="text"
                      placeholder="-"
                      value={getDynamicValue(leadFormDynamic, 'requirement')}
                      onChange={(event) => handleDynamicChange('requirement', event.target.value)}
                    />
                  </FormField>

                  <FormField label="Notes to the cos if any">
                    <input
                      type="text"
                      placeholder="-"
                      value={getDynamicValue(leadFormDynamic, 'notes')}
                      onChange={(event) => handleDynamicChange('notes', event.target.value)}
                    />
                  </FormField>

                  {leadFormLeadType === 'FIELD' && (
                    <div className="col-span-1 md:col-span-2 xl:col-span-3">
                      <GeotagCapture
                        leadType="FIELD_VISIT"
                        onChange={(coords, file) => {
                          if (coords) setLeadFormGeotagCoords(coords);
                          if (file) setLeadFormGeotagFile(file);
                        }}
                      />
                    </div>
                  )}
                </FormSection>

                <FormSection title="Assigning">
                  {!subVerticalFilter && (
                    <FormField label="Sub-Vertical">
                      <select
                        value={leadFormSubVerticalId || ''}
                        onChange={(event) => setLeadFormSubVerticalId(event.target.value)}
                      >
                        <option value="">-- None (Vertical Level) --</option>
                        {subVerticals.map((sub) => (
                          <option key={sub._id} value={sub._id}>{sub.name}</option>
                        ))}
                      </select>
                    </FormField>
                  )}

                  <FormField label="Lead Type">
                    <select
                      value={leadFormLeadType}
                      onChange={(event) => {
                        setLeadFormLeadType(event.target.value);
                        if (event.target.value !== 'FIELD') {
                          setLeadFormGeotagCoords(null);
                          setLeadFormGeotagFile(null);
                        }
                      }}
                    >
                      <option value="CALL">Calls</option>
                      <option value="FIELD">Field Visit</option>
                    </select>
                  </FormField>

                  <FormField label="Assign Operator">
                    <SearchableOperatorSelect
                      agents={agents}
                      value={leadFormAssignedTo}
                      onChange={setLeadFormAssignedTo}
                      placeholder="-- Unassigned --"
                    />
                  </FormField>
                </FormSection>

                {customConfigs.length > 0 && (
                  <FormSection title="Custom Fields">
                    {customConfigs.map((config) => (
                      <FormField key={config._id} label={`${config.label}${config.isRequired ? ' *' : ''}`}>
                        <CustomFieldInput
                          config={config}
                          value={getDynamicValue(leadFormDynamic, config.fieldKey) || undefined}
                          onChange={(value) => handleDynamicChange(config.fieldKey, value)}
                        />
                      </FormField>
                    ))}
                  </FormSection>
                )}
              </div>

              <div className="flex justify-end gap-3 border-t border-[--border-strong] pt-4 mt-4 flex-shrink-0">
                <button type="button" onClick={() => setLeadModalOpen(false)} className="px-4 py-2 border border-[--border-strong] hover:bg-stone-50 rounded-lg text-sm font-semibold text-[--text-secondary]">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 bg-[--accent] text-white font-bold rounded-lg text-sm hover:bg-[--accent-hover] shadow-sm">
                  Save Lead (COS)
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmDialog
        isOpen={bulkDeleteDialog}
        title="Bulk Delete COS"
        description={`Are you sure you want to delete these ${selectedRowIds.length} checked COS records?`}
        confirmLabel="Bulk Delete"
        danger
        onConfirm={handleBulkDelete}
        onCancel={() => setBulkDeleteDialog(false)}
      />


      {bulkStatusModal && (
        <Modal title="Bulk Change Status" onClose={() => setBulkStatusModal(false)}>
          <p className="text-xs text-[--text-secondary] mb-4">Choose the target status for all {selectedRowIds.length} checked leads.</p>
          <FilterInput label="Select Status">
            <select value={bulkStatusTarget} onChange={(event) => setBulkStatusTarget(event.target.value)} className="w-full">
              {STATUS_OPTIONS.map((status) => (
                <option key={status.value} value={status.value}>{status.label}</option>
              ))}
            </select>
          </FilterInput>
          <div className="flex justify-end gap-3 mt-6">
            <button onClick={() => setBulkStatusModal(false)} className="px-4 py-2 border border-[--border-strong] hover:bg-stone-50 rounded-lg text-xs font-semibold text-[--text-secondary]">Cancel</button>
            <button onClick={handleBulkStatusChange} className="px-4 py-2 bg-[--accent] text-white font-bold rounded-lg text-xs hover:bg-[--accent-hover]">Apply</button>
          </div>
        </Modal>
      )}

      {bulkAssignModal && (
        <Modal title="Bulk Assign Operator" onClose={() => setBulkAssignModal(false)}>
          <p className="text-xs text-[--text-secondary] mb-4">Choose the operator to assign to all {selectedRowIds.length} checked leads.</p>
          <FilterInput label="Select Operator">
            <select 
              value={bulkAssignTarget} 
              onChange={(event) => setBulkAssignTarget(event.target.value)} 
              className="bg-stone-50 border border-stone-200 rounded-lg px-3 py-2 text-xs font-bold focus:outline-none focus:border-[--accent] w-full"
            >
              <option value="">-- Unassigned --</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>{agent.name}</option>
              ))}
            </select>
          </FilterInput>
          <div className="flex justify-end gap-3 mt-6">
            <button onClick={() => setBulkAssignModal(false)} className="px-4 py-2 border border-[--border-strong] hover:bg-stone-50 rounded-lg text-xs font-semibold text-[--text-secondary]">Cancel</button>
            <button onClick={handleBulkAssign} className="px-4 py-2 bg-[--accent] text-white font-bold rounded-lg text-xs hover:bg-[--accent-hover]">Assign</button>
          </div>
        </Modal>
      )}
    </div>
  );
};

const CustomFieldInput = ({ config, value, onChange }) => {
  if (config.fieldType === 'select') {
    return (
      <select value={value || ''} onChange={(event) => onChange(event.target.value)}>
        <option value="">-- Choose Option --</option>
        {config.options?.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    );
  }

  if (config.fieldType === 'boolean') {
    return (
      <label className="flex items-center gap-2 py-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={!!value}
          onChange={(event) => onChange(event.target.checked)}
          className="accent-[--accent] w-4 h-4"
        />
        <span className="text-xs text-[--text-primary]">Yes</span>
      </label>
    );
  }

  if (config.fieldType === 'textarea') {
    return <textarea rows={4} value={value || ''} onChange={(event) => onChange(event.target.value)} />;
  }

  return (
    <input
      type={config.fieldType === 'number' ? 'number' : config.fieldType === 'date' ? 'date' : config.fieldType === 'url' ? 'url' : 'text'}
      value={value || ''}
      onChange={(event) => onChange(event.target.value)}
    />
  );
};

const FilterInput = ({ label, children }) => (
  <div className="flex flex-col gap-1.5">
    <label className="text-[10px] font-bold text-[--text-secondary] uppercase">{label}</label>
    {children}
  </div>
);

const FormSection = ({ title, children }) => (
  <section className="border-t border-[--border-strong] pt-5">
    <h3 className="text-sm font-black text-[--text-primary] uppercase tracking-wide mb-4">{title}</h3>
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">{children}</div>
  </section>
);

const FormField = ({ label, children }) => (
  <div className="flex flex-col gap-1">
    <label className="text-xs font-bold text-[--text-secondary] uppercase">{label}</label>
    {children}
  </div>
);

const Modal = ({ title, onClose, children }) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 backdrop-blur-sm p-4">
    <div className="glass-panel w-full max-w-sm p-6 bg-white border border-[--border] text-[--text-primary] shadow-xl">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h3 className="text-lg font-bold text-[--text-primary]">{title}</h3>
        <button onClick={onClose} className="px-2 py-1 border border-[--border-strong] rounded text-xs font-semibold text-[--text-secondary] hover:bg-stone-50">Close</button>
      </div>
      {children}
    </div>
  </div>
);

export default LeadsPage;
