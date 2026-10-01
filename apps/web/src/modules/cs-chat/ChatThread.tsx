"use client";

/**
 * 聊天窗口（2026-09-28，老板：「是直接类似微信的对话功能」「只要文字信息就行了，然后也可以发图片」）。
 * 客户的「在线客服」和员工 / 超管的「客户消息」共用这一个组件（CLAUDE.md 第 20 条：别两边各写一套）。
 *
 * 像微信的地方：自己的在右（绿）、对方的在左（白）；
 * 回车发送、Shift+回车换行；能点「图片」选图，也能直接 Ctrl+V 粘贴截图；图片点开看大图；
 * 往上翻到头点「更早的消息」；翻上去看旧消息时来了新的，底下冒一个「有新消息」不强行拉下去。
 *
 * 消息靠轮询：窗口开着、页面在前台时每 3 秒取一次比手里最新那条还新的（后端往前多给 5 秒，这里按 id 去重）。
 * 看到对方的新消息就标已读，并通知左边菜单的红点马上刷新（CHAT_UNREAD_EVENT）。
 *
 * 2026-10-02 老板：「直接显示已读，每条信息都显示，类似 LINE 那种。然后每个信息都单独显示时间」「还要有消息提示音」——
 *   · 每条气泡旁边写发送时间（时:分，北京时间）；跨天的地方中间插一行「今天 / 昨天 / 9月28日 周一」；
 *   · 我方发的（客户看 = 自己发的；客服看 = 任何一个员工 / 超管发的），对方看过了就在时间上面写「已读」，没看过什么都不写（LINE 就这样）；
 *     「对方看到哪」用的是后端早就记着的 client_read_at / staff_read_at（随每次取消息一起回来，3 秒内跟着变）；
 *   · 轮询拿到对方新发来的就「叮咚」一声（chat-sound.ts，跟左边菜单共用一份记录，同一条不响两次）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import {
  CHAT_UNREAD_EVENT,
  fetchChatMessages,
  markChatRead,
  mergeChatMessages,
  sendChatMessage,
  type ChatMessage,
  type ChatScope,
} from "../../services/cs-chat-api";
import { compressImageForUpload } from "../shared/image-compress";
import { createRequestGate } from "../shared/request-gate";
import { installChatSoundUnlock, noteIncomingArrived, noteIncomingShown } from "./chat-sound";

export { CHAT_UNREAD_EVENT };
/** 轮询间隔（毫秒）。老板要「像微信」，窗口开着时 3 秒一次，对方的消息 3 秒内出来 */
export const CHAT_POLL_MS = 3000;
/** 跟后端 CS_MAX_TEXT 一致 */
const MAX_TEXT = 2000;

function notifyUnreadChanged(): void {
  try { window.dispatchEvent(new Event(CHAT_UNREAD_EVENT)); } catch { /* 老浏览器没有 Event 构造函数就算了 */ }
}

/* 时间都按北京时间（跟物流轨迹、导出文件名一个口径：泰国客户和员工看到的一样） */
const BJ = "Asia/Shanghai";
/** 北京时间的「2026-09-28」，拿来判断是不是同一天。按部件拼（不靠某个语言恰好输出 年-月-日 的格式，dsh 复查） */
function bjDayKey(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: BJ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
/** 每条气泡旁边的时间：时:分（hourCycle 写死 h23：有的浏览器 hour12:false 会把零点写成 24:05） */
function hmLabel(iso: string): string {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: BJ, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}
/** 跨天时中间那一行：今天 / 昨天 / 9月28日 周一；不是今年的带年份 */
function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const key = bjDayKey(d);
  const today = bjDayKey(now);
  if (key === today) return "今天";
  if (key === bjDayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000))) return "昨天";
  const [y, m, day] = key.split("-").map(Number);
  const week = new Intl.DateTimeFormat("zh-CN", { timeZone: BJ, weekday: "short" }).format(d);
  return String(y) === today.slice(0, 4) ? `${m}月${day}日 ${week}` : `${y}年${m}月${day}日 ${week}`;
}
/** 鼠标停在气泡上看到的完整时间 */
function fullTimeLabel(iso: string): string {
  return `${bjDayKey(new Date(iso))} ${hmLabel(iso)}`;
}

