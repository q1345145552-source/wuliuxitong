/**
 * 装柜管理推状态前，看这次要记的时间行不行（2026-10-14 老板要「改状态加个时间，默认现在、可以改」）。
 * 页面和测试共用这一个函数，测试真跑它（scripts/test-container-loading-page.ts），不只查源码字样。
 *
 *   edited：员工改过的时间（北京时间「2026-10-14T15:30」）；空串 = 没改 —— 后端用服务器当前时间记
 *   prevAt：当前这一步记的时间（装柜详情的 statusChangedAt）；没有（老柜子）就不比
 *
 * 「比上一步还早」客户轨迹会倒着排（线上有过 12 次），先问一句：
 *   改过时间：跟上一步严格比
 *   没改时间（Codex 10-14 第 1 轮）：上一步本身可能记在将来 —— 旧页面只给日期、记成北京 08:00，北京凌晨推下一步；
 *     或者旧日期框留下的 10-30 那种。这时按「现在」推照样倒着排。但上一步通常就是几分钟前按服务器时间推的，
 *     员工电脑慢几分钟不能误报，所以只在上一步比现在晚 10 分钟以上才问。
 */
import { beijingLocalToMs } from "../shared/beijing-date";

/** 允许比现在晚这么多（员工电脑时钟可能快 / 慢几分钟），跟后端 containers/status-time.ts 一样 */
export const PUSH_TIME_SLACK_MS = 10 * 60 * 1000;

export type PushTimeCheck =
  | { kind: "ok" }
  /** 时间框里不是完整的北京时间 */
  | { kind: "incomplete" }
  /** 填成了将来 */
  | { kind: "future" }
  /** 比上一步还早：atMs 是这次要记的时间（没改就是现在），prevMs 是上一步的时间 */
  | { kind: "earlier"; atMs: number; prevMs: number };

export function checkPushTime(edited: string, prevAt: string | null | undefined, nowMs: number = Date.now()): PushTimeCheck {
  const prevMs = prevAt ? Date.parse(prevAt) : Number.NaN;
  if (!edited) {
    if (!Number.isNaN(prevMs) && prevMs > nowMs + PUSH_TIME_SLACK_MS) return { kind: "earlier", atMs: nowMs, prevMs };
    return { kind: "ok" };
  }
  const atMs = beijingLocalToMs(edited);
  if (atMs === null) return { kind: "incomplete" };
  if (atMs > nowMs + PUSH_TIME_SLACK_MS) return { kind: "future" };
  if (!Number.isNaN(prevMs) && atMs < prevMs) return { kind: "earlier", atMs, prevMs };
  return { kind: "ok" };
}
