# 2026-10-11 对接拆派仓（工作记录）

任务来源：老板把拆派仓会话写的任务贴进本窗口（第一次贴的「代理系统对接说明」他说发错了，作废）。
任务和修改清单原文（10-12 00:02 版，按老板全部拍板改过）：
- `/Users/liuyujiang/刘雨江的项目/拆派仓/docs/湘泰物流系统对接任务提示词.md`「已经定了的」节
- `/Users/liuyujiang/刘雨江的项目/拆派仓/docs/湘泰物流系统对接拆派仓修改清单.md` 第二节
拆派仓已定：第 238～257 条（原话记在拆派仓 `docs/sessions/2026-09-25-photo-purpose.md` 第 724 行起）。

## 进度
- [x] 特别货 + 建号修复已在 main 本地提交 8c2635d（未推未上线）；新活在分支 `feat/chaipai-integration`。
- [x] 只读调研（报告 `.audit/2026-10-11/chaipai/` 1～4；4 号是旧设计，下面「新设计」为准）。
- [x] 10-12 老板把剩下的全定了，按新规矩改设计（本文）。
- [x] 10-12 动手做完（分支 feat/chaipai-integration，未提交时见 git status）：模块 `apps/api/src/modules/chaipai/`（config / manifest / manifest-routes / events / read-client / event-routes / photo-routes / routes）、迁移 `20261012_chaipai_integration`（Neon 测试库已执行，生产没动）、前端 `ChaipaiPhotos.tsx` + 轨迹弹窗挂载、不许单删新原因 `chaipai`、重量口径抽成 `split-metrics.ts` 的 `loadedWeightKg`（装柜清单导出共用）。
- [x] 测试：test:chaipai-source 20 项、test:chaipai-db 22 项（真库 + 本机假拆派仓；3 个变异都能抓到）、test:migration-chaipai-db 4 项（本机一次性库）；已进 package.json + ci.yml。
- [x] 本机联调（拆派仓源码复制到会话临时目录跑，原件没动）：扫码台拉清单（柜号带空格小写也对上；5 票、没填重量那票被拆派仓退回；再拉「没变化 4」）→ 扫码到仓（含少件）→ 排线 → 装车 → 出车 → 司机拍照签收 / 一站送不成拉回仓。湘泰这边：状态、轨迹、自动派送单（同一趟车同一个 WD、自营、司机车牌、曼谷日期）、签收图、撤单全对；客户轨迹弹窗看得到签收单、看不到「派送照片」和「拆派仓」字样；管理员看得到「派送照片」和操作人；尾端派送页显示正常；控制台无报错。
- [x] 全套 83 项第一遍全过（51fd1ae）。
- [x] 第 1 轮审查（`.audit/2026-10-12/chaipai/codex-r1.md`、`dsh-r1.md`）→ 修了一批，提交 99bf78a；处理清单见 `review-prompt-r2.md`。
- [x] 第 2 轮 → b04d5d7；第 3 轮 → 748451d；第 4 轮 → 本次提交（每轮原文 `.audit/2026-10-12/chaipai/{codex,dsh}-rN.md`、处理说明 `review-prompt-rN.md`）。dsh 第 2 轮起「没有必须修」；Codex 每轮还在挑换趟 / 404 这类边角，逐条核对后真的都修了、补了测试和变异。
- 不改的（理由在 review-prompt-r2/r3/r4）：挂两柜的票剔除（生产 0 票）；连库测试库闸照仓库约定；PNG 标 jpeg（Chromium 实测正常、手工签收本来如此）；体检 SQL 只核字段；迁移未被任何库登记过所以就地改；回传不比对运单号（员工能改号）。
- [ ] 第 5 轮审查 → 汇报 → 等「上」（带迁移）→ 上线开关关着 → 交两个接口地址（生产 nginx：xianlianth.com 走 Next 转发、api.xianlianth.com 直通后台，两个都能到）。

## 老板已定（不用再问）
- 拆派仓来拉清单，湘泰不推；唛头 = `Order.clientId`；公司编号 xiangtai。
- 状态以拆派仓为准、往回走也跟，只改成 已到泰国仓 / 派送中 / 已签收 三个；每次变化写一条轨迹。
- 派送中 / 已签收**自动登记尾端派送单**（甲）：承运商「自营」（转交了就写对方物流名 + 对方单号）；司机、车牌从拆派仓只读接口取；同一趟车同一个 WD 号；签收改已签收、签收图放这票最新一张照片；送不成拉回仓撤单（照「改派」删旧行）；已签收后往回走照「撤销误签收」。已有员工手工登记且还在派送中的单：不新建，在那张单上改。不拦员工手工登记。
- 客户看签收单（尾端派送记录里那张，轨迹弹窗原样显示）；拆派仓其他照片只给员工看，标题「派送照片」。
- 先收到「泰国已装车」：湘泰还在已到泰国仓之前就提到已到泰国仓。
- 拆派仓写的轨迹不许单删；备注不出现「拆派仓」；操作人记「拆派仓」只有超管看得到。
- 加三张表（消息记录、每票最后状态、清单版本）。
- 代理名下客户的货照放；整柜不给（填整柜柜号回 404）；取消 / 退回不会发生，不设计；推柜子规则不改。

