/**
 * 对接海外仓财务系统：真 PostgreSQL + 真 HTTP 服务（2026-11-04）。
 *
 * 走真实接口：财务后端那几条（带对接密钥）、授权页那两条，再拿物流客户端 / 代理端自己的列表核总数，
 * 用真的改密码接口、真的停代理接口核授权失效。覆盖修改清单第八节「物流（第 1 轮）」逐条：
 * 范围（普通客户 / 代理 / 客户转走）、总数对得上、整柜集货不出现、响应里没有柜号金额收件人操作人内部 id、
 * 封禁改密码改角色立刻失效、密钥错和授权错码不同、一次性码（一次、过期、并发）、员工管理员不能授权、登录限流、总开关、跳回地址。
 *
 * ⚠️ 字段恰好为空 = 测不出来（CLAUDE.md #31④）：夹具里柜号、金额、收件人、操作人、内部备注全部填好认的真值。
 *
 * 只连测试库：没设 AGENT_PORTAL_TEST_ALLOW_DB=1 一律不跑（CI 的一次性库、本机一次性库才设）；
 * 没有 DATABASE_URL 打印「跳过」。测试数据全在假公司 zz_ft_co 下，开跑前、跑完后都清干净。
 * 迁移文件那一段要临时建库，只在本机一次性库上跑。
 * 用法：npm run test:finance-link-db
 */
process.env.TZ = "UTC";
process.env.AUTH_SECRET ||= "test-only-fake-secret-not-a-real-key-do-not-use-in-production";
process.env.AGENT_REBATE_SCHEDULER = "off";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { PrismaClient } from "@prisma/client";

type Row = Record<string, any>;

const CO = "zz_ft_co";
/** 测「账号换了公司」用的另一个假公司：用例中途失败时账号可能还留在这里，清数据要连它一起清 */
const OTHER_CO = "zz_ft_other_co";
const COMPANIES = [CO, OTHER_CO];
const P = "zz_ft_";
const SECRET = "Fin4nceLink-aB3dE5gH7jK9mN1pQ3sT5vX";
const RETURN_URL = "https://finance.example.test/logistics-waybills/callback";
const PASSWORD = "Test-pass-Zz123456";
const ROOT = path.join(__dirname, "..");
const SCHEMA = path.join(ROOT, "apps/api/prisma/schema.prisma");
const MIGRATION = path.join(ROOT, "apps/api/prisma/migrations/20261104_finance_link/migration.sql");
const DRIFT = path.join(ROOT, "scripts/check-schema-drift.sql");

/** 账号 */
const CLIENT = "ZZFTA";
const AGENT = "zz_ft_agent";
const AGENT2 = "zz_ft_agent2";
const CLIENT_B = "ZZFTB";
const CLIENT_C = "ZZFTC";
const CLIENT_D = "ZZFTD";
const CLIENT_X = "ZZFTX";
const STAFF = "zz_ft_staff";
const ADMIN = "zz_ft_admin";

/** 这些在给财务系统的响应里一个字都不许出现 */
const SEA_CONTAINER = "ZFTU1234567";
const LAND_CONTAINER = "LZZFT260821";
/** 手写在备注里、没录进系统、也不是标准柜号的写法 */
const HANDWRITTEN_CONTAINER = "ABC-77ZZ";
const HANDWRITTEN_CONTAINER_2 = "XYZ-88ZZ";
const BATCH_ONLY = "ZZFTBATCH77";
const MUST_NOT_LEAK = [
  // 值
  SEA_CONTAINER, LAND_CONTAINER, BATCH_ONLY, "FCLZ7654321", HANDWRITTEN_CONTAINER, HANDWRITTEN_CONTAINER_2,
  "8765.43", // 金额
  "收件人陈ZZFT", "0899998888", "曼谷收件地址ZZFT",
  "员工小王ZZFT", "老李ZZFT", STAFF, ADMIN,
  "内部备注ZZFT", "ZZFTORD",
  // 客户名字：老板选全部填唛头，name / clientName 的值都是唛头
  "普通客户甲", "代理一登录号", "代理二登录号", "代理客户乙", "代理客户丙", "别的代理的客户", "别家客户",
  // 内部 id
  `${P}o_`, `${P}s_`, `${P}ct_`, `${P}l_`, `${P}ag1`, `${P}ag2`,
  // 字段名
  "batchNo", "containerNo", "receivableAmountCny", "receiverNameTh", "receiverPhoneTh", "receiverAddressTh",
  "operatorId", "operatorName", "operatorRole", "orderNo", "shipmentId", "companyId", "approvalStatus", "passwordHash",
];

let failures = 0;
let passes = 0;
async function test(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passes++;
    console.log(`  ✅ ${label}`);
  } catch (e) {
    failures++;
    console.log(`  ❌ ${label}\n     ${e instanceof Error ? e.message.split("\n").slice(0, 12).join("\n     ") : String(e)}`);
  }
}

