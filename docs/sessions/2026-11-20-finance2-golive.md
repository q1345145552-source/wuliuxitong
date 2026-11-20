# 2026-11-20 财务系统2 对接合进物流系统（上线记录草稿，还没上线）

老板已同意把财务系统2 对接合进湘泰物流系统并上线。这一份是**合并和检查**的记录，加上线要做的清单；**上线由总调度做**，这里没推、没 ssh、没碰线上库，本机没用 Docker。

## 合了什么

工作目录 `/private/tmp/wl-golive`，分支 `claude/caiwu2-golive`，从 `origin/main` = 5a974da（到货通知按仓库筛选，线上就是它）切出。老板 main 工作区一点没动。

1. `claude/caiwu2-api-54a826`（39c2812）：给财务系统2 的只读接口 `/integrations/finance2/v1/…`（modules/finance2，第 7 期物流这一边）。没有冲突。合并提交 7c452d7。
2. `claude/caiwu2-hold-answers`（f6e86d1）：扣货拦截（8fa2476 → 5635e92 Codex 第二次审查修）、代理端「我的钱包」b25c96d、老板 11-19 答复改动（9659f0d、b3152cc）。
   合并提交 61809da。两个分支都从 cca3a9c（84c1db9 上线记录）切出，所以 cca3a9c 这条 journal 也跟着进来了。

### 冲突怎么处理的（都是两边都留）
| 文件 | 怎么合 |
| --- | --- |
| `apps/api/prisma/schema.prisma` | 只读接口两张表（Finance2WaybillChange、Finance2CustomerAgentChange）在前，扣货名单五张表在后；补上中间漏掉的 `}` |
| `scripts/check-schema-drift.sql` | 两边的字段清单都留（12 + 31 个）；抬头改成 **71 张表 / 852 个字段**（在一次性库上数过，跟迁移后实际库一致） |
| `env.example`、`.env.example` | 两组变量都留：只读接口三个在前，扣货名单 / 钱包三个在后 |
| `docker-compose.yml` | 两组透传都留（共 6 个变量） |
| `docs/journal.md` | 两边的条目都留 |
| `apps/api/src/main.ts`、`package.json`、`.github/workflows/ci.yml`、`docs/api-contract.md` | 自动合并，核过两边都在（路由三处注册、六个 test 脚本、CI build 组 3 项 / test-db 组 3 项） |

### 迁移
`apps/api/prisma/migrations/` 新加三个，`prisma migrate deploy` 按名字顺序跑：
1. `20261119_finance2_holds`：扣货名单五张新表（finance2_hold_state / holds / hold_releases / hold_clears / hold_logs）。
2. `20261119_finance2_holds_reports`：`finance2_hold_state` 加一列 `unavailable_report`（IF NOT EXISTS）。
3. `20261119_finance2_readonly_api`：两张只追加的表 + 15 个触发器（orders / shipments / order_products / shipment_container_items / status_logs / containers / users）+ 给现有每一票母运单补一条改动记录。

都只加不删：没有 DROP TABLE / DROP COLUMN / DELETE / 改列；唯一的 DROP 是 `DROP TRIGGER IF EXISTS`（只删自己这几个新触发器，好重复执行）。三个互不依赖，顺序无所谓。

## 检查（本机 Homebrew postgresql@16 一次性库，端口 55480，用完删掉；没用 Docker）
- 三套类型检查（后端 / 前端 / 测试脚本）0 错；前端 `npm run build --prefix apps/web` 过。
- 本机复刻 CI（`.audit/tools/run_ci.py`、`run_testdb.py` 拷到 `/private/tmp/golive-ci`、指向本工作目录）：
  - build 组 **84 / 84** 一次过（含 test:finance2-source 14、test:finance2-holds-source 43、test:finance2-wallet-source 12、到货通知 test:arrival-notice-source 24 / editor / converted-edit / snapshot / warehouse 16、Build frontend）。
  - test-db 组 **41 / 41** 一次过（含 test:finance2-db 40、test:finance2-holds-db 54、test:finance2-wallet-db 12、到货通知三项 + 两个迁移测试）。跟 build 组同时跑，这次没碰上并发偶发失败。
- 迁移另核一遍（没用 db push）：拿 5a974da 的 schema 用 `prisma migrate diff --from-empty --script` 建一个「上线前」的库，按顺序跑三个新迁移、**连跑两遍**都过；`prisma migrate diff --from-url … --to-schema-datamodel schema.prisma --exit-code` 输出「No difference detected」；`check-schema-drift.sql` 不报；库里 71 张表 / 852 个字段跟体检清单一致。
- 加跑一遍：CI 的 test-db 组用 db push 建库，**没有只读接口那 15 个触发器**；线上上线后是有的。所以在上面那个「上线前 + 三个迁移」的库（触发器在）上把 test-db 组 40 项（跳过 db push 那步）又全跑一遍：**40 / 40**，触发器真在记（改动记录表里 shipments / status_logs / 装柜明细 / 产品行 / 订单 / 账号 / 柜子各来源都有）。

