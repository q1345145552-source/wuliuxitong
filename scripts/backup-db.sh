#!/bin/bash
# 每天凌晨2点备份 PostgreSQL 数据库
# 保留最近7天的备份

BACKUP_DIR="/root/db-backups"
mkdir -p "$BACKUP_DIR"
FILE="$BACKUP_DIR/xiangtai_$(date +%Y%m%d).sql.gz"

FEISHU_URL="https://open.feishu.cn/open-apis/bot/v2/hook/e49ecf0c-003d-41ae-9971-823ab219d9a4"

cd /root/MyWebSite

# dump 数据库
if docker compose exec -T postgres pg_dump -U xiangtai xiangtai | gzip > "$FILE"; then
  echo "$(date): Backup saved to $FILE ($(du -h "$FILE" | cut -f1))"
else
  echo "$(date): ❌ Backup FAILED"
  curl -s -X POST "$FEISHU_URL" -H "Content-Type: application/json" \
    -d "{\"msg_type\":\"text\",\"content\":{\"text\":\"【监控告警】数据库备份失败\n时间：$(date)\"}}" > /dev/null 2>&1
  exit 1
fi

# 保留最近7天
find "$BACKUP_DIR" -name "*.sql.gz" -mtime +7 -delete
