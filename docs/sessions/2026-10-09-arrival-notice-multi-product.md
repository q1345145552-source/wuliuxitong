# 2026-10-09 到货通知支持多款产品（本地交付完成，未推送 / 未上线）

老板 10-08 晚原话：「到货通知，只能填一款产品啊，很多时候是有好几款产品的」。
**10-09 凌晨老板切换 Claude 账号，后台工作流被打断（OAuth 令牌失效），这份是接手说明。**

## 已定方向（跟老板说过，他没反对）
- 照「创建订单」的产品行做（老板早先定过「到货通知的登记项跟创建订单一样」，交接文档 2026-10-06 第二节规则 1A）。
- 整票项不变：唛头、运单号、仓库、运输方式、到仓日期、备注、照片；产品部分改成多行（＋加一款 / 删一款 / 至少一款，最多 50 款）。每款：品名、件数、货型、国内快递单号，选填长宽高、单箱重、单箱数量。
- 单箱重 / 长宽高算得出时，总重量 / 总体积自动算、框只读；算不出照旧手填整票。
- 转运单：每款一个产品行；**要么全建、要么全不建**（待入库只要有一款没件数就一行都不建，件数显示「—」，订单品名拼成「灯具 / 鞋」）。
- 老数据：迁移把每条老到货通知回填成一款，文案一字不差。
- **多款文案（给客户的）——待老板确认**，先按这个做（只改 `notice-text.ts`）：
  ```
  您好！唛头 ABC-001 的货已到义乌仓，共 2 款、17 件。
  1. 灯具 × 12 件　国内快递单号：SF1234567890
  2. 鞋 × 5 件　国内快递单号：YT9876543210
  合计：17 件　重量：85 公斤　体积：0.62 立方
  到仓日期：10月6日
  如需安排发货或有疑问，请随时联系我们，谢谢！
  ```
  一款时跟现在逐字一样。

## 最新进度（收工结论，下面旧记录按时间保留）
- 接手清单第 1–5 项完成：修复、独立新 exec 审查清零、规模模拟、员工/超管浏览器清单、全量 CI 和单个本地提交。第 6 项部署尚未授权。
- 提交前另开全新 `review-r4-delivery` 核对交付记录与证据，结论无需修复问题；独立重算24文件哈希均一致。此轮是证据复核，不冒充再次亲测浏览器/全套CI/数据库。
- 最终两组：`final-ci-r2` **CI 64/64、一次性真库 19/19，全绿**；收工复核24个代码/测试文件哈希未变，与已测试版本一致。前一次误带 NODE_ENV=development 的环境失败保留，不拿它当产品问题。
- 浏览器剩余项已由 Codex 自行完成：超管转正式、详情及轨迹；员工/超管真实确认框都列出第二款的预报单号；两端实际生成17张标签（灯具12、鞋5，1/17至17/17）。各端控制台 error 为空；没把单测或模拟 HTML 当浏览器验收，也没有实际打印纸张。
- 工具卡点已解除：同时发起真实点击并观察原生弹窗事件，用受支持的 `Page.handleJavaScriptDialog` 确认/取消；打印通过浏览器键盘 Escape 退出原生预览后检查真实标签页。没有改业务 confirm 返回值。先前让老板反复找弹窗属于我的操作问题，不是缺授权或产品转单失败。
- 一次性库最终只读对照：员工/超管两票均 formal / inWarehouseCN / sensitive，2行17件；员工确认框取消的精度测试单未转。证据见 `browser/final-state.txt`。
- 本轮测试页、3026 / 4426 进程、55441 Docker 已清理；3000 / 3001 / 3005 的原 PID 均未变。假数据末态留在 `browser/state-final.sql`，权限0600，审计产物保留。
- **没有推送、没有上线；多款客户文案尚未得到老板明确拍板。** 本 session 保留到上线和部署后只读体检完成，避免丢交接点。