## 上线清单（给总调度）

### 物流服务器（`/root/MyWebSite/.env`）要加的变量
| 变量 | 含义 | 谁提供 |
| --- | --- | --- |
| `FINANCE2_COMPANY_ID` | 湘泰那家公司的 company_id（只读接口只给这一家的单） | 上线前在线上只读查 `companies` 确认 |
| `FINANCE2_API_KEY_SHA256` | 「财务拉物流」那把密钥的 sha256 指纹（64 位小写十六进制），**不是密钥本身** | 我们自己生成：`npx tsx scripts/finance2-make-key.ts`，密钥交给财务系统2，指纹填这里 |
| `FINANCE2_API_KEY_SHA256_PREV` | 换密钥期间上一把的指纹，平时空 | 换密钥时才填 |
| `FINANCE2_API_BASE` | 财务系统2 根地址，例如 `https://xtcwxt.site`（不带 `/integrations/...`，程序自己拼 `/integrations/logistics/v1`）；生产只认 https | 财务系统2 的域名 |
| `FINANCE2_HOLDS_SECRET` | 「物流拉财务」那把密钥**原文**（扣货名单、上报、代理钱包共用），随机、至少 32 位 | 财务系统2 那边生成发过来（指纹配在财务那边） |
| `FINANCE2_HOLDS_MODE` | 扣货开关：**不填或 `observe`（先只记不拦）**；`enforce` 真拦（老板看过几天试运行记录说开再改）；`off` 完全关 | 老板定 |

- 只读接口三个（`FINANCE2_COMPANY_ID`、`FINANCE2_API_KEY_SHA256`）配齐才打开，否则 `/integrations/finance2/v1/*` 一律 503。
- ⚠️ 只要配了 `FINANCE2_API_BASE` 或 `FINANCE2_HOLDS_SECRET`、`FINANCE2_HOLDS_MODE` 不填，扣货就按 observe 开始每 15 分钟取名单（只记不拦）；代理端「我的钱包」也用这对地址 + 密钥。
- 改完 `.env` 要 `docker compose up -d` 重建 api 容器才生效（docker-compose.yml 已透传这 6 个）。

### 财务系统2 服务器（`/opt/caiwu2/shared/.env`）要配的
| 变量 | 写什么 | 说明 |
| --- | --- | --- |
| `LOGISTICS_API_URL` | `https://<物流系统域名>/integrations/finance2/v1`（带完整前缀） | 财务系统2 docs/部署.md「接上物流系统」 |
| `LOGISTICS_API_KEY` | 上面物流这边生成的「财务拉物流」密钥原文 | 写进去就等于「接上那天」，那天以前确认收货的只记不算钱——**先问老板从哪天起算钱** |
| `CAIWU2_LOGISTICS_KEY_SHA256` | 「物流拉财务」那把密钥的 sha256 指纹；换密钥时逗号隔开放新旧两个 | 没配指纹一律 401（扣货名单、钱包、上报全不通）。财务系统2 的 docs/部署.md「.env 每一项」里**没写这一项**（只在 ADR 0090 / 0130 和 `src/server/auth/api-key.ts`），要补 |

改完 `sudo systemctl restart caiwu2`（next start 启动时读 .env）。「物流拉财务」那把密钥在财务这边没有专门的生成脚本：随便生成一把随机串（例如 `openssl rand -base64 48 | tr -d '/+='`），原文给物流 `FINANCE2_HOLDS_SECRET`，`printf %s '<密钥>' | shasum -a 256` 的指纹给财务 `CAIWU2_LOGISTICS_KEY_SHA256`。

### 上线前只读核对（线上）
照 `docs/finance2-对接-核对.md` 第七节「上线前核对」：脏数据两条 SQL、规模、`statement_timeout` / `lock_timeout`、长事务、这几张表上原来有没有别的触发器。

### 上线后核对
- `prisma migrate status` 没有待跑的迁移；`check-schema-drift.sql` 不报。
- 只读接口：不带密钥 401、带密钥 `GET /integrations/finance2/v1/agents` 200；`SELECT count(*) FROM finance2_waybill_changes` ≈ 母运单数；过一会儿 `source <> 'backfill'` 的最新一条在往前走。
- 扣货：管理员端装柜管理 / 尾端派送顶上「扣货名单：现在按 … 的名单拦（试运行：只记不拦）」；`finance2_hold_logs` 里有 `fetch_ok`。
- 钱包：代理登录 → 我的钱包能打开（没配时写「钱包还没开通」）。

## 还没定的（从各分支会话记录里带过来，上线后问老板）
- 钱包菜单一上线就对所有代理显示、时间按北京时间、手机底部要不要加入口（`docs/sessions/2026-11-19-finance2-agent-wallet.md`）。
- 只读接口第六节 1～7 条（`docs/finance2-对接-核对.md`）。
