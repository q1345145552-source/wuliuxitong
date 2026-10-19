/**
 * 员工账号备注（2026-10-20 老板：「给员工账号备注是哪里的员工，比如义乌仓管，广州仓管，泰国员工」→「管理员给员工账号进行备注」）—— 连库（真 handler + 真 PostgreSQL）。
 * 计划：.audit/2026-10-20/staff-remark/plan.md。
 *
 *   B1 超管建员工带备注：存上（去掉前后空格）、列表里看得到；不带 / 空白 = 没写；超长 / 不是文字 400 且号没建出来；建客户号带了也不存
 *   B2 超管改备注：写上 → 改成别的 → 前后空格去掉 → 空着 = 清掉；50 个字正好可以、51 个字 400 且原来的没动；列表（按员工 / 不分角色）都带备注
 *   B3 只认本公司员工号：客户 / 超管 / 代理的号 400 且没写上；别家公司的员工 404；没有这个号 404；没选人 400
 *   B4 只有超管能改、能看：员工 / 客户 / 代理改备注 403、看员工名单 403
 *   B5 查和写之间这个号被改成客户号：写的时候再核一次 → 409，备注没写上
 *
 * 只连测试库：DATABASE_URL 不带 neon.tech 的不跑（一次性 docker 库设 AGENT_PORTAL_TEST_ALLOW_DB=1）。测试数据全在假公司 zz_rmk_co / zz_rmk_co2 下，跑前跑后都清。
 */
import assert from "node:assert/strict";

