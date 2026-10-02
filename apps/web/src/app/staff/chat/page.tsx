"use client";

/**
 * 员工 / 超管「客户消息」（2026-09-28，老板：「不是自己挑人聊，而是全部客服都能回」）。
 * 所有员工和超管看同一个收件箱：左边是客户列表（只显示唛头，有新消息的带红色数字），右边是聊天窗口。
 * 超管菜单里的「客户消息」也指到这一页（跟「整柜询价」「装柜管理」一样借员工端的页面）。
 *
 * 列表 5 秒刷一次（页面在前台时）；右边窗口自己 3 秒取一次新消息（见 ChatThread）。
 * 还没聊过的客户：上面输唛头点「开始对话」，员工可以先开口。代理名下的客户不开对话（老板定的），后端会挡。
 * 网址带 ?clientId=唛头 直接打开那个客户（整柜询价详情里的「联系客户」就是这么跳过来的）。
 *
 * 2026-10-02 老板：已读不回容易漏 → 列表上面分「全部 / 待回复」两个页签，待回复的那一行标「待回复 · 等了多久」。
 * 待回复 = 最新一条还在的消息是客户发的（有人看过也算，看过不回照样挂着）。最上面一行可以开浏览器系统通知（ChatPushToggle）。
 */
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import ChatThread, { CHAT_UNREAD_EVENT } from "../../../modules/cs-chat/ChatThread";
import ChatPushToggle from "../../../modules/cs-chat/ChatPushToggle";
import { fetchChatConversations, type ChatConversation } from "../../../services/cs-chat-api";
import { createRequestGate } from "../../../modules/shared/request-gate";

const LIST_POLL_MS = 5000;

function shortTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const day = (x: Date) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(x);
  const opts: Intl.DateTimeFormatOptions = day(d) === day(new Date())
    ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } // 不用 hour12:false：有的浏览器零点会写成 24:05（dsh 复查）
    : { month: "2-digit", day: "2-digit" };
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", ...opts }).format(d);
}

/** 待回复等了多久：不到 1 分钟 / x 分钟 / x 小时 / x 天（列表 5 秒刷一次，跟着走） */
function waitedLabel(since: string | null, now = Date.now()): string {
  if (!since) return "";
  const min = Math.floor((now - Date.parse(since)) / 60_000);
  if (!Number.isFinite(min) || min < 1) return "不到 1 分钟";
  if (min < 60) return `${min} 分钟`;
  if (min < 24 * 60) return `${Math.floor(min / 60)} 小时`;
  return `${Math.floor(min / (24 * 60))} 天`;
}

/**
 * 网址上的 ?clientId= 用 useSearchParams 读（2026-09-28 分支审查改）：原来只在进页面时读一次 window.location，
 * 手机上正聊着某个客户、点菜单「客户消息」（网址变回 /staff/chat）页面不重建，屏幕还停在那个客户、回不到列表。
 * Next 16 规定用 useSearchParams 的组件要包一层 Suspense（不包 next build 会报错）。
 */
export default function StaffChatPage() {
  return (
    <Suspense fallback={<div style={{ padding: 24, fontSize: 13, color: "var(--t-faint)" }}>加载中…</div>}>
      <StaffChatInbox />
    </Suspense>
  );
}

