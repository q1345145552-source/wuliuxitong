#!/usr/bin/env bash
# 打开拆派仓对接：把 6 个 CHAIPAI_* 配置写进生产服务器 /root/MyWebSite/.env，只重建 api 容器（2026-10-12）。
#
# 用法（在老板 Mac 上跑）：
#   bash scripts/chaipai-env-apply.sh /Users/liuyujiang/拆派仓-湘泰对接密钥.env
#
# 做的事：
#   1. 本机先核对密钥文件（只看变量名和规矩，不打印任何值）；
#   2. 把 5 个值 + CHAIPAI_ENABLED=true 通过 ssh 的标准输入交给服务器（不进命令行参数、不进 shell 历史、服务器上不落临时文件）；
#   3. 服务器上：.env 先原样备份成 .env.bak-<时间>-before-chaipai，再在末尾追加一段；
#      已经有一模一样的 6 行（上次跑到一半断了）就不再追加、直接往下走；有 CHAIPAI_ 行但不一样就停下、什么都不改；
#   4. 只重建 api 容器（--no-deps --no-build，web / 数据库 / redis 不动），等它健康；
#      等不到健康就自动把 .env 换回备份、再重建 api，然后报失败；
#   5. 核对：容器里开关是 true、公司编号和地址对；不带密钥请求拉清单接口应回 401（开关关着或配置不合格时是 503）；
#      日志里没有「配置不合格」。
# 全程不打印任何密钥；任何一步出错都会打印回退办法。
#
# 演练：DRY_RUN=1 REMOTE_DIR=<本机目录> bash scripts/chaipai-env-apply.sh <假密钥文件>
#   —— 不连服务器，在本机目录里的 .env 上跑同一段逻辑，跳过 docker / curl。
set -euo pipefail

KEYFILE="${1:?用法: bash scripts/chaipai-env-apply.sh <密钥文件>}"
SSH_KEY="${XT_SSH_KEY:-$HOME/.ssh/xiangtai_deploy_20260720}"
XT_HOST="${XT_HOST:-root@76.13.181.104}"
DRY_RUN="${DRY_RUN:-0}"
REMOTE_DIR="${REMOTE_DIR:-/root/MyWebSite}"

[ -r "$KEYFILE" ] || { echo "❌ 读不到密钥文件：$KEYFILE"; exit 2; }

# ① 本机核对 + 生成要写的 6 行（只进变量，不落盘、不打印）
BLOCK="$(python3 - "$KEYFILE" <<'PY'
import re, sys
vals = {}
for line in open(sys.argv[1], encoding="utf-8-sig").read().splitlines():
    s = line.strip()
    if not s or s.startswith("#"):
        continue
    m = re.match(r"^(?:export\s+)?([A-Z0-9_]+)=(.*)$", s)
    if not m:
        sys.exit("❌ 密钥文件里有一行格式认不出（没有显示内容）")
    k, v = m.group(1), m.group(2)
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
        v = v[1:-1]
    if k in vals:
        sys.exit(f"❌ 密钥文件里 {k} 写了两遍")
    vals[k] = v
need = ["CHAIPAI_COMPANY_ID", "CHAIPAI_PULL_SECRET", "CHAIPAI_CALLBACK_SECRET", "CHAIPAI_READ_SECRET", "CHAIPAI_API_BASE"]
missing = [k for k in need if not vals.get(k)]
if missing:
    sys.exit("❌ 密钥文件缺：" + "、".join(missing))
extra = [k for k in vals if k not in need and k != "CHAIPAI_ENABLED"]
if extra:
    sys.exit("❌ 密钥文件里有不认识的变量：" + "、".join(extra))
