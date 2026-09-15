-- 代理账号上线：切完 API 后补填一次客户长期价（2026-09-15，Codex 审查 P2-4）
--
-- 跟迁移 20260916_agent_accounts 第 ⑦ 段同一句：只给「用过仓库版集货、还没有长期价」的客户补，
-- 已有长期价的不覆盖（ON CONFLICT DO NOTHING），重复跑没有副作用。
--
-- 为什么切完 API 还要再跑一次：迁移回填完、切 API 之前，老程序（3381aca）还在服务。
-- 这几分钟里要是有人把一个**第一次用仓库版**的客户加进了柜，他没有长期价，
-- 新程序下次往柜里加他会弹「暂未配对价格，请联系管理员」。
--
-- ⚠️ 这是写库语句，上线时在服务器上跑（上线方案第 6 步之后），跑完接着跑只读的
--    scripts/agent-go-live-check-long-term-prices.sql 核对。
--
-- 跑法：psql -X -v ON_ERROR_STOP=1 -f scripts/agent-go-live-backfill-long-term-prices.sql
-- 出错即停：中间任何一句报 ERROR，psql 马上退出、退出码非 0（3），事务整个回滚、一行不写。
-- 成功会打出 INSERT 0 <补了几行> 和 COMMIT、退出码 0。
-- （2026-09-15 Codex 第二轮 P3-1：原来没有这一行，SQL 报错命令照样退出 0）
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO "client_whr_prices"
  ("client_id", "company_id", "price_normal", "price_inspection", "price_sensitive",
   "updated_by", "updated_by_role", "created_at", "updated_at")
SELECT DISTINCT ON (pc."client_id")
  pc."client_id", pc."company_id",
  pc."unit_price_normal", pc."unit_price_inspection", pc."unit_price_sensitive",
  NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "whr_consolidation_plan_customers" pc
ORDER BY pc."client_id", pc."created_at" DESC, pc."id" DESC
ON CONFLICT ("client_id") DO NOTHING;

COMMIT;
