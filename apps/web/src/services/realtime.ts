import { getOptionalSession, AUTH_SESSION_STORAGE_KEY } from "../auth/auth-session";

/**
 * 实时更新（2026-10-05 老板要做 app：「数据都能连接上，不能有延迟」）。
 *
 * 后端在任何人改了数据之后，往这条长连接里推一句「哪一类变了」（不带内容），
 * 页面收到就调自己原来的接口重拉。原来靠每隔 3～10 秒问一次，员工端运单列表干脆不刷新。
 *
 * - 一个标签页只开一条连接，所有页面 / 组件共用（订阅时说自己关心哪几类）。
 * - 用 fetch 读流、令牌放 Authorization 头；不用浏览器自带的 EventSource，那个带不了请求头，
 *   令牌只能塞进网址，会进 nginx 访问日志。
 * - 断了自己重连（1 秒起，越断越慢，最长 30 秒）；**重连上之后让所有页面重拉一次**，
 *   断线那段时间漏掉的变化靠这一下补齐，不会因为断过一次就一直停在旧数据上。
 * - 登录失效（401 / 服务器说登录已退出）就停，不反复敲门；换了新令牌（重新登录）再连。
 */

export type RealtimeTopic = "shipping" | "consolidation" | "whr" | "fcl" | "chat" | "wallet" | "accounts" | "config";

/** 后端那条连接的地址（Next 已经把 /auth/* 转给接口） */
export const REALTIME_PATH = "/auth/events";

/** 同一个订阅者多久内收到的多条合成一次（后端已经合过一次，这里再兜一层，页面重拉期间又来的也并进来） */
const DEBOUNCE_MS = 200;
/** 这么久一个字节都没收到就当连接死了（后端 20 秒一次心跳） */
const WATCHDOG_MS = 50_000;
/** 没人订阅之后再等多久断开（页面之间跳转会先退订再订，别来回断） */
const IDLE_CLOSE_MS = 10_000;
/** 订阅之后多久内连上的，算「页面刚拉过」，不用补拉 */
const FRESH_SUBSCRIBE_MS = 1_500;

interface Subscriber {
  topics: ReadonlySet<RealtimeTopic>;
  callback: () => void;
  since: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const subscribers = new Set<Subscriber>();
const statusListeners = new Set<(live: boolean) => void>();

let running = false;
let live = false;
/** 断开当前连接。"stop" = 不再连；"restart" = 马上用新令牌重连 */
let abortCurrent: ((mode: "stop" | "restart") => void) | null = null;
let wakeSleep: (() => void) | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
/** 因为登录失效停下时用的那张令牌；令牌变了才重新连 */
let stoppedForToken: string | null = null;
let globalListenersInstalled = false;

function setLive(next: boolean): void {
  if (live === next) return;
  live = next;
  for (const listener of statusListeners) listener(next);
}

function fire(sub: Subscriber): void {
  if (sub.timer) return;
  sub.timer = setTimeout(() => {
    sub.timer = null;
    if (!subscribers.has(sub)) return;
    try {
      sub.callback();
    } catch {
      /* 页面自己的重拉出错不影响别人 */
    }
  }, DEBOUNCE_MS);
}

function dispatch(topics: RealtimeTopic[]): void {
  for (const sub of subscribers) {
    if (topics.some((t) => sub.topics.has(t))) fire(sub);
  }
}

/** 刚连上：订阅得比较早的页面补拉一次（断线期间 / 页面加载到连上之间的变化） */
function resyncAfterConnect(connectedAt: number): void {
  for (const sub of subscribers) {
    if (sub.since < connectedAt - FRESH_SUBSCRIBE_MS) fire(sub);
  }
}

function currentToken(): string | null {
  return getOptionalSession()?.token ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      wakeSleep = null;
      resolve();
    }
    wakeSleep = done;
  });
}

/** 处理一段 SSE 消息（两个换行之间那一块）。返回 "auth" 表示服务器说登录失效了 */
function handleBlock(block: string): "auth" | void {
  let eventName = "message";
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return;
  let data: unknown;
  try {
    data = JSON.parse(dataLines.join("\n"));
  } catch {
    return;
  }
  if (eventName === "bye") {
    const reason = String((data as { reason?: unknown })?.reason ?? "");
    return reason.startsWith("auth:") ? "auth" : undefined;
  }
  const topics = (data as { t?: unknown })?.t;
  if (Array.isArray(topics)) dispatch(topics.filter((t): t is RealtimeTopic => typeof t === "string") as RealtimeTopic[]);
}

