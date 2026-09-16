/* ==========================================================================
   运单状态 → 中文（三端唯一一份）
   ------------------------------------------------------------------------
   2026-08-07：客户端原来自己写了一份小的对照表，漏了 pickedUp、inWarehouseCN，
   客户在「物流状态」那一列直接看到英文单词。系统要求全中文，所以合并到这里。

   ⚠️ key 一律小写，查表前会 toLowerCase()。新加状态两件事：
      1. 在这里补一行；
      2. 如果它还要在轨迹弹窗里显示，去 ShipmentTrackModal.tsx 的 STATUS_CONFIG
         补一行颜色（那边只管颜色，中文从这里取）。
   ========================================================================== */

import { SHIPMENT_STATUS_FLOW, SHIPMENT_STATUS_FLOW_LAND } from "../../../../../packages/shared-types/shipment-status";

export const SHIPMENT_STATUS_ZH: Record<string, string> = {
  created: "已创建",
  pickedup: "已揽收",
  /* 2026-09-02：inWarehouseCN 进了运单状态流程（created → 已入库 → …），
     老板定的中文是「已入库」。原来这里写「国内仓已收货」——
     老轨迹里的 inWarehouseCN 会跟着改叫「已入库」，意思一样。
     receivedcn 是另一个只在老数据里出现的状态，保持旧叫法不动。 */
  inwarehousecn: "已入库",
  receivedcn: "国内仓已收货",
  customspending: "报关中",
  holdloading: "暂缓柜",
  loaded: "已装柜",
  customsinspectcn: "国内海关查验",
  inspectclearedcn: "国内查验放行",
  delaydeparted: "延迟开船",
  delay_departed: "延迟开船",
  etaupdated: "到港时间更新",
  portclosed: "港口封港暂停作业",
  berthed: "已靠泊",
  departed: "已开船",
  customsinspectth: "泰国海关查验",
  inspectclearedth: "泰国查验放行",
  deliverybooked: "预约派送",
  delayintransit: "延迟运输",
  delay_in_transit: "延迟运输",
  arrivedport: "已到港",
  intransit: "运输中",
  // 陆运专属环节（2026-08-06）
  atportcn: "到达凭祥口岸",
  exportcleared: "出口已放行",
  invietnam: "过境越南",
  laoscleared: "老挝边境已放行",
  borderdelay: "口岸滞留",
  customsinspect: "海关查验",
  customsth: "清关中",
  customscleared: "清关已放行",
  inwarehouseth: "已到仓",
  warehouseth: "已到仓",
  outfordelivery: "派送中",
  delivered: "派送完成",
  exception: "异常",
  returned: "已退回",
  cancelled: "已取消",
  // 柜子状态（老轨迹里混进过柜子的状态值，一并认掉，免得漏出英文）
  customs: "清关中",
  loading: "装柜中",
  sealed: "已封柜",
  arrived: "已到港",
  unloading: "正在卸柜",
  in_warehouse_th: "已到仓",
  out_for_delivery: "派送中",
  signed: "已签收",
  // 2026-08-13 新增那 8 个的柜子写法（下划线），同理一并认掉
  hold_loading: "暂缓柜",
  customs_inspect_cn: "国内海关查验",
  inspect_cleared_cn: "国内查验放行",
  export_cleared: "出口已放行",
  eta_updated: "到港时间更新",
  port_closed: "港口封港暂停作业",
  customs_inspect_th: "泰国海关查验",
  inspect_cleared_th: "泰国查验放行",
  delivery_booked: "预约派送",
};

/**
 * 客户端对 delivered 一直叫「已签收」，员工端/轨迹叫「派送完成」。
 * 这次只补漏翻译，不改任何已有文案，所以把差异放在这里。
 */
export const CLIENT_STATUS_ZH_OVERRIDES: Record<string, string> = {
  delivered: "已签收",
};

/* ==========================================================================
   运单列表「按状态筛选」下拉的选项（员工端 + 管理员端共用一份）
   ------------------------------------------------------------------------
   2026-08-13：原来员工端和管理员端各自写死一份中文清单（10 个 / 15 个），
   加状态时没人记得回来改，实测缺了 16 个 / 15 个 ——
   连 2026-08-06 加的陆运五步（到达凭祥口岸、过境越南、老挝边境已放行……）
   **从上线那天起就一直筛不到**。筛选本身是好的（比对走的是上面那份中文表），
   纯粹是选项列表没跟上。

   所以改成从流程表直接生成：加状态只改流程表，这里自动跟着变。
   顺序＝海运流程走完，再接上陆运独有的几步。
   ⚠️ 开头那三个（已揽收 / 国内仓已收货 / 报关中）不在任何流程里，
      是老数据里出现过的状态，原来管理员端筛得到，别把人家的功能筛没了。
   ========================================================================== */

const LEGACY_FILTER_STATUSES = ["已揽收", "国内仓已收货", "报关中"];

export const SHIPMENT_STATUS_FILTER_OPTIONS: string[] = (() => {
  const out: string[] = [];
  const push = (label: string) => {
    if (label && label !== "未知状态" && !out.includes(label)) out.push(label);
  };
  // 「已创建」是两条流程的第一步，先放它，再插老数据那三个，顺序才像话
  push(shipmentStatusZh(SHIPMENT_STATUS_FLOW[0]));
  LEGACY_FILTER_STATUSES.forEach(push);
  SHIPMENT_STATUS_FLOW.forEach((s) => push(shipmentStatusZh(s)));
  SHIPMENT_STATUS_FLOW_LAND.forEach((s) => push(shipmentStatusZh(s)));
  // 2026-08-31（复查条目25）：异常 / 已退回 / 已取消 三个终态不在任何流程表里，
  // 列表那一列能显示出来（SHIPMENT_STATUS_ZH 里有），下拉里却一直选不到。
  // 追加到末尾，三端（员工/管理员/客户端）共用这份清单，改这一处一起补齐。
  ["exception", "returned", "cancelled"].forEach((s) => push(shipmentStatusZh(s)));
  return out;
})();

/**
 * 状态转中文。查不到时返回「未知状态」而不是把英文原样吐给用户，
 * 同时在控制台留一条警告，方便发现是哪个状态漏配了。
 */
export function shipmentStatusZh(
  status: string | undefined | null,
  overrides?: Record<string, string>,
): string {
  if (!status) return "—";
  const key = status.trim().toLowerCase();
  if (!key) return "—";
  const zh = overrides?.[key] ?? SHIPMENT_STATUS_ZH[key];
  if (zh) return zh;
  if (typeof console !== "undefined") {
    console.warn(`[状态未翻译] 运单状态 "${status}" 没有中文对照，去 modules/shipment/shipment-status.ts 补一行`);
  }
  return "未知状态";
}

/**
 * 列表那一列显示的文字：主状态 +「（部分已放行）」。
 *
 * 老板 2026-09-16 拍板：拆了子单、子单进度不一样时，主状态仍按**最慢的那批**（分组、筛选、
 * 顶部四个数一个字不改，一票货只进一个页签），后面补一句把话说全。
 * partialAhead 由后端下发（三端列表接口都有），为空就只显示主状态。
 */
export function shipmentStatusWithPartialZh(
  status: string | null | undefined,
  partialAhead: string | null | undefined,
  overrides?: Record<string, string>,
): string {
  const main = shipmentStatusZh(status, overrides);
  if (!partialAhead) return main;
  return `${main}（部分${shipmentStatusZh(partialAhead, overrides)}）`;
}
