"use client";

import { useEffect, useRef } from "react";
import type { RealtimeTopic } from "../../services/realtime";
import { startLiveRefresh, type LiveRefreshOptions } from "./live-refresh";

/**
 * 页面用的实时更新钩子（2026-10-05 老板要做 app：「不能有延迟」）：这几类数据一变就悄悄重拉，再加兜底轮询。
 * 规矩都在 live-refresh.ts 里（推送马上拉、同一时间只拉一份、断线时回到原来的轮询节奏）。
 *
 * - refresh 用的是最新那个函数（放在 ref 里），页面不用 useCallback 包，也不会因为它变了反复退订再订。
 * - enabled=false 时不订、不轮询（比如那一栏没显示、还没登录）。
 */
export function useLiveRefresh({ topics, enabled = true, refresh, pollMs, livePollMs }: LiveRefreshOptions & { enabled?: boolean }): void {
  const latest = useRef(refresh);
  latest.current = refresh;
  const key = [...topics].sort().join(",");
  useEffect(() => {
    if (!enabled) return;
    return startLiveRefresh({
      topics: key ? (key.split(",") as RealtimeTopic[]) : [],
      pollMs,
      livePollMs,
      getRefresh: () => latest.current,
    });
  }, [key, enabled, pollMs, livePollMs]);
}
