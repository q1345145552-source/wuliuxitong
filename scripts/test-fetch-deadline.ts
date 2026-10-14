/**
 * 拆派仓只读接口「到点就走」的自测（2026-10-14，apps/api/src/modules/core/fetch-deadline.ts）。
 *
 * 为什么要有这个：线上和 CI 的 Node 22 自带 fetch，请求带 redirect:"error"（拆派仓只读接口就带）时，
 * 一次垃圾回收之后 AbortController 的 abort() 会失灵 —— 对方回了响应头、内容迟迟不发完，读响应体会挂到 undici 自己的 300 秒上限。
 * 10-12 CI 里拆派仓回传那项（test-chaipai-db 的 V9）就这样等了 300333 毫秒；本机 Node 24 没这毛病，平时测不出来。
 *
 * 做法：本机起假服务器（只回头不发完 / 连头都不回 / 正常回），每项在请求挂着的时候**强制回收一次内存**，
 * 看是不是照样按配的时间断开、服务器那头的连接是不是真的断了。不连数据库、不连外网。
 * ⚠️ 只有在 Node 22 上才照得出老毛病（CI 就是 Node 22）；在 Node 24 上跑，老写法也会过。
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import v8 from "node:v8";
import vm from "node:vm";

v8.setFlagsFromString("--expose-gc");
const forceGc = vm.runInNewContext("gc") as () => void;
const collect = () => { forceGc(); forceGc(); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 每个请求按 tag 记下服务器这头的连接什么时候断的 */
const closedAt = new Map<string, number | null>();
function track(tag: string, req: http.IncomingMessage) {
  closedAt.set(tag, null);
  req.socket.on("close", () => closedAt.set(tag, performance.now()));
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  track(u.searchParams.get("tag") ?? "", req);
  const mode = u.pathname.split("/").pop();
  if (mode === "stall-head") return; // 连响应头都不回
  if (mode === "stall-body") { res.writeHead(200, { "content-type": "application/json" }); res.write('{"code":"OK","data":'); return; }
  if (mode === "drip") { // 慢慢发，但在时限内发完
    res.writeHead(200, { "content-type": "application/json" });
    const parts = ['{"code":"OK",', '"data":{"route":null,', '"handover":null,', '"photos":{"items":[],"nextCursor":null}}}'];
    let i = 0;
    const t = setInterval(() => { res.write(parts[i++]); if (i === parts.length) { clearInterval(t); res.end(); } }, 60);
    return;
  }
  if (mode === "big") { // 2 MiB，一块块发
    res.writeHead(200, { "content-type": "application/json" });
    let sent = 0;
    const push = () => { while (sent < 2 * 1024 * 1024) { sent += 64 * 1024; if (!res.write(Buffer.alloc(64 * 1024, 32))) { res.once("drain", push); return; } } res.end(); };
    push();
    return;
  }
  res.statusCode = 404; res.end("{}");
});

/** 假拆派仓：/integrations/domestic/v2/shipments/{id}[/photos/{photoId}] 一律回了头不发完（id 以 503 开头的回 503 头） */
const cpServer = http.createServer((req, res) => {
  const id = decodeURIComponent((req.url ?? "").split("/shipments/")[1]?.split(/[/?]/)[0] ?? "");
  track(id, req);
  if (id.startsWith("503")) { res.writeHead(503, { "content-type": "application/json" }); res.write('{"code":"SERVICE_UNAVAILABLE",'); return; }
  if (req.url?.includes("/photos/")) { res.writeHead(200, { "content-type": "image/jpeg" }); res.write(Buffer.alloc(1024, 1)); return; }
  res.writeHead(200, { "content-type": "application/json" }); res.write('{"code":"OK","data":');
});

