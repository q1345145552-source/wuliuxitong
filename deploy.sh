#!/bin/bash
# 加固版：湘泰物流网站部署
# 特点：先构建再切换，构建失败则保留旧容器，不中断服务

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

# 3. 修复备份脚本权限
chmod +x scripts/backup-db.sh 2>/dev/null || true

# 4. 安装依赖
npm install --ignore-scripts 2>/dev/null || true

# 5. 确保旧容器在运行（构建期间服务不中断）
echo "🔧 确保旧服务运行中..."
docker compose up -d 2>/dev/null || true

# 6. 先尝试增量构建（快），失败再全量（慢）
echo "🔨 构建 Docker 镜像..."
BUILD_OK=false

if docker compose build web api 2>&1; then
  BUILD_OK=true
else
  echo "⚠️  增量构建失败，尝试全量构建..."
  if docker compose build --no-cache web api 2>&1; then
    BUILD_OK=true
  fi
fi

# 7. 构建成功才切换
if [ "$BUILD_OK" = true ]; then
  echo "✅ 构建成功，切换容器..."
  docker compose up -d
else
  echo "⛔ 构建失败，保留旧容器"
  docker compose up -d  # 确保旧容器在跑
fi

# 8. 健康检查（轮询最多 90 秒）
echo "⏳ 等待服务就绪..."

wait_for_service() {
  local url=$1
  local name=$2
  local max_wait=90
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

# 9. 重载 nginx
nginx -s reload 2>/dev/null || true

echo "=== 部署完成 ==="
