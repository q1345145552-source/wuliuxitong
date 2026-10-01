/**
 * 新消息提示音（2026-10-02 老板：「还要有消息提示音」）。客户、员工、超管三边都响，只对「对方」发来的响。
 *
 * 谁来报「有新消息」：
 *   · 左边菜单的未读数（useChatUnread，网页切到后台也照样问；后台浏览器会放慢，最慢约一分钟一次）—— 不在聊天页、或者网页在后台时靠它；
 *   · 聊天窗口的 3 秒轮询（ChatThread）—— 正开着这个对话时靠它，不用等菜单那半分钟。
 *
 * 同一条只响一次：按**对话**分开记「这个对话里对方最新一条，已经报到哪了」（对话 = 客户那头就一个「client」；
 * 员工那头是客户唛头）。同一个对话里消息按时间往后走，所以「不比记下的新 = 已经报过」。
 *   ⚠️ 不能整个系统共用一个时间（dsh 第二轮复查 2026-10-02）：客户甲 01:00:10 那条刚响过，
 *      客户乙 01:00:05 那条没人看过，拿一个全局时间一比就被当成「报过了」，一声不响、红点却亮着。
 * **开着好几个标签页也只响一次**（dsh 复查）：这份记录同时写进 localStorage，同一个浏览器的标签页共用；
 *   谁先看到新消息谁响，别的标签页看到这个对话已经有人报过就不响。
 *
 * 声音用 Web Audio 现场合成一声「叮咚」，不用下载音频文件。
 * ⚠️ 浏览器规定：网页打开后，人得先在页面上点一下或按一下键，网页才允许出声 ——
 *    所以这里在第一次点击 / 按键时把声音通道打开（installChatSoundUnlock）。刚打开、一下都没点过的那段时间来消息，响不了。
 */

type AudioCtxCtor = new () => AudioContext;
/** 对话 → 对方最新一条已经报到的时间（ISO 字符串，同一格式可以直接比大小） */
type Seen = Record<string, string>;

let ctx: AudioContext | null = null;
let unlockInstalled = false;
let lastPlayedAt = 0;
/** 1 秒内又要响：不丢，等满 1 秒补响一声（dsh 复查：原来直接丢掉，前后脚来的第二条永远不响） */
let pendingTimer: number | null = null;
/** 这个标签页自己的记录 */
let announced: Seen = {};
/** 菜单未读数第一次取回来时只记下、不响：打开网页时就已经躺着的未读，不算「新来的」 */
let unreadBaselineDone = false;
/** 同一个浏览器各标签页共用的记录（v1 是全局一个时间，有上面说的毛病，换个名字不读它） */
const SHARED_KEY = "xt_chat_ding_v2";
/** 共用记录最多记这么多个对话（按时间留最新的），免得越攒越大 */
const SHARED_MAX = 300;

function audioCtor(): AudioCtxCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: AudioCtxCtor; webkitAudioContext?: AudioCtxCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function ensureContext(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = audioCtor();
  if (!Ctor) return null;
  try { ctx = new Ctor(); } catch { ctx = null; }
  return ctx;
}

/** 第一次点击 / 按键时把声音通道打开（浏览器不让网页一打开就出声）。装一次就够，重复调用没事 */
export function installChatSoundUnlock(): void {
  if (unlockInstalled || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  unlockInstalled = true;
  const unlock = () => {
    const c = ensureContext();
    if (c && c.state === "suspended") void c.resume().catch(() => { /* 不让开就算了 */ });
  };
  window.addEventListener("pointerdown", unlock, true);
  window.addEventListener("keydown", unlock, true);
}

function readShared(): Seen {
  try {
    const raw = window.localStorage.getItem(SHARED_KEY);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Seen) : {};
  } catch {
    return {};
  }
}

