-- 给财务系统2 的只读接口（2026-11-19，第 7 期物流这一边；约定：财务系统2 docs/物流系统接口约定.md 第二版）
--
-- 只加不删，不改任何现有表的结构和数据：
--   ① finance2_waybill_changes —— 运单「改过」的记录（只追加）。财务系统2 按它增量拉运单。
--   ② finance2_customer_agent_changes —— 客户换代理的记录（只追加）。物流系统原来不记换代理的日子。
--   ③ 几个触发器：订单 / 运单 / 产品行 / 装柜明细 / 轨迹 / 柜子 / 账号的有关列一变，往上面两张表记一笔。
--      为什么用触发器、不在业务代码里一处处记：会改这些表的地方有几十处（建单、改单、确认收货、到货通知、装柜卸柜、
--      分柜并柜、柜子推进撤销、尾端派送、拆派仓回传、删 / 恢复轨迹、整柜建改删、删订单……），手写一定会漏；
--      触发器挂在表上，哪条路改的都记得到，业务代码一行不动。
--   ④ 给现有的每一票母运单补一条（重复执行不会补第二遍），财务第一次拉能拉全。
--
-- 触发器的规矩（改这个文件前逐条看）：
--   · 一律 AFTER … FOR EACH STATEMENT + 变化行集合（REFERENCING），一条语句只多一次插入，批量推柜子也只多一条 INSERT。
--   · 只读别的表、只往这两张新表插，不更新、不加锁别的行，跟原来的加锁顺序无关（CLAUDE.md #35）。
--   · 记失败只发一句 WARNING，原来的写操作照常成功（EXCEPTION 兜住；每条语句一个子事务）。
--   · 时间用数据库时钟的 UTC（clock_timestamp() AT TIME ZONE 'UTC'），跟 Prisma 存的时间同一个口径，跟连接的时区设置无关。
--   · 级联删除时（删运单连带删轨迹 / 装柜明细，删订单连带删产品行）那几张表的触发器找不到运单就不记，删运单那一笔由 shipments 的触发器记。
--
-- ⚠️ 手写迁移，不许用 migrate dev / db push / 影子库 diff 生成（12 张表没迁移记录，重放会挂）。
--    建表、建索引照 `prisma migrate diff` 对 schema.prisma 的输出抄的；全部可以重复执行。