type Row = Record<string, any>;
type Auth = { userId: string; companyId: string; role: string; name: string; agentId: string | null };
const CO = "zz_rmk_co";
const CO2 = "zz_rmk_co2";
const ADMIN: Auth = { userId: "zz_rmk_admin", companyId: CO, role: "admin", name: "超管", agentId: null };
const STAFF: Auth = { userId: "zz_rmk_staff", companyId: CO, role: "staff", name: "员工", agentId: null };
const AGENT: Auth = { userId: "zz_rmk_agent_user", companyId: CO, role: "agent", name: "代理", agentId: "zz_rmk_agent" };
const CLIENT: Auth = { userId: "ZZRMK01", companyId: CO, role: "client", name: "客户一", agentId: null };
const STAFF2 = "zz_rmk_staff2";
const OTHER_STAFF = "zz_rmk_other_staff";

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
  async function must(key: string, auth: Auth, body: Row = {}, query: Record<string, string> = {}): Promise<any> {
    const r = await call(key, auth, body, query);
    assert.equal(r.status, 200, `${key} 应该成功，实际 ${r.status}：${r.message}`);
    return r.data;
  }
  const remarkOf = async (id: string) => (await pm.user.findUnique({ where: { id }, select: { remark: true } }))?.remark as string | null | undefined;
  const setRemark = (auth: Auth, id: unknown, remark: unknown) => call("POST /admin/users/staff-remark", auth, { id, remark });
  const listed = async (query: Record<string, string>, id: string) => {
    const items = (await must("GET /admin/users", ADMIN, {}, query)).items as Row[];
    const row = items.find((r) => r.id === id);
    assert.ok(row, `名单里没有 ${id}`);
    return row;
  };

  async function cleanup(): Promise<void> {
    for (const co of [CO, CO2]) {
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
    const users: Array<[string, string, string, string]> = [
      [ADMIN.userId, CO, "admin", "超管"], [STAFF.userId, CO, "staff", "员工"], [STAFF2, CO, "staff", "员工二"],
      [AGENT.userId, CO, "agent", "代理"], [CLIENT.userId, CO, "client", "客户一"], [OTHER_STAFF, CO2, "staff", "别家员工"],
    ];
    for (const [id, co, role, name] of users) {
      await pm.user.create({ data: { id, companyId: co, role, name, passwordHash: hashPassword("Zz#rmk2026x"), phone: `0${id}`, status: "active", agentId: role === "agent" ? AGENT.agentId : null } });
    }

    await check("B1 建员工带备注：存上（去掉前后空格）、列表看得到；不带 / 空白 = 没写；超长 / 不是文字 400 且号没建出来；建客户号带了也不存", async () => {
      const base = { phone: "0800", password: "Zz#rmk2026x" };
      await must("POST /admin/users", ADMIN, { ...base, id: "zz_rmk_new1", name: "新员工一", remark: "  义乌仓管  " });
      assert.equal(await remarkOf("zz_rmk_new1"), "义乌仓管");
      assert.equal((await listed({ role: "staff" }, "zz_rmk_new1")).remark, "义乌仓管");
      await must("POST /admin/users", ADMIN, { ...base, id: "zz_rmk_new2", name: "新员工二" });
      assert.equal(await remarkOf("zz_rmk_new2"), null, "没带备注应该是空");
      await must("POST /admin/users", ADMIN, { ...base, id: "zz_rmk_new3", name: "新员工三", remark: "   " });
      assert.equal(await remarkOf("zz_rmk_new3"), null, "全是空格当没写");
      const long = await call("POST /admin/users", ADMIN, { ...base, id: "zz_rmk_new4", name: "新员工四", remark: "广".repeat(51) });
      assert.equal(long.status, 400, long.message);
      assert.match(long.message, /最多 50 个字/);
      assert.equal(await remarkOf("zz_rmk_new4"), undefined, "备注超长，号不该建出来");
      const notText = await call("POST /admin/users", ADMIN, { ...base, id: "zz_rmk_new5", name: "新员工五", remark: 123 });
      assert.equal(notText.status, 400, notText.message);
      assert.equal(await remarkOf("zz_rmk_new5"), undefined, "备注不是文字，号不该建出来");
      await must("POST /admin/users", ADMIN, { ...base, id: "zz_rmk_new6", name: "新员工六", remark: "广".repeat(50) });
      assert.equal(await remarkOf("zz_rmk_new6"), "广".repeat(50), "50 个字正好可以");
      // 走这条接口建客户号（role=client）：备注不认
      await must("POST /admin/users", ADMIN, { ...base, id: "ZZRMKC2", name: "新客户", role: "client", remark: "不该存" });
      assert.equal(await remarkOf("ZZRMKC2"), null, "客户号不许带备注");
    });

    await check("B2 改备注：写上 → 改成别的 → 去空格 → 空着 = 清掉；50 字可以、51 字 400 不动；两种名单都带备注", async () => {
      assert.deepEqual(await must("POST /admin/users/staff-remark", ADMIN, { id: STAFF.userId, remark: "广州仓管" }), { id: STAFF.userId, remark: "广州仓管" });
      assert.equal(await remarkOf(STAFF.userId), "广州仓管");
      assert.equal((await listed({ role: "staff" }, STAFF.userId)).remark, "广州仓管");
      assert.equal((await listed({}, STAFF.userId)).remark, "广州仓管", "不分角色的名单也要带");
      assert.equal(await remarkOf(STAFF2), null, "改一个员工不许动别的员工");
      const r2 = await must("POST /admin/users/staff-remark", ADMIN, { id: ` ${STAFF.userId} `, remark: "  泰国员工 " });
      assert.deepEqual(r2, { id: STAFF.userId, remark: "泰国员工" }, "账号和备注都去掉前后空格，返回存进去的值");
      assert.equal(await remarkOf(STAFF.userId), "泰国员工");
      const tooLong = await setRemark(ADMIN, STAFF.userId, "义".repeat(51));
      assert.equal(tooLong.status, 400, tooLong.message);
      assert.equal(await remarkOf(STAFF.userId), "泰国员工", "超长被拦，原来的不许动");
      assert.equal((await setRemark(ADMIN, STAFF.userId, 5)).status, 400, "不是文字 400");
      assert.equal(await remarkOf(STAFF.userId), "泰国员工");
      await must("POST /admin/users/staff-remark", ADMIN, { id: STAFF.userId, remark: "义".repeat(50) });
      assert.equal(await remarkOf(STAFF.userId), "义".repeat(50));
      assert.deepEqual(await must("POST /admin/users/staff-remark", ADMIN, { id: STAFF.userId, remark: "   " }), { id: STAFF.userId, remark: null }, "空白 = 清掉");
      assert.equal(await remarkOf(STAFF.userId), null);
      await must("POST /admin/users/staff-remark", ADMIN, { id: STAFF.userId, remark: "义乌仓管" });
      await must("POST /admin/users/staff-remark", ADMIN, { id: STAFF.userId });
      assert.equal(await remarkOf(STAFF.userId), null, "不传备注也当清掉");
      assert.equal((await listed({ role: "client" }, CLIENT.userId)).remark, null, "客户名单那一格是空的");
    });

    await check("B3 只认本公司员工号：客户 / 超管 / 代理的号 400 不写；别家员工 404；没这个号 404；没选人 400", async () => {
      for (const id of [CLIENT.userId, ADMIN.userId, AGENT.userId]) {
        const r = await setRemark(ADMIN, id, "义乌仓管");
        assert.equal(r.status, 400, `${id}：${r.status} ${r.message}`);
        assert.match(r.message, /只能写在员工号上/);
        assert.equal(await remarkOf(id), null, `${id} 被写上备注了`);
      }
      const other = await setRemark(ADMIN, OTHER_STAFF, "义乌仓管");
      assert.equal(other.status, 404, other.message);
      assert.equal(await remarkOf(OTHER_STAFF), null, "别家公司的员工被写上了");
      assert.equal((await setRemark(ADMIN, "NOBODY_RMK", "x")).status, 404);
      assert.equal((await setRemark(ADMIN, "", "x")).status, 400);
      assert.equal((await setRemark(ADMIN, "   ", "x")).status, 400);
      assert.equal((await setRemark(ADMIN, 1, "x")).status, 400);
    });

    await check("B4 只有超管能改、能看：员工 / 客户 / 代理改备注 403、看员工名单 403", async () => {
      await must("POST /admin/users/staff-remark", ADMIN, { id: STAFF2, remark: "广州仓管" });
      for (const who of [STAFF, CLIENT, AGENT]) {
        const r = await setRemark(who, STAFF2, "被改了");
        assert.equal(r.status, 403, `${who.role} 改备注：${r.status} ${r.message}`);
        const l = await call("GET /admin/users", who, {}, { role: "staff" });
        assert.equal(l.status, 403, `${who.role} 看员工名单：${l.status}`);
      }
      assert.equal(await remarkOf(STAFF2), "广州仓管", "非超管把备注改了");
      const self = await setRemark(STAFF, STAFF.userId, "自己写");
      assert.equal(self.status, 403, "员工给自己写备注也不行");
      assert.equal(await remarkOf(STAFF.userId), null);
    });

    await check("B5 查和写之间这个号被改成客户号：写的时候再核一次 → 409，备注没写上", async () => {
      const { PrismaClient } = await import("@prisma/client");
      const locker = new PrismaClient();
      let releaseLock: (() => void) | undefined;
      let otherTx: Promise<unknown> | undefined;
      try {
        await pm.user.update({ where: { id: STAFF2 }, data: { remark: null } });
        let locked!: () => void, release!: () => void;
        const isLocked = new Promise<void>((r) => { locked = r; });
        const gate = new Promise<void>((r) => { release = r; });
        // 另一条连接：把这一行锁住并改成客户号，先不提交；改备注请求查到它还是员工号，写的时候卡在锁上；放锁后它看到的已经是客户号
        const other = locker.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`UPDATE users SET role = 'client' WHERE id = '${STAFF2}'`);
          locked();
          await gate;
        }, { timeout: 30000, maxWait: 10000 });
        releaseLock = release;
        otherTx = other;
        await isLocked;
        const req = setRemark(ADMIN, STAFF2, "义乌仓管");
        let waiting = 0;
        for (let i = 0; i < 100 && waiting === 0; i++) {
          await new Promise((r) => setTimeout(r, 50));
          waiting = Number((await locker.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%users%'`))[0].n);
        }
        assert.ok(waiting > 0, "前提：改备注请求没卡在锁上，这一项没测到「查和写之间」");
        release();
        await other;
        const r = await req;
        assert.equal(r.status, 409, `${r.status} ${r.message}`);
        assert.equal(await remarkOf(STAFF2), null, "已经是客户号了，备注被写上了");
      } finally {
        // 先放锁、等那条事务结束，再把角色改回来（不然断言失败时这里会一直等那把锁到超时）
        releaseLock?.();
        await otherTx?.catch(() => {});
        await pm.user.update({ where: { id: STAFF2 }, data: { role: "staff" } });
        await locker.$disconnect();
      }
    });
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
