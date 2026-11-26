-- 管理员调整客户余额（2026-11-27；财务系统2 ADR 0191 第 2 轮：「充值的话线下转，然后管理员去加金额」「加了就算数」）
--
-- 只加不删，不改任何现有数据。一张新表 wallet_adjustments：管理员「给客户加金额」（topup）/「减金额」（deduction）一次一行；
-- 加错了整笔冲掉，冲掉的信息记在同一行的 reversed_* 上（一行只能冲一次）。流水照旧记在 consolidation_balance_ledger
-- （关联类型 admin_adjust、ref_id = 这一行的 id）。submit_key / reverse_submit_key 唯一：同一个一次性提交编号只办一次。
-- 外键 client_id → users；CHECK 把「种类、金额大于 0、冲掉那几列要么全空要么全有、只有 topup 能冲」钉在库里。
-- 全部 IF NOT EXISTS / 先查再加，重复执行不会出错。必须排在 20261127_finance2_balance 后面（目录名按字母排）。
-- ⚠️ 手写迁移，不许用 migrate dev / db push / 影子库 diff 生成。语句照 `prisma migrate diff` 的输出抄的，CHECK 是手加的。

-- CreateTable
CREATE TABLE IF NOT EXISTS "wallet_adjustments" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "remark" TEXT,
    "proof_image" TEXT,
    "submit_key" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "operator_name" TEXT NOT NULL,
    "ledger_id" TEXT NOT NULL,
    "balance_after" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversed_at" TIMESTAMP(3),
    "reversed_by_id" TEXT,
    "reversed_by_name" TEXT,
    "reverse_reason" TEXT,
    "reversal_ledger_id" TEXT,
    "reverse_submit_key" TEXT,
    "reverse_balance_after" DECIMAL(14,2),

    CONSTRAINT "wallet_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_adjustments_submit_key_key" ON "wallet_adjustments"("submit_key");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_adjustments_reverse_submit_key_key" ON "wallet_adjustments"("reverse_submit_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "wallet_adjustments_company_id_client_id_created_at_idx" ON "wallet_adjustments"("company_id", "client_id", "created_at");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_adjustments_client_id_fkey') THEN
    ALTER TABLE "wallet_adjustments" ADD CONSTRAINT "wallet_adjustments_client_id_fkey"
      FOREIGN KEY ("client_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- CHECK（schema.prisma 表达不了，手加）
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_adjustments_shape') THEN
    ALTER TABLE "wallet_adjustments" ADD CONSTRAINT "wallet_adjustments_shape" CHECK (
      "kind" IN ('topup', 'deduction') AND "amount" > 0
    );
  END IF;
  -- 冲掉那几列：要么全空（没冲），要么全有（冲了）；只有 topup 能冲
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_adjustments_reverse_shape') THEN
    ALTER TABLE "wallet_adjustments" ADD CONSTRAINT "wallet_adjustments_reverse_shape" CHECK (
      ("reversed_at" IS NULL AND "reversed_by_id" IS NULL AND "reversed_by_name" IS NULL AND "reverse_reason" IS NULL
        AND "reversal_ledger_id" IS NULL AND "reverse_submit_key" IS NULL AND "reverse_balance_after" IS NULL)
      OR ("kind" = 'topup' AND "reversed_at" IS NOT NULL AND "reversed_by_id" IS NOT NULL AND "reversed_by_name" IS NOT NULL
        AND "reverse_reason" IS NOT NULL AND "reversal_ledger_id" IS NOT NULL AND "reverse_submit_key" IS NOT NULL
        AND "reverse_balance_after" IS NOT NULL)
    );
  END IF;
END $$;
