-- 财务系统2 扣货名单（2026-11-19，第 9 期；约定：财务系统2 docs/物流系统接口约定.md 第 5 节）
--
-- 只加不删，不碰任何现有表的数据。五张新表：
--   finance2_hold_state      名单抬头（一行）：名单生成时间、最后一次取到 / 去取 / 失败的时间和原因
--   finance2_holds           被扣的唛头（每 15 分钟整份替换）
--   finance2_hold_releases   老板单票放行的母运单号（整份替换）
--   finance2_hold_clears     「重新核对」问财务的结果（放 / 扣都记，按财务的核对时间取最新；下一份更新的名单出来后作废）
--   finance2_hold_logs       取名单、拦、重新核对的日志
-- 不加外键（名单里的唛头物流系统可能还没有）。全部 IF NOT EXISTS，重复执行不会出错。
-- ⚠️ 手写迁移，不许用 migrate dev / db push / 影子库 diff 生成（12 张表没迁移记录，重放会挂）。
--    语句照 `prisma migrate diff` 对 schema.prisma 的输出抄的。
-- 表建了但开关（FINANCE2_HOLDS_MODE）默认关着：不取名单、不拦。

-- CreateTable
CREATE TABLE IF NOT EXISTS "finance2_hold_state" (
    "id" TEXT NOT NULL,
    "generated_at" TIMESTAMP(3),
    "fetched_at" TIMESTAMP(3),
    "last_attempt_at" TIMESTAMP(3),
    "last_error" TEXT,
    "last_error_at" TIMESTAMP(3),
    "failing_since" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "finance2_hold_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "finance2_holds" (
    "customer_mark" TEXT NOT NULL,
    "held_since" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "finance2_holds_pkey" PRIMARY KEY ("customer_mark")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "finance2_hold_releases" (
    "waybill_no" TEXT NOT NULL,
    "customer_mark" TEXT NOT NULL,
    "released_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "finance2_hold_releases_pkey" PRIMARY KEY ("waybill_no")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "finance2_hold_clears" (
    "id" TEXT NOT NULL,
    "customer_mark" TEXT NOT NULL,
    "waybill_no" TEXT,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "cleared_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "operator_id" TEXT,

    CONSTRAINT "finance2_hold_clears_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "finance2_hold_logs" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "customer_mark" TEXT,
    "waybill_no" TEXT,
    "tracking_no" TEXT,
    "entry" TEXT,
    "list_generated_at" TIMESTAMP(3),
    "detail" TEXT,
    "operator_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance2_hold_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "finance2_hold_clears_customer_mark_idx" ON "finance2_hold_clears"("customer_mark");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "finance2_hold_logs_created_at_idx" ON "finance2_hold_logs"("created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "finance2_hold_logs_operator_id_created_at_idx" ON "finance2_hold_logs"("operator_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "finance2_hold_logs_customer_mark_created_at_idx" ON "finance2_hold_logs"("customer_mark", "created_at");

