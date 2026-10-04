/**
 * 实时推送（2026-10-05）—— 前端连接管理的行为测试（不开浏览器，用假的 window / fetch 跑真代码）。
 *
 * 盯：
 *   C1 令牌放请求头、不进网址；一个标签页只开一条连接（多个页面共用）
 *   C2 只叫醒订了这一类的页面；200 毫秒内的多条合成一次
 *   C3 断了自己重连；重连上之后早就订阅的页面补拉一次（断线期间漏的靠这一下补齐）、刚订阅的不重复拉
 *   C4 401 / 服务器说「auth:」就停，不反复敲门；换了新令牌（别的标签页重新登录）马上重连
 *   C5 没登录不连；连通 / 断开的状态对外报得准
 *   C6 没人订阅 10 秒后断开（退出登录 / 改密码都是整页跳到 /login，连接跟着页面一起没了，不用另外断）
 *   L1~L6 页面用的「推送马上拉 + 兜底轮询」：开头不拉、连通前后兜底节奏不同、只叫醒订了的类别、
 *         拉的时候又来推送只补一次、抛错不影响下次、用最新的函数、停了就不再拉
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

  await check("C3 页面刚订阅就连上的，不额外补拉", async () => {
    await sleep(300);
    assert.equal(shipCalls, 0);
    assert.equal(chatCalls, 0);
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
    await sleep(50);
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

  console.log(`\n实时推送（前端连接）${passed} 项全部通过`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
