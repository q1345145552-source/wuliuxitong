/**
 * 代理的客户换牌子自测（2026-09-16，B4）。不连数据库、不连外网 —— prisma 换成内存桩。
 *
 * 需求：确认单 5.1-5.4、5.7（docs/交接文档-附件-代理账号确认单/final.md，该目录不进 git）。
 * 盯住这几件事：
 *  1. 公开接口 GET /auth/brand **只回名字和 logo**：桩故意无视 select、把整行（三档代理价、专属域名、
 *     公司、前缀）都塞回来 —— 响应里只要多出一个字段就是没有「明确列字段」（CLAUDE.md #31）
 *  2. 前缀 / 域名规范化；格式不对、IP、localhost 不查库；查不到、限流都回 null（不区分）
 *  3. logo 只认 /images/<文件名>，别的地址不给
 *  4. GET /client/brand：代理的客户回代理的；湘泰客户 null；员工 / 管理员 403；代理令牌被统一闸 403；
 *     改归属当场生效（agentId 由 session-guard 现读）；别的公司的代理行不认
 *  5. GET /agent/brand：代理本人拿到；代理的客户 403；代理行没了 404
 *  6. 前端纯逻辑：外壳品牌（藏哪些菜单、改哪些名字，id 必须真在 menu-config 里）、
 *     /login 转代理登录页的地址不许被 cookie 带出站外、首字图标转义、前后端规范化口径一致
 *  7. 前缀登录页敢放在根目录动态段的前提：next.config.ts 的 rewrites 仍是数组写法（afterFiles，先于动态路由）
 *  8. 登录接口 POST /auth/login 成功时顺带回品牌（第 1 轮审查后加固，防进工作台首帧闪错牌子）：
 *     只算刚登录的这个账号、只三个字段；失败出口一个字都不带；查品牌出错不许把登录弄挂；
 *     前端 readLoginBrand 只认接口说的
 */
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/never?connect_timeout=1";
process.env.NODE_ENV = "test";
process.env.AUTH_SECRET = "zz_test_secret_for_agent_branding_only";
process.env.BIND_HOST = "127.0.0.1";

import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

type Row = Record<string, any>;

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
    console.log(`  ❌ ${name}\n     ${message.split("\n").slice(0, 6).join("\n     ")}`);
  }
}

/* ────────────────────────── 内存桩 ────────────────────────── */

const db = { users: [] as Row[], agents: [] as Row[] };
let agentCalls = 0;
/** 置 true 时按 id 查代理直接抛错（模拟登录时查品牌那一下数据库出错） */
let agentFindFirstThrows = false;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => row[k] === v);
}

const stub: Row = {
  user: {
    async findUnique({ where }: Row) {
      const u = db.users.find((x) => x.id === where.id);
      return u ? { ...u } : null;
    },
  },
  agent: {
    // ⚠️ 故意无视 select，整行原样返回（含价格、域名）：接口必须自己挑字段
    async findUnique({ where }: Row) {
      agentCalls += 1;
      const keys = Object.keys(where);
      assert.equal(keys.length, 1, "findUnique 只能按一个唯一键查");
      const a = db.agents.find((x) => matches(x, where));
      return a ? { ...a } : null;
    },
    async findFirst({ where }: Row) {
      agentCalls += 1;
      if (agentFindFirstThrows) throw new Error("zz 模拟数据库出错");
      assert.ok(where.id, "按 id 查代理必须带 id");
      assert.ok(where.companyId, "按 id 查代理必须同时卡公司");
      const a = db.agents.find((x) => matches(x, where));
      return a ? { ...a } : null;
    },
  },
};
(globalThis as any).__prisma = stub;

const SECRET_VALUES = ["500", "600", "700", "agent.example.com", "c_001"];

