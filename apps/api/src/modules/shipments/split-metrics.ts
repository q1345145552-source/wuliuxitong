import type { Prisma } from "@prisma/client";

type NumericMetric = Prisma.Decimal | number | string | null | undefined;

/**
 * 按件数占比分配重量/体积。历史手工分柜子单没有保存这两个字段时，
 * 导出端用订单总量和原订单件数补算，不能把整票总量直接复制给子单。
 */
export function metricByPieceShare(
  total: NumericMetric,
  pieceCount: number | null | undefined,
  totalPieceCount: number | null | undefined,
  precision: number,
): number | null {
  if (total === null || total === undefined) return null;
  const numericTotal = Number(total.toString());
  const pieces = Number(pieceCount ?? 0);
  const allPieces = Number(totalPieceCount ?? 0);
  if (
    !Number.isFinite(numericTotal)
    || numericTotal < 0
    || !Number.isFinite(pieces)
    || !Number.isFinite(allPieces)
    || allPieces <= 0
  ) {
    return null;
  }
  const factor = 10 ** precision;
  return Math.round((numericTotal * Math.max(0, pieces) * factor) / allPieces) / factor;
}

/**
 * 把父单当前剩余的重量/体积精确分给多条手工子单，并返回父单余量。
 * 用累计最小单位分配，确保“所有子单 + 父单余量”严格等于拆分前总量，
 * 避免多条子单分别四舍五入后凭空多出或少掉 0.01kg / 0.001m³。
 */
export function allocateSplitMetric(
  total: NumericMetric,
  currentPieceCount: number,
  splitPieceCounts: number[],
  precision: number,
): { children: Array<number | null>; remaining: number | null } {
  if (total === null || total === undefined) {
    return { children: splitPieceCounts.map(() => null), remaining: null };
  }
  const numericTotal = Number(total.toString());
  const splitTotal = splitPieceCounts.reduce((sum, count) => sum + count, 0);
  if (
    !Number.isFinite(numericTotal)
    || numericTotal < 0
    || currentPieceCount <= 0
    || splitPieceCounts.some((count) => !Number.isInteger(count) || count <= 0)
    || splitTotal > currentPieceCount
  ) {
    throw new RangeError("invalid split metric allocation");
  }

  const factor = 10 ** precision;
  const totalUnits = Math.round(numericTotal * factor);
  let cumulativePieces = 0;
  let allocatedUnits = 0;
  const children = splitPieceCounts.map((count) => {
    cumulativePieces += count;
    const cumulativeUnits = Math.round((totalUnits * cumulativePieces) / currentPieceCount);
    const childUnits = cumulativeUnits - allocatedUnits;
    allocatedUnits = cumulativeUnits;
    return childUnits / factor;
  });
  return {
    children,
    remaining: (totalUnits - allocatedUnits) / factor,
  };
}

export type FamilyMetricPart = {
  key: string;
  pieceCount: number | null | undefined;
  value: NumericMetric;
  isParent: boolean;
};

/**
 * 归一父子运单家族的一项指标：已有子单的明确值保持不动，空子单按件数补算；
 * 若“父 + 子”不等于订单总量，则由父单吃掉差额。这样既兼容历史脏父单，
 * 又确保极小值/循环小数在最小计量单位上严格守恒。
 */
