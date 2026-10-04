/**
 * 「悄悄重拉」给用户自己点的请求让路（Codex 复查 2026-10-05）。
 *
 * 页面的加载函数多半带门闩（request-gate）：后出发的领新号、先出发的作废。有变化时的悄悄重拉要是在
 * 用户点的请求（搜索、翻页、打开详情、重试）还在路上时出发，就会把用户那次作废；悄悄这次再失败（不报错），
 * 用户点的那一下就白点了 —— 列表停在旧的、详情变空。
 *
 * 规矩：用户的请求在路上 → 悄悄重拉先不发、记一笔；用户的请求回来以后补发一次（补的那次照样领号，拿最新的）。
 */
export interface YieldGuard {
  /** 用户发起的那次，出发时调；返回「收尾」函数，放进 finally 里（调多次只算一次） */
  begin(): () => void;
  /** 悄悄重拉现在能不能发：用户的请求在路上就返回 false，并记下 rerun，等用户那次回来后调它 */
  allowSilent(rerun: () => void): boolean;
}

export function createYieldGuard(): YieldGuard {
  let inFlight = 0;
  let pending: (() => void) | null = null;
  return {
    begin() {
      inFlight += 1;
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        inFlight -= 1;
        if (inFlight === 0 && pending) {
          const rerun = pending;
          pending = null;
          rerun();
        }
      };
    },
    allowSilent(rerun) {
      if (inFlight > 0) {
        pending = rerun;
        return false;
      }
      return true;
    },
  };
}
