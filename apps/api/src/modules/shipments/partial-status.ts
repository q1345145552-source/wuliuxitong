import { prisma } from "../../db/prisma";
import { partialAheadStatus } from "../../../../../packages/shared-types/shipment-status";

type ParentRow = {
  trackingNo: string;
  currentStatus: string;
  packageCount?: number | null;
  transportMode?: string | null;
};

/**
 * 给三端列表补那句「（部分已放行）」。
 *
 * 主状态、分组、筛选、顶部四个数一律不动（老板 2026-09-16 拍板），这里只多给一个字段。
 * ⚠️ 一次把这批父单的子单查完，**不要在循环里查** —— 列表一页 500 行，N+1 会把库打爆。
 */
export async function loadPartialAhead(
  companyId: string,
  rows: ParentRow[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const parents = rows.map((r) => r.trackingNo).filter(Boolean);
  if (parents.length === 0) return out;

  const kids = await prisma.shipment.findMany({
    where: { companyId, parentTrackingNo: { in: parents } },
    select: { parentTrackingNo: true, currentStatus: true },
  });
  if (kids.length === 0) return out;

  const byParent = new Map<string, string[]>();
  for (const k of kids) {
    if (!k.parentTrackingNo) continue;
    const list = byParent.get(k.parentTrackingNo) ?? [];
    list.push(k.currentStatus);
    byParent.set(k.parentTrackingNo, list);
  }

  for (const r of rows) {
    const childStatuses = byParent.get(r.trackingNo);
    if (!childStatuses) continue;
    const ahead = partialAheadStatus(r.currentStatus, childStatuses, r.packageCount ?? null, r.transportMode ?? null);
    if (ahead) out.set(r.trackingNo, ahead);
  }
  return out;
}
