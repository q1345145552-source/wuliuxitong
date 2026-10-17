#!/bin/bash
# 湘泰物流网站部署（加固版 v3）
# - 显示本次变更内容
# - 先等 API 就绪再同步数据库（带重试）
# - 部署后检查图片文件完整性
# - 构建失败保留旧容器，不中断服务

# 先复制一份自己，用副本跑。
#
# 这个脚本跑到一半会 `git reset --hard`。如果这次部署的内容恰好也改了 deploy.sh 自己，
# 文件就在脚本还没跑完的时候被换掉了 —— bash 是按「读到第几个字节」往下读的，
# 会接着从新文件的那个位置继续读，执行出半截乱码命令（本地实测确认会）。
# 用副本跑，原文件怎么变都不影响正在跑的这一次。
if [ -z "$DEPLOY_SRC_DIR" ]; then
  export DEPLOY_SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
  SELF_COPY="$(mktemp /tmp/deploy-running-XXXXXX.sh)" || { echo "❌ 无法创建临时文件"; exit 1; }
  cp "$0" "$SELF_COPY" || { echo "❌ 复制部署脚本失败"; rm -f "$SELF_COPY"; exit 1; }
  bash "$SELF_COPY" "$@"
  DEPLOY_RC=$?
  rm -f "$SELF_COPY"
  exit $DEPLOY_RC
fi

echo "=== 湘泰物流网站部署 ==="
cd "$DEPLOY_SRC_DIR" || exit 1

# 收集本次部署出现的问题。
# 原来每一步出问题都只是打一行警告，然后照样往下走、最后照样显示「部署完成」——
# 不盯着屏幕看根本发现不了。现在统一记下来，结尾一次性摊开，并用退出码区分成败。
DEPLOY_ISSUES=()
note_issue() {
  DEPLOY_ISSUES+=("$1")
  echo "⚠️  $1"
}

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

# 2026-08-07：只比对提交号会漏掉「代码拉下来了但没构建完」的半截状态 ——
# 上一次部署中途断掉后，git 已经指向新提交，再跑这个脚本却直接说
# 「已是最新，无需部署」，容器永远停在旧版本，靠脚本自己补不回来。
# 加一个强制开关：FORCE_DEPLOY=1 bash deploy.sh 可以重跑一遍完整流程。
if [ "$OLD_COMMIT" = "$NEW_COMMIT" ] && [ "${FORCE_DEPLOY:-}" != "1" ]; then
  echo "✅ 已是最新版本，无需部署"
  echo "   如果上次部署中断、容器还是旧版本，用这个强制重跑："
  echo "   FORCE_DEPLOY=1 bash deploy.sh"
  exit 0
fi

if [ "$OLD_COMMIT" = "$NEW_COMMIT" ]; then
  echo "⚠️  代码已是最新，但按 FORCE_DEPLOY=1 强制重新构建部署"
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
  note_issue "docker-compose.yml 缺少 IMAGES_DIR 环境变量（图片可能无法访问）"
fi
if ! grep -q "127.0.0.1" docker-compose.yml; then
  note_issue "docker-compose.yml healthcheck 仍使用 localhost（可能导致 unhealthy）"
fi

# 5. 修复备份脚本权限
chmod +x scripts/backup-db.sh 2>/dev/null || true

# 6. 安装依赖
npm install --ignore-scripts 2>/dev/null || true

# 7. 确保旧容器在运行（构建期间服务不中断）
# ⚠️ 下面几处「保留旧容器」一律带 --no-recreate（2026-10-18 全系统审查第一档第 4 条，本机 compose 实测过）：
# 光写 `docker compose up -d`，只要镜像标签已经指向新构建的镜像（这次刚 build 完、或者上一次部署 build 了却没切上去），
# compose 就会按新镜像把容器**重建**——嘴上说「旧版本继续服务」，实际把新代码换上去了，新代码跑在没迁移的旧表结构上。
# --no-recreate：容器在就不动（停着的照样拉起来），只有容器根本不存在时才新建。
echo "🔧 确保旧服务运行中..."
docker compose up -d --no-recreate 2>/dev/null || true

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

# ⚠️ 构建失败就到此为止，**别再往下走**（2026-08-24 从第 10 节挪上来）。
#
# 这道闸原来放在第 10 节「切容器」前面。拦是拦住了，但下面第 9 节
# 会先去连数据库、可能还备份一次、跑一遍迁移 —— 而新代码根本切不上去，
# 那趟纯属白跑，还平白碰了一次生产库。构建都失败了，数据库一个字都不该动。
if [ "$BUILD_OK" != true ]; then
  echo "⛔ 构建失败，保留旧容器，数据库不做任何改动"
  # 两个服务可能有一个已经构建成功，不带 --no-recreate 会把它单独换成新的（前后端版本对不上）
  docker compose up -d --no-recreate
  exit 1
