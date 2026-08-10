import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, AlertTriangle, CheckCircle, User, Layers, Calendar, ArrowRight, ShieldAlert, PhoneCall } from 'lucide-react';
import axios from '../api/axios.js';
import Loader from '../components/Loader.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import toast from 'react-hot-toast';

export const SearchLeadPage = () => {
  const [phoneNumber, setPhoneNumber] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState(null);
  const [searchedNum, setSearchedNum] = useState('');
  const navigate = useNavigate();

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!phoneNumber.trim()) {
      toast.error('Please enter a phone number to search.');
      return;
    }

    const sanitized = phoneNumber.replace(/[^\d+]/g, '').trim();
    if (!sanitized) {
      toast.error('Invalid phone number format.');
      return;
    }

    setLoading(true);
    setResults(null);
    setSearchedNum(sanitized);

    try {
      const response = await axios.get(`/api/v1/leads/check-phone?phone=${encodeURIComponent(sanitized)}`);
      setResults(response.data.data || []);
    } catch (err) {
      console.error(err);
      toast.error(err.response?.data?.error || 'Failed to search for lead.');
    } finally {
      setLoading(false);
    }
  };

  const handleAddRedirect = () => {
    navigate(`/leads?openAdd=true&phone=${encodeURIComponent(searchedNum)}`);
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return Number.isNaN(date.getTime()) ? String(dateStr) : date.toLocaleDateString();
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto animate-in fade-in duration-300">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-[--text-primary]">Search Lead</h1>
        <p className="text-sm text-[--text-secondary] mt-1">
          Verify if a lead is already present or contacted in Leadbase using their phone number to prevent duplicates.
        </p>
      </div>

      {/* Search Input Card */}
      <div className="glass-panel p-6 bg-white border border-[--border] shadow-sm">
        <form onSubmit={handleSearch} className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-[--text-muted]" />
            <input
              type="text"
              required
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              placeholder="Enter contact number (e.g. 9876543210)"
              className="pl-10 pr-4 py-2.5 w-full bg-[--bg-input] border border-[--border-strong] rounded-lg focus:outline-none focus:border-[--accent] text-sm"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="px-6 py-2.5 bg-[--accent] hover:bg-[--accent-hover] text-white rounded-lg text-sm font-bold shadow-sm transition-all disabled:opacity-50 flex items-center justify-center gap-2 whitespace-nowrap"
          >
            {loading ? <Loader size="small" /> : <Search size={16} />}
            <span>Search</span>
          </button>
        </form>
      </div>

      {/* Loading State */}
      {loading && (
        <div className="glass-panel p-12 flex justify-center bg-white border border-[--border] shadow-sm">
          <div className="flex flex-col items-center gap-3">
            <Loader />
            <span className="text-xs text-[--text-secondary]">Checking lead database...</span>
          </div>
        </div>
      )}

      {/* Results Section */}
      {!loading && results !== null && (
        <div className="space-y-6">
          {results.length > 0 ? (
            <>
              {/* Warning Alert Banner */}
              <div className="flex items-start gap-3 p-4 bg-amber-500/10 border border-amber-500/30 rounded-xl text-amber-900">
                <AlertTriangle size={20} className="text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <h3 className="text-sm font-bold">Lead already exists in database!</h3>
                  <p className="text-xs text-amber-800 mt-1">
                    A lead record with this phone number <strong>({searchedNum})</strong> is already registered. Please ignore creating a new lead or follow up on the existing record below.
                  </p>
                </div>
              </div>

              {/* Match Details List */}
              <div className="space-y-4">
                <h3 className="text-xs font-bold uppercase tracking-wider text-[--text-secondary]">Registered Lead Matches</h3>
                {results.map((lead) => (
                  <div
                    key={lead.id}
                    className="glass-panel p-5 bg-white border border-[--border] shadow-sm hover:border-[--accent-border] transition-all flex flex-col md:flex-row md:items-center justify-between gap-4"
                  >
                    <div className="space-y-3 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-bold text-sm text-[--text-primary]">
                          {lead.hasAccess ? (lead.business_name || lead.name || 'Unnamed Record') : 'Restricted Lead Details'}
                        </span>
                        <StatusBadge status={lead.status} />
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-black uppercase bg-stone-100 text-stone-600 border border-stone-200">
                          {lead.lead_type || 'CALL'}
                        </span>
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-y-2 gap-x-4 text-xs text-[--text-secondary]">
                        <div className="flex items-center gap-1.5">
                          <Layers size={13} className="text-[--text-muted]" />
                          <span>
                            {lead.vertical_name || 'No Vertical'} 
                            {lead.sub_vertical_name && ` – ${lead.sub_vertical_name}`}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Calendar size={13} className="text-[--text-muted]" />
                          <span>Added {formatDate(lead.created_at)}</span>
                        </div>
                        {lead.hasAccess && (
                          <div className="flex items-center gap-1.5 col-span-2 sm:col-span-1">
                            <User size={13} className="text-[--text-muted]" />
                            <span>Assignee: {lead.assignee_name || 'Unassigned'}</span>
                          </div>
                        )}
                      </div>

                      {!lead.hasAccess && (
                        <div className="flex items-center gap-1.5 text-[10px] text-amber-700 font-semibold bg-amber-500/5 px-2 py-1 rounded border border-amber-500/10 w-fit">
                          <ShieldAlert size={12} />
                          <span>Owner Details Redacted (Exists in a vertical you don't have access to)</span>
                        </div>
                      )}
                    </div>

                    <div className="shrink-0 flex items-center">
                      {lead.hasAccess ? (
                        <button
                          onClick={() => navigate(`/leads/${lead.id}`)}
                          className="w-full md:w-auto inline-flex items-center justify-center gap-1.5 px-4 py-2 border border-[--border-strong] hover:border-[--accent] text-[--text-primary] hover:text-[--accent] rounded-lg text-xs font-bold bg-white transition-all shadow-sm"
                        >
                          <span>View Details</span>
                          <ArrowRight size={13} />
                        </button>
                      ) : (
                        <span className="text-xs text-[--text-muted] font-medium italic">Details Private</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              {/* Success Alert Banner */}
              <div className="flex items-start gap-3 p-4 bg-emerald-500/10 border border-emerald-500/30 rounded-xl text-emerald-900">
                <CheckCircle size={20} className="text-emerald-600 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <h3 className="text-sm font-bold">This lead number is available!</h3>
                  <p className="text-xs text-emerald-800 mt-1">
                    No lead records were found matching phone number <strong>({searchedNum})</strong>. It is safe to register this lead in the system.
                  </p>
                </div>
              </div>

              {/* Call to Action Container */}
              <div className="glass-panel p-8 text-center bg-white border border-[--border] shadow-sm flex flex-col items-center justify-center gap-4">
                <div className="w-12 h-12 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-600">
                  <PhoneCall size={22} />
                </div>
                <div>
                  <h4 className="text-sm font-bold text-[--text-primary]">Proceed to Lead Registration</h4>
                  <p className="text-xs text-[--text-secondary] mt-1 max-w-sm mx-auto">
                    You can register this number as a new lead. Clicking the button below will prepopulate the phone number in the creation form.
                  </p>
                </div>
                <button
                  onClick={handleAddRedirect}
                  className="px-6 py-2 bg-[--accent] hover:bg-[--accent-hover] text-white rounded-lg text-sm font-bold shadow-sm transition-all flex items-center gap-1.5"
                >
                  <span>Add New Lead</span>
                  <ArrowRight size={15} />
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default SearchLeadPage;
