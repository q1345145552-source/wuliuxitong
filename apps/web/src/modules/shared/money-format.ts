/**
 * 金额统一显示两位小数、带千分位（2026-09-29 老板选 A）：原来好几处用裸的 toLocaleString()，
 * 300.10 会显示成「300.1」、1534.60 显示成「1,534.6」，跟同一个弹窗里用 toFixed(2) 的余额写法不一致。
 * 不带「¥」，调用处自己写（原来的写法就是「¥{…}」）。空值给「—」。
 */
export function amount2(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
