-- 代理账号上线：核对客户长期价和一个外键（只读，2026-09-15，Codex 审查 P2-1 / P2-4）
-- 用在两处：上线方案第 4 步（恢复库演练）、第 6 步切完 API 并补填长期价之后。
--
-- 跑法：psql -X -v ON_ERROR_STOP=1 -f scripts/agent-go-live-check-long-term-prices.sql
-- 最后一段会自己核「① 是 0 行」和「③ 外键定义对」：不对直接报 ERROR、退出码非 0（3），看到 ERROR 就停下来别往下走。
-- 全过会打出 NOTICE「核对通过」、退出码 0。第 ② 段要人看：有行就停下来核对。
-- （2026-09-15 Codex 第二轮 P3-1 / P3-2：原来没有「出错即停」，SQL 报错命令照样退出 0；外键只按名字核）
\set ON_ERROR_STOP on
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

-- ③ 「改所属代理」防新运单插队靠的外键（admin/routes.ts 改归属那段注释）：
--    必须有一条 public.orders(client_id) → public.users(id) 的真外键，已验证、不延迟。
--    先把 orders 指向 users 的外键定义列出来给人看，真正的核对在最后一段。
SELECT c.conname, pg_get_constraintdef(c.oid) AS definition, c.convalidated AS validated, c.condeferrable AS deferrable
FROM pg_constraint c
WHERE c.contype = 'f'
  AND c.conrelid = to_regclass('public.orders')
  AND c.confrelid = to_regclass('public.users');

-- ④ 自动核对：① 必须 0 行；③ 的外键必须对。不对直接报错退出。
DO $$
DECLARE
  missing_prices integer;
  fk_hits integer;
BEGIN
  SELECT count(*) INTO missing_prices
  FROM "whr_consolidation_plan_customers" pc
  JOIN "whr_consolidation_plans" pl ON pl."id" = pc."plan_id"
  LEFT JOIN "client_whr_prices" p ON p."client_id" = pc."client_id"
  WHERE pl."status" IN ('planning', 'collecting', 'loading')
    AND p."client_id" IS NULL;
  IF missing_prices > 0 THEN
    RAISE EXCEPTION '核对没通过：在跑的柜里有 % 位客户没有长期价（见第 ① 段），停下来先补', missing_prices;
  END IF;

  SELECT count(*) INTO fk_hits
  FROM pg_constraint c
  WHERE c.contype = 'f'
    AND c.conrelid = to_regclass('public.orders')
    AND c.confrelid = to_regclass('public.users')
    AND c.convalidated
    AND NOT c.condeferrable
    AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a
                          WHERE a.attrelid = to_regclass('public.orders') AND a.attname = 'client_id' AND NOT a.attisdropped)]
    AND c.confkey = ARRAY[(SELECT a.attnum FROM pg_attribute a
                           WHERE a.attrelid = to_regclass('public.users') AND a.attname = 'id' AND NOT a.attisdropped)];
  IF fk_hits < 1 THEN
    RAISE EXCEPTION '核对没通过：找不到 public.orders(client_id) → public.users(id) 的已验证、不延迟外键（见第 ③ 段）。「改所属代理」防新运单插队靠它，停下来';
  END IF;

  RAISE NOTICE '核对通过：在跑的柜里客户都有长期价；外键 public.orders(client_id) → public.users(id) 已验证、不延迟';
END
$$;
