/**
 * 仓库版集货改长期价 + 付款快照 + 超管客户管理 自测（2026-09-16，B1）。**不连数据库、不连外网。**
 * 需求：docs/交接文档-附件-代理账号确认单/final.md（不进 git）4.4-4.7 / 4.14 / 4.19 / 3.12 / 2.2 / 2.9 / 6.3。
 *
 * 真调路由（内存库见 scripts/whr-memory-db.ts），盯住这几件事：
 *   1. 建柜 / 往柜里加客户：不再收单价，按长期价带出；没长期价 400「暂未配对价格，请联系管理员」；
 *      锁序【客户价排队锁 → 计划】（多个客户按 clientId 排序），价格在锁里读（锁前价被删也拦得住）
 *   2. 柜里「改单价」停用 410；审核拒绝不再改价
 *   3. 改货型 / 删货品：没付款的单自动重算；已付款的改不了
 *   4. 付款写快照（代理客户记代理价和返现、湘泰客户代理几列为空、返现负数记 0）；撤销付款、作废已付款的单清快照；
 *      付款这条路不去锁代理行
 *   5. 超管改长期价：代理的客户 403（锁前归属刚改成代理也拦）；湘泰客户改完没付款的单重算
 *   6. **员工能碰到的所有响应、客户能碰到的响应里没有代理 id / 代理名 / 代理价 / 返现**
 *   7. 超管客户列表带所属代理和长期价；代理登录号卡密码强度；改归属只许没业务记录、且长期价不低于代理价
 *   8. 客户端「有没有长期价」；超管替客户填泰国地址（发运后不许改、锁里重判）
 *
 * ⚠️ 验证方式照 CLAUDE.md #28⑤：每条「锁里重判」都用 mem.onEvent 在锁的那一刻改数据，
 *    证明事务外那次判断之后发生的变化照样被拦住，不是只测了事务外那道提示。
 */
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/never?connect_timeout=1";
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { assertBefore, callRoute, installMemoryPrisma, loadRoutes, mem, resetMemory, writes, type Row } from "./whr-memory-db";

installMemoryPrisma();

const failures: string[] = [];
let total = 0;
async function check(name: string, body: () => Promise<void> | void): Promise<void> {
  total += 1;
  try {
    await body();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push(name);
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.log(`  ❌ ${name}\n     ${message.split("\n").slice(0, 8).join("\n     ")}`);
  }
}

/* ─────────────────────────── 身份 ─────────────────────────── */

const AGENT_ID = "zz_b1_AGT";
const AGENT_NAME = "代理甲乙丙";
const C_AG = "zz_b1_cA"; // 代理的客户
const C_XT = "zz_b1_cX"; // 湘泰自己的客户（长期价是上线回填的）
const C_NOPRICE = "zz_b1_cN"; // 没长期价
const C_NEW_LOW = "zz_b1_cL"; // 没业务记录，长期价低于代理价
const C_NEW = "zz_b1_cZ"; // 没业务记录，没长期价
const P1 = "zz_b1_P1";
const P2 = "zz_b1_P2";
const PC_A = "zz_b1_pcA";
const PC_X = "zz_b1_pcX";
const PA_A = "zz_b1_paA";
const PA_X = "zz_b1_paX";

const ADMIN = { userId: "zz_b1_admin", companyId: "c1", role: "admin", name: "老板本人", agentId: null };
const STAFF = { userId: "zz_b1_staff", companyId: "c1", role: "staff", name: "员工甲", agentId: null };
const CLIENT_AG = { userId: C_AG, companyId: "c1", role: "client", name: "代理客户", agentId: AGENT_ID };
const CLIENT_XT = { userId: C_XT, companyId: "c1", role: "client", name: "湘泰客户", agentId: null };
const CLIENT_NOPRICE = { userId: C_NOPRICE, companyId: "c1", role: "client", name: "没价客户", agentId: null };

const T0 = new Date("2026-09-01T01:00:00Z");
const T1 = new Date("2026-09-02T01:00:00Z");

/* ─────────────────────────── 夹具 ─────────────────────────── */

const user = (id: string, role: string, extra: Row = {}): Row => ({
  id, companyId: "c1", role, name: extra.name ?? id, phone: "0800000000", status: "active", warehouseIds: "[]",
  passwordHash: null, companyName: null, email: null, createdAt: T0, agentId: null, ...extra,
});

const prealertRow = (id: string, customerId: string, trackingNo: string, status: string, totalFee: number | null): Row => ({
  id, customerId, companyId: "c1", trackingNo, expressNo: null, mark: `M_${trackingNo}`, status,
  receivedAt: T0, signedAt: T0, warehouseReceiptProofs: [], paymentProofs: [], paymentProofUploadedAt: null, totalFee,
  paymentReviewedAt: null, paymentReviewedBy: null, paymentRejectReason: null, thailandReceiptProofs: [], thailandReceivedAt: null,
  cancelReason: null, cancelledAt: null,
  paidPriceNormal: null, paidPriceInspection: null, paidPriceSensitive: null, paidAgentId: null,
  paidAgentPriceNormal: null, paidAgentPriceInspection: null, paidAgentPriceSensitive: null, rebateAmount: null,
  createdAt: T0, updatedAt: T1,
});

