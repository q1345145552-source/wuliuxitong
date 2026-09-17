"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { apiBaseUrl, apiRequest } from "../../../services/core-api";
import { formatBeijingTime } from "../../../modules/staff/utils";
import { base64Bytes, compressImageForUpload, formatBytes } from "../../../modules/shared/image-compress";
import { createRequestGate } from "../../../modules/shared/request-gate";
import { viewerCanSeeOperator } from "../../../auth/operator-visibility";
import { parseUnitPrice, unitPriceIssue } from "../../../modules/shared/unit-price";

// 选文件时的原图上限。超过这个的多半是选错了（视频/超大扫描件），先挡掉再说。
const MAX_SOURCE_BYTES = 30 * 1024 * 1024;
// 压缩之后单张仍然不许超过这个（后端 MAX_IMAGE_BASE64_LENGTH 是 8MB，这里留足余量）
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// 整个请求体的上限。
// 真正的天花板是 10 MiB —— 不是 nginx 也不是后端，是中间 Next.js 转发那一跳的硬限制
// （2026-08-08 实测：10.4MB 还通，10.8MB 就变成一句光秃秃的 500）。
// 这里取 8MB，给 JSON 里的其他字段和 base64 的换算误差留足余量。
const MAX_UPLOAD_TOTAL_BYTES = 8 * 1024 * 1024;
const jsonPost = { "Content-Type": "application/json" } as const;

/**
 * 多张图片选完后统一压缩。返回压好的列表 + 被跳过的文件说明。
 * 被跳过的一定要显式告诉用户，不能静默丢掉。
 */
async function prepareUploadFiles(
  files: File[],
): Promise<{ ready: { base64: string; fileName: string; mime: string }[]; skipped: string[] }> {
  const ready: { base64: string; fileName: string; mime: string }[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    if (file.size > MAX_SOURCE_BYTES) {
      skipped.push(`${file.name}（原图 ${formatBytes(file.size)}，超过 ${formatBytes(MAX_SOURCE_BYTES)}）`);
      continue;
    }
    const img = await compressImageForUpload(file);
    if (base64Bytes(img.base64) > MAX_IMAGE_BYTES) {
      skipped.push(`${file.name}（压缩后仍有 ${formatBytes(base64Bytes(img.base64))}）`);
      continue;
    }
    ready.push({ base64: img.base64, fileName: img.fileName, mime: img.mime });
  }
  return { ready, skipped };
}

/** 这一批图片加起来会占多大请求体 */
function totalUploadBytes(files: { base64: string }[]): number {
  return files.reduce((s, f) => s + base64Bytes(f.base64), 0);
}

/** 把接口返回的图片字段（可能是 /images 路径、data URL 或裸 base64）统一成可用的 src */
function toImageSrc(src: unknown, mime?: string): string {
  if (typeof src !== "string" || !src) return "";
  if (src.startsWith("data:") || src.startsWith("/") || src.startsWith("http")) return src;
  return `data:${mime || "image/png"};base64,${src}`;
}

// 费用明细（后端算好下发，保证三端口径一致）
interface FeeBreakdownRow {
  cargoType: string; label: string; volumeM3: number; unitPrice: number; amount: number;
}
interface FeeBreakdown {
  rows: FeeBreakdownRow[];
  totalVolumeM3: number;
  computedFee: number;
  storedFee: number | null;
  matchesStored: boolean;
}

