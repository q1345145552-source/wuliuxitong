-- 新增第四种货型「特别货」（2026-10-11 老板：「新增一个货型，叫特别货」；价格「1a2a」）
--
-- 只加不删，五张表各加特别货那一档：
--   ① whr_consolidation_plan_customers.unit_price_special —— 仓库版集货建柜给客户填的特别货单价，默认 1250（1A：默认 1250、能改）；
--      已有的柜客户行一起填 1250（它们没有特别货，不影响已算的钱）；
--   ② whr_consolidation_prealerts.paid_price_special / paid_agent_price_special —— 付款那一刻的价格快照，可空（加之前付的款不可能有特别货）；
--   ③ agents.price_special —— 湘泰给代理的特别货价，默认 1250（2A：跟客户默认价一样，默认不产生返现；代理管理里能改）；
--   ④ client_whr_prices.price_special —— 客户长期价（9-18 起前端停用、后端保留），默认 1250，跟着补齐四档；
--   ⑤ agent_rebate_lines 三列（方数 / 客户价 / 代理价）—— 返现明细，老行是 0。
-- 货型本身存在各表的 cargo_type 文字列里（新值 special），那些列不用改。
-- 加带常量默认值的列在 PostgreSQL 里只改表结构元数据，瞬间完成；全部 IF NOT EXISTS，重复执行不会出错。
-- ⚠️ 手写迁移，不许用 migrate dev / db push / 影子库 diff 生成（12 张表没迁移记录，重放会挂）。
--    语句照 `prisma migrate diff` 对 schema.prisma 的输出抄的，类型、默认值跟设计图一致。

ALTER TABLE "whr_consolidation_plan_customers" ADD COLUMN IF NOT EXISTS "unit_price_special" DECIMAL(10,2) NOT NULL DEFAULT 1250;

ALTER TABLE "whr_consolidation_prealerts" ADD COLUMN IF NOT EXISTS "paid_price_special" DECIMAL(10,2);
ALTER TABLE "whr_consolidation_prealerts" ADD COLUMN IF NOT EXISTS "paid_agent_price_special" DECIMAL(10,2);

ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "price_special" DECIMAL(10,2) NOT NULL DEFAULT 1250;

ALTER TABLE "client_whr_prices" ADD COLUMN IF NOT EXISTS "price_special" DECIMAL(10,2) NOT NULL DEFAULT 1250;

ALTER TABLE "agent_rebate_lines" ADD COLUMN IF NOT EXISTS "volume_special_m3" DECIMAL(12,3) NOT NULL DEFAULT 0;
ALTER TABLE "agent_rebate_lines" ADD COLUMN IF NOT EXISTS "client_price_special" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "agent_rebate_lines" ADD COLUMN IF NOT EXISTS "agent_price_special" DECIMAL(10,2) NOT NULL DEFAULT 0;
