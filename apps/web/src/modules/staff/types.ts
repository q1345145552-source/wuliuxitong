import type { ReactNode } from "react";
import type { OrderProductImageItem, ShipmentItem } from "../../services/business-api";

export const MAX_ORDER_PRODUCT_IMAGES = 999;

export type OrderProductImagesPanelProps = {
  orderId: string;
  images: OrderProductImageItem[];
  canManage: boolean;
  busy: boolean;
  onSelectFile: (file: File) => void | Promise<void>;
  onDelete: (imageId: string) => void | Promise<void>;
};

export type ShipmentEditFormFieldProps = {
  label: string;
  required?: boolean;
  children: ReactNode;
};

export type ShipmentOrderEditDraft = {
  trackingNo: string;
  warehouseId: string;
  batchNo: string;
  itemName: string;
  domesticTrackingNo: string;
  productQuantity: string;
  packageCount: string;
  packageUnit: "bag" | "box";
  weightKg: string;
  volumeM3: string;
  orderCreatedDate: string;
  transportMode: "sea" | "land";
  shipLocal: string;
  receiverAddressTh: string;
  containerNo: string;
  receivableAmountCny: string;
  receivableCurrency: "CNY" | "THB";
  paymentStatus: "paid" | "unpaid";
  destinationCountry: string;
  customsDeclaration: "none" | "declare";
  remark: string;
};

export const STAFF_SECTION_IDS = [
  "staff-billing",
  "staff-prealert-review",
  "staff-create-order",
  "staff-ops-tools",
  "staff-order-shipment",
  "staff-lastmile",
  "staff-address",
  "staff-wallet",
  "staff-fcl",
] as const;

export type StaffSectionId = (typeof STAFF_SECTION_IDS)[number];

export type PrealertEditDraft = {
  warehouseId: string;
  itemName: string;
  packageCount: number;
  packageUnit: "bag" | "box";
  productQuantity: number;
  weightKg: number;
  volumeM3: number;
  receivableAmountCny: number;
  receivableCurrency: "CNY" | "THB";
  domesticTrackingNo: string;
  transportMode: "sea" | "land";
  shipDate: string;
};
