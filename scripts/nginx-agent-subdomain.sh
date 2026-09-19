#!/usr/bin/env bash
#
# 代理子域名（我们域名下的子域名，例如 yujiang.xianlianth.com）自动接上湘泰系统。
# 2026-09-19 写。老板没有 Hostinger API token，所以**不走通配证书**（通配证书只能用 DNS 验证签，
# 必须要有 DNS 服务商的 API），改成「每个子域名单独签一张证书」，用 HTTP-01 验证 ——
# 只要 DNS 有一条 `*` 解析指到本机，以后开多少代理都不用再碰服务器、也不用再动 DNS。
#
# 老板那边只需要做一次：Hostinger 后台加一条 A 记录，名称 `*`，指向本机公网 IP。
#
# 用法（在服务器上跑）：
#   bash scripts/nginx-agent-subdomain.sh setup    # 一次性：装 80 端口通配块 + 每 5 分钟的自动签证任务
#   bash scripts/nginx-agent-subdomain.sh sync     # 给所有代理子域名补证书和 443 块（cron 每 5 分钟调它，可手动跑）
#   bash scripts/nginx-agent-subdomain.sh status   # 看现状：哪些代理域名、有没有证书、有没有配置
#
# 幂等：配过的域名什么都不做；nginx 校验失败会自己删掉新写的文件并退出，不会把湘泰主站搞挂。
# ⚠️ 只碰 *.xianlianth.com 这种子域名；代理自己的域名（别的后缀）走 scripts/nginx-agent-domain.sh。

set -euo pipefail

SUFFIX="${AGENT_SUBDOMAIN_SUFFIX:-xianlianth.com}"
WEB_UPSTREAM="http://127.0.0.1:3000"        # 前端容器（docker-compose 只绑 127.0.0.1:3000）
ACME_WEBROOT="/var/www/acme-challenge"      # HTTP-01 验证文件放这儿，nginx 从 80 端口喂给 Let's Encrypt
PG_CONTAINER="xiangtai-postgres"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-admin@xianlianth.com}"
SITES_AVAILABLE="/etc/nginx/sites-available"
SITES_ENABLED="/etc/nginx/sites-enabled"
PORT80_CONF="$SITES_AVAILABLE/agent-subdomains.conf"
CRON_FILE="/etc/cron.d/xt-agent-subdomain"
SELF="/root/MyWebSite/scripts/nginx-agent-subdomain.sh"

die() { echo "$*" >&2; exit 1; }
[[ "$(id -u)" == "0" ]] || die "要用 root 跑（sudo bash $0 $*）"

# 一次查库把所有代理填的专属域名拿出来。查不到库不算致命：这次不补，下次 cron 再来。
agent_domains() {
  docker exec "$PG_CONTAINER" sh -c \
    "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -At -c \"SELECT custom_domain FROM agents WHERE custom_domain IS NOT NULL AND custom_domain <> '' ORDER BY custom_domain\"" \
    2>/dev/null | tr -d '\r' | grep -E "^[a-z0-9.-]+\.${SUFFIX//./\\.}\$" || true
}

