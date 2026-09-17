/**
 * 超管「代理管理」接口自测（2026-09-16，B2）。不连数据库、不连外网 —— prisma 换成内存桩。
 *
 * 盯住这几件事（需求编号见 docs/交接文档-附件-代理账号确认单/final.md，该目录不进 git）：
 *  1. 前缀保留字**扫真目录**：apps/web/src/app 顶层每个页面/文件、apps/web/public 顶层、
 *     next.config.ts 的每个 rewrites 前缀，都必须在保留字里 —— 以后加页面忘了补这里就红
 *  2. 开代理：一次嵌套写入同时建 agents 行和 users(role=agent, agentId) 行；登录号撞了两行都不留
 *  3. 代理密码卡强度（123456、跟账号一样、全数字）；前缀格式 / 保留字 / 域名格式拦住
 *  4. 调高代理价：名下有客户价低于新价就拒，并列出是哪几个客户，**什么都没写**；
 *     锁序是先 `agents FOR UPDATE` 再查客户价（跟 long-term-price.ts 的 FOR SHARE 排队）
 *  5. 停用 / 启用代理登录号：只动 role=agent 那一行，名下客户照常（2.7）；停用后代理令牌当场失效
 *  6. 重置代理密码卡强度，旧令牌失效
 *  7. 员工令牌打这 8 个接口全 403；别的公司的代理 404、列表里不出现
 *  8. GET /admin/agents 返回形状符合给 B1 的约定（id / name / slug / clientCount / loginId / loginStatus / prices）
 *
 * 写法照 test-agent-foundation.ts：import 路由之前把 globalThis.__prisma 换成内存桩，
 * 真起一个 HTTP 服务走完整请求管线（验签 → session-guard → requireRole → 路由 → 业务错误转 400）。
 */
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/never?connect_timeout=1";
process.env.NODE_ENV = "test";
process.env.AUTH_SECRET = "zz_test_secret_for_agent_admin_only";
process.env.BIND_HOST = "127.0.0.1";

import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const IMAGES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "zz_b2_agent_admin_images_"));
process.env.IMAGES_DIR = IMAGES_DIR;

type Row = Record<string, any>;
const ROOT = process.cwd();

const failures: string[] = [];
let total = 0;
async function check(name: string, body: () => Promise<void> | void): Promise<void> {
  total += 1;
  try {
    await body();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push(name);
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.log(`  ❌ ${name}\n     ${message.split("\n").slice(0, 8).join("\n     ")}`);
  }
}

/* ────────────────────────── 内存桩 ────────────────────────── */

let db = {
  users: [] as Row[],
  agents: [] as Row[],
  prices: [] as Row[],
  statements: [] as Row[],
  lines: [] as Row[],
};
let events: string[] = [];
let seq = 0;

function pick(row: Row | undefined | null, select?: Row): Row | null {
  if (!row) return null;
  if (!select) return { ...row };
  const out: Row = {};
  for (const key of Object.keys(select)) if (select[key] === true) out[key] = row[key];
  return out;
}
/** 支持 equals / { in } 两种条件 */
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v === undefined) return true;
    if (v && typeof v === "object" && !(v instanceof Date) && Array.isArray(v.in)) return v.in.includes(row[k]);
    return row[k] === v;
  });
}
function p2002(target: string[]): Error {
  return Object.assign(new Error(`Unique constraint failed on ${target.join(",")}`), { code: "P2002", meta: { target } });
}
const clone = <T>(v: T): T => structuredClone(v);

