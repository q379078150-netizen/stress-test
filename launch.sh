#!/bin/bash
set -e

# 自动定位到脚本所在目录，无需硬编码路径
cd "$(dirname "$0")"

pkill -f stress-test-server.js 2>/dev/null || true
sleep 1

LOG_FILE="${TMPDIR:-/tmp}/stress-test-server.log"
node stress-test-server.js >"$LOG_FILE" 2>&1 &
PID=$!
sleep 2

if ! kill -0 "$PID" 2>/dev/null; then
  echo "压力测试服务器启动失败，请查看日志: $LOG_FILE"
  tail -n 80 "$LOG_FILE" 2>/dev/null || true
  exit 1
fi

echo "压力测试服务器已启动: http://localhost:3457"
echo "PID: $PID"
echo "日志: $LOG_FILE"
