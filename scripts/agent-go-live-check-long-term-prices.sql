-- 代理账号上线：核对客户长期价和一个外键（只读，2026-09-15，Codex 审查 P2-1 / P2-4）
-- 用在两处：上线方案第 4 步（恢复库演练）、第 6 步切完 API 并补填长期价之后。
SET default_transaction_read_only = on;

-- ① 在跑的柜（计划中 / 收货中 / 装柜中）里，没有长期价的客户：必须 0 行
SELECT pc."client_id", pl."plan_no", pl."status"
FROM "whr_consolidation_plan_customers" pc
JOIN "whr_consolidation_plans" pl ON pl."id" = pc."plan_id"
LEFT JOIN "client_whr_prices" p ON p."client_id" = pc."client_id"
WHERE pl."status" IN ('planning', 'collecting', 'loading')
  AND p."client_id" IS NULL;

-- ② 系统回填的长期价（updated_by 为空）跟这个客户最近一个柜的价不一样：有行就停下来核对
--    （说明迁移完到切 API 之间，老程序给这个客户手填了别的价；按确认单 4.19 应以最近一个柜的价为准）
SELECT latest."client_id",
       p."price_normal", p."price_inspection", p."price_sensitive",
       latest."unit_price_normal", latest."unit_price_inspection", latest."unit_price_sensitive"
FROM (
  SELECT DISTINCT ON (pc."client_id")
    pc."client_id", pc."unit_price_normal", pc."unit_price_inspection", pc."unit_price_sensitive"
  FROM "whr_consolidation_plan_customers" pc
  ORDER BY pc."client_id", pc."created_at" DESC, pc."id" DESC
) latest
JOIN "client_whr_prices" p ON p."client_id" = latest."client_id"
WHERE p."updated_by" IS NULL
  AND (p."price_normal" <> latest."unit_price_normal"
    OR p."price_inspection" <> latest."unit_price_inspection"
    OR p."price_sensitive" <> latest."unit_price_sensitive");

-- ③ 「改所属代理」防新运单插队靠的外键还在：必须 1 行（admin/routes.ts 改归属那段注释）
SELECT conname FROM pg_constraint WHERE conname = 'orders_client_id_fkey';
