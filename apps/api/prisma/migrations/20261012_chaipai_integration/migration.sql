-- 对接拆派仓的三张表（2026-10-12；老板 10-11「4:同意加」：消息记录、每票最后状态、清单版本）
--
-- 只加不删，不碰任何现有表的数据：
--   ① chaipai_callback_events —— 拆派仓回传的每条消息（按 event_id 去重；不加指向运单的外键，运单删了记录也留着）；
--   ② chaipai_shipment_states —— 每票最后一次回传的序号和状态（判新旧），以及自动登记的尾端派送单（同一趟车同一个派送单号）；
--      外键指向 shipments，删运单时跟着删（CASCADE，不挡删订单 / 删运单的老流程）；
--   ③ chaipai_manifest_versions —— 给拆派仓的清单每票的版本时间（内容不变版本不变），故意不加外键。
-- 全部 IF NOT EXISTS，重复执行不会出错。
-- ⚠️ 手写迁移，不许用 migrate dev / db push / 影子库 diff 生成（12 张表没迁移记录，重放会挂）。
--    语句照 `prisma migrate diff` 对 schema.prisma 的输出抄的。

CREATE TABLE IF NOT EXISTS "chaipai_callback_events" (
    "event_id" TEXT NOT NULL,
    "company_id" TEXT,
    "source_company_id" TEXT NOT NULL,
    "shipment_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "result" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chaipai_callback_events_pkey" PRIMARY KEY ("event_id")
);

CREATE TABLE IF NOT EXISTS "chaipai_shipment_states" (
    "shipment_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "last_sequence" INTEGER NOT NULL DEFAULT 0,
    "last_event_id" TEXT NOT NULL,
    "thai_status" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "actual_box_count" INTEGER,
    "shortage" BOOLEAN,
    "route_id" TEXT,
    "delivery_no" TEXT,
    "lastmile_order_id" TEXT,
    "handover_carrier" TEXT,
    "handover_tracking_no" TEXT,
    "released_routes" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "chaipai_shipment_states_pkey" PRIMARY KEY ("shipment_id")
);

CREATE TABLE IF NOT EXISTS "chaipai_manifest_versions" (
    "shipment_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "version_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chaipai_manifest_versions_pkey" PRIMARY KEY ("shipment_id")
);

-- 只在 Neon 测试库跑过的早一版没有这一列、消息记录的公司编号是必填：补上 / 放开（新库上这两句什么都不做；10-12 两家审查）
ALTER TABLE "chaipai_shipment_states" ADD COLUMN IF NOT EXISTS "handover_tracking_no" TEXT;
ALTER TABLE "chaipai_shipment_states" ADD COLUMN IF NOT EXISTS "released_routes" JSONB;
ALTER TABLE "chaipai_callback_events" ALTER COLUMN "company_id" DROP NOT NULL;

CREATE INDEX IF NOT EXISTS "chaipai_callback_events_shipment_id_sequence_idx" ON "chaipai_callback_events"("shipment_id", "sequence");
CREATE INDEX IF NOT EXISTS "chaipai_shipment_states_company_id_idx" ON "chaipai_shipment_states"("company_id");
CREATE INDEX IF NOT EXISTS "chaipai_shipment_states_route_id_idx" ON "chaipai_shipment_states"("route_id");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chaipai_shipment_states_shipment_id_fkey') THEN
    ALTER TABLE "chaipai_shipment_states" ADD CONSTRAINT "chaipai_shipment_states_shipment_id_fkey"
      FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