const models: Row = {
  user: {
    async findUnique({ where, select }: Row) {
      return pick(db.users.find((u) => u.id === where.id), select);
    },
    async findFirst({ where, select }: Row) {
      return pick(db.users.filter((u) => matches(u, where)).sort((a, b) => a.createdAt - b.createdAt)[0], select);
    },
    async findMany({ where, select }: Row) {
      return db.users.filter((u) => matches(u, where)).sort((a, b) => a.createdAt - b.createdAt).map((u) => pick(u, select));
    },
    async update({ where, data }: Row) {
      const u = db.users.find((x) => x.id === where.id);
      if (!u) throw new Error("user not found");
      events.push(`write:users:${where.id}`);
      Object.assign(u, data);
      return { ...u };
    },
    async updateMany({ where, data }: Row) {
      const rows = db.users.filter((u) => matches(u, where));
      for (const u of rows) { Object.assign(u, data); events.push(`write:users:${u.id}`); }
      return { count: rows.length };
    },
  },
  agent: {
    async findUnique({ where, select }: Row) {
      const key = Object.keys(where)[0];
      return pick(db.agents.find((a) => a[key] === where[key]), select);
    },
    async findFirst({ where, select }: Row) {
      return pick(db.agents.find((a) => matches(a, where)), select);
    },
    async findMany({ where, select }: Row) {
      return db.agents.filter((a) => matches(a, where)).sort((a, b) => a.createdAt - b.createdAt).map((a) => pick(a, select));
    },
    async create({ data, select }: Row) {
      const { users, ...agentData } = data;
      // 嵌套写入要么全成要么全不成：先查唯一约束，再一起落库
      if (agentData.slug && db.agents.some((a) => a.slug === agentData.slug)) throw p2002(["slug"]);
      if (agentData.customDomain && db.agents.some((a) => a.customDomain === agentData.customDomain)) throw p2002(["custom_domain"]);
      for (const u of users?.create ?? []) if (db.users.some((x) => x.id === u.id)) throw p2002(["id"]);
      const id = `agent_${++seq}`;
      const now = new Date();
      db.agents.push({ id, ...agentData, createdAt: now, updatedAt: now });
      for (const u of users?.create ?? []) db.users.push({ ...u, agentId: id, createdAt: now });
      events.push(`write:agents:${id}`);
      return pick({ id }, select);
    },
    async update({ where, data }: Row) {
      const a = db.agents.find((x) => x.id === where.id);
      if (!a) throw new Error("agent not found");
      if (data.slug && db.agents.some((x) => x.id !== a.id && x.slug === data.slug)) throw p2002(["slug"]);
      events.push(`write:agents:${where.id}`);
      Object.assign(a, data, { updatedAt: new Date() });
      return { ...a };
    },
  },
  clientWhrPrice: {
    async findMany({ where }: Row) {
      events.push("read:client_whr_prices");
      return db.prices
        .filter((p) => p.companyId === where.companyId)
        .filter((p) => {
          const c = db.users.find((u) => u.id === p.clientId);
          return c && matches(c, where.client);
        })
        .sort((a, b) => (a.clientId < b.clientId ? -1 : 1))
        .map((p) => ({ ...p, client: { name: db.users.find((u) => u.id === p.clientId)!.name } }));
    },
  },
  agentRebateStatement: {
    async findMany({ where }: Row) {
      return db.statements.filter((s) => matches(s, where)).map((s) => ({ ...s, agent: { name: db.agents.find((a) => a.id === s.agentId)?.name } }));
    },
    async findFirst({ where }: Row) {
      const s = db.statements.find((x) => matches(x, where));
      return s ? { ...s, agent: { name: db.agents.find((a) => a.id === s.agentId)?.name } } : null;
    },
    async updateMany({ where, data }: Row) {
      const rows = db.statements.filter((s) => matches(s, where));
      for (const s of rows) { Object.assign(s, data); events.push(`write:agent_rebate_statements:${s.id}`); }
      return { count: rows.length };
    },
  },
  agentRebateLine: {
    async findMany({ where }: Row) {
      return db.lines.filter((l) => matches(l, where));
    },
  },
};

async function queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]> {
  const sql = strings.join("?").replace(/\s+/g, " ").trim();
  if (/FROM agents WHERE id = \? AND company_id = \? FOR UPDATE/.test(sql)) {
    events.push(`lock:agents:${values[0]}`);
    const a = db.agents.find((x) => x.id === values[0] && x.companyId === values[1]);
    return a ? [{ id: a.id, logo_path: a.logoPath, price_normal: a.priceNormal, price_inspection: a.priceInspection, price_sensitive: a.priceSensitive }] : [];
  }
  throw new Error(`桩没实现这句 SQL：${sql}`);
}