## 新设计（10-12）
### 配置
6 个变量照清单：`CHAIPAI_ENABLED / COMPANY_ID / PULL_SECRET / CALLBACK_SECRET / READ_SECRET / API_BASE`。
旧设计里的第 7 个 `CHAIPAI_LOCAL_COMPANY_ID` 去掉：柜号、运单 id 全库唯一，公司编号直接从查到的柜子 / 运单上取。

### 三张表（只加不删，手写迁移）
1. `chaipai_callback_events`：event_id 主键、company_id、source_company_id、shipment_id、sequence、status、occurred_at、payload_hash、payload、result、received_at。不加外键。
2. `chaipai_shipment_states`：shipment_id 主键（外键 CASCADE）、company_id、last_sequence、last_event_id、thai_status、occurred_at、actual_box_count、shortage、**route_id、delivery_no、lastmile_order_id**（自动派送单用：同一趟车同一个 WD；记着是哪一行）、created_at、updated_at；route_id 加索引。
3. `chaipai_manifest_versions`：shipment_id 主键（不加外键）、company_id、content_hash、version_at、updated_at。

### 拉清单 GET /integrations/chaipai/v2/container-manifest
同 4 号报告第三节，改两处：整柜（`isFcl`）当没这个柜回 404；代理客户照放。

### 收回传 POST /integrations/chaipai/v2/events
1. 校验、去重（eventId）、判新旧（sequence）同旧设计；找不到票记日志回 IGNORED_OLDER。
2. 目标状态：
   - ARRIVED → 已到泰国仓。
   - LOADED → 现在在已到泰国仓之前，或在派送中 / 已签收（说明中间那条「回仓」丢了）→ 已到泰国仓；已到泰国仓 / 已预约派送 → 不变。
   - OUT_FOR_DELIVERY → 派送中；DELIVERED → 已签收。
3. 派送中 / 已签收要先去拆派仓只读接口取：司机、车牌、出发时间、转交信息、照片列表（签收时再下载最新一张）。在事务**外**取；取不到（网络 / 5xx）回 503 让拆派仓过一会儿重发，不写任何东西；只读接口说没这票（404）就照常办、司机车牌留空。
4. 尾端派送单（锁序跟员工手工那条一样：号码锁 2901 → 派送单行 → 运单 → 父单）：
   - 派送中：这票已有「派送中」的单（自动的或员工手工的）→ 不新建，用那张（自动的那张更新转交信息）；没有 → 新建：同一 route.id 已有 WD 号就复用，没有就照手工那条发新号；承运商「自营」或转交物流名；派送日期 = 出发日（曼谷）；电话空。轨迹照手工写「司机【张三】正在为您派送，请注意查收」/ 没司机写「正在为您派送，请注意查收（WD…）」/ 转交写「已交给【某物流】派送，单号 …」。
   - 已签收：把跟踪的那张（没有就找这票派送中的；都没有就直接建一张已签收的）改成已签收，签收图 = 拆派仓这票**签收时间之前最新的一张**照片（都在之后就取最新一张）；轨迹「尾程派送已签收（WD…）」。
   - 往回走（派送中 / 已签收之后又收到已到仓、已装车）：已签收的先照「撤销误签收」退回派送中（写「撤销误签收」那条），再把这票派送中的那张删掉（照「改派」删旧行），运单回已到泰国仓，轨迹「未送达，已回泰国仓」。拆派仓里签收是终点，正常只会是员工在湘泰手工签过才碰上。
5. 轨迹：时间用 occurredAt；操作人 id `chaipai`、角色 `system`、名字「拆派仓」；备注不出现「拆派仓」。
   编号：已到仓 / 已装车 `sl_cp_`（新加一种「不能删」原因）；派送相关 `sl_lm_cp_` / `sl_lmdel_cp_` / `sl_lmunsign_cp_`（现有规则本来就不让删）。
   同一个粗状态重复来（拆派仓细状态开关打开时）只记账本，不重复写轨迹；转交信息变了才补一条。
6. 提交后推实时刷新（shipping）；回裸 JSON `{eventId, result}`。

### 照片
- 客户：不加东西，轨迹弹窗派送信息里原来那张签收图就是拆派仓那张。
- 员工 / 管理员：轨迹弹窗每个页签的派送信息下面加「派送照片」一块（只在 viewerRole 是 staff/admin 时出现），接口 `GET /staff/shipments/chaipai-photos`、`/staff/shipments/chaipai-photo`，后台带只读密钥去取；按拍照时间排；410 显示「照片已过保留期」、其他错误「暂时取不到照片」。这票没收到过回传就不显示、不去查。

### 其余照旧
server.ts 对 `/integrations/` 不跑登录解析；next.config 加 `/integrations` 转发；agent-rules 保留字加 integrations；realtime topics 加一条；env 样板 + docker-compose 加 6 个变量。

## 我自己定的技术取舍（汇报时说清）
- 一票挂两个柜的老数据不发、记日志；柜号对上两个柜报错。
- 方数 / 重量没填、运单号带空格的票原样发，让拆派仓逐票退回（员工在拆派仓弹窗里看得到）。
- 派送中时这票挂着员工手工登记的派送中单：拆派仓说回仓了也一起删掉（不然运单在仓、单子还说派送中）。
- 只读接口取不到 → 回 503 让拆派仓重发（拆派仓约 4 小时内重发 10 次，之后要在拆派仓「补发」）。
