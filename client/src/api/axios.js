import axios from 'axios';
import { isNoResponseError, enrichNoResponseError } from '../utils/networkError.js';

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

let storeRef = {
  getAccessToken: () => null,
  refreshToken: () => Promise.reject(new Error('Auth store not injected')),
  logout: () => {}
};

export const injectAuthStore = (store) => {
  storeRef.getAccessToken = () => store.getState().accessToken;
  storeRef.refreshToken = () => store.getState().refreshToken();
  storeRef.logout = () => store.getState().logout();
};

// Create central Axios instance
const instance = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '', // Vite proxy handles /api routing to localhost:5000 in dev
  timeout: 30000,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json'
  }
});

// Request Interceptor: Attach X-Request-ID and Bearer Authorization tokens
instance.interceptors.request.use(
  (config) => {
    // 1. Attach unique request identifier
    const requestId = Math.random().toString(36).substring(2, 11).toUpperCase();
    config.headers['X-Request-ID'] = requestId;

    // 2. Attach Authorization Bearer token
    const token = storeRef.getAccessToken();
    if (token) {
      config.headers['Authorization'] = `Bearer ${token}`;
    }

    // 3. FormData uploads must not carry the instance's default
    // 'Content-Type: application/json' header — it pre-empts the
    // browser's automatic 'multipart/form-data; boundary=...' header,
    // which silently breaks multer/busboy parsing on the server.
    if (typeof FormData !== 'undefined' && config.data instanceof FormData) {
      delete config.headers['Content-Type'];
    }

    return config;
  },
  (error) => Promise.reject(error)
);

// Response Interceptor: Automatically handles token rotation on 401 expiration
let isRefreshing = false;
let failedQueue = [];

const processQueue = (error, token = null) => {
  failedQueue.forEach((prom) => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve(token);
    }
  });
  failedQueue = [];
};

instance.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    // Request never reached the server at all — network drop, DNS failure,
    // timeout, or a CORS block (the browser withholds everything about a
    // blocked cross-origin response, including whether it was ever sent).
    // axios surfaces this as `error.request` set with no `error.response`,
    // so there is no body for any of this app's ~70 existing
    // `err.response?.data?.error || fallback` / `extractErrorMessage(err, ...)`
    // call sites to read — without this, every one of them silently falls
    // through to a generic hardcoded string with no correlationId, and
    // consumers with their own result-state machine (e.g. CsvImportModal)
    // never transition out of "in progress" at all. This synthesizes a
    // response-shaped payload in the exact convention those call sites
    // already expect, so a specific, correlation-traceable message reaches
    // every one of them with zero per-call-site changes. See
    // client/src/utils/networkError.js for the correlationId + client-side
    // logging + best-effort persisted-report logic.
    if (!error.response && isNoResponseError(error)) {
      enrichNoResponseError(error, API_BASE_URL);
    }

    // Prevent infinite loop if auth check itself fails
    if (originalRequest.url?.includes('/auth/refresh') || originalRequest.url?.includes('/auth/login')) {
      return Promise.reject(error);
    }

    // Capture token expired code (from Section 11 specifications)
    if (error.response?.status === 401) {
      if (originalRequest._retry) {
        // If it was already retried once and still returns 401, redirect to login
        storeRef.logout();
        window.location.href = '/login';
        return Promise.reject(error);
      }

      if (isRefreshing) {
        // Queue original request until token rotates
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        })
          .then((token) => {
            originalRequest.headers['Authorization'] = `Bearer ${token}`;
            return instance(originalRequest);
          })
          .catch((err) => Promise.reject(err));
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        const newToken = await storeRef.refreshToken();
        isRefreshing = false;
        processQueue(null, newToken);

        originalRequest.headers['Authorization'] = `Bearer ${newToken}`;
        return instance(originalRequest);
      } catch (refreshError) {
        isRefreshing = false;
        processQueue(refreshError, null);
        
        // Log out user and redirect to login screen
        storeRef.logout();
        window.location.href = '/login';
        return Promise.reject(error);
      }
    }

    return Promise.reject(error);
  }
);

export default instance;