## 接手时状态（历史，别当作最新结果）
- **代码在工作区，未提交**（main 上最新是 fecc1be 唛头下拉，已上线；线上不含多款）。改动文件：
  - 后端：`apps/api/prisma/schema.prisma`（新 model `ArrivalNoticeProduct` → 表 `arrival_notice_products`）、新迁移 `apps/api/prisma/migrations/20261009_arrival_notice_products/migration.sql`（建表 + 幂等回填老数据）、`apps/api/src/modules/arrival-notices/routes.ts`、新共享模块 `packages/shared-types/arrival-notice-products.ts`、`scripts/check-schema-drift.sql`（57 表 / 720 列）、新只读体检 `scripts/check-arrival-notice-products.sql`（不进 deploy.sh，上线后手工跑）。
  - 前端：`apps/web/src/services/arrival-notice-api.ts`、`apps/web/src/modules/arrival-notice/{ArrivalNoticesView.tsx, notice-text.ts, missing.ts}`、`apps/web/src/app/globals.css`（.an-* 段）。
  - 测试：`scripts/test-arrival-notices-db.ts`（新增 N37–N49，N19e 改「产品明细变了」）、`scripts/test-migration-arrival-notices-db.ts`（新增 M1e）、`scripts/test-arrival-notice-source.ts`。`scripts/test-sim-fixes-1008-db.ts` **没改**（当老页面兼容回归，原样通过）。
  - 文档：`docs/api-contract.md` 第 22 节（新增 22.10）、`docs/domain-dictionary.md` 第 14 节 —— 描述的是多款，跟代码一起提交，别单独先提交。
- **集成全量检查全绿**：CI build job 63/63、test-db job 18/18（一次性库）。新测试在旧代码上确认会失败。⚠️ 现在 ci.yml 的 test-db 是 19 步，集成报告记 18 可能少数了一步，接手重跑为准。
- **本地复刻 CI 的两个脚本**：`.audit/tools/run_ci.py`（build 63 步）、`.audit/tools/run_testdb.py <端口>`（test-db，一次性库）——原在会话临时目录被清，10-09 从会话记录找回，用法写在文件头和完整版交接 7.1 节。
- **第 1 轮对抗审查提出 5 条，未复核、未修**（工作流在这之后被打断）。原文：`.audit/2026-10-09/multi-product/第1轮审查发现-未复核.md`。摘要：
  1. **[high]** 产品行算出来的总体积带 6 位小数，后端要求最多 3 位 → 保存直接 400；框是只读的，员工改不了。（只要填了长宽高就会撞上，必须修）
  2. [medium] 待入库时有一款没填齐，第 2 款及以后的国内快递单号在运单上看不到、也搜不到。
  3. [low] 待入库每款都有件数但有一款没品名：照样能打标签，标签印拼起来的品名。
  4. [low] 只有部分款填单箱重时，整票重量只算填了的款并盖掉手填总重（跟「创建订单」同一个老问题）。
  5. [low] 回滚再上线的场景：回滚期间旧代码对已有产品行的通知做的修改会被盖掉；体检 SQL 只计划在第一次上线跑。

## 接手要做的（按顺序）
> **10-09 起由 Codex 桌面版接手当主力**（Claude 额度快用完，只做复查）。审查改成「另开一个全新的 `codex exec` 会话挑刺」，下面第 2 条提到的 Claude 工作流脚本只当审查角度参考。分工和提示词见 `docs/交接文档-2026-10-09-完整版.md` 9.3 节。

- [x] 1. 逐条复核上面 5 条（真跑：一次性库 + 真 handler / 假 React），确认的修掉，每条补一个旧代码会红的测试。high 那条先修（体积按 3 位小数取整，前后端算法一致，后端也兜底）。
- [x] 2. 再跑对抗审查直到一整轮挑不出（三个角度：后端和数据 / 到货通知页面 / 转出来的运单在全系统的表现）。审查提示和角度可照 `.audit/2026-10-09/multi-product/实施方案.md` 第 5 节和本次工作流脚本（`~/.claude/projects/-Users-liuyujiang--------MyWebSite/161ef813-b821-4ab0-8b3d-78c638470c7e/workflows/scripts/arrival-notice-multi-product-implement-wf_84d7020f-db0.js`）。
- [x] 3. 模拟数据重跑（教训 41）：脚本在 `.audit/2026-10-08/sim-data/`（gen 造数据、r3/r3-rerun/fuzz 并发、behavior 新旧对比），补上多款到货通知的数据形状。
- [x] 4. 主控浏览器验收：`实施方案.md` 第 5 节末尾 10 条（员工、超管各一遍，控制台不能有 error，手机 375 宽）。
- [x] 5. 跑全量 CI（build + test-db）→ 提交一个本地 commit → 给老板看文案和截图。**本地交付完成；展示不等于文案已获确认，更不等于允许推送/上线。老板说「上」才部署。**
- [ ] 6. 部署后：`ssh -i ~/.ssh/xiangtai_deploy_20260720 root@76.13.181.104 "cd /root/MyWebSite && bash deploy.sh"`（迁移会自动先整库备份）；部署完手工跑只读体检 `scripts/check-arrival-notice-products.sql`（命令在文件开头），有输出先给老板看。

