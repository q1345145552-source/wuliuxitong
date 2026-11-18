/**
 * 给财务系统2 的只读接口：不连库的部分（2026-11-19）。
 * 盯：密钥只认指纹、新旧两把、定长比较；配置不全就关；路径只放行那几条；
 * 运单拼出来的样子跟约定第 3 节一样（字段一个不多一个不少、字符串小数位、时间带 Z、null 不省略）；
 * 确认收货 / 签收时间的取法；游标和时间参数。
 * 用法：npm run test:finance2-source
 */
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { bearerKeyMatchesAny, readKeyFingerprints, sha256HexOf } from "../apps/api/src/modules/finance2/api-key";
import { readFinance2Config } from "../apps/api/src/modules/finance2/config";
import {
  FINANCE2_CHANGES_PATH,
  FINANCE2_CUSTOMERS_PATH,
  finance2WaybillNoFromPath,
  isFinance2Path,
} from "../apps/api/src/modules/finance2/paths";
import {
  WAYBILL_KEYS,
  buildWaybill,
  decodeCursor,
  deletedWaybill,
  encodeCursor,
  floatText,
  parseZonedTime,
  signedAtOf,
  utcDate,
  warehouseConfirmedAtOf,
  type WaybillSource,
} from "../apps/api/src/modules/finance2/views";
import { FINANCE_LINK_PATHS } from "../apps/api/src/modules/finance-link/paths";

let failures = 0;
let passes = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passes++; console.log(`  ✅ ${name}`); }
  catch (e) { failures++; console.log(`  ❌ ${name}\n     ${(e instanceof Error ? e.message : String(e)).split("\n").slice(0, 10).join("\n     ")}`); }
}

const D = (s: string) => new Prisma.Decimal(s);
const T = (s: string) => new Date(s);
const KEY = "k3y-For-Finance2-aB3dE5gH7jK9mN1pQ3sT5vX";
const OLD_KEY = "0ld-k3y-For-Finance2-zY8xW6vU4tS2rQ0pO9";

console.log("\n【密钥和配置】");
test("K1 指纹对得上才放行；新旧两把都认；大小写、多空格、缺 Bearer、超长、空指纹一律不放", () => {
  const fps = readKeyFingerprints({ A: sha256HexOf(KEY), B: sha256HexOf(OLD_KEY) }, ["A", "B"]);
  assert.ok(fps.ok);
  if (!fps.ok) return;
  assert.equal(bearerKeyMatchesAny(`Bearer ${KEY}`, fps.fingerprints), true);
  assert.equal(bearerKeyMatchesAny(`Bearer ${OLD_KEY}`, fps.fingerprints), true);
  for (const bad of [undefined, "", KEY, `bearer${KEY}`, `Bearer ${KEY}x`, `Bearer ${KEY.toUpperCase()}`, `Bearer  ${KEY}`, `Bearer ${KEY} x`, `Bearer ${"a".repeat(600)}`, ["Bearer", KEY]]) {
    assert.equal(bearerKeyMatchesAny(bad, fps.fingerprints), false, String(bad));
  }
  assert.equal(bearerKeyMatchesAny(`Bearer ${KEY}`, []), false);
});

test("K2 环境变量里只认指纹：填成密钥本身、大写、两把一样、第一把没填都算不合格；第二把可以空", () => {
  assert.equal(readKeyFingerprints({ A: KEY }, ["A", "B"]).ok, false, "填密钥本身");
  assert.equal(readKeyFingerprints({ A: sha256HexOf(KEY).toUpperCase() }, ["A"]).ok, false, "大写");
  assert.equal(readKeyFingerprints({ A: sha256HexOf(KEY), B: sha256HexOf(KEY) }, ["A", "B"]).ok, false, "两把一样");
  assert.equal(readKeyFingerprints({ B: sha256HexOf(KEY) }, ["A", "B"]).ok, false, "第一把没填");
  const one = readKeyFingerprints({ A: sha256HexOf(KEY), B: "" }, ["A", "B"]);
  assert.ok(one.ok && one.fingerprints.length === 1);
  const bad = readKeyFingerprints({ A: sha256HexOf(KEY), B: "xyz" }, ["A", "B"]);
  assert.ok(!bad.ok && !bad.reason.includes("xyz"), "原因里不带填的值");
});

