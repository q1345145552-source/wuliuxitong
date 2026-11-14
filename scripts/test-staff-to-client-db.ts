/**
 * 员工号改成客户号（2026-11-14 老板「a」：客服在「员工管理」把客户 XHH-6669 建成了员工号，管理员要能在系统里自己改）—— 连库（真 handler + 真 PostgreSQL）。
 *
 *   C1 没用过的员工号：改成客户号；只动 role（+ 清员工备注），密码 / 名字 / 手机 / 封没封都不动；客户名单里有、员工名单里没了；原来的员工登录当场失效
 *   C2 封着的员工号也能改，改完还是封着（回的 status = inactive）
 *   C3 用过的（留下过操作记录 / AI 会话）不许改：409、角色没动
 *   C4 只开过浏览器通知（cs_push_subscriptions）不算用过：照改
 *   C5 只认本公司员工号：客户号 / 超管 / 代理 409 不动；别家公司 404；没这个号 404；没选 400
 *   C6 只有超管能改：员工 / 客户 / 代理 403
 *   C7 锁里再核：查之前另一条连接锁住这一行、塞了一条操作记录还没提交 → 请求卡在锁上 → 放锁后看到记录 → 409、角色没动
 *   C8 记账号的列（user-references.ts）在库里全都真有：拿不存在的号查一遍不报错、一条都没有
 *   C9 （dsh 第 1 轮）没有外键的员工记录也拦：轨迹 operator_id、聊天 sender_id；被删掉的轨迹整条存在审计记录里（能恢复）也拦；
 *      审计记录里只有「长得像」的号（多一个字 / 下划线当通配符）不误拦
 *   C10 当初没设密码的员工号：不许改（客户号必须有密码，改过去登不进），409 叫他先设；设好再改就行（Codex 第 1 轮）
 *   C11 别人锁着这一行超过 3 秒：409「正被别人改着」，角色没动
 *
 * 只连测试库：DATABASE_URL 不带 neon.tech 的不跑（一次性库设 AGENT_PORTAL_TEST_ALLOW_DB=1）。测试数据全在假公司 zz_s2c_co / zz_s2c_co2 下，跑前跑后都清。
 */
import assert from "node:assert/strict";

