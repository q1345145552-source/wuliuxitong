-- 到货通知（2026-10-06 老板拍板）：国内仓到货登记 → 客服复制文案 / 图片通知客户 → 标「已通知客户」→ 转运单（正式 / 待入库）
--
-- 只增不删：新建两张表，已有的表一个字都不动。
--   ① arrival_notices：一票到货一行，每一项都能空着；
--   ② arrival_notice_images：到货照片（文件存盘，表里只记路径）。
-- 「待入库」是运单的一个新状态值（shipments.current_status 本来就是文字列），不用改表。
-- 全部 IF NOT EXISTS，重复执行不会出错。
-- ⚠️ 手写迁移，不许用 migrate dev / db push / 影子库 diff 生成（12 张表没迁移记录，重放会挂）。
--    建表语句照 `prisma migrate diff` 对 schema.prisma 的输出抄的，表名列名、索引名、外键名跟 Prisma 默认命名一致，免得 diff 以为缺了再建一份。

-- ① 到货通知
CREATE TABLE IF NOT EXISTS "arrival_notices" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "client_id" TEXT,
    "tracking_no" TEXT,
    "item_name" TEXT,
    "package_count" INTEGER,
    "weight_kg" DECIMAL(10,2),
    "volume_m3" DECIMAL(10,3),
    "transport_mode" TEXT,
    "domestic_tracking_no" TEXT,
    "warehouse_id" TEXT,
    "arrived_at" TEXT,
    "remark" TEXT,
    "notified_at" TIMESTAMP(3),
    "notified_by" TEXT,
    "notified_by_name" TEXT,
    "converted_to" TEXT,
    "shipment_id" TEXT,
    "converted_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,
    "created_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "arrival_notices_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "arrival_notices_company_id_created_at_idx" ON "arrival_notices"("company_id", "created_at");
CREATE INDEX IF NOT EXISTS "arrival_notices_shipment_id_idx" ON "arrival_notices"("shipment_id");
-- 同一家公司一个运单号只登记一条：两人同时登记同一个号，后到的被挡下（运单号空着的 NULL 不算重复）
CREATE UNIQUE INDEX IF NOT EXISTS "arrival_notices_company_id_tracking_no_key" ON "arrival_notices"("company_id", "tracking_no");

-- ② 到货照片
CREATE TABLE IF NOT EXISTS "arrival_notice_images" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "notice_id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "file_path" TEXT NOT NULL,
    "order_image_id" TEXT,
    "uploaded_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "arrival_notice_images_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "arrival_notice_images_notice_id_created_at_idx" ON "arrival_notice_images"("notice_id", "created_at");

-- 删到货通知时照片记录跟着删（照片文件由接口自己删）。外键没有 IF NOT EXISTS 写法，先查有没有
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'arrival_notice_images_notice_id_fkey') THEN
    ALTER TABLE "arrival_notice_images" ADD CONSTRAINT "arrival_notice_images_notice_id_fkey"
      FOREIGN KEY ("notice_id") REFERENCES "arrival_notices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