test("K3 配置：公司没填 / 带空格 / 指纹不对就关；配齐才开", () => {
  const fp = sha256HexOf(KEY);
  assert.equal(readFinance2Config({ FINANCE2_API_KEY_SHA256: fp }).ok, false);
  assert.equal(readFinance2Config({ FINANCE2_COMPANY_ID: " c1", FINANCE2_API_KEY_SHA256: fp }).ok, false);
  assert.equal(readFinance2Config({ FINANCE2_COMPANY_ID: "c1", FINANCE2_API_KEY_SHA256: KEY }).ok, false);
  const ok = readFinance2Config({ FINANCE2_COMPANY_ID: "c1", FINANCE2_API_KEY_SHA256: fp, FINANCE2_API_KEY_SHA256_PREV: sha256HexOf(OLD_KEY) });
  assert.ok(ok.ok && ok.cfg.companyId === "c1" && ok.cfg.fingerprints.length === 2);
});

console.log("\n【路径】");
test("P1 只放行这几条和 /waybills/<运单号>；不按前缀整段放；原来那组一个不碰", () => {
  assert.equal(isFinance2Path(FINANCE2_CHANGES_PATH), true);
  assert.equal(isFinance2Path(FINANCE2_CUSTOMERS_PATH), true);
  assert.equal(finance2WaybillNoFromPath("/integrations/finance2/v1/waybills/XT2611180001"), "XT2611180001");
  assert.equal(finance2WaybillNoFromPath("/integrations/finance2/v1/waybills/XT2611100045-1"), "XT2611100045-1");
  assert.equal(finance2WaybillNoFromPath("/integrations/finance2/v1/waybills/%E6%B5%8B1"), "测1");
  for (const p of [
    "/integrations/finance2/v1/waybills/", "/integrations/finance2/v1/waybills/a/b", "/integrations/finance2/v1/waybills/%2Fx",
    "/integrations/finance2/v1/waybills/%E0%A4%A", "/integrations/finance2/v1/waybills/%00", `/integrations/finance2/v1/waybills/${"A".repeat(101)}`,
    "/integrations/finance2/v1/other", "/integrations/finance2/v2/waybills/changes", "/integrations/finance/v1/waybills", "/admin/orders",
  ]) assert.equal(isFinance2Path(p), false, p);
  for (const p of FINANCE_LINK_PATHS) assert.equal(isFinance2Path(p), false, p);
});

console.log("\n【运单长什么样】");

/** 约定 3.5 那种：拆了两张子运单、装了两个柜 */
function splitSource(): WaybillSource {
  return {
    order: {
      clientId: "20231", warehouseId: "wh_yiwu_01", transportMode: "sea", cargoType: "normal",
      volumeM3: D("5.6"), weightKg: D("720"), packageCount: 40, approvalStatus: "approved", receivableAmountCny: D("999.5"), createdAt: T("2026-11-08T04:00:00Z"),
    },
    agentId: "cm3agent0003",
    mother: { id: "s0", trackingNo: "XT2611100045", parentTrackingNo: null, currentStatus: "departed", volumeM3: D("0"), weightKg: D("0"), packageCount: 0 },
    children: [
      { id: "s1", trackingNo: "XT2611100045-1", parentTrackingNo: "XT2611100045", currentStatus: "departed", volumeM3: D("3.5"), weightKg: null, packageCount: 25 },
      // 老的手工分柜子单：没存方数，按件数占比补算 5.6 × 15 / 40 = 2.1
      { id: "s2", trackingNo: "XT2611100045-2", parentTrackingNo: "XT2611100045", currentStatus: "loaded", volumeM3: null, weightKg: null, packageCount: 15 },
    ],
    products: [{ id: "cm3op88001", cargoType: "normal", itemName: "塑料凳", lengthCm: 70, widthCm: 50, heightCm: 40, packageCount: 40 }],
    logsByShipmentId: new Map([
      ["s0", [{ toStatus: "inWarehouseCN", changedAt: T("2026-11-10T07:00:00Z") }, { toStatus: "loaded", changedAt: T("2026-11-12T11:30:00Z") }, { toStatus: "departed", changedAt: T("2026-11-17T15:00:00Z") }]],
      ["s1", [{ toStatus: "departed", changedAt: T("2026-11-17T15:00:00Z") }]],
      ["s2", [{ toStatus: "loaded", changedAt: T("2026-11-14T12:10:00Z") }]],
    ]),
    containerItems: [
      { trackingNo: "XT2611100045-2", loadedVolumeM3: D("2.1"), loadedPieceCount: 15, createdAt: T("2026-11-14T12:10:00Z"), container: { containerNo: "TGHU7654321", containerType: "40HQ", loadingDate: null, isFcl: false } },
      { trackingNo: "XT2611100045-1", loadedVolumeM3: D("3.5"), loadedPieceCount: 25, createdAt: T("2026-11-12T11:30:00Z"), container: { containerNo: "TCLU1234567", containerType: "40HQ", loadingDate: null, isFcl: false } },
    ],
    changedAt: T("2026-11-17T15:00:00.900Z"),
  };
}

