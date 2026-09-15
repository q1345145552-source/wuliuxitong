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

  await check("13b) 藏掉的菜单对应的页面自己也按品牌挡：代理的客户直接输网址 / 旧书签进来被送回主页；每次进门现查（不认缓存）、没查到不挂业务页、查失败给「重试」（Codex 审查 P2-3、第二轮 P2-1 / P2-2，源码检查；页面真跑见 .audit/2026-09-15/r2-fix/ui-brand-gate.cjs）", () => {
    const clientItems = roleFunctionGroups.client.flatMap((g) => g.items);
    for (const id of web.AGENT_CLIENT_HIDDEN_MENU_IDS) {
      const href = clientItems.find((i) => i.id === id)!.href;
      assert.ok(/^\/client\/[a-z-]+$/.test(href), `${id} 的地址 ${href} 不是独立页面，这条检查要跟着改`);
      const file = path.join(__dirname, "..", "apps", "web", "src", "app", ...href.slice(1).split("/"), "page.tsx");
      const src = fs.readFileSync(file, "utf8");
      const entry = src.slice(src.indexOf("export default function"));
      const head = entry.slice(0, entry.indexOf("\n}\n"));
      assert.ok(head.includes("useVerifiedSessionBrand()"), `${href} 默认导出没有进门现查品牌`);
      assert.ok(!head.includes("useCurrentSessionBrand"), `${href} 进门判断不许用浏览器里记的品牌（在线改归属后会按旧的放行 / 拦截）`);
      assert.ok(head.includes('router.replace("/client")'), `${href} 认出代理的客户没送回主页`);
      assert.ok(head.includes('state.status === "error"') && head.includes("onClick={retry}") && head.includes("重试"), `${href} 查品牌失败要写明原因、给「重试」`);
      assert.ok(
        /if \(state\.status !== "done" \|\| state\.brand\) \{[\s\S]*?\}\s*return <\w+Content \/>;/.test(head),
        `${href} 还没查到、或查到是代理的客户时，不许挂业务页`,
      );
    }
  });

  await check("13c) 现查品牌 fetchSessionBrand：每次都自己真发请求、不复用改归属之前发出的旧请求；先发后到的旧结果不许盖掉新结果；回包格式不对当查不到；服务器出错原样抛出且缓存不动、之后能重查；查的时候换了账号不记到新账号头上（Codex 第二轮 P2-1 / P2-2、第三轮 P2-2 残留 / P3-1）", async () => {
    const g = globalThis as any;
    const saved = { window: g.window, document: g.document, fetch: g.fetch };
    const store = new Map<string, string>();
    const USER = "zz_b4_verify_u1";
    /** 服务端此刻会回的 data（请求发出那一刻定下来，模拟「发出之后才改归属」） */
    let serverData: unknown = { brand: null };
    let serverStatus = 200;
    let calls = 0;
    let hold: Promise<void> | null = null;
    g.window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
      location: { protocol: "http:", pathname: "/client/consolidation", href: "http://127.0.0.1/client/consolidation" },
    };
    g.document = { cookie: "" };
    g.fetch = async (url: unknown) => {
      calls += 1;
      assert.ok(String(url).endsWith("/client/brand"), `查错了接口 ${String(url)}`);
      const data = serverData;
      const status = serverStatus;
      const wait = hold;
      if (wait) await wait;
      if (status >= 500) return new Response("boom", { status });
      return new Response(JSON.stringify({ code: "OK", data }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const session = await import("../apps/web/src/auth/auth-session");
      const hook = await import("../apps/web/src/modules/branding/useWorkbenchBrand");
      store.set(session.AUTH_SESSION_STORAGE_KEY, JSON.stringify({ userId: USER, companyId: "c_001", role: "client", token: "zz_t1" }));
      const cachedBrand = () => JSON.parse(store.get(session.WORKBENCH_BRAND_CACHE_KEY) ?? "null");
      const AGENT_A = { name: "A 代理国际物流", logoUrl: null, loginPath: "/zz-b4-a" };
      const AGENT_B = { name: "B 代理", logoUrl: null, loginPath: null };

      assert.equal(await hook.fetchSessionBrand(USER, "client"), null);
      assert.equal(calls, 1);
      assert.equal(cachedBrand()?.brand, null);

      serverData = { brand: AGENT_A };
      const reassigned = await hook.fetchSessionBrand(USER, "client");
      assert.equal(calls, 2, "上一次查到湘泰也要再真发一次请求（在线改归代理）");
      assert.equal(reassigned?.name, "A 代理国际物流");
      assert.equal(cachedBrand()?.userId, USER);
      assert.equal(cachedBrand()?.brand?.name, "A 代理国际物流");

      // 旧请求 old 发出时是湘泰、还没回来 → 改归 B 代理 → 新请求 fresh 发出并先回来 → old 才回来
      let release!: () => void;
      hold = new Promise<void>((resolve) => { release = resolve; });
      serverData = { brand: null };
      const old = hook.fetchSessionBrand(USER, "client");
      hold = null;
      serverData = { brand: AGENT_B };
      const fresh = hook.fetchSessionBrand(USER, "client");
      assert.notEqual(old, fresh, "改归属之后再查要自己发请求，不许复用之前发出去的");
      assert.equal(calls, 4);
      assert.equal((await fresh)?.name, "B 代理");
      assert.equal(cachedBrand()?.brand?.name, "B 代理");
      release();
      assert.equal(await old, null, "旧请求照实回它自己查到的");
      assert.equal(cachedBrand()?.brand?.name, "B 代理", "先发后到的旧结果不许盖掉新结果");

      const cacheBeforeMalformed = store.get(session.WORKBENCH_BRAND_CACHE_KEY);
      for (const bad of [{}, { brand: { name: "", logoUrl: null, loginPath: null } }, { brand: "代理" }]) {
        serverData = bad;
        await assert.rejects(hook.fetchSessionBrand(USER, "client"), /账号信息/, `回包 ${JSON.stringify(bad)} 要当查不到`);
      }
      assert.equal(store.get(session.WORKBENCH_BRAND_CACHE_KEY), cacheBeforeMalformed, "回包格式不对不许改缓存");

      const cacheBeforeError = store.get(session.WORKBENCH_BRAND_CACHE_KEY);
      serverStatus = 502;
      await assert.rejects(hook.fetchSessionBrand(USER, "client"), /服务器繁忙/);
      assert.equal(store.get(session.WORKBENCH_BRAND_CACHE_KEY), cacheBeforeError, "出错不许改缓存");
      serverStatus = 200;
      serverData = { brand: null };
      const callsBeforeRetry = calls;
      assert.equal(await hook.fetchSessionBrand(USER, "client"), null, "出错之后点重试要能重查");
      assert.equal(calls, callsBeforeRetry + 1);

      hold = new Promise<void>((resolve) => { release = resolve; });
      const p3 = hook.fetchSessionBrand(USER, "client");
      store.set(session.AUTH_SESSION_STORAGE_KEY, JSON.stringify({ userId: "zz_b4_verify_u2", companyId: "c_001", role: "client", token: "zz_t2" }));
      const cacheBeforeSwitch = store.get(session.WORKBENCH_BRAND_CACHE_KEY);
      release();
      hold = null;
      await assert.rejects(p3, /账号已经换了/);
      assert.equal(store.get(session.WORKBENCH_BRAND_CACHE_KEY), cacheBeforeSwitch, "换了账号不许把上一个账号的品牌写进缓存");
    } finally {
      g.window = saved.window;
      g.document = saved.document;
      g.fetch = saved.fetch;
    }
  });

  await check("13d) 外壳每换一页（含同一页只换 #）、切回这个标签页都再查一次品牌；外壳卸载就停掉补查；受限页挂着时跟着外壳查到的更新结果变；不按账号共用在途请求（Codex 第三轮 P2-2 残留、第四轮 P2-2 残留 / P3-1；源码检查，页面真跑见 .audit/2026-09-15/r4-fix/ui-brand-r4fix.cjs）", () => {
    const shell = fs.readFileSync(path.join(process.cwd(), "apps/web/src/modules/layout/RoleShell.tsx"), "utf-8");
    assert.match(shell, /useWorkbenchBrand\(session, currentPath \+ currentHash\)/, "外壳要把当前地址（含 #）交给品牌钩子：客户端很多菜单只换 #");
    const hook = fs.readFileSync(path.join(process.cwd(), "apps/web/src/modules/branding/useWorkbenchBrand.ts"), "utf-8");
    const shellHook = hook.slice(hook.indexOf("export function useWorkbenchBrand("));
    assert.match(shellHook, /createBrandRevalidator\(userId, role\)/, "外壳补查要走 createBrandRevalidator（13e 测的就是它）");
    assert.ok(shellHook.includes('addEventListener("focus"') && shellHook.includes('"visibilitychange"'), "切回标签页（focus / visibilitychange）要再查品牌");
    assert.match(shellHook, /\.dispose\(\)/, "外壳卸载 / 换身份时要停掉补查");
    assert.match(shellHook, /\[locationKey\]/, "换一页（含只换 #）要再查品牌");
    assert.match(
      shellHook,
      /window\.location\.pathname \+ window\.location\.hash/,
      "换页再查要按浏览器真实地址去重：Next 换路径那一帧外壳记的 # 还是上一页的，按拼出来的地址去重会一次换页查两次（Codex 第五轮 P3-2）",
    );
    assert.ok(!/\binflight\b/.test(hook), "不许按账号共用在途请求（会复用改归属之前发出的旧请求）");
    const gate = hook.slice(hook.indexOf("export function useVerifiedSessionBrand("), hook.indexOf("export function useWorkbenchBrand("));
    assert.match(gate, /subscribeAppliedBrand\(/, "受限页挂着时要听外壳查到的更新结果（被改归代理就退出这一页）");
    assert.match(gate, /shouldAdoptAppliedBrand\(/, "受限页跟不跟更新结果要走 shouldAdoptAppliedBrand（13f 测的就是它）");
  });

  await check("13e) 外壳补查调度 createBrandRevalidator：同一时刻只一个请求、在路上时触发 100 次也只补查 1 次、补完不循环；dispose 之后触发不发请求，旧请求回来不补查、不压掉新外壳查到的结果（Codex 第四轮 P3-1）", async () => {
    const g = globalThis as any;
    const saved = { window: g.window, document: g.document, fetch: g.fetch };
    const store = new Map<string, string>();
    const USER = "zz_b4_revalidator_u1";
    const AGENT_A = { name: "A 代理国际物流", logoUrl: null, loginPath: "/zz-b4-a" };
    const AGENT_B = { name: "B 代理", logoUrl: null, loginPath: null };
    let calls = 0;
    /** 第 n 次请求怎么回：held = 悬着等 releases[n] 放行；fail = 502；没写的回代理 A */
    let plan: Record<number, { brand?: unknown; held?: boolean; fail?: boolean }> = {};
    const releases: Record<number, () => void> = {};
    g.window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
      location: { protocol: "http:", pathname: "/client", href: "http://127.0.0.1/client" },
    };
    g.document = { cookie: "" };
    g.fetch = async () => {
      calls += 1;
      const n = calls;
      const p = plan[n] ?? { brand: AGENT_A };
      if (p.held) await new Promise<void>((resolve) => { releases[n] = resolve; });
      if (p.fail) return new Response("boom", { status: 502 });
      return new Response(JSON.stringify({ code: "OK", data: { brand: p.brand ?? null } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 30));
    try {
      const session = await import("../apps/web/src/auth/auth-session");
      const hook = await import("../apps/web/src/modules/branding/useWorkbenchBrand");
      store.set(session.AUTH_SESSION_STORAGE_KEY, JSON.stringify({ userId: USER, companyId: "c_001", role: "client", token: "zz_t9" }));
      const cachedBrand = () => JSON.parse(store.get(session.WORKBENCH_BRAND_CACHE_KEY) ?? "null");

      plan = { 1: { brand: null, held: true } };
      const burst = hook.createBrandRevalidator(USER, "client");
      burst.trigger();
      for (let i = 0; i < 100; i += 1) burst.trigger();
      assert.equal(calls, 1, "上一次还在路上，不许并发");
      releases[1]!();
      await settle();
      assert.equal(calls, 2, "回来之后只补查一次");
      await settle();
      assert.equal(calls, 2, "补查完不许自己循环");
      assert.equal(cachedBrand()?.brand?.name, "A 代理国际物流");
      burst.dispose();
      burst.trigger();
      await settle();
      assert.equal(calls, 2, "dispose 之后再触发不许发请求");

      // 旧外壳：请求悬着（湘泰）→ 又触发（记补查）→ 外壳卸载 → 新外壳发请求（B 代理，悬着）→ 旧请求回来 → 新请求回来
      const base = calls;
      plan = { [base + 1]: { brand: null, held: true }, [base + 2]: { brand: AGENT_B, held: true }, [base + 3]: { fail: true } };
      const oldShell = hook.createBrandRevalidator(USER, "client");
      oldShell.trigger();
      oldShell.trigger();
      assert.equal(calls, base + 1);
      oldShell.dispose();
      const newShell = hook.createBrandRevalidator(USER, "client");
      newShell.trigger();
      assert.equal(calls, base + 2);
      releases[base + 1]!();
      await settle();
      assert.equal(calls, base + 2, "旧外壳卸载了，它的请求回来后不许再补查");
      releases[base + 2]!();
      await settle();
      assert.equal(cachedBrand()?.brand?.name, "B 代理", "新外壳查到的结果要直接生效，不许被旧外壳的补查压掉");
      newShell.dispose();
    } finally {
      g.window = saved.window;
      g.document = saved.document;
      g.fetch = saved.fetch;
    }
  });

  await check("13f) 受限页挂着时只认「比我进门那次更新」的结果，而且只跟收紧（湘泰 → 代理）、不跟放开：更新的请求查到代理才跟着退出，更早发出的、归属一样的、已经判成代理后又说湘泰的都不变；每次最新结果写入都通知受限页（归属没变也通知），取消订阅后不再通知（Codex 第四轮 P2-2：已打开的普通版集货页被改归代理后不退出）", async () => {
    const g = globalThis as any;
    const saved = { window: g.window, document: g.document, fetch: g.fetch };
    const store = new Map<string, string>();
    const USER = "zz_b4_applied_u1";
    const AGENT = { name: "A 代理国际物流", logoUrl: null, loginPath: "/zz-b4-a" };
    let serverData: unknown = { brand: null };
    g.window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
      location: { protocol: "http:", pathname: "/client/consolidation", href: "http://127.0.0.1/client/consolidation" },
    };
    g.document = { cookie: "" };
    g.fetch = async () => {
      const data = serverData;
      return new Response(JSON.stringify({ code: "OK", data }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const session = await import("../apps/web/src/auth/auth-session");
      const hook = await import("../apps/web/src/modules/branding/useWorkbenchBrand");
      store.set(session.AUTH_SESSION_STORAGE_KEY, JSON.stringify({ userId: USER, companyId: "c_001", role: "client", token: "zz_t10" }));
      let notified = 0;
      const off = hook.subscribeAppliedBrand(() => { notified += 1; });

      const entry = hook.startSessionBrandRequest(USER, "client");
      assert.equal(await entry.promise, null);
      const gate = { seq: entry.seq, brand: null };
      assert.deepEqual(hook.readAppliedSessionBrand(USER), { seq: entry.seq, brand: null });
      assert.equal(hook.shouldAdoptAppliedBrand(gate, hook.readAppliedSessionBrand(USER)), false, "就是我进门那次自己的结果");
      assert.equal(notified, 1);

      await hook.fetchSessionBrand(USER, "client");
      assert.equal(notified, 2, "最新结果写入，归属没变也要通知受限页");
      assert.equal(hook.shouldAdoptAppliedBrand(gate, hook.readAppliedSessionBrand(USER)), false, "归属没变不跟");

      serverData = { brand: AGENT };
      await hook.fetchSessionBrand(USER, "client");
      const applied = hook.readAppliedSessionBrand(USER)!;
      assert.ok(applied.seq > entry.seq);
      assert.equal(applied.brand?.name, "A 代理国际物流");
      assert.equal(hook.shouldAdoptAppliedBrand(gate, applied), true, "更新的请求查到改归代理，受限页要跟着变");
      assert.equal(hook.shouldAdoptAppliedBrand({ seq: applied.seq + 1, brand: null }, applied), false, "比我进门那次更早发出的结果不跟");
      assert.equal(hook.shouldAdoptAppliedBrand(gate, null), false);
      const deniedGate = { seq: entry.seq, brand: applied.brand };
      assert.equal(
        hook.shouldAdoptAppliedBrand(deniedGate, { seq: applied.seq + 5, brand: null }),
        false,
        "已经判成代理的客户（正在送回主页），更新的结果说是湘泰也不许把业务页再挂出来：只跟收紧、不跟放开（Codex 第五轮 P3-1）",
      );
      assert.equal(
        hook.shouldAdoptAppliedBrand(deniedGate, { seq: applied.seq + 5, brand: { name: "B 代理", logoUrl: null, loginPath: null } }),
        false,
        "从一个代理换到另一个代理：本来就不让进，不用跟",
      );

      off();
      const before = notified;
      serverData = { brand: null };
      await hook.fetchSessionBrand(USER, "client");
      assert.equal(notified, before, "取消订阅后不再通知");
    } finally {
      g.window = saved.window;
      g.document = saved.document;
      g.fetch = saved.fetch;
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

  await check("15b) 前缀代理的客户（没专属域名）打开 /register 不许看到湘泰和湘泰客服微信：cookie 前缀真存在才转代理登录页，/login /register 共用一条规则（第 5 轮）", async () => {
    // ① 纯规则：格式不对不查、查不到不转、大写规范化
    const looked: string[] = [];
    const brandA = { name: "A 代理", logoUrl: null };
    const lookup = async (slug: string) => { looked.push(slug); return slug === "zz-b4-a" ? brandA : null; };
    assert.deepEqual(await web.resolveBrandLoginCookie("zz-b4-a", lookup), { slug: "zz-b4-a", brand: brandA });
    assert.deepEqual(await web.resolveBrandLoginCookie(" ZZ-B4-A ", lookup), { slug: "zz-b4-a", brand: brandA });
    assert.equal(await web.resolveBrandLoginCookie("zz-b4-nobody", lookup), null, "前缀不存在不许转（转过去是 404）");
    looked.length = 0;
    for (const bad of ["//evil.com", "/evil", "https://evil.com", "%2F%2Fevil.com", "", null, undefined, "a"]) {
      assert.equal(await web.resolveBrandLoginCookie(bad as any, lookup), null, String(bad));
    }
    assert.deepEqual(looked, [], "格式不对的 cookie 不许拿去查接口");

    // ② 源码：两页都是「先按 Host，认不出再按 cookie」，页面和 generateMetadata 都要有
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const register = strip(fs.readFileSync(path.join(process.cwd(), "apps/web/src/app/register/page.tsx"), "utf-8"));
    const login = strip(fs.readFileSync(path.join(process.cwd(), "apps/web/src/app/login/page.tsx"), "utf-8"));
    for (const [name, src, pageFn, xiangtaiMarker] of [
      ["register", register, "export default async function RegisterPage", '{ label: "微信", value: CONTACT.wechat }'],
      ["login", login, "export default async function LoginPage", "<LoginView brand={null} />"],
    ] as const) {
      const meta = src.slice(src.indexOf("export async function generateMetadata"), src.indexOf(pageFn));
      assert.match(meta, /getBrandByRequestHost\(\)\)\s*\?\?\s*\(await getBrandByLoginCookie\(\)\)/, `${name} 的标签页标题没按 cookie 认前缀代理`);
      const body = src.slice(src.indexOf(pageFn));
      const hostAt = body.indexOf("getBrandByRequestHost()");
      const cookieAt = body.indexOf("getBrandByLoginCookie()");
      const redirectAt = body.indexOf("redirect(target)");
      assert.ok(hostAt > 0 && cookieAt > hostAt && redirectAt > cookieAt, `${name} 页没有「Host 认不出 → cookie 前缀 → 转代理登录页」`);
      const xiangtaiAt = body.indexOf(xiangtaiMarker);
      assert.ok(xiangtaiAt > redirectAt, `${name} 页必须在拼湘泰版内容之前转走`);
      assert.ok(!/readBrandLoginCookie|normalizeBrandSlug\(/.test(src), `${name} 页别自己读 cookie / 自己规范化，统一走 getBrandByLoginCookie`);
    }
    assert.match(register, /brandLoginRedirectPath\(cookieBrand\.slug, ""\)/, "register 转去的地址必须走 brandLoginRedirectPath");

    // ③ 同类扫描：app/ 下凡是按 Host 认品牌的页面，都必须同时认前缀 cookie（专门的前缀登录页 [agentSlug] 除外，它按地址认）
    const appDir = path.join(process.cwd(), "apps/web/src/app");
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : /\.(tsx?|jsx?)$/.test(e.name) ? [p] : [];
    });
    const hostOnly = walk(appDir).filter((f) => {
      const src = strip(fs.readFileSync(f, "utf-8"));
      return src.includes("getBrandByRequestHost(") && !src.includes("getBrandByLoginCookie(");
    });
    assert.deepEqual(hostOnly.map((f) => path.relative(appDir, f)), [], "这些页面只按 Host 认品牌，漏了只设前缀的代理");
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

  /* ── 9. 整页打开 / 刷新工作台：<head> 内联脚本让标签页标题图标第一帧就是代理的（第 1 轮后加固） ── */
  const early = await import("../apps/web/src/modules/branding/early-tab-brand");
  const docBrand = await import("../apps/web/src/modules/branding/document-brand");
  const { AUTH_SESSION_STORAGE_KEY, WORKBENCH_BRAND_CACHE_KEY } = await import("../apps/web/src/auth/auth-session");
  // 拿「浏览器实际执行的那串字节」编译出判定函数来测，不另写一份
  const decide = new Function(`return (${early.EARLY_TAB_BRAND_DECIDE_SOURCE});`)() as (p: unknown, s: unknown, c: unknown) => { title: string; iconHref: string | null } | null;
  const sess = (role: string, userId = "zz_u1", extra: Row = {}): string => JSON.stringify({ userId, companyId: "c_001", role, token: "t", ...extra });
  const BRAND_LOGO = { name: " A 代理国际物流 ", logoUrl: "/images/zz_fxt_logo.png", loginPath: "/zz-a" };
  const BRAND_NOLOGO = { name: "<B>代理", logoUrl: null, loginPath: null };
  const rec = (userId: string, brand: any): string => JSON.stringify(web.buildBrandCacheRecord(userId, brand === null ? null : web.parseSessionBrand(brand)));

  await check("25) 首帧判定（内联脚本那串源码）：只有「工作台路径 + 有效的客户/代理会话 + 同账号缓存 + 品牌有名字」才动；图标地址用缓存里算好的", () => {
    for (const p of ["/client", "/client/", "/client/whr-consolidation", "/agent"]) {
      assert.deepEqual(decide(p, sess("client"), rec("zz_u1", BRAND_LOGO)), { title: "A 代理国际物流", iconHref: "/images/zz_fxt_logo.png" }, p);
    }
    assert.deepEqual(decide("/agent", sess("agent"), rec("zz_u1", BRAND_NOLOGO)), { title: "<B>代理", iconHref: web.letterIconDataUri("<B>代理") });
    for (const p of ["/clientx", "/agents", "/login", "/", "/zz-a", "/admin", "/staff/container-loading", "/register", "", null, 1]) {
      assert.equal(decide(p, sess("client"), rec("zz_u1", BRAND_LOGO)), null, `路径 ${String(p)} 不许动`);
    }
    assert.equal(decide("/client", sess("client"), rec("zz_u1", null)), null, "湘泰客户（缓存 brand: null）不许动");
    assert.equal(decide("/client", sess("client"), rec("zz_u2", BRAND_LOGO)), null, "别的账号的缓存不许认");
    for (const role of ["admin", "staff", "", "boss"]) assert.equal(decide("/client", sess(role), rec("zz_u1", BRAND_LOGO)), null, `角色 ${role} 不许动`);
    for (const drop of ["token", "companyId", "userId"]) {
      assert.equal(decide("/client", sess("client", "zz_u1", { [drop]: "" }), rec("zz_u1", BRAND_LOGO)), null, `会话缺 ${drop} 当没登录`);
    }
    for (const bad of [null, "", "{", "null", "[]", "42"]) {
      assert.equal(decide("/client", bad, rec("zz_u1", BRAND_LOGO)), null, `会话 ${String(bad)}`);
      assert.equal(decide("/client", sess("client"), bad), null, `缓存 ${String(bad)}`);
    }
    // 旧格式缓存（没 iconHref）：只改标题
    assert.deepEqual(decide("/client", sess("client"), JSON.stringify({ userId: "zz_u1", brand: BRAND_LOGO })), { title: "A 代理国际物流", iconHref: null });
    // 图标地址跟 brandIconHref 的选法对不上（被改过）：不用，只改标题
    const tampered = (brand: Row, iconHref: unknown) => decide("/client", sess("client"), JSON.stringify({ userId: "zz_u1", brand, iconHref }))?.iconHref;
    assert.equal(tampered(BRAND_LOGO, "javascript:alert(1)"), null);
    assert.equal(tampered(BRAND_LOGO, "/images/other.png"), null, "有 logo 时只认 logo 本身");
    assert.equal(tampered(BRAND_LOGO, web.letterIconDataUri("A")), null, "有 logo 时不认首字图标");
    assert.equal(tampered(BRAND_NOLOGO, "/images/zz_fxt_logo.png"), null, "没 logo 时只认首字图标");
    assert.equal(tampered({ ...BRAND_LOGO, logoUrl: "https://evil.example.net/x.png" }, "https://evil.example.net/x.png"), null, "不合规 logo 不认");
    assert.equal(tampered(BRAND_NOLOGO, 42), null);
  });

  await check("26) 首帧判定和 React 那边（getOptionalSession + readCache/parseSessionBrand + peek 只认客户/代理）口径一致：整张组合表逐格比", () => {
    const sessions: unknown[] = [sess("client"), sess("agent"), sess("admin"), sess("staff"), sess("client", "zz_u2"), sess("client", "zz_u1", { token: "" }), "{", "null", null];
    const brands: unknown[] = [BRAND_LOGO, BRAND_NOLOGO, null, { name: "  " }, { name: 42 }, "A 代理", { name: "X", logoUrl: "javascript:1" }, { name: "Y", logoUrl: "/images/../x" }];
    const caches: unknown[] = [null, "garbage", "{}"];
    for (const b of brands) {
      caches.push(JSON.stringify({ userId: "zz_u1", brand: b }));
      const parsed = b === null ? null : web.parseSessionBrand(b);
      caches.push(JSON.stringify({ userId: "zz_u1", brand: b, iconHref: parsed ? web.brandIconHref(parsed) : null }));
    }
    caches.push(rec("zz_u2", BRAND_LOGO));
    const refSession = (raw: unknown): Row | null => {
      if (typeof raw !== "string") return null;
      try {
        const s = JSON.parse(raw);
        return s?.role && s.userId && s.companyId && s.token ? s : null;
      } catch { return null; }
    };
    let cells = 0;
    for (const p of ["/client/wallet", "/agent", "/login", "/clientx"]) {
      for (const s of sessions) {
        for (const c of caches) {
          cells += 1;
          const got = decide(p, s, c);
          const session = refSession(s);
          let expected: { title: string; iconHref: string | null } | null = null;
          if (/^\/(client|agent)(\/|$)/.test(p) && session && (session.role === "client" || session.role === "agent") && typeof c === "string") {
            let parsed: Row | null = null;
            try { parsed = JSON.parse(c); } catch { parsed = null; }
            const brand = parsed && parsed.userId === session.userId && parsed.brand !== null ? web.parseSessionBrand(parsed.brand) : null;
            if (brand) expected = { title: brand.name, iconHref: parsed!.iconHref === web.brandIconHref(brand) ? web.brandIconHref(brand) : null };
          }
          // 缓存里是 brand 对象但 iconHref 是按「没过 parseSessionBrand 的原 logo」算的这种人为组合，不在比对范围：只比「动不动」和标题
          assert.equal(got === null, expected === null, `动不动不一致：${p} ${String(s)} ${String(c)}`);
          if (got && expected) {
            assert.equal(got.title, expected.title, `标题不一致：${String(c)}`);
            if (got.iconHref !== null) assert.equal(got.iconHref, expected.iconHref, `图标不一致：${String(c)}`);
          }
        }
      }
    }
    assert.ok(cells > 300, `组合太少：${cells}`);
    // 写缓存的地方算好的图标地址，内联脚本原样拿到
    for (const b of [BRAND_LOGO, BRAND_NOLOGO]) {
      const parsed = web.parseSessionBrand(b)!;
      assert.equal(decide("/client", sess("client"), rec("zz_u1", b))?.iconHref, web.brandIconHref(parsed));
    }
    assert.deepEqual(web.buildBrandCacheRecord("zz_u1", null), { userId: "zz_u1", brand: null, iconHref: null });
  });

  /* ── 假 DOM：只实现两边用到的那几个接口，MutationObserver 按「一次清空一批」模拟微任务 ── */
  type Mut = { type: string; attributeName?: string };
  class FakeDom {
    observers: FakeMO[] = [];
    head: FakeEl;
    titleCreated = 0;
    constructor() { this.head = new FakeEl(this, "head"); }
    record(m: Mut): void { for (const o of this.observers) if (o.accepts(m)) o.pending = true; }
    flush(): void {
      for (let round = 0; ; round += 1) {
        assert.ok(round < 20, "MutationObserver 来回改停不下来（两边在抢着改）");
        const due = this.observers.filter((o) => o.pending);
        if (!due.length) return;
        for (const o of due) { o.pending = false; o.cb([], o); }
      }
    }
    links(): FakeEl[] { return this.head.children.filter((e) => e.tag === "link"); }
    titles(): FakeEl[] { return this.head.children.filter((e) => e.tag === "title"); }
    document(): Row {
      const dom = this;
      return {
        get head() { return dom.head; },
        get title() { return dom.titles()[0]?.text ?? ""; },
        set title(v: string) {
          const t = dom.titles()[0];
          if (t) t.setText(v);
          else { dom.titleCreated += 1; const el = new FakeEl(dom, "title"); el.text = v; dom.head.append(el); }
        },
        getElementsByTagName: (tag: string) => dom.head.children.filter((e) => e.tag === tag),
        querySelectorAll: (sel: string) => {
          assert.equal(sel, web.TAB_ICON_SELECTOR, "选择器变了，假 DOM 要跟着改");
          return dom.links().filter((l) => {
            const rel = l.getAttribute("rel") ?? "";
            return rel.split(/\s+/).includes("icon") || rel === "apple-touch-icon" || rel === "shortcut icon";
          });
        },
      };
    }
    snapshot(): Row {
      return { title: this.titles().map((t) => t.text), links: this.links().map((l) => Object.fromEntries([...l.attrs.entries()].sort())) };
    }
  }
  class FakeEl {
    attrs = new Map<string, string>();
    children: FakeEl[] = [];
    text = "";
    constructor(public dom: FakeDom, public tag: string, attrs: Record<string, string> = {}) {
      for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v);
    }
    getAttribute(n: string): string | null { return this.attrs.has(n) ? this.attrs.get(n)! : null; }
    hasAttribute(n: string): boolean { return this.attrs.has(n); }
    setAttribute(n: string, v: string): void { this.attrs.set(n, String(v)); this.dom.record({ type: "attributes", attributeName: n }); }
    removeAttribute(n: string): void { this.attrs.delete(n); this.dom.record({ type: "attributes", attributeName: n }); }
    setText(v: string): void { this.text = v; this.dom.record({ type: "childList" }); }
    append(el: FakeEl): void { this.children.push(el); this.dom.record({ type: "childList" }); }
  }
  class FakeMO {
    pending = false;
    opts: Row = {};
    dom: FakeDom | null = null;
    constructor(public cb: (records: unknown[], o: FakeMO) => void) {}
    observe(target: FakeEl, opts: Row): void {
      assert.equal(target.tag, "head", "只许盯 <head>");
      this.dom = target.dom;
      this.opts = opts;
      target.dom.observers.push(this);
    }
    disconnect(): void { if (this.dom) this.dom.observers = this.dom.observers.filter((o) => o !== this); this.pending = false; }
    accepts(m: Mut): boolean {
      if (m.type === "attributes") return !!this.opts.attributes && (!this.opts.attributeFilter || this.opts.attributeFilter.includes(m.attributeName));
      return !!this.opts.childList;
    }
  }
  const parseXiangtaiHead = (dom: FakeDom): void => {
    // 服务器 HTML 里根布局 metadata 出来的那几行（顺序照真实构建产物）
    dom.head.append(new FakeEl(dom, "link", { rel: "stylesheet", href: "/_next/static/chunks/a.css" }));
    const t = new FakeEl(dom, "title");
    dom.head.append(t);
    t.setText("湘泰物流网站");
    dom.head.append(new FakeEl(dom, "link", { rel: "icon", href: "/favicon.ico?favicon.x.ico", sizes: "48x48", type: "image/x-icon" }));
    dom.head.append(new FakeEl(dom, "link", { rel: "icon", href: "/icon.png?icon.y.png", sizes: "256x256", type: "image/png" }));
    dom.head.append(new FakeEl(dom, "link", { rel: "apple-touch-icon", href: "/apple-icon.png?apple-icon.z.png", sizes: "180x180", type: "image/png" }));
  };
  const hydrateXiangtaiHead = (dom: FakeDom): void => {
    // React 水合 metadata：第一个 <title> 的文字写回湘泰；按 href 找不到的图标 link 另插一个湘泰的
    dom.titles()[0]!.setText("湘泰物流网站");
    dom.head.append(new FakeEl(dom, "link", { rel: "icon", href: "/icon.png?icon.y.png", sizes: "256x256", type: "image/png" }));
  };
  const runEarly = (dom: FakeDom, pathname: string, store: Record<string, string | null> | "throws", withMO = true): Row => {
    const win: Row = {
      location: { pathname },
      localStorage: { getItem: (k: string) => { if (store === "throws") throw new Error("SecurityError"); return store[k] ?? null; } },
    };
    new Function("window", "document", "MutationObserver", early.EARLY_TAB_BRAND_SCRIPT)(win, dom.document(), withMO ? FakeMO : undefined);
    return win;
  };
  const withGlobals = <T>(dom: FakeDom, win: Row, body: () => T): T => {
    const g = globalThis as any;
    const saved = { document: g.document, window: g.window, MutationObserver: g.MutationObserver };
    g.document = dom.document(); g.window = win; g.MutationObserver = FakeMO;
    try { return body(); } finally { g.document = saved.document; g.window = saved.window; g.MutationObserver = saved.MutationObserver; }
  };
  const storeFor = (role: string, cacheRaw: string | null): Record<string, string | null> => ({ [AUTH_SESSION_STORAGE_KEY]: sess(role), [WORKBENCH_BRAND_CACHE_KEY]: cacheRaw });
  const H = early.EARLY_TAB_BRAND_HANDLE;
  const ORIG = web.TAB_ICON_ORIGINAL_HREF_ATTR;

  await check("27) 内联脚本：解析 <head> 时标题图标当场换成代理的；React 水合写回湘泰的也当场改回；不造第二个 <title>；非 /images/ 图标去 type", () => {
    for (const b of [BRAND_LOGO, BRAND_NOLOGO]) {
      const parsed = web.parseSessionBrand(b)!;
      const icon = web.brandIconHref(parsed);
      const dom = new FakeDom();
      const win = runEarly(dom, "/client/whr-consolidation", storeFor("client", rec("zz_u1", b)));
      assert.equal(dom.titleCreated, 0, "脚本跑的时候还没有 <title>，不许自己造一个");
      assert.ok(win[H] && typeof win[H].stop === "function", "没挂交接把手");
      parseXiangtaiHead(dom);
      dom.flush();
      assert.equal(dom.document().title, parsed.name);
      assert.equal(dom.titles().length, 1);
      for (const l of dom.links().filter((x) => x.getAttribute("rel") !== "stylesheet")) {
        assert.equal(l.getAttribute("href"), icon);
        assert.ok(l.getAttribute(ORIG)!.startsWith("/"), "没记原地址");
        assert.equal(l.hasAttribute("type"), icon.startsWith("/images/"), "type 去留跟 document-brand 不一致");
      }
      assert.equal(dom.links()[0]!.getAttribute("href"), "/_next/static/chunks/a.css", "样式表 link 不许动");
      assert.equal(win[H].originalTitle, "湘泰物流网站");
      hydrateXiangtaiHead(dom);
      dom.flush();
      assert.equal(dom.document().title, parsed.name, "水合写回湘泰标题后没改回");
      assert.ok(dom.links().filter((x) => x.getAttribute("rel") !== "stylesheet").every((l) => l.getAttribute("href") === icon), "水合插进来的湘泰图标没改");
    }
  });

  await check("28) 交接：React 接管后内联脚本停掉；两边在同一份 <head> 上得到的结果逐个属性一样；接管后结论是湘泰的就按原值还原", () => {
    for (const b of [BRAND_LOGO, BRAND_NOLOGO]) {
      const parsed = web.parseSessionBrand(b)!;
      const info = { name: parsed.name, logoUrl: parsed.logoUrl };
      // A：内联脚本先换 → 水合 → React 按同一个品牌接管
      const domA = new FakeDom();
      const winA = runEarly(domA, "/client", storeFor("client", rec("zz_u1", b)));
      parseXiangtaiHead(domA); domA.flush(); hydrateXiangtaiHead(domA); domA.flush();
      withGlobals(domA, winA, () => docBrand.applyDocumentBrand(info));
      assert.equal(winA[H], undefined, "接管后把手没清");
      assert.equal(domA.observers.length, 1, "接管后应只剩 document-brand 自己的观察者");
      const snapA = domA.snapshot();
      // A 接着：Next 写回湘泰标题 → document-brand 改回；再判成湘泰 → 还原成「湘泰物流网站」（原标题从内联脚本那儿拿，不是代理名字）
      withGlobals(domA, winA, () => { domA.titles()[0]!.setText("湘泰物流网站"); domA.flush(); });
      assert.equal(domA.document().title, parsed.name);
      withGlobals(domA, winA, () => docBrand.applyDocumentBrand(null));
      assert.equal(domA.document().title, "湘泰物流网站", "还原后的标题不对");
      assert.deepEqual(domA.links().filter((x) => x.getAttribute("rel") !== "stylesheet").map((l) => l.getAttribute("href")),
        ["/favicon.ico?favicon.x.ico", "/icon.png?icon.y.png", "/apple-icon.png?apple-icon.z.png", "/icon.png?icon.y.png"]);
      assert.equal(domA.observers.length, 0);
      // B：没有内联脚本（改之前的样子）→ 水合 → React 换。⚠️ document-brand 的观察者是模块级单例，A 收尾（还原）之后才能开 B
      const domB = new FakeDom();
      parseXiangtaiHead(domB); hydrateXiangtaiHead(domB);
      withGlobals(domB, {}, () => docBrand.applyDocumentBrand(info));
      assert.deepEqual(snapA, domB.snapshot(), "内联脚本 + 接管 与 只有 document-brand 的结果不一样（口径不一致）");
      withGlobals(domB, {}, () => docBrand.applyDocumentBrand(null));
    }
  });

  await check("29) 内联脚本换过、React 还没换过就判成湘泰（接口说归属改了）：停掉并还原；水合那一帧会话还没读到不许调 applyDocumentBrand（源码）", () => {
    const dom = new FakeDom();
    const win = runEarly(dom, "/agent", storeFor("agent", rec("zz_u1", BRAND_NOLOGO)));
    parseXiangtaiHead(dom); dom.flush();
    assert.equal(dom.document().title, "<B>代理");
    withGlobals(dom, win, () => docBrand.applyDocumentBrand(null));
    assert.equal(win[H], undefined);
    assert.equal(dom.observers.length, 0);
    assert.equal(dom.document().title, "湘泰物流网站");
    assert.deepEqual(dom.links().slice(1).map((l) => l.getAttribute("href")), ["/favicon.ico?favicon.x.ico", "/icon.png?icon.y.png", "/apple-icon.png?apple-icon.z.png"]);
    // 湘泰账号：没有内联脚本、React 也没换过 → applyDocumentBrand(null) 一个属性都不碰
    const xt = new FakeDom();
    parseXiangtaiHead(xt);
    const before = xt.snapshot();
    withGlobals(xt, {}, () => docBrand.applyDocumentBrand(null));
    assert.deepEqual(xt.snapshot(), before);
    const hook = fs.readFileSync(path.join(process.cwd(), "apps/web/src/modules/branding/useWorkbenchBrand.ts"), "utf-8");
    assert.match(hook, /if \(state === undefined \|\| !userId\) return;\s*applyDocumentBrand\(/, "会话没读到时不许调 applyDocumentBrand（会把内联脚本换好的标题还原成湘泰）");
    assert.match(hook, /JSON\.stringify\(buildBrandCacheRecord\(userId, brand\)\)/, "写品牌缓存没带上算好的图标地址");
  });

  await check("30) 内联脚本不动的情况：湘泰客户 / 管理员 / 登录页 / 代理前缀登录页 / 没缓存；旧缓存只改标题；离开工作台路径还原并停下", () => {
    const cases: Array<[string, Record<string, string | null>]> = [
      ["/client", storeFor("client", rec("zz_u1", null))],
      ["/client", storeFor("admin", rec("zz_u1", BRAND_LOGO))],
      ["/staff", storeFor("staff", rec("zz_u1", BRAND_LOGO))],
      ["/login", storeFor("client", rec("zz_u1", BRAND_LOGO))],
      ["/zz-a", storeFor("client", rec("zz_u1", BRAND_LOGO))],
      ["/client", storeFor("client", null)],
      ["/client", { [AUTH_SESSION_STORAGE_KEY]: null, [WORKBENCH_BRAND_CACHE_KEY]: rec("zz_u1", BRAND_LOGO) }],
    ];
    for (const [p, store] of cases) {
      const dom = new FakeDom();
      const ref = new FakeDom();
      const win = runEarly(dom, p, store);
      assert.equal(win[H], undefined, `${p} 不该挂把手`);
      assert.equal(dom.observers.length, 0, `${p} 不该盯 <head>`);
      parseXiangtaiHead(dom); dom.flush(); hydrateXiangtaiHead(dom); dom.flush();
      parseXiangtaiHead(ref); hydrateXiangtaiHead(ref);
      assert.deepEqual(dom.snapshot(), ref.snapshot(), `${p} 的 <head> 被动了`);
    }
    // 旧缓存（没 iconHref）：只改标题，图标一个属性都不碰
    const old = new FakeDom();
    runEarly(old, "/client", storeFor("client", JSON.stringify({ userId: "zz_u1", brand: BRAND_LOGO })));
    parseXiangtaiHead(old); old.flush();
    assert.equal(old.document().title, "A 代理国际物流");
    const oldRef = new FakeDom();
    parseXiangtaiHead(oldRef);
    assert.deepEqual(old.snapshot().links, oldRef.snapshot().links, "旧缓存（没 iconHref）不许动图标");
    // 离开工作台路径（保险）：下一次 <head> 变化时还原并停下
    const leave = new FakeDom();
    const win = runEarly(leave, "/client", storeFor("client", rec("zz_u1", BRAND_LOGO)));
    parseXiangtaiHead(leave); leave.flush();
    win.location.pathname = "/login";
    leave.titles()[0]!.setText("湘泰物流网站"); leave.flush();
    assert.equal(leave.document().title, "湘泰物流网站");
    assert.equal(leave.links()[1]!.getAttribute("href"), "/favicon.ico?favicon.x.ico");
    assert.equal(win[H], undefined);
    assert.equal(leave.observers.length, 0);
  });

  await check("31) 内联脚本异常一律静默：localStorage 抛错、没有 MutationObserver、<title> 已在前面；脚本只用 ES5、不含 </script、根布局 <head> 里真放了它", () => {
    const dom = new FakeDom();
    assert.doesNotThrow(() => runEarly(dom, "/client", "throws"));
    assert.equal(dom.observers.length, 0);
    const noMO = new FakeDom();
    parseXiangtaiHead(noMO);
    assert.doesNotThrow(() => runEarly(noMO, "/client", storeFor("client", rec("zz_u1", BRAND_LOGO)), false));
    assert.equal(noMO.document().title, "A 代理国际物流", "<title> 已解析出来时脚本当场就该换");
    assert.equal(noMO.links()[1]!.getAttribute("href"), "/images/zz_fxt_logo.png");
    const src = early.EARLY_TAB_BRAND_SCRIPT;
    assert.ok(!/<\/script/i.test(src), "脚本里有 </script，会把 HTML 截断");
    assert.ok(!/=>|\bconst\b|\blet\b|`|\?\.|\?\?|\bclass\b/.test(src.replace(/\/\*[\s\S]*?\*\//g, "")), "内联脚本只许用 ES5 写法（老浏览器解析失败就整段不跑）");
    assert.ok(src.includes(JSON.stringify(AUTH_SESSION_STORAGE_KEY)) && src.includes(JSON.stringify(WORKBENCH_BRAND_CACHE_KEY)), "脚本读的键名跟 auth-session.ts 不一致");
    const layout = fs.readFileSync(path.join(process.cwd(), "apps/web/src/app/layout.tsx"), "utf-8");
    assert.match(layout, /<head>[\s\S]*<script dangerouslySetInnerHTML=\{\{ __html: EARLY_TAB_BRAND_SCRIPT \}\} \/>[\s\S]*<\/head>/, "根布局 <head> 里没放首帧脚本");
    const eb = fs.readFileSync(path.join(process.cwd(), "apps/web/src/modules/branding/early-tab-brand.ts"), "utf-8");
    assert.ok(!/^\s*["']use client["']/m.test(eb), "early-tab-brand.ts 不能是客户端模块（根布局是服务端组件，要直接拿字符串）");
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
