"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AiKnowledgeItem } from "../../../../../packages/shared-types/entities";
import { getOptionalSession, type AuthSession } from "../../auth/auth-session";
import CountUpNumber from "../../modules/layout/CountUpNumber";
import EmptyStateCard from "../../modules/layout/EmptyStateCard";
import RoleShell from "../../modules/layout/RoleShell";
import Toast from "../../modules/layout/Toast";
import ShipmentSearch from "../../modules/shipment/ShipmentSearch";
import { openPrintLabel } from "../../modules/shipment/ShipmentPrintLabel";
import { openShipmentTrack } from "../../modules/shipment/ShipmentTrackModal";
import { apiBaseUrl, authHeaders, parseApiResponse } from "../../services/core-api";
import { DEFAULT_SHIPPING_PRICES, INSPECTION_SURCHARGE, SENSITIVE_SURCHARGE } from "../../../../../packages/shared-types/constants";
import { shipmentStatusZh, transportModeLabel, warehouseLabelFromId } from "../../modules/staff/utils";
import StaffLastmile from "../../components/staff/StaffLastmile";
import ShippingConfig from "../../components/admin/ShippingConfig";
import {
  fetchAdminOverview,
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
  deleteAdminStaff,
  deleteAdminOrder,
  setAdminStaffPassword,
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
  type ShipmentItem,
  // 充值审核
  fetchAdminRecharges,
  approveRecharge,
  rejectRecharge,
  type AdminWalletRechargeItem,
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
  "offline-payments",
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
  "offline-payments": "付款审核",
};

const sectionStyle = {
  marginBottom: 24,
  border: "1px solid #e5e7eb",
  borderRadius: 12,
  padding: 20,
  background: "#fff",
};

const cardStyle = {
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  padding: "10px 12px",
  background: "#f8fafc",
  fontSize: 14,
};

