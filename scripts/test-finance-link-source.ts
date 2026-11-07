/**
 * 对接海外仓财务系统：不连库的部分（2026-11-04）。
 *
 * 配置门槛、状态中文跟客户端逐条一致、字段逐个裁、账号核对的先后、一次性码跟密码绑定、授权页地址，
 * 以及接线：只有那几条精确路径不跑登录解析、拆派仓那组没动、代理端四个函数只加 export、
 * 三个环境变量不进前端、迁移只加不删、日志里没有密码 / 授权 / 一次性码、授权页不碰登录状态。
 * 连库的整套流程在 test-finance-link-db.ts。
 * 用法：npm run test:finance-link-source
 */
process.env.AUTH_SECRET ||= "test-only-fake-secret-not-a-real-key-do-not-use-in-production";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  authorizeUrlOf,
  canAuthorize,
  codeHashOf,
  linkProblem,
  newAuthorizationId,
  newOpaqueValue,
  sha256Hex,
  shouldTouchLastUsed,
} from "../apps/api/src/modules/finance-link/authorization";
import { passwordFingerprint } from "../apps/api/src/modules/auth/token";
import { RESERVED_AGENT_SLUGS } from "../apps/api/src/modules/agents/agent-rules";
import { INTEGRATION_PATHS } from "../apps/api/src/modules/chaipai/paths";
import { readFinanceLinkConfig } from "../apps/api/src/modules/finance-link/config";
import { AUTHORIZE_INFO_PATH, AUTHORIZE_SUBMIT_PATH, FINANCE_LINK_PATHS } from "../apps/api/src/modules/finance-link/paths";
import { WAYBILL_STATUS_ZH, waybillStatusZh } from "../apps/api/src/modules/finance-link/status-zh";
import { ORDER_MONTH_INVALID, orderMonthRange, parseOrderMonth } from "../apps/api/src/modules/finance-link/order-month";
import { cargoTypeOrNull, declaredVolumeM3, mapTrackChild, mapTrackLog, mapWaybillRow, maskHandwrittenContainerNos } from "../apps/api/src/modules/finance-link/views";
import { CLIENT_STATUS_ZH_OVERRIDES, SHIPMENT_STATUS_ZH, shipmentStatusZh } from "../apps/web/src/modules/shipment/shipment-status";

const ROOT = path.join(__dirname, "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (e) { failed++; console.log(`❌ ${name}\n   ${e instanceof Error ? e.message.split("\n").slice(0, 6).join("\n   ") : String(e)}`); }
}

const SECRET = "Fin4nceLink-aB3dE5gH7jK9mN1pQ3sT5vX";
const RETURN_URL = "https://finance.example.com/logistics-waybills/callback";

/* ─────────────── 配置 ─────────────── */

check("C1 总开关默认关，只认字符串 true", () => {
  assert.equal(readFinanceLinkConfig({} as NodeJS.ProcessEnv).ok, false);
  for (const v of ["1", "TRUE", "yes", " true", ""]) {
    assert.equal(readFinanceLinkConfig({ FINANCE_LINK_ENABLED: v, FINANCE_LINK_SECRET: SECRET, FINANCE_LINK_RETURN_URL: RETURN_URL } as unknown as NodeJS.ProcessEnv).ok, false, v);
  }
  const good = readFinanceLinkConfig({ FINANCE_LINK_ENABLED: "true", FINANCE_LINK_SECRET: SECRET, FINANCE_LINK_RETURN_URL: RETURN_URL, NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv);
  assert.deepEqual(good, { ok: true, cfg: { secret: SECRET, returnUrl: RETURN_URL } });
});

check("C2 密钥不合格按关闭处理（短、占位词、带空白、重复字符），不抛异常", () => {
  for (const bad of [undefined, "short", "x".repeat(40), `change-me-${"a1b2c3d4".repeat(5)}`, `${SECRET} `, `a b${SECRET}`]) {
    const r = readFinanceLinkConfig({ FINANCE_LINK_ENABLED: "true", FINANCE_LINK_SECRET: bad, FINANCE_LINK_RETURN_URL: RETURN_URL } as unknown as NodeJS.ProcessEnv);
    assert.equal(r.ok, false, String(bad));
  }
});

check("C3 跳回地址：生产只认 https；不许带 ? # 用户名密码 反斜杠 空白；开发只多放行本机 http", () => {
  const cfg = (url: string | undefined, nodeEnv?: string) =>
    readFinanceLinkConfig({ FINANCE_LINK_ENABLED: "true", FINANCE_LINK_SECRET: SECRET, FINANCE_LINK_RETURN_URL: url, NODE_ENV: nodeEnv } as unknown as NodeJS.ProcessEnv).ok;
  assert.equal(cfg(RETURN_URL, "production"), true);
  for (const bad of ["http://finance.example.com/cb", "http://127.0.0.1:3000/cb", "ftp://x.com/cb", "https://x.com/cb?a=1", "https://x.com/cb#f", "https://u:p@x.com/cb", "https://x.com\\@evil.com/cb", " https://x.com/cb", "not a url", undefined]) {
    assert.equal(cfg(bad, "production"), false, String(bad));
  }
  assert.equal(cfg("http://127.0.0.1:3000/cb"), true);
  assert.equal(cfg("http://localhost:3000/cb"), true);
  assert.equal(cfg("http://evil.com/cb"), false);
  assert.equal(cfg("http://127.0.0.1.evil.com/cb"), false);
});

/* ─────────────── 状态中文 ─────────────── */

check("Z1 状态中文跟物流客户端逐条一致（网页那份改了这边没跟就红）", () => {
  // 两边的键都走一遍：这边多抄一个、抄错一个都红
  const keys = new Set([...Object.keys(SHIPMENT_STATUS_ZH), ...Object.keys(WAYBILL_STATUS_ZH), ...Object.keys(CLIENT_STATUS_ZH_OVERRIDES), "inWarehouseTH", "outForDelivery", "customsTH", "delivered"]);
  assert.ok(keys.size > 50, "网页那份没读到");
  for (const k of keys) assert.equal(waybillStatusZh(k), shipmentStatusZh(k, CLIENT_STATUS_ZH_OVERRIDES), k);
  assert.equal(waybillStatusZh("delivered"), "已签收", "客户端叫已签收");
  for (const k of [null, undefined, "", "  "]) assert.equal(waybillStatusZh(k), shipmentStatusZh(k, CLIENT_STATUS_ZH_OVERRIDES), String(k));
});

check("Z2 查不到的状态写「未知状态」，不把英文吐出去", () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(waybillStatusZh("someNewStatus"), "未知状态");
    assert.equal(shipmentStatusZh("someNewStatus", CLIENT_STATUS_ZH_OVERRIDES), "未知状态");
  } finally { console.warn = warn; }
});

