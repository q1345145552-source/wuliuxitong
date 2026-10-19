-- 到货通知转正式运单时存一份原样（2026-10-19，老板选 B：「转运单之后，又修改运单……怕之后数据不一样，但又怕改错了直接没有原始信息」）
--
-- 只增不删：新建一张表 arrival_notice_snapshots（转一次正式运单存一行，写了就不改），别的表一个字都不动、不回填老数据
-- （上线前已经转过的那些没有原样可存，页面上写「上线前转的，没存原样」）。
-- 全部 IF NOT EXISTS，重复执行不会出错。
-- ⚠️ 手写迁移，不许用 migrate dev / db push / 影子库 diff 生成（同 20261006 那份的说明）。
--    建表语句照 `prisma migrate diff --from-empty --to-schema-datamodel` 的输出抄的，表名列名、索引名、外键名跟 Prisma 默认命名一致。

CREATE TABLE IF NOT EXISTS "arrival_notice_snapshots" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "notice_id" TEXT NOT NULL,
    "shipment_id" TEXT,
    "data" TEXT NOT NULL,
    "converted_by_id" TEXT NOT NULL,
    "converted_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "arrival_notice_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "arrival_notice_snapshots_notice_id_created_at_idx" ON "arrival_notice_snapshots"("notice_id", "created_at");

-- 删到货通知时原样跟着删（同照片表、产品表；只有「没转」的才删得掉）。外键没有 IF NOT EXISTS 写法，先查有没有
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'arrival_notice_snapshots_notice_id_fkey') THEN
    ALTER TABLE "arrival_notice_snapshots" ADD CONSTRAINT "arrival_notice_snapshots_notice_id_fkey"
      FOREIGN KEY ("notice_id") REFERENCES "arrival_notices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
