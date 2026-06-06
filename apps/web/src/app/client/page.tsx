"use client";

import { useEffect, useMemo, useState } from "react";
import { Anchor, ClipboardCheck, PackageCheck, Ship, Truck, Warehouse, type LucideIcon } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import EmptyStateCard from "../../modules/layout/EmptyStateCard";
import RoleShell from "../../modules/layout/RoleShell";
import Toast from "../../modules/layout/Toast";
import { formatCny } from "../../modules/billing/billing-utils";
import { sendAiMessage } from "../../services/ai-client";
import { apiBaseUrl } from "../../services/core-api";
import {
  fetchClientAddresses,
  createClientPrealert,
  fetchClientPrealerts,
  shipClientPrealert,
  deleteClientPrealert,
  updateClientPrealert,
  fetchClientOrders,
  fetchClientWalletOverview,
  fetchShippingPrices,
  uploadStaffOrderProductImage,
  type ClientAddressItem,
  type OrderItem,
  type ShippingPriceItem,
} from "../../services/business-api";
import { openPrintLabel, openPrintPrealert } from "../../modules/shipment/ShipmentPrintLabel";
import { openShipmentTrack } from "../../modules/shipment/ShipmentTrackModal";

const initialSearch = {
  batchNo: "",
  orderId: "",
  arrivedDateFrom: "",
  arrivedDateTo: "",
  domesticTrackingNo: "",
  status: "",
  transportMode: "",
  warehouseId: "",
};

const warehouseOptions = [
  { id: "wh_yiwu_01", label: "义乌仓" },
  { id: "wh_guangzhou_01", label: "广州仓" },
  { id: "wh_dongguan_01", label: "东莞仓" },
  { id: "wh_shenzhen_01", label: "深圳仓" },
];

const warehouseAddressMap: Record<string, string> = {
  wh_yiwu_01: "浙江省金华市义乌市北苑街道 xx 路 88 号（义乌仓）",
  wh_guangzhou_01: "广东省广州市白云区石井街道 xx 物流园 16 栋（广州仓）",
  wh_dongguan_01: "广东省东莞市虎门镇 xx 工业区 9 号（东莞仓）",
  wh_shenzhen_01: "（深圳仓地址待补充）",
};

type FreightTransportMode = "land"  |  "sea";
type FreightCargoType = "normal"  |  "inspection"  |  "sensitive";

const freightRateMap: Record<FreightTransportMode, Record<FreightCargoType, number>> = {
  // 统一按“计费体积（立方米）× 单价（元/立方米）”计费
  // 注：海运普货 540 元/立方米（按你提供的口径）
  land: { normal: 1070, inspection: 1250, sensitive: 1350 },
  sea: { normal: 550, inspection: 700, sensitive: 800 },
};

const CLIENT_SECTION_IDS = ["client-main", "client-query", "client-prealert"] as const;
const ORDER_TIMELINE = [
  { key: "loaded", label: "装柜" },
  { key: "departed", label: "开船" },
  { key: "arrivedPort", label: "到港" },
  { key: "customsTH", label: "清关" },
  { key: "customsCleared", label: "放行" },
  { key: "inWarehouseTH", label: "到仓" },
  { key: "outForDelivery", label: "派送" },
  { key: "delivered", label: "签收" },
] as const;

/**
 * 返回订单时间轴节点图标。
 */
function orderTimelineIcon(key: string): LucideIcon {
  if (key === "created") return ClipboardCheck;
  if (key === "inWarehouseCN") return Warehouse;
  if (key === "inTransit") return Ship;
  if (key === "customsTH") return Anchor;
  if (key === "outForDelivery") return Truck;
  return PackageCheck;
}

const VALID_PACKAGE_UNITS = ["bag", "box"] as const;
const VALID_TRANSPORT_MODES = ["sea", "land"] as const;

function PrealertPrintButton({ item }: { item: OrderItem }) {
  const wl = warehouseOptions.find(w => w.id === item.warehouseId)?.label || item.warehouseId || "—";
  const safePkgUnit = VALID_PACKAGE_UNITS.includes(item.packageUnit as any) ? (item.packageUnit as "bag"  |  "box") : "box";
  const safeTransport = VALID_TRANSPORT_MODES.includes(item.transportMode as any) ? (item.transportMode as "sea"  |  "land") : "sea";

  return (
    <button type="button" onClick={() => {
      openPrintPrealert({
        prealertNo: item.orderNo || item.id,
        itemName: item.itemName,
        packageCount: item.packageCount,
        packageUnit: safePkgUnit,
        transportMode: safeTransport,
        warehouseLabel: wl,
        domesticTrackingNo: item.domesticTrackingNo,
        createdAt: item.createdAt,
        clientId: item.clientId,
        productQuantity: item.productQuantity,
        products: item.products?.map(p => ({ itemName: p.itemName, packageCount: p.packageCount })),
      });
    }} style={{ border: "1px solid #8b5cf6", borderRadius: 4, padding: "4px 10px", fontSize: 12, background: "#fff", color: "#8b5cf6", cursor: "pointer", marginLeft: 6 }}>打印预报单</button>
  );
}

function imgSrc(img: { imageUrl?: string | null; mime: string; contentBase64: string }): string {
  if (img.imageUrl) return apiBaseUrl() + img.imageUrl;
  return 'data:' + img.mime + ';base64,' + img.contentBase64;
}

