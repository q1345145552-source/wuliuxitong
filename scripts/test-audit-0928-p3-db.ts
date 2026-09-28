/**
 * 2026-09-28 审查报告那批小 bug —— 连库回归（真 handler + 真 PostgreSQL）。
 *
 * 覆盖：
 *   G  运单顶部「本月已签收」：按真签收轨迹的时间数（签收记在子单上也算父单），不按「最后修改时间」
 *   I  装柜详情接口带 isFcl（整柜在详情里的「删柜 / 改运输方式」禁用全看它）
 *   J  集货任务给客户的轨迹备注：带空格的柜号整段抹掉；「柜号」两个字没写、直接夹着柜号的也抹
 *   K  确认收货写到父单上，不写到子单上
 *   L  客户建预报单：仓库不是那四个 → 400
 *   N  两个员工同时给刚满柜的集货任务报价：只留一条「已满柜 → 已报价」轨迹
 *   O  删仓库版集货计划的预览：状态写中文
 *   P  仓库版集货「操作」列表每一行带计划号
 *   A  运费配置的低消：空的、不是数字、负数 → 400，而且两个里有一个不对就都不存
 *
 * 只连测试库：DATABASE_URL 不带 neon.tech 的不跑（一次性 docker 库设 AGENT_PORTAL_TEST_ALLOW_DB=1）；
 * 没有 DATABASE_URL 打印「跳过」。测试数据全在假公司 zz_a0928_co 下，开跑前、跑完后都清干净；
 * 运费低消是全局配置（不分公司），测之前记下原值、测完原样写回。
 */
import assert from "node:assert/strict";

