#!/usr/bin/env bash
# 一条命令设置所有定时任务
cat > /tmp/xt-cron <<CRON
0 3 * * * cd /root/MyWebSite && npx tsx scripts/backup-images.ts >> /var/log/image-backup.log 2>&1
*/10 * * * * cd /root/MyWebSite && bash scripts/monitor.sh >> /var/log/xt-monitor.log 2>&1
0 4 * * * cd /root/MyWebSite && bash scripts/backup-check.sh >> /var/log/xt-backup.log 2>&1
CRON
crontab /tmp/xt-cron
echo "✅ crontab 已设置："
crontab -l