/** 一批消息里最新那条的时间（ISO 字符串可以直接比大小）；没有比 fallback 新的就还是 fallback */
function latestCreatedAt(list: ChatMessage[], fallback: string): string {
  let latest = fallback;
  for (const m of list) if (m.createdAt > latest) latest = m.createdAt;
  return latest;
}

function scopeKey(scope: ChatScope): string {
  return scope.kind === "client" ? "client" : `staff:${scope.clientId}`;
}

/** 「我方」是哪一边：客户那头是 client；员工 / 超管那头是 cs（共用收件箱，别的员工发的也算我方） */
function ourSide(scope: ChatScope): "client" | "cs" {
  return scope.kind === "client" ? "client" : "cs";
}

/** 提示音按对话分开记：客户那头只有一个对话「client」；员工那头按客户唛头（跟左边菜单未读的 latestByClient 同一个叫法） */
function soundConv(scope: ChatScope): string {
  return scope.kind === "client" ? "client" : scope.clientId;
}

/** 一批消息里对方发的最新那条的时间（没有就空串） */
function latestIncoming(list: ChatMessage[], scope: ChatScope): string {
  const side = ourSide(scope);
  return latestCreatedAt(list.filter((m) => m.side !== side), "");
}

export default function ChatThread(props: {
  scope: ChatScope;
  /** 窗口上方的标题（客户那边是「客服」，员工那边是客户唛头） */
  title: string;
  /** 输入框里的提示字 */
  placeholder?: string;
  /** 不能再发（比如这个客户后来被划到代理名下了）：只能看记录 */
  closedNotice?: string;
  /** 发出去一条之后（员工那边拿来刷新左边的对话列表） */
  onSent?: () => void;
  /** 员工「客户消息」在手机上一次只显示一栏：给了这个，标题左边出一个「‹ 返回」回客户列表（宽屏靠样式藏掉） */
  onBack?: () => void;
}) {
  const { scope, title, placeholder, closedNotice, onSent, onBack } = props;
  const key = scopeKey(scope);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [newBelow, setNewBelow] = useState(false);
  /** 对方看到了哪一刻（ISO）：我方发的、不晚于它的显示「已读」；空串 = 还没看过 */
  const [peerReadAt, setPeerReadAt] = useState("");
  /** 首次取消息失败后重取（点「重试」或 5 秒后自己再试）：原来失败一次窗口就一直是死的（2026-09-28 分支审查） */
  const [reloadTick, setReloadTick] = useState(0);
  /** 自己重试了几次：最多 3 次（唛头输错这种一直会错的，别每 5 秒闪一次「加载中」）；换对话清零 */
  const autoRetryRef = useRef(0);

  const listRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const composingRef = useRef(false);
  /** 当前是哪个对话：换了对话，旧对话晚到的响应一律丢掉（用法二：认主人） */
  const keyRef = useRef(key);
  keyRef.current = key;
  const gate = useRef(createRequestGate()).current;
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;
  /** 最后一次拿到的服务器时间（对话是空的时候轮询拿它当起点） */
  const serverTimeRef = useRef<string>("");
  /**
   * 轮询从哪条之后取：只认「从服务器取回来的」最新一条，自己刚发出去的不算（2026-09-28 分支审查）。
   * 原来取列表最后一条 —— 轮询断了几秒、恢复后赶在下一轮之前自己发了一句，起点就跳到自己这句，
   * 对方在断网那几秒发的消息落在「往前多取 5 秒」之外，这个窗口里永远不出来。
   */
  const pollSinceRef = useRef<string>("");
  const stickToBottomRef = useRef(true);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  /** 已经成功标过已读的「对方最后一条」的时间：标失败了下一轮会再标；翻上去看旧消息时不标 */
  const lastMarkedRef = useRef("");
  /**
   * 手里这批消息是哪个对话的（取回来那一刻记下）。换对话时，「已经按新客户画了一帧、清空旧消息的 effect 还没跑」
   * 那一瞬间手里还是上一个客户的消息 —— 这时窗口正好获得焦点，会拿上一个客户的时间去标新客户的已读
   * （dsh 第二轮复查 2026-10-02）。对不上就不标。
   */
  const loadedKeyRef = useRef("");

  const nearBottom = () => {
    const el = listRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  const scrollToBottom = () => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    stickToBottomRef.current = true;
    setNewBelow(false);
  };

  /**
   * 看到了对方的消息：标已读。几个条件都要满足才算「看到了」：
   *   · 页面在前台（切到别的标签页不算）；
   *   · 这个浏览器窗口是当前窗口（2026-10-02 dsh 复查：现在「已读」要显示给对方看了 —— 浏览器摆在屏幕边上、
   *     人在别的软件里干活，原来也照标，对方看到「已读」却没人回。跟 LINE 电脑版一样，点回这个窗口才算看了）；
   *   · 停在最底下（2026-09-28 Codex 复核第 5 条：往上翻看旧消息时来了新的，只冒「有新消息」，
   *     不能标已读 —— 共用收件箱，一标所有员工的红点都没了，容易漏回）；
   *   · 比上次标过的新（标失败了下一轮会再来，Codex 复核第 6 条）。
   */
  const markSeen = useCallback((list: ChatMessage[]) => {
    if (loadedKeyRef.current !== keyRef.current) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    if (typeof document !== "undefined" && typeof document.hasFocus === "function" && !document.hasFocus()) return;
    if (!stickToBottomRef.current) return;
    const lastOther = [...list].reverse().find((m) => !m.mine);
    if (!lastOther || lastOther.createdAt <= lastMarkedRef.current) return;
    const forKey = keyRef.current;
    const upTo = lastOther.createdAt;
    markChatRead(scopeRef.current, upTo)
      .then(() => {
        if (keyRef.current !== forKey) return;
        if (upTo > lastMarkedRef.current) lastMarkedRef.current = upTo;
        notifyUnreadChanged();
      })
      .catch(() => { /* 标已读失败不打扰人，下一轮轮询会再标 */ });
  }, []);

  useEffect(() => { autoRetryRef.current = 0; }, [key]);
  // 浏览器要人先点一下页面才让出声：第一次点击 / 按键时把声音通道打开
  useEffect(() => { installChatSoundUnlock(); }, []);
  // 点回这个窗口（从别的软件切回来）：马上补标已读，不用等下一轮轮询
  useEffect(() => {
    const onFocus = () => markSeen(messagesRef.current);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [markSeen]);
  /* 过了零点重画一次（dsh 复查）：日期行「今天 / 昨天」是画的时候算的，页面开着过夜、又没来新消息，
     昨天的消息会一直写「今天」。每分钟看一眼北京日期变没变，变了才重画 */
  const [, setDayTick] = useState(0);
  useEffect(() => {
    let shownDay = bjDayKey(new Date());
    const timer = window.setInterval(() => {
      const today = bjDayKey(new Date());
      if (today !== shownDay) { shownDay = today; setDayTick((n) => n + 1); }
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // 换对话：清空、重新取最近 50 条
  useEffect(() => {
    let cancelled = false;
    const ticket = gate.begin();
    setMessages([]);
    setHasMore(false);
    setLoading(true);
    setLoadError("");
    setSendError("");
    setNewBelow(false);
    setPeerReadAt("");
    serverTimeRef.current = "";
    pollSinceRef.current = "";
    stickToBottomRef.current = true;
    lastMarkedRef.current = "";
    loadedKeyRef.current = "";
    const forKey = key;
    fetchChatMessages(scopeRef.current)
      .then((page) => {
        if (cancelled || !gate.isCurrent(ticket)) return;
        loadedKeyRef.current = forKey;
        setMessages(page.messages);
        setHasMore(page.hasMore);
        setPeerReadAt(page.peerReadAt ?? "");
        serverTimeRef.current = page.serverTime;
        pollSinceRef.current = latestCreatedAt(page.messages, "");
        // 打开对话时就有的对方消息：只记下、不响（不是新来的）
        noteIncomingShown(soundConv(scopeRef.current), latestIncoming(page.messages, scopeRef.current));
        markSeen(page.messages);
      })
      .catch((e: unknown) => {
        if (cancelled || !gate.isCurrent(ticket)) return;
        setLoadError(e instanceof Error ? e.message : "加载失败");
      })
      .finally(() => {
        if (!cancelled && gate.isCurrent(ticket)) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [key, gate, markSeen, reloadTick]);

  // 首次取消息失败：5 秒后自己再试一次（断网、服务器正在重启这种一会儿就好的情况）
  useEffect(() => {
    if (!loadError || autoRetryRef.current >= 3) return;
    const timer = window.setTimeout(() => { autoRetryRef.current += 1; setReloadTick((n) => n + 1); }, 5000);
    return () => window.clearTimeout(timer);
  }, [loadError]);

  // 轮询新消息
  useEffect(() => {
    if (loading || loadError) return;
    let stopped = false;
    const forKey = key;
    const tick = async () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      const since = pollSinceRef.current || serverTimeRef.current;
      if (!since) return;
      try {
        const page = await fetchChatMessages(scopeRef.current, { since });
        if (stopped || keyRef.current !== forKey) return;
        serverTimeRef.current = page.serverTime;
        pollSinceRef.current = latestCreatedAt(page.messages, pollSinceRef.current);
        // 对方看到哪：只往前走（每轮都带回来，对方一看过，3 秒内这边就变「已读」）
        const peer = page.peerReadAt;
        if (peer) setPeerReadAt((cur) => (peer > cur ? peer : cur));
        const before = messagesRef.current;
        // 对方新发来的（这一轮才出现的）：响一声。往前多取的那 5 秒里的旧消息、我方自己发的都不算
        const known = new Set(before.map((m) => m.id));
        noteIncomingArrived(soundConv(scopeRef.current), latestIncoming(page.messages.filter((m) => !known.has(m.id)), scopeRef.current));
        const merged = mergeChatMessages(before, page.messages);
        if (merged !== before) {
          stickToBottomRef.current = nearBottom();
          if (!stickToBottomRef.current) setNewBelow(true);
          setMessages(merged);
        }
        // 没有新消息也调一次：上一轮标已读失败的，这一轮补上（停在底部、在前台才真标）
        markSeen(merged);
      } catch {
        /* 断网 / 服务器重启：这一轮算了，下一轮接着取 */
      }
    };
    const timer = window.setInterval(() => { void tick(); }, CHAT_POLL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [key, loading, loadError, markSeen]);

  // 新消息进来、原本就在底部 → 跟着滚到底；首次加载完直接到底
  useLayoutEffect(() => {
    if (stickToBottomRef.current) scrollToBottom();
  }, [messages]);

  const loadOlder = async () => {
    if (loadingOlder || messages.length === 0) return;
    const forKey = key;
    const el = listRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    setLoadingOlder(true);
    try {
      const page = await fetchChatMessages(scopeRef.current, { before: messages[0].createdAt });
      if (keyRef.current !== forKey) return;
      stickToBottomRef.current = false;
      setMessages((cur) => mergeChatMessages(cur, page.messages));
      setHasMore(page.hasMore);
      // 往上补了内容：保持眼前这条不动（跟微信一样，不跳）
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - prevHeight;
      });
    } catch (e) {
      if (keyRef.current === forKey) setSendError(e instanceof Error ? `更早的消息没取到：${e.message}` : "更早的消息没取到");
    } finally {
      if (keyRef.current === forKey) setLoadingOlder(false);
    }
  };

  /** restoreText：发文字时输入框已经先清空了，没发出去就把原话放回去（框里要是已经又打了别的字就不动） */
  const send = async (input: { content?: string; file?: File; restoreText?: string }) => {
    if (sending || closedNotice) return;
    const forKey = key;
    setSending(true);
    setSendError("");
    try {
      const image = input.file ? await compressImageForUpload(input.file) : undefined;
      const r = await sendChatMessage(scopeRef.current, { content: input.content, image });
      if (keyRef.current !== forKey) return;
      stickToBottomRef.current = true;
      setMessages((cur) => mergeChatMessages(cur, [r.message]));
      notifyUnreadChanged();
      onSent?.();
    } catch (e) {
      if (keyRef.current === forKey) {
        setSendError(e instanceof Error ? `没发出去：${e.message}` : "没发出去，请重试");
        // 框里空着就原样放回；已经接着打了别的字，就把没发出去的那句放在前面，两句都留着（Codex 复看第 7 条：原来直接丢了）
        const restore = input.restoreText;
        if (restore !== undefined) setText((cur) => (cur.trim() === "" ? restore : `${restore}\n${cur}`));
      }
    } finally {
      if (keyRef.current === forKey) setSending(false);
    }
  };

  const sendText = () => {
    // 上一条还在发：不动输入框（原来这时按回车什么也不做，照旧）
    if (sending || closedNotice) return;
    const content = text.trim();
    if (!content) return;
    if (content.length > MAX_TEXT) { setSendError(`一条最多 ${MAX_TEXT} 个字，请分几条发`); return; }
    /* 像微信：一按发送输入框马上清空，接着打下一句（2026-09-28 分支审查）。原来发成功后才整框清空，
       发送途中接着打的字会被一起清掉。没发出去再把原话放回来。 */
    const typed = text;
    setText("");
    void send({ content, restoreText: typed });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 中文输入法选字时按的回车不能当发送（composingRef / isComposing 两道都看，Safari 的 isComposing 不准）。
    // Safari 是先发 compositionend、后发这次回车的 keydown，前两道都放行 —— 这时 keyCode 是 229，再挡一道
    // （2026-09-28 分支审查；ShipmentSearch、客户首页、登录页早就这么挡了）
    if (e.key === "Enter" && !e.shiftKey && !composingRef.current && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
      e.preventDefault();
      sendText();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
    if (!file) return;
    e.preventDefault();
    // 上一条还在发：说一声，不能悄悄吞掉（2026-09-28 分支审查；「图片」按钮这时是灰的，粘贴这条路原来没提示）
    if (sending) { setSendError("上一条还在发送，等发完再粘贴图片"); return; }
    void send({ file });
  };

  const side = ourSide(scope);
  let lastDay = "";
  return (
    <div className="cs-chat" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--s-sunken)", borderRadius: 10, border: "1px solid var(--l-soft)", overflow: "hidden" }}>
      <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--l-soft)", background: "var(--white)", fontWeight: 600, fontSize: 15, color: "var(--t-heading)", display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        {onBack ? (
          <button type="button" className="cs-inbox-back" onClick={onBack} aria-label="返回客户列表"
            style={{ border: "1px solid var(--l-strong)", borderRadius: 6, background: "var(--white)", padding: "3px 10px", fontSize: 13, color: "var(--t-strong)", cursor: "pointer", flexShrink: 0 }}>
            ‹ 返回
          </button>
        ) : null}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
      </div>

      <div
        ref={listRef}
        onScroll={() => {
          stickToBottomRef.current = nearBottom();
          if (stickToBottomRef.current) {
            setNewBelow(false);
            // 翻回到底了 = 新消息看到了，这时再标已读
            markSeen(messagesRef.current);
          }
        }}
        style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 14px", position: "relative" }}
        aria-live="polite"
      >
        {loading ? <div style={{ textAlign: "center", color: "var(--t-faint)", fontSize: 13, padding: 24 }}>加载中…</div> : null}
        {loadError ? (
          <div style={{ textAlign: "center", color: "var(--c-red-deep)", fontSize: 13, padding: 24 }}>
            消息没取到：{loadError}
            <div style={{ marginTop: 8 }}>
              <button type="button" onClick={() => setReloadTick((n) => n + 1)}
                style={{ border: "1px solid var(--l-strong)", borderRadius: 6, background: "var(--white)", padding: "4px 14px", fontSize: 12, color: "var(--t-strong)", cursor: "pointer" }}>
                重试
              </button>
              {autoRetryRef.current < 3 ? <span style={{ marginLeft: 8, color: "var(--t-faint)", fontSize: 12 }}>（几秒后也会自己再试）</span> : null}
            </div>
          </div>
        ) : null}
        {!loading && !loadError && hasMore ? (
          <div style={{ textAlign: "center", marginBottom: 10 }}>
            <button type="button" onClick={() => void loadOlder()} disabled={loadingOlder}
              style={{ border: "none", background: "transparent", color: "var(--c-blue)", cursor: "pointer", fontSize: 12 }}>
              {loadingOlder ? "加载中…" : "查看更早的消息"}
            </button>
          </div>
        ) : null}
        {!loading && !loadError && messages.length === 0 ? (
          <div style={{ textAlign: "center", color: "var(--t-faint)", fontSize: 13, padding: 24 }}>还没有消息，发一句试试</div>
        ) : null}
        {messages.map((m) => {
          const day = bjDayKey(new Date(m.createdAt));
          const showDay = day !== lastDay;
          lastDay = day;
          const read = m.side === side && peerReadAt !== "" && m.createdAt <= peerReadAt;
          return (
            <div key={m.id}>
              {showDay ? (
                <div style={{ textAlign: "center", margin: "10px 0 8px" }}>
                  <span style={{ fontSize: 11, color: "var(--t-faint)" }}>{dayLabel(m.createdAt)}</span>
                </div>
              ) : null}
              <div style={{ display: "flex", flexDirection: "column", alignItems: m.mine ? "flex-end" : "flex-start", marginBottom: 10 }}>
                {!m.mine ? <div style={{ fontSize: 11, color: "var(--t-muted)", margin: "0 4px 3px" }}>{m.senderLabel}</div> : null}
                {/* 气泡 + 旁边的「已读 / 时间」：自己的在气泡左边、对方的在气泡右边，贴着气泡底（LINE 的样子） */}
                <div style={{ display: "flex", flexDirection: m.mine ? "row-reverse" : "row", alignItems: "flex-end", gap: 5, maxWidth: "min(84%, 600px)" }}>
                  <div
                    style={{
                      minWidth: 0,
                      padding: m.content ? "8px 11px" : 4,
                      borderRadius: 8,
                      background: m.mine ? "var(--c-green-bg)" : "var(--white)",
                      border: `1px solid ${m.mine ? "var(--c-green-2)" : "var(--l-soft)"}`,
                      color: "var(--t-body)",
                      fontSize: 14,
                      lineHeight: 1.55,
                      whiteSpace: "pre-wrap",
                      overflowWrap: "anywhere",
                    }}
                    title={fullTimeLabel(m.createdAt)}
                  >
                    {m.imageUrl ? (
                      /* 220 的上限放在按钮上、图片只写 100%（2026-09-28 手机实测）：原来上限写在图片上，
                         手机屏窄、气泡只有 200 来宽，横图照样撑到 220，伸出聊天框右边、消息区多出横向滚动条。
                         这样写电脑上跟原来一模一样（横图 220 宽、竖图按高 220 缩），手机上跟着气泡缩。 */
                      <button type="button" onClick={() => setPreview(m.imageUrl)} style={{ display: "block", maxWidth: 220, padding: 0, border: "none", background: "transparent", cursor: "zoom-in" }} aria-label="看大图">
                        <img src={m.imageUrl} alt="图片" onLoad={() => { if (stickToBottomRef.current) scrollToBottom(); }} style={{ display: "block", maxWidth: "100%", maxHeight: 220, borderRadius: 6 }} />
                      </button>
                    ) : null}
                    {m.content ? <div style={m.imageUrl ? { marginTop: 6, padding: "0 7px 4px" } : undefined}>{m.content}</div> : null}
                  </div>
                  <div className="cs-msg-meta" style={{ display: "flex", flexDirection: "column", alignItems: m.mine ? "flex-end" : "flex-start", flexShrink: 0, fontSize: 11, lineHeight: 1.35, color: "var(--t-faint)", whiteSpace: "nowrap" }}>
                    {read ? <span style={{ color: "var(--t-muted)" }}>已读</span> : null}
                    <span>{hmLabel(m.createdAt)}</span>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {newBelow ? (
        <div style={{ position: "relative" }}>
          <button type="button" onClick={scrollToBottom}
            style={{ position: "absolute", right: 16, bottom: 8, border: "1px solid var(--l-soft)", borderRadius: 14, background: "var(--white)", color: "var(--c-green-deep)", fontSize: 12, padding: "4px 12px", cursor: "pointer", boxShadow: "var(--shadow-sm)" }}>
            有新消息 ↓
          </button>
        </div>
      ) : null}

      {closedNotice ? (
        <div style={{ padding: "12px 16px", borderTop: "1px solid var(--l-soft)", background: "var(--white)", fontSize: 13, color: "var(--t-muted)" }}>{closedNotice}</div>
      ) : (
        <div style={{ borderTop: "1px solid var(--l-soft)", background: "var(--white)", padding: "8px 12px 10px" }}>
          {sendError ? <div role="alert" style={{ color: "var(--c-red-deep)", fontSize: 12, marginBottom: 6 }}>{sendError}</div> : null}
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <button type="button" onClick={() => fileRef.current?.click()} disabled={sending || loading || !!loadError}
              style={{ border: "1px solid var(--l-strong)", borderRadius: 6, background: "var(--white)", padding: "8px 10px", cursor: "pointer", fontSize: 13, color: "var(--t-strong)", flexShrink: 0 }}
              title="发图片（也可以直接 Ctrl+V 粘贴截图）">
              图片
            </button>
            <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void send({ file: f }); }} />
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={() => { composingRef.current = false; }}
              placeholder={placeholder ?? "输入消息，回车发送，Shift+回车换行"}
              rows={2}
              maxLength={MAX_TEXT}
              disabled={loading || !!loadError}
              aria-label="输入消息"
              style={{ flex: 1, resize: "none", border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 10px", fontSize: 14, lineHeight: 1.5, minHeight: 42, maxHeight: 140, fontFamily: "inherit" }}
            />
            <button type="button" onClick={sendText} disabled={sending || loading || !!loadError || !text.trim()}
              style={{ border: "none", borderRadius: 6, background: sending || !text.trim() ? "var(--t-faint)" : "var(--c-green-3)", color: "var(--white)", padding: "9px 16px", cursor: sending || !text.trim() ? "default" : "pointer", fontSize: 14, fontWeight: 600, flexShrink: 0 }}>
              {sending ? "发送中" : "发送"}
            </button>
          </div>
        </div>
      )}

      {preview ? (
        <div role="dialog" aria-label="大图" onClick={() => setPreview(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, cursor: "zoom-out" }}>
          <img src={preview} alt="大图" style={{ maxWidth: "92vw", maxHeight: "92vh", borderRadius: 6 }} />
        </div>
      ) : null}
    </div>
  );
}
