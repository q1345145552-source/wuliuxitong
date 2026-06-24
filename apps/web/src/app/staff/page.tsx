"use client";

import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { calcOrderAmountCny, formatCny } from "../../modules/billing/billing-utils";
import ShipmentSearch from "../../modules/shipment/ShipmentSearch";
import PrealertSearch from "../../modules/shipment/PrealertSearch";
import { openPrintLabel } from "../../modules/shipment/ShipmentPrintLabel";
import { openShipmentTrack } from "../../modules/shipment/ShipmentTrackModal";
import { splitStaffShipment } from "../../services/business-api";
import EmptyStateCard from "../../modules/layout/EmptyStateCard";
import RoleShell from "../../modules/layout/RoleShell";
import Toast from "../../modules/layout/Toast";
import { apiBaseUrl, authHeaders } from "../../services/core-api";
import {
  receiveStaffPrealert,
  createStaffOrder,
  deleteStaffOrderProductImage,
  fetchStaffClients,
  fetchStaffInboundPhotos,
  fetchStaffPrealerts,
  fetchStaffShipments,
  fetchShipmentImages,
  fetchClientNotes,
  patchStaffShipmentOrderBundle,
  repairStaffShipmentOrderLinks,
  type RepairStaffShipmentOrderLinksResult,
  setStaffOrderPayment,
  setStaffShipmentContainer,
  type OrderItem,
  type OrderProductImageItem,
  type StaffInboundPhotoItem,
  type ShipmentItem,
  uploadStaffInboundPhoto,
  uploadStaffOrderProductImage,
} from "../../services/business-api";

const MAX_ORDER_PRODUCT_IMAGES = 999;

type OrderProductImagesPanelProps = {
  orderId: string;
  images: OrderProductImageItem[];
  canManage: boolean;
  busy: boolean;
  onSelectFile: (file: File) => void | Promise<void>;
  onDelete: (imageId: string) => void | Promise<void>;
};

/**
 * 订单详情产品图：展示、上传与删除（最多 5 张）。
 */
function OrderProductImagesPanel(props: OrderProductImagesPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imgs = props.images ?? [];
  const canAdd = props.canManage && imgs.length < MAX_ORDER_PRODUCT_IMAGES;
  return (
    <div style={{ marginTop: 8, marginBottom: 8, padding: 10, background: "#f8fafc", borderRadius: 8, border: "1px solid #e2e8f0" }}>
      <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13, color: "#000000" }}>
        订单详情 · 产品图（最多 {MAX_ORDER_PRODUCT_IMAGES} 张）
      </div>
      {imgs.length === 0 && !canAdd ? (
        <div style={{ fontSize: 12, color: "#000000" }}>暂无产品图</div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-start" }}>
          {imgs.map((img) => (
            <div key={img.id}>
              <img
                src={img.imageUrl ? `${apiBaseUrl()}${img.imageUrl}` : `data:${img.mime};base64,${img.contentBase64}`}
                alt={img.fileName}
                style={{ width: 88, height: 88, objectFit: "cover", borderRadius: 8, border: "1px solid #e5e7eb", display: "block" }}
              />
              {props.canManage ? (
                <button
                  type="button"
                  disabled={props.busy}
                  onClick={() => void props.onDelete(img.id)}
                  style={{
                    marginTop: 4,
                    width: "100%",
                    border: "1px solid #fecaca",
                    borderRadius: 6,
                    padding: "2px 4px",
                    fontSize: 11,
                    background: "#fff",
                    color: "#b91c1c",
                    cursor: props.busy ? "not-allowed" : "pointer",
                  }}
                >
                  删除
                </button>
              ) : null}
            </div>
          ))}
          {canAdd ? (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                disabled={props.busy}
                style={{ position: "absolute", width: 0, height: 0, opacity: 0, pointerEvents: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void props.onSelectFile(f);
                }}
              />
              <button
                type="button"
                disabled={props.busy}
                onClick={() => fileInputRef.current?.click()}
                style={{
                  width: 88,
                  height: 88,
                  border: "1px dashed #000000",
                  borderRadius: 8,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 12,
                  color: "#000000",
                  cursor: props.busy ? "not-allowed" : "pointer",
                  background: "#fff",
                }}
              >
                {props.busy ? "…" : "+ 上传"}
              </button>
            </>
          ) : null}
        </div>
      )}
      {!props.canManage ? <div style={{ fontSize: 12, color: "#000000", marginTop: 6 }}>仅展示；无本仓库操作权限时不可修改（与上传接口校验的订单仓库一致）。</div> : null}
    </div>
  );
}

/**
 * 运单系统状态转中文（列表展示）。
 */
function shipmentStatusZh(status: string | undefined): string {
  if (!status) return "—";
  const value = status.toLowerCase();
  const map: Record<string, string> = {
    created: "已创建",
    pickedup: "已揽收",
    inwarehousecn: "国内仓已收货",
    receivedcn: "国内仓已收货",
    customspending: "报关中",
    loaded: "已装柜",
    delaydeparted: "延迟开船",
    departed: "已开船",
    arrivedport: "已到港",
    intransit: "运输中",
    customsth: "清关中",
    customscleared: "清关已放行",
    inwarehouseth: "已到仓",
    warehouseth: "已到仓",
    outfordelivery: "派送中",
    delivered: "派送完成",
    exception: "异常",
    returned: "已退回",
    cancelled: "已取消",
  };
  return map[value] ?? (value || "未知");
}

/**
 * 仓库 ID 转中文仓名。
 */
function warehouseLabelFromId(warehouseId: string | undefined): string {
  if (!warehouseId) return "—";
  const map: Record<string, string> = {
    wh_yiwu_01: "义乌仓",
    wh_guangzhou_01: "广州仓",
    wh_dongguan_01: "东莞仓",
  wh_shenzhen_01: "深圳仓",
  };
  return map[warehouseId] ?? warehouseId;
}

/**
 * 运输方式展示。
 */
function transportModeLabel(mode: string | undefined): string {
  if (mode === "sea") return "海运";
  if (mode === "land") return "陆运";
  return mode ?? "—";
}

/**
 * 截断过长文本。
 */
function truncateText(s: string | undefined, max: number): string {
  if (!s?.trim()) return "—";
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/**
 * 数字列格式化。
 */
function formatMetric(n: number | undefined | null, digits = 3): string {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return Number(n).toFixed(digits);
}

const STAFF_SECTION_IDS = [
  "staff-billing",
  "staff-prealert-review",
  "staff-create-order",
  "staff-ops-tools",
  "staff-order-shipment",
  "staff-lastmile",
  "staff-address",
] as const;

/**
 * 根据长宽高（厘米）计算体积（立方米）：长×宽×高÷1,000,000。
 */
function volumeM3FromDimensionsCm(lengthCm: number, widthCm: number, heightCm: number): number {
  return (lengthCm * widthCm * heightCm) / 1_000_000;
}

/**
 * 将体积（立方米）格式化为字符串，便于提交表单。
 */
function formatDateTime(iso: string | null | undefined, fallback = "—"): string {
  if (!iso) return fallback;
  return iso.slice(0, 16).replace("T", " ");
}

function formatVolumeM3String(m3: number): string {
  if (!Number.isFinite(m3) || m3 <= 0) return "";
  return String(Number(m3.toFixed(6)));
}

function shipmentShipDateToLocalInput(shipDate: string | undefined): string {
  if (!shipDate?.trim()) return "";
  const s = shipDate.trim();
  const datePart = s.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return "";
  if (s.length >= 16 && (s.includes("T") || s.includes(" "))) {
    const sep = s.includes("T") ? "T" : " ";
    const rest = sep === "T" ? s.slice(11) : s.slice(11);
    const hm = rest.slice(0, 5);
    if (/^\d{2}:\d{2}$/.test(hm)) return `${datePart}T${hm}`;
  }
  return `${datePart}T12:00`;
}

/** 与后端 update-status 主流程一致。 */
const SHIPMENT_STATUS_FLOW = [
  "created",
  "pickedUp",
  "inWarehouseCN",
  "customsPending",
  "inTransit",
  "customsTH",
  "outForDelivery",
  "delivered",
] as const;

const SHIPMENT_EXCEPTION_STATUSES = new Set(["exception", "returned", "cancelled"]);

/**
 * 计算运单状态下拉可选目标（与后端 canTransit 规则一致）。
 */
function getValidShipmentStatusTargets(fromStatus: string): string[] {
  const from = fromStatus?.trim() || "created";
  const out = new Set<string>();
  out.add(from);
  if (SHIPMENT_EXCEPTION_STATUSES.has(from)) {
    SHIPMENT_EXCEPTION_STATUSES.forEach((s) => out.add(s));
    return Array.from(out);
  }
  const fromIdx = SHIPMENT_STATUS_FLOW.indexOf(from as (typeof SHIPMENT_STATUS_FLOW)[number]);
  if (fromIdx >= 0 && fromIdx + 1 < SHIPMENT_STATUS_FLOW.length) {
    out.add(SHIPMENT_STATUS_FLOW[fromIdx + 1]!);
  }
  SHIPMENT_EXCEPTION_STATUSES.forEach((s) => out.add(s));
  return Array.from(out);
}

type ShipmentEditFormFieldProps = {
  label: string;
  required?: boolean;
  children: ReactNode;
};

/**
 * 运单编辑展开区单字段：白底卡片、标签与必填星号。
 */
function ShipmentEditFormField(props: ShipmentEditFormFieldProps) {
  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 12px", background: "#ffffff" }}>
      <div style={{ fontSize: 12, color: "#000000", marginBottom: 6 }}>
        {props.label}
        {props.required ? <span style={{ color: "#dc2626", marginLeft: 2 }}>*</span> : null}
      </div>
      {props.children}
    </div>
  );
}

/**
 * 将「修复关联」接口结果转为用户可见的提示文案。
 */
function formatRepairShipmentOrderLinkToast(result: RepairStaffShipmentOrderLinksResult): string {
  if (result.repairedCount > 0) {
    return result.repairedCount === 1
      ? "已补建订单并关联该运单，可保存订单信息"
      : `已补建订单并关联 ${result.repairedCount} 条运单`;
  }
  const first = result.skipped[0];
  if (!first) return "当前没有需要修复的运单";
  if (first.reason === "already_linked") return "该运单已有关联订单";
  if (first.reason === "shipment_not_found") return "未找到运单或无权访问";
  if (first.reason === "no_company_user") return "公司下无可用用户，无法补建订单";
  if (first.reason.startsWith("insert_failed:")) return `补建订单失败：${first.reason.slice("insert_failed:".length)}`;
  return `未能修复：${first.reason}`;
}

type ShipmentOrderEditDraft = {
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
};

/**
 * 由运单行构造订单详情编辑草稿。
 */
function buildShipmentOrderEditDraft(item: ShipmentItem): ShipmentOrderEditDraft {
  return {
    trackingNo: item.trackingNo ?? "",
    warehouseId: item.warehouseId ?? "wh_yiwu_01",
    batchNo: item.batchNo ?? "",
    itemName: item.itemName ?? "",
    domesticTrackingNo: item.domesticTrackingNo ?? "",
    productQuantity: item.productQuantity != null ? String(item.productQuantity) : "",
    packageCount: item.packageCount != null ? String(item.packageCount) : "",
    packageUnit: item.packageUnit === "bag" ? "bag" : "box",
    weightKg: item.weightKg != null ? String(item.weightKg) : "",
    volumeM3: item.volumeM3 != null ? String(item.volumeM3) : "",
    orderCreatedDate: item.arrivedAt ? item.arrivedAt.slice(0, 10) : "",
    transportMode: item.transportMode === "land" ? "land" : "sea",
    shipLocal: shipmentShipDateToLocalInput(item.shipDate),
    receiverAddressTh: item.receiverAddressTh ?? "",
    containerNo: item.containerNo ?? "",
    receivableAmountCny: item.receivableAmountCny != null ? String(item.receivableAmountCny) : "",
    receivableCurrency: item.receivableCurrency === "THB" ? "THB" : "CNY",
    paymentStatus: item.paymentStatus === "paid" ? "paid" : "unpaid",
    destinationCountry: "泰国",
    customsDeclaration: "none",
  };
}