export function reconcileFamilyMetric(
  orderTotal: NumericMetric,
  orderPieceCount: number | null | undefined,
  parts: FamilyMetricPart[],
  precision: number,
): Record<string, number | null> {
  const factor = 10 ** precision;
  // trackingNo 是外部数据，普通对象会被 "__proto__" 等键污染。
  const result = Object.create(null) as Record<string, number | null>;
  const numeric = (value: NumericMetric): number | null => {
    if (value === null || value === undefined) return null;
    const parsed = Number(value.toString());
    return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * factor) / factor : null;
  };
  for (const part of parts) result[part.key] = numeric(part.value);

  const parent = parts.find((part) => part.isParent);
  const children = parts.filter((part) => !part.isParent);
  const total = numeric(orderTotal);
  const configuredTotalPieces = Number(orderPieceCount ?? 0);
  const sorted = [...parts].sort((a, b) => a.key.localeCompare(b.key));
  const pieceCountsValid = sorted.every((part) => Number.isInteger(part.pieceCount) && Number(part.pieceCount) >= 0);
  const familyPieceCount = sorted.reduce((sum, part) => sum + Number(part.pieceCount ?? 0), 0);
  const totalPieces = configuredTotalPieces > 0 ? configuredTotalPieces : familyPieceCount;
  if (
    !parent
    || total === null
    || !Number.isInteger(configuredTotalPieces)
    || configuredTotalPieces < 0
    || !Number.isInteger(totalPieces)
    || totalPieces <= 0
  ) {
    return result;
  }
  if (children.length === 0) {
    if (result[parent.key] === null) {
      result[parent.key] = metricByPieceShare(total, parent.pieceCount, totalPieces, precision);
    }
    return result;
  }

  // 先按稳定 key 对完整家族做一次最小单位分配，空子单从这里取值；
  // 父单最后再用订单总量减所有子单，因此会自然吃掉舍入余数。
  // 历史上订单件数可能被改得比既有子单还小；此时按家族现有件数作为分母，
  // 仍要把订单总量完整且守恒地分完。
  const allocationPieceCount = familyPieceCount > totalPieces ? familyPieceCount : totalPieces;
  const shareByKey = Object.create(null) as Record<string, number | null>;
  let shareRemaining = 0;
  if (pieceCountsValid && allocationPieceCount > 0) {
    const positive = sorted.filter((part) => Number(part.pieceCount) > 0);
    const allocation = allocateSplitMetric(
      total,
      allocationPieceCount,
      positive.map((part) => Number(part.pieceCount)),
      precision,
    );
    positive.forEach((part, index) => { shareByKey[part.key] = allocation.children[index] ?? null; });
    sorted.filter((part) => Number(part.pieceCount) === 0).forEach((part) => { shareByKey[part.key] = 0; });
    shareRemaining = allocation.remaining ?? 0;
  }

  let hadMissingChild = false;
  let childUnits = 0;
  for (const child of children) {
    let value = numeric(child.value);
    if (value === null) {
      hadMissingChild = true;
      value = shareByKey[child.key]
        ?? metricByPieceShare(total, child.pieceCount, totalPieces, precision)
        ?? 0;
      result[child.key] = value;
    }
    childUnits += Math.round(value * factor);
  }

  const totalUnits = Math.round(total * factor);
  // 若旧子单本身已经超过后来修改过的订单总量，单靠把父单归零仍不守恒；
  // 此时整族回到按件数累计分配的口径。
  if (childUnits > totalUnits && pieceCountsValid && allocationPieceCount > 0) {
    for (const part of parts) result[part.key] = shareByKey[part.key] ?? 0;
    result[parent.key] = Number(((result[parent.key] ?? 0) + shareRemaining).toFixed(precision));
    return result;
  }
  if (childUnits > totalUnits) {
    // 件数缺失时无法按件数重分，退而按现有非负指标比例缩到订单总量；
    // 累计最小单位计算保证最后仍严格守恒。
    const sourceUnits = sorted.map((part) => Math.round((numeric(part.value) ?? 0) * factor));
    const sourceTotal = sourceUnits.reduce((sum, units) => sum + units, 0);
    if (sourceTotal > 0) {
      let cumulativeSource = 0;
      let allocated = 0;
      sorted.forEach((part, index) => {
        cumulativeSource += sourceUnits[index] ?? 0;
        const cumulativeTarget = Math.round((totalUnits * cumulativeSource) / sourceTotal);
        result[part.key] = (cumulativeTarget - allocated) / factor;
        allocated = cumulativeTarget;
      });
    } else {
      for (const part of parts) result[part.key] = part.isParent ? total : 0;
    }
    return result;
  }
  const parentValue = numeric(parent.value);
  const familyConserves = parentValue !== null
    && Math.round(parentValue * factor) + childUnits === totalUnits;
  if (hadMissingChild || !familyConserves) {
    result[parent.key] = Math.max(0, totalUnits - childUnits) / factor;
  }
  return result;
}

/**
 * 这一票是不是装着「整张订单的全部货」（2026-10-07，老板：整柜派送清单「没有分详细」）。
 *
 * 产品行挂在订单上，不挂在运单上。现在装柜一律切子单（整票装也会切出 -1），
 * 所以以前两种导出看到子单就不展开产品行 —— 怕货拆到两个柜时，
 * 每个柜都把整张订单的产品件数印一遍。结果整票装柜的货也全被压成一行。
 *
 * 判断「可以放心展开」要三条同时成立：
 *   ① 订单有产品行；
 *   ② 产品行件数合计 = 这一票要印的件数（装柜件数 / 派送件数）；
 *   ③ 订单下其它运单（父单、别的子单）件数都是 0 —— 货没有留在别处。
 * 件数没填（null）的一律当「不知道」，不展开，宁可照旧合并成一行。
 */
export function holdsWholeOrder(
  trackingNo: string,
  pieceCount: number | null | undefined,
  orderShipments: ReadonlyArray<{ trackingNo: string; packageCount: number | null }>,
  products: ReadonlyArray<{ packageCount: number }>,
): boolean {
  if (products.length === 0 || !Number.isInteger(pieceCount) || Number(pieceCount) <= 0) return false;
  const productPieces = products.reduce((sum, product) => sum + Number(product.packageCount || 0), 0);
  if (productPieces !== pieceCount) return false;
  return orderShipments.every((part) => part.trackingNo === trackingNo || part.packageCount === 0);
}
