/**
 * 轨迹「删除」只删记录、不改状态 —— 按 2026-09-15 线上那次原样重现（真 PostgreSQL，2026-09-17）。
 *
 * 9-15 线上发生了什么（nginx + API 日志 + 生产库只读核实）：
 *   02:02 新建装柜单 → 02:03 把 12 票从旧柜卸下（父单写一条「已从柜子卸下」，时间是当时真实时间）
 *   → 02:04 装进新柜（新子单写一条「装入柜子」，时间取新柜创建时间）
 *   → 02:05-02:08 新柜补推状态，日期填的是过去的（8-25 封柜 / 9-01 开船 / 9-13 到港 / 9-14 清关中）
 *   → 轨迹里「已从柜子卸下」「装入柜子」两条时间最新，排在「清关中」上面，看着像货退回了国内仓
 *   → 02:15-02:21 员工在轨迹弹窗里把这两条删掉 → 12 票父单被改成「已创建」（货其实在泰国清关）。
 *
 * 老板 9-17 拍板：删除只删记录，不改任何运单 / 父单的状态；显示当前状态的那一条不许删
 *（状态推错了到「装柜管理」撤销）；整柜撤销在这种柜子上退错的问题一起修。
 * 这里每一步都走真实接口（新建装柜单、装柜、卸柜、推柜子状态、查轨迹、删记录、整柜撤销）：
 *   · 按线上两种点击顺序各跑一遍，断言删完以后父单、子单状态都跟删之前一样；
 *   · 当前状态那条：弹窗不给删，硬调接口 409，记录和状态都不动；同一状态有两条时可以删掉一条；
 *   · 整柜撤销：卸柜重装 + 补推过去日期的柜子连撤三步，每步父单子单都退到上一步；
 *     已经单独往前走了的货不跟着退。
 *
 * 只连测试库：DATABASE_URL 不带 neon.tech 的不跑（本机 IPv6 不通、用 IPv4 地址连测试库时，
 * 核实是测试库后设 AGENT_PORTAL_TEST_ALLOW_DB=1）。没有 DATABASE_URL（CI）打印「跳过」。
 * 测试数据全在假公司 zz_trkdel_co 下，开跑前、跑完后都清干净。
 * 用法：npm run test:track-delete-db
 */
process.env.TZ = "UTC"; // 线上服务器是 UTC；推柜子状态时填的日期按服务器时区解析
import assert from "node:assert/strict";

type Row = Record<string, any>;
type Auth = { userId: string; companyId: string; role: string; name: string };

const CO = "zz_trkdel_co";
const P = "zz_trkdel_";
const STAFF: Auth = { userId: `${P}staff`, companyId: CO, role: "staff", name: "测试员工" };
const ADMIN: Auth = { userId: `${P}admin`, companyId: CO, role: "admin", name: "测试管理员" };

const ZH: Record<string, string> = {
  created: "已创建", inWarehouseCN: "已到国内仓", loaded: "已装柜", departed: "已开船",
  arrivedPort: "已到港", customsTH: "泰国清关中", customsCleared: "清关已放行",
};
const zh = (s: string | null | undefined): string => (s ? ZH[s] ?? s : "（无）");

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

