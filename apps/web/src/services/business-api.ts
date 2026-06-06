import { authHeaders, apiBaseUrl, parseApiResponse } from "./core-api";

export interface StaffCreateOrderPayload {
  clientId: string;
  warehouseId: string;
  batchNo?: string;
  trackingNo?: string;
  arrivedAt: string;
  itemName: string;
  productQuantity?: number;
  packageCount: number;
  packageUnit: "bag" | "box";
  weightKg?: number;
  volumeM3?: number;
  domesticTrackingNo?: string;
  transportMode: "sea" | "land";
  cargoType?: string;
  receiverNameTh?: string;
  receiverPhoneTh?: string;
  receiverAddressTh?: string;
  products?: Array<{
    itemName: string;
    packageCount: number;
    lengthCm?: number;
    widthCm?: number;
    heightCm?: number;
    productQuantity?: number;
    cargoType?: string;
    domesticTrackingNo?: string;
  }>;
}

export interface ClientPrealertPayload {
  warehouseId: string;
  itemName: string;
  packageCount: number;
  packageUnit: "bag" | "box";
  weightKg?: number;
  volumeM3?: number;
  shipDate?: string;
  domesticTrackingNo?: string;
  transportMode: "sea" | "land";
  receiverNameTh?: string;
  receiverPhoneTh?: string;
  receiverAddressTh?: string;
  trackingNo?: string;
}

