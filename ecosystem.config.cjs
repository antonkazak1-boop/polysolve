/**
 * PM2: backend (Express) + frontend (Next.js)
 * Запуск из корня репозитория: pm2 start ecosystem.config.cjs
 */
const path = require('path');

const root = __dirname;
const backendPort = process.env.BACKEND_PORT || '3002';
const frontendPort = process.env.FRONTEND_PORT || '3006';

module.exports = {
  apps: [
    {
      name: 'polysolve-backend',
      cwd: path.join(root, 'backend'),
      script: 'dist/index.js',
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      min_uptime: '10s',
      env: {
        NODE_ENV: 'production',
        PORT: backendPort,
      },
    },
    {
      name: 'polysolve-frontend',
      cwd: path.join(root, 'frontend'),
      script: 'npm',
      args: 'run start',
      interpreter: 'none',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      min_uptime: '10s',
      env: {
        NODE_ENV: 'production',
        PORT: frontendPort,
      },
    },
  ],
};