export default function ClientHomePage() {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [toast, setToast] = useState("");
  const [queryMode, setQueryMode] = useState<"unfinished"  |  "completed"  |  "all"  |  null>("all");
  const [queriedOrders, setQueriedOrders] = useState<OrderItem[]>([]);
  const [hasQueried, setHasQueried] = useState(false);
  const [prealerts, setPrealerts] = useState<OrderItem[]>([]);
  const [dashboardOrders, setDashboardOrders] = useState<OrderItem[]>([]);
  const [walletRateText, setWalletRateText] = useState("-");
  const [prealertSearch, setPrealertSearch] = useState("");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingPrealert, setEditingPrealert] = useState<OrderItem  |  null>(null);
  const [previewImage, setPreviewImage] = useState<{ src: string; alt: string }  |  null>(null);
  const [shippingPrices, setShippingPrices] = useState<Record<string, ShippingPriceItem>  |  null>(null);
  const [selectedOrders, setSelectedOrders] = useState<Set<string>>(new Set());
  const [pageSize, setPageSize] = useState(100);
  const toggleSelectClientOrder = (id: string) => { setSelectedOrders((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; }); };
  const [queryPanelCollapsed, setQueryPanelCollapsed] = useState(false);
  const [openLogisticsByOrder, setOpenLogisticsByOrder] = useState<Record<string, boolean>>({});
  const [openDetailsByOrder, setOpenDetailsByOrder] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState(initialSearch);
  const [aiQuestion, setAiQuestion] = useState("");
  const [aiAnswer, setAiAnswer] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [freightForm, setFreightForm] = useState({
    warehouseId: "",
    itemName: "",
    transportMode: "land" as FreightTransportMode,
    cargoType: "normal" as FreightCargoType,
    weightKg: "",
    volumeM3: "",
    unitPriceOverride: "",
  });
  const [form, setForm] = useState({
    warehouseId: "",
    itemName: "",
    packageCount: "",
    packageUnit: "box" as "bag"  |  "box",
    lengthCm: "",
    widthCm: "",
    heightCm: "",
    trackingNo: "",
    weightKg: "",
    volumeM3: "",
    domesticTrackingNo: "",
    transportMode: "" as ""  |  "sea"  |  "land",
    receiverNameTh: "",
    receiverPhoneTh: "",
    receiverAddressTh: "",
  });
  const [formProducts, setFormProducts] = useState<Array<{
    itemName: string; packageCount: string; lengthCm: string; widthCm: string; heightCm: string; productQuantity: string; weightKg: string; domesticTrackingNo: string;
  }>>([]);
  const [prealertImageFiles, setPrealertImageFiles] = useState<File[]>([]);
  const [prealertImagePreviews, setPrealertImagePreviews] = useState<string[]>([]);
  const [addressBook, setAddressBook] = useState<ClientAddressItem[]>([]);
  const [selectedAddressId, setSelectedAddressId] = useState("");
  const [activeSection, setActiveSection] = useState<(typeof CLIENT_SECTION_IDS)[number]>("client-main");

  // 判断 hash 是否属于客户端可展示的功能分区。
  const isClientSectionId = (value: string): value is (typeof CLIENT_SECTION_IDS)[number] =>
    CLIENT_SECTION_IDS.includes(value as (typeof CLIENT_SECTION_IDS)[number]);

  const refreshMainData = async () => {
    const [allPrealerts, orders, wallet, addresses] = await Promise.all([
      fetchClientPrealerts("all"),
      fetchClientOrders(),
      fetchClientWalletOverview(),
      fetchClientAddresses(),
    ]);
    setPrealerts(allPrealerts);
    setDashboardOrders(orders);
    setWalletRateText(wallet.exchangeRate.rate.toFixed(4));
    setAddressBook(addresses);
  };

  /**
   * 根据长宽高（厘米）计算体积（立方米）。
   */
  const volumeM3FromDimensionsCm = (l: number, w: number, h: number) => (l * w * h) / 1_000_000;

  /**
   * 格式化体积字符串。
   */
  const formatVolumeM3String = (m3: number): string => {
    if (!Number.isFinite(m3) || m3 <= 0) return "";
    return String(Number(m3.toFixed(6)));
  };

  /**
   * 更新长宽高并同步计算体积。
   */
  const updateOrderDimensions = (patch: Partial<Pick<typeof form, "lengthCm"  |  "widthCm"  |  "heightCm"  |  "packageCount">>) => {
    setForm((prev) => {
      const next = { ...prev, ...patch };
      const l = Number(String(next.lengthCm).trim());
      const w = Number(String(next.widthCm).trim());
      const h = Number(String(next.heightCm).trim());
      const pkg = Number(String(next.packageCount).trim());
      if (Number.isFinite(l) && Number.isFinite(w) && Number.isFinite(h) && l > 0 && w > 0 && h > 0) {
        const single = volumeM3FromDimensionsCm(l, w, h);
        next.volumeM3 = formatVolumeM3String(Number.isFinite(pkg) && pkg > 0 ? single * pkg : single);
      } else {
        next.volumeM3 = "";
      }
      return next;
    });
  };

  /**
   * 从地址簿快速填充收件信息。
   */
  const applyAddressBook = (addressId: string) => {
    const selected = addressBook.find((item) => item.id === addressId);
    if (!selected) return;
    setForm((prev) => ({
      ...prev,
      receiverNameTh: selected.contactName,
      receiverPhoneTh: selected.contactPhone,
      receiverAddressTh: selected.addressDetail,
    }));
  };

  useEffect(() => {
    setLoading(true);
    refreshMainData()
      .catch((error) => {
        const text = error instanceof Error ? error.message : "加载失败";
        setMessage(`加载失败：${text}`);
      })
      .finally(() => setLoading(false));

    // 加载运费价格表
    fetchShippingPrices().then(setShippingPrices).catch(() => {});

    // 10 秒自动刷新同步
    const interval = window.setInterval(() => {
      refreshMainData().catch(() => {});
    }, 10000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);
  // Auto-fill volume and weight from multi-product form
  useEffect(() => {
    if (formProducts.length === 0) return;
    const totalVol = formProducts.reduce((s, p) => {
      const pkg = Number(p.packageCount) || 0;
      const l = Number(p.lengthCm) || 0;
      const w = Number(p.widthCm) || 0;
      const h = Number(p.heightCm) || 0;
      return s + ((l > 0 && w > 0 && h > 0) ? (l * w * h * pkg) / 1_000_000 : 0);
    }, 0);
    const totalWt = formProducts.reduce((s, p) => {
      const pkg = Number(p.packageCount) || 0;
      const wt = Number(p.weightKg) || 0;
      return s + wt * pkg;
    }, 0);
    setForm((v) => ({ ...v, volumeM3: totalVol > 0 ? String(totalVol.toFixed(6)) : v.volumeM3, weightKg: totalWt > 0 ? String(totalWt.toFixed(2)) : v.weightKg }));
  }, [formProducts]);

  useEffect(() => {
    const syncSectionByHash = () => {
      const hashId = window.location.hash.replace(/^#/, "");
      if (isClientSectionId(hashId)) {
        setActiveSection(hashId);
      }
    };
    syncSectionByHash();
    window.addEventListener("hashchange", syncSectionByHash);
    return () => window.removeEventListener("hashchange", syncSectionByHash);
  }, []);

  const submitPrealert = async () => {
    setLoading(true);
    setMessage("");
    try {
      if (!form.warehouseId || !form.itemName.trim() || !form.transportMode) {
        setMessage("请填写仓库、品名、运输方式。");
        setLoading(false);
        return;
      }
      const result = await createClientPrealert({
        warehouseId: form.warehouseId,
        itemName: form.itemName.trim(),
        packageCount: Number(form.packageCount || 0),
        packageUnit: form.packageUnit,
        weightKg: form.weightKg ? Number(form.weightKg) : undefined,
        volumeM3: form.volumeM3 ? Number(form.volumeM3) : undefined,
        domesticTrackingNo: form.domesticTrackingNo.trim() || undefined,
        transportMode: form.transportMode as "sea"  |  "land",
        receiverNameTh: form.receiverNameTh.trim() || undefined,
        receiverPhoneTh: form.receiverPhoneTh.trim() || undefined,
        receiverAddressTh: form.receiverAddressTh.trim() || undefined,
      });
      setToast("预报单提交成功");
      setMessage(`预报单创建成功：${result.prealertId}`);
      await refreshMainData();
    } catch (error) {
      const text = error instanceof Error ? error.message : "提交失败";
      setMessage(`提交失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  const handleShip = async (orderId: string) => {
    try {
      const result = await shipClientPrealert(orderId);
      setToast("确认发货成功！运单号：" + result.trackingNo);
      await refreshMainData();
      // 同步更新运单查询列表（若已查询过）
      if (hasQueried) {
        const orders = await fetchClientOrders();
        setQueriedOrders(orders);
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : "确认发货失败";
      setToast("确认发货失败：" + text);
    }
  };

  const runOrderQuery = async () => {
    if (!queryMode) {
      setMessage("请先选择“订单在途”“订单已完成”或“全部订单”。");
      return;
    }

    setLoading(true);
    setMessage("");
    try {
      const baseOrders =
        queryMode === "all"
          ? await fetchClientOrders()
          : await fetchClientOrders({ statusGroup: queryMode });
      const result = baseOrders
        .filter((item) => !search.batchNo || (item.trackingNo ?? "").toLowerCase().includes(search.batchNo.toLowerCase()))
        .filter((item) => !search.orderId || item.id.toLowerCase().includes(search.orderId.toLowerCase()))
        .filter((item) => {
          const d = item.createdAt.slice(0, 10);
          if (search.arrivedDateFrom && d < search.arrivedDateFrom) return false;
          if (search.arrivedDateTo && d > search.arrivedDateTo) return false;
          return true;
        })
        .filter(
          (item) =>
            !search.domesticTrackingNo || (item.domesticTrackingNo ?? "").toLowerCase().includes(search.domesticTrackingNo.toLowerCase()),
        )
        .filter((item) => !search.status || (item.currentStatus ?? "").toLowerCase() === search.status.toLowerCase())
        .filter((item) => !search.transportMode || item.transportMode === search.transportMode)
        .filter((item) => !search.warehouseId || item.warehouseId === search.warehouseId);
      setQueriedOrders(result);
      setHasQueried(true);
    } catch (error) {
      const text = error instanceof Error ? error.message : "查询失败";
      setMessage(`查询失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  /**
   * 查询区默认加载：进入“我的运单查询”后自动展示全部订单。
   */
  const runDefaultAllOrderQuery = async () => {
    if (loading) return;
    setLoading(true);
    setMessage("");
    try {
      const result = await fetchClientOrders();
      setQueryMode("all");
      setSearch(initialSearch);
      setQueriedOrders(result);
      setHasQueried(true);
    } catch (error) {
      const text = error instanceof Error ? error.message : "查询失败";
      setMessage(`查询失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  /**
   * 切换运单查询分组（在途/已完成/全部）。
   */
  const changeQueryMode = (mode: "unfinished"  |  "completed"  |  "all") => {
    setQueryMode(mode);
    setSearch(initialSearch);
    setHasQueried(false);
    setQueriedOrders([]);
    setMessage("");
  };

  const runAiSearch = async () => {
    const question = aiQuestion.trim();
    if (!question || aiLoading) return;
    setAiLoading(true);
    setAiAnswer("");
    try {
      const result = await sendAiMessage({ message: question });
      setAiAnswer(result.answer);
    } catch (error) {
      const text = error instanceof Error ? error.message : "AI 查询失败";
      setAiAnswer(`AI 查询失败：${text}`);
    } finally {
      setAiLoading(false);
    }
  };

  useEffect(() => {
    if (activeSection !== "client-query") return;
    if (hasQueried) return;
    void runDefaultAllOrderQuery();
  }, [activeSection, hasQueried]);

  const statusToneClass = (status?: string): string => {
    const value = (status ?? "").toLowerCase();
    if (value === "delivered" || value === "returned" || value === "cancelled") return "order-badge order-badge-land";
    if (value === "loaded" || value === "delaydeparted" || value === "departed" || value === "arrivedport" || value === "customsth" || value === "customscleared" || value === "inwarehouseth" || value === "outfordelivery") {
      return "order-badge order-badge-sea";
    }
    return "order-badge";
  };

  const logisticsStatusText = (status?: string): string => {
    const value = (status ?? "").toLowerCase();
    if (value === "delivered" || value === "returned" || value === "cancelled") return "已到达";
    if (value === "loaded" || value === "delaydeparted" || value === "departed" || value === "arrivedport" || value === "customsth" || value === "customscleared" || value === "inwarehouseth" || value === "outfordelivery") return "途中";
    return "已收货";
  };

  /**
   * 将系统状态值映射为中文订单状态文案。
   */
  const orderStatusText = (status?: string): string => {
    const value = (status ?? "").toLowerCase();
    if (!value) return "未更新";
    if (value === "created") return "已创建";
    if (value === "pickedup") return "已揽收";
    if (value === "inwarehousecn" || value === "receivedcn") return "国内仓已收货";
    if (value === "customspending") return "报关中";
    if (value === "loaded") return "已装柜";
    if (value === "delaydeparted") return "延迟开船";
    if (value === "departed") return "已开船";
    if (value === "arrivedport") return "已到港";
    if (value === "intransit") return "运输中";
    if (value === "customsth") return "清关中";
    if (value === "customscleared") return "清关已放行";
    if (value === "inwarehouseth" || value === "warehouseth") return "已到仓";
    if (value === "outfordelivery") return "派送中";
    if (value === "delivered") return "派送完成";
    if (value === "returned") return "已退回";
    if (value === "cancelled") return "已取消";
    if (value === "exception") return "异常件";
    return "未更新";
  };

  /**
   * 将状态值归一化到订单时间轴节点。
   */
  const normalizeTimelineStatus = (status?: string): string => {
    const value = (status ?? "").toLowerCase();
    if (!value) return "";
    if (value === "delaydeparted") return "departed";
    if (value === "customscleared") return "inWarehouseTH";
    return value;
  };

  /**
   * 构建带阶段（已完成/进行中/未开始）的物流时间轴数据。
   */
  const buildOrderTimeline = (status?: string): Array<{ key: string; label: string; phase: "done"  |  "active"  |  "pending" }> => {
    const normalized = normalizeTimelineStatus(status);
    const activeIndex = ORDER_TIMELINE.findIndex((item) => item.key.toLowerCase() === normalized.toLowerCase());
    const fallbackIndex = normalized === "delivered" ? ORDER_TIMELINE.length - 1 : Math.max(activeIndex, 0);
    return ORDER_TIMELINE.map((item, index) => {
      if (index < fallbackIndex) return { ...item, phase: "done" };
      if (index === fallbackIndex) return { ...item, phase: "active" };
      return { ...item, phase: "pending" };
    });
  };

  /**
   * 将时间字符串格式化为“yyyy/MM/dd HH:mm:ss”。
   */
  const formatDateTime = (value?: string): string => {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString("zh-CN", { hour12: false });
  };

  /**
   * 状态值转中文文案（用于状态变更日志）。
   */
  const statusLabel = (value?: string): string => {
    return orderStatusText(value);
  };

  /**
   * 构建物流状态变更记录（按时间升序，并补充时间段信息）。
   */
  const buildLogisticsTransitions = (
    records: OrderItem["logisticsRecords"]  |  undefined,
  ): Array<{
    fromStatus?: string;
    toStatus?: string;
    remark: string;
    changedAt: string;
    periodText: string;
  }> => {
    const normalized = [...(records ?? [])].sort(
      (a, b) => new Date(a.changedAt).getTime() - new Date(b.changedAt).getTime(),
    );
    return normalized.map((record, index) => {
      const next = normalized[index + 1];
      const start = formatDateTime(record.changedAt);
      const end = next ? formatDateTime(next.changedAt) : "至今";
      return {
        ...record,
        periodText: `${start} ~ ${end}`,
      };
    });
  };

  const freightWeight = Number(freightForm.weightKg || 0);
  const freightVolume = Number(freightForm.volumeM3 || 0);
  const safeWeight = Number.isNaN(freightWeight) ? 0 : Math.max(freightWeight, 0);
  const safeVolume = Number.isNaN(freightVolume) ? 0 : Math.max(freightVolume, 0);
  const priceKey = `${freightForm.transportMode} | ${freightForm.cargoType}`;
  const defaultUnitPrice = shippingPrices?.[priceKey]?.unitPriceCny ?? freightRateMap[freightForm.transportMode][freightForm.cargoType];
  const overrideUnitPriceRaw = freightForm.unitPriceOverride.trim();
  const overrideUnitPrice = overrideUnitPriceRaw ? Number(overrideUnitPriceRaw) : undefined;
  const unitPrice =
    overrideUnitPrice !== undefined && !Number.isNaN(overrideUnitPrice) && overrideUnitPrice > 0
      ? overrideUnitPrice
      : defaultUnitPrice;
  const convertedVolumeByWeight = safeWeight / 500;
  const chargeVolume = Math.max(safeVolume, convertedVolumeByWeight);
  const disableMin = shippingPrices?.[priceKey]?.disableMinVolume ?? false;
  const minVolume = disableMin ? 0 : (freightForm.transportMode === "sea" ? 0.5 : 0.3);
  const finalChargeVolume = minVolume > 0 ? Math.max(chargeVolume, minVolume) : chargeVolume;
  let freightFee = finalChargeVolume * unitPrice;
  // 义乌陆运附加费 +120/方
  if (freightForm.transportMode === "land" && freightForm.warehouseId === "wh_yiwu_01") {
    freightFee += finalChargeVolume * 120;
  }
  const estimatedFee = freightFee;
  const hasFreightInput = safeWeight > 0 || safeVolume > 0;
  const cargoTypeLabel =
    freightForm.cargoType === "normal"
      ? "普货"
      : freightForm.cargoType === "inspection"
        ? "商检货"
        : "敏感货";
  const transportLabel =
    freightForm.transportMode === "sea"
      ? "海运"
      : freightForm.transportMode === "land"
        ? "陆运"
        : "快线";
  const etaByMode = freightForm.transportMode === "sea" ? "预计 12-18 天" : freightForm.transportMode === "land" ? "预计 5-8 天" : "预计 2-4 天";

  /**
   * 客户看板状态统计：用于状态卡片与图表展示。
   */
  const clientStatusData = useMemo(() => {
    const bucket = { completed: 0, unfinished: 0, processing: 0 };
    dashboardOrders.forEach((item) => {
      const group = (item.statusGroup ?? "").toLowerCase();
      const approval = (item.approvalStatus ?? "").toLowerCase();
      if (approval !== "approved") {
        bucket.processing += 1;
      } else if (group === "completed") {
        bucket.completed += 1;
      } else {
        bucket.unfinished += 1;
      }
    });
    return [
      { name: "已完成", value: bucket.completed, color: "#10b981" },
      { name: "在途", value: bucket.unfinished, color: "#f59e0b" },
      { name: "处理中", value: bucket.processing, color: "#f59e0b" },
    ];
  }, [dashboardOrders]);

  /**
   * 客户时效趋势图：按最近订单构建可视化趋势。
   */
  const clientEtaTrend = useMemo(() => {
    return dashboardOrders.slice(0, 8).map((item, index) => ({
      label: `订单${index + 1}`,
      orderId: item.id,
      days: Number((2.2 + index * 0.5 + (item.transportMode === "sea" ? 4.6 : 1.2)).toFixed(1)),
    }));
  }, [dashboardOrders]);

  /**
   * 客户可见在途柜量：按批次号去重统计。
   */
  const clientInTransitContainerCount = useMemo(() => {
    const set = new Set(
      dashboardOrders
        .filter((item) => (item.statusGroup ?? "").toLowerCase() === "unfinished")
        .map((item) => item.batchNo ?? "")
        .filter((item) => item),
    );
    return set.size;
  }, [dashboardOrders]);

  return (
    <RoleShell allowedRole="client" title="客户端工作台">
      <p style={{ color: "#4b5563", marginBottom: 20 }}>
        客户提交预报单后会先进入“预报中”，员工审核通过后会自动进入“我的订单”。
      </p>

      <section
        id="client-main"
        className="client-main-section"
        style={{ display: activeSection === "client-main" ? "block" : "none" }}
      >
        <div className="section-label section-label-primary">主业务区</div>
        <h2 style={{ marginTop: 0, fontSize: 20 }}>主页</h2>
        <div className="dashboard-grid-2" style={{ marginBottom: 12 }}>
          <div className="dashboard-panel">
            <div className="dashboard-panel-title">中泰线路时效分析图</div>
            <div style={{ width: "100%", height: 220 }}>
              <ResponsiveContainer>
                <LineChart data={clientEtaTrend}>
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
            <div style={{ width: "100%", height: 220 }}>
              <ResponsiveContainer>
                <BarChart data={clientStatusData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="name" stroke="#000000" />
                  <YAxis stroke="#000000" />
                  <Tooltip />
                  <Bar dataKey="value" radius={[6, 6, 0, 0]}>
                    {clientStatusData.map((item) => (
                      <Cell key={item.name} fill={item.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
        <div className="dashboard-panel" style={{ marginBottom: 12 }}>
          <div className="dashboard-panel-title">中泰海陆运路线概览（简化）</div>
          <div className="route-map-wrap">
            <div className="route-point route-point-cn">中国仓</div>
            <div className="route-line route-line-sea" />
            <div className="route-line route-line-land" />
            <div className="route-point route-point-th">泰国仓</div>
            <div className="route-counter">当前在途柜量：{clientInTransitContainerCount}</div>
          </div>
        </div>

        {/* 预报单管理 */}
        <div style={{ marginBottom: 14, border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, background: "#fff" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontWeight: 700, color: "var(--ink)", fontSize: 16 }}>预报单</div>
            <button type="button" onClick={() => setShowCreateModal(true)}
              style={{ border: "none", borderRadius: 6, padding: "8px 16px", background: "#2563eb", color: "#fff", fontWeight: 500, fontSize: 13, cursor: "pointer" }}>创建预报单</button>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontSize: 12, color: "#000000" }}>共 {prealerts.length} 条</div>
            <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "4px 8px", fontSize: 12 }}>
              {[20, 50, 100, 200, 500, 1000].map((n) => <option key={n} value={n}>{n}条/页</option>)}
            </select>
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <input value={prealertSearch} onChange={(e) => setPrealertSearch(e.target.value)}
              placeholder="搜索单号、品名…"
              style={{ flex: 1, border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 12px", fontSize: 13 }} />
          </div>
          {prealerts.length === 0 ? (
            <div style={{ color: "#000000", fontSize: 13, padding: "20px 0", textAlign: "center" }}>暂无预报单</div>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              {prealerts.filter((item) => {
                const q = prealertSearch.trim().toLowerCase();
                if (!q) return true;
                return item.id.toLowerCase().includes(q) || (item.itemName ?? "").toLowerCase().includes(q);
              }).slice(0, pageSize).map((item) => {
                const isPending = item.approvalStatus === "pending";
                const isApproved = item.approvalStatus === "approved";
                const isShipped = item.approvalStatus === "shipped";
                const isReceived = item.currentStatus === "delivered" || item.currentStatus === "inWarehouseCN";
                const sLabel = isPending ? "待审核" : isApproved ? "已审核" : isReceived ? "已入库" : "已发货";
                const sColor = isPending ? "#92400e" : isApproved ? "#0369a1" : isReceived ? "#16a34a" : "#000000";
                const sBg = isPending ? "#fef3c7" : isApproved ? "#e0f2fe" : isReceived ? "#dcfce7" : "#f3f4f6";
                const sBd = isPending ? "#fde68a" : isApproved ? "#7dd3fc" : isReceived ? "#86efac" : "#e5e7eb";
                return (
                  <div key={item.id} style={{ border: "1px solid " + sBd, borderRadius: 8, padding: 12, background: "#fff" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                      <div>
                        <span style={{ fontWeight: 600, fontSize: 14, fontFamily: "monospace" }}>{item.orderNo || item.id}</span>
                        <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 500, color: sColor, background: sBg, padding: "2px 8px", borderRadius: 4 }}>{sLabel}</span>
                      </div>
                      <div style={{ fontSize: 12, color: "#000000" }}>{item.createdAt.slice(0, 10)}</div>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 6, fontSize: 13, color: "#000000", marginBottom: 8 }}>
                      <div>品名：{item.itemName}</div>
                      <div>件数：{item.packageCount} {item.packageUnit === "box" ? "箱" : "袋"}</div>
                      <div>运输：{item.transportMode === "sea" ? "海运" : "陆运"}</div>
                      
                      {isShipped && item.trackingNo ? <div>运单号：{item.trackingNo}</div> : null}
                    </div>
                    {(item.products?.length ?? 0) > 1 && (
                      <div style={{ marginBottom: 8, fontSize: 12, color: "#000000", background: "#f8fafc", borderRadius: 6, padding: "6px 8px" }}>
                        {item.products!.map((p, i) => (
                          <div key={p.id || i}>{p.itemName} ×{p.packageCount}箱</div>
                        ))}
                      </div>
                    )}
                    {(item.productImages?.length ?? 0) > 0 && (
                      <div style={{ display: "flex", gap: 4, marginBottom: 8, flexWrap: "wrap" }}>
                        {item.productImages!.map((img) => (
                          <img
                            key={img.id}
                            src={imgSrc(img)}
                            alt={img.fileName}
                            onClick={() => setPreviewImage({ src: imgSrc(img), alt: img.fileName })}
                            style={{ width: 100, height: 100, objectFit: "cover", borderRadius: 4, border: "1px solid #e5e7eb", cursor: "pointer" }}
                          />
                        ))}
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", borderTop: "1px solid #f3f4f6", paddingTop: 8 }}>
                      {isPending && (
                        <>
                          <button type="button" onClick={() => setEditingPrealert(item)}
                            style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "4px 10px", fontSize: 12, background: "#fff", color: "#000000", cursor: "pointer" }}>编辑</button>
                          <button type="button" onClick={async () => {
                            if (!confirm("确定删除此预报单？")) return;
                            try { await deleteClientPrealert(item.id); setToast("预报单已删除"); await refreshMainData(); }
                            catch { setToast("删除失败"); }
                          }} style={{ border: "1px solid #fca5a5", borderRadius: 4, padding: "4px 10px", fontSize: 12, background: "#fff", color: "#dc2626", cursor: "pointer" }}>删除</button>
                        </>
                      )}
                      {isApproved && (
                        <button type="button" disabled={false} onClick={() => {
                          if (confirm("确认发货？预报单号：" + (item.orderNo || item.id))) void handleShip(item.id);
                        }} style={{ border: "none", borderRadius: 4, padding: "4px 14px", fontSize: 12, background: "#16a34a", color: "#fff", fontWeight: 500, cursor: "pointer" }}>确认发货</button>
                      )}
                      {(isApproved || isShipped) && item.trackingNo ? (
                        <button type="button" onClick={() => openPrintLabel({ marks: item.clientId ?? "", packageCount: item.packageCount ?? "—", trackingNo: item.trackingNo ?? "", itemName: item.itemName, productQuantity: item.productQuantity, transportMode: item.transportMode, products: item.products?.map(p => ({ itemName: p.itemName, packageCount: p.packageCount })) })} style={{ border: "1px solid #16a34a", borderRadius: 4, padding: "4px 10px", fontSize: 12, background: "#fff", color: "#16a34a", cursor: "pointer", marginLeft: 6 }}>打印</button>
                      ) : null}
                      {item.trackingNo ? (
                        <button type="button" onClick={() => openShipmentTrack(item.trackingNo!)} style={{ border: "1px solid #2563eb", borderRadius: 4, padding: "4px 10px", fontSize: 12, background: "#fff", color: "#2563eb", cursor: "pointer", marginLeft: 6 }}>物流轨迹</button>
                      ) : null}
                      <PrealertPrintButton item={item} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, marginBottom: 12, background: "#f8fafc" }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>AI问答</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={aiQuestion}
              onChange={(e) => setAiQuestion(e.target.value)}
              placeholder="例如：我的运单现在到哪了？"
              style={{ flex: 1, border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void runAiSearch();
                }
              }}
            />
            <button
              type="button"
              onClick={() => void runAiSearch()}
              disabled={aiLoading}
              style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff", background: "#1d4ed8" }}
            >
              {aiLoading ? "查询中..." : "AI 搜索"}
            </button>
          </div>
          {aiAnswer ? (
            <div style={{ marginTop: 8, whiteSpace: "pre-wrap", color: "#000000", fontSize: 13 }}>{aiAnswer}</div>
          ) : null}
        </div>

        <div style={{ border: "1px solid #dbeafe", borderRadius: 10, padding: 12, marginBottom: 12, background: "#f8fbff" }}>
          <div style={{ fontWeight: 700, color: "#1e40af", marginBottom: 8 }}>运费计算器</div>
          <div style={{ color: "#000000", fontSize: 13, marginBottom: 10 }}>
            输入品名、重量、体积后，自动计算基础运费，并给出预计时效。
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8 }}>
            <input
              value={freightForm.itemName}
              onChange={(e) => setFreightForm((v) => ({ ...v, itemName: e.target.value }))}
              placeholder="品名（例如：服装）"
              style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
            />
            <select
              value={freightForm.warehouseId}
              onChange={(e) => setFreightForm((v) => ({ ...v, warehouseId: e.target.value }))}
              style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
            >
              <option value="">请选择国内仓库地址</option>
              {warehouseOptions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <select
              value={freightForm.transportMode}
              onChange={(e) =>
                setFreightForm((v) => ({ ...v, transportMode: e.target.value as FreightTransportMode }))
              }
              style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
            >
              <option value="land">陆运</option>
              <option value="sea">海运</option>
              <option value="express">快线</option>
            </select>
            <select
              value={freightForm.cargoType}
              onChange={(e) =>
                setFreightForm((v) => ({ ...v, cargoType: e.target.value as FreightCargoType }))
              }
              style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
            >
              <option value="normal">普货</option>
              <option value="inspection">商检货</option>
              <option value="sensitive">敏感货</option>
            </select>
            <input
              type="number"
              step="0.01"
              min="0"
              value={freightForm.weightKg}
              onChange={(e) => setFreightForm((v) => ({ ...v, weightKg: e.target.value }))}
              placeholder="重量（千克）"
              style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
            />
            <input
              type="number"
              step="0.001"
              min="0"
              value={freightForm.volumeM3}
              onChange={(e) => setFreightForm((v) => ({ ...v, volumeM3: e.target.value }))}
              placeholder="体积（立方米）"
              style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
            />
            <input
              type="number"
              step="1"
              min="0"
              value={freightForm.unitPriceOverride}
              onChange={(e) => setFreightForm((v) => ({ ...v, unitPriceOverride: e.target.value }))}
              placeholder={`体积单价（元/立方），默认 ${defaultUnitPrice}`}
              style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
            />
          </div>

          <div style={{ marginTop: 10, fontSize: 13, color: "#000000", whiteSpace: "pre-wrap" }}>
            {freightForm.warehouseId
              ? `仓库地址：${warehouseAddressMap[freightForm.warehouseId]}`
              : "仓库地址：请先选择仓库"}
          </div>
          <div style={{ marginTop: 8, border: "1px solid #e2e8f0", borderRadius: 8, padding: "10px 12px", background: "#fff" }}>
            {hasFreightInput ? (
              <>
                <div style={{ fontWeight: 700, color: "#0f172a" }}>
                  预估运费：¥{estimatedFee.toFixed(2)}
                </div>
                <div style={{ marginTop: 6, color: "#000000", fontSize: 13 }}>
                  计费规则：{transportLabel} / {cargoTypeLabel}，先比较体积：
                  max(实际体积 {safeVolume.toFixed(3)}，重量折算体积 {convertedVolumeByWeight.toFixed(3)}（500千克=1立方米）)
                  = {chargeVolume.toFixed(3)} 立方米{chargeVolume < finalChargeVolume ? `（低消${minVolume}方，按${finalChargeVolume.toFixed(3)}计费）` : ""}；
                  基础运费 = {finalChargeVolume.toFixed(3)} × ¥{unitPrice}/立方米 = ¥{freightFee.toFixed(2)}；
                  合计 = ¥{estimatedFee.toFixed(2)}。
                </div>
                <div style={{ marginTop: 6, color: "#000000", fontSize: 12 }}>
                  注：该结果为预估价；{etaByMode}，最终以客服复核与实际计费规则为准。
                </div>
              </>
            ) : (
              <div style={{ color: "#000000", fontSize: 13 }}>
                请输入重量或体积后自动计算预估运费。
              </div>
            )}
          </div>
        </div>
      </section>

      {activeSection === "client-main" || activeSection === "client-query" ? (
        <div className="section-divider" aria-hidden />
      ) : null}

      <section
        id="client-query"
        className="client-query-section"
        style={{ display: activeSection === "client-query" ? "block" : "none" }}
      >
        <div className="section-label section-label-query">查询区</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 20 }}>我的运单查询</h2>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <a
              href="/client/bills"
              style={{
                border: "1px solid #bfdbfe",
                borderRadius: 8,
                padding: "6px 10px",
                color: "#1d4ed8",
                background: "#eff6ff",
                fontWeight: 800,
                textDecoration: "none",
              }}
            >
              账单
            </a>
            <button
              type="button"
              onClick={() => setQueryPanelCollapsed((v) => !v)}
              style={{
                border: "1px solid #d1d5db",
                borderRadius: 8,
                padding: "6px 10px",
                color: "#000000",
                background: "#fff",
                fontWeight: 600,
              }}
            >
              {queryPanelCollapsed ? "展开" : "折叠"}
            </button>
          </div>
        </div>

        {!queryPanelCollapsed ? (
          <>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <button
                type="button"
                onClick={() => changeQueryMode("unfinished")}
                style={{
                  border: "none",
                  borderRadius: 999,
                  padding: "6px 14px",
                  color: "#fff",
                  background: queryMode === "unfinished" ? "#2563eb" : "#000000",
                }}
              >
                订单在途
              </button>
              <button
                type="button"
                onClick={() => changeQueryMode("completed")}
                style={{
                  border: "none",
                  borderRadius: 999,
                  padding: "6px 14px",
                  color: "#fff",
                  background: queryMode === "completed" ? "#2563eb" : "#000000",
                }}
              >
                订单已完成
              </button>
              <button
                type="button"
                onClick={() => changeQueryMode("all")}
                style={{
                  border: "none",
                  borderRadius: 999,
                  padding: "6px 14px",
                  color: "#fff",
                  background: queryMode === "all" ? "#2563eb" : "#000000",
                }}
              >
                全部订单
              </button>
            </div>

        {!queryMode ? (
          <EmptyStateCard title="订单已折叠" description="请先点击“订单在途”“订单已完成”或“全部订单”，再展开搜索框进行查询。" />
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8, marginBottom: 12 }}>
              <input
                value={search.batchNo}
                onChange={(e) => setSearch((v) => ({ ...v, batchNo: e.target.value }))}
                placeholder="运单号"
                style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
              />
              <input
                value={search.orderId}
                onChange={(e) => setSearch((v) => ({ ...v, orderId: e.target.value }))}
                placeholder="订单号"
                style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
              />
              <div style={{ display: "flex", gap: 4, alignItems: "center", gridColumn: "span 2" }}>
                <input
                  type="date"
                  value={search.arrivedDateFrom}
                  onChange={(e) => setSearch((v) => ({ ...v, arrivedDateFrom: e.target.value }))}
                  style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", flex: 1 }}
                  placeholder="到仓起始"
                />
                <span style={{ fontSize: 12, color: "#6b7280" }}>~</span>
                <input
                  type="date"
                  value={search.arrivedDateTo}
                  onChange={(e) => setSearch((v) => ({ ...v, arrivedDateTo: e.target.value }))}
                  style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", flex: 1 }}
                  placeholder="到仓截止"
                />
              </div>
              <div style={{ position: "relative", width: "100%", display: "none" }}>
                <input type="date" style={{ display: "none" }} />
                {(!search.arrivedDateFrom && !search.arrivedDateTo) ? (
                  <div
                    style={{
                      position: "absolute",
                      right: 36,
                      top: "50%",
                      transform: "translateY(-50%)",
                      fontSize: 12,
                      color: "#000000",
                      pointerEvents: "none",
                    }}
                  >
                    到仓日期
                  </div>
                ) : null}
              </div>
              <input
                value={search.domesticTrackingNo}
                onChange={(e) => setSearch((v) => ({ ...v, domesticTrackingNo: e.target.value }))}
                placeholder="国内快递单号"
                style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
              />
              <input
                value={search.status}
                onChange={(e) => setSearch((v) => ({ ...v, status: e.target.value }))}
                placeholder="状态（如 运输中）"
                style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
              />
              <select
                value={search.transportMode}
                onChange={(e) => setSearch((v) => ({ ...v, transportMode: e.target.value }))}
                style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
              >
                <option value="">运输方式（全部）</option>
                <option value="sea">海运</option>
                <option value="land">陆运</option>
              </select>
              <select
                value={search.warehouseId}
                onChange={(e) => setSearch((v) => ({ ...v, warehouseId: e.target.value }))}
                style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
              >
                <option value="">仓库（全部）</option>
                {warehouseOptions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <button
                type="button"
                onClick={() => void runOrderQuery()}
                disabled={loading}
                style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff", background: "#2563eb" }}
              >
                执行查询
              </button>
              <button
                type="button"
                onClick={() => {
                  setSearch(initialSearch);
                  setHasQueried(false);
                  setQueriedOrders([]);
                }}
                style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "8px 14px", background: "#fff", color: "#000000" }}
              >
                清空条件
              </button>
            </div>

            {!hasQueried ? (
              <EmptyStateCard
                title="正在加载订单"
                description="已自动为你加载“全部订单”，你也可调整条件后点击“执行查询”。"
              />
            ) : queriedOrders.length === 0 ? (
              <EmptyStateCard title="无匹配订单" description="可调整查询条件后重新查询。" />
            ) : null}
          </>
        )}

            {hasQueried && queriedOrders.slice(0, pageSize).map((item, idx) => (
          <article key={item.id} className="order-card">
            <div className="order-head">
              <div className="order-title">
                {(item.products?.length ?? 0) > 0
                  ? item.products!.map((p, i) => (
                      <div key={p.id || i} style={{ marginBottom: i < (item.products?.length ?? 0) - 1 ? 4 : 0 }}>
                        <div style={{ fontWeight: 600 }}>{p.itemName}</div>
                        <div style={{ fontSize: 12, color: "#000000", paddingLeft: 4 }}>
                          {p.packageCount}件
                          {p.lengthCm ? `  ${p.lengthCm}×${p.widthCm}×${p.heightCm}cm` : ""}
                          <span style={{ marginLeft: 6, fontSize: 12, color: "#000000" }}>
                            货型：{(p.cargoType ?? "NORMAL") === "INSPECTION" ? "商检" : (p.cargoType ?? "NORMAL") === "SENSITIVE" ? "敏感" : "普货"}
                          </span>
                          <span style={{ marginLeft: 6, fontSize: 12, color: "#000000" }}>
                            国内单号：{p.domesticTrackingNo || "货拉拉"}
                          </span>
                        </div>
                      </div>
                    ))
                  : (item.itemName || "未填品名")}
              </div>
              <div className="order-badges">
                <span className="order-badge order-badge-amount">金额：{formatCny(item.receivableAmountCny ?? null)}</span>
                <span
                  className={`order-badge ${(item.paymentStatus ?? "unpaid") === "paid" ? "order-badge-paid" : "order-badge-unpaid"}`}
                >
                  {(item.paymentStatus ?? "unpaid") === "paid" ? "已付款" : "待付款"}
                </span>
                <a
                  href={`/client/bills/${encodeURIComponent(item.id)}`}
                  style={{
                    border: "1px solid #bfdbfe",
                    borderRadius: 999,
                    padding: "3px 10px",
                    background: "#eff6ff",
                    color: "#1d4ed8",
                    textDecoration: "none",
                    fontSize: 12,
                    fontWeight: 700,
                  }}
                >
                  账单
                </a>
                <span className={`order-badge ${item.transportMode === "sea" ? "order-badge-sea" : "order-badge-land"}`}>
                  {item.transportMode === "sea" ? "海运" : "陆运"}
                </span>
                <span className="order-badge" style={{ background: "#fef3c7", color: "#92400e", borderColor: "#fcd34d" }}>
                  {item.cargoType === "INSPECTION" ? "商检" : item.cargoType === "SENSITIVE" ? "敏感" : "普货"}
                </span>
                <span className={statusToneClass(item.currentStatus)}>{orderStatusText(item.currentStatus)}</span>
              </div>
            </div>

            <div className="order-summary-row">
              <div className="order-summary-item">
                <span className="order-summary-label">单号</span>
                <span className="order-summary-value">{item.trackingNo ?? item.id}</span>
              </div>
              <div className="order-summary-item">
                <span className="order-summary-label">目的国</span>
                <span className="order-summary-value">🇹🇭 泰国</span>
              </div>
              <div className="order-summary-item">
                <span className="order-summary-label">当前状态</span>
                <span className="order-summary-value">{orderStatusText(item.currentStatus)}</span>
              </div>
              <button
                type="button"
                className="order-detail-toggle"
                onClick={() =>
                  setOpenDetailsByOrder((prev) => ({
                    ...prev,
                    [item.id]: !prev[item.id],
                  }))
                }
              >
                {openDetailsByOrder[item.id] ? "收起详情" : "展开详情"}
              </button>
            </div>

            <div className="order-stepper">
              {buildOrderTimeline(item.currentStatus).map((node) => (
                <div key={`${item.id}-${node.key}`} className="order-stepper-node">
                  <span className={`order-step-icon order-step-${node.phase}`} />
                  {(() => {
                    const Icon = orderTimelineIcon(node.key);
                    return <Icon size={12} />;
                  })()}
                  <span className="order-step-label">{node.label}</span>
                </div>
              ))}
            </div>

            {openDetailsByOrder[item.id] ? (
              <div className="order-fields" style={{ marginTop: 10 }}>
                <div className="order-field">
                  <div className="order-field-label">仓库</div>
                  <div className="order-field-value">{warehouseOptions.find(w => w.id === item.warehouseId)?.label ?? item.warehouseId ?? "—"}</div>
                </div>
                <div className="order-field">
                  <div className="order-field-label">国内单号</div>
                  <div className="order-field-value">{item.domesticTrackingNo ?? "-"}</div>
                </div>
                <div className="order-field">
                  <div className="order-field-label">体积</div>
                  <div className="order-field-value">{item.volumeM3 != null ? `${item.volumeM3} m³` : "-"}</div>
                </div>
                <div className="order-field">
                  <div className="order-field-label">重量</div>
                  <div className="order-field-value">{item.weightKg != null ? `${item.weightKg} kg` : "-"}</div>
                </div>
                <div className="order-field">
                  <div className="order-field-label">发货日期</div>
                  <div className="order-field-value">{item.shipDate ?? item.createdAt?.slice(0, 10) ?? "-"}</div>
                </div>
                <div className="order-field">
                  <div className="order-field-label">件数</div>
                  <div className="order-field-value">
                    {item.packageCount} {item.packageUnit === "bag" ? "袋" : "箱"}
                  </div>
                </div>
                {(item.products?.length ?? 0) > 0 && (
                  <div className="order-field">
                    <div className="order-field-label">产品明细</div>
                    <div className="order-field-value" style={{ fontSize: 12 }}>
                      {item.products!.map((p, i) => (
                        <div key={i} style={{ marginBottom: 2 }}>
                          {p.itemName} ×{p.packageCount}
                          {p.lengthCm ? `  ${p.lengthCm}×${p.widthCm}×${p.heightCm}cm` : ""}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div className="order-field">
                  <div className="order-field-label">实时汇率</div>
                  <div className="order-field-value">{walletRateText}</div>
                </div>
                <div className="order-field">
                  <div className="order-field-label">订单详情 · 产品图</div>
                  <div className="order-field-value" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {(item.productImages?.length ?? 0) === 0 ? (
                      <span style={{ color: "#000000" }}>暂无（由仓库员工上传）</span>
                    ) : (
                      item.productImages?.map((img) => (
                        <a
                          key={img.id}
                          href={imgSrc(img)}
                          download={img.fileName}
                          target="_blank"
                          rel="noreferrer"
                          style={{ display: "block" }}
                        >
                          <img
                            src={imgSrc(img)}
                            alt={img.fileName}
                            style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 8, border: "1px solid #e2e8f0" }}
                          />
                        </a>
                      ))
                    )}
                  </div>
                </div>
                <div className="order-field">
                  <div className="order-field-label">物流状态</div>
                  <div className="order-field-value">
                    {logisticsStatusText(item.currentStatus)}
                    {(item.logisticsRecords?.length ?? 0) > 0 ? (
                      <button
                        type="button"
                        onClick={() =>
                          setOpenLogisticsByOrder((prev) => ({
                            ...prev,
                            [item.id]: !prev[item.id],
                          }))
                        }
                        style={{
                          marginLeft: 8,
                          border: "1px solid #d1d5db",
                          borderRadius: 8,
                          padding: "2px 8px",
                          background: "#fff",
                          color: "#1d4ed8",
                          cursor: "pointer",
                          fontSize: 12,
                        }}
                      >
                        {openLogisticsByOrder[item.id] ? "收起记录" : `查看记录（${item.logisticsRecords?.length ?? 0}）`}
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}

            {openDetailsByOrder[item.id] && openLogisticsByOrder[item.id] && (item.logisticsRecords?.length ?? 0) > 0 ? (
              <div
                style={{
                  marginTop: 10,
                  border: "1px solid #e2e8f0",
                  borderRadius: 8,
                  background: "#f8fafc",
                  padding: 10,
                  display: "grid",
                  gap: 8,
                }}
              >
                {buildLogisticsTransitions(item.logisticsRecords).map((record, index) => (
                  <div
                    key={`${item.id}-${record.changedAt}-${index}`}
                    style={{
                      border: "1px solid #e2e8f0",
                      borderRadius: 8,
                      padding: "8px 10px",
                      background: "#fff",
                      color: "#000000",
                      fontSize: 13,
                    }}
                  >
                    <div style={{ marginBottom: 4, fontWeight: 600 }}>
                      状态变更：{statusLabel(record.fromStatus)}
                      {" -> "}
                      {statusLabel(record.toStatus)}
                    </div>
                    <div style={{ marginBottom: 4 }}>变更时间：{formatDateTime(record.changedAt)}</div>
                    <div style={{ marginBottom: 4 }}>时间段：{record.periodText}</div>
                    <div>物流信息：{record.remark}</div>
                  </div>
                ))}
              </div>
            ) : null}
          </article>
            ))}
          </>
        ) : null}
      </section>

      {activeSection === "client-query" || activeSection === "client-prealert" ? (
        <div className="section-divider" aria-hidden />
      ) : null}
      <section
        id="client-prealert"
        style={{ display: activeSection === "client-prealert" ? "block" : "none" }}
      >
        {/* 预报单管理 */}
        <div style={{ marginBottom: 14, border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, background: "#fff" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontWeight: 700, color: "var(--ink)", fontSize: 16 }}>预报单</div>
            <button type="button" onClick={() => setShowCreateModal(true)}
              style={{ border: "none", borderRadius: 6, padding: "8px 16px", background: "#2563eb", color: "#fff", fontWeight: 500, fontSize: 13, cursor: "pointer" }}>创建预报单</button>
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <input value={prealertSearch} onChange={(e) => setPrealertSearch(e.target.value)}
              placeholder="搜索单号、品名…"
              style={{ flex: 1, border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 12px", fontSize: 13 }} />
          </div>
          {prealerts.length === 0 ? (
            <div style={{ color: "#000000", fontSize: 13, padding: "20px 0", textAlign: "center" }}>暂无预报单</div>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              {prealerts.filter((item) => {
                const q = prealertSearch.trim().toLowerCase();
                if (!q) return true;
                return item.id.toLowerCase().includes(q) || (item.itemName ?? "").toLowerCase().includes(q);
              }).slice(0, pageSize).map((item) => {
                const isPending = item.approvalStatus === "pending";
                const isApproved = item.approvalStatus === "approved";
                const isShipped = item.approvalStatus === "shipped";
                const isReceived = item.currentStatus === "delivered" || item.currentStatus === "inWarehouseCN";
                const sLabel = isPending ? "待审核" : isApproved ? "已审核" : isReceived ? "已入库" : "已发货";
                const sColor = isPending ? "#92400e" : isApproved ? "#0369a1" : isReceived ? "#16a34a" : "#000000";
                const sBg = isPending ? "#fef3c7" : isApproved ? "#e0f2fe" : isReceived ? "#dcfce7" : "#f3f4f6";
                const sBd = isPending ? "#fde68a" : isApproved ? "#7dd3fc" : isReceived ? "#86efac" : "#e5e7eb";
                return (
                  <div key={item.id} style={{ border: "1px solid " + sBd, borderRadius: 8, padding: 12, background: "#fff" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                      <div>
                        <span style={{ fontWeight: 600, fontSize: 14, fontFamily: "monospace" }}>{item.orderNo || item.id}</span>
                        <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 500, color: sColor, background: sBg, padding: "2px 8px", borderRadius: 4 }}>{sLabel}</span>
                      </div>
                      <div style={{ fontSize: 12, color: "#000000" }}>{item.createdAt.slice(0, 10)}</div>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 6, fontSize: 13, color: "#000000", marginBottom: 8 }}>
                      <div>品名：{item.itemName}</div>
                      <div>件数：{item.packageCount} {item.packageUnit === "box" ? "箱" : "袋"}</div>
                      <div>运输：{item.transportMode === "sea" ? "海运" : "陆运"}</div>
                      
                      {isShipped && item.trackingNo ? <div>运单号：{item.trackingNo}</div> : null}
                    </div>
                    {(item.products?.length ?? 0) > 1 && (
                      <div style={{ marginBottom: 8, fontSize: 12, color: "#000000", background: "#f8fafc", borderRadius: 6, padding: "6px 8px" }}>
                        {item.products!.map((p, i) => (
                          <div key={p.id || i}>{p.itemName} ×{p.packageCount}箱</div>
                        ))}
                      </div>
                    )}
                    {(item.productImages?.length ?? 0) > 0 && (
                      <div style={{ display: "flex", gap: 4, marginBottom: 8, flexWrap: "wrap" }}>
                        {item.productImages!.map((img) => (
                          <img
                            key={img.id}
                            src={imgSrc(img)}
                            alt={img.fileName}
                            onClick={() => setPreviewImage({ src: imgSrc(img), alt: img.fileName })}
                            style={{ width: 100, height: 100, objectFit: "cover", borderRadius: 4, border: "1px solid #e5e7eb", cursor: "pointer" }}
                          />
                        ))}
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", borderTop: "1px solid #f3f4f6", paddingTop: 8 }}>
                      {isPending && (
                        <>
                          <button type="button" onClick={() => setEditingPrealert(item)}
                            style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "4px 10px", fontSize: 12, background: "#fff", color: "#000000", cursor: "pointer" }}>编辑</button>
                          <button type="button" onClick={async () => {
                            if (!confirm("确定删除此预报单？")) return;
                            try { await deleteClientPrealert(item.id); setToast("预报单已删除"); await refreshMainData(); }
                            catch { setToast("删除失败"); }
                          }} style={{ border: "1px solid #fca5a5", borderRadius: 4, padding: "4px 10px", fontSize: 12, background: "#fff", color: "#dc2626", cursor: "pointer" }}>删除</button>
                        </>
                      )}
                      {isApproved && (
                        <button type="button" disabled={false} onClick={() => {
                          if (confirm("确认发货？预报单号：" + (item.orderNo || item.id))) void handleShip(item.id);
                        }} style={{ border: "none", borderRadius: 4, padding: "4px 14px", fontSize: 12, background: "#16a34a", color: "#fff", fontWeight: 500, cursor: "pointer" }}>确认发货</button>
                      )}
                      {(isApproved || isShipped) && item.trackingNo ? (
                        <button type="button" onClick={() => openPrintLabel({ marks: item.clientId ?? "", packageCount: item.packageCount ?? "—", trackingNo: item.trackingNo ?? "", itemName: item.itemName, productQuantity: item.productQuantity, transportMode: item.transportMode, products: item.products?.map(p => ({ itemName: p.itemName, packageCount: p.packageCount })) })} style={{ border: "1px solid #16a34a", borderRadius: 4, padding: "4px 10px", fontSize: 12, background: "#fff", color: "#16a34a", cursor: "pointer", marginLeft: 6 }}>打印</button>
                      ) : null}
                      {item.trackingNo ? (
                        <button type="button" onClick={() => openShipmentTrack(item.trackingNo!)} style={{ border: "1px solid #2563eb", borderRadius: 4, padding: "4px 10px", fontSize: 12, background: "#fff", color: "#2563eb", cursor: "pointer", marginLeft: 6 }}>物流轨迹</button>
                      ) : null}
                      <PrealertPrintButton item={item} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

      </section>

      {message ? <p style={{ marginTop: 12, color: message.includes("失败") ? "#b91c1c" : "#065f46" }}>{message}</p> : null}

      {/* 创建预报单弹窗 */}
      {showCreateModal && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)", padding: 16 }}>
          <div style={{ width: "100%", maxWidth: 1200, maxHeight: "90vh", overflow: "auto", background: "#fff", borderRadius: 12, padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
            <h3 style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 600 }}>创建预报单</h3>
            <div style={{ display: "grid", gap: 10 }}>
              <select value={form.warehouseId} onChange={(e) => setForm((v) => ({ ...v, warehouseId: e.target.value }))} style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", fontSize: 13 }}>
                <option value="">选择仓库</option>
                {warehouseOptions.map((w) => (<option key={w.id} value={w.id}>{w.label}</option>))}
              </select>
              {/* Multi-product section */}
              <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, background: "#f9fafb" }}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, color: "#000000" }}>产品列表</div>
                {formProducts.length === 0 ? (
                  <input value={form.itemName} onChange={(e) => setForm((v) => ({ ...v, itemName: e.target.value }))} placeholder="品名 *" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", fontSize: 13, width: "100%" }} />
                ) : null}
                {formProducts.map((p, i) => {
                  const pPkg = Number(p.packageCount) || 0;
                  const pL = Number(p.lengthCm) || 0;
                  const pW = Number(p.widthCm) || 0;
                  const pH = Number(p.heightCm) || 0;
                  const pWt = Number(p.weightKg) || 0;
                  const prodVol = (pL > 0 && pW > 0 && pH > 0) ? (pL * pW * pH * pPkg) / 1_000_000 : 0;
                  const prodWt = pWt * pPkg;
                  return (
                  <div key={i} style={{ display: "grid", gridTemplateColumns: "3fr 0.5fr 0.4fr 0.4fr 0.4fr 0.5fr 0.5fr 1fr 1fr 1fr auto", gap: 3, marginBottom: 4, alignItems: "center" }}>
                    <input value={p.itemName} onChange={(e) => setFormProducts((v) => { const n = [...v]; n[i] = { ...n[i], itemName: e.target.value }; return n; })} placeholder="品名" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
                    <input type="number" value={p.packageCount} onChange={(e) => setFormProducts((v) => { const n = [...v]; n[i] = { ...n[i], packageCount: e.target.value }; return n; })} placeholder="箱数" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
                    <input type="number" step="0.01" value={p.lengthCm} onChange={(e) => setFormProducts((v) => { const n = [...v]; n[i] = { ...n[i], lengthCm: e.target.value }; return n; })} placeholder="长cm" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
                    <input type="number" step="0.01" value={p.widthCm} onChange={(e) => setFormProducts((v) => { const n = [...v]; n[i] = { ...n[i], widthCm: e.target.value }; return n; })} placeholder="宽cm" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
                    <input type="number" step="0.01" value={p.heightCm} onChange={(e) => setFormProducts((v) => { const n = [...v]; n[i] = { ...n[i], heightCm: e.target.value }; return n; })} placeholder="高cm" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
                    <input type="number" value={p.productQuantity} onChange={(e) => setFormProducts((v) => { const n = [...v]; n[i] = { ...n[i], productQuantity: e.target.value }; return n; })} placeholder="单箱数量" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
                    <input type="number" step="0.01" value={p.weightKg} onChange={(e) => setFormProducts((v) => { const n = [...v]; n[i] = { ...n[i], weightKg: e.target.value }; return n; })} placeholder="单箱重量kg" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
                    <input value={p.domesticTrackingNo || ""} onChange={(e) => setFormProducts((v) => { const n = [...v]; n[i] = { ...n[i], domesticTrackingNo: e.target.value }; return n; })} placeholder="货拉拉" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
                    <span style={{ fontSize: 11, color: prodVol > 0 ? "#2563eb" : "#9ca3af", textAlign: "right", padding: "0 4px" }}>{prodVol > 0 ? prodVol.toFixed(4) + "m³" : "---"}</span>
                    <span style={{ fontSize: 11, color: prodWt > 0 ? "#2563eb" : "#9ca3af", textAlign: "right", padding: "0 4px" }}>{prodWt > 0 ? prodWt.toFixed(2) + "kg" : "---"}</span>
                    <button type="button" onClick={() => setFormProducts((v) => v.filter((_, j) => j !== i))} style={{ border: "1px solid #fca5a5", borderRadius: 4, padding: "4px 6px", fontSize: 11, background: "#fff", color: "#dc2626", cursor: "pointer" }}>✕</button>
                  </div>
                );})}
                {(() => {
                  const totalVol = formProducts.reduce((s, p) => {
                    const pkg = Number(p.packageCount) || 0;
                    const l = Number(p.lengthCm) || 0;
                    const w = Number(p.widthCm) || 0;
                    const h = Number(p.heightCm) || 0;
                    return s + ((l > 0 && w > 0 && h > 0) ? (l * w * h * pkg) / 1_000_000 : 0);
                  }, 0);
                  const totalWt = formProducts.reduce((s, p) => {
                    const pkg = Number(p.packageCount) || 0;
                    const wt = Number(p.weightKg) || 0;
                    return s + wt * pkg;
                  }, 0);
                  return (
                    <div style={{ fontSize: 12, fontWeight: 600, padding: "4px 0", color: "#2563eb", textAlign: "right" }}>
                      合计：总体积 {totalVol.toFixed(4)}m³  |  总重量 {totalWt.toFixed(2)}kg
                    </div>
                  );
                })()}
                <button type="button" onClick={() => setFormProducts((v) => [...v, { itemName: "", packageCount: "", lengthCm: "", widthCm: "", heightCm: "", productQuantity: "", weightKg: "", domesticTrackingNo: "" }])} style={{ border: "1px dashed #2563eb", borderRadius: 4, padding: "4px 10px", fontSize: 12, background: "#fff", color: "#2563eb", cursor: "pointer", marginTop: 4 }}>+ 添加产品</button>
              </div>
              <div style={{ fontSize: 12, color: "#000000", marginTop: 4 }}>
                💡 输入长宽高和箱/袋数后，体积自动计算（长×宽×高÷1,000,000×箱数）
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
                <input type="number" min={0} step="0.01" value={form.lengthCm} onChange={(e) => updateOrderDimensions({ lengthCm: e.target.value })} placeholder="长（cm）" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", fontSize: 13 }} />
                <input type="number" min={0} step="0.01" value={form.widthCm} onChange={(e) => updateOrderDimensions({ widthCm: e.target.value })} placeholder="宽（cm）" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", fontSize: 13 }} />
                <input type="number" min={0} step="0.01" value={form.heightCm} onChange={(e) => updateOrderDimensions({ heightCm: e.target.value })} placeholder="高（cm）" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", fontSize: 13 }} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
                <select value={form.packageUnit} onChange={(e) => setForm((v) => ({ ...v, packageUnit: e.target.value as "bag"  |  "box" }))} style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", fontSize: 13 }}>
                  <option value="box">箱</option>
                  <option value="bag">袋</option>
                </select>
                <input type="number" value={form.packageCount} onChange={(e) => updateOrderDimensions({ packageCount: e.target.value })} placeholder="箱/袋数" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", fontSize: 13 }} />
                <input type="number" step="0.001" value={form.volumeM3} readOnly={formProducts.length > 0} onChange={(e) => setForm((v) => ({ ...v, volumeM3: e.target.value }))} placeholder="总体积（m³）" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", fontSize: 13 }} />
                <input type="number" step="0.01" value={form.weightKg ?? ""} onChange={(e) => setForm((v) => ({ ...v, weightKg: e.target.value }))} placeholder="总重量(kg)" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", fontSize: 13 }} />
              </div>
              <input value={form.trackingNo ?? ""} onChange={(e) => setForm((v) => ({ ...v, trackingNo: e.target.value }))} placeholder="预报单号（留空自动生成）" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", fontSize: 13 }} />
              <input value={form.domesticTrackingNo} onChange={(e) => setForm((v) => ({ ...v, domesticTrackingNo: e.target.value }))} placeholder="国内快递单号" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", fontSize: 13 }} />
              <select value={form.transportMode} onChange={(e) => setForm((v) => ({ ...v, transportMode: e.target.value as "sea"  |  "land" }))} style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", fontSize: 13 }}>
                <option value="">运输方式 *</option>
                <option value="sea">海运</option>
                <option value="land">陆运</option>
              </select>
              


            </div>
            {/* 产品图片上传 */}
            <div style={{ marginTop: 10, border: "1px dashed #d1d5db", borderRadius: 8, padding: 10 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6, color: "#000000" }}>产品图片（可选，可多选）</div>
              <input type="file" multiple accept="image/*" onChange={(e) => {
                const files = Array.from(e.target.files || []);
                setPrealertImageFiles(files);
                setPrealertImagePreviews(files.map(f => URL.createObjectURL(f)));
              }} style={{ fontSize: 12 }} />
              {prealertImagePreviews.length > 0 && (
                <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                  {prealertImagePreviews.map((url, i) => (
                    <div key={i} style={{ position: "relative" }}>
                      <img src={url} style={{ width: 60, height: 60, objectFit: "cover", borderRadius: 4, border: "1px solid #e5e7eb" }} />
                      <button type="button" onClick={() => {
                        setPrealertImageFiles(f => f.filter((_, j) => j !== i));
                        setPrealertImagePreviews(p => p.filter((_, j) => j !== i));
                      }} style={{ position: "absolute", top: -6, right: -6, border: "1px solid #fca5a5", borderRadius: 10, width: 18, height: 18, fontSize: 10, background: "#fff", color: "#dc2626", cursor: "pointer", padding: 0, lineHeight: 1 }}>✕</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button type="button" onClick={() => { setShowCreateModal(false); setPrealertImageFiles([]); setPrealertImagePreviews([]); }} style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 16px", fontSize: 13, background: "#fff", cursor: "pointer", color: "#000000" }}>取消</button>
              <button type="button" onClick={async () => {
                const hasProducts = formProducts.length > 0 && formProducts.some((p) => p.itemName.trim());
                if (!hasProducts && !form.itemName) { setToast("请填写品名"); return; }
                if (!form.transportMode || !form.warehouseId) { setToast("请填写必填项"); return; }
                try {
                  const payload: any = { ...form, packageCount: +form.packageCount || 0, weightKg: form.weightKg ? +form.weightKg : undefined, volumeM3: form.volumeM3 ? +form.volumeM3 : undefined, transportMode: form.transportMode as "sea"  |  "land", trackingNo: form.trackingNo?.trim() || undefined };
                  if (hasProducts) {
                    payload.products = formProducts.filter((p) => p.itemName.trim()).map((p) => ({ itemName: p.itemName.trim(), packageCount: Number(p.packageCount) || 1, lengthCm: p.lengthCm ? Number(p.lengthCm) : undefined, widthCm: p.widthCm ? Number(p.widthCm) : undefined, heightCm: p.heightCm ? Number(p.heightCm) : undefined, productQuantity: p.productQuantity ? Number(p.productQuantity) : undefined, weightKg: p.weightKg ? Number(p.weightKg) : undefined, domesticTrackingNo: p.domesticTrackingNo?.trim() || "货拉拉", cargoType: "NORMAL" }));
                    payload.itemName = payload.products[0].itemName;
                  }
                  const result = await createClientPrealert(payload);
                  // Upload images
                  if (prealertImageFiles.length > 0) {
                    for (const file of prealertImageFiles) {
                      try {
                        const base64 = await new Promise<string>((resolve) => {
                          const reader = new FileReader();
                          reader.onload = () => resolve((reader.result as string).split(",")[1]);
                          reader.readAsDataURL(file);
                        });
                        await uploadStaffOrderProductImage({ orderId: result.prealertId, fileName: file.name, mime: file.type || "image/jpeg", contentBase64: base64 });
                      } catch { /* skip */ }
                    }
                  }
                  setToast("预报单创建成功");
                  setShowCreateModal(false);
                  setForm({ warehouseId: "", itemName: "", packageCount: "", packageUnit: "box" as "bag"  |  "box", lengthCm: "", widthCm: "", heightCm: "", weightKg: "", volumeM3: "", trackingNo: "", domesticTrackingNo: "", transportMode: "" as ""  |  "sea"  |  "land", receiverNameTh: "", receiverPhoneTh: "", receiverAddressTh: "" });
                  setFormProducts([]);
                  setPrealertImageFiles([]);
                  setPrealertImagePreviews([]);
                  await refreshMainData();
                } catch { setToast("创建失败"); }
              }} style={{ border: "none", borderRadius: 6, padding: "8px 16px", fontSize: 13, background: "#2563eb", color: "#fff", fontWeight: 500, cursor: "pointer" }}>
                提交
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 编辑预报单弹窗 */}
      {editingPrealert && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)", padding: 16 }}>
          <div style={{ width: "100%", maxWidth: 520, maxHeight: "90vh", overflow: "auto", background: "#fff", borderRadius: 12, padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
            <h3 style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 600 }}>编辑预报单</h3>
            {(editingPrealert.products?.length ?? 0) > 1 && (
              <div style={{ marginBottom: 10, background: "#f8fafc", borderRadius: 6, padding: "8px 10px", fontSize: 12 }}>
                <div style={{ fontWeight: 600, marginBottom: 4, color: "#000000" }}>产品列表</div>
                {editingPrealert.products!.map((p) => (
                  <div key={p.id} style={{ color: "#000000" }}>{p.itemName} ×{p.packageCount}箱</div>
                ))}
              </div>
            )}
            <div style={{ display: "grid", gap: 10 }}>
              <input value={editingPrealert.itemName} onChange={(e) => setEditingPrealert((v) => v ? { ...v, itemName: e.target.value } : v)} placeholder="品名" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", fontSize: 13 }} />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <input type="number" value={editingPrealert.packageCount} onChange={(e) => setEditingPrealert((v) => v ? { ...v, packageCount: +e.target.value } : v)} placeholder="箱数" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", fontSize: 13 }} />
                <select value={editingPrealert.packageUnit} onChange={(e) => setEditingPrealert((v) => v ? { ...v, packageUnit: e.target.value as "bag"  |  "box" } : v)} style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", fontSize: 13 }}>
                  <option value="box">箱</option>
                  <option value="bag">袋</option>
                </select>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <input type="number" step="0.01" value={editingPrealert.weightKg ?? ""} onChange={(e) => setEditingPrealert((v) => v ? { ...v, weightKg: e.target.value ? +e.target.value : undefined } : v)} placeholder="重量(kg)" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", fontSize: 13 }} />
                <input type="number" step="0.001" value={editingPrealert.volumeM3 ?? ""} onChange={(e) => setEditingPrealert((v) => v ? { ...v, volumeM3: e.target.value ? +e.target.value : undefined } : v)} placeholder="体积(m³)" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", fontSize: 13 }} />
              </div>
              <input value={editingPrealert.domesticTrackingNo ?? ""} onChange={(e) => setEditingPrealert((v) => v ? { ...v, domesticTrackingNo: e.target.value } : v)} placeholder="国内快递单号" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", fontSize: 13 }} />
              <select value={editingPrealert.transportMode} onChange={(e) => setEditingPrealert((v) => v ? { ...v, transportMode: e.target.value } : v)} style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", fontSize: 13 }}>
                <option value="sea">海运</option>
                <option value="land">陆运</option>
              </select>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button type="button" onClick={() => setEditingPrealert(null)} style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 16px", fontSize: 13, background: "#fff", cursor: "pointer", color: "#000000" }}>取消</button>
              <button type="button" onClick={async () => {
                try {
                  await updateClientPrealert(editingPrealert.id, {
                    itemName: editingPrealert.itemName,
                    packageCount: editingPrealert.packageCount,
                    packageUnit: editingPrealert.packageUnit,
                    weightKg: editingPrealert.weightKg,
                    volumeM3: editingPrealert.volumeM3,
                    domesticTrackingNo: editingPrealert.domesticTrackingNo,
                    transportMode: editingPrealert.transportMode,
                  });
                  setToast("预报单已更新");
                  setEditingPrealert(null);
                  await refreshMainData();
                } catch { setToast("更新失败"); }
              }} style={{ border: "none", borderRadius: 6, padding: "8px 16px", fontSize: 13, background: "#2563eb", color: "#fff", fontWeight: 500, cursor: "pointer" }}>保存</button>
            </div>
          </div>
        </div>
      )}
      <Toast open={toast.length > 0} message={toast} />
      {previewImage && (
        <div
          onClick={() => setPreviewImage(null)}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 9999,
            display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
          }}
        >
          <img
            src={previewImage.src}
            alt={previewImage.alt}
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: "90vw", maxHeight: "90vh", objectFit: "contain", borderRadius: 8, boxShadow: "0 8px 32px rgba(0,0,0,0.4)" }}
          />
        </div>
      )}
    </RoleShell>
  );
}
