/**
 * 推进账本 + 整柜撤销 + 轨迹删除（真 PostgreSQL，2026-09-17）。
 *
 * 为什么有这份：老板 9-17 定「第 7 种做法」。原来整柜撤销靠柜子时间表的日期和轨迹记录去「猜」上一步和货原来的状态，
 * 7 个对抗子代理 + 本机 8 个版本对照实测：同一天推几步、日期填倒了、员工删过记录、柜里有已签收的货、
 * 开船后才装进来的货，撤销都会退错或把柜子卡死（线上老代码、送审版 94ddf0e、办法 1 都有）。
 * 现在推柜子状态时记一笔账（container_push_batches / container_push_entries），撤销按账把最近一笔倒回去。
 * 原型 v7e 经随机乱点 640 次 0 次柜货对不上（办法 1 同测法 41 次）。
 *
 * 全部走真实接口：新建装柜单、装柜、推状态、撤销（含预览）、卸柜、派送签收、查轨迹、删记录、管理员查删除记录/恢复。
 * 只连测试库：DATABASE_URL 不带 neon.tech 的不跑（IPv4 连测试库时核实后设 AGENT_PORTAL_TEST_ALLOW_DB=1）；
 * 没有 DATABASE_URL（CI）打印「跳过」。测试数据全在假公司 zz_ledger_co 下，开跑前、跑完后都清干净。
 * 用法：npm run test:push-ledger-db
 */
process.env.TZ = "UTC"; // 线上服务器是 UTC；推柜子状态时填的日期按服务器时区解析
import assert from "node:assert/strict";

type Row = Record<string, any>;
type Auth = { userId: string; companyId: string; role: string; name: string };

const CO = "zz_ledger_co";
const P = "zz_ledger_";
const STAFF: Auth = { userId: `${P}staff`, companyId: CO, role: "staff", name: "测试员工" };
const ADMIN: Auth = { userId: `${P}admin`, companyId: CO, role: "admin", name: "测试管理员" };
const MAP: Record<string, string> = {
  LOADING: "loaded", SEALED: "loaded", IN_TRANSIT: "departed", ARRIVED: "arrivedPort", CUSTOMS: "customsTH",
  CUSTOMS_CLEARED: "customsCleared", UNLOADING: "unloading", IN_WAREHOUSE_TH: "inWarehouseTH",
};

