/**
 * 按北京时间取「哪一天」（2026-09-29 实跑发现）。
 *
 * 后端给的时间都是 UTC（2026-09-28T17:05:00.000Z），原来到处直接 `.slice(0, 10)` 取日期 ——
 * 北京时间 0 点到 8 点之间的记录会显示成**前一天**（实跑：北京 9-29 凌晨 1 点提交的整柜询价，列表写 2026-09-28，
 * 点开详情又写「9 月 29 日 01 点 05 分」）。导出文件名、表单默认日期也一样，早上 8 点前是昨天。
 * 中国不实行夏令时，固定 +8 小时。
 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 这个时刻在北京时间是哪一天（YYYY-MM-DD）。本来就是纯日期（2026-09-28）的原样返回；空的给空串 */
export function beijingDate(value: string | null | undefined): string {
  if (!value) return "";
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const t = new Date(text).getTime();
  if (Number.isNaN(t)) return text.slice(0, 10);
  return new Date(t + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

/** 北京时间的今天（YYYY-MM-DD）：表单默认日期、导出文件名用 */
export function beijingToday(): string {
  return new Date(Date.now() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 北京时间的「现在」，精确到分钟，写成 2026-10-14T15:30（时间输入框 datetime-local 要的格式）。
 * 装柜管理改状态的「时间」框默认就是它（2026-10-14 老板：默认现在、可以改）。
 */
export function beijingNowMinute(nowMs: number = Date.now()): string {
  return new Date(nowMs + BEIJING_OFFSET_MS).toISOString().slice(0, 16);
}

/** 把时间框里的北京时间（2026-10-14T15:30）换成真正的时刻（毫秒）；格式不对给 null */
export function beijingLocalToMs(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) - BEIJING_OFFSET_MS;
  return Number.isNaN(ms) ? null : ms;
}