# 门槛跟湘泰 chaipai/config.ts 的 isSafeSecret 一样，另外只许安全字符、不许 ~ 开头
# （写进 .env 不加引号，deploy.sh 会 source .env，~ 开头会被 shell 展开成路径）
def safe(v):
    return (v == v.strip() and len(v) >= 32 and not re.search(r"[\s\x00-\x1f\x7f]", v) and len(set(v)) >= 8
            and not re.search(r"dev-only|change[-_ ]?me|replace[-_ ]?me|your[-_ ]?secret", v, re.I)
            and re.fullmatch(r"[A-Za-z0-9._~+/=-]+", v) is not None and not v.startswith("~"))
secrets = [vals[k] for k in ("CHAIPAI_PULL_SECRET", "CHAIPAI_CALLBACK_SECRET", "CHAIPAI_READ_SECRET")]
for k in ("CHAIPAI_PULL_SECRET", "CHAIPAI_CALLBACK_SECRET", "CHAIPAI_READ_SECRET"):
    if not safe(vals[k]):
        sys.exit(f"❌ {k} 不合规（至少 32 位、不能有空白、至少 8 种字符、只许字母数字和 ._~+/=-、不许 ~ 开头）")
if len(set(secrets)) != 3:
    sys.exit("❌ 三把密钥不能有相同的")
if vals["CHAIPAI_COMPANY_ID"] != "xiangtai":
    sys.exit("❌ CHAIPAI_COMPANY_ID 应该是 xiangtai")
if vals["CHAIPAI_API_BASE"] != "https://xtchaipai.top/api":
    sys.exit("❌ CHAIPAI_API_BASE 应该是 https://xtchaipai.top/api")
print("CHAIPAI_ENABLED=true")
for k in need:
    print(f"{k}={vals[k]}")
PY
)" || exit 2
echo "✅ 本机核对通过：5 个值齐全、三把密钥合规且互不相同、公司编号 xiangtai、地址 https://xtchaipai.top/api"

UP_API="docker compose up -d --no-deps --no-build api </dev/null"

# ② 服务器上要跑的那一段（值放在带引号的 heredoc 里，不展开、不打印、不进命令行参数）
REMOTE_SCRIPT="$(cat <<REMOTE
set -euo pipefail
DRY_RUN='$DRY_RUN'
cd '$REMOTE_DIR'
[ -f .env ] || { echo "❌ 找不到 .env"; exit 3; }
BAK=""
fail_hint() {
  rc=\$?
  if [ \$rc -ne 0 ] && [ \$rc -ne 4 ] && [ -n "\$BAK" ]; then
    echo "=== ❌ 没做完（退出码 \$rc）。退回原样：cd $REMOTE_DIR && cp -p \$BAK .env && $UP_API ==="
  fi
}
trap fail_hint EXIT
EXISTING=\$(grep -Ec '^[[:space:]]*(export[[:space:]]+)?CHAIPAI_' .env || true)
if [ "\$EXISTING" != 0 ]; then
  # 跟这次要写的 6 行逐行比（模式从标准输入给 grep，不进命令行参数）
  SAME=\$(grep -Fxc -f - .env <<'CHAIPAI_CMP_EOF' || true
$BLOCK
CHAIPAI_CMP_EOF
)
  if [ "\$EXISTING" = 6 ] && [ "\$SAME" = 6 ]; then
    BAK=\$(ls -1t .env.bak-*-before-chaipai 2>/dev/null | head -1 || true)
    echo "ℹ️  .env 里已经有一模一样的 6 行 CHAIPAI_ 配置（上次写过），这次不再追加，直接重建并核对。"
  else
    echo "⚠️  .env 里已经有 CHAIPAI_ 配置、但跟这次的不一样，这次什么都没改。要重来请先人工核对 .env。"
    exit 4
  fi