/* ─────────────── 裁字段 ─────────────── */

const FULL_ROW = {
  // 这些是要给的
  trackingNo: "YW1", clientId: "C01", clientName: "客户名", productNames: "鞋", packageCount: 3, packageUnit: "箱",
  weightKg: 12.5, volumeM3: 0.42, totalWeightKg: 12.5, totalVolumeM3: 0.42, transportMode: "sea", domesticTrackingNo: "SF1",
  currentStatus: "inWarehouseTH", partialAhead: "delivered", statusGroup: "arrived", updatedAt: "2026-11-03T08:00:00.000Z",
  // 这些是 loadShipmentRows 行里有、绝不能带出去的
  id: "order-id", orderNo: "ORD1", shipmentId: "ship-id", approvalStatus: "approved", itemName: "x", productQuantity: 1,
  lengthCm: "1", widthCm: "1", heightCm: "1", cargoType: "normal", shipDate: "2026-10-01", createdAt: "2026-10-01T03:15:00.000Z",
  receiverNameTh: "收件人", receiverPhoneTh: "0899", receiverAddressTh: "地址",
  products: [{ itemName: "x", domesticTrackingNo: "SF1", productQuantity: 1, lengthCm: 50, widthCm: 40, heightCm: 30, packageCount: 2, weightKg: 9, cargoType: "normal" }],
  // 将来谁给那一行加了这些，也带不出去
  batchNo: "MEDU1234567", containerNo: "MEDU1234567", receivableAmountCny: 8765.43, operatorName: "员工", remark: "内部备注",
};
/** 2026-11-04 第 1 轮就有的字段：名字和值一个都不许变（老版本的财务系统只认这些） */
const WAYBILL_KEYS = ["trackingNo", "clientId", "productNames", "packageCount", "packageUnit", "weightKg", "volumeM3", "totalWeightKg", "totalVolumeM3",
  "transportMode", "domesticTrackingNo", "currentStatus", "statusZh", "partialAhead", "statusGroup", "updatedAt"];
/** 2026-11-07 代理利润第 1 轮多给的，只有这四个 */
const PROFIT_KEYS = ["orderedAt", "cargoType", "estimated", "products"];
/** FULL_ROW 在改之前（eb5705d）mapWaybillRow 出来的老字段，一个字不差 */
const OLD_VALUES = {
  trackingNo: "YW1", clientId: "C01", productNames: "鞋", packageCount: 3, packageUnit: "箱", weightKg: 12.5, volumeM3: 0.42, totalWeightKg: 12.5,
  totalVolumeM3: 0.42, transportMode: "sea", domesticTrackingNo: "SF1", currentStatus: "inWarehouseTH", statusZh: "已到仓", partialAhead: "delivered",
  statusGroup: "arrived", updatedAt: "2026-11-03T08:00:00.000Z",
};

check("V1 运单一行只出修改清单 5.4 那些字段 + 代理利润那四个：普通客户没有 clientName，代理才有", () => {
  const asClient = mapWaybillRow(FULL_ROW, false);
  assert.deepEqual(Object.keys(asClient).sort(), [...WAYBILL_KEYS, ...PROFIT_KEYS].sort());
  const asAgent = mapWaybillRow(FULL_ROW, true);
  assert.deepEqual(Object.keys(asAgent).sort(), [...WAYBILL_KEYS, ...PROFIT_KEYS, "clientName"].sort());
  assert.equal(asAgent.clientName, "C01", "值是唛头，不是客户名字");
  assert.ok(!JSON.stringify(asAgent).includes("客户名"), "客户名字不许带出去");
  assert.equal(asAgent.statusZh, "已到仓");
  assert.equal(mapWaybillRow({ ...FULL_ROW, partialAhead: undefined }, false).partialAhead, null);
});

check("V1b 国内单号跟代理端列表同一个口径：一票多款把产品行的号都带上，不丢", () => {
  const row = (products: Array<{ domesticTrackingNo?: string | null }>, top: string | null) => ({ ...FULL_ROW, products, domesticTrackingNo: top });
  assert.equal(mapWaybillRow(row([{ domesticTrackingNo: "SF1" }, { domesticTrackingNo: "SF2" }], null), false).domesticTrackingNo, "SF1、SF2");
  assert.equal(mapWaybillRow(row([{ domesticTrackingNo: "SF1" }], "SF9"), false).domesticTrackingNo, "SF1、SF9", "整票另有真单号也带上");
  assert.equal(mapWaybillRow(row([], "SF9"), false).domesticTrackingNo, "SF9", "没有产品行的老单用整票的号");
  assert.equal(mapWaybillRow(row([], null), false).domesticTrackingNo, null);
  assert.equal(mapWaybillRow(row([{ domesticTrackingNo: null }], null), false).domesticTrackingNo, "货拉拉", "产品行没填号的占位，跟代理端列表一样");
});

