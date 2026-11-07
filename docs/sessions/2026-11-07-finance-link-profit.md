# 2026-11-07 代理利润第 1 轮：对接接口多给货型、方数、下单时间（工作记录）

任务来源：财务窗口写好贴进物流窗口（「物流系统 · 代理利润第 1 轮」）。计划书在财务仓库 `docs/代理利润计划书.md`。
本轮只改物流对接接口的运单列表：一行多给 4 个字段、加「下单月份」筛选。利润在财务系统算，这边照旧不给任何金额。

## 老板已定（原话，不用再问）
- 混装：「单独算吧」—— 每个产品行按自己的货型分开算。
- 到仓实量跟客户报的对不上：「直接显示实际的不就行了吗」—— 用整票实量，按客户报的各行比例分（财务那边算，物流只给原始数）。
- 没到仓的票：「行，标预估」。
- 合计范围：同意「必须选月份才合计、按泰国时间分月」。

## 改动范围（任务里写死，多改一个文件算没做完）
允许：`finance-link/views.ts`、`finance-link/routes.ts`、新建 `finance-link/order-month.ts`、`scripts/test-finance-link-source.ts`、`scripts/test-finance-link-db.ts`、`docs/api-contract.md` 第 26 节、`docs/` 下工作记录。
不许：`agent-portal/routes.ts`（一个字节不改）、`packages/shared-types/cargo-type.ts`（只引用）、`schema.prisma` 和迁移、前端任何页面。
分支 `feat/finance-link-profit`，从 main（eb5705d）拉。

## 做了什么
- `views.ts`：`mapWaybillRow` 逐个多给 `orderedAt`（订单 createdAt，loadShipmentRows 已转 ISO）、`cargoType`（只认四个值，别的给 null）、`estimated`（approvalStatus === "shipped"）、`products`（每项只有 `cargoType`、`declaredVolumeM3`）。老字段一个没动。
- `order-month.ts`：只放 `parseOrderMonth` / `orderMonthRange`，纯函数。
- `routes.ts`：运单列表读 `orderMonth`，格式不对 400；`listScopedOrderIds` 之后用 `keepOrderMonth` 按订单 createdAt 再筛一遍，顺序不变，total 和分页用筛完的。轨迹、授权、别的接口没动。

## 我自己定的技术取舍（汇报时说清）
- 产品行方数按十进制精确乘（每个数按它最短的十进制写法拆成整数），四舍五入到整立方厘米再除以 1,000,000，结果正好 6 位小数、不带浮点尾巴。第一版直接用浮点乘，10 × 1.5 × 4.1 这种正好半立方厘米的会少舍 1 立方厘米（Codex 审查抓到，已改，测试里逐个比精确值）。四样都是正数但小于半立方厘米的会舍成 0（不现实，测试里写明了）。
- 货型严格比对：`" normal"`、`"Normal"`、中文「普货」都给 null（库里存的只会是英文小写，别的值说明数据有问题，不替人猜）。
- 月份不去首尾空格、不认全角数字；网址里同一个参数传两次时，整个后台都按最后一个算（server.ts 的写法，这轮不许动），所以 `orderMonth=2026-11&orderMonth=2026-12` 按 2026-12 筛，不报 400。
- 筛月份时订单 id 按 5000 个一批查，名下单子再多也不会把一条查询撑爆。`keepOrderMonth` 导出、带一个只给测试用的每批个数参数，连库测试 P6 用 1～9 个一批验证不丢、不重复、不乱序。
- 产品行顺序靠 `loadShipmentRows` 查的时候 `orderBy: { sortOrder: "asc" }`；sortOrder 一样的几行，顺序跟代理端列表一样由数据库定。

## 三种单的方数是谁填的（`estimated` 怎么来）
- 客户预报单：建单时 `approvalStatus = "shipped"`，方数是客户报的（按产品行长宽高 × 件数算；算不出来时用客户手填的整票方数）→ `estimated: true`。
- 仓库确认收货（`/staff/prealerts/receive`）：改成 `"received"` → `estimated: false`。弹窗里方数预先填着客户报的数，员工改了才换成量出来的数，不改就还是客户报的。确认收货不改产品行的长宽高和货型；只有一个产品行时，改的箱数会同步到那一行。
- 员工建单、到货通知转运单：`buildNewOrderRows` 写 `"approved"`，方数是员工在仓库填的 → `estimated: false`。

## 第三部分：线上 5 个数
老板 11-07 说「去查吧」后只读查了生产库（`BEGIN TRANSACTION READ ONLY … ROLLBACK`，只回审核状态、货型、方数、产品行尺寸，不回唛头 / 单号 / id / 名字 / 金额）。数数在本机用仓库里的 `strictestCargoType` / `declaredVolumeM3`（`prod-counts.ts`）。范围同对接接口：已审核 / 已发货 / 已收货、去掉整柜，共 2952 票（已审核 2944、已发货 8、**已收货 0**）。

| # | 数什么 | 线上 |
|---|---|---|
| 一 | 混装（产品行货型不止一种） | 92（全是已审核） |
| 二 | 整票货型跟产品行最严的不一样 | 289 |
| 三 | 混装且有产品行缺长宽高 | 0 |
| 四 | 没有产品行的老单 | 0 |
| 五 | 混装、已确认收货、各行方数加起来跟整票差超过 0.001 | 0（线上范围内一票已收货的都没有，所以是 0） |