fi

# ============================================================================
# 9. 先把数据库准备好，再切新容器（2026-08-22 调整顺序）
# ============================================================================
#
# 原来的顺序是【先切容器 → 再改数据库】，中间有个窗口：新代码已经在服务客户，
# 数据库却还是旧结构。新代码只要用到新字段，那段时间**读也读不了、写也写不了**。
#
# ⚠️ 这不是纸上谈兵，2026-08-16 上线「集货货型」时真出现过：
#   08:19:56 新容器起来 → 08:20:13 迁移才跑完，中间 17 秒。
#   那 17 秒里，只要有人打开集货页面就会报错（Prisma 读表时会点名要 cargo_type 这一列，
#   数据库里还没有 → 直接失败）。当天翻日志确认 0 条报错 —— 纯属运气：
#   窗口短 + 集货是冷门功能。要是改的是运单表，那 17 秒整个系统都在报错。
#
# 现在改成【备份 → 迁移 → 切容器】，数据库永远先准备好。
#
# ⚠️ 这么排的前提：**迁移必须是「只加不删」的**。
#   迁移期间跑的是**旧代码 + 新结构**，加字段旧代码不受影响（它不认识就不读）；
#   但删字段/改字段名会让旧代码当场崩。
#   红线 2.1 本来就禁止删字段（`db push` 就是因为这个被换掉的），所以这个前提成立。
#   哪天真要删字段，必须拆成两次上线：先上不再用该字段的代码，下次再删。
#
# ⚠️ 迁移用 `docker compose run --rm` 起一次性容器跑，**用的是刚构建好的新镜像**，
#   同时**不动正在服务客户的旧容器**。不能用 `exec`：那是钻进旧容器里跑旧代码，
#   拿到的迁移文件清单也是旧的。
#
# 9a. 这次部署到底要不要动数据库？
#
# 绝大多数部署只改代码、根本不碰数据库结构，那次备份（约 9 秒 + 130MB 磁盘）是白花的。
# 所以先问一句 Prisma：还有没有没执行的迁移文件？
#   没有 → 跳过备份，也跳过迁移，直接进健康检查
#   有   → 老老实实备份再动，改结构出意外时那是唯一的退路
#
# 注意这里故意「问不出来就当作要动」：API 没起来、命令报错等情况一律走备份那条路。
# 宁可白备一次，也不能在该备的时候没备。
echo "🔍 检查这次部署要不要动数据库..."
NEED_DB_WORK=true
MIGRATE_STATUS=$(docker compose run --rm -T api npx prisma migrate status --schema=apps/api/prisma/schema.prisma 2>&1)
if echo "$MIGRATE_STATUS" | grep -q "Database schema is up to date"; then
  NEED_DB_WORK=false
  echo "✅ 没有待执行的迁移，这次不动数据库（跳过备份，省下约 9 秒和 130MB）"
else
  echo "📋 有待执行的迁移，这次要改数据库结构："
  echo "$MIGRATE_STATUS" | grep -iE "have not yet been applied|migration.*found|^  " | head -8
fi

# 9b. 要动数据库才备份
BACKUP_OK=false
if [ "$NEED_DB_WORK" = false ]; then
  BACKUP_OK=true   # 不动数据库，不需要退路
else
  echo "💾 改结构前备份数据库..."
  # 用 $DEPLOY_SRC_DIR 而不是 $(dirname "$0")：
  # 脚本是复制到 /tmp 跑的（见开头的自我复制保护），$0 指向 /tmp，
  # dirname 出来就是 /tmp，找不到 scripts/backup-db.sh。
  # 2026-08-02 部署时踩过这个坑：备份失败 → 连带跳过了数据库迁移。
  if BACKUP_LABEL="predeploy_$(date +%Y%m%d_%H%M%S)" bash "$DEPLOY_SRC_DIR/scripts/backup-db.sh"; then
    BACKUP_OK=true
  else
    note_issue "数据库备份失败 —— 已跳过数据库迁移"
  fi
fi

