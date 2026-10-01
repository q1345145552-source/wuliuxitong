"use client";

/**
 * 左边菜单「在线客服 / 客户消息」旁边的未读红点（2026-09-28）。
 * 30 秒问一次；切回这个标签页、换页、聊天窗口标了已读 / 发了消息（CHAT_UNREAD_EVENT）时马上再问一次。
 * 代理本人、代理名下的客户（菜单已按品牌藏掉）不问 —— 接口会 403，问了也白问。
 *
 * 提示音（2026-10-02 老板：「还要有消息提示音」「当时收的时候响，而不是之后响」）：有比上次更新的未读就「叮咚」一声（chat-sound.ts）。
 * 所以**网页切到后台也照样问**（原来切走就不问）—— 客服把系统开在后台干别的，来消息也得听得到。
 * 多久问一次：网页在眼前 5 秒（原来 30 秒，在别的页面来消息最多晚半分钟才响）；在后台 15 秒（少打点服务器）。
 * 计时放在 Worker 里（public/chat-tick.worker.js）：网页在后台待久了，浏览器会把页面自己的定时器放慢到一分钟一次，
 * Worker 里的不受这个限制。Worker 起不来（老浏览器、文件没取到）就退回页面自己的定时器。
 */
import { useEffect, useRef, useState } from "react";
import type { AuthSession } from "../../auth/auth-session";
import { CHAT_UNREAD_EVENT, fetchChatUnread } from "../../services/cs-chat-api";
import { createRequestGate } from "../shared/request-gate";
import { chatSoundKey, installChatSoundUnlock, noteUnreadLatest } from "./chat-sound";

/** 菜单里这三个 id 旁边挂红点（menu-config.ts） */
export const CHAT_MENU_IDS: readonly string[] = ["client-func-chat", "staff-func-chat", "admin-func-chat"];
/** 网页在眼前时多久问一次 */
const VISIBLE_MS = 5_000;
/** 网页在后台时多久问一次 */
const HIDDEN_MS = 15_000;

export function useChatUnread(session: AuthSession | null, hiddenByBrand: boolean, path: string): number {
  const [count, setCount] = useState(0);
  const gate = useRef(createRequestGate()).current;
  const role = session?.role;
  const enabled = !!session && role !== "agent" && !hiddenByBrand;

  useEffect(() => {
    if (!enabled || !role) { setCount(0); return; }
    const who = role; // 进门已排除没登录和代理本人

    let stopped = false;
    installChatSoundUnlock();
    let lastLoadAt = 0;
    /* 一次只问一个（Codex 复查 2026-10-02）：改成 5 秒一次以后，服务器一慢（一次超过 5 秒），后一次会把前一次作废，
       回来的全被丢掉 —— 红点和提示音一直不动，请求还越堆越多。现在：上一次还没回来就不发新的；
       这期间有人要求马上刷新（聊天窗口标了已读、发了消息），就记一笔，等上一次回来立刻补问一次 */
    let inFlight = false;
    let pending = false;
    const load = async () => {
      if (inFlight) { pending = true; return; }
      inFlight = true;
      // 不再「切到后台就不问」：后台也要能响提示音（见文件头）
      lastLoadAt = Date.now();
      const ticket = gate.begin();
      try {
        const r = await fetchChatUnread(who);
        if (!stopped && gate.isCurrent(ticket)) {
          setCount(Number(r.count) || 0);
          // 按对话分开报（chatSoundKey，跟聊天窗口同一个叫法）：客户那头只有自己一个对话；员工那头按客户唛头
          noteUnreadLatest(
            who === "client"
              ? { [chatSoundKey()]: r.latestAt ?? null }
              : Object.fromEntries(Object.entries(r.latestByClient ?? {}).map(([cid, at]) => [chatSoundKey(cid), at])),
            r.serverTime,
          );
        }
      } catch {
        /* 问不到就保持原样，不打扰人 */
      } finally {
        inFlight = false;
        if (pending && !stopped) { pending = false; void load(); }
      }
    };
    void load();
    /** 到点了：在眼前 5 秒问一次，在后台 15 秒问一次（计时器每 5 秒叫一下，留 1 秒余量） */
    const tick = () => {
      if (stopped) return;
      const gap = document.visibilityState === "visible" ? VISIBLE_MS : HIDDEN_MS;
      if (Date.now() - lastLoadAt >= gap - 1000) void load();
    };
    let timer: number | null = null;
    const useFallbackTimer = () => { if (timer === null && !stopped) timer = window.setInterval(tick, VISIBLE_MS); };
    let worker: Worker | null = null;
    try {
      if (typeof Worker !== "undefined") {
        worker = new Worker("/chat-tick.worker.js");
        worker.onmessage = tick;
        worker.onerror = () => { worker?.terminate(); worker = null; useFallbackTimer(); };
        worker.postMessage(VISIBLE_MS);
      }
    } catch {
      worker = null;
    }
    if (!worker) useFallbackTimer();
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    const onChanged = () => { void load(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(CHAT_UNREAD_EVENT, onChanged);
    return () => {
      stopped = true;
      worker?.terminate();
      if (timer !== null) window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(CHAT_UNREAD_EVENT, onChanged);
    };
  }, [enabled, role, session?.userId, path, gate]);

  return enabled ? count : 0;
}
