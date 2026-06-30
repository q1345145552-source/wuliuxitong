// 运单状态流转定义，从 shipments/routes.ts 提取为共享模块
// 避免多个文件各自定义导致不一致和未导入引用错误

export const STATUS_FLOW = [
  "created",
  "loaded",
  "delayDeparted",
  "departed",
  "arrivedPort",
  "customsTH",
  "customsCleared",
  "inWarehouseTH",
  "outForDelivery",
  "delivered",
] as const;

export const EXCEPTION_STATUSES = new Set(["exception", "returned", "cancelled"]);

export const COMPLETED_STATUSES = new Set(["delivered", "returned", "cancelled"]);

export type ShipmentStatus = (typeof STATUS_FLOW)[number];
