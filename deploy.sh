#!/usr/bin/env bash
# PolySolve — деплой на VPS: git pull → install → prisma → build → pm2
# Использование (на сервере, один раз настроить backend/.env):
#   chmod +x deploy.sh && ./deploy.sh
#
# Переменные (опционально):
#   DEPLOY_ROOT=~/polysolve          — каталог репозитория
#   REPO_URL=...                     — если клонируем впервые
#   GIT_BRANCH=main
#   BACKEND_PORT=3002 FRONTEND_PORT=3006
#   NEXT_PUBLIC_API_URL=http://IP:3002      — URL API для браузера (важно при доступе с другого ПК)

set -euo pipefail

DEPLOY_ROOT="${DEPLOY_ROOT:-$HOME/polysolve}"
REPO_URL="${REPO_URL:-https://github.com/antonkazak1-boop/polysolve.git}"
GIT_BRANCH="${GIT_BRANCH:-main}"
BACKEND_PORT="${BACKEND_PORT:-3002}"
FRONTEND_PORT="${FRONTEND_PORT:-3006}"
NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-http://127.0.0.1:${BACKEND_PORT}}"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Нет команды «$1». Установи и повтори." >&2
    exit 1
  }
}

need_cmd git
need_cmd node
need_cmd npm

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
if [[ "${NODE_MAJOR}" -lt 18 ]]; then
  echo "Нужен Node.js 18+ (лучше 20). Сейчас: $(node -v)" >&2
  exit 1
fi

if ! command -v pm2 >/dev/null 2>&1; then
  echo "PM2 не найден. Установи: npm i -g pm2" >&2
  exit 1
fi

if [[ -d "${DEPLOY_ROOT}/.git" ]]; then
  echo "→ git pull (${GIT_BRANCH})"
  cd "${DEPLOY_ROOT}"
  git fetch origin
  git checkout "${GIT_BRANCH}"
  git pull origin "${GIT_BRANCH}"
else
  echo "→ git clone в ${DEPLOY_ROOT}"
  git clone -b "${GIT_BRANCH}" "${REPO_URL}" "${DEPLOY_ROOT}"
  cd "${DEPLOY_ROOT}"
fi

if [[ ! -f "${DEPLOY_ROOT}/backend/.env" ]]; then
  echo "" >&2
  echo "Создай файл backend/.env (шаблон: backend/.env.example)" >&2
  echo "  cp backend/.env.example backend/.env && nano backend/.env" >&2
  exit 1
fi

# CORS / Socket.io: origin фронта (для продакшена подставь свой домен или http://IP:FRONTEND_PORT)
if ! grep -q '^FRONTEND_URL=' "${DEPLOY_ROOT}/backend/.env" 2>/dev/null; then
  echo "FRONTEND_URL=http://127.0.0.1:${FRONTEND_PORT}" >> "${DEPLOY_ROOT}/backend/.env"
  echo "→ Добавлен FRONTEND_URL=http://127.0.0.1:${FRONTEND_PORT} в backend/.env (проверь для внешнего доступа!)"
fi

echo "→ npm ci (корень, workspaces)"
cd "${DEPLOY_ROOT}"
npm ci

echo "→ backend: prisma + build"
cd "${DEPLOY_ROOT}/backend"
export PORT="${BACKEND_PORT}"
npx prisma generate
npx prisma db push --skip-generate
npm run build

echo "→ frontend: build (NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL})"
cd "${DEPLOY_ROOT}/frontend"
export NEXT_PUBLIC_API_URL
npm run build

echo "→ pm2"
cd "${DEPLOY_ROOT}"
export BACKEND_PORT FRONTEND_PORT
pm2 delete polysolve-backend 2>/dev/null || true
pm2 delete polysolve-frontend 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save

echo ""
echo "✓ Готово."
echo "  API:   http://0.0.0.0:${BACKEND_PORT}/health"
echo "  UI:    http://0.0.0.0:${FRONTEND_PORT}/"
echo ""
echo "Полезно один раз на сервере: pm2 startup && pm2 save"
echo "Логи: pm2 logs"
echo "Стоп: ./stop.sh  или  pm2 stop polysolve-backend polysolve-frontend"