test("V1 拆了子运单的一票：字段一个不多一个不少；体积 3 位、重量 2 位、产品方数 6 位；柜按装柜时间排；子单方数补算", () => {
  const w = buildWaybill(splitSource());
  assert.deepEqual(Object.keys(w), [...WAYBILL_KEYS]);
  assert.equal(w.waybillNo, "XT2611100045");
  assert.equal(w.volumeCbm, "5.600");
  assert.equal(w.weightKg, "720.00");
  assert.equal(w.pieces, 40);
  assert.deepEqual(w.products, [{ productLineId: "cm3op88001", cargoType: "normal", name: "塑料凳", lengthCm: "70", widthCm: "50", heightCm: "40", pieces: 40, volumeCbm: "5.600000" }]);
  assert.equal(w.status, "departed");
  assert.equal(w.statusChangedAt, "2026-11-17T15:00:00.000Z");
  assert.equal(w.warehouseConfirmedAt, "2026-11-10T07:00:00.000Z");
  assert.equal(w.signedAt, null);
  assert.equal(w.isFcl, false);
  assert.equal(w.fcl, null, "不是整柜 fcl 必须是 null（整柜金额不能漏出来）");
  assert.deepEqual(w.containers.map((c) => [c.containerNo, c.trackingNo, c.volumeCbm, c.pieces, c.loadedAt]), [
    ["TCLU1234567", "XT2611100045-1", "3.500", 25, "2026-11-12T11:30:00.000Z"],
    ["TGHU7654321", "XT2611100045-2", "2.100", 15, "2026-11-14T12:10:00.000Z"],
  ]);
  assert.deepEqual(w.splits, [
    { trackingNo: "XT2611100045-1", status: "departed", statusChangedAt: "2026-11-17T15:00:00.000Z", volumeCbm: "3.500", pieces: 25 },
    { trackingNo: "XT2611100045-2", status: "loaded", statusChangedAt: "2026-11-14T12:10:00.000Z", volumeCbm: "2.100", pieces: 15 },
  ]);
  assert.equal(w.changedAt, "2026-11-17T15:00:00.900Z");
  assert.equal(w.deletedAt, null);
  assert.equal(w.agentId, "cm3agent0003");
});

test("V2 订单没体积重量时合计父子运单（跟运单列表同一个取法）；都没有给 null，不给 0", () => {
  const s = splitSource();
  s.order.volumeM3 = null; s.order.weightKg = null;
  s.mother.volumeM3 = D("0.1");
  const w = buildWaybill(s);
  assert.equal(w.volumeCbm, "3.600", "0.1 + 3.5，子单没存的不算");
  assert.equal(w.weightKg, "0.00", "母单 0 也是有值");
  s.mother.weightKg = null;
  assert.equal(buildWaybill(s).weightKg, null);
});

