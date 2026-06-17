#!/bin/bash
# 自动定位到脚本所在目录，无需硬编码路径
cd "$(dirname "$0")"
pkill -f stress-test-server.js 2>/dev/null
sleep 1
node stress-test-server.js &
sleep 2
echo "压力测试服务器已启动: http://localhost:3457"
echo "PID: $!"
