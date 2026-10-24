/**
 * 2026-10-24 老板：「不要给客户任何编辑的权限」「订单照片的权限改了」（安全审查 NEW-04）—— 真库 + 真路由。
 *
 * 原来：客户自己的订单不管到哪一步，后台都让他传照片、删照片（6-10 617d103 拿掉了状态限制），
 *       连仓库员工传的入库照也能删（客户页面上没有删除按钮，是直接调接口）。
 * 现在：
 *   Q1 客户页面真流程：报预报单 → 马上传照片，照常成功（这是「下单那一下附照片」，不算改）
 *   Q2 预报单建好 1 小时以后再传：挡住（59 分钟还行）
 *   Q3 仓库收了货的单：刚建也不许传
 *   Q4 员工建的单（不是客户自己报的）：不许传
 *   Q5 别的客户的单：照旧挡
 *   Q6 客户删照片：自己传的、员工传的都删不了，记录和文件都还在
 *   Q7 员工、超管照旧能传能删
 *   Q8 客户上传那一刻仓库正在确认收货：等收货提交后按「已收货」判，挡住，不留文件（锁后重读）
 *   Q9 同一张单同时传好几张、只差一张就到上限：只进一张，没进的文件也删干净
 *   Q11 1 小时按请求进来的时间算：59 分 58 秒时发来、在订单锁上等了几秒，照样能传
 * 收尾规则（文件留不留、回什么话、哪些错算同事在处理）是纯逻辑，在 test-order-photo-rules.ts 里测（不连库）。
 *
 * 只连一次性库：DATABASE_URL 不是 Neon 时要 AGENT_PORTAL_TEST_ALLOW_DB=1。测试数据前缀 zz_cpl_，跑完清到 0。
 */
process.env.TZ = process.env.TZ || "UTC";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Auth = { userId: string; companyId: string; role: "admin" | "staff" | "client"; name: string };
type Row = Record<string, any>;

