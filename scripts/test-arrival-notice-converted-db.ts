/**
 * 超管在到货通知里改「已转正式运单」的那条 + 运单管理改完卡片跟着变（2026-10-16 老板「让超管在到货通知里也能改」）—— 连库。
 *
 * 真接口、真 PostgreSQL（一次性库 / Neon 测试库）：登记 → 转正式运单 → 各种改法，核对运单和到货通知两边。
 * 页面那一步（草稿 → 超管改单的请求）用的是页面真代码 converted-edit.ts / draft.ts，不在这里抄一份。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Row = Record<string, any>;
type Auth = { userId: string; companyId: string; role: string; name: string; agentId: string | null };
const CO = "zz_conv_co";
const ADMIN: Auth = { userId: "zz_conv_admin", companyId: CO, role: "admin", name: "超管", agentId: null };
const STAFF: Auth = { userId: "zz_conv_staff", companyId: CO, role: "staff", name: "员工", agentId: null };
const CA = "ZZCVA01";
const CB = "ZZCVB02";

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`✅ ${name}`); }
  catch (e) { failures += 1; console.log(`❌ ${name}\n   ${(e instanceof Error ? e.stack ?? e.message : String(e)).split("\n").slice(0, 8).join("\n   ")}`); }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) { console.log("⚠️ 跳过：没有 DATABASE_URL（CI 没有数据库）—— 这一项等于没测"); return; }
  if (!url.includes("neon.tech") && process.env.AGENT_PORTAL_TEST_ALLOW_DB !== "1") {
    console.log("⚠️ 跳过：DATABASE_URL 不是 Neon 测试库，怕连到生产库不跑（确认是测试库可设 AGENT_PORTAL_TEST_ALLOW_DB=1）—— 这一项等于没测");
    return;
  }
  process.env.NODE_ENV = process.env.NODE_ENV || "test";
  process.env.IMAGES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "zz-conv-img-"));

  const { prisma } = await import("../apps/api/src/db/prisma");
  const { BusinessError } = await import("../apps/api/src/modules/core/business-error");
  const { FCL_EDIT_ELSEWHERE_MESSAGE } = await import("../apps/api/src/modules/core/fcl-scope");
  const pm: any = prisma;
  const routes = new Map<string, Function>();
  const app: any = {};
  for (const m of ["get", "post", "put", "patch", "delete"]) app[m] = (p: string, h: Function) => routes.set(`${m.toUpperCase()} ${p}`, h);
  const arrival = await import("../apps/api/src/modules/arrival-notices/routes");
  arrival.registerArrivalNoticeRoutes(app);
  (await import("../apps/api/src/modules/orders/routes")).registerOrderRoutes(app);
  (await import("../apps/api/src/modules/admin/routes")).registerAdminRoutes(app);
  // 页面真代码
  const { buildAdminOrderPatch, sameConvertedDraft } = await import("../apps/web/src/modules/arrival-notice/converted-edit");
  const { convertedDraftOf } = await import("../apps/web/src/modules/arrival-notice/draft");

  async function call(key: string, auth: Auth, body: Row = {}, query: Record<string, string> = {}): Promise<{ status: number; data: any; message: string }> {
    const handler = routes.get(key);
    if (!handler) return { status: 404, data: undefined, message: `没有这个接口：${key}` };
    let status = 200; let raw: any;
    const res: any = { status(s: number) { status = s; return res; }, json(p: any) { raw = p; }, setHeader() {} };
    try { await handler({ method: key.split(" ")[0], body, query, headers: {}, auth, path: key.split(" ")[1] }, res); }
    catch (e) { if (e instanceof BusinessError) { status = e.httpStatus; raw = { code: e.code, message: e.message }; } else throw e; }
    return { status, data: raw?.data, message: raw?.message ?? "" };
  }
  async function must(key: string, auth: Auth, body: Row = {}, query: Record<string, string> = {}): Promise<any> {
    const r = await call(key, auth, body, query);
    assert.equal(r.status, 200, `${key} 应该成功，实际 ${r.status}：${r.message}`);
    return r.data;
  }
  const listItem = async (auth: Auth, id: string) => (await must("GET /staff/arrival-notices/list", auth, {}, { tab: "all", pageSize: "200" })).items.find((x: Row) => x.id === id);
  const detail = (id: string) => must("GET /staff/arrival-notices/converted-detail", ADMIN, {}, { id });

  async function cleanup(): Promise<void> {
    const ns = await pm.arrivalNotice.findMany({ where: { companyId: CO }, select: { id: true } });
    await pm.arrivalNoticeImage.deleteMany({ where: { noticeId: { in: ns.map((n: Row) => n.id) } } });
    await pm.arrivalNotice.deleteMany({ where: { companyId: CO } });
    const cs = await pm.container.findMany({ where: { companyId: CO }, select: { id: true } });
    await pm.shipmentContainerItem.deleteMany({ where: { containerId: { in: cs.map((c: Row) => c.id) } } });
    await pm.container.deleteMany({ where: { companyId: CO } });
    await pm.statusLog.deleteMany({ where: { companyId: CO } });
    await pm.orderProductImage.deleteMany({ where: { companyId: CO } });
    await pm.orderProduct.deleteMany({ where: { companyId: CO } });
    await pm.shipment.deleteMany({ where: { companyId: CO } });
    await pm.order.deleteMany({ where: { companyId: CO } });
    await pm.auditLog.deleteMany({ where: { companyId: CO } });
    await pm.user.deleteMany({ where: { companyId: CO } });
  }

  /** 登记一票两款的货并转正式运单，返回到货通知 id 和运单 id */
  async function makeConverted(no: string): Promise<{ id: string; shipmentId: string }> {
    const saved = (await must("POST /staff/arrival-notices/save", STAFF, {
      clientId: CA, trackingNo: no, transportMode: "sea", warehouseId: "wh_yiwu_01", arrivedAt: "2026-10-16", remark: "外箱有破损",
      products: [
        { itemName: "冰敷袋", packageCount: "2", lengthCm: "42", widthCm: "42", heightCm: "41", weightKg: "13", cargoType: "normal", domesticTrackingNo: "S665" },
        { itemName: "支架", packageCount: "1", lengthCm: "38", widthCm: "37.5", heightCm: "38", weightKg: "7", cargoType: "sensitive", domesticTrackingNo: null },
      ],
    })).item;
    const conv = (await must("POST /staff/arrival-notices/convert", STAFF, { id: saved.id, to: "formal" })).item;
    assert.equal(conv.convertedTo, "formal");
    return { id: saved.id, shipmentId: conv.shipmentId };
  }
  const orderOf = async (shipmentId: string) => {
    const s = await pm.shipment.findFirst({ where: { id: shipmentId }, select: { orderId: true, weightKg: true, volumeM3: true, trackingNo: true } });
    const o = await pm.order.findFirst({ where: { id: s.orderId } });
    const ps = await pm.orderProduct.findMany({ where: { orderId: s.orderId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }] });
    return { s, o, ps };
  };

  await cleanup();
  try {
    for (const u of [ADMIN, STAFF, { userId: CA, role: "client", name: "客户甲" }, { userId: CB, role: "client", name: "客户乙" }] as Row[]) {
      await pm.user.create({ data: { id: u.userId, companyId: CO, role: u.role, name: u.name, passwordHash: "x", phone: `0${u.userId}`, status: "active" } });
    }
    const A = await makeConverted("ZZCV0001");
    const blank = (await must("POST /staff/arrival-notices/save", STAFF, { remark: "还没转" })).item;

    await check("D1 列表：已转正式的只给超管「能改」标记；员工拿到 false；没转的不带这个标记（false）", async () => {
      assert.equal((await listItem(ADMIN, A.id)).canEditConverted, true);
      assert.equal((await listItem(STAFF, A.id)).canEditConverted, false);
      assert.equal((await listItem(ADMIN, blank.id)).canEditConverted, false);
    });

    await check("D2 converted-detail：只给超管（员工 403）；读的是运单现在的样子，行号跟订单产品行一一对应；没转的 400", async () => {
      const r = await call("GET /staff/arrival-notices/converted-detail", STAFF, {}, { id: A.id });
      assert.equal(r.status, 403);
      const d = await detail(A.id);
      const { ps, o } = await orderOf(A.shipmentId);
      assert.deepEqual(d.productIds, ps.map((p: Row) => p.id));
      assert.deepEqual(d.item.products.map((p: Row) => [p.itemName, p.packageCount, p.cargoType, p.domesticTrackingNo]),
        [["冰敷袋", 2, "normal", "S665"], ["支架", 1, "sensitive", null]], "订单上「货拉拉」回到这边当没填");
      assert.equal(d.item.weightKg, Number(o.weightKg));
      assert.equal(d.item.remark, "外箱有破损", "备注是到货通知自己的");
      assert.equal(d.blockedReason, null);
      assert.equal(d.shipmentId, A.shipmentId);
      const bad = await call("GET /staff/arrival-notices/converted-detail", ADMIN, {}, { id: blank.id });
      assert.equal(bad.status, 400);
    });

    await check("D3 超管在「运单管理」改了运单（重量、第二款件数和国内单号）：到货通知卡片跟着变（员工看到的也是新的），备注不动", async () => {
      const { ps } = await orderOf(A.shipmentId);
      await must("POST /admin/orders/update", ADMIN, {
        orderId: A.shipmentId,
        weightKg: 47, volumeM3: 0.307,
        itemName: "冰敷袋", packageCount: 5,
        products: [
          { id: ps[0].id, itemName: "冰敷袋", packageCount: 2, lengthCm: 42, widthCm: 42, heightCm: 41, weightKg: 13, cargoType: "normal", domesticTrackingNo: "S665" },
          { id: ps[1].id, itemName: "支架", packageCount: 3, lengthCm: 38, widthCm: 37.5, heightCm: 38, weightKg: 7, cargoType: "sensitive", domesticTrackingNo: "JT888" },
        ],
      });
      for (const who of [ADMIN, STAFF]) {
        const it = await listItem(who, A.id);
        assert.equal(it.weightKg, 47, `${who.role} 看到的重量没跟上`);
        assert.equal(it.volumeM3, 0.307);
        assert.deepEqual(it.products.map((p: Row) => [p.itemName, p.packageCount, p.domesticTrackingNo]), [["冰敷袋", 2, "S665"], ["支架", 3, "JT888"]]);
        assert.equal(it.packageCount, 5, "平铺的件数合计也跟上");
        assert.equal(it.remark, "外箱有破损");
      }
      // 搜新的国内单号也搜得到（卡片存的就是新的）
      const found = (await must("GET /staff/arrival-notices/list", STAFF, {}, { tab: "all", keyword: "JT888" })).items.map((x: Row) => x.id);
      assert.ok(found.includes(A.id), "按运单管理改过的新单号搜不到");
    });

    await check("D4 页面的真流程：读运单 → 草稿删一款、改件数 → 打开后没人改过 → 超管改单（带行号）→ 刷新卡片存备注；订单那款真删了", async () => {
      const d = await detail(A.id);
      const base = convertedDraftOf(d);
      const draft = { ...base, remark: "改成一款", products: [{ ...base.products[0], packageCount: "4" }] };
      const fresh = await detail(A.id);
      assert.equal(sameConvertedDraft(base, convertedDraftOf(fresh)), true);
      const { patch, changed } = buildAdminOrderPatch(fresh.shipmentId, base, draft);
      assert.equal(changed, true);
      await must("POST /admin/orders/update", ADMIN, patch as Row);
      const refreshed = (await must("POST /staff/arrival-notices/converted-refresh", ADMIN, { id: A.id, remark: draft.remark })).item;
      const { ps, o } = await orderOf(A.shipmentId);
      assert.equal(ps.length, 1, "删掉的那款订单上也要删掉");
      assert.equal(ps[0].packageCount, 4);
      assert.equal(o.packageCount, 4);
      assert.equal(o.cargoType, "normal", "只剩普货那款：整票货型跟着变成普货");
      assert.equal(refreshed.remark, "改成一款");
      assert.deepEqual(refreshed.products.map((p: Row) => [p.itemName, p.packageCount]), [["冰敷袋", 4]]);
      assert.equal(refreshed.weightKg, Number(o.weightKg));
      assert.equal(refreshed.convertedTo, "formal", "还是已转正式");
    });

    await check("D5 打开以后有人在运单管理改过：页面拿重读的比，能看出来（不会拿老的盖回去）", async () => {
      const base = convertedDraftOf(await detail(A.id));
      const { ps } = await orderOf(A.shipmentId);
      await must("POST /admin/orders/update", ADMIN, { orderId: A.shipmentId, products: [{ id: ps[0].id, itemName: "冰敷袋", packageCount: 6, cargoType: "normal", domesticTrackingNo: "S665", lengthCm: 42, widthCm: 42, heightCm: 41, weightKg: 13 }], packageCount: 6, itemName: "冰敷袋" });
      assert.equal(sameConvertedDraft(base, convertedDraftOf(await detail(A.id))), false);
    });

    await check("D6 converted-refresh：员工 403；不带备注 = 备注不动；带空串 = 清掉；没转的 400；什么都没变时不白改 updatedAt", async () => {
      assert.equal((await call("POST /staff/arrival-notices/converted-refresh", STAFF, { id: A.id, remark: "x" })).status, 403);
      const before = await pm.arrivalNotice.findFirst({ where: { id: A.id } });
      await must("POST /staff/arrival-notices/converted-refresh", ADMIN, { id: A.id });
      const after = await pm.arrivalNotice.findFirst({ where: { id: A.id } });
      assert.equal(after.remark, before.remark);
      assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime(), "资料跟运单一样时不该写库");
      await must("POST /staff/arrival-notices/converted-refresh", ADMIN, { id: A.id, remark: "" });
      assert.equal((await pm.arrivalNotice.findFirst({ where: { id: A.id } })).remark, null);
      assert.equal((await call("POST /staff/arrival-notices/converted-refresh", ADMIN, { id: blank.id, remark: "x" })).status, 400);
    });

    await check("D7 已通知过、在运单管理换了唛头：卡片唛头跟着换、「已通知」清掉（G01）", async () => {
      await must("POST /staff/arrival-notices/notify", STAFF, { id: A.id, notified: true, clientId: CA });
      assert.ok((await listItem(ADMIN, A.id)).notifiedAt);
      await must("POST /admin/orders/update", ADMIN, { orderId: A.shipmentId, clientId: CB });
      const it = await listItem(ADMIN, A.id);
      assert.equal(it.clientId, CB);
      assert.equal(it.notifiedAt, null);
    });

    await check("D8 员工页那条改单路（超管用 patch-shipment-bundle 改重量）：卡片也跟着变", async () => {
      const { s, o } = await orderOf(A.shipmentId);
      await must("POST /staff/orders/patch-shipment-bundle", ADMIN, {
        shipmentId: A.shipmentId, trackingNo: s.trackingNo, itemName: o.itemName, packageCount: o.packageCount, productQuantity: o.productQuantity,
        packageUnit: "box", weightKg: 88.5, volumeM3: Number(s.volumeM3), domesticTrackingNo: o.domesticTrackingNo, transportMode: o.transportMode,
        shipDate: o.shipDate, warehouseId: o.warehouseId, receiverAddressTh: o.receiverAddressTh ?? "",
        orderCreatedDate: o.createdAt.toISOString().slice(0, 10),
      });
      const now = await orderOf(A.shipmentId);
      assert.equal((await listItem(ADMIN, A.id)).weightKg, Number(now.o.weightKg));
      assert.equal(Number(now.o.weightKg), 88.5);
    });

    await check("D9 整柜的单：converted-detail 直接说去「整柜管理」（blockedReason），跟超管改单那条路的拒绝同一句", async () => {
      const B = await makeConverted("ZZCV0002");
      const ctr = await pm.container.create({ data: { id: "zz_conv_fcl", companyId: CO, containerNo: "ZZCVFCL0001", containerType: "40HQ", currentStatus: "LOADING", isFcl: true } });
      await pm.shipmentContainerItem.create({ data: { id: "zz_conv_fcl_item", shipmentId: B.shipmentId, containerId: ctr.id, loadedVolumeM3: 1, loadedPieceCount: 3 } });
      const d = await detail(B.id);
      assert.equal(d.blockedReason, FCL_EDIT_ELSEWHERE_MESSAGE);
      const r = await call("POST /admin/orders/update", ADMIN, { orderId: B.shipmentId, weightKg: 1 });
      assert.equal(r.status, 400);
      assert.equal(r.message, FCL_EDIT_ELSEWHERE_MESSAGE);
    });

    await check("D10 两个对齐同时跑（两次改单紧挨着）：不死锁、最后卡片是运单最新的样子", async () => {
      const { s } = await orderOf(A.shipmentId);
      await pm.orderProduct.updateMany({ where: { orderId: s.orderId }, data: { packageCount: 7 } });
      await Promise.all([
        arrival.syncConvertedNoticesFromShipments(CO, [A.shipmentId]),
        arrival.syncConvertedNoticesFromShipments(CO, [A.shipmentId]),
      ]);
      assert.deepEqual((await listItem(ADMIN, A.id)).products.map((p: Row) => p.packageCount), [7]);
    });

    await check("D12 运单号、唛头不归对齐管（归原来那两个「跟着走」）：运单现在的号被另一条到货通知占着时，对齐照常改别的、不碰号、不撞唯一约束", async () => {
      const E = await makeConverted("ZZCV0005");
      const { s } = await orderOf(E.shipmentId);
      // 老数据：到货通知存的号跟运单对不上，运单现在的号又被一条没转的到货通知占着
      await pm.arrivalNotice.update({ where: { id: E.id }, data: { trackingNo: "ZZCV0005OLD" } });
      await pm.arrivalNotice.create({ data: { id: "zz_conv_squatter", companyId: CO, trackingNo: s.trackingNo, createdBy: STAFF.userId } });
      const logs: string[] = [];
      const orig = { e: console.error, w: console.warn, l: console.log };
      const grab = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
      console.error = grab; console.warn = grab; console.log = grab;
      try {
        await must("POST /admin/orders/update", ADMIN, { orderId: E.shipmentId, weightKg: 66 });
      } finally { console.error = orig.e; console.warn = orig.w; console.log = orig.l; }
      const row = await pm.arrivalNotice.findUnique({ where: { id: E.id } });
      assert.equal(row.trackingNo, "ZZCV0005OLD", "号被占着：对齐不许去改号");
      assert.equal(Number(row.weightKg), 66, "别的资料照常对齐");
      assert.ok(!logs.some((l) => l.includes("prisma:error") || l.includes("sync converted failed")), `对齐不许撞唯一约束：\n${logs.join("\n")}`);
      assert.equal((await listItem(ADMIN, E.id)).trackingNo, s.trackingNo, "卡片照旧显示运单现在的号（F06）");
    });

    await check("D11 运单被删了：卡片不再给超管「能改」，converted-detail 400（当作没转、可以重转）", async () => {
      const C = await makeConverted("ZZCV0003");
      const { s } = await orderOf(C.shipmentId);
      await must("POST /admin/orders/delete", ADMIN, { orderId: s.orderId, confirmPassword: undefined }).catch(async () => {
        // 删单要密码等条件时直接删库（只为造「运单被删了」的状态）
        await pm.statusLog.deleteMany({ where: { shipmentId: C.shipmentId } });
        await pm.orderProduct.deleteMany({ where: { orderId: s.orderId } });
        await pm.shipment.deleteMany({ where: { orderId: s.orderId } });
        await pm.order.delete({ where: { id: s.orderId } });
      });
      const it = await listItem(ADMIN, C.id);
      assert.equal(it.shipmentGone, true);
      assert.equal(it.canEditConverted, false);
      assert.equal((await call("GET /staff/arrival-notices/converted-detail", ADMIN, {}, { id: C.id })).status, 400);
    });
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
  if (failures > 0) { console.log(`\n${failures} 项没过`); process.exit(1); }
  console.log("\n超管改已转正式运单（连库）全部通过");
}
main().catch((e) => { console.error(e); process.exit(1); });
