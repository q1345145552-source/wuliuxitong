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

# 5. 等待健康检查
echo "⏳ 等待服务就绪..."
sleep 5
if curl -sf http://localhost:3001 -o /dev/null; then
  echo "✅ API 正常"
else
  echo "⚠️  API 端口未响应，检查日志: docker logs mywebsite-api-1"
fi
if curl -sf http://localhost:3000 -o /dev/null; then
  echo "✅ Web 正常"
else
  echo "⚠️  Web 端口未响应"
fi

echo "=== 部署完成 ==="