const prealertEditInputStyle: React.CSSProperties = {
  border: "1px solid #d1d5db",
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

const logisticsStatusOptions = [
  "已创建", "已揽收", "国内仓已收货", "报关中", "已装柜",
  "延迟开船", "已开船", "已到港", "运输中",
  "清关中", "清关已放行", "已到仓", "派送中", "派送完成",
] as const;

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

export default function AdminHomePage() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [overviewFlash, setOverviewFlash] = useState(false);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [opsOverview, setOpsOverview] = useState<AdminOpsOverview | null>(null);
  const [staffList, setStaffList] = useState<AdminUserItem[]>([]);
  const [clientList, setClientList] = useState<AdminUserItem[]>([]);
  const [orderList, setOrderList] = useState<AdminOrderItem[]>([]);
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
  const [pageSize, setPageSize] = useState(100);
  const [orderSearch, setOrderSearch] = useState({
    trackingNo: "", domesticTrackingNo: "", clientName: "", warehouseId: "",
    batchNo: "", itemName: "", packageCount: "", productQuantity: "",
    weightKg: "", volumeM3: "", arrivedAtFrom: "", arrivedAtTo: "", logisticsStatus: "",
    containerNo: "", transportMode: "", receiverAddress: "", shipDateFrom: "", shipDateTo: "",
    receivableAmount: "", statusRaw: "",
  });
  const [editingOrderId, setEditingOrderId] = useState("");
  const [expandedOrderId, setExpandedOrderId] = useState("");

  const [showCreateOrderModal, setShowCreateOrderModal] = useState(false);
  const [showBatchImport, setShowBatchImport] = useState(false);
  const [staffClients, setStaffClients] = useState<Array<{ id: string; name: string }>>([]);
  const [createForm, setCreateForm] = useState({
    clientId: "", warehouseId: "wh_yiwu_01", arrivedAt: new Date().toISOString().slice(0, 10),
    transportMode: "sea" as "sea" | "land", domesticTrackingNo: "", batchNo: "", shipDate: "",
    receiverNameTh: "", receiverPhoneTh: "", receiverAddressTh: "",
  });
  const [createProducts, setCreateProducts] = useState<Array<{
    itemName: string; packageCount: number; lengthCm: string; widthCm: string;
    heightCm: string; productQuantity: string; cargoType: string; domesticTrackingNo: string;
  }>>([{ itemName: "", packageCount: 1, lengthCm: "", widthCm: "", heightCm: "", productQuantity: "", cargoType: "normal", domesticTrackingNo: "" }]);
  const [batchRows, setBatchRows] = useState<Array<any>>([]);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ current: 0, success: 0, fail: 0 });
  const [batchFileName, setBatchFileName] = useState("");
  const [batchConfirmed, setBatchConfirmed] = useState(false);
  const [calcLength, setCalcLength] = useState("");
  const [calcWidth, setCalcWidth] = useState("");
  const [calcHeight, setCalcHeight] = useState("");
  const [calcQty, setCalcQty] = useState("1");
  const [calcResult, setCalcResult] = useState("");
  const [lmForm, setLmForm] = useState({ driverName: "", licensePlate: "", phoneNumber: "", deliveryDate: "" });
  const [lmShipments, setLmShipments] = useState<Array<{id:string;trackingNo:string;clientId:string;itemName:string;packageCount:number}>>([]);
  const [lmSelected, setLmSelected] = useState<Set<string>>(new Set());
  const [lmShipSearch, setLmShipSearch] = useState("");
  const lmSignFileRef = useRef<HTMLInputElement>(null);
  const [lmSignData, setLmSignData] = useState<{id:string;base64:string}|null>(null);
  const loadLmShipments = async () => {
    try { const r = await fetch(apiBaseUrl()+"/staff/shipments?limit=500&all=1",{headers:authHeaders()}); const d=await r.json();
      if(d.code==="OK") setLmShipments(d.data.items.filter((s:any)=>["inwarehouseth","outfordelivery","delivered"].includes((s.currentStatus||"").toLowerCase())).map((s:any)=>({id:s.id,trackingNo:s.trackingNo,clientId:s.clientId??"",itemName:s.itemName??"",packageCount:s.packageCount??0,containerNo:s.containerNo||undefined}))); } catch (e) { console.error(e); }
  };
  const [lmOrders, setLmOrders] = useState<Array<{id:string;deliveryNo:string;shipmentId:string;trackingNo?:string;driverName?:string|null;licensePlate?:string|null;phoneNumber?:string|null;deliveryDate?:string|null;signImageBase64?:string|null;status:string}>>([]);
  const loadLastmileOrders = async () => {
    try { const res = await fetch(`${apiBaseUrl()}/admin/lastmile/orders`, { headers: authHeaders() }); const d = await parseApiResponse<{items:any[]}>(res); setLmOrders(d.items); } catch (e) { console.error(e); }
  };
  const updateLastmileStatus = async (id: string, status: string, signImageBase64?: string) => {
    const res = await fetch(`${apiBaseUrl()}/admin/lastmile/status`, { method: "POST", headers: {"Content-Type":"application/json",...authHeaders()}, body: JSON.stringify({id, status, signImageBase64: signImageBase64 || undefined}) });
    return parseApiResponse(res);
  };
  // 充值审核
  const [rechargeList, setRechargeList] = useState<AdminWalletRechargeItem[]>([]);
  const [rechargeStatusFilter, setRechargeStatusFilter] = useState("");
  const [rejectModalId, setRejectModalId] = useState<string | null>(null);
  // 线下付款审核
  const [offlinePayments, setOfflinePayments] = useState<Array<{id:string;orderId:string;trackingNo:string;clientName:string;itemName:string;amount:number;proofImage:string;submittedAt:string|null}>>([]);
  const [offlineRejectId, setOfflineRejectId] = useState<string | null>(null);
  const [offlineRejectRemark, setOfflineRejectRemark] = useState("");
  const loadOfflinePayments = async () => {
    try { const r = await fetch(`${apiBaseUrl()}/admin/offline-payments`, { headers: authHeaders() }); const d = await r.json(); if (d.code === "OK") setOfflinePayments(d.data.items); } catch (e) { console.error(e); }
  };
  const [rejectRemark, setRejectRemark] = useState("");
  const loadRecharges = async () => {
    try {
      const data = await fetchAdminRecharges(rechargeStatusFilter || undefined);
      setRechargeList(data.recharges);
    } catch (e) { console.error(e); }
  };
  const [orderImagesCache, setOrderImagesCache] = useState<Record<string, Array<{ id: string; fileName: string; mime: string; contentBase64: string; filePath?: string | null; imageUrl?: string; createdAt: string }>>>({});
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
    receivableAmountCny: "",
    receivableCurrency: "CNY" as "CNY" | "THB",
    paymentStatus: "unpaid" as "paid" | "unpaid",
    shipDate: "",
    cargoType: "normal",
  });
  const [editProducts, setEditProducts] = useState<Array<{
    itemName: string; packageCount: string; lengthCm: string; widthCm: string; heightCm: string; productQuantity: string; weightKg: string; cargoType: string; domesticTrackingNo: string;
  }>>([]);
  const [staffForm, setStaffForm] = useState({ id: "", name: "", phone: "", password: "" });
  const [clientForm, setClientForm] = useState({ id: "", name: "", companyName: "", phone: "", email: "", password: "" });
  const [showStaffModal, setShowStaffModal] = useState(false);
  const [showClientModal, setShowClientModal] = useState(false);
  const [editingClientId, setEditingClientId] = useState<string | null>(null);
  const [settingPasswordFor, setSettingPasswordFor] = useState<string | null>(null);
  const [settingPasswordValue, setSettingPasswordValue] = useState("");
  const [memoryFilterSessionId, setMemoryFilterSessionId] = useState("");
  const [memoryFilterUserId, setMemoryFilterUserId] = useState("");
  const [activeSection, setActiveSection] = useState<(typeof SECTION_IDS)[number]>("overview");

  // 复用 staff/utils 中的状态/运输方式/仓库标签函数
  const shipmentStatusLabel = shipmentStatusZh;
  const warehouseLabel = warehouseLabelFromId;

  /**
   * 看板状态分布：用于状态卡片与柱状图展示。
   */
  const statusDistribution = useMemo(() => {
    const bucket = { delivered: 0, inTransit: 0, processing: 0, exception: 0 };
    orderList.forEach((item) => {
      const status = (item.statusGroup ?? "").toLowerCase();
      const approval = (item.approvalStatus ?? "").toLowerCase();
      if (approval !== "approved") {
        bucket.processing += 1;
        return;
      }
      if (status === "completed") {
        bucket.delivered += 1;
      } else if (status === "unfinished") {
        bucket.inTransit += 1;
      } else {
        bucket.exception += 1;
      }
    });
    return [
      { name: "已完成", value: bucket.delivered, color: "#10b981" },
      { name: "在途", value: bucket.inTransit, color: "#f59e0b" },
      { name: "处理中", value: bucket.processing, color: "#f59e0b" },
      { name: "异常/其他", value: bucket.exception, color: "#000000" },
    ];
  }, [orderList]);

  /**
   * 中泰线路时效趋势：按最近订单的创建时间模拟时效天数用于趋势观察。
   */
  const etaTrendData = useMemo(() => {
    return orderList.slice(0, 8).map((item, index) => ({
      label: `订单${index + 1}`,
      orderId: item.id,
      days: Number((2.5 + index * 0.6 + (item.transportMode === "sea" ? 4.2 : 1.4)).toFixed(1)),
    }));
  }, [orderList]);

  /**
   * 在途柜量：按批次号去重后统计未完成订单的柜子数。
   */
  const inTransitContainerCount = useMemo(() => {
    const set = new Set(
      orderList
        .filter((item) => (item.statusGroup ?? "").toLowerCase() === "unfinished")
        .map((item) => item.batchNo ?? "")
        .filter((item) => item),
    );
    return set.size;
  }, [orderList]);

  // 判断 hash 是否为有效的功能分区 id。
  const isSectionId = (value: string): value is (typeof SECTION_IDS)[number] =>
    SECTION_IDS.includes(value as (typeof SECTION_IDS)[number]);

  const loadOverview = useCallback(async () => {
    const stats = await fetchAdminOverview();
    setOverview(stats);
  }, []);

  const loadOpsOverview = useCallback(async () => {
    const stats = await fetchAdminOpsOverview();
    setOpsOverview(stats);
  }, []);

  const loadStaff = useCallback(async () => {
    const list = await fetchAdminStaff();
    setStaffList(list);
  }, []);

  const loadClients = useCallback(async () => {
    const list = await fetchAdminClients();
    setClientList(list);
  }, []);

  const loadOrders = useCallback(async () => {
    const list = await fetchAdminOrders();
    // 按运单号数字降序：YW0001220 > YW0001219
    list.sort((a, b) => {
      const an = (a.trackingNo ?? "").replace(/\D/g, "");
      const bn = (b.trackingNo ?? "").replace(/\D/g, "");
      return (Number(bn) || 0) - (Number(an) || 0);
    });
    setOrderList(list);
  }, []);

  /**
   * 载入待编辑订单到表单，便于管理员修改客户端订单信息。
   */
  const startEditOrder = (order: AdminOrderItem) => {
    setEditingOrderId(order.orderId ?? order.id);
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
      receivableAmountCny:
        order.receivableAmountCny === null || order.receivableAmountCny === undefined ? "" : String(order.receivableAmountCny),
      receivableCurrency: order.receivableCurrency === "THB" ? "THB" : "CNY",
      paymentStatus: order.paymentStatus === "paid" ? "paid" : "unpaid",
      shipDate: order.shipDate ?? "",
    });
    if (order.products && order.products.length > 0) {
      setEditProducts(order.products.map((p) => ({
        itemName: p.itemName ?? "",
        packageCount: String(p.packageCount ?? ""),
        lengthCm: p.lengthCm != null ? String(p.lengthCm) : "",
        widthCm: p.widthCm != null ? String(p.widthCm) : "",
        heightCm: p.heightCm != null ? String(p.heightCm) : "",
        productQuantity: p.productQuantity != null ? String(p.productQuantity) : "",
        weightKg: p.weightKg != null ? String(p.weightKg) : "",
        cargoType: p.cargoType ?? "normal",
        domesticTrackingNo: p.domesticTrackingNo ?? "货拉拉",
      })));
    } else {
      setEditProducts([]);
    }
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
    const totalPackageCount = activeProducts.reduce((s, p) => s + (Number(p.packageCount) || 1), 0);
    const totalProductQuantity = activeProducts.reduce((s, p) => s + (Number(p.productQuantity) || 0), 0);
    const primaryItemName = activeProducts[0]?.itemName.trim() || orderEditForm.itemName.trim();
    if (!primaryItemName) {
      setMessage("请填写品名。");
      return;
    }
    if (activeProducts.length === 0) {
      setMessage("请至少添加一个产品行。");
      return;
    }
    // 从产品行自动计算总体积和总重量
    let autoVolume = 0;
    let autoWeight = 0;
    let hasProductDims = false;
    for (const p of activeProducts) {
      const l = Number(p.lengthCm); const w = Number(p.widthCm); const h = Number(p.heightCm);
      const qty = Number(p.packageCount) || 1;
      if (l > 0 && w > 0 && h > 0) {
        autoVolume += (l * w * h * qty) / 1_000_000;
        hasProductDims = true;
      }
      const pw = Number(p.weightKg);
      if (pw > 0) autoWeight += pw * qty;
    }
    const finalVolume = hasProductDims ? autoVolume : (orderEditForm.volumeM3.trim() ? Number(orderEditForm.volumeM3) : null);
    const finalWeight = autoWeight > 0 ? autoWeight : (orderEditForm.weightKg.trim() ? Number(orderEditForm.weightKg) : null);

    const saveOrderId = editingOrderId;
    if (!saveOrderId) { setMessage("编辑失败：未选择订单"); return; }

    setLoading(true);
    setMessage("");
    try {
      await updateAdminOrder({
        orderId: saveOrderId,
        clientId: orderEditForm.clientId.trim() || "",
        itemName: primaryItemName,
        trackingNo: orderEditForm.trackingNo.trim() || "",
        batchNo: orderEditForm.batchNo.trim() || "",
        warehouseId: orderEditForm.warehouseId,
        transportMode: orderEditForm.transportMode,
        domesticTrackingNo: orderEditForm.domesticTrackingNo.trim() || "",
        receiverAddressTh: orderEditForm.receiverAddressTh.trim(),
        containerNo: orderEditForm.containerNo.trim() || "",
        productQuantity: totalProductQuantity,
        packageCount: totalPackageCount,
        packageUnit: orderEditForm.packageUnit,
        weightKg: finalWeight,
        volumeM3: finalVolume,
        receivableAmountCny: orderEditForm.receivableAmountCny.trim() ? Number(orderEditForm.receivableAmountCny) : null,
        receivableCurrency: orderEditForm.receivableCurrency,
        paymentStatus: orderEditForm.paymentStatus,
        shipDate: orderEditForm.shipDate.trim() || undefined,
        products: activeProducts.map(p => ({
          itemName: p.itemName.trim(),
          packageCount: Number(p.packageCount) || 1,
          lengthCm: p.lengthCm ? Number(p.lengthCm) : undefined,
          widthCm: p.widthCm ? Number(p.widthCm) : undefined,
          heightCm: p.heightCm ? Number(p.heightCm) : undefined,
          productQuantity: p.productQuantity ? Number(p.productQuantity) : undefined,
          cargoType: p.cargoType || "normal",
          domesticTrackingNo: p.domesticTrackingNo.trim() || "货拉拉",
          weightKg: p.weightKg ? Number(p.weightKg) : undefined,
        })),
      });
      setToast("订单信息已更新");
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
    setSessionMemoryList(data.items);
  }, []);

  const loadKnowledgeGaps = useCallback(async () => {
    const data = await fetchAdminAiKnowledgeGaps({ status: knowledgeGapStatus });
    setKnowledgeGapList(data.items);
  }, [knowledgeGapStatus]);

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

    // 10 秒自动刷新同步
    const interval = window.setInterval(() => {
      if (document.hidden) return;
      loadStaff().catch(() => {});
      loadClients().catch(() => {});
      loadOrders().catch(() => {});
    }, 10000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!overview) return;
    setOverviewFlash(true);
    const t = window.setTimeout(() => setOverviewFlash(false), 620);
    return () => window.clearTimeout(t);
  }, [overview]);

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
      await createAdminStaff({
        id: staffForm.id.trim() || undefined,
        name: staffForm.name.trim(),
        phone: staffForm.phone.trim(),
        password: staffForm.password.trim() || undefined,
      });
      setStaffForm({ id: "", name: "", phone: "", password: "" });
      setShowStaffModal(false);
      setToast("员工添加成功");
      setMessage("");
      await Promise.all([loadStaff(), loadOverview()]);
    } catch (error) {
      const text = error instanceof Error ? error.message : "添加失败";
      if (text.includes("permission") || text.includes("FORBIDDEN") || text.includes("403")) {
        setMessage("添加失败：请使用管理员身份登录（在首页选择 admin 并进入工作台）后再试。");
      } else {
        setMessage(`添加失败：${text}`);
      }
    } finally {
      setLoading(false);
    }
  };

  const confirmDeleteClient = async (userId: string, userName: string) => {
    if (!window.confirm(`确定要删除客户「${userName}」吗？删除后该账号将无法登录。此操作不可撤销。`)) return;
    // 安全问题：已移除前端硬编码二级密码，改为后端二次鉴权
    const pwd = window.prompt("请输入您的管理员密码以确认删除：");
    if (!pwd) {
      setMessage("操作已取消");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      await deleteAdminStaff(userId, pwd);
      setToast("客户已删除");
      await Promise.all([loadClients(), loadOverview()]);
    } catch (error) {
      const text = error instanceof Error ? error.message : "删除失败";
      setMessage(`删除失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  const confirmDeleteStaff = async (userId: string, userName: string) => {
    if (!window.confirm(`确定要删除员工「${userName}」吗？删除后该账号将无法登录。`)) return;
    setLoading(true);
    setMessage("");
    try {
      await deleteAdminStaff(userId);
      setToast("员工已删除");
      await Promise.all([loadStaff(), loadOverview()]);
    } catch (error) {
      const text = error instanceof Error ? error.message : "删除失败";
      setMessage(`删除失败：${text}`);
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
      await createAdminClient({
        id: clientForm.id.trim() || undefined,
        name: clientForm.name.trim(),
        companyName: clientForm.companyName.trim() || undefined,
        phone: clientForm.phone.trim(),
        email: clientForm.email.trim() || undefined,
        password: clientForm.password.trim() || undefined,
      });
      setClientForm({ id: "", name: "", companyName: "", phone: "", email: "", password: "" });
      setShowClientModal(false);
      setToast("客户添加成功");
      setMessage("");
      await Promise.all([loadClients(), loadOverview()]);
    } catch (error) {
      const text = error instanceof Error ? error.message : "添加失败";
      if (text.includes("permission") || text.includes("FORBIDDEN") || text.includes("403")) {
        setMessage("添加失败：请使用管理员身份登录后再试。");
      } else {
        setMessage(`添加失败：${text}`);
      }
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
      await updateAdminClient({
        id: editingClientId,
        name: clientForm.name.trim(),
        companyName: clientForm.companyName.trim() || undefined,
        phone: clientForm.phone.trim(),
        email: clientForm.email.trim() || undefined,
        password: clientForm.password.trim() || undefined,
      });
      setClientForm({ id: "", name: "", companyName: "", phone: "", email: "", password: "" });
      setShowClientModal(false);
      setEditingClientId(null);
      setToast("客户信息已更新");
      setMessage("");
      await loadClients();
    } catch (error) {
      const text = error instanceof Error ? error.message : "更新失败";
      if (text.includes("permission") || text.includes("FORBIDDEN") || text.includes("403")) {
        setMessage("更新失败：请使用管理员身份登录后再试。");
      } else {
        setMessage(`更新失败：${text}`);
      }
    } finally {
      setLoading(false);
    }
  };

  const filteredOrderList = useMemo(() => {
    const s = orderSearch;
    return orderList.filter((item) => {
      const trackingNo = (item.trackingNo ?? "").toLowerCase();
      const dn = (item.domesticTrackingNo ?? "").toLowerCase();
      const cn = `${item.clientName ?? ""} ${item.clientId ?? ""}`.toLowerCase();
      const wn = (item.warehouseId ?? "").toLowerCase();
      const bn = (item.batchNo ?? "").toLowerCase();
      const inm = (item.itemName ?? "").toLowerCase();
      const pn = (item.packageCount ?? "").toString();
      const pq = (item.productQuantity ?? "").toString();
      const wk = (item.weightKg ?? "").toString();
      const vm = (item.volumeM3 ?? "").toString();
      const ar = item.shipDate ?? item.createdAt?.slice(0, 10) ?? "";
      const cnr = (item.containerNo ?? "").toLowerCase();
      const tm = item.transportMode ?? "";
      const ra = (item.receiverAddressTh ?? "").toLowerCase();
      const sd = (item.shipDate ?? "").slice(0, 10);
      const rc = item.receivableAmountCny != null ? String(item.receivableAmountCny) : "";
      const sr = (item.currentStatus ?? "").toLowerCase();
      if (s.trackingNo && !trackingNo.includes(s.trackingNo.toLowerCase())) return false;
      if (s.domesticTrackingNo && !dn.includes(s.domesticTrackingNo.toLowerCase())) return false;
      if (s.clientName && !cn.includes(s.clientName.toLowerCase())) return false;
      if (s.warehouseId && wn !== s.warehouseId) return false;
      if (s.batchNo && !bn.includes(s.batchNo.toLowerCase())) return false;
      if (s.itemName && !inm.includes(s.itemName.toLowerCase())) return false;
      if (s.packageCount && !pn.includes(s.packageCount)) return false;
      if (s.productQuantity && !pq.includes(s.productQuantity)) return false;
      if (s.weightKg && !wk.includes(s.weightKg)) return false;
      if (s.volumeM3 && !vm.includes(s.volumeM3)) return false;
      if (s.arrivedAtFrom && ar < s.arrivedAtFrom) return false;
      if (s.arrivedAtTo && ar > s.arrivedAtTo) return false;
      if (s.logisticsStatus && shipmentStatusLabel(item.currentStatus) !== s.logisticsStatus) return false;
      if (s.containerNo && !cnr.includes(s.containerNo.toLowerCase())) return false;
      if (s.transportMode && tm !== s.transportMode) return false;
      if (s.receiverAddress && !ra.includes(s.receiverAddress.toLowerCase())) return false;
      if (s.shipDateFrom && sd < s.shipDateFrom) return false;
      if (s.shipDateTo && sd > s.shipDateTo) return false;
      if (s.receivableAmount && !rc.includes(s.receivableAmount)) return false;
      if (s.statusRaw && !sr.includes(s.statusRaw.toLowerCase())) return false;
      return true;
    });
  }, [orderList, orderSearch]);

  const toggleSelectOrder = (id: string) => {
    setSelectedOrders((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };
  const pagedOrders = useMemo(() => filteredOrderList.slice(0, pageSize), [filteredOrderList, pageSize]);

  const toggleSelectAllOrders = () => {
    if (selectedOrders.size === filteredOrderList.length) setSelectedOrders(new Set());
    else setSelectedOrders(new Set(filteredOrderList.map((o) => o.id)));
  };

  const [exportDateFrom, setExportDateFrom] = useState("");
  const [exportDateTo, setExportDateTo] = useState("");

  const exportOrdersToExcel = () => {
    let source = selectedOrders.size > 0 ? filteredOrderList.filter((o) => selectedOrders.has(o.id)) : filteredOrderList;
    if (source.length === 0) { setMessage("当前没有可导出的订单数据。"); return; }
    if (exportDateFrom) source = source.filter((o) => (o.shipDate ?? "").slice(0,10) >= exportDateFrom);
    if (exportDateTo) source = source.filter((o) => (o.shipDate ?? "").slice(0,10) <= exportDateTo);
    if (source.length === 0) { setMessage("所选日期范围内没有订单。"); return; }
    const rows = source.map((o) => ({
      运单号: o.trackingNo ?? "-", 客户: o.clientId ?? "-", 品名: o.itemName,
      运输方式: o.transportMode, 国内单号: o.domesticTrackingNo ?? "-", 柜号: o.batchNo ?? "-",
      审批状态: o.approvalStatus === "pending" ? "待审核" : o.approvalStatus === "approved" ? "已审核" : o.approvalStatus === "shipped" ? "已发货" : o.approvalStatus,
      产品数量: o.productQuantity ?? "-", 包裹数量: o.packageCount ?? "-",
      重量: o.weightKg ?? "-", 体积: o.volumeM3 ?? "-",
      到仓日期: o.shipDate ?? "-", 状态组: o.statusGroup ?? "-",
      创建时间: o.createdAt ?? "-", 更新时间: o.updatedAt ?? "-",
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "订单列表");
    XLSX.writeFile(wb, `订单数据_${new Date().toISOString().slice(0,10)}.xlsx`);
    setToast(`已导出 ${rows.length} 条`);
  };

  // 根据导航切换当前显示的功能分区。
  const scrollToSection = (id: string) => {
    if (!isSectionId(id)) return;
    setActiveSection(id);
    window.location.hash = id;
  };

  useEffect(() => {
    const syncSectionByHash = () => {
      const hashId = window.location.hash.replace(/^#/, "");
      if (isSectionId(hashId)) {
        setActiveSection(hashId);
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
      setRateItems(data.items);
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
    if (activeSection === "lastmile") loadLastmileOrders();
    if (activeSection === "wallet-recharges") loadRecharges();
    if (activeSection === "offline-payments") loadOfflinePayments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSection, clientList]);

  if (!session) return null;

  return (
    <RoleShell allowedRole="admin" title="管理员工作台">
      {/* 1. 运营看板 */}
      <section id="overview" style={{ ...sectionStyle, display: activeSection === "overview" ? "block" : "none" }}>
        <h2 style={{ marginTop: 0, marginBottom: 16, fontSize: 18 }}>{SECTION_LABELS.overview}</h2>
        {overview ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 12,
            }}
          >
            <div className={overviewFlash ? "kpi-flash" : ""} style={cardStyle}>
              <div style={{ color: "#000000", fontSize: 12 }}>员工账号总人数</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>
                <CountUpNumber value={overview.staffAccountCount} />
              </div>
            </div>
            <div className={overviewFlash ? "kpi-flash" : ""} style={cardStyle}>
              <div style={{ color: "#000000", fontSize: 12 }}>客户账号</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>
                <CountUpNumber value={overview.clientAccountCount} />
              </div>
            </div>
            <div className={overviewFlash ? "kpi-flash" : ""} style={cardStyle}>
              <div style={{ color: "#000000", fontSize: 12 }}>今日新增订单</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>
                <CountUpNumber value={overview.newOrderCountToday} />
              </div>
            </div>
            <div className={overviewFlash ? "kpi-flash" : ""} style={cardStyle}>
              <div style={{ color: "#000000", fontSize: 12 }}>在途订单</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>
                <CountUpNumber value={overview.inTransitOrderCount} />
              </div>
            </div>
            <div className={overviewFlash ? "kpi-flash" : ""} style={cardStyle}>
              <div style={{ color: "#000000", fontSize: 12 }}>当日收货总方数</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>
                <CountUpNumber value={overview.receivedVolumeM3Today} decimals={1} />
              </div>
            </div>
          </div>
        ) : (
          <p style={{ color: "#000000" }}>看板数据加载中…</p>
        )}
        <div style={{ marginTop: 14, display: "grid", gap: 12 }}>
          <div className="dashboard-grid-2">
            <div className="dashboard-panel">
              <div className="dashboard-panel-title">中泰线路时效分析图</div>
              <div style={{ width: "100%", height: 240 }}>
                <ResponsiveContainer>
                  <LineChart data={etaTrendData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="label" stroke="#000000" />
                    <YAxis stroke="#000000" />
                    <Tooltip
                      formatter={(value) => [`${String(value ?? "-")} 天`, "时效"]}
                      labelFormatter={(label) => (label ? `订单号：${String(label)}` : "时效详情")}
                    />
                    <Line type="monotone" dataKey="days" stroke="#1e3a8a" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="dashboard-panel">
              <div className="dashboard-panel-title">订单状态分布</div>
              <div style={{ width: "100%", height: 240 }}>
                <ResponsiveContainer>
                  <BarChart data={statusDistribution}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="name" stroke="#000000" />
                    <YAxis stroke="#000000" />
                    <Tooltip />
                    <Bar dataKey="value" radius={[6, 6, 0, 0]}>
                      {statusDistribution.map((item) => (
                        <Cell key={item.name} fill={item.color} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
          <div className="dashboard-panel">
            <div className="dashboard-panel-title">中泰海陆运路线概览（简化）</div>
            <div className="route-map-wrap">
              <div className="route-point route-point-cn">中国仓</div>
              <div className="route-line route-line-sea" />
              <div className="route-line route-line-land" />
              <div className="route-point route-point-th">泰国仓</div>
              <div className="route-counter">当前在途柜量：{inTransitContainerCount}</div>
            </div>
          </div>
          <div style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: 10, background: "#f8fafc" }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>毛利率趋势（最近结算）</div>
            {opsOverview ? (
              <>
                <div style={{ fontSize: 13, color: "#000000", marginBottom: 8 }}>
                  总收入 {opsOverview.profitSummary.totalRevenue.toFixed(2)} / 总成本{" "}
                  {opsOverview.profitSummary.totalCost.toFixed(2)} / 总利润{" "}
                  {opsOverview.profitSummary.totalProfit.toFixed(2)} / 毛利率{" "}
                  {opsOverview.profitSummary.grossMarginPercent.toFixed(2)}%
                </div>
                <div style={{ display: "grid", gap: 4 }}>
                  {opsOverview.profitTrend.map((item: any) => (
                    <div key={`${item.orderId}-${item.updatedAt}`} style={{ fontSize: 12, color: "#000000" }}>
                      运单 {item.trackingNo ?? item.orderId ?? "—"}：利润 {item.profit.toFixed(2)}（{item.updatedAt.slice(0, 16)}）
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 13, color: "#000000" }}>暂无利润趋势数据</div>
            )}
          </div>
          <div style={{ border: "1px solid #fde68a", borderRadius: 10, padding: 10, background: "#fffbeb" }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>关务查验预警</div>
            {opsOverview && opsOverview.customsAlerts.length > 0 ? (
              <div style={{ display: "grid", gap: 4 }}>
                {opsOverview.customsAlerts.slice(0, 6).map((item: any) => (
                  <div key={item.id} style={{ fontSize: 12, color: "#92400e" }}>
                    [{item.status === "inspection" ? "查验" : item.status === "released" ? "放行" : item.status === "pending" ? "待处理" : item.status}] 运单 {item.shipmentTrackingNo ?? item.shipmentId ?? "-"} /{" "}
                    {item.remark ?? "无备注"}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: "#000000" }}>暂无查验/待处理告警</div>
            )}
          </div>
          <div style={{ border: "1px solid #bfdbfe", borderRadius: 10, padding: 10, background: "#eff6ff" }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>供应商报价变化提醒</div>
            {opsOverview && opsOverview.supplierPriceAlerts.length > 0 ? (
              <div style={{ display: "grid", gap: 4 }}>
                {opsOverview.supplierPriceAlerts.slice(0, 6).map((item) => (
                  <div key={`${item.routeCode}-${item.supplierName}-${item.updatedAt}`} style={{ fontSize: 12, color: "#1e3a8a" }}>
                    {item.routeCode} / {item.supplierName}：{item.previousQuotePrice.toFixed(2)} →{" "}
                    {item.latestQuotePrice.toFixed(2)}（变动 {item.delta > 0 ? "+" : ""}
                    {item.delta.toFixed(2)}）
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: "#000000" }}>暂无报价变动提醒</div>
            )}
          </div>
        </div>
      </section>

      {/* 2. 员工管理 */}
      <section id="staff" style={{ ...sectionStyle, display: activeSection === "staff" ? "block" : "none" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{SECTION_LABELS.staff}</h2>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              type="button"
              onClick={() => setStaffPanelCollapsed((v) => !v)}
              style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "6px 10px", background: "#fff", fontWeight: 600, cursor: "pointer", color: "#000000" }}
            >
              {staffPanelCollapsed ? "展开" : "折叠"}
            </button>
            <button
              type="button"
              onClick={() => void loadStaff()}
              disabled={loading}
              style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "6px 12px", background: "#fff", cursor: "pointer", color: "#000000" }}
            >
              刷新
            </button>
          </div>
        </div>
        {staffPanelCollapsed ? (
          <p style={{ color: "#000000", fontSize: 13, margin: 0 }}>已折叠，可防止误删。点击「展开」后显示添加员工与员工列表（含设置密码、删除等操作）。</p>
        ) : (
          <>
        <div style={{ marginBottom: 12 }}>
          <button
            type="button"
            onClick={() => { setShowStaffModal(true); setStaffForm({ id: "", name: "", phone: "", password: "" }); }}
            style={{ border: "none", borderRadius: 8, padding: "8px 14px", background: "#2563eb", color: "#fff", fontWeight: 600, cursor: "pointer" }}
          >
            ＋ 创建账号
          </button>
          <span style={{ marginLeft: 8, fontSize: 12, color: "#000000" }}>需使用管理员身份登录</span>
        </div>
        {staffList.length === 0 ? (
          <EmptyStateCard title="暂无员工" description="请在上方添加员工账号。" />
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {staffList.map((u) => (
              <div key={u.id} style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 12, background: "#fff" }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8, alignItems: "center" }}>
                  <span><strong>账号</strong> {u.id}</span>
                  <span><strong>姓名</strong> {u.name}</span>
                  <span><strong>手机</strong> {u.phone}</span>
                  <span><strong>状态</strong> {u.status === "inactive" ? "已封禁" : "正常"}</span>
                  <span style={{ color: "#000000", fontSize: 12 }}>{u.createdAt.slice(0, 10)}</span>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={() => setSettingPasswordFor(settingPasswordFor === u.id ? null : u.id)}
                      disabled={loading}
                      style={{ border: "1px solid #059669", color: "#059669", borderRadius: 8, padding: "6px 10px", background: "#f0fdf4", cursor: "pointer", fontSize: 13 }}
                    >
                      {settingPasswordFor === u.id ? "取消" : "设置密码"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void confirmDeleteStaff(u.id, u.name)}
                      disabled={loading}
                      style={{ border: "1px solid #dc2626", color: "#dc2626", borderRadius: 8, padding: "6px 10px", background: "#fef2f2", cursor: "pointer", fontSize: 13 }}
                    >
                      删除
                    </button>
                  </div>
                </div>
                {settingPasswordFor === u.id ? (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #e5e7eb", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <input
                      type="password"
                      value={settingPasswordValue}
                      onChange={(e) => setSettingPasswordValue(e.target.value)}
                      placeholder="输入新密码"
                      style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "6px 10px", width: 180 }}
                    />
                    <button
                      type="button"
                      onClick={() => void submitSetPassword(u.id)}
                      disabled={loading || !settingPasswordValue.trim()}
                      style={{ border: "none", borderRadius: 8, padding: "6px 12px", background: "#059669", color: "#fff", cursor: "pointer" }}
                    >
                      确认
                    </button>
                    <button
                      type="button"
                      onClick={() => { setSettingPasswordFor(null); setSettingPasswordValue(""); }}
                      style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "6px 12px", background: "#fff", cursor: "pointer", color: "#000000" }}
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
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "6px 12px", background: "#fff", cursor: "pointer", color: "#000000" }}
          >
            刷新
          </button>
        </div>
        <div style={{ marginBottom: 12 }}>
          <button
            type="button"
            onClick={() => { setShowClientModal(true); setEditingClientId(null); setClientForm({ id: "", name: "", companyName: "", phone: "", email: "", password: "" }); }}
            style={{ border: "none", borderRadius: 8, padding: "8px 14px", background: "#2563eb", color: "#fff", fontWeight: 600, cursor: "pointer" }}
          >
            ＋ 创建账号
          </button>
        </div>
        {clientList.length === 0 ? (
          <EmptyStateCard title="暂无客户" description="请在上方添加客户。" />
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {clientList.map((u) => (
              <div key={u.id} style={{ marginBottom: 8 }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8, ...cardStyle }}>
                  <span><strong>账号</strong> {u.id}</span>
                  <span><strong>客户名字</strong> {u.name}</span>
                  <span><strong>公司名字</strong> {u.companyName ?? "-"}</span>
                  <span><strong>电话</strong> {u.phone}</span>
                  <span><strong>邮箱</strong> {u.email ?? "-"}</span>
                  <span><strong>状态</strong> {u.status === "inactive" ? "已封禁" : "正常"}</span>
                  <span style={{ color: "#000000", fontSize: 12 }}>{u.createdAt.slice(0, 10)}</span>
                  <button
                    type="button"
                    onClick={() => setSettingPasswordFor(settingPasswordFor === u.id ? null : u.id)}
                    disabled={loading}
                    style={{ border: "1px solid #059669", color: "#059669", borderRadius: 8, padding: "6px 10px", background: "#f0fdf4", cursor: "pointer", fontSize: 13 }}
                  >
                    {settingPasswordFor === u.id ? "取消" : "设置密码"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingClientId(u.id);
                      setClientForm({
                        id: u.id,
                        name: u.name,
                        companyName: u.companyName ?? "",
                        phone: u.phone,
                        email: u.email ?? "",
                        password: "",
                      });
                      setShowClientModal(true);
                    }}
                    disabled={loading}
                    style={{ border: "1px solid #f59e0b", color: "#d97706", borderRadius: 8, padding: "6px 10px", background: "#fffbeb", cursor: "pointer", fontSize: 13 }}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    onClick={() => confirmDeleteClient(u.id, u.name)}
                    disabled={loading}
                    style={{ border: "1px solid #fca5a5", color: "#dc2626", borderRadius: 8, padding: "6px 10px", background: "#fef2f2", cursor: "pointer", fontSize: 13 }}
                  >
                    删除
                  </button>
                </div>
                {settingPasswordFor === u.id ? (
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #e5e7eb", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <input
                      type="password"
                      value={settingPasswordValue}
                      onChange={(e) => setSettingPasswordValue(e.target.value)}
                      placeholder="输入新密码"
                      style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "6px 10px", width: 180 }}
                    />
                    <button
                      type="button"
                      onClick={() => void submitSetPassword(u.id)}
                      disabled={loading || !settingPasswordValue.trim()}
                      style={{ border: "none", borderRadius: 8, padding: "6px 12px", background: "#059669", color: "#fff", cursor: "pointer" }}
                    >
                      确认
                    </button>
                    <button
                      type="button"
                      onClick={() => { setSettingPasswordFor(null); setSettingPasswordValue(""); }}
                      style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "6px 12px", background: "#fff", cursor: "pointer", color: "#000000" }}
                    >
                      取消
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 4. 运单管理 */}
      <section id="orders" style={{ ...sectionStyle, display: activeSection === "orders" ? "block" : "none" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{SECTION_LABELS.orders}</h2>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              type="button"
              onClick={() => setOrdersPanelCollapsed((v) => !v)}
              style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "6px 10px", background: "#fff", fontWeight: 600, cursor: "pointer", color: "#000000" }}
            >
              {ordersPanelCollapsed ? "展开" : "折叠"}
            </button>
            <button
              type="button"
              onClick={async () => { const clients = await fetchStaffClients(); setStaffClients(clients); setShowCreateOrderModal(true); }}
              style={{ border: "none", borderRadius: 8, padding: "6px 12px", color: "#fff", background: "#16a34a", cursor: "pointer", fontWeight: 600 }}
            >
              ＋ 创建订单
            </button>
            <button
              type="button"
              onClick={() => setShowBatchImport(true)}
              style={{ border: "1px solid #d97706", borderRadius: 8, padding: "6px 12px", color: "#d97706", background: "#fffbeb", cursor: "pointer", fontWeight: 600 }}
            >
              📥 批量导入
            </button>
            <input type="date" value={exportDateFrom} onChange={e => setExportDateFrom(e.target.value)}
              style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "5px 6px", fontSize: 11 }} title="导出日期从" />
            <span style={{ fontSize: 11, color: "#9ca3af" }}>至</span>
            <input type="date" value={exportDateTo} onChange={e => setExportDateTo(e.target.value)}
              style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "5px 6px", fontSize: 11 }} title="导出日期到" />
            <button type="button" onClick={exportOrdersToExcel}
              style={{ border: "none", borderRadius: 8, padding: "6px 12px", color: "#fff", background: "#2563eb", cursor: "pointer", fontSize: 13 }}>
              导出Excel
            </button>
            <button
              type="button"
              onClick={() => void loadOrders()}
              disabled={loading}
              style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "6px 12px", background: "#fff", cursor: "pointer", color: "#000000" }}
            >
              刷新
            </button>
          </div>
        </div>
        {!ordersPanelCollapsed ? (
          <ShipmentSearch
            value={orderSearch}
            onChange={(key, val) => setOrderSearch((prev) => ({ ...prev, [key]: val }))}
            onSearch={() => {}}
            warehouseOptions={warehouseOptions}
            logisticsStatusOptions={logisticsStatusOptions as unknown as string[]}
            inputStyle={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", fontSize: 13 }}
          />
        ) : null}
        {ordersPanelCollapsed ? (
          <p style={{ color: "#000000", fontSize: 13, margin: 0 }}>已折叠。点击「展开」可查看订单列表并导出 Excel。</p>
        ) : filteredOrderList.length === 0 ? (
          <EmptyStateCard title="暂无匹配订单" description="无匹配结果" />
        ) : (
          <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, padding: "0 8px" }}>
            <span style={{ fontSize: 12, color: "#000000" }}>共 {filteredOrderList.length} 条</span>
            <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "4px 8px", fontSize: 12 }}>
              {[20, 50, 100, 200, 500, 1000].map((n) => <option key={n} value={n}>{n}条/页</option>)}
            </select>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 1700 }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #e2e8f0", textAlign: "left" }}>
                  <th style={{ padding: "10px 8px", width: 44 }}>
                    <input type="checkbox" checked={selectedOrders.size === filteredOrderList.length && filteredOrderList.length > 0} onChange={toggleSelectAllOrders} style={{ cursor: "pointer" }} />
                  </th>
                  <th style={{ padding: "10px 8px", whiteSpace: "nowrap" }}>唛头</th>
                  <th style={{ padding: "10px 8px", whiteSpace: "nowrap" }}>运单号</th>
                  <th style={{ padding: "10px 8px", whiteSpace: "nowrap" }}>到仓日期</th>
                  <th style={{ padding: "10px 8px", minWidth: 120 }}>品名</th>
                  <th style={{ padding: "10px 8px", whiteSpace: "nowrap" }}>箱数</th>
                  <th style={{ padding: "10px 8px", whiteSpace: "nowrap" }}>单箱数量</th>
                  <th style={{ padding: "10px 8px", whiteSpace: "nowrap" }}>长宽高(cm)</th>
                  <th style={{ padding: "10px 8px", whiteSpace: "nowrap" }}>国内单号</th>
                  <th style={{ padding: "10px 8px", whiteSpace: "nowrap" }}>体积</th>
                  <th style={{ padding: "10px 8px", whiteSpace: "nowrap" }}>重量</th>
                  <th style={{ padding: "10px 8px", whiteSpace: "nowrap" }}>运输方式</th>
                  <th style={{ padding: "10px 8px", whiteSpace: "nowrap" }}>货型</th>
                  <th style={{ padding: "10px 8px", whiteSpace: "nowrap" }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {pagedOrders.map((o) => (
                  <Fragment key={o.id}>
                  <tr style={{ borderBottom: "1px solid #e2e8f0", background: expandedOrderId === o.id ? "#eff6ff" : "#fff" }}>
                    <td style={{ padding: "8px 6px", verticalAlign: "middle", whiteSpace: "nowrap" }}>
                      <input type="checkbox" checked={selectedOrders.has(o.id)} onChange={() => toggleSelectOrder(o.id)} style={{ cursor: "pointer", marginRight: 4 }} />
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
                        style={{ border: "1px solid #cbd5e1", borderRadius: 6, width: 28, height: 28, background: "#fff", cursor: "pointer", fontSize: 16, lineHeight: 1, color: "#0f172a" }}
                      >
                        {expandedOrderId === o.id ? "−" : "+"}
                      </button>
                    </td>
                    <td style={{ padding: "8px 6px", color: "#000000", fontWeight: 600 }}>{o.clientId ?? "—"}</td>
                    <td style={{ padding: "8px 6px", fontWeight: 600, color: "#1e3a8a", whiteSpace: "nowrap" }}>
                      {o.trackingNo ?? "—"}
                    </td>
                    <td style={{ padding: "8px 6px", whiteSpace: "nowrap", color: "#000000" }}>
                      {o.shipDate ?? o.createdAt.slice(0, 10)}
                    </td>
                    <td style={{ padding: "8px 6px", color: "#000000", minWidth: 120 }}>
                      {(o.products?.length ?? 0) > 0
                        ? (o.products ?? []).map((p, i) => (
                            <div key={i} style={{ marginBottom: i < (o.products?.length ?? 0) - 1 ? 2 : 0, whiteSpace: "nowrap" }}>
                              {p.itemName}
                            </div>
                          ))
                        : (o.itemName ?? "—")}
                    </td>
                    <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>
                      {(o.products?.length ?? 0) > 0
                        ? (o.products ?? []).map((p, i) => (
                            <div key={i} style={{ marginBottom: i < (o.products?.length ?? 0) - 1 ? 2 : 0 }}>
                              {p.packageCount}箱
                            </div>
                          ))
                        : "—"}
                    </td>
                    <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>
                      {(o.products?.length ?? 0) > 0
                        ? (o.products ?? []).map((p, i) => (
                            <div key={i} style={{ marginBottom: i < (o.products?.length ?? 0) - 1 ? 2 : 0 }}>
                              {p.productQuantity ? `${p.productQuantity}个/箱` : "—"}
                            </div>
                          ))
                        : "—"}
                    </td>
                    <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>
                      {(o.products?.length ?? 0) > 0
                        ? (o.products ?? []).map((p, i) => (
                            <div key={i} style={{ marginBottom: i < (o.products?.length ?? 0) - 1 ? 2 : 0 }}>
                              {p.lengthCm ? `${p.lengthCm}×${p.widthCm}×${p.heightCm}cm` : "—"}
                            </div>
                          ))
                        : "—"}
                    </td>
                    <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>
                      {(o.products?.length ?? 0) > 0
                        ? (o.products ?? []).map((p, i) => (
                            <div key={i} style={{ marginBottom: i < (o.products?.length ?? 0) - 1 ? 2 : 0 }}>
                              {p.domesticTrackingNo || "货拉拉"}
                            </div>
                          ))
                        : (o.domesticTrackingNo || "—")}
                    </td>
                    <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>{o.volumeM3 ?? "—"}</td>
                    <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>{o.weightKg ?? "—"}</td>
                    <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>{transportModeLabel(o.transportMode)}</td>
                    <td style={{ padding: "8px 6px", whiteSpace: "nowrap", fontSize: 12 }}>
                      {(o.products?.length ?? 0) > 0
                        ? (o.products ?? []).map((p, i) => (
                            <div key={i} style={{ marginBottom: i < (o.products?.length ?? 0) - 1 ? 2 : 0 }}>
                              {((p.cargoType ?? "normal").toLowerCase() === "inspection" ? "商检" : (p.cargoType ?? "normal").toLowerCase() === "sensitive" ? "敏感" : "普货")}
                            </div>
                          ))
                        : ((o.cargoType ?? "normal").toLowerCase() === "inspection" ? "商检" : (o.cargoType ?? "normal").toLowerCase() === "sensitive" ? "敏感" : "普货")}
                    </td>
                    <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>
                      <button
                        type="button"
                        onClick={() => {
                          if (editingOrderId === (o.orderId ?? o.id)) {
                            setEditingOrderId("");
                          } else {
                            startEditOrder(o);
                          }
                        }}
                        style={{ border: "1px solid #bfdbfe", borderRadius: 8, padding: "4px 10px", background: editingOrderId === (o.orderId ?? o.id) ? "#e0e7ff" : "#eff6ff", color: "#1d4ed8", cursor: "pointer", fontWeight: 700, marginRight: 6 }}
                      >
                        {editingOrderId === (o.orderId ?? o.id) ? "收起" : "编辑"}
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
                        style={{ border: "1px solid #fecaca", borderRadius: 8, padding: "4px 10px", background: "#fef2f2", color: "#dc2626", cursor: "pointer", fontWeight: 700 }}
                      >
                        删除
                      </button>
                      <button
                        type="button"
                        onClick={() => openShipmentTrack(o.trackingNo ?? o.id)}
                        style={{ border: "none", background: "transparent", color: "#2563eb", cursor: "pointer", fontWeight: 600, padding: 0, marginLeft: 8 }}
                      >
                        物流轨迹
                      </button>
                      <button
                        type="button"
                        onClick={() => openPrintLabel({ marks: o.clientName ?? o.clientId ?? "—", packageCount: o.packageCount ?? "—", trackingNo: o.trackingNo ?? "", itemName: o.itemName, productQuantity: o.productQuantity, transportMode: o.transportMode, products: (o.products ?? []).map(p => ({ itemName: p.itemName, packageCount: p.packageCount })) })}
                        style={{ border: "none", background: "transparent", color: "#16a34a", cursor: "pointer", fontWeight: 600, padding: 0, marginLeft: 8 }}
                      >
                        打印
                      </button>

                    </td>
                  </tr>
                  {expandedOrderId === o.id ? (
                    <tr>
                      <td colSpan={14} style={{ padding: 0, background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                        <div style={{ padding: 14 }}>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 20px", marginBottom: 12, padding: 8, background: "#f1f5f9", borderRadius: 6, fontSize: 12 }}>
                            <span>仓库：<strong>{warehouseOptions.find(w => w.id === o.warehouseId)?.label ?? "—"}</strong></span>
                            <span>柜号：<strong>{o.batchNo ?? "—"}</strong></span>
                            <span>包装：<strong>{o.packageUnit === "bag" ? "袋" : "箱"}</strong></span>
                            <span>国内单号：<strong>{((o.products?.length ?? 0) > 0) ? (o.products ?? []).map(p => p.domesticTrackingNo || "货拉拉").filter((v, i, a) => a.indexOf(v) === i).join("、") : (o.domesticTrackingNo ?? "—")}</strong></span>
                            <span>加收金额：<strong>{o.receivableAmountCny != null ? `${o.receivableAmountCny} ${o.receivableCurrency ?? "CNY"}` : "—"}</strong></span>
                            <span>收货地址：<strong>{o.receiverAddressTh ?? "—"}</strong></span>
                          </div>
                          {(o.productImages?.length ?? 0) > 0 || (orderImagesCache[o.orderId ?? o.id]?.length ?? 0) > 0 ? (
                            <div style={{ marginBottom: 10, padding: 10, background: "#f8fafc", borderRadius: 8, border: "1px solid #e2e8f0" }}>
                              <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13, color: "#000000" }}>产品图</div>
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                                {(orderImagesCache[o.orderId ?? o.id] ?? o.productImages ?? []).map((img: any) => (
                                  <div key={img.id} style={{ position: "relative" }}>
                                    <img src={img.imageUrl ? `${apiBaseUrl()}${img.imageUrl}` : `data:${img.mime};base64,${img.contentBase64}`} alt={img.fileName} style={{ width: 88, height: 88, objectFit: "cover", borderRadius: 8, border: "1px solid #e5e7eb" }} />
                                    <button type="button" onClick={async () => { await deleteStaffOrderProductImage(img.id); const oid = o.orderId ?? o.id; const imgs = await fetchShipmentImages(oid); setOrderImagesCache((c) => ({ ...c, [oid]: imgs })); }} style={{ position: "absolute", top: -4, right: -4, width: 18, height: 18, borderRadius: "50%", background: "#dc2626", color: "#fff", border: "none", cursor: "pointer", fontSize: 11, lineHeight: 1 }}>×</button>
                                  </div>
                                ))}
                              </div>
                              <div style={{ marginTop: 8 }}>
                                <input type="file" accept="image/*" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; const oid = o.orderId ?? o.id; try { const toBase64 = (file: File) => new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onloadend = () => resolve((r.result as string).split(",")[1]); r.onerror = () => reject(new Error("文件读取失败")); r.readAsDataURL(file); }); const base64 = await toBase64(f); await uploadStaffOrderProductImage({ orderId: oid, fileName: f.name, mime: f.type, contentBase64: base64 }); const imgs = await fetchShipmentImages(oid); setOrderImagesCache((c) => ({ ...c, [oid]: imgs })); setToast("产品图已上传"); } catch (err) { setMessage("上传失败：" + (err instanceof Error ? err.message : "未知错误")); } }} style={{ fontSize: 12 }} />
                              </div>
                            </div>
                          ) : (
                            <div style={{ marginBottom: 10 }}>
                              <input type="file" accept="image/*" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; const oid = o.orderId ?? o.id; try { const toBase64 = (file: File) => new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onloadend = () => resolve((r.result as string).split(",")[1]); r.onerror = () => reject(new Error("文件读取失败")); r.readAsDataURL(file); }); const base64 = await toBase64(f); await uploadStaffOrderProductImage({ orderId: oid, fileName: f.name, mime: f.type, contentBase64: base64 }); const imgs = await fetchShipmentImages(oid); setOrderImagesCache((c) => ({ ...c, [oid]: imgs })); setToast("产品图已上传"); } catch (err) { setMessage("上传失败：" + (err instanceof Error ? err.message : "未知错误")); } }} style={{ fontSize: 12, color: "#2563eb" }} />
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                  {editingOrderId === (o.orderId ?? o.id) ? (
                    <tr key={`edit-${o.id}`} style={{ background: "#f8fafc" }}>
                      <td colSpan={14} style={{ padding: 12 }}>
                        <div style={{ display: "grid", gap: 8 }}>
                          <div style={{ fontWeight: 700, color: "#0f172a" }}>编辑：{o.trackingNo ?? "—"}</div>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
                            <input value={orderEditForm.clientId} onChange={(e) => setOrderEditForm((v) => ({ ...v, clientId: e.target.value }))} placeholder="唛头" list="admin-client-options" autoComplete="off" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
                            <datalist id="admin-client-options">{clientList.map((c) => (<option key={c.id} value={c.id}>{c.id}</option>))}</datalist>
                            <input value={orderEditForm.trackingNo} onChange={(e) => setOrderEditForm((v) => ({ ...v, trackingNo: e.target.value.toUpperCase() }))} placeholder="运单号" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
                            <input value={orderEditForm.batchNo} onChange={(e) => setOrderEditForm((v) => ({ ...v, batchNo: e.target.value }))} placeholder="柜号" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
                            <select value={orderEditForm.warehouseId} onChange={(e) => setOrderEditForm((v) => ({ ...v, warehouseId: e.target.value }))} style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}><option value="wh_yiwu_01">义乌仓</option><option value="wh_guangzhou_01">广州仓</option><option value="wh_dongguan_01">东莞仓</option><option value="wh_shenzhen_01">深圳仓</option></select>
                            <select value={orderEditForm.transportMode} onChange={(e) => setOrderEditForm((v) => ({ ...v, transportMode: e.target.value as "sea" | "land" }))} style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}><option value="sea">海运</option><option value="land">陆运</option></select>
                            <input value={orderEditForm.domesticTrackingNo} onChange={(e) => setOrderEditForm((v) => ({ ...v, domesticTrackingNo: e.target.value }))} placeholder="货拉拉" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
                            <input value={orderEditForm.receiverAddressTh} onChange={(e) => setOrderEditForm((v) => ({ ...v, receiverAddressTh: e.target.value }))} placeholder="收货地址" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
                            <input value={orderEditForm.containerNo} onChange={(e) => setOrderEditForm((v) => ({ ...v, containerNo: e.target.value }))} placeholder="装柜号" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
                            <select value={orderEditForm.packageUnit} onChange={(e) => setOrderEditForm((v) => ({ ...v, packageUnit: e.target.value as "bag" | "box" }))} style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}><option value="box">箱</option><option value="bag">袋</option></select>
                            <input value={orderEditForm.weightKg} onChange={(e) => setOrderEditForm((v) => ({ ...v, weightKg: e.target.value }))} placeholder="重量(kg)" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
                            <input value={orderEditForm.volumeM3} onChange={(e) => setOrderEditForm((v) => ({ ...v, volumeM3: e.target.value }))} placeholder="体积(m³)" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
                            <input value={orderEditForm.receivableAmountCny} onChange={(e) => setOrderEditForm((v) => ({ ...v, receivableAmountCny: e.target.value }))} placeholder="应收金额(CNY)" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
                            <select value={orderEditForm.receivableCurrency} onChange={(e) => setOrderEditForm((v) => ({ ...v, receivableCurrency: e.target.value as "CNY" | "THB" }))} style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}><option value="CNY">CNY</option><option value="THB">THB</option></select>
                            <select value={orderEditForm.paymentStatus} onChange={(e) => setOrderEditForm((v) => ({ ...v, paymentStatus: e.target.value as "paid" | "unpaid" }))} style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}><option value="unpaid">未支付</option><option value="paid">已支付</option></select>
                            <input type="date" value={orderEditForm.shipDate} onChange={(e) => setOrderEditForm((v) => ({ ...v, shipDate: e.target.value }))} style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
                          </div>
                          <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, background: "#f9fafb", marginTop: 8 }}>
                            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, color: "#000000" }}>产品行编辑</div>
                            {editProducts.length === 0 && (
                              <div style={{ fontSize: 12, color: "#9ca3af", padding: "4px 0" }}>无产品行，点击下方按钮添加</div>
                            )}
                            {editProducts.map((p, i) => (
                              <div key={i} style={{ display: "grid", gridTemplateColumns: "2fr 0.4fr 0.3fr 0.3fr 0.3fr 0.4fr 0.45fr 0.8fr 1fr auto", gap: 4, marginBottom: 4, alignItems: "center" }}>
                                <input value={p.itemName} onChange={(e) => { const n = [...editProducts]; n[i] = { ...n[i], itemName: e.target.value }; setEditProducts(n); }} placeholder="品名" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
                                <input type="number" value={p.packageCount} onChange={(e) => { const n = [...editProducts]; n[i] = { ...n[i], packageCount: e.target.value }; setEditProducts(n); }} placeholder="箱数" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
                                <input type="number" step="0.01" value={p.lengthCm} onChange={(e) => { const n = [...editProducts]; n[i] = { ...n[i], lengthCm: e.target.value }; setEditProducts(n); }} placeholder="长cm" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
                                <input type="number" step="0.01" value={p.widthCm} onChange={(e) => { const n = [...editProducts]; n[i] = { ...n[i], widthCm: e.target.value }; setEditProducts(n); }} placeholder="宽cm" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
                                <input type="number" step="0.01" value={p.heightCm} onChange={(e) => { const n = [...editProducts]; n[i] = { ...n[i], heightCm: e.target.value }; setEditProducts(n); }} placeholder="高cm" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
                                <input type="number" value={p.productQuantity} onChange={(e) => { const n = [...editProducts]; n[i] = { ...n[i], productQuantity: e.target.value }; setEditProducts(n); }} placeholder="单箱数量" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
                                <input type="number" step="0.01" value={p.weightKg} onChange={(e) => { const n = [...editProducts]; n[i] = { ...n[i], weightKg: e.target.value }; setEditProducts(n); }} placeholder="单箱重kg" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
                                <select value={(p.cargoType || "normal").toLowerCase()} onChange={(e) => { const n = [...editProducts]; n[i] = { ...n[i], cargoType: e.target.value }; setEditProducts(n); }} style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "4px 6px", fontSize: 12, background: "#fff" }}>
                                  <option value="normal">普货</option>
                                  <option value="inspection">商检</option>
                                  <option value="sensitive">敏感</option>
                                </select>
                                <input value={p.domesticTrackingNo || ""} onChange={(e) => { const n = [...editProducts]; n[i] = { ...n[i], domesticTrackingNo: e.target.value }; setEditProducts(n); }} placeholder="货拉拉" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
                                <button type="button" onClick={() => setEditProducts((v) => v.filter((_, j) => j !== i))} style={{ border: "1px solid #fca5a5", borderRadius: 4, padding: "4px 6px", fontSize: 11, background: "#fff", color: "#dc2626", cursor: "pointer" }}>X</button>
                              </div>
                            ))}
                            <button type="button" onClick={() => setEditProducts((v) => [...v, { itemName: "", packageCount: "", lengthCm: "", widthCm: "", heightCm: "", productQuantity: "", weightKg: "", cargoType: "normal", domesticTrackingNo: "" }])} style={{ border: "1px dashed #2563eb", borderRadius: 4, padding: "4px 10px", fontSize: 12, background: "#fff", color: "#2563eb", cursor: "pointer", marginTop: 4 }}>+ 添加产品</button>
                          </div>
                          {(o.productImages?.length ?? 0) > 0 && (
                            <div style={{ marginTop: 8, padding: 10, background: "#f8fafc", borderRadius: 8, border: "1px solid #e2e8f0" }}>
                              <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13, color: "#000000" }}>产品图</div>
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                                {o.productImages!.map((img) => (
                                  <img key={img.id} src={img.imageUrl ? `${apiBaseUrl()}${img.imageUrl}` : `data:${img.mime};base64,${img.contentBase64}`} alt={img.fileName} style={{ width: 88, height: 88, objectFit: "cover", borderRadius: 8, border: "1px solid #e5e7eb" }} />
                                ))}
                              </div>
                            </div>
                          )}
                          <div style={{ display: "flex", gap: 8 }}>
                            <button type="button" onClick={() => void submitOrderEdit()} disabled={loading} style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff", background: "#2563eb", cursor: "pointer" }}>保存</button>
                            <button type="button" onClick={() => setEditingOrderId("")} style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 14px", background: "#fff", cursor: "pointer", color: "#000000" }}>取消</button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </section>

      {/* 入库与标签工具 */}
      <section id="ops-tools" style={{ ...sectionStyle, display: activeSection === "ops-tools" ? "block" : "none" }}>
        <h2 style={{ margin: "0 0 16px", fontSize: 18 }}>{SECTION_LABELS["ops-tools"]}</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16 }}>
          <div style={{ padding: 16, background: "#f8fafc", borderRadius: 8, border: "1px solid #e2e8f0" }}>
            <h4 style={{ margin: "0 0 12px", fontSize: 14 }}>体积重量核算</h4>
            <div style={{ display: "grid", gap: 8 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input value={calcLength} onChange={(e) => setCalcLength(e.target.value)} placeholder="长(cm)" style={prealertEditInputStyle} />
                <span style={{ color: "#000000" }}>×</span>
                <input value={calcWidth} onChange={(e) => setCalcWidth(e.target.value)} placeholder="宽(cm)" style={prealertEditInputStyle} />
                <span style={{ color: "#000000" }}>×</span>
                <input value={calcHeight} onChange={(e) => setCalcHeight(e.target.value)} placeholder="高(cm)" style={prealertEditInputStyle} />
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: 12, minWidth: 60 }}>数量：</span>
                <input type="number" value={calcQty} onChange={(e) => setCalcQty(e.target.value)} style={{ ...prealertEditInputStyle, width: 80 }} />
                <span style={{ fontSize: 12, color: "#000000" }}>箱</span>
                <button onClick={() => {
                  const l = Number(calcLength); const w = Number(calcWidth); const h = Number(calcHeight); const q = Number(calcQty);
                  if (!l || !w || !h) { setCalcResult("请填写长宽高"); return; }
                  const volM3 = (l * w * h * q) / 1_000_000;
                  const weightEst = volM3 * 167;
                  setCalcResult(`${volM3.toFixed(3)} m³（≈ ${weightEst.toFixed(1)} kg）`);
                }} style={{ border: "none", borderRadius: 6, padding: "6px 12px", background: "#2563eb", color: "#fff", cursor: "pointer", fontSize: 12 }}>计算</button>
              </div>
              {calcResult && <div style={{ fontSize: 14, fontWeight: 600, color: "#16a34a" }}>{calcResult}</div>}
            </div>
          </div>
          <div style={{ padding: 16, background: "#f8fafc", borderRadius: 8, border: "1px solid #e2e8f0" }}>
            <h4 style={{ margin: "0 0 12px", fontSize: 14 }}>标签打印</h4>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <p style={{ fontSize: 12, color: "#000000", margin: 0 }}>在运单管理列表中点击「打印」按钮即可打印 FBA 标签 / 面单 / 箱号条码。</p>
              <p style={{ fontSize: 12, color: "#000000", margin: 0 }}>支持：唛头、运单号、品名、箱数、运输方式等信息一键打印。</p>
            </div>
          </div>
        </div>
      </section>

      {/* 尾端派送 */}
      <section id="lastmile" style={{ ...sectionStyle, display: activeSection === "lastmile" ? "block" : "none" }}>
        <h2 style={{ margin: "0 0 16px", fontSize: 18 }}>{SECTION_LABELS["lastmile"]}</h2>

        {/* 创建派送单 */}
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 16, marginBottom: 16, background: "#f8fafc" }}>
          <h4 style={{ margin: "0 0 12px", fontSize: 14 }}>创建派送单</h4>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, maxWidth: 600 }}>
            <div style={{ border: "1px solid #e5e7eb", borderRadius: 6, padding: 8, background: "#fff", gridColumn: "1/-1" }}>
              <input value={lmShipSearch} onChange={e=>setLmShipSearch(e.target.value)} onFocus={()=>loadLmShipments()} placeholder="搜索运单（已到泰国的）..." style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 8px", fontSize: 12, width: "100%", marginBottom: 4 }} />
              <div style={{ maxHeight: 150, overflow: "auto" }}>
                {lmShipments.filter(s=>!lmShipSearch||(s.trackingNo||"").includes(lmShipSearch)||(s.clientId||"").includes(lmShipSearch)).slice(0,20).map(s=>(
                  <label key={s.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 0", fontSize: 12, cursor: "pointer" }}>
                    <input type="checkbox" checked={lmSelected.has(s.id)} onChange={()=>{const n=new Set(lmSelected);n.has(s.id)?n.delete(s.id):n.add(s.id);setLmSelected(n)}} />
                    <span style={{ fontFamily: "monospace", color: "#1e3a8a", minWidth: 150 }}>{s.trackingNo}</span>
                    <span style={{ color: "#6b21a8", minWidth: 60 }}>{s.clientId}</span>
                    <span style={{ color: "#374151" }}>{s.itemName} · {s.packageCount}件</span>
                  </label>
                ))}
              </div>
              <div style={{ fontSize: 11, color: "#6b7280", marginTop: 4 }}>已选 {lmSelected.size} 个运单</div>
            </div>
            <input value={lmForm.driverName} onChange={e => setLmForm(f => ({...f, driverName: e.target.value}))} placeholder="司机姓名" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 12px", fontSize: 13 }} />
            <input value={lmForm.licensePlate} onChange={e => setLmForm(f => ({...f, licensePlate: e.target.value}))} placeholder="车牌号" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 12px", fontSize: 13 }} />
            <input value={lmForm.phoneNumber} onChange={e => setLmForm(f => ({...f, phoneNumber: e.target.value}))} placeholder="电话" />
            <input type="date" value={lmForm.deliveryDate} onChange={e => setLmForm(f => ({...f, deliveryDate: e.target.value}))} placeholder="派送日期" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 12px", fontSize: 13 }} />
          </div>
          <button disabled={loading || lmSelected.size===0} onClick={async () => {
            setLoading(true);
            try {
              (()=>{const ids=Array.from(lmSelected);return fetch(apiBaseUrl()+"/admin/lastmile/orders",{method:"POST",headers:{"Content-Type":"application/json",...authHeaders()},body:JSON.stringify({shipmentIds:ids,driverName:lmForm.driverName.trim(),licensePlate:lmForm.licensePlate.trim(),phoneNumber:lmForm.phoneNumber.trim(),deliveryDate:lmForm.deliveryDate})}).then(r=>r.json()).then(d=>{if(d.code!=="OK")throw new Error(d.message||"创建失败");setToast(d.data.deliveryNo+" 已创建（"+d.data.count+"个运单）")})})();
              setToast("派送单已创建");
              setLmForm({ driverName: "", licensePlate: "", phoneNumber: "", deliveryDate: "" }); setLmSelected(new Set());
              loadLastmileOrders();
            } catch (e: any) { setToast(e.message ?? "创建失败"); }
            finally { setLoading(false); }
          }} style={{ marginTop: 8, border: "none", borderRadius: 6, padding: "8px 16px", background: "#2563eb", color: "#fff", cursor: "pointer", fontSize: 13 }}>创建派送单</button>
        </div>

        {/* 派送列表 */}
        {lmOrders.length === 0 ? <p style={{ color: "#6b7280", fontSize: 13 }}>暂无派送单</p> : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr style={{ borderBottom: "2px solid #e2e8f0", textAlign: "left" }}>
                <th style={{ padding: "6px 8px" }}>派送单号</th>
                <th style={{ padding: "6px 8px" }}>运单号</th>
                <th style={{ padding: "6px 8px" }}>司机</th>
                <th style={{ padding: "6px 8px" }}>车牌</th>
                <th style={{ padding: "6px 8px" }}>电话</th>
                <th style={{ padding: "6px 8px" }}>派送日期</th>
                <th style={{ padding: "6px 8px" }}>状态</th>
                <th style={{ padding: "6px 8px" }}>操作</th>
              </tr></thead>
              <tbody>
                {lmOrders.map(o => (
                  <tr key={o.id} style={{ borderBottom: "1px solid #e2e8f0" }}>
                    <td style={{ padding: "6px 8px", fontFamily: "monospace", fontSize: 11 }}>{o.deliveryNo}</td>
                    <td style={{ padding: "6px 8px", fontFamily: "monospace" }}>{o.trackingNo || o.shipmentId}</td>
                    <td style={{ padding: "6px 8px" }}>{o.driverName ?? "-"}</td>
                    <td style={{ padding: "6px 8px" }}>{o.licensePlate ?? "-"}</td>
                    <td style={{ padding: "6px 8px" }}>{o.phoneNumber ?? "-"}</td>
                    <td style={{ padding: "6px 8px" }}>{o.deliveryDate || "-"}</td>
                    <td style={{ padding: "6px 8px" }}>{o.status === "SIGNED" ? <>✅ 已签收{o.signImageBase64?<img src={"data:image/jpeg;base64,"+o.signImageBase64} style={{maxWidth:40,maxHeight:40,borderRadius:4,marginLeft:4}} alt="" />:null}</> : o.status === "DELIVERING" ? "🚚 派送中" : o.status}</td>
                    <td style={{ padding: "6px 8px" }}>
                      {o.status !== "SIGNED" && (
                        <button onClick={async () => {
                          setLmSignData({id:o.id,base64:""}); lmSignFileRef.current?.click();
                        }} style={{ border: "1px solid #16a34a", borderRadius: 4, padding: "2px 8px", fontSize: 11, background: "#fff", color: "#16a34a", cursor: "pointer" }}>签收</button>
                      )}
                      <button onClick={async ()=>{if(!confirm("确定删除？"))return;try{await fetch(apiBaseUrl()+"/admin/lastmile/orders?id="+o.id,{method:"DELETE",headers:authHeaders()});setToast("已删除");loadLastmileOrders()}catch(e:any){setToast(e.message||"失败")}}} style={{ border: "1px solid #fca5a5", borderRadius: 4, padding: "2px 6px", fontSize: 11, background: "#fff", color: "#dc2626", cursor: "pointer", marginLeft: 4 }}>删除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <input ref={lmSignFileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={async (e) => {
          const f = e.target.files?.[0]; e.target.value = "";
          if (!f || !lmSignData) return;
          const reader = new FileReader();
          reader.onload = async () => {
            const base64 = (reader.result as string).split(",")[1] || "";
            try {
              await updateLastmileStatus(lmSignData.id, "SIGNED", base64);
              loadLastmileOrders();
              setToast("已签收");
            } catch(ee:any) { setToast(ee.message||"失败"); }
            setLmSignData(null);
          };
          reader.readAsDataURL(f);
        }} />
      </section>

      {/* 尾端地址 */}
      <section id="lastmile-address" style={{ ...sectionStyle, display: activeSection === "lastmile-address" ? "block" : "none" }}>
        <h2 style={{ margin: "0 0 16px", fontSize: 18 }}>尾端地址</h2>
        <p style={{ fontSize: 13, color: "#6b7280" }}>客户端注册后自动同步唛头与派送地址。</p>
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
              onClick={() => { setRechargeStatusFilter(s); setTimeout(() => loadRecharges(), 0); }}
              style={{
                border: rechargeStatusFilter === s ? "2px solid #2563eb" : "1px solid #d1d5db",
                borderRadius: 8,
                padding: "6px 14px",
                background: rechargeStatusFilter === s ? "#eff6ff" : "#fff",
                color: rechargeStatusFilter === s ? "#2563eb" : "#374151",
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
          <p style={{ color: "#6b7280", fontSize: 13 }}>暂无充值申请</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#f9fafb", borderBottom: "1px solid #e5e7eb" }}>
                  <th style={{ padding: "8px 10px", textAlign: "left", fontWeight: 600, color: "#374151", whiteSpace: "nowrap" }}>时间</th>
                  <th style={{ padding: "8px 10px", textAlign: "left", fontWeight: 600, color: "#374151", whiteSpace: "nowrap" }}>客户</th>
                  <th style={{ padding: "8px 10px", textAlign: "left", fontWeight: 600, color: "#374151", whiteSpace: "nowrap" }}>币种</th>
                  <th style={{ padding: "8px 10px", textAlign: "right", fontWeight: 600, color: "#374151", whiteSpace: "nowrap" }}>金额</th>
                  <th style={{ padding: "8px 10px", textAlign: "left", fontWeight: 600, color: "#374151", whiteSpace: "nowrap" }}>支付方式</th>
                  <th style={{ padding: "8px 10px", textAlign: "left", fontWeight: 600, color: "#374151", whiteSpace: "nowrap" }}>状态</th>
                  <th style={{ padding: "8px 10px", textAlign: "left", fontWeight: 600, color: "#374151", whiteSpace: "nowrap" }}>凭证</th>
                  <th style={{ padding: "8px 10px", textAlign: "left", fontWeight: 600, color: "#374151", whiteSpace: "nowrap" }}>备注</th>
                  <th style={{ padding: "8px 10px", textAlign: "left", fontWeight: 600, color: "#374151", whiteSpace: "nowrap" }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {rechargeList.map((r) => {
                  const methodLabel = r.paymentMethod === "WECHAT" ? "微信" : r.paymentMethod === "ALIPAY" ? "支付宝" : "银行转账";
                  const statusLabel = r.status === "PENDING" ? "待审核" : r.status === "APPROVED" ? "已通过" : "已拒绝";
                  const statusColor =
                    r.status === "PENDING" ? { bg: "#fef3c7", text: "#92400e" } :
                    r.status === "APPROVED" ? { bg: "#d1fae5", text: "#065f46" } :
                    { bg: "#fee2e2", text: "#991b1b" };
                  return (
                    <tr key={r.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                      <td style={{ padding: "8px 10px", whiteSpace: "nowrap", fontSize: 12 }}>
                        {new Date(r.createdAt).toLocaleString("zh-CN", {
                          month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
                        })}
                      </td>
                      <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>{r.clientName}{r.companyName ? ` (${r.companyName})` : ""}</td>
                      <td style={{ padding: "8px 10px" }}>{r.currency}</td>
                      <td style={{ padding: "8px 10px", textAlign: "right", fontWeight: 600 }}>
                        {r.currency === "CNY" ? "¥" : "฿"}{r.amount.toFixed(2)}
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
                            if (w) { w.document.write(`<img src="${r.proofImage}" style="max-width:100%" />`); }
                          }}
                          style={{ width: 60, height: 60, objectFit: "cover", borderRadius: 6, border: "1px solid #e5e7eb", cursor: "pointer" }}
                        />
                      </td>
                      <td style={{ padding: "8px 10px", maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, color: "#6b7280" }}>
                        {r.reviewRemark || r.remark || "—"}
                      </td>
                      <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>
                        {r.status === "PENDING" ? (
                          <div style={{ display: "flex", gap: 4 }}>
                            <button
                              type="button"
                              disabled={loading}
                              onClick={async () => {
                                if (!window.confirm(`确认通过 ${r.clientName} 的 ${r.currency} ${r.amount} 充值？`)) return;
                                setLoading(true);
                                try {
                                  await approveRecharge(r.id);
                                  setToast("充值已通过");
                                  await loadRecharges();
                                } catch (e: any) { setToast(e.message ?? "操作失败"); }
                                finally { setLoading(false); }
                              }}
                              style={{ border: "none", borderRadius: 6, padding: "4px 10px", background: "#16a34a", color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
                            >
                              通过
                            </button>
                            <button
                              type="button"
                              onClick={() => { setRejectModalId(r.id); setRejectRemark(""); }}
                              style={{ border: "none", borderRadius: 6, padding: "4px 10px", background: "#dc2626", color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
                            >
                              拒绝
                            </button>
                          </div>
                        ) : (
                          <span style={{ fontSize: 12, color: "#6b7280" }}>
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
          <div style={{ width: "100%", maxWidth: 400, background: "#fff", borderRadius: 12, padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
            <h3 style={{ margin: "0 0 16px", fontSize: 16 }}>拒绝原因</h3>
            <textarea
              placeholder="请填写拒绝原因"
              value={rejectRemark}
              onChange={(e) => setRejectRemark(e.target.value)}
              rows={3}
              style={{ width: "100%", padding: "10px", border: "1px solid #d1d5db", borderRadius: 8, fontSize: 14, boxSizing: "border-box", resize: "vertical" }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button
                type="button"
                onClick={() => setRejectModalId(null)}
                style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 16px", background: "#fff", cursor: "pointer", fontSize: 13 }}
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
                style={{ border: "none", borderRadius: 8, padding: "8px 16px", background: "#dc2626", color: "#fff", fontWeight: 600, cursor: "pointer", fontSize: 13 }}
              >
                确认拒绝
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 线下付款拒绝原因弹窗 */}
      {offlineRejectId && (
        <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)", padding: 16 }}>
          <div style={{ width: "100%", maxWidth: 400, background: "#fff", borderRadius: 12, padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
            <h3 style={{ margin: "0 0 16px", fontSize: 16 }}>拒绝付款</h3>
            <textarea placeholder="请填写拒绝原因" value={offlineRejectRemark} onChange={(e) => setOfflineRejectRemark(e.target.value)} rows={3} style={{ width: "100%", padding: 10, border: "1px solid #d1d5db", borderRadius: 8, fontSize: 14, boxSizing: "border-box", resize: "vertical" }} />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button type="button" onClick={() => setOfflineRejectId(null)} style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 16px", background: "#fff", cursor: "pointer", fontSize: 13 }}>取消</button>
              <button type="button" onClick={async () => {
                if (!offlineRejectRemark.trim()) { setToast("请填写拒绝原因"); return; }
                try { await fetch(`${apiBaseUrl()}/admin/offline-payments/reject`, { method: "POST", headers: {"Content-Type":"application/json",...authHeaders()}, body: JSON.stringify({orderId: offlineRejectId, remark: offlineRejectRemark.trim()}) }); setToast("已拒绝"); setOfflineRejectId(null); loadOfflinePayments(); } catch (e: any) { setToast(e.message||"失败"); }
              }} style={{ border: "none", borderRadius: 8, padding: "8px 16px", background: "#dc2626", color: "#fff", fontWeight: 600, cursor: "pointer", fontSize: 13 }}>确认拒绝</button>
            </div>
          </div>
        </div>
      )}

      {/* 线下付款审核 */}
      <section id="offline-payments" style={{ ...sectionStyle, display: activeSection === "offline-payments" ? "block" : "none" }}>
        <h2 style={{ margin: "0 0 16px", fontSize: 18 }}>{SECTION_LABELS["offline-payments"]}</h2>
        {offlinePayments.length === 0 ? (
          <p style={{ color: "#6b7280", fontSize: 13 }}>暂无待审核的线下付款</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr style={{ background: "#f9fafb", borderBottom: "1px solid #e5e7eb" }}>
                <th style={{ padding: "8px 10px", textAlign: "left" }}>运单号</th>
                <th style={{ padding: "8px 10px", textAlign: "left" }}>客户</th>
                <th style={{ padding: "8px 10px", textAlign: "left" }}>品名</th>
                <th style={{ padding: "8px 10px", textAlign: "right" }}>金额</th>
                <th style={{ padding: "8px 10px", textAlign: "left" }}>提交时间</th>
                <th style={{ padding: "8px 10px", textAlign: "left" }}>凭证</th>
                <th style={{ padding: "8px 10px", textAlign: "left" }}>操作</th>
              </tr></thead>
              <tbody>
                {offlinePayments.map((p) => (
                  <tr key={p.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                    <td style={{ padding: "8px 10px", fontFamily: "monospace" }}>{p.trackingNo || "—"}</td>
                    <td style={{ padding: "8px 10px" }}>{p.clientName}</td>
                    <td style={{ padding: "8px 10px" }}>{p.itemName}</td>
                    <td style={{ padding: "8px 10px", textAlign: "right", fontWeight: 600 }}>¥{p.amount.toFixed(2)}</td>
                    <td style={{ padding: "8px 10px", fontSize: 12 }}>{p.submittedAt ? new Date(p.submittedAt).toLocaleString("zh-CN") : "—"}</td>
                    <td style={{ padding: "8px 10px" }}>
                      <img src={p.proofImage} alt="凭证" onClick={() => { const w = window.open("","_blank"); if (w) w.document.write(`<img src="${p.proofImage}" style="max-width:100%"/>`); }} style={{ width: 60, height: 60, objectFit: "cover", borderRadius: 6, border: "1px solid #e5e7eb", cursor: "pointer" }} />
                    </td>
                    <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>
                      <button type="button" onClick={async () => {
                        if (!confirm("确认通过？运单将标记为已付款")) return;
                        try { await fetch(`${apiBaseUrl()}/admin/offline-payments/approve`, { method: "POST", headers: {"Content-Type":"application/json",...authHeaders()}, body: JSON.stringify({orderId: p.orderId}) }); setToast("已通过"); loadOfflinePayments(); } catch (e: any) { setToast(e.message||"失败"); }
                      }} style={{ border: "none", borderRadius: 6, padding: "4px 10px", background: "#16a34a", color: "#fff", cursor: "pointer", fontSize: 12, marginRight: 4 }}>通过</button>
                      <button type="button" onClick={() => { setOfflineRejectId(p.orderId); setOfflineRejectRemark(""); }} style={{ border: "none", borderRadius: 6, padding: "4px 10px", background: "#dc2626", color: "#fff", cursor: "pointer", fontSize: 12 }}>拒绝</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 5. AI会话记忆运维 */}
      <section id="ai-memory" style={{ ...sectionStyle, display: activeSection === "ai-memory" ? "block" : "none" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{SECTION_LABELS["ai-memory"]}</h2>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={() => void loadSessionMemory()}
              disabled={loading}
              style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "6px 12px", background: "#fff", cursor: "pointer", color: "#000000" }}
            >
              刷新
            </button>
            <button
              type="button"
              onClick={() => void clearSessionMemory()}
              disabled={loading}
              style={{ border: "1px solid #dc2626", color: "#dc2626", borderRadius: 8, padding: "6px 12px", background: "#fef2f2", cursor: "pointer", fontWeight: 600 }}
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
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", width: "100%" }}
          />
          <input
            value={memoryFilterUserId}
            onChange={(e) => setMemoryFilterUserId(e.target.value)}
            placeholder="按用户ID清理（选填）"
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", width: "100%" }}
          />
        </div>
        {sessionMemoryList.length === 0 ? (
          <EmptyStateCard title="暂无会话记忆" description="当前没有可排查的 AI 会话记忆记录。" />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #e2e8f0", textAlign: "left" }}>
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
                  <tr key={row.key} style={{ borderBottom: "1px solid #e2e8f0" }}>
                    <td style={{ padding: "8px 6px" }}>{row.sessionId}</td>
                    <td style={{ padding: "8px 6px" }}>{row.userId}</td>
                    <td style={{ padding: "8px 6px" }}>{row.intent ?? "-"}</td>
                    <td style={{ padding: "8px 6px" }}>{row.itemName ?? "-"}</td>
                    <td style={{ padding: "8px 6px" }}>{row.statusScope ?? "-"}</td>
                    <td style={{ padding: "8px 6px" }}>{row.timeHint ?? "-"}</td>
                    <td style={{ padding: "8px 6px" }}>{row.metric ?? "-"}</td>
                    <td style={{ padding: "8px 6px", color: "#000000" }}>{row.updatedAt.slice(0, 16)}</td>
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
          <div style={{ display: "flex", gap: 8 }}>
            <select
              value={knowledgeGapStatus}
              onChange={(e) => setKnowledgeGapStatus(e.target.value as "open" | "resolved")}
              style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "6px 10px", background: "#fff" }}
            >
              <option value="open">仅看待处理</option>
              <option value="resolved">仅看已处理</option>
            </select>
            <button
              type="button"
              onClick={() => void loadKnowledgeGaps()}
              disabled={loading}
              style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "6px 12px", background: "#fff", cursor: "pointer", color: "#000000" }}
            >
              刷新
            </button>
          </div>
        </div>
        {knowledgeGapList.length === 0 ? (
          <EmptyStateCard title="暂无待补问题" description="当 AI 遇到知识不足时，会自动汇总到这里供管理员补知识。" />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #e2e8f0", textAlign: "left" }}>
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
                  <tr key={item.id} style={{ borderBottom: "1px solid #e2e8f0" }}>
                    <td style={{ padding: "8px 6px", color: "#000000" }}>{item.createdAt.slice(0, 16)}</td>
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
                          style={{ border: "1px solid #059669", color: "#059669", borderRadius: 8, padding: "6px 10px", background: "#ecfdf5", cursor: "pointer" }}
                        >
                          标记已处理
                        </button>
                      ) : (
                        <span style={{ color: "#000000" }}>{item.resolvedBy ? `已由 ${item.resolvedBy} 处理` : "已处理"}</span>
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
        <p style={{ color: "#000000", marginBottom: 12, fontSize: 14 }}>
          填写业务规则、时效说明、清关说明等内容，AI 会作为上下文参考。
        </p>
        <div style={{ display: "grid", gap: 8, maxWidth: 720 }}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="知识标题（例如：海运时效说明）"
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
          />
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="知识内容（支持长文本）"
            rows={5}
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", resize: "vertical" }}
          />
        </div>
        <div style={{ marginTop: 12 }}>
          <button
            type="button"
            onClick={() => void submitKnowledge()}
            disabled={loading}
            style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff", background: "#059669", cursor: "pointer" }}
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
              <div key={item.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}>
                <div style={{ fontWeight: 600 }}>{item.title}</div>
                <div style={{ marginTop: 6, whiteSpace: "pre-wrap", color: "#000000", fontSize: 14 }}>{item.content}</div>
                <div style={{ marginTop: 6, color: "#000000", fontSize: 12 }}>
                  {item.createdAt} / by {item.createdBy}
                </div>
                <div style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    onClick={() => void removeKnowledge(item.id)}
                    disabled={loading}
                    style={{
                      border: "1px solid #ef4444",
                      color: "#b91c1c",
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
        <p style={{ marginTop: 12, color: message.includes("失败") ? "#b91c1c" : "#065f46" }}>{message}</p>
      ) : null}
      <Toast open={toast.length > 0} message={toast} />

      {/* 创建员工弹窗 */}
      {showStaffModal && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)", padding: 16 }}>
          <div style={{ width: "100%", maxWidth: 440, background: "#fff", borderRadius: 12, padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
            <h3 style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 600 }}>创建员工账号</h3>
            <div style={{ display: "grid", gap: 10 }}>
              <div>
                <label style={{ fontSize: 12, color: "#000000", display: "block", marginBottom: 4 }}>账号（选填）</label>
                <input value={staffForm.id} onChange={(e) => setStaffForm((f) => ({ ...f, id: e.target.value }))} placeholder="留空自动生成" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", width: "100%", fontSize: 13 }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "#000000", display: "block", marginBottom: 4 }}>姓名 *</label>
                <input value={staffForm.name} onChange={(e) => setStaffForm((f) => ({ ...f, name: e.target.value }))} placeholder="员工姓名" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", width: "100%", fontSize: 13 }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "#000000", display: "block", marginBottom: 4 }}>手机 *</label>
                <input value={staffForm.phone} onChange={(e) => setStaffForm((f) => ({ ...f, phone: e.target.value }))} placeholder="手机号" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", width: "100%", fontSize: 13 }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "#000000", display: "block", marginBottom: 4 }}>登录密码</label>
                <input type="password" value={staffForm.password} onChange={(e) => setStaffForm((f) => ({ ...f, password: e.target.value }))} placeholder="密码（可选）" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", width: "100%", fontSize: 13 }} />
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button type="button" onClick={() => setShowStaffModal(false)} style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 14px", background: "#fff", cursor: "pointer", color: "#000000", fontSize: 13 }}>取消</button>
              <button type="button" disabled={loading} onClick={() => void submitAddStaff()} style={{ border: "none", borderRadius: 8, padding: "8px 14px", background: loading ? "#000000" : "#2563eb", color: "#fff", fontWeight: 600, cursor: loading ? "not-allowed" : "pointer", fontSize: 13 }}>{loading ? "提交中…" : "创建"}</button>
            </div>
          </div>
        </div>
      )}

      {/* 创建/编辑客户弹窗 */}
      {showClientModal && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)", padding: 16 }}>
          <div style={{ width: "100%", maxWidth: 440, background: "#fff", borderRadius: 12, padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
            <h3 style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 600 }}>{editingClientId ? "编辑客户账号" : "创建客户账号"}</h3>
            <div style={{ display: "grid", gap: 10 }}>
              <div>
                <label style={{ fontSize: 12, color: "#000000", display: "block", marginBottom: 4 }}>账号{editingClientId ? "" : "（选填，不填则自动生成）"}</label>
                <input value={clientForm.id} onChange={(e) => setClientForm((f) => ({ ...f, id: e.target.value }))} placeholder={editingClientId ? undefined : "留空自动生成"} disabled={!!editingClientId} style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", width: "100%", fontSize: 13, background: editingClientId ? "#f3f4f6" : "#fff", color: editingClientId ? "#6b7280" : "#000000" }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "#000000", display: "block", marginBottom: 4 }}>客户名字 *</label>
                <input value={clientForm.name} onChange={(e) => setClientForm((f) => ({ ...f, name: e.target.value }))} placeholder="客户姓名" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", width: "100%", fontSize: 13 }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "#000000", display: "block", marginBottom: 4 }}>公司名字</label>
                <input value={clientForm.companyName} onChange={(e) => setClientForm((f) => ({ ...f, companyName: e.target.value }))} placeholder="公司名（可选）" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", width: "100%", fontSize: 13 }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "#000000", display: "block", marginBottom: 4 }}>电话号码 *</label>
                <input value={clientForm.phone} onChange={(e) => setClientForm((f) => ({ ...f, phone: e.target.value }))} placeholder="手机号" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", width: "100%", fontSize: 13 }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "#000000", display: "block", marginBottom: 4 }}>邮箱</label>
                <input value={clientForm.email} onChange={(e) => setClientForm((f) => ({ ...f, email: e.target.value }))} placeholder="email@example.com" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", width: "100%", fontSize: 13 }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "#000000", display: "block", marginBottom: 4 }}>{editingClientId ? "登录密码（留空不修改）" : "登录密码 *"}</label>
                <input type="password" value={clientForm.password} onChange={(e) => setClientForm((f) => ({ ...f, password: e.target.value }))} placeholder={editingClientId ? "留空不修改密码" : "密码（必填）"} style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", width: "100%", fontSize: 13 }} />
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button type="button" onClick={() => { setShowClientModal(false); setEditingClientId(null); setClientForm({ id: "", name: "", companyName: "", phone: "", email: "", password: "" }); }} style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 14px", background: "#fff", cursor: "pointer", color: "#000000", fontSize: 13 }}>取消</button>
              <button type="button" disabled={loading} onClick={() => void (editingClientId ? submitEditClient() : submitAddClient())} style={{ border: "none", borderRadius: 8, padding: "8px 14px", background: loading ? "#000000" : "#2563eb", color: "#fff", fontWeight: 600, cursor: loading ? "not-allowed" : "pointer", fontSize: 13 }}>{loading ? "提交中…" : editingClientId ? "保存" : "创建"}</button>
            </div>
          </div>
        </div>
      )}
      {/* 分柜功能已移至装柜管理页面
创建订单弹窗 */}
      {showCreateOrderModal && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)", padding: 16 }}>
          <div style={{ width: "100%", maxWidth: 640, background: "#fff", borderRadius: 12, padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.3)", maxHeight: "85vh", overflow: "auto" }}>
            <h3 style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 600 }}>创建订单</h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8, marginBottom: 12 }}>
              <div>
                <label style={{ fontSize: 11, display: "block", marginBottom: 2 }}>客户 *</label>
                <input list="admin-create-client" value={createForm.clientId} onChange={(e) => setCreateForm(f => ({ ...f, clientId: e.target.value }))} placeholder="输入客户ID搜索" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 8px", width: "100%", fontSize: 12 }} />
                <datalist id="admin-create-client">{staffClients.map(c => (<option key={c.id} value={c.id}>{c.id} - {c.name}</option>))}</datalist>
              </div>
              <div>
                <label style={{ fontSize: 11, display: "block", marginBottom: 2 }}>仓库</label>
                <select value={createForm.warehouseId} onChange={(e) => setCreateForm(f => ({ ...f, warehouseId: e.target.value }))} style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 8px", width: "100%", fontSize: 12 }}>
                  {warehouseOptions.map(w => (<option key={w.id} value={w.id}>{w.label}</option>))}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 11, display: "block", marginBottom: 2 }}>到仓日期</label>
                <input type="date" value={createForm.arrivedAt} onChange={(e) => setCreateForm(f => ({ ...f, arrivedAt: e.target.value }))} style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 8px", width: "100%", fontSize: 12 }} />
              </div>
              <div>
                <label style={{ fontSize: 11, display: "block", marginBottom: 2 }}>运输方式</label>
                <select value={createForm.transportMode} onChange={(e) => setCreateForm(f => ({ ...f, transportMode: e.target.value as "sea" | "land" }))} style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 8px", width: "100%", fontSize: 12 }}>
                  <option value="sea">海运</option><option value="land">陆运</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize: 11, display: "block", marginBottom: 2 }}>国内单号</label>
                <input value={createForm.domesticTrackingNo} onChange={(e) => setCreateForm(f => ({ ...f, domesticTrackingNo: e.target.value }))} placeholder="货拉拉" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 8px", width: "100%", fontSize: 12 }} />
              </div>
              <div>
                <label style={{ fontSize: 11, display: "block", marginBottom: 2 }}>泰国收货人</label>
                <input value={createForm.receiverNameTh} onChange={(e) => setCreateForm(f => ({ ...f, receiverNameTh: e.target.value }))} style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 8px", width: "100%", fontSize: 12 }} />
              </div>
              <div>
                <label style={{ fontSize: 11, display: "block", marginBottom: 2 }}>泰国收货电话</label>
                <input value={createForm.receiverPhoneTh} onChange={(e) => setCreateForm(f => ({ ...f, receiverPhoneTh: e.target.value }))} style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 8px", width: "100%", fontSize: 12 }} />
              </div>
              <div>
                <label style={{ fontSize: 11, display: "block", marginBottom: 2 }}>泰国收货地址</label>
                <input value={createForm.receiverAddressTh} onChange={(e) => setCreateForm(f => ({ ...f, receiverAddressTh: e.target.value }))} style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 8px", width: "100%", fontSize: 12 }} />
              </div>
            </div>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>产品行</div>
            {createProducts.map((p, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "2fr 0.6fr 0.8fr 0.8fr 0.8fr 1.2fr", gap: 4, marginBottom: 4 }}>
                <input value={p.itemName} onChange={(e) => { const n = [...createProducts]; n[i].itemName = e.target.value; setCreateProducts(n); }} placeholder="品名" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "4px 6px", fontSize: 11 }} />
                <input type="number" value={p.packageCount} onChange={(e) => { const n = [...createProducts]; n[i].packageCount = Math.max(1, Number(e.target.value)); setCreateProducts(n); }} placeholder="箱数" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "4px 6px", fontSize: 11 }} />
                <input value={p.productQuantity} onChange={(e) => { const n = [...createProducts]; n[i].productQuantity = e.target.value; setCreateProducts(n); }} placeholder="数量/箱" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "4px 6px", fontSize: 11 }} />
                <input value={`${p.lengthCm}×${p.widthCm}×${p.heightCm}`} onChange={(e) => { const parts = e.target.value.split("×"); const n = [...createProducts]; n[i].lengthCm = parts[0] || ""; n[i].widthCm = parts[1] || ""; n[i].heightCm = parts[2] || ""; setCreateProducts(n); }} placeholder="L×W×H cm" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "4px 6px", fontSize: 11 }} />
                <select value={p.cargoType} onChange={(e) => { const n = [...createProducts]; n[i].cargoType = e.target.value; setCreateProducts(n); }} style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "4px 6px", fontSize: 11 }}>
                  <option value="normal">普货</option><option value="inspection">商检</option><option value="sensitive">敏感</option>
                </select>
                <div style={{ display: "flex", gap: 4 }}>
                  <input value={p.domesticTrackingNo} onChange={(e) => { const n = [...createProducts]; n[i].domesticTrackingNo = e.target.value; setCreateProducts(n); }} placeholder="国内单号" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "4px 6px", fontSize: 11, flex: 1 }} />
                  {createProducts.length > 1 && <button onClick={() => { setCreateProducts(createProducts.filter((_, j) => j !== i)); }} style={{ border: "none", background: "#fecaca", color: "#dc2626", borderRadius: 4, cursor: "pointer", fontSize: 11 }}>✕</button>}
                </div>
              </div>
            ))}
            <button onClick={() => setCreateProducts([...createProducts, { itemName: "", packageCount: 1, lengthCm: "", widthCm: "", heightCm: "", productQuantity: "", cargoType: "normal", domesticTrackingNo: "" }])} style={{ border: "1px solid #2563eb", borderRadius: 6, padding: "4px 10px", background: "#eff6ff", color: "#2563eb", cursor: "pointer", fontSize: 12, marginBottom: 16 }}>＋ 添加产品行</button>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={() => setShowCreateOrderModal(false)} style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 14px", background: "#fff", cursor: "pointer", color: "#000" }}>取消</button>
              <button disabled={loading} onClick={async () => {
                if (!createForm.clientId.trim()) { setMessage("请选择客户"); return; }
                const validProducts = createProducts.filter(p => p.itemName.trim() && p.packageCount > 0);
                if (validProducts.length === 0) { setMessage("请至少填写一个产品行"); return; }
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
                    packageCount: validProducts[0].packageCount,
                    packageUnit: "box",
                    products: validProducts.map(p => ({
                      itemName: p.itemName.trim(),
                      packageCount: p.packageCount,
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
              }} style={{ border: "none", borderRadius: 8, padding: "8px 14px", background: "#2563eb", color: "#fff", fontWeight: 600, cursor: "pointer" }}>
                {loading ? "提交中…" : "创建"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 批量导入弹窗 */}
      {showBatchImport && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)", padding: 16 }}>
          <div style={{ width: "100%", maxWidth: 700, background: "#fff", borderRadius: 12, padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.3)", maxHeight: "85vh", overflow: "auto" }}>
            <h3 style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 600 }}>批量导入运单</h3>
            <div style={{ marginBottom: 12, fontSize: 12, color: "#000" }}>
              下载模板 → 填写数据 → 上传文件。表头：客户ID, 仓库ID, 品名, 箱数, 包装单位, 运输方式, 到仓日期, 国内单号, 泰国收货人, 泰国收货电话, 泰国收货地址
            </div>
            {!batchConfirmed ? (
              <>
                <input type="file" accept=".xlsx,.xls,.csv" onChange={async (e) => {
                  const f = e.target.files?.[0]; if (!f) return;
                  setBatchFileName(f.name);
                  const XLSX = await import("xlsx");
                  const data = await f.arrayBuffer();
                  const wb = XLSX.read(data);
                  const ws = wb.Sheets[wb.SheetNames[0]];
                  const rows = XLSX.utils.sheet_to_json<any>(ws);
                  setBatchRows(rows);
                }} style={{ marginBottom: 12, fontSize: 12 }} />
                {batchRows.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 12, marginBottom: 4 }}>预览（{batchRows.length} 条）：</div>
                    <div style={{ maxHeight: 200, overflow: "auto", fontSize: 11, border: "1px solid #e5e7eb", borderRadius: 6 }}>
                      <table style={{ width: "100%", borderCollapse: "collapse" }}>
                        <thead><tr style={{ background: "#f1f5f9" }}>{Object.keys(batchRows[0]).slice(0, 6).map(k => (<th key={k} style={{ padding: "4px 6px", textAlign: "left" }}>{k}</th>))}</tr></thead>
                        <tbody>{batchRows.slice(0, 20).map((r: any, i: number) => (<tr key={i}>{Object.values(r).slice(0, 6).map((v: any, j: number) => (<td key={j} style={{ padding: "2px 6px" }}>{String(v ?? "")}</td>))}</tr>))}</tbody>
                      </table>
                    </div>
                    <button onClick={() => setBatchConfirmed(true)} style={{ marginTop: 8, border: "none", borderRadius: 6, padding: "6px 12px", background: "#16a34a", color: "#fff", cursor: "pointer", fontSize: 12 }}>确认导入</button>
                  </div>
                )}
              </>
            ) : (
              <div>
                <div style={{ marginBottom: 8, fontSize: 12 }}>正在导入 {batchRows.length} 条…</div>
                {batchProgress.current > 0 && (<div style={{ height: 4, background: "#e5e7eb", borderRadius: 2, marginBottom: 8 }}><div style={{ height: "100%", background: "#16a34a", borderRadius: 2, width: `${(batchProgress.current / batchRows.length) * 100}%` }} /></div>)}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button onClick={() => { setShowBatchImport(false); setBatchRows([]); setBatchConfirmed(false); setBatchFileName(""); }} style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 14px", background: "#fff", cursor: "pointer" }}>取消</button>
              {batchConfirmed && (
                <button disabled={batchLoading} onClick={async () => {
                  setBatchLoading(true); let success = 0; let fail = 0;
                  for (let i = 0; i < batchRows.length; i++) {
                    const r = batchRows[i];
                    try {
                      await createStaffOrder({
                        clientId: String(r["客户ID"] ?? r.clientId ?? ""), warehouseId: String(r["仓库ID"] ?? r.warehouseId ?? "wh_yiwu_01"),
                        arrivedAt: String(r["到仓日期"] ?? r.arrivedAt ?? new Date().toISOString().slice(0, 10)),
                        itemName: String(r["品名"] ?? r.itemName ?? ""), packageCount: Number(r["箱数"] ?? r.packageCount ?? 1),
                        packageUnit: (r["包装单位"] ?? r.packageUnit ?? "box") as "bag" | "box",
                        transportMode: (r["运输方式"] ?? r.transportMode ?? "sea") as "sea" | "land",
                        domesticTrackingNo: String(r["国内单号"] ?? r.domesticTrackingNo ?? ""),
                        receiverNameTh: String(r["泰国收货人"] ?? r.receiverNameTh ?? ""),
                        receiverPhoneTh: String(r["泰国收货电话"] ?? r.receiverPhoneTh ?? ""),
                        receiverAddressTh: String(r["泰国收货地址"] ?? r.receiverAddressTh ?? ""),
                      });
                      success++;
                    } catch { fail++; }
                    setBatchProgress({ current: i + 1, success, fail });
                  }
                  setBatchLoading(false);
                  setToast(`导入完成：成功 ${success}，失败 ${fail}`);
                  setShowBatchImport(false); setBatchRows([]); setBatchConfirmed(false);
                  await loadOrders();
                }} style={{ border: "none", borderRadius: 8, padding: "8px 14px", background: "#2563eb", color: "#fff", fontWeight: 600, cursor: "pointer" }}>
                  {batchLoading ? `导入中 ${batchProgress.current}/${batchRows.length}` : "开始导入"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </RoleShell>
  );
}