function StaffChatInbox() {
  const [items, setItems] = useState<ChatConversation[]>([]);
  const [listError, setListError] = useState("");
  const [listLoaded, setListLoaded] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [search, setSearch] = useState("");
  /** 全部 / 只看待回复（2026-10-02） */
  const [tab, setTab] = useState<"all" | "pending">("all");
  const [pendingCount, setPendingCount] = useState(0);
  const [selected, setSelected] = useState<string>("");
  const [startInput, setStartInput] = useState("");
  const gate = useRef(createRequestGate()).current;
  const searchRef = useRef(search);
  searchRef.current = search;
  const tabRef = useRef(tab);
  tabRef.current = tab;
  /** 哪些客户已经划到代理名下（只能看、不能发）：记下每次列表里见过的，搜索把选中的客户过滤掉了也还认得（2026-09-28 分支审查） */
  const closedSeenRef = useRef(new Map<string, boolean>());

  const loadList = useCallback(async () => {
    const ticket = gate.begin();
    try {
      const data = await fetchChatConversations(searchRef.current, tabRef.current === "pending" ? "pending" : undefined);
      if (!gate.isCurrent(ticket)) return;
      for (const c of data.items ?? []) closedSeenRef.current.set(c.clientId, c.closed === true);
      /* 这个列表不报提示音（Codex 复查 2026-10-02）：左边菜单已经是 5 秒一次（老板：「当时收的时候响」），
         列表再报一份只会跟菜单抢「第一次只记不响」，把真新消息悄悄吞掉。正开着客户甲时客户乙来消息，菜单 5 秒内响 */
      setItems(data.items ?? []);
      setTruncated(data.truncated === true);
      setPendingCount(Number(data.pendingCount) || 0);
      setListError("");
    } catch (e) {
      if (!gate.isCurrent(ticket)) return;
      setListError(e instanceof Error ? e.message : "加载失败");
    } finally {
      if (gate.isCurrent(ticket)) setListLoaded(true);
    }
  }, [gate]);

  useEffect(() => { void loadList(); }, [loadList, search, tab]);

  // 选中的客户跟着网址走：进页面带 ?clientId= 直接打开；点菜单「客户消息」网址变回 /staff/chat 就回到列表
  const searchParams = useSearchParams();
  const urlClientId = searchParams.get("clientId")?.trim() ?? "";
  useEffect(() => { setSelected(urlClientId); }, [urlClientId]);

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
  const selectedClosed = current?.closed ?? closedSeenRef.current.get(selected) ?? false;

  return (
    /* 手机上（窄于 640）一次只显示一栏，跟手机微信一样：没选客户看列表，点了客户整屏是聊天，
       左上「‹ 返回」回列表（样式在 globals.css 的 .cs-inbox）。原来两栏硬挤在一行，
       手机上聊天那栏只剩十几像素宽，员工根本没法回（2026-09-28 手机实测）。 */
    <div className={selected ? "cs-inbox cs-inbox--open" : "cs-inbox"} style={{ padding: "16px 20px", height: "calc(100dvh - 72px)", minHeight: 460, display: "flex", gap: 12 }}>
      <aside className="cs-inbox-list" style={{ width: 280, flexShrink: 0, display: "flex", flexDirection: "column", border: "1px solid var(--l-soft)", borderRadius: 10, background: "var(--white)", overflow: "hidden" }}>
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
          {/* 全部 / 待回复（2026-10-02 老板：已读不回容易漏）。数字是全公司待回复几个，不跟着搜索走 */}
          <div role="tablist" aria-label="对话筛选" style={{ display: "flex", gap: 6 }}>
            {([["all", "全部"], ["pending", `待回复${pendingCount > 0 ? ` ${pendingCount}` : ""}`]] as const).map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                style={{ flex: 1, border: `1px solid ${tab === k ? "var(--c-blue)" : "var(--l-strong)"}`, background: tab === k ? "var(--c-blue)" : "var(--white)", color: tab === k ? "var(--white)" : k === "pending" && pendingCount > 0 ? "var(--c-amber-deep)" : "var(--t-strong)", borderRadius: 6, padding: "5px 0", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                {label}
              </button>
            ))}
          </div>
          <ChatPushToggle compact />
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          {!listLoaded ? <div style={{ padding: 16, fontSize: 13, color: "var(--t-faint)" }}>加载中…</div> : null}
          {listError ? <div style={{ padding: 16, fontSize: 13, color: "var(--c-red-deep)" }}>列表没取到：{listError}</div> : null}
          {listLoaded && !listError && items.length === 0 ? (
            <div style={{ padding: 16, fontSize: 13, color: "var(--t-faint)" }}>
              {tab === "pending" ? (search.trim() ? "这个唛头没有待回复的对话" : "没有待回复的对话，都回过了") : search.trim() ? "没有这个唛头的对话" : "还没有客户发消息"}
            </div>
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
                {/* 待回复：客户说了话、我们还没回（看过也算没回），写上等了多久 */}
                {c.pendingReply ? (
                  <div className="cs-pending-tag" style={{ display: "inline-block", marginTop: 4, fontSize: 11, color: "var(--c-amber-deep)", background: "var(--c-amber-bg)", borderRadius: 4, padding: "1px 6px" }}>
                    待回复 · 等了 {waitedLabel(c.pendingSince)}
                  </div>
                ) : null}
                <div style={{ fontSize: 12, color: "var(--t-muted)", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {c.closed ? "（已划到代理名下，不能再发）" : null}
                  {c.lastFromUs ? "我方：" : ""}{c.lastMessagePreview || "（无内容）"}
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      <section className="cs-inbox-thread" style={{ flex: 1, minWidth: 0 }}>
        {selected ? (
          <ChatThread
            key={selected}
            scope={{ kind: "staff", clientId: selected }}
            title={`客户 ${selected}`}
            closedNotice={selectedClosed ? "这个客户已经划到代理名下，对话功能不对代理的客户开放，只能看以前的记录。" : undefined}
            onSent={() => { void loadList(); }}
            onBack={() => select("")}
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
