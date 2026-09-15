/**
 * 代理工作台接口（/agent/*，2026-09-16）。
 *
 * ⚠️ 这些类型是手写的，TypeScript 不会去核对后端（CLAUDE.md #22）。
 *    后端在 apps/api/src/modules/agent-portal/routes.ts，改了那边 ok(res, {...}) 的结构，这里要同步。
 * ⚠️ 代理令牌只能打 /agent/* 和 /auth/*，别在代理页面里调 business-api.ts 里的 /client、/staff、/admin 接口（会 403）。
 */
import { apiBaseUrl, apiRequest } from "./core-api";

export interface PriceTriple {
  normal: number;
  inspection: number;
  sensitive: number;
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const text = sp.toString();
  return text ? `?${text}` : "";
}

/* ── 我的价格 ── */
export interface AgentMe {
  name: string;
  logoUrl: string | null;
  slug: string | null;
  customDomain: string | null;
  prices: PriceTriple;
}
export function fetchAgentMe(): Promise<AgentMe> {
  return apiRequest<AgentMe>(`${apiBaseUrl()}/agent/me`);
}

/* ── 首页：卡住的单 ── */
export interface AgentStuckPrealert {
  prealertId: string;
  trackingNo: string;
  mark: string;
  status: string;
  clientId: string;
  clientName: string;
  planId: string;
  planNo: string;
  totalFee: number | null;
  signedAt: string | null;
  createdAt: string;
}
export interface AgentMissingAddress {
  clientId: string;
  clientName: string;
  planId: string;
  planNo: string;
  planStatus: string;
  prealertCount: number;
}
/**
 * 列表超过接口上限时的真实总数（CLAUDE.md #21：截断必须说清楚）。
 * 字段标成可选：本地 API 进程不自动重载，前端先热更新时老接口没有这些字段，页面不许因此白屏（CLAUDE.md #22）。
 */
export interface ListCap {
  total: number;
  limit: number;
  truncated: boolean;
}
export interface AgentDashboard {
  clientCount: number;
  missingSize: AgentStuckPrealert[];
  missingAddress: AgentMissingAddress[];
  unpaid: AgentStuckPrealert[];
  caps?: { missingSize: ListCap; missingAddress: ListCap; unpaid: ListCap };
}
export function fetchAgentDashboard(): Promise<AgentDashboard> {
  return apiRequest<AgentDashboard>(`${apiBaseUrl()}/agent/dashboard`);
}

/* ── 运单 ── */
export interface AgentShipmentProduct {
  itemName: string;
  packageCount: number;
  productQuantity: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  weightKg: number | null;
  cargoType: string;
  domesticTrackingNo: string;
}
export interface AgentShipmentItem {
  id: string;
  clientId: string;
  clientName: string;
  orderNo: string | null;
  approvalStatus: string;
  shipmentId: string | null;
  trackingNo: string | null;
  currentStatus: string | null;
  statusGroup: "pending" | "transit" | "arrived" | "delivered" | "closed";
  itemName: string;
  productNames: string;
  productQuantity: number;
  packageCount: number;
  packageUnit: string;
  weightKg: number | null;
  volumeM3: number | null;
  totalWeightKg: number | null;
  totalVolumeM3: number | null;
  lengthCm: string | null;
  widthCm: string | null;
  heightCm: string | null;
  transportMode: string;
  domesticTrackingNo: string | null;
  cargoType: string;
  shipDate: string | null;
  receiverNameTh: string;
  receiverPhoneTh: string;
  receiverAddressTh: string;
  products: AgentShipmentProduct[];
  createdAt: string;
  updatedAt: string;
}
export interface AgentShipmentQuery {
  page?: number;
  pageSize?: number;
  trackingNo?: string;
  clientId?: string;
  statusGroup?: string;
  keyword?: string;
  dateFrom?: string;
  dateTo?: string;
}
export interface AgentShipmentList {
  items: AgentShipmentItem[];
  page: number;
  pageSize: number;
  total: number;
  clients: Array<{ clientId: string; name: string }>;
}
export function fetchAgentShipments(query: AgentShipmentQuery): Promise<AgentShipmentList> {
  return apiRequest<AgentShipmentList>(`${apiBaseUrl()}/agent/shipments${qs({ ...query })}`);
}
export function fetchAgentShipmentExportData(
  query: Omit<AgentShipmentQuery, "page" | "pageSize"> & { orderIds?: string[] },
): Promise<{ items: AgentShipmentItem[]; total: number }> {
  const { orderIds, ...rest } = query;
  return apiRequest(`${apiBaseUrl()}/agent/shipments/export-data${qs({ ...rest, orderIds: orderIds?.length ? orderIds.join(",") : undefined })}`);
}

/* ── 仓库版集货 ── */
export interface AgentWhrCustomerSummary {
  customerId: string;
  clientId: string;
  clientName: string;
  unitPrices: PriceTriple;
  totalVolumeM3: number;
  totalFee: number | null;
  prealertCount: number;
  cancelledCount: number;
  latestStatus: string;
  deliveryAddress: string | null;
}
export interface AgentWhrPlan {
  planId: string;
  planNo: string;
  warehouse: string;
  containerType: string;
  destinationTh: string;
  planStatus: string;
  createdAt: string;
  customers: AgentWhrCustomerSummary[];
}
export function fetchAgentWhrPlans(): Promise<{ items: AgentWhrPlan[] } & Partial<ListCap>> {
  return apiRequest(`${apiBaseUrl()}/agent/whr/plans`);
}

