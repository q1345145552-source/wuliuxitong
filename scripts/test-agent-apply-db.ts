/**
 * 代理申请（2026-11-08，老板：「财务提交，物流审批」）连库测试：真库 + 真 HTTP（server.ts 的鉴权、路由、错误格式都在路上）。
 *
 *   海外仓财务系统那两条：POST / GET /integrations/finance/v1/agent-applications（对接密钥）
 *   超管那三条：GET /admin/agents/applications/list、POST .../approve、POST .../reject
 *
 * 用法：DATABASE_URL=<一次性测试库> AGENT_PORTAL_TEST_ALLOW_DB=1 npx tsx scripts/test-agent-apply-db.ts
 * 没有 DATABASE_URL 打印「跳过」。测试数据全在假公司 zz_ap_co 下，开跑前、跑完后都清干净。
 * ⚠️ 「申请算哪家公司」取的是有正常超管的那家、只认一家：测试期间库里不能有别家的正常超管（CI 的 test-db 各项跑完都自己清）。
 */
process.env.TZ = "UTC";
process.env.AUTH_SECRET ||= "test-only-fake-secret-not-a-real-key-do-not-use-in-production";
process.env.AGENT_REBATE_SCHEDULER = "off";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { PrismaClient } from "@prisma/client";

type Row = Record<string, any>;

const CO = "zz_ap_co";
/** 另一家公司：它的申请超管看不到，财务按仓查也查不到 */
const OTHER_CO = "zz_ap_other_co";
const COMPANIES = [CO, OTHER_CO];
const P = "zz_ap_";
const SECRET = "Fin4nceLink-aB3dE5gH7jK9mN1pQ3sT5vX";
const RETURN_URL = "https://finance.example.test/logistics-waybills/callback";
const PASSWORD = "Test-pass-Zz123456";
const AGENT_PASSWORD = "Apply-Pass-88x";
const ROOT = path.join(__dirname, "..");
const SCHEMA = path.join(ROOT, "apps/api/prisma/schema.prisma");
const MIGRATION = path.join(ROOT, "apps/api/prisma/migrations/20261108_agent_applications/migration.sql");
const DRIFT = path.join(ROOT, "scripts/check-schema-drift.sql");

