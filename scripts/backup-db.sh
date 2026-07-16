#!/bin/bash
set -euo pipefail

# 加固版：数据库备份
# crontab: 0 2 * * * /root/MyWebSite/scripts/backup-db.sh >> /root/db-backups/cron.log 2>&1

BACKUP_DIR="/root/db-backups"
RETENTION_DAYS=14
TODAY=$(date +%Y%m%d)
FILE="$BACKUP_DIR/xiangtai_${TODAY}.sql.gz"
TMP_FILE="$BACKUP_DIR/xiangtai_${TODAY}.tmp.sql.gz"
MIN_SIZE_KB=50  # 小于50KB认为备份异常

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"; }

mkdir -p "$BACKUP_DIR"
cd /root/MyWebSite

log "========== 数据库备份开始 =========="

# 1. 检查磁盘空间（至少保留 500MB）
AVAIL=$(df -m "$BACKUP_DIR" | tail -1 | awk '{print $4}')
if [ "$AVAIL" -lt 500 ]; then
  log "❌ 磁盘空间不足：${AVAIL}MB，清理旧备份..."
  find "$BACKUP_DIR" -name "*.sql.gz" -mtime +3 -delete
  AVAIL=$(df -m "$BACKUP_DIR" | tail -1 | awk '{print $4}')
  if [ "$AVAIL" -lt 200 ]; then
    log "⛔ 磁盘仍不足，放弃备份"
    exit 1
  fi
fi

# 2. 检查数据库连接
if ! docker compose exec -T postgres pg_isready -U xiangtai > /dev/null 2>&1; then
  log "❌ 数据库无响应，尝试重启..."
  docker compose restart postgres
  sleep 10
  if ! docker compose exec -T postgres pg_isready -U xiangtai > /dev/null 2>&1; then
    log "⛔ 数据库无法恢复，放弃备份"
    exit 1
  fi
  log "✅ 数据库已恢复"
fi

# 3. 执行备份（3次重试）
SUCCESS=false
for i in 1 2 3; do
  log "第${i}次尝试备份..."
  if docker compose exec -T postgres pg_dump -U xiangtai xiangtai 2>/dev/null | gzip > "$TMP_FILE" 2>/dev/null; then
    SIZE=$(stat -c%s "$TMP_FILE" 2>/dev/null || stat -f%z "$TMP_FILE" 2>/dev/null || echo 0)
    SIZE_KB=$((SIZE / 1024))
    if [ "$SIZE_KB" -ge "$MIN_SIZE_KB" ]; then
      # 验证 gzip 完整性
      if gzip -t "$TMP_FILE" 2>/dev/null; then
        mv "$TMP_FILE" "$FILE"
        log "✅ 备份成功：$FILE ($(du -h "$FILE" | cut -f1))"
        SUCCESS=true
        break
      else
        log "⚠ gzip 损坏，重试..."
        rm -f "$TMP_FILE"
      fi
    else
      log "⚠ 文件过小（${SIZE_KB}KB），可能异常，重试..."
      rm -f "$TMP_FILE"
    fi
  else
    log "⚠ pg_dump 失败，重试..."
  fi
  sleep 5
done

# 4. 结果处理
if [ "$SUCCESS" = false ]; then
  log "⛔ 备份失败（已重试3次）"
  rm -f "$TMP_FILE"
  # 保留最后一次有效备份
  PREV=$(ls -t "$BACKUP_DIR"/xiangtai_*.sql.gz 2>/dev/null | head -1)
  if [ -n "$PREV" ]; then
    log "最近有效备份：$PREV"
  fi
  exit 1
fi

# 5. 清理旧备份（保留 ${RETENTION_DAYS} 天）
DELETED=$(find "$BACKUP_DIR" -name "*.sql.gz" -mtime +${RETENTION_DAYS} -delete -print | wc -l)
log "清理旧备份：${DELETED} 个"

# 6. 保留至少2个备份（即使超过保留天数）
COUNT=$(ls "$BACKUP_DIR"/xiangtai_*.sql.gz 2>/dev/null | wc -l)
log "当前备份数：${COUNT}"

log "========== 数据库备份完成 =========="