/** 把测试期间所有日志接下来，最后查一遍有没有密码 / 授权 / 一次性码 */
const captured: string[] = [];
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
    original(...args);
  };
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) { console.log("⚠️ 跳过：没有 DATABASE_URL（CI 没有数据库）—— 这一项等于没测"); return; }
  if (process.env.AGENT_PORTAL_TEST_ALLOW_DB !== "1") {
    console.log("⚠️ 跳过：怕连到生产库不跑（确认是测试库再设 AGENT_PORTAL_TEST_ALLOW_DB=1）—— 这一项等于没测");
    return;
  }

  process.env.FINANCE_LINK_ENABLED = "true";
  process.env.FINANCE_LINK_SECRET = SECRET;
  process.env.FINANCE_LINK_RETURN_URL = RETURN_URL;

  const { prisma } = await import("../apps/api/src/db/prisma");
  const { createApp } = await import("../apps/api/src/server");
  const { signAuthToken } = await import("../apps/api/src/modules/auth/token");
  const { hashPassword } = await import("../apps/api/src/modules/auth/crypto-utils");
  const { registerAuthRoutes } = await import("../apps/api/src/modules/auth/routes");
  const { registerOrderRoutes } = await import("../apps/api/src/modules/orders/routes");
  const { registerAgentPortalRoutes } = await import("../apps/api/src/modules/agent-portal/routes");
  const { registerAgentAdminRoutes } = await import("../apps/api/src/modules/agents/admin-routes");
  const { registerFinanceLinkRoutes } = await import("../apps/api/src/modules/finance-link/routes");
  const { __resetFailureStoreForTest } = await import("../apps/api/src/modules/core/rate-limit");
  const { sha256Hex } = await import("../apps/api/src/modules/finance-link/authorization");
  const { CLIENT_STATUS_ZH_OVERRIDES, shipmentStatusZh } = await import("../apps/web/src/modules/shipment/shipment-status");

  const db = prisma as any;

  async function cleanup(): Promise<void> {
    await db.financeLinkAuthorization.deleteMany({ where: { companyId: { in: COMPANIES } } });
    await db.financeLinkRequest.deleteMany({ where: { warehouseRef: { startsWith: P } } });
    await db.whrConsolidationPrealert.deleteMany({ where: { companyId: CO } });
    await db.whrConsolidationPlanCustomer.deleteMany({ where: { companyId: CO } });
    await db.whrConsolidationPlan.deleteMany({ where: { companyId: CO } });
    await db.consolidationTask.deleteMany({ where: { companyId: CO } });
    await db.statusLog.deleteMany({ where: { companyId: CO } });
    const shipments: Array<{ id: string }> = await db.shipment.findMany({ where: { companyId: CO }, select: { id: true } });
    await db.shipmentContainerItem.deleteMany({ where: { shipmentId: { in: shipments.map((s) => s.id) } } });
    await db.container.deleteMany({ where: { companyId: CO } });
    await db.shipment.deleteMany({ where: { companyId: CO } });
    await db.orderProduct.deleteMany({ where: { companyId: CO } });
    await db.order.deleteMany({ where: { companyId: CO } });
    await db.user.deleteMany({ where: { companyId: { in: COMPANIES } } });
    await db.agent.deleteMany({ where: { companyId: CO } });
  }

  async function seed(): Promise<void> {
    const pw = hashPassword(PASSWORD);
    await db.agent.createMany({ data: [
      { id: `${P}ag1`, companyId: CO, name: "代理一", slug: "zzftone", priceNormal: 500, priceInspection: 550, priceSensitive: 600 },
      { id: `${P}ag2`, companyId: CO, name: "代理二", priceNormal: 500, priceInspection: 550, priceSensitive: 600 },
    ] });
    const user = (id: string, role: string, name: string, agentId: string | null = null) =>
      ({ id, companyId: CO, role, name, phone: "0800000000", status: "active", agentId, passwordHash: pw });
    await db.user.createMany({ data: [
      user(CLIENT, "client", "普通客户甲"),
      user(AGENT, "agent", "代理一登录号", `${P}ag1`),
      user(AGENT2, "agent", "代理二登录号", `${P}ag2`),
      user(CLIENT_B, "client", "代理客户乙", `${P}ag1`),
      user(CLIENT_C, "client", "代理客户丙", `${P}ag1`),
      user(CLIENT_D, "client", "别的代理的客户", `${P}ag2`),
      user(CLIENT_X, "client", "别家客户"),
      user(STAFF, "staff", "员工小王ZZFT"),
      user(ADMIN, "admin", "老李ZZFT"),
    ] });
    const order = (id: string, clientId: string, itemName: string, extra: Row = {}) => ({
      id: `${P}o_${id}`, companyId: CO, clientId, warehouseId: "wh", orderNo: `ZZFTORD${id}`, itemName, productQuantity: 2, packageCount: 3, packageUnit: "箱", transportMode: "sea",
      receiverNameTh: "收件人陈ZZFT", receiverPhoneTh: "0899998888", receiverAddressTh: "曼谷收件地址ZZFT", approvalStatus: "approved",
      shipDate: "2026-10-01", batchNo: BATCH_ONLY, volumeM3: 1.5, weightKg: 30, receivableAmountCny: 8765.43, domesticTrackingNo: "SFZZFT0001", ...extra,
    });
    await db.order.createMany({ data: [
      order("a1", CLIENT, "鞋子A1"),
      order("a2", CLIENT, "衣服A2"),
      order("apend", CLIENT, "还没审的单", { approvalStatus: "pending" }),
      order("afcl", CLIENT, "整柜货"),
      order("b1", CLIENT_B, "灯具B1"),
      order("b2", CLIENT_B, "灯具B2"),
      order("c1", CLIENT_C, "布料C1"),
      order("d1", CLIENT_D, "别的代理的货"),
      order("x1", CLIENT_X, "别家的货"),
    ] });
    const ship = (id: string, orderId: string, trackingNo: string, currentStatus: string, parentTrackingNo: string | null = null) => ({
      id: `${P}s_${id}`, companyId: CO, orderId: `${P}o_${orderId}`, trackingNo, parentTrackingNo, currentStatus, warehouseId: "wh",
      batchNo: BATCH_ONLY, containerNo: SEA_CONTAINER, remark: "内部备注ZZFT", volumeM3: 1.5, transportMode: "sea",
    });
    await db.shipment.createMany({ data: [
      ship("a1", "a1", "ZZFT0000001", "customsCleared"),
      ship("a1c1", "a1", "ZZFT0000001-1", "inWarehouseTH", "ZZFT0000001"),
      ship("a1c2", "a1", "ZZFT0000001-2", "customsCleared", "ZZFT0000001"),
      ship("a2", "a2", "ZZFT0000002", "delivered"),
      ship("apend", "apend", "ZZFT0000003", "created"),
      ship("afcl", "afcl", "ZZFTFCL0001", "departed"),
      ship("b1", "b1", "ZZFT0000011", "departed"),
      ship("b2", "b2", "ZZFT0000012", "inWarehouseCN"),
      ship("c1", "c1", "ZZFT0000021", "outForDelivery"),
      ship("d1", "d1", "ZZFT0000031", "departed"),
      ship("x1", "x1", "ZZFT0000091", "departed"),
      // 脏数据：子单挂在父单 ZZFT0000011 下面，订单却是别家客户的。代理一不许看到
      ship("dirty", "x1", "ZZFT0000011-9", "departed", "ZZFT0000011"),
      // 脏数据：子单挂在同一个客户、但没审过的单 / 整柜的单上。父单 ZZFT0000001 看得到，这两张不许带出来
      ship("dirtyP", "apend", "ZZFT0000001-8", "departed", "ZZFT0000001"),
      ship("dirtyF", "afcl", "ZZFT0000001-7", "departed", "ZZFT0000001"),
    ] });
    // 一票多款：每款有自己的国内单号，整票上还有一个真单号
    await db.orderProduct.createMany({ data: [
      { id: `${P}p1`, companyId: CO, orderId: `${P}o_b2`, itemName: "灯具甲", packageCount: 1, domesticTrackingNo: "SFP1", sortOrder: 0 },
      { id: `${P}p2`, companyId: CO, orderId: `${P}o_b2`, itemName: "灯具乙", packageCount: 2, domesticTrackingNo: "SFP2", sortOrder: 1 },
    ] });
    await db.container.createMany({ data: [
      { id: `${P}ct_sea`, companyId: CO, containerNo: SEA_CONTAINER, containerType: "40HQ", currentStatus: "IN_TRANSIT" },
      { id: `${P}ct_land`, companyId: CO, containerNo: LAND_CONTAINER, containerType: "40HQ", currentStatus: "IN_TRANSIT", transportMode: "land" },
      { id: `${P}ct_fcl`, companyId: CO, containerNo: "FCLZ7654321", containerType: "40HQ", currentStatus: "IN_TRANSIT", isFcl: true },
    ] });
    await db.shipmentContainerItem.createMany({ data: [
      { shipmentId: `${P}s_a1c1`, containerId: `${P}ct_sea`, loadedVolumeM3: 1, loadedPieceCount: 2 },
      { shipmentId: `${P}s_a1c2`, containerId: `${P}ct_land`, loadedVolumeM3: 1, loadedPieceCount: 1 },
      { shipmentId: `${P}s_b1`, containerId: `${P}ct_sea`, loadedVolumeM3: 1, loadedPieceCount: 3 },
      { shipmentId: `${P}s_afcl`, containerId: `${P}ct_fcl`, loadedVolumeM3: 1, loadedPieceCount: 3 },
    ] });
    const log = (id: string, shipmentId: string, toStatus: string, remark: string, at: string, nextStop: string | null = null) => ({
      id: `${P}l_${id}`, companyId: CO, shipmentId: `${P}s_${shipmentId}`, operatorId: STAFF, operatorRole: "staff", operatorName: "员工小王ZZFT",
      fromStatus: "created", toStatus, remark, nextStop, changedAt: new Date(at),
    });
    await db.statusLog.createMany({ data: [
      log("1", "a1", "inWarehouseCN", "入库完成", "2026-10-01T01:00:00Z"),
      log("2", "a1c1", "loaded", `装入柜子 ${SEA_CONTAINER}（分装 2件）`, "2026-10-02T01:00:00Z", `${SEA_CONTAINER} 去林查班`),
      log("3", "a1c2", "loaded", `到达凭祥口岸（随柜 ${LAND_CONTAINER} 补记）`, "2026-10-02T02:00:00Z"),
      log("4", "a1c1", "departed", `柜号 ${SEA_CONTAINER} 今日开船`, "2026-10-03T01:00:00Z"),
      log("5", "a1", "customsCleared", "管理员把「鞋子A1」的货型由普货改为商检", "2026-10-04T01:00:00Z"),
      log("6", "a1c1", "inWarehouseTH", `${BATCH_ONLY} 已卸柜`, "2026-10-05T01:00:00Z"),
      log("7", "b1", "departed", `装入柜子 ${SEA_CONTAINER}（分装 3件）`, "2026-10-02T03:00:00Z"),
      log("8", "dirty", "departed", "脏子单的轨迹SECRETDIRTY", "2026-10-06T01:00:00Z"),
      log("8p", "dirtyP", "departed", "没审过那张的子单轨迹SECRETDIRTY", "2026-10-06T02:00:00Z"),
      log("8f", "dirtyF", "departed", "整柜那张的子单轨迹SECRETDIRTY", "2026-10-06T03:00:00Z"),
      log("9", "b1", "departed", `柜号：${HANDWRITTEN_CONTAINER}、${HANDWRITTEN_CONTAINER_2} 今天到`, "2026-10-07T01:00:00Z", `柜号:${HANDWRITTEN_CONTAINER_2}`),
    ] });
    // 集货两种都造上：不许出现在运单接口里
    await db.consolidationTask.create({ data: { taskNo: "JHZZFT0001", companyId: CO, clientId: CLIENT, destinationTh: "曼谷" } });
    await db.whrConsolidationPlan.create({ data: { id: `${P}plan`, companyId: CO, planNo: "WHRZZFT01", destinationTh: "曼谷", status: "collecting", createdBy: ADMIN, creatorName: "老李ZZFT", totalVolumeM3: 10 } });
    await db.whrConsolidationPlanCustomer.create({ data: { id: `${P}pc`, planId: `${P}plan`, companyId: CO, clientId: CLIENT_B, unitPriceNormal: 600, unitPriceInspection: 650, unitPriceSensitive: 700, totalVolumeM3: 3 } });
    await db.whrConsolidationPrealert.create({ data: { id: `${P}pa`, customerId: `${P}pc`, companyId: CO, trackingNo: "JH-ZZFT0001", mark: CLIENT_B, status: "pending" } });
  }

  await cleanup();
  await seed();

  const PORT = await freePort();
  const app = createApp();
  registerAuthRoutes(app);
  registerOrderRoutes(app);
  registerAgentPortalRoutes(app);
  registerAgentAdminRoutes(app);
  registerFinanceLinkRoutes(app);
  // MinimalHttpApp.listen 不返回 server；等它起来，退出时整个进程结束
  await new Promise<void>((resolve) => app.listen(PORT, resolve));

  const BASE = `http://127.0.0.1:${PORT}`;
  let ipCounter = 0;
  const nextIp = () => `10.77.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

  interface Res { status: number; body: Row; text: string }
  async function call(method: string, pathAndQuery: string, opts: { body?: unknown; headers?: Record<string, string>; ip?: string } = {}): Promise<Res> {
    const r = await fetch(`${BASE}${pathAndQuery}`, {
      method,
      headers: { "content-type": "application/json", "x-real-ip": opts.ip ?? nextIp(), ...(opts.headers ?? {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await r.text();
    let body: Row = {};
    try { body = JSON.parse(text) as Row; } catch { /* 不是 JSON 就留空 */ }
    return { status: r.status, body, text };
  }
  const bearer = { authorization: `Bearer ${SECRET}` };
  const fin = (method: string, p: string, body?: unknown, token?: string) =>
    call(method, p, { body, headers: { ...bearer, ...(token ? { "x-link-token": token } : {}) } });

  let refCounter = 0;
  const newRef = () => `${P}wh${++refCounter}`;

  async function newRequest(warehouseRef = newRef(), warehouseName = "曼谷1仓"): Promise<string> {
    const r = await fin("POST", "/integrations/finance/v1/link-requests", { warehouseRef, warehouseName });
    assert.equal(r.status, 201, r.text);
    return r.body.requestId as string;
  }
  /** 登录授权，拿到一次性码 */
  async function authorizeCode(requestId: string, account: string, password = PASSWORD): Promise<string> {
    const r = await call("POST", "/auth/finance-link/authorize", { body: { requestId, account, password } });
    assert.equal(r.status, 200, r.text);
    const m = /#request=([^&]+)&code=(.+)$/.exec(r.body.redirectUrl as string);
    assert.ok(m, r.body.redirectUrl);
    return decodeURIComponent(m![2]);
  }
  /** 整套走一遍，拿到长期授权 */
  async function link(account: string, warehouseRef = newRef()): Promise<{ token: string; authorizationId: string; warehouseRef: string }> {
    const requestId = await newRequest(warehouseRef);
    const code = await authorizeCode(requestId, account);
    const r = await fin("POST", "/integrations/finance/v1/link-tokens", { requestId, code });
    assert.equal(r.status, 200, r.text);
    return { token: r.body.token as string, authorizationId: r.body.authorizationId as string, warehouseRef };
  }
  const waybills = (token: string, query = "") => fin("GET", `/integrations/finance/v1/waybills${query}`, undefined, token);
  const track = (token: string, no: string) => fin("GET", `/integrations/finance/v1/waybills/track?trackingNo=${encodeURIComponent(no)}`, undefined, token);
  const loginToken = (userId: string, role: string) => signAuthToken({ userId, companyId: CO, role: role as any, userName: userId });
  const asUser = (token: string) => ({ authorization: `Bearer ${token}` });
  const trackingNos = (r: Res) => (r.body.items as Row[]).map((i) => i.trackingNo as string).sort();
  /** 比响应时去掉每次都变的编号和时间 */
  const stable = (b: Row) => { const { requestId: _r, timestamp: _t, ...rest } = b; return rest; };

  try {
    console.log("\n【授权流程】");
    await test("A1 建请求 201：requestId 至少 32 字节、授权页地址对、10 分钟过期；请求里还没有账号和码", async () => {
      const r = await fin("POST", "/integrations/finance/v1/link-requests", { warehouseRef: newRef(), warehouseName: "曼谷1仓" });
      assert.equal(r.status, 201, r.text);
      assert.deepEqual(Object.keys(r.body).sort(), ["authorizeUrl", "expiresAt", "requestId"]);
      assert.ok(Buffer.from(r.body.requestId, "base64url").length >= 32);
      assert.ok((r.body.authorizeUrl as string).endsWith(`/login/authorize?request=${r.body.requestId}`), r.body.authorizeUrl);
      const ms = new Date(r.body.expiresAt).getTime() - Date.now();
      assert.ok(ms > 9 * 60_000 && ms <= 10 * 60_000, String(ms));
      const row = await db.financeLinkRequest.findUnique({ where: { id: r.body.requestId } });
      assert.equal(row.userId, null);
      assert.equal(row.codeHash, null);
    });

    await test("A2 建请求：没带 / 带错密钥 401 LINK_SECRET_INVALID；仓库编号或名称不合格 400", async () => {
      for (const headers of [{}, { authorization: "Bearer wrong-secret" }] as Array<Record<string, string>>) {
        const r = await call("POST", "/integrations/finance/v1/link-requests", { body: { warehouseRef: newRef(), warehouseName: "x" }, headers });
        assert.equal(r.status, 401, r.text);
        assert.equal(r.body.code, "LINK_SECRET_INVALID");
      }
      for (const bad of [{}, { warehouseRef: newRef() }, { warehouseRef: "", warehouseName: "x" }, { warehouseRef: 12, warehouseName: "x" }, { warehouseRef: newRef(), warehouseName: "a\nb" }]) {
        const r = await fin("POST", "/integrations/finance/v1/link-requests", bad);
        assert.equal(r.status, 400, JSON.stringify(bad));
      }
    });

    await test("A3 授权页信息：仓名从数据库取、网址里塞的不认；不存在 / 过期都是 expired", async () => {
      const id = await newRequest(newRef(), "曼谷1仓");
      const r = await call("GET", `/auth/finance-link/request?request=${encodeURIComponent(id)}&warehouseName=${encodeURIComponent("假仓")}`);
      assert.equal(r.status, 200);
      assert.deepEqual({ warehouseName: r.body.warehouseName, expired: r.body.expired }, { warehouseName: "曼谷1仓", expired: false });
      const none = await call("GET", "/auth/finance-link/request?request=nope");
      assert.deepEqual({ warehouseName: none.body.warehouseName, expired: none.body.expired }, { warehouseName: null, expired: true });
      await db.financeLinkRequest.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const old = await call("GET", `/auth/finance-link/request?request=${encodeURIComponent(id)}`);
      assert.equal(old.body.expired, true);
      assert.equal(old.body.warehouseName, null);
    });

    await test("A4 授权成功：只回跳回地址（# 后面带 request 和 code）；不签登录令牌；数据库只存码的哈希", async () => {
      const id = await newRequest();
      const r = await call("POST", "/auth/finance-link/authorize", { body: { requestId: id, account: CLIENT, password: `  ${PASSWORD} ` } });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(Object.keys(r.body), ["redirectUrl"]);
      const m = /^(.+)#request=([^&]+)&code=(.+)$/.exec(r.body.redirectUrl as string)!;
      assert.equal(m[1], RETURN_URL);
      assert.equal(decodeURIComponent(m[2]), id);
      const code = decodeURIComponent(m[3]);
      assert.ok(Buffer.from(code, "base64url").length >= 32);
      assert.ok(!r.text.includes("token"), "不许带令牌");
      const row = await db.financeLinkRequest.findUnique({ where: { id } });
      assert.equal(row.userId, CLIENT);
      assert.ok(row.codeHash && row.codeHash !== code && !row.codeHash.includes(code));
      const ms = row.codeExpiresAt.getTime() - Date.now();
      assert.ok(ms > 4 * 60_000 && ms <= 5 * 60_000, String(ms));
      assert.equal(row.codeUsedAt, null);
    });

    await test("A5 跳回地址不受请求参数影响：body、网址、请求头里塞地址都不认", async () => {
      const id = await newRequest();
      const evil = "https://evil.example.com/steal";
      const r = await call("POST", `/auth/finance-link/authorize?redirectUrl=${encodeURIComponent(evil)}&returnUrl=${encodeURIComponent(evil)}`, {
        body: { requestId: id, account: CLIENT, password: PASSWORD, redirectUrl: evil, returnUrl: evil, redirect_uri: evil },
        headers: { origin: evil, referer: evil, "x-forwarded-host": "evil.example.com" },
      });
      assert.equal(r.status, 200, r.text);
      assert.ok((r.body.redirectUrl as string).startsWith(`${RETURN_URL}#request=`), r.body.redirectUrl);
      assert.ok(!r.text.includes("evil"), r.text);
    });

    await test("A6 换长期授权：只回一次、字段对、编号和账号不超长；数据库只存 SHA-256", async () => {
      const ref = newRef();
      const id = await newRequest(ref, "曼谷2仓");
      const code = await authorizeCode(id, AGENT);
      const r = await fin("POST", "/integrations/finance/v1/link-tokens", { requestId: id, code });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(Object.keys(r.body).sort(), ["account", "authorizationId", "token"]);
      assert.deepEqual(r.body.account, { account: AGENT, name: AGENT, role: "agent" }, "name 填唛头，不给客户名字");
      assert.ok(!r.text.includes("代理一登录号"));
      assert.ok(typeof r.body.authorizationId === "string" && r.body.authorizationId.length <= 128);
      assert.ok(r.body.account.account.length <= 100);
      assert.ok(Buffer.from(r.body.token, "base64url").length >= 32);
      const row = await db.financeLinkAuthorization.findUnique({ where: { id: r.body.authorizationId } });
      assert.equal(row.tokenHash, sha256Hex(r.body.token));
      assert.ok(!JSON.stringify(row).includes(r.body.token), "数据库不存原文");
      assert.equal(row.companyId, CO);
      assert.equal(row.warehouseRef, ref);
      assert.equal(row.warehouseName, "曼谷2仓");
      assert.equal(row.role, "agent");
      assert.equal(row.revokedAt, null);
    });

    await test("A7 码不能用第二次；没带密钥换不了；没带码 400", async () => {
      const id = await newRequest();
      const code = await authorizeCode(id, CLIENT);
      const noSecret = await call("POST", "/integrations/finance/v1/link-tokens", { body: { requestId: id, code } });
      assert.equal(noSecret.body.code, "LINK_SECRET_INVALID");
      assert.equal((await fin("POST", "/integrations/finance/v1/link-tokens", { requestId: id, code })).status, 200, "没带密钥那次不许把码用掉");
      const again = await fin("POST", "/integrations/finance/v1/link-tokens", { requestId: id, code });
      assert.equal(again.status, 400);
      assert.equal(again.body.code, "LINK_CODE_INVALID");
      assert.equal((await fin("POST", "/integrations/finance/v1/link-tokens", { requestId: id })).body.code, "LINK_CODE_INVALID");
      assert.equal((await fin("POST", "/integrations/finance/v1/link-tokens", { requestId: "nope", code })).body.code, "LINK_CODE_INVALID");
    });

    await test("A8 码过期不能用；请求自己过期了但码还没到点可以换（用户刚登录完不该白登录）", async () => {
      const id = await newRequest();
      const code = await authorizeCode(id, CLIENT);
      await db.financeLinkRequest.update({ where: { id }, data: { codeExpiresAt: new Date(Date.now() - 1000) } });
      const r = await fin("POST", "/integrations/finance/v1/link-tokens", { requestId: id, code });
      assert.equal(r.status, 400);
      assert.equal(r.body.code, "LINK_CODE_INVALID");
      const id2 = await newRequest();
      const code2 = await authorizeCode(id2, CLIENT);
      await db.financeLinkRequest.update({ where: { id: id2 }, data: { expiresAt: new Date(Date.now() - 1000) } });
      assert.equal((await fin("POST", "/integrations/finance/v1/link-tokens", { requestId: id2, code: code2 })).status, 200);
    });

    await test("A9 并发 8 次换同一个码：只成功一次，只有一条授权", async () => {
      const ref = newRef();
      const id = await newRequest(ref);
      const code = await authorizeCode(id, CLIENT);
      const all = await Promise.all(Array.from({ length: 8 }, () => fin("POST", "/integrations/finance/v1/link-tokens", { requestId: id, code })));
      assert.deepEqual(all.map((r) => r.status).sort(), [200, 400, 400, 400, 400, 400, 400, 400], all.map((r) => r.text.slice(0, 80)).join("\n"));
      assert.equal(await db.financeLinkAuthorization.count({ where: { warehouseRef: ref } }), 1);
    });

    await test("A10 错的码不消耗对的码", async () => {
      const id = await newRequest();
      const code = await authorizeCode(id, CLIENT);
      assert.equal((await fin("POST", "/integrations/finance/v1/link-tokens", { requestId: id, code: `${code}x` })).body.code, "LINK_CODE_INVALID");
      assert.equal((await fin("POST", "/integrations/finance/v1/link-tokens", { requestId: id, code })).status, 200);
    });

    await test("A11 登录后、换授权前改了密码 / 角色 / 封禁：码作废，不会换出一条带新密码指纹的授权", async () => {
      const before = await db.user.findUnique({ where: { id: CLIENT_C } });
      const id1 = await newRequest();
      const code1 = await authorizeCode(id1, CLIENT_C);
      await db.user.update({ where: { id: CLIENT_C }, data: { passwordHash: hashPassword("Another-pass-999") } });
      try {
        assert.equal((await fin("POST", "/integrations/finance/v1/link-tokens", { requestId: id1, code: code1 })).body.code, "LINK_CODE_INVALID");
      } finally {
        await db.user.update({ where: { id: CLIENT_C }, data: { passwordHash: before.passwordHash } });
      }

      const id2 = await newRequest();
      const code2 = await authorizeCode(id2, CLIENT_C);
      await db.user.update({ where: { id: CLIENT_C }, data: { role: "agent" } });
      try {
        assert.equal((await fin("POST", "/integrations/finance/v1/link-tokens", { requestId: id2, code: code2 })).body.code, "LINK_CODE_INVALID");
      } finally {
        await db.user.update({ where: { id: CLIENT_C }, data: { role: "client" } });
      }

      const id3 = await newRequest();
      const code3 = await authorizeCode(id3, CLIENT_C);
      await db.user.update({ where: { id: CLIENT_C }, data: { status: "inactive" } });
      try {
        assert.equal((await fin("POST", "/integrations/finance/v1/link-tokens", { requestId: id3, code: code3 })).body.code, "LINK_CODE_INVALID");
      } finally {
        await db.user.update({ where: { id: CLIENT_C }, data: { status: "active" } });
      }

      const id4 = await newRequest();
      const code4 = await authorizeCode(id4, CLIENT_C);
      await db.user.update({ where: { id: CLIENT_C }, data: { companyId: OTHER_CO } });
      try {
        assert.equal((await fin("POST", "/integrations/finance/v1/link-tokens", { requestId: id4, code: code4 })).body.code, "LINK_CODE_INVALID", "换了公司也不行");
      } finally {
        await db.user.update({ where: { id: CLIENT_C }, data: { companyId: CO } });
      }
      assert.equal(await db.financeLinkAuthorization.count({ where: { userId: CLIENT_C } }), 0);
    });

    await test("A11b 换授权中途数据库出错（写授权那句失败）：整个回滚，码不算用掉，修好后还能换", async () => {
      const ref = newRef();
      const id = await newRequest(ref, "写不进去ZZFT");
      const code = await authorizeCode(id, CLIENT);
      await prisma.$executeRawUnsafe(`ALTER TABLE finance_link_authorizations ADD CONSTRAINT zz_ft_block CHECK (warehouse_name <> '写不进去ZZFT')`);
      try {
        const failed = await fin("POST", "/integrations/finance/v1/link-tokens", { requestId: id, code });
        assert.equal(failed.status, 500, failed.text);
        assert.equal((await db.financeLinkRequest.findUnique({ where: { id } })).codeUsedAt, null, "码被用掉了");
        assert.equal(await db.financeLinkAuthorization.count({ where: { warehouseRef: ref } }), 0);
      } finally {
        await prisma.$executeRawUnsafe(`ALTER TABLE finance_link_authorizations DROP CONSTRAINT zz_ft_block`);
      }
      assert.equal((await fin("POST", "/integrations/finance/v1/link-tokens", { requestId: id, code })).status, 200);
    });

    await test("A12 同一个仓 + 同一个账号再授权：旧的撤销、发新的；换一个仓两条并存", async () => {
      const first = await link(CLIENT_B);
      assert.equal((await waybills(first.token)).status, 200);
      const second = await link(CLIENT_B, first.warehouseRef);
      const old = await waybills(first.token);
      assert.equal(old.status, 401);
      assert.equal(old.body.code, "LINK_REVOKED");
      assert.equal(old.body.reason, "REVOKED");
      assert.equal((await waybills(second.token)).status, 200);
      const other = await link(CLIENT_B);
      assert.equal((await waybills(second.token)).status, 200, "另一个仓的授权不影响这一个");
      assert.equal((await waybills(other.token)).status, 200);
      assert.equal(await db.financeLinkAuthorization.count({ where: { userId: CLIENT_B, warehouseRef: first.warehouseRef, revokedAt: null } }), 1);
    });

    await test("A13 同一个仓 + 同一个账号并发换两个不同的请求：最后只留一条有效的", async () => {
      const ref = newRef();
      const pairs = await Promise.all([0, 1, 2, 3].map(async () => {
        const id = await newRequest(ref);
        return { requestId: id, code: await authorizeCode(id, CLIENT_B) };
      }));
      const all = await Promise.all(pairs.map((p) => fin("POST", "/integrations/finance/v1/link-tokens", p)));
      assert.deepEqual(all.map((r) => r.status), [200, 200, 200, 200], all.map((r) => r.text.slice(0, 80)).join("\n"));
      assert.equal(await db.financeLinkAuthorization.count({ where: { warehouseRef: ref, revokedAt: null } }), 1);
    });

    await test("A14 员工和管理员（密码对）403「这个账号不能授权」；请求不被占用", async () => {
      const id = await newRequest();
      for (const account of [STAFF, ADMIN]) {
        const r = await call("POST", "/auth/finance-link/authorize", { body: { requestId: id, account, password: PASSWORD } });
        assert.equal(r.status, 403, r.text);
        assert.equal(r.body.message, "这个账号不能授权");
        assert.ok(!r.text.includes("redirectUrl"));
      }
      assert.equal((await db.financeLinkRequest.findUnique({ where: { id } })).userId, null);
      await authorizeCode(id, CLIENT);
    });

    await test("A15 失败提示一样：密码错、账号不存在、账号被封禁跟 /auth/login 同一个码和说法，不暴露账号存不存在", async () => {
      __resetFailureStoreForTest();
      const id = await newRequest();
      await db.user.update({ where: { id: CLIENT_X }, data: { status: "inactive" } });
      const attempts = [
        { account: CLIENT, password: "wrong-password" },
        { account: "ZZFT-NOT-EXIST", password: "wrong-password" },
        { account: CLIENT_X, password: PASSWORD },
        { account: STAFF, password: "wrong-password" },
      ];
      for (const a of attempts) {
        const viaLink = await call("POST", "/auth/finance-link/authorize", { body: { requestId: id, ...a } });
        const viaLogin = await call("POST", "/auth/login", { body: a });
        assert.equal(viaLink.status, 401, viaLink.text);
        assert.deepEqual(stable(viaLink.body), stable(viaLogin.body), a.account);
      }
      await db.user.update({ where: { id: CLIENT_X }, data: { status: "active" } });
      __resetFailureStoreForTest();
    });

    await test("A16 按 IP 那道限流跟 /auth/login 共用：两边加起来 10 次，第 11 次 429，说法一样", async () => {
      const ip = "10.99.0.1";
      const id = await newRequest();
      for (let i = 0; i < 5; i++) {
        assert.equal((await call("POST", "/auth/finance-link/authorize", { ip, body: { requestId: id, account: "ZZFT-NOPE-1", password: "x" } })).status, 401);
        assert.equal((await call("POST", "/auth/login", { ip, body: { account: "ZZFT-NOPE-2", password: "x" } })).status, 401);
      }
      const blockedA = await call("POST", "/auth/finance-link/authorize", { ip, body: { requestId: id, account: CLIENT, password: PASSWORD } });
      const blockedB = await call("POST", "/auth/login", { ip, body: { account: CLIENT, password: PASSWORD } });
      assert.equal(blockedA.status, 429, blockedA.text);
      assert.equal(blockedB.status, 429);
      assert.equal(blockedA.body.message, blockedB.body.message);
      assert.equal((await db.financeLinkRequest.findUnique({ where: { id } })).userId, null);
      __resetFailureStoreForTest();
    });

    await test("A17 按账号那道失败计数跟 /auth/login 共用：错满 20 次，对的密码也 429；两边都挡；成功登录清零", async () => {
      __resetFailureStoreForTest();
      const id = await newRequest();
      for (let i = 0; i < 10; i++) {
        assert.equal((await call("POST", "/auth/finance-link/authorize", { body: { requestId: id, account: CLIENT_D, password: "wrong" } })).status, 401);
        assert.equal((await call("POST", "/auth/login", { body: { account: CLIENT_D, password: "wrong" } })).status, 401);
      }
      const a = await call("POST", "/auth/finance-link/authorize", { body: { requestId: id, account: CLIENT_D, password: PASSWORD } });
      const b = await call("POST", "/auth/login", { body: { account: CLIENT_D, password: PASSWORD } });
      assert.equal(a.status, 429, a.text);
      assert.equal(b.status, 429);
      assert.equal(a.body.message, b.body.message);
      assert.match(a.body.message, /这个账号密码错太多次了/);
      __resetFailureStoreForTest();
      // 错几次、再成功授权，计数清零（照登录）
      for (let i = 0; i < 19; i++) await call("POST", "/auth/finance-link/authorize", { body: { requestId: id, account: CLIENT_D, password: "wrong" } });
      await authorizeCode(id, CLIENT_D);
      const id2 = await newRequest();
      assert.equal((await call("POST", "/auth/finance-link/authorize", { body: { requestId: id2, account: CLIENT_D, password: "wrong" } })).status, 401, "清零后第一次错还是 401，不是 429");
      __resetFailureStoreForTest();
    });

    await test("A17b 拿不到有效链接的人探不出账号有没有被锁；超长字段直接挡回，不查库、不算密码", async () => {
      __resetFailureStoreForTest();
      for (let i = 0; i < 20; i++) await call("POST", "/auth/login", { body: { account: CLIENT_D, password: "wrong" } });
      assert.equal((await call("POST", "/auth/login", { body: { account: CLIENT_D, password: PASSWORD } })).status, 429, "账号确实被锁了");
      const noLink = await call("POST", "/auth/finance-link/authorize", { body: { requestId: "nope", account: CLIENT_D, password: PASSWORD } });
      assert.equal(noLink.status, 400, noLink.text);
      assert.equal(noLink.body.code, "LINK_REQUEST_INVALID");
      __resetFailureStoreForTest();
      const id = await newRequest();
      const longId = await call("POST", "/auth/finance-link/authorize", { body: { requestId: "x".repeat(300), account: CLIENT, password: PASSWORD } });
      assert.equal(longId.body.code, "LINK_REQUEST_INVALID");
      for (const body of [{ requestId: id, account: "A".repeat(300), password: PASSWORD }, { requestId: id, account: CLIENT, password: "x".repeat(2000) }]) {
        // 错 21 次都还是 401，不是 429：说明超长的直接挡回去了，没进失败计数，也没拿去算密码
        for (let i = 0; i < 21; i++) {
          const r = await call("POST", "/auth/finance-link/authorize", { body });
          assert.equal(r.status, 401, r.text);
          assert.equal(r.body.message, "invalid credentials");
        }
      }
      assert.equal((await db.financeLinkRequest.findUnique({ where: { id } })).userId, null);
      __resetFailureStoreForTest();
    });

    await test("A17c 账号长度：100 位能授权，101 位不能（约定账号不超过 100 位）；300 位密码能登录也能授权", async () => {
      const ok100 = "Z".repeat(100);
      const over101 = "Y".repeat(101);
      const pw = hashPassword(PASSWORD);
      // 开客户账号没限密码长度：300 位的密码能登录，授权页也得认（不能卡得比登录严）
      const longPassword = "Pw9-".repeat(75);
      await db.user.create({ data: { id: "ZZFTLONGPW", companyId: CO, role: "client", name: "长密码", phone: "0", status: "active", passwordHash: hashPassword(longPassword) } });
      const longId = await newRequest();
      assert.equal((await call("POST", "/auth/login", { body: { account: "ZZFTLONGPW", password: longPassword } })).status, 200);
      await authorizeCode(longId, "ZZFTLONGPW", longPassword);
      await db.user.createMany({ data: [ok100, over101].map((id) => ({ id, companyId: CO, role: "client", name: "长账号", phone: "0", status: "active", passwordHash: pw })) });
      const l = await link(ok100);
      assert.equal((await waybills(l.token)).status, 200);
      const id = await newRequest();
      const r = await call("POST", "/auth/finance-link/authorize", { body: { requestId: id, account: over101, password: PASSWORD } });
      assert.equal(r.status, 403, r.text);
      assert.equal(r.body.message, "这个账号不能授权");
      assert.equal((await db.financeLinkRequest.findUnique({ where: { id } })).userId, null);
    });

    await test("A18 已授权过的请求不能再授权（防止并发 / 回退再提交）；过期的、不存在的同一个错；并发只有一次拿到码", async () => {
      const id = await newRequest();
      await authorizeCode(id, CLIENT);
      for (const requestId of [id, "nope", ""]) {
        const r = await call("POST", "/auth/finance-link/authorize", { body: { requestId, account: CLIENT, password: PASSWORD } });
        assert.equal(r.status, 400, r.text);
        assert.equal(r.body.code, "LINK_REQUEST_INVALID");
      }
      const expired = await newRequest();
      await db.financeLinkRequest.update({ where: { id: expired }, data: { expiresAt: new Date(Date.now() - 1000) } });
      assert.equal((await call("POST", "/auth/finance-link/authorize", { body: { requestId: expired, account: CLIENT, password: PASSWORD } })).body.code, "LINK_REQUEST_INVALID");
      const racing = await newRequest();
      const all = await Promise.all([1, 2, 3, 4].map(() => call("POST", "/auth/finance-link/authorize", { body: { requestId: racing, account: CLIENT, password: PASSWORD } })));
      assert.deepEqual(all.map((r) => r.status).sort(), [200, 400, 400, 400]);
    });

    await test("A19 建新请求时顺手删过期的：没拿到码的、码也过期的删；请求过期但码还有效的留着；还没过期的留着", async () => {
      const ref = newRef();
      const mk = (suffix: string, data: Row) => db.financeLinkRequest.create({ data: { id: `${P}req_${suffix}`, warehouseRef: ref, warehouseName: "x", ...data } });
      const past = new Date(Date.now() - 60_000);
      const future = new Date(Date.now() + 60_000);
      await mk("old", { expiresAt: past });
      await mk("oldcode", { expiresAt: past, codeExpiresAt: past });
      await mk("livecode", { expiresAt: past, codeExpiresAt: future });
      await mk("live", { expiresAt: future });
      await newRequest();
      const left: Array<{ id: string }> = await db.financeLinkRequest.findMany({ where: { warehouseRef: ref }, select: { id: true } });
      assert.deepEqual(left.map((r) => r.id).sort(), [`${P}req_live`, `${P}req_livecode`]);
    });

    await test("A20 撤销：200 { ok: true }、重复也 200；撤销后查询 LINK_REVOKED/REVOKED；没带授权 400；密钥错 401", async () => {
      const { token, authorizationId } = await link(CLIENT);
      const r1 = await fin("POST", "/integrations/finance/v1/link-tokens/revoke", undefined, token);
      assert.equal(r1.status, 200);
      assert.deepEqual(r1.body, { ok: true });
      assert.deepEqual((await fin("POST", "/integrations/finance/v1/link-tokens/revoke", undefined, token)).body, { ok: true });
      assert.deepEqual((await fin("POST", "/integrations/finance/v1/link-tokens/revoke", undefined, "unknown-token")).body, { ok: true });
      const q = await waybills(token);
      assert.equal(q.status, 401);
      assert.equal(q.body.reason, "REVOKED");
      const row = await db.financeLinkAuthorization.findUnique({ where: { id: authorizationId } });
      assert.equal(row.revokedReason, "REVOKED");
      assert.ok(row.revokedAt);
      assert.equal((await fin("POST", "/integrations/finance/v1/link-tokens/revoke")).status, 400);
      assert.equal((await call("POST", "/integrations/finance/v1/link-tokens/revoke", { headers: { "x-link-token": token } })).body.code, "LINK_SECRET_INVALID");
    });

    console.log("\n【运单范围】");
    const clientLink = await link(CLIENT);
    const agentLink = await link(AGENT);

    await test("B1 普通客户只看到自己的：clients 空、没有 clientName、字段逐个对上", async () => {
      const r = await waybills(clientLink.token);
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.body.account, { account: CLIENT, role: "client" });
      assert.deepEqual(r.body.clients, []);
      assert.deepEqual(trackingNos(r), ["ZZFT0000001", "ZZFT0000002"]);
      assert.equal(r.body.total, 2);
      assert.deepEqual(Object.keys(r.body).sort(), ["account", "clients", "items", "page", "pageSize", "total"]);
      const item = (r.body.items as Row[]).find((i) => i.trackingNo === "ZZFT0000001")!;
      assert.deepEqual(item, {
        trackingNo: "ZZFT0000001", clientId: CLIENT, productNames: "鞋子A1", packageCount: 3, packageUnit: "箱", weightKg: 30, volumeM3: 1.5,
        totalWeightKg: item.totalWeightKg, totalVolumeM3: item.totalVolumeM3, transportMode: "sea", domesticTrackingNo: "SFZZFT0001",
        currentStatus: "customsCleared", statusZh: "清关已放行", partialAhead: "inWarehouseTH", statusGroup: "transit", updatedAt: item.updatedAt,
      });
      assert.ok(!("clientName" in item));
    });

    await test("B2 代理只看到名下的：有 clients 和 clientName；能按客户筛；筛别人的客户是 0", async () => {
      const r = await waybills(agentLink.token);
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.body.account, { account: AGENT, role: "agent" });
      assert.deepEqual(r.body.clients, [{ clientId: CLIENT_B, name: CLIENT_B }, { clientId: CLIENT_C, name: CLIENT_C }], "name 填唛头");
      assert.deepEqual(trackingNos(r), ["ZZFT0000011", "ZZFT0000012", "ZZFT0000021"]);
      assert.equal((r.body.items as Row[]).find((i) => i.clientId === CLIENT_C)!.clientName, CLIENT_C, "clientName 的值是唛头");
      assert.deepEqual(trackingNos(await waybills(agentLink.token, `?clientId=${CLIENT_C}`)), ["ZZFT0000021"]);
      for (const other of [CLIENT, CLIENT_D, CLIENT_X]) {
        const none = await waybills(agentLink.token, `?clientId=${other}`);
        assert.equal(none.body.total, 0, other);
        assert.deepEqual(none.body.items, []);
      }
      assert.equal((await waybills(clientLink.token, `?clientId=${CLIENT_X}`)).body.total, 0, "普通客户筛别人也是 0");
    });

    await test("B2b 归代理的客户自己授权：只看到自己的，不会变成看代理名下全部客户", async () => {
      const own = await link(CLIENT_C);
      const r = await waybills(own.token);
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.body.account, { account: CLIENT_C, role: "client" });
      assert.deepEqual(r.body.clients, []);
      assert.deepEqual(trackingNos(r), ["ZZFT0000021"]);
      assert.equal((await track(own.token, "ZZFT0000011")).status, 404, "同一个代理名下别的客户的单");
    });

    await test("B2c 一票多款的国内单号全带上，跟代理端列表显示的一样", async () => {
      const item = ((await waybills(agentLink.token, "?trackingNo=ZZFT0000012")).body.items as Row[])[0];
      assert.equal(item.domesticTrackingNo, "SFP1、SFP2、SFZZFT0001");
      assert.equal(item.productNames, "灯具甲 / 灯具乙");
    });

    await test("B3 客户转走后立刻看不到（列表、筛选、轨迹）；转回来又看得到", async () => {
      assert.equal((await track(agentLink.token, "ZZFT0000021")).status, 200);
      await db.user.update({ where: { id: CLIENT_C }, data: { agentId: `${P}ag2` } });
      try {
        const r = await waybills(agentLink.token);
        assert.deepEqual(trackingNos(r), ["ZZFT0000011", "ZZFT0000012"]);
        assert.ok(!(r.body.clients as Row[]).some((c) => c.clientId === CLIENT_C));
        assert.equal((await track(agentLink.token, "ZZFT0000021")).status, 404);
      } finally {
        await db.user.update({ where: { id: CLIENT_C }, data: { agentId: `${P}ag1` } });
      }
      assert.equal((await track(agentLink.token, "ZZFT0000021")).status, 200);
    });

    await test("B4 代理账号 agentId 是空的（脏数据）：当没有名下客户，绝不放大成全公司", async () => {
      const dirty = await link(AGENT2);
      await db.user.update({ where: { id: AGENT2 }, data: { agentId: null } });
      try {
        const r = await waybills(dirty.token);
        assert.equal(r.status, 200);
        assert.equal(r.body.total, 0);
        assert.deepEqual(r.body.clients, []);
        assert.equal((await track(dirty.token, "ZZFT0000031")).status, 404);
      } finally {
        await db.user.update({ where: { id: AGENT2 }, data: { agentId: `${P}ag2` } });
      }
    });

    await test("B5 总数跟物流客户端、代理端列表一致（数字打印出来）；每个状态分组都对得上", async () => {
      const clientToken = loginToken(CLIENT, "client");
      const agentToken = loginToken(AGENT, "agent");
      const portalClient = await call("GET", "/client/orders?pageSize=500", { headers: asUser(clientToken) });
      const portalAgent = await call("GET", "/agent/shipments?pageSize=200", { headers: asUser(agentToken) });
      assert.equal(portalClient.status, 200, portalClient.text.slice(0, 200));
      assert.equal(portalAgent.status, 200, portalAgent.text.slice(0, 200));
      const financeClient = await waybills(clientLink.token, "?pageSize=100");
      const financeAgent = await waybills(agentLink.token, "?pageSize=100");
      console.log(`     客户 ${CLIENT}：物流客户端 ${portalClient.body.data.total} = 新接口 ${financeClient.body.total}；代理 ${AGENT}：物流代理端 ${portalAgent.body.data.total} = 新接口 ${financeAgent.body.total}`);
      assert.equal(financeClient.body.total, portalClient.body.data.total);
      assert.equal(financeAgent.body.total, portalAgent.body.data.total);
      const nos = (items: Row[]) => items.map((i) => i.trackingNo as string).sort();
      assert.deepEqual(trackingNos(financeClient), nos(portalClient.body.data.items));
      assert.deepEqual(trackingNos(financeAgent), nos(portalAgent.body.data.items));
      for (const group of ["pending", "transit", "arrived", "delivered", "closed", "attention", "all"]) {
        const f = await waybills(agentLink.token, `?statusGroup=${group}&pageSize=100`);
        const a = await call("GET", `/agent/shipments?statusGroup=${group}&pageSize=200`, { headers: asUser(agentToken) });
        assert.equal(f.body.total, a.body.data.total, group);
        assert.deepEqual(trackingNos(f), nos(a.body.data.items), group);
      }
      // 普通客户：逐票比状态中文 / 部分放行，就是客户那一列显示的那两样
      for (const item of financeClient.body.items as Row[]) {
        const same = (portalClient.body.data.items as Row[]).find((i) => i.trackingNo === item.trackingNo)!;
        assert.equal(item.statusZh, shipmentStatusZh(same.currentStatus, CLIENT_STATUS_ZH_OVERRIDES), item.trackingNo);
        assert.equal(item.partialAhead ?? undefined, same.partialAhead ?? undefined, item.trackingNo);
        assert.equal(item.totalVolumeM3, Number(same.totalVolumeM3), item.trackingNo);
      }
      // 代理：逐票逐字段比（不是只看字段在不在）
      for (const item of financeAgent.body.items as Row[]) {
        const same = (portalAgent.body.data.items as Row[]).find((i) => i.trackingNo === item.trackingNo)!;
        for (const key of ["clientId", "productNames", "packageCount", "packageUnit", "weightKg", "volumeM3", "totalWeightKg", "totalVolumeM3", "transportMode", "currentStatus", "statusGroup", "updatedAt"]) {
          assert.deepEqual(item[key], same[key], `${item.trackingNo} ${key}`);
        }
        assert.equal(item.partialAhead ?? undefined, same.partialAhead ?? undefined, item.trackingNo);
      }
      const bad = await waybills(agentLink.token, "?statusGroup=nope");
      assert.equal(bad.status, 400, "筛选规则沿用代理端：不认识的分组 400");
    });

    await test("B6 整柜、集货、没审过的单不出现；轨迹回同一个 404（不存在、别人的也一样）", async () => {
      const listed = trackingNos(await waybills(clientLink.token, "?pageSize=100"));
      for (const no of ["ZZFTFCL0001", "ZZFT0000003", "JH-ZZFT0001", "JHZZFT0001"]) assert.ok(!listed.includes(no), no);
      const agentListed = trackingNos(await waybills(agentLink.token, "?pageSize=100"));
      assert.ok(!agentListed.includes("JH-ZZFT0001"));
      const responses = await Promise.all(["ZZFTFCL0001", "ZZFT0000003", "JH-ZZFT0001", "JHZZFT0001", "ZZFT0000091", "ZZFT0000011", "NOT-EXIST"].map((no) => track(clientLink.token, no)));
      for (const r of responses) assert.equal(r.status, 404, r.text);
      assert.equal(new Set(responses.map((r) => JSON.stringify(stable(r.body)))).size, 1, "404 必须一模一样");
      const agentResponses = await Promise.all(["ZZFT0000001", "ZZFT0000031", "ZZFT0000091", "JH-ZZFT0001"].map((no) => track(agentLink.token, no)));
      for (const r of agentResponses) assert.equal(r.status, 404, r.text);
      assert.equal(JSON.stringify(stable(agentResponses[0].body)), JSON.stringify(stable(responses[0].body)));
    });

    await test("B7 轨迹：字段对；父单合并自己 + 子单、按时间排；子单列表对；查子单只有自己的", async () => {
      const r = await track(clientLink.token, "ZZFT0000001");
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(Object.keys(r.body).sort(), ["children", "currentStatus", "logs", "statusZh", "trackingNo"]);
      assert.equal(r.body.statusZh, "清关已放行");
      const logs = r.body.logs as Row[];
      assert.equal(logs.length, 6);
      assert.deepEqual(logs.map((l) => l.status), ["inWarehouseCN", "loaded", "loaded", "departed", "customsCleared", "inWarehouseTH"]);
      assert.deepEqual(logs.map((l) => l.at), [...logs.map((l) => l.at)].sort());
      for (const l of logs) assert.deepEqual(Object.keys(l).sort(), ["at", "nextStop", "remark", "status", "statusZh"]);
      assert.deepEqual(r.body.children, [
        { trackingNo: "ZZFT0000001-1", currentStatus: "inWarehouseTH", statusZh: "已到仓" },
        { trackingNo: "ZZFT0000001-2", currentStatus: "customsCleared", statusZh: "清关已放行" },
      ]);
      const child = await track(clientLink.token, "ZZFT0000001-1");
      assert.equal(child.status, 200);
      assert.deepEqual(child.body.children, []);
      assert.equal((child.body.logs as Row[]).length, 3);
      const noParam = await fin("GET", "/integrations/finance/v1/waybills/track", undefined, clientLink.token);
      assert.equal(noParam.status, 400);
    });

    await test("B8 脏数据：子单挂在别家订单上，代理看父单时不带出来；挂在同一个客户没审过 / 整柜的单上，客户看父单也不带出来，直接查也 404", async () => {
      const own = await track(clientLink.token, "ZZFT0000001");
      assert.ok(!own.text.includes("SECRETDIRTY"), own.text.slice(0, 300));
      assert.ok(!own.text.includes("ZZFT0000001-8") && !own.text.includes("ZZFT0000001-7"));
      for (const no of ["ZZFT0000001-8", "ZZFT0000001-7"]) assert.equal((await track(clientLink.token, no)).status, 404, no);
      const r = await track(agentLink.token, "ZZFT0000011");
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.body.children, []);
      assert.ok(!r.text.includes("SECRETDIRTY"));
      assert.ok(!r.text.includes("ZZFT0000011-9"));
    });

    await test("B9 响应全文搜不到柜号、金额、收件人、操作人、内部 id、内部备注；备注里的柜号确实抹了（不是字段恰好空）", async () => {
      const responses = await Promise.all([
        waybills(clientLink.token, "?pageSize=100"),
        waybills(agentLink.token, "?pageSize=100"),
        track(clientLink.token, "ZZFT0000001"),
        track(clientLink.token, "ZZFT0000001-1"),
        track(clientLink.token, "ZZFT0000002"),
        track(agentLink.token, "ZZFT0000011"),
        track(agentLink.token, "ZZFT0000021"),
      ]);
      const hits: string[] = [];
      for (const r of responses) {
        assert.equal(r.status, 200, r.text.slice(0, 200));
        for (const word of MUST_NOT_LEAK) if (r.text.includes(word)) hits.push(word);
      }
      assert.deepEqual([...new Set(hits)], [], "响应里出现了");
      const logs = responses[2].body.logs as Row[];
      assert.equal(logs.find((l) => l.status === "loaded" && (l.remark as string).includes("已装柜"))?.remark, "已装柜（分装 2件）");
      assert.equal(logs.find((l) => l.status === "departed")!.remark, "柜号（不对外显示） 今日开船");
      assert.ok((logs.find((l) => l.status === "inWarehouseTH")!.remark as string).includes("柜号已隐藏"), "只在 batch_no 里有的手写柜号也要抹");
      const handwritten = (responses[5].body.logs as Row[]).find((l) => (l.remark as string).includes("今天到"))!;
      assert.equal(handwritten.remark, "柜号（不对外显示） 今天到", "两个手写柜号都抹掉，后半句留着");
      assert.equal(handwritten.nextStop, "柜号（不对外显示）");
      assert.equal(logs.find((l) => l.status === "loaded" && (l.nextStop as string))?.nextStop, "柜号已隐藏 去林查班");
      assert.equal(logs.find((l) => l.status === "customsCleared")!.remark, "把「鞋子A1」的货型由普货改为商检", "代码拼的「管理员」抹掉");
      // 夹具真的有这些值：反过来查一下库，别是白搜
      assert.equal((await db.user.findUnique({ where: { id: CLIENT_B } })).name, "代理客户乙");
      const fixture = await db.order.findUnique({ where: { id: `${P}o_a1` } });
      assert.equal(Number(fixture.receivableAmountCny), 8765.43);
      assert.equal(fixture.batchNo, BATCH_ONLY);
    });

    await test("B10 翻页和筛选：pageSize 上限 100；页码不合法 400；运单号、关键字筛选跟代理端一样", async () => {
      const big = await waybills(clientLink.token, "?pageSize=5000");
      assert.equal(big.body.pageSize, 100);
      const first = await waybills(clientLink.token, "?pageSize=1&page=1");
      const second = await waybills(clientLink.token, "?pageSize=1&page=2");
      assert.equal(first.body.total, 2);
      assert.equal((first.body.items as Row[]).length, 1);
      assert.notEqual(first.body.items[0].trackingNo, second.body.items[0].trackingNo);
      assert.deepEqual((await waybills(clientLink.token, "?page=9")).body.items, []);
      for (const q of ["?page=0", "?page=abc", "?pageSize=-1", "?page=1e400"]) assert.equal((await waybills(clientLink.token, q)).status, 400, q);
      assert.deepEqual(trackingNos(await waybills(clientLink.token, "?trackingNo=ZZFT0000002")), ["ZZFT0000002"]);
      assert.deepEqual(trackingNos(await waybills(clientLink.token, "?trackingNo=ZZFT0000001-2")), ["ZZFT0000001"], "搜子单号命中父单那一行（同代理端）");
      assert.deepEqual(trackingNos(await waybills(clientLink.token, `?keyword=${encodeURIComponent("衣服")}`)), ["ZZFT0000002"]);
      // 约定不接日期：日期参数不起作用，2026-99-99 这种也不会变成 500
      for (const q of ["?dateTo=2026-99-99", "?dateFrom=2099-01-01", "?dateFrom=2026-02-31&dateTo=2026-02-31"]) {
        const r = await waybills(clientLink.token, q);
        assert.equal(r.status, 200, `${q}: ${r.text.slice(0, 120)}`);
        assert.equal(r.body.total, 2, q);
      }
    });

    console.log("\n【每次查询都核对】");
    await test("D1 封禁：立刻 401 LINK_REVOKED/ACCOUNT_DISABLED，库里写成已撤销；解封后也不恢复，原因不变", async () => {
      const l = await link(CLIENT_D);
      assert.equal((await waybills(l.token)).status, 200);
      await db.user.update({ where: { id: CLIENT_D }, data: { status: "inactive" } });
      for (const r of [await waybills(l.token), await track(l.token, "ZZFT0000031")]) {
        assert.equal(r.status, 401, r.text);
        assert.equal(r.body.code, "LINK_REVOKED");
        assert.equal(r.body.reason, "ACCOUNT_DISABLED");
        assert.ok(typeof r.body.message === "string" && r.body.message);
      }
      const row = await db.financeLinkAuthorization.findUnique({ where: { id: l.authorizationId } });
      assert.equal(row.revokedReason, "ACCOUNT_DISABLED");
      assert.ok(row.revokedAt);
      await db.user.update({ where: { id: CLIENT_D }, data: { status: "active" } });
      const again = await waybills(l.token);
      assert.equal(again.status, 401);
      assert.equal(again.body.reason, "ACCOUNT_DISABLED");
    });

    await test("D2 改密码（走真的 /auth/change-password）：立刻 401 PASSWORD_CHANGED；旧密码授权不了，新密码重新授权恢复", async () => {
      const l = await link(CLIENT_X);
      assert.equal((await waybills(l.token)).status, 200);
      const newPw = "Changed-pass-Zz999";
      const changed = await call("POST", "/auth/change-password", { headers: asUser(signAuthToken({ userId: CLIENT_X, companyId: CO, role: "client", userName: CLIENT_X })), body: { oldPassword: PASSWORD, newPassword: newPw } });
      assert.equal(changed.status, 200, changed.text);
      const r = await waybills(l.token);
      assert.equal(r.status, 401);
      assert.equal(r.body.code, "LINK_REVOKED");
      assert.equal(r.body.reason, "PASSWORD_CHANGED");
      assert.equal((await db.financeLinkAuthorization.findUnique({ where: { id: l.authorizationId } })).revokedReason, "PASSWORD_CHANGED");
      const id = await newRequest();
      assert.equal((await call("POST", "/auth/finance-link/authorize", { body: { requestId: id, account: CLIENT_X, password: PASSWORD } })).status, 401, "旧密码不行");
      const code = await authorizeCode(id, CLIENT_X, newPw);
      const fresh = await fin("POST", "/integrations/finance/v1/link-tokens", { requestId: id, code });
      assert.equal(fresh.status, 200);
      assert.equal((await waybills(fresh.body.token)).status, 200);
      assert.equal((await waybills(l.token)).status, 401, "旧授权不复活");
      __resetFailureStoreForTest();
    });

    await test("D3 改角色：立刻 401 ROLE_CHANGED；改回去也不恢复", async () => {
      const l = await link(CLIENT_B);
      await db.user.update({ where: { id: CLIENT_B }, data: { role: "staff" } });
      try {
        const r = await waybills(l.token);
        assert.equal(r.status, 401);
        assert.equal(r.body.code, "LINK_REVOKED");
        assert.equal(r.body.reason, "ROLE_CHANGED");
      } finally {
        await db.user.update({ where: { id: CLIENT_B }, data: { role: "client" } });
      }
      assert.equal((await waybills(l.token)).body.reason, "ROLE_CHANGED");
    });

    await test("D4 停代理（走真的 /admin/agents/login-status 接口）：代理的授权 ACCOUNT_DISABLED；名下客户自己的授权不受影响", async () => {
      const agentL = await link(AGENT);
      const clientL = await link(CLIENT_C);
      const stop = await call("POST", "/admin/agents/login-status", { headers: asUser(loginToken(ADMIN, "admin")), body: { id: `${P}ag1`, status: "inactive" } });
      assert.equal(stop.status, 200, stop.text);
      try {
        assert.equal((await waybills(agentL.token)).body.reason, "ACCOUNT_DISABLED");
        assert.equal((await waybills(clientL.token)).status, 200);
      } finally {
        await db.user.updateMany({ where: { id: AGENT }, data: { status: "active" } });
      }
    });

    await test("D5 账号被删：当封禁处理", async () => {
      await db.user.create({ data: { id: "ZZFTGONE", companyId: CO, role: "client", name: "要删的", phone: "0", status: "active", passwordHash: hashPassword(PASSWORD) } });
      const l = await link("ZZFTGONE");
      await db.user.delete({ where: { id: "ZZFTGONE" } });
      assert.equal((await waybills(l.token)).body.reason, "ACCOUNT_DISABLED");
    });

    await test("D5b 账号换了公司：当封禁处理，写库撤销", async () => {
      const l = await link(CLIENT_D);
      await db.user.update({ where: { id: CLIENT_D }, data: { companyId: OTHER_CO } });
      try {
        const r = await waybills(l.token);
        assert.equal(r.status, 401, r.text);
        assert.equal(r.body.reason, "ACCOUNT_DISABLED");
      } finally {
        await db.user.update({ where: { id: CLIENT_D }, data: { companyId: CO } });
      }
      assert.equal((await db.financeLinkAuthorization.findUnique({ where: { id: l.authorizationId } })).revokedReason, "ACCOUNT_DISABLED");
    });

    await test("D6 密钥错和授权错码不同；密钥错不改授权状态；缺授权、乱写授权都是 LINK_REVOKED/REVOKED", async () => {
      const l = await link(CLIENT);
      const wrongSecret = await call("GET", "/integrations/finance/v1/waybills", { headers: { authorization: "Bearer not-the-secret", "x-link-token": l.token } });
      assert.equal(wrongSecret.status, 401);
      assert.equal(wrongSecret.body.code, "LINK_SECRET_INVALID");
      assert.ok(!("reason" in wrongSecret.body));
      assert.equal((await waybills(l.token)).status, 200, "密钥错那次不许把授权弄失效");
      for (const r of [await fin("GET", "/integrations/finance/v1/waybills"), await waybills("garbage-token"), await waybills("x".repeat(500))]) {
        assert.equal(r.status, 401, r.text);
        assert.equal(r.body.code, "LINK_REVOKED");
        assert.equal(r.body.reason, "REVOKED");
      }
    });

    await test("D7 登录令牌进不来：拿真的客户登录令牌当密钥 → LINK_SECRET_INVALID；这几条不跑登录解析（日志不多一句「认证失败」）", async () => {
      const l = await link(CLIENT);
      const before = captured.filter((line) => line.includes("认证失败")).length;
      const r = await call("GET", "/integrations/finance/v1/waybills", { headers: { authorization: `Bearer ${loginToken(CLIENT, "client")}`, "x-link-token": l.token } });
      assert.equal(r.body.code, "LINK_SECRET_INVALID");
      const garbage = await call("GET", "/integrations/finance/v1/waybills", { headers: { authorization: "Bearer aaa.bbb.ccc" } });
      assert.equal(garbage.body.code, "LINK_SECRET_INVALID");
      assert.equal(captured.filter((line) => line.includes("认证失败")).length, before);
      assert.equal((await call("GET", `/client/orders`, { headers: { authorization: `Bearer ${SECRET}` } })).status, 401, "对接密钥也进不了客户接口");
    });

    await test("D8 last_used_at：第一次写；一小时内不再写；超过一小时再写", async () => {
      const l = await link(CLIENT);
      const read = () => db.financeLinkAuthorization.findUnique({ where: { id: l.authorizationId } }).then((r: Row) => r.lastUsedAt as Date | null);
      assert.equal(await read(), null);
      await waybills(l.token);
      const first = await read();
      assert.ok(first);
      const stamp = new Date(Date.now() - 30 * 60_000);
      await db.financeLinkAuthorization.update({ where: { id: l.authorizationId }, data: { lastUsedAt: stamp } });
      await waybills(l.token);
      assert.equal((await read())!.getTime(), stamp.getTime(), "半小时前写过，不再写");
      await db.financeLinkAuthorization.update({ where: { id: l.authorizationId }, data: { lastUsedAt: new Date(Date.now() - 61 * 60_000) } });
      await waybills(l.token);
      assert.ok(Date.now() - (await read())!.getTime() < 60_000, "超过一小时要更新");
    });

    console.log("\n【总开关】");
    await test("G1 总开关没开 / 配置不合格：7 条接口全 503 LINK_DISABLED；授权状态不变；进程不退", async () => {
      const l = await link(CLIENT);
      const id = await newRequest();
      const every = () => Promise.all([
        fin("POST", "/integrations/finance/v1/link-requests", { warehouseRef: newRef(), warehouseName: "x" }),
        fin("POST", "/integrations/finance/v1/link-tokens", { requestId: id, code: "x" }),
        fin("POST", "/integrations/finance/v1/link-tokens/revoke", undefined, l.token),
        waybills(l.token),
        track(l.token, "ZZFT0000001"),
        call("GET", `/auth/finance-link/request?request=${encodeURIComponent(id)}`),
        call("POST", "/auth/finance-link/authorize", { body: { requestId: id, account: CLIENT, password: PASSWORD } }),
      ]);
      const expectAll503 = async (label: string) => {
        for (const r of await every()) {
          assert.equal(r.status, 503, `${label}: ${r.text}`);
          assert.equal(r.body.code, "LINK_DISABLED", label);
        }
      };
      const saved = { en: process.env.FINANCE_LINK_ENABLED, sec: process.env.FINANCE_LINK_SECRET, url: process.env.FINANCE_LINK_RETURN_URL };
      try {
        delete process.env.FINANCE_LINK_ENABLED;
        await expectAll503("没设开关");
        process.env.FINANCE_LINK_ENABLED = "false";
        await expectAll503("开关 false");
        process.env.FINANCE_LINK_ENABLED = "true";
        process.env.FINANCE_LINK_SECRET = "too-short";
        await expectAll503("密钥太短");
        process.env.FINANCE_LINK_SECRET = saved.sec;
        process.env.FINANCE_LINK_RETURN_URL = "https://x.com/cb?evil=1";
        await expectAll503("跳回地址带 ?");
      } finally {
        process.env.FINANCE_LINK_ENABLED = saved.en;
        process.env.FINANCE_LINK_SECRET = saved.sec;
        process.env.FINANCE_LINK_RETURN_URL = saved.url;
      }
      assert.equal((await waybills(l.token)).status, 200, "开回来授权照常");
      assert.equal((await db.financeLinkRequest.findUnique({ where: { id } })).userId, null);
    });

    await test("G2 开关关着不影响现有登录", async () => {
      const saved = process.env.FINANCE_LINK_ENABLED;
      delete process.env.FINANCE_LINK_ENABLED;
      try {
        const r = await call("POST", "/auth/login", { body: { account: CLIENT, password: PASSWORD } });
        assert.equal(r.status, 200, r.text);
        assert.ok(r.body.data.token);
      } finally {
        process.env.FINANCE_LINK_ENABLED = saved;
      }
    });

    console.log("\n【日志】");
    await test("L1 整个测试过程的日志里没有密码、长期授权、一次性码、对接密钥", async () => {
      const id = await newRequest();
      const code = await authorizeCode(id, CLIENT);
      const issued = await fin("POST", "/integrations/finance/v1/link-tokens", { requestId: id, code });
      const token = issued.body.token as string;
      await waybills(token);
      await fin("POST", "/integrations/finance/v1/link-tokens/revoke", undefined, token);
      const all = captured.join("\n");
      for (const secret of [PASSWORD, "Changed-pass-Zz999", code, token, SECRET]) {
        assert.ok(!all.includes(secret), `日志里出现了 ${secret.slice(0, 6)}…`);
      }
    });

    // 迁移文件：要临时建库，只许在本机一次性库上做，Neon 和生产绝不碰
    const u = new URL(url);
    if (["127.0.0.1", "localhost", "::1", "[::1]"].includes(u.hostname) && process.env.AGENT_PORTAL_TEST_ALLOW_DB === "1") {
      console.log("\n【迁移文件】");
      const runPrisma = (args: string[], dbUrl: string): { code: number; out: string } => {
        try {
          const out = execFileSync("npx", ["prisma", ...args], { cwd: ROOT, env: { ...process.env, DATABASE_URL: dbUrl }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
          return { code: 0, out };
        } catch (e: any) {
          return { code: typeof e.status === "number" ? e.status : 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
        }
      };
      const tmpName = `zz_mig_finance_link_${Date.now().toString(36)}`;
      const tmp = new URL(url);
      tmp.pathname = `/${tmpName}`;
      const tmpUrl = tmp.toString();
      await prisma.$executeRawUnsafe(`CREATE DATABASE "${tmpName}"`);
      const tmpDb = new PrismaClient({ datasources: { db: { url: tmpUrl } } });
      try {
        await test("M1 上线前的库上跑两遍都不报错；跑完跟 schema.prisma 零差异；上线体检一行不报；现有数据一行不动", async () => {
          const push = runPrisma(["db", "push", `--schema=${SCHEMA}`, "--skip-generate"], tmpUrl);
          assert.equal(push.code, 0, `临时库建结构失败：${push.out.slice(-400)}`);
          await tmpDb.$executeRawUnsafe(`DROP TABLE "finance_link_authorizations"`);
          await tmpDb.$executeRawUnsafe(`DROP TABLE "finance_link_requests"`);
          await tmpDb.$executeRawUnsafe(`INSERT INTO users (id, company_id, role, name, phone, status, password_hash) VALUES ('ZZM1', 'c_zz', 'client', '测试客户', '000', 'active', 'hash-keep')`);
          for (const n of [1, 2]) {
            const r = runPrisma(["db", "execute", `--schema=${SCHEMA}`, "--file", MIGRATION], tmpUrl);
            assert.equal(r.code, 0, `第 ${n} 遍失败：${r.out.slice(-400)}`);
          }
          const diff = runPrisma(["migrate", "diff", "--from-url", tmpUrl, "--to-schema-datamodel", SCHEMA, "--script", "--exit-code"], tmpUrl);
          assert.equal(diff.code, 0, `还差这些：\n${diff.out.split("\n").filter((l) => l.trim() && !l.startsWith("--")).slice(0, 12).join("\n")}`);
          const drift = await tmpDb.$queryRawUnsafe<Row[]>(readFileSync(DRIFT, "utf8"));
          assert.equal(drift.length, 0, `上线体检报了：${JSON.stringify(drift).slice(0, 300)}`);
          const rows = await tmpDb.$queryRawUnsafe<Row[]>(`SELECT password_hash, status FROM users WHERE id = 'ZZM1'`);
          assert.deepEqual(rows, [{ password_hash: "hash-keep", status: "active" }]);
          await tmpDb.$executeRawUnsafe(`DELETE FROM users WHERE id = 'ZZM1'`);
        });
      } finally {
        await tmpDb.$disconnect();
        await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${tmpName}" WITH (FORCE)`);
      }
    } else {
      console.log("\n【迁移文件】这一段要临时建库，只在本机一次性库上跑（CI 的 test-db 那一组会真跑）");
    }
  } finally {
    await cleanup();
    const left = await db.user.count({ where: { companyId: { in: COMPANIES } } }) + await db.financeLinkAuthorization.count({ where: { companyId: { in: COMPANIES } } }) + await db.financeLinkRequest.count({ where: { warehouseRef: { startsWith: P } } });
    if (left !== 0) { failures++; console.log(`  ❌ 测试数据没清干净，剩 ${left} 行`); }
    await prisma.$disconnect();
  }

  console.log(`\n通过 ${passes}，失败 ${failures}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
