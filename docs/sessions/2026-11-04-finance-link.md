# 2026-11-04 对接海外仓财务系统 · 第 1 轮（工作记录）

任务来源：财务窗口写好贴进物流窗口。修改清单 `/Users/liuyujiang/刘雨江的项目/海外仓财务系统/docs/物流运单对接修改清单.md` 第五、六、八节。
本轮只做物流这边：长期只读授权 + 运单状态接口 + 授权页。财务那边的页面在另一个窗口。

## 老板已定（原话，不用再问）
- 「物流系统要对接运单状态，只要运单就行了，集货的不要……登陆一次账号后就可以一直看到物流系统的运单状态了」
- 物流账号绑在财务的「仓上」；改物流密码后授权「失效，重新登录」；代理申请「财务提交，物流审批」（第二批，这轮不做）。
- 修改清单第三节是财务窗口加的做法，老板没单独确认过，不算老板定的。

## 改动范围规矩（老板 11-03 任务里写死）
只许改任务里列的文件；多改一个文件算没做完。要动公共组件先停下来问。

## 进度
- [x] 改动前截图：`.audit/2026-11-04/finance-link/shots/before/`（/login、代理前缀页；桌面 + 手机）。
- [x] 代码写完（分支 feat/finance-link，未提交）：模块 `apps/api/src/modules/finance-link/`（paths / config / status-zh / views / authorization / routes）、迁移 `20261104_finance_link`、授权页 `apps/web/src/app/login/authorize/page.tsx`。
- [x] 两个测试：test:finance-link-source、test:finance-link-db（已进 package.json、ci.yml）。
- [x] 基线 + 全套（`.audit/2026-11-04/finance-link/baseline/`、`full/C-final/`）。
- [x] 本机走一遍 + 对数字 + 截图比对。
- [x] 老板回 b（下面「名字」一节）。清单外两个文件已按我说好的改了。
- [x] 第 1 轮审查已修完（见文末）。
- [ ] 问老板要不要再审一轮、要不要提交（迁移、提交、推送、上线都要他点头）。

## 我自己定的技术取舍（汇报时说清）
- 状态中文：唯一来源在网页 `modules/shipment/shipment-status.ts`，后台镜像不带 apps/web，import 不了。抄一份到 `finance-link/status-zh.ts`，测试逐条比对网页那份。
- 授权页地址从财务调进来的域名算（只有三个配置，没有「物流前端地址」）：走 Next 看 x-forwarded-host；直连 api.xianlianth.com 时去掉 api.。线上一律 https。
- 一次性码的哈希把登录那一刻的账号、角色、密码指纹算进去：登录后、换授权前（5 分钟内）改了密码，码就作废。没加字段，表结构照修改清单。
- 同一个账号 + 同一个仓并发再授权：用 pg_advisory_xact_lock(83080, …) 排队，最后只留一条有效。
- 请求过期但 5 分钟的码还没到点：顺手清理时留着，能换授权。
- 列表和轨迹的范围都走 listScopedOrderIds（轨迹也挡没审过的单、整柜），比代理端轨迹接口严：代理端轨迹不看审核状态，这里跟列表一致。

## 名字（分清他说的和我理解的）
- 他问「名字就是唛头吧？」，我说不是一回事（唛头 = users.id，名字 = users.name，比如 XHH6700 / 杨先），给了两种做法并建议全部填唛头。
- 他回了一个字「b」。最早的按钮里 B 是「名字照给」，上一条里第二个做法是「所有人都填唛头」。我按后者做，因为他前一句就是要名字=唛头、这样也不外传名字，并且明确告诉他了，他要是指前者改回去很快。
- 做法：`account.name`、`clients[].name`、`clientName` 字段名沿用修改清单，值一律是唛头；模块里不再查 users.name。普通客户仍不返回 clientName。财务窗口要知道：这几个字段显示出来就是唛头。

