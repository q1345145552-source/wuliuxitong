/**
 * 放货时查财务系统2 扣货名单：不连库的部分（2026-11-19，第 9 期）。
 *
 * ① 开关和配置（老板 2026-11-19 定）：不填时配了地址 / 密钥按 observe、都没配是 off；明确写 off 才关；不认识的词按 enforce；
 *    开着时密钥 / 地址配错照本地名单拦；生产只认 https；地址自己拼 /integrations/logistics/v1
 * ② 解析财务系统2 的返回（约定 5.1、5.2 的样例原样能收；时间不带时区、数字当唛头、blocked 不是布尔一律当失败）
 * ③ 真起一个假财务系统2：密钥在请求头不在地址里；401 不重试、5xx 能重试；超时按时断开
 * ④ 提示的话：【扣货】开头、带唛头和「按几点（泰国时间）的名单」、不带「派送中」（前端见到会当改派）
 * ⑤ 放货入口：后端里会把运单写成 deliveryBooked / outForDelivery 的地方逐个钉住，每处都过了扣货判断；
 *    按「写死字面量」「data: { currentStatus: 变量 }」「xx.currentStatus = 值」三种常见写法扫，新加这三种写法会红。
 *    ⚠️ 扫不到所有写法（多行对象、展开、currentStatus 不在第一个键……），不能代替改代码时自己想「这里会不会把货放出去」
 * ⑥ 前端：拦货报错时通知「扣货名单」那一块；装柜管理、尾端派送都放了这一块；试运行记录只给管理员看
 * ⑦ 扣货上报（约定 11.2，老板 11-19 答「放货拦截 6」）：请求体字段和请求头对着约定、4xx 不重试、5xx / 连不上 / 超时下一轮再报；
 *    拆派仓派出去的（11.1）物流不报（财务拉运单时自己报警，ADR 0142）
 * 用法：npm run test:finance2-holds-source
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { readFinance2HoldsConfig } from "../apps/api/src/modules/finance2-holds/config";
import { checkHold, fetchHoldList, parseHoldCheck, parseHoldList, postHoldEvent, zonedTime } from "../apps/api/src/modules/finance2-holds/client";
import { safeReason } from "../apps/api/src/modules/finance2-holds/reports";
import { heldByRules, heldMessage, listLabel, noticeFor, NO_LIST_NOTICE, motherOf } from "../apps/api/src/modules/finance2-holds/gate";

const ROOT = path.join(__dirname, "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const SECRET = "F1n2Hold-aB3dE5gH7jK9mN1pQ3sT5vXyZ";

let failures = 0;
let passes = 0;
async function test(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passes++;
    console.log(`  ✅ ${label}`);
  } catch (e) {
    failures++;
    console.log(`  ❌ ${label}\n     ${e instanceof Error ? e.message.split("\n").slice(0, 10).join("\n     ") : String(e)}`);
  }
}

/** 约定 5.1 原样 */
const SAMPLE_LIST = {
  serverTime: "2026-12-05T10:15:02+07:00",
  generatedAt: "2026-12-05T10:15:00+07:00",
  holds: [
    { customerMark: "10086", heldSince: "2026-12-03T00:00:00+07:00" },
    { customerMark: "20231", heldSince: "2026-12-04T10:30:00+07:00" },
  ],
  releasedWaybills: [{ waybillNo: "XT2611100045", customerMark: "20231", releasedAt: "2026-12-04T15:20:00+07:00" }],
};
/** 约定 5.2 原样 */
const SAMPLE_CHECK = { serverTime: "2026-12-05T10:21:40+07:00", customerMark: "10086", waybillNo: "XT2611180001", blocked: true, checkedAt: "2026-12-05T10:21:40+07:00" };

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