export interface AgentProof {
  base64Path: string;
  fileName: string;
  mime: string;
  uploadedAt: string | null;
}
export interface AgentWhrItem {
  id: string;
  productName: string;
  packageCount: number;
  quantityPerBox: number;
  totalQuantity: number;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  unitWeightKg: number | null;
  totalWeightKg: number | null;
  volumeM3: number | null;
  material: string;
  cargoValue: string;
  cargoType: string;
}
export interface AgentWhrPrealert {
  id: string;
  trackingNo: string;
  expressNo: string | null;
  mark: string;
  status: string;
  signedAt: string | null;
  warehouseReceiptProofs: AgentProof[];
  totalFee: number | null;
  feeBreakdown: {
    rows: Array<{ cargoType: string; label: string; volumeM3: number; unitPrice: number; amount: number }>;
    totalVolumeM3: number;
    /** 按明细单价算出来的钱是否等于 totalFee。已付款的单按付款时记下的价算，一般都对得上；false 时页面要提示以实际金额为准 */
    matchesStored: boolean;
  };
  paidAt: string | null;
  paymentRejectReason: string | null;
  thailandReceiptProofs: AgentProof[];
  thailandReceivedAt: string | null;
  cancelReason: string | null;
  cancelledAt: string | null;
  rebateAmount: number | null;
  createdAt: string;
  items: AgentWhrItem[];
  /** 状态记录真实条数；statusLogs 只带最近 statusLogLimit 条 */
  statusLogTotal?: number;
  statusLogsTruncated?: boolean;
  statusLogs: Array<{ id: string; fromStatus: string; toStatus: string; remark: string; createdAt: string }>;
}
export interface AgentWhrPlanDetail {
  planId: string;
  planNo: string;
  warehouse: string;
  containerType: string;
  destinationTh: string;
  planStatus: string;
  createdAt: string;
  /** 每个客户最多带多少张预报单 / 每张单最多带多少条状态记录 */
  prealertLimit?: number;
  statusLogLimit?: number;
  customers: Array<{
    customerId: string;
    clientId: string;
    clientName: string;
    unitPrices: PriceTriple;
    totalVolumeM3: number;
    totalFee: number | null;
    totalPackages: number;
    deliveryAddress: string | null;
    prealertTotal?: number;
    prealertsTruncated?: boolean;
    prealerts: AgentWhrPrealert[];
  }>;
}
export function fetchAgentWhrPlanDetail(planId: string): Promise<AgentWhrPlanDetail> {
  return apiRequest(`${apiBaseUrl()}/agent/whr/plan-detail${qs({ planId })}`);
}

/* ── 客户和价格 ── */
export interface AgentClientItem {
  clientId: string;
  name: string;
  phone: string;
  status: string;
  createdAt: string;
  price: (PriceTriple & { updatedAt: string }) | null;
}
export function fetchAgentClients(): Promise<{ agentPrices: PriceTriple; items: AgentClientItem[] }> {
  return apiRequest(`${apiBaseUrl()}/agent/clients`);
}
export function saveAgentClientPrice(input: { clientId: string; prices: PriceTriple }): Promise<{
  clientId: string;
  price: (PriceTriple & { updatedAt: string }) | null;
  updatedPlanRows: number;
}> {
  return apiRequest(`${apiBaseUrl()}/agent/clients/price`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

/* ── 集货余额和充值记录 ── */
export interface AgentWallet {
  balances: Array<{ clientId: string; clientName: string; balance: number; updatedAt: string | null }>;
  recharges: {
    items: Array<{
      id: string;
      clientId: string;
      clientName: string;
      amount: number;
      currency: string;
      paymentMethod: string;
      status: string;
      createdAt: string;
      updatedAt: string;
    }>;
    page: number;
    pageSize: number;
    total: number;
  };
}
export function fetchAgentWallet(query: { page?: number; pageSize?: number; clientId?: string }): Promise<AgentWallet> {
  return apiRequest(`${apiBaseUrl()}/agent/wallet${qs({ ...query })}`);
}

/* ── 返现单 ── */
export interface AgentRebateStatement {
  id: string;
  month: string;
  lineCount: number;
  totalVolumeM3: number;
  totalRebate: number;
  status: "unpaid" | "paid" | string;
  generatedAt: string;
  paidAt: string | null;
}
export interface AgentRebateLine {
  id: string;
  trackingNo: string;
  planNo: string;
  clientId: string;
  mark: string;
  productNames: string;
  volumes: PriceTriple;
  clientPrices: PriceTriple;
  agentPrices: PriceTriple;
  rebateAmount: number;
  prealertCreatedAt: string;
  signedAt: string | null;
  paidAt: string | null;
  loadedAt: string | null;
  shippedAt: string | null;
  thailandReceivedAt: string;
}
export function fetchAgentRebates(): Promise<{ items: AgentRebateStatement[] } & Partial<ListCap>> {
  return apiRequest(`${apiBaseUrl()}/agent/rebates`);
}
export function fetchAgentRebateDetail(statementId: string): Promise<{ statement: AgentRebateStatement; lines: AgentRebateLine[] }> {
  return apiRequest(`${apiBaseUrl()}/agent/rebates/detail${qs({ statementId })}`);
}
