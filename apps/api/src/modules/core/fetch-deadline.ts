/**
 * 往外发请求「到点就走」（2026-10-14，拆派仓只读接口在用）。
 *
 * ⚠️ 坑：线上和 CI 跑的 Node 22 自带 fetch（undici 6.28），请求带 `redirect: "error"` 时，响应头已经到了、正在读响应体，
 * 这时碰上一次垃圾回收，之后 abort() 就什么也不触发 —— 对方内容迟迟不发完时，读响应体（reader.read() / response.json()
 * 都一样）会一直挂到 undici 自己的 bodyTimeout：300 秒，连接也一直占着。等响应头那一步 abort 照常生效；握着 Response 也没用。
 * 原因（10-14 子代理按 undici 6.28.1 源码查实，把第 1079 行注释掉重编后 10 次卡 0 次）：我们 signal 上 undici 只挂一个监听，
 * 它用 WeakRef 指着 Request 内部自己的 AbortController（request.js:423）；这个 controller 只靠 fetch() 的闭包拉住，闭包又只靠
 * fetchParams.processResponse 拉住，收到响应头后 index.js:1079 把它置空。带 redirect:"error" 时网络层拿的就是这同一个 fetchParams
 *（index.js:1386-1387，不复制），置空后没人再拉住，回收时 FinalizationRegistry（request.js:35）顺手摘掉我们 signal 上的监听。
 * 不带 "error" 时网络层拿的是副本（index.js:1396），副本里的 processResponse 不置空，所以没事 —— DeepSeek、汇率没带这个设置，
 * 实测不受影响，没改；请求方法、有没有请求体、压不压缩都无关。证据：.audit/2026-10-14/v9-fix/。
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
    // signal 已经中止的话这里马上走；fetch 拿到响应和到点落在同一拍时可能是响应赢，后面读 body 那一步会兜住（回「超时」）
    return await Promise.race([stop.promise, pending]);
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