## Codex 接手执行记录（历史过程；各阶段结果以后续记录及顶部收工结论为准）

证据根目录：`.audit/2026-10-09/multi-product/codex-takeover/`。3000 / 3001 / 3005 没动；生产 / Neon 没连。
- [x] high 复现并修复：共享合计最后舍入到重量 2 位 / 体积 3 位，页面直接用共享结果；后端有自动值时不校验无效的旧页面合计。微小正体积舍成 0 仍按自动值处理；手填及产品输入校验保持。
  - A23 / N50 / 新增真实编辑器行为测试（假 React、非浏览器），修前红、修后绿；N50 真 handler + 一次性 PostgreSQL 覆盖保存→待入库→改备注→正式。仍待浏览器和独立审查。
- [x] CLI 登录有效；按原定 gpt-5.6-sol + max 新 exec 实测返回 OK。原文 `review-smoke/`。
- 基线：独立源码 / 依赖副本（不碰原 `.next`）跑 run_ci.py 63 步；其中客服源码测试首次红是我复制时漏 `.env.example`，补回公开样板原样复跑通过（`baseline/46-recheck.log`），不是产品问题。run_testdb.py 19/19；一次性容器 `zz-mp-codex-1009`、端口 55441。
- [x] medium：不建产品行时运单保留全部国内号，订单仍取第一个非空号；N51 真 handler + 一次性库验证员工 / 客户按第二号搜、跨客户隔离、再次修改同步和补齐后产品行。旧代码红，修后绿。
- [x] low：无完整产品明细的待入库单打印拦截，员工 / 超管调用接线已测；新旧回归都绿。全量首次发现提示顺序改变，已保留原来的没件数提示，标签 47/47、待入库显示 13/13。
- [x] low：部分单箱重提示复核（既有口径不改；E3 行为测试及员工 / 超管真实浏览器均确认提示、只读、清空后解锁并清总重）。
- [x] low：回滚再上线开放编辑前再次体检，mismatch 先保留两边交老板确认；迁移回归证明重跑不会自动修复旧镜像修改，文档缺流程时会红。

## 注意
- **部署窗口 / 回滚**：迁移在换容器前跑；旧容器那几分钟新登记的通知靠 `fieldsOf` 兜底能读；旧代码修改的会让产品行过时 → 体检 SQL 会列出来。回滚后旧代码只认主表镜像列（多款被汇总成一款），待入库单在旧代码里再存一次会被改回一行。**不能称为「不丢数据」：再次上线读取旧产品行，再保存会覆盖回滚期间的镜像修改。开放编辑前必须再次手工体检；mismatch 先保留两边、让老板确认修复，不自动回写。**
- 本地测试环境做法：一次性 docker 库（`docker run -d --rm --name zz-xxx -e POSTGRES_PASSWORD=zzpw -e POSTGRES_DB=zzbase -p 127.0.0.1:<端口>:5432 postgres:16-alpine`）→ `prisma db push` → `SEED_PASSWORD=随机 npx tsx apps/api/prisma/seed.ts`；API 用 `set -a && . ./.env && set +a && DATABASE_URL=<一次性库> PORT=44xx AGENT_REBATE_SCHEDULER=off npx tsx apps/api/src/main.ts`；前端用 `API_PROXY_TARGET=http://127.0.0.1:44xx NEXT_DIST_DIR=.next-e2e-xxx npx next dev --webpack -p 30xx`。**3000、3001 是老板的不碰**；next dev 会改 `apps/web/next-env.d.ts`、`tsconfig.json`，提交前 `git checkout` 还原。
- 生产只读；之前只读查生产库被自动权限拦过，别绕。部署前不 push。
- **Neon 测试库表结构停在 10-06**（没有 20261008 的 cargo_type / thumb_path，更没有 arrival_notice_products），这个活一律在一次性库上测；要连 Neon 先 `prisma db execute --file` 手动上迁移，别 `migrate deploy`。
- 完整交接（线上状态、换号须知、测试做法）：`docs/交接文档-2026-10-09-完整版.md`。