## 已知限制（原来就这样）
- `remarkForAgent` 只抹系统模板拼的「管理员…」和柜号。员工手写进备注的人名抹不掉，客户端、代理端一样（core/operator-visibility.ts 写明了）。
- `passwordFingerprint` 用 AUTH_SECRET 算：换 AUTH_SECRET 时全部授权会变成 PASSWORD_CHANGED，要重新授权。
- `partialAhead` 给的是状态码（同代理端列表），不是中文。要显示「（部分已到仓）」财务那边得自己翻译。

## 11-04 做到哪（关机一次后接着做）
- 走查（一次性库、经 Next 转发，同线上路径）结果在 `.audit/2026-11-04/finance-link/walkthrough-output.txt`；28 种改坏全抓到 `.audit/2026-11-04/finance-link/mutation-results.txt`；截图比对 `.audit/2026-11-04/finance-link/shots/`（stable2 = 改动前后代码各拍 3 次；final = 最终版）。
- 全套基线（HEAD 016bcc5）：build 76/76、test-db 35/35，`.audit/2026-11-04/finance-link/baseline/`。
- 清单外两个文件（我说「你回了就算同意改」，他回 b 之后改的）：`scripts/check-schema-drift.sql`（登记两张新表）、`scripts/test-mark-display.ts`（只放行 views.ts 里 `clientName` 这个字段名，值是唛头）。
- 临时库：本机 Homebrew PostgreSQL 16，放在会话临时目录（`pg55493` 走查、`pg55494` 全套），用完 pg_ctl stop。

## 第 1 轮审查（Codex + dsh，提示词和原文 `.audit/2026-11-04/finance-link/review-r1/`）
Codex 报 7 条必须修，dsh 没有必须修（只提醒先提交再上线）。逐条核过：
- 修了：一次性码绑公司、账号在事务和锁后重读；子单只认同一张订单；多产品国内单号用 `domesticNosLabel`；手写「柜号：XXX」先过 `maskLabeledContainerNo`；账号超 100 位不让授权；测试不再自动放行 Neon（一律要 ALLOW_DB=1）。
- 建议里修了：链接先核再看账号锁定；授权页超长字段直接挡；普通客户拼的身份不带 agentId；`api.` 只认 api.xianlianth.com；授权页 429 提示、不走缓存；测试补公司变更、回滚后码还能用、逐字段比对。
- 不改：账号存在性的响应快慢差异（`/auth/login` 原来就有，只修授权页没用，要改得动登录，不在这轮清单）；授权页地址加白名单（只有带对接密钥的请求才算这个地址，财务后端不转发用户的请求头）；`partialAhead` 受脏子单影响（复用现有函数，客户端代理端一样，只影响一个状态码）；公司变更的原因码（约定只有四个原因）。
- 变异检查第一遍有假抓到：改坏后测试崩了也算「抓到」。原因是用例中途失败时账号留在别的公司、清数据清不到，后面全在造数据时崩。已修测试清理和脚本（崩了不算抓到）。

## 第 2 轮审查（`.audit/2026-11-04/finance-link/review-r2/`）
- 改了：手写柜号改成 views.ts 的 `maskHandwrittenContainerNos`（一个、好几个、带空格都抹，碰到中文停，后半句留着）；运单列表不接日期（约定只有四个筛选，`2026-99-99` 不会再 500）；授权页密码上限放到 1024（开客户账号不限长度，200 会把能登录的长密码挡掉，是第 1 轮我改出来的）；文档写清「货拉拉」占位。
- 不改：一次性码在封禁又解封后 5 分钟内还能用（解封了本来就能再登录，没多给什么；防它要给用户表加版本字段）；响应快慢差异（登录接口有同样的，单改这里没用，Codex 和 dsh 意见不一，我跟 Codex）；地址白名单、服务端 no-store、查询限流（约定没有，碰不到真风险）；partialAhead 脏子单（复用现有函数）。
- 财务那边不用动：`clientLabel` 已按「名字也填唛头」处理，`partialLabel` 已翻译状态码（Codex 说会拼原始码，我读了 logisticsLink.ts，不对）。
- 代理端的日期问题原来就有：`/agent/shipments?dateTo=2026-99-99` 会 500，不在这轮范围。
