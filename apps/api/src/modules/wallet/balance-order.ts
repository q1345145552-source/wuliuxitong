/**
 * 客户余额列表的默认顺序（2026-11-27 老板在正式站看了：122 个客户一屏全是 ¥0.00，有钱的两个埋在后面）。
 * 管理员打开这一页最想看「谁是负数、谁账上有钱」：
 *   ① 负数的排最前（负得多的在上）→ ② 有余额的（多的在上）→ ③ 余额是 0 的。
 *   同一档里余额一样的，照原来的顺序（调用方传进来时已经按唛头排好，这里用稳定排序不打乱）。
 * 金额按 Decimal 比，不经过浮点。管理员「客户余额」页（/staff/wallet/clients）和员工「客户余额」那一栏（/staff/wallet/balances）共用。
 */
import { Prisma } from "@prisma/client";

/** 0 = 负数，1 = 有余额，2 = 0 */
function tier(balance: Prisma.Decimal): number {
  if (balance.lt(0)) return 0;
  if (balance.gt(0)) return 1;
  return 2;
}

/** 按上面的规矩排好（返回新数组，不改传进来的） */
export function sortByBalanceForList<T>(rows: readonly T[], balanceOf: (row: T) => Prisma.Decimal): T[] {
  return [...rows].sort((a, b) => {
    const ba = balanceOf(a);
    const bb = balanceOf(b);
    const ta = tier(ba);
    const tb = tier(bb);
    if (ta !== tb) return ta - tb;
    if (ta === 0) return ba.comparedTo(bb); // 负数：负得多（小）的在上
    if (ta === 1) return bb.comparedTo(ba); // 有余额：多的在上
    return 0; // 0：保持原来按唛头的顺序（Array.prototype.sort 是稳定排序）
  });
}
