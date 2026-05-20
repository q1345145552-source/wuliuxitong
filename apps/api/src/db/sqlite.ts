/**
 * ⚠️ DEPRECATED — 此文件已不再使用（2026-05-20）
 *
 * 系统已完成 SQLite → PostgreSQL 迁移：
 *   - 数据访问层：apps/api/src/db/prisma.ts（PrismaClient）
 *   - Schema 管理：apps/api/prisma/schema.prisma
 *   - 数据初始化：apps/api/prisma/seed.ts
 *
 * 本文件保留 1 个月作为回滚缓冲，预计 2026-06-20 后删除。
 * 不要在任何地方 import 此文件。
 */
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface DbContext {
  db: DatabaseSync;
}

const CURRENT_WAREHOUSE_IDS = ["wh_yiwu_01", "wh_guangzhou_01", "wh_dongguan_01"] as const;
const DEFAULT_WAREHOUSE_ID = "wh_yiwu_01";
const LEGACY_WAREHOUSE_IDS = ["wh_bkk_01", "wh_bkk_02"] as const;
const DEMO_STAFF_ACCOUNT_ID = "888888";

function dbFilePath(): string {
  const custom = process.env.SQLITE_PATH;
  if (custom?.trim()) return custom;
  return path.join(process.cwd(), "apps", "api", "data", "dev.sqlite");
}

