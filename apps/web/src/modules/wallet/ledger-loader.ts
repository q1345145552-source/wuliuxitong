/**
 * 一个客户的余额流水：前台加载（换客户 / 翻页 / 刷新 / 管理员刚办完一笔）和后台静默刷新（实时推送）共用一份数据（2026-11-27 审查第 2 条）。
 *
 * 原来的毛病：只认「最新发出的那一次」，加载中靠这一次自己收。前台 A 还在路上、静默刷新 B 后发（领了更大的号）→
 * A 回来验号不过被扔掉、finally 里也不收「加载中」→ B 是静默的也不收 → 「加载中…」永远亮着、翻页刷新一直是灰的。
 * 最常见的触发就是管理员自己刚加完钱：外面让它回第一页重拉，几乎同时自己这一下推回来的推送又触发一次静默刷新。
 *
 * 现在（CLAUDE.md 第 45 条、modules/shared/request-gate.ts 的 createQueryGate）：
 *   · 「加载中」按前台请求的个数算：发一个加一、回来（不管成败、不管用没用上）减一，归零才熄 —— 谁也卡不住它；
 *   · 结果用不用：成功回来的，只要还是「现在要看的那一页」（同一个查询对象）、而且不比已经显示的旧，就用；
 *     失败的谁也不作废，静默的失败不吭声，前台的失败只在它还是现在这一页、又没被更新的结果盖过时才提示；
 *   · 换客户 / 外面办完一笔 → 新建一个「第 1 页」的查询对象再拉：一定回到第一页、看得到刚办的那一笔（新的在前）。
 * 纯逻辑、不碰 React，scripts/test-wallet-adjust-source.ts 拿假的取数函数直接跑。
 */
import { createQueryGate } from "../shared/request-gate";

export interface LedgerQuery {
  readonly clientId: string;
  readonly page: number;
}

export interface LedgerPage<T> {
  items: T[];
  page: number;
  total: number;
  balance: number;
}

export interface LedgerLoaderHooks<T> {
  fetchPage: (q: LedgerQuery) => Promise<LedgerPage<T>>;
  onData: (data: LedgerPage<T>) => void;
  onError: (message: string) => void;
  onLoading: (loading: boolean) => void;
}

export interface LedgerLoader {
  /** 前台：看这个客户的第 page 页（换客户、翻页、外面办完一笔回第 1 页都走这里） */
  goTo(clientId: string, page: number): Promise<void>;
  /** 前台：按现在这一页再拉一次（「刷新」按钮） */
  reload(): Promise<void>;
  /** 后台：按现在这一页悄悄重拉（实时推送）。不亮「加载中」、失败不吭声 */
  refreshSilently(): Promise<void>;
  /** 现在要看的是哪一页 */
  current(): LedgerQuery | null;
}

export function createLedgerLoader<T>(hooks: LedgerLoaderHooks<T>): LedgerLoader {
  const gate = createQueryGate<LedgerQuery | null>();
  let currentQuery: LedgerQuery | null = null;
  let userLoads = 0;

  const run = async (q: LedgerQuery, silent: boolean): Promise<void> => {
    const ticket = gate.begin(q);
    if (!silent) {
      userLoads += 1;
      hooks.onLoading(true);
      hooks.onError("");
    }
    try {
      const data = await hooks.fetchPage(q);
      if (gate.accept(ticket, currentQuery)) {
        hooks.onData(data);
        hooks.onError("");
      }
    } catch (e) {
      if (!silent && Object.is(q, currentQuery) && !gate.superseded(ticket)) {
        hooks.onError(e instanceof Error ? e.message : "流水没加载出来");
      }
    } finally {
      if (!silent) {
        userLoads -= 1;
        if (userLoads === 0) hooks.onLoading(false);
      }
    }
  };

  return {
    goTo(clientId, page) {
      // 每次都是新的查询对象：同一页再点一次也算「要最新的」，晚到的旧结果用不上
      currentQuery = { clientId, page: Math.max(1, page) };
      return run(currentQuery, false);
    },
    reload() {
      if (!currentQuery) return Promise.resolve();
      currentQuery = { ...currentQuery };
      return run(currentQuery, false);
    },
    refreshSilently() {
      if (!currentQuery) return Promise.resolve();
      return run(currentQuery, true);
    },
    current: () => currentQuery,
  };
}
