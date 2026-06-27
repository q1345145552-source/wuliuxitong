-- ============================================================================
-- 同步 Prisma Schema 与数据库实际结构的差异
-- 日期: 2026-06-27
-- 设计：所有 DDL 使用 IF NOT EXISTS / DO 块保护，可安全重复执行
-- ============================================================================

-- ── 1. PricingRule: 添加缺失列 ──

-- transportMode (transport_mode)
ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS transport_mode TEXT NOT NULL DEFAULT 'sea';

-- disableMinVolume (disable_min_volume)
ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS disable_min_volume BOOLEAN NOT NULL DEFAULT false;

-- 处理 unit_price_usd → unit_price_cny 重命名
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pricing_rules' AND column_name = 'unit_price_usd'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pricing_rules' AND column_name = 'unit_price_cny'
  ) THEN
    ALTER TABLE pricing_rules RENAME COLUMN unit_price_usd TO unit_price_cny;
  END IF;
END $$;

-- 重建索引以包含 transport_mode
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'pricing_rules' AND indexname = 'pricing_rules_company_id_cargo_type_customer_id_idx'
  ) THEN
    DROP INDEX pricing_rules_company_id_cargo_type_customer_id_idx;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS pricing_rules_company_id_transport_mode_cargo_type_customer_id_idx
  ON pricing_rules (company_id, transport_mode, cargo_type, customer_id);

-- ── 2. AdminLastmileOrder: 添加缺失列 ──

ALTER TABLE admin_lastmile_orders ADD COLUMN IF NOT EXISTS delivery_no TEXT;
ALTER TABLE admin_lastmile_orders ADD COLUMN IF NOT EXISTS driver_name TEXT;
ALTER TABLE admin_lastmile_orders ADD COLUMN IF NOT EXISTS license_plate TEXT;
ALTER TABLE admin_lastmile_orders ADD COLUMN IF NOT EXISTS phone_number TEXT;
ALTER TABLE admin_lastmile_orders ADD COLUMN IF NOT EXISTS sign_image_base64 TEXT;
ALTER TABLE admin_lastmile_orders ADD COLUMN IF NOT EXISTS delivery_date TEXT;

-- 为 delivery_no 添加 unique 约束（先给已有数据补值，再建唯一索引）
-- 避免因现有数据 delivery_no 为空导致冲突
UPDATE admin_lastmile_orders SET delivery_no = id WHERE delivery_no IS NULL OR delivery_no = '';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'admin_lastmile_orders' AND indexname = 'admin_lastmile_orders_delivery_no_key'
  ) THEN
    CREATE UNIQUE INDEX admin_lastmile_orders_delivery_no_key ON admin_lastmile_orders (delivery_no);
  END IF;
END $$;

-- ── 3. StatusLog: 添加 operator_name ──

ALTER TABLE status_logs ADD COLUMN IF NOT EXISTS operator_name TEXT NOT NULL DEFAULT '';

-- ── 4. ClientNote: 创建整表（如不存在） ──

CREATE TABLE IF NOT EXISTS client_notes (
  id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT client_notes_pkey PRIMARY KEY (id)
);

-- 如果表刚创建，加唯一约束
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'client_notes' AND indexname = 'client_notes_client_id_key'
  ) THEN
    CREATE UNIQUE INDEX client_notes_client_id_key ON client_notes (client_id);
  END IF;
END $$;

-- ── 5. FK 约束修正（onDelete: Cascade） ──

-- AdminLastmileOrder → Shipment: RESTRICT → CASCADE
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'admin_lastmile_orders_shipment_id_fkey'
  ) THEN
    ALTER TABLE admin_lastmile_orders DROP CONSTRAINT admin_lastmile_orders_shipment_id_fkey;
  END IF;
END $$;
ALTER TABLE admin_lastmile_orders ADD CONSTRAINT admin_lastmile_orders_shipment_id_fkey
  FOREIGN KEY (shipment_id) REFERENCES shipments(id) ON DELETE CASCADE ON UPDATE CASCADE;

-- AdminSettlementEntry → Order: RESTRICT → CASCADE
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'admin_settlement_entries_order_id_fkey'
  ) THEN
    ALTER TABLE admin_settlement_entries DROP CONSTRAINT admin_settlement_entries_order_id_fkey;
  END IF;
END $$;
ALTER TABLE admin_settlement_entries ADD CONSTRAINT admin_settlement_entries_order_id_fkey
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 6. cargoType 大小写统一（大写 → 小写） ──

UPDATE orders SET cargo_type = LOWER(cargo_type) WHERE cargo_type != LOWER(cargo_type);
UPDATE order_products SET cargo_type = LOWER(cargo_type) WHERE cargo_type != LOWER(cargo_type);

-- ── 7. 额外索引（性能优化） ──

CREATE INDEX IF NOT EXISTS orders_order_no_idx ON orders (order_no);
CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS orders_approval_status_idx ON orders (approval_status);
CREATE INDEX IF NOT EXISTS invoice_lines_order_id_idx ON invoice_lines (order_id);
CREATE INDEX IF NOT EXISTS admin_customs_cases_shipment_id_idx ON admin_customs_cases (shipment_id);
CREATE INDEX IF NOT EXISTS admin_customs_cases_order_id_idx ON admin_customs_cases (order_id);
CREATE INDEX IF NOT EXISTS admin_settlement_entries_company_id_idx ON admin_settlement_entries (company_id);
