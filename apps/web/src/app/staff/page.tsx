"use client";

import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { calcOrderAmountCny, formatCny } from "../../modules/billing/billing-utils";
import EmptyStateCard from "../../modules/layout/EmptyStateCard";
import RoleShell from "../../modules/layout/RoleShell";
import Toast from "../../modules/layout/Toast";
import {
  approveStaffPrealert,
  createStaffOrder,
  deleteStaffOrderProductImage,
  fetchStaffInboundPhotos,
  fetchStaffPrealerts,
  fetchStaffShipments,
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
  updateStaffShipmentStatus,
} from "../../services/business-api";

const MAX_ORDER_PRODUCT_IMAGES = 5;

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
      <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13, color: "#334155" }}>
        订单详情 · 产品图（最多 {MAX_ORDER_PRODUCT_IMAGES} 张）
      </div>
      {imgs.length === 0 && !canAdd ? (
        <div style={{ fontSize: 12, color: "#94a3b8" }}>暂无产品图</div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-start" }}>
          {imgs.map((img) => (
            <div key={img.id}>
              <img
                src={`data:${img.mime};base64,${img.contentBase64}`}
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
                  border: "1px dashed #94a3b8",
                  borderRadius: 8,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 12,
                  color: "#64748b",
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
      {!props.canManage ? <div style={{ fontSize: 12, color: "#64748b", marginTop: 6 }}>仅展示；无本仓库操作权限时不可修改（与上传接口校验的订单仓库一致）。</div> : null}
    </div>
  );
}

/**
 * 运单系统状态转中文（列表展示）。
 */
function shipmentStatusZh(status: string | undefined): string {
  if (!status) return "—";
  const map: Record<string, string> = {
    created: "已入起运仓",
    pickedUp: "已揽收",
    inWarehouseCN: "国内在仓",
    customsPending: "报关中",
    inTransit: "国际在途",
    customsTH: "目的港清关",
    outForDelivery: "末端派送",
    delivered: "已签收",
    exception: "异常",
    returned: "已退回",
    cancelled: "已取消",
  };
  return map[status] ?? status;
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
  "staff-status-update",
  "staff-shipment-list",
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
function formatVolumeM3String(m3: number): string {
  if (!Number.isFinite(m3) || m3 <= 0) return "";
  return String(Number(m3.toFixed(6)));
}

type StatusUpdateImageAttachProps = {
  disabled: boolean;
  previewUrl: string | null;
  fileName: string | null;
  dragActive: boolean;
  onDragActive: (active: boolean) => void;
  onPickFile: (file: File | null) => void;
};

/**
 * 状态更新区附图：支持点击选择或拖放单张图片，展示预览与清除。
 */
function StatusUpdateImageAttach(props: StatusUpdateImageAttachProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
      <div style={{ position: "relative" }}>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          disabled={props.disabled}
          style={{ position: "absolute", width: 0, height: 0, opacity: 0, pointerEvents: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            e.target.value = "";
            props.onPickFile(f);
          }}
        />
        <div
          onDragEnter={(e) => {
            e.preventDefault();
            e.stopPropagation();
            props.onDragActive(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            props.onDragActive(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            const related = e.relatedTarget as Node | null;
            if (related && e.currentTarget.contains(related)) return;
            props.onDragActive(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            props.onDragActive(false);
            const f = e.dataTransfer.files?.[0] ?? null;
            props.onPickFile(f);
          }}
          onClick={() => {
            if (!props.disabled) inputRef.current?.click();
          }}
          onKeyDown={(e) => {
            if (props.disabled) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              inputRef.current?.click();
            }
          }}
          role="button"
          tabIndex={props.disabled ? -1 : 0}
          aria-label="上传或拖放图片"
          style={{
            width: 112,
            minHeight: 88,
            border: `2px dashed ${props.dragActive ? "#2563eb" : "#cbd5e1"}`,
            borderRadius: 8,
            background: props.dragActive ? "#eff6ff" : "#f8fafc",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: 6,
            cursor: props.disabled ? "not-allowed" : "pointer",
            opacity: props.disabled ? 0.6 : 1,
            boxSizing: "border-box",
          }}
        >
          {props.previewUrl ? (
            <img src={props.previewUrl} alt="" style={{ maxWidth: 100, maxHeight: 72, objectFit: "cover", borderRadius: 4 }} />
          ) : (
            <span style={{ fontSize: 11, color: "#64748b", textAlign: "center", lineHeight: 1.35, userSelect: "none" }}>
              拖放或点击
              <br />
              上传图片
            </span>
          )}
        </div>
      </div>
      {props.fileName ? (
        <div
          style={{ fontSize: 11, color: "#475569", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={props.fileName}
        >
          {props.fileName}
        </div>
      ) : null}
      {props.previewUrl ? (
        <button
          type="button"
          disabled={props.disabled}
          onClick={(e) => {
            e.stopPropagation();
            props.onPickFile(null);
          }}
          style={{
            fontSize: 11,
            border: "1px solid #e2e8f0",
            borderRadius: 6,
            padding: "2px 8px",
            background: "#fff",
            cursor: props.disabled ? "not-allowed" : "pointer",
          }}
        >
          清除
        </button>
      ) : null}
      <span style={{ fontSize: 11, color: "#94a3b8" }}>附图存为入库拍照</span>
    </div>
  );
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
  /** 发货日期时间（datetime-local 字符串，保存时取日期部分写入 ship_date）。 */
  shipLocal: string;
  receiverAddressTh: string;
  containerNo: string;
  receivableAmountCny: string;
  receivableCurrency: "CNY" | "THB";
  paymentStatus: "paid" | "unpaid";
  /** 仅表单展示，后端暂无字段持久化。 */
  destinationCountry: string;
  /** 仅表单展示，后端暂无字段持久化。 */
  customsDeclaration: "none" | "declare";
};

/**
 * 将接口返回的发货日期转为 datetime-local 初始值。
 */
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
      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6 }}>
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
  const clientOptions = [
    { id: "u_client_001", name: "Client One（客户一）" },
  ];
  const warehouseOptions = [
    { id: "wh_yiwu_01", label: "义乌仓" },
    { id: "wh_guangzhou_01", label: "广州仓" },
    { id: "wh_dongguan_01", label: "东莞仓" },
  ];
  const logisticsStatusOptions = ["已揽收", "已入库", "报关中", "运输中", "泰国清关", "派送中", "已签收"] as const;
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [toast, setToast] = useState("");
  const [prealertSearch, setPrealertSearch] = useState({
    clientName: "",
    domesticTrackingNo: "",
    transportMode: "",
    warehouseId: "",
  });
  const [prealertPanelCollapsed, setPrealertPanelCollapsed] = useState(false);
  const [shipmentListCollapsed, setShipmentListCollapsed] = useState(false);
  const [shipmentTableExpandedId, setShipmentTableExpandedId] = useState<string | null>(null);
  const [shipmentOrderEditDrafts, setShipmentOrderEditDrafts] = useState<Record<string, ShipmentOrderEditDraft>>({});
  const [clientSearchKeyword, setClientSearchKeyword] = useState("");
  const [shipments, setShipments] = useState<ShipmentItem[]>([]);
  const [prealerts, setPrealerts] = useState<OrderItem[]>([]);
  const [prealertBatchDrafts, setPrealertBatchDrafts] = useState<Record<string, string>>({});
  const [prealertEditDrafts, setPrealertEditDrafts] = useState<Record<string, PrealertEditDraft>>({});
  const [prealertConfirmedDrafts, setPrealertConfirmedDrafts] = useState<Record<string, PrealertEditDraft>>({});
  const [editingPrealertId, setEditingPrealertId] = useState<string | null>(null);
  const [createStepDone, setCreateStepDone] = useState(false);
  const [statusSearch, setStatusSearch] = useState({
    batchNo: "",
    shipmentStatus: "",
  });
  const [statusHasSearched, setStatusHasSearched] = useState(false);
  const [editingShipmentId, setEditingShipmentId] = useState<string | null>(null);
  const [editingBatchNo, setEditingBatchNo] = useState<string | null>(null);
  const [statusEditDraft, setStatusEditDraft] = useState({
    toStatus: "",
    remark: "",
  });
  const [statusAttachFile, setStatusAttachFile] = useState<File | null>(null);
  const [statusAttachDragActive, setStatusAttachDragActive] = useState(false);
  const statusAttachPreviewUrl = useMemo(
    () => (statusAttachFile ? URL.createObjectURL(statusAttachFile) : null),
    [statusAttachFile],
  );
  useEffect(() => {
    return () => {
      if (statusAttachPreviewUrl) URL.revokeObjectURL(statusAttachPreviewUrl);
    };
  }, [statusAttachPreviewUrl]);
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
    arrivedAt: "",
    warehouseId: "",
    logisticsStatus: "",
    containerNo: "",
    transportMode: "",
    receiverAddress: "",
    shipDate: "",
    receivableAmount: "",
    statusRaw: "",
  });
  const [form, setForm] = useState({
    clientId: "u_client_001",
    warehouseId: "wh_yiwu_01",
    batchNo: "",
    arrivedAt: "",
    itemName: "",
    productQuantity: "",
    packageCount: "",
    lengthCm: "",
    widthCm: "",
    heightCm: "",
    volumeM3: "",
    weightKg: "",
    domesticOrderNo: "",
    packageUnit: "box" as "bag" | "box",
    transportMode: "land" as "sea" | "land",
    receiverNameTh: "Anan",
    receiverPhoneTh: "0820000000",
    receiverAddressTh: "Chiang Mai",
  });

  /**
   * 更新长宽高并同步写入由尺寸换算得到的体积（m³）。
   */
  const updateOrderDimensions = (patch: Partial<Pick<typeof form, "lengthCm" | "widthCm" | "heightCm">>) => {
    setForm((prev) => {
      const next = { ...prev, ...patch };
      const l = Number(String(next.lengthCm).trim());
      const w = Number(String(next.widthCm).trim());
      const h = Number(String(next.heightCm).trim());
      if (Number.isFinite(l) && Number.isFinite(w) && Number.isFinite(h) && l > 0 && w > 0 && h > 0) {
        next.volumeM3 = formatVolumeM3String(volumeM3FromDimensionsCm(l, w, h));
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
    if (!Number.isFinite(draft.receivableAmountCny) || draft.receivableAmountCny <= 0) {
      return "应收金额必须大于 0。";
    }
    if (draft.transportMode !== "sea" && draft.transportMode !== "land") {
      return "运输方式无效，请选择海运或陆运。";
    }
    if (!draft.shipDate) {
      return "发货日期不能为空。";
    }
    const shipDate = new Date(`${draft.shipDate}T00:00:00`);
    if (Number.isNaN(shipDate.getTime())) {
      return "发货日期格式无效，请重新选择日期。";
    }
    return null;
  };

  const toLogisticsStatus = (status?: string): string => {
    if (!status) return "";
    const v = status.trim();
    if (v === "delivered") return "已签收";
    if (v === "returned") return "已退回";
    if (v === "cancelled") return "已取消";
    if (v === "outForDelivery") return "派送中";
    if (v === "customsTH") return "泰国清关";
    if (v === "inTransit") return "运输中";
    if (v === "customsPending") return "报关中";
    if (v === "inWarehouseCN") return "已入库";
    if (v === "pickedUp") return "已揽收";
    if (v === "created") return "已创建";
    return v;
  };

  const toSystemStatus = (logisticsStatus: string): string => {
    if (logisticsStatus === "已揽收") return "pickedUp";
    if (logisticsStatus === "已入库") return "inWarehouseCN";
    if (logisticsStatus === "报关中") return "customsPending";
    if (logisticsStatus === "运输中") return "inTransit";
    if (logisticsStatus === "泰国清关") return "customsTH";
    if (logisticsStatus === "派送中") return "outForDelivery";
    if (logisticsStatus === "已签收") return "delivered";
    return logisticsStatus;
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
  const handleStatusAttachPick = (file: File | null) => {
    if (!file) {
      setStatusAttachFile(null);
      return;
    }
    if (!file.type.startsWith("image/")) {
      setMessage("请上传图片文件（jpg/png 等）。");
      return;
    }
    setStatusAttachFile(file);
  };

  /**
   * 重置状态更新表单中的附图（取消编辑或清空搜索时调用）。
   */
  const resetStatusAttach = () => {
    setStatusAttachFile(null);
    setStatusAttachDragActive(false);
  };

  /**
   * 状态更新成功后，将当前附图写入各运单的入库拍照记录。
   */
  const uploadStatusInboundPhotosIfAny = async (shipmentIds: string[]) => {
    if (!statusAttachFile || shipmentIds.length === 0) return;
    const contentBase64 = await readFileAsBase64(statusAttachFile);
    const mime = statusAttachFile.type || "image/jpeg";
    const fileName = statusAttachFile.name;
    for (const shipmentId of shipmentIds) {
      await uploadStaffInboundPhoto({
        shipmentId,
        fileName,
        mime,
        contentBase64,
        note: "状态更新附图",
      });
    }
  };

  const loadPageData = async (): Promise<ShipmentItem[]> => {
    const [shipmentItems, prealertItems] = await Promise.all([fetchStaffShipments(), fetchStaffPrealerts()]);
    setShipments(shipmentItems);
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
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

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
    const itemName = form.itemName.trim();
    const batchNo = form.batchNo.trim();
    const arrivedAt = form.arrivedAt.trim();
    const packageCount = Number(form.packageCount.trim());
    const productQuantityText = form.productQuantity.trim();
    const productQuantity = productQuantityText ? Number(productQuantityText) : undefined;
    const volumeM3 = Number(form.volumeM3.trim());
    const weightKg = Number(form.weightKg.trim());

    if (!itemName || !batchNo || !arrivedAt || !form.warehouseId) {
      setMessage("请先完整填写创建订单信息。");
      return;
    }
    if (
      Number.isNaN(packageCount) ||
      Number.isNaN(volumeM3) ||
      Number.isNaN(weightKg)
    ) {
      setMessage("数量、重量、体积请输入有效数字。");
      return;
    }
    if (productQuantityText && productQuantity !== undefined && Number.isNaN(productQuantity)) {
      setMessage("产品数量请输入有效数字，或留空。");
      return;
    }
    if (
      packageCount <= 0 ||
      (productQuantity !== undefined && productQuantity <= 0) ||
      volumeM3 <= 0 ||
      weightKg <= 0
    ) {
      setMessage("包裹数量、重量、体积必须大于 0；产品数量可留空或填写大于 0。");
      return;
    }

    setLoading(true);
    setMessage("");
    try {
      const result = await createStaffOrder({
        clientId: form.clientId,
        warehouseId: form.warehouseId,
        batchNo,
        arrivedAt,
        itemName,
        productQuantity,
        packageCount,
        packageUnit: form.packageUnit,
        weightKg,
        volumeM3,
        domesticTrackingNo: form.domesticOrderNo.trim(),
        transportMode: form.transportMode,
        receiverNameTh: form.receiverNameTh,
        receiverPhoneTh: form.receiverPhoneTh,
        receiverAddressTh: form.receiverAddressTh,
      });
      setCreateStepDone(true);
      setToast("订单创建成功");
      setMessage(`订单创建成功：${result.orderId}`);
      await loadPageData();
    } catch (error) {
      const text = error instanceof Error ? error.message : "创建失败";
      setMessage(`创建失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  const submitStatusUpdate = async (shipmentId: string) => {
    const toStatus = toSystemStatus(statusEditDraft.toStatus.trim());
    const remark = statusEditDraft.remark.trim();
    if (!toStatus) {
      setMessage("请先选择物流状态。");
      return;
    }
    if (!remark) {
      setMessage("请先填写编辑信息。");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const result = await updateStaffShipmentStatus({
        shipmentId,
        toStatus,
        remark,
      });
      if (statusAttachFile && result.shipmentIds.length > 0) {
        try {
          await uploadStatusInboundPhotosIfAny(result.shipmentIds);
        } catch (uploadErr) {
          const ut = uploadErr instanceof Error ? uploadErr.message : "上传失败";
          setMessage(`状态已更新，但附图上传失败：${ut}`);
          resetStatusAttach();
          setEditingShipmentId(null);
          setStatusEditDraft({ toStatus: "", remark: "" });
          await loadPageData();
          return;
        }
      }
      resetStatusAttach();
      setToast("运单状态更新成功");
      setMessage(
        result.mode === "batch"
          ? `批次 ${result.batchNo ?? "-"} 更新成功，共 ${result.updatedCount} 条 -> ${result.toStatus}`
          : `状态更新成功：${result.fromStatus ?? "-"} -> ${result.toStatus}`,
      );
      setEditingShipmentId(null);
      setStatusEditDraft({ toStatus: "", remark: "" });
      await loadPageData();
    } catch (error) {
      const text = error instanceof Error ? error.message : "更新失败";
      setMessage(`更新失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  const submitBatchStatusUpdate = async (batchNo: string) => {
    const targetBatchNo = batchNo.trim();
    const toStatus = toSystemStatus(statusEditDraft.toStatus.trim());
    const remark = statusEditDraft.remark.trim();
    if (!targetBatchNo) {
      setMessage("请先输入柜号并搜索。");
      return;
    }
    if (!toStatus) {
      setMessage("请先选择物流状态。");
      return;
    }
    if (!remark) {
      setMessage("请先填写编辑信息。");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const result = await updateStaffShipmentStatus({
        batchNo: targetBatchNo,
        updateByBatch: true,
        toStatus,
        remark,
      });
      if (statusAttachFile && result.shipmentIds.length > 0) {
        try {
          await uploadStatusInboundPhotosIfAny(result.shipmentIds);
        } catch (uploadErr) {
          const ut = uploadErr instanceof Error ? uploadErr.message : "上传失败";
          setMessage(`状态已更新，但附图上传失败：${ut}`);
          resetStatusAttach();
          setEditingBatchNo(null);
          setStatusEditDraft({ toStatus: "", remark: "" });
          await loadPageData();
          return;
        }
      }
      resetStatusAttach();
      setToast("批量状态更新成功");
      setMessage(`批次 ${result.batchNo ?? targetBatchNo} 更新成功，共 ${result.updatedCount} 条 -> ${result.toStatus}`);
      setEditingBatchNo(null);
      setStatusEditDraft({ toStatus: "", remark: "" });
      await loadPageData();
    } catch (error) {
      const text = error instanceof Error ? error.message : "更新失败";
      setMessage(`更新失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  const approvePrealert = async (orderId: string) => {
    const sourceItem = prealerts.find((item) => item.id === orderId);
    const currentDraft = prealertEditDrafts[orderId] ?? (sourceItem ? buildPrealertDraft(sourceItem) : undefined);
    const confirmedDraft = prealertConfirmedDrafts[orderId] ?? currentDraft;
    if (!currentDraft || !confirmedDraft) {
      setMessage("未找到预报单草稿，请刷新后重试。");
      return;
    }
    const confirmedDraftError = validatePrealertDraft(confirmedDraft);
    if (confirmedDraftError) {
      setMessage(`审核失败：${confirmedDraftError}`);
      return;
    }
    if (editingPrealertId === orderId && !isSamePrealertDraft(currentDraft, confirmedDraft)) {
      setMessage("你还有未确认的修改，请先点击“确认修改”。");
      return;
    }

    const batchNo = (prealertBatchDrafts[orderId] ?? "").trim();
    if (!batchNo) {
      setMessage("请先填写批次号后再审核通过。");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const draft = confirmedDraft;
      await approveStaffPrealert({
        orderId,
        batchNo,
        warehouseId: draft?.warehouseId,
        itemName: draft?.itemName,
        packageCount: draft?.packageCount,
        packageUnit: draft?.packageUnit,
        productQuantity: draft?.productQuantity,
        weightKg: draft?.weightKg,
        volumeM3: draft?.volumeM3,
        receivableAmountCny: draft.receivableAmountCny,
        receivableCurrency: draft.receivableCurrency,
        domesticTrackingNo: draft?.domesticTrackingNo,
        transportMode: draft?.transportMode,
        shipDate: draft?.shipDate,
      });
      setEditingPrealertId((current) => (current === orderId ? null : current));
      setToast("预报单审核通过");
      setMessage(`预报单 ${orderId} 已审核通过，批次号 ${batchNo} 已回写到客户订单列表。`);
      await loadPageData();
    } catch (error) {
      const text = error instanceof Error ? error.message : "审核失败";
      setMessage(`审核失败：${text}`);
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
      <div style={{ color: "#6b7280", fontSize: 12, marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );

  const InfoItem = ({ label, value }: { label: string; value: string }) => (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 10,
        background: "#f9fafb",
        padding: "8px 10px",
      }}
    >
      <div style={{ fontSize: 12, color: "#6b7280" }}>{label}</div>
      <div style={{ marginTop: 2, fontSize: 13, color: "#1f2937", fontWeight: 600 }}>{value}</div>
    </div>
  );

  const prealertEditInputStyle = {
    border: "1px solid #d1d5db",
    borderRadius: 8,
    padding: "8px 10px",
    width: "100%",
    marginBottom: 8,
  } as const;

  const allClientOptions = useMemo(() => {
    const byId = new Map<string, { id: string; name: string }>();
    clientOptions.forEach((item) => byId.set(item.id, item));
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
  }, [prealerts]);

  const filteredClientOptions = useMemo(() => {
    const keyword = clientSearchKeyword.trim().toLowerCase();
    if (!keyword) return allClientOptions;
    return allClientOptions.filter(
      (item) => item.name.toLowerCase().includes(keyword) || item.id.toLowerCase().includes(keyword),
    );
  }, [allClientOptions, clientSearchKeyword]);

  const filteredPrealerts = useMemo(() => {
    const clientKeyword = prealertSearch.clientName.trim().toLowerCase();
    const domesticKeyword = prealertSearch.domesticTrackingNo.trim().toLowerCase();
    return prealerts
      .filter((item) => {
        const clientText = `${item.clientName ?? ""} ${item.clientId ?? ""}`.toLowerCase();
        return !clientKeyword || clientText.includes(clientKeyword);
      })
      .filter((item) => {
        const domesticText = (item.domesticTrackingNo ?? "").toLowerCase();
        return !domesticKeyword || domesticText.includes(domesticKeyword);
      })
      .filter((item) => !prealertSearch.warehouseId || item.warehouseId === prealertSearch.warehouseId)
      .filter((item) => !prealertSearch.transportMode || item.transportMode === prealertSearch.transportMode);
  }, [prealerts, prealertSearch]);

  const filteredStatusShipments = useMemo(() => {
    if (!statusHasSearched) return [];
    const batchNoKeyword = statusSearch.batchNo.trim().toLowerCase();
    const shipmentStatusKeyword = statusSearch.shipmentStatus.trim();
    return shipments.filter((item) => {
      const batchNo = (item.batchNo ?? "").toLowerCase();
      const logisticsStatus = toLogisticsStatus(item.currentStatus);
      const batchMatched = !batchNoKeyword || batchNo.includes(batchNoKeyword);
      const statusMatched = !shipmentStatusKeyword || logisticsStatus === shipmentStatusKeyword;
      return batchMatched && statusMatched;
    });
  }, [shipments, statusHasSearched, statusSearch]);

  const searchedBatchNo = useMemo(() => statusSearch.batchNo.trim(), [statusSearch.batchNo]);
  const exactBatchNo = useMemo(() => {
    if (!searchedBatchNo) return "";
    const exact = filteredStatusShipments.find(
      (item) => (item.batchNo ?? "").trim().toLowerCase() === searchedBatchNo.toLowerCase(),
    );
    return (exact?.batchNo ?? "").trim();
  }, [filteredStatusShipments, searchedBatchNo]);
  const batchNoForBulkEdit = exactBatchNo || searchedBatchNo;
  const canSubmitBatchEdit = Boolean(statusEditDraft.toStatus.trim()) && Boolean(statusEditDraft.remark.trim());

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
    const arrivedAtKeyword = shipmentSearch.arrivedAt.trim();
    const warehouseKeyword = shipmentSearch.warehouseId.trim();
    const logisticsStatusKeyword = shipmentSearch.logisticsStatus.trim();
    const containerNoKeyword = shipmentSearch.containerNo.trim().toLowerCase();
    const transportModeKeyword = shipmentSearch.transportMode.trim();
    const receiverAddressKeyword = shipmentSearch.receiverAddress.trim().toLowerCase();
    const shipDateKeyword = shipmentSearch.shipDate.trim();
    const receivableAmountKeyword = shipmentSearch.receivableAmount.trim();
    const statusRawKeyword = shipmentSearch.statusRaw.trim().toLowerCase();

    return shipments.filter((item) => {
      const batchNo = (item.batchNo ?? "").toLowerCase();
      const clientName = `${item.clientName ?? ""} ${item.clientId ?? ""}`.toLowerCase();
      const itemName = (item.itemName ?? "").toLowerCase();
      const trackingNo = (item.trackingNo ?? "").toLowerCase();
      const domesticTrackingNo = (item.domesticTrackingNo ?? "").toLowerCase();
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
      if (arrivedAtKeyword && !arrivedAt.includes(arrivedAtKeyword)) return false;
      if (warehouseKeyword && warehouseId !== warehouseKeyword.toLowerCase()) return false;
      if (logisticsStatusKeyword && logisticsStatus !== logisticsStatusKeyword) return false;
      if (containerNoKeyword && !containerNo.includes(containerNoKeyword)) return false;
      if (transportModeKeyword && (item.transportMode ?? "") !== transportModeKeyword) return false;
      if (receiverAddressKeyword && !receiverAddr.includes(receiverAddressKeyword)) return false;
      if (shipDateKeyword && shipDateVal !== shipDateKeyword) return false;
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

  const exportShipmentsToExcel = () => {
    if (filteredShipmentList.length === 0) {
      setMessage("当前没有可导出的运单数据。");
      return;
    }
    const rows = filteredShipmentList.map((item) => ({
      运单号: item.trackingNo ?? "-",
      归属用户: item.clientName ?? item.clientId ?? "-",
      运单状态: shipmentStatusZh(item.currentStatus),
      加收金额: item.receivableAmountCny != null ? `${item.receivableCurrency === "THB" ? "THB" : "CNY"} ${item.receivableAmountCny}` : "0",
      运输方式: transportModeLabel(item.transportMode),
      发货时间: item.shipDate ?? (item.arrivedAt ? item.arrivedAt.slice(0, 10) : "-"),
      总件数: item.packageCount ?? "-",
      总重量: item.weightKg ?? "-",
      总体积: item.volumeM3 ?? "-",
      计费体积: item.volumeM3 ?? "-",
      所属仓库: warehouseLabelFromId(item.warehouseId),
      收货地址: truncateText(item.receiverAddressTh, 40),
      柜号: item.batchNo ?? "-",
      品名: item.itemName ?? "-",
      国内单号: item.domesticTrackingNo ?? "-",
      产品数量: item.productQuantity ?? "-",
      到仓日期: item.arrivedAt ? item.arrivedAt.slice(0, 10) : "-",
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
            color: "#475569",
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
          <h2 style={{ margin: 0, fontSize: 18, color: "#111827" }}>客户预报单审核</h2>
          <button
            type="button"
            onClick={() => setPrealertPanelCollapsed((v) => !v)}
            style={{
              border: "1px solid #d1d5db",
              borderRadius: 8,
              padding: "6px 10px",
              color: "#374151",
              background: "#fff",
              fontWeight: 600,
            }}
          >
            {prealertPanelCollapsed ? "展开" : "折叠"}
          </button>
        </div>
        {!prealertPanelCollapsed ? (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                gap: 8,
                marginBottom: 10,
              }}
            >
              <input
                value={prealertSearch.clientName}
                onChange={(e) => setPrealertSearch((v) => ({ ...v, clientName: e.target.value }))}
                placeholder="按客户名字查找"
                style={orderCreateInputStyle}
              />
              <input
                value={prealertSearch.domesticTrackingNo}
                onChange={(e) => setPrealertSearch((v) => ({ ...v, domesticTrackingNo: e.target.value }))}
                placeholder="按国内快递单号查找"
                style={orderCreateInputStyle}
              />
              <select
                value={prealertSearch.warehouseId}
                onChange={(e) => setPrealertSearch((v) => ({ ...v, warehouseId: e.target.value }))}
                style={orderCreateInputStyle}
              >
                <option value="">仓库（全部）</option>
                <option value="wh_yiwu_01">义乌</option>
                <option value="wh_guangzhou_01">广州</option>
                <option value="wh_dongguan_01">东莞</option>
              </select>
              <select
                value={prealertSearch.transportMode}
                onChange={(e) => setPrealertSearch((v) => ({ ...v, transportMode: e.target.value }))}
                style={orderCreateInputStyle}
              >
                <option value="">运输方式（全部）</option>
                <option value="sea">海运</option>
                <option value="land">陆运</option>
              </select>
            </div>
            {prealerts.length === 0 ? (
              <EmptyStateCard title="暂无待审核预报单" description="客户提交预报单后会在这里显示，审核通过后会自动移出。" />
            ) : filteredPrealerts.length === 0 ? (
              <EmptyStateCard title="未找到匹配预报单" description="可调整客户名字、国内快递单号、仓库或运输方式筛选条件。" />
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {filteredPrealerts.map((item) => (
                  <div key={item.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, background: "#fff" }}>
                    {(() => {
                      const draft = prealertEditDrafts[item.id] ?? buildPrealertDraft(item);
                      const isEditing = editingPrealertId === item.id;
                      const confirmedDraft = prealertConfirmedDrafts[item.id] ?? buildPrealertDraft(item);
                      const displayDraft = isEditing ? draft : confirmedDraft;
                      return (
                        <>
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>
                      客户名字：{item.clientName ?? item.clientId ?? "-"} / 提交日期：{item.createdAt.slice(0, 10)}
                    </div>
                    <div
                      style={{
                        marginBottom: 8,
                        display: "grid",
                        gap: 6,
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
                            <span style={{ color: "#6b7280", fontSize: 13, minWidth: 26 }}>kg</span>
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
                            <span style={{ color: "#6b7280", fontSize: 13, minWidth: 30 }}>m3</span>
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
                          <InfoItem
                            label="最终应收金额"
                            value={
                              displayDraft.receivableCurrency === "THB"
                                ? `THB ${displayDraft.receivableAmountCny.toFixed(2)}`
                                : formatCny(displayDraft.receivableAmountCny)
                            }
                          />
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
                      placeholder="填写批次号（例如 CAB-2026-A08）"
                      style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", width: "100%", marginBottom: 8 }}
                    />
                    <div style={{ display: "flex", gap: 8 }}>
                      {isEditing ? (
                        <>
                          <button
                            type="button"
                            disabled={loading}
                            onClick={() => void confirmPrealertEdit(item.id)}
                            style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff", background: "#374151", fontWeight: 600 }}
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
                            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 14px", color: "#374151", background: "#fff", fontWeight: 600 }}
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
                          style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 14px", color: "#374151", background: "#fff", fontWeight: 600 }}
                        >
                          修改
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={loading}
                        onClick={() => void approvePrealert(item.id)}
                        style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff", background: "#374151", fontWeight: 600 }}
                      >
                        审核通过
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
        ) : null}
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
          <input
            value={clientSearchKeyword}
            onChange={(e) => setClientSearchKeyword(e.target.value)}
            placeholder="搜索客户名字或客户ID（可选）"
            style={orderCreateInputStyle}
          />
          <select
            value={form.clientId}
            onChange={(e) => setForm((v) => ({ ...v, clientId: e.target.value }))}
            style={orderCreateInputStyle}
          >
            {filteredClientOptions.length === 0 ? (
              <option value={form.clientId}>未找到匹配客户，请调整搜索关键词</option>
            ) : (
              filteredClientOptions.map((item) => (
                <option key={item.id} value={item.id}>
                  客户名字：{item.name}
                </option>
              ))
            )}
          </select>
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
          <input value={form.batchNo} onChange={(e) => setForm((v) => ({ ...v, batchNo: e.target.value }))} placeholder="柜号" style={orderCreateInputStyle} />
          <input value={form.itemName} onChange={(e) => setForm((v) => ({ ...v, itemName: e.target.value }))} placeholder="品名" style={orderCreateInputStyle} />
          <input
            value={
              form.warehouseId === "wh_guangzhou_01"
                ? "将自动生成：GZXTYYYYMMDD001"
                : form.warehouseId === "wh_yiwu_01"
                  ? "将自动生成：YWXTYYYYMMDD001"
                  : "将自动生成：DGXTYYYYMMDD001"
            }
            readOnly
            placeholder="湘泰运单号（系统自动生成）"
            style={{ ...orderCreateInputStyle, color: "#64748b", background: "#f8fafc" }}
          />
          <input value={form.domesticOrderNo} onChange={(e) => setForm((v) => ({ ...v, domesticOrderNo: e.target.value }))} placeholder="国内单号" style={orderCreateInputStyle} />
          <input type="number" value={form.packageCount} onChange={(e) => setForm((v) => ({ ...v, packageCount: e.target.value }))} placeholder="包裹数量" style={orderCreateInputStyle} />
          <input type="number" value={form.productQuantity} onChange={(e) => setForm((v) => ({ ...v, productQuantity: e.target.value }))} placeholder="产品数量（可不填）" style={orderCreateInputStyle} />
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
          <div style={{ fontSize: 12, color: "#64748b", marginTop: -4, marginBottom: 4 }}>尺寸：厘米；体积（m³）= 长×宽×高 ÷ 1,000,000，自动填入下方。</div>
          <input type="number" step="0.01" value={form.weightKg} onChange={(e) => setForm((v) => ({ ...v, weightKg: e.target.value }))} placeholder="重量（kg）" style={orderCreateInputStyle} />
          <input
            type="text"
            readOnly
            value={form.volumeM3}
            placeholder="体积（m³，根据长宽高自动生成）"
            style={{ ...orderCreateInputStyle, color: "#64748b", background: "#f8fafc" }}
          />
          <div style={{ display: "grid", gap: 4 }}>
            <input type="date" value={form.arrivedAt} onChange={(e) => setForm((v) => ({ ...v, arrivedAt: e.target.value }))} style={orderCreateInputStyle} />
            <div style={{ fontSize: 12, color: "#64748b", marginTop: -6, marginBottom: 8 }}>说明：该日期为到仓日期</div>
          </div>
        </div>
        <div style={{ marginTop: 10 }}>
          <button type="button" disabled={loading} onClick={() => void submitOrder()} style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff", background: "#374151" }}>
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
                style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff", background: photoDraft.shipmentId.trim() && photoDraft.fileName && photoDraft.contentBase64 ? "#dc2626" : "#9ca3af" }}
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
                    <div style={{ fontSize: 12, color: "#64748b" }}>
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
        id="staff-status-update"
        style={{
          display: activeSection === "staff-status-update" ? "block" : "none",
          border: "1px solid #e5e7eb",
          borderLeft: "4px solid #d1d5db",
          borderRadius: 12,
          padding: 16,
          marginBottom: 18,
          background: "#ffffff",
          boxShadow: "0 1px 3px rgba(15,23,42,0.06)",
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: 18, color: "#111827", marginBottom: 12 }}>更新订单状态（员工）</h2>
        <div style={{ display: "grid", gap: 8, maxWidth: 760, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          <input
            value={statusSearch.batchNo}
            onChange={(e) => setStatusSearch((v) => ({ ...v, batchNo: e.target.value }))}
            placeholder="柜号"
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", width: "100%" }}
          />
          <select
            value={statusSearch.shipmentStatus}
            onChange={(e) => setStatusSearch((v) => ({ ...v, shipmentStatus: e.target.value }))}
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", width: "100%" }}
          >
            <option value="">物流状态（全部）</option>
            {logisticsStatusOptions.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </div>
        <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
          <button
            type="button"
            disabled={loading}
            onClick={() => {
              setStatusHasSearched(true);
              setEditingShipmentId(null);
              setEditingBatchNo(null);
              resetStatusAttach();
            }}
            style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff", background: "#4b5563" }}
          >
            搜索
          </button>
          <button
            type="button"
            onClick={() => {
              setStatusSearch({ batchNo: "", shipmentStatus: "" });
              setStatusHasSearched(false);
              setEditingShipmentId(null);
              setEditingBatchNo(null);
              setStatusEditDraft({ toStatus: "", remark: "" });
              resetStatusAttach();
            }}
            style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "8px 14px", background: "#fff" }}
          >
            清空
          </button>
        </div>
        <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
          {statusHasSearched && searchedBatchNo && filteredStatusShipments.length > 0 ? (
            <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 10, background: "#f8fafc" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div style={{ color: "#334155", fontWeight: 600 }}>
                  当前柜号：{batchNoForBulkEdit}（共 {filteredStatusShipments.length} 条）
                </div>
                <button
                  type="button"
                  disabled={loading || !exactBatchNo}
                  onClick={() => {
                    setEditingShipmentId(null);
                    setEditingBatchNo(batchNoForBulkEdit);
                    setStatusEditDraft({ toStatus: "", remark: "" });
                    resetStatusAttach();
                  }}
                  style={{
                    border: "1px solid #d1d5db",
                    borderRadius: 8,
                    padding: "6px 12px",
                    background: "#fff",
                    fontWeight: 600,
                    color: "#374151",
                    cursor: loading || !exactBatchNo ? "not-allowed" : "pointer",
                    opacity: loading || !exactBatchNo ? 0.55 : 1,
                  }}
                >
                  按当前柜号批量状态修改
                </button>
              </div>
              {!exactBatchNo ? (
                <div style={{ marginTop: 8, color: "#b45309", fontSize: 13 }}>
                  提示：当前是模糊匹配，建议输入完整柜号后再执行批量修改。
                </div>
              ) : null}
              {editingBatchNo ? (
                <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
                    <select
                      value={statusEditDraft.toStatus}
                      onChange={(e) => setStatusEditDraft((v) => ({ ...v, toStatus: e.target.value }))}
                      style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
                    >
                      <option value="">选择物流状态</option>
                      {logisticsStatusOptions.map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                    </select>
                    <textarea
                      value={statusEditDraft.remark}
                      onChange={(e) => setStatusEditDraft((v) => ({ ...v, remark: e.target.value }))}
                      placeholder="编辑信息（手动输入，必填）"
                      rows={3}
                      style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", resize: "vertical" }}
                    />
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-start" }}>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        type="button"
                        disabled={loading}
                        onClick={() => void submitBatchStatusUpdate(editingBatchNo)}
                        style={{
                          border: "none",
                          borderRadius: 8,
                          padding: "8px 14px",
                          color: "#fff",
                          background: "#4b5563",
                          cursor: loading ? "not-allowed" : "pointer",
                          opacity: loading ? 0.55 : 1,
                        }}
                      >
                        确认批量修改
                      </button>
                      <button
                        type="button"
                        disabled={loading}
                        onClick={() => {
                          setEditingBatchNo(null);
                          setStatusEditDraft({ toStatus: "", remark: "" });
                          resetStatusAttach();
                        }}
                        style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "8px 14px", background: "#fff" }}
                      >
                        取消
                      </button>
                    </div>
                    <StatusUpdateImageAttach
                      disabled={loading}
                      previewUrl={statusAttachPreviewUrl}
                      fileName={statusAttachFile?.name ?? null}
                      dragActive={statusAttachDragActive}
                      onDragActive={setStatusAttachDragActive}
                      onPickFile={handleStatusAttachPick}
                    />
                  </div>
                  {!canSubmitBatchEdit ? (
                    <div style={{ color: "#b45309", fontSize: 13 }}>
                      可直接点击“确认批量修改”，系统会提示你缺少的必填项。
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          {!statusHasSearched ? (
            <EmptyStateCard title="请先搜索" description="输入柜号和物流状态后点击“搜索”。" />
          ) : filteredStatusShipments.length === 0 ? (
            <EmptyStateCard title="无匹配结果" description="可调整柜号或物流状态后重新搜索。" />
          ) : (
            filteredStatusShipments.map((item) => (
              <div key={item.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 10, background: "#fff" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <div style={{ display: "flex", gap: 14, color: "#374151", fontWeight: 600 }}>
                    <span>柜号：{item.batchNo ?? "-"}</span>
                    <span>物流状态：{toLogisticsStatus(item.currentStatus) || "-"}</span>
                  </div>
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => {
                      setEditingBatchNo(null);
                      setEditingShipmentId(item.id);
                      setStatusEditDraft({ toStatus: toLogisticsStatus(item.currentStatus), remark: "" });
                      resetStatusAttach();
                    }}
                    style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "6px 12px", background: "#fff", fontWeight: 600, color: "#374151" }}
                  >
                    状态修改
                  </button>
                </div>
                {editingShipmentId === item.id ? (
                  <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
                    <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
                      <select
                        value={statusEditDraft.toStatus}
                        onChange={(e) => setStatusEditDraft((v) => ({ ...v, toStatus: e.target.value }))}
                        style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
                      >
                        <option value="">选择物流状态</option>
                        {logisticsStatusOptions.map((status) => (
                          <option key={status} value={status}>
                            {status}
                          </option>
                        ))}
                      </select>
                      <textarea
                        value={statusEditDraft.remark}
                        onChange={(e) => setStatusEditDraft((v) => ({ ...v, remark: e.target.value }))}
                        placeholder="编辑信息（手动输入，必填）"
                        rows={3}
                        style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", resize: "vertical" }}
                      />
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-start" }}>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          type="button"
                          disabled={loading}
                          onClick={() => void submitStatusUpdate(item.id)}
                          style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff", background: "#4b5563" }}
                        >
                          确认修改
                        </button>
                        <button
                          type="button"
                          disabled={loading}
                          onClick={() => {
                            setEditingShipmentId(null);
                            setStatusEditDraft({ toStatus: "", remark: "" });
                            resetStatusAttach();
                          }}
                          style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "8px 14px", background: "#fff" }}
                        >
                          取消
                        </button>
                      </div>
                      <StatusUpdateImageAttach
                        disabled={loading}
                        previewUrl={statusAttachPreviewUrl}
                        fileName={statusAttachFile?.name ?? null}
                        dragActive={statusAttachDragActive}
                        onDragActive={setStatusAttachDragActive}
                        onPickFile={handleStatusAttachPick}
                      />
                    </div>
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>
      </section>

      <section
        id="staff-shipment-list"
        style={{
          display: activeSection === "staff-shipment-list" ? "block" : "none",
          border: "1px solid #e5e7eb",
          borderLeft: "4px solid #d1d5db",
          borderRadius: 12,
          padding: 16,
          background: "#fcfcfd",
          boxShadow: "0 1px 3px rgba(15,23,42,0.06)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, color: "#111827" }}>运单列表</h2>
            <p style={{ margin: "6px 0 0", fontSize: 12, color: "#64748b" }}>
              表格展示运单号、用户、状态、加收金额、运输方式、发货时间、件重体、仓库与地址；点击「查看」或 + 展开查看详情与物流轨迹。
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShipmentListCollapsed((v) => !v)}
            style={{
              border: "1px solid #d1d5db",
              borderRadius: 8,
              padding: "6px 10px",
              color: "#374151",
              background: "#fff",
              fontWeight: 600,
            }}
          >
            {shipmentListCollapsed ? "展开" : "折叠"}
          </button>
        </div>
        {!shipmentListCollapsed ? (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: 8,
                marginBottom: 10,
              }}
            >
              <input
                value={shipmentSearch.batchNo}
                onChange={(e) => setShipmentSearch((prev) => ({ ...prev, batchNo: e.target.value }))}
                placeholder="柜号"
                style={orderCreateInputStyle}
              />
              <input
                value={shipmentSearch.clientName}
                onChange={(e) => setShipmentSearch((prev) => ({ ...prev, clientName: e.target.value }))}
                placeholder="客户名"
                style={orderCreateInputStyle}
              />
              <input
                value={shipmentSearch.itemName}
                onChange={(e) => setShipmentSearch((prev) => ({ ...prev, itemName: e.target.value }))}
                placeholder="品名"
                style={orderCreateInputStyle}
              />
              <input
                value={shipmentSearch.trackingNo}
                onChange={(e) => setShipmentSearch((prev) => ({ ...prev, trackingNo: e.target.value }))}
                placeholder="湘泰运单号"
                style={orderCreateInputStyle}
              />
              <input
                value={shipmentSearch.domesticTrackingNo}
                onChange={(e) => setShipmentSearch((prev) => ({ ...prev, domesticTrackingNo: e.target.value }))}
                placeholder="国内单号"
                style={orderCreateInputStyle}
              />
              <input
                value={shipmentSearch.packageCount}
                onChange={(e) => setShipmentSearch((prev) => ({ ...prev, packageCount: e.target.value }))}
                placeholder="包裹数量"
                style={orderCreateInputStyle}
              />
              <input
                value={shipmentSearch.productQuantity}
                onChange={(e) => setShipmentSearch((prev) => ({ ...prev, productQuantity: e.target.value }))}
                placeholder="产品数量"
                style={orderCreateInputStyle}
              />
              <input
                value={shipmentSearch.weightKg}
                onChange={(e) => setShipmentSearch((prev) => ({ ...prev, weightKg: e.target.value }))}
                placeholder="重量"
                style={orderCreateInputStyle}
              />
              <input
                value={shipmentSearch.volumeM3}
                onChange={(e) => setShipmentSearch((prev) => ({ ...prev, volumeM3: e.target.value }))}
                placeholder="体积"
                style={orderCreateInputStyle}
              />
              <div style={{ position: "relative", width: "100%" }}>
                <input
                  type="date"
                  className="staff-shipment-date-input"
                  value={shipmentSearch.arrivedAt}
                  onChange={(e) => setShipmentSearch((prev) => ({ ...prev, arrivedAt: e.target.value }))}
                  style={{ ...orderCreateInputStyle, padding: "8px 64px 8px 10px", boxSizing: "border-box", marginBottom: 0 }}
                />
                {!shipmentSearch.arrivedAt ? (
                  <div
                    style={{
                      position: "absolute",
                      right: 10,
                      top: "50%",
                      transform: "translateY(-50%)",
                      fontSize: 12,
                      color: "#94a3b8",
                      pointerEvents: "none",
                      whiteSpace: "nowrap",
                    }}
                  >
                    到仓日期
                  </div>
                ) : null}
              </div>
              <select
                value={shipmentSearch.warehouseId}
                onChange={(e) => setShipmentSearch((prev) => ({ ...prev, warehouseId: e.target.value }))}
                style={orderCreateInputStyle}
              >
                <option value="">国内仓库（全部）</option>
                {warehouseOptions.map((warehouse) => (
                  <option key={warehouse.id} value={warehouse.id}>
                    {warehouse.label}
                  </option>
                ))}
              </select>
              <select
                value={shipmentSearch.logisticsStatus}
                onChange={(e) => setShipmentSearch((prev) => ({ ...prev, logisticsStatus: e.target.value }))}
                style={orderCreateInputStyle}
              >
                <option value="">物流状态（全部）</option>
                {logisticsStatusOptions.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
              <input
                value={shipmentSearch.trackingNo}
                onChange={(e) => setShipmentSearch((prev) => ({ ...prev, trackingNo: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") runShipmentListSearch();
                }}
                placeholder="运单号"
                style={orderCreateInputStyle}
              />
              <button
                type="button"
                onClick={runShipmentListSearch}
                style={{
                  border: "none",
                  borderRadius: 8,
                  padding: "8px 18px",
                  color: "#fff",
                  background: "#2563eb",
                  fontWeight: 600,
                  cursor: "pointer",
                  marginBottom: 8,
                  alignSelf: "end",
                  height: 38,
                  boxSizing: "border-box",
                }}
              >
                搜索
              </button>
            </div>
            {/* 运单列表第二行筛选：装柜号、运输方式、地址与金额等 */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: 8,
                marginBottom: 10,
              }}
            >
              <input
                value={shipmentSearch.containerNo}
                onChange={(e) => setShipmentSearch((prev) => ({ ...prev, containerNo: e.target.value }))}
                placeholder="装柜号"
                style={orderCreateInputStyle}
              />
              <select
                value={shipmentSearch.transportMode}
                onChange={(e) => setShipmentSearch((prev) => ({ ...prev, transportMode: e.target.value }))}
                style={orderCreateInputStyle}
              >
                <option value="">运输方式（全部）</option>
                <option value="sea">海运</option>
                <option value="land">陆运</option>
              </select>
              <input
                value={shipmentSearch.receiverAddress}
                onChange={(e) => setShipmentSearch((prev) => ({ ...prev, receiverAddress: e.target.value }))}
                placeholder="收货地址（关键词）"
                style={orderCreateInputStyle}
              />
              <div style={{ position: "relative", width: "100%" }}>
                <input
                  type="date"
                  className="staff-shipment-date-input"
                  value={shipmentSearch.shipDate}
                  onChange={(e) => setShipmentSearch((prev) => ({ ...prev, shipDate: e.target.value }))}
                  style={{ ...orderCreateInputStyle, padding: "8px 64px 8px 10px", boxSizing: "border-box", marginBottom: 0 }}
                />
                {!shipmentSearch.shipDate ? (
                  <div
                    style={{
                      position: "absolute",
                      right: 10,
                      top: "50%",
                      transform: "translateY(-50%)",
                      fontSize: 12,
                      color: "#94a3b8",
                      pointerEvents: "none",
                      whiteSpace: "nowrap",
                    }}
                  >
                    发货日期
                  </div>
                ) : null}
              </div>
              <input
                value={shipmentSearch.receivableAmount}
                onChange={(e) => setShipmentSearch((prev) => ({ ...prev, receivableAmount: e.target.value }))}
                placeholder="加收金额（数字片段）"
                style={orderCreateInputStyle}
              />
              <input
                value={shipmentSearch.statusRaw}
                onChange={(e) => setShipmentSearch((prev) => ({ ...prev, statusRaw: e.target.value }))}
                placeholder="运单状态（系统原文，模糊）"
                style={orderCreateInputStyle}
              />
            </div>
            <div style={{ marginBottom: 12, display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={() =>
                  setShipmentSearch({
                    batchNo: "",
                    clientName: "",
                    itemName: "",
                    trackingNo: "",
                    domesticTrackingNo: "",
                    packageCount: "",
                    productQuantity: "",
                    weightKg: "",
                    volumeM3: "",
                    arrivedAt: "",
                    warehouseId: "",
                    logisticsStatus: "",
                    containerNo: "",
                    transportMode: "",
                    receiverAddress: "",
                    shipDate: "",
                    receivableAmount: "",
                    statusRaw: "",
                  })
                }
                style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "8px 14px", background: "#fff" }}
              >
                清空筛选
              </button>
              <button
                type="button"
                onClick={exportShipmentsToExcel}
                disabled={filteredShipmentList.length === 0}
                style={{
                  border: "none",
                  borderRadius: 8,
                  padding: "8px 14px",
                  color: "#fff",
                  background: filteredShipmentList.length === 0 ? "#94a3b8" : "#2563eb",
                  cursor: filteredShipmentList.length === 0 ? "not-allowed" : "pointer",
                }}
              >
                导出Excel
              </button>
            </div>
            <div style={{ marginBottom: 10, color: "#475569", fontSize: 13 }}>
              搜索结果数量：共 {filteredShipmentList.length} 条
            </div>
            {shipments.length === 0 ? (
              <EmptyStateCard title="暂无运单数据" description="先创建订单或等待系统分配运单后，这里会展示可操作记录。" />
            ) : filteredShipmentList.length === 0 ? (
              <EmptyStateCard title="没有匹配结果" description="请调整搜索条件后重试。" />
            ) : (
              <div
                id="staff-shipment-list-table-wrap"
                style={{ overflowX: "auto", border: "1px solid #e2e8f0", borderRadius: 10, background: "#fff" }}
              >
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 1180 }}>
                  <thead>
                    <tr style={{ background: "#f1f5f9", textAlign: "left", borderBottom: "2px solid #e2e8f0" }}>
                      <th style={{ padding: "10px 8px", width: 44 }} />
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
                    {filteredShipmentList.map((item) => (
                      <Fragment key={item.id}>
                        <tr style={{ borderBottom: "1px solid #e2e8f0", background: shipmentTableExpandedId === item.id ? "#eff6ff" : "#fff" }}>
                          <td style={{ padding: "8px 6px", verticalAlign: "middle" }}>
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
                          <td style={{ padding: "8px 6px", fontWeight: 600, color: "#1e3a8a", whiteSpace: "nowrap" }}>{item.trackingNo}</td>
                          <td style={{ padding: "8px 6px", color: "#334155" }}>{item.clientName ?? item.clientId ?? "—"}</td>
                          <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>{shipmentStatusZh(item.currentStatus)}</td>
                          <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>
                            {item.receivableAmountCny != null
                              ? `${item.receivableCurrency === "THB" ? "THB" : "CNY"} ${item.receivableAmountCny.toFixed(2)}`
                              : "0"}
                          </td>
                          <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>{transportModeLabel(item.transportMode)}</td>
                          <td style={{ padding: "8px 6px", whiteSpace: "nowrap", color: "#64748b" }}>
                            {item.shipDate ?? (item.arrivedAt ? item.arrivedAt.slice(0, 10) : "—")}
                          </td>
                          <td style={{ padding: "8px 6px" }}>{item.packageCount ?? "—"}</td>
                          <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>{formatMetric(item.weightKg, 2)}</td>
                          <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>{formatMetric(item.volumeM3)}</td>
                          <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>{formatMetric(item.volumeM3)}</td>
                          <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>{warehouseLabelFromId(item.warehouseId)}</td>
                          <td style={{ padding: "8px 6px", color: "#475569", fontSize: 12, maxWidth: 160 }} title={item.receiverAddressTh ?? ""}>
                            {truncateText(item.receiverAddressTh, 24)}
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
                              onClick={() => {
                                setActiveSection("staff-status-update");
                                window.location.hash = "staff-status-update";
                                setStatusSearch((prev) => ({ ...prev, batchNo: item.batchNo ?? "" }));
                                setStatusHasSearched(true);
                                setEditingShipmentId(null);
                                setEditingBatchNo(null);
                              }}
                              style={{ border: "none", background: "transparent", color: "#2563eb", cursor: "pointer", fontWeight: 600, padding: 0 }}
                            >
                              物流轨迹
                            </button>
                          </td>
                        </tr>
                        {shipmentTableExpandedId === item.id ? (
                          <tr>
                            <td colSpan={14} style={{ padding: 0, background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                              <div style={{ padding: 14 }}>
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
                                                    color: "#1f2937",
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
                                              disabled={formDisabled}
                                              style={inputInCard}
                                              onChange={async (e) => {
                                                const next = e.target.value;
                                                if (next === currentShipmentStatus) return;
                                                setLoading(true);
                                                setMessage("");
                                                try {
                                                  await updateStaffShipmentStatus({
                                                    shipmentId: item.id,
                                                    toStatus: next,
                                                    remark: "",
                                                  });
                                                  const items = await loadPageData();
                                                  const u = items.find((s) => s.id === item.id);
                                                  if (u) {
                                                    setShipmentOrderEditDrafts((prev) => ({
                                                      ...prev,
                                                      [item.id]: buildShipmentOrderEditDraft(u),
                                                    }));
                                                  }
                                                  setToast("运单状态已更新");
                                                } catch (error) {
                                                  const text = error instanceof Error ? error.message : "更新失败";
                                                  setMessage(`运单状态更新失败：${text}`);
                                                } finally {
                                                  setLoading(false);
                                                }
                                              }}
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
                                              style={{ ...inputInCard, color: "#64748b", background: "#f8fafc" }}
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
                                                disabled={formDisabled}
                                                style={{ fontSize: 12, color: "#475569" }}
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
                                              <span style={{ fontSize: 11, color: "#94a3b8" }}>上传后写入入库拍照记录</span>
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
                                    images={item.productImages ?? []}
                                    canManage={false}
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
                                          background: item.orderId ? "#059669" : "#94a3b8",
                                          cursor: item.orderId ? "pointer" : "not-allowed",
                                          fontWeight: 600,
                                        }}
                                      >
                                        保存订单信息
                                      </button>
                                      <button
                                        type="button"
                                        disabled={loading}
                                        onClick={() => {
                                          setActiveSection("staff-status-update");
                                          window.location.hash = "staff-status-update";
                                          setStatusSearch((prev) => ({ ...prev, batchNo: item.batchNo ?? "" }));
                                          setStatusHasSearched(true);
                                          setEditingShipmentId(item.id);
                                          setStatusEditDraft({ toStatus: toLogisticsStatus(item.currentStatus), remark: "" });
                                        }}
                                        style={{
                                          border: "none",
                                          borderRadius: 8,
                                          padding: "8px 14px",
                                          color: "#fff",
                                          background: "#1e3a8a",
                                          cursor: "pointer",
                                          fontWeight: 600,
                                        }}
                                      >
                                        去修改物流状态
                                      </button>
                                    </>
                                  ) : null}
                                  <button
                                    type="button"
                                    disabled={loading}
                                    onClick={() => setShipmentTableExpandedId(null)}
                                    style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "8px 14px", background: "#fff", color: "#475569" }}
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
        ) : null}
      </section>

      {message ? <p style={{ marginTop: 12, color: message.includes("失败") ? "#b91c1c" : "#065f46" }}>{message}</p> : null}
      <Toast open={toast.length > 0} message={toast} />
    </RoleShell>
  );
}
