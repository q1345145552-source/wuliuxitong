/**
 * 实时推送（2026-10-05 老板：「我需要做成app，数据都能连接上，不能有延迟」）—— 后端不连库的测试。
 *
 * 盯：
 *   R1 全部改数据接口（从源码里读，不手抄）都有归类，只有写明的那几个不推；几个关键接口归对类
 *   R2 谁收得到：别家公司收不到；客户只收自己的 / 员工做的；员工回客服只推那一个客户；代理只收自己名下的
 *   R3 总机：150 毫秒内的多条合成一条；同一账号连太多挤掉最早的；断开后不再写
 *   R4 publishAfterWrite：只认成功的 POST / DELETE、要登录；员工客服接口带上 clientId
 *   R5 真 HTTP 长连接：响应头（不缓冲、不压缩）、先写一句把头推出去、推送到得了、心跳、
 *      退出登录 / 封号会断开并告诉前端「auth:」、浏览器断开后从总机摘掉
 *   R6 server.ts 接线：长连接在路由表之前、只认 GET；推送在 handler 成功跑完之后、在 try 里
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import type { AddressInfo } from "node:net";

process.env.AUTH_SECRET = process.env.AUTH_SECRET || "zz-realtime-test-secret-0123456789abcdef";

const ROOT = path.resolve(__dirname, "..");
const API_SRC = path.join(ROOT, "apps/api/src");

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`✓ ${name}`);
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const { topicForWrite, REALTIME_TOPICS } = await import("../apps/api/src/modules/realtime/topics");
  const hubMod = await import("../apps/api/src/modules/realtime/hub");
  const { RealtimeHub, shouldDeliver, MAX_CONNECTIONS_PER_USER } = hubMod;
  const { openEventStream } = await import("../apps/api/src/realtime-stream");
  const { publishAfterWrite } = await import("../apps/api/src/modules/realtime/publish");
  const { signAuthToken } = await import("../apps/api/src/modules/auth/token");
  const { revokeToken } = await import("../apps/api/src/modules/core/token-blacklist");

  // ---------- R1 ----------
  const writeRoutes = new Set<string>();
  for (const file of walk(path.join(API_SRC, "modules"))) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/app\.(post|delete)\(\s*"([^"]+)"/g)) writeRoutes.add(m[2]);
  }
  await check("R1 从源码读到的改数据接口不少于 110 个（读漏了这条测试就没意义）", () => {
    assert.ok(writeRoutes.size >= 110, `只读到 ${writeRoutes.size} 个`);
  });
  await check("R1 只有写明的 7 个不推，其余全部归了类", () => {
    const skipped = [...writeRoutes].filter((p) => topicForWrite(p) === null).sort();
    assert.deepEqual(skipped, [
      "/auth/change-password",
      "/auth/login",
      "/auth/logout",
      "/client/chat/push/subscribe",
      "/client/chat/push/unsubscribe",
      "/staff/chat/push/subscribe",
      "/staff/chat/push/unsubscribe",
    ]);
    for (const p of writeRoutes) {
      const t = topicForWrite(p);
      if (t) assert.ok((REALTIME_TOPICS as readonly string[]).includes(t), `${p} 归到了不存在的类 ${t}`);
    }
  });
  await check("R1 关键接口归对类", () => {
    const expect: Record<string, string> = {
      "/staff/orders/patch-shipment-bundle": "shipping",
      "/admin/orders/update": "shipping",
      "/admin/containers/status": "shipping",
      "/staff/loading-manifests/seal": "shipping",
      "/admin/lastmile/status": "shipping",
      "/client/prealerts": "shipping",
      "/staff/prealerts/receive": "shipping",
      "/client/consolidation/pay": "consolidation",
      "/staff/consolidation/tasks/quote": "consolidation",
      "/staff/whr-consolidation/thailand-sign": "whr",
      "/admin/clients/whr-price": "whr",
      "/client/fcl-inquiries/accept": "fcl",
      "/staff/fcl-containers/update": "fcl",
      "/client/chat/send": "chat",
      "/staff/chat/read": "chat",
      "/admin/wallet/recharges/approve": "wallet",
      "/client/wallet/recharge": "wallet",
      "/admin/users/toggle-ban": "accounts",
      "/admin/agents/rebates/mark-paid": "accounts",
      "/agent/clients/price": "accounts",
      "/auth/register": "accounts",
      "/admin/shipping/rates": "config",
      "/admin/system/status-labels": "config",
      // 客户问 AI 会新增知识缺口 / 改会话记忆（Codex 复查）；AI 后台那几栏订的是 ai
      "/client/ai/chat": "ai",
      "/admin/ai/knowledge": "ai",
      "/admin/ai/knowledge-gaps/resolve": "ai",
    };
    for (const [p, t] of Object.entries(expect)) {
      assert.ok(writeRoutes.has(p), `源码里没有 ${p} 了，测试要跟着改`);
      assert.equal(topicForWrite(p), t, p);
    }
    // 以后新加的接口没写进规则，也会落到 shipping 推出去（宁多勿漏）
    assert.equal(topicForWrite("/staff/some-new-thing/save"), "shipping");
    assert.equal(topicForWrite("/admin/some-new-thing"), "shipping");
  });

  // ---------- R2 ----------
  const staffActor = { userId: "s1", role: "staff" as const, agentId: null };
  const conn = (userId: string, role: any, companyId = "co1", agentId: string | null = null) => ({ userId, role, companyId, agentId });
  await check("R2 别家公司一律收不到（员工也一样）", () => {
    assert.equal(shouldDeliver(conn("s9", "staff", "co2"), { companyId: "co1", topic: "shipping", actor: staffActor }), false);
    assert.equal(shouldDeliver(conn("c9", "client", "co2"), { companyId: "co1", topic: "shipping", actor: staffActor }), false);
  });
  await check("R2 员工 / 管理员收本公司全部分类", () => {
    for (const t of REALTIME_TOPICS) {
      assert.equal(shouldDeliver(conn("s2", "staff"), { companyId: "co1", topic: t, actor: { userId: "c1", role: "client", agentId: null } }), true);
      assert.equal(shouldDeliver(conn("a1", "admin"), { companyId: "co1", topic: t, actor: staffActor }), true);
    }
  });
  await check("R2 客户：员工做的收得到；别的客户做的收不到；自己做的收得到；账号类收不到", () => {
    const me = conn("c1", "client");
    assert.equal(shouldDeliver(me, { companyId: "co1", topic: "shipping", actor: staffActor }), true);
    assert.equal(shouldDeliver(me, { companyId: "co1", topic: "shipping", actor: { userId: "c2", role: "client", agentId: null } }), false);
    assert.equal(shouldDeliver(me, { companyId: "co1", topic: "consolidation", actor: { userId: "c1", role: "client", agentId: null } }), true);
    assert.equal(shouldDeliver(me, { companyId: "co1", topic: "accounts", actor: staffActor }), false);
    // AI 后台那一类只给员工 / 管理员：客户、代理都收不到（客户自己问 AI 也不推回给客户）
    assert.equal(shouldDeliver(me, { companyId: "co1", topic: "ai", actor: { userId: "c1", role: "client", agentId: null } }), false);
    assert.equal(shouldDeliver(conn("u_ag1", "agent", "co1", "ag1"), { companyId: "co1", topic: "ai", actor: staffActor }), false);
    assert.equal(shouldDeliver(conn("s2", "staff"), { companyId: "co1", topic: "ai", actor: { userId: "c1", role: "client", agentId: null } }), true);
  });
  await check("R2 员工回客服：只推给那一个客户", () => {
    const ev = { companyId: "co1", topic: "chat" as const, actor: staffActor, clientIds: ["c1"] };
    assert.equal(shouldDeliver(conn("c1", "client"), ev), true);
    assert.equal(shouldDeliver(conn("c2", "client"), ev), false);
    assert.equal(shouldDeliver(conn("s2", "staff"), ev), true);
  });
  await check("R2 代理：只收员工做的、自己做的、自己名下客户做的；别的代理的客户收不到", () => {
    const ag = conn("u_ag1", "agent", "co1", "ag1");
    assert.equal(shouldDeliver(ag, { companyId: "co1", topic: "shipping", actor: staffActor }), true);
    assert.equal(shouldDeliver(ag, { companyId: "co1", topic: "shipping", actor: { userId: "c5", role: "client", agentId: "ag1" } }), true);
    assert.equal(shouldDeliver(ag, { companyId: "co1", topic: "shipping", actor: { userId: "c6", role: "client", agentId: "ag2" } }), false);
    assert.equal(shouldDeliver(ag, { companyId: "co1", topic: "shipping", actor: { userId: "c7", role: "client", agentId: null } }), false);
    assert.equal(shouldDeliver(ag, { companyId: "co1", topic: "accounts", actor: { userId: "u_ag1", role: "agent", agentId: "ag1" } }), true);
    assert.equal(shouldDeliver(ag, { companyId: "co1", topic: "chat", actor: staffActor }), false);
    // 代理改了价：自己名下客户收得到，别的代理的客户收不到
    const agentActor = { userId: "u_ag1", role: "agent" as const, agentId: "ag1" };
    assert.equal(shouldDeliver(conn("c5", "client", "co1", "ag1"), { companyId: "co1", topic: "shipping", actor: agentActor }), true);
    assert.equal(shouldDeliver(conn("c6", "client", "co1", "ag2"), { companyId: "co1", topic: "shipping", actor: agentActor }), false);
    assert.equal(shouldDeliver(conn("c7", "client", "co1", null), { companyId: "co1", topic: "shipping", actor: agentActor }), false);
  });

  // ---------- R3 ----------
  type Fake = { id: number; userId: string; companyId: string; role: any; agentId: string | null; writes: string[][]; closed: string | null; write(t: string[]): void; close(r: string): void };
  function fake(hub: InstanceType<typeof RealtimeHub>, userId: string, role: any = "staff", companyId = "co1"): Fake {
    const f: Fake = {
      id: hub.allocateId(), userId, companyId, role, agentId: null, writes: [], closed: null,
      write(t) { f.writes.push(t); },
      close(r) { f.closed = r; hub.remove(f.id); },
    };
    hub.add(f as any);
    return f;
  }
  await check("R3 150 毫秒内的多条合成一条，分类去重", async () => {
    const hub = new RealtimeHub(50);
    const a = fake(hub, "s1");
    for (let i = 0; i < 30; i++) hub.publish({ companyId: "co1", topic: i % 2 ? "shipping" : "chat", actor: staffActor });
    assert.equal(a.writes.length, 0, "合并窗口内不该马上写");
    await sleep(120);
    assert.equal(a.writes.length, 1);
    assert.deepEqual([...a.writes[0]].sort(), ["chat", "shipping"]);
    hub.publish({ companyId: "co1", topic: "fcl", actor: staffActor });
    await sleep(120);
    assert.equal(a.writes.length, 2);
    assert.deepEqual(a.writes[1], ["fcl"]);
  });
  await check("R3 同一账号连太多：挤掉最早的，别人的不动", () => {
    const hub = new RealtimeHub(10);
    const other = fake(hub, "s2");
    const mine = Array.from({ length: MAX_CONNECTIONS_PER_USER + 2 }, () => fake(hub, "s1"));
    assert.equal(mine.filter((f) => f.closed).length, 2);
    assert.ok(mine[0].closed && mine[1].closed && !mine[2].closed);
    // 原因要以 busy: 开头：前端认这个，停下等人点回来，别马上回头再挤别人（dsh 2026-10-05 实测过轮着互挤）
    assert.ok(mine[0].closed!.startsWith("busy:"), `挤掉的原因没带 busy:：${mine[0].closed}`);
    assert.equal(other.closed, null);
    assert.equal(hub.size, MAX_CONNECTIONS_PER_USER + 1);
  });
  await check("R3 断开以后不再写（合并窗口里断开的也不写）", async () => {
    const hub = new RealtimeHub(30);
    const a = fake(hub, "s1");
    hub.publish({ companyId: "co1", topic: "shipping", actor: staffActor });
    a.close("test");
    await sleep(80);
    assert.equal(a.writes.length, 0);
    assert.equal(hub.size, 0);
  });

  await check("R3 定时任务出了返现单：推「账号」类，只给那个代理和员工 / 管理员（dsh 复查补：定时任务不走接口，server.ts 推不到）", () => {
    const src = fs.readFileSync(path.join(API_SRC, "modules/agents/rebate-scheduler.ts"), "utf8");
    assert.match(src, /const before = result\.statementsCreated;\s*await generateForAgent\(a\.id, now, result\);/);
    assert.match(src, /if \(result\.statementsCreated > before\) \{[\s\S]{0,400}realtimeHub\.publish\(\{ companyId: a\.companyId, topic: "accounts", actor: \{ userId: "system", role: "agent", agentId: a\.id \} \}\)/);
    const ev = { companyId: "co1", topic: "accounts" as const, actor: { userId: "system", role: "agent" as const, agentId: "ag1" } };
    assert.equal(shouldDeliver(conn("u_ag1", "agent", "co1", "ag1"), ev), true);
    assert.equal(shouldDeliver(conn("u_ag2", "agent", "co1", "ag2"), ev), false);
    assert.equal(shouldDeliver(conn("s1", "staff"), ev), true);
    assert.equal(shouldDeliver(conn("a1", "admin"), ev), true);
    assert.equal(shouldDeliver(conn("c5", "client", "co1", "ag1"), ev), false);
  });

  // ---------- R4 ----------
  await check("R4 只认成功的、登录了的 POST / DELETE", async () => {
    const hub = new RealtimeHub(10);
    const a = fake(hub, "s1");
    const auth = { userId: "c1", companyId: "co1", role: "client" as const, name: "", agentId: null };
    publishAfterWrite({ method: "GET", path: "/client/prealerts", query: {}, headers: {}, auth }, 200, hub);
    publishAfterWrite({ method: "POST", path: "/client/prealerts", query: {}, headers: {}, auth }, 400, hub);
    publishAfterWrite({ method: "POST", path: "/client/prealerts", query: {}, headers: {}, auth }, 500, hub);
    publishAfterWrite({ method: "POST", path: "/client/prealerts", query: {}, headers: {} }, 200, hub);
    publishAfterWrite({ method: "POST", path: "/auth/login", query: {}, headers: {}, auth }, 200, hub);
    await sleep(40);
    assert.equal(a.writes.length, 0);
    publishAfterWrite({ method: "DELETE", path: "/client/addresses", query: {}, headers: {}, auth }, 200, hub);
    await sleep(40);
    assert.deepEqual(a.writes, [["shipping"]]);
  });
  await check("R4 删除前的预览（dryRun）只算不改：不推（Codex 复查：打开删除确认框就让全公司重拉）", async () => {
    const hub = new RealtimeHub(10);
    const a = fake(hub, "s1");
    const auth = { userId: "a1", companyId: "co1", role: "admin" as const, name: "", agentId: null };
    publishAfterWrite({ method: "POST", path: "/admin/consolidation/tasks/delete", query: {}, headers: {}, auth, body: { taskId: "t1", dryRun: true } }, 200, hub);
    await sleep(40);
    assert.deepEqual(a.writes, []);
    publishAfterWrite({ method: "POST", path: "/admin/consolidation/tasks/delete", query: {}, headers: {}, auth, body: { taskId: "t1" } }, 200, hub);
    await sleep(40);
    assert.deepEqual(a.writes, [["consolidation"]]);
    // 两个删除接口自己就是按 body.dryRun 真值判断只预览的，这里跟它们一个口径
    for (const f of ["modules/consolidation/routes.ts", "modules/whr-consolidation/routes.ts"]) {
      assert.match(fs.readFileSync(path.join(API_SRC, f), "utf8"), /if \(body\.dryRun\) \{/);
    }
  });
  await check("R4 员工客服接口：带上 body.clientId，只推那一个客户", async () => {
    const hub = new RealtimeHub(10);
    const c1 = fake(hub, "c1", "client");
    const c2 = fake(hub, "c2", "client");
    const auth = { userId: "s1", companyId: "co1", role: "staff" as const, name: "", agentId: null };
    publishAfterWrite({ method: "POST", path: "/staff/chat/send", query: {}, headers: {}, auth, body: { clientId: " c1 " } }, 200, hub);
    await sleep(40);
    assert.deepEqual(c1.writes, [["chat"]]);
    assert.deepEqual(c2.writes, []);
  });

  // ---------- R5 ----------
  const hub = new RealtimeHub(10);
  let sessionOk = true;
  const server = http.createServer((req, res) => {
    const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const role = (req.headers["x-test-role"] as string) || "staff";
    const auth = { userId: (req.headers["x-test-user"] as string) || "s1", companyId: "co1", role: role as any, name: "", agentId: null };
    const c = openEventStream(req, res, auth, {
      hub, heartbeatMs: 80, recheckMs: 60,
      checkSession: async () => (sessionOk ? { ok: true, agentId: null } : { ok: false, reason: "账号已被封禁" }),
    });
    if (!c) { res.statusCode = 401; res.end(); }
    void token;
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function openStream(token: string, headers: Record<string, string> = {}) {
    const ctrl = new AbortController();
    const res = await fetch(base + "/auth/events", { headers: { Authorization: `Bearer ${token}`, ...headers }, signal: ctrl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    let ended = false;
    const pump = (async () => {
      try {
        for (;;) { const { value, done } = await reader.read(); if (done) break; text += dec.decode(value, { stream: true }); }
      } catch { /* 主动断开 */ }
      ended = true;
    })();
    return { res, get text() { return text; }, get ended() { return ended; }, abort: () => ctrl.abort(), pump };
  }
  const token = () => signAuthToken({ userId: "s1", companyId: "co1", role: "staff", userName: "t" });

  await check("R5 响应头：事件流、不缓冲、不压缩；一连上就先写一句", async () => {
    const s = await openStream(token());
    assert.equal(s.res.status, 200);
    assert.match(s.res.headers.get("content-type") ?? "", /^text\/event-stream/);
    assert.equal(s.res.headers.get("x-accel-buffering"), "no");
    assert.match(s.res.headers.get("cache-control") ?? "", /no-transform/);
    await sleep(30);
    assert.match(s.text, /^retry: 3000\n: ok\n\n/);
    s.abort();
    await s.pump;
  });
  await check("R5 推送真的到得了浏览器；心跳在走", async () => {
    sessionOk = true;
    const s = await openStream(token());
    await sleep(30);
    hub.publish({ companyId: "co1", topic: "shipping", actor: { userId: "c1", role: "client", agentId: null } });
    await sleep(60);
    assert.match(s.text, /data: \{"t":\["shipping"\]\}\n\n/);
    await sleep(120);
    assert.match(s.text, /: ping\n\n/);
    s.abort();
    await s.pump;
  });
  await check("R5 浏览器断开后从总机摘掉", async () => {
    await sleep(80); // 等上一项断开的那条收完尾
    const before = hub.size;
    const s = await openStream(token());
    await sleep(30);
    assert.equal(hub.size, before + 1);
    s.abort();
    await s.pump;
    await sleep(50);
    assert.equal(hub.size, before);
  });
  await check("R5 退出登录（令牌拉黑）：一分钟内断开，并告诉前端是登录问题", async () => {
    const t = token();
    const s = await openStream(t);
    await sleep(20);
    revokeToken(t, Math.floor(Date.now() / 1000) + 3600);
    await sleep(150);
    assert.match(s.text, /event: bye\ndata: \{"reason":"auth:登录已退出"\}/);
    await s.pump;
    assert.equal(s.ended, true);
  });
  await check("R5 封号 / 改密码（复查登录状态不通过）：断开，原因带 auth:", async () => {
    sessionOk = false;
    const s = await openStream(token());
    await sleep(150);
    assert.match(s.text, /event: bye\ndata: \{"reason":"auth:账号已被封禁"\}/);
    await s.pump;
    sessionOk = true;
  });
  await check("R5 别家公司的变化不会写进来", async () => {
    const s = await openStream(token());
    await sleep(20);
    hub.publish({ companyId: "co2", topic: "shipping", actor: staffActor });
    await sleep(60);
    assert.doesNotMatch(s.text, /data:/);
    s.abort();
    await s.pump;
  });
  await check("R5 令牌坏的不接（返回 null 让 server.ts 回 401）", async () => {
    const r = await fetch(base + "/auth/events", { headers: { Authorization: "Bearer bad.token.x" } });
    assert.equal(r.status, 401);
  });
  server.close();

  // ---------- R5b 慢的读者 / 复查不叠（Codex 复查 2026-10-05），用假的请求 / 响应对象跑真代码 ----------
  const { EventEmitter } = await import("node:events");
  const { MAX_PENDING_BYTES } = await import("../apps/api/src/realtime-stream");
  function fakePair() {
    const req = new EventEmitter() as any;
    req.headers = { authorization: `Bearer ${token()}` };
    const res = new EventEmitter() as any;
    res.statusCode = 0;
    res.headers = {} as Record<string, string>;
    res.writableEnded = false;
    res.writableLength = 0;
    res.out = "";
    res.setHeader = (k: string, v: string) => { res.headers[k.toLowerCase()] = v; };
    res.write = (t: string) => { res.out += t; res.writableLength += Buffer.byteLength(t); return false; }; // 对方一个字节都不读
    res.end = () => { res.writableEnded = true; };
    return { req, res };
  }
  await check("R5b 对方读不动（攒的没发出去超过 64KB）：断开，不让内存一直涨", async () => {
    const hub2 = new RealtimeHub(1);
    const { req, res } = fakePair();
    const c = openEventStream(req, res, { userId: "s1", companyId: "co1", role: "staff", name: "", agentId: null }, { hub: hub2, heartbeatMs: 60_000, recheckMs: 60_000 })!;
    assert.ok(c);
    let n = 0;
    while (!res.writableEnded && n < 100_000) { c.write(["shipping"]); n++; }
    assert.equal(res.writableEnded, true, "攒了一大堆还没断");
    assert.ok(res.writableLength >= MAX_PENDING_BYTES && res.writableLength < MAX_PENDING_BYTES + 1024, `断得太晚：攒了 ${res.writableLength} 字节`);
    assert.match(res.out, /event: bye\ndata: \{"reason":"对方网络太慢/);
    assert.equal(hub2.size, 0);
    req.emit("close");
  });
  await check("R5b 复查登录状态：上一次查完才排下一次（数据库慢时一条连接不会叠着查）", async () => {
    const hub3 = new RealtimeHub(1);
    const { req, res } = fakePair();
    let running = 0;
    let maxRunning = 0;
    let calls = 0;
    const c = openEventStream(req, res, { userId: "s1", companyId: "co1", role: "staff", name: "", agentId: null }, {
      hub: hub3, heartbeatMs: 60_000, recheckMs: 30,
      checkSession: async () => { calls++; running++; maxRunning = Math.max(maxRunning, running); await sleep(150); running--; return { ok: true, agentId: null }; },
    })!;
    await sleep(700);
    c.close("test");
    req.emit("close");
    assert.ok(calls >= 2, `复查次数太少：${calls}`);
    assert.equal(maxRunning, 1, "同一条连接叠着查了");
  });

  // ---------- R6 ----------
  const serverSrc = fs.readFileSync(path.join(API_SRC, "server.ts"), "utf8");
  await check("R6 长连接在查路由表之前接住、只认 GET；没认出人回 401", () => {
    const sse = serverSrc.indexOf("path === REALTIME_STREAM_PATH");
    const table = serverSrc.indexOf("const routeTable =");
    assert.ok(sse > 0 && table > 0 && sse < table);
    assert.match(serverSrc, /method === "GET" && path === REALTIME_STREAM_PATH/);
    assert.match(serverSrc, /fail\(createJsonResponse\(rawRes\), 401, "UNAUTHORIZED"/);
  });
  await check("R6 推送在 handler 跑完之后、在 try 里（handler 抛错就不推）", () => {
    assert.match(serverSrc, /try \{\s*await handler\(req, res\);\s*\/\/[^\n]*\n\s*publishAfterWrite\(req, rawRes\.statusCode\);/);
  });
  const streamSrc = fs.readFileSync(path.join(API_SRC, "realtime-stream.ts"), "utf8");
  await check("R6 碰原始响应的长连接放在 src/ 管线层（不在 modules/），而且只写 SSE 那几种行、不写 JSON 响应体", () => {
    assert.ok(!fs.existsSync(path.join(API_SRC, "modules/realtime/stream.ts")));
    // 直接写原始响应的只有：开头那句、send() 里转一手、bye；其余一律经 send()
    const writes = [...streamSrc.matchAll(/rawRes\.(write|end)\(([^)]*)/g)].map((m) => m[2].trim());
    const sends = [...streamSrc.matchAll(/\bsend\(([^)]*)\)/g)].map((m) => m[1].trim()).filter((a) => !a.startsWith("text: string"));
    assert.ok(writes.length >= 3 && sends.length >= 2, "没认出写响应的地方（正则坏了）");
    for (const w of [...writes, ...sends]) {
      assert.ok(w === "" || w === "text" || /^["`](retry: |: ping|data: |event: bye)/.test(w), `写了不是 SSE 的东西：${w}`);
    }
    assert.match(streamSrc, /const send = \(text: string\): void => \{/);
  });
  await check("R6 长连接放在 /auth 下（Next 已经转发 /auth/*）", () => {
    assert.match(streamSrc, /REALTIME_STREAM_PATH = "\/auth\/events"/);
    const nextConfig = fs.readFileSync(path.join(ROOT, "apps/web/next.config.ts"), "utf8");
    assert.match(nextConfig, /source: "\/auth\/:path\*"/);
  });

  await check("R7 装柜页「哪票在哪个柜」一次查出来，口径跟原来一样（同一票在几个柜里取最早建的柜），前端不再按柜挨个拉", () => {
    const routes = fs.readFileSync(path.join(API_SRC, "modules/loading-manifests/routes.ts"), "utf8");
    assert.match(routes, /app\.get\("\/staff\/loading-manifests\/shipment-map"/);
    assert.match(routes, /where: \{ container: \{ companyId: auth\.companyId \} \}/, "没按公司过滤");
    assert.match(routes, /if \(!cur \|\| at < cur\.createdAt\)/, "不是取最早建的柜");
    const page = fs.readFileSync(path.join(ROOT, "apps/web/src/app/staff/container-loading/page.tsx"), "utf8");
    const body = page.slice(page.indexOf("const loadShipmentList = async () =>"), page.indexOf("const loadShipmentList = async () =>") + 600);
    assert.match(body, /fetchLoadingShipmentMap\(\)/);
    assert.doesNotMatch(body, /fetchLoadingManifestDetail/, "还在按柜挨个拉详情");
  });

  console.log(`\n实时推送（后端）${passed} 项全部通过`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
