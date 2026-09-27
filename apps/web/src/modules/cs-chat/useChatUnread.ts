"use client";

/**
 * 左边菜单「在线客服 / 客户消息」旁边的未读红点（2026-09-28）。
 * 30 秒问一次；切回这个标签页、换页、聊天窗口标了已读 / 发了消息（CHAT_UNREAD_EVENT）时马上再问一次。
 * 代理本人、代理名下的客户（菜单已按品牌藏掉）不问 —— 接口会 403，问了也白问。
 */
import { useEffect, useRef, useState } from "react";
import type { AuthSession } from "../../auth/auth-session";
import { CHAT_UNREAD_EVENT, fetchChatUnread } from "../../services/cs-chat-api";
import { createRequestGate } from "../shared/request-gate";

/** 菜单里这三个 id 旁边挂红点（menu-config.ts） */
export const CHAT_MENU_IDS: readonly string[] = ["client-func-chat", "staff-func-chat", "admin-func-chat"];
const POLL_MS = 30_000;

export function useChatUnread(session: AuthSession | null, hiddenByBrand: boolean, path: string): number {
  const [count, setCount] = useState(0);
  const gate = useRef(createRequestGate()).current;
  const role = session?.role;
  const enabled = !!session && role !== "agent" && !hiddenByBrand;

  useEffect(() => {
    if (!enabled || !role) { setCount(0); return; }
    const who = role; // 进门已排除没登录和代理本人

    let stopped = false;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      const ticket = gate.begin();
      try {
        const r = await fetchChatUnread(who);
        if (!stopped && gate.isCurrent(ticket)) setCount(Number(r.count) || 0);
      } catch {
        /* 问不到就保持原样，不打扰人 */
      }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, POLL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    const onChanged = () => { void load(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(CHAT_UNREAD_EVENT, onChanged);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(CHAT_UNREAD_EVENT, onChanged);
    };
  }, [enabled, role, session?.userId, path, gate]);

  return enabled ? count : 0;
}
