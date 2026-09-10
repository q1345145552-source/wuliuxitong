/**
 * 尾端派送 / 派送单导出的「品名」要把全部产品名带出来（2026-09-10，老板反馈「品类不全」）。
 *
 * 病根：员工建单 / 客户预报单在有产品行时，订单的 itemName 只存**第一个产品名**
 * （orders/routes.ts 的 `products[0].itemName`），运单的 itemName 建单时根本不写（可能是空）。
 * 下游把它当整票品名用的地方，这里**真调路由**（Prisma 换成内存桩）逐个盯：
 *   ① 尾端派送卡片      GET /admin/lastmile/orders
 *   ② 客户签收单导出    GET /admin/lastmile/customer-export-data（分柜单不展开产品行那条路）
 *   ③ 整柜拆柜派送清单  GET /staff/loading-manifests/export-data（products 故意为空）
 *   ④ 可派送运单候选    真前端 fetchLastmileShipments → 真 GET /staff/shipments?all=1（翻两页）
 *   ⑤ 卡片上的「物流轨迹」子单页签  GET /client/shipments/track 的 children[]（Codex 2026-09-10 复核 P1）
 *
 * ⚠️ 桩是**严格**的（Codex 复核 P2 之后改）：
 *   · 只回 select / include 里点名的字段——查询里少选一个字段，这里就拿不到，测试当场红；
 *   · 没实现的模型 / 方法一被调到就抛错，不许静默通过。
 * ⚠️ 全程不连数据库：import 之前把 globalThis.__prisma 换成桩（照 test-client-status-group.ts 的写法）。
 */
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/never?connect_timeout=1";
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { productNamesLabel } from "../packages/shared-types/product-names";

