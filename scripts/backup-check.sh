#!/usr/bin/env bash
# 湘泰物流系统 — 备份检查 + 自动修复
# 用法：bash scripts/backup-check.sh
# 建议 crontab：0 4 * * * cd /root/MyWebSite && bash scripts/backup-check.sh >> /var/log/xt-backup.log 2>&1

NOW=$(date "+%Y-%m-%d %H:%M:%S")
BACKUP_DIR="/root/image-backups"
SCRIPT="npx tsx scripts/backup-images.ts"

log() { echo "[$NOW] $1"; }

log "========== 备份检查 =========="

# 1. 确保备份目录存在
mkdir -p "$BACKUP_DIR"

# 2. 检查远端数据库
DB_OK=$(docker compose exec -T postgres psql -U xiangtai -d xiangtai -c "SELECT count(*) FROM order_product_images WHERE created_at < NOW() - INTERVAL '3 days'" 2>/dev/null | tail -1 | tr -d ' ')
log "可备份图片数: $DB_OK"

# 3. 执行备份
cd /root/MyWebSite
if $SCRIPT 2>&1; then
  log "✅ 备份成功"
else
  log "❌ 备份失败，尝试修复..."
  
  # 尝试重启数据库
  docker compose restart postgres
  sleep 10
  
  if $SCRIPT 2>&1; then
    log "✅ 重启后备份成功"
  else
    log "❌ 备份仍然失败，需人工介入"
  fi
fi

# 4. 磁盘空间预警
BACKUP_SIZE=$(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1)
log "备份目录大小: $BACKUP_SIZE"
log "========== 完成 =========="
