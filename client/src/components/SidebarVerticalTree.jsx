/* eslint-disable i18next/no-literal-string */
import React, { useState } from 'react';
import { ChevronRight, ChevronDown, Layers, Settings } from 'lucide-react';
import { Link } from 'react-router-dom';

/**
 * SidebarVerticalTree — light cream theme
 * Renders a collapsible tree of Verticals and their Sub-Verticals.
 * Shows a clean empty state when no verticals exist yet.
 */
const SidebarVerticalTree = ({
  verticals = [],
  subVerticals = {},
  activeVerticalId,
  activeSubVerticalId,
  sidebarCollapsed,
  onAddSubVertical,
  onEditVertical,
  onExpandVertical,
  onSelectVertical,
  onSelectSubVertical,
  loading = false,
}) => {
  const [expandedVerticals, setExpandedVerticals] = useState({});

  const toggle = (id) => {
    if (['__proto__', 'constructor', 'prototype'].includes(id)) return;
    const next = !expandedVerticals[id];
    setExpandedVerticals(prev => ({ ...prev, [id]: next }));
    if (next && onExpandVertical) onExpandVertical(id);
  };

  // ── Loading state skeleton ─────────────────────────────────────────────────
  if (loading) {
    if (sidebarCollapsed) {
      return (
        <div className="flex flex-col items-center gap-2 py-2">
          {[1, 2, 3].map(i => (
            <div
              key={i}
              className="w-8 h-8 rounded-lg animate-pulse"
              style={{ background: 'rgba(180,155,130,0.15)' }}
            />
          ))}
        </div>
      );
    }
    return (
      <div className="space-y-2 px-3 py-2">
        {[1, 2, 3].map(i => (
          <div key={i} className="flex items-center gap-2 animate-pulse">
            <div className="w-2 h-2 rounded-full shrink-0" style={{ background: 'rgba(180,155,130,0.25)' }} />
            <div className="h-3 rounded flex-1" style={{ background: 'rgba(180,155,130,0.18)' }} />
          </div>
        ))}
      </div>
    );
  }

  // ── Collapsed icon strip ──────────────────────────────────────────────────
  if (sidebarCollapsed) {
    if (!verticals.length) return null;
    return (
      <div className="flex flex-col items-center gap-2 py-2">
        {verticals.map(v => (
          <div
            key={v._id}
            title={v.name}
            className="w-8 h-8 rounded-lg flex items-center justify-center transition-all cursor-pointer"
            style={{
              background: activeVerticalId === v._id ? `${v.color}20` : 'rgba(180,155,130,0.10)',
              borderLeft: `3px solid ${v.color || 'var(--accent)'}`,
              color: activeVerticalId === v._id ? v.color : 'var(--text-muted)',
            }}
            onClick={() => {
              if (onSelectVertical) onSelectVertical(v);
            }}
          >
            <Layers size={14} />
          </div>
        ))}
      </div>
    );
  }

  // ── Empty state ───────────────────────────────────────────────────────────
  if (!verticals.length) {
    return (
      <div className="mx-2 mt-1 px-3 py-4 rounded-xl border border-dashed text-center"
        style={{ borderColor: 'var(--border-strong)', background: 'rgba(200,149,108,0.04)' }}>
        <Layers size={18} className="mx-auto mb-2" style={{ color: 'var(--text-muted)' }} />
        <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
          No verticals yet
        </p>
        <Link to="/admin/verticals"
          className="text-[10px] font-bold mt-1.5 inline-block transition-all"
          style={{ color: 'var(--accent)' }}>
          + Create one
        </Link>
      </div>
    );
  }

  // ── Expanded tree ─────────────────────────────────────────────────────────
  return (
    <div className="space-y-0.5 px-2">
      {verticals.map(vert => {
        if (['__proto__', 'constructor', 'prototype'].includes(vert._id)) return null;
        const isExpanded = !!expandedVerticals[vert._id];
        const isActive   = activeVerticalId === vert._id;
        const subs       = subVerticals[vert._id] || [];
        const hasLoaded  = subVerticals[vert._id] !== undefined;

        return (
          <div key={vert._id}>
            {/* Vertical row */}
            <div
              className="group flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer transition-all"
              style={{
                background: isActive ? `${vert.color}15` : 'transparent',
                color: isActive ? vert.color || 'var(--accent)' : 'var(--text-secondary)',
              }}
              onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = 'rgba(180,155,130,0.12)'; }}
              onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
              onClick={() => {
                toggle(vert._id);
                if (onSelectVertical) onSelectVertical(vert);
              }}
            >
              <div className="flex items-center gap-2 overflow-hidden min-w-0">
                <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: vert.color || 'var(--accent)' }} />
                <span className="text-xs font-semibold truncate">{vert.name}</span>
                {hasLoaded && (
                  <span className="text-[9px] shrink-0" style={{ color: 'var(--text-muted)' }}>({subs.length})</span>
                )}
              </div>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all shrink-0">
                <button
                  onClick={e => { e.stopPropagation(); onEditVertical && onEditVertical(vert); }}
                  className="p-1 rounded transition-all"
                  title="Edit vertical"
                  style={{ color: 'var(--text-muted)' }}
                  onMouseEnter={e => e.currentTarget.style.color = 'var(--accent)'}
                  onMouseLeave={e => e.currentTarget.style.color = 'var(--text-muted)'}
                >
                  <Settings size={11} />
                </button>
                {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </div>
            </div>

            {/* Sub-verticals list */}
            <div
              className="overflow-hidden transition-all duration-200"
              style={{ maxHeight: isExpanded ? '400px' : '0', opacity: isExpanded ? 1 : 0 }}
            >
              <div className="pl-5 py-0.5 space-y-0.5 ml-3 border-l"
                style={{ borderColor: 'var(--border)' }}>
                {subs.map(sub => (
                  <button
                    key={sub._id}
                    type="button"
                    onClick={() => onSelectSubVertical && onSelectSubVertical(sub)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs font-medium transition-all text-left"
                    style={{
                      color: activeSubVerticalId === sub._id ? 'var(--accent)' : 'var(--text-secondary)',
                      background: activeSubVerticalId === sub._id ? 'var(--accent-light)' : 'transparent',
                      border: 'none',
                      cursor: 'pointer'
                    }}
                    onMouseEnter={e => { if (activeSubVerticalId !== sub._id) { e.currentTarget.style.background = 'rgba(180,155,130,0.10)'; e.currentTarget.style.color = 'var(--text-primary)'; } }}
                    onMouseLeave={e => { if (activeSubVerticalId !== sub._id) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-secondary)'; } }}
                  >
                    <div className="w-1.5 h-1.5 rounded-full shrink-0"
                      style={{ backgroundColor: activeSubVerticalId === sub._id ? 'var(--accent)' : 'var(--text-muted)' }} />
                    <span className="truncate">{sub.name}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default SidebarVerticalTree;
