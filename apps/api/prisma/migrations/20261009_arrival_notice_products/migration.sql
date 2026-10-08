-- 到货通知多款产品（2026-10-09，老板 10-08「到货通知只能填一款产品，很多时候有好几款」）
--
-- 只增不删：新建一张子表 arrival_notice_products（一款产品一行，跟 order_products 的字段一一对应，每一项都能空着），
-- 主表 arrival_notices 一个字都不改、一列都不删：
--   · weight_kg / volume_m3 仍是整票总重量、总体积；
--   · item_name / package_count / domestic_tracking_no / cargo_type 变成「镜像列」—— 新代码每次保存按各款汇总写一遍，
--     只给回滚后的旧代码、部署期间的旧容器看。
-- 末尾把老数据回填成一款（见最后一段）。
-- 全部 IF NOT EXISTS / NOT EXISTS，重复执行不会出错、不会多插。
-- ⚠️ 手写迁移，不许用 migrate dev / db push / 影子库 diff 生成（同 20261006 那份的说明）。
--    建表语句照 `prisma migrate diff --from-empty --to-schema-datamodel` 的输出抄的，表名列名、索引名、外键名跟 Prisma 默认命名一致。

CREATE TABLE IF NOT EXISTS "arrival_notice_products" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "notice_id" TEXT NOT NULL,
    "item_name" TEXT,
    "package_count" INTEGER,
    "length_cm" DOUBLE PRECISION,
    "width_cm" DOUBLE PRECISION,
    "height_cm" DOUBLE PRECISION,
    "product_quantity" INTEGER,
    "weight_kg" DOUBLE PRECISION,
    "cargo_type" TEXT NOT NULL DEFAULT 'normal',
    "domestic_tracking_no" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "arrival_notice_products_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "arrival_notice_products_notice_id_sort_order_idx" ON "arrival_notice_products"("notice_id", "sort_order");

-- 删到货通知时产品行跟着删（同照片表）。外键没有 IF NOT EXISTS 写法，先查有没有
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'arrival_notice_products_notice_id_fkey') THEN
    ALTER TABLE "arrival_notice_products" ADD CONSTRAINT "arrival_notice_products_notice_id_fkey"
      FOREIGN KEY ("notice_id") REFERENCES "arrival_notices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- 老数据回填（幂等）：上线前登记的每条到货通知，只要品名 / 件数 / 国内单号 / 货型有一项填了，就变成一款产品。
--   · 不抄 weight_kg / volume_m3：它们是整票数，留在主表上；抄进产品行会被当成单箱重再乘一次件数。
--   · 国内单号空着就保持空，不写「货拉拉」（转运单写进运单产品行时才补）。
--   · 货型空着 = 普货（normal）。主表上只会是 inspection / sensitive / 空（旧代码选普货也存空），
--     万一有 normal 也不单凭它建一款空白产品。
--   · 已经有产品行的（新代码存过的 / 第二遍执行）一律不动。
--   · 待入库运单上的 order_products 这里不动：那张运单下次在到货通知里保存时会整份重建。
INSERT INTO "arrival_notice_products" ("id", "company_id", "notice_id", "item_name", "package_count", "cargo_type", "domestic_tracking_no", "sort_order")
SELECT n."id" || ':p0', n."company_id", n."id", n."item_name", n."package_count",
       COALESCE(n."cargo_type", 'normal'), n."domestic_tracking_no", 0
FROM "arrival_notices" n
WHERE (n."item_name" IS NOT NULL OR n."package_count" IS NOT NULL
       OR n."domestic_tracking_no" IS NOT NULL
       OR (n."cargo_type" IS NOT NULL AND n."cargo_type" <> 'normal'))
  AND NOT EXISTS (SELECT 1 FROM "arrival_notice_products" p WHERE p."notice_id" = n."id")
ON CONFLICT ("id") DO NOTHING;
