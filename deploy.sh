#!/bin/bash
set -e
echo "=== 湘泰物流网站部署 ==="

cd "$(dirname "$0")"

# 1. 检查 .env
if ! grep -q "NEXT_PUBLIC_API_BASE_URL=" .env 2>/dev/null; then
  echo "❌ 缺少 .env 文件或 NEXT_PUBLIC_API_BASE_URL 未设置"
  exit 1
fi
source .env
echo "✅ API 地址: $NEXT_PUBLIC_API_BASE_URL"

# 2. 拉代码
echo "📥 拉取最新代码..."
git fetch origin
git reset --hard origin/main

# 3. 安装依赖
npm install --ignore-scripts 2>/dev/null || true

# 4. 构建并启动
echo "🔨 构建 Docker 镜像..."
docker compose build --no-cache web

echo "🚀 启动服务..."
docker compose up -d

# 5. 等待健康检查（轮询最多 60 秒）
echo "⏳ 等待服务就绪..."

wait_for_service() {
  local url=$1
  local name=$2
  local max_wait=60
  local elapsed=0
  while [ $elapsed -lt $max_wait ]; do
    if curl -sf "$url" -o /dev/null 2>/dev/null; then
      echo "✅ $name 正常"
      return 0
    fi
    sleep 3
    elapsed=$((elapsed + 3))
  done
  echo "⚠️  $name 未响应（等了 ${max_wait}s）"
  return 1
}

wait_for_service "http://localhost:3001" "API"
wait_for_service "http://localhost:3000" "Web"

echo "=== 部署完成 ==="