async function cleanup(prisma: any): Promise<void> {
  const containers = await prisma.container.findMany({ where: { companyId: CO }, select: { id: true } });
  await prisma.shipmentContainerItem.deleteMany({ where: { containerId: { in: containers.map((c: Row) => c.id) } } });
  await prisma.container.deleteMany({ where: { companyId: CO } });
  await prisma.statusLog.deleteMany({ where: { companyId: CO } });
  await prisma.shipment.deleteMany({ where: { companyId: CO } });
  await prisma.order.deleteMany({ where: { companyId: CO } });
  await prisma.user.deleteMany({ where: { companyId: CO } });
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

  const routes = new Map<string, Function>();
  const app: any = {};
  for (const m of ["get", "post", "put", "patch", "delete"]) app[m] = (p: string, h: Function) => routes.set(`${m.toUpperCase()} ${p}`, h);
  (await import("../apps/api/src/modules/shipments/routes")).registerShipmentRoutes(app);
  (await import("../apps/api/src/modules/containers/routes")).registerContainerRoutes(app);
  (await import("../apps/api/src/modules/loading-manifests/routes")).registerLoadingManifestRoutes(app);

  async function call(key: string, auth: Auth, body: Row = {}, query: Record<string, string> = {}): Promise<{ status: number; data: any; raw: any }> {
    const handler = routes.get(key);
    assert.ok(handler, `没有这个接口：${key}`);
    let status = 200;
    let raw: any;
    const res: any = { status(s: number) { status = s; return res; }, json(p: any) { raw = p; }, setHeader() {} };
    try {
      await handler({ body, query, headers: {}, auth }, res);
    } catch (e) {
      if (e instanceof BusinessError) { status = e.httpStatus; raw = { code: e.code, message: e.message }; } else throw e;
    }
    return { status, data: raw?.data, raw };
  }
  async function must(key: string, auth: Auth, body: Row = {}, query: Record<string, string> = {}): Promise<any> {
    const r = await call(key, auth, body, query);
    assert.equal(r.status, 200, `${key} 失败：${JSON.stringify(r.raw)}`);
    return r.data;
  }
  const statusOf = async (trackingNo: string): Promise<string | null> =>
    (await prisma.shipment.findFirst({ where: { trackingNo, companyId: CO }, select: { currentStatus: true } }))?.currentStatus ?? null;
  const logExists = async (id: string): Promise<boolean> => (await prisma.statusLog.count({ where: { id } })) > 0;

  /** 按 9-15 那天的操作把一票货走到「员工准备删记录」之前那一刻，返回父单号、子单号 */
  async function replayUntilDelete(tag: string): Promise<{ parentNo: string; childNo: string; newBox: string }> {
    const stamp = Date.now().toString(36).toUpperCase();
    const parentNo = `ZZTD${tag}${stamp}`;
    const orderId = `${P}o_${tag}_${stamp}`;
    await prisma.order.create({
      data: {
        id: orderId, companyId: CO, clientId: `${P}client`, warehouseId: `${P}wh`, itemName: "测试鞋",
        productQuantity: 3, packageCount: 3, packageUnit: "箱", transportMode: "sea",
        receiverNameTh: "测试收货人", receiverPhoneTh: "000", receiverAddressTh: "测试地址",
      },
    });
    await prisma.shipment.create({
      data: {
        id: `${P}s_${tag}_${stamp}`, companyId: CO, orderId, trackingNo: parentNo, currentStatus: "inWarehouseCN",
        warehouseId: `${P}wh`, packageCount: 3, volumeM3: 0.6, weightKg: 30, transportMode: "sea",
      },
    });
    // 跟线上父单留下的那条一样：「运单已建立」created→created
    await prisma.statusLog.create({
      data: {
        id: `sl_new_${Date.now()}_${P}${tag}`, companyId: CO, shipmentId: `${P}s_${tag}_${stamp}`,
        operatorId: STAFF.userId, operatorRole: "staff", operatorName: STAFF.name,
        fromStatus: "created", toStatus: "created", remark: "运单已建立", changedAt: new Date("2026-08-24T02:50:36.382Z"),
      },
    });

    const pushTo = async (containerId: string, toStatus: string, date: string) =>
      must("POST /admin/containers/status", ADMIN, { id: containerId, toStatus, date });

    // 旧柜：装进去、推到已开船（线上这票原来就在别的柜子里走着）
    const oldBox = (await must("POST /staff/loading-manifests", STAFF, { warehouse: `${P}wh`, transportMode: "sea", containerNo: `ZZTD-OLD-${tag}${stamp}` })).manifest.id;
    await must("POST /staff/loading-manifests/add-shipment", STAFF, { trackingNo: parentNo }, { id: oldBox });
    await pushTo(oldBox, "SEALED", "2026-08-25");
    await pushTo(oldBox, "IN_TRANSIT", "2026-09-01");

    // 02:02 新建装柜单 → 02:03 从旧柜卸下 → 02:04 装进新柜
    const newBox = (await must("POST /staff/loading-manifests", STAFF, { warehouse: `${P}wh`, transportMode: "sea", containerNo: `ZZTD-NEW-${tag}${stamp}` })).manifest.id;
    const oldItem = await prisma.shipmentContainerItem.findFirst({ where: { containerId: oldBox }, select: { id: true } });
    assert.ok(oldItem, "旧柜里应该有这票货");
    await must("POST /staff/loading-manifests/remove-shipment", STAFF, { itemId: oldItem.id }, { id: oldBox });
    await must("POST /staff/loading-manifests/add-shipment", STAFF, { trackingNo: parentNo }, { id: newBox });

    // 02:05-02:08 新柜补推状态，日期填过去的
    await pushTo(newBox, "SEALED", "2026-08-25");
    await pushTo(newBox, "IN_TRANSIT", "2026-09-01");
    await pushTo(newBox, "ARRIVED", "2026-09-13");
    await pushTo(newBox, "CUSTOMS", "2026-09-14");

    const child = await prisma.shipment.findFirst({ where: { parentTrackingNo: parentNo, companyId: CO }, select: { trackingNo: true } });
    assert.ok(child, "新柜应该装出一个子单");
    return { parentNo, childNo: child.trackingNo, newBox };
  }

  /** 员工在轨迹弹窗里看到的（父单页签，最新在上） */
  async function staffTimeline(parentNo: string): Promise<Row[]> {
    const track = await must("GET /client/shipments/track", STAFF, {}, { trackingNo: parentNo });
    return [...track.timeline].reverse();
  }

  async function scenario(tag: string, title: string, order: Array<"child" | "parent">): Promise<void> {
    console.log(`\n【${title}】`);
    const { parentNo, childNo } = await replayUntilDelete(tag);
    const beforeParent = await statusOf(parentNo);
    const beforeChild = await statusOf(childNo);
    console.log(`  删之前：父单 ${zh(beforeParent)}，子单 ${zh(beforeChild)}`);
    const top = await staffTimeline(parentNo);
    console.log(`  员工看到的轨迹最上面三条：${top.slice(0, 3).map((t) => `「${(t.remark || zh(t.toStatus)).slice(0, 12)}」`).join(" ")}`);
    expect("重现前提：删之前父单、子单都在「泰国清关中」", () => {
      assert.equal(beforeParent, "customsTH");
      assert.equal(beforeChild, "customsTH");
    });
    expect("重现前提：「已从柜子卸下」「装入柜子」排在「清关中」上面（看着像货退回国内仓）", () => {
      const firstCustoms = top.findIndex((t) => t.toStatus === "customsTH");
      const unload = top.findIndex((t) => t.trackingNo === parentNo && String(t.remark).startsWith("已从柜子卸下"));
      const load = top.findIndex((t) => t.trackingNo === childNo && String(t.remark).startsWith("装入柜子"));
      assert.ok(unload >= 0 && load >= 0 && firstCustoms >= 0, JSON.stringify(top.map((t) => t.remark)));
      assert.ok(unload < firstCustoms && load < firstCustoms, "两条应排在清关中上面");
    });

    for (const which of order) {
      const item = (await staffTimeline(parentNo)).find((t) =>
        which === "parent"
          ? t.trackingNo === parentNo && String(t.remark).startsWith("已从柜子卸下")
          : t.trackingNo === childNo && String(t.remark).startsWith("装入柜子"));
      assert.ok(item?.id, `轨迹里找不到要删的那条（${which}）`);
      const label = which === "parent" ? "父单的「已从柜子卸下」" : "子单的「装入柜子」";
      expect(`${label}在弹窗里可以删（不是当前状态那条）`, () => {
        assert.equal(item.canDelete, true);
        assert.equal(item.isCurrentStatus, false);
      });
      const del = await call("POST /staff/shipments/track/delete-log", STAFF, { logId: item.id });
      const p = await statusOf(parentNo);
      const c = await statusOf(childNo);
      console.log(`  删掉${label}（接口 ${del.status}）→ 父单 ${zh(p)}，子单 ${zh(c)}`);
      const stillThere = await logExists(item.id);
      expect(`删掉${label}：接口成功、这条记录没了`, () => {
        assert.equal(del.status, 200, JSON.stringify(del.raw));
        assert.equal(stillThere, false, "记录还在");
      });
      expect(`删掉${label}后：父单还是「${zh(beforeParent)}」`, () => assert.equal(p, beforeParent, `父单变成了「${zh(p)}」`));
      expect(`删掉${label}后：子单还是「${zh(beforeChild)}」`, () => assert.equal(c, beforeChild, `子单变成了「${zh(c)}」`));
    }

    // 显示当前状态的那条（子单唯一一条「清关中」）不许删：弹窗里不给删，硬调接口也拦下，状态和记录都不动
    const current = (await staffTimeline(parentNo)).find((t) => t.trackingNo === childNo && t.toStatus === "customsTH");
    assert.ok(current?.id, "轨迹里找不到子单的「清关中」");
    expect("子单唯一一条「清关中」在弹窗里标成当前状态、不给删", () => {
      assert.equal(current.canDelete, false);
      assert.equal(current.isCurrentStatus, true);
    });
    const blocked = await call("POST /staff/shipments/track/delete-log", STAFF, { logId: current.id });
    const kept = await logExists(current.id);
    const p2 = await statusOf(parentNo);
    const c2 = await statusOf(childNo);
    console.log(`  硬删子单的「清关中」（接口 ${blocked.status}：${blocked.raw?.message ?? ""}）→ 父单 ${zh(p2)}，子单 ${zh(c2)}`);
    expect("硬删当前状态那条：接口 409、提示去装柜管理撤销、记录还在、状态不变", () => {
      assert.equal(blocked.status, 409, JSON.stringify(blocked.raw));
      assert.match(String(blocked.raw?.message), /装柜管理/);
      assert.equal(kept, true, "记录被删了");
      assert.equal(p2, beforeParent);
      assert.equal(c2, beforeChild);
    });
  }

  /** 同一个状态有两条记录（装入柜子 + 已封柜，都是「已装柜」）：可以删掉一条，最后一条不许删 */
  async function duplicateCurrentStatus(): Promise<void> {
    console.log("\n【同一个状态有两条记录：删掉一条可以，最后一条不许删】");
    const stamp = Date.now().toString(36).toUpperCase();
    const parentNo = `ZZTDC${stamp}`;
    const orderId = `${P}o_C_${stamp}`;
    await prisma.order.create({
      data: {
        id: orderId, companyId: CO, clientId: `${P}client`, warehouseId: `${P}wh`, itemName: "测试鞋",
        productQuantity: 2, packageCount: 2, packageUnit: "箱", transportMode: "sea",
        receiverNameTh: "测试收货人", receiverPhoneTh: "000", receiverAddressTh: "测试地址",
      },
    });
    await prisma.shipment.create({
      data: {
        id: `${P}s_C_${stamp}`, companyId: CO, orderId, trackingNo: parentNo, currentStatus: "inWarehouseCN",
        warehouseId: `${P}wh`, packageCount: 2, volumeM3: 0.4, weightKg: 20, transportMode: "sea",
      },
    });
    const box = (await must("POST /staff/loading-manifests", STAFF, { warehouse: `${P}wh`, transportMode: "sea", containerNo: `ZZTD-DUP-${stamp}` })).manifest.id;
    await must("POST /staff/loading-manifests/add-shipment", STAFF, { trackingNo: parentNo }, { id: box });
    await must("POST /admin/containers/status", ADMIN, { id: box, toStatus: "SEALED", date: "2026-08-25" });
    const child = await prisma.shipment.findFirst({ where: { parentTrackingNo: parentNo, companyId: CO }, select: { trackingNo: true } });
    assert.ok(child);
    const loadedRows = (await staffTimeline(parentNo)).filter((t) => t.trackingNo === child.trackingNo && t.toStatus === "loaded");
    expect("子单有两条「已装柜」，两条在弹窗里都能删", () => {
      assert.equal(loadedRows.length, 2, JSON.stringify(loadedRows.map((t) => t.remark)));
      assert.ok(loadedRows.every((t) => t.canDelete === true && t.isCurrentStatus === false));
    });
    const first = await call("POST /staff/shipments/track/delete-log", STAFF, { logId: loadedRows[0]!.id });
    const left = (await staffTimeline(parentNo)).filter((t) => t.trackingNo === child.trackingNo && t.toStatus === "loaded");
    const second = await call("POST /staff/shipments/track/delete-log", STAFF, { logId: left[0]?.id });
    const c = await statusOf(child.trackingNo);
    console.log(`  删第一条（接口 ${first.status}）→ 删剩下那条（接口 ${second.status}）→ 子单 ${zh(c)}`);
    expect("删掉第一条成功；剩下那条变成当前状态、再删被拦下；子单还是「已装柜」", () => {
      assert.equal(first.status, 200, JSON.stringify(first.raw));
      assert.equal(left.length, 1);
      assert.equal(left[0]!.canDelete, false);
      assert.equal(left[0]!.isCurrentStatus, true);
      assert.equal(second.status, 409, JSON.stringify(second.raw));
      assert.equal(c, "loaded");
    });
  }

  /** 整柜撤销：9-15 那种「卸柜重装 + 补推过去的日期」的柜子，撤一步要退到上一步，不能退成「已装柜」 */
  async function undoAfterReload(): Promise<void> {
    console.log("\n【整柜撤销：卸柜重装 + 补推过去日期的柜子】");
    const { parentNo, childNo, newBox } = await replayUntilDelete("D");
    const box = async () => (await prisma.container.findUnique({ where: { id: newBox }, select: { currentStatus: true } }))?.currentStatus;
    console.log(`  撤销前：柜子 ${await box()}，父单 ${zh(await statusOf(parentNo))}，子单 ${zh(await statusOf(childNo))}`);
    const steps: Array<[string, string]> = [["ARRIVED", "arrivedPort"], ["IN_TRANSIT", "departed"], ["SEALED", "loaded"]];
    for (const [boxStatus, shipStatus] of steps) {
      const r = await call("POST /admin/containers/status/undo", ADMIN, { id: newBox });
      const b = await box();
      const p = await statusOf(parentNo);
      const c = await statusOf(childNo);
      console.log(`  点一次撤销（接口 ${r.status}）→ 柜子 ${b}，父单 ${zh(p)}，子单 ${zh(c)}`);
      expect(`撤到柜子「${boxStatus}」：父单、子单都是「${zh(shipStatus)}」`, () => {
        assert.equal(r.status, 200, JSON.stringify(r.raw));
        assert.equal(b, boxStatus);
        assert.equal(c, shipStatus, `子单变成了「${zh(c)}」`);
        assert.equal(p, shipStatus, `父单变成了「${zh(p)}」`);
      });
    }
  }

  /** 整柜撤销：柜子里已经往前走了的货（这里用尾端签收过的）不跟着退 */
  async function undoLeavesMovedOnShipments(): Promise<void> {
    console.log("\n【整柜撤销：已经往前走了的货不跟着退】");
    const { parentNo, childNo, newBox } = await replayUntilDelete("E");
    // 柜子推到「已放行」，然后这票货单独往前走了（直接改状态 + 写一条非柜子推进的记录，模拟尾端派送）
    await must("POST /admin/containers/status", ADMIN, { id: newBox, toStatus: "CUSTOMS_CLEARED", date: "2026-09-15" });
    const child = await prisma.shipment.findFirst({ where: { trackingNo: childNo, companyId: CO }, select: { id: true } });
    assert.ok(child);
    await prisma.shipment.update({ where: { id: child.id }, data: { currentStatus: "outForDelivery" } });
    await prisma.statusLog.create({
      data: {
        id: `sl_zzmove_${Date.now()}`, companyId: CO, shipmentId: child.id, operatorId: STAFF.userId, operatorRole: "staff", operatorName: STAFF.name,
        fromStatus: "customsCleared", toStatus: "outForDelivery", remark: "测试：货已单独往前走", changedAt: new Date("2026-09-16T00:00:00Z"),
      },
    });
    const r = await call("POST /admin/containers/status/undo", ADMIN, { id: newBox });
    const c = await statusOf(childNo);
    console.log(`  撤销「已放行」（接口 ${r.status}）→ 子单 ${zh(c)}，父单 ${zh(await statusOf(parentNo))}`);
    expect("柜子退回，但已经往前走的子单还是「派送中」", () => {
      assert.equal(r.status, 200, JSON.stringify(r.raw));
      assert.equal(c, "outForDelivery");
    });
  }

  console.log("轨迹删除只删记录、不改状态（真库，按 9-15 线上操作重现）");
  try {
    await cleanup(prisma);
    for (const u of [STAFF, ADMIN]) {
      await prisma.user.create({ data: { id: u.userId, companyId: CO, role: u.role, name: u.name, phone: "000", status: "active" } });
    }
    await prisma.user.create({ data: { id: `${P}client`, companyId: CO, role: "client", name: "测试客户", phone: "000", status: "active" } });

    await scenario("A", "顺序一：先删子单那条，再删父单那条（线上 YW0001474/1489/1495/1497/1499/1502 是这个顺序）", ["child", "parent"]);
    await scenario("B", "顺序二：先删父单那条，再删子单那条（线上 YW0001503/1504/1507/1508/1509/1510 是这个顺序）", ["parent", "child"]);
    await duplicateCurrentStatus();
    await undoAfterReload();
    await undoLeavesMovedOnShipments();
  } finally {
    await cleanup(prisma);
    const left = await prisma.shipment.count({ where: { companyId: CO } }) + await prisma.container.count({ where: { companyId: CO } })
      + await prisma.statusLog.count({ where: { companyId: CO } }) + await prisma.user.count({ where: { companyId: CO } });
    console.log(`\n测试数据清理：剩 ${left} 行`);
    await prisma.$disconnect();
  }
  console.log(`\nFAILURES ${failures}`);
  if (failures) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