export interface ClientAddressItem {
  id: string;
  companyId: string;
  clientId: string;
  contactName: string;
  contactPhone: string;
  addressDetail: string;
  lat?: number;
  lng?: number;
  label?: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PublicTrackResult {
  trackingNo: string;
  domesticTrackingNo?: string;
  batchNo?: string;
  orderId: string;
  itemName: string;
  currentStatus: string;
  currentLocation?: string;
  updatedAt: string;
  events: Array<{
    fromStatus: string;
    toStatus: string;
    remark: string;
    changedAt: string;
  }>;
}

export interface UniversalExpressTrackResult {
  trackingNo: string;
  companyCode: string;
  statusCode: string;
  statusText: string;
  events: Array<{
    time: string;
    content: string;
  }>;
}

export interface ClientWalletOverview {
  accounts: Array<{
    currency: string;
    balance: number;
    updatedAt: string;
  }>;
  exchangeRate: {
    pair: string;
    rate: number;
    updatedAt: string;
  };
}

export interface OrderProductImageItem {
  id: string;
  fileName: string;
  mime: string;
  contentBase64: string;
  filePath?: string | null;
  imageUrl?: string;
  createdAt: string;
}

export interface ShipmentItem {
  id: string;
  orderId?: string;
  orderNo?: string;
  trackingNo: string;
  batchNo?: string;
  containerNo?: string;
  cargoType?: string;
  clientId?: string;
  clientName?: string;
  itemName?: string;
  domesticTrackingNo?: string;
  packageCount?: number;
  packageUnit?: "bag" | "box";
  productQuantity?: number;
  weightKg?: number;
  volumeM3?: number;
  arrivedAt?: string;
  currentStatus: string;
  currentLocation?: string;
  updatedAt?: string;
  warehouseId?: string;
  transportMode?: string;
  shipDate?: string;
  receiverAddressTh?: string;
  receivableAmountCny?: number;
  receivableCurrency?: string;
  paymentStatus?: "paid" | "unpaid";
  canEdit?: boolean;
  productImages?: OrderProductImageItem[];
  products?: OrderProductItem[];
}

export interface OrderProductItem {
  id: string;
  itemName: string;
  packageCount: number;
  lengthCm?: number | null;
  widthCm?: number | null;
  heightCm?: number | null;
  productQuantity?: number | null;
  cargoType?: string;
  domesticTrackingNo?: string;
}

export interface StaffInboundPhotoItem {
  id: string;
  shipmentId: string;
  operatorId: string;
  fileName: string;
  mime: string;
  contentBase64: string;
  note?: string;
  createdAt: string;
}

export interface OrderItem {
  id: string;
  orderNo?: string;
  clientId?: string;
  clientName?: string;
  warehouseId?: string;
  batchNo?: string;
  latestRemark?: string;
  logisticsRecords?: Array<{
    remark: string;
    changedAt: string;
    fromStatus?: string;
    toStatus?: string;
  }>;
  itemName: string;
  transportMode: string;
  cargoType?: string;
  approvalStatus?: "pending" | "approved" | "shipped";
  domesticTrackingNo?: string;
  trackingNo?: string;
  currentStatus?: string;
  statusGroup?: "unfinished" | "completed";
  productQuantity: number;
  packageCount: number;
  packageUnit: string;
  weightKg?: number;
  volumeM3?: number;
  receivableAmountCny?: number | null;
  receivableCurrency?: "CNY" | "THB";
  paymentStatus?: "paid" | "unpaid";
  paidAt?: string;
  paidBy?: string;
  shipDate?: string;
  createdAt: string;
  updatedAt?: string;
  productImages?: OrderProductImageItem[];
  products?: OrderProductItem[];
}

export interface AdminOverview {
  staffAccountCount: number;
  clientAccountCount: number;
  newOrderCountToday: number;
  inTransitOrderCount: number;
  receivedVolumeM3Today: number;
}

export interface AdminUserItem {
  id: string;
  companyId: string;
  role: string;
  name: string;
  phone: string;
  status: string;
  createdAt: string;
  companyName?: string;
  email?: string;
}

export interface AdminOrderItem {
  id: string;
  orderId?: string;
  shipmentId?: string;
  cargoType?: string;
  clientId: string;
  clientName: string | null;
  warehouseId: string;
  orderNo: string | null;
  itemName: string;
  transportMode: string;
  domesticTrackingNo: string | null;
  batchNo: string | null;
  approvalStatus: string;
  productQuantity: number;
  packageCount: number;
  packageUnit: string;
  weightKg: number | null;
  volumeM3: number | null;
  receiverAddressTh?: string;
  containerNo?: string;
  trackingNo?: string;
  currentStatus?: string;
  canEdit?: boolean;
  receivableAmountCny?: number | null;
  receivableCurrency?: "CNY" | "THB";
  paymentStatus?: "paid" | "unpaid";
  shipDate: string | null;
  statusGroup: string;
  createdAt: string;
  updatedAt: string;
  productImages?: OrderProductImageItem[];
  products?: OrderProductItem[];
}

export interface AdminAiSessionMemoryItem {
  key: string;
  companyId: string;
  userId: string;
  sessionId: string;
  intent?: string;
  itemName?: string;
  statusScope?: string;
  timeHint?: string;
  metric?: string;
  updatedAt: string;
}

export interface AdminAiKnowledgeGapItem {
  id: string;
  companyId: string;
  userId: string;
  sessionId?: string;
  question: string;
  answerSummary: string;
  knowledgeCountAtAsk: number;
  status: "open" | "resolved";
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface AdminLmpRateItem {
  id: string;
  routeCode: string;
  supplierName: string;
  transportMode: string;
  seasonTag: string;
  supplierCost: number;
  quotePrice: number;
  currency: string;
  effectiveFrom: string;
  effectiveTo?: string;
  updatedAt: string;
}

export interface AdminCustomsCaseItem {
  id: string;
  shipmentId?: string;
  orderId?: string;
  status: string;
  remark?: string;
  updatedAt: string;
}

export interface AdminLastmileItem {
  id: string;
  shipmentId: string;
  carrierName: string;
  externalTrackingNo: string;
  status: string;
  updatedAt: string;
}

export interface AdminSettlementEntryItem {
  id: string;
  orderId: string;
  clientReceivable: number;
  supplierPayable: number;
  taxFee: number;
  currency: string;
  updatedAt: string;
}

export interface AdminProfitItem {
  orderId: string;
  clientReceivable: number;
  supplierPayable: number;
  taxFee: number;
  profit: number;
  currency: string;
  updatedAt: string;
}

export interface AdminOpsOverview {
  profitSummary: {
    totalRevenue: number;
    totalCost: number;
    totalProfit: number;
    grossMarginPercent: number;
  };
  profitTrend: Array<{
    orderId: string;
    profit: number;
    updatedAt: string;
  }>;
  customsAlerts: Array<{
    id: string;
    shipmentId?: string;
    orderId?: string;
    status: string;
    remark?: string;
    updatedAt: string;
  }>;
  supplierPriceAlerts: Array<{
    routeCode: string;
    supplierName: string;
    previousQuotePrice: number;
    latestQuotePrice: number;
    delta: number;
    updatedAt: string;
  }>;
}

export interface FinanceRow {
  id: string;
  orderNo: string;
  clientName: string;
  transportMode: string;
  warehouse: string;
  weightKg: number;
  volumeM3: number;
  paymentStatus: string;
  createdAt: string;
}

export interface FinanceSummary {
  totalOrders: number;
  totalWeight: number;
  totalVolume: number;
  monthOrders: number;
  rows: FinanceRow[];
}

export async function createStaffOrder(payload: StaffCreateOrderPayload): Promise<{
  orderId: string;
  createdAt: string;
}> {
  const response = await fetch(`${apiBaseUrl()}/staff/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

/**
 * 员工上传订单详情产品图（单订单最多 5 张）。
 */
export async function uploadStaffOrderProductImage(payload: {
  orderId: string;
  fileName: string;
  mime: string;
  contentBase64: string;
}): Promise<{ id: string; orderId: string; fileName: string; mime: string; createdAt: string }> {
  const response = await fetch(`${apiBaseUrl()}/staff/orders/product-images`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

/**
 * 员工删除订单详情产品图。
 */
export async function deleteStaffOrderProductImage(id: string): Promise<{ deleted: boolean; id: string }> {
  const response = await fetch(`${apiBaseUrl()}/staff/orders/product-images?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

export async function createClientPrealert(payload: ClientPrealertPayload): Promise<{
  prealertId: string;
  createdAt: string;
}> {
  const response = await fetch(`${apiBaseUrl()}/client/prealerts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

/**
 * 拉取客户端地址簿。
 */
export async function fetchClientAddresses(): Promise<ClientAddressItem[]> {
  const response = await fetch(`${apiBaseUrl()}/client/addresses`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: ClientAddressItem[] }>(response);
  return data.items;
}

/**
 * 新增客户端地址。
 */
export async function createClientAddress(payload: {
  contactName: string;
  contactPhone: string;
  addressDetail: string;
  lat?: number;
  lng?: number;
  label?: string;
  isDefault?: boolean;
}): Promise<ClientAddressItem> {
  const response = await fetch(`${apiBaseUrl()}/client/addresses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

/**
 * 设置默认地址。
 */
export async function setDefaultClientAddress(id: string): Promise<{ id: string; isDefault: true; updatedAt: string }> {
  const response = await fetch(`${apiBaseUrl()}/client/addresses/set-default`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({ id }),
  });
  return parseApiResponse(response);
}

/**
 * 删除客户端地址。
 */
export async function deleteClientAddress(id: string): Promise<{ deleted: boolean; id: string }> {
  const response = await fetch(`${apiBaseUrl()}/client/addresses?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

/**
 * 通过运单号和手机号后四位进行免登录轨迹查询。
 */
export async function fetchPublicTrack(params: {
  trackingNo: string;
  phoneLast4: string;
}): Promise<PublicTrackResult> {
  const query = new URLSearchParams();
  query.set("trackingNo", params.trackingNo);
  query.set("phoneLast4", params.phoneLast4);
  const response = await fetch(`${apiBaseUrl()}/public/track?${query.toString()}`, {
    method: "GET",
  });
  return parseApiResponse(response);
}

/**
 * 通用快递查询（快递100代理）。
 */
export async function fetchUniversalExpressTrack(params: {
  trackingNo: string;
  companyCode?: string;
}): Promise<UniversalExpressTrackResult> {
  const query = new URLSearchParams();
  query.set("trackingNo", params.trackingNo);
  if (params.companyCode?.trim()) {
    query.set("companyCode", params.companyCode.trim());
  }
  const response = await fetch(`${apiBaseUrl()}/client/express/universal?${query.toString()}`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

/**
 * 获取多币种账户概览与汇率。
 */
export async function fetchClientWalletOverview(): Promise<ClientWalletOverview> {
  const response = await fetch(`${apiBaseUrl()}/client/wallet/overview`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

export async function fetchClientOrders(params?: {
  statusGroup?: "completed" | "unfinished";
}): Promise<OrderItem[]> {
  const query = new URLSearchParams();
  if (params?.statusGroup) query.set("statusGroup", params.statusGroup);
  const response = await fetch(`${apiBaseUrl()}/client/orders?${query.toString()}`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: OrderItem[] }>(response);
  return data.items;
}

/**
 * 获取客户端预报单列表
 * @param status 预报单状态：pending(待审核), approved(已审核/待发货), shipped(已发货), all(全部)
 */
export async function fetchClientPrealerts(status: string = "pending"): Promise<OrderItem[]> {
  const response = await fetch(`${apiBaseUrl()}/client/prealerts?status=${status}`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: OrderItem[] }>(response);
  return data.items;
}

/**
 * 客户确认发货 - 将已审核的预报单转为正式订单
 */
export async function shipClientPrealert(orderId: string): Promise<{
  orderId: string;
  trackingNo: string;
  shippedAt: string;
}> {
  const response = await fetch(`${apiBaseUrl()}/client/prealerts/ship`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({ orderId }),
  });
  return parseApiResponse(response);
}

export async function deleteClientPrealert(orderId: string): Promise<{ deleted: boolean }> {
  const response = await fetch(`${apiBaseUrl()}/client/prealerts/delete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({ orderId }),
  });
  return parseApiResponse(response);
}

export async function updateClientPrealert(orderId: string, payload: Record<string, unknown>): Promise<{ updated: boolean }> {
  const response = await fetch(`${apiBaseUrl()}/client/prealerts/update`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({ orderId, ...payload }),
  });
  return parseApiResponse(response);
}

export async function fetchStaffPrealerts(): Promise<OrderItem[]> {
  const response = await fetch(`${apiBaseUrl()}/staff/prealerts`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: OrderItem[] }>(response);
  return data.items;
}

export async function approveStaffPrealert(payload: {
  orderId: string;
  batchNo: string;
  warehouseId?: string;
  itemName?: string;
  packageCount?: number;
  packageUnit?: "bag" | "box";
  productQuantity?: number;
  weightKg?: number;
  volumeM3?: number;
  receivableAmountCny: number;
  receivableCurrency?: "CNY" | "THB";
  domesticTrackingNo?: string;
  transportMode?: "sea" | "land";
  shipDate?: string;
}): Promise<{
  orderId: string;
  batchNo: string;
  approvalStatus: "approved";
  approvedAt: string;
}> {
  const response = await fetch(`${apiBaseUrl()}/staff/prealerts/approve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

export async function setStaffOrderReceivable(payload: {
  orderId: string;
  receivableAmountCny: number;
  receivableCurrency?: "CNY" | "THB";
}): Promise<{ orderId: string; receivableAmountCny: number; receivableCurrency: "CNY" | "THB"; updatedAt: string }> {
  const response = await fetch(`${apiBaseUrl()}/staff/orders/set-receivable`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

export async function setStaffOrderPayment(payload: {
  orderId: string;
  paymentStatus: "paid" | "unpaid";
  proofFileName?: string;
  proofMime?: string;
  proofBase64?: string;
}): Promise<{
  orderId: string;
  paymentStatus: "paid" | "unpaid";
  paidAt: string | null;
  paidBy: string | null;
  updatedAt: string;
}> {
  const response = await fetch(`${apiBaseUrl()}/staff/orders/set-payment`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

export async function fetchClientShipments(): Promise<ShipmentItem[]> {
  const response = await fetch(`${apiBaseUrl()}/client/shipments/search`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: ShipmentItem[] }>(response);
  return data.items;
}

export async function splitStaffShipment(payload: {
  parentShipmentId: string;
  splits: Array<{ trackingNo: string; batchNo: string; itemName: string; packageCount: number }>;
}): Promise<{ parentTrackingNo: string; children: Array<{ trackingNo: string; shipmentId: string }> }> {
  const response = await fetch(`${apiBaseUrl()}/staff/shipments/split`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

export async function fetchStaffShipments(): Promise<ShipmentItem[]> {
  const response = await fetch(`${apiBaseUrl()}/staff/shipments`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: ShipmentItem[] }>(response);
  return data.items;
}

export async function fetchShipmentImages(orderId: string): Promise<OrderProductImageItem[]> {
  const response = await fetch(`${apiBaseUrl()}/staff/shipments/images?orderId=${encodeURIComponent(orderId)}`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ images: OrderProductImageItem[] }>(response);
  return data.images;
}

export async function fetchStaffClients(): Promise<Array<{ id: string; name: string }>> {
  const response = await fetch(`${apiBaseUrl()}/staff/clients`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: Array<{ id: string; name: string }> }>(response);
  return data.items;
}

/** 修复运单-订单关联接口的返回结果。 */
export type RepairStaffShipmentOrderLinksResult = {
  ok: boolean;
  repairedCount: number;
  repairedShipmentIds: string[];
  skipped: Array<{ shipmentId: string; reason: string }>;
};

/**
 * 请求后端修复运单与订单脱节（补建缺失订单并写回 order_id）。
 * @param payload.shipmentId 仅修复该运单，便于列表页定向处理。
 */
export async function repairStaffShipmentOrderLinks(
  payload?: { shipmentId?: string },
): Promise<RepairStaffShipmentOrderLinksResult> {
  const response = await fetch(`${apiBaseUrl()}/staff/shipments/repair-order-links`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(payload ?? {}),
  });
  return parseApiResponse(response);
}

/**
 * 为运单设置装柜号（Container No.）。
 */
export async function setStaffShipmentContainer(payload: {
  shipmentId: string;
  containerNo: string;
}): Promise<{ shipmentId: string; containerNo: string; updatedAt: string }> {
  const response = await fetch(`${apiBaseUrl()}/staff/shipments/set-container`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

/**
 * 上传入库拍照记录。
 */
export async function uploadStaffInboundPhoto(payload: {
  shipmentId: string;
  fileName: string;
  mime: string;
  contentBase64: string;
  note?: string;
}): Promise<{ id: string; shipmentId: string; createdAt: string }> {
  const response = await fetch(`${apiBaseUrl()}/staff/inbound-photos`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

/**
 * 查询指定运单的入库拍照记录。
 */
export async function fetchStaffInboundPhotos(shipmentId: string): Promise<StaffInboundPhotoItem[]> {
  const response = await fetch(`${apiBaseUrl()}/staff/inbound-photos?shipmentId=${encodeURIComponent(shipmentId)}`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: StaffInboundPhotoItem[] }>(response);
  return data.items;
}

/**
 * 员工端：按运单保存关联订单与运单的基础信息（运单列表展开区「订单详情」）。
 */
export async function patchStaffShipmentOrderBundle(payload: {
  shipmentId: string;
  trackingNo: string;
  batchNo?: string | null;
  itemName: string;
  productQuantity: number;
  packageCount: number;
  packageUnit: "bag" | "box";
  weightKg?: number | null;
  volumeM3?: number | null;
  domesticTrackingNo?: string | null;
  orderCreatedDate: string;
  transportMode: "sea" | "land";
  shipDate?: string | null;
  receiverAddressTh: string;
  containerNo?: string | null;
  receivableAmountCny?: number | null;
  receivableCurrency?: "CNY" | "THB";
  warehouseId?: string;
}): Promise<{ shipmentId: string; orderId: string; updatedAt: string }> {
  const response = await fetch(`${apiBaseUrl()}/staff/orders/patch-shipment-bundle`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

export async function updateStaffShipmentStatus(payload: {
  shipmentId?: string;
  batchNo?: string;
  updateByBatch?: boolean;
  toStatus: string;
  remark?: string;
}): Promise<{
  mode: "single" | "batch";
  batchNo?: string | null;
  shipmentId?: string | null;
  shipmentIds: string[];
  fromStatus?: string | null;
  toStatus: string;
  updatedCount: number;
  changedAt: string;
}> {
  const response = await fetch(`${apiBaseUrl()}/staff/shipments/update-status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

export async function fetchAdminOverview(): Promise<AdminOverview> {
  const response = await fetch(`${apiBaseUrl()}/admin/dashboard/overview`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

export async function fetchAdminStaff(): Promise<AdminUserItem[]> {
  const response = await fetch(`${apiBaseUrl()}/admin/users?role=staff`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: AdminUserItem[] }>(response);
  return data.items;
}

export async function fetchAdminClients(): Promise<AdminUserItem[]> {
  const response = await fetch(`${apiBaseUrl()}/admin/users?role=client`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: AdminUserItem[] }>(response);
  return data.items;
}

export async function fetchAdminOrders(): Promise<AdminOrderItem[]> {
  const response = await fetch(`${apiBaseUrl()}/admin/orders`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: AdminOrderItem[] }>(response);
  return data.items;
}

/**
 * 管理员更新客户端订单基础信息。
 */
export async function updateAdminOrder(payload: {
  orderId: string;
  clientId?: string;
  itemName: string;
  cargoType?: string;
  transportMode: "sea" | "land";
  domesticTrackingNo?: string;
  trackingNo?: string;
  batchNo?: string;
  warehouseId?: string;
  receiverAddressTh?: string;
  containerNo?: string;
  productQuantity: number;
  packageCount: number;
  packageUnit: "bag" | "box";
  weightKg?: number;
  volumeM3?: number;
  receivableAmountCny?: number;
  receivableCurrency?: "CNY" | "THB";
  paymentStatus?: "paid" | "unpaid";
  shipDate?: string;
  products?: Array<{
    itemName: string;
    packageCount: number;
    lengthCm?: number;
    widthCm?: number;
    heightCm?: number;
    productQuantity?: number;
    cargoType?: string;
    domesticTrackingNo?: string;
  }>;
}): Promise<{ orderId: string; updatedAt: string }> {
  const response = await fetch(`${apiBaseUrl()}/admin/orders/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

export async function createAdminStaff(payload: {
  id?: string;
  name: string;
  phone: string;
  password?: string;
}): Promise<{ id: string; name: string; phone: string; createdAt: string }> {
  const response = await fetch(`${apiBaseUrl()}/admin/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

export async function deleteAdminStaff(userId: string): Promise<{ deleted: boolean; id: string }> {
  const response = await fetch(`${apiBaseUrl()}/admin/users?id=${encodeURIComponent(userId)}`, {
    method: "DELETE",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}


export async function deleteAdminOrder(orderId: string): Promise<{ deleted: boolean; orderId: string; itemName: string }> {
  const response = await fetch(`${apiBaseUrl()}/admin/orders/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ orderId }),
  });
  return parseApiResponse(response);
}

export async function setAdminStaffPassword(userId: string, password: string): Promise<{ updated: boolean; id: string }> {
  const response = await fetch(`${apiBaseUrl()}/admin/users/set-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ id: userId, password }),
  });
  return parseApiResponse(response);
}

export async function createAdminClient(payload: {
  id?: string;
  name: string;
  companyName?: string;
  phone: string;
  email?: string;
  password?: string;
}): Promise<{ id: string; name: string; companyName: string | null; phone: string; email: string | null; createdAt: string }> {
  const response = await fetch(`${apiBaseUrl()}/admin/users/client`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

export async function fetchAdminAiSessionMemory(params?: {
  companyId?: string;
  limit?: number;
}): Promise<{ items: AdminAiSessionMemoryItem[]; total: number; limit: number }> {
  const query = new URLSearchParams();
  if (params?.companyId) query.set("companyId", params.companyId);
  if (typeof params?.limit === "number") query.set("limit", String(params.limit));
  const suffix = query.toString();
  const response = await fetch(
    `${apiBaseUrl()}/admin/ai/session-memory${suffix ? `?${suffix}` : ""}`,
    {
      method: "GET",
      headers: { ...authHeaders() },
    },
  );
  return parseApiResponse(response);
}

export async function clearAdminAiSessionMemory(params?: {
  companyId?: string;
  sessionId?: string;
  userId?: string;
}): Promise<{ removed: number; companyId: string; sessionId: string | null; userId: string | null }> {
  const query = new URLSearchParams();
  if (params?.companyId) query.set("companyId", params.companyId);
  if (params?.sessionId) query.set("sessionId", params.sessionId);
  if (params?.userId) query.set("userId", params.userId);
  const suffix = query.toString();
  const response = await fetch(
    `${apiBaseUrl()}/admin/ai/session-memory${suffix ? `?${suffix}` : ""}`,
    {
      method: "DELETE",
      headers: { ...authHeaders() },
    },
  );
  return parseApiResponse(response);
}

export async function fetchAdminAiKnowledgeGaps(params?: {
  companyId?: string;
  status?: "open" | "resolved";
}): Promise<{ items: AdminAiKnowledgeGapItem[]; total: number; status: "open" | "resolved" | "all" }> {
  const query = new URLSearchParams();
  if (params?.companyId) query.set("companyId", params.companyId);
  if (params?.status) query.set("status", params.status);
  const suffix = query.toString();
  const response = await fetch(
    `${apiBaseUrl()}/admin/ai/knowledge-gaps${suffix ? `?${suffix}` : ""}`,
    {
      method: "GET",
      headers: { ...authHeaders() },
    },
  );
  return parseApiResponse(response);
}

export async function resolveAdminAiKnowledgeGap(params: {
  id: string;
  companyId?: string;
}): Promise<{ resolved: true; id: string }> {
  const response = await fetch(`${apiBaseUrl()}/admin/ai/knowledge-gaps/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  return parseApiResponse(response);
}

/**
 * 获取管理员渠道底价与报价列表。
 */
export async function fetchAdminLmpRates(): Promise<AdminLmpRateItem[]> {
  const response = await fetch(`${apiBaseUrl()}/admin/lmp/rates`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: AdminLmpRateItem[] }>(response);
  return data.items;
}

/**
 * 新增渠道底价与报价规则。
 */
export async function createAdminLmpRate(payload: {
  routeCode: string;
  supplierName: string;
  transportMode: string;
  seasonTag: string;
  supplierCost: number;
  quotePrice: number;
  currency?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
}): Promise<{ id: string; updatedAt: string }> {
  const response = await fetch(`${apiBaseUrl()}/admin/lmp/rates`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

/**
 * 获取关务监控列表。
 */
export async function fetchAdminCustomsCases(): Promise<AdminCustomsCaseItem[]> {
  const response = await fetch(`${apiBaseUrl()}/admin/customs/cases`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: AdminCustomsCaseItem[] }>(response);
  return data.items;
}

/**
 * 新增关务状态记录。
 */
export async function createAdminCustomsCase(payload: {
  shipmentId?: string;
  orderId?: string;
  status: string;
  remark?: string;
}): Promise<{ id: string; updatedAt: string }> {
  const response = await fetch(`${apiBaseUrl()}/admin/customs/cases`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

/**
 * 获取末端派送单号集成列表。
 */
export async function fetchAdminLastmileOrders(): Promise<AdminLastmileItem[]> {
  const response = await fetch(`${apiBaseUrl()}/admin/lastmile/orders`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: AdminLastmileItem[] }>(response);
  return data.items;
}

/**
 * 新增末端派送对接记录。
 */
export async function createAdminLastmileOrder(payload: {
  shipmentId: string;
  carrierName: string;
  externalTrackingNo: string;
  status?: string;
}): Promise<{ id: string; updatedAt: string }> {
  const response = await fetch(`${apiBaseUrl()}/admin/lastmile/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

/**
 * 获取财务结算录入项。
 */
export async function fetchAdminSettlementEntries(): Promise<AdminSettlementEntryItem[]> {
  const response = await fetch(`${apiBaseUrl()}/admin/settlement/entries`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: AdminSettlementEntryItem[] }>(response);
  return data.items;
}

/**
 * 新增财务结算录入项（AR/AP/Tax）。
 */
export async function createAdminSettlementEntry(payload: {
  orderId: string;
  clientReceivable: number;
  supplierPayable: number;
  taxFee: number;
  currency?: string;
}): Promise<{ id: string; updatedAt: string }> {
  const response = await fetch(`${apiBaseUrl()}/admin/settlement/entries`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

/**
 * 获取利润分析列表。
 */
export async function fetchAdminProfitAnalysis(): Promise<AdminProfitItem[]> {
  const response = await fetch(`${apiBaseUrl()}/admin/settlement/profit`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: AdminProfitItem[] }>(response);
  return data.items;
}

/**
 * 获取管理员运营总控看板数据（毛利/关务预警/报价变动）。
 */
export async function fetchAdminOpsOverview(): Promise<AdminOpsOverview> {
  const response = await fetch(`${apiBaseUrl()}/admin/ops/overview`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

/**
 * 获取财务汇总数据。
 */
export async function fetchFinanceSummary(): Promise<FinanceSummary> {
  const response = await fetch(`${apiBaseUrl()}/admin/finance/summary`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

// ============================================================================
// 用户管理相关（管理员端）
// ============================================================================

export interface ManagedUser {
  id: string;
  companyId: string;
  role: string;
  name: string;
  phone: string;
  status: string;
  createdAt: string;
  companyName?: string;
  email?: string;
  warehouseIds?: string[];
}

/**
 * 获取用户列表（管理员）。
 */
export async function fetchManagedUsers(): Promise<ManagedUser[]> {
  const response = await fetch(`${apiBaseUrl()}/admin/users`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: ManagedUser[] }>(response);
  return data.items;
}

/**
 * 创建用户（管理员）。
 */
export async function createManagedUser(payload: {
  role: string;
  name: string;
  phone: string;
  password: string;
  companyName?: string;
  email?: string;
  warehouseIds?: string[];
}): Promise<ManagedUser> {
  const response = await fetch(`${apiBaseUrl()}/admin/users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

/**
 * 重置用户密码（管理员）。
 */
export async function resetUserPassword(userId: string, password: string): Promise<{ updated: boolean; id: string }> {
  const response = await fetch(`${apiBaseUrl()}/admin/users/set-password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({ id: userId, password }),
  });
  return parseApiResponse(response);
}

/**
 * 禁用/启用用户（管理员）。
 */
export async function toggleUserBan(userId: string): Promise<{ id: string; status: string }> {
  const response = await fetch(`${apiBaseUrl()}/admin/users/toggle-ban`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({ id: userId }),
  });
  return parseApiResponse(response);
}

// ============================================================================
// 装柜清单相关
// ============================================================================

export interface LoadingManifestItem {
  id: string;
  manifestNo: string;
  warehouse: string;
  status: string;
  carrierInfo: string | null;
  sealedAt: string | null;
  totalBills: number;
  createdAt: string;
}

export interface LoadingManifestDetail extends LoadingManifestItem {
  bills: Array<{
    id: string;
    shipmentId: string;
    trackingNo: string | null;
    batchNo: string | null;
    itemName: string | null;
    currentStatus: string | null;
  }>;
}

/**
 * 创建装柜清单。
 */
export async function createLoadingManifest(payload: {
  warehouse: string;
  carrierInfo?: string;
}): Promise<{ manifestNo: string }> {
  const response = await fetch(`${apiBaseUrl()}/staff/loading-manifests`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(payload),
  });
  const body = await parseApiResponse<{ message: string; manifest: { id: string; manifestNo: string } }>(response);
  return { manifestNo: body.manifest.manifestNo };
}

/**
 * 获取装柜清单列表。
 */
export async function fetchLoadingManifests(filters?: { query?: string; status?: string }): Promise<LoadingManifestItem[]> {
  const params = new URLSearchParams();
  if (filters?.query) params.set("query", filters.query);
  if (filters?.status) params.set("status", filters.status);
  const qs = params.toString();
  const url = `${apiBaseUrl()}/staff/loading-manifests${qs ? `?${qs}` : ""}`;
  const response = await fetch(url, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: LoadingManifestItem[] }>(response);
  return data.items;
}

/**
 * 获取装柜清单详情。
 */
export async function fetchLoadingManifestDetail(manifestId: string): Promise<LoadingManifestDetail> {
  const response = await fetch(`${apiBaseUrl()}/staff/loading-manifests/detail?id=${manifestId}`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

/**
 * 封装装柜清单。
 */
export async function sealLoadingManifest(manifestId: string): Promise<LoadingManifestItem> {
  const response = await fetch(`${apiBaseUrl()}/staff/loading-manifests/seal?id=${manifestId}`, {
    method: "POST",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

/**
 * 添加运单到装柜清单。
 */
export async function removeShipmentFromManifest(manifestId: string, itemId: string): Promise<{ removed: boolean }> {
  const response = await fetch(`${apiBaseUrl()}/staff/loading-manifests/remove-shipment?id=${manifestId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ itemId }),
  });
  return parseApiResponse(response);
}

/**
 * 管理员删除柜子（仅 LOADING 状态）。
 */
export async function deleteContainer(containerId: string): Promise<{ deleted: boolean; id: string }> {
  const response = await fetch(`${apiBaseUrl()}/admin/containers?id=${encodeURIComponent(containerId)}`, {
    method: "DELETE",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

export async function addShipmentToManifest(manifestId: string, trackingNo: string): Promise<{ added: boolean }> {
  const response = await fetch(`${apiBaseUrl()}/staff/loading-manifests/add-shipment?id=${manifestId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({ trackingNo }),
  });
  return parseApiResponse(response);
}
export async function fetchShippingConfig(): Promise<Record<string, string>> {
  const response = await fetch(`${apiBaseUrl()}/admin/shipping/config`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

export interface ShippingPriceItem {
  unitPriceCny: number;
  disableMinVolume: boolean;
}

export async function fetchShippingPrices(clientId?: string): Promise<Record<string, ShippingPriceItem>> {
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  const response = await fetch(`${apiBaseUrl()}/client/shipping/prices${query}`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

export async function fetchAdminShippingRates(): Promise<{
  items: Array<{
    id: string;
    transportMode: string;
    cargoType: string;
    customerId: string | null;
    customerName: string | null;
    unitPriceCny: number;
    disableMinVolume: boolean;
  }>;
  defaults: Array<{ transportMode: string; cargoType: string; unitPriceCny: number }>;
}> {
  const response = await fetch(`${apiBaseUrl()}/admin/shipping/rates`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

export async function saveAdminShippingRate(payload: {
  id?: string;
  transportMode: string;
  cargoType: string;
  customerId?: string | null;
  unitPriceCny: number;
  disableMinVolume?: boolean;
}): Promise<{ saved: boolean }> {
  const response = await fetch(`${apiBaseUrl()}/admin/shipping/rates`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

export async function deleteAdminShippingRate(id: string): Promise<{ deleted: boolean }> {
  const response = await fetch(`${apiBaseUrl()}/admin/shipping/rates?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

export async function fetchClientShippingConfig(clientId: string): Promise<{
  clientId: string;
  prices: Record<string, number>;
  disableMinVolume: boolean;
}> {
  const response = await fetch(`${apiBaseUrl()}/admin/shipping/client-config?clientId=${encodeURIComponent(clientId)}`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

export async function saveClientShippingConfig(payload: {
  clientId: string;
  prices: Record<string, number>;
  disableMinVolume: boolean;
}): Promise<{ saved: boolean }> {
  const response = await fetch(`${apiBaseUrl()}/admin/shipping/client-config`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

export async function fetchClientNotes(): Promise<Record<string, { content: string; updatedAt: string }>> {
  const response = await fetch(`${apiBaseUrl()}/staff/lastmile/notes`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

export async function saveClientNote(clientId: string, content: string): Promise<{ saved: boolean }> {
  const response = await fetch(`${apiBaseUrl()}/admin/shipping/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ clientId, content }),
  });
  return parseApiResponse(response);
}

export async function updateShippingConfig(payload: Record<string, string>): Promise<Record<string, string>> {
  const response = await fetch(`${apiBaseUrl()}/admin/shipping/config`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}
