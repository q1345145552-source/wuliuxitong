import type { UserRole, WarehouseScope } from "./role";
import type { ShipmentStatus } from "./shipment-status";

export type TransportMode = "sea" | "land";
export type PackageUnit = "bag" | "box";
export type StatusGroup = "unfinished" | "completed";

export interface User {
  id: string;
  companyId?: string;
  role: UserRole;
  name: string;
  phone: string;
  email?: string;
  status: "active" | "inactive";
  createdAt?: string;
  warehouseIds?: string[];
  scopeType?: WarehouseScope;
}

export interface Order {
  id: string;
  companyId?: string;
  clientId: string;
  pickupAddressCn: string;
  deliveryAddressTh: string;
  receiverName: string;
  receiverPhone: string;
  serviceType: "standard" | "express";
  remark?: string;
  createdAt?: string;
  updatedAt?: string;

  // Client/Staff/Admin 对齐字段
  itemName: string;
  productQuantity: number;
  packageCount: number;
  packageUnit?: PackageUnit;
  domesticTrackingNo?: string;
  orderNo?: string;
  transportMode?: TransportMode;
  warehouseId?: string;
  batchNo?: string;
  weightKg?: number;
  volumeM3?: number;
  receivableAmountCny?: number;
  receivableCurrency?: "CNY" | "THB";
  receiverNameTh?: string;
  receiverPhoneTh?: string;
  receiverAddressTh?: string;
  statusGroup?: StatusGroup;
}

export interface Shipment {
  id: string;
  companyId?: string;
  orderId: string;
  trackingNo: string;
  currentStatus: ShipmentStatus;
  currentLocation?: string;
  weightKg?: number;
  volumeM3?: number;
  freightAmount?: number;
  currency?: "CNY" | "THB";
  createdAt: string;
  updatedAt: string;

  // 物流补录统一字段
  domesticTrackingNo?: string;
  transportMode?: TransportMode;
  packageCount?: number;
  packageUnit?: PackageUnit;
  warehouseId?: string;
  batchNo?: string;
}

export interface PackageItem {
  id: string;
  shipmentId: string;
  packageNo: string;
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
  weightKg?: number;
  packageType?: "carton" | "pallet" | "other";
}

export interface StatusLog {
  id: string;
  companyId: string;
  shipmentId: string;
  operatorId: string;
  operatorName: string;
  operatorRole: string;
  fromStatus: ShipmentStatus;
  toStatus: ShipmentStatus;
  remark?: string;
  changedAt: string;
}

export interface DashboardOverview {
  staffAccountCount: number;
  clientAccountCount: number;
  newOrderCountToday: number;
  inTransitOrderCount: number;
  receivedVolumeM3Today: number;
}

export interface AiChatEvidence {
  orderIds?: string[];
  shipmentIds?: string[];
  updatedAt: string;
}

export interface AiQueryAuditLog {
  id: string;
  userId: string;
  companyId: string;
  sessionId?: string;
  question: string;
  answerSummary: string;
  referencedOrderIds?: string[];
  referencedShipmentIds?: string[];
  queriedAt: string;
}

export interface StatusLabelConfig {
  status: ShipmentStatus;
  labelZh: string;
}

export interface AiKnowledgeItem {
  id: string;
  companyId: string;
  title: string;
  content: string;
  createdBy: string;
  createdAt: string;
}