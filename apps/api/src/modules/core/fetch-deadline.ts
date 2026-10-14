/**
 * 往外发请求「到点就走」（2026-10-14，拆派仓只读接口在用）。
 *
 * ⚠️ 坑：线上和 CI 跑的 Node 22 自带 fetch（undici 6.28），请求带 `redirect: "error"` 时走的是另一条路（不复制请求，
 * undici lib/web/fetch/index.js 第 1386 行那个分支）。这条路上一次垃圾回收之后，再 abort() 什么也不触发 ——
 * 对方回了响应头、内容迟迟不发完时，读响应体（reader.read() / response.json() 都一样）会一直挂到 undici 自己的
 * bodyTimeout：300 秒。握着 Response 也没用。
 *   10-12 CI 的 V9（拆派仓回传取司机车牌）就这样等了 300333 毫秒；本机 Node 24（undici 7）没有这个问题，所以本机一直测不出来。
 *   复现：.audit/2026-10-14/v9-fix/repro-gc.mjs（Node 22.23.3 强制回收一次：带 redirect:"error" 20 次卡 20 次；
 *   不设 / manual / follow 都是 0 次；等响应头那一步不受影响）。DeepSeek、汇率接口没带这个设置，实测不受影响，没改。
 *
 * 做法：不指望 undici 响应 abort。等响应头、读响应体的每一步都跟「我们自己的」signal 赛跑，signal 一中止就抛 signal.reason
 * （不带参数的 abort() 给的是 AbortError，跟 fetch 自己中止时一样）；没读完就放弃的响应体一律 cancel 掉，连接跟着断，不留着等 300 秒。
 * 计时器照旧由调用方管：等读完响应体才 clearTimeout。
 */

/** signal 中止时 reject 的 promise；用完调 dispose 摘掉监听 */
function whenAborted(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
  let dispose: () => void = () => {};
  const promise = new Promise<never>((_, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("This operation was aborted", "AbortError"));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    dispose = () => signal.removeEventListener("abort", onAbort);
  });
  promise.catch(() => undefined); // 没人等它时中止了也不算「没处理的 reject」
  return { promise, dispose };
}

/** fetch，等响应头这一步也跟 signal 赛跑；到点先走了的话，晚回来的响应把 body 取消掉 */
export async function fetchWithDeadline(url: string, init: RequestInit & { signal: AbortSignal }): Promise<Response> {
  const pending = fetch(url, init);
  const stop = whenAborted(init.signal);
  try {
    return await Promise.race([stop.promise, pending]); // 两边都已落定时中止优先
  } catch (error) {
    pending.then((late) => late.body?.cancel().catch(() => undefined), () => undefined);
    throw error;
  } finally {
    stop.dispose();
  }
}

/**
 * 读完整个响应体（边读边数字节）；超过 maxBytes 返回 null。
 * 每次 read 都跟 signal 赛跑；没读完就结束（到点、超上限、出错）都 cancel 响应体。
 */
export async function readBodyWithDeadline(response: Response, signal: AbortSignal, maxBytes = Infinity): Promise<Buffer | null> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const stop = whenAborted(signal);
  const chunks: Uint8Array[] = [];
  let size = 0;
  let finished = false;
  try {
    for (;;) {
      const { value, done } = await Promise.race([stop.promise, reader.read()]);
      if (done) { finished = true; break; }
      size += value.byteLength;
      if (size > maxBytes) return null;
      chunks.push(value);
    }
  } finally {
    stop.dispose();
    if (!finished) reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, size);
}