const CO = "zz_cpl_co";
const ADMIN: Auth = { userId: "zz_cpl_admin", companyId: CO, role: "admin", name: "照片超管" };
const STAFF: Auth = { userId: "zz_cpl_staff", companyId: CO, role: "staff", name: "照片员工" };
const C1: Auth = { userId: "ZZCPLC1", companyId: CO, role: "client", name: "照片客户一" };
const C2: Auth = { userId: "ZZCPLC2", companyId: CO, role: "client", name: "照片客户二" };
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const MIN = 60 * 1000;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url || url.includes("blocked")) { console.log("⚠️ 跳过：没有 DATABASE_URL（CI 没有数据库）—— 这一项等于没测"); return; }
  if (!url.includes("neon.tech") && process.env.AGENT_PORTAL_TEST_ALLOW_DB !== "1") {
    console.log("⚠️ 跳过：DATABASE_URL 不是 Neon 测试库，怕连到生产库不跑（确认是测试库可设 AGENT_PORTAL_TEST_ALLOW_DB=1）—— 这一项等于没测");
    return;
  }
  process.env.NODE_ENV = process.env.NODE_ENV || "test";
  // Q9 同时要 5 条连接（持锁 1 + 上传 3 + 查等锁 1）；Prisma 默认连接数 = CPU 数 × 2 + 1，单核机器只有 3 条，写明给够（dsh 第 4 轮）
  if (!/[?&]connection_limit=/.test(url)) process.env.DATABASE_URL = `${url}${url.includes("?") ? "&" : "?"}connection_limit=10`;
  const imagesDir = fs.mkdtempSync(path.join(os.tmpdir(), "zz_cpl_images_"));
  process.env.IMAGES_DIR = imagesDir;
  const { prisma } = await import("../apps/api/src/db/prisma");
  const { BusinessError } = await import("../apps/api/src/modules/core/business-error");
  const { CLIENT_PHOTO_LOCKED_MESSAGE } = await import("../apps/api/src/modules/orders/product-images");
  const pm: any = prisma;

  const routes = new Map<string, Function>();
  const app: any = {};
  for (const m of ["get", "post", "put", "patch", "delete"]) app[m] = (p: string, h: Function) => routes.set(`${m.toUpperCase()} ${p}`, h);
  (await import("../apps/api/src/modules/orders/routes")).registerOrderRoutes(app);

  async function call(key: string, auth: Auth, body: Row = {}, query: Record<string, string> = {}): Promise<{ status: number; data: any; message: string }> {
    const handler = routes.get(key);
    if (!handler) return { status: 404, data: undefined, message: `没有这个接口：${key}` };
    let status = 200; let raw: any;
    const res: any = { status(s: number) { status = s; return res; }, json(p: any) { raw = p; }, setHeader() {} };
    try { await handler({ body, query, headers: {}, auth: { agentId: null, ...auth } }, res); }
    catch (e) {
      if (e instanceof BusinessError) { status = e.httpStatus; raw = { code: e.code, message: e.message }; }
      else { status = 500; raw = { message: `【未翻成业务错误的异常】${(e as Error)?.message ?? e}` }; }
    }
    return { status, data: raw?.data, message: raw?.message ?? "" };
  }
  const upload = (auth: Auth, orderId: string) =>
    call("POST /staff/orders/product-images", auth, { orderId, fileName: "a.png", mime: "image/png", contentBase64: PNG });
  const remove = (auth: Auth, id: string) => call("DELETE /staff/orders/product-images", auth, {}, { id });
  const images = (orderId: string) => pm.orderProductImage.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
  /** 客户报一张预报单（跟客户页面同一条接口），返回订单 id */
  let seq = 0;
  async function prealert(auth: Auth = C1): Promise<string> {
    seq += 1;
    const r = await call("POST /client/prealerts", auth, { warehouseId: "wh_yiwu_01", transportMode: "sea", products: [{ itemName: `照片测试${seq}`, packageCount: 2 }] });
    assert.equal(r.status, 200, `报预报单失败：${r.message}`);
    return r.data.prealertId;
  }
  const ageOrder = (id: string, minutes: number) => pm.order.update({ where: { id }, data: { createdAt: new Date(Date.now() - minutes * MIN) } });

  async function cleanup(): Promise<void> {
    const orders = await pm.order.findMany({ where: { companyId: CO }, select: { id: true } });
    const ids = orders.map((o: Row) => o.id);
    await pm.orderProductImage.deleteMany({ where: { companyId: CO } });
    await pm.statusLog.deleteMany({ where: { companyId: CO } });
    await pm.shipment.deleteMany({ where: { companyId: CO } });
    if (ids.length) await pm.orderProduct.deleteMany({ where: { orderId: { in: ids } } });
    await pm.order.deleteMany({ where: { companyId: CO } });
    await pm.auditLog.deleteMany({ where: { companyId: CO } });
    await pm.user.deleteMany({ where: { companyId: CO } });
  }

  let passed = 0, failed = 0;
  async function check(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`✅ ${name}`); }
    catch (e: any) { failed++; console.log(`❌ ${name}\n   ${e?.message ?? e}`); }
  }

  console.log("客户不能改订单照片（真库 + 真路由）");
  await cleanup();
  try {
    for (const u of [ADMIN, STAFF, C1, C2]) {
      await pm.user.create({ data: { id: u.userId, companyId: CO, role: u.role, name: u.name, passwordHash: "x", phone: `0${u.userId}`, status: "active" } });
    }

    await check("Q1 客户页面真流程：报预报单 → 马上传两张照片，照常成功（下单那一下附照片不算改）", async () => {
      const id = await prealert();
      assert.equal((await pm.order.findUnique({ where: { id } })).approvalStatus, "shipped", "客户报的预报单状态变了，规则要跟着改");
      for (let i = 0; i < 2; i++) { const r = await upload(C1, id); assert.equal(r.status, 200, r.message); }
      const imgs = await images(id);
      assert.equal(imgs.length, 2);
      assert.ok(imgs.every((x: Row) => x.uploadedBy === C1.userId));
    });

    await check("Q2 建好 59 分钟还能传；1 小时以后再传：挡住、提示找客服、一张都不多", async () => {
      const id = await prealert();
      await ageOrder(id, 59);
      assert.equal((await upload(C1, id)).status, 200, "59 分钟就挡了，下单时网慢、照片多的会被误挡");
      await ageOrder(id, 61);
      const r = await upload(C1, id);
      assert.equal(r.status, 403, `过了 1 小时还能传（${r.status}）`);
      assert.equal(r.message, CLIENT_PHOTO_LOCKED_MESSAGE);
      assert.equal((await images(id)).length, 1);
    });

    await check("Q3 仓库收了货的单：刚建也不许客户传", async () => {
      const id = await prealert();
      await pm.order.update({ where: { id }, data: { approvalStatus: "received" } });
      const r = await upload(C1, id);
      assert.equal(r.status, 403, `收了货还能传（${r.status}）`);
      assert.equal(r.message, CLIENT_PHOTO_LOCKED_MESSAGE);
      assert.equal((await images(id)).length, 0);
    });

    await check("Q4 员工建给客户的单（不是客户自己报的）：客户不许传", async () => {
      const r0 = await call("POST /staff/orders", STAFF, { clientId: C1.userId, trackingNo: "ZZCPLSTAFF1", warehouseId: "wh_yiwu_01", itemName: "鞋", packageCount: 2, transportMode: "sea", arrivedAt: "2026-10-20" });
      assert.equal(r0.status, 200, r0.message);
      // 直接用员工建出来的那一张（Codex 10-24：原来按「不是 shipped 的最新一张」去找，会捡到 Q3 那张已收货的，假绿）
      const order = await pm.order.findUnique({ where: { id: r0.data.orderId } });
      assert.ok(order, "员工建的单没找到");
      assert.equal(order.clientId, C1.userId);
      assert.equal(order.approvalStatus, "approved", `员工建的单状态是 ${order.approvalStatus}，规则要跟着改`);
      const r = await upload(C1, order.id);
      assert.equal(r.status, 403, `员工建的单客户还能传（${r.status}）`);
      assert.equal((await images(order.id)).length, 0);
    });

    await check("Q5 别的客户刚报的单：照旧挡", async () => {
      const id = await prealert(C2);
      const r = await upload(C1, id);
      assert.equal(r.status, 403);
      assert.equal((await images(id)).length, 0);
    });

    await check("Q6 客户删照片：自己刚传的、员工传的都删不了，记录和文件都还在", async () => {
      const id = await prealert();
      assert.equal((await upload(C1, id)).status, 200);
      assert.equal((await upload(STAFF, id)).status, 200);
      const imgs = await images(id);
      assert.equal(imgs.length, 2);
      for (const img of imgs) {
        const r = await remove(C1, img.id);
        assert.equal(r.status, 403, `客户把照片删了（${r.status}）`);
        assert.ok(fs.existsSync(path.join(imagesDir, path.basename(img.filePath))), "照片文件被删了");
      }
      assert.equal((await images(id)).length, 2);
    });

    await check("Q7 员工、超管照旧：收了货、过了 1 小时的单也能传能删（删了文件也删）", async () => {
      const id = await prealert();
      await pm.order.update({ where: { id }, data: { approvalStatus: "received", createdAt: new Date(Date.now() - 120 * MIN) } });
      for (const who of [STAFF, ADMIN]) {
        const up = await upload(who, id);
        assert.equal(up.status, 200, `${who.role} 传不了：${up.message}`);
      }
      const imgs = await images(id);
      assert.equal(imgs.length, 2);
      for (const [i, who] of [STAFF, ADMIN].entries()) {
        const r = await remove(who, imgs[i].id);
        assert.equal(r.status, 200, `${who.role} 删不了：${r.message}`);
        assert.ok(!fs.existsSync(path.join(imagesDir, path.basename(imgs[i].filePath))), "员工删了照片，文件还在");
      }
      assert.equal((await images(id)).length, 0);
    });

    /** 磁盘上属于这张单的照片文件（文件名以订单号开头），用来核「没进库的文件删干净了」 */
    const filesOf = (orderId: string) => fs.readdirSync(imagesDir).filter((f) => f.startsWith(`${orderId.replace(/[^a-zA-Z0-9_-]/g, "_")}_`));

    /**
     * 模拟另一边（确认收货 / 别的同事）拿着这张单的订单锁不放；mutate 是锁住以后、提交以前要改的东西。
     * 等「上传都写完文件、都卡在锁上」再放锁，保证上传真走到了锁里那一遍（dsh / Codex 第 2 轮：只靠 Promise.all 不确定）
     */
    async function withOrderLockHeld(id: string, mutate: ((tx: any) => Promise<void>) | null, start: () => Promise<Array<{ status: number; message: string }>>, expectWaiting: number, holdExtraMs = 0) {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let locked!: () => void;
      const lockedNow = new Promise<void>((r) => { locked = r; });
      const holder = pm.$transaction(async (tx: any) => {
        await tx.$queryRaw`SELECT id FROM orders WHERE id = ${id} FOR NO KEY UPDATE`;
        if (mutate) await mutate(tx);
        locked();
        await gate;
      }, { timeout: 30_000, maxWait: 10_000 });
      // 持锁那一边出错的话别一直干等
      await Promise.race([lockedNow, holder.then(() => { throw new Error("持锁事务没等到放锁就结束了"); }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("10 秒没锁上订单")), 10_000))]);
      const pending = start();
      let waiting = 0;
      let files = 0;
      try {
        for (let i = 0; i < 160 && (waiting < expectWaiting || files < expectWaiting); i += 1) {
          // 只数这个库、这个账号的会话（dsh 第 3 轮：共用测试库上别的用例也可能在等 orders 的锁）
          const rows: Array<{ n: number }> = await pm.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE pid <> pg_backend_pid() AND datname = current_database() AND usename = current_user
              AND wait_event_type = 'Lock' AND query ILIKE '%FROM orders%FOR NO KEY UPDATE%'`;
          waiting = rows[0]?.n ?? 0;
          files = filesOf(id).length;
          if (waiting < expectWaiting || files < expectWaiting) await new Promise((r) => setTimeout(r, 50));
        }
        if (holdExtraMs) await new Promise((r) => setTimeout(r, holdExtraMs));
      } finally {
        release();
        await holder;
      }
      return { results: await pending, waiting, files };
    }

    await check("Q8 客户上传那一刻仓库正在确认收货：等收货提交后按「已收货」判，挡住，不留文件", async () => {
      const id = await prealert();
      const { results, waiting, files } = await withOrderLockHeld(
        id,
        async (tx) => { await tx.order.update({ where: { id }, data: { approvalStatus: "received" } }); },
        async () => [await upload(C1, id)],
        1,
      );
      assert.ok(waiting >= 1 && files >= 1, `上传没写完文件 / 没卡在订单锁上（等锁 ${waiting}、文件 ${files}），这一项没测到并发`);
      const r = results[0];
      assert.equal(r.status, 403, `收货提交后还是传进去了（${r.status}）：${r.message}`);
      assert.equal(r.message, CLIENT_PHOTO_LOCKED_MESSAGE);
      assert.equal((await images(id)).length, 0);
      assert.deepEqual(filesOf(id), [], "挡住了但文件留在磁盘上");
    });

    await check("Q9 同一张单同时传 3 张、只差 1 张到上限：三张都排到锁里，只进 1 张，没进的 2 个文件删干净", async () => {
      const { MAX_ORDER_PRODUCT_IMAGES } = await import("../apps/api/src/modules/orders/product-images");
      const id = await prealert();
      await pm.orderProductImage.createMany({ data: Array.from({ length: MAX_ORDER_PRODUCT_IMAGES - 1 }, (_, i) => ({
        id: `zz_cpl_fill_${i}`, companyId: CO, orderId: id, fileName: `fill${i}.png`, mime: "image/png", contentBase64: "x", uploadedBy: STAFF.userId,
      })) });
      // 同时要 5 条数据库连接（持锁 1 + 上传 3 + 查等锁 1）；Prisma 默认连接数 = CPU 数 × 2 + 1，2 核以上都够
      const { results: rs, waiting, files } = await withOrderLockHeld(
        id, null, () => Promise.all([upload(STAFF, id), upload(STAFF, id), upload(ADMIN, id)]), 3,
      );
      assert.ok(waiting >= 3 && files >= 3, `三张没都排到锁里（等锁 ${waiting}、文件 ${files}），这一项没测到并发`);
      const okCount = rs.filter((r) => r.status === 200).length;
      assert.equal(okCount, 1, `进了 ${okCount} 张：${JSON.stringify(rs.map((r) => [r.status, r.message]))}`);
      assert.ok(rs.filter((r) => r.status !== 200).every((r) => r.status === 400 && /image limit reached/.test(r.message)), JSON.stringify(rs.map((r) => [r.status, r.message])));
      assert.equal(await pm.orderProductImage.count({ where: { orderId: id } }), MAX_ORDER_PRODUCT_IMAGES);
      assert.equal(filesOf(id).length, 1, `磁盘上有 ${filesOf(id).length} 个文件（没进库的没删）`);
    });

    await check("Q11 1 小时按请求进来的时间算：59 分 58 秒时发来、在订单锁上等了 3 秒，照样能传", async () => {
      const id = await prealert();
      await pm.order.update({ where: { id }, data: { createdAt: new Date(Date.now() - 60 * MIN + 2_000) } });
      const { results, waiting, files } = await withOrderLockHeld(id, null, async () => [await upload(C1, id)], 1, 3_000);
      assert.ok(waiting >= 1 && files >= 1, `上传没卡在订单锁上（等锁 ${waiting}、文件 ${files}），这一项没测到`);
      assert.equal(results[0].status, 200, `请求进来时还在 1 小时内，等了一会儿锁就被挡了（${results[0].status}）：${results[0].message}`);
      assert.equal((await images(id)).length, 1);
    });
  } finally {
    await cleanup();
    const left = (await pm.order.count({ where: { companyId: CO } })) + (await pm.orderProductImage.count({ where: { companyId: CO } }))
      + (await pm.user.count({ where: { companyId: CO } }));
    if (left) { failed++; console.log(`❌ 测试数据没清干净：还剩 ${left} 行`); }
    await prisma.$disconnect();
    fs.rmSync(imagesDir, { recursive: true, force: true });
  }
  console.log(`\n客户不能改订单照片：通过 ${passed}，不通过 ${failed}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
