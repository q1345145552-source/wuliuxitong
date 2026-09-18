"use client";

import { matchesShipmentListFilter } from "../../../../../packages/shared-types/shipment-status";
import { productNamesLabel } from "../../../../../packages/shared-types/product-names";
import { cargoTypeLabel } from "../../../../../packages/shared-types/cargo-type";
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { formatCny } from "../../modules/billing/billing-utils";
import ShipmentSearch from "../../modules/shipment/ShipmentSearch";
import { openPrintLabel } from "../../modules/shipment/ShipmentPrintLabel";
import { openShipmentTrack } from "../../modules/shipment/ShipmentTrackModal";
import ShipmentExportPanel from "../../modules/shipment/ShipmentExportPanel";
import ShipmentStatusGroups, { type ShipmentGroupFilter } from "../../modules/shipment/ShipmentStatusGroups";
import { ShipmentOverviewStrip } from "../../modules/shipment/ShipmentOverviewStrip";
import {
  GridColgroup,
  ProductListDetailCell,
  PRODUCT_LIST_COL_WIDTHS,
  PRODUCT_DETAIL_HEADS,
  buildProductDetailRows,
  totalPackageCountOf,
  totalVolumeOf,
  totalWeightOf,
  gridThStyle,
  gridTdStyle,
} from "../../modules/shipment/ShipmentTableGrid";
import { validateProductRows, packageCountForPayload } from "../../modules/orders/productRowGuard";
import { optionalIntegerForReceive, optionalNumberForReceive, validateReceiveDraft } from "../../modules/staff/utils";
import EmptyStateCard from "../../modules/layout/EmptyStateCard";
import DetailModal from "../../modules/layout/DetailModal";
import Toast from "../../modules/layout/Toast";
import { apiBaseUrl, authHeaders, parseApiResponse, fetchWithSession as fetch } from "../../services/core-api";
import { createRequestGate } from "../../modules/shared/request-gate";
import { viewerCanSeeOperator } from "../../auth/operator-visibility";
import LastmileAddressPanel from "../../components/lastmile/LastmileAddressPanel";
import {
  receiveStaffPrealert,
  createStaffOrder,
  deleteStaffOrderProductImage,
  fetchStaffClients,
  fetchStaffInboundPhotos,
  fetchStaffPrealerts,
  fetchStaffShipments,
  fetchStaffShipmentOverview,
  type StaffShipmentOverview,
  fetchShipmentImages,
  patchStaffShipmentOrderBundle,
  repairStaffShipmentOrderLinks,
  type RepairStaffShipmentOrderLinksResult,
  setStaffShipmentContainer,
  type OrderItem,
  type OrderProductImageItem,
  type StaffInboundPhotoItem,
  type ShipmentItem,
  uploadStaffInboundPhoto,
  uploadStaffOrderProductImage,
  fetchStaffWalletBalances,
  type StaffWalletBalanceItem,
  fetchLastmileShipments,
  fetchShippingConfig,
} from "../../services/business-api";
import {
  type OrderProductImagesPanelProps,
  type ShipmentOrderEditDraft,
  STAFF_SECTION_IDS,
  type StaffSectionId,
  type PrealertEditDraft,
} from "../../modules/staff/types";
import StaffProductImagesPanel from "../../components/staff/StaffProductImagesPanel";
import ShipmentEditFormField from "../../components/staff/ShipmentEditFormField";
import StaffPrealertList from "../../components/staff/StaffPrealertList";
import type { PrealertSearchState } from "../../components/staff/StaffPrealertList";
import StaffLastmile from "../../components/staff/StaffLastmile";
import type { LastmileOrderItem, LastmileShipmentOption } from "../../modules/lastmile/types";
import FclInquiryPanel from "../../components/client/FclInquiryPanel";
import { SHIPMENT_STATUS_FILTER_OPTIONS } from "../../modules/shipment/shipment-status";
import {
  BATCH_SHEET_TO_JSON_OPTIONS,
  lastRowWithCells,
  formatStaffBatchErrorLocation,
  parseStaffBatchRows,
  type StaffBatchOrder,
} from "../../modules/staff/batchOrderImport";
import {
  shipmentStatusZh,
  warehouseLabelFromId,
  transportModeLabel,
  truncateText,
  formatMetric,
  volumeM3FromDimensionsCm,
  formatDateTime,
  formatVolumeM3String,
  shipmentShipDateToLocalInput,
  getValidShipmentStatusTargets,
  formatRepairShipmentOrderLinkToast,
  buildShipmentOrderEditDraft,
  buildPrealertDraft,
  SHIPMENT_STATUS_FLOW,
  SHIPMENT_EXCEPTION_STATUSES,
  shipmentStatusWithPartialZh,
} from "../../modules/staff/utils";

/* 员工端运单列表的列宽。排版规则见 modules/shipment/ShipmentTableGrid.tsx。
   ⚠️ 第 5~9 个必须和 PRODUCT_LIST_COL_WIDTHS 完全一致。
   紧跟在产品明细块后面的 80 是「总箱数」，它和体积、重量一样是整单的合计数，
   所以放在会滚动的明细块外面 —— 放进去会跟着产品一起滚上去看不见。 */
const SHIPMENT_COL_WIDTHS = [
  44, 110, 130, 120,
  ...PRODUCT_LIST_COL_WIDTHS,
  80, 100, 90, 90, 110, 170, 190,
] as const;
const SHIPMENT_TABLE_MIN_WIDTH = SHIPMENT_COL_WIDTHS.reduce((a, b) => a + b, 0);
/** 弹性列＝「备注」（表头第 15 个）。备注是长文字，宽一点正好少截断几个字。
 *  ⚠️ 调整列顺序时这个下标要跟着改。 */
const SHIPMENT_FLEX_COL_INDEX = 14;

/**
 * 从运单的产品行里取长/宽/高，拼成能放进 Excel 一个格子的值（2026-08-27 加）。
 *
 * 为什么要拼：长宽高是记在「产品行」上的，一张运单可能有好几个产品、尺寸各不相同，
 * 而导出是一行一张运单。实测 97% 的运单只有一个产品，所以：
 *   · 只有一个尺寸  → 直接出数字（Excel 里能求和、能排序）
 *   · 有好几个不同的 → 用「/」并排，例如 60/50，一个都不丢
 *   · 一个都没填    → 出「-」，跟这张表其它列的空值写法一致
 */
/** 批量导入的上限：整个文件要读进浏览器内存解析，太大会把页面卡死（2026-08-27 加） */
const BATCH_MAX_FILE_MB = 5;
const BATCH_MAX_FILE_BYTES = BATCH_MAX_FILE_MB * 1024 * 1024;
const BATCH_MAX_ROWS = 2000;
/** 错误清单最多显示多少条（其余靠「复制全部」带走）。2026-08-29 加 */
const BATCH_MAX_SHOWN_ERRORS = 200;

/** 清空查询只重置现有筛选字段，不改日期或运输状态口径。 */
const EMPTY_SHIPMENT_SEARCH = {
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
  };

function productDim(
  products: Array<{ lengthCm?: number | null; widthCm?: number | null; heightCm?: number | null }> | undefined,
  key: "lengthCm" | "widthCm" | "heightCm",
): number | string {
  const vals = (products ?? []).map((p) => p[key]).filter((v): v is number => v != null);
  if (vals.length === 0) return "-";
  const uniq = Array.from(new Set(vals));
  return uniq.length === 1 ? uniq[0] : uniq.join("/");
}

