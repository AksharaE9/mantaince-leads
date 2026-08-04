import React, { useState, useEffect } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import axios from '../api/axios.js';
import { 
  Layers, ChevronRight, Plus, Check, X, ShieldAlert, Trash2, Edit2, 
  HelpCircle, Eye, Settings, ListPlus, ToggleLeft, ToggleRight, ArrowUp, ArrowDown,
  Upload
} from 'lucide-react';
import toast from 'react-hot-toast';

export const AdminVerticalsPage = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [verticals, setVerticals] = useState([]);
  const [loading, setLoading] = useState(true);

  // Selected vertical detail
  const [selectedVertical, setSelectedVertical] = useState(null);
  const [subVerticals, setSubVerticals] = useState([]);
  const [loadingSubs, setLoadingSubs] = useState(false);
  const [leadCount, setLeadCount] = useState(0);

  // Sync selected vertical with URL param
  useEffect(() => {
    const verticalId = searchParams.get('id');
    const action = searchParams.get('action');

    if (verticalId && verticals.length > 0) {
      const found = verticals.find(v => v._id === verticalId);
      if (found) {
        if (!selectedVertical || selectedVertical._id !== verticalId) {
          handleSelectVertical(found);
        }
        
        if (action === 'delete' && !deleting) {
          // Add a small delay to ensure selection and confirmation dialog can show properly
          setTimeout(() => {
            if (window.confirm(`Are you sure you want to delete ${found.name}? This will remove all associated data.`)) {
              handleDeleteVertical(verticalId);
            } else {
              setSearchParams({ id: verticalId }); // Remove action from URL
            }
          }, 100);
        }
      }
    }
  }, [searchParams, verticals]);

  // Vertical Edit form states
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editColor, setEditColor] = useState('#c8956c');
  const [editIcon, setEditIcon] = useState('ti-folder');
  const [editActive, setEditActive] = useState(true);
  const [statuses, setStatuses] = useState([]);
  const [newStatusLabel, setNewStatusLabel] = useState('');
  const [newStatusValue, setNewStatusValue] = useState('');
  const [isStatusValueManuallyEdited, setIsStatusValueManuallyEdited] = useState(false);
  const [savingVertical, setSavingVertical] = useState(false);

  // Quick Field modal states
  const [quickFieldModalOpen, setQuickFieldModalOpen] = useState(false);
  const [quickFieldSub, setQuickFieldSub] = useState(null);
  const [quickFieldLabel, setQuickFieldLabel] = useState('');
  const [quickFieldKey, setQuickFieldKey] = useState('');
  const [quickFieldType, setQuickFieldType] = useState('TEXT');
  const [quickFieldRequired, setQuickFieldRequired] = useState(false);
  const [quickFieldOptionsStr, setQuickFieldOptionsStr] = useState('');
  const [savingQuickField, setSavingQuickField] = useState(false);

  // Add Inline Vertical State
  const [showAddRow, setShowAddRow] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newColor, setNewColor] = useState('#c8956c');

  // Sub-vertical form states
  const [newSubName, setNewSubName] = useState('');
  const [editingSubId, setEditingSubId] = useState(null);
  const [editingSubName, setEditingSubName] = useState('');
  const [creatingSub, setCreatingSub] = useState(false);

  // Danger zone confirmation
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);

  // Upload states
  const [uploadingLeads, setUploadingLeads] = useState(false);
  const [uploadSub, setUploadSub] = useState(null);
  const fileInputRef = React.useRef(null);

  const presetColors = [
    { label: 'Terracotta', value: '#c8956c' },
    { label: 'Blue', value: '#185FA5' },
    { label: 'Green', value: '#2ecc71' },
    { label: 'Red', value: '#e74c3c' },
    { label: 'Orange', value: '#f39c12' },
    { label: 'Purple', value: '#9b59b6' },
  ];

  const fetchVerticalsList = async () => {
    setLoading(true);
    try {
      const res = await axios.get('/api/v1/verticals');
      setVerticals(res.data.data);
    } catch {
      toast.error('Failed to retrieve business verticals list');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchVerticalsList();
  }, []);

  // Auto-generate key from label for Quick Add Custom Field
  useEffect(() => {
    const key = quickFieldLabel
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/(^-|_$)/g, '');
    setQuickFieldKey(key);
  }, [quickFieldLabel]);

  const handleSelectVertical = async (vert) => {
    setSelectedVertical(vert);
    setSearchParams({ id: vert._id });
    setEditName(vert.name);
    setEditDescription(vert.description || '');
    setEditColor(vert.color || '#c8956c');
    setEditIcon(vert.icon || 'ti-folder');
    setEditActive(vert.isActive);
    setStatuses(vert.statuses || []);
    setDeleteConfirmText('');

    // Fetch sub-verticals and leads stats
    setLoadingSubs(true);
    try {
      const [subsRes, countRes] = await Promise.all([
        axios.get(`/api/v1/verticals/${vert._id}/sub-verticals`),
        axios.get(`/api/v1/leads?verticalId=${vert._id}&limit=1`)
      ]);
      setSubVerticals(subsRes.data.data);
      setLeadCount(countRes.data.meta?.total || 0);
    } catch {
      toast.error('Failed to load vertical details metadata');
    } finally {
      setLoadingSubs(false);
    }
  };

  const handleCreateVertical = async (e) => {
    e.preventDefault();
    if (!newName.trim()) return;

    try {
      const res = await axios.post('/api/v1/verticals', {
        name: newName,
        description: newDesc,
        color: newColor,
        icon: 'ti-folder'
      });
      toast.success('Vertical created successfully!');
      setNewName('');
      setNewDesc('');
      setShowAddRow(false);
      await fetchVerticalsList();
      handleSelectVertical(res.data.data);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to create vertical');
    }
  };

  const handleSaveVerticalDetails = async () => {
    if (!selectedVertical) return;
    setSavingVertical(true);
    try {
      const res = await axios.patch(`/api/v1/verticals/${selectedVertical._id}`, {
        name: editName,
        description: editDescription,
        color: editColor,
        icon: editIcon,
        isActive: editActive,
        statuses
      });
      toast.success('Vertical updated successfully');
      await fetchVerticalsList();
      setSelectedVertical(res.data.data);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update vertical specifications');
    } finally {
      setSavingVertical(false);
    }
  };

  const handleAddStatus = () => {
    if (!newStatusLabel || !newStatusValue) return;
    setStatuses([...statuses, { label: newStatusLabel, value: newStatusValue }]);
    setNewStatusLabel('');
    setNewStatusValue('');
    setIsStatusValueManuallyEdited(false);
  };

  const handleDeleteStatus = (index) => {
    setStatuses(statuses.filter((_, i) => i !== index));
  };

  const handleUploadCsv = async (event) => {
    const file = event.target.files[0];
    if (!file || !selectedVertical) return;

    if (!uploadSub) {
      toast.error('Please select a sub-vertical to upload leads to.');
      return;
    }

    const formData = new FormData();
    formData.append('file', file);
    formData.append('verticalId', selectedVertical._id);
    formData.append('subVerticalId', uploadSub._id);

    setUploadingLeads(true);
    const toastId = toast.loading(`Uploading leads to ${uploadSub.name}...`);
    try {
      await axios.post('/api/v1/leads/csv/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      toast.success('Leads batch uploaded successfully!', { id: toastId });
      // Refresh lead count
      const countRes = await axios.get(`/api/v1/leads?verticalId=${selectedVertical._id}&limit=1`);
      setLeadCount(countRes.data.meta?.total || 0);
    } catch (err) {
      toast.error(err.response?.data?.error || 'CSV upload failed', { id: toastId });
    } finally {
      setUploadingLeads(false);
      setUploadSub(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Reorder commands
  const moveVertical = async (index, direction) => {
    const nextIndex = direction === 'up' ? index - 1 : index + 1;
    if (nextIndex < 0 || nextIndex >= verticals.length) return;

    const list = [...verticals];
    // swap
    const temp = list[index];
    list[index] = list[nextIndex];
    list[nextIndex] = temp;

    // Build payload of { id, displayOrder }
    const payload = list.map((item, idx) => ({
      id: item._id,
      displayOrder: idx
    }));

    // Update state immediately for UX
    setVerticals(list);

    try {
      await axios.patch('/api/v1/verticals/reorder', payload);
      toast.success('Display layout reordered');
    } catch {
      toast.error('Failed to update vertical displays ordering');
      fetchVerticalsList();
    }
  };

  // Sub-Vertical Operations
  const handleAddSubVertical = async (e) => {
    e.preventDefault();
    if (!newSubName.trim() || !selectedVertical) return;
    setCreatingSub(true);
    try {
      const res = await axios.post(`/api/v1/verticals/${selectedVertical._id}/sub-verticals`, {
        name: newSubName
      });
      toast.success('Sub-vertical added successfully');
      setNewSubName('');
      setSubVerticals([...subVerticals, res.data.data]);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to map sub-vertical');
    } finally {
      setCreatingSub(false);
    }
  };

  const handleStartEditSub = (sub) => {
    setEditingSubId(sub._id);
    setEditingSubName(sub.name);
  };

  const handleSaveSubName = async (subId) => {
    try {
      const res = await axios.patch(`/api/v1/verticals/sub-verticals/${subId}`, {
        name: editingSubName
      });
      toast.success('Sub-vertical updated');
      setSubVerticals(subVerticals.map(s => s._id === subId ? res.data.data : s));
      setEditingSubId(null);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Rename failed');
    }
  };

  const handleToggleSubActive = async (sub) => {
    try {
      const res = await axios.patch(`/api/v1/verticals/sub-verticals/${sub._id}`, {
        isActive: !sub.isActive
      });
      setSubVerticals(subVerticals.map(s => s._id === sub._id ? res.data.data : s));
      toast.success('Status toggled');
    } catch {
      toast.error('Failed to toggle active state');
    }
  };

  const handleDeleteSub = async (subId) => {
    if (window.confirm('Are you sure you want to delete this sub-vertical?')) {
      try {
        await axios.delete(`/api/v1/verticals/sub-verticals/${subId}`);
        toast.success('Sub-vertical removed');
        setSubVerticals(subVerticals.filter(s => s._id !== subId));
      } catch (err) {
        toast.error(err.response?.data?.error || 'Delete rejected');
      }
    }
  };

  const handleCreateQuickField = async (e) => {
    e.preventDefault();
    if (!quickFieldLabel.trim() || !quickFieldKey.trim() || !quickFieldSub) return;
    setSavingQuickField(true);
    
    const typeUpper = quickFieldType.toUpperCase();
    const optionsArray = (typeUpper === 'SELECT' || typeUpper === 'MULTISELECT')
      ? quickFieldOptionsStr.split(',').map(s => s.trim()).filter(Boolean)
      : [];

    try {
      await axios.post(`/api/v1/admin/sub-verticals/${quickFieldSub._id}/custom-fields`, {
        label: quickFieldLabel,
        fieldKey: quickFieldKey,
        fieldType: quickFieldType.toLowerCase(),
        isRequired: quickFieldRequired,
        options: optionsArray
      });
      toast.success(`Field "${quickFieldLabel}" created successfully!`);
      setQuickFieldLabel('');
      setQuickFieldKey('');
      setQuickFieldType('TEXT');
      setQuickFieldRequired(false);
      setQuickFieldOptionsStr('');
      setQuickFieldModalOpen(false);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to create field');
    } finally {
      setSavingQuickField(false);
    }
  };

  const handleDeleteVertical = async (overrideId = null) => {
    const targetId = overrideId || selectedVertical?._id;
    if (!targetId) return;
    
    setDeleting(true);
    try {
      await axios.delete(`/api/v1/verticals/${targetId}`);
      toast.success(`Vertical deleted successfully`);
      setSelectedVertical(null);
      setSearchParams({}); // Clear ID from URL
      await fetchVerticalsList();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Deletions rejected');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      
      {/* Page header */}
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-black text-[--text-primary] uppercase tracking-wider">Verticals & Sub-Verticals</h2>
          <p className="text-xs text-[--text-secondary] mt-1">Configure business tenant groups, categorization structures, and dynamic fields portals</p>
        </div>
        <button
          onClick={() => setShowAddRow(!showAddRow)}
          className="flex items-center gap-2 px-4 py-2.5 bg-[--accent] text-white font-black uppercase text-xs rounded-lg hover:bg-[--accent-hover] transition-all shadow-md"
        >
          <Plus size={14} />
          <span>Add Vertical</span>
        </button>
      </div>

      {/* Inline Add vertical form */}
      {showAddRow && (
        <form onSubmit={handleCreateVertical} className="glass-panel p-4 bg-white border border-[--border] rounded-xl space-y-3 max-w-xl shadow-md">
          <h3 className="text-xs font-black uppercase text-[--accent] tracking-wider">Initialize Business Vertical</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
            <div className="flex flex-col gap-1">
              <label className="font-bold text-[--text-secondary] uppercase">Vertical Name</label>
              <input
                type="text"
                required
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="bg-[--bg-input] border border-[--border-strong] rounded-lg px-2.5 py-1.5 text-[--text-primary] focus:outline-none focus:border-[--accent]"
                placeholder="e.g. Real Estate"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="font-bold text-[--text-secondary] uppercase">Short Description</label>
              <input
                type="text"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                className="bg-[--bg-input] border border-[--border-strong] rounded-lg px-2.5 py-1.5 text-[--text-primary] focus:outline-none focus:border-[--accent]"
                placeholder="Residential properties"
              />
            </div>
          </div>
          <div className="flex justify-between items-center text-xs pt-2">
            <div className="flex items-center gap-2">
              <span className="font-bold text-[--text-secondary] uppercase">Color Tag:</span>
              <div className="flex gap-1.5">
                {presetColors.map(c => (
                  <button
                    key={c.value}
                    type="button"
                    className={`w-5 h-5 rounded-full border border-stone-300 transition-all ${newColor === c.value ? 'ring-2 ring-[--accent] scale-110' : ''}`}
                    style={{ backgroundColor: c.value }}
                    onClick={() => setNewColor(c.value)}
                  />
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowAddRow(false)}
                className="px-3 py-1.5 border border-[--border-strong] text-[--text-secondary] hover:bg-stone-50 rounded-lg font-semibold bg-white"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-3 py-1.5 bg-[--accent] text-white font-black uppercase rounded-lg hover:bg-[--accent-hover]"
              >
                Create
              </button>
            </div>
          </div>
        </form>
      )}

      {/* Main double column manager dashboard */}
      <div className="flex flex-col lg:flex-row gap-6">
        
        {/* Left Column: Draggable display vertical cards list */}
        <div className="w-full lg:w-96 glass-panel border border-[--border] bg-white overflow-hidden flex flex-col shadow-sm">
          <div className="p-4 bg-stone-50 border-b border-[--border] flex justify-between items-center">
            <span className="text-xs font-bold text-[--text-secondary] uppercase tracking-wider">Business Verticals ({verticals.length})</span>
            <span className="text-[10px] text-[--text-muted] uppercase font-bold tracking-wider">Sort Order</span>
          </div>

          <div className="divide-y divide-[--border]">
            {loading ? (
              Array.from({ length: 3 }).map((_, idx) => (
                <div key={idx} className="p-4 animate-pulse flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="w-3 h-3 rounded-full bg-stone-100"></div>
                    <div className="h-4 bg-stone-100 rounded w-28"></div>
                  </div>
                  <div className="w-4 h-8 bg-stone-100 rounded"></div>
                </div>
              ))
            ) : verticals.length === 0 ? (
              <div className="text-center py-10 text-xs text-[--text-secondary]">
                No business verticals registered. Create one to get started.
              </div>
            ) : (
              verticals.map((vert, idx) => (
                <div
                  key={vert._id}
                  onClick={() => handleSelectVertical(vert)}
                  className={`p-4 flex items-center justify-between cursor-pointer transition-all hover:bg-stone-50/50 ${
                    selectedVertical?._id === vert._id ? 'bg-[--accent-light]' : ''
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: vert.color || 'var(--border)' }} />
                    <div>
                      <h4 className="text-sm font-semibold text-[--text-primary] group-hover:text-[--accent] transition-all flex items-center gap-1.5">
                        <span>{vert.name}</span>
                        {!vert.isActive && (
                          <span className="px-1.5 py-0.5 bg-red-50 text-red-500 border border-red-100 text-[8px] font-bold rounded uppercase">
                            Inactive
                          </span>
                        )}
                      </h4>
                      <p className="text-[10px] text-[--text-secondary] leading-none mt-1 truncate max-w-[180px]">{vert.description || 'No description'}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 onClick-handler">
                    <button
                      onClick={(e) => { e.stopPropagation(); moveVertical(idx, 'up'); }}
                      disabled={idx === 0}
                      className="p-1 text-[--text-muted] hover:text-[--text-primary] disabled:opacity-20"
                    >
                      <ArrowUp size={12} />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); moveVertical(idx, 'down'); }}
                      disabled={idx === verticals.length - 1}
                      className="p-1 text-[--text-muted] hover:text-[--text-primary] disabled:opacity-20"
                    >
                      <ArrowDown size={12} />
                    </button>

                    <button
                      onClick={(e) => { 
                        e.stopPropagation(); 
                        if (window.confirm(`Are you sure you want to delete ${vert.name}? This will remove all associated data.`)) {
                          handleSelectVertical(vert);
                          setTimeout(() => handleDeleteVertical(vert._id), 0);
                        }
                      }}
                      className="p-1 text-[--text-muted] hover:text-[#ff4d4d] transition-all"
                    >
                      <Trash2 size={12} />
                    </button>

                    <ChevronRight size={14} className="text-[--text-secondary] ml-2" />
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Right Column: Selected Vertical specs detailed configurations */}
        {selectedVertical ? (
          <div className="flex-1 glass-panel border border-[--border] bg-white p-6 space-y-6 shadow-sm">
            
            {/* Header section redirecting to dynamic fields */}
            <div className="flex justify-between items-center border-b border-[--border] pb-4">
              <div>
                <h3 className="text-lg font-black text-[--text-primary] uppercase">{selectedVertical.name} Profile</h3>
                <span className="text-[10px] text-[--text-secondary] font-mono tracking-wider block">ID: {selectedVertical._id} | Slug: {selectedVertical.slug}</span>
              </div>
              <Link
                to={`/admin/verticals/${selectedVertical._id}/fields`}
                className="flex items-center gap-1.5 px-3 py-2 border border-[--accent-border] hover:border-[--accent] text-[--accent] font-bold text-xs rounded-lg transition-all bg-white shadow-sm"
              >
                <Settings size={12} />
                <span>Configure Dynamic Fields</span>
              </Link>
            </div>

            {/* General configurations fields */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              <div className="flex flex-col gap-1.5">
                <label className="font-bold text-[--text-secondary] uppercase">Vertical Display Name</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-[--text-primary] focus:outline-none focus:border-[--accent]"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="font-bold text-[--text-secondary] uppercase">Description Banner</label>
                <input
                  type="text"
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  className="bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-[--text-primary] focus:outline-none focus:border-[--accent]"
                />
              </div>

              {/* Color Preset Picker */}
              <div className="flex flex-col gap-1.5">
                <label className="font-bold text-[--text-secondary] uppercase">Branding Color</label>
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    value={editColor}
                    onChange={(e) => setEditColor(e.target.value)}
                    className="w-8 h-8 rounded border border-stone-300 bg-transparent cursor-pointer"
                  />
                  <div className="flex flex-wrap gap-1">
                    {presetColors.map(c => (
                      <button
                        key={c.value}
                        type="button"
                        className={`w-4 h-4 rounded-full border border-stone-300 ${editColor === c.value ? 'ring-1 ring-[--accent]' : ''}`}
                        style={{ backgroundColor: c.value }}
                        onClick={() => setEditColor(c.value)}
                      />
                    ))}
                  </div>
                </div>
              </div>

              {/* Toggle active state */}
              <div className="flex items-center justify-between bg-stone-50/50 p-3 rounded-lg border border-[--border]">
                <div>
                  <span className="font-bold text-[--text-primary] uppercase block">Vertical Status</span>
                  <span className="text-[9px] text-[--text-secondary] block mt-0.5">Allow leads indexing</span>
                </div>
                <button
                  type="button"
                  onClick={() => setEditActive(!editActive)}
                  className="text-[--text-secondary] hover:text-[--text-primary] transition-all"
                >
                  {editActive ? (
                    <ToggleRight className="text-[#2ecc71]" size={28} />
                  ) : (
                    <ToggleLeft className="text-[--text-muted]" size={28} />
                  )}
                </button>
              </div>
            </div>

            {/* Lead Statuses configuration */}
            <div className="bg-stone-50/50 p-5 rounded-xl border border-[--border] space-y-4 shadow-sm">
              <div className="flex items-center justify-between border-b border-[--border] pb-3">
                <h4 className="text-[11px] font-black text-[--text-primary] uppercase tracking-widest flex items-center gap-2">
                  <ListPlus size={14} className="text-[--accent]" />
                  <span>Configurable Lead Statuses</span>
                </h4>
                <span className="text-[9px] font-bold text-[--text-secondary] bg-white border border-[--border-strong] px-2 py-0.5 rounded-full">
                  {statuses.length} Defined
                </span>
              </div>

              <div className="flex flex-wrap gap-2">
                {statuses.length === 0 ? (
                  <p className="text-[10px] text-[--text-muted] italic">No custom statuses defined. Will fallback to global defaults.</p>
                ) : (
                  statuses.map((st, idx) => (
                    <div key={idx} className="flex items-center gap-2 bg-white border border-stone-200 rounded-lg px-2.5 py-1.5 group hover:border-[--accent-border] transition-all">
                      <span className="text-[11px] font-bold text-[--text-primary]">{st.label}</span>
                      <span className="text-[9px] text-[--text-muted] font-mono">({st.value})</span>
                      <button 
                        type="button"
                        onClick={() => handleDeleteStatus(idx)}
                        className="text-stone-300 hover:text-rose-500 transition-colors opacity-0 group-hover:opacity-100"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-2 pt-2">
                <input
                  type="text"
                  placeholder="Label (e.g. New Lead)"
                  value={newStatusLabel}
                  onChange={(e) => {
                    const labelVal = e.target.value;
                    setNewStatusLabel(labelVal);
                    if (!isStatusValueManuallyEdited) {
                      setNewStatusValue(labelVal.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/(^-|_$)/g, ''));
                    }
                  }}
                  className="bg-white border border-stone-200 rounded-lg px-3 py-2 text-[11px] focus:outline-none focus:border-[--accent]"
                />
                <input
                  type="text"
                  placeholder="Value (e.g. new_lead)"
                  value={newStatusValue}
                  onChange={(e) => {
                    const val = e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_');
                    setNewStatusValue(val);
                    setIsStatusValueManuallyEdited(val !== '');
                  }}
                  className="bg-white border border-stone-200 rounded-lg px-3 py-2 text-[11px] font-mono focus:outline-none focus:border-[--accent]"
                />
                <button
                  type="button"
                  onClick={handleAddStatus}
                  className="px-4 py-2 bg-stone-100 border border-stone-200 text-[--text-primary] font-bold uppercase text-[10px] rounded-lg hover:bg-stone-200 transition-all"
                >
                  Add Status
                </button>
              </div>
            </div>

            <div className="flex justify-end pt-2 border-b border-[--border] pb-4 gap-3">
              <input 
                type="file" 
                ref={fileInputRef} 
                onChange={handleUploadCsv} 
                className="hidden" 
                accept=".csv"
              />
              <button
                onClick={handleSaveVerticalDetails}
                disabled={savingVertical}
                className="px-4 py-2 bg-[--accent] text-white font-black uppercase text-xs rounded-lg hover:bg-[--accent-hover] transition-all shadow-sm"
              >
                {savingVertical ? 'Saving...' : 'Save Vertical Details'}
              </button>
            </div>

            {/* Sub-vertical section list manager */}
            <div className="space-y-4">
              <h4 className="text-sm font-bold text-[--text-primary] uppercase tracking-wider flex items-center gap-2">
                <ListPlus size={16} className="text-[--accent]" />
                <span>Sub-Vertical Categories ({subVerticals.length})</span>
              </h4>

              {/* Add sub-vertical form inline */}
              <form onSubmit={handleAddSubVertical} className="flex gap-2 text-xs">
                <input
                  type="text"
                  required
                  placeholder="Create sub-vertical label (e.g. Apartments)"
                  value={newSubName}
                  onChange={(e) => setNewSubName(e.target.value)}
                  className="flex-1 bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-[--text-primary] focus:outline-none focus:border-[--accent]"
                />
                <button
                  type="submit"
                  disabled={creatingSub}
                  className="px-4 py-2 bg-[--accent] text-white font-black uppercase rounded-lg hover:bg-[--accent-hover]"
                >
                  Add Category
                </button>
              </form>

              {/* Scrollable list of sub-verticals */}
              <div className="border border-[--border] rounded-lg bg-[--bg-input] overflow-hidden">
                <div className="divide-y divide-[--border] text-xs max-h-[250px] overflow-y-auto bg-white">
                  {loadingSubs ? (
                    <div className="text-center py-6 text-[--text-secondary]">Loading sub-categories...</div>
                  ) : subVerticals.length === 0 ? (
                    <div className="text-center py-6 text-[--text-secondary]">No sub-verticals mapped under this vertical.</div>
                  ) : (
                    subVerticals.map((sub, sIdx) => (
                      <div key={sub._id} className="p-3 flex items-center justify-between hover:bg-stone-50/50 transition-all">
                        {editingSubId === sub._id ? (
                          <div className="flex items-center gap-2 flex-1 mr-2">
                            <input
                              type="text"
                              value={editingSubName}
                              onChange={(e) => setEditingSubName(e.target.value)}
                              className="flex-1 bg-[--bg-input] border border-[--accent-border] rounded px-2.5 py-1 text-[--text-primary] text-xs focus:outline-none"
                            />
                            <button
                              onClick={() => handleSaveSubName(sub._id)}
                              className="p-1 bg-[#2ecc71] text-white rounded hover:bg-[#2ecc71]/80"
                            >
                              <Check size={12} />
                            </button>
                            <button
                              onClick={() => setEditingSubId(null)}
                              className="p-1 bg-stone-100 text-[--text-secondary] rounded hover:bg-stone-200 border border-[--border]"
                            >
                              <X size={12} />
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-[--text-primary]">{sub.name}</span>
                            <span className="text-[10px] text-[--text-muted] font-mono leading-none">({sub.slug})</span>
                            {!sub.isActive && (
                              <span className="px-1 py-0.5 bg-red-50 text-red-500 border border-red-100 text-[7px] font-bold rounded uppercase">
                                Suspended
                              </span>
                            )}
                          </div>
                        )}

                        {editingSubId !== sub._id && (
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => {
                                setUploadSub(sub);
                                fileInputRef.current?.click();
                              }}
                              className="px-1.5 py-0.5 border border-emerald-200 rounded text-emerald-600 hover:bg-emerald-50 transition-all bg-white flex items-center gap-0.5 font-bold"
                              title="Upload Leads for this Category"
                              style={{ fontSize: '9px' }}
                            >
                              <Upload size={9} />
                              <span>Upload</span>
                            </button>

                            <button
                              type="button"
                              onClick={() => {
                                setQuickFieldSub(sub);
                                setQuickFieldModalOpen(true);
                              }}
                              className="px-1.5 py-0.5 border border-[--accent-border] rounded text-[--accent] hover:bg-[--accent-light] transition-all bg-white flex items-center gap-0.5 font-bold"
                              title="Add Field Directly"
                              style={{ fontSize: '9px' }}
                            >
                              <Plus size={9} />
                              <span>Field</span>
                            </button>

                            <Link
                              to={`/admin/sub-verticals/${sub._id}/fields`}
                              className="px-1.5 py-0.5 border border-[--border-strong] rounded text-[--text-secondary] hover:text-[--accent] hover:border-[--accent] transition-all bg-white hover:bg-stone-50 flex items-center gap-1"
                              title="Configure Custom Fields"
                              style={{ fontSize: '9px' }}
                            >
                              <Settings size={10} />
                              <span className="font-bold">Fields</span>
                            </Link>

                            <button
                              onClick={() => handleToggleSubActive(sub)}
                              className={`px-1.5 py-0.5 text-[9px] font-bold rounded uppercase border ${
                                sub.isActive 
                                  ? 'bg-[#2ecc71]/10 text-[#2ecc71] border-[#2ecc71]/20' 
                                  : 'bg-stone-50 text-[--text-secondary] border-[--border-strong]'
                              }`}
                            >
                              {sub.isActive ? 'Active' : 'Inactive'}
                            </button>

                            <button
                              onClick={() => handleStartEditSub(sub)}
                              className="p-1 border border-[--border-strong] rounded text-[--text-secondary] hover:text-[--accent] transition-all bg-white hover:bg-stone-50"
                            >
                              <Edit2 size={10} />
                            </button>

                            <button
                              onClick={() => handleDeleteSub(sub._id)}
                              className="p-1 border border-[--border-strong] rounded text-[--text-secondary] hover:text-[#ff4d4d] transition-all bg-white hover:bg-stone-50"
                            >
                              <Trash2 size={10} />
                            </button>
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            {/* DANGER ZONE delete section */}
            <div className="border border-red-200 bg-red-50 rounded-xl p-5 space-y-4">
              <h4 className="text-sm font-bold text-red-600 flex items-center gap-2 uppercase tracking-wider">
                <ShieldAlert size={18} />
                <span>Danger Zone</span>
              </h4>
              <p className="text-xs text-[--text-secondary] leading-relaxed">
                Deleting a vertical is permanent. It deletes all nested sub-verticals, field structures, and configurations. 
                Deletion will fail if there are any active leads linked to this vertical. (Active Leads Linked: <strong>{leadCount}</strong>)
              </p>

              {leadCount > 0 ? (
                <div className="flex items-center gap-2 text-xs bg-red-100/50 text-red-700 border border-red-200 px-3 py-2 rounded-lg font-medium">
                  <ShieldAlert size={14} />
                  <span>Cannot delete. Clear existing {leadCount} leads from leads table first.</span>
                </div>
              ) : (
                <div className="space-y-3 text-xs">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[--text-primary] font-semibold">Type vertical name <strong>{selectedVertical.name}</strong> to confirm:</label>
                    <input
                      type="text"
                      className="bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-[--text-primary] focus:outline-none focus:border-red-500 max-w-sm"
                      placeholder="Type vertical name exact match"
                      value={deleteConfirmText}
                      onChange={(e) => setDeleteConfirmText(e.target.value)}
                    />
                  </div>
                  <button
                    onClick={handleDeleteVertical}
                    disabled={deleting || deleteConfirmText !== selectedVertical.name}
                    className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-40 transition-all text-white font-bold rounded-lg uppercase tracking-wide text-xs"
                  >
                    Delete Vertical Configuration
                  </button>
                </div>
              )}
            </div>

          </div>
        ) : (
          <div className="flex-1 glass-panel border border-[--border] bg-white p-12 text-center text-xs text-[--text-secondary] flex items-center justify-center flex-col gap-2 shadow-sm">
            <Layers size={36} className="text-[--text-muted]/30" />
            <span>Select a business vertical on the left to configure metadata profile and categories</span>
          </div>
        )}

      </div>

      {/* Quick Add Field Modal */}
      {quickFieldModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 backdrop-blur-sm">
          <div className="w-full max-w-md bg-white rounded-xl shadow-2xl border border-[--border] overflow-hidden">
            <div className="p-5 border-b border-[--border] flex items-center justify-between bg-stone-50 text-xs">
              <div>
                <h3 className="text-sm font-bold text-[--text-primary] uppercase tracking-wider">Quick Add Field</h3>
                <p className="text-xs text-[--text-secondary] mt-0.5">
                  Sub-vertical: <strong className="text-[--accent]">{quickFieldSub?.name}</strong>
                </p>
              </div>
              <button 
                onClick={() => setQuickFieldModalOpen(false)}
                className="p-1.5 border border-[--border-strong] rounded-lg text-[--text-secondary] hover:text-[--text-primary] bg-white transition-all shadow-sm"
              >
                <X size={16} />
              </button>
            </div>
            
            <form onSubmit={handleCreateQuickField} className="p-5 space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className="font-bold text-[--text-secondary] uppercase">Field Label</label>
                  <input
                    type="text"
                    required
                    value={quickFieldLabel}
                    onChange={(e) => setQuickFieldLabel(e.target.value)}
                    className="bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-[--text-primary] focus:outline-none focus:border-[--accent]"
                    placeholder="e.g. Property SQFT"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="font-bold text-[--text-secondary] uppercase">Database Key</label>
                  <input
                    type="text"
                    required
                    readOnly
                    value={quickFieldKey}
                    className="bg-stone-50 border border-[--border] rounded-lg px-3 py-2 text-[--text-muted] font-mono outline-none cursor-not-allowed"
                    placeholder="property_sqft"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="font-bold text-[--text-secondary] uppercase">Value Type</label>
                <select
                  value={quickFieldType}
                  onChange={(e) => setQuickFieldType(e.target.value)}
                  className="bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-2 text-[--text-primary] focus:outline-none focus:border-[--accent]"
                >
                  <option value="text">Plain Text</option>
                  <option value="number">Number</option>
                  <option value="phone">Phone Number</option>
                  <option value="email">Email Address</option>
                  <option value="url">URL Hyperlink</option>
                  <option value="boolean">Boolean (Yes/No)</option>
                  <option value="select">Dropdown Choice Menu (Select)</option>
                  <option value="multiselect">Multi-select Menu</option>
                  <option value="date">Date picker</option>
                  <option value="textarea">Textarea Block</option>
                </select>
              </div>

              {(quickFieldType.toLowerCase() === 'select' || quickFieldType.toLowerCase() === 'multiselect') && (
                <div className="flex flex-col gap-1.5 bg-stone-50 p-3 rounded-lg border border-[--border]">
                  <label className="font-bold text-[--accent] uppercase">Comma-separated Options</label>
                  <input
                    type="text"
                    required
                    value={quickFieldOptionsStr}
                    onChange={(e) => setQuickFieldOptionsStr(e.target.value)}
                    className="bg-white border border-[--accent-border] rounded-lg px-3 py-2 text-[--text-primary] focus:outline-none focus:border-[--accent]"
                    placeholder="e.g. Small, Medium, Large"
                  />
                  <span className="text-[10px] text-[--text-secondary]">Input possible option values separated by commas.</span>
                </div>
              )}

              <div className="bg-stone-50 p-3 rounded-lg border border-[--border]">
                <label className="flex items-center gap-2 cursor-pointer select-none text-[--text-secondary] font-semibold">
                  <input
                    type="checkbox"
                    checked={quickFieldRequired}
                    onChange={(e) => setQuickFieldRequired(e.target.checked)}
                    className="rounded border-[--border-strong] bg-[--bg-input] text-[--accent] focus:ring-0 w-4 h-4"
                  />
                  <span>Is Required Field</span>
                </label>
              </div>

              <div className="flex justify-end gap-3 pt-3 border-t border-[--border]">
                <button
                  type="button"
                  onClick={() => setQuickFieldModalOpen(false)}
                  className="px-4 py-2 border border-[--border-strong] rounded-lg text-[--text-secondary] hover:bg-stone-50 font-semibold transition-all bg-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingQuickField}
                  className="px-4 py-2 bg-[--accent] text-white font-black uppercase rounded-lg hover:bg-[--accent-hover] transition-all shadow-sm"
                >
                  {savingQuickField ? 'Creating...' : 'Create Field'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
};

export default AdminVerticalsPage;
