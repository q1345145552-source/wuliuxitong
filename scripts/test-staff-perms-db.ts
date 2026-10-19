/**
 * 员工端加两项权限（2026-10-19 老板「那就给员工加权限吧」）—— 连库（真 handler + 真 PostgreSQL）。
 * 计划：.audit/2026-10-19/staff-perms/plan.md。
 *
 *   K1 员工重置客户密码：新密码能用、旧的不能用；被连错锁住的号重置完能登；客户手上的旧令牌失效（密码指纹变了）；
 *      不卡强度（「123」这种也行，跟客户自己改一样）、前后空格去掉
 *   K2 只能重置客户号：员工 / 超管 / 代理的号 403、密码一个字没动；别家公司的客户 404；没选人 / 没填 / 太长 400；客户、代理调不了（403）
 *   K3 （审查第 1 轮）查和写之间这个号被改成了员工号：写的时候再核一次是客户号 → 409、密码没动（另一条连接锁住那一行、请求卡住时改角色）
 *   W1 员工改运单（走超管同一条 /admin/orders/update）：只发改过的项也行、产品行改得上、带打开时的版本；别人先存了 409 什么都不写；
 *      编辑框拿员工列表（/staff/shipments）那一条建表单：产品行号、订单版本都对得上（审查第 1 轮 dsh）
 *   W2 员工改运单的闸跟超管一样：待入库的拦（资料在到货通知里补）、换成封禁的唛头拦；客户 / 代理 403
 *   W3 别的超管专属的照旧：删运单、员工页旧的「保存订单信息」（patch-shipment-bundle）员工照旧 403
 *   W4 到货通知里改已转正式运单：员工也能走完（读运单现在的样子 → 改 → 卡片对齐）
 *
 * 只连测试库：DATABASE_URL 不带 neon.tech 的不跑（一次性 docker 库设 AGENT_PORTAL_TEST_ALLOW_DB=1）。测试数据全在假公司 zz_perm_co / zz_perm_co2 下，跑前跑后都清。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Row = Record<string, any>;
type Auth = { userId: string; companyId: string; role: string; name: string; agentId: string | null };
const CO = "zz_perm_co";
const CO2 = "zz_perm_co2";
const ADMIN: Auth = { userId: "zz_perm_admin", companyId: CO, role: "admin", name: "超管", agentId: null };
const STAFF: Auth = { userId: "zz_perm_staff", companyId: CO, role: "staff", name: "员工", agentId: null };
const STAFF2: Auth = { userId: "zz_perm_staff2", companyId: CO, role: "staff", name: "员工二", agentId: null };
const AGENT: Auth = { userId: "zz_perm_agent_user", companyId: CO, role: "agent", name: "代理", agentId: "zz_perm_agent" };
const C1 = "ZZPERM01";
const C2 = "ZZPERM02";
const CBAN = "ZZPERMBAN";
const OTHER_CLIENT = "ZZPERMX1";
const CLIENT: Auth = { userId: C1, companyId: CO, role: "client", name: "客户一", agentId: null };

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) { console.log("⚠️ 跳过：没有 DATABASE_URL（CI 没有数据库）—— 这一项等于没测"); return; }
  if (!url.includes("neon.tech") && process.env.AGENT_PORTAL_TEST_ALLOW_DB !== "1") {
    console.log("⚠️ 跳过：DATABASE_URL 不是 Neon 测试库，怕连到生产库不跑（确认是测试库可设 AGENT_PORTAL_TEST_ALLOW_DB=1）—— 这一项等于没测");
    return;
  }
  process.env.NODE_ENV = process.env.NODE_ENV || "test";
  const imagesDir = fs.mkdtempSync(path.join(os.tmpdir(), "zz-perm-img-"));
  process.env.IMAGES_DIR = imagesDir;

  const { prisma } = await import("../apps/api/src/db/prisma");
  const { BusinessError } = await import("../apps/api/src/modules/core/business-error");
  const { hashPassword, verifyPassword } = await import("../apps/api/src/modules/auth/crypto-utils");
  const { recordLoginFailure, isLoginBlocked, LOGIN_FAILURE_MAX } = await import("../apps/api/src/modules/core/rate-limit");
  const { passwordFingerprint } = await import("../apps/api/src/modules/auth/token");
  const { isSessionStillValid } = await import("../apps/api/src/modules/auth/session-guard");
  const pm: any = prisma;

  const routes = new Map<string, Function>();
  const app: any = {};
  for (const m of ["get", "post", "put", "patch", "delete"]) app[m] = (p: string, h: Function) => routes.set(`${m.toUpperCase()} ${p}`, h);
  (await import("../apps/api/src/modules/arrival-notices/routes")).registerArrivalNoticeRoutes(app);
  (await import("../apps/api/src/modules/orders/routes")).registerOrderRoutes(app);
  (await import("../apps/api/src/modules/admin/routes")).registerAdminRoutes(app);
  (await import("../apps/api/src/modules/shipments/routes")).registerShipmentRoutes(app);

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
  const hashOf = async (id: string) => (await pm.user.findUnique({ where: { id }, select: { passwordHash: true } })).passwordHash as string;
  const setPw = (auth: Auth, id: string, password: unknown) => call("POST /staff/clients/set-password", auth, { id, password });
  /** 员工建一张单（真接口），返回 { shipmentId, orderId } */
  const makeOrder = async (trackingNo: string) => {
    const r = await must("POST /staff/orders", STAFF, {
      clientId: C1, trackingNo, itemName: "鞋", packageCount: 5, transportMode: "sea", warehouseId: "wh_yiwu_01", arrivedAt: "2026-10-19",
      products: [
        { itemName: "鞋", packageCount: 2, lengthCm: 40, widthCm: 30, heightCm: 20, weightKg: 5, cargoType: "normal", domesticTrackingNo: "SF1" },
        { itemName: "包", packageCount: 3, lengthCm: 40, widthCm: 30, heightCm: 20, weightKg: 4, cargoType: "normal", domesticTrackingNo: "SF2" },
      ],
    });
    const ship = await pm.shipment.findFirst({ where: { companyId: CO, trackingNo } });
    assert.ok(ship, `建单没建出运单：${JSON.stringify(r)}`);
    return { shipmentId: ship.id as string, orderId: ship.orderId as string };
  };

  async function cleanup(): Promise<void> {
    for (const co of [CO, CO2]) {
      const ns = await pm.arrivalNotice.findMany({ where: { companyId: co }, select: { id: true } });
      await pm.arrivalNoticeSnapshot.deleteMany({ where: { companyId: co } });
      await pm.arrivalNoticeImage.deleteMany({ where: { noticeId: { in: ns.map((n: Row) => n.id) } } });
      await pm.arrivalNotice.deleteMany({ where: { companyId: co } });
      await pm.statusLog.deleteMany({ where: { companyId: co } });
      await pm.orderProductImage.deleteMany({ where: { companyId: co } });
      await pm.orderProduct.deleteMany({ where: { companyId: co } });
      await pm.shipment.deleteMany({ where: { companyId: co, parentTrackingNo: { not: null } } });
      await pm.shipment.deleteMany({ where: { companyId: co } });
      await pm.order.deleteMany({ where: { companyId: co } });
      await pm.auditLog.deleteMany({ where: { companyId: co } });
      await pm.user.deleteMany({ where: { companyId: co } });
      await pm.agent.deleteMany({ where: { companyId: co } });
    }
  }

  let passed = 0, failed = 0;
  async function check(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`✅ ${name}`); }
    catch (e: any) { failed++; console.log(`❌ ${name}\n   ${(e instanceof Error ? e.stack ?? e.message : String(e)).split("\n").slice(0, 6).join("\n   ")}`); }
  }

  await cleanup();
  try {
    await pm.agent.create({ data: { id: AGENT.agentId, companyId: CO, name: "代理", priceNormal: 1, priceInspection: 1, priceSensitive: 1 } });
    const users: Array<[string, string, string, string, string]> = [
      [ADMIN.userId, CO, "admin", "超管", "Admin#Old123"], [STAFF.userId, CO, "staff", "员工", "Staff#Old123"], [STAFF2.userId, CO, "staff", "员工二", "Staff#Old456"],
      [AGENT.userId, CO, "agent", "代理", "Agent#Old123"], [C1, CO, "client", "客户一", "ZZPERM01"], [C2, CO, "client", "客户二", "ZZPERM02"],
      [CBAN, CO, "client", "封禁客户", "x"], [OTHER_CLIENT, CO2, "client", "别家客户", "ZZPERMX1"],
    ];
    for (const [id, co, role, name, pw] of users) {
      await pm.user.create({ data: { id, companyId: co, role, name, passwordHash: hashPassword(pw), phone: `0${id}`, status: id === CBAN ? "disabled" : "active", agentId: role === "agent" ? AGENT.agentId : null } });
    }

    await check("K1 员工重置客户密码：新密码能用、旧的不能；被连错锁住的号重置完能登；客户手上的旧令牌失效；不卡强度、前后空格去掉", async () => {
      const oldHash = await hashOf(C1);
      for (let i = 0; i < LOGIN_FAILURE_MAX; i++) recordLoginFailure(C1);
      assert.equal(isLoginBlocked(C1), true, "前提：连错锁住了");
      const r = await must("POST /staff/clients/set-password", STAFF, { id: C1, password: "  123  " });
      assert.deepEqual(r, { updated: true, id: C1 });
      const newHash = await hashOf(C1);
      assert.ok(verifyPassword("123", newHash), "新密码（去掉前后空格）要能用");
      assert.ok(!verifyPassword("ZZPERM01", newHash), "旧密码不能再用");
      assert.equal(isLoginBlocked(C1), false, "重置完要清掉连错计数（不然拿新密码也登不进）");
      // 客户手上的旧令牌：指纹是旧密码的，重置后当没登录（auth/session-guard.ts）
      const stale = await isSessionStillValid({ userId: C1, companyId: CO, role: "client", pv: passwordFingerprint(oldHash) } as any);
      assert.equal(stale.ok, false, "重置后客户旧的登录还能用");
      // 超管也能用这一页（超管菜单不挂，但接口给员工 / 超管）
      await must("POST /staff/clients/set-password", ADMIN, { id: C1, password: "ZZPERM01" });
      assert.ok(verifyPassword("ZZPERM01", await hashOf(C1)));
      // 封禁的客户也能重置（不解封，只换密码）
      await must("POST /staff/clients/set-password", STAFF, { id: CBAN, password: "abc" });
      assert.equal((await pm.user.findUnique({ where: { id: CBAN } })).status, "disabled", "重置密码不许顺手解封");
    });

    await check("K2 只能重置客户号：员工 / 超管 / 代理的号 403 且密码没动；别家公司 404；没选人 / 没填 / 太长 400；客户、代理调不了", async () => {
      for (const id of [STAFF.userId, STAFF2.userId, ADMIN.userId, AGENT.userId]) {
        const before = await hashOf(id);
        const r = await setPw(STAFF, id, "Hacked#2026x");
        assert.equal(r.status, 403, `${id}：${r.status} ${r.message}`);
        assert.match(r.message, /只能重置客户的密码/);
        assert.equal(await hashOf(id), before, `${id} 的密码被改了`);
      }
      const otherBefore = await hashOf(OTHER_CLIENT);
      const other = await setPw(STAFF, OTHER_CLIENT, "x1");
      assert.equal(other.status, 404, other.message);
      assert.equal(await hashOf(OTHER_CLIENT), otherBefore, "别家公司的客户密码被改了");
      assert.equal((await setPw(STAFF, "", "x")).status, 400);
      assert.equal((await setPw(STAFF, "  ", "x")).status, 400);
      assert.equal((await setPw(STAFF, C2, "")).status, 400);
      assert.equal((await setPw(STAFF, C2, "   ")).status, 400);
      assert.equal((await setPw(STAFF, C2, 123 as unknown)).status, 400, "密码不是字符串当没填");
      assert.equal((await setPw(STAFF, C2, "x".repeat(129))).status, 400);
      assert.equal((await setPw(STAFF, C2, "x".repeat(128))).status, 200, "128 位正好可以");
      assert.equal((await setPw(STAFF, "NOBODY", "x")).status, 404);
      const c2Before = await hashOf(C2);
      assert.equal((await setPw(CLIENT, C2, "y")).status, 403, "客户不能给别人重置");
      assert.equal((await setPw(AGENT, C2, "y")).status, 403, "代理不能用这条（代理名下的客户找超管）");
      assert.equal(await hashOf(C2), c2Before);
    });

    await check("K3 查和写之间这个号被改成员工号：写的时候再核一次 → 409，密码一个字没动", async () => {
      const { PrismaClient } = await import("@prisma/client");
      const locker = new PrismaClient();
      try {
        const before = await hashOf(C2);
        let locked!: () => void, release!: () => void;
        const isLocked = new Promise<void>((r) => { locked = r; });
        const gate = new Promise<void>((r) => { release = r; });
        // 另一条连接：把这一行锁住并改成员工号，先不提交；重置请求查到它还是客户号，写的时候卡在锁上；放锁后它看到的已经是员工号
        const other = locker.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`UPDATE users SET role = 'staff' WHERE id = '${C2}'`);
          locked();
          await gate;
        }, { timeout: 30000, maxWait: 10000 });
        await isLocked;
        const req = setPw(STAFF, C2, "racy");
        let waiting = 0;
        for (let i = 0; i < 100 && waiting === 0; i++) {
          await new Promise((r) => setTimeout(r, 50));
          waiting = Number((await locker.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%users%'`))[0].n);
        }
        assert.ok(waiting > 0, "前提：重置请求没卡在锁上，这一项没测到「查和写之间」");
        release();
        await other;
        const r = await req;
        assert.equal(r.status, 409, `${r.status} ${r.message}`);
        assert.equal(await hashOf(C2), before, "已经是员工号了，密码被改了");
      } finally {
        await pm.user.update({ where: { id: C2 }, data: { role: "client" } });
        await locker.$disconnect();
      }
    });

    let W: { shipmentId: string; orderId: string };
    await check("W1 员工改运单（同超管那条 /admin/orders/update）：只改备注、改产品行都存得上；带打开时的版本；别人先存了 409 什么都不写", async () => {
      W = await makeOrder("ZZPERM-W1");
      const o0 = await pm.order.findUnique({ where: { id: W.orderId } });
      const ps = await pm.orderProduct.findMany({ where: { orderId: W.orderId }, orderBy: { sortOrder: "asc" } });
      // 只改备注（带版本）
      const r1 = await must("POST /admin/orders/update", STAFF, { orderId: W.shipmentId, expectedOrderUpdatedAt: o0.updatedAt.toISOString(), remark: "员工改的备注" });
      const s1 = await pm.shipment.findUnique({ where: { id: W.shipmentId } });
      assert.equal(s1.remark, "员工改的备注");
      // 改第 1 款件数（产品行整组带回去）
      const products = ps.map((p: Row, i: number) => ({ id: p.id, itemName: p.itemName, packageCount: i === 0 ? 4 : p.packageCount, lengthCm: p.lengthCm, widthCm: p.widthCm, heightCm: p.heightCm, productQuantity: p.productQuantity, weightKg: p.weightKg, cargoType: p.cargoType, domesticTrackingNo: p.domesticTrackingNo }));
      const r2 = await must("POST /admin/orders/update", STAFF, { orderId: W.shipmentId, expectedOrderUpdatedAt: r1.updatedAt, products, packageCount: 7, itemName: "鞋" });
      const ps2 = await pm.orderProduct.findMany({ where: { orderId: W.orderId }, orderBy: { sortOrder: "asc" } });
      assert.deepEqual(ps2.map((p: Row) => p.packageCount), [4, 3]);
      // 拿旧版本再存：409，一个字没写
      const stale = await call("POST /admin/orders/update", STAFF2, { orderId: W.shipmentId, expectedOrderUpdatedAt: r1.updatedAt, remark: "拿旧版本存的" });
      assert.equal(stale.status, 409, stale.message);
      assert.match(stale.message, /刚刚被别人改过（「运单管理」里或别的同事）/, "员工也会看到这句：不能再写「超管端…别的超管」");
      assert.equal((await pm.shipment.findUnique({ where: { id: W.shipmentId } })).remark, "员工改的备注");
      assert.ok(r2.updatedAt);
      // 员工页的编辑框拿 /staff/shipments 那一条建表单（WaybillEditDialog 的 waybillEditStateOf）：行号、订单版本、整票数都要对得上，不然存不上 / 会删行
      // 路径放变量里动态取：WaybillEditDialog 是 .tsx，测试脚本那份 tsconfig 没开 jsx（同 test-review-1018-source S10）
      const dialogPath = "../apps/web/src/modules/orders/WaybillEditDialog";
      const { waybillEditStateOf } = (await import(dialogPath)) as { waybillEditStateOf: (o: Row) => { form: Row; products: Row[]; snapshot: Row } };
      const list = await must("GET /staff/shipments", STAFF, {}, { pageSize: "500" });
      const row = list.items.find((x: Row) => x.id === W.shipmentId);
      assert.ok(row, "员工列表里找不到这张");
      const st = waybillEditStateOf(row);
      const o2 = await pm.order.findUnique({ where: { id: W.orderId } });
      assert.equal(st.snapshot.orderUpdatedAt, o2.updatedAt.toISOString(), "订单版本要跟库里一样（不然一存就 409）");
      assert.deepEqual(st.products.map((p) => [p.id, p.packageCount]), ps2.map((p: Row) => [p.id, String(p.packageCount)]), "产品行号要跟库里一一对应（不然存的时候会把行删了重建）");
      assert.equal(st.form.remark, "员工改的备注");
      assert.equal(st.form.weightKg, String(Number(o2.weightKg)), "整票重量预填要是订单整票的");
    });

    await check("W2 员工改运单的闸跟超管一样：换成封禁的唛头拦（「账号已封禁」）、待入库的拦；客户 / 代理 403", async () => {
      const ban = await call("POST /admin/orders/update", STAFF, { orderId: W.shipmentId, clientId: CBAN });
      assert.notEqual(ban.status, 200, "换成封禁的唛头被放过去了");
      assert.match(ban.message, /封禁/);
      assert.equal((await pm.order.findUnique({ where: { id: W.orderId } })).clientId, C1);
      // 待入库：到货通知转待入库建出来的单，运单管理那边不许改
      const n = (await must("POST /staff/arrival-notices/save", STAFF, { clientId: C2, trackingNo: "ZZPERM-IN1" })).item;
      const inbound = (await must("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "inbound" })).item;
      const pend = await call("POST /admin/orders/update", STAFF, { orderId: inbound.shipmentId, remark: "改待入库的" });
      assert.notEqual(pend.status, 200, "员工能在运单管理改待入库的单了（资料该在到货通知里补）");
      for (const who of [CLIENT, AGENT]) {
        assert.equal((await call("POST /admin/orders/update", who, { orderId: W.shipmentId, remark: "x" })).status, 403, `${who.role} 能改运单了`);
      }
    });

    await check("W3 别的超管专属的照旧：员工删运单 403、员工页旧的「保存订单信息」（patch-shipment-bundle）员工 403", async () => {
      const del = await call("POST /admin/orders/delete", STAFF, { orderId: W.orderId });
      assert.equal(del.status, 403, del.message);
      assert.ok(await pm.order.findUnique({ where: { id: W.orderId } }), "员工把运单删了");
      const bundle = await call("POST /staff/orders/patch-shipment-bundle", STAFF, { shipmentId: W.shipmentId, trackingNo: "ZZPERM-W1", itemName: "鞋", productQuantity: 0, packageCount: 7 });
      assert.equal(bundle.status, 403, bundle.message);
    });

    await check("W4 到货通知里改已转正式运单：员工也能走完 —— 卡片给「修改」、读运单现在的样子、存上、卡片对齐", async () => {
      const n = (await must("POST /staff/arrival-notices/save", STAFF, {
        clientId: C2, trackingNo: "ZZPERM-AN1", transportMode: "sea", warehouseId: "wh_yiwu_01", arrivedAt: "2026-10-19", remark: "到货备注",
        products: [{ itemName: "杯子", packageCount: 3, lengthCm: 30, widthCm: 30, heightCm: 30, productQuantity: null, weightKg: 2, cargoType: "normal", domesticTrackingNo: "JD1" }],
      })).item;
      const formal = (await must("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "formal" })).item;
      assert.equal(formal.canEditConverted, true, "员工那份卡片要给「修改」");
      const d = await must("GET /staff/arrival-notices/converted-detail", STAFF, {}, { id: n.id, v: "2" });
      await must("POST /admin/orders/update", STAFF, {
        orderId: d.shipmentId, expectedOrderUpdatedAt: d.orderUpdatedAt,
        products: [{ id: d.productIds[0], itemName: "杯子", packageCount: 5, lengthCm: 30, widthCm: 30, heightCm: 30, weightKg: 2, cargoType: "normal", domesticTrackingNo: "JD1" }],
        packageCount: 5, itemName: "杯子",
      });
      const card = (await must("POST /staff/arrival-notices/converted-refresh", STAFF, { id: n.id })).item;
      assert.equal(card.products[0].packageCount, 5, "卡片要跟着运单变");
      assert.equal(card.remark, "到货备注", "没改备注就不动");
    });
  } finally {
    await cleanup();
    await prisma.$disconnect();
    fs.rmSync(imagesDir, { recursive: true, force: true });
  }
  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