test("V3 整柜：isFcl 和 fcl 一起有；金额 2 位字符串、装柜日期取 UTC 年月日；整柜没填金额给 null", () => {
  const s = splitSource();
  s.children = [];
  s.containerItems = [{ trackingNo: "FCL1", loadedVolumeM3: D("0"), loadedPieceCount: 0, createdAt: T("2026-11-05T03:00:00Z"), container: { containerNo: "MSKU7654321", containerType: "40HQ", loadingDate: T("2026-11-05T00:00:00Z"), isFcl: true } }];
  s.order.receivableAmountCny = D("28000");
  const w = buildWaybill(s);
  assert.equal(w.isFcl, true);
  assert.deepEqual(w.fcl, { containerNo: "MSKU7654321", containerType: "40HQ", loadingDate: "2026-11-05", amountCny: "28000.00" });
  s.order.receivableAmountCny = null;
  assert.equal(buildWaybill(s).fcl?.amountCny, null);
});

test("V4 尺寸原样（16.9 → \"16.9\"、0.1+0.2 这种浮点照最短写法）；有一样没填产品方数给 null；货型认不出来给 null 不当普货", () => {
  assert.equal(floatText(16.9), "16.9");
  assert.equal(floatText(50), "50");
  assert.equal(floatText(null), null);
  assert.equal(floatText(Number.NaN), null);
  const s = splitSource();
  s.products = [
    { id: "p1", cargoType: "weird", itemName: "文具", lengthCm: null, widthCm: 10, heightCm: 10, packageCount: 3 },
    { id: "p2", cargoType: "special", itemName: "x", lengthCm: 10, widthCm: 1.5, heightCm: 4.1, packageCount: 10 },
  ];
  s.order.cargoType = "?";
  const w = buildWaybill(s);
  assert.equal(w.cargoType, null);
  assert.deepEqual(w.products.map((p) => [p.cargoType, p.lengthCm, p.volumeCbm]), [[null, null, null], ["special", "10", "0.000615"]]);
});

test("V5 确认收货时间：取母运单最早那条 inWarehouseCN（卸柜退回再写一条不算）；预报单没收货 / 待入库 / 已创建给 null", () => {
  const logs = [
    { toStatus: "created", changedAt: T("2026-11-01T00:00:00Z") },
    { toStatus: "inWarehouseCN", changedAt: T("2026-11-03T00:00:00Z") },
    { toStatus: "loaded", changedAt: T("2026-11-04T00:00:00Z") },
    { toStatus: "inWarehouseCN", changedAt: T("2026-11-05T00:00:00Z") },
  ];
  assert.equal(warehouseConfirmedAtOf("received", "inWarehouseCN", logs)?.toISOString(), "2026-11-03T00:00:00.000Z");
  assert.equal(warehouseConfirmedAtOf("received", "inWarehouseCN", [...logs].reverse())?.toISOString(), "2026-11-03T00:00:00.000Z");
  assert.equal(warehouseConfirmedAtOf("shipped", "inWarehouseCN", logs), null);
  assert.equal(warehouseConfirmedAtOf("approved", "pendingInbound", logs), null);
  assert.equal(warehouseConfirmedAtOf("shipped", "created", []), null);
  assert.equal(warehouseConfirmedAtOf("approved", "inWarehouseCN", []), null, "老单没轨迹给 null");
});

test("V6 签收时间：母单和子单都签收（退回 / 取消的不等）才有，取一家里最后那条 delivered；有一张没签给 null", () => {
  const s = splitSource();
  s.mother.currentStatus = "delivered";
  s.children[0].currentStatus = "delivered";
  s.children[1].currentStatus = "outForDelivery";
  const logs = new Map(s.logsByShipmentId);
  logs.set("s1", [{ toStatus: "delivered", changedAt: T("2026-11-20T01:00:00Z") }]);
  logs.set("s2", [{ toStatus: "delivered", changedAt: T("2026-11-21T01:00:00Z") }]);
  s.logsByShipmentId = logs;
  assert.equal(signedAtOf(s), null);
  s.children[1].currentStatus = "cancelled";
  assert.equal(signedAtOf(s)?.toISOString(), "2026-11-21T01:00:00.000Z", "取消的那张不等，它那条旧轨迹照算最晚");
  s.children[1].currentStatus = "delivered";
  assert.equal(signedAtOf(s)?.toISOString(), "2026-11-21T01:00:00.000Z");
  s.mother.currentStatus = "outForDelivery";
  assert.equal(signedAtOf(s), null);
});

