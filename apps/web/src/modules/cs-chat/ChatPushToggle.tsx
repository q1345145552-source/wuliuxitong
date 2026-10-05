"use client";

/**
 * 聊天页顶上那一行「开启新消息通知」（2026-10-02 老板选「浏览器系统通知」）。
 * 客户的「在线客服」、员工 / 超管的「客户消息」都放一份。服务器没配密钥（server-off）就整行不出现。
 * 做法见 chat-push.ts。
 */
import { useEffect, useState } from "react";
import { getOptionalSession } from "../../auth/auth-session";
import { disableChatPush, enableChatPush, ensureIosManifest, readChatPushState, type ChatPushRole, type ChatPushState } from "./chat-push";
import { isNativeApp } from "../app-shell/native-app";

const HINT: Record<Exclude<ChatPushState, "on" | "off" | "server-off">, string> = {
  denied: "这个浏览器禁止了本网站的通知。要开的话：点地址栏左边的小锁 / 设置图标，把「通知」改成「允许」，再刷新页面。",
  "ios-install": "苹果手机要收新消息通知：先点 Safari 下方的「分享」→「添加到主屏幕」，再从主屏幕上的图标打开本系统，这里就能开启。",
  unsupported: "这个浏览器不支持系统通知，可以换 Chrome、Edge、Safari 或火狐。",
};

/** compact：员工收件箱左边那一栏窄（280 宽），字说短一点 */
export default function ChatPushToggle(props: { compact?: boolean } = {}) {
  const { compact = false } = props;
  const [state, setState] = useState<ChatPushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const session = getOptionalSession();
    if (!session) return;
    let cancelled = false;
    ensureIosManifest(session.role as ChatPushRole);
    readChatPushState(session)
      .then((s) => { if (!cancelled) setState(s); })
      .catch(() => { if (!cancelled) setState("server-off"); /* 问不到就当没开，不打扰人 */ });
    return () => { cancelled = true; };
  }, []);

  // 湘泰 app 里整行不出：app 里的网页开不了浏览器系统通知，那句「换 Chrome」对 app 用户是错的（2026-10-05）
  if (state === null || state === "server-off" || isNativeApp()) return null;

  const run = async (fn: typeof enableChatPush) => {
    const session = getOptionalSession();
    if (!session || busy) return;
    setBusy(true);
    setError("");
    try {
      setState(await fn(session));
    } catch (e) {
      setError(e instanceof Error ? e.message : "没开成，请刷新页面再试");
    } finally {
      setBusy(false);
    }
  };

  const btn = { border: "1px solid var(--c-blue)", color: "var(--c-blue)", background: "var(--white)", borderRadius: 6, padding: "3px 12px", fontSize: 12, cursor: busy ? "default" : "pointer", flexShrink: 0 } as const;
  return (
    <div className="cs-push-toggle" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 12, color: "var(--t-muted)" }}>
      {state === "on" ? (
        <>
          <span>{compact ? "这台设备已开新消息通知" : "这台设备已开启新消息通知：没开系统页面也会弹提醒。"}</span>
          <button type="button" onClick={() => void run(disableChatPush)} disabled={busy} style={{ ...btn, borderColor: "var(--l-strong)", color: "var(--t-strong)" }}>
            {busy ? "处理中…" : "关闭通知"}
          </button>
        </>
      ) : state === "off" ? (
        <>
          <span>{compact ? "没开系统页面也能收到新消息提醒" : "开启新消息通知：没开系统页面也能在电脑右下角 / 手机通知栏收到提醒。"}</span>
          <button type="button" onClick={() => void run(enableChatPush)} disabled={busy} style={btn}>
            {busy ? "开启中…" : "开启通知"}
          </button>
        </>
      ) : (
        <span>{HINT[state]}</span>
      )}
      {error ? <span role="alert" style={{ color: "var(--c-red-deep)" }}>{error}</span> : null}
    </div>
  );
}
