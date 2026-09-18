import type {
  LastmileCustomerGroup,
  LastmileOrderItem,
  LastmileWdGroup,
} from "./types";

const textOf = (value: unknown): string => String(value ?? "").trim();

const normalized = (value: unknown): string => textOf(value).toLocaleLowerCase();

const addressKeyOf = (order: LastmileOrderItem): string => normalized(order.receiverAddress);

function groupCustomers(orders: LastmileOrderItem[]): LastmileCustomerGroup[] {
  const grouped = new Map<string, LastmileOrderItem[]>();
  for (const order of orders) {
    const clientId = textOf(order.clientId) || "未标记客户";
    const rows = grouped.get(clientId) ?? [];
    rows.push(order);
    grouped.set(clientId, rows);
  }
  return [...grouped.entries()].map(([clientId, rows]) => ({
    key: clientId,
    clientId,
    addressCount: new Set(rows.map(addressKeyOf).filter(Boolean)).size,
    orders: rows,
  }));
}

/**
 * 先按完整 WD 分组，再搜索整张卡。
 * 不能先过滤行再签收计数，否则搜中一票时会把 1/3 误算成 1/1。
 */
export function buildLastmileWdGroups(orders: LastmileOrderItem[]): LastmileWdGroup[] {
  const grouped = new Map<string, LastmileOrderItem[]>();
  for (const order of orders) {
    const deliveryNo = textOf(order.deliveryNo) || "未编号";
    const rows = grouped.get(deliveryNo) ?? [];
    rows.push(order);
    grouped.set(deliveryNo, rows);
  }
  return [...grouped.entries()].map(([deliveryNo, rows]) => {
    const signed = rows.filter((row) => row.status === "SIGNED").length;
    const customers = groupCustomers(rows);
    return {
      deliveryNo,
      orders: rows,
      customers,
      signed,
      total: rows.length,
      done: rows.length > 0 && signed === rows.length,
      addressCount: new Set(rows.map(addressKeyOf).filter(Boolean)).size,
    };
  });
}

export type LastmileStatusFilter = "all" | "active" | "done";

export function filterLastmileWdGroups(
  groups: LastmileWdGroup[],
  keyword: string,
  status: LastmileStatusFilter,
): LastmileWdGroup[] {
  const query = normalized(keyword);
  return groups.filter((group) => {
    if (status === "active" && group.done) return false;
    if (status === "done" && !group.done) return false;
    if (!query) return true;
    const searchable = [
      group.deliveryNo,
      ...group.orders.flatMap((order) => [
        order.trackingNo,
        order.clientId,
        order.clientName,
        order.receiverName,
        order.receiverPhone,
        order.receiverAddress,
        order.itemName,
        order.driverName,
        order.licensePlate,
        order.phoneNumber,
        order.deliveryDate,
      ]),
    ];
    return searchable.some((value) => normalized(value).includes(query));
  });
}

export function summarizeLastmileMeta(values: Array<string | null | undefined>): {
  display: string;
  full: string;
} {
  const unique = [...new Set(values.map(textOf).filter(Boolean))];
  // 2026-08-25：没填就留空，不要写「未填写」三个字。
  // 生产实测 6 张 WD 卡片里有 16 个格子是空的，整屏灰字「未填写」只是噪音 ——
  // 司机/车牌/电话/日期本来就都是选填的，没填是常态，不是异常。
  if (unique.length === 0) return { display: "", full: "" };
  if (unique.length === 1) return { display: unique[0], full: unique[0] };
  return { display: `${unique[0]} 等 ${unique.length} 项`, full: unique.join(" / ") };
}

export function lastmileSummaryOf(groups: LastmileWdGroup[]) {
  const activeGroups = groups.filter((group) => !group.done);
  return {
    totalWd: groups.length,
    activeWd: activeGroups.length,
    doneWd: groups.length - activeGroups.length,
    pendingShipments: activeGroups.reduce((sum, group) => sum + group.total - group.signed, 0),
  };
}
