#!/usr/bin/env bash
set -euo pipefail
pm2 stop polysolve-backend polysolve-frontend 2>/dev/null || true
echo "Остановлено (pm2 stop). Запуск снова: ./deploy.sh или pm2 start ecosystem.config.cjs"
