/**
 * 湘泰物流系统 — Prisma Seed
 *
 * 用途：把原 SQLite 中所有 demo 数据（用户、订单、运单、AI 状态标签、运营数据、客户钱包）
 *      一次性写入 Postgres，并补充 P0 阶段新增的 Container/Delivery/Invoice/CustomerCredit 示例。
 *
 * 运行：SEED_PASSWORD=你自己定的密码 npm run db:seed
 * 重置：npm run db:reset（会先 drop 全部表再迁移再 seed）
 *
 * demo 账号的密码从环境变量 SEED_PASSWORD 读取，代码里不写死。
 * 没设这个变量就直接退出，不建账号 —— 防止再出现「代码里能看到密码」。
 */
import { PrismaClient } from "@prisma/client";
import crypto from "node:crypto";
// 2026-09-02 终审整改：状态标签名单直接 import 唯一来源（ai-config-store），
// 删掉这里的手抄副本 —— 之前两份名单条数（16 vs 31）和中文都对不上，迟早越走越远。
// 该文件只有 type-only 的跨包 import，tsx 跑 seed 时可正常解析、无副作用。
import { DEFAULT_STATUS_LABELS } from "../src/modules/ai/ai-config-store";

const prisma = new PrismaClient();

// ============ 常量 ============
const COMPANY_ID = "c_001";
const CURRENT_WAREHOUSE_IDS = ["wh_yiwu_01", "wh_guangzhou_01", "wh_dongguan_01"];

