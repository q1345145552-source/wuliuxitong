/**
 * 一票只有一个货型（2026-11-24 老板：「改一下逻辑，一票只会有一个货型，不能单独产品选择货型」）—— 连库。
 *
 * 真接口、真 PostgreSQL（一次性库 / 测试库）：每个能建单 / 改单的入口都试一遍，看库里订单和每条产品行的货型。
 *   C1 员工建单：新页面（整票 + 每行同一个）存成那一个；老页面（整票默认普货、产品行真选的）跟产品行；产品行不一样 400、一张不建
 *   C2 客户预报：同上；产品行空着的跟着整票
 *   C3 超管改单只改货型：这票全部产品行跟着改；返回的版本跟库里一样（再存一次不会被当成别人改过）
 *   C4 上线前就混着几种的老单（直接写库造）：只改备注不碰货型；改产品行（没带货型）统一成最严的；老页面带着混的产品行来 400、什么都不写
 *   C5 收货时改整票货型（直接调接口）：产品行跟着
 *   C6 到货通知：每款不一样 400；一样的转正式，订单产品行都是它；上线前混着的老通知转正式，订单产品行统一成最严的
 *   C7 整柜：清单几行不一样 400、一柜不建；一样的照建
 *   C8 到货通知里改已转正式运单（页面真代码 buildAdminOrderPatch → 超管改单）：混着的老单存一次就统一，总重量总体积不动
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Row = Record<string, any>;
type Auth = { userId: string; companyId: string; role: string; name: string; agentId: string | null };
const CO = "zz_cargo1_co";
const ADMIN: Auth = { userId: "zz_cargo1_admin", companyId: CO, role: "admin", name: "超管", agentId: null };
const STAFF: Auth = { userId: "zz_cargo1_staff", companyId: CO, role: "staff", name: "员工", agentId: null };
const MARK = "ZZCARGO01";
const CLIENT: Auth = { userId: MARK, companyId: CO, role: "client", name: "客户", agentId: null };
const WH = "wh_yiwu_01";
const ONE = /一票只能有一个货型/;

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`✅ ${name}`); }
  catch (e) { failures += 1; console.log(`❌ ${name}\n   ${(e instanceof Error ? e.stack ?? e.message : String(e)).split("\n").slice(0, 8).join("\n   ")}`); }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) { console.log("⚠️ 跳过：没有 DATABASE_URL（CI 没有数据库）—— 这一项等于没测"); return; }
  if (process.env.AGENT_PORTAL_TEST_ALLOW_DB !== "1") {
    console.log("⚠️ 跳过：没设 AGENT_PORTAL_TEST_ALLOW_DB=1，怕连到生产库不跑（确认 DATABASE_URL 是一次性库 / 测试库再设）—— 这一项等于没测");
    return;
  }
  process.env.NODE_ENV = process.env.NODE_ENV || "test";
  process.env.IMAGES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "zz-cargo1-img-"));

  const { prisma } = await import("../apps/api/src/db/prisma");
  const { BusinessError } = await import("../apps/api/src/modules/core/business-error");
  const pm: any = prisma;
  const routes = new Map<string, Function>();
  const app: any = {};
  for (const m of ["get", "post", "put", "patch", "delete"]) app[m] = (p: string, h: Function) => routes.set(`${m.toUpperCase()} ${p}`, h);
  (await import("../apps/api/src/modules/arrival-notices/routes")).registerArrivalNoticeRoutes(app);
  (await import("../apps/api/src/modules/orders/routes")).registerOrderRoutes(app);
  (await import("../apps/api/src/modules/admin/routes")).registerAdminRoutes(app);
  (await import("../apps/api/src/modules/fcl-containers/routes")).registerFclContainerRoutes(app);
  const { buildAdminOrderPatch } = await import("../apps/web/src/modules/arrival-notice/converted-edit");
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
  async function rejected(key: string, auth: Auth, body: Row): Promise<string> {
    const r = await call(key, auth, body);
    assert.equal(r.status, 400, `${key} 应该被拦，实际 ${r.status}：${r.message}`);
    assert.match(r.message, ONE, `${key} 拦下的理由不对：${r.message}`);
    return r.message;
  }
  /** 一张单现在的样子：订单货型 + 每条产品行的货型（按顺序） */
  async function cargoOf(trackingNo: string): Promise<{ order: string; products: string[]; orderId: string; shipmentId: string; updatedAt: string; weightKg: string | null; volumeM3: string | null }> {
    const s = await pm.shipment.findFirst({ where: { trackingNo }, include: { order: true } });
    assert.ok(s, `找不到运单 ${trackingNo}`);
    const ps = await pm.orderProduct.findMany({ where: { orderId: s.orderId }, orderBy: { sortOrder: "asc" }, select: { cargoType: true } });
    return {
      order: s.order.cargoType, products: ps.map((p: Row) => p.cargoType), orderId: s.orderId, shipmentId: s.id,
      updatedAt: s.order.updatedAt.toISOString(), weightKg: s.order.weightKg?.toString() ?? null, volumeM3: s.order.volumeM3?.toString() ?? null,
    };
  }

  async function cleanup(): Promise<void> {
    const ns = await pm.arrivalNotice.findMany({ where: { companyId: CO }, select: { id: true } });
    const ids = ns.map((n: Row) => n.id);
    await pm.arrivalNoticeImage.deleteMany({ where: { noticeId: { in: ids } } });
    await pm.arrivalNoticeSnapshot?.deleteMany?.({ where: { noticeId: { in: ids } } });
    await pm.arrivalNoticeProduct.deleteMany({ where: { noticeId: { in: ids } } });
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

  const row = (itemName: string, cargoType?: string, extra: Row = {}) => ({ itemName, packageCount: 2, lengthCm: 50, widthCm: 40, heightCm: 30, weightKg: 5, ...(cargoType === undefined ? {} : { cargoType }), ...extra });
  const staffOrder = (trackingNo: string, cargoType: string | undefined, products: Row[]) => ({
    clientId: MARK, trackingNo, itemName: products[0]?.itemName ?? "灯具", packageCount: 2, transportMode: "sea", warehouseId: WH, arrivedAt: "2026-11-24",
    ...(cargoType === undefined ? {} : { cargoType }), products,
  });

  await cleanup();
  try {
    for (const u of [ADMIN, STAFF, CLIENT]) {
      await pm.user.create({ data: { id: u.userId, companyId: CO, role: u.role, name: u.name, passwordHash: "x", phone: `0${u.userId}`, status: "active" } });
    }

    await check("C1 员工建单：新页面存成整票那个；老页面（整票默认普货、产品行真选的）跟产品行；产品行不一样 400、一张不建", async () => {
      await must("POST /staff/orders", STAFF, staffOrder("ZZCG0101", "special", [row("灯", "special"), row("鞋", "special")]));
      assert.deepEqual(await cargoOf("ZZCG0101").then((c) => [c.order, c.products]), ["special", ["special", "special"]]);
      await must("POST /staff/orders", ADMIN, staffOrder("ZZCG0102", "normal", [row("灯", "sensitive"), row("鞋", "sensitive")]));
      assert.deepEqual(await cargoOf("ZZCG0102").then((c) => [c.order, c.products]), ["sensitive", ["sensitive", "sensitive"]]);
      await rejected("POST /staff/orders", STAFF, staffOrder("ZZCG0103", "sensitive", [row("灯", "sensitive"), row("鞋", "normal")]));
      assert.equal(await pm.shipment.count({ where: { trackingNo: "ZZCG0103" } }), 0, "被拦下还建了单");
      // 没分产品行：整票那个
      await must("POST /staff/orders", STAFF, { ...staffOrder("ZZCG0104", "inspection", []), products: undefined });
      assert.deepEqual(await cargoOf("ZZCG0104").then((c) => [c.order, c.products]), ["inspection", ["inspection"]]);
    });

    await check("C2 客户预报：产品行空着的跟着整票；产品行不一样 400、一张不建", async () => {
      const before = await pm.order.count({ where: { companyId: CO, clientId: MARK } });
      const made = await must("POST /client/prealerts", CLIENT, { warehouseId: WH, transportMode: "land", cargoType: "inspection", products: [row("玩具", "inspection"), row("文具")] });
      const ps = await pm.orderProduct.findMany({ where: { orderId: made.prealertId }, orderBy: { sortOrder: "asc" }, select: { cargoType: true } });
      const o = await pm.order.findUnique({ where: { id: made.prealertId } });
      assert.deepEqual([o.cargoType, ps.map((p: Row) => p.cargoType)], ["inspection", ["inspection", "inspection"]]);
      await rejected("POST /client/prealerts", CLIENT, { warehouseId: WH, transportMode: "land", products: [row("玩具", "inspection"), row("文具", "normal")] });
      assert.equal(await pm.order.count({ where: { companyId: CO, clientId: MARK } }), before + 1, "被拦下还建了预报单");
    });

    await check("C3 超管改单只改货型：这票全部产品行跟着改；返回的版本跟库里一样；总重量总体积不动", async () => {
      const c0 = await cargoOf("ZZCG0101");
      const saved = await must("POST /admin/orders/update", ADMIN, { orderId: c0.shipmentId, cargoType: "inspection", expectedOrderUpdatedAt: c0.updatedAt });
      const c1 = await cargoOf("ZZCG0101");
      assert.deepEqual([c1.order, c1.products], ["inspection", ["inspection", "inspection"]]);
      assert.equal(saved.updatedAt, c1.updatedAt, "返回的版本跟库里的不一样：再存一次会被当成别人改过");
      assert.deepEqual([c1.weightKg, c1.volumeM3], [c0.weightKg, c0.volumeM3]);
      // 拿返回的版本接着存：不被当成别人改过
      await must("POST /admin/orders/update", STAFF, { orderId: c0.shipmentId, remark: "接着存", expectedOrderUpdatedAt: saved.updatedAt });
    });

    await check("C4 上线前就混着几种的老单：只改备注不碰货型；老页面带着混的产品行 400 什么都不写；改产品行（没带货型）统一成最严的", async () => {
      await must("POST /staff/orders", STAFF, staffOrder("ZZCG0401", "normal", [row("灯", "normal"), row("鞋", "normal"), row("帽", "normal")]));
      const c0 = await cargoOf("ZZCG0401");
      // 造一张上线前的混装老单：产品行 普货 / 敏感货 / 商检货，订单记最严的敏感货（原来的规矩）
      const ids = (await pm.orderProduct.findMany({ where: { orderId: c0.orderId }, orderBy: { sortOrder: "asc" }, select: { id: true } })).map((p: Row) => p.id);
      await pm.orderProduct.update({ where: { id: ids[1] }, data: { cargoType: "sensitive" } });
      await pm.orderProduct.update({ where: { id: ids[2] }, data: { cargoType: "inspection" } });
      await pm.order.update({ where: { id: c0.orderId }, data: { cargoType: "sensitive" } });
      await must("POST /admin/orders/update", ADMIN, { orderId: c0.shipmentId, remark: "只改备注" });
      assert.deepEqual(await cargoOf("ZZCG0401").then((c) => [c.order, c.products]), ["sensitive", ["normal", "sensitive", "inspection"]], "只改备注却动了货型");
      const before = await cargoOf("ZZCG0401");
      const oldPage = [row("灯", "normal", { id: ids[0] }), row("鞋", "sensitive", { id: ids[1] }), row("帽", "inspection", { id: ids[2], packageCount: 9 })];
      await rejected("POST /admin/orders/update", ADMIN, { orderId: c0.shipmentId, products: oldPage, packageCount: 13 });
      const after = await cargoOf("ZZCG0401");
      assert.deepEqual(after, before, "被拦下还写了库");
      // 直接调接口、产品行没带货型：沿用这票现在显示的（混着的取最严 = 敏感货），每行都统一
      await must("POST /admin/orders/update", ADMIN, { orderId: c0.shipmentId, products: oldPage.map(({ cargoType, ...p }) => p), packageCount: 13 });
      assert.deepEqual(await cargoOf("ZZCG0401").then((c) => [c.order, c.products]), ["sensitive", ["sensitive", "sensitive", "sensitive"]]);
    });

    await check("C5 收货时改整票货型（直接调接口）：产品行跟着", async () => {
      const made = await must("POST /client/prealerts", CLIENT, { warehouseId: WH, transportMode: "sea", products: [row("玩具"), row("文具")] });
      await must("POST /staff/prealerts/receive", STAFF, { orderId: made.prealertId, cargoType: "special" });
      const ps = await pm.orderProduct.findMany({ where: { orderId: made.prealertId }, select: { cargoType: true } });
      const o = await pm.order.findUnique({ where: { id: made.prealertId } });
      assert.deepEqual([o.cargoType, ps.map((p: Row) => p.cargoType)], ["special", ["special", "special"]]);
    });

    const notice = (trackingNo: string, cargo: string[]) => ({
      clientId: MARK, trackingNo, transportMode: "sea", warehouseId: WH, arrivedAt: "2026-11-24",
      products: cargo.map((c, i) => ({ itemName: `货${i}`, packageCount: "2", lengthCm: "40", widthCm: "40", heightCm: "40", weightKg: "10", cargoType: c, domesticTrackingNo: `SF${i}` })),
    });
    await check("C6 到货通知：每款不一样 400；一样的转正式，订单产品行都是它；上线前混着的老通知转正式，订单产品行统一成最严的", async () => {
      await rejected("POST /staff/arrival-notices/save", STAFF, notice("ZZCG0601", ["normal", "sensitive"]));
      assert.equal(await pm.arrivalNotice.count({ where: { companyId: CO, trackingNo: "ZZCG0601" } }), 0);
      const n2 = (await must("POST /staff/arrival-notices/save", STAFF, notice("ZZCG0602", ["inspection", "inspection"]))).item;
      await must("POST /staff/arrival-notices/convert", STAFF, { id: n2.id, to: "formal" });
      assert.deepEqual(await cargoOf("ZZCG0602").then((c) => [c.order, c.products]), ["inspection", ["inspection", "inspection"]]);
      // 上线前登记、混着几种的老通知（直接写库造；整票镜像照原来的规矩记最严的）
      const n3 = (await must("POST /staff/arrival-notices/save", STAFF, notice("ZZCG0603", ["normal", "normal"]))).item;
      const nps = await pm.arrivalNoticeProduct.findMany({ where: { noticeId: n3.id }, orderBy: { sortOrder: "asc" }, select: { id: true } });
      await pm.arrivalNoticeProduct.update({ where: { id: nps[1].id }, data: { cargoType: "sensitive" } });
      await pm.arrivalNotice.update({ where: { id: n3.id }, data: { cargoType: "sensitive" } });
      await must("POST /staff/arrival-notices/convert", STAFF, { id: n3.id, to: "formal" });
      assert.deepEqual(await cargoOf("ZZCG0603").then((c) => [c.order, c.products]), ["sensitive", ["sensitive", "sensitive"]], "混着的老通知转出来的运单还是混的");
    });

    await check("C6b 混着几种的老到货通知（还没转）在弹窗里存一次（页面真代码 draftOf → draftToBody，base 照库里原样）：不被当成同事改过，存成整票一个", async () => {
      const { draftOf } = await import("../apps/web/src/modules/arrival-notice/draft");
      const { draftToBody } = await import("../apps/web/src/services/arrival-notice-api");
      const n = (await must("POST /staff/arrival-notices/save", STAFF, notice("ZZCG0604", ["normal", "normal"]))).item;
      const nps = await pm.arrivalNoticeProduct.findMany({ where: { noticeId: n.id }, orderBy: { sortOrder: "asc" }, select: { id: true } });
      await pm.arrivalNoticeProduct.update({ where: { id: nps[0].id }, data: { cargoType: "inspection" } });
      await pm.arrivalNotice.update({ where: { id: n.id }, data: { cargoType: "inspection" } });
      const listed = (await must("GET /staff/arrival-notices/list", STAFF, {}, { keyword: "ZZCG0604" })).items.find((x: Row) => x.id === n.id);
      const base = draftOf(listed);
      assert.equal(base.cargoType, "inspection", "打开时整票该显示最严的");
      const draft = { ...base, remark: "只改备注" };
      // 同 saveArrivalNotice：草稿整份发，base 照库里原样（rowCargoAsStored）
      await must("POST /staff/arrival-notices/save", STAFF, { id: n.id, ...draftToBody(draft), base: draftToBody(base, { rowCargoAsStored: true }) });
      const after = await pm.arrivalNoticeProduct.findMany({ where: { noticeId: n.id }, orderBy: { sortOrder: "asc" }, select: { cargoType: true } });
      assert.deepEqual(after.map((p: Row) => p.cargoType), ["inspection", "inspection"]);
      // 反过来：base 也统一了发 → 后端拿它跟库里混着的比，会误报「同事改过」（这就是 rowCargoAsStored 要防的）
      const n2 = (await must("POST /staff/arrival-notices/save", STAFF, notice("ZZCG0605", ["normal", "normal"]))).item;
      const nps2 = await pm.arrivalNoticeProduct.findMany({ where: { noticeId: n2.id }, orderBy: { sortOrder: "asc" }, select: { id: true } });
      await pm.arrivalNoticeProduct.update({ where: { id: nps2[0].id }, data: { cargoType: "inspection" } });
      await pm.arrivalNotice.update({ where: { id: n2.id }, data: { cargoType: "inspection" } });
      const base2 = draftOf((await must("GET /staff/arrival-notices/list", STAFF, {}, { keyword: "ZZCG0605" })).items.find((x: Row) => x.id === n2.id));
      const wrong = await call("POST /staff/arrival-notices/save", STAFF, { id: n2.id, ...draftToBody(base2), base: draftToBody(base2) });
      assert.equal(wrong.status, 400, `base 统一了发本该被当成同事改过：${wrong.status} ${wrong.message}`);
      assert.match(wrong.message, /同事改过/);
    });

    const fcl = (trackingNo: string, containerNo: string, cargo: string[]) => ({
      clientId: MARK, trackingNo, containerNo, containerType: "40HQ", transportMode: "sea", warehouseId: WH, loadingDate: "2026-11-20",
      products: cargo.map((c, i) => ({ itemName: `整柜货${i}`, packageCount: 10, quantityPerBox: 20, lengthCm: 60, widthCm: 40, heightCm: 30, unitWeightKg: 2.5, domesticTrackingNo: `SF00${i}`, cargoType: c })),
    });
    await check("C7 整柜：清单几行不一样 400、一柜不建；一样的照建，每行都是它", async () => {
      await rejected("POST /staff/fcl-containers/create", STAFF, fcl("ZZCGBL01", "ZZCGCN01", ["normal", "special"]));
      assert.equal(await pm.shipment.count({ where: { trackingNo: "ZZCGBL01" } }), 0);
      await must("POST /staff/fcl-containers/create", STAFF, fcl("ZZCGBL02", "ZZCGCN02", ["special", "special"]));
      assert.deepEqual(await cargoOf("ZZCGBL02").then((c) => [c.order, c.products]), ["special", ["special", "special"]]);
    });

    await check("C8 到货通知里改已转正式运单（页面真代码）：混着的老单存一次就统一，总重量总体积不动；产品行动了每款都是整票那个", async () => {
      const n = (await must("POST /staff/arrival-notices/save", STAFF, notice("ZZCG0801", ["normal", "normal"]))).item;
      await must("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "formal" });
      const c0 = await cargoOf("ZZCG0801");
      // 运单上造成混着的（上线前的样子）
      const ops = await pm.orderProduct.findMany({ where: { orderId: c0.orderId }, orderBy: { sortOrder: "asc" }, select: { id: true } });
      await pm.orderProduct.update({ where: { id: ops[0].id }, data: { cargoType: "inspection" } });
      await pm.order.update({ where: { id: c0.orderId }, data: { cargoType: "inspection" } });
      const detail = await must("GET /staff/arrival-notices/converted-detail", ADMIN, {}, { id: n.id, v: "2" });
      const base = convertedDraftOf(detail);
      assert.equal(base.cargoType, "inspection", "打开时整票该显示最严的");
      const { patch, changed } = buildAdminOrderPatch(detail.shipmentId, base, { ...base, arrivedAt: "2026-11-23" }, detail.orderUpdatedAt);
      assert.ok(changed); assert.equal(patch.cargoType, "inspection"); assert.equal(patch.products, undefined, "没动产品行就不整份发");
      const mid = await cargoOf("ZZCG0801");
      await must("POST /admin/orders/update", ADMIN, patch);
      const c1 = await cargoOf("ZZCG0801");
      assert.deepEqual([c1.order, c1.products], ["inspection", ["inspection", "inspection"]]);
      assert.deepEqual([c1.weightKg, c1.volumeM3], [mid.weightKg, mid.volumeM3], "统一货型却动了总重量总体积");
      // 再改产品行、换货型：每款都是整票那个
      const detail2 = await must("GET /staff/arrival-notices/converted-detail", ADMIN, {}, { id: n.id, v: "2" });
      const base2 = convertedDraftOf(detail2);
      const edited = { ...base2, cargoType: "special" as const, products: base2.products.map((p, i) => (i === 1 ? { ...p, packageCount: "5" } : p)) };
      const r2 = buildAdminOrderPatch(detail2.shipmentId, base2, edited, detail2.orderUpdatedAt);
      assert.deepEqual(r2.patch.products?.map((p) => p.cargoType), ["special", "special"]);
      await must("POST /admin/orders/update", ADMIN, r2.patch);
      assert.deepEqual(await cargoOf("ZZCG0801").then((c) => [c.order, c.products]), ["special", ["special", "special"]]);
    });
  } finally {
    await cleanup();
    await pm.$disconnect();
  }
  console.log(failures === 0 ? "\n✅ 一票一个货型（连库）：全部通过" : `\n❌ 一票一个货型（连库）：${failures} 项失败`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