type Row = Record<string, any>;
type Auth = { userId: string; companyId: string; role: string; name: string };
const CO = "zz_a0928_co";
const ADMIN: Auth = { userId: "zz_a0928_admin", companyId: CO, role: "admin", name: "审计超管" };
const STAFF: Auth = { userId: "zz_a0928_staff", companyId: CO, role: "staff", name: "审计员工" };
const STAFF2: Auth = { userId: "zz_a0928_staff2", companyId: CO, role: "staff", name: "审计员工二" };
const CLIENT: Auth = { userId: "zz_a0928_client", companyId: CO, role: "client", name: "审计客户" };

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) { console.log("⚠️ 跳过：没有 DATABASE_URL（CI 没有数据库）—— 这一项等于没测"); return; }
  if (!url.includes("neon.tech") && process.env.AGENT_PORTAL_TEST_ALLOW_DB !== "1") {
    console.log("⚠️ 跳过：DATABASE_URL 不是 Neon 测试库，怕连到生产库不跑（确认是测试库可设 AGENT_PORTAL_TEST_ALLOW_DB=1）—— 这一项等于没测");
    return;
  }
  process.env.NODE_ENV = process.env.NODE_ENV || "test";
  const { prisma } = await import("../apps/api/src/db/prisma");
  const { BusinessError } = await import("../apps/api/src/modules/core/business-error");
  const pm: any = prisma;

  const routes = new Map<string, Function>();
  const app: any = {};
  for (const m of ["get", "post", "put", "patch", "delete"]) app[m] = (p: string, h: Function) => routes.set(`${m.toUpperCase()} ${p}`, h);
  (await import("../apps/api/src/modules/orders/routes")).registerOrderRoutes(app);
  (await import("../apps/api/src/modules/shipments/routes")).registerShipmentRoutes(app);
  (await import("../apps/api/src/modules/loading-manifests/routes")).registerLoadingManifestRoutes(app);
  (await import("../apps/api/src/modules/consolidation/routes")).registerConsolidationRoutes(app);
  (await import("../apps/api/src/modules/whr-consolidation/routes")).registerWhrConsolidationRoutes(app);
  (await import("../apps/api/src/modules/whr-consolidation/staff-routes")).registerWhrConsolidationStaffRoutes(app);
  (await import("../apps/api/src/modules/shipping-config/routes")).registerShippingConfigRoutes(app);

  async function call(key: string, auth: Auth, body: Row = {}, query: Record<string, string> = {}): Promise<{ status: number; data: any; message: string }> {
    const handler = routes.get(key);
    if (!handler) return { status: 404, data: undefined, message: `没有这个接口：${key}` };
    let status = 200; let raw: any;
    const res: any = { status(s: number) { status = s; return res; }, json(p: any) { raw = p; }, setHeader() {} };
    try { await handler({ body, query, headers: {}, auth }, res); }
    catch (e) { if (e instanceof BusinessError) { status = e.httpStatus; raw = { code: e.code, message: e.message }; } else throw e; }
    return { status, data: raw?.data, message: raw?.message ?? "" };
  }

  async function cleanup(): Promise<void> {
    const cs = await pm.container.findMany({ where: { companyId: CO }, select: { id: true } });
    await pm.shipmentContainerItem.deleteMany({ where: { containerId: { in: cs.map((c: Row) => c.id) } } });
    await pm.container.deleteMany({ where: { companyId: CO } });
    await pm.statusLog.deleteMany({ where: { companyId: CO } });
    await pm.orderProduct.deleteMany({ where: { companyId: CO } });
    await pm.shipment.deleteMany({ where: { companyId: CO } });
    await pm.order.deleteMany({ where: { companyId: CO } });
    await pm.consolidationStatusLog.deleteMany({ where: { companyId: CO } });
    await pm.consolidationTask.deleteMany({ where: { companyId: CO } });
    await pm.whrConsolidationPrealert.deleteMany({ where: { companyId: CO } });
    await pm.whrConsolidationPlanCustomer.deleteMany({ where: { companyId: CO } });
    await pm.whrConsolidationPlan.deleteMany({ where: { companyId: CO } });
    await pm.auditLog.deleteMany({ where: { companyId: CO } });
    await pm.user.deleteMany({ where: { companyId: CO } });
  }

  let passed = 0, failed = 0;
  async function check(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`✅ ${name}`); }
    catch (e: any) { failed++; console.log(`❌ ${name}\n   ${e?.message ?? e}`); }
  }

  // 运费低消是全局两行，先记下原值
  const MIN_KEYS = ["min_volume_sea_min_volume", "min_volume_land_min_volume"];
  const minBefore = await pm.aiStatusLabel.findMany({ where: { status: { in: MIN_KEYS } } });

  await cleanup();
  try {
    for (const u of [ADMIN, STAFF, STAFF2, CLIENT]) {
      await pm.user.create({ data: { id: u.userId, companyId: CO, role: u.role, name: u.name, passwordHash: "x", phone: `0${u.userId}`, status: "active" } });
    }
    const recv = { receiverNameTh: "r", receiverPhoneTh: "0", receiverAddressTh: "addr" };
    const mkOrder = (id: string, approvalStatus = "approved") => pm.order.create({ data: {
      id, companyId: CO, clientId: CLIENT.userId, warehouseId: "wh_yiwu_01", itemName: "鞋", productQuantity: 0,
      packageCount: 10, packageUnit: "box", transportMode: "sea", weightKg: 10, volumeM3: 0.1, approvalStatus, ...recv,
    } });
    const mkShip = (id: string, orderId: string, trackingNo: string, currentStatus: string, extra: Row = {}) => pm.shipment.create({ data: {
      id, companyId: CO, orderId, trackingNo, currentStatus, warehouseId: "wh_yiwu_01", transportMode: "sea", packageCount: 10, weightKg: 10, volumeM3: 0.1, ...extra,
    } });
    const mkLog = (id: string, shipmentId: string, toStatus: string, changedAt: Date) => pm.statusLog.create({ data: {
      id, companyId: CO, shipmentId, operatorId: STAFF.userId, operatorRole: "staff", fromStatus: "outForDelivery", toStatus, changedAt,
    } });

    // ---------- G 本月已签收 ----------
    const now = new Date();
    const OLD = new Date("2026-05-01T03:00:00Z");
    // ① 签收记在子单上（生产上绝大多数是这样）：父单要算
    await mkOrder("zz_a0928_g1");
    await mkShip("zz_a0928_g1p", "zz_a0928_g1", "ZZA0928G1", "delivered");
    await mkShip("zz_a0928_g1c", "zz_a0928_g1", "ZZA0928G1-1", "delivered", { parentTrackingNo: "ZZA0928G1" });
    await mkLog("zz_a0928_g1l", "zz_a0928_g1c", "delivered", now);
    // ② 五月就签收了、今天改了下备注（最后修改时间 = 今天）：不能算
    await mkOrder("zz_a0928_g2");
    await mkShip("zz_a0928_g2p", "zz_a0928_g2", "ZZA0928G2", "delivered", { remark: "今天改的备注" });
    await mkLog("zz_a0928_g2l", "zz_a0928_g2p", "delivered", OLD);
    // ③ 父单自己本月签收：算
    await mkOrder("zz_a0928_g3");
    await mkShip("zz_a0928_g3p", "zz_a0928_g3", "ZZA0928G3", "delivered");
    await mkLog("zz_a0928_g3l", "zz_a0928_g3p", "delivered", now);
    // ④ 本月签收过、后来退回：现在不是已签收，不算
    await mkOrder("zz_a0928_g4");
    await mkShip("zz_a0928_g4p", "zz_a0928_g4", "ZZA0928G4", "returned");
    await mkLog("zz_a0928_g4l", "zz_a0928_g4p", "delivered", now);

    await check("G 顶部「本月已签收」= 2（子单本月签收的父单 + 父单自己本月签收的）；五月签收今天改过备注的不算、签收后退回的不算", async () => {
      for (const [key, who] of [["GET /staff/shipments/overview", STAFF], ["GET /client/shipments/overview", CLIENT]] as const) {
        const r = await call(key, who);
        assert.equal(r.status, 200, r.message);
        assert.equal(r.data.signedThisMonthCount, 2, `${key} 给的是 ${r.data.signedThisMonthCount}（按最后修改时间数会是 3）`);
      }
    });

    // ---------- I 装柜详情带 isFcl ----------
    const FCL = await pm.container.create({ data: { companyId: CO, containerNo: "ZZFCL0928", containerType: "40HQ", currentStatus: "LOADING", transportMode: "sea", isFcl: true } });
    const LCL = await pm.container.create({ data: { companyId: CO, containerNo: "ZZLCL0928", containerType: "40HQ", currentStatus: "LOADING", transportMode: "sea" } });
    await check("I 装柜详情：整柜 isFcl = true、普通柜 isFcl = false（原来不返回，前端拿到 undefined）", async () => {
      const a = await call("GET /staff/loading-manifests/detail", STAFF, {}, { id: FCL.id });
      const b = await call("GET /staff/loading-manifests/detail", STAFF, {}, { id: LCL.id });
      assert.equal(a.status, 200, a.message); assert.equal(b.status, 200, b.message);
      assert.equal(a.data.isFcl, true);
      assert.equal(b.data.isFcl, false);
    });

    // ---------- J 集货任务给客户的轨迹备注 ----------
    const CNO = "L26 0821 9129";
    const TJ = await pm.consolidationTask.create({ data: {
      taskNo: "ZZA0928TJ", companyId: CO, clientId: CLIENT.userId, destinationTh: "曼谷", status: "loading", containerNo: CNO, loadingDate: "2026-09-20",
    } });
    const jLog = (toStatus: string, remark: string, sec: number) => pm.consolidationStatusLog.create({ data: {
      taskId: TJ.id, companyId: CO, operatorId: STAFF.userId, operatorRole: "staff", operatorName: STAFF.name,
      fromStatus: "paid", toStatus, remark, createdAt: new Date(Date.now() - sec * 1000),
    } });
    await jLog("loading", `柜号: ${CNO}`, 30);
    await jLog("shipped", `今天发车 ${CNO}，预计三天到`, 20);
    await jLog("shipped", "柜号：MSKU1234567，已开船", 10);
    await check("J 客户看集货任务轨迹：带空格的柜号整段抹掉、没写「柜号」直接夹着的也抹、标准柜号抹掉；柜号后面的正常内容留着", async () => {
      const r = await call("GET /client/consolidation/tasks/detail", CLIENT, {}, { taskId: TJ.id });
      assert.equal(r.status, 200, r.message);
      const remarks: string[] = r.data.statusLogs.map((l: Row) => l.remark ?? "");
      const wire = JSON.stringify(r.data.statusLogs);
      for (const piece of ["L26", "0821", "9129", "MSKU", "1234567"]) {
        assert.ok(!wire.includes(piece), `客户拿到的轨迹里还有柜号片段「${piece}」：${remarks.join(" | ")}`);
      }
      assert.ok(remarks.some((x) => x.includes("预计三天到")), `柜号后面的正常内容被一起抹了：${remarks.join(" | ")}`);
      assert.ok(remarks.some((x) => x.includes("已开船")), `「已开船」被一起抹了：${remarks.join(" | ")}`);
    });

    // ---------- K 确认收货写到父单 ----------
    // 客户预报的单先装走、分了柜，再补确认收货。子单**先**建（表里排在前面），不带条件取第一张就会拿到子单
    await mkOrder("zz_a0928_k", "shipped");
    await mkShip("zz_a0928_kc", "zz_a0928_k", "ZZA0928K-1", "loaded", { parentTrackingNo: "ZZA0928K", createdAt: new Date(Date.now() - 60_000) });
    // 真实数据里整票装走后父单剩 0（2026-09-28 分支审查：原来夹具让父单还剩 10 件，照不出「整票写回父单」）
    await mkShip("zz_a0928_kp", "zz_a0928_k", "ZZA0928K", "created", { packageCount: 0, weightKg: 0, volumeM3: 0 });
    await check("K 分过柜的单补确认收货：柜号、「已入库」轨迹写在父单上，父单数量 =「整票实收 − 已装走」，子单一个字没动", async () => {
      const r = await call("POST /staff/prealerts/receive", STAFF, { orderId: "zz_a0928_k", packageCount: 10, weightKg: 12.5, volumeM3: 0.2, batchNo: "ZZB0928" });
      assert.equal(r.status, 200, r.message);
      const p = await pm.shipment.findUnique({ where: { id: "zz_a0928_kp" } });
      const c = await pm.shipment.findUnique({ where: { id: "zz_a0928_kc" } });
      const o = await pm.order.findUnique({ where: { id: "zz_a0928_k" } });
      assert.equal(Number(o.weightKg), 12.5, "订单（整票）重量没更新");
      assert.equal(p.packageCount, 0, `父单件数应是 10 − 已装走 10 = 0，实际 ${p.packageCount}（整票写回父单 = 同一批货能再装一次柜）`);
      assert.equal(Number(p.weightKg), 2.5, `父单重量应是 12.5 − 已装走 10 = 2.5，实际 ${p.weightKg}`);
      assert.equal(Number(p.volumeM3), 0.1, `父单体积应是 0.2 − 已装走 0.1 = 0.1，实际 ${p.volumeM3}`);
      assert.equal(p.batchNo, "ZZB0928");
      assert.equal(p.currentStatus, "inWarehouseCN");
      assert.equal(Number(c.weightKg), 10, "子单重量被改了");
      assert.equal(c.batchNo, null);
      assert.equal(c.currentStatus, "loaded");
      const logs = await pm.statusLog.findMany({ where: { companyId: CO, shipmentId: { in: ["zz_a0928_kp", "zz_a0928_kc"] }, toStatus: "inWarehouseCN" } });
      assert.deepEqual(logs.map((l: Row) => l.shipmentId), ["zz_a0928_kp"], "「已入库」轨迹没写在父单上");
    });

    // ---------- L 客户建单仓库校验 ----------
    await check("L 客户建预报单：仓库写「义乌」/ 乱写 → 400，库里不多单；写 wh_yiwu_01 → 成功", async () => {
      const before = await pm.order.count({ where: { companyId: CO } });
      for (const w of ["义乌", "义乌仓", "wh_test"]) {
        const r = await call("POST /client/prealerts", CLIENT, { warehouseId: w, itemName: "耳机", packageCount: 2, transportMode: "sea" });
        assert.equal(r.status, 400, `仓库「${w}」没被拦，拿到 ${r.status}`);
        assert.match(r.message, /仓库/);
      }
      assert.equal(await pm.order.count({ where: { companyId: CO } }), before, "被拦的请求还是建了单");
      const ok = await call("POST /client/prealerts", CLIENT, { warehouseId: "wh_yiwu_01", itemName: "耳机", packageCount: 2, transportMode: "sea" });
      assert.equal(ok.status, 200, ok.message);
    });

    // ---------- N 并发报价 ----------
    await check("N 两个员工同时给刚满柜的任务报价（连测 5 个任务）：每个任务只有一条「已满柜 → 已报价」", async () => {
      const bad: string[] = [];
      for (let i = 0; i < 5; i++) {
        const t = await pm.consolidationTask.create({ data: { taskNo: `ZZA0928N${i}`, companyId: CO, clientId: CLIENT.userId, destinationTh: "曼谷", status: "full_confirmed" } });
        const fee = { taskId: t.id, bookingFee: 100, customsFee: 50, loadingFee: 30 };
        const rs = await Promise.all([call("POST /staff/consolidation/tasks/quote", STAFF, fee), call("POST /staff/consolidation/tasks/quote", STAFF2, { ...fee, bookingFee: 120 })]);
        for (const r of rs) assert.equal(r.status, 200, r.message);
        const logs = await pm.consolidationStatusLog.count({ where: { taskId: t.id, toStatus: "quoted" } });
        if (logs !== 1) bad.push(`${t.taskNo}：${logs} 条`);
        const firsts = rs.filter((r) => r.data?.isFirstQuote === true).length;
        if (firsts !== 1) bad.push(`${t.taskNo}：${firsts} 个请求都说自己是第一次报价`);
      }
      assert.deepEqual(bad, [], `重复的报价轨迹：${bad.join("；")}`);
    });

    // ---------- O / P 仓库版集货 ----------
    const plan = await pm.whrConsolidationPlan.create({ data: { companyId: CO, planNo: "ZZWHR0928", destinationTh: "曼谷", status: "loading", createdBy: STAFF.userId, creatorName: STAFF.name } });
    const pc = await pm.whrConsolidationPlanCustomer.create({ data: { id: "zz_a0928_pc", planId: plan.id, companyId: CO, clientId: CLIENT.userId, unitPriceNormal: 1, unitPriceInspection: 1, unitPriceSensitive: 1 } });
    await pm.whrConsolidationPrealert.create({ data: { customerId: pc.id, companyId: CO, trackingNo: "ZZA0928WP1", mark: "ZZMARK", status: "pending" } });
    await check("O 删计划的预览：状态写「装柜中」，不是 loading", async () => {
      const r = await call("POST /admin/whr-consolidation/plans/delete", ADMIN, { planId: plan.id, dryRun: true });
      const text = JSON.stringify(r.data ?? r.message);
      assert.ok(text.includes("「装柜中」"), `预览里没有中文状态：${text.slice(0, 400)}`);
      assert.ok(!text.includes("「loading」"), `预览里还是英文状态：${text.slice(0, 400)}`);
      assert.ok(await pm.whrConsolidationPlan.findUnique({ where: { id: plan.id } }), "预览把计划删了");
    });
    await check("P 仓库版集货「操作」列表：每一行带计划号（签收弹窗标题用）", async () => {
      const r = await call("GET /staff/whr-consolidation/operations", STAFF);
      assert.equal(r.status, 200, r.message);
      const p = (r.data.plans ?? []).find((x: Row) => x.planId === plan.id);
      assert.ok(p, "列表里没有这个计划");
      const rows = Object.values(p.sections).flat() as Row[];
      assert.ok(rows.length > 0, "计划里没有预报单行");
      for (const row of rows) assert.equal(row.planNo, "ZZWHR0928", `行 ${row.trackingNo} 没带计划号`);
    });

    // ---------- A 运费低消 ----------
    await check("A 低消：空的 / 不是数字 / 负数 / 4 位小数 → 400；一个对一个错 → 两个都不存；都对 → 存上", async () => {
      await call("POST /admin/shipping/config", ADMIN, { sea_min_volume: "1.5", land_min_volume: "2" });
      const read = async () => Object.fromEntries((await pm.aiStatusLabel.findMany({ where: { status: { in: MIN_KEYS } } })).map((r: Row) => [r.status, r.labelZh]));
      const base = await read();
      assert.deepEqual(base, { min_volume_sea_min_volume: "1.5", min_volume_land_min_volume: "2" });
      for (const bad of ["", "  ", "abc", "-1", "1.2345", null]) {
        const r = await call("POST /admin/shipping/config", ADMIN, { sea_min_volume: bad });
        assert.equal(r.status, 400, `海运低消「${String(bad)}」没被拦，拿到 ${r.status}`);
      }
      const half = await call("POST /admin/shipping/config", ADMIN, { sea_min_volume: "3", land_min_volume: "abc" });
      assert.equal(half.status, 400);
      assert.deepEqual(await read(), base, "有一个不对，另一个也不该存");
      const good = await call("POST /admin/shipping/config", ADMIN, { sea_min_volume: " 0 ", land_min_volume: 2.5 });
      assert.equal(good.status, 200, good.message);
      assert.deepEqual(await read(), { min_volume_sea_min_volume: "0", min_volume_land_min_volume: "2.5" });
    });
  } finally {
    await cleanup();
    // 运费低消原样写回
    await pm.aiStatusLabel.deleteMany({ where: { status: { in: MIN_KEYS } } });
    for (const row of minBefore) await pm.aiStatusLabel.create({ data: row });
    await pm.$disconnect();
  }
  console.log(`\n通过 ${passed} / 失败 ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
