/* ==========================================================================
   财务运单列表的「下单月份」（2026-11-07 代理利润第 1 轮）
   --------------------------------------------------------------------------
   ⚠️ 纯函数，不碰数据库，scripts/test-finance-link-source.ts 直接测。
   ⚠️ 只认 YYYY-MM（四位年、两位月，01～12，年份 2020～2100），别的写法一律算格式不对 → 400。
      不复用代理端的 dateFrom / dateTo：那组筛的是到仓日期 shipDate，而且 2026-99-99 过得了它的格式检查。
   ⚠️ 月份按泰国时间（UTC+7）划：2026-11 = 2026-10-31T17:00:00.000Z（含）到 2026-11-30T17:00:00.000Z（不含）。
      老板同意「必须选月份才合计、按泰国时间分月」。
   ========================================================================== */

const ORDER_MONTH = /^(\d{4})-(\d{2})$/;
const YEAR_MIN = 2020;
const YEAR_MAX = 2100;
/** 泰国时间比 UTC 早 7 小时，没有夏令时 */
const THAI_OFFSET_MS = 7 * 60 * 60_000;

export const ORDER_MONTH_INVALID = "下单月份格式不对，请写成 2026-11 这种格式";

/** 一个月的起止：from 含、to 不含 */
export interface OrderMonthRange {
  from: Date;
  to: Date;
}

/** 泰国时间某年某月（月份 1～12）的起止。12 月的下一个月由 Date.UTC 自己进到下一年 1 月 */
export function orderMonthRange(year: number, month: number): OrderMonthRange {
  return {
    from: new Date(Date.UTC(year, month - 1, 1) - THAI_OFFSET_MS),
    to: new Date(Date.UTC(year, month, 1) - THAI_OFFSET_MS),
  };
}

/**
 * 读 orderMonth 参数：没传或空串 → undefined（不筛，跟原来一样）；格式不对 → null（调用方回 400）；对的 → 起止。
 * 不去首尾空格、不认全角数字（`\d` 不带 u 标志只认 0～9）；不是字符串的也算格式不对。
 */
export function parseOrderMonth(raw: unknown): OrderMonthRange | null | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (typeof raw !== "string") return null;
  const m = ORDER_MONTH.exec(raw);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (year < YEAR_MIN || year > YEAR_MAX || month < 1 || month > 12) return null;
  return orderMonthRange(year, month);
}
