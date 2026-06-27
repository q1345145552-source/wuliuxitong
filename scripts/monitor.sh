#!/usr/bin/env bash
# 湘泰物流系统 — 健康监控脚本
# 用法：./scripts/monitor.sh
# 建议 crontab：*/10 * * * * cd /root/MyWebSite && bash scripts/monitor.sh >> /var/log/xt-monitor.log 2>&1

set -e

NOW=$(date "+%Y-%m-%d %H:%M:%S")
ALERT=0
RESTARTED=0

log()  { echo "[$NOW] $1"; }
alert(){ echo "[$NOW] ❌ $1"; ALERT=1; }
ok()   { echo "[$NOW] ✅ $1"; }
RESTART_LIST=""

restart_service() {
  local svc=$1
  echo "[$NOW] 🔄 重启 $svc ..."
  docker restart "$svc" 2>/dev/null && { RESTARTED=1; RESTART_LIST="$RESTART_LIST $svc"; echo "[$NOW] ✅ $svc 已重启"; } || echo "[$NOW] ❌ $svc 重启失败"
}

# ── 1. 容器状态检查 ──
log "========== 健康检查 =========="

for container in xiangtai-api xiangtai-web xiangtai-postgres xiangtai-redis; do
  STATUS=$(docker inspect -f '{{.State.Status}}' "$container" 2>/dev/null)
  if [ "$STATUS" = "running" ]; then
    ok "$container 运行中"
  else
    alert "$container 状态: $STATUS"
    restart_service "$container"
  fi
done

# ── 2. API 响应检查 ──
API_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/admin/dashboard/overview -H "Authorization: Bearer test" --max-time 5 2>/dev/null || echo "000")
if [ "$API_CODE" = "200" ] || [ "$API_CODE" = "401" ]; then
  ok "API 响应正常 (HTTP $API_CODE)"
elif [ "$API_CODE" = "000" ]; then
  alert "API 无响应（可能挂了）"
  restart_service "xiangtai-api"
else
  alert "API 异常响应 (HTTP $API_CODE)"
fi

# ── 3. 前端响应检查 ──
WEB_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 --max-time 5 2>/dev/null || echo "000")
if [ "$WEB_CODE" = "200" ] || [ "$WEB_CODE" = "307" ] || [ "$WEB_CODE" = "301" ] || [ "$WEB_CODE" = "302" ]; then
  ok "前端响应正常 (HTTP $WEB_CODE)"
elif [ "$WEB_CODE" = "000" ]; then
  alert "前端无响应"
  restart_service "xiangtai-web"
else
  alert "前端异常响应 (HTTP $WEB_CODE)"
fi

# ── 4. 磁盘空间 ──
DISK_PCT=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
if [ "$DISK_PCT" -lt 85 ]; then
  ok "磁盘使用: ${DISK_PCT}%"
else
  alert "磁盘空间不足: ${DISK_PCT}% — 请清理"
fi

# ── 5. 内存 ──
MEM_PCT=$(free | grep Mem | awk '{printf "%.0f", $3/$2*100}')
if [ "$MEM_PCT" -lt 90 ]; then
  ok "内存使用: ${MEM_PCT}%"
else
  alert "内存使用过高: ${MEM_PCT}%"
fi

# ── 6. 备份检查（24小时内有过备份） ──
BACKUP_OK=0
for BACKUP_DIR in "/root/db-backups" "/root/image-backups"; do
  if [ -d "$BACKUP_DIR" ]; then
    RECENT=$(find "$BACKUP_DIR" -type f -mmin -1440 2>/dev/null | wc -l | tr -d ' ')
    if [ "$RECENT" -gt 0 ]; then
      BACKUP_OK=1
    fi
  fi
done
if [ "$BACKUP_OK" -eq 1 ]; then
  ok "备份正常"
else
  alert "备份异常：24小时内无新备份文件"
fi

# ── 7. 数据库连接 ──
DB_OK=$(docker compose exec -T postgres psql -U xiangtai -d xiangtai -c "SELECT 1" 2>/dev/null | grep -c "1 row" || echo "0")
if [ "$DB_OK" -gt 0 ]; then
  ok "数据库连接正常"
else
  alert "数据库连接失败"
fi

# ── 飞书通知 ──
FEISHU_URL="${FEISHU_WEBHOOK_URL:-}"

send_feishu() {
  local title="$1"
  local body="$2"
  curl -s -X POST "$FEISHU_URL" -H "Content-Type: application/json" \
    -d "{\"msg_type\":\"text\",\"content\":{\"text\":\"$title\n时间：$NOW\n$body\"}}" > /dev/null 2>&1
}

if [ "$ALERT" -eq 1 ] || [ "$RESTARTED" -eq 1 ]; then
  if [ "$RESTARTED" -eq 1 ]; then
    # 重启后复检
    sleep 5
    FIXED=0
    FAILED=""
    for container in $RESTART_LIST; do
      STATUS=$(docker inspect -f '{{.State.Status}}' "$container" 2>/dev/null)
      if [ "$STATUS" = "running" ]; then
        FIXED=1
      else
        FAILED="$FAILED $container"
      fi
    done
    if [ -n "$FAILED" ]; then
      send_feishu "【监控告警】❌ 自动修复失败" "以下服务未能恢复：$FAILED\n请手动检查。"
    else
      send_feishu "【监控告警】✅ 已自动修复" "所有异常服务已恢复正常。"
    fi
  else
    send_feishu "【监控告警】⚠️ 发现异常" "请检查服务器状态。"
  fi
fi

# ── 汇总 ──
log "========== 检查完成 =========="
if [ "$ALERT" -eq 1 ]; then
  echo "[$NOW] ⚠️  发现问题，已尝试自动修复"
fi
if [ "$RESTARTED" -eq 1 ]; then
  echo "[$NOW] 🔄 已自动重启服务"
fi
