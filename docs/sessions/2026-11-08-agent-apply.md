# 2026-11-08 代理申请第 1 轮：物流系统收申请、超管审批（工作记录）

任务来源：海外仓财务系统窗口（会话间消息转来，老板 11-08 说「开始第 1 轮」）。计划书在财务仓库 `docs/代理申请计划书.md`。
分支 `feat/finance-link-agent-apply`，从 main（d53e2df）拉。**只在本地提交，不推送、不上线。**

## 老板已定（原话，不用再问）
- 「财务提交，物流审批」。
- 已经是普通客户的，**新开一个代理号**，原来的客户号不动（不做「客户改代理」）。
- 密码由超管审批时设好，线下告诉对方（不做自助设密码页）。
- 通过以后对方要在海外仓财务系统用新代理号授权登录一次才绑上（不自动绑定，现有授权流程一行不改）。

## 做了什么
- 新表 `agent_applications`（schema 只加一个 model，迁移 `20261108_agent_applications` 手写、全部 IF NOT EXISTS，只建表和 3 个索引）；`scripts/check-schema-drift.sql` 登记 19 个字段（64 张表 / 809 个字段）。
- 对接接口（`finance-link/agent-applications.ts` + 纯函数 `agent-application-views.ts`）：`POST / GET /integrations/finance/v1/agent-applications`，路径加进 `FINANCE_LINK_PATHS`。`routes.ts` 只把 `linkError`、`requireFinanceSecret` 加了 `export`。
- 超管审批（`agents/application-routes.ts`）：`GET /admin/agents/applications/list`、`POST .../approve`、`POST .../reject`。
- 开代理的校验和建号从 `/admin/agents/create` 里原样抽成 `parseAgentCreateBody` / `agentCreateTakenMessage` / `agentCreateData`（`admin-routes.ts` 导出），开代理和通过申请共用；开代理的检查顺序、提示、返回没变（test:agent-admin 21 项、新测试 S10 钉顺序、连库 9 真开一次）。
- `main.ts` 注册两组新路由（各一行）。
- 页面：`admin/agents/page.tsx` 加「代理申请」页签（待审数标在页签上），列表和驳回框在新组件 `AgentApplicationsPanel.tsx`；`AgentFormModal.tsx` 多一个 `application` 参数 = 通过模式（名字、账号、电话预填；价和密码超管填）。`services/agents-admin-api.ts` 加三个请求函数。
- 文档：`docs/api-contract.md` 第 26.2 节。

## 我自己定的取舍（汇报时说清）
- **公司怎么定**：对接接口没有登录用户；拆派仓用环境变量 `CHAIPAI_COMPANY_ID`，这轮不许加环境变量 → 取「有正常（active）超管的那家公司」，只认正好一家，而且要跟表里已有申请的公司一致（Codex 第 1 轮）；0 家、多家、对不上都 503 `AGENT_APPLY_UNAVAILABLE`，不猜。线上 11-08 只读核过：超管、员工、代理、客户都在同一家公司。以后真开第二家公司要改成配置。
- **一个仓一张在审**：表里多一列 `pending_warehouse_id`（在审时 = 仓号，处理后清空），配 `(company_id, pending_warehouse_id)` 唯一约束 —— PostgreSQL 唯一约束里 NULL 不算重复，所以处理过的随便多少张，在审的只能一张；并发交只进得去一张（连库 2 项：8 个同时交 → 1 个 201 + 7 个 409）。用列 + 普通唯一约束而不是部分索引，是因为 Prisma schema 写不了部分索引，db push 建的测试库和 CI 库会没有那道闸。
- **不加外键**：跟 11-04 的 finance_link_* 一样，不跟用户 / 代理的删除搅在一起；处理人、开出来的代理只存编号（任务说「只新建这一张表和它的索引、外键」，外键没加，报告里写明）。
- **特货价**：通过弹窗的特货照开代理一样先填 1250（老板 10-11「2a」：新代理特货默认 1250），任务写的是「四档价和密码空着」，这一处跟老规矩冲突，按老规矩来，报告里写明。
- 交申请返回 201 `{ application }`、按仓查 200 `{ items }`，裸 JSON（跟 26 节对接接口一样）；400 用 `BAD_REQUEST` + 中文提示；409 `APPLICATION_PENDING`。
- 驳回原因去控制字符、去首尾空格；`warehouseId` 只认 JSON 整数 1～2147483647（PostgreSQL integer）。