export default function StaffHomePage() {
  const [staffClients, setStaffClients] = useState<Array<{ id: string; name: string }>>([]);
  const warehouseOptions = [
    { id: "wh_yiwu_01", label: "义乌仓" },
    { id: "wh_guangzhou_01", label: "广州仓" },
    { id: "wh_dongguan_01", label: "东莞仓" },
  { id: "wh_shenzhen_01", label: "深圳仓" },
  ];
  /* 运单列表「按状态筛选」的选项。2026-08-13 改成从流程表生成（唯一定义处在
     modules/shipment/shipment-status.ts）—— 原来这里写死 10 个，加状态没人回来改，
     实测缺 16 个，陆运那五步从上线起就一直筛不到。**别再改回写死。** */
  const logisticsStatusOptions = SHIPMENT_STATUS_FILTER_OPTIONS;
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
  /* 顶部那排数字。拉不到就整排不显示 —— 宁可不显示，
     也不能显示一个假的 0 让人以为「今天没有延迟的」。 */
  const [shipmentOverview, setShipmentOverview] = useState<StaffShipmentOverview | null>(null);
  useEffect(() => {
    fetchStaffShipmentOverview().then(setShipmentOverview).catch(() => setShipmentOverview(null));
  }, []);
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
  const [shipmentSearch, setShipmentSearch] = useState(EMPTY_SHIPMENT_SEARCH);
  const [shipmentGroup, setShipmentGroup] = useState<ShipmentGroupFilter>("all");
  const [copyNotice, setCopyNotice] = useState("");
  const [exporting, setExporting] = useState(false);
  const exportInFlight = useRef(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showBatchImport, setShowBatchImport] = useState(false);
  // 读 Excel 的门闩：换文件 / 关弹窗 / 卸载后，慢文件晚到的结果不许回填（2026-09-05 复查：原来手写序号，改用统一门闩）
  const batchReadGate = useRef(createRequestGate()).current;
  const [batchFileReading, setBatchFileReading] = useState(false);
  useEffect(() => () => { batchReadGate.cancel(); }, [batchReadGate]);
  const [batchRows, setBatchRows] = useState<StaffBatchOrder[]>([]);
  const [batchSourceRowCount, setBatchSourceRowCount] = useState(0);
  /**
   * 已经建成功的运单号（2026-08-27 加）。
   * 批量创建是一票一票发的，不是一个整体事务 —— 100 票在第 60 票失败时，
   * 前 59 票**已经存进数据库了**。以前用户只能把整份表重传，结果那 59 票
   * 全部提示「运单号已存在」，看着像出了大问题。
   * 记下来之后，再点一次只补剩下的，不会重复创建。
   */
  const [batchDoneNos, setBatchDoneNos] = useState<Set<string>>(new Set());
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ current: 0, success: 0, fail: 0 });
  const [batchErrors, setBatchErrors] = useState<string[]>([]);
  const [batchFileName, setBatchFileName] = useState("");
  const [batchConfirmed, setBatchConfirmed] = useState(false);
  const [shipmentSearchCollapsed, setShipmentSearchCollapsed] = useState(true);
  const [selectedForExport, setSelectedForExport] = useState<Set<string>>(new Set());
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [staffFormProducts, setStaffFormProducts] = useState<Array<{
    itemName: string; packageCount: string; lengthCm: string; widthCm: string; heightCm: string; productQuantity: string; weightKg: string; cargoType: string; domesticTrackingNo: string;
  }>>([]);
  const [orderImageFiles, setOrderImageFiles] = useState<File[]>([]);
  const [orderImagePreviews, setOrderImagePreviews] = useState<string[]>([]);
  const [approvingPrealert, setApprovingPrealert] = useState<OrderItem | null>(null);
  // 确认收货弹窗内的常驻报错（2026-08-31 排查条目43）：原来用 2.2 秒就消失的 Toast，
  // 60 多字的校验提示根本读不完；改成弹窗里一直显示的红字，改好并提交成功前不消失。
  const [receiveModalError, setReceiveModalError] = useState("");
  // 2026-08-31（排查报告 41）：原来这里有 splittingShipment / splitRows 两个状态和配套的
  // 「运单分柜」弹窗——但全页没有任何入口能打开它（开关只被关过、从没被打开过），
  // 分柜功能早已搬到装柜管理页，这里是搬家漏删的死代码，整块删掉。

  // 尾端地址那一整块（state / 加载 / 增删改 / 备注）2026-08-29 抽到了
  // components/lastmile/LastmileAddressPanel.tsx —— 员工端和管理员端共用一份，
  // 免得像尾端派送那样两端各写各的、改一个漏另一个（CLAUDE.md 第 20 条）。

  const [form, setForm] = useState({
    clientId: "",
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
    cargoType: "normal",
    remark: "",
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

  /**
   * 弹窗版尺寸输入（2026-08-31 排查条目15 复查补丁）：弹窗的「总体积」允许手填，
   * 而 updateOrderDimensions 在长宽高没填全时会把体积直接清空 —— 员工手填了总体积、
   * 随手在「长」里补个数，总体积当场被清。这里照弹窗「包裹数量」框那套守卫：
   * 长宽高填全了才重算体积，没填全就只更新那一格、不动 volumeM3。
   * ⚠️ 守卫按**本次输入后**的值判断（不能拿闭包里的旧 form 判，否则填完最后一格不会触发重算）。
   */
  const updateModalOrderDimension = (patch: Partial<Pick<typeof form, "lengthCm" | "widthCm" | "heightCm">>) => {
    setForm((prev) => {
      const next = { ...prev, ...patch };
      const l = Number(String(next.lengthCm).trim());
      const w = Number(String(next.widthCm).trim());
      const h = Number(String(next.heightCm).trim());
      if (Number.isFinite(l) && Number.isFinite(w) && Number.isFinite(h) && l > 0 && w > 0 && h > 0) {
        const pkg = Number(String(next.packageCount).trim());
        const singleVolume = volumeM3FromDimensionsCm(l, w, h);
        next.volumeM3 = formatVolumeM3String(Number.isFinite(pkg) && pkg > 0 ? singleVolume * pkg : singleVolume);
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
    /** 2026-09-02 终审整改：这张照片是「读取出发那一刻」为哪个运单选的（照片会话）。上传前必须核对它 === 即将上传的运单号 */
    forShipmentId: "",
  });
  const [photoList, setPhotoList] = useState<StaffInboundPhotoItem[]>([]);
  /** 2026-09-01 竞态全扫：入库照片要「认主人」。查 A 的照片期间把输入框改成 B，
      A 的响应后到会把 A 的照片摆在 B 的单号下面。响应落地时核对「此刻输入框里的
      运单号」还是不是出发时那个，不是就整段丢弃。每次渲染同步一次最新值。 */
  const photoShipmentIdRef = useRef("");
  photoShipmentIdRef.current = photoDraft.shipmentId.trim();
  /** 2026-09-02 终审整改：入库照片文件读取的门闩。换运单号时 begin() 作废在途读取，
      防止「读 A 的照片期间换成 B，FileReader 回调把 A 的图塞进 B 的草稿」。 */
  const photoReadGate = useRef(createRequestGate()).current;
  /** 2026-09-02 终审整改：换运单号时要把文件选择框也清空，否则草稿清了、输入框还显示旧文件名 */
  const photoFileInputRef = useRef<HTMLInputElement>(null);
  // 2026-09-16 导航根治：从别的页面点菜单跳进来带着 #（例如仓库版 → /admin#orders）时，首帧就选对分区，
  // 不先闪一下默认分区。本页只在外壳核验完登录之后才挂载（那时一定在浏览器里），可以直接读地址。
  const [activeSection, setActiveSection] = useState<StaffSectionId>(() => {
    const hashId = typeof window === "undefined" ? "" : window.location.hash.replace(/^#/, "");
    return (STAFF_SECTION_IDS as readonly string[]).includes(hashId) ? (hashId as StaffSectionId) : "staff-prealert-review";
  });

  const [lmShipments, setLmShipments] = useState<LastmileShipmentOption[]>([]);
  const [lmShipmentsLoading, setLmShipmentsLoading] = useState(false);
  const [lmShipmentsError, setLmShipmentsError] = useState("");
  const loadLmShipments = async () => {
    // 2026-08-06：原来是自己拼 `?pageSize=500&all=1` 再在前端筛状态 ——
    // 只拿到第 1 页 500 条（所有状态混着排），571 张能派送的里只到 126 张，漏了 445 张。
    // 改为统一走 fetchLastmileShipments()：后端按状态筛 + 翻页拿完。
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
  const [lmOrderList, setLmOrderList] = useState<LastmileOrderItem[]>([]);
  const [lmOrdersLoading, setLmOrdersLoading] = useState(false);
  const [lmOrdersError, setLmOrdersError] = useState("");
  // 【审查问题 3】走 parseApiResponse：401 会自动跳登录页
  const loadLmOrders = async () => {
    setLmOrdersLoading(true);
    setLmOrdersError("");
    try {
      const response = await fetch(`${apiBaseUrl()}/admin/lastmile/orders`, { headers: authHeaders() });
      const data = await parseApiResponse<{ items: LastmileOrderItem[] }>(response);
      setLmOrderList(data.items ?? []);
    } catch (e) {
      console.error(e);
      setLmOrdersError(e instanceof Error ? e.message : "未知错误");
    } finally {
      setLmOrdersLoading(false);
    }
  };

  // 客户余额
  const [walletBalances, setWalletBalances] = useState<StaffWalletBalanceItem[]>([]);
  const loadWalletBalances = async () => {
    try {
      const data = await fetchStaffWalletBalances();
      setWalletBalances(data.balances);
    } catch (e) { console.error(e); }
  };

  // 按派送单号分组，检查是否全部签收
  
  const isSamePrealertDraft = (a: PrealertEditDraft, b: PrealertEditDraft): boolean =>
    a.warehouseId === b.warehouseId &&
    a.itemName === b.itemName &&
    a.packageCount === b.packageCount &&
    a.packageUnit === b.packageUnit &&
    a.productQuantity === b.productQuantity &&
    a.weightKg === b.weightKg &&
    a.volumeM3 === b.volumeM3 &&
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
    // 【审查问题 10】同 admin：原来 Number() 超 15 位丢精度，改成按位数+字符串比
    shipmentItems.sort((a, b) => {
      const an = (a.trackingNo ?? "").replace(/\D/g, "").replace(/^0+/, "");
      const bn = (b.trackingNo ?? "").replace(/\D/g, "").replace(/^0+/, "");
      if (an.length !== bn.length) return bn.length - an.length;
      return bn.localeCompare(an);
    });
    setStaffClients(clientItems);
    setShipments(shipmentItems.filter(s => !s.parentTrackingNo));
    setPrealerts(prealertItems);
    // 2026-08-31（排查报告 44）：这里原来还调了一次 loadLmOrders() —— 页面一打开会和下面那个
    // useEffect 各拉一遍派送订单，而且之后每次保存订单/传图（loadPageData 的所有调用方）都会
    // 把几百条派送单白拉一遍。派送订单跟本函数刷新的数据无关：首次加载走 useEffect，
    // 尾端派送页签内用 StaffLastmile 的 onReloadOrders 自己刷，所以删掉。
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
        warehouseId: draft.warehouseId.trim(),
        remark: draft.remark?.trim() || null,
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
    let cancelled = false;
    setLoading(true);
    loadPageData()
      .catch((error) => {
        if (cancelled) return;
        const text = error instanceof Error ? error.message : "加载失败";
        setMessage(`加载失败：${text}`);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { loadLmOrders(); loadLmShipments(); }, []);

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

  const isStaffSectionId = (value: string): value is StaffSectionId =>
    STAFF_SECTION_IDS.includes(value as StaffSectionId);

  useEffect(() => {
    const syncSectionByHash = () => {
      const hashId = window.location.hash.replace(/^#/, "");
      if (isStaffSectionId(hashId)) {
        setActiveSection(hashId);
      } else if (!hashId) {
        // 地址里没有 #（例如后退回最初打开的 /staff）就回默认分区，否则地址和显示的分区对不上
        setActiveSection("staff-prealert-review");
      }
    };
    syncSectionByHash();
    window.addEventListener("hashchange", syncSectionByHash);
    return () => window.removeEventListener("hashchange", syncSectionByHash);
  }, []);

  const submitOrder = async () => {
    if (loading) return;
    const hasProducts = staffFormProducts.length > 0 && staffFormProducts.some((p) => p.itemName.trim());
    const itemName = hasProducts ? staffFormProducts[0].itemName.trim() : form.itemName.trim();
    const batchNo = form.batchNo.trim();
    const arrivedAt = form.arrivedAt.trim();
    // ⚠️ 不许 `|| 1`（2026-08-29 改）：箱数没填就该是 0、就该被下面那道校验拦住，
    // 悄悄当成 1 箱会让重量/方数/产品数量三个合计一起错，而且错得很像真的。
    const packageCount = hasProducts
      ? staffFormProducts.reduce((s, p) => s + (Number(String(p.packageCount).trim()) || 0), 0)
      : Number(form.packageCount.trim());
    const productQuantityText = form.productQuantity.trim();
    const productQuantity = productQuantityText ? Number(productQuantityText) : undefined;
    const volumeM3 = Number(form.volumeM3.trim());
    const weightKg = Number(form.weightKg.trim());

    if (hasProducts) {
      const rowIssue = validateProductRows(staffFormProducts.filter((p) => p.itemName.trim()));
      if (rowIssue) { setMessage(rowIssue); return; }
    }

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
        remark: form.remark?.trim() || undefined,
        products: hasProducts ? staffFormProducts.filter(p => p.itemName.trim()).map(p => ({ itemName: p.itemName.trim(), packageCount: packageCountForPayload(p.packageCount), lengthCm: p.lengthCm ? Number(p.lengthCm) : undefined, widthCm: p.widthCm ? Number(p.widthCm) : undefined, heightCm: p.heightCm ? Number(p.heightCm) : undefined, productQuantity: p.productQuantity ? Number(p.productQuantity) : undefined, weightKg: p.weightKg ? Number(p.weightKg) : undefined, cargoType: (p.cargoType || "normal").toLowerCase(), domesticTrackingNo: p.domesticTrackingNo.trim() || "货拉拉" })) : undefined,
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
      const displayNo = form.trackingNo.trim() || "已创建";
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
        transportMode: "sea" as "sea" | "land", cargoType: "normal", arrivedAt: "", clientId: "",
        packageCount: "", volumeM3: "", weightKg: "", productQuantity: "",
        lengthCm: "", widthCm: "", heightCm: "",
        remark: "",
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
      // 2026-08-28 改名：原来叫「产品数量」，员工容易当成「这一行一共几个」来填，
      // 而系统要的是「每箱几个」（跟旁边的「单箱重量kg」同一个口径）。
      // ⚠️ 不能叫「单箱数量」—— 那四个字里含有「箱数」，
      //    而解析表头是**包含匹配**，「箱数」那一列会被认成数量列（实测算出 49 而不是 35）。
      // 解析器新旧两个表头都认，老模板下载过的文件不受影响。
      "每箱几个": "",
      /**
       * 货型（2026-09-11 老板点的）。以前模板没有这一列、代码写死普货，
       * 仓库表里填了「商检」的货导进来全变普货，要人工一张张改。
       * ⚠️ 这一列**加在最后**，不插在中间 —— 员工手上有按老模板列序粘数据的文件，
       *    中间插一列会让粘进来的数据整体错位（比加一列认错列更惨）。
       *    放在最后时老文件顶多是这一格空着，空着就是普货，跟改之前一模一样。
       */
      "货型（普货/商检货/敏感货，默认普货）": "",
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
      { wch: 30 },  // 货型
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "员工批量下单模板");
    /**
     * ⚠️ 说明这一页 2026-08-29 重写过，因为原来那 5 条跟代码实际行为对不上，
     * 而对不上的每一条都真的坑过人（详见 batchOrderImport.ts 里各处注释）：
     *   · 没写「不要自己加列」—— 员工加一列「总箱数」就能把方数从 0.5 算成 9.9
     *   · 没写仓库只能填哪四个 —— 少打一个「仓」字会静默存进库
     *   · 没写日期只认哪几种写法 —— 填 2026/8/1 要到提交时才一张张失败
     *   · 「单箱重量kg *」标着必填，代码却当选填
     */
    const instructions = XLSX.utils.aoa_to_sheet([
      ["填写说明"],
      ["1. Excel 每一行代表一种产品或一种尺寸；同一运单号的多行会自动合并成一张运单。"],
      ["2. 同一运单的第二行起，运单号、唛头、仓库、到仓日期、运输方式和包装类型可以留空，系统会继承上一行。"],
      ["3. 同一运单的唛头、仓库、到仓日期、运输方式和包装类型必须一致，不一致会报错。"],
      ["4. 长宽高按单箱填写；总体积按每行 长×宽×高×箱数 后求和。单箱重量也会乘箱数后求和。"],
      ["5. 如果填写尺寸，同一运单的每条产品都需要填写完整的长、宽、高。"],
      ["6.〔重要〕请不要自己增加、删除或改名任何一列。多加一列（比如「总箱数」「货物长度」）会让系统认错列，方数和箱数会算成完全不同的数字。要做小计请另开一个工作表。"],
      ["7. 带 * 的都是必填：唛头、运单号、仓库、品名、箱数、单箱重量kg、到仓日期、运输方式。少填会在上传时当场报错。"],
      ["8. 仓库只能填这四个之一：义乌仓 / 广州仓 / 东莞仓 / 深圳仓。"],
      ["9. 到仓日期写成 2026-08-29；2026/08/29、2026.08.29、2026年8月29日 也认。不要写成 29/08/2026。"],
      ["10.「每箱几个」填的是「一箱里装几个」，不是这一行一共几个。系统会自动乘箱数。举例：5 箱、每箱 7 个，这里填 7，系统算出总数 35。"],
      ["11. 数字格可以带单位（100cm、10kg、5箱 都认），但不要写成「1米」「40*30」这种，系统会当场报错让你改。"],
      ["12.「货型」留空就是普货；商检货填「商检货」，敏感货填「敏感货」。填别的字（比如「普通货物」「危险品」）会在上传时当场报错，不会悄悄变成普货。"],
      ["13. 同一运单的几行可以填不同货型，按行各自记；运单那一层会记最严的那个（敏感货 > 商检货 > 普货）。"],
    ]);
    instructions["!cols"] = [{ wch: 110 }];
    XLSX.utils.book_append_sheet(wb, instructions, "填写说明");
    XLSX.writeFile(wb, "员工批量下单模板.xlsx");
  }
  async function submitStaffBatch() {
    setBatchLoading(true);
    setBatchErrors([]);
    setBatchProgress({ current: 0, success: 0, fail: 0 });
    const errors: string[] = [];
    let success = 0;
    const done = new Set(batchDoneNos);
    // 已经建成功的直接跳过：重试时不会重复创建，也不会再报「运单号已存在」
    const pending = batchRows.filter((row) => !done.has(row.trackingNo));
    success = batchRows.length - pending.length;
    /**
     * 2026-08-31 排查条目42：「继续创建」时进度不能从 1 重新数。
     * 已成功 60 再点继续，显示「第 1/100」会让员工以为在从头重建
     * （之前正好出过重传全报「运单号已存在」的吓人事，容易中途乱操作）。
     * 把已跳过的成功数加进「第几个」，显示成「第 61/100」。
     */
    const alreadyDone = success;
    for (let i = 0; i < pending.length; i++) {
      setBatchProgress({ current: alreadyDone + i + 1, success, fail: errors.length });
      const row = pending[i];
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
          // 运单这一层的货型（2026-09-11）：不传的话后端按 "normal" 兜底，整批又全成普货
          cargoType: row.cargoType,
          products: row.products,
        });
        success++;
        done.add(row.trackingNo);
        setBatchDoneNos(new Set(done));
        setBatchProgress({ current: alreadyDone + i + 1, success, fail: errors.length });
      } catch (err) {
        const text = err instanceof Error ? err.message : "提交失败";
        const location = formatStaffBatchErrorLocation(
          `Excel 第${row.sourceRows.join("、")}行`,
          row.trackingNo,
          row.clientId,
        );
        errors.push(`${location}：${text}`);
        setBatchErrors([...errors]);
        setBatchProgress({ current: alreadyDone + i + 1, success, fail: errors.length });
      }
    }
    setBatchLoading(false);
    setBatchErrors(errors);
    await loadPageData();
  }


  /**
   * ⚠️ 这里原来有个 `receivePrealert(orderId)` 函数（约 57 行），**没有任何调用方**。
   * 第十一轮复核指出它是死代码。
   *
   * 我上一轮还专门给它补了校验 —— 补在一段**永远不会执行**的代码上，
   * 纯属白做，而且会误导下一个人以为「这条路已经加固过了」。
   * 真正在用的确认收货入口有两个：
   *   · 本文件 ~2426 那个弹窗
   *   · apps/web/src/app/admin/prealerts/page.tsx
   * 删掉它，别留着当摆设。（2026-08-29）
   */


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
    const source = prealerts.find((item) => item.id === orderId);
    setPrealertConfirmedDrafts((prev) => ({ ...prev, [orderId]: draft }));
    setEditingPrealertId(null);
    setToast("修改已确认");
    // 2026-08-31 排查条目15（复查补丁）：页面级提示改成「带成功才绿」之后，
    // 这条是全页唯一不带「成功」二字的成功提示，补上字样免得被染红
    setMessage(`预报单 ${source?.orderNo || orderId} 修改确认成功。`);
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
        border: "1px solid var(--l-soft)",
        borderRadius: 10,
        padding: 10,
        background: "var(--white)",
      }}
    >
      <div style={{ color: "var(--t-strong)", fontSize: 12, marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );

  const InfoItem = ({ label, value }: { label: string; value: string }) => (
    <div
      style={{
        border: "1px solid var(--l-soft)",
        borderRadius: 6,
        background: "var(--s-alt)",
        padding: "3px 6px",
      }}
    >
      <div style={{ fontSize: 10, color: "var(--t-strong)" }}>{label}</div>
      <div style={{ fontSize: 12, color: "var(--t-strong)", fontWeight: 600 }}>{value}</div>
    </div>
  );

  const prealertEditInputStyle = {
    border: "1px solid var(--l-strong)",
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
        const searchText = `${item.id} ${item.orderNo ?? ""} ${item.clientId ?? ""} ${item.clientName ?? ""}`.toLowerCase();
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
      if (!matchesShipmentListFilter(item.currentStatus, shipmentGroup)) return false;
      const batchNo = (item.batchNo ?? "").toLowerCase();
      const clientName = `${item.clientName ?? ""} ${item.clientId ?? ""}`.toLowerCase();
      /* 按品名搜要认**全部产品名**（2026-09-11）：item.itemName 只存了第一个产品名，
         一票「鞋 / 包 / 帽」的货搜「帽」原来一条都搜不到。存的那个名也留在草堆里，
         产品行被改过名时老关键词照样能命中。口径跟国内单号那一行一致（上面几行）。 */
      const itemName = `${productNamesLabel(item.products, item.itemName)} ${item.itemName ?? ""}`.toLowerCase();
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
  }, [shipments, shipmentSearch, shipmentGroup]);

  // 按当前结果计数；刷新后失去的勾选项不参与导出，也不回退成「导出全部」（2026-09-05 复查：跟管理员端同一道）
  const selectedResultShipments = useMemo(
    () => filteredShipmentList.filter((s) => selectedForExport.has(s.trackingNo)),
    [filteredShipmentList, selectedForExport],
  );
  const allResultShipmentsSelected = filteredShipmentList.length > 0 && selectedResultShipments.length === filteredShipmentList.length;

  /**
   * 运单列表：点击「搜索」后提示当前筛选条数并滚动至结果表格。
   */
  const runShipmentListSearch = () => {
    setToast(`共 ${filteredShipmentList.length} 条运单`);
    document.getElementById("staff-shipment-list-table-wrap")?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "nearest",
    });
  };

  const copyShipmentNumber = async (number: string) => {
    setCopyNotice("");
    try {
      await navigator.clipboard.writeText(number);
      setCopyNotice(`已复制单号 ${number}`);
    } catch {
      setCopyNotice(`复制未完成，请手动选择并复制单号 ${number}`);
    }
  };

  const orderCreateInputStyle = {
    border: "1px solid var(--l-strong)",
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
    if (allResultShipmentsSelected) {
      setSelectedForExport(new Set());
    } else {
      setSelectedForExport(new Set(filteredShipmentList.map((s) => s.trackingNo)));
    }
  };

  const totalPages = Math.max(1, Math.ceil(filteredShipmentList.length / pageSize));
  // 列表刷新后变短（比如翻到第 5 页时改了一条状态、分组只剩 2 页），页码要跟着回夹，否则显示「第 5/2 页」空表。跟管理员端同一道。
  useEffect(() => { setCurrentPage((page) => Math.min(page, totalPages)); }, [totalPages]);
  const pagedShipments = useMemo(() => {
    const offset = (currentPage - 1) * pageSize;
    return filteredShipmentList.slice(offset, offset + pageSize);
  }, [filteredShipmentList, pageSize, currentPage]);

  // 搜索条件变化时清空选中并重置页码
  useEffect(() => { setSelectedForExport(new Set()); setCurrentPage(1); }, [shipmentSearch]);

  const [shipmentExportFeedback, setShipmentExportFeedback] = useState("");
  const [exportDateFrom, setExportDateFrom] = useState("");
  const [exportDateTo, setExportDateTo] = useState("");

  const exportShipmentsToExcel = async () => {
    let source = selectedForExport.size > 0 ? selectedResultShipments : filteredShipmentList;
    if (source.length === 0) { setMessage("当前没有可导出的运单数据。"); setShipmentExportFeedback("当前没有可导出的运单数据。"); return; }
    // 日期筛选
    if (exportDateFrom) source = source.filter((s) => (s.shipDate ?? s.arrivedAt ?? "").slice(0,10) >= exportDateFrom);
    if (exportDateTo) source = source.filter((s) => (s.shipDate ?? s.arrivedAt ?? "").slice(0,10) <= exportDateTo);
    if (source.length === 0) { setMessage("所选日期范围内没有运单。"); setShipmentExportFeedback("所选日期范围内没有运单。"); return; }
    /* 2026-08-31（排查报告 24）：「计费体积」的低消原来写死海运 0.5 / 陆运 0.2，
       跟管理员「运费配置」里填的数对不上（配置默认陆运就是 0.3，改过就差更多）。
       改成导出前读一次配置（/admin/shipping/config，staff 也有权限）；
       读不到就不做低消调整，并把列名标注成「未按低消调整」——绝不再用写死的数。 */
    let minVolumeMap: Record<string, number> | null = null;
    try {
      const config = await fetchShippingConfig();
      const seaMin = Number(config.sea_min_volume);
      const landMin = Number(config.land_min_volume);
      if (Number.isFinite(seaMin) && seaMin >= 0 && Number.isFinite(landMin) && landMin >= 0) {
        minVolumeMap = { sea: seaMin, land: landMin };
      }
    } catch (e) {
      console.error(e); // 拿不到配置时走下面「未按低消调整」的列名，不中断导出
    }
    const billedVolumeCol = minVolumeMap ? "计费体积" : "计费体积(未按低消调整)";
    const rows = source.map((item) => ({
      // 导出的品名带全部产品名（2026-09-11，同尾端派送单那次的口径）
      运单号: item.trackingNo ?? "-", 品名: productNamesLabel(item.products, item.itemName) || "-",
      // 货型（2026-09-11 老板点的）：一票多条产品行货型不同时去重拼起来
      货型: cargoTypeLabel((item.products ?? []).map((p) => p.cargoType), item.cargoType),
      归属用户: item.clientName ?? item.clientId ?? "-",
      运单状态: shipmentStatusZh(item.currentStatus),
      加收金额: item.receivableAmountCny != null ? `${item.receivableCurrency === "THB" ? "THB" : "CNY"} ${item.receivableAmountCny}` : "0",
      运输方式: transportModeLabel(item.transportMode),
      发货时间: item.shipDate ?? formatDateTime(item.arrivedAt, "-"),
      总件数: item.packageCount ?? "-", 总重量: item.weightKg ?? "-", 总体积: item.volumeM3 ?? "-",
      长cm: productDim(item.products, "lengthCm"),
      宽cm: productDim(item.products, "widthCm"),
      高cm: productDim(item.products, "heightCm"),
      [billedVolumeCol]: item.volumeM3 != null && item.volumeM3 > 0 ? Math.max(item.volumeM3, minVolumeMap?.[item.transportMode ?? ""] ?? 0).toFixed(3) : "-",
      所属仓库: warehouseLabelFromId(item.warehouseId),
      收货地址: truncateText(item.receiverAddressTh, 40),
      柜号: item.batchNo ?? "-", 国内单号: item.domesticTrackingNo ?? "-",
      产品数量: item.productQuantity ?? "-", 到仓日期: formatDateTime(item.arrivedAt, "-"),
      可编辑: item.canEdit ? "是" : "否", 更新时间: item.updatedAt ?? "-",
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "运单列表");
    XLSX.writeFile(wb, `运单列表_${new Date().toISOString().slice(0,10)}.xlsx`);
    setToast(`已导出 ${rows.length} 条`);
    setShipmentExportFeedback(`已导出 ${rows.length} 条`);
  };

  const exportDateInvalid = !!(exportDateFrom && exportDateTo && exportDateFrom > exportDateTo);
  const handleShipmentExport = async () => {
    // 同一轮渲染连续点击也只生成一次文件；不改原来的选中/日期取数规则。
    if (exportInFlight.current || exportDateInvalid) return;
    exportInFlight.current = true;
    setExporting(true);
    setShipmentExportFeedback("");
    try {
      await exportShipmentsToExcel();
    } catch (error) {
      setMessage(`导出失败：${error instanceof Error ? error.message : "请稍后重试"}`);
      setShipmentExportFeedback(`导出失败：${error instanceof Error ? error.message : "请稍后重试"}`);
    } finally {
      exportInFlight.current = false;
      setExporting(false);
    }
  };

  // ⚠️ allowedRole 必须带 admin。管理员菜单里的「整柜询价」指向 /staff#staff-fcl，
  // 这一页原来写死只准 staff，管理员一点就被弹回管理员工作台，等于按钮是死的。
  // 员工端另外三页（装柜管理、集货拼柜、集货拼柜仓库版）本来就是 ["staff","admin"]，
  // 后端那 37 个 /staff 接口也全是 ["staff","admin"] —— 只有这一页漏了（2026-08-11 修）。
  return (
    <>

      {/*
        2026-08-07 补回：a661165「运单不再涉及金额」那次清理，把这块「预报单审核」
        的渲染整段删掉了（组件本身和 import 都还在，只是没人再用它）。
        结果是菜单里点「预报单审核」跳到 #staff-prealert-review，页面上却没有这个区块 ——
        接口照常返回数据，员工看到的是一片空白。
      */}
      <StaffPrealertList
        visible={activeSection === "staff-prealert-review"}
        prealerts={prealerts}
        filteredPrealerts={filteredPrealerts}
        prealertSearch={prealertSearch as PrealertSearchState}
        onPrealertSearchChange={(key, val) => setPrealertSearch((prev) => ({ ...prev, [key]: val }))}
        prealertPanelCollapsed={prealertPanelCollapsed}
        onToggleCollapse={() => setPrealertPanelCollapsed((v) => !v)}
        prealertEditDrafts={prealertEditDrafts}
        setPrealertEditDrafts={setPrealertEditDrafts}
        prealertConfirmedDrafts={prealertConfirmedDrafts}
        editingPrealertId={editingPrealertId}
        setEditingPrealertId={setEditingPrealertId}
        prealertBatchDrafts={prealertBatchDrafts}
        setPrealertBatchDrafts={setPrealertBatchDrafts}
        loading={loading}
        warehouseOptions={warehouseOptions}
        onConfirmPrealertEdit={confirmPrealertEdit}
        onApprovePrealert={(item) => { setReceiveModalError(""); setApprovingPrealert(item); }}
        onUploadImage={(orderId, file) => { void uploadOrderProductImageAndReload(orderId, file); }}
        onDeleteImage={(imageId) => { void deleteOrderProductImageAndReload(imageId); }}
      />

      <section
        id="staff-create-order"
        style={{
          display: activeSection === "staff-create-order" ? "block" : "none",
          border: "1px solid var(--l-soft)",
          borderLeft: "4px solid var(--l-strong)",
          borderRadius: 12,
          padding: 16,
          marginBottom: 18,
          background: "#F0F1F4",
          boxShadow: "0 1px 3px rgba(15,23,42,0.06)",
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: 18, color: "var(--t-heading)", marginBottom: 12 }}>创建订单（员工）</h2>
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
            style={{ ...orderCreateInputStyle, background: "var(--s-cool)", color: "var(--t-strong)", fontWeight: 600 }}
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
          <div style={{ border: "1px solid var(--l-soft)", borderRadius: 8, padding: 10, background: "var(--s-alt)" }}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, color: "var(--t-strong)" }}>产品列表</div>
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
                <input value={p.itemName} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], itemName: e.target.value }; setStaffFormProducts(n); }} placeholder="品名" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "3px 4px", fontSize: 11 }} />
                <input type="number" value={p.packageCount} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], packageCount: e.target.value }; setStaffFormProducts(n); }} placeholder="箱数" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "3px 4px", fontSize: 11, minWidth: 0 }} />
                <input type="number" step="0.01" value={p.lengthCm} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], lengthCm: e.target.value }; setStaffFormProducts(n); }} placeholder="长" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "3px 4px", fontSize: 11, minWidth: 0 }} />
                <input type="number" step="0.01" value={p.widthCm} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], widthCm: e.target.value }; setStaffFormProducts(n); }} placeholder="宽" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "3px 4px", fontSize: 11, minWidth: 0 }} />
                <input type="number" step="0.01" value={p.heightCm} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], heightCm: e.target.value }; setStaffFormProducts(n); }} placeholder="高" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "3px 4px", fontSize: 11, minWidth: 0 }} />
                <input type="number" value={p.productQuantity} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], productQuantity: e.target.value }; setStaffFormProducts(n); }} placeholder="单箱数量" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "3px 4px", fontSize: 11, minWidth: 0 }} />
                <input type="number" step="0.01" value={p.weightKg} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], weightKg: e.target.value }; setStaffFormProducts(n); }} placeholder="单箱重kg" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "3px 4px", fontSize: 11, minWidth: 0 }} />
                <select value={(p.cargoType || "normal").toLowerCase()} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], cargoType: e.target.value }; setStaffFormProducts(n); }} style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "3px 2px", fontSize: 11, background: "var(--white)", minWidth: 0 }}>
                  <option value="normal">普货</option>
                  <option value="inspection">商检货</option>
                  <option value="sensitive">敏感货</option>
                </select>
                <input value={p.domesticTrackingNo || ""} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], domesticTrackingNo: e.target.value }; setStaffFormProducts(n); }} placeholder="货拉拉" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "3px 4px", fontSize: 11, minWidth: 0 }} />
                <span style={{ fontSize: 10, color: prodVol > 0 ? "var(--c-blue)" : "var(--t-faint)", textAlign: "right", padding: "0 2px", whiteSpace: "nowrap" }}>{prodVol > 0 ? prodVol.toFixed(3) + "m³" : "—"}</span>
                <span style={{ fontSize: 10, color: prodWt > 0 ? "var(--c-blue)" : "var(--t-faint)", textAlign: "right", padding: "0 2px", whiteSpace: "nowrap" }}>{prodWt > 0 ? prodWt.toFixed(2) + "kg" : "—"}</span>
                <button type="button" onClick={() => setStaffFormProducts((v) => v.filter((_, j) => j !== i))} style={{ border: "1px solid #fca5a5", borderRadius: 4, padding: "2px 4px", fontSize: 10, background: "var(--white)", color: "var(--c-red-2)", cursor: "pointer", minWidth: 20 }}>×</button>
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
                <div style={{ fontSize: 12, fontWeight: 600, padding: "4px 0", color: "var(--c-blue)", textAlign: "right" }}>
                  合计：总体积 {totalVol.toFixed(3)}m³  |  总重量 {totalWt.toFixed(2)}kg
                </div>
              );
            })()}
            <button type="button" onClick={() => setStaffFormProducts((v) => [...v, { itemName: "", packageCount: "", lengthCm: "", widthCm: "", heightCm: "", productQuantity: "", weightKg: "", cargoType: "normal", domesticTrackingNo: "" }])} style={{ border: "1px dashed var(--c-blue)", borderRadius: 4, padding: "4px 10px", fontSize: 12, background: "var(--white)", color: "var(--c-blue)", cursor: "pointer", marginTop: 4 }}>+ 添加产品</button>
          </div>
          <div style={{ fontSize: 12, color: "var(--t-strong)", marginTop: 4 }}>
            输入长宽高和单箱重量后，体积和总重量在前端实时自动计算
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
          <div style={{ fontSize: 12, color: "var(--t-strong)", marginTop: -4, marginBottom: 4 }}>尺寸：厘米；体积（m³）= 长×宽×高 ÷ 1,000,000，自动填入下方。</div>
          <input type="number" step="0.01" value={form.weightKg} readOnly={staffFormProducts.length > 0} onChange={(e) => setForm((v) => ({ ...v, weightKg: e.target.value }))} placeholder="重量（kg）" style={orderCreateInputStyle} />
          <input
            type="text"
            readOnly
            value={form.volumeM3}
            placeholder="体积（m³，根据长宽高自动生成）"
            style={{ ...orderCreateInputStyle, color: "var(--t-strong)", background: "var(--s-cool)" }}
          />
          <div style={{ display: "grid", gap: 4 }}>
            <input type="date" value={form.arrivedAt} onChange={(e) => setForm((v) => ({ ...v, arrivedAt: e.target.value }))} style={orderCreateInputStyle} />
            <div style={{ fontSize: 12, color: "var(--t-strong)", marginTop: -6, marginBottom: 8 }}>说明：该日期为到仓日期</div>
          </div>
        </div>
        <div style={{ gridColumn: "1/-1", marginTop: 4 }}>
          <div style={{ fontSize: 11, color: "var(--t-strong)", marginBottom: 4 }}>备注</div>
          <input value={form.remark} onChange={(e) => setForm((v) => ({ ...v, remark: e.target.value }))} placeholder="备注（可选）" style={{ ...orderCreateInputStyle, width: "100%" }} />
        </div>

        <div style={{ marginTop: 10 }}>
          <button type="button" disabled={loading} onClick={() => void submitOrder()} style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "var(--white)", background: "var(--t-strong)" }}>
            创建订单
          </button>
        </div>
      </section>

      <section
        id="staff-ops-tools"
        style={{
          display: activeSection === "staff-ops-tools" ? "block" : "none",
          border: "1px solid var(--l-soft)",
          borderLeft: "4px solid #15803D",
          borderRadius: 12,
          padding: 16,
          marginBottom: 18,
          background: "var(--white)",
          boxShadow: "0 1px 3px rgba(15,23,42,0.06)",
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: 18, color: "var(--t-heading)", marginBottom: 12 }}>入库与标签工具</h2>
        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ border: "1px solid var(--c-green-bg)", borderRadius: 10, padding: 10, background: "#ecfdf5" }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>体积重量自动核算</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 8 }}>
              <input value={sizeDraft.lengthCm} onChange={(e) => setSizeDraft((v) => ({ ...v, lengthCm: e.target.value }))} placeholder="长(cm)" style={orderCreateInputStyle} />
              <input value={sizeDraft.widthCm} onChange={(e) => setSizeDraft((v) => ({ ...v, widthCm: e.target.value }))} placeholder="宽(cm)" style={orderCreateInputStyle} />
              <input value={sizeDraft.heightCm} onChange={(e) => setSizeDraft((v) => ({ ...v, heightCm: e.target.value }))} placeholder="高(cm)" style={orderCreateInputStyle} />
              <input value={sizeDraft.actualWeightKg} onChange={(e) => setSizeDraft((v) => ({ ...v, actualWeightKg: e.target.value }))} placeholder="实重(kg)" style={orderCreateInputStyle} />
            </div>
            <div style={{ marginTop: 6, fontSize: 13, color: "var(--c-green-deep)" }}>
              体积重 = L×W×H/6000 = {volumetricWeightKg.toFixed(2)} kg；计费重 = Max(实重, 体积重) ={" "}
              <strong>{chargeableWeightKg.toFixed(2)} kg</strong>
            </div>
          </div>

          <div style={{ border: "1px solid var(--c-blue-bg-2)", borderRadius: 10, padding: 10, background: "var(--c-blue-bg)" }}>
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
                style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "var(--white)", background: "var(--c-blue)" }}
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
                style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "var(--white)", background: "#B45309" }}
              >
                保存装柜号
              </button>
            </div>
          </div>

          <div style={{ border: "1px solid #fecaca", borderRadius: 10, padding: 10, background: "#fff1f2" }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>入库拍照（责任留档）</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 8 }}>
              <input
                value={photoDraft.shipmentId}
                onChange={(e) => {
                  // 2026-09-02 终审整改：换运单号 = 重新选图。三件事必须在这里同步做（不等重渲染/useEffect）：
                  // ① 认主人的 ref 立刻改成新值；② 作废在途的文件读取；③ 清掉已选照片（含文件选择框）
                  photoShipmentIdRef.current = e.target.value.trim();
                  photoReadGate.begin();
                  if (photoFileInputRef.current) photoFileInputRef.current.value = "";
                  setPhotoDraft((v) => ({ ...v, shipmentId: e.target.value, fileName: "", mime: "", contentBase64: "", forShipmentId: "" }));
                }}
                placeholder="运单ID（shipmentId）"
                style={orderCreateInputStyle}
              />
              <input value={photoDraft.note} onChange={(e) => setPhotoDraft((v) => ({ ...v, note: e.target.value }))} placeholder="备注（例如：外箱破损）" style={orderCreateInputStyle} />
              <input
                ref={photoFileInputRef}
                type="file"
                accept="image/*"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  // 2026-09-02 终审整改：出发时记住「此刻输入框里的运单号」并领号；
                  // 读完先验号（换单/重选都会作废旧读取）、再认主人（运单号变了整段作废），
                  // 防止读 A 的照片期间换成 B，回调把 A 的图片放进 B 的草稿。
                  const sessionShipmentId = photoShipmentIdRef.current;
                  const ticket = photoReadGate.begin();
                  try {
                    const contentBase64 = await readFileAsBase64(file);
                    if (!photoReadGate.isCurrent(ticket)) return;
                    if (photoShipmentIdRef.current !== sessionShipmentId) return;
                    setPhotoDraft((v) => ({
                      ...v,
                      fileName: file.name,
                      mime: file.type || "application/octet-stream",
                      contentBase64,
                      forShipmentId: sessionShipmentId,
                    }));
                  } catch {
                    if (!photoReadGate.isCurrent(ticket)) return;
                    setMessage("图片读取失败，请重新选择");
                  }
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
                  // 2026-09-01 竞态全扫：记住这次是给哪个运单传的，刷新照片时要认主人
                  const uploadShipmentId = photoDraft.shipmentId.trim();
                  // 2026-09-02 终审整改：提交前再核一次「照片会话的运单号 === 即将上传的运单号」，
                  // 不一致说明选图之后换过运单号（或选图时没填运单号），拒绝上传并要求重选
                  if (photoDraft.forShipmentId !== uploadShipmentId) {
                    setMessage("照片是给另一个运单选的（或选图时未填运单ID），请重新选择图片再上传");
                    return;
                  }
                  setLoading(true);
                  try {
                    await uploadStaffInboundPhoto({
                      shipmentId: uploadShipmentId,
                      fileName: photoDraft.fileName,
                      mime: photoDraft.mime,
                      contentBase64: photoDraft.contentBase64,
                      note: photoDraft.note.trim() || undefined,
                    });
                    const items = await fetchStaffInboundPhotos(uploadShipmentId);
                    // 响应回来时输入框已换成别的运单号 → A 的照片不许落到 B 的单号下面
                    if (photoShipmentIdRef.current === uploadShipmentId) setPhotoList(items);
                    setToast("入库照片已上传");
                  } catch (error) {
                    const text = error instanceof Error ? error.message : "上传失败";
                    setMessage(`上传失败：${text}`);
                  } finally {
                    setLoading(false);
                  }
                }}
                style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "var(--white)", background: photoDraft.shipmentId.trim() && photoDraft.fileName && photoDraft.contentBase64 ? "var(--c-red-2)" : "var(--t-strong)" }}
              >
                上传入库照片
              </button>
              <button
                type="button"
                disabled={loading}
                onClick={async () => {
                  if (!photoDraft.shipmentId.trim()) return;
                  setLoading(true);
                  // 2026-09-01 竞态全扫：查 A 期间把输入框改成 B，A 的响应后到不许落地
                  const queryShipmentId = photoDraft.shipmentId.trim();
                  try {
                    const items = await fetchStaffInboundPhotos(queryShipmentId);
                    if (photoShipmentIdRef.current === queryShipmentId) setPhotoList(items);
                  } finally {
                    setLoading(false);
                  }
                }}
                style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 14px", background: "var(--white)" }}
              >
                查询该运单照片
              </button>
            </div>
            {photoList.length > 0 ? (
              <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
                {photoList.map((item) => (
                  <div key={item.id} style={{ border: "1px solid #fecdd3", borderRadius: 8, padding: 8, background: "var(--white)" }}>
                    <div style={{ fontSize: 12, color: "var(--t-strong)" }}>
                      {/* 2026-09-15：「操作员 xxx」只给超级管理员显示（后端也只给管理员下发 operatorId） */}
                      {item.fileName} / {item.createdAt}{viewerCanSeeOperator() && item.operatorId ? ` / 操作员 ${item.operatorId}` : ""}
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
        className="staff-shipment-workbench"
        aria-labelledby="staff-shipment-heading"
        style={{ display: activeSection === "staff-order-shipment" ? "block" : "none" }}
      >
        <div className="staff-shipment-heading">
          <div>
            <h2 id="staff-shipment-heading">运单管理</h2>
          </div>
          <div className="staff-shipment-primary-actions">
            <button type="button" className="staff-workbench-button staff-workbench-button--primary" onClick={() => setShowCreateModal(true)}>
              创建订单
            </button>
            <button type="button" className="staff-workbench-button" onClick={() => setShowBatchImport(true)}>
              批量创建
            </button>
          </div>
        </div>
        <ShipmentOverviewStrip data={shipmentOverview} />
        <ShipmentStatusGroups
          value={shipmentGroup}
          onChange={(group) => {
            setShipmentGroup(group);
            setCurrentPage(1);
            setSelectedForExport(new Set());
          }}
        />
        <ShipmentSearch
          variant="workbench"
          value={shipmentSearch}
          onChange={(key, val) => setShipmentSearch((prev) => ({ ...prev, [key]: val }))}
          onSearch={runShipmentListSearch}
          onReset={() => setShipmentSearch({ ...EMPTY_SHIPMENT_SEARCH })}
          warehouseOptions={warehouseOptions}
          logisticsStatusOptions={logisticsStatusOptions}
          inputStyle={orderCreateInputStyle}
        />
        <div className="staff-shipment-results" id="staff-shipment-list-table-wrap">
          <div className="staff-shipment-results-meta">
            <span role="status" aria-live="polite">共 <strong>{filteredShipmentList.length}</strong> 条 · 第 {currentPage}/{totalPages} 页</span>
            {selectedForExport.size > 0 && (
              <span className="staff-shipment-selection">
                已选 {selectedResultShipments.length} 条（含其他页）
                {selectedForExport.size > selectedResultShipments.length && <span>另有 {selectedForExport.size - selectedResultShipments.length} 条已不在当前结果，不参与导出</span>}
                <button type="button" onClick={() => setSelectedForExport(new Set())}>取消选择</button>
              </span>
            )}
          </div>
          <div className="shipment-results-actions">
            <ShipmentExportPanel onOpen={() => setShipmentExportFeedback("")}>
              <div className="staff-shipment-export" role="group" aria-label="导出 Excel">
                <div className="staff-shipment-export-dates">
                  <label>导出起始日期<input type="date" value={exportDateFrom} onChange={(e) => { setExportDateFrom(e.target.value); setShipmentExportFeedback(""); }} /></label>
                  <span aria-hidden="true">—</span>
                  <label>导出截止日期<input type="date" value={exportDateTo} onChange={(e) => { setExportDateTo(e.target.value); setShipmentExportFeedback(""); }} /></label>
                </div>
                <button type="button" className="staff-workbench-button" disabled={filteredShipmentList.length === 0 || (selectedForExport.size > 0 && selectedResultShipments.length === 0) || exporting || exportDateInvalid} aria-describedby="staff-export-note" onClick={() => void handleShipmentExport()}>{exporting ? "导出中…" : "导出 Excel"}</button>
                <span className="staff-shipment-export-note" id="staff-export-note">{selectedForExport.size > 0 ? "仅导出当前结果中的已选运单，再按导出日期筛选" : "未勾选时导出全部筛选结果，再按导出日期筛选"}</span>
              </div>
              {exportDateInvalid && <p className="staff-shipment-export-error" role="alert">导出起始日期晚于截止日期，请调整日期范围。</p>}
                <p role="status" aria-live="polite" aria-atomic="true" style={{ margin: shipmentExportFeedback ? "12px 0 0" : 0, fontSize: 13 }}>{shipmentExportFeedback}</p>
            </ShipmentExportPanel>
            <nav className="staff-shipment-pagination" aria-label="运单列表分页">
              <button type="button" className="staff-workbench-button" onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={currentPage <= 1}>上一页</button>
              <span className="staff-shipment-page-number" aria-hidden="true">{currentPage} / {totalPages}</span>
              <button type="button" className="staff-workbench-button" onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage >= totalPages}>下一页</button>
              <label className="staff-shipment-page-size">
                <span className="staff-workbench-sr-only">每页条数</span>
                <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setCurrentPage(1); }}>
                  {[20, 50, 100, 200].map((n) => <option key={n} value={n}>{n} 条/页</option>)}
                </select>
              </label>
            </nav>
          </div>
        </div>
        <p className="staff-shipment-scroll-hint" id="staff-shipment-scroll-hint">宽表可左右滚动查看完整列；产品超过 3 项时，在产品明细区域上下滚动。</p>
        <div className="staff-shipment-copy-notice" role="status" aria-live="polite" aria-atomic="true">{copyNotice}</div>
          <>
            {shipments.length === 0 ? (
              <EmptyStateCard title="暂无运单数据" description="先创建订单或等待系统分配运单后，这里会展示可操作记录。" />
            ) : filteredShipmentList.length === 0 ? (
              <EmptyStateCard title="没有匹配结果" description="请调整搜索条件后重试。" />
            ) : (
              <div
                className="table-card staff-shipment-table-scroll"
                tabIndex={0}
                role="region"
                aria-label="运单列表，可横向与纵向滚动"
                aria-describedby="staff-shipment-scroll-hint"
              >
                {/* a3-table 只换外观（表头颜色、发丝分隔线、行 hover），**列和顺序一个不动**。
                    ⚠️ 表头/单元格用的 gridThStyle / gridTdStyle 是三端共用的行内样式，
                    不能直接改（改了管理员端和客户端一起变），所以在 globals.css 里
                    用 .a3-table 覆盖，行内样式优先级高，那边必须写 !important。 */}
                <table className="a3-table shipment-ledger-table shipment-ledger-table--staff" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, tableLayout: "fixed", minWidth: SHIPMENT_TABLE_MIN_WIDTH }}>
                  <GridColgroup widths={SHIPMENT_COL_WIDTHS} flexIndex={SHIPMENT_FLEX_COL_INDEX} />
                  <thead>
                    <tr style={{ background: "var(--s-cool-2)", textAlign: "left", borderBottom: "2px solid var(--l-cool)" }}>
                      {/* 产品明细共五列，整块同步滚动 */}
                      <th className="shipment-pin shipment-pin--check" scope="col" style={gridThStyle}>
                        <input type="checkbox" aria-label="选择全部筛选结果（包含其他页）" title="选择全部筛选结果，不限当前页" ref={(node) => { if (node) node.indeterminate = selectedResultShipments.length > 0 && !allResultShipmentsSelected; }} checked={allResultShipmentsSelected} onChange={toggleSelectAll} style={{ cursor: "pointer" }} />
                      </th>
                      <th className="shipment-pin shipment-pin--mark" scope="col" style={gridThStyle}>唛头</th>
                      <th className="shipment-pin shipment-pin--number" scope="col" style={gridThStyle}>运单号</th>
                      <th scope="col" className="shipment-current-status" style={gridThStyle}>物流状态</th>
                      <th scope="col" style={gridThStyle}>品名</th>
                      <th scope="col" style={gridThStyle}>箱数</th>
                      <th scope="col" style={gridThStyle}>长宽高(cm)</th>
                      <th scope="col" style={gridThStyle}>国内单号</th>
                      <th scope="col" style={gridThStyle}>货型</th>
                      <th scope="col" className="shipment-metric" style={gridThStyle}>总箱数</th>
                      <th scope="col" className="shipment-metric" style={gridThStyle}>体积 (m³)</th>
                      <th scope="col" className="shipment-metric" style={gridThStyle}>重量 (kg)</th>
                      <th scope="col" style={gridThStyle}>运输方式</th>
                      <th scope="col" style={gridThStyle}>到仓日期</th>
                      <th scope="col" style={gridThStyle}>备注</th>
                      <th scope="col" style={gridThStyle}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedShipments.map((item) => {
                      const detailRows = buildProductDetailRows(item);
                      return (
                      <Fragment key={item.id}>
                        <tr data-selected={selectedForExport.has(item.trackingNo) || undefined} style={{ borderBottom: "1px solid var(--l-cool)", background: shipmentTableExpandedId === item.id ? "var(--c-blue-bg)" : "var(--white)" }}>
                          <td className="shipment-pin shipment-pin--check" style={gridTdStyle}>
                            <input type="checkbox" aria-label={`选择运单 ${item.trackingNo}`} checked={selectedForExport.has(item.trackingNo)} onChange={() => toggleSelectShipment(item.trackingNo)} style={{ cursor: "pointer" }} />
                          </td>
                          <td className="shipment-pin shipment-pin--mark" style={{ ...gridTdStyle, fontWeight: 600, color: "#14171D", fontFamily: "monospace", fontSize: 12 }}>{item.clientId ?? "—"}</td>
                          <td className="shipment-pin shipment-pin--number" style={gridTdStyle}>
                            <button type="button" className="staff-shipment-copy" title={`点击复制：${item.orderNo || item.trackingNo}`} aria-label={`复制单号 ${item.orderNo || item.trackingNo}`} onClick={() => void copyShipmentNumber(item.orderNo || item.trackingNo)}>
                              {item.orderNo || item.trackingNo}
                            </button>
                            {/* 明细块只露 3 行，这里写清楚一共几项，免得员工不知道下面还有货 */}
                            <div className="staff-shipment-product-count">共 {detailRows.length} 项</div>
                          </td>
                          <td className="shipment-current-status" style={gridTdStyle}>{shipmentStatusWithPartialZh(item.currentStatus, item.partialAhead)}</td>
                          {/* 品名 / 箱数 / 长宽高 / 国内单号 / 货型：合并成一块，固定高度一起滚 */}
                          <ProductListDetailCell rows={detailRows} />
                          {/* 总箱数＝把左边「箱数」那一列加起来，省得多产品时人工心算 */}
                          <td className="shipment-metric" style={{ ...gridTdStyle, fontWeight: 600 }}>
                            {(() => {
                              const total = totalPackageCountOf(item);
                              return total != null ? `${total} 箱` : "—";
                            })()}
                          </td>
                          <td style={gridTdStyle} className="shipment-metric">{formatMetric(totalVolumeOf(item), 3)}</td>
                          <td style={gridTdStyle} className="shipment-metric">{formatMetric(totalWeightOf(item), 2)}</td>
                          <td style={gridTdStyle}>{transportModeLabel(item.transportMode)}</td>
                          <td style={{ ...gridTdStyle, color: "var(--t-strong)" }}>
                            {item.shipDate ?? formatDateTime(item.arrivedAt)}
                          </td>
                          <td style={gridTdStyle} title={item.remark || ""}>
                            {item.remark || ""}
                          </td>
                          <td style={gridTdStyle}>
                            <button
                              type="button"
                              onClick={() => {
                                setShipmentTableExpandedId((prev) => {
                                  if (prev === item.id) return null;
                                  setShipmentOrderEditDrafts((d) => ({ ...d, [item.id]: buildShipmentOrderEditDraft(item) }));
                                  // 原来加载产品图的逻辑在已删掉的 + 按钮里，挪到这里来，
                                  // 否则详情弹窗打开后图片是空的
                                  const oid = item.orderId;
                                  if (oid) {
                                    fetchShipmentImages(oid).then((imgs) => {
                                      setShipmentImagesCache((c) => ({ ...c, [oid]: imgs }));
                                    }).catch(() => {});
                                  }
                                  return item.id;
                                });
                              }}
                              className="row-act"
                            >
                              详情
                            </button>
                            <button
                              type="button"
                              onClick={() => openShipmentTrack({ trackingNo: item.trackingNo })}
                              className="row-act"
                            >
                              物流轨迹
                            </button>
                            <button
                              type="button"
                              onClick={() => openPrintLabel({ marks: item.clientId ?? "—", packageCount: item.packageCount ?? "—", trackingNo: item.trackingNo ?? "", itemName: item.itemName, productQuantity: item.productQuantity, transportMode: item.transportMode, products: item.products?.map(p => ({ itemName: p.itemName, packageCount: p.packageCount })) })}
                              className="row-act"
                            >
                              打印
                            </button>
                          </td>
                        </tr>
                        {shipmentTableExpandedId === item.id ? (
                          <tr>
                            {/* 详情改成全屏弹窗：这个格子只作挂载点，内容用 position:fixed 铺满屏幕，
                                所以格子本身不占高度，表格行不会被撑开 */}
                            <td colSpan={SHIPMENT_COL_WIDTHS.length} style={{ padding: 0, border: "none" }}>
                              <DetailModal
                                title="运单详情"
                                subtitle={item.trackingNo ?? "—"}
                                onClose={() => setShipmentTableExpandedId(null)}
                              >
                              <div>
                                {/* 隐藏信息栏：不用色块，靠一条细线跟下面分开 */}
                                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 24px", marginBottom: 14, paddingBottom: 12, borderBottom: "1px solid #eceae6", fontSize: 12, color: "#8B94A3" }}>
                                  <span>仓库：<strong>{warehouseLabelFromId(item.warehouseId)}</strong></span>
                                  <span>包装：<strong>{item.packageUnit === "bag" ? "袋" : "箱"}</strong></span>
                                  <span>国内单号：<strong>{(item.products?.length ?? 0) > 0 ? (item.products ?? []).map(p => p.domesticTrackingNo ?? "货拉拉").filter((v, i, a) => a.indexOf(v) === i).join("、") : (item.domesticTrackingNo ?? "—")}</strong></span>
                                  <span>加收金额：<strong>{item.receivableAmountCny != null ? `${item.receivableCurrency === "THB" ? "THB" : "CNY"} ${item.receivableAmountCny.toFixed(2)}` : "0"}</strong></span>
                                  <span>收货地址：<strong>{item.receiverAddressTh ?? "—"}</strong></span>
                                </div>
                                <div style={{ fontWeight: 700, marginBottom: 12, color: "#14171D" }}>运单详情（只读）</div>
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
                                        /* 原来是一行用「|」隔开的长串，43 个产品时根本读不了，改成一张表 */
                                        <div style={{ marginBottom: 12 }}>
                                          <div style={{ fontWeight: 600, color: "var(--t-strong)", fontSize: 12, marginBottom: 6 }}>
                                            货物明细 共 {detailRows.length} 项
                                          </div>
                                          <div style={{ maxHeight: 320, overflowY: "auto", border: "1px solid var(--l-cool)" }}>
                                            <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                                              <thead>
                                                <tr style={{ background: "var(--s-cool-2)", textAlign: "left" }}>
                                                  {["#", ...PRODUCT_DETAIL_HEADS].map((h) => (
                                                    <th key={h} style={{ padding: "4px 8px", border: "1px solid var(--l-cool)", whiteSpace: "nowrap", fontWeight: 600 }}>{h}</th>
                                                  ))}
                                                </tr>
                                              </thead>
                                              <tbody>
                                                {detailRows.map((r, i) => (
                                                  <tr key={i}>
                                                    {[String(i + 1), ...r].map((v, j) => (
                                                      <td key={j} style={{ padding: "4px 8px", border: "1px solid var(--l-cool)", whiteSpace: "nowrap", color: "var(--t-strong)" }}>{v}</td>
                                                    ))}
                                                  </tr>
                                                ))}
                                              </tbody>
                                            </table>
                                          </div>
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
                                                    color: "var(--t-strong)",
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
                                        </div>
                                        <div style={{ flex: "1 1 300px", display: "flex", flexDirection: "column", gap: 12 }}>
                                          <ShipmentEditFormField label="运单所属用户" required>
                                            <input
                                              value={item.clientName ?? item.clientId ?? "—"}
                                              readOnly
                                              style={{ ...inputInCard, color: "var(--t-strong)", background: "var(--s-cool)" }}
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
                                          <ShipmentEditFormField label="签收单">
                                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                              <input
                                                type="file"
                                                accept="image/*"
                                                style={{ fontSize: 12, color: "var(--t-strong)" }}
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
                                              <span style={{ fontSize: 11, color: "var(--t-strong)" }}>上传后写入入库拍照记录</span>
                                            </div>
                                          </ShipmentEditFormField>
                                          <ShipmentEditFormField label="备注">
                                            <input
                                              value={draft.remark}
                                              onChange={(e) => mergeShipmentOrderDraft(item.id, item, { remark: e.target.value })}
                                              placeholder="备注（可选）"
                                              style={inputInCard}
                                            />
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
                                  <StaffProductImagesPanel
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
                                          color: "var(--white)",
                                          background: item.orderId ? "var(--c-green)" : "var(--t-strong)",
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
                                    style={{ border: "1px solid #d8d6d1", borderRadius: 6, padding: "8px 16px", background: "var(--white)", color: "#14171D" }}
                                  >
                                    关闭
                                  </button>
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
          </>
      </section>

      <StaffLastmile
        visible={activeSection === "staff-lastmile"}
        lmShipments={lmShipments}
        lmOrderList={lmOrderList}
        ordersLoading={lmOrdersLoading}
        ordersError={lmOrdersError}
        shipmentsLoading={lmShipmentsLoading}
        shipmentsError={lmShipmentsError}
        onToast={setToast}
        onReloadOrders={loadLmOrders}
        onLoadShipments={loadLmShipments}
      />
      <section
        id="staff-address"
        style={{
          display: activeSection === "staff-address" ? "block" : "none",
          border: "1px solid var(--l-soft)",
          borderLeft: "4px solid var(--l-strong)",
          borderRadius: 12,
          padding: 16,
          marginBottom: 18,
          background: "#F0F1F4",
          boxShadow: "0 1px 3px rgba(15,23,42,0.06)",
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: 18, color: "var(--t-heading)", marginBottom: 12 }}>尾端地址</h2>
        <p style={{ fontSize: 12, color: "var(--t-strong)", marginBottom: 10 }}>客户端注册后自动同步唛头与派送地址。</p>
        {/* 搜索 / 列表 / 添加 / 编辑 / 删除 / 备注 全在这个共用组件里，管理员端用的是同一个 */}
        <LastmileAddressPanel onToast={setToast} />
      </section>


      {/* 2026-08-31 排查条目15（复查补丁）：原来只有带「失败」才红，侧边栏创建订单的校验拦截语
          （如「产品数量必须大于 0。」）不带这两个字，被显示成绿色、看着像成功。
          改成和弹窗那份一致：只有带「成功」才绿，其余一律红。 */}
      {message ? <p style={{ marginTop: 12, color: message.includes("成功") ? "var(--c-green-deep)" : "var(--c-red-deep)" }}>{message}</p> : null}
<Toast open={toast.length > 0} message={toast} />
      {/* 预报单审核弹窗 */}
      {approvingPrealert && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)", padding: 16 }}>
          <div style={{ width: "100%", maxWidth: 560, maxHeight: "90vh", overflow: "auto", background: "var(--white)", borderRadius: 12, padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
            <h3 style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 600 }}>审核预报单</h3>
            <div style={{ color: "var(--t-strong)", fontSize: 13, marginBottom: 12 }}>
              客户：{approvingPrealert.clientId ?? "-"} · {approvingPrealert.createdAt.slice(0, 10)}
            </div>
            {(approvingPrealert.products?.length ?? 0) > 1 && (
              <div style={{ marginBottom: 10, background: "#fefce8", borderRadius: 6, padding: "8px 10px", fontSize: 12 }}>
                <div style={{ fontWeight: 600, marginBottom: 4, color: "var(--t-strong)" }}>产品列表</div>
                {(approvingPrealert.products ?? []).map((p) => (
                  // 2026-08-31 排查条目50（复查补丁）：长宽高三个都有才拼，只填了长会显示「(60×null×nullcm)」
                  <div key={p.id} style={{ color: "var(--t-strong)" }}>{p.itemName} ×{p.packageCount}箱{p.lengthCm && p.widthCm && p.heightCm ? ` (${p.lengthCm}×${p.widthCm}×${p.heightCm}cm)` : ""}</div>
                ))}
              </div>
            )}
            <div style={{ display: "grid", gap: 6, fontSize: 13, color: "var(--t-strong)", marginBottom: 16 }}>
              <div>仓库：{warehouseOptions.find((w) => w.id === (prealertEditDrafts[approvingPrealert.id]?.warehouseId ?? approvingPrealert.warehouseId))?.label ?? "-"}</div>
              <div>品名：{prealertEditDrafts[approvingPrealert.id]?.itemName ?? approvingPrealert.itemName}</div>
              <div>件数：{prealertEditDrafts[approvingPrealert.id]?.packageCount ?? approvingPrealert.packageCount} {prealertEditDrafts[approvingPrealert.id]?.packageUnit ?? approvingPrealert.packageUnit}</div>
              <div>产品数量：{prealertEditDrafts[approvingPrealert.id]?.productQuantity ?? approvingPrealert.productQuantity}</div>
              <div>重量：{formatMetric(prealertEditDrafts[approvingPrealert.id]?.weightKg ?? approvingPrealert.weightKg, 2)} kg</div>
              <div>体积：{formatMetric(prealertEditDrafts[approvingPrealert.id]?.volumeM3 ?? approvingPrealert.volumeM3, 3)} m³</div>
              <div>国内单号：{prealertEditDrafts[approvingPrealert.id]?.domesticTrackingNo ?? approvingPrealert.domesticTrackingNo ?? "-"}</div>
              <div>运输方式：{(prealertEditDrafts[approvingPrealert.id]?.transportMode ?? approvingPrealert.transportMode) === "sea" ? "海运" : "陆运"}</div>
              <div>发货日期：{prealertEditDrafts[approvingPrealert.id]?.shipDate ?? approvingPrealert.shipDate ?? approvingPrealert.createdAt.slice(0, 10)}</div>
              <div style={{ marginTop: 8, borderTop: "1px solid var(--l-soft)", paddingTop: 8 }}>
                <div style={{ fontSize: 12, color: "var(--t-strong)", marginBottom: 4 }}>柜号（可选）</div>
                <input value={prealertBatchDrafts[approvingPrealert.id] ?? ""} onChange={(e) => setPrealertBatchDrafts((prev) => ({ ...prev, [approvingPrealert.id]: e.target.value }))} placeholder="柜号（装柜时填写）" style={prealertEditInputStyle} />
              </div>
            </div>
            {/* 2026-08-31 排查条目43：报错常驻在弹窗里（原来是 2.2 秒就消失、还长得像成功的 Toast，
                60 多字的提示根本读不完）。红字一直显示到员工改好重新提交，userSelect 让提示可以复制去问人。 */}
            {receiveModalError ? (
              <div style={{ marginBottom: 12, padding: "10px 12px", background: "#fef2f2", border: "1px solid var(--c-red-deep)", borderRadius: 8, color: "var(--c-red-deep)", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", userSelect: "text" }}>{receiveModalError}</div>
            ) : null}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" onClick={() => setApprovingPrealert(null)} style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 16px", fontSize: 13, background: "var(--white)", cursor: "pointer", color: "var(--t-strong)" }}>取消</button>
              <button type="button" onClick={async () => {
                const item = approvingPrealert;
                const draft = prealertEditDrafts[item.id] ?? buildPrealertDraft(item);
                const batchNo = (prealertBatchDrafts[item.id] ?? "").trim();
                setReceiveModalError("");
                /**
                 * ⚠️ 提交前先校验（2026-08-29 补）：这个弹窗以前**一道校验都没有**，
                 * draft 里的数字原样发出去。
                 */
                // ⚠️ 第二个参数是**这张单原来的**重量/体积 —— 用来识别
                //    「员工把原有的数清空了」，那种情况后端做不到清零，必须当场说清楚
                const draftIssue = validateReceiveDraft(draft, {
                  weightKg: (item as any).weightKg,
                  volumeM3: (item as any).volumeM3,
                });
                // 报错写进弹窗常驻红字，不用 Toast（2026-08-31 排查条目43：2.2 秒读不完长提示）
                if (draftIssue) { setReceiveModalError(draftIssue); return; }
                try {
                  await receiveStaffPrealert({
                    orderId: item.id,
                    itemName: draft.itemName,
                    packageCount: draft.packageCount,
                    packageUnit: draft.packageUnit,
                    // 空着或 0 → 不发（后端要求正整数，发 0 会被 400 打回来）
                    productQuantity: optionalIntegerForReceive(draft.productQuantity),
                    /**
                     * ⚠️ 重量和方数是**可填可不填**的：空着或 0 就根本不发这个字段。
                     * 后端的语义是「没传 = 不改」，不是「传 0 = 清零」。
                     * 生产库里有 8 张待确认收货的单子本来就没填重量/方数 ——
                     * 原来前端把它们当成 0 发出去，后端收紧之后这 8 张**确认不了收货**。
                     */
                    weightKg: optionalNumberForReceive(draft.weightKg),
                    volumeM3: optionalNumberForReceive(draft.volumeM3),
                    domesticTrackingNo: draft.domesticTrackingNo,
                    transportMode: draft.transportMode,
                    /* 2026-08-31 排查条目1 → 深夜老板重申「钱只在集货里」：
                       弹窗一度接过「应收金额」，当晚拆除——普通运单不录钱。柜号保留。 */
                    batchNo: batchNo || undefined,
                  });
                  setToast(`预报单 ${item.id} 确认收货`);
                  await loadPageData();
                  // ⚠️ **只有成功才关弹窗**（2026-08-29 改）。
                  // 原来这句在 try/catch 外面，失败也照样关 —— 员工只看到一闪而过的
                  // 提示，弹窗没了、填的东西也没了，根本不知道该改哪里。
                  setApprovingPrealert(null);
                } catch (error) {
                  const text = error instanceof Error ? error.message : "确认收货失败";
                  // 2026-08-31 排查条目43：服务器报错也走弹窗常驻红字，不再用一闪而过的 Toast
                  setReceiveModalError("确认收货失败：" + text);
                  // 失败时**保留弹窗和已填内容**，让员工照着提示改
                }
              }} style={{ border: "none", borderRadius: 6, padding: "8px 16px", fontSize: 13, background: "var(--c-blue)", color: "var(--white)", fontWeight: 500, cursor: "pointer" }}>确认收货</button>
            </div>
          </div>
        </div>
      )}

      {/* 创建订单弹窗 */}
      {showCreateModal ? (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)", padding: 16 }}>
          <div style={{ width: "100%", maxWidth: 1320, maxHeight: "90vh", overflow: "auto", background: "var(--white)", borderRadius: 12, padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
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
              <input value={allClientOptions.find((c) => c.id === form.clientId)?.id ?? form.clientId} readOnly style={{ ...orderCreateInputStyle, background: "var(--s-cool)", color: "var(--t-strong)", fontWeight: 600 }} placeholder="已选唛头" />
              <select value={form.warehouseId} onChange={(e) => setForm((v) => ({ ...v, warehouseId: e.target.value }))} style={orderCreateInputStyle}>
                {warehouseOptions.map((item) => (
                  <option key={item.id} value={item.id}>仓库：{item.label}</option>
                ))}
              </select>
              <input value={form.trackingNo} onChange={(e) => setForm((v) => ({ ...v, trackingNo: e.target.value }))} placeholder="运单号 *" style={orderCreateInputStyle} />
              <input value={form.batchNo} onChange={(e) => setForm((v) => ({ ...v, batchNo: e.target.value }))} placeholder="柜号（可选）" style={orderCreateInputStyle} />
              <div style={{ border: "1px solid var(--l-soft)", borderRadius: 8, padding: 10, background: "var(--s-alt)" }}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, color: "var(--t-strong)" }}>产品列表</div>
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
                    <input value={p.itemName} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], itemName: e.target.value }; setStaffFormProducts(n); }} placeholder="品名" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "3px 4px", fontSize: 11 }} />
                    <input type="number" value={p.packageCount} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], packageCount: e.target.value }; setStaffFormProducts(n); }} placeholder="箱数" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "3px 4px", fontSize: 11, minWidth: 0 }} />
                    <input type="number" step="0.01" value={p.lengthCm} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], lengthCm: e.target.value }; setStaffFormProducts(n); }} placeholder="长" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "3px 4px", fontSize: 11, minWidth: 0 }} />
                    <input type="number" step="0.01" value={p.widthCm} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], widthCm: e.target.value }; setStaffFormProducts(n); }} placeholder="宽" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "3px 4px", fontSize: 11, minWidth: 0 }} />
                    <input type="number" step="0.01" value={p.heightCm} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], heightCm: e.target.value }; setStaffFormProducts(n); }} placeholder="高" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "3px 4px", fontSize: 11, minWidth: 0 }} />
                    <input type="number" value={p.productQuantity} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], productQuantity: e.target.value }; setStaffFormProducts(n); }} placeholder="单箱数量" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "3px 4px", fontSize: 11, minWidth: 0 }} />
                    <input type="number" step="0.01" value={p.weightKg} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], weightKg: e.target.value }; setStaffFormProducts(n); }} placeholder="单箱重kg" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "3px 4px", fontSize: 11, minWidth: 0 }} />
                    <select value={(p.cargoType || "normal").toLowerCase()} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], cargoType: e.target.value }; setStaffFormProducts(n); }} style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "3px 2px", fontSize: 11, background: "var(--white)", minWidth: 0 }}>
                      <option value="normal">普货</option>
                      <option value="inspection">商检货</option>
                      <option value="sensitive">敏感货</option>
                    </select>
                    <input value={p.domesticTrackingNo || ""} onChange={(e) => { const n = [...staffFormProducts]; n[i] = { ...n[i], domesticTrackingNo: e.target.value }; setStaffFormProducts(n); }} placeholder="货拉拉" style={{ border: "1px solid var(--l-strong)", borderRadius: 4, padding: "3px 4px", fontSize: 11, minWidth: 0 }} />
                    <span style={{ fontSize: 10, color: prodVol > 0 ? "var(--c-blue)" : "var(--t-faint)", textAlign: "right", padding: "0 2px", whiteSpace: "nowrap" }}>{prodVol > 0 ? prodVol.toFixed(3) + "m³" : "—"}</span>
                    <span style={{ fontSize: 10, color: prodWt > 0 ? "var(--c-blue)" : "var(--t-faint)", textAlign: "right", padding: "0 2px", whiteSpace: "nowrap" }}>{prodWt > 0 ? prodWt.toFixed(2) + "kg" : "—"}</span>
                    <button type="button" onClick={() => setStaffFormProducts((v) => v.filter((_, j) => j !== i))} style={{ border: "1px solid #fca5a5", borderRadius: 4, padding: "2px 4px", fontSize: 10, background: "var(--white)", color: "var(--c-red-2)", cursor: "pointer", minWidth: 20 }}>×</button>
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
                    <div style={{ fontSize: 12, fontWeight: 600, padding: "4px 0", color: "var(--c-blue)", textAlign: "right" }}>
                      合计：总体积 {totalVol.toFixed(3)}m³  |  总重量 {totalWt.toFixed(2)}kg
                    </div>
                  );
                })()}
                <button type="button" onClick={() => setStaffFormProducts((v) => [...v, { itemName: "", packageCount: "", lengthCm: "", widthCm: "", heightCm: "", productQuantity: "", weightKg: "", cargoType: "normal", domesticTrackingNo: "" }])} style={{ border: "1px dashed var(--c-blue)", borderRadius: 4, padding: "4px 10px", fontSize: 12, background: "var(--white)", color: "var(--c-blue)", cursor: "pointer", marginTop: 4 }}>+ 添加产品</button>
              </div>
              <div style={{ fontSize: 12, color: "var(--t-strong)", marginTop: 4 }}>
                输入长宽高和单箱重量后，体积和总重量在前端实时自动计算
              </div>
              {/* 2026-08-31（排查报告 15）：弹窗里原来没有「包裹数量」「产品数量」和整单长宽高——
                  可提交校验偏偏要求它们大于 0，员工不加产品行就永远创建不了，报错还指向一个
                  页面上不存在的框。这里照侧边栏「创建订单」区块补齐同一套输入框。 */}
              <input type="number" value={form.packageCount} onChange={(e) => {
                /* 弹窗的「总体积」允许手填（和侧边栏不同）。updateOrderDimensions 在长宽高
                   没填全时会把体积清空，所以只有长宽高都填了才让箱数触发重算，
                   免得手填的体积被悄悄清掉。 */
                const hasDims = Number(form.lengthCm) > 0 && Number(form.widthCm) > 0 && Number(form.heightCm) > 0;
                if (hasDims) updateOrderDimensions({ packageCount: e.target.value });
                else setForm((v) => ({ ...v, packageCount: e.target.value }));
              }} placeholder="包裹数量 *" style={orderCreateInputStyle} />
              <input type="number" value={form.productQuantity} onChange={(e) => setForm((v) => ({ ...v, productQuantity: e.target.value }))} placeholder="产品数量 *" style={orderCreateInputStyle} />
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
                {/* 2026-08-31 排查条目15（复查补丁）：弹窗尺寸框走 updateModalOrderDimension——
                    没填全长宽高时不动 volumeM3，免得手填的总体积被悄悄清掉（和上面「包裹数量」框同一套守卫）。 */}
                <input type="number" min={0} step="0.01" value={form.lengthCm} onChange={(e) => updateModalOrderDimension({ lengthCm: e.target.value })} placeholder="长（cm）" style={orderCreateInputStyle} />
                <input type="number" min={0} step="0.01" value={form.widthCm} onChange={(e) => updateModalOrderDimension({ widthCm: e.target.value })} placeholder="宽（cm）" style={orderCreateInputStyle} />
                <input type="number" min={0} step="0.01" value={form.heightCm} onChange={(e) => updateModalOrderDimension({ heightCm: e.target.value })} placeholder="高（cm）" style={orderCreateInputStyle} />
              </div>
              <div style={{ fontSize: 12, color: "var(--t-strong)", marginTop: -4 }}>尺寸：厘米；填全长宽高后体积（m³）= 长×宽×高 ÷ 1,000,000 自动填入下方，也可直接手填总体积。</div>
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
              <div style={{ fontSize: 11, color: "var(--t-strong)", marginTop: -4 }}>到仓日期 *</div>
              <hr style={{ border: "none", borderTop: "1px solid var(--l-soft)", margin: "8px 0" }} />
            </div>
            {/* 产品图片上传 */}
            <div style={{ marginTop: 10, border: "1px dashed var(--l-strong)", borderRadius: 8, padding: 10 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6, color: "var(--t-strong)" }}>产品图片（可选，可多选）</div>
              <input type="file" multiple accept="image/*" onChange={(e) => {
                const files = Array.from(e.target.files || []);
                setOrderImageFiles(prev => [...prev, ...files]);
                setOrderImagePreviews(prev => [...prev, ...files.map(f => URL.createObjectURL(f))]);
              }} style={{ fontSize: 12 }} />
              {orderImagePreviews.length > 0 && (
                <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                  {orderImagePreviews.map((url, i) => (
                    <div key={i} style={{ position: "relative" }}>
                      <img src={url} style={{ width: 60, height: 60, objectFit: "cover", borderRadius: 4, border: "1px solid var(--l-soft)" }} />
                      <button type="button" onClick={() => {
                        setOrderImageFiles(f => f.filter((_, j) => j !== i));
                        setOrderImagePreviews(p => p.filter((_, j) => j !== i));
                      }} style={{ position: "absolute", top: -6, right: -6, border: "1px solid #fca5a5", borderRadius: 10, width: 18, height: 18, fontSize: 10, background: "var(--white)", color: "var(--c-red-2)", cursor: "pointer", padding: 0, lineHeight: 1 }}>×</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {/* ⚠️ 这里原来多了一个 </div>，白色弹窗在这一行就收掉了，
                下面的「备注 + 取消 + 创建订单」被挤成弹窗的兄弟，
                和弹窗并排摆在遮罩层里，跑到框外压住后面的页面（2026-08-11 修）。 */}
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, color: "var(--t-strong)", marginBottom: 4 }}>备注</div>
              <input value={form.remark} onChange={(e) => setForm((v) => ({ ...v, remark: e.target.value }))} placeholder="备注（可选）" style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 10px", width: "100%", fontSize: 13 }} />

            {/* 2026-08-31（排查报告 15）：原来只有带「失败」字样的提示才红，校验拦截语
                （如「产品数量必须大于 0」）不带这两个字，被显示成绿色、看着像成功。
                改成只有带「成功」字样才绿，其余一律红。 */}
            {message ? (
              <p style={{ marginTop: 8, color: message.includes("成功") ? "var(--c-green-deep)" : "var(--c-red-deep)", fontSize: 13 }}>{message}</p>
            ) : null}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button type="button" onClick={() => { setShowCreateModal(false); setMessage(""); setOrderImageFiles([]); setOrderImagePreviews([]); }} style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 16px", fontSize: 13, background: "var(--white)", cursor: "pointer", color: "var(--t-strong)" }}>取消</button>
              <button type="button" disabled={loading} onClick={() => void submitOrder()} style={{ border: "none", borderRadius: 6, padding: "8px 16px", fontSize: 13, background: loading ? "var(--t-strong)" : "var(--c-blue)", color: "var(--white)", fontWeight: 500, cursor: loading ? "not-allowed" : "pointer" }}>{loading ? "提交中…" : "创建订单"}</button>
            </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* 批量上传弹窗 */}
      {showBatchImport ? (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)", padding: 16 }}>
          <div style={{ width: "100%", maxWidth: 900, maxHeight: "90vh", overflow: "auto", background: "var(--white)", borderRadius: 12, padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
            <h3 style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 600 }}>批量创建订单</h3>
            <p style={{ fontSize: 13, color: "var(--t-strong)", margin: "0 0 12px" }}>
              Excel 每行填写一种产品或尺寸；相同运单号会合并成一张运单。建议先下载模板查看填写说明。
            </p>
            {batchFileName && !batchFileReading && (
              <div style={{ marginBottom: 12, padding: "10px 14px", background: "var(--white)", border: "1px solid var(--l-soft)", borderRadius: 8, fontSize: 14, color: "var(--t-strong)" }}>
                已上传: <strong>{batchFileName}</strong> — 读取 <strong>{batchSourceRowCount}</strong> 行，合并为 <strong>{batchRows.length}</strong> 个运单
                {batchRows.length === 0 && <span style={{ color: "var(--c-red-2)", marginLeft: 8 }}>无有效数据，请检查模板格式</span>}
              </div>
            )}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
              <button type="button" onClick={downloadStaffBatchTemplate} style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 12px", background: "var(--white)", color: "var(--t-strong)", cursor: "pointer" }}>下载模板</button>
              {/* ⚠️ 提交进行中必须禁掉（2026-08-29 加）。
                  submitStaffBatch 里的 pending 是**进函数那一刻的快照**，
                  中途换一份表，正在跑的循环照样按旧表一张张建 —— 员工完全看不出来。 */}
              <label style={{ border: "1px solid var(--c-blue)", borderRadius: 8, padding: "8px 12px", background: batchLoading ? "var(--s-cool)" : "var(--c-blue-bg)", color: batchLoading ? "var(--t-faint)" : "#1e3a8a", cursor: batchLoading ? "not-allowed" : "pointer" }}>
                {batchLoading ? "创建中…" : "上传 Excel"}
                <input type="file" accept=".xlsx,.xls" disabled={batchLoading} style={{ display: "none" }} onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  e.currentTarget.value = "";
                  const readTicket = batchReadGate.begin();
                  setBatchFileReading(true);
                  setBatchRows([]);
                  setBatchSourceRowCount(0);
                  setBatchErrors([]);
                  setBatchProgress({ current: 0, success: 0, fail: 0 });
                  setBatchFileName(file.name);
                  setBatchConfirmed(false);
                  setBatchDoneNos(new Set());   // 换文件了，重新记
                  /**
                   * 先卡大小和行数（2026-08-27 加）。
                   * 整个文件是读进浏览器内存里解析的，太大的表会让页面卡住甚至崩掉，
                   * 而且用户完全看不出是怎么回事。宁可当场告诉他「分批传」。
                   */
                  if (file.size > BATCH_MAX_FILE_BYTES) {
                    setBatchRows([]); setBatchSourceRowCount(0); setBatchProgress({ current: 0, success: 0, fail: 0 });
                    setBatchErrors([`文件 ${(file.size / 1024 / 1024).toFixed(1)}MB，超过 ${BATCH_MAX_FILE_MB}MB 上限。请拆成几份分批上传。`]);
                    setBatchFileReading(false);
                    return;
                  }
                  try {
                    const buf = await file.arrayBuffer();
                    if (!batchReadGate.isCurrent(readTicket)) return;
                    const wb = XLSX.read(buf, { type: "array" });
                    const ws = wb.Sheets[wb.SheetNames[0]];
                    /**
                     * ⚠️ 必须 blankrows:true（2026-08-29 改）。
                     * 默认会把完全空白的行**丢掉**，而解析器的行号是「下标+2」——
                     * 丢一行，下面所有报错的行号全部少 1。实测：错误真实在 Excel 第 5 行，
                     * 系统报「第 4 行」，员工去看那一行是好的，只会以为系统抽风。
                     * 保留空行之后下标和 Excel 行号严格对齐，解析器自己会跳过空行。
                     */
                    /**
                     * ⚠️ 必须把读取范围收到「真正有单元格的最后一行」（2026-08-29 加）。
                     * blankrows:true 是按 !ref 逐行产出的，而 Excel 的已用区域经常被拖到表底：
                     * 老板真实在用的那份表 !ref 是 A1:AF1048565、实际只有 67 行 ——
                     * 不收范围就会造出 104 万个空对象、吃掉 1.9GB，浏览器直接崩。
                     * 收范围不影响行号：起点仍是第 1 行，前面每一行的下标都没变。
                     */
                    const lastRow = lastRowWithCells(Object.keys(ws));
                    const refRange = XLSX.utils.decode_range(ws["!ref"] ?? "A1");
                    const boundedRange = XLSX.utils.encode_range({
                      s: { r: 0, c: refRange.s.c },
                      e: { r: Math.max(lastRow - 1, 0), c: refRange.e.c },
                    });
                    const raw = XLSX.utils.sheet_to_json(ws, { ...BATCH_SHEET_TO_JSON_OPTIONS, range: boundedRange }) as Record<string, unknown>[];
                    /**
                     * ⚠️ 行数上限按**非空行**算。保留空行之后 raw.length 会把空行也数进去，
                     * 有些 Excel 的「已用区域」会一直拖到几千行空白，
                     * 按 raw.length 判就会把一份正常的表拒之门外。
                     */
                    const filledRowCount = raw.filter((r) => Object.values(r).some((v) => String(v ?? "").trim() !== "")).length;
                    if (filledRowCount > BATCH_MAX_ROWS) {
                      setBatchRows([]); setBatchSourceRowCount(0); setBatchProgress({ current: 0, success: 0, fail: 0 });
                      setBatchErrors([`这份表有 ${filledRowCount} 行数据，超过 ${BATCH_MAX_ROWS} 行上限。请拆成几份分批上传。`]);

                      return;
                    }
                    const parsed = parseStaffBatchRows(raw);
                    setBatchRows(parsed.orders);
                    setBatchSourceRowCount(parsed.sourceRowCount);
                    setBatchErrors(parsed.issues.map((issue) => {
                      // 整表级的问题（缺了一整列、同名列重复）不属于任何一行，
                      // 硬套「Excel 数据（运单号 —，唛头 —）：表里找不到「箱数」这一列」读起来是废话
                      if (issue.kind === "file") return issue.message;
                      const location = formatStaffBatchErrorLocation(
                        issue.rowNumber ? `Excel 第${issue.rowNumber}行` : "Excel 数据",
                        issue.trackingNo,
                        issue.clientId,
                      );
                      return `${location}：${issue.message}`;
                    }));
                    setBatchProgress({ current: 0, success: 0, fail: 0 });
                  } catch {
                    if (!batchReadGate.isCurrent(readTicket)) return;
                    setBatchRows([]);
                    setBatchSourceRowCount(0);
                    setBatchErrors(["Excel 解析失败，请使用系统模板并检查文件内容"]);
                  } finally {
                    if (batchReadGate.isCurrent(readTicket)) setBatchFileReading(false);
                  }
                }} />
              </label>
              {batchFileReading && <p role="status" style={{ fontSize: 13 }}>正在读取 {batchFileName}，读取完成后再确认创建。</p>}
              {!batchFileReading && !batchConfirmed && batchRows.length > 0 && batchErrors.length === 0 && !batchLoading && batchProgress.current === 0 && (
                <button type="button" onClick={() => { setBatchConfirmed(true); void submitStaffBatch(); }} style={{ border: "none", borderRadius: 8, padding: "8px 16px", background: "var(--c-blue)", color: "var(--white)", cursor: "pointer", fontWeight: 600, fontSize: 14 }}>
                  确认创建 {batchRows.length} 个运单
                </button>
              )}
              {/* 中途失败后接着建剩下的。
                  ⚠️ 条件不能带 batchDoneNos.size > 0（2026-08-28 改）：
                  第一票就失败时「已成功」是 0，那样这个按钮和「确认创建」都不显示，
                  用户只能关掉重新上传整份表。 */}
              {batchConfirmed && !batchLoading && batchRows.length > 0 && batchDoneNos.size < batchRows.length && (
                <button type="button" onClick={() => { void submitStaffBatch(); }} style={{ border: "none", borderRadius: 8, padding: "8px 16px", background: "var(--c-amber)", color: "#7c2d12", cursor: "pointer", fontWeight: 600, fontSize: 14 }}>
                  {batchDoneNos.size > 0
                    ? `继续创建剩下的 ${batchRows.length - batchDoneNos.size} 个（已成功 ${batchDoneNos.size} 个会跳过）`
                    : `重试这 ${batchRows.length} 个运单`}
                </button>
              )}
            </div>
            {/* 进度：只用文字报数，不放进度条动画 */}
            {batchLoading && (
              <div style={{ marginBottom: 12, display: "flex", justifyContent: "space-between", fontSize: 13, color: "var(--t-strong)" }}>
                <span>正在创建第 {batchProgress.current}/{batchRows.length} 个运单…</span>
                <span>
                  成功 {batchProgress.success} 条
                  {batchProgress.fail > 0 ? <span style={{ color: "var(--c-red-deep)" }}>　失败 {batchProgress.fail} 条</span> : null}
                </span>
              </div>
            )}
            {batchErrors.length > 0 && !batchLoading && (
              /**
               * ⚠️ 错误清单要封顶（2026-08-29 加）。
               * 一份 2000 行的表填错一列就能刷出几千条，原来全部堆在弹窗里，
               * 页面卡、也看不完，而且没法带走去改表。
               * 现在只列前 200 条，并给一个「复制全部」把完整清单送进剪贴板。
               */
              <div style={{ marginBottom: 12, padding: 12, borderRadius: 8, background: "#fef2f2", border: "1px solid #fecaca" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4, gap: 8 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: "var(--c-red-deep)" }}>
                    需要修正{batchErrors.length > 1 ? `（共 ${batchErrors.length} 条${batchErrors.length > BATCH_MAX_SHOWN_ERRORS ? `，下面只列前 ${BATCH_MAX_SHOWN_ERRORS} 条` : ""}）` : ""}：
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(batchErrors.join("\n"))
                        .then(() => setToast(`已复制 ${batchErrors.length} 条错误，可以粘到 Excel 或微信里对着改`))
                        .catch(() => setToast("这个浏览器不让复制，请手动选中复制"));
                    }}
                    style={{ border: "1px solid #fecaca", borderRadius: 6, padding: "4px 10px", fontSize: 12, background: "var(--white)", color: "var(--c-red-deep)", cursor: "pointer", whiteSpace: "nowrap" }}
                  >复制全部</button>
                </div>
                <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: "var(--c-red-deep)", maxHeight: 260, overflowY: "auto" }}>
                  {batchErrors.slice(0, BATCH_MAX_SHOWN_ERRORS).map((e, i) => <li key={i}>{e}</li>)}
                </ul>
                {/* ⚠️ 2026-08-29 加这一句。只要有一条错，「确认创建」按钮就不显示 ——
                    原来是**凭空消失**，员工只看到按钮没了，不知道是系统坏了还是自己错了。
                    规则本身不改（有错就整份表不建，避免建一半留个烂摊子），但要把话说明白。 */}
                {batchProgress.current === 0 && (
                  <div style={{ marginTop: 8, fontSize: 12, color: "var(--c-red-deep)" }}>
                    有问题的时候不能创建，避免建一半留个烂摊子。请在 Excel 里按上面的提示改好，再重新上传这份表。
                  </div>
                )}
              </div>
            )}
            {!batchLoading && batchProgress.current > 0 && batchErrors.length === 0 && (
              <div style={{ marginBottom: 12, padding: 12, border: "1px solid var(--l-soft)", background: "var(--white)" }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: "var(--t-strong)" }}>全部提交成功：{batchProgress.success} 个运单</div>
              </div>
            )}
            {batchRows.length > 0 && (
              <div style={{ overflowX: "auto", marginBottom: 12 }}>
                <div style={{ fontSize: 13, marginBottom: 4, color: "var(--t-strong)" }}>
                  预览：{batchRows.length} 个运单 / {batchSourceRowCount} 行产品明细
                  {"　"}合计 {batchRows.reduce((sum, r) => sum + r.packageCount, 0)} 箱
                  {"　"}{batchRows.reduce((sum, r) => sum + (r.volumeM3 ?? 0), 0).toFixed(3)} m³
                  {"　"}{batchRows.reduce((sum, r) => sum + (r.weightKg ?? 0), 0).toFixed(2)} kg
                </div>
                <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid var(--l-cool)", background: "var(--s-cool)" }}>
                      <th style={{ textAlign: "left", padding: "6px 4px" }}>#</th>
                      <th style={{ textAlign: "left", padding: "6px 4px" }}>客户ID</th>
                      <th style={{ textAlign: "left", padding: "6px 4px" }}>运单号</th>
                      <th style={{ textAlign: "left", padding: "6px 4px" }}>仓库</th>
                      <th style={{ textAlign: "left", padding: "6px 4px" }}>品名</th>
                      <th style={{ textAlign: "left", padding: "6px 4px" }}>箱数</th>
                      {/* ⚠️ 方数 / 重量 / 总数三列 2026-08-29 补（老板要求）。
                          原来预览只有箱数、品名、日期、运输 —— 方数和重量**根本不显示**，
                          所以「表头串列把方数从 0.5 算成 9.9」这种错误在页面上完全看不见，
                          而方数是算钱的。摆出来才有可能在确认前发现不对。 */}
                      <th style={{ textAlign: "right", padding: "6px 4px" }}>方数 m³</th>
                      <th style={{ textAlign: "right", padding: "6px 4px" }}>重量 kg</th>
                      <th style={{ textAlign: "right", padding: "6px 4px" }}>总数</th>
                      <th style={{ textAlign: "left", padding: "6px 4px" }}>到仓日期</th>
                      <th style={{ textAlign: "left", padding: "6px 4px" }}>运输</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batchRows.map((row, idx) => (
                      <tr key={row.trackingNo} style={{ borderBottom: "1px solid var(--s-cool-2)" }}>
                        <td style={{ padding: "6px 4px" }}>{idx + 1}</td>
                        <td style={{ padding: "6px 4px" }}>{allClientOptions.find((c) => c.id === row.clientId)?.name ?? row.clientId}</td>
                        <td style={{ padding: "6px 4px" }}>{row.trackingNo}</td>
                        <td style={{ padding: "6px 4px" }}>{{"wh_yiwu_01":"义乌仓","wh_guangzhou_01":"广州仓","wh_dongguan_01":"东莞仓","wh_shenzhen_01":"深圳仓"}[row.warehouseId] ?? row.warehouseId}</td>
                        <td style={{ padding: "6px 4px" }}>{row.itemName}（{row.products.length}行）</td>
                        <td style={{ padding: "6px 4px" }}>{row.packageCount} {row.packageUnit === "bag" ? "袋" : "箱"}</td>
                        <td style={{ padding: "6px 4px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{row.volumeM3 === undefined ? "—" : row.volumeM3.toFixed(3)}</td>
                        <td style={{ padding: "6px 4px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{row.weightKg === undefined ? "—" : row.weightKg.toFixed(2)}</td>
                        <td style={{ padding: "6px 4px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{row.productQuantity === undefined ? "—" : row.productQuantity}</td>
                        <td style={{ padding: "6px 4px" }}>{row.arrivedAt}</td>
                        <td style={{ padding: "6px 4px" }}>{row.transportMode === "sea" ? "海运" : "陆运"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              {/* ⚠️ 提交进行中不许关（2026-08-29 加）。
                  原来关掉弹窗只是把 state 清了，后台那个 for 循环照样一张张建下去，
                  员工以为取消了，实际还在建。 */}
              <button
                type="button"
                disabled={batchLoading}
                title={batchLoading ? "正在创建，关掉也不会停下来，请等它跑完" : undefined}
                onClick={() => { batchReadGate.cancel(); setBatchFileReading(false); setShowBatchImport(false); setBatchRows([]); setBatchSourceRowCount(0); setBatchErrors([]); setBatchProgress({ current: 0, success: 0, fail: 0 }); setBatchFileName(""); setBatchConfirmed(false); }}
                style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 16px", fontSize: 13, background: "var(--white)", cursor: batchLoading ? "not-allowed" : "pointer", color: batchLoading ? "var(--t-faint)" : "var(--t-strong)" }}
              >{batchLoading ? "创建中，请勿关闭" : "关闭"}</button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 客户余额 */}
      <section id="staff-fcl" style={{ display: activeSection === "staff-fcl" ? "block" : "none" }}>
        <FclInquiryPanel visible={activeSection === "staff-fcl"} isStaff clients={staffClients} onToast={setToast} />
      </section>

      {activeSection === "staff-wallet" && (
        <section style={{ border: "1px solid var(--l-soft)", borderRadius: 12, padding: 16, background: "var(--white)", marginTop: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontSize: 18 }}>客户余额</h2>
            <button
              type="button"
              onClick={loadWalletBalances}
              style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "6px 14px", background: "var(--white)", cursor: "pointer", fontSize: 13 }}
            >
              刷新
            </button>
          </div>
          {walletBalances.length === 0 ? (
            <p style={{ color: "var(--t-muted)", fontSize: 13 }}>暂无数据，点击刷新加载</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "var(--s-alt)", borderBottom: "1px solid var(--l-soft)" }}>
                    <th style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600, color: "var(--t-body)" }}>客户</th>
                    <th style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600, color: "var(--t-body)" }}>公司</th>
                    <th style={{ padding: "8px 12px", textAlign: "right", fontWeight: 600, color: "var(--t-body)" }}>集货余额</th>
                  </tr>
                </thead>
                <tbody>
                  {walletBalances.map((b) => (
                    <tr key={b.clientId} style={{ borderBottom: "1px solid var(--s-sunken)" }}>
                      <td style={{ padding: "8px 12px" }}>{b.clientId}</td>
                      <td style={{ padding: "8px 12px", color: "var(--t-muted)" }}>{b.companyName || "—"}</td>
                      <td style={{ padding: "8px 12px", textAlign: "right", fontWeight: 600 }}>¥{b.cny.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}
