import axios from 'axios';

const raw = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3002/api';
// Backend routes are under /api — ensure baseURL ends with /api so paths like /copytrading/wallets resolve
const API_URL = raw.replace(/\/+$/, '').endsWith('/api') ? raw.replace(/\/+$/, '') : `${raw.replace(/\/+$/, '')}/api`;

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 30000, // 30 секунд таймаут для загрузки данных
});

export default api;
