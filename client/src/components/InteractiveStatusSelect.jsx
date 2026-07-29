import React, { useState, useEffect } from 'react';
import axios from '../api/axios.js';
import toast from 'react-hot-toast';

export const InteractiveStatusSelect = ({ leadId, currentStatus, statusOptions, onStatusUpdated }) => {
  const [status, setStatus] = useState(currentStatus || 'new');
  const [updating, setUpdating] = useState(false);

  // Sync state if prop changes (e.g. from bulk update)
  useEffect(() => {
    setStatus(currentStatus || 'new');
  }, [currentStatus]);

  const getStyles = (val) => {
    switch (val?.toLowerCase()) {
      case 'new':
        return 'bg-blue-500/10 text-blue-400 border border-blue-500/20';
      case 'contacted':
        return 'bg-amber-500/10 text-amber-400 border border-amber-500/20';
      case 'qualified':
        return 'bg-cyan-500/10 text-cyan-300 border border-cyan-500/20';
      case 'visit_scheduled':
        return 'bg-violet-500/10 text-violet-300 border border-violet-500/20';
      case 'visit_completed':
        return 'bg-indigo-500/10 text-indigo-300 border border-indigo-500/20';
      case 'negotiation':
        return 'bg-orange-500/10 text-orange-300 border border-orange-500/20';
      case 'converted':
        return 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
      case 'lost':
        return 'bg-rose-500/10 text-rose-400 border border-rose-500/20';
      case 'invalid':
      default:
        return 'bg-zinc-500/10 text-zinc-400 border border-zinc-500/20';
    }
  };

  const handleChange = async (e) => {
    const nextStatus = e.target.value;
    setStatus(nextStatus);
    setUpdating(true);
    try {
      await axios.patch(`/api/v1/leads/${leadId}/status`, { status: nextStatus });
      toast.success('Lead status updated.');
      onStatusUpdated?.(leadId, nextStatus);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update status.');
      setStatus(currentStatus); // revert
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div className="relative inline-block" onClick={(e) => e.stopPropagation()}>
      <select
        value={status}
        onChange={handleChange}
        disabled={updating}
        className={`appearance-none inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold tracking-wide uppercase select-none cursor-pointer outline-none transition-all pr-6 ${getStyles(status)} ${updating ? 'opacity-50 cursor-wait' : ''}`}
        style={{
          backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'></polyline></svg>")`,
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'right 6px center',
          backgroundSize: '12px',
        }}
      >
        {statusOptions.map((opt) => (
          <option
            key={opt.value}
            value={opt.value}
            className="bg-stone-900 text-white uppercase font-bold"
          >
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
};

export default InteractiveStatusSelect;