const item = (id: string, prealertId: string, volumeM3: number, cargoType: string, sortOrder: number): Row => ({
  id, prealertId, companyId: "c1", productName: `货${id.slice(-2)}`, packageCount: 2, quantityPerBox: 1, totalQuantity: 2,
  lengthCm: 50, widthCm: 50, heightCm: 50, unitWeightKg: 1, totalWeightKg: 2, volumeM3, material: "布", cargoValue: "100",
  cargoType, productImageFileName: null, productImageMime: null, productImageBase64: null, sortOrder,
});

let ADMIN_HASH = "";

function seed(): void {
  resetMemory();
  const db = mem.db;
  db.user.push(
    user(ADMIN.userId, "admin", { name: ADMIN.name, passwordHash: ADMIN_HASH }),
    user(STAFF.userId, "staff", { name: STAFF.name }),
    user("zz_b1_agentlogin", "agent", { name: "代理登录号", agentId: AGENT_ID }),
    user(C_AG, "client", { name: "代理客户", agentId: AGENT_ID, companyName: "代理客户公司" }),
    user(C_XT, "client", { name: "湘泰客户", companyName: "湘泰客户公司" }),
    user(C_NOPRICE, "client", { name: "没价客户" }),
    user(C_NEW_LOW, "client", { name: "低价新客户" }),
    user(C_NEW, "client", { name: "空白新客户" }),
  );
  db.agent.push({
    id: AGENT_ID, companyId: "c1", name: AGENT_NAME, logoPath: null, slug: null, customDomain: null,
    priceNormal: 500, priceInspection: 600, priceSensitive: 700, createdAt: T0, updatedAt: T0,
  });
  db.clientWhrPrice.push(
    { clientId: C_AG, companyId: "c1", priceNormal: 600, priceInspection: 700, priceSensitive: 800, updatedBy: "zz_b1_agentlogin", updatedByRole: "agent", createdAt: T0, updatedAt: T0 },
    // 上线回填的行：操作人为空
    { clientId: C_XT, companyId: "c1", priceNormal: 550, priceInspection: 650, priceSensitive: 750, updatedBy: null, updatedByRole: null, createdAt: T0, updatedAt: T0 },
    { clientId: C_NEW_LOW, companyId: "c1", priceNormal: 450, priceInspection: 650, priceSensitive: 750, updatedBy: ADMIN.userId, updatedByRole: "admin", createdAt: T0, updatedAt: T0 },
  );
  const plan = (id: string, planNo: string, status: string): Row => ({
    id, companyId: "c1", planNo, warehouse: "义乌", containerType: "40HQ", destinationTh: "曼谷", totalVolumeM3: 68,
    status, createdBy: ADMIN.userId, creatorName: ADMIN.name, createdAt: T0, updatedAt: T1,
  });
  db.whrConsolidationPlan.push(plan(P1, "WHR0009001", "collecting"), plan(P2, "WHR0009002", "collecting"));
  const pc = (id: string, clientId: string, prices: [number, number, number], address: string): Row => ({
    id, planId: P1, companyId: "c1", clientId, unitPriceNormal: prices[0], unitPriceInspection: prices[1], unitPriceSensitive: prices[2],
    totalVolumeM3: 0, totalFee: null, deliveryAddress: address, totalPrealerts: 1, totalPackages: 4, createdAt: T0, updatedAt: T0,
  });
  db.whrConsolidationPlanCustomer.push(pc(PC_A, C_AG, [600, 700, 800], "曼谷一号路"), pc(PC_X, C_XT, [550, 650, 750], "曼谷二号路"));
  // paA：1.5 普 + 0.5 敏 → 1.5×600 + 0.5×800 = 1300；paX：2 普 + 1 商检 → 2×550 + 650 = 1750
  db.whrConsolidationPrealert.push(
    prealertRow(PA_A, PC_A, "WHRP9001", "received_pending_payment", 1300),
    prealertRow(PA_X, PC_X, "WHRP9002", "received_pending_payment", 1750),
  );
  db.whrConsolidationPrealertItem.push(
    item("zz_b1_iA1", PA_A, 1.5, "normal", 0),
    item("zz_b1_iA2", PA_A, 0.5, "sensitive", 1),
    item("zz_b1_iX1", PA_X, 2, "normal", 0),
    item("zz_b1_iX2", PA_X, 1, "inspection", 1),
  );
  db.whrConsolidationStatusLog.push({
    id: "zz_b1_log1", prealertId: PA_A, companyId: "c1", operatorId: STAFF.userId, operatorRole: "staff", operatorName: STAFF.name,
    fromStatus: "pending", toStatus: "received_pending_payment", remark: "仓库签收", createdAt: T0,
  });
  db.clientWalletAccount.push(
    { clientId: C_AG, companyId: "c1", currency: "CNY", balance: 5000, updatedAt: T0 },
    { clientId: C_XT, companyId: "c1", currency: "CNY", balance: 5000, updatedAt: T0 },
  );
}

