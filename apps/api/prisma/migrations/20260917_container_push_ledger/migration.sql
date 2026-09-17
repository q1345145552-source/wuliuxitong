-- 推进账本（2026-09-17，老板定「推进账本」做法）
--
-- 只增不删：新建 2 张表。推柜子状态时每推一次记一笔（container_push_batches），
-- 这一笔涉及的每票货推之前/推之后的状态记在 container_push_entries。整柜撤销按账撤最近一笔，
-- 不再靠柜子时间表的日期和轨迹记录去猜（同一天推几步、日期填倒、删过记录都会退错）。
-- 老数据不补：上线前推过的步骤没有账，撤到那几步时走原来的办法（containers/routes.ts legacyUndoPlan）。
-- 全部 IF NOT EXISTS，重复执行不会出错。
-- ⚠️ 手写迁移，不许用 migrate dev / db push / 影子库 diff 生成（12 张表没迁移记录，重放会挂）。
-- ⚠️ 列名全部下划线，schema.prisma 里一律 @map。

-- ① 每推一次柜子状态一笔
CREATE TABLE IF NOT EXISTS "container_push_batches" (
  "id"                    TEXT NOT NULL,
  "company_id"            TEXT NOT NULL,
  "container_id"          TEXT NOT NULL,
  "seq"                   INTEGER NOT NULL,
  "from_container_status" TEXT NOT NULL,
  "to_container_status"   TEXT NOT NULL,
  "changed_at"            TIMESTAMP(3) NOT NULL,
  "prev_status_dates"     TEXT,
  "prev_departure_date"   TIMESTAMP(3),
  "prev_ata"              TIMESTAMP(3),
  "operator_id"           TEXT NOT NULL,
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "container_push_batches_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "container_push_batches_container_id_seq_key" ON "container_push_batches" ("container_id", "seq");
CREATE INDEX IF NOT EXISTS "container_push_batches_company_id_idx" ON "container_push_batches" ("company_id");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'container_push_batches_container_id_fkey') THEN
    ALTER TABLE "container_push_batches"
      ADD CONSTRAINT "container_push_batches_container_id_fkey"
      FOREIGN KEY ("container_id") REFERENCES "containers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ② 这一笔涉及的每票货（kind：push=推的时候就在柜里；late_add=柜子推过以后才装进来，装柜时补进账）
CREATE TABLE IF NOT EXISTS "container_push_entries" (
  "id"            TEXT NOT NULL,
  "company_id"    TEXT NOT NULL,
  "batch_id"      TEXT NOT NULL,
  "shipment_id"   TEXT NOT NULL,
  "from_status"   TEXT NOT NULL,
  "to_status"     TEXT NOT NULL,
  "status_log_id" TEXT,
  "kind"          TEXT NOT NULL,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "container_push_entries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "container_push_entries_batch_id_idx" ON "container_push_entries" ("batch_id");
CREATE INDEX IF NOT EXISTS "container_push_entries_shipment_id_idx" ON "container_push_entries" ("shipment_id");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'container_push_entries_batch_id_fkey') THEN
    ALTER TABLE "container_push_entries"
      ADD CONSTRAINT "container_push_entries_batch_id_fkey"
      FOREIGN KEY ("batch_id") REFERENCES "container_push_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
