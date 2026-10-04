import { isRealtimeLive, onRealtimeStatus, subscribeRealtime, type RealtimeTopic } from "../../services/realtime";

export interface LiveRefreshOptions {
  /** 关心哪几类变化 */
  topics: readonly RealtimeTopic[];
  /**
   * 悄悄重拉一次。isStillWanted() 变 false 说明这次拉的期间页面已经切走 / 换了条件，结果别往页面上写。
   * reason：push = 服务器推来了变化（或断线重连后补拉）；poll = 兜底定时到了。
   * ⚠️ 别在里面把列表先清空、别开整页的「加载中」，否则别人每改一次你这边就闪一下。
   */
  refresh: (isStillWanted: () => boolean, reason: "push" | "poll") => Promise<unknown> | unknown;
  /**
   * 实时连接断着的时候，隔多久兜底拉一次（毫秒）。
   * 不填 = 按 FALLBACK_POLL_MS（60 秒）兜底，而且只在网页在眼前时拉 —— 推送连不上（公司网络把长连接掐了之类）
   * 也不会一直停在旧数据上（dsh 复查 2026-10-05）；推送通着就不拉。
   */
  pollMs?: number;
  /** 实时连接通着的时候，隔多久兜底拉一次；不填 = 不轮询（只靠推送 + 断线重连后补拉） */
  livePollMs?: number;
}

/**
 * 「有变化就马上拉 + 兜底轮询」一起管（2026-10-05 老板要做 app：「不能有延迟」）。原来各页自己写的 setTimeout 轮询都换成这个。
 * 不依赖 React（页面用 useLiveRefresh 包一层），这样能直接拿假的推送测（scripts/test-realtime-client.ts）。
 *
 * - 一开始不拉（页面自己已经拉过第一次），之后：推送一到就拉；没推送就按兜底间隔拉。
 * - 同一时间只有一次在拉：拉的过程中又来了推送，拉完马上再拉一次（不丢、也不叠成两条轮询链）。
 * - 实时连接断了 / 通了，兜底间隔跟着换（断了回到原来的快节奏，不会因为推送坏了就一直不更新）。
 *
 * 返回停止函数。refresh 每次调用时现取（getRefresh），页面每次渲染换了新函数也用得上最新的条件。
 */
/** 没给 pollMs 的页面，推送断着时多久兜底拉一次 */
export const FALLBACK_POLL_MS = 60_000;

export function startLiveRefresh(
  options: Omit<LiveRefreshOptions, "refresh"> & {
    getRefresh: () => LiveRefreshOptions["refresh"];
    /** 只给测试用：把 60 秒的默认兜底缩短 */
    fallbackPollMs?: number;
  },
): () => void {
  const { topics, pollMs, livePollMs, getRefresh } = options;
  const fallbackPollMs = options.fallbackPollMs ?? FALLBACK_POLL_MS;
  let cancelled = false;
  let running = false;
  let again = false;
  let againReason: "push" | "poll" = "poll";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const wanted = () => !cancelled;

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (cancelled || running) return;
    const live = isRealtimeLive();
    const fallback = !live && pollMs === undefined;
    const wait = live ? livePollMs : (pollMs ?? fallbackPollMs);
    if (!wait || wait <= 0) return;
    timer = setTimeout(() => {
      // 默认兜底只在网页在眼前时拉（后台的标签页切回来时推送重连会补拉，不用在后台白拉）
      if (fallback && typeof document !== "undefined" && document.visibilityState !== "visible") {
        schedule();
        return;
      }
      void run("poll");
    }, wait);
  };

  const run = async (reason: "push" | "poll") => {
    if (cancelled) return;
    if (running) {
      again = true;
      if (reason === "push") againReason = "push";
      return;
    }
    if (timer) clearTimeout(timer);
    timer = null;
    running = true;
    try {
      await getRefresh()(wanted, reason);
    } catch {
      /* 悄悄拉的失败不打扰人，下一次推送 / 兜底再试 */
    } finally {
      running = false;
    }
    if (cancelled) return;
    if (again) {
      again = false;
      const next = againReason;
      againReason = "poll";
      void run(next);
      return;
    }
    schedule();
  };

  const unsubscribe = topics.length > 0 ? subscribeRealtime(topics, () => void run("push")) : () => {};
  const unwatch = onRealtimeStatus(() => schedule());
  schedule();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
    unsubscribe();
    unwatch();
  };
}
