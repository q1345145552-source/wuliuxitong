/**
 * 实时推送（2026-10-05）—— 前端连接管理的行为测试（不开浏览器，用假的 window / fetch 跑真代码）。
 *
 * 盯：
 *   C1 令牌放请求头、不进网址；一个标签页只开一条连接（多个页面共用）
 *   C2 只叫醒订了这一类的页面；200 毫秒内的多条合成一次
 *   C3 断了自己重连；每次连上（包括第一次）所有订阅的页面都补拉一次（断线期间 / 开页到连上之间漏的靠这一下补齐）
 *   C4 401 / 服务器说「auth:」就停，不反复敲门；换了新令牌（别的标签页重新登录）马上重连
 *   C5 没登录不连；连通 / 断开的状态对外报得准
 *   C6 没人订阅 10 秒后断开（退出登录 / 改密码都是整页跳到 /login，连接跟着页面一起没了，不用另外断）
 *   L1~L6 页面用的「推送马上拉 + 兜底轮询」：开头不拉、连通前后兜底节奏不同、只叫醒订了的类别、
 *         拉的时候又来推送只补一次、抛错不影响下次、用最新的函数、停了就不再拉
 *   H1/H2 网页在后台 15 秒就断开、切回来马上连并补拉（线上 HTTP/1.1，浏览器每站 6 条连接，开多了整站卡）
 *   B1 被服务器挤掉不马上回头再挤（dsh 实测过轮着互挤）；F1 没给兜底间隔的页面推送断了也按默认间隔拉
 */
import assert from "node:assert/strict";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed++;
  console.log(`✓ ${name}`);
}

// ---------- 假的浏览器环境 ----------
const store = new Map<string, string>();
const win = new EventTarget() as any;
win.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
win.location = { pathname: "/staff", href: "/staff" };
(globalThis as any).window = win;
const doc = new EventTarget() as any;
doc.visibilityState = "visible";
(globalThis as any).document = doc;

function login(token: string): void {
  store.set("auth_session_v1", JSON.stringify({ userId: "u1", companyId: "co1", role: "staff", token }));
}

// ---------- 假的服务器：每次 fetch 开一条可控的流 ----------
interface FakeStream {
  url: string;
  auth: string | null;
  status: number;
  push(text: string): void;
  end(): void;
  aborted: boolean;
}
const streams: FakeStream[] = [];
let nextStatus = 200;
(globalThis as any).fetch = async (url: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const enc = new TextEncoder();
  const s: FakeStream = {
    url, auth: headers.get("Authorization"), status: nextStatus, aborted: false,
    push: (t) => { try { controller.enqueue(enc.encode(t)); } catch { /* 已关 */ } },
    end: () => { try { controller.close(); } catch { /* 已关 */ } },
  };
  streams.push(s);
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  init.signal?.addEventListener("abort", () => {
    s.aborted = true;
    try { controller.error(new DOMException("aborted", "AbortError")); } catch { /* 已关 */ }
  });
  if (s.status !== 200) return new Response("{}", { status: s.status });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
};