let failures = 0;
function expect(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✅ ${label}`);
  } catch (e) {
    failures++;
    console.log(`  ❌ ${label}\n     ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url || url.includes("blocked")) {
    console.log("⚠️ 跳过：没有 DATABASE_URL（CI 没有数据库）—— 这一项等于没测");
    return;
  }
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
  (await import("../apps/api/src/modules/shipments/routes")).registerShipmentRoutes(app);
  (await import("../apps/api/src/modules/containers/routes")).registerContainerRoutes(app);
  (await import("../apps/api/src/modules/loading-manifests/routes")).registerLoadingManifestRoutes(app);
  (await import("../apps/api/src/modules/admin-ops/routes")).registerAdminOpsRoutes(app);

  async function call(key: string, auth: Auth, body: Row = {}, query: Record<string, string> = {}): Promise<{ status: number; data: any; message: string }> {
    const handler = routes.get(key);
    if (!handler) return { status: 404, data: undefined, message: `没有这个接口：${key}` };
    let status = 200;
    let raw: any;
    const res: any = { status(s: number) { status = s; return res; }, json(p: any) { raw = p; }, setHeader() {} };
    try {
      await handler({ body, query, headers: {}, auth }, res);
    } catch (e) {
      if (e instanceof BusinessError) { status = e.httpStatus; raw = { code: e.code, message: e.message }; } else throw e;
    }
    return { status, data: raw?.data, message: raw?.message ?? "" };
  }
  async function must(key: string, auth: Auth, body: Row = {}, query: Record<string, string> = {}): Promise<any> {
    const r = await call(key, auth, body, query);
    assert.equal(r.status, 200, `${key} 失败：${r.status} ${r.message}`);
    return r.data;
  }

  async function cleanup(): Promise<void> {
    const containers = await pm.container.findMany({ where: { companyId: CO }, select: { id: true } });
    const ids = containers.map((c: Row) => c.id);
    await pm.adminLastmileOrder.deleteMany({ where: { companyId: CO } });
    await pm.shipmentContainerItem.deleteMany({ where: { containerId: { in: ids } } });
    if (pm.containerPushEntry) await pm.containerPushEntry.deleteMany({ where: { companyId: CO } });
    if (pm.containerPushBatch) await pm.containerPushBatch.deleteMany({ where: { companyId: CO } });
    await pm.container.deleteMany({ where: { companyId: CO } });
    await pm.statusLog.deleteMany({ where: { companyId: CO } });
    await pm.shipment.deleteMany({ where: { companyId: CO } });
    await pm.order.deleteMany({ where: { companyId: CO } });
    await pm.auditLog.deleteMany({ where: { companyId: CO } });
    await pm.user.deleteMany({ where: { companyId: CO } });
  }

  let seq = 0;
  const uniq = (tag: string) => `ZZLG${tag}${Date.now().toString(36).toUpperCase()}${seq++}`;
  async function seedShipment(pieces = 3): Promise<string> {
    const trackingNo = uniq("T");
    const orderId = `${P}o_${trackingNo}`;
    await pm.order.create({ data: {
      id: orderId, companyId: CO, clientId: `${P}client`, warehouseId: `${P}wh`, itemName: "测试鞋",
      productQuantity: pieces, packageCount: pieces, packageUnit: "箱", transportMode: "sea",
      receiverNameTh: "测试收货人", receiverPhoneTh: "000", receiverAddressTh: "测试地址",
    } });
    const id = `${P}s_${trackingNo}`;
    await pm.shipment.create({ data: {
      id, companyId: CO, orderId, trackingNo, currentStatus: "inWarehouseCN", warehouseId: `${P}wh`,
      packageCount: pieces, volumeM3: 0.2 * pieces, weightKg: 10 * pieces, transportMode: "sea",
    } });
    await pm.statusLog.create({ data: {
      id: `sl_new_${Date.now()}_${seq++}_${P}`, companyId: CO, shipmentId: id, operatorId: STAFF.userId, operatorRole: "staff", operatorName: STAFF.name,
      fromStatus: "created", toStatus: "inWarehouseCN", remark: "货已到国内仓，等待装柜", changedAt: new Date("2026-08-20T02:00:00.000Z"),
    } });
    return trackingNo;
  }
  const newBox = async (): Promise<{ id: string; no: string }> => {
    const no = uniq("BOX");
    const id = (await must("POST /staff/loading-manifests", STAFF, { warehouse: `${P}wh`, transportMode: "sea", containerNo: no })).manifest.id;
    return { id, no };
  };
  async function load(boxId: string, trackingNo: string): Promise<string> {
    const before = await pm.shipment.findMany({ where: { parentTrackingNo: trackingNo, companyId: CO }, select: { trackingNo: true } });
    await must("POST /staff/loading-manifests/add-shipment", STAFF, { trackingNo }, { id: boxId });
    const after = await pm.shipment.findMany({ where: { parentTrackingNo: trackingNo, companyId: CO }, select: { trackingNo: true } });
    return after.map((c: Row) => c.trackingNo).find((t: string) => !before.some((b: Row) => b.trackingNo === t))!;
  }
  const push = (boxId: string, toStatus: string, date?: string) => call("POST /admin/containers/status", ADMIN, { id: boxId, toStatus, ...(date ? { date } : {}) });
  async function pushAll(boxId: string, steps: Array<[string, string]>): Promise<void> {
    for (const [s, d] of steps) {
      const r = await push(boxId, s, d);
      assert.equal(r.status, 200, `推 ${s} 失败：${r.status} ${r.message}`);
    }
  }
  const undo = (boxId: string, expectStatus?: string) => call("POST /admin/containers/status/undo", ADMIN, { id: boxId, ...(expectStatus ? { expectStatus } : {}) });
  const statusOf = async (trackingNo: string) => (await pm.shipment.findFirst({ where: { trackingNo, companyId: CO }, select: { currentStatus: true } }))?.currentStatus ?? null;
  const boxStatus = async (id: string) => (await pm.container.findUnique({ where: { id }, select: { currentStatus: true } }))?.currentStatus ?? null;
  async function timeline(trackingNo: string, role: "staff" | "client" = "staff"): Promise<Row[]> {
    const who = role === "staff" ? STAFF : { userId: `${P}client`, companyId: CO, role: "client", name: "测试客户" };
    const t = await must("GET /client/shipments/track", who, {}, { trackingNo });
    return [...t.timeline].reverse();
  }
  /** 柜子和这几票货对得上（货 = 柜子状态对应的货状态） */
  async function consistent(boxId: string, nos: string[]): Promise<string> {
    const b = (await boxStatus(boxId))!;
    const want = MAP[b];
    const got = await Promise.all(nos.map((n) => statusOf(n)));
    return got.every((g) => g === want) ? "" : `柜子 ${b}（货应为 ${want}），实际 ${got.join(",")}`;
  }

  console.log("推进账本 + 整柜撤销 + 轨迹删除（真库）");
  try {
    await cleanup();
    for (const u of [STAFF, ADMIN]) await pm.user.create({ data: { id: u.userId, companyId: CO, role: u.role, name: u.name, phone: "000", status: "active" } });
    await pm.user.create({ data: { id: `${P}client`, companyId: CO, role: "client", name: "测试客户", phone: "000", status: "active" } });

    console.log("\n【1 删中间「已开船」被挡，连撤到底柜货一直对得上，还能重推（Codex P1）】");
    try {
      const p = await seedShipment(); const box = await newBox(); const c = await load(box.id, p);
      await pushAll(box.id, [["SEALED", "2026-08-25"], ["IN_TRANSIT", "2026-09-01"], ["ARRIVED", "2026-09-13"]]);
      const dep = (await timeline(p)).find((t) => t.trackingNo === c && t.toStatus === "departed");
      const d = await call("POST /staff/shipments/track/delete-log", STAFF, { logId: dep!.id });
      expect("删「已开船」推进记录 → 409，提示去装柜管理撤销；弹窗里不给删并写明原因", () => {
        assert.equal(d.status, 409, d.message);
        assert.match(d.message, /装柜管理/);
        assert.equal(dep!.canDelete, false);
        assert.equal(dep!.deleteBlockedReason, "containerPush");
      });
      const bad: string[] = [];
      for (let i = 1; i <= 3; i++) { const u = await undo(box.id); if (u.status !== 200) bad.push(`撤${i} ${u.status}`); const x = await consistent(box.id, [p, c]); if (x) bad.push(`撤${i}：${x}`); }
      const r = await push(box.id, "SEALED", "2026-08-25");
      expect("连撤三步每步柜货一致，撤到装柜中后能重推封柜", () => { assert.deepEqual(bad, []); assert.equal(r.status, 200, r.message); });
    } catch (e) { failures++; console.log(`  ❌ 这个场景中途出错，后面几步没跑完：${e instanceof Error ? e.message.split("\n")[0] : String(e)}`); }

    console.log("\n【2 好几步填同一天，连撤四步（线上老代码/送审版都会退错、柜子往前走）】");
    try {
      const p = await seedShipment(); const box = await newBox(); const c = await load(box.id, p);
      await pushAll(box.id, [["SEALED", "2026-08-25"], ["IN_TRANSIT", "2026-09-01"], ["ARRIVED", "2026-09-13"], ["CUSTOMS", "2026-09-14"], ["CUSTOMS_CLEARED", "2026-09-16"], ["UNLOADING", "2026-09-16"], ["IN_WAREHOUSE_TH", "2026-09-16"]]);
      const path: string[] = []; const bad: string[] = [];
      for (let i = 1; i <= 4; i++) { await undo(box.id); path.push((await boxStatus(box.id))!); const x = await consistent(box.id, [p, c]); if (x) bad.push(`撤${i}：${x}`); }
      expect("柜子按推的顺序一步步退（卸柜中→放行→清关中→到港），货每步跟上", () => {
        assert.deepEqual(path, ["UNLOADING", "CUSTOMS_CLEARED", "CUSTOMS", "ARRIVED"]);
        assert.deepEqual(bad, []);
      });
    } catch (e) { failures++; console.log(`  ❌ 这个场景中途出错，后面几步没跑完：${e instanceof Error ? e.message.split("\n")[0] : String(e)}`); }

    console.log("\n【3 到港日期填得比开船还早，连撤后还能重推（送审版会卡死）；撤回后柜子的日期跟没推过一样，再装进来的货不会补出撤掉的步骤】");
    try {
      const p = await seedShipment(); const box = await newBox(); const c = await load(box.id, p);
      const dates = async () => JSON.stringify(await pm.container.findUnique({ where: { id: box.id }, select: { statusDates: true, departureDate: true, ata: true } }));
      await pushAll(box.id, [["SEALED", "2026-08-25"]]);
      const sealedDates = await dates();
      await pushAll(box.id, [["IN_TRANSIT", "2026-09-01"], ["ARRIVED", "2026-08-30"]]);
      const bad: string[] = [];
      for (let i = 1; i <= 2; i++) { await undo(box.id); const x = await consistent(box.id, [p, c]); if (x) bad.push(`撤${i}：${x}`); }
      const undoneDates = await dates();
      const p2 = await seedShipment(); const c2 = await load(box.id, p2); const s2 = await statusOf(c2);
      const r = await push(box.id, "IN_TRANSIT", "2026-09-01");
      expect("撤到已封柜柜货一致，重推运输中成功", () => { assert.deepEqual(bad, []); assert.equal(r.status, 200, r.message); });
      expect("撤回已封柜后，柜子时间表、开船/到港日期跟刚封柜时一模一样；这时装进来的货是已装柜", () => {
        assert.equal(undoneDates, sealedDates);
        assert.equal(s2, "loaded");
      });
    } catch (e) { failures++; console.log(`  ❌ 这个场景中途出错，后面几步没跑完：${e instanceof Error ? e.message.split("\n")[0] : String(e)}`); }

    console.log("\n【4 柜里一票已签收：撤两步不动它，另一票跟着退，再往前推不被它挡住】");
    try {
      const p1 = await seedShipment(); const p2 = await seedShipment(); const box = await newBox();
      const c1 = await load(box.id, p1); const c2 = await load(box.id, p2);
      await pushAll(box.id, [["SEALED", "2026-08-25"], ["IN_TRANSIT", "2026-09-01"], ["ARRIVED", "2026-09-13"], ["CUSTOMS", "2026-09-14"], ["CUSTOMS_CLEARED", "2026-09-15"], ["UNLOADING", "2026-09-16"], ["IN_WAREHOUSE_TH", "2026-09-17"]]);
      const s1 = await pm.shipment.findFirst({ where: { trackingNo: c1, companyId: CO }, select: { id: true } });
      await must("POST /admin/lastmile/orders", ADMIN, { shipmentIds: [s1.id] });
      const lm = await pm.adminLastmileOrder.findFirst({ where: { shipmentId: s1.id }, select: { id: true } });
      await must("POST /admin/lastmile/status", ADMIN, { id: lm.id, status: "SIGNED" });
      const signedLogsBefore = await pm.statusLog.count({ where: { shipmentId: s1.id } });
      const u1 = await undo(box.id); const u2 = await undo(box.id);
      const after = { box: await boxStatus(box.id), c1: await statusOf(c1), c2: await statusOf(c2), signedLogs: await pm.statusLog.count({ where: { shipmentId: s1.id } }) };
      const r = await push(box.id, "UNLOADING", "2026-09-16");
      expect("撤两步：柜子到清关放行、没签收的那票跟着退、已签收那票不动且轨迹一条没删；撤销结果列出它", () => {
        assert.equal(u1.status, 200, u1.message); assert.equal(u2.status, 200, u2.message);
        assert.equal(after.box, "CUSTOMS_CLEARED"); assert.equal(after.c2, "customsCleared"); assert.equal(after.c1, "delivered");
        assert.equal(after.signedLogs, signedLogsBefore);
        assert.ok((u1.data.skippedShipments ?? []).some((s: Row) => s.trackingNo === c1), JSON.stringify(u1.data.skippedShipments));
      });
      expect("再往前推正在卸柜成功，已签收的货被跳过并在结果里列出", () => {
        assert.equal(r.status, 200, r.message);
        assert.ok((r.data.skippedShipments ?? []).some((s: Row) => s.trackingNo === c1), JSON.stringify(r.data.skippedShipments));
      });
    } catch (e) { failures++; console.log(`  ❌ 这个场景中途出错，后面几步没跑完：${e instanceof Error ? e.message.split("\n")[0] : String(e)}`); }

    console.log("\n【5 开船后才装进来的货：撤到底跟着退，补记删掉、「装入柜子」留着，能重推】");
    try {
      const p1 = await seedShipment(); const p2 = await seedShipment(); const box = await newBox();
      const c1 = await load(box.id, p1);
      await pushAll(box.id, [["SEALED", "2026-08-25"], ["IN_TRANSIT", "2026-09-01"]]);
      const c2 = await load(box.id, p2);
      // 刚装进来时：一条「装入柜子」（已装柜）+ 已封柜、运输中两条随柜补记，不能出现两条「装入柜子」
      const justLoaded = await pm.statusLog.findMany({ where: { shipment: { trackingNo: c2 } }, orderBy: { changedAt: "asc" }, select: { toStatus: true, remark: true } });
      expect("开船后装进来：一条「装入柜子」（已装柜）+ 两条随柜补记", () => {
        assert.deepEqual(justLoaded.map((l: Row) => [l.toStatus, /^装入柜子 /.test(String(l.remark)), /随柜 .* 补记/.test(String(l.remark))]),
          [["loaded", true, false], ["loaded", false, true], ["departed", false, true]], JSON.stringify(justLoaded));
      });
      await pushAll(box.id, [["ARRIVED", "2026-09-13"]]);
      const bad: string[] = [];
      for (let i = 1; i <= 3; i++) { await undo(box.id); const x = await consistent(box.id, [c1, c2]); if (x) bad.push(`撤${i}：${x}`); }
      const lateLogs = await pm.statusLog.findMany({ where: { shipment: { trackingNo: c2 } }, select: { toStatus: true, remark: true } });
      const r = await push(box.id, "SEALED", "2026-08-25");
      expect("每步柜货一致；后装那票只剩「装入柜子」一条；重推封柜成功", () => {
        assert.deepEqual(bad, []);
        assert.equal(lateLogs.length, 1, JSON.stringify(lateLogs));
        assert.match(String(lateLogs[0].remark), /^装入柜子 /);
        assert.equal(r.status, 200, r.message);
      });
    } catch (e) { failures++; console.log(`  ❌ 这个场景中途出错，后面几步没跑完：${e instanceof Error ? e.message.split("\n")[0] : String(e)}`); }

    console.log("\n【6 9-15 形状：删「装入柜子」能删、客户顶上正常；连撤到装柜中自动放回它，每步客户轨迹都有当前状态】");
    try {
      const p = await seedShipment(); const box = await newBox(); const c = await load(box.id, p);
      await pushAll(box.id, [["SEALED", "2026-08-25"], ["IN_TRANSIT", "2026-09-01"], ["ARRIVED", "2026-09-13"], ["CUSTOMS", "2026-09-14"]]);
      const loadLog = (await timeline(p)).find((t) => t.trackingNo === c && String(t.remark).startsWith("装入柜子"));
      const d = await call("POST /staff/shipments/track/delete-log", STAFF, { logId: loadLog!.id });
      const top = (await timeline(p, "client"))[0];
      expect("删「装入柜子」200；客户最上面变成「清关中」", () => { assert.equal(d.status, 200, d.message); assert.equal(top.toStatus, "customsTH"); });
      const missing: string[] = [];
      for (let i = 1; i <= 4; i++) {
        const u = await undo(box.id);
        const st = await statusOf(c);
        const tl = await timeline(p, "client");
        if (u.status !== 200 || !tl.some((t) => t.toStatus === st)) missing.push(`撤${i}(${u.status}) 状态 ${st} 在客户轨迹里找不到`);
      }
      const restored = await pm.statusLog.findUnique({ where: { id: loadLog!.id } });
      expect("每步客户轨迹都有当前状态；撤到装柜中时原来那条「装入柜子」被原样放回", () => {
        assert.deepEqual(missing, []);
        assert.ok(restored, "没放回");
      });
    } catch (e) { failures++; console.log(`  ❌ 这个场景中途出错，后面几步没跑完：${e instanceof Error ? e.message.split("\n")[0] : String(e)}`); }

    console.log("\n【7 自动放回只认装柜时写的「装入柜子 本柜号」整号：写错柜号的、柜号撞开头的、推进记录「已封柜」、推柜子时备注里手填「装入柜子 本柜号」的都不放回】");
    try {
      const p = await seedShipment(); const box = await newBox(); const c = await load(box.id, p);
      await pushAll(box.id, [["SEALED", "2026-08-25"]]);
      const cs = await pm.shipment.findFirst({ where: { trackingNo: c, companyId: CO }, select: { id: true } });
      const wrongId = `sl_mnf_${Date.now()}_wrong_${P}`;
      await pm.statusLog.create({ data: { id: wrongId, companyId: CO, shipmentId: cs.id, operatorId: STAFF.userId, operatorRole: "staff", operatorName: STAFF.name, fromStatus: "loaded", toStatus: "loaded", remark: "装入柜子 WRONG123", changedAt: new Date("2026-09-30T00:00:00Z") } });
      await pushAll(box.id, [["IN_TRANSIT", "2026-09-01"]]);
      // 柜号撞开头：另一个柜号是本柜号后面多一位（线上真有一对柜号一个是另一个的开头）
      const prefixId = `sl_mnf_${Date.now()}_prefix_${P}`;
      await pm.statusLog.create({ data: { id: prefixId, companyId: CO, shipmentId: cs.id, operatorId: STAFF.userId, operatorRole: "staff", operatorName: STAFF.name, fromStatus: "loaded", toStatus: "loaded", remark: `装入柜子 ${box.no}9`, changedAt: new Date("2026-09-29T00:00:00Z") } });
      // 推柜子时员工在备注里手填了「装入柜子 本柜号」：备注一模一样，但不是装柜写的那条（id 不是 sl_mnf_），不能当它放回
      const fakeId = `sl_ctn_${Date.now()}_fake_${P}`;
      await pm.statusLog.create({ data: { id: fakeId, companyId: CO, shipmentId: cs.id, operatorId: STAFF.userId, operatorRole: "staff", operatorName: STAFF.name, fromStatus: "loaded", toStatus: "loaded", remark: `装入柜子 ${box.no}`, changedAt: new Date("2026-08-26T00:00:00Z") } });
      const logs = await timeline(p);
      const right = logs.find((t) => t.trackingNo === c && t.remark === `装入柜子 ${box.no}` && t.id !== fakeId);
      const sealed = logs.find((t) => t.trackingNo === c && t.toStatus === "loaded" && !String(t.remark).startsWith("装入柜子"));
      // 手填备注那条、撞开头那条最后删（放回时按最近删的优先：不认 id 会先挑中手填那条，只比开头会先挑中撞开头那条）
      for (const id of [right!.id, sealed!.id, wrongId, fakeId, prefixId]) {
        const r = await call("POST /staff/shipments/track/delete-log", STAFF, { logId: id });
        assert.equal(r.status, 200, `删 ${id} 失败 ${r.message}`);
      }
      await undo(box.id); await undo(box.id);
      const left = await pm.statusLog.findMany({ where: { shipmentId: cs.id }, select: { id: true } });
      expect("撤到装柜中只放回对的「装入柜子」这一条", () => {
        assert.deepEqual(left.map((l: Row) => l.id), [right!.id]);
      });
    } catch (e) { failures++; console.log(`  ❌ 这个场景中途出错，后面几步没跑完：${e instanceof Error ? e.message.split("\n")[0] : String(e)}`); }

    console.log("\n【8 删除存底：管理员按父单号查到子单删掉的记录；已撤销那一步不许恢复；员工不能恢复】");
    try {
      const p = await seedShipment(); const box = await newBox(); const c = await load(box.id, p);
      await pushAll(box.id, [["SEALED", "2026-08-25"], ["IN_TRANSIT", "2026-09-01"]]);
      const loadLog = (await timeline(p)).find((t) => t.trackingNo === c && String(t.remark).startsWith("装入柜子"));
      await must("POST /staff/shipments/track/delete-log", STAFF, { logId: loadLog!.id });
      const list = await call("GET /admin/shipments/track/deleted-logs", ADMIN, {}, { trackingNo: p });
      const item = (list.data?.items ?? []).find((i: Row) => i.log?.id === loadLog!.id);
      const staffTry = await call("POST /admin/shipments/track/restore-log", STAFF, { auditId: item?.auditId ?? "x" });
      expect("按父单号查到子单那条，写着谁删的；员工调恢复 403", () => {
        assert.equal(list.status, 200, list.message);
        assert.ok(item, JSON.stringify(list.data));
        assert.equal(item.deletedBy, STAFF.userId);
        assert.equal(staffTry.status, 403);
      });
      const ok1 = await call("POST /admin/shipments/track/restore-log", ADMIN, { auditId: item.auditId });
      const st = await statusOf(c);
      const again = await call("POST /admin/shipments/track/restore-log", ADMIN, { auditId: item.auditId });
      expect("管理员恢复 200、状态不变、重复恢复 409", () => { assert.equal(ok1.status, 200, ok1.message); assert.equal(st, "departed"); assert.equal(again.status, 409); });

      // 删「已开船」挡住了，换一条能删的记录来测「已撤销那一步不许恢复」：先推到港，删自环的重复记录没有，就造一条
      const cs = await pm.shipment.findFirst({ where: { trackingNo: c, companyId: CO }, select: { id: true } });
      const extraId = `sl_mnf_${Date.now()}_extra_${P}`;
      await pm.statusLog.create({ data: { id: extraId, companyId: CO, shipmentId: cs.id, operatorId: STAFF.userId, operatorRole: "staff", operatorName: STAFF.name, fromStatus: "departed", toStatus: "departed", remark: "重复的开船备注", changedAt: new Date("2026-09-02T00:00:00Z") } });
      await must("POST /staff/shipments/track/delete-log", STAFF, { logId: extraId });
      await undo(box.id);
      const list2 = await call("GET /admin/shipments/track/deleted-logs", ADMIN, {}, { trackingNo: c });
      const extra = (list2.data?.items ?? []).find((i: Row) => i.log?.id === extraId);
      const blocked = await call("POST /admin/shipments/track/restore-log", ADMIN, { auditId: extra?.auditId ?? "x" });
      expect("柜子已撤回封柜后，恢复「已开船」那条 409（这一步已经撤销了）", () => { assert.equal(blocked.status, 409, blocked.message); });
    } catch (e) { failures++; console.log(`  ❌ 这个场景中途出错，后面几步没跑完：${e instanceof Error ? e.message.split("\n")[0] : String(e)}`); }

    console.log("\n【9 撤销核对页面上看到的状态；撤销预览告诉员工会退到哪、谁不跟着退】");
    try {
      const p1 = await seedShipment(); const p2 = await seedShipment(); const box = await newBox();
      const c1 = await load(box.id, p1); const c2 = await load(box.id, p2);
      await pushAll(box.id, [["SEALED", "2026-08-25"], ["IN_TRANSIT", "2026-09-01"]]);
      await pm.shipment.update({ where: { trackingNo: c2 }, data: { currentStatus: "returned" } });
      const preview = await call("GET /admin/containers/status/undo-preview", ADMIN, {}, { id: box.id });
      const wrong = await undo(box.id, "ARRIVED");
      const ok = await undo(box.id, "IN_TRANSIT");
      expect("预览：退回已封柜、1 票跟着退、退回的那票列出来不动", () => {
        assert.equal(preview.status, 200, preview.message);
        assert.equal(preview.data.prevStatus, "SEALED");
        assert.equal(preview.data.revertCount, 1);
        assert.ok((preview.data.keep ?? []).some((k: Row) => k.trackingNo === c2), JSON.stringify(preview.data));
      });
      expect("expectStatus 不对 409、对 200", () => { assert.equal(wrong.status, 409); assert.equal(ok.status, 200, ok.message); });
      void c1;

      // 柜子状态被系统以外改过（直接改库），跟账本最后一笔对不上：预览和撤销都拒绝，什么都不动
      const p3 = await seedShipment(); const box3 = await newBox(); const c3 = await load(box3.id, p3);
      await pushAll(box3.id, [["SEALED", "2026-08-25"]]);
      // 撤封柜货的状态不变（已装柜→已装柜），预览不能说「1 票跟着退」
      const pvSealed = await call("GET /admin/containers/status/undo-preview", ADMIN, {}, { id: box3.id });
      expect("预览撤封柜：0 票跟着退（状态本来就没变）", () => { assert.equal(pvSealed.status, 200, pvSealed.message); assert.equal(pvSealed.data.revertCount, 0); });
      await pushAll(box3.id, [["IN_TRANSIT", "2026-09-01"]]);
      await pm.container.update({ where: { id: box3.id }, data: { currentStatus: "ARRIVED" } });
      const pv3 = await call("GET /admin/containers/status/undo-preview", ADMIN, {}, { id: box3.id });
      const u3 = await undo(box3.id);
      const after3 = { box: await boxStatus(box3.id), c3: await statusOf(c3), batches: await pm.containerPushBatch.count({ where: { containerId: box3.id } }) };
      expect("柜子状态跟账本对不上：预览、撤销都 409，柜子、货、账本都没动", () => {
        assert.equal(pv3.status, 409, pv3.message);
        assert.equal(u3.status, 409, u3.message);
        assert.deepEqual(after3, { box: "ARRIVED", c3: "departed", batches: 2 });
      });
    } catch (e) { failures++; console.log(`  ❌ 这个场景中途出错，后面几步没跑完：${e instanceof Error ? e.message.split("\n")[0] : String(e)}`); }

    console.log("\n【10 推柜子状态：柜里有退回的货跳过它，不挡整柜（已签收的货跳过见场景 4）】");
    try {
      const p1 = await seedShipment(); const p2 = await seedShipment(); const box = await newBox();
      const c1 = await load(box.id, p1); const c2 = await load(box.id, p2);
      await pushAll(box.id, [["SEALED", "2026-08-25"]]);
      await pm.shipment.update({ where: { trackingNo: c2 }, data: { currentStatus: "returned" } });
      const r = await push(box.id, "IN_TRANSIT", "2026-09-01");
      expect("退回的货跳过", () => {
        assert.equal(r.status, 200, r.message);
        assert.ok((r.data.skippedShipments ?? []).some((s: Row) => s.trackingNo === c2), JSON.stringify(r.data));
      });
      const s1 = await statusOf(c1); const s2 = await statusOf(c2);
      expect("没退回的那票到已开船，退回那票还是退回", () => { assert.equal(s1, "departed"); assert.equal(s2, "returned"); });
    } catch (e) { failures++; console.log(`  ❌ 这个场景中途出错，后面几步没跑完：${e instanceof Error ? e.message.split("\n")[0] : String(e)}`); }

    console.log("\n【11 上线前推过的老柜子（没有账本）：同一天 / 日期倒序撤销按流程顺序找上一步】");
    try {
      const p = await seedShipment(); const box = await newBox(); const c = await load(box.id, p);
      await pushAll(box.id, [["SEALED", "2026-08-25"], ["IN_TRANSIT", "2026-09-01"], ["ARRIVED", "2026-08-30"]]);
      if (pm.containerPushBatch) await pm.containerPushBatch.deleteMany({ where: { containerId: box.id } });
      const path: string[] = []; const bad: string[] = [];
      for (let i = 1; i <= 2; i++) { await undo(box.id); path.push((await boxStatus(box.id))!); const x = await consistent(box.id, [p, c]); if (x) bad.push(`撤${i}：${x}`); }
      expect("没有账本也按流程顺序退：到港→运输中→已封柜，柜货一致", () => {
        assert.deepEqual(path, ["IN_TRANSIT", "SEALED"]);
        assert.deepEqual(bad, []);
      });

      // 上线前推到运输中（没账本）、上线后推到港（有账本）、再后装一票：撤到港，后装那票退回「已开船」，不是「已装柜」
      const q1 = await seedShipment(); const q2 = await seedShipment(); const box2 = await newBox(); const d1 = await load(box2.id, q1);
      await pushAll(box2.id, [["SEALED", "2026-08-25"], ["IN_TRANSIT", "2026-09-01"]]);
      if (pm.containerPushBatch) await pm.containerPushBatch.deleteMany({ where: { containerId: box2.id } });
      await pushAll(box2.id, [["ARRIVED", "2026-09-13"]]);
      const d2 = await load(box2.id, q2);
      const u = await undo(box2.id);
      const mixed = { box: await boxStatus(box2.id), d1: await statusOf(d1), d2: await statusOf(d2) };
      expect("上线前后各推几步的柜子里后装的货：撤到港后跟柜子一起回到「已开船」", () => {
        assert.equal(u.status, 200, u.message);
        assert.deepEqual(mixed, { box: "IN_TRANSIT", d1: "departed", d2: "departed" });
      });
    } catch (e) { failures++; console.log(`  ❌ 这个场景中途出错，后面几步没跑完：${e instanceof Error ? e.message.split("\n")[0] : String(e)}`); }

    console.log("\n【12 员工删过的重复「已封柜」：那一步被整柜撤销后，管理员不能再恢复它（有账本 / 老柜子都挡）】");
    try {
      for (const legacy of [false, true]) {
        const p = await seedShipment(); const box = await newBox(); const c = await load(box.id, p);
        await pushAll(box.id, [["SEALED", "2026-08-25"]]);
        if (legacy && pm.containerPushBatch) await pm.containerPushBatch.deleteMany({ where: { containerId: box.id } });
        const sealed = (await timeline(p)).find((t) => t.trackingNo === c && String(t.id).startsWith("sl_ctn_") && t.toStatus === "loaded");
        const d = await call("POST /staff/shipments/track/delete-log", STAFF, { logId: sealed!.id });
        const u = await undo(box.id);
        const list = await call("GET /admin/shipments/track/deleted-logs", ADMIN, {}, { trackingNo: c });
        const item = (list.data?.items ?? []).find((i: Row) => i.log?.id === sealed!.id);
        const r = await call("POST /admin/shipments/track/restore-log", ADMIN, { auditId: item?.auditId ?? "x" });
        const back = await pm.statusLog.count({ where: { id: sealed!.id } });
        expect(`${legacy ? "老柜子" : "有账本"}：删重复「已封柜」200，撤回装柜中后恢复它 409，轨迹里没有它`, () => {
          assert.equal(d.status, 200, d.message);
          assert.equal(u.status, 200, u.message);
          assert.ok(item, JSON.stringify(list.data));
          assert.equal(r.status, 409, r.message);
          assert.match(r.message, /撤销/);
          assert.equal(back, 0);
        });
      }
    } catch (e) { failures++; console.log(`  ❌ 这个场景中途出错，后面几步没跑完：${e instanceof Error ? e.message.split("\n")[0] : String(e)}`); }

    console.log("\n【13 后装货只在柜子有推进账本时多写补记：「封柜」按钮封柜再推开船、后装、连撤到底，后装那票只剩「装入柜子」；没账本的老柜子后装货照原来只写两条】");
    try {
      const p1 = await seedShipment(); const box = await newBox(); const c1 = await load(box.id, p1);
      await must("POST /staff/loading-manifests/seal", STAFF, {}, { id: box.id });
      await pushAll(box.id, [["IN_TRANSIT", "2026-09-01"]]);
      const p2 = await seedShipment(); const c2 = await load(box.id, p2);
      const u1 = await undo(box.id); const u2 = await undo(box.id);
      const left = (await timeline(p2)).filter((t) => t.trackingNo === c2);
      const b = await boxStatus(box.id); const s1 = await statusOf(c1); const s2 = await statusOf(c2);
      expect("封柜按钮封柜、再推开船、再后装一票：连撤两步回装柜中；后装那票只剩「装入柜子」一条，两票都是已装柜", () => {
        assert.equal(u1.status, 200, u1.message); assert.equal(u2.status, 200, u2.message);
        assert.equal(b, "LOADING");
        assert.deepEqual(left.filter((t) => String(t.id).startsWith("sl_mnf_")).map((t) => [t.toStatus, String(t.remark).startsWith("装入柜子")]), [["loaded", true]]);
        assert.equal(s1, "loaded"); assert.equal(s2, "loaded");
      });

      const p3 = await seedShipment(); const p4 = await seedShipment(); const box2 = await newBox(); await load(box2.id, p3);
      await pushAll(box2.id, [["SEALED", "2026-08-25"], ["IN_TRANSIT", "2026-09-01"]]);
      if (pm.containerPushBatch) await pm.containerPushBatch.deleteMany({ where: { containerId: box2.id } });
      const c4 = await load(box2.id, p4);
      const mnf = (await timeline(p4)).filter((t) => t.trackingNo === c4 && String(t.id).startsWith("sl_mnf_"));
      expect("没账本的老柜子后装货：一条「已封柜」补记 + 一条「装入柜子」（已开船），跟上线前一样", () => {
        assert.equal(mnf.length, 2, JSON.stringify(mnf.map((t) => [t.toStatus, t.remark])));
        const load4 = mnf.filter((t) => String(t.remark).startsWith("装入柜子"));
        assert.equal(load4.length, 1);
        assert.equal(load4[0].toStatus, "departed");
      });
    } catch (e) { failures++; console.log(`  ❌ 这个场景中途出错，后面几步没跑完：${e instanceof Error ? e.message.split("\n")[0] : String(e)}`); }

    console.log("\n【14 改运输方式：柜子走过另一种运输方式才有的步骤就不许改（Codex 第三批 P1-1）；撤回去只剩两边都有的步骤后能改，改完推、后装、撤都对得上】");
    try {
      const p = await seedShipment(); const box = await newBox(); const c = await load(box.id, p);
      await pushAll(box.id, [["SEALED", "2026-08-25"], ["IN_TRANSIT", "2026-09-01"], ["ARRIVED", "2026-09-13"], ["CUSTOMS", "2026-09-14"]]);
      const sw = await call("POST /staff/loading-manifests/transport-mode", STAFF, { id: box.id, transportMode: "land" });
      const mode1 = (await pm.container.findUnique({ where: { id: box.id }, select: { transportMode: true } }))?.transportMode;
      expect("走过「运输中」「已到港」、停在清关中的海运柜：改陆运被拒，还是海运", () => {
        assert.notEqual(sw.status, 200, sw.message);
        assert.match(sw.message, /运输中|已到港/);
        assert.equal(mode1, "sea");
      });
      // 时间表坏了 / 没了，推进账本里也记着走过的步骤，照样挡住
      const pB = await seedShipment(); const boxB = await newBox(); await load(boxB.id, pB);
      await pushAll(boxB.id, [["SEALED", "2026-08-25"], ["IN_TRANSIT", "2026-09-01"], ["ARRIVED", "2026-09-13"], ["CUSTOMS", "2026-09-14"]]);
      await pm.container.update({ where: { id: boxB.id }, data: { statusDates: null } });
      const swB = await call("POST /staff/loading-manifests/transport-mode", STAFF, { id: boxB.id, transportMode: "land" });
      expect("时间表清空的同样柜子：按推进账本照样拒绝改陆运", () => { assert.notEqual(swB.status, 200, swB.message); assert.match(swB.message, /运输中|已到港/); });

      // 上线前推的老柜子（Codex 第三批第 2 轮 P1）：没有时间表、没有账本、未标注运输方式。
      // 开船 / 到港日期是柜子自己身上的证据，只剩其中一样也挡住改陆运；只走过两边都有的步骤的老柜子能改
      const legacyBox = async (steps: Array<[string, string]>): Promise<{ id: string; nos: string[]; ships: string[] }> => {
        const pp = await seedShipment(); const bx = await newBox(); const cc = await load(bx.id, pp);
        await pushAll(bx.id, steps);
        await pm.containerPushBatch.deleteMany({ where: { containerId: bx.id } });
        await pm.container.update({ where: { id: bx.id }, data: { statusDates: null, transportMode: null } });
        const ids = (await pm.shipment.findMany({ where: { trackingNo: { in: [pp, cc] }, companyId: CO }, select: { id: true } })).map((x: Row) => x.id);
        return { id: bx.id, nos: [pp, cc], ships: ids };
      };
      const seaSteps: Array<[string, string]> = [["SEALED", "2026-08-25"], ["IN_TRANSIT", "2026-09-01"], ["ARRIVED", "2026-09-13"], ["CUSTOMS", "2026-09-14"]];
      const onlyDeparture = await legacyBox(seaSteps);
      await pm.container.update({ where: { id: onlyDeparture.id }, data: { ata: null } });
      await pm.statusLog.deleteMany({ where: { shipmentId: { in: onlyDeparture.ships }, id: { startsWith: "sl_ctn_" } } });
      const onlyAta = await legacyBox(seaSteps);
      await pm.container.update({ where: { id: onlyAta.id }, data: { departureDate: null } });
      await pm.statusLog.deleteMany({ where: { shipmentId: { in: onlyAta.ships }, id: { startsWith: "sl_ctn_" } } });
      const sharedOnly = await legacyBox([["SEALED", "2026-08-25"], ["CUSTOMS", "2026-09-14"]]);
      const toLand = (id: string) => call("POST /staff/loading-manifests/transport-mode", STAFF, { id, transportMode: "land" });
      const toSea = (id: string) => call("POST /staff/loading-manifests/transport-mode", STAFF, { id, transportMode: "sea" });
      const rDep = await toLand(onlyDeparture.id); const rAta = await toLand(onlyAta.id); const rShared = await toLand(sharedOnly.id);
      expect("老柜子只剩开船日期 / 只剩到港日期：改陆运都被拒；只走过两边都有的步骤：改陆运 200", () => {
        assert.notEqual(rDep.status, 200, `只剩开船日期：${rDep.message}`); assert.match(rDep.message, /运输中/);
        assert.notEqual(rAta.status, 200, `只剩到港日期：${rAta.message}`); assert.match(rAta.message, /已到港/);
        assert.equal(rShared.status, 200, rShared.message);
      });
      // 线上真有：陆运老柜子带着早年按海运推时写的开船日期。原样保存「陆运」不算改，不能被拦
      await pm.container.update({ where: { id: onlyDeparture.id }, data: { transportMode: "land" } });
      const rSame = await toLand(onlyDeparture.id);
      expect("陆运老柜子带开船日期：原样保存陆运 200（没改就不查）", () => { assert.equal(rSame.status, 200, rSame.message); });

      // 撤销以后开船日期没清掉的老柜子（Opus 第 6 轮复核报的）：柜子已经退回「已封柜」，还没开船，
      // 这时候改陆运不该被那个残留的开船日期拦住。柜子真的走到「运输中」之后（上面 onlyDeparture 那个停在清关中的）照样拦
      const staleDate = (await must("POST /staff/loading-manifests", STAFF, { warehouse: `${P}wh`, transportMode: "sea", containerNo: uniq("BOX") })).manifest.id;
      await pm.container.update({ where: { id: staleDate }, data: { currentStatus: "SEALED", statusDates: null, departureDate: new Date("2026-09-01T00:00:00Z") } });
      const rStale = await toLand(staleDate);
      const staleMode = (await pm.container.findUnique({ where: { id: staleDate }, select: { transportMode: true } }))?.transportMode;
      expect("撤回「已封柜」后开船日期还留着的老柜子：改陆运 200（柜子还没走到运输中）", () => {
        assert.equal(rStale.status, 200, rStale.message);
        assert.equal(staleMode, "land");
      });

      // 没标运输方式的柜子本来就按海运走，标成海运什么都不会变，柜里有陆运状态的货也不该拦（Opus 第 6 轮复核报的）；标陆运照样按规矩查
      const unlabeled = async (shipStatus: string): Promise<{ id: string; child: string }> => {
        const pp = await seedShipment();
        const bid = (await must("POST /staff/loading-manifests", STAFF, { warehouse: `${P}wh`, transportMode: "sea", containerNo: uniq("BOX") })).manifest.id;
        const cc = await load(bid, pp);
        await pushAll(bid, [["SEALED", "2026-08-25"]]);
        await pm.shipment.update({ where: { trackingNo: cc }, data: { currentStatus: shipStatus } });
        await pm.container.update({ where: { id: bid }, data: { transportMode: null } });
        return { id: bid, child: cc };
      };
      const unlabeledLandShip = await unlabeled("atPortCn");
      const rLabelSea = await toSea(unlabeledLandShip.id);
      const labeledMode = (await pm.container.findUnique({ where: { id: unlabeledLandShip.id }, select: { transportMode: true } }))?.transportMode;
      const unlabeledSeaShip = await unlabeled("departed");
      const rLabelLand = await toLand(unlabeledSeaShip.id);
      expect("没标运输方式的柜子：柜里有「到达凭祥口岸」的货也能标成海运；柜里有「已开船」的货标陆运照样被拒", () => {
        assert.equal(rLabelSea.status, 200, rLabelSea.message);
        assert.equal(labeledMode, "sea");
        assert.notEqual(rLabelLand.status, 200, rLabelLand.message);
        assert.match(rLabelLand.message, /已开船/);
      });

      // 老柜子只剩货的推进记录（sl_ctn_ 上没记是哪个柜推的，按时间猜归属两头都错 —— Codex 第三批第 3、4 轮）：
      // 改运输方式放行；撤销那一刻核对，货要退回「已到港」（海运才有）而柜子现在是陆运 → 预览、撤销都不撤，什么都不动；改回海运再撤就正常
      const onlyLogs = await legacyBox(seaSteps);
      await pm.container.update({ where: { id: onlyLogs.id }, data: { departureDate: null, ata: null } });
      const logCount = () => pm.statusLog.count({ where: { shipmentId: { in: onlyLogs.ships }, id: { startsWith: "sl_ctn_" } } });
      const logsBefore = await logCount();
      const rLogs = await toLand(onlyLogs.id);
      const pvLogs = await call("GET /admin/containers/status/undo-preview", ADMIN, {}, { id: onlyLogs.id });
      const uLogs = await undo(onlyLogs.id);
      const blockedState = { box: await boxStatus(onlyLogs.id), ships: await Promise.all(onlyLogs.nos.map((n) => statusOf(n))), logs: await logCount() };
      const rBack = await toSea(onlyLogs.id);
      const uLogs2 = await undo(onlyLogs.id);
      const backBad = await consistent(onlyLogs.id, onlyLogs.nos);
      expect("只剩货的推进记录：改陆运 200；预览、撤销都 409 提示改回海运，柜子、货、推进记录都没动；改回海运再撤：柜子到港、货到港", () => {
        assert.equal(rLogs.status, 200, rLogs.message);
        assert.equal(pvLogs.status, 409, pvLogs.message); assert.match(pvLogs.message, /改回海运/);
        assert.equal(uLogs.status, 409, uLogs.message); assert.match(uLogs.message, /改回海运/);
        assert.deepEqual(blockedState, { box: "CUSTOMS", ships: ["customsTH", "customsTH"], logs: logsBefore });
        assert.equal(rBack.status, 200, rBack.message);
        assert.equal(uLogs2.status, 200, uLogs2.message);
        assert.equal(backBad, "");
      });

      // 有账本的柜子也核：柜子只走过两边都有的步骤（能改陆运），但柜里一票货是单独到了「已到港」时跟着推的，撤销要把它退回「已到港」
      const pL = await seedShipment(); const boxL = await newBox(); const cL = await load(boxL.id, pL);
      await pushAll(boxL.id, [["SEALED", "2026-08-25"]]);
      await pm.shipment.update({ where: { trackingNo: cL }, data: { currentStatus: "arrivedPort" } });
      await pushAll(boxL.id, [["CUSTOMS", "2026-09-14"]]);
      const rL = await toLand(boxL.id);
      const pvL = await call("GET /admin/containers/status/undo-preview", ADMIN, {}, { id: boxL.id });
      const uL = await undo(boxL.id);
      const stateL = { box: await boxStatus(boxL.id), c: await statusOf(cL), batches: await pm.containerPushBatch.count({ where: { containerId: boxL.id } }) };
      expect("有账本、货要退回海运才有的「已到港」而柜子已改陆运：预览、撤销 409，柜子、货、账本都没动", () => {
        assert.equal(rL.status, 200, rL.message);
        assert.equal(pvL.status, 409, pvL.message);
        assert.equal(uL.status, 409, uL.message); assert.match(uL.message, /改回海运/);
        assert.deepEqual(stateL, { box: "CUSTOMS", c: "customsTH", batches: 2 });
      });

      // 先撤销、后改运输方式（Codex 第三批第 5 轮）：撤销把一票货退回「已到港」（海运才有），柜子回到已封柜；
      // 这时改陆运，柜子和货就在两条流程里了 → 看柜里货现在的状态，不许改。陆运柜里货在「到达凭祥口岸」改海运同理
      const hazard = async (mode: "sea" | "land", aheadStatus: string): Promise<{ id: string; child: string }> => {
        const pp = await seedShipment();
        const s0 = await pm.shipment.findFirst({ where: { trackingNo: pp, companyId: CO }, select: { id: true, orderId: true } });
        await pm.order.update({ where: { id: s0.orderId }, data: { transportMode: mode } });
        await pm.shipment.update({ where: { id: s0.id }, data: { transportMode: mode } });
        const bid = (await must("POST /staff/loading-manifests", STAFF, { warehouse: `${P}wh`, transportMode: mode, containerNo: uniq("BOX") })).manifest.id;
        const cc = await load(bid, pp);
        await pushAll(bid, [["SEALED", "2026-08-25"]]);
        await pm.shipment.update({ where: { trackingNo: cc }, data: { currentStatus: aheadStatus } });
        await pushAll(bid, [["CUSTOMS", "2026-09-14"]]);
        const uu = await undo(bid);
        assert.equal(uu.status, 200, uu.message);
        return { id: bid, child: cc };
      };
      const hzSea = await hazard("sea", "arrivedPort");
      const swHzSea = await toLand(hzSea.id);
      const hzLand = await hazard("land", "atPortCn");
      const swHzLand = await toSea(hzLand.id);
      const hzState = {
        sea: { mode: (await pm.container.findUnique({ where: { id: hzSea.id }, select: { transportMode: true } }))?.transportMode, ship: await statusOf(hzSea.child) },
        land: { mode: (await pm.container.findUnique({ where: { id: hzLand.id }, select: { transportMode: true } }))?.transportMode, ship: await statusOf(hzLand.child) },
      };
      expect("撤销后柜里货停在「已到港」：改陆运被拒；陆运柜里货停在「到达凭祥口岸」：改海运被拒；运输方式和货都没动", () => {
        assert.notEqual(swHzSea.status, 200, swHzSea.message); assert.match(swHzSea.message, /已到港/);
        assert.notEqual(swHzLand.status, 200, swHzLand.message); assert.match(swHzLand.message, /凭祥/);
        assert.deepEqual(hzState, { sea: { mode: "sea", ship: "arrivedPort" }, land: { mode: "land", ship: "atPortCn" } });
      });

      // 柜子自己要退到对方流程才有的步骤（直接改库造出来的乱数据：陆运柜的时间表 / 账本里有「已到港」）：不撤，什么都不动
      const mixLegacy = await legacyBox(seaSteps);
      await pm.statusLog.deleteMany({ where: { shipmentId: { in: mixLegacy.ships }, id: { startsWith: "sl_ctn_" } } });
      await pm.container.update({ where: { id: mixLegacy.id }, data: { transportMode: "land", statusDates: JSON.stringify({ SEALED: "2026-08-25T00:00:00.000Z", ARRIVED: "2026-09-13T00:00:00.000Z", CUSTOMS: "2026-09-14T00:00:00.000Z" }) } });
      const uMixLegacy = await undo(mixLegacy.id);
      const pMixL = await seedShipment(); const mixLedger = await newBox(); await load(mixLedger.id, pMixL);
      await pushAll(mixLedger.id, seaSteps);
      // 货先卸掉（直接删装柜关系），只剩柜子自己要退到「已到港」这一条对不上
      await pm.shipmentContainerItem.deleteMany({ where: { containerId: mixLedger.id } });
      await pm.container.update({ where: { id: mixLedger.id }, data: { transportMode: "land" } });
      const uMixLedger = await undo(mixLedger.id);
      const mixState = { legacy: await boxStatus(mixLegacy.id), ledger: await boxStatus(mixLedger.id) };
      expect("陆运柜要退回「已到港」（老柜子按时间表 / 有账本按账本）：撤销都 409，柜子不动", () => {
        assert.equal(uMixLegacy.status, 409, uMixLegacy.message); assert.match(uMixLegacy.message, /已到港/);
        assert.equal(uMixLedger.status, 409, uMixLedger.message); assert.match(uMixLedger.message, /已到港/);
        assert.deepEqual(mixState, { legacy: "CUSTOMS", ledger: "CUSTOMS" });
      });
      // 改运输方式功能出现之前就乱了的老柜子：标着陆运、却停在海运才有的「已到港」（线上真有标陆运停在「运输中」的）。
      // 当前状态本身就不在自己流程里，这道核对不管，照原来的老路子撤
      const odd = await legacyBox([["SEALED", "2026-08-25"], ["IN_TRANSIT", "2026-09-01"], ["ARRIVED", "2026-09-13"]]);
      await pm.container.update({ where: { id: odd.id }, data: { transportMode: "land" } });
      const uOdd = await undo(odd.id);
      const oddBox = await boxStatus(odd.id);
      expect("标陆运却停在「已到港」的乱数据老柜子：照原来撤一步到「运输中」", () => { assert.equal(uOdd.status, 200, uOdd.message); assert.equal(oddBox, "IN_TRANSIT"); });

      // 货带着别的柜的推进记录挪进来（Codex 第三批第 3 轮 P2，线上 1 个柜子有这种形状）：遗留整票用同一个运单从柜 A 挪进柜 B，
      // 柜 A 推过「运输中」。立刻挪、不改装柜时间，柜 B 自己只封过柜，改陆运 200
      const pOld = await seedShipment(); const boxA = await newBox(); const moved = await load(boxA.id, pOld);
      await pushAll(boxA.id, [["SEALED", "2026-08-25"], ["IN_TRANSIT", "2026-09-01"]]);
      const movedId = (await pm.shipment.findFirst({ where: { trackingNo: moved, companyId: CO }, select: { id: true } })).id;
      const boxB2 = await newBox();
      await pm.shipmentContainerItem.deleteMany({ where: { containerId: boxA.id, shipmentId: movedId } });
      await pm.shipmentContainerItem.create({ data: { id: `sci_moved_${P}`, containerId: boxB2.id, shipmentId: movedId, loadedVolumeM3: 0.2, loadedPieceCount: 1 } });
      await pm.container.update({ where: { id: boxB2.id }, data: { currentStatus: "SEALED", statusDates: null, transportMode: "sea" } });
      // 货现在的状态跟柜 B 一致（已装柜，两边都有）；它还停在「已开船」的话会被上面「货现在的状态」那道拦住，那是对的
      await pm.shipment.update({ where: { id: movedId }, data: { currentStatus: "loaded" } });
      const rMoved = await toLand(boxB2.id);
      expect("货带着柜 A 的「运输中」记录立刻挪进只封过柜的柜 B、货现在是已装柜：柜 B 改陆运 200", () => { assert.equal(rMoved.status, 200, rMoved.message); });
      for (let i = 0; i < 3; i++) await undo(box.id);
      const sw2 = await call("POST /staff/loading-manifests/transport-mode", STAFF, { id: box.id, transportMode: "land" });
      const r = await push(box.id, "AT_PORT_CN", "2026-08-27");
      const p2 = await seedShipment(); const c2 = await load(box.id, p2);
      const u = await undo(box.id);
      const after = { box: await boxStatus(box.id), c: await statusOf(c), c2: await statusOf(c2), mode: (await pm.container.findUnique({ where: { id: box.id }, select: { transportMode: true } }))?.transportMode };
      expect("撤回已封柜后改陆运 200；推到达凭祥口岸、后装一票、撤一步：柜子已封柜、两票都是已装柜、还是陆运", () => {
        assert.equal(sw2.status, 200, sw2.message);
        assert.equal(r.status, 200, r.message);
        assert.equal(u.status, 200, u.message);
        assert.deepEqual(after, { box: "SEALED", c: "loaded", c2: "loaded", mode: "land" });
      });
    } catch (e) { failures++; console.log(`  ❌ 这个场景中途出错，后面几步没跑完：${e instanceof Error ? e.message.split("\n")[0] : String(e)}`); }

    console.log("\n【15 恢复删过的记录：老数据运单没填运输方式、订单后来改成陆运，撤回已装柜后不能把「已开船」的重复记录恢复回来（Codex 第三批 P1-2）】");
    try {
      const p = await seedShipment(); const box = await newBox(); const c = await load(box.id, p);
      await pushAll(box.id, [["SEALED", "2026-08-25"], ["IN_TRANSIT", "2026-09-01"]]);
      const cs = await pm.shipment.findFirst({ where: { trackingNo: c, companyId: CO }, select: { id: true, orderId: true } });
      const dupId = `sl_mnf_${Date.now()}_dup_${P}`;
      await pm.statusLog.create({ data: { id: dupId, companyId: CO, shipmentId: cs.id, operatorId: STAFF.userId, operatorRole: "staff", operatorName: STAFF.name, fromStatus: "departed", toStatus: "departed", remark: "重复的开船记录", changedAt: new Date("2026-09-02T00:00:00Z") } });
      await must("POST /staff/shipments/track/delete-log", STAFF, { logId: dupId });
      await pm.shipment.updateMany({ where: { trackingNo: { in: [p, c] }, companyId: CO }, data: { transportMode: null } });
      await pm.order.update({ where: { id: cs.orderId }, data: { transportMode: "land" } });
      const u = await undo(box.id);
      const list = await call("GET /admin/shipments/track/deleted-logs", ADMIN, {}, { trackingNo: p });
      const item = (list.data?.items ?? []).find((i: Row) => i.log?.id === dupId);
      const r = await call("POST /admin/shipments/track/restore-log", ADMIN, { auditId: item?.auditId ?? "x" });
      const back = await pm.statusLog.count({ where: { id: dupId } });
      const st = await statusOf(c);
      expect("撤回已装柜后恢复「已开船」重复记录 409，记录没放回，货还是已装柜", () => {
        assert.equal(u.status, 200, u.message);
        assert.ok(item, JSON.stringify(list.data));
        assert.equal(r.status, 409, r.message);
        assert.equal(back, 0);
        assert.equal(st, "loaded");
      });
      // 货现在是陆运才有的「到达凭祥口岸」，记录是海运才有的「已开船」：两条流程都比不出先后，不许恢复
      await pm.shipment.update({ where: { id: cs.id }, data: { currentStatus: "atPortCn" } });
      const r2 = await call("POST /admin/shipments/track/restore-log", ADMIN, { auditId: item?.auditId ?? "x" });
      const back2 = await pm.statusLog.count({ where: { id: dupId } });
      expect("记录「已开船」、货「到达凭祥口岸」比不出先后：恢复 409，记录没放回", () => {
        assert.equal(r2.status, 409, r2.message);
        assert.match(r2.message, /比不出先后/);
        assert.equal(back2, 0);
      });
    } catch (e) { failures++; console.log(`  ❌ 这个场景中途出错，后面几步没跑完：${e instanceof Error ? e.message.split("\n")[0] : String(e)}`); }

    console.log("\n【16 管理员「删过的记录」：运单号改了按新号也查得到；超过 200 条全列出来并给总数（Codex 第三批 P2-1）】");
    try {
      const p = await seedShipment();
      const s = await pm.shipment.findFirst({ where: { trackingNo: p, companyId: CO }, select: { id: true } });
      const dupId = `sl_new_${Date.now()}_dup_${P}`;
      await pm.statusLog.create({ data: { id: dupId, companyId: CO, shipmentId: s.id, operatorId: STAFF.userId, operatorRole: "staff", operatorName: STAFF.name, fromStatus: "created", toStatus: "inWarehouseCN", remark: "重复的入库记录", changedAt: new Date("2026-08-20T03:00:00Z") } });
      await must("POST /staff/shipments/track/delete-log", STAFF, { logId: dupId });
      const newNo = `${p}X`;
      await pm.shipment.update({ where: { id: s.id }, data: { trackingNo: newNo } });
      const byNew = await call("GET /admin/shipments/track/deleted-logs", ADMIN, {}, { trackingNo: newNo });
      await pm.auditLog.createMany({ data: Array.from({ length: 205 }, (_, i) => ({
        companyId: CO, actorId: STAFF.userId, actorRole: "staff", action: "DELETE", resourceType: "StatusLog", resourceId: `sl_new_bulk${i}_${P}`,
        beforeJson: JSON.stringify({ id: `sl_new_bulk${i}_${P}`, companyId: CO, shipmentId: s.id, operatorId: STAFF.userId, operatorRole: "staff", operatorName: STAFF.name, fromStatus: "created", toStatus: "inWarehouseCN", remark: "批量", nextStop: null, changedAt: "2026-08-20T03:00:00.000Z", trackingNo: newNo }),
        remark: `删除物流轨迹 ${newNo}`,
      })) });
      const all = await call("GET /admin/shipments/track/deleted-logs", ADMIN, {}, { trackingNo: newNo });
      expect("改号后按新号查到那 1 条；再存 205 条后 206 条全列出来、总数 206", () => {
        assert.equal(byNew.status, 200, byNew.message);
        assert.deepEqual((byNew.data?.items ?? []).map((i: Row) => i.log?.id), [dupId]);
        assert.equal(all.status, 200, all.message);
        assert.equal(all.data.items.length, 206);
        assert.equal(all.data.total, 206);
      });
    } catch (e) { failures++; console.log(`  ❌ 这个场景中途出错，后面几步没跑完：${e instanceof Error ? e.message.split("\n")[0] : String(e)}`); }

    console.log("\n【17 陆运柜里有「预约派送」的货：推前面的步骤跳过它，不挡整柜（Codex 第三批 P2-2）】");
    try {
      const p1 = await seedShipment(); const p2 = await seedShipment();
      for (const t of [p1, p2]) {
        const s = await pm.shipment.findFirst({ where: { trackingNo: t, companyId: CO }, select: { id: true, orderId: true } });
        await pm.order.update({ where: { id: s.orderId }, data: { transportMode: "land" } });
        await pm.shipment.update({ where: { id: s.id }, data: { transportMode: "land" } });
      }
      const boxId = (await must("POST /staff/loading-manifests", STAFF, { warehouse: `${P}wh`, transportMode: "land", containerNo: uniq("BOX") })).manifest.id;
      const c1 = await load(boxId, p1); const c2 = await load(boxId, p2);
      await pushAll(boxId, [["SEALED", "2026-08-25"]]);
      await pm.shipment.update({ where: { trackingNo: c2 }, data: { currentStatus: "deliveryBooked" } });
      const r = await push(boxId, "AT_PORT_CN", "2026-08-27");
      const s1 = await statusOf(c1); const s2 = await statusOf(c2);
      expect("推到达凭祥口岸 200；预约派送那票跳过并列出，另一票到口岸", () => {
        assert.equal(r.status, 200, r.message);
        assert.ok((r.data?.skippedShipments ?? []).some((x: Row) => x.trackingNo === c2), JSON.stringify(r.data));
        assert.equal(s1, "atPortCn");
        assert.equal(s2, "deliveryBooked");
      });
    } catch (e) { failures++; console.log(`  ❌ 这个场景中途出错，后面几步没跑完：${e instanceof Error ? e.message.split("\n")[0] : String(e)}`); }
  } finally {
    await cleanup();
    const left = (await pm.shipment.count({ where: { companyId: CO } })) + (await pm.container.count({ where: { companyId: CO } }))
      + (await pm.statusLog.count({ where: { companyId: CO } })) + (await pm.user.count({ where: { companyId: CO } }))
      + (await pm.auditLog.count({ where: { companyId: CO } }));
    console.log(`\n测试数据清理：剩 ${left} 行`);
    await pm.$disconnect();
  }
  console.log(`\nFAILURES ${failures}`);
  if (failures) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