const pa = (id: string): Row => mem.db.whrConsolidationPrealert.find((r) => r.id === id)!;
const pcRow = (id: string): Row => mem.db.whrConsolidationPlanCustomer.find((r) => r.id === id)!;
const priceOf = (clientId: string): Row | undefined => mem.db.clientWhrPrice.find((r) => r.clientId === clientId);
const balanceOf = (clientId: string): number => Number(mem.db.clientWalletAccount.find((r) => r.clientId === clientId)!.balance);

/** 员工 / 客户的响应里一样都不许出现 */
const AGENT_MARKERS = [AGENT_ID, AGENT_NAME, "agentId", "agentName", "paidAgent", "rebateAmount", "zz_b1_agentlogin"];
function assertNoAgentInfo(label: string, wire: unknown): void {
  const text = JSON.stringify(wire);
  for (const marker of AGENT_MARKERS) {
    assert.ok(!text.includes(marker), `${label} 的返回里出现了「${marker}」：${text.slice(0, 300)}`);
  }
}

async function main(): Promise<void> {
  const { hashPassword } = await import("../apps/api/src/modules/auth/crypto-utils");
  ADMIN_HASH = hashPassword("Admin#Pass2026");
  await loadRoutes([
    await import("../apps/api/src/modules/whr-consolidation/routes"),
    await import("../apps/api/src/modules/whr-consolidation/staff-routes"),
    await import("../apps/api/src/modules/whr-consolidation/client-routes"),
    await import("../apps/api/src/modules/admin/routes"),
  ]);
  const { NO_LONG_TERM_PRICE_MESSAGE } = await import("../apps/api/src/modules/whr-consolidation/routes");

  console.log("仓库版集货长期价 / 付款快照 / 超管客户管理");

  /* ───────────── 1. 建柜 / 加客户 ───────────── */

  await check("1) 建柜：单价按长期价带出，请求里传的单价不认；客户价锁按 clientId 排序、排在取号建柜前面", async () => {
    seed();
    const r = await callRoute("POST /admin/whr-consolidation/plans", ADMIN, {
      body: {
        destinationTh: "曼谷",
        customers: [
          { clientId: C_XT, unitPriceNormal: 1, unitPriceInspection: 1, unitPriceSensitive: 1 },
          { clientId: C_AG, unitPriceNormal: 1, unitPriceInspection: 1, unitPriceSensitive: 1 },
        ],
      },
    });
    assert.equal(r.status, 200, r.message);
    const rows = mem.db.whrConsolidationPlanCustomer.filter((x) => x.planId === r.data.id);
    const byClient = Object.fromEntries(rows.map((x) => [x.clientId, [x.unitPriceNormal, x.unitPriceInspection, x.unitPriceSensitive]]));
    assert.deepEqual(byClient[C_AG], [600, 700, 800], "代理客户没按长期价带出");
    assert.deepEqual(byClient[C_XT], [550, 650, 750], "湘泰客户没按长期价带出");
    // 传进来的顺序是 cX、cA，锁必须按 id 排序 cA → cX
    assertBefore(`lock:client_price:${C_AG}`, `lock:client_price:${C_XT}`, "多个客户的价锁要按 clientId 排序");
    assertBefore(`lock:client_price:${C_XT}`, "lock:plan_no", "客户价锁要排在取号建柜前面");
    assertBefore("lock:plan_no", `write:whrConsolidationPlan:${r.data.id}`, "取号锁在建柜之前");
  });

  await check("2) 建柜：有一个客户没长期价 → 400「暂未配对价格，请联系管理员」并点名，整柜不建", async () => {
    seed();
    const before = mem.db.whrConsolidationPlan.length;
    const r = await callRoute("POST /admin/whr-consolidation/plans", ADMIN, {
      body: { destinationTh: "曼谷", customers: [{ clientId: C_XT }, { clientId: C_NOPRICE }] },
    });
    assert.equal(r.status, 400, r.message);
    assert.ok(r.message.includes(NO_LONG_TERM_PRICE_MESSAGE) && r.message.includes("没价客户"), r.message);
    assert.equal(mem.db.whrConsolidationPlan.length, before, "没价还是把柜建出来了");
    assert.deepEqual(writes(), [], `被拦下还写了库：${writes().join(", ")}`);
  });

  await check("3) 员工往柜里加客户：价按长期价带出（传了单价也不认）；锁序 客户价锁 → 计划 → 写", async () => {
    seed();
    const r = await callRoute("POST /admin/whr-consolidation/customers/add", STAFF, {
      body: { planId: P2, clientId: C_AG, unitPriceNormal: 1, unitPriceInspection: 1, unitPriceSensitive: 1 },
    });
    assert.equal(r.status, 200, r.message);
    const row = mem.db.whrConsolidationPlanCustomer.find((x) => x.planId === P2 && x.clientId === C_AG)!;
    assert.deepEqual([row.unitPriceNormal, row.unitPriceInspection, row.unitPriceSensitive], [600, 700, 800]);
    assert.deepEqual([r.data.unitPriceNormal, r.data.unitPriceInspection, r.data.unitPriceSensitive], [600, 700, 800]);
    assertBefore(`lock:client_price:${C_AG}`, `lock:plan:${P2}`, "加客户：客户价锁必须排在锁计划前面（跟改长期价同一个方向）");
    assertBefore(`lock:plan:${P2}`, `write:whrConsolidationPlanCustomer:${row.id}`, "加客户：锁完计划才写");
    assertNoAgentInfo("员工加客户的返回", r.wire);
  });

  await check("4) 加客户：没长期价 400；**锁之前价被删了**，锁里重读照样拦下、什么都没写", async () => {
    seed();
    const r1 = await callRoute("POST /admin/whr-consolidation/customers/add", STAFF, { body: { planId: P2, clientId: C_NOPRICE } });
    assert.equal(r1.status, 400);
    assert.equal(r1.message, NO_LONG_TERM_PRICE_MESSAGE);
    seed();
    mem.onEvent = (e) => {
      if (e === `lock:client_price:${C_XT}`) mem.db.clientWhrPrice = mem.db.clientWhrPrice.filter((p) => p.clientId !== C_XT);
    };
    const r2 = await callRoute("POST /admin/whr-consolidation/customers/add", ADMIN, { body: { planId: P2, clientId: C_XT } });
    assert.equal(r2.status, 400, `锁里没重读长期价：${r2.status} ${r2.message}`);
    assert.deepEqual(writes(), [], `被拦下还写了库：${writes().join(", ")}`);
  });

  /* ───────────── 2. 柜里改价停用 ───────────── */

  await check("5) 柜详情「改单价」接口停用 → 410 + 告诉他去「客户管理」改，一次库都不碰", async () => {
    seed();
    const r = await callRoute("POST /admin/whr-consolidation/customers/price", ADMIN, {
      body: { planId: P1, customerId: PC_X, unitPriceNormal: 999 },
    });
    assert.equal(r.status, 410);
    assert.ok(r.message.includes("客户管理"), r.message);
    assert.deepEqual(mem.events, []);
    assert.equal(pcRow(PC_X).unitPriceNormal, 550);
  });

  await check("6) 审核不通过：传了单价也不改柜里的价，只按现价重算这张单", async () => {
    seed();
    pa(PA_X).status = "payment_submitted";
    pa(PA_X).totalFee = 1;
    const r = await callRoute("POST /admin/whr-consolidation/prealerts/review", STAFF, {
      body: { planId: P1, prealertId: PA_X, action: "reject", rejectReason: "凭证看不清", unitPriceNormal: 1, unitPriceInspection: 1, unitPriceSensitive: 1 },
    });
    assert.equal(r.status, 200, r.message);
    assert.equal(pcRow(PC_X).unitPriceNormal, 550, "拒绝时把柜里的单价改了");
    assert.equal(Number(pa(PA_X).totalFee), 1750, "没按现价重算应付金额");
    assert.equal(pa(PA_X).status, "received_pending_payment");
  });

  /* ───────────── 3. 改货型 / 删货品 自动重算 ───────────── */

  await check("7) 改货型：待付款的单按新货型自动重算（商检 → 敏感：1750 → 1850），锁计划在写之前；已付款的改不了", async () => {
    seed();
    const r = await callRoute("POST /admin/whr-consolidation/prealerts/item-cargo-type", ADMIN, {
      body: { itemId: "zz_b1_iX2", cargoType: "sensitive" },
    });
    assert.equal(r.status, 200, r.message);
    assert.equal(r.data.totalFee, 1850);
    assert.equal(Number(pa(PA_X).totalFee), 1850);
    assert.equal(Number(pcRow(PC_X).totalFee), 1850, "客户汇总没跟着重算");
    assertBefore(`lock:plan:${P1}`, "write:whrConsolidationPrealertItem:zz_b1_iX2", "改货型要先锁计划");
    // 已付款
    pa(PA_A).status = "paid";
    const r2 = await callRoute("POST /admin/whr-consolidation/prealerts/item-cargo-type", ADMIN, { body: { itemId: "zz_b1_iA1", cargoType: "inspection" } });
    assert.equal(r2.status, 400);
    assert.equal(Number(pa(PA_A).totalFee), 1300, "已付款的单金额被动了");
  });

  await check("8) 改货型：事务外看到「待付款」、锁住那一刻客户付了款 → 锁里重查拦下，金额不动", async () => {
    seed();
    mem.onEvent = (e) => {
      if (e === `lock:plan:${P1}`) pa(PA_X).status = "paid";
    };
    const r = await callRoute("POST /admin/whr-consolidation/prealerts/item-cargo-type", ADMIN, { body: { itemId: "zz_b1_iX2", cargoType: "sensitive" } });
    assert.equal(r.status, 400, `${r.status} ${r.message}`);
    assert.equal(Number(pa(PA_X).totalFee), 1750);
    assert.deepEqual(writes(), []);
  });

  await check("9) 删货品：待付款的单按剩下的货自动重算（删掉 1 方商检：1750 → 1100）", async () => {
    seed();
    const r = await callRoute("POST /admin/whr-consolidation/prealerts/item-delete", ADMIN, { body: { itemId: "zz_b1_iX2" } });
    assert.equal(r.status, 200, r.message);
    assert.equal(r.data.totalFee, 1100);
    assert.equal(Number(pa(PA_X).totalFee), 1100);
    assert.equal(Number(pcRow(PC_X).totalFee), 1100);
  });

  /* ───────────── 4. 付款快照 / 撤销 ───────────── */

  await check("10) 代理客户付款：记下客户价、代理、代理价、返现（1.5×100 + 0.5×100 = 200）；锁序 计划 → 预报单 → 钱包，不去锁代理行", async () => {
    seed();
    const r = await callRoute("POST /client/whr-consolidation/pay", CLIENT_AG, { body: { planId: P1, prealertId: PA_A } });
    assert.equal(r.status, 200, r.message);
    const row = pa(PA_A);
    assert.equal(row.status, "paid");
    assert.deepEqual([row.paidPriceNormal, row.paidPriceInspection, row.paidPriceSensitive], [600, 700, 800]);
    assert.equal(row.paidAgentId, AGENT_ID);
    assert.deepEqual([row.paidAgentPriceNormal, row.paidAgentPriceInspection, row.paidAgentPriceSensitive], [500, 600, 700]);
    assert.equal(row.rebateAmount, 200);
    assert.equal(balanceOf(C_AG), 3700);
    assertBefore(`lock:plan:${P1}`, `lock:prealert:${PA_A}`, "付款：先锁计划再锁单");
    assertBefore(`lock:prealert:${PA_A}`, `lock:wallet:${C_AG}`, "付款：先锁单再锁钱包");
    assert.ok(!mem.events.some((e) => e.startsWith("lock:agent_share")), "付款这条路去锁代理行了 —— 跟改长期价反着拿，会绕成死锁");
    assertNoAgentInfo("客户付款的返回", r.wire);
  });

  await check("11) 湘泰客户付款：客户价照记，代理、代理价、返现都留空", async () => {
    seed();
    const r = await callRoute("POST /client/whr-consolidation/pay", CLIENT_XT, { body: { planId: P1, prealertId: PA_X } });
    assert.equal(r.status, 200, r.message);
    const row = pa(PA_X);
    assert.deepEqual([row.paidPriceNormal, row.paidPriceInspection, row.paidPriceSensitive], [550, 650, 750]);
    assert.equal(row.paidAgentId, null);
    assert.equal(row.paidAgentPriceNormal, null);
    assert.equal(row.rebateAmount, null);
  });

  await check("12) 客户价低于代理价（数据异常）：付款照常成功，返现记 0 不记负数", async () => {
    seed();
    Object.assign(pcRow(PC_A), { unitPriceNormal: 400 });
    pa(PA_A).totalFee = 1000; // 1.5×400 + 0.5×800
    const r = await callRoute("POST /client/whr-consolidation/pay", CLIENT_AG, { body: { planId: P1, prealertId: PA_A } });
    assert.equal(r.status, 200, r.message);
    assert.equal(pa(PA_A).rebateAmount, 0, `返现不该是负数：${pa(PA_A).rebateAmount}`);
  });

  await check("13) 撤销付款：钱退回、单子回待付款、快照整组清空；再付款重新记", async () => {
    seed();
    await callRoute("POST /client/whr-consolidation/pay", CLIENT_AG, { body: { planId: P1, prealertId: PA_A } });
    const r = await callRoute("POST /admin/whr-consolidation/payments/revoke", ADMIN, { body: { prealertId: PA_A, reason: "点错了" } });
    assert.equal(r.status, 200, r.message);
    const row = pa(PA_A);
    assert.equal(row.status, "received_pending_payment");
    for (const k of ["paidPriceNormal", "paidPriceInspection", "paidPriceSensitive", "paidAgentId", "paidAgentPriceNormal", "paidAgentPriceInspection", "paidAgentPriceSensitive", "rebateAmount"]) {
      assert.equal(row[k], null, `撤销付款后 ${k} 没清空`);
    }
    assert.equal(balanceOf(C_AG), 5000);
    // 代理价改了再付：按新代理价重新记
    mem.db.agent[0].priceNormal = 550;
    const again = await callRoute("POST /client/whr-consolidation/pay", CLIENT_AG, { body: { planId: P1, prealertId: PA_A } });
    assert.equal(again.status, 200, again.message);
    assert.equal(pa(PA_A).paidAgentPriceNormal, 550);
    assert.equal(pa(PA_A).rebateAmount, 125); // 1.5×50 + 0.5×100
  });

  await check("14) 作废已付款的单：钱退回，快照跟撤销付款一样清空", async () => {
    seed();
    await callRoute("POST /client/whr-consolidation/pay", CLIENT_AG, { body: { planId: P1, prealertId: PA_A } });
    const r = await callRoute("POST /admin/whr-consolidation/prealerts/cancel", ADMIN, { body: { planId: P1, prealertId: PA_A, cancelReason: "客户不要了" } });
    assert.equal(r.status, 200, r.message);
    assert.equal(pa(PA_A).status, "cancelled");
    assert.equal(pa(PA_A).paidAgentId, null);
    assert.equal(pa(PA_A).rebateAmount, null);
    assert.equal(balanceOf(C_AG), 5000);
  });

  /* ───────────── 5. 超管改长期价 ───────────── */

  await check("15) 超管改代理客户的长期价 → 403，价没动、一把锁都没拿", async () => {
    seed();
    const r = await callRoute("POST /admin/clients/whr-price", ADMIN, {
      body: { clientId: C_AG, unitPriceNormal: 999, unitPriceInspection: 999, unitPriceSensitive: 999 },
    });
    assert.equal(r.status, 403, r.message);
    assert.ok(r.message.includes("代理"), r.message);
    assert.equal(priceOf(C_AG)!.priceNormal, 600);
    assert.deepEqual(mem.events, []);
  });

  await check("16) 超管改湘泰客户长期价：事务外看是湘泰客户、**锁住那一刻归属被改成代理** → 锁里重判 403，什么都没写", async () => {
    seed();
    mem.onEvent = (e) => {
      if (e === `lock:client_price:${C_XT}`) mem.db.user.find((u) => u.id === C_XT)!.agentId = AGENT_ID;
    };
    const r = await callRoute("POST /admin/clients/whr-price", ADMIN, {
      body: { clientId: C_XT, unitPriceNormal: 560, unitPriceInspection: 660, unitPriceSensitive: 760 },
    });
    assert.equal(r.status, 403, `${r.status} ${r.message}`);
    assert.equal(priceOf(C_XT)!.priceNormal, 550);
    assert.deepEqual(writes(), []);
  });

  await check("17) 超管改湘泰客户长期价：存价、记是超管改的、在跑的柜跟着改、没付款的单重算（1750 → 1780）", async () => {
    seed();
    const r = await callRoute("POST /admin/clients/whr-price", ADMIN, {
      body: { clientId: C_XT, unitPriceNormal: 560, unitPriceInspection: 660, unitPriceSensitive: 760 },
    });
    assert.equal(r.status, 200, r.message);
    assert.equal(r.data.updatedPlanRows, 1);
    assert.equal(priceOf(C_XT)!.priceNormal, 560);
    assert.equal(priceOf(C_XT)!.updatedByRole, "admin");
    assert.equal(pcRow(PC_X).unitPriceNormal, 560);
    assert.equal(Number(pa(PA_X).totalFee), 1780);
  });

  await check("18) 超管改长期价：0.001 / 3 位小数 / 缺档在碰数据库之前就拦", async () => {
    seed();
    for (const body of [
      { clientId: C_XT, unitPriceNormal: 0.001, unitPriceInspection: 1, unitPriceSensitive: 1 },
      { clientId: C_XT, unitPriceNormal: 12.345, unitPriceInspection: 1, unitPriceSensitive: 1 },
      { clientId: C_XT, unitPriceNormal: 600, unitPriceInspection: 1 },
    ]) {
      const r = await callRoute("POST /admin/clients/whr-price", ADMIN, { body });
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.deepEqual(mem.events, []);
  });

  /* ───────────── 6. 员工 / 客户看不到代理 ───────────── */

  await check("19) 员工能调的仓库版接口：返回里没有代理 id / 代理名 / 代理价 / 返现（客户和单子上都故意填上了值）", async () => {
    seed();
    // 把快照填满，路由要是把整行吐出去就会被抓到（CLAUDE.md #31④：字段为空测不出来）
    Object.assign(pa(PA_A), { status: "paid", paidAgentId: AGENT_ID, paidAgentPriceNormal: 500, rebateAmount: 200 });
    const staffCalls: Array<[string, Row]> = [
      ["GET /staff/whr-consolidation/operations", {}],
      ["GET /staff/whr-consolidation/prealert-detail", { prealertId: PA_A }],
      ["GET /staff/whr-consolidation/dispatch-view", {}],
      ["GET /admin/whr-consolidation/plans", {}],
      ["GET /admin/whr-consolidation/plans/detail", { planId: P1 }],
      ["GET /admin/whr-consolidation/client-prices", {}],
    ];
    for (const [key, query] of staffCalls) {
      const r = await callRoute(key, STAFF, { query });
      assert.equal(r.status, 200, `${key}：${r.message}`);
      assertNoAgentInfo(`员工 ${key}`, r.wire);
    }
    // 真的有数据（别是空数组骗过去）
    const detail = await callRoute("GET /admin/whr-consolidation/plans/detail", STAFF, { query: { planId: P1 } });
    assert.ok(detail.data.customers.some((c: Row) => c.clientId === C_AG), "计划详情里没有代理客户那一行，上面的检查等于没测");
    const prices = await callRoute("GET /admin/whr-consolidation/client-prices", STAFF);
    assert.ok(prices.data.items.some((p: Row) => p.clientId === C_AG), "长期价一览里没有代理客户，上面的检查等于没测");
  });

  await check("20) 客户能调的仓库版接口：代理客户看不到代理名、代理价、返现", async () => {
    seed();
    Object.assign(pa(PA_A), { status: "paid", paidAgentId: AGENT_ID, paidAgentPriceNormal: 500, rebateAmount: 200 });
    for (const [key, query] of [["GET /client/whr-consolidation/plans", {}], ["GET /client/whr-consolidation/my-detail", { planId: P1 }]] as Array<[string, Row]>) {
      const r = await callRoute(key, CLIENT_AG, { query });
      assert.equal(r.status, 200, `${key}：${r.message}`);
      assertNoAgentInfo(`代理客户 ${key}`, r.wire);
    }
  });

  await check("21) 客户端「有没有长期价」：有价 true；没价 false（没参与任何柜也要回）", async () => {
    seed();
    const yes = await callRoute("GET /client/whr-consolidation/plans", CLIENT_AG);
    assert.equal(yes.data.hasLongTermPrice, true);
    const no = await callRoute("GET /client/whr-consolidation/plans", CLIENT_NOPRICE);
    assert.equal(no.data.hasLongTermPrice, false);
    assert.deepEqual(no.data.items, []);
  });

  /* ───────────── 7. 超管客户管理 ───────────── */

  await check("22) 超管客户列表：带所属代理和长期价，回填的标出来（filledByRole=null），没价的为 null；不列代理登录号", async () => {
    seed();
    const r = await callRoute("GET /admin/users", ADMIN, { query: { role: "client" } });
    assert.equal(r.status, 200, r.message);
    const byId = Object.fromEntries((r.data.items as Row[]).map((u) => [u.id, u]));
    assert.equal(byId[C_AG].agentName, AGENT_NAME);
    assert.equal(byId[C_AG].whrPrice.filledByRole, "agent");
    assert.equal(byId[C_XT].agentId, null);
    assert.equal(byId[C_XT].whrPrice.filledByRole, null, "回填的那批应该标成 null");
    assert.equal(byId[C_NOPRICE].whrPrice, null);
    const all = await callRoute("GET /admin/users", ADMIN);
    assert.ok(!(all.data.items as Row[]).some((u) => u.role === "agent"), "账号列表把代理登录号也列出来了");
  });

  await check("23) 设置密码：代理登录号走强度检查（123456 拦下，强密码放行）；代理的客户照客户规矩不卡", async () => {
    seed();
    const weak = await callRoute("POST /admin/users/set-password", ADMIN, { body: { id: "zz_b1_agentlogin", password: "123456" } });
    assert.equal(weak.status, 400, weak.message);
    const strong = await callRoute("POST /admin/users/set-password", ADMIN, { body: { id: "zz_b1_agentlogin", password: "Agent#Strong2026x" } });
    assert.equal(strong.status, 200, strong.message);
    const clientWeak = await callRoute("POST /admin/users/set-password", ADMIN, { body: { id: C_AG, password: "123456" } });
    assert.equal(clientWeak.status, 200, clientWeak.message);
  });

  await check("24) 开客户选代理：代理不存在 400；选了真代理就挂到代理名下；不选就是湘泰的", async () => {
    seed();
    const bad = await callRoute("POST /admin/users/client", ADMIN, { body: { id: "zz_b1_new1", name: "新客户", phone: "0811", password: "x", agentId: "zz_nope" } });
    assert.equal(bad.status, 400, bad.message);
    assert.ok(!mem.db.user.some((u) => u.id === "zz_b1_new1"));
    const good = await callRoute("POST /admin/users/client", ADMIN, { body: { id: "zz_b1_new2", name: "新客户", phone: "0811", password: "x", agentId: AGENT_ID } });
    assert.equal(good.status, 200, good.message);
    assert.equal(mem.db.user.find((u) => u.id === "zz_b1_new2")!.agentId, AGENT_ID);
    const xt = await callRoute("POST /admin/users/client", ADMIN, { body: { id: "zz_b1_new3", name: "新客户", phone: "0811", password: "x" } });
    assert.equal(xt.status, 200, xt.message);
    assert.equal(mem.db.user.find((u) => u.id === "zz_b1_new3")!.agentId, null);
  });

  await check("25) 改归属：有业务记录 409；长期价低于代理价 409；干净的客户能改（先拿客户价锁再写）；只改名字不碰这道闸", async () => {
    seed();
    const withRecords = await callRoute("POST /admin/users/client/update", ADMIN, { body: { id: C_XT, agentId: AGENT_ID } });
    assert.equal(withRecords.status, 409, withRecords.message);
    assert.ok(withRecords.message.includes("仓库版集货"), withRecords.message);
    assert.equal(mem.db.user.find((u) => u.id === C_XT)!.agentId, null);

    const low = await callRoute("POST /admin/users/client/update", ADMIN, { body: { id: C_NEW_LOW, agentId: AGENT_ID } });
    assert.equal(low.status, 409, low.message);
    assert.ok(low.message.includes("低于代理价"), low.message);

    mem.events = [];
    const ok = await callRoute("POST /admin/users/client/update", ADMIN, { body: { id: C_NEW, agentId: AGENT_ID } });
    assert.equal(ok.status, 200, ok.message);
    assert.equal(mem.db.user.find((u) => u.id === C_NEW)!.agentId, AGENT_ID);
    assertBefore(`lock:client_price:${C_NEW}`, `write:user:${C_NEW}`, "改归属要先拿客户价锁");
    const back = await callRoute("POST /admin/users/client/update", ADMIN, { body: { id: C_NEW, agentId: "" } });
    assert.equal(back.status, 200, back.message);
    assert.equal(mem.db.user.find((u) => u.id === C_NEW)!.agentId, null);

    const rename = await callRoute("POST /admin/users/client/update", ADMIN, { body: { id: C_XT, name: "湘泰客户改名" } });
    assert.equal(rename.status, 200, rename.message);
  });

  await check("26) 改归属：事务外没记录、锁住那一刻被加进了柜 → 锁里重查 409", async () => {
    seed();
    mem.onEvent = (e) => {
      if (e === `lock:client_price:${C_NEW}`) {
        mem.db.whrConsolidationPlanCustomer.push({ id: "zz_b1_pcRace", planId: P2, companyId: "c1", clientId: C_NEW, unitPriceNormal: 1, unitPriceInspection: 1, unitPriceSensitive: 1 });
      }
    };
    const r = await callRoute("POST /admin/users/client/update", ADMIN, { body: { id: C_NEW, agentId: AGENT_ID } });
    assert.equal(r.status, 409, `${r.status} ${r.message}`);
    assert.equal(mem.db.user.find((u) => u.id === C_NEW)!.agentId, null);
  });

  /* ───────────── 8. 超管替客户填泰国地址 ───────────── */

  await check("27) 超管填泰国地址：锁计划之后才写；员工调不了", async () => {
    seed();
    const staff = await callRoute("POST /admin/whr-consolidation/address", STAFF, { body: { planId: P1, customerId: PC_A, deliveryAddress: "新地址" } });
    assert.equal(staff.status, 403);
    const r = await callRoute("POST /admin/whr-consolidation/address", ADMIN, { body: { planId: P1, customerId: PC_A, deliveryAddress: "  清迈三号路  " } });
    assert.equal(r.status, 200, r.message);
    assert.equal(pcRow(PC_A).deliveryAddress, "清迈三号路");
    assertBefore(`lock:plan:${P1}`, `write:whrConsolidationPlanCustomer:${PC_A}`, "填地址要先锁计划再写");
  });

  await check("28) 填泰国地址：已有货发运 400；**锁住那一刻刚发运** → 锁里重查照样拦，地址不变", async () => {
    seed();
    pa(PA_A).status = "shipped";
    const r1 = await callRoute("POST /admin/whr-consolidation/address", ADMIN, { body: { planId: P1, customerId: PC_A, deliveryAddress: "新地址" } });
    assert.equal(r1.status, 400, r1.message);
    seed();
    mem.onEvent = (e) => {
      if (e === `lock:plan:${P1}`) pa(PA_A).status = "shipped";
    };
    const r2 = await callRoute("POST /admin/whr-consolidation/address", ADMIN, { body: { planId: P1, customerId: PC_A, deliveryAddress: "新地址" } });
    assert.equal(r2.status, 400, `${r2.status} ${r2.message}`);
    assert.equal(pcRow(PC_A).deliveryAddress, "曼谷一号路");
  });

  if (failures.length > 0) {
    console.error(`\n${failures.length}/${total} 项不通过：${failures.join("；")}`);
    process.exit(1);
  }
  console.log(`仓库版集货长期价：${total} 项全部通过`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