// demo 账号密码：只从环境变量读，代码里不留明文。没设就不往下跑。
// 去首尾空格（2026-10-15）：登录页会去掉首尾空格再发，存了带空格的就登不进
const DEFAULT_PASSWORD = (process.env.SEED_PASSWORD ?? "").trim();
if (!DEFAULT_PASSWORD) {
  console.error("❌ 没有设置 SEED_PASSWORD，为避免建出弱口令账号，seed 已中止。");
  console.error("   正确用法：SEED_PASSWORD=你自己定的密码 npm run db:seed");
  process.exit(1);
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const N = 16384;
  const r = 8;
  const p = 1;
  const keyLen = 64;
  const derived = crypto.scryptSync(password, salt, keyLen, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

const DEMO_HASH = hashPassword(DEFAULT_PASSWORD);

// 2026-09-02 终审整改：状态标签不再手抄，见顶部 import（唯一来源 ai-config-store.DEFAULT_STATUS_LABELS）。
// ⚠️ 下面对 ai_status_labels 只许 upsert，绝不能加任何删行写法 —— 表里混着计费用的 min_volume 行。

async function main() {
  console.log("🌱 开始 seed...");

  // ---------------- 用户 ----------------
  const now = new Date();
  await prisma.user.upsert({
    where: { id: "u_admin_001" },
    update: {},
    create: {
      id: "u_admin_001",
      companyId: COMPANY_ID,
      role: "admin",
      name: "Admin",
      phone: "13000000001",
      status: "active",
      warehouseIds: "[]",
      passwordHash: DEMO_HASH,
      companyName: "湘泰国际物流",
      email: "admin@xiangtai.demo",
      createdAt: now,
    },
  });

  await prisma.user.upsert({
    where: { id: "u_staff_001" },
    update: {},
    create: {
      id: "u_staff_001",
      companyId: COMPANY_ID,
      role: "staff",
      name: "Staff One",
      phone: "13000000002",
      status: "active",
      warehouseIds: JSON.stringify(CURRENT_WAREHOUSE_IDS),
      passwordHash: DEMO_HASH,
      createdAt: now,
    },
  });

  await prisma.user.upsert({
    where: { id: "888888" },
    update: {},
    create: {
      id: "888888",
      companyId: COMPANY_ID,
      role: "staff",
      name: "Staff 888888",
      phone: "18888888888",
      status: "active",
      warehouseIds: JSON.stringify(CURRENT_WAREHOUSE_IDS),
      passwordHash: DEMO_HASH,
      createdAt: now,
    },
  });

  await prisma.user.upsert({
    where: { id: "u_client_001" },
    update: {},
    create: {
      id: "u_client_001",
      companyId: COMPANY_ID,
      role: "client",
      name: "Client One",
      phone: "13000000003",
      status: "active",
      warehouseIds: "[]",
      passwordHash: DEMO_HASH,
      companyName: "示范贸易有限公司",
      email: "client@xiangtai.demo",
      createdAt: now,
    },
  });

  console.log("✔ 用户 seed 完成 (4 个账号，密码取自 SEED_PASSWORD)");

  // ---------------- AI 状态标签 ----------------
  for (const item of DEFAULT_STATUS_LABELS) {
    await prisma.aiStatusLabel.upsert({
      where: { status: item.status },
      update: { labelZh: item.labelZh },
      create: { status: item.status, labelZh: item.labelZh, updatedAt: now },
    });
  }
  console.log(`✔ AI 状态标签 seed 完成 (${DEFAULT_STATUS_LABELS.length} 条)`);

  // ---------------- 演示订单 + 运单 ----------------
  type DemoSeed = {
    orderId: string;
    orderNo: string;
    shipmentId: string;
    batchNo: string;
    itemName: string;
    productQuantity: number;
    packageCount: number;
    packageUnit: string;
    domesticTrackingNo: string;
    transportMode: string;
    receiverNameTh: string;
    receiverPhoneTh: string;
    receiverAddressTh: string;
    trackingNo: string;
    currentStatus: string;
    currentLocation: string;
    weightKg: number;
    volumeM3: number;
    statusGroup: string;
    minutesAgo: number;
    cargoType: "normal" | "inspection" | "sensitive";
  };

  const demoOrders: DemoSeed[] = [
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
      // 2026-09-02 复核整改：inTransit 早已不在 STATUS_FLOW 里，全新环境会直接显示英文原文；
      // 换成海运流程里的合法状态 departed（已开船），仍属「在途/unfinished」口径
      currentStatus: "departed",
      currentLocation: "Bangkok Hub",
      weightKg: 120.5,
      volumeM3: 1.28,
      statusGroup: "unfinished",
      minutesAgo: 30,
      cargoType: "normal",
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
      cargoType: "sensitive",
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
      cargoType: "normal",
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
      cargoType: "sensitive",
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
      currentStatus: "inWarehouseCN",
      currentLocation: "义乌中转仓",
      weightKg: 98.1,
      volumeM3: 1.12,
      statusGroup: "unfinished",
      minutesAgo: 10,
      cargoType: "inspection",
    },
  ];

  for (const item of demoOrders) {
    const createdAt = new Date(now.getTime() - item.minutesAgo * 60 * 1000);
    const unitPrice = item.transportMode === "sea" ? 540 : 680;
    const chargeVolume = Math.max(item.volumeM3, item.weightKg / 500);
    const receivableAmountCny = Number((chargeVolume * unitPrice).toFixed(2));

    await prisma.order.upsert({
      where: { id: item.orderId },
      update: {},
      create: {
        id: item.orderId,
        companyId: COMPANY_ID,
        clientId: "u_client_001",
        warehouseId: "wh_yiwu_01",
        batchNo: item.batchNo,
        orderNo: item.orderNo,
        approvalStatus: "approved",
        itemName: item.itemName,
        productQuantity: item.productQuantity,
        packageCount: item.packageCount,
        packageUnit: item.packageUnit,
        weightKg: item.weightKg,
        volumeM3: item.volumeM3,
        receivableAmountCny,
        receivableCurrency: "CNY",
        paymentStatus: "unpaid",
        shipDate: createdAt.toISOString().slice(0, 10),
        domesticTrackingNo: item.domesticTrackingNo,
        transportMode: item.transportMode,
        receiverNameTh: item.receiverNameTh,
        receiverPhoneTh: item.receiverPhoneTh,
        receiverAddressTh: item.receiverAddressTh,
        statusGroup: item.statusGroup,
        cargoType: item.cargoType,
        createdAt,
        updatedAt: createdAt,
      },
    });

    await prisma.shipment.upsert({
      where: { id: item.shipmentId },
      update: {},
      create: {
        id: item.shipmentId,
        companyId: COMPANY_ID,
        orderId: item.orderId,
        trackingNo: item.trackingNo,
        batchNo: item.batchNo,
        currentStatus: item.currentStatus,
        currentLocation: item.currentLocation,
        weightKg: item.weightKg,
        volumeM3: item.volumeM3,
        packageCount: item.packageCount,
        packageUnit: item.packageUnit,
        transportMode: item.transportMode,
        domesticTrackingNo: item.domesticTrackingNo,
        warehouseId: "wh_yiwu_01",
        createdAt,
        updatedAt: createdAt,
      },
    });
  }
  console.log(`✔ 演示订单/运单 seed 完成 (${demoOrders.length} 票)`);

  // ---------------- 集装箱（Container）+ 拆柜示范 ----------------
  // CAB-2026-A01 → 柜号 TCKU1234567（20GP，在途中）
  // CAB-2026-A02 → 柜号 OOCU8888888（40HQ，已到港）
  // CAB-2026-A03 → 还未装柜，作为"待装柜"示例

  const container01 = await prisma.container.upsert({
    where: { containerNo: "TCKU1234567" },
    update: {},
    create: {
      containerNo: "TCKU1234567",
      companyId: COMPANY_ID,
      containerType: "20GP",
      loadingDate: new Date(now.getTime() - 7 * 24 * 3600 * 1000),
      departureDate: new Date(now.getTime() - 6 * 24 * 3600 * 1000),
      eta: new Date(now.getTime() + 3 * 24 * 3600 * 1000),
      currentStatus: "IN_TRANSIT",
      remark: "示范柜：覆盖 o_001、o_002（拆柜 + 拼柜）",
    },
  });

  const container02 = await prisma.container.upsert({
    where: { containerNo: "OOCU8888888" },
    update: {},
    create: {
      containerNo: "OOCU8888888",
      companyId: COMPANY_ID,
      containerType: "40HQ",
      loadingDate: new Date(now.getTime() - 18 * 24 * 3600 * 1000),
      departureDate: new Date(now.getTime() - 17 * 24 * 3600 * 1000),
      eta: new Date(now.getTime() - 4 * 24 * 3600 * 1000),
      ata: new Date(now.getTime() - 3 * 24 * 3600 * 1000),
      customsClearedAt: new Date(now.getTime() - 1 * 24 * 3600 * 1000),
      currentStatus: "DELIVERING",
      remark: "示范柜：o_003 已分两柜走，o_004 已签收",
    },
  });

  // 拆柜关系：o_001 全量在 container01；o_002 全量在 container01
  // o_003 拆两柜：1.5m³ 在 container02、0.45m³ 在 container01（演示拆柜）
  // o_004 全量在 container02
  const items = [
    { shipmentId: "s_001", containerId: container01.id, vol: 1.28, pcs: 12 },
    { shipmentId: "s_002", containerId: container01.id, vol: 0.76, pcs: 6 },
    { shipmentId: "s_003", containerId: container02.id, vol: 1.5, pcs: 15 },
    { shipmentId: "s_003", containerId: container01.id, vol: 0.45, pcs: 5 }, // 拆柜
    { shipmentId: "s_004", containerId: container02.id, vol: 0.61, pcs: 8 },
  ];
  for (const it of items) {
    await prisma.shipmentContainerItem.upsert({
      where: {
        shipmentId_containerId: {
          shipmentId: it.shipmentId,
          containerId: it.containerId,
        },
      },
      update: {},
      create: {
        shipmentId: it.shipmentId,
        containerId: it.containerId,
        loadedVolumeM3: it.vol,
        loadedPieceCount: it.pcs,
      },
    });
  }
  console.log("✔ Container + 拆柜示范 seed 完成（2 个柜，含一票拆两柜示例）");

  // ---------------- 库位（中国仓 s_005 未装柜）----------------
  await prisma.warehouseLocation.upsert({
    where: { warehouse_locationCode: { warehouse: "CN", locationCode: "CN-YW-A-01-03" } },
    update: {},
    create: {
      warehouse: "CN",
      locationCode: "CN-YW-A-01-03",
      shipmentId: "s_005",
      inAt: new Date(now.getTime() - 10 * 24 * 3600 * 1000), // 已存 10 天，未触发预警
      agingDays: 10,
      isAlerted: false,
      status: "OCCUPIED",
      remark: "义乌仓 A 区 01 排 03 号",
    },
  });
  console.log("✔ 库位示范 seed 完成");

  // ---------------- 计费规则 ----------------
  const pricingFrom = new Date(now.getFullYear(), 0, 1);
  await Promise.all(
    (["normal", "inspection", "sensitive"] as const).map((cargoType, idx) =>
      prisma.pricingRule.upsert({
        where: {
          id: `seed_price_${cargoType}`,
        },
        update: {},
        create: {
          id: `seed_price_${cargoType}`,
          companyId: COMPANY_ID,
          cargoType,
          unitPriceCny: cargoType === "normal" ? 75 : cargoType === "inspection" ? 95 : 120,
          effectiveFrom: pricingFrom,
        },
      }),
    ),
  );
  console.log("✔ 计费规则 seed 完成（普货 75 / 商检 95 / 敏感 120 CNY/m³）");

  // ---------------- 客户分级（u_client_001 默认 C 级）----------------
  await prisma.customerCredit.upsert({
    where: { customerId: "u_client_001" },
    update: {},
    create: {
      customerId: "u_client_001",
      currentLevel: "C",
      creditTermDays: 15,
      creditLimit: 50000,
      currentReceivable: 0,
      oldestUnpaidDays: 0,
      overdueCount: 0,
      evaluatedAt: now,
      manuallyAdjusted: false,
    },
  });
  console.log("✔ 客户分级 seed 完成（u_client_001 默认 C 级）");

  // ---------------- 客户钱包 + 汇率（保留原 SQLite seed）----------------
  await prisma.clientWalletAccount.upsert({
    where: { clientId_currency: { clientId: "u_client_001", currency: "CNY" } },
    update: {},
    create: { clientId: "u_client_001", companyId: COMPANY_ID, currency: "CNY", balance: 12000 },
  });
  await prisma.clientWalletAccount.upsert({
    where: { clientId_currency: { clientId: "u_client_001", currency: "THB" } },
    update: {},
    create: { clientId: "u_client_001", companyId: COMPANY_ID, currency: "THB", balance: 58000 },
  });
  await prisma.clientExchangeRate.upsert({
    where: { baseCurrency_quoteCurrency: { baseCurrency: "CNY", quoteCurrency: "THB" } },
    update: { rate: 5.06 },
    create: { baseCurrency: "CNY", quoteCurrency: "THB", rate: 5.06 },
  });
  console.log("✔ 客户钱包 + 汇率 seed 完成");

  // ---------------- 运营模块（LMP/海关/末端/结算）----------------
  await prisma.adminLmpRate.upsert({
    where: { id: "lmp_001" },
    update: {},
    create: {
      id: "lmp_001",
      companyId: COMPANY_ID,
      routeCode: "CN-TH-BKK",
      supplierName: "ThaiSea Line",
      transportMode: "sea",
      seasonTag: "peak",
      supplierCost: 4200,
      quotePrice: 5600,
      currency: "CNY",
      effectiveFrom: now.toISOString().slice(0, 10),
    },
  });
  await prisma.adminCustomsCase.upsert({
    where: { id: "cus_001" },
    update: {},
    create: {
      id: "cus_001",
      companyId: COMPANY_ID,
      shipmentId: "s_001",
      orderId: "o_001",
      status: "inspection",
      remark: "海关抽检，待补充资料",
    },
  });
  await prisma.adminLastmileOrder.upsert({
    where: { id: "lm_001" },
    update: {},
    create: {
      id: "lm_001",
      companyId: COMPANY_ID,
      shipmentId: "s_001",
      // 2026-09-02 终审顺带补：deliveryNo 是必填列，缺了它 create 路径一跑就炸
      // （seed.ts 不在任何 tsconfig 的 include 里，类型检查一直照不到这里）
      deliveryNo: "WD202600001",
      carrierName: "DHL",
      externalTrackingNo: "DHLTH0001",
      status: "inTransit",
    },
  });
  await prisma.adminSettlementEntry.upsert({
    where: { id: "set_001" },
    update: {},
    create: {
      id: "set_001",
      companyId: COMPANY_ID,
      orderId: "o_001",
      clientReceivable: 691.2,
      supplierPayable: 420.0,
      taxFee: 36.0,
      currency: "CNY",
    },
  });
  console.log("✔ 运营模块 seed 完成");

  console.log("\n🎉 全部 seed 完成。三个 demo 账号（admin / staff / client）的密码");
  console.log("   就是你刚才传进来的 SEED_PASSWORD，账号名请查数据库 users 表。");
}

main()
  .catch((e) => {
    console.error("❌ Seed 失败：", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
