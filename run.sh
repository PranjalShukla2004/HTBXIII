#!/usr/bin/env bash
# Start the webagent backend (FastAPI on :8000) and frontend (Vite on :5173) together.
# Ctrl+C stops both.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"

# First run on a fresh clone: install dependencies.
if [[ ! -d "$ROOT/frontend/node_modules" ]]; then
  echo "Installing frontend dependencies..."
  (cd "$ROOT/frontend" && npm install)
fi
(cd "$ROOT/backend/api" && uv sync --quiet)

pids=()
cleanup() {
  echo -e "\nStopping..."
  for pid in "${pids[@]}"; do
    kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  echo "Stopped."
}
trap cleanup INT TERM EXIT

# Each server runs in its own process group so Ctrl+C takes down its children too.
setsid bash -c "cd '$ROOT/backend/api' && exec uv run python serve.py" \
  > >(sed -u 's/^/[api] /') 2>&1 &
pids+=($!)

setsid bash -c "cd '$ROOT/frontend' && exec npm run dev" \
  > >(sed -u 's/^/[web] /') 2>&1 &
pids+=($!)

echo "Backend:  http://localhost:8000   (API docs: http://localhost:8000/docs)"
echo "Frontend: http://localhost:5173"
echo "Press Ctrl+C to stop both."
wait -n "${pids[@]}"     # if either server dies, stop the other one too
