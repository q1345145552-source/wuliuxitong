"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { matchesShipmentListFilter } from "../../../../../packages/shared-types/shipment-status";
import { productNamesLabel } from "../../../../../packages/shared-types/product-names";
import ExportConditionFields, { type ExportFieldDef } from "../../modules/shipment/ExportConditionFields";
import { EMPTY_SHIPMENT_FILTER, adminOrderFilterRow, matchesShipmentFilter, mergeDateFrom, mergeDateTo, shipmentFilterDateInvalid, type ShipmentFilterValue } from "../../modules/shipment/export-filter";
import { parseCargoType, CARGO_TYPE_HINT, cargoTypeLabel } from "../../../../../packages/shared-types/cargo-type";
import { AT_WAREHOUSE_STATUSES, COMPLETED_STATUSES, CLIENT_STATUS_GROUP_ZH } from "../../../../../packages/shared-types/shipment-status";
import type { AiKnowledgeItem } from "../../../../../packages/shared-types/entities";
import { getOptionalSession, type AuthSession } from "../../auth/auth-session";
import AdminOperationsOverview from "../../components/admin/AdminOperationsOverview";
import { validateProductRows, packageCountForPayload } from "../../modules/orders/productRowGuard";
import EmptyStateCard from "../../modules/layout/EmptyStateCard";
import Toast from "../../modules/layout/Toast";
import ShipmentSearch from "../../modules/shipment/ShipmentSearch";
import { openPrintLabel } from "../../modules/shipment/ShipmentPrintLabel";
import { openShipmentTrack } from "../../modules/shipment/ShipmentTrackModal";
import LastmileDispatchWorkspace from "../../modules/lastmile/LastmileDispatchWorkspace";
import type { LastmileOrderItem, LastmileShipmentOption } from "../../modules/lastmile/types";
import ShipmentExportPanel from "../../modules/shipment/ShipmentExportPanel";
import ShipmentStatusGroups, { SHIPMENT_GROUP_OPTIONS, type ShipmentGroupFilter } from "../../modules/shipment/ShipmentStatusGroups";
import { ShipmentOverviewStrip } from "../../modules/shipment/ShipmentOverviewStrip";
import LastmileAddressPanel from "../../components/lastmile/LastmileAddressPanel";
import DetailModal from "../../modules/layout/DetailModal";
import AdminShipmentDetail from "../../components/admin/AdminShipmentDetail";
import {
  GridColgroup,
  ProductListDetailCell,
  PRODUCT_LIST_COL_WIDTHS,
  buildProductDetailRows,
  totalPackageCountOf,
  totalVolumeOf,
  totalWeightOf,
  gridThStyle,
  gridTdStyle,
} from "../../modules/shipment/ShipmentTableGrid";
import { apiBaseUrl, authHeaders, parseApiResponse, fetchWithSession as fetch } from "../../services/core-api";
import { DEFAULT_SHIPPING_PRICES, INSPECTION_SURCHARGE, SENSITIVE_SURCHARGE } from "../../../../../packages/shared-types/constants";
import { formatMetric, shipmentStatusWithPartialZh, shipmentStatusZh, transportModeLabel, warehouseLabelFromId } from "../../modules/staff/utils";
import { SHIPMENT_STATUS_FILTER_OPTIONS } from "../../modules/shipment/shipment-status";
import ShippingConfig from "../../components/admin/ShippingConfig";
import { createRequestGate } from "../../modules/shared/request-gate";
import {
  fetchAdminOverview,
  fetchStaffShipmentOverview,
  type StaffShipmentOverview,
  fetchAdminStaff,
  fetchAdminClients,
  fetchAdminOrders,
  fetchShipmentImages,
  updateAdminOrder,
  fetchAdminAiSessionMemory,
  fetchAdminAiKnowledgeGaps,
  clearAdminAiSessionMemory,
  resolveAdminAiKnowledgeGap,
  createAdminStaff,
  createAdminClient,
  updateAdminClient,
  toggleUserBan,
  deleteAdminOrder,
  setAdminStaffPassword,
  fetchAgentOptions,
  type AgentOption,
  type AdminOverview,
  type AdminOpsOverview,
  type AdminUserItem,
  type AdminOrderItem,
  type AdminAiSessionMemoryItem,
  type AdminAiKnowledgeGapItem,
  fetchAdminOpsOverview,
  updateShippingConfig,
  fetchShippingConfig,
  fetchAdminShippingRates,
  fetchClientShippingConfig,
  saveClientShippingConfig,
  // 员工端共享功能
  uploadStaffOrderProductImage,
  deleteStaffOrderProductImage,
  fetchStaffClients,
  fetchStaffPrealerts,
  createStaffOrder,
  type OrderProductImageItem,
  // 充值审核
  fetchAdminRecharges,
  approveRecharge,
  rejectRecharge,
  type AdminWalletRechargeItem,
  fetchLastmileShipments,
} from "../../services/business-api";
import {
  createKnowledgeItem,
  deleteKnowledgeItem,
  fetchKnowledgeList,
} from "../../services/admin-ai";

const SECTION_IDS = [
  "overview",
  "staff",
  "clients",
  "orders",
  "ai-memory",
  "ai-knowledge-gaps",
  "knowledge-feed",
  "knowledge-list",
  "shipping-config",
  "ops-tools",
  "lastmile",
  "lastmile-address",
  "wallet-recharges",
] as const;

const SECTION_LABELS: Record<(typeof SECTION_IDS)[number], string> = {
  overview: "运营看板",
  staff: "员工管理",
  clients: "客户管理",
  orders: "运单管理",
  "ai-memory": "AI会话记忆运维",
  "ai-knowledge-gaps": "AI待补知识问题",
  "knowledge-feed": "AI知识投喂",
  "knowledge-list": "已投喂的知识列表",
  "shipping-config": "运费配置",
  "ops-tools": "入库与标签工具",
  "lastmile": "尾端派送",
  "lastmile-address": "尾端地址",
  "wallet-recharges": "充值审核",
};

const sectionStyle = {
  marginBottom: 24,
  border: "1px solid var(--l-soft)",
  borderRadius: 12,
  padding: 20,
  background: "var(--white)",
};

const cardStyle = {
  border: "1px solid var(--l-soft)",
  borderRadius: 8,
  padding: "10px 12px",
  background: "var(--s-cool)",
  fontSize: 14,
};

const prealertEditInputStyle: React.CSSProperties = {
  border: "1px solid var(--l-strong)",
  borderRadius: 6,
  padding: "6px 8px",
  fontSize: 12,
  width: "100%",
};

const WAREHOUSE_LABEL_MAP: Record<string, string> = {
  wh_yiwu_01: "义乌仓",
  wh_guangzhou_01: "广州仓",
  wh_dongguan_01: "东莞仓",
  wh_shenzhen_01: "深圳仓",
};

const warehouseOptions = [
  { id: "wh_yiwu_01", label: "义乌仓" },
  { id: "wh_guangzhou_01", label: "广州仓" },
  { id: "wh_dongguan_01", label: "东莞仓" },
  { id: "wh_shenzhen_01", label: "深圳仓" },
];

/* 运单列表「按状态筛选」的选项。2026-08-13 改成从流程表生成（唯一定义处在
   modules/shipment/shipment-status.ts）—— 原来这里写死 15 个，加状态没人回来改，
   实测缺 15 个，陆运那五步从上线起就一直筛不到。**别再改回写死。** */
const logisticsStatusOptions = SHIPMENT_STATUS_FILTER_OPTIONS;


/** 中文状态 → 英文 status */
/**
 * 管理端运单号前缀规则：仓库与单号前缀必须匹配。
 */
const WAREHOUSE_TRACKING_PREFIX_MAP: Record<string, string[]> = {
  wh_yiwu_01: ["YW", "YWXT"],
  wh_guangzhou_01: ["GZ", "GZXT"],
  wh_dongguan_01: ["DG", "DGXT"],
};

export const dynamic = "force-dynamic";

/* 管理员端运单列表的列宽。排版规则见 modules/shipment/ShipmentTableGrid.tsx。
   ⚠️ 第 6~10 个必须和 PRODUCT_LIST_COL_WIDTHS 完全一致。
   紧跟在产品明细块后面的 80 是「总箱数」，它和体积、重量一样是整单的合计数，
   所以放在会滚动的明细块外面 —— 放进去会跟着产品一起滚上去看不见。 */
const ORDER_COL_WIDTHS = [
  44, 110, 130, 120, 110,
  ...PRODUCT_LIST_COL_WIDTHS,
  80, 100, 90, 90, 170, 330,
] as const;
const ORDER_TABLE_MIN_WIDTH = ORDER_COL_WIDTHS.reduce((a, b) => a + b, 0);
/** 弹性列＝「备注」（表头第 15 个）。操作列有 5 个按钮，宽度必须写死。 */
const ORDER_FLEX_COL_INDEX = 14;

const EMPTY_ORDER_SEARCH = {
  trackingNo: "", domesticTrackingNo: "", clientName: "", warehouseId: "",
  batchNo: "", itemName: "", packageCount: "", productQuantity: "",
  weightKg: "", volumeM3: "", arrivedAtFrom: "", arrivedAtTo: "", logisticsStatus: "",
  containerNo: "", transportMode: "", receiverAddress: "", shipDateFrom: "", shipDateTo: "",
  receivableAmount: "", statusRaw: "",
};

/**
 * 编辑运单时「总重量/总体积到底听谁的」的裁决（2026-08-31，排查报告第22条）。
 * 老毛病：只要任何一行产品填了尺寸，手填的总体积就被静默扔掉 —— 三行货仓库只量了
 * 一箱的尺寸，管理员手填实际总体积 3.5 方，保存后悄悄变成那一箱的 0.6 方，没人察觉。
 * 现在的规则：
 * - 每一行都填齐了尺寸（或单箱重）→ 数据齐全，按产品行自动算，手填值不生效；
 * - 有行没填齐 → 手填了就以手填为准；没手填才拿不完整的自动值凑合（跟原来一致）；
 * - 哪边生效通过 notes 在编辑框旁边和保存提示里明说，不再静默。
 * 保存和界面提示都调这一个函数，保证两边口径一致。
 */
function decideEditTotals(
  products: Array<{ packageCount: string; lengthCm: string; widthCm: string; heightCm: string; weightKg: string }>,
  manualWeightRaw: string,
  manualVolumeRaw: string,
): { finalWeight: number | null; finalVolume: number | null; notes: string[] } {
  let autoVolume = 0;
  let autoWeight = 0;
  let dimRows = 0;
  let weightRows = 0;
  for (const p of products) {
    const qty = Number(String(p.packageCount).trim()) || 0;
    const l = Number(p.lengthCm);
    const w = Number(p.widthCm);
    const h = Number(p.heightCm);
    if (l > 0 && w > 0 && h > 0) {
      autoVolume += (l * w * h * qty) / 1_000_000;
      dimRows++;
    }
    const pw = Number(p.weightKg);
    if (pw > 0) {
      autoWeight += pw * qty;
      weightRows++;
    }
  }
  const manualVolume = manualVolumeRaw.trim() ? Number(manualVolumeRaw) : null;
  const manualWeight = manualWeightRaw.trim() ? Number(manualWeightRaw) : null;
  const notes: string[] = [];

  let finalVolume: number | null;
  if (products.length > 0 && dimRows === products.length) {
    finalVolume = autoVolume;
    if (manualVolume !== null && Math.abs(manualVolume - autoVolume) > 0.0005) {
      notes.push(`产品行尺寸已填齐：总体积按尺寸自动算为 ${autoVolume.toFixed(3)} m³，手填的 ${manualVolume} 不生效`);
    }
  } else if (dimRows > 0) {
    if (manualVolume !== null) {
      finalVolume = manualVolume;
      notes.push(`产品行尺寸没填齐（${dimRows}/${products.length} 行有尺寸）：总体积以手填的 ${manualVolume} m³ 为准`);
    } else {
      finalVolume = autoVolume;
      notes.push(`产品行尺寸没填齐、也没手填总体积：先按已填尺寸的 ${dimRows} 行算出 ${autoVolume.toFixed(3)} m³，偏小`);
    }
  } else {
    finalVolume = manualVolume;
  }

  let finalWeight: number | null;
  if (products.length > 0 && weightRows === products.length) {
    finalWeight = autoWeight;
    if (manualWeight !== null && Math.abs(manualWeight - autoWeight) > 0.005) {
      notes.push(`产品行单箱重已填齐：总重量自动算为 ${autoWeight.toFixed(2)} kg，手填的 ${manualWeight} 不生效`);
    }
  } else if (weightRows > 0) {
    if (manualWeight !== null) {
      finalWeight = manualWeight;
      notes.push(`产品行单箱重没填齐（${weightRows}/${products.length} 行有重量）：总重量以手填的 ${manualWeight} kg 为准`);
    } else {
      finalWeight = autoWeight;
      notes.push(`产品行单箱重没填齐、也没手填总重量：先按已填重量的 ${weightRows} 行算出 ${autoWeight.toFixed(2)} kg，偏小`);
    }
  } else {
    finalWeight = manualWeight;
  }

  return { finalWeight, finalVolume, notes };
}