function writeShared(seen: Seen): void {
  try {
    let entries = Object.entries(seen);
    if (entries.length > SHARED_MAX) entries = entries.sort((a, b) => (a[1] < b[1] ? 1 : -1)).slice(0, SHARED_MAX);
    window.localStorage.setItem(SHARED_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* 记不下就算了（隐私模式、被禁）：当只有这一个标签页 */ }
}

/**
 * 这个对话这条（时间 at）该不该由这个标签页来响：别的标签页已经把**这个对话**报到 at 或更晚就不响；否则记下、由我来响。
 * localStorage 用不了就当只有这一个标签页。
 */
function claimShared(conv: string, at: string): boolean {
  const seen = readShared();
  if ((seen[conv] ?? "") >= at) return false;
  seen[conv] = at;
  writeShared(seen);
  return true;
}

/** 记下「这个对话看到这一条了」（不响）：别的标签页随后取到它也别响 */
function markShared(conv: string, at: string): void {
  const seen = readShared();
  if ((seen[conv] ?? "") < at) {
    seen[conv] = at;
    writeShared(seen);
  }
}

/** 响一声「叮咚」。两声至少隔 1 秒：1 秒内又来一声，等满 1 秒再补响（不丢） */
export function playChatDing(): void {
  const now = Date.now();
  const wait = 1000 - (now - lastPlayedAt);
  if (wait > 0) {
    if (pendingTimer === null && typeof window !== "undefined" && typeof window.setTimeout === "function") {
      pendingTimer = window.setTimeout(() => { pendingTimer = null; playChatDing(); }, wait);
    }
    return;
  }
  const c = ensureContext();
  if (!c) return;
  lastPlayedAt = now;
  try {
    if (c.state === "suspended") void c.resume().catch(() => { /* 没点过页面，浏览器不让响 */ });
    const t0 = c.currentTime + 0.01;
    const tone = (freq: number, start: number, dur: number) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(start);
      osc.stop(start + dur + 0.02);
    };
    tone(1046.5, t0, 0.16); // 叮
    tone(1318.5, t0 + 0.14, 0.24); // 咚
  } catch {
    /* 出声失败不影响聊天 */
  }
}

/** 这个对话来了比记下的新的一条：记下；这个标签页抢到了（别的标签页还没为它响）就返回 true */
function arrived(conv: string, at: string | null | undefined): boolean {
  if (!at || at <= (announced[conv] ?? "")) return false;
  announced[conv] = at;
  return claimShared(conv, at);
}

/**
 * 菜单未读数取回来了：latest = 每个有未读的对话，对方最新一条没看的时间。
 * 第一次只记下（打开网页前就有的不算新）；以后哪个对话有比记下的新的，就响（一次取回来最多响一声）。
 */
export function noteUnreadLatest(latest: Record<string, string | null | undefined> | null | undefined): void {
  const entries = Object.entries(latest ?? {});
  if (!unreadBaselineDone) {
    unreadBaselineDone = true;
    for (const [conv, at] of entries) if (at && at > (announced[conv] ?? "")) announced[conv] = at;
    return;
  }
  let ring = false;
  for (const [conv, at] of entries) if (arrived(conv, at)) ring = true;
  if (ring) playChatDing();
}

/** 打开一个对话时拿到的那一页旧消息：只记下、不响（人已经在看了，也不是新来的）；别的标签页也别为它响 */
export function noteIncomingShown(conv: string, latestAt: string | null | undefined): void {
  if (!latestAt) return;
  if (latestAt > (announced[conv] ?? "")) announced[conv] = latestAt;
  markShared(conv, latestAt);
}

/** 聊天窗口轮询拿到了这个对话里对方新发来的：比记下的新、别的标签页也还没为它响过，就响 */
export function noteIncomingArrived(conv: string, latestAt: string | null | undefined): void {
  if (arrived(conv, latestAt)) playChatDing();
}

/** 只给测试用：把记下的状态清掉（一个测试进程里跑好几轮） */
export function resetChatSoundForTest(): void {
  ctx = null;
  unlockInstalled = false;
  lastPlayedAt = 0;
  if (pendingTimer !== null) { try { window.clearTimeout(pendingTimer); } catch { /* 测试里的假定时器 */ } }
  pendingTimer = null;
  announced = {};
  unreadBaselineDone = false;
}
