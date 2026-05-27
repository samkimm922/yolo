#!/bin/bash
# YOLO 一键启动：progress-server + runner
# 用法: bash scripts/yolo/start.sh [prd.json] [--mode=fix]
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=3456

# 启动 progress-server（如果未运行）
if ! lsof -i :$PORT -t >/dev/null 2>&1; then
  echo "[start] 启动 progress-server (port $PORT)..."
  node "$SCRIPT_DIR/src/runtime/progress/server.mjs" --port=$PORT &
  PS_PID=$!
  sleep 2
  if kill -0 $PS_PID 2>/dev/null; then
    echo "[start] progress-server 已启动 (PID $PS_PID)"
    echo "[start] 看板地址: http://localhost:$PORT"
  else
    echo "[start] ⚠️ progress-server 启动失败，runner 仍可正常运行"
  fi
else
  echo "[start] progress-server 已在运行 (port $PORT)"
fi

# 启动 runner
echo "[start] 启动 runner..."
node "$SCRIPT_DIR/runner.mjs" "$@"
RUNNER_EXIT=$?

# runner 退出后关闭 progress-server（只关本次启动的）
if [ -n "$PS_PID" ] && kill -0 $PS_PID 2>/dev/null; then
  echo "[start] runner 退出，关闭 progress-server..."
  kill $PS_PID 2>/dev/null || true
fi

exit $RUNNER_EXIT
