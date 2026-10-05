/**
 * 到货通知的几条规矩（2026-10-06 老板拍板），抽出来给别的模块引用，免得各写各的字。
 * 规格原话见 schema.prisma 里 ArrivalNotice 那段注释。
 */

/** 运单的「待入库」状态值（中文「待入库」）。故意不进流程表，见 packages/shared-types/shipment-status.ts */
export const PENDING_INBOUND = "pendingInbound";

/**
 * 「运单管理」里改「待入库」的单时说的话。
 * 待入库那张运单的底稿是到货通知那一行：在那边存，会同步改运单；
 * 两边都让改，就会你盖我、我盖你（在运单管理改完，到货通知一存又改回去）。所以只留到货通知一个入口。
 */
export const PENDING_INBOUND_EDIT_ELSEWHERE_MESSAGE =
  "这票货还是「待入库」，资料请到「到货通知」里补，补全后点「转正式运单」";

/** 转正式运单要齐的几项（跟员工端「创建订单」一样，老板 10-06：「没错，就这样」） */
export const FORMAL_REQUIRED_LABELS = ["运单号", "唛头", "品名", "仓库", "运输方式", "到仓日期", "件数", "重量", "体积"] as const;

/** 转待入库至少要的两项（老板 10-06：「必须填运单号才能转」；运单一定要挂在某个客户名下，所以唛头也得有） */
export const INBOUND_REQUIRED_LABELS = ["运单号", "唛头"] as const;

/** 四个国内仓（同 orders/routes.ts 的 RECEIVE_WAREHOUSE_IDS、fcl-containers 的 WAREHOUSE_IDS） */
export const ARRIVAL_WAREHOUSE_IDS = ["wh_yiwu_01", "wh_guangzhou_01", "wh_dongguan_01", "wh_shenzhen_01"] as const;