async function main(): Promise<void> {
  login("tok-A");
  const rt = await import("../apps/web/src/services/realtime");

  let shipCalls = 0;
  let chatCalls = 0;
  let unsubShip: () => void = () => {};
  let unsubChat: () => void = () => {};

  await check("C1 令牌放在请求头里、不进网址；两个页面共用一条连接", async () => {
    unsubShip = rt.subscribeRealtime(["shipping", "consolidation"], () => shipCalls++);
    unsubChat = rt.subscribeRealtime(["chat"], () => chatCalls++);
    await sleep(20);
    assert.equal(streams.length, 1);
    assert.equal(streams[0].url, "/auth/events");
    assert.equal(streams[0].auth, "Bearer tok-A");
    assert.ok(!streams[0].url.includes("tok-A"));
  });

  await check("C5 收到第一句之前不算连通，收到之后算", async () => {
    assert.equal(rt.isRealtimeLive(), false);
    streams[0].push("retry: 3000\n: ok\n\n");
    await sleep(20);
    assert.equal(rt.isRealtimeLive(), true);
  });

  await check("C3 一连上，所有订阅的页面都补拉一次（页面开始拉数据到连上之间的变化不会漏，Codex 复查 2026-10-05）", async () => {
    await sleep(300);
    assert.equal(shipCalls, 1);
    assert.equal(chatCalls, 1);
    shipCalls = 0;
    chatCalls = 0;
  });

  await check("C2 只叫醒订了这一类的；连着来的几条合成一次；拆成两半发的也认得", async () => {
    streams[0].push('data: {"t":["shipping"]}\n\n');
    streams[0].push('data: {"t":["consolidation","fcl"]}\n\n');
    streams[0].push('data: {"t":["shi');
    await sleep(10);
    streams[0].push('pping"]}\n\n');
    await sleep(300);
    assert.equal(shipCalls, 1);
    assert.equal(chatCalls, 0);
    streams[0].push('data: {"t":["chat"]}\n\n');
    await sleep(300);
    assert.equal(chatCalls, 1);
    assert.equal(shipCalls, 1);
    streams[0].push('data: {"t":["accounts"]}\n\n: ping\n\n');
    await sleep(300);
    assert.equal(chatCalls + shipCalls, 2);
  });

  await check("C3 断了 1 秒左右自己重连；连上后所有页面补拉一次", async () => {
    streams[0].end();
    await sleep(30);
    assert.equal(rt.isRealtimeLive(), false);
    await sleep(1500);
    assert.equal(streams.length, 2, "应该重连了一次");
    assert.equal(streams[1].auth, "Bearer tok-A");
    streams[1].push(": ok\n\n");
    await sleep(300);
    assert.equal(rt.isRealtimeLive(), true);
    assert.equal(shipCalls, 2);
    assert.equal(chatCalls, 2);
  });

  await check("C4 服务器说登录失效（bye auth:）：停下，不再敲门", async () => {
    streams[1].push('event: bye\ndata: {"reason":"auth:账号已被封禁"}\n\n');
    await sleep(2500);
    assert.equal(streams.length, 2);
    assert.equal(rt.isRealtimeLive(), false);
  });

  await check("C4 别的标签页重新登录（令牌换了）：马上重连，用新令牌", async () => {
    login("tok-B");
    win.dispatchEvent(Object.assign(new Event("storage"), { key: "auth_session_v1" }));
    await sleep(30);
    assert.equal(streams.length, 3);
    assert.equal(streams[2].auth, "Bearer tok-B");
    streams[2].push(": ok\n\n");
    await sleep(30);
    assert.equal(rt.isRealtimeLive(), true);
  });

  await check("C4 连接时回 401：停下，同一张令牌不再试", async () => {
    nextStatus = 401;
    streams[2].end();
    await sleep(1600);
    assert.equal(streams.length, 4);
    assert.equal(streams[3].status, 401);
    await sleep(2500);
    assert.equal(streams.length, 4, "401 之后不该再试");
    win.dispatchEvent(new Event("online"));
    win.dispatchEvent(new Event("focus"));
    await sleep(50);
    assert.equal(streams.length, 4, "同一张令牌，切回来也不该再试");
    nextStatus = 200;
    login("tok-C");
    win.dispatchEvent(new Event("focus"));
    await sleep(30);
    assert.equal(streams.length, 5);
    assert.equal(streams[4].auth, "Bearer tok-C");
    streams[4].push(": ok\n\n");
    await sleep(30);
  });

  await check("C6 页面都退订了：10 秒后断开；中途又订回来就不断", async () => {
    unsubShip();
    unsubChat();
    await sleep(5000);
    const again = rt.subscribeRealtime(["fcl"], () => {});
    await sleep(6000);
    assert.equal(streams[4].aborted, false, "又有人订阅了，不该断");
    again();
    await sleep(10_300);
    assert.equal(streams[4].aborted, true);
    assert.equal(streams.length, 5, "没人订阅不该重连");
  });

  await check("C5 没登录不连", async () => {
    store.clear();
    const un = rt.subscribeRealtime(["shipping"], () => {});
    await sleep(50);
    assert.equal(streams.length, 5);
    un();
  });

  // ---------- 页面用的「推送马上拉 + 兜底轮询」（live-refresh.ts，useLiveRefresh 包的就是它） ----------
  const { startLiveRefresh } = await import("../apps/web/src/modules/realtime/live-refresh");
  login("tok-L");
  const calls: string[] = [];
  let slow = 0;
  let currentFn = async (_w: () => boolean, reason: "push" | "poll") => {
    calls.push(reason);
    if (slow) await sleep(slow);
  };
  const stopL = startLiveRefresh({ topics: ["shipping"], pollMs: 700, livePollMs: 2500, getRefresh: () => currentFn });
  await sleep(30);
  const sL = streams[streams.length - 1];

  await check("L1 一开始不拉（页面自己拉过了）；连通前按断线的快节奏兜底", async () => {
    assert.equal(sL.auth, "Bearer tok-L");
    assert.deepEqual(calls, []);
    await sleep(800);
    assert.deepEqual(calls, ["poll"]);
  });

  await check("L2 连通后兜底换成慢节奏；推送一到马上拉（reason=push）", async () => {
    sL.push(": ok\n\n");
    await sleep(300);
    assert.deepEqual(calls.slice(-1), ["push"], "连上后没补拉");
    calls.length = 0;
    await sleep(1000);
    assert.deepEqual(calls, [], "连通了还按 0.7 秒在拉");
    sL.push('data: {"t":["shipping"]}\n\n');
    await sleep(300);
    assert.deepEqual(calls, ["push"]);
    sL.push('data: {"t":["chat"]}\n\n');
    await sleep(300);
    assert.deepEqual(calls, ["push"], "没订的类别也拉了");
  });

  await check("L3 正在拉的时候又来推送：拉完马上补一次，只补一次、不叠成两条", async () => {
    calls.length = 0;
    slow = 600;
    sL.push('data: {"t":["shipping"]}\n\n');
    await sleep(300);
    sL.push('data: {"t":["shipping"]}\n\n');
    await sleep(250);
    sL.push('data: {"t":["shipping"]}\n\n');
    await sleep(1600);
    slow = 0;
    assert.deepEqual(calls, ["push", "push"]);
  });

  await check("L4 拉的函数抛错：不影响下一次推送照拉", async () => {
    calls.length = 0;
    const good = currentFn;
    currentFn = async (_w, reason) => { calls.push(reason); throw new Error("boom"); };
    sL.push('data: {"t":["shipping"]}\n\n');
    await sleep(300);
    currentFn = good;
    sL.push('data: {"t":["shipping"]}\n\n');
    await sleep(300);
    assert.deepEqual(calls, ["push", "push"]);
  });

  await check("L5 每次都用页面最新的那个函数（条件变了用新条件拉）", async () => {
    let usedNew = false;
    currentFn = async () => { usedNew = true; };
    sL.push('data: {"t":["shipping"]}\n\n');
    await sleep(300);
    assert.equal(usedNew, true);
  });

  await check("L6 断线了：兜底回到快节奏；停止以后推送、定时都不再拉", async () => {
    calls.length = 0;
    currentFn = async (_w, reason) => { calls.push(reason); };
    sL.end();
    await sleep(900);
    assert.ok(calls.includes("poll"), "断线后没按 0.7 秒兜底");
    stopL();
    calls.length = 0;
    await sleep(1500);
    const sLast = streams[streams.length - 1];
    sLast.push('data: {"t":["shipping"]}\n\n');
    await sleep(800);
    assert.deepEqual(calls, []);
  });

  // ---------- dsh 复查 2026-10-05 补的三条 ----------
  const setHidden = (hidden: boolean) => {
    doc.visibilityState = hidden ? "hidden" : "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
  };
  let hCalls = 0;
  const unH = rt.subscribeRealtime(["shipping"], () => hCalls++);
  login("tok-H");
  win.dispatchEvent(Object.assign(new Event("storage"), { key: "auth_session_v1" }));
  await sleep(1300); // 等停着的空闲连接收尾、用新令牌连上
  const sH = streams[streams.length - 1];
  sH.push(": ok\n\n");
  await sleep(300);

  await check("H1 切到后台 15 秒内不断（短暂切走不来回重连）", async () => {
    assert.equal(sH.auth, "Bearer tok-H");
    assert.equal(rt.isRealtimeLive(), true);
    setHidden(true);
    await sleep(3000);
    setHidden(false);
    await sleep(100);
    assert.equal(sH.aborted, false);
    assert.equal(streams[streams.length - 1], sH, "短暂切走不该重连");
  });

  await check("H2 在后台超过 15 秒就断开、在后台不重连；切回来马上连上并补拉一次（线上 HTTP/1.1 每站只有 6 条连接）", async () => {
    const before = streams.length;
    hCalls = 0;
    setHidden(true);
    await sleep(15_500);
    assert.equal(sH.aborted, true, "在后台 15 秒还没断");
    assert.equal(rt.isRealtimeLive(), false);
    await sleep(2500);
    assert.equal(streams.length, before, "在后台还在重连");
    win.dispatchEvent(new Event("online"));
    await sleep(100);
    assert.equal(streams.length, before, "在后台时网络恢复也不该连");
    setHidden(false);
    await sleep(80);
    assert.equal(streams.length, before + 1, "切回来没马上连");
    streams[streams.length - 1].push(": ok\n\n");
    await sleep(300);
    assert.equal(hCalls, 1, "切回来连上后没补拉（或补拉了不止一次）");
  });

  await check("B1 被服务器挤掉（busy:）：不马上重连；页面自己重新订阅也不连；人点回这个窗口才连", async () => {
    const sB = streams[streams.length - 1];
    const before = streams.length;
    sB.push('event: bye\ndata: {"reason":"busy:同一账号打开的页面太多"}\n\n');
    await sleep(2500);
    assert.equal(streams.length, before, "被挤掉后又自己连回去了（会回头挤别人，轮着互挤）");
    const un2 = rt.subscribeRealtime(["fcl"], () => {});
    await sleep(100);
    assert.equal(streams.length, before, "页面换栏目重新订阅就连回去了");
    win.dispatchEvent(new Event("focus"));
    await sleep(80);
    assert.equal(streams.length, before + 1, "人点回窗口后没连");
    streams[streams.length - 1].push(": ok\n\n");
    await sleep(50);
    un2();
  });

  await check("F1 没给兜底间隔的页面：推送断着时按默认间隔兜底拉，在后台不拉；推送通了就不拉", async () => {
    const fCalls: string[] = [];
    const stopF = startLiveRefresh({ topics: ["config"], fallbackPollMs: 400, getRefresh: () => async (_w, reason) => { fCalls.push(reason); } });
    await sleep(600);
    assert.deepEqual(fCalls, [], "推送通着还在兜底拉");
    streams[streams.length - 1].end(); // 断线
    await sleep(700);
    assert.ok(fCalls.length >= 1 && fCalls.every((r) => r === "poll"), `断线后没兜底：${JSON.stringify(fCalls)}`);
    doc.visibilityState = "hidden"; // 只改状态不发事件：不触发 15 秒断开那条，单看兜底
    const n = fCalls.length;
    await sleep(1000);
    assert.equal(fCalls.length, n, "在后台还在兜底拉");
    doc.visibilityState = "visible";
    stopF();
  });
  unH();

  // ---------- 悄悄重拉给用户的请求让路（yield-guard.ts） ----------
  const { createYieldGuard } = await import("../apps/web/src/modules/realtime/yield-guard");
  await check("Y1 用户的请求在路上：悄悄重拉不发、记一笔；用户那次回来后补一次，只补一次", async () => {
    const g = createYieldGuard();
    let reruns = 0;
    const end = g.begin();
    assert.equal(g.allowSilent(() => reruns++), false);
    assert.equal(g.allowSilent(() => reruns++), false);
    assert.equal(reruns, 0);
    end();
    assert.equal(reruns, 1);
    end(); // 调两次只算一次
    assert.equal(reruns, 1);
    assert.equal(g.allowSilent(() => reruns++), true, "没有用户请求在路上就该直接发");
  });
  await check("Y2 两个用户请求叠着：都回来以后才补，补一次", async () => {
    const g = createYieldGuard();
    let reruns = 0;
    const a = g.begin();
    const b = g.begin();
    g.allowSilent(() => reruns++);
    a();
    assert.equal(reruns, 0);
    b();
    assert.equal(reruns, 1);
  });
  await check("Y3 每个会被悄悄重拉作废的加载函数都接了让路（源码）", async () => {
    const fs = await import("node:fs");
    const pathMod = await import("node:path");
    const web = pathMod.join(__dirname, "..", "apps/web/src");
    const expect: Array<[string, number]> = [
      ["app/staff/container-loading/page.tsx", 2],
      ["app/staff/consolidation/page.tsx", 2],
      ["app/admin/consolidation/page.tsx", 1],
      ["app/client/consolidation/page.tsx", 1],
      ["app/client/whr-consolidation/page.tsx", 1],
      ["app/admin/whr-consolidation/page.tsx", 1],
      ["app/staff/whr-consolidation/page.tsx", 1],
      ["app/staff/page.tsx", 1],
      ["components/lastmile/LastmileAddressPanel.tsx", 1],
      ["components/agent/agent-ui.tsx", 1],
    ];
    for (const [file, n] of expect) {
      const src = fs.readFileSync(pathMod.join(web, file), "utf8");
      assert.equal((src.match(/\.allowSilent\(/g) ?? []).length, n, `${file}：让路的地方不是 ${n} 处`);
      assert.equal((src.match(/endUser\?\.\(\);|endUser\(\);/g) ?? []).length, n, `${file}：用户请求收尾（endUser）不是 ${n} 处`);
    }
  });

  console.log(`\n实时推送（前端连接）${passed} 项全部通过`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