# 9c. 执行迁移文件（原来这里是 `prisma db push --accept-data-loss`）
#
# 为什么换掉 db push：它的职责是让数据库和 schema.prisma 长得一模一样 ——
# 设计图里没有的字段会被删掉；改字段名在它眼里是「删旧的、加一个新的空的」，
# 那一列数据全没。2026-07-31 部署时它真的删过一个带数据的字段。
# migrate deploy 只执行 apps/api/prisma/migrations/ 下写好的迁移文件，不自作主张，
# 也不会因为设计图里少写了什么就去删东西。
DB_SYNC_OK=false
if [ "$NEED_DB_WORK" = false ]; then
  DB_SYNC_OK=true
  echo "⏭️  跳过数据库迁移（没有待执行的迁移）"
elif [ "$BACKUP_OK" = false ]; then
  echo ""
  echo "⛔ 跳过数据库迁移 —— 因为备份没成功，此时改结构一旦出问题无法回退。"
  echo "   请先修好备份，再手动执行迁移。服务本身不受影响，代码已经上线。"
  echo ""
else
echo "🗄️  执行数据库迁移..."
for i in 1 2 3; do
  echo "  第${i}次尝试..."
  if docker compose run --rm -T api npx prisma migrate deploy --schema=apps/api/prisma/schema.prisma 2>&1; then
    DB_SYNC_OK=true
    break
  fi
  sleep 5
done
fi

if [ "$BACKUP_OK" = true ] && [ "$DB_SYNC_OK" = false ]; then
  note_issue "数据库迁移失败 —— 如果是某个迁移文件执行到一半失败，它会挡住以后所有迁移，必须先处理（先看上面的报错，再跑 prisma migrate status 确认）"
elif [ "$NEED_DB_WORK" = true ] && [ "$DB_SYNC_OK" = true ]; then
  # 只有真的改过结构才重启 API 让它重新认识数据库。
  # 没改结构还重启，纯粹是多一次没必要的服务中断。
  echo "✅ 数据库迁移完成"
fi

# 9d. 数据库结构体检（纯只读，一个字都不改）
#
# ⚠️ 2026-08-22 从「切容器之后」挪到了「切容器之前」。
# 放在后面等于白检：等发现少字段时，新代码已经在服务客户了。
#
# 换成 migrate deploy 之后，就没有「谁改了设计图但忘了写迁移文件、db push 也能自动补上」
# 这个兜底了。所以每次部署都得体检一遍：设计图有、数据库没有的字段会被列出来。
# 不体检的话，缺字段要等客户点开页面弹「服务器繁忙」才发现（集货拼柜那次就是）。
echo "🔍 数据库结构体检..."
if [ ! -f scripts/check-schema-drift.sql ]; then
  note_issue "找不到 scripts/check-schema-drift.sql，这次没做结构体检"
else
  DRIFT_RAW=$(docker compose exec -T postgres sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -t -A -q -v ON_ERROR_STOP=1' < scripts/check-schema-drift.sql 2>&1)
  DRIFT_RC=$?
  if [ $DRIFT_RC -ne 0 ]; then
    echo "$DRIFT_RAW"
    note_issue "结构体检没跑起来（上面是原始输出）—— 这次部署没检查数据库结构"
  else
    DRIFT=$(echo "$DRIFT_RAW" | grep -v '^[[:space:]]*$')
    if [ -n "$DRIFT" ]; then
      echo "$DRIFT"
      DRIFT_COUNT=$(echo "$DRIFT" | wc -l | tr -d ' ')
      # 「A 缺失」= 数据库少字段 → 新代码一上去相关页面就报错，必须拦住部署。
      # 「B 多余」= 数据库多字段 → 不影响使用，只提醒。
      if echo "$DRIFT" | grep -q "^A"; then
        echo ""
        echo "⛔ 数据库缺少设计图里的字段（上面以 A 开头的几行），**不切换新容器**。"
        echo "   新代码用到这些字段时会直接报错。请补一个迁移文件再重跑部署。"
        echo ""
        docker compose up -d --no-recreate   # 旧容器继续服务（不带 --no-recreate 会按刚构建的新镜像重建，见第 7 节）
        exit 1
      fi
      note_issue "数据库结构与设计图有 ${DRIFT_COUNT} 处对不上（见上面几行）：均为「B 多余」，不影响使用"
    else
      echo "✅ 结构与设计图一致"
    fi
  fi
fi

# ============================================================================
# 10. 数据库就绪之后，才切新容器
# ============================================================================
#
# ⚠️⚠️ 这道闸是整个「先改库、后换代码」顺序的关键。
# 2026-08-22 第一版把备份/迁移提到了前面，**但切容器时只检查了 BUILD_OK** ——
# 迁移失败时只记一条警告就照样把新代码切上去，新代码跑在旧结构上，
# 跟调整顺序的初衷正好相反。这里必须把数据库的结果也作为切换前提。
#
# 判断口径：
#   - 这次不用动数据库（NEED_DB_WORK=false）→ 无条件放行
#   - 要动数据库 → 备份和迁移都必须成功，否则保留旧容器、直接退出
if [ "$NEED_DB_WORK" = true ] && { [ "$BACKUP_OK" != true ] || [ "$DB_SYNC_OK" != true ]; }; then
  echo ""
  echo "⛔ 数据库没准备好，**不切换新容器**，旧版本继续服务客户。"
  [ "$BACKUP_OK" != true ] && echo "   原因：改结构前的备份没成功"
  [ "$DB_SYNC_OK" != true ] && echo "   原因：数据库迁移没成功"
  echo "   新代码需要新字段，此时切上去会让相关页面直接报错。"
  echo "   请先解决上面的问题再重跑部署。代码已经拉到本地，服务本身不受影响。"
  echo ""
  docker compose up -d --no-recreate   # 确保旧容器还在跑（不带 --no-recreate 会按刚构建的新镜像重建，见第 7 节）
  exit 1
fi

echo "✅ 构建成功、数据库就绪，切换容器..."
docker compose up -d

# 11. 等待 API 就绪（最多 60s）
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
  note_issue "API 在 60 秒内没就绪，后续步骤可能不准"
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
  echo "❌ $name 未响应（等了 ${max_wait}s）"
  return 1
}

