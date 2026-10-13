/**
 * 对接拆派仓：不连库的部分（2026-10-12）。
 *
 * 配置门槛、拉清单的分份 / 字段 / 上限、回传的校验 / 目标状态 / 备注、签收图挑哪张，
 * 以及接线：/integrations 不跑登录解析、Next 转发、代理前缀保留字、轨迹不许单删、派送照片只给员工看。
 * 连库的整套流程在 test-chaipai-db.ts。
 * 用法：npm run test:chaipai-source
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { bearerMatches, isSafeSecret, readChaipaiConfig } from "../apps/api/src/modules/chaipai/config";
import {
  NO_BATCH,
  batchKeyOf,
  buildEnvelope,
  cleanOptionalText,
  containerKey,
  contentHashOf,
  envelopeProblem,
  itemBodyOf,
  manifestParts,
  planBatches,
  validContainerNoInput,
  validWaybillNoInput,
  type ManifestSourceRow,
} from "../apps/api/src/modules/chaipai/manifest";
import {
  arrivedRemark,
  bangkokDate,
  departRemark,
  eventHashOf,
  parseChaipaiEvent,
  pickSignPhoto,
  planForEvent,
} from "../apps/api/src/modules/chaipai/events";
import { deleteBlockedReasonOf } from "../apps/api/src/modules/shipments/managed-lastmile-log";
import { RESERVED_AGENT_SLUGS } from "../apps/api/src/modules/agents/agent-rules";
import { INTEGRATION_PATHS } from "../apps/api/src/modules/chaipai/paths";

const ROOT = path.join(__dirname, "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (e) { failed++; console.log(`❌ ${name}\n   ${e instanceof Error ? e.message.split("\n").slice(0, 4).join("\n   ") : String(e)}`); }
}

const S1 = "aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI";
const S2 = "Zy8Xw6Vu4Ts2Rq0Po8Nm6Lk4Ji2Hg0Fe";
const S3 = "Qw9Er7Ty5Ui3Op1As9Df7Gh5Jk3Lz1Xc";
const env = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  CHAIPAI_ENABLED: "true", CHAIPAI_COMPANY_ID: "xiangtai", CHAIPAI_PULL_SECRET: S1, CHAIPAI_CALLBACK_SECRET: S2,
  CHAIPAI_READ_SECRET: S3, CHAIPAI_API_BASE: "https://xtchaipai.top/api/", NODE_ENV: "production", ...over,
});

console.log("对接拆派仓（不连库）");

check("C1 配置：六项都合格才开；结尾的 / 去掉", () => {
  const r = readChaipaiConfig(env());
  assert.ok(r.ok);
  assert.equal(r.ok && r.cfg.apiBase, "https://xtchaipai.top/api");
  assert.equal(r.ok && r.cfg.companyId, "xiangtai");
});

check("C2 配置：开关不是 true / 少公司编号 / 密钥太短、带空白、种类太少、占位词 / 三把有相同的 → 一律当关", () => {
  for (const over of [
    { CHAIPAI_ENABLED: undefined }, { CHAIPAI_ENABLED: "1" }, { CHAIPAI_COMPANY_ID: "" }, { CHAIPAI_COMPANY_ID: " xiangtai" },
    { CHAIPAI_PULL_SECRET: "short" }, { CHAIPAI_PULL_SECRET: S1 + " x" }, { CHAIPAI_PULL_SECRET: "a".repeat(40) },
    { CHAIPAI_READ_SECRET: "change-me-change-me-change-me-12345" }, { CHAIPAI_READ_SECRET: S1 },
  ]) {
    assert.equal(readChaipaiConfig(env(over)).ok, false, JSON.stringify(over));
  }
  assert.equal(isSafeSecret(S1), true);
});

check("C3 配置：生产只认 https；开发只多放行本机 http；带用户名密码 / ? / # 不行", () => {
  assert.equal(readChaipaiConfig(env({ CHAIPAI_API_BASE: "http://xtchaipai.top/api" })).ok, false);
  assert.equal(readChaipaiConfig(env({ CHAIPAI_API_BASE: "http://127.0.0.1:4000" })).ok, false, "生产不许 http 本机");
  assert.equal(readChaipaiConfig(env({ CHAIPAI_API_BASE: "http://127.0.0.1:4000", NODE_ENV: "development" })).ok, true);
  assert.equal(readChaipaiConfig(env({ CHAIPAI_API_BASE: "http://10.0.0.5:4000", NODE_ENV: "development" })).ok, false);
  for (const bad of ["https://u:p@xtchaipai.top/api", "https://xtchaipai.top/api?x=1", "https://xtchaipai.top/api#a", " https://xtchaipai.top/api"]) {
    assert.equal(readChaipaiConfig(env({ CHAIPAI_API_BASE: bad })).ok, false, bad);
  }
});

check("C4 Bearer 核对：一字不差才过（多空格、小写 bearer 以外的前缀、长度不同都不过）", () => {
  assert.equal(bearerMatches(`Bearer ${S1}`, S1), true);
  assert.equal(bearerMatches(`Bearer ${S1}x`, S1), false);
  assert.equal(bearerMatches(`Basic ${S1}`, S1), false);
  assert.equal(bearerMatches(undefined, S1), false);
  assert.equal(bearerMatches(`Bearer ${S2}`, S1), false);
});

const row = (over: Partial<ManifestSourceRow> = {}): ManifestSourceRow => ({
  shipmentId: "s_1", trackingNo: "XT001-1", parentTrackingNo: "XT001", batchNo: "B1", clientId: "XHH-6698",
  loadedPieceCount: 3, loadedVolumeM3: 1.234, weightKg: 56.78, transportMode: "sea", itemName: "鞋", remark: null, ...over,
});

check("M1 柜号口径跟拆派仓一样：去掉全部空白（含全角空格）、转大写；员工输入 1～64 字、不含控制字符", () => {
  assert.equal(containerKey(" msku 123　4567 "), "MSKU1234567");
  assert.equal(containerKey("MSKU1234567"), containerKey("msku1234567"));
  assert.equal(validContainerNoInput("  MSKU1  "), "MSKU1");
  assert.equal(validContainerNoInput(""), null);
  assert.equal(validContainerNoInput("A".repeat(65)), null);
  assert.equal(validContainerNoInput("MS\u0085KU"), null);
});

check("M2 每票字段：Decimal 变数字、父单号兜底自己、唛头原文、运输方式转中文、空的选填字段不放键、重量没填发 0", () => {
  const b = itemBodyOf(row({ parentTrackingNo: null, remark: " \n ", itemName: "鞋\t\t袜", transportMode: "land", weightKg: null }));
  assert.equal(b.parentWaybillNo, "XT001-1");
  assert.equal(b.customerCode, "XHH-6698");
  assert.equal(typeof b.volumeM3, "number");
  assert.equal(b.weightKg, 0);
  assert.equal(b.transportMode, "陆运");
  assert.equal(b.itemName, "鞋 袜");
  assert.equal("remark" in b, false);
  assert.equal(cleanOptionalText("x".repeat(250), 200)!.length, 200);
});

check("M3 batchKey 固定规则（写死一个值核对），同柜同批次永远一样，换柜 / 换批次就不一样", () => {
  const k = batchKeyOf("xiangtai", "ctn_1", "B1");
  assert.equal(k, "xt-c1-" + createHash("sha256").update(JSON.stringify(["xiangtai", "ctn_1", "B1"])).digest("hex"));
  assert.notEqual(batchKeyOf("xiangtai", "ctn_1", null), batchKeyOf("xiangtai", "ctn_1", "NO-BATCH"), "没批次和批次号恰好叫 NO-BATCH 要分开");
  assert.equal(k.length, 70);
  assert.equal(batchKeyOf("xiangtai", "ctn_1", "B1"), k);
  assert.notEqual(batchKeyOf("xiangtai", "ctn_2", "B1"), k);
  assert.notEqual(batchKeyOf("xiangtai", "ctn_1", "B2"), k);
});

check("M4 分份：按批次号分、批次号空的统一 NO-BATCH；501 票切两份 batchKey 相同；份按批次号排、份内按运单 id 排", () => {
  const rows: ManifestSourceRow[] = [
    ...Array.from({ length: 501 }, (_, i) => row({ shipmentId: `s_${String(i).padStart(4, "0")}`, trackingNo: `T${i}`, batchNo: "B2" })),
    row({ shipmentId: "s_x", trackingNo: "TX", batchNo: null }),
    row({ shipmentId: "s_y", trackingNo: "TY", batchNo: "  " }),
    row({ shipmentId: "s_z", trackingNo: "TZ", batchNo: "A1" }),
  ];
  const b = planBatches("xiangtai", "ctn_1", rows);
  assert.deepEqual(b.map((x) => [x.batchNo, x.items.length]), [["A1", 1], ["B2", 500], ["B2", 1], [NO_BATCH, 2]]);
  assert.equal(b[1].batchKey, b[2].batchKey);
  assert.equal(b[1].items[0].sourceShipmentId, "s_0000");
  assert.equal(b[2].items[0].sourceShipmentId, "s_0500");
});

check("M4b 批次按湘泰原文分组、合规矩就原文发：清洗 / 截断后显示一样的两个批次不会被并成一批（batchKey 不同）", () => {
  const long = "B".repeat(128);
  const b = planBatches("xiangtai", "c", [
    row({ shipmentId: "s1", batchNo: `${long}1` }),
    row({ shipmentId: "s2", batchNo: `${long}2` }),
    row({ shipmentId: "s3", batchNo: "X\tY" }),
    row({ shipmentId: "s4", batchNo: "X Y" }),
  ]);
  assert.equal(b.length, 4);
  assert.equal(new Set(b.map((x) => x.batchKey)).size, 4);
  assert.ok(b.every((x) => x.batchNo.length <= 128 && !/[\x00-\x1f]/.test(x.batchNo)), "显示的批次号照样要合拆派仓的规矩");
  // 合规矩的批次号原样发（中间两个空格、前后空格都不动）
  const ok = planBatches("xiangtai", "c", [row({ shipmentId: "s5", batchNo: " X  Y " })]);
  assert.equal(ok[0].batchNo, " X  Y ");
});

check("M5 内容摘要：件数 / 方数 / 唛头 / 选填字段 / 批次变了摘要就变；没变就不变", () => {
  const key = batchKeyOf("xiangtai", "c", "B1");
  const base = contentHashOf(key, "B1", itemBodyOf(row()));
  assert.equal(contentHashOf(key, "B1", itemBodyOf(row())), base);
  for (const over of [{ loadedPieceCount: 4 }, { loadedVolumeM3: 1.235 }, { clientId: "OTHER" }, { remark: "易碎" }, { weightKg: 1 }]) {
    assert.notEqual(contentHashOf(key, "B1", itemBodyOf(row(over))), base, JSON.stringify(over));
  }
  assert.notEqual(contentHashOf(batchKeyOf("xiangtai", "c2", "B1"), "B1", itemBodyOf(row())), base);
});

check("M6 整次上限：51 份 / 5001 票 / 柜号有控制字符 → 先挡住；正常的不挡；版本时间填进每票", () => {
  const one = planBatches("xiangtai", "c", [row()]);
  const env1 = buildEnvelope("xiangtai", "MSKU1", one, () => "2026-10-12T03:00:00.000Z");
  assert.equal(envelopeProblem(env1), null);
  assert.equal(env1.manifests[0].shipments[0].sourceUpdatedAt, "2026-10-12T03:00:00.000Z");
  assert.equal(env1.protocolVersion, 2);
  assert.ok(!("code" in (env1 as object)), "不能带 code（会被套壳）");
  const many = planBatches("xiangtai", "c", Array.from({ length: 51 }, (_, i) => row({ shipmentId: `s${i}`, batchNo: `B${String(i).padStart(2, "0")}` })));
  assert.match(envelopeProblem(buildEnvelope("xiangtai", "M", many, () => "x"))!, /份数/);
  const big = planBatches("xiangtai", "c", Array.from({ length: 5001 }, (_, i) => row({ shipmentId: `s${i}`, batchNo: `B${i % 11}` })));
  assert.match(envelopeProblem(buildEnvelope("xiangtai", "M", big, () => "x"))!, /5000/);
  assert.match(envelopeProblem(buildEnvelope("xiangtai", "M\u0001", one, () => "x"))!, /柜号/);
  // 批次号也是整次拒收的（兜底自检：正常情况下 normalizeBatchNo 已经洗干净）
  assert.match(envelopeProblem(buildEnvelope("xiangtai", "M", [{ ...one[0], batchNo: "   " }], () => "x"))!, /批次号/);
  assert.match(envelopeProblem(buildEnvelope("xiangtai", "M", [{ ...one[0], batchNo: "B".repeat(129) }], () => "x"))!, /批次号/);
  // 5MB 两边：每票备注 700 个汉字（约 2.3KB），2300 票超、2150 票不超（按真实 JSON 字节算）
  const fat = (n: number) => planBatches("xiangtai", "c", Array.from({ length: n }, (_, i) => row({ shipmentId: `s${String(i).padStart(5, "0")}`, batchNo: `B${i % 10}`, remark: "备".repeat(700) })));
  const big5 = buildEnvelope("xiangtai", "M", fat(2300), () => "2026-10-12T03:00:00.000Z");
  const small5 = buildEnvelope("xiangtai", "M", fat(2150), () => "2026-10-12T03:00:00.000Z");
  assert.ok(Buffer.byteLength(JSON.stringify(big5)) > 5 * 1024 * 1024 && Buffer.byteLength(JSON.stringify(small5)) <= 5 * 1024 * 1024, "造的数据没跨过 5MB 边界");
  assert.match(envelopeProblem(big5)!, /5MB/);
  assert.equal(envelopeProblem(small5), null);
});

const ev = (over: Record<string, unknown> = {}) => ({
  eventId: "e1", protocolVersion: 2, companyId: "xiangtai", sourceShipmentId: "s_1", sequence: 3, status: "ARRIVED",
  occurredAt: "2026-10-12T03:00:00.000Z", waybillNo: "XT001-1", actualBoxCount: 3, shortage: false,
  parentWaybillNo: "XT001", sourceUpdatedAt: "2026-10-12T01:00:00.000Z", batchKey: "k", batchNo: "B1", containerNo: "M",
  ...over,
});

check("E1 回传校验：公司编号不对 409；版本 / 编号 / 序号 / 状态 / 时间不合格 400；认不得的字段（execution）不管", () => {
  assert.equal(parseChaipaiEvent(ev(), "xiangtai").ok, true);
  assert.equal(parseChaipaiEvent(ev({ execution: { status: "ON_HOLD", holdReason: "SHORTAGE", failureReason: null } }), "xiangtai").ok, true);
  const bad = (over: Record<string, unknown>) => parseChaipaiEvent(ev(over), "xiangtai");
  const r409 = bad({ companyId: "other" });
  assert.equal(!r409.ok && r409.status, 409);
  for (const over of [{ protocolVersion: 1 }, { eventId: "" }, { sourceShipmentId: "x".repeat(129) }, { sequence: 0 }, { sequence: 1.5 },
    { status: "LOST" }, { occurredAt: "2026-10-12 03:00:00" }, { occurredAt: "2026-10-12T03:00:00Z" }]) {
    const r = bad(over);
    assert.equal(!r.ok && r.status, 400, JSON.stringify(over));
  }
  assert.equal(parseChaipaiEvent(null, "xiangtai").ok, false);
});

check("E2 到仓件数选填：不带 / 格式不对当没带（不拒收）；只有 ARRIVED 才认", () => {
  const p = (over: Record<string, unknown>) => { const r = parseChaipaiEvent(ev(over), "xiangtai"); assert.ok(r.ok); return r.event; };
  assert.deepEqual([p({ actualBoxCount: undefined, shortage: undefined }).actualBoxCount, p({}).actualBoxCount], [null, 3]);
  assert.equal(p({ actualBoxCount: "3" }).actualBoxCount, null);
  assert.equal(p({ status: "LOADED" }).actualBoxCount, null);
  assert.equal(p({ shortage: true }).shortage, true);
});

check("E3 摘要跟字段先后无关；协议里认得的字段任一变了摘要就变（同一编号换内容回 409），认不得的扩展字段不算", () => {
  const hashOf = (raw: Record<string, unknown>) => { const r = parseChaipaiEvent(raw, "xiangtai"); assert.ok(r.ok); return eventHashOf(r.event); };
  const exec = { status: "ON_HOLD", holdReason: "SHORTAGE", failureReason: null };
  const base = hashOf(ev({ execution: exec }));
  // 键的先后（顶层和 execution 里面）不影响
  assert.equal(hashOf(Object.fromEntries(Object.entries(ev({ execution: { failureReason: null, holdReason: "SHORTAGE", status: "ON_HOLD" } })).reverse())), base);
  // 认不得的扩展字段不算
  assert.equal(hashOf(ev({ execution: exec, someFutureField: 1 })), base);
  for (const over of [{ sequence: 4 }, { batchNo: "changed" }, { waybillNo: "X" }, { parentWaybillNo: "X" }, { sourceUpdatedAt: "2026-10-12T02:00:00.000Z" },
    { batchKey: "k2" }, { containerNo: "M2" }, { execution: { ...exec, holdReason: "OVERAGE" } }]) {
    assert.notEqual(hashOf(ev({ execution: exec, ...over })), base, JSON.stringify(over));
  }
});

check("E4 目标状态（第 244、253 条）：已装车只在已到泰国仓之前才提上来、别的一律不动；派送中 / 签收后再来已到仓 = 拉回仓", () => {
  assert.deepEqual(planForEvent("ARRIVED", "unloading"), { targetStatus: "inWarehouseTH", isReturn: false });
  assert.deepEqual(planForEvent("ARRIVED", "deliveryBooked"), { targetStatus: "inWarehouseTH", isReturn: false });
  assert.deepEqual(planForEvent("ARRIVED", "outForDelivery"), { targetStatus: "inWarehouseTH", isReturn: true });
  assert.deepEqual(planForEvent("ARRIVED", "delivered"), { targetStatus: "inWarehouseTH", isReturn: true });
  assert.deepEqual(planForEvent("LOADED", "customsCleared"), { targetStatus: "inWarehouseTH", isReturn: false });
  assert.deepEqual(planForEvent("LOADED", "departed"), { targetStatus: "inWarehouseTH", isReturn: false });
  assert.deepEqual(planForEvent("LOADED", "inWarehouseTH"), { targetStatus: "inWarehouseTH", isReturn: false });
  assert.deepEqual(planForEvent("LOADED", "deliveryBooked"), { targetStatus: "deliveryBooked", isReturn: false });
  // 已经在泰国段（含派送中、已签收）收到已装车一律不动，不当成拉回仓（修改清单表格「否则不变」）
  assert.deepEqual(planForEvent("LOADED", "outForDelivery"), { targetStatus: "outForDelivery", isReturn: false });
  assert.deepEqual(planForEvent("LOADED", "delivered"), { targetStatus: "delivered", isReturn: false });
  assert.deepEqual(planForEvent("OUT_FOR_DELIVERY", "unloading"), { targetStatus: "outForDelivery", isReturn: false });
  assert.deepEqual(planForEvent("DELIVERED", "inWarehouseTH"), { targetStatus: "delivered", isReturn: false });
});

check("E5 轨迹备注不出现「拆派仓」（第 255 条）；司机没名字不写「司机【】」；转交写对方物流和单号", () => {
  const all = [
    arrivedRemark(null, null), arrivedRemark(3, false), arrivedRemark(2, true),
    departRemark({ driverName: "张三", deliveryNo: "WD000001", handoverCarrier: null, handoverTrackingNo: null }),
    departRemark({ driverName: "", deliveryNo: "WD000001", handoverCarrier: null, handoverTrackingNo: null }),
    departRemark({ driverName: "", deliveryNo: "WD000001", handoverCarrier: "Kerry", handoverTrackingNo: "K123" }),
  ];
  assert.deepEqual(all, [
    "已到泰国仓", "已到泰国仓，实到 3 件", "已到泰国仓，实到 2 件（少件）",
    "司机【张三】正在为您派送，请注意查收", "正在为您派送，请注意查收（WD000001）", "已交给【Kerry】派送，单号 K123，请注意查收",
  ]);
  const src = read("apps/api/src/modules/chaipai/events.ts");
  // 只看代码不看注释（注释里会提到「不出现拆派仓」这句规矩本身）
  const remarkCode = src.slice(src.indexOf("export function arrivedRemark"), src.indexOf("export function bangkokDate"))
    .split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
  assert.ok(remarkCode.includes("已到泰国仓") && !remarkCode.includes("拆派仓"), "备注模板里出现了「拆派仓」");
});

check("E6 派送日期按曼谷时间取日子；签收图取签收前最新一张（都在之后就取最新）", () => {
  assert.equal(bangkokDate("2026-10-11T17:30:00.000Z", "2000-01-01T00:00:00.000Z"), "2026-10-12");
  assert.equal(bangkokDate("2026-10-11T16:59:00.000Z", "2000-01-01T00:00:00.000Z"), "2026-10-11");
  // 出发时间认不出来 / 没有：用回传时间，不炸
  assert.equal(bangkokDate("not-a-date", "2026-10-11T17:30:00.000Z"), "2026-10-12");
  assert.equal(bangkokDate(null, "2026-10-11T17:30:00.000Z"), "2026-10-12");
  const photos = [
    { id: "b", createdAt: "2026-10-12T02:00:00.000Z" },
    { id: "a", createdAt: "2026-10-12T03:30:00.000Z" },
    { id: "c", createdAt: "2026-10-12T02:59:00.000Z" },
  ];
  assert.equal(pickSignPhoto(photos, "2026-10-12T03:00:00.000Z"), "c");
  assert.equal(pickSignPhoto(photos, "2026-10-12T01:00:00.000Z"), "a");
  assert.equal(pickSignPhoto([], "2026-10-12T03:00:00.000Z"), null);
});

check("W1 拆派仓写的轨迹不许单删（第 254 条）：已到仓 / 已装车 sl_cp_ 新原因，派送那几条走尾端派送的老规矩", () => {
  const r = (id: string, from = "inWarehouseTH", to = "inWarehouseTH") => deleteBlockedReasonOf({ id, fromStatus: from, toStatus: to }, "delivered", 1);
  assert.equal(r("sl_cp_1"), "chaipai");
  assert.equal(r("sl_cp_2", "unloading", "inWarehouseTH"), "chaipai");
  assert.equal(r("sl_lm_cp_1"), "lastmile");
  assert.equal(r("sl_lmdel_cp_1"), "lastmile");
  assert.equal(r("sl_lmunsign_cp_1"), "lastmile");
  assert.equal(r("sl_manual_1"), null);
  const routes = read("apps/api/src/modules/shipments/routes.ts");
  assert.match(routes, /blockedReason === "chaipai"\s*\?\s*CHAIPAI_LOG_MESSAGE/);
  const modal = read("apps/web/src/modules/shipment/ShipmentTrackModal.tsx");
  assert.match(modal, /chaipai: "拆派仓同步的记录，不能单删"/);
});

check("W2 接线：只有拆派仓那三条精确路径不跑登录解析；Next 原样转发；代理前缀保留 integrations；三个接口都注册了", () => {
  assert.match(read("apps/api/src/server.ts"), /auth: INTEGRATION_PATHS\.has\(path\) \? undefined : await parseAuth/);
  assert.deepEqual([...INTEGRATION_PATHS].sort(), [
    "/integrations/chaipai/v2/container-manifest", "/integrations/chaipai/v2/events", "/integrations/chaipai/v2/waybill-manifest",
  ]);
  assert.match(read("apps/web/next.config.ts"), /source: "\/integrations\/:path\*", destination: `\$\{API_PROXY_TARGET\}\/integrations\/:path\*`/);
  assert.ok(RESERVED_AGENT_SLUGS.has("integrations"));
  assert.match(read("apps/api/src/main.ts"), /registerChaipaiRoutes\(app\)/);
  const routes = read("apps/api/src/modules/chaipai/routes.ts");
  for (const fn of ["registerChaipaiManifestRoutes", "registerChaipaiEventRoutes", "registerChaipaiPhotoRoutes"]) assert.ok(routes.includes(`${fn}(app)`), fn);
});

check("W2b 拉清单的事务第一句就是同柜排队锁（删了这句静态锁扫描看不见，这里点名查）", () => {
  const src = read("apps/api/src/modules/chaipai/manifest-routes.ts");
  assert.match(src, /await prisma\.\$transaction\(async \(tx\) => \{\n\s*await lockChaipaiManifest\(tx, container\.id\);/);
  assert.match(src, /async function lockChaipaiManifest\(tx: any, containerId: string\): Promise<void> \{\n\s*await tx\.\$executeRaw`SELECT pg_advisory_xact_lock\(83060, hashtext\(\$\{containerId\}\)\)`;/);
});

check("W2c 按运单号取票（10-13）：先按这几票挂过的柜子排好序一个一个排队，再重读；跟按柜拉同一把锁、同一份取数代码", () => {
  const src = read("apps/api/src/modules/chaipai/manifest-routes.ts");
  // 总截止时间：每句碰数据库的语句之前都把 statement_timeout / lock_timeout 改成离截止还剩多少（Codex 10-13 第 3 轮）
  assert.match(src, /const deadline = Date\.now\(\) \+ 4500;\n\s*const guard = async \(\) => \{\n\s*const ms = String\(Math\.max\(50, deadline - Date\.now\(\)\)\);\n\s*await tx\.\$executeRaw`SELECT set_config\('statement_timeout', \$\{ms\}, true\), set_config\('lock_timeout', \$\{ms\}, true\)`;\n\s*\};\n\s*await guard\(\);\n\s*const candidates: Candidate\[\] = await findCandidates\(tx\);/);
  assert.match(src, /for \(const id of \[\.\.\.lockIds\]\.sort\(\)\) \{\n\s*await guard\(\);\n\s*await lockChaipaiManifest\(tx, id\);\n\s*\}\n\s*const snap = await readSnapshot\(tx, lockIds, guard\);/);
  assert.match(src, /const readSnapshot = async \(tx: any, lockIds: string\[\], guard: \(\) => Promise<void>\): Promise<Snapshot> => \{\n\s*await guard\(\);\n\s*const fresh: Candidate\[\] = await findCandidates\(tx\);/);
  assert.match(src, /\n\s*await guard\(\);\n\s*const items = await tx\.shipmentContainerItem\.findMany\(\{\n\s*where: \{ shipmentId: \{ in: fresh\.map/);
  assert.match(src, /const nowIso = new Date\(\)\.toISOString\(\);\n\s*await guard\?\.\(\);\n\s*await tx\.\$executeRaw`\n\s*INSERT INTO chaipai_manifest_versions/);
  // 产品名排序写死（sortOrder 可重复），前后两次读拼出来的品名才一样（dsh / Codex 10-13 第 3 轮）
  assert.match(src, /products: \{ select: \{ itemName: true, sortOrder: true \}, orderBy: \[\{ sortOrder: "asc" \}, \{ id: "asc" \}\]/);
  assert.match(src, /const lockIds = \[\.\.\.new Set\(candidates\.flatMap\(\(c\) => c\.containerItems\.map\(\(i\) => i\.containerId\)\)\)\]\.sort\(\);/);
  // 两条路都用 MANIFEST_SHIPMENT_SELECT + sourceRowOf，不各抄一份
  assert.equal((src.match(/shipment: \{ select: MANIFEST_SHIPMENT_SELECT \}/g) ?? []).length, 2);
  assert.equal((src.match(/sourceRowOf\(item\)/g) ?? []).length, 2);
  // 被挪柜、事务超时、序列化冲突都回 503 让拆派仓再扫（拆派仓只认 200 / 404 / 401，别的当连不上）；拆派仓等约 8 秒
  assert.match(src, /if \(error instanceof ScanAgainError \|\| code === "P2028" \|\| code === "P2034" \|\| code === "P2024" \|\| isDbTimeout\(error\)\) \{[\s\S]{0,300}fail\(res, 503, "INTERNAL_ERROR", "正忙，请稍后再扫一次"\);/);
  // 版本写下以后、提交以前原样再读一遍、比「挂的柜 + 内容摘要」（Codex 10-13 两轮）
  assert.match(src, /const versions = await versionsFor\(tx, snap\.groups, guard\);\n(\s*\/\/[^\n]*\n)*\s*if \(\(await readSnapshot\(tx, lockIds, guard\)\)\.signature !== snap\.signature\) throw new ScanAgainError\(\);\n\s*return \{ picked: snap\.picked/);
  assert.match(src, /signature: `\$\{placement\}\|\$\{hashes\}`/);
  assert.match(src, /if \(items\.some\(\(it: \{ containerId: string \}\) => !lockIds\.includes\(it\.containerId\)\)\) throw new ScanAgainError\(\);/);
  // 拿锁后重读那一道（DB 用例 N8 里它跟上面那道互相兜，单删一道 N8 不红，这里点名查；dsh 10-13 第 2 轮）
  assert.match(src, /if \(fresh\.some\(\(c\) => c\.containerItems\.some\(\(i\) => !lockIds\.includes\(i\.containerId\)\)\)\) throw new ScanAgainError\(\);/);
  // 200 上限在写版本之前挡（不白写几百行版本）
  assert.match(src, /if \(snap\.picked\.length > WAYBILL_MAX_SHIPMENTS\) return \{ tooMany: snap\.picked\.length \};\n\s*const versions = await versionsFor\(tx,/);
  assert.match(src, /\}, \{ timeout: 5500, maxWait: 500, isolationLevel: Prisma\.TransactionIsolationLevel\.ReadCommitted \}\);/);
});

check("W3 派送照片只给员工 / 管理员（第 256 条）：后端 requireRole staff/admin；弹窗只在员工 / 管理员打开时挂", () => {
  const photo = read("apps/api/src/modules/chaipai/photo-routes.ts");
  assert.equal((photo.match(/requireRole\(req, res, \["staff", "admin"\]\)/g) ?? []).length, 2);
  assert.match(photo, /app\.get\("\/staff\/shipments\/chaipai-photos"/);
  const modal = read("apps/web/src/modules/shipment/ShipmentTrackModal.tsx");
  assert.match(modal, /const canEditTimeline = data\.viewerRole === "staff" \|\| data\.viewerRole === "admin";/);
  assert.match(modal, /\{canEditTimeline \? <ChaipaiPhotos key=\{tab\.trackingNo\} trackingNo=\{tab\.trackingNo\}/);
  assert.match(read("apps/web/src/modules/shipment/ChaipaiPhotos.tsx"), /派送照片/);
});

check("W4 六个环境变量：两份样板都有、docker-compose 透传、前端代码里一个都没有", () => {
  const names = ["CHAIPAI_ENABLED", "CHAIPAI_COMPANY_ID", "CHAIPAI_PULL_SECRET", "CHAIPAI_CALLBACK_SECRET", "CHAIPAI_READ_SECRET", "CHAIPAI_API_BASE"];
  for (const f of [".env.example", "env.example"]) for (const n of names) assert.match(read(f), new RegExp(`^${n}=$`, "m"), `${f} 缺 ${n}`);
  for (const n of names) assert.ok(read("docker-compose.yml").includes(`${n}: \${${n}:-}`), `compose 缺 ${n}`);
  let hits = "";
  try { hits = execFileSync("grep", ["-rln", "CHAIPAI_", path.join(ROOT, "apps/web/src")], { encoding: "utf8" }).trim(); }
  catch (e: any) { if (e.status !== 1) throw e; } // grep 没找到时退出码 1
  assert.equal(hits, "", `前端出现了密钥变量：${hits}`);
});

check("M9 按运单号取票的入参和信封（10-13）：只去首尾空格、不改大小写；控制字符 / 超长 / 空的不收；顶层 waybillNo，每份带自己的柜号", () => {
  assert.equal(validWaybillNoInput("  GZ260902267-1 "), "GZ260902267-1");
  assert.equal(validWaybillNoInput("gz260902267-1"), "gz260902267-1");
  assert.equal(validWaybillNoInput("GZ 2609"), "GZ 2609");
  for (const bad of [undefined, null, 5, "", "   ", "A\nB", "A\u0085B", "x".repeat(129)]) assert.equal(validWaybillNoInput(bad), null, JSON.stringify(bad));
  assert.equal(validWaybillNoInput("x".repeat(128)), "x".repeat(128));
  const batches = planBatches("xiangtai", "ctr_1", [row({ shipmentId: "s_k1", trackingNo: "P1-1", parentTrackingNo: "P1" })]);
  const parts = manifestParts("xiangtai", "CTN-A", batches, () => "2026-10-13T00:00:00.000Z");
  const env = { protocolVersion: 2 as const, companyId: "xiangtai", waybillNo: " P1 ", manifests: parts };
  assert.equal(envelopeProblem(env), null);
  assert.deepEqual([parts[0].containerNo, parts[0].batchKey, parts[0].shipments[0].parentWaybillNo], ["CTN-A", batchKeyOf("xiangtai", "ctr_1", row().batchNo), "P1"]);
  // 同一票、同一柜：按运单号取和按柜拉出来的 batchKey、内容摘要一模一样（拆派仓里进同一个批次、版本不乱跳）
  const viaContainer = buildEnvelope("xiangtai", "CTN-A", batches, () => "2026-10-13T00:00:00.000Z");
  assert.deepEqual(viaContainer.manifests, parts);
  assert.match(envelopeProblem({ ...env, waybillNo: "A\u0001" }) ?? "", /运单号/);
  assert.match(envelopeProblem({ ...env, manifests: [{ ...parts[0], containerNo: "C\u0002" }] }) ?? "", /柜号/);
  // 拆派仓按单号取票一次最多 200 票：200 放行、201 挡（按柜拉仍是 5000）
  const many = (n: number) => [{ ...parts[0], shipments: Array.from({ length: n }, (_, i) => ({ ...parts[0].shipments[0], sourceShipmentId: `s_${i}` })) }];
  assert.equal(envelopeProblem({ ...env, manifests: many(200) }), null);
  assert.match(envelopeProblem({ ...env, manifests: many(201) }) ?? "", /超过 200/);
  assert.equal(envelopeProblem({ ...viaContainer, manifests: many(201) }), null);
});

console.log(`\n通过 ${passed} / 失败 ${failed}`);
if (failed > 0) process.exit(1);
