/**
 * 物流轨迹弹窗「装柜时间」那一块用的柜子信息（2026-10-18 全系统审查 A-P2-3 / B-P2-3 / B-P3-1）。
 *
 * ① 现在装柜一律先拆子单、柜里记的是子单（loading-manifests「全部走子运单」），父单自己身上没有柜关系。
 *    原来轨迹接口只看父单自己的柜 —— 从列表点父单（客户、员工、超管、代理都是点父单）看轨迹，
 *    「装柜时间」那块永远是空的，已装方数 / 拆了几个柜也都是 0。现在把父单 + 全部子单装过的柜合起来，同一个柜只出现一次。
 * ② 「清关放行」日期：柜子推进到「清关已放行」时只记进了状态时间表（statusDates），专门那一列 customsClearedAt
 *    全系统没有地方写 —— 读的时候那一列空着就从状态时间表里取（撤销状态时状态时间表会跟着退回去，取到的就是现在的）。
 *    不改库里的数，老柜子也能显示出来。
 */

type ContainerDates = {
  customsClearedAt: Date | null;
  statusDates: string | null;
};

/** 清关放行日期：专门那一列有就用它，没有就看状态时间表里「清关已放行」那一格（海运、陆运都叫 CUSTOMS_CLEARED） */
export function customsClearedAtOf(container: ContainerDates): string | null {
  if (container.customsClearedAt) return container.customsClearedAt.toISOString();
  if (!container.statusDates) return null;
  try {
    const dates = JSON.parse(container.statusDates) as Record<string, unknown>;
    const at = dates?.CUSTOMS_CLEARED;
    if (typeof at !== "string") return null;
    const d = new Date(at);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}

type FamilyItem<C, V> = {
  containerId: string;
  loadedVolumeM3: V;
  loadedPieceCount?: number | null;
  container: C;
};

/**
 * 父单 + 子单装过的柜，按柜合并（同一个柜里装了这票货的好几张子单，只算一个柜，装的方数 / 件数加起来）。
 * 顺序按柜子建的先后（跟原来父单那份一样）。
 */
export function familyContainers<C extends { createdAt: Date }, V>(
  items: ReadonlyArray<FamilyItem<C, V>>,
  toNumber: (v: V) => number,
): Array<{ containerId: string; container: C; loadedVolumeM3: number; loadedPieceCount: number }> {
  const byId = new Map<string, { containerId: string; container: C; loadedVolumeM3: number; loadedPieceCount: number }>();
  for (const it of items) {
    const cur = byId.get(it.containerId);
    const vol = it.loadedVolumeM3 == null ? 0 : toNumber(it.loadedVolumeM3) || 0;
    const pcs = it.loadedPieceCount ?? 0;
    if (cur) {
      cur.loadedVolumeM3 += vol;
      cur.loadedPieceCount += pcs;
    } else {
      byId.set(it.containerId, { containerId: it.containerId, container: it.container, loadedVolumeM3: vol, loadedPieceCount: pcs });
    }
  }
  return [...byId.values()].sort((a, b) => a.container.createdAt.getTime() - b.container.createdAt.getTime());
}
