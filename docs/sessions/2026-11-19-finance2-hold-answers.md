# 2026-11-19 扣货拦截：落实老板对「放货拦截」1～6 条的答复（财务系统2 第 9 期，物流这一边）

任务来源：财务系统2 总窗口派的活。只在本机分支 `claude/caiwu2-hold-answers`（从 `claude/caiwu2-agent-wallet` 即 b25c96d 切出）提交，**不推、不上线、不碰线上库、本机不用 Docker**。
依据：老板 2026-11-19 对上一轮「要问老板的」的答复（都照建议做）；财务系统2 `docs/物流系统接口约定.md` 第 1.1、1.3、5 节和新加的**第 11 节「扣货上报」**（ADR 0145）。
上一轮的说明：`docs/sessions/2026-11-19-finance2-holds.md`（它的「要问老板的」已逐条标上答复）。

## ⚠️ 中途改过一次（同日，总调度通知）
第一版（9659f0d）物流把「拆派仓把扣着的货派出去了」也按约定 11.1 报给财务（releasedWhileHeld，带补报）。之后总调度通知：**财务那边 C 组拉运单时已经自己认出这件事并报警（财务系统2 ADR 0142，警报 holds.releasedWhileHeld），物流不要再报同一件事**。所以第二版：
- 拆派仓派出去的：物流照收、记 chaipai 日志、打 warn，**不往财务报，也没有补报**。
- 迁移 `20261119_finance2_holds_reports` 还没上线，直接改：日志表不加列（去掉第一版的 report_status / reported_at / report_error），只留 `finance2_hold_state.unavailable_report`。
- 「拿不到名单 / 恢复了」（约定 11.2）照旧报。

## 老板答复怎么落实

| # | 老板答复 | 怎么做的 | 测试 |
|---|---|---|---|
| 1 | 柜子推到「预约派送」时柜里有欠款客户的货：**只扣这几票，其余照推** | 代码本来就是这样（containers/routes.ts → `splitHeldForBatch`）。注释、文档里「接口⑦ 老板还没定」改成「老板 2026-11-19 定」 | db C1（被扣的几票不推、其余照推、没写轨迹没进账本）、源码 E3 |
| 2 | 拆派仓回传「派送中」时货已经出去了：**照收、记日志，另外在财务系统老板首页报一条警报** | 照收、记 chaipai 日志（唛头、母运单号、实际出去的运单号、按几点的名单）、打 warn。**老板首页那条警报由财务拉运单时自己认出来、自己报（财务系统2 ADR 0142），物流不另报**，免得同一件事报两遍。observe 照记，off 不记 | db K1、K2，源码 R4、E6 |
| 3 | 撤销误签收：**不拦** | 代码本来就不拦（admin-ops `/admin/lastmile/unsign` 不查名单）。注释改成「老板 11-19 定不拦」；补了真库测试 | db U1、源码 E5 |
| 4 | 什么时候开拦截：**先开「只记不拦」看几天，确认名单没算错，再真拦** | a）`FINANCE2_HOLDS_MODE` 不填时：`FINANCE2_API_BASE`、`FINANCE2_HOLDS_SECRET` 至少配了一个 → observe；两个都没配 → off。明确写 off 才是关、observe 只记、enforce 真拦，不认识的词仍按 enforce。b）管理员能在放货页「扣货名单」那一块（observe 模式下）点「试运行记录：这几天本来会拦谁」，看最近 7 天的 observe 记录（几点、唛头、运单号 / 母单、从哪个入口、按几点的名单），新接口 `GET /admin/finance2-holds/observe-log`（只给管理员，最多 300 条，不回金额、客户名字、操作人）。员工看不到这个列表。c）env.example / .env.example / docker-compose.yml 注释和下面「上线步骤」写清楚 | 源码 K1b、W5、W6；db S2、O1、O2 |
| 5 | 开关写错、密钥地址配错按「照本地名单拦」（宁可多拦）：**对** | 代码本来就是这样（config.ts：开着时配错照本地名单拦、不认识的词按 enforce）。注释、env 说明里过时的「配错按 off」删了，改成老板已定 | 源码 K1、K3；db S3、S4 |
| 6 | 拿不到扣货名单的报警现在只打物流服务器日志 → **财务系统老板首页也报一条** | sync.ts 里原来打 error 的几种（401 / 403、配置有问题、连续 1 小时取不到）同时按约定 11.2 `POST {FINANCE2_API_BASE}/integrations/logistics/v1/hold-events` 报 `holdListUnavailable`（Bearer 同一把「物流拉财务」密钥、10 秒超时、走 core/fetch-deadline；reason 去掉密钥、截 200 字；配置有问题时没有 remote，报不了，只打日志）。一串失败里**报成一次就不再报**（`finance2_hold_state.unavailable_report = sent`）；报了没收到 200（连不上 / 超时 / 5xx）记 pending，下一轮失败时再报；4xx 记 rejected、打 error、不再报。又取到名单时，之前报过（sent / pending）的报一次 `holdListRecovered`，200 或 4xx 后清掉记号，没报进去留着下次取到时再报。报的成败不影响取名单 | db A1～A6、源码 R1～R3、R5 |

