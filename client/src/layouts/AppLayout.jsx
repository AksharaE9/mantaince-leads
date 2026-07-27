/* eslint-disable i18next/no-literal-string */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Layers, Users, Settings, LogOut, ChevronDown,
  Menu, X, Bell, BarChart3, ChevronRight, FileSpreadsheet, Calendar, ClipboardList, TrendingUp, Terminal,
  Database, Truck,
} from 'lucide-react';
import { useAuthStore } from '../store/authStore.js';
import { useUiStore } from '../store/uiStore.js';
import axios from '../api/axios.js';
import SidebarVerticalTree from '../components/SidebarVerticalTree.jsx';
import { useRealtimeAssignments } from '../hooks/useRealtimeAssignments.js';

export const AppLayout = () => {
  const { user, logout } = useAuthStore();
  const { 
    sidebarCollapsed, toggleSidebar,
    activeVertical, setActiveVertical,
    activeSubVertical, setActiveSubVertical,
    assignedSubVerticals, setAssignedSubVerticals,
    leadsRefreshTrigger
  } = useUiStore();
  
  useRealtimeAssignments();

  const location = useLocation();
  const navigate = useNavigate();

  const [verticals, setVerticals] = useState([]);
  const [subVerticalsMap, setSubVerticalsMap] = useState({});
  const [mobileOpen, setMobileOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [loadingVerticals, setLoadingVerticals] = useState(true);
  const [buildInfo, setBuildInfo] = useState(null);

  useEffect(() => {
    axios.get('/health')
      .then(res => {
        if (res.data?.success) {
          setBuildInfo(res.data.data);
        }
      })
      .catch(() => {});
  }, []);

  // Stable snapshot — read inside effects without making them reactive deps
  const snap = useRef({ activeVertical, activeSubVertical, subVerticalsMap: {}, verticals: [] });
  snap.current.activeVertical    = activeVertical;
  snap.current.activeSubVertical = activeSubVertical;
  snap.current.subVerticalsMap   = subVerticalsMap;
  snap.current.verticals         = verticals;

  // Effect 1: Fetch verticals on mount / role change / realtime refresh trigger
  useEffect(() => {
    let cancelled = false;
    const fetchVerticals = async () => {
      setLoadingVerticals(true);
      try {
        const { data } = await axios.get('/api/v1/verticals');
        if (cancelled) return;
        const list = data.data;
        setVerticals(list);
        const subMap = {};
        list.forEach(v => { if (!['__proto__','constructor','prototype'].includes(v._id)) subMap[v._id] = undefined; });
        setSubVerticalsMap(subMap);

        if (list.length > 0) {
          const savedId = localStorage.getItem('active_vertical_id');
          const cur = snap.current.activeVertical;
          const matched = (cur && list.find(v => v._id === cur._id))
                       || (savedId && list.find(v => v._id === savedId))
                       || list[0];
          if (matched) {
            if (!cur || cur._id !== matched._id) { setActiveVertical(matched); localStorage.setItem('active_vertical_id', matched._id); }
            try {
              const r = await axios.get(`/api/v1/verticals/${matched._id}/sub-verticals`);
              if (!cancelled && !['__proto__','constructor','prototype'].includes(matched._id))
                setSubVerticalsMap(prev => ({ ...prev, [matched._id]: r.data.data }));
            } catch (e) { console.error(e); }
          }
        } else if (snap.current.activeVertical) {
          setActiveVertical(null);
          localStorage.removeItem('active_vertical_id');
        }
      } catch (e) { if (!cancelled) console.error(e); }
      finally { if (!cancelled) setLoadingVerticals(false); }
    };

    fetchVerticals();
    return () => { cancelled = true; };
  }, [user?.role, leadsRefreshTrigger]); // eslint-disable-line react-hooks/exhaustive-deps

  // Effect 2: Sync vertical and sub-vertical from URL — reads snap.current to avoid loops
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const subId = params.get('subVerticalId');
    const vertId = params.get('verticalId');

    if (!subId) {
      if (snap.current.activeSubVertical) setActiveSubVertical(null);
      if (vertId && (!snap.current.activeVertical || snap.current.activeVertical._id !== vertId)) {
        const matchedVert = verticals.find(v => v._id === vertId);
        if (matchedVert) {
          setActiveVertical(matchedVert);
          localStorage.setItem('active_vertical_id', vertId);
        }
      }
      return;
    }



    const { subVerticalsMap: map, verticals: verts } = snap.current;
    let foundSub = null, foundVert = null;
    for (const [vid, subs] of Object.entries(map)) {
      if (!subs) continue;
      const s = subs.find(x => x._id === subId);
      if (s) { foundSub = s; foundVert = verts.find(v => v._id === vid) ?? null; break; }
    }
    if (foundSub) {
      if (!snap.current.activeSubVertical || snap.current.activeSubVertical._id !== foundSub._id) setActiveSubVertical(foundSub);
      if (foundVert && (!snap.current.activeVertical || snap.current.activeVertical._id !== foundVert._id)) setActiveVertical(foundVert);
      return;
    }
    if (verts.length === 0) return;
    (async () => {
      try {
        const { data } = await axios.get(`/api/v1/verticals/sub-verticals/${subId}`);
        const sub = data.data; if (!sub) return;
        const pid = sub.verticalId || sub.vertical_id;
        if (pid && !['__proto__','constructor','prototype'].includes(pid)) {
          const { data: r2 } = await axios.get(`/api/v1/verticals/${pid}/sub-verticals`);
          setSubVerticalsMap(prev => ({ ...prev, [pid]: r2.data }));
        }
        const pv = verts.find(v => v._id === pid);
        if (pv) { setActiveVertical(pv); localStorage.setItem('active_vertical_id', pid); }
        setActiveSubVertical(sub);
      } catch (e) { console.error(e); }
    })();
  }, [location.search, user?.role, assignedSubVerticals, verticals]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchSubVerticalsForVertical = useCallback(async (verticalId) => {
    if (!verticalId || ['__proto__','constructor','prototype'].includes(verticalId)) return;
    try {
      const { data } = await axios.get(`/api/v1/verticals/${verticalId}/sub-verticals`);
      setSubVerticalsMap(prev => ({ ...prev, [verticalId]: data.data }));
    } catch (e) { console.error(e); }
  }, []);

  const handleLogout = () => { logout(); navigate('/login'); };
  const isAdmin = user?.role === 'super_admin' || user?.role === 'vertical_admin';

  const getBreadcrumbs = () => {
    const parts = location.pathname.split('/').filter(Boolean);
    if (!parts.length) return [{ label: 'Dashboard', path: '/' }];
    return parts.map((p, i) => ({
      label: p.charAt(0).toUpperCase() + p.slice(1).replace(/-/g, ' '),
      path: '/' + parts.slice(0, i + 1).join('/')
    }));
  };

  const navLink = (to, Icon, label, exact = false) => {
    const active = exact ? location.pathname === to : location.pathname.startsWith(to);
    return (
      <Link to={to}
        className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
          active ? 'bg-[--accent-light] text-[--accent] font-semibold' : 'text-[--text-secondary] hover:bg-stone-100 hover:text-[--text-primary]'
        }`}>
        <Icon size={17} className={active ? 'text-[--accent]' : ''} />
        {!sidebarCollapsed && <span>{label}</span>}
      </Link>
    );
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden" style={{ background: 'var(--bg-page)', color: 'var(--text-primary)' }}>

      {/* ── Sidebar ── */}
      <aside
        className={`hidden md:flex flex-col h-full transition-all duration-300 border-r`}
        style={{
          width: sidebarCollapsed ? '64px' : '232px',
          background: 'linear-gradient(180deg, #f8f4ee 0%, #f0e8dc 100%)',
          borderColor: 'var(--border)',
        }}
      >
        {/* Logo */}
        <div className="flex items-center gap-3 px-4 py-5 border-b" style={{ borderColor: 'var(--border)' }}>
          <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ background: 'linear-gradient(135deg, var(--accent), #e8a87c)' }}>
            <Layers size={16} className="text-white" />
          </div>
          {!sidebarCollapsed && (
            <div>
              <h1 className="text-sm font-black tracking-wide" style={{ color: 'var(--text-primary)' }}>LeadsBase</h1>
              <p className="text-[9px] uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>CRM Portal</p>
            </div>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-4 px-2 space-y-0.5">
          {navLink('/follow-ups-positives', Calendar, 'Follow-ups/Positives', true)}
          {navLink('/leads', Layers, 'COS', false)}
          {navLink('/raw-data', Database, 'Raw Data', true)}
          {navLink('/delivery-data', Truck, 'Delivery Data', true)}
          {navLink('/calendar', Calendar, 'Calendar', true)}
          {navLink('/follow-ups', ClipboardList, 'Follow-ups', true)}
          {isAdmin && navLink('/reports', BarChart3, 'Reports', true)}

          {isAdmin && (
            <div className="pt-4 mt-3 border-t space-y-0.5" style={{ borderColor: 'var(--border)' }}>
              {!sidebarCollapsed && (
                <p className="px-3 mb-2 text-[9px] uppercase tracking-widest font-bold" style={{ color: 'var(--text-muted)' }}>
                  Administration
                </p>
              )}
              {navLink('/admin/dashboard', TrendingUp, 'Admin Dashboard', true)}
              {navLink('/admin/users', Users, 'User Accounts', true)}
              {navLink('/admin/verticals', Settings, 'Verticals & Fields', false)}
              {navLink('/admin/audit-logs', Terminal, 'Audit Logs', true)}

            </div>
          )}

          <div className="pt-3 mt-2 border-t" style={{ borderColor: 'var(--border)' }}>
            {!sidebarCollapsed && (
              <p className="px-3 mb-2 text-[9px] uppercase tracking-widest font-bold" style={{ color: 'var(--text-muted)' }}>
                Workspace
              </p>
            )}
            <SidebarVerticalTree
              verticals={verticals}
              subVerticals={subVerticalsMap}
              activeVerticalId={activeVertical?._id}
              activeSubVerticalId={activeSubVertical?._id}
              sidebarCollapsed={sidebarCollapsed}
              onEditVertical={isAdmin ? () => navigate('/admin/verticals') : undefined}
              onAddSubVertical={isAdmin ? () => navigate('/admin/verticals') : undefined}
              onExpandVertical={fetchSubVerticalsForVertical}
              onSelectVertical={(vert) => navigate(`/leads?verticalId=${vert._id}`)}
              loading={loadingVerticals}
            />
          </div>
        </nav>

        {/* Version Information */}
        {!sidebarCollapsed && buildInfo && (
          <div className="px-4 py-2 border-t text-[10px] text-center" style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
            v-{buildInfo.commitSha.substring(0, 7)} ({buildInfo.environment})
          </div>
        )}

        {/* Collapse toggle */}
        <div className="p-2 border-t" style={{ borderColor: 'var(--border)' }}>
          <button onClick={toggleSidebar}
            className="hidden md:flex w-full justify-center items-center py-2 rounded-lg transition-all text-sm"
            style={{ color: 'var(--text-muted)' }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(180,155,130,0.15)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
            <ChevronRight size={16} className={`transition-transform ${sidebarCollapsed ? '' : 'rotate-180'}`} />
          </button>
        </div>
      </aside>

      {/* ── Mobile Drawer ── */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 flex md:hidden" style={{ background: 'rgba(45,37,32,0.5)' }}>
          <div className="w-64 h-full flex flex-col border-r p-4"
            style={{ background: 'linear-gradient(180deg, #f8f4ee 0%, #f0e8dc 100%)', borderColor: 'var(--border)' }}>
            <div className="flex justify-between items-center mb-5">
              <span className="font-black text-sm" style={{ color: 'var(--text-primary)' }}>LeadsBase</span>
              <button onClick={() => setMobileOpen(false)} style={{ color: 'var(--text-muted)' }}><X size={18} /></button>
            </div>
            <nav className="flex-1 space-y-0.5 text-sm overflow-y-auto">
              {[
                ['/follow-ups-positives', Calendar, 'Follow-ups/Positives'],
                ['/leads', Layers, 'COS'],
                ['/raw-data', Database, 'Raw Data'],
                ['/delivery-data', Truck, 'Delivery Data'],
                ['/calendar', Calendar, 'Calendar'],
                ['/follow-ups', ClipboardList, 'Follow-ups'],
                isAdmin ? ['/reports', BarChart3, 'Reports'] : null,
              ].filter(Boolean).map(([to, Icon, label]) => (
                <Link key={to} to={to} onClick={() => setMobileOpen(false)}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg font-medium transition-all ${
                    location.pathname.startsWith(to) ? 'bg-[--accent-light] text-[--accent]' : 'text-[--text-secondary] hover:bg-stone-100'
                  }`}>
                  <Icon size={16} /><span>{label}</span>
                </Link>
              ))}

              <div className="pt-4 mt-3 border-t space-y-0.5" style={{ borderColor: 'var(--border)' }}>
                <p className="px-3 mb-2 text-[9px] uppercase tracking-widest font-bold text-[--text-muted]">
                  Workspace
                </p>
                {verticals.map(vert => (
                  <div key={vert._id} className="px-3 py-1">
                    <Link to={`/leads?verticalId=${vert._id}`} onClick={() => setMobileOpen(false)}
                      className={`flex items-center gap-2 text-xs font-semibold ${
                        activeVertical?._id === vert._id ? 'text-[--accent]' : 'text-[--text-secondary]'
                      }`}>
                      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: vert.color || 'var(--accent)' }} />
                      <span>{vert.name}</span>
                    </Link>
                  </div>
                ))}
              </div>

              {isAdmin && (
                <div className="pt-4 mt-3 border-t space-y-0.5" style={{ borderColor: 'var(--border)' }}>
                  <p className="px-3 mb-2 text-[9px] uppercase tracking-widest font-bold text-[--text-muted]">
                    Administration
                  </p>
                  {[
                    ['/admin/dashboard', TrendingUp, 'Admin Dashboard'],
                    ['/admin/users', Users, 'User Accounts'],
                    ['/admin/verticals', Settings, 'Verticals & Fields'],
                    ['/admin/audit-logs', Terminal, 'Audit Logs'],
                  ].map(([to, Icon, label]) => (

                    <Link key={to} to={to} onClick={() => setMobileOpen(false)}
                      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg font-medium transition-all ${
                        location.pathname.startsWith(to) ? 'bg-[--accent-light] text-[--accent]' : 'text-[--text-secondary] hover:bg-stone-100'
                      }`}>
                      <Icon size={16} /><span>{label}</span>
                    </Link>
                  ))}
                </div>
              )}
            </nav>
            <button onClick={handleLogout}
              className="flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-semibold mt-auto transition-all"
              style={{ color: '#c0392b' }}>
              <LogOut size={16} /><span>Sign Out</span>
            </button>
          </div>
        </div>
      )}

      {/* ── Main ── */}
      <div className="flex-1 flex flex-col h-full overflow-hidden">

        {/* Top bar */}
        <header className="flex items-center justify-between px-6 py-3 border-b"
          style={{ background: 'rgba(255,255,255,0.85)', backdropFilter: 'blur(12px)', borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-4">
            <button onClick={() => setMobileOpen(true)} className="md:hidden" data-testid="hamburger-btn" style={{ color: 'var(--text-muted)' }}>
              <Menu size={20} />
            </button>
            {activeSubVertical ? (
              <div className="flex items-center gap-2 text-xs">
                <span className="hidden lg:inline font-semibold" style={{ color: 'var(--text-muted)' }}>Workspace:</span>
                <span className="px-3 py-1 rounded-full text-xs font-bold border animate-pulse-subtle"
                  style={{ background: `${activeVertical?.color}18` || 'var(--accent-light)', color: activeVertical?.color || 'var(--accent)', borderColor: `${activeVertical?.color}30` || 'var(--accent-border)' }}>
                  {activeSubVertical.name}
                </span>
                <span className="font-medium hidden sm:inline" style={{ color: 'var(--text-muted)' }}>({activeVertical?.name})</span>
              </div>
            ) : activeVertical ? (
              <div className="flex items-center gap-2 text-xs">
                <span className="hidden lg:inline font-semibold" style={{ color: 'var(--text-muted)' }}>Workspace:</span>
                <span className="px-3 py-1 rounded-full text-xs font-bold border animate-pulse-subtle"
                  style={{ background: `${activeVertical?.color}18` || 'var(--accent-light)', color: activeVertical?.color || 'var(--accent)', borderColor: `${activeVertical?.color}30` || 'var(--accent-border)' }}>
                  {activeVertical.name}
                </span>
              </div>
            ) : (
              <span className="text-xs px-3 py-1 rounded-full border font-medium"
                style={{ color: 'var(--text-muted)', borderColor: 'var(--border)', background: 'var(--bg-card-hover)' }}>
                Select a workspace from the sidebar
              </span>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button className="relative p-2 rounded-lg transition-all"
              style={{ color: 'var(--text-muted)' }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--accent-light)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
              <Bell size={18} />
            </button>
            <div className="relative">
              <button onClick={() => setProfileOpen(p => !p)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-all"
                style={{ borderColor: 'var(--border)', background: 'var(--bg-card)' }}
                onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--accent-border)'}
                onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}>
                <div className="w-7 h-7 rounded-full flex items-center justify-center font-black text-xs text-white select-none"
                  style={{ background: 'linear-gradient(135deg, var(--accent), #e8a87c)' }}>
                  {user?.name?.slice(0, 2).toUpperCase()}
                </div>
                <div className="hidden md:flex flex-col items-start">
                  <span className="text-xs font-bold leading-none" style={{ color: 'var(--text-primary)' }}>{user?.name}</span>
                  <span className="text-[9px] uppercase font-mono mt-0.5" style={{ color: 'var(--text-muted)' }}>{user?.role?.replace('_', ' ')}</span>
                </div>
                <ChevronDown size={13} style={{ color: 'var(--text-muted)' }} />
              </button>
              {profileOpen && (
                <div className="absolute right-0 mt-2 w-48 glass-panel z-50 py-2 card-elevated">
                  <div className="px-4 py-2 border-b text-xs" style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
                    Signed in as<br /><strong style={{ color: 'var(--text-primary)' }}>{user?.email}</strong>
                  </div>
                  <button onClick={handleLogout}
                    className="flex w-full items-center gap-2 px-4 py-2.5 text-sm font-semibold transition-all"
                    style={{ color: '#c0392b' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(192,57,43,0.07)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                    <LogOut size={14} /><span>Sign Out</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto p-6" style={{ background: 'var(--bg-page)' }}>
          {/* Breadcrumbs */}
          <nav className="flex items-center gap-1.5 text-xs mb-5 font-mono select-none">
            {getBreadcrumbs().map((bc, idx, arr) => (
              <React.Fragment key={bc.path}>
                {idx > 0 && <span style={{ color: 'var(--border-strong)' }}>/</span>}
                {idx === arr.length - 1
                  ? <span className="font-bold" style={{ color: 'var(--text-primary)' }}>{bc.label}</span>
                  : <Link to={bc.path} className="transition-all" style={{ color: 'var(--text-muted)' }}
                      onMouseEnter={e => e.currentTarget.style.color = 'var(--accent)'}
                      onMouseLeave={e => e.currentTarget.style.color = 'var(--text-muted)'}>{bc.label}</Link>}
              </React.Fragment>
            ))}
          </nav>
          <Outlet />
        </main>
      </div>
    </div>
  );
};

export default AppLayout;