/* ─────────────── 代理利润第 1 轮（2026-11-07）：多给的四个字段 ─────────────── */

check("V4 老字段一个不少、值不变；新的只有四个：orderedAt 原样是下单时间、整票货型、estimated、products", () => {
  for (const isAgent of [false, true]) {
    const item = mapWaybillRow(FULL_ROW, isAgent) as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(OLD_VALUES)) assert.deepEqual(item[k], v, k);
    const added = Object.keys(item).filter((k) => !(k in OLD_VALUES) && k !== "clientName");
    assert.deepEqual(added.sort(), [...PROFIT_KEYS].sort());
  }
  const item = mapWaybillRow(FULL_ROW, false);
  assert.equal(item.orderedAt, "2026-10-01T03:15:00.000Z");
  assert.equal(item.cargoType, "normal");
  assert.deepEqual(item.products, [{ cargoType: "normal", declaredVolumeM3: 0.12 }]);
  const text = JSON.stringify(mapWaybillRow(FULL_ROW, true));
  for (const word of ["MEDU1234567", "8765.43", "收件人", "0899", "内部备注", "order-id", "ship-id", "ORD1", "客户名", "itemName", "weightKg\":9", "approvalStatus"]) {
    assert.ok(!text.includes(word), `带出去了 ${word}`);
  }
});

check("V5 estimated 只在客户预报、还没确认收货（approvalStatus = shipped）时是 true", () => {
  const est = (approvalStatus: string) => mapWaybillRow({ ...FULL_ROW, approvalStatus }, false).estimated;
  assert.equal(est("shipped"), true);
  for (const s of ["received", "approved", "pending", "rejected", "", "Shipped"]) assert.equal(est(s), false, s);
});

check("V6 products 每项只有 cargoType、declaredVolumeM3 两个键，顺序照来的（已按 sortOrder 排）；没有产品行给空数组", () => {
  const products = [
    { domesticTrackingNo: "SF1", itemName: "衣服", weightKg: 5, lengthCm: 100, widthCm: 100, heightCm: 100, packageCount: 1, cargoType: "normal" },
    { domesticTrackingNo: "SF2", itemName: "电池", weightKg: 6, lengthCm: 100, widthCm: 100, heightCm: 100, packageCount: 1, cargoType: "sensitive" },
  ];
  const item = mapWaybillRow({ ...FULL_ROW, products }, true);
  assert.deepEqual(item.products, [{ cargoType: "normal", declaredVolumeM3: 1 }, { cargoType: "sensitive", declaredVolumeM3: 1 }]);
  for (const p of item.products) assert.deepEqual(Object.keys(p).sort(), ["cargoType", "declaredVolumeM3"]);
  assert.deepEqual(mapWaybillRow({ ...FULL_ROW, products: [] }, false).products, []);
});

check("V7 货型只认 normal / inspection / sensitive / special；认不出来（含中文、大小写、带空格、空）给 null，绝不当普货", () => {
  for (const v of ["normal", "inspection", "sensitive", "special"]) assert.equal(cargoTypeOrNull(v), v);
  for (const v of ["frozen", "普货", "Normal", " normal", "SPECIAL", "", null, undefined]) assert.equal(cargoTypeOrNull(v), null, String(v));
  assert.equal(mapWaybillRow({ ...FULL_ROW, cargoType: "frozen" }, false).cargoType, null, "整票");
  assert.equal(mapWaybillRow({ ...FULL_ROW, cargoType: null }, false).cargoType, null, "整票没值");
  assert.deepEqual(mapWaybillRow({ ...FULL_ROW, products: [{ ...FULL_ROW.products[0], cargoType: "frozen" }] }, false).products, [{ cargoType: null, declaredVolumeM3: 0.12 }], "产品行");
});

