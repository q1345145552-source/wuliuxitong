# 2026-11-27 财务系统2 客户余额 · 物流这边第 1 轮：账和对接接口

任务来源：财务系统2 总窗口派的活（老板 11-27 点头的 ADR 0191「客户余额：物流充值、账单发出自动扣」）。
只在本机工作树 `.claude/worktrees/caiwu2-balance`、分支 `claude/caiwu2-balance`（从 origin/main 6c3a19f 切出）提交，**不推、不合并、不上线、没碰线上库**。
主目录里别人没提交的 38 处改动没动。本机没用 Docker：连库测试用 Homebrew PostgreSQL 16 临时建库、跑完删掉。

依据（在财务系统2 仓库，只读）：
- `docs/adr/0191-客户余额-物流充值-账单发出自动扣.md`
- `docs/物流系统接口约定.md` 1.1～1.3、第 12 节（四个接口）
- `docs/客户余额-分轮.md`「物流这边 · 第 1 轮」

## 做了什么

- **钱包公共函数**（`apps/api/src/modules/wallet/consolidation-balance.ts` 文件末尾）：
  - `chargeBillUpTo`：扣完为止。`SELECT balance … FOR UPDATE` 一句锁 + 读；实扣 = min(上限, max(余额, 0))；实扣 > 0 才改余额、写 `bill_charge` 流水。钱包行不存在 = 余额 0，扣 0、不建行。
  - `refundBillCharge`：先 `INSERT … ON CONFLICT DO NOTHING` 保证钱包行在 → 锁 + 读 → 锁里按流水重算这次扣款还能退多少（超了抛 `OverRefundError`）→ 加回、写 `bill_refund` 流水。
  - 金额全程用 `Prisma.Decimal`。`writeLedger` 只放开类型（`LedgerType`：原来三种 + `bill_charge` / `bill_refund` + 第 2 轮的 `topup` / `topup_reversal` / `deduction`）、多返回流水编号。集货那三个函数一行没改。
  - 新关联类型 `finance2_charge`（`ref_id` = 扣款的请求编号，退回也挂这个编号；`ref_no` = 账单号），不跟 whr / normal / recharge 共用。
- **请求去重表** `finance2_balance_requests`（迁移 `20261127_finance2_balance`）：主键 = 请求编号；种类、内容指纹、公司、客户（外键 users）、账单号、账单种类、上限 / 金额、扣款编号、退回原因、实扣 / 实退、之后的余额、流水编号、时间；两条 CHECK 把扣款 / 退回各自该有的列和金额关系钉在库里。
- **流水表加一列 `tx_id`**（同一个迁移）：写这一笔的事务号（库自己填），给 `/ledger` 防漏。老流水 0。
- **新模块** `apps/api/src/modules/finance2-balance/`：`paths.ts`（四条精确路径）、`config.ts`（开关 / 单独一把钥匙）、`views.ts`（格式核对、指纹、字段、游标）、`ops.ts`（扣款 / 退回的事务：编号排队锁 83092 → 查登记 → 动钱 → 登记）、`ledger.ts`（查余额、拉流水）、`routes.ts`。
- 接线：`server.ts` 对这四条精确路径不跑登录解析（2 行）；`main.ts` 注册。
- 客户余额页的流水中文名（`client-compliance/routes.ts`）：补了新类型和 `finance2_charge`「运费账单」。
- 其他跟着改的：`admin/user-references.ts`（新表的 client_id 记账号，员工号改客户号要查）、`scripts/check-schema-drift.sql`（72 张表 / 867 个字段）、`scripts/test-lock-order.ts`（登记排队锁 helper）、`scripts/test-mark-display.ts`（流水的操作人走 operatorNameForDisplay，钉住）、`.env.example` / `env.example` / `docker-compose.yml`（三个新变量）、`package.json`、`.github/workflows/ci.yml`、`docs/api-contract.md` 第 29 节。

## 测试

- `npm run test:finance2-balance-source`（8 项，CI build 组）
- `npm run test:finance2-balance-db`（34 项，CI test-db 组；自己临时建库、迁移连跑两遍）
- 变异（教训 28）：每次只去掉一处防护跑连库测试 —— 去掉编号排队锁（R6 红；C10 靠主键兜底仍绿）、去掉排队锁且不接撞主键（C10、R6 红）、去掉排队锁且登记撞了就忽略（C10、R6 红，余额被扣两次）、读余额不加锁（C11、R5、R6 红）、退回在锁外算能退多少（R5 红）、流水不看还没结束的事务（L4 红）。并发测试一开始没先锁住钱包，第一个请求常常在别的请求进门前就提交完了，变异 B 照样绿 —— 改成「另一个连接先锁住钱包 500 毫秒再放开」后才稳定变红。脚本 `run_mut.py` 在会话临时目录（没进仓库）。
- 不连库那组也做了 6 处变异，全红。
- 整套：本机照 CI 逐步跑 build 组 86/86、test-db 组 42/42（Homebrew PG16 一次性空库）；真起 main.ts（db push + seed 的一次性库，端口 4521）对四个接口冒烟过。
- 没做的验证：浏览器走查（这一轮没页面改动）；Node 22（本机 24）；子代理审查；线上库只读核对。

