/**
 * 改整柜（真 PostgreSQL，2026-09-24）。老板：「加上编辑功能」。
 *
 * 为什么非得连真库跑：上面那份 test-fcl-containers.ts 是读源码的，能证明「代码里写了」，
 * **证明不了「改完库里真的变了」**。而改整柜最容易出事的恰恰是「只改了一半」——
 * 订单改了运单没改、柜子改了轨迹没改、汇总没跟着清单重算。
 * 这些 tsc 全绿、源码扫描也全绿，只有真改一遍再回头查库才照得出来（CLAUDE.md 第 24、33 条）。
 *
 * 全部走**真实接口**（建整柜 / 改整柜 / 推柜子状态 / 建派送单），不自己拼 SQL 造状态。
 * 只连测试库：DATABASE_URL 不带 neon.tech 的不跑（IPv4 连测试库时核实后设 AGENT_PORTAL_TEST_ALLOW_DB=1）；
 * 没有 DATABASE_URL（CI）打印「跳过」。测试数据全在假公司 zz_fclup_co 下，开跑前、跑完后都清干净。
 * 用法：npm run test:fcl-update-db
 */
process.env.TZ = "UTC"; // 线上服务器是 UTC，装柜日期按服务器时区解析
import assert from "node:assert/strict";

type Row = Record<string, any>;
type Auth = { userId: string; companyId: string; role: string; name: string };

const CO = "zz_fclup_co";
const P = "zz_fclup_";
const STAFF: Auth = { userId: `${P}staff`, companyId: CO, role: "staff", name: "测试员工" };
const ADMIN: Auth = { userId: `${P}admin`, companyId: CO, role: "admin", name: "测试管理员" };
const CLIENT_ID = `${P}client`;
const WH = "wh_yiwu_01";

