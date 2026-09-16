/**
 * 老板 2026-09-15 拍板的三件小改动，一个脚本盯住（不连数据库、不连网络、不写文件）：
 *
 *  R1「是谁操作的」只给超级管理员看 —— 员工、客户的**接口返回**里都不许带操作人身份
 *     （operatorId / operatorName / operatorRole / paymentReviewedBy / createdBy / creatorName /
 *      createdByRole / paidBy …），页面也不显示；管理员一切照旧。
 *     ⚠️ 前端不显示 ≠ 看不到（CLAUDE.md 第 31 条），所以这里**真调路由**看返回，不是 grep 源码。
 *     ⚠️ 字段恰好为空 = 测不出来（第 31 条④）：夹具里操作人一律填上真名字「员工甲 / 老板本人」。
 *  R2 打印标签去掉底部「湘泰物流网站」，其余内容不动。
 *  R3 客户派送签收单去掉「📧 请签收后拍照/扫描回传…微信/Line」那句 —— 用**真模板**生成，
 *     中文页、泰文页、续页、共享字符串里都不许再有；上面那句「⚠️ 签字即代表…」和合计公式、行高照旧。
 *
 * 写法照 test-lastmile-product-names.ts：import 路由之前把 globalThis.__prisma 换成内存桩，
 * 桩按 select / include 裁剪返回值（查询里没选的字段拿不到），没实现的模型/方法一被调到就抛错。
 */
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/never?connect_timeout=1";
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";
import JSZip from "../apps/web/node_modules/jszip";
import { buildLastmileTemplateWorkbook, type LastmileExportData } from "../apps/web/src/modules/lastmile/exportDispatchWorkbooks";
import {
  OPERATOR_IDENTITY_FIELDS,
  canSeeOperatorIdentity,
  hideOperatorIdentity,
  hideOperatorInRemark,
} from "../apps/api/src/modules/core/operator-visibility";

type Row = Record<string, any>;
type Handler = (req: any, res: any) => Promise<void> | void;
const ROOT = process.cwd();
const webRequire = createRequire(path.resolve(ROOT, "apps/web/package.json"));

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

/* ── 三种身份。操作人名字故意起得很好认，返回里只要出现就是漏了 ── */
const STAFF = { userId: "u_staff_jia", companyId: "c1", role: "staff", name: "员工甲", agentId: null };
const ADMIN = { userId: "u_admin_boss", companyId: "c1", role: "admin", name: "老板本人", agentId: null };
const CLIENT = { userId: "MARK1", companyId: "c1", role: "client", name: "客户一", agentId: null };
const IDENTITY_VALUES = [STAFF.name, STAFF.userId, ADMIN.name, ADMIN.userId];

/* ── 严格桩：按 Prisma 的 select / include / orderBy / take 语义裁剪 ── */
const isScalar = (v: unknown): boolean =>
  v == null || typeof v !== "object" || v instanceof Date || (Array.isArray(v) && v.every((x) => x == null || typeof x !== "object"));
function sortBy(rows: Row[], orderBy: any): Row[] {
  if (!orderBy) return rows;
  const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const spec of specs) {
      const [key, dir] = Object.entries(spec as Record<string, any>)[0];
      if (a[key] === b[key]) continue;
      const cmp = a[key] > b[key] ? 1 : -1;
      return dir === "desc" ? -cmp : cmp;
    }
    return 0;
  });
}
function shape(value: any, spec: any): any {
  if (value == null) return value;
  if (Array.isArray(value)) {
    let rows = sortBy(value, spec?.orderBy);
    if (typeof spec?.take === "number") rows = rows.slice(0, spec.take);
    return rows.map((r) => shapeOne(r, spec));
  }
  return shapeOne(value, spec);
}
function shapeOne(row: Row, spec: any): Row {
  const out: Row = {};
  if (spec?.select) {
    for (const [key, sub] of Object.entries(spec.select as Record<string, any>)) {
      if (!sub) continue;
      assert.ok(key in row, `夹具缺字段 ${key}（路由 select 了它）`);
      out[key] = sub === true ? (isScalar(row[key]) ? row[key] : shape(row[key], {})) : shape(row[key], sub);
    }
    return out;
  }
  for (const [key, v] of Object.entries(row)) if (isScalar(v)) out[key] = v;
  for (const [key, sub] of Object.entries((spec?.include ?? {}) as Record<string, any>)) {
    if (!sub) continue;
    assert.ok(key in row, `夹具缺关系 ${key}（路由 include 了它）`);
    out[key] = shape(row[key], sub === true ? {} : sub);
  }
  return out;
}
function strict(name: string, methods: Record<string, (args: any) => any>): any {
  return new Proxy(methods, {
    get(target, prop) {
      if (typeof prop === "symbol" || prop === "then") return undefined;
      if (!(prop in target)) throw new Error(`桩没实现 ${name}.${String(prop)}——路由多查了东西，先看是不是查询变了`);
      return target[prop as string];
    },
  });
}

/* ── 夹具 ── */
const T0 = new Date("2026-09-01T01:00:00Z");
const T1 = new Date("2026-09-02T01:00:00Z");
const T2 = new Date("2026-09-03T01:00:00Z");

/** 运单轨迹：一条员工写的、一条管理员写的 */
const shipmentLogs = (shipmentId: string): Row[] => [
  { id: `${shipmentId}_l1`, companyId: "c1", shipmentId, fromStatus: "created", toStatus: "inWarehouseCN", remark: "入库拍照完成", nextStop: null, changedAt: T0, operatorId: STAFF.userId, operatorRole: "staff", operatorName: STAFF.name },
  { id: `${shipmentId}_l2`, companyId: "c1", shipmentId, fromStatus: "inWarehouseCN", toStatus: "loaded", remark: "装入柜子 ABCU1234567（分装 2件）", nextStop: null, changedAt: T1, operatorId: ADMIN.userId, operatorRole: "admin", operatorName: ADMIN.name },
];
const trackParent: Row = {
  id: "s1", companyId: "c1", orderId: "o1", trackingNo: "YW0001", parentTrackingNo: null, batchNo: "ABCU1234567", itemName: "鞋",
  packageCount: 2, volumeM3: 0.4, weightKg: 8, currentStatus: "loaded", currentLocation: null, createdAt: T0, updatedAt: T1,
  order: { id: "o1", orderNo: "NO1", itemName: "鞋", clientId: CLIENT.userId, receiverNameTh: "收货人", receiverAddressTh: "曼谷", cargoType: "normal", products: [{ itemName: "鞋", packageCount: 4 }] },
  containerItems: [], statusLogs: shipmentLogs("s1"),
};
const trackChild: Row = { ...trackParent, id: "s1c", trackingNo: "YW0001-1", parentTrackingNo: "YW0001", statusLogs: shipmentLogs("s1c") };

