-- 代理申请一张表（2026-11-08；老板原话：「财务提交，物流审批」）
--
-- 只加不删，不碰任何现有表的数据：
--   agent_applications —— 别的海外仓在海外仓财务系统里申请当湘泰的代理，物流超管通过（当场开代理号）或驳回。
-- 「同一个仓同一时间只能有一张在审的」靠 (company_id, pending_warehouse_id) 唯一：在审时 pending_warehouse_id = warehouse_id，
--   处理后清成 NULL（PostgreSQL 唯一约束里 NULL 不算重复），两个请求同时交只有一张进得去。
-- 不加外键（跟 2026-11-04 finance_link_* 一样，不跟用户 / 代理的删除搅在一起）。全部 IF NOT EXISTS，重复执行不会出错。
-- ⚠️ 手写迁移，不许用 migrate dev / db push / 影子库 diff 生成（12 张表没迁移记录，重放会挂）。
--    语句照 `prisma migrate diff` 对 schema.prisma 的输出抄的。

CREATE TABLE IF NOT EXISTS "agent_applications" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "warehouse_id" INTEGER NOT NULL,
    "warehouse_name" TEXT NOT NULL,
    "submitter_name" TEXT NOT NULL,
    "agent_name" TEXT NOT NULL,
    "contact_name" TEXT NOT NULL,
    "contact_phone" TEXT NOT NULL,
    "login_id" TEXT NOT NULL,
    "remark" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "pending_warehouse_id" INTEGER,
    "reject_reason" TEXT,
    "reviewed_by_id" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "approved_agent_id" TEXT,
    "approved_login_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "agent_applications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "agent_applications_company_id_warehouse_id_created_at_idx" ON "agent_applications"("company_id", "warehouse_id", "created_at");
CREATE INDEX IF NOT EXISTS "agent_applications_company_id_status_created_at_idx" ON "agent_applications"("company_id", "status", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "agent_applications_company_id_pending_warehouse_id_key" ON "agent_applications"("company_id", "pending_warehouse_id");
