#!/usr/bin/env bash
#
# 给某个代理的「专属域名」接上湘泰系统（草稿，2026-09-16 写，还没在任何服务器上跑过）。
#
# 为什么要有这个脚本
# ------------------
# 确认单 5.1 / 5.5：代理可以用自己的域名打开登录页，看到的是代理的名字和 logo。
# 系统这边已经做好了：登录页按请求的 Host 去查「代理管理」里填的专属域名（apps/web/src/modules/branding/server-brand.ts）。
# 但每个域名要在服务器上配 nginx + HTTPS 证书，nginx 配置不在 git 里（重装服务器会丢），
# 所以照 scripts/nginx-upload-limit.sh 的做法写成可重放的脚本。
#
# 前提（缺一个都别跑）
# ------------------
#   1. 代理那边已经把域名的 A 记录解析到这台服务器的公网 IP（脚本会先核一遍）
#   2. 超级管理员已经在「代理管理」里给这个代理填了同一个专属域名（全小写、不带 http:// 和端口）
#   3. 服务器上已经装了 certbot 和它的 nginx 插件（湘泰主站的证书就是它签的 —— 上服务器先 `certbot certificates` 看一眼确认）
#
# 用法（在服务器上跑，一次一个域名）：
#   bash /root/MyWebSite/scripts/nginx-agent-domain.sh agent.example.com
#
# 幂等：这个域名配过了就什么都不做。nginx 校验失败会自动删掉新配置，不会把湘泰主站搞挂。
#
# ⚠️ 上线前要先对照主站配置 /etc/nginx/sites-available/xianlianth.com 核一遍下面 server 块里的转发写法
#    （端口、X-Real-IP、超时），两边保持一致。尤其这三行不能少：
#      proxy_set_header Host $host;                 —— 登录页靠它认出是哪个代理的域名，少了就显示湘泰
#      proxy_set_header X-Real-IP $remote_addr;     —— 登录限流按它算（core/rate-limit.ts getClientIp）
#      client_max_body_size 10m;                    —— 上传入库照片，见 nginx-upload-limit.sh

set -euo pipefail

DOMAIN="${1:-}"
WEB_UPSTREAM="http://127.0.0.1:3000"   # 前端容器（docker-compose 只绑 127.0.0.1:3000）
SITES_AVAILABLE="/etc/nginx/sites-available"
SITES_ENABLED="/etc/nginx/sites-enabled"

if [[ -z "$DOMAIN" ]]; then
  echo "用法：bash $0 <代理的专属域名>，例如 bash $0 agent.example.com" >&2
  exit 1
fi

DOMAIN="$(echo "$DOMAIN" | tr 'A-Z' 'a-z' | sed -e 's#^https\?://##' -e 's#/.*$##' -e 's#:.*$##' -e 's#\.$##')"
if ! [[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
  echo "域名格式不对：$DOMAIN" >&2
  exit 1
fi
if [[ "$DOMAIN" == "xianlianth.com" || "$DOMAIN" == *".xianlianth.com" ]]; then
  echo "这是湘泰自己的域名，不能配成代理的专属域名：$DOMAIN" >&2
  exit 1
fi

CONF="$SITES_AVAILABLE/agent-$DOMAIN"
if [[ -f "$CONF" ]]; then
  echo "已经配过了，无需改动：$CONF"
  exit 0
fi

# ── 1. 核 DNS：域名必须已经指到这台机器，否则 certbot 签不出证书 ──
SERVER_IP="$(curl -fsS --max-time 5 https://api.ipify.org || true)"
DOMAIN_IPS="$(getent ahostsv4 "$DOMAIN" | awk '{print $1}' | sort -u | tr '\n' ' ' || true)"
echo "本机公网 IP：${SERVER_IP:-查不到}；$DOMAIN 解析到：${DOMAIN_IPS:-解析不到}"
if [[ -z "$SERVER_IP" || " $DOMAIN_IPS " != *" $SERVER_IP "* ]]; then
  echo "域名还没解析到这台服务器，先让代理去改 DNS，等生效了再跑。" >&2
  exit 1
fi

# ── 2. 先写 80 端口的配置（certbot --nginx 会在它上面加 443 和证书） ──
cat > "$CONF" <<NGINX
# 代理专属域名：$DOMAIN（scripts/nginx-agent-domain.sh 生成于 $(date '+%Y-%m-%d %H:%M:%S')）
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    client_max_body_size 10m;    # 上传入库照片用，见 scripts/nginx-upload-limit.sh

    location / {
        proxy_pass $WEB_UPSTREAM;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
NGINX
ln -sf "$CONF" "$SITES_ENABLED/agent-$DOMAIN"

if ! nginx -t; then
  echo "nginx 配置校验失败，已删掉新配置" >&2
  rm -f "$SITES_ENABLED/agent-$DOMAIN" "$CONF"
  exit 1
fi
systemctl reload nginx
echo "80 端口已生效：http://$DOMAIN"

# ── 3. 签证书并自动改成 https（certbot 会改写上面那个文件、自己 reload） ──
if ! certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect -m "${CERTBOT_EMAIL:-admin@xianlianth.com}"; then
  echo "证书没签下来。80 端口的配置保留着（http 能打开），查完原因再重跑 certbot：" >&2
  echo "  certbot --nginx -d $DOMAIN --redirect" >&2
  exit 1
fi

nginx -t
systemctl reload nginx

# ── 4. 核一遍：登录页标题应该是代理的名字，不是「湘泰物流网站」 ──
echo "--- 核验 ---"
TITLE="$(curl -fsS --max-time 10 "https://$DOMAIN/login" | grep -o '<title>[^<]*</title>' | head -1 || true)"
echo "https://$DOMAIN/login 标题：${TITLE:-取不到}"
if [[ "$TITLE" == *"湘泰"* ]]; then
  echo "⚠️ 标题还是湘泰的：检查「代理管理」里的专属域名是不是填的 $DOMAIN（最多 1 分钟缓存）" >&2
fi
echo "完成。"
