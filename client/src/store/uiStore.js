import { create } from 'zustand';

export const useUiStore = create((set) => ({
  sidebarCollapsed: localStorage.getItem('sidebar_collapsed') === 'true',
  activeVertical: null,
  activeSubVertical: null,
  assignedSubVerticals: [],
  
  toggleSidebar: () => set((state) => {
    const nextVal = !state.sidebarCollapsed;
    localStorage.setItem('sidebar_collapsed', String(nextVal));
    return { sidebarCollapsed: nextVal };
  }),
  
  setSidebarCollapsed: (collapsed) => {
    localStorage.setItem('sidebar_collapsed', String(collapsed));
    set({ sidebarCollapsed: collapsed });
  },

  // Normalize vertical objects: the server returns `id` (PG column name) but the
  // entire client codebase accesses `._id`. Store both so all consumers work.
  setActiveVertical: (vertical) => set({
    activeVertical: vertical
      ? { ...vertical, _id: vertical._id || vertical.id, id: vertical.id || vertical._id }
      : null
  }),
  // Same normalization for sub-verticals which also have `id` from the DB.
  setActiveSubVertical: (subVertical) => set({
    activeSubVertical: subVertical
      ? { ...subVertical, _id: subVertical._id || subVertical.id, id: subVertical.id || subVertical._id }
      : null
  }),
  setAssignedSubVerticals: (assignments) => set({ assignedSubVerticals: assignments }),
  
  leadsRefreshTrigger: 0,
  triggerLeadsRefresh: () => set((state) => ({ leadsRefreshTrigger: state.leadsRefreshTrigger + 1 }))
}));

export default useUiStore;
