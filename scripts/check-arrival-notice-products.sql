-- 到货通知产品明细体检（2026-10-09 多款产品）—— 纯只读，一个字都不改。
--
-- 为什么要有：20261009_arrival_notice_products 迁移在 deploy.sh 里比换新容器早跑。迁移跑完、旧容器被换下之前那几分钟，
-- 旧代码还在接请求，它只认主表 arrival_notices 上的品名 / 件数 / 国内单号 / 货型四列（新代码里叫「镜像列」）：
--   ① 旧代码这时**新登记**的：只有镜像列、没有产品行。新代码读的时候会把镜像列当成一款（fieldsOf 的兜底），能正常用，
--      但最好知道有几条（kind = no_products）；
--   ② 旧代码这时**修改**的：只改了镜像列，产品行还是改之前的 —— 页面上显示的是旧的产品明细（kind = mismatch）。
-- 迁移本身回填的老数据不会出现在这里（回填就是照镜像列抄的）。新代码每次保存都按产品行重写镜像列，也不会出现在这里。
-- 回滚后再次上线：开放编辑前必须再次手工跑本体检，不是只在第一次上线跑。
-- 迁移账本不会重跑已完成的迁移，回填也不会覆盖已有产品行；mismatch 未处理前不要保存这些通知，免得覆盖旧版期间的修改。
-- 不自动猜哪边正确：保留两份记录、交老板确认后再修；正常新旧切换窗口也按这个流程核对。
--
-- 保存 / 转单入口另有行锁内硬闸：已有产品行与镜像 / 可计算总量不一致就 409，不覆盖任一边。
-- 总重 / 体积仅在有可算行时比对；合计后重量两位、体积三位（含小正体积舍成 0），纯手填不误报。
-- 镜像列应该等于产品行的汇总（packages/shared-types/arrival-notice-products.ts 的 noticeLegacySummary）：
--   品名 = 各款品名去重后按顺序用「 / 」拼；件数 = 每款都有件数时的合计（有一款没填就是空）；
--   国内单号 = 各款单号去重后按顺序用「、」拼；货型 = 最严的那个（敏感 > 商检 > 普货），普货存空。
--
-- 不进 deploy.sh（同 check-arrival-notice-tracking-no.sql：部署脚本不为一次性体检改动）。带 20261009 迁移的那次部署跑完以后，
-- 在服务器上**手工跑一遍**（只读）：
--   cd /root/MyWebSite && docker compose exec -T postgres sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -t -A -q -F " | "' < scripts/check-arrival-notice-products.sql
-- 没有输出 = 都对得上。有输出先交给老板看，确认正确数据及修复方案后再做，这里不带修复语句。
-- 列名都核过 schema.prisma（两张表每一列都有 @map，教训 26）。
WITH firsts AS (
  -- 同一个品名 / 单号只算第一次出现的位置（productNamesLabel 去重时保留第一次的顺序）
  SELECT notice_id, btrim(item_name) AS v, min(sort_order) AS pos
    FROM arrival_notice_products
   WHERE item_name IS NOT NULL AND btrim(item_name) <> ''
   GROUP BY notice_id, btrim(item_name)
),
dom_firsts AS (
  SELECT notice_id, btrim(domestic_tracking_no) AS v, min(sort_order) AS pos
    FROM arrival_notice_products
   WHERE domestic_tracking_no IS NOT NULL AND btrim(domestic_tracking_no) <> ''
   GROUP BY notice_id, btrim(domestic_tracking_no)
),
raw_summary AS (
  SELECT p.notice_id,
         count(*) AS product_count,
         sum(p.weight_kg * p.package_count ORDER BY p.sort_order) FILTER (WHERE p.weight_kg > 0 AND p.package_count > 0) AS raw_weight,
         sum(p.length_cm * p.width_cm * p.height_cm * p.package_count / 1e6 ORDER BY p.sort_order) FILTER (WHERE p.length_cm > 0 AND p.width_cm > 0 AND p.height_cm > 0 AND p.package_count > 0) AS raw_volume,
         CASE WHEN count(*) = count(p.package_count) THEN sum(p.package_count) END AS package_count,
         CASE WHEN bool_or(p.cargo_type = 'sensitive') THEN 'sensitive'
              WHEN bool_or(p.cargo_type = 'inspection') THEN 'inspection' END AS cargo_type
    FROM arrival_notice_products AS p
   GROUP BY p.notice_id
),
scaled AS (
  -- 跟 JS 一样先按 sort_order 求和，加 Number.EPSILON，再乘倍率；不能先 cast numeric（近半值会改变）。
  SELECT *, (raw_weight + 2.220446049250313e-16::float8) * 100::float8 AS weight_scaled,
            (raw_volume + 2.220446049250313e-16::float8) * 1000::float8 AS volume_scaled
    FROM raw_summary
),
summary AS (
  -- 正数的 Math.round：小数部分 >= 0.5 就进一。PostgreSQL round(float8) 是银行家舍入，不能直接用。
  SELECT notice_id, product_count, package_count, cargo_type,
         CASE WHEN raw_weight > 0 THEN ((floor(weight_scaled) + CASE WHEN weight_scaled - floor(weight_scaled) >= 0.5 THEN 1 ELSE 0 END) / 100::float8)::numeric END AS weight_kg,
         CASE WHEN raw_volume > 0 THEN ((floor(volume_scaled) + CASE WHEN volume_scaled - floor(volume_scaled) >= 0.5 THEN 1 ELSE 0 END) / 1000::float8)::numeric END AS volume_m3
    FROM scaled
)
SELECT 'no_products' AS kind,
       n.company_id,
       n.id                   AS notice_id,
       n.tracking_no,
       n.item_name            AS mirror_item_name,
       n.package_count        AS mirror_package_count,
       n.domestic_tracking_no AS mirror_domestic_tracking_no,
       n.cargo_type           AS mirror_cargo_type,
       0::bigint              AS product_count,
       NULL::text             AS products_item_name,
       NULL::bigint           AS products_package_count,
       NULL::text             AS products_domestic_tracking_no,
       NULL::text             AS products_cargo_type,
       n.weight_kg            AS mirror_weight_kg,
       n.volume_m3            AS mirror_volume_m3,
       NULL::numeric          AS products_weight_kg,
       NULL::numeric          AS products_volume_m3
  FROM arrival_notices AS n
 WHERE NOT EXISTS (SELECT 1 FROM arrival_notice_products AS p WHERE p.notice_id = n.id)
   AND (n.item_name IS NOT NULL OR n.package_count IS NOT NULL OR n.domestic_tracking_no IS NOT NULL
        OR (n.cargo_type IS NOT NULL AND n.cargo_type <> 'normal'))
