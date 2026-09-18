export type LastmileShipmentOption = {
  id: string;
  trackingNo: string;
  clientId: string;
  itemName: string;
  packageCount: number;
  containerNo?: string;
  receiverName?: string;
  receiverPhone?: string;
  receiverAddress?: string;
};

export type LastmileOrderItem = {
  id: string;
  deliveryNo: string;
  shipmentId: string;
  trackingNo?: string;
  clientId?: string | null;
  clientName?: string | null;
  receiverName?: string | null;
  receiverPhone?: string | null;
  receiverAddress?: string | null;
  itemName?: string | null;
  packageCount?: number | null;
  packageUnit?: string | null;
  driverName?: string | null;
  licensePlate?: string | null;
  phoneNumber?: string | null;
  deliveryDate?: string | null;
  hasSignImage?: boolean;
  status: string;
  updatedAt?: string;
};

export type LastmileCustomerGroup = {
  key: string;
  /** 唛头。卡片标题只显示唛头，不带客户名字（2026-09-19） */
  clientId: string;
  addressCount: number;
  orders: LastmileOrderItem[];
};

export type LastmileWdGroup = {
  deliveryNo: string;
  orders: LastmileOrderItem[];
  customers: LastmileCustomerGroup[];
  signed: number;
  total: number;
  done: boolean;
  addressCount: number;
};