## 建议补的长期文档（记忆协议第 8、9 条，等老板点头）
- ADR 草稿「到货通知产品放子表 arrival_notice_products」：背景 = 一票多款；决定 = 子表（搜索第二款、级联删除、跟 order_products 一一映射），主表 item_name/package_count/domestic_tracking_no/cargo_type 留作镜像列给回滚和部署窗口；后果 = 每次保存要同时写镜像列，体检 SQL 查不一致。
- ADR 草稿「唛头选择统一用 MarkPicker」：只显示唛头；回车只在键盘选过时换值；打字一律按字筛（前缀账号）；键盘选中按唛头记；面板量剩余空间缩短或上弹。
- `docs/INDEX.md`、`docs/adr/`、`docs/glossary.md` 仓库里还没有（记忆协议提到的四层索引），术语目前在 `docs/domain-dictionary.md`。

### 本轮检查进度（持续更新）
- 真库全量 `work/db-summary.txt`：19/19。CI 首轮 63/64，失败是新打印 guard 抢先改了原有缺件数提示；已修正顺序，完整 CI 第二轮在 `ci-r2/`。
- 独立审查 `review-r1/`：新 exec、只读独立副本，仍在进行。规模模拟的新脚本在 `sim/` 准备中，尚不能算跑过。

### 新 exec 独立审查第 1 轮
- `review-r1/final.md` 5 条已逐条确认：打印 CI 红已保留旧提示修掉；真实客户主页面、代理漏第二国内号；200 条粗筛漏精确预报单；体检漏总重体积；保存、转单缺数据不一致硬闸。
- 新增 N52：旧版只改镜像或总重体积，新版保存和转单在锁内返回 409，不改任一边。N53：205 条候选中较老的精确号仍提醒，没确认不能转。N51 加真实客户主页面和代理列表、导出及隔离。
- 原实现红见 `r1-db-red-corrected.log`，体检红 `r1-migration-red.log`；修后真库 59/59、迁移 8/8。最初测试夹具漏必填项，已纠正重跑，不拿夹具报错当回归证明。
- 修复：体检增加派生总量；保存、转单硬闸防覆盖；候选分页不静默截断；真实客户、代理链路保留第二号。
- 前一轮 CI 第二遍 `ci-r2/ci-summary.txt` 64/64 通过；这些审查修复后还要重跑两组，不拿之前绿冒充最终。
- `ci-r3` 真库仍 19/19；CI 两项红：隐私测试的严格 select 夹具缺新查的国内号，已补；我把浏览器入口先放进了 CI 副本，代理保留字测试正确拦住，已移到 `browser-ui` 专用副本。两项单跑绿，最终全量待重跑。
- SQL 舍入边界：59×69×25×20 箱的 JS 值与先 cast numeric 再 round 差 0.001。体检必须按生产共享算法的求和顺序、EPSILON 和正数 Math.round 比对，不能把正常保存值报成回滚冲突。新增迁移回归先红后绿，日志 `r1-sql-round-{red,green}.log`，10,000 组探针对照原文 `rounding-crosscheck.log`。

### 审查清零及最终全量（规模模拟前）
- 全新 `review-r2` 无需修复问题；SQL 浮点对齐及隐私夹具收尾再开 `review-r3`，也无问题，原文各目录 `final.md`。
- 最新 `ci-r4`：CI 64/64、一次性真库 19/19，全绿。
- 开始第 3 项模拟：API 4427，库 55441/zzsim，本轮专用进程信息 `sim-api.process.json`。

### 规模模拟完成 / 浏览器进行中
- 模拟报告 `codex-takeover/sim/REPORT.md`：80 客户/2 代理/320 通知等规模，四端对 SQL 两遍均无差异；第二轮随机 2134 请求无 500/异常，隔离 30 轮编辑/转单/改号竞态通过；129 新旧场景业务一致（仅新生成产品 id 不同）、16 老形状一致。
- 首轮产品件数候选核实为旧版已有的「正式后改整票件数不改产品行」，打印保护仍有效；改号候选为后续另一组操作又改号。保留原日志，校正审计口径后重跑，不扩大范围改旧规则。
- 浏览器已实点员工两款卡片/复制、增删、保存中产品控件锁定、部分重量提示及解锁；旧 UI 创建→真迁移→新 UI 复制逐字相同。转待入库后原页控制工具超时，同一浏览器新页恢复，确认已转；员工/客户待入库件数 —、拼接品名、第二国内号搜索及无产品明细都已真看。截图 `codex-takeover/browser/`。超管及剩余清单尚未完，不标整项通过。

