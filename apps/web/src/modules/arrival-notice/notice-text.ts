/**
 * 到货通知里「复制文案」那段话（2026-10-06）。
 *
 * 老板给的底子：「通常是 xx 唛头 xx 仓库到货多少件，这种，你润色一下看看」。
 * 第一句固定说唛头、到了哪个仓、多少件；下面几行有就写、没登记的那一行不出现；内部备注不进文案。
 * 改字只改这一个文件（测试 scripts/test-arrival-notice-source.ts 钉着样子）。
 *
 * 2026-10-09 多款（老板 10-08「很多时候有好几款」）：
 *   · 0 款 / 1 款：跟原来一字不差（用那一款的品名、件数、国内单号）；
 *   · 2 款及以上：第一句「共 2 款、17 件」，下面一款一行「1. 灯具 × 12 件　国内快递单号：…」，再一行「合计：…」。
 *     ⚠️ 多款的样子是统一方案第 4 节的示例，老板还没回话，定了只改这里。
 *   货型、单箱重、尺寸都不进文案。
 */
import { noticeProductTotals } from "../../../../../packages/shared-types/arrival-notice-products";

const WAREHOUSE_ZH: Record<string, string> = {
  wh_yiwu_01: "义乌仓",
  wh_guangzhou_01: "广州仓",
  wh_dongguan_01: "东莞仓",
  wh_shenzhen_01: "深圳仓",
};

export interface NoticeTextInput {
  clientId: string | null;
  warehouseId: string | null;
  /** 整票总重量 / 总体积 */
  weightKg: number | null;
  volumeM3: number | null;
  /** YYYY-MM-DD */
  arrivedAt: string | null;
  /** 各款（按页面顺序）。卡片上传的是 noticeProductsOf(n)，老后端没回 products 也拼得出一款 */
  products: ReadonlyArray<{ itemName: string | null; packageCount: number | null; domesticTrackingNo: string | null }>;
}

/** 2026-10-06 → 10月6日（客户看不用年份） */
function monthDay(date: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(date);
  return m ? `${Number(m[1])}月${Number(m[2])}日` : date;
}

export function buildArrivalNoticeText(n: NoticeTextInput): string {
  const who = n.clientId ? `唛头 ${n.clientId} 的货` : "您的货";
  const where = (n.warehouseId && WAREHOUSE_ZH[n.warehouseId]) || "仓";
  const size = [
    n.weightKg !== null ? `重量：${n.weightKg} 公斤` : "",
    n.volumeM3 !== null ? `体积：${n.volumeM3} 立方` : "",
  ].filter(Boolean);
  const lines: string[] = [];

  if (n.products.length <= 1) {
    // 0 款 / 1 款：跟原来一字不差
    const p = n.products[0] ?? { itemName: null, packageCount: null, domesticTrackingNo: null };
    const count = p.packageCount ? `，共 ${p.packageCount} 件` : "";
    lines.push(`您好！${who}已到${where}${count}。`);
    if (p.itemName) lines.push(`品名：${p.itemName}`);
    if (size.length) lines.push(size.join("　"));
    if (p.domesticTrackingNo) lines.push(`国内快递单号：${p.domesticTrackingNo}`);
  } else {
    // 2 款及以上：件数合计只在每款都有件数时才写（有一款没填就不写总数，免得说少了）
    const total = noticeProductTotals(n.products).packageCount;
    lines.push(`您好！${who}已到${where}，共 ${n.products.length} 款${total !== null ? `、${total} 件` : ""}。`);
    n.products.forEach((p, i) => {
      const name = p.itemName || "品名未登记";
      const count = p.packageCount !== null ? ` × ${p.packageCount} 件` : "";
      const no = p.domesticTrackingNo ? `　国内快递单号：${p.domesticTrackingNo}` : "";
      lines.push(`${i + 1}. ${name}${count}${no}`);
    });
    const sum = [total !== null ? `${total} 件` : "", ...size];
    if (sum.some(Boolean)) lines.push(`合计：${sum.filter(Boolean).join("　")}`);
  }

  if (n.arrivedAt) lines.push(`到仓日期：${monthDay(n.arrivedAt)}`);
  lines.push("如需安排发货或有疑问，请随时联系我们，谢谢！");
  return lines.join("\n");
}