function nowIso(): string {
  return new Date().toISOString();
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const cost = 16384;
  const blockSize = 8;
  const parallelization = 1;
  const keyLen = 64;
  const derived = crypto.scryptSync(password, salt, keyLen, { N: cost, r: blockSize, p: parallelization });
  return `scrypt$${cost}$${blockSize}$${parallelization}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export function createDbContext(): DbContext {
  const file = dbFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  ensureSchema(db);
  // For existing dev DBs, backfill newly added columns.
  ensureDefaultReceivableAmounts(db);
  ensureDefaultPaymentStatus(db);
  ensureSeedData(db);
  ensurePresetStaffAccount(db);
  ensureDefaultPasswordHashes(db);
  ensureClientDemoOrders(db);
  ensureClientFinanceSeed(db);
  ensureAdminOpsSeed(db);
  ensureWarehouseCompatibility(db);
  ensureShipmentsForApprovedOrders(db);
  ensureShipmentOrderLinks(db, undefined);
  return { db };
}

function ensureSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      role TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      status TEXT NOT NULL,
      warehouse_ids TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      warehouse_id TEXT NOT NULL,
      batch_no TEXT,
      order_no TEXT,
      approval_status TEXT NOT NULL DEFAULT 'approved',
      item_name TEXT NOT NULL,
      product_quantity INTEGER NOT NULL,
      package_count INTEGER NOT NULL,
      package_unit TEXT NOT NULL,
      weight_kg REAL,
      volume_m3 REAL,
      receivable_amount_cny REAL,
      receivable_currency TEXT NOT NULL DEFAULT 'CNY',
      payment_status TEXT NOT NULL DEFAULT 'unpaid',
      paid_at TEXT,
      paid_by TEXT,
      payment_proof_file_name TEXT,
      payment_proof_mime TEXT,
      payment_proof_base64 TEXT,
      payment_proof_uploaded_at TEXT,
      ship_date TEXT,
      domestic_tracking_no TEXT,
      transport_mode TEXT NOT NULL,
      receiver_name_th TEXT NOT NULL,
      receiver_phone_th TEXT NOT NULL,
      receiver_address_th TEXT NOT NULL,
      status_group TEXT NOT NULL DEFAULT 'unfinished',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shipments (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      tracking_no TEXT NOT NULL UNIQUE,
      batch_no TEXT,
      container_no TEXT,
      current_status TEXT NOT NULL,
      current_location TEXT,
      weight_kg REAL,
      volume_m3 REAL,
      package_count INTEGER,
      package_unit TEXT,
      transport_mode TEXT,
      domestic_tracking_no TEXT,
      warehouse_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS status_logs (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      shipment_id TEXT NOT NULL,
      operator_id TEXT NOT NULL,
      operator_role TEXT NOT NULL,
      from_status TEXT NOT NULL,
      to_status TEXT NOT NULL,
      remark TEXT,
      changed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_session_memory (
      key TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      intent TEXT,
      item_name TEXT,
      status_scope TEXT,
      time_hint TEXT,
      metric TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_status_labels (
      status TEXT PRIMARY KEY,
      label_zh TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_knowledge_items (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_audit_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      company_id TEXT NOT NULL,
      session_id TEXT,
      question TEXT NOT NULL,
      answer_summary TEXT NOT NULL,
      referenced_order_ids TEXT,
      referenced_shipment_ids TEXT,
      queried_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_knowledge_gaps (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      session_id TEXT,
      question TEXT NOT NULL,
      answer_summary TEXT NOT NULL,
      knowledge_count_at_ask INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT
    );

    CREATE TABLE IF NOT EXISTS client_addresses (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      contact_name TEXT NOT NULL,
      contact_phone TEXT NOT NULL,
      address_detail TEXT NOT NULL,
      lat REAL,
      lng REAL,
      label TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ai_session_memory_updated_at ON ai_session_memory(updated_at);
    CREATE INDEX IF NOT EXISTS idx_ai_knowledge_items_company_created ON ai_knowledge_items(company_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_audit_logs_company_queried ON ai_audit_logs(company_id, queried_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_knowledge_gaps_company_status_created
      ON ai_knowledge_gaps(company_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_client_addresses_client_updated
      ON client_addresses(client_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS client_documents (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      doc_type TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime TEXT NOT NULL,
      content_base64 TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS client_wallet_accounts (
      client_id TEXT NOT NULL,
      company_id TEXT NOT NULL,
      currency TEXT NOT NULL,
      balance REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (client_id, currency)
    );

    CREATE TABLE IF NOT EXISTS client_exchange_rates (
      base_currency TEXT NOT NULL,
      quote_currency TEXT NOT NULL,
      rate REAL NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (base_currency, quote_currency)
    );

    CREATE INDEX IF NOT EXISTS idx_client_documents_client_created
      ON client_documents(client_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS staff_inbound_photos (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      shipment_id TEXT NOT NULL,
      operator_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime TEXT NOT NULL,
      content_base64 TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_staff_inbound_photos_shipment_created
      ON staff_inbound_photos(shipment_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS order_product_images (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime TEXT NOT NULL,
      content_base64 TEXT NOT NULL,
      uploaded_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_order_product_images_order_created
      ON order_product_images(company_id, order_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS admin_lmp_rates (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      route_code TEXT NOT NULL,
      supplier_name TEXT NOT NULL,
      transport_mode TEXT NOT NULL,
      season_tag TEXT NOT NULL,
      supplier_cost REAL NOT NULL,
      quote_price REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'CNY',
      effective_from TEXT NOT NULL,
      effective_to TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_customs_cases (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      shipment_id TEXT,
      order_id TEXT,
      status TEXT NOT NULL,
      remark TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_lastmile_orders (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      shipment_id TEXT NOT NULL,
      carrier_name TEXT NOT NULL,
      external_tracking_no TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_settlement_entries (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      client_receivable REAL NOT NULL,
      supplier_payable REAL NOT NULL,
      tax_fee REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'CNY',
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_admin_lmp_rates_route_updated
      ON admin_lmp_rates(route_code, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_customs_cases_status_updated
      ON admin_customs_cases(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_lastmile_orders_shipment_updated
      ON admin_lastmile_orders(shipment_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_settlement_entries_order_updated
      ON admin_settlement_entries(order_id, updated_at DESC);
  `);
  ensureAdditionalColumns(db);
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function ensureAdditionalColumns(db: DatabaseSync): void {
  // 兼容历史库：早期订单表可能使用 order_id 而非 id，先补列再回填，避免查询时报 no such column: o.id。
  ensureLegacyOrderIdColumn(db);
  if (!hasColumn(db, "orders", "batch_no")) {
    db.exec("ALTER TABLE orders ADD COLUMN batch_no TEXT;");
  }
  if (!hasColumn(db, "orders", "approval_status")) {
    db.exec("ALTER TABLE orders ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'approved';");
  }
  if (!hasColumn(db, "shipments", "batch_no")) {
    db.exec("ALTER TABLE shipments ADD COLUMN batch_no TEXT;");
  }
  if (!hasColumn(db, "shipments", "container_no")) {
    db.exec("ALTER TABLE shipments ADD COLUMN container_no TEXT;");
  }
  if (!hasColumn(db, "orders", "order_no")) {
    db.exec("ALTER TABLE orders ADD COLUMN order_no TEXT;");
  }
  if (!hasColumn(db, "orders", "weight_kg")) {
    db.exec("ALTER TABLE orders ADD COLUMN weight_kg REAL;");
  }
  if (!hasColumn(db, "orders", "volume_m3")) {
    db.exec("ALTER TABLE orders ADD COLUMN volume_m3 REAL;");
  }
  if (!hasColumn(db, "orders", "receivable_amount_cny")) {
    db.exec("ALTER TABLE orders ADD COLUMN receivable_amount_cny REAL;");
  }
  if (!hasColumn(db, "orders", "receivable_currency")) {
    db.exec("ALTER TABLE orders ADD COLUMN receivable_currency TEXT NOT NULL DEFAULT 'CNY';");
  }
  if (!hasColumn(db, "orders", "payment_status")) {
    db.exec("ALTER TABLE orders ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'unpaid';");
  }
  if (!hasColumn(db, "orders", "paid_at")) {
    db.exec("ALTER TABLE orders ADD COLUMN paid_at TEXT;");
  }
  if (!hasColumn(db, "orders", "paid_by")) {
    db.exec("ALTER TABLE orders ADD COLUMN paid_by TEXT;");
  }
  if (!hasColumn(db, "orders", "payment_proof_file_name")) {
    db.exec("ALTER TABLE orders ADD COLUMN payment_proof_file_name TEXT;");
  }
  if (!hasColumn(db, "orders", "payment_proof_mime")) {
    db.exec("ALTER TABLE orders ADD COLUMN payment_proof_mime TEXT;");
  }
  if (!hasColumn(db, "orders", "payment_proof_base64")) {
    db.exec("ALTER TABLE orders ADD COLUMN payment_proof_base64 TEXT;");
  }
  if (!hasColumn(db, "orders", "payment_proof_uploaded_at")) {
    db.exec("ALTER TABLE orders ADD COLUMN payment_proof_uploaded_at TEXT;");
  }
  if (!hasColumn(db, "orders", "ship_date")) {
    db.exec("ALTER TABLE orders ADD COLUMN ship_date TEXT;");
  }
  if (!hasColumn(db, "users", "password_hash")) {
    db.exec("ALTER TABLE users ADD COLUMN password_hash TEXT;");
  }
  if (!hasColumn(db, "users", "company_name")) {
    db.exec("ALTER TABLE users ADD COLUMN company_name TEXT;");
  }
  if (!hasColumn(db, "users", "email")) {
    db.exec("ALTER TABLE users ADD COLUMN email TEXT;");
  }
}