## 留给第 2 轮 / 要注意

- 管理员加 / 冲 / 减（`topup` / `topup_reversal` / `deduction`）：类型和客户页中文名已留好，函数、入口、关联类型（约定样例写的 `admin_adjust`）都没做；客户页 `source` 认不出的关联类型会原样露英文，第 2 轮加关联类型时一起在 `refZh` 补。
- 页面改名「集货余额」→「余额」、说明文字：没做。
- 本机两边连起来对着测的做法见交接给总窗口的报告（也抄在 journal）。

## 第 2 轮（同一天，总窗口验收第 1 轮后接着做）：管理员加 / 减 / 冲掉，页面改名改文案

依据：财务系统2 ADR 0191、`docs/方案-客户余额充值-2026-11-27.md` 第二节、第五节 1～7。

### 做了什么
- 后端 `apps/api/src/modules/wallet/admin-adjust-routes.ts`（接口见 `docs/api-contract.md` 29.8）；钱包公共函数 `adminTopup` / `adminDeduct` / `adminReverseTopup`（`consolidation-balance.ts` 末尾，先保证行在 → 锁和读同一句 → 锁里判断）。
- 新表 `wallet_adjustments` + 迁移 `20261127_wallet_adjustments`（外键 users，两条 CHECK）；结构漂移清单 73 张表 / 887 个字段。
- `realtime/publish.ts`：加减冲只推给请求里那一个客户。`core/operator-visibility.ts` 登记 reversedById / reversedByName；`admin/user-references.ts` 登记新表三列 + 水单列不算。
- 客户余额页流水：认不出的类型 / 来源写「其他」；新来源 `admin_adjust`「后台调整」。
- 前端：`app/admin/client-balance/page.tsx`（新页，菜单在「充值审核」下面）、`modules/wallet/ClientLedgerPanel.tsx`（管理员 / 员工共用的流水）；员工「客户余额」加「看流水」；客户余额页改名、两处文案、负数标红；集货两个付款弹窗、管理员集货撤销 / 删除提示、充值审核确认框、代理（关着的）入口、菜单、页面标题里的「集货余额」都改「余额」；财务页「N 个客户充值未用」改成「账上还有钱（负数余额已抵减）」。后端给人看的提示 / 新流水备注同样改。
- `scripts/finance2-make-key.ts` 加 `balance` 参数。

### 测试
- `test:wallet-adjust-source`（7 项）、`test:wallet-adjust-db`（21 项），都进 CI；改了老测试：test-finance2-wallet-source（代理菜单名）、test-mark-display（钉住新的操作人显示处）、test-staff-to-client-source（钉死名单加水单列）、test-lock-order（登记排队锁）。
- 变异：去掉编号排队锁（冲掉的同号并发红；加金额靠唯一约束兜底仍绿）、再去掉兜底（加金额同号并发红）、冲掉不锁调整单（两人同时冲红）、钱包读不加锁（两笔同时减、加金额和付集货同时来红）、减金额不拦负数、冲掉不看冲过没有 —— 全红。
- 已知问题复现 `test:wallet-first-row-known-issue-db`（不进 CI）：强制时序复现出来了（应 1900 实 900）；钱包行已存在的对照正确；自然并发 100 轮 0 轮出错。

### 浏览器（本机一次性库 + 后端 4521 + 前端 3217，亲手点）
- 管理员：客户余额页 → 看流水 → 加金额（金额默认空、两步核对、连点两下「确认加金额」库里只有一笔）→ 冲掉（没写原因被拦、写了冲掉、那一笔下面写明已冲掉）→ 减金额（超过余额被拦、100 减成功）；财务页那句、菜单入口。控制台 0 报错。
- 员工：客户余额 → 看流水（没有「冲掉」、没有操作人）。控制台 0 报错。
- 客户：余额页标题 / 文案 / 新流水中文名 / 账单号在单号列；用 SQL 把余额改成负数看了标红；两个集货页没有「集货余额」字样。控制台 0 报错。
- 没看的：集货付款弹窗本身（库里没有待付款的单，没打开）、手机宽度、代理端（入口关着）。

## 第 3 轮（同一天）：修钱包行第一次出现的竞态、管理员页窄屏、亲眼看集货付款弹窗

### 修竞态（单独一个提交 9a2e1ce，老板不同意可以原样 revert）
- `chargeForConsolidation` / `refundToConsolidation` 的「锁」和「读余额」改成同一句（新函数 `lockAndReadBalance`）；锁不到行 = 余额 0，付款不建行；退款锁不到行时先建行再锁再读。
- `recordRechargeCredit`、充值通过的 upsert 没改：同一个事务里先 upsert（库里原子加、写的时候锁住了这一行）再记流水，没有这个窗口。
- 回归测试 `test:wallet-first-row-db`（原已知问题脚本改名、加断言、进 CI 连库组）：修之前 A1、A2 红（900 vs 1900、1050 vs 2050），修之后全绿；B / B2 对照、C 30 轮不强制时序一直绿。

