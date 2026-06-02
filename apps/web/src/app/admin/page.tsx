"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AiKnowledgeItem } from "../../../../../packages/shared-types/entities";
import { getOptionalSession, type MockSession } from "../../auth/mock-session";
import CountUpNumber from "../../modules/layout/CountUpNumber";
import EmptyStateCard from "../../modules/layout/EmptyStateCard";
import RoleShell from "../../modules/layout/RoleShell";
import Toast from "../../modules/layout/Toast";
import ShipmentSearch from "../../modules/shipment/ShipmentSearch";
import {
  fetchAdminOverview,
  fetchAdminStaff,
  fetchAdminClients,
  fetchAdminOrders,
  updateAdminOrder,
  fetchAdminAiSessionMemory,
  fetchAdminAiKnowledgeGaps,
  clearAdminAiSessionMemory,
  resolveAdminAiKnowledgeGap,
  createAdminStaff,
  createAdminClient,
  deleteAdminStaff,
  setAdminStaffPassword,
  type AdminOverview,
  type AdminOpsOverview,
  type AdminUserItem,
  type AdminOrderItem,
  type AdminAiSessionMemoryItem,
  type AdminAiKnowledgeGapItem,
  fetchAdminOpsOverview,
  fetchShippingConfig,
  updateShippingConfig,
  fetchAdminShippingRates,
  saveAdminShippingRate,
  deleteAdminShippingRate,
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
] as const;

