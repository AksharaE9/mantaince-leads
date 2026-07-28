import { create } from 'zustand';
import axios, { injectAuthStore } from '../api/axios.js';

let refreshPromise = null;

// Get initial user from localStorage
const getInitialUser = () => {
  try {
    const saved = localStorage.getItem('user');
    return saved ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
};

export const useAuthStore = create((set, get) => ({
  user: getInitialUser(),
  accessToken: null,
  // Refresh token stored in memory only (NOT localStorage) as fallback for
  // environments where HttpOnly cookies are not sent (e.g. Vercel serverless)
  refreshTokenMemory: null,
  isAuthenticated: !!getInitialUser(),
  isInitializing: true,
  loading: false,

  initializeAuth: async () => {
    if (localStorage.getItem('user')) {
      try {
        await get().refreshToken();
      } catch {
        localStorage.removeItem('user');
        set({ user: null, accessToken: null, isAuthenticated: false, refreshTokenMemory: null });
      }
    }
    set({ isInitializing: false });
  },

  login: async (email, password) => {
    set({ loading: true });
    try {
      const response = await axios.post('/api/v1/auth/login', { email, password });
      const { accessToken, refreshToken: newRefreshToken, user } = response.data.data;

      localStorage.setItem('user', JSON.stringify(user));
      set({
        user,
        accessToken,
        refreshTokenMemory: newRefreshToken || null,
        isAuthenticated: true,
        loading: false
      });
      return user;
    } catch (error) {
      set({ loading: false });
      throw new Error(error.response?.data?.error || 'Login failed. Please check your credentials.');
    }
  },

  logout: async () => {
    try {
      await axios.post('/api/v1/auth/logout');
    } catch {
      // Ignore network errors on logout
    } finally {
      localStorage.removeItem('user');
      set({
        user: null,
        accessToken: null,
        refreshTokenMemory: null,
        isAuthenticated: false
      });
    }
  },

  refreshToken: async () => {
    if (refreshPromise) {
      return refreshPromise;
    }

    refreshPromise = (async () => {
      try {
        const currentRefreshToken = get().refreshTokenMemory;
        // Send refresh token in body as fallback when cookie is not forwarded
        const response = await axios.post('/api/v1/auth/refresh', 
          currentRefreshToken ? { refreshToken: currentRefreshToken } : {}
        );
        const { accessToken, refreshToken: newRefreshToken, user } = response.data.data;
        localStorage.setItem('user', JSON.stringify(user));
        set({
          user,
          accessToken,
          refreshTokenMemory: newRefreshToken || null,
          isAuthenticated: true
        });
        return accessToken;
      } catch (error) {
        localStorage.removeItem('user');
        set({
          user: null,
          accessToken: null,
          refreshTokenMemory: null,
          isAuthenticated: false
        });
        throw error;
      } finally {
        refreshPromise = null;
      }
    })();

    return refreshPromise;
  },

  setAccessToken: (token) => set({ accessToken: token }),
  setUser: (user) => {
    if (user) {
      localStorage.setItem('user', JSON.stringify(user));
      set({ user, isAuthenticated: true });
    } else {
      localStorage.removeItem('user');
      set({ user: null, isAuthenticated: false });
    }
  }
}));

injectAuthStore(useAuthStore);

export default useAuthStore;