else
  TS=\$(date +%Y%m%d-%H%M%S)
  BAK=".env.bak-\$TS-before-chaipai"
  cp -p .env "\$BAK"
  echo "💾 已备份：$REMOTE_DIR/\$BAK"
  # .env 最后一行没有换行就先补一个，别把第一行粘到上一行后面
  if [ -s .env ] && [ "\$(tail -c1 .env | od -An -c | tr -d ' ')" != '\n' ]; then echo >> .env; fi
  echo "# ===== 对接拆派仓（2026-10-12 打开；密钥由拆派仓生成，见 docs/sessions/2026-10-11-chaipai-integration.md）=====" >> .env
  cat >> .env <<'CHAIPAI_BLOCK_EOF'
$BLOCK
CHAIPAI_BLOCK_EOF
  N=\$(grep -c '^CHAIPAI_' .env || true)
  [ "\$N" = 6 ] || { echo "❌ 写完应有 6 行 CHAIPAI_，实际 \$N 行；已还原 .env"; cp -p "\$BAK" .env; BAK=""; exit 5; }
  echo "✅ .env 已追加 6 行 CHAIPAI_ 配置"
fi
if [ "\$DRY_RUN" = 1 ]; then echo "（演练：跳过重建容器和核对）"; exit 0; fi

START=\$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "🔄 只重建 api 容器（web、数据库、redis 不动，后台会断十几秒）……"
$UP_API
H=none
for i in \$(seq 1 60); do
  H=\$(docker inspect -f '{{.State.Health.Status}}' mywebsite-api-1 2>/dev/null || echo none)
  [ "\$H" = healthy ] && break
  sleep 2
done
echo "api 容器状态：\$H"
if [ "\$H" != healthy ]; then
  if [ -n "\$BAK" ]; then
    echo "❌ api 两分钟没起来，自动把 .env 换回备份、再重建 api……"
    cp -p "\$BAK" .env
    $UP_API
    BAK=""
    echo "=== ❌ 已退回原样（对接没打开），请把上面的输出发给技术 ==="
  else
    echo "=== ❌ api 两分钟没起来，也找不到备份，请把上面的输出发给技术 ==="
  fi
  exit 7
fi
EN=\$(docker exec mywebsite-api-1 printenv CHAIPAI_ENABLED 2>/dev/null || true)
CO=\$(docker exec mywebsite-api-1 printenv CHAIPAI_COMPANY_ID 2>/dev/null || true)
AB=\$(docker exec mywebsite-api-1 printenv CHAIPAI_API_BASE 2>/dev/null || true)
echo "容器里：CHAIPAI_ENABLED=\$EN  CHAIPAI_COMPANY_ID=\$CO  CHAIPAI_API_BASE=\$AB（密钥不显示）"
CODE=\$(curl -s -m 10 -o /dev/null -w '%{http_code}' 'http://127.0.0.1:3001/integrations/chaipai/v2/container-manifest?containerNo=X' || true)
echo "不带密钥请求拉清单接口：HTTP \$CODE（打开了应是 401；503 说明开关没开或配置不合格）"
BAD=\$(docker logs --since "\$START" mywebsite-api-1 2>&1 | grep -c '配置不合格' || true)
echo "日志里「配置不合格」：\$BAD 条"
if [ "\$EN" = true ] && [ "\$CODE" = 401 ] && [ "\$BAD" = 0 ]; then
  trap - EXIT
  echo "=== ✅ 湘泰这边的拆派仓对接已打开 ==="
  echo "（以后要关掉对接：cd $REMOTE_DIR && sed -i 's/^CHAIPAI_ENABLED=true\$/CHAIPAI_ENABLED=false/' .env && $UP_API ）"
else
  echo "=== ❌ 没对上（网站本身不受影响，只是对接接口还不能用），先别让拆派仓开开关 ==="
  exit 6
fi
REMOTE
)"

if [ "$DRY_RUN" = 1 ]; then
  printf '%s\n' "$REMOTE_SCRIPT" | bash -s
else
  printf '%s\n' "$REMOTE_SCRIPT" | ssh -i "$SSH_KEY" -o IdentitiesOnly=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 "$XT_HOST" 'bash -s'
fi
