# 2026-10-11 新增货型「特别货」（工作记录）

拍板（老板原话见记忆 special-cargo-type.md）：存 `special`；混装最严（特别 > 敏感 > 商检 > 普货）；
仓库版集货建柜加客户时特别货单价默认 1250、能改（1A）；给代理的特别货价默认 1250（2A，代理管理里能改）。

## 进度
- [x] 第一批（不算钱的）：共享 cargo-type.ts 加 special + cargoTypeZh；运单（建单 / 改单 / 预报单 / 批量导入）、到货通知、整柜（含模板旧表头兼容）、普通版集货、各处显示和导出；老测试跟着改（cargo-regressions、fcl-containers、arrival-notices-db 一句报错文案）。两套 tsc 过。未提交。
- [x] 基线：原版 835014e 全套 82 项；Neon 补了 20261008 / 20261009 两份迁移后全绿。
- [x] 第二批（算钱的）后端：仓库版集货建柜 / 加客户 / 改单价（特别货没传按 1250）、按货型算费和费用明细、客户报货能选特别货、付款快照两列、返现（老快照没特别货补 0）、代理价（新开默认 1250；老页面只传三档时沿用原值）、长期价（停用；没传特别货沿用原值、下限按原值判）、代理端各接口。
- [x] 第二批前端：超管 / 员工 / 客户三个仓库版集货页（建柜、加客户、改单价各多一格特别货，默认填 1250）、货型下拉和显示收成共享名单、代理管理编辑框第 4 格、代理列表 / 返现单 / 代理端「我的价格」「客户和价格」「返现」。web tsc 过。
- [x] 库：手写迁移 `20261011_special_cargo_type`（8 列，只加不删）；check-schema-drift.sql 728 个字段；新迁移测试 test:migration-special-cargo-type-db（package.json + ci.yml），本机 docker 一次性库 5/5 过，故意改错默认值会红 3 项。**Neon 测试库已加这 8 列**（生产没动）。
- [x] 测试：test-agent-foundation 加 20/21、test-agent-admin 加 10b、test-agent-rebates 加 4b、test-whr-long-term-price 加 S1–S6 + S4b；三处关键逻辑都做过「改坏会红」。测试用的内存库（whr-memory-db.ts）补回 price_special。
- [x] 全套 82 项：第一遍 79 过 / 3 红（typecheck:scripts、agent-portal-isolation、agent-domain-display，都是老测试写死三档的期望值 / 类型），改完复跑全过；基线那两项红（Neon 缺迁移）这次也过了。迁移测试在 Neon 上照例跳过，本机一次性库真跑 5/5。
- [x] 浏览器实测（一次性 docker 库 + 临时 4402 后端 + 副本 3019 前端，跑完全拆）：开代理特别货默认 1250、改成 1200 保存；建柜每人多一格特别货默认 1250；改单价低于代理特别货价被挡并点名；客户列表 / 柜详情显示特别货价；客户报货下拉有特别货；费用明细「特别货 1 方 × 1250」；真库签收 ¥1800、付款快照 paid_price_special=1250；运单建单产品行下拉有特别货。
- [x] 第 1 轮 Codex（gpt-5.6-sol max）+ dsh 审（`.audit/2026-10-11/special-cargo/` codex-final.md / dsh-final.md）。Codex 必须修 1：建客户号密码可不填 → 前后端都改成必填（员工号仍选填，提示里写「还没设密码」）；建议 2：签收路由补真库测试（test-fix-0929-db F5s，改坏会红）、长期价接口改成用锁里返回的四档（setClientWhrPrice 返回 prices）。dsh 必须修 0；建议 3：改代理价手写 SQL 补真库测试（test-agent-portal-isolation，改坏会红）、编辑客户「显示密码」文案按编辑态改、UnitPrices.unitPriceSpecial 改必填（顺带修 test-fix-0929-source 字面量）；过时注释两处顺手改。没改：运费配置死配置、长期价开回来时的柜里价下限（写接口关着）。
- [x] 第 2–5 轮 Codex + dsh（每轮只看上一轮之后的修改，报告都在 `.audit/2026-10-11/special-cargo/`）。第 5 轮两边都「未发现必须修」。这几轮改的：
  - `POST /admin/users` 带 role=client 也必须有密码（闸挪到查代理之前）；`createAdminClient` 类型密码必填。
  - 建员工 / 建客户（含编辑）弹窗里画红色报错条（校验 + 后端失败都进来），打开入口和「取消」在请求中置灰（防旧请求的报错写进新弹窗），弹窗矮屏可滚。
  - `setClientWhrPrice` 返回 `{ updatedPlanRows, prices, updatedAt }`，超管 / 代理两个长期价接口都用返回值，不在事务外补读。
  - 新测试：test-admin-overview（建号空密码 / 名字留空 / 编辑留空不发密码 / 弹窗报错条与置灰源码检查）、test-whr-long-term-price 24b（两个开户入口）、test-agent-foundation updatedAt；都做过改坏会红。
  - 本机浏览器（工作区代码 + 一次性库）实测：弹窗里依次显示「请填写客户名字和电话号码」「请填写登录密码」「添加失败：该客户账号已存在」，取消重开干净。
- [x] 最终全套 full-1011e：82 项 + tsc-web + tsc-api 全过；之后改过的 9 项 + 两套 tsc 单独复跑全过。
- [ ] 跟他汇报 → 等他说「上」（特别货带迁移 8 列，deploy.sh 会自动备份；建号修复同一次上，或只上建号修复 = `.audit/2026-10-11/login-fix/` 里的两个单独版文件）
- 没改（审查提过、我判断不影响）：运费配置死配置；长期价开回来时的柜里价下限；刷新失败提示复用 message；禁用按钮无视觉变化；100dvh 无 vh 兜底；部分「三档」注释。
- 同一工作区里还有「建号密码看得见」那处修复（admin/page.tsx + admin/routes.ts 客户建号密码必填），单独版在 `.audit/2026-10-11/login-fix/`（注意：单独上线时 admin/routes.ts 那句「登录密码为必填」也要带上）。

## 我默认、没单独问的
- 「运费配置」那页（本来不算钱）不加特别货。
- 到货通知文案、装柜单、签收单、轨迹照旧不写货型。
- 批量导入认「特别货」「特别」；整柜模板新表头带特别货，旧表头照认。