export default function StaffHomePage() {
  type PrealertEditDraft = {
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
  const [staffClients, setStaffClients] = useState<Array<{ id: string; name: string }>>([]);
  const warehouseOptions = [
    { id: "wh_yiwu_01", label: "义乌仓" },
    { id: "wh_guangzhou_01", label: "广州仓" },
    { id: "wh_dongguan_01", label: "东莞仓" },
  { id: "wh_shenzhen_01", label: "深圳仓" },
  ];
  const logisticsStatusOptions = ["已装柜", "延迟开船", "已开船", "已到港", "清关中", "清关已放行", "已到仓", "派送中", "派送完成"] as const;
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [toast, setToast] = useState("");
  const [prealertSearch, setPrealertSearch] = useState({
    keyword: "",
    warehouseId: "",
    itemName: "",
    domesticTrackingNo: "",
  });
  const [prealertPanelCollapsed, setPrealertPanelCollapsed] = useState(false);
  const [shipmentListCollapsed, setShipmentListCollapsed] = useState(false);
  const [shipmentTableExpandedId, setShipmentTableExpandedId] = useState<string | null>(null);
  const [shipmentImagesCache, setShipmentImagesCache] = useState<Record<string, OrderProductImageItem[]>>({});
  const [shipmentOrderEditDrafts, setShipmentOrderEditDrafts] = useState<Record<string, ShipmentOrderEditDraft>>({});
  const [clientSearchKeyword, setClientSearchKeyword] = useState("");
  const [shipments, setShipments] = useState<ShipmentItem[]>([]);
  const [prealerts, setPrealerts] = useState<OrderItem[]>([]);
  const [prealertBatchDrafts, setPrealertBatchDrafts] = useState<Record<string, string>>({});
  const [prealertEditDrafts, setPrealertEditDrafts] = useState<Record<string, PrealertEditDraft>>({});
  const [prealertConfirmedDrafts, setPrealertConfirmedDrafts] = useState<Record<string, PrealertEditDraft>>({});
  const [editingPrealertId, setEditingPrealertId] = useState<string | null>(null);
  const [createStepDone, setCreateStepDone] = useState(false);
  const [shipmentSearch, setShipmentSearch] = useState({
    batchNo: "",
    clientName: "",
    itemName: "",
    trackingNo: "",
    domesticTrackingNo: "",
    packageCount: "",
    productQuantity: "",
    weightKg: "",
    volumeM3: "",
    arrivedAtFrom: "",
    arrivedAtTo: "",
    warehouseId: "",
    logisticsStatus: "",
    containerNo: "",
    transportMode: "",
    receiverAddress: "",
    shipDateFrom: "",
    shipDateTo: "",
    receivableAmount: "",
    statusRaw: "",
  });
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showBatchImport, setShowBatchImport] = useState(false);
  const [batchRows, setBatchRows] = useState<Array<{clientId: string; trackingNo?: string; warehouseId: string; itemName: string; packageCount: number; packageUnit: "bag" | "box"; weightKg?: number; volumeM3?: number; arrivedAt: string; transportMode: "sea" | "land"; domesticTrackingNo?: string; batchNo?: string; productQuantity?: number; receiverNameTh?: string; receiverPhoneTh?: string; receiverAddressTh?: string}>>([]);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ current: 0, success: 0, fail: 0 });
  const [batchErrors, setBatchErrors] = useState<string[]>([]);
  const [batchFileName, setBatchFileName] = useState("");
  const [batchConfirmed, setBatchConfirmed] = useState(false);
  const [shipmentSearchCollapsed, setShipmentSearchCollapsed] = useState(true);
  const [selectedForExport, setSelectedForExport] = useState<Set<string>>(new Set());
  const [pageSize, setPageSize] = useState(100);
  const [staffFormProducts, setStaffFormProducts] = useState<Array<{
    itemName: string; packageCount: string; lengthCm: string; widthCm: string; heightCm: string; productQuantity: string; weightKg: string; cargoType: string; domesticTrackingNo: string;
  }>>([]);
  const [orderImageFiles, setOrderImageFiles] = useState<File[]>([]);
  const [orderImagePreviews, setOrderImagePreviews] = useState<string[]>([]);
  const [approvingPrealert, setApprovingPrealert] = useState<OrderItem | null>(null);
  const [splittingShipment, setSplittingShipment] = useState<ShipmentItem | null>(null);
  const [splitRows, setSplitRows] = useState<Array<{ trackingNo: string; batchNo: string; itemName: string; packageCount: string }>>([]);

  const [lastmileKeyword, setLastmileKeyword] = useState("");
  const [lastmileItems, setLastmileItems] = useState<Array<{
    id: string;
    name: string;
    phone: string;
    addresses: Array<{
      id: string;
      contactName: string;
      contactPhone: string;
      addressDetail: string;
      isDefault: boolean;
    }>;
  }>>([]);
  const [lastmileLoading, setLastmileLoading] = useState(false);
  const [clientNotes, setClientNotes] = useState<Record<string, { content: string; updatedAt: string }>>({});
  const [editingNote, setEditingNote] = useState<{ clientId: string; content: string } | null>(null);
  const [showAddAddress, setShowAddAddress] = useState<string | null>(null);
  const [addrForm, setAddrForm] = useState({ contactName: "", contactPhone: "", addressDetail: "", label: "" });

  const saveNote = async (clientId: string, content: string) => {
    try {
      await fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001"}/admin/shipping/notes`, {
        method: "POST",
        headers: { ...(await import("../../services/core-api")).authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, content }),
      });
      setToast("备注已保存");
      setEditingNote(null);
      await loadClientNotesData();
    } catch { setToast("保存失败"); }
  };

  const saveAddr = async (clientId: string) => {
    if (!addrForm.contactName.trim() || !addrForm.contactPhone.trim() || !addrForm.addressDetail.trim()) {
      setToast("请填写完整地址信息"); return;
    }
    try {
      await fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001"}/staff/client-addresses`, {
        method: "POST",
        headers: { ...(await import("../../services/core-api")).authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, ...addrForm }),
      });
      setToast("地址已添加");
      setShowAddAddress(null);
      setAddrForm({ contactName: "", contactPhone: "", addressDetail: "", label: "" });
      void loadLastmileAddresses(lastmileKeyword);
    } catch { setToast("保存失败"); }
  };

  const loadClientNotesData = async () => {
    try { setClientNotes(await fetchClientNotes()); } catch { }
  };

  const deleteAddr = async (addrId: string) => {
    try {
      const resp = await fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001"}/staff/lastmile/addresses?id=${encodeURIComponent(addrId)}`, {
        method: "DELETE",
        headers: { ...(await import("../../services/core-api")).authHeaders() },
      });
      const json = await resp.json();
      if (json.code === "OK") { setToast("地址已删除"); void loadLastmileAddresses(lastmileKeyword); }
      else setMessage("删除失败：" + (json.message ?? "未知错误"));
    } catch (e: any) { setMessage("删除失败：" + (e.message ?? "网络错误")); }
  };

  const loadLastmileAddresses = async (keyword: string) => {
    setLastmileLoading(true);
    try {
      const resp = await fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001"}/staff/lastmile/addresses?keyword=${encodeURIComponent(keyword)}`, {
        headers: { ...(await import("../../services/core-api")).authHeaders() },
      });
      const json = await resp.json();
      if (json.code === "OK") setLastmileItems(json.data.items);
      else setMessage("查询失败：" + (json.message ?? "未知错误"));
    } catch (e: any) {
      setMessage("查询失败：" + (e.message ?? "网络错误"));
    } finally { setLastmileLoading(false); }
  };

  const [form, setForm] = useState({
    clientId: "u_client_001",
    warehouseId: "wh_yiwu_01",
    batchNo: "",
    arrivedAt: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" }),
    itemName: "",
    trackingNo: "",
    productQuantity: "",
    packageCount: "",
    lengthCm: "",
    widthCm: "",
    heightCm: "",
    volumeM3: "",
    weightKg: "",
    domesticOrderNo: "",
    packageUnit: "box" as "bag" | "box",
    transportMode: "sea" as "sea" | "land",
    cargoType: "NORMAL",
  });

  /**
   * 更新长宽高并同步写入由尺寸换算得到的体积（m³）。
   */
  const updateOrderDimensions = (patch: Partial<Pick<typeof form, "lengthCm" | "widthCm" | "heightCm" | "packageCount">>) => {
    setForm((prev) => {
      const next = { ...prev, ...patch };
      const l = Number(String(next.lengthCm).trim());
      const w = Number(String(next.widthCm).trim());
      const h = Number(String(next.heightCm).trim());
      const pkg = Number(String(next.packageCount).trim());
      if (Number.isFinite(l) && Number.isFinite(w) && Number.isFinite(h) && l > 0 && w > 0 && h > 0) {
        const singleVolume = volumeM3FromDimensionsCm(l, w, h);
        next.volumeM3 = formatVolumeM3String(Number.isFinite(pkg) && pkg > 0 ? singleVolume * pkg : singleVolume);
      } else {
        next.volumeM3 = "";
      }
      return next;
    });
  };
  const [sizeDraft, setSizeDraft] = useState({
    lengthCm: "",
    widthCm: "",
    heightCm: "",
    actualWeightKg: "",
  });
  const [labelDraft, setLabelDraft] = useState({
    orderOrShipmentId: "",
    labelType: "fba" as "fba" | "waybill" | "internal-box",
  });
  const [containerDraft, setContainerDraft] = useState({
    shipmentId: "",
    containerNo: "",
  });
  const [photoDraft, setPhotoDraft] = useState({
    shipmentId: "",
    note: "",
    fileName: "",
    mime: "",
    contentBase64: "",
  });
  const [photoList, setPhotoList] = useState<StaffInboundPhotoItem[]>([]);
  const [activeSection, setActiveSection] = useState<(typeof STAFF_SECTION_IDS)[number]>("staff-billing");

  const [lmDriverName, setLmDriverName] = useState("");
  const [lmLicensePlate, setLmLicensePlate] = useState("");
  const [lmPhoneNumber, setLmPhoneNumber] = useState("");
  const [lmShipments, setLmShipments] = useState<Array<{id:string;trackingNo:string;clientId:string;itemName:string;packageCount:number}>>([]);
  const [lmSelected, setLmSelected] = useState<Set<string>>(new Set());
  const [lmShipSearch, setLmShipSearch] = useState("");
  const loadLmShipments = async () => {
    try { const r = await fetch(apiBaseUrl()+"/staff/shipments?limit=500",{headers:authHeaders()}); const d=await r.json();
      if(d.code==="OK") setLmShipments(d.data.items.filter((s:any)=>["inWarehouseTH","outForDelivery","delivered"].includes(s.currentStatus)).map((s:any)=>({id:s.id,trackingNo:s.trackingNo,clientId:s.clientId??"",itemName:s.itemName??"",packageCount:s.packageCount??0}))); } catch {}
  };
  const [lmOrderList, setLmOrderList] = useState<Array<{id:string;deliveryNo:string;shipmentId:string;trackingNo?:string;driverName?:string;licensePlate?:string;phoneNumber?:string;status:string}>>([]);
  const loadLmOrders = async () => { try { const r=await fetch(apiBaseUrl()+"/admin/lastmile/orders",{headers:authHeaders()}); const d=await r.json(); if(d.code==="OK")setLmOrderList(d.data.items); } catch {} };

  useEffect(() => {
    if (activeSection === "staff-lastmile") {
      loadLmOrders();
      if (lastmileItems.length === 0) {
        void loadLastmileAddresses("");
        void loadClientNotesData();
      }
    }
  }, [activeSection]);

  // 判断 hash 是否属于员工端可展示的功能分区。
  const isStaffSectionId = (value: string): value is (typeof STAFF_SECTION_IDS)[number] =>
    STAFF_SECTION_IDS.includes(value as (typeof STAFF_SECTION_IDS)[number]);
  const buildPrealertDraft = (item: OrderItem): PrealertEditDraft => ({
    warehouseId: item.warehouseId ?? "",
    itemName: item.itemName,
    packageCount: item.packageCount,
    packageUnit: item.packageUnit === "bag" ? "bag" : "box",
    productQuantity: item.productQuantity,
    weightKg: item.weightKg ?? 0,
    volumeM3: item.volumeM3 ?? 0,
    receivableAmountCny:
      typeof item.receivableAmountCny === "number"
        ? item.receivableAmountCny
        : calcOrderAmountCny(item) ?? 0,
    receivableCurrency: item.receivableCurrency === "THB" ? "THB" : "CNY",
    domesticTrackingNo: item.domesticTrackingNo ?? "",
    transportMode: item.transportMode === "sea" ? "sea" : "land",
    shipDate: item.shipDate ?? item.createdAt.slice(0, 10),
  });

  const isSamePrealertDraft = (a: PrealertEditDraft, b: PrealertEditDraft): boolean =>
    a.warehouseId === b.warehouseId &&
    a.itemName === b.itemName &&
    a.packageCount === b.packageCount &&
    a.packageUnit === b.packageUnit &&
    a.productQuantity === b.productQuantity &&
    a.weightKg === b.weightKg &&
    a.volumeM3 === b.volumeM3 &&
    a.receivableAmountCny === b.receivableAmountCny &&
    a.receivableCurrency === b.receivableCurrency &&
    a.domesticTrackingNo === b.domesticTrackingNo &&
    a.transportMode === b.transportMode &&
    a.shipDate === b.shipDate;

  const validatePrealertDraft = (draft: PrealertEditDraft): string | null => {
    if (!draft.warehouseId) {
      return "仓库未选择，请选择义乌/广州/东莞。";
    }
    if (!draft.itemName.trim()) {
      return "品名不能为空。";
    }
    if (!Number.isFinite(draft.packageCount) || draft.packageCount <= 0) {
      return "箱数/袋数必须大于 0。";
    }
    if (draft.packageUnit !== "box" && draft.packageUnit !== "bag") {
      return "箱数/袋数单位无效，请选择箱或袋。";
    }
    if (!Number.isFinite(draft.productQuantity) || draft.productQuantity <= 0) {
      return "产品数量必须大于 0。";
    }
    if (!Number.isFinite(draft.weightKg) || draft.weightKg <= 0) {
      return "重量必须大于 0。";
    }
    if (!Number.isFinite(draft.volumeM3) || draft.volumeM3 <= 0) {
      return "体积必须大于 0。";
    }
    if (draft.transportMode !== "sea" && draft.transportMode !== "land") {
      return "运输方式无效，请选择海运或陆运。";
    }
    return null;
  };

  const toLogisticsStatus = (status?: string): string => {
    if (!status) return "";
    return shipmentStatusZh(status);
  };

  /**
   * 将文件读取为 base64，供入库拍照上传接口使用。
   */
  const readFileAsBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === "string" ? reader.result : "";
        resolve(result.includes(",") ? result.split(",").pop() ?? "" : "");
      };
      reader.onerror = () => reject(new Error("文件读取失败"));
      reader.readAsDataURL(file);
    });

  /**
   * 选择或清除状态更新附图（仅接受图片）。
   */
  /**
   * 重置状态更新表单中的附图（取消编辑或清空搜索时调用）。
   */
  /**
   * 状态更新成功后，将当前附图写入各运单的入库拍照记录。
   */
  const loadPageData = async (): Promise<ShipmentItem[]> => {
    const [shipmentItems, prealertItems, clientItems] = await Promise.all([fetchStaffShipments(), fetchStaffPrealerts(), fetchStaffClients()]);
    // 按运单号数字降序
    shipmentItems.sort((a, b) => {
      const an = (a.trackingNo ?? "").replace(/\D/g, "");
      const bn = (b.trackingNo ?? "").replace(/\D/g, "");
      return (Number(bn) || 0) - (Number(an) || 0);
    });
    setStaffClients(clientItems);
    setShipments(shipmentItems.filter(s => !s.parentTrackingNo));
    setPrealerts(prealertItems);
    setPrealertBatchDrafts((prev) => {
      const next: Record<string, string> = { ...prev };
      prealertItems.forEach((item) => {
        if (!(item.id in next)) {
          next[item.id] = item.batchNo ?? "";
        }
      });
      return next;
    });
    setPrealertEditDrafts((prev) => {
      const next: Record<string, PrealertEditDraft> = { ...prev };
      prealertItems.forEach((item) => {
        if (!(item.id in next)) {
          next[item.id] = buildPrealertDraft(item);
        }
      });
      return next;
    });
    setPrealertConfirmedDrafts((prev) => {
      const next: Record<string, PrealertEditDraft> = { ...prev };
      prealertItems.forEach((item) => {
        if (!(item.id in next)) {
          next[item.id] = buildPrealertDraft(item);
        }
      });
      return next;
    });
    return shipmentItems;
  };

  /**
   * 上传订单产品图后刷新员工端数据。
   */
  const uploadOrderProductImageAndReload = async (orderId: string, file: File) => {
    if (!orderId) { setToast("上传失败：缺少订单ID"); return; }
    setLoading(true);
    setMessage("");
    try {
      const contentBase64 = await readFileAsBase64(file);
      await uploadStaffOrderProductImage({
        orderId,
        fileName: file.name,
        mime: file.type || "image/jpeg",
        contentBase64,
      });
      await loadPageData();
      // 刷新该订单的图片缓存
      fetchShipmentImages(orderId).then((imgs) => {
        setShipmentImagesCache((c) => ({ ...c, [orderId]: imgs }));
      }).catch(() => {});
      setToast("产品图已上传");
    } catch (error) {
      const text = error instanceof Error ? error.message : "上传失败";
      setMessage(`上传失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  /**
   * 删除订单产品图后刷新员工端数据。
   */
  const deleteOrderProductImageAndReload = async (imageId: string) => {
    setLoading(true);
    setMessage("");
    try {
      await deleteStaffOrderProductImage(imageId);
      await loadPageData();
      // 清除该订单图片缓存（下次展开时重新加载）
      const oid = shipmentTableExpandedId ? shipments.find((s) => s.id === shipmentTableExpandedId)?.orderId : undefined;
      if (oid) {
        fetchShipmentImages(oid).then((imgs) => {
          setShipmentImagesCache((c) => ({ ...c, [oid]: imgs }));
        }).catch(() => {});
      }
      setToast("产品图已删除");
    } catch (error) {
      const text = error instanceof Error ? error.message : "删除失败";
      setMessage(`删除失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  /**
   * 保存运单列表展开区中编辑的订单与运单基础信息。
   */
  const saveShipmentOrderEdit = async (shipmentId: string) => {
    const draft = shipmentOrderEditDrafts[shipmentId];
    if (!draft) {
      setMessage("未找到编辑草稿，请收起后重新展开。");
      return;
    }
    if (!draft.trackingNo.trim()) {
      setMessage("运单号不能为空。");
      return;
    }
    if (!draft.itemName.trim()) {
      setMessage("品名不能为空。");
      return;
    }
    if (!draft.orderCreatedDate.trim()) {
      setMessage("请选择到仓日期。");
      return;
    }
    const productQuantity = Number(draft.productQuantity);
    const packageCount = Number(draft.packageCount);
    if (!Number.isFinite(productQuantity) || productQuantity < 0) {
      setMessage("产品数量请输入有效数字。");
      return;
    }
    if (!Number.isFinite(packageCount) || packageCount < 0) {
      setMessage("包裹数量请输入有效数字。");
      return;
    }
    const weightKg = draft.weightKg.trim() === "" ? null : Number(draft.weightKg);
    const volumeM3 = draft.volumeM3.trim() === "" ? null : Number(draft.volumeM3);
    if (weightKg !== null && !Number.isFinite(weightKg)) {
      setMessage("重量请输入有效数字。");
      return;
    }
    if (volumeM3 !== null && !Number.isFinite(volumeM3)) {
      setMessage("体积请输入有效数字。");
      return;
    }
    const recv = draft.receivableAmountCny.trim() === "" ? 0 : Number(draft.receivableAmountCny);
    if (!Number.isFinite(recv) || recv < 0) {
      setMessage("加收金额请输入有效数字。");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      await patchStaffShipmentOrderBundle({
        shipmentId,
        trackingNo: draft.trackingNo.trim(),
        batchNo: draft.batchNo.trim() || null,
        itemName: draft.itemName.trim(),
        productQuantity,
        packageCount,
        packageUnit: draft.packageUnit,
        weightKg,
        volumeM3,
        domesticTrackingNo: draft.domesticTrackingNo.trim() || null,
        orderCreatedDate: draft.orderCreatedDate,
        transportMode: draft.transportMode,
        shipDate: draft.shipLocal.trim() ? draft.shipLocal.trim().slice(0, 10) : null,
        receiverAddressTh: draft.receiverAddressTh,
        containerNo: draft.containerNo.trim() || null,
        receivableAmountCny: recv,
        receivableCurrency: draft.receivableCurrency,
        warehouseId: draft.warehouseId.trim(),
      });
      const shipmentItems = await loadPageData();
      const updated = shipmentItems.find((s) => s.id === shipmentId);
      if (updated) {
        setShipmentOrderEditDrafts((prev) => ({ ...prev, [shipmentId]: buildShipmentOrderEditDraft(updated) }));
      }
      setToast("订单信息已保存");
    } catch (error) {
      const text = error instanceof Error ? error.message : "保存失败";
      setMessage(`保存失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  /**
   * 合并当前运单订单详情草稿（运单列表展开区表单）。
   */
  const mergeShipmentOrderDraft = (shipmentId: string, item: ShipmentItem, partial: Partial<ShipmentOrderEditDraft>) => {
    setShipmentOrderEditDrafts((prev) => {
      const cur = prev[shipmentId] ?? buildShipmentOrderEditDraft(item);
      return { ...prev, [shipmentId]: { ...cur, ...partial } };
    });
  };

  useEffect(() => {
    setLoading(true);
    loadPageData()
      .catch((error) => {
        const text = error instanceof Error ? error.message : "加载失败";
        setMessage(`加载失败：${text}`);
      })
      .finally(() => setLoading(false));

    // 30 秒自动刷新同步
    const interval = window.setInterval(() => {
      loadPageData().catch(() => {});
    }, 30000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);
  // Auto-fill volume and weight from multi-product form
  useEffect(() => {
    if (staffFormProducts.length === 0) return;
    const totalVol = staffFormProducts.reduce((s, p) => {
      const pkg = Number(p.packageCount) || 0;
      const l = Number(p.lengthCm) || 0;
      const w = Number(p.widthCm) || 0;
      const h = Number(p.heightCm) || 0;
      return s + ((l > 0 && w > 0 && h > 0) ? (l * w * h * pkg) / 1_000_000 : 0);
    }, 0);
    const totalWt = staffFormProducts.reduce((s, p) => {
      const pkg = Number(p.packageCount) || 0;
      const wt = Number(p.weightKg) || 0;
      return s + wt * pkg;
    }, 0);
    setForm((v) => ({ ...v, volumeM3: totalVol > 0 ? String(totalVol.toFixed(6)) : v.volumeM3, weightKg: totalWt > 0 ? String(totalWt.toFixed(2)) : v.weightKg }));
  }, [staffFormProducts]);

  useEffect(() => {
    const syncSectionByHash = () => {
      const hashId = window.location.hash.replace(/^#/, "");
      if (isStaffSectionId(hashId)) {
        setActiveSection(hashId);
      }
    };
    syncSectionByHash();
    window.addEventListener("hashchange", syncSectionByHash);
    return () => window.removeEventListener("hashchange", syncSectionByHash);
  }, []);

  const submitOrder = async () => {
    const hasProducts = staffFormProducts.length > 0 && staffFormProducts.some((p) => p.itemName.trim());
    const itemName = hasProducts ? staffFormProducts[0].itemName.trim() : form.itemName.trim();
    const batchNo = form.batchNo.trim();
    const arrivedAt = form.arrivedAt.trim();
    const packageCount = hasProducts
      ? staffFormProducts.reduce((s, p) => s + (Number(p.packageCount) || 1), 0)
      : Number(form.packageCount.trim());
    const productQuantityText = form.productQuantity.trim();
    const productQuantity = productQuantityText ? Number(productQuantityText) : undefined;
    const volumeM3 = Number(form.volumeM3.trim());
    const weightKg = Number(form.weightKg.trim());

    if (!form.trackingNo.trim()) {
      setMessage("运单号为必填，请手动输入。");
      return;
    }
    if (!itemName || !arrivedAt || !form.warehouseId || !form.clientId || !form.transportMode) {
      setMessage("请先完整填写创建订单信息（唛头、品名、仓库、运输方式、到仓日期为必填）。");
      return;
    }
    if (
      Number.isNaN(packageCount) || Number.isNaN(volumeM3) || Number.isNaN(weightKg)
    ) {
      setMessage("数量、重量、体积请输入有效数字。");
      return;
    }
    if (!hasProducts && (!productQuantityText || Number(productQuantityText) <= 0)) {
      setMessage("产品数量必须大于 0。");
      return;
    }
    if (
      packageCount <= 0 || volumeM3 <= 0 || weightKg <= 0
    ) {
      setMessage("包裹数量、重量、体积必须大于 0。");
      return;
    }

    setLoading(true);
    setMessage("");
    try {
      const result = await createStaffOrder({
        clientId: form.clientId,
        warehouseId: form.warehouseId,
        batchNo,
        trackingNo: form.trackingNo.trim(),
        arrivedAt,
        itemName: hasProducts ? staffFormProducts[0].itemName.trim() : itemName,
        productQuantity,
        packageCount,
        packageUnit: form.packageUnit,
        weightKg,
        volumeM3,
        domesticTrackingNo: form.domesticOrderNo.trim() || "货拉拉",
        cargoType: form.cargoType,
        transportMode: form.transportMode,
        products: hasProducts ? staffFormProducts.filter(p => p.itemName.trim()).map(p => ({ itemName: p.itemName.trim(), packageCount: Number(p.packageCount) || 1, lengthCm: p.lengthCm ? Number(p.lengthCm) : undefined, widthCm: p.widthCm ? Number(p.widthCm) : undefined, heightCm: p.heightCm ? Number(p.heightCm) : undefined, productQuantity: p.productQuantity ? Number(p.productQuantity) : undefined, weightKg: p.weightKg ? Number(p.weightKg) : undefined, cargoType: p.cargoType || "NORMAL", domesticTrackingNo: p.domesticTrackingNo.trim() || "货拉拉" })) : undefined,
      });
      // 并行上传产品图片
      if (orderImageFiles.length > 0) {
        try {
          await Promise.all(orderImageFiles.map(async (file) => {
            const base64 = await new Promise<string>((resolve) => {
              const reader = new FileReader();
              reader.onload = () => resolve((reader.result as string).split(",")[1]);
              reader.readAsDataURL(file);
            });
            return uploadStaffOrderProductImage({ orderId: result.orderId, fileName: file.name, mime: file.type || "image/jpeg", contentBase64: base64 });
          }));
        } catch (e) {
          setLoading(false);
          setMessage(`图片上传失败：${e instanceof Error ? e.message : "未知错误"}`);
          return;
        }
        setOrderImageFiles([]);
        setOrderImagePreviews([]);
      }
      setCreateStepDone(true);
      const displayNo = form.trackingNo.trim() || result.orderId;
      setToast("订单创建成功");
      setMessage(`订单创建成功：${displayNo}`);
      // 刷新产品图缓存
      if (orderImageFiles.length > 0) {
        fetchShipmentImages(result.orderId).then((imgs) => {
          setShipmentImagesCache((c) => ({ ...c, [result.orderId]: imgs }));
        }).catch(() => {});
      }
      // 重置表单
      setForm({
        domesticOrderNo: "", trackingNo: "", batchNo: "",
        itemName: "", warehouseId: "wh_yiwu_01", packageUnit: "box" as "bag" | "box",
        transportMode: "sea" as "sea" | "land", cargoType: "NORMAL", arrivedAt: "", clientId: "",
        packageCount: "", volumeM3: "", weightKg: "", productQuantity: "",
        lengthCm: "", widthCm: "", heightCm: "",
      });
      setStaffFormProducts([]);
      setShowCreateModal(false);
      setClientSearchKeyword("");
      setOrderImageFiles([]);
      setOrderImagePreviews([]);
      loadPageData().catch(() => {});
    } catch (error) {
      const text = error instanceof Error ? error.message : "创建失败";
      setMessage(`创建失败：${text}`);
    } finally {
      setLoading(false);
    }
  };


  function downloadStaffBatchTemplate() {
    const ws = XLSX.utils.json_to_sheet([{
      "唛头 *": "",
      "运单号 *": "",
      "仓库 *": "",
      "品名 *": "",
      "箱数 *": "",
      "包装类型（箱/袋，默认箱）": "",
      "长cm（数字）": "",
      "宽cm（数字）": "",
      "高cm（数字）": "",
      "单箱重量kg *（数字）": "",
      "到仓日期 *（YYYY-MM-DD）": "",
      "运输方式 *（海运/陆运）": "",
      "国内单号（选填）": "",
      "产品数量": "",
    }]);
    ws["!cols"] = [
      { wch: 12 },  // 唛头
      { wch: 20 },  // 运单号
      { wch: 14 },  // 仓库
      { wch: 12 },  // 品名
      { wch: 10 },  // 箱数
      { wch: 32 },  // 包装类型
      { wch: 12 },  // 长cm
      { wch: 12 },  // 宽cm
      { wch: 12 },  // 高cm
      { wch: 24 },  // 单箱重量kg
      { wch: 28 },  // 到仓日期
      { wch: 12 },  // 运输方式
      { wch: 20 },  // 国内单号
      { wch: 14 },  // 产品数量
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "员工批量下单模板");
    XLSX.writeFile(wb, "员工批量下单模板.xlsx");
  }

  function normalizeStaffBatchRows(rows: Record<string, unknown>[]) {
    // 按关键字模糊匹配列名（兼容有无括号格式说明）
    function findCol(row: Record<string, unknown>, keywords: string[]): string {
      const keys = Object.keys(row);
      for (const kw of keywords) {
        const found = keys.find((k) => k.includes(kw));
        if (found) return String(row[found] ?? "").trim();
      }
      return "";
    }
    function cleanNum(v: unknown): number | undefined {
      if (v === undefined || v === "") return undefined;
      if (typeof v === "number" && Number.isFinite(v)) return v;
      const cleaned = String(v).replace(/[^0-9.\-]/g, "");
      if (!cleaned) return undefined;
      const n = Number(cleaned);
      return Number.isFinite(n) ? n : undefined;
    }
    function findNum(row: Record<string, unknown>, keywords: string[]): number | undefined {
      const keys = Object.keys(row);
      for (const kw of keywords) {
        const found = keys.find((k) => k.includes(kw));
        if (found) return cleanNum(row[found]);
      }
      return undefined;
    }
    return rows
      .map((row) => {
        const transportRaw = findCol(row, ["运输方式"]).toLowerCase().replace("海运", "sea").replace("陆运", "land");
        const unitRaw = findCol(row, ["包装类型"]).toLowerCase().replace("箱", "box").replace("袋", "bag");
        const warehouseNameMap: Record<string, string> = {
          "义乌仓": "wh_yiwu_01", "广州仓": "wh_guangzhou_01", "东莞仓": "wh_dongguan_01", "深圳仓": "wh_shenzhen_01",
        };
        const rawWarehouse = findCol(row, ["仓库"]);
        const warehouseId = warehouseNameMap[rawWarehouse] || rawWarehouse;
        const packageCount = findNum(row, ["箱数"]) ?? 0;
        const perBoxWeightKg = findNum(row, ["单箱重量"]);
        const weightKg = perBoxWeightKg != null && packageCount > 0 ? perBoxWeightKg * packageCount : perBoxWeightKg;
        const lengthCm = findNum(row, ["长cm", "长"]);
        const widthCm = findNum(row, ["宽cm", "宽"]);
        const heightCm = findNum(row, ["高cm", "高"]);
        let volumeM3: number | undefined;
        if (lengthCm && widthCm && heightCm && lengthCm > 0 && widthCm > 0 && heightCm > 0) {
          volumeM3 = (lengthCm * widthCm * heightCm) / 1_000_000;
        }
        let arrivedAt = findCol(row, ["到仓日期"]);
        if (/^\d{5}$/.test(arrivedAt)) {
          const d = new Date((Number(arrivedAt) - 25569) * 86400000);
          arrivedAt = d.toISOString().slice(0, 10);
        }
        return {
          clientId: findCol(row, ["唛头"]),
          trackingNo: findCol(row, ["运单号"]) || undefined,
          warehouseId,
          itemName: findCol(row, ["品名"]),
          packageCount,
          packageUnit: unitRaw.includes("bag") ? "bag" as const : "box" as const,
          weightKg,
          volumeM3,
          arrivedAt,
          transportMode: transportRaw.includes("land") ? "land" as const : "sea" as const,
          domesticTrackingNo: findCol(row, ["国内单号"]) || undefined,
          productQuantity: findNum(row, ["产品数量"]),
        };
      })
      .filter((item) => item.clientId && item.warehouseId && item.itemName && item.arrivedAt && item.packageCount > 0);
  }
  async function submitStaffBatch() {
    setBatchLoading(true);
    setBatchErrors([]);
    setBatchProgress({ current: 0, success: 0, fail: 0 });
    const errors: string[] = [];
    let success = 0;
    for (let i = 0; i < batchRows.length; i++) {
      setBatchProgress({ current: i + 1, success, fail: errors.length });
      const row = batchRows[i];
      try {
        await createStaffOrder({
          clientId: row.clientId,
          warehouseId: row.warehouseId,
          trackingNo: row.trackingNo,
          arrivedAt: row.arrivedAt,
          itemName: row.itemName,
          packageCount: row.packageCount,
          packageUnit: row.packageUnit,
          weightKg: row.weightKg,
          volumeM3: row.volumeM3,
          transportMode: row.transportMode,
          domesticTrackingNo: row.domesticTrackingNo,
          productQuantity: row.productQuantity,

        });
        success++;
        setBatchProgress({ current: i + 1, success, fail: errors.length });
      } catch (err) {
        const text = err instanceof Error ? err.message : "提交失败";
        errors.push(`第${i + 1}行(${row.itemName}): ${text}`);
        setBatchErrors([...errors]);
        setBatchProgress({ current: i + 1, success, fail: errors.length });
      }
    }
    setBatchLoading(false);
    setBatchErrors(errors);
    await loadPageData();
  }


  const receivePrealert = async (orderId: string) => {
    const sourceItem = prealerts.find((item) => item.id === orderId);
    const currentDraft = prealertEditDrafts[orderId] ?? (sourceItem ? buildPrealertDraft(sourceItem) : undefined);
    const confirmedDraft = prealertConfirmedDrafts[orderId] ?? currentDraft;
    if (!currentDraft || !confirmedDraft) {
      setMessage("未找到预报单草稿，请刷新后重试。");
      return;
    }
    const confirmedDraftError = validatePrealertDraft(confirmedDraft);
    if (confirmedDraftError) {
      setMessage(`确认收货失败：${confirmedDraftError}`);
      return;
    }
    if (editingPrealertId === orderId && !isSamePrealertDraft(currentDraft, confirmedDraft)) {
      setMessage("你还有未确认的修改，请先点击“确认修改”。");
      return;
    }

    const batchNo = (prealertBatchDrafts[orderId] ?? "").trim();
    setLoading(true);
    setMessage("");
    try {
      const draft = confirmedDraft;
      await receiveStaffPrealert({
        orderId,
        itemName: draft?.itemName,
        packageCount: draft?.packageCount,
        packageUnit: draft?.packageUnit,
        productQuantity: draft?.productQuantity,
        weightKg: draft?.weightKg,
        volumeM3: draft?.volumeM3,
        domesticTrackingNo: draft?.domesticTrackingNo,
        transportMode: draft?.transportMode,
      });
      setEditingPrealertId((current) => (current === orderId ? null : current));
      setToast("已确认收货");
      setMessage(`预报单 ${orderId} 已确认收货${batchNo ? `，柜号 ${batchNo}` : ""}。`);
      await loadPageData();
    } catch (error) {
      const text = error instanceof Error ? error.message : "确认收货失败";
      setMessage(`确认收货失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  const confirmPrealertEdit = (orderId: string) => {
    const draft = prealertEditDrafts[orderId];
    if (!draft) {
      setMessage("未找到可确认的修改内容。");
      return;
    }
    const draftError = validatePrealertDraft(draft);
    if (draftError) {
      setMessage(`确认修改失败：${draftError}`);
      return;
    }
    setPrealertConfirmedDrafts((prev) => ({ ...prev, [orderId]: draft }));
    setEditingPrealertId(null);
    setToast("修改已确认");
    setMessage(`预报单 ${orderId} 修改已确认。`);
  };

  const FieldCard = ({
    label,
    children,
  }: {
    label: string;
    children: ReactNode;
  }) => (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 10,
        padding: 10,
        background: "#ffffff",
      }}
    >
      <div style={{ color: "#000000", fontSize: 12, marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );

  const InfoItem = ({ label, value }: { label: string; value: string }) => (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 6,
        background: "#f9fafb",
        padding: "3px 6px",
      }}
    >
      <div style={{ fontSize: 10, color: "#000000" }}>{label}</div>
      <div style={{ fontSize: 12, color: "#000000", fontWeight: 600 }}>{value}</div>
    </div>
  );

  const prealertEditInputStyle = {
    border: "1px solid #d1d5db",
    borderRadius: 6,
    padding: "5px 8px",
    width: "100%",
    fontSize: 12,
    marginBottom: 4,
  } as const;

  const allClientOptions = useMemo(() => {
    const byId = new Map<string, { id: string; name: string }>();
    staffClients.forEach((item) => byId.set(item.id, item));
    prealerts.forEach((item) => {
      if (!item.clientId) return;
      const current = byId.get(item.clientId);
      if (current) return;
      byId.set(item.clientId, {
        id: item.clientId,
        name: item.clientName ?? item.clientId,
      });
    });
    return Array.from(byId.values());
  }, [staffClients, prealerts]);

  const filteredClientOptions = useMemo(() => {
    const keyword = clientSearchKeyword.trim().toLowerCase();
    if (!keyword) return allClientOptions;
    return allClientOptions.filter(
      (item) => item.name.toLowerCase().includes(keyword) || item.id.toLowerCase().includes(keyword),
    );
  }, [allClientOptions, clientSearchKeyword]);

  const filteredPrealerts = useMemo(() => {
    const kw = prealertSearch.keyword.trim().toLowerCase();
    const domesticKw = prealertSearch.domesticTrackingNo.trim().toLowerCase();
    const itemKw = prealertSearch.itemName.trim().toLowerCase();
    return prealerts
      .filter((item) => {
        if (!kw) return true;
        const searchText = `${item.id} ${item.orderNo ?? ""} ${item.clientName ?? ""}`.toLowerCase();
        return searchText.includes(kw);
      })
      .filter((item) => {
        if (!domesticKw) return true;
        return (item.domesticTrackingNo ?? "").toLowerCase().includes(domesticKw);
      })
      .filter((item) => {
        if (!itemKw) return true;
        return (item.itemName ?? "").toLowerCase().includes(itemKw);
      })
      .filter((item) => !prealertSearch.warehouseId || item.warehouseId === prealertSearch.warehouseId);
  }, [prealerts, prealertSearch]);


  const filteredShipmentList = useMemo(() => {
    const batchNoKeyword = shipmentSearch.batchNo.trim().toLowerCase();
    const clientNameKeyword = shipmentSearch.clientName.trim().toLowerCase();
    const itemNameKeyword = shipmentSearch.itemName.trim().toLowerCase();
    const trackingNoKeyword = shipmentSearch.trackingNo.trim().toLowerCase();
    const domesticTrackingKeyword = shipmentSearch.domesticTrackingNo.trim().toLowerCase();
    const packageCountKeyword = shipmentSearch.packageCount.trim();
    const productQuantityKeyword = shipmentSearch.productQuantity.trim();
    const weightKgKeyword = shipmentSearch.weightKg.trim();
    const volumeM3Keyword = shipmentSearch.volumeM3.trim();
    const arrivedAtFrom = shipmentSearch.arrivedAtFrom.trim();
    const arrivedAtTo = shipmentSearch.arrivedAtTo.trim();
    const warehouseKeyword = shipmentSearch.warehouseId.trim();
    const logisticsStatusKeyword = shipmentSearch.logisticsStatus.trim();
    const containerNoKeyword = shipmentSearch.containerNo.trim().toLowerCase();
    const transportModeKeyword = shipmentSearch.transportMode.trim();
    const receiverAddressKeyword = shipmentSearch.receiverAddress.trim().toLowerCase();
    const shipDateFrom = shipmentSearch.shipDateFrom.trim();
    const shipDateTo = shipmentSearch.shipDateTo.trim();
    const receivableAmountKeyword = shipmentSearch.receivableAmount.trim();
    const statusRawKeyword = shipmentSearch.statusRaw.trim().toLowerCase();

    return shipments.filter((item) => {
      const batchNo = (item.batchNo ?? "").toLowerCase();
      const clientName = `${item.clientName ?? ""} ${item.clientId ?? ""}`.toLowerCase();
      const itemName = (item.itemName ?? "").toLowerCase();
      const trackingNo = (item.trackingNo ?? "").toLowerCase();
      const domesticTrackingNo = (
        (item.domesticTrackingNo ?? "") +
        (item.products?.map(p => p.domesticTrackingNo ?? "").join(" ") ?? "")
      ).toLowerCase();
      const packageCount = item.packageCount == null ? "" : String(item.packageCount);
      const productQuantity = item.productQuantity == null ? "" : String(item.productQuantity);
      const weightKg = item.weightKg == null ? "" : String(item.weightKg);
      const volumeM3 = item.volumeM3 == null ? "" : String(item.volumeM3);
      const arrivedAt = item.arrivedAt ? item.arrivedAt.slice(0, 10) : "";
      const warehouseId = (item.warehouseId ?? "").toLowerCase();
      const logisticsStatus = toLogisticsStatus(item.currentStatus);
      const containerNo = (item.containerNo ?? "").toLowerCase();
      const receiverAddr = (item.receiverAddressTh ?? "").toLowerCase();
      const shipDateVal = (item.shipDate ?? "").trim().slice(0, 10);
      const receivableText =
        item.receivableAmountCny == null ? "" : item.receivableAmountCny.toFixed(2);
      const statusRaw = (item.currentStatus ?? "").toLowerCase();

      if (batchNoKeyword && !batchNo.includes(batchNoKeyword)) return false;
      if (clientNameKeyword && !clientName.includes(clientNameKeyword)) return false;
      if (itemNameKeyword && !itemName.includes(itemNameKeyword)) return false;
      if (trackingNoKeyword && !trackingNo.includes(trackingNoKeyword)) return false;
      if (domesticTrackingKeyword && !domesticTrackingNo.includes(domesticTrackingKeyword)) return false;
      if (packageCountKeyword && !packageCount.includes(packageCountKeyword)) return false;
      if (productQuantityKeyword && !productQuantity.includes(productQuantityKeyword)) return false;
      if (weightKgKeyword && !weightKg.includes(weightKgKeyword)) return false;
      if (volumeM3Keyword && !volumeM3.includes(volumeM3Keyword)) return false;
      if (arrivedAtFrom && arrivedAt < arrivedAtFrom) return false;
      if (arrivedAtTo && arrivedAt > arrivedAtTo) return false;
      if (warehouseKeyword && warehouseId !== warehouseKeyword.toLowerCase()) return false;
      if (logisticsStatusKeyword && logisticsStatus !== logisticsStatusKeyword) return false;
      if (containerNoKeyword && !containerNo.includes(containerNoKeyword)) return false;
      if (transportModeKeyword && (item.transportMode ?? "") !== transportModeKeyword) return false;
      if (receiverAddressKeyword && !receiverAddr.includes(receiverAddressKeyword)) return false;
      if (shipDateFrom && shipDateVal < shipDateFrom) return false;
      if (shipDateTo && shipDateVal > shipDateTo) return false;
      if (receivableAmountKeyword && !receivableText.includes(receivableAmountKeyword)) return false;
      if (statusRawKeyword && !statusRaw.includes(statusRawKeyword)) return false;
      return true;
    });
  }, [shipments, shipmentSearch]);

  /**
   * 运单列表：点击「搜索」后提示当前筛选条数并滚动至结果表格。
   */
  const runShipmentListSearch = () => {
    setToast(`共 ${filteredShipmentList.length} 条运单`);
    document.getElementById("staff-shipment-list-table-wrap")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  const orderCreateInputStyle = {
    border: "1px solid #d1d5db",
    borderRadius: 8,
    padding: "8px 10px",
    width: "100%",
    marginBottom: 8,
  } as const;
  const lengthCm = Number(sizeDraft.lengthCm || 0);
  const widthCm = Number(sizeDraft.widthCm || 0);
  const heightCm = Number(sizeDraft.heightCm || 0);
  const actualWeightKg = Number(sizeDraft.actualWeightKg || 0);
  const volumetricWeightKg =
    lengthCm > 0 && widthCm > 0 && heightCm > 0 ? (lengthCm * widthCm * heightCm) / 6000 : 0;
  const chargeableWeightKg = Math.max(actualWeightKg > 0 ? actualWeightKg : 0, volumetricWeightKg);

  const toggleSelectShipment = (trackingNo: string) => {
    setSelectedForExport((prev) => {
      const next = new Set(prev);
      if (next.has(trackingNo)) next.delete(trackingNo); else next.add(trackingNo);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedForExport.size === filteredShipmentList.length) {
      setSelectedForExport(new Set());
    } else {
      setSelectedForExport(new Set(filteredShipmentList.map((s) => s.trackingNo)));
    }
  };

  const pagedShipments = useMemo(() => filteredShipmentList.slice(0, pageSize), [filteredShipmentList, pageSize]);

  // 搜索条件变化时清空选中
  useEffect(() => { setSelectedForExport(new Set()); }, [shipmentSearch]);

  const exportShipmentsToExcel = () => {
    const source = selectedForExport.size > 0
      ? filteredShipmentList.filter((s) => selectedForExport.has(s.trackingNo))
      : filteredShipmentList;
    if (source.length === 0) {
      setMessage("当前没有可导出的运单数据。");
      return;
    }
    const rows = source.map((item) => ({
      运单号: item.trackingNo ?? "-",
      品名: item.itemName ?? "-",
      归属用户: item.clientName ?? item.clientId ?? "-",
      运单状态: shipmentStatusZh(item.currentStatus),
      加收金额: item.receivableAmountCny != null ? `${item.receivableCurrency === "THB" ? "THB" : "CNY"} ${item.receivableAmountCny}` : "0",
      运输方式: transportModeLabel(item.transportMode),
      发货时间: item.shipDate ?? formatDateTime(item.arrivedAt, "-"),
      总件数: item.packageCount ?? "-",
      总重量: item.weightKg ?? "-",
      总体积: item.volumeM3 ?? "-",
      计费体积: item.volumeM3 != null && item.volumeM3 > 0
        ? Math.max(item.volumeM3, item.transportMode === "sea" ? 0.5 : item.transportMode === "land" ? 0.2 : 0).toFixed(3)
        : "-",
      所属仓库: warehouseLabelFromId(item.warehouseId),
      收货地址: truncateText(item.receiverAddressTh, 40),
      柜号: item.batchNo ?? "-",
      国内单号: item.domesticTrackingNo ?? "-",
      产品数量: item.productQuantity ?? "-",
      到仓日期: formatDateTime(item.arrivedAt, "-"),
      可编辑: item.canEdit ? "是" : "否",
      更新时间: item.updatedAt ?? "-",
    }));
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "运单列表");
    const today = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(workbook, `运单列表_${today}.xlsx`);
    setToast("导出Excel成功");
  };

  return (
    <RoleShell allowedRole="staff" title="员工工作台">
      <p style={{ color: "#4b5563", marginBottom: 16 }}>
        员工可创建订单、查看运单列表中的订单信息（只读），并按状态流转规则更新物流状态；订单金额、付款及产品图（已审核订单）请在管理端维护。
      </p>

      <section
        id="staff-billing"
        style={{
          display: activeSection === "staff-billing" ? "block" : "none",
          border: "1px solid #e5e7eb",
          borderLeft: "4px solid #0f766e",
          borderRadius: 12,
          padding: 16,
          marginBottom: 18,
          background: "#ffffff",
          boxShadow: "0 1px 3px rgba(15,23,42,0.06)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <h2 style={{ margin: 0, fontSize: 18, color: "#111827" }}>账单管理（业务板块）</h2>
        </div>
        <div
          style={{
            border: "1px solid #e2e8f0",
            borderRadius: 12,
            padding: 14,
            background: "#f8fafc",
            color: "#000000",
            fontSize: 14,
            lineHeight: 1.6,
          }}
        >
          应收金额、付款状态与已审核订单的产品图维护已调整为<strong>仅管理员</strong>在管理端操作。员工端运单列表中的订单信息为<strong>只读</strong>展示。
        </div>
      </section>

      <section
        id="staff-prealert-review"
        style={{
          display: activeSection === "staff-prealert-review" ? "block" : "none",
          border: "1px solid #e5e7eb",
          borderLeft: "4px solid #d1d5db",
          borderRadius: 12,
          padding: 16,
          marginBottom: 18,
          background: "#ffffff",
          boxShadow: "0 1px 3px rgba(15,23,42,0.06)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <h2 style={{ margin: 0, fontSize: 18, color: "#111827" }}>预报单收货确认</h2>
          <button
            type="button"
            onClick={() => setPrealertPanelCollapsed((v) => !v)}
            style={{
              border: "1px solid #d1d5db",
              borderRadius: 8,
              padding: "6px 10px",
              color: "#000000",
              background: "#fff",
              fontWeight: 600,
            }}
          >
            {prealertPanelCollapsed ? "展开" : "折叠"}
          </button>
          <PrealertSearch value={prealertSearch} onChange={(key, val) => setPrealertSearch((prev) => ({ ...prev, [key]: val }))} onSearch={() => {}} warehouseOptions={warehouseOptions} inputStyle={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", fontSize: 13, width: "100%" }} />
        </div>
          <>
            {prealerts.length === 0 ? (
              <EmptyStateCard title="暂无待收货预报单" description="客户端创建预报单后会在这里显示。" />
            ) : filteredPrealerts.length === 0 ? (
              <EmptyStateCard title="未找到匹配预报单" description="可调整客户名字、国内快递单号、仓库或运输方式筛选条件。" />
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {filteredPrealerts.map((item) => (
                  <div key={item.id} style={{ border: "1px solid #e5e7eb", borderRadius: 6, padding: 8, background: "#fff" }}>
                    {(() => {
                      const draft = prealertEditDrafts[item.id] ?? buildPrealertDraft(item);
                      const isEditing = editingPrealertId === item.id;
                      const confirmedDraft = prealertConfirmedDrafts[item.id] ?? buildPrealertDraft(item);
                      const displayDraft = isEditing ? draft : confirmedDraft;
                      return (
                        <>
                    <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4, color: "#000000" }}>
                      <span style={{ fontFamily: "monospace" }}>{item.orderNo || item.id}</span> · {item.clientName ?? item.clientId ?? "-"} · {item.createdAt.slice(0, 10)}
                    </div>
                    {(item.products?.length ?? 0) > 1 && (
                      <div style={{ fontSize: 11, color: "#000000", marginBottom: 6, background: "#fefce8", borderRadius: 4, padding: "3px 6px" }}>
                        {item.products!.map((p) => `${p.itemName}×${p.packageCount}箱`).join(" | ")}
                      </div>
                    )}
                    <div
                      style={{
                        marginBottom: 6,
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                        gap: 4,
                      }}
                    >
                      {isEditing ? (
                        <>
                          <select
                            value={draft.warehouseId}
                            onChange={(e) =>
                              setPrealertEditDrafts((prev) => ({
                                ...prev,
                                [item.id]: {
                                  ...(prev[item.id] ?? buildPrealertDraft(item)),
                                  warehouseId: e.target.value,
                                },
                              }))
                            }
                            style={prealertEditInputStyle}
                          >
                            <option value="">请选择仓库</option>
                            {warehouseOptions.map((warehouse) => (
                              <option key={warehouse.id} value={warehouse.id}>
                                仓库：{warehouse.label}
                              </option>
                            ))}
                          </select>
                          <input
                            value={draft.itemName}
                            onChange={(e) =>
                              setPrealertEditDrafts((prev) => ({
                                ...prev,
                                [item.id]: { ...(prev[item.id] ?? buildPrealertDraft(item)), itemName: e.target.value },
                              }))
                            }
                            placeholder="品名"
                            style={prealertEditInputStyle}
                          />
                          <input
                            type="number"
                            value={String(draft.packageCount)}
                            onChange={(e) =>
                              setPrealertEditDrafts((prev) => ({
                                ...prev,
                                [item.id]: {
                                  ...(prev[item.id] ?? buildPrealertDraft(item)),
                                  packageCount: Number(e.target.value || 0),
                                },
                              }))
                            }
                            placeholder="箱数/袋数"
                            style={prealertEditInputStyle}
                          />
                          <select
                            value={draft.packageUnit}
                            onChange={(e) =>
                              setPrealertEditDrafts((prev) => ({
                                ...prev,
                                [item.id]: {
                                  ...(prev[item.id] ?? buildPrealertDraft(item)),
                                  packageUnit: e.target.value as "bag" | "box",
                                },
                              }))
                            }
                            style={prealertEditInputStyle}
                          >
                            <option value="box">箱（box）</option>
                            <option value="bag">袋（bag）</option>
                          </select>
                          <input
                            type="number"
                            value={String(draft.productQuantity)}
                            onChange={(e) =>
                              setPrealertEditDrafts((prev) => ({
                                ...prev,
                                [item.id]: {
                                  ...(prev[item.id] ?? buildPrealertDraft(item)),
                                  productQuantity: Number(e.target.value || 0),
                                },
                              }))
                            }
                            placeholder="产品数量"
                            style={prealertEditInputStyle}
                          />
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                            <input
                              type="number"
                              step="0.01"
                              min="0.01"
                              value={String(draft.weightKg)}
                              onChange={(e) =>
                                setPrealertEditDrafts((prev) => ({
                                  ...prev,
                                  [item.id]: {
                                    ...(prev[item.id] ?? buildPrealertDraft(item)),
                                    weightKg: Number(e.target.value || 0),
                                  },
                                }))
                              }
                              placeholder="重量"
                              style={{ ...prealertEditInputStyle, marginBottom: 0 }}
                            />
                            <span style={{ color: "#000000", fontSize: 13, minWidth: 26 }}>kg</span>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                            <input
                              type="number"
                              step="0.001"
                              min="0.001"
                              value={String(draft.volumeM3)}
                              onChange={(e) =>
                                setPrealertEditDrafts((prev) => ({
                                  ...prev,
                                  [item.id]: {
                                    ...(prev[item.id] ?? buildPrealertDraft(item)),
                                    volumeM3: Number(e.target.value || 0),
                                  },
                                }))
                              }
                              placeholder="体积"
                              style={{ ...prealertEditInputStyle, marginBottom: 0 }}
                            />
                            <span style={{ color: "#000000", fontSize: 13, minWidth: 30 }}>m3</span>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                            <input
                              type="number"
                              step="0.01"
                              min="0.01"
                              value={String(draft.receivableAmountCny)}
                              onChange={(e) =>
                                setPrealertEditDrafts((prev) => ({
                                  ...prev,
                                  [item.id]: {
                                    ...(prev[item.id] ?? buildPrealertDraft(item)),
                                    receivableAmountCny: Number(e.target.value || 0),
                                  },
                                }))
                              }
                              placeholder="最终应收金额"
                              style={{ ...prealertEditInputStyle, marginBottom: 0 }}
                            />
                            <select
                              value={draft.receivableCurrency}
                              onChange={(e) =>
                                setPrealertEditDrafts((prev) => ({
                                  ...prev,
                                  [item.id]: {
                                    ...(prev[item.id] ?? buildPrealertDraft(item)),
                                    receivableCurrency: e.target.value === "THB" ? "THB" : "CNY",
                                  },
                                }))
                              }
                              style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", minWidth: 100 }}
                            >
                              <option value="CNY">CNY</option>
                              <option value="THB">THB</option>
                            </select>
                          </div>
                          <input
                            value={draft.domesticTrackingNo}
                            onChange={(e) =>
                              setPrealertEditDrafts((prev) => ({
                                ...prev,
                                [item.id]: {
                                  ...(prev[item.id] ?? buildPrealertDraft(item)),
                                  domesticTrackingNo: e.target.value,
                                },
                              }))
                            }
                            placeholder="国内快递单号"
                            style={prealertEditInputStyle}
                          />
                          <select
                            value={draft.transportMode}
                            onChange={(e) =>
                              setPrealertEditDrafts((prev) => ({
                                ...prev,
                                [item.id]: {
                                  ...(prev[item.id] ?? buildPrealertDraft(item)),
                                  transportMode: e.target.value as "sea" | "land",
                                },
                              }))
                            }
                            style={prealertEditInputStyle}
                          >
                            <option value="sea">运输方式：海运</option>
                            <option value="land">运输方式：陆运</option>
                          </select>
                          <input
                            type="date"
                            value={draft.shipDate}
                            onChange={(e) =>
                              setPrealertEditDrafts((prev) => ({
                                ...prev,
                                [item.id]: { ...(prev[item.id] ?? buildPrealertDraft(item)), shipDate: e.target.value },
                              }))
                            }
                            style={prealertEditInputStyle}
                          />
                        </>
                      ) : (
                        <>
                          <InfoItem label="品名" value={displayDraft.itemName} />
                      <InfoItem
                        label="仓库"
                        value={
                          warehouseOptions.find((warehouse) => warehouse.id === displayDraft.warehouseId)?.label ??
                          displayDraft.warehouseId ??
                          "-"
                        }
                      />
                          <InfoItem label="箱数/袋数" value={`${displayDraft.packageCount} ${displayDraft.packageUnit}`} />
                          <InfoItem label="产品数量" value={String(displayDraft.productQuantity)} />
                          <InfoItem label="重量" value={`${displayDraft.weightKg ?? "-"} kg`} />
                          <InfoItem label="体积" value={`${displayDraft.volumeM3 ?? "-"} m3`} />
                          {displayDraft.receivableAmountCny != null && displayDraft.receivableAmountCny > 0 ? (
                            <InfoItem
                              label="最终应收金额"
                              value={
                                displayDraft.receivableCurrency === "THB"
                                  ? `THB ${displayDraft.receivableAmountCny.toFixed(2)}`
                                  : formatCny(displayDraft.receivableAmountCny)
                              }
                            />
                          ) : null}
                          <InfoItem label="国内快递单号" value={displayDraft.domesticTrackingNo ?? "-"} />
                          <InfoItem label="运输方式" value={displayDraft.transportMode === "sea" ? "海运" : "陆运"} />
                          <InfoItem label="发货日期" value={displayDraft.shipDate} />
                        </>
                      )}
                    </div>
                    <OrderProductImagesPanel
                      orderId={item.id}
                      images={item.productImages ?? []}
                      canManage
                      busy={loading}
                      onSelectFile={(file) => uploadOrderProductImageAndReload(item.id, file)}
                      onDelete={(imageId) => deleteOrderProductImageAndReload(imageId)}
                    />
                    <input
                      value={prealertBatchDrafts[item.id] ?? ""}
                      onChange={(e) =>
                        setPrealertBatchDrafts((prev) => ({
                          ...prev,
                          [item.id]: e.target.value,
                        }))
                      }
                      placeholder="柜号（可选，装柜时填写）"
                      style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "5px 8px", width: "100%", fontSize: 12, marginBottom: 4 }}
                    />
                    <div style={{ display: "flex", gap: 8 }}>
                      {isEditing ? (
                        <>
                          <button
                            type="button"
                            disabled={loading}
                            onClick={() => void confirmPrealertEdit(item.id)}
                            style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff", background: "#000000", fontWeight: 600 }}
                          >
                            确认修改
                          </button>
                          <button
                            type="button"
                            disabled={loading}
                            onClick={() => {
                              const sourceItem = prealerts.find((prealert) => prealert.id === item.id);
                              setPrealertEditDrafts((prev) => ({
                                ...prev,
                                [item.id]: prealertConfirmedDrafts[item.id] ?? (sourceItem ? buildPrealertDraft(sourceItem) : prev[item.id]),
                              }));
                              setEditingPrealertId(null);
                            }}
                            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 14px", color: "#000000", background: "#fff", fontWeight: 600 }}
                          >
                            取消修改
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          disabled={loading}
                          onClick={() => {
                            const sourceItem = prealerts.find((prealert) => prealert.id === item.id);
                            setPrealertEditDrafts((prev) => ({
                              ...prev,
                              [item.id]:
                                prealertConfirmedDrafts[item.id] ??
                                prev[item.id] ??
                                (sourceItem ? buildPrealertDraft(sourceItem) : buildPrealertDraft(item)),
                            }));
                            setEditingPrealertId(item.id);
                          }}
                          style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 14px", color: "#000000", background: "#fff", fontWeight: 600 }}
                        >
                          修改
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={loading}
                        onClick={() => setApprovingPrealert(item)}
                        style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff", background: "#000000", fontWeight: 600 }}
                      >
                        确认收货
                      </button>
                    </div>
                        </>
                      );
                    })()}
                  </div>
                ))}
              </div>
            )}
          </>
      </section>

      <section
        id="staff-create-order"
        style={{
          display: activeSection === "staff-create-order" ? "block" : "none",
          border: "1px solid #e5e7eb",
          borderLeft: "4px solid #d1d5db",
          borderRadius: 12,
          padding: 16,
          marginBottom: 18,
          background: "#fcfcfd",
          boxShadow: "0 1px 3px rgba(15,23,42,0.06)",
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: 18, color: "#111827", marginBottom: 12 }}>创建订单（员工）</h2>
        <div style={{ display: "grid", gap: 0, maxWidth: 760 }}>
          <div style={{ position: "relative" }}>
            <input
              value={clientSearchKeyword}
              onChange={(e) => {
                setClientSearchKeyword(e.target.value);
                const match = allClientOptions.find(
                  (c) => `${c.id} - ${c.name}` === e.target.value
                );
                if (match) setForm((v) => ({ ...v, clientId: match.id }));
              }}
              onFocus={() => setClientSearchKeyword("")}
              placeholder="搜索客户名字或ID…"
              list="client-options"
              autoComplete="off"
              style={{ ...orderCreateInputStyle, width: "100%" }}
            />
            <datalist id="client-options">
              {filteredClientOptions.map((item) => (
                <option key={item.id} value={`${item.id} - ${item.name}`} />
              ))}
            </datalist>
          </div>
          <input
            value={allClientOptions.find((c) => c.id === form.clientId)?.id ?? form.clientId}
            readOnly
            style={{ ...orderCreateInputStyle, background: "#f8fafc", color: "#000000", fontWeight: 600 }}
            placeholder="已选唛头"
          />
          <select
            value={form.warehouseId}
            onChange={(e) => setForm((v) => ({ ...v, warehouseId: e.target.value }))}
            style={orderCreateInputStyle}
          >
            {warehouseOptions.map((item) => (
              <option key={item.id} value={item.id}>
                仓库：{item.label}
              </option>
            ))}
          </select>
          <input value={form.trackingNo} onChange={(e) => setForm((v) => ({ ...v, trackingNo: e.target.value }))} placeholder="运单号 *" style={orderCreateInputStyle} />
          <input value={form.batchNo} onChange={(e) => setForm((v) => ({ ...v, batchNo: e.target.value }))} placeholder="柜号（可选）" style={orderCreateInputStyle} />
          <input value={form.itemName} onChange={(e) => setForm((v) => ({ ...v, itemName: e.target.value }))} placeholder="品名 *" style={orderCreateInputStyle} />
          <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, background: "#f9fafb" }}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, color: "#000000" }}>产品列表</div>
            {staffFormProducts.length === 0 ? (
              <input value={form.itemName} onChange={(e) => setForm((v) => ({ ...v, itemName: e.target.value }))} placeholder="品名 *" style={orderCreateInputStyle} />
            ) : null}
            {staffFormProducts.map((p, i) => {
            const pPkg = Number(p.packageCount) || 0;
            const pL = Number(p.lengthCm) || 0;
            const pW = Number(p.widthCm) || 0;
            const pH = Number(p.heightCm) || 0;
            const pWt = Number(p.weightKg) || 0;
            const prodVol = (pL > 0 && pW > 0 && pH > 0) ? (pL * pW * pH * pPkg) / 1_000_000 : 0;
            const prodWt = pWt * pPkg;
            return (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "2.5fr 0.45fr 0.35fr 0.35fr 0.35fr 0.4fr 0.42fr 0.7fr 0.8fr 0.6fr 0.6fr auto", gap: 2, marginBottom: 3, alignItems: "center" }}>
                <input value={p.itemName} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], itemName: e.target.value }; setStaffFormProducts(n); }} placeholder="品名" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "3px 4px", fontSize: 11 }} />
                <input type="number" value={p.packageCount} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], packageCount: e.target.value }; setStaffFormProducts(n); }} placeholder="箱数" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "3px 4px", fontSize: 11, minWidth: 0 }} />
                <input type="number" step="0.01" value={p.lengthCm} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], lengthCm: e.target.value }; setStaffFormProducts(n); }} placeholder="长" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "3px 4px", fontSize: 11, minWidth: 0 }} />
                <input type="number" step="0.01" value={p.widthCm} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], widthCm: e.target.value }; setStaffFormProducts(n); }} placeholder="宽" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "3px 4px", fontSize: 11, minWidth: 0 }} />
                <input type="number" step="0.01" value={p.heightCm} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], heightCm: e.target.value }; setStaffFormProducts(n); }} placeholder="高" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "3px 4px", fontSize: 11, minWidth: 0 }} />
                <input type="number" value={p.productQuantity} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], productQuantity: e.target.value }; setStaffFormProducts(n); }} placeholder="单箱数量" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "3px 4px", fontSize: 11, minWidth: 0 }} />
                <input type="number" step="0.01" value={p.weightKg} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], weightKg: e.target.value }; setStaffFormProducts(n); }} placeholder="单箱重kg" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "3px 4px", fontSize: 11, minWidth: 0 }} />
                <select value={p.cargoType || "NORMAL"} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], cargoType: e.target.value }; setStaffFormProducts(n); }} style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "3px 2px", fontSize: 11, background: "#fff", minWidth: 0 }}>
                  <option value="NORMAL">普货</option>
                  <option value="INSPECTION">商检</option>
                  <option value="SENSITIVE">敏感</option>
                </select>
                <input value={p.domesticTrackingNo || ""} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], domesticTrackingNo: e.target.value }; setStaffFormProducts(n); }} placeholder="货拉拉" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "3px 4px", fontSize: 11, minWidth: 0 }} />
                <span style={{ fontSize: 10, color: prodVol > 0 ? "#2563eb" : "#9ca3af", textAlign: "right", padding: "0 2px", whiteSpace: "nowrap" }}>{prodVol > 0 ? prodVol.toFixed(3) + "m³" : "—"}</span>
                <span style={{ fontSize: 10, color: prodWt > 0 ? "#2563eb" : "#9ca3af", textAlign: "right", padding: "0 2px", whiteSpace: "nowrap" }}>{prodWt > 0 ? prodWt.toFixed(1) + "kg" : "—"}</span>
                <button type="button" onClick={() => setStaffFormProducts((v) => v.filter((_, j) => j !== i))} style={{ border: "1px solid #fca5a5", borderRadius: 4, padding: "2px 4px", fontSize: 10, background: "#fff", color: "#dc2626", cursor: "pointer", minWidth: 20 }}>✕</button>
              </div>
            );})}
            {(() => {
              const totalVol = staffFormProducts.reduce((s, p) => {
                const pkg = Number(p.packageCount) || 0;
                const l = Number(p.lengthCm) || 0;
                const w = Number(p.widthCm) || 0;
                const h = Number(p.heightCm) || 0;
                return s + ((l > 0 && w > 0 && h > 0) ? (l * w * h * pkg) / 1_000_000 : 0);
              }, 0);
              const totalWt = staffFormProducts.reduce((s, p) => {
                const pkg = Number(p.packageCount) || 0;
                const wt = Number(p.weightKg) || 0;
                return s + wt * pkg;
              }, 0);
              return (
                <div style={{ fontSize: 12, fontWeight: 600, padding: "4px 0", color: "#2563eb", textAlign: "right" }}>
                  合计：总体积 {totalVol.toFixed(6)}m³  |  总重量 {totalWt.toFixed(2)}kg
                </div>
              );
            })()}
            <button type="button" onClick={() => setStaffFormProducts((v) => [...v, { itemName: "", packageCount: "", lengthCm: "", widthCm: "", heightCm: "", productQuantity: "", weightKg: "", cargoType: "NORMAL", domesticTrackingNo: "" }])} style={{ border: "1px dashed #2563eb", borderRadius: 4, padding: "4px 10px", fontSize: 12, background: "#fff", color: "#2563eb", cursor: "pointer", marginTop: 4 }}>+ 添加产品</button>
          </div>
          <div style={{ fontSize: 12, color: "#000000", marginTop: 4 }}>
            💡 输入长宽高和单箱重量后，体积和总重量在前端实时自动计算
          </div>
          <input type="number" value={form.packageCount} onChange={(e) => updateOrderDimensions({ packageCount: e.target.value })} placeholder="包裹数量" style={orderCreateInputStyle} />
          <input type="number" value={form.productQuantity} onChange={(e) => setForm((v) => ({ ...v, productQuantity: e.target.value }))} placeholder="产品数量 *" style={orderCreateInputStyle} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
            <input
              type="number"
              min={0}
              step="0.01"
              value={form.lengthCm}
              onChange={(e) => updateOrderDimensions({ lengthCm: e.target.value })}
              placeholder="长（cm）"
              style={orderCreateInputStyle}
            />
            <input
              type="number"
              min={0}
              step="0.01"
              value={form.widthCm}
              onChange={(e) => updateOrderDimensions({ widthCm: e.target.value })}
              placeholder="宽（cm）"
              style={orderCreateInputStyle}
            />
            <input
              type="number"
              min={0}
              step="0.01"
              value={form.heightCm}
              onChange={(e) => updateOrderDimensions({ heightCm: e.target.value })}
              placeholder="高（cm）"
              style={orderCreateInputStyle}
            />
          </div>
          <div style={{ fontSize: 12, color: "#000000", marginTop: -4, marginBottom: 4 }}>尺寸：厘米；体积（m³）= 长×宽×高 ÷ 1,000,000，自动填入下方。</div>
          <input type="number" step="0.01" value={form.weightKg} readOnly={staffFormProducts.length > 0} onChange={(e) => setForm((v) => ({ ...v, weightKg: e.target.value }))} placeholder="重量（kg）" style={orderCreateInputStyle} />
          <input
            type="text"
            readOnly
            value={form.volumeM3}
            placeholder="体积（m³，根据长宽高自动生成）"
            style={{ ...orderCreateInputStyle, color: "#000000", background: "#f8fafc" }}
          />
          <div style={{ display: "grid", gap: 4 }}>
            <input type="date" value={form.arrivedAt} onChange={(e) => setForm((v) => ({ ...v, arrivedAt: e.target.value }))} style={orderCreateInputStyle} />
            <div style={{ fontSize: 12, color: "#000000", marginTop: -6, marginBottom: 8 }}>说明：该日期为到仓日期</div>
          </div>
        </div>
        <div style={{ marginTop: 10 }}>
          <button type="button" disabled={loading} onClick={() => void submitOrder()} style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff", background: "#000000" }}>
            创建订单
          </button>
        </div>
      </section>

      <section
        id="staff-ops-tools"
        style={{
          display: activeSection === "staff-ops-tools" ? "block" : "none",
          border: "1px solid #e5e7eb",
          borderLeft: "4px solid #0f766e",
          borderRadius: 12,
          padding: 16,
          marginBottom: 18,
          background: "#ffffff",
          boxShadow: "0 1px 3px rgba(15,23,42,0.06)",
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: 18, color: "#111827", marginBottom: 12 }}>入库与标签工具</h2>
        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ border: "1px solid #d1fae5", borderRadius: 10, padding: 10, background: "#ecfdf5" }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>体积重量自动核算</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 8 }}>
              <input value={sizeDraft.lengthCm} onChange={(e) => setSizeDraft((v) => ({ ...v, lengthCm: e.target.value }))} placeholder="长(cm)" style={orderCreateInputStyle} />
              <input value={sizeDraft.widthCm} onChange={(e) => setSizeDraft((v) => ({ ...v, widthCm: e.target.value }))} placeholder="宽(cm)" style={orderCreateInputStyle} />
              <input value={sizeDraft.heightCm} onChange={(e) => setSizeDraft((v) => ({ ...v, heightCm: e.target.value }))} placeholder="高(cm)" style={orderCreateInputStyle} />
              <input value={sizeDraft.actualWeightKg} onChange={(e) => setSizeDraft((v) => ({ ...v, actualWeightKg: e.target.value }))} placeholder="实重(kg)" style={orderCreateInputStyle} />
            </div>
            <div style={{ marginTop: 6, fontSize: 13, color: "#065f46" }}>
              体积重 = L×W×H/6000 = {volumetricWeightKg.toFixed(3)} kg；计费重 = Max(实重, 体积重) ={" "}
              <strong>{chargeableWeightKg.toFixed(3)} kg</strong>
            </div>
          </div>

          <div style={{ border: "1px solid #dbeafe", borderRadius: 10, padding: 10, background: "#eff6ff" }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>标签打印系统</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 8 }}>
              <input value={labelDraft.orderOrShipmentId} onChange={(e) => setLabelDraft((v) => ({ ...v, orderOrShipmentId: e.target.value }))} placeholder="订单号/运单号" style={orderCreateInputStyle} />
              <select value={labelDraft.labelType} onChange={(e) => setLabelDraft((v) => ({ ...v, labelType: e.target.value as "fba" | "waybill" | "internal-box" }))} style={orderCreateInputStyle}>
                <option value="fba">FBA 标签</option>
                <option value="waybill">面单</option>
                <option value="internal-box">内部箱号条码</option>
              </select>
              <button
                type="button"
                onClick={() => {
                  const targetId = labelDraft.orderOrShipmentId.trim() || "N/A";
                  const title = labelDraft.labelType === "fba" ? "FBA 标签" : labelDraft.labelType === "waybill" ? "运单面单" : "内部箱号条码";
                  const printWindow = window.open("", "_blank", "width=420,height=560");
                  if (!printWindow) return;
                  printWindow.document.write(`
                    <html><body style="font-family:Arial;padding:16px;">
                      <h2>${title}</h2>
                      <p>单号：${targetId}</p>
                      <p>打印时间：${new Date().toLocaleString("zh-CN")}</p>
                    </body></html>
                  `);
                  printWindow.document.close();
                  printWindow.print();
                }}
                style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff", background: "#2563eb" }}
              >
                一键打印标签
              </button>
            </div>
          </div>

          <div style={{ border: "1px solid #fde68a", borderRadius: 10, padding: 10, background: "#fffbeb" }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>装柜/排舱管理（Container No.）</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 8 }}>
              <input value={containerDraft.shipmentId} onChange={(e) => setContainerDraft((v) => ({ ...v, shipmentId: e.target.value }))} placeholder="运单ID（shipmentId）" style={orderCreateInputStyle} />
              <input value={containerDraft.containerNo} onChange={(e) => setContainerDraft((v) => ({ ...v, containerNo: e.target.value }))} placeholder="Container No." style={orderCreateInputStyle} />
              <button
                type="button"
                disabled={loading}
                onClick={async () => {
                  setLoading(true);
                  try {
                    await setStaffShipmentContainer({
                      shipmentId: containerDraft.shipmentId.trim(),
                      containerNo: containerDraft.containerNo.trim(),
                    });
                    await loadPageData();
                    setToast("装柜号更新成功");
                  } catch (error) {
                    const text = error instanceof Error ? error.message : "更新失败";
                    setMessage(`更新失败：${text}`);
                  } finally {
                    setLoading(false);
                  }
                }}
                style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff", background: "#a16207" }}
              >
                保存装柜号
              </button>
            </div>
          </div>

          <div style={{ border: "1px solid #fecaca", borderRadius: 10, padding: 10, background: "#fff1f2" }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>入库拍照（责任留档）</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 8 }}>
              <input value={photoDraft.shipmentId} onChange={(e) => setPhotoDraft((v) => ({ ...v, shipmentId: e.target.value }))} placeholder="运单ID（shipmentId）" style={orderCreateInputStyle} />
              <input value={photoDraft.note} onChange={(e) => setPhotoDraft((v) => ({ ...v, note: e.target.value }))} placeholder="备注（例如：外箱破损）" style={orderCreateInputStyle} />
              <input
                type="file"
                accept="image/*"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const contentBase64 = await readFileAsBase64(file);
                  setPhotoDraft((v) => ({
                    ...v,
                    fileName: file.name,
                    mime: file.type || "application/octet-stream",
                    contentBase64,
                  }));
                }}
                style={orderCreateInputStyle}
              />
              <button
                type="button"
                disabled={loading || !photoDraft.shipmentId.trim() || !photoDraft.fileName || !photoDraft.contentBase64}
                onClick={async () => {
                  if (!photoDraft.shipmentId.trim() || !photoDraft.fileName || !photoDraft.mime || !photoDraft.contentBase64) {
                    setMessage("请先填写运单ID并选择文件");
                    return;
                  }
                  setLoading(true);
                  try {
                    await uploadStaffInboundPhoto({
                      shipmentId: photoDraft.shipmentId.trim(),
                      fileName: photoDraft.fileName,
                      mime: photoDraft.mime,
                      contentBase64: photoDraft.contentBase64,
                      note: photoDraft.note.trim() || undefined,
                    });
                    const items = await fetchStaffInboundPhotos(photoDraft.shipmentId.trim());
                    setPhotoList(items);
                    setToast("入库照片已上传");
                  } catch (error) {
                    const text = error instanceof Error ? error.message : "上传失败";
                    setMessage(`上传失败：${text}`);
                  } finally {
                    setLoading(false);
                  }
                }}
                style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff", background: photoDraft.shipmentId.trim() && photoDraft.fileName && photoDraft.contentBase64 ? "#dc2626" : "#000000" }}
              >
                上传入库照片
              </button>
              <button
                type="button"
                disabled={loading}
                onClick={async () => {
                  if (!photoDraft.shipmentId.trim()) return;
                  setLoading(true);
                  try {
                    const items = await fetchStaffInboundPhotos(photoDraft.shipmentId.trim());
                    setPhotoList(items);
                  } finally {
                    setLoading(false);
                  }
                }}
                style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 14px", background: "#fff" }}
              >
                查询该运单照片
              </button>
            </div>
            {photoList.length > 0 ? (
              <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
                {photoList.map((item) => (
                  <div key={item.id} style={{ border: "1px solid #fecdd3", borderRadius: 8, padding: 8, background: "#fff" }}>
                    <div style={{ fontSize: 12, color: "#000000" }}>
                      {item.fileName} / {item.createdAt} / 操作员 {item.operatorId}
                    </div>
                    <img src={`data:${item.mime};base64,${item.contentBase64}`} alt={item.fileName} style={{ maxWidth: "100%", maxHeight: 160, marginTop: 6, borderRadius: 6 }} />
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </section>


      <section
        id="staff-order-shipment"
        style={{
          display: activeSection === "staff-order-shipment" ? "block" : "none",
          border: "1px solid #e5e7eb",
          borderLeft: "4px solid #d1d5db",
          borderRadius: 12,
          padding: 16,
          background: "#fcfcfd",
          boxShadow: "0 1px 3px rgba(15,23,42,0.06)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10, gap: 12 }}>
          <div style={{ flex: 1 }}>
            <h2 style={{ margin: 0, fontSize: 18, color: "#111827" }}>运单管理</h2>
            <p style={{ margin: "6px 0 8px", fontSize: 12, color: "#000000" }}>
              表格展示运单号、用户、状态、加收金额、运输方式、发货时间、件重体、仓库与地址；点击「查看」或 + 展开查看详情与物流轨迹。
            </p>
        <ShipmentSearch value={shipmentSearch} onChange={(key, val) => setShipmentSearch((prev) => ({ ...prev, [key]: val }))} onSearch={runShipmentListSearch} warehouseOptions={warehouseOptions} logisticsStatusOptions={logisticsStatusOptions} inputStyle={orderCreateInputStyle} />
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 2 }}>
            <button
              type="button"
              onClick={() => {
                const source = selectedForExport.size > 0 ? filteredShipmentList.filter((s) => selectedForExport.has(s.trackingNo)) : filteredShipmentList;
                if (source.length === 0) { setMessage("没有可导出的运单"); return; }
                const rows = source.map((item) => ({
                  运单号: item.trackingNo ?? "-",
                  品名: item.itemName ?? "-",
                  归属用户: item.clientName ?? item.clientId ?? "-",
                  运单状态: shipmentStatusZh(item.currentStatus),
                  加收金额: item.receivableAmountCny != null ? `${item.receivableCurrency === "THB" ? "THB" : "CNY"} ${item.receivableAmountCny}` : "0",
                  运输方式: transportModeLabel(item.transportMode),
                  发货时间: item.shipDate ?? formatDateTime(item.arrivedAt, "-"),
                  总件数: item.packageCount ?? "-",
                  总重量: item.weightKg ?? "-",
                  总体积: item.volumeM3 ?? "-",
                  计费体积: item.volumeM3 != null && item.volumeM3 > 0 ? Math.max(item.volumeM3, item.transportMode === "sea" ? 0.5 : item.transportMode === "land" ? 0.2 : 0).toFixed(3) : "-",
                  所属仓库: warehouseLabelFromId(item.warehouseId),
                  柜号: item.batchNo ?? "-",
                  国内单号: item.domesticTrackingNo ?? "-",
                  到仓日期: formatDateTime(item.arrivedAt, "-"),
                }));
                const ws = XLSX.utils.json_to_sheet(rows);
                const wb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, ws, "运单列表");
                XLSX.writeFile(wb, `运单列表_${new Date().toISOString().slice(0, 10)}.xlsx`);
                setToast(`已导出 ${rows.length} 条`);
              }}
              style={{ border: "1px solid #2563eb", borderRadius: 8, padding: "8px 16px", color: "#2563eb", background: "#fff", cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap", fontSize: 14 }}
            >
              导出Excel
            </button>
            <button
              type="button"
              onClick={() => setShowCreateModal(true)}
              style={{ border: "none", borderRadius: 8, padding: "8px 16px", color: "#fff", background: "#2563eb", cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap", fontSize: 14 }}
            >
              ＋ 创建订单
            </button>
            <button
              type="button"
              onClick={() => setShowBatchImport(true)}
              style={{ border: "1px solid #2563eb", borderRadius: 8, padding: "8px 16px", color: "#2563eb", background: "#fff", cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap", fontSize: 14 }}
            >
              批量创建
            </button>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: "#000000" }}>共 {filteredShipmentList.length} 条</span>
            <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "4px 8px", fontSize: 12 }}>
              {[20, 50, 100, 200, 500, 1000].map((n) => <option key={n} value={n}>{n}条/页</option>)}
            </select>
          </div>
        </div>
          <>
            {shipments.length === 0 ? (
              <EmptyStateCard title="暂无运单数据" description="先创建订单或等待系统分配运单后，这里会展示可操作记录。" />
            ) : filteredShipmentList.length === 0 ? (
              <EmptyStateCard title="没有匹配结果" description="请调整搜索条件后重试。" />
            ) : (
              <div
                id="staff-shipment-list-table-wrap"
                style={{ overflowX: "auto", border: "1px solid #e2e8f0", borderRadius: 10, background: "#fff" }}
              >
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 1660 }}>
                  <thead>
                    <tr style={{ background: "#f1f5f9", textAlign: "left", borderBottom: "2px solid #e2e8f0" }}>
                      <th style={{ padding: "10px 8px", width: 44 }}>
                        <input type="checkbox" checked={selectedForExport.size === filteredShipmentList.length && filteredShipmentList.length > 0} onChange={toggleSelectAll} style={{ cursor: "pointer" }} />
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
                    {pagedShipments.map((item) => (
                      <Fragment key={item.id}>
                        <tr style={{ borderBottom: "1px solid #e2e8f0", background: shipmentTableExpandedId === item.id ? "#eff6ff" : "#fff" }}>
                          <td style={{ padding: "8px 6px", verticalAlign: "middle", whiteSpace: "nowrap" }}>
                            <input type="checkbox" checked={selectedForExport.has(item.trackingNo)} onChange={() => toggleSelectShipment(item.trackingNo)} style={{ cursor: "pointer", marginRight: 4 }} />
                            <button
                              type="button"
                              onClick={() => {
                                setShipmentTableExpandedId((prev) => {
                                  if (prev === item.id) return null;
                                  setShipmentOrderEditDrafts((d) => ({ ...d, [item.id]: buildShipmentOrderEditDraft(item) }));
                                  const oid = item.orderId;
                                  if (oid) {
                                    fetchShipmentImages(oid).then((imgs) => {
                                      setShipmentImagesCache((c) => ({ ...c, [oid]: imgs }));
                                    }).catch(() => {});
                                  }
                                  return item.id;
                                });
                              }}
                              style={{
                                border: "1px solid #cbd5e1",
                                borderRadius: 6,
                                width: 28,
                                height: 28,
                                background: "#fff",
                                cursor: "pointer",
                                fontSize: 16,
                                lineHeight: 1,
                                color: "#0f172a",
                              }}
                              aria-label={shipmentTableExpandedId === item.id ? "收起详情" : "展开详情"}
                            >
                              {shipmentTableExpandedId === item.id ? "−" : "+"}
                            </button>
                          </td>
                          <td style={{ padding: "8px 6px", fontWeight: 600, color: "#6b21a8", whiteSpace: "nowrap", fontFamily: "monospace", fontSize: 12 }}>{item.clientId ?? "—"}</td>
                          <td style={{ padding: "8px 6px", fontWeight: 600, color: "#1e3a8a", whiteSpace: "nowrap" }}>{item.orderNo || item.trackingNo}</td>
                          <td style={{ padding: "8px 6px", color: "#000000", minWidth: 120 }}>
                            {(item.products?.length ?? 0) > 0
                              ? item.products!.map((p, i) => (
                                  <div key={i} style={{ marginBottom: i < (item.products?.length ?? 0) - 1 ? 2 : 0, whiteSpace: "nowrap" }}>
                                    {p.itemName}
                                  </div>
                                ))
                              : (item.itemName ?? "—")}
                          </td>
                          <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>
                            {(item.products?.length ?? 0) > 0
                              ? item.products!.map((p, i) => (
                                  <div key={i} style={{ marginBottom: i < (item.products?.length ?? 0) - 1 ? 2 : 0 }}>
                                    {p.packageCount}箱
                                  </div>
                                ))
                              : "—"}
                          </td>
                          <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>
                            {(item.products?.length ?? 0) > 0
                              ? item.products!.map((p, i) => (
                                  <div key={i} style={{ marginBottom: i < (item.products?.length ?? 0) - 1 ? 2 : 0 }}>
                                    {p.productQuantity ? `${p.productQuantity}个/箱` : "—"}
                                  </div>
                                ))
                              : "—"}
                          </td>
                          <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>
                            {(item.products?.length ?? 0) > 0
                              ? item.products!.map((p, i) => (
                                  <div key={i} style={{ marginBottom: i < (item.products?.length ?? 0) - 1 ? 2 : 0 }}>
                                    {p.lengthCm ? `${p.lengthCm}×${p.widthCm}×${p.heightCm}cm` : "—"}
                                  </div>
                                ))
                              : "—"}
                          </td>
                          <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>
                            {(item.products?.length ?? 0) > 0
                              ? item.products!.map((p, i) => (
                                  <div key={i} style={{ marginBottom: i < (item.products?.length ?? 0) - 1 ? 2 : 0 }}>
                                    {p.domesticTrackingNo || "货拉拉"}
                                  </div>
                                ))
                              : (item.domesticTrackingNo || "—")}
                          </td>
                          <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>{formatMetric(item.volumeM3, 6)}</td>
                          <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>{formatMetric(item.weightKg, 2)}</td>
                          <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>{transportModeLabel(item.transportMode)}</td>
                          <td style={{ padding: "8px 6px", whiteSpace: "nowrap", fontSize: 12 }}>
                            {(item.products?.length ?? 0) > 0
                              ? item.products!.map((p, i) => (
                                  <div key={i} style={{ marginBottom: i < (item.products?.length ?? 0) - 1 ? 2 : 0 }}>
                                    {(p.cargoType ?? "NORMAL") === "INSPECTION" ? "商检" : (p.cargoType ?? "NORMAL") === "SENSITIVE" ? "敏感" : "普货"}
                                  </div>
                                ))
                              : (item.cargoType === "INSPECTION" ? "商检" : item.cargoType === "SENSITIVE" ? "敏感" : "普货")}
                          </td>
                          <td style={{ padding: "8px 6px", whiteSpace: "nowrap", color: "#000000" }}>
                            {item.shipDate ?? formatDateTime(item.arrivedAt)}
                          </td>
                          <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>
                            <button
                              type="button"
                              onClick={() => {
                                setShipmentTableExpandedId((prev) => {
                                  if (prev === item.id) return null;
                                  setShipmentOrderEditDrafts((d) => ({ ...d, [item.id]: buildShipmentOrderEditDraft(item) }));
                                  return item.id;
                                });
                              }}
                              style={{
                                border: "none",
                                background: "transparent",
                                color: "#2563eb",
                                cursor: "pointer",
                                fontWeight: 600,
                                padding: 0,
                                marginRight: 8,
                              }}
                            >
                              查看
                            </button>
                            <button
                              type="button"
                              onClick={() => openShipmentTrack(item.trackingNo)}
                              style={{ border: "none", background: "transparent", color: "#2563eb", cursor: "pointer", fontWeight: 600, padding: 0 }}
                            >
                              物流轨迹
                            </button>
                            <button
                              type="button"
                              onClick={() => openPrintLabel({ marks: item.clientName ?? item.clientId ?? "—", packageCount: item.packageCount ?? "—", trackingNo: item.trackingNo ?? "", itemName: item.itemName, productQuantity: item.productQuantity, transportMode: item.transportMode, products: item.products?.map(p => ({ itemName: p.itemName, packageCount: p.packageCount })) })}
                              style={{ border: "none", background: "transparent", color: "#16a34a", cursor: "pointer", fontWeight: 600, padding: 0, marginLeft: 8 }}
                            >
                              打印
                            </button>
                          </td>
                        </tr>
                        {shipmentTableExpandedId === item.id ? (
                          <tr>
                            <td colSpan={14} style={{ padding: 0, background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                              <div style={{ padding: 14 }}>
                                {/* 隐藏信息栏 */}
                                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 20px", marginBottom: 12, padding: 8, background: "#f1f5f9", borderRadius: 6, fontSize: 12 }}>
                                  <span>仓库：<strong>{warehouseLabelFromId(item.warehouseId)}</strong></span>
                                  <span>柜号：<strong>{item.batchNo ?? "—"}</strong></span>
                                  <span>包装：<strong>{item.packageUnit === "bag" ? "袋" : "箱"}</strong></span>
                                  <span>国内单号：<strong>{(item.products?.length ?? 0) > 0 ? item.products!.map(p => p.domesticTrackingNo ?? "货拉拉").filter((v, i, a) => a.indexOf(v) === i).join("、") : (item.domesticTrackingNo ?? "—")}</strong></span>
                                  <span>加收金额：<strong>{item.receivableAmountCny != null ? `${item.receivableCurrency === "THB" ? "THB" : "CNY"} ${item.receivableAmountCny.toFixed(2)}` : "0"}</strong></span>
                                  <span>收货地址：<strong>{item.receiverAddressTh ?? "—"}</strong></span>
                                </div>
                                <div style={{ fontWeight: 700, marginBottom: 12, color: "#0f172a" }}>运单详情（只读）</div>
                                {(() => {
                                  const draft = shipmentOrderEditDrafts[item.id] ?? buildShipmentOrderEditDraft(item);
                                  /** 员工端运单列表统一只读，禁止在此处修改任何字段。 */
                                  const formDisabled = true;
                                  const inputInCard = { ...orderCreateInputStyle, marginBottom: 0 } as const;
                                  const currentShipmentStatus = item.currentStatus?.trim() || "created";
                                  const statusTargets = getValidShipmentStatusTargets(currentShipmentStatus);
                                  return (
                                    <>
                                      {!item.orderId ? (
                                        <div
                                          style={{
                                            color: "#b45309",
                                            fontSize: 13,
                                            marginBottom: 8,
                                            display: "flex",
                                            flexWrap: "wrap",
                                            gap: 8,
                                            alignItems: "center",
                                          }}
                                        >
                                          <span>当前运单未关联订单，请联系管理员在管理端处理订单关联。</span>
                                        </div>
                                      ) : null}
                                      <div
                                        style={{
                                          display: "flex",
                                          flexWrap: "wrap",
                                          gap: 20,
                                          alignItems: "flex-start",
                                          marginBottom: 12,
                                        }}
                                      >
                                        <div style={{ flex: "1 1 300px", display: "flex", flexDirection: "column", gap: 12 }}>
                                          {(item.products?.length ?? 0) > 1 && (
                                        <div style={{ marginBottom: 12, background: "#fefce8", borderRadius: 6, padding: "8px 10px", fontSize: 12 }}>
                                          <span style={{ fontWeight: 600, color: "#000000" }}>产品列表：</span>
                                          {item.products!.map((p) => (
                                            <span key={p.id} style={{ marginLeft: 8, color: "#000000" }}>
                                              {p.itemName} ×{p.packageCount}箱
                                              {p.lengthCm ? ` (${p.lengthCm}×${p.widthCm}×${p.heightCm}cm)` : ""}
                                              {p.productQuantity ? `，${p.productQuantity}个/箱` : ""}
                                              {" | "}
                                            </span>
                                          ))}
                                        </div>
                                      )}
                                      <ShipmentEditFormField label="运单号" required>
                                            <input
                                              value={draft.trackingNo}
                                              onChange={(e) => mergeShipmentOrderDraft(item.id, item, { trackingNo: e.target.value })}
                                              disabled={formDisabled}
                                              style={inputInCard}
                                            />
                                          </ShipmentEditFormField>
                                          <ShipmentEditFormField label="所属仓库" required>
                                            <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                                              {warehouseOptions.map((w) => (
                                                <label
                                                  key={w.id}
                                                  style={{
                                                    display: "flex",
                                                    alignItems: "center",
                                                    gap: 6,
                                                    cursor: formDisabled ? "not-allowed" : "pointer",
                                                    fontSize: 13,
                                                    color: "#000000",
                                                  }}
                                                >
                                                  <input
                                                    type="radio"
                                                    name={`ship-wh-${item.id}`}
                                                    checked={draft.warehouseId === w.id}
                                                    disabled={formDisabled}
                                                    onChange={() => mergeShipmentOrderDraft(item.id, item, { warehouseId: w.id })}
                                                  />
                                                  {w.label}
                                                </label>
                                              ))}
                                            </div>
                                          </ShipmentEditFormField>
                                          <ShipmentEditFormField label="品名" required>
                                            <input
                                              value={draft.itemName}
                                              onChange={(e) => mergeShipmentOrderDraft(item.id, item, { itemName: e.target.value })}
                                              disabled={formDisabled}
                                              style={inputInCard}
                                            />
                                          </ShipmentEditFormField>
                                          <ShipmentEditFormField label="国内单号">
                                            <input
                                              value={draft.domesticTrackingNo}
                                              onChange={(e) =>
                                                mergeShipmentOrderDraft(item.id, item, { domesticTrackingNo: e.target.value })
                                              }
                                              disabled={formDisabled}
                                              style={inputInCard}
                                            />
                                          </ShipmentEditFormField>
                                          <ShipmentEditFormField label="收货地址（泰国）" required>
                                            <textarea
                                              value={draft.receiverAddressTh}
                                              onChange={(e) =>
                                                mergeShipmentOrderDraft(item.id, item, { receiverAddressTh: e.target.value })
                                              }
                                              disabled={formDisabled}
                                              rows={2}
                                              placeholder="请选择或填写收货地址"
                                              style={{ ...inputInCard, resize: "vertical", minHeight: 48 }}
                                            />
                                          </ShipmentEditFormField>
                                          <ShipmentEditFormField label="发货时间">
                                            <input
                                              type="datetime-local"
                                              value={draft.shipLocal}
                                              onChange={(e) => mergeShipmentOrderDraft(item.id, item, { shipLocal: e.target.value })}
                                              disabled={formDisabled}
                                              style={inputInCard}
                                            />
                                          </ShipmentEditFormField>
                                          <ShipmentEditFormField label="到仓日期">
                                            <input
                                              type="date"
                                              value={draft.orderCreatedDate}
                                              onChange={(e) =>
                                                mergeShipmentOrderDraft(item.id, item, { orderCreatedDate: e.target.value })
                                              }
                                              disabled={formDisabled}
                                              style={inputInCard}
                                            />
                                          </ShipmentEditFormField>
                                          <ShipmentEditFormField label="运单状态">
                                            <select
                                              value={currentShipmentStatus}
                                              disabled={true}
                                              style={inputInCard}
                                            >
                                              {statusTargets.map((st) => (
                                                <option key={st} value={st}>
                                                  {shipmentStatusZh(st)}
                                                </option>
                                              ))}
                                            </select>
                                          </ShipmentEditFormField>
                                          <ShipmentEditFormField label="是否报关">
                                            <div style={{ display: "flex", gap: 16 }}>
                                              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: formDisabled ? "not-allowed" : "pointer" }}>
                                                <input
                                                  type="radio"
                                                  name={`cust-${item.id}`}
                                                  checked={draft.customsDeclaration === "none"}
                                                  disabled={formDisabled}
                                                  onChange={() =>
                                                    mergeShipmentOrderDraft(item.id, item, { customsDeclaration: "none" })
                                                  }
                                                />
                                                不报关
                                              </label>
                                              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: formDisabled ? "not-allowed" : "pointer" }}>
                                                <input
                                                  type="radio"
                                                  name={`cust-${item.id}`}
                                                  checked={draft.customsDeclaration === "declare"}
                                                  disabled={formDisabled}
                                                  onChange={() =>
                                                    mergeShipmentOrderDraft(item.id, item, { customsDeclaration: "declare" })
                                                  }
                                                />
                                                报关
                                              </label>
                                            </div>
                                          </ShipmentEditFormField>
                                          <ShipmentEditFormField label="支付状态">
                                            <select
                                              value={draft.paymentStatus}
                                              disabled={formDisabled || !item.orderId}
                                              style={inputInCard}
                                              onChange={async (e) => {
                                                const v = e.target.value as "paid" | "unpaid";
                                                if (v === "paid") {
                                                  setMessage("标记为已付款需上传付款凭证，请使用订单管理中的付款操作后再标记。");
                                                  return;
                                                }
                                                if (!item.orderId) return;
                                                setLoading(true);
                                                setMessage("");
                                                try {
                                                  await setStaffOrderPayment({ orderId: item.orderId, paymentStatus: "unpaid" });
                                                  const items = await loadPageData();
                                                  const u = items.find((s) => s.id === item.id);
                                                  if (u) {
                                                    setShipmentOrderEditDrafts((prev) => ({
                                                      ...prev,
                                                      [item.id]: buildShipmentOrderEditDraft(u),
                                                    }));
                                                  }
                                                  setToast("支付状态已更新为未支付");
                                                } catch (error) {
                                                  const text = error instanceof Error ? error.message : "更新失败";
                                                  setMessage(`支付状态更新失败：${text}`);
                                                } finally {
                                                  setLoading(false);
                                                }
                                              }}
                                            >
                                              <option value="unpaid">未支付</option>
                                              <option value="paid">已支付</option>
                                            </select>
                                          </ShipmentEditFormField>
                                          <ShipmentEditFormField label="目的国家">
                                            <select
                                              value={draft.destinationCountry}
                                              onChange={(e) =>
                                                mergeShipmentOrderDraft(item.id, item, { destinationCountry: e.target.value })
                                              }
                                              disabled={formDisabled}
                                              style={inputInCard}
                                            >
                                              <option value="泰国">泰国</option>
                                              <option value="越南">越南</option>
                                              <option value="印尼">印尼</option>
                                              <option value="其他">其他</option>
                                            </select>
                                          </ShipmentEditFormField>
                                          <ShipmentEditFormField label="总体积 (m³)">
                                            <input
                                              value={draft.volumeM3}
                                              onChange={(e) => mergeShipmentOrderDraft(item.id, item, { volumeM3: e.target.value })}
                                              disabled={formDisabled}
                                              style={inputInCard}
                                              placeholder="如 0.08"
                                            />
                                          </ShipmentEditFormField>
                                          <ShipmentEditFormField label="计费体积 (m³)">
                                            <input
                                              value={draft.volumeM3}
                                              onChange={(e) => mergeShipmentOrderDraft(item.id, item, { volumeM3: e.target.value })}
                                              disabled={formDisabled}
                                              style={inputInCard}
                                              placeholder="与总体积一致时可填相同值"
                                            />
                                          </ShipmentEditFormField>
                                          <ShipmentEditFormField label="加收金额">
                                            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                                              <input
                                                value={draft.receivableAmountCny}
                                                onChange={(e) =>
                                                  mergeShipmentOrderDraft(item.id, item, { receivableAmountCny: e.target.value })
                                                }
                                                disabled={formDisabled}
                                                style={{ ...inputInCard, flex: 1 }}
                                                placeholder="0"
                                              />
                                              <select
                                                value={draft.receivableCurrency}
                                                onChange={(e) =>
                                                  mergeShipmentOrderDraft(item.id, item, {
                                                    receivableCurrency: e.target.value as "CNY" | "THB",
                                                  })
                                                }
                                                disabled={formDisabled}
                                                style={{ ...inputInCard, flex: 0, minWidth: 72 }}
                                              >
                                                <option value="CNY">CNY</option>
                                                <option value="THB">THB</option>
                                              </select>
                                            </div>
                                          </ShipmentEditFormField>
                                          <ShipmentEditFormField label="柜号">
                                            <input
                                              value={draft.batchNo}
                                              onChange={(e) => mergeShipmentOrderDraft(item.id, item, { batchNo: e.target.value })}
                                              disabled={formDisabled}
                                              style={inputInCard}
                                            />
                                          </ShipmentEditFormField>
                                        </div>
                                        <div style={{ flex: "1 1 300px", display: "flex", flexDirection: "column", gap: 12 }}>
                                          <ShipmentEditFormField label="运单所属用户" required>
                                            <input
                                              value={item.clientName ?? item.clientId ?? "—"}
                                              readOnly
                                              style={{ ...inputInCard, color: "#000000", background: "#f8fafc" }}
                                            />
                                          </ShipmentEditFormField>
                                          <ShipmentEditFormField label="运输方式" required>
                                            <select
                                              value={draft.transportMode}
                                              onChange={(e) =>
                                                mergeShipmentOrderDraft(item.id, item, {
                                                  transportMode: e.target.value as "sea" | "land",
                                                })
                                              }
                                              disabled={formDisabled}
                                              style={inputInCard}
                                            >
                                              <option value="sea">海运</option>
                                              <option value="land">陆运</option>
                                            </select>
                                          </ShipmentEditFormField>
                                          <ShipmentEditFormField label="包裹数量 / 单位">
                                            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                                              <input
                                                type="number"
                                                min={0}
                                                value={draft.packageCount}
                                                onChange={(e) =>
                                                  mergeShipmentOrderDraft(item.id, item, { packageCount: e.target.value })
                                                }
                                                disabled={formDisabled}
                                                style={{ ...inputInCard, flex: 1 }}
                                              />
                                              <select
                                                value={draft.packageUnit}
                                                onChange={(e) =>
                                                  mergeShipmentOrderDraft(item.id, item, {
                                                    packageUnit: e.target.value as "bag" | "box",
                                                  })
                                                }
                                                disabled={formDisabled}
                                                style={{ ...inputInCard, flex: 0, minWidth: 88 }}
                                              >
                                                <option value="box">箱</option>
                                                <option value="bag">袋</option>
                                              </select>
                                            </div>
                                          </ShipmentEditFormField>
                                          <ShipmentEditFormField label="产品数量">
                                            <input
                                              type="number"
                                              min={0}
                                              value={draft.productQuantity}
                                              onChange={(e) =>
                                                mergeShipmentOrderDraft(item.id, item, { productQuantity: e.target.value })
                                              }
                                              disabled={formDisabled}
                                              style={inputInCard}
                                            />
                                          </ShipmentEditFormField>
                                          <ShipmentEditFormField label="总件数">
                                            <input
                                              type="number"
                                              min={0}
                                              value={draft.packageCount}
                                              onChange={(e) =>
                                                mergeShipmentOrderDraft(item.id, item, { packageCount: e.target.value })
                                              }
                                              disabled={formDisabled}
                                              style={inputInCard}
                                            />
                                          </ShipmentEditFormField>
                                          <ShipmentEditFormField label="总重量 (kg)">
                                            <input
                                              value={draft.weightKg}
                                              onChange={(e) => mergeShipmentOrderDraft(item.id, item, { weightKg: e.target.value })}
                                              disabled={formDisabled}
                                              style={inputInCard}
                                              placeholder="如 14.1"
                                            />
                                          </ShipmentEditFormField>
                                          <ShipmentEditFormField label="装柜号">
                                            <input
                                              value={draft.containerNo}
                                              onChange={(e) => mergeShipmentOrderDraft(item.id, item, { containerNo: e.target.value })}
                                              disabled={formDisabled}
                                              style={inputInCard}
                                            />
                                          </ShipmentEditFormField>
                                          <ShipmentEditFormField label="签收单">
                                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                              <input
                                                type="file"
                                                accept="image/*"
                                                style={{ fontSize: 12, color: "#000000" }}
                                                onChange={async (ev) => {
                                                  const f = ev.target.files?.[0] ?? null;
                                                  ev.target.value = "";
                                                  if (!f || !f.type.startsWith("image/")) {
                                                    if (f) setMessage("签收单请上传图片文件。");
                                                    return;
                                                  }
                                                  setLoading(true);
                                                  setMessage("");
                                                  try {
                                                    const contentBase64 = await readFileAsBase64(f);
                                                    await uploadStaffInboundPhoto({
                                                      shipmentId: item.id,
                                                      fileName: f.name,
                                                      mime: f.type || "image/jpeg",
                                                      contentBase64,
                                                      note: "签收单",
                                                    });
                                                    setToast("签收单已上传");
                                                  } catch (error) {
                                                    const text = error instanceof Error ? error.message : "上传失败";
                                                    setMessage(`签收单上传失败：${text}`);
                                                  } finally {
                                                    setLoading(false);
                                                  }
                                                }}
                                              />
                                              <span style={{ fontSize: 11, color: "#000000" }}>上传后写入入库拍照记录</span>
                                            </div>
                                          </ShipmentEditFormField>
                                          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                                            <InfoItem label="可编辑" value={item.canEdit ? "是" : "否"} />
                                            <InfoItem label="更新时间" value={item.updatedAt ?? "-"} />
                                          </div>
                                        </div>
                                      </div>
                                    </>
                                  );
                                })()}
                                {item.orderId ? (
                                  <OrderProductImagesPanel
                                    orderId={item.orderId}
                                    images={item.productImages ?? shipmentImagesCache[item.orderId] ?? []}
                                    canManage={true}
                                    busy={loading}
                                    onSelectFile={(file) => uploadOrderProductImageAndReload(item.orderId!, file)}
                                    onDelete={(imageId) => deleteOrderProductImageAndReload(imageId)}
                                  />
                                ) : null}
                                <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                                  {item.canEdit ? (
                                    <>
                                      <button
                                        type="button"
                                        disabled={loading || !item.orderId}
                                        onClick={() => void saveShipmentOrderEdit(item.id)}
                                        style={{
                                          border: "none",
                                          borderRadius: 8,
                                          padding: "8px 14px",
                                          color: "#fff",
                                          background: item.orderId ? "#059669" : "#000000",
                                          cursor: item.orderId ? "pointer" : "not-allowed",
                                          fontWeight: 600,
                                        }}
                                      >
                                        保存订单信息
                                      </button>
                                    </>
                                  ) : null}
                                  <button
                                    type="button"
                                    disabled={loading}
                                    onClick={() => setShipmentTableExpandedId(null)}
                                    style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "8px 14px", background: "#fff", color: "#000000" }}
                                  >
                                    收起
                                  </button>
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
            )}
          </>
      </section>

      <section
        id="staff-lastmile"
        style={{
          display: activeSection === "staff-lastmile" ? "block" : "none",
          border: "1px solid #e5e7eb",
          borderLeft: "4px solid #d1d5db",
          borderRadius: 12,
          padding: 16,
          marginBottom: 18,
          background: "#fcfcfd",
          boxShadow: "0 1px 3px rgba(15,23,42,0.06)",
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: 18, color: "#111827", marginBottom: 12 }}>尾端派送</h2>

        {/* 创建派送单 */}
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 12, marginBottom: 16, background: "#f8fafc" }}>
          <h4 style={{ margin: "0 0 8px", fontSize: 14 }}>创建派送单（一车多单，逗号分隔）</h4>
          <div style={{ display: "grid", gap: 6 }}>
            <div style={{ border: "1px solid #e5e7eb", borderRadius: 6, padding: 8, background: "#fff" }}>
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
            <div style={{ display: "flex", gap: 6 }}>
              <input value={lmDriverName} onChange={e => setLmDriverName(e.target.value)} placeholder="司机姓名" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 8px", fontSize: 12, flex: 1 }} />
              <input value={lmLicensePlate} onChange={e => setLmLicensePlate(e.target.value)} placeholder="车牌号" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 8px", fontSize: 12, flex: 1 }} />
              <input value={lmPhoneNumber} onChange={e => setLmPhoneNumber(e.target.value)} placeholder="电话" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 8px", fontSize: 12, flex: 1 }} />
            </div>
            <button disabled={lmSelected.size===0} onClick={async () => {
              const ids = Array.from(lmSelected);
              if (ids.length===0) return;
              try {
                const r = await fetch(apiBaseUrl()+"/admin/lastmile/orders",{method:"POST",headers:{"Content-Type":"application/json",...authHeaders()},body:JSON.stringify({shipmentIds:ids,driverName:lmDriverName.trim(),licensePlate:lmLicensePlate.trim(),phoneNumber:lmPhoneNumber.trim()})});
                const d = await r.json();
                if (d.code!=="OK") throw new Error(d.message||"创建失败");
                setToast(`派送单 ${d.data.deliveryNo} 已创建（${d.data.count}个运单）`);
                setLmSelected(new Set());setLmDriverName("");setLmLicensePlate("");setLmPhoneNumber("");
                loadLmOrders();
              } catch(e:any) { setToast(e.message||"创建失败"); }
            }} style={{ border: "none", borderRadius: 6, padding: "6px 14px", background: "#2563eb", color: "#fff", cursor: "pointer", fontSize: 12, justifySelf: "start" }}>创建派送单</button>
          </div>
        </div>

        {/* 派送列表 */}
        {lmOrderList.length > 0 && (
          <div style={{ overflowX: "auto", marginBottom: 16 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead><tr style={{ borderBottom: "2px solid #e2e8f0", textAlign: "left" }}>
                <th style={{ padding: "4px 6px" }}>派送单号</th><th style={{ padding: "4px 6px" }}>运单号</th><th style={{ padding: "4px 6px" }}>司机</th><th style={{ padding: "4px 6px" }}>车牌</th><th style={{ padding: "4px 6px" }}>电话</th><th style={{ padding: "4px 6px" }}>状态</th><th style={{ padding: "4px 6px" }}>操作</th>
              </tr></thead>
              <tbody>
                {lmOrderList.map(o => (
                  <tr key={o.id} style={{ borderBottom: "1px solid #e2e8f0" }}>
                    <td style={{ padding: "4px 6px", fontFamily: "monospace", fontSize: 11 }}>{o.deliveryNo}</td>
                    <td style={{ padding: "4px 6px", fontFamily: "monospace" }}>{o.shipmentId}</td>
                    <td style={{ padding: "4px 6px" }}>{o.driverName ?? "-"}</td>
                    <td style={{ padding: "4px 6px" }}>{o.licensePlate ?? "-"}</td>
                    <td style={{ padding: "4px 6px" }}>{o.phoneNumber ?? "-"}</td>
                    <td style={{ padding: "4px 6px" }}>{o.status==="SIGNED"?"✅已签收":"🚚派送中"}</td>
                    <td style={{ padding: "4px 6px" }}>{o.status!=="SIGNED"&&(
                      <><button onClick={async ()=>{try{await fetch(apiBaseUrl()+"/admin/lastmile/status",{method:"POST",headers:{"Content-Type":"application/json",...authHeaders()},body:JSON.stringify({id:o.id,status:"SIGNED"})});setToast("已签收");loadLmOrders()}catch(e:any){setToast(e.message||"失败")}}} style={{ border: "1px solid #16a34a", borderRadius: 4, padding: "2px 6px", fontSize: 11, background: "#fff", color: "#16a34a", cursor: "pointer" }}>签收</button>
                      <button onClick={async ()=>{if(!confirm("确定删除？"))return;try{await fetch(apiBaseUrl()+"/admin/lastmile/orders?id="+o.id,{method:"DELETE",headers:authHeaders()});setToast("已删除");loadLmOrders()}catch(e:any){setToast(e.message||"失败")}}} style={{ border: "1px solid #fca5a5", borderRadius: 4, padding: "2px 4px", fontSize: 11, background: "#fff", color: "#dc2626", cursor: "pointer", marginLeft: 4 }}>删除</button></>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p style={{ fontSize: 12, color: "#000000", marginBottom: 10 }}>所有客户唛头及派送地址，支持按唛头或客户名搜索。</p>
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <input
            value={lastmileKeyword}
            onChange={(e) => setLastmileKeyword(e.target.value)}
            placeholder="搜索唛头或客户名"
            style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", fontSize: 13, flex: 1 }}
          />
          <button
            type="button"
            disabled={lastmileLoading}
            onClick={() => { setLastmileKeyword(""); void loadLastmileAddresses(""); }}
            style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 12px", fontSize: 13, background: "#fff", color: "#000000", cursor: "pointer" }}
          >
            重置
          </button>
        </div>
        {lastmileLoading ? (
          <div style={{ color: "#000000", fontSize: 13, padding: "20px 0", textAlign: "center" }}>加载中…</div>
        ) : lastmileItems.length === 0 ? (
          <div style={{ color: "#000000", fontSize: 13, padding: "20px 0", textAlign: "center" }}>暂无客户数据</div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {lastmileItems.filter((c) => !lastmileKeyword || c.id.toLowerCase().includes(lastmileKeyword.toLowerCase()) || c.name.toLowerCase().includes(lastmileKeyword.toLowerCase())).map((client) => (
              <div key={client.id} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: 12, background: "#fff" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <div>
                    <span style={{ fontWeight: 700, fontSize: 15, color: "#6b21a8", fontFamily: "monospace" }}>{client.id}</span>
                    <span style={{ marginLeft: 8, fontSize: 13, color: "#000000" }}>{client.name}</span>
                  </div>
                  <span style={{ fontSize: 12, color: "#000000" }}>{client.phone}</span>
                </div>
                {client.addresses.length === 0 ? (
                  <div style={{ fontSize: 12, color: "#000000" }}>暂无地址</div>
                ) : (
                  client.addresses.map((addr) => (
                    <div key={addr.id} style={{ padding: "6px 8px", background: "#f8fafc", borderRadius: 6, marginBottom: 4, border: addr.isDefault ? "1px solid #bbf7d0" : "1px solid #f1f5f9", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 12, color: "#000000" }}>
                          {addr.isDefault ? <span style={{ color: "#16a34a", fontWeight: 600 }}>［默认］</span> : null}
                          {addr.contactName} ｜ {addr.contactPhone}
                        </div>
                        <div style={{ fontSize: 11, color: "#000000", marginTop: 2 }}>{addr.addressDetail}</div>
                      </div>
                      <div style={{ display: "flex", gap: 4, flexShrink: 0, marginLeft: 8 }}>
                        <button type="button" onClick={() => {
                          if (!confirm("确定删除该地址？")) return;
                          deleteAddr(addr.id);
                        }} style={{ border: "1px solid #fca5a5", borderRadius: 4, padding: "2px 5px", fontSize: 10, background: "#fff", color: "#dc2626", cursor: "pointer" }}>删除</button>
                      </div>
                    </div>
                  ))
                )}
                {/* 操作按钮 */}
                <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                  <button type="button" onClick={() => { setShowAddAddress(client.id); setAddrForm({ contactName: "", contactPhone: "", addressDetail: "", label: "" }); }} style={{ border: "1px solid #2563eb", borderRadius: 4, padding: "4px 8px", fontSize: 11, background: "#eff6ff", color: "#2563eb", cursor: "pointer" }}>＋ 添加地址</button>
                  <button type="button" onClick={() => setEditingNote({ clientId: client.id, content: clientNotes[client.id]?.content ?? "" })} style={{ border: "1px solid #8b5cf6", borderRadius: 4, padding: "4px 8px", fontSize: 11, background: "#f5f3ff", color: "#8b5cf6", cursor: "pointer" }}>✎ 编辑备注</button>
                </div>
                {/* 添加地址表单 */}
                {showAddAddress === client.id && (
                  <div style={{ marginTop: 6, padding: 8, background: "#f0f9ff", borderRadius: 6, border: "1px solid #bae6fd" }}>
                    <div style={{ display: "grid", gap: 4 }}>
                      <input value={addrForm.contactName} onChange={(e) => setAddrForm((v) => ({ ...v, contactName: e.target.value }))} placeholder="联系人姓名" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "4px 6px", fontSize: 11 }} />
                      <input value={addrForm.contactPhone} onChange={(e) => setAddrForm((v) => ({ ...v, contactPhone: e.target.value }))} placeholder="联系电话" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "4px 6px", fontSize: 11 }} />
                      <input value={addrForm.addressDetail} onChange={(e) => setAddrForm((v) => ({ ...v, addressDetail: e.target.value }))} placeholder="详细地址" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "4px 6px", fontSize: 11 }} />
                      <input value={addrForm.label} onChange={(e) => setAddrForm((v) => ({ ...v, label: e.target.value }))} placeholder="标签（可选，如：公司/家）" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "4px 6px", fontSize: 11 }} />
                      <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                        <button type="button" onClick={() => setShowAddAddress(null)} style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "3px 8px", fontSize: 11, background: "#fff", cursor: "pointer" }}>取消</button>
                        <button type="button" onClick={() => saveAddr(client.id)} style={{ border: "none", borderRadius: 4, padding: "3px 8px", fontSize: 11, background: "#2563eb", color: "#fff", cursor: "pointer" }}>保存</button>
                      </div>
                    </div>
                  </div>
                )}
                {/* 编辑备注表单 */}
                {editingNote?.clientId === client.id && (
                  <div style={{ marginTop: 6, padding: 8, background: "#faf5ff", borderRadius: 6, border: "1px solid #e9d5ff" }}>
                    <textarea value={editingNote.content} onChange={(e) => setEditingNote((v) => v ? { ...v, content: e.target.value } : null)} rows={3} placeholder="输入备注..." style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "4px 6px", fontSize: 11, width: "100%", resize: "vertical" }} />
                    <div style={{ display: "flex", gap: 4, justifyContent: "flex-end", marginTop: 4 }}>
                      <button type="button" onClick={() => setEditingNote(null)} style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "3px 8px", fontSize: 11, background: "#fff", cursor: "pointer" }}>取消</button>
                      <button type="button" onClick={() => saveNote(client.id, editingNote.content)} style={{ border: "none", borderRadius: 4, padding: "3px 8px", fontSize: 11, background: "#8b5cf6", color: "#fff", cursor: "pointer" }}>保存</button>
                    </div>
                  </div>
                )}
                {/* 备注（只读） */}
                <div style={{ marginTop: 8, borderTop: "1px solid #e5e7eb", paddingTop: 8 }}>
                  <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4 }}>备注</div>
                  <div style={{ fontSize: 12, color: clientNotes[client.id]?.content ? "#000000" : "#9ca3af", whiteSpace: "pre-wrap" }}>
                    {clientNotes[client.id]?.content || "暂无备注"}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {message ? <p style={{ marginTop: 12, color: message.includes("失败") ? "#b91c1c" : "#065f46" }}>{message}</p> : null}
      <Toast open={toast.length > 0} message={toast} />
      {/* 预报单审核弹窗 */}
      {approvingPrealert && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)", padding: 16 }}>
          <div style={{ width: "100%", maxWidth: 560, maxHeight: "90vh", overflow: "auto", background: "#fff", borderRadius: 12, padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
            <h3 style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 600 }}>审核预报单</h3>
            <div style={{ color: "#000000", fontSize: 13, marginBottom: 12 }}>
              客户：{approvingPrealert.clientName ?? "-"} · {approvingPrealert.createdAt.slice(0, 10)}
            </div>
            {(approvingPrealert.products?.length ?? 0) > 1 && (
              <div style={{ marginBottom: 10, background: "#fefce8", borderRadius: 6, padding: "8px 10px", fontSize: 12 }}>
                <div style={{ fontWeight: 600, marginBottom: 4, color: "#000000" }}>产品列表</div>
                {approvingPrealert.products!.map((p) => (
                  <div key={p.id} style={{ color: "#000000" }}>{p.itemName} ×{p.packageCount}箱{p.lengthCm ? ` (${p.lengthCm}×${p.widthCm}×${p.heightCm}cm)` : ""}</div>
                ))}
              </div>
            )}
            <div style={{ display: "grid", gap: 6, fontSize: 13, color: "#000000", marginBottom: 16 }}>
              <div>仓库：{warehouseOptions.find((w) => w.id === (prealertEditDrafts[approvingPrealert.id]?.warehouseId ?? approvingPrealert.warehouseId))?.label ?? "-"}</div>
              <div>品名：{prealertEditDrafts[approvingPrealert.id]?.itemName ?? approvingPrealert.itemName}</div>
              <div>件数：{prealertEditDrafts[approvingPrealert.id]?.packageCount ?? approvingPrealert.packageCount} {prealertEditDrafts[approvingPrealert.id]?.packageUnit ?? approvingPrealert.packageUnit}</div>
              <div>产品数量：{prealertEditDrafts[approvingPrealert.id]?.productQuantity ?? approvingPrealert.productQuantity}</div>
              <div>重量：{prealertEditDrafts[approvingPrealert.id]?.weightKg ?? approvingPrealert.weightKg ?? "-"} kg</div>
              <div>体积：{prealertEditDrafts[approvingPrealert.id]?.volumeM3 ?? approvingPrealert.volumeM3 ?? "-"} m³</div>
              <div>国内单号：{prealertEditDrafts[approvingPrealert.id]?.domesticTrackingNo ?? approvingPrealert.domesticTrackingNo ?? "-"}</div>
              <div>运输方式：{(prealertEditDrafts[approvingPrealert.id]?.transportMode ?? approvingPrealert.transportMode) === "sea" ? "海运" : "陆运"}</div>
              <div>发货日期：{prealertEditDrafts[approvingPrealert.id]?.shipDate ?? approvingPrealert.shipDate ?? approvingPrealert.createdAt.slice(0, 10)}</div>
              <div style={{ marginTop: 8, borderTop: "1px solid #e5e7eb", paddingTop: 8 }}>
                <div style={{ fontSize: 12, color: "#000000", marginBottom: 4 }}>应收金额（必填）</div>
                <input type="number" step="0.01" value={prealertEditDrafts[approvingPrealert.id]?.receivableAmountCny ?? approvingPrealert.receivableAmountCny ?? ""} onChange={(e) => setPrealertEditDrafts((prev) => ({ ...prev, [approvingPrealert.id]: { ...(prev[approvingPrealert.id] ?? buildPrealertDraft(approvingPrealert)), receivableAmountCny: +e.target.value } }))} placeholder="输入应收金额" style={prealertEditInputStyle} />
              </div>
              <div>
                <div style={{ fontSize: 12, color: "#000000", marginBottom: 4 }}>柜号（可选）</div>
                <input value={prealertBatchDrafts[approvingPrealert.id] ?? ""} onChange={(e) => setPrealertBatchDrafts((prev) => ({ ...prev, [approvingPrealert.id]: e.target.value }))} placeholder="柜号（装柜时填写）" style={prealertEditInputStyle} />
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" onClick={() => setApprovingPrealert(null)} style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 16px", fontSize: 13, background: "#fff", cursor: "pointer", color: "#000000" }}>取消</button>
              <button type="button" onClick={async () => {
                const item = approvingPrealert;
                const draft = prealertEditDrafts[item.id] ?? buildPrealertDraft(item);
                const batchNo = (prealertBatchDrafts[item.id] ?? "").trim();
                try {
                  await receiveStaffPrealert({
                    orderId: item.id,
                    itemName: draft.itemName,
                    packageCount: draft.packageCount,
                    packageUnit: draft.packageUnit,
                    productQuantity: draft.productQuantity,
                    weightKg: draft.weightKg,
                    volumeM3: draft.volumeM3,
                    domesticTrackingNo: draft.domesticTrackingNo,
                    transportMode: draft.transportMode,
                  });
                  setToast(`预报单 ${item.id} 确认收货`);
                  await loadPageData();
                } catch (error) {
                  const text = error instanceof Error ? error.message : "确认收货失败";
                  setToast("确认收货失败：" + text);
                }
                setApprovingPrealert(null);
              }} style={{ border: "none", borderRadius: 6, padding: "8px 16px", fontSize: 13, background: "#2563eb", color: "#fff", fontWeight: 500, cursor: "pointer" }}>确认收货</button>
            </div>
          </div>
        </div>
      )}

      {/* 创建订单弹窗 */}
      {showCreateModal ? (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)", padding: 16 }}>
          <div style={{ width: "100%", maxWidth: 1320, maxHeight: "90vh", overflow: "auto", background: "#fff", borderRadius: 12, padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
            <h3 style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 600 }}>创建订单</h3>
            <div style={{ display: "grid", gap: 8 }}>
              <div style={{ position: "relative" }}>
                <input value={clientSearchKeyword} onChange={(e) => { setClientSearchKeyword(e.target.value); const match = allClientOptions.find((c) => `${c.id} - ${c.name}` === e.target.value); if (match) setForm((v) => ({ ...v, clientId: match.id })); }} onFocus={() => setClientSearchKeyword("")} placeholder="搜索客户名字或ID…" list="client-options-modal" autoComplete="off" style={{ ...orderCreateInputStyle, width: "100%" }} />
                <datalist id="client-options-modal">
                  {filteredClientOptions.map((item) => (
                    <option key={item.id} value={`${item.id} - ${item.name}`} />
                  ))}
                </datalist>
              </div>
              <input value={allClientOptions.find((c) => c.id === form.clientId)?.id ?? form.clientId} readOnly style={{ ...orderCreateInputStyle, background: "#f8fafc", color: "#000000", fontWeight: 600 }} placeholder="已选唛头" />
              <select value={form.warehouseId} onChange={(e) => setForm((v) => ({ ...v, warehouseId: e.target.value }))} style={orderCreateInputStyle}>
                {warehouseOptions.map((item) => (
                  <option key={item.id} value={item.id}>仓库：{item.label}</option>
                ))}
              </select>
              <input value={form.trackingNo} onChange={(e) => setForm((v) => ({ ...v, trackingNo: e.target.value }))} placeholder="运单号 *" style={orderCreateInputStyle} />
              <input value={form.batchNo} onChange={(e) => setForm((v) => ({ ...v, batchNo: e.target.value }))} placeholder="柜号（可选）" style={orderCreateInputStyle} />
              <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, background: "#f9fafb" }}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, color: "#000000" }}>产品列表</div>
                {staffFormProducts.length === 0 ? (
                  <input value={form.itemName} onChange={(e) => setForm((v) => ({ ...v, itemName: e.target.value }))} placeholder="品名 *" style={orderCreateInputStyle} />
                ) : null}
                {staffFormProducts.map((p, i) => {
                  const pPkg = Number(p.packageCount) || 0;
                  const pL = Number(p.lengthCm) || 0;
                  const pW = Number(p.widthCm) || 0;
                  const pH = Number(p.heightCm) || 0;
                  const pWt = Number(p.weightKg) || 0;
                  const prodVol = (pL > 0 && pW > 0 && pH > 0) ? (pL * pW * pH * pPkg) / 1_000_000 : 0;
                  const prodWt = pWt * pPkg;
                  return (
                  <div key={i} style={{ display: "grid", gridTemplateColumns: "2.5fr 0.45fr 0.35fr 0.35fr 0.35fr 0.4fr 0.42fr 0.7fr 0.8fr 0.6fr 0.6fr auto", gap: 2, marginBottom: 3, alignItems: "center" }}>
                    <input value={p.itemName} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], itemName: e.target.value }; setStaffFormProducts(n); }} placeholder="品名" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "3px 4px", fontSize: 11 }} />
                    <input type="number" value={p.packageCount} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], packageCount: e.target.value }; setStaffFormProducts(n); }} placeholder="箱数" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "3px 4px", fontSize: 11, minWidth: 0 }} />
                    <input type="number" step="0.01" value={p.lengthCm} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], lengthCm: e.target.value }; setStaffFormProducts(n); }} placeholder="长" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "3px 4px", fontSize: 11, minWidth: 0 }} />
                    <input type="number" step="0.01" value={p.widthCm} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], widthCm: e.target.value }; setStaffFormProducts(n); }} placeholder="宽" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "3px 4px", fontSize: 11, minWidth: 0 }} />
                    <input type="number" step="0.01" value={p.heightCm} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], heightCm: e.target.value }; setStaffFormProducts(n); }} placeholder="高" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "3px 4px", fontSize: 11, minWidth: 0 }} />
                    <input type="number" value={p.productQuantity} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], productQuantity: e.target.value }; setStaffFormProducts(n); }} placeholder="单箱数量" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "3px 4px", fontSize: 11, minWidth: 0 }} />
                    <input type="number" step="0.01" value={p.weightKg} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], weightKg: e.target.value }; setStaffFormProducts(n); }} placeholder="单箱重kg" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "3px 4px", fontSize: 11, minWidth: 0 }} />
                    <select value={p.cargoType || "NORMAL"} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], cargoType: e.target.value }; setStaffFormProducts(n); }} style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "3px 2px", fontSize: 11, background: "#fff", minWidth: 0 }}>
                      <option value="NORMAL">普货</option>
                      <option value="INSPECTION">商检</option>
                      <option value="SENSITIVE">敏感</option>
                    </select>
                    <input value={p.domesticTrackingNo || ""} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], domesticTrackingNo: e.target.value }; setStaffFormProducts(n); }} placeholder="货拉拉" style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "3px 4px", fontSize: 11, minWidth: 0 }} />
                    <span style={{ fontSize: 10, color: prodVol > 0 ? "#2563eb" : "#9ca3af", textAlign: "right", padding: "0 2px", whiteSpace: "nowrap" }}>{prodVol > 0 ? prodVol.toFixed(3) + "m³" : "—"}</span>
                    <span style={{ fontSize: 10, color: prodWt > 0 ? "#2563eb" : "#9ca3af", textAlign: "right", padding: "0 2px", whiteSpace: "nowrap" }}>{prodWt > 0 ? prodWt.toFixed(1) + "kg" : "—"}</span>
                    <button type="button" onClick={() => setStaffFormProducts((v) => v.filter((_, j) => j !== i))} style={{ border: "1px solid #fca5a5", borderRadius: 4, padding: "2px 4px", fontSize: 10, background: "#fff", color: "#dc2626", cursor: "pointer", minWidth: 20 }}>✕</button>
                  </div>
                );})}
                {(() => {
                  const totalVol = staffFormProducts.reduce((s, p) => {
                    const pkg = Number(p.packageCount) || 0;
                    const l = Number(p.lengthCm) || 0;
                    const w = Number(p.widthCm) || 0;
                    const h = Number(p.heightCm) || 0;
                    return s + ((l > 0 && w > 0 && h > 0) ? (l * w * h * pkg) / 1_000_000 : 0);
                  }, 0);
                  const totalWt = staffFormProducts.reduce((s, p) => {
                    const pkg = Number(p.packageCount) || 0;
                    const wt = Number(p.weightKg) || 0;
                    return s + wt * pkg;
                  }, 0);
                  return (
                    <div style={{ fontSize: 12, fontWeight: 600, padding: "4px 0", color: "#2563eb", textAlign: "right" }}>
                      合计：总体积 {totalVol.toFixed(6)}m³  |  总重量 {totalWt.toFixed(2)}kg
                    </div>
                  );
                })()}
                <button type="button" onClick={() => setStaffFormProducts((v) => [...v, { itemName: "", packageCount: "", lengthCm: "", widthCm: "", heightCm: "", productQuantity: "", weightKg: "", cargoType: "NORMAL", domesticTrackingNo: "" }])} style={{ border: "1px dashed #2563eb", borderRadius: 4, padding: "4px 10px", fontSize: 12, background: "#fff", color: "#2563eb", cursor: "pointer", marginTop: 4 }}>+ 添加产品</button>
              </div>
              <div style={{ fontSize: 12, color: "#000000", marginTop: 4 }}>
                💡 输入长宽高和单箱重量后，体积和总重量在前端实时自动计算
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                <select value={form.packageUnit} onChange={(e) => setForm((v) => ({ ...v, packageUnit: e.target.value as "bag" | "box" }))} style={orderCreateInputStyle}>
                  <option value="box">箱</option>
                  <option value="bag">袋</option>
                </select>
                <input type="number" step="0.001" value={form.volumeM3} readOnly={staffFormProducts.length > 0} onChange={(e) => setForm((v) => ({ ...v, volumeM3: e.target.value }))} placeholder="总体积（m³）" style={orderCreateInputStyle} />
                <input type="number" step="0.01" value={form.weightKg} onChange={(e) => setForm((v) => ({ ...v, weightKg: e.target.value }))} placeholder="总重量（kg）" style={orderCreateInputStyle} />
              </div>
              <select value={form.transportMode} onChange={(e) => setForm((v) => ({ ...v, transportMode: e.target.value as "sea" | "land" }))} style={orderCreateInputStyle}>
                <option value="sea">海运</option>
                <option value="land">陆运</option>
              </select>
              <input type="date" value={form.arrivedAt} onChange={(e) => setForm((v) => ({ ...v, arrivedAt: e.target.value }))} style={orderCreateInputStyle} />
              <div style={{ fontSize: 11, color: "#000000", marginTop: -4 }}>到仓日期 *</div>
              <hr style={{ border: "none", borderTop: "1px solid #e5e7eb", margin: "8px 0" }} />
            </div>
            {/* 产品图片上传 */}
            <div style={{ marginTop: 10, border: "1px dashed #d1d5db", borderRadius: 8, padding: 10 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6, color: "#000000" }}>产品图片（可选，可多选）</div>
              <input type="file" multiple accept="image/*" onChange={(e) => {
                const files = Array.from(e.target.files || []);
                setOrderImageFiles(prev => [...prev, ...files]);
                setOrderImagePreviews(prev => [...prev, ...files.map(f => URL.createObjectURL(f))]);
              }} style={{ fontSize: 12 }} />
              {orderImagePreviews.length > 0 && (
                <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                  {orderImagePreviews.map((url, i) => (
                    <div key={i} style={{ position: "relative" }}>
                      <img src={url} style={{ width: 60, height: 60, objectFit: "cover", borderRadius: 4, border: "1px solid #e5e7eb" }} />
                      <button type="button" onClick={() => {
                        setOrderImageFiles(f => f.filter((_, j) => j !== i));
                        setOrderImagePreviews(p => p.filter((_, j) => j !== i));
                      }} style={{ position: "absolute", top: -6, right: -6, border: "1px solid #fca5a5", borderRadius: 10, width: 18, height: 18, fontSize: 10, background: "#fff", color: "#dc2626", cursor: "pointer", padding: 0, lineHeight: 1 }}>✕</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {message && message.includes("失败") ? (
              <p style={{ marginTop: 8, color: "#b91c1c", fontSize: 13 }}>{message}</p>
            ) : message && !message.includes("失败") && showCreateModal ? (
              <p style={{ marginTop: 8, color: "#065f46", fontSize: 13 }}>{message}</p>
            ) : null}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button type="button" onClick={() => { setShowCreateModal(false); setMessage(""); setOrderImageFiles([]); setOrderImagePreviews([]); }} style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 16px", fontSize: 13, background: "#fff", cursor: "pointer", color: "#000000" }}>取消</button>
              <button type="button" disabled={loading} onClick={() => void submitOrder()} style={{ border: "none", borderRadius: 6, padding: "8px 16px", fontSize: 13, background: loading ? "#000000" : "#2563eb", color: "#fff", fontWeight: 500, cursor: loading ? "not-allowed" : "pointer" }}>{loading ? "提交中…" : "创建订单"}</button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 批量上传弹窗 */}
      {showBatchImport ? (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)", padding: 16 }}>
          <div style={{ width: "100%", maxWidth: 900, maxHeight: "90vh", overflow: "auto", background: "#fff", borderRadius: 12, padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
            <h3 style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 600 }}>批量创建订单</h3>
            <p style={{ fontSize: 13, color: "#000000", margin: "0 0 12px" }}>
              支持 Excel 批量导入订单。建议先下载模板，按字段填好后上传。
            </p>
            {batchFileName && (
              <div style={{ marginBottom: 12, padding: "10px 14px", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8, fontSize: 14 }}>
                📄 已上传: <strong>{batchFileName}</strong> — 有效数据 <strong>{batchRows.length}</strong> 条
                {batchRows.length === 0 && <span style={{ color: "#dc2626", marginLeft: 8 }}>⚠️ 无有效数据，请检查模板格式</span>}
              </div>
            )}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
              <button type="button" onClick={downloadStaffBatchTemplate} style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 12px", background: "#fff", color: "#000000", cursor: "pointer" }}>下载模板</button>
              <label style={{ border: "1px solid #2563eb", borderRadius: 8, padding: "8px 12px", background: "#eff6ff", color: "#1d4ed8", cursor: "pointer" }}>
                上传 Excel
                <input type="file" accept=".xlsx,.xls" style={{ display: "none" }} onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setBatchFileName(file.name);
                  setBatchConfirmed(false);
                  file.arrayBuffer().then((buf) => {
                    const wb = XLSX.read(buf, { type: "array" });
                    const ws = wb.Sheets[wb.SheetNames[0]];
                    const raw = XLSX.utils.sheet_to_json(ws, { defval: "" });
                    const normalized = normalizeStaffBatchRows(raw as Record<string, unknown>[]);
                    setBatchRows(normalized);
                    setBatchErrors([]);
                    setBatchProgress({ current: 0, success: 0, fail: 0 });
                  });
                  e.target.value = "";
                }} />
              </label>
              {!batchConfirmed && batchRows.length > 0 && !batchLoading && batchProgress.current === 0 && (
                <button type="button" onClick={() => { setBatchConfirmed(true); void submitStaffBatch(); }} style={{ border: "none", borderRadius: 8, padding: "8px 16px", background: "#16a34a", color: "#fff", cursor: "pointer", fontWeight: 600, fontSize: 14 }}>
                  确认上传 {batchRows.length} 条
                </button>
              )}
            </div>
            {batchLoading && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
                  <span>正在提交第 {batchProgress.current}/{batchRows.length} 条…</span>
                  <span><span style={{ color: "#16a34a" }}>✅ {batchProgress.success}</span> / <span style={{ color: batchProgress.fail > 0 ? "#dc2626" : "#6b7280" }}>❌ {batchProgress.fail}</span></span>
                </div>
                <div style={{ height: 8, background: "#e5e7eb", borderRadius: 4, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${(batchProgress.current / batchRows.length) * 100}%`, background: "#2563eb", borderRadius: 4, transition: "width 0.3s" }} />
                </div>
              </div>
            )}
            {batchErrors.length > 0 && !batchLoading && (
              <div style={{ marginBottom: 12, padding: 12, borderRadius: 8, background: "#fef2f2", border: "1px solid #fecaca" }}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4, color: "#b91c1c" }}>❌ 失败明细：</div>
                <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: "#b91c1c" }}>
                  {batchErrors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </div>
            )}
            {!batchLoading && batchProgress.current > 0 && batchErrors.length === 0 && (
              <div style={{ marginBottom: 12, padding: 12, borderRadius: 8, background: "#f0fdf4", border: "1px solid #bbf7d0" }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: "#166534" }}>✅ 全部提交成功：{batchProgress.success} 条</div>
              </div>
            )}
            {batchRows.length > 0 && (
              <div style={{ overflowX: "auto", marginBottom: 12 }}>
                <div style={{ fontSize: 13, marginBottom: 4, color: "#000000" }}>预览：有效行 {batchRows.length} 条</div>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid #e2e8f0", background: "#f8fafc" }}>
                      <th style={{ textAlign: "left", padding: "6px 4px" }}>#</th>
                      <th style={{ textAlign: "left", padding: "6px 4px" }}>客户ID</th>
                      <th style={{ textAlign: "left", padding: "6px 4px" }}>仓库</th>
                      <th style={{ textAlign: "left", padding: "6px 4px" }}>品名</th>
                      <th style={{ textAlign: "left", padding: "6px 4px" }}>箱数</th>
                      <th style={{ textAlign: "left", padding: "6px 4px" }}>到仓日期</th>
                      <th style={{ textAlign: "left", padding: "6px 4px" }}>运输</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batchRows.map((row, idx) => (
                      <tr key={idx} style={{ borderBottom: "1px solid #f1f5f9" }}>
                        <td style={{ padding: "6px 4px" }}>{idx + 1}</td>
                        <td style={{ padding: "6px 4px" }}>{allClientOptions.find((c) => c.id === row.clientId)?.name ?? row.clientId}</td>
                        <td style={{ padding: "6px 4px" }}>{row.trackingNo ?? "—"}</td>
                        <td style={{ padding: "6px 4px" }}>{{"wh_yiwu_01":"义乌仓","wh_guangzhou_01":"广州仓","wh_dongguan_01":"东莞仓","wh_shenzhen_01":"深圳仓"}[row.warehouseId] ?? row.warehouseId}</td>
                        <td style={{ padding: "6px 4px" }}>{row.itemName}</td>
                        <td style={{ padding: "6px 4px" }}>{row.packageCount} {row.packageUnit}</td>
                        <td style={{ padding: "6px 4px" }}>{row.arrivedAt}</td>
                        <td style={{ padding: "6px 4px" }}>{row.transportMode === "sea" ? "海运" : "陆运"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button type="button" onClick={() => { setShowBatchImport(false); setBatchRows([]); setBatchErrors([]); setBatchProgress({ current: 0, success: 0, fail: 0 }); setBatchFileName(""); setBatchConfirmed(false); }} style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 16px", fontSize: 13, background: "#fff", cursor: "pointer", color: "#000000" }}>关闭</button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 分柜弹窗 */}
      {splittingShipment ? (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)", padding: 16 }}>
          <div style={{ width: "100%", maxWidth: 540, maxHeight: "90vh", overflow: "auto", background: "#fff", borderRadius: 12, padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
            <h3 style={{ margin: "0 0 12px", fontSize: 18, fontWeight: 600 }}>运单分柜</h3>
            <div style={{ fontSize: 13, color: "#000000", marginBottom: 12 }}>
              运单号：{splittingShipment.trackingNo} ｜ 当前总件数：<strong>{splittingShipment.packageCount ?? "—"}</strong>
            </div>
            <div style={{ fontSize: 12, color: "#000000", marginBottom: 12 }}>
              已分配：{splitRows.reduce((sum, r) => sum + (Number(r.packageCount) || 0), 0)} 件
              ｜ 剩余：{(splittingShipment.packageCount ?? 0) - splitRows.reduce((sum, r) => sum + (Number(r.packageCount) || 0), 0)} 件
            </div>
            <div style={{ display: "grid", gap: 12 }}>
              {splitRows.map((row, i) => (
                <div key={i} style={{ padding: 12, border: "1px solid #e5e7eb", borderRadius: 8, background: "#fafafa" }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#000000", marginBottom: 6 }}>分柜 {i + 1}</div>
                  <div style={{ display: "grid", gap: 6 }}>
                    <input value={row.trackingNo} onChange={(e) => setSplitRows((prev) => prev.map((r, j) => j === i ? { ...r, trackingNo: e.target.value } : r))} placeholder="运单号 *" style={orderCreateInputStyle} />
                    <input value={row.batchNo} onChange={(e) => setSplitRows((prev) => prev.map((r, j) => j === i ? { ...r, batchNo: e.target.value } : r))} placeholder="柜号 *" style={orderCreateInputStyle} />
                    <input value={row.itemName} onChange={(e) => setSplitRows((prev) => prev.map((r, j) => j === i ? { ...r, itemName: e.target.value } : r))} placeholder="品名" style={orderCreateInputStyle} />
                    <input type="number" min={1} value={row.packageCount} onChange={(e) => setSplitRows((prev) => prev.map((r, j) => j === i ? { ...r, packageCount: e.target.value } : r))} placeholder="移走件数 *" style={orderCreateInputStyle} />
                  </div>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button type="button" onClick={() => setSplitRows((prev) => [...prev, { trackingNo: "", batchNo: "", itemName: splittingShipment.itemName ?? "", packageCount: "" }])} style={{ border: "1px dashed #d1d5db", borderRadius: 6, padding: "6px 12px", fontSize: 12, background: "#fff", cursor: "pointer", color: "#000000" }}>＋ 添加分柜</button>
            </div>
            {message && message.includes("分柜") ? (
              <p style={{ marginTop: 8, color: message.includes("失败") ? "#b91c1c" : "#065f46", fontSize: 13 }}>{message}</p>
            ) : null}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button type="button" onClick={() => { setSplittingShipment(null); setMessage(""); }} style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 16px", fontSize: 13, background: "#fff", cursor: "pointer", color: "#000000" }}>取消</button>
              <button type="button" disabled={loading} onClick={async () => {
                const validRows = splitRows.filter((r) => r.trackingNo.trim() && r.batchNo.trim() && Number(r.packageCount) > 0);
                if (validRows.length === 0) { setMessage("分柜失败：请至少填写运单号、柜号和件数"); return; }
                const totalSplit = validRows.reduce((s, r) => s + Number(r.packageCount), 0);
                if (totalSplit > (splittingShipment.packageCount ?? 0)) { setMessage(`分柜失败：移走总件数(${totalSplit})超过当前总件数(${splittingShipment.packageCount ?? 0})`); return; }
                setLoading(true); setMessage("");
                try {
                  const result = await splitStaffShipment({
                    parentShipmentId: splittingShipment.id,
                    splits: validRows.map((r) => ({ trackingNo: r.trackingNo.trim(), batchNo: r.batchNo.trim(), itemName: r.itemName.trim(), packageCount: Number(r.packageCount) })),
                  });
                  setToast(`分柜成功：${result.children.length} 个子单`);
                  setMessage(`分柜成功：${result.children.map((c) => c.trackingNo).join("、")}`);
                  setSplittingShipment(null);
                  setSplitRows([]);
                  await loadPageData();
                } catch (error) {
                  const text = error instanceof Error ? error.message : "分柜失败";
                  setMessage(`分柜失败：${text}`);
                } finally { setLoading(false); }
              }} style={{ border: "none", borderRadius: 6, padding: "8px 16px", fontSize: 13, background: loading ? "#000000" : "#d97706", color: "#fff", fontWeight: 500, cursor: loading ? "not-allowed" : "pointer" }}>{loading ? "提交中…" : "确认分柜"}</button>
            </div>
          </div>
        </div>
      ) : null}
    </RoleShell>
  );
}