public_ip() { curl -fsS --max-time 5 https://api.ipify.org || true; }

write_443_block() {  # $1 = 域名
  local domain="$1" conf="$SITES_AVAILABLE/agent-sub-$1"
  cat > "$conf" <<NGINX
# 代理子域名：$domain（scripts/nginx-agent-subdomain.sh 自动生成）
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $domain;
    client_max_body_size 10m;

    ssl_certificate /etc/letsencrypt/live/$domain/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$domain/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    location / {
        proxy_pass $WEB_UPSTREAM;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;                 # 登录页靠它认出是哪个代理
        proxy_set_header X-Real-IP \$remote_addr;     # 登录限流按它算
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
NGINX
  ln -sf "$conf" "$SITES_ENABLED/agent-sub-$domain"
}

cmd_setup() {
  local ip; ip="$(public_ip)"
  [[ -n "$ip" ]] || die "查不到本机公网 IP，先确认能上外网"

  # 1) DNS 通配解析还没加的话，先提醒（不加也能装，只是签不出证书）
  local probe="xt-probe-$(date +%s).$SUFFIX"
  if getent ahostsv4 "$probe" >/dev/null 2>&1; then
    echo "通配解析已生效（$probe 能解析）"
  else
    echo "⚠️ 通配解析还没生效：$probe 解析不出来。先让老板在 Hostinger 加 A 记录「*」→ $ip，加完再跑 sync。" >&2
  fi

  # 2) 80 端口通配块：只喂 Let's Encrypt 的验证文件，其余一律跳 https
  mkdir -p "$ACME_WEBROOT"
  cat > "$PORT80_CONF" <<NGINX
# 代理子域名的 80 端口：只放 Let's Encrypt 的验证文件，其余跳 https（scripts/nginx-agent-subdomain.sh 生成）
server {
    listen 80;
    listen [::]:80;
    server_name *.$SUFFIX;

    location ^~ /.well-known/acme-challenge/ {
        root $ACME_WEBROOT;
        default_type "text/plain";
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}
NGINX
  ln -sf "$PORT80_CONF" "$SITES_ENABLED/agent-subdomains.conf"

  if ! nginx -t; then
    echo "nginx 配置校验失败，已删掉新配置" >&2
    rm -f "$SITES_ENABLED/agent-subdomains.conf" "$PORT80_CONF"
    exit 1
  fi
  systemctl reload nginx
  echo "80 端口通配块已生效（*.${SUFFIX}）"

  # 3) 续期后让 nginx 重新加载证书（certbot.timer 已经在跑，这里只加个 deploy hook）
  mkdir -p /etc/letsencrypt/renewal-hooks/deploy
  cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'HOOK'
#!/usr/bin/env bash
# 证书续期后重载 nginx（scripts/nginx-agent-subdomain.sh setup 装的）
systemctl reload nginx
HOOK
  chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

  # 4) 每 5 分钟补一次证书（新开代理填了域名，几分钟内自动生效）
  cat > "$CRON_FILE" <<CRON
# 代理子域名自动签证书（scripts/nginx-agent-subdomain.sh setup 生成）
*/5 * * * * root bash $SELF sync >> /var/log/xt-agent-subdomain.log 2>&1
CRON
  chmod 644 "$CRON_FILE"
  echo "自动任务已装：每 5 分钟补一次证书 → /var/log/xt-agent-subdomain.log"

  cmd_sync
  echo "setup 完成。"
}

cmd_sync() {
  local changed=0 domain
  while read -r domain; do
    [[ -n "$domain" ]] || continue
    if [[ ! -f "/etc/letsencrypt/live/$domain/fullchain.pem" ]]; then
      echo "签证书：$domain"
      if ! certbot certonly --webroot -w "$ACME_WEBROOT" -d "$domain" \
           --non-interactive --agree-tos -m "$CERTBOT_EMAIL" --keep-until-expiring >/dev/null 2>&1; then
        echo "  ✗ $domain 证书没签下来，下次再试（certbot 日志在 /var/log/letsencrypt/）" >&2
        continue
      fi
      changed=1
    fi
    if [[ ! -f "$SITES_AVAILABLE/agent-sub-$domain" ]] || ! grep -q "$domain" "$SITES_AVAILABLE/agent-sub-$domain" 2>/dev/null; then
      write_443_block "$domain"
      changed=1
      echo "  已加 443 配置：$domain"
    fi
  done < <(agent_domains)

  if [[ "$changed" == "1" ]]; then
    if nginx -t; then
      systemctl reload nginx
      echo "nginx 已重载"
    else
      echo "✗ nginx 校验失败，配置留在原地没生效，去 /etc/nginx 查（主站不受影响，没重载）" >&2
      return 1
    fi
  else
    echo "没有新域名要处理"
  fi
}

cmd_status() {
  echo "后缀：*.$SUFFIX    本机公网 IP：$(public_ip)"
  echo "80 端口通配块：$([[ -f "$PORT80_CONF" ]] && echo 有 || echo 没有)"
  echo "自动任务：$([[ -f "$CRON_FILE" ]] && echo 有 || echo 没有)"
  echo "--- 代理填的域名 ---"
  local any=0 domain
  while read -r domain; do
    [[ -n "$domain" ]] || continue
    any=1
    local cert="没证书" conf="没配置"
    [[ -f "/etc/letsencrypt/live/$domain/fullchain.pem" ]] && cert="有证书"
    [[ -f "$SITES_AVAILABLE/agent-sub-$domain" ]] && conf="有配置"
    printf "  %-40s %s %s\n" "$domain" "$cert" "$conf"
  done < <(agent_domains)
  [[ "$any" == "1" ]] || echo "  （还没有代理填 *.${SUFFIX} 的域名）"
  echo "--- 最近日志 ---"
  tail -n 5 /var/log/xt-agent-subdomain.log 2>/dev/null || echo "  （还没有日志）"
}

case "${1:-}" in
  setup) cmd_setup ;;
  sync) cmd_sync ;;
  status) cmd_status ;;
  *) die "用法：bash $0 {setup|sync|status}" ;;
esac
