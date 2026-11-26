-- 财务系统2 客户余额（2026-11-27；ADR 0191 在财务系统2 那边；约定：财务系统2 docs/物流系统接口约定.md 第 12 节）
--
-- 只加不删，不改任何现有数据：
--   1. consolidation_balance_ledger 加一列 tx_id：写这一笔流水的数据库事务号，库自己填（pg_current_xact_id()）。
--      给财务系统2 拉流水（GET /integrations/finance2-balance/v1/ledger）防漏用：只给事务号比「还没结束的最老那个事务」小的，
--      两笔几乎同时写、后写的先提交时，晚提交的那笔不会被游标跳过（finance2-balance/ledger.ts）。
--      上线前的老流水一律是 0（ADD COLUMN 的默认值 0 只用来填老行，同一句里马上换成事务号）。
--      加列 + 换默认值写在同一句 ALTER TABLE 里：中间不会有新流水插进来拿到 0。
--      再加一个索引给拉流水用。
--   2. 新表 finance2_balance_requests：财务系统2 来扣 / 退的请求编号登记（一号一行，主键唯一）。
--      外键 client_id → users.id；几条 CHECK 把「扣款 / 退回各自该有哪些列、实扣不超过上限」钉在库里。
-- 集货付款、撤销、退款、充值审核那几条路一行没改：它们写流水时不填 tx_id，库自己填。
-- 全部 IF NOT EXISTS / 先查再加，重复执行不会出错。
-- ⚠️ 手写迁移，不许用 migrate dev / db push / 影子库 diff 生成（12 张表没迁移记录，重放会挂）。
--    语句照 `prisma migrate diff`（旧 schema → 新 schema）的输出抄的，tx_id 那一句为了老行填 0 改写过，CHECK 是 schema 表达不了、手加的。

-- AlterTable
ALTER TABLE "consolidation_balance_ledger"
  ADD COLUMN IF NOT EXISTS "tx_id" BIGINT NOT NULL DEFAULT 0,
  ALTER COLUMN "tx_id" SET DEFAULT ((pg_current_xact_id())::text)::bigint;

-- CreateTable
CREATE TABLE IF NOT EXISTS "finance2_balance_requests" (
    "request_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "bill_no" TEXT NOT NULL,
    "bill_kind" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "charge_request_id" TEXT,
    "reason" TEXT,
    "result_amount" DECIMAL(14,2) NOT NULL,
    "balance_after" DECIMAL(14,2) NOT NULL,
    "ledger_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance2_balance_requests_pkey" PRIMARY KEY ("request_id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "finance2_balance_requests_charge_request_id_idx" ON "finance2_balance_requests"("charge_request_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "finance2_balance_requests_company_id_client_id_created_at_idx" ON "finance2_balance_requests"("company_id", "client_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "consolidation_balance_ledger_company_id_tx_id_created_at_id_idx" ON "consolidation_balance_ledger"("company_id", "tx_id", "created_at", "id");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance2_balance_requests_client_id_fkey') THEN
    ALTER TABLE "finance2_balance_requests" ADD CONSTRAINT "finance2_balance_requests_client_id_fkey"
      FOREIGN KEY ("client_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- CHECK（schema.prisma 表达不了，手加）
DO $$
BEGIN
  -- 扣款：有账单种类、没有「退的是哪次扣款」和退回原因；退回：反过来
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance2_balance_requests_kind_shape') THEN
    ALTER TABLE "finance2_balance_requests" ADD CONSTRAINT "finance2_balance_requests_kind_shape" CHECK (
      ("kind" = 'charge' AND "bill_kind" IN ('bulk', 'fcl') AND "charge_request_id" IS NULL AND "reason" IS NULL)
      OR ("kind" = 'refund' AND "bill_kind" IS NULL AND "charge_request_id" IS NOT NULL
          AND "reason" IN ('billVoided', 'receiptVoided', 'overCharged'))
    );
  END IF;
  -- 金额：上限 / 要退的大于 0；实扣 / 实退在 0 到它之间；动了钱才有流水、没动钱就没有
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance2_balance_requests_amount_shape') THEN
    ALTER TABLE "finance2_balance_requests" ADD CONSTRAINT "finance2_balance_requests_amount_shape" CHECK (
      "amount" > 0 AND "result_amount" >= 0 AND "result_amount" <= "amount"
      AND (("result_amount" = 0) = ("ledger_id" IS NULL))
    );
  END IF;
END $$;
