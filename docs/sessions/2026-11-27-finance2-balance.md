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