UNION ALL
SELECT 'mismatch',
       n.company_id,
       n.id,
       n.tracking_no,
       n.item_name,
       n.package_count,
       n.domestic_tracking_no,
       n.cargo_type,
       s.product_count,
       names.v,
       s.package_count,
       doms.v,
       s.cargo_type,
       n.weight_kg, n.volume_m3, s.weight_kg, s.volume_m3
  FROM arrival_notices AS n
  JOIN summary AS s ON s.notice_id = n.id
  LEFT JOIN (SELECT notice_id, string_agg(v, ' / ' ORDER BY pos) AS v FROM firsts GROUP BY notice_id) AS names ON names.notice_id = n.id
  LEFT JOIN (SELECT notice_id, string_agg(v, '、' ORDER BY pos) AS v FROM dom_firsts GROUP BY notice_id) AS doms ON doms.notice_id = n.id
 WHERE n.item_name IS DISTINCT FROM names.v
    OR n.package_count IS DISTINCT FROM s.package_count
    OR n.domestic_tracking_no IS DISTINCT FROM doms.v
    OR NULLIF(n.cargo_type, 'normal') IS DISTINCT FROM s.cargo_type
    OR (s.weight_kg IS NOT NULL AND n.weight_kg IS DISTINCT FROM s.weight_kg)
    OR (s.volume_m3 IS NOT NULL AND n.volume_m3 IS DISTINCT FROM s.volume_m3)
 ORDER BY 1, 2, 3;