check("V8 产品行方数 = 长×宽×高×件数÷1,000,000，保留 6 位；缺一个尺寸、件数，或不大于 0 都给 null，不当 0", () => {
  const vol = (l: unknown, w: unknown, h: unknown, pkg: unknown) =>
    declaredVolumeM3({ lengthCm: l as number, widthCm: w as number, heightCm: h as number, packageCount: pkg as number });
  assert.equal(vol(100, 100, 100, 1), 1);
  assert.equal(vol(50, 40, 30, 2), 0.12);
  assert.equal(vol(33.3, 33.3, 33.3, 3), 0.110778, "36926.037 立方厘米 × 3，舍到 6 位");
  assert.equal(vol(0.5, 0.5, 0.5, 1), 0, "不到半立方厘米舍成 0（尺寸都是正数，算出来就是这么小）");
  assert.equal(vol(120, 100, 100, 1), 1.2);
  for (const [l, w, h, pkg] of [[null, 40, 30, 1], [50, undefined, 30, 1], [50, 40, null, 1], [50, 40, 30, null], [0, 40, 30, 1], [50, 40, 30, 0], [-50, 40, 30, 1], [50, 40, 30, -1], [Number.NaN, 40, 30, 1], [Number.POSITIVE_INFINITY, 40, 30, 1], ["50", 40, 30, 1]]) {
    assert.equal(vol(l, w, h, pkg), null, JSON.stringify([l, w, h, pkg]));
  }
  // 正好半立方厘米的要进位：浮点直接乘会乘成 .4999…（11-07 Codex 审查抓到的）
  assert.equal(vol(10, 10.5, 16.9, 1), 0.001775, "1774.5 立方厘米");
  assert.equal(vol(10, 1.5, 4.1, 1), 0.000062, "61.5 立方厘米");
  assert.equal(vol(10, 1.5, 33.3, 1), 0.0005, "499.5 立方厘米");
  assert.equal(vol(10, 1.5, 33.3, 3), 0.001499, "1498.5 立方厘米");
  // 跟「尺寸都乘 100 变整数再算」的精确值逐个比（两位小数以内的尺寸），一个都不许差；同时小数最多 6 位、不带浮点尾巴
  const exact = (l: number, w: number, h: number, pkg: number) => {
    const n = BigInt(Math.round(l * 100)) * BigInt(Math.round(w * 100)) * BigInt(Math.round(h * 100)) * BigInt(pkg); // 立方厘米 × 1,000,000
    const cm3 = (n + 500_000n) / 1_000_000n;
    return Number(`${cm3 / 1_000_000n}.${(cm3 % 1_000_000n).toString().padStart(6, "0")}`);
  };
  // 大到超过 2^53 立方厘米也不许差最后一位（第 2 轮审查）；科学计数法写法的数（String 出来带 e）照样算对
  assert.equal(vol(21001, 21401, 21523, 941), 9102621217.716343);
  assert.equal(vol(1e-7, 1e7, 1, 1), 0.000001, "1e-7 × 1e7 = 1 立方厘米");
  assert.equal(vol(1e21, 1e-21, 1, 1), 0.000001, "1e21 × 1e-21 = 1 立方厘米");
  assert.equal(vol(2.5e-7, 2, 1, 1), 0, "0.0000005 立方厘米舍成 0");
  const cases: Array<[number, number, number, number]> = [[33.3, 33.3, 33.3, 3], [12.7, 9.9, 3.3, 7], [0.1, 0.2, 0.3, 1], [99.99, 88.88, 77.77, 11], [10, 10.5, 16.9, 1], [10, 1.5, 65.1, 4], [45.5, 12.5, 7.3, 2], [0.01, 0.01, 0.01, 1], [1200, 800, 600.5, 9]];
  for (let a = 1; a <= 120; a++) for (const b of [1.5, 10.5, 12.25, 33.3]) cases.push([10, b, a / 10, 1 + (a % 5)]);
  for (const [l, w, h, pkg] of cases) {
    const v = vol(l, w, h, pkg)!;
    assert.ok(/^\d+(\.\d{1,6})?$/.test(String(v)), `${String(v)} 不是最多 6 位小数`);
    assert.equal(v, exact(l, w, h, pkg), JSON.stringify([l, w, h, pkg]));
  }
});

check("V9 下单月份：只认 YYYY-MM（2020～2100、01～12）；没传 / 空串不筛；别的写法一律格式不对", () => {
  const iso = (r: ReturnType<typeof parseOrderMonth>) => (r ? [r.from.toISOString(), r.to.toISOString()] : r);
  assert.deepEqual(iso(parseOrderMonth("2026-11")), ["2026-10-31T17:00:00.000Z", "2026-11-30T17:00:00.000Z"]);
  assert.deepEqual(iso(parseOrderMonth("2026-12")), ["2026-11-30T17:00:00.000Z", "2026-12-31T17:00:00.000Z"], "12 月跨年");
  assert.deepEqual(iso(parseOrderMonth("2027-01")), ["2026-12-31T17:00:00.000Z", "2027-01-31T17:00:00.000Z"]);
  assert.deepEqual(iso(parseOrderMonth("2024-02")), ["2024-01-31T17:00:00.000Z", "2024-02-29T17:00:00.000Z"], "闰年 2 月");
  assert.deepEqual(iso(parseOrderMonth("2020-01")), ["2019-12-31T17:00:00.000Z", "2020-01-31T17:00:00.000Z"]);
  assert.deepEqual(iso(parseOrderMonth("2100-12")), ["2100-11-30T17:00:00.000Z", "2100-12-31T17:00:00.000Z"]);
  assert.deepEqual(iso(orderMonthRange(2026, 11)), iso(parseOrderMonth("2026-11")));
  assert.equal(parseOrderMonth(undefined), undefined);
  assert.equal(parseOrderMonth(""), undefined);
  for (const bad of ["2026-99-99", "2026-13", "2026-1", "26-11", "abc", "2026-00", "2019-12", "2101-01", "2026-11-01", " 2026-11", "2026-11 ", "2026-11\n",
    "2026/11", "202611", "２０２６-１１", "2026-1１", "+2026-11", "-2026-11", " ", 202611, ["2026-11"], null, {}]) {
    assert.equal(parseOrderMonth(bad), null, JSON.stringify(bad));
  }
  assert.equal(ORDER_MONTH_INVALID, "下单月份格式不对，请写成 2026-11 这种格式");
});

