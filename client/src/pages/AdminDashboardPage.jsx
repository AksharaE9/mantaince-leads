/* eslint-disable i18next/no-literal-string */
import React, { useState, useEffect } from 'react';
import axios from '../api/axios.js';
import { useUiStore } from '../store/uiStore.js';
import { 
  BarChart3, Layers, Compass, TrendingUp, Users, CheckCircle2, 
  HelpCircle, ChevronRight, RefreshCw, X, ShieldAlert, Award
} from 'lucide-react';
import toast from 'react-hot-toast';

export const AdminDashboardPage = () => {
  const { leadsRefreshTrigger } = useUiStore();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState([]);
  const [activeVerticalDetails, setActiveVerticalDetails] = useState(null);

  const fetchStats = async () => {
    setLoading(true);
    try {
      const response = await axios.get('/api/v1/admin/dashboard-stats');
      setStats(response.data.data || []);
    } catch (err) {
      toast.error('Failed to load administrative dashboard stats');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
  }, [leadsRefreshTrigger]);

  // General Aggregations
  const totalVerticals = stats.length;
  const totalSubVerticals = stats.reduce((sum, v) => sum + (v.subVerticals?.length || 0), 0);
  const totalLeads = stats.reduce((sum, v) => sum + (v.totalLeads || 0), 0);
  const totalConverted = stats.reduce((sum, v) => sum + (v.convertedLeads || 0), 0);
  const overallConversionRate = totalLeads > 0 ? ((totalConverted / totalLeads) * 100).toFixed(1) : '0.0';

  const getStatusBadgeClass = (status) => {
    switch (status) {
      case 'new': return 'bg-blue-50 text-blue-700 border-blue-100';
      case 'contacted': return 'bg-yellow-50 text-yellow-700 border-yellow-100';
      case 'converted': return 'bg-green-50 text-green-700 border-green-100';
      case 'lost': return 'bg-red-50 text-red-700 border-red-100';
      default: return 'bg-stone-50 text-stone-600 border-stone-200';
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-black text-[--text-primary] uppercase tracking-wider">Admin KPIs Dashboard</h2>
          <p className="text-xs text-[--text-secondary] mt-1">
            Real-time operational overview of business verticals, sub-verticals, and aggregate performance.
          </p>
        </div>
        <button
          onClick={fetchStats}
          className="flex items-center gap-1.5 px-3 py-2 bg-white hover:bg-stone-50 border border-[--border-strong] text-[--text-secondary] font-semibold text-xs rounded-lg transition-all shadow-sm self-start md:self-auto"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          <span>Refresh Stats</span>
        </button>
      </div>

      {/* High Level Stats Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="glass-panel p-5 bg-white border border-[--border] shadow-sm flex items-center gap-4 transition-all hover:translate-y-[-2px] duration-300">
          <div className="w-10 h-10 rounded-xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-600">
            <Layers size={20} />
          </div>
          <div>
            <p className="text-[10px] uppercase font-bold tracking-wider text-[--text-muted]">Business Verticals</p>
            <h3 className="text-xl font-black text-[--text-primary] font-mono leading-tight mt-0.5">{totalVerticals}</h3>
          </div>
        </div>

        <div className="glass-panel p-5 bg-white border border-[--border] shadow-sm flex items-center gap-4 transition-all hover:translate-y-[-2px] duration-300">
          <div className="w-10 h-10 rounded-xl bg-sky-50 border border-sky-100 flex items-center justify-center text-sky-600">
            <Compass size={20} />
          </div>
          <div>
            <p className="text-[10px] uppercase font-bold tracking-wider text-[--text-muted]">Sub-Verticals</p>
            <h3 className="text-xl font-black text-[--text-primary] font-mono leading-tight mt-0.5">{totalSubVerticals}</h3>
          </div>
        </div>

        <div className="glass-panel p-5 bg-white border border-[--border] shadow-sm flex items-center gap-4 transition-all hover:translate-y-[-2px] duration-300">
          <div className="w-10 h-10 rounded-xl bg-amber-50 border border-amber-100 flex items-center justify-center text-amber-600">
            <BarChart3 size={20} />
          </div>
          <div>
            <p className="text-[10px] uppercase font-bold tracking-wider text-[--text-muted]">Total Leads Pool</p>
            <h3 className="text-xl font-black text-[--text-primary] font-mono leading-tight mt-0.5">{totalLeads}</h3>
          </div>
        </div>

        <div className="glass-panel p-5 bg-white border border-[--border] shadow-sm flex items-center gap-4 transition-all hover:translate-y-[-2px] duration-300">
          <div className="w-10 h-10 rounded-xl bg-emerald-50 border border-emerald-100 flex items-center justify-center text-emerald-600">
            <TrendingUp size={20} />
          </div>
          <div>
            <p className="text-[10px] uppercase font-bold tracking-wider text-[--text-muted]">Conversion Rate</p>
            <div className="flex items-baseline gap-1.5 mt-0.5">
              <h3 className="text-xl font-black text-[--text-primary] font-mono leading-tight">{overallConversionRate}%</h3>
              <span className="text-[9px] text-[--text-secondary] font-semibold">({totalConverted} converted)</span>
            </div>
          </div>
        </div>
      </div>

      {loading && stats.length === 0 ? (
        <div className="py-20 flex justify-center items-center">
          <div className="w-8 h-8 border-4 border-[--accent] border-t-transparent rounded-full animate-spin"></div>
        </div>
      ) : stats.length === 0 ? (
        <div className="glass-panel py-16 text-center text-[--text-secondary] border border-[--border]">
          <ShieldAlert className="mx-auto text-amber-500/40 mb-3" size={48} />
          <p className="text-sm font-semibold">No vertical statistics found.</p>
          <p className="text-xs text-[--text-muted] mt-1">Configure verticals in administrative sections to view reports.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {stats.map(v => (
            <div 
              key={v.id} 
              className="glass-panel bg-white border border-[--border] rounded-xl shadow-sm overflow-hidden transition-all duration-300 hover:shadow-md border-t-4"
              style={{ borderTopColor: v.color || 'var(--accent)' }}
            >
              {/* Vertical Details Summary Header */}
              <div className="p-6 border-b border-[--border] bg-stone-50/50 flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: v.color || 'var(--accent)' }} />
                    <h3 className="text-base font-bold text-[--text-primary] uppercase tracking-wide">{v.name}</h3>
                    <span className={`px-2 py-0.5 text-[9px] font-black uppercase rounded-full border ${
                      v.isActive ? 'bg-green-50 text-green-700 border-green-200' : 'bg-stone-100 text-stone-500 border-stone-200'
                    }`}>
                      {v.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[--text-secondary]">
                    <p>Slug: <span className="font-mono">{v.slug}</span></p>
                    {v.lastRefreshedAt && (
                      <p className="flex items-center gap-1 text-[--text-muted]">
                        <span>•</span>
                        <span>As of: {new Date(v.lastRefreshedAt).toLocaleTimeString()}</span>
                      </p>
                    )}
                  </div>
                </div>

                {/* Vertical metrics */}
                <div className="flex flex-wrap items-center gap-6 text-xs text-[--text-secondary]">
                  <div className="space-y-0.5">
                    <span className="block text-[10px] uppercase font-bold text-[--text-muted]">Total Leads</span>
                    <span className="font-mono text-sm font-bold text-[--text-primary]">{v.totalLeads}</span>
                  </div>
                  <div className="space-y-0.5">
                    <span className="block text-[10px] uppercase font-bold text-[--text-muted]">Converted</span>
                    <span className="font-mono text-sm font-bold text-[#2ecc71]">{v.convertedLeads}</span>
                  </div>
                  <div className="space-y-0.5 min-w-[100px]">
                    <span className="block text-[10px] uppercase font-bold text-[--text-muted] mb-1">Conversion Rate</span>
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-[--text-primary]">{v.conversionRate}%</span>
                      <div className="flex-1 bg-stone-200 h-1.5 rounded-full overflow-hidden w-16">
                        <div 
                          className="bg-green-500 h-full transition-all duration-500" 
                          style={{ width: `${v.conversionRate}%` }} 
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Status breakdown widgets */}
              <div className="px-6 py-4 bg-stone-50/20 border-b border-[--border] flex flex-wrap items-center gap-2 text-xs">
                <span className="font-bold text-[--text-secondary] uppercase text-[9px] mr-2">Status Counts:</span>
                {Object.keys(v.statusDistribution).length === 0 ? (
                  <span className="text-[10px] text-[--text-muted]">No lead status tracking recorded</span>
                ) : (
                  Object.entries(v.statusDistribution).map(([status, count]) => (
                    <div 
                      key={status} 
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[10px] font-semibold capitalize ${getStatusBadgeClass(status)}`}
                    >
                      <span>{status.replace(/_/g, ' ')}:</span>
                      <span className="font-bold font-mono">{count}</span>
                    </div>
                  ))
                )}
              </div>

              {/* Sub-verticals Table List */}
              <div className="p-6">
                <h4 className="text-xs font-black text-[--text-primary] uppercase tracking-wider mb-3 flex items-center gap-1.5">
                  <Compass size={14} className="text-[--text-secondary]" />
                  <span>Sub-Vertical Layouts ({v.subVerticals?.length || 0})</span>
                </h4>

                {(!v.subVerticals || v.subVerticals.length === 0) ? (
                  <div className="text-center py-6 border border-dashed border-[--border-strong] rounded-xl text-xs text-[--text-secondary]">
                    No sub-vertical configurations registered under this vertical.
                  </div>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-[--border] shadow-sm">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead>
                        <tr className="border-b border-[--border-strong] bg-stone-50 text-[10px] text-[--text-secondary] font-bold uppercase tracking-wider">
                          <th className="px-4 py-3">Sub-Vertical Name</th>
                          <th className="px-4 py-3">Slug</th>
                          <th className="px-4 py-3">Status</th>
                          <th className="px-4 py-3 text-center">Leads Pool</th>
                          <th className="px-4 py-3 text-center">Converted</th>
                          <th className="px-4 py-3 text-right">Conversion Ratio</th>
                          <th className="px-4 py-3 text-center">Breakdown</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[--border]">
                        {v.subVerticals.map(sub => (
                          <tr key={sub.id} className="hover:bg-stone-50/50 transition-all">
                            <td className="px-4 py-3 font-bold text-[--text-primary] truncate max-w-[180px]">{sub.name}</td>
                            <td className="px-4 py-3 font-mono text-[--text-muted]">{sub.slug}</td>
                            <td className="px-4 py-3">
                              <span className={`px-2 py-0.5 text-[9px] font-black uppercase rounded-full border ${
                                sub.isActive ? 'bg-green-50 text-green-700 border-green-200' : 'bg-stone-100 text-stone-500 border-stone-200'
                              }`}>
                                {sub.isActive ? 'Active' : 'Inactive'}
                              </span>
                            </td>
                            <td className="px-4 py-3 font-mono text-center text-[--text-primary] font-semibold">{sub.totalLeads || 0}</td>
                            <td className="px-4 py-3 font-mono text-center text-green-600 font-semibold">{sub.convertedLeads || 0}</td>
                            <td className="px-4 py-3 text-right">
                              <div className="flex items-center justify-end gap-2 font-mono">
                                <span className="text-[--text-primary] font-bold">{sub.conversionRate.toFixed(1)}%</span>
                                <div className="w-12 bg-stone-100 h-1.5 rounded-full overflow-hidden hidden sm:block">
                                  <div className="bg-green-500 h-full" style={{ width: `${sub.conversionRate}%` }}></div>
                                </div>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-center">
                              <button
                                onClick={() => setActiveVerticalDetails({
                                  verticalName: v.name,
                                  subName: sub.name,
                                  distribution: sub.statusDistribution
                                })}
                                className="px-2.5 py-1 bg-stone-50 hover:bg-stone-100 border border-[--border-strong] rounded text-[9px] font-bold uppercase tracking-wider text-[--text-secondary]"
                              >
                                View Statuses
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Sub-vertical Status Details Modal */}
      {activeVerticalDetails && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 backdrop-blur-sm p-4">
          <div className="glass-panel w-full max-w-sm p-6 bg-white border border-[--border] text-[--text-primary] shadow-xl rounded-xl space-y-4">
            <div className="flex items-center justify-between border-b border-[--border] pb-3">
              <div>
                <h3 className="text-sm font-black uppercase text-[--text-primary] tracking-wide">
                  {activeVerticalDetails.subName}
                </h3>
                <p className="text-[10px] text-[--text-secondary] mt-0.5">
                  Under vertical: <strong>{activeVerticalDetails.verticalName}</strong>
                </p>
              </div>
              <button 
                onClick={() => setActiveVerticalDetails(null)} 
                className="p-1 border border-[--border-strong] rounded text-[--text-secondary] hover:bg-stone-50"
              >
                <X size={14} />
              </button>
            </div>

            <div className="space-y-2">
              <span className="text-[9px] font-bold uppercase tracking-wider text-[--text-muted]">Lead Status Distribution:</span>
              
              {Object.keys(activeVerticalDetails.distribution).length === 0 ? (
                <p className="text-xs text-[--text-secondary] text-center py-4">No leads recorded in this area.</p>
              ) : (
                Object.entries(activeVerticalDetails.distribution).map(([status, count]) => (
                  <div key={status} className="flex justify-between items-center bg-stone-50 px-3 py-2 rounded-lg border border-[--border] text-xs">
                    <span className="capitalize font-semibold text-[--text-secondary]">{status.replace(/_/g, ' ')}</span>
                    <span className="font-bold font-mono text-[--text-primary] bg-white px-2 py-0.5 border border-[--border-strong] rounded">
                      {count}
                    </span>
                  </div>
                ))
              )}
            </div>

            <div className="flex justify-end pt-2 border-t border-[--border]">
              <button
                onClick={() => setActiveVerticalDetails(null)}
                className="px-4 py-1.5 bg-[--accent] hover:bg-[--accent-hover] text-white font-bold rounded-lg text-xs"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AdminDashboardPage;
