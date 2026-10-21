#!/usr/bin/env bash
# 重启本地 tigerowo 画布 web(3100)。
# 关键步骤:Next standalone 模式必须把构建产物里的静态资源复制进 standalone 目录,
# 否则页面会以"无样式"(黑白、文字堆叠)的方式渲染——这就是 2026-09-15 踩过的坑。
set -e
cd "$(dirname "$0")/web"

# 停掉现有 3100 进程
PID=$(netstat -ano 2>/dev/null | grep ":3100" | grep LISTENING | head -1 | awk '{print $NF}')
if [ -n "$PID" ]; then
  taskkill //PID "$PID" //F >/dev/null 2>&1 || true
  sleep 1
fi

# 复制静态资源(每次构建后都必须执行)
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public 2>/dev/null || true
cp ../VERSION ../CHANGELOG.md .next/standalone/ 2>/dev/null || true

(PORT=3100 HOSTNAME=127.0.0.1 node .next/standalone/server.js > ../web.log 2>&1 &)
sleep 6
curl -s -o /dev/null -w "3100: HTTP %{http_code}\n" http://127.0.0.1:3100/
