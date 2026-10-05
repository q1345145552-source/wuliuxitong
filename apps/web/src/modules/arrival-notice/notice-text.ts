/**
 * 到货通知里「复制文案」那段话（2026-10-06）。
 *
 * 老板给的底子：「通常是 xx 唛头 xx 仓库到货多少件，这种，你润色一下看看」。
 * 第一句固定说唛头、到了哪个仓、多少件；下面几行有就写、没登记的那一行不出现；内部备注不进文案。
 * 改字只改这一个文件（测试 scripts/test-arrival-notice-source.ts 钉着样子）。
 */

const WAREHOUSE_ZH: Record<string, string> = {
  wh_yiwu_01: "义乌仓",
  wh_guangzhou_01: "广州仓",
  wh_dongguan_01: "东莞仓",
  wh_shenzhen_01: "深圳仓",
};

export interface NoticeTextInput {
  clientId: string | null;
  warehouseId: string | null;
  packageCount: number | null;
  itemName: string | null;
  weightKg: number | null;
  volumeM3: number | null;
  domesticTrackingNo: string | null;
  /** YYYY-MM-DD */
  arrivedAt: string | null;
}

/** 2026-10-06 → 10月6日（客户看不用年份） */
function monthDay(date: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(date);
  return m ? `${Number(m[1])}月${Number(m[2])}日` : date;
}

export function buildArrivalNoticeText(n: NoticeTextInput): string {
  const who = n.clientId ? `唛头 ${n.clientId} 的货` : "您的货";
  const where = (n.warehouseId && WAREHOUSE_ZH[n.warehouseId]) || "仓";
  const count = n.packageCount ? `，共 ${n.packageCount} 件` : "";
  const lines = [`您好！${who}已到${where}${count}。`];
  if (n.itemName) lines.push(`品名：${n.itemName}`);
  const size = [
    n.weightKg !== null ? `重量：${n.weightKg} 公斤` : "",
    n.volumeM3 !== null ? `体积：${n.volumeM3} 立方` : "",
  ].filter(Boolean);
  if (size.length) lines.push(size.join("　"));
  if (n.domesticTrackingNo) lines.push(`国内快递单号：${n.domesticTrackingNo}`);
  if (n.arrivedAt) lines.push(`到仓日期：${monthDay(n.arrivedAt)}`);
  lines.push("如需安排发货或有疑问，请随时联系我们，谢谢！");
  return lines.join("\n");
}