const money = (n: number) => `¥${n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** 总费用的详细算式：每档「方数 × 单价 = 金额」，最后合计 */
function FeeBreakdownPanel({ bd, title = "费用明细", compact }: { bd?: FeeBreakdown | null; title?: string; compact?: boolean }) {
  if (!bd || !bd.rows || bd.rows.length === 0) return null;
  const fs = compact ? 11 : 12;
  return (
    <div style={{ background: "var(--s-alt)", border: "1px solid var(--l-soft)", borderRadius: 6, padding: compact ? "6px 8px" : "8px 10px", fontSize: fs }}>
      <div style={{ fontWeight: 600, color: "var(--t-body)", marginBottom: 4 }}>{title}</div>
      {bd.rows.map(r => (
        <div key={r.cargoType} style={{ display: "flex", justifyContent: "space-between", gap: 8, color: "#4B5462", padding: "1px 0" }}>
          <span>{r.label}：{r.volumeM3.toFixed(3)} 方 × {r.unitPrice} 元/方</span>
          <span style={{ whiteSpace: "nowrap" }}>= {money(r.amount)}</span>
        </div>
      ))}
      <div style={{ borderTop: "1px solid var(--l-soft)", marginTop: 4, paddingTop: 4, display: "flex", justifyContent: "space-between", gap: 8 }}>
        <span style={{ color: "var(--t-muted)" }}>合计 {bd.totalVolumeM3.toFixed(3)} 方</span>
        <span style={{ fontWeight: 700, fontSize: fs + 2, color: "var(--c-green)", whiteSpace: "nowrap" }}>
          {money(bd.storedFee ?? bd.computedFee)}
        </span>
      </div>
      {!bd.matchesStored && bd.storedFee != null && (
        <div style={{ marginTop: 4, color: "#b45309", fontSize: fs - 1 }}>
          付款后柜里单价改过：按现价算为 {money(bd.computedFee)}，实际应付以付款时锁定的 {money(bd.storedFee)} 为准。
        </div>
      )}
    </div>
  );
}

/** 本地时区的 YYYY-MM-DD，用于导出文件名（原来用 UTC，晚上导出会显示成前一天） */
function localDateStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ============================================================================
// 状态中文
// ============================================================================
const PLAN_ST_ZH: Record<string, string> = {
  planning: "计划中", collecting: "集货中", loading: "装柜中", shipped: "已发运", completed: "已完成", cancelled: "已取消",
};
const PREALERT_ST_ZH: Record<string, string> = {
  pending: "待签收", received_pending_payment: "待付款", payment_submitted: "待审核",
  paid: "已付款", loading: "装柜中", shipped: "已发运", thailand_received: "泰国已签收", cancelled: "已取消",
};
const TAG: Record<string, { bg: string; color: string }> = {
  pending: { bg: "var(--c-blue-bg-2)", color: "var(--c-blue-deep)" },
  received_pending_payment: { bg: "var(--c-amber-bg)", color: "var(--c-amber-deep)" },
  payment_submitted: { bg: "var(--c-blue-bg-2)", color: "var(--c-blue-deep)" },
  paid: { bg: "var(--c-green-bg)", color: "var(--c-green-deep)" },
  loading: { bg: "#EEF2FB", color: "#1e3a8a" },
  shipped: { bg: "#EEF2FB", color: "#1e3a8a" },
  thailand_received: { bg: "var(--c-green-bg)", color: "var(--c-green-deep)" },
  cancelled: { bg: "var(--c-red-bg)", color: "var(--c-red-dark)" },
};

// ============================================================================
// 类型
// ============================================================================
interface DispatchCustomerItem {
  id: string; productName: string; packageCount: number; quantityPerBox: number;
  totalQuantity: number; lengthCm: number | null; widthCm: number | null; heightCm: number | null;
  unitWeightKg: number | null; totalWeightKg: number | null; volumeM3: number | null;
  material: string; cargoValue: string; cargoType: string;
  productImageFileName: string | null; productImageBase64: string | null; sortOrder: number;
}
interface DispatchCustomer {
  id: string; clientId: string; clientName: string; clientPhone: string; clientCompany: string;
  status?: string; unitPriceNormal: number; unitPriceInspection: number; unitPriceSensitive: number;
  totalVolumeM3: number; totalFee: number | null; deliveryAddress: string | null; addressMissing?: boolean;
  totalItems: number; totalPackages: number; createdAt: string; 
  prealerts?: { id: string; trackingNo: string; mark: string; expressNo: string | null; status: string; warehouseReceiptProofs?: { base64Path: string; fileName: string; mime: string; uploadedAt?: string }[]; thailandReceiptProofs?: { base64Path: string; fileName: string; mime: string; uploadedAt?: string }[]; items: DispatchCustomerItem[] }[];
}
interface DispatchPlan {
  planId: string; planNo: string; warehouse: string; containerType: string; destinationTh: string;
  totalVolumeM3: number; planStatus: string; customers: DispatchCustomer[]; createdAt: string;
}

// Operations Tab — 预报单级别
interface OpsPrealert {
  prealertId: string; trackingNo: string; expressNo?: string | null; mark: string; status: string;
  clientId: string; customerId?: string; clientName: string; clientPhone: string | null; clientCompany: string | null;
  deliveryAddress: string | null; addressMissing?: boolean;
  itemCount: number; volumeM3: number; packageCount: number;
  totalFee?: number | null;
  paymentProofs?: any[];
  warehouseReceiptProofs?: { base64Path: string; fileName: string; mime: string; uploadedAt?: string }[];
  thailandReceiptProofs?: { base64Path: string; fileName: string; mime: string; uploadedAt?: string }[];
}
interface OpsPlan {
  planId: string; planNo: string; warehouse: string; containerType: string; destinationTh: string;
  totalVolumeM3: number; usedVolumeM3?: number; status?: string;
  sections: {
    pending: OpsPrealert[];
    received_pending_payment: OpsPrealert[];
    payment_submitted: OpsPrealert[];
    paid: OpsPrealert[];
    loading: OpsPrealert[];
    shipped: OpsPrealert[];
  };
}

interface PlanItem {
  id: string; planNo: string; warehouse: string; containerType: string; destinationTh: string;
  // creatorName：只有超级管理员拿得到（2026-09-15），员工的接口返回里没有
  totalVolumeM3: number; usedVolumeM3?: number; status: string; creatorName?: string; customerCount: number; createdAt: string;
}
interface PlanDetail { id: string; planNo: string; warehouse: string; containerType: string; destinationTh: string;
  totalVolumeM3: number; status: string; creatorName?: string; createdAt: string; updatedAt: string;
  customers: any[];
}

// ============================================================================
// 共用样式
// ============================================================================
const thS: React.CSSProperties = { padding: "6px 10px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "var(--t-body)", borderBottom: "2px solid var(--l-soft)", whiteSpace: "nowrap" };
const tdS: React.CSSProperties = { padding: "7px 10px", fontSize: 13, borderBottom: "1px solid var(--s-sunken)", verticalAlign: "middle" };
const btnBlue: React.CSSProperties = { padding: "8px 18px", background: "var(--c-blue)", color: "var(--white)", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600, fontSize: 13 };
const btnGray: React.CSSProperties = { padding: "8px 18px", border: "1px solid var(--l-strong)", color: "var(--t-muted)", background: "var(--white)", borderRadius: 6, cursor: "pointer", fontSize: 13 };
const btnGreen: React.CSSProperties = { padding: "8px 18px", background: "var(--c-green)", color: "var(--white)", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600, fontSize: 13 };
const fl: React.CSSProperties = { display: "block", fontSize: 13, color: "var(--t-body)", fontWeight: 500, marginBottom: 3 };
const fi: React.CSSProperties = { width: "100%", padding: "7px 10px", border: "1px solid var(--l-strong)", borderRadius: 6, fontSize: 13, boxSizing: "border-box" };

// ============================================================================
// 主页面
// ============================================================================
/**
 * 页面这道单价校验要跟后端 requireUnitPrice 对得上（2026-09-18 复核第 6 条）：
 * 必填、大于 0、最多 2 位小数（按字符串判，别用 1e-6 容差）、小于 1 亿（库里是 Decimal(10,2)）。
 * 返回 null = 没问题。
 */
export default function StaffWhrConsolidationPage() {
  const [activeTab, setActiveTab] = useState<"dispatch" | "operations" | "plans">("dispatch");
  const [toast, setToast] = useState<string>("");

  // ---- 尾端拆派 ----
  const [dispatchData, setDispatchData] = useState<DispatchPlan[]>([]);
  const [dispatchLoading, setDispatchLoading] = useState(false);
  const [expandedPlan, setExpandedPlan] = useState<string | null>(null);
  const [expandedCustomer, setExpandedCustomer] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // ---- 操作区 ----
  const [opsPlans, setOpsPlans] = useState<OpsPlan[]>([]);
  const [opsLoading, setOpsLoading] = useState(false);
  const [opsActionSubmitting, setOpsActionSubmitting] = useState<Record<string, boolean>>({});

  // ---- 泰国签收 ----
  const [thailandTarget, setThailandTarget] = useState<{ planId: string; prealertId: string; planNo: string; trackingNo: string; clientName: string; volumeM3: number } | null>(null);
  const [thailandFiles, setThailandFiles] = useState<{ base64: string; fileName: string; mime: string }[]>([]);
  const [thailandSubmitting, setThailandSubmitting] = useState(false);
  const [thailandCompressing, setThailandCompressing] = useState(false);

  // ---- 仓库签收 ----
  const [signTarget, setSignTarget] = useState<{ planId: string; prealertId: string; planNo: string; trackingNo: string; mark: string; clientName: string; clientPhone?: string; clientCompany?: string; deliveryAddress: string | null; items?: any[]; loading?: boolean } | null>(null);
  const [signFiles, setSignFiles] = useState<{ base64: string; fileName: string; mime: string }[]>([]);
  const [signSubmitting, setSignSubmitting] = useState(false);
  const [signCompressing, setSignCompressing] = useState(false);

  // ---- 审核付款 ----
  const [reviewTarget, setReviewTarget] = useState<any>(null);
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  // ---- 拼柜计划 ----
  const [planList, setPlanList] = useState<PlanItem[]>([]);
  const [planDetail, setPlanDetail] = useState<PlanDetail | null>(null);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  // 新增 / 移除参与客户（2026-08-07）
  const [clientOptions, setClientOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [clientsLoading, setClientsLoading] = useState(false);
  const [showAddCustomer, setShowAddCustomer] = useState(false);
  const [addClientId, setAddClientId] = useState("");
  const [addSearch, setAddSearch] = useState("");
  /** 加客户时当场填这一柜的三档单价（2026-09-18 老板拍板改回来：每个柜价格都不一样） */
  const [addPriceNormal, setAddPriceNormal] = useState("");
  const [addPriceInspection, setAddPriceInspection] = useState("");
  const [addPriceSensitive, setAddPriceSensitive] = useState("");
  const [addSubmitting, setAddSubmitting] = useState(false);
  /** 加客户弹窗里的报错：画在弹窗里面，页面顶部那条会被遮罩压住、5 秒还自动消失（复核 2026-09-18 第 3 条） */
  const [addError, setAddError] = useState("");
  const [removingCustomerId, setRemovingCustomerId] = useState("");
  const [planLoading, setPlanLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);

  // ---- 图片预览 ----
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  // 2026-09-01 竞态全扫：这几份独立数据各自「认主人」用的 ref。
  // 病根都是「异步取数在路上、用户换了对象、旧响应回来盖新界面」。
  // - 计划详情：连点两个计划，旧计划的详情落到新计划头上 → ref + 领号验号；
  // - 签收/审核弹窗：关 A 开 B，A 的慢详情把 B 的弹窗内容盖掉 → 响应落地时比对当前弹窗的预报单 id；
  // - 签收/泰国签收照片：压缩是异步的，关 A 开 B 后压完的照片会落进 B 的文件列表 → 回调同样认主人。
  const selectedPlanIdRef = useRef<string | null>(null);
  const planDetailGate = useRef(createRequestGate()).current;
  const signPrealertIdRef = useRef<string | null>(null);
  const reviewPrealertIdRef = useRef<string | null>(null);
  const thailandPrealertIdRef = useRef<string | null>(null);
  // 2026-09-02 终审整改：这三个 ref 已改为在「点击打开处同步赋值、关闭处同步清空」，
  // 下面的 useEffect 只留作兜底——effect 要等渲染后才跑，关 A 开 B 的间隙里 ref 若还停在 A，
  // A 的慢详情 / 慢压缩结果就能趁机落进 B 的弹窗（见 request-gate.ts 用法二）。
  useEffect(() => { signPrealertIdRef.current = signTarget?.prealertId ?? null; }, [signTarget]);
  useEffect(() => { reviewPrealertIdRef.current = reviewTarget?.prealert?.prealertId ?? null; }, [reviewTarget]);
  useEffect(() => { thailandPrealertIdRef.current = thailandTarget?.prealertId ?? null; }, [thailandTarget]);

  // ================================================================
  // 数据加载
  // ================================================================
  const loadDispatch = useCallback(async () => {
    setDispatchLoading(true);
    try {
      const data = await apiRequest<{ items: DispatchPlan[] }>(`${apiBaseUrl()}/staff/whr-consolidation/dispatch-view`);
      setDispatchData(data.items ?? []);
    } catch (e: any) { setToast(e?.message ?? "加载拆派视图失败"); }
    finally { setDispatchLoading(false); }
  }, []);

  const loadOperations = useCallback(async () => {
    setOpsLoading(true);
    try {
      const data = await apiRequest<{ plans: OpsPlan[] }>(`${apiBaseUrl()}/staff/whr-consolidation/operations`);
      setOpsPlans(data.plans ?? []);
    } catch (e: any) { setToast(e?.message ?? "加载操作数据失败"); }
    finally { setOpsLoading(false); }
  }, []);

  const loadPlans = useCallback(async () => {
    setPlanLoading(true);
    try {
      const data = await apiRequest<{ items: PlanItem[] }>(`${apiBaseUrl()}/admin/whr-consolidation/plans`);
      setPlanList(data.items ?? []);
    } catch (e: any) { setToast(e?.message ?? "加载计划列表失败"); }
    finally { setPlanLoading(false); }
  }, []);

  const loadPlanDetail = useCallback(async (planId: string) => {
    // 2026-09-01 竞态全扫：出发领号，落地验号 + 认主人（成功、失败、finally 三个分支都要验）
    const ticket = planDetailGate.begin();
    setDetailLoading(true);
    try {
      const data = await apiRequest<PlanDetail>(
        `${apiBaseUrl()}/admin/whr-consolidation/plans/detail?planId=${encodeURIComponent(planId)}`
      );
      // 号已作废，或用户已换/退出这个计划：旧详情不许落到新计划头上
      if (!planDetailGate.isCurrent(ticket) || selectedPlanIdRef.current !== planId) return;
      setPlanDetail(data);
    } catch (e: any) {
      // 失败分支同样验：旧请求的报错不许安到新界面头上
      if (!planDetailGate.isCurrent(ticket) || selectedPlanIdRef.current !== planId) return;
      setToast(e?.message ?? "加载详情失败");
    }
    finally {
      // 旧请求不许提前掐掉新请求的加载态；只要没有更新的请求在跑，加载态就该收掉
      if (planDetailGate.isCurrent(ticket)) setDetailLoading(false);
    }
  }, [planDetailGate]);

  // ==========================================================================
  // 新增 / 移除参与客户（2026-08-07）
  // 员工端走的是 /admin/whr-consolidation/... 这组接口，后端角色已放开到 staff。
  // ==========================================================================
  /** 客户下拉用 /staff/clients（员工有权限），管理员端那套 /admin/users 员工调不了 */
  const openAddCustomer = async () => {
    setAddClientId(""); setAddSearch(""); setAddError("");
    setAddPriceNormal(""); setAddPriceInspection(""); setAddPriceSensitive("");
    setShowAddCustomer(true);
    if (clientOptions.length > 0) return;
    setClientsLoading(true);
    try {
      const data = await apiRequest<{ items: Array<{ id: string; name: string }> }>(`${apiBaseUrl()}/staff/clients`);
      setClientOptions(data.items ?? []);
    } catch (e: any) { setToast(e?.message ?? "加载客户列表失败"); }
    finally { setClientsLoading(false); }
  };

  const handleAddCustomer = async () => {
    if (!selectedPlanId) return;
    if (!addClientId) { setAddError("请选择客户"); return; }
    // 三档单价当场填（2026-09-18）：页面先挡一次，说了算的是后端那道 requireUnitPrice
    const priceChecks: Array<[string, string]> = [["普货", addPriceNormal], ["商检货", addPriceInspection], ["敏感货", addPriceSensitive]];
    for (const [label, raw] of priceChecks) {
      const issue = unitPriceIssue(label, raw);
      if (issue) { setAddError(issue); return; }
    }
    setAddSubmitting(true);
    try {
      const r = await apiRequest<{ unitPriceNormal?: number; unitPriceInspection?: number; unitPriceSensitive?: number }>(`${apiBaseUrl()}/admin/whr-consolidation/customers/add`, {
        method: "POST",
        headers: jsonPost,
        body: JSON.stringify({
          planId: selectedPlanId,
          clientId: addClientId,
          unitPriceNormal: parseUnitPrice(addPriceNormal),
          unitPriceInspection: parseUnitPrice(addPriceInspection),
          unitPriceSensitive: parseUnitPrice(addPriceSensitive),
        }),
      });
      setToast(r?.unitPriceNormal != null
        ? `客户已加入本计划，单价：普货 ${r.unitPriceNormal} · 商检货 ${r.unitPriceInspection} · 敏感货 ${r.unitPriceSensitive} 元/方`
        : "客户已加入本计划");
      setShowAddCustomer(false);
      loadPlanDetail(selectedPlanId);
    } catch (e: any) { setAddError(e?.message ?? "新增失败"); }
    finally { setAddSubmitting(false); }
  };

  /** 移除客户。名下有预报单的后端会拦住，这里先提示一次，免得白点 */
  const handleRemoveCustomer = async (c: any) => {
    if (!selectedPlanId) return;
    const paCount = (c.prealerts ?? []).length;
    if (paCount > 0) {
      setToast(`${c.clientName} 名下还有 ${paCount} 个预报单，请先逐个取消后再移除`);
      return;
    }
    if (!confirm(`确定把「${c.clientName}」从本计划移除？\n\n该客户名下没有预报单，移除后只会删掉这条参与记录。`)) return;
    setRemovingCustomerId(c.id);
    try {
      await apiRequest(`${apiBaseUrl()}/admin/whr-consolidation/customers/remove`, {
        method: "POST",
        headers: jsonPost,
        body: JSON.stringify({ planId: selectedPlanId, customerId: c.id }),
      });
      setToast(`已移除 ${c.clientName}`);
      loadPlanDetail(selectedPlanId);
    } catch (e: any) { setToast(e?.message ?? "移除失败"); }
    finally { setRemovingCustomerId(""); }
  };


  useEffect(() => {
    if (activeTab === "dispatch") loadDispatch();
    else if (activeTab === "operations") loadOperations();
    else if (activeTab === "plans") loadPlans();
  }, [activeTab, loadDispatch, loadOperations, loadPlans]);

  // Toast 自动消失
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  // ================================================================
  // 操作函数 — 预报单级别
  // ================================================================
  // ---- 取消预报单 ----
  const handleCancelPrealert = (planId: string, prealertId: string, trackingNo: string) => {
    if (!window.confirm("确认取消预报单 " + trackingNo + "？将释放已占用方数。")) return;
    doPrealertAction("/admin/whr-consolidation/prealerts/cancel", planId, prealertId, "cancel-" + prealertId, { cancelReason: "员工主动取消" });
  };

  const doPrealertAction = async (url: string, planId: string, prealertId: string, key: string, extraBody?: any) => {
    setOpsActionSubmitting(p => ({ ...p, [key]: true }));
    try {
      const body: any = { planId, prealertId, ...extraBody };
      await apiRequest<any>(`${apiBaseUrl()}${url}`, {
        method: "POST",
        headers: jsonPost,
        body: JSON.stringify(body),
      });
      setToast("操作成功");
      loadOperations();
      if (activeTab === "dispatch") loadDispatch();
      if (selectedPlanId) loadPlanDetail(selectedPlanId);
    } catch (e: any) { setToast(e?.message ?? "操作失败"); }
    finally { setOpsActionSubmitting(p => ({ ...p, [key]: false })); }
  };

  // ---- 仓库签收 ----
  const handleOpenSign = async (pa: any, planId: string) => {
    // 2026-09-02 终审整改：认主人的 ref 在点击处同步赋值，不等 useEffect——
    // 否则打开的瞬间 ref 还停在上一单，旧详情/旧压缩照片能趁间隙落进这张新弹窗
    signPrealertIdRef.current = pa.prealertId;
    // 2026-09-01 竞态全扫：换单先清掉上一单残留的照片，否则给 A 选的照片会跟着签到 B 上
    setSignFiles([]);
    // 先弹出弹窗显示基本信息 + loading
    setSignTarget({
      planId, prealertId: pa.prealertId, planNo: pa.planNo || "",
      trackingNo: pa.trackingNo, mark: pa.mark, clientName: pa.clientName,
      deliveryAddress: pa.deliveryAddress, loading: true,
    });
    try {
      const detail = await apiRequest<any>(
        `${apiBaseUrl()}/staff/whr-consolidation/prealert-detail?prealertId=${encodeURIComponent(pa.prealertId)}`
      );
      // 2026-09-01 竞态全扫·认主人：弹窗已关或已换成别的预报单，A 的晚响应不许盖 B
      if (signPrealertIdRef.current !== pa.prealertId) return;
      setSignTarget({
        planId, prealertId: pa.prealertId, planNo: pa.planNo || "",
        trackingNo: pa.trackingNo, mark: pa.mark,
        clientName: detail.clientName ?? pa.clientName,
        clientPhone: detail.clientPhone,
        clientCompany: detail.clientCompany,
        deliveryAddress: detail.deliveryAddress ?? pa.deliveryAddress,
        items: detail.items ?? [],
        loading: false,
      });
    } catch (e: any) {
      // 失败分支同样认主人：旧请求的报错不许把当前弹窗关掉
      if (signPrealertIdRef.current !== pa.prealertId) return;
      setToast(e?.message ?? "加载预报单详情失败");
      signPrealertIdRef.current = null; // 2026-09-02 终审整改：关闭处同步清空 owner
      setSignTarget(null);
    }
  };

  const handleWarehouseSign = async () => {
    if (!signTarget || signFiles.length === 0) { setToast("请上传收货凭证照片"); return; }
    // 2026-09-02 终审整改：还有照片在压缩时不许提交，否则压缩中的那张会被静默漏掉
    if (signCompressing) { setToast("照片处理中，稍等一下再提交"); return; }
    // 整批超上限就当场说清楚，别让请求发出去被服务器挡掉（那样浏览器只会报 413，员工看不懂）
    const signTotal = totalUploadBytes(signFiles);
    if (signTotal > MAX_UPLOAD_TOTAL_BYTES) {
      setToast(`这 ${signFiles.length} 张照片共 ${formatBytes(signTotal)}，超过 ${formatBytes(MAX_UPLOAD_TOTAL_BYTES)}，请先删掉几张再提交`);
      return;
    }
    setSignSubmitting(true);
    try {
      await apiRequest<any>(
        `${apiBaseUrl()}/staff/whr-consolidation/prealert-sign`,
        {
          method: "POST", headers: jsonPost,
          body: JSON.stringify({
            planId: signTarget.planId, prealertId: signTarget.prealertId,
            receiptProofs: signFiles.map(f => ({ fileName: f.fileName, mime: f.mime, base64: f.base64 })),
          }),
        }
      );
      setToast("签收成功");
      signPrealertIdRef.current = null; // 2026-09-02 终审整改：关闭处同步清空 owner
      setSignTarget(null); setSignFiles([]);
      loadOperations();
      if (activeTab === "dispatch") loadDispatch();
      if (selectedPlanId) loadPlanDetail(selectedPlanId);
      loadPlans();
    } catch (e: any) {
      setToast(e?.message ?? "签收失败");
      // 失败也要刷新（2026-08-27 补）：后端现在会说「刚刚被别人改过，请刷新后再看」，
      // 页面不刷新的话用户看到的还是旧数字，容易照着旧数字再操作一次。
      loadOperations();
      if (activeTab === "dispatch") loadDispatch();
      if (selectedPlanId) loadPlanDetail(selectedPlanId);
      loadPlans();
    }
    finally { setSignSubmitting(false); }
  };

  // ---- 审核付款 ----
  const handleOpenReview = async (pa: OpsPrealert, planId: string) => {
    // 2026-09-02 终审整改：认主人的 ref 在点击处同步赋值，不等 useEffect（同 handleOpenSign）
    reviewPrealertIdRef.current = pa.prealertId;
    // 先用操作区已有数据把弹窗打开，再补货品明细
    setReviewTarget({ planId, prealert: pa, loading: true });
    try {
      // 只拉这一条预报单，不再为了一条单去拉整个计划的全部客户和货品
      const detail = await apiRequest<any>(
        `${apiBaseUrl()}/staff/whr-consolidation/prealert-detail?prealertId=${encodeURIComponent(pa.prealertId)}`
      );
      // 2026-09-01 竞态全扫·认主人：弹窗已关或已换成别的预报单，A 的晚响应不许把 B 的金额/凭证盖掉
      if (reviewPrealertIdRef.current !== pa.prealertId) return;
      const unitPrices = {
        unitPriceNormal: detail.unitPriceNormal,
        unitPriceInspection: detail.unitPriceInspection,
        unitPriceSensitive: detail.unitPriceSensitive,
      };
      setReviewTarget({
        planId,
        prealert: {
          ...pa,
          items: detail.items ?? [],
          unitPrices,
          totalFee: detail.totalFee ?? pa.totalFee,
          paymentProofs: detail.paymentProofs ?? pa.paymentProofs,
          deliveryAddress: detail.deliveryAddress ?? pa.deliveryAddress,
          feeBreakdown: detail.feeBreakdown,
        },
        loading: false,
      });
    } catch (e: any) {
      // 失败分支同样认主人：旧请求的报错不许把当前弹窗关掉
      if (reviewPrealertIdRef.current !== pa.prealertId) return;
      setToast(e?.message ?? "加载货品详情失败");
      reviewPrealertIdRef.current = null; // 2026-09-02 终审整改：关闭处同步清空 owner
      setReviewTarget(null);
    }
  };

  const handleReviewApprove = async () => {
    if (!reviewTarget) return;
    setReviewSubmitting(true);
    try {
      await apiRequest<any>(
        `${apiBaseUrl()}/admin/whr-consolidation/prealerts/review`,
        {
          method: "POST", headers: jsonPost,
          body: JSON.stringify({ planId: reviewTarget.planId, prealertId: reviewTarget.prealert.prealertId, action: "approve" }),
        }
      );
      setToast("审核通过");
      reviewPrealertIdRef.current = null; // 2026-09-02 终审整改：关闭处同步清空 owner
      setReviewTarget(null);
      loadOperations();
      if (activeTab === "dispatch") loadDispatch();
      if (selectedPlanId) loadPlanDetail(selectedPlanId);
      loadPlans();
    } catch (e: any) {
      setToast(e?.message ?? "审核失败");
      // 失败也要刷新（2026-08-27 补）：后端现在会说「刚刚被别人改过，请刷新后再看」，
      // 页面不刷新的话用户看到的还是旧数字，容易照着旧数字再操作一次。
      loadOperations();
      if (activeTab === "dispatch") loadDispatch();
      if (selectedPlanId) loadPlanDetail(selectedPlanId);
      loadPlans();
    }
    finally { setReviewSubmitting(false); }
  };

  const handleReviewReject = async () => {
    if (!reviewTarget || !rejectReason.trim()) { setToast("请填写拒绝原因"); return; }
    setReviewSubmitting(true);
    try {
      const r = await apiRequest<{ totalFee?: number }>(
        `${apiBaseUrl()}/admin/whr-consolidation/prealerts/review`,
        {
          method: "POST", headers: jsonPost,
          body: JSON.stringify({
            planId: reviewTarget.planId, prealertId: reviewTarget.prealert.prealertId,
            action: "reject", rejectReason: rejectReason.trim(),
          }),
        }
      );
      setToast(r?.totalFee != null ? `已拒绝，应付金额已更新为 ¥${r.totalFee}` : "已拒绝");
      reviewPrealertIdRef.current = null; // 2026-09-02 终审整改：关闭处同步清空 owner
      setShowReject(false); setReviewTarget(null); setRejectReason("");
      loadOperations();
      if (activeTab === "dispatch") loadDispatch();
      if (selectedPlanId) loadPlanDetail(selectedPlanId);
      loadPlans();
    } catch (e: any) {
      setToast(e?.message ?? "操作失败");
      // 失败也要刷新（2026-08-27 补）：后端现在会说「刚刚被别人改过，请刷新后再看」，
      // 页面不刷新的话用户看到的还是旧数字，容易照着旧数字再操作一次。
      loadOperations();
      if (activeTab === "dispatch") loadDispatch();
      if (selectedPlanId) loadPlanDetail(selectedPlanId);
      loadPlans();
    }
    finally { setReviewSubmitting(false); }
  };

  // ---- 装柜确认 ----
  const handleLoadingConfirm = (planId: string, prealertId: string, key: string) => {
    const plan = opsPlans.find(p => p.planId === planId);
    if (plan) {
      const allSections = [
        ...plan.sections.pending,
        ...plan.sections.received_pending_payment,
        ...plan.sections.payment_submitted,
        ...plan.sections.paid,
        ...plan.sections.loading,
        ...plan.sections.shipped,
      ];
      const filled = allSections.reduce((s, pa) => s + (pa.volumeM3 ?? 0), 0);
      const total = plan.totalVolumeM3 || 1;
      const pct = Math.round((filled / total) * 100);
      if (pct < 60) {
        if (!window.confirm(`当前仅装填了 ${filled.toFixed(1)} 方，目标 ${total} 方，仅 ${pct}%。是否确认装柜？`)) return;
      }
    }
    doPrealertAction("/staff/whr-consolidation/loading-confirm", planId, prealertId, key);
  };

  // ---- 发运确认 ----
  const handleShipConfirm = (planId: string, prealertId: string, key: string) => {
    doPrealertAction("/staff/whr-consolidation/ship-confirm", planId, prealertId, key);
  };

  // ---- 泰国签收 ----
  const handleThailandSign = async () => {
    if (!thailandTarget || thailandFiles.length === 0) { setToast("请选择签收单文件"); return; }
    // 2026-09-02 终审整改：还有照片在压缩时不许提交，否则压缩中的那张会被静默漏掉
    if (thailandCompressing) { setToast("照片处理中，稍等一下再提交"); return; }
    const thailandTotal = totalUploadBytes(thailandFiles);
    if (thailandTotal > MAX_UPLOAD_TOTAL_BYTES) {
      setToast(`这 ${thailandFiles.length} 张照片共 ${formatBytes(thailandTotal)}，超过 ${formatBytes(MAX_UPLOAD_TOTAL_BYTES)}，请先删掉几张再提交`);
      return;
    }
    setThailandSubmitting(true);
    try {
      await apiRequest<any>(
        `${apiBaseUrl()}/staff/whr-consolidation/thailand-sign`,
        {
          method: "POST",
          headers: jsonPost,
          body: JSON.stringify({
            planId: thailandTarget.planId, prealertId: thailandTarget.prealertId,
            proofs: thailandFiles.map(f => ({ fileName: f.fileName, mime: f.mime, base64: f.base64 })),
          }),
        }
      );
      setToast("泰国签收成功");
      thailandPrealertIdRef.current = null; // 2026-09-02 终审整改：关闭处同步清空 owner
      setThailandTarget(null); setThailandFiles([]);
      loadOperations(); loadDispatch();
    } catch (e: any) {
      setToast(e?.message ?? "签收失败");
      // 失败也要刷新（2026-08-27 补）：后端现在会说「刚刚被别人改过，请刷新后再看」，
      // 页面不刷新的话用户看到的还是旧数字，容易照着旧数字再操作一次。
      loadOperations(); loadDispatch();
    }
    finally { setThailandSubmitting(false); }
  };

  // ================================================================
  // Excel 导出
  // ================================================================
  const handleExportPlan = async (p: DispatchPlan) => {
    setExporting(true);
    try {
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("尾端拆派");

      const headers = ["计划编号", "仓库", "柜型", "目的地", "客户名", "预报单号", "唛头", "品名", "件数", "长cm", "宽cm", "高cm", "方数(m³)", "重量(kg)", "收货地址", "状态"];
      const colCount = headers.length;

      const headerRow = ws.addRow(headers);
      headerRow.eachCell((cell) => {
        cell.font = { bold: true, size: 11 };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE5E7EB" } };
        cell.alignment = { horizontal: "center", vertical: "middle" };
      });

      const planHeaderStyle = {
        font: { bold: true, size: 12, color: { argb: "FFFFFFFF" } },
        fill: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FF2563EB" } },
        alignment: { horizontal: "left" as const, vertical: "middle" as const },
      };
      const subtotalStyle = {
        font: { bold: true, size: 11, color: { argb: "FF059669" } },
        fill: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFF0FDF4" } },
      };

      let currentRow = 2;
        const planTitleRow = ws.addRow([`${p.planNo}  ${p.warehouse}  ${p.containerType}  →  ${p.destinationTh}  ${p.totalVolumeM3}方`]);
        ws.mergeCells(currentRow, 1, currentRow, colCount);
        planTitleRow.eachCell((cell) => {
          cell.font = planHeaderStyle.font;
          cell.fill = planHeaderStyle.fill;
          cell.alignment = planHeaderStyle.alignment;
        });
        planTitleRow.height = 24;
        currentRow++;

        let planTotalVol = 0;

        for (const c of p.customers) {
          const prealerts = c.prealerts ?? [];
          let customerTotalVol = 0;

          if (prealerts.length === 0) {
            ws.addRow([p.planNo, p.warehouse, p.containerType, p.destinationTh, c.clientName, "", "", "", "", "", "", "", "", "", c.deliveryAddress ?? "", c.status ? (PREALERT_ST_ZH[c.status] ?? c.status) : ""]);
            currentRow++;
          } else {
            for (const pa of prealerts) {
              const items = pa.items ?? [];
              let isFirst = true;

              if (items.length === 0) {
                ws.addRow([p.planNo, p.warehouse, p.containerType, p.destinationTh, c.clientName, pa.trackingNo, pa.mark, "", "", "", "", "", "", "", c.deliveryAddress ?? "", PREALERT_ST_ZH[pa.status] ?? pa.status]);
                currentRow++;
              } else {
                for (const it of items) {
                  const vol = it.volumeM3 ?? 0;
                  customerTotalVol += vol;
                  planTotalVol += vol;

                  const dataRow = ws.addRow([
                    p.planNo, p.warehouse, p.containerType, p.destinationTh, c.clientName,
                    isFirst ? pa.trackingNo : "",
                    isFirst ? pa.mark : "",
                    it.productName, it.packageCount,
                    // 长宽高（2026-08-27 加）。没量过尺寸的货留空，**不要写 0** ——
                    // 写 0 会被当成「量过、是 0」，空着才表示「没这个数」。
                    it.lengthCm ?? "", it.widthCm ?? "", it.heightCm ?? "",
                    vol, it.totalWeightKg ?? 0,
                    c.deliveryAddress ?? "", PREALERT_ST_ZH[pa.status] ?? pa.status,
                  ]);
                  dataRow.getCell(13).numFmt = "0.000";
                  isFirst = false;
                  currentRow++;
                }
              }
            }
          }

          if (customerTotalVol > 0) {
            // 单元格数量必须和表头一致（16 列，2026-08-27 加了长宽高三列），
            // 方数写数字而不是字符串，Excel 里才能求和
            const subRow = ws.addRow([
              "", "", "", "", `${c.clientName} 小计`, "", "", "", "", "", "", "",
              Math.round(customerTotalVol * 1000) / 1000, "", "", "",
            ]);
            subRow.getCell(13).numFmt = "0.000";
            subRow.eachCell((cell, colIdx) => {
              if (colIdx === 13) cell.font = subtotalStyle.font;
              cell.fill = subtotalStyle.fill;
            });
            currentRow++;
          }
        }

        if (planTotalVol > 0) {
          const totalRow = ws.addRow([
            "", "", "", "", `${p.planNo} 合计`, "", "", "", "", "", "", "",
            Math.round(planTotalVol * 1000) / 1000, "", "", "",
          ]);
          totalRow.getCell(13).numFmt = "0.000";
          totalRow.eachCell((cell, colIdx) => {
            if (colIdx === 13) cell.font = { bold: true, size: 12, color: { argb: "FF059669" } };
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFECFDF5" } };
          });
          totalRow.height = 22;
          currentRow++;
        }

      ws.columns = headers.map((_, i) => {
        if (i === 0 || i === 4 || i === 5 || i === 14) return { width: 16 };
        if (i === 7) return { width: 18 };
        return { width: 12 };
      });

      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `尾端拆派_${p.planNo}_${localDateStamp()}.xlsx`; a.click();
      URL.revokeObjectURL(url);
      setToast("导出成功");
    } catch (e: any) { setToast(e?.message ?? "导出失败"); }
    finally { setExporting(false); }
  };

  // ================================================================
  // 渲染
  // ================================================================
  const tabBtnStyle = (tab: string): React.CSSProperties => ({
    padding: "10px 24px", border: "none", background: activeTab === tab ? "var(--c-blue)" : "var(--s-sunken)",
    color: activeTab === tab ? "var(--white)" : "var(--t-body)", borderRadius: "8px 8px 0 0", cursor: "pointer", fontWeight: 600, fontSize: 14,
  });

  return (
    <>
      <div style={{ maxWidth: "100%", padding: "20px 24px" }}>
        {/* Toast */}
        {toast && (
          <div onClick={() => setToast("")} style={{ cursor: "pointer", marginBottom: 16, padding: "10px 16px", background: "var(--c-amber-bg)", color: "var(--c-amber-deep)", borderRadius: 8, fontSize: 14 }}>{toast}</div>
        )}

        {/* Tab 切换 */}
        <div style={{ display: "flex", gap: 4, marginBottom: 20, borderBottom: "2px solid var(--c-blue)" }}>
          <button onClick={() => { setActiveTab("dispatch"); setExpandedPlan(null); setExpandedCustomer(null); }} style={tabBtnStyle("dispatch")}>尾端拆派</button>
          <button onClick={() => setActiveTab("operations")} style={tabBtnStyle("operations")}>操作区</button>
          <button onClick={() => { setActiveTab("plans"); setSelectedPlanId(null); selectedPlanIdRef.current = null; setPlanDetail(null); }} style={tabBtnStyle("plans")}>拼柜计划</button>
        </div>

        {/* ================================================================ */}
        {/* TAB 1: 尾端拆派 */}
        {/* ================================================================ */}
        {activeTab === "dispatch" && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ fontSize: 17, margin: 0 }}>尾端拆派</h3>
            </div>
            {dispatchLoading ? <p style={{ color: "var(--t-faint)" }}>加载中...</p> : (
              dispatchData.length === 0 ? <p style={{ color: "var(--t-faint)", padding: "24px 0" }}>暂无数据</p> :
              dispatchData.map(p => {
                const planExpanded = expandedPlan === p.planId;
                return (
                  <div key={p.planId} style={{ marginBottom: 16, border: "1px solid var(--l-soft)", borderRadius: 10, overflow: "hidden" }}>
                    <div style={{ cursor: "pointer", padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--s-alt)" }}>
                      <div onClick={() => setExpandedPlan(planExpanded ? null : p.planId)} style={{ display: "flex", alignItems: "center", gap: 12, flex: 1 }}>
                        <strong style={{ fontSize: 15 }}>{p.planNo}</strong>
                        <span style={{ fontSize: 13, color: "var(--t-muted)" }}>{p.warehouse} · {p.containerType} · {p.destinationTh} · {p.totalVolumeM3}方</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <button onClick={(e) => { e.stopPropagation(); handleExportPlan(p); }} disabled={exporting} style={{ ...btnGreen, padding: "4px 12px", fontSize: 12 }}>导出</button>
                        <span onClick={() => setExpandedPlan(planExpanded ? null : p.planId)} style={{ fontSize: 12, color: "var(--t-faint)" }}>{p.customers.length} 个客户 {planExpanded ? "▲" : "▼"}</span>
                      </div>
                    </div>
                    {planExpanded && p.customers.map(c => {
                      const cExpanded = expandedCustomer === c.id;
                      const flatItems = (c.prealerts ?? []).flatMap(pa => (pa.items ?? []).map(it => ({ ...it, prealertTrackingNo: pa.trackingNo, prealertMark: pa.mark })));
                      return (
                        <div key={c.id} style={{ borderTop: "1px solid var(--l-soft)" }}>
                          <div onClick={() => setExpandedCustomer(cExpanded ? null : c.id)} style={{ cursor: "pointer", padding: "8px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", background: cExpanded ? "#F0F1F4" : "white" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                              <strong style={{ fontSize: 14 }}>{c.clientName}</strong>
                              <span style={{ fontSize: 12, color: "var(--t-muted)" }}>{c.clientPhone} · {c.clientCompany}</span>
                              {/* 客户维度状态由后端按所有预报单推导，不再拿第一条单的状态冒充 */}
                              {c.status && <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 4, background: TAG[c.status]?.bg ?? "var(--l-soft)", color: TAG[c.status]?.color ?? "var(--t-body)" }}>{PREALERT_ST_ZH[c.status] ?? c.status}</span>}
                              {(c.prealerts ?? []).flatMap(pa => (pa.warehouseReceiptProofs ?? []).map((pf, i) => <img key={`wr-${pa.id}-${i}`} src={pf.base64Path} alt="收货凭证" onClick={(e) => { e.stopPropagation(); setPreviewImage(pf.base64Path); }} style={{ width: 32, height: 32, objectFit: "cover", borderRadius: 4, border: "1px solid var(--l-soft)", cursor: "pointer" }} title={`收货凭证 ${i+1}`} />))}
                              {(c.prealerts ?? []).flatMap(pa => (pa.thailandReceiptProofs ?? []).map((pf, i) => <img key={`th-${pa.id}-${i}`} src={pf.base64Path} alt="泰国签收单" onClick={(e) => { e.stopPropagation(); setPreviewImage(pf.base64Path); }} style={{ width: 32, height: 32, objectFit: "cover", borderRadius: 4, border: "1px solid var(--c-green-2)", cursor: "pointer" }} title={`泰国签收单 ${i+1}`} />))}
                            </div>
                            <span style={{ fontSize: 12, color: "var(--t-faint)" }}>
                              {!c.deliveryAddress && <span style={{ color: "var(--c-red-deep)", marginRight: 8 }}>⚠ 缺地址</span>}
                              {c.totalVolumeM3}方 · {c.totalPackages}件 {cExpanded ? "▲" : "▼"}
                            </span>
                          </div>
                          {cExpanded && flatItems.length > 0 && (
                            <div style={{ padding: "8px 16px", background: "#F0F1F4", overflowX: "auto" }}>
                              <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                                <thead><tr style={{ background: "var(--s-sunken)" }}>
                                  {["预报单号", "唛头", "品名", "件数", "方数(m³)", "重量(kg)", "类型"].map(h => <th key={h} style={{ ...thS, padding: "4px 8px", fontSize: 11 }}>{h}</th>)}
                                </tr></thead>
                                <tbody>{flatItems.map((it, i) => (
                                  <tr key={i}>
                                    <td style={{ ...tdS, padding: "4px 8px", fontSize: 11, minWidth: 100, whiteSpace: "nowrap" }}>{(it as any).prealertTrackingNo}</td>
                                    <td style={{ ...tdS, padding: "4px 8px", fontSize: 11, minWidth: 80, whiteSpace: "nowrap" }}>{(it as any).prealertMark}</td>
                                    <td style={{ ...tdS, padding: "4px 8px", fontSize: 11 }}>{it.productName}</td>
                                    <td style={{ ...tdS, padding: "4px 8px", fontSize: 11 }}>{it.packageCount}</td>
                                    <td style={{ ...tdS, padding: "4px 8px", fontSize: 11 }}>{it.volumeM3 != null ? it.volumeM3 : "-"}</td>
                                    <td style={{ ...tdS, padding: "4px 8px", fontSize: 11 }}>{it.totalWeightKg != null ? it.totalWeightKg : "-"}</td>
                                    <td style={{ ...tdS, padding: "4px 8px", fontSize: 11 }}>{it.cargoType === "inspection" ? "商检货" : it.cargoType === "sensitive" ? "敏感货" : "普货"}</td>
                                  </tr>
                                ))}</tbody>
                              </table>
                            </div>
                          )}
                          {cExpanded && (
                            <div style={{ padding: "4px 16px 8px", fontSize: 12 }}>
                              {c.deliveryAddress
                                ? <span style={{ color: "var(--t-muted)" }}>收货地址：{c.deliveryAddress}</span>
                                : <span style={{ color: "var(--c-red-deep)", background: "var(--c-red-bg)", padding: "2px 8px", borderRadius: 4 }}>⚠ 收货地址未填写，无法派送 —— 请联系该客户在客户端补填</span>}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })
            )}
          </>
        )}

        {/* ================================================================ */}
        {/* TAB 2: 操作区 */}
        {/* ================================================================ */}
        {activeTab === "operations" && (
          <>
            <h3 style={{ fontSize: 17, marginBottom: 16 }}>操作区</h3>
            {opsLoading ? <p style={{ color: "var(--t-faint)" }}>加载中...</p> : (
              opsPlans.length === 0 ? <p style={{ color: "var(--t-faint)", padding: "24px 0" }}>暂无活跃计划</p> :
              opsPlans.map(p => (
                <div key={p.planId} style={{ marginBottom: 20, border: "1px solid var(--l-soft)", borderRadius: 10, overflow: "hidden" }}>
                  <div style={{ padding: "10px 16px", background: "var(--s-alt)", borderBottom: "1px solid var(--l-soft)", display: "flex", gap: 12, alignItems: "center", fontSize: 14, fontWeight: 600, color: "#14171D" }}>
                    <span>{p.planNo}</span>
                    <span style={{ fontWeight: 400, fontSize: 13, color: "var(--t-muted)" }}>
                      {p.warehouse} · {p.containerType} · {p.destinationTh} ·{" "}
                      {p.usedVolumeM3 != null ? `已用 ${p.usedVolumeM3} / ${p.totalVolumeM3} 方` : `${p.totalVolumeM3}方`}
                    </span>
                  </div>

                  {/* --- 待签收 --- */}
                  {/* --- 待签收 --- */}
                  {p.sections.pending.length > 0 && (
                    <Section title="仓库签收" count={p.sections.pending.length} emptyMsg="">
                      {p.sections.pending.map(pa => (
                        <div key={pa.prealertId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid var(--s-sunken)", fontSize: 13 }}>
                          <div style={{ flex: 1 }}>
                            <strong>{pa.clientName}</strong>
                            <span style={{ color: "var(--t-muted)", marginLeft: 8 }}>{pa.trackingNo}</span>
                            <span style={{ color: "var(--t-faint)", marginLeft: 8 }}>唛头：{pa.mark || "-"} · {pa.volumeM3}方 · {pa.itemCount}款 · {pa.packageCount}件</span>
                            {pa.deliveryAddress
                              ? <span style={{ color: "var(--t-muted)", marginLeft: 8 }}>🏠{pa.deliveryAddress}</span>
                              : <span style={{ color: "var(--c-red-deep)", background: "var(--c-red-bg)", padding: "1px 6px", borderRadius: 4, marginLeft: 8 }}>⚠ 收货地址未填写</span>}
                          </div>
                          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                            <button onClick={() => handleOpenSign(pa, p.planId)} style={btnBlue}>签收</button>
                            <button onClick={(e) => { e.stopPropagation(); handleCancelPrealert(p.planId, pa.prealertId, pa.trackingNo); }} style={{ padding: "4px 10px", border: "1px solid var(--l-strong)", color: "var(--t-muted)", background: "var(--white)", borderRadius: 4, cursor: "pointer", fontSize: 12 }}>取消</button>
                          </div>
                        </div>
                      ))}
                    </Section>
                  )}

                  {/* --- 待付款（只读展示，等待客户端上传付款凭证） --- */}
                  {p.sections.received_pending_payment.length > 0 && (
                    <Section title="待付款" count={p.sections.received_pending_payment.length} emptyMsg="">
                      {p.sections.received_pending_payment.map(pa => (
                        <div key={pa.prealertId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid var(--s-sunken)", fontSize: 13 }}>
                          <div style={{ flex: 1 }}>
                            <strong>{pa.clientName}</strong>
                            <span style={{ color: "var(--t-muted)", marginLeft: 8 }}>{pa.trackingNo}</span>
                            <span style={{ color: "var(--t-faint)", marginLeft: 8 }}>唛头：{pa.mark || "-"} · {pa.volumeM3}方 · {pa.itemCount}款 · {pa.packageCount}件</span>
                            {pa.deliveryAddress
                              ? <span style={{ color: "var(--t-muted)", marginLeft: 8 }}>🏠{pa.deliveryAddress}</span>
                              : <span style={{ color: "var(--c-red-deep)", background: "var(--c-red-bg)", padding: "1px 6px", borderRadius: 4, marginLeft: 8 }}>⚠ 收货地址未填写</span>}
                            {pa.totalFee != null && <span style={{ color: "var(--c-green)", marginLeft: 8, fontWeight: 600 }}>{money(pa.totalFee)}</span>}
                          </div>
                        </div>
                      ))}
                    </Section>
                  )}

                  {/* --- 待审核付款 --- */}
                  {p.sections.payment_submitted.length > 0 && (
                    <Section title="审核付款" count={p.sections.payment_submitted.length} emptyMsg="">
                      {p.sections.payment_submitted.map(pa => (
                        <div key={pa.prealertId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid var(--s-sunken)", fontSize: 13 }}>
                          <div style={{ flex: 1 }}>
                            <strong>{pa.clientName}</strong>
                            <span style={{ color: "var(--t-muted)", marginLeft: 8 }}>{pa.trackingNo}</span>
                            <span style={{ color: "var(--t-faint)", marginLeft: 8 }}>唛头：{pa.mark || "-"} · {pa.volumeM3}方 · {pa.itemCount}款 · {pa.packageCount}件</span>
                            {pa.deliveryAddress
                              ? <span style={{ color: "var(--t-muted)", marginLeft: 8 }}>🏠{pa.deliveryAddress}</span>
                              : <span style={{ color: "var(--c-red-deep)", background: "var(--c-red-bg)", padding: "1px 6px", borderRadius: 4, marginLeft: 8 }}>⚠ 收货地址未填写</span>}
                            {pa.totalFee != null && <span style={{ color: "var(--c-green)", marginLeft: 8, fontWeight: 600 }}>{money(pa.totalFee)}</span>}
                            {pa.paymentProofs && pa.paymentProofs.length > 0 && (
                              <span style={{ marginLeft: 8, display: "inline-flex", gap: 4 }}>
                                {(pa.paymentProofs as any[]).slice(0, 3).map((pf: any, i: number) => {
                                  const imgSrc = toImageSrc(pf?.base64Path || pf?.base64 || pf, pf?.mime);
                                  if (!imgSrc) return null;
                                  return <img key={i} src={imgSrc} alt={`凭证${i+1}`} onClick={(e) => { e.stopPropagation(); setPreviewImage(imgSrc); }} style={{ width: 32, height: 32, objectFit: "cover", borderRadius: 3, border: "1px solid var(--l-soft)", cursor: "pointer" }} />;
                                })}
                                {pa.paymentProofs.length > 3 && <span style={{ fontSize: 11, color: "var(--t-faint)" }}>+{pa.paymentProofs.length - 3}</span>}
                              </span>
                            )}
                          </div>
                          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                            <button onClick={() => handleOpenReview(pa, p.planId)} style={btnBlue}>审核</button>
                            <button onClick={(e) => { e.stopPropagation(); handleCancelPrealert(p.planId, pa.prealertId, pa.trackingNo); }} style={{ padding: "4px 10px", border: "1px solid var(--l-strong)", color: "var(--t-muted)", background: "var(--white)", borderRadius: 4, cursor: "pointer", fontSize: 12 }}>取消</button>
                          </div>
                        </div>
                      ))}
                    </Section>
                  )}

                  {/* --- 待装柜 --- */}
                  {p.sections.paid.length > 0 && (
                    <Section title="装柜确认" count={p.sections.paid.length} emptyMsg="">
                      {p.sections.paid.map(pa => {
                        const key = `loading-${pa.prealertId}`;
                        return (
                          <div key={pa.prealertId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid var(--s-sunken)", fontSize: 13 }}>
                            <div style={{ flex: 1 }}>
                              <strong>{pa.clientName}</strong>
                              <span style={{ color: "var(--t-muted)", marginLeft: 8 }}>{pa.trackingNo}</span>
                              <span style={{ color: "var(--t-faint)", marginLeft: 8 }}>唛头：{pa.mark || "-"} · {pa.volumeM3}方 · {pa.itemCount}款</span>
                              {pa.deliveryAddress
                              ? <span style={{ color: "var(--t-muted)", marginLeft: 8 }}>🏠{pa.deliveryAddress}</span>
                              : <span style={{ color: "var(--c-red-deep)", background: "var(--c-red-bg)", padding: "1px 6px", borderRadius: 4, marginLeft: 8 }}>⚠ 收货地址未填写</span>}
                              {pa.totalFee != null && <span style={{ color: "var(--c-green)", marginLeft: 8, fontWeight: 600 }}>{money(pa.totalFee)}</span>}
                            </div>
                            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                              <button onClick={() => handleLoadingConfirm(p.planId, pa.prealertId, key)} disabled={opsActionSubmitting[key]} style={btnBlue}>{opsActionSubmitting[key] ? "..." : "确认装柜"}</button>
                              <button onClick={(e) => { e.stopPropagation(); handleCancelPrealert(p.planId, pa.prealertId, pa.trackingNo); }} style={{ padding: "4px 10px", border: "1px solid var(--l-strong)", color: "var(--t-muted)", background: "var(--white)", borderRadius: 4, cursor: "pointer", fontSize: 12 }}>取消</button>
                            </div>
                          </div>
                        );
                      })}
                    </Section>
                  )}

                  {/* --- 待发运 --- */}
                  {p.sections.loading.length > 0 && (
                    <Section title="发运确认" count={p.sections.loading.length} emptyMsg="">
                      {p.sections.loading.map(pa => {
                        const key = `ship-${pa.prealertId}`;
                        return (
                          <div key={pa.prealertId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid var(--s-sunken)", fontSize: 13 }}>
                            <div style={{ flex: 1 }}>
                              <strong>{pa.clientName}</strong>
                              <span style={{ color: "var(--t-muted)", marginLeft: 8 }}>{pa.trackingNo}</span>
                              <span style={{ color: "var(--t-faint)", marginLeft: 8 }}>唛头：{pa.mark || "-"} · {pa.volumeM3}方 · {pa.itemCount}款</span>
                              {pa.deliveryAddress
                              ? <span style={{ color: "var(--t-muted)", marginLeft: 8 }}>🏠{pa.deliveryAddress}</span>
                              : <span style={{ color: "var(--c-red-deep)", background: "var(--c-red-bg)", padding: "1px 6px", borderRadius: 4, marginLeft: 8 }}>⚠ 收货地址未填写</span>}
                            </div>
                            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                              <button onClick={() => handleShipConfirm(p.planId, pa.prealertId, key)} disabled={opsActionSubmitting[key]} style={btnBlue}>{opsActionSubmitting[key] ? "..." : "确认发运"}</button>
                            </div>
                          </div>
                        );
                      })}
                    </Section>
                  )}

                  {/* --- 待泰国签收 --- */}
                  {p.sections.shipped.length > 0 && (
                    <Section title="泰国签收" count={p.sections.shipped.length} emptyMsg="">
                      {p.sections.shipped.map(pa => (
                        <div key={pa.prealertId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid var(--s-sunken)", fontSize: 13 }}>
                          <div style={{ flex: 1 }}>
                            <strong>{pa.clientName}</strong>
                            <span style={{ color: "var(--t-muted)", marginLeft: 8 }}>{pa.trackingNo}</span>
                            <span style={{ color: "var(--t-faint)", marginLeft: 8 }}>唛头：{pa.mark || "-"} · {pa.volumeM3}方 · {pa.itemCount}款</span>
                            {pa.deliveryAddress
                              ? <span style={{ color: "var(--t-muted)", marginLeft: 8 }}>🏠{pa.deliveryAddress}</span>
                              : <span style={{ color: "var(--c-red-deep)", background: "var(--c-red-bg)", padding: "1px 6px", borderRadius: 4, marginLeft: 8 }}>⚠ 收货地址未填写</span>}
                          </div>
                          <div style={{ flexShrink: 0 }}>
                            {/* 2026-09-01 竞态全扫：换单先清掉上一单残留的照片，防止跟错单 */}
                            <button onClick={() => { /* 2026-09-02 终审整改：点击处同步赋值 owner ref，不等 useEffect */ thailandPrealertIdRef.current = pa.prealertId; setThailandFiles([]); setThailandTarget({ planId: p.planId, prealertId: pa.prealertId, planNo: p.planNo, trackingNo: pa.trackingNo, clientName: pa.clientName, volumeM3: pa.volumeM3 }); }} style={btnBlue}>上传签收单</button>
                          </div>
                        </div>
                      ))}
                    </Section>
                  )}

                </div>
              ))
            )}
          </>
        )}

        {/* ================================================================ */}
        {/* TAB 3: 拼柜计划 */}
        {/* ================================================================ */}
        {activeTab === "plans" && (
          <>
            <h3 style={{ fontSize: 17, marginBottom: 16 }}>拼柜计划</h3>
            {planLoading || detailLoading ? <p style={{ color: "var(--t-faint)" }}>加载中...</p> : (
              planDetail ? (
                <div>
                  <button onClick={() => { setPlanDetail(null); setSelectedPlanId(null); selectedPlanIdRef.current = null; }} style={{ ...btnGray, marginBottom: 16 }}>← 返回列表</button>

                  <div style={{ border: "1px solid var(--l-soft)", borderRadius: 10, padding: 16, marginBottom: 16 }}>
                    <h4 style={{ margin: "0 0 8px" }}>{planDetail.planNo}</h4>
                    <p style={{ fontSize: 13, color: "var(--t-muted)", margin: 0 }}>{planDetail.warehouse} · {planDetail.containerType} · {planDetail.destinationTh} · {planDetail.totalVolumeM3}方 · <span style={{ padding: "2px 8px", borderRadius: 4, background: TAG[planDetail.status]?.bg ?? "var(--l-soft)", color: TAG[planDetail.status]?.color ?? "var(--t-body)", fontSize: 12 }}>{PLAN_ST_ZH[planDetail.status] ?? planDetail.status}</span></p>
                    {/* 2026-09-15：创建人只给超级管理员显示；员工只看到创建时间 */}
                    <p style={{ fontSize: 12, color: "var(--t-faint)", margin: "4px 0 0" }}>{viewerCanSeeOperator() && planDetail.creatorName ? `创建人：${planDetail.creatorName} · ` : ""}{formatBeijingTime(planDetail.createdAt)}</p>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                    <h4 style={{ fontSize: 15, margin: 0 }}>客户列表</h4>
                    {/* 计划一旦开始装柜/发运就不给再加人，后端也拦了一道 */}
                    {["planning", "collecting"].includes(planDetail.status) && (
                      <button onClick={openAddCustomer} style={{ ...btnGray, padding: "4px 12px", fontSize: 12 }}>新增客户</button>
                    )}
                  </div>
                  {planDetail.customers.map((c: any) => (
                    <div key={c.id} style={{ border: "1px solid var(--l-soft)", borderRadius: 8, padding: "12px 16px", marginBottom: 12 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div>
                          <strong>{c.clientName}</strong>
                          <span style={{ fontSize: 13, color: "var(--t-muted)", marginLeft: 8 }}>{c.clientPhone} · {c.clientCompany}</span>
                        </div>
                        <span style={{ fontSize: 13, color: "var(--t-muted)" }}>{c.totalVolumeM3}方 · {c.totalFee ? `¥${c.totalFee.toLocaleString()}` : ""}</span>
                      </div>
                      <div style={{ fontSize: 13, color: "var(--t-muted)", marginTop: 4, display: "flex", alignItems: "center", gap: 10 }}>
                        <span>普货：{c.unitPriceNormal}元/方 · 商检货：{c.unitPriceInspection}元/方 · 敏感货：{c.unitPriceSensitive}元/方</span>
                        {/* 已装柜/已发运的计划不给动参与名单，和「新增客户」同一条口径 */}
                        {["planning", "collecting"].includes(planDetail.status) && (
                          <button onClick={() => handleRemoveCustomer(c)} disabled={removingCustomerId === c.id} style={{ ...btnGray, padding: "3px 10px", fontSize: 12, color: "var(--c-red-deep)", borderColor: "#fecaca" }}>{removingCustomerId === c.id ? "移除中..." : "移除客户"}</button>
                        )}
                      </div>
                      {c.deliveryAddress && <div style={{ fontSize: 13, color: "var(--t-muted)", marginTop: 2 }}>收货地址：{c.deliveryAddress}</div>}

                      {/* 预报单列表 */}
                      {(c.prealerts ?? []).length > 0 && (
                        <div style={{ marginTop: 10, borderTop: "1px solid var(--l-soft)", paddingTop: 10 }}>
                          <div style={{ fontWeight: 600, color: "var(--t-body)", marginBottom: 8, fontSize: 13 }}>预报单（{c.prealerts.length}）</div>
                          {c.prealerts.map((pa: any) => {
                            const paVol = (pa.items ?? []).reduce((s: number, it: any) => s + (it.volumeM3 ?? 0), 0);
                            const paPkg = (pa.items ?? []).reduce((s: number, it: any) => s + it.packageCount, 0);
                            const paStatus = pa.status;
                            const canSign = paStatus === "pending";
                            const canReview = paStatus === "payment_submitted";
                            return (
                              <div key={pa.id} style={{ border: "1px solid var(--l-soft)", borderRadius: 6, padding: "8px 12px", marginBottom: 8, background: "var(--s-alt)", fontSize: 12 }}>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                    <strong>{pa.trackingNo}</strong>
                                    <span style={{ color: "var(--t-muted)" }}>唛头：{pa.mark || "-"}</span>
                                    {pa.expressNo && <span style={{ color: "var(--t-muted)" }}>快递：{pa.expressNo}</span>}
                                    <span style={{ fontSize: 11, padding: "2px 6px", borderRadius: 3, background: TAG[paStatus]?.bg ?? "var(--l-soft)", color: TAG[paStatus]?.color ?? "var(--t-body)" }}>
                                      {PREALERT_ST_ZH[paStatus] ?? paStatus}
                                    </span>
                                  </div>
                                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                    <span style={{ color: "var(--t-muted)" }}>{paVol.toFixed(3)}方 · {paPkg}件</span>
                                    {canSign && (
                                      <button onClick={() => handleOpenSign({ prealertId: pa.id, trackingNo: pa.trackingNo, mark: pa.mark, clientName: c.clientName, planNo: planDetail.planNo, deliveryAddress: c.deliveryAddress }, selectedPlanId!)} style={{ ...btnBlue, padding: "4px 12px", fontSize: 11 }}>签收</button>
                                    )}
                                    {canReview && (
                                      <button onClick={() => {
                                        const paObj = { prealertId: pa.id, trackingNo: pa.trackingNo, mark: pa.mark, clientName: c.clientName, clientId: c.clientId, clientPhone: c.clientPhone, clientCompany: c.clientCompany, deliveryAddress: c.deliveryAddress, volumeM3: paVol, itemCount: (pa.items ?? []).length, packageCount: paPkg, status: paStatus };
                                        handleOpenReview(paObj, selectedPlanId!);
                                      }} style={{ ...btnBlue, padding: "4px 12px", fontSize: 11 }}>审核</button>
                                    )}
                                  </div>
                                </div>

                                {/* 货品表格 */}
                                {(pa.items ?? []).length > 0 && (
                                  <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, marginTop: 6 }}>
                                    <thead><tr style={{ background: "var(--s-sunken)" }}>
                                      {["品名","件数","方数","类型"].map(h => <th key={h} style={{ ...thS, padding: "3px 6px", fontSize: 10 }}>{h}</th>)}
                                    </tr></thead>
                                    <tbody>
                                      {(pa.items ?? []).map((it: any, idx: number) => (
                                        <tr key={idx}>
                                          <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.productName}</td>
                                          <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.packageCount}</td>
                                          <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.volumeM3 != null ? (typeof it.volumeM3 === "number" ? it.volumeM3.toFixed(4) : it.volumeM3) : "-"}</td>
                                          <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.cargoType === "inspection" ? "商检货" : it.cargoType === "sensitive" ? "敏感货" : "普货"}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                  {planDetail.customers.length === 0 && <p style={{ color: "var(--t-faint)", fontSize: 14, padding: "12px 0" }}>暂无客户</p>}
                </div>
              ) : (
                <>
                  {planList.length === 0 ? <p style={{ color: "var(--t-faint)", fontSize: 14, padding: "12px 0" }}>暂无计划</p> : (
                    <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                      <thead>
                        <tr style={{ background: "var(--s-sunken)" }}>
                          {/* 2026-09-15：「创建人」列只给超级管理员 —— 表头和下面数据行的 <td> 用同一个条件，一起有一起没（CLAUDE.md 第 10 条） */}
                          {["计划编号", "仓库", "柜型", "目的地", "总方数", "已用/进度", "客户数", "状态", ...(viewerCanSeeOperator() ? ["创建人"] : []), "创建时间"].map(h => <th key={h} style={thS}>{h}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {planList.map(p => {
                          const isSelected = selectedPlanId === p.id;
                          return (
                          <tr key={p.id} onClick={() => { /* 2026-09-01 竞态全扫：ref 和 state 同步改，详情响应回来按 ref 认主人 */ setSelectedPlanId(p.id); selectedPlanIdRef.current = p.id; loadPlanDetail(p.id); }} style={{ cursor: "pointer", borderBottom: "1px solid var(--s-sunken)", background: isSelected ? "var(--c-blue-bg)" : "white" }} onMouseEnter={e => (e.currentTarget.style.background = "var(--s-alt)")} onMouseLeave={e => (e.currentTarget.style.background = isSelected ? "var(--c-blue-bg)" : "white")}>
                            <td style={{ ...tdS, fontWeight: 600 }}>{p.planNo}</td>
                            <td style={tdS}>{p.warehouse}</td>
                            <td style={tdS}>{p.containerType}</td>
                            <td style={tdS}>{p.destinationTh}</td>
                            <td style={tdS}>{p.totalVolumeM3}方</td>
                            <td style={tdS}>
                              {(() => {
                                const used = p.usedVolumeM3 ?? 0;
                                const total = p.totalVolumeM3 || 1;
                                const pct = Math.round((used / total) * 100);
                                const warn = pct > 80;
                                return (
                                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                    <span style={{ fontSize: 12, fontWeight: 600, color: warn ? "var(--c-red)" : "var(--t-body)" }}>{used.toFixed(1)}方</span>
                                    <div style={{ flex: 1, minWidth: 40, height: 6, background: "var(--l-soft)", borderRadius: 3, overflow: "hidden" }}>
                                      <div style={{ width: Math.min(pct, 100) + "%", height: "100%", background: warn ? "var(--c-red)" : "var(--c-green)", borderRadius: 3, transition: "width 0.3s" }} />
                                    </div>
                                    <span style={{ fontSize: 11, color: warn ? "var(--c-red)" : "var(--t-muted)", fontWeight: warn ? 600 : 400 }}>{pct}%</span>
                                  </div>
                                );
                              })()}
                            </td>
                            <td style={tdS}>{p.customerCount}</td>
                            <td style={tdS}><span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 12, background: TAG[p.status]?.bg ?? "var(--l-soft)", color: TAG[p.status]?.color ?? "var(--t-body)" }}>{PLAN_ST_ZH[p.status] ?? p.status}</span></td>
                            {viewerCanSeeOperator() ? <td style={tdS}>{p.creatorName}</td> : null}
                            <td style={{ ...tdS, fontSize: 12 }}>{formatBeijingTime(p.createdAt)}</td>
                          </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </>
              )
            )}
          </>
        )}

        {/* ================================================================ */}
        {/* 弹窗：仓库签收 */}
        {/* ================================================================ */}
        {signTarget && (
          <Modal onClose={() => { signPrealertIdRef.current = null; /* 2026-09-02 终审整改：关闭处同步清空 owner */ setSignTarget(null); setSignFiles([]); }}>
            <h3 style={{ marginTop: 0 }}>仓库签收</h3>
            <p style={{ fontSize: 13, color: "var(--t-muted)" }}>{signTarget.planNo} · 预报单：{signTarget.trackingNo} · 唛头：{signTarget.mark || "-"}</p>
            <p style={{ fontSize: 13, color: "var(--t-body)" }}>
              客户：{signTarget.clientName}
              {signTarget.clientCompany && <span style={{ color: "var(--t-muted)", marginLeft: 8 }}>{signTarget.clientCompany}</span>}
              {signTarget.clientPhone && <span style={{ color: "var(--t-muted)", marginLeft: 8 }}>{signTarget.clientPhone}</span>}
            </p>
            {signTarget.deliveryAddress && <p style={{ fontSize: 12, color: "var(--t-muted)" }}>收货地址：{signTarget.deliveryAddress}</p>}

            {/* 货品清单 */}
            {signTarget.loading ? (
              <p style={{ color: "var(--t-faint)", padding: "12px 0" }}>加载预报单详情...</p>
            ) : (
              (signTarget.items ?? []).length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 12 }}>货品清单（{signTarget.items!.length}款）</div>
                  <div style={{ maxHeight: 300, overflowY: "auto" }}>
                    <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                      <thead><tr style={{ background: "var(--s-sunken)" }}>
                        {["品名","件数","方数","材质","类型"].map(h => <th key={h} style={{ ...thS, padding: "3px 6px", fontSize: 10 }}>{h}</th>)}
                      </tr></thead>
                      <tbody>
                        {signTarget.items!.map((it: any, idx: number) => (
                          <tr key={idx}>
                            <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.productName}</td>
                            <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.packageCount}</td>
                            <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.volumeM3 != null ? (typeof it.volumeM3 === "number" ? it.volumeM3.toFixed(4) : it.volumeM3) : "-"}</td>
                            <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.material || "-"}</td>
                            <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.cargoType === "inspection" ? "商检货" : it.cargoType === "sensitive" ? "敏感货" : "普货"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            )}

            <div style={{ marginTop: 14 }}>
              <label style={fl}>收货凭证照片 *（支持多张）</label>
              <input type="file" accept="image/*" multiple disabled={signCompressing} onChange={async e => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                if (files.length === 0) return;
                // 2026-09-01 竞态全扫：记住出发时是给哪张预报单选的照片，压缩回来先认主人
                const ownerPrealertId = signTarget.prealertId;
                setSignCompressing(true);
                try {
                  const { ready, skipped } = await prepareUploadFiles(files);
                  // 弹窗已关或已换成别的预报单：照片不许落到别的单上
                  if (signPrealertIdRef.current !== ownerPrealertId) return;
                  if (ready.length > 0) setSignFiles(prev => [...prev, ...ready]);
                  if (skipped.length > 0) setToast(`以下照片没能加进来：${skipped.join("；")}`);
                } finally { setSignCompressing(false); }
              }} style={{ marginTop: 4 }} />
              {signCompressing && <div style={{ marginTop: 4, fontSize: 12, color: "var(--t-muted)" }}>正在处理照片，请稍候…</div>}
              {signFiles.length > 0 && (
                <div style={{ marginTop: 4, fontSize: 12 }}>
                  <span style={{ color: "var(--c-green-2)" }}>已选择 {signFiles.length} 张照片（共 {formatBytes(totalUploadBytes(signFiles))}）</span>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                    {signFiles.map((f, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 4, background: "var(--s-sunken)", padding: "2px 8px", borderRadius: 4 }}>
                        <span style={{ maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.fileName}</span>
                        <button onClick={() => setSignFiles(prev => prev.filter((_, j) => j !== i))} style={{ border: "none", background: "none", color: "var(--c-red)", cursor: "pointer", fontSize: 14, padding: 0, lineHeight: 1 }}>×</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
              {/* 2026-09-02 终审整改：压缩中也禁用，防止压缩中的照片被静默漏掉 */}
              <button onClick={handleWarehouseSign} disabled={signSubmitting || signCompressing || signFiles.length === 0} style={{ ...btnBlue, opacity: signFiles.length === 0 || signCompressing ? 0.5 : 1, cursor: signFiles.length === 0 || signCompressing ? "not-allowed" : "pointer" }}>
                {signSubmitting ? "提交中..." : signCompressing ? "照片处理中…" : "确认签收"}
              </button>
              <button onClick={() => { signPrealertIdRef.current = null; /* 2026-09-02 终审整改：关闭处同步清空 owner */ setSignTarget(null); setSignFiles([]); }} style={btnGray}>取消</button>
            </div>

          </Modal>
        )}

        {/* ================================================================ */}
        {/* 弹窗：审核付款 */}
        {/* ================================================================ */}
        {reviewTarget && (
          <Modal onClose={() => { reviewPrealertIdRef.current = null; /* 2026-09-02 终审整改：关闭处同步清空 owner */ setReviewTarget(null); setShowReject(false); }}>
            {showReject ? (
              <>
                <h3 style={{ marginTop: 0 }}>审核不通过</h3>
                <p style={{ fontSize: 13, color: "var(--t-muted)" }}>预报单：{reviewTarget.prealert.trackingNo} · {reviewTarget.prealert.mark}</p>
                {reviewTarget.prealert.deliveryAddress && <p style={{ fontSize: 12, color: "var(--t-muted)" }}>收货地址：{reviewTarget.prealert.deliveryAddress}</p>}
                <div style={{ marginTop: 10 }}>
                  <label style={fl}>拒绝原因 *</label>
                  <textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)} placeholder="请填写拒绝原因" style={{ ...fi, minHeight: 80 }} />
                </div>
                {/* 拒绝时不顺带改单价：改价是超管在柜详情点「改单价」（2026-09-18 起恢复） */}
                <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
                  <button onClick={handleReviewReject} disabled={reviewSubmitting} style={btnBlue}>{reviewSubmitting ? "提交中..." : "确认拒绝"}</button>
                  <button onClick={() => { setShowReject(false); setRejectReason(""); }} style={btnGray}>取消</button>
                </div>
              </>
            ) : (
              <>
                <h3 style={{ marginTop: 0 }}>审核付款</h3>
                <div style={{ fontSize: 13 }}>
                  <p style={{ margin: "4px 0" }}>预报单：{reviewTarget.prealert.trackingNo} · 唛头：{reviewTarget.prealert.mark || "-"}</p>
                  <p style={{ margin: "4px 0" }}>客户：{reviewTarget.prealert.clientName}</p>
                  {reviewTarget.prealert.deliveryAddress && <p style={{ margin: "2px 0", color: "var(--t-muted)" }}>收货地址：{reviewTarget.prealert.deliveryAddress}</p>}

                  {reviewTarget.prealert.totalFee != null && (
                    <p style={{ margin: "8px 0", fontSize: 16, fontWeight: 700, color: "var(--c-green)" }}>应付金额：{money(reviewTarget.prealert.totalFee)}</p>
                  )}

                  {/* 货品明细 */}
                  {reviewTarget.prealert.loading ? (
                    <p style={{ color: "var(--t-faint)", padding: "12px 0" }}>加载货品明细...</p>
                  ) : (
                    <>
                      {(reviewTarget.prealert.items ?? []).length > 0 && (
                        <div style={{ marginTop: 8 }}>
                          <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 12 }}>货品明细</div>
                          <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                            <thead><tr style={{ background: "var(--s-sunken)" }}>
                              {["品名","件数","方数","重量(kg)","类型"].map(h => <th key={h} style={{ ...thS, padding: "3px 6px", fontSize: 10 }}>{h}</th>)}
                            </tr></thead>
                            <tbody>
                              {(reviewTarget.prealert.items ?? []).map((it: any, idx: number) => (
                                <tr key={idx}>
                                  <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.productName}</td>
                                  <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.packageCount}</td>
                                  <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.volumeM3 != null ? (typeof it.volumeM3 === "number" ? it.volumeM3.toFixed(3) : it.volumeM3) : "-"}</td>
                                  <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.totalWeightKg != null ? it.totalWeightKg : "-"}</td>
                                  <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.cargoType === "inspection" ? "商检货" : it.cargoType === "sensitive" ? "敏感货" : "普货"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}

                      {/* 费用明细 —— 直接用后端下发的，和结算口径一致；
                          前端自己按当前单价再算一遍会和已锁定的金额对不上 */}
                      <div style={{ marginTop: 8 }}>
                        <FeeBreakdownPanel bd={reviewTarget.prealert.feeBreakdown} title="费用是这样算出来的" />
                      </div>

                      {/* 付款截图 */}
                      {(() => {
                        const proofs = reviewTarget.prealert.paymentProofs;
                        if (!proofs || (Array.isArray(proofs) && proofs.length === 0)) return null;
                        const proofList = Array.isArray(proofs) ? proofs : [proofs];
                        return (
                          <div style={{ marginTop: 8 }}>
                            <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 12 }}>付款截图（{proofList.length}张）</div>
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              {proofList.map((pf: any, idx: number) => {
                                const imgSrc = toImageSrc(pf?.base64Path || pf?.base64 || pf, pf?.mime);
                                if (!imgSrc) return null;
                                return <img key={idx} src={imgSrc} alt={`付款截图${idx + 1}`} onClick={() => setPreviewImage(imgSrc)} style={{ width: 100, height: 100, objectFit: "cover", borderRadius: 6, border: "1px solid var(--l-soft)", cursor: "pointer" }} />;
                              })}
                            </div>
                          </div>
                        );
                      })()}
                    </>
                  )}
                </div>
                <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
                  <button onClick={handleReviewApprove} disabled={reviewSubmitting} style={btnBlue}>{reviewSubmitting ? "..." : "审核通过"}</button>
                  <button onClick={() => { setShowReject(true); setRejectReason(""); }} style={btnGray}>审核不通过</button>
                </div>
              </>
            )}
          </Modal>
        )}


        {/* ================================================================ */}
        {/* 弹窗：泰国签收 */}
        {/* ================================================================ */}
        {thailandTarget && (
          <Modal onClose={() => { thailandPrealertIdRef.current = null; /* 2026-09-02 终审整改：关闭处同步清空 owner */ setThailandTarget(null); setThailandFiles([]); }}>
            <h3 style={{ marginTop: 0 }}>泰国签收 - {thailandTarget.clientName}</h3>
            <p style={{ fontSize: 13, color: "var(--t-muted)" }}>{thailandTarget.planNo} · 预报单：{thailandTarget.trackingNo} · {thailandTarget.volumeM3}方</p>
            <div style={{ marginTop: 14 }}>
              <label style={fl}>签收单文件 *（支持多张）</label>
              <input type="file" accept="image/*" multiple disabled={thailandCompressing} onChange={async e => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                if (files.length === 0) return;
                // 2026-09-01 竞态全扫：记住出发时是给哪张预报单选的照片，压缩回来先认主人
                const ownerPrealertId = thailandTarget.prealertId;
                setThailandCompressing(true);
                try {
                  const { ready, skipped } = await prepareUploadFiles(files);
                  // 弹窗已关或已换成别的预报单：照片不许落到别的单上
                  if (thailandPrealertIdRef.current !== ownerPrealertId) return;
                  if (ready.length > 0) setThailandFiles(prev => [...prev, ...ready]);
                  if (skipped.length > 0) setToast(`以下照片没能加进来：${skipped.join("；")}`);
                } finally { setThailandCompressing(false); }
              }} style={{ marginTop: 4 }} />
              {thailandCompressing && <div style={{ marginTop: 4, fontSize: 12, color: "var(--t-muted)" }}>正在处理照片，请稍候…</div>}
              {thailandFiles.length > 0 && (
                <div style={{ marginTop: 4, fontSize: 12 }}>
                  <span style={{ color: "var(--c-green-2)" }}>已选择 {thailandFiles.length} 张照片（共 {formatBytes(totalUploadBytes(thailandFiles))}）</span>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                    {thailandFiles.map((f, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 4, background: "var(--s-sunken)", padding: "2px 8px", borderRadius: 4 }}>
                        <span style={{ maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.fileName}</span>
                        <button onClick={() => setThailandFiles(prev => prev.filter((_, j) => j !== i))} style={{ border: "none", background: "none", color: "var(--c-red)", cursor: "pointer", fontSize: 14, padding: 0, lineHeight: 1 }}>×</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
              {/* 2026-09-02 终审整改：压缩中也禁用，防止压缩中的照片被静默漏掉 */}
              <button onClick={handleThailandSign} disabled={thailandSubmitting || thailandCompressing || thailandFiles.length === 0} style={{ ...btnBlue, opacity: thailandFiles.length === 0 || thailandCompressing ? 0.5 : 1, cursor: thailandFiles.length === 0 || thailandCompressing ? "not-allowed" : "pointer" }}>
                {thailandSubmitting ? "提交中..." : thailandCompressing ? "照片处理中…" : "确认签收"}
              </button>
              <button onClick={() => { thailandPrealertIdRef.current = null; /* 2026-09-02 终审整改：关闭处同步清空 owner */ setThailandTarget(null); setThailandFiles([]); }} style={btnGray}>取消</button>
            </div>
          </Modal>
        )}

        {/* ================================================================ */}
        {/* 弹窗：新增参与客户（2026-08-07）                                   */}
        {/* ================================================================ */}
        {showAddCustomer && selectedPlanId && planDetail && (() => {
          // 已经在本计划里的客户不再出现在候选里，避免重复添加被后端打回
          const joined = new Set((planDetail.customers ?? []).map((c: any) => c.clientId));
          const q = addSearch.trim().toLowerCase();
          const options = clientOptions.filter(cl => !joined.has(cl.id))
            .filter(cl => !q || (cl.name ?? "").toLowerCase().includes(q));
          return (
            <Modal onClose={() => { setShowAddCustomer(false); setAddError(""); }}>
              <h3 style={{ marginTop: 0 }}>新增参与客户 - {planDetail.planNo}</h3>
              <div style={{ marginTop: 10 }}>
                <label style={fl}>选择客户</label>
                <input value={addSearch} onChange={e => setAddSearch(e.target.value)} placeholder="搜索客户名" style={fi} />
                <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--l-soft)", borderRadius: 6, marginTop: 6 }}>
                  {clientsLoading ? (
                    <div style={{ padding: "10px 12px", fontSize: 13, color: "var(--t-faint)" }}>加载客户列表中…</div>
                  ) : options.length === 0 ? (
                    <div style={{ padding: "10px 12px", fontSize: 13, color: "var(--t-faint)" }}>
                      没有可选客户{joined.size > 0 ? "（已在本计划里的客户不会重复出现）" : ""}
                    </div>
                  ) : options.map(cl => (
                    <label key={cl.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", cursor: "pointer", borderBottom: "1px solid var(--s-sunken)", fontSize: 13 }}>
                      <input type="radio" name="add-whr-client-staff" checked={addClientId === cl.id} onChange={() => setAddClientId(cl.id)} />
                      <span style={{ fontWeight: 600 }}>{cl.name}</span>
                      <span style={{ color: "var(--t-muted)", fontSize: 12 }}>{cl.id}</span>
                    </label>
                  ))}
                </div>
                <div style={{ fontSize: 12, color: "var(--t-muted)", marginTop: 4 }}>共 {options.length} 位可选</div>
              </div>
              {/* 2026-09-18 老板拍板：加客户时当场填这一柜的三档单价 */}
              <div style={{ marginTop: 12 }}>
                <label style={fl}>这一柜给他的单价（元/方，必填）</label>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  {([["普货", addPriceNormal, setAddPriceNormal], ["商检货", addPriceInspection, setAddPriceInspection], ["敏感货", addPriceSensitive, setAddPriceSensitive]] as Array<[string, string, (v: string) => void]>).map(([label, value, setter]) => (
                    <label key={label} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <span style={{ color: "var(--t-muted)", fontSize: 13 }}>{label}</span>
                      <input type="number" min="0" step="0.01" value={value} onChange={(e) => setter(e.target.value)} style={{ ...fi, width: 100, padding: "4px 8px" }} />
                    </label>
                  ))}
                </div>
              </div>
              {addError && (
                <div style={{ margin: "10px 0", padding: "10px 12px", background: "var(--c-red-bg)", color: "var(--c-red-deep)", borderRadius: 8, fontSize: 13, whiteSpace: "pre-wrap" }}>{addError}</div>
              )}
              <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
                <button onClick={handleAddCustomer} disabled={addSubmitting} style={btnBlue}>{addSubmitting ? "添加中..." : "确认新增"}</button>
                <button onClick={() => { setShowAddCustomer(false); setAddError(""); }} style={btnGray}>取消</button>
              </div>
            </Modal>
          );
        })()}

        {/* ================================================================ */}
        {/* 弹窗：图片预览 */}
        {/* ================================================================ */}
        {previewImage && (
          <div onClick={() => setPreviewImage(null)} style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <img src={previewImage} alt="预览" style={{ maxWidth: "90vw", maxHeight: "90vh", borderRadius: 8 }} />
          </div>
        )}
      </div>
    </>
  );
}

// ============================================================================
// Section 组件
// ============================================================================
function Section({ title, count, emptyMsg, children }: { title: string; count: number; emptyMsg: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <h4 style={{ fontSize: 15, margin: "0 0 10px", color: "var(--t-body)" }}>{title} ({count})</h4>
      {count === 0 ? <p style={{ fontSize: 14, color: "var(--t-faint)", padding: "12px 0" }}>{emptyMsg}</p> : children}
    </div>
  );
}

// ============================================================================
// Modal 组件
// ============================================================================
function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "var(--white)", borderRadius: 12, padding: 24, maxWidth: 520, width: "90vw", maxHeight: "85vh", overflowY: "auto", boxShadow: "0 8px 30px rgba(0,0,0,0.15)" }}>
        {children}
      </div>
    </div>
  );
}
