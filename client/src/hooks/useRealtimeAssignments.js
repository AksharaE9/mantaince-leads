import { useEffect, useCallback, useRef } from 'react';
import { useAuthStore } from '../store/authStore.js';
import { useUiStore } from '../store/uiStore.js';
import toast from 'react-hot-toast';
import axios from '../api/axios.js';

export function useRealtimeAssignments() {
  const { user, accessToken } = useAuthStore();
  const { setAssignedSubVerticals, triggerLeadsRefresh } = useUiStore();
  const esRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const activeRef = useRef(false);

  const handleMessage = useCallback((event) => {
    try {
      const payload = JSON.parse(event.data);

      if (payload.type === 'ASSIGNMENT_UPDATED') {
        if (payload.userId === user?.id) {
          setAssignedSubVerticals(payload.assignments);
          toast.success('Your workspace assignments have been updated.', { icon: '🔄' });
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
  }, [user?.id, setAssignedSubVerticals, triggerLeadsRefresh]);

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

      // 2. Open EventSource with ticket
      const apiBase = import.meta.env.VITE_API_URL || '';
      const streamUrl = `${apiBase}/api/v1/assignments/stream?ticket=${ticket}`;
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
}