/** 订单：paidBy 按 2026-06 老付款功能（提交 820af10）的写法填「管理员审核(名字)」 */
const orderRow: Row = {
  id: "o1", companyId: "c1", clientId: CLIENT.userId, warehouseId: "wh", receiverAddressTh: "曼谷", orderNo: "NO1", itemName: "鞋",
  transportMode: "sea", domesticTrackingNo: null, approvalStatus: "approved", productQuantity: null, packageCount: 4, packageUnit: "box",
  weightKg: 8, volumeM3: 0.4, receivableAmountCny: null, receivableCurrency: "CNY", paymentStatus: "paid", paidAt: T1,
  paidBy: `管理员审核(${ADMIN.name})`, shipDate: "2026-09-01", cargoType: "normal", batchNo: "ABCU1234567", createdAt: T0, updatedAt: T1,
  client: { name: "客户一" },
  shipments: [{ id: "s1", trackingNo: "YW0001", currentStatus: "loaded", remark: null, parentTrackingNo: null, createdAt: T0, updatedAt: T1, statusLogs: shipmentLogs("s1") }],
};

/** 普通版集货：管理员撤销付款（备注开头带「管理员」）+ 员工装柜（备注带柜号）；付款审核人是员工甲 */
const consolidationLogs: Row[] = [
  { id: "cl1", taskId: "t1", companyId: "c1", operatorId: ADMIN.userId, operatorRole: "admin", operatorName: ADMIN.name, fromStatus: "paid", toStatus: "quoted", remark: "管理员撤销付款，退回集货余额 ¥100.00", createdAt: T2 },
  { id: "cl2", taskId: "t1", companyId: "c1", operatorId: STAFF.userId, operatorRole: "staff", operatorName: STAFF.name, fromStatus: "paid", toStatus: "loading", remark: "柜号: ABCU1234567", createdAt: T1 },
];
const taskRow: Row = {
  id: "t1", taskNo: "JH0000001", companyId: "c1", clientId: CLIENT.userId, destinationTh: "曼谷", status: "loading",
  maxVolumeM3: 68, totalVolumeM3: 10, bookingFee: 100, customsFee: 100, loadingFee: 100, totalFee: 300, currency: "CNY",
  paymentStatus: "paid", paidAt: T1, paymentProofFileName: null, paymentProofMime: null, paymentProofBase64: null, paymentProofUploadedAt: null,
  paymentReviewedAt: T1, paymentReviewedBy: STAFF.userId, paymentRejectReason: null, containerNo: "ABCU1234567", loadingDate: null,
  createdAt: T0, updatedAt: T2,
  client: { id: CLIENT.userId, name: "客户一", phone: "0800000000" },
  prealerts: [{ id: "pa1", taskId: "t1", companyId: "c1", clientId: CLIENT.userId, trackingNo: "JH-YW0000001", expressNo: null, mark: "MARK1", status: "received", signedAt: null, receivedProofFileName: null, receivedProofMime: null, receivedProofBase64: null, createdAt: T0, updatedAt: T0, products: [] }],
  statusLogs: consolidationLogs,
};

/** 仓库版集货 */
const whrLogs: Row[] = [
  { id: "wl1", prealertId: "wp1", companyId: "c1", operatorId: ADMIN.userId, operatorRole: "admin", operatorName: ADMIN.name, fromStatus: "signed", toStatus: "signed", remark: "管理员把「鞋」的货型由普货改为敏感货", createdAt: T2 },
  { id: "wl2", prealertId: "wp1", companyId: "c1", operatorId: STAFF.userId, operatorRole: "staff", operatorName: STAFF.name, fromStatus: "pending", toStatus: "signed", remark: "仓库签收，1 方，系统自动计费 ¥100.00", createdAt: T1 },
];
const whrPrealert: Row = {
  id: "wp1", planCustomerId: "pc1", companyId: "c1", trackingNo: "WHR0001", expressNo: null, mark: "MARK1", status: "signed",
  receivedAt: null, signedAt: T1, warehouseReceiptProofs: [], totalFee: 100, paymentProofs: [], paymentProofUploadedAt: null,
  paymentReviewedAt: null, paymentReviewedBy: STAFF.userId, paymentRejectReason: null, thailandReceiptProofs: [], thailandReceivedAt: null,
  cancelReason: null, cancelledAt: null, createdAt: T0, updatedAt: T2, items: [], statusLogs: whrLogs,
};
const whrCustomer: Row = {
  id: "pc1", planId: "wplan1", companyId: "c1", clientId: CLIENT.userId, unitPriceNormal: 100, unitPriceInspection: 120, unitPriceSensitive: 150,
  totalVolumeM3: 1, totalFee: 100, deliveryAddress: "曼谷", totalPrealerts: 1, totalPackages: 1, createdAt: T0,
  client: { id: CLIENT.userId, name: "客户一", phone: "0800000000", companyName: "客户公司" }, prealerts: [whrPrealert],
};
const whrPlan: Row = {
  id: "wplan1", planNo: "PL0001", companyId: "c1", warehouse: "义乌", containerType: "40HQ", destinationTh: "曼谷", totalVolumeM3: 68,
  status: "collecting", createdBy: ADMIN.userId, creatorName: ADMIN.name, createdAt: T0, updatedAt: T1, _count: { customers: 1 }, customers: [whrCustomer],
};