## 我自己定的技术取舍（汇报时说清）
- 「拿不到名单」报到哪一步记在名单抬头那一行上：新迁移 `20261119_finance2_holds_reports` 只加一列 `finance2_hold_state.unavailable_report`（可空，IF NOT EXISTS，只加不删；`check-schema-drift.sql` 登记，共 69 张表 / 840 个字段）。值：null 没报过 / pending 报了没收到 200 / sent 财务收下了 / rejected 财务回 4xx。
- 一串失败里报成一次就不再报（财务那边本来也去重，「这边也别刷」）；只有 401 / 403、连续 1 小时取不到这几种才报，偶尔一次 5xx 只打 warn、不报。每轮最多报一次，不在一轮里重试 5 秒 / 30 秒 / 2 分钟（约定 11.3：下一轮接着报）。
- 上报的超时取 10 秒（约定没单写，跟取名单一样）；只认 200 算报进去，别的 2xx / 3xx、429 当「下一轮再报」；请求体超过 8 KB 本地就不发。
- ⚠️ **代理端「我的钱包」跟扣货共用 `FINANCE2_API_BASE` + `FINANCE2_HOLDS_SECRET`**：只为钱包配了这两项、开关不填，扣货就会按 observe 开始取名单（只记不拦）——这正是老板「默认先只记」的意思，env 注释里写了。

## 上线步骤（开关怎么设）
1. 财务系统2 把 `/integrations/logistics/v1/holds`、`/holds/check`、`/hold-events`（第 11 节）做好并上线，给物流一把「物流拉财务」的密钥。
2. 服务器 `.env` 配 `FINANCE2_HOLDS_SECRET=<财务给的>`、`FINANCE2_API_BASE=https://<财务系统2 域名>`；**`FINANCE2_HOLDS_MODE` 不填或填 `observe`**（先只记不拦）。`docker compose up -d` 重建 api。
3. 部署会跑两个迁移：`20261119_finance2_holds`（五张新表）、`20261119_finance2_holds_reports`（`finance2_hold_state` 加一列），都只加不删。
4. 核对：管理员端装柜管理 / 尾端派送顶上出现「扣货名单：现在按 … 的名单拦（试运行：只记不拦）」；`finance2_hold_logs` 里有 fetch_ok。
5. 看几天：管理员在那一块点「试运行记录：这几天本来会拦谁」，对着财务系统看名单有没有算错。
6. 老板说开 → `FINANCE2_HOLDS_MODE=enforce`、重建 api，真拦。
7. 要完全关：填 `FINANCE2_HOLDS_MODE=off`（不填不是关，只要地址 / 密钥配着就是 observe）。

## 测试
- `npm run test:finance2-holds-source`：35 → **43 项**（新加 K1b 开关不填；R1～R3 上报请求体 / 请求头 / 4xx 不重试 / 5xx 超时连不上下一轮 / 8 KB；R4 拆派仓派出去的不报财务、没有补报；R5 报警同时上报、恢复报一次；W5 试运行记录只给管理员；W6 文档不再写「配错按 off」）。
- `npm run test:finance2-holds-db`：44 → **54 项**（新加 K2、A1～A6、O1、O2、U1；K1 改成「记日志、打 warn、不往财务报、定时那一轮也不报」；S2 改成「不填 + 配了地址密钥 = observe、都没配 = off」；M1 加新迁移接着跑两遍、老数据不动、日志表没加 report 列）。

## 验证（本机 Homebrew postgresql@16 一次性库，端口 55471，用完删掉；没用 Docker）
（第二版跑完补上）

## 没做的（记一笔）
- 拆派仓回传这条还是直接调 `noteChaipaiRelease` 测，没有走真的 `/integrations/chaipai/v2/events`（要配拆派仓那一整套；上一轮就记过）。源码测试 E6 钉住回传路由在事务提交后调它。
