/**
 * 到货通知「转正式运单还缺哪几项」（2026-10-06）—— 页面上先提示一句，真正说了算的是后端
 * （apps/api/src/modules/arrival-notices/routes.ts 的 missingForTarget）。
 * 两边同一张单子、同一个顺序（跟「创建订单」弹窗一样），测试 test:arrival-notice-source 拿两边逐条比。
 */
export interface MissingInput {
  trackingNo: string | null;
  clientId: string | null;
  itemName: string | null;
  warehouseId: string | null;
  transportMode: string | null;
  arrivedAt: string | null;
  packageCount: number | null;
  weightKg: number | null;
  volumeM3: number | null;
}

export function missingForFormal(n: MissingInput): string[] {
  const out: string[] = [];
  if (!n.trackingNo) out.push("运单号");
  if (!n.clientId) out.push("唛头");
  if (!n.itemName) out.push("品名");
  if (!n.warehouseId) out.push("仓库");
  if (!n.transportMode) out.push("运输方式");
  if (!n.arrivedAt) out.push("到仓日期");
  if (n.packageCount === null) out.push("件数");
  if (n.weightKg === null) out.push("重量");
  if (n.volumeM3 === null) out.push("体积");
  return out;
}