const inboundPhoto: Row = { id: "ph1", companyId: "c1", shipmentId: "s1", operatorId: STAFF.userId, fileName: "a.jpg", mime: "image/jpeg", contentBase64: "AAAA", note: null, createdAt: T0 };
const fclRow: Row = {
  id: "f1", companyId: "c1", clientId: CLIENT.userId, productName: "鞋", cargoValue: "1000", cargoWeight: "500", address: "曼谷", containerType: "40HQ",
  serviceType: "清提派", loadingDate: null, certFileName: null, certFileBase64: null, productImages: null, status: "pending", remark: "内部备注",
  createdBy: STAFF.userId, createdByRole: "staff", createdAt: T0,
};
const ledgerRow: Row = {
  id: "led1", companyId: "c1", clientId: CLIENT.userId, type: "refund", amount: 100, balanceAfter: 100, refType: "normal", refId: "t1", refNo: "JH0000001",
  remark: "管理员删除集货任务 JH0000001，退回已付款项", operatorId: ADMIN.userId, operatorName: ADMIN.name, createdAt: T2,
};

(globalThis as any).__prisma = strict("prisma", {
  order: strict("order", {
    count: async () => 1,
    findMany: async (args) => shape([orderRow], args),
  }),
  orderProduct: strict("orderProduct", { findMany: async () => [] }),
  orderProductImage: strict("orderProductImage", { findMany: async () => [] }),
  shipment: strict("shipment", {
    findFirst: async (args) => shape(trackParent, args),
    findMany: async (args) => (args?.where?.parentTrackingNo ? shape([trackChild], args) : []),
  }),
  adminLastmileOrder: strict("adminLastmileOrder", { findFirst: async () => null }),
  consolidationTask: strict("consolidationTask", {
    findFirst: async (args) => shape(taskRow, args),
    findMany: async (args) => shape([taskRow], args),
  }),
  whrConsolidationPlan: strict("whrConsolidationPlan", {
    findFirst: async (args) => shape(whrPlan, args),
    findMany: async (args) => shape([whrPlan], args),
  }),
  whrConsolidationPlanCustomer: strict("whrConsolidationPlanCustomer", {
    findFirst: async (args) => shape(whrCustomer, args),
    groupBy: async () => [{ planId: "wplan1", _sum: { totalVolumeM3: { toNumber: () => 1 } } }],
  }),
  whrConsolidationPrealert: strict("whrConsolidationPrealert", {
    findFirst: async (args) => shape({ ...whrPrealert, planCustomer: whrCustomer }, args),
  }),
  staffInboundPhoto: strict("staffInboundPhoto", { findMany: async (args) => shape([inboundPhoto], args) }),
  fclInquiry: strict("fclInquiry", {
    count: async () => 1,
    findMany: async (args) => shape([fclRow], args),
    findFirst: async (args) => shape(fclRow, args ?? {}),
  }),
  consolidationBalanceLedger: strict("consolidationBalanceLedger", {
    count: async () => 1,
    findMany: async (args) => shape([ledgerRow], args),
  }),
});

/* ── 断言工具 ── */
function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) { for (const v of value) collectKeys(v, keys); return keys; }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) { keys.add(k); collectKeys(v, keys); }
  }
  return keys;
}
/** 员工 / 客户：返回里一个操作人字段都不许有，操作人的名字和账号也不许以任何形式出现 */
function assertNoOperator(label: string, wire: unknown): void {
  const keys = collectKeys(wire);
  const leakedKeys = OPERATOR_IDENTITY_FIELDS.filter((k) => keys.has(k));
  assert.deepEqual(leakedKeys, [], `${label}：返回里还带着操作人字段 ${leakedKeys.join(", ")}`);
  const text = JSON.stringify(wire);
  const leakedValues = IDENTITY_VALUES.filter((v) => text.includes(v));
  assert.deepEqual(leakedValues, [], `${label}：返回里还能看到操作人 ${leakedValues.join(", ")}`);
}
/** 管理员：照样看得到 */
function assertSeesOperator(label: string, wire: unknown, expected: string[]): void {
  const text = JSON.stringify(wire);
  for (const v of expected) assert.ok(text.includes(v), `${label}：超级管理员应该照样看到「${v}」`);
}

/** 把真前端 TS 源码转成 CJS 装进 vm（照 test-lastmile-product-names.ts） */
function loadWebModule(relative: string, globals: Record<string, unknown>): Record<string, any> {
  const context = vm.createContext({ console, ...globals });
  const cache = new Map<string, Record<string, any>>();
  function load(file: string): Record<string, any> {
    if (cache.has(file)) return cache.get(file)!;
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const mod = { exports: {} as Record<string, any> };
    cache.set(file, mod.exports);
    const req = (name: string) => {
      assert.ok(name.startsWith("."), `不该有外部依赖：${name}`);
      const base = path.resolve(path.dirname(file), name);
      const target = [base, `${base}.ts`, `${base}.tsx`].find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
      assert.ok(target, `找不到 ${name}`);
      return load(target!);
    };
    vm.runInContext(`(function(require,module,exports){${code}\n})`, context, { filename: file })(req, mod, mod.exports);
    return mod.exports;
  }
  return load(path.resolve(ROOT, relative));
}

/** 真轨迹弹窗组件渲染成 HTML（照 test-shipment-track-actions.ts 的 trackModule） */
function renderTrack(data: unknown): string {
  const filename = path.resolve(ROOT, "apps/web/src/modules/shipment/ShipmentTrackModal.tsx");
  const source = fs.readFileSync(filename, "utf8") + "\nexport { TrackContent };";
  const js = ts.transpileModule(source, { fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} as Record<string, any> };
  const react = webRequire("react");
  const core = {
    authHeaders: () => ({}), apiBaseUrl: () => "http://fixture.invalid", parseApiResponse: async () => ({}),
    fetchWithSession: async () => ({}), apiRequest: async () => { throw new Error("渲染时不该发请求"); },
  };
  vm.runInNewContext(js, {
    module: mod, exports: mod.exports, console, URLSearchParams,
    document: { getElementById: () => null, createElement: () => ({ remove() {} }), body: { appendChild() {} } },
    require: (id: string) => id === "react-dom/client"
      ? { createRoot: () => ({ render() {}, unmount() {} }) }
      : id.includes("core-api") ? core : id.startsWith(".") ? createRequire(filename)(id) : webRequire(id),
  }, { filename });
  return webRequire("react-dom/server").renderToStaticMarkup(react.createElement(mod.exports.TrackContent, { data }));
}