### 浏览器本轮续验 / 暂停点
- 员工 / 超管：第二款搜索、两窗口旧版保存拒绝、真实 CSS375 不横滚、旧文案复制一致、保存中产品控件禁用均已验；自动体积0.065与舍零0.000真实保存成功。
- 员工正式单、客户正式单已看两款12+5、各自国内号、整票最严敏感货；轨迹没有×0箱，客户看不到操作人身份。超管已看待入库缺件数及补齐后的两款17箱，转正式自身流程仍待补。
- 原生确认框工具读不到、打印标签窗口未出现在可访问tabs，没拿单测替代。问老板Chrome A/B后继续做完其余可做项，剩余没有打勾。
- 截图/剪贴板/三端error日志在 browser/（三端均[]；工具超时单独记，不伪装成产品控制台报错）。
- 模拟、旧版对照等不再用的7组进程已精准核对cwd/进程组后停掉；只保留当前浏览器3026/API4426和一次性容器55441，等待补验。数据库另存 browser/state.sql，环境只含假数据。3000/3001/3005原服务仍在，未动。

### Chrome 补验与最终CI结果
- 老板回复「A」，已授权换Chrome，仅新开 `🧪 湘泰多款验收` 的本地测试页（3026），原Claude标签未动。
- 点击超管 ZZBROWSERADMIN「转正式运单」，通过浏览器原生 Page.javascriptDialogOpening 事件读取实际确认正文，正确包含 YWYB0000001 / ZZADM002、重复建单风险及未通知提醒；原文 browser/chrome-admin-confirm.json。
- getJsDialog 正确返回 confirm，但 accept 操作超时（Emulation.setFocusEmulationEnabled）；后续 getJsDialog 不再返回对象，不能当成功。已按浏览器技能停止重试，请老板切专用标签手动点确定并回「好了 / 没有」。没有改页面confirm返回值，也没有用后端接口代替点击。
- 最终全量 final-ci-r2：64/64 + 19/19；退出 CI=0 DB=0。前一轮NODE_ENV误带开发值的失败日志保留，不当产品bug。

### Chrome 人工交接校正 / 打印续验
- 老板说「没看见我可以点的地方」：只读窗口截图与getJsDialog均确认没有弹窗，不是缺授权。测试标签仍在；筛出唯一ZZBROWSERADMIN，截图 browser/chrome-manual-handoff.jpg，明确先点「转正式运单」才会出现「确定」。
- 老板问「接下来呢」后复核：仍为待入库（到货通知与运单管理两页一致），没有假定其已手动完成。
- 独立打开超管运单管理，真点ZZBROWSERADMIN的打印按钮，生成1232044952「运单标签」页；点击/读取页面分别超时。原生窗口截图显示该标签在后台，未看到17页预览，所以打印仍未通过。停止重复尝试，未改产品代码、未实际打印纸张。
- 需保留1232044950到货通知、1232044951运单管理、1232044952标签预览；本轮均重新markHandoff。浏览器第4项与提交第5项仍未勾。

### 超管17张打印已核实
- 用户配合取消打印后，实际标签页共17张：灯具12、鞋5，箱号1/17至17/17，运单号/唛头/海运/条码正确；截图和DOM在browser/chrome-admin-labels*，控制台error为空。仅超管打印项通过，员工打印仍待补。
- 用户回复「好了」后，转单界面刷新与一次性库只读检查仍为inbound（待入库），没有假定已经转成功。用户具体点击后提示未明，剩余验收不勾选，未提交。

### 自主操作解除卡点 / 浏览器最终完成
- 老板要求「你直接去点，不要反复麻烦我」。已自行真实点击超管转正式，并经原生弹窗接口确认；页面显示已转运单，详情两款12+5、各自国内号/货型正确，轨迹没有×0箱。截图 `browser/chrome-admin-converted.jpg`、`chrome-admin-formal-detail.jpg`、`chrome-admin-formal-track.jpg`。
- 员工第二款撞预报确认框实测，原生消息包含 ZZADM002 / YWYB0000001；用原生接口取消，不产生新单。`browser/chrome-staff-prealert-confirm.json`。
- 员工真实点打印，用浏览器键盘 Escape 退出打印预览；实际标签页17张（灯具1–12、鞋13–17），截图/DOM在 `browser/chrome-staff-labels*`，没有通过改 window.print 伪造结果。超管此前17张也已核实。
- `chrome-{admin,staff}-final-console-errors.json` 都为空；打印、转单工具失败记录保留，区别于产品控制台 error。
- `final-code-reverified.json`：24个代码/测试文件与全绿CI时哈希相同。`teardown-final.json`：仅停本轮自己的进程组/容器，受保护的三个端口PID前后相同。所有本轮测试标签已关闭，原用户Claude标签没动。