### 窄屏
- 流水（管理员页、员工页共用的 `ClientLedgerPanel`）按这一块的宽度（< 860）换成一条一块，「冲掉」「看水单」在块里；管理员页客户列表 < 640 也换成一条一块（`modules/wallet/useNarrowBox.ts`，按容器量，平板带侧边栏也算窄）。
- 加 / 减 / 冲弹窗：手机上最高占满屏、能滚，底下留出底部常用入口那一排的高度；按钮换行；提示条「知道了」不再被挤成两行。
- 亲眼看过：375 宽（客户列表、流水、加金额两步弹窗填一个很长的金额、冲掉弹窗、减金额两步弹窗并真减一笔，页面没有横向滚动）、768 宽（客户列表表格、流水一条一块、加金额弹窗）。员工页的流水在手机宽度下没单独看。

### 集货付款弹窗（亲眼看）
- 一次性库里走真接口造了待付款的普通版任务（客户建 → 员工确认满柜 → 员工报价）和仓库版预报单（超管建计划 → 客户填地址、建预报单、加货 → 员工签收）。
- 客户身份打开两个付款弹窗：标题「用余额付款」、「当前余额」「付款后剩余」、确认框「确认用余额支付 ¥…？」；各真付一笔（180、96），余额 12000 → 11820 → 11724，流水两笔集货付款对得上。
- 余额是负数（只改钱包余额那一格）时：两个弹窗都显示「余额不足，还差 ¥…，请先去「余额」充值」，确认按钮变灰；当前余额原来写成「¥-50.00」，改成「−¥50.00」并标红（这次改的）。

## 第 4 轮（同一天）：审查和总窗口亲手点提出的 9 处

- **网断以后别加两遍**（审查第 1 条）：`modules/wallet/submit-keys.ts` —— 提交编号跟「这一次填的内容」（种类 + 客户 + 金额 + 备注 / 原因 + 水单；冲掉是那一笔 + 客户 + 原因）绑在一起。
  交出去后不知道办没办成（网断、20 秒没回话、5xx、2xx 读不全）→ 浏览器里记下「内容 → 编号」（24 小时），同样的内容再交（原样重试、返回修改没改、关掉重开填同一个数、刷新页面后）都用回原编号；
  后端回了明确结果（成功、重复回话、4xx）→ 清掉。真想再加一笔同样的数：再交一次会拿到「刚才那一笔已经加过了，这次没有重复加」，记录清掉，再交一次就是新的一笔（页面写明）。改了内容 = 另一笔（有意的）。
  `services/business-api.ts` 的 `postAdjust` 分两类错；管理员页提示「不确定办成没有：请先看下面的流水，已经有这一笔就不要再点」并重拉流水和余额。
- **流水「加载中」卡死**（第 2 条）：`modules/wallet/ledger-loader.ts`（createQueryGate），「加载中」按前台请求个数算；办完一笔回第 1 页；晚到的旧页用不上。
- **看流水不读水单原图**（第 3 条）：`proof_image IS NOT NULL` 在库里算；重复提交比水单用 `IS NOT DISTINCT FROM` 在库里比；全文件只剩「看水单」那一个接口读原图。
- **8 秒内回话**（第 4 条）：财务四个接口 maxWait 1.5 秒 + 事务 6 秒，事务第一句 `SET LOCAL lock_timeout = '4s'`、`statement_timeout = '5s'`；只读查询 `statement_timeout = '5s'`。等不到锁 → 503 busy（钱没动、编号没记）。管理员加 / 减 / 冲同样加了（等锁 5 秒、语句 8 秒），503 → 页面按「不确定」处理、原编号重试。
  实测：别的连接锁住钱包行 9.5 秒，扣款 4.2 秒回 503、没有连接还在等锁、放开后原样重发办成且只扣一次；排队锁被占同样 4.3 秒 503。把这些去掉、恢复原来的 3 秒 + 8 秒时限再跑：扣款等了 9.5 秒才回（Prisma 事务时限到点没打断正在等锁的那一句，审查说的对）。
- 金额千分位（第 5 条）：流水里的金额 `signedYuan`（+¥5,000.00）。客户自己的余额页没动。
- 菜单「客户余额」点了没跳（第 6 条）：本机开发服务（从 /admin 首页、点过「充值审核」之后、从柜子收款页）和生产构建（next build + next start）各点了一遍都能跳，复现不出来；代码没改。最可能：开发服务第一次打开这一页要现编译，那几分钟机器在跑整套检查、编译慢，链接在编译完之前不改地址。
- 代理端关着的入口改叫「客户余额」（第 7 条）；水单站内路径不许 `..` / 以点开头（第 8 条）；一个提交编号不许既拿来加 / 减又拿来冲掉（第 9 条）。
