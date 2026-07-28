import React, { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import axios from '../api/axios.js';
import { useUiStore } from '../store/uiStore.js';
import { useAuthStore } from '../store/authStore.js';
import { 
  ChevronLeft, ChevronRight, Calendar, User, Clock, CheckCircle2, 
  AlertCircle, MessageSquare, ExternalLink, Filter, Check, X
} from 'lucide-react';
import toast from 'react-hot-toast';

export const CalendarPage = () => {
  const { user } = useAuthStore();
  const { activeVertical } = useUiStore();
  const [searchParams, setSearchParams] = useSearchParams();

  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(new Date());
  
  // Data state
  const [calendarData, setCalendarData] = useState({}); // { [dateStr]: { pending, completed, missed, total } }
  const [dailyFollowUps, setDailyFollowUps] = useState([]);
  const [loadingCalendar, setLoadingCalendar] = useState(false);
  const [loadingDaily, setLoadingDaily] = useState(false);

  // Filters
  const [subVerticals, setSubVerticals] = useState([]);
  
  // Get/Set subVerticalId in searchParams
  const selectedSubId = searchParams.get('subVerticalId') || '';
  const setSelectedSubId = (id) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('subVerticalId', id); else next.delete('subVerticalId');
    setSearchParams(next);
  };
  const [agents, setAgents] = useState([]);
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('ALL');
  const [searchName, setSearchName] = useState('');

  // Action / Completion Dialog state
  const [completingId, setCompletingId] = useState(null);
  const [completedNote, setCompletedNote] = useState('');
  const [submittingCompletion, setSubmittingCompletion] = useState(false);

  const isAdmin = user?.role === 'super_admin' || user?.role === 'vertical_admin';

  // Format local date to YYYY-MM-DD
  const formatLocalDate = (date) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };

  // Fetch sub-verticals when vertical changes
  useEffect(() => {
    const fetchSubVerticals = async () => {
      if (!activeVertical) return;
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
        console.error('Failed to load sub-vertical filters', err);
      }
    };
    fetchSubVerticals();
  }, [activeVertical]);

  // Fetch agents when sub-vertical changes
  useEffect(() => {
    const fetchAgents = async () => {
      if (!selectedSubId) {
        setAgents([]);
        setSelectedAgentId('');
        return;
      }
      try {
        const res = await axios.get(`/api/v1/admin/sub-verticals/${selectedSubId}/users`);
        setAgents(res.data.data);
        setSelectedAgentId('');
      } catch (err) {
        console.error('Failed to load sub-vertical agents', err);
      }
    };
    fetchAgents();
  }, [selectedSubId]);

  // Fetch calendar grid data
  const fetchCalendarGrid = async () => {
    if (!activeVertical) return;
    setLoadingCalendar(true);
    try {
      const year = currentDate.getFullYear();
      const month = currentDate.getMonth() + 1;
      
      const params = { year, month };
      if (selectedSubId) params.subVerticalId = selectedSubId;

      const res = await axios.get(
        `/api/v1/followUps/verticals/${activeVertical._id}/follow-ups/calendar`,
        { params }
      );
      setCalendarData(res.data.data || {});
    } catch (err) {
      toast.error('Failed to load calendar follow-ups grid');
      console.error(err);
    } finally {
      setLoadingCalendar(false);
    }
  };

  // Fetch daily follow ups
  const fetchDailyFollowUps = async () => {
    if (!activeVertical) return;
    setLoadingDaily(true);
    try {
      const dateStr = formatLocalDate(selectedDate);
      const params = { date: dateStr };

      const res = await axios.get(
        `/api/v1/followUps/verticals/${activeVertical._id}/follow-ups/by-date`,
        { params }
      );
      setDailyFollowUps(res.data.data || []);
    } catch (err) {
      toast.error('Failed to load daily follow-ups list');
      console.error(err);
    } finally {
      setLoadingDaily(false);
    }
  };

  // Trigger grid fetch on date, vertical, or filter change
  useEffect(() => {
    fetchCalendarGrid();
  }, [currentDate, activeVertical, selectedSubId]);

  // Trigger daily list fetch on selected date or active vertical change
  useEffect(() => {
    fetchDailyFollowUps();
  }, [selectedDate, activeVertical]);

  // Navigation
  const prevMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1));
  };

  const nextMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1));
  };

  // Grid builder
  const buildCalendarGrid = () => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth(); // 0-11

    const firstDayIndex = new Date(year, month, 1).getDay(); // 0 (Sun) to 6 (Sat)
    const totalDays = new Date(year, month + 1, 0).getDate();

    const grid = [];
    // Padding for previous month
    for (let i = 0; i < firstDayIndex; i++) {
      grid.push(null);
    }
    // Days
    for (let d = 1; d <= totalDays; d++) {
      grid.push(new Date(year, month, d));
    }
    return grid;
  };

  const handleMarkCompleted = async (e, followUpId) => {
    e.preventDefault();
    setSubmittingCompletion(true);
    try {
      await axios.put(`/api/v1/followUps/follow-ups/${followUpId}`, {
        status: 'COMPLETED',
        completedNote
      });
      toast.success('Follow-up marked as completed!');
      setCompletingId(null);
      setCompletedNote('');
      
      // Refresh
      fetchDailyFollowUps();
      fetchCalendarGrid();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to complete follow-up');
    } finally {
      setSubmittingCompletion(false);
    }
  };

  if (!activeVertical) {
    return (
      <div className="glass-panel border border-[--border] bg-white p-12 text-center text-xs text-[--text-secondary] flex items-center justify-center flex-col gap-2 shadow-sm min-h-[400px]">
        <Calendar size={48} className="text-[--text-muted]/30 animate-pulse" />
        <h3 className="font-bold text-sm text-[--text-primary] mt-2">No Active Business Vertical</h3>
        <p className="max-w-xs leading-relaxed">
          Please select a business vertical from the sidebar workspace to view and manage follow-ups.
        </p>
      </div>
    );
  }

  const filteredDailyFollowUps = dailyFollowUps.filter(item => {
    const nameMatch = searchName.trim() === '' || 
      (item.lead_name && item.lead_name.toLowerCase().includes(searchName.toLowerCase())) ||
      (item.lead_business && item.lead_business.toLowerCase().includes(searchName.toLowerCase()));
    
    const statusMatch = selectedStatus === 'ALL' || item.status === selectedStatus;
    
    return nameMatch && statusMatch;
  });

  const daysGrid = buildCalendarGrid();
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <div className="space-y-6">
      
      {/* Page Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[--border] pb-4">
        <div>
          <h2 className="text-2xl font-black text-[--text-primary] uppercase tracking-wider flex items-center gap-2">
            <Calendar className="text-[--accent]" size={24} />
            <span>Follow-up Calendar</span>
          </h2>
          <p className="text-xs text-[--text-secondary] mt-1">
            Workspace: <strong className="text-[--accent]">{activeVertical.name}</strong> | Track client interactions and scheduled check-ins
          </p>
        </div>

        {/* Filters Panel */}
        <div className="flex flex-wrap gap-2.5 items-center text-xs">
          <div className="flex items-center gap-1.5 bg-stone-50 border border-[--border-strong] rounded-lg px-2 py-1 bg-white">
            <Filter size={12} className="text-[--text-secondary]" />
            <span className="font-bold text-[--text-secondary] uppercase text-[10px]">Filter:</span>
          </div>

          {/* Sub-vertical select */}
          <select
            value={selectedSubId}
            onChange={(e) => setSelectedSubId(e.target.value)}
            className="bg-[--bg-input] border border-[--border-strong] rounded-lg px-3 py-1.5 focus:outline-none focus:border-[--accent] text-xs w-44"
          >
            <option value="">All Categories</option>
            {subVerticals.map(sub => (
              <option key={sub._id} value={sub._id}>{sub.name}</option>
            ))}
          </select>

        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Left Column: Calendar monthly grid */}
        <div className="lg:col-span-2 space-y-4">
          <div className="glass-panel border border-[--border] bg-white p-5 shadow-sm">
            
            {/* Calendar Controls */}
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-base font-black text-[--text-primary] uppercase font-sans tracking-wide">
                {currentDate.toLocaleString('default', { month: 'long', year: 'numeric' })}
              </h3>
              <div className="flex gap-2">
                <button
                  onClick={prevMonth}
                  className="p-1.5 border border-[--border-strong] rounded-lg hover:bg-stone-50 text-[--text-secondary] transition-all bg-white"
                >
                  <ChevronLeft size={16} />
                </button>
                <button
                  onClick={() => { setCurrentDate(new Date()); setSelectedDate(new Date()); }}
                  className="px-3 py-1 border border-[--border-strong] rounded-lg hover:bg-stone-50 text-[--text-secondary] text-xs font-semibold uppercase bg-white"
                >
                  Today
                </button>
                <button
                  onClick={nextMonth}
                  className="p-1.5 border border-[--border-strong] rounded-lg hover:bg-stone-50 text-[--text-secondary] transition-all bg-white"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>

            {/* Calendar Grid */}
            <div data-testid="calendar-grid-view" className="grid grid-cols-7 gap-2">
              
              {/* Day names */}
              {dayNames.map(day => (
                <div key={day} className="text-center font-bold text-xs text-[--text-secondary] py-2 uppercase tracking-wider select-none">
                  {day}
                </div>
              ))}

              {/* Days numbers */}
              {daysGrid.map((day, idx) => {
                if (!day) {
                  return <div key={`empty-${idx}`} className="aspect-square bg-stone-50/40 border border-stone-100 rounded-lg" />;
                }

                const dateStr = formatLocalDate(day);
                const stats = calendarData[dateStr];
                const isSelected = formatLocalDate(selectedDate) === dateStr;
                const isToday = formatLocalDate(new Date()) === dateStr;

                return (
                  <div
                    key={dateStr}
                    onClick={() => setSelectedDate(day)}
                    className={`aspect-square p-2 border rounded-lg cursor-pointer transition-all flex flex-col justify-between relative select-none ${
                      isSelected 
                        ? 'border-[--accent] bg-[--accent-light] shadow-sm scale-[1.02]' 
                        : 'border-[--border] hover:border-[--accent-border] hover:bg-stone-50/50 bg-white'
                    }`}
                  >
                    {/* Day number & Total badge */}
                    <div className="flex justify-between items-center w-full">
                      <span className={`text-xs font-bold ${
                        isToday 
                          ? 'bg-[--accent] text-white w-5 h-5 rounded-full flex items-center justify-center -ml-0.5' 
                          : isSelected ? 'text-[--accent]' : 'text-[--text-primary]'
                      }`}>
                        {day.getDate()}
                      </span>
                      {stats && stats.total > 0 && (
                        <span className="text-[9px] font-black bg-stone-100 text-[--text-primary] px-1.5 py-0.2 rounded-full border border-stone-200">
                          {stats.total}
                        </span>
                      )}
                    </div>

                    {/* Stats pills / follow-up details */}
                    {/* Stats indicator dots (No text pills display) */}
                    {stats && stats.total > 0 && (
                      <div className="w-full mt-auto overflow-hidden">
                        <div className="flex flex-wrap gap-0.5 justify-center mt-1 select-none">
                          {stats.items.slice(0, 3).map(item => (
                            <span 
                              key={item.id} 
                              className={`w-1.5 h-1.5 rounded-full ${
                                item.status === 'COMPLETED' ? 'bg-emerald-500' :
                                item.status === 'PENDING' ? 'bg-amber-500' :
                                'bg-rose-500'
                              }`}
                              title={`${item.leadBusiness || item.leadName || 'Unnamed'}: ${item.status}`}
                            />
                          ))}
                          {stats.total > 3 && (
                            <span className="text-[7px] text-[--text-muted] font-bold leading-none">+</span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

            </div>
          </div>
        </div>

        {/* Right Column: Detailed daily view */}
        <div className="lg:col-span-1 space-y-4">
          <div className="glass-panel border border-[--border] bg-white p-5 shadow-sm flex flex-col h-full min-h-[450px]">
            
            {/* Header */}
            <div className="border-b border-[--border] pb-3 mb-3 flex justify-between items-center">
              <div>
                <Link 
                  to={`/follow-ups?date=${formatLocalDate(selectedDate)}`}
                  className="text-sm font-black text-[--text-primary] uppercase tracking-wide hover:text-[--accent] transition-all flex items-center gap-1.5"
                >
                  Schedule Details
                  <ExternalLink size={14} className="opacity-40" />
                </Link>
                <span className="text-xs text-[--text-secondary] font-semibold">
                  {selectedDate.toLocaleDateString('default', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })}
                </span>
              </div>
              <span className="text-[10px] bg-stone-100 border border-stone-200 px-2 py-0.5 rounded-full font-bold text-[--text-secondary]">
                {filteredDailyFollowUps.length} follow-up(s)
              </span>
            </div>

            {/* Filtering Controls */}
            <div className="space-y-2 mb-4 text-xs">
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Search lead/business..."
                  value={searchName}
                  onChange={(e) => setSearchName(e.target.value)}
                  className="flex-1 bg-[--bg-input] border border-[--border-strong] rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-[--accent] text-xs"
                />
                <select
                  value={selectedStatus}
                  onChange={(e) => setSelectedStatus(e.target.value)}
                  className="bg-[--bg-input] border border-[--border-strong] rounded-lg px-2 py-1.5 focus:outline-none focus:border-[--accent] text-xs w-28 font-semibold"
                >
                  <option value="ALL">All Statuses</option>
                  <option value="PENDING">Pending</option>
                  <option value="COMPLETED">Completed</option>
                  <option value="MISSED">Missed</option>
                </select>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold text-[--text-secondary] uppercase shrink-0">Selected Date:</span>
                <input
                  type="date"
                  value={formatLocalDate(selectedDate)}
                  onChange={(e) => {
                    if (e.target.value) {
                      const d = new Date(e.target.value);
                      setSelectedDate(d);
                      setCurrentDate(d);
                    }
                  }}
                  className="bg-[--bg-input] border border-[--border-strong] rounded-lg px-2.5 py-1 focus:outline-none focus:border-[--accent] text-xs flex-1 font-semibold"
                />
              </div>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto space-y-3 pr-1">
              {loadingDaily ? (
                Array.from({ length: 2 }).map((_, idx) => (
                  <div key={idx} className="p-3 border border-[--border] rounded-lg animate-pulse space-y-2">
                    <div className="h-4 bg-stone-100 rounded w-24"></div>
                    <div className="h-3 bg-stone-100 rounded w-full"></div>
                    <div className="h-3 bg-stone-100 rounded w-32"></div>
                  </div>
                ))
              ) : filteredDailyFollowUps.length === 0 ? (
                <div className="text-center py-12 text-xs text-[--text-secondary] flex flex-col items-center justify-center gap-1.5">
                  <Clock size={24} className="text-[--text-muted]/40" />
                  <span>No follow-ups match your filters.</span>
                </div>
              ) : (
                filteredDailyFollowUps.map(item => {
                  const isCompleted = item.status === 'COMPLETED';
                  const isPending = item.status === 'PENDING';
                  const isMissed = item.status === 'MISSED';

                  return (
                    <div key={item.id} className="p-3.5 border border-[--border] rounded-xl hover:bg-stone-50/30 transition-all space-y-2.5 relative bg-white">
                      
                      {/* Top Row: Lead title and redirect */}
                      <div className="flex justify-between items-start">
                        <div>
                          <Link
                            to={`/leads/${item.lead_id}`}
                            className="font-bold text-xs text-[--text-primary] hover:text-[--accent] transition-all flex items-center gap-1"
                          >
                            <span>{item.lead_business || item.lead_name}</span>
                            <ExternalLink size={10} className="shrink-0" />
                          </Link>
                          <span className="text-[9px] text-[--text-muted] block mt-0.5">
                            Category: {item.sub_vertical_name}
                          </span>
                        </div>
                        <span className={`px-2 py-0.5 rounded text-[8px] font-bold uppercase border ${
                          isCompleted ? 'bg-emerald-50 text-emerald-600 border-emerald-200' :
                          isPending ? 'bg-amber-50 text-amber-600 border-amber-200' :
                          'bg-rose-50 text-rose-600 border-rose-200'
                        }`}>
                          {item.status}
                        </span>
                      </div>

                      {/* Middle: Description */}
                      <p className="text-xs text-[--text-secondary] bg-stone-50 border border-stone-100 p-2 rounded-lg leading-relaxed italic">
                        "{item.description}"
                      </p>

                      {/* Bottom Row: metadata and completion trigger */}
                      <div className="flex justify-between items-center text-[10px] text-[--text-muted] pt-1 border-t border-stone-50">
                        <span className="flex items-center gap-1">
                          <User size={11} />
                          <span className="truncate max-w-[80px]">{item.assigned_to_name}</span>
                        </span>
                        <span className="flex items-center gap-1 font-mono">
                          <Clock size={11} />
                          <span>{new Date(item.follow_up_date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        </span>
                      </div>

                      {/* Completed note display */}
                      {item.completed_note && (
                        <div className="bg-emerald-50/20 border border-emerald-100 text-[10px] text-emerald-800 p-2 rounded-lg flex items-start gap-1.5">
                          <MessageSquare size={12} className="shrink-0 mt-0.5 text-emerald-600" />
                          <span className="leading-relaxed"><strong>Note:</strong> {item.completed_note}</span>
                        </div>
                      )}

                      {/* Completed action inline block */}
                      {isPending && completingId !== item.id && (
                        <button
                          onClick={() => setCompletingId(item.id)}
                          className="w-full mt-2 py-1 border border-emerald-200 hover:border-transparent bg-white hover:bg-emerald-600 text-emerald-600 hover:text-white font-bold text-[10px] rounded-lg transition-all flex items-center justify-center gap-1 shadow-sm font-sans"
                        >
                          <CheckCircle2 size={11} />
                          <span>Mark Visit Completed</span>
                        </button>
                      )}

                      {/* Completion Note Form Dialog */}
                      {completingId === item.id && (
                        <form onSubmit={(e) => handleMarkCompleted(e, item.id)} className="mt-3 p-3 bg-stone-50 border border-stone-200 rounded-xl space-y-2">
                          <span className="text-[10px] font-bold uppercase text-[--text-secondary] block">
                            Write Completion Summary:
                          </span>
                          <textarea
                            value={completedNote}
                            onChange={(e) => setCompletedNote(e.target.value)}
                            required
                            rows={2}
                            className="bg-white border border-stone-300 rounded-lg p-1.5 text-xs text-[--text-primary] focus:outline-none w-full"
                            placeholder="e.g. Visited store, discussed invoice issues."
                          />
                          <div className="flex gap-1.5 justify-end">
                            <button
                              type="button"
                              onClick={() => { setCompletingId(null); setCompletedNote(''); }}
                              className="px-2.5 py-1 border border-stone-300 text-[10px] font-semibold rounded hover:bg-stone-100 bg-white"
                            >
                              Cancel
                            </button>
                            <button
                              type="submit"
                              disabled={submittingCompletion || !completedNote.trim()}
                              className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-[10px] rounded transition-all"
                            >
                              {submittingCompletion ? 'Saving...' : 'Save Summary'}
                            </button>
                          </div>
                        </form>
                      )}

                    </div>
                  );
                })
              )}
            </div>

          </div>
        </div>

      </div>
    </div>
  );
};

export default CalendarPage;
