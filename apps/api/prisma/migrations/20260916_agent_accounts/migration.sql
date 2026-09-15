-- 代理账号（2026-09-16）
--
-- 只增不删：新建 4 张表 + 给 users / whr_consolidation_prealerts 加可空列 + 回填长期价。
-- 全部 IF NOT EXISTS / ON CONFLICT DO NOTHING，重复执行不会出错也不会重复写。
-- ⚠️ 手写迁移，不许用 migrate dev / db push / 影子库 diff 生成（12 张表没迁移记录，重放会挂）。
-- ⚠️ 列名全部下划线，schema.prisma 里一律 @map；表名列名已在 Neon 测试库 information_schema 核过。

-- ① 代理
CREATE TABLE IF NOT EXISTS "agents" (
  "id"               TEXT NOT NULL,
  "company_id"       TEXT NOT NULL,
  "name"             TEXT NOT NULL,
  "logo_path"        TEXT,
  "slug"             TEXT,
  "custom_domain"    TEXT,
  "price_normal"     DECIMAL(10,2) NOT NULL,
  "price_inspection" DECIMAL(10,2) NOT NULL,
  "price_sensitive"  DECIMAL(10,2) NOT NULL,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "agents_slug_key" ON "agents" ("slug");
CREATE UNIQUE INDEX IF NOT EXISTS "agents_custom_domain_key" ON "agents" ("custom_domain");
CREATE INDEX IF NOT EXISTS "agents_company_id_idx" ON "agents" ("company_id");

-- ② users.agent_id：role=agent 的行 = 这个代理的登录号；role=client 的行 = 归这个代理的客户；湘泰自己的为空
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "agent_id" TEXT;
CREATE INDEX IF NOT EXISTS "users_agent_id_idx" ON "users" ("agent_id");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_agent_id_fkey') THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_agent_id_fkey"
      FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ③ 客户长期价（仓库版集货，所有客户）
CREATE TABLE IF NOT EXISTS "client_whr_prices" (
  "client_id"        TEXT NOT NULL,
  "company_id"       TEXT NOT NULL,
  "price_normal"     DECIMAL(10,2) NOT NULL,
  "price_inspection" DECIMAL(10,2) NOT NULL,
  "price_sensitive"  DECIMAL(10,2) NOT NULL,
  "updated_by"       TEXT,
  "updated_by_role"  TEXT,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "client_whr_prices_pkey" PRIMARY KEY ("client_id")
);
CREATE INDEX IF NOT EXISTS "client_whr_prices_company_id_idx" ON "client_whr_prices" ("company_id");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_whr_prices_client_id_fkey') THEN
    ALTER TABLE "client_whr_prices"
      ADD CONSTRAINT "client_whr_prices_client_id_fkey"
      FOREIGN KEY ("client_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ④ 仓库版预报单：付款那一刻的价格快照（4.14），全部可空；湘泰自己的客户代理那几列留空
ALTER TABLE "whr_consolidation_prealerts" ADD COLUMN IF NOT EXISTS "paid_price_normal" DECIMAL(10,2);
ALTER TABLE "whr_consolidation_prealerts" ADD COLUMN IF NOT EXISTS "paid_price_inspection" DECIMAL(10,2);
ALTER TABLE "whr_consolidation_prealerts" ADD COLUMN IF NOT EXISTS "paid_price_sensitive" DECIMAL(10,2);
ALTER TABLE "whr_consolidation_prealerts" ADD COLUMN IF NOT EXISTS "paid_agent_id" TEXT;
ALTER TABLE "whr_consolidation_prealerts" ADD COLUMN IF NOT EXISTS "paid_agent_price_normal" DECIMAL(10,2);
ALTER TABLE "whr_consolidation_prealerts" ADD COLUMN IF NOT EXISTS "paid_agent_price_inspection" DECIMAL(10,2);
ALTER TABLE "whr_consolidation_prealerts" ADD COLUMN IF NOT EXISTS "paid_agent_price_sensitive" DECIMAL(10,2);
ALTER TABLE "whr_consolidation_prealerts" ADD COLUMN IF NOT EXISTS "rebate_amount" DECIMAL(12,2);
CREATE INDEX IF NOT EXISTS "whr_consolidation_prealerts_paid_agent_id_thailand_received_at_idx"
  ON "whr_consolidation_prealerts" ("paid_agent_id", "thailand_received_at");

-- ⑤ 每月返现单（4.12/4.13）
CREATE TABLE IF NOT EXISTS "agent_rebate_statements" (
  "id"              TEXT NOT NULL,
  "company_id"      TEXT NOT NULL,
  "agent_id"        TEXT NOT NULL,
  "month"           VARCHAR(7) NOT NULL,
  "line_count"      INTEGER NOT NULL,
  "total_volume_m3" DECIMAL(12,3) NOT NULL,
  "total_rebate"    DECIMAL(12,2) NOT NULL,
  "status"          TEXT NOT NULL DEFAULT 'unpaid',
  "generated_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paid_at"         TIMESTAMP(3),
  "paid_by"         TEXT,
  CONSTRAINT "agent_rebate_statements_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "agent_rebate_statements_agent_id_month_key"
  ON "agent_rebate_statements" ("agent_id", "month");
CREATE INDEX IF NOT EXISTS "agent_rebate_statements_company_id_idx" ON "agent_rebate_statements" ("company_id");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_rebate_statements_agent_id_fkey') THEN
    ALTER TABLE "agent_rebate_statements"
      ADD CONSTRAINT "agent_rebate_statements_agent_id_fkey"
      FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ⑥ 返现单明细（出单时冻结，4.20）。prealert_id 唯一 = 一票只算一次。**不存柜号**（3.11 暂缓）
CREATE TABLE IF NOT EXISTS "agent_rebate_lines" (
  "id"                          TEXT NOT NULL,
  "statement_id"                TEXT NOT NULL,
  "company_id"                  TEXT NOT NULL,
  "prealert_id"                 TEXT NOT NULL,
  "tracking_no"                 TEXT NOT NULL,
  "plan_no"                     TEXT NOT NULL,
  "client_id"                   TEXT NOT NULL,
  "mark"                        TEXT NOT NULL,
  "product_names"               TEXT NOT NULL,
  "volume_normal_m3"            DECIMAL(12,3) NOT NULL,
  "volume_inspection_m3"        DECIMAL(12,3) NOT NULL,
  "volume_sensitive_m3"         DECIMAL(12,3) NOT NULL,
  "client_price_normal"         DECIMAL(10,2) NOT NULL,
  "client_price_inspection"     DECIMAL(10,2) NOT NULL,
  "client_price_sensitive"      DECIMAL(10,2) NOT NULL,
  "agent_price_normal"          DECIMAL(10,2) NOT NULL,
  "agent_price_inspection"      DECIMAL(10,2) NOT NULL,
  "agent_price_sensitive"       DECIMAL(10,2) NOT NULL,
  "rebate_amount"               DECIMAL(12,2) NOT NULL,
  "prealert_created_at"         TIMESTAMP(3) NOT NULL,
  "signed_at"                   TIMESTAMP(3),
  "paid_at"                     TIMESTAMP(3),
  "loaded_at"                   TIMESTAMP(3),
  "shipped_at"                  TIMESTAMP(3),
  "thailand_received_at"        TIMESTAMP(3) NOT NULL,
  "created_at"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_rebate_lines_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "agent_rebate_lines_prealert_id_key" ON "agent_rebate_lines" ("prealert_id");
CREATE INDEX IF NOT EXISTS "agent_rebate_lines_statement_id_idx" ON "agent_rebate_lines" ("statement_id");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_rebate_lines_statement_id_fkey') THEN
    ALTER TABLE "agent_rebate_lines"
      ADD CONSTRAINT "agent_rebate_lines_statement_id_fkey"
      FOREIGN KEY ("statement_id") REFERENCES "agent_rebate_statements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ⑦ 回填长期价（4.19 已拍板）：每个用过仓库版集货的客户，按他最近一个柜的三档价填上。
--    已在柜里的 plan_customers 行**不动**；已有长期价的客户不覆盖（ON CONFLICT DO NOTHING）。
--    updated_by / updated_by_role 留空 = 系统上线时自动带出来的，不是哪个人填的。
--    同一时刻建的两行用 id 兜底排序，保证重复执行结果一样。
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
