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
import { readdirSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import v8 from "node:v8";
import vm from "node:vm";
import path from "node:path";
import type TS from "typescript";

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

/**
 * 先记时间、再发起（run 里才起计时器和请求），最多等 capMs（老毛病会挂 300 秒，这里先截住、报「挂住了」）。
 * ⚠️ 计时起点必须在计时器之前：fetch() 开头那段同步准备在机器忙时要 100 多毫秒，起点放在它后面，
 * 正常 600 毫秒就会被量成不到 480、被「太早断开」误判（10-14 那次没留原文的 D1 红，Codex / dsh 第 1 轮查出，dsh 加压 4 次复现 3 次）。
 */
async function within<T>(capMs: number, run: () => Promise<T>): Promise<{ value?: T; error?: unknown; hung?: true; ms: number }> {
  const t0 = performance.now();
  const p = run();
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

/** 轮询等条件成立，最多 capMs */
async function waitFor(cond: () => boolean, capMs: number): Promise<boolean> {
  const t0 = performance.now();
  while (performance.now() - t0 < capMs) { if (cond()) return true; await sleep(20); }
  return cond();
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
  // 先热身一次：进程里第一次 fetch 要做一次性初始化（10-14 子代理实测冷启动 185ms、之后 31ms），CPU 被压到 0.3 核时
  // 第一次请求还没到服务器就到点了，D1 会误报「连接没断」。热身两种 redirect 设置都走一遍，后面计时的请求不再背这个开销
  for (const redirect of ["error", "follow"] as const) {
    const warm = await fetch(`${base}/warm?tag=warm`, { redirect });
    await warm.arrayBuffer();
  }

  /** 跟拆派仓只读接口一样带 redirect:"error"（就是这个设置在 Node 22 上触发老毛病），请求挂着时回收一次内存 */
  async function timedRead(path: string, tag: string, timeoutMs: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await within(timeoutMs + 8000, async () => {
        const controller = new AbortController();
        timer = setTimeout(() => controller.abort(), timeoutMs);
        for (const f of [0.1, 0.25, 0.5]) setTimeout(collect, timeoutMs * f); // 回收几次：单一个时间点有时碰不上
        const response = await fetchWithDeadline(`${base}/${path}?tag=${tag}`, { redirect: "error", signal: controller.signal });
        return readBodyWithDeadline(response, controller.signal, 1024 * 1024);
      });
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
    const r = await within(2000, () => fetchWithDeadline(`${base}/stall-head?tag=d5`, { redirect: "error", signal: controller.signal }));
    assert.ok(!r.hung && isAbortError(r.error), `没报 AbortError：${String(r.error ?? r.value)}`);
  });

  // 下面两项（和 C4 / C5）把 fetch 换成假的：不靠哪个 Node 版本有没有毛病，直接考「跟我们自己的 signal 赛跑」这一层 ——
  // 以后 CI 的 Node 22 小版本修好了 undici，D1 / C1 / C2 就照不出删掉赛跑了，这几项照样红（Codex / dsh 第 1 轮建议）
  const realFetch = globalThis.fetch;
  await check("D6 fetch 自己完全不理中止（模拟最坏的情况）：等响应头这一步照样按时走", async () => {
    globalThis.fetch = (() => new Promise<Response>(() => undefined)) as typeof fetch;
    try {
      const r = await within(5000, () => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 300);
        return fetchWithDeadline(`${base}/never`, { signal: controller.signal });
      });
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
      const r = await within(3000, () => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 100);
        return fetchWithDeadline(`${base}/late`, { signal: controller.signal });
      });
      assert.ok(isAbortError(r.error), `报的不是 AbortError：${String(r.error ?? r.value)}`);
      assert.ok(await waitFor(() => cancelled, 3000), "晚回来的响应体 3 秒内没取消");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  // ---- 真正用到的地方：拆派仓只读接口（回传取司机车牌 / 签收图，员工看派送照片） ----
  const cfg = { companyId: "xiangtai", pullSecret: "x", callbackSecret: "x", readSecret: "x",
    apiBase: `http://127.0.0.1:${(cpServer.address() as AddressInfo).port}` };

  await check("C1 拆派仓详情回了头不发完（回传 V9 那条路），中途回收内存：按时回「超时」，连接断了", async () => {
    for (const ms of [60, 150, 300]) setTimeout(collect, ms);
    const r = await within(8600, () => fetchChaipaiDetail(cfg, "c1", { maxPages: 1, timeoutMs: 600 }));
    assert.ok(!r.hung, "挂住了 —— 拆派仓回传会等到 300 秒才回 503");
    assert.deepEqual(r.value, { kind: "error", reason: "超时" });
    assertOnTime(r.ms, 600);
    await assertClosed("c1");
  });

  await check("C2 拆派仓照片回了头不发完，中途回收内存：按时回「超时」，连接断了", async () => {
    for (const ms of [60, 150, 300]) setTimeout(collect, ms);
    const r = await within(8600, () => fetchChaipaiPhoto(cfg, "c2", "p1", { timeoutMs: 600 }));
    assert.ok(!r.hung, "挂住了 —— 员工看派送照片 / 签收取图会等到 300 秒");
    assert.deepEqual(r.value, { kind: "error", reason: "超时" });
    assertOnTime(r.ms, 600);
    await assertClosed("c2");
  });

  await check("C3 拆派仓回 503、内容又不发完：马上回「HTTP 503」（取消响应体不会卡住），连接断了", async () => {
    const r = await within(8600, () => fetchChaipaiDetail(cfg, "503c3", { maxPages: 1, timeoutMs: 3000 }));
    assert.ok(!r.hung, "挂住了");
    assert.deepEqual(r.value, { kind: "error", reason: "HTTP 503" });
    assert.ok(r.ms < 2500, `等了 ${Math.round(r.ms)} 毫秒 —— 取消响应体卡住了（应该马上回，不用等到 3 秒时限）`);
    await assertClosed("503c3");
  });

  /** 假 fetch：回 200 和一点内容，之后永远不发完、也不理任何中止（跟哪个 Node 版本有没有毛病无关）；记下有没有被取消 */
  function fakeStalledFetch(contentType: string, first: Uint8Array) {
    const state = { cancelled: false };
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(first); },
      pull() { return new Promise<void>(() => undefined); },
      cancel() { state.cancelled = true; },
    }), { status: 200, headers: { "content-type": contentType } })) as typeof fetch;
    return state;
  }

  await check("C4 拆派仓详情：fetch 回了头、内容永远不发完也不理中止（不靠 Node 版本）：按时回「超时」并取消响应体", async () => {
    const state = fakeStalledFetch("application/json", new TextEncoder().encode('{"code":"OK","data":'));
    try {
      const r = await within(8600, () => fetchChaipaiDetail(cfg, "c4", { maxPages: 1, timeoutMs: 600 }));
      assert.ok(!r.hung, "挂住了 —— 读响应体没跟我们自己的 signal 赛跑");
      assert.deepEqual(r.value, { kind: "error", reason: "超时" });
      assertOnTime(r.ms, 600);
      assert.ok(await waitFor(() => state.cancelled, 3000), "放弃后没取消响应体（连接会一直占着）");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await check("C5 拆派仓照片：同上，按时回「超时」并取消响应体", async () => {
    const state = fakeStalledFetch("image/jpeg", new Uint8Array(1024));
    try {
      const r = await within(8600, () => fetchChaipaiPhoto(cfg, "c5", "p1", { timeoutMs: 600 }));
      assert.ok(!r.hung, "挂住了 —— 读响应体没跟我们自己的 signal 赛跑");
      assert.deepEqual(r.value, { kind: "error", reason: "超时" });
      assertOnTime(r.ms, 600);
      assert.ok(await waitFor(() => state.cancelled, 3000), "放弃后没取消响应体（连接会一直占着）");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await check("C6 时限用的是传进来的值（假 fetch 不发完）：给 300ms 的明显早于给 1500ms 的，详情、照片都是", async () => {
    const run = async (kind: "detail" | "photo", timeoutMs: number) => {
      fakeStalledFetch(kind === "detail" ? "application/json" : "image/jpeg", new Uint8Array(16));
      try {
        return await within<unknown>(8600, () => kind === "detail"
          ? fetchChaipaiDetail(cfg, `c6-${timeoutMs}`, { maxPages: 1, timeoutMs })
          : fetchChaipaiPhoto(cfg, `c6-${timeoutMs}`, "p1", { timeoutMs }));
      } finally {
        globalThis.fetch = realFetch;
      }
    };
    for (const kind of ["detail", "photo"] as const) {
      const short = await run(kind, 300);
      const long = await run(kind, 1500);
      for (const r of [short, long]) assert.deepEqual(r.value, { kind: "error", reason: "超时" });
      // 「到点没断开」由别的项管（上限 +4 秒）；这里只管「用的是不是传进来的值」：300 的要在 1500 的下限（1200）之前回
      assert.ok(short.ms >= 240 && short.ms < 1200, `${kind} 给 300ms 却等了 ${Math.round(short.ms)}ms —— 没用传进来的时限`);
      assert.ok(long.ms >= 1200, `${kind} 给 1500ms 却 ${Math.round(long.ms)}ms 就断了 —— 没用传进来的时限`);
    }
  });

  await check("S1 后台代码里凡是带 redirect:\"error\" 的文件，都只走 fetchWithDeadline / readBodyWithDeadline（不直接碰 fetch、不自己读 body）", async () => {
    // 按语法树查，不用正则（Codex 10-14 第 2 轮：去注释的正则会把字符串里的 https:// 当注释、漏掉 globalThis.fetch / 别名 / for await）。
    // ⚠️ 放在最后、用到才加载 typescript：它一载进来内存大好几倍，前面计时的项强制回收会慢到超时；解析几秒还会让测试服务器
    // 空闲 5 秒关掉的连接正好被下一项复用 → fetch failed（10-14 第 2 轮改完在 Node 22 上压力测试 32 遍全红，就是这个）
    const ts: typeof TS = (await import("typescript")).default;
    // 它只是防手滑的绊线，不是完整的数据流分析；真正夹住修复的是上面实际发请求的各项（Node 22 上改坏 5 种全红）。
    // 已知认不出（Codex / dsh 第 4 轮列的，判定不再追）：init.redirect = "error" 这种事后赋值、const K = "redirect" 的计算属性、
    // r.clone().json()、const b = r.body 再读、const { fetch: f } = globalThis 改名、响应传给别的函数再读；
    // 同一文件不同函数里同名变量会被当成同一个响应（可能误报，报错会指到行号）。
    const root = path.join(__dirname, "../apps/api/src");
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
      const f = path.join(dir, n);
      return statSync(f).isDirectory() ? walk(f) : /\.[cm]?[jt]s$/.test(f) && !f.endsWith(".d.ts") ? [f] : [];
    });
    const helper = path.join(root, "modules/core/fetch-deadline.ts");
    let hits = 0;
    for (const f of walk(root)) {
      if (f === helper) continue;
      const sf = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true);
      const at = (n: TS.Node) => `第 ${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} 行`;
      const unwrap = (e: TS.Expression): TS.Expression => {
        while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isSatisfiesExpression(e)
          || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e) || ts.isAwaitExpression(e)) e = e.expression;
        return e;
      };
      const nameOf = (name: TS.Node): string | null => {
        if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
        if (ts.isComputedPropertyName(name)) { const v = unwrap(name.expression); return ts.isStringLiteralLike(v) ? v.text : null; }
        return null;
      };
      /** 是不是调了 fetchWithDeadline（直接调或 xx.fetchWithDeadline） */
      const isHelperCall = (e: TS.Expression): boolean => {
        const c = unwrap(e);
        if (!ts.isCallExpression(c)) return false;
        const callee = unwrap(c.expression);
        return (ts.isIdentifier(callee) && callee.text === "fetchWithDeadline")
          || (ts.isPropertyAccessExpression(callee) && callee.name.text === "fetchWithDeadline");
      };
      const inType = (n: TS.Node) => { for (let p = n.parent; p; p = p.parent) if (ts.isTypeNode(p)) return true; return false; };
      const isDeclName = (n: TS.Identifier) => {
        const p = n.parent;
        if (ts.isPropertyAccessExpression(p)) return p.name === n;
        if ((ts.isBindingElement(p) || ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) && p.propertyName === n) return true;
        return (ts.isPropertyAssignment(p) || ts.isBindingElement(p) || ts.isVariableDeclaration(p) || ts.isParameter(p)
          || ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p) || ts.isMethodSignature(p) || ts.isPropertySignature(p)
          || ts.isPropertyDeclaration(p) || ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) && p.name === n;
      };

      // 第一遍：这份文件带不带 redirect:"error"；哪些变量装着 fetchWithDeadline 拿回来的响应
      // redirect 的值能确定是别的字面量（"follow" / "manual"）才不算；"error"、as const、常量、变量、简写都算候选，宁可多查（dsh / Codex 第 3 轮）
      let redirectError = false;
      let usesHelper = false;
      const responses = new Set<string>();
      const scan = (n: TS.Node): void => {
        if (ts.isPropertyAssignment(n) && nameOf(n.name) === "redirect") {
          const v = unwrap(n.initializer);
          if (!(ts.isStringLiteralLike(v) && v.text !== "error")) redirectError = true;
        }
        if (ts.isShorthandPropertyAssignment(n) && n.name.text === "redirect") redirectError = true;
        if (ts.isCallExpression(n) && isHelperCall(n)) usesHelper = true;
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && isHelperCall(n.initializer)) responses.add(n.name.text);
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && isHelperCall(n.right)) responses.add(n.left.text);
        ts.forEachChild(n, scan);
      };
      scan(sf);
      if (!redirectError) continue;
      hits++;

      // 第二遍：绕开 fetch-deadline 的写法。读 body 只看上面那些响应（和它的 .body），服务端自己的 res.json() 不算（dsh 第 3 轮）
      const READ_BODY = new Set(["getReader", "json", "text", "arrayBuffer", "blob", "formData", "bytes", "pipeTo", "pipeThrough", "tee"]);
      const isResponse = (e: TS.Expression): boolean => {
        const r = unwrap(e);
        if (ts.isIdentifier(r)) return responses.has(r.text);
        if (ts.isPropertyAccessExpression(r) && r.name.text === "body") return isResponse(r.expression);
        return isHelperCall(r);
      };
      const bad: string[] = [];
      const check2 = (n: TS.Node): void => {
        // 任何值位置提到 fetch（直接调、const f = fetch、{ fetch }）
        if (ts.isIdentifier(n) && n.text === "fetch" && !isDeclName(n) && !inType(n)) bad.push(`${at(n)}直接用了 fetch`);
        if (ts.isPropertyAccessExpression(n) && n.name.text === "fetch" && !inType(n)) bad.push(`${at(n)}用了 ${n.getText(sf)}`);
        if (ts.isElementAccessExpression(n) && nameOf(n.argumentExpression) === "fetch") bad.push(`${at(n)}用了 ${n.getText(sf)}`);
        if (ts.isCallExpression(n)) {
          const callee = unwrap(n.expression);
          const method = ts.isPropertyAccessExpression(callee) ? callee.name.text
            : ts.isElementAccessExpression(callee) ? nameOf(callee.argumentExpression) : null;
          const receiver = ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee) ? callee.expression : null;
          if (method && receiver && READ_BODY.has(method) && isResponse(receiver)) bad.push(`${at(n)}自己读响应体 ${n.getText(sf).slice(0, 60)}`);
        }
        if (ts.isForOfStatement(n) && n.awaitModifier && isResponse(n.expression)) bad.push(`${at(n)}用 for await 读响应体`);
        ts.forEachChild(n, check2);
      };
      check2(sf);
      const rel = path.relative(root, f);
      assert.ok(usesHelper, `${rel} 带 redirect:"error" 却没用 fetchWithDeadline`);
      assert.deepEqual(bad, [], `${rel} 带 redirect:"error"，又绕开了 fetch-deadline —— Node 22 上读 body 碰上回收会挂 300 秒`);
    }
    assert.ok(hits > 0, "一个都没找到 —— 拆派仓只读接口应该带着 redirect:\"error\"，检查规则失效了");
  });

  server.close();
  cpServer.close();
  if (failures.length) throw new Error(`${failures.length} 项不通过：${failures.join("；")}`);
  console.log("拆派仓只读接口到点就走：14 项全部通过");
}

main().then(() => process.exit(0), (error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