check("V10 接线：月份在 listScopedOrderIds 之后按订单 createdAt 再筛一遍；total 和分页用筛完的；不碰 dateFrom / dateTo；order-month.ts 不碰数据库", () => {
  const routes = read("apps/api/src/modules/finance-link/routes.ts");
  const handler = routes.slice(routes.indexOf("app.get(WAYBILLS_PATH"), routes.indexOf("app.get(WAYBILL_TRACK_PATH"));
  assert.match(handler, /parseOrderMonth\(req\.query\.orderMonth\)/);
  assert.match(handler, /if \(orderMonth === null\) \{ fail\(res, 400, "BAD_REQUEST", ORDER_MONTH_INVALID\); return; \}/);
  assert.match(handler, /const scopedIds = await listScopedOrderIds\(scope\.auth, scope\.clientIds, filters\);/);
  assert.match(handler, /const allIds = orderMonth \? await keepOrderMonth\(link\.companyId, scopedIds, orderMonth\) : scopedIds;/);
  assert.match(handler, /total: allIds\.length/);
  assert.match(handler, /allIds\.slice\(\(page - 1\) \* pageSize, page \* pageSize\)/);
  assert.ok(!/dateFrom|dateTo/.test(handler.replace(/\/\/.*$/gm, "")), "不许把代理端的到仓日期筛选接进来");
  const keep = routes.slice(routes.indexOf("async function keepOrderMonth"), routes.indexOf("const TRACK_LOG_SELECT"));
  assert.match(routes, /const MONTH_FILTER_CHUNK = 5000;/);
  assert.match(keep, /chunk = MONTH_FILTER_CHUNK\)/, "接口里每批默认 5000");
  assert.match(keep, /if \(!Number\.isSafeInteger\(chunk\) \|\| chunk < 1\) throw/, "每批个数不是正整数直接报错，不许死循环");
  assert.match(keep, /createdAt: \{ gte: range\.from, lt: range\.to \}/);
  assert.match(keep, /where: \{ id: \{ in: orderIds\.slice\(i, i \+ chunk\) \}, companyId, createdAt: \{ gte: range\.from, lt: range\.to \} \}/, "查询条件里要带公司（光有参数名不算）");
  assert.match(keep, /return orderIds\.filter\(\(id\) => hit\.has\(id\)\);/, "顺序照 listScopedOrderIds 的");
  const monthSrc = read("apps/api/src/modules/finance-link/order-month.ts");
  assert.ok(!/import /.test(monthSrc), "order-month.ts 只放解析和起止时间，不引别的");
});

check("V2 轨迹一条只有 at/status/statusZh/remark/nextStop；柜号抹掉、代码拼的「管理员」抹掉（跟代理端同一个函数）", () => {
  const log = mapTrackLog({
    toStatus: "departed", remark: "管理员把「鞋」的货型由普货改为商检 柜号 ZZFT9988", nextStop: "MEDU1234567 去林查班", changedAt: new Date("2026-10-03T01:00:00Z"),
  }, ["ZZFT9988"]);
  assert.deepEqual(Object.keys(log).sort(), ["at", "nextStop", "remark", "status", "statusZh"]);
  assert.ok(!log.remark.includes("ZZFT9988"), log.remark);
  assert.ok(!log.nextStop.includes("MEDU1234567"), log.nextStop);
  assert.ok(!log.remark.includes("管理员"), log.remark);
  assert.equal(log.statusZh, "已开船");
  const labeled = mapTrackLog({ toStatus: "departed", remark: "柜号：ABC-77 今天到", nextStop: "柜号:XYZ-88", changedAt: new Date("2026-10-03T01:00:00Z") }, []);
  assert.ok(!labeled.remark.includes("ABC-77"), `没录进系统、也不是标准写法的手写柜号要抹：${labeled.remark}`);
  assert.ok(!labeled.nextStop.includes("XYZ-88"), labeled.nextStop);
  assert.equal(log.at, "2026-10-03T01:00:00.000Z");
  assert.deepEqual(Object.keys(mapTrackChild({ trackingNo: "T", currentStatus: "loaded" })).sort(), ["currentStatus", "statusZh", "trackingNo"]);
});

/* ─────────────── 授权的纯逻辑 ─────────────── */

check("V3 手写柜号：一个、好几个、带空格都抹干净，后半句留着", () => {
  const cases: Array<[string, string[], string[]]> = [
    ["柜号：ABC-77 今天到", ["ABC-77"], ["今天到"]],
    ["柜号：ABC-77（分装 2件）", ["ABC-77"], ["（分装 2件）"]],
    ["柜号：ABC-77、XYZ-88", ["ABC-77", "XYZ-88"], []],
    ["柜号：ABC-77, XYZ-88 已开船", ["ABC-77", "XYZ-88"], ["已开船"]],
    ["柜号：ABC-77 / XYZ-88", ["ABC-77", "XYZ-88"], []],
    ["柜号:L26 0821 9129 今日到", ["L26", "0821", "9129"], ["今日到"]],
    ["柜号 ABC-77 今日开船", ["ABC-77"], ["今日开船"]],
    ["柜号ABC-77", ["ABC-77"], []],
    ["柜号：七号柜，今天到", ["七号柜"], ["今天到"]],
  ];
  for (const [input, gone, kept] of cases) {
    const out = maskHandwrittenContainerNos(input);
    for (const word of gone) assert.ok(!out.includes(word), `${input} → ${out}`);
    for (const word of kept) assert.ok(out.includes(word), `${input} → ${out}`);
    assert.ok(out.includes("不对外显示"), `${input} → ${out}`);
  }
  // 不是柜号的不碰
  for (const text of ["入库完成", "柜号已隐藏 去林查班", "这个柜号我不清楚", "请联系管理员确认"]) assert.equal(maskHandwrittenContainerNos(text), text);
});

check("A1 只有客户和代理能授权", () => {
  for (const r of ["client", "agent"]) assert.equal(canAuthorize(r), true, r);
  for (const r of ["staff", "admin", "", null, undefined, "Client"]) assert.equal(canAuthorize(r), false, String(r));
});

check("A2 随机串至少 32 字节；授权编号不超过 128 位", () => {
  const v = newOpaqueValue();
  assert.ok(Buffer.from(v, "base64url").length >= 32, v);
  assert.notEqual(newOpaqueValue(), v);
  const id = newAuthorizationId();
  assert.equal(typeof id, "string");
  assert.ok(id.length <= 128, id);
  assert.equal(sha256Hex("a").length, 64);
});

