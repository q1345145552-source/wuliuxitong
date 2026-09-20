import { matchesShipmentListFilter, type ClientStatusGroup } from "../../../../packages/shared-types/shipment-status";
import { productNamesLabel } from "../../../../packages/shared-types/product-names";
import { authHeaders, apiBaseUrl, parseApiResponse, apiRequest, fetchWithSession as fetch } from "./core-api";

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
    /** 单箱重量；后端按 packageCount 汇总整票重量 */
    weightKg?: number;
    cargoType?: string;
    domesticTrackingNo?: string;
  }>;
  remark?: string;
}

export interface ClientPrealertPayload {
  warehouseId: string;
  itemName?: string;
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
  /** 整票货型（2026-09-11）：normal / inspection / sensitive，不传按普货 */
  cargoType?: string;
  products?: Array<{
    itemName: string;
    packageCount: number;
    lengthCm?: number;
    widthCm?: number;
    heightCm?: number;
    productQuantity?: number;
    weightKg?: number;
    cargoType?: string;
    domesticTrackingNo?: string;
  }>;
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

/**
 * ⚠️ 这个类型必须和后端 /client/wallet/overview 的返回**逐字对齐**
 * （apps/api/src/modules/client-compliance/routes.ts）。
 *
 * 2026-08-07 教训：这里原来还声明着 `exchangeRate: { pair, rate, updatedAt }`，
 * 但后端在集货余额改造时早就不返回它了。TypeScript 只信这里写的，不会去核对后端，
 * 所以类型检查和构建全绿，客户一打开首页却报
 * 「Cannot read properties of undefined (reading 'rate')」。
 * 改后端返回结构时，务必回来同步这里。
 */
export interface ClientWalletOverview {
  balance: number;
  currency: string;
  updatedAt: string | null;
  accounts: Array<{
    currency: string;
    balance: number;
    updatedAt: string;
  }>;
}

// ===== 充值相关类型 =====

export interface WalletRechargeItem {
  id: string;
  currency: string;
  amount: number;
  paymentMethod: string;
  status: string; // PENDING | APPROVED | REJECTED
  remark: string | null;
  reviewRemark: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminWalletRechargeItem {
  id: string;
  clientId: string;
  companyName: string | null;
  currency: string;
  amount: number;
  paymentMethod: string;
  proofImage: string;
  status: string;
  remark: string | null;
  reviewRemark: string | null;
  reviewedBy: string | null;
  reviewerName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StaffWalletBalanceItem {
  clientId: string;
  companyName: string | null;
  cny: number;
  thb: number;
}

export interface OrderProductImageItem {
  id: string;
  fileName: string;
  mime: string;
  contentBase64?: string;
  filePath?: string | null;
  imageUrl?: string;
  createdAt: string;
}

export interface ShipmentItem {
  id: string;
  orderId?: string;
  orderNo?: string;
  trackingNo: string;
  parentTrackingNo?: string;
  batchNo?: string;
  containerNo?: string;
  cargoType?: string;
  clientId?: string;
  clientName?: string;
  itemName?: string;
  domesticTrackingNo?: string;
  packageCount?: number;
  packageUnit?: "bag" | "box";
  totalPackageCount?: number;
  productQuantity?: number;
  weightKg?: number;
  volumeM3?: number;
  totalWeightKg?: number | null;
  totalVolumeM3?: number | null;
  arrivedAt?: string;
  currentStatus: string;
  /** 子单进度不一样时，最快的那批走到哪了（2026-09-16）。空 = 没有子单或进度一致 */
  partialAhead?: string;
  currentLocation?: string;
  updatedAt?: string;
  warehouseId?: string;
  remark?: string | null;
  transportMode?: string;
  shipDate?: string;
  receiverNameTh?: string;
  receiverPhoneTh?: string;
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
  weightKg?: number | null;
}

export interface StaffInboundPhotoItem {
  id: string;
  shipmentId: string;
  /** 上传人账号：只有超级管理员拿得到（2026-09-15），员工的接口返回里没有 */
  operatorId?: string;
  fileName: string;
  mime: string;
  contentBase64: string;
  note?: string;
  createdAt: string;
}

export interface OrderItem {
  /** 子单进度不一样时，最快的那批走到哪了（2026-09-16）。空 = 没有子单或进度一致 */
  partialAhead?: string;
  id: string;
  orderNo?: string;
  clientId?: string;
  clientName?: string;
  warehouseId?: string;
  remark?: string | null;
  batchNo?: string;
  latestRemark?: string;
  logisticsRecords?: Array<{
    remark: string;
    changedAt: string;
    fromStatus?: string;
    toStatus?: string;
    // 2026-09-15：operatorRole / operatorName 已不再下发（/client/orders 只给客户，操作人只有超级管理员能看）
  }>;
  itemName: string;
  transportMode: string;
  cargoType?: string;
  approvalStatus?: "pending" | "approved" | "shipped" | "received";
  domesticTrackingNo?: string;
  trackingNo?: string;
  currentStatus?: string;
  statusGroup?: "pending" | "transit" | "arrived" | "delivered" | "closed";
  productQuantity: number;
  packageCount: number;
  packageUnit: string;
  weightKg?: number;
  volumeM3?: number;
  totalWeightKg?: number | null;
  totalVolumeM3?: number | null;
  receivableAmountCny?: number | null;
  receivableCurrency?: "CNY" | "THB";
  paymentStatus?: "paid" | "unpaid";
  paidAt?: string;
  paidBy?: string;
  paymentProofUploadedAt?: string;
  shipDate?: string;
  createdAt: string;
  updatedAt?: string;
  productImages?: OrderProductImageItem[];
  products?: OrderProductItem[];
}

/**
 * ⚠️ 必须和后端 /admin/dashboard/overview 的返回逐字对齐
 * （apps/api/src/modules/admin/routes.ts）。这里写了后端没有的字段，
 * TypeScript 不会报错，页面上却会读到 undefined —— 2026-08-07 客户端就这么崩过一次。
 */
export interface AdminOverview {
  staffAccountCount: number;
  clientAccountCount: number;
  newOrderCountToday: number;
  inTransitOrderCount: number;
  receivedVolumeM3Today: number;
  /**
   * 柜子分段统计（2026-08-07 新增，取代前端按柜号去重的老算法）。
   * 四段相加 = containerTotalCount，后端用减法保证不漏任何状态。
   */
  containerLoadingCount: number;
  containerOnTheWayCount: number;
  containerAtWarehouseCount: number;
  containerDoneCount: number;
  containerTotalCount: number;
  /**
   * 卡住的柜子（2026-08-21 新增）：装柜太久还没到仓，或者太久没人推状态。
   * reason: overdue=超期未到仓，idle=长时间没推进。
   */
  stalledContainers: Array<{
    containerNo: string;
    transportMode: string;
    currentStatus: string;
    /** 中文状态名，由后端下发（前端不再自己维护一份对照表） */
    currentStatusZh: string;
    loadedDays: number | null;
    idleDays: number | null;
    shipmentCount: number;
    reason: "overdue" | "idle";
  }>;
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
  /**
   * 2026-09-16 代理账号：以下三项只有 GET /admin/users?role=client 才有（只给超级管理员的接口）。
   * 员工端客户下拉走 /staff/clients，那边没有这些字段。
   */
  agentId?: string | null;
  agentName?: string | null;
  whrPrice?: AdminClientWhrPrice | null;
}

/** 客户长期价（仓库版集货，元/方） */
export interface AdminClientWhrPrice {
  normal: number;
  inspection: number;
  sensitive: number;
  /** 谁填的：admin / agent；null = 上线时按这个客户最近一个柜的价自动填的 */
  filledByRole: string | null;
  updatedAt: string;
}

/** 开客户选归属用的代理下拉（B2 的 GET /admin/agents/list 里只取 id 和名字；不能用 /admin/agents，那是页面地址，请求到不了后端） */
export interface AgentOption {
  id: string;
  name: string;
}

/**
 * 代理下拉列表。接口没好 / 出错时返回空数组，不让「客户管理」整块报错
 * （选不了代理时照样能开湘泰自己的客户）。
 */
export async function fetchAgentOptions(): Promise<AgentOption[]> {
  try {
    const data = await apiRequest<{ items?: Array<{ id: string; name: string }> }>(`${apiBaseUrl()}/admin/agents/list`);
    return (data.items ?? []).map((a) => ({ id: a.id, name: a.name }));
  } catch {
    return [];
  }
}

/**
 * 超管填 / 改湘泰自己客户的长期价（2026-09-16）。代理的客户后端会 403。
 * 改完「计划中/收货中/装柜中」柜里没付款的单自动按新价重算，updatedPlanRows = 跟着改了几个柜。
 */
export async function setAdminClientWhrPrice(payload: {
  clientId: string;
  unitPriceNormal: number;
  unitPriceInspection: number;
  unitPriceSensitive: number;
}): Promise<{ clientId: string; whrPrice: { normal: number; inspection: number; sensitive: number }; updatedPlanRows: number }> {
  return apiRequest(`${apiBaseUrl()}/admin/clients/whr-price`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export interface AdminOrderItem {
  /** 子单进度不一样时，最快的那批走到哪了（2026-09-16）。空 = 没有子单或进度一致 */
  partialAhead?: string;
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
  /** 长/宽/高来自「产品行」；一张单有多个不同尺寸时是 "60/50" 这样的字符串（2026-08-27 加） */
  lengthCm?: number | string;
  widthCm?: number | string;
  heightCm?: number | string;
  volumeM3: number | null;
  totalWeightKg?: number | null;
  totalVolumeM3?: number | null;
  receiverAddressTh?: string;
  containerNo?: string;
  remark?: string | null;
  trackingNo?: string;
  currentStatus?: string;
  canEdit?: boolean;
  receivableAmountCny?: number | null;
  receivableCurrency?: "CNY" | "THB";
  paymentStatus?: "paid" | "unpaid";
  shipDate: string | null;
  /* 2026-09-03：收窄成五个分组的联合类型（原来是宽松的 string）。
     后端已改成按运单当前状态实时算，不再发数据库那个从没更新过的死字段。
     ⚠️ 必须和 packages/shared-types 的 ClientStatusGroup 对得上 —— 导出 Excel
     那列靠它查中文名，写成 string 的话拼错一个字母 TypeScript 也不会拦。 */
  statusGroup?: ClientStatusGroup;
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
  deliveryNo: string;
  shipmentId: string;
  carrierName: string;
  externalTrackingNo: string;
  driverName?: string | null;
  licensePlate?: string | null;
  phoneNumber?: string | null;
  status: string;
  updatedAt: string;
}

/* 2026-08-31（Codex 二轮）：删掉 AdminSettlementEntryItem / AdminProfitItem 两个类型——
   只有下面三个零调用的死包装在用，随包装一起删（后端 /admin/settlement 接口另一路处理） */

export interface AdminOpsOverview {
  // 2026-08-27：后端已不再返回 profitSummary / profitTrend（按运单算利润那套已废弃）
  customsAlerts: Array<{
    id: string;
    /** 2026-08-27 补：后端一直在返回，类型里漏了，页面只能用 any 绕过 */
    shipmentTrackingNo?: string | null;
    shipmentId?: string;
    orderId?: string;
    status: string;
    remark?: string;
    updatedAt: string;
  }>;
  supplierPriceAlerts: Array<{
    routeCode: string;
    supplierName: string;
    transportMode: string;
    seasonTag: string;
    currency: string;
    previousQuotePrice: number;
    latestQuotePrice: number;
    delta: number;
    updatedAt: string;
  }>;
}

/**
 * 财务页的一行 = 一张集货单（2026-08-27 改）。
 * 改之前这一行是「一张运单」，但老板口径：运单跟钱无关，钱只在集货那两个功能里。
 */
export interface FinanceRow {
  /** normal=普通版集货 | warehouse=仓库版集货 */
  kind: "normal" | "warehouse";
  kindLabel: string;
  /** 普通版是任务号 JH…，仓库版是预报单号 WHRP… */
  no: string;
  /** 普通版是唛头（账号），仓库版是客户下单时自己填的唛头 */
  client: string;
  /** 唛头（账号），只给搜索用（仓库版那一行显示的 client 是客户自填的唛头，按账号搜要靠它） */
  clientId: string;
  status: string;
  statusZh: string;
  /** ⚠️ null = 还没报价，页面上要显示「—」，不能显示 ¥0.00 */
  amount: number | null;
  paid: boolean;
  createdAt: string;
}

export interface FinanceSummary {
  /** 货已到仓、报了价、客户还没付 —— 真正该催的钱 */
  receivableAmount: number;
  receivableCount: number;
  receivedAmount: number;
  receivedCount: number;
  /** 还没到该收钱的环节：仓库版「等收货」+ 普通版「收集中/已满待报价」。不算应收 */
  notYetAmount: number;
  notYetCount: number;
  /** 客户充值了还没花掉的钱 */
  balanceAmount: number;
  balanceClientCount: number;
  rows: FinanceRow[];
}

/**
 * ⚠️ 超时（2026-08-29 加）。
 * 批量建单是**一张一张顺序发**的，中间任何一张卡住（服务器僵住、网络半死不活），
 * 整批就停在那里，员工只看到「正在创建第 37/100 个运单…」一直不动，
 * 也不知道该等还是该重来。给一个上限，卡住的那张按失败处理，后面继续跑。
 *
 * ⚠️ 超时**不等于没建成**：请求可能已经到服务器并且建好了，只是回话没回来。
 * 所以提示语里必须让员工先去运单列表搜一下再重试，
 * 不能让他闭着眼睛点「继续建剩下的」（那样会撞「运单号已存在」）。
 */
const STAFF_ORDER_TIMEOUT_MS = 30_000;

export async function createStaffOrder(payload: StaffCreateOrderPayload): Promise<{
  orderId: string;
  createdAt: string;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STAFF_ORDER_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}/staff/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(
        `服务器 ${STAFF_ORDER_TIMEOUT_MS / 1000} 秒没有回应。这张单**可能已经建好了**，` +
        `请先去运单列表搜一下这个运单号，确认没有再重试`,
      );
    }
    throw new Error("网络中断，这张单可能已经建好了，请先去运单列表搜一下这个运单号，确认没有再重试");
  } finally {
    clearTimeout(timer);
  }
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

// ===== 客户端充值 =====

/**
 * 客户端提交充值申请。
 */
export async function submitRecharge(payload: {
  amount: number;
  /** 2026-08-07 起集货余额只有人民币，后端强制按 CNY 入账，这里不用再传 */
  paymentMethod: string;
  proofImage: string;
  remark?: string;
}): Promise<{ id: string; status: string; message: string }> {
  const response = await fetch(`${apiBaseUrl()}/client/wallet/recharge`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

/** 集货余额流水一行（2026-08-07 新增） */
export interface ConsolidationLedgerItem {
  id: string;
  type: string;
  typeLabel: string;
  /** 正数进账、负数出账 */
  amount: number;
  balanceAfter: number;
  source: string;
  refNo: string;
  remark: string;
  createdAt: string;
}

/**
 * 客户端获取集货余额流水（充值到账 / 集货付款 / 撤销退款）。
 * 2026-09-01 Codex 复核收尾：加分页参数（照抄 fetchClientPrealerts 的写法）。
 * 原来固定只拿前 200 条、total 就是本次条数，流水多了老记录静默消失（教训21）。
 */
export async function fetchConsolidationLedger(
  params?: { page?: number; pageSize?: number },
): Promise<{ items: ConsolidationLedgerItem[]; total: number; page: number; pageSize: number }> {
  const query = new URLSearchParams();
  if (params?.page) query.set("page", String(params.page));
  if (params?.pageSize) query.set("pageSize", String(params.pageSize));
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const response = await fetch(`${apiBaseUrl()}/client/wallet/ledger${suffix}`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: ConsolidationLedgerItem[]; total?: number; page?: number; pageSize?: number }>(response);
  /* 2026-09-01 终验收尾：page/pageSize 不再丢掉，原样透传给调用方（钱包页用后端
     回的 page 校准页码；非法页码后端直接 400 中文报错（2026-09-01 起不再静默夹紧），前端不能自己猜）。
     后端现在一定返回这三个字段；?? 兜底只为兼容还没部署新版的老后端——
     老响应缺字段时 page/pageSize 退回请求参数，total 退回本页条数（至少不显示 undefined）。 */
  return {
    items: data.items,
    total: data.total ?? data.items.length,
    page: data.page ?? params?.page ?? 1,
    pageSize: data.pageSize ?? params?.pageSize ?? data.items.length,
  };
}

/**
 * 客户端获取充值记录。
 */
export async function fetchClientWalletRecharges(): Promise<{ recharges: WalletRechargeItem[] }> {
  const response = await fetch(`${apiBaseUrl()}/client/wallet/recharges`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

// ===== 管理员充值审核 =====

/**
 * 管理员获取充值审核列表。
 */
export async function fetchAdminRecharges(status?: string): Promise<{ recharges: AdminWalletRechargeItem[] }> {
  const query = status ? `?status=${status}` : "";
  const response = await fetch(`${apiBaseUrl()}/admin/wallet/recharges${query}`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

/**
 * 管理员通过充值申请。
 */
export async function approveRecharge(id: string): Promise<{ approved: boolean; id: string }> {
  const response = await fetch(`${apiBaseUrl()}/admin/wallet/recharges/approve`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  return parseApiResponse(response);
}

/**
 * 管理员拒绝充值申请。
 */
export async function rejectRecharge(id: string, reviewRemark: string): Promise<{ rejected: boolean; id: string }> {
  const response = await fetch(`${apiBaseUrl()}/admin/wallet/recharges/reject`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ id, reviewRemark }),
  });
  return parseApiResponse(response);
}

// ===== 员工端客户余额 =====

/**
 * 员工端获取所有客户余额。
 */
export async function fetchStaffWalletBalances(): Promise<{ balances: StaffWalletBalanceItem[] }> {
  const response = await fetch(`${apiBaseUrl()}/staff/wallet/balances`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

export async function fetchClientOrders(params?: {
  statusGroup?: ClientStatusGroup | "attention";
}): Promise<OrderItem[]> {
  const query = new URLSearchParams();
  if (params?.statusGroup) query.set("statusGroup", params.statusGroup);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const orders = await fetchAllPages<OrderItem>(`/client/orders${suffix}`);
  /* 「异常」2026-09-05 起后端也认（每页只回异常单，不再整页拉全量）。
     这里再筛一道是兜底：万一后端还是老版本、不认 attention 就当「不过滤」把全量回来，
     前端照样能筛对——两边谁先上线都不会出错。 */
  return params?.statusGroup === "attention"
    ? orders.filter((order) => matchesShipmentListFilter(order.currentStatus, "attention"))
    : orders;
}

/**
 * 获取客户端预报单列表
 * @param status 预报单状态：pending(待审核), approved(已审核/待发货), shipped(已发货), all(全部)
 */
export async function fetchClientPrealerts(
  status: string = "pending",
  params?: { page?: number; pageSize?: number },
): Promise<{ items: OrderItem[]; total: number }> {
  // 2026-08-31：原来固定只拿一页、也不给总数，客户端两处列表都被砍到前 50 条还看不出来。
  const query = new URLSearchParams({ status });
  if (params?.page) query.set("page", String(params.page));
  if (params?.pageSize) query.set("pageSize", String(params.pageSize));
  const response = await fetch(`${apiBaseUrl()}/client/prealerts?${query.toString()}`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: OrderItem[]; total?: number }>(response);
  return { items: data.items, total: data.total ?? data.items.length };
}

/* 2026-08-31（复查条目24 / 条目48收尾）：deleteClientPrealert / updateClientPrealert 已删 ——
   唯一调用方是客户端那个没有入口的「编辑预报单」死弹窗，弹窗条目48已删，
   全 web 目录 grep 引用为 0，留着就是新的死导出（教训9）。
   连带删掉上面那段「客户确认发货」的孤儿注释（它说的函数早就没了）。
   后端 /client/prealerts/update、/client/prealerts/delete 两个接口已于 2026-09-02 按老板拍板下线，
   客户还能不能自助改/删预报单要老板拍板。 */

export async function fetchStaffPrealerts(): Promise<OrderItem[]> {
  const response = await fetch(`${apiBaseUrl()}/staff/prealerts`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: OrderItem[] }>(response);
  return data.items;
}

export async function receiveStaffPrealert(payload: {
  orderId: string;
  itemName?: string;
  packageCount?: number;
  packageUnit?: "bag" | "box";
  productQuantity?: number;
  weightKg?: number;
  volumeM3?: number;
  domesticTrackingNo?: string;
  transportMode?: "sea" | "land";
  cargoType?: string;
  /* 2026-08-31：柜号随收货保存；应收金额一度接过、当晚按老板拍板拆除（钱只在集货里）。 */
  batchNo?: string;
}): Promise<{ orderId: string; status: string; updatedAt: string }> {
  const response = await fetch(`${apiBaseUrl()}/staff/prealerts/receive`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
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

/* ==========================================================================
   按 total 翻页拿完，不要只拿第一页（2026-08-10）
   --------------------------------------------------------------------------
   原来这里写死 `pageSize=500&page=1`，只拿第一页。生产上运单已经 663 条，
   **第 501 条往后的 163 条在页面上等于不存在** —— 而且搜索是在已拿回来的
   那批里用 useMemo 筛的，所以那些老运单不管怎么搜都搜不到（用户实测
   搜 YW0001276 显示「暂无匹配订单」，但它在库里好好的）。

   这跟 CLAUDE.md 第 19 条是同一个坑（尾端派送丢货）：
   **前端筛只对「已经全拿到」的数据成立。要拿全就得按 total 翻页拿完。**
   ========================================================================== */
const PAGE_SIZE = 500;
/** 安全上限：50 页 = 25000 条。到顶了在控制台喊一声，别再像以前那样静默截断 */
const MAX_PAGES = 50;

async function fetchAllPages<T>(path: string): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const response = await fetch(`${apiBaseUrl()}${path}${sep}pageSize=${PAGE_SIZE}&page=${page}`, {
      method: "GET",
      headers: { ...authHeaders() },
    });
    const data = await parseApiResponse<{ items: T[]; total?: number }>(response);
    const items = data.items ?? [];
    all.push(...items);
    // 有些老接口是先分页、再做状态筛选，total 仍是筛选前总数。
    // 因此不能用 all.length >= total：筛选后每页可能少于 500，
    // all.length 永远追不上 total，会白跑到 50 页上限。按后端页进度才能既拿全又正确停止。
    const done = typeof data.total === "number" ? page * PAGE_SIZE >= data.total : items.length < PAGE_SIZE;
    if (done) return all;
    if (page === MAX_PAGES) {
      console.warn(`[列表没拿全] ${path} 已拿 ${all.length} 条，到了 ${MAX_PAGES} 页上限还没拿完，请改用后端搜索`);
    }
  }
  return all;
}

export async function fetchStaffShipments(): Promise<ShipmentItem[]> {
  return fetchAllPages<ShipmentItem>("/staff/shipments");
}

/** 运单列表顶部那排数字（A3 方案 §3.2）。三端同一套字段，口径一致。
 *  ⚠️ 必须和后端 countShipmentOverview() 的返回逐字对齐 —— TypeScript 不会替你核对。 */
export interface StaffShipmentOverview {
  /** 在途：从国内仓发出、还没进泰国仓（含「正在卸柜」）*/
  inTransitCount: number;
  /** 延迟 · 查验：延迟开船 / 海上延误 / 口岸滞留 / 港口封港 / 三种海关查验（国内·泰国·陆运口岸）/ 异常。
   *  2026-09-03 从 5 个补到 8 个 —— 清单在 packages/shared-types 的 ATTENTION_STATUSES，
   *  查验类从流程表推导，别在这条注释里手抄一份，会过期。 */
  attentionCount: number;
  /** 已到仓：进泰国仓到客户签收之前的整段（已到仓 + 预约派送 + 派送中）。
   *  2026-09-03 起含派送中 —— 原来只数 inWarehouseTH。 */
  atWarehouseCount: number;
  /** 本月已签收 */
  signedThisMonthCount: number;
  /** 下面几个是后端返回的对账字段，界面不显示 */
  totalCount: number;
  /** 未发出（已创建 + 已入库）—— 2026-09-02 起后端把 inWarehouseCN 也算进这格 */
  createdCount: number;
  deliveringCount: number;
  doneCount: number;
  /** 异常单数（2026-09-02 复核整改：后端已从「在途」减法里扣掉并单独返回；
   *  对账等式 2026-09-03 起 = 未发出 + 已到仓（含派送中）+ 已完成 + 异常 + 在途。
   *  设成可选：老后端没这字段时前端拿到 undefined 不报错 —— TypeScript 不会替你核对 */
  exceptionCount?: number;
}

/** 员工端和管理员端共用这个接口（后端 requireRole 里就允许这两个角色） */
export async function fetchStaffShipmentOverview(): Promise<StaffShipmentOverview> {
  const response = await fetch(`${apiBaseUrl()}/staff/shipments/overview`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse<StaffShipmentOverview>(response);
}

/** 客户端只数自己的运单，所以是另一个接口，返回结构完全一样 */
export async function fetchClientShipmentOverview(): Promise<StaffShipmentOverview> {
  const response = await fetch(`${apiBaseUrl()}/client/shipments/overview`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse<StaffShipmentOverview>(response);
}


/**
 * 尾端派送能挑的运单状态：已到仓 / 预约派送 / 派送中 / 已签收
 *
 * ⚠️ 2026-08-13 补上 deliveryBooked（预约派送）。加这个状态时漏了这里，
 *    结果是**推到「预约派送」的货在尾端派送页面上直接消失**，员工找不到就发不出去。
 *    跟 2026-08-06「445 张运单选不到」是同一个坑：状态清单写死在好几处，加状态要全找一遍。
 */
const LASTMILE_STATUSES = "inWarehouseTH,deliveryBooked,outForDelivery,delivered";

export interface LastmileShipmentItem {
  id: string;
  trackingNo: string;
  clientId: string;
  itemName: string;
  packageCount: number;
  hasChildren?: boolean;
  containerNo?: string;
  receiverName?: string;
  receiverPhone?: string;
  receiverAddress?: string;
}

/**
 * 拉取尾端派送可选的全部运单。
 *
 * ⚠️ 2026-08-06 修的一个真丢货的 bug：
 * 原来 staff 和 admin 两个页面各自写 `/staff/shipments?pageSize=500&all=1`，
 * 拿回「按更新时间倒序的前 500 条（所有状态混在一起）」再在前端筛这三种状态。
 * 生产实测：能派送的运单 571 张，但排进前 500 的只有 126 张 —— **445 张、5791 件货
 * 页面上根本选不到**，粘贴运单号批量勾选时这些号码会被静默丢弃，员工以为加进去了。
 *
 * 现在：① 让后端按状态筛（新增 status 参数）；② 按 total 翻页拿完，不止第 1 页。
 * 两个页面都改成调这个函数，别再各写各的。
 */
export async function fetchLastmileShipments(): Promise<LastmileShipmentItem[]> {
  const pageSize = 500;
  const collected: any[] = [];
  let page = 1;
  let total = 0;
  // 最多翻 20 页兜底，防止 total 异常时死循环
  while (page <= 20) {
    const url = `${apiBaseUrl()}/staff/shipments?pageSize=${pageSize}&page=${page}&all=1&status=${encodeURIComponent(LASTMILE_STATUSES)}`;
    const response = await fetch(url, { method: "GET", headers: { ...authHeaders() } });
    const data = await parseApiResponse<{ items: any[]; total?: number }>(response);
    const items = data.items ?? [];
    collected.push(...items);
    total = data.total ?? collected.length;
    if (items.length === 0 || collected.length >= total) break;
    page += 1;
  }
  return collected.filter((s) => s.parentTrackingNo || !s.hasChildren || (s.packageCount ?? 0) !== 0).map((s) => ({
    id: s.id,
    trackingNo: s.trackingNo,
    clientId: s.clientId ?? "",
    // 候选列表上的品名把全部产品名带出来（2026-09-10）：s.itemName 只存了第一个产品名
    itemName: productNamesLabel(s.products, s.itemName ?? ""),
    packageCount: s.packageCount ?? 0,
    hasChildren: s.hasChildren,
    containerNo: s.containerNo || undefined,
    receiverName: s.receiverNameTh || undefined,
    receiverPhone: s.receiverPhoneTh || undefined,
    receiverAddress: s.receiverAddressTh || undefined,
  }));
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
  /* 2026-08-31：应收金额/币种从这个「写」载荷里拆除——后端 2026-08-07 起就不收，
     一直是发了也白发的死字段（钱只在集货里）。列表展示用的读字段在 OrderItem 上，不受影响。 */
  warehouseId?: string;
  remark?: string | null;
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

export async function fetchAdminOverview(signal?: AbortSignal): Promise<AdminOverview> {
  const response = await fetch(`${apiBaseUrl()}/admin/dashboard/overview`, {
    method: "GET",
    headers: { ...authHeaders() },
    signal,
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

/** 同 fetchStaffShipments：按 total 翻页拿完，别只拿第一页（见那边的注释） */
export async function fetchAdminOrders(): Promise<AdminOrderItem[]> {
  return fetchAllPages<AdminOrderItem>("/admin/orders");
}

/**
 * 管理员更新客户端订单基础信息。
 */
export async function updateAdminOrder(payload: {
  orderId: string;
  // 除 orderId 外全部可选：只传本次改动过的项，没传的后端不会去动
  clientId?: string;
  itemName?: string;
  cargoType?: string;
  transportMode?: "sea" | "land";
  domesticTrackingNo?: string;
  trackingNo?: string;
  batchNo?: string;
  warehouseId?: string;
  remark?: string | null;
  receiverAddressTh?: string;
  containerNo?: string;
  productQuantity?: number;
  packageCount?: number;
  packageUnit?: "bag" | "box";
  weightKg?: number | null;
  volumeM3?: number | null;
  paymentStatus?: "paid" | "unpaid";
  shipDate?: string;
  products?: Array<{
    /** 已有产品行的编号；不传表示新增一行 */
    id?: string;
    itemName: string;
    packageCount: number;
    lengthCm?: number;
    widthCm?: number;
    heightCm?: number;
    productQuantity?: number;
    cargoType?: string;
    domesticTrackingNo?: string;
    weightKg?: number;
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
}, signal?: AbortSignal): Promise<{ id: string; name: string; phone: string; createdAt: string }> {
  const response = await fetch(`${apiBaseUrl()}/admin/users`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

// deleteAdminStaff() 已删除（2026-08-07）。
// 账号不再支持删除，改用 toggleUserBan() 封禁：账号登不进来，但单据、图片、余额全留着。
// 原因：数据库有 15 张表以 RESTRICT 认着账号，名下有任何一条记录就删不掉；
// 而且这个函数删员工时漏传管理员密码，后端第一关就打回，从来没成功过。
// 后端 DELETE /admin/users 也已停用。


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
  /** 2026-09-16：开在哪个代理名下；不传 / null = 湘泰自己的客户 */
  agentId?: string | null;
}, signal?: AbortSignal): Promise<{ id: string; name: string; companyName: string | null; phone: string; email: string | null; createdAt: string; agentId: string | null; agentName: string | null }> {
  const response = await fetch(`${apiBaseUrl()}/admin/users/client`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

export async function updateAdminClient(payload: {
  id: string;
  name?: string;
  companyName?: string;
  phone?: string;
  email?: string;
  password?: string;
  /** 2026-09-16：不传 = 不改归属；null = 改回湘泰。客户已有运单/集货记录时后端会拒 */
  agentId?: string | null;
}, signal?: AbortSignal): Promise<{ id: string; name: string; companyName: string | null; phone: string; email: string | null; createdAt: string; agentId: string | null }> {
  const response = await fetch(`${apiBaseUrl()}/admin/users/client/update`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

export async function fetchAdminAiSessionMemory(params?: {
  limit?: number;
}): Promise<{ items: AdminAiSessionMemoryItem[]; total: number; limit: number }> {
  const query = new URLSearchParams();
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
  sessionId?: string;
  userId?: string;
}): Promise<{ removed: number; companyId: string; sessionId: string | null; userId: string | null }> {
  const query = new URLSearchParams();
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
  status?: "open" | "resolved";
}): Promise<{ items: AdminAiKnowledgeGapItem[]; total: number; status: "open" | "resolved" | "all" }> {
  const query = new URLSearchParams();
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
  shipmentIds: string[];
  driverName?: string;
  licensePlate?: string;
  phoneNumber?: string;
  status?: string;
}): Promise<{ deliveryNo: string; count: number }> {
  const response = await fetch(`${apiBaseUrl()}/admin/lastmile/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

/* 2026-08-31（Codex 二轮）：删掉 fetchAdminSettlementEntries / createAdminSettlementEntry /
   fetchAdminProfitAnalysis 三个死包装——grep 全仓库零调用（按运单算利润那套 08-27 已废弃） */

/**
 * 获取管理员运营总控看板数据（毛利/关务预警/报价变动）。
 */
export async function fetchAdminOpsOverview(signal?: AbortSignal): Promise<AdminOpsOverview> {
  const response = await fetch(`${apiBaseUrl()}/admin/ops/overview`, {
    method: "GET",
    headers: { ...authHeaders() },
    signal,
  });
  return parseApiResponse(response);
}

/**
 * 获取财务汇总数据。
 */
/* ── 一个柜收了客户多少钱（2026-08-27）──────────────────────────
   ⚠️ 这几个类型是手写的，TypeScript 不会去核对后端。
   改后端 ok(res, {...}) 的结构后必须回来同步（CLAUDE.md 第 22 条）。 */
export interface ContainerRevenueCustomer {
  /** 唛头（账号），不是客户名字 */
  clientId: string;
  received: number;
  receivable: number;
  /** 还没到该收钱的环节（仓库版等收货 / 普通版收集中、已满待报价），不算待收 */
  notYet: number;
  orderCount: number;
  /** 名下真报过价的单数；0 = 一张都没报价 → 金额要显示「—」不是「¥0.00」 */
  quotedCount: number;
}
export interface ContainerRevenueRow {
  kind: "normal" | "warehouse";
  kindLabel: string;
  /** 普通版是任务号 JH…，仓库版是计划号 WHR… */
  no: string;
  /** 仓库版是柜型 40HQ，普通版是员工手填的柜号（可能是「—」） */
  containerType: string;
  status: string;
  customerCount: number;
  orderCount: number;
  quotedCount: number;
  received: number;
  receivable: number;
  notYet: number;
  total: number;
  /** ⚠️ 页面目前不显示它，只用于后端排序；要加日期列时直接用（注意按北京时间换算） */
  createdAt: string;
  customers: ContainerRevenueCustomer[];
}
export interface ContainerRevenueSummary {
  totalReceived: number;
  totalReceivable: number;
  totalNotYet: number;
  containerCount: number;
  rows: ContainerRevenueRow[];
}

export async function fetchContainerRevenue(): Promise<ContainerRevenueSummary> {
  const response = await fetch(`${apiBaseUrl()}/admin/settlement/by-container`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

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

// ManagedUser / fetchManagedUsers / createManagedUser / resetUserPassword 已删除（2026-08-07）。
// 它们只服务于「账号管理」页，而那个页面和「员工管理」「客户管理」是同一套功能、
// 调的还是同一批接口（/admin/users、/admin/users/set-password、toggle-ban），
// 用户要求砍掉重复入口，页面已删。
// 员工/客户列表用 fetchAdminStaff / fetchAdminClients，改密码用 setAdminStaffPassword。

/**
 * 禁用/启用用户（管理员）。
 */
export async function toggleUserBan(userId: string, signal?: AbortSignal): Promise<{ id: string; status: string }> {
  const response = await fetch(`${apiBaseUrl()}/admin/users/toggle-ban`, {
    method: "POST",
    signal,
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
  /** sea = 海运 | land = 陆运 | null = 2026-08-05 之前建的老柜子，还没标 */
  transportMode: string | null;
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
    clientId: string | null;
    productQuantity: number | null;
    cargoType: string | null;
    packageCount: number | null;
    transportMode: string | null;
    currentStatus: string | null;
    parentTrackingNo: string | null;
    loadedPieces: number;
    loadedVolume: number;
  }>;
}

/**
 * 创建装柜清单。
 */
export async function createLoadingManifest(payload: {
  warehouse: string;
  /** 必填，后端只认 sea / land，不传会 400 */
  transportMode: string;
  carrierInfo?: string;
  containerNo?: string;
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
export async function fetchLoadingManifests(filters?: { query?: string; trackingNo?: string; status?: string; transportMode?: string }): Promise<LoadingManifestItem[]> {
  const params = new URLSearchParams();
  if (filters?.query) params.set("query", filters.query);
  if (filters?.trackingNo) params.set("trackingNo", filters.trackingNo);
  if (filters?.status) params.set("status", filters.status);
  // sea / land / none（none = 只看还没标运输方式的老柜子）
  if (filters?.transportMode) params.set("transportMode", filters.transportMode);
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
 * 改柜子的运输方式（给「未标注」的老柜子补上；状态已经走到某一方专属环节时后端会拒绝）。
 */
export async function setManifestTransportMode(manifestId: string, transportMode: string): Promise<{ transportMode: string }> {
  const response = await fetch(`${apiBaseUrl()}/staff/loading-manifests/transport-mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ id: manifestId, transportMode }),
  });
  return parseApiResponse(response);
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
export async function sealLoadingManifest(manifestId: string): Promise<{ message: string; manifest: { id: string; status: string } }> {
  const response = await fetch(`${apiBaseUrl()}/staff/loading-manifests/seal?id=${manifestId}`, {
    method: "POST",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

/**
 * 添加运单到装柜清单。
 */
export async function removeShipmentFromManifest(manifestId: string, itemId: string, pieceCount?: number): Promise<{ message: string }> {
  const response = await fetch(`${apiBaseUrl()}/staff/loading-manifests/remove-shipment?id=${manifestId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ itemId, pieceCount }),
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

export async function addShipmentToManifest(manifestId: string, trackingNo: string, pieceCount?: number): Promise<{ message: string; trackingNo: string; isPartial?: boolean; parentTrackingNo?: string; warning?: string | null }> {
  const response = await fetch(`${apiBaseUrl()}/staff/loading-manifests/add-shipment?id=${manifestId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ trackingNo, pieceCount }),
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

/** 推进柜子状态 */
export async function updateContainerStatus(payload: {
  id: string;
  toStatus: string;
  remark?: string;
  date?: string;
  /** 「下一站【泰国边境】」，不传则后端按状态取默认值 */
  nextStop?: string;
}): Promise<{
  containerNo: string;
  fromStatus: string;
  toStatus: string;
  affectedShipmentCount: number;
  /** 已派送/签收（比这一步靠后）、退回、取消的货推柜子时跳过，列在这里（2026-09-17 推进账本） */
  skippedShipments?: Array<{ trackingNo: string; status: string }>;
}> {
  const response = await fetch(`${apiBaseUrl()}/admin/containers/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

/**
 * 撤销预览（2026-09-17 推进账本）：点撤销之前告诉员工柜子退到哪一步、几票货跟着退、哪几票不动为什么。
 */
export async function fetchUndoPreview(id: string): Promise<{
  mode: "ledger" | "legacy";
  currentStatus: string;
  prevStatus: string;
  revertCount: number;
  keep: Array<{ trackingNo: string; reason: string }>;
}> {
  const response = await fetch(`${apiBaseUrl()}/admin/containers/status/undo-preview?id=${encodeURIComponent(id)}`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}

/**
 * 撤销这个柜子上一次的状态推进：柜子退回上一步，柜里还停在这一步的货跟着退、这一步的轨迹一起删掉。
 * 推错了整柜一次撤，不用一张张运单去删。
 * expectStatus 传页面上看到的柜子状态：对不上（别人刚撤过 / 推过）后端不撤，页面没刷新连点两下不会多撤一步。
 */
export async function undoContainerStatus(id: string, expectStatus?: string): Promise<{
  containerNo: string;
  undoneStatus: string;
  currentStatus: string;
  deletedLogs: number;
  affectedShipmentCount: number;
  skippedShipments?: Array<{ trackingNo: string; reason: string }>;
  restoredLogs?: number;
}> {
  const response = await fetch(`${apiBaseUrl()}/admin/containers/status/undo`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ id, ...(expectStatus ? { expectStatus } : {}) }),
  });
  return parseApiResponse(response);
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

// ============================================================================
// 集货拼柜模块
// ============================================================================

/** 集货产品明细项 */
export interface ConsolidationProductItem {
  id: string;
  productName: string;
  packageCount: number;
  quantityPerBox: number;
  totalQuantity: number;
  unitWeight: number | null;
  totalWeight: number | null;
  length: number | null;
  width: number | null;
  height: number | null;
  volume: number | null;
  material: string;
  cargoValue: string;
  /** 货型：normal | inspection | sensitive。只作记录，不参与计价 */
  cargoType: string;
  productImageFileName: string | null;
  productImageMime: string | null;
  productImageBase64: string | null;
  sortOrder: number;
}

/** 集货预报单列表项 */
export interface ConsolidationPrealertItem {
  id: string;
  taskId: string;
  trackingNo: string;
  expressNo: string | null;
  mark: string;
  status: "pending" | "received";
  signedAt: string | null;
  receivedProofFileName: string | null;
  receivedProofMime: string | null;
  receivedProofBase64: string | null;
  products: ConsolidationProductItem[];
  createdAt: string;
}

/** 集货任务列表项 */
export interface ConsolidationTaskItem {
  id: string;
  taskNo: string;
  destinationTh: string;
  status: string;
  maxVolumeM3: number;
  totalVolumeM3: number;
  totalPackages: number;
  totalPrealerts: number;
  bookingFee: number | null;
  customsFee: number | null;
  loadingFee: number | null;
  totalFee: number | null;
  currency: string;
  paymentStatus: string;
  paidAt: string | null;
  paymentProofBase64: string | null;
  paymentProofUploadedAt: string | null;
  paymentRejectReason: string | null;
  paymentReviewedAt: string | null;
  containerNo: string | null;
  loadingDate: string | null;
  clientId?: string;
  clientName?: string;
  clientPhone?: string;
  createdAt: string;
  updatedAt: string;
  volumePercent: number;
  isNearFull: boolean;
  prealerts?: ConsolidationPrealertItem[];
  statusLogs?: any[];
}

// ============================================================================
// 客户端接口
// ============================================================================

/** 获取客户端集货任务列表 */
export async function fetchClientConsolidationTasks(status?: "active"): Promise<ConsolidationTaskItem[]> {
  try {
    const params = status ? `?status=${encodeURIComponent(status)}` : "";
    return await apiRequest<ConsolidationTaskItem[]>(
      `${apiBaseUrl()}/client/consolidation/tasks${params}`,
    );
  } catch (error) {
    throw new Error(`获取集货任务列表失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 获取客户端集货任务详情 */
export async function fetchClientConsolidationTaskDetail(taskId: string): Promise<ConsolidationTaskItem> {
  try {
    return await apiRequest<ConsolidationTaskItem>(
      `${apiBaseUrl()}/client/consolidation/tasks/detail?taskId=${encodeURIComponent(taskId)}`,
    );
  } catch (error) {
    throw new Error(`获取任务详情失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 创建集货任务 */
export async function createConsolidationTask(destinationTh: string): Promise<ConsolidationTaskItem> {
  try {
    return await apiRequest<ConsolidationTaskItem>(
      `${apiBaseUrl()}/client/consolidation/tasks`,
      { method: "POST", body: JSON.stringify({ destinationTh }) },
    );
  } catch (error) {
    throw new Error(`创建任务失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 修改任务目的地 */
export async function updateConsolidationTask(taskId: string, destinationTh: string): Promise<ConsolidationTaskItem> {
  try {
    return await apiRequest<ConsolidationTaskItem>(
      `${apiBaseUrl()}/client/consolidation/tasks/update`,
      { method: "POST", body: JSON.stringify({ taskId, destinationTh }) },
    );
  } catch (error) {
    throw new Error(`更新任务失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 创建预报单 */
export async function createConsolidationPrealert(payload: {
  taskId: string;
  mark: string;
  expressNo?: string;
  products: Array<{
    productName: string;
    packageCount: number;
    quantityPerBox: number;
    unitWeightKg: number;
    lengthCm: number;
    widthCm: number;
    heightCm: number;
    material: string;
    cargoValue: string;
    cargoType?: string;
    productImage?: { fileName?: string; mime?: string; base64?: string };
  }>;
}): Promise<ConsolidationPrealertItem> {
  try {
    return await apiRequest<ConsolidationPrealertItem>(
      `${apiBaseUrl()}/client/consolidation/prealerts`,
      { method: "POST", body: JSON.stringify(payload) },
    );
  } catch (error) {
    throw new Error(`创建预报单失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 编辑预报单 */
export async function updateConsolidationPrealert(payload: {
  prealertId: string;
  mark?: string;
  expressNo?: string;
  products?: Array<{
    /** 已有产品行的编号；不传表示新增一行。不传 productImage 则沿用原图 */
    id?: string;
    productName: string;
    packageCount: number;
    quantityPerBox: number;
    unitWeightKg: number;
    lengthCm: number;
    widthCm: number;
    heightCm: number;
    material: string;
    cargoValue: string;
    cargoType?: string;
    productImage?: { fileName?: string; mime?: string; base64?: string };
  }>;
}): Promise<ConsolidationPrealertItem> {
  try {
    return await apiRequest<ConsolidationPrealertItem>(
      `${apiBaseUrl()}/client/consolidation/prealerts/update`,
      { method: "POST", body: JSON.stringify(payload) },
    );
  } catch (error) {
    throw new Error(`编辑预报单失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 删除预报单 */
export async function deleteConsolidationPrealert(prealertId: string): Promise<{ deleted: boolean; id: string }> {
  try {
    return await apiRequest<{ deleted: boolean; id: string }>(
      `${apiBaseUrl()}/client/consolidation/prealerts/delete`,
      { method: "POST", body: JSON.stringify({ prealertId }) },
    );
  } catch (error) {
    throw new Error(`删除预报单失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 付款 */
/**
 * 管理员撤销一笔普通版集货付款：钱退回客户的集货余额，任务回到「未付款」。
 * 退多少由后端按流水里实际扣过的钱算。
 */
export async function revokeConsolidationPayment(payload: {
  taskId: string;
  reason?: string;
}): Promise<{ taskId: string; refunded: number; balanceAfter: number; message: string }> {
  return apiRequest(`${apiBaseUrl()}/admin/consolidation/payments/revoke`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/** 2026-08-07：改成用集货余额付款，不再传付款凭证 */
export async function payConsolidationTask(payload: {
  taskId: string;
}): Promise<{ success: boolean; taskId: string; paidAmount?: number; balanceAfter?: number; message?: string }> {
  try {
    return await apiRequest<{ success: boolean; taskId: string; paidAmount?: number; balanceAfter?: number; message?: string }>(
      `${apiBaseUrl()}/client/consolidation/pay`,
      { method: "POST", body: JSON.stringify(payload) },
    );
  } catch (error) {
    throw new Error(`付款失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

// ============================================================================
// 员工端接口
// ============================================================================

/** 员工查所有客户任务列表 */
export async function fetchStaffConsolidationTasks(status?: string): Promise<ConsolidationTaskItem[]> {
  try {
    const params = status ? `?status=${encodeURIComponent(status)}` : "";
    return await apiRequest<ConsolidationTaskItem[]>(
      `${apiBaseUrl()}/staff/consolidation/tasks${params}`,
    );
  } catch (error) {
    throw new Error(`获取任务列表失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 员工查任务详情 */
export async function fetchStaffConsolidationTaskDetail(taskId: string): Promise<ConsolidationTaskItem> {
  try {
    return await apiRequest<ConsolidationTaskItem>(
      `${apiBaseUrl()}/staff/consolidation/tasks/detail?taskId=${encodeURIComponent(taskId)}`,
    );
  } catch (error) {
    throw new Error(`获取任务详情失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/**
 * 签收预报单。
 * warning（2026-08-31 新增，可选）：这张单是任务**付款之后**才签收的，
 * 这批货不在当初报价的账里 —— 后端只提醒不拦，前端要把这句话摆给员工看清楚。
 */
export async function receiveConsolidationPrealert(payload: {
  prealertId: string;
  proofBase64: string;
  proofFileName: string;
  proofMime: string;
}): Promise<{ success: boolean; prealertId: string; status: string; warning?: string }> {
  try {
    return await apiRequest<{ success: boolean; prealertId: string; status: string; warning?: string }>(
      `${apiBaseUrl()}/staff/consolidation/prealerts/receive`,
      { method: "POST", body: JSON.stringify(payload) },
    );
  } catch (error) {
    throw new Error(`签收预报单失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 确认满柜 */
export async function confirmConsolidationTaskFull(taskId: string): Promise<{ success: boolean; taskId: string; status: string }> {
  try {
    return await apiRequest<{ success: boolean; taskId: string; status: string }>(
      `${apiBaseUrl()}/staff/consolidation/tasks/confirm-full`,
      { method: "POST", body: JSON.stringify({ taskId }) },
    );
  } catch (error) {
    throw new Error(`确认满柜失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 录入报价 */
export async function quoteConsolidationTask(payload: {
  taskId: string;
  bookingFee: number;
  customsFee: number;
  loadingFee: number;
}): Promise<{ success: boolean; taskId: string; totalFee: number; isFirstQuote: boolean }> {
  try {
    return await apiRequest<{ success: boolean; taskId: string; totalFee: number; isFirstQuote: boolean }>(
      `${apiBaseUrl()}/staff/consolidation/tasks/quote`,
      { method: "POST", body: JSON.stringify(payload) },
    );
  } catch (error) {
    throw new Error(`报价失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 推进任务状态 */
export async function advanceConsolidationTaskStatus(payload: {
  taskId: string;
  toStatus: string;
  remark?: string;
}): Promise<{ success: boolean; taskId: string; fromStatus: string; toStatus: string }> {
  try {
    return await apiRequest<{ success: boolean; taskId: string; fromStatus: string; toStatus: string }>(
      `${apiBaseUrl()}/staff/consolidation/tasks/advance-status`,
      { method: "POST", body: JSON.stringify(payload) },
    );
  } catch (error) {
    throw new Error(`推进状态失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 装柜 */
export async function loadingConsolidationTask(payload: {
  taskId: string;
  containerNo?: string;
  loadingDate?: string;
}): Promise<{ success: boolean; taskId: string; status: string }> {
  try {
    return await apiRequest<{ success: boolean; taskId: string; status: string }>(
      `${apiBaseUrl()}/staff/consolidation/tasks/loading`,
      { method: "POST", body: JSON.stringify(payload) },
    );
  } catch (error) {
    throw new Error(`装柜失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/**
 * 取消任务。
 * 2026-08-31 起后端多了一道闸：任务里有**已签收**的预报单时，直接取消会被拦
 * （409，提示语里带「管理员密码」）—— 取消会把签收记录物理删光，等于销毁签收证据。
 * 被拦时带 confirmPassword 重试才放行，用法照 deleteAdminConsolidationTask 那套。
 * 2026-08-31 Codex 复核补：还要带 adminAccount 指名验哪个管理员——
 * 原来后端拿密码挨个试全公司管理员，等于给员工开了猜密码的口子。
 */
export async function cancelConsolidationTask(
  taskId: string,
  opts?: { confirmPassword?: string; adminAccount?: string },
): Promise<{ success: boolean; taskId: string; status: string }> {
  try {
    return await apiRequest<{ success: boolean; taskId: string; status: string }>(
      `${apiBaseUrl()}/staff/consolidation/tasks/cancel`,
      { method: "POST", body: JSON.stringify({ taskId, ...opts }) },
    );
  } catch (error) {
    throw new Error(`取消任务失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 导出任务数据 */

/** 审核通过付款（员工/管理员） */
export async function reviewConsolidationPayment(taskId: string): Promise<void> {
  try {
    await apiRequest(`${apiBaseUrl()}/staff/consolidation/review-payment`, {
      method: "POST",
      body: JSON.stringify({ taskId }),
    });
  } catch (error) {
    throw new Error(`审核付款失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 审核拒绝付款（员工/管理员） */
export async function rejectConsolidationPayment(taskId: string, reason: string): Promise<void> {
  try {
    await apiRequest(`${apiBaseUrl()}/staff/consolidation/reject-payment`, {
      method: "POST",
      body: JSON.stringify({ taskId, reason }),
    });
  } catch (error) {
    throw new Error(`拒绝付款失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

export async function exportConsolidationTask(taskId: string): Promise<{
  taskNo: string;
  taskId: string;
  totalRows: number;
  headers: Array<{ key: string; label: string }>;
  rows: Array<Record<string, any>>;
}> {
  try {
    return await apiRequest<{
      taskNo: string;
      taskId: string;
      totalRows: number;
      headers: Array<{ key: string; label: string }>;
      rows: Array<Record<string, any>>;
    }>(
      `${apiBaseUrl()}/staff/consolidation/tasks/export?taskId=${encodeURIComponent(taskId)}`,
    );
  } catch (error) {
    throw new Error(`导出失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

// ============================================================================
// 管理员端接口
// ============================================================================

/** 管理员查所有任务 */
export async function fetchAdminConsolidationTasks(status?: string): Promise<ConsolidationTaskItem[]> {
  try {
    const params = status ? `?status=${encodeURIComponent(status)}` : "";
    return await apiRequest<ConsolidationTaskItem[]>(
      `${apiBaseUrl()}/admin/consolidation/tasks${params}`,
    );
  } catch (error) {
    throw new Error(`获取任务列表失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 管理员删除任务（级联删除） */
/** 删除集货任务时，后端返回的连带删除清单 */
export interface ConsolidationDeletePreview {
  taskNo?: string;
  planNo?: string;
  willDelete: Record<string, number>;
  blockers: string[];
  /** 删除时会退回客户集货余额的总金额（元）。2026-08-08 新增 */
  refundTotal?: number;
  /** 会退给几位客户 */
  refundCount?: number;
  /**
   * 2026-09-16 发运红线（确认单 4.15）：true = 已经发运，谁都不能删、输管理员密码也不行。
   * 这时界面不给密码框、不给确认按钮，只把 hardBlockReason 摆出来。
   */
  hardBlocked?: boolean;
  hardBlockReason?: string | null;
}

/**
 * 删除整个集货任务（管理员）。
 *
 * ⚠️ 2026-08-07 修：这个函数原来调的是 DELETE /admin/consolidation/tasks，
 * 而后端从来没有这个接口（只有 GET）—— 页面上的「删除任务」按钮点了必然失败。
 * 现在改调 POST /admin/consolidation/tasks/delete。
 *
 * dryRun=true 只预检不删，用来告诉用户「会连带删掉几张预报单」。
 * 已收货 / 任务已开始走流程时后端会拦（409），要带 confirmPassword 才放行。
 */
export async function deleteAdminConsolidationTask(
  taskId: string,
  opts?: { dryRun?: boolean; confirmPassword?: string },
): Promise<ConsolidationDeletePreview & { deleted?: boolean; forced?: boolean }> {
  return apiRequest(`${apiBaseUrl()}/admin/consolidation/tasks/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskId, ...opts }),
  });
}

/**
 * 删除整个集货计划（仓库版，管理员，2026-08-07 新增）。
 * 级联链最长：计划 → 计划客户 → 预报单 → 货物明细 + 状态日志。
 * 用法与 deleteAdminConsolidationTask 一致：先 dryRun 预检，被拦时带 confirmPassword 强删。
 */
export async function deleteAdminWhrConsolidationPlan(
  planId: string,
  opts?: { dryRun?: boolean; confirmPassword?: string },
): Promise<ConsolidationDeletePreview & { deleted?: boolean; forced?: boolean }> {
  return apiRequest(`${apiBaseUrl()}/admin/whr-consolidation/plans/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planId, ...opts }),
  });
}

/** 管理员强制编辑预报单 */
export async function adminForceEditConsolidationPrealert(payload: {
  prealertId: string;
  mark?: string;
  expressNo?: string;
  products?: Array<{
    /** 已有产品行的编号；不传表示新增一行。不传 productImage 则沿用原图 */
    id?: string;
    productName: string;
    packageCount: number;
    quantityPerBox: number;
    unitWeightKg: number;
    lengthCm: number;
    widthCm: number;
    heightCm: number;
    material: string;
    cargoValue: string;
    cargoType?: string;
    productImage?: { fileName?: string; mime?: string; base64?: string };
  }>;
}): Promise<{ success: boolean; prealertId: string }> {
  try {
    return await apiRequest<{ success: boolean; prealertId: string }>(
      `${apiBaseUrl()}/admin/consolidation/prealerts/force-edit`,
      { method: "POST", body: JSON.stringify(payload) },
    );
  } catch (error) {
    throw new Error(`强制编辑预报单失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 管理员强制删除预报单 */
/** 管理员删单件货物明细（普通版集货，2026-08-15）。金额是人工填的，这里不动金额 */
export async function adminDeleteConsolidationProduct(productId: string): Promise<{ deleted: boolean; productId: string; productName: string }> {
  try {
    return await apiRequest<{ deleted: boolean; productId: string; productName: string }>(
      `${apiBaseUrl()}/admin/consolidation/prealerts/product-delete`,
      { method: "POST", body: JSON.stringify({ productId }) },
    );
  } catch (error) {
    throw new Error(`删除货物失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

export async function adminDeleteConsolidationPrealert(prealertId: string): Promise<{ deleted: boolean; prealertId: string }> {
  try {
    return await apiRequest<{ deleted: boolean; prealertId: string }>(
      `${apiBaseUrl()}/admin/consolidation/prealerts/delete`,
      { method: "POST", body: JSON.stringify({ prealertId }) },
    );
  } catch (error) {
    throw new Error(`删除预报单失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}
