#!/usr/bin/env bash
# 安全设置定时任务（追加不覆盖已有任务）

TMPFILE=$(mktemp /tmp/xt-cron-XXXXXX)
crontab -l > "$TMPFILE" 2>/dev/null || true

# 追加湘泰定时任务（如已存在则跳过）
for line in \
  "0 3 * * * cd /root/MyWebSite && npx tsx scripts/backup-images.ts >> /var/log/image-backup.log 2>&1" \
  "*/10 * * * * cd /root/MyWebSite && bash scripts/monitor.sh >> /var/log/xt-monitor.log 2>&1" \
  "0 4 * * * cd /root/MyWebSite && bash scripts/backup-check.sh >> /var/log/xt-backup.log 2>&1"; do
  if ! grep -Fq "$line" "$TMPFILE" 2>/dev/null; then
    echo "$line" >> "$TMPFILE"
  fi
done

crontab "$TMPFILE"
rm -f "$TMPFILE"
echo "✅ crontab 已更新（保留原有任务）："
crontab -l
