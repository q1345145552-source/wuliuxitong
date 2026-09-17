/**
 * 仓库版集货改长期价 + 付款快照 + 超管客户管理 自测（2026-09-16，B1）。**不连数据库、不连外网。**
 * 需求：docs/交接文档-附件-代理账号确认单/final.md（不进 git）4.4-4.7 / 4.14 / 4.19 / 3.12 / 2.2 / 2.9 / 6.3。
 *
 * ⚠️ 2026-09-18 老板拍板改回来：**价格是每个柜当场填的**（「每次柜价格都不一样的，所有人都不需要设置价格」）。
 *    所以第 1~6 项已经改成测「建柜 / 加客户 / 改单价 当场填三档价」；
 *    「客户长期价」那套接口（setClientWhrPrice / 超管客户管理那几条）**后端留着**，第 15~18、22、25 项继续盯着它，
 *    只是前端没有入口了（见 apps/web 那三个集货页和 admin/page.tsx 的注释）。
 *
 * 真调路由（内存库见 scripts/whr-memory-db.ts），盯住这几件事：
 *   1. 建柜 / 往柜里加客户：当场填三档单价，缺档 / 0.001 一律 400；没配过长期价的客户照样能建柜
 *   2. 柜里「改单价」：只改传的那几档、没付款的单按新价重算、已取消的柜改不了；审核拒绝不改价
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
    await import("../apps/api/src/modules/consolidation/routes"),
  ]);
  console.log("仓库版集货长期价 / 付款快照 / 超管客户管理");

  /* ───────────── 1. 建柜 / 加客户 ───────────── */

  await check("1) 建柜：三档单价当场填，逐位客户各自存下来（2026-09-18 拍板改回来）", async () => {
    seed();
    const r = await callRoute("POST /admin/whr-consolidation/plans", ADMIN, {
      body: {
        destinationTh: "曼谷",
        customers: [
          { clientId: C_XT, unitPriceNormal: 520, unitPriceInspection: 620, unitPriceSensitive: 720 },
          { clientId: C_AG, unitPriceNormal: 580, unitPriceInspection: 680, unitPriceSensitive: 780 },
        ],
      },
    });
    assert.equal(r.status, 200, r.message);
    const rows = mem.db.whrConsolidationPlanCustomer.filter((x) => x.planId === r.data.id);
    const byClient = Object.fromEntries(rows.map((x) => [x.clientId, [x.unitPriceNormal, x.unitPriceInspection, x.unitPriceSensitive]]));
    assert.deepEqual(byClient[C_XT], [520, 620, 720], "湘泰客户的价没按填的存");
    assert.deepEqual(byClient[C_AG], [580, 680, 780], "代理客户的价没按填的存");
    /**
     * 价格虽然是当场填的，但两把锁照旧要（DeepSeek 复核 2026-09-18 第 1、2 条）：
     * 客户价排队锁保证「改客户归属」那条路数完业务记录后不会被新柜记录插队；
     * 代理价共享锁保证下限判断跟「调高代理价」排队。顺序：客户价（按 id 排序）→ agents → 取号。
     */
    assertBefore(`lock:client_price:${C_AG}`, `lock:client_price:${C_XT}`, "多个客户的价锁要按 clientId 排序");
    assertBefore(`lock:client_price:${C_XT}`, `lock:agent_share:${AGENT_ID}`, "客户价锁要排在代理价共享锁前面");
    assertBefore(`lock:agent_share:${AGENT_ID}`, "lock:plan_no", "代理价共享锁要排在取号建柜前面");
    assertBefore("lock:plan_no", `write:whrConsolidationPlan:${r.data.id}`, "取号锁在建柜之前");
  });

  await check("2) 建柜：缺一档价 / 价不合法 → 400，整柜不建，一次库都不写", async () => {
    seed();
    const before = mem.db.whrConsolidationPlan.length;
    const missing = await callRoute("POST /admin/whr-consolidation/plans", ADMIN, {
      body: { destinationTh: "曼谷", customers: [{ clientId: C_XT, unitPriceNormal: 520, unitPriceInspection: 620 }] },
    });
    assert.equal(missing.status, 400, missing.message);
    assert.ok(/敏感货单价/.test(missing.message), missing.message);
    const tiny = await callRoute("POST /admin/whr-consolidation/plans", ADMIN, {
      body: { destinationTh: "曼谷", customers: [{ clientId: C_XT, unitPriceNormal: 0.001, unitPriceInspection: 620, unitPriceSensitive: 720 }] },
    });
    assert.equal(tiny.status, 400, "0.001 会被 Decimal(10,2) 存成 0.00，必须拦");
    // 没填长期价的客户照样能建柜了（9-18 起没有「必须先配价」这道闸）
    const ok2 = await callRoute("POST /admin/whr-consolidation/plans", ADMIN, {
      body: { destinationTh: "曼谷", customers: [{ clientId: C_NOPRICE, unitPriceNormal: 500, unitPriceInspection: 600, unitPriceSensitive: 700 }] },
    });
    assert.equal(ok2.status, 200, `没长期价的客户被拦住了：${ok2.message}`);
    assert.equal(mem.db.whrConsolidationPlan.length, before + 1, "只该多出最后那一个柜");
  });

  await check("3) 员工往柜里加客户：当场填的三档价存进去、也回给前端；锁计划在写之前", async () => {
    seed();
    const r = await callRoute("POST /admin/whr-consolidation/customers/add", STAFF, {
      body: { planId: P2, clientId: C_AG, unitPriceNormal: 540, unitPriceInspection: 640, unitPriceSensitive: 740 },
    });
    assert.equal(r.status, 200, r.message);
    const row = mem.db.whrConsolidationPlanCustomer.find((x) => x.planId === P2 && x.clientId === C_AG)!;
    assert.deepEqual([row.unitPriceNormal, row.unitPriceInspection, row.unitPriceSensitive], [540, 640, 740]);
    assert.deepEqual([r.data.unitPriceNormal, r.data.unitPriceInspection, r.data.unitPriceSensitive], [540, 640, 740]);
    assertBefore(`lock:client_price:${C_AG}`, `lock:agent_share:${AGENT_ID}`, "加客户：客户价锁在代理价共享锁前面");
    assertBefore(`lock:agent_share:${AGENT_ID}`, `lock:plan:${P2}`, "加客户：代理价共享锁在锁计划前面");
    assertBefore(`lock:plan:${P2}`, `write:whrConsolidationPlanCustomer:${row.id}`, "加客户：锁完计划才写");
    assertNoAgentInfo("员工加客户的返回", r.wire);
  });

  await check("4) 加客户：不填价 / 价不合法 → 400，什么都不写；没长期价的客户照样能加", async () => {
    seed();
    const none = await callRoute("POST /admin/whr-consolidation/customers/add", STAFF, { body: { planId: P2, clientId: C_AG } });
    assert.equal(none.status, 400, none.message);
    assert.ok(/必填/.test(none.message), none.message);
    assert.deepEqual(writes(), [], `被拦下还写了库：${writes().join(", ")}`);
    seed();
    const tiny = await callRoute("POST /admin/whr-consolidation/customers/add", STAFF, {
      body: { planId: P2, clientId: C_AG, unitPriceNormal: 0.001, unitPriceInspection: 640, unitPriceSensitive: 740 },
    });
    assert.equal(tiny.status, 400, "0.001 必须拦");
    assert.deepEqual(writes(), [], "被拦下还写了库");
    seed();
    const okNoPrice = await callRoute("POST /admin/whr-consolidation/customers/add", STAFF, {
      body: { planId: P2, clientId: C_NOPRICE, unitPriceNormal: 500, unitPriceInspection: 600, unitPriceSensitive: 700 },
    });
    assert.equal(okNoPrice.status, 200, `没长期价的客户被拦住了：${okNoPrice.message}`);
  });

  /* ───────────── 2. 柜里改单价（2026-09-18 恢复） ───────────── */

  await check("5) 柜详情改单价：只改传的那几档、没付款的单按新价重算（1750 → 1810）、锁计划在写之前", async () => {
    seed();
    assert.equal(pcRow(PC_X).unitPriceNormal, 550);
    assert.equal(Number(pa(PA_X).totalFee), 1750);
    const r = await callRoute("POST /admin/whr-consolidation/customers/price", ADMIN, {
      body: { planId: P1, customerId: PC_X, unitPriceNormal: 580 },
    });
    assert.equal(r.status, 200, r.message);
    assert.equal(pcRow(PC_X).unitPriceNormal, 580, "普货价没改");
    assert.equal(pcRow(PC_X).unitPriceInspection, 650, "没传的档不许动");
    assert.equal(pcRow(PC_X).unitPriceSensitive, 750, "没传的档不许动");
    // 这张单是 2 方普货 + 1 方商检：普货价 550→580 以后 2×580 + 650 = 1810
    assert.equal(Number(pa(PA_X).totalFee), 1810, "没付款的单没按新价重算");
    assert.equal(Number(r.data.totalFee), Number(pcRow(PC_X).totalFee ?? r.data.totalFee));
    assertBefore(`lock:plan:${P1}`, `write:whrConsolidationPlanCustomer:${PC_X}`, "改单价：锁完计划才写");
  });

  await check("5b) 改单价：一档都不传 400；0.001 400；已取消的柜改不了；都不碰金额", async () => {
    seed();
    const none = await callRoute("POST /admin/whr-consolidation/customers/price", ADMIN, { body: { planId: P1, customerId: PC_X } });
    assert.equal(none.status, 400, none.message);
    const tiny = await callRoute("POST /admin/whr-consolidation/customers/price", ADMIN, { body: { planId: P1, customerId: PC_X, unitPriceNormal: 0.001 } });
    assert.equal(tiny.status, 400, "0.001 必须拦");
    assert.deepEqual(writes(), [], `被拦下还写了库：${writes().join(", ")}`);
    assert.equal(pcRow(PC_X).unitPriceNormal, 550, "价被改了");
    // 整柜取消了就不许再改价（改一次会把柜里没付款的单全重算）
    seed();
    mem.db.whrConsolidationPlan.find((x: Row) => x.id === P1)!.status = "cancelled";
    const cancelled = await callRoute("POST /admin/whr-consolidation/customers/price", ADMIN, { body: { planId: P1, customerId: PC_X, unitPriceNormal: 580 } });
    assert.ok(cancelled.status >= 400, `已取消的柜还能改单价：${cancelled.status}`);
    assert.equal(pcRow(PC_X).unitPriceNormal, 550, "已取消的柜价被改了");
  });

  await check("5c) 代理客户的柜价不能低于给代理的价：建柜 / 加客户 / 改单价三处都拦，什么都不写", async () => {
    // 夹具：代理价 500 / 600 / 700
    seed();
    const low = await callRoute("POST /admin/whr-consolidation/plans", ADMIN, {
      body: { destinationTh: "曼谷", customers: [{ clientId: C_AG, unitPriceNormal: 400, unitPriceInspection: 700, unitPriceSensitive: 800 }] },
    });
    assert.equal(low.status, 400, `建柜没拦住低于代理价：${low.status} ${low.message}`);
    assert.ok(/不能低于给代理的价 500/.test(low.message), low.message);
    assert.deepEqual(writes(), [], `被拦下还写了库：${writes().join(", ")}`);

    seed();
    const lowAdd = await callRoute("POST /admin/whr-consolidation/customers/add", STAFF, {
      body: { planId: P2, clientId: C_AG, unitPriceNormal: 600, unitPriceInspection: 500, unitPriceSensitive: 800 },
    });
    assert.equal(lowAdd.status, 400, `加客户没拦住低于代理价：${lowAdd.status} ${lowAdd.message}`);
    /**
     * ⚠️ 员工看到的这句话**不许带代理价、也不许暴露这个客户归代理**
     *（9-15 确认单：员工在任何地方都看不到客户属于哪个代理、代理价、返现；Opus 第二轮复核第 2 条）。
     */
    assert.ok(/填低了/.test(lowAdd.message), lowAdd.message);
    assertNoAgentInfo("员工加客户被拦时的报错", { message: lowAdd.message });
    // 注意：夹具里这个客户的名字就叫「代理客户」，所以只能挑「代理价」这类字眼和那个数字，不能整段搜「代理」
    assert.ok(!/600/.test(lowAdd.message), `报错把代理价露给员工了：${lowAdd.message}`);
    assert.ok(!/代理的价|代理价|所属代理/.test(lowAdd.message), `报错跟员工提代理了：${lowAdd.message}`);
    assert.deepEqual(writes(), [], "被拦下还写了库");

    // 超管看同一件事：给具体数字，方便他判断该填多少
    seed();
    const lowAddAdmin = await callRoute("POST /admin/whr-consolidation/customers/add", ADMIN, {
      body: { planId: P2, clientId: C_AG, unitPriceNormal: 600, unitPriceInspection: 500, unitPriceSensitive: 800 },
    });
    assert.equal(lowAddAdmin.status, 400, lowAddAdmin.message);
    assert.ok(/商检货单价不能低于给代理的价 600/.test(lowAddAdmin.message), lowAddAdmin.message);

    seed();
    const lowEdit = await callRoute("POST /admin/whr-consolidation/customers/price", ADMIN, {
      body: { planId: P1, customerId: PC_A, unitPriceSensitive: 650 },
    });
    assert.equal(lowEdit.status, 400, `改单价没拦住低于代理价：${lowEdit.status} ${lowEdit.message}`);
    assert.ok(/敏感货单价不能低于给代理的价 700/.test(lowEdit.message), lowEdit.message);

    // 湘泰自己的客户不受这道闸管（想填多低填多低）
    seed();
    const xt = await callRoute("POST /admin/whr-consolidation/customers/price", ADMIN, {
      body: { planId: P1, customerId: PC_X, unitPriceNormal: 1 },
    });
    assert.equal(xt.status, 200, `湘泰客户被代理价闸误伤了：${xt.message}`);
  });

  await check("5d) 改单价：锁之前这个客户被移出柜了 → 锁里重读拦下，404 不报服务器错误、什么都没写", async () => {
    seed();
    mem.onEvent = (e) => {
      if (e === `lock:plan:${P1}`) {
        mem.db.whrConsolidationPlanCustomer = mem.db.whrConsolidationPlanCustomer.filter((c: Row) => c.id !== PC_X);
      }
    };
    const r = await callRoute("POST /admin/whr-consolidation/customers/price", ADMIN, { body: { planId: P1, customerId: PC_X, unitPriceNormal: 580 } });
    assert.equal(r.status, 404, `锁里没重读这一行：${r.status} ${r.message}`);
    assert.ok(/移出/.test(r.message), r.message);
    assert.deepEqual(writes(), [], `被拦下还写了库：${writes().join(", ")}`);
  });

  await check("5g) 改单价的下限判断用**锁里重读**那一行：事务外看着「另外两档偏低」，锁到之后其实已经被人改好了 → 不许误拦", async () => {
    /**
     * 上一版为了锁序（agents 必须排在计划前面），拿**事务外**读到的现价先判了一遍下限。
     * 场景：柜里普货一度是 400（低于代理价 500），另一个人正在把它改回 600；
     * 我这次只改敏感货 800 → 750（合法）。事务外那份快照里普货还是 400 → 上一版当场 400 把我拦下来，
     * 而锁到计划、重读那一行时普货已经是 600 —— 这一拦是错的（Opus 第三轮复核第 10 条）。
     * 现在拆成「先只拿锁读下限、锁完计划重读之后再判」，这一项就是盯它。
     */
    seed();
    pcRow(PC_A).unitPriceNormal = 400; // 事务外会读到这份「脏」快照
    mem.onEvent = (e) => {
      // 客户价排队锁到手那一刻，别人的事务已经提交：普货其实已经改回 600
      if (e === `lock:client_price:${C_AG}`) pcRow(PC_A).unitPriceNormal = 600;
    };
    const r = await callRoute("POST /admin/whr-consolidation/customers/price", ADMIN, {
      body: { planId: P1, customerId: PC_A, unitPriceSensitive: 750 },
    });
    mem.onEvent = null;
    assert.equal(r.status, 200, `合法的改价被误拦了（用的还是事务外那份快照）：${r.status} ${r.message}`);
    assert.equal(pcRow(PC_A).unitPriceSensitive, 750);
    assert.equal(pcRow(PC_A).unitPriceNormal, 600, "别人改回去的那一档不许被覆盖");

    // 反方向必须照旧拦住：锁到之后另一档才被改低 → 这次改动会留下一个低于代理价的柜，必须 400
    seed();
    mem.onEvent = (e) => {
      if (e === `lock:client_price:${C_AG}`) pcRow(PC_A).unitPriceNormal = 400;
    };
    const bad = await callRoute("POST /admin/whr-consolidation/customers/price", ADMIN, {
      body: { planId: P1, customerId: PC_A, unitPriceSensitive: 750 },
    });
    mem.onEvent = null;
    assert.equal(bad.status, 400, `锁里那一份变低了却放行：${bad.status} ${bad.message}`);
    assert.equal(pcRow(PC_A).unitPriceSensitive, 800, "被拦下还把价改了");
  });

  await check("5h) 改单价：柜里那一行的客户在 users 表里查不到（归属/公司对不上）→ 400 拦下，不许把下限闸整条跳过", async () => {
    /**
     * CLAUDE.md #27：加了过滤必须加「查不到就 return」。上一版这里是 `continue` ——
     * 柜里那行的 clientId 在 users 里查不到（companyId / role 对不上）时，
     * 这道算钱的闸整条静默跳过，代理客户的柜价想填多低都行（Opus 第三轮复核第 12 条）。
     */
    seed();
    pcRow(PC_A).clientId = "zz_b1_ghost";
    const r = await callRoute("POST /admin/whr-consolidation/customers/price", ADMIN, {
      body: { planId: P1, customerId: PC_A, unitPriceNormal: 1 },
    });
    assert.equal(r.status, 400, `客户查不到却放行了：${r.status} ${r.message}`);
    assert.ok(/查不到/.test(r.message), r.message);
    assert.equal(pcRow(PC_A).unitPriceNormal, 600, "被拦下还把价改了");
    assert.deepEqual(writes(), [], `被拦下还写了库：${writes().join(", ")}`);
  });

  await check("5e) 改单价：已付款的单金额和快照一个字不动（只重算没付款的）", async () => {
    seed();
    // 现造一张**已付款**的单：金额和快照在付款那一刻就定死了，改单价不许动它
    mem.db.whrConsolidationPrealert.push({
      ...JSON.parse(JSON.stringify(pa(PA_X))),
      id: "zz_b1_paidone",
      status: "paid",
      totalFee: 825,
      paidPriceNormal: 550,
      paidPriceInspection: 650,
      paidPriceSensitive: 750,
    });
    const before = JSON.parse(JSON.stringify(mem.db.whrConsolidationPrealert.filter((x: Row) => x.status === "paid")));
    const r = await callRoute("POST /admin/whr-consolidation/customers/price", ADMIN, { body: { planId: P1, customerId: PC_X, unitPriceNormal: 580 } });
    assert.equal(r.status, 200, r.message);
    const after = mem.db.whrConsolidationPrealert.filter((x: Row) => x.status === "paid");
    assert.deepEqual(JSON.parse(JSON.stringify(after)), before, "已付款的单被改了");
  });

  await check("5f) 改单价只有超管能调：员工 403，一次库都不碰", async () => {
    seed();
    const r = await callRoute("POST /admin/whr-consolidation/customers/price", STAFF, { body: { planId: P1, customerId: PC_X, unitPriceNormal: 580 } });
    assert.equal(r.status, 403, `员工能改单价了：${r.status} ${r.message}`);
    assert.deepEqual(writes(), [], "被拦下还写了库");
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

  await check("15) 长期价两个写接口都关着：超管和代理调都 400，价没动、一把锁都没拿（2026-09-18 拍板）", async () => {
    /**
     * 老板 2026-09-18 拍板「价格每个柜当场填」，代理端前端下线，但**后端保留**。
     * 光拆页面入口不够：这两个接口一被调到，`setClientWhrPrice` 会把这位客户所有在跑的柜里的价一次覆盖掉
     *（Opus 复核第 2 条）。所以功能关闭期间接口一律拒绝；开关在 long-term-price.ts。
     */
    seed();
    const admin = await callRoute("POST /admin/clients/whr-price", ADMIN, {
      body: { clientId: C_XT, unitPriceNormal: 999, unitPriceInspection: 999, unitPriceSensitive: 999 },
    });
    assert.equal(admin.status, 400, `超管那条没关：${admin.status} ${admin.message}`);
    assert.ok(/暂时关闭/.test(admin.message), admin.message);
    assert.equal(priceOf(C_XT)!.priceNormal, 550, "长期价被改了");
    assert.equal(pcRow(PC_X).unitPriceNormal, 550, "柜里的价被覆盖了");
    assert.deepEqual(mem.events, [], `被拦下还拿了锁 / 写了库：${mem.events.join(", ")}`);

    // 代理那条（POST /agent/clients/price）在 scripts/test-agent-portal-isolation.ts 里用真库测（这份内存桩不注册代理端路由）
    const { LONG_TERM_PRICE_WRITE_ENABLED } = await import("../apps/api/src/modules/whr-consolidation/long-term-price");
    assert.equal(LONG_TERM_PRICE_WRITE_ENABLED, false, "开关被打开了：打开前先想清楚它会覆盖柜里当场填的价");
  });

  await check("16) 保留下来的长期价逻辑本身没坏（直接调函数测，开回来时还能用）", async () => {
    const { setClientWhrPrice } = await import("../apps/api/src/modules/whr-consolidation/long-term-price");
    // ① 湘泰客户：存价、记是超管改的、在跑的柜跟着改、没付款的单重算（1750 → 1780）
    seed();
    const okRes = await setClientWhrPrice({
      companyId: "c1",
      clientId: C_XT,
      prices: { normal: 560, inspection: 660, sensitive: 760 },
      actor: { userId: ADMIN.userId, role: "admin" },
    });
    assert.equal(okRes.updatedPlanRows, 1);
    assert.equal(priceOf(C_XT)!.priceNormal, 560);
    assert.equal(priceOf(C_XT)!.updatedByRole, "admin");
    assert.equal(pcRow(PC_X).unitPriceNormal, 560);
    assert.equal(Number(pa(PA_X).totalFee), 1780);

    // ② 代理客户：价不能低于给代理的价（代理价 500/600/700）
    seed();
    await assert.rejects(
      () => setClientWhrPrice({
        companyId: "c1",
        clientId: C_AG,
        prices: { normal: 400, inspection: 700, sensitive: 800 },
        actor: { userId: "zz_b1_agentlogin", role: "agent" },
      }),
      /不能低于/,
      "代理价下限没拦住",
    );
    assert.equal(priceOf(C_AG)!.priceNormal, 600, "被拦下还把价改了");

    /**
     * ③④ 代理那条接口的**归属闸**（`setAgentClientWhrPrice`）。
     * ⚠️ 接口现在进门就被开关拦成 400，这道闸**没有任何请求走得到** ——
     * 所以直接调函数测，不然哪天开回来它坏了没人知道（复核 2026-09-18 第 6 条）。
     */
    const { setAgentClientWhrPrice } = await import("../apps/api/src/modules/whr-consolidation/long-term-price");
    const asAgent = (clientId: string, prices: Record<"normal" | "inspection" | "sensitive", unknown>) =>
      setAgentClientWhrPrice({
        companyId: "c1", agentId: AGENT_ID, clientId, prices,
        actor: { userId: "zz_b1_agentlogin", role: "agent" },
        notFoundMessage: "客户不存在或不在你名下",
      });

    // ③ 自己名下的客户：改得动，柜里跟着改
    seed();
    const mine = await asAgent(C_AG, { normal: 620, inspection: 720, sensitive: 820 });
    assert.equal(mine.updatedPlanRows, 1);
    assert.equal(priceOf(C_AG)!.priceNormal, 620);
    assert.equal(pcRow(PC_A).unitPriceNormal, 620);

    // ④ 别人家的客户（湘泰自己的）：404，而且是在**拿了客户价锁之后**判的，一行都没写
    seed();
    await assert.rejects(() => asAgent(C_XT, { normal: 900, inspection: 900, sensitive: 900 }), /不在你名下/, "代理改到了不是自己名下的客户");
    assert.equal(priceOf(C_XT)!.priceNormal, 550, "被拦下还把别人家客户的价改了");
    assert.equal(pcRow(PC_X).unitPriceNormal, 550, "被拦下还把别人家柜里的价改了");
    assert.deepEqual(writes(), [], `被拦下还写了库：${writes().join(", ")}`);
    assert.ok(mem.events.includes(`lock:client_price:${C_XT}`), "归属判断没在客户价锁里做（超管同时改归属就串了）");

    /**
     * ⑤⑥⑦ 超管那条接口（`POST /admin/clients/whr-price`）的「代理客户超管不许改」那道闸。
     * ⚠️ 跟代理那条同样的处境：接口进门就被开关拦成 400，这道闸**没有任何请求走得到**，
     * 所以直接调 `setNonAgentClientWhrPrice`（Opus 第三轮复核第 6 条）。
     */
    const { setNonAgentClientWhrPrice, AGENT_CLIENT_PRICE_READONLY_MESSAGE } = await import("../apps/api/src/modules/whr-consolidation/long-term-price");
    const asAdmin = (clientId: string, prices: Record<"normal" | "inspection" | "sensitive", unknown>) =>
      setNonAgentClientWhrPrice({ companyId: "c1", clientId, prices, actor: { userId: ADMIN.userId, role: "admin" } });

    // ⑤ 湘泰自己的客户：改得动
    seed();
    const xt = await asAdmin(C_XT, { normal: 600, inspection: 700, sensitive: 800 });
    assert.equal(xt.updatedPlanRows, 1);
    assert.equal(priceOf(C_XT)!.priceNormal, 600);

    // ⑥ 代理的客户：403，价没动
    seed();
    await assert.rejects(
      () => asAdmin(C_AG, { normal: 900, inspection: 900, sensitive: 900 }),
      (e: Error) => e.message === AGENT_CLIENT_PRICE_READONLY_MESSAGE,
      "超管改到了代理客户的长期价",
    );
    assert.equal(priceOf(C_AG)!.priceNormal, 600, "被拦下还把价改了");

    // ⑦ 锁里重判：拿到客户价锁那一刻，这个客户刚被改到代理名下 → 照样 403
    seed();
    mem.onEvent = (e) => {
      if (e === `lock:client_price:${C_XT}`) {
        mem.db.user.find((u: Row) => u.id === C_XT)!.agentId = AGENT_ID;
      }
    };
    await assert.rejects(
      () => asAdmin(C_XT, { normal: 900, inspection: 900, sensitive: 900 }),
      (e: Error) => e.message === AGENT_CLIENT_PRICE_READONLY_MESSAGE,
      "归属是在锁外面判的：锁那一刻客户被改到代理名下就漏了",
    );
    mem.onEvent = null;
    assert.equal(priceOf(C_XT)!.priceNormal, 550, "被拦下还把价改了");
  });

  await check("17) 长期价的单价闸：0.001 / 3 位小数 / 缺档在碰数据库之前就拦（parseWhrPriceInput）", async () => {
    const { parseWhrPriceInput } = await import("../apps/api/src/modules/whr-consolidation/long-term-price");
    seed();
    for (const bad of [
      { normal: 0.001, inspection: 1, sensitive: 1 },
      { normal: 12.345, inspection: 1, sensitive: 1 },
      { normal: 600, inspection: 1 },
    ]) {
      assert.throws(() => parseWhrPriceInput(bad as Record<"normal" | "inspection" | "sensitive", unknown>), /单价/, JSON.stringify(bad));
    }
    assert.deepEqual(mem.events, [], "校验之前就不该碰库");
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

  await check("21) 客户端：不再下发「有没有长期价」（价格每个柜当场填），柜里那行的单价照旧给", async () => {
    seed();
    const r = await callRoute("GET /client/whr-consolidation/plans", CLIENT_AG);
    assert.equal(r.status, 200, r.message);
    assert.ok(!("hasLongTermPrice" in r.data), "还在下发 hasLongTermPrice（页顶那句「暂未配对价格」已经去掉了）");
    const mine = r.data.items.find((x: Row) => x.planId === P1);
    assert.ok(mine, "客户看不到自己参与的柜");
    assert.equal(mine.myUnitPriceNormal, 600, "柜里那行的普货单价没给客户");
    // 没配过长期价的客户照样能用（以前会被页顶那句话挡住）
    const noPrice = await callRoute("GET /client/whr-consolidation/plans", CLIENT_NOPRICE);
    assert.equal(noPrice.status, 200, noPrice.message);
    assert.ok(!("hasLongTermPrice" in noPrice.data));
    assert.deepEqual(noPrice.data.items, []);
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

    /**
     * 2026-09-18：原来这里测「长期价低于代理价 → 409」。价格改成每柜当场填之后这条闸删了 ——
     * 进过任何一个仓库版集货柜的客户，早就被上面那道「有业务记录」拦住了（柜价低于代理价的前提就是他在柜里），
     * 真正把关的是建柜 / 加客户 / 改单价那三处的下限闸（本文件 5c）。这里改成钉住「进过柜就拦」这件事。
     */
    mem.db.whrConsolidationPlanCustomer.push({
      id: "zz_b1_pc_low", planId: P1, companyId: "c1", clientId: C_NEW_LOW,
      unitPriceNormal: 450, unitPriceInspection: 650, unitPriceSensitive: 750,
      totalVolumeM3: 0, totalPackages: 0, totalPrealerts: 0, totalFee: 0, deliveryAddress: null, createdAt: T0, updatedAt: T0,
    });
    const low = await callRoute("POST /admin/users/client/update", ADMIN, { body: { id: C_NEW_LOW, agentId: AGENT_ID } });
    assert.equal(low.status, 409, low.message);
    assert.ok(low.message.includes("仓库版集货"), low.message);
    assert.equal(mem.db.user.find((u) => u.id === C_NEW_LOW)!.agentId, null, "被拦下还是把归属改了");

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

  /* ───────────── 9. 代理的客户不许有普通版集货任务（4.1，第 2 轮复核：改归属 × 建任务竞态） ───────────── */

  const CLIENT_NEW = { userId: C_NEW, companyId: "c1", role: "client", name: "空白新客户", agentId: null };

  await check("29) 湘泰客户建普通版任务：先拿客户排队锁（跟改归属同一把）→ 取号 → 写，成功", async () => {
    seed();
    const r = await callRoute("POST /client/consolidation/tasks", CLIENT_NEW, { body: { destinationTh: "曼谷三号路" } });
    assert.equal(r.status, 200, `${r.status} ${r.message}`);
    assert.equal(mem.db.consolidationTask.filter((t) => t.clientId === C_NEW).length, 1);
    const w = writes().find((e) => e.startsWith("write:consolidationTask:"))!;
    assertBefore(`lock:client_price:${C_NEW}`, "lock:task_no", "建普通版任务：客户锁要排在取号锁前面（跟改归属锁序一致）");
    assertBefore("lock:task_no", w, "建普通版任务：取号锁要在写之前");
  });

  await check("30) 代理的客户直接打建普通版任务路由（绕过 server.ts 统一闸）→ 403「该功能暂未开放」，一行没写", async () => {
    seed();
    const r = await callRoute("POST /client/consolidation/tasks", CLIENT_AG, { body: { destinationTh: "曼谷四号路" } });
    assert.equal(r.status, 403, `${r.status} ${r.message}`);
    assert.ok(r.message.includes("该功能暂未开放"), r.message);
    assert.equal(mem.db.consolidationTask.length, 0);
    assert.deepEqual(writes(), []);
  });

  await check("31) 进门时还是湘泰客户、**锁住那一刻超管把他改归代理** → 锁里现读 agentId 拦下 403，任务没建", async () => {
    seed();
    mem.onEvent = (e) => {
      if (e === `lock:client_price:${C_NEW}`) mem.db.user.find((u) => u.id === C_NEW)!.agentId = AGENT_ID;
    };
    const r = await callRoute("POST /client/consolidation/tasks", CLIENT_NEW, { body: { destinationTh: "曼谷五号路" } });
    assert.equal(r.status, 403, `${r.status} ${r.message}`);
    assert.equal(mem.db.consolidationTask.length, 0);
    assert.ok(!mem.events.includes("lock:task_no"), `拦下之后不该再取号：${mem.events.join(" → ")}`);
  });

  await check("32) 改归属：事务外没记录、锁住那一刻客户建了普通版任务 → 锁里重查 409（普通版任务点名）", async () => {
    seed();
    mem.onEvent = (e) => {
      if (e === `lock:client_price:${C_NEW}`) {
        mem.db.consolidationTask.push({ id: "zz_b1_ctRace", taskNo: "JH0009001", companyId: "c1", clientId: C_NEW, status: "collecting" });
      }
    };
    const r = await callRoute("POST /admin/users/client/update", ADMIN, { body: { id: C_NEW, agentId: AGENT_ID } });
    assert.equal(r.status, 409, `${r.status} ${r.message}`);
    assert.ok(r.message.includes("普通版集货"), r.message);
    assert.equal(mem.db.user.find((u) => u.id === C_NEW)!.agentId, null);
  });

  /* ───────────── 9. Codex 审查修复（2026-09-15） ───────────── */

  await check("33) 付款后改价、再撤销付款：单子按柜里现在的单价重算（1300 → 1700），重付扣 1700，快照和返现同一个价；锁序 计划 → 预报单 → 客户汇总 → 钱包", async () => {
    seed();
    const { setClientWhrPrice } = await import("../apps/api/src/modules/whr-consolidation/long-term-price");
    const first = await callRoute("POST /client/whr-consolidation/pay", CLIENT_AG, { body: { planId: P1, prealertId: PA_A } });
    assert.equal(first.status, 200, first.message);
    assert.equal(balanceOf(C_AG), 3700);
    // 代理把客户价改高：柜里单价跟着改，已付款那张单的金额不动（4.14）
    await setClientWhrPrice({
      companyId: "c1", clientId: C_AG, prices: { normal: 800, inspection: 900, sensitive: 1000 },
      actor: { userId: "zz_b1_agentlogin", role: "agent" },
    });
    assert.equal(pcRow(PC_A).unitPriceNormal, 800);
    assert.equal(Number(pa(PA_A).totalFee), 1300, "已付款的金额不该跟着改价变");

    mem.onEvent = null;
    mem.events = [];
    const revoke = await callRoute("POST /admin/whr-consolidation/payments/revoke", ADMIN, { body: { prealertId: PA_A, reason: "改价后重付" } });
    assert.equal(revoke.status, 200, revoke.message);
    assert.equal(balanceOf(C_AG), 5000, "退的是实际扣过的 1300");
    assert.equal(Number(pa(PA_A).totalFee), 1700, "回到待付款就按柜里现在的单价重算：1.5×800 + 0.5×1000");
    assert.equal(Number(pcRow(PC_A).totalFee), 1700, "客户汇总跟着重算");
    assertBefore(`lock:plan:${P1}`, `lock:prealert:${PA_A}`, "撤销付款：先锁计划再锁单");
    assertBefore(`write:whrConsolidationPlanCustomer:${PC_A}`, `lock:wallet:${C_AG}`, "撤销付款：客户汇总写完再碰钱包（锁序 计划 → 预报单/客户 → 钱包）");

    const again = await callRoute("POST /client/whr-consolidation/pay", CLIENT_AG, { body: { planId: P1, prealertId: PA_A } });
    assert.equal(again.status, 200, again.message);
    const row = pa(PA_A);
    assert.deepEqual([row.paidPriceNormal, row.paidPriceInspection, row.paidPriceSensitive], [800, 900, 1000]);
    const charged = 5000 - balanceOf(C_AG);
    assert.equal(charged, 1700, "重付扣 1700");
    assert.equal(charged, 1.5 * row.paidPriceNormal + 0.5 * row.paidPriceSensitive, "扣的钱 = 快照单价算出来的钱");
    assert.equal(row.rebateAmount, 600, "返现按同一个价：1.5×(800−500) + 0.5×(1000−700)");
  });

  await check("34) 付款最后一道闸：代理客户的单金额跟柜里单价对不上（数据被改脏）→ 409 不扣钱、状态不变、不记快照；湘泰客户同样情况照旧按单子上的金额扣", async () => {
    seed();
    pa(PA_A).totalFee = 1200; // 按柜里单价应是 1.5×600 + 0.5×800 = 1300
    mem.onEvent = null;
    mem.events = [];
    const r = await callRoute("POST /client/whr-consolidation/pay", CLIENT_AG, { body: { planId: P1, prealertId: PA_A } });
    assert.equal(r.status, 409, `${r.status} ${r.message}`);
    assert.ok(r.message.includes("对不上"), r.message);
    assert.equal(balanceOf(C_AG), 5000);
    assert.equal(pa(PA_A).status, "received_pending_payment");
    assert.equal(pa(PA_A).paidPriceNormal, null);
    assert.deepEqual(writes(), [], "拦下时一行都不许写");

    seed();
    pa(PA_X).totalFee = 1700; // 按柜里单价应是 2×550 + 650 = 1750（上线前「删了货没改价」那种老金额）
    const x = await callRoute("POST /client/whr-consolidation/pay", CLIENT_XT, { body: { planId: P1, prealertId: PA_X } });
    assert.equal(x.status, 200, x.message);
    assert.equal(balanceOf(C_XT), 3300, "湘泰客户照单子上的金额扣，不因为老数据付不了款");
  });

  await check("35) 改归属：锁住客户这一行那一刻有人给他建了第一张运单 → 锁里数到、409 点名运单，归属不变；锁序 客户价锁 → 客户行 → 写（Codex 审查 P2-1）", async () => {
    seed();
    mem.onEvent = (e) => {
      if (e === `lock:user:${C_NEW}`) mem.db.order.push({ id: "zz_b1_oRace", companyId: "c1", clientId: C_NEW });
    };
    const r = await callRoute("POST /admin/users/client/update", ADMIN, { body: { id: C_NEW, agentId: AGENT_ID } });
    assert.equal(r.status, 409, `${r.status} ${r.message}`);
    assert.ok(r.message.includes("运单 1 张"), r.message);
    assert.equal(mem.db.user.find((u) => u.id === C_NEW)!.agentId, null);

    seed();
    mem.onEvent = null;
    mem.events = [];
    const moved = await callRoute("POST /admin/users/client/update", ADMIN, { body: { id: C_NEW, agentId: AGENT_ID } });
    assert.equal(moved.status, 200, moved.message);
    assertBefore(`lock:client_price:${C_NEW}`, `lock:user:${C_NEW}`, "改归属：先拿客户价排队锁，再锁客户行");
    assertBefore(`lock:user:${C_NEW}`, `write:user:${C_NEW}`, "改归属：锁住客户行之后才写");
  });

  await check("36) 移除柜里客户：事务外看没有预报单、锁住计划那一刻客户刚建了一张 → 锁里重数 400，客户行和新单都在；没单的照常移除，锁计划在删之前（Codex 审查 O1）", async () => {
    seed();
    const PC_RM = "zz_b1_pcRm";
    const PA_RM = "zz_b1_paRm";
    mem.db.whrConsolidationPlanCustomer.push({
      id: PC_RM, planId: P1, companyId: "c1", clientId: C_NEW, unitPriceNormal: 600, unitPriceInspection: 700, unitPriceSensitive: 800,
      totalVolumeM3: 0, totalFee: null, deliveryAddress: "曼谷三号路", totalPrealerts: 0, totalPackages: 0, createdAt: T0, updatedAt: T0,
    });
    mem.onEvent = (e) => {
      if (e === `lock:plan:${P1}` && !mem.db.whrConsolidationPrealert.some((x) => x.id === PA_RM)) {
        mem.db.whrConsolidationPrealert.push(prealertRow(PA_RM, PC_RM, "WHRP9009", "pending", null));
      }
    };
    const blocked = await callRoute("POST /admin/whr-consolidation/customers/remove", ADMIN, { body: { planId: P1, customerId: PC_RM } });
    assert.equal(blocked.status, 400, `${blocked.status} ${blocked.message}`);
    assert.ok(blocked.message.includes("预报单"), blocked.message);
    assert.ok(pcRow(PC_RM), "客户行不该被删");
    assert.ok(mem.db.whrConsolidationPrealert.some((x) => x.id === PA_RM), "客户刚建的预报单还在");

    mem.onEvent = null;
    mem.db.whrConsolidationPrealert = mem.db.whrConsolidationPrealert.filter((x) => x.id !== PA_RM);
    mem.events = [];
    const removed = await callRoute("POST /admin/whr-consolidation/customers/remove", ADMIN, { body: { planId: P1, customerId: PC_RM } });
    assert.equal(removed.status, 200, removed.message);
    assert.ok(!pcRow(PC_RM), "没单的客户照常移除");
    assertBefore(`lock:plan:${P1}`, `delete:whrConsolidationPlanCustomer:${PC_RM}`, "移除客户：先锁计划再删");
  });

  /** 模拟员工「移除柜里客户」已经提交：客户行连同名下预报单一起没了（数据库是级联删） */
  const dropPlanCustomer = (pcId: string): void => {
    const gone = new Set(mem.db.whrConsolidationPrealert.filter((x) => x.customerId === pcId).map((x) => x.id));
    mem.db.whrConsolidationPrealertItem = mem.db.whrConsolidationPrealertItem.filter((x) => !gone.has(x.prealertId));
    mem.db.whrConsolidationPrealert = mem.db.whrConsolidationPrealert.filter((x) => x.customerId !== pcId);
    mem.db.whrConsolidationPlanCustomer = mem.db.whrConsolidationPlanCustomer.filter((x) => x.id !== pcId);
  };

  await check("37) 客户自己填泰国地址：先锁计划再写；**锁住那一刻被移出柜** → 403 不报服务器错误、什么都没写；**锁住那一刻刚发运** → 400 地址不变（Codex 第二轮 O1-R1）", async () => {
    seed();
    const r = await callRoute("POST /client/whr-consolidation/address", CLIENT_XT, { body: { planId: P1, deliveryAddress: "  清迈四号路  " } });
    assert.equal(r.status, 200, r.message);
    assert.equal(pcRow(PC_X).deliveryAddress, "清迈四号路");
    assertBefore(`lock:plan:${P1}`, `write:whrConsolidationPlanCustomer:${PC_X}`, "客户填地址要先锁计划再写");

    seed();
    mem.onEvent = (e) => {
      if (e === `lock:plan:${P1}`) dropPlanCustomer(PC_X);
    };
    const removed = await callRoute("POST /client/whr-consolidation/address", CLIENT_XT, { body: { planId: P1, deliveryAddress: "新地址" } });
    assert.equal(removed.status, 403, `${removed.status} ${removed.message}`);
    assert.deepEqual(writes(), [], "被移出柜了还写了东西");

    seed();
    mem.onEvent = (e) => {
      if (e === `lock:plan:${P1}`) pa(PA_X).status = "shipped";
    };
    const shipped = await callRoute("POST /client/whr-consolidation/address", CLIENT_XT, { body: { planId: P1, deliveryAddress: "新地址" } });
    assert.equal(shipped.status, 400, `${shipped.status} ${shipped.message}`);
    assert.equal(pcRow(PC_X).deliveryAddress, "曼谷二号路");
  });

  await check("38) 超管替客户填泰国地址：事务外查到客户、**锁住计划那一刻客户被移出柜** → 404 不报服务器错误、什么都没写（Codex 第二轮 O1-R1）", async () => {
    seed();
    mem.onEvent = (e) => {
      if (e === `lock:plan:${P1}`) dropPlanCustomer(PC_A);
    };
    const r = await callRoute("POST /admin/whr-consolidation/address", ADMIN, { body: { planId: P1, customerId: PC_A, deliveryAddress: "新地址" } });
    assert.equal(r.status, 404, `${r.status} ${r.message}`);
    assert.deepEqual(writes(), [], "客户被移出柜了还写了东西");
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