type Handler = (req: any, res: any) => Promise<void> | void;
const failures: string[] = [];
let total = 0;
async function check(name: string, body: () => Promise<void> | void): Promise<void> {
  total += 1;
  try { await body(); console.log(`  ✅ ${name}`); }
  catch (error) {
    failures.push(name);
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ❌ ${name}\n     ${message.split("\n").join("\n     ")}`);
  }
}

/* ── 严格桩：按 Prisma 的 select / include / orderBy / take 语义裁剪返回值 ── */
function sortBy(rows: any[], orderBy: any): any[] {
  if (!orderBy || !Array.isArray(rows)) return rows;
  const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const spec of specs) {
      const [key, dir] = Object.entries(spec as Record<string, string>)[0];
      const av = a[key], bv = b[key];
      if (av === bv) continue;
      const cmp = av > bv ? 1 : -1;
      return dir === "desc" ? -cmp : cmp;
    }
    return 0;
  });
}
/** select：只留点名的字段；include：标量全留、关系按子规则裁剪。两者都递归处理嵌套 */
function shape(row: any, args: any): any {
  if (row == null || !args) return row;
  const select = args.select as Record<string, any> | undefined;
  const include = args.include as Record<string, any> | undefined;
  const scalarsOnly = (v: any): any => {
    if (v == null || typeof v !== "object" || v instanceof Date) return v;
    if (Array.isArray(v)) return v.map(scalarsOnly);
    const out: any = {};
    for (const [key, value] of Object.entries(v)) if (value == null || typeof value !== "object" || value instanceof Date) out[key] = value;
    return out;
  };
  const relation = (value: any, spec: any) => {
    // 关系写成 `true`：只给那张表的标量，它下面的关系不给（Codex 第三轮 P3：原来原样带出整棵子树）
    if (spec === true) return scalarsOnly(value);
    if (spec == null) return value;
    let next = value;
    if (Array.isArray(next)) {
      next = sortBy(next, spec.orderBy);
      if (typeof spec.take === "number") next = next.slice(0, spec.take);
      return next.map((x: any) => shape(x, spec));
    }
    return shape(next, spec);
  };
  if (select) {
    const out: any = {};
    for (const [key, spec] of Object.entries(select)) {
      if (spec === false || spec == null) continue;
      out[key] = spec === true ? row[key] : relation(row[key], spec);
    }
    return out;
  }
  if (include) {
    // Prisma 的 include 语义：标量全给，**关系只给点名的**（Codex 第二轮 P2-1：原来 {...row} 把没 include 的关系也漏出去了）
    const isScalar = (v: any) => v == null || typeof v !== "object" || v instanceof Date;
    const out: any = {};
    for (const [key, value] of Object.entries(row)) if (isScalar(value)) out[key] = value;
    for (const [key, spec] of Object.entries(include)) {
      if (spec === false || spec == null) continue;
      out[key] = relation(row[key], spec);
    }
    return out;
  }
  // 既没 select 也没 include：只给标量，关系一律不给（跟 Prisma 一样）
  const out: any = {};
  for (const [key, value] of Object.entries(row)) if (value == null || typeof value !== "object" || value instanceof Date) out[key] = value;
  return out;
}
function strict(name: string, methods: Record<string, (args: any) => Promise<any>>) {
  return new Proxy(methods, {
    get(target, prop) {
      if (typeof prop === "symbol" || prop === "then") return undefined;
      if (!(prop in target)) throw new Error(`桩没实现 ${name}.${String(prop)}——路由多查了东西，先看是不是查询变了`);
      return target[prop as string];
    },
  });
}

/* ── 夹具：一张订单三个产品，第一个产品叫「鞋」——改前所有地方都只印「鞋」 ── */
const PRODUCTS = [
  { id: "p1", companyId: "c_001", orderId: "o1", itemName: "鞋", sortOrder: 0, packageCount: 2, lengthCm: 60, widthCm: 40, heightCm: 30, weightKg: 2, productQuantity: null, cargoType: "normal", domesticTrackingNo: "货拉拉" },
  { id: "p2", companyId: "c_001", orderId: "o1", itemName: "包", sortOrder: 1, packageCount: 2, lengthCm: 60, widthCm: 40, heightCm: 30, weightKg: 2, productQuantity: null, cargoType: "normal", domesticTrackingNo: "货拉拉" },
  { id: "p3", companyId: "c_001", orderId: "o1", itemName: "帽", sortOrder: 2, packageCount: 1, lengthCm: 60, widthCm: 40, heightCm: 30, weightKg: 2, productQuantity: null, cargoType: "normal", domesticTrackingNo: "货拉拉" },
  // 同名不同尺寸的第四行：拼出来只许出现一次「鞋」
  { id: "p4", companyId: "c_001", orderId: "o1", itemName: "鞋", sortOrder: 3, packageCount: 1, lengthCm: 50, widthCm: 40, heightCm: 30, weightKg: 2, productQuantity: null, cargoType: "normal", domesticTrackingNo: "货拉拉" },
];
const EXPECTED = "鞋 / 包 / 帽";
const client = { name: "客户一", phone: "0800000000", addresses: [] as any[] };
const orderBase = {
  id: "o1", orderNo: "NO-o1", clientId: "MARK1", itemName: "鞋", packageCount: 6, packageUnit: "box", weightKg: 12, volumeM3: 0.432,
  productQuantity: null, cargoType: "normal", transportMode: "sea", shipDate: "2026-09-01",
  receivableAmountCny: null, receivableCurrency: "CNY", paymentStatus: "unpaid",
  receiverNameTh: "收货人A", receiverPhoneTh: "0811111111", receiverAddressTh: "曼谷某路 1 号",
  client, products: PRODUCTS,
};

/** 整票（没分柜）运单 */
const wholeShipment = {
  id: "s1", orderId: "o1", trackingNo: "YW0001", parentTrackingNo: null, batchNo: null, containerNo: null, domesticTrackingNo: null,
  itemName: "鞋", packageCount: 6, packageUnit: "box", weightKg: 12, volumeM3: 0.432, remark: "", currentStatus: "inWarehouseTH",
  currentLocation: null, warehouseId: "wh_yiwu_01", updatedAt: new Date(0), createdAt: new Date(0), containerItems: [] as any[], statusLogs: [] as any[],
  order: { ...orderBase, shipments: [{ trackingNo: "YW0001", parentTrackingNo: null, packageCount: 6, weightKg: 12, volumeM3: 0.432 }] },
};
/** 分柜后的子单：客户单导出对它**不展开**产品行，整票只有一行 */
const childShipment = {
  ...wholeShipment,
  id: "s1c", trackingNo: "YW0001-1", parentTrackingNo: "YW0001", itemName: "鞋", packageCount: 2, weightKg: 4, volumeM3: 0.144,
  order: {
    ...orderBase,
    shipments: [
      { trackingNo: "YW0001", parentTrackingNo: null, packageCount: 4, weightKg: 8, volumeM3: 0.288 },
      { trackingNo: "YW0001-1", parentTrackingNo: "YW0001", packageCount: 2, weightKg: 4, volumeM3: 0.144 },
    ],
  },
};
/** 没有产品行的老运单 */
const legacyOrder = { ...orderBase, id: "o9", orderNo: "NO-o9", itemName: "老单品名", products: [] as any[], shipments: [] as any[] };
const legacyShipment = { ...wholeShipment, id: "s9", orderId: "o9", trackingNo: "YW0009", itemName: "老单品名", order: legacyOrder };

/* ── 桩的数据源：各用例自己摆 ── */
let lastmileRows: any[] = [];
let lastmileQueries: any[] = [];       // adminLastmileOrder.findMany 收到的查询参数
let containerRow: any = null;
let shipmentPool: any[] = [];          // GET /staff/shipments 的列表
let trackParent: any = null;           // GET /client/shipments/track 的父单
let trackChildren: any[] = [];         // 它的子单

(globalThis as any).__prisma = new Proxy({
  orderProduct: strict("orderProduct", {
    async findMany(args) {
      const ids: string[] = args?.where?.orderId?.in ?? [];
      const rows = sortBy(PRODUCTS.filter((p) => ids.includes(p.orderId)), args?.orderBy);
      return rows.map((r) => shape(r, args));
    },
  }),
  orderProductImage: strict("orderProductImage", { async findMany() { return []; } }),
  adminLastmileOrder: strict("adminLastmileOrder", {
    async findMany(args) {
      lastmileQueries.push(args); // 记下查询参数，第 2 项直接断言 select（Codex 第二轮 P2-2）
      // 列表接口第二次查询只取「有签收图的 id」：这里没有图，回空
      if (args?.where?.AND) return [];
      return lastmileRows.map((r) => shape(r, args));
    },
    async findFirst() { return null; },
  }),
  container: strict("container", { async findFirst(args) { return shape(containerRow, args); } }),
  shipment: strict("shipment", {
    async count() { return shipmentPool.length; },
    async findFirst(args) { return shape(trackParent, args); },
    async findMany(args) {
      // 轨迹接口查子单
      if (args?.where?.parentTrackingNo) return trackChildren.map((r) => shape(r, args));
      // 列表接口的整票合计（total-metrics.ts）：只有 select 没有分页
      if (args?.select && args?.skip === undefined) return [];
      // /staff/shipments 列表本身：翻页
      const skip = args?.skip ?? 0, take = args?.take ?? shipmentPool.length;
      return shipmentPool.slice(skip, skip + take).map((r) => shape(r, args));
    },
  }),
}, {
  get(target, prop) {
    if (typeof prop === "symbol" || prop === "then") return undefined;
    if (!(prop in target)) throw new Error(`桩没实现模型 ${String(prop)}——路由多查了表，先看是不是查询变了`);
    return (target as any)[prop];
  },
});

/** 把真前端源码（TS 转 CJS）装进 vm 跑，fetch 直接打到真路由处理函数（照 test-attention-filter.ts 的写法） */
function loadWebModule(relative: string, fetchImpl: (input: string, init?: RequestInit) => Promise<Response>) {
  const root = process.cwd();
  const stored = new Map([["auth_session_v1", JSON.stringify({ userId: "staff1", companyId: "c_001", role: "staff", token: "fixture-token" })]]);
  const localStorage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v), removeItem: (k: string) => stored.delete(k), key: (i: number) => [...stored.keys()][i] ?? null, get length() { return stored.size; } };
  const context = vm.createContext({ window: { localStorage, location: { pathname: "/staff" } }, console, URLSearchParams, Response, Request, Headers, AbortController, atob, setTimeout, clearTimeout, process: { env: {} }, fetch: fetchImpl });
  const cache = new Map<string, Record<string, any>>();
  function load(rel: string): Record<string, any> {
    const file = path.resolve(root, rel);
    if (cache.has(file)) return cache.get(file)!;
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const mod = { exports: {} }; cache.set(file, mod.exports);
    const require = (name: string) => { assert.ok(name.startsWith("."), "Unexpected external module: " + name); return load(path.resolve(path.dirname(file), name + (path.extname(name) ? "" : ".ts"))); };
    vm.runInContext(`(function(require,module,exports){${code}\n})`, context, { filename: file })(require, mod, mod.exports);
    return mod.exports;
  }
  return load(relative);
}

async function main(): Promise<void> {
  const routes = new Map<string, Handler>();
  const fakeApp: any = {
    get(p: string, h: Handler) { routes.set(`GET ${p}`, h); },
    post(p: string, h: Handler) { routes.set(`POST ${p}`, h); },
    put(p: string, h: Handler) { routes.set(`PUT ${p}`, h); },
    delete(p: string, h: Handler) { routes.set(`DELETE ${p}`, h); },
    listen() {},
  };
  const adminOps = await import("../apps/api/src/modules/admin-ops/routes");
  const manifests = await import("../apps/api/src/modules/loading-manifests/routes");
  const shipments = await import("../apps/api/src/modules/shipments/routes");
  const containers = await import("../apps/api/src/modules/containers/routes");
  (adminOps as any).registerAdminOpsRoutes(fakeApp);
  (manifests as any).registerLoadingManifestRoutes(fakeApp);
  (shipments as any).registerShipmentRoutes(fakeApp);
  (containers as any).registerContainerRoutes(fakeApp);
  const exporter = await import("../apps/web/src/modules/lastmile/exportDispatchWorkbooks");

  const staffAuth = { userId: "staff1", companyId: "c_001", role: "staff", name: "测试员工" };
  async function call(key: string, query: Record<string, string> = {}): Promise<{ status: number; data: any; raw: any }> {
    const handler = routes.get(key);
    assert.ok(handler, `没注册到 ${key}`);
    let status = 200;
    let payload: any = {};
    const res: any = { status(c: number) { status = c; return res; }, json(v: unknown) { payload = v; } };
    await handler!({ method: key.split(" ")[0], path: key.split(" ")[1], query, headers: {}, body: undefined, auth: staffAuth }, res);
    return { status, data: payload?.data ?? payload, raw: payload };
  }

  console.log("尾端派送 / 派送单的品名要带全部产品名");

  await check("1) 拼名字的共享函数：按录入顺序、去重、空的退回原品名", () => {
    assert.equal(productNamesLabel(PRODUCTS), EXPECTED);
    assert.equal(productNamesLabel([{ itemName: "帽", sortOrder: 2 }, { itemName: "鞋", sortOrder: 0 }]), "鞋 / 帽", "要按 sortOrder 排");
    assert.equal(productNamesLabel([], "老单品名"), "老单品名");
    assert.equal(productNamesLabel(undefined, "老单品名"), "老单品名");
    assert.equal(productNamesLabel([{ itemName: "  " }], "老单品名"), "老单品名", "全是空白当没有");
    assert.equal(productNamesLabel([{ itemName: " 鞋 " }, { itemName: "鞋" }]), "鞋", "前后空格要去掉再去重");
    // 变异自证：改前的行为（只取第一个）在这里必须是错的
    assert.notEqual(productNamesLabel(PRODUCTS), PRODUCTS[0].itemName, "只带出第一个产品名就是老病");
  });

  await check("2) 尾端派送卡片（GET /admin/lastmile/orders）：品名是三个产品全拼，且没把签收图查回来", async () => {
    lastmileRows = [{
      id: "lm1", deliveryNo: "WD000001", shipmentId: "s1", deliveryDate: "2026-09-10", carrierName: "自营",
      externalTrackingNo: "", driverName: "张三", licensePlate: "", phoneNumber: "", status: "DELIVERING", updatedAt: new Date(0),
      signImageBase64: "NEVER-SELECT-THIS",
      shipment: { ...wholeShipment, order: orderBase },
    }];
    lastmileQueries = [];
    const r = await call("GET /admin/lastmile/orders");
    assert.equal(r.status, 200, `应该 200，实际 ${r.status}`);
    assert.equal(r.data.items?.length, 1);
    assert.equal(r.data.items[0].itemName, EXPECTED, `卡片品名不对：${r.data.items[0].itemName}`);
    assert.equal(r.data.items[0].hasSignImage, false);
    assert.ok(!JSON.stringify(r.raw).includes("NEVER-SELECT-THIS"), "列表接口把签收图查回来了（8-22 那个 113MB 的坑）");
    // ⭐ 直接看 Prisma 查询参数，不只看响应（响应组装时会把多查的字段丢掉，看响应看不出「多查了」）
    const listQuery = lastmileQueries.find((q) => !q?.where?.AND);
    assert.ok(listQuery?.select, "列表查询必须用 select 点名字段，不许 include / 不写 select（会把签收图整列拖回来）");
    assert.notEqual(listQuery.select.signImageBase64, true, "列表查询把 signImageBase64 选进来了（8-22 那个 113MB 的坑）");
    assert.deepEqual(
      Object.keys(listQuery.select.shipment?.select?.order?.select?.products?.select ?? {}).sort(),
      ["itemName", "sortOrder"],
      "卡片只该多查产品的 itemName / sortOrder 两个字段，多一个都是白拖",
    );
    // 第二次「有没有签收图」的查询只许选 id（Codex 第三轮 P3）
    const flagQuery = lastmileQueries.find((q) => q?.where?.AND);
    assert.ok(flagQuery, "少了「有没有签收图」那次轻量查询");
    assert.deepEqual(Object.keys(flagQuery.select ?? {}), ["id"], "「有没有图」那次查询只许选 id，不许把图本身带回来");
  });

  await check("2b) 没有产品行的老运单 / 运单 itemName 为空：卡片退回原来的名字，不编造", async () => {
    lastmileRows = [
      { id: "lm2", deliveryNo: "WD000002", shipmentId: "s9", deliveryDate: "", carrierName: "自营", externalTrackingNo: "", driverName: "", licensePlate: "", phoneNumber: "", status: "DELIVERING", updatedAt: new Date(0), shipment: { ...legacyShipment, order: legacyOrder } },
      { id: "lm3", deliveryNo: "WD000002", shipmentId: "s9n", deliveryDate: "", carrierName: "自营", externalTrackingNo: "", driverName: "", licensePlate: "", phoneNumber: "", status: "DELIVERING", updatedAt: new Date(0), shipment: { ...legacyShipment, id: "s9n", trackingNo: "YW0009N", itemName: null, order: legacyOrder } },
    ];
    const r = await call("GET /admin/lastmile/orders");
    assert.equal(r.data.items[0].itemName, "老单品名");
    assert.equal(r.data.items[1].itemName, null, "运单没品名又没产品行：保持 null，前端显示「品名未填写」");
  });

  await check("3) 客户签收单（分柜子单，不展开产品行）：那一行的品名是三个产品全拼，件数是子单自己的", async () => {
    lastmileRows = [{
      id: "lm3", carrierName: "自营", driverName: "张三", licensePlate: "กท-1234", phoneNumber: "0800000000",
      deliveryDate: "2026-09-10", status: "DELIVERING", shipment: childShipment,
    }];
    const r = await call("GET /admin/lastmile/customer-export-data", { deliveryNo: "WD000003", clientId: "MARK1" });
    assert.equal(r.status, 200, `应该 200，实际 ${r.status}：${JSON.stringify(r.data).slice(0, 200)}`);
    const shipment = r.data.customers[0].shipments[0];
    assert.deepEqual(shipment.products, [], "分柜子单不该展开产品行（会把件数重复算回整票）");
    assert.equal(shipment.itemName, EXPECTED, `子单品名不对：${shipment.itemName}`);
    const lines = exporter.expandTemplateLines(r.data);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].itemName, EXPECTED);
    assert.equal(lines[0].packageCount, 2, "子单件数还是子单自己的 2");
  });

  await check("3b) 客户签收单（整票没分柜）：展开成一行一个产品，四行名字齐全", async () => {
    lastmileRows = [{
      id: "lm4", carrierName: "自营", driverName: "", licensePlate: "", phoneNumber: "",
      deliveryDate: "", status: "DELIVERING", shipment: wholeShipment,
    }];
    const r = await call("GET /admin/lastmile/customer-export-data", { deliveryNo: "WD000004", clientId: "MARK1" });
    assert.equal(r.status, 200);
    const shipment = r.data.customers[0].shipments[0];
    assert.equal(shipment.products.length, 4, "整票要展开全部产品行");
    assert.equal(shipment.itemName, EXPECTED);
    const lines = exporter.expandTemplateLines(r.data);
    assert.deepEqual(lines.map((l) => l.itemName), ["鞋", "包", "帽", "鞋"]);
    assert.equal(lines.reduce((s, l) => s + l.packageCount, 0), 6, "展开后件数合计仍是整票 6");
  });

  await check("4) 整柜拆柜派送清单（GET /staff/loading-manifests/export-data）：一票一行，品名三个全拼，数字不动", async () => {
    containerRow = {
      id: "ct1", containerNo: "CT-2026-001", containerType: "40HQ", warehouseId: "wh_yiwu_01", transportMode: "sea",
      carrierName: "班次A", currentStatus: "loaded",
      items: [{ id: "ci1", loadedPieceCount: 6, loadedVolumeM3: 0.432, createdAt: new Date(0), shipment: wholeShipment }],
    };
    const r = await call("GET /staff/loading-manifests/export-data", { id: "ct1" });
    assert.equal(r.status, 200, `应该 200，实际 ${r.status}：${JSON.stringify(r.data).slice(0, 200)}`);
    const shipment = r.data.customers[0].shipments[0];
    assert.deepEqual(shipment.products, [], "整柜清单本来就不展开产品行");
    assert.equal(shipment.itemName, EXPECTED, `清单品名不对：${shipment.itemName}`);
    // 长宽高那条老逻辑没被带坏：60 和 50 两种长度并排；件数 / 方数 / 重量是本柜实际装入的
    assert.equal(shipment.lengthCm, "60/50");
    assert.equal(shipment.widthCm, 40);
    assert.equal(shipment.packageCount, 6);
    assert.equal(shipment.volumeM3, 0.432);
    assert.equal(shipment.weightKg, 12);
    const lines = exporter.expandTemplateLines(r.data);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].itemName, EXPECTED);
    assert.equal(lines[0].packageCount, 6, "件数还是本柜实际装入的 6");
  });

  await check("4b) 整柜清单里没有产品行的老运单：品名退回运单自己的，长宽高照旧留空", async () => {
    containerRow = {
      id: "ct2", containerNo: "CT-2026-002", containerType: "40HQ", warehouseId: "wh_yiwu_01", transportMode: "sea",
      carrierName: "", currentStatus: "loaded",
      items: [{ id: "ci2", loadedPieceCount: 1, loadedVolumeM3: 0.1, createdAt: new Date(0), shipment: legacyShipment }],
    };
    const r = await call("GET /staff/loading-manifests/export-data", { id: "ct2" });
    assert.equal(r.status, 200);
    const shipment = r.data.customers[0].shipments[0];
    assert.equal(shipment.itemName, "老单品名");
    assert.equal(shipment.lengthCm, null);
    assert.equal(exporter.expandTemplateLines(r.data)[0].lengthCm, null);
  });

  await check("5) 可派送候选列表：真前端 fetchLastmileShipments → 真 GET /staff/shipments?all=1，翻两页，父单/子单品名都全", async () => {
    const filler = Array.from({ length: 498 }, (_, i) => ({
      ...legacyShipment, id: `sf${i}`, orderId: "o9", trackingNo: `YW9${String(i).padStart(4, "0")}`,
    }));
    shipmentPool = [wholeShipment, childShipment, legacyShipment, ...filler];
    const pages: string[] = [];
    const api = loadWebModule("apps/web/src/services/business-api.ts", async (input: string, init?: RequestInit) => {
      const url = new URL(input, "http://fixture.invalid");
      assert.equal(url.pathname, "/staff/shipments");
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture-token");
      const query: Record<string, string> = {}; url.searchParams.forEach((v, k) => { query[k] = v; });
      pages.push(query.page);
      assert.equal(query.all, "1", "候选列表必须带 all=1（子单也要能派）");
      const r = await call("GET /staff/shipments", query);
      return new Response(JSON.stringify(r.raw), { status: r.status });
    });
    const list = await api.fetchLastmileShipments();
    assert.equal(list.length, 501, `501 票要全拿到，实际 ${list.length}`);
    assert.deepEqual(pages, ["1", "2"], "501 票要翻两页");
    const byNo = new Map<string, any>(list.map((s: any) => [s.trackingNo, s] as [string, any]));
    assert.equal(byNo.get("YW0001")?.itemName, EXPECTED, "父单品名不全");
    assert.equal(byNo.get("YW0001-1")?.itemName, EXPECTED, "子单（同一张订单）品名不全");
    assert.equal(byNo.get("YW0009")?.itemName, "老单品名", "老单退回原品名");
    assert.equal(byNo.get("YW0001")?.packageCount, 6);
    assert.equal(byNo.get("YW0001-1")?.packageCount, 2, "子单件数还是子单自己的");
  });

  await check("6) 卡片「物流轨迹」的子单页签（GET /client/shipments/track）：子单品名带全，父单产品行不变", async () => {
    trackParent = wholeShipment;
    trackChildren = [
      { ...childShipment, statusLogs: [] },
      { ...childShipment, id: "s1d", trackingNo: "YW0001-2", itemName: null, packageCount: 1, statusLogs: [] },
    ];
    const r = await call("GET /client/shipments/track", { trackingNo: "YW0001" });
    assert.equal(r.status, 200, `应该 200，实际 ${r.status}：${JSON.stringify(r.data).slice(0, 200)}`);
    assert.deepEqual(r.data.products.map((p: any) => p.itemName), ["鞋", "包", "帽", "鞋"], "父单页签的产品行要原样");
    assert.equal(r.data.children?.length, 2);
    assert.equal(r.data.children[0].itemName, EXPECTED, `子单页签品名不对：${r.data.children[0].itemName}`);
    assert.equal(r.data.children[1].itemName, EXPECTED, "运单 itemName 为空的子单也要从订单产品行拼出来");
    assert.equal(r.data.children[0].packageCount, 2);
    assert.equal(r.data.children[1].packageCount, 1, "子单件数不许被父单的盖掉");
  });

  await check("7) 装柜管理柜内货物（GET /staff/loading-manifests/detail）：品名三个全拼，老单退回原品名（老板 9-10 追加）", async () => {
    containerRow = {
      id: "ct3", containerNo: "CT-2026-003", containerType: "40HQ", warehouseId: "wh_yiwu_01", transportMode: "sea",
      carrierName: "", currentStatus: "LOADING", sealedAt: null,
      items: [
        { id: "ci3", shipmentId: "s1", loadedPieceCount: 6, loadedVolumeM3: 0.432, createdAt: new Date(0), shipment: wholeShipment },
        { id: "ci4", shipmentId: "s9", loadedPieceCount: 1, loadedVolumeM3: 0.1, createdAt: new Date(1), shipment: legacyShipment },
      ],
    };
    const r = await call("GET /staff/loading-manifests/detail", { id: "ct3" });
    assert.equal(r.status, 200, `应该 200，实际 ${r.status}：${JSON.stringify(r.data).slice(0, 200)}`);
    assert.equal(r.data.bills.length, 2);
    assert.equal(r.data.bills[0].itemName, EXPECTED, `柜内货物品名不对：${r.data.bills[0].itemName}`);
    assert.equal(r.data.bills[0].loadedPieces, 6, "装入件数不许变");
    assert.equal(r.data.bills[0].packageCount, 6);
    assert.equal(r.data.bills[1].itemName, "老单品名");
  });

  console.log(`\n共 ${total} 项，失败 ${failures.length} 项`);
  if (failures.length > 0) {
    console.log("失败：\n  - " + failures.join("\n  - "));
    process.exit(1);
  }
  console.log("✅ 全部通过");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