async function main(): Promise<void> {
  console.log("\n【① 开关和配置】");
  const good = { FINANCE2_HOLDS_MODE: "enforce", FINANCE2_HOLDS_SECRET: SECRET, FINANCE2_API_BASE: "https://caiwu.example.com/" } as NodeJS.ProcessEnv;
  await test("K1 填 off 才是关（配了地址密钥也关）；填了不认识的词按 enforce（宁可多拦）并说原因（老板 2026-11-19 答「放货拦截 5」）", () => {
    assert.equal(readFinance2HoldsConfig({} as NodeJS.ProcessEnv).ok, false);
    const off = readFinance2HoldsConfig({ ...good, FINANCE2_HOLDS_MODE: "off" });
    assert.equal(off.ok, false);
    assert.equal(readFinance2HoldsConfig({ ...good, FINANCE2_HOLDS_MODE: " off " }).ok, false, "前后空格照认");
    const bad = readFinance2HoldsConfig({ ...good, FINANCE2_HOLDS_MODE: "on" });
    assert.ok(bad.ok);
    assert.equal(bad.ok && bad.cfg.mode, "enforce");
    assert.match(bad.ok ? bad.cfg.problem ?? "" : "", /只认 off \/ observe \/ enforce/);
  });
  await test("K1b 开关不填（老板 2026-11-19 答「放货拦截 4」：默认先只记不拦）：地址、密钥至少配了一个 → observe；两个都没配 / 只有空白 → off", () => {
    const blank = { ...good, FINANCE2_HOLDS_MODE: "" };
    for (const env of [blank, { ...good, FINANCE2_HOLDS_MODE: undefined }, { ...good, FINANCE2_HOLDS_MODE: "  " }]) {
      const r = readFinance2HoldsConfig(env as NodeJS.ProcessEnv);
      assert.ok(r.ok, "配了地址和密钥、开关不填 = observe，不是关");
      assert.equal(r.ok && r.cfg.mode, "observe");
      assert.equal(r.ok && r.cfg.problem, null);
      assert.ok(r.ok && r.cfg.remote);
    }
    // 只配了一个：照样 observe（照本地名单「只记」，页面提示配置有问题）
    const onlySecret = readFinance2HoldsConfig({ FINANCE2_HOLDS_SECRET: SECRET } as NodeJS.ProcessEnv);
    assert.ok(onlySecret.ok && onlySecret.cfg.mode === "observe" && onlySecret.cfg.remote === null);
    assert.match(onlySecret.ok ? onlySecret.cfg.problem ?? "" : "", /FINANCE2_API_BASE 不对/);
    const onlyBase = readFinance2HoldsConfig({ FINANCE2_API_BASE: "https://caiwu.example.com" } as NodeJS.ProcessEnv);
    assert.ok(onlyBase.ok && onlyBase.cfg.mode === "observe" && onlyBase.cfg.remote === null);
    assert.match(onlyBase.ok ? onlyBase.cfg.problem ?? "" : "", /FINANCE2_HOLDS_SECRET 不合格/);
    // 两个都没配（docker-compose 透传进来是空串）/ 只有空白：关
    for (const env of [{}, { FINANCE2_HOLDS_MODE: "", FINANCE2_HOLDS_SECRET: "", FINANCE2_API_BASE: "" }, { FINANCE2_HOLDS_SECRET: "  ", FINANCE2_API_BASE: " " }]) {
      assert.equal(readFinance2HoldsConfig(env as NodeJS.ProcessEnv).ok, false, JSON.stringify(env));
    }
  });
  await test("K2 observe / enforce 开；地址去掉结尾 / 拼上 /integrations/logistics/v1；配置没问题时 problem 为空", () => {
    for (const mode of ["observe", "enforce"]) {
      const r = readFinance2HoldsConfig({ ...good, FINANCE2_HOLDS_MODE: mode });
      assert.ok(r.ok);
      assert.equal(r.ok && r.cfg.mode, mode);
      assert.equal(r.ok && r.cfg.remote?.apiBase, "https://caiwu.example.com/integrations/logistics/v1");
      assert.equal(r.ok && r.cfg.problem, null);
    }
  });
  await test("K3 开着但密钥 / 地址配错：**开关照开**（照本地名单拦），只是连不了财务、说清哪里错（Codex 审查第 1 条）", () => {
    const remoteOf = (env: NodeJS.ProcessEnv) => {
      const r = readFinance2HoldsConfig(env);
      assert.ok(r.ok, "配错不许变成关");
      return r.ok ? r.cfg : null;
    };
    for (const secret of ["short", "change-me-change-me-change-me-change-me", ` ${SECRET}`, undefined]) {
      const c = remoteOf({ ...good, FINANCE2_HOLDS_SECRET: secret });
      assert.equal(c?.remote, null, String(secret));
      assert.match(c?.problem ?? "", /FINANCE2_HOLDS_SECRET 不合格/);
      assert.equal(c?.mode, "enforce");
    }
    assert.equal(remoteOf({ ...good, FINANCE2_API_BASE: "http://127.0.0.1:4000", NODE_ENV: "production" })?.remote, null);
    assert.ok(remoteOf({ ...good, FINANCE2_API_BASE: "http://127.0.0.1:4000" })?.remote);
    assert.equal(remoteOf({ ...good, FINANCE2_API_BASE: "http://10.0.0.5:4000" })?.remote, null);
    for (const base of ["https://a.com/?x=1", "https://a.com/#x", "https://u:p@a.com", "ftp://a.com", ""]) {
      const c = remoteOf({ ...good, FINANCE2_API_BASE: base });
      assert.equal(c?.remote, null, base);
      assert.match(c?.problem ?? "", /FINANCE2_API_BASE 不对/);
    }
    // 配置问题里不许带密钥
    assert.ok(!(remoteOf({ ...good, FINANCE2_API_BASE: "" })?.problem ?? "").includes(SECRET));
  });

  console.log("\n【② 解析返回】");
  await test("P1 约定 5.1 的样例原样能收", () => {
    const r = parseHoldList(SAMPLE_LIST);
    assert.ok(typeof r !== "string", String(r));
    if (typeof r === "string") return;
    assert.equal(r.generatedAt.toISOString(), "2026-12-05T03:15:00.000Z");
    assert.deepEqual(r.holds.map((h) => h.customerMark), ["10086", "20231"]);
    assert.deepEqual(r.releasedWaybills.map((x) => x.waybillNo), ["XT2611100045"]);
  });
  await test("P2 坏数据整份不收：时间不带时区 / 唛头是数字 / 少数组 / 唛头带空白 / 不是对象", () => {
    const bads: unknown[] = [
      { ...SAMPLE_LIST, generatedAt: "2026-12-05T10:15:00" },
      { ...SAMPLE_LIST, generatedAt: 1764900900000 },
      { ...SAMPLE_LIST, holds: [{ customerMark: 10086, heldSince: "2026-12-03T00:00:00+07:00" }] },
      { ...SAMPLE_LIST, holds: [{ customerMark: " 10086", heldSince: "2026-12-03T00:00:00+07:00" }] },
      { ...SAMPLE_LIST, holds: [{ customerMark: "10086" }] },
      { ...SAMPLE_LIST, releasedWaybills: undefined },
      { ...SAMPLE_LIST, holds: {} },
      [], null, "x",
    ];
    for (const b of bads) assert.equal(typeof parseHoldList(b), "string", JSON.stringify(b));
  });
  await test("P3 同一个唛头出现两次：只留一条（取早的上名单时间）；空名单可以（= 谁都不扣）", () => {
    const r = parseHoldList({ ...SAMPLE_LIST, holds: [...SAMPLE_LIST.holds, { customerMark: "10086", heldSince: "2026-12-01T00:00:00Z" }] });
    assert.ok(typeof r !== "string");
    if (typeof r === "string") return;
    assert.equal(r.holds.length, 2);
    assert.equal(r.holds.find((h) => h.customerMark === "10086")!.heldSince.toISOString(), "2026-12-01T00:00:00.000Z");
    const empty = parseHoldList({ ...SAMPLE_LIST, holds: [], releasedWaybills: [] });
    assert.ok(typeof empty !== "string");
  });
  await test("P4 约定 5.2 样例能收；blocked 不是布尔 / 回的唛头或运单号跟问的不一样 → 失败", () => {
    const ok = parseHoldCheck(SAMPLE_CHECK, "10086", "XT2611180001");
    assert.ok(typeof ok !== "string" && ok.blocked === true);
    assert.equal(typeof parseHoldCheck({ ...SAMPLE_CHECK, blocked: "false" }, "10086", "XT2611180001"), "string");
    assert.equal(typeof parseHoldCheck({ ...SAMPLE_CHECK, blocked: 0 }, "10086", "XT2611180001"), "string");
    assert.equal(typeof parseHoldCheck(SAMPLE_CHECK, "20231", "XT2611180001"), "string");
    assert.equal(typeof parseHoldCheck(SAMPLE_CHECK, "10086", "XT0000000000"), "string");
    const noWaybill = parseHoldCheck({ ...SAMPLE_CHECK, waybillNo: null, blocked: false }, "10086", null);
    assert.ok(typeof noWaybill !== "string" && noWaybill.blocked === false);
  });
  await test("P4b 核对时间要可靠（Codex 审查第 6 条）：checkedAt 不带时区 / 两个时间都没有 → 失败；只问唛头回来却带了运单号 → 失败", () => {
    assert.equal(typeof parseHoldCheck({ ...SAMPLE_CHECK, checkedAt: "2026-12-05T10:21:40" }, "10086", "XT2611180001"), "string");
    const { checkedAt: _c, serverTime: _s, ...noTimes } = SAMPLE_CHECK;
    assert.equal(typeof parseHoldCheck(noTimes, "10086", "XT2611180001"), "string");
    const onlyServer = parseHoldCheck({ ...noTimes, serverTime: "2026-12-05T10:21:40+07:00" }, "10086", "XT2611180001");
    assert.ok(typeof onlyServer !== "string" && onlyServer.checkedAt.toISOString() === "2026-12-05T03:21:40.000Z");
    assert.equal(typeof parseHoldCheck({ ...SAMPLE_CHECK, blocked: false }, "10086", null), "string", "只问唛头，回的带着 XT2611180001");
  });
  await test("P6 判断规则（heldByRules）：整家看最新核对、没核对看名单；这一票看最新核对、没核对看单票放行", () => {
    const H = (onList: boolean, released: boolean, markDecision: boolean | null, ticketDecision: boolean | null) => heldByRules({ onList, released, markDecision, ticketDecision });
    assert.equal(H(false, false, null, null), false, "不在名单");
    assert.equal(H(true, false, null, null), true, "在名单");
    assert.equal(H(true, true, null, null), false, "单票放行");
    assert.equal(H(true, false, false, null), false, "核对说整家不扣");
    assert.equal(H(false, false, true, null), true, "名单上没有，但刚核对说扣（财务刚加上）");
    assert.equal(H(true, false, true, false), false, "整家扣、这一票核对说放");
    assert.equal(H(true, true, true, true), true, "名单说单放，但更新的核对说这一票还扣（老板撤了单放）");
    assert.equal(H(true, true, false, true), false, "整家都不扣了，这一票的旧答案不算");
  });
  await test("P5 时间：Z 和 +07:00 都认；不带时区、乱写不认", () => {
    assert.equal(zonedTime("2026-11-18T07:05:00.000Z")!.toISOString(), "2026-11-18T07:05:00.000Z");
    assert.equal(zonedTime("2026-11-18T14:05:00+07:00")!.toISOString(), "2026-11-18T07:05:00.000Z");
    for (const v of ["2026-11-18T14:05:00", "2026-11-18", "昨天", 1, null]) assert.equal(zonedTime(v), null, String(v));
  });

  console.log("\n【③ 真发请求（本机假财务系统2）】");
  const seen: Array<{ url: string; auth: string | undefined }> = [];
  let reply: { status: number; body: string; delayMs?: number } = { status: 200, body: JSON.stringify(SAMPLE_LIST) };
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", auth: req.headers.authorization });
    const send = () => { if (!res.destroyed) { res.writeHead(reply.status, { "content-type": "application/json" }); res.end(reply.body); } };
    if (reply.delayMs) setTimeout(send, reply.delayMs); else send();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const cfg = { mode: "enforce" as const, secret: SECRET, apiBase: `http://127.0.0.1:${(server.address() as AddressInfo).port}/integrations/logistics/v1` };
  try {
    await test("H1 取名单：GET …/holds，密钥在 Authorization 头、不在地址里", async () => {
      const r = await fetchHoldList(cfg);
      assert.equal(r.kind, "ok");
      assert.equal(seen.at(-1)!.url, "/integrations/logistics/v1/holds");
      assert.equal(seen.at(-1)!.auth, `Bearer ${SECRET}`);
      assert.ok(!seen.at(-1)!.url.includes(SECRET));
    });
    await test("H2 核对：GET …/holds/check?customerMark=…&waybillNo=…（唛头里的特殊字符编码好）", async () => {
      reply = { status: 200, body: JSON.stringify({ ...SAMPLE_CHECK, customerMark: "A&B 1", blocked: false }) };
      const r = await checkHold(cfg, "A&B 1", "XT2611180001");
      assert.equal(r.kind, "ok");
      assert.equal(seen.at(-1)!.url, "/integrations/logistics/v1/holds/check?customerMark=A%26B+1&waybillNo=XT2611180001");
    });
    await test("H3 401 / 403 / 400 不重试，5xx / 429 可以重试（429 带 Retry-After）", async () => {
      for (const [status, retryable] of [[401, false], [403, false], [400, false], [500, true], [503, true], [429, true]] as const) {
        reply = { status, body: "{}" };
        const r = await fetchHoldList(cfg);
        assert.equal(r.kind, "error");
        assert.equal(r.kind === "error" && r.retryable, retryable, String(status));
      }
    });
    await test("H4 超时按时断开（不挂到 300 秒）", async () => {
      reply = { status: 200, body: JSON.stringify(SAMPLE_LIST), delayMs: 3000 };
      const t0 = Date.now();
      const r = await fetchHoldList(cfg, 300);
      assert.equal(r.kind === "error" && r.reason, "超时");
      assert.ok(Date.now() - t0 < 1500);
    });
    await test("H5 不是 JSON / 格式不对 → 失败、不重试", async () => {
      reply = { status: 200, body: "<html>" };
      const r = await fetchHoldList(cfg);
      assert.equal(r.kind === "error" && r.retryable, false);
      reply = { status: 200, body: JSON.stringify({ ...SAMPLE_LIST, generatedAt: "2026-12-05 10:15" }) };
      const r2 = await fetchHoldList(cfg);
      assert.equal(r2.kind === "error" && r2.retryable, false);
    });
  } finally {
    server.close();
  }

  console.log("\n【④ 提示的话】");
  const gen = new Date("2026-12-05T03:15:00Z");
  await test("M1 拦货的话：【扣货】开头、带唛头和运单号、写「按 2026-12-05 10:15（泰国时间）的名单」、没有「派送中」", () => {
    const one = heldMessage([{ trackingNo: "XT1", motherTrackingNo: "XT1", customerMark: "10086" }], gen);
    assert.ok(one.startsWith("【扣货】这家客户有欠款，放货前请联系财务"), one);
    assert.ok(one.includes("10086（XT1）"));
    assert.ok(one.includes("按 2026-12-05 10:15（泰国时间）的名单"));
    assert.ok(!one.includes("派送中"));
    const two = heldMessage([
      { trackingNo: "XT1", motherTrackingNo: "XT1", customerMark: "10086" },
      { trackingNo: "XT2-1", motherTrackingNo: "XT2", customerMark: "10086" },
      { trackingNo: "XT3", motherTrackingNo: "XT3", customerMark: "20231" },
    ], gen, "这几票没跟着推");
    assert.ok(two.includes("这几家客户有欠款"));
    assert.ok(two.includes("10086（XT1、XT2-1）；20231（XT3）"));
    assert.ok(!two.includes("派送中"));
  });
  await test("M2 提示：没有名单 / 超过 1 天 / 正常", () => {
    const now = new Date("2026-12-06T03:15:00Z");
    assert.equal(noticeFor(null, now), NO_LIST_NOTICE);
    assert.match(NO_LIST_NOTICE, /现在没有扣货名单/);
    assert.equal(noticeFor(new Date(now.getTime() - 23 * 3600_000), now), null);
    assert.match(noticeFor(new Date(now.getTime() - 25 * 3600_000), now)!, /超过 1 天没更新/);
    assert.equal(listLabel(gen), "按 2026-12-05 10:15（泰国时间）的名单");
  });
  await test("M3 子单按母运单号认（单票放行、重新核对都按母单）", () => {
    assert.equal(motherOf({ trackingNo: "XT2-1", parentTrackingNo: "XT2" }), "XT2");
    assert.equal(motherOf({ trackingNo: "XT2", parentTrackingNo: null }), "XT2");
  });

  console.log("\n【⑤ 放货入口一处不漏】");
  /**
   * 后端里所有「把运单状态写成 deliveryBooked / outForDelivery」的地方（2026-11-19 子代理逐处读过，见 docs/sessions/2026-11-19-finance2-holds.md）：
   *   containers/routes.ts      柜子推进：currentStatus: shipmentNextStatus（DELIVERY_BOOKED → deliveryBooked）→ 被扣的不推
   *   loading-manifests/routes  往预约派送的柜子加货：currentStatus: finalStatus → 整个不装
   *   admin-ops/routes.ts       尾端派送出车：currentStatus: "outForDelivery"（第 1 处）→ 整车不建
   *                             撤销误签收：currentStatus: "outForDelivery"（第 2 处）→ 不拦（货当时已经出车了，只是纠正点错的签收）
   *   chaipai/event-routes.ts   拆派仓回传派送中：currentStatus: status → 照收、记一笔（接口⑧）
   *   shipments/parent-status   父单跟着子单走：子单拦住了父单就到不了，不另拦
   */
  const apiFiles = walk(path.join(ROOT, "apps/api/src"));
  await test("E1 写死 \"outForDelivery\" / \"deliveryBooked\" 当运单状态的只有 admin-ops 那两处（多一处就红：去想要不要拦）", () => {
    const hits: string[] = [];
    for (const f of apiFiles) {
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((l, i) => {
        if (/currentStatus:\s*["'](outForDelivery|deliveryBooked)["']/.test(l) && /update|data/.test(l)) hits.push(`${path.relative(ROOT, f)}:${i + 1}`);
      });
    }
    assert.equal(hits.length, 2, hits.join("\n"));
    assert.ok(hits.every((h) => h.startsWith("apps/api/src/modules/admin-ops/routes.ts:")), hits.join("\n"));
  });
  await test("E2 拿变量写运单状态的地方就这几处（新增就红：看看那个变量会不会是这两个状态）", () => {
    const hits: string[] = [];
    for (const f of apiFiles) {
      for (const m of readFileSync(f, "utf8").matchAll(/data:\s*\{\s*currentStatus:\s*([a-zA-Z_][\w.!]*)\s*[,}]/g)) {
        hits.push(`${path.relative(ROOT, f).replace("apps/api/src/modules/", "")} ${m[1]}`);
      }
    }
    assert.deepEqual(hits.sort(), [
      "chaipai/event-routes.ts status", // 拆派仓回传：照收、记一笔（E6）
      "containers/routes.ts freshBatch.fromContainerStatus", // 撤销时柜子自己退回去（改的是柜子，不是运单）
      "containers/routes.ts shipmentNextStatus", // 柜子推进（E3）
      "containers/routes.ts status", // 撤销柜子状态（两处）：只退回推进之前的状态；柜子在派送中 / 已签收时不许撤
      "containers/routes.ts status",
      "loading-manifests/routes.ts finalStatus", // 加货（E4）
      "shipments/parent-status.ts slowest", // 父单跟着子单走：子单拦住了父单就到不了
    ].sort());
  });
  await test("E2b 「xx.currentStatus = 值」这种写法就这几处，值都不是这两个状态（新增就红）", () => {
    const hits: string[] = [];
    for (const f of apiFiles) {
      for (const m of readFileSync(f, "utf8").matchAll(/\.currentStatus\s*=\s*([^;=][^;\n]*)/g)) hits.push(`${path.relative(ROOT, f).replace("apps/api/src/modules/", "")} ${m[1].trim()}`);
    }
    assert.deepEqual(hits.sort(), [
      "containers/routes.ts statusFilter", // where 查询条件，不是写
      "fcl-containers/routes.ts q.status.trim()", // where 查询条件，不是写
      "loading-manifests/routes.ts status", // where 查询条件，不是写
      'orders/routes.ts "inWarehouseCN"', // 确认收货
    ].sort(), hits.join("\n"));
  });
  await test("E3 柜子推进：推到预约派送前先 splitHeldForBatch，扣下的从 moving 里拿掉再 updateMany", () => {
    const src = read("apps/api/src/modules/containers/routes.ts");
    assert.match(src, /RELEASE_STATUSES\.has\(shipmentNextStatus\) && finance2HoldsConfig\(\)/, "开关 off 时一条都不多查");
    assert.match(src, /if \(holdLog\) logHeldAfterCommit\(/, "日志等事务提交以后再记");
    const gate = src.indexOf("splitHeldForBatch(tx");
    const filter = src.indexOf("moving = moving.filter((sp: { id: string }) => !heldIds.has(sp.id))");
    const write = src.indexOf("data: { currentStatus: shipmentNextStatus, updatedAt: now }");
    assert.ok(gate > 0 && filter > gate && write > filter, `${gate} ${filter} ${write}`);
    assert.match(src, /heldShipments,\n\s+holdMessage,\n\s+holdNotice,/);
  });
  await test("E4 加货：补到 finalStatus 之前先 assertReleasable（事务里，拦了整个撤）", () => {
    const src = read("apps/api/src/modules/loading-manifests/routes.ts");
    const gate = src.indexOf("await assertReleasable(tx,");
    const write = src.indexOf("data: { currentStatus: finalStatus, updatedAt: now }");
    assert.ok(gate > 0 && write > gate);
    assert.ok(src.slice(gate - 600, gate).includes("RELEASE_STATUSES.has(finalStatus)"));
  });
  await test("E5 尾端派送出车：循环前 assertReleasable；撤销误签收不拦", () => {
    const src = read("apps/api/src/modules/admin-ops/routes.ts");
    const route = src.indexOf('app.post("/admin/lastmile/orders"');
    const gate = src.indexOf("await assertReleasable(tx, releasing.map(toCandidate)");
    const loop = src.indexOf("for (const sid of orderedIds)");
    const write = src.indexOf('data: { currentStatus: "outForDelivery", updatedAt: now } });\n          await tx.statusLog.create');
    assert.ok(route > 0 && gate > route && loop > gate && write > loop, `${route} ${gate} ${loop} ${write}`);
    const unsign = src.indexOf('app.post("/admin/lastmile/unsign"');
    assert.ok(unsign > 0 && !src.slice(unsign, unsign + 6000).includes("assertReleasable"));
  });
  await test("E6 拆派仓回传：事务提交后 noteChaipaiRelease（只记不拦）", () => {
    const src = read("apps/api/src/modules/chaipai/event-routes.ts");
    const apply = src.indexOf("const out = await applyEvent(");
    const note = src.indexOf("void noteChaipaiRelease(wentOut)");
    assert.ok(apply > 0 && note > apply);
    // 变成派送中，或者没经过派送中直接从仓里变成已签收，都算放出去了
    assert.match(src, /wentOut: changed && \(status === "outForDelivery" \|\| \(status === "delivered" && fromStatus !== "outForDelivery"\)\) \? sid : null/);
  });
  await test("E7 启动时注册路由、起定时任务；定时任务在 off 时什么都不做（sync 先读开关）", () => {
    const main = read("apps/api/src/main.ts");
    assert.match(main, /registerFinance2HoldRoutes\(app\);\nstartFinance2HoldScheduler\(\);/);
    const sync = read("apps/api/src/modules/finance2-holds/sync.ts");
    assert.match(sync, /const cfg = finance2HoldsConfig\(\);\n\s+if \(!cfg\) return \{ kind: "off" \};/);
  });
  await test("E7b 开关 off 时三个入口一条都不多查（先看开关再查库）", () => {
    assert.match(read("apps/api/src/modules/admin-ops/routes.ts"), /if \(finance2HoldsConfig\(\)\) \{ \/\/ 开关 off 时一条都不多查/);
    assert.match(read("apps/api/src/modules/loading-manifests/routes.ts"), /RELEASE_STATUSES\.has\(finalStatus\) && finance2HoldsConfig\(\)/);
    assert.match(read("apps/api/src/modules/finance2-holds/gate.ts"), /if \(!finance2HoldsConfig\(\)\) return;\n\s+const result = await evaluateRelease\(prisma, await loadCandidates/);
    assert.ok(!read("apps/api/src/modules/containers/routes.ts").includes("order: { select: { clientId: true } } },\n          });\n          let moving"), "柜子推进不再无条件多查客户");
  });
  await test("E7c 判断一条 SQL 读完（名单替换夹在中间也读不到两个版本；Codex 审查第 3 条）；单票放行按唛头 + 母运单号对（第 4 条）", () => {
    const gate = read("apps/api/src/modules/finance2-holds/gate.ts");
    const fn = gate.slice(gate.indexOf("export async function evaluateRelease"), gate.indexOf("/** 前端认这个开头"));
    assert.equal((fn.match(/await db\./g) ?? []).length, 1, "evaluateRelease 里只许一次查库");
    assert.match(fn, /db\.\$queryRaw<VerdictRow\[\]>/);
    assert.match(fn, /r\.waybill_no = c\.mother AND r\.customer_mark = c\.mark/);
    assert.match(fn, /ORDER BY d\.cleared_at DESC, d\.blocked DESC LIMIT 1/, "同一时间的放和扣，扣赢");
  });
  await test("E7d 放出去了也带提示（没名单 / 名单太旧 / 配置有问题；Codex 审查第 7 条）：三个入口回 holdNotice，页面都接上了", () => {
    assert.match(read("apps/api/src/modules/admin-ops/routes.ts"), /ok\(res, \{ deliveryNo, count: results\.length, moved, skipped, holdNotice \}\)/);
    assert.match(read("apps/api/src/modules/loading-manifests/routes.ts"), /holdNotice = \(await assertReleasable\(tx,/);
    assert.match(read("apps/api/src/modules/loading-manifests/routes.ts"), /\n      holdNotice,\n    \}\);/);
    const page = read("apps/web/src/app/staff/container-loading/page.tsx");
    assert.match(page, /result\.holdNotice \? `。⚠️ \$\{result\.holdNotice\}`/);
    assert.match(page, /if \(r\.holdNotice\) holdNotice = r\.holdNotice;/);
    assert.match(read("apps/web/src/modules/lastmile/LastmileDispatchWorkspace.tsx"), /result\.holdNotice \? `。⚠️ \$\{result\.holdNotice\}`/);
  });
  await test("E8 日志不在事务里写（写坏了会连累原操作）：writeHoldLogs 不收 tx", () => {
    const store = read("apps/api/src/modules/finance2-holds/store.ts");
    assert.match(store, /export async function writeHoldLogs\(rows: HoldLogInput\[\]\): Promise<void>/);
  });

  await test("E9 三个环境变量进了 .env.example / env.example（不写值）、docker-compose 只透传给 api；前端一个字都不碰", () => {
    const names = ["FINANCE2_HOLDS_MODE", "FINANCE2_HOLDS_SECRET", "FINANCE2_API_BASE"];
    for (const file of [".env.example", "env.example"]) {
      for (const name of names) assert.match(read(file), new RegExp(`^${name}=$`, "m"), `${file} ${name}`);
    }
    const compose = read("docker-compose.yml");
    for (const name of names) {
      assert.equal(compose.split("\n").filter((l) => l.includes(name)).join("\n"), `      ${name}: \${${name}:-}`, `${name} 只透传给 api 一处`);
      assert.ok(compose.indexOf(name) < compose.indexOf("NEXT_PUBLIC_API_BASE_URL"), "要在 api 那一段");
    }
    const webFiles = walk(path.join(ROOT, "apps/web/src"));
    assert.ok(webFiles.length > 100);
    for (const f of webFiles) {
      assert.ok(!readFileSync(f, "utf8").includes("FINANCE2_HOLDS"), f);
    }
  });

  console.log("\n【⑥ 前端】");
  await test("W1 core-api：后端回【扣货】开头的报错时发 finance2-hold-blocked 事件（前缀、事件名跟 finance2-holds-api 一致）", () => {
    const core = read("apps/web/src/services/core-api.ts");
    const api = read("apps/web/src/services/finance2-holds-api.ts");
    assert.match(core, /raw\?\.startsWith\("【扣货】"\)/);
    assert.match(core, /new Event\("finance2-hold-blocked"\)/);
    assert.match(api, /FINANCE2_HOLD_MESSAGE_MARK = "【扣货】"/);
    assert.match(api, /FINANCE2_HOLD_EVENT = "finance2-hold-blocked"/);
    assert.match(read("apps/api/src/modules/finance2-holds/gate.ts"), /HOLD_MESSAGE_MARK = "【扣货】"/);
  });
  await test("W2 装柜管理、尾端派送（管理员 / 员工 / 整柜共用的那一套）都放了「扣货名单」那一块", () => {
    assert.match(read("apps/web/src/app/staff/container-loading/page.tsx"), /<Finance2HoldPanel \/>/);
    assert.match(read("apps/web/src/modules/lastmile/LastmileDispatchWorkspace.tsx"), /<Finance2HoldPanel \/>/);
  });
  await test("W3 柜子推进成功但扣下了几票：提示里带后端那句话，并通知「扣货名单」那一块", () => {
    const page = read("apps/web/src/app/staff/container-loading/page.tsx");
    assert.match(page, /heldCount > 0 && result\.holdMessage/);
    assert.match(page, /if \(heldCount > 0\) window\.dispatchEvent\(new Event\(FINANCE2_HOLD_EVENT\)\)/);
  });
  await test("W4 「扣货名单」那一块：开关 off 什么都不画、不再轮询、取不到也不冒红字；不显示金额；「立即更新名单」只给管理员", () => {
    const panel = read("apps/web/src/components/finance2/Finance2HoldPanel.tsx");
    // 关着改成 10 分钟问一次（不完全停：后台开了开关，开着的页面最多 10 分钟就知道；Codex 审查第 7 条）
    assert.match(panel, /schedule\(next\.mode === "off" \? OFF_POLL_MS : ON_POLL_MS\)/);
    assert.match(panel, /const OFF_POLL_MS = 10 \* 60_000;/);
    assert.match(panel, /seq\.current\+\+; \/\/ 还在路上的那次回来也不再排下一轮/);
    assert.match(panel, /if \(everLive\.current\) setLoadError\(/);
    assert.match(panel, /if \(status\?\.mode === "off"\) return null;/);
    assert.ok(!/amount|金额|¥/.test(panel.replace(/\/\*[^]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
    assert.match(panel, /\{isAdmin && \(/);
  });
  await test("W5 试运行记录（老板 2026-11-19 答「放货拦截 4」）：接口只给管理员、只查 observe、最近 7 天、限条数、不回金额 / 名字 / 操作人；面板只在 observe + 管理员时出这个按钮", () => {
    const routes = read("apps/api/src/modules/finance2-holds/routes.ts");
    const fn = routes.slice(routes.indexOf("app.get(FINANCE2_HOLD_PATHS.observeLog"), routes.indexOf("app.post(FINANCE2_HOLD_PATHS.refresh"));
    assert.match(fn, /requireRole\(req, res, \["admin"\]\)/);
    assert.match(fn, /where: \{ kind: "observe", createdAt: \{ gte: since \} \}/);
    assert.match(fn, /take: OBSERVE_LOG_LIMIT \+ 1/);
    assert.ok(!/operatorId|amount|clientName|name:/.test(fn), "不回操作人、金额、名字");
    assert.match(routes, /OBSERVE_LOG_DAYS = 7;/);
    const panel = read("apps/web/src/components/finance2/Finance2HoldPanel.tsx");
    assert.match(panel, /\{isAdmin && live\?\.mode === "observe" && \(/);
    assert.match(read("apps/web/src/services/finance2-holds-api.ts"), /\/admin\/finance2-holds\/observe-log/);
  });
  await test("W6 文档里不再有过时的「配错按 off」，写明不填时按 observe、off 才关", () => {
    for (const f of [".env.example", "env.example", "apps/api/src/modules/finance2-holds/config.ts"]) {
      assert.ok(!read(f).includes("配错按 off"), f);
    }
    for (const f of [".env.example", "env.example"]) {
      assert.match(read(f), /不填   → 下面地址、密钥至少配了一个就按 observe/, f);
      assert.match(read(f), /off     → 关：什么都不做/, f);
    }
    assert.match(read("docker-compose.yml"), /MODE 不填：地址 \/ 密钥配了就按 observe/);
  });

  console.log("\n【⑦ 扣货上报（约定 11.2；11.1 物流不报，财务 ADR 0142 自己报警）】");
  {
    interface Seen { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }
    const got: Seen[] = [];
    let ev: { status: number; body: string; delayMs?: number } = { status: 200, body: JSON.stringify({ serverTime: "2026-12-05T10:15:03+07:00", accepted: true }) };
    const srv = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        got.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
        const send = () => { if (!res.destroyed) { res.writeHead(ev.status, { "content-type": "application/json" }); res.end(ev.body); } };
        if (ev.delayMs) setTimeout(send, ev.delayMs); else send();
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const remote = { secret: SECRET, apiBase: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/integrations/logistics/v1` };
    const unav = { kind: "holdListUnavailable" as const, occurredAt: "2026-12-05T11:15:00.000Z", reason: "HTTP 401", failingSince: "2026-12-05T10:00:00.000Z", lastFetchedAt: null };
    try {
      await test("R1 holdListUnavailable：POST …/hold-events，Bearer 密钥在请求头、JSON 请求体字段跟约定 11.2 一模一样（不多不少）", async () => {
        const r = await postHoldEvent(remote, unav);
        assert.equal(r.kind, "ok");
        const g = got.at(-1)!;
        assert.equal(g.method, "POST");
        assert.equal(g.url, "/integrations/logistics/v1/hold-events");
        assert.equal(g.headers.authorization, `Bearer ${SECRET}`);
        assert.match(String(g.headers["content-type"]), /^application\/json/);
        assert.ok(!g.url.includes(SECRET));
        assert.deepEqual(JSON.parse(g.body), { kind: "holdListUnavailable", occurredAt: "2026-12-05T11:15:00.000Z", reason: "HTTP 401", failingSince: "2026-12-05T10:00:00.000Z", lastFetchedAt: null });
      });
      await test("R2 holdListRecovered 只有 kind、occurredAt；reason 里的密钥换掉、截到 200 字、不许空", async () => {
        await postHoldEvent(remote, { kind: "holdListRecovered", occurredAt: "2026-12-05T11:30:00.000Z" });
        assert.deepEqual(JSON.parse(got.at(-1)!.body), { kind: "holdListRecovered", occurredAt: "2026-12-05T11:30:00.000Z" });
        assert.equal(safeReason(`连不上 ${SECRET} 了`, SECRET), "连不上 *** 了");
        assert.equal(safeReason("x".repeat(500), SECRET).length, 200);
        assert.equal(safeReason("  ", SECRET), "取不到扣货名单");
      });
      await test("R3 只有 200 算报进去；4xx（400 / 401 / 403 / 404 / 413）不重试；5xx / 429 / 别的状态码 / 超时 / 连不上下一轮再报；超过 8 KB 不发", async () => {
        for (const [status, retryable] of [[400, false], [401, false], [403, false], [404, false], [413, false], [500, true], [502, true], [503, true], [429, true], [204, true], [302, true]] as const) {
          ev = { status, body: status === 400 ? JSON.stringify({ error: "bad_request", message: "reason 太长" }) : "{}" };
          const r = await postHoldEvent(remote, unav);
          assert.equal(r.kind, "error", String(status));
          assert.equal(r.kind === "error" && r.retryable, retryable, String(status));
          if (status === 400) assert.match(r.kind === "error" ? r.reason : "", /HTTP 400：reason 太长/);
        }
        ev = { status: 200, body: "{}", delayMs: 2000 };
        const t0 = Date.now();
        const slow = await postHoldEvent(remote, unav, 300);
        assert.ok(slow.kind === "error" && slow.retryable && slow.reason === "超时", JSON.stringify(slow));
        assert.ok(Date.now() - t0 < 1500);
        const down = await postHoldEvent({ ...remote, apiBase: "http://127.0.0.1:1/integrations/logistics/v1" }, unav);
        assert.ok(down.kind === "error" && down.retryable && down.reason === "连不上", JSON.stringify(down));
        const n = got.length;
        const big = await postHoldEvent(remote, { ...unav, reason: "长".repeat(5000) });
        assert.ok(big.kind === "error" && !big.retryable);
        assert.equal(got.length, n, "超过 8 KB 本地就不发（约定 11）");
      });
    } finally {
      srv.close();
    }
    await test("R4 拆派仓把扣着的货派出去了：只记 chaipai 日志、打 warn，**不报财务**（财务拉运单时自己报警，ADR 0142）；也没有补报", () => {
      const gate = read("apps/api/src/modules/finance2-holds/gate.ts");
      const note = gate.slice(gate.indexOf("async function noteChaipaiReleaseInner"));
      assert.match(note, /if \(!finance2HoldsConfig\(\)\) return;/);
      assert.match(note, /logHeld\(result, \{ entry: "拆派仓回传派送中", operatorId: null \}, "chaipai",/);
      assert.ok(!/postHoldEvent|report[A-Z]|from "\.\/reports"/.test(gate), "gate.ts 不许往财务报");
      assert.ok(!read("apps/api/src/modules/finance2-holds/client.ts").includes('kind: "releasedWhileHeld"'), "上报类型里不许有 releasedWhileHeld");
      const sync = read("apps/api/src/modules/finance2-holds/sync.ts");
      assert.ok(!/retryPending|runHoldRound/.test(sync));
      assert.match(sync, /const run = \(\) => \{\n\s+syncHoldList\(\)/);
    });
    await test("R5 取名单报警的那几种同时报给财务（有 remote 才报）；取到名单时报「恢复了」；上报函数整个包在 try 里、不影响取名单", () => {
      const sync = read("apps/api/src/modules/finance2-holds/sync.ts");
      const alert = sync.slice(sync.indexOf("if (/HTTP 40[13]|配置有问题/.test(lastReason) || longDown)"));
      assert.match(alert.slice(0, 600), /if \(cfg\.remote\) \{\n\s+await reportHoldListUnavailable\(cfg\.remote,/);
      assert.match(sync, /await reportHoldListRecovered\(cfg\.remote!\);/);
      const reports = read("apps/api/src/modules/finance2-holds/reports.ts");
      for (const fn of ["reportHoldListUnavailable", "reportHoldListRecovered"]) {
        const body = reports.slice(reports.indexOf(`export async function ${fn}`));
        assert.match(body.slice(0, 400), /\{\n\s+try \{/, `${fn} 要整个包在 try 里`);
      }
    });
  }

  console.log(`\n通过 ${passes}，失败 ${failures}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