type Row = Record<string, any>;
type Auth = { userId: string; companyId: string; role: string; name: string; agentId: string | null };
const CO = "zz_s2c_co";
const CO2 = "zz_s2c_co2";
const ADMIN: Auth = { userId: "zz_s2c_admin", companyId: CO, role: "admin", name: "超管", agentId: null };
const STAFF: Auth = { userId: "zz_s2c_staff", companyId: CO, role: "staff", name: "员工", agentId: null };
const AGENT: Auth = { userId: "zz_s2c_agent_user", companyId: CO, role: "agent", name: "代理", agentId: "zz_s2c_agent" };
const CLIENT: Auth = { userId: "ZZS2C01", companyId: CO, role: "client", name: "客户一", agentId: null };
const NEW1 = "ZZS2C-NEW1";      // 误建成员工号的客户号（没用过、有备注）
const NEW_BANNED = "ZZS2C-NEW2"; // 误建后先封禁的
const USED = "zz_s2c_used";      // 真员工（留下过操作记录）
const USED_AI = "zz_s2c_used_ai"; // 只问过 AI
const PUSH_ONLY = "ZZS2C-PUSH";  // 只开过浏览器通知
const RACE = "ZZS2C-RACE";
const USED_LOG = "zz_s2c_used_log";   // 留下过轨迹（status_logs 没外键）
const USED_CHAT = "zz_s2c_used_chat"; // 回过客户消息（cs_messages 没外键）
const USED_DELETED = "zz_s2c_used_del"; // 加过的轨迹被删了，整条存在审计记录里
const LOOKALIKE = "zz_s2c_look";      // 审计记录里只有长得像的号
const NO_PW = "ZZS2C-NOPW";            // 当初没设密码
const BUSY = "ZZS2C-BUSY";
const OTHER = "zz_s2c_other_staff";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) { console.log("⚠️ 跳过：没有 DATABASE_URL（CI 没有数据库）—— 这一项等于没测"); return; }
  if (!url.includes("neon.tech") && process.env.AGENT_PORTAL_TEST_ALLOW_DB !== "1") {
    console.log("⚠️ 跳过：DATABASE_URL 不是 Neon 测试库，怕连到生产库不跑（确认是测试库可设 AGENT_PORTAL_TEST_ALLOW_DB=1）—— 这一项等于没测");
    return;
  }
  process.env.NODE_ENV = process.env.NODE_ENV || "test";

  const { prisma } = await import("../apps/api/src/db/prisma");
  const { BusinessError } = await import("../apps/api/src/modules/core/business-error");
  const { hashPassword } = await import("../apps/api/src/modules/auth/crypto-utils");
  const { passwordFingerprint } = await import("../apps/api/src/modules/auth/token");
  const { isSessionStillValid } = await import("../apps/api/src/modules/auth/session-guard");
  const { findUserReferences, USER_REFERENCE_COLUMNS } = await import("../apps/api/src/modules/admin/user-references");
  const pm: any = prisma;

  const routes = new Map<string, Function>();
  const app: any = {};
  for (const m of ["get", "post", "put", "patch", "delete"]) app[m] = (p: string, h: Function) => routes.set(`${m.toUpperCase()} ${p}`, h);
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
  const convert = (auth: Auth, id: unknown) => call("POST /admin/users/staff-to-client", auth, { id });
  const userOf = async (id: string) => pm.user.findUnique({ where: { id }, select: { role: true, status: true, name: true, phone: true, passwordHash: true, remark: true } });
  const listed = async (role: "staff" | "client") => ((await call("GET /admin/users", ADMIN, {}, { role })).data.items as Row[]).map((r) => r.id);

  async function cleanup(): Promise<void> {
    for (const co of [CO, CO2]) {
      await pm.auditLog.deleteMany({ where: { companyId: co } });
      await pm.$executeRawUnsafe(`DELETE FROM cs_messages WHERE company_id = '${co}'`);
      await pm.$executeRawUnsafe(`DELETE FROM cs_conversations WHERE company_id = '${co}'`);
      await pm.$executeRawUnsafe(`DELETE FROM status_logs WHERE company_id = '${co}'`);
      await pm.$executeRawUnsafe(`DELETE FROM shipments WHERE company_id = '${co}'`);
      await pm.$executeRawUnsafe(`DELETE FROM orders WHERE company_id = '${co}'`);
      await pm.aiSessionMemory.deleteMany({ where: { companyId: co } });
      await pm.csPushSubscription.deleteMany({ where: { companyId: co } });
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
      [ADMIN.userId, CO, "admin", "超管", "active"], [STAFF.userId, CO, "staff", "员工", "active"], [AGENT.userId, CO, "agent", "代理", "active"],
      [CLIENT.userId, CO, "client", "客户一", "active"], [NEW1, CO, "staff", NEW1, "active"], [NEW_BANNED, CO, "staff", NEW_BANNED, "inactive"],
      [USED, CO, "staff", "老员工", "active"], [USED_AI, CO, "staff", "问过 AI 的员工", "active"], [PUSH_ONLY, CO, "staff", PUSH_ONLY, "active"],
      [RACE, CO, "staff", RACE, "active"], [OTHER, CO2, "staff", "别家员工", "active"],
      [USED_LOG, CO, "staff", "加过轨迹的员工", "active"], [USED_CHAT, CO, "staff", "回过消息的员工", "active"],
      [USED_DELETED, CO, "staff", "轨迹被删的员工", "active"], [LOOKALIKE, CO, "staff", LOOKALIKE, "active"],
      [NO_PW, CO, "staff", NO_PW, "active"], [BUSY, CO, "staff", BUSY, "active"],
    ];
    for (const [id, co, role, name, status] of users) {
      await pm.user.create({ data: { id, companyId: co, role, name, phone: "-", status, passwordHash: hashPassword("Zz#s2c2026x"), agentId: role === "agent" ? AGENT.agentId : null } });
    }
    await pm.user.update({ where: { id: NEW1 }, data: { remark: "义乌仓管" } });
    await pm.user.update({ where: { id: NO_PW }, data: { passwordHash: null } });
    // 客户一的一票货 + 轨迹（员工 USED_LOG 加的）；客户一的对话 + 员工 USED_CHAT 的回复；被删轨迹整条存进审计（删的人是超管）
    await pm.$executeRawUnsafe(`INSERT INTO orders (id, company_id, client_id, warehouse_id, item_name, product_quantity, package_count, package_unit,
        receiver_name_th, receiver_phone_th, receiver_address_th, transport_mode, updated_at)
      VALUES ('zz_s2c_o1', '${CO}', '${CLIENT.userId}', 'wh_yiwu_01', '鞋', 1, 1, 'box', '收货人', '000', '地址', 'sea', now())`);
    await pm.$executeRawUnsafe(`INSERT INTO shipments (id, company_id, order_id, tracking_no, current_status, warehouse_id, updated_at)
      VALUES ('zz_s2c_s1', '${CO}', 'zz_s2c_o1', 'ZZS2C-T1', 'inWarehouseCN', 'wh_yiwu_01', now())`);
    await pm.$executeRawUnsafe(`INSERT INTO status_logs (id, company_id, shipment_id, operator_id, operator_role, from_status, to_status)
      VALUES ('zz_s2c_log1', '${CO}', 'zz_s2c_s1', '${USED_LOG}', 'staff', 'created', 'inWarehouseCN')`);
    const conv = await pm.csConversation.create({ data: { companyId: CO, clientId: CLIENT.userId } });
    await pm.csMessage.create({ data: { companyId: CO, conversationId: conv.id, senderId: USED_CHAT, senderRole: "staff", content: "您好" } });
    await pm.auditLog.create({ data: { companyId: CO, actorId: ADMIN.userId, actorRole: "admin", action: "DELETE", resourceType: "StatusLog", resourceId: "gone",
      beforeJson: JSON.stringify({ id: "gone", operatorId: USED_DELETED, operatorRole: "staff", toStatus: "inWarehouseCN" }) } });
    await pm.auditLog.create({ data: { companyId: CO, actorId: ADMIN.userId, actorRole: "admin", action: "DELETE", resourceType: "StatusLog", resourceId: "gone2",
      beforeJson: JSON.stringify({ operatorId: `${LOOKALIKE}X` }), afterJson: JSON.stringify({ operatorId: "zzXs2cXlook" }) } });
    await pm.auditLog.create({ data: { companyId: CO, actorId: USED, actorRole: "staff", action: "UPDATE", resourceType: "Shipment", resourceId: "x" } });
    await pm.aiSessionMemory.create({ data: { key: "zz_s2c_mem", companyId: CO, userId: USED_AI, sessionId: "s" } });
    await pm.csPushSubscription.create({ data: { companyId: CO, userId: PUSH_ONLY, role: "staff", endpoint: "https://push.example.invalid/zz-s2c", p256dh: "k", auth: "a", passwordFp: "fp" } });

    await check("C1 没用过的员工号：改成客户号；只动角色（+ 清员工备注）；客户名单有、员工名单没了；原来的员工登录当场失效", async () => {
      const before = await userOf(NEW1);
      const staffToken = { userId: NEW1, companyId: CO, role: "staff", pv: passwordFingerprint(before.passwordHash) } as any;
      assert.equal((await isSessionStillValid(staffToken)).ok, true, "前提：改之前员工登录是有效的");
      const r = await convert(ADMIN, ` ${NEW1} `);
      assert.equal(r.status, 200, `${r.status} ${r.message}`);
      assert.deepEqual(r.data, { id: NEW1, role: "client", status: "active" });
      const after = await userOf(NEW1);
      assert.deepEqual(after, { ...before, role: "client", remark: null }, "除了角色和员工备注，别的一样都不许动");
      assert.ok((await listed("client")).includes(NEW1), "客户名单里没有");
      assert.ok(!(await listed("staff")).includes(NEW1), "员工名单里还有");
      assert.equal((await isSessionStillValid(staffToken)).ok, false, "原来的员工登录还能用");
    });

    await check("C2 封着的员工号也能改，改完还是封着", async () => {
      const r = await convert(ADMIN, NEW_BANNED);
      assert.equal(r.status, 200, r.message);
      assert.deepEqual(r.data, { id: NEW_BANNED, role: "client", status: "inactive" });
      const u = await userOf(NEW_BANNED);
      assert.equal(u.role, "client");
      assert.equal(u.status, "inactive", "改号不许顺手解封");
    });

    await check("C3 用过的员工号（留下过操作记录 / 问过 AI）不许改：409、角色没动", async () => {
      for (const id of [USED, USED_AI]) {
        const r = await convert(ADMIN, id);
        assert.equal(r.status, 409, `${id}：${r.status} ${r.message}`);
        assert.match(r.message, /已经用过/);
        assert.equal((await userOf(id)).role, "staff", `${id} 被改了`);
      }
    });

    await check("C4 只开过浏览器通知不算用过：照改", async () => {
      const r = await convert(ADMIN, PUSH_ONLY);
      assert.equal(r.status, 200, r.message);
      assert.equal((await userOf(PUSH_ONLY)).role, "client");
    });

    await check("C5 只认本公司员工号：客户 / 超管 / 代理 409 不动；别家 404；没这个号 404；没选 400", async () => {
      const asClient = await convert(ADMIN, CLIENT.userId);
      assert.equal(asClient.status, 409);
      assert.match(asClient.message, /已经是客户号/);
      for (const who of [ADMIN.userId, AGENT.userId]) {
        const r = await convert(ADMIN, who);
        assert.equal(r.status, 409, `${who}：${r.status}`);
        assert.match(r.message, /只有员工号能改/);
      }
      assert.equal((await userOf(ADMIN.userId)).role, "admin");
      assert.equal((await userOf(AGENT.userId)).role, "agent");
      const other = await convert(ADMIN, OTHER);
      assert.equal(other.status, 404);
      assert.equal((await userOf(OTHER)).role, "staff", "别家公司的员工号被改了");
      assert.equal((await convert(ADMIN, "NOBODY_S2C")).status, 404);
      assert.equal((await convert(ADMIN, "")).status, 400);
      assert.equal((await convert(ADMIN, "  ")).status, 400);
      assert.equal((await convert(ADMIN, 5)).status, 400);
    });

    await check("C6 只有超管能改：员工 / 客户 / 代理 403，啥也没动", async () => {
      for (const who of [STAFF, CLIENT, AGENT]) {
        const r = await convert(who, RACE);
        assert.equal(r.status, 403, `${who.role}：${r.status}`);
      }
      assert.equal((await userOf(RACE)).role, "staff");
    });

    await check("C7 锁里再核：另一条连接锁住这一行、塞了操作记录没提交 → 请求卡在锁上 → 放锁后看到记录 → 409、角色没动（只保证改号这一刻之前落库的）", async () => {
      const { PrismaClient } = await import("@prisma/client");
      const locker = new PrismaClient();
      let releaseLock: (() => void) | undefined;
      let otherTx: Promise<unknown> | undefined;
      try {
        let locked!: () => void, release!: () => void;
        const isLocked = new Promise<void>((r) => { locked = r; });
        const gate = new Promise<void>((r) => { release = r; });
        const other = locker.$transaction(async (tx) => {
          await tx.$queryRawUnsafe(`SELECT id FROM users WHERE id = '${RACE}' FOR UPDATE`);
          await tx.$executeRawUnsafe(`INSERT INTO audit_logs (id, company_id, actor_id, actor_role, action, resource_type, resource_id) VALUES ('zz_s2c_race_log', '${CO}', '${RACE}', 'staff', 'UPDATE', 'Shipment', 'x')`);
          locked();
          await gate;
        }, { timeout: 30000, maxWait: 10000 });
        releaseLock = release;
        otherTx = other;
        await isLocked;
        const req = convert(ADMIN, RACE);
        let waiting = 0;
        for (let i = 0; i < 100 && waiting === 0; i++) {
          await new Promise((r) => setTimeout(r, 50));
          waiting = Number((await locker.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%users%'`))[0].n);
        }
        assert.ok(waiting > 0, "前提：改号请求没卡在锁上，这一项没测到「查之前别人刚留下记录」");
        release();
        await other;
        const r = await req;
        assert.equal(r.status, 409, `${r.status} ${r.message}`);
        assert.match(r.message, /已经用过/, "要是「正被别人改着」就是等锁超时顶了包，没测到再查（dsh 第 2 轮）");
        assert.equal((await userOf(RACE)).role, "staff", "锁里没再核，把刚做过事的员工改成客户了");
      } finally {
        releaseLock?.();
        await otherTx?.catch(() => {});
        await locker.$disconnect();
      }
    });

    await check("C8 记账号的列在库里全都真有（列名写错这里就报错）、拿不存在的号查一条都没有", async () => {
      const cols = await pm.$queryRawUnsafe(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`) as Array<{ table_name: string; column_name: string }>;
      const have = new Set(cols.map((c) => `${c.table_name}.${c.column_name}`));
      const missing = USER_REFERENCE_COLUMNS.map(([t, c]) => `${t}.${c}`).filter((k) => !have.has(k));
      assert.deepEqual(missing, [], "这些列库里没有");
      assert.deepEqual(await prisma.$transaction((tx) => findUserReferences(tx, "zz_s2c_nobody")), []);
      assert.deepEqual(await prisma.$transaction((tx) => findUserReferences(tx, USED)), ["audit_logs.actor_id"]);
      assert.deepEqual(await prisma.$transaction((tx) => findUserReferences(tx, CLIENT.userId)), ["orders.client_id", "cs_conversations.client_id"]);
    });

    await check("C9 没外键的员工记录也拦（轨迹、聊天）；被删的轨迹存在审计里也拦；审计里只有长得像的号不误拦", async () => {
      for (const [id, where] of [[USED_LOG, "status_logs.operator_id"], [USED_CHAT, "cs_messages.sender_id"], [USED_DELETED, "audit_logs.before_json"]] as const) {
        assert.deepEqual(await prisma.$transaction((tx) => findUserReferences(tx, id)), [where], `${id} 查到的位置不对`);
        await pm.user.update({ where: { id }, data: { remark: "广州仓管" } });
        const before = await pm.user.findUnique({ where: { id } });
        const r = await convert(ADMIN, id);
        assert.equal(r.status, 409, `${id}：${r.status} ${r.message}`);
        assert.match(r.message, /已经用过/);
        assert.deepEqual(await pm.user.findUnique({ where: { id } }), before, `${id} 被改了（改完再查到用过要整个撤销：角色、备注都回原样）`);
      }
      // 审计里「被操作的是这个账号」也算
      await pm.auditLog.create({ data: { companyId: CO, actorId: ADMIN.userId, actorRole: "admin", action: "UPDATE", resourceType: "User", resourceId: LOOKALIKE } });
      assert.deepEqual(await prisma.$transaction((tx) => findUserReferences(tx, LOOKALIKE)), ["audit_logs.resource_id(User)"]);
      await pm.auditLog.deleteMany({ where: { resourceType: "User", resourceId: LOOKALIKE } });
      const look = await convert(ADMIN, LOOKALIKE);
      assert.equal(look.status, 200, `只有长得像的号就被拦了：${look.message}`);
    });

    await check("C10 当初没设密码的员工号：409 叫他先设密码、角色没动；设好再改就行", async () => {
      const r = await convert(ADMIN, NO_PW);
      assert.equal(r.status, 409, `${r.status} ${r.message}`);
      assert.match(r.message, /还没有登录密码，先点「设置密码」/);
      assert.equal((await userOf(NO_PW)).role, "staff");
      await pm.user.update({ where: { id: NO_PW }, data: { passwordHash: hashPassword("Zz#s2c2026y") } });
      const ok2 = await convert(ADMIN, NO_PW);
      assert.equal(ok2.status, 200, ok2.message);
      assert.equal((await userOf(NO_PW)).role, "client");
    });

    await check("C11 别人锁着这一行超过 3 秒：409「正被别人改着」，角色没动", async () => {
      const { PrismaClient } = await import("@prisma/client");
      const locker = new PrismaClient();
      let release!: () => void;
      let other: Promise<unknown> | undefined;
      try {
        let locked!: () => void;
        const isLocked = new Promise<void>((r) => { locked = r; });
        const gate = new Promise<void>((r) => { release = r; });
        other = locker.$transaction(async (tx) => {
          await tx.$queryRawUnsafe(`SELECT id FROM users WHERE id = '${BUSY}' FOR UPDATE`);
          locked();
          await gate;
        }, { timeout: 30000, maxWait: 10000 });
        await isLocked;
        const t0 = Date.now();
        const r = await convert(ADMIN, BUSY);
        assert.equal(r.status, 409, `${r.status} ${r.message}`);
        assert.match(r.message, /正被别人改着/);
        const waited = Date.now() - t0;
        assert.ok(waited >= 2500 && waited < 10000, `等了 ${waited} 毫秒：该是等锁 3 秒到点（太快说明走了别的 409）`);
      } finally {
        release?.();
        await other?.catch(() => {});
        await locker.$disconnect();
      }
      assert.equal((await userOf(BUSY)).role, "staff");
    });
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
