"use client";

/**
 * 员工 / 超管「客户消息」（2026-09-28，老板：「不是自己挑人聊，而是全部客服都能回」）。
 * 所有员工和超管看同一个收件箱：左边是客户列表（只显示唛头，有新消息的带红色数字），右边是聊天窗口。
 * 超管菜单里的「客户消息」也指到这一页（跟「整柜询价」「装柜管理」一样借员工端的页面）。
 *
 * 列表 5 秒刷一次（页面在前台时）；右边窗口自己 3 秒取一次新消息（见 ChatThread）。
 * 还没聊过的客户：上面输唛头点「开始对话」，员工可以先开口。代理名下的客户不开对话（老板定的），后端会挡。
 * 网址带 ?clientId=唛头 直接打开那个客户（整柜询价详情里的「联系客户」就是这么跳过来的）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import ChatThread, { CHAT_UNREAD_EVENT } from "../../../modules/cs-chat/ChatThread";
import { fetchChatConversations, type ChatConversation } from "../../../services/cs-chat-api";
import { createRequestGate } from "../../../modules/shared/request-gate";

const LIST_POLL_MS = 5000;

function shortTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const day = (x: Date) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(x);
  const opts: Intl.DateTimeFormatOptions = day(d) === day(new Date())
    ? { hour: "2-digit", minute: "2-digit", hour12: false }
    : { month: "2-digit", day: "2-digit" };
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", ...opts }).format(d);
}

export default function StaffChatPage() {
  const [items, setItems] = useState<ChatConversation[]>([]);
  const [listError, setListError] = useState("");
  const [listLoaded, setListLoaded] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string>("");
  const [startInput, setStartInput] = useState("");
  const gate = useRef(createRequestGate()).current;
  const searchRef = useRef(search);
  searchRef.current = search;

  const loadList = useCallback(async () => {
    const ticket = gate.begin();
    try {
      const data = await fetchChatConversations(searchRef.current);
      if (!gate.isCurrent(ticket)) return;
      setItems(data.items ?? []);
      setTruncated(data.truncated === true);
      setListError("");
    } catch (e) {
      if (!gate.isCurrent(ticket)) return;
      setListError(e instanceof Error ? e.message : "加载失败");
    } finally {
      if (gate.isCurrent(ticket)) setListLoaded(true);
    }
  }, [gate]);

  useEffect(() => { void loadList(); }, [loadList, search]);

  // 进页面时读网址上的 ?clientId=（不用 useSearchParams：Next 16 要为它另包一层 Suspense，项目里也没人用它）
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("clientId")?.trim();
    if (fromUrl) setSelected(fromUrl);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadList();
    }, LIST_POLL_MS);
    // 聊天窗口标了已读 / 发了消息：列表上的红色数字马上跟着变
    const onChanged = () => { void loadList(); };
    window.addEventListener(CHAT_UNREAD_EVENT, onChanged);
    return () => { window.clearInterval(timer); window.removeEventListener(CHAT_UNREAD_EVENT, onChanged); };
  }, [loadList]);

  // 网址上的 ?clientId= 跟着选中的走（刷新 / 复制链接还在同一个客户）
  const select = (clientId: string) => {
    setSelected(clientId);
    window.history.replaceState(null, "", clientId ? `/staff/chat?clientId=${encodeURIComponent(clientId)}` : "/staff/chat");
  };

  const current = items.find((x) => x.clientId === selected);

  return (
    <div style={{ padding: "16px 20px", height: "calc(100dvh - 72px)", minHeight: 460, display: "flex", gap: 12 }}>
      <aside style={{ width: 280, flexShrink: 0, display: "flex", flexDirection: "column", border: "1px solid var(--l-soft)", borderRadius: 10, background: "var(--white)", overflow: "hidden" }}>
        <div style={{ padding: 10, borderBottom: "1px solid var(--l-soft)", display: "grid", gap: 8 }}>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜唛头"
            aria-label="搜唛头"
            style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "7px 10px", fontSize: 13 }} />
          <form onSubmit={(e) => { e.preventDefault(); const v = startInput.trim(); if (v) { select(v); setStartInput(""); } }}
            style={{ display: "flex", gap: 6 }}>
            <input value={startInput} onChange={(e) => setStartInput(e.target.value)} placeholder="输唛头，主动找客户"
              aria-label="输唛头，主动找客户"
              style={{ flex: 1, minWidth: 0, border: "1px solid var(--l-strong)", borderRadius: 6, padding: "7px 10px", fontSize: 13 }} />
            <button type="submit" style={{ border: "1px solid var(--c-blue)", color: "var(--c-blue)", background: "var(--white)", borderRadius: 6, padding: "0 10px", fontSize: 12, cursor: "pointer", flexShrink: 0 }}>
              开始对话
            </button>
          </form>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          {!listLoaded ? <div style={{ padding: 16, fontSize: 13, color: "var(--t-faint)" }}>加载中…</div> : null}
          {listError ? <div style={{ padding: 16, fontSize: 13, color: "var(--c-red-deep)" }}>列表没取到：{listError}</div> : null}
          {listLoaded && !listError && items.length === 0 ? (
            <div style={{ padding: 16, fontSize: 13, color: "var(--t-faint)" }}>{search.trim() ? "没有这个唛头的对话" : "还没有客户发消息"}</div>
          ) : null}
          {truncated ? (
            <div style={{ padding: "8px 12px", fontSize: 12, color: "var(--c-amber-deep)", background: "var(--c-amber-bg)" }}>
              只列出最近 500 个对话，更早的请在上面搜唛头
            </div>
          ) : null}
          {items.map((c) => {
            const active = c.clientId === selected;
            return (
              <button key={c.clientId} type="button" onClick={() => select(c.clientId)}
                aria-current={active ? "true" : undefined}
                style={{ display: "block", width: "100%", textAlign: "left", border: "none", borderBottom: "1px solid var(--s-cool-2)", background: active ? "var(--c-green-bg)" : "var(--white)", padding: "10px 12px", cursor: "pointer" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                  <span style={{ fontWeight: 600, fontFamily: "var(--a3-mono, monospace)", fontSize: 13, color: "var(--t-heading)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.clientId}</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                    <span style={{ fontSize: 11, color: "var(--t-faint)" }}>{shortTime(c.lastMessageAt)}</span>
                    {c.unreadCount > 0 ? (
                      <span aria-label={`${c.unreadCount} 条未读`} style={{ minWidth: 18, height: 18, borderRadius: 9, background: "var(--c-red)", color: "var(--white)", fontSize: 11, lineHeight: "18px", textAlign: "center", padding: "0 5px" }}>
                        {c.unreadCount > 99 ? "99+" : c.unreadCount}
                      </span>
                    ) : null}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "var(--t-muted)", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {c.closed ? "（已划到代理名下，不能再发）" : null}
                  {c.lastFromClient ? "" : "我方："}{c.lastMessagePreview || "（无内容）"}
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      <section style={{ flex: 1, minWidth: 0 }}>
        {selected ? (
          <ChatThread
            key={selected}
            scope={{ kind: "staff", clientId: selected }}
            title={`客户 ${selected}`}
            closedNotice={current?.closed ? "这个客户已经划到代理名下，对话功能不对代理的客户开放，只能看以前的记录。" : undefined}
            onSent={() => { void loadList(); }}
          />
        ) : (
          <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", border: "1px dashed var(--l-strong)", borderRadius: 10, color: "var(--t-faint)", fontSize: 14 }}>
            左边选一个客户开始回复
          </div>
        )}
      </section>
    </div>
  );
}
