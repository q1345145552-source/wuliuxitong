/**
 * 2026-10-08 模拟数据测试（接近生产规模的模拟库 + 多人同时操作）查出来的问题 —— 连库回归（真 handler + 真 PostgreSQL）。
 *
 * 每一项在修之前的代码上都会失败（修之前实测过一遍，见每项注释里的「旧代码」）：
 *   S1  到货通知搜索 % _ 按字面算（旧：搜「_」「%」几乎全出来，「F_Y」把 FXY 也搜出来）
 *   S2  到货通知按卡片上显示的号搜（旧：运单改过号的老数据，按卡片上的号搜不到 / 搜出另一张）
 *   S3  员工建单用到货通知登记着的号被挡；同号同时建单不 500（旧：200 建成，那条到货通知从此转不了；并发一方 500）
 *   S4  员工端改单带着打开时的剩余件数，期间有人装柜就拦（旧：200，订单件数凭空多出装走的那几件）
 *   S5  删运单和装柜同时操作同一张单不死锁、不把 Prisma 原文给员工（旧：30 次里约 12 次 40P01）
 *   S6  两张单同时改成同一个新号（超管 / 员工两条路）、两人同时新建装柜：输的一方是人话不是 500（旧：500）
 *   S7  删单那一刻有人在看运单列表：/staff/shipments、/admin/orders 不 500（旧：Field order is required … got null）
 *   S8  超管改单时订单刚被删：409 人话，不是 500 P2025（旧：500）
 *   S9  删运单把产品图文件一起删（旧：文件留在盘上）
 *   S10 运单列表 updatedAt 并列时翻页不重不漏（排序带 id 兜底）
 *   S11 客服「选运单」标题按全部产品名，按第二个产品名也搜得到（旧：只有第一个产品名，搜不到）
 *   —— 第 2 轮（复核确认的问题修完以后补的）——
 *   S12 改号和装柜同时做：装柜醒来发现号变了就不装（旧：200，子单挂在旧号下面成孤儿，父单件数被扣）
 *   S13 装柜时拆出来的子单号被一张普通运单占着：400 人话（旧：500 Unique constraint）
 *   S14 已转、运单还在、只是存的号没跟上的到货通知，不挡员工建单 / 不挡没有自己到货通知的运单改号（旧：400，提示的事一件都做不了）
 *   S15 删单的同时有人卸柜：删单 404 人话，不是 500（旧：500 Record to delete does not exist）
 *   S16 到货通知搜索命中 3.3 万条已转通知：不 500（旧：too many bind variables → 500）
 *   —— 第 3 轮（第 2 轮修完复核确认的 4 条）——
 *   S17 用「老到货通知还占着的旧号」建单 / 改号以后，老通知那张运单再被删：老通知回到「没转」时显示它自己运单的号、能转
 *       （旧：显示旧号 T、转正式 400「运单号 T 已经有运单了」—— T 是刚建的那张别人的运单）
 *   S18 整柜新建 / 修改的提单号被一条没转的到货通知登记着：挡（旧：200，那条到货通知从此转不了）
 *   S19 整柜「删 / 改」时柜子刚被别人删掉：404「这个整柜刚刚已经被别人删掉了」（旧：404「运单不存在…：s_fcl_xxx」）
 *   S20 删柜的同时有人把柜里那张单删了：删柜照样 200（旧：第 2 轮改出来的回归，404「运单 X-1 已经不存在了」、要再点一次）
 *
 * 只连测试库：DATABASE_URL 不带 neon.tech 的不跑（一次性 docker 库设 AGENT_PORTAL_TEST_ALLOW_DB=1）；
 * 没有 DATABASE_URL 打印「跳过」。测试数据全在假公司 zz_simfix_co 下，开跑前、跑完后都清干净。
 * ⚠️ S7 / S8 会对 orders 表 / 订单行加锁卡住别的请求，只能在一次性库上跑。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Row = Record<string, any>;
type Auth = { userId: string; companyId: string; role: string; name: string; agentId: string | null };
const CO = "zz_simfix_co";
const ADMIN: Auth = { userId: "zz_simfix_admin", companyId: CO, role: "admin", name: "超管", agentId: null };
const ADMIN2: Auth = { userId: "zz_simfix_admin2", companyId: CO, role: "admin", name: "超管二", agentId: null };
const STAFF: Auth = { userId: "zz_simfix_staff", companyId: CO, role: "staff", name: "员工甲", agentId: null };
const STAFF2: Auth = { userId: "zz_simfix_staff2", companyId: CO, role: "staff", name: "员工乙", agentId: null };
const CLIENT: Auth = { userId: "ZZSFA01", companyId: CO, role: "client", name: "客户甲", agentId: null };
const CLIENT_B: Auth = { userId: "ZZSFB02", companyId: CO, role: "client", name: "客户乙", agentId: null };
const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const NO = (s: string) => `ZZSF${s}`;
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) { console.log("⚠️ 跳过：没有 DATABASE_URL（CI 没有数据库）—— 这一项等于没测"); return; }
  if (!url.includes("neon.tech") && process.env.AGENT_PORTAL_TEST_ALLOW_DB !== "1") {
    console.log("⚠️ 跳过：DATABASE_URL 不是 Neon 测试库，怕连到生产库不跑（确认是测试库可设 AGENT_PORTAL_TEST_ALLOW_DB=1）—— 这一项等于没测");
    return;
  }
  process.env.NODE_ENV = process.env.NODE_ENV || "test";
  const imagesDir = fs.mkdtempSync(path.join(os.tmpdir(), "zz-simfix-img-"));
  process.env.IMAGES_DIR = imagesDir;

  const { prisma } = await import("../apps/api/src/db/prisma");
  const { BusinessError } = await import("../apps/api/src/modules/core/business-error");
  const pm: any = prisma;

  const routes = new Map<string, Function>();
  const app: any = {};
  for (const m of ["get", "post", "put", "patch", "delete"]) app[m] = (p: string, h: Function) => routes.set(`${m.toUpperCase()} ${p}`, h);
  (await import("../apps/api/src/modules/arrival-notices/routes")).registerArrivalNoticeRoutes(app);
  (await import("../apps/api/src/modules/orders/routes")).registerOrderRoutes(app);
  (await import("../apps/api/src/modules/admin/routes")).registerAdminRoutes(app);
  (await import("../apps/api/src/modules/loading-manifests/routes")).registerLoadingManifestRoutes(app);
  (await import("../apps/api/src/modules/shipments/routes")).registerShipmentRoutes(app);
  (await import("../apps/api/src/modules/cs-chat/routes")).registerCsChatRoutes(app);
  (await import("../apps/api/src/modules/fcl-containers/routes")).registerFclContainerRoutes(app);
  (await import("../apps/api/src/modules/containers/routes")).registerContainerRoutes(app);

  /** 跟 server.ts 一样：BusinessError 按它的状态码回；别的异常 = 线上的 500（这里记成 status 500，不往外抛，方便数次数） */
  async function call(key: string, auth: Auth, body: Row = {}, query: Record<string, string> = {}): Promise<{ status: number; data: any; message: string }> {
    const handler = routes.get(key);
    if (!handler) return { status: 404, data: undefined, message: `没有这个接口：${key}` };
    let status = 200; let raw: any;
    const res: any = { status(s: number) { status = s; return res; }, json(p: any) { raw = p; }, setHeader() {} };
    try { await handler({ method: key.split(" ")[0], body, query, headers: {}, auth, path: key.split(" ")[1] }, res); }
    catch (e: any) {
      if (e instanceof BusinessError) { status = e.httpStatus; raw = { code: e.code, message: e.message }; }
      else { status = 500; raw = { code: "INTERNAL_ERROR", message: String(e?.message ?? e) }; }
    }
    return { status, data: raw?.data, message: raw?.message ?? "" };
  }
  async function must(key: string, auth: Auth, body: Row = {}, query: Record<string, string> = {}): Promise<any> {
    const r = await call(key, auth, body, query);
    assert.equal(r.status, 200, `${key} 应该成功，实际 ${r.status}：${r.message}`);
    return r.data;
  }
  const saveNotice = (body: Row) => must("POST /staff/arrival-notices/save", STAFF, body).then((d) => d.item);
  const searchNotices = (keyword: string) => must("GET /staff/arrival-notices/list", STAFF, {}, { keyword, pageSize: "200" });
  const orderBody = (trackingNo: string, extra: Row = {}) => ({
    clientId: CLIENT.userId, trackingNo, itemName: "灯具", packageCount: 10, weightKg: 100, volumeM3: 1,
    transportMode: "sea", warehouseId: "wh_yiwu_01", arrivedAt: "2026-10-08", ...extra,
  });
  async function newOrder(trackingNo: string, extra: Row = {}): Promise<{ orderId: string; shipmentId: string }> {
    const d = await must("POST /staff/orders", STAFF, orderBody(trackingNo, extra));
    const s = await pm.shipment.findFirst({ where: { trackingNo }, select: { id: true } });
    return { orderId: d.orderId, shipmentId: s.id };
  }
  async function newContainer(): Promise<string> {
    const d = await must("POST /staff/loading-manifests", STAFF, { warehouse: "wh_yiwu_01", transportMode: "sea" });
    return d.manifest.id;
  }
  /** 有几个连接正卡在锁上（本库） */
  async function lockWaiters(): Promise<number> {
    const r = await pm.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    return r[0].n;
  }
  async function waitForWaiters(n: number): Promise<void> {
    for (let i = 0; i < 200; i++) { if ((await lockWaiters()) >= n) return; await sleepMs(25); }
    throw new Error(`等了 5 秒也没等到 ${n} 个请求卡在锁上`);
  }

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
    await pm.shipment.deleteMany({ where: { companyId: CO, parentTrackingNo: { not: null } } });
    await pm.shipment.deleteMany({ where: { companyId: CO } });
    await pm.order.deleteMany({ where: { companyId: CO } });
    await pm.auditLog.deleteMany({ where: { companyId: CO } });
    await pm.user.deleteMany({ where: { companyId: CO } });
  }

  let passed = 0, failed = 0;
  async function check(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`✅ ${name}`); }
    catch (e: any) { failed++; console.log(`❌ ${name}\n   ${e?.message ?? e}`); }
  }

  await cleanup();
  try {
    for (const u of [ADMIN, ADMIN2, STAFF, STAFF2, CLIENT, CLIENT_B]) {
      await pm.user.create({ data: { id: u.userId, companyId: u.companyId, role: u.role, name: u.name, passwordHash: "x", phone: `0${u.userId}`, status: "active" } });
    }

    await check("S1 到货通知搜索：% 和 _ 按字面算，不当通配符", async () => {
      const a = await saveNotice({ trackingNo: NO("WILDX1") });
      const b = await saveNotice({ trackingNo: NO("F_Y1") });
      const c = await saveNotice({ trackingNo: NO("FXY1") });
      const ids = (l: Row) => l.items.map((x: Row) => x.id).sort();
      assert.deepEqual(ids(await searchNotices("_")), [b.id], "搜「_」只该出来真带下划线的那条（旧：全出来）");
      assert.equal((await searchNotices("%")).total, 0, "搜「%」一条都不该有（旧：全出来）");
      assert.deepEqual(ids(await searchNotices("F_Y")), [b.id], "搜「F_Y」不该把 FXY 也搜出来（旧：_ 当任意一个字）");
      assert.deepEqual(ids(await searchNotices(NO("WILD"))), [a.id], "普通搜索照旧");
      assert.ok(c.id);
    });

    await check("S2 到货通知按卡片上显示的号搜：转出去的运单改过号（迁移跳过的老数据）也搜得到、不串卡", async () => {
      const n1 = await saveNotice({ ...{ clientId: CLIENT.userId, itemName: "灯具", packageCount: 3, weightKg: 9, volumeM3: 0.2, transportMode: "sea", warehouseId: "wh_yiwu_01", arrivedAt: "2026-10-08" }, trackingNo: NO("SWAPA") });
      const n2 = await saveNotice({ ...{ clientId: CLIENT.userId, itemName: "椅子", packageCount: 3, weightKg: 9, volumeM3: 0.2, transportMode: "sea", warehouseId: "wh_yiwu_01", arrivedAt: "2026-10-08" }, trackingNo: NO("SWAPB") });
      await must("POST /staff/arrival-notices/convert", STAFF, { id: n1.id, to: "formal" });
      await must("POST /staff/arrival-notices/convert", STAFF, { id: n2.id, to: "formal" });
      // 造老数据：两张运单直接在库里互换号，到货通知存的号不跟（同生产上迁移跳过的「互换」形状）
      const s1 = await pm.shipment.findFirst({ where: { trackingNo: NO("SWAPA") } });
      const s2 = await pm.shipment.findFirst({ where: { trackingNo: NO("SWAPB") } });
      await pm.shipment.update({ where: { id: s1.id }, data: { trackingNo: NO("SWAPTMP") } });
      await pm.shipment.update({ where: { id: s2.id }, data: { trackingNo: NO("SWAPA") } });
      await pm.shipment.update({ where: { id: s1.id }, data: { trackingNo: NO("SWAPB") } });
      const hit = await searchNotices(NO("SWAPB"));
      assert.deepEqual(hit.items.map((x: Row) => x.trackingNo), [NO("SWAPB")], "按 SWAPB 搜，出来的卡片上就该写 SWAPB（旧：出来的是写着 SWAPA 的那张）");
      assert.equal(hit.items[0].id, n1.id);
      const hitA = await searchNotices(NO("SWAPA"));
      assert.deepEqual(hitA.items.map((x: Row) => x.id), [n2.id]);
      // 没转的照旧按自己存的号搜
      const n3 = await saveNotice({ trackingNo: NO("HOLD1") });
      assert.deepEqual((await searchNotices(NO("HOLD1"))).items.map((x: Row) => x.id), [n3.id]);
    });

    await check("S3 员工建单：号被一条没转的到货通知登记着就挡；那条之后照样能转", async () => {
      const n = await saveNotice({ trackingNo: NO("HELD1"), clientId: CLIENT_B.userId, itemName: "灯具", packageCount: 2, weightKg: 5, volumeM3: 0.1, transportMode: "sea", warehouseId: "wh_yiwu_01", arrivedAt: "2026-10-08" });
      const r = await call("POST /staff/orders", STAFF2, orderBody(NO("HELD1")));
      assert.equal(r.status, 400, `应该被挡，实际 ${r.status}：${r.message}（旧：200 建成了）`);
      assert.match(r.message, /已经登记在「到货通知」里了.*本次没有建单/);
      assert.equal(await pm.shipment.count({ where: { trackingNo: NO("HELD1") } }), 0, "不该建出运单");
      await must("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "formal" });
      assert.equal(await pm.shipment.count({ where: { trackingNo: NO("HELD1") } }), 1);
    });

    await check("S3b 同一个号两人同时建单（双击 / 批量导入重复）：一个成、一个 409 人话，不 500", async () => {
      for (let i = 0; i < 6; i++) {
        const no = NO(`DUP${i}`);
        const rs = await Promise.all([call("POST /staff/orders", STAFF, orderBody(no)), call("POST /staff/orders", STAFF2, orderBody(no))]);
        const st = rs.map((r) => r.status).sort();
        assert.deepEqual(st, [200, 409], `第 ${i} 次：${rs.map((r) => `${r.status} ${r.message}`).join(" / ")}（旧：一方 500 Unique constraint）`);
        assert.equal(await pm.shipment.count({ where: { trackingNo: no } }), 1);
      }
    });

    await check("S4 员工端改单：打开编辑框以后有人装柜，带着旧剩余数保存被拦，订单件数不凭空变多", async () => {
      const { orderId, shipmentId } = await newOrder(NO("EDIT1"));
      const ctr = await newContainer();
      const base = 10; // 打开编辑框时看到的剩余件数
      await must("POST /staff/loading-manifests/add-shipment", STAFF, { trackingNo: NO("EDIT1"), pieceCount: 2 }, { id: ctr });
      const patch = (packageCount: number, basePackageCount: number) => call("POST /staff/orders/patch-shipment-bundle", ADMIN, {
        shipmentId, trackingNo: NO("EDIT1"), itemName: "灯具", productQuantity: 0, packageCount, basePackageCount, packageUnit: "box",
        weightKg: 100, volumeM3: 1, orderCreatedDate: "2026-10-08", transportMode: "sea", receiverAddressTh: "", warehouseId: "wh_yiwu_01", remark: "只改备注",
      });
      const stale = await patch(base, base);
      assert.equal(stale.status, 409, `应该拦下，实际 ${stale.status}：${stale.message}（旧：200）`);
      assert.match(stale.message, /刚刚有人装柜或卸柜.*从 10 变成 8/);
      const o = await pm.order.findUnique({ where: { id: orderId }, select: { packageCount: true } });
      assert.equal(o.packageCount, 10, "订单整票件数不该变（旧：变成 12）");
      // 刷新后（剩余 8）再存：正常
      await must("POST /staff/orders/patch-shipment-bundle", ADMIN, {
        shipmentId, trackingNo: NO("EDIT1"), itemName: "灯具", productQuantity: 0, packageCount: 8, basePackageCount: 8, packageUnit: "box",
        weightKg: 80, volumeM3: 0.8, orderCreatedDate: "2026-10-08", transportMode: "sea", receiverAddressTh: "", warehouseId: "wh_yiwu_01",
      });
      assert.equal((await pm.order.findUnique({ where: { id: orderId }, select: { packageCount: true } })).packageCount, 10);
    });

    await check("S5 删运单和装柜同时操作同一张单：不死锁、不 500、不把 Prisma 原文给员工", async () => {
      const ctr = await newContainer();
      const bad: string[] = [];
      for (let i = 0; i < 20; i++) {
        const no = NO(`DL${i}`);
        const { orderId } = await newOrder(no);
        const [del, load] = await Promise.all([
          call("POST /admin/orders/delete", ADMIN, { orderId }),
          (async () => { await sleepMs(i % 4); return call("POST /staff/loading-manifests/add-shipment", STAFF, { trackingNo: no, pieceCount: 3 }, { id: ctr }); })(),
        ]);
        for (const r of [del, load]) {
          if (r.status >= 500 || /deadlock|40P01|ConnectorError|Raw query failed/i.test(r.message)) bad.push(`第 ${i} 次 ${r.status}：${r.message.slice(0, 120)}`);
        }
      }
      assert.deepEqual(bad, [], "旧代码 30 次约 12 次死锁");
    });

    await check("S6a 两张单同时改成同一个新号（超管 /admin/orders/update）：一个成、一个 400 人话", async () => {
      for (let i = 0; i < 5; i++) {
        const a = await newOrder(NO(`RNA${i}`));
        const b = await newOrder(NO(`RNB${i}`));
        const target = NO(`RNT${i}`);
        const rs = await Promise.all([
          call("POST /admin/orders/update", ADMIN, { orderId: a.orderId, trackingNo: target }),
          call("POST /admin/orders/update", ADMIN2, { orderId: b.orderId, trackingNo: target }),
        ]);
        assert.deepEqual(rs.map((r) => r.status).sort(), [200, 400], `第 ${i} 次：${rs.map((r) => `${r.status} ${r.message.slice(0, 100)}`).join(" / ")}（旧：一方 500）`);
        assert.ok(rs.some((r) => /already exists/.test(r.message)));
      }
    });

    await check("S6b 两张单同时改成同一个新号（员工端 patch-shipment-bundle）：一个成、一个 400 人话", async () => {
      for (let i = 0; i < 5; i++) {
        const a = await newOrder(NO(`SRA${i}`));
        const b = await newOrder(NO(`SRB${i}`));
        const target = NO(`SRT${i}`);
        const body = (shipmentId: string) => ({
          shipmentId, trackingNo: target, itemName: "灯具", productQuantity: 0, packageCount: 10, packageUnit: "box",
          weightKg: 100, volumeM3: 1, orderCreatedDate: "2026-10-08", transportMode: "sea", receiverAddressTh: "", warehouseId: "wh_yiwu_01",
        });
        const rs = await Promise.all([
          call("POST /staff/orders/patch-shipment-bundle", ADMIN, body(a.shipmentId)),
          call("POST /staff/orders/patch-shipment-bundle", ADMIN2, body(b.shipmentId)),
        ]);
        assert.deepEqual(rs.map((r) => r.status).sort(), [200, 400], `第 ${i} 次：${rs.map((r) => `${r.status} ${r.message.slice(0, 100)}`).join(" / ")}（旧：一方 500）`);
      }
    });

    await check("S6c 两人同时点「新建装柜」（自动取号）：两个都建成、号不一样", async () => {
      for (let i = 0; i < 5; i++) {
        const rs = await Promise.all([
          call("POST /staff/loading-manifests", STAFF, { warehouse: "wh_yiwu_01", transportMode: "sea" }),
          call("POST /staff/loading-manifests", STAFF2, { warehouse: "wh_yiwu_01", transportMode: "sea" }),
        ]);
        assert.deepEqual(rs.map((r) => r.status), [200, 200], `第 ${i} 次：${rs.map((r) => `${r.status} ${r.message.slice(0, 100)}`).join(" / ")}（旧：一方 500）`);
        assert.notEqual(rs[0].data.manifest.manifestNo, rs[1].data.manifest.manifestNo);
      }
    });

    /** 卡住 orders 表 → 让列表的「查订单」那一句排队 → 趁它排队删掉一张单并提交 → 看列表 */
    async function listDuringDelete(key: string, auth: Auth): Promise<{ status: number; message: string }> {
      const { orderId, shipmentId } = await newOrder(NO(`LD${key.length}${Date.now() % 100000}`));
      let result: { status: number; message: string } | null = null;
      await pm.$transaction(async (tx: any) => {
        await tx.$executeRawUnsafe("LOCK TABLE orders IN ACCESS EXCLUSIVE MODE");
        const before = await lockWaiters();
        const pending = call(key, auth, {}, { pageSize: "500" }).then((r) => { result = r; });
        await waitForWaiters(before + 1);
        await tx.statusLog.deleteMany({ where: { shipmentId } });
        await tx.shipment.delete({ where: { id: shipmentId } });
        await tx.order.delete({ where: { id: orderId } });
        void pending; // 提交以后它才继续，下面等它回来
      }, { timeout: 20000, maxWait: 10000 });
      for (let i = 0; i < 200 && !result; i++) await sleepMs(25);
      assert.ok(result, "列表请求没回来");
      return result!;
    }

    await check("S7 删单那一刻有人在看运单列表：/staff/shipments 不 500", async () => {
      const r = await listDuringDelete("GET /staff/shipments", STAFF);
      assert.equal(r.status, 200, `实际 ${r.status}：${r.message.slice(0, 160)}（旧：Field order is required … got null）`);
    });

    await check("S7b 同上：/admin/orders 不 500", async () => {
      const r = await listDuringDelete("GET /admin/orders", ADMIN);
      assert.equal(r.status, 200, `实际 ${r.status}：${r.message.slice(0, 160)}`);
    });

    await check("S8 超管改单的同时另一个超管把单删了：改单回 409「刚刚已经被删掉了」，不是 500", async () => {
      const { orderId } = await newOrder(NO("UPDEL1"));
      let del: any; let upd: any;
      await pm.$transaction(async (tx: any) => {
        await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`;
        const before = await lockWaiters();
        const pDel = call("POST /admin/orders/delete", ADMIN, { orderId }).then((r) => { del = r; });
        await waitForWaiters(before + 1);
        const pUpd = call("POST /admin/orders/update", ADMIN2, { orderId, itemName: "改个品名" }).then((r) => { upd = r; });
        await waitForWaiters(before + 2);
        void pDel; void pUpd;
      }, { timeout: 20000, maxWait: 10000 });
      for (let i = 0; i < 200 && (!del || !upd); i++) await sleepMs(25);
      assert.equal(del?.status, 200, `删单：${del?.status} ${del?.message}`);
      assert.equal(upd?.status, 409, `改单应该 409，实际 ${upd?.status}：${upd?.message}（旧：500 Record to update not found）`);
      assert.match(upd.message, /刚刚已经被删掉了/);
    });

    await check("S9 删运单把产品图文件一起删", async () => {
      const { orderId } = await newOrder(NO("IMG1"));
      await must("POST /staff/orders/product-images", STAFF, { orderId, fileName: "a.png", mime: "image/png", contentBase64: PNG_1x1 });
      const img = await pm.orderProductImage.findFirst({ where: { orderId }, select: { filePath: true } });
      const full = path.join(imagesDir, path.basename(img.filePath));
      assert.ok(fs.existsSync(full), "上传后文件应该在");
      await must("POST /admin/orders/delete", ADMIN, { orderId });
      assert.ok(!fs.existsSync(full), "删单后文件应该删掉（旧：文件留在盘上）");
    });

    await check("S10 运单列表 updatedAt 并列时翻页：每张父单正好出现一次（排序带 id 兜底）", async () => {
      for (let i = 0; i < 24; i++) await newOrder(NO(`TIE${String(i).padStart(2, "0")}`));
      const tie = new Date("2026-10-08T05:12:29.568Z");
      await pm.shipment.updateMany({ where: { companyId: CO }, data: { updatedAt: tie } });
      for (const [key, auth] of [["GET /staff/shipments", STAFF], ["GET /admin/orders", ADMIN]] as const) {
        const all = await must(key, auth, {}, { pageSize: "500" });
        const seen: string[] = [];
        for (let page = 1; page <= Math.ceil(all.total / 5); page++) {
          const d = await must(key, auth, {}, { page: String(page), pageSize: "5" });
          seen.push(...d.items.map((x: Row) => x.id));
        }
        assert.equal(seen.length, all.total);
        assert.equal(new Set(seen).size, all.total, `${key} 翻页有重复 / 漏掉`);
      }
    });

    await check("S11 客服「选运单」：标题是全部产品名，按第二个产品名也搜得到", async () => {
      await must("POST /staff/orders", STAFF, orderBody(NO("MULTI1"), {
        itemName: undefined,
        products: [
          { itemName: "电饭煲", packageCount: 2, productQuantity: 1, cargoType: "normal" },
          { itemName: "水管配件", packageCount: 3, productQuantity: 1, cargoType: "normal" },
        ],
      }));
      const all = await must("GET /staff/chat/refs", STAFF, {}, { clientId: CLIENT.userId });
      const row = all.shipments.find((s: Row) => s.no === NO("MULTI1"));
      assert.ok(row, "选运单里应该有这张");
      assert.equal(row.title, "电饭煲 / 水管配件", `实际：${row.title}（旧：只有「电饭煲」）`);
      const hit = await must("GET /staff/chat/refs", STAFF, {}, { clientId: CLIENT.userId, q: "水管配件" });
      assert.ok(hit.shipments.some((s: Row) => s.no === NO("MULTI1")), "按第二个产品名搜不到（旧：只比订单 itemName）");
    });
    await check("S12 改号和装柜同时做：装柜等锁期间号被改了，装柜不装、不留孤儿子单（旧：200 + 子单挂旧号）", async () => {
      const oldNo = NO("RACEL1"), newNo = NO("RACEL1N");
      const { orderId, shipmentId } = await newOrder(oldNo);
      const ctr = await newContainer();
      let load: any;
      await pm.$transaction(async (tx: any) => {
        await tx.$queryRaw`SELECT id FROM shipments WHERE id = ${shipmentId} FOR UPDATE`;
        const before = await lockWaiters();
        const p = call("POST /staff/loading-manifests/add-shipment", STAFF, { trackingNo: oldNo, pieceCount: 4 }, { id: ctr }).then((r) => { load = r; });
        await waitForWaiters(before + 1); // 装柜已经按旧号读到这张单、卡在运单锁上
        await tx.shipment.update({ where: { id: shipmentId }, data: { trackingNo: newNo } }); // 同事改号，先提交
        void p;
      }, { timeout: 20000, maxWait: 10000 });
      for (let i = 0; i < 200 && !load; i++) await sleepMs(25);
      assert.equal(load?.status, 400, `装柜应该被拦，实际 ${load?.status}：${load?.message}（旧：200）`);
      assert.match(load.message, new RegExp(`刚刚被改了单号（现在是 ${newNo}）`));
      assert.equal(await pm.shipment.count({ where: { companyId: CO, parentTrackingNo: oldNo } }), 0, "不该有挂在旧号下面的子单（旧：有一张 -1）");
      const parent = await pm.shipment.findUnique({ where: { id: shipmentId }, select: { packageCount: true } });
      assert.equal(parent.packageCount, 10, "父单件数不该被扣（旧：剩 6）");
      // 按新号重装：正常，子单挂在新号下面
      await must("POST /staff/loading-manifests/add-shipment", STAFF, { trackingNo: newNo, pieceCount: 4 }, { id: ctr });
      const child = await pm.shipment.findFirst({ where: { companyId: CO, parentTrackingNo: newNo }, select: { trackingNo: true, orderId: true } });
      assert.equal(child?.trackingNo, `${newNo}-1`);
      assert.equal(child?.orderId, orderId);
    });

    await check("S13 拆出来的子单号被一张普通运单占着：400 说清是哪个号，不是 500（旧：500 Unique constraint）", async () => {
      const x = NO("CHILDX");
      await newOrder(x);
      await newOrder(`${x}-1`);
      const ctr = await newContainer();
      const r = await call("POST /staff/loading-manifests/add-shipment", STAFF, { trackingNo: x, pieceCount: 3 }, { id: ctr });
      assert.equal(r.status, 400, `实际 ${r.status}：${r.message.slice(0, 160)}（旧：500）`);
      assert.match(r.message, new RegExp(`子单号 ${x}-1 已经被另一张运单占用了`));
      assert.equal((await pm.shipment.findFirst({ where: { trackingNo: x }, select: { packageCount: true } })).packageCount, 10, "父单件数不该动");
      assert.equal(await pm.shipmentContainerItem.count({ where: { containerId: ctr } }), 0);
    });

    await check("S14 已转、运单还在、存的号没跟上的到货通知：不挡建单、不挡没有自己到货通知的运单改号（旧：400 死路）", async () => {
      const full = { clientId: CLIENT.userId, itemName: "灯具", packageCount: 3, weightKg: 9, volumeM3: 0.2, transportMode: "sea", warehouseId: "wh_yiwu_01", arrivedAt: "2026-10-08" };
      // 造三条迁移跳过的老数据：转成运单以后运单直接在库里改了号，到货通知存的还是旧号
      const stale: Array<{ notice: Row; old: string; cur: string }> = [];
      for (const k of ["STALE1", "STALE2", "STALE3"]) {
        const n = await saveNotice({ ...full, trackingNo: NO(k) });
        await must("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "formal" });
        await pm.shipment.updateMany({ where: { trackingNo: NO(k) }, data: { trackingNo: NO(`${k}N`) } });
        stale.push({ notice: n, old: NO(k), cur: NO(`${k}N`) });
      }
      // ① 建单用旧号：放行
      const c = await call("POST /staff/orders", STAFF, orderBody(stale[0].old));
      assert.equal(c.status, 200, `建单应该成功，实际 ${c.status}：${c.message}（旧：400「已经登记在到货通知里了」）`);
      // ② 一张没有到货通知的普通运单改成旧号：放行（两条改号路）
      const plain = await newOrder(NO("PLAINR1"));
      const u = await call("POST /admin/orders/update", ADMIN, { orderId: plain.orderId, trackingNo: stale[1].old });
      assert.equal(u.status, 200, `超管改号应该成功，实际 ${u.status}：${u.message}（旧：400）`);
      // ③ 被改的运单自己是到货通知转出来的、占号那条又跟不上（它运单现在的号还被另一条没转的到货通知登记着 —— 双重老数据）：
      //   照样挡（不然它的到货通知跟不上新号），但提示说清占着的那条现在对应哪张运单。
      //   （只有一重老数据时，第 3 轮起改号前会先让占号那条跟上，就不挡了，见 S17）
      await pm.$executeRawUnsafe(
        `INSERT INTO arrival_notices (id, company_id, created_by, tracking_no, client_id, updated_at) VALUES ('zzsf_dirty_hold3', '${CO}', '${STAFF.userId}', '${stale[2].cur}', '${CLIENT.userId}', now())`);
      const own = await saveNotice({ ...full, trackingNo: NO("OWNR1") });
      await must("POST /staff/arrival-notices/convert", STAFF, { id: own.id, to: "formal" });
      const ownShip = await pm.shipment.findFirst({ where: { trackingNo: NO("OWNR1") }, select: { orderId: true } });
      const b = await call("POST /admin/orders/update", ADMIN, { orderId: ownShip.orderId, trackingNo: stale[2].old });
      assert.equal(b.status, 400, `应该挡，实际 ${b.status}：${b.message}`);
      assert.match(b.message, new RegExp(`它现在对应的运单是 ${stale[2].cur}`), `提示没说占着的那条现在对应哪张运单：${b.message}`);
    });

    await check("S15 删单的同时有人卸柜：删单回 404 人话，不是 500；再点一次能删掉（旧：500 Record to delete does not exist）", async () => {
      const no = NO("DELUNL1");
      const { orderId, shipmentId } = await newOrder(no);
      const ctr = await newContainer();
      await must("POST /staff/loading-manifests/add-shipment", STAFF, { trackingNo: no, pieceCount: 3 }, { id: ctr });
      const child = await pm.shipment.findFirst({ where: { parentTrackingNo: no }, select: { id: true } });
      const item = await pm.shipmentContainerItem.findFirst({ where: { shipmentId: child.id }, select: { id: true } });
      let unload: any; let del: any;
      await pm.$transaction(async (tx: any) => {
        await tx.$queryRaw`SELECT id FROM shipments WHERE id = ${shipmentId} FOR UPDATE`; // 卡住父单
        const before = await lockWaiters();
        const pU = call("POST /staff/loading-manifests/remove-shipment", STAFF, { itemId: item.id }).then((r) => { unload = r; });
        await waitForWaiters(before + 1); // 卸柜已经锁了柜子和子单，卡在父单上
        const pD = call("POST /admin/orders/delete", ADMIN, { orderId }).then((r) => { del = r; });
        await waitForWaiters(before + 2); // 删单已经锁了订单、读到了子单，卡在子单上
        void pU; void pD;
      }, { timeout: 20000, maxWait: 10000 });
      for (let i = 0; i < 200 && (!unload || !del); i++) await sleepMs(25);
      assert.equal(unload?.status, 200, `卸柜：${unload?.status} ${unload?.message}`);
      assert.equal(del?.status, 404, `删单应该 404，实际 ${del?.status}：${del?.message?.slice(0, 160)}（旧：500）`);
      assert.match(del.message, new RegExp(`运单 ${no}-1 已经不存在了（刚刚被别人卸柜或删掉）`));
      await must("POST /admin/orders/delete", ADMIN, { orderId });
      assert.equal(await pm.order.count({ where: { id: orderId } }), 0);
    });

    await check("S16 到货通知搜索命中 3.3 万条已转通知（运单都还在）：200，不撞绑定参数上限（旧：500 too many bind variables）", async () => {
      const N = 33000;
      try {
        await pm.$executeRawUnsafe(`
          INSERT INTO orders (id, company_id, client_id, warehouse_id, item_name, product_quantity, package_count, package_unit, transport_mode, receiver_name_th, receiver_phone_th, receiver_address_th, updated_at)
          SELECT 'zzbulk_o' || g, '${CO}', '${CLIENT.userId}', 'wh_yiwu_01', '灯具', 0, 1, 'box', 'sea', '', '', '', now() FROM generate_series(1, ${N}) g`);
        await pm.$executeRawUnsafe(`
          INSERT INTO shipments (id, company_id, order_id, tracking_no, current_status, warehouse_id, updated_at)
          SELECT 'zzbulk_s' || g, '${CO}', 'zzbulk_o' || g, 'ZZSFBULK' || g, 'inWarehouseCN', 'wh_yiwu_01', now() FROM generate_series(1, ${N}) g`);
        await pm.$executeRawUnsafe(`
          INSERT INTO arrival_notices (id, company_id, created_by, tracking_no, client_id, converted_to, shipment_id, updated_at)
          SELECT 'zzbulk_n' || g, '${CO}', '${STAFF.userId}', 'ZZSFBULK' || g, '${CLIENT.userId}', 'formal', 'zzbulk_s' || g, now() FROM generate_series(1, ${N}) g`);
        const t0 = Date.now();
        const r = await call("GET /staff/arrival-notices/list", STAFF, {}, { keyword: "ZZSFBULK", pageSize: "50" });
        const ms = Date.now() - t0;
        assert.equal(r.status, 200, `实际 ${r.status}：${r.message.slice(0, 200)}（旧：500 too many bind variables）`);
        assert.equal(r.data.total, N);
        assert.equal(r.data.counts.formal, N);
        console.log(`   （${N} 条命中，用时 ${ms}ms）`);
      } finally {
        await pm.$executeRawUnsafe(`DELETE FROM arrival_notices WHERE company_id = '${CO}' AND id LIKE 'zzbulk\\_n%'`);
        await pm.$executeRawUnsafe(`DELETE FROM shipments WHERE company_id = '${CO}' AND id LIKE 'zzbulk\\_s%'`);
        await pm.$executeRawUnsafe(`DELETE FROM orders WHERE company_id = '${CO}' AND id LIKE 'zzbulk\\_o%'`);
      }
    });
    await check("S17 用老到货通知还占着的旧号建单 / 改号，之后老通知的运单被删：老通知按它自己运单的号回到「没转」、能重转（旧：显示旧号、转不了）", async () => {
      const full = { clientId: CLIENT.userId, itemName: "灯具", packageCount: 3, weightKg: 9, volumeM3: 0.2, transportMode: "sea", warehouseId: "wh_yiwu_01", arrivedAt: "2026-10-08" };
      for (const via of ["create", "rename"] as const) {
        // A 故意不以 T 开头：到货通知搜索是按包含搜的，A=T+"N" 的话按 T 也会搜出它
        const T = NO(`GONE${via === "create" ? "C" : "R"}`), A = NO(`MOVED${via === "create" ? "C" : "R"}`);
        const n = await saveNotice({ ...full, trackingNo: T });
        await must("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "formal" });
        const s = await pm.shipment.findFirst({ where: { trackingNo: T }, select: { id: true, orderId: true } });
        await pm.shipment.update({ where: { id: s.id }, data: { trackingNo: A } }); // 迁移跳过的老数据：运单改过号，通知存的还是 T
        if (via === "create") {
          const c = await call("POST /staff/orders", STAFF2, orderBody(T, { clientId: CLIENT_B.userId }));
          assert.equal(c.status, 200, `建单：${c.status} ${c.message}`);
        } else {
          const plain = await newOrder(NO("GONEPLAIN"));
          const u = await call("POST /admin/orders/update", ADMIN, { orderId: plain.orderId, trackingNo: T });
          assert.equal(u.status, 200, `改号：${u.status} ${u.message}`);
        }
        await must("POST /admin/orders/delete", ADMIN, { orderId: s.orderId }); // 老通知那张运单被删
        const hitT = await searchNotices(T);
        assert.ok(!hitT.items.some((x: Row) => x.id === n.id), `[${via}] 按 T 不该再搜出老通知（旧：搜出来、卡片写 T、提示可重转）`);
        const card = (await searchNotices(A)).items.find((x: Row) => x.id === n.id);
        assert.ok(card, `[${via}] 按它自己运单的号 ${A} 应该搜得到老通知`);
        assert.equal(card.trackingNo, A);
        const conv = await call("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "formal" });
        assert.equal(conv.status, 200, `[${via}] 老通知应该能重转，实际 ${conv.status}：${conv.message}（旧：400「运单号 ${T} 已经有运单了」）`);
        assert.equal(await pm.shipment.count({ where: { trackingNo: A } }), 1);
      }
    });

    const FCL_ROW = { itemName: "鞋", packageCount: 10, quantityPerBox: 20, lengthCm: 60, widthCm: 40, heightCm: 30, unitWeightKg: 2.5, domesticTrackingNo: "SF001", cargoType: "normal" };
    const fclBody = (trackingNo: string, containerNo: string, extra: Row = {}) => ({
      clientId: CLIENT.userId, trackingNo, containerNo, containerType: "40HQ", transportMode: "sea", warehouseId: "wh_yiwu_01",
      loadingDate: "2026-10-05", amountCny: "12000", remark: "", products: [FCL_ROW], ...extra,
    });

    await check("S18 整柜新建 / 修改：提单号被一条没转的到货通知登记着就挡，那条之后照样能转（旧：200，那条从此转不了）", async () => {
      const n1 = await saveNotice({ trackingNo: NO("FCLHELD1"), clientId: CLIENT_B.userId, itemName: "灯具", packageCount: 2, weightKg: 5, volumeM3: 0.1, transportMode: "sea", warehouseId: "wh_yiwu_01", arrivedAt: "2026-10-08" });
      const c = await call("POST /staff/fcl-containers/create", STAFF, fclBody(NO("FCLHELD1"), NO("CTRH1")));
      assert.equal(c.status, 409, `新建整柜应该被挡，实际 ${c.status}：${c.message}（旧：200）`);
      assert.match(c.message, /已经登记在「到货通知」里了/);
      assert.equal(await pm.shipment.count({ where: { trackingNo: NO("FCLHELD1") } }), 0, "不该建出运单");
      await must("POST /staff/arrival-notices/convert", STAFF, { id: n1.id, to: "formal" });

      const n2 = await saveNotice({ trackingNo: NO("FCLHELD2"), clientId: CLIENT_B.userId, itemName: "灯具", packageCount: 2, weightKg: 5, volumeM3: 0.1, transportMode: "sea", warehouseId: "wh_yiwu_01", arrivedAt: "2026-10-08" });
      const made = await must("POST /staff/fcl-containers/create", STAFF, fclBody(NO("FCLBL2"), NO("CTRH2")));
      const u = await call("POST /staff/fcl-containers/update", STAFF, { containerId: made.containerId, ...fclBody(NO("FCLHELD2"), NO("CTRH2")) });
      assert.equal(u.status, 409, `改整柜提单号应该被挡，实际 ${u.status}：${u.message}（旧：200）`);
      assert.match(u.message, /已经登记在「到货通知」里了/);
      assert.equal(await pm.shipment.count({ where: { trackingNo: NO("FCLHELD2") } }), 0, "提单号不该被改过去");
      // 号没变、只改别的：不因为别处的到货通知被挡
      await must("POST /staff/fcl-containers/update", STAFF, { containerId: made.containerId, ...fclBody(NO("FCLBL2"), NO("CTRH2"), { remark: "改个备注" }) });
      await must("POST /staff/arrival-notices/convert", STAFF, { id: n2.id, to: "formal" });
    });

    await check("S19 整柜「删 / 改」时柜子刚被别人删掉：404 说的是整柜被删了，不甩内部 id（旧：「运单不存在…：s_fcl_xxx」）", async () => {
      for (const second of ["delete", "update"] as const) {
        const tag = second === "delete" ? "D" : "U";
        const ctrNo = NO(`CTRG${tag}`), blNo = NO(`FCLG${tag}`);
        const made = await must("POST /staff/fcl-containers/create", STAFF, fclBody(blNo, ctrNo));
        let a: any; let b: any;
        await pm.$transaction(async (tx: any) => {
          await tx.$queryRaw`SELECT id FROM containers WHERE id = ${made.containerId} FOR UPDATE`; // 卡住柜子
          const before = await lockWaiters();
          const pA = call("POST /admin/fcl-containers/delete", ADMIN, { containerId: made.containerId, confirmContainerNo: ctrNo }).then((r) => { a = r; });
          await waitForWaiters(before + 1); // 第一个删的人排在柜子锁上
          const pB = second === "delete"
            ? call("POST /admin/fcl-containers/delete", ADMIN2, { containerId: made.containerId, confirmContainerNo: ctrNo }).then((r) => { b = r; })
            : call("POST /staff/fcl-containers/update", STAFF, { containerId: made.containerId, ...fclBody(blNo, ctrNo, { remark: "改" }) }).then((r) => { b = r; });
          await waitForWaiters(before + 2); // 第二个人也排在柜子锁上
          void pA; void pB;
        }, { timeout: 20000, maxWait: 10000 });
        for (let i = 0; i < 200 && (!a || !b); i++) await sleepMs(25);
        assert.equal(a?.status, 200, `[${second}] 先删的：${a?.status} ${a?.message}`);
        assert.equal(b?.status, 404, `[${second}] 后到的应该 404，实际 ${b?.status}：${b?.message}`);
        assert.match(b.message, /这个整柜刚刚已经被别人删掉了/, `[${second}] 提示没说是整柜被删了（旧：「运单不存在或不属于当前公司：s_fcl_…」）：${b.message}`);
        assert.doesNotMatch(b.message, /s_fcl_/);
      }
    });

    await check("S20 删柜的同时有人把柜里那张单删了：删柜照样 200、不用再点一次（旧：第 2 轮改出来的 404「运单 X-1 已经不存在了」）", async () => {
      for (let i = 0; i < 2; i++) {
        const no = NO(`CDEL${i}`);
        const { orderId, shipmentId } = await newOrder(no);
        const ctr = await newContainer();
        await must("POST /staff/loading-manifests/add-shipment", STAFF, { trackingNo: no, pieceCount: 2 }, { id: ctr });
        let delOrder: any; let delCtr: any;
        await pm.$transaction(async (tx: any) => {
          await tx.$queryRaw`SELECT id FROM shipments WHERE id = ${shipmentId} FOR UPDATE`; // 卡住父单
          const before = await lockWaiters();
          const pO = call("POST /admin/orders/delete", ADMIN, { orderId }).then((r) => { delOrder = r; });
          await waitForWaiters(before + 1); // 删单已经锁了子单，卡在父单上
          const pC = call("DELETE /admin/containers", ADMIN2, {}, { id: ctr }).then((r) => { delCtr = r; });
          await waitForWaiters(before + 2); // 删柜已经锁了柜子、读到了柜里那条子单，卡在子单上
          void pO; void pC;
        }, { timeout: 20000, maxWait: 10000 });
        for (let k = 0; k < 200 && (!delOrder || !delCtr); k++) await sleepMs(25);
        assert.equal(delOrder?.status, 200, `删单：${delOrder?.status} ${delOrder?.message}`);
        assert.equal(delCtr?.status, 200, `第 ${i} 次删柜应该 200，实际 ${delCtr?.status}：${delCtr?.message}（旧：404「运单 ${no}-1 已经不存在了」）`);
        assert.equal(await pm.container.count({ where: { id: ctr } }), 0, "柜子应该删掉了");
        assert.equal(await pm.shipment.count({ where: { orderId } }), 0);
      }
    });
  } finally {
    await cleanup().catch((e) => console.log("清理失败：", e));
    await prisma.$disconnect();
    fs.rmSync(imagesDir, { recursive: true, force: true });
  }
  console.log(`\n${passed} 项通过，${failed} 项失败`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