/** 连一次，直到断开。返回 "auth" = 登录失效别再连；"stop" = 没人订阅了 / 主动停；"retry" = 断了要等一会儿重连；"restart" = 换令牌马上重连 */
async function connectOnce(token: string): Promise<"auth" | "stop" | "retry" | "restart"> {
  const controller = new AbortController();
  let ended: "stop" | "restart" | null = null;
  abortCurrent = (mode) => {
    ended = mode;
    controller.abort();
  };
  const afterDrop = (): "stop" | "retry" | "restart" => ended ?? "retry";
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  const kick = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => controller.abort(), WATCHDOG_MS);
  };
  try {
    kick();
    const response = await fetch(REALTIME_PATH, {
      headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) return "auth";
    if (!response.ok || !response.body) return afterDrop();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let connected = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      kick();
      if (!connected) {
        connected = true;
        retryDelay = 1000;
        setLive(true);
        resyncAfterConnect(Date.now());
      }
      buffer += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, "");
        if (handleBlock(block) === "auth") return "auth";
      }
    }
    return afterDrop();
  } catch {
    return afterDrop();
  } finally {
    if (watchdog) clearTimeout(watchdog);
    abortCurrent = null;
    setLive(false);
  }
}

let retryDelay = 1000;

async function runLoop(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (subscribers.size > 0) {
      const token = currentToken();
      if (!token || token === stoppedForToken) return; // 没登录 / 这张令牌已经被拒过
      const outcome = await connectOnce(token);
      if (outcome === "auth") {
        stoppedForToken = token;
        return;
      }
      if (outcome === "stop" || subscribers.size === 0) return;
      if (outcome === "restart") {
        retryDelay = 1000;
        continue;
      }
      // 断了：等一会儿再连（带点随机，别让所有人在同一秒一起敲门，比如服务器刚重启）
      await sleep(retryDelay * (0.7 + Math.random() * 0.6));
      retryDelay = Math.min(retryDelay * 2, 30_000);
    }
  } finally {
    running = false;
  }
}

/** 有人订阅、或者网络 / 登录 / 前后台变了：该连就连，正在等重连的就别等了 */
function ensureRunning(): void {
  if (typeof window === "undefined" || subscribers.size === 0) return;
  const token = currentToken();
  if (token && token !== stoppedForToken) stoppedForToken = null;
  if (running) {
    if (!live && wakeSleep) {
      retryDelay = 1000;
      wakeSleep();
    }
    return;
  }
  void runLoop();
}

function installGlobalListeners(): void {
  if (globalListenersInstalled || typeof window === "undefined") return;
  globalListenersInstalled = true;
  window.addEventListener("online", ensureRunning);
  window.addEventListener("focus", ensureRunning);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") ensureRunning();
  });
  // 别的标签页重新登录 / 退出：令牌换了，这边跟着换
  window.addEventListener("storage", (event) => {
    if (event.key !== AUTH_SESSION_STORAGE_KEY) return;
    if (abortCurrent) abortCurrent("restart");
    else ensureRunning();
  });
}

/**
 * 订阅某几类变化。返回退订函数（组件卸载时调）。
 * callback 会在这几类有变化、或者断线重连之后被调用（200 毫秒内的多次合成一次）。
 */
export function subscribeRealtime(topics: readonly RealtimeTopic[], callback: () => void): () => void {
  const sub: Subscriber = { topics: new Set(topics), callback, since: Date.now(), timer: null };
  subscribers.add(sub);
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  installGlobalListeners();
  ensureRunning();
  return () => {
    if (sub.timer) clearTimeout(sub.timer);
    subscribers.delete(sub);
    if (subscribers.size === 0 && !idleTimer) {
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (subscribers.size === 0) abortCurrent?.("stop");
      }, IDLE_CLOSE_MS);
    }
  };
}

/** 现在实时连接通不通（通的时候页面可以把兜底轮询放慢） */
export function isRealtimeLive(): boolean {
  return live;
}

export function onRealtimeStatus(listener: (live: boolean) => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}
