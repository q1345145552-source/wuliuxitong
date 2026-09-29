/**
 * 费用明细里的方数怎么显示（2026-09-29 老板选 A）。
 *
 * 原来一律 toFixed(3)：金额按精确方数算（0.057441 方 × 1200 = ¥68.93），屏幕上却写「0.057 方 × 1200 = ¥68.93」，
 * 客户一乘是 68.40，对不上（钱本身是对的）。现在：刚好 3 位小数以内的照旧写 3 位；不是的就写到精确值（最多 6 位、去掉末尾的 0），
 * 让「方数 × 单价」正好等于右边的金额。只管显示，不改任何一分钱。
 */
export function formatBreakdownVolume(v: number): string {
  if (!Number.isFinite(v)) return "—";
  // 先收到 6 位：不然 0.0000004、1.9999999 这种会走到下面去掉末尾 0，剩个「0.」「2.」（dsh 复核指出）
  const r = Number(v.toFixed(6));
  if (Math.abs(Number(r.toFixed(3)) - r) < 1e-9) return r.toFixed(3);
  return r.toFixed(6).replace(/0+$/, "");
}