function ensureLegacyOrderIdColumn(db: DatabaseSync): void {
  const hasId = hasColumn(db, "orders", "id");
  const hasOrderId = hasColumn(db, "orders", "order_id");
  const hasOrderNo = hasColumn(db, "orders", "order_no");
  if (hasId) return;

  db.exec("ALTER TABLE orders ADD COLUMN id TEXT;");
  if (hasOrderId) {
    db.exec("UPDATE orders SET id = order_id WHERE id IS NULL OR TRIM(id) = '';");
    return;
  }
  if (hasOrderNo) {
    db.exec("UPDATE orders SET id = COALESCE(NULLIF(order_no, ''), 'legacy-' || rowid) WHERE id IS NULL OR TRIM(id) = '';");
    return;
  }
  db.exec("UPDATE orders SET id = 'legacy-' || rowid WHERE id IS NULL OR TRIM(id) = '';");
}

function estimateReceivableAmountCny(input: {
  transportMode: string | null;
  weightKg: number | null;
  volumeM3: number | null;
}): number | null {
  const mode = (input.transportMode ?? "").trim().toLowerCase();
  const unitPrice = mode === "sea" ? 540 : mode === "land" ? 680 : null;
  if (!unitPrice) return null;
  const weight = typeof input.weightKg === "number" && !Number.isNaN(input.weightKg) ? Math.max(input.weightKg, 0) : 0;
  const volume = typeof input.volumeM3 === "number" && !Number.isNaN(input.volumeM3) ? Math.max(input.volumeM3, 0) : 0;
  if (weight <= 0 && volume <= 0) return null;
  const chargeVolume = Math.max(volume, weight / 500);
  if (!Number.isFinite(chargeVolume) || chargeVolume <= 0) return null;
  const amount = chargeVolume * unitPrice;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Number(amount.toFixed(2));
}

function ensureDefaultReceivableAmounts(db: DatabaseSync): void {
  if (!hasColumn(db, "orders", "receivable_amount_cny")) return;
  if (!hasColumn(db, "orders", "receivable_currency")) return;

  // Backfill only when amount is missing; don't override staff-confirmed final values.
  const rows = db
    .prepare(
      `
      SELECT id, transport_mode, weight_kg, volume_m3
      FROM orders
      WHERE approval_status = 'approved'
        AND (receivable_amount_cny IS NULL OR receivable_amount_cny <= 0)
      `,
    )
    .all() as Array<{ id: string; transport_mode: string | null; weight_kg: number | null; volume_m3: number | null }>;
  if (rows.length === 0) return;

  const update = db.prepare(`
    UPDATE orders
    SET receivable_amount_cny = ?, receivable_currency = CASE
      WHEN receivable_currency IS NULL OR TRIM(receivable_currency) = '' THEN 'CNY'
      ELSE receivable_currency
    END
    WHERE id = ?
  `);
  for (const row of rows) {
    const amount = estimateReceivableAmountCny({
      transportMode: row.transport_mode,
      weightKg: row.weight_kg,
      volumeM3: row.volume_m3,
    });
    if (amount === null) continue;
    update.run(amount, row.id);
  }
}