第二个数的情况（同样只读、只回日期和票数）：
- 289 票全是「整票写普货、产品行里有更严的」：产品行最严是敏感货 160 票、商检货 129 票；其中 50 票是混装，239 票产品行全是同一种。
- 全部是 9 月 10 日（北京时间）及以前下的单：6 月 53、7 月 63、8 月 118、9 月 55（9-01～9-10）；**9 月 11 日起一票都没有**。9-11 那次改动（0d7bfba / 12ab801）起整票货型按产品行最严的定。
- 计划书猜的「仓库确认收货时改了整票货型」在线上没发生过：线上范围内没有已收货的单。

材料：`.audit/2026-11-07/finance-profit/prod-rows.json`（只有货型方数尺寸）、`prod-mismatch-months.out`、`prod-mismatch-days.out`。

## 验证（本机一次性库 127.0.0.1:55507，没碰 Neon 和生产）
材料在 `.audit/2026-11-07/finance-profit/`（本地，不进 git）：
- 两个 finance-link 测试：不连库 38 / 38（原 31 + 新 7），连库 55 / 55（原 48 + 新 7，含审查后补的 P6、P7）。
- 全套：改前（`baseline/`，eb5705d）build 组 76 / 77、test-db 36 / 36；改后（`after-full/`）一样 76 / 77、36 / 36。没过的那 1 项两边都是「Build frontend」，原因是副本里依赖目录是链接、打包工具不认（日志同一句报错），不是代码；改后另用克隆的依赖目录单独打包网页，通过（`web-build-after.log`）。
- 混装预报单（`after-final/prealert-*.json`）：确认收货前 cargoType sensitive、products 两项各 1 方、totalVolumeM3 2、estimated true；填实量 2.4 确认收货后 totalVolumeM3 2.4、estimated false。
- 下单月份：代理固定数据不带 5 条、2026-11 是 3 条（报完预报单后 6 条 / 4 条）；2026-99-99 等 12 种写法都是 400。
- 响应全文搜金额、柜号、收件人、内部备注、订单号、内部 id、相关字段名：命中 0。
- 改前（`before/`）改后（`after-final/`）同一批数据：比了 127 个老字段，不一样 0 个；每行新增的正好是那 4 个。
- 故意改坏 12 处（`mutation-results.txt`）：每处都至少有一项测试变红。

## 审查（老板 11-07 回「你做好了再说」后补做）
意见原文在 `.audit/2026-11-07/finance-profit/review-r1/`、`review-r2/`、`review-r3/`（Codex gpt-5.6-sol max，只读沙箱；第 1 轮另有 dsh）。
- 第 1 轮 Codex 必须修 1 条：产品行方数直接用浮点乘，正好半立方厘米的会少舍 1（10 × 1.5 × 4.1 = 61.5 乘出 61.4999…）→ 改成十进制精确乘（`toDecimalParts` + BigInt）。dsh 没有必须修。
- 第 1 轮建议、已做：注释写错一处；V10 公司过滤断言太松（参数名就叫 companyId）；P1 排序测试分不出「按货型字母排」；补 P6（分批 1～9 个、别家公司）、P7（同一参数传两次）；接口文档写清 `estimated` 只看审核状态（确认收货没改方数也是 false；还没收货被超管在运单编辑里改了方数仍是 true，这条代码核实过：`/admin/orders/update` 没挡已发货的预报单）、产品行方数只用来按比例分。
- 第 1 轮建议、没做：小数件数（库里是 Int 到不了）；名下单子多时的性能（上线后看）；`estimated` 口径（任务写死按 shipped）。
- dsh 提的「10-18 以前员工编辑会把到仓日期写进订单 createdAt」：代码核实属实（c2506bb 以前 patch-shipment-bundle 写 `createdAt: arrived`，线上后台时区 UTC）。只读查线上（`prod-createdat-check.sql`）：范围内 2952 票没有一票的下单时间落在 UTC 零点，每票都跟主运单建单时间差不到 60 秒，泰国时间月份 0 票不同 —— 线上数据没受影响，`orderMonth` 按现有 createdAt 分月可信。
- 第 2 轮 Codex 必须修 1 条：超过 2^53 立方厘米时整个 cm3 先转 Number 会差最后一位 → 改成商和余数拼十进制再转。建议、已做：补科学计数法两组；P1 的产品行 id 改成升降序都跟 sortOrder 不一样；`chunk` 不是正整数直接报错。
- 每处修复都做了变异：改回老写法测试必红（`node22/after-review-r1.txt`、`after-review-r2.txt`、`mutation-p6.txt`）。

## Node 22（线上同版本）
Docker 里 node:22.23.4-alpine + postgres:16-alpine 一次性库，跟 GitHub test-db 组一样只装根目录依赖：不连库 38 / 38、连库 55 / 55（`node22/`）。

## 没做 / 待办
- 线上 5 个数 11-07 已只读查完（见第三部分）。
- 老板说「提交吧」后提交到本地分支 feat/finance-link-profit（不含 apps/web/next-env.d.ts）；没推送、没上线（这轮先不上线）。
