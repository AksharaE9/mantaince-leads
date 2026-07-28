import { useEffect, useCallback, useRef } from 'react';
import { useAuthStore } from '../store/authStore.js';
import { useUiStore } from '../store/uiStore.js';
import toast from 'react-hot-toast';
import axios from '../api/axios.js';

// Data-mutation broadcasts carry a `verticalId` and are scoped to whichever
// vertical the user is actively viewing — a bulk upload in vertical A must
// not trigger a refetch storm for every user viewing vertical B. The other
// broadcast types below (role/schema/assignment changes) intentionally stay
// unscoped: they can affect what the current user is allowed to see
// regardless of which vertical is on screen.
const VERTICAL_SCOPED_TYPES = new Set([
  'COST_CONVERSION_MUTATED', // COS + Positives & Follow-ups share this table/event
  'RAW_DATA_MUTATED',
  'DELIVERY_DATA_MUTATED',
]);

// Coalesce bursts of individual mutations (several quick single-adds from
// other users) into one refetch instead of one per message. Bulk uploads
// already emit a single broadcast at batch completion server-side, so this
// mainly guards the many-small-edits case, not large imports.
const REFRESH_DEBOUNCE_MS = 800;

export function useRealtimeAssignments() {
  const { user, accessToken } = useAuthStore();
  const { activeVertical, setAssignedSubVerticals, triggerLeadsRefresh } = useUiStore();
  const esRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const activeRef = useRef(false);
  const activeVerticalRef = useRef(activeVertical);
  const refreshDebounceRef = useRef(null);

  useEffect(() => { activeVerticalRef.current = activeVertical; }, [activeVertical]);

  const debouncedTriggerLeadsRefresh = useCallback(() => {
    clearTimeout(refreshDebounceRef.current);
    refreshDebounceRef.current = setTimeout(triggerLeadsRefresh, REFRESH_DEBOUNCE_MS);
  }, [triggerLeadsRefresh]);

  const handleMessage = useCallback((event) => {
    try {
      const payload = JSON.parse(event.data);

      if (payload.type === 'ASSIGNMENT_UPDATED') {
        if (payload.userId === user?.id) {
          setAssignedSubVerticals(payload.assignments);
          toast.success('Your workspace assignments have been updated.', { icon: '🔄' });
        }
      } else if (VERTICAL_SCOPED_TYPES.has(payload.type)) {
        // Only refetch if this signal is for the vertical currently on
        // screen — everyone else's session ignores it entirely.
        if (payload.verticalId && payload.verticalId === activeVerticalRef.current?._id) {
          debouncedTriggerLeadsRefresh();
        }
      } else if (
        payload.type === 'LEAD_MUTATED' ||
        payload.type === 'STAGES_UPDATED' ||
        payload.type === 'FOLLOWUP_CREATED' ||
        payload.type === 'FOLLOWUP_UPDATED' ||
        payload.type === 'USER_MUTATED' ||
        payload.type === 'ASSIGNMENT_UPDATED' ||
        payload.type === 'VERTICAL_MUTATED'
      ) {
        triggerLeadsRefresh();
      }
    } catch (e) {
      console.error('[SSE] Parse error:', e);
    }
  }, [user?.id, setAssignedSubVerticals, triggerLeadsRefresh, debouncedTriggerLeadsRefresh]);

  const connect = useCallback(async () => {
    if (!activeRef.current) return;
    
    // Clean up existing connection
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    try {
      // 1. Fetch fresh, short-lived SSE ticket
      const ticketRes = await axios.post('/api/v1/assignments/stream/ticket');
      const ticket = ticketRes.data?.ticket;
      if (!ticket) {
        throw new Error('No SSE ticket returned');
      }

      if (!activeRef.current) return;

      // 2. Open EventSource with ticket — include the current vertical (if
      // known yet) so server-side broadcast scoping applies from the first
      // message, not just after the next explicit vertical-change report.
      const apiBase = import.meta.env.VITE_API_URL || '';
      const initialVerticalId = activeVerticalRef.current?._id;
      const verticalParam = initialVerticalId ? `&verticalId=${encodeURIComponent(initialVerticalId)}` : '';
      const streamUrl = `${apiBase}/api/v1/assignments/stream?ticket=${ticket}${verticalParam}`;
      const es = new EventSource(streamUrl, { withCredentials: true });
      esRef.current = es;

      es.addEventListener('message', handleMessage);

      es.onerror = (err) => {
        console.warn('[SSE] Connection error/closed, retrying with new ticket...', err);
        es.close();
        if (esRef.current === es) {
          esRef.current = null;
        }
        // Attempt reconnect with backoff
        if (activeRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = setTimeout(connect, 3000);
        }
      };
    } catch (error) {
      console.error('[SSE] Failed to establish connection:', error);
      // Attempt reconnect with backoff
      if (activeRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = setTimeout(connect, 5000);
      }
    }
  }, [handleMessage]);

  useEffect(() => {
    if (!user || !accessToken) {
      activeRef.current = false;
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      clearTimeout(reconnectTimeoutRef.current);
      return;
    }

    activeRef.current = true;
    connect();

    // Reconnect on online or visibility change (wake up / network restored)
    const handleVisibilityOrOnlineChange = () => {
      if (document.visibilityState === 'visible' || navigator.onLine) {
        console.log('[SSE] Tab visible or browser online; forcing fresh connection...');
        connect();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityOrOnlineChange);
    window.addEventListener('online', handleVisibilityOrOnlineChange);

    return () => {
      activeRef.current = false;
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      clearTimeout(reconnectTimeoutRef.current);
      document.removeEventListener('visibilitychange', handleVisibilityOrOnlineChange);
      window.removeEventListener('online', handleVisibilityOrOnlineChange);
    };
  }, [user, accessToken, connect]);

  // Report vertical switches to the server so it can keep scoping broadcasts
  // to this connection correctly without a full SSE reconnect (see
  // updateStreamVertical / updateClientVertical). Best-effort — if this call
  // fails or races, the client-side vertical check in handleMessage still
  // guarantees correctness, just with a little less server-side efficiency.
  useEffect(() => {
    if (!user || !accessToken || !activeVertical?._id) return;
    axios.post('/api/v1/assignments/stream/vertical', { verticalId: activeVertical._id }).catch(() => {});
  }, [user, accessToken, activeVertical?._id]);
}