function ensureDefaultPaymentStatus(db: DatabaseSync): void {
  if (!hasColumn(db, "orders", "payment_status")) return;
  db.exec(`
    UPDATE orders
    SET payment_status = 'unpaid'
    WHERE payment_status IS NULL OR TRIM(payment_status) = ''
  `);
}

function ensureSeedData(db: DatabaseSync): void {
  const hasUsers = db.prepare("SELECT COUNT(1) as count FROM users").get() as { count: number };
  if (hasUsers.count > 0) return;

  const insertUser = db.prepare(`
    INSERT INTO users (id, company_id, role, name, phone, status, warehouse_ids, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertOrder = db.prepare(`
    INSERT INTO orders (
      id, company_id, client_id, warehouse_id, batch_no, order_no, approval_status, item_name, product_quantity, package_count, package_unit,
      weight_kg, volume_m3, receivable_amount_cny, receivable_currency, ship_date, domestic_tracking_no, transport_mode, receiver_name_th, receiver_phone_th, receiver_address_th,
      status_group, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertShipment = db.prepare(`
    INSERT INTO shipments (
      id, company_id, order_id, tracking_no, batch_no, current_status, current_location, weight_kg, volume_m3,
      package_count, package_unit, transport_mode, domestic_tracking_no, warehouse_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = nowIso();
  insertUser.run("u_admin_001", "c_001", "admin", "Admin", "13000000001", "active", JSON.stringify([]), now);
  insertUser.run(
    "u_staff_001",
    "c_001",
    "staff",
    "Staff One",
    "13000000002",
    "active",
    JSON.stringify(CURRENT_WAREHOUSE_IDS),
    now,
  );
  insertUser.run(
    "u_client_001",
    "c_001",
    "client",
    "Client One",
    "13000000003",
    "active",
    JSON.stringify([]),
    now,
  );

  insertOrder.run(
    "o_001",
    "c_001",
    "u_client_001",
    "wh_bkk_01",
    "CAB-2026-A01",
    "ORDER-2026-0001",
    "approved",
    "手机壳",
    200,
    12,
    "box",
    120.5,
    1.28,
    691.2,
    "CNY",
    now.slice(0, 10),
    "SF12345678",
    "sea",
    "Somchai",
    "0812345678",
    "Bangkok",
    "unfinished",
    now,
    now,
  );

  insertShipment.run(
    "s_001",
    "c_001",
    "o_001",
    "THCN0001",
    "CAB-2026-A01",
    "inTransit",
    "Bangkok Hub",
    120.5,
    1.28,
    12,
    "box",
    "sea",
    "SF12345678",
    "wh_bkk_01",
    now,
    now,
  );
}

function ensurePresetStaffAccount(db: DatabaseSync): void {
  const existed = db.prepare("SELECT COUNT(1) as count FROM users WHERE id = ?").get(DEMO_STAFF_ACCOUNT_ID) as {
    count: number;
  };
  if (existed.count > 0) return;

  const now = nowIso();
  db.prepare(`
    INSERT INTO users (id, company_id, role, name, phone, status, warehouse_ids, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    DEMO_STAFF_ACCOUNT_ID,
    "c_001",
    "staff",
    "Staff 888888",
    "18888888888",
    "active",
    JSON.stringify(CURRENT_WAREHOUSE_IDS),
    now,
  );
}

function ensureDefaultPasswordHashes(db: DatabaseSync): void {
  const rows = db
    .prepare("SELECT id FROM users WHERE status = 'active' AND (password_hash IS NULL OR TRIM(password_hash) = '')")
    .all() as Array<{ id: string }>;
  if (rows.length === 0) return;
  const stmt = db.prepare("UPDATE users SET password_hash = ? WHERE id = ?");
  const defaultHash = hashPassword("123456");
  for (const row of rows) {
    stmt.run(defaultHash, row.id);
  }
}

function ensureClientDemoOrders(db: DatabaseSync): void {
  const hasClient = db
    .prepare("SELECT COUNT(1) as count FROM users WHERE id = ? AND role = ?")
    .get("u_client_001", "client") as { count: number };
  if (hasClient.count === 0) return;

  const insertOrder = db.prepare(`
    INSERT OR IGNORE INTO orders (
      id, company_id, client_id, warehouse_id, batch_no, order_no, approval_status, item_name, product_quantity, package_count, package_unit,
      weight_kg, volume_m3, receivable_amount_cny, receivable_currency,
      ship_date, domestic_tracking_no, transport_mode, receiver_name_th, receiver_phone_th, receiver_address_th,
      status_group, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertShipment = db.prepare(`
    INSERT OR IGNORE INTO shipments (
      id, company_id, order_id, tracking_no, batch_no, current_status, current_location, weight_kg, volume_m3,
      package_count, package_unit, transport_mode, domestic_tracking_no, warehouse_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const demoOrders = [
    {
      orderId: "o_001",
      orderNo: "ORDER-2026-0001",
      shipmentId: "s_001",
      batchNo: "CAB-2026-A01",
      itemName: "手机壳",
      productQuantity: 200,
      packageCount: 12,
      packageUnit: "box",
      domesticTrackingNo: "SF12345678",
      transportMode: "sea",
      receiverNameTh: "Somchai",
      receiverPhoneTh: "0812345678",
      receiverAddressTh: "Bangkok",
      trackingNo: "THCN0001",
      currentStatus: "inTransit",
      currentLocation: "Bangkok Hub",
      weightKg: 120.5,
      volumeM3: 1.28,
      statusGroup: "unfinished",
      minutesAgo: 30,
    },
    {
      orderId: "o_002",
      orderNo: "ORDER-2026-0002",
      shipmentId: "s_002",
      batchNo: "CAB-2026-A01",
      itemName: "蓝牙耳机",
      productQuantity: 180,
      packageCount: 6,
      packageUnit: "box",
      domesticTrackingNo: "YT99820001",
      transportMode: "land",
      receiverNameTh: "Anan",
      receiverPhoneTh: "0820000000",
      receiverAddressTh: "Chiang Mai",
      trackingNo: "THCN0002",
      currentStatus: "customsTH",
      currentLocation: "Bangkok Customs",
      weightKg: 86.2,
      volumeM3: 0.76,
      statusGroup: "unfinished",
      minutesAgo: 25,
    },
    {
      orderId: "o_003",
      orderNo: "ORDER-2026-0003",
      shipmentId: "s_003",
      batchNo: "CAB-2026-A02",
      itemName: "服装",
      productQuantity: 500,
      packageCount: 20,
      packageUnit: "bag",
      domesticTrackingNo: "ZT66009988",
      transportMode: "sea",
      receiverNameTh: "Niran",
      receiverPhoneTh: "0831112222",
      receiverAddressTh: "Pattaya",
      trackingNo: "THCN0003",
      currentStatus: "warehouseTH",
      currentLocation: "Pattaya Warehouse",
      weightKg: 210.0,
      volumeM3: 1.95,
      statusGroup: "unfinished",
      minutesAgo: 20,
    },
    {
      orderId: "o_004",
      orderNo: "ORDER-2026-0004",
      shipmentId: "s_004",
      batchNo: "CAB-2026-A02",
      itemName: "美妆套装",
      productQuantity: 160,
      packageCount: 8,
      packageUnit: "box",
      domesticTrackingNo: "JD55667788",
      transportMode: "land",
      receiverNameTh: "Kanya",
      receiverPhoneTh: "0899991111",
      receiverAddressTh: "Khon Kaen",
      trackingNo: "THCN0004",
      currentStatus: "delivered",
      currentLocation: "Khon Kaen",
      weightKg: 72.4,
      volumeM3: 0.61,
      statusGroup: "completed",
      minutesAgo: 15,
    },
    {
      orderId: "o_005",
      orderNo: "ORDER-2026-0005",
      shipmentId: "s_005",
      batchNo: "CAB-2026-A03",
      itemName: "家居收纳盒",
      productQuantity: 240,
      packageCount: 10,
      packageUnit: "box",
      domesticTrackingNo: "SF99887700",
      transportMode: "sea",
      receiverNameTh: "Prasert",
      receiverPhoneTh: "0862223333",
      receiverAddressTh: "Phuket",
      trackingNo: "THCN0005",
      currentStatus: "receivedCN",
      currentLocation: "Shenzhen Warehouse",
      weightKg: 98.1,
      volumeM3: 1.12,
      statusGroup: "unfinished",
      minutesAgo: 10,
    },
  ] as const;

  for (const item of demoOrders) {
    const createdAt = new Date(Date.now() - item.minutesAgo * 60 * 1000).toISOString();
    const unitPrice = item.transportMode === "sea" ? 540 : 680;
    const chargeVolume = Math.max(item.volumeM3, item.weightKg / 500);
    const receivableAmountCny = Number((chargeVolume * unitPrice).toFixed(2));
    insertOrder.run(
      item.orderId,
      "c_001",
      "u_client_001",
      "wh_bkk_01",
      item.batchNo,
      item.orderNo,
      "approved",
      item.itemName,
      item.productQuantity,
      item.packageCount,
      item.packageUnit,
      item.weightKg,
      item.volumeM3,
      receivableAmountCny,
      "CNY",
      createdAt.slice(0, 10),
      item.domesticTrackingNo,
      item.transportMode,
      item.receiverNameTh,
      item.receiverPhoneTh,
      item.receiverAddressTh,
      item.statusGroup,
      createdAt,
      createdAt,
    );

    insertShipment.run(
      item.shipmentId,
      "c_001",
      item.orderId,
      item.trackingNo,
      item.batchNo,
      item.currentStatus,
      item.currentLocation,
      item.weightKg,
      item.volumeM3,
      item.packageCount,
      item.packageUnit,
      item.transportMode,
      item.domesticTrackingNo,
      "wh_bkk_01",
      createdAt,
      createdAt,
    );
  }
}

/**
 * 初始化客户端资金账户与汇率种子数据。
 */
function ensureClientFinanceSeed(db: DatabaseSync): void {
  const clientExists = db
    .prepare("SELECT COUNT(1) as count FROM users WHERE id = ? AND role = ?")
    .get("u_client_001", "client") as { count: number };
  if (clientExists.count === 0) return;
  const now = nowIso();
  db.prepare(
    `
    INSERT OR IGNORE INTO client_wallet_accounts (client_id, company_id, currency, balance, updated_at)
    VALUES (?, ?, ?, ?, ?)
    `,
  ).run("u_client_001", "c_001", "CNY", 12000, now);
  db.prepare(
    `
    INSERT OR IGNORE INTO client_wallet_accounts (client_id, company_id, currency, balance, updated_at)
    VALUES (?, ?, ?, ?, ?)
    `,
  ).run("u_client_001", "c_001", "THB", 58000, now);
  db.prepare(
    `
    INSERT OR REPLACE INTO client_exchange_rates (base_currency, quote_currency, rate, updated_at)
    VALUES (?, ?, ?, ?)
    `,
  ).run("CNY", "THB", 5.06, now);
}

/**
 * 初始化管理员端运营模块的演示数据。
 */
function ensureAdminOpsSeed(db: DatabaseSync): void {
  const now = nowIso();
  db.prepare(
    `
    INSERT OR IGNORE INTO admin_lmp_rates (
      id, company_id, route_code, supplier_name, transport_mode, season_tag,
      supplier_cost, quote_price, currency, effective_from, effective_to, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run("lmp_001", "c_001", "CN-TH-BKK", "ThaiSea Line", "sea", "peak", 4200, 5600, "CNY", now.slice(0, 10), null, now);
  db.prepare(
    `
    INSERT OR IGNORE INTO admin_customs_cases (
      id, company_id, shipment_id, order_id, status, remark, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
  ).run("cus_001", "c_001", "s_001", "o_001", "inspection", "海关抽检，待补充资料", now);
  db.prepare(
    `
    INSERT OR IGNORE INTO admin_lastmile_orders (
      id, company_id, shipment_id, carrier_name, external_tracking_no, status, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
  ).run("lm_001", "c_001", "s_001", "DHL", "DHLTH0001", "inTransit", now);
  db.prepare(
    `
    INSERT OR IGNORE INTO admin_settlement_entries (
      id, company_id, order_id, client_receivable, supplier_payable, tax_fee, currency, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run("set_001", "c_001", "o_001", 691.2, 420.0, 36.0, "CNY", now);
}

function ensureWarehouseCompatibility(db: DatabaseSync): void {
  const staffRows = db
    .prepare("SELECT id, warehouse_ids FROM users WHERE role = 'staff'")
    .all() as Array<{ id: string; warehouse_ids: string }>;

  const updateUserWarehouses = db.prepare("UPDATE users SET warehouse_ids = ? WHERE id = ?");
  for (const row of staffRows) {
    let parsed: string[] = [];
    try {
      const value = JSON.parse(row.warehouse_ids);
      parsed = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    } catch {
      parsed = [];
    }

    const normalized = parsed.map((item) => item.trim()).filter(Boolean);
    const mapped = normalized.flatMap((item) => {
      if (LEGACY_WAREHOUSE_IDS.includes(item as (typeof LEGACY_WAREHOUSE_IDS)[number])) {
        return [DEFAULT_WAREHOUSE_ID];
      }
      return [item];
    });
    const deduped = Array.from(new Set(mapped));
    const validCurrent = deduped.filter((item) =>
      CURRENT_WAREHOUSE_IDS.includes(item as (typeof CURRENT_WAREHOUSE_IDS)[number]),
    );

    if (validCurrent.length === 0) {
      updateUserWarehouses.run(JSON.stringify(CURRENT_WAREHOUSE_IDS), row.id);
      continue;
    }
    if (JSON.stringify(validCurrent) !== JSON.stringify(normalized)) {
      updateUserWarehouses.run(JSON.stringify(validCurrent), row.id);
    }
  }

  const updateOrderWarehouse = db.prepare("UPDATE orders SET warehouse_id = ? WHERE warehouse_id = ?");
  const updateShipmentWarehouse = db.prepare("UPDATE shipments SET warehouse_id = ? WHERE warehouse_id = ?");
  for (const legacyId of LEGACY_WAREHOUSE_IDS) {
    updateOrderWarehouse.run(DEFAULT_WAREHOUSE_ID, legacyId);
    updateShipmentWarehouse.run(DEFAULT_WAREHOUSE_ID, legacyId);
  }
}

function ensureShipmentsForApprovedOrders(db: DatabaseSync): void {
  const rows = db.prepare(`
    SELECT
      o.id, o.company_id, o.batch_no, o.warehouse_id, o.package_count, o.package_unit, o.transport_mode,
      o.domestic_tracking_no, o.weight_kg, o.volume_m3, o.created_at, o.updated_at
    FROM orders o
    LEFT JOIN shipments s ON s.order_id = o.id AND s.company_id = o.company_id
    WHERE o.approval_status = 'approved' AND s.id IS NULL
  `).all() as Array<{
    id: string;
    company_id: string;
    batch_no: string | null;
    warehouse_id: string;
    package_count: number;
    package_unit: string;
    transport_mode: string;
    domestic_tracking_no: string | null;
    weight_kg: number | null;
    volume_m3: number | null;
    created_at: string;
    updated_at: string;
  }>;
  if (rows.length === 0) return;

  const insertShipment = db.prepare(`
    INSERT OR IGNORE INTO shipments (
      id, company_id, order_id, tracking_no, batch_no, current_status, current_location, weight_kg, volume_m3,
      package_count, package_unit, transport_mode, domestic_tracking_no, warehouse_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  rows.forEach((row, idx) => {
    const now = new Date().toISOString();
    insertShipment.run(
      `s_sync_${Date.now()}_${idx}`,
      row.company_id,
      row.id,
      `AUTO_${row.id}`,
      row.batch_no,
      "created",
      null,
      row.weight_kg,
      row.volume_m3,
      row.package_count,
      row.package_unit,
      row.transport_mode,
      row.domestic_tracking_no,
      row.warehouse_id,
      row.created_at || now,
      row.updated_at || now,
    );
  });
}

/** 补建订单并关联运单后的结果统计。 */
export type RepairOrderLinksResult = {
  repairedShipmentIds: string[];
  skipped: Array<{ shipmentId: string; reason: string }>;
};

/**
 * 修复运单与订单脱节：order_id 为空、空串，或指向已删除/不属于本公司的订单时，补建一条订单并写回运单。
 * 在进程启动时执行一次；也可由管理接口手动触发。
 * @param shipmentIdFilter 若传入，仅尝试修复该运单（须同时满足 company 条件）。
 */
export function ensureShipmentOrderLinks(
  db: DatabaseSync,
  companyIdFilter?: string,
  shipmentIdFilter?: string,
): RepairOrderLinksResult {
  const repairedShipmentIds: string[] = [];
  const skipped: Array<{ shipmentId: string; reason: string }> = [];

  const companySql = companyIdFilter?.trim() ? "AND s.company_id = ?" : "";
  const shipmentSql = shipmentIdFilter?.trim() ? "AND s.id = ?" : "";
  const bindParams: string[] = [];
  if (companyIdFilter?.trim()) bindParams.push(companyIdFilter.trim());
  if (shipmentIdFilter?.trim()) bindParams.push(shipmentIdFilter.trim());

  const orphans = db
    .prepare(
      `
      SELECT
        s.id AS sid,
        s.company_id,
        s.warehouse_id,
        s.tracking_no,
        s.batch_no,
        s.created_at,
        s.updated_at,
        s.weight_kg,
        s.volume_m3,
        s.package_count,
        s.package_unit,
        s.transport_mode,
        s.domestic_tracking_no
      FROM shipments s
      LEFT JOIN orders o ON o.id = s.order_id AND o.company_id = s.company_id
      WHERE (s.order_id IS NULL OR TRIM(s.order_id) = '' OR o.id IS NULL)
      ${companySql}
      ${shipmentSql}
      `,
    )
    .all(...bindParams) as Array<{
      sid: string;
      company_id: string;
      warehouse_id: string;
      tracking_no: string;
      batch_no: string | null;
      created_at: string;
      updated_at: string;
      weight_kg: number | null;
      volume_m3: number | null;
      package_count: number | null;
      package_unit: string | null;
      transport_mode: string | null;
      domestic_tracking_no: string | null;
    }>;

  if (orphans.length === 0 && shipmentIdFilter?.trim()) {
    const sid = shipmentIdFilter.trim();
    const shipRow = db
      .prepare(
        `
        SELECT s.id, o.id AS oid
        FROM shipments s
        LEFT JOIN orders o ON o.id = s.order_id AND o.company_id = s.company_id
        WHERE s.id = ?
        ${companySql}
        `,
      )
      .get(...(companyIdFilter?.trim() ? [sid, companyIdFilter.trim()] : [sid])) as
      | { id: string; oid: string | null }
      | undefined;
    if (!shipRow) {
      skipped.push({ shipmentId: sid, reason: "shipment_not_found" });
    } else if (shipRow.oid) {
      skipped.push({ shipmentId: sid, reason: "already_linked" });
    }
  }

  if (orphans.length === 0) {
    return { repairedShipmentIds, skipped };
  }

  const pickClient = db.prepare(`SELECT id FROM users WHERE company_id = ? AND role = 'client' LIMIT 1`);
  const pickAnyUser = db.prepare(`SELECT id FROM users WHERE company_id = ? LIMIT 1`);
  const insertOrder = db.prepare(`
    INSERT INTO orders (
      id, company_id, client_id, warehouse_id, batch_no, order_no, approval_status, item_name, product_quantity, package_count, package_unit,
      weight_kg, volume_m3, receivable_amount_cny, receivable_currency, ship_date, domestic_tracking_no, transport_mode, receiver_name_th, receiver_phone_th, receiver_address_th,
      status_group, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateShipment = db.prepare(`UPDATE shipments SET order_id = ?, updated_at = ? WHERE id = ?`);

  orphans.forEach((row, idx) => {
    const clientRow = pickClient.get(row.company_id) as { id: string } | undefined;
    const fallbackUser = pickAnyUser.get(row.company_id) as { id: string } | undefined;
    const clientId = clientRow?.id ?? fallbackUser?.id;
    if (!clientId) {
      console.warn(
        `[sqlite] ensureShipmentOrderLinks: skip shipment ${row.sid}, no users in company ${row.company_id}`,
      );
      skipped.push({ shipmentId: row.sid, reason: "no_company_user" });
      return;
    }
    const orderId = `o_repair_${Date.now()}_${idx}_${crypto.randomBytes(3).toString("hex")}`;
    const now = new Date().toISOString();
    const createdAt = row.created_at || now;
    const shipDate = createdAt.slice(0, 10);
    const itemName = row.batch_no?.trim() || `运单 ${row.tracking_no}`;
    const pkgCount = Math.max(1, Math.floor(Number(row.package_count ?? 1)));
    const productQty = pkgCount;
    const pu = row.package_unit === "bag" ? "bag" : "box";
    const tm = row.transport_mode === "land" ? "land" : "sea";

    try {
      insertOrder.run(
        orderId,
        row.company_id,
        clientId,
        row.warehouse_id,
        row.batch_no?.trim() || null,
        null,
        "approved",
        itemName,
        productQty,
        pkgCount,
        pu,
        row.weight_kg,
        row.volume_m3,
        null,
        "CNY",
        shipDate,
        row.domestic_tracking_no ?? null,
        tm,
        "",
        "",
        "",
        "unfinished",
        createdAt,
        now,
      );
      updateShipment.run(orderId, now, row.sid);
      repairedShipmentIds.push(row.sid);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[sqlite] ensureShipmentOrderLinks: failed for shipment ${row.sid}:`, err);
      skipped.push({ shipmentId: row.sid, reason: `insert_failed:${msg}` });
    }
  });

  return { repairedShipmentIds, skipped };
}