CREATE TABLE IF NOT EXISTS "finance2_waybill_changes" (
    "id" BIGSERIAL NOT NULL,
    "company_id" TEXT NOT NULL,
    "waybill_no" TEXT NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL,

    CONSTRAINT "finance2_waybill_changes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "finance2_customer_agent_changes" (
    "id" BIGSERIAL NOT NULL,
    "company_id" TEXT NOT NULL,
    "customer_mark" TEXT NOT NULL,
    "from_agent_id" TEXT,
    "to_agent_id" TEXT,
    "changed_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "finance2_customer_agent_changes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "finance2_waybill_changes_company_id_changed_at_idx" ON "finance2_waybill_changes"("company_id", "changed_at");
CREATE INDEX IF NOT EXISTS "finance2_waybill_changes_company_id_waybill_no_changed_at_idx" ON "finance2_waybill_changes"("company_id", "waybill_no", "changed_at");
CREATE INDEX IF NOT EXISTS "finance2_customer_agent_changes_company_id_changed_at_idx" ON "finance2_customer_agent_changes"("company_id", "changed_at");

-- 数据库时钟的 UTC，毫秒（列是 TIMESTAMP(3)，跟游标里的毫秒对得上）
CREATE OR REPLACE FUNCTION finance2_now() RETURNS timestamp(3) LANGUAGE sql VOLATILE AS $$
  SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
$$;

/* ---------- 订单：改了约定里用到的列（客户、仓、运输方式、货型、体积、重量、件数、审核状态、整柜金额、建单时间）---------- */
CREATE OR REPLACE FUNCTION finance2_track_orders() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO finance2_waybill_changes (company_id, waybill_no, changed_at, deleted, source)
  SELECT DISTINCT s.company_id, s.tracking_no, finance2_now(), false, 'orders'
  FROM new_rows n
  JOIN old_rows o ON o.id = n.id
  JOIN shipments s ON s.order_id = n.id AND s.parent_tracking_no IS NULL
  WHERE (n.company_id, n.client_id, n.warehouse_id, n.transport_mode, n.cargo_type, n.volume_m3, n.weight_kg,
         n.package_count, n.approval_status, n.receivable_amount_cny, n.created_at)
     IS DISTINCT FROM
        (o.company_id, o.client_id, o.warehouse_id, o.transport_mode, o.cargo_type, o.volume_m3, o.weight_kg,
         o.package_count, o.approval_status, o.receivable_amount_cny, o.created_at);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'finance2 改动记录没记上（orders）：%', SQLERRM;
  RETURN NULL;
END
$$;

/* ---------- 运单：新建、删掉、改了有关的列（号、父单号、状态、体积、重量、件数、订单）。子运单的改动算到母运单头上 ---------- */
CREATE OR REPLACE FUNCTION finance2_track_shipments() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO finance2_waybill_changes (company_id, waybill_no, changed_at, deleted, source)
    SELECT DISTINCT n.company_id, COALESCE(n.parent_tracking_no, n.tracking_no), finance2_now(), false, 'shipments'
    FROM new_rows n;
  ELSIF TG_OP = 'DELETE' THEN
    -- 删掉母运单 = 这票没了（deleted）；删掉子运单（卸柜并回、删柜子）= 母运单改了
    INSERT INTO finance2_waybill_changes (company_id, waybill_no, changed_at, deleted, source)
    SELECT DISTINCT o.company_id, COALESCE(o.parent_tracking_no, o.tracking_no), finance2_now(), o.parent_tracking_no IS NULL, 'shipments'
    FROM old_rows o;
  ELSE
    INSERT INTO finance2_waybill_changes (company_id, waybill_no, changed_at, deleted, source)
    SELECT DISTINCT x.company_id, x.waybill_no, finance2_now(), x.deleted, 'shipments'
    FROM (
      -- 改后的那一票
      SELECT n.company_id, COALESCE(n.parent_tracking_no, n.tracking_no) AS waybill_no, false AS deleted
      FROM new_rows n JOIN old_rows o ON o.id = n.id
      WHERE (n.company_id, n.order_id, n.tracking_no, n.parent_tracking_no, n.current_status, n.volume_m3, n.weight_kg, n.package_count)
         IS DISTINCT FROM
            (o.company_id, o.order_id, o.tracking_no, o.parent_tracking_no, o.current_status, o.volume_m3, o.weight_kg, o.package_count)
      UNION ALL
      -- 改了号 / 挪了父单：原来那一票也要记。原来是母运单的，旧号就不在了，算删掉
      SELECT o.company_id, COALESCE(o.parent_tracking_no, o.tracking_no), o.parent_tracking_no IS NULL
      FROM new_rows n JOIN old_rows o ON o.id = n.id
      WHERE (o.company_id, COALESCE(o.parent_tracking_no, o.tracking_no))
         IS DISTINCT FROM (n.company_id, COALESCE(n.parent_tracking_no, n.tracking_no))
    ) x;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'finance2 改动记录没记上（shipments %）：%', TG_OP, SQLERRM;
  RETURN NULL;
END
$$;

/* ---------- 产品行：增、删、改了品名 / 箱数 / 长宽高 / 货型 / 顺序 ---------- */
CREATE OR REPLACE FUNCTION finance2_track_order_products() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO finance2_waybill_changes (company_id, waybill_no, changed_at, deleted, source)
    SELECT DISTINCT s.company_id, s.tracking_no, finance2_now(), false, 'order_products'
    FROM (SELECT DISTINCT order_id FROM new_rows) r
    JOIN shipments s ON s.order_id = r.order_id AND s.parent_tracking_no IS NULL;
  ELSIF TG_OP = 'DELETE' THEN
    -- 删订单连带删产品行时运单已经先删了，这里找不到就不记（删运单那一笔已经记了）
    INSERT INTO finance2_waybill_changes (company_id, waybill_no, changed_at, deleted, source)
    SELECT DISTINCT s.company_id, s.tracking_no, finance2_now(), false, 'order_products'
    FROM (SELECT DISTINCT order_id FROM old_rows) r
    JOIN shipments s ON s.order_id = r.order_id AND s.parent_tracking_no IS NULL;
  ELSE
    INSERT INTO finance2_waybill_changes (company_id, waybill_no, changed_at, deleted, source)
    SELECT DISTINCT s.company_id, s.tracking_no, finance2_now(), false, 'order_products'
    FROM (
      SELECT n.order_id FROM new_rows n JOIN old_rows o ON o.id = n.id
      WHERE (n.order_id, n.item_name, n.package_count, n.length_cm, n.width_cm, n.height_cm, n.cargo_type, n.sort_order)
         IS DISTINCT FROM
            (o.order_id, o.item_name, o.package_count, o.length_cm, o.width_cm, o.height_cm, o.cargo_type, o.sort_order)
      UNION
      SELECT o.order_id FROM new_rows n JOIN old_rows o ON o.id = n.id WHERE n.order_id IS DISTINCT FROM o.order_id
    ) r
    JOIN shipments s ON s.order_id = r.order_id AND s.parent_tracking_no IS NULL;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'finance2 改动记录没记上（order_products %）：%', TG_OP, SQLERRM;
  RETURN NULL;
END
$$;

/* ---------- 装柜明细：装柜、卸柜、改装柜量 ---------- */
CREATE OR REPLACE FUNCTION finance2_track_container_items() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO finance2_waybill_changes (company_id, waybill_no, changed_at, deleted, source)
    SELECT DISTINCT s.company_id, COALESCE(s.parent_tracking_no, s.tracking_no), finance2_now(), false, 'shipment_container_items'
    FROM (SELECT DISTINCT shipment_id FROM new_rows) r JOIN shipments s ON s.id = r.shipment_id;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO finance2_waybill_changes (company_id, waybill_no, changed_at, deleted, source)
    SELECT DISTINCT s.company_id, COALESCE(s.parent_tracking_no, s.tracking_no), finance2_now(), false, 'shipment_container_items'
    FROM (SELECT DISTINCT shipment_id FROM old_rows) r JOIN shipments s ON s.id = r.shipment_id;
  ELSE
    INSERT INTO finance2_waybill_changes (company_id, waybill_no, changed_at, deleted, source)
    SELECT DISTINCT s.company_id, COALESCE(s.parent_tracking_no, s.tracking_no), finance2_now(), false, 'shipment_container_items'
    FROM (
      SELECT n.shipment_id FROM new_rows n JOIN old_rows o ON o.id = n.id
      WHERE (n.shipment_id, n.container_id, n.loaded_volume_m3, n.loaded_piece_count, n.created_at)
         IS DISTINCT FROM (o.shipment_id, o.container_id, o.loaded_volume_m3, o.loaded_piece_count, o.created_at)
      UNION
      SELECT o.shipment_id FROM new_rows n JOIN old_rows o ON o.id = n.id WHERE n.shipment_id IS DISTINCT FROM o.shipment_id
    ) r JOIN shipments s ON s.id = r.shipment_id;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'finance2 改动记录没记上（shipment_container_items %）：%', TG_OP, SQLERRM;
  RETURN NULL;
END
$$;

/* ---------- 轨迹：加、删、改了状态或时间（进入当前状态的时间、确认收货、签收都从轨迹取）---------- */
CREATE OR REPLACE FUNCTION finance2_track_status_logs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO finance2_waybill_changes (company_id, waybill_no, changed_at, deleted, source)
    SELECT DISTINCT s.company_id, COALESCE(s.parent_tracking_no, s.tracking_no), finance2_now(), false, 'status_logs'
    FROM (SELECT DISTINCT shipment_id FROM new_rows) r JOIN shipments s ON s.id = r.shipment_id;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO finance2_waybill_changes (company_id, waybill_no, changed_at, deleted, source)
    SELECT DISTINCT s.company_id, COALESCE(s.parent_tracking_no, s.tracking_no), finance2_now(), false, 'status_logs'
    FROM (SELECT DISTINCT shipment_id FROM old_rows) r JOIN shipments s ON s.id = r.shipment_id;
  ELSE
    INSERT INTO finance2_waybill_changes (company_id, waybill_no, changed_at, deleted, source)
    SELECT DISTINCT s.company_id, COALESCE(s.parent_tracking_no, s.tracking_no), finance2_now(), false, 'status_logs'
    FROM (
      SELECT n.shipment_id FROM new_rows n JOIN old_rows o ON o.id = n.id
      WHERE (n.shipment_id, n.to_status, n.changed_at) IS DISTINCT FROM (o.shipment_id, o.to_status, o.changed_at)
      UNION
      SELECT o.shipment_id FROM new_rows n JOIN old_rows o ON o.id = n.id WHERE n.shipment_id IS DISTINCT FROM o.shipment_id
    ) r JOIN shipments s ON s.id = r.shipment_id;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'finance2 改动记录没记上（status_logs %）：%', TG_OP, SQLERRM;
  RETURN NULL;
END
$$;

/* ---------- 柜子：改了柜号、柜型、装柜日期、是不是整柜（柜里每一票都算改了）。删柜子连带删装柜明细，由装柜明细那个触发器记 ---------- */
CREATE OR REPLACE FUNCTION finance2_track_containers() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO finance2_waybill_changes (company_id, waybill_no, changed_at, deleted, source)
  SELECT DISTINCT s.company_id, COALESCE(s.parent_tracking_no, s.tracking_no), finance2_now(), false, 'containers'
  FROM new_rows n
  JOIN old_rows o ON o.id = n.id
  JOIN shipment_container_items i ON i.container_id = n.id
  JOIN shipments s ON s.id = i.shipment_id
  WHERE (n.container_no, n.container_type, n.loading_date, n.is_fcl)
     IS DISTINCT FROM (o.container_no, o.container_type, o.loading_date, o.is_fcl);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'finance2 改动记录没记上（containers）：%', SQLERRM;
  RETURN NULL;
END
$$;

/* ---------- 客户换代理：users.agent_id 变了（只记客户号）---------- */
CREATE OR REPLACE FUNCTION finance2_track_user_agent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO finance2_customer_agent_changes (company_id, customer_mark, from_agent_id, to_agent_id, changed_at)
  SELECT n.company_id, n.id, o.agent_id, n.agent_id, finance2_now()
  FROM new_rows n JOIN old_rows o ON o.id = n.id
  WHERE n.role = 'client' AND n.agent_id IS DISTINCT FROM o.agent_id;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'finance2 换代理记录没记上：%', SQLERRM;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS finance2_orders_upd ON orders;
CREATE TRIGGER finance2_orders_upd AFTER UPDATE ON orders
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION finance2_track_orders();

DROP TRIGGER IF EXISTS finance2_shipments_ins ON shipments;
CREATE TRIGGER finance2_shipments_ins AFTER INSERT ON shipments
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION finance2_track_shipments();
DROP TRIGGER IF EXISTS finance2_shipments_upd ON shipments;
CREATE TRIGGER finance2_shipments_upd AFTER UPDATE ON shipments
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION finance2_track_shipments();
DROP TRIGGER IF EXISTS finance2_shipments_del ON shipments;
CREATE TRIGGER finance2_shipments_del AFTER DELETE ON shipments
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION finance2_track_shipments();

DROP TRIGGER IF EXISTS finance2_order_products_ins ON order_products;
CREATE TRIGGER finance2_order_products_ins AFTER INSERT ON order_products
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION finance2_track_order_products();
DROP TRIGGER IF EXISTS finance2_order_products_upd ON order_products;
CREATE TRIGGER finance2_order_products_upd AFTER UPDATE ON order_products
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION finance2_track_order_products();
DROP TRIGGER IF EXISTS finance2_order_products_del ON order_products;
CREATE TRIGGER finance2_order_products_del AFTER DELETE ON order_products
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION finance2_track_order_products();

DROP TRIGGER IF EXISTS finance2_container_items_ins ON shipment_container_items;
CREATE TRIGGER finance2_container_items_ins AFTER INSERT ON shipment_container_items
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION finance2_track_container_items();
DROP TRIGGER IF EXISTS finance2_container_items_upd ON shipment_container_items;
CREATE TRIGGER finance2_container_items_upd AFTER UPDATE ON shipment_container_items
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION finance2_track_container_items();
DROP TRIGGER IF EXISTS finance2_container_items_del ON shipment_container_items;
CREATE TRIGGER finance2_container_items_del AFTER DELETE ON shipment_container_items
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION finance2_track_container_items();

DROP TRIGGER IF EXISTS finance2_status_logs_ins ON status_logs;
CREATE TRIGGER finance2_status_logs_ins AFTER INSERT ON status_logs
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION finance2_track_status_logs();
DROP TRIGGER IF EXISTS finance2_status_logs_upd ON status_logs;
CREATE TRIGGER finance2_status_logs_upd AFTER UPDATE ON status_logs
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION finance2_track_status_logs();
DROP TRIGGER IF EXISTS finance2_status_logs_del ON status_logs;
CREATE TRIGGER finance2_status_logs_del AFTER DELETE ON status_logs
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION finance2_track_status_logs();

DROP TRIGGER IF EXISTS finance2_containers_upd ON containers;
CREATE TRIGGER finance2_containers_upd AFTER UPDATE ON containers
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION finance2_track_containers();

DROP TRIGGER IF EXISTS finance2_users_agent_upd ON users;
CREATE TRIGGER finance2_users_agent_upd AFTER UPDATE ON users
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION finance2_track_user_agent();

-- 给现有的每一票母运单补一条（已经有记录的不补，重复执行不会补第二遍）。时间取订单 / 运单最后改动时间里晚的那个
INSERT INTO finance2_waybill_changes (company_id, waybill_no, changed_at, deleted, source)
SELECT s.company_id, s.tracking_no, GREATEST(s.updated_at, o.updated_at), false, 'backfill'
FROM shipments s
JOIN orders o ON o.id = s.order_id
WHERE s.parent_tracking_no IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM finance2_waybill_changes c WHERE c.company_id = s.company_id AND c.waybill_no = s.tracking_no
  );
