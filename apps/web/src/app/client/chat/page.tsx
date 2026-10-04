"use client";

/**
 * 客户端「在线客服」（2026-09-28，老板：「可以跟后台的客服对话，也就是员工账号」「类似微信」）。
 * 一个客户一条对话，所有员工都能回；对方统一显示「客服」。
 *
 * ⚠️ 代理名下的客户不开（老板：「代理的不开这个功能」）：
 *   · 左边菜单按品牌藏掉（branding/brand-core.ts 的 AGENT_CLIENT_HIDDEN_MENU_IDS）；
 *   · 直接输网址 / 旧书签进来：这里进门现查品牌，是代理的客户就送回主页（跟普通版集货那页同一套）；
 *   · 接口那头 /client/chat/* 在服务端统一闸再挡一次。
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useVerifiedSessionBrand } from "../../../modules/branding/useWorkbenchBrand";
import ChatThread from "../../../modules/cs-chat/ChatThread";
import ChatPushToggle from "../../../modules/cs-chat/ChatPushToggle";

function ClientChatContent() {
  return (
    <div className="cs-client-page" style={{ padding: "16px 20px", height: "calc(100dvh - 72px)", minHeight: 420, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 13, color: "var(--t-muted)" }}>
        有问题直接在这里问，客服看到就回。报价有疑问也可以在这里谈。问某一票货的，点输入框上面的「选运单」选上那一票。
      </div>
      {/* 浏览器系统通知（2026-10-02）：没开系统页面也能收到客服的回复。服务器没配好就不出现 */}
      <ChatPushToggle />
      <div style={{ flex: 1, minHeight: 0 }}>
        <ChatThread scope={{ kind: "client" }} title="客服" />
      </div>
    </div>
  );
}

export default function ClientChatPage() {
  const { state, retry } = useVerifiedSessionBrand();
  const router = useRouter();
  const isAgentClient = state.status === "done" && state.brand !== null;
  useEffect(() => {
    if (isAgentClient) router.replace("/client");
  }, [isAgentClient, router]);
  if (state.status === "error") {
    return (
      <div style={{ padding: 24, fontSize: 14, color: "var(--t-muted)" }}>
        <div style={{ marginBottom: 12 }}>暂时打不开这一页：{state.message}</div>
        <button onClick={retry} style={{ padding: "6px 16px", border: "1px solid var(--c-blue)", color: "var(--c-blue)", background: "var(--white)", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>
          重试
        </button>
      </div>
    );
  }
  if (state.status !== "done" || state.brand) {
    return (
      <div style={{ padding: 24, fontSize: 14, color: "var(--t-muted)" }}>
        {state.status === "done" ? "该功能暂未开放，正在返回主页…" : "加载中…"}
      </div>
    );
  }
  return <ClientChatContent />;
}