wait_for_service "http://localhost:3001" "API" || note_issue "API 健康检查未通过 —— 后台可能不可用"
wait_for_service "http://localhost:3000" "Web" || note_issue "Web 健康检查未通过 —— 前台可能打不开"

# 上面两个只证明「进程活着、端口通了」——它们**都不碰数据库**。
# 数据库连不上、结构对不上，这两项照样全绿（2026-08-22 加这一段的原因）。
# 所以再补一刀：让新容器用 Prisma 真去连一次数据库。
# 用 migrate status 是因为它既要连库、又要读迁移账本，一次同时验证「连得上」和「结构对得上」。
echo "🔌 验证新容器真的能连上数据库..."
DB_PROBE=$(docker compose exec -T api npx prisma migrate status --schema=apps/api/prisma/schema.prisma 2>&1)
if echo "$DB_PROBE" | grep -q "Database schema is up to date"; then
  echo "✅ 数据库连得上，结构与迁移账本一致"
else
  echo "$DB_PROBE" | tail -5
  note_issue "新容器连数据库或对账失败（上面是原始输出）—— 页面可能大面积报错，先看这条再说别的"
fi

# 13. 图片完整性检查
echo "🖼️  图片文件检查..."
IMG_DB=$(docker compose exec -T postgres psql -t -A -U xiangtai -d xiangtai -c "SELECT count(*) FROM order_product_images WHERE file_path IS NOT NULL AND file_path != ''" 2>/dev/null | tr -d ' ' || echo "0")
IMG_DISK=$(docker compose exec -T api ls /images/ 2>/dev/null | wc -l | tr -d ' ' || echo "0")
echo "  数据库记录: $IMG_DB | 磁盘文件: $IMG_DISK"
if [ "$IMG_DB" -gt 0 ] 2>/dev/null && [ "$IMG_DISK" -lt "$IMG_DB" ] 2>/dev/null; then
  note_issue "磁盘图片($IMG_DISK)少于数据库记录($IMG_DB)，部分图片可能显示不出来"
fi

# 14. 重载 nginx
nginx -s reload 2>/dev/null || true

echo ""
echo "=============================================="
if [ ${#DEPLOY_ISSUES[@]} -eq 0 ]; then
  echo "=== ✅ 部署完成，一切正常 ==="
  echo "📌 新版本: $(git rev-parse --short HEAD)"
  echo "=============================================="
  exit 0
fi

# 走到这里说明中途有问题。原来这些问题只在过程中一闪而过，
# 结尾照样显示「部署完成」，很容易被当成成功。
echo "=== ⚠️  部署完成，但有 ${#DEPLOY_ISSUES[@]} 处问题需要处理 ==="
echo ""
i=1
for issue in "${DEPLOY_ISSUES[@]}"; do
  echo "  $i) $issue"
  i=$((i + 1))
done
echo ""
echo "📌 新版本: $(git rev-parse --short HEAD)"
echo "📌 上一版: ${OLD_COMMIT:0:8}"
echo ""
echo "需要回滚到上一版的话："
echo "  cd $(pwd) && git reset --hard ${OLD_COMMIT} && docker compose up -d --build"
echo ""
echo "数据库备份在 /root/db-backups/（本次的文件名以 predeploy_ 开头）"
echo "=============================================="
exit 1
