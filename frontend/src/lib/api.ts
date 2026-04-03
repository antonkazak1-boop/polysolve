import axios from 'axios';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3002';

const api = axios.create({
  baseURL: `${API_URL}/api`,
  timeout: 120_000, // 2 min for heavy DB queries (draft analysis)
});

// Inject auth token into every request
api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('accessToken');
    if (token) config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Auto-refresh on 401
api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config;
    if (error.response?.status === 401 && !original._retry) {
      original._retry = true;
      const refreshed = await tryRefresh();
      if (refreshed) {
        original.headers.Authorization = `Bearer ${localStorage.getItem('accessToken')}`;
        return api(original);
      }
    }
    return Promise.reject(error);
  },
);

export default api;

// --- Token helpers ---

export function setTokens(access: string, refresh: string) {
  localStorage.setItem('accessToken', access);
  localStorage.setItem('refreshToken', refresh);
}

export function clearTokens() {
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
}

export function getRefreshToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('refreshToken');
}

async function tryRefresh(): Promise<boolean> {
  const rt = typeof window !== 'undefined' ? localStorage.getItem('refreshToken') : null;
  if (!rt) return false;
  try {
    const res = await axios.post(`${API_URL}/api/auth/refresh`, { refreshToken: rt });
    setTokens(res.data.accessToken, res.data.refreshToken);
    return true;
  } catch {
    clearTokens();
    return false;
  }
}

// fetch-based helper for auth pages (simpler than axios for login/register)
export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(`${API_URL}${path}`, { ...options, headers });
}
