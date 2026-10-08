-- 到货通知第四轮审查（2026-10-08）：只加不删，两列都可空（加可空列只改表结构元数据，瞬间完成）；末尾回填改号 / 改唛头对不上的老到货通知（见最后两段）
--   F11 货型：arrival_notices.cargo_type，空 = 普货（同「创建订单」默认普货）
--   G03 照片小图：arrival_notice_images.thumb_path，老照片没有，页面显示原图
-- 全部 IF NOT EXISTS，末尾的回填只改「号对不上」「唛头对不上」的行（号那段循环到改 0 行为止），重复执行不会出错。
-- ⚠️ 手写迁移，不许用 migrate dev / db push / 影子库 diff 生成（同 20261006 那份的说明）。
ALTER TABLE "arrival_notices" ADD COLUMN IF NOT EXISTS "cargo_type" TEXT;
ALTER TABLE "arrival_notice_images" ADD COLUMN IF NOT EXISTS "thumb_path" TEXT;

-- F06 一次性回填（2026-10-08 修复第 1 轮）：10-06 上线到这次部署之间，转了正式、又在「运单管理」改过号的到货通知，
-- 库里还是旧号（旧代码不跟号）。新代码卡片按运单现在的号显示、搜索和查重却还比库里的旧号 ——
-- 按新号搜不到、旧号还被占着、卡片上又看不到旧号。这里把它们一次改成运单现在的号。
--   跳过两种：① 新号已被同公司另一条到货通知登记着（撞唯一约束，留给员工处理，新代码改号时会点名）；
--             ② 同一张运单挂着不止一条到货通知（一句 UPDATE 里两行改成同一个号会撞唯一约束，整份迁移就失败了）。
--   运单已经被删的（JOIN 不上）不动。只改号对不上的行。
--   ⚠️ 要循环跑到改 0 行为止（修复第 2 轮）：「连环改号」—— 运单 S8 从 P8 改成 P8NEW、运单 S7 又从 P7 改成 P8 ——
--   NOT EXISTS 看的是语句开始那一刻的数据，第一遍时 P8 还被 S8 那条占着，S7 那条就被跳过了；迁移只执行一次，
--   它会一直停在旧号。每一轮把能改的改掉、下一轮接着改被腾出来的号。两张运单互换号（P1↔P2）每一轮都被 NOT EXISTS 挡住、
--   改 0 行，不会死循环；再加 100 轮上限兜底。循环结束后重复执行整份迁移改 0 行。
DO $$
DECLARE
  changed integer;
  rounds integer := 0;
BEGIN
  LOOP
    UPDATE "arrival_notices" n
    SET "tracking_no" = s."tracking_no"
    FROM "shipments" s
    WHERE s."id" = n."shipment_id"
      AND s."company_id" = n."company_id"
      AND n."converted_to" IS NOT NULL
      AND n."tracking_no" IS DISTINCT FROM s."tracking_no"
      AND NOT EXISTS (SELECT 1 FROM "arrival_notices" m WHERE m."company_id" = n."company_id" AND m."tracking_no" = s."tracking_no")
      AND NOT EXISTS (SELECT 1 FROM "arrival_notices" d WHERE d."shipment_id" = n."shipment_id" AND d."id" <> n."id");
    GET DIAGNOSTICS changed = ROW_COUNT;
    rounds := rounds + 1;
    EXIT WHEN changed = 0 OR rounds >= 100;
  END LOOP;
END $$;

-- 唛头一次性回填（2026-10-08 修复第 4 轮）：10-06 上线到这次部署之间，转了运单、又被超管在「运单管理」把订单改给别的客户的到货通知，
-- 库里还是旧唛头 A、还挂着「已通知」（旧代码不跟唛头）。新代码只在超管再保存那张订单时才跟（followShipmentClientIds），
-- 员工改单那条路不跟 —— 没人再保存，卡片就一直是 A、「已通知」，按新唛头 B 搜不到，复制给客户的文案写的也是 A。
-- 这里照 followShipmentClientIds 的写法一次改成订单现在的客户，「已通知」清掉、回到「待通知」（通知的是旧客户，同 G01）。
--   只改「转过、运单还在、唛头对不上」的行；没转的、运单删了的（JOIN 不上）不动。client_id 没有唯一约束，一句就够，不用循环。
--   updated_at 是不带时区的 timestamp(3)、Prisma 按 UTC 存，所以写 NOW() AT TIME ZONE 'UTC'（同 followShipmentClientIds）。
--   重复执行改 0 行。列名都核过库（client_id / notified_at / notified_by / notified_by_name / order_id 都有 @map，教训 26）。
UPDATE "arrival_notices" AS n
SET "client_id" = o."client_id", "notified_at" = NULL, "notified_by" = NULL, "notified_by_name" = NULL, "updated_at" = (NOW() AT TIME ZONE 'UTC')
FROM "shipments" s
JOIN "orders" o ON o."id" = s."order_id" AND o."company_id" = s."company_id"
WHERE n."shipment_id" = s."id"
  AND s."company_id" = n."company_id"
  AND n."converted_to" IS NOT NULL
  AND n."client_id" IS DISTINCT FROM o."client_id";