check("A3 账号核对先后：封禁 → 角色 → 密码；公司不对当封禁；都对才 null", () => {
  const fp = passwordFingerprint("hash-1");
  const auth = { companyId: "c1", role: "client", passwordFingerprint: fp };
  const user = { companyId: "c1", role: "client", status: "active", passwordHash: "hash-1" };
  assert.equal(linkProblem(auth, user), null);
  assert.equal(linkProblem(auth, null), "ACCOUNT_DISABLED");
  assert.equal(linkProblem(auth, { ...user, status: "inactive" }), "ACCOUNT_DISABLED");
  assert.equal(linkProblem(auth, { ...user, companyId: "c2" }), "ACCOUNT_DISABLED");
  assert.equal(linkProblem(auth, { ...user, role: "agent" }), "ROLE_CHANGED");
  assert.equal(linkProblem(auth, { ...user, passwordHash: "hash-2" }), "PASSWORD_CHANGED");
  assert.equal(linkProblem(auth, { ...user, status: "inactive", role: "agent", passwordHash: "hash-2" }), "ACCOUNT_DISABLED", "封禁排最前");
  assert.equal(linkProblem(auth, { ...user, role: "agent", passwordHash: "hash-2" }), "ROLE_CHANGED", "角色排密码前");
});

check("A4 一次性码的哈希跟登录那一刻的账号、角色、密码绑定：哪样变了都对不上", () => {
  const user = { id: "U1", companyId: "c1", role: "client", passwordHash: "hash-1" };
  const h = codeHashOf("code", user);
  assert.equal(h, codeHashOf("code", { ...user }));
  assert.notEqual(h, codeHashOf("code2", user));
  assert.notEqual(h, codeHashOf("code", { ...user, passwordHash: "hash-2" }));
  assert.notEqual(h, codeHashOf("code", { ...user, role: "agent" }));
  assert.notEqual(h, codeHashOf("code", { ...user, id: "U2" }));
  assert.notEqual(h, codeHashOf("code", { ...user, companyId: "c2" }));
  assert.ok(!h.includes("code"));
});

check("A5 last_used_at 最多一小时写一次", () => {
  const now = new Date("2026-11-04T10:00:00Z");
  assert.equal(shouldTouchLastUsed(null, now), true);
  assert.equal(shouldTouchLastUsed(new Date("2026-11-04T09:30:00Z"), now), false);
  assert.equal(shouldTouchLastUsed(new Date("2026-11-04T09:00:00Z"), now), true);
});

check("A6 授权页地址：线上 https；走 Next 看 x-forwarded-host；直连 api.xianlianth.com 指回主域名，别的 api.xxx 不动；不像域名的不要", () => {
  assert.equal(authorizeUrlOf({ host: "api.partner.com" }, "abc", true), "https://api.partner.com/login/authorize?request=abc", "代理专属域名不能被改");
  assert.equal(authorizeUrlOf({ host: "api:3001", "x-forwarded-host": "xianlianth.com" }, "abc", true), "https://xianlianth.com/login/authorize?request=abc");
  assert.equal(authorizeUrlOf({ host: "api.xianlianth.com" }, "abc", true), "https://xianlianth.com/login/authorize?request=abc");
  assert.equal(authorizeUrlOf({ host: "127.0.0.1:3000" }, "a b", false), "http://127.0.0.1:3000/login/authorize?request=a%20b");
  assert.equal(authorizeUrlOf({ "x-forwarded-host": "a.com, b.com" }, "x", true), "https://a.com/login/authorize?request=x");
  for (const bad of ["evil.com/path", "evil.com#", "user@evil.com", "", "a b"]) assert.equal(authorizeUrlOf({ host: bad }, "x", true), null, bad);
  assert.equal(authorizeUrlOf({}, "x", true), null);
});

/* ─────────────── 接线 ─────────────── */

