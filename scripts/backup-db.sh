#!/bin/bash
# 每天凌晨2点备份 PostgreSQL 数据库
# 保留最近7天的备份

BACKUP_DIR="/root/db-backups"
mkdir -p "$BACKUP_DIR"
FILE="$BACKUP_DIR/xiangtai_$(date +%Y%m%d).sql.gz"

cd /root/MyWebSite

# dump 数据库
docker compose exec -T postgres pg_dump -U xiangtai xiangtai | gzip > "$FILE"

# 保留最近7天
find "$BACKUP_DIR" -name "*.sql.gz" -mtime +7 -delete

echo "$(date): Backup saved to $FILE ($(du -h "$FILE" | cut -f1))"