- 提交人那一列库里叫 `submitter_name`（Prisma 字段 submitterName），给财务的接口字段名照约定叫 `submittedBy`：项目的「藏操作人」检查把 *By 字段都当成员工操作人，提交人是海外仓那边的人、不是员工账号，不该进那张名单。处理人 `reviewedById` 登记进了 `core/operator-visibility.ts`。
- 交申请在一个事务里：咨询锁 83090 排队 → 定公司 → 写（`scripts/test-lock-order.ts` 登记了 `lockAgentApplicationIntake`）。通过申请的事务：先 `SELECT … FOR UPDATE` 锁这张申请、锁里重读，再带条件改状态、建号、记账号（都带公司条件）；超时 15s / 等锁 5s，比网页 30 秒短。

## 审查（Codex gpt-5.6-sol max，只读，三轮，原文在 `.audit/2026-11-08/agent-apply/review-r1～r3/`）
- 第 1 轮 5 条必须修，全改：公司会随「当前唯一超管」悄悄换 → 加核对已有申请的公司；同账号两个超管同时通过时后到的报「账号被占」→ 回头看状态，已处理就 409；事务最后一步没带公司条件 → 补上；处理人被删后不显示是谁 → 显示编号；通过弹窗密码标签写「代理提供」→ 通过模式改成「你来设，线下告诉对方」。建议采纳：列表和张数同一快照、事务超时比网页短、ok() 挪出 try。
- 第 2 轮 2 条必须修，全改：表空时首次绑定公司能并发裂成两家 → 交申请排队锁 + 一个事务；页面「只认最后一次」会让后发先失败的扔掉先发成功的 → 改用 createQueryGate（成功才作废）。文档补上 503 的新情况。
- 第 3 轮：没有必须修。没做的建议：补「可控暂停」的并发测试、页面请求竞态的行为测试、把事务参数的 any 收紧（项目里事务参数一直是 `type Tx = any`）；财务新交申请后主动推送刷新待审数（对接接口没登录身份，现有推送按登录身份推；页面打开 / 切页签 / 处理后 / 别的超管操作时都会重拉）；logo 孤儿文件定时清理（跟开代理一样只在失败时删）；真跑 `prisma migrate deploy`（12 张表没迁移记录，影子库重放会挂，照 11-04 做法 db execute 连跑两遍 + migrate diff 零差异 + 体检）。

## 验证
- 新测试：`test:agent-apply-source` 11 项、`test:agent-apply-db` 19 项（本机 Homebrew PG 一次性库，含迁移文件那一项），都进了 package.json 和 ci.yml。
- 任务点名要照样过的：test:agent-admin 21 项、test:agent-foundation 全过、test:finance-link-source 38 项（W1 路径数 5 → 6）、test:finance-link-db 55 项。
- 全套（副本用 `cp -cR` 克隆依赖跑，不碰仓库的 Prisma 客户端）：build 组 79 / 79（含网页打包），test-db 组 37 / 37。记录在 `.audit/2026-11-08/agent-apply/ci*/`。
- 故意改坏 13 处（`mutation-results.txt` 10 处 + 后补 3 处），都至少一项测试变红（「账号被占不再看状态」只有错峰才走得到，连库撞不准，改成代码检查钉住）。
- 浏览器：临时库 + 临时后台 3121（财务开关开、随机测试密钥）+ 副本网页 3122，用对接接口交 3 张申请（第 4 张同仓 409），页面上页签「3 待审」、通过（预填名字 / 账号 / 电话，填价和密码开号）、驳回（空原因拦住、写原因驳回）、处理后的行显示结果和谁什么时候、「代理」页签多出新代理、财务那边查到 approved / rejected；通过弹窗密码标签、开代理弹窗照旧；控制台无页面报错。老板本机 3000 / 3001 没动。

## 没做 / 待办
- 不推送、不上线（任务写的）。上线时有一份迁移（只加一张表），deploy.sh 会先备份再 migrate deploy。
- `apps/web/next-env.d.ts` 是开发服务器自动改的，不进提交。