const failures: string[] = [];
async function check(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  ❌ ${name}\n     ${(error instanceof Error ? error.message : String(error)).split("\n").join("\n     ")}`);
  }
}

/** 等 promise，最多等 capMs（老毛病会挂 300 秒，这里先截住、报「挂住了」） */
async function within<T>(capMs: number, p: Promise<T>): Promise<{ value?: T; error?: unknown; hung?: true; ms: number }> {
  const t0 = performance.now();
  const r = await Promise.race([
    p.then((value) => ({ value }), (error) => ({ error })),
    sleep(capMs).then(() => ({ hung: true as const })),
  ]);
  return { ...r, ms: performance.now() - t0 };
}

/**
 * 断开以后服务器这头的连接也要在 3 秒内断掉（不能留着等 300 秒）。
 * 余量放得宽：10-14 在 Node 22 容器里跑了约 50 遍，机器被连库测试压满的那一遍红过一次没留下原文，之后单跑 / 循环 60 遍 /
 * 4 份并发都复现不出来；老毛病是挂 300 秒、连接一直不断，宽一点照样一抓一个准（D1 / C1 / C2 改回老写法仍然红）。
 */
async function assertClosed(tag: string): Promise<void> {
  const t0 = performance.now();
  while (performance.now() - t0 < 3000) {
    if (closedAt.get(tag)) return;
    await sleep(20);
  }
  assert.fail(`服务器那头的连接（${tag}）3 秒内没断 —— 中途放弃的响应体没取消掉，连接会一直占着`);
}

/** 不早于配的时限的 80%（证明用的是配的值），不晚于时限 + 4 秒（老毛病要挂 300 秒；余量见上） */
function assertOnTime(ms: number, timeoutMs: number) {
  assert.ok(ms >= timeoutMs * 0.8, `才 ${Math.round(ms)} 毫秒就断了（配的是 ${timeoutMs}）—— 用的不是配的时限`);
  assert.ok(ms < timeoutMs + 4000, `等了 ${Math.round(ms)} 毫秒才断（配的是 ${timeoutMs}）—— 到点没断开`);
}

const isAbortError = (e: unknown) => e instanceof DOMException && e.code === DOMException.ABORT_ERR;

async function main(): Promise<void> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => cpServer.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { fetchWithDeadline, readBodyWithDeadline } = await import("../apps/api/src/modules/core/fetch-deadline");
  const { fetchChaipaiDetail, fetchChaipaiPhoto } = await import("../apps/api/src/modules/chaipai/read-client");
  console.log(`拆派仓只读接口到点就走（Node ${process.version}，undici ${process.versions.undici}）`);

  /** 跟拆派仓只读接口一样带 redirect:"error"（就是这个设置在 Node 22 上触发老毛病），请求挂着时回收一次内存 */
  async function timedRead(path: string, tag: string, timeoutMs: number) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    for (const f of [0.1, 0.25, 0.5]) setTimeout(collect, timeoutMs * f); // 回收几次：单一个时间点有时碰不上
    try {
      return await within(timeoutMs + 8000, (async () => {
        const response = await fetchWithDeadline(`${base}/${path}?tag=${tag}`, { redirect: "error", signal: controller.signal });
        return readBodyWithDeadline(response, controller.signal, 1024 * 1024);
      })());
    } finally {
      clearTimeout(timer);
    }
  }

  await check("D1 回了头、内容不发完，中途回收一次内存：照样按时断开（AbortError），连接也断了", async () => {
    const r = await timedRead("stall-body", "d1", 600);
    assert.ok(!r.hung, "挂住了 —— 读响应体没按时断开（就是 10-12 CI 那个 300 秒）");
    assert.ok(isAbortError(r.error), `报的不是 AbortError：${String(r.error ?? r.value)}`);
    assertOnTime(r.ms, 600);
    await assertClosed("d1");
  });

  await check("D2 连响应头都不回，中途回收一次内存：照样按时断开，连接也断了", async () => {
    const r = await timedRead("stall-head", "d2", 600);
    assert.ok(!r.hung, "挂住了 —— 等响应头没按时断开");
    assert.ok(isAbortError(r.error), `报的不是 AbortError：${String(r.error ?? r.value)}`);
    assertOnTime(r.ms, 600);
    await assertClosed("d2");
  });

  await check("D3 正常回（慢慢发，时限内发完）：照样读全，中途回收内存也不影响", async () => {
    const r = await timedRead("drip", "d3", 2000);
    assert.ok(!r.hung && !r.error, `出错了：${String(r.error)}`);
    const parsed = JSON.parse((r.value as Buffer).toString("utf8"));
    assert.deepEqual(parsed.data.photos, { items: [], nextCursor: null });
  });

  await check("D4 内容超过上限：返回 null、不读完，连接断掉", async () => {
    const r = await timedRead("big", "d4", 3000);
    assert.ok(!r.hung && !r.error, `出错了：${String(r.error)}`);
    assert.equal(r.value, null);
    await assertClosed("d4");
  });

  await check("D5 已经中止的 signal：直接报 AbortError", async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await within(2000, fetchWithDeadline(`${base}/stall-head?tag=d5`, { redirect: "error", signal: controller.signal }));
    assert.ok(!r.hung && isAbortError(r.error), `没报 AbortError：${String(r.error ?? r.value)}`);
  });

  // 下面两项把 fetch 换成假的：不靠哪个 Node 版本有没有毛病，直接考「跟我们自己的 signal 赛跑」这一层
  const realFetch = globalThis.fetch;
  await check("D6 fetch 自己完全不理中止（模拟最坏的情况）：等响应头这一步照样按时走", async () => {
    globalThis.fetch = (() => new Promise<Response>(() => undefined)) as typeof fetch;
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 300);
      const r = await within(5000, fetchWithDeadline(`${base}/never`, { signal: controller.signal }));
      assert.ok(!r.hung, "挂住了 —— 等响应头没跟我们自己的 signal 赛跑");
      assert.ok(isAbortError(r.error), `报的不是 AbortError：${String(r.error)}`);
      assertOnTime(r.ms, 300);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await check("D7 到点走了以后响应才回来：把它的响应体取消掉（不留着连接）", async () => {
    let cancelled = false;
    const late = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    globalThis.fetch = (() => sleep(500).then(() => late)) as typeof fetch;
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100);
      const r = await within(3000, fetchWithDeadline(`${base}/late`, { signal: controller.signal }));
      assert.ok(isAbortError(r.error), `报的不是 AbortError：${String(r.error ?? r.value)}`);
      await sleep(700);
      assert.ok(cancelled, "晚回来的响应体没取消");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  // ---- 真正用到的地方：拆派仓只读接口（回传取司机车牌 / 签收图，员工看派送照片） ----
  const cfg = { companyId: "xiangtai", pullSecret: "x", callbackSecret: "x", readSecret: "x",
    apiBase: `http://127.0.0.1:${(cpServer.address() as AddressInfo).port}` };

  await check("C1 拆派仓详情回了头不发完（回传 V9 那条路），中途回收内存：按时回「超时」，连接断了", async () => {
    for (const ms of [60, 150, 300]) setTimeout(collect, ms);
    const r = await within(8600, fetchChaipaiDetail(cfg, "c1", { maxPages: 1, timeoutMs: 600 }));
    assert.ok(!r.hung, "挂住了 —— 拆派仓回传会等到 300 秒才回 503");
    assert.deepEqual(r.value, { kind: "error", reason: "超时" });
    assertOnTime(r.ms, 600);
    await assertClosed("c1");
  });

  await check("C2 拆派仓照片回了头不发完，中途回收内存：按时回「超时」，连接断了", async () => {
    for (const ms of [60, 150, 300]) setTimeout(collect, ms);
    const r = await within(8600, fetchChaipaiPhoto(cfg, "c2", "p1", { timeoutMs: 600 }));
    assert.ok(!r.hung, "挂住了 —— 员工看派送照片 / 签收取图会等到 300 秒");
    assert.deepEqual(r.value, { kind: "error", reason: "超时" });
    assertOnTime(r.ms, 600);
    await assertClosed("c2");
  });

  await check("C3 拆派仓回 503、内容又不发完：马上回「HTTP 503」（取消响应体不会卡住），连接断了", async () => {
    const r = await within(8600, fetchChaipaiDetail(cfg, "503c3", { maxPages: 1, timeoutMs: 3000 }));
    assert.ok(!r.hung, "挂住了");
    assert.deepEqual(r.value, { kind: "error", reason: "HTTP 503" });
    assert.ok(r.ms < 2500, `等了 ${Math.round(r.ms)} 毫秒 —— 取消响应体卡住了（应该马上回，不用等到 3 秒时限）`);
    await assertClosed("503c3");
  });

  server.close();
  cpServer.close();
  if (failures.length) throw new Error(`${failures.length} 项不通过：${failures.join("；")}`);
  console.log("拆派仓只读接口到点就走：10 项全部通过");
}

main().then(() => process.exit(0), (error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