function resetFixtures(): void {
  db.agents = [
    {
      id: "zz_b4_agentA", companyId: "c_001", name: "A 代理国际物流", logoPath: "/images/zz_b4_logo_abc123.png",
      slug: "zz-b4-a", customDomain: "agent.example.com", priceNormal: 500, priceInspection: 600, priceSensitive: 700,
    },
    {
      id: "zz_b4_agentB", companyId: "c_001", name: "<B>代理", logoPath: "https://evil.example.net/x.png",
      slug: null, customDomain: null, priceNormal: 500, priceInspection: 600, priceSensitive: 700,
    },
    {
      id: "zz_b4_agentOther", companyId: "c_zzz_other", name: "别家公司的代理", logoPath: null,
      slug: "zz-b4-other", customDomain: null, priceNormal: 500, priceInspection: 600, priceSensitive: 700,
    },
  ];
  const base = { status: "active", passwordHash: "h", companyId: "c_001" };
  db.users = [
    { ...base, id: "zz_b4_client_a", role: "client", agentId: "zz_b4_agentA" },
    { ...base, id: "zz_b4_client_b", role: "client", agentId: "zz_b4_agentB" },
    { ...base, id: "zz_b4_client_xt", role: "client", agentId: null },
    { ...base, id: "zz_b4_client_cross", role: "client", agentId: "zz_b4_agentOther" },
    { ...base, id: "zz_b4_agent_login", role: "agent", agentId: "zz_b4_agentA" },
    { ...base, id: "zz_b4_agent_ghost", role: "agent", agentId: "zz_b4_agent_deleted" },
    { ...base, id: "zz_b4_staff", role: "staff", agentId: null },
    { ...base, id: "zz_b4_admin", role: "admin", agentId: null },
  ];
}

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
  resetFixtures();
  const { signAuthToken } = await import("../apps/api/src/modules/auth/token");
  const { createApp } = await import("../apps/api/src/server");
  const api = await import("../apps/api/src/modules/branding/routes");
  const web = await import("../apps/web/src/modules/branding/brand-core");
  const { roleFunctionGroups } = await import("../apps/web/src/modules/layout/menu-config");

  const tokenFor = (userId: string): string => {
    const u = db.users.find((x) => x.id === userId)!;
    return signAuthToken({ userId, companyId: u.companyId, role: u.role, userName: userId, passwordHash: u.passwordHash });
  };

  const app = createApp();
  api.registerBrandingRoutes(app);
  const { registerAuthRoutes } = await import("../apps/api/src/modules/auth/routes");
  const { hashPassword } = await import("../apps/api/src/modules/auth/crypto-utils");
  registerAuthRoutes(app);
  const port = await freePort();
  await new Promise<void>((resolve) => app.listen(port, resolve));
  const call = async (p: string, opts: { token?: string; ip?: string } = {}): Promise<{ status: number; body: any; raw: string }> => {
    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    headers["X-Real-IP"] = opts.ip ?? "203.0.113.1";
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers });
    const raw = await r.text();
    return { status: r.status, body: JSON.parse(raw), raw };
  };
  const noSecrets = (raw: string, where: string): void => {
    const dataText = JSON.stringify(JSON.parse(raw).data ?? {});
    for (const v of SECRET_VALUES) assert.ok(!dataText.includes(v), `${where} 响应里出现了不该给的值「${v}」：${dataText}`);
    for (const k of ["price", "Price", "customDomain", "companyId", "clientCount", "loginId", "slug\""]) {
      assert.ok(!dataText.includes(k), `${where} 响应里出现了字段「${k}」：${dataText}`);
    }
  };

  console.log("代理的客户换牌子");

  await check("1) 公开 /auth/brand?slug=：只回 name + logoUrl，价格 / 域名 / 公司 / 前缀一个都不带", async () => {
    const r = await call("/auth/brand?slug=zz-b4-a");
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body.data), ["brand"]);
    assert.deepEqual(r.body.data.brand, { name: "A 代理国际物流", logoUrl: "/images/zz_b4_logo_abc123.png" });
    noSecrets(r.raw, "/auth/brand?slug");
  });

  await check("2) 公开 /auth/brand?host=：去端口、转小写、去末尾点能认出专属域名；同样只回两个字段", async () => {
    for (const host of ["agent.example.com", "AGENT.Example.com:443", "agent.example.com."]) {
      const r = await call(`/auth/brand?host=${encodeURIComponent(host)}`);
      assert.deepEqual(r.body.data.brand, { name: "A 代理国际物流", logoUrl: "/images/zz_b4_logo_abc123.png" }, host);
      noSecrets(r.raw, `/auth/brand?host=${host}`);
    }
  });

  await check("3) 前缀大小写 / 两端空格照认；前缀优先于域名", async () => {
    const r = await call(`/auth/brand?slug=${encodeURIComponent(" ZZ-B4-A ")}&host=nothing.example.org`);
    assert.equal(r.body.data.brand?.name, "A 代理国际物流");
  });

  await check("4) 查不到 / 格式不对 / IP / localhost → brand: null；格式不对和 IP 根本不查库", async () => {
    let r = await call("/auth/brand?slug=zz-b4-nobody");
    assert.equal(r.status, 200);
    assert.equal(r.body.data.brand, null);
    r = await call("/auth/brand?host=xianlianth.com");
    assert.equal(r.body.data.brand, null);
    const before = agentCalls;
    for (const q of ["slug=..%2Fadmin", "slug=a", "slug=%2F%2Fevil.com", "slug=", "host=127.0.0.1:3000", "host=localhost:3000", "host=%5B%3A%3A1%5D", "host=not_a_domain", ""]) {
      r = await call(`/auth/brand?${q}`);
      assert.equal(r.status, 200, q);
      assert.equal(r.body.data.brand, null, q);
    }
    assert.equal(agentCalls, before, "格式不对 / IP / localhost 不许去查库");
  });

  await check("5) logo 只认 /images/<文件名>：外链 logo 回 null；名字原样给（前端 React 自己转义）", async () => {
    assert.equal(api.toLogoUrl("https://evil.example.net/x.png"), null);
    assert.equal(api.toLogoUrl("/images/../etc/passwd"), null);
    assert.equal(api.toLogoUrl("/images/a b.png"), null);
    assert.equal(api.toLogoUrl(null), null);
    assert.equal(api.toLogoUrl("/images/zz_b4_logo_abc123.png"), "/images/zz_b4_logo_abc123.png");
  });

  await check("6) 限流：同一 IP 一分钟超过 120 次也回 brand: null（不报错、不区分）；别的 IP 不受影响", async () => {
    const ip = "198.51.100.77";
    for (let i = 0; i < 120; i += 1) await call("/auth/brand?slug=zz-b4-a", { ip });
    const blocked = await call("/auth/brand?slug=zz-b4-a", { ip });
    assert.equal(blocked.status, 200);
    assert.equal(blocked.body.data.brand, null);
    const other = await call("/auth/brand?slug=zz-b4-a", { ip: "198.51.100.78" });
    assert.equal(other.body.data.brand?.name, "A 代理国际物流");
  });

  await check("7) /client/brand：代理的客户拿到 name / logoUrl / loginPath 三个字段，别的都不带", async () => {
    const r = await call("/client/brand", { token: tokenFor("zz_b4_client_a") });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data.brand, { name: "A 代理国际物流", logoUrl: "/images/zz_b4_logo_abc123.png", loginPath: "/zz-b4-a" });
    noSecrets(r.raw, "/client/brand");
    const b = await call("/client/brand", { token: tokenFor("zz_b4_client_b") });
    assert.deepEqual(b.body.data.brand, { name: "<B>代理", logoUrl: null, loginPath: null }, "没前缀 loginPath 为 null、外链 logo 不给");
  });

  await check("8) /client/brand：湘泰客户 null；员工 / 管理员 403；没登录 401；代理令牌被统一闸 403", async () => {
    assert.equal((await call("/client/brand", { token: tokenFor("zz_b4_client_xt") })).body.data.brand, null);
    assert.equal((await call("/client/brand", { token: tokenFor("zz_b4_staff") })).status, 403);
    assert.equal((await call("/client/brand", { token: tokenFor("zz_b4_admin") })).status, 403);
    assert.equal((await call("/client/brand")).status, 401);
    assert.equal((await call("/client/brand", { token: tokenFor("zz_b4_agent_login") })).status, 403);
  });

  await check("9) /client/brand：别的公司的代理行不认（按 id 查也卡公司）", async () => {
    const r = await call("/client/brand", { token: tokenFor("zz_b4_client_cross") });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.brand, null);
  });

  await check("10) 改归属当场生效：同一张令牌，库里 agentId 改了下一次请求就变（session-guard 现读）", async () => {
    const t = tokenFor("zz_b4_client_xt");
    assert.equal((await call("/client/brand", { token: t })).body.data.brand, null);
    db.users.find((u) => u.id === "zz_b4_client_xt")!.agentId = "zz_b4_agentA";
    assert.equal((await call("/client/brand", { token: t })).body.data.brand?.name, "A 代理国际物流");
    resetFixtures();
  });

  await check("11) /agent/brand：代理本人拿到三个字段；代理的客户 / 湘泰客户 / 管理员 403；代理行没了 404", async () => {
    const r = await call("/agent/brand", { token: tokenFor("zz_b4_agent_login") });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data.brand, { name: "A 代理国际物流", logoUrl: "/images/zz_b4_logo_abc123.png", loginPath: "/zz-b4-a" });
    noSecrets(r.raw, "/agent/brand");
    for (const u of ["zz_b4_client_a", "zz_b4_client_xt", "zz_b4_admin"]) {
      assert.equal((await call("/agent/brand", { token: tokenFor(u) })).status, 403, u);
    }
    assert.equal((await call("/agent/brand", { token: tokenFor("zz_b4_agent_ghost") })).status, 404);
  });

  await check("12) 前端外壳品牌：代理的客户藏普通版集货、「主页与AI」改「主页」；代理本人不藏；湘泰账号一律 null", () => {
    const info = { name: "A 代理", logoUrl: "/images/x.png" };
    assert.deepEqual(web.toWorkbenchBrand("client", info), {
      name: "A 代理", logoUrl: "/images/x.png", hiddenMenuIds: ["client-func-consolidation"], labelOverrides: { "client-func-main": "主页" },
    });
    assert.deepEqual(web.toWorkbenchBrand("agent", { name: "A 代理", logoUrl: null }), { name: "A 代理", hiddenMenuIds: [], labelOverrides: {} });
    for (const role of ["admin", "staff"]) assert.equal(web.toWorkbenchBrand(role, info), null, `${role} 永远是湘泰的样子`);
    assert.equal(web.toWorkbenchBrand("client", null), null);
    assert.equal(web.toWorkbenchBrand("client", undefined), null);
  });

  await check("13) 藏 / 改名的菜单 id 真在 menu-config 里（改菜单 id 忘了改这里会当场红）；仓库版集货、整柜询价不许藏", () => {
    const clientItems = roleFunctionGroups.client.flatMap((g) => g.items);
    const ids = new Set(clientItems.map((i) => i.id));
    for (const id of web.AGENT_CLIENT_HIDDEN_MENU_IDS) assert.ok(ids.has(id), `菜单里没有 ${id}`);
    for (const id of Object.keys(web.AGENT_CLIENT_LABEL_OVERRIDES)) assert.ok(ids.has(id), `菜单里没有 ${id}`);
    assert.equal(clientItems.find((i) => i.id === "client-func-consolidation")?.href, "/client/consolidation", "藏的必须是普通版");
    assert.equal(clientItems.find((i) => i.id === "client-func-main")?.label, "主页与AI");
    for (const keep of ["client-func-whr-consolidation", "client-func-fcl", "client-func-wallet"]) {
      assert.ok(!(web.AGENT_CLIENT_HIDDEN_MENU_IDS as readonly string[]).includes(keep), `${keep} 不许藏（5.6 / 5.8）`);
    }
  });

  await check("14) 前端解析接口回的品牌：loginPath 只认 /<合规前缀>，logo 只认 /images/，名字空的当没有", () => {
    assert.deepEqual(web.parseSessionBrand({ name: "A", logoUrl: "/images/a.png", loginPath: "/zz-b4-a" }), { name: "A", logoUrl: "/images/a.png", loginPath: "/zz-b4-a" });
    assert.equal(web.parseSessionBrand({ name: "A", logoUrl: null, loginPath: "//evil.com" })?.loginPath, null);
    assert.equal(web.parseSessionBrand({ name: "A", logoUrl: null, loginPath: "https://evil.com" })?.loginPath, null);
    assert.equal(web.parseSessionBrand({ name: "A", logoUrl: "javascript:alert(1)", loginPath: null })?.logoUrl, null);
    assert.equal(web.parseSessionBrand({ name: "  ", logoUrl: null }), null);
    assert.equal(web.parsePublicBrand(null), null);
    assert.equal(web.parsePublicBrand("A"), null);
  });

  await check("15) /login 转代理登录页的地址：只认合规前缀，cookie 被改成站外地址也跳不出去；查询串原样带上", () => {
    assert.equal(web.brandLoginRedirectPath("zz-b4-a", "?expired=1"), "/zz-b4-a?expired=1");
    assert.equal(web.brandLoginRedirectPath("ZZ-B4-A", ""), "/zz-b4-a");
    for (const bad of ["//evil.com", "/evil", "evil.com/x", "a", "", null, undefined, "zz b4", "%2F%2Fevil.com"]) {
      assert.equal(web.brandLoginRedirectPath(bad as any, ""), null, String(bad));
    }
    assert.equal(web.brandLoginRedirectPath("zz-b4-a", "expired=1"), "/zz-b4-a", "不是 ? 开头的查询串不拼");
  });

  await check("16) 首字图标：名字里的 < > 被转义进 SVG；空名字不崩", () => {
    const uri = web.letterIconDataUri("<B>代理");
    assert.ok(uri.startsWith("data:image/svg+xml,"));
    const svg = decodeURIComponent(uri.slice("data:image/svg+xml,".length));
    assert.ok(svg.includes("&#60;"), svg);
    assert.ok(!svg.includes("><B<") && !/<text[^>]*><</.test(svg), svg);
    assert.ok(web.letterIconDataUri("").startsWith("data:image/svg+xml,"));
    assert.equal(web.brandIconHref({ name: "A", logoUrl: "/images/a.png" }), "/images/a.png");
  });

  await check("17) 前后端规范化口径一致（前端服务端先过滤、后端再过滤，两边不一致就会出现「前端放行后端不认」）", () => {
    const slugs = [" ZZ-B4-A ", "zz-b4-a", "a", "ab", "-ab", "a_b", "admin", "x".repeat(31), "x".repeat(32), "//evil", 42, null];
    for (const s of slugs) assert.equal(web.normalizeBrandSlug(s), api.normalizeBrandSlug(s), `slug ${String(s)}`);
    const hosts = ["agent.example.com", "AGENT.example.com:8443", "agent.example.com.", "127.0.0.1", "localhost", "[::1]:3000", "a.b, c.d", "nodot", "bad_host.com", "", 1];
    for (const h of hosts) assert.equal(web.normalizeBrandHost(h), api.normalizeBrandHost(h), `host ${String(h)}`);
    assert.equal(api.normalizeBrandHost("a.b, c.d"), "a.b");
  });

  await check("18) 前缀登录页放根目录动态段的前提：rewrites 仍是数组写法（afterFiles，先于动态路由生效）", () => {
    const cfg = fs.readFileSync(path.join(process.cwd(), "apps/web/next.config.ts"), "utf-8");
    assert.match(cfg, /async rewrites\(\)\s*\{\s*return \[/, "rewrites 改成对象写法（beforeFiles/afterFiles/fallback）前，先回来重测 app/[agentSlug] 会不会吃掉转发");
    for (const prefix of ["auth", "admin", "staff", "client", "agent", "images"]) {
      assert.ok(cfg.includes(`source: "/${prefix}/:path*"`), `${prefix} 转发规则不见了`);
    }
    assert.ok(fs.existsSync(path.join(process.cwd(), "apps/web/src/app/[agentSlug]/page.tsx")), "前缀登录页文件不在");
  });

  /* ── 8. 登录接口顺带回品牌 ── */
  const LOGIN_PWD = "zz_fxb_login_fixture_pwd";
  const LOGIN_HASH = hashPassword(LOGIN_PWD);
  let loginIp = 0;
  const postLogin = async (body: Record<string, unknown>): Promise<{ status: number; body: any; raw: string }> => {
    // 每次换 IP：别撞上「每 IP 每分钟 10 次」那道闸
    loginIp += 1;
    const r = await fetch(`http://127.0.0.1:${port}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Real-IP": `203.0.113.${100 + loginIp}` },
      body: JSON.stringify(body),
    });
    const raw = await r.text();
    return { status: r.status, body: JSON.parse(raw), raw };
  };
  const withLoginPasswords = (): void => { for (const u of db.users) u.passwordHash = LOGIN_HASH; };
  const brandOnly = (raw: string, where: string): void => {
    const data = JSON.parse(raw).data;
    assert.deepEqual(Object.keys(data).sort(), ["brand", "token", "user"], `${where} 登录响应多了/少了顶层字段：${Object.keys(data)}`);
    if (data.brand !== null) assert.deepEqual(Object.keys(data.brand).sort(), ["loginPath", "logoUrl", "name"], `${where} 品牌字段不对`);
    // token 是随机串，可能碰巧含「500」这种数字，只核品牌和 user 两块
    noSecrets(JSON.stringify({ data: { brand: data.brand, user: { id: data.user.id, name: data.user.name, role: data.user.role } } }), where);
  };

  await check("19) 登录成功回品牌：代理的客户 / 代理本人 → 代理的三个字段；湘泰客户、员工、管理员 → null", async () => {
    resetFixtures();
    withLoginPasswords();
    const a = await postLogin({ account: "zz_b4_client_a", password: LOGIN_PWD });
    assert.equal(a.status, 200, a.raw);
    assert.deepEqual(a.body.data.brand, { name: "A 代理国际物流", logoUrl: "/images/zz_b4_logo_abc123.png", loginPath: "/zz-b4-a" });
    brandOnly(a.raw, "代理的客户登录");
    const b = await postLogin({ account: "zz_b4_client_b", password: LOGIN_PWD });
    assert.deepEqual(b.body.data.brand, { name: "<B>代理", logoUrl: null, loginPath: null }, "没前缀 loginPath null、外链 logo 不给");
    const ag = await postLogin({ account: "zz_b4_agent_login", password: LOGIN_PWD });
    assert.deepEqual(ag.body.data.brand, { name: "A 代理国际物流", logoUrl: "/images/zz_b4_logo_abc123.png", loginPath: "/zz-b4-a" });
    brandOnly(ag.raw, "代理本人登录");
    for (const id of ["zz_b4_client_xt", "zz_b4_staff", "zz_b4_admin"]) {
      const r = await postLogin({ account: id, password: LOGIN_PWD });
      assert.equal(r.status, 200, `${id} ${r.raw}`);
      assert.equal(r.body.data.brand, null, `${id} 必须是湘泰的`);
      brandOnly(r.raw, `${id} 登录`);
    }
    resetFixtures();
  });

  await check("20) 登录回品牌只看这个账号：员工 / 管理员行上就算挂了 agentId 也 null；别家公司的代理、代理行没了 → null", async () => {
    resetFixtures();
    withLoginPasswords();
    db.users.find((u) => u.id === "zz_b4_staff")!.agentId = "zz_b4_agentA";
    db.users.find((u) => u.id === "zz_b4_admin")!.agentId = "zz_b4_agentA";
    const before = agentCalls;
    for (const id of ["zz_b4_staff", "zz_b4_admin"]) {
      assert.equal((await postLogin({ account: id, password: LOGIN_PWD })).body.data.brand, null, id);
    }
    assert.equal(agentCalls, before, "员工 / 管理员登录不许去查代理表");
    assert.equal((await postLogin({ account: "zz_b4_client_cross", password: LOGIN_PWD })).body.data.brand, null);
    assert.equal((await postLogin({ account: "zz_b4_agent_ghost", password: LOGIN_PWD })).body.data.brand, null);
    resetFixtures();
  });

  await check("21) 登录失败的响应不带任何品牌（防拿错密码探账号归属）：密码错 / 角色不对 / 账号不存在三种回包一模一样", async () => {
    resetFixtures();
    withLoginPasswords();
    const before = agentCalls;
    const wrongPwd = await postLogin({ account: "zz_b4_client_a", password: "zz_wrong" });
    const wrongRole = await postLogin({ account: "zz_b4_client_a", password: LOGIN_PWD, role: "staff" });
    const noUser = await postLogin({ account: "zz_b4_nobody", password: LOGIN_PWD });
    for (const [name, r] of [["密码错", wrongPwd], ["角色不对", wrongRole], ["账号不存在", noUser]] as const) {
      assert.equal(r.status, 401, `${name} ${r.raw}`);
      assert.ok(!/brand|A 代理|zz-b4-a|logo/i.test(r.raw), `${name} 的失败响应里有品牌信息：${r.raw}`);
    }
    // 每个响应自带的请求号、时间戳本来就不同，去掉再比
    const strip = (r: { body: any }) => { const { requestId: _r, timestamp: _t, ...rest } = r.body; return rest; };
    assert.deepEqual(strip(wrongPwd), strip(noUser), "密码错和账号不存在的回包不一样 —— 能拿来探账号");
    assert.deepEqual(strip(wrongRole), strip(noUser));
    assert.equal(agentCalls, before, "登录失败不许去查代理表");
    resetFixtures();
  });

  await check("22) 登录时查品牌出错：登录照常成功，只是不回 brand 字段（前端当不知道）", async () => {
    resetFixtures();
    withLoginPasswords();
    agentFindFirstThrows = true;
    try {
      const r = await postLogin({ account: "zz_b4_client_a", password: LOGIN_PWD });
      assert.equal(r.status, 200, r.raw);
      assert.ok(r.body.data.token, "没发令牌");
      assert.ok(!Object.prototype.hasOwnProperty.call(r.body.data, "brand"), `查品牌出错还回了 brand：${r.raw}`);
    } finally {
      agentFindFirstThrows = false;
      resetFixtures();
    }
  });

  await check("23) 前端 readLoginBrand：只认登录接口说的；管理员 / 员工永远湘泰；没字段或格式不对当不知道；代理本人回 null 当不知道", () => {
    const A = { name: "A 代理", logoUrl: "/images/a.png", loginPath: "/zz-b4-a" };
    assert.deepEqual(web.readLoginBrand({ user: { role: "client" }, brand: A }), { known: true, brand: A });
    assert.deepEqual(web.readLoginBrand({ user: { role: "agent" }, brand: A }), { known: true, brand: A });
    assert.deepEqual(web.readLoginBrand({ user: { role: "client" }, brand: null }), { known: true, brand: null });
    assert.deepEqual(web.readLoginBrand({ user: { role: "agent" }, brand: null }), { known: false }, "代理本人没品牌是脏数据，别写成湘泰");
    for (const role of ["admin", "staff"]) {
      assert.deepEqual(web.readLoginBrand({ user: { role }, brand: A }), { known: true, brand: null }, `${role} 回了品牌也当湘泰`);
    }
    assert.deepEqual(web.readLoginBrand({ user: { role: "client" } }), { known: false }, "没 brand 字段 = 服务端查品牌出错");
    assert.deepEqual(web.readLoginBrand({ user: { role: "client" }, brand: { name: "" } }), { known: false });
    assert.deepEqual(web.readLoginBrand({ user: { role: "client" }, brand: "A 代理" }), { known: false });
    assert.deepEqual(web.readLoginBrand(null), { known: false });
    assert.deepEqual(
      web.readLoginBrand({ user: { role: "client" }, brand: { name: "A", logoUrl: "https://evil.example.net/x.png", loginPath: "//evil.com" } }),
      { known: true, brand: { name: "A", logoUrl: null, loginPath: null } },
      "logo / 前缀照样过 parseSessionBrand",
    );
  });

  await check("24) 登录页只按登录接口写品牌缓存，不再按「是哪张登录页」猜；退出登录清品牌缓存但不动 xt_brand_login cookie（源码检查）", () => {
    const view = fs.readFileSync(path.join(process.cwd(), "apps/web/src/modules/branding/LoginView.tsx"), "utf-8");
    const primeAt = view.indexOf("primeBrandAfterLogin(result)");
    assert.ok(primeAt > 0, "登录页没把整份登录响应交给 primeBrandAfterLogin");
    assert.ok(primeAt < view.indexOf("setAuthSession({"), "品牌缓存必须在写会话之前写");
    assert.ok(primeAt < view.indexOf("window.location.href"), "品牌缓存必须在跳转之前写");
    const hook = fs.readFileSync(path.join(process.cwd(), "apps/web/src/modules/branding/useWorkbenchBrand.ts"), "utf-8");
    const prime = hook.slice(hook.indexOf("export function primeBrandAfterLogin"), hook.indexOf("/** 这个登录身份的品牌"));
    assert.ok(prime.includes("readLoginBrand(result)"), "primeBrandAfterLogin 没走 readLoginBrand");
    const session = fs.readFileSync(path.join(process.cwd(), "apps/web/src/auth/auth-session.ts"), "utf-8");
    const clear = session.slice(session.indexOf("export function clearAuthSession"), session.indexOf("export function prepareLoginPage"));
    assert.ok(clear.includes("safeRemoveItem(WORKBENCH_BRAND_CACHE_KEY)"), "退出登录没清品牌缓存");
    assert.ok(!/xt_brand_login|BRAND_LOGIN_COOKIE|document\.cookie/.test(clear.replace(/\/\*[\s\S]*?\*\//g, "")), "退出登录不许动 xt_brand_login cookie（B4 靠它把代理的客户送回代理登录页）");
  });

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
  process.exit(1);
});
