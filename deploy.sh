#!/bin/bash
# 湘泰物流网站部署（加固版 v3）
# - 显示本次变更内容
# - 先等 API 就绪再同步数据库（带重试）
# - 部署后检查图片文件完整性
# - 构建失败保留旧容器，不中断服务

echo "=== 湘泰物流网站部署 ==="
cd "$(dirname "$0")"

# 1. 检查 .env
if ! grep -q "NEXT_PUBLIC_API_BASE_URL=" .env 2>/dev/null; then
  echo "❌ 缺少 .env 文件或 NEXT_PUBLIC_API_BASE_URL 未设置"
  exit 1
fi
source .env
echo "✅ API 地址: $NEXT_PUBLIC_API_BASE_URL"

# 2. 记录当前版本
OLD_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
echo "📌 当前版本: ${OLD_COMMIT:0:8}"

# 3. 拉代码
echo "📥 拉取最新代码..."
git fetch origin
NEW_COMMIT=$(git rev-parse origin/main)

if [ "$OLD_COMMIT" = "$NEW_COMMIT" ]; then
  echo "✅ 已是最新版本，无需部署"
  exit 0
fi

# 显示变更
echo ""
echo "========== 📋 本次部署包含的变更 =========="
git log --oneline ${OLD_COMMIT}..${NEW_COMMIT} 2>/dev/null || echo "(无法获取)"
echo "=============================================="
echo ""

git reset --hard origin/main

# 4. 检查关键环境变量
echo "🔍 环境检查..."
if ! grep -q "IMAGES_DIR" docker-compose.yml; then
  echo "⚠️  docker-compose.yml 缺少 IMAGES_DIR 环境变量（图片可能无法访问）"
fi
if ! grep -q "127.0.0.1" docker-compose.yml; then
  echo "⚠️  docker-compose.yml healthcheck 仍使用 localhost（可能导致 unhealthy）"
fi

# 5. 修复备份脚本权限
chmod +x scripts/backup-db.sh 2>/dev/null || true

# 6. 安装依赖
npm install --ignore-scripts 2>/dev/null || true

# 7. 确保旧容器在运行（构建期间服务不中断）
echo "🔧 确保旧服务运行中..."
docker compose up -d 2>/dev/null || true

# 8. 构建
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

# 9. 构建成功才切换
if [ "$BUILD_OK" = true ]; then
  echo "✅ 构建成功，切换容器..."
  docker compose up -d
else
  echo "⛔ 构建失败，保留旧容器"
  docker compose up -d
  exit 1
fi

# 10. 等待 API 就绪（最多 60s）
echo "⏳ 等待 API 就绪..."
API_READY=false
for i in $(seq 1 20); do
  if curl -sf http://localhost:3001/ -o /dev/null 2>/dev/null; then
    API_READY=true
    echo "✅ API 已就绪"
    break
  fi
  sleep 3
done

if [ "$API_READY" = false ]; then
  echo "⚠️  API 未就绪，尝试继续执行..."
fi

# 11. 同步数据库 schema（带重试，失败会报错）
echo "🗄️  同步数据库 schema..."
DB_SYNC_OK=false
for i in 1 2 3; do
  echo "  第${i}次尝试..."
  if docker compose exec -T api npx prisma db push --schema=apps/api/prisma/schema.prisma --accept-data-loss 2>&1; then
    DB_SYNC_OK=true
    break
  fi
  sleep 5
done

if [ "$DB_SYNC_OK" = false ]; then
  echo "❌ 数据库同步失败！请手动执行 db push"
else
  echo "✅ 数据库已同步"
  docker compose restart api 2>&1 | tail -1
  sleep 5
fi

# 12. 健康检查
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

# 13. 图片完整性检查
echo "🖼️  图片文件检查..."
IMG_DB=$(docker compose exec -T postgres psql -t -A -U xiangtai -d xiangtai -c "SELECT count(*) FROM order_product_images WHERE file_path IS NOT NULL AND file_path != ''" 2>/dev/null | tr -d ' ' || echo "0")
IMG_DISK=$(docker compose exec -T api ls /images/ 2>/dev/null | wc -l || echo "0")
echo "  数据库记录: $IMG_DB | 磁盘文件: $IMG_DISK"
if [ "$IMG_DB" -gt 0 ] 2>/dev/null && [ "$IMG_DISK" -lt "$IMG_DB" ] 2>/dev/null; then
  echo "⚠️  磁盘文件($IMG_DISK)少于数据库记录($IMG_DB)，图片可能无法显示"
fi

# 14. 重载 nginx
nginx -s reload 2>/dev/null || true

echo ""
echo "=== 部署完成 ==="
echo "📌 新版本: $(git rev-parse --short HEAD)"