const SECTION_LABELS: Record<(typeof SECTION_IDS)[number], string> = {
  overview: "运营看板",
  staff: "员工管理",
  clients: "客户管理",
  orders: "订单数据管理",
  "ai-memory": "AI会话记忆运维",
  "ai-knowledge-gaps": "AI待补知识问题",
  "knowledge-feed": "AI知识投喂",
  "knowledge-list": "已投喂的知识列表",
  "shipping-config": "运费配置",
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
const STATUS_REVERSE_MAP: Record<string, string> = {
  "已创建": "created", "已揽收": "pickedup", "国内仓已收货": "inwarehousecn",
  "报关中": "customspending", "已装柜": "loaded", "延迟开船": "delaydeparted",
  "已开船": "departed", "已到港": "arrivedport", "运输中": "intransit",
  "清关中": "customsth", "清关已放行": "customscleared", "已到仓": "inwarehouseth",
  "派送中": "outfordelivery", "派送完成": "delivered",
};

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
  const [session, setSession] = useState<MockSession | null>(null);
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
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [staffPanelCollapsed, setStaffPanelCollapsed] = useState(false);
  const [ordersPanelCollapsed, setOrdersPanelCollapsed] = useState(false);
  const [orderSearch, setOrderSearch] = useState({
    trackingNo: "", domesticTrackingNo: "", clientName: "", warehouseId: "",
    batchNo: "", itemName: "", packageCount: "", productQuantity: "",
    weightKg: "", volumeM3: "", arrivedAt: "", logisticsStatus: "",
    containerNo: "", transportMode: "", receiverAddress: "", shipDate: "",
    receivableAmount: "", statusRaw: "",
  });
  const [editingOrderId, setEditingOrderId] = useState("");
  const [orderEditForm, setOrderEditForm] = useState({
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
  });
  const [staffForm, setStaffForm] = useState({ id: "", name: "", phone: "", password: "" });
  const [clientForm, setClientForm] = useState({ id: "", name: "", companyName: "", phone: "", email: "", password: "" });
  const [showStaffModal, setShowStaffModal] = useState(false);
  const [showClientModal, setShowClientModal] = useState(false);
  const [settingPasswordFor, setSettingPasswordFor] = useState<string | null>(null);
  const [settingPasswordValue, setSettingPasswordValue] = useState("");
  const [memoryFilterSessionId, setMemoryFilterSessionId] = useState("");
  const [memoryFilterUserId, setMemoryFilterUserId] = useState("");
  const [activeSection, setActiveSection] = useState<(typeof SECTION_IDS)[number]>("overview");

  /**
   * 后台统一运输方式文案。
   */
  const transportModeLabel = (mode?: string) => ((mode ?? "").toLowerCase() === "sea" ? "海运" : "陆运");

  /**
   * 后台统一运单状态文案。
   */
  const shipmentStatusLabel = (status?: string) => {
    const value = (status ?? "").toLowerCase();
    if (!value) return "—";
    if (value === "created") return "已创建";
    if (value === "pickedup") return "已揽收";
    if (value === "inwarehousecn" || value === "receivedcn") return "国内仓已收货";
    if (value === "customspending") return "报关中";
    if (value === "intransit") return "运输中";
    if (value === "customsth") return "清关中";
    if (value === "warehouseth") return "泰国仓处理中";
    if (value === "outfordelivery") return "派送中";
    if (value === "delivered") return "已签收";
    if (value === "returned") return "已退回";
    if (value === "cancelled") return "已取消";
    if (value === "exception") return "异常件";
    return status ?? "—";
  };

  /**
   * 后台统一仓库文案。
   */
  const warehouseLabel = (warehouseId?: string) => WAREHOUSE_LABEL_MAP[warehouseId ?? ""] ?? warehouseId ?? "—";

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
    setOrderList(list);
  }, []);

  /**
   * 载入待编辑订单到表单，便于管理员修改客户端订单信息。
   */
  const startEditOrder = (order: AdminOrderItem) => {
    setEditingOrderId(order.id);
    setOrderEditForm({
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
      receivableAmountCny:
        order.receivableAmountCny === null || order.receivableAmountCny === undefined ? "" : String(order.receivableAmountCny),
      receivableCurrency: order.receivableCurrency === "THB" ? "THB" : "CNY",
      paymentStatus: order.paymentStatus === "paid" ? "paid" : "unpaid",
      shipDate: order.shipDate ?? "",
    });
  };

  /**
   * 保存管理员对客户端订单的编辑结果。
   */
  const submitOrderEdit = async () => {
    if (!editingOrderId) {
      setMessage("请先选择要编辑的订单。");
      return;
    }
    if (!orderEditForm.trackingNo.trim()) {
      setMessage("请填写运单号。");
      return;
    }
    const trackingNoUpper = orderEditForm.trackingNo.trim().toUpperCase();
    const prefixes = WAREHOUSE_TRACKING_PREFIX_MAP[orderEditForm.warehouseId] ?? ["XT"];
    if (!prefixes.some((prefix) => trackingNoUpper.startsWith(prefix))) {
      setMessage(`运单号前缀需与仓库一致：${prefixes.join("/")}`);
      return;
    }
    if (!orderEditForm.itemName.trim()) {
      setMessage("请填写品名。");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      await updateAdminOrder({
        orderId: editingOrderId,
        itemName: orderEditForm.itemName.trim(),
        trackingNo: orderEditForm.trackingNo.trim() || undefined,
        batchNo: orderEditForm.batchNo.trim() || undefined,
        warehouseId: orderEditForm.warehouseId,
        transportMode: orderEditForm.transportMode,
        domesticTrackingNo: orderEditForm.domesticTrackingNo.trim() || undefined,
        receiverAddressTh: orderEditForm.receiverAddressTh.trim(),
        containerNo: orderEditForm.containerNo.trim() || undefined,
        productQuantity: Number(orderEditForm.productQuantity || 0),
        packageCount: Number(orderEditForm.packageCount || 0),
        packageUnit: orderEditForm.packageUnit,
        weightKg: orderEditForm.weightKg.trim() ? Number(orderEditForm.weightKg) : undefined,
        volumeM3: orderEditForm.volumeM3.trim() ? Number(orderEditForm.volumeM3) : undefined,
        receivableAmountCny: orderEditForm.receivableAmountCny.trim() ? Number(orderEditForm.receivableAmountCny) : undefined,
        receivableCurrency: orderEditForm.receivableCurrency,
        paymentStatus: orderEditForm.paymentStatus,
        shipDate: orderEditForm.shipDate.trim() || undefined,
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
    const list = await fetchKnowledgeList(session.companyId);
    setKnowledgeItems(list);
  }, [session]);

  const loadAll = useCallback(
    async (currentSession?: MockSession | null) => {
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
          fetchKnowledgeList(s.companyId).then(setKnowledgeItems),
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

  const submitKnowledge = async () => {
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
        companyId: session?.companyId ?? "",
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
      await deleteKnowledgeItem(id, session?.companyId ?? "");
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
      if (s.arrivedAt && !ar.includes(s.arrivedAt)) return false;
      if (s.logisticsStatus && shipmentStatusLabel(item.currentStatus) !== s.logisticsStatus) return false;
      if (s.containerNo && !cnr.includes(s.containerNo.toLowerCase())) return false;
      if (s.transportMode && tm !== s.transportMode) return false;
      if (s.receiverAddress && !ra.includes(s.receiverAddress.toLowerCase())) return false;
      if (s.shipDate && sd !== s.shipDate) return false;
      if (s.receivableAmount && !rc.includes(s.receivableAmount)) return false;
      if (s.statusRaw && !sr.includes(s.statusRaw.toLowerCase())) return false;
      return true;
    });
  }, [orderList, orderSearch]);

  const exportOrdersToExcel = () => {
    if (filteredOrderList.length === 0) {
      setMessage("当前没有可导出的订单数据。");
      return;
    }
    const rows = filteredOrderList.map((o) => ({
      订单号: o.id,
      客户: o.clientName ?? o.clientId ?? "-",
      品名: o.itemName,
      运输方式: o.transportMode,
      国内单号: o.domesticTrackingNo ?? "-",
      柜号: o.batchNo ?? "-",
      审批状态: o.approvalStatus,
      产品数量: o.productQuantity ?? "-",
      包裹数量: o.packageCount ?? "-",
      重量kg: o.weightKg ?? "-",
      体积m3: o.volumeM3 ?? "-",
      到仓日期: o.shipDate ?? "-",
      状态组: o.statusGroup ?? "-",
      创建时间: o.createdAt ?? "-",
      更新时间: o.updatedAt ?? "-",
    }));
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "订单列表");
    const today = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(workbook, `订单数据_${today}.xlsx`);
    setToast("导出Excel成功");
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
      await resolveAdminAiKnowledgeGap({ id, companyId: session?.companyId ?? "" });
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
    } catch { /* ignore */ }
  };

  useEffect(() => {
    if (activeSection === "shipping-config") void loadRates();
  }, [activeSection]);

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
                  {opsOverview.profitTrend.map((item) => (
                    <div key={`${item.orderId}-${item.updatedAt}`} style={{ fontSize: 12, color: "#000000" }}>
                      订单 {item.orderId}：利润 {item.profit.toFixed(2)}（{item.updatedAt.slice(0, 16)}）
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
                {opsOverview.customsAlerts.slice(0, 6).map((item) => (
                  <div key={item.id} style={{ fontSize: 12, color: "#92400e" }}>
                    [{item.status}] shipment {item.shipmentId ?? "-"} / order {item.orderId ?? "-"} /{" "}
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
                  <span><strong>状态</strong> {u.status}</span>
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
            onClick={() => { setShowClientModal(true); setClientForm({ id: "", name: "", companyName: "", phone: "", email: "", password: "" }); }}
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
                  <span><strong>状态</strong> {u.status}</span>
                  <span style={{ color: "#000000", fontSize: 12 }}>{u.createdAt.slice(0, 10)}</span>
                  <button
                    type="button"
                    onClick={() => setSettingPasswordFor(settingPasswordFor === u.id ? null : u.id)}
                    disabled={loading}
                    style={{ border: "1px solid #059669", color: "#059669", borderRadius: 8, padding: "6px 10px", background: "#f0fdf4", cursor: "pointer", fontSize: 13 }}
                  >
                    {settingPasswordFor === u.id ? "取消" : "设置密码"}
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

      {/* 4. 订单数据管理 */}
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
              onClick={exportOrdersToExcel}
              disabled={orderList.length === 0}
              style={{
                border: "none",
                borderRadius: 8,
                padding: "6px 12px",
                color: "#fff",
                background: orderList.length === 0 ? "#000000" : "#2563eb",
                cursor: orderList.length === 0 ? "not-allowed" : "pointer",
              }}
            >
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
        ) : (() => {
          if (filteredOrderList.length === 0) return <EmptyStateCard title="暂无匹配订单" description="无匹配结果" />;
          return (
          <div style={{ overflowX: "auto" }}>
            {editingOrderId ? (
              <div style={{ ...cardStyle, marginBottom: 10, display: "grid", gap: 8 }}>
                <div style={{ fontWeight: 700, color: "#0f172a" }}>正在编辑订单：{editingOrderId}</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
                  <input value={orderEditForm.trackingNo} onChange={(e) => setOrderEditForm((v) => ({ ...v, trackingNo: e.target.value.toUpperCase() }))} placeholder="运单号（如 YW... / DG...）" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
                  <input value={orderEditForm.batchNo} onChange={(e) => setOrderEditForm((v) => ({ ...v, batchNo: e.target.value }))} placeholder="批次号" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
                  <select value={orderEditForm.warehouseId} onChange={(e) => setOrderEditForm((v) => ({ ...v, warehouseId: e.target.value }))} style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}>
                    <option value="wh_yiwu_01">义乌仓</option>
                    <option value="wh_guangzhou_01">广州仓</option>
                    <option value="wh_dongguan_01">东莞仓</option>
                  </select>
                  <input value={orderEditForm.itemName} onChange={(e) => setOrderEditForm((v) => ({ ...v, itemName: e.target.value }))} placeholder="品名" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
                  <select value={orderEditForm.transportMode} onChange={(e) => setOrderEditForm((v) => ({ ...v, transportMode: e.target.value as "sea" | "land" }))} style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}>
                    <option value="sea">海运</option>
                    <option value="land">陆运</option>
                  </select>
                  <input value={orderEditForm.domesticTrackingNo} onChange={(e) => setOrderEditForm((v) => ({ ...v, domesticTrackingNo: e.target.value }))} placeholder="国内快递单号" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
                  <input value={orderEditForm.receiverAddressTh} onChange={(e) => setOrderEditForm((v) => ({ ...v, receiverAddressTh: e.target.value }))} placeholder="收货地址（泰国）" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
                  <input value={orderEditForm.containerNo} onChange={(e) => setOrderEditForm((v) => ({ ...v, containerNo: e.target.value }))} placeholder="装柜号" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
                  <input value={orderEditForm.productQuantity} onChange={(e) => setOrderEditForm((v) => ({ ...v, productQuantity: e.target.value }))} placeholder="产品数量" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
                  <input value={orderEditForm.packageCount} onChange={(e) => setOrderEditForm((v) => ({ ...v, packageCount: e.target.value }))} placeholder="件数" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
                  <select value={orderEditForm.packageUnit} onChange={(e) => setOrderEditForm((v) => ({ ...v, packageUnit: e.target.value as "bag" | "box" }))} style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}>
                    <option value="box">box</option>
                    <option value="bag">bag</option>
                  </select>
                  <input value={orderEditForm.weightKg} onChange={(e) => setOrderEditForm((v) => ({ ...v, weightKg: e.target.value }))} placeholder="重量(kg)" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
                  <input value={orderEditForm.volumeM3} onChange={(e) => setOrderEditForm((v) => ({ ...v, volumeM3: e.target.value }))} placeholder="体积(m3)" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
                  <input value={orderEditForm.receivableAmountCny} onChange={(e) => setOrderEditForm((v) => ({ ...v, receivableAmountCny: e.target.value }))} placeholder="应收金额(CNY)" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
                  <select value={orderEditForm.receivableCurrency} onChange={(e) => setOrderEditForm((v) => ({ ...v, receivableCurrency: e.target.value as "CNY" | "THB" }))} style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}>
                    <option value="CNY">CNY</option>
                    <option value="THB">THB</option>
                  </select>
                  <select value={orderEditForm.paymentStatus} onChange={(e) => setOrderEditForm((v) => ({ ...v, paymentStatus: e.target.value as "paid" | "unpaid" }))} style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}>
                    <option value="unpaid">未支付</option>
                    <option value="paid">已支付</option>
                  </select>
                  <input type="date" value={orderEditForm.shipDate} onChange={(e) => setOrderEditForm((v) => ({ ...v, shipDate: e.target.value }))} style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => void submitOrderEdit()}
                    disabled={loading}
                    style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff", background: "#2563eb", cursor: "pointer" }}
                  >
                    保存订单编辑
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingOrderId("")}
                    style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 14px", background: "#fff", cursor: "pointer", color: "#000000" }}
                  >
                    取消编辑
                  </button>
                </div>
              </div>
            ) : null}
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 1180 }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #e2e8f0", textAlign: "left" }}>
                  <th style={{ padding: "10px 8px", whiteSpace: "nowrap" }}>运单号</th>
                  <th style={{ padding: "10px 8px", whiteSpace: "nowrap" }}>运单所属用户</th>
                  <th style={{ padding: "10px 8px", whiteSpace: "nowrap" }}>运单状态</th>
                  <th style={{ padding: "10px 8px", whiteSpace: "nowrap" }}>加收金额</th>
                  <th style={{ padding: "10px 8px", whiteSpace: "nowrap" }}>运输方式</th>
                  <th style={{ padding: "10px 8px", whiteSpace: "nowrap" }}>发货时间</th>
                  <th style={{ padding: "10px 8px", whiteSpace: "nowrap" }}>总件数</th>
                  <th style={{ padding: "10px 8px", whiteSpace: "nowrap" }}>总重量</th>
                  <th style={{ padding: "10px 8px", whiteSpace: "nowrap" }}>总体积</th>
                  <th style={{ padding: "10px 8px", whiteSpace: "nowrap" }}>计费体积</th>
                  <th style={{ padding: "10px 8px", whiteSpace: "nowrap" }}>所属仓库</th>
                  <th style={{ padding: "10px 8px", minWidth: 120 }}>收货地址</th>
                  <th style={{ padding: "10px 8px", whiteSpace: "nowrap" }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredOrderList.map((o) => (
                  <tr key={o.id} style={{ borderBottom: "1px solid #e2e8f0" }}>
                    <td style={{ padding: "8px 6px", fontWeight: 600, color: "#1e3a8a", whiteSpace: "nowrap" }}>
                      {o.trackingNo ?? "—"}
                    </td>
                    <td style={{ padding: "8px 6px", color: "#000000" }}>{o.clientName ?? o.clientId ?? "—"}</td>
                    <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>{shipmentStatusLabel(o.currentStatus)}</td>
                    <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>
                      {o.receivableAmountCny != null
                        ? `${o.receivableCurrency === "THB" ? "THB" : "CNY"} ${o.receivableAmountCny.toFixed(2)}`
                        : "0"}
                    </td>
                    <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>{transportModeLabel(o.transportMode)}</td>
                    <td style={{ padding: "8px 6px", whiteSpace: "nowrap", color: "#000000" }}>
                      {o.shipDate ?? o.createdAt.slice(0, 10)}
                    </td>
                    <td style={{ padding: "8px 6px" }}>{o.packageCount}</td>
                    <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>{o.weightKg ?? "—"}</td>
                    <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>{o.volumeM3 ?? "—"}</td>
                    <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>{o.volumeM3 ?? "—"}</td>
                    <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>{warehouseLabel(o.warehouseId)}</td>
                    <td style={{ padding: "8px 6px", color: "#000000", fontSize: 12, maxWidth: 160 }} title={o.receiverAddressTh ?? ""}>
                      {o.receiverAddressTh ?? "—"}
                    </td>
                    <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>
                      <button
                        type="button"
                        onClick={() => startEditOrder(o)}
                        style={{ border: "1px solid #bfdbfe", borderRadius: 8, padding: "4px 10px", background: "#eff6ff", color: "#1d4ed8", cursor: "pointer", fontWeight: 700 }}
                      >
                        编辑
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          );
        })()}
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
          );
        })()}
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
      <section id="shipping-config" style={{ ...sectionStyle, display: activeSection === "shipping-config" ? "block" : "none" }}>
        <h2 style={{ marginTop: 0, marginBottom: 12, fontSize: 18 }}>运费配置</h2>
        <p style={{ color: "#000000", marginBottom: 12, fontSize: 14 }}>
          设置最低计费体积（低消）。当货物体积低于低消时，按低消计算运费。
        </p>
        <div style={{ display: "grid", gap: 10, maxWidth: 400 }}>
          <div>
            <div style={{ fontSize: 13, color: "#000000", marginBottom: 4 }}>海运低消（立方米）</div>
            <input
              value={shippingConfigSea}
              onChange={(e) => setShippingConfigSea(e.target.value)}
              type="number" step="0.1" min="0"
              style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", fontSize: 13, width: "100%" }}
            />
          </div>
          <div>
            <div style={{ fontSize: 13, color: "#000000", marginBottom: 4 }}>陆运低消（立方米）</div>
            <input
              value={shippingConfigLand}
              onChange={(e) => setShippingConfigLand(e.target.value)}
              type="number" step="0.1" min="0"
              style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", fontSize: 13, width: "100%" }}
            />
          </div>
          <button
            type="button"
            disabled={configSaving}
            onClick={async () => {
              setConfigSaving(true);
              try {
                await updateShippingConfig({ sea_min_volume: shippingConfigSea, land_min_volume: shippingConfigLand });
                setToast("配置已保存");
              } catch { setToast("保存失败"); }
              finally { setConfigSaving(false); }
            }}
            style={{ border: "none", borderRadius: 6, padding: "8px 16px", background: "#2563eb", color: "#fff", fontWeight: 500, fontSize: 13, cursor: "pointer", justifySelf: "start" }}
          >
            {configSaving ? "保存中…" : "保存配置"}
          </button>
        </div>

        {/* 价格管理 */}
        <h3 style={{ marginTop: 24, marginBottom: 10, fontSize: 16 }}>价格管理</h3>
        <p style={{ color: "#000000", marginBottom: 12, fontSize: 13 }}>
          默认价格若无手动配置则使用内置默认值。可为特定客户设置专属价格或取消低消。
        </p>

        {/* 默认价格表 */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8, color: "#000000" }}>当前价格表</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid #e5e7eb" }}>
                <th style={{ padding: "6px 8px", textAlign: "left", color: "#000000" }}>运输方式</th>
                <th style={{ padding: "6px 8px", textAlign: "left", color: "#000000" }}>货物类型</th>
                <th style={{ padding: "6px 8px", textAlign: "left", color: "#000000" }}>客户</th>
                <th style={{ padding: "6px 8px", textAlign: "right", color: "#000000" }}>单价 (¥/m³)</th>
                <th style={{ padding: "6px 8px", textAlign: "center", color: "#000000" }}>取消低消</th>
                <th style={{ padding: "6px 8px", textAlign: "center", color: "#000000" }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {rateDefaults.map((d) => {
                const override = rateItems.find((r) => r.transportMode === d.transportMode && r.cargoType === d.cargoType && !r.customerId);
                const price = override?.unitPriceCny ?? d.unitPriceCny;
                return (
                  <tr key={`${d.transportMode}|${d.cargoType}|default`} style={{ borderBottom: "1px solid #f3f4f6" }}>
                    <td style={{ padding: "6px 8px" }}>{d.transportMode === "sea" ? "海运" : "陆运"}</td>
                    <td style={{ padding: "6px 8px" }}>{d.cargoType === "normal" ? "普货" : d.cargoType === "inspection" ? "商检" : "敏感"}</td>
                    <td style={{ padding: "6px 8px", color: "#6b7280" }}>通用</td>
                    <td style={{ padding: "6px 8px", textAlign: "right" }}>¥{price.toFixed(0)}</td>
                    <td style={{ padding: "6px 8px", textAlign: "center" }}>—</td>
                    <td style={{ padding: "6px 8px", textAlign: "center" }}>
                      <button type="button" onClick={() => setRateEditForm({
                        transportMode: d.transportMode, cargoType: d.cargoType,
                        customerId: "", unitPriceCny: String(price), disableMinVolume: false
                      })} style={{ border: "1px solid #2563eb", borderRadius: 4, padding: "2px 8px", fontSize: 12, background: "#fff", color: "#2563eb", cursor: "pointer" }}>编辑</button>
                    </td>
                  </tr>
                );
              })}
              {/* 客户专属价格 */}
              {rateItems.filter((r) => r.customerId).map((r) => (
                <tr key={r.id} style={{ borderBottom: "1px solid #f3f4f6", background: "#fefce8" }}>
                  <td style={{ padding: "6px 8px" }}>{r.transportMode === "sea" ? "海运" : "陆运"}</td>
                  <td style={{ padding: "6px 8px" }}>{r.cargoType === "normal" ? "普货" : r.cargoType === "inspection" ? "商检" : "敏感"}</td>
                  <td style={{ padding: "6px 8px" }}>{r.customerId}{r.customerName ? ` (${r.customerName})` : ""}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 600 }}>¥{r.unitPriceCny.toFixed(0)}</td>
                  <td style={{ padding: "6px 8px", textAlign: "center" }}>{r.disableMinVolume ? "✓" : "—"}</td>
                  <td style={{ padding: "6px 8px", textAlign: "center" }}>
                    <button type="button" onClick={async () => {
                      if (!confirm("删除此客户专属价格？")) return;
                      try { await deleteAdminShippingRate(r.id); await loadRates(); setToast("已删除"); } catch { setToast("删除失败"); }
                    }} style={{ border: "1px solid #dc2626", borderRadius: 4, padding: "2px 8px", fontSize: 12, background: "#fff", color: "#dc2626", cursor: "pointer" }}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 添加/编辑表单 */}
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 12, background: "#f9fafb" }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8, color: "#000000" }}>{rateEditForm.unitPriceCny ? "编辑价格" : "添加价格"}</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <select value={rateEditForm.transportMode} onChange={(e) => setRateEditForm((f) => ({ ...f, transportMode: e.target.value }))}
              style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 8px", fontSize: 13 }}>
              <option value="sea">海运</option>
              <option value="land">陆运</option>
            </select>
            <select value={rateEditForm.cargoType} onChange={(e) => setRateEditForm((f) => ({ ...f, cargoType: e.target.value }))}
              style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 8px", fontSize: 13 }}>
              <option value="normal">普货</option>
              <option value="inspection">商检</option>
              <option value="sensitive">敏感</option>
            </select>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
            <input value={rateEditForm.customerId} onChange={(e) => setRateEditForm((f) => ({ ...f, customerId: e.target.value }))}
              placeholder="客户ID（留空=通用）" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 8px", fontSize: 13 }} />
            <input value={rateEditForm.unitPriceCny} onChange={(e) => setRateEditForm((f) => ({ ...f, unitPriceCny: e.target.value }))}
              placeholder="单价 ¥/m³" type="number" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 8px", fontSize: 13 }} />
          </div>
          {rateEditForm.customerId ? (
            <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 13, cursor: "pointer" }}>
              <input type="checkbox" checked={rateEditForm.disableMinVolume} onChange={(e) => setRateEditForm((f) => ({ ...f, disableMinVolume: e.target.checked }))} />
              <span style={{ color: "#000000" }}>取消低消</span>
            </label>
          ) : null}
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button type="button" onClick={async () => {
              const price = Number(rateEditForm.unitPriceCny);
              if (!price || price <= 0) { setToast("请输入有效价格"); return; }
              try {
                await saveAdminShippingRate({
                  transportMode: rateEditForm.transportMode, cargoType: rateEditForm.cargoType,
                  customerId: rateEditForm.customerId || null, unitPriceCny: price,
                  disableMinVolume: rateEditForm.disableMinVolume,
                });
                await loadRates();
                setRateEditForm({ transportMode: "sea", cargoType: "normal", customerId: "", unitPriceCny: "", disableMinVolume: false });
                setToast("已保存");
              } catch { setToast("保存失败"); }
            }} style={{ border: "none", borderRadius: 6, padding: "8px 16px", background: "#2563eb", color: "#fff", fontWeight: 500, fontSize: 13, cursor: "pointer" }}>保存</button>
            <button type="button" onClick={() => setRateEditForm({ transportMode: "sea", cargoType: "normal", customerId: "", unitPriceCny: "", disableMinVolume: false })}
              style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 16px", background: "#fff", color: "#000000", fontSize: 13, cursor: "pointer" }}>取消</button>
          </div>
        </div>
      </section>

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

      {/* 创建客户弹窗 */}
      {showClientModal && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)", padding: 16 }}>
          <div style={{ width: "100%", maxWidth: 440, background: "#fff", borderRadius: 12, padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
            <h3 style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 600 }}>创建客户账号</h3>
            <div style={{ display: "grid", gap: 10 }}>
              <div>
                <label style={{ fontSize: 12, color: "#000000", display: "block", marginBottom: 4 }}>账号（选填，不填则自动生成）</label>
                <input value={clientForm.id} onChange={(e) => setClientForm((f) => ({ ...f, id: e.target.value }))} placeholder="留空自动生成" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", width: "100%", fontSize: 13 }} />
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
                <label style={{ fontSize: 12, color: "#000000", display: "block", marginBottom: 4 }}>登录密码 *</label>
                <input type="password" value={clientForm.password} onChange={(e) => setClientForm((f) => ({ ...f, password: e.target.value }))} placeholder="密码（必填）" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", width: "100%", fontSize: 13 }} />
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button type="button" onClick={() => setShowClientModal(false)} style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 14px", background: "#fff", cursor: "pointer", color: "#000000", fontSize: 13 }}>取消</button>
              <button type="button" disabled={loading} onClick={() => void submitAddClient()} style={{ border: "none", borderRadius: 8, padding: "8px 14px", background: loading ? "#000000" : "#2563eb", color: "#fff", fontWeight: 600, cursor: loading ? "not-allowed" : "pointer", fontSize: 13 }}>{loading ? "提交中…" : "创建"}</button>
            </div>
          </div>
        </div>
      )}
    </RoleShell>
  );
}