let failures = 0;
function expect(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✅ ${label}`);
  } catch (e) {
    failures++;
    console.log(`  ❌ ${label}\n     ${e instanceof Error ? e.message.split("\n").slice(0, 3).join("\n     ") : String(e)}`);
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
  (await import("../apps/api/src/modules/fcl-containers/routes")).registerFclContainerRoutes(app);
  (await import("../apps/api/src/modules/containers/routes")).registerContainerRoutes(app);
  (await import("../apps/api/src/modules/admin-ops/routes")).registerAdminOpsRoutes(app);
  (await import("../apps/api/src/modules/shipments/routes")).registerShipmentRoutes(app);
  // N5 要打这两条老的「改运单」接口，确认它们碰到整柜会整张拒绝
  (await import("../apps/api/src/modules/admin/routes")).registerAdminRoutes(app);
  (await import("../apps/api/src/modules/orders/routes")).registerOrderRoutes(app);

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
    assert.equal(r.status, 200, `${key} 应该成功，实际 ${r.status}：${r.message}`);
    return r.data;
  }

  async function cleanup(): Promise<void> {
    const cs = await pm.container.findMany({ where: { companyId: CO }, select: { id: true } });
    const ids = cs.map((c: Row) => c.id);
    await pm.adminLastmileOrder.deleteMany({ where: { companyId: CO } });
    await pm.shipmentContainerItem.deleteMany({ where: { containerId: { in: ids } } });
    if (pm.containerPushEntry) await pm.containerPushEntry.deleteMany({ where: { companyId: CO } });
    if (pm.containerPushBatch) await pm.containerPushBatch.deleteMany({ where: { companyId: CO } });
    await pm.container.deleteMany({ where: { companyId: CO } });
    await pm.statusLog.deleteMany({ where: { companyId: CO } });
    await pm.orderProduct.deleteMany({ where: { companyId: CO } });
    await pm.shipment.deleteMany({ where: { companyId: CO } });
    await pm.order.deleteMany({ where: { companyId: CO } });
    await pm.auditLog.deleteMany({ where: { companyId: CO } });
    await pm.user.deleteMany({ where: { companyId: CO } });
  }

  await cleanup();
  for (const u of [STAFF, ADMIN]) {
    await pm.user.create({ data: { id: u.userId, companyId: CO, role: u.role, name: u.name, passwordHash: "x", phone: `000${u.userId}`, status: "active" } });
  }
  await pm.user.create({ data: { id: CLIENT_ID, companyId: CO, role: "client", name: "测试客户", passwordHash: "x", phone: "0000000", status: "active" } });

  let seq = 0;
  const uniq = (t: string) => `ZZFU${t}${Date.now().toString(36).toUpperCase()}${seq++}`;
  const ROW_A = { itemName: "鞋", packageCount: 10, quantityPerBox: 20, lengthCm: 60, widthCm: 40, heightCm: 30, unitWeightKg: 2.5, domesticTrackingNo: "SF001", cargoType: "normal" };
  const ROW_B = { itemName: "包", packageCount: 5, quantityPerBox: 4, lengthCm: 50, widthCm: 50, heightCm: 40, unitWeightKg: 3, domesticTrackingNo: "SF002", cargoType: "inspection" };

  /** 建一个整柜，返回它的全套 id 和当初提交的那份 */
  async function makeFcl(over: Row = {}): Promise<Row> {
    const payload = {
      clientId: CLIENT_ID, trackingNo: uniq("BL"), containerNo: uniq("CN"),
      containerType: "40HQ", transportMode: "sea", warehouseId: WH,
      loadingDate: "2026-09-10", amountCny: "12000", remark: "原备注",
      products: [ROW_A], ...over,
    };
    const r = await must("POST /staff/fcl-containers/create", STAFF, payload);
    return { ...payload, containerId: r.containerId, shipmentId: r.shipmentId };
  }
  /** 把一个已有整柜读回来，拼成「改整柜」要的那份（前端就是这么填回表单的） */
  function toUpdateBody(base: Row, over: Row = {}): Row {
    const { containerId, clientId, trackingNo, containerNo, containerType, transportMode, warehouseId, loadingDate, amountCny, remark, products } = base;
    return { containerId, clientId, trackingNo, containerNo, containerType, transportMode, warehouseId, loadingDate, amountCny, remark, products, ...over };
  }
  const dbOf = async (id: string) => pm.container.findUnique({
    where: { id },
    include: {
      items: {
        include: {
          shipment: {
            include: {
              order: { include: { products: { orderBy: { sortOrder: "asc" } } } },
              statusLogs: { orderBy: { changedAt: "asc" } },
            },
          },
        },
      },
    },
  });

  console.log("改整柜（真库）");

  // ── A：什么都不改直接保存 ──────────────────────────────────────────────
  {
    const f = await makeFcl();
    const before = await dbOf(f.containerId);
    const r = await call("POST /staff/fcl-containers/update", STAFF, toUpdateBody(f));
    expect("A) 什么都不改直接保存：不报「柜号已存在」（查重排除了自己）", () => {
      assert.equal(r.status, 200, `原样保存被拦了：${r.message}`);
      assert.deepEqual(r.data?.changedFields, [], `没改东西却说改了：${JSON.stringify(r.data?.changedFields)}`);
    });
    const after = await dbOf(f.containerId);
    expect("A2) 原样保存不会把数据改坏（汇总、轨迹条数、产品行 id 都没动）", () => {
      const bs = before.items[0].shipment, as = after.items[0].shipment;
      assert.equal(Number(as.volumeM3), Number(bs.volumeM3), "方数被改了");
      assert.equal(as.packageCount, bs.packageCount, "箱数被改了");
      assert.equal(as.statusLogs.length, bs.statusLogs.length, "轨迹条数变了");
      assert.deepEqual(as.order.products.map((p: Row) => p.id), bs.order.products.map((p: Row) => p.id), "清单没动却把产品行删了重建");
      assert.equal(after.sealedAt?.toISOString(), before.sealedAt?.toISOString(), "封柜时间被改了");
    });
  }

  // ── B：改货物清单 → 三处汇总都要跟着重算 ──────────────────────────────
  {
    const f = await makeFcl();
    const r = await must("POST /staff/fcl-containers/update", STAFF, toUpdateBody(f, { products: [ROW_A, ROW_B] }));
    const db = await dbOf(f.containerId);
    const sp = db.items[0].shipment, od = sp.order;
    // 手算：鞋 0.6*0.4*0.3*10 = 0.72；包 0.5*0.5*0.4*5 = 0.5 → 1.22 方；箱数 15；总重 25+15=40
    expect("B) 清单加一行：方数 / 箱数 / 总重按新清单重算", () => {
      assert.equal(Number(od.volumeM3), 1.22, `订单方数算错：${od.volumeM3}`);
      assert.equal(od.packageCount, 15, `订单箱数算错：${od.packageCount}`);
      assert.equal(Number(od.weightKg), 40, `订单总重算错：${od.weightKg}`);
      assert.equal(Number(sp.volumeM3), 1.22, `运单方数没跟着改：${sp.volumeM3}`);
      assert.equal(sp.packageCount, 15, `运单箱数没跟着改：${sp.packageCount}`);
    });
    expect("B2) 柜内记录上的方数箱数也跟着改（装柜清单、派送单读的是它）", () => {
      assert.equal(Number(db.items[0].loadedVolumeM3), 1.22, `柜内记录方数没跟着改：${db.items[0].loadedVolumeM3}`);
      assert.equal(db.items[0].loadedPieceCount, 15, `柜内记录箱数没跟着改：${db.items[0].loadedPieceCount}`);
    });
    expect("B3) 存进产品行的是**单箱重**，不是整行总重（客户签收单按它×箱数印）", () => {
      const shoes = od.products.find((p: Row) => p.itemName === "鞋");
      assert.equal(Number(shoes.weightKg), 2.5, `存成整行总重了：${shoes.weightKg}（该是单箱重 2.5）`);
      assert.equal(shoes.productQuantity, 20, `每箱数量存错了：${shoes.productQuantity}`);
    });
    expect("B4) 品名摘要和货型跟着清单走（货型取最严的那个）", () => {
      assert.equal(od.itemName, "鞋 等 2 项", `品名摘要没跟着改：${od.itemName}`);
      assert.equal(od.cargoType, "inspection", `货型该取最严的商检货，实际 ${od.cargoType}`);
    });
    expect("B5) 返回里说清楚改了哪几样", () => {
      assert.deepEqual(r.changedFields, ["货物清单"], JSON.stringify(r.changedFields));
    });
  }

  // ── C：改装柜日期 → 柜子、状态时间表、轨迹三处一起走 ────────────────────
  {
    const f = await makeFcl({ loadingDate: "2026-09-10" });
    await must("POST /staff/fcl-containers/update", STAFF, toUpdateBody(f, { loadingDate: "2026-09-05" }));
    const db = await dbOf(f.containerId);
    const sp = db.items[0].shipment;
    const start = sp.statusLogs.find((l: Row) => l.fromStatus === "created");
    const dates = JSON.parse(db.statusDates ?? "{}");
    expect("C) 改装柜日期：柜子上的装柜日期和封柜时间跟着改", () => {
      assert.equal(db.loadingDate?.toISOString().slice(0, 10), "2026-09-05", `装柜日期没改：${db.loadingDate}`);
      assert.equal(db.sealedAt?.toISOString().slice(0, 10), "2026-09-05", `封柜时间没跟着改：${db.sealedAt}`);
    });
    expect("C2) 柜子那张「状态时间表」里「已封柜」那一格也跟着改（撤销状态读的是它）", () => {
      assert.equal(String(dates.SEALED).slice(0, 10), "2026-09-05", `状态时间表没跟着改：${dates.SEALED}`);
    });
    expect("C3) 客户看到的那条「已装柜」轨迹，时间跟着改", () => {
      assert.equal(start.changedAt.toISOString().slice(0, 10), "2026-09-05", `轨迹时间没跟着改：${start.changedAt}`);
    });
    expect("C4) 订单上的发货日期也跟着改", () => {
      assert.equal(sp.order.shipDate, "2026-09-05", `订单发货日期没跟着改：${sp.order.shipDate}`);
    });
  }

  // ── D：改运输方式（柜子还在起点）→ 柜子 / 订单 / 运单三处一起改 ──────────
  {
    const f = await makeFcl({ transportMode: "sea" });
    await must("POST /staff/fcl-containers/update", STAFF, toUpdateBody(f, { transportMode: "land" }));
    const db = await dbOf(f.containerId);
    const sp = db.items[0].shipment;
    const start = sp.statusLogs.find((l: Row) => l.fromStatus === "created");
    expect("D) 海运改陆运：柜子 / 订单 / 运单三处一起改（少一处两套流程就分裂）", () => {
      assert.equal(db.transportMode, "land", `柜子没改：${db.transportMode}`);
      assert.equal(sp.transportMode, "land", `运单没改：${sp.transportMode}`);
      assert.equal(sp.order.transportMode, "land", `订单没改：${sp.order.transportMode}`);
    });
    expect("D2) 起步那条轨迹的「下一站」跟着换成陆运那一站", () => {
      assert.equal(start.nextStop, "凭祥口岸", `下一站还是海运的：${start.nextStop}`);
    });
  }

  // ── E：柜子推过状态之后，运输方式不许改（老板：海运陆运不许串）────────────
  {
    const f = await makeFcl({ transportMode: "sea" });
    await must("POST /admin/containers/status", ADMIN, { id: f.containerId, toStatus: "IN_TRANSIT", date: "2026-09-12" });
    const r = await call("POST /staff/fcl-containers/update", STAFF, toUpdateBody(f, { transportMode: "land" }));
    expect("E) 柜子已经在推状态了：海运 / 陆运改不了，而且说得明白", () => {
      assert.equal(r.status, 400, `居然让改了（${r.status}）`);
      assert.match(r.message, /海运 \/ 陆运不能再改/, r.message);
    });
    const r2 = await call("POST /staff/fcl-containers/update", STAFF, toUpdateBody(f, { amountCny: "9999" }));
    expect("E2) 但别的照样能改（只拦运输方式这一样，不是一刀切）", () => {
      assert.equal(r2.status, 200, `连金额都不让改了：${r2.message}`);
    });

    // ── F：装柜日期不能改到后面那几步之后（客户轨迹会倒着排）────────────
    const r3 = await call("POST /staff/fcl-containers/update", STAFF, toUpdateBody(f, { loadingDate: "2026-09-20" }));
    expect("F) 装柜日期改到「已开船」之后：拦住（不然客户看到的轨迹会倒着排）", () => {
      assert.equal(r3.status, 400, `居然让改了（${r3.status}）`);
      assert.match(r3.message, /装柜日期不能晚于后面已经走过的那几步/, r3.message);
    });
    const r4 = await call("POST /staff/fcl-containers/update", STAFF, toUpdateBody(f, { loadingDate: "2026-09-08" }));
    expect("F2) 往前改（还在开船之前）放行", () => {
      assert.equal(r4.status, 200, `往前改也被拦了：${r4.message}`);
    });
  }

  // ── G/H：柜号、提单号那两道 ────────────────────────────────────────────
  {
    const a = await makeFcl();
    const b = await makeFcl();
    const r1 = await call("POST /staff/fcl-containers/update", STAFF, toUpdateBody(a, { containerNo: b.containerNo }));
    expect("G) 柜号改成别的柜子已经在用的：拦住", () => {
      assert.equal(r1.status, 409, `居然让改了（${r1.status}）`);
      assert.match(r1.message, /已经被别的柜子用了/, r1.message);
    });
    const r2 = await call("POST /staff/fcl-containers/update", STAFF, toUpdateBody(a, { trackingNo: b.trackingNo }));
    expect("G2) 提单号改成别人的：拦住", () => {
      assert.equal(r2.status, 409, `居然让改了（${r2.status}）`);
    });
    const r3 = await call("POST /staff/fcl-containers/update", STAFF, toUpdateBody(a, { trackingNo: a.containerNo }));
    expect("H) 提单号改成自己的柜号：拦住（提单号客户看得到，等于把柜号发出去）", () => {
      assert.equal(r3.status, 400, `居然让改了（${r3.status}）`);
      assert.match(r3.message, /提单号不能跟柜号填成同一个/, r3.message);
    });
    const r4 = await call("POST /staff/fcl-containers/update", STAFF, toUpdateBody(a, { warehouseId: "wh_随便编的" }));
    expect("H2) 仓库乱填：拦住（后端按名单卡，不是只判非空）", () => {
      assert.equal(r4.status, 400, `居然让改了（${r4.status}）`);
    });
  }

  // ── I：排了派送单之后，清单不许改，别的照改 ─────────────────────────────
  {
    const f = await makeFcl();
    for (const s of ["IN_TRANSIT", "ARRIVED", "CUSTOMS", "CUSTOMS_CLEARED", "UNLOADING", "IN_WAREHOUSE_TH"]) {
      const r = await call("POST /admin/containers/status", ADMIN, { id: f.containerId, toStatus: s, date: "2026-09-15" });
      assert.equal(r.status, 200, `推到 ${s} 失败：${r.message}`);
    }
    await must("POST /admin/lastmile/orders", ADMIN, {
      shipmentIds: [f.shipmentId], carrierName: "测试承运商", externalTrackingNo: "ZZ-LM-1",
    });
    const r1 = await call("POST /staff/fcl-containers/update", STAFF, toUpdateBody(f, { products: [ROW_A, ROW_B] }));
    expect("I) 已经排了派送单：货物清单改不了（那张单上的箱数方数要给客户签字）", () => {
      assert.equal(r1.status, 400, `居然让改了（${r1.status}）`);
      assert.match(r1.message, /货物清单不能改/, r1.message);
    });
    const r2 = await call("POST /staff/fcl-containers/update", STAFF, toUpdateBody(f, { amountCny: "8888", remark: "改过的备注" }));
    expect("I2) 但金额和备注照样能改", () => {
      assert.equal(r2.status, 200, `金额备注也被拦了：${r2.message}`);
    });
    const db = await dbOf(f.containerId);
    expect("I3) 金额真的写进去了（客户那一页看的就是它）", () => {
      assert.equal(Number(db.items[0].shipment.order.receivableAmountCny), 8888, `金额没写进去：${db.items[0].shipment.order.receivableAmountCny}`);
      assert.equal(db.remark, "改过的备注", `备注没写进去：${db.remark}`);
    });

    // ── J：签收之后只剩金额和备注 ───────────────────────────────────────
    await pm.shipment.update({ where: { id: f.shipmentId }, data: { currentStatus: "delivered" } });
    /* ⚠️ **每个字段都要单独试一遍**（2026-09-24 复核抓到假绿）：
       上一版只试了「柜型」这一个，于是把闸 ① 那张比对表里的
       「客户唛头」「仓库」「装柜日期」逐个删掉，测试照样全绿 ——
       等于那三样能在签收之后被偷偷改掉，而测试一声不吭。
       这张清单必须跟 routes.ts 里 `changed` 那张表**一一对上**。 */
    const otherClientForJ = `${P}client2`;
    await pm.user.create({ data: { id: otherClientForJ, companyId: CO, role: "client", name: "另一个客户", passwordHash: "x", phone: "0000009", status: "active" } });
    const lockedFields: Array<[string, Row]> = [
      ["柜型", { containerType: "20GP" }],
      ["客户唛头", { clientId: otherClientForJ }],
      ["仓库", { warehouseId: "wh_shenzhen_01" }],
      ["装柜日期", { loadingDate: "2026-09-02" }],
      ["提单号", { trackingNo: `${f.trackingNo}X` }],
      ["柜号", { containerNo: `${f.containerNo}X` }],
      ["运输方式", { transportMode: "land" }],
      ["货物清单", { products: [ROW_A, ROW_B] }],
    ];
    for (const [name, patch] of lockedFields) {
      const r = await call("POST /staff/fcl-containers/update", STAFF, toUpdateBody(f, patch));
      expect(`J) 货已签收：改「${name}」必须被拦住`, () => {
        assert.equal(r.status, 400, `居然让改了（${r.status} ${r.message}）`);
        assert.match(r.message, /已经签收了，只能改金额和备注/, r.message);
        assert.match(r.message, new RegExp(name), `提示里没说是哪一样改不了：${r.message}`);
      });
    }
    const r4 = await call("POST /staff/fcl-containers/update", STAFF, toUpdateBody(f, { amountCny: "7777", remark: "签收后补的备注" }));
    expect("J2) 签收之后金额和备注还是能改（钱线下谈，谈完要能补录）", () => {
      assert.equal(r4.status, 200, `签收后连金额都不让改了：${r4.message}`);
    });
    const dbJ = await dbOf(f.containerId);
    expect("J3) 签收后那一次保存，真的只动了金额和备注，别的一个字没变", () => {
      const sp = dbJ.items[0].shipment;
      assert.equal(Number(sp.order.receivableAmountCny), 7777, "金额没写进去");
      assert.equal(dbJ.remark, "签收后补的备注", "备注没写进去");
      assert.equal(dbJ.containerType, "40HQ", "柜型被改了");
      assert.equal(sp.order.clientId, CLIENT_ID, "客户唛头被改了");
      assert.equal(dbJ.transportMode, "sea", "运输方式被改了");
      assert.equal(sp.order.products.length, 1, "货物清单被改了");
    });
  }

  // ── K：改完之后，客户那边还是看不到柜号；整柜还是不进普通运单列表 ──────────
  {
    const f = await makeFcl();
    await must("POST /staff/fcl-containers/update", STAFF, toUpdateBody(f, { remark: "改一下" }));
    const CLIENT: Auth = { userId: CLIENT_ID, companyId: CO, role: "client", name: "测试客户" };
    const list = await must("GET /client/fcl-containers/list", CLIENT);
    const detail = await must("GET /client/fcl-containers/detail", CLIENT, {}, { containerId: f.containerId });
    expect("K) 改完之后，客户那两个接口里一个柜号都没有", () => {
      const txt = JSON.stringify({ list, detail });
      assert.ok(!txt.includes(f.containerNo), "客户接口里漏了柜号");
      assert.ok(!("containerNo" in detail), "客户详情里有 containerNo 这个字段");
    });
    const staffList = await must("GET /staff/shipments", STAFF, {}, { pageSize: "500", all: "1" });
    expect("K2) 改完之后，整柜还是不出现在普通运单列表里（老板：不想混在一起）", () => {
      const nos = (staffList.items ?? []).map((x: Row) => x.trackingNo);
      assert.ok(!nos.includes(f.trackingNo), "整柜跑进普通运单列表了");
    });
  }

  // ── L：权限 ───────────────────────────────────────────────────────────
  {
    const f = await makeFcl();
    const CLIENT: Auth = { userId: CLIENT_ID, companyId: CO, role: "client", name: "测试客户" };
    const r = await call("POST /staff/fcl-containers/update", CLIENT, toUpdateBody(f, { amountCny: "1" }));
    expect("L) 客户改不了整柜（老板：只有我们能建能改）", () => {
      assert.ok(r.status === 401 || r.status === 403, `客户居然能改（${r.status}）`);
    });
    const r2 = await call("POST /staff/fcl-containers/update", ADMIN, toUpdateBody(f, { amountCny: "1" }));
    expect("L2) 超管也能改（跟员工同一档）", () => {
      assert.equal(r2.status, 200, r2.message);
    });
    /* 跨公司要分两条路各测一遍（CLAUDE.md 第 27 条：加了过滤不等于拦得住，
       一个接口里每一次查询都要各自带公司过滤）：
         ① 拿着别人的唛头来改 —— 该被「唛头不属于本公司」拦在前面
         ② 拿着自己公司的唛头来改别人的柜 —— 该在查柜子那一步拦住
       只测 ① 的话，柜子那一步漏了公司过滤也发现不了。 */
    const OTHER_CO = "zz_fclup_other_co";
    const other: Auth = { userId: `${P}other_staff`, companyId: OTHER_CO, role: "staff", name: "别家员工" };
    const r3 = await call("POST /staff/fcl-containers/update", other, toUpdateBody(f, { amountCny: "2" }));
    expect("L3) 别家公司的员工拿着我们的唛头来改：拦住", () => {
      assert.equal(r3.status, 400, `跨公司居然改得到（${r3.status}）`);
      assert.match(r3.message, /唛头不存在或不属于当前公司/, r3.message);
    });
    const otherClient = `${P}other_client`;
    await pm.user.create({ data: { id: otherClient, companyId: OTHER_CO, role: "client", name: "别家客户", passwordHash: "x", phone: "0000001", status: "active" } });
    const r4 = await call("POST /staff/fcl-containers/update", other, toUpdateBody(f, { clientId: otherClient, amountCny: "2" }));
    expect("L4) 别家公司的员工拿着自己的唛头来改我们的柜：照样拦住（查柜子那一步也带公司过滤）", () => {
      assert.equal(r4.status, 404, `跨公司居然改得到（${r4.status}）：${r4.message}`);
    });
    const db = await dbOf(f.containerId);
    expect("L5) 被拦下来之后，我们这个柜一个字都没被动过", () => {
      assert.equal(db.items[0].shipment.order.clientId, CLIENT_ID, `客户唛头被改掉了：${db.items[0].shipment.order.clientId}`);
      assert.equal(Number(db.items[0].shipment.order.receivableAmountCny), 1, `金额被改掉了：${db.items[0].shipment.order.receivableAmountCny}`);
    });
    await pm.user.deleteMany({ where: { companyId: OTHER_CO } });
  }

  // ── M：清单比对的每一格都要算数（2026-09-24 复核抓到假绿）────────────────
  {
    /* 上一版只有「加一行货」这种整行变化的用例，于是把 fclProductSignature 里
       单箱重那一项删掉，测试照样全绿 —— 而单箱重是客户签收单按「×箱数」印的那个数。
       这里逐格改一个字，每一格都必须被认出来「清单改了」。 */
    const cells: Array<[string, Row, string]> = [
      ["品名", { itemName: "改过的鞋" }, "itemName"],
      ["箱数", { packageCount: 11 }, "packageCount"],
      ["每箱数量", { quantityPerBox: 21 }, "productQuantity"],
      ["长", { lengthCm: 61 }, "lengthCm"],
      ["宽", { widthCm: 41 }, "widthCm"],
      ["高", { heightCm: 31 }, "heightCm"],
      ["单箱重", { unitWeightKg: 2.6 }, "weightKg"],
      ["国内单号", { domesticTrackingNo: "SF999" }, "domesticTrackingNo"],
      ["货型", { cargoType: "sensitive" }, "cargoType"],
    ];
    for (const [name, patch, dbField] of cells) {
      const f = await makeFcl();
      const r = await call("POST /staff/fcl-containers/update", STAFF, toUpdateBody(f, { products: [{ ...ROW_A, ...patch }] }));
      const db = await dbOf(f.containerId);
      const row = db.items[0].shipment.order.products[0];
      expect(`M) 清单里只改「${name}」这一格：认得出来是改了，而且真写进库`, () => {
        assert.equal(r.status, 200, r.message);
        assert.deepEqual(r.data?.changedFields, ["货物清单"], `没认出清单改了：${JSON.stringify(r.data?.changedFields)}`);
        const want = String(Object.values(patch)[0]);
        assert.equal(String(row[dbField] === null ? "" : Number.isNaN(Number(row[dbField])) ? row[dbField] : Number(row[dbField])), want,
          `${name} 没写进库：库里是 ${row[dbField]}，该是 ${want}`);
      });
    }
  }

  // ── N：这次复核修的几条 ────────────────────────────────────────────────
  {
    /* N1：推状态时填了比装柜日期更早的日期，之后改不相干的字段不该被拦
       （复核实测：上一版连只改金额都 400，签收后金额彻底改不了）。 */
    const f = await makeFcl({ loadingDate: "2026-09-10" });
    await must("POST /admin/containers/status", ADMIN, { id: f.containerId, toStatus: "IN_TRANSIT", date: "2026-09-08" });
    const r1 = await call("POST /staff/fcl-containers/update", STAFF, toUpdateBody(f, { amountCny: "555" }));
    expect("N1) 推状态填了更早的日期：之后只改金额不该被「装柜日期」那道检查拦住", () => {
      assert.equal(r1.status, 200, `被拦了：${r1.message}`);
    });
    const r2 = await call("POST /staff/fcl-containers/update", STAFF, toUpdateBody(f, { loadingDate: "2026-09-12" }));
    expect("N1b) 但真把装柜日期往后挪到已开船之后，照样要拦", () => {
      assert.equal(r2.status, 400, `居然让改了（${r2.status}）`);
      assert.match(r2.message, /装柜日期不能晚于后面已经走过的那几步/, r2.message);
    });
  }
  {
    /* N2：柜子撤回「已封柜」但运单还停在派送中 —— 海陆不许改
       （复核实测：上一版只看柜子状态，这种局面放行了，海运八步轨迹留在陆运柜上）。 */
    const f = await makeFcl({ transportMode: "sea" });
    for (const s of ["IN_TRANSIT", "ARRIVED", "CUSTOMS", "CUSTOMS_CLEARED", "UNLOADING", "IN_WAREHOUSE_TH"]) {
      await must("POST /admin/containers/status", ADMIN, { id: f.containerId, toStatus: s, date: "2026-09-15" });
    }
    await must("POST /admin/lastmile/orders", ADMIN, { shipmentIds: [f.shipmentId], carrierName: "测试", externalTrackingNo: "ZZ-N2" });
    for (let i = 0; i < 8; i++) {
      const c = await pm.container.findUnique({ where: { id: f.containerId }, select: { currentStatus: true } });
      if (c.currentStatus === "SEALED") break;
      const u = await call("POST /admin/containers/status/undo", ADMIN, { id: f.containerId });
      if (u.status !== 200) break;
    }
    const c = await pm.container.findUnique({ where: { id: f.containerId }, select: { currentStatus: true } });
    const sp = await pm.shipment.findUnique({ where: { id: f.shipmentId }, select: { currentStatus: true } });
    const r = await call("POST /staff/fcl-containers/update", STAFF, toUpdateBody(f, { transportMode: "land" }));
    expect("N2) 柜子撤回「已封柜」但运单还在派送中：海运/陆运还是不许改", () => {
      assert.equal(c.currentStatus, "SEALED", `前提没造出来：柜子是 ${c.currentStatus}`);
      assert.notEqual(sp.currentStatus, "loaded", `前提没造出来：运单是 ${sp.currentStatus}`);
      assert.equal(r.status, 400, `居然让改了（${r.status}）—— 海运的轨迹会留在陆运柜上`);
      assert.match(r.message, /海运 \/ 陆运不能再改/, r.message);
    });
  }
  {
    /* N2b：闸③那三个条件要**各自都能拦住**（2026-09-24 复核抓到假绿）：
       N2 那个场景里「运单动了」和「有多余轨迹」同时成立，删掉任意一个条件测试照样绿。
       这里各造一个「只有它成立」的局面。 */
    // 只有「柜子动了」：推一步，运单跟着到 departed —— 撤销会把两边一起撤回，所以单独造法是不撤
    const a = await makeFcl({ transportMode: "sea" });
    await must("POST /admin/containers/status", ADMIN, { id: a.containerId, toStatus: "IN_TRANSIT", date: "2026-09-15" });
    const ra = await call("POST /staff/fcl-containers/update", STAFF, toUpdateBody(a, { transportMode: "land" }));
    expect("N2b) 柜子推过状态：海陆不许改", () => {
      assert.equal(ra.status, 400, `居然让改了（${ra.status}）`);
    });
    // 只有「有多余轨迹」：柜子和运单都在起点，但轨迹多了一条（手工补的那种）
    const b = await makeFcl({ transportMode: "sea" });
    await pm.statusLog.create({ data: {
      id: `sl_zz_${Date.now()}`, companyId: CO, shipmentId: b.shipmentId,
      operatorId: STAFF.userId, operatorRole: "staff", operatorName: "测试",
      fromStatus: "loaded", toStatus: "loaded", remark: "补一条不改状态的记录",
      changedAt: new Date("2026-09-12"),
    } });
    const cB = await pm.container.findUnique({ where: { id: b.containerId }, select: { currentStatus: true } });
    const sB = await pm.shipment.findUnique({ where: { id: b.shipmentId }, select: { currentStatus: true } });
    const rb = await call("POST /staff/fcl-containers/update", STAFF, toUpdateBody(b, { transportMode: "land" }));
    expect("N2c) 柜子和运单都在起点、但轨迹多了一条：海陆也不许改", () => {
      assert.equal(cB.currentStatus, "SEALED", `前提没造出来：柜子 ${cB.currentStatus}`);
      assert.equal(sB.currentStatus, "loaded", `前提没造出来：运单 ${sB.currentStatus}`);
      assert.equal(rb.status, 400, `居然让改了（${rb.status}）—— 多出来的轨迹属于哪套流程说不清`);
    });
  }
  {
    /* N3：改了装柜日期，撤销用的那份快照也要跟着改，
       否则员工随便撤一步，装柜时间就悄悄退回旧日期（复核实测）。 */
    const f = await makeFcl({ loadingDate: "2026-09-10" });
    await must("POST /admin/containers/status", ADMIN, { id: f.containerId, toStatus: "IN_TRANSIT", date: "2026-09-15" });
    await must("POST /staff/fcl-containers/update", STAFF, toUpdateBody(f, { loadingDate: "2026-09-05" }));
    await must("POST /admin/containers/status/undo", ADMIN, { id: f.containerId });
    const db = await dbOf(f.containerId);
    const dates = JSON.parse(db.statusDates ?? "{}");
    expect("N3) 改完装柜日期再撤销一步：柜子时间表里「已封柜」那格不许退回旧日期", () => {
      assert.equal(String(dates.SEALED).slice(0, 10), "2026-09-05",
        `撤销把装柜时间退回去了：${dates.SEALED}（该是 2026-09-05）`);
    });
  }
  {
    /* N4：两个人同时开着编辑框，后保存的不许把前一个人的改动整份冲掉。 */
    const f = await makeFcl();
    const before = await dbOf(f.containerId);
    const version = new Date(before.updatedAt).toISOString();
    // B 先加了一行货
    await must("POST /staff/fcl-containers/update", STAFF, toUpdateBody(f, { products: [ROW_A, ROW_B] }));
    // A 拿着打开时那份旧表单只改金额
    const r = await call("POST /staff/fcl-containers/update", STAFF, toUpdateBody(f, { amountCny: "1", expectUpdatedAt: version }));
    const db = await dbOf(f.containerId);
    expect("N4) 别人刚改过：拿旧版本保存要被挡住，B 加的那行货还在", () => {
      assert.equal(r.status, 409, `居然覆盖了（${r.status} ${r.message}）`);
      assert.match(r.message, /刚刚被别人改过/, r.message);
      assert.equal(db.items[0].shipment.order.products.length, 2, "B 加的那行货被冲掉了");
    });
    // 带上最新版本号就该放行
    const r2 = await call("POST /staff/fcl-containers/update", STAFF, toUpdateBody(f, {
      products: [ROW_A, ROW_B], amountCny: "1", expectUpdatedAt: new Date(db.updatedAt).toISOString(),
    }));
    expect("N4b) 带最新版本号保存照常放行", () => assert.equal(r2.status, 200, r2.message));
  }
  {
    /* N5：两条老的「改运单」接口不许再碰整柜 —— 它们能绕开上面那三道闸，
       而且只改订单和运单、柜内记录不跟着改（复核实测：已签收的整柜从老接口改成 999 箱返回 200）。 */
    const f = await makeFcl();
    await pm.shipment.update({ where: { id: f.shipmentId }, data: { currentStatus: "delivered" } });
    const dbBefore = await dbOf(f.containerId);
    const orderIdOf = dbBefore.items[0].shipment.orderId;
    /* 参数照两条接口自己的签名填全（admin 要 orderId，员工那条要一整份运单资料）——
       填不全的话会被参数校验先挡住，看起来「拦住了」其实根本没走到整柜那道判断。 */
    const a = await call("POST /admin/orders/update", ADMIN, {
      orderId: orderIdOf, itemName: "被改的品名", packageCount: 999, productQuantity: 999,
      packageUnit: "box", transportMode: "sea", cargoType: "normal",
    });
    /* ⚠️ 参数必须填到「拿掉整柜拒绝之后真能写进库」的程度（2026-09-24 复核抓到假绿）：
       上一版少了 orderCreatedDate，请求先被参数校验挡住，
       于是把整柜拒绝删掉、N5c 照样绿 —— 等于没测到这条路。 */
    const b = await call("POST /staff/orders/patch-shipment-bundle", STAFF, {
      shipmentId: f.shipmentId, trackingNo: f.trackingNo, itemName: "被改的品名",
      packageCount: 999, productQuantity: 999, packageUnit: "box", transportMode: "sea",
      orderCreatedDate: "2026-09-01", weightKg: 1, volumeM3: 1,
      receiverNameTh: "收货人", receiverPhoneTh: "0800000000", receiverAddressTh: "地址",
    });
    const db = await dbOf(f.containerId);
    expect("N5) 超管「改运单」碰整柜：整张拒绝", () => {
      assert.equal(a.status, 400, `居然让改了（${a.status}）`);
      assert.match(a.message, /请到「整柜管理」里点「编辑」改/, a.message);
    });
    expect("N5b) 员工「改运单」碰整柜：整张拒绝", () => {
      assert.equal(b.status, 400, `居然让改了（${b.status}）`);
      assert.match(b.message, /请到「整柜管理」里点「编辑」改/, b.message);
    });
    expect("N5c) 被拦下来之后，箱数一个字没被改", () => {
      assert.equal(db.items[0].shipment.packageCount, 10, `运单箱数被改成了 ${db.items[0].shipment.packageCount}`);
      assert.equal(db.items[0].loadedPieceCount, 10, `柜内记录被改成了 ${db.items[0].loadedPieceCount}`);
    });
  }

  // ── P：四方复核第二批（2026-09-24）——每条都是实测复现过的 ──────────────
  {
    /* P1：柜号和提单号**跨表**查重。客户看得到提单号、看不到柜号，
       所以提单号一旦变成某个真柜号，就等于把柜号发给客户了。 */
    const a = await makeFcl();
    const r1 = await call("POST /staff/fcl-containers/update", STAFF,
      toUpdateBody(a, { trackingNo: a.containerNo, containerNo: a.trackingNo }));
    expect("P1) 把柜号和提单号对调：拦住（冲突来自自己的另一个号，查重不能排除自己）", () => {
      assert.equal(r1.status, 409, `居然让改了（${r1.status}）—— 客户会在提单号那栏看到柜号`);
      assert.match(r1.message, /是一个柜号/, r1.message);
    });
    const b = await makeFcl();
    const r2 = await call("POST /staff/fcl-containers/update", STAFF, toUpdateBody(b, { trackingNo: a.containerNo }));
    expect("P1b) 把提单号填成别的柜的柜号：拦住", () => {
      assert.equal(r2.status, 409, `居然让改了（${r2.status}）`);
    });
    const r3 = await call("POST /staff/fcl-containers/update", STAFF, toUpdateBody(b, { containerNo: a.trackingNo }));
    expect("P1c) 把柜号填成别的单的提单号：拦住", () => {
      assert.equal(r3.status, 409, `居然让改了（${r3.status}）`);
    });
    const r4 = await call("POST /staff/fcl-containers/update", STAFF, toUpdateBody(b, { remark: "只改备注" }));
    expect("P1d) 但什么都不改照样能保存（跨表查重没有误伤自己）", () => {
      assert.equal(r4.status, 200, `原样保存被拦了：${r4.message}`);
    });
  }
  {
    /* P2：没有 2 月 31 日。`new Date("2026-02-31")` 不报错，会顺延成 3-03 静默收下。 */
    const f = await makeFcl();
    for (const bad of ["2026-02-31", "2026-13-01", "2026-09-99", "26-09-10", "2026/09/10"]) {
      const r = await call("POST /staff/fcl-containers/update", STAFF, toUpdateBody(f, { loadingDate: bad }));
      expect(`P2) 装柜日期填「${bad}」：拦住`, () => {
        assert.equal(r.status, 400, `居然收下了（${r.status}）`);
      });
    }
    const ok = await call("POST /staff/fcl-containers/update", STAFF, toUpdateBody(f, { loadingDate: "2026-09-08" }));
    expect("P2b) 正常日期照旧收", () => assert.equal(ok.status, 200, ok.message));
  }
  {
    /* P3：清单没动就不许重写汇总 —— 否则已排派送单的柜，只改个金额也会把箱数悄悄改掉，
       而闸②只在「清单改了」时才拦，等于绕过去了。 */
    const f = await makeFcl();
    const oid = (await pm.shipment.findUnique({ where: { id: f.shipmentId }, select: { orderId: true } })).orderId;
    // 造出「汇总跟产品行对不上」（模拟别的入口改过）
    await pm.order.update({ where: { id: oid }, data: { packageCount: 12 } });
    await pm.shipment.update({ where: { id: f.shipmentId }, data: { packageCount: 12 } });
    await pm.shipmentContainerItem.updateMany({ where: { containerId: f.containerId }, data: { loadedPieceCount: 12 } });
    const r = await call("POST /staff/fcl-containers/update", STAFF, toUpdateBody(f, { amountCny: "3210" }));
    const od = await pm.order.findUnique({ where: { id: oid }, select: { packageCount: true, receivableAmountCny: true } });
    const sp = await pm.shipment.findUnique({ where: { id: f.shipmentId }, select: { packageCount: true } });
    const it = await pm.shipmentContainerItem.findFirst({ where: { containerId: f.containerId }, select: { loadedPieceCount: true } });
    expect("P3) 清单没动，只改金额：箱数一个字都不许动", () => {
      assert.equal(r.status, 200, r.message);
      assert.deepEqual(r.data?.changedFields, [], JSON.stringify(r.data?.changedFields));
      assert.equal(od.packageCount, 12, `订单箱数被悄悄改成了 ${od.packageCount}`);
      assert.equal(sp.packageCount, 12, `运单箱数被悄悄改成了 ${sp.packageCount}`);
      assert.equal(it.loadedPieceCount, 12, `柜内记录被悄悄改成了 ${it.loadedPieceCount}`);
      assert.equal(Number(od.receivableAmountCny), 3210, "金额没写进去");
    });
    // 清单真改了的时候，三处还是要一起重算
    const r2 = await call("POST /staff/fcl-containers/update", STAFF, toUpdateBody(f, { products: [ROW_A, ROW_B] }));
    const od2 = await pm.order.findUnique({ where: { id: oid }, select: { packageCount: true } });
    const it2 = await pm.shipmentContainerItem.findFirst({ where: { containerId: f.containerId }, select: { loadedPieceCount: true } });
    expect("P3b) 清单真改了：三处汇总照样一起重算", () => {
      assert.equal(r2.status, 200, r2.message);
      assert.equal(od2.packageCount, 15, `订单箱数没重算：${od2.packageCount}`);
      assert.equal(it2.loadedPieceCount, 15, `柜内记录没重算：${it2.loadedPieceCount}`);
    });
  }
  {
    /* P4：客户看不到柜号 —— 连员工手写在备注和「下一站」里的也不行。 */
    const f = await makeFcl({ containerNo: "ZZLEAKCN01" });
    await pm.statusLog.create({ data: {
      id: `sl_ctn_${Date.now()}`, companyId: CO, shipmentId: f.shipmentId,
      operatorId: ADMIN.userId, operatorRole: "admin", operatorName: "超管",
      fromStatus: "loaded", toStatus: "departed",
      remark: "柜号 ZZLEAKCN01 已开船", nextStop: "ZZLEAKCN01 到港",
      changedAt: new Date("2026-09-15"),
    } });
    const CLIENT: Auth = { userId: CLIENT_ID, companyId: CO, role: "client", name: "测试客户" };
    const d = await must("GET /client/fcl-containers/detail", CLIENT, {}, { containerId: f.containerId });
    expect("P4) 员工手写备注 / 下一站里带柜号：客户那边也看不到", () => {
      assert.ok(!JSON.stringify(d).includes("ZZLEAKCN01"), "柜号漏给客户了");
    });
    // 员工自己那边要照旧看得见（脱敏只对客户）
    const ds = await must("GET /staff/fcl-containers/detail", STAFF, {}, { containerId: f.containerId });
    expect("P4b) 员工自己看详情，备注原样不动", () => {
      assert.ok(JSON.stringify(ds).includes("ZZLEAKCN01"), "把员工那边也抹了，员工看不到柜号了");
    });
  }
  {
    /* P5：整柜起步那条「已装柜」不许被单删 —— 删了客户轨迹就少了第一步，
       改整柜里靠它同步装柜日期的两段也会整段跳过。 */
    const f = await makeFcl();
    await must("POST /admin/containers/status", ADMIN, { id: f.containerId, toStatus: "IN_TRANSIT", date: "2026-09-15" });
    const start = await pm.statusLog.findFirst({ where: { shipmentId: f.shipmentId, fromStatus: "created" }, select: { id: true } });
    const r = await call("POST /staff/shipments/track/delete-log", STAFF, { logId: start.id, shipmentId: f.shipmentId });
    const still = await pm.statusLog.findUnique({ where: { id: start.id }, select: { id: true } });
    expect("P5) 整柜的「已装柜」起步轨迹：不许单删", () => {
      assert.notEqual(r.status, 200, `居然删掉了（${r.status}）`);
      assert.ok(still, "那条轨迹真的被删了");
    });
  }

  await cleanup();
  const left = await pm.container.count({ where: { companyId: CO } });
  expect("Z) 测试数据清干净了", () => assert.equal(left, 0, `还剩 ${left} 条`));

  await prisma.$disconnect();
  if (failures > 0) { console.log(`❌ 失败 ${failures} 项`); process.exit(1); }
  console.log("✅ 改整柜（真库）：全部通过");
}

main().catch((e) => { console.error(e); process.exit(1); });
