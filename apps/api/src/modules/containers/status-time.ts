/**
 * 推柜子状态时员工手填的时间（2026-10-14，老板：「装柜管理那里修改状态的时候，加个时间吧。默认状态的时间是现在，
 * 也可以去改时间，因为有时候会有一两天的误差」）。
 *
 * 两种写法都认：
 *   「2026-10-12T14:30」（T 也可以是空格，带秒也认、秒丢掉）：页面现在发的，按**北京时间**解（系统里所有时间都按北京时间显示，轨迹也是）
 *   「2026-10-12」：只给日期的老写法（上线那几秒还开着旧页面的人、测试脚本），照旧记成那天 0 点（服务器时区，
 *    线上是 UTC，轨迹里显示北京 08:00）—— 跟 2026-09-29 以来的行为一模一样
 * 不是真实存在的日子（2 月 31 日）、时分越界、别的格式（2026/09/01、abc）→ null，调用方回 400。
 */

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
/** 带时分的手填时间允许比现在晚这么多（员工电脑时钟可能快几分钟） */
const FUTURE_SLACK_MS = 10 * 60 * 1000;

export interface StatusTime {
  at: Date;
  /** 老写法：只给了日期 */
  dateOnly: boolean;
  /** 这个时间在北京是哪一天（YYYY-MM-DD） */
  beijingDate: string;
}

export function parseStatusTime(raw: string): StatusTime | null {
  // 带秒的也认（个别浏览器时间框给 …T15:30:00），秒丢掉（dsh 10-14 第 1 轮）
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(raw);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() + 1 !== mo || day.getUTCDate() !== d) return null;
  const ymd = `${m[1]}-${m[2]}-${m[3]}`;
  if (m[4] === undefined) {
    const at = new Date(`${ymd}T00:00:00`);
    if (Number.isNaN(at.getTime())) return null;
    return { at, dateOnly: true, beijingDate: ymd };
  }
  const hh = Number(m[4]);
  const mm = Number(m[5]);
  if (hh > 23 || mm > 59 || (m[6] !== undefined && Number(m[6]) > 59)) return null;
  return { at: new Date(Date.UTC(y, mo - 1, d, hh, mm) - BEIJING_OFFSET_MS), dateOnly: false, beijingDate: ymd };
}

/**
 * 填成了将来（线上 10-08 有一次把清关放行填成了 10-30）。推状态记的是已经发生的事，将来的时间会让客户轨迹里出现还没到的日子。
 * 带时分的：晚于现在 10 分钟以上算将来；只给日期的老写法：按北京日期比，晚于北京今天才算（北京今天 0～8 点之间选「今天」不误拦）。
 */
export function isFutureStatusTime(t: StatusTime, nowMs: number = Date.now()): boolean {
  if (t.dateOnly) return t.beijingDate > new Date(nowMs + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
  return t.at.getTime() > nowMs + FUTURE_SLACK_MS;
}