test("V7 删除记录（约定 3.9）：只有运单号、改动时间、删除时间，其余 null / [] / false", () => {
  const w = deletedWaybill("XT2611170021", T("2026-11-18T09:30:00Z"), T("2026-11-18T09:30:00.001Z"));
  assert.deepEqual(Object.keys(w), [...WAYBILL_KEYS]);
  assert.deepEqual(w, {
    waybillNo: "XT2611170021", customerMark: null, agentId: null, warehouseCode: null, transportMode: null, cargoType: null, volumeCbm: null,
    weightKg: null, pieces: null, products: [], approvalStatus: null, status: null, statusChangedAt: null, statusHistory: [],
    warehouseConfirmedAt: null, signedAt: null, isFcl: false, fcl: null, containers: [], splits: [], createdAt: null,
    changedAt: "2026-11-18T09:30:00.001Z", deletedAt: "2026-11-18T09:30:00.000Z",
  });
});

test("V8 JSON 里金额、体积、重量、尺寸没有一个是数字；时间都带 Z", () => {
  const json = JSON.stringify(buildWaybill(splitSource()));
  for (const k of ["volumeCbm", "weightKg", "lengthCm", "widthCm", "heightCm", "amountCny"]) {
    assert.doesNotMatch(json, new RegExp(`"${k}":-?\\d`), k);
  }
  for (const m of json.matchAll(/"(\d{4}-\d{2}-\d{2}T[^"]*)"/g)) assert.match(m[1], /Z$/, m[1]);
});

console.log("\n【参数】");
test("Q1 时间参数必须带时区；不带时区、乱写的、2 月 31 日 / 24 点 / 0000 年这种会被顺延或进库报错的不收", () => {
  assert.equal(parseZonedTime("2026-11-18T07:05:00.000Z")?.toISOString(), "2026-11-18T07:05:00.000Z");
  assert.equal(parseZonedTime("2026-11-18T14:05:00+07:00")?.toISOString(), "2026-11-18T07:05:00.000Z");
  assert.equal(parseZonedTime("2026-11-18T14:05+07:00")?.toISOString(), "2026-11-18T07:05:00.000Z");
  assert.equal(parseZonedTime("2028-02-29T00:00:00.123456Z")?.toISOString(), "2028-02-29T00:00:00.123Z");
  for (const bad of [undefined, "", "2026-11-18 14:05:00", "2026-11-18T14:05:00", "2026-11-18", "1731900000000", "2026-13-40T00:00:00Z", "2026-11-18T07:05:00Z junk", "0000-01-01T00:00:00Z", "2026-02-31T00:00:00Z", "2026-11-18T24:00:00Z", "2026-11-18T10:60:00Z", "2026-11-18T10:00:00+25:00"]) {
    assert.equal(parseZonedTime(bad), null, String(bad));
  }
});

test("Q2 游标：原样解得回；乱改、多字段、少字段、非字符串都不认", () => {
  const c = encodeCursor({ t: "2026-11-18T07:05:00.000Z", w: "XT1" });
  assert.deepEqual(decodeCursor(c, ["t", "w"]), { t: "2026-11-18T07:05:00.000Z", w: "XT1" });
  assert.equal(decodeCursor(`${c}!`, ["t", "w"]), null);
  assert.equal(decodeCursor(encodeCursor({ t: "x" }), ["t", "w"]), null);
  assert.equal(decodeCursor(encodeCursor({ t: "x", w: "y", z: "1" }), ["t", "w"]), null);
  assert.equal(decodeCursor(Buffer.from(JSON.stringify({ t: 1, w: "y" })).toString("base64url"), ["t", "w"]), null);
  assert.equal(decodeCursor("e30", ["t", "w"]), null);
  assert.equal(utcDate(T("2026-11-10T00:00:00Z")), "2026-11-10");
});

console.log(`\n通过 ${passes}，失败 ${failures}`);
process.exit(failures > 0 ? 1 : 0);
