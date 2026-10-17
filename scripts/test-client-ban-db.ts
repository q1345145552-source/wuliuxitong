/**
 * 封禁的客户唛头不许再挂新单（2026-10-17 老板「为什么客户账号已经封禁了，还是能加进去运单？」，选 A）—— 连库。
 *
 * 真接口、真 PostgreSQL（一次性库 / Neon 测试库）：先在没封的时候给这个唛头建好各种老单（运单、到货通知三种状态、整柜、预报单），
 * 再用超管真接口「封禁」，然后逐条挂单的路试：新挂 / 换成它的拦下，已经挂在它名下的照常改、照常走。
 * 规则在 apps/api/src/modules/core/client-ban.ts。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Row = Record<string, any>;
type Auth = { userId: string; companyId: string; role: string; name: string; agentId: string | null };
const CO = "zz_ban_co";
const ADMIN: Auth = { userId: "zz_ban_admin", companyId: CO, role: "admin", name: "超管", agentId: null };
const STAFF: Auth = { userId: "zz_ban_staff", companyId: CO, role: "staff", name: "员工", agentId: null };
const BAN = "ZZBANX01";
const OK1 = "ZZBANOK1";
const OK2 = "ZZBANOK2";
/** 只给并发那几项用（B13～B15 各自用、互不影响） */
const OK3 = "ZZBANOK3";
const OK4 = "ZZBANOK4";
const OK5 = "ZZBANOK5";
const OK6 = "ZZBANOK6";
const OK7 = "ZZBANOK7";
const OK8 = "ZZBANOK8";
const OK9 = "ZZBANOK9";
const OK9_CLIENT: Auth = { userId: OK9, companyId: CO, role: "client", name: "客户九", agentId: null };
const BAN_CLIENT: Auth = { userId: BAN, companyId: CO, role: "client", name: "要封的客户", agentId: null };
const WH = "wh_yiwu_01";
const BANNED = /^账号已封禁$/; // 老板 2026-10-17 定的：「提示说账号已封禁」

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`✅ ${name}`); }
  catch (e) { failures += 1; console.log(`❌ ${name}\n   ${(e instanceof Error ? e.stack ?? e.message : String(e)).split("\n").slice(0, 8).join("\n   ")}`); }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) { console.log("⚠️ 跳过：没有 DATABASE_URL（CI 没有数据库）—— 这一项等于没测"); return; }
  /* 一律要明说是测试库才跑（Codex 审查：别的连库测试见到 neon.tech 就放行，域名分不出 Neon 的测试分支和正式分支；
     这份要建、删数据，宁可多设一个开关）。CI 的 test-db 那一组已经设了 AGENT_PORTAL_TEST_ALLOW_DB=1 */
  if (process.env.AGENT_PORTAL_TEST_ALLOW_DB !== "1") {
    console.log("⚠️ 跳过：没设 AGENT_PORTAL_TEST_ALLOW_DB=1，怕连到生产库不跑（确认 DATABASE_URL 是一次性库 / 测试库再设）—— 这一项等于没测");
    return;
  }
  process.env.NODE_ENV = process.env.NODE_ENV || "test";
  process.env.IMAGES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "zz-ban-img-"));

  const { prisma } = await import("../apps/api/src/db/prisma");
  const { BusinessError } = await import("../apps/api/src/modules/core/business-error");
  const { lockClientBan } = await import("../apps/api/src/modules/core/client-ban");
  const pm: any = prisma;
  const routes = new Map<string, Function>();
  const app: any = {};
  for (const m of ["get", "post", "put", "patch", "delete"]) app[m] = (p: string, h: Function) => routes.set(`${m.toUpperCase()} ${p}`, h);
  (await import("../apps/api/src/modules/arrival-notices/routes")).registerArrivalNoticeRoutes(app);
  (await import("../apps/api/src/modules/orders/routes")).registerOrderRoutes(app);
  (await import("../apps/api/src/modules/admin/routes")).registerAdminRoutes(app);
  (await import("../apps/api/src/modules/fcl-containers/routes")).registerFclContainerRoutes(app);
  (await import("../apps/api/src/modules/fcl-inquiries/routes")).registerFclInquiryRoutes(app);
  (await import("../apps/api/src/modules/client-addresses/routes")).registerClientAddressRoutes(app);
  // 页面真代码：超管在到货通知里改已转正式运单那一步（草稿 → 超管改单请求）
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
  /** 应该被「已封禁」拦下：400 + 那句话 */
  async function banned(key: string, auth: Auth, body: Row): Promise<void> {
    const r = await call(key, auth, body);
    assert.equal(r.status, 400, `${key} 应该被拦，实际 ${r.status}：${r.message}`);
    assert.match(r.message, BANNED, `${key} 拦下的理由不对：${r.message}`);
  }

  async function cleanup(): Promise<void> {
    const ns = await pm.arrivalNotice.findMany({ where: { companyId: CO }, select: { id: true } });
    await pm.arrivalNoticeImage.deleteMany({ where: { noticeId: { in: ns.map((n: Row) => n.id) } } });
    await pm.arrivalNotice.deleteMany({ where: { companyId: CO } });
    const cs = await pm.container.findMany({ where: { companyId: CO }, select: { id: true } });
    await pm.shipmentContainerItem.deleteMany({ where: { containerId: { in: cs.map((c: Row) => c.id) } } });
    await pm.fclInquiry.deleteMany({ where: { companyId: CO } });
    await pm.container.deleteMany({ where: { companyId: CO } });
    await pm.statusLog.deleteMany({ where: { companyId: CO } });
    await pm.orderProductImage.deleteMany({ where: { companyId: CO } });
    await pm.orderProduct.deleteMany({ where: { companyId: CO } });
    await pm.shipment.deleteMany({ where: { companyId: CO } });
    await pm.order.deleteMany({ where: { companyId: CO } });
    await pm.auditLog.deleteMany({ where: { companyId: CO } });
    await pm.clientAddress.deleteMany({ where: { companyId: CO } });
    await pm.user.deleteMany({ where: { companyId: CO } });
  }

  const ticket = (clientId: string, trackingNo: string) => ({
    clientId, trackingNo, itemName: "灯具", packageCount: 2, transportMode: "sea", warehouseId: WH, arrivedAt: "2026-10-17",
  });
  const notice = (clientId: string, trackingNo: string, extra: Row = {}) => ({
    clientId, trackingNo, transportMode: "sea", warehouseId: WH, arrivedAt: "2026-10-17",
    products: [{ itemName: "灯具", packageCount: "2", lengthCm: "40", widthCm: "40", heightCm: "40", weightKg: "10", cargoType: "normal", domesticTrackingNo: "SF1" }],
    ...extra,
  });
  const fcl = (clientId: string, trackingNo: string, containerNo: string) => ({
    clientId, trackingNo, containerNo, containerType: "40HQ", transportMode: "sea", warehouseId: WH,
    loadingDate: "2026-10-10", amountCny: "12000", remark: "原备注",
    products: [{ itemName: "鞋", packageCount: 10, quantityPerBox: 20, lengthCm: 60, widthCm: 40, heightCm: 30, unitWeightKg: 2.5, domesticTrackingNo: "SF001", cargoType: "normal" }],
  });
  const shipByNo = (no: string) => pm.shipment.findFirst({ where: { trackingNo: no }, include: { order: true } });
  /** 把一个已有整柜读回来，拼成「改整柜」要的那份（前端就是这么填回表单的，同 test-fcl-update-db.ts） */
  const fclUpdateBody = (base: Row, containerId: string, over: Row = {}) => ({ ...base, containerId, ...over });

  await cleanup();
  try {
    for (const u of [ADMIN, STAFF, { userId: BAN, role: "client", name: "要封的客户" }, { userId: OK1, role: "client", name: "客户一" }, { userId: OK2, role: "client", name: "客户二" },
      { userId: OK3, role: "client", name: "客户三" }, { userId: OK4, role: "client", name: "客户四" }, { userId: OK5, role: "client", name: "客户五" },
      { userId: OK6, role: "client", name: "客户六" }, { userId: OK7, role: "client", name: "客户七" },
      { userId: OK8, role: "client", name: "客户八" },
      { userId: OK9, role: "client", name: "客户九" }] as Row[]) {
      await pm.user.create({ data: { id: u.userId, companyId: CO, role: u.role, name: u.name, passwordHash: "x", phone: `0${u.userId}`, status: "active" } });
    }

    /* ---------- 封禁前：给 BAN 建好各种老单 ---------- */
    await must("POST /staff/orders", STAFF, ticket(BAN, "ZZBN0001"));
    const oldOrder = await shipByNo("ZZBN0001");
    const nDraft = (await must("POST /staff/arrival-notices/save", STAFF, notice(BAN, "ZZBN0002"))).item;
    const nInbound = (await must("POST /staff/arrival-notices/save", STAFF, notice(BAN, "ZZBN0003"))).item;
    await must("POST /staff/arrival-notices/convert", STAFF, { id: nInbound.id, to: "inbound" });
    const nFormal = (await must("POST /staff/arrival-notices/save", STAFF, notice(BAN, "ZZBN0004"))).item;
    await must("POST /staff/arrival-notices/convert", STAFF, { id: nFormal.id, to: "formal" });
    const fclBanBody = fcl(BAN, "ZZBNBL01", "ZZBNCN01");
    const fclBan = await must("POST /staff/fcl-containers/create", STAFF, fclBanBody);
    const prealert = await must("POST /client/prealerts", BAN_CLIENT, { warehouseId: WH, transportMode: "sea", products: [{ itemName: "玩具", packageCount: 3 }] });
    const inquiry = await must("POST /staff/fcl-inquiries", STAFF, { clientId: BAN, productName: "家具", address: "曼谷" });

    // 给 OK1 也备几张，后面试「换成封禁的唛头」
    await must("POST /staff/orders", STAFF, ticket(OK1, "ZZBN0101"));
    const okOrder = await shipByNo("ZZBN0101");
    const nOkInbound = (await must("POST /staff/arrival-notices/save", STAFF, notice(OK1, "ZZBN0103"))).item;
    await must("POST /staff/arrival-notices/convert", STAFF, { id: nOkInbound.id, to: "inbound" });
    const fclOkBody = fcl(OK1, "ZZBNBL02", "ZZBNCN02");
    const fclOk = await must("POST /staff/fcl-containers/create", STAFF, fclOkBody);

    // 封禁前 BAN 名下有几张订单：老运单、待入库、正式、整柜、预报单
    const banOrdersBefore = await pm.order.count({ where: { companyId: CO, clientId: BAN } });
    assert.equal(banOrdersBefore, 5);

    /* ---------- 超管点「封禁」（真接口） ---------- */
    const toggled = await must("POST /admin/users/toggle-ban", ADMIN, { id: BAN });
    assert.equal(toggled.status, "inactive");

    await check("B1 /staff/clients 带上 status（挂单的下拉靠它去掉封禁的）；名单照旧全给（整柜询价、集货那边还用）", async () => {
      const items = (await must("GET /staff/clients", STAFF)).items as Row[];
      const by = new Map(items.map((c) => [c.id, c]));
      assert.equal(by.get(BAN)?.status, "inactive", "封禁的也在名单里，标着 inactive");
      assert.equal(by.get(OK1)?.status, "active");
      assert.equal(by.get(OK1)?.name, "客户一");
      // 超管「运单管理」改唛头的下拉用的是超管客户名单（/admin/users?role=client），也要带 status（dsh 审查：不带的话下拉又会列出封禁的，页面测试照不出来）
      const adminItems = (await must("GET /admin/users", ADMIN, {}, { role: "client" })).items as Row[];
      const adminBy = new Map(adminItems.map((c) => [c.id, c]));
      assert.equal(adminBy.get(BAN)?.status, "inactive");
      assert.equal(adminBy.get(OK1)?.status, "active");
    });

    await check("B2 员工 / 超管「创建订单」（批量导入也走这条）：封禁的唛头 400、一张不建；没封的照常建", async () => {
      await banned("POST /staff/orders", STAFF, ticket(BAN, "ZZBN0201"));
      await banned("POST /staff/orders", ADMIN, ticket(BAN, "ZZBN0202"));
      assert.equal(await pm.shipment.count({ where: { trackingNo: { in: ["ZZBN0201", "ZZBN0202"] } } }), 0, "被拦下还建了运单");
      assert.equal(await pm.order.count({ where: { companyId: CO, clientId: BAN } }), banOrdersBefore, "BAN 名下还是封禁前那几张");
    });

    await check("B3 超管「运单管理」改唛头：换成封禁的 400、唛头不动；原来就挂在封禁唛头名下的单照常改（页面原样带回唛头也行）；从封禁的换走可以", async () => {
      await banned("POST /admin/orders/update", ADMIN, { orderId: okOrder.id, clientId: BAN });
      assert.equal((await shipByNo("ZZBN0101")).order.clientId, OK1, "被拦下还换了唛头");
      // 老单：带着原来的唛头改别的项
      await must("POST /admin/orders/update", ADMIN, { orderId: oldOrder.id, clientId: BAN, itemName: "改过的灯具" });
      const after = await shipByNo("ZZBN0001");
      assert.equal(after.order.itemName, "改过的灯具");
      assert.equal(after.order.clientId, BAN);
      // 老单：不带唛头改别的项
      await must("POST /admin/orders/update", ADMIN, { orderId: oldOrder.id, itemName: "又改了" });
      // 从封禁的唛头换走 → 可以；再换回去 → 拦
      await must("POST /admin/orders/update", ADMIN, { orderId: oldOrder.id, clientId: OK2 });
      assert.equal((await shipByNo("ZZBN0001")).order.clientId, OK2);
      await banned("POST /admin/orders/update", ADMIN, { orderId: oldOrder.id, clientId: BAN });
      assert.equal((await shipByNo("ZZBN0001")).order.clientId, OK2, "换回封禁的被拦下");
    });

    await check("B4 到货通知新登记：唛头是封禁的 400、一条不建；没封的照常登记，之后改成封禁的 400、唛头不动", async () => {
      const before = await pm.arrivalNotice.count({ where: { companyId: CO } });
      await banned("POST /staff/arrival-notices/save", STAFF, notice(BAN, "ZZBN0301"));
      await banned("POST /staff/arrival-notices/save", STAFF, notice(BAN, ""));
      assert.equal(await pm.arrivalNotice.count({ where: { companyId: CO } }), before, "被拦下还登记了");
      const ok = (await must("POST /staff/arrival-notices/save", STAFF, notice(OK1, "ZZBN0302"))).item;
      await banned("POST /staff/arrival-notices/save", STAFF, { ...notice(BAN, "ZZBN0302"), id: ok.id });
      assert.equal((await pm.arrivalNotice.findFirst({ where: { id: ok.id } })).clientId, OK1);
      // 原来没唛头、这次补上封禁的 → 也算换成它，拦
      const blank = (await must("POST /staff/arrival-notices/save", STAFF, { remark: "还没唛头" })).item;
      await banned("POST /staff/arrival-notices/save", STAFF, { id: blank.id, clientId: BAN, remark: "补唛头" });
      assert.equal((await pm.arrivalNotice.findFirst({ where: { id: blank.id } })).clientId, null);
    });

    await check("B5 封禁前登记、还没转的到货通知：照常能改别的项；转正式 / 转待入库都 400、一张运单不建", async () => {
      const saved = (await must("POST /staff/arrival-notices/save", STAFF, { ...notice(BAN, "ZZBN0002", { remark: "封了以后改个备注" }), id: nDraft.id })).item;
      assert.equal(saved.remark, "封了以后改个备注");
      assert.equal(saved.clientId, BAN);
      await banned("POST /staff/arrival-notices/convert", STAFF, { id: nDraft.id, to: "formal" });
      await banned("POST /staff/arrival-notices/convert", STAFF, { id: nDraft.id, to: "inbound" });
      assert.equal(await pm.shipment.count({ where: { trackingNo: "ZZBN0002" } }), 0, "被拦下还建了运单");
      assert.equal((await pm.arrivalNotice.findFirst({ where: { id: nDraft.id } })).convertedTo, null);
    });

    await check("B6 封禁前已转待入库的：照常改、照常转正式（还是那一张运单，挂在原唛头名下）", async () => {
      await must("POST /staff/arrival-notices/save", STAFF, { ...notice(BAN, "ZZBN0003", { remark: "待入库改备注" }), id: nInbound.id });
      await must("POST /staff/arrival-notices/convert", STAFF, { id: nInbound.id, to: "formal" });
      const s = await shipByNo("ZZBN0003");
      assert.equal(s.currentStatus, "inWarehouseCN");
      assert.equal(s.order.clientId, BAN);
      assert.equal(await pm.shipment.count({ where: { trackingNo: "ZZBN0003" } }), 1);
    });

    await check("B7 别人的待入库到货通知把唛头换成封禁的：400，那张待入库运单也不跟着换", async () => {
      await banned("POST /staff/arrival-notices/save", STAFF, { ...notice(BAN, "ZZBN0103"), id: nOkInbound.id });
      assert.equal((await pm.arrivalNotice.findFirst({ where: { id: nOkInbound.id } })).clientId, OK1);
      assert.equal((await shipByNo("ZZBN0103")).order.clientId, OK1, "被拦下待入库运单的唛头还换了");
    });

    await check("B7b 到货通知跟待入库运单的唛头对不上的老数据（通知上是封禁的、运单上是别人）：照原样存也拦 —— 存了会把运单换成封禁的唛头", async () => {
      await pm.arrivalNotice.update({ where: { id: nOkInbound.id }, data: { clientId: BAN } });
      try {
        await banned("POST /staff/arrival-notices/save", STAFF, { ...notice(BAN, "ZZBN0103"), id: nOkInbound.id });
        assert.equal((await shipByNo("ZZBN0103")).order.clientId, OK1, "被拦下待入库运单的唛头还换了");
      } finally {
        await pm.arrivalNotice.update({ where: { id: nOkInbound.id }, data: { clientId: OK1 } });
      }
    });

    await check("B8 整柜：封禁的唛头建整柜 400、柜和单都不建（从询价单转的也拦、询价单不动）；封禁前建的整柜照常改别的项；别人的整柜改成封禁的 400", async () => {
      await banned("POST /staff/fcl-containers/create", STAFF, fcl(BAN, "ZZBNBL03", "ZZBNCN03"));
      assert.equal(await pm.container.count({ where: { containerNo: "ZZBNCN03" } }), 0);
      assert.equal(await pm.shipment.count({ where: { trackingNo: "ZZBNBL03" } }), 0);
      // 封禁前的整柜询价单转整柜（Codex / dsh 审查）：也拦，询价单不能被标成「已转」
      await banned("POST /staff/fcl-containers/create", STAFF, { ...fcl(BAN, "ZZBNBL04", "ZZBNCN04"), inquiryId: inquiry.id });
      assert.equal(await pm.container.count({ where: { containerNo: "ZZBNCN04" } }), 0);
      const inq = await pm.fclInquiry.findFirst({ where: { id: inquiry.id } });
      assert.equal(inq.status, "pending", "被拦下询价单还改了状态");
      assert.equal(inq.fclContainerId, null);
      await must("POST /staff/fcl-containers/update", STAFF, fclUpdateBody(fclBanBody, fclBan.containerId, { remark: "封了以后改备注" }));
      assert.equal((await pm.container.findFirst({ where: { id: fclBan.containerId } })).remark, "封了以后改备注");
      await banned("POST /staff/fcl-containers/update", STAFF, fclUpdateBody(fclOkBody, fclOk.containerId, { clientId: BAN }));
      assert.equal((await shipByNo("ZZBNBL02")).order.clientId, OK1, "被拦下整柜的唛头还换了");
    });

    await check("B9 封禁前客户自己报的预报单：员工照常「确认收货」（已有的单不动）；封禁以后客户自己再报预报单：400「账号已被封禁」、一张不建", async () => {
      await must("POST /staff/prealerts/receive", STAFF, { orderId: prealert.prealertId, packageCount: 3 });
      assert.equal((await pm.order.findFirst({ where: { id: prealert.prealertId } })).clientId, BAN);
      // 平时封禁的客户进不了门（server.ts 的登录检查）；这里直接调接口，模拟「进门时还没封、提交时已经封了」（dsh 第 2 轮）
      const before = await pm.order.count({ where: { companyId: CO, clientId: BAN } });
      const r = await call("POST /client/prealerts", BAN_CLIENT, { warehouseId: WH, transportMode: "sea", products: [{ itemName: "封了以后报的", packageCount: 1 }] });
      assert.equal(r.status, 400, `${r.status} ${r.message}`);
      assert.equal(r.message, "账号已被封禁", "给客户看的话不提超管、客户管理");
      assert.equal(await pm.order.count({ where: { companyId: CO, clientId: BAN } }), before);
    });

    await check("B10 已转正式的到货通知：超管在到货通知里改（页面真代码拼请求：读运单 → 草稿 → 超管改单），封禁唛头名下照常改", async () => {
      const d = await must("GET /staff/arrival-notices/converted-detail", ADMIN, {}, { id: nFormal.id, v: "2" });
      const base = convertedDraftOf(d);
      assert.equal(base.clientId, BAN);
      const draft = { ...base, products: base.products.map((p) => ({ ...p, itemName: "到货通知里改的" })) };
      const { patch, changed } = buildAdminOrderPatch(d.shipmentId, base, draft, d.orderUpdatedAt);
      assert.equal(changed, true);
      assert.equal((patch as Row).clientId, undefined, "没换唛头就不发唛头");
      await must("POST /admin/orders/update", ADMIN, patch);
      assert.equal((await shipByNo("ZZBN0004")).order.itemName, "到货通知里改的");
      assert.equal((await shipByNo("ZZBN0004")).order.clientId, BAN);
    });

    await check("B11 超管「解除封禁」以后：又能建单、新登记、转运单、询价单转整柜", async () => {
      assert.equal((await must("POST /admin/users/toggle-ban", ADMIN, { id: BAN })).status, "active");
      await must("POST /staff/orders", STAFF, ticket(BAN, "ZZBN0401"));
      const fresh = (await must("POST /staff/arrival-notices/save", STAFF, notice(BAN, "ZZBN0402"))).item;
      assert.equal(fresh.clientId, BAN, "解封后新登记");
      await must("POST /staff/arrival-notices/convert", STAFF, { id: nDraft.id, to: "formal" });
      assert.equal((await shipByNo("ZZBN0002")).order.clientId, BAN);
      await must("POST /staff/fcl-containers/create", STAFF, { ...fcl(BAN, "ZZBNBL05", "ZZBNCN05"), inquiryId: inquiry.id });
      assert.equal((await pm.fclInquiry.findFirst({ where: { id: inquiry.id } })).status, "converted", "解封后询价单照常转整柜");
    });

    /* ---------- 封禁跟挂单同时发生（dsh / Codex 审查）：挂单拿共享档、封禁「只试不排队」拿独占档（core/client-ban.ts 文件头） ---------- */
    /** 开一个事务拿着某把锁做点事、先不提交（模拟另一边正在进行中） */
    async function hold(lockSql: (tx: any) => Promise<unknown>, change: (tx: any) => Promise<unknown> = async () => undefined) {
      let release!: () => void; let locked!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const lockedP = new Promise<void>((r) => { locked = r; });
      const done = prisma.$transaction(async (tx: any) => { await lockSql(tx); await change(tx); locked(); await gate; }, { timeout: 60000 });
      done.catch(() => undefined); // 同 track：先挂上接错的处理，后面 await 它照样会把错抛出来
      // 跟 done 赛跑：拿锁 / change 在就绪前就失败的话，这里直接把错抛出来（不然 lockedP 永远等不到，测试一直挂到 CI 超时 —— Codex / dsh 第 7 轮）
      await Promise.race([lockedP, done]);
      return { release, done };
    }
    /** 放开拿锁的那个事务，等它和这一项发出去的请求全部收尾，再看它自己有没有失败（先 await 它的话，它一失败就跳过后面的收尾 —— Codex 第 7 轮） */
    async function drain(h: { release: () => void; done: Promise<unknown> }, started: Promise<unknown>[]): Promise<void> {
      h.release();
      const [holder] = await Promise.allSettled([h.done, ...started]);
      if (holder.status === "rejected") throw holder.reason;
    }
    const banKey = (clientId: string) => `${CO}:${clientId}`;
    const sharedBanLock = (clientId: string) => (tx: any) => tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(83070, hashtext(${banKey(clientId)}))`;
    const exclusiveBanLock = (clientId: string) => (tx: any) => tx.$executeRaw`SELECT pg_advisory_xact_lock(83070, hashtext(${banKey(clientId)}))`;
    /** 有几个连接正卡在**这个客户**的封禁排队锁上（只认 83070 + 这个唛头算出来的那个号，Codex / dsh 第 2、3 轮） */
    async function banLockWaiters(clientId: string): Promise<number> {
      const r = await pm.$queryRaw`
        SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND classid = 83070 AND objid::bigint = (hashtext(${banKey(clientId)})::bigint & 4294967295) AND NOT granted`;
      return r[0].n;
    }
    /** 有几个连接卡在锁上、而且正在跑的语句长这样（认语句，不数全库） */
    async function stuckOn(sqlLike: string): Promise<number> {
      const r = await pm.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE ${sqlLike}`;
      return r[0].n;
    }
    async function waitFor(what: string, probe: () => Promise<number>, n = 1): Promise<void> {
      for (let i = 0; i < 400; i++) { if ((await probe()) >= n) return; await new Promise((res) => setTimeout(res, 25)); }
      throw new Error(`等了 10 秒也没等到：${what}`);
    }
    /** 并发发出去、过一会儿才 await 的请求：一发出去就挂上接错的处理（Codex 第 6 轮）。
     *  不挂的话，它在我们 await 之前先报错（比如事务 5 秒到点 P2028），Node 24 当成「没人接的报错」直接退出整个测试进程；
     *  原 Promise 照样是失败的，后面 await 它照样拿到这个错 */
    function track<T>(p: Promise<T>): Promise<T> { p.catch(() => undefined); return p; }
    /** ms 毫秒内要有结果，不然算「被挡住了」 */
    async function within<T>(what: string, p: Promise<T>, ms: number): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}：${ms} 毫秒内没回来（被挡住了）`)), ms); });
      try { return await Promise.race([p, late]); } finally { clearTimeout(timer); }
    }
    const statusOf = async (clientId: string) => (await pm.user.findFirst({ where: { id: clientId } })).status;

    await check("B12 封禁正拿着独占档、还没提交时员工点了建单：建单等封禁提交，再读到「已封禁」，400、一张不建", async () => {
      try {
        const h = await hold(exclusiveBanLock(OK2), (tx) => tx.user.update({ where: { id: OK2 }, data: { status: "inactive" } }));
        let mine: Promise<{ status: number; message: string }> = Promise.resolve(null as any);
        try {
          mine = track(call("POST /staff/orders", STAFF, ticket(OK2, "ZZBN0501")));
          await waitFor("建单卡在这个客户的封禁排队锁上", () => banLockWaiters(OK2));
        } finally { await drain(h, [mine]); /* 判定失败时也等它收尾：没人接的报错会让整个测试进程直接退出 */ }
        const r = await mine!;
        assert.equal(r.status, 400, `封禁提交以后还建成了：${r.status} ${r.message}`);
        assert.match(r.message, /已封禁/);
        assert.equal(await pm.shipment.count({ where: { trackingNo: "ZZBN0501" } }), 0);
      } finally {
        await pm.user.update({ where: { id: OK2 }, data: { status: "active" } });
      }
    });

    /** 封禁正在「试」独占锁（重试循环里：那个连接最后一句是 pg_try_advisory_xact_lock(83070…)、事务还开着）—— 认数据库里的实况，不靠睡多久（Codex 第 4 轮）。
     *  ⚠️ 要排除自己、匹配串当参数传：这条查询自己也在 pg_stat_activity 里、正 active，原来字面量写在 SQL 里会匹配到自己，永远 ≥ 1（Codex / dsh 第 5 轮） */
    async function banTrying(): Promise<number> {
      const r = await pm.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state IN ('active', 'idle in transaction') AND query ILIKE ${"%pg_try_advisory_xact_lock(83070%"}`;
      return r[0].n;
    }
    /** 发封禁之前先确认探针是 0（探针坏了 / 上一项留下的封禁还在跑，这里就红，不会空转） */
    const noBanTrying = async () => assert.equal(await banTrying(), 0, "还没点封禁，探针就说有封禁在试锁 —— 探针坏了，或者上一项留下的请求还在跑");
    const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

    await check("B11b 自检：拿锁的那个事务还没就绪就失败了，hold() 马上报错（不会一直挂着等）", async () => {
      await assert.rejects(within("hold 失败", hold(async () => { throw new Error("故意失败"); }), 3000), /故意失败/);
    });

    await check("B13 真接口对撞：建单已过封禁检查（拿着共享档）、停在建订单那一步时超管点了封禁 → 封禁一直在试、等建单提交才封上；建单成功，再建就拦", async () => {
      // 拿住客户那一行，让建单停在「建订单时外键要锁客户行」那一步（它这时已经拿着共享档）
      const rowHold = await hold((tx) => tx.$queryRaw`SELECT id FROM users WHERE id = ${OK3} FOR UPDATE`);
      let order: Promise<{ status: number; message: string }> = Promise.resolve(null as any);
      let ban: Promise<{ status: number; data: any; message: string }> = Promise.resolve(null as any);
      try {
        order = track(call("POST /staff/orders", STAFF, ticket(OK3, "ZZBN0601")));
        await waitFor("建单停在建订单那一步", () => stuckOn("%INSERT INTO%orders%"));
        await noBanTrying();
        ban = track(call("POST /admin/users/toggle-ban", ADMIN, { id: OK3 }));
        await waitFor("封禁在试独占锁（建单拿着共享档）", banTrying);
        assert.equal(await statusOf(OK3), "active");
      } finally { await drain(rowHold, [order, ban]); }
      const o = await order!;
      assert.equal(o.status, 200, `封禁前过了检查的那张该建成：${o.status} ${o.message}`);
      const b = await ban!;
      assert.equal(b.status, 200, b.message);
      assert.equal(b.data.status, "inactive");
      assert.equal((await shipByNo("ZZBN0601")).order.clientId, OK3);
      const again = await call("POST /staff/orders", STAFF, ticket(OK3, "ZZBN0602"));
      assert.equal(again.status, 400, "封禁生效以后再建要拦");
    });

    await check("B14 有人正往这个唛头挂单（拿着共享档，封禁开始试锁以后再拿 6 秒，超过 Prisma 默认 5 秒）：这期间封禁一直没生效，挂单提交后封上", async () => {
      const h = await hold(sharedBanLock(OK4));
      let ban: Promise<{ status: number; data: any; message: string }> = Promise.resolve(null as any);
      try {
        await noBanTrying();
        ban = track(call("POST /admin/users/toggle-ban", ADMIN, { id: OK4 }));
        await waitFor("封禁在试独占锁", banTrying);
        await sleep(1000);
        assert.equal(await statusOf(OK4), "active", "挂单还没提交，封禁不该先生效");
        await sleep(5000);
        assert.equal(await statusOf(OK4), "active", "挂单还没提交，封禁不该先生效");
      } finally { await drain(h, [ban]); }
      const b = await ban!;
      assert.equal(b.status, 200, `${b.status} ${b.message}`);
      assert.equal(await statusOf(OK4), "inactive");
    });

    await check("B15 封禁试了 10 秒还拿不到：大约 10 秒时回 409 中文提示（不是马上、也不是 500），状态不变", async () => {
      const h = await hold(sharedBanLock(OK5));
      let b: { status: number; data: any; message: string };
      let waited = 0;
      let ban: Promise<{ status: number; data: any; message: string }> = Promise.resolve(null as any);
      try {
        await noBanTrying();
        ban = track(call("POST /admin/users/toggle-ban", ADMIN, { id: OK5 }));
        await waitFor("封禁在试独占锁", banTrying);
        const t0 = Date.now();
        // 加上限：要是封禁排进了锁队列（错误写法），它等这边放锁、这边等它回来，会互相卡死 —— 15 秒没回来直接算错
        b = await within("封禁试锁到点回 409", ban, 15000);
        waited = Date.now() - t0;
      } finally { await drain(h, [ban]); }
      assert.equal(b!.status, 409, `${b!.status} ${b!.message}`);
      assert.match(b!.message, /过几秒再点一次/);
      assert.ok(waited >= 8000 && waited <= 12000, `从开始试锁到回 409 应该是 10 秒左右，实际 ${waited} 毫秒`);
      assert.equal(await statusOf(OK5), "active");
    });

    await check("B16 同一个客户同时挂好几张：别人拿着共享档没提交时，真的建单请求照样马上建成（挂单之间不互等）", async () => {
      const h = await hold(sharedBanLock(OK6));
      const orderP = track(call("POST /staff/orders", STAFF, ticket(OK6, "ZZBN0701")));
      try {
        const r = await within("同客户建单", orderP, 3000);
        assert.equal(r.status, 200, r.message);
      } finally { await drain(h, [orderP]); }
    });

    await check("B17 封禁正在试锁时，同一个客户新来的建单不被挡在封禁后面（Codex / dsh 第 3 轮：排队的独占会挡后来的共享，挂单 5 秒就 500）", async () => {
      const h = await hold(sharedBanLock(OK7));
      let ban: Promise<{ status: number; data: any; message: string }> = Promise.resolve(null as any);
      const started: Promise<unknown>[] = [];
      try {
        await noBanTrying();
        ban = track(call("POST /admin/users/toggle-ban", ADMIN, { id: OK7 }));
        started.push(ban);
        // 封禁已经开始抢锁：在试（正确写法）或者排在锁队列里（错误写法）都算，等到了再发建单
        await waitFor("封禁开始抢独占锁", async () => (await banTrying()) + (await banLockWaiters(OK7)));
        const orderP = track(call("POST /staff/orders", STAFF, ticket(OK7, "ZZBN0801")));
        started.push(orderP);
        const r = await within("封禁抢锁期间的建单", orderP, 3000);
        assert.equal(r.status, 200, `封禁还没生效，这张该建成：${r.status} ${r.message}`);
      } finally { await drain(h, started); /* 超时没回来的也等它收尾，别带到下一项（Codex 第 5 轮） */ }
      const b = await ban!;
      assert.equal(b.status, 200, b.message);
      assert.equal(await statusOf(OK7), "inactive");
      assert.equal((await call("POST /staff/orders", STAFF, ticket(OK7, "ZZBN0802"))).status, 400);
    });

    await check("B18 客户那一行被别的事务锁着（比如客户管理改归属）：封禁拿到独占后最多等 1 秒，回 409 中文提示（不是 500），状态不变", async () => {
      const rowHold = await hold((tx) => tx.$queryRaw`SELECT id FROM users WHERE id = ${OK8} FOR UPDATE`);
      let b: { status: number; data: any; message: string };
      let waited = 0;
      const ban = track(call("POST /admin/users/toggle-ban", ADMIN, { id: OK8 }));
      try {
        const t0 = Date.now();
        b = await within("封禁等客户行", ban, 6000);
        waited = Date.now() - t0;
      } finally { await drain(rowHold, [ban]); }
      assert.equal(b!.status, 409, `${b!.status} ${b!.message}`);
      assert.match(b!.message, /过几秒再点一次/);
      // 下限：真的等了；上限：钉住 1 秒这个设计值（改成 3、5 秒，后来的挂单会被拖到默认 5 秒超时 —— Codex / dsh 第 5 轮）
      assert.ok(waited >= 700 && waited <= 1800, `等客户行应该等 1 秒左右，实际 ${waited} 毫秒（改回 2 秒这里就红；值本身另在 test-client-ban-ui U7 核）`);
      assert.equal(await statusOf(OK8), "active");
    });

    await check("B19 封禁在试锁的那几秒里，同一个客户存收货地址（也要锁客户那一行）照样马上存上（dsh 第 4 轮：原来试锁期间一直锁着客户行，地址 / 客服消息 5 秒就 500）", async () => {
      const h = await hold(sharedBanLock(OK9));
      let ban: Promise<{ status: number; data: any; message: string }> = Promise.resolve(null as any);
      const started: Promise<unknown>[] = [];
      try {
        await noBanTrying();
        ban = track(call("POST /admin/users/toggle-ban", ADMIN, { id: OK9 }));
        started.push(ban);
        await waitFor("封禁在试独占锁", banTrying);
        const addrP = track(call("POST /client/addresses", OK9_CLIENT, { contactName: "收货人", contactPhone: "0800000000", addressDetail: "曼谷" }));
        started.push(addrP);
        const r = await within("封禁试锁期间存地址", addrP, 3000);
        assert.equal(r.status, 200, r.message);
      } finally { await drain(h, started); }
      const b = await ban!;
      assert.equal(b.status, 200, b.message);
      assert.equal(await statusOf(OK9), "inactive");
    });
  } finally {
    await cleanup();
    await pm.$disconnect();
  }
  if (failures > 0) { console.log(`\n❌ ${failures} 项没过`); process.exit(1); }
  console.log("\n✅ 封禁唛头不许再挂新单：全部通过");
}

main().catch((e) => { console.error(e); process.exit(1); });