const ADMIN = "zz_ap_admin";
const ADMIN_NAME = "老板ZZAP";
const STAFF = "zz_ap_staff";
const CLIENT = "ZZAPC";
const OLD_AGENT = "zz_ap_oldagent";
/** 1×1 PNG */
const LOGO = { mime: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" };
/** 给海外仓财务系统的「申请」只有这 12 个字段 */
const APPLICATION_KEYS = ["agentName", "approvedLoginId", "contactName", "contactPhone", "createdAt", "id", "loginId", "rejectReason", "remark", "reviewedAt", "status", "submittedBy"];

let failures = 0;
let passes = 0;
async function test(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passes++;
    console.log(`  ✅ ${label}`);
  } catch (e) {
    failures++;
    console.log(`  ❌ ${label}\n     ${e instanceof Error ? e.message.split("\n").slice(0, 12).join("\n     ") : String(e)}`);
  }
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) { console.log("⚠️ 跳过：没有 DATABASE_URL（CI 没有数据库）—— 这一项等于没测"); return; }
  if (process.env.AGENT_PORTAL_TEST_ALLOW_DB !== "1") {
    console.log("⚠️ 跳过：怕连到生产库不跑（确认是测试库再设 AGENT_PORTAL_TEST_ALLOW_DB=1）—— 这一项等于没测");
    return;
  }

  process.env.FINANCE_LINK_ENABLED = "true";
  process.env.FINANCE_LINK_SECRET = SECRET;
  process.env.FINANCE_LINK_RETURN_URL = RETURN_URL;
  const imagesDir = mkdtempSync(path.join(tmpdir(), "zz-agent-apply-"));
  process.env.IMAGES_DIR = imagesDir;

  const { prisma } = await import("../apps/api/src/db/prisma");
  const { createApp } = await import("../apps/api/src/server");
  const { signAuthToken } = await import("../apps/api/src/modules/auth/token");
  const { hashPassword } = await import("../apps/api/src/modules/auth/crypto-utils");
  const { registerAgentAdminRoutes } = await import("../apps/api/src/modules/agents/admin-routes");
  const { registerAgentApplicationAdminRoutes } = await import("../apps/api/src/modules/agents/application-routes");
  const { registerFinanceLinkRoutes } = await import("../apps/api/src/modules/finance-link/routes");
  const { registerFinanceAgentApplicationRoutes, resolveApplicationCompanyId } = await import("../apps/api/src/modules/finance-link/agent-applications");

  const db = prisma as any;

  async function cleanup(): Promise<void> {
    await db.agentApplication.deleteMany({ where: { companyId: { in: COMPANIES } } });
    await db.user.deleteMany({ where: { companyId: { in: COMPANIES } } });
    await db.agent.deleteMany({ where: { companyId: { in: COMPANIES } } });
  }

  await cleanup();
  const pw = hashPassword(PASSWORD);
  await db.agent.create({ data: { id: `${P}oldag`, companyId: CO, name: "老代理", slug: "zzapold", priceNormal: 500, priceInspection: 550, priceSensitive: 600 } });
  const user = (id: string, role: string, name: string, companyId = CO, agentId: string | null = null) =>
    ({ id, companyId, role, name, phone: "0800000000", status: "active", agentId, passwordHash: pw });
  await db.user.createMany({ data: [
    user(ADMIN, "admin", ADMIN_NAME),
    user(STAFF, "staff", "员工ZZAP"),
    user(CLIENT, "client", "客户ZZAP"),
    user(OLD_AGENT, "agent", "老代理", CO, `${P}oldag`),
  ] });

  const PORT = await freePort();
  const app = createApp();
  registerAgentAdminRoutes(app);
  registerFinanceLinkRoutes(app);
  registerFinanceAgentApplicationRoutes(app);
  registerAgentApplicationAdminRoutes(app);
  await new Promise<void>((resolve) => app.listen(PORT, resolve));
  const BASE = `http://127.0.0.1:${PORT}`;

  interface Res { status: number; body: Row; text: string }
  /** 给海外仓财务系统的成功响应全文都收起来，最后搜价、密码、哈希（报错里会原样点名对方多传的字段名，比如 price，那不算漏） */
  const financeTexts: string[] = [];
  async function call(method: string, pathAndQuery: string, opts: { body?: unknown; headers?: Record<string, string>; rawBody?: string } = {}): Promise<Res> {
    const r = await fetch(`${BASE}${pathAndQuery}`, {
      method,
      headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
      body: opts.rawBody !== undefined ? opts.rawBody : opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await r.text();
    let body: Row = {};
    try { body = JSON.parse(text) as Row; } catch { /* 不是 JSON 就留空 */ }
    if (pathAndQuery.startsWith("/integrations/") && r.status < 300) financeTexts.push(text);
    return { status: r.status, body, text };
  }
  const bearer = { authorization: `Bearer ${SECRET}` };
  const APPLY = "/integrations/finance/v1/agent-applications";
  const apply = (body: unknown) => call("POST", APPLY, { body, headers: bearer });
  const listFor = (warehouseId: number | string) => call("GET", `${APPLY}?warehouseId=${encodeURIComponent(String(warehouseId))}`, { headers: bearer });
  const tokenOf = (userId: string, role: string) => signAuthToken({ userId, companyId: CO, role: role as any, userName: userId });
  const asUser = (userId: string, role: string) => ({ authorization: `Bearer ${tokenOf(userId, role)}` });
  const admin = asUser(ADMIN, "admin");
  const adminList = (status = "all") => call("GET", `/admin/agents/applications/list?status=${status}`, { headers: admin });
  const approve = (applicationId: string, extra: Row = {}, headers = admin) => call("POST", "/admin/agents/applications/approve", {
    headers,
    body: { applicationId, name: "曼谷 A 仓", prices: { normal: 900, inspection: 950, sensitive: 1000, special: 1250 }, loginId: `${P}newagent`, password: AGENT_PASSWORD, phone: "0812345678", ...extra },
  });
  const reject = (applicationId: string, reason: unknown, headers = admin) => call("POST", "/admin/agents/applications/reject", { headers, body: { applicationId, reason } });
  const good = (warehouseId: number, extra: Row = {}) => ({
    warehouseId, warehouseName: "曼谷 A 仓", submittedBy: "张三", agentName: "曼谷 A 仓", contactName: "李四", contactPhone: "0812345678", loginId: "bkk-a", remark: "可以不传", ...extra,
  });
  const countAgentsAndUsers = async () => ({
    agents: await db.agent.count({ where: { companyId: CO } }),
    agentUsers: await db.user.count({ where: { companyId: CO, role: "agent" } }),
  });
  const logos = () => readdirSync(imagesDir).filter((f) => f.startsWith("agent_logo_"));

  try {
    console.log("\n【申请算哪家公司】");
    await test("C2 表里已有的申请属于别家公司（跟现在有超管的那家对不上）：不收也不查（503），不悄悄改记到另一家", async () => {
      await db.agentApplication.create({ data: { id: `${P}bound`, companyId: OTHER_CO, warehouseId: 903, warehouseName: "别家", submitterName: "x", agentName: "别家的", contactName: "x", contactPhone: "x", loginId: "other-a", status: "pending", pendingWarehouseId: 903 } });
      try {
        assert.equal(await resolveApplicationCompanyId(), null);
        const r = await apply(good(904));
        assert.equal(r.status, 503, r.text);
        assert.equal(r.body.code, "AGENT_APPLY_UNAVAILABLE");
        assert.equal((await listFor(903)).status, 503, "也查不到别家的");
      } finally {
        await db.agentApplication.delete({ where: { id: `${P}bound` } });
      }
      assert.equal(await resolveApplicationCompanyId(), CO, "删掉以后恢复");
      assert.equal(await db.agentApplication.count({ where: { warehouseId: 904 } }), 0);
    });

    await test("C1 有正常超管的公司正好一家才用它；超管停用 / 再多一家有超管的公司都不收（503 AGENT_APPLY_UNAVAILABLE），不猜", async () => {
      assert.equal(await resolveApplicationCompanyId(), CO, "测试库里还有别家的正常超管？先清掉再跑");
      await db.user.update({ where: { id: ADMIN }, data: { status: "inactive" } });
      try {
        const r = await apply(good(901));
        assert.equal(r.status, 503, r.text);
        assert.equal(r.body.code, "AGENT_APPLY_UNAVAILABLE");
        assert.equal((await listFor(901)).status, 503);
      } finally {
        await db.user.update({ where: { id: ADMIN }, data: { status: "active" } });
      }
      await db.user.create({ data: user(`${P}admin2`, "admin", "别家超管", OTHER_CO) });
      try {
        const r = await apply(good(902));
        assert.equal(r.status, 503, r.text);
        assert.equal(await db.agentApplication.count({ where: { warehouseId: { in: [901, 902] } } }), 0, "不收就一张都不能写进去");
      } finally {
        await db.user.delete({ where: { id: `${P}admin2` } });
      }
    });

    console.log("\n【交申请】");
    await test("1 提交成功：201，状态 pending；文字去掉首尾空格和控制字符再存；只给 12 个字段；存在超管那家公司、带在审标记", async () => {
      const r = await apply(good(12, { warehouseName: "  曼谷 A 仓\u0007 ", submittedBy: "\t张三 ", agentName: " 曼谷\u0000 A 仓", contactName: "李四\u007f", contactPhone: " 0812345678 ", loginId: "  bkk-a  ", remark: "  第一次申请\u001b  " }));
      assert.equal(r.status, 201, r.text);
      const a = r.body.application as Row;
      assert.deepEqual(Object.keys(a).sort(), APPLICATION_KEYS);
      assert.equal(a.status, "pending");
      assert.equal(a.agentName, "曼谷 A 仓");
      assert.equal(a.contactName, "李四");
      assert.equal(a.contactPhone, "0812345678");
      assert.equal(a.submittedBy, "张三");
      assert.equal(a.loginId, "bkk-a");
      assert.equal(a.remark, "第一次申请");
      assert.equal(a.reviewedAt, null);
      assert.equal(a.rejectReason, null);
      assert.equal(a.approvedLoginId, null);
      assert.match(a.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      const row = await db.agentApplication.findUnique({ where: { id: a.id } });
      assert.equal(row.companyId, CO);
      assert.equal(row.warehouseId, 12);
      assert.equal(row.warehouseName, "曼谷 A 仓");
      assert.equal(row.pendingWarehouseId, 12);
      const noRemark = await apply(good(13, { remark: undefined }));
      assert.equal(noRemark.status, 201, noRemark.text);
      assert.equal(noRemark.body.application.remark, null, "不传备注 = null");
      const blankRemark = await apply(good(14, { remark: "   " }));
      assert.equal(blankRemark.body.application.remark, null, "备注只有空格 = null");
    });

    await test("2 这个仓已经有在审的再交：409 APPLICATION_PENDING「这个仓已经有一张在审的申请」；8 个请求同时交只留一张", async () => {
      const r = await apply(good(12, { agentName: "第二次" }));
      assert.equal(r.status, 409, r.text);
      assert.equal(r.body.code, "APPLICATION_PENDING");
      assert.equal(r.body.message, "这个仓已经有一张在审的申请");
      assert.equal(await db.agentApplication.count({ where: { companyId: CO, warehouseId: 12 } }), 1);
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => apply(good(20, { agentName: `并发${i}` }))));
      assert.deepEqual(results.map((x) => x.status).sort(), [201, 409, 409, 409, 409, 409, 409, 409], results.map((x) => `${x.status} ${x.text.slice(0, 80)}`).join("\n"));
      assert.equal(await db.agentApplication.count({ where: { companyId: CO, warehouseId: 20 } }), 1);
      assert.equal((await apply(good(21))).status, 201, "别的仓不受影响");
    });

    await test("3 每个字段乱填 400（中文提示）；多传字段 400；不带密钥 / 密钥错 401；开关关着 503", async () => {
      const cases: Array<[string, Row | unknown, RegExp]> = [
        ["仓号缺", good(30, { warehouseId: undefined }), /请填仓库编号/],
        ["仓号是字符串", good(30, { warehouseId: "30" }), /仓库编号要是正整数/],
        ["仓号是 0", good(0), /仓库编号要是正整数/],
        ["仓号是负数", good(-3), /仓库编号要是正整数/],
        ["仓号是小数", good(3.5), /仓库编号要是正整数/],
        ["仓号太大", good(2_147_483_648), /仓库编号要是正整数/],
        ["仓名空", good(30, { warehouseName: "   " }), /请填仓名/],
        ["仓名只有控制字符", good(30, { warehouseName: "\u0001\u0002" }), /请填仓名/],
        ["仓名 101 字", good(30, { warehouseName: "仓".repeat(101) }), /仓名太长了（最多 100 个字）/],
        ["仓名是数字", good(30, { warehouseName: 12 }), /仓名要是文字/],
        ["提交人缺", good(30, { submittedBy: undefined }), /请填提交人/],
        ["提交人 101 字", good(30, { submittedBy: "张".repeat(101) }), /提交人太长了/],
        ["代理名字空", good(30, { agentName: "" }), /请填代理名字/],
        ["代理名字 51 字", good(30, { agentName: "代".repeat(51) }), /代理名字太长了（最多 50 个字）/],
        ["联系人空", good(30, { contactName: " " }), /请填联系人/],
        ["联系人 51 字", good(30, { contactName: "联".repeat(51) }), /联系人太长了/],
        ["电话空", good(30, { contactPhone: "" }), /请填联系电话/],
        ["电话 41 字", good(30, { contactPhone: "1".repeat(41) }), /联系电话太长了（最多 40 个字）/],
        ["账号空", good(30, { loginId: "" }), /请填登录账号/],
        ["账号带空格", good(30, { loginId: "bkk a" }), /登录账号只能用字母、数字/],
        ["账号太短", good(30, { loginId: "ab" }), /登录账号只能用字母、数字/],
        ["账号中文", good(30, { loginId: "曼谷仓" }), /登录账号只能用字母、数字/],
        ["账号是数字", good(30, { loginId: 123 }), /登录账号要是文字/],
        ["备注 501 字", good(30, { remark: "备".repeat(501) }), /备注太长了（最多 500 个字）/],
        ["备注是对象", good(30, { remark: { a: 1 } }), /备注要是文字/],
        ["多传字段", good(30, { price: 1 }), /不认识的字段：price/],
        ["多传两个", good(30, { agentId: "x", password: "y" }), /不认识的字段：agentId、password/],
        ["是数组", [good(30)], /JSON 对象/],
      ];
      for (const [label, body, re] of cases) {
        const r = await apply(body);
        assert.equal(r.status, 400, `${label}: ${r.text.slice(0, 160)}`);
        assert.equal(r.body.code, "BAD_REQUEST", label);
        assert.match(r.body.message, re, label);
      }
      assert.equal(await db.agentApplication.count({ where: { companyId: CO, warehouseId: 30 } }), 0, "乱填的一张都没写进去");

      const noKey = await call("POST", APPLY, { body: good(31) });
      assert.equal(noKey.status, 401, noKey.text);
      assert.equal(noKey.body.code, "LINK_SECRET_INVALID");
      const wrongKey = await call("POST", APPLY, { body: good(31), headers: { authorization: `Bearer ${SECRET}x` } });
      assert.equal(wrongKey.status, 401);
      assert.equal((await call("GET", `${APPLY}?warehouseId=31`)).status, 401);
      const adminToken = await call("POST", APPLY, { body: good(31), headers: admin });
      assert.equal(adminToken.status, 401, "超管的登录令牌也不行，只认对接密钥");

      const saved = process.env.FINANCE_LINK_ENABLED;
      process.env.FINANCE_LINK_ENABLED = "false";
      try {
        for (const r of [await apply(good(31)), await listFor(31)]) {
          assert.equal(r.status, 503, r.text);
          assert.equal(r.body.code, "LINK_DISABLED");
        }
      } finally {
        process.env.FINANCE_LINK_ENABLED = saved;
      }
      assert.equal(await db.agentApplication.count({ where: { companyId: CO, warehouseId: 31 } }), 0);
    });

    await test("4 按仓查：只给这个仓的（别的仓、别家公司的不给），新的在前，最多 20 张，字段正好 12 个；仓号乱写 400", async () => {
      const base = Date.UTC(2026, 10, 1);
      await db.agentApplication.createMany({ data: Array.from({ length: 23 }, (_, i) => ({
        id: `${P}hist${String(i).padStart(2, "0")}`, companyId: CO, warehouseId: 40, warehouseName: "历史仓", submitterName: "张三",
        agentName: `历史${i}`, contactName: "李四", contactPhone: "08", loginId: "hist-a", status: "rejected", rejectReason: "不合适",
        reviewedById: ADMIN, reviewedAt: new Date(base + i * 60_000 + 30_000), createdAt: new Date(base + i * 60_000),
      })) });
      await db.agentApplication.create({ data: { id: `${P}otherwh`, companyId: CO, warehouseId: 41, warehouseName: "别的仓", submitterName: "x", agentName: "别的仓的", contactName: "x", contactPhone: "x", loginId: "other-b", status: "pending", pendingWarehouseId: 41 } });
      const r = await listFor(40);
      assert.equal(r.status, 200, r.text);
      const items = r.body.items as Row[];
      assert.equal(items.length, 20, "最多 20 张");
      assert.deepEqual(items.map((x) => x.agentName), Array.from({ length: 20 }, (_, i) => `历史${22 - i}`), "新的在前，最老的 3 张不给");
      for (const x of items) assert.deepEqual(Object.keys(x).sort(), APPLICATION_KEYS);
      assert.equal(items[0].status, "rejected");
      assert.equal(items[0].rejectReason, "不合适");
      assert.equal(items[0].reviewedAt, new Date(base + 22 * 60_000 + 30_000).toISOString());
      assert.ok(!r.text.includes("别的仓的"));
      assert.deepEqual((await listFor(999)).body.items, [], "没交过的仓是空数组");
      for (const bad of ["", "abc", "0", "-1", "1.5", "01", " 40", "40 ", "2147483648", "99999999999"]) {
        const x = await call("GET", `${APPLY}?warehouseId=${encodeURIComponent(bad)}`, { headers: bearer });
        assert.equal(x.status, 400, `${JSON.stringify(bad)}: ${x.text.slice(0, 120)}`);
        assert.equal(x.body.code, "BAD_REQUEST");
      }
      assert.equal((await call("GET", APPLY, { headers: bearer })).status, 400, "不带仓号 400");
    });

    console.log("\n【超管审批】");
    const pending12 = await db.agentApplication.findFirst({ where: { companyId: CO, warehouseId: 12, status: "pending" } });

    await test("5a 只有超管：员工、客户、代理调列表 / 通过 / 驳回都 403；别家公司的申请看不到、动不了（404）", async () => {
      await db.agentApplication.create({ data: { id: `${P}otherco`, companyId: OTHER_CO, warehouseId: 40, warehouseName: "别家", submitterName: "x", agentName: "别家的", contactName: "x", contactPhone: "x", loginId: "other-a", status: "pending", pendingWarehouseId: 40 } });
      try {
      for (const [who, role] of [[STAFF, "staff"], [CLIENT, "client"], [OLD_AGENT, "agent"]] as const) {
        const h = asUser(who, role);
        assert.equal((await call("GET", "/admin/agents/applications/list", { headers: h })).status, 403, `${role} 列表`);
        assert.equal((await approve(pending12.id, {}, h)).status, 403, `${role} 通过`);
        assert.equal((await reject(pending12.id, "不行", h)).status, 403, `${role} 驳回`);
      }
      assert.equal((await call("GET", "/admin/agents/applications/list")).status, 401, "不登录 401");
      const list = await adminList();
      assert.equal(list.status, 200, list.text);
      assert.ok(!(list.body.data.items as Row[]).some((x) => x.id === `${P}otherco`), "别家的申请不在列表里");
      assert.equal((await approve(`${P}otherco`)).status, 404);
      assert.equal((await reject(`${P}otherco`, "x")).status, 404);
      assert.equal((await approve("not-exist")).status, 404);
      assert.equal((await adminList("weird")).status, 400, "状态乱写 400");
      const counts = list.body.data.counts;
      assert.equal(counts.rejected, 23);
      assert.equal(counts.pending, (list.body.data.items as Row[]).filter((x) => x.status === "pending").length);
      assert.ok((await adminList("pending")).body.data.items.every((x: Row) => x.status === "pending"));
      assert.equal((await db.agentApplication.findUnique({ where: { id: `${P}otherco` } })).status, "pending", "别家的没被动");
      } finally {
        await db.agentApplication.delete({ where: { id: `${P}otherco` } });
      }
    });

    await test("6 通过时登录账号已经有人用了：400，申请还是 pending，不多出代理行、用户行，logo 也不留", async () => {
      const before = await countAgentsAndUsers();
      const logosBefore = logos().length;
      const r = await approve(pending12.id, { loginId: OLD_AGENT, logo: LOGO });
      assert.equal(r.status, 400, r.text);
      assert.match(r.body.message, /这个登录账号已经有人用了/);
      assert.equal((await db.agentApplication.findUnique({ where: { id: pending12.id } })).status, "pending");
      assert.deepEqual(await countAgentsAndUsers(), before);
      assert.equal(logos().length, logosBefore);
      // 别的校验跟开代理一样
      const weak = await approve(pending12.id, { password: "12345678" });
      assert.equal(weak.status, 400, weak.text);
      const noPrice = await approve(pending12.id, { prices: { normal: 900 } });
      assert.equal(noPrice.status, 400, noPrice.text);
      const slugTaken = await approve(pending12.id, { slug: "zzapold" });
      assert.match(slugTaken.body.message, /后缀已经被别的代理用了/);
      assert.equal((await db.agentApplication.findUnique({ where: { id: pending12.id } })).status, "pending");
      assert.deepEqual(await countAgentsAndUsers(), before);
    });

    await test("5b 通过：开出 role=agent、状态正常的登录号和代理行（价、名字照填的）；申请变 approved、带实际开出的账号（可以跟申请的不一样）；财务那边查得到", async () => {
      const before = await countAgentsAndUsers();
      const r = await approve(pending12.id, { loginId: `${P}bkk-a2`, logo: LOGO });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.data.loginId, `${P}bkk-a2`);
      const agentId = r.body.data.agentId as string;
      const agent = await db.agent.findUnique({ where: { id: agentId } });
      assert.equal(agent.companyId, CO);
      assert.equal(agent.name, "曼谷 A 仓");
      assert.equal(Number(agent.priceNormal), 900);
      assert.equal(Number(agent.priceSpecial), 1250);
      assert.ok(agent.logoPath && logos().some((f) => agent.logoPath.endsWith(f)), "logo 存了");
      const login = await db.user.findUnique({ where: { id: `${P}bkk-a2` } });
      assert.equal(login.role, "agent");
      assert.equal(login.status, "active");
      assert.equal(login.agentId, agentId);
      assert.equal(login.companyId, CO);
      assert.ok(login.passwordHash && login.passwordHash !== AGENT_PASSWORD, "密码存的是哈希");
      assert.deepEqual(await countAgentsAndUsers(), { agents: before.agents + 1, agentUsers: before.agentUsers + 1 });
      const row = await db.agentApplication.findUnique({ where: { id: pending12.id } });
      assert.equal(row.status, "approved");
      assert.equal(row.pendingWarehouseId, null);
      assert.equal(row.approvedAgentId, agentId);
      assert.equal(row.approvedLoginId, `${P}bkk-a2`);
      assert.equal(row.reviewedById, ADMIN);
      assert.ok(row.reviewedAt instanceof Date);
      const fin = (await listFor(12)).body.items as Row[];
      assert.equal(fin[0].status, "approved");
      assert.equal(fin[0].loginId, "bkk-a", "申请时想用的照旧");
      assert.equal(fin[0].approvedLoginId, `${P}bkk-a2`, "真正开出来的");
      assert.equal(fin[0].reviewedAt, row.reviewedAt.toISOString());
      const adminRow = ((await adminList("approved")).body.data.items as Row[]).find((x) => x.id === pending12.id)!;
      assert.equal(adminRow.reviewedByName, ADMIN_NAME, "超管列表看得到谁处理的");
      assert.equal(adminRow.approvedLoginId, `${P}bkk-a2`);
      assert.equal(adminRow.approvedAgentId, agentId);
      assert.equal((await apply(good(12))).status, 201, "通过以后这个仓又能交新的（不卡）");
    });

    await test("7 同一张通过两次、驳回后再通过、通过后再驳回：都 409「这张申请已经处理过了」，不多开号", async () => {
      const before = await countAgentsAndUsers();
      const again = await approve(pending12.id, { loginId: `${P}twice` });
      assert.equal(again.status, 409, again.text);
      assert.equal(again.body.message, "这张申请已经处理过了");
      const rejectApproved = await reject(pending12.id, "改主意了");
      assert.equal(rejectApproved.status, 409, rejectApproved.text);
      const w20 = await db.agentApplication.findFirst({ where: { companyId: CO, warehouseId: 20, status: "pending" } });
      assert.equal((await reject(w20.id, "资料不全")).status, 200);
      const approveRejected = await approve(w20.id, { loginId: `${P}late` });
      assert.equal(approveRejected.status, 409, approveRejected.text);
      assert.equal((await reject(w20.id, "再驳一次")).status, 409);
      assert.deepEqual(await countAgentsAndUsers(), before);
      assert.equal((await db.agentApplication.findUnique({ where: { id: w20.id } })).rejectReason, "资料不全", "原因不被第二次盖掉");
    });

    await test("7b 两个超管同时点同一张的「通过」：只开出一个号；另一个 409（或账号已被用 400），申请只记一次", async () => {
      const w21 = await db.agentApplication.findFirst({ where: { companyId: CO, warehouseId: 21, status: "pending" } });
      const before = await countAgentsAndUsers();
      const [a, b] = await Promise.all([approve(w21.id, { loginId: `${P}race1` }), approve(w21.id, { loginId: `${P}race2` })]);
      assert.deepEqual([a.status, b.status].sort(), [200, 409], `${a.text.slice(0, 100)} / ${b.text.slice(0, 100)}`);
      assert.deepEqual(await countAgentsAndUsers(), { agents: before.agents + 1, agentUsers: before.agentUsers + 1 });
      const row = await db.agentApplication.findUnique({ where: { id: w21.id } });
      const winner = a.status === 200 ? `${P}race1` : `${P}race2`;
      assert.equal(row.approvedLoginId, winner);
      assert.equal(await db.user.count({ where: { id: { in: [`${P}race1`, `${P}race2`] } } }), 1);
    });

    await test("7d 两个超管用同一个预填账号同时点通过：只开出一个号，另一个 409「这张申请已经处理过了」（不是「账号被占」）", async () => {
      const app = (await apply(good(60))).body.application as Row;
      const before = await countAgentsAndUsers();
      const [a, b] = await Promise.all([approve(app.id, { loginId: `${P}samepre` }), approve(app.id, { loginId: `${P}samepre` })]);
      assert.deepEqual([a.status, b.status].sort(), [200, 409], `${a.text.slice(0, 100)} / ${b.text.slice(0, 100)}`);
      assert.equal((a.status === 409 ? a : b).body.message, "这张申请已经处理过了");
      assert.deepEqual(await countAgentsAndUsers(), { agents: before.agents + 1, agentUsers: before.agentUsers + 1 });
      // 错峰：先到的处理完了，后到的才查账号 —— 照样说「已经处理过了」
      const late = await approve(app.id, { loginId: `${P}samepre` });
      assert.equal(late.status, 409, late.text);
      assert.equal(late.body.message, "这张申请已经处理过了");
    });

    await test("7e 一个超管点通过、另一个同时点驳回：只有一个成；申请的状态跟有没有开号对得上", async () => {
      for (const wh of [61, 62, 63]) {
        const app = (await apply(good(wh))).body.application as Row;
        const before = await countAgentsAndUsers();
        const [a, r] = await Promise.all([approve(app.id, { loginId: `${P}ar${wh}` }), reject(app.id, "同时驳回")]);
        assert.deepEqual([a.status, r.status].sort(), [200, 409], `${a.text.slice(0, 100)} / ${r.text.slice(0, 100)}`);
        const row = await db.agentApplication.findUnique({ where: { id: app.id } });
        const after = await countAgentsAndUsers();
        if (a.status === 200) {
          assert.equal(row.status, "approved");
          assert.equal(row.rejectReason, null);
          assert.deepEqual(after, { agents: before.agents + 1, agentUsers: before.agentUsers + 1 });
        } else {
          assert.equal(row.status, "rejected");
          assert.equal(row.approvedAgentId, null);
          assert.deepEqual(after, before, "驳回赢了就一个号都不开");
        }
        assert.equal(row.pendingWarehouseId, null);
      }
    });

    await test("7f 处理人的账号后来被删了：列表照样给处理人编号（名字给 null），页面显示编号", async () => {
      await db.user.create({ data: user(`${P}admin3`, "admin", "临时超管ZZAP") });
      const app = (await apply(good(64))).body.application as Row;
      assert.equal((await reject(app.id, "临时超管驳的", asUser(`${P}admin3`, "admin"))).status, 200);
      await db.user.delete({ where: { id: `${P}admin3` } });
      const row = ((await adminList("rejected")).body.data.items as Row[]).find((x) => x.id === app.id)!;
      assert.equal(row.reviewedById, `${P}admin3`);
      assert.equal(row.reviewedByName, null);
      const panel = readFileSync(path.join(ROOT, "apps/web/src/components/admin/agents/AgentApplicationsPanel.tsx"), "utf8");
      assert.ok(panel.includes("{a.reviewedByName ?? a.reviewedById ?? \"—\"}"), "页面没名字时显示编号");
    });

    await test("7c 两张申请同时通过、用同一个登录账号：只成一张；输的那张整个回滚 —— 还是 pending、不留代理行和用户行、logo 删掉", async () => {
      const x = await apply(good(50));
      const y = await apply(good(51));
      const before = await countAgentsAndUsers();
      const logosBefore = logos().length;
      const [a, b] = await Promise.all([
        approve(x.body.application.id, { loginId: `${P}same`, logo: LOGO }),
        approve(y.body.application.id, { loginId: `${P}same`, logo: LOGO }),
      ]);
      assert.deepEqual([a.status, b.status].sort(), [200, 400], `${a.text.slice(0, 100)} / ${b.text.slice(0, 100)}`);
      const loser = a.status === 400 ? x.body.application.id : y.body.application.id;
      const loserRow = await db.agentApplication.findUnique({ where: { id: loser } });
      assert.equal(loserRow.status, "pending");
      assert.equal(loserRow.pendingWarehouseId, loserRow.warehouseId, "在审标记也回滚回来了");
      assert.equal(loserRow.approvedAgentId, null);
      assert.equal(loserRow.reviewedById, null);
      assert.deepEqual(await countAgentsAndUsers(), { agents: before.agents + 1, agentUsers: before.agentUsers + 1 });
      assert.equal(logos().length, logosBefore + 1, "输的那张的 logo 删掉了，只剩赢的那张的");
    });

    await test("8 驳回：不填原因 / 只有空格 / 超过 200 字 400；驳回后财务看得到原因；这个仓可以再交", async () => {
      const w51 = await db.agentApplication.findFirst({ where: { companyId: CO, warehouseId: { in: [50, 51] }, status: "pending" } });
      for (const bad of [undefined, "", "   ", "\u0001", 12, "原".repeat(201)]) {
        const r = await reject(w51.id, bad);
        assert.equal(r.status, 400, `${JSON.stringify(bad)?.slice(0, 20)}: ${r.text.slice(0, 120)}`);
      }
      assert.equal((await db.agentApplication.findUnique({ where: { id: w51.id } })).status, "pending");
      const ok = await reject(w51.id, "  资料不全，请补营业执照  ");
      assert.equal(ok.status, 200, ok.text);
      const fin = (await listFor(w51.warehouseId)).body.items as Row[];
      assert.equal(fin[0].status, "rejected");
      assert.equal(fin[0].rejectReason, "资料不全，请补营业执照");
      assert.equal(fin[0].approvedLoginId, null);
      const again = await apply(good(w51.warehouseId, { agentName: "补了资料" }));
      assert.equal(again.status, 201, again.text);
      const rows = (await listFor(w51.warehouseId)).body.items as Row[];
      assert.deepEqual(rows.slice(0, 2).map((r) => r.status), ["pending", "rejected"], "新交的在前");
    });

    await test("9 开代理（/admin/agents/create）照旧：真库开一个，返回 { id, loginId }，代理行 + 登录号都在", async () => {
      const r = await call("POST", "/admin/agents/create", { headers: admin, body: { name: "直接开的代理", prices: { normal: 700, inspection: 750, sensitive: 800 }, loginId: `${P}direct`, password: AGENT_PASSWORD } });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(Object.keys(r.body.data).sort(), ["id", "loginId"]);
      assert.equal(r.body.data.loginId, `${P}direct`);
      const login = await db.user.findUnique({ where: { id: `${P}direct` } });
      assert.equal(login.role, "agent");
      assert.equal(login.agentId, r.body.data.id);
      assert.equal(Number((await db.agent.findUnique({ where: { id: r.body.data.id } })).priceSpecial), 1250, "特货没传默认 1250");
      const dup = await call("POST", "/admin/agents/create", { headers: admin, body: { name: "撞号", prices: { normal: 700, inspection: 750, sensitive: 800 }, loginId: `${P}direct`, password: AGENT_PASSWORD } });
      assert.equal(dup.status, 400);
      assert.match(dup.body.message, /这个登录账号已经有人用了/);
    });

    await test("10 给海外仓财务系统的响应全文：搜 price、password、hash 都是 0；也没有代理 id、审批人、公司、在审标记", async () => {
      assert.ok(financeTexts.length >= 10, `收集到 ${financeTexts.length} 份成功响应`);
      // 申请编号是随机串，碰巧拼出 hash / price 也不算：先抹掉编号再搜
      const all = financeTexts.join("\n").replace(/"id":"[^"]*"/g, '"id":""').toLowerCase();
      for (const word of ["price", "password", "hash", "approvedagentid", "reviewedby", "companyid", "pendingwarehouseid", ADMIN.toLowerCase(), ADMIN_NAME.toLowerCase(), `${P}oldag`]) {
        assert.equal(all.split(word).length - 1, 0, `命中「${word}」`);
      }
    });

    // 迁移文件：要临时建库，只在本机 / CI 那种一次性库上跑
    const u = new URL(url);
    if (["127.0.0.1", "localhost", "::1", "[::1]"].includes(u.hostname)) {
      console.log("\n【迁移文件】");
      const runPrisma = (args: string[], dbUrl: string): { code: number; out: string } => {
        try {
          const out = execFileSync("npx", ["prisma", ...args], { cwd: ROOT, env: { ...process.env, DATABASE_URL: dbUrl }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
          return { code: 0, out };
        } catch (e: any) {
          return { code: typeof e.status === "number" ? e.status : 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
        }
      };
      const tmpName = `zz_mig_agent_apply_${Date.now().toString(36)}`;
      const tmp = new URL(url);
      tmp.pathname = `/${tmpName}`;
      const tmpUrl = tmp.toString();
      await prisma.$executeRawUnsafe(`CREATE DATABASE "${tmpName}"`);
      const tmpDb = new PrismaClient({ datasources: { db: { url: tmpUrl } } });
      try {
        await test("M1 上线前的库上跑两遍都不报错；跑完跟 schema.prisma 零差异；上线体检一行不报；现有数据一行不动；一个仓两张在审的写不进去", async () => {
          const push = runPrisma(["db", "push", `--schema=${SCHEMA}`, "--skip-generate"], tmpUrl);
          assert.equal(push.code, 0, `临时库建结构失败：${push.out.slice(-400)}`);
          await tmpDb.$executeRawUnsafe(`DROP TABLE "agent_applications"`);
          await tmpDb.$executeRawUnsafe(`INSERT INTO users (id, company_id, role, name, phone, status, password_hash) VALUES ('ZZM1', 'c_zz', 'client', '测试客户', '000', 'active', 'hash-keep')`);
          for (const n of [1, 2]) {
            const r = runPrisma(["db", "execute", `--schema=${SCHEMA}`, "--file", MIGRATION], tmpUrl);
            assert.equal(r.code, 0, `第 ${n} 遍失败：${r.out.slice(-400)}`);
          }
          const diff = runPrisma(["migrate", "diff", "--from-url", tmpUrl, "--to-schema-datamodel", SCHEMA, "--script", "--exit-code"], tmpUrl);
          assert.equal(diff.code, 0, `还差这些：\n${diff.out.split("\n").filter((l) => l.trim() && !l.startsWith("--")).slice(0, 12).join("\n")}`);
          const drift = await tmpDb.$queryRawUnsafe<Row[]>(readFileSync(DRIFT, "utf8"));
          assert.equal(drift.length, 0, `上线体检报了：${JSON.stringify(drift).slice(0, 300)}`);
          const rows = await tmpDb.$queryRawUnsafe<Row[]>(`SELECT password_hash, status FROM users WHERE id = 'ZZM1'`);
          assert.deepEqual(rows, [{ password_hash: "hash-keep", status: "active" }]);
          const ins = (id: string, pending: number | null) => tmpDb.$executeRawUnsafe(
            `INSERT INTO agent_applications (id, company_id, warehouse_id, warehouse_name, submitter_name, agent_name, contact_name, contact_phone, login_id, status, pending_warehouse_id, updated_at) VALUES ('${id}', 'c_zz', 7, 'w', 's', 'a', 'c', 'p', 'l', '${pending === null ? "rejected" : "pending"}', ${pending === null ? "NULL" : pending}, now())`,
          );
          await ins("m1", 7);
          await ins("m2", null);
          await ins("m3", null);
          await assert.rejects(ins("m4", 7), /23505|already exists|unique|duplicate/i, "同一家公司同一个仓第二张在审的写不进去");
          await tmpDb.$executeRawUnsafe(`DELETE FROM users WHERE id = 'ZZM1'`);
        });
      } finally {
        await tmpDb.$disconnect();
        await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${tmpName}" WITH (FORCE)`);
      }
    } else {
      console.log("\n【迁移文件】这一段要临时建库，只在本机一次性库上跑（CI 的 test-db 那一组会真跑）");
    }
  } finally {
    await cleanup();
    const left = await db.agentApplication.count({ where: { companyId: { in: COMPANIES } } })
      + await db.user.count({ where: { companyId: { in: COMPANIES } } })
      + await db.agent.count({ where: { companyId: { in: COMPANIES } } });
    if (left !== 0) { failures++; console.log(`  ❌ 测试数据没清干净，剩 ${left} 行`); }
    rmSync(imagesDir, { recursive: true, force: true });
    await prisma.$disconnect();
  }
  console.log(`\n通过 ${passes}，失败 ${failures}`);
  if (failures > 0) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error(e); process.exit(1); });
