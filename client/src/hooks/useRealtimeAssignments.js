import { useEffect, useCallback, useRef } from 'react';
import { useAuthStore } from '../store/authStore.js';
import { useUiStore } from '../store/uiStore.js';
import axios from '../api/axios.js';

// Data-mutation events carry a `verticalId` and are scoped to whichever
// vertical the user is actively viewing — a bulk upload in vertical A must
// not trigger a refetch storm for every user viewing vertical B. The other
// event types below (role/schema/vertical changes) intentionally stay
// unscoped: they can affect what the current user is allowed to see
// regardless of which vertical is on screen.
const VERTICAL_SCOPED_TYPES = new Set([
  'COST_CONVERSION_MUTATED', // COS + Positives & Follow-ups share this table/event
  'RAW_DATA_MUTATED',
  'DELIVERY_DATA_MUTATED',
]);

const UNSCOPED_REFRESH_TYPES = new Set([
  'LEAD_MUTATED',
  'STAGES_UPDATED',
  'FOLLOWUP_CREATED',
  'FOLLOWUP_UPDATED',
  'USER_MUTATED',
  'VERTICAL_MUTATED',
]);

// Coalesce a poll cycle's events into a single refetch instead of one per
// event. Bulk uploads already emit a single event at batch completion
// server-side, so this mainly guards the many-small-edits case.
const REFRESH_DEBOUNCE_MS = 200;

// SSE never actually delivered data on Vercel (the legacy builds/routes
// @vercel/node config buffers the whole function response instead of
// streaming it — confirmed empirically, see assignmentBroadcaster.js).
// Polling is the replacement transport: cheap, robust on any Vercel plan,
// and well within budget at the ~50-concurrent-user target.
// Reduced to 1500ms (1.5s) to guarantee real-time sync responsiveness.
const POLL_INTERVAL_MS = 1500;

export function useRealtimeAssignments() {
  const { user, accessToken } = useAuthStore();
  const { activeVertical, triggerLeadsRefresh } = useUiStore();
  const pollIntervalRef = useRef(null);
  const cursorRef = useRef(null); // null until the baseline poll establishes it
  const activeRef = useRef(false);
  const activeVerticalRef = useRef(activeVertical);
  const refreshDebounceRef = useRef(null);
  const pollInFlightRef = useRef(false);

  useEffect(() => { activeVerticalRef.current = activeVertical; }, [activeVertical]);

  // Defensive helper: server may return { id } while the store/client uses { _id }.
  // Always prefer _id first (set by legacy vertical-selection code) then fall back to id.
  const getActiveVerticalId = useCallback(() => {
    const v = activeVerticalRef.current;
    return v?._id || v?.id || null;
  }, []);

  const debouncedTriggerLeadsRefresh = useCallback(() => {
    clearTimeout(refreshDebounceRef.current);
    refreshDebounceRef.current = setTimeout(triggerLeadsRefresh, REFRESH_DEBOUNCE_MS);
  }, [triggerLeadsRefresh]);

  const poll = useCallback(async () => {
    if (!activeRef.current || pollInFlightRef.current) return;
    pollInFlightRef.current = true;
    try {
      const params = {};
      if (cursorRef.current != null) params.sinceId = cursorRef.current;
      const activeVerticalId = activeVerticalRef.current?._id;
      if (activeVerticalId) params.verticalId = activeVerticalId;

      const res = await axios.get('/api/v1/assignments/poll', { params });
      const { latestId, events } = res.data?.data || {};

      if (typeof latestId === 'number') {
        cursorRef.current = latestId;
      }

      let shouldRefresh = false;
      for (const evt of events || []) {
        if (VERTICAL_SCOPED_TYPES.has(evt.type)) {
          const activeVId = getActiveVerticalId();
          // If the event carries a verticalId, only refresh when it matches the
          // currently active vertical. If either side is missing, we err on the
          // side of refreshing (failsafe) to avoid silently dropping events.
          if (!evt.verticalId || !activeVId || evt.verticalId === activeVId) {
            shouldRefresh = true;
          }
        } else if (UNSCOPED_REFRESH_TYPES.has(evt.type)) {
          shouldRefresh = true;
        }
      }
      if (shouldRefresh) debouncedTriggerLeadsRefresh();
    } catch (error) {
      // Transient network/auth errors: just try again next tick. The axios
      // instance already handles 401 refresh; anything else self-heals on
      // the next poll rather than needing bespoke retry/backoff here.
      console.warn('[Realtime] poll failed, will retry next interval:', error.message);
    } finally {
      pollInFlightRef.current = false;
    }
  }, [debouncedTriggerLeadsRefresh, getActiveVerticalId]);

  useEffect(() => {
    if (!user || !accessToken) {
      activeRef.current = false;
      cursorRef.current = null;
      clearInterval(pollIntervalRef.current);
      return;
    }

    activeRef.current = true;
    poll(); // establish baseline cursor immediately
    pollIntervalRef.current = setInterval(poll, POLL_INTERVAL_MS);

    // Poll immediately on tab focus / network restore, so a backgrounded
    // tab catches up right away instead of waiting for the next tick.
    const handleVisibilityOrOnlineChange = () => {
      if (document.visibilityState === 'visible' || navigator.onLine) {
        poll();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityOrOnlineChange);
    window.addEventListener('online', handleVisibilityOrOnlineChange);

    return () => {
      activeRef.current = false;
      clearInterval(pollIntervalRef.current);
      clearTimeout(refreshDebounceRef.current);
      document.removeEventListener('visibilitychange', handleVisibilityOrOnlineChange);
      window.removeEventListener('online', handleVisibilityOrOnlineChange);
    };
  }, [user, accessToken, poll]);
}