export default function AdminHomePage() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [opsOverview, setOpsOverview] = useState<AdminOpsOverview | null>(null);
  const [overviewError, setOverviewError] = useState(false);
  const [opsError, setOpsError] = useState(false);
  // 无参数总览请求只保留一份在途请求，避免慢接口被10秒轮询反复挤掉。
  const overviewRefreshPending = useRef(false);
  const overviewRefreshPromise = useRef<Promise<void> | null>(null);
  const accountWriteState = useRef({ revision: 0, active: 0 });
  const opsOverviewInFlight = useRef(false);
  /* 运单管理顶部那排数字。拉不到就整排不显示 ——
     宁可不显示，也不能显示一个假的 0 让人以为「今天没有延迟的」。 */
  const [shipmentOverview, setShipmentOverview] = useState<StaffShipmentOverview | null>(null);
  useEffect(() => {
    fetchStaffShipmentOverview().then(setShipmentOverview).catch(() => setShipmentOverview(null));
  }, []);
  const [staffList, setStaffList] = useState<AdminUserItem[]>([]);
  const [clientList, setClientList] = useState<AdminUserItem[]>([]);
  /**
   * 客户搜索（2026-08-27 加）。
   * 分成两个状态是故意的：`clientSearchInput` 是输入框里正在打的字，
   * `clientSearchQuery` 是**点了搜索按钮之后**才生效的词 ——
   * 用户要的是「按钮搜索」，边打边筛会一直跳。
   */
  const [clientSearchInput, setClientSearchInput] = useState("");
  const [clientSearchQuery, setClientSearchQuery] = useState("");
  const [orderList, setOrderList] = useState<AdminOrderItem[]>([]);
  const [ordersLoaded, setOrdersLoaded] = useState(false);
  const [ordersError, setOrdersError] = useState(false);
  const [sessionMemoryList, setSessionMemoryList] = useState<AdminAiSessionMemoryItem[]>([]);
  const [knowledgeGapList, setKnowledgeGapList] = useState<AdminAiKnowledgeGapItem[]>([]);
  const [knowledgeGapStatus, setKnowledgeGapStatus] = useState<"open" | "resolved">("open");
  const [knowledgeItems, setKnowledgeItems] = useState<AiKnowledgeItem[]>([]);
  const [message, setMessage] = useState("");
  const [toast, setToast] = useState("");
  const [shippingConfigSea, setShippingConfigSea] = useState("0.5");
  const [shippingConfigLand, setShippingConfigLand] = useState("0.3");
  const [configSaving, setConfigSaving] = useState(false);
  const [rateItems, setRateItems] = useState<Array<{
    id: string; transportMode: string; cargoType: string; customerId: string | null;
    customerName: string | null; unitPriceCny: number; disableMinVolume: boolean;
  }>>([]);
  const [rateDefaults, setRateDefaults] = useState<Array<{ transportMode: string; cargoType: string; unitPriceCny: number }>>([]);
  const [rateEditForm, setRateEditForm] = useState({ transportMode: "sea", cargoType: "normal", customerId: "", unitPriceCny: "", disableMinVolume: false });
  const [expandedClientId, setExpandedClientId] = useState<string | null>(null);
  const [clientPrices, setClientPrices] = useState<Record<string, number>>({});
  const [clientMinVolumeDisabled, setClientMinVolumeDisabled] = useState(false);
  const [defaultEditPrices, setDefaultEditPrices] = useState<Record<string, number>>({});
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [staffPanelCollapsed, setStaffPanelCollapsed] = useState(false);
  const [ordersPanelCollapsed, setOrdersPanelCollapsed] = useState(false);
  const [selectedOrders, setSelectedOrders] = useState<Set<string>>(new Set());
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [orderSearch, setOrderSearch] = useState(EMPTY_ORDER_SEARCH);
  const [shipmentGroup, setShipmentGroup] = useState<ShipmentGroupFilter>("all");
  const [orderCopyNotice, setOrderCopyNotice] = useState("");
  const [orderExporting, setOrderExporting] = useState(false);
  const orderExportInFlight = useRef(false);
  const [orderRefreshing, setOrderRefreshing] = useState(false);
  const orderRefreshInFlight = useRef(false);
  const [editingOrderId, setEditingOrderId] = useState("");
  const [expandedOrderId, setExpandedOrderId] = useState("");

  const [showCreateOrderModal, setShowCreateOrderModal] = useState(false);
  const [showBatchImport, setShowBatchImport] = useState(false);
  // 读 Excel 的门闩：换文件 / 关弹窗 / 卸载后，慢文件晚到的结果不许回填（2026-09-05 复查：原来手写序号，改用统一门闩）
  const batchReadGate = useRef(createRequestGate()).current;
  const [batchFileReading, setBatchFileReading] = useState(false);
  const [batchFileError, setBatchFileError] = useState("");
  useEffect(() => () => { batchReadGate.cancel(); }, [batchReadGate]);
  const [batchTemplateDownloading, setBatchTemplateDownloading] = useState(false);
  async function downloadAdminBatchTemplate() {
    if (batchTemplateDownloading) return;
    setBatchTemplateDownloading(true);
    try {
      const XLSX = await import("xlsx");
      // 「货型」2026-09-11 加在最后一列：以前没有这一列、代码不传，后端一律兜成普货。
      // 不插在中间 —— 有人是按老列序粘数据的，插中间会整体错位。
      const headers = ["客户ID", "仓库ID", "品名", "箱数", "包装单位", "运输方式", "到仓日期", "国内单号", "泰国收货人", "泰国收货电话", "泰国收货地址", "货型"];
      const ws = XLSX.utils.aoa_to_sheet([headers]);
      ws["!cols"] = [18, 24, 24, 10, 14, 14, 18, 24, 20, 24, 45, 22].map((wch) => ({ wch }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "运单导入模板");
      const notes = XLSX.utils.aoa_to_sheet([
        ["管理员批量导入填写说明"],
        ["填写第一个工作表；每行创建一张运单，请勿修改表头。空白行不会导入，模板不含可误导入的示例订单。"],
        ["客户ID填写系统已有的客户ID；品名和箱数请填写完整，箱数为正整数。"],
        ["仓库ID：" + warehouseOptions.map((w) => `${w.label} = ${w.id}`).join("；")],
        ["包装单位填写 box（箱）或 bag（袋）；运输方式填写 sea（海运）或 land（陆运），不要填写中文代替这些值。"],
        ["到仓日期按文本填写 YYYY-MM-DD，例如 2026-09-05；不要将单元格改成Excel日期格式。"],
        ["填写前，请将客户ID、国内单号、电话和到仓日期的单元格格式设为“文本”，保留开头的0与日期原文。"],
        ["国内单号、泰国收货人、泰国收货电话、泰国收货地址按实际信息填写。"],
        ["货型留空就是普货；商检货填「商检货」，敏感货填「敏感货」。填别的字会让这一行导入失败并在失败明细里说明，不会悄悄变成普货。"],
        ["此模板仅用于管理员当前12列导入；员工的多产品批量创建请使用员工端模板，两者不可混用。"],
        ["填写后上传，先核对预览再确认导入；已成功导入的行请勿重复提交。"],
      ]);
      notes["!cols"] = [{ wch: 110 }];
      XLSX.utils.book_append_sheet(wb, notes, "填写说明");
      XLSX.writeFile(wb, "管理员运单导入模板.xlsx");
    } catch (error) {
      setToast(`模板下载失败：${error instanceof Error ? error.message : "请稍后重试"}`);
    } finally {
      setBatchTemplateDownloading(false);
    }
  }

  const [staffClients, setStaffClients] = useState<Array<{ id: string; name: string }>>([]);
  const [createForm, setCreateForm] = useState({
    clientId: "", warehouseId: "wh_yiwu_01", arrivedAt: new Date().toISOString().slice(0, 10),
    transportMode: "sea" as "sea" | "land", domesticTrackingNo: "", batchNo: "", shipDate: "",
    receiverNameTh: "", receiverPhoneTh: "", receiverAddressTh: "",
  });
  /**
   * ⚠️ `packageCount` 存**字符串**（2026-08-29 第八轮改）。
   * 原来是 number、初值 1，而且输入框 onChange 写着
   *   `n[i].packageCount = Math.max(1, Number(e.target.value))`
   * —— 管理员把箱数**清空的那一刻就被改成 1**，比发送还早，
   * 后端那道正整数校验永远看不到真相。这就是老板最早报的
   * 「系统自己把箱数猜成 1」在管理员端剩下的最后一处。
   * 现在原样存字符串，提交时统一交给 validateProductRows 判。
   */
  const [createProducts, setCreateProducts] = useState<Array<{
    itemName: string; packageCount: string; lengthCm: string; widthCm: string;
    heightCm: string; productQuantity: string; cargoType: string; domesticTrackingNo: string;
  }>>([{ itemName: "", packageCount: "", lengthCm: "", widthCm: "", heightCm: "", productQuantity: "", cargoType: "normal", domesticTrackingNo: "" }]);
  const [batchRows, setBatchRows] = useState<Array<any>>([]);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ current: 0, success: 0, fail: 0 });
  const [batchFileName, setBatchFileName] = useState("");
  const [batchConfirmed, setBatchConfirmed] = useState(false);
  /* 批量导入的失败明细（2026-08-31，排查报告第46条）：原来只报「成功 95 失败 5」，
     哪 5 条、为什么失败当场就扔了，管理员只能整表重导（把已建好的 95 条建重）。
     现在逐条记下行号 + 客户ID/品名 + 后端返回的原因，导完列在弹窗里。
     封顶 200 条防止极端情况下撑爆内存，超出部分只计数。 */
  const [batchFailures, setBatchFailures] = useState<Array<{ row: number; clientId: string; itemName: string; reason: string }>>([]);
  /** 本轮导入是否已跑完（跑完且有失败时弹窗不自动关，留人看明细） */
  const [batchDone, setBatchDone] = useState(false);
  const [calcLength, setCalcLength] = useState("");
  const [calcWidth, setCalcWidth] = useState("");
  const [calcHeight, setCalcHeight] = useState("");
  const [calcQty, setCalcQty] = useState("1");
  const [calcResult, setCalcResult] = useState("");
  const [lmShipments, setLmShipments] = useState<LastmileShipmentOption[]>([]);
  const [lmShipmentsLoading, setLmShipmentsLoading] = useState(false);
  const [lmShipmentsError, setLmShipmentsError] = useState("");
  const loadLmShipments = async () => {
    // 2026-08-06：和员工端犯的是同一个错 —— 只拿第 1 页 500 条再在前端筛状态，
    // 能派送的 571 张里只到 126 张。改为统一走 fetchLastmileShipments()（后端按状态筛 + 翻页拿完）。
    setLmShipmentsLoading(true);
    setLmShipmentsError("");
    try { setLmShipments(await fetchLastmileShipments()); }
    catch (e) {
      console.error(e);
      const reason = e instanceof Error ? e.message : "未知错误";
      setLmShipmentsError(reason);
      setToast(`可派送运单加载失败：${reason}`);
    } finally {
      setLmShipmentsLoading(false);
    }
  };
  const [lmOrders, setLmOrders] = useState<LastmileOrderItem[]>([]);
  const [lmOrdersLoading, setLmOrdersLoading] = useState(false);
  const [lmOrdersError, setLmOrdersError] = useState("");
  const loadLastmileOrders = async () => {
    setLmOrdersLoading(true);
    setLmOrdersError("");
    try {
      const response = await fetch(`${apiBaseUrl()}/admin/lastmile/orders`, { headers: authHeaders() });
      const data = await parseApiResponse<{ items: LastmileOrderItem[] }>(response);
      setLmOrders(data.items ?? []);
    } catch (e) {
      console.error(e);
      setLmOrdersError(e instanceof Error ? e.message : "未知错误");
    } finally {
      setLmOrdersLoading(false);
    }
  };
  // 充值审核
  const [rechargeList, setRechargeList] = useState<AdminWalletRechargeItem[]>([]);
  const [rechargeStatusFilter, setRechargeStatusFilter] = useState("");
  const [rejectModalId, setRejectModalId] = useState<string | null>(null);
  const [rejectRemark, setRejectRemark] = useState("");
  // 2026-09-01 竞态全扫：快速切筛选状态时，先回来的旧响应不许盖掉新筛选的列表
  const rechargeGate = useRef(createRequestGate()).current;
  const loadRecharges = async () => {
    const ticket = rechargeGate.begin();
    try {
      const data = await fetchAdminRecharges(rechargeStatusFilter || undefined);
      if (!rechargeGate.isCurrent(ticket)) return; // 号作废：旧筛选的数据不许上屏
      setRechargeList(data.recharges);
    } catch (e) {
      if (!rechargeGate.isCurrent(ticket)) return; // 旧请求的报错也不许乱入
      console.error(e);
    }
  };
  const [orderImagesCache, setOrderImagesCache] = useState<Record<string, Array<{ id: string; fileName: string; mime: string; contentBase64?: string; filePath?: string | null; imageUrl?: string; createdAt: string }>>>({});
  const [orderEditForm, setOrderEditForm] = useState({
    clientId: "",
    trackingNo: "",
    batchNo: "",
    warehouseId: "wh_yiwu_01",
    itemName: "",
    transportMode: "sea" as "sea" | "land",
    domesticTrackingNo: "",
    receiverAddressTh: "",
    containerNo: "",
    productQuantity: "",
    packageCount: "",
    packageUnit: "box" as "bag" | "box",
    weightKg: "",
    volumeM3: "",
    paymentStatus: "unpaid" as "paid" | "unpaid",
    shipDate: "",
    cargoType: "normal",
    remark: "",
  });
  const [editProducts, setEditProducts] = useState<Array<{
    /** 已有产品行的编号；新加的行为空，后端据此判断是改还是新增 */
    id?: string;
    itemName: string; packageCount: string; lengthCm: string; widthCm: string; heightCm: string; productQuantity: string; weightKg: string; cargoType: string; domesticTrackingNo: string;
  }>>([]);
  /** 打开编辑弹窗那一刻的原始数据，用于保存时算出「哪些项被改过」 */
  const [editSnapshot, setEditSnapshot] = useState<{ form: Record<string, string>; productsJson: string } | null>(null);
  /* 编辑弹窗里实时提示「总重量/总体积保存时听谁的」（2026-08-31，排查报告第22条）。
     跟保存用的是同一个 decideEditTotals，界面上说的和实际存的不会两张皮。 */
  const editTotalsPreview = useMemo(
    () => decideEditTotals(editProducts, orderEditForm.weightKg, orderEditForm.volumeM3),
    [editProducts, orderEditForm.weightKg, orderEditForm.volumeM3],
  );
  const [staffForm, setStaffForm] = useState({ id: "", name: "", phone: "", password: "" });
  const [clientForm, setClientForm] = useState({ id: "", name: "", companyName: "", phone: "", email: "", password: "", agentId: "" });
  const [showStaffModal, setShowStaffModal] = useState(false);
  const [showClientModal, setShowClientModal] = useState(false);
  const [editingClientId, setEditingClientId] = useState<string | null>(null);
  // 2026-09-16 代理账号：开客户选归属（确认单 2.2 / 6.2）、卡片上填/改长期价（4.19，代理的客户只读 4.7）
  const [agentOptions, setAgentOptions] = useState<AgentOption[]>([]);
  /** 编辑弹窗打开时这个客户原来的归属；只有改了才把 agentId 发给后端 */
  const [editingClientAgentId, setEditingClientAgentId] = useState<string | null>(null);

  const [settingPasswordFor, setSettingPasswordFor] = useState<string | null>(null);
  const [settingPasswordValue, setSettingPasswordValue] = useState("");
  // 设密码时能不能看见自己输的内容。每次换一个账号设密码都恢复成看不见，避免被旁人瞄到
  const [showSettingPassword, setShowSettingPassword] = useState(false);
  const [memoryFilterSessionId, setMemoryFilterSessionId] = useState("");
  const [memoryFilterUserId, setMemoryFilterUserId] = useState("");
  // 2026-09-16 导航根治：从别的页面点菜单跳进来带着 #（例如仓库版 → /admin#orders）时，首帧就选对分区，
  // 不先闪一下默认分区。本页只在外壳核验完登录之后才挂载（那时一定在浏览器里），可以直接读地址。
  const [activeSection, setActiveSection] = useState<(typeof SECTION_IDS)[number]>(() => {
    const hashId = typeof window === "undefined" ? "" : window.location.hash.replace(/^#/, "");
    return (SECTION_IDS as readonly string[]).includes(hashId) ? (hashId as (typeof SECTION_IDS)[number]) : "overview";
  });

  // 复用 staff/utils 中的状态/运输方式/仓库标签函数
  const shipmentStatusLabel = shipmentStatusZh;
  const warehouseLabel = warehouseLabelFromId;

  /**
   * 看板运单数量：沿用原状态图的分桶，只把图换成直接可读的数字。
   *
   * ⚠️ 2026-08-21 改：原来只看 statusGroup，凡是「没完成」一律算「在途」——
   * 连**还没装柜发走**的「已创建」也算进去了。结果同一屏上，上面 KPI 的「在途订单」
   * 和这里的「在途」是两个不同口径、两个不同数字，看的人只会觉得数据不可信。
   * 现在改成跟 KPI 用**同一份** IN_TRANSIT_STATUSES（从流程表自动推导），两处必然一致。
   *
   * 口径按用户的业务说法（交接文档 1.5）：**装柜了 = 发走了**。
   * 所以「已创建 / 暂缓柜」= 货在国内仓还没发走 → 算「处理中」，不算在途。
   */
  const shipmentCounts = useMemo(() => {
    const bucket = { delivered: 0, inTransit: 0, atWarehouse: 0, processing: 0, exception: 0 };
    const atWarehouse = new Set<string>(AT_WAREHOUSE_STATUSES);
    const completed = new Set<string>(COMPLETED_STATUSES);
    // 2026-09-03：还没发走的那几个（口径跟后端 classifyClientStatusGroup 的 pending 一致）
    const notShipped = new Set<string>(["", "created", "inWarehouseCN", "holdLoading"]);
    orderList.forEach((item) => {
      // ⚠️ 不要先按「订单审核状态」分流。原来的写法是「没审核 → 一律处理中」，
      // 结果一张已经在泰国「正在卸柜」的货，因为订单标着未审核，被算成了处理中，
      // 让这里的「在途」比上面 KPI 少 1（实测就是 YWYB0000001 这张）。
      // 货走到哪一步看状态就够了，审核与否不改变它在不在路上。
      const cur = item.currentStatus ?? "";
      if (cur === "delivered") {
        bucket.delivered += 1;
      } else if (notShipped.has(cur)) {
        // 已创建 / 已入库 / 暂缓柜 / 没状态 —— 货还在国内仓
        bucket.processing += 1;
      } else if (atWarehouse.has(cur)) {
        /* 2026-09-03 老板拍板：到了泰国仓（含预约派送、派送中）单独一格，不算在途。
           原来这一格不存在，IN_TRANSIT_STATUSES 把它们算成在途；把它们从在途摘掉之后
           如果不加这一格，这批货会掉进下面的「处理中」，跟「还没发走」混成一堆。 */
        bucket.atWarehouse += 1;
      } else if (completed.has(cur) || cur === "exception") {
        /* 退回 / 取消 / 异常：算结束了，但不是正常送达。
           2026-09-03 修：exception 原来不在 COMPLETED_STATUSES 里，会掉进「处理中」，
           跟「还没发走的货」混在一格 —— 异常单在这张图上等于看不见。 */
        bucket.exception += 1;
      } else {
        /* 剩下的一律「在途」——**兜底，不要改成白名单**。
           2026-09-03 修：原来这里用 IN_TRANSIT_STATUSES 白名单判在途、其余掉进「处理中」，
           结果老数据里流程表没有的状态（pickedUp / customsPending / inTransit 这些）
           被画成「还没发走」。口径跟后端减法一致：没被上面几格认领的都还在路上。 */
        bucket.inTransit += 1;
      }
    });
    // 只换呈现方式，不改原柱状图的状态分桶口径。
    return bucket;
  }, [orderList]);

  // 判断 hash 是否为有效的功能分区 id。
  const isSectionId = (value: string): value is (typeof SECTION_IDS)[number] =>
    SECTION_IDS.includes(value as (typeof SECTION_IDS)[number]);

  // 发写请求前作废旧快照，结束时再作废写入途中发出的读取；不靠响应先后猜库内提交时刻。
  const beginAccountWrite = useCallback(() => {
    accountWriteState.current.revision++;
    accountWriteState.current.active++;
    return () => {
      accountWriteState.current.revision++;
      accountWriteState.current.active--;
    };
  }, []);

  const isAccountSnapshotCurrent = useCallback((revision: number) => (
    accountWriteState.current.active === 0 && accountWriteState.current.revision === revision
  ), []);

  const runAccountWrite = useCallback(async <T,>(write: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const finishWrite = beginAccountWrite();
    const controller = new AbortController();
    const error = new Error("请求超时，结果未确认，请刷新核对，勿重复操作。");
    error.name = "AccountWriteTimeoutError";
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // 中断客户端等待不等于服务端回滚。绝不自动重试这些非幂等写入。
      return await Promise.race([
        Promise.resolve().then(() => write(controller.signal)),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort(error);
            reject(error);
          }, 30_000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
      finishWrite();
    }
  }, [beginAccountWrite]);

  const loadOverview = useCallback((refreshAfterWrite = false): Promise<void> => {
    const inFlight = overviewRefreshPromise.current;
    if (inFlight) {
      // 普通轮询只复用；写成功后的刷新必须补做，多个写入合并为一次补发。
      if (refreshAfterWrite) overviewRefreshPending.current = true;
      return inFlight;
    }
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    // 共享 Promise 是唯一在途状态；必须先登记再执行服务调用，不能在两者之间插入 await。
    overviewRefreshPromise.current = completion;
    void (async () => {
      try {
        do {
          overviewRefreshPending.current = false;
          const revision = accountWriteState.current.revision;
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(new Error("总览接口 30 秒未响应")), 30_000);
          try {
            const stats = await fetchAdminOverview(controller.signal);
            // 请求途中有写入时，这份结果已过期；等待补发，不能将旧数标成最新。
            if (!overviewRefreshPending.current && isAccountSnapshotCurrent(revision)) {
              setOverview(stats);
              setOverviewError(false);
            }
          } catch (error) {
            // 旧请求失败/超时也不能吞掉待补刷新；最终请求失败才通知所有等待者。
            if (!overviewRefreshPending.current && isAccountSnapshotCurrent(revision)) {
              setOverviewError(true);
              throw error;
            }
          } finally {
            clearTimeout(timeout);
          }
        } while (overviewRefreshPending.current);
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        overviewRefreshPromise.current = null;
      }
    })();
    return completion;
  }, [isAccountSnapshotCurrent]);

  const loadOpsOverview = useCallback(async () => {
    if (opsOverviewInFlight.current) return;
    opsOverviewInFlight.current = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("运营总览接口 30 秒未响应")), 30_000);
    try {
      const stats = await fetchAdminOpsOverview(controller.signal);
      setOpsOverview(stats);
      setOpsError(false);
    } catch (error) {
      setOpsError(true);
      throw error;
    } finally {
      clearTimeout(timeout);
      opsOverviewInFlight.current = false;
    }
  }, []);

  const loadStaff = useCallback(async () => {
    const revision = accountWriteState.current.revision;
    const list = await fetchAdminStaff();
    if (!isAccountSnapshotCurrent(revision)) return;
    setStaffList(list);
  }, [isAccountSnapshotCurrent]);

  const loadClients = useCallback(async () => {
    const revision = accountWriteState.current.revision;
    // 代理下拉跟客户列表一起拉；代理接口出错时返回空数组，不影响客户列表
    const [list, agents] = await Promise.all([fetchAdminClients(), fetchAgentOptions()]);
    if (!isAccountSnapshotCurrent(revision)) return;
    setClientList(list);
    setAgentOptions(agents);
  }, [isAccountSnapshotCurrent]);

  // 写成功已是事实。刷新错误单独反馈，并等两个读取都落定后才解除操作中的状态。
  const refreshAccountViews = useCallback(async (reload: () => Promise<unknown>, successMessage: string) => {
    const refreshList = async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        // 列表 API 没有超时参数，限制此次等待；不宣称已取消底层请求。
        await Promise.race([
          Promise.resolve().then(reload),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("账号列表 30 秒未响应")), 30_000);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    };
    const results = await Promise.allSettled([
      refreshList(),
      Promise.resolve().then(() => loadOverview(true)),
    ]);
    const failed = ["账号列表", "看板"].filter((_, index) => results[index].status === "rejected");
    if (failed.length) {
      setMessage(`${successMessage}；${failed.join("、")}刷新失败，请刷新核对，勿重复操作。`);
    }
  }, [loadOverview]);

  /**
   * 按搜索词筛客户。账号、客户名字、公司名字、电话、邮箱 —— 五样里命中任意一样就算。
   * 不分大小写；两头的空格自动去掉（从别处复制过来常常带空格）。
   * 在前端筛而不是重新请求接口：客户总共几十个，一次都取回来了，本地筛更快也不用等。
   */
  const filteredClientList = useMemo(() => {
    const q = clientSearchQuery.trim().toLowerCase();
    if (!q) return clientList;
    return clientList.filter((u) =>
      [u.id, u.name, u.companyName, u.phone, u.email]
        .some((v) => (v ?? "").toLowerCase().includes(q)),
    );
  }, [clientList, clientSearchQuery]);

  // 运单列表的门闩：10 秒轮询和手动「刷新」都走 loadOrders，慢的旧响应不许盖掉快的新响应（2026-09-05 复查补）
  const orderListGate = useRef(createRequestGate()).current;
  /**
   * 返回值告诉调用方这次结果有没有真的写进列表（Codex 2026-09-06 复核 P2-1）：
   *   applied = 写了；stale = 被更新的一次请求作废了（数据没写、失败也不抛）。
   * 手动「刷新」只有 applied 才许说「已刷新」；作废那次的失败也不许冒充新结果的失败。
   */
  const loadOrders = useCallback(async (): Promise<"applied" | "stale"> => {
    const ticket = orderListGate.begin();
    let list: Awaited<ReturnType<typeof fetchAdminOrders>>;
    try {
      list = await fetchAdminOrders();
    } catch (error) {
      if (!orderListGate.isCurrent(ticket)) return "stale"; // 旧请求的失败不许污染新结果
      setOrdersError(true);
      throw error;
    }
    if (!orderListGate.isCurrent(ticket)) return "stale";
    // 按运单号数字降序：YW0001220 > YW0001219
    // 【审查问题 10】原来用 Number() 比大小，超过 15 位会丢精度导致排序乱。
    // 改成先按位数、再按字符串比 —— 纯数字字符串等长时字典序就是数值序，不受长度限制。
    list.sort((a, b) => {
      const an = (a.trackingNo ?? "").replace(/\D/g, "").replace(/^0+/, "");
      const bn = (b.trackingNo ?? "").replace(/\D/g, "").replace(/^0+/, "");
      if (an.length !== bn.length) return bn.length - an.length;
      return bn.localeCompare(an);
    });
    setOrderList(list);
    setOrdersLoaded(true);
    setOrdersError(false);
    return "applied";
  }, []);

  /**
   * 载入待编辑订单到表单，便于管理员修改客户端订单信息。
   */
  const startEditOrder = (order: AdminOrderItem) => {
    setEditingOrderId(order.orderId ?? order.id);
    // 记下打开弹窗那一刻的样子，保存时只把改动过的项发出去，
    // 避免把别人在这期间改的字段一起覆盖掉
    setEditSnapshot({
      form: {
        clientId: order.clientId ?? "",
        trackingNo: order.trackingNo ?? "",
        batchNo: order.batchNo ?? "",
        warehouseId: order.warehouseId ?? "wh_yiwu_01",
        itemName: order.itemName ?? "",
        transportMode: order.transportMode === "land" ? "land" : "sea",
        domesticTrackingNo: order.domesticTrackingNo ?? "",
        receiverAddressTh: order.receiverAddressTh ?? "",
        containerNo: order.containerNo ?? "",
        productQuantity: String(order.productQuantity ?? 0),
        packageCount: String(order.packageCount ?? 0),
        packageUnit: order.packageUnit === "bag" ? "bag" : "box",
        weightKg: order.weightKg === null || order.weightKg === undefined ? "" : String(order.weightKg),
        volumeM3: order.volumeM3 === null || order.volumeM3 === undefined ? "" : String(order.volumeM3),
        cargoType: order.cargoType ?? "normal",
        paymentStatus: order.paymentStatus === "paid" ? "paid" : "unpaid",
        shipDate: order.shipDate ?? "",
        remark: order.remark ?? "",
      } as Record<string, string>,
      productsJson: "", // 下面构建完产品行后再填
    });
    setOrderEditForm({
      clientId: order.clientId ?? "",
      trackingNo: order.trackingNo ?? "",
      batchNo: order.batchNo ?? "",
      warehouseId: order.warehouseId ?? "wh_yiwu_01",
      itemName: order.itemName ?? "",
      transportMode: order.transportMode === "land" ? "land" : "sea",
      domesticTrackingNo: order.domesticTrackingNo ?? "",
      receiverAddressTh: order.receiverAddressTh ?? "",
      containerNo: order.containerNo ?? "",
      productQuantity: String(order.productQuantity ?? 0),
      packageCount: String(order.packageCount ?? 0),
      packageUnit: order.packageUnit === "bag" ? "bag" : "box",
      weightKg: order.weightKg === null || order.weightKg === undefined ? "" : String(order.weightKg),
      volumeM3: order.volumeM3 === null || order.volumeM3 === undefined ? "" : String(order.volumeM3),
      cargoType: order.cargoType ?? "normal",
      paymentStatus: order.paymentStatus === "paid" ? "paid" : "unpaid",
      shipDate: order.shipDate ?? "",
      remark: order.remark ?? "",
    });
    const rows = (order.products ?? []).map((p) => ({
      id: p.id,
      itemName: p.itemName ?? "",
      packageCount: String(p.packageCount ?? ""),
      lengthCm: p.lengthCm != null ? String(p.lengthCm) : "",
      widthCm: p.widthCm != null ? String(p.widthCm) : "",
      heightCm: p.heightCm != null ? String(p.heightCm) : "",
      productQuantity: p.productQuantity != null ? String(p.productQuantity) : "",
      weightKg: p.weightKg != null ? String(p.weightKg) : "",
      cargoType: p.cargoType ?? "normal",
      domesticTrackingNo: p.domesticTrackingNo ?? "货拉拉",
    }));
    setEditProducts(rows);
    // 产品行的快照直接用表单自己的格式，比对时不会因为格式差异误判
    setEditSnapshot((prev) => (prev ? { ...prev, productsJson: JSON.stringify(rows) } : prev));
  };

  /**
   * 保存管理员对客户端订单的编辑结果。
   */
  const submitOrderEdit = async () => {
    if (loading) return;
    if (!editingOrderId) {
      setMessage("请先选择要编辑的订单。");
      return;
    }
    if (!orderEditForm.trackingNo.trim()) {
      setMessage("请填写运单号。");
      return;
    }
    // 从产品行计算总数
    const activeProducts = editProducts;
    // ⚠️ 先把产品行卡住再算合计（2026-08-29 补）。箱数是三个合计的乘数，
    // 原来 `Number(p.packageCount) || 1` 会把「没填」和「填 0」悄悄当成 1 箱。
    {
      const rowIssue = validateProductRows(activeProducts);
      if (rowIssue) { setMessage(rowIssue); return; }
    }
    const totalPackageCount = activeProducts.reduce((s, p) => s + Number(String(p.packageCount).trim()), 0);
    // ⚠️ 产品行上的「数量」口径是**单箱几个**（这一页的表头就写着「单箱数量」），
    // 所以总数必须乘箱数。2026-08-28 复核实测：这里原来直接相加，跟批量导入犯的是同一个错。
    // 口径见 apps/api/src/modules/orders/routes.ts:833 的注释。
    const totalProductQuantity = activeProducts.reduce(
      (s, p) => s + (Number(p.productQuantity) || 0) * Number(String(p.packageCount).trim()),
      0,
    );
    const primaryItemName = activeProducts[0]?.itemName.trim() || orderEditForm.itemName.trim();
    if (!primaryItemName) {
      setMessage("请填写品名。");
      return;
    }
    if (activeProducts.length === 0) {
      setMessage("请至少添加一个产品行。");
      return;
    }
    // 总体积/总重量「自动算 vs 手填」的裁决统一走 decideEditTotals
    // （2026-08-31，排查报告第22条：原来任何一行填了尺寸就静默扔掉手填值）
    const { finalVolume, finalWeight, notes: totalsNotes } = decideEditTotals(
      activeProducts, orderEditForm.weightKg, orderEditForm.volumeM3,
    );

    const saveOrderId = editingOrderId;
    if (!saveOrderId) { setMessage("编辑失败：未选择订单"); return; }

    setLoading(true);
    setMessage("");
    try {
      const products = activeProducts.map(p => ({
        id: p.id,
        itemName: p.itemName.trim(),
        packageCount: packageCountForPayload(p.packageCount),
        lengthCm: p.lengthCm ? Number(p.lengthCm) : undefined,
        widthCm: p.widthCm ? Number(p.widthCm) : undefined,
        heightCm: p.heightCm ? Number(p.heightCm) : undefined,
        productQuantity: p.productQuantity ? Number(p.productQuantity) : undefined,
        cargoType: p.cargoType || "normal",
        domesticTrackingNo: p.domesticTrackingNo.trim() || "货拉拉",
        weightKg: p.weightKg ? Number(p.weightKg) : undefined,
      }));

      // 只把「打开弹窗之后被改动过的项」发出去。没改的不发，
      // 后端就不会去动它 —— 这样两个人改不同字段不会互相覆盖。
      const snap = editSnapshot?.form;
      const changed = (key: string, current: string) => !snap || snap[key] !== current;
      const productsChanged = !editSnapshot || editSnapshot.productsJson !== JSON.stringify(activeProducts);
      // 只改了手填的总重量/总体积、没动产品明细时也要保存（2026-08-31，排查报告第22条：
      // 原来这两个数只跟着产品行一起发，单独改手填框等于白填）
      const manualTotalsChanged =
        changed("weightKg", orderEditForm.weightKg) || changed("volumeM3", orderEditForm.volumeM3);

      await updateAdminOrder({
        orderId: saveOrderId,
        ...(changed("clientId", orderEditForm.clientId) ? { clientId: orderEditForm.clientId.trim() || "" } : {}),
        ...(changed("itemName", orderEditForm.itemName) || productsChanged ? { itemName: primaryItemName } : {}),
        ...(changed("trackingNo", orderEditForm.trackingNo) ? { trackingNo: orderEditForm.trackingNo.trim() || "" } : {}),
        ...(changed("batchNo", orderEditForm.batchNo) ? { batchNo: orderEditForm.batchNo.trim() || "" } : {}),
        ...(changed("warehouseId", orderEditForm.warehouseId) ? { warehouseId: orderEditForm.warehouseId } : {}),
        ...(changed("transportMode", orderEditForm.transportMode) ? { transportMode: orderEditForm.transportMode } : {}),
        ...(changed("domesticTrackingNo", orderEditForm.domesticTrackingNo) ? { domesticTrackingNo: orderEditForm.domesticTrackingNo.trim() || "" } : {}),
        ...(changed("receiverAddressTh", orderEditForm.receiverAddressTh) ? { receiverAddressTh: orderEditForm.receiverAddressTh.trim() } : {}),
        ...(changed("containerNo", orderEditForm.containerNo) ? { containerNo: orderEditForm.containerNo.trim() || "" } : {}),
        ...(changed("packageUnit", orderEditForm.packageUnit) ? { packageUnit: orderEditForm.packageUnit } : {}),
        ...(changed("cargoType", orderEditForm.cargoType) ? { cargoType: orderEditForm.cargoType } : {}),
        ...(changed("shipDate", orderEditForm.shipDate) ? { shipDate: orderEditForm.shipDate.trim() } : {}),
        ...(changed("remark", orderEditForm.remark ?? "") ? { remark: orderEditForm.remark?.trim() || null } : {}),
        // 件数/数量是按产品行算出来的，产品行没动就不发
        ...(productsChanged ? {
          productQuantity: totalProductQuantity,
          packageCount: totalPackageCount,
          products,
        } : {}),
        // 重量/体积单独判断：产品行或手填框任一动过就发（见上面 manualTotalsChanged 的注释）
        ...(productsChanged || manualTotalsChanged ? {
          weightKg: finalWeight,
          volumeM3: finalVolume,
        } : {}),
      });
      // 手填值和自动计算冲突时明说哪边生效了，不再静默（排查报告第22条）
      setToast(totalsNotes.length > 0 ? `订单信息已更新。${totalsNotes.join("；")}` : "订单信息已更新");
      await loadOrders();
    } catch (error) {
      const text = error instanceof Error ? error.message : "保存失败";
      setMessage(`保存失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  const loadSessionMemory = useCallback(async () => {
    const data = await fetchAdminAiSessionMemory({ limit: 200 });
    setSessionMemoryList(data.items ?? []); // 【审查问题 13】接口少了 items 就会让整页崩掉
  }, []);

  // 2026-09-01 竞态全扫：快速切「待处理/已处理」时，先回来的旧响应不许盖掉新页签的列表
  const knowledgeGapGate = useRef(createRequestGate()).current;
  const loadKnowledgeGaps = useCallback(async () => {
    const ticket = knowledgeGapGate.begin();
    const data = await fetchAdminAiKnowledgeGaps({ status: knowledgeGapStatus });
    if (!knowledgeGapGate.isCurrent(ticket)) return; // 号作废：旧页签的数据不许上屏
    setKnowledgeGapList(data.items ?? []); // 【审查问题 13】同上
  }, [knowledgeGapStatus, knowledgeGapGate]);

  const loadKnowledge = useCallback(async () => {
    if (!session?.companyId) return;
    const list = await fetchKnowledgeList();
    setKnowledgeItems(list);
  }, [session]);

  const loadAll = useCallback(
    async (currentSession?: AuthSession | null) => {
      const s = currentSession ?? session;
      if (!s?.companyId) return;
      setLoading(true);
      setMessage("");
      try {
        await Promise.all([
          loadOverview(),
          loadOpsOverview(),
          loadStaff(),
          loadClients(),
          loadOrders(),
          loadSessionMemory(),
          loadKnowledgeGaps(),
          fetchKnowledgeList().then(setKnowledgeItems),
        ]);
      } catch (error) {
        const text = error instanceof Error ? error.message : "加载失败";
        setMessage(`加载失败：${text}`);
      } finally {
        setLoading(false);
      }
    },
    [session, loadOverview, loadOpsOverview, loadStaff, loadClients, loadOrders, loadSessionMemory, loadKnowledgeGaps],
  );

  useEffect(() => {
    const next = getOptionalSession();
    if (!next) return;
    setSession(next);
    void loadAll(next);

    // 10 秒自动刷新同步。看板的 KPI / 柜量 / 告警必须和运单列表一起刷新，
    // 否则右侧状态图已经变了，顶部 KPI 还停在首次打开页面时的旧值。
    const interval = window.setInterval(() => {
      if (document.hidden) return;
      loadOverview().catch(() => {});
      loadOpsOverview().catch(() => {});
      loadStaff().catch(() => {});
      loadClients().catch(() => {});
      loadOrders().catch(() => {});
    }, 10000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(""), 2200);
    return () => window.clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    void loadKnowledgeGaps();
  }, [loadKnowledgeGaps]);

  useEffect(() => {
    fetchShippingConfig().then(c => {
      if (c.sea_min_volume) setShippingConfigSea(c.sea_min_volume);
      if (c.land_min_volume) setShippingConfigLand(c.land_min_volume);
    }).catch(() => {});
  }, []);

  const submitKnowledge = async () => {
    if (loading) return;
    if (!title.trim() || !content.trim()) {
      setMessage("请先填写知识标题和内容。");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      await createKnowledgeItem({
        title: title.trim(),
        content: content.trim(),
      });
      setTitle("");
      setContent("");
      setToast("知识投喂成功");
      await loadKnowledge();
    } catch (error) {
      const text = error instanceof Error ? error.message : "投喂失败";
      setMessage(`投喂失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  const removeKnowledge = async (id: string) => {
    setLoading(true);
    setMessage("");
    try {
      await deleteKnowledgeItem(id);
      await loadKnowledge();
      setToast("知识条目删除成功");
    } catch (error) {
      const text = error instanceof Error ? error.message : "删除失败";
      setMessage(`删除失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  const submitAddStaff = async () => {
    if (loading) return;
    if (!staffForm.name.trim() || !staffForm.phone.trim()) {
      setMessage("请填写员工姓名和手机号。");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      try {
        await runAccountWrite((signal) => createAdminStaff({
          id: staffForm.id.trim() || undefined,
          name: staffForm.name.trim(),
          phone: staffForm.phone.trim(),
          password: staffForm.password.trim() || undefined,
        }, signal));
      } catch (error) {
        if (error instanceof Error && error.name === "AccountWriteTimeoutError") {
          setMessage(error.message);
          return;
        }
        const text = error instanceof Error ? error.message : "添加失败";
        if (text.includes("permission") || text.includes("FORBIDDEN") || text.includes("403")) {
          setMessage("添加失败：请使用管理员身份登录（在首页选择 admin 并进入工作台）后再试。");
        } else {
          setMessage(`添加失败：${text}`);
        }
        return;
      }
      setStaffForm({ id: "", name: "", phone: "", password: "" });
      setShowStaffModal(false);
      setToast("员工添加成功");
      setMessage("");
      await refreshAccountViews(loadStaff, "员工已添加");
    } finally {
      setLoading(false);
    }
  };

  /**
   * 2026-08-07：删除账号改成封禁。
   *
   * 原来这两个函数调的是「删除账号」，但那条路本来就走不通：
   * 数据库有 15 张表以 RESTRICT 认着这个账号（订单、地址、钱包、产品图、审计日志…），
   * 只要名下有一条记录就删不掉，报错还是英文的 500，用户只看到「删除失败」。
   * 而且删员工那个函数漏传了管理员密码，后端第一关就打回，**从来没成功过**。
   *
   * 用户要的其实只是「让这个账号登不进来」，封禁正好就是这个，
   * 而且单据、图片、流水全都留着，随时能解封。
   */
  const confirmToggleBan = async (
    userId: string,
    userName: string,
    currentStatus: string,
    reload: () => Promise<unknown>,
    kind: "客户" | "员工",
  ) => {
    if (loading) return;
    const banned = currentStatus === "inactive";
    const word = banned ? "解除封禁" : "封禁";
    const tip = banned
      ? `确定解除「${userName}」的封禁吗？解除后这个账号可以重新登录。`
      // 系统弹窗不认 markdown，别在这里写 ** **，会原样显示成星号
      : `确定封禁${kind}「${userName}」吗？\n\n· 这个账号立刻登不进来\n· 他名下的订单、运单、图片、余额一条都不会动\n· 随时可以解除`;
    if (!window.confirm(tip)) return;
    setLoading(true);
    setMessage("");
    try {
      let result: Awaited<ReturnType<typeof toggleUserBan>>;
      try {
        result = await runAccountWrite((signal) => toggleUserBan(userId, signal));
      } catch (error) {
        if (error instanceof Error && error.name === "AccountWriteTimeoutError") {
          setMessage(error.message);
          return;
        }
        const text = error instanceof Error ? error.message : `${word}失败`;
        setMessage(`${word}失败：${text}`);
        return;
      }
      // 使用服务器确认状态，而不是猜测取反；旧列表由同一写入版本边界拦截。
      const applyStatus = (rows: AdminUserItem[]) => rows.map((row) => (
        row.id === result.id ? { ...row, status: result.status } : row
      ));
      if (kind === "员工") setStaffList(applyStatus);
      else setClientList(applyStatus);
      setToast(result.status === "active" ? "已解除封禁" : "已封禁，该账号无法再登录");
      await refreshAccountViews(reload, result.status === "active" ? "已解除封禁" : "已封禁");
    } finally {
      setLoading(false);
    }
  };

  const submitSetPassword = async (userId: string) => {
    if (loading) return;
    if (!settingPasswordValue.trim()) {
      setMessage("请输入新密码。");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      await setAdminStaffPassword(userId, settingPasswordValue.trim());
      setSettingPasswordFor(null);
      setSettingPasswordValue("");
      setShowSettingPassword(false);
      setToast("密码已更新");
    } catch (error) {
      const text = error instanceof Error ? error.message : "设置失败";
      setMessage(`设置失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  const submitAddClient = async () => {
    if (loading) return;
    if (!clientForm.name.trim() || !clientForm.phone.trim()) {
      setMessage("请填写客户名字和电话号码。");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      try {
        await runAccountWrite((signal) => createAdminClient({
          id: clientForm.id.trim() || undefined,
          name: clientForm.name.trim(),
          companyName: clientForm.companyName.trim() || undefined,
          phone: clientForm.phone.trim(),
          email: clientForm.email.trim() || undefined,
          password: clientForm.password.trim() || undefined,
          agentId: clientForm.agentId || null,
        }, signal));
      } catch (error) {
        if (error instanceof Error && error.name === "AccountWriteTimeoutError") {
          setMessage(error.message);
          return;
        }
        const text = error instanceof Error ? error.message : "添加失败";
        if (text.includes("permission") || text.includes("FORBIDDEN") || text.includes("403")) {
          setMessage("添加失败：请使用管理员身份登录后再试。");
        } else {
          setMessage(`添加失败：${text}`);
        }
        return;
      }
      const agentName = agentOptions.find((a) => a.id === clientForm.agentId)?.name;
      setClientForm({ id: "", name: "", companyName: "", phone: "", email: "", password: "", agentId: "" });
      setShowClientModal(false);
      setToast(agentName ? `客户添加成功，开在代理「${agentName}」名下` : "客户添加成功");
      setMessage("");
      await refreshAccountViews(loadClients, "客户已添加");
    } finally {
      setLoading(false);
    }
  };

  const submitEditClient = async () => {
    if (loading) return;
    if (!editingClientId) return;
    if (!clientForm.name.trim() || !clientForm.phone.trim()) {
      setMessage("请填写客户名字和电话号码。");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      try {
        await runAccountWrite((signal) => updateAdminClient({
          id: editingClientId,
          name: clientForm.name.trim(),
          companyName: clientForm.companyName.trim() || undefined,
          phone: clientForm.phone.trim(),
          email: clientForm.email.trim() || undefined,
          password: clientForm.password.trim() || undefined,
          // 归属只有真改了才发（后端只许没业务记录的客户改归属，不改就别去碰那道闸）
          ...(clientForm.agentId !== (editingClientAgentId ?? "") ? { agentId: clientForm.agentId || null } : {}),
        }, signal));
      } catch (error) {
        if (error instanceof Error && error.name === "AccountWriteTimeoutError") {
          setMessage(error.message);
          return;
        }
        const text = error instanceof Error ? error.message : "更新失败";
        if (text.includes("permission") || text.includes("FORBIDDEN") || text.includes("403")) {
          setMessage("更新失败：请使用管理员身份登录后再试。");
        } else {
          setMessage(`更新失败：${text}`);
        }
        return;
      }
      setClientForm({ id: "", name: "", companyName: "", phone: "", email: "", password: "", agentId: "" });
      setShowClientModal(false);
      setEditingClientId(null);
      setEditingClientAgentId(null);
      setToast("客户信息已更新");
      setMessage("");
      await refreshAccountViews(loadClients, "客户资料已保存");
    } finally {
      setLoading(false);
    }
  };

  /**
   * 2026-09-18 老板拍板：客户长期价这套不用了（价格改成每个柜当场填），所以这里的
   * 「填/改长期价」表单和提交函数都删了。后端接口 POST /admin/clients/whr-price
   * 和服务层的 setAdminClientWhrPrice 都留着，以后要开回来照旧能用。
   */

  /* 列表和导出用**同一份**判断（modules/shipment/export-filter.ts）：
     2026-09-23 给导出弹窗加了自己的条件，两个地方要按同一套口径筛，抽出去免得以后改一边忘一边。 */
  const filteredOrderList = useMemo(
    () => orderList.filter((item) =>
      matchesShipmentListFilter(item.currentStatus, shipmentGroup) && matchesShipmentFilter(adminOrderFilterRow(item), orderSearch)),
    [orderList, orderSearch, shipmentGroup],
  );

  // 按当前结果计数；刷新后失去的勾选项不参与导出，也不回退成「导出全部」。
  const selectedResultOrders = useMemo(
    () => filteredOrderList.filter((order) => selectedOrders.has(order.id)),
    [filteredOrderList, selectedOrders],
  );
  const allResultOrdersSelected = filteredOrderList.length > 0 && selectedResultOrders.length === filteredOrderList.length;

  const runOrderSearch = () => {
    setToast(`共 ${filteredOrderList.length} 条运单`);
    document.getElementById("admin-order-list-results")?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "nearest",
    });
  };

  const copyOrderNumber = async (number: string) => {
    setOrderCopyNotice("");
    try {
      await navigator.clipboard.writeText(number);
      setOrderCopyNotice(`已复制单号 ${number}`);
    } catch {
      setOrderCopyNotice(`复制未完成，请手动选择并复制单号 ${number}`);
    }
  };

  const refreshOrderList = async () => {
    if (orderRefreshInFlight.current) return;
    orderRefreshInFlight.current = true;
    setOrderRefreshing(true);
    try {
      const outcome = await loadOrders();
      // 被更新的一次请求作废时，只说「被替代」——那次请求可能还没回来、也可能失败，这里不许替它宣布「已更新」
      // （Codex 2026-09-06 第二轮：R1 手动→R2 轮询→R1 作废→R2 失败，全程列表没变，不能提示更新完成）
      setToast(outcome === "applied" ? "运单列表已刷新" : "本次刷新已被较新的请求替代");
    } catch (error) {
      setMessage(`刷新失败，已保留上次结果：${error instanceof Error ? error.message : "请稍后重试"}`);
    } finally {
      orderRefreshInFlight.current = false;
      setOrderRefreshing(false);
    }
  };

  const toggleSelectOrder = (id: string) => {
    setSelectedOrders((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };
  const totalPages = Math.max(1, Math.ceil(filteredOrderList.length / pageSize));
  useEffect(() => { setCurrentPage((page) => Math.min(page, totalPages)); }, [totalPages]);
  const pagedOrders = useMemo(() => {
    const offset = (currentPage - 1) * pageSize;
    return filteredOrderList.slice(offset, offset + pageSize);
  }, [filteredOrderList, pageSize, currentPage]);

  const toggleSelectAllOrders = () => {
    if (allResultOrdersSelected) setSelectedOrders(new Set());
    else setSelectedOrders(new Set(filteredOrderList.map((o) => o.id)));
  };

  const [orderExportFeedback, setOrderExportFeedback] = useState("");
  /* 导出弹窗有自己的一套条件（2026-09-23 老板：导出不能只让选日期）。
     打开弹窗时把列表上已经筛好的条件带进来，可以改、可以清空；列表本身不受影响。 */
  const [exportFilter, setExportFilter] = useState<ShipmentFilterValue>(EMPTY_SHIPMENT_FILTER);
  const [exportGroup, setExportGroup] = useState<ShipmentGroupFilter>("all");
  const prefillExportFilter = () => {
    setOrderExportFeedback("");
    setExportGroup(shipmentGroup);
    setExportFilter({
      ...orderSearch,
      /* 弹窗里只放一组日期（老板 2026-09-23 定：按到仓日期）。列表上那两组日期（到仓 / 发货）筛的是同一个字段，
         带进来时取**交集**（起始取晚的、截止取早的），免得导出比列表宽。
         口径跟列表「到仓日期」那格完全一样（arrivedAt：没填到仓日期就退到建单日期），不然会少导。 */
      arrivedAtFrom: mergeDateFrom(orderSearch.arrivedAtFrom, orderSearch.shipDateFrom),
      arrivedAtTo: mergeDateTo(orderSearch.arrivedAtTo, orderSearch.shipDateTo),
      shipDateFrom: "",
      shipDateTo: "",
    });
  };
  const exportFieldValues: Record<string, string> = { ...exportFilter, group: exportGroup };
  const onExportFieldChange = (key: string, next: string) => {
    setOrderExportFeedback("");
    if (key === "group") { setExportGroup(next as ShipmentGroupFilter); return; }
    setExportFilter((prev) => ({ ...prev, [key]: next }));
  };
  const exportCommonFields: ExportFieldDef[] = [
    { key: "group", label: "运单分组", type: "select", options: SHIPMENT_GROUP_OPTIONS },
    { key: "arrivedAtFrom", label: "到仓开始日期", type: "date" },
    { key: "arrivedAtTo", label: "到仓截止日期", type: "date" },
    { key: "logisticsStatus", label: "物流状态", type: "select", options: [{ value: "", label: "全部" }, ...logisticsStatusOptions.map((v) => ({ value: v, label: v }))] },
    { key: "warehouseId", label: "仓库", type: "select", options: [{ value: "", label: "全部" }, ...warehouseOptions.map((w) => ({ value: w.id, label: w.label }))] },
    { key: "transportMode", label: "运输方式", type: "select", options: [{ value: "", label: "全部" }, { value: "sea", label: "海运" }, { value: "land", label: "陆运" }] },
    { key: "clientName", label: "唛头 / 客户名", type: "text", placeholder: "唛头或客户名" },
    { key: "trackingNo", label: "运单号", type: "text", placeholder: "支持部分匹配" },
  ];
  const exportMoreFields: ExportFieldDef[] = [
    { key: "domesticTrackingNo", label: "国内单号", type: "text" },
    { key: "itemName", label: "品名", type: "text" },
    { key: "containerNo", label: "柜号", type: "text" },
    { key: "batchNo", label: "批次号", type: "text" },
    { key: "packageCount", label: "包裹数量", type: "text" },
    { key: "productQuantity", label: "产品数量", type: "text" },
    { key: "weightKg", label: "重量", type: "text" },
    { key: "volumeM3", label: "体积", type: "text" },
    { key: "receiverAddress", label: "收货地址", type: "text" },
    { key: "receivableAmount", label: "加收金额", type: "text" },
    { key: "statusRaw", label: "状态关键词", type: "text" },
  ];

  const exportOrdersToExcel = () => {
    /* 按**弹窗里的条件**筛（不是列表的条件，2026-09-23）。勾了单子就只导勾的那些（仍要符合条件）。
       跟列表用同一份判断（matchesShipmentFilter），口径不会跑偏。 */
    const matched = orderList.filter((item) =>
      matchesShipmentListFilter(item.currentStatus, exportGroup) && matchesShipmentFilter(adminOrderFilterRow(item), exportFilter));
    const source = selectedOrders.size > 0 ? matched.filter((o) => selectedOrders.has(o.id)) : matched;
    if (source.length === 0) {
      const why = selectedOrders.size > 0 ? "勾选的运单里没有符合这些条件的。" : "没有符合这些条件的运单。";
      setMessage(why); setOrderExportFeedback(why); return;
    }
    const rows = source.map((o) => ({
      // 导出的品名带全部产品名（2026-09-11，同员工端导出口径）
      运单号: o.trackingNo ?? "-", 客户: o.clientId ?? "-", 品名: productNamesLabel(o.products, o.itemName),
      // 货型（2026-09-11 老板点的），口径同员工端导出
      货型: cargoTypeLabel((o.products ?? []).map((p: any) => p.cargoType), o.cargoType),
      运输方式: transportModeLabel(o.transportMode), 国内单号: o.domesticTrackingNo ?? "-", 柜号: o.batchNo ?? "-",
      审批状态: o.approvalStatus === "pending" ? "待审核" : o.approvalStatus === "approved" ? "已审核" : o.approvalStatus === "shipped" ? "已发货" : o.approvalStatus,
      产品数量: o.productQuantity ?? "-", 包裹数量: o.packageCount ?? "-",
      重量: o.weightKg ?? "-", 体积: o.volumeM3 ?? "-",
      // 长宽高来自产品行；一张单有多个不同尺寸时后端会拼成 "60/50"（2026-08-27 加）
      长cm: o.lengthCm ?? "-", 宽cm: o.widthCm ?? "-", 高cm: o.heightCm ?? "-",
      到仓日期: o.shipDate ?? "-",
      // 2026-09-23 复核补：这一列原来只有员工端导出有，客户端那份要跟这套模板一致，补上
      物流状态: shipmentStatusZh(o.currentStatus),
      /* 2026-09-03：这一列原来导的是英文（而且是数据库里从没更新过的死字段，
         全库都是 unfinished）。现在后端实时算，这里转成中文再导。 */
      状态组: o.statusGroup ? (CLIENT_STATUS_GROUP_ZH[o.statusGroup] ?? o.statusGroup) : "-",
      创建时间: o.createdAt ?? "-", 更新时间: o.updatedAt ?? "-",
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "订单列表");
    XLSX.writeFile(wb, `订单数据_${new Date().toISOString().slice(0,10)}.xlsx`);
    setToast(`已导出 ${rows.length} 条`);
    setOrderExportFeedback(`已导出 ${rows.length} 条`);
  };

  const orderExportDateInvalid = shipmentFilterDateInvalid(exportFilter);
  const handleOrderExport = async () => {
    if (orderExportInFlight.current || orderExportDateInvalid) return;
    orderExportInFlight.current = true;
    setOrderExporting(true);
    setOrderExportFeedback("");
    try {
      // 文件生成推迟到下一轮，按钮先进入忙碌状态；同轮点击共用 ref。
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      exportOrdersToExcel();
    } catch (error) {
      setMessage(`导出失败：${error instanceof Error ? error.message : "请稍后重试"}`);
      setOrderExportFeedback(`导出失败：${error instanceof Error ? error.message : "请稍后重试"}`);
    } finally {
      orderExportInFlight.current = false;
      setOrderExporting(false);
    }
  };

  useEffect(() => {
    const syncSectionByHash = () => {
      const hashId = window.location.hash.replace(/^#/, "");
      if (isSectionId(hashId)) {
        setActiveSection(hashId);
      } else if (!hashId) {
        // 地址里没有 #（例如后退回最初打开的 /admin）就回默认分区，否则地址和显示的分区对不上
        setActiveSection("overview");
      }
    };
    syncSectionByHash();
    window.addEventListener("hashchange", syncSectionByHash);
    return () => window.removeEventListener("hashchange", syncSectionByHash);
  }, []);

  const clearSessionMemory = async () => {
    if (!window.confirm("确定清理当前筛选条件下的 AI 会话记忆吗？")) return;
    setLoading(true);
    setMessage("");
    try {
      const result = await clearAdminAiSessionMemory({
        sessionId: memoryFilterSessionId.trim() || undefined,
        userId: memoryFilterUserId.trim() || undefined,
      });
      await loadSessionMemory();
      setToast("会话记忆已清理");
      setMessage(`已清理 ${result.removed} 条会话记忆。`);
    } catch (error) {
      const text = error instanceof Error ? error.message : "清理失败";
      setMessage(`清理失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  const resolveKnowledgeGap = async (id: string) => {
    setLoading(true);
    setMessage("");
    try {
      await resolveAdminAiKnowledgeGap({ id });
      await loadKnowledgeGaps();
      setToast("已标记为已处理");
    } catch (error) {
      const text = error instanceof Error ? error.message : "操作失败";
      setMessage(`操作失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  const loadRates = async () => {
    try {
      const data = await fetchAdminShippingRates();
      setRateItems(data.items ?? []); // 【审查问题 13】同上
      setRateDefaults(data.defaults);
      // 初始化默认价格编辑值
      const initPrices: Record<string, number> = {};
      for (const d of data.defaults) {
        const override = data.items.find((r) => r.transportMode === d.transportMode && r.cargoType === d.cargoType && !r.customerId);
        initPrices[`${d.transportMode}|${d.cargoType}`] = override?.unitPriceCny ?? d.unitPriceCny;
      }
      setDefaultEditPrices(initPrices);
    } catch { /* ignore */ }
  };

  const priceDefaults = rateDefaults.length > 0 ? rateDefaults : [
    { transportMode: "sea", cargoType: "normal", unitPriceCny: DEFAULT_SHIPPING_PRICES.sea },
    { transportMode: "sea", cargoType: "inspection", unitPriceCny: DEFAULT_SHIPPING_PRICES.sea + INSPECTION_SURCHARGE },
    { transportMode: "sea", cargoType: "sensitive", unitPriceCny: DEFAULT_SHIPPING_PRICES.sea + SENSITIVE_SURCHARGE },
    { transportMode: "land", cargoType: "normal", unitPriceCny: DEFAULT_SHIPPING_PRICES.land },
    { transportMode: "land", cargoType: "inspection", unitPriceCny: DEFAULT_SHIPPING_PRICES.land + INSPECTION_SURCHARGE },
    { transportMode: "land", cargoType: "sensitive", unitPriceCny: DEFAULT_SHIPPING_PRICES.land + SENSITIVE_SURCHARGE },
  ];

  const loadClientPrices = async (clientId: string) => {
    try {
      const data = await fetchClientShippingConfig(clientId);
      setClientPrices(data.prices);
      setClientMinVolumeDisabled(data.disableMinVolume);
    } catch { /* ignore */ }
  };

  const toggleClientExpand = async (clientId: string) => {
    if (expandedClientId === clientId) {
      setExpandedClientId(null);
      return;
    }
    setExpandedClientId(clientId);
    await loadClientPrices(clientId);
  };

  useEffect(() => {
    if (activeSection === "shipping-config" && clientList.length > 0) void loadRates();
    // 2026-08-06：原来只在搜索框 onFocus 时才去加载可选运单，
    // 进到「尾端派送」不点那个框，列表就一直是空的，看起来像没数据。
    // 改成进这个页面就连派送单一起加载。
    if (activeSection === "lastmile") { loadLastmileOrders(); void loadLmShipments(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSection, clientList]);

  // 【审查问题 5】充值审核的状态筛选原来写在 onClick 里：
  // setRechargeStatusFilter(s) 之后紧接着 setTimeout(loadRecharges, 0)，
  // 但那个 loadRecharges 闭包读的还是点击前的筛选值 —— 结果永远慢一拍，
  // 点「待审核」拉回来的是上一次的结果。改成让筛选值变化自己触发加载。
  useEffect(() => {
    if (activeSection !== "wallet-recharges") return;
    void loadRecharges();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSection, rechargeStatusFilter]);

  if (!session) return null;

  return (
    <>
      {/* 1. 运营看板 */}
      <section id="overview" style={{ ...sectionStyle, display: activeSection === "overview" ? "block" : "none" }}>
        <AdminOperationsOverview
          overview={overview}
          opsOverview={opsOverview}
          shipmentCounts={ordersLoaded ? shipmentCounts : null}
          overviewError={overviewError}
          ordersError={ordersError}
          opsError={opsError}
        />
      </section>

      {/* 2. 员工管理 */}
      <section id="staff" style={{ ...sectionStyle, display: activeSection === "staff" ? "block" : "none" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{SECTION_LABELS.staff}</h2>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              type="button"
              onClick={() => setStaffPanelCollapsed((v) => !v)}
              style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "6px 10px", background: "var(--white)", fontWeight: 600, cursor: "pointer", color: "var(--t-strong)" }}
            >
              {staffPanelCollapsed ? "展开" : "折叠"}
            </button>
            <button
              type="button"
              onClick={() => void loadStaff()}
              disabled={loading}
              style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "6px 12px", background: "var(--white)", cursor: "pointer", color: "var(--t-strong)" }}
            >
              刷新
            </button>
          </div>
        </div>
        {staffPanelCollapsed ? (
          <p style={{ color: "var(--t-strong)", fontSize: 13, margin: 0 }}>已折叠，可防止误删。点击「展开」后显示添加员工与员工列表（含设置密码、删除等操作）。</p>
        ) : (
          <>
        <div style={{ marginBottom: 12 }}>
          <button
            type="button"
            onClick={() => { setShowStaffModal(true); setStaffForm({ id: "", name: "", phone: "", password: "" }); }}
            style={{ border: "none", borderRadius: 8, padding: "8px 14px", background: "var(--c-blue)", color: "var(--white)", fontWeight: 600, cursor: "pointer" }}
          >
            创建账号
          </button>
          <span style={{ marginLeft: 8, fontSize: 12, color: "var(--t-strong)" }}>需使用管理员身份登录</span>
        </div>
        {staffList.length === 0 ? (
          <EmptyStateCard title="暂无员工" description="请在上方添加员工账号。" />
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {staffList.map((u) => (
              <div key={u.id} style={{ border: "1px solid var(--l-soft)", borderRadius: 8, padding: 12, background: "var(--white)" }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8, alignItems: "center" }}>
                  <span><strong>账号</strong> {u.id}</span>
                  <span><strong>姓名</strong> {u.name}</span>
                  <span><strong>手机</strong> {u.phone}</span>
                  <span><strong>状态</strong> {u.status === "inactive" ? "已封禁" : "正常"}</span>
                  <span style={{ color: "var(--t-strong)", fontSize: 12 }}>{u.createdAt.slice(0, 10)}</span>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={() => { setShowSettingPassword(false); setSettingPasswordValue(""); setSettingPasswordFor(settingPasswordFor === u.id ? null : u.id); }}
                      disabled={loading}
                      style={{ border: "1px solid var(--c-green)", color: "var(--c-green)", borderRadius: 8, padding: "6px 10px", background: "#f0fdf4", cursor: "pointer", fontSize: 13 }}
                    >
                      {settingPasswordFor === u.id ? "取消" : "设置密码"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void confirmToggleBan(u.id, u.name, u.status, loadStaff, "员工")}
                      disabled={loading}
                      style={{ border: `1px solid ${u.status === "inactive" ? "var(--c-green)" : "var(--c-red-2)"}`, color: u.status === "inactive" ? "var(--c-green)" : "var(--c-red-2)", borderRadius: 8, padding: "6px 10px", background: u.status === "inactive" ? "#f0fdf4" : "#fef2f2", cursor: "pointer", fontSize: 13 }}
                    >
                      {u.status === "inactive" ? "解除封禁" : "封禁"}
                    </button>
                  </div>
                </div>
                {settingPasswordFor === u.id ? (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--l-soft)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <input
                      type={showSettingPassword ? "text" : "password"}
                      value={settingPasswordValue}
                      onChange={(e) => setSettingPasswordValue(e.target.value)}
                      placeholder="新密码：至少 8 位，不能全是数字"
                      style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "6px 10px", width: 240 }}
                    />
                    <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13, color: "var(--t-strong)", cursor: "pointer", whiteSpace: "nowrap" }}>
                      <input type="checkbox" checked={showSettingPassword} onChange={(e) => setShowSettingPassword(e.target.checked)} style={{ cursor: "pointer" }} />
                      显示密码
                    </label>
                    <button
                      type="button"
                      onClick={() => void submitSetPassword(u.id)}
                      disabled={loading || !settingPasswordValue.trim()}
                      style={{ border: "none", borderRadius: 8, padding: "6px 12px", background: "var(--c-green)", color: "var(--white)", cursor: "pointer" }}
                    >
                      确认
                    </button>
                    <button
                      type="button"
                      onClick={() => { setSettingPasswordFor(null); setSettingPasswordValue(""); setShowSettingPassword(false); }}
                      style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "6px 12px", background: "var(--white)", cursor: "pointer", color: "var(--t-strong)" }}
                    >
                      取消
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
          </>
        )}
      </section>

      {/* 3. 客户管理 */}
      <section id="clients" style={{ ...sectionStyle, display: activeSection === "clients" ? "block" : "none" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{SECTION_LABELS.clients}</h2>
          <button
            type="button"
            onClick={() => void loadClients()}
            disabled={loading}
            style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "6px 12px", background: "var(--white)", cursor: "pointer", color: "var(--t-strong)" }}
          >
            刷新
          </button>
        </div>
        <div style={{ marginBottom: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => { setShowClientModal(true); setEditingClientId(null); setClientForm({ id: "", name: "", companyName: "", phone: "", email: "", password: "", agentId: "" }); }}
            style={{ border: "none", borderRadius: 8, padding: "8px 14px", background: "var(--c-blue)", color: "var(--white)", fontWeight: 600, cursor: "pointer" }}
          >
            创建账号
          </button>

          {/* 客户搜索（2026-08-27 加）：按回车等同于点「搜索」，两种习惯都照顾到 */}
          <input
            type="search"
            value={clientSearchInput}
            onChange={(e) => setClientSearchInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") setClientSearchQuery(clientSearchInput); }}
            placeholder="搜账号 / 名字 / 公司 / 电话 / 邮箱"
            style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 12px", width: 260, marginLeft: "auto" }}
          />
          <button
            type="button"
            onClick={() => setClientSearchQuery(clientSearchInput)}
            style={{ border: "none", borderRadius: 8, padding: "8px 16px", background: "var(--c-blue)", color: "var(--white)", fontWeight: 600, cursor: "pointer" }}
          >
            搜索
          </button>
          {clientSearchQuery ? (
            <button
              type="button"
              onClick={() => { setClientSearchInput(""); setClientSearchQuery(""); }}
              style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 14px", background: "var(--white)", cursor: "pointer", color: "var(--t-strong)" }}
            >
              清空
            </button>
          ) : null}
        </div>

        {/* 搜过之后告诉用户找到几个，找不到时也好判断是没有还是打错了 */}
        {clientSearchQuery ? (
          <div style={{ marginBottom: 12, fontSize: 13, color: "var(--t-muted)" }}>
            搜「{clientSearchQuery}」找到 <strong style={{ color: "var(--t-strong)" }}>{filteredClientList.length}</strong> 个客户（共 {clientList.length} 个）
          </div>
        ) : null}

        {clientList.length === 0 ? (
          <EmptyStateCard title="暂无客户" description="请在上方添加客户。" />
        ) : filteredClientList.length === 0 ? (
          <EmptyStateCard title="没找到匹配的客户" description={`「${clientSearchQuery}」没有匹配到任何客户，换个词试试，或者点「清空」看全部。`} />
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {filteredClientList.map((u) => (
              <div key={u.id} style={{ marginBottom: 8 }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8, ...cardStyle }}>
                  <span><strong>账号</strong> {u.id}</span>
                  <span><strong>客户名字</strong> {u.name}</span>
                  <span><strong>公司名字</strong> {u.companyName ?? "-"}</span>
                  <span><strong>电话</strong> {u.phone}</span>
                  <span><strong>邮箱</strong> {u.email ?? "-"}</span>
                  {/* 2026-09-16 代理账号（确认单 6.3）：所属代理照旧显示 */}
                  <span><strong>所属代理</strong> {u.agentId ? (u.agentName ?? "代理") : "湘泰自己的客户"}</span>
                  {/*
                    2026-09-18 老板拍板：**不再有「客户长期价」**（每个柜价格都不一样，价格在建柜 / 加客户 /
                    改单价时当场填）。所以这里「长期价」那一行和「填/改长期价」按钮都去掉了。
                    后端接口（POST /admin/clients/whr-price）和 client_whr_prices 表都留着，以后要用再开。
                  */}
                  <span><strong>状态</strong> {u.status === "inactive" ? "已封禁" : "正常"}</span>
                  <span style={{ color: "var(--t-strong)", fontSize: 12 }}>{u.createdAt.slice(0, 10)}</span>
                  <button
                    type="button"
                    onClick={() => { setShowSettingPassword(false); setSettingPasswordValue(""); setSettingPasswordFor(settingPasswordFor === u.id ? null : u.id); }}
                    disabled={loading}
                    style={{ border: "1px solid var(--c-green)", color: "var(--c-green)", borderRadius: 8, padding: "6px 10px", background: "#f0fdf4", cursor: "pointer", fontSize: 13 }}
                  >
                    {settingPasswordFor === u.id ? "取消" : "设置密码"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingClientId(u.id);
                      setEditingClientAgentId(u.agentId ?? null);
                      setClientForm({
                        id: u.id,
                        name: u.name,
                        companyName: u.companyName ?? "",
                        phone: u.phone,
                        email: u.email ?? "",
                        password: "",
                        agentId: u.agentId ?? "",
                      });
                      setShowClientModal(true);
                    }}
                    disabled={loading}
                    style={{ border: "1px solid var(--c-amber)", color: "#B45309", borderRadius: 8, padding: "6px 10px", background: "#fffbeb", cursor: "pointer", fontSize: 13 }}
                  >
                    编辑
                  </button>
                  {/* 确认框里报唛头不报名字：同一个名字底下可能有好几个账号（2026-09-19） */}
                  <button
                    type="button"
                    onClick={() => void confirmToggleBan(u.id, u.id, u.status, loadClients, "客户")}
                    disabled={loading}
                    style={{ border: `1px solid ${u.status === "inactive" ? "var(--c-green)" : "#fca5a5"}`, color: u.status === "inactive" ? "var(--c-green)" : "var(--c-red-2)", borderRadius: 8, padding: "6px 10px", background: u.status === "inactive" ? "#f0fdf4" : "#fef2f2", cursor: "pointer", fontSize: 13 }}
                  >
                    {u.status === "inactive" ? "解除封禁" : "封禁"}
                  </button>
                </div>
                {settingPasswordFor === u.id ? (
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--l-soft)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <input
                      type={showSettingPassword ? "text" : "password"}
                      value={settingPasswordValue}
                      onChange={(e) => setSettingPasswordValue(e.target.value)}
                      placeholder="输入新密码"
                      style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "6px 10px", width: 180 }}
                    />
                    <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13, color: "var(--t-strong)", cursor: "pointer", whiteSpace: "nowrap" }}>
                      <input type="checkbox" checked={showSettingPassword} onChange={(e) => setShowSettingPassword(e.target.checked)} style={{ cursor: "pointer" }} />
                      显示密码
                    </label>
                    <button
                      type="button"
                      onClick={() => void submitSetPassword(u.id)}
                      disabled={loading || !settingPasswordValue.trim()}
                      style={{ border: "none", borderRadius: 8, padding: "6px 12px", background: "var(--c-green)", color: "var(--white)", cursor: "pointer" }}
                    >
                      确认
                    </button>
                    <button
                      type="button"
                      onClick={() => { setSettingPasswordFor(null); setSettingPasswordValue(""); setShowSettingPassword(false); }}
                      style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "6px 12px", background: "var(--white)", cursor: "pointer", color: "var(--t-strong)" }}
                    >
                      取消
                    </button>
                  </div>
                ) : null}
                {/* 2026-09-18：长期价的填写表单去掉了（价格改成每个柜当场填），后端接口留着 */}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 4. 运单管理 */}
      <section id="orders" className="shipment-workbench" aria-labelledby="admin-orders-heading" style={{ display: activeSection === "orders" ? "block" : "none" }}>
        <div className="shipment-heading">
          <div>
            <h2 id="admin-orders-heading">{SECTION_LABELS.orders}</h2>
          </div>
          <div className="shipment-primary-actions">
            <button
              type="button"
              onClick={() => setOrdersPanelCollapsed((v) => !v)}
              className="workbench-button"
              aria-expanded={!ordersPanelCollapsed}
              aria-controls="admin-orders-panel"
            >
              {ordersPanelCollapsed ? "展开列表" : "收起列表"}
            </button>
            <button
              type="button"
              onClick={async () => { const clients = await fetchStaffClients(); setStaffClients(clients); setShowCreateOrderModal(true); }}
              className="workbench-button workbench-button--primary"
            >
              创建订单
            </button>
            <button
              type="button"
              onClick={() => setShowBatchImport(true)}
              className="workbench-button"
            >
              批量导入
            </button>
            <button
              type="button"
              onClick={() => void refreshOrderList()}
              disabled={loading || orderRefreshing}
              className="workbench-button"
            >
              {orderRefreshing ? "刷新中…" : "刷新"}
            </button>
          </div>
        </div>
        {/* 顶部一排数字（2026-08-10 用户要三端都有，且「跟员工端一模一样」）。
            用的是员工端同一个接口、同一套口径，三个端对得上数。 */}
        <ShipmentOverviewStrip data={shipmentOverview} />
        {ordersPanelCollapsed && <p className="shipment-scroll-hint">列表已收起，点击「展开列表」继续查看、筛选和导出。</p>}
        <div id="admin-orders-panel" hidden={ordersPanelCollapsed}>
        <ShipmentStatusGroups
          value={shipmentGroup}
          onChange={(group) => {
            setShipmentGroup(group);
            setCurrentPage(1);
            setSelectedOrders(new Set());
          }}
        />
          <ShipmentSearch
            variant="workbench"
            value={orderSearch}
            onChange={(key, val) => {
              /* 换筛选条件必须回到第 1 页（2026-08-31，排查报告第19条）：
                 翻到第 3 页再改条件，新结果只剩 1 页时页面会停在第 3 页，
                 标题写着「共 20 条」表格却一行都没有，像数据丢了。 */
              setCurrentPage(1);
              setSelectedOrders(new Set());
              setOrderSearch((prev) => ({ ...prev, [key]: val }));
            }}
            onSearch={runOrderSearch}
            onReset={() => {
              setCurrentPage(1);
              setSelectedOrders(new Set());
              setOrderSearch({ ...EMPTY_ORDER_SEARCH });
            }}
            warehouseOptions={warehouseOptions}
            logisticsStatusOptions={logisticsStatusOptions}
            inputStyle={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px", fontSize: 13 }}
          />
          <div className="shipment-results" id="admin-order-list-results">
            <div className="shipment-results-meta">
              <span role="status" aria-live="polite">共 <strong>{filteredOrderList.length}</strong> 条 · 第 {currentPage}/{totalPages} 页</span>
              {selectedOrders.size > 0 && (
                <span className="shipment-selection">
                  已选 {selectedResultOrders.length} 条（含其他页）
                  {selectedOrders.size > selectedResultOrders.length && <span>另有 {selectedOrders.size - selectedResultOrders.length} 条不在当前结果里（导出按弹窗里的条件算）</span>}
                  <button type="button" onClick={() => setSelectedOrders(new Set())}>取消选择</button>
                </span>
              )}
            </div>
            <div className="shipment-results-actions">
              <ShipmentExportPanel onOpen={prefillExportFilter}>
                <div className="shipment-export" role="group" aria-label="导出 Excel">
                  <ExportConditionFields
                    value={exportFieldValues}
                    onChange={onExportFieldChange}
                    common={exportCommonFields}
                    more={exportMoreFields}
                    onClear={() => { setOrderExportFeedback(""); setExportGroup("all"); setExportFilter(EMPTY_SHIPMENT_FILTER); }}
                    hint={selectedOrders.size > 0
                      ? `只导出已勾选的 ${selectedOrders.size} 条里符合这些条件的；条件是打开弹窗时从列表带过来的，可以改。`
                      : "按上面的条件导出（打开弹窗时从列表带过来的，可以改）；勾了单子就只导勾的那些。"}
                  />
                  <button type="button" className="workbench-button" disabled={orderExporting || orderExportDateInvalid} aria-describedby="admin-export-note" onClick={() => void handleOrderExport()}>{orderExporting ? "导出中…" : "导出 Excel"}</button>
                  <span className="shipment-export-note" id="admin-export-note">共 {filteredOrderList.length} 条在列表里；导出按弹窗条件另算</span>
                </div>
                {orderExportDateInvalid && <p className="shipment-export-error" role="alert">起始日期晚于截止日期，请调整日期范围。</p>}
                <p role="status" aria-live="polite" aria-atomic="true" style={{ margin: orderExportFeedback ? "12px 0 0" : 0, fontSize: 13 }}>{orderExportFeedback}</p>
              </ShipmentExportPanel>
              <nav className="shipment-pagination" aria-label="运单列表分页">
                <button type="button" className="workbench-button" onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={currentPage <= 1}>上一页</button>
                <span className="shipment-page-number" aria-hidden="true">{currentPage} / {totalPages}</span>
                <button type="button" className="workbench-button" onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage >= totalPages}>下一页</button>
                <label className="shipment-page-size">
                  <span className="workbench-sr-only">每页条数</span>
                  <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setCurrentPage(1); }}>
                    {[20, 50, 100, 200].map((n) => <option key={n} value={n}>{n} 条/页</option>)}
                  </select>
                </label>
              </nav>
            </div>
          </div>
          <p className="shipment-scroll-hint" id="admin-order-scroll-hint">宽表可左右滚动查看完整列；产品超过 3 项时，在产品明细区域上下滚动。调整查询条件会清空勾选并回到第 1 页。</p>
          <div className="shipment-copy-notice" role="status" aria-live="polite" aria-atomic="true">{orderCopyNotice}</div>
        {orderList.length === 0 ? (
          <EmptyStateCard title="暂无运单数据" description="创建订单或刷新后，这里会展示运单记录。" />
        ) : filteredOrderList.length === 0 ? (
          <EmptyStateCard title="没有匹配结果" description="请调整查询条件，或点击「清空条件」重新查看全部运单。" />
        ) : (
          <div className="table-card shipment-table-scroll" tabIndex={0} role="region" aria-label="运单列表，可横向与纵向滚动" aria-describedby="admin-order-scroll-hint">
            <table className="a3-table shipment-ledger-table shipment-ledger-table--admin" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, tableLayout: "fixed", minWidth: ORDER_TABLE_MIN_WIDTH }}>
              <GridColgroup widths={ORDER_COL_WIDTHS} flexIndex={ORDER_FLEX_COL_INDEX} />
              <thead>
                <tr style={{ borderBottom: "2px solid var(--l-cool)", textAlign: "left", background: "var(--s-cool-2)" }}>
                  {/* 产品明细共五列，整块同步滚动 */}
                  <th className="shipment-pin shipment-pin--check" scope="col" style={gridThStyle}>
                    <input type="checkbox" aria-label="选择全部筛选结果（包含其他页）" title="选择全部筛选结果，不限当前页" ref={(node) => { if (node) node.indeterminate = selectedResultOrders.length > 0 && !allResultOrdersSelected; }} checked={allResultOrdersSelected} onChange={toggleSelectAllOrders} style={{ cursor: "pointer" }} />
                  </th>
                  <th className="shipment-pin shipment-pin--mark" scope="col" style={gridThStyle}>唛头</th>
                  <th className="shipment-pin shipment-pin--number" scope="col" style={gridThStyle}>运单号</th>
                  <th scope="col" className="shipment-current-status" style={gridThStyle}>物流状态</th>
                  <th scope="col" style={gridThStyle}>到仓日期</th>
                  <th scope="col" style={gridThStyle}>品名</th>
                  <th scope="col" style={gridThStyle}>箱数</th>
                  <th scope="col" style={gridThStyle}>长宽高(cm)</th>
                  <th scope="col" style={gridThStyle}>国内单号</th>
                  <th scope="col" style={gridThStyle}>货型</th>
                  <th scope="col" className="shipment-metric" style={gridThStyle}>总箱数</th>
                  <th scope="col" className="shipment-metric" style={gridThStyle}>体积 (m³)</th>
                  <th scope="col" className="shipment-metric" style={gridThStyle}>重量 (kg)</th>
                  <th scope="col" style={gridThStyle}>运输方式</th>
                  <th scope="col" style={gridThStyle}>备注</th>
                  <th scope="col" style={gridThStyle}>操作</th>
                </tr>
              </thead>
              <tbody>
                {pagedOrders.map((o) => {
                  const detailRows = buildProductDetailRows(o);
                  const trackingNumber = o.trackingNo;
                  return (
                  <Fragment key={o.id}>
                  <tr data-selected={selectedOrders.has(o.id) || undefined} style={{ borderBottom: "1px solid var(--l-cool)", background: expandedOrderId === o.id ? "var(--c-blue-bg)" : "var(--white)" }}>
                    <td className="shipment-pin shipment-pin--check" style={gridTdStyle}>
                      <input type="checkbox" aria-label={`选择运单 ${o.trackingNo ?? o.id}`} checked={selectedOrders.has(o.id)} onChange={() => toggleSelectOrder(o.id)} style={{ cursor: "pointer" }} />
                    </td>
                    <td className="shipment-pin shipment-pin--mark" style={{ ...gridTdStyle, color: "var(--t-strong)", fontWeight: 600 }}>{o.clientId ?? "—"}</td>
                    <td className="shipment-pin shipment-pin--number" style={gridTdStyle}>
                      {trackingNumber ? <button type="button" className="shipment-copy" title={`点击复制：${trackingNumber}`} aria-label={`复制单号 ${trackingNumber}`} onClick={() => void copyOrderNumber(trackingNumber)}>{trackingNumber}</button> : <span>{trackingNumber ?? "—"}</span>}
                      {/* 明细块只露 3 行，这里写清楚一共几项，免得漏看 */}
                      <div className="shipment-product-count">共 {detailRows.length} 项</div>
                    </td>
                    <td className="shipment-current-status" style={gridTdStyle}>{shipmentStatusWithPartialZh(o.currentStatus, o.partialAhead)}</td>
                    <td style={{ ...gridTdStyle, color: "var(--t-strong)" }}>
                      {o.shipDate ?? o.createdAt.slice(0, 10)}
                    </td>
                    {/* 品名 / 箱数 / 长宽高 / 国内单号 / 货型：合并成一块，固定高度一起滚 */}
                    <ProductListDetailCell rows={detailRows} />
                    {/* 总箱数＝把左边「箱数」那一列加起来，省得多产品时人工心算 */}
                    <td className="shipment-metric" style={{ ...gridTdStyle, fontWeight: 600 }}>
                      {(() => {
                        const total = totalPackageCountOf(o);
                        return total != null ? `${total} 箱` : "—";
                      })()}
                    </td>
                    <td style={gridTdStyle} className="shipment-metric">{formatMetric(totalVolumeOf(o), 3)}</td>
                    <td style={gridTdStyle} className="shipment-metric">{formatMetric(totalWeightOf(o), 2)}</td>
                    <td style={gridTdStyle}>{transportModeLabel(o.transportMode)}</td>
                    <td style={{ ...gridTdStyle, fontSize: 12 }} title={o.remark || ""}>{o.remark || ""}</td>
                    <td style={gridTdStyle}>
                      <button
                        type="button"
                        onClick={() => {
                          setExpandedOrderId((prev) => {
                            if (prev === o.id) return "";
                            const oid = o.orderId ?? o.id;
                            fetchShipmentImages(oid).then((imgs: any) => {
                              setOrderImagesCache((c: any) => ({ ...c, [oid]: imgs }));
                            }).catch(() => {});
                            return o.id;
                          });
                        }}
                        className="row-act"
                      >
                        详情
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (editingOrderId === (o.orderId ?? o.id)) {
                            setEditingOrderId("");
                          } else {
                            startEditOrder(o);
                          }
                        }}
                        className="row-act"
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          if (!confirm(`确定删除运单 ${o.trackingNo ?? "—"}（${o.itemName ?? ""}）？\n\n此操作不可撤销，将级联删除运单、状态日志、产品行等所有关联数据。`)) return;
                          try {
                            await deleteAdminOrder(o.orderId ?? o.id);
                            setToast(`已删除：${o.trackingNo ?? o.itemName ?? "—"}`);
                            await loadOrders();
                          } catch (err) {
                            setMessage(`删除失败：${err instanceof Error ? err.message : "未知错误"}`);
                          }
                        }}
                        style={{ border: "1px solid #fecaca", borderRadius: 8, padding: "4px 10px", background: "#fef2f2", color: "var(--c-red-2)", cursor: "pointer", fontWeight: 700 }}
                      >
                        删除
                      </button>
                      <button
                        type="button"
                        onClick={() => openShipmentTrack(o.trackingNo ? { trackingNo: o.trackingNo } : { shipmentId: o.id })}
                        className="row-act"
                      >
                        物流轨迹
                      </button>
                      <button
                        type="button"
                        onClick={() => openPrintLabel({ marks: o.clientId ?? "—", packageCount: o.packageCount ?? "—", trackingNo: o.trackingNo ?? "", itemName: o.itemName, productQuantity: o.productQuantity, transportMode: o.transportMode, products: (o.products ?? []).map(p => ({ itemName: p.itemName, packageCount: p.packageCount })) })}
                        className="row-act"
                      >
                        打印
                      </button>

                    </td>
                  </tr>
                  {expandedOrderId === o.id ? (
                    <tr>
                      {/* 详情改成全屏弹窗：格子只作挂载点，内容用 position:fixed 铺满屏幕，
                          所以这一行不占高度，表格不会被撑开 */}
                      <td colSpan={ORDER_COL_WIDTHS.length} style={{ padding: 0, border: "none" }}>
                        <DetailModal
                          title="运单详情"
                          subtitle={o.trackingNo ?? o.orderNo ?? "—"}
                          onClose={() => setExpandedOrderId("")}
                        >
                        <div>
                          <AdminShipmentDetail
                            order={o}
                            warehouseLabel={warehouseOptions.find(w => w.id === o.warehouseId)?.label ?? warehouseLabelFromId(o.warehouseId)}
                          />
                          {(o.productImages?.length ?? 0) > 0 || (orderImagesCache[o.orderId ?? o.id]?.length ?? 0) > 0 ? (
                            <div style={{ marginBottom: 10, padding: 10, background: "var(--s-cool)", borderRadius: 8, border: "1px solid var(--l-cool)" }}>
                              <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13, color: "var(--t-strong)" }}>产品图</div>
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                                {(orderImagesCache[o.orderId ?? o.id] ?? o.productImages ?? []).map((img: any) => (
                                  <div key={img.id} style={{ position: "relative" }}>
                                    <img src={img.imageUrl ? `${apiBaseUrl()}${img.imageUrl}` : ""} alt={img.fileName} style={{ width: 88, height: 88, objectFit: "cover", borderRadius: 8, border: "1px solid var(--l-soft)" }} />
                                    <button type="button" onClick={async () => { await deleteStaffOrderProductImage(img.id); const oid = o.orderId ?? o.id; const imgs = await fetchShipmentImages(oid); setOrderImagesCache((c) => ({ ...c, [oid]: imgs })); }} style={{ position: "absolute", top: -4, right: -4, width: 18, height: 18, borderRadius: "50%", background: "var(--c-red-2)", color: "var(--white)", border: "none", cursor: "pointer", fontSize: 11, lineHeight: 1 }}>×</button>
                                  </div>
                                ))}
                              </div>
                              <div style={{ marginTop: 8 }}>
                                <input aria-label="上传产品图片" type="file" accept="image/*" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; const oid = o.orderId ?? o.id; try { const toBase64 = (file: File) => new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onloadend = () => resolve((r.result as string).split(",")[1]); r.onerror = () => reject(new Error("文件读取失败")); r.readAsDataURL(file); }); const base64 = await toBase64(f); await uploadStaffOrderProductImage({ orderId: oid, fileName: f.name, mime: f.type, contentBase64: base64 }); const imgs = await fetchShipmentImages(oid); setOrderImagesCache((c) => ({ ...c, [oid]: imgs })); setToast("产品图已上传"); } catch (err) { setMessage("上传失败：" + (err instanceof Error ? err.message : "未知错误")); } }} style={{ fontSize: 12 }} />
                              </div>
                            </div>
                          ) : (
                            <div style={{ marginBottom: 10 }}>
                              <h3 style={{ margin: "0 0 8px", fontSize: 14, fontWeight: 600 }}>产品图片</h3>
                              <p style={{ margin: "0 0 10px", fontSize: 13, color: "var(--t-muted)" }}>暂无产品图片</p>
                              <input aria-label="上传产品图片" type="file" accept="image/*" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; const oid = o.orderId ?? o.id; try { const toBase64 = (file: File) => new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onloadend = () => resolve((r.result as string).split(",")[1]); r.onerror = () => reject(new Error("文件读取失败")); r.readAsDataURL(file); }); const base64 = await toBase64(f); await uploadStaffOrderProductImage({ orderId: oid, fileName: f.name, mime: f.type, contentBase64: base64 }); const imgs = await fetchShipmentImages(oid); setOrderImagesCache((c) => ({ ...c, [oid]: imgs })); setToast("产品图已上传"); } catch (err) { setMessage("上传失败：" + (err instanceof Error ? err.message : "未知错误")); } }} style={{ fontSize: 12, color: "var(--c-blue)" }} />
                            </div>
                          )}
                        </div>
                        </DetailModal>
                      </td>
                    </tr>
                  ) : null}
                  {editingOrderId === (o.orderId ?? o.id) ? (
                    <tr key={`edit-${o.id}`}>
                      {/* 编辑表单同样改成全屏弹窗；格子只作挂载点，不占高度 */}
                      <td colSpan={ORDER_COL_WIDTHS.length} style={{ padding: 0, border: "none" }}>
                        <DetailModal
                          title="编辑运单"
                          subtitle={o.trackingNo ?? o.orderNo ?? "—"}
                          onClose={() => setEditingOrderId("")}
                          closeOnEsc={false}
                        >
                        <div style={{ display: "grid", gap: 8 }}>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
                            <input value={orderEditForm.clientId} onChange={(e) => setOrderEditForm((v) => ({ ...v, clientId: e.target.value }))} placeholder="唛头" list="admin-client-options" autoComplete="off" style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px" }} />
                            <datalist id="admin-client-options">{clientList.map((c) => (<option key={c.id} value={c.id}>{c.id}</option>))}</datalist>
                            <input value={orderEditForm.trackingNo} onChange={(e) => setOrderEditForm((v) => ({ ...v, trackingNo: e.target.value.toUpperCase() }))} placeholder="运单号" style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px" }} />
                            <input value={orderEditForm.batchNo} onChange={(e) => setOrderEditForm((v) => ({ ...v, batchNo: e.target.value }))} placeholder="柜号" style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px" }} />
                            <select value={orderEditForm.warehouseId} onChange={(e) => setOrderEditForm((v) => ({ ...v, warehouseId: e.target.value }))} style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px" }}><option value="wh_yiwu_01">义乌仓</option><option value="wh_guangzhou_01">广州仓</option><option value="wh_dongguan_01">东莞仓</option><option value="wh_shenzhen_01">深圳仓</option></select>
                            <select value={orderEditForm.transportMode} onChange={(e) => setOrderEditForm((v) => ({ ...v, transportMode: e.target.value as "sea" | "land" }))} style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px" }}><option value="sea">海运</option><option value="land">陆运</option></select>
                            <input value={orderEditForm.domesticTrackingNo} onChange={(e) => setOrderEditForm((v) => ({ ...v, domesticTrackingNo: e.target.value }))} placeholder="货拉拉" style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px" }} />
                            <input value={orderEditForm.receiverAddressTh} onChange={(e) => setOrderEditForm((v) => ({ ...v, receiverAddressTh: e.target.value }))} placeholder="收货地址" style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px" }} />
                            <input value={orderEditForm.containerNo} onChange={(e) => setOrderEditForm((v) => ({ ...v, containerNo: e.target.value }))} placeholder="装柜号" style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px" }} />
                            <select value={orderEditForm.packageUnit} onChange={(e) => setOrderEditForm((v) => ({ ...v, packageUnit: e.target.value as "bag" | "box" }))} style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px" }}><option value="box">箱</option><option value="bag">袋</option></select>
                            <input value={orderEditForm.weightKg} onChange={(e) => setOrderEditForm((v) => ({ ...v, weightKg: e.target.value }))} placeholder="重量(kg)" style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px" }} />
                            <input value={orderEditForm.volumeM3} onChange={(e) => setOrderEditForm((v) => ({ ...v, volumeM3: e.target.value }))} placeholder="体积(m³)" style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px" }} />
                            <input type="date" value={orderEditForm.shipDate} onChange={(e) => setOrderEditForm((v) => ({ ...v, shipDate: e.target.value }))} style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px" }} />
                          </div>
                          {/* 手填总重量/总体积和产品行自动计算冲突时，当场说清保存后哪边生效
                              （2026-08-31，排查报告第22条：原来静默扔掉手填值，没人察觉） */}
                          {editTotalsPreview.notes.length > 0 && (
                            <div style={{ fontSize: 12, color: "var(--c-red-deep)", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, padding: "6px 10px" }}>
                              {editTotalsPreview.notes.map((n, i) => (<div key={i}>{n}</div>))}
                            </div>
                          )}
                          <div style={{ border: "1px solid var(--l-soft)", borderRadius: 8, padding: 10, background: "var(--s-alt)", marginTop: 8 }}>
                            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, color: "var(--t-strong)" }}>产品行编辑</div>
                            {editProducts.length === 0 && (
                              <div style={{ fontSize: 12, color: "var(--t-faint)", padding: "4px 0" }}>无产品行，点击下方按钮添加</div>
                            )}
                            {editProducts.map((p, i) => (
                              <div key={i} style={{ display: "grid", gridTemplateColumns: "2fr 0.4fr 0.3fr 0.3fr 0.3fr 0.4fr 0.45fr 0.8fr 1fr auto", gap: 4, marginBottom: 4, alignItems: "center" }}>
                                <input value={p.itemName} onChange={(e) => { const n = [...editProducts]; n[i] = { ...n[i], itemName: e.target.value }; setEditProducts(n); }} placeholder="品名" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
                                <input type="number" value={p.packageCount} onChange={(e) => { const n = [...editProducts]; n[i] = { ...n[i], packageCount: e.target.value }; setEditProducts(n); }} placeholder="箱数" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
                                <input type="number" step="0.01" value={p.lengthCm} onChange={(e) => { const n = [...editProducts]; n[i] = { ...n[i], lengthCm: e.target.value }; setEditProducts(n); }} placeholder="长cm" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
                                <input type="number" step="0.01" value={p.widthCm} onChange={(e) => { const n = [...editProducts]; n[i] = { ...n[i], widthCm: e.target.value }; setEditProducts(n); }} placeholder="宽cm" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
                                <input type="number" step="0.01" value={p.heightCm} onChange={(e) => { const n = [...editProducts]; n[i] = { ...n[i], heightCm: e.target.value }; setEditProducts(n); }} placeholder="高cm" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
                                <input type="number" value={p.productQuantity} onChange={(e) => { const n = [...editProducts]; n[i] = { ...n[i], productQuantity: e.target.value }; setEditProducts(n); }} placeholder="单箱数量" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
                                <input type="number" step="0.01" value={p.weightKg} onChange={(e) => { const n = [...editProducts]; n[i] = { ...n[i], weightKg: e.target.value }; setEditProducts(n); }} placeholder="单箱重kg" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
                                <select value={(p.cargoType || "normal").toLowerCase()} onChange={(e) => { const n = [...editProducts]; n[i] = { ...n[i], cargoType: e.target.value }; setEditProducts(n); }} style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "4px 6px", fontSize: 12, background: "var(--white)" }}>
                                  <option value="normal">普货</option>
                                  <option value="inspection">商检货</option>
                                  <option value="sensitive">敏感货</option>
                                </select>
                                <input value={p.domesticTrackingNo || ""} onChange={(e) => { const n = [...editProducts]; n[i] = { ...n[i], domesticTrackingNo: e.target.value }; setEditProducts(n); }} placeholder="货拉拉" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
                                <button type="button" onClick={() => setEditProducts((v) => v.filter((_, j) => j !== i))} style={{ border: "1px solid #fca5a5", borderRadius: 4, padding: "4px 6px", fontSize: 11, background: "var(--white)", color: "var(--c-red-2)", cursor: "pointer" }}>X</button>
                              </div>
                            ))}
                            <button type="button" onClick={() => setEditProducts((v) => [...v, { itemName: "", packageCount: "", lengthCm: "", widthCm: "", heightCm: "", productQuantity: "", weightKg: "", cargoType: "normal", domesticTrackingNo: "" }])} style={{ border: "1px dashed var(--c-blue)", borderRadius: 4, padding: "4px 10px", fontSize: 12, background: "var(--white)", color: "var(--c-blue)", cursor: "pointer", marginTop: 4 }}>+ 添加产品</button>
                          </div>
                          {(o.productImages?.length ?? 0) > 0 && (
                            <div style={{ marginTop: 8, padding: 10, background: "var(--s-cool)", borderRadius: 8, border: "1px solid var(--l-cool)" }}>
                              <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13, color: "var(--t-strong)" }}>产品图</div>
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                                {o.productImages!.map((img) => (
                                  <img key={img.id} src={img.imageUrl ? `${apiBaseUrl()}${img.imageUrl}` : ""} alt={img.fileName} style={{ width: 88, height: 88, objectFit: "cover", borderRadius: 8, border: "1px solid var(--l-soft)" }} />
                                ))}
                              </div>
                            </div>
                          )}
                          <div style={{ marginBottom: 12 }}>
                            <div style={{ fontSize: 12, color: "var(--t-strong)", marginBottom: 4 }}>备注</div>
                            <input value={orderEditForm.remark} onChange={(e) => setOrderEditForm((v) => ({ ...v, remark: e.target.value }))} placeholder="备注（可选）" style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px", width: "100%", fontSize: 13 }} />
                          </div>

                          <div style={{ display: "flex", gap: 8 }}>
                            <button type="button" onClick={() => void submitOrderEdit()} disabled={loading} style={{ border: "none", borderRadius: 6, padding: "9px 18px", color: "var(--white)", background: "var(--c-navy)", cursor: "pointer", fontWeight: 600 }}>保存</button>
                            <button type="button" onClick={() => setEditingOrderId("")} style={{ border: "1px solid #d8d6d1", borderRadius: 6, padding: "9px 18px", background: "var(--white)", cursor: "pointer", color: "#14171D" }}>取消</button>
                          </div>
                        </div>
                        </DetailModal>
                      </td>
                    </tr>
                  ) : null}
                  </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        </div>
      </section>

      {/* 入库与标签工具 */}
      <section id="ops-tools" style={{ ...sectionStyle, display: activeSection === "ops-tools" ? "block" : "none" }}>
        <h2 style={{ margin: "0 0 16px", fontSize: 18 }}>{SECTION_LABELS["ops-tools"]}</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16 }}>
          <div style={{ padding: 16, background: "var(--s-cool)", borderRadius: 8, border: "1px solid var(--l-cool)" }}>
            <h4 style={{ margin: "0 0 12px", fontSize: 14 }}>体积重量核算</h4>
            <div style={{ display: "grid", gap: 8 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input value={calcLength} onChange={(e) => setCalcLength(e.target.value)} placeholder="长(cm)" style={prealertEditInputStyle} />
                <span style={{ color: "var(--t-strong)" }}>×</span>
                <input value={calcWidth} onChange={(e) => setCalcWidth(e.target.value)} placeholder="宽(cm)" style={prealertEditInputStyle} />
                <span style={{ color: "var(--t-strong)" }}>×</span>
                <input value={calcHeight} onChange={(e) => setCalcHeight(e.target.value)} placeholder="高(cm)" style={prealertEditInputStyle} />
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: 12, minWidth: 60 }}>数量：</span>
                <input type="number" value={calcQty} onChange={(e) => setCalcQty(e.target.value)} style={{ ...prealertEditInputStyle, width: 80 }} />
                <span style={{ fontSize: 12, color: "var(--t-strong)" }}>箱</span>
                <button onClick={() => {
                  const l = Number(calcLength); const w = Number(calcWidth); const h = Number(calcHeight); const q = Number(calcQty);
                  if (!l || !w || !h) { setCalcResult("请填写长宽高"); return; }
                  const volM3 = (l * w * h * q) / 1_000_000;
                  const weightEst = volM3 * 167;
                  setCalcResult(`${volM3.toFixed(3)} m³（≈ ${weightEst.toFixed(2)} kg）`);
                }} style={{ border: "none", borderRadius: 6, padding: "6px 12px", background: "var(--c-blue)", color: "var(--white)", cursor: "pointer", fontSize: 12 }}>计算</button>
              </div>
              {calcResult && <div style={{ fontSize: 14, fontWeight: 600, color: "var(--c-green-3)" }}>{calcResult}</div>}
            </div>
          </div>
          <div style={{ padding: 16, background: "var(--s-cool)", borderRadius: 8, border: "1px solid var(--l-cool)" }}>
            <h4 style={{ margin: "0 0 12px", fontSize: 14 }}>标签打印</h4>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <p style={{ fontSize: 12, color: "var(--t-strong)", margin: 0 }}>在运单管理列表中点击「打印」按钮即可打印 FBA 标签 / 面单 / 箱号条码。</p>
              <p style={{ fontSize: 12, color: "var(--t-strong)", margin: 0 }}>支持：唛头、运单号、品名、箱数、运输方式等信息一键打印。</p>
            </div>
          </div>
        </div>
      </section>

      {/* 尾端派送 */}
      <section
        id="lastmile"
        className="lastmile-admin-section"
        style={{ ...sectionStyle, display: activeSection === "lastmile" ? "block" : "none" }}
      >
        <header className="lastmile-page-heading">
          <div>
            <span className="lastmile-eyebrow">尾端运营</span>
            <h2>{SECTION_LABELS.lastmile}</h2>
            <p>派送作业按 WD 管理；一张 WD 代表一辆车的一趟路线，可包含多个客户和多个地址。</p>
          </div>
        </header>

          <LastmileDispatchWorkspace
            /* 撤销误签收只开给管理端（2026-09-11） */
            canUnsign
            id="admin-lastmile-dispatch"
            surface="embedded"
            showHeading={false}
            lmShipments={lmShipments}
            lmOrderList={lmOrders}
            ordersLoading={lmOrdersLoading}
            ordersError={lmOrdersError}
            shipmentsLoading={lmShipmentsLoading}
            shipmentsError={lmShipmentsError}
            onToast={setToast}
            onReloadOrders={loadLastmileOrders}
            onLoadShipments={loadLmShipments}
          />
      </section>

      {/* 尾端地址 */}
      <section id="lastmile-address" style={{ ...sectionStyle, display: activeSection === "lastmile-address" ? "block" : "none" }}>
        <h2 style={{ margin: "0 0 16px", fontSize: 18 }}>尾端地址</h2>
        <p style={{ fontSize: 13, color: "var(--t-muted)", marginBottom: 12 }}>客户端注册后自动同步唛头与派送地址。</p>
        {/*
          2026-08-29 补上。这一页原来**只有上面这个标题和这句话** ——
          0 个按钮、0 个输入框、0 个表格（在页面上实测确认过），
          点进来什么都没有，看着像系统坏了。功能一直只在员工端有。
          用的是跟员工端同一个组件，不是另抄一份。
        */}
        {/* ⚠️ 故意**不传** onToast：管理员端那个全局 message 渲染在页面最底部
            （admin/page.tsx 约 2423 行），离这一块很远，报错了容易看不见。
            不传的话面板会把提示显示在自己上方，就在操作的地方。 */}
        <LastmileAddressPanel />
      </section>

      {/* 充值审核 */}
      <section id="wallet-recharges" style={{ ...sectionStyle, display: activeSection === "wallet-recharges" ? "block" : "none" }}>
        <h2 style={{ margin: "0 0 16px", fontSize: 18 }}>{SECTION_LABELS["wallet-recharges"]}</h2>
        {/* 状态筛选 */}
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          {["", "PENDING", "APPROVED", "REJECTED"].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setRechargeStatusFilter(s)}
              style={{
                border: rechargeStatusFilter === s ? "2px solid var(--c-blue)" : "1px solid var(--l-strong)",
                borderRadius: 8,
                padding: "6px 14px",
                background: rechargeStatusFilter === s ? "var(--c-blue-bg)" : "var(--white)",
                color: rechargeStatusFilter === s ? "var(--c-blue)" : "var(--t-body)",
                fontWeight: 600,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              {s === "" ? "全部" : s === "PENDING" ? "待审核" : s === "APPROVED" ? "已通过" : "已拒绝"}
            </button>
          ))}
        </div>
        {rechargeList.length === 0 ? (
          <p style={{ color: "var(--t-muted)", fontSize: 13 }}>暂无充值申请</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "var(--s-alt)", borderBottom: "1px solid var(--l-soft)" }}>
                  <th style={{ padding: "8px 10px", textAlign: "left", fontWeight: 600, color: "var(--t-body)", whiteSpace: "nowrap" }}>时间</th>
                  <th style={{ padding: "8px 10px", textAlign: "left", fontWeight: 600, color: "var(--t-body)", whiteSpace: "nowrap" }}>客户</th>
                  <th style={{ padding: "8px 10px", textAlign: "right", fontWeight: 600, color: "var(--t-body)", whiteSpace: "nowrap" }}>金额</th>
                  <th style={{ padding: "8px 10px", textAlign: "left", fontWeight: 600, color: "var(--t-body)", whiteSpace: "nowrap" }}>支付方式</th>
                  <th style={{ padding: "8px 10px", textAlign: "left", fontWeight: 600, color: "var(--t-body)", whiteSpace: "nowrap" }}>状态</th>
                  <th style={{ padding: "8px 10px", textAlign: "left", fontWeight: 600, color: "var(--t-body)", whiteSpace: "nowrap" }}>凭证</th>
                  <th style={{ padding: "8px 10px", textAlign: "left", fontWeight: 600, color: "var(--t-body)", whiteSpace: "nowrap" }}>备注</th>
                  <th style={{ padding: "8px 10px", textAlign: "left", fontWeight: 600, color: "var(--t-body)", whiteSpace: "nowrap" }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {rechargeList.map((r) => {
                  const methodLabel = r.paymentMethod === "WECHAT" ? "微信" : r.paymentMethod === "ALIPAY" ? "支付宝" : "银行转账";
                  const statusLabel = r.status === "PENDING" ? "待审核" : r.status === "APPROVED" ? "已通过" : "已拒绝";
                  const statusColor =
                    r.status === "PENDING" ? { bg: "var(--c-amber-bg)", text: "var(--c-amber-deep)" } :
                    r.status === "APPROVED" ? { bg: "var(--c-green-bg)", text: "var(--c-green-deep)" } :
                    { bg: "var(--c-red-bg)", text: "var(--c-red-dark)" };
                  return (
                    <tr key={r.id} style={{ borderBottom: "1px solid var(--s-sunken)" }}>
                      <td style={{ padding: "8px 10px", whiteSpace: "nowrap", fontSize: 12 }}>
                        {new Date(r.createdAt).toLocaleString("zh-CN", {
                          month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
                        })}
                      </td>
                      <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>{r.clientId}{r.companyName ? ` (${r.companyName})` : ""}</td>
                      <td style={{ padding: "8px 10px", textAlign: "right", fontWeight: 600 }}>
                        ¥{r.amount.toFixed(2)}
                      </td>
                      <td style={{ padding: "8px 10px" }}>{methodLabel}</td>
                      <td style={{ padding: "8px 10px" }}>
                        <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 10, fontSize: 12, background: statusColor.bg, color: statusColor.text }}>
                          {statusLabel}
                        </span>
                      </td>
                      <td style={{ padding: "8px 10px" }}>
                        <img
                          src={r.proofImage}
                          alt="付款凭证"
                          onClick={() => {
                            const w = window.open("", "_blank");
                            // ⚠️ 不能用 document.write 拼字符串（2026-08-28 改）。
                            // 凭证是客户自己填的，拼进 HTML 等于让客户在管理员浏览器里执行脚本
                            // （能读走登录令牌）。改用 DOM 接口设 src，内容只会被当成网址。
                            if (!w) return;
                            const img = w.document.createElement("img");
                            img.src = r.proofImage;
                            img.alt = "付款凭证";
                            img.style.maxWidth = "100%";
                            w.document.body.appendChild(img);
                          }}
                          style={{ width: 60, height: 60, objectFit: "cover", borderRadius: 6, border: "1px solid var(--l-soft)", cursor: "pointer" }}
                        />
                      </td>
                      <td style={{ padding: "8px 10px", maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, color: "var(--t-muted)" }}>
                        {r.reviewRemark || r.remark || "—"}
                      </td>
                      <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>
                        {r.status === "PENDING" ? (
                          <div style={{ display: "flex", gap: 4 }}>
                            <button
                              type="button"
                              disabled={loading}
                              onClick={async () => {
                                if (!window.confirm(`确认通过 ${r.clientId} 的 ¥${r.amount} 集货余额充值？\n\n通过后钱立刻进入他的集货余额。`)) return;
                                setLoading(true);
                                try {
                                  await approveRecharge(r.id);
                                  setToast("充值已通过");
                                  await loadRecharges();
                                } catch (e: any) { setToast(e.message ?? "操作失败"); }
                                finally { setLoading(false); }
                              }}
                              style={{ border: "none", borderRadius: 6, padding: "4px 10px", background: "var(--c-green-3)", color: "var(--white)", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
                            >
                              通过
                            </button>
                            <button
                              type="button"
                              onClick={() => { setRejectModalId(r.id); setRejectRemark(""); }}
                              style={{ border: "none", borderRadius: 6, padding: "4px 10px", background: "var(--c-red-2)", color: "var(--white)", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
                            >
                              拒绝
                            </button>
                          </div>
                        ) : (
                          <span style={{ fontSize: 12, color: "var(--t-muted)" }}>
                            {r.reviewerName ? `审核人：${r.reviewerName}` : "—"}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 拒绝原因弹窗 */}
      {rejectModalId && (
        <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)", padding: 16 }}>
          <div style={{ width: "100%", maxWidth: 400, background: "var(--white)", borderRadius: 12, padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
            <h3 style={{ margin: "0 0 16px", fontSize: 16 }}>拒绝原因</h3>
            <textarea
              placeholder="请填写拒绝原因"
              value={rejectRemark}
              onChange={(e) => setRejectRemark(e.target.value)}
              rows={3}
              style={{ width: "100%", padding: "10px", border: "1px solid var(--l-strong)", borderRadius: 8, fontSize: 14, boxSizing: "border-box", resize: "vertical" }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button
                type="button"
                onClick={() => setRejectModalId(null)}
                style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 16px", background: "var(--white)", cursor: "pointer", fontSize: 13 }}
              >
                取消
              </button>
              <button
                type="button"
                disabled={loading || !rejectRemark.trim()}
                onClick={async () => {
                  if (!rejectRemark.trim()) return;
                  setLoading(true);
                  try {
                    await rejectRecharge(rejectModalId, rejectRemark.trim());
                    setToast("已拒绝");
                    setRejectModalId(null);
                    await loadRecharges();
                  } catch (e: any) { setToast(e.message ?? "操作失败"); }
                  finally { setLoading(false); }
                }}
                style={{ border: "none", borderRadius: 8, padding: "8px 16px", background: "var(--c-red-2)", color: "var(--white)", fontWeight: 600, cursor: "pointer", fontSize: 13 }}
              >
                确认拒绝
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 线下付款拒绝原因弹窗 */}
      <section id="ai-memory" style={{ ...sectionStyle, display: activeSection === "ai-memory" ? "block" : "none" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{SECTION_LABELS["ai-memory"]}</h2>
          {/* 这里原来错贴了一个运单编辑的「备注」输入框（2026-08-31 删，排查报告第45条）：
              在这打字会写进 orderEditForm，极端操作下会存成别的运单的备注。 */}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={() => void loadSessionMemory()}
              disabled={loading}
              style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "6px 12px", background: "var(--white)", cursor: "pointer", color: "var(--t-strong)" }}
            >
              刷新
            </button>
            <button
              type="button"
              onClick={() => void clearSessionMemory()}
              disabled={loading}
              style={{ border: "1px solid var(--c-red-2)", color: "var(--c-red-2)", borderRadius: 8, padding: "6px 12px", background: "#fef2f2", cursor: "pointer", fontWeight: 600 }}
            >
              一键清理
            </button>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8, marginBottom: 10 }}>
          <input
            value={memoryFilterSessionId}
            onChange={(e) => setMemoryFilterSessionId(e.target.value)}
            placeholder="按会话ID清理（选填）"
            style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px", width: "100%" }}
          />
          <input
            value={memoryFilterUserId}
            onChange={(e) => setMemoryFilterUserId(e.target.value)}
            placeholder="按用户ID清理（选填）"
            style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px", width: "100%" }}
          />
        </div>
        {sessionMemoryList.length === 0 ? (
          <EmptyStateCard title="暂无会话记忆" description="当前没有可排查的 AI 会话记忆记录。" />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "2px solid var(--l-cool)", textAlign: "left" }}>
                  <th style={{ padding: "8px 6px" }}>会话ID</th>
                  <th style={{ padding: "8px 6px" }}>用户ID</th>
                  <th style={{ padding: "8px 6px" }}>意图</th>
                  <th style={{ padding: "8px 6px" }}>品名</th>
                  <th style={{ padding: "8px 6px" }}>状态</th>
                  <th style={{ padding: "8px 6px" }}>时间范围</th>
                  <th style={{ padding: "8px 6px" }}>指标</th>
                  <th style={{ padding: "8px 6px" }}>更新时间</th>
                </tr>
              </thead>
              <tbody>
                {sessionMemoryList.map((row) => (
                  <tr key={row.key} style={{ borderBottom: "1px solid var(--l-cool)" }}>
                    <td style={{ padding: "8px 6px" }}>{row.sessionId}</td>
                    <td style={{ padding: "8px 6px" }}>{row.userId}</td>
                    <td style={{ padding: "8px 6px" }}>{row.intent ?? "-"}</td>
                    <td style={{ padding: "8px 6px" }}>{row.itemName ?? "-"}</td>
                    <td style={{ padding: "8px 6px" }}>{row.statusScope ?? "-"}</td>
                    <td style={{ padding: "8px 6px" }}>{row.timeHint ?? "-"}</td>
                    <td style={{ padding: "8px 6px" }}>{row.metric ?? "-"}</td>
                    <td style={{ padding: "8px 6px", color: "var(--t-strong)" }}>{row.updatedAt.slice(0, 16)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 6. AI待补知识问题 */}
      <section
        id="ai-knowledge-gaps"
        style={{ ...sectionStyle, display: activeSection === "ai-knowledge-gaps" ? "block" : "none" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{SECTION_LABELS["ai-knowledge-gaps"]}</h2>
          {/* 同 ai-memory：错贴的「备注」输入框已删（2026-08-31，排查报告第45条） */}
          <div style={{ display: "flex", gap: 8 }}>
            <select
              value={knowledgeGapStatus}
              onChange={(e) => setKnowledgeGapStatus(e.target.value as "open" | "resolved")}
              style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "6px 10px", background: "var(--white)" }}
            >
              <option value="open">仅看待处理</option>
              <option value="resolved">仅看已处理</option>
            </select>
            <button
              type="button"
              onClick={() => void loadKnowledgeGaps()}
              disabled={loading}
              style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "6px 12px", background: "var(--white)", cursor: "pointer", color: "var(--t-strong)" }}
            >
              刷新
            </button>
          </div>
        </div>
        {knowledgeGapList.length === 0 ? (
          <EmptyStateCard title="暂无待补问题" description="当 AI 遇到知识不足时，会自动汇总到这里供管理员补知识。" />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "2px solid var(--l-cool)", textAlign: "left" }}>
                  <th style={{ padding: "8px 6px" }}>提问时间</th>
                  <th style={{ padding: "8px 6px" }}>用户ID</th>
                  <th style={{ padding: "8px 6px" }}>问题</th>
                  <th style={{ padding: "8px 6px" }}>当时知识条数</th>
                  <th style={{ padding: "8px 6px" }}>状态</th>
                  <th style={{ padding: "8px 6px" }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {knowledgeGapList.map((item) => (
                  <tr key={item.id} style={{ borderBottom: "1px solid var(--l-cool)" }}>
                    <td style={{ padding: "8px 6px", color: "var(--t-strong)" }}>{item.createdAt.slice(0, 16)}</td>
                    <td style={{ padding: "8px 6px" }}>{item.userId}</td>
                    <td style={{ padding: "8px 6px", whiteSpace: "pre-wrap" }}>{item.question}</td>
                    <td style={{ padding: "8px 6px" }}>{item.knowledgeCountAtAsk}</td>
                    <td style={{ padding: "8px 6px" }}>{item.status === "open" ? "待处理" : "已处理"}</td>
                    <td style={{ padding: "8px 6px" }}>
                      {item.status === "open" ? (
                        <button
                          type="button"
                          onClick={() => void resolveKnowledgeGap(item.id)}
                          disabled={loading}
                          style={{ border: "1px solid var(--c-green)", color: "var(--c-green)", borderRadius: 8, padding: "6px 10px", background: "#ecfdf5", cursor: "pointer" }}
                        >
                          标记已处理
                        </button>
                      ) : (
                        <span style={{ color: "var(--t-strong)" }}>{item.resolvedBy ? `已由 ${item.resolvedBy} 处理` : "已处理"}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 7. AI知识投喂 */}
      <section id="knowledge-feed" style={{ ...sectionStyle, display: activeSection === "knowledge-feed" ? "block" : "none" }}>
        <h2 style={{ marginTop: 0, marginBottom: 12, fontSize: 18 }}>{SECTION_LABELS["knowledge-feed"]}</h2>
        <p style={{ color: "var(--t-strong)", marginBottom: 12, fontSize: 14 }}>
          填写业务规则、时效说明、清关说明等内容，AI 会作为上下文参考。
        </p>
        <div style={{ display: "grid", gap: 8, maxWidth: 720 }}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="知识标题（例如：海运时效说明）"
            style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px" }}
          />
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="知识内容（支持长文本）"
            rows={5}
            style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px", resize: "vertical" }}
          />
        </div>
        <div style={{ marginTop: 12 }}>
          <button
            type="button"
            onClick={() => void submitKnowledge()}
            disabled={loading}
            style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "var(--white)", background: "var(--c-green)", cursor: "pointer" }}
          >
            提交知识
          </button>
        </div>
      </section>

      {/* 8. 已投喂的知识列表 */}
      <section id="knowledge-list" style={{ ...sectionStyle, display: activeSection === "knowledge-list" ? "block" : "none" }}>
        <h2 style={{ marginTop: 0, marginBottom: 12, fontSize: 18 }}>{SECTION_LABELS["knowledge-list"]}</h2>
        {knowledgeItems.length === 0 ? (
          <EmptyStateCard title="暂无知识条目" description="可先投喂运输时效、清关规则等内容，让 AI 回答更专业。" />
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {knowledgeItems.map((item) => (
              <div key={item.id} style={{ border: "1px solid var(--l-soft)", borderRadius: 10, padding: 12 }}>
                <div style={{ fontWeight: 600 }}>{item.title}</div>
                <div style={{ marginTop: 6, whiteSpace: "pre-wrap", color: "var(--t-strong)", fontSize: 14 }}>{item.content}</div>
                <div style={{ marginTop: 6, color: "var(--t-strong)", fontSize: 12 }}>
                  {item.createdAt} / by {item.createdBy}
                </div>
                <div style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    onClick={() => void removeKnowledge(item.id)}
                    disabled={loading}
                    style={{
                      border: "1px solid var(--c-red)",
                      color: "var(--c-red-deep)",
                      borderRadius: 8,
                      padding: "6px 10px",
                      background: "#fef2f2",
                      cursor: "pointer",
                    }}
                  >
                    删除该条知识
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      <ShippingConfig
        visible={activeSection === "shipping-config"}
        shippingConfigSea={shippingConfigSea}
        onSeaChange={setShippingConfigSea}
        shippingConfigLand={shippingConfigLand}
        onLandChange={setShippingConfigLand}
        configSaving={configSaving}
        clientList={clientList}
        rateItems={rateItems}
        rateDefaults={rateDefaults}
        onToast={setToast}
        onRatesReload={loadRates}
      />

      {message ? (
        <p style={{ marginTop: 12, color: message.includes("失败") ? "var(--c-red-deep)" : "var(--c-green-deep)" }}>{message}</p>
      ) : null}
      <Toast open={toast.length > 0} message={toast} />

      {/* 创建员工弹窗 */}
      {showStaffModal && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)", padding: 16 }}>
          <div style={{ width: "100%", maxWidth: 440, background: "var(--white)", borderRadius: 12, padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
            <h3 style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 600 }}>创建员工账号</h3>
            <div style={{ display: "grid", gap: 10 }}>
              <div>
                <label style={{ fontSize: 12, color: "var(--t-strong)", display: "block", marginBottom: 4 }}>账号（选填）</label>
                <input value={staffForm.id} onChange={(e) => setStaffForm((f) => ({ ...f, id: e.target.value }))} placeholder="留空自动生成" style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px", width: "100%", fontSize: 13 }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--t-strong)", display: "block", marginBottom: 4 }}>姓名 *</label>
                <input value={staffForm.name} onChange={(e) => setStaffForm((f) => ({ ...f, name: e.target.value }))} placeholder="员工姓名" style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px", width: "100%", fontSize: 13 }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--t-strong)", display: "block", marginBottom: 4 }}>手机 *</label>
                <input value={staffForm.phone} onChange={(e) => setStaffForm((f) => ({ ...f, phone: e.target.value }))} placeholder="手机号" style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px", width: "100%", fontSize: 13 }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--t-strong)", display: "block", marginBottom: 4 }}>登录密码</label>
                <input type="password" value={staffForm.password} onChange={(e) => setStaffForm((f) => ({ ...f, password: e.target.value }))} placeholder="密码（可选，填就要至少 8 位、不能全是数字）" style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px", width: "100%", fontSize: 13 }} />
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button type="button" onClick={() => setShowStaffModal(false)} style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 14px", background: "var(--white)", cursor: "pointer", color: "var(--t-strong)", fontSize: 13 }}>取消</button>
              <button type="button" disabled={loading} onClick={() => void submitAddStaff()} style={{ border: "none", borderRadius: 8, padding: "8px 14px", background: loading ? "var(--t-strong)" : "var(--c-blue)", color: "var(--white)", fontWeight: 600, cursor: loading ? "not-allowed" : "pointer", fontSize: 13 }}>{loading ? "提交中…" : "创建"}</button>
            </div>
          </div>
        </div>
      )}

      {/* 创建/编辑客户弹窗 */}
      {showClientModal && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)", padding: 16 }}>
          <div style={{ width: "100%", maxWidth: 440, background: "var(--white)", borderRadius: 12, padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
            <h3 style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 600 }}>{editingClientId ? "编辑客户账号" : "创建客户账号"}</h3>
            <div style={{ display: "grid", gap: 10 }}>
              <div>
                <label style={{ fontSize: 12, color: "var(--t-strong)", display: "block", marginBottom: 4 }}>账号{editingClientId ? "" : "（选填，不填则自动生成）"}</label>
                <input value={clientForm.id} onChange={(e) => setClientForm((f) => ({ ...f, id: e.target.value }))} placeholder={editingClientId ? undefined : "留空自动生成"} disabled={!!editingClientId} style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px", width: "100%", fontSize: 13, background: editingClientId ? "var(--s-sunken)" : "var(--white)", color: editingClientId ? "var(--t-muted)" : "var(--t-strong)" }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--t-strong)", display: "block", marginBottom: 4 }}>客户名字 *</label>
                <input value={clientForm.name} onChange={(e) => setClientForm((f) => ({ ...f, name: e.target.value }))} placeholder="客户姓名" style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px", width: "100%", fontSize: 13 }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--t-strong)", display: "block", marginBottom: 4 }}>公司名字</label>
                <input value={clientForm.companyName} onChange={(e) => setClientForm((f) => ({ ...f, companyName: e.target.value }))} placeholder="公司名（可选）" style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px", width: "100%", fontSize: 13 }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--t-strong)", display: "block", marginBottom: 4 }}>电话号码 *</label>
                <input value={clientForm.phone} onChange={(e) => setClientForm((f) => ({ ...f, phone: e.target.value }))} placeholder="手机号" style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px", width: "100%", fontSize: 13 }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--t-strong)", display: "block", marginBottom: 4 }}>邮箱</label>
                <input value={clientForm.email} onChange={(e) => setClientForm((f) => ({ ...f, email: e.target.value }))} placeholder="email@example.com" style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px", width: "100%", fontSize: 13 }} />
              </div>
              {/* 2026-09-16 代理账号：开在哪个代理名下（确认单 2.2 / 2.3 / 6.2） */}
              <div>
                <label style={{ fontSize: 12, color: "var(--t-strong)", display: "block", marginBottom: 4 }}>所属代理</label>
                <select value={clientForm.agentId} onChange={(e) => setClientForm((f) => ({ ...f, agentId: e.target.value }))} style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px", width: "100%", fontSize: 13, background: "var(--white)" }}>
                  <option value="">湘泰自己的客户</option>
                  {agentOptions.map((a) => (
                    <option key={a.id} value={a.id}>开在代理「{a.name}」名下</option>
                  ))}
                  {/* 代理列表没拉到时，编辑的这位客户原来的代理也要能显示，免得保存时被当成改回湘泰 */}
                  {clientForm.agentId && !agentOptions.some((a) => a.id === clientForm.agentId) ? (
                    <option value={clientForm.agentId}>
                      当前代理（{clientList.find((c) => c.id === editingClientId)?.agentName ?? clientForm.agentId}）
                    </option>
                  ) : null}
                </select>
                <div style={{ fontSize: 11, color: "var(--t-muted)", marginTop: 4 }}>
                  {editingClientId
                    ? "只有还没下过单（没有运单、没有集货记录）的客户才能改归属。"
                    : agentOptions.length === 0
                      ? "现在还没有代理（在「代理管理」里开），只能开湘泰自己的客户。"
                      : "开在代理名下的客户归这个代理管，仓库版集货的价由代理填；员工那边看不到归属。"}
                </div>
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--t-strong)", display: "block", marginBottom: 4 }}>{editingClientId ? "登录密码（留空不修改）" : "登录密码 *"}</label>
                <input type="password" value={clientForm.password} onChange={(e) => setClientForm((f) => ({ ...f, password: e.target.value }))} placeholder={editingClientId ? "留空不修改密码" : "密码（必填）"} style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px", width: "100%", fontSize: 13 }} />
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button type="button" onClick={() => { setShowClientModal(false); setEditingClientId(null); setClientForm({ id: "", name: "", companyName: "", phone: "", email: "", password: "", agentId: "" }); }} style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 14px", background: "var(--white)", cursor: "pointer", color: "var(--t-strong)", fontSize: 13 }}>取消</button>
              <button type="button" disabled={loading} onClick={() => void (editingClientId ? submitEditClient() : submitAddClient())} style={{ border: "none", borderRadius: 8, padding: "8px 14px", background: loading ? "var(--t-strong)" : "var(--c-blue)", color: "var(--white)", fontWeight: 600, cursor: loading ? "not-allowed" : "pointer", fontSize: 13 }}>{loading ? "提交中…" : editingClientId ? "保存" : "创建"}</button>
            </div>
          </div>
        </div>
      )}
      {/* 分柜功能已移至装柜管理页面
创建订单弹窗 */}
      {showCreateOrderModal && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)", padding: 16 }}>
          <div style={{ width: "100%", maxWidth: 640, background: "var(--white)", borderRadius: 12, padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.3)", maxHeight: "85vh", overflow: "auto" }}>
            <h3 style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 600 }}>创建订单</h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8, marginBottom: 12 }}>
              <div>
                <label style={{ fontSize: 11, display: "block", marginBottom: 2 }}>客户 *</label>
                <input list="admin-create-client" value={createForm.clientId} onChange={(e) => setCreateForm(f => ({ ...f, clientId: e.target.value }))} placeholder="输入客户ID搜索" style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "6px 8px", width: "100%", fontSize: 12 }} />
                <datalist id="admin-create-client">{staffClients.map(c => (<option key={c.id} value={c.id} />))}</datalist>
              </div>
              <div>
                <label style={{ fontSize: 11, display: "block", marginBottom: 2 }}>仓库</label>
                <select value={createForm.warehouseId} onChange={(e) => setCreateForm(f => ({ ...f, warehouseId: e.target.value }))} style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "6px 8px", width: "100%", fontSize: 12 }}>
                  {warehouseOptions.map(w => (<option key={w.id} value={w.id}>{w.label}</option>))}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 11, display: "block", marginBottom: 2 }}>到仓日期</label>
                <input type="date" value={createForm.arrivedAt} onChange={(e) => setCreateForm(f => ({ ...f, arrivedAt: e.target.value }))} style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "6px 8px", width: "100%", fontSize: 12 }} />
              </div>
              <div>
                <label style={{ fontSize: 11, display: "block", marginBottom: 2 }}>运输方式</label>
                <select value={createForm.transportMode} onChange={(e) => setCreateForm(f => ({ ...f, transportMode: e.target.value as "sea" | "land" }))} style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "6px 8px", width: "100%", fontSize: 12 }}>
                  <option value="sea">海运</option><option value="land">陆运</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize: 11, display: "block", marginBottom: 2 }}>国内单号</label>
                <input value={createForm.domesticTrackingNo} onChange={(e) => setCreateForm(f => ({ ...f, domesticTrackingNo: e.target.value }))} placeholder="货拉拉" style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "6px 8px", width: "100%", fontSize: 12 }} />
              </div>
              <div>
                <label style={{ fontSize: 11, display: "block", marginBottom: 2 }}>泰国收货人</label>
                <input value={createForm.receiverNameTh} onChange={(e) => setCreateForm(f => ({ ...f, receiverNameTh: e.target.value }))} style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "6px 8px", width: "100%", fontSize: 12 }} />
              </div>
              <div>
                <label style={{ fontSize: 11, display: "block", marginBottom: 2 }}>泰国收货电话</label>
                <input value={createForm.receiverPhoneTh} onChange={(e) => setCreateForm(f => ({ ...f, receiverPhoneTh: e.target.value }))} style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "6px 8px", width: "100%", fontSize: 12 }} />
              </div>
              <div>
                <label style={{ fontSize: 11, display: "block", marginBottom: 2 }}>泰国收货地址</label>
                <input value={createForm.receiverAddressTh} onChange={(e) => setCreateForm(f => ({ ...f, receiverAddressTh: e.target.value }))} style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "6px 8px", width: "100%", fontSize: 12 }} />
              </div>
            </div>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>产品行</div>
            {createProducts.map((p, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "2fr 0.6fr 0.8fr 0.8fr 0.8fr 1.2fr", gap: 4, marginBottom: 4 }}>
                <input value={p.itemName} onChange={(e) => { const n = [...createProducts]; n[i].itemName = e.target.value; setCreateProducts(n); }} placeholder="品名" style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "4px 6px", fontSize: 11 }} />
                <input type="number" value={p.packageCount} onChange={(e) => { const n = [...createProducts]; n[i].packageCount = e.target.value; setCreateProducts(n); }} placeholder="箱数" style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "4px 6px", fontSize: 11 }} />
                <input value={p.productQuantity} onChange={(e) => { const n = [...createProducts]; n[i].productQuantity = e.target.value; setCreateProducts(n); }} placeholder="数量/箱" style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "4px 6px", fontSize: 11 }} />
                <input value={`${p.lengthCm}×${p.widthCm}×${p.heightCm}`} onChange={(e) => { const parts = e.target.value.split("×"); const n = [...createProducts]; n[i].lengthCm = parts[0] || ""; n[i].widthCm = parts[1] || ""; n[i].heightCm = parts[2] || ""; setCreateProducts(n); }} placeholder="L×W×H cm" style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "4px 6px", fontSize: 11 }} />
                <select value={p.cargoType} onChange={(e) => { const n = [...createProducts]; n[i].cargoType = e.target.value; setCreateProducts(n); }} style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "4px 6px", fontSize: 11 }}>
                  <option value="normal">普货</option><option value="inspection">商检货</option><option value="sensitive">敏感货</option>
                </select>
                <div style={{ display: "flex", gap: 4 }}>
                  <input value={p.domesticTrackingNo} onChange={(e) => { const n = [...createProducts]; n[i].domesticTrackingNo = e.target.value; setCreateProducts(n); }} placeholder="国内单号" style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "4px 6px", fontSize: 11, flex: 1 }} />
                  {createProducts.length > 1 && <button onClick={() => { setCreateProducts(createProducts.filter((_, j) => j !== i)); }} style={{ border: "none", background: "#fecaca", color: "var(--c-red-2)", borderRadius: 4, cursor: "pointer", fontSize: 11 }}>×</button>}
                </div>
              </div>
            ))}
            <button onClick={() => setCreateProducts([...createProducts, { itemName: "", packageCount: "", lengthCm: "", widthCm: "", heightCm: "", productQuantity: "", cargoType: "normal", domesticTrackingNo: "" }])} style={{ border: "1px solid var(--c-blue)", borderRadius: 6, padding: "4px 10px", background: "var(--c-blue-bg)", color: "var(--c-blue)", cursor: "pointer", fontSize: 12, marginBottom: 16 }}>添加产品行</button>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={() => setShowCreateOrderModal(false)} style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 14px", background: "var(--white)", cursor: "pointer", color: "var(--t-strong)" }}>取消</button>
              <button disabled={loading} onClick={async () => {
                if (!createForm.clientId.trim()) { setMessage("请选择客户"); return; }
                const validProducts = createProducts.filter(p => p.itemName.trim());
                if (validProducts.length === 0) { setMessage("请至少填写一个产品行"); return; }
                // ⚠️ 跟另外三个入口同一份口径（箱数正整数、每箱几个全填或全空）
                {
                  const rowIssue = validateProductRows(validProducts);
                  if (rowIssue) { setMessage(rowIssue); return; }
                }
                setLoading(true);
                try {
                  await createStaffOrder({
                    clientId: createForm.clientId.trim(),
                    warehouseId: createForm.warehouseId,
                    arrivedAt: createForm.arrivedAt,
                    transportMode: createForm.transportMode,
                    domesticTrackingNo: createForm.domesticTrackingNo.trim() || undefined,
                    batchNo: createForm.batchNo.trim() || undefined,
                    receiverNameTh: createForm.receiverNameTh.trim() || undefined,
                    receiverPhoneTh: createForm.receiverPhoneTh.trim() || undefined,
                    receiverAddressTh: createForm.receiverAddressTh.trim() || undefined,
                    itemName: validProducts[0].itemName.trim(),
                    packageCount: packageCountForPayload(validProducts[0].packageCount),
                    packageUnit: "box",
                    products: validProducts.map(p => ({
                      itemName: p.itemName.trim(),
                      packageCount: packageCountForPayload(p.packageCount),
                      lengthCm: Number(p.lengthCm) || undefined,
                      widthCm: Number(p.widthCm) || undefined,
                      heightCm: Number(p.heightCm) || undefined,
                      productQuantity: Number(p.productQuantity) || undefined,
                      cargoType: p.cargoType,
                      domesticTrackingNo: p.domesticTrackingNo.trim() || undefined,
                    })),
                  });
                  setToast("订单创建成功");
                  setShowCreateOrderModal(false);
                  await loadOrders();
                } catch (err) {
                  setMessage(`创建失败：${err instanceof Error ? err.message : "未知错误"}`);
                } finally { setLoading(false); }
              }} style={{ border: "none", borderRadius: 8, padding: "8px 14px", background: "var(--c-blue)", color: "var(--white)", fontWeight: 600, cursor: "pointer" }}>
                {loading ? "提交中…" : "创建"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 批量导入弹窗 */}
      {showBatchImport && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)", padding: 16 }}>
          <div style={{ width: "100%", maxWidth: 700, background: "var(--white)", borderRadius: 12, padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.3)", maxHeight: "85vh", overflow: "auto" }}>
            <h3 style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 600 }}>批量导入运单</h3>
            <div style={{ marginBottom: 12, fontSize: 12, color: "var(--t-strong)" }}>
              下载模板 → 填写数据 → 上传文件。表头：客户ID, 仓库ID, 品名, 箱数, 包装单位, 运输方式, 到仓日期, 国内单号, 泰国收货人, 泰国收货电话, 泰国收货地址, 货型
            </div>
            {!batchConfirmed ? (
              <>
                <div style={{ marginBottom: 12 }}>
                  <button type="button" className="workbench-button" style={{ minHeight: 40, border: "1px solid var(--l-strong)", borderRadius: 4, padding: "8px 12px", background: "var(--white)", color: "var(--t-strong)", fontSize: 13, cursor: "pointer" }} disabled={batchTemplateDownloading} onClick={() => void downloadAdminBatchTemplate()}>{batchTemplateDownloading ? "下载中…" : "下载模板"}</button>
                </div>
                <input type="file" accept=".xlsx,.xls,.csv" onChange={async (e) => {
                  const file = e.currentTarget.files?.[0];
                  if (!file) return;
                  e.currentTarget.value = "";
                  const readTicket = batchReadGate.begin();
                  setBatchFileName(file.name);
                  setBatchRows([]);
                  setBatchConfirmed(false);
                  setBatchFileError("");
                  setBatchFileReading(true);
                  try {
                    const XLSX = await import("xlsx");
                    const data = await file.arrayBuffer();
                    if (!batchReadGate.isCurrent(readTicket)) return;
                    const wb = XLSX.read(data);
                    const ws = wb.Sheets[wb.SheetNames[0]];
                    if (!ws) throw new Error("文件中没有工作表");
                    const rows = XLSX.utils.sheet_to_json<any>(ws);
                    setBatchRows(rows);
                    if (rows.length === 0) setBatchFileError("文件中没有可导入的数据，请填写模板后重新上传。");
                  } catch {
                    if (!batchReadGate.isCurrent(readTicket)) return;
                    setBatchRows([]);
                    setBatchFileError("文件读取失败，请检查文件内容并使用系统模板重新上传。");
                  } finally {
                    if (batchReadGate.isCurrent(readTicket)) setBatchFileReading(false);
                  }
                }} style={{ marginBottom: 12, fontSize: 12 }} />
                {batchFileReading && <p role="status" style={{ fontSize: 13 }}>正在读取 {batchFileName}，读取完成后再确认导入。</p>}
                {batchFileError && <p role="alert" style={{ fontSize: 13, color: "var(--c-red-deep)" }}>{batchFileError}</p>}
                {!batchFileReading && batchRows.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 12, marginBottom: 4 }}>预览（{batchRows.length} 条）：</div>
                    <div style={{ maxHeight: 200, overflow: "auto", fontSize: 11, border: "1px solid var(--l-soft)", borderRadius: 6 }}>
                      <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse" }}>
                        <thead><tr style={{ background: "var(--s-cool-2)" }}>{Object.keys(batchRows[0]).slice(0, 6).map(k => (<th key={k} style={{ padding: "4px 6px", textAlign: "left" }}>{k}</th>))}</tr></thead>
                        <tbody>{batchRows.slice(0, 20).map((r: any, i: number) => (<tr key={i}>{Object.values(r).slice(0, 6).map((v: any, j: number) => (<td key={j} style={{ padding: "2px 6px" }}>{String(v ?? "")}</td>))}</tr>))}</tbody>
                      </table>
                    </div>
                    <button onClick={() => setBatchConfirmed(true)} style={{ marginTop: 8, border: "none", borderRadius: 6, padding: "6px 12px", background: "var(--c-blue)", color: "var(--white)", cursor: "pointer", fontSize: 12 }}>确认导入</button>
                  </div>
                )}
              </>
            ) : (
              <div>
                {/* 进度：只用文字报数，不放进度条 */}
                <div style={{ marginBottom: 8, fontSize: 12, color: "var(--t-strong)" }}>
                  {batchDone ? "导入完成。" : `正在导入 ${batchRows.length} 条…`}
                  {batchProgress.current > 0 ? `　已处理 ${batchProgress.current}/${batchRows.length}，成功 ${batchProgress.success} 条` : ""}
                  {batchProgress.fail > 0 ? <span style={{ color: "var(--c-red-deep)" }}>，失败 {batchProgress.fail} 条</span> : null}
                </div>
                {/* 失败明细（2026-08-31，排查报告第46条）：列出行号+客户ID/品名+原因，
                    让人照着补录，别整表重导把已成功的建重 */}
                {batchDone && batchFailures.length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--c-red-deep)", marginBottom: 4 }}>
                      失败明细（共 {batchProgress.fail} 条{batchProgress.fail > batchFailures.length ? `，只记录了前 ${batchFailures.length} 条` : ""}）。
                      行号=表头下面第几行。已成功的 {batchProgress.success} 条不用重导，照下面明细补失败的就行：
                    </div>
                    <textarea
                      readOnly
                      value={batchFailures.map((f) => `第${f.row}行　客户ID:${f.clientId || "-"}　品名:${f.itemName || "-"}　原因:${f.reason}`).join("\n")}
                      style={{ width: "100%", height: 160, fontSize: 12, border: "1px solid #fca5a5", borderRadius: 6, padding: 8, background: "#fef2f2", color: "var(--t-strong)", resize: "vertical", boxSizing: "border-box" }}
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        const text = batchFailures.map((f) => `第${f.row}行\t${f.clientId}\t${f.itemName}\t${f.reason}`).join("\n");
                        try {
                          await navigator.clipboard.writeText(text);
                          setToast("失败明细已复制");
                        } catch {
                          setToast("复制失败，请直接全选上面文本框的内容复制");
                        }
                      }}
                      style={{ marginTop: 4, border: "1px solid var(--l-strong)", borderRadius: 6, padding: "4px 10px", background: "var(--white)", cursor: "pointer", fontSize: 12, color: "var(--t-strong)" }}
                    >
                      复制失败明细
                    </button>
                  </div>
                )}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button onClick={() => { batchReadGate.cancel(); setBatchFileReading(false); setBatchFileError(""); setShowBatchImport(false); setBatchRows([]); setBatchConfirmed(false); setBatchFileName(""); setBatchDone(false); setBatchFailures([]); setBatchProgress({ current: 0, success: 0, fail: 0 }); }} style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 14px", background: "var(--white)", cursor: "pointer" }}>{batchDone ? "关闭" : "取消"}</button>
              {/* 导入跑完就把「开始导入」收起来，防止手抖再点一次把成功的整批建重 */}
              {batchConfirmed && !batchDone && (
                <button disabled={batchLoading} onClick={async () => {
                  setBatchLoading(true); let success = 0; let fail = 0;
                  // 开跑前清掉上一轮的数字，别让旧进度/旧明细混进这一轮
                  setBatchProgress({ current: 0, success: 0, fail: 0 });
                  setBatchFailures([]);
                  // 【排查报告第46条 · 2026-08-31】失败的行要逐条记下来，不许只报个数
                  const failures: Array<{ row: number; clientId: string; itemName: string; reason: string }> = [];
                  for (let i = 0; i < batchRows.length; i++) {
                    const r = batchRows[i];
                    try {
                      await createStaffOrder({
                        clientId: String(r["客户ID"] ?? r.clientId ?? ""), warehouseId: String(r["仓库ID"] ?? r.warehouseId ?? "wh_yiwu_01"),
                        arrivedAt: String(r["到仓日期"] ?? r.arrivedAt ?? new Date().toISOString().slice(0, 10)),
                        itemName: String(r["品名"] ?? r.itemName ?? ""),
                        // ⚠️ 不许 `?? 1`（2026-08-29 去掉）：表里没填箱数就该报错让人去补，
                        // 悄悄当成 1 箱会让重量/方数/产品数量三个合计一起错，而且错得很像真的
                        packageCount: Number(r["箱数"] ?? r.packageCount ?? NaN),
                        packageUnit: (r["包装单位"] ?? r.packageUnit ?? "box") as "bag" | "box",
                        transportMode: (r["运输方式"] ?? r.transportMode ?? "sea") as "sea" | "land",
                        domesticTrackingNo: String(r["国内单号"] ?? r.domesticTrackingNo ?? ""),
                        receiverNameTh: String(r["泰国收货人"] ?? r.receiverNameTh ?? ""),
                        receiverPhoneTh: String(r["泰国收货电话"] ?? r.receiverPhoneTh ?? ""),
                        receiverAddressTh: String(r["泰国收货地址"] ?? r.receiverAddressTh ?? ""),
                        // 货型（2026-09-11）：留空按普货；填了认不出来的值让这一行失败，
                        // 不许静默当普货 —— 商检货走普货，清关要的单据是另一套
                        cargoType: (() => {
                          const parsed = parseCargoType(r["货型"] ?? r.cargoType);
                          if (!parsed) throw new Error(`货型「${String(r["货型"] ?? r.cargoType ?? "").trim()}」认不出来。${CARGO_TYPE_HINT}`);
                          return parsed.value;
                        })(),
                      });
                      success++;
                    } catch (err) {
                      fail++;
                      // 行号按数据行算（第 1 条 = 表头下面第一行），凑不满 200 条才继续记
                      if (failures.length < 200) {
                        failures.push({
                          row: i + 1,
                          clientId: String(r["客户ID"] ?? r.clientId ?? ""),
                          itemName: String(r["品名"] ?? r.itemName ?? ""),
                          reason: err instanceof Error ? err.message : "未知错误",
                        });
                      }
                    }
                    setBatchProgress({ current: i + 1, success, fail });
                  }
                  setBatchLoading(false);
                  setBatchDone(true);
                  setBatchFailures(failures);
                  if (fail === 0) {
                    // 全部成功才自动关弹窗；有失败就留着弹窗给人看明细（排查报告第46条）
                    setToast(`导入完成：${success} 条全部成功`);
                    setShowBatchImport(false); setBatchRows([]); setBatchConfirmed(false); setBatchDone(false);
                  } else {
                    setToast(`导入完成：成功 ${success}，失败 ${fail}，失败明细见弹窗`);
                  }
                  await loadOrders();
                }} style={{ border: "none", borderRadius: 8, padding: "8px 14px", background: "var(--c-blue)", color: "var(--white)", fontWeight: 600, cursor: "pointer" }}>
                  {batchLoading ? `导入中 ${batchProgress.current}/${batchRows.length}` : "开始导入"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
