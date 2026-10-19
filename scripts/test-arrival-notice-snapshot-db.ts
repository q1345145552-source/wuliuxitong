/**
 * 到货通知转正式运单时存原样（2026-10-19 老板选 B）—— 连库（真 handler + 真 PostgreSQL）。
 * 计划和老板认可的细节：.audit/2026-10-19/notice-snapshot/plan.md。
 *
 *   P1  直接转正式：存一份，内容 = 转之前那一刻的到货通知（两款产品、备注、整票重量体积、仓库、运输方式、到仓日期、唛头、运单号），
 *       记谁转的；列表、转的回包都带 snapshotCount = 1；读原样：员工拿不到是谁转的，超管拿得到
 *   P2  转待入库不存；待入库时在到货通知里改资料、再转正式：存的是改过之后、转正式那一刻的；只存这一份
 *   P3  转正式以后超管在「运单管理」改运单：卡片照样跟着变（同步照旧），原样那一份一个字没动
 *   P4  转正式没转成（缺资料）：一份都不存
 *   P5  运单在「运单管理」被删：卡片回到「没转」，原样还在（snapshotCount 照旧 1、读得到）；改资料存一下回包也带着；
 *       重新转正式再存一份，两份都在、新的在前、各记各的运单
 *   P6  读原样：别家公司的 404、没带 id 400、客户 / 代理进不来；坏了的 / 认不出的新格式 / 字段类型不对（审查第 1 轮）那一份 data 是 null、不报错；
 *       别家公司的原样混在同一条到货通知下：读原样、列表、改资料回包、超管修改详情的份数都不算它
 *   P7  删到货通知（运单被删、回到「没转」才删得掉）：原样跟着删
 *   P8  超管点「修改」时拿的已转运单详情也带 snapshotCount
 *   P9  刚转完、谁都没改：页面真比对函数跟读原样回的 current 比，一处「改过」都没有（各种填法、国内单号写「货拉拉」、待入库再转正式；
 *       运单管理改了无关的一项触发同步之后也一样）；current 跟列表上那张卡片一模一样
 *   P10 （审查第 2 轮）current 和原样在同一个快照里读：读到一半（current 读完、原样还没读）有人改了备注又多存了一份，
 *       回的还是同一时刻的「现在 + 原样」（不会「旧的现在 + 新存的原样」）
 *
 * 只连测试库：DATABASE_URL 不带 neon.tech 的不跑（一次性 docker 库设 AGENT_PORTAL_TEST_ALLOW_DB=1）；
 * 没有 DATABASE_URL 打印「跳过」。测试数据全在假公司 zz_ansnap_co / zz_ansnap_co2 下，开跑前、跑完后都清干净。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Row = Record<string, any>;
type Auth = { userId: string; companyId: string; role: string; name: string; agentId: string | null };
const CO = "zz_ansnap_co";
const CO2 = "zz_ansnap_co2";
const ADMIN: Auth = { userId: "zz_ansnap_admin", companyId: CO, role: "admin", name: "超管老王", agentId: null };
const STAFF: Auth = { userId: "zz_ansnap_staff", companyId: CO, role: "staff", name: "员工小李", agentId: null };
const CLIENT: Auth = { userId: "ZZANS01", companyId: CO, role: "client", name: "客户甲", agentId: null };
const OTHER_STAFF: Auth = { userId: "zz_ansnap_o_staff", companyId: CO2, role: "staff", name: "别家员工", agentId: null };
const AGENT: Auth = { userId: "zz_ansnap_agent_user", companyId: CO, role: "agent", name: "代理", agentId: "zz_ansnap_agent" };
const NO = (s: string) => `ZZANS${s}`;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) { console.log("⚠️ 跳过：没有 DATABASE_URL（CI 没有数据库）—— 这一项等于没测"); return; }
  if (!url.includes("neon.tech") && process.env.AGENT_PORTAL_TEST_ALLOW_DB !== "1") {
    console.log("⚠️ 跳过：DATABASE_URL 不是 Neon 测试库，怕连到生产库不跑（确认是测试库可设 AGENT_PORTAL_TEST_ALLOW_DB=1）—— 这一项等于没测");
    return;
  }
  process.env.NODE_ENV = process.env.NODE_ENV || "test";
  const imagesDir = fs.mkdtempSync(path.join(os.tmpdir(), "zz-ansnap-img-"));
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
  const save = (auth: Auth, body: Row) => must("POST /staff/arrival-notices/save", auth, body).then((d) => d.item);
  const convert = (auth: Auth, id: string, to: "formal" | "inbound") => must("POST /staff/arrival-notices/convert", auth, { id, to }).then((d) => d.item);
  const listItem = async (auth: Auth, trackingNo: string) => {
    const l = await must("GET /staff/arrival-notices/list", auth, {}, { keyword: trackingNo });
    return l.items.find((x: Row) => x.trackingNo === trackingNo || x.id === trackingNo);
  };
  const snaps = (auth: Auth, id: string) => must("GET /staff/arrival-notices/snapshots", auth, {}, { id }).then((d) => d.items as Row[]);
  const snapsCurrent = (auth: Auth, id: string) => must("GET /staff/arrival-notices/snapshots", auth, {}, { id }).then((d) => d.current as Row);
  // 一款产品（页面 draftToBody 发的样子：没填的是 null）
  const P = (o: Row = {}): Row => ({ itemName: null, packageCount: null, lengthCm: null, widthCm: null, heightCm: null, productQuantity: null, weightKg: null, cargoType: "normal", domesticTrackingNo: null, ...o });
  const full = (no: string): Row => ({
    clientId: CLIENT.userId, trackingNo: NO(no), transportMode: "sea", warehouseId: "wh_yiwu_01", arrivedAt: "2026-10-19",
    weightKg: 85.5, volumeM3: 0.625, remark: "内部备注：外箱有破损",
    products: [
      P({ itemName: "灯具", packageCount: 12, lengthCm: 60, widthCm: 40, heightCm: 30, productQuantity: 10, weightKg: 5, domesticTrackingNo: "SF1234567890" }),
      P({ itemName: "鞋", packageCount: 5, productQuantity: 2, cargoType: "sensitive", domesticTrackingNo: "YT9876543210" }),
    ],
  });

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
    catch (e: any) { failed++; console.log(`❌ ${name}\n   ${e?.message ?? e}`); }
  }

  await cleanup();
  try {
    await pm.agent.create({ data: { id: AGENT.agentId, companyId: CO, name: "代理", priceNormal: 1, priceInspection: 1, priceSensitive: 1 } });
    for (const u of [ADMIN, STAFF, CLIENT, OTHER_STAFF, AGENT]) {
      await pm.user.create({ data: { id: u.userId, companyId: u.companyId, role: u.role, name: u.name, passwordHash: "x", phone: `0${u.userId}`, status: "active", agentId: u === AGENT ? AGENT.agentId : null } });
    }

    let p1Id = "";
    await check("P1 直接转正式：存一份 = 转之前那一刻的到货通知，记谁转的；回包 / 列表带 snapshotCount 1；员工看不到是谁转的，超管看得到", async () => {
      const n = await save(STAFF, full("A1"));
      p1Id = n.id;
      assert.equal(n.snapshotCount, 0, "还没转，0 份");
      const before = await must("GET /staff/arrival-notices/list", STAFF, {}, { keyword: NO("A1") }).then((l) => l.items[0]);
      const after = await convert(STAFF, n.id, "formal");
      assert.equal(after.convertedTo, "formal");
      assert.equal(after.snapshotCount, 1, "转的回包要带 1 份");
      assert.equal((await listItem(STAFF, NO("A1"))).snapshotCount, 1, "列表要带 1 份");
      const rows = await pm.arrivalNoticeSnapshot.findMany({ where: { noticeId: n.id } });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].convertedById, STAFF.userId);
      assert.equal(rows[0].convertedByName, STAFF.name);
      assert.equal(rows[0].shipmentId, after.shipmentId, "记着转出去的是哪张运单");
      const data = JSON.parse(rows[0].data);
      assert.deepEqual(data, {
        v: 1, clientId: CLIENT.userId, trackingNo: NO("A1"), warehouseId: "wh_yiwu_01", transportMode: "sea", arrivedAt: "2026-10-19",
        // 整票重量 / 体积按产品行重算过（保存时就算好了），跟转之前卡片上那份一样
        weightKg: before.weightKg, volumeM3: before.volumeM3, remark: "内部备注：外箱有破损", products: before.products,
      }, "存的要跟转之前卡片上那份一模一样");
      assert.deepEqual([before.weightKg, before.volumeM3], [60, 0.864], "前提：这份测试数据的整票数是产品行算出来的");
      const asStaff = await snaps(STAFF, n.id);
      assert.equal(asStaff.length, 1);
      assert.equal(asStaff[0].convertedByName, null, "员工拿不到是谁转的（老板 2026-09-15：操作人只给超管）");
      assert.deepEqual(asStaff[0].data, data);
      assert.equal(asStaff[0].convertedAt, rows[0].createdAt.toISOString());
      assert.equal((await snaps(ADMIN, n.id))[0].convertedByName, STAFF.name, "超管看得到");
      // 一起回的 current = 列表上那张卡片（同一个口径）
      assert.deepEqual(await snapsCurrent(STAFF, n.id), await listItem(STAFF, NO("A1")), "读原样回的「现在」跟列表卡片不一样");
    });

    await check("P2 转待入库不存；待入库时改资料、再转正式：存的是改过之后、转正式那一刻的；只这一份", async () => {
      const n = await save(STAFF, { clientId: CLIENT.userId, trackingNo: NO("B1") });
      const inbound = await convert(STAFF, n.id, "inbound");
      assert.equal(inbound.convertedTo, "inbound");
      assert.equal(inbound.snapshotCount, 0, "转待入库不存");
      assert.equal(await pm.arrivalNoticeSnapshot.count({ where: { noticeId: n.id } }), 0);
      const filled = await save(STAFF, { ...full("B1"), id: n.id, remark: "待入库时补齐" });
      assert.equal(filled.snapshotCount, 0);
      const formal = await convert(STAFF, n.id, "formal");
      assert.equal(formal.snapshotCount, 1);
      const rows = await pm.arrivalNoticeSnapshot.findMany({ where: { noticeId: n.id } });
      assert.equal(rows.length, 1);
      const data = JSON.parse(rows[0].data);
      assert.equal(data.remark, "待入库时补齐");
      assert.deepEqual(data.products.map((p: Row) => [p.itemName, p.packageCount]), [["灯具", 12], ["鞋", 5]]);
      assert.equal(rows[0].shipmentId, inbound.shipmentId, "待入库转正式是同一张运单");
    });

    await check("P3 转正式后超管在「运单管理」改运单：卡片照样跟着变（同步照旧），原样一个字没动", async () => {
      const ship = await pm.shipment.findFirst({ where: { trackingNo: NO("A1") } });
      const snapBefore = await pm.arrivalNoticeSnapshot.findFirst({ where: { noticeId: p1Id } });
      const cardBefore = await listItem(STAFF, NO("A1"));
      await must("POST /admin/orders/update", ADMIN, { orderId: ship.orderId, itemName: "改过的品名", weightKg: 99 });
      const cardAfter = await listItem(STAFF, NO("A1"));
      assert.notDeepEqual([cardAfter.products, cardAfter.weightKg], [cardBefore.products, cardBefore.weightKg], "卡片要跟着运单变（同步照旧）");
      const snapAfter = await pm.arrivalNoticeSnapshot.findFirst({ where: { noticeId: p1Id } });
      assert.equal(snapAfter.data, snapBefore.data, "原样谁都改不了");
      assert.equal(await pm.arrivalNoticeSnapshot.count({ where: { noticeId: p1Id } }), 1, "改运单不多存");
      assert.equal(cardAfter.snapshotCount, 1);
    });

    await check("P4 转正式没转成（缺资料）：一份都不存", async () => {
      const n = await save(STAFF, { clientId: CLIENT.userId, trackingNo: NO("C1") });
      const r = await call("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "formal" });
      assert.equal(r.status, 400, r.message);
      assert.equal(await pm.arrivalNoticeSnapshot.count({ where: { noticeId: n.id } }), 0);
    });

    let p5Id = "";
    await check("P5 运单被删：卡片回到「没转」、原样还在；改资料回包也带着；重转再存一份，两份都在、新的在前、各记各的运单", async () => {
      const n = await save(STAFF, full("D1"));
      p5Id = n.id;
      const first = await convert(STAFF, n.id, "formal");
      const ship = await pm.shipment.findFirst({ where: { id: first.shipmentId } });
      await must("POST /admin/orders/delete", ADMIN, { orderId: ship.orderId });
      const card = await listItem(STAFF, NO("D1"));
      assert.equal(card.convertedTo, null, "运单被删：当作没转");
      assert.equal(card.shipmentGone, true);
      assert.equal(card.snapshotCount, 1, "以前那份原样还在");
      assert.equal((await snaps(STAFF, n.id)).length, 1);
      // 别家公司的原样混在这条下面（审查第 1 轮）：改资料回包的份数不算它
      await pm.arrivalNoticeSnapshot.create({ data: { id: "zz_ansnap_x5", companyId: CO2, noticeId: n.id, data: "{}", convertedById: OTHER_STAFF.userId } });
      const edited = await save(STAFF, { ...full("D1"), id: n.id, remark: "重转前改一下" });
      assert.equal(edited.snapshotCount, 1, "改资料存完回给页面的卡片也要带着（不然按钮就不见了），也不算别家公司的");
      await pm.arrivalNoticeSnapshot.delete({ where: { id: "zz_ansnap_x5" } });
      await new Promise((r) => setTimeout(r, 5));
      const second = await convert(STAFF, n.id, "formal");
      assert.equal(second.snapshotCount, 2);
      const items = await snaps(ADMIN, n.id);
      assert.equal(items.length, 2);
      assert.equal(items[0].data.remark, "重转前改一下", "新的在前");
      assert.equal(items[1].data.remark, "内部备注：外箱有破损");
      assert.ok(items[0].convertedAt > items[1].convertedAt);
      const rows = await pm.arrivalNoticeSnapshot.findMany({ where: { noticeId: n.id }, orderBy: { createdAt: "asc" } });
      assert.deepEqual(rows.map((r: Row) => r.shipmentId), [first.shipmentId, second.shipmentId], "各记各的那张运单");
    });

    await check("P6 读原样：别家公司 404、没带 id 400、客户 / 代理进不来；坏了的那一份 data 是 null、不报错", async () => {
      const other = await call("GET /staff/arrival-notices/snapshots", OTHER_STAFF, {}, { id: p1Id });
      assert.equal(other.status, 404, other.message);
      assert.equal((await call("GET /staff/arrival-notices/snapshots", STAFF, {}, {})).status, 400);
      assert.equal((await call("GET /staff/arrival-notices/snapshots", CLIENT, {}, { id: p1Id })).status, 403);
      assert.equal((await call("GET /staff/arrival-notices/snapshots", AGENT, {}, { id: p1Id })).status, 403);
      await pm.arrivalNoticeSnapshot.create({ data: { id: "zz_ansnap_bad", companyId: CO, noticeId: p1Id, data: "{坏的", convertedById: STAFF.userId, createdAt: new Date(Date.now() + 60_000) } });
      const good = JSON.parse((await pm.arrivalNoticeSnapshot.findFirst({ where: { noticeId: p1Id, id: { not: "zz_ansnap_bad" } } })).data);
      // 以后的新格式（v=2，别的字段都齐、类型也对）这一版认不出：也给 null，不拿新格式硬套老页面
      await pm.arrivalNoticeSnapshot.create({ data: { id: "zz_ansnap_v2", companyId: CO, noticeId: p1Id, data: JSON.stringify({ ...good, v: 2 }), convertedById: STAFF.userId, createdAt: new Date(Date.now() + 30_000) } });
      // 审查第 1 轮：JSON 能解析、v=1，但字段类型不对 / 缺字段 / 产品不是对象 —— 一律当坏的（不然页面一 trim 就白屏）
      // 审查第 2 轮：每次只坏一个字段（顶层、产品里每一个都轮一遍：类型不对、整个缺掉），别让别的字段顺带挡住
      const without = (o: Row, k: string) => { const c = { ...o }; delete c[k]; return c; };
      const p0 = good.products[0];
      const broken: Array<[string, unknown]> = [
        ...["clientId", "trackingNo", "warehouseId", "arrivedAt", "remark"].flatMap((k): Array<[string, unknown]> => [[`${k} 是对象`, { ...good, [k]: {} }], [`缺 ${k}`, without(good, k)]]),
        ["运输方式认不出", { ...good, transportMode: "air" }], ["缺运输方式", without(good, "transportMode")],
        ...["weightKg", "volumeM3"].flatMap((k): Array<[string, unknown]> => [[`${k} 是字符串`, { ...good, [k]: "60" }], [`缺 ${k}`, without(good, k)]]),
        ...["itemName", "cargoType", "domesticTrackingNo"].flatMap((k): Array<[string, unknown]> => [[`产品 ${k} 是数字`, { ...good, products: [{ ...p0, [k]: 1 }] }], [`产品缺 ${k}`, { ...good, products: [without(p0, k)] }]]),
        ...["packageCount", "lengthCm", "widthCm", "heightCm", "productQuantity", "weightKg"].flatMap((k): Array<[string, unknown]> => [[`产品 ${k} 是字符串`, { ...good, products: [{ ...p0, [k]: "12" }] }], [`产品缺 ${k}`, { ...good, products: [without(p0, k)] }]]),
        ["产品里有 null", { ...good, products: [null] }],
        ["产品是数组", { ...good, products: [[p0]] }],
        ["products 不是数组", { ...good, products: {} }],
        ["整份是数组", [good]],
      ];
      // 正常的边界照样认：货型 null / 以后的新货型、件数 0、小数、整票数 null
      const fine: Array<[string, Row]> = [
        ["货型 null", { ...good, products: [{ ...p0, cargoType: null }] }],
        ["以后的新货型", { ...good, products: [{ ...p0, cargoType: "futureType" }] }],
        ["件数 0、小数", { ...good, weightKg: 12.345, volumeM3: 0.001, products: [{ ...p0, packageCount: 0, lengthCm: 33.3, weightKg: 2.25 }] }],
        ["整票数、产品数字全是 null", { ...good, weightKg: null, volumeM3: null, products: [{ ...p0, packageCount: null, lengthCm: null, widthCm: null, heightCm: null, productQuantity: null, weightKg: null }] }],
        ["没有产品", { ...good, products: [] }],
      ];
      let at = 20_000;
      for (const [i, [, data]] of broken.entries()) {
        await pm.arrivalNoticeSnapshot.create({ data: { id: `zz_ansnap_b${i}`, companyId: CO, noticeId: p1Id, data: JSON.stringify(data), convertedById: STAFF.userId, createdAt: new Date(Date.now() + (at -= 1000)) } });
      }
      for (const [i, [, data]] of fine.entries()) {
        await pm.arrivalNoticeSnapshot.create({ data: { id: `zz_ansnap_f${i}`, companyId: CO, noticeId: p1Id, data: JSON.stringify(data), convertedById: STAFF.userId, createdAt: new Date(Date.now() + (at -= 1000)) } });
      }
      const all = await snaps(STAFF, p1Id);
      for (const [i, [why]] of broken.entries()) assert.equal(all.find((x: Row) => x.id === `zz_ansnap_b${i}`)?.data, null, `${why}：应该给 null`);
      for (const [i, [why, data]] of fine.entries()) assert.deepEqual(all.find((x: Row) => x.id === `zz_ansnap_f${i}`)?.data, data, `${why}：是正常的，应该原样给`);
      await pm.arrivalNoticeSnapshot.deleteMany({ where: { id: { startsWith: "zz_ansnap_f" } } });
      assert.deepEqual(all.find((x: Row) => !x.id.startsWith("zz_ansnap_"))?.data, good, "好的那份原样给（只回认得的字段）");
      await pm.arrivalNoticeSnapshot.deleteMany({ where: { id: { startsWith: "zz_ansnap_b" }, NOT: { id: "zz_ansnap_bad" } } });
      const items = await snaps(STAFF, p1Id);
      assert.equal(items.length, 3);
      assert.deepEqual(items.map((x: Row) => x.id).slice(0, 2), ["zz_ansnap_bad", "zz_ansnap_v2"]);
      assert.equal(items[0].data, null, "坏的那份给 null");
      assert.equal(items[1].data, null, "认不出的新格式给 null");
      assert.ok(items[2].data, "好的那份照常");
      // 别家公司的原样混进来也不给（按公司过滤）
      await pm.arrivalNoticeSnapshot.create({ data: { id: "zz_ansnap_x", companyId: CO2, noticeId: p1Id, data: "{}", convertedById: OTHER_STAFF.userId } });
      assert.equal((await snaps(STAFF, p1Id)).length, 3, "别家公司的那份不能混进来");
      // 份数也不算它（审查第 1 轮 dsh / Codex）：列表、读原样回的 current、超管修改详情；改资料回包的在 D1 那条上核
      assert.equal((await listItem(STAFF, NO("A1"))).snapshotCount, 3, "列表的份数不能把别家公司那份算进去");
      assert.equal((await snapsCurrent(STAFF, p1Id)).snapshotCount, 3);
      assert.equal((await must("GET /staff/arrival-notices/converted-detail", ADMIN, {}, { id: p1Id, v: "2" })).item.snapshotCount, 3);
      await pm.arrivalNoticeSnapshot.deleteMany({ where: { id: { in: ["zz_ansnap_bad", "zz_ansnap_v2", "zz_ansnap_x"] } } });
    });

    await check("P7 删到货通知（运单被删、回到「没转」才删得掉）：原样跟着删", async () => {
      const ship = await pm.shipment.findFirst({ where: { trackingNo: NO("D1") } });
      await must("POST /admin/orders/delete", ADMIN, { orderId: ship.orderId });
      await must("POST /staff/arrival-notices/delete", STAFF, { id: p5Id });
      assert.equal(await pm.arrivalNotice.count({ where: { id: p5Id } }), 0);
      assert.equal(await pm.arrivalNoticeSnapshot.count({ where: { noticeId: p5Id } }), 0, "原样跟着删（外键 ON DELETE CASCADE）");
    });

    await check("P8 超管点「修改」拿的已转运单详情也带 snapshotCount", async () => {
      const d = await must("GET /staff/arrival-notices/converted-detail", ADMIN, {}, { id: p1Id, v: "2" });
      assert.equal(d.item.snapshotCount, 1);
    });

    await check("P9 刚转完、谁都没改：弹窗里一处「改过」都没有（真拿页面的比对函数，跟转完以后列表上的卡片比；各种填法 + 待入库再转正式）", async () => {
      const { snapshotMetaRows, snapshotProductRows } = await import("../apps/web/src/modules/arrival-notice/snapshot-diff");
      const shapes: Array<[string, Row]> = [
        ["E1 两款、尺寸 / 单箱重 / 国内单号都填", full("E1")],
        // 国内单号空着（运单那边会写「货拉拉」）、没尺寸没单箱重、整票数手填、陆运、没备注
        ["E2 国内单号空着、整票数手填", { clientId: CLIENT.userId, trackingNo: NO("E2"), transportMode: "land", warehouseId: "wh_guangzhou_01", arrivedAt: "2026-10-18",
          weightKg: 33.5, volumeM3: 0.123, remark: null, products: [P({ itemName: "杯子", packageCount: 3 }), P({ itemName: "盘子", packageCount: 1, cargoType: "inspection" })] }],
        ["E3 一款、小数尺寸、特货", { clientId: CLIENT.userId, trackingNo: NO("E3"), transportMode: "sea", warehouseId: "wh_yiwu_01", arrivedAt: "2026-10-17",
          weightKg: null, volumeM3: null, remark: "  前后有空格  ", products: [P({ itemName: "电池", packageCount: 7, lengthCm: 33.3, widthCm: 21.7, heightCm: 15.5, weightKg: 2.25, productQuantity: 40, cargoType: "special", domesticTrackingNo: "JD0001" })] }],
        ["E4 有的款填了尺寸、有的没填（整票数以手填为准）", { clientId: CLIENT.userId, trackingNo: NO("E4"), transportMode: "sea", warehouseId: "wh_yiwu_01", arrivedAt: "2026-10-16",
          weightKg: 50, volumeM3: 0.5, remark: "x", products: [P({ itemName: "灯具", packageCount: 2, lengthCm: 60, widthCm: 40, heightCm: 30, weightKg: 5, domesticTrackingNo: "SF1" }), P({ itemName: "鞋", packageCount: 4 })] }],
        // 审查第 1 轮：到货通知上国内单号就写的「货拉拉」（同步回来变成没填）
        ["E5 国内单号写的「货拉拉」", { clientId: CLIENT.userId, trackingNo: NO("E5"), transportMode: "sea", warehouseId: "wh_yiwu_01", arrivedAt: "2026-10-15",
          weightKg: 20, volumeM3: 0.2, remark: null, products: [P({ itemName: "杯子", packageCount: 3, domesticTrackingNo: "货拉拉" })] }],
      ];
      const problems: string[] = [];
      // 跟弹窗一样：拿读原样那个接口一起回的 current 比（顺便核它跟列表卡片一模一样）
      const compare = async (label: string, trackingNo: string) => {
        const card = await listItem(STAFF, trackingNo);
        const r = await must("GET /staff/arrival-notices/snapshots", STAFF, {}, { id: card.id });
        assert.deepEqual(r.current, card, `${label}：current 跟列表卡片不一样`);
        const [s] = r.items;
        assert.ok(s?.data, `${label}：没存原样`);
        const diff = [...snapshotMetaRows(s.data, r.current), ...snapshotProductRows(s.data, r.current)].filter((x) => x.changed);
        for (const x of diff) problems.push(`${label} · ${x.label}：转运单时「${x.was}」/ 现在「${x.now}」`);
      };
      for (const [label, body] of shapes) {
        const n = await save(STAFF, body);
        const formal = await convert(STAFF, n.id, "formal");
        await compare(label, body.trackingNo);
        // 超管在「运单管理」改了一项跟到货通知无关的（订单备注）：卡片照样按运单重对一遍（国内单号空着的运单那边是「货拉拉」），也不能冒出「改过」
        const ship = await pm.shipment.findFirst({ where: { id: formal.shipmentId } });
        await must("POST /admin/orders/update", ADMIN, { orderId: ship.orderId, remark: "跟到货通知无关的订单备注" });
        await compare(`${label}（运单管理改过无关的一项以后）`, body.trackingNo);
      }
      await compare("B1 待入库再转正式", NO("B1"));
      assert.deepEqual(problems, [], "谁都没改，却标了「改过」");
    });

    await check("P10 （审查第 2 轮）current 和原样在同一个快照里读：读到一半有人改了备注又多存一份，回的还是同一时刻的（份数、备注、原样条数对得上）", async () => {
      const { PrismaClient } = await import("@prisma/client");
      const locker = new PrismaClient();
      try {
        const n = await save(STAFF, full("F1"));
        await convert(STAFF, n.id, "formal");
        const before = await snapsCurrent(STAFF, n.id);
        assert.equal(before.snapshotCount, 1);
        let locked!: () => void, release!: () => void;
        const isLocked = new Promise<void>((r) => { locked = r; });
        const gate = new Promise<void>((r) => { release = r; });
        // 另一条连接：先把原样表锁住（读原样那个请求读完 current 里的到货通知、数份数时就会卡住），等它卡住了再改备注、多存一份、放锁
        const other = locker.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`LOCK TABLE arrival_notice_snapshots IN ACCESS EXCLUSIVE MODE`);
          locked();
          await gate;
          await tx.$executeRawUnsafe(`UPDATE arrival_notices SET remark = '读到一半改的备注' WHERE id = '${n.id}'`);
          await tx.$executeRawUnsafe(`INSERT INTO arrival_notice_snapshots (id, company_id, notice_id, data, converted_by_id) VALUES ('zz_ansnap_mid', '${CO}', '${n.id}', '{}', '${STAFF.userId}')`);
        }, { timeout: 30000, maxWait: 10000 });
        await isLocked;
        const reading = call("GET /staff/arrival-notices/snapshots", STAFF, {}, { id: n.id });
        // 等那个请求真的卡在锁上（看数据库里有没有在等锁的查询）
        let waiting = 0;
        for (let i = 0; i < 100 && waiting === 0; i++) {
          await new Promise((r) => setTimeout(r, 50));
          waiting = Number((await locker.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%arrival_notice_snapshots%'`))[0].n);
        }
        assert.ok(waiting > 0, "前提：读原样的请求没卡在锁上，这一项没测到「读到一半」");
        release();
        await other;
        const r = await reading;
        assert.equal(r.status, 200, r.message);
        assert.equal(r.data.items.length, r.data.current.snapshotCount, "原样条数跟 current 的份数对不上（不是同一时刻读的）");
        assert.deepEqual([r.data.items.length, r.data.current.remark], [1, before.remark], "读到一半别人提交的不该混进来（要么全是之前的，要么全是之后的）");
        const after = await must("GET /staff/arrival-notices/snapshots", STAFF, {}, { id: n.id });
        assert.deepEqual([after.items.length, after.current.remark], [2, "读到一半改的备注"], "再读一次就是新的");
        await pm.arrivalNoticeSnapshot.deleteMany({ where: { id: "zz_ansnap_mid" } });
      } finally {
        await locker.$disconnect();
      }
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