const stub: Row = {
  ...models,
  $queryRaw: queryRaw,
  async $transaction(fn: (tx: Row) => Promise<unknown>) {
    // 事务：失败就把整份内存库还原，才测得出「被拒时什么都没写」
    const snapshot = clone(db);
    try {
      return await fn({ ...models, $queryRaw: queryRaw });
    } catch (error) {
      db = snapshot;
      throw error;
    }
  },
  async $connect() {},
};
(globalThis as any).__prisma = stub;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/* ────────────────────────── 开测 ────────────────────────── */

async function main(): Promise<void> {
  const { hashPassword, verifyPassword } = await import("../apps/api/src/modules/auth/crypto-utils");
  const { signAuthToken } = await import("../apps/api/src/modules/auth/token");
  const { createApp } = await import("../apps/api/src/server");
  const { registerAgentAdminRoutes } = await import("../apps/api/src/modules/agents/admin-routes");
  const rules = await import("../apps/api/src/modules/agents/agent-rules");

  const now = new Date("2026-09-16T02:00:00Z");
  db.users = [
    { id: "zz_admin", companyId: "c1", role: "admin", name: "老板", status: "active", passwordHash: hashPassword("Admin#2026x"), agentId: null, createdAt: now },
    { id: "zz_staff", companyId: "c1", role: "staff", name: "员工甲", status: "active", passwordHash: hashPassword("Staff#2026x"), agentId: null, createdAt: now },
    { id: "zz_admin_c2", companyId: "c2", role: "admin", name: "别家老板", status: "active", passwordHash: hashPassword("Admin#2026y"), agentId: null, createdAt: now },
  ];
  const tokenFor = (userId: string): string => {
    const u = db.users.find((x) => x.id === userId)!;
    return signAuthToken({ userId, companyId: u.companyId, role: u.role, userName: u.name, passwordHash: u.passwordHash });
  };

  const app = createApp();
  registerAgentAdminRoutes(app);
  const port = await freePort();
  await new Promise<void>((resolve) => app.listen(port, resolve));
  const call = async (method: "GET" | "POST", p: string, token: string | null, body?: unknown): Promise<{ status: number; body: any }> => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const admin = tokenFor("zz_admin");

  const goodAgent = {
    name: "曼谷代理甲",
    slug: "BKK-Jia ",
    customDomain: "https://Wuliu.Example.com/",
    prices: { normal: 500, inspection: 550, sensitive: 600 },
    loginId: "zz_agent_jia",
    password: "Jia#Agent2026",
    // 1x1 透明 PNG
    logo: { mime: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" },
  };

  console.log("代理管理（超管）");

  await check("1) 前缀保留字盖住 app 目录顶层、public 顶层、next.config.ts 每个转发前缀", () => {
    const appDir = path.join(ROOT, "apps/web/src/app");
    const NEXT_CONVENTION_FILES = new Set(["page.tsx", "layout.tsx", "loading.tsx", "error.tsx", "not-found.tsx", "globals.css", "ledger.css"]);
    const missing: string[] = [];
    for (const entry of fs.readdirSync(appDir, { withFileTypes: true })) {
      if (!entry.isDirectory() && NEXT_CONVENTION_FILES.has(entry.name)) continue;
      // 动态段 / 路由组（[agentSlug]、(group)）本身不占网址
      if (/^[[(]/.test(entry.name)) continue;
      const seg = entry.name;
      if (!rules.RESERVED_AGENT_SLUGS.has(seg)) missing.push(`app/${seg}`);
      const bare = seg.replace(/\.[a-z]+$/, "");
      if (bare !== seg && !rules.RESERVED_AGENT_SLUGS.has(bare)) missing.push(`app/${seg}（去扩展名 ${bare}）`);
    }
    const publicDir = path.join(ROOT, "apps/web/public");
    if (fs.existsSync(publicDir)) {
      for (const entry of fs.readdirSync(publicDir)) {
        if (!rules.RESERVED_AGENT_SLUGS.has(entry)) missing.push(`public/${entry}`);
      }
    }
    const nextConfig = fs.readFileSync(path.join(ROOT, "apps/web/next.config.ts"), "utf-8");
    const sources = [...nextConfig.matchAll(/source:\s*"\/([^/":]+)/g)].map((m) => m[1]).filter((s) => s !== "(.*)");
    assert.ok(sources.length >= 5, `只从 next.config.ts 读到 ${sources.length} 个转发前缀，正则可能写窄了`);
    for (const s of sources) if (!rules.RESERVED_AGENT_SLUGS.has(s)) missing.push(`rewrite /${s}`);
    assert.deepEqual(missing, [], "这些网址前缀没进保留字，代理起这个前缀会跟现有页面/接口撞车");
  });

  await check("1b) 代理管理的接口网址不许跟任何页面网址重名（重名的接口浏览器永远打不到，拿回页面 HTML）", async () => {
    const pages: string[] = [];
    const walkPages = (dir: string, prefix: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walkPages(path.join(dir, entry.name), `${prefix}/${entry.name}`);
        else if (entry.name === "page.tsx") pages.push(prefix || "/");
      }
    };
    walkPages(path.join(ROOT, "apps/web/src/app"), "");
    assert.ok(pages.includes("/admin/agents"), `没扫到代理管理页面，扫描写窄了：${pages.join(", ")}`);
    const registered: string[] = [];
    const recorder = { get: (p: string) => registered.push(p), post: (p: string) => registered.push(p), delete: (p: string) => registered.push(p), listen: () => {} };
    registerAgentAdminRoutes(recorder as any);
    assert.ok(registered.length >= 8, `只登记到 ${registered.length} 个接口`);
    const clash = registered.filter((r) => pages.includes(r));
    assert.deepEqual(clash, [], "这些接口跟页面同一个网址：浏览器请求会被 Next 当成打开页面");
  });

  await check("2) 前缀 / 域名 / 登录号 / logo 规则（纯函数）", () => {
    assert.equal(rules.normalizeAgentSlug("  BKK-01 "), "bkk-01");
    assert.equal(rules.normalizeAgentSlug(""), null);
    assert.equal(rules.validateAgentSlug(null), null, "不设前缀是允许的");
    assert.equal(rules.validateAgentSlug("bkk-01"), null);
    assert.match(rules.validateAgentSlug("a")!, /2 到 31 位/);
    assert.match(rules.validateAgentSlug("-bkk")!, /开头不能是横杠/);
    assert.match(rules.validateAgentSlug("bkk_01")!, /小写字母/);
    assert.match(rules.validateAgentSlug("b".repeat(32))!, /2 到 31 位/);
    for (const r of ["admin", "agent", "login", "auth", "images", "api", "404"]) assert.match(rules.validateAgentSlug(r)!, /保留/, r);
    assert.equal(rules.normalizeAgentDomain(" HTTPS://Wuliu.Example.com/ "), "wuliu.example.com");
    assert.equal(rules.validateAgentDomain("wuliu.example.com"), null);
    assert.ok(rules.validateAgentDomain("wuliu.example.com/login"));
    assert.ok(rules.validateAgentDomain("localhost"));
    assert.ok(rules.validateAgentDomain("a..com"));
    assert.equal(rules.validateAgentLoginId("zz_agent.01@x"), null);
    assert.ok(rules.validateAgentLoginId("有空格 的"));
    assert.ok(rules.validateAgentLogo({ mime: "image/svg+xml", base64: "PHN2Zz4=" }), "svg 能塞脚本，不收");
    assert.ok(rules.validateAgentLogo({ mime: "image/png", base64: "A".repeat(3 * 1024 * 1024) }), "超过 2MB 拦");
  });

  await check("3) 员工令牌打 9 个代理管理接口全 403；没登录 401", async () => {
    const staff = tokenFor("zz_staff");
    const routes: Array<["GET" | "POST", string]> = [
      ["GET", "/admin/agents/list"], ["POST", "/admin/agents/create"], ["POST", "/admin/agents/update"],
      ["POST", "/admin/agents/login-status"], ["POST", "/admin/agents/reset-password"],
      ["GET", "/admin/agents/rebates"], ["GET", "/admin/agents/rebates/detail?id=x"], ["POST", "/admin/agents/rebates/mark-paid"],
    ["POST", "/admin/agents/rebates/undo-paid"],
    ];
    for (const [m, p] of routes) {
      const r = await call(m, p, staff, m === "POST" ? { id: "x" } : undefined);
      assert.equal(r.status, 403, `${m} ${p}`);
      const anon = await call(m, p, null, m === "POST" ? {} : undefined);
      assert.equal(anon.status, 401, `未登录 ${m} ${p}`);
    }
  });

  await check("4) 代理密码卡强度：123456 / 跟账号一样 / 全数字一律拦，而且什么都没建", async () => {
    for (const [pw, re] of [["123456", /至少 8 位/], ["zz_agent_jia", /账号名一样/], ["1234567890", /常见|全是数字/], ["", /请填/]] as const) {
      const r = await call("POST", "/admin/agents/create", admin, { ...goodAgent, password: pw });
      assert.equal(r.status, 400, pw);
      assert.match(r.body.message, re, pw);
    }
    assert.equal(db.agents.length, 0);
    assert.equal(db.users.filter((u) => u.role === "agent").length, 0);
  });

  await check("5) 前缀保留字 / 格式、域名格式、三档价缺一档都拦", async () => {
    let r = await call("POST", "/admin/agents/create", admin, { ...goodAgent, slug: "admin" });
    assert.equal(r.status, 400); assert.match(r.body.message, /保留/);
    r = await call("POST", "/admin/agents/create", admin, { ...goodAgent, slug: "bkk_01" });
    assert.equal(r.status, 400); assert.match(r.body.message, /小写字母/);
    r = await call("POST", "/admin/agents/create", admin, { ...goodAgent, customDomain: "not a domain" });
    assert.equal(r.status, 400); assert.match(r.body.message, /域名格式/);
    r = await call("POST", "/admin/agents/create", admin, { ...goodAgent, prices: { normal: 500, inspection: 550 } });
    assert.equal(r.status, 400); assert.match(r.body.message, /敏感货单价/);
    r = await call("POST", "/admin/agents/create", admin, { ...goodAgent, name: "  " });
    assert.equal(r.status, 400); assert.match(r.body.message, /代理名字/);
    assert.equal(db.agents.length, 0);
  });

  let agentId = "";
  await check("6) 开代理：agents 行 + users(role=agent, agentId) 行一起建；前缀、域名规整；logo 落盘；密码是哈希", async () => {
    const r = await call("POST", "/admin/agents/create", admin, goodAgent);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    agentId = r.body.data.id;
    assert.equal(r.body.data.loginId, "zz_agent_jia");
    const a = db.agents.find((x) => x.id === agentId)!;
    assert.equal(a.companyId, "c1");
    assert.equal(a.slug, "bkk-jia");
    assert.equal(a.customDomain, "wuliu.example.com");
    assert.deepEqual([a.priceNormal, a.priceInspection, a.priceSensitive], [500, 550, 600]);
    assert.match(a.logoPath, /^\/images\/agent_logo_[0-9a-f]+\.png$/);
    assert.ok(fs.existsSync(path.join(IMAGES_DIR, path.basename(a.logoPath))), "logo 文件要真落盘");
    const login = db.users.find((u) => u.id === "zz_agent_jia")!;
    assert.equal(login.role, "agent");
    assert.equal(login.agentId, agentId);
    assert.equal(login.status, "active");
    assert.equal(login.companyId, "c1");
    assert.notEqual(login.passwordHash, goodAgent.password);
    assert.ok(verifyPassword(goodAgent.password, login.passwordHash));
  });

  await check("7) 登录号、前缀、域名撞了都拦，而且不留半截（没有多出代理行，logo 文件也删掉）", async () => {
    const filesBefore = fs.readdirSync(IMAGES_DIR).length;
    let r = await call("POST", "/admin/agents/create", admin, { ...goodAgent, slug: "other-1", customDomain: "" });
    assert.equal(r.status, 400); assert.match(r.body.message, /登录账号已经有人用了/);
    r = await call("POST", "/admin/agents/create", admin, { ...goodAgent, loginId: "zz_agent_yi", customDomain: "" });
    assert.equal(r.status, 400); assert.match(r.body.message, /前缀已经被别的代理用了/);
    r = await call("POST", "/admin/agents/create", admin, { ...goodAgent, loginId: "zz_agent_yi", slug: "other-2" });
    assert.equal(r.status, 400); assert.match(r.body.message, /专属域名已经被别的代理用了/);
    assert.equal(db.agents.length, 1);
    assert.equal(fs.readdirSync(IMAGES_DIR).length, filesBefore, "被拒的请求不许留下 logo 文件");

    // 预检查之后、写入之前被别人抢先（并发）：唯一约束兜住，两行都不留、logo 删掉
    const origFindUnique = models.user.findUnique;
    models.user.findUnique = async (args: Row) => {
      const result = await origFindUnique(args);
      if (args.where.id === "zz_race") {
        db.users.push({ id: "zz_race", companyId: "c1", role: "client", name: "抢先", status: "active", passwordHash: null, agentId: null, createdAt: new Date() });
      }
      return result;
    };
    try {
      r = await call("POST", "/admin/agents/create", admin, { ...goodAgent, loginId: "zz_race", slug: "race-1", customDomain: "" });
    } finally {
      models.user.findUnique = origFindUnique;
    }
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.message, /登录账号已经有人用了/);
    assert.equal(db.agents.length, 1, "登录号建不出来，代理行也不许留");
    assert.equal(fs.readdirSync(IMAGES_DIR).length, filesBefore);
  });

  // 名下两个客户 + 一个湘泰客户 + 别家公司一个代理
  db.users.push(
    { id: "zz_c_a1", companyId: "c1", role: "client", name: "客户一", status: "active", passwordHash: null, agentId: "", createdAt: now },
    { id: "zz_c_a2", companyId: "c1", role: "client", name: "zz_c_a2", status: "active", passwordHash: null, agentId: "", createdAt: now },
    { id: "zz_c_xt", companyId: "c1", role: "client", name: "湘泰客户", status: "active", passwordHash: null, agentId: null, createdAt: now },
  );
  const fixAgentIds = () => {
    for (const u of db.users) if (u.agentId === "") u.agentId = agentId;
  };

  await check("8) GET /admin/agents：形状符合给 B1 的约定；客户数只数客户不数登录号；别家公司看不到", async () => {
    fixAgentIds();
    db.agents.push({ id: "agent_other_co", companyId: "c2", name: "别家代理", slug: "c2-agent", customDomain: null, logoPath: null, priceNormal: 1, priceInspection: 1, priceSensitive: 1, createdAt: now, updatedAt: now });
    const r = await call("GET", "/admin/agents/list", admin);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.items.length, 1);
    const it = r.body.data.items[0];
    assert.deepEqual(
      { id: it.id, name: it.name, slug: it.slug, clientCount: it.clientCount, loginId: it.loginId, loginStatus: it.loginStatus, prices: it.prices },
      { id: agentId, name: "曼谷代理甲", slug: "bkk-jia", clientCount: 2, loginId: "zz_agent_jia", loginStatus: "active", prices: { normal: 500, inspection: 550, sensitive: 600 } },
    );
    assert.equal(typeof it.logoUrl, "string");
    assert.equal(it.customDomain, "wuliu.example.com");
    assert.ok(!("passwordHash" in it), "列表不许带密码哈希");
    const c2 = await call("GET", "/admin/agents/list", tokenFor("zz_admin_c2"));
    assert.deepEqual(c2.body.data.items.map((x: Row) => x.id), ["agent_other_co"]);
  });

  const updateBody = (prices: Row, extra: Row = {}) => ({
    id: agentId, name: "曼谷代理甲", slug: "bkk-jia", customDomain: "wuliu.example.com", prices, ...extra,
  });

  await check("9) 调高代理价：名下有客户价低于新价 → 400 并列出客户和档位，什么都没写；锁序先锁 agents 再查客户价", async () => {
    db.prices = [
      { clientId: "zz_c_a1", companyId: "c1", priceNormal: 520, priceInspection: 570, priceSensitive: 650 },
      { clientId: "zz_c_a2", companyId: "c1", priceNormal: 505, priceInspection: 560, priceSensitive: 700 },
      // 湘泰客户价很低，但不是这个代理名下的，不许算进来
      { clientId: "zz_c_xt", companyId: "c1", priceNormal: 100, priceInspection: 100, priceSensitive: 100 },
    ];
    events = [];
    const r = await call("POST", "/admin/agents/update", admin, updateBody({ normal: 510, inspection: 580, sensitive: 600 }, { name: "改了名字" }));
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.message, /名下有 2 个客户/);
    assert.match(r.body.message, /zz_c_a1（客户一）：商检货 570（新代理价 580）/, "要写清楚是哪个客户、哪一档");
    assert.match(r.body.message, /zz_c_a2：普货 505（新代理价 510），商检货 560（新代理价 580）/);
    assert.doesNotMatch(r.body.message, /zz_c_xt/);
    assert.doesNotMatch(r.body.message, /zz_c_a1（客户一）：普货/, "520 ≥ 510 的档不许误报");
    const a = db.agents.find((x) => x.id === agentId)!;
    assert.equal(a.name, "曼谷代理甲", "被拒时名字也不许改");
    assert.equal(a.priceNormal, 500);
    const lockAt = events.indexOf(`lock:agents:${agentId}`);
    const readAt = events.indexOf("read:client_whr_prices");
    assert.ok(lockAt >= 0 && readAt > lockAt, `锁序不对：${events.join(" → ")}`);
    assert.ok(!events.some((e) => e.startsWith("write:")), `被拒时不许写：${events.join(" → ")}`);
  });

  await check("10) 调高到不低于所有客户价、或者调低 → 保存成功；只调低不去查客户价", async () => {
    events = [];
    let r = await call("POST", "/admin/agents/update", admin, updateBody({ normal: 505, inspection: 560, sensitive: 650 }, { name: "曼谷代理甲（新）", slug: "bkk-new", customDomain: "" }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const a = db.agents.find((x) => x.id === agentId)!;
    assert.deepEqual([a.name, a.slug, a.customDomain, a.priceNormal, a.priceInspection, a.priceSensitive], ["曼谷代理甲（新）", "bkk-new", null, 505, 560, 650]);
    assert.ok(events.indexOf(`lock:agents:${agentId}`) < events.indexOf(`write:agents:${agentId}`));

    events = [];
    r = await call("POST", "/admin/agents/update", admin, updateBody({ normal: 400, inspection: 400, sensitive: 400 }, { name: "曼谷代理甲", slug: "bkk-jia" }));
    assert.equal(r.status, 200);
    assert.ok(!events.includes("read:client_whr_prices"), "三档都没调高，不用查客户价");
  });

  await check("11) 编辑：换 logo 删旧文件；removeLogo 清空；别家公司的代理 404；前缀改成保留字拦", async () => {
    const oldPath = db.agents.find((x) => x.id === agentId)!.logoPath;
    let r = await call("POST", "/admin/agents/update", admin, updateBody({ normal: 400, inspection: 400, sensitive: 400 }, { logo: goodAgent.logo }));
    assert.equal(r.status, 200);
    const newPath = db.agents.find((x) => x.id === agentId)!.logoPath;
    assert.notEqual(newPath, oldPath);
    assert.ok(fs.existsSync(path.join(IMAGES_DIR, path.basename(newPath))));
    assert.ok(!fs.existsSync(path.join(IMAGES_DIR, path.basename(oldPath))), "旧 logo 文件要删掉");
    r = await call("POST", "/admin/agents/update", admin, updateBody({ normal: 400, inspection: 400, sensitive: 400 }, { removeLogo: true }));
    assert.equal(r.status, 200);
    assert.equal(db.agents.find((x) => x.id === agentId)!.logoPath, null);
    r = await call("POST", "/admin/agents/update", admin, { ...updateBody({ normal: 1, inspection: 1, sensitive: 1 }), id: "agent_other_co" });
    assert.equal(r.status, 404);
    r = await call("POST", "/admin/agents/update", admin, updateBody({ normal: 400, inspection: 400, sensitive: 400 }, { slug: "login" }));
    assert.equal(r.status, 400);
  });

  await check("12) 停用代理登录号：只动 role=agent 那一行，名下客户照常；代理旧令牌当场失效；再启用又能用", async () => {
    const agentToken = signAuthToken({ userId: "zz_agent_jia", companyId: "c1", role: "agent", userName: "x", passwordHash: db.users.find((u) => u.id === "zz_agent_jia")!.passwordHash });
    const { isSessionStillValid } = await import("../apps/api/src/modules/auth/session-guard");
    const { verifyAuthToken } = await import("../apps/api/src/modules/auth/token");
    assert.equal((await isSessionStillValid(verifyAuthToken(agentToken)!)).ok, true);

    let r = await call("POST", "/admin/agents/login-status", admin, { id: agentId, status: "inactive" });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.loginStatus, "inactive");
    assert.equal(db.users.find((u) => u.id === "zz_agent_jia")!.status, "inactive");
    for (const c of ["zz_c_a1", "zz_c_a2"]) assert.equal(db.users.find((u) => u.id === c)!.status, "active", `${c} 不许被停`);
    assert.equal((await isSessionStillValid(verifyAuthToken(agentToken)!)).ok, false, "停用后旧令牌必须当场失效");
    // 重复点停用：结果一样，不会变成启用
    r = await call("POST", "/admin/agents/login-status", admin, { id: agentId, status: "inactive" });
    assert.equal(db.users.find((u) => u.id === "zz_agent_jia")!.status, "inactive");

    r = await call("POST", "/admin/agents/login-status", admin, { id: agentId, status: "active" });
    assert.equal(r.status, 200);
    assert.equal((await isSessionStillValid(verifyAuthToken(agentToken)!)).ok, true);
    r = await call("POST", "/admin/agents/login-status", admin, { id: agentId, status: "banned" });
    assert.equal(r.status, 400);
    r = await call("POST", "/admin/agents/login-status", admin, { id: "agent_other_co", status: "inactive" });
    assert.equal(r.status, 404);
  });

  await check("13) 重置代理密码：弱密码拦；成功后新密码能验、旧令牌失效；别家公司 404", async () => {
    const before = db.users.find((u) => u.id === "zz_agent_jia")!.passwordHash;
    const oldToken = signAuthToken({ userId: "zz_agent_jia", companyId: "c1", role: "agent", userName: "x", passwordHash: before });
    let r = await call("POST", "/admin/agents/reset-password", admin, { id: agentId, password: "12345678" });
    assert.equal(r.status, 400);
    assert.equal(db.users.find((u) => u.id === "zz_agent_jia")!.passwordHash, before);
    r = await call("POST", "/admin/agents/reset-password", admin, { id: agentId, password: "New#Agent2026" });
    assert.equal(r.status, 200);
    const after = db.users.find((u) => u.id === "zz_agent_jia")!.passwordHash;
    assert.ok(verifyPassword("New#Agent2026", after));
    const { isSessionStillValid } = await import("../apps/api/src/modules/auth/session-guard");
    const { verifyAuthToken } = await import("../apps/api/src/modules/auth/token");
    assert.equal((await isSessionStillValid(verifyAuthToken(oldToken)!)).ok, false);
    for (const c of ["zz_c_a1", "zz_c_a2"]) assert.equal(db.users.find((u) => u.id === c)!.passwordHash, null, "客户密码不许被连带改");
    r = await call("POST", "/admin/agents/reset-password", admin, { id: "agent_other_co", password: "New#Agent2026" });
    assert.equal(r.status, 404);
  });

  fs.rmSync(IMAGES_DIR, { recursive: true, force: true });
  console.log(`\n共 ${total} 项，失败 ${failures.length} 项`);
  if (failures.length > 0) {
    console.log("❌ 失败：\n  - " + failures.join("\n  - "));
    process.exit(1);
  }
  console.log("✅ 全部通过");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  fs.rmSync(IMAGES_DIR, { recursive: true, force: true });
  process.exit(1);
});
