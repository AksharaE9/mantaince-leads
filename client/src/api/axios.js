import axios from 'axios';

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

    // Prevent infinite loop if auth check itself fails
    if (originalRequest.url?.includes('/auth/refresh') || originalRequest.url?.includes('/auth/login')) {
      return Promise.reject(error);
    }

    // Capture token expired code (from Section 11 specifications)
    if (error.response?.status === 401 && !originalRequest._retry) {
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
