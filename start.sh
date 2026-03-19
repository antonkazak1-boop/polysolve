#!/bin/bash
# PolySolve — Start Script
# Запускает backend (port 3002) и frontend (port 3006)

set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"

echo ""
echo "██████╗  ██████╗ ██╗  ██╗   ██╗███████╗ ██████╗ ██╗    ██╗   ██╗███████╗"
echo "██╔══██╗██╔═══██╗██║  ╚██╗ ██╔╝██╔════╝██╔═══██╗██║    ██║   ██║██╔════╝"
echo "██████╔╝██║   ██║██║   ╚████╔╝ ███████╗██║   ██║██║    ██║   ██║█████╗  "
echo "██╔═══╝ ██║   ██║██║    ╚██╔╝  ╚════██║██║   ██║██║    ╚██╗ ██╔╝██╔══╝  "
echo "██║     ╚██████╔╝███████╗██║   ███████║╚██████╔╝███████╗╚████╔╝ ███████╗"
echo "╚═╝      ╚═════╝ ╚══════╝╚═╝   ╚══════╝ ╚═════╝ ╚══════╝ ╚═══╝  ╚══════╝"
echo ""
echo "  Polymarket Analytics & Demo Trading Dashboard"
echo ""

# ── Kill ALL existing polysolve/dev processes (zombies from previous sessions) ─
echo "→ Stopping any existing processes..."
# Kill by port
lsof -ti:3002 2>/dev/null | xargs kill -9 2>/dev/null && echo "  Killed port 3002" || true
lsof -ti:3006 2>/dev/null | xargs kill -9 2>/dev/null && echo "  Killed port 3006" || true
# Kill zombie tsx/npm dev processes from polysolve
pkill -f "polysolve.*tsx" 2>/dev/null || true
pkill -f "polysolve.*npm run dev" 2>/dev/null || true
pkill -f "polysolve.*next" 2>/dev/null || true
ZOMBIE_COUNT=$(ps aux | grep -E "tsx watch|npm run dev" | grep polysolve | grep -v grep | wc -l | tr -d ' ')
if [ "$ZOMBIE_COUNT" -gt "0" ]; then
  echo "  Killed $ZOMBIE_COUNT zombie process(es)"
fi
sleep 1

# ── Backend ────────────────────────────────────────────────────────────────────
echo ""
echo "→ Starting backend on http://localhost:3002 ..."
cd "$BACKEND"
npm run dev > /tmp/polysolve-backend.log 2>&1 &
BACKEND_PID=$!
echo "  PID: $BACKEND_PID | Log: /tmp/polysolve-backend.log"

# Wait for backend to be ready
echo "  Waiting for backend..."
for i in $(seq 1 20); do
  if curl -s http://localhost:3002/health > /dev/null 2>&1; then
    echo "  ✓ Backend ready!"
    break
  fi
  if [ $i -eq 20 ]; then
    echo "  ✗ Backend failed to start. Check /tmp/polysolve-backend.log"
    tail -20 /tmp/polysolve-backend.log
    exit 1
  fi
  sleep 1
done

# ── Frontend ───────────────────────────────────────────────────────────────────
echo ""
echo "→ Starting frontend on http://localhost:3006 ..."
cd "$FRONTEND"
npm run dev -- --port 3006 > /tmp/polysolve-frontend.log 2>&1 &
FRONTEND_PID=$!
echo "  PID: $FRONTEND_PID | Log: /tmp/polysolve-frontend.log"

# Wait for frontend to be ready
echo "  Waiting for frontend..."
for i in $(seq 1 30); do
  if curl -s http://localhost:3006 > /dev/null 2>&1; then
    echo "  ✓ Frontend ready!"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "  ✗ Frontend failed to start. Check /tmp/polysolve-frontend.log"
    tail -20 /tmp/polysolve-frontend.log
    exit 1
  fi
  sleep 2
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✓  PolySolve is running!"
echo ""
echo "  Dashboard:       http://localhost:3006/dashboard"
echo "  Portfolio:       http://localhost:3006/portfolio"
echo "  Top 10:          http://localhost:3006/recommendations"
echo "  Anomalies:       http://localhost:3006/anomalies"
echo "  Markets:         http://localhost:3006/events"
echo ""
echo "  Backend API:     http://localhost:3002/api"
echo "  Backend Health:  http://localhost:3002/health"
echo ""
echo "  Logs:"
echo "    Backend:   tail -f /tmp/polysolve-backend.log"
echo "    Frontend:  tail -f /tmp/polysolve-frontend.log"
echo ""
echo "  Press Ctrl+C to stop both servers"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Open browser
sleep 2
open http://localhost:3006/dashboard 2>/dev/null || true

# ── Keep running until Ctrl+C ──────────────────────────────────────────────────
trap "echo ''; echo 'Stopping PolySolve...'; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit 0" INT TERM

wait $BACKEND_PID $FRONTEND_PID
