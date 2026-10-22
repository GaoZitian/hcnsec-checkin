#!/bin/bash
# hcnsec-daily-checkin.sh - 本地常驻签到脚本
# 每天 09:10 自动执行（需配置 launchd 或 cron）

cd "$(dirname "$0")"

echo "$(date '+%Y-%m-%d %H:%M:%S') - 开始签到..."

# 确保 Node.js 可用
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js 未安装"
    exit 1
fi

# 运行签到脚本（无头模式，但仍保留完整浏览器环境）
node checkin.js 2>&1 | tee checkin-$(date +%Y%m%d-%H%M%S).log

echo "$(date '+%Y-%m-%d %H:%M:%S') - 签到完成"