check("W1 财务这组只有 5 条精确路径不跑登录解析；拆派仓那组没动；授权页那两条不在里面", () => {
  assert.deepEqual([...FINANCE_LINK_PATHS].sort(), [
    "/integrations/finance/v1/link-requests",
    "/integrations/finance/v1/link-tokens",
    "/integrations/finance/v1/link-tokens/revoke",
    "/integrations/finance/v1/waybills",
    "/integrations/finance/v1/waybills/track",
  ]);
  assert.deepEqual([...INTEGRATION_PATHS].sort(), [
    "/integrations/chaipai/v2/container-manifest",
    "/integrations/chaipai/v2/events",
    "/integrations/chaipai/v2/waybill-manifest",
  ]);
  assert.ok(!FINANCE_LINK_PATHS.has(AUTHORIZE_INFO_PATH) && !FINANCE_LINK_PATHS.has(AUTHORIZE_SUBMIT_PATH));
  const server = read("apps/api/src/server.ts");
  assert.match(server, /auth: INTEGRATION_PATHS\.has\(path\) \? undefined : await parseAuth\(rawReq\.headers, path\)/, "拆派仓那一句不动");
  assert.match(server, /async function parseAuth\([^\n]*\n[^\n]*\n\s*if \(path && FINANCE_LINK_PATHS\.has\(path\)\) return undefined;/, "财务那几条在 parseAuth 第一句就不解析");
  assert.ok(!/startsWith\(["'`]\/integrations/.test(server), "不许按前缀放");
});

check("W2 main.ts 注册了路由；Next 已转发 /auth 和 /integrations，没改 next.config.ts 也通", () => {
  assert.match(read("apps/api/src/main.ts"), /registerFinanceLinkRoutes\(app\);/);
  const next = read("apps/web/next.config.ts");
  assert.match(next, /source: "\/auth\/:path\*"/);
  assert.match(next, /source: "\/integrations\/:path\*"/);
});

check("W3 代理端四个函数只加了 export，别的路由照旧用；列表 / 明细只读 auth.companyId，名下客户只读 agentId + companyId", () => {
  const src = read("apps/api/src/modules/agent-portal/routes.ts");
  for (const sig of [
    "export async function loadAgentClients(auth: AgentAuth): Promise<AgentClientRow[]>",
    "export async function listScopedOrderIds(",
    "export async function loadShipmentRows(auth: AgentAuth, orderIds: string[], clientNames: Map<string, string>)",
    "export function readShipmentFilters(req: HttpRequest): ShipmentFilters | string",
  ]) assert.ok(src.includes(sig), sig);
  const bodyOf = (start: string, end: string) => {
    const from = src.indexOf(start);
    const to = src.indexOf(end, from);
    assert.ok(from >= 0 && to > from, start);
    return src.slice(from, to);
  };
  const fields = (body: string) => [...new Set([...body.matchAll(/\bauth\.(\w+)/g)].map((m) => m[1]))].sort();
  // 普通客户也走这几个函数：它们读 auth 的别的字段就得回来重想（finance-link/routes.ts 的 loadLinkScope）
  assert.deepEqual(fields(bodyOf("export async function listScopedOrderIds(", "/** 按 id 拉订单明细")), ["companyId"]);
  assert.deepEqual(fields(bodyOf("export async function loadShipmentRows(", "export function readShipmentFilters")), ["companyId"]);
  assert.deepEqual(fields(bodyOf("export async function loadAgentClients(", "function queryText")), ["agentId", "companyId"]);
  assert.match(bodyOf("export async function loadAgentClients(", "function queryText"), /if \(!auth\.agentId \|\| !auth\.companyId\) return \[\];/, "agentId 为空必须回空，不能放大范围");
  // 普通客户拼的那个身份不带 agentId：行为上现在看不出差别（上面钉着只读这两个字段），这里点名防以后放大范围
  assert.ok(read("apps/api/src/modules/finance-link/routes.ts").includes('const agentId = link.role === "agent" ? link.agentId ?? "" : "";'));
});

check("W4 代理前缀保留字里有 login：授权页放 /login 下面不占新字", () => {
  assert.ok(RESERVED_AGENT_SLUGS.has("login"));
  assert.ok(read("apps/web/src/app/login/authorize/page.tsx").length > 0);
});

check("W5 三个环境变量进了 .env.example / env.example / docker-compose 的 api；不进前端", () => {
  for (const file of [".env.example", "env.example"]) {
    const text = read(file);
    for (const name of ["FINANCE_LINK_ENABLED", "FINANCE_LINK_SECRET", "FINANCE_LINK_RETURN_URL"]) assert.match(text, new RegExp(`^${name}=$`, "m"), `${file} ${name}（样板里不许写值）`);
  }
  const compose = read("docker-compose.yml");
  for (const name of ["FINANCE_LINK_ENABLED", "FINANCE_LINK_SECRET", "FINANCE_LINK_RETURN_URL"]) {
    assert.equal(compose.split("\n").filter((l) => l.includes(name)).join("\n"), `      ${name}: \${${name}:-}`, `${name} 只透传给 api 一处`);
  }
  assert.ok(compose.indexOf("FINANCE_LINK_SECRET") < compose.indexOf("NEXT_PUBLIC_API_BASE_URL"), "api 服务在 web 前面，变量要在 api 那一段");
  assert.ok(!read("apps/web/src/app/login/authorize/page.tsx").includes("FINANCE_LINK"));
});

/* ─────────────── 规矩 ─────────────── */

check("R1 finance-link 模块里没有 `...row`，也没有整对象展开进响应", () => {
  for (const f of ["routes.ts", "views.ts"]) {
    // 注释里写着规矩「不许 ...row」，要先去掉注释再查
    const text = read(`apps/api/src/modules/finance-link/${f}`).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/\.\.\.(row|o|ship|order|user|log|child|c)\b|\.\.\.shipment\s*[,}]/.test(text), `${f} 有展开整行`);
  }
});

check("R1b 模块不引 apps/web：后台镜像（Dockerfile.api）只拷 apps/api 和 packages，引了线上就起不来", () => {
  assert.ok(read("Dockerfile.api").includes("COPY apps/api ./apps/api") && !read("Dockerfile.api").includes("apps/web"));
  for (const f of ["routes.ts", "views.ts", "authorization.ts", "config.ts", "paths.ts", "status-zh.ts"]) {
    const imports = read(`apps/api/src/modules/finance-link/${f}`).split("\n").filter((l) => /^\s*(import|export) .*from /.test(l));
    for (const line of imports) assert.ok(!line.includes("apps/web"), `${f}: ${line}`);
  }
});

check("R1c 客户名字不出物流系统：模块不查 users.name、不读 .name；name 字段的值都是唛头", () => {
  for (const f of ["routes.ts", "views.ts", "authorization.ts"]) {
    const text = read(`apps/api/src/modules/finance-link/${f}`).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/\bname:\s*true\b/.test(text), `${f} 在查名字`);
    assert.ok(!/[\w\])]\s*[?!]?\.name\b/.test(text), `${f} 在读 .name`);
  }
  const routes = read("apps/api/src/modules/finance-link/routes.ts");
  assert.ok(routes.includes("return { account: user.id, name: user.id, role: user.role };"));
  assert.ok(routes.includes("({ clientId: id, name: id })"));
});

