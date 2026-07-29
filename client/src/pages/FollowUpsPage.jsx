import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { 
  ClipboardList, User, Clock, Calendar as CalendarIcon, 
  MessageSquare, Plus, Filter, ChevronLeft, ChevronRight, 
  ExternalLink, CheckCircle2, X, Search
} from 'lucide-react';
import axios from '../api/axios.js';
import { useUiStore } from '../store/uiStore.js';
import { useAuthStore } from '../store/authStore.js';
import EmployeeDropdown from '../components/EmployeeDropdown.jsx';
import VerticalSelectionBar from '../components/VerticalSelectionBar.jsx';
import toast from 'react-hot-toast';

export const FollowUpsPage = () => {
  const { user } = useAuthStore();
  const { activeVertical, setActiveVertical, activeSubVertical, setActiveSubVertical, leadsRefreshTrigger } = useUiStore();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  // Filters from URL
  const dateStr = searchParams.get('date') || new Date().toISOString().split('T')[0];
  const agentId = searchParams.get('assignedTo') || '';
  const status = searchParams.get('status') || 'ALL';

  // Data state
  const [followUps, setFollowUps] = useState([]);
  const [loading, setLoading] = useState(false);
  const [agents, setAgents] = useState([]);
  const [selectedAgent, setSelectedAgent] = useState(null);

  const isAdmin = user?.role === 'super_admin' || user?.role === 'vertical_admin';

  // Local Filter scopes
  const [verticals, setVerticals] = useState([]);
  const [subVerticals, setSubVerticals] = useState([]);
  
  // Get/Set subVerticalId in searchParams
  const selectedSubVerticalId = searchParams.get('subVerticalId') || '';
  const setSelectedSubVerticalId = (id) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('subVerticalId', id); else next.delete('subVerticalId');
    setSearchParams(next);
  };

  // Stats dashboard state
  const [stats, setStats] = useState(null);
  const [loadingStats, setLoadingStats] = useState(false);

  // Real-time fields status list
  const [fieldStatuses, setFieldStatuses] = useState([]);

  // Fetch all verticals on mount
  useEffect(() => {
    const fetchVerticals = async () => {
      try {
        const res = await axios.get('/api/v1/verticals');
        setVerticals(res.data.data || []);
      } catch (err) {
        console.error('Failed to load verticals', err);
      }
    };
    fetchVerticals();
  }, []);

  // Fetch sub-verticals when vertical changes
  // Fetch sub-verticals when vertical changes
  useEffect(() => {
    const fetchSubVerticals = async () => {
      if (!activeVertical?._id) {
        setSubVerticals([]);
        return;
      }
      try {
        const res = await axios.get(`/api/v1/verticals/${activeVertical._id}/sub-verticals`);
        const list = res.data.data || [];
        setSubVerticals(list);
        
        // Only reset subVerticalId from URL if it's not present in the new vertical's sub-verticals
        const urlSubId = searchParams.get('subVerticalId');
        if (urlSubId && !list.some(sv => (sv._id || sv.id) === urlSubId)) {
          const next = new URLSearchParams(searchParams);
          next.delete('subVerticalId');
          setSearchParams(next);
        }
      } catch (err) {
        console.error('Failed to load sub-verticals', err);
      }
    };
    fetchSubVerticals();
  }, [activeVertical]);

  // Fetch agents for the selected vertical
  useEffect(() => {
    const fetchAgents = async () => {
      if (!activeVertical?._id) return;
      try {
        const res = await axios.get('/api/v1/users');
        const members = res.data.data.filter(u => u.is_active);
        setAgents(members);
      } catch (err) {
        console.error('Failed to load agents', err);
      }
    };
    fetchAgents();
  }, [activeVertical]);

  // Fetch follow-ups based on filters — useCallback so leadsRefreshTrigger
  // always re-runs with the latest activeVertical / dateStr / subVertical.
  const fetchFollowUps = useCallback(async () => {
    if (!activeVertical?._id) return;
    setLoading(true);
    try {
      const params = { date: dateStr };
      if (selectedSubVerticalId) params.subVerticalId = selectedSubVerticalId;
      
      const res = await axios.get(
        `/api/v1/followUps/verticals/${activeVertical._id}/follow-ups/by-date`,
        { params }
      );
      setFollowUps(res.data.data || []);
    } catch (err) {
      toast.error('Failed to load follow-ups');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [activeVertical, selectedSubVerticalId, dateStr]);

  useEffect(() => {
    fetchFollowUps();
  }, [fetchFollowUps, leadsRefreshTrigger]);

  // Fetch vertical stats dashboard
  const fetchStats = useCallback(async () => {
    if (!activeVertical?._id || !isAdmin) {
      setStats(null);
      return;
    }
    setLoadingStats(true);
    try {
      const params = { date: dateStr };
      if (selectedSubVerticalId) params.subVerticalId = selectedSubVerticalId;
      const res = await axios.get(
        `/api/v1/followUps/verticals/${activeVertical._id}/follow-ups/stats`,
        { params }
      );
      setStats(res.data.data);
    } catch (err) {
      console.error('Failed to load stats', err);
    } finally {
      setLoadingStats(false);
    }
  }, [activeVertical, selectedSubVerticalId, dateStr, isAdmin]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats, leadsRefreshTrigger]);

  // Fetch field status details
  useEffect(() => {
    const fetchFieldStatuses = async () => {
      if (!activeVertical?._id) {
        setFieldStatuses([]);
        return;
      }
      try {
        const [vertFieldsRes, subFieldsRes] = await Promise.all([
          axios.get(`/api/v1/configs/verticals/${activeVertical._id}/fields`),
          selectedSubVerticalId 
            ? axios.get(`/api/v1/admin/sub-verticals/${selectedSubVerticalId}/custom-fields`)
            : Promise.resolve({ data: { data: [] } })
        ]);
        const vertFields = (vertFieldsRes.data.data || []).map(f => ({
          id: f._id || f.id,
          name: f.label,
          type: 'Vertical Field',
          isActive: f.isActive !== false
        }));
        const subFields = (subFieldsRes.data.data || []).map(f => ({
          id: f.id || f._id,
          name: f.label,
          type: 'Sub-Vertical Field',
          isActive: f.is_active !== false
        }));
        setFieldStatuses([...vertFields, ...subFields]);
      } catch (err) {
        console.error(err);
      }
    };
    fetchFieldStatuses();
  }, [activeVertical, selectedSubVerticalId, leadsRefreshTrigger]);

  // Handle employee selection and show details
  useEffect(() => {
    if (agentId) {
      const matched = agents.find(a => a._id === agentId || a.id === agentId);
      setSelectedAgent(matched || null);
    } else {
      setSelectedAgent(null);
    }
  }, [agentId, agents]);

  const updateFilter = (key, value) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next);
  };

  const handleMarkCompleted = async (followUpId, note, nextDate, nextDesc) => {
    try {
      await axios.put(`/api/v1/followUps/follow-ups/${followUpId}`, {
        status: 'COMPLETED',
        completedNote: note,
        nextFollowUpDate: nextDate,
        nextFollowUpDesc: nextDesc
      });
      toast.success('Follow-up completed and next one scheduled!');
      fetchFollowUps();
      fetchStats();
    } catch (err) {
      toast.error('Failed to update follow-up');
    }
  };

  const handleCsvExport = async () => {
    if (!activeVertical) return;
    try {
      const qParams = new URLSearchParams({
        date: dateStr
      });
      if (selectedSubVerticalId) qParams.set('subVerticalId', selectedSubVerticalId);
      if (agentId) qParams.set('assignedTo', agentId);
      if (status) qParams.set('status', status);

      const response = await axios.get(
        `/api/v1/followUps/verticals/${activeVertical._id}/follow-ups/export/csv?${qParams.toString()}`,
        { responseType: 'blob' }
      );
      const blob = new Blob([response.data], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', `follow-ups-export-${activeVertical.slug}-${Date.now()}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      toast.success('Follow-ups exported successfully!');
    } catch (err) {
      console.error('Export failed:', err);
      toast.error('Failed to export follow-ups');
    }
  };

  const filteredFollowUps = followUps.filter(f => status === 'ALL' || f.status === status);

  return (
    <div className="space-y-6 pb-20">
      
      {/* Page Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[--border] pb-6">
        <div>
          <h2 className="text-2xl font-black text-[--text-primary] uppercase tracking-wider flex items-center gap-2">
            <ClipboardList className="text-[--accent]" size={26} />
            <span>Follow-up Management</span>
          </h2>
          <p className="text-xs text-[--text-secondary] mt-1.5 font-medium">
            Workspace: <strong className="text-[--accent]">{activeVertical?.name || 'No workspace active'}</strong> | Detailed schedule tracking and visit reporting
          </p>
        </div>

        <div className="flex gap-2.5">
          {activeVertical && (
            <button 
              onClick={handleCsvExport}
              className="flex items-center gap-2 px-4 py-2 border border-[--border-strong] rounded-lg text-xs font-bold text-[--text-secondary] bg-white hover:bg-stone-50 shadow-sm transition-all"
            >
              <Download size={14} />
              <span>Export CSV</span>
            </button>
          )}
          <button 
            onClick={() => navigate('/calendar')}
            className="flex items-center gap-2 px-4 py-2 border border-[--border-strong] rounded-lg text-xs font-bold text-[--text-secondary] bg-white hover:bg-stone-50 shadow-sm transition-all"
          >
            <CalendarIcon size={14} />
            <span>Calendar View</span>
          </button>
        </div>
      </div>

      {/* Vertical Selector - Always Visible at the Top */}
      <VerticalSelectionBar
        verticals={verticals}
        activeVerticalId={activeVertical?._id}
        onSelect={(v) => {
          setActiveVertical(v);
          setActiveSubVertical(null);
        }}
      />

      {!activeVertical ? (
        <div className="flex flex-col items-center justify-center min-h-[350px] text-center p-8 bg-white border border-[--border] rounded-xl shadow-sm">
          <ClipboardList size={48} className="text-stone-300 mb-4" />
          <h2 className="text-xl font-bold">No Vertical Selected</h2>
          <p className="text-sm text-[--text-secondary] mt-2 max-w-sm">
            Please select a business vertical from the selector above to view scheduled follow-ups.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-4 gap-6 items-start">
          
          {/* Left Column: Filters & Real-time User Details */}
          <div className="xl:col-span-1 space-y-6">
            <div className="glass-panel p-5 bg-white border border-[--border] shadow-sm space-y-5">
              <h3 className="text-xs font-black text-[--text-primary] uppercase tracking-widest border-b border-[--border] pb-3 flex items-center gap-2">
                <Filter size={14} className="text-[--accent]" />
                <span>Schedule Filters</span>
              </h3>

              <div className="space-y-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-black text-[--text-secondary] uppercase tracking-wider">Sub-Vertical</label>
                  <select 
                    value={selectedSubVerticalId}
                    onChange={(e) => setSelectedSubVerticalId(e.target.value)}
                    className="bg-stone-50 border border-stone-200 rounded-lg px-3 py-2 text-xs font-bold focus:outline-none focus:border-[--accent]"
                  >
                    <option value="">All Sub-Verticals</option>
                    {subVerticals.map(sv => (
                      <option key={sv._id || sv.id} value={sv._id || sv.id}>{sv.name}</option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-black text-[--text-secondary] uppercase tracking-wider">Scheduled Date</label>
                  <div className="flex items-center gap-2">
                    <input 
                      type="date"
                      value={dateStr}
                      onChange={(e) => updateFilter('date', e.target.value)}
                      className="flex-1 bg-stone-50 border border-stone-200 rounded-lg px-3 py-2 text-xs font-bold focus:outline-none focus:border-[--accent]"
                    />
                  </div>
                </div>


                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-black text-[--text-secondary] uppercase tracking-wider">Visit Status</label>
                  <select 
                    value={status}
                    onChange={(e) => updateFilter('status', e.target.value)}
                    className="bg-stone-50 border border-stone-200 rounded-lg px-3 py-2 text-xs font-bold focus:outline-none focus:border-[--accent]"
                  >
                    <option value="ALL">All Statuses</option>
                    <option value="PENDING">Pending Visits</option>
                    <option value="COMPLETED">Completed Visits</option>
                    <option value="MISSED">Missed Visits</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Real-time Field Configuration Status Widget */}
            <div className="glass-panel p-5 bg-white border border-[--border] shadow-sm space-y-4">
              <h3 className="text-xs font-black text-[--text-primary] uppercase tracking-widest border-b border-[--border] pb-3 flex items-center gap-2">
                <ClipboardList size={14} className="text-[--accent]" />
                <span>Field Status (Real-time)</span>
              </h3>

              {fieldStatuses.length === 0 ? (
                <p className="text-[10px] text-[--text-muted] italic">No fields configured for this scope.</p>
              ) : (
                <div className="space-y-2.5 max-h-[200px] overflow-y-auto pr-1">
                  {fieldStatuses.map(f => (
                    <div key={f.id} className="flex justify-between items-center bg-stone-50 border border-stone-200/50 p-2 rounded-lg text-[10px]">
                      <div className="truncate pr-2">
                        <span className="block font-bold text-[--text-primary] truncate">{f.name}</span>
                        <span className="block text-[8px] text-[--text-muted] mt-0.5">{f.type}</span>
                      </div>
                      <span className={`px-2 py-0.5 rounded-full font-black uppercase text-[8px] shrink-0 ${
                        f.isActive 
                          ? 'bg-emerald-50 text-emerald-600 border border-emerald-200' 
                          : 'bg-stone-100 text-stone-500 border border-stone-200'
                      }`}>
                        {f.isActive ? 'Being Added' : 'Not Added'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

          </div>

          {/* Right Column: Follow-up List & Details */}
          <div className="xl:col-span-3 space-y-6">
            
            {/* Admin KPI Dashboard */}
            {isAdmin && stats && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 animate-in fade-in duration-300">
                {/* Card 1: Total */}
                <div className="glass-panel p-4 bg-indigo-50/20 border border-indigo-100 rounded-xl flex items-center gap-4">
                  <div className="w-10 h-10 rounded-lg bg-indigo-500 text-white flex items-center justify-center">
                    <ClipboardList size={20} />
                  </div>
                  <div>
                    <span className="block text-[10px] font-black text-[--text-secondary] uppercase tracking-wider">Total Visits</span>
                    <span className="text-xl font-bold text-[--text-primary]">{stats.daily.total}</span>
                    <span className="block text-[8px] text-[--text-muted] mt-0.5">All-time: {stats.allTime.total}</span>
                  </div>
                </div>

                {/* Card 2: Pending */}
                <div className="glass-panel p-4 bg-amber-50/20 border border-amber-100 rounded-xl flex items-center gap-4">
                  <div className="w-10 h-10 rounded-lg bg-amber-500 text-white flex items-center justify-center">
                    <Clock size={20} />
                  </div>
                  <div>
                    <span className="block text-[10px] font-black text-[--text-secondary] uppercase tracking-wider">Pending</span>
                    <span className="text-xl font-bold text-[--text-primary]">{stats.daily.pending}</span>
                    <span className="block text-[8px] text-[--text-muted] mt-0.5">All-time: {stats.allTime.pending}</span>
                  </div>
                </div>

                {/* Card 3: Completed */}
                <div className="glass-panel p-4 bg-emerald-50/20 border border-emerald-100 rounded-xl flex items-center gap-4">
                  <div className="w-10 h-10 rounded-lg bg-emerald-500 text-white flex items-center justify-center">
                    <CheckCircle2 size={20} />
                  </div>
                  <div>
                    <span className="block text-[10px] font-black text-[--text-secondary] uppercase tracking-wider">Completed</span>
                    <span className="text-xl font-bold text-[--text-primary]">{stats.daily.completed}</span>
                    <span className="block text-[8px] text-[--text-muted] mt-0.5">All-time: {stats.allTime.completed}</span>
                  </div>
                </div>

                {/* Card 4: Missed */}
                <div className="glass-panel p-4 bg-rose-50/20 border border-rose-100 rounded-xl flex items-center gap-4">
                  <div className="w-10 h-10 rounded-lg bg-rose-500 text-white flex items-center justify-center">
                    <X size={20} />
                  </div>
                  <div>
                    <span className="block text-[10px] font-black text-[--text-secondary] uppercase tracking-wider">Missed</span>
                    <span className="text-xl font-bold text-[--text-primary]">{stats.daily.missed}</span>
                    <span className="block text-[8px] text-[--text-muted] mt-0.5">All-time: {stats.allTime.missed}</span>
                  </div>
                </div>
              </div>
            )}

            <div className="glass-panel bg-white border border-[--border] shadow-sm overflow-hidden flex flex-col min-h-[500px]">
              {/* List Header */}
              <div className="px-6 py-4 border-b border-[--border] bg-stone-50/50 flex justify-between items-center">
                <h3 className="text-sm font-black text-[--text-primary] uppercase tracking-wide">
                  Visit Schedule for {new Date(dateStr).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
                </h3>
                <span className="text-[10px] font-black bg-white border border-[--border-strong] px-3 py-1 rounded-full text-[--text-secondary]">
                  {filteredFollowUps.length} Records Found
                </span>
              </div>

              {/* Content Area */}
              <div className="flex-1 overflow-y-auto">
                {loading ? (
                  <div className="p-20 flex flex-col items-center justify-center gap-3">
                    <div className="w-8 h-8 border-4 border-stone-100 border-t-[--accent] rounded-full animate-spin" />
                    <span className="text-[10px] font-black uppercase text-[--text-muted] tracking-widest">Synchronizing...</span>
                  </div>
                ) : filteredFollowUps.length === 0 ? (
                  <div className="p-20 text-center space-y-3 opacity-60">
                    <ClipboardList size={64} className="mx-auto text-stone-200" />
                    <p className="text-sm font-bold text-[--text-secondary]">No follow-ups scheduled for this criteria.</p>
                    <p className="text-xs">Adjust your filters or select another date.</p>
                  </div>
                ) : (
                  <div className="divide-y divide-stone-100">
                    {filteredFollowUps.map(item => (
                      <FollowUpCard 
                        key={item.id} 
                        item={item} 
                        onComplete={handleMarkCompleted}
                        isAdmin={isAdmin}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const FollowUpCard = ({ item, onComplete, isAdmin }) => {
  const [showCompleteForm, setShowCompleteForm] = useState(false);
  const [note, setNote] = useState('');
  const [nextDate, setNextDate] = useState('');
  const [nextDesc, setNextDesc] = useState('');

  const isPending = item.status === 'PENDING';
  const isCompleted = item.status === 'COMPLETED';
  const isMissed = item.status === 'MISSED';

  const handleComplete = (e) => {
    e.preventDefault();
    if (!note.trim()) {
      toast.error('Completion note is required');
      return;
    }
    onComplete(item.id, note, nextDate, nextDesc);
    setShowCompleteForm(false);
  };

  return (
    <div className="p-6 hover:bg-stone-50/50 transition-all group">
      <div className="flex flex-col lg:flex-row gap-6">
        
        {/* Left: Time and Lead Info */}
        <div className="lg:w-1/4 space-y-3">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-stone-100 rounded-lg text-[--text-primary]">
              <Clock size={16} />
            </div>
            <span className="text-lg font-black font-mono">
              {new Date(item.follow_up_date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>

          <div>
            <Link 
              to={`/leads/${item.lead_id}`}
              className="text-sm font-black text-[--text-primary] hover:text-[--accent] transition-all flex items-center gap-1.5 group-hover:translate-x-1 duration-300"
            >
              <span>{item.lead_business || item.lead_name}</span>
              <ExternalLink size={12} className="opacity-40" />
            </Link>
            <p className="text-[10px] text-[--text-muted] mt-1 font-bold uppercase tracking-wider">
              {item.sub_vertical_name}
            </p>
            <div className="flex items-center gap-1.5 mt-1 text-[10px] text-[--text-secondary] lg:hidden font-medium">
              <div className="w-4 h-4 rounded bg-stone-100 flex items-center justify-center text-[7px] border border-stone-200 font-bold">
                {item.assigned_to_name?.slice(0, 1)}
              </div>
              <span>{item.assigned_to_name || 'Unassigned'}</span>
            </div>
          </div>

          <div className={`inline-flex px-2.5 py-1 rounded-full text-[9px] font-black uppercase border ${
            isCompleted ? 'bg-emerald-50 text-emerald-600 border-emerald-200' :
            isPending ? 'bg-amber-50 text-amber-600 border-amber-200' :
            'bg-rose-50 text-rose-600 border-rose-200'
          }`}>
            {item.status}
          </div>
        </div>

        {/* Center: Description and Notes */}
        <div className="flex-1 space-y-4">
          <div className="bg-stone-50/50 border border-stone-100 p-4 rounded-xl space-y-2">
            <h4 className="text-[10px] font-black text-[--text-muted] uppercase tracking-widest flex items-center gap-1.5">
              <MessageSquare size={12} />
              <span>Visit Instruction / Agenda</span>
            </h4>
            <p className="text-sm text-[--text-secondary] leading-relaxed italic">
              "{item.description}"
            </p>
          </div>

          {item.completed_note && (
            <div className="bg-emerald-50/30 border border-emerald-100 p-4 rounded-xl space-y-2">
              <h4 className="text-[10px] font-black text-emerald-600 uppercase tracking-widest flex items-center gap-1.5">
                <CheckCircle2 size={12} />
                <span>Visit Outcome Report</span>
              </h4>
              <p className="text-sm text-emerald-800 leading-relaxed font-medium">
                {item.completed_note}
              </p>
              <div className="flex justify-between items-center text-[10px] text-emerald-600 pt-1 border-t border-emerald-100/50 font-mono">
                <span>Completed At: {new Date(item.completed_at).toLocaleString()}</span>
              </div>
            </div>
          )}

          {isPending && !showCompleteForm && (
            <button
              onClick={() => setShowCompleteForm(true)}
              className="px-6 py-2.5 bg-white border-2 border-emerald-500 text-emerald-600 hover:bg-emerald-600 hover:text-white font-black text-xs rounded-xl transition-all shadow-sm flex items-center gap-2 uppercase tracking-wider"
            >
              <CheckCircle2 size={16} />
              <span>Record Visit Outcome</span>
            </button>
          )}

          {showCompleteForm && (
            <div className="bg-white border-2 border-emerald-100 rounded-2xl p-6 shadow-lg animate-in slide-in-from-top-4 duration-300">
              <form onSubmit={handleComplete} className="space-y-5">
                <div className="flex justify-between items-center border-b border-stone-100 pb-3">
                  <h4 className="text-xs font-black text-[--text-primary] uppercase tracking-widest">Complete Follow-up Visit</h4>
                  <button type="button" onClick={() => setShowCompleteForm(false)} className="text-stone-400 hover:text-stone-600"><X size={16} /></button>
                </div>

                <div className="space-y-4">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-black text-[--text-secondary] uppercase tracking-wider">Visit Description / Outcome *</label>
                    <textarea 
                      required
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      rows={3}
                      placeholder="Detail the conversation and results..."
                      className="bg-stone-50 border border-stone-200 rounded-xl p-3 text-sm focus:outline-none focus:border-emerald-500"
                    />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-black text-[--text-secondary] uppercase tracking-wider">Optional Next Follow Date</label>
                      <input 
                        type="datetime-local"
                        value={nextDate}
                        onChange={(e) => setNextDate(e.target.value)}
                        className="bg-stone-50 border border-stone-200 rounded-xl px-3 py-2 text-xs font-bold focus:outline-none focus:border-emerald-500"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-black text-[--text-secondary] uppercase tracking-wider">Description of Next</label>
                      <input 
                        type="text"
                        value={nextDesc}
                        onChange={(e) => setNextDesc(e.target.value)}
                        placeholder="Next steps summary..."
                        className="bg-stone-50 border border-stone-200 rounded-xl px-3 py-2 text-xs font-bold focus:outline-none focus:border-emerald-500"
                      />
                    </div>
                  </div>
                </div>

                <div className="flex justify-end gap-3 pt-2">
                  <button 
                    type="button"
                    onClick={() => setShowCompleteForm(false)}
                    className="px-4 py-2 text-xs font-bold text-[--text-secondary] hover:bg-stone-100 rounded-lg transition-all"
                  >
                    Cancel
                  </button>
                  <button 
                    type="submit"
                    className="px-6 py-2 bg-emerald-600 text-white font-black text-xs rounded-lg hover:bg-emerald-700 shadow-md transition-all uppercase tracking-widest"
                  >
                    Save & Complete
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>

        {/* Right: metadata */}
        <div className="lg:w-1/6 space-y-4 text-[10px] border-l border-stone-50 pl-6 hidden lg:block">
          <div>
            <span className="block font-black text-[--text-muted] uppercase tracking-widest mb-1">Created By</span>
            <span className="font-medium text-[--text-secondary]">{item.creator_name}</span>
          </div>

          <div>
            <span className="block font-black text-[--text-muted] uppercase tracking-widest mb-1">Created At</span>
            <span className="font-medium text-[--text-secondary]">{new Date(item.created_at).toLocaleDateString()}</span>
          </div>
        </div>

      </div>
    </div>
  );
};

export default FollowUpsPage;