/* ── 客户签收单导出的数据（结构照 test-dispatch-wrap.ts） ── */
function receiptData(count: number): LastmileExportData {
  return {
    containerId: "", containerNo: "", containerType: "", origin: "义乌", destination: "曼谷", carrierInfo: "", deliveryNo: "WD000001", scope: "customer",
    carrierName: "自营", driverName: "司机张三", licensePlate: "กท-1234", phoneNumber: "0800000000", deliveryDate: "2026-09-15", status: "DELIVERING", customerCount: 1,
    shipmentCount: count, signedCount: 0, totalPackageCount: count * 2, totalVolumeM3: count * 0.1, totalWeightKg: count * 10, containerNos: [], generatedAt: "2026-09-15T00:00:00Z",
    customers: [{
      clientId: "MARK1", clientName: "客户一", contactName: "收件人", contactPhone: "0811111111", address: "曼谷某路 1 号", addressLabel: "曼谷",
      shipments: Array.from({ length: count }, (_, i) => ({
        lastmileOrderId: `lm${i}`, trackingNo: `YW${String(i + 1).padStart(4, "0")}`, parentTrackingNo: "", itemName: `货品${i + 1}`,
        packageCount: 2, packageUnit: "箱", volumeM3: 0.1, weightKg: 10, lengthCm: 60, widthCm: 40, heightCm: 30, remark: "", status: "DELIVERING", containerNos: [],
        receiverName: "收件人", receiverPhone: "0811111111", receiverAddress: "曼谷某路 1 号", products: [],
      })),
    }],
  } as LastmileExportData;
}
const RECEIPT_TEMPLATE = path.resolve(ROOT, "apps/web/public/templates/lastmile/customer-receipt-template.xlsx");
const RETURN_SENTENCE_BITS = ["微信/Line", "回传至湘泰货运", "请签收后回传", "กรุณาถ่ายรูปหรือสแกนส่งกลับ"];
function sharedTexts(sharedXml: string): string[] {
  return [...sharedXml.matchAll(/<(?:\w+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g)]
    .map((m) => [...(m[1] ?? "").matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((t) => t[1]).join(""));
}
function cellText(sheetXml: string, texts: string[], ref: string): string | null {
  const cell = new RegExp(`<(?:\\w+:)?c\\b[^>]*\\br="${ref}"[^>]*?(?:\\/>|>([\\s\\S]*?)<\\/(?:\\w+:)?c>)`).exec(sheetXml);
  if (!cell) return null;
  const v = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(cell[1] ?? "")?.[1];
  if (v === undefined) return "";
  return /\bt="s"/.test(cell[0]) ? texts[Number(v)] ?? "" : v;
}
function allSharedCellTexts(sheetXml: string, texts: string[]): string[] {
  return [...sheetXml.matchAll(/<(?:\w+:)?c\b([^>]*)>\s*<(?:\w+:)?v>(\d+)<\/(?:\w+:)?v>/g)]
    .filter((m) => /\bt="s"/.test(m[1]))
    .map((m) => texts[Number(m[2])] ?? "");
}

async function main(): Promise<void> {
  const routes = new Map<string, Handler>();
  const fakeApp: any = {};
  for (const m of ["get", "post", "put", "patch", "delete"]) fakeApp[m] = (p: string, h: Handler) => routes.set(`${m.toUpperCase()} ${p}`, h);
  fakeApp.listen = () => {};
  (await import("../apps/api/src/modules/orders/routes")).registerOrderRoutes(fakeApp);
  (await import("../apps/api/src/modules/shipments/routes")).registerShipmentRoutes(fakeApp);
  (await import("../apps/api/src/modules/containers/routes")).registerContainerRoutes(fakeApp);
  (await import("../apps/api/src/modules/consolidation/routes")).registerConsolidationRoutes(fakeApp);
  (await import("../apps/api/src/modules/whr-consolidation/routes")).registerWhrConsolidationRoutes(fakeApp);
  (await import("../apps/api/src/modules/whr-consolidation/staff-routes")).registerWhrConsolidationStaffRoutes(fakeApp);
  (await import("../apps/api/src/modules/whr-consolidation/client-routes")).registerWhrConsolidationClientRoutes(fakeApp);
  (await import("../apps/api/src/modules/fcl-inquiries/routes")).registerFclInquiryRoutes(fakeApp);
  (await import("../apps/api/src/modules/client-compliance/routes")).registerClientComplianceRoutes(fakeApp);

  /** 真调路由，返回「过了一遍 JSON 的」数据 —— 跟浏览器收到的一样（undefined 的键会消失） */
  async function call(key: string, auth: Row, query: Record<string, string> = {}): Promise<{ status: number; wire: any }> {
    const handler = routes.get(key);
    assert.ok(handler, `没注册到 ${key}`);
    let status = 200;
    let payload: unknown = null;
    const res: any = { requestId: "test", status(c: number) { status = c; return res; }, json(v: unknown) { payload = v; } };
    await handler!({ method: key.split(" ")[0], path: key.split(" ")[1], query, headers: {}, body: undefined, auth }, res);
    const wire = JSON.parse(JSON.stringify(payload));
    assert.equal(status, 200, `${key}（${auth.role}）应该 200，实际 ${status}：${JSON.stringify(wire).slice(0, 200)}`);
    return { status, wire: wire?.data };
  }

  console.log("R1 · 操作人身份只给超级管理员看");

  await check("0) 共用函数：非管理员整个删掉字段、不改原对象；管理员原样；备注只去开头的「管理员」", () => {
    const row = { id: "x", remark: "r", operatorId: "u", operatorName: "n", operatorRole: "staff", paymentReviewedBy: "u", paidBy: "p" };
    const snapshot = JSON.stringify(row);
    for (const role of ["staff", "client", undefined, "", "ADMIN"]) {
      const hidden = hideOperatorIdentity(row, role) as Row;
      assert.deepEqual(Object.keys(hidden).sort(), ["id", "remark"], `role=${String(role)} 应该只剩业务字段`);
    }
    assert.equal(JSON.stringify(row), snapshot, "不许改传进来的对象");
    assert.deepEqual(hideOperatorIdentity(row, "admin"), row);
    assert.equal(canSeeOperatorIdentity("admin"), true);
    assert.equal(canSeeOperatorIdentity("staff"), false);
    assert.equal(hideOperatorInRemark("管理员撤销付款，退回集货余额 ¥1.00", "staff"), "撤销付款，退回集货余额 ¥1.00");
    assert.equal(hideOperatorInRemark("管理员删除了货物「鞋」（2件）", "client"), "删除了货物「鞋」（2件）");
    assert.equal(hideOperatorInRemark("管理员撤销付款", "admin"), "管理员撤销付款", "管理员自己看原文");
    assert.equal(hideOperatorInRemark("请联系管理员确认", "client"), "请联系管理员确认", "句子中间的不碰（手填备注别误伤）");
    // 2026-09-15 复核补：手填备注开头恰好是「管理员」也不许动，只认代码拼的那 8 个模板
    assert.equal(hideOperatorInRemark("管理员已确认明天装", "staff"), "管理员已确认明天装", "手填备注开头的「管理员」被误删了");
    assert.equal(hideOperatorInRemark("管理员撤销付款：客户要求", "client"), "撤销付款：客户要求");
    assert.equal(hideOperatorInRemark("管理员把「鞋」的货型由普货改为敏感货", "staff"), "把「鞋」的货型由普货改为敏感货");
    assert.equal(hideOperatorInRemark("管理员删除集货计划 WHR0000001，退回已付款项", "client"), "删除集货计划 WHR0000001，退回已付款项");
    assert.equal(hideOperatorInRemark(null, "client"), null);
  });

  await check("0b) 全覆盖闸：schema.prisma 里每个「谁操作的」字段都在摘除名单里（以后加字段忘了补，这里当场红）", () => {
    const schema = fs.readFileSync(path.resolve(ROOT, "apps/api/prisma/schema.prisma"), "utf8");
    const found = new Set<string>();
    for (const m of schema.matchAll(/^\s+(\w+)\s+String\??\s/gm)) {
      const f = m[1];
      if (/By$/.test(f) || /^(operator|actor)[A-Z]/.test(f) || f === "creatorName" || f === "createdByRole" || f === "reviewerName") found.add(f);
    }
    assert.ok(found.size >= 10, `从 schema 里只认出 ${found.size} 个字段，正则可能写窄了`);
    const missing = [...found].filter((f) => !(OPERATOR_IDENTITY_FIELDS as readonly string[]).includes(f));
    assert.deepEqual(missing, [], `这些字段没进 core/operator-visibility.ts 的名单：${missing.join(", ")}`);
  });

  await check("1) 客户 GET /client/orders：物流记录不带操作人，paidBy（老数据里是「管理员审核(名字)」）也不带", async () => {
    const { wire } = await call("GET /client/orders", CLIENT);
    assert.equal(wire.items.length, 1);
    assert.equal(wire.items[0].logisticsRecords.length, 2, "物流记录本身要在");
    assertNoOperator("客户 /client/orders", wire);
  });

  await check("2) 客户 GET /client/prealerts：paidBy 不带", async () => {
    const { wire } = await call("GET /client/prealerts", CLIENT);
    assert.equal(wire.items.length, 1);
    assertNoOperator("客户 /client/prealerts", wire);
  });

  await check("3) GET /staff/prealerts：员工拿不到 paidBy，管理员照样拿到", async () => {
    assertNoOperator("员工 /staff/prealerts", (await call("GET /staff/prealerts", STAFF)).wire);
    const admin = (await call("GET /staff/prealerts", ADMIN)).wire;
    assert.equal(admin.items[0].paidBy, `管理员审核(${ADMIN.name})`);
  });

  await check("4) 轨迹 GET /client/shipments/track：客户、员工都拿不到操作人（父单合并轨迹 + 子单页签），管理员照样拿到；员工的删除能力不受影响", async () => {
    for (const auth of [CLIENT, STAFF]) {
      const { wire } = await call("GET /client/shipments/track", auth, { trackingNo: "YW0001" });
      assert.equal(wire.timeline.length, 4, "父单轨迹 = 自己 2 条 + 子单 2 条");
      assert.equal(wire.children[0].timeline.length, 2);
      assertNoOperator(`${auth.role} 轨迹`, wire);
    }
    const staff = (await call("GET /client/shipments/track", STAFF, { trackingNo: "YW0001" })).wire;
    // 员工删「写错的一条」要靠 id / canDelete / isCurrentStatus，不许跟操作人一起摘掉。
    // 夹具里两票都停在「已装柜」，各自唯一一条「已装柜」是当前状态那条，不给删（2026-09-17）
    assert.ok(staff.timeline.every((t: Row) => t.id), "员工删「写错的一条」要靠 id，不许一起摘掉");
    for (const t of staff.timeline as Row[]) {
      const isCurrent = String(t.id).endsWith("_l2");
      assert.equal(t.canDelete, !isCurrent, `${t.id} 的 canDelete 不对`);
      assert.equal(t.isCurrentStatus, isCurrent, `${t.id} 的 isCurrentStatus 不对`);
    }
    const admin = (await call("GET /client/shipments/track", ADMIN, { trackingNo: "YW0001" })).wire;
    assertSeesOperator("管理员轨迹", admin, [STAFF.name, ADMIN.name]);
    assert.equal(admin.timeline[0].operatorRole, "staff");
    assert.equal(admin.children[0].timeline[1].operatorName, ADMIN.name);
  });

  await check("5) 普通版集货 客户 GET /client/consolidation/tasks(+detail)：没有操作人、没有审核人；备注开头的「管理员」去掉，柜号照旧抹", async () => {
    assertNoOperator("客户集货列表", (await call("GET /client/consolidation/tasks", CLIENT)).wire);
    const { wire } = await call("GET /client/consolidation/tasks/detail", CLIENT, { taskId: "t1" });
    assertNoOperator("客户集货详情", wire);
    assert.deepEqual(wire.statusLogs.map((l: Row) => l.remark), ["撤销付款，退回集货余额 ¥100.00", "柜号（不对外显示）"]);
    assert.equal(wire.containerNo, undefined, "柜号字段照旧不给客户");
    assert.equal(wire.statusLogs[0].toStatus, "quoted", "状态记录本身要在");
  });

  await check("6) 普通版集货 GET /staff/consolidation/tasks(+detail)：员工拿不到，管理员（管理员端详情共用这个接口）照样拿到", async () => {
    assertNoOperator("员工集货列表", (await call("GET /staff/consolidation/tasks", STAFF)).wire);
    const staff = (await call("GET /staff/consolidation/tasks/detail", STAFF, { taskId: "t1" })).wire;
    assertNoOperator("员工集货详情", staff);
    assert.deepEqual(staff.statusLogs.map((l: Row) => l.remark), ["撤销付款，退回集货余额 ¥100.00", "柜号: ABCU1234567"], "员工照旧看得到柜号");
    const adminList = (await call("GET /staff/consolidation/tasks", ADMIN)).wire;
    assert.equal(adminList[0].paymentReviewedBy, STAFF.userId);
    const admin = (await call("GET /staff/consolidation/tasks/detail", ADMIN, { taskId: "t1" })).wire;
    assert.equal(admin.paymentReviewedBy, STAFF.userId);
    assert.deepEqual(admin.statusLogs.map((l: Row) => [l.operatorName, l.operatorRole, l.operatorId]), [[ADMIN.name, "admin", ADMIN.userId], [STAFF.name, "staff", STAFF.userId]]);
    assert.equal(admin.statusLogs[0].remark, "管理员撤销付款，退回集货余额 ¥100.00", "管理员看原文");
  });

  await check("7) 仓库版集货 客户 GET /client/whr-consolidation/my-detail：状态时间线没有操作人，备注开头的「管理员」去掉", async () => {
    const { wire } = await call("GET /client/whr-consolidation/my-detail", CLIENT, { planId: "wplan1" });
    assertNoOperator("客户仓库版详情", wire);
    assert.deepEqual(wire.statusLogs.map((l: Row) => l.remark), ["把「鞋」的货型由普货改为敏感货", "仓库签收，1 方，系统自动计费 ¥100.00"]);
  });

  await check("8) 仓库版集货 员工 GET /staff/whr-consolidation/prealert-detail：员工拿不到，管理员拿到", async () => {
    assertNoOperator("员工预报单详情", (await call("GET /staff/whr-consolidation/prealert-detail", STAFF, { prealertId: "wp1" })).wire);
    const admin = (await call("GET /staff/whr-consolidation/prealert-detail", ADMIN, { prealertId: "wp1" })).wire;
    assertSeesOperator("管理员预报单详情", admin, [STAFF.name, ADMIN.name]);
    assert.equal(admin.statusLogs[0].remark, "管理员把「鞋」的货型由普货改为敏感货");
  });

  await check("9) 仓库版集货 GET /admin/whr-consolidation/plans(+detail)（员工也能调）：员工拿不到创建人和日志操作人，管理员拿到", async () => {
    const staffList = (await call("GET /admin/whr-consolidation/plans", STAFF)).wire;
    assert.equal(staffList.items.length, 1);
    assertNoOperator("员工计划列表", staffList);
    assertNoOperator("员工计划详情", (await call("GET /admin/whr-consolidation/plans/detail", STAFF, { planId: "wplan1" })).wire);
    const adminList = (await call("GET /admin/whr-consolidation/plans", ADMIN)).wire;
    assert.deepEqual([adminList.items[0].createdBy, adminList.items[0].creatorName], [ADMIN.userId, ADMIN.name]);
    const adminDetail = (await call("GET /admin/whr-consolidation/plans/detail", ADMIN, { planId: "wplan1" })).wire;
    assert.equal(adminDetail.creatorName, ADMIN.name);
    assert.equal(adminDetail.customers[0].prealerts[0].statusLogs[1].operatorName, STAFF.name);
  });

  await check("10) 入库照片 GET /staff/inbound-photos：员工拿不到上传人账号，管理员拿到", async () => {
    const staff = (await call("GET /staff/inbound-photos", STAFF, { shipmentId: "s1" })).wire;
    assert.equal(staff.items.length, 1, "照片本身要在");
    assertNoOperator("员工入库照片", staff);
    assert.equal((await call("GET /staff/inbound-photos", ADMIN, { shipmentId: "s1" })).wire.items[0].operatorId, STAFF.userId);
  });

  await check("11) 整柜询价 GET /client/fcl-inquiries(+detail)：客户、员工拿不到提交人角色，管理员拿到", async () => {
    for (const auth of [CLIENT, STAFF]) {
      assertNoOperator(`${auth.role} 询价列表`, (await call("GET /client/fcl-inquiries", auth)).wire);
      assertNoOperator(`${auth.role} 询价详情`, (await call("GET /client/fcl-inquiries/detail", auth, { id: "f1" })).wire);
    }
    assert.equal((await call("GET /client/fcl-inquiries", ADMIN)).wire.items[0].createdByRole, "staff");
    assert.equal((await call("GET /client/fcl-inquiries/detail", ADMIN, { id: "f1" })).wire.createdByRole, "staff");
  });

  await check("12) 客户余额流水 GET /client/wallet/ledger：备注开头的「管理员」去掉，操作人不带", async () => {
    const { wire } = await call("GET /client/wallet/ledger", CLIENT);
    assertNoOperator("客户流水", wire);
    assert.equal(wire.items[0].remark, "删除集货任务 JH0000001，退回已付款项");
  });

  await check("13) 真轨迹弹窗：员工看不到操作人（哪怕接口里混进了名字），管理员照样看到", async () => {
    const staffWire = (await call("GET /client/shipments/track", STAFF, { trackingNo: "YW0001" })).wire;
    const staffHtml = renderTrack(staffWire);
    assert.ok(staffHtml.includes("状态变更记录"), "弹窗要真的渲染出轨迹");
    assert.ok(!IDENTITY_VALUES.some((v) => staffHtml.includes(v)), "员工的弹窗里出现了操作人");
    // 前端这道也要单独挡住：假设哪天后端又漏了，员工的弹窗照样不许画出来
    const leakyStaff = { ...staffWire, timeline: staffWire.timeline.map((t: Row) => ({ ...t, operatorRole: "staff", operatorName: STAFF.name })) };
    assert.ok(!renderTrack(leakyStaff).includes(STAFF.name), "接口混进了名字时，员工弹窗不许显示（前端只给管理员显示）");
    const adminHtml = renderTrack((await call("GET /client/shipments/track", ADMIN, { trackingNo: "YW0001" })).wire);
    assert.ok(adminHtml.includes(STAFF.name) && adminHtml.includes(ADMIN.name), "管理员的弹窗应该照样显示操作人");
  });

  await check("14) 页面：前端「只给管理员显示」的判断按登录角色走；员工页每处操作人都挂着这道判断；客户页不再读操作人", () => {
    const roleOf = (role: string | null) => {
      const stored = new Map<string, string>();
      if (role) stored.set("auth_session_v1", JSON.stringify({ userId: "u", companyId: "c1", role, token: "t" }));
      const localStorage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { stored.set(k, v); }, removeItem: (k: string) => { stored.delete(k); } };
      return loadWebModule("apps/web/src/auth/operator-visibility.ts", { window: { localStorage } }).viewerCanSeeOperator() as boolean;
    };
    assert.deepEqual([roleOf("admin"), roleOf("staff"), roleOf("client"), roleOf(null)], [true, false, false, false]);

    const staffPages = ["apps/web/src/app/staff/consolidation/page.tsx", "apps/web/src/app/staff/whr-consolidation/page.tsx", "apps/web/src/app/staff/page.tsx"];
    let guarded = 0;
    for (const rel of staffPages) {
      fs.readFileSync(path.resolve(ROOT, rel), "utf8").split("\n").forEach((line, i) => {
        if (!/\.(operatorName|creatorName|operatorId)\b/.test(line)) return;
        assert.ok(line.includes("viewerCanSeeOperator()"), `${rel}:${i + 1} 显示操作人没挂「只给管理员」的判断：${line.trim().slice(0, 120)}`);
        guarded += 1;
      });
    }
    assert.equal(guarded, 4, `员工页应该正好 4 处操作人显示（集货日志、计划详情创建人、计划列表创建人、入库照片操作员），实际 ${guarded}`);
    const whr = fs.readFileSync(path.resolve(ROOT, "apps/web/src/app/staff/whr-consolidation/page.tsx"), "utf8");
    assert.match(whr, /\.\.\.\(viewerCanSeeOperator\(\) \? \["创建人"\] : \[\]\)/, "「创建人」表头和数据格必须同一个条件（CLAUDE.md 第 10 条）");
    for (const rel of ["apps/web/src/app/client/consolidation/page.tsx", "apps/web/src/app/client/whr-consolidation/page.tsx"]) {
      assert.ok(!/operatorName|operatorRole/.test(fs.readFileSync(path.resolve(ROOT, rel), "utf8")), `${rel} 还在读操作人`);
    }
  });

  console.log("R2 · 打印标签去掉「湘泰物流网站」");

  await check("15) 标签 HTML（多产品 / 单产品两条路）：没有「湘泰物流网站」和 footer，唛头/运输方式/品名/箱号/单箱数量/运单号都在", () => {
    const render = (props: Row): string => {
      let html = "";
      const win = { document: { write: (s: string) => { html += s; }, close() {} } };
      loadWebModule("apps/web/src/modules/shipment/ShipmentPrintLabel.tsx", { window: { open: () => win } }).openPrintLabel(props);
      return html;
    };
    const multi = render({ marks: "MARK1", packageCount: 3, trackingNo: "YW0001", transportMode: "sea", products: [{ itemName: "鞋", packageCount: 2 }, { itemName: "包", packageCount: 1 }] });
    const single = render({ marks: "MARK2", packageCount: 2, trackingNo: "YW0002", transportMode: "land", itemName: "帽", productQuantity: 12 });
    for (const [label, html, boxes] of [["多产品", multi, 3], ["单产品", single, 2]] as const) {
      assert.ok(!html.includes("湘泰物流网站"), `${label}标签还印着「湘泰物流网站」`);
      assert.ok(!/footer/.test(html), `${label}标签还留着 footer`);
      assert.equal((html.match(/class="label"/g) ?? []).length, boxes, `${label}标签张数不对`);
    }
    for (const bit of ["MARK1", "海运", "鞋", "包", "箱号：1/3", "箱号：3/3", "YW0001"]) assert.ok(multi.includes(bit), `多产品标签少了「${bit}」`);
    for (const bit of ["MARK2", "陆运", "帽", "箱号：2/2", "单箱数量：12个", "YW0002"]) assert.ok(single.includes(bit), `单产品标签少了「${bit}」`);
  });

  console.log("R3 · 客户派送签收单去掉「请签收后拍照/扫描回传…微信/Line」");

  await check("16) 真模板生成（12 票 → 中文/泰文各 2 页）：共享字符串和每一页都没有那句；「⚠️ 签字即代表…」、合计公式、行高、合并区域照旧", async () => {
    const templateBytes = fs.readFileSync(RECEIPT_TEMPLATE);
    const templateZip = await JSZip.loadAsync(templateBytes);
    const templateTexts = sharedTexts(await templateZip.file("xl/sharedStrings.xml")!.async("string"));
    // 自证：模板里真有这两句（第 41 / 82 条），不然下面「没有」等于没测
    assert.ok(RETURN_SENTENCE_BITS.slice(0, 2).every((b) => templateTexts[41]?.includes(b)), `模板第 41 条变了：${templateTexts[41]}`);
    assert.ok(templateTexts[82]?.includes("微信/Line") && templateTexts[82]?.includes("กรุณาถ่ายรูปหรือสแกนส่งกลับ"), `模板第 82 条变了：${templateTexts[82]}`);

    const out = await JSZip.loadAsync(await buildLastmileTemplateWorkbook(receiptData(12), templateBytes));
    const texts = sharedTexts(await out.file("xl/sharedStrings.xml")!.async("string"));
    const leakedShared = texts.map((t, i) => [i, t] as const).filter(([, t]) => RETURN_SENTENCE_BITS.some((b) => t.includes(b)));
    assert.deepEqual(leakedShared, [], "共享字符串里还有那句");
    assert.ok(texts.length >= templateTexts.length, "共享字符串条数变少了（删 <si> 会让后面编号整体错位）");
    assert.equal(texts[40], templateTexts[40], "第 40 条（签字即代表…）编号错位了");

    const sheetFiles = Object.keys(out.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort();
    assert.equal(sheetFiles.length, 4, `12 票应该是中文 2 页 + 泰文 2 页，实际 ${sheetFiles.join(", ")}`);
    for (const file of sheetFiles) {
      const xml = await out.file(file)!.async("string");
      assert.ok(!RETURN_SENTENCE_BITS.some((b) => xml.includes(b)), `${file} 里直接写着那句`);
      const leaked = allSharedCellTexts(xml, texts).filter((t) => RETURN_SENTENCE_BITS.some((b) => t.includes(b)));
      assert.deepEqual(leaked, [], `${file} 还有格子引用着那句`);
    }

    const cn = await out.file("xl/worksheets/sheet1.xml")!.async("string");
    const th = await out.file("xl/worksheets/sheet2.xml")!.async("string");
    const cnTemplate = await templateZip.file("xl/worksheets/sheet1.xml")!.async("string");
    const thTemplate = await templateZip.file("xl/worksheets/sheet2.xml")!.async("string");
    assert.ok(cellText(cn, texts, "A53")?.startsWith("⚠️ 签字即代表已阅读并同意以上全部条款"), `中文页 A53 被误删：${cellText(cn, texts, "A53")}`);
    assert.ok(cellText(th, texts, "A62")?.startsWith("⚠️ การลงนามหมายถึงยอมรับ"), `泰文页 A62 被误删：${cellText(th, texts, "A62")}`);
    assert.equal(cellText(cn, texts, "A55"), null, "中文页 A55 那一格应该整格去掉（留着会有一条空黄底）");
    assert.equal(cellText(th, texts, "A64"), null, "泰文页 A64 那一格应该整格去掉");
    assert.match(cn, /<(?:\w+:)?f>SUM\(E6:E15\)<\/(?:\w+:)?f>/, "中文页件数合计公式没了");
    assert.match(th, /<(?:\w+:)?f>SUM\(E8:E27\)<\/(?:\w+:)?f>/, "泰文页件数合计公式没了");
    const rowTag = (xml: string, r: number) => new RegExp(`<(?:\\w+:)?row\\b[^>]*\\br="${r}"[^>]*>`).exec(xml)?.[0];
    assert.equal(rowTag(cn, 55), rowTag(cnTemplate, 55), "中文页第 55 行的行高被动了");
    assert.equal(rowTag(th, 64), rowTag(thTemplate, 64), "泰文页第 64 行的行高被动了");
    const merges = (xml: string) => /<(?:\w+:)?mergeCells\b[\s\S]*?<\/(?:\w+:)?mergeCells>/.exec(xml)?.[0];
    assert.equal(merges(cn), merges(cnTemplate), "中文页合并区域被动了");
    assert.equal(merges(th), merges(thTemplate), "泰文页合并区域被动了");
    assert.equal(await out.file("xl/styles.xml")!.async("string"), await templateZip.file("xl/styles.xml")!.async("string"), "样式表被动了");
  });

  await check("17) 模板里写死的公司名「新泓瀚」导出时换成「我司」（2026-09-15 老板：代理的客户也会拿到这张单）", async () => {
    const templateBytes = fs.readFileSync(RECEIPT_TEMPLATE);
    const templateZip = await JSZip.loadAsync(templateBytes);
    const templateTexts = sharedTexts(await templateZip.file("xl/sharedStrings.xml")!.async("string"));
    // 自证：模板第 42 条（泰文页标题）确实写着新泓瀚，不然下面「没有」等于没测
    assert.ok(templateTexts[42]?.startsWith("新泓瀚 ขนส่ง"), `模板第 42 条变了：${templateTexts[42]}`);
    const out = await JSZip.loadAsync(await buildLastmileTemplateWorkbook(receiptData(12), templateBytes));
    const texts = sharedTexts(await out.file("xl/sharedStrings.xml")!.async("string"));
    let all = "";
    for (const name of Object.keys(out.files)) if (name.endsWith(".xml")) all += await out.file(name)!.async("string");
    assert.ok(!all.includes("新泓瀚"), "导出的文件里还有「新泓瀚」");
    assert.ok(texts.length >= templateTexts.length, "共享字符串条数变少了");
    const th = await out.file("xl/worksheets/sheet2.xml")!.async("string");
    const cn = await out.file("xl/worksheets/sheet1.xml")!.async("string");
    assert.equal(cellText(th, texts, "A1"), templateTexts[42].replace("新泓瀚", "我司"), `泰文页标题不对：${cellText(th, texts, "A1")}`);
    assert.equal(cellText(cn, texts, "A1"), templateTexts[0], "中文页标题不该动");
    // 续页的标题也不许再出现新泓瀚
    const sheetFiles = Object.keys(out.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
    for (const file of sheetFiles) {
      const title = cellText(await out.file(file)!.async("string"), texts, "A1");
      if (title) assert.ok(!title.includes("新泓瀚"), `${file} 标题还是新泓瀚：${title}`);
    }
  });

  console.log(`\n共 ${total} 项，失败 ${failures.length} 项`);
  if (failures.length > 0) {
    console.log("失败：\n  - " + failures.join("\n  - "));
    process.exit(1);
  }
  console.log("✅ 全部通过");
  // 路由模块 import 时会挂清理定时器（rate-limit / token-blacklist），不主动退出进程就不结束
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
