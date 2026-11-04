/**
 * 运单状态 → 中文，给财务系统的 statusZh 用（2026-11-04）。
 *
 * 要跟物流客户端显示的一字不差：唯一来源是 apps/web/src/modules/shipment/shipment-status.ts 的
 * SHIPMENT_STATUS_ZH + CLIENT_STATUS_ZH_OVERRIDES（客户端把 delivered 叫「已签收」）。
 * ⚠️ 这里是抄的一份，不能直接 import：后台镜像（Dockerfile.api）只拷 apps/api 和 packages，没有 apps/web。
 *    scripts/test-finance-link-source.ts 逐条比对，那边改了这边没跟就红。
 */
export const WAYBILL_STATUS_ZH: Record<string, string> = {
  created: "已创建",
  pickedup: "已揽收",
  inwarehousecn: "已入库",
  pendinginbound: "待入库",
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
  delivered: "已签收",
  exception: "异常",
  returned: "已退回",
  cancelled: "已取消",
  customs: "清关中",
  loading: "装柜中",
  sealed: "已封柜",
  arrived: "已到港",
  unloading: "正在卸柜",
  in_warehouse_th: "已到仓",
  out_for_delivery: "派送中",
  signed: "已签收",
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

/** 跟客户端 shipmentStatusZh(status, CLIENT_STATUS_ZH_OVERRIDES) 同一个结果：空的写「—」，查不到写「未知状态」 */
export function waybillStatusZh(status: string | null | undefined): string {
  if (!status) return "—";
  const key = status.trim().toLowerCase();
  if (!key) return "—";
  return WAYBILL_STATUS_ZH[key] ?? "未知状态";
}
