"use client";

/**
 * 聊天窗口（2026-09-28，老板：「是直接类似微信的对话功能」「只要文字信息就行了，然后也可以发图片」）。
 * 客户的「在线客服」和员工 / 超管的「客户消息」共用这一个组件（CLAUDE.md 第 20 条：别两边各写一套）。
 *
 * 像微信的地方：自己的在右（绿）、对方的在左（白）；隔了 5 分钟以上中间插一行时间；
 * 回车发送、Shift+回车换行；能点「图片」选图，也能直接 Ctrl+V 粘贴截图；图片点开看大图；
 * 往上翻到头点「更早的消息」；翻上去看旧消息时来了新的，底下冒一个「有新消息」不强行拉下去。
 *
 * 消息靠轮询：窗口开着、页面在前台时每 3 秒取一次比手里最新那条还新的（后端往前多给 5 秒，这里按 id 去重）。
 * 看到对方的新消息就标已读，并通知左边菜单的红点马上刷新（CHAT_UNREAD_EVENT）。
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

export { CHAT_UNREAD_EVENT };
/** 轮询间隔（毫秒）。老板要「像微信」，窗口开着时 3 秒一次，对方的消息 3 秒内出来 */
export const CHAT_POLL_MS = 3000;
/** 跟后端 CS_MAX_TEXT 一致 */
const MAX_TEXT = 2000;
/** 两条消息隔多久中间插一行时间（微信是 5 分钟左右） */
const TIME_GAP_MS = 5 * 60 * 1000;

function notifyUnreadChanged(): void {
  try { window.dispatchEvent(new Event(CHAT_UNREAD_EVENT)); } catch { /* 老浏览器没有 Event 构造函数就算了 */ }
}

/** 时间行：今天只写时分，今年写月-日 时分，往年带年份（都按北京时间） */
function timeLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, ...opts }).format(d);
  const dayKey = (x: Date) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(x);
  const hm = fmt({ hour: "2-digit", minute: "2-digit" });
  if (dayKey(d) === dayKey(now)) return hm;
  const sameYear = fmt({ year: "numeric" }) === new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric" }).format(now);
  return sameYear ? `${fmt({ month: "2-digit", day: "2-digit" })} ${hm}` : `${fmt({ year: "numeric", month: "2-digit", day: "2-digit" })} ${hm}`;
}

function scopeKey(scope: ChatScope): string {
  return scope.kind === "client" ? "client" : `staff:${scope.clientId}`;
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
}) {
  const { scope, title, placeholder, closedNotice, onSent } = props;
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
  const stickToBottomRef = useRef(true);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  /** 已经成功标过已读的「对方最后一条」的时间：标失败了下一轮会再标；翻上去看旧消息时不标 */
  const lastMarkedRef = useRef("");

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
   * 看到了对方的消息：标已读。三个条件都要满足才算「看到了」：
   *   · 页面在前台（切到别的标签页不算）；
   *   · 停在最底下（2026-09-28 Codex 复核第 5 条：往上翻看旧消息时来了新的，只冒「有新消息」，
   *     不能标已读 —— 共用收件箱，一标所有员工的红点都没了，容易漏回）；
   *   · 比上次标过的新（标失败了下一轮会再来，Codex 复核第 6 条）。
   */
  const markSeen = useCallback((list: ChatMessage[]) => {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
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
    serverTimeRef.current = "";
    stickToBottomRef.current = true;
    lastMarkedRef.current = "";
    fetchChatMessages(scopeRef.current)
      .then((page) => {
        if (cancelled || !gate.isCurrent(ticket)) return;
        setMessages(page.messages);
        setHasMore(page.hasMore);
        serverTimeRef.current = page.serverTime;
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
  }, [key, gate, markSeen]);

  // 轮询新消息
  useEffect(() => {
    if (loading || loadError) return;
    let stopped = false;
    const forKey = key;
    const tick = async () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      const list = messagesRef.current;
      const since = list.length > 0 ? list[list.length - 1].createdAt : serverTimeRef.current;
      if (!since) return;
      try {
        const page = await fetchChatMessages(scopeRef.current, { since });
        if (stopped || keyRef.current !== forKey) return;
        serverTimeRef.current = page.serverTime;
        const before = messagesRef.current;
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

  const send = async (input: { content?: string; file?: File }) => {
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
      if (input.content !== undefined) setText("");
      notifyUnreadChanged();
      onSent?.();
    } catch (e) {
      if (keyRef.current === forKey) setSendError(e instanceof Error ? `没发出去：${e.message}` : "没发出去，请重试");
    } finally {
      if (keyRef.current === forKey) setSending(false);
    }
  };

  const sendText = () => {
    const content = text.trim();
    if (!content) return;
    if (content.length > MAX_TEXT) { setSendError(`一条最多 ${MAX_TEXT} 个字，请分几条发`); return; }
    void send({ content });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 中文输入法选字时按的回车不能当发送（composingRef / isComposing 两道都看，Safari 的 isComposing 不准）
    if (e.key === "Enter" && !e.shiftKey && !composingRef.current && !e.nativeEvent.isComposing) {
      e.preventDefault();
      sendText();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
    if (!file) return;
    e.preventDefault();
    void send({ file });
  };

  let lastShown = 0;
  return (
    <div className="cs-chat" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--s-sunken)", borderRadius: 10, border: "1px solid var(--l-soft)", overflow: "hidden" }}>
      <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--l-soft)", background: "var(--white)", fontWeight: 600, fontSize: 15, color: "var(--t-heading)" }}>
        {title}
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
          const t = new Date(m.createdAt).getTime();
          const showTime = t - lastShown > TIME_GAP_MS;
          if (showTime) lastShown = t;
          return (
            <div key={m.id}>
              {showTime ? (
                <div style={{ textAlign: "center", margin: "10px 0 8px" }}>
                  <span style={{ fontSize: 11, color: "var(--t-faint)" }}>{timeLabel(m.createdAt)}</span>
                </div>
              ) : null}
              <div style={{ display: "flex", flexDirection: "column", alignItems: m.mine ? "flex-end" : "flex-start", marginBottom: 10 }}>
                {!m.mine ? <div style={{ fontSize: 11, color: "var(--t-muted)", margin: "0 4px 3px" }}>{m.senderLabel}</div> : null}
                <div
                  style={{
                    maxWidth: "min(72%, 520px)",
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
                  title={timeLabel(m.createdAt)}
                >
                  {m.imageUrl ? (
                    <button type="button" onClick={() => setPreview(m.imageUrl)} style={{ display: "block", padding: 0, border: "none", background: "transparent", cursor: "zoom-in" }} aria-label="看大图">
                      <img src={m.imageUrl} alt="图片" onLoad={() => { if (stickToBottomRef.current) scrollToBottom(); }} style={{ display: "block", maxWidth: 220, maxHeight: 220, borderRadius: 6 }} />
                    </button>
                  ) : null}
                  {m.content ? <div style={m.imageUrl ? { marginTop: 6, padding: "0 7px 4px" } : undefined}>{m.content}</div> : null}
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