check("R2 日志里没有密码、授权、一次性码", () => {
  const dir = "apps/api/src/modules/finance-link";
  for (const f of ["routes.ts", "authorization.ts", "config.ts", "views.ts"]) {
    for (const line of read(`${dir}/${f}`).split("\n").filter((l) => /logger\.|console\./.test(l))) {
      assert.ok(!/\b(password|token|code|secret|passwordHash|codeHash|tokenHash|FINANCE_LINK_SECRET)\b/i.test(line.replace(/["'`][^"'`]*["'`]/g, "")), `${f}: ${line.trim()}`);
    }
  }
});

check("R3 授权接口不签登录令牌；跳回地址只读配置；不收请求里传的地址", () => {
  const routes = read("apps/api/src/modules/finance-link/routes.ts");
  assert.ok(!routes.includes("signAuthToken"), "不签登录令牌");
  assert.match(routes, /redirectUrl: `\$\{cfg\.returnUrl\}#request=\$\{encodeURIComponent\(pending\.id\)\}&code=\$\{encodeURIComponent\(code\)\}`/);
  assert.ok(!/returnUrl\b.*(raw|body|req\.query)|(raw|body|req\.query).*returnUrl/.test(routes), "不收请求里的地址");
});

check("R4 登录限流、失败计数、失败提示跟 /auth/login 同一份（键也一样）", () => {
  const routes = read("apps/api/src/modules/finance-link/routes.ts");
  const login = read("apps/api/src/modules/auth/routes.ts");
  for (const piece of [
    'checkRateLimit(rateLimitKey(ip, "login"), 10, 60_000)',
    "登录尝试次数过多，请 1 分钟后再试。",
    "loginRetryAfterMs(",
    "这个账号密码错太多次了，请 ${waitMin} 分钟后再试。着急的话联系管理员重置密码。",
    'fail(res, 401, "UNAUTHORIZED", "invalid credentials")',
    "recordLoginFailure(",
    "clearLoginFailures(",
  ]) {
    assert.ok(login.includes(piece), `/auth/login 没有了：${piece}`);
    assert.ok(routes.includes(piece), `授权接口没有：${piece}`);
  }
});

check("R5 授权页不碰登录状态：不引 core-api / auth-session / LoginView；文字照修改清单；公共样式只用现成的", () => {
  const raw = read("apps/web/src/app/login/authorize/page.tsx");
  const page = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const bad of ["core-api", "auth-session", "LoginView", "setAuthSession", "prepareLoginPage", "localStorage", "sessionStorage", "document.cookie", "@import"]) {
    assert.ok(!page.includes(bad), bad);
  }
  assert.ok(page.includes("海外仓财务系统（{state.warehouseName}）申请查看你这个账号的运单状态。只能看，不能改。你的密码不会交给财务系统。"));
  assert.ok(!/searchParams\.get\(["']warehouse|get\(["']warehouse/.test(page), "仓名不从网址取");
  assert.ok(!/from "\.\.?\/.*\.css"/.test(page), "不加样式文件");
});

check("R6 迁移只加不删：只有 CREATE TABLE / CREATE INDEX，全 IF NOT EXISTS", () => {
  const sql = read("apps/api/prisma/migrations/20261104_finance_link/migration.sql").replace(/^--.*$/gm, "");
  const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);
  assert.equal(statements.length, 5);
  for (const s of statements) assert.match(s, /^CREATE (TABLE|INDEX|UNIQUE INDEX) IF NOT EXISTS /, s.slice(0, 60));
  assert.ok(!/\b(DROP|ALTER|UPDATE|DELETE|INSERT|TRUNCATE)\b/i.test(sql));
});

check("R7 两张表的字段跟修改清单第六节一个不差", () => {
  const schema = read("apps/api/prisma/schema.prisma");
  const columnsOf = (model: string) => {
    const body = schema.split(`model ${model} {`)[1]?.split("\n}")[0] ?? "";
    return body.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//") && !l.startsWith("@@"))
      .map((l) => /@map\("([^"]+)"\)/.exec(l)?.[1] ?? l.split(/\s+/)[0]);
  };
  assert.deepEqual(columnsOf("FinanceLinkRequest"), ["id", "warehouse_ref", "warehouse_name", "user_id", "code_hash", "code_expires_at", "code_used_at", "expires_at", "created_at"]);
  assert.deepEqual(columnsOf("FinanceLinkAuthorization"), ["id", "company_id", "user_id", "warehouse_ref", "warehouse_name", "token_hash", "password_fingerprint", "role", "created_at", "last_used_at", "revoked_at", "revoked_reason"]);
  assert.match(schema, /tokenHash\s+String\s+@unique @map\("token_hash"\)/);
});

check("R7b 上线体检清单登记了两张新表的每个字段，还写清总数", () => {
  const drift = read("scripts/check-schema-drift.sql");
  for (const [table, columns] of [
    ["finance_link_requests", ["id", "warehouse_ref", "warehouse_name", "user_id", "code_hash", "code_expires_at", "code_used_at", "expires_at", "created_at"]],
    ["finance_link_authorizations", ["id", "company_id", "user_id", "warehouse_ref", "warehouse_name", "token_hash", "password_fingerprint", "role", "created_at", "last_used_at", "revoked_at", "revoked_reason"]],
  ] as Array<[string, string[]]>) {
    for (const c of columns) assert.ok(drift.includes(`('${table}','${c}')`), `${table}.${c}`);
  }
  assert.match(drift, /共 63 张表 \/ 790 个字段/);
});

check("R8 两个测试进了 package.json 和 ci.yml", () => {
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["test:finance-link-source"], "tsx scripts/test-finance-link-source.ts");
  assert.equal(pkg.scripts["test:finance-link-db"], "tsx scripts/test-finance-link-db.ts");
  const ci = read(".github/workflows/ci.yml");
  assert.ok(ci.includes("run: npm run test:finance-link-source"));
  assert.ok(ci.includes("run: bash .github/scripts/run-db-test.sh test:finance-link-db"));
});

console.log(`\n通过 ${passed}，失败 ${failed}`);
process.exit(failed > 0 ? 1 : 0);
