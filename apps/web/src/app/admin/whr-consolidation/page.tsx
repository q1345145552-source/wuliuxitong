"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { apiBaseUrl, apiRequest } from "../../../services/core-api";
import { formatBeijingTime } from "../../../modules/staff/utils";
import { createRequestGate } from "../../../modules/shared/request-gate";
import { parseUnitPrice, unitPriceIssue } from "../../../modules/shared/unit-price";

const jsonPost = { "Content-Type": "application/json" } as const;

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

/** 把接口返回的图片字段（可能是 /images 路径、data URL 或裸 base64）统一成可用的 src */
function toImageSrc(src: unknown, mime?: string): string {
  if (typeof src !== "string" || !src) return "";
  if (src.startsWith("data:") || src.startsWith("/") || src.startsWith("http")) return src;
  return `data:${mime || "image/png"};base64,${src}`;
}

interface StatusLogRow {
  id: string;
  operatorName: string;
  operatorRole: string;
  fromStatus: string;
  toStatus: string;
  remark: string | null;
  createdAt: string;
}

/** 客户级时间线由所有预报单的日志聚合而成（后端不再重复下发一份） */
function aggregateCustomerLogs(prealerts: { trackingNo: string; statusLogs?: StatusLogRow[] }[]) {
  return prealerts
    .flatMap((pa) => (pa.statusLogs ?? []).map((sl) => ({ ...sl, trackingNo: pa.trackingNo })))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 200);
}

// ============================================================================
// 状态中文映射 & 标签颜色
// ============================================================================
const PLAN_STATUS_ZH: Record<string, string> = {
  planning: "计划中",
  collecting: "集货中",
  loading: "装柜中",
  shipped: "已发运",
  completed: "已完成",
  cancelled: "已取消",
};
const PREALERT_STATUS_ZH: Record<string, string> = {
  pending: "待签收",
  received_pending_payment: "待付款",
  payment_submitted: "待审核",
  paid: "已付款",
  loading: "装柜中",
  shipped: "已发运",
  thailand_received: "泰国已签收",
  cancelled: "已取消",
};
const TAG: Record<string, { bg: string; color: string }> = {
  planning: { bg: "#EEF2FB", color: "#1e3a8a" },
  collecting: { bg: "var(--c-blue-bg-2)", color: "var(--c-blue-deep)" },
  loading: { bg: "#EEF2FB", color: "#1e3a8a" },
  shipped: { bg: "#EEF2FB", color: "#1e3a8a" },
  completed: { bg: "var(--c-green-bg)", color: "var(--c-green-deep)" },
  cancelled: { bg: "var(--c-red-bg)", color: "var(--c-red-dark)" },
  pending: { bg: "var(--c-amber-bg)", color: "var(--c-amber-deep)" },
  received_pending_payment: { bg: "var(--c-amber-bg)", color: "var(--c-amber-deep)" },
  payment_submitted: { bg: "var(--c-blue-bg-2)", color: "var(--c-blue-deep)" },
  paid: { bg: "var(--c-green-bg)", color: "var(--c-green-deep)" },
  thailand_received: { bg: "var(--c-green-bg)", color: "var(--c-green-deep)" },
};

// ============================================================================
// 类型定义
// ============================================================================
interface PlanItem {
  id: string;
  planNo: string;
  warehouse: string;
  containerType: string;
  destinationTh: string;
  totalVolumeM3: number;
  status: string;
  creatorName: string;
  customerCount: number;
  createdAt: string;
}

interface PrealertItem {
  id: string;
  trackingNo: string;
  expressNo: string | null;
  mark: string;
  status: string;
  receivedAt: string | null;
  signedAt?: string | null;
  warehouseReceiptBase64?: string | null;
  totalFee?: number | null;
  feeBreakdown?: FeeBreakdown | null;
  paymentProofs?: { fileName?: string; mime?: string; base64Path?: string; base64?: string; uploadedAt?: string }[];
  paymentProofUploadedAt?: string | null;
  paymentReviewedAt?: string | null;
  paymentRejectReason?: string | null;
  thailandReceiptBase64?: string | null;
  thailandReceivedAt?: string | null;
  createdAt: string;
  items: {
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
    productImageFileName: string | null;
    productImageBase64: string | null;
    sortOrder: number;
  }[];
  statusLogs?: {
    id: string;
    operatorName: string;
    operatorRole: string;
    fromStatus: string;
    toStatus: string;
    remark: string | null;
    createdAt: string;
  }[];
}

interface CustomerDetail {
  id: string;
  clientId: string;
  clientName: string;
  clientPhone: string;
  clientCompany: string;
  unitPriceNormal: number;
  unitPriceInspection: number;
  unitPriceSensitive: number;
  totalVolumeM3: number;
  totalFee: number | null;
  feeBreakdown?: FeeBreakdown | null;
  deliveryAddress: string | null;
  totalPrealerts: number;
  totalPackages: number;
  totalItems: number;
  prealerts: PrealertItem[];
}

interface PlanDetail {
  id: string;
  planNo: string;
  warehouse: string;
  containerType: string;
  destinationTh: string;
  totalVolumeM3: number;
  usedVolumeM3?: number;
  status: string;
  creatorName: string;
  createdAt: string;
  updatedAt: string;
  customers: CustomerDetail[];
}

interface ClientOption {
  id: string;
  name: string;
  phone: string;
  companyName: string | null;
  status?: string | null;
  /** 2026-09-16：/admin/users?role=client 只给超管，带所属代理和长期价（员工页那套接口没有） */
  agentName?: string | null;
  whrPrice?: { normal: number; inspection: number; sensitive: number } | null;
}

/**
 * 2026-09-18 老板拍板改回来：建柜时**每位客户当场填三档单价**（每个柜价格都不一样）。
 * 9-16 到 9-18 之间是「按客户长期价自动带出」，那套不用了（长期价的表和接口留着，只是没人读）。
 */
interface CreateCustomerForm {
  clientId: string;
  unitPriceNormal: string;
  unitPriceInspection: string;
  unitPriceSensitive: string;
}

const priceText = (p: { normal: number; inspection: number; sensitive: number }) =>
  `普货 ${p.normal} · 商检货 ${p.inspection} · 敏感货 ${p.sensitive} 元/方`;

// ============================================================================
// 共用样式
// ============================================================================
const thS: React.CSSProperties = { padding: "6px 10px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "var(--t-body)", borderBottom: "2px solid var(--l-soft)", whiteSpace: "nowrap" };
const tdS: React.CSSProperties = { padding: "7px 10px", fontSize: 13, borderBottom: "1px solid var(--s-sunken)", verticalAlign: "middle" };
const btnConfirm: React.CSSProperties = { padding: "8px 18px", background: "var(--c-blue)", color: "var(--white)", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600, fontSize: 13 };
const btnCancel: React.CSSProperties = { padding: "8px 18px", border: "1px solid var(--l-strong)", color: "var(--t-muted)", background: "var(--white)", borderRadius: 6, cursor: "pointer", fontSize: 13 };
const btnDanger: React.CSSProperties = { padding: "8px 18px", background: "var(--c-red)", color: "var(--white)", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600, fontSize: 13 };
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
export default function AdminWhrConsolidationPage() {
  // --- 列表 ---
  const [plans, setPlans] = useState<PlanItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState("");
  /**
   * 弹窗里的报错画在弹窗**里面**：Modal 是 inset:0 + zIndex 9999 的遮罩，页面顶部那条 toast 会被压在后面、
   * 5 秒后还自动消失，员工只看到「点了没反应」（两位复核 2026-09-18 都报了；返现单 9d6d160 已经这么修过）。
   * 同一时间只会开一个弹窗，所以三处共用这一个。
   */
  const [modalError, setModalError] = useState("");

  // --- 详情 ---
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [planDetail, setPlanDetail] = useState<PlanDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // 2026-09-01 竞态全扫：详情请求「领号验号 + 认主人」。
  // 进 A 计划详情、马上退出再进 B，A 的慢响应回来不许把 B 的详情盖掉。
  // ref 在点击处同步赋值（不等 React 提交），响应落地时核对主人用它。
  const selectedPlanIdRef = useRef<string | null>(null);
  const detailGate = useRef(createRequestGate()).current;
  const [expandedCustomer, setExpandedCustomer] = useState<string | null>(null);
  const [expandedPrealert, setExpandedPrealert] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  // --- 新建计划 ---
  const [showCreate, setShowCreate] = useState(false);
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [newWarehouse, setNewWarehouse] = useState("义乌");
  const [newContainerType, setNewContainerType] = useState("40HQ");
  const [newDestinationTh, setNewDestinationTh] = useState("");
  const [newTotalVolume, setNewTotalVolume] = useState("68");
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [clientSearch, setClientSearch] = useState("");
  const [selectedCustomers, setSelectedCustomers] = useState<CreateCustomerForm[]>([]);
  const [clientsLoading, setClientsLoading] = useState(false);

  // --- 审核（预报单级别） ---
  const [reviewTarget, setReviewTarget] = useState<{ planId: string; prealert: PrealertItem } | null>(null);
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  // --- 取消（预报单级别） ---
  const [cancelTarget, setCancelTarget] = useState<{ planId: string; prealert: PrealertItem } | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelSubmitting, setCancelSubmitting] = useState(false);

  // --- 改单件货物的货型 / 删单件货物（2026-08-15）---
  const [itemBusyId, setItemBusyId] = useState("");
  const [deleteItemTarget, setDeleteItemTarget] = useState<{ item: any; trackingNo: string } | null>(null);
  const [deleteItemSubmitting, setDeleteItemSubmitting] = useState(false);

  /**
   * --- 改单价（2026-09-18 老板拍板恢复：「每次柜价格都不一样的」）---
   * 9-16 到 9-18 之间这块停用过（那阵子改价走客户长期价）。现在回到老规矩：
   * 在柜详情里改这位客户的三档价，改完他**没付款**的单按新价重算（已付款的不动）。
   */
  const [priceTarget, setPriceTarget] = useState<CustomerDetail | null>(null);
  const [editPriceNormal, setEditPriceNormal] = useState("");
  const [editPriceInspection, setEditPriceInspection] = useState("");
  const [editPriceSensitive, setEditPriceSensitive] = useState("");
  const [priceSubmitting, setPriceSubmitting] = useState(false);
  // 加客户时当场填的三档价（2026-09-18）
  const [addPriceNormal, setAddPriceNormal] = useState("");
  const [addPriceInspection, setAddPriceInspection] = useState("");
  const [addPriceSensitive, setAddPriceSensitive] = useState("");
  // 撤销付款（2026-08-07）
  const [revokingId, setRevokingId] = useState("");
  // 新增 / 移除参与客户（2026-08-07）
  const [showAddCustomer, setShowAddCustomer] = useState(false);
  const [addClientId, setAddClientId] = useState("");
  const [addSearch, setAddSearch] = useState("");
  const [addSubmitting, setAddSubmitting] = useState(false);
  const [removingCustomerId, setRemovingCustomerId] = useState("");
  // 超管替客户填泰国收货地址（2026-09-16，确认单 3.12）
  const [addressTarget, setAddressTarget] = useState<CustomerDetail | null>(null);
  const [addressValue, setAddressValue] = useState("");
  const [addressSubmitting, setAddressSubmitting] = useState(false);

  // ==========================================================================
  // 数据加载
  // ==========================================================================
  const loadPlans = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiRequest<{ items: PlanItem[] }>(`${apiBaseUrl()}/admin/whr-consolidation/plans`);
      setPlans(data.items ?? []);
    } catch (e: any) {
      setToast(e?.message ?? "加载计划列表失败");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (planId: string) => {
    // 2026-09-01 竞态全扫：出发领号，落地验号 + 认主人（成功、失败、finally 三个分支都要验）
    const ticket = detailGate.begin();
    setDetailLoading(true);
    try {
      const data = await apiRequest<PlanDetail>(
        `${apiBaseUrl()}/admin/whr-consolidation/plans/detail?planId=${encodeURIComponent(planId)}`
      );
      // 号已作废，或用户已换/退出这个计划：旧详情不许落到新计划头上
      if (!detailGate.isCurrent(ticket) || selectedPlanIdRef.current !== planId) return;
      setPlanDetail(data);
    } catch (e: any) {
      // 失败分支同样验：旧请求的报错不许安到新界面头上
      if (!detailGate.isCurrent(ticket) || selectedPlanIdRef.current !== planId) return;
      setToast(e?.message ?? "加载详情失败");
    } finally {
      // 旧请求不许提前掐掉新请求的加载态；只要没有更新的请求在跑，加载态就该收掉
      if (detailGate.isCurrent(ticket)) setDetailLoading(false);
    }
  }, [detailGate]);

  // /admin/users 不支持 search / pageSize 参数（传了会被忽略），所以这里一次性拉回列表，
  // 过滤放到前端做，搜索框才是真的有用
  const loadClients = useCallback(async () => {
    setClientsLoading(true);
    try {
      const data = await apiRequest<{ items: ClientOption[] }>(`${apiBaseUrl()}/admin/users?role=client`);
      setClients(data.items ?? []);
    } catch (e: any) {
      setToast(e?.message ?? "加载客户列表失败");
    } finally {
      setClientsLoading(false);
    }
  }, []);

  useEffect(() => { loadPlans(); }, [loadPlans]);
  // ======== 删除整个集货计划（2026-08-07 新增）========
  // 级联链最长：计划 → 计划客户 → 预报单 → 货物明细 + 状态日志。
  // 所以点删除先向后端预检，把「会连带删掉什么」摆给人看；
  // 已付款/已发货的后端会拦住，要输管理员密码才放行。
  const [deletePlanId, setDeletePlanId] = useState<string | null>(null);
  // 2026-09-01 竞态全扫：预检结果里带上它是给哪个计划算的（planId），执行删除前必须核对
  // hardBlocked（2026-09-16，确认单 4.15）：已经发运的柜谁都不能删，输密码也不行 —— 这时不给密码框、不给确认按钮
  const [deletePlanPreview, setDeletePlanPreview] = useState<{ planId: string; willDelete: Record<string, number>; blockers: string[]; refundTotal?: number; refundCount?: number; hardBlocked?: boolean; hardBlockReason?: string | null } | null>(null);
  const [deletePlanPassword, setDeletePlanPassword] = useState("");
  const [deletePlanError, setDeletePlanError] = useState("");
  const [deletePlanSubmitting, setDeletePlanSubmitting] = useState(false);
  // 2026-09-01 竞态全扫：删除弹窗当前对着哪个计划（认主人用）。
  // 关 A 的删除弹窗再开 B，A 的慢预检回来不许把 B 的预检盖掉——否则界面上给人看的是 A 的清单，删的却是 B。
  const deletePlanIdRef = useRef<string | null>(null);
  useEffect(() => { deletePlanIdRef.current = deletePlanId; }, [deletePlanId]);

  const openDeletePlan = async (planId: string) => {
    setDeletePlanId(planId);
    deletePlanIdRef.current = planId; // 同步赋值，不等 React 提交
    setDeletePlanPreview(null);
    setDeletePlanPassword("");
    setDeletePlanError("");
    try {
      const r = await apiRequest<{ willDelete: Record<string, number>; blockers: string[]; refundTotal?: number; refundCount?: number; hardBlocked?: boolean; hardBlockReason?: string | null }>(
        `${apiBaseUrl()}/admin/whr-consolidation/plans/delete`,
        { method: "POST", headers: jsonPost, body: JSON.stringify({ planId, dryRun: true }) },
      );
      // 2026-09-01 竞态全扫·认主人：弹窗已关或已换成别的计划，旧预检不许落地
      if (deletePlanIdRef.current !== planId) return;
      setDeletePlanPreview({ planId, willDelete: r.willDelete, blockers: r.blockers, refundTotal: r.refundTotal, refundCount: r.refundCount, hardBlocked: r.hardBlocked, hardBlockReason: r.hardBlockReason });
    } catch (e: any) {
      // 失败分支同样认主人：旧请求的报错不许安到新弹窗头上
      if (deletePlanIdRef.current !== planId) return;
      setDeletePlanError(e?.message ?? "预检失败");
    }
  };

  const handleDeletePlan = async () => {
    if (!deletePlanId) return;
    // 2026-09-01 竞态全扫：确认按钮真正要删的 id 必须和预检展示的是同一个计划，对不上就拒绝执行
    if (!deletePlanPreview || deletePlanPreview.planId !== deletePlanId) {
      setDeletePlanError("预检信息和当前要删的计划对不上，请关掉这个窗口重新点删除");
      return;
    }
    setDeletePlanSubmitting(true);
    setDeletePlanError("");
    try {
      await apiRequest(`${apiBaseUrl()}/admin/whr-consolidation/plans/delete`, {
        method: "POST", headers: jsonPost,
        body: JSON.stringify({ planId: deletePlanId, ...(deletePlanPassword.trim() ? { confirmPassword: deletePlanPassword.trim() } : {}) }),
      });
      setToast("集货计划已删除");
      if (selectedPlanId === deletePlanId) { setSelectedPlanId(null); selectedPlanIdRef.current = null; }
      setDeletePlanId(null);
      setDeletePlanPassword("");
      await loadPlans();
    } catch (e: any) {
      setDeletePlanError(e?.message ?? "删除失败");
      // 失败也要刷新（2026-08-27 补）：后端现在会说「刚刚被别人改过，请刷新后再看」，
      // 页面不刷新的话用户看到的还是旧数字，容易照着旧数字再操作一次。
      await loadPlans();
    } finally { setDeletePlanSubmitting(false); }
  };

  // Toast 自动消失
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  // 客户搜索：本地按姓名/电话/公司过滤，已选中的始终保留在列表里
  const filteredClients = (() => {
    const q = clientSearch.trim().toLowerCase();
    if (!q) return clients;
    return clients.filter(
      (cl) =>
        selectedCustomers.some((sc) => sc.clientId === cl.id) ||
        (cl.name ?? "").toLowerCase().includes(q) ||
        (cl.phone ?? "").toLowerCase().includes(q) ||
        (cl.companyName ?? "").toLowerCase().includes(q),
    );
  })();

  // ==========================================================================
  // 操作函数
  // ==========================================================================
  const handleCreate = async () => {
    if (!newDestinationTh.trim()) { setModalError("请输入目的地"); return; }
    if (selectedCustomers.length === 0) { setModalError("请至少选择一位客户"); return; }
    /**
     * ⚠️ 总方数不许静默变成 68（2026-08-29 补）。
     * 这个框的初值就是 68、界面上看得见，正常情况没问题；
     * 但**手动清空**时下面那句 `Number(newTotalVolume) || 68` 会悄悄又变回 68，
     * 而柜总方数是「本柜已用方数不许超上限」那道闸的依据 —— 填错了闸就形同虚设。
     * 清空了就当场说清楚，别替他猜。
     */
    {
      const v = Number(String(newTotalVolume).trim());
      if (!String(newTotalVolume).trim() || !Number.isFinite(v) || v <= 0) {
        setModalError("请填写柜子总方数（这个数是「已用方数不许超上限」那道闸的依据，不能空着）");
        return;
      }
      // 库里是 Decimal(10,2)，多的小数位会被抹掉，跟你填的对不上
      if (Math.abs(v * 100 - Math.round(v * 100)) > 1e-6) {
        setModalError("柜子总方数最多只能有 2 位小数");
        return;
      }
    }
    // 三档单价当场填（2026-09-18）：页面先挡一次，说了算的是后端那道 requireUnitPrice
    for (let i = 0; i < selectedCustomers.length; i++) {
      const c = selectedCustomers[i];
      const name = clients.find((cl) => cl.id === c.clientId)?.name ?? `第 ${i + 1} 位客户`;
      const checks: Array<[string, string]> = [["普货", c.unitPriceNormal], ["商检货", c.unitPriceInspection], ["敏感货", c.unitPriceSensitive]];
      for (const [label, raw] of checks) {
        const issue = unitPriceIssue(label, raw);
        if (issue) { setModalError(`${name}的${issue}`); return; }
      }
    }
    setCreateSubmitting(true);
    try {
      await apiRequest<any>(
        `${apiBaseUrl()}/admin/whr-consolidation/plans`,
        {
          method: "POST",
          headers: jsonPost,
          body: JSON.stringify({
            warehouse: newWarehouse,
            containerType: newContainerType,
            destinationTh: newDestinationTh.trim(),
            // ⚠️ 不许 `|| 68`：上面已经卡死必须填，这里再兜一次等于把校验抹掉
            totalVolumeM3: Number(String(newTotalVolume).trim()),
            customers: selectedCustomers.map(c => ({
              clientId: c.clientId,
              unitPriceNormal: parseUnitPrice(c.unitPriceNormal),
              unitPriceInspection: parseUnitPrice(c.unitPriceInspection),
              unitPriceSensitive: parseUnitPrice(c.unitPriceSensitive),
            })),
          }),
        }
      );
      setToast("计划创建成功");
      setShowCreate(false);
      setNewDestinationTh("");
      setNewWarehouse("义乌");
      setNewContainerType("40HQ");
      setNewTotalVolume("68");
      setSelectedCustomers([]);
      loadPlans();
    } catch (e: any) { setModalError(e?.message ?? "创建失败"); }
    finally { setCreateSubmitting(false); }
  };

  const handleApprove = async () => {
    if (!reviewTarget) return;
    setReviewSubmitting(true);
    try {
      await apiRequest<any>(
        `${apiBaseUrl()}/admin/whr-consolidation/prealerts/review`,
        {
          method: "POST",
          headers: jsonPost,
          body: JSON.stringify({ planId: reviewTarget.planId, prealertId: reviewTarget.prealert.id, action: "approve" }),
        }
      );
      setToast("审核通过");
      setReviewTarget(null);
      if (selectedPlanId) loadDetail(selectedPlanId);
      loadPlans();
    } catch (e: any) {
      setToast(e?.message ?? "审核失败");
      // 失败也要刷新（2026-08-27 补）：后端现在会说「刚刚被别人改过，请刷新后再看」，
      // 页面不刷新的话用户看到的还是旧数字，容易照着旧数字再操作一次。
      if (selectedPlanId) loadDetail(selectedPlanId);
      loadPlans();
    }
    finally { setReviewSubmitting(false); }
  };

  const handleReject = async () => {
    if (!reviewTarget || !rejectReason.trim()) { setToast("请填写拒绝原因"); return; }
    setReviewSubmitting(true);
    try {
      const r = await apiRequest<{ totalFee?: number }>(
        `${apiBaseUrl()}/admin/whr-consolidation/prealerts/review`,
        {
          method: "POST",
          headers: jsonPost,
          body: JSON.stringify({
            planId: reviewTarget.planId,
            prealertId: reviewTarget.prealert.id,
            action: "reject",
            rejectReason: rejectReason.trim(),
          }),
        }
      );
      setToast(r?.totalFee != null ? `已拒绝，单子退回待付款，应付金额 ¥${r.totalFee}` : "已拒绝");
      setShowReject(false); setReviewTarget(null); setRejectReason("");
      if (selectedPlanId) loadDetail(selectedPlanId);
      loadPlans();
    } catch (e: any) {
      setToast(e?.message ?? "操作失败");
      // 失败也要刷新（2026-08-27 补）：后端现在会说「刚刚被别人改过，请刷新后再看」，
      // 页面不刷新的话用户看到的还是旧数字，容易照着旧数字再操作一次。
      if (selectedPlanId) loadDetail(selectedPlanId);
      loadPlans();
    }
    finally { setReviewSubmitting(false); }
  };

  const handleCancel = async () => {
    if (!cancelTarget || !cancelReason.trim()) { setToast("请填写取消原因"); return; }
    setCancelSubmitting(true);
    try {
      const r = await apiRequest<{ customerVolume?: number }>(
        `${apiBaseUrl()}/admin/whr-consolidation/prealerts/cancel`,
        {
          method: "POST",
          headers: jsonPost,
          body: JSON.stringify({ planId: cancelTarget.planId, prealertId: cancelTarget.prealert.id, cancelReason: cancelReason.trim() }),
        }
      );
      setToast(r?.customerVolume != null ? `已取消，该客户占用方数已更新为 ${r.customerVolume} 方` : "已取消");
      setCancelTarget(null); setCancelReason("");
      if (selectedPlanId) loadDetail(selectedPlanId);
      loadPlans();
    } catch (e: any) {
      setToast(e?.message ?? "取消失败");
      // 失败也要刷新（2026-08-27 补）：后端现在会说「刚刚被别人改过，请刷新后再看」，
      // 页面不刷新的话用户看到的还是旧数字，容易照着旧数字再操作一次。
      if (selectedPlanId) loadDetail(selectedPlanId);
      loadPlans();
    }
    finally { setCancelSubmitting(false); }
  };

  /** 只有「货还没到」和「已收货等付款」两档能改货型 / 删货，跟后端同一条界线 */
  const canEditItems = (status: string) => status === "pending" || status === "received_pending_payment";

  const handleChangeItemCargoType = async (itemId: string, cargoType: string) => {
    setItemBusyId(itemId);
    try {
      const r = await apiRequest<{ prealertStatus?: string; totalFee?: number }>(
        `${apiBaseUrl()}/admin/whr-consolidation/prealerts/item-cargo-type`,
        { method: "POST", headers: jsonPost, body: JSON.stringify({ itemId, cargoType }) }
      );
      // 没付款的单后端按新货型自动重算金额
      setToast(r?.prealertStatus === "received_pending_payment" && r.totalFee != null
        ? `货型已改，应付金额已按新货型自动重算为 ¥${r.totalFee}`
        : "货型已改（货还没签收，签收时按新货型计费）");
      if (selectedPlanId) loadDetail(selectedPlanId);
      loadPlans();
    } catch (e: any) { setToast(e?.message ?? "改货型失败"); }
    finally { setItemBusyId(""); }
  };

  const handleDeleteItem = async () => {
    if (!deleteItemTarget) return;
    setDeleteItemSubmitting(true);
    try {
      const r = await apiRequest<{ customerVolume?: number; prealertStatus?: string; totalFee?: number }>(
        `${apiBaseUrl()}/admin/whr-consolidation/prealerts/item-delete`,
        { method: "POST", headers: jsonPost, body: JSON.stringify({ itemId: deleteItemTarget.item.id }) }
      );
      // 没付款的单后端按剩下的货自动重算金额
      const volText = r?.customerVolume != null ? `，该客户占用方数更新为 ${r.customerVolume} 方` : "";
      const feeText = r?.prealertStatus === "received_pending_payment" && r.totalFee != null
        ? `，这张单应付金额已按剩下的货自动重算为 ¥${r.totalFee}`
        : "";
      setToast(`已删除${volText}${feeText}`);
      setDeleteItemTarget(null);
      if (selectedPlanId) loadDetail(selectedPlanId);
      loadPlans();
    } catch (e: any) {
      setToast(e?.message ?? "删除失败");
      // 失败也要刷新（2026-08-27 补）：后端现在会说「刚刚被别人改过，请刷新后再看」，
      // 页面不刷新的话用户看到的还是旧数字，容易照着旧数字再操作一次。
      if (selectedPlanId) loadDetail(selectedPlanId);
      loadPlans();
    }
    finally { setDeleteItemSubmitting(false); }
  };

  /**
   * 撤销一笔集货付款：钱退回客户的集货余额，预报单回到「待付款」，客户可以重付。
   * 退多少由后端按流水里实际扣过的钱算，前端不猜。
   */
  const handleRevokePayment = async (pa: any) => {
    if (!selectedPlanId) return;
    const reason = prompt(`撤销「${pa.trackingNo}」的付款？\n\n钱会退回客户的集货余额，单子回到「待付款」。\n请填写撤销原因（会记进流水和轨迹）：`);
    if (reason == null) return;
    setRevokingId(pa.id);
    try {
      const r = await apiRequest<any>(`${apiBaseUrl()}/admin/whr-consolidation/payments/revoke`, {
        method: "POST",
        headers: jsonPost,
        body: JSON.stringify({ prealertId: pa.id, reason: reason.trim() || undefined }),
      });
      setToast(r?.message ?? "已撤销并退款");
      loadDetail(selectedPlanId);
    } catch (e: any) {
      setToast(e?.message ?? "撤销失败");
      // 失败也要刷新（2026-08-27 补）：后端现在会说「刚刚被别人改过，请刷新后再看」，
      // 页面不刷新的话用户看到的还是旧数字，容易照着旧数字再操作一次。
      loadDetail(selectedPlanId);
    }
    finally { setRevokingId(""); }
  };

  /** 打开「新增客户」弹窗：客户列表是懒加载的，这里补一次 */
  const openAddCustomer = () => {
    setModalError("");
    setAddClientId(""); setAddSearch("");
    setShowAddCustomer(true);
    setAddPriceNormal("");
    setAddPriceInspection("");
    setAddPriceSensitive("");
    loadClients();
  };

  /** 改这位客户在本柜的单价：改完他没付款的单按新价重算（2026-09-18 恢复） */
  const handleUpdatePrice = async () => {
    if (!priceTarget || !selectedPlanId) return;
    const checks: Array<[string, string]> = [["普货", editPriceNormal], ["商检货", editPriceInspection], ["敏感货", editPriceSensitive]];
    let filled = 0;
    for (const [label, raw] of checks) {
      if (!String(raw).trim()) continue; // 留空 = 这一档不改
      const issue = unitPriceIssue(label, raw);
      if (issue) { setModalError(issue); return; }
      filled += 1;
    }
    if (filled === 0) { setModalError("至少改一种单价"); return; }
    setPriceSubmitting(true);
    try {
      /**
       * ⚠️ 只发**真的改过**的那几档：弹窗打开时三档都预填着，全发过去的话，
       * 我开着弹窗这段时间别人改了另外两档，我一保存就把人家的改动覆盖回去了（复核第 11 条）。
       */
      const changed = (input: string, current: number): number | undefined => {
        const text = String(input).trim();
        if (!text) return undefined;
        const value = parseUnitPrice(input);
        return Math.abs(value - Number(current)) < 1e-9 ? undefined : value;
      };
      const payload = {
        planId: selectedPlanId,
        customerId: priceTarget.id,
        unitPriceNormal: changed(editPriceNormal, priceTarget.unitPriceNormal),
        unitPriceInspection: changed(editPriceInspection, priceTarget.unitPriceInspection),
        unitPriceSensitive: changed(editPriceSensitive, priceTarget.unitPriceSensitive),
      };
      if (payload.unitPriceNormal === undefined && payload.unitPriceInspection === undefined && payload.unitPriceSensitive === undefined) {
        setModalError("三档价都跟原来一样，没什么要改的");
        setPriceSubmitting(false);
        return;
      }
      const r = await apiRequest<{ totalFee?: number }>(`${apiBaseUrl()}/admin/whr-consolidation/customers/price`, {
        method: "POST",
        headers: jsonPost,
        body: JSON.stringify(payload),
      });
      setToast(r?.totalFee != null ? `单价已改，没付款的单按新价重算了，这位客户现在合计 ¥${r.totalFee}` : "单价已改");
      setPriceTarget(null);
      loadDetail(selectedPlanId);
    } catch (e: any) { setModalError(e?.message ?? "改单价失败"); }
    finally { setPriceSubmitting(false); }
  };

  const handleAddCustomer = async () => {
    if (!selectedPlanId) return;
    if (!addClientId) { setModalError("请选择客户"); return; }
    // 三档单价当场填（2026-09-18 老板拍板）。页面先挡一次，说了算的是后端那道 requireUnitPrice
    const priceChecks: Array<[string, string]> = [["普货", addPriceNormal], ["商检货", addPriceInspection], ["敏感货", addPriceSensitive]];
    for (const [label, raw] of priceChecks) {
      const issue = unitPriceIssue(label, raw);
      if (issue) { setModalError(issue); return; }
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
        ? `客户已加入本计划，单价：${priceText({ normal: r.unitPriceNormal, inspection: r.unitPriceInspection ?? 0, sensitive: r.unitPriceSensitive ?? 0 })}`
        : "客户已加入本计划");
      setShowAddCustomer(false);
      loadDetail(selectedPlanId);
    } catch (e: any) { setModalError(e?.message ?? "新增失败"); }
    finally { setAddSubmitting(false); }
  };

  /** 移除客户。名下有预报单的后端会拦住，这里也先提示一次，免得白点 */
  const handleRemoveCustomer = async (c: CustomerDetail) => {
    if (!selectedPlanId) return;
    const paCount = c.prealerts?.length ?? 0;
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
      loadDetail(selectedPlanId);
    } catch (e: any) { setToast(e?.message ?? "移除失败"); }
    finally { setRemovingCustomerId(""); }
  };

  /** 这位客户在本柜有没有货已经发运 / 到泰国签收 —— 有的话地址不许再改（跟后端同一条线） */
  const customerHasShipped = (c: CustomerDetail) =>
    c.prealerts.some((pa) => pa.status === "shipped" || pa.status === "thailand_received");

  /** 超管替客户填泰国收货地址（2026-09-16，确认单 3.12：代理把地址给超管，超管来填） */
  const openAddress = (c: CustomerDetail) => {
    setAddressTarget(c);
    setAddressValue(c.deliveryAddress ?? "");
  };

  const handleSaveAddress = async () => {
    if (!addressTarget || !selectedPlanId) return;
    const v = addressValue.trim();
    if (!v) { setToast("请填写泰国收货地址"); return; }
    if (v.length > 500) { setToast("收货地址过长（最多 500 字）"); return; }
    setAddressSubmitting(true);
    try {
      await apiRequest(`${apiBaseUrl()}/admin/whr-consolidation/address`, {
        method: "POST",
        headers: jsonPost,
        body: JSON.stringify({ planId: selectedPlanId, customerId: addressTarget.id, deliveryAddress: v }),
      });
      setToast(`已保存 ${addressTarget.clientName} 的泰国收货地址`);
      setAddressTarget(null);
      loadDetail(selectedPlanId);
    } catch (e: any) {
      setToast(e?.message ?? "保存地址失败");
      // 失败也刷新：可能刚有货发运了，页面要跟着变
      loadDetail(selectedPlanId);
    }
    finally { setAddressSubmitting(false); }
  };

  // ==========================================================================
  // 渲染
  // ==========================================================================
  return (
    <>
      <div style={{ maxWidth: "100%", padding: "20px 24px" }}>
        {/* Toast */}
        {toast && (
          <div onClick={() => setToast("")} style={{ cursor: "pointer", marginBottom: 16, padding: "10px 16px", background: "var(--c-amber-bg)", color: "var(--c-amber-deep)", borderRadius: 8, fontSize: 14 }}>
            {toast}
          </div>
        )}

        {/* ================================================================ */}
        {/* 列表视图 */}
        {/* ================================================================ */}
        {!selectedPlanId && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 20 }}>集货拼柜（仓库版）</h2>
              <button onClick={() => { setModalError(""); setShowCreate(true); setClientSearch(""); loadClients(); }} style={btnConfirm}>+ 新建计划</button>
            </div>

            {loading ? (
              <p style={{ color: "var(--t-faint)", fontSize: 14 }}>加载中...</p>
            ) : plans.length === 0 ? (
              <p style={{ color: "var(--t-faint)", fontSize: 14 }}>暂无计划</p>
            ) : (
              <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "var(--s-alt)" }}>
                    <th style={thS}>计划编号</th>
                    <th style={thS}>仓库</th>
                    <th style={thS}>柜型</th>
                    <th style={thS}>目的地</th>
                    <th style={thS}>总方数</th>
                    <th style={thS}>客户数</th>
                    <th style={thS}>状态</th>
                    <th style={thS}>创建人</th>
                    <th style={thS}>创建时间</th>
                    <th style={thS}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {plans.map(p => (
                    <tr key={p.id} onClick={() => { /* 2026-09-01 竞态全扫：ref 和 state 同步改，详情响应回来按 ref 认主人 */ setSelectedPlanId(p.id); selectedPlanIdRef.current = p.id; loadDetail(p.id); }} style={{ cursor: "pointer", background: "white" }}
                      onMouseEnter={e => { e.currentTarget.style.background = "var(--s-alt)" }}
                      onMouseLeave={e => { e.currentTarget.style.background = "white" }}>
                      <td style={{ ...tdS, fontWeight: 600, minWidth: 120, whiteSpace: "nowrap" }}>{p.planNo}</td>
                      <td style={tdS}>{p.warehouse}</td>
                      <td style={tdS}>{p.containerType}</td>
                      <td style={tdS}>{p.destinationTh}</td>
                      <td style={tdS}>{p.totalVolumeM3} 方</td>
                      <td style={tdS}>{p.customerCount}</td>
                      <td style={tdS}>
                        <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 4, background: TAG[p.status]?.bg ?? "var(--l-soft)", color: TAG[p.status]?.color ?? "var(--t-body)" }}>
                          {PLAN_STATUS_ZH[p.status] ?? p.status}
                        </span>
                      </td>
                      <td style={tdS}>{p.creatorName}</td>
                      <td style={{ ...tdS, fontSize: 12 }}>{formatBeijingTime(p.createdAt)}</td>
                      <td style={tdS}>
                        <button
                          onClick={(e) => { e.stopPropagation(); void openDeletePlan(p.id); }}
                          style={{ padding: "3px 10px", border: "1px solid var(--c-red)", color: "var(--c-red)", background: "var(--white)", borderRadius: 4, cursor: "pointer", fontSize: 11 }}
                        >删除</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}

        {/* ================================================================ */}
        {/* 详情视图 */}
        {/* ================================================================ */}
        {selectedPlanId && (
          <>
            <button onClick={() => { setSelectedPlanId(null); selectedPlanIdRef.current = null; setPlanDetail(null); setExpandedCustomer(null); }} style={{ ...btnCancel, marginBottom: 16 }}>← 返回列表</button>

            {detailLoading ? (
              <p style={{ color: "var(--t-faint)", fontSize: 14 }}>加载中...</p>
            ) : !planDetail ? (
              <p style={{ color: "var(--c-red)", fontSize: 14 }}>加载计划详情失败</p>
            ) : (
              <>
                {/* 计划基本信息 */}
                <div style={{ border: "1px solid var(--l-soft)", borderRadius: 10, padding: "16px 20px", marginBottom: 16, background: "#F0F1F4" }}>
                  <h3 style={{ margin: "0 0 10px", fontSize: 17 }}>{planDetail.planNo}</h3>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "12px 24px", fontSize: 13, color: "var(--t-body)" }}>
                    <div><span style={{ color: "var(--t-muted)" }}>仓库：</span>{planDetail.warehouse}</div>
                    <div><span style={{ color: "var(--t-muted)" }}>柜型：</span>{planDetail.containerType}</div>
                    <div><span style={{ color: "var(--t-muted)" }}>目的地：</span>{planDetail.destinationTh}</div>
                    <div>
                      <span style={{ color: "var(--t-muted)" }}>方数：</span>
                      {planDetail.usedVolumeM3 != null
                        ? `已用 ${planDetail.usedVolumeM3} / ${planDetail.totalVolumeM3} 方`
                        : `${planDetail.totalVolumeM3} 方`}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ color: "var(--t-muted)" }}>状态：</span>
                      <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 4, background: TAG[planDetail.status]?.bg ?? "var(--l-soft)", color: TAG[planDetail.status]?.color ?? "var(--t-body)" }}>
                        {PLAN_STATUS_ZH[planDetail.status] ?? planDetail.status}
                      </span>
                    </div>
                    <div><span style={{ color: "var(--t-muted)" }}>创建人：</span>{planDetail.creatorName}</div>
                    <div><span style={{ color: "var(--t-muted)" }}>创建时间：</span>{formatBeijingTime(planDetail.createdAt)}</div>
                  </div>
                </div>

                {/* 客户卡片列表 */}
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                  <h3 style={{ fontSize: 16, margin: 0 }}>参与客户（{planDetail.customers.length}）</h3>
                  {/* 计划一旦开始装柜/发运就不给再加人，后端也拦了一道 */}
                  {["planning", "collecting"].includes(planDetail.status) && (
                    <button onClick={openAddCustomer} style={{ ...btnCancel, padding: "4px 12px", fontSize: 12 }}>新增客户</button>
                  )}
                </div>
                {planDetail.customers.map(c => {
                  const isExpanded = expandedCustomer === c.id;
                  return (
                    <div key={c.id} style={{ border: "1px solid var(--l-soft)", borderRadius: 10, marginBottom: 12, overflow: "hidden" }}>
                      {/* 客户卡片头 */}
                      <div onClick={() => setExpandedCustomer(isExpanded ? null : c.id)} style={{ cursor: "pointer", padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", background: isExpanded ? "var(--s-alt)" : "white" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                          <span style={{ fontWeight: 600, fontSize: 15 }}>{c.clientName}</span>
                          <span style={{ fontSize: 12, color: "var(--t-muted)" }}>{c.clientPhone} · {c.clientCompany}</span>
                          <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 4, background: "var(--s-sunken)", color: "var(--t-muted)" }}>参与客户</span>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                          <span style={{ fontSize: 13, color: "var(--t-muted)" }}>
                            {c.totalVolumeM3} 方 · {c.totalPrealerts} 个预报单
                            {c.totalFee != null ? ` · ${money(c.totalFee)}` : ""}
                          </span>
                          <span style={{ fontSize: 12, color: "var(--t-faint)" }}>{isExpanded ? "▲" : "▼"}</span>
                        </div>
                      </div>

                      {/* 客户卡片展开体 */}
                      {isExpanded && (
                        <div style={{ padding: "12px 16px", borderTop: "1px solid var(--l-soft)", background: "#F0F1F4" }}>
                          {/* 价格信息 */}
                          <div style={{ display: "flex", gap: 20, alignItems: "center", fontSize: 13, marginBottom: 10, color: "var(--t-body)" }}>
                            <span>普货：{c.unitPriceNormal} 元/方</span>
                            <span>商检货：{c.unitPriceInspection} 元/方</span>
                            <span>敏感货：{c.unitPriceSensitive} 元/方</span>
                            {/* 2026-09-18 老板拍板恢复：柜里能改单价（每个柜价格都不一样）。
                                只有还在「计划中 / 收货中 / 装柜中」的柜能改：已发运 / 已完成的柜里单子都付过款了，
                                改价不会改金额，只会让详情显示「付款后柜里单价改过」，看着像账错了（复核第 8 条） */}
                            {["planning", "collecting", "loading"].includes(planDetail.status) && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setModalError("");
                                  setPriceTarget(c);
                                  // 老柜里可能存着 0.00（8-29 之前 0.001 能过），预填成 "0" 会被「要大于 0」拦死 → 当没填
                                  const prefill = (v: number) => (Number(v) > 0 ? String(v) : "");
                                  setEditPriceNormal(prefill(c.unitPriceNormal));
                                  setEditPriceInspection(prefill(c.unitPriceInspection));
                                  setEditPriceSensitive(prefill(c.unitPriceSensitive));
                                }}
                                style={{ ...btnCancel, padding: "4px 12px", fontSize: 12 }}
                              >改单价</button>
                            )}
                            {planDetail.status !== "cancelled" && !customerHasShipped(c) && (
                              <button onClick={(e) => { e.stopPropagation(); openAddress(c); }} style={{ ...btnCancel, padding: "4px 12px", fontSize: 12 }}>
                                {c.deliveryAddress?.trim() ? "改泰国地址" : "填泰国地址"}
                              </button>
                            )}
                            {/* 已装柜/已发运的计划不给动参与名单，和「新增客户」同一条口径 */}
                            {["planning", "collecting"].includes(planDetail.status) && (
                              <button onClick={(e) => { e.stopPropagation(); handleRemoveCustomer(c); }} disabled={removingCustomerId === c.id} style={{ ...btnCancel, padding: "4px 12px", fontSize: 12, color: "var(--c-red-deep)", borderColor: "#fecaca" }}>{removingCustomerId === c.id ? "移除中..." : "移除客户"}</button>
                            )}
                          </div>

                          {/* 总费用及其算式 */}
                          {c.feeBreakdown && c.feeBreakdown.rows.length > 0 && (
                            <div style={{ marginBottom: 10, maxWidth: 460 }}>
                              <FeeBreakdownPanel bd={c.feeBreakdown} title="总费用明细（全部未取消预报单合计）" />
                            </div>
                          )}

                          {/* 收货地址（客户端必填） */}
                          <div style={{ fontSize: 13, marginBottom: 10 }}>
                            {c.deliveryAddress?.trim() ? (
                              <span style={{ color: "var(--t-muted)" }}>收货地址：{c.deliveryAddress}</span>
                            ) : (
                              <span style={{ color: "var(--c-red-deep)", background: "var(--c-red-bg)", padding: "3px 8px", borderRadius: 4 }}>
                                收货地址未填写 —— 客户没填地址付不了款、建不了预报单，可以点上面「填泰国地址」替他填
                              </span>
                            )}
                          </div>

                          {/* 预报单列表 */}
                          {c.prealerts.length > 0 && (
                            <div style={{ marginBottom: 10 }}>
                              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--t-body)", marginBottom: 6 }}>预报单（{c.prealerts.length}）</div>
                              {c.prealerts.map(pa => {
                                const paPkg = pa.items.reduce((s: number, it: any) => s + it.packageCount, 0);
                                const paVol = pa.items.reduce((s: number, it: any) => s + (it.volumeM3 ?? 0), 0);
                                const paIsExpanded = expandedPrealert === pa.id;
                                // 预报单的流程状态：pa.status 是预报单级别的（pending, received_pending_payment, etc.）
                                const paStatus = pa.status;
                                const canReview = paStatus === "payment_submitted";
                                // 2026-08-07：客户改成用集货余额付款、当场扣钱不可撤销，
                                // 这里是唯一的后手：退钱 + 单子回到待付款
                                const canRevoke = paStatus === "paid";
                                const canCancel = !["loading", "shipped", "thailand_received", "cancelled"].includes(paStatus);

                                return (
                                  <div key={pa.id} style={{ marginBottom: 8, border: "1px solid var(--l-soft)", borderRadius: 6, overflow: "hidden" }}>
                                    {/* 预报单卡片头 */}
                                    <div onClick={() => setExpandedPrealert(paIsExpanded ? null : pa.id)} style={{ padding: "8px 12px", background: paIsExpanded ? "var(--c-blue-bg)" : "var(--s-alt)", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, cursor: "pointer" }}>
                                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                        <strong>{pa.trackingNo}</strong>
                                        <span style={{ color: "var(--t-muted)" }}>唛头：{pa.mark || "-"}</span>
                                        {pa.expressNo && <span style={{ color: "var(--t-muted)" }}>快递：{pa.expressNo}</span>}
                                        <span style={{ fontSize: 11, padding: "2px 6px", borderRadius: 3, background: TAG[paStatus]?.bg ?? "var(--l-soft)", color: TAG[paStatus]?.color ?? "var(--t-body)" }}>
                                          {PREALERT_STATUS_ZH[paStatus] ?? paStatus}
                                        </span>
                                      </div>
                                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                        {pa.totalFee != null && <span style={{ fontWeight: 600, color: "var(--c-green)" }}>{money(pa.totalFee)}</span>}
                                        <span style={{ color: "var(--t-muted)" }}>{paPkg}件 · {paVol.toFixed(3)}方</span>
                                        <span style={{ fontSize: 12, color: "var(--t-faint)" }}>{paIsExpanded ? "▲" : "▼"}</span>
                                      </div>
                                    </div>

                                    {/* 预报单卡片展开体 */}
                                    {paIsExpanded && (
                                      <div style={{ padding: "8px 12px", borderTop: "1px solid var(--l-soft)", background: "var(--white)", fontSize: 12 }}>
                                        {/* 本单费用明细 */}
                                        {pa.feeBreakdown && pa.feeBreakdown.rows.length > 0 && (
                                          <div style={{ marginBottom: 8, maxWidth: 420 }}>
                                            <FeeBreakdownPanel bd={pa.feeBreakdown} title="本单费用明细" compact />
                                          </div>
                                        )}

                                        {/* 收货凭证 */}
                                        {pa.warehouseReceiptBase64 && (
                                          <div style={{ marginBottom: 8 }}>
                                            <div style={{ color: "var(--t-muted)", marginBottom: 4 }}>收货凭证</div>
                                            <img src={pa.warehouseReceiptBase64} alt="收货凭证" onClick={() => setPreviewImage(pa.warehouseReceiptBase64!)} style={{ maxWidth: "100%", maxHeight: 180, borderRadius: 6, border: "1px solid var(--l-soft)", cursor: "pointer" }} />
                                          </div>
                                        )}

                                        {/* 付款截图 */}
                                        {pa.paymentProofs && pa.paymentProofs.length > 0 && (
                                          <div style={{ marginBottom: 8 }}>
                                            <div style={{ color: "var(--t-muted)", marginBottom: 4 }}>付款凭证（{pa.paymentProofs.length}张）</div>
                                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                              {pa.paymentProofs.map((p: any, i: number) => {
                                                const imgSrc = toImageSrc(p.base64Path || p.base64, p.mime);
                                                return imgSrc ? <img key={i} src={imgSrc} alt={`付款凭证 ${i + 1}`} onClick={() => setPreviewImage(imgSrc)} style={{ width: 80, height: 80, objectFit: "cover", borderRadius: 4, border: "1px solid var(--l-soft)", cursor: "pointer" }} /> : null;
                                              })}
                                            </div>
                                          </div>
                                        )}

                                        {/* 拒绝原因 */}
                                        {pa.paymentRejectReason && (
                                          <div style={{ marginBottom: 8, padding: "6px 10px", background: "#fef2f2", borderRadius: 4, color: "var(--c-red)" }}>
                                            拒绝原因：{pa.paymentRejectReason}
                                          </div>
                                        )}

                                        {/* 泰国签收单 */}
                                        {pa.thailandReceiptBase64 && (
                                          <div style={{ marginBottom: 8 }}>
                                            <div style={{ color: "var(--t-muted)", marginBottom: 4 }}>泰国签收单</div>
                                            <img src={pa.thailandReceiptBase64} alt="泰国签收单" onClick={() => setPreviewImage(pa.thailandReceiptBase64!)} style={{ maxWidth: "100%", maxHeight: 180, borderRadius: 6, border: "1px solid var(--l-soft)", cursor: "pointer" }} />
                                            {pa.thailandReceivedAt && <div style={{ color: "var(--t-muted)", marginTop: 4 }}>签收时间：{formatBeijingTime(pa.thailandReceivedAt)}</div>}
                                          </div>
                                        )}

                                        {/* 操作按钮 */}
                                        <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                                          {canReview && (
                                            <button onClick={(e) => { e.stopPropagation(); setReviewTarget({ planId: selectedPlanId!, prealert: pa }); }} style={btnConfirm}>审核付款</button>
                                          )}
                                          {canRevoke && (
                                            <button onClick={(e) => { e.stopPropagation(); handleRevokePayment(pa); }} disabled={revokingId === pa.id} style={{ ...btnCancel, color: "var(--c-red-deep)", borderColor: "#fecaca" }}>
                                              {revokingId === pa.id ? "退款中..." : "撤销付款并退款"}
                                            </button>
                                          )}
                                          {canCancel && (
                                            <button onClick={(e) => { e.stopPropagation(); setCancelTarget({ planId: selectedPlanId!, prealert: pa }); }} style={btnCancel}>取消预报单</button>
                                          )}
                                        </div>

                                        {/* 预报单状态日志 */}
                                        {pa.statusLogs && pa.statusLogs.length > 0 && (
                                          <div style={{ marginBottom: 8 }}>
                                            <div style={{ fontWeight: 600, color: "var(--t-body)", marginBottom: 4 }}>状态日志</div>
                                            {pa.statusLogs.map((sl: any) => (
                                              <div key={sl.id} style={{ padding: "2px 0", color: "var(--t-muted)", fontSize: 11 }}>
                                                <span style={{ color: "var(--t-body)" }}>{PREALERT_STATUS_ZH[sl.fromStatus] ?? sl.fromStatus}</span> → <span style={{ color: "var(--t-body)" }}>{PREALERT_STATUS_ZH[sl.toStatus] ?? sl.toStatus}</span>
                                                &nbsp;· {sl.operatorName} · {formatBeijingTime(sl.createdAt)}
                                                {sl.remark && <span style={{ color: "var(--t-faint)", marginLeft: 8 }}>{sl.remark}</span>}
                                              </div>
                                            ))}
                                          </div>
                                        )}

                                        {/* 货品表格 */}
                                        {pa.items.length > 0 && (
                                          <div style={{ overflowX: "auto" }}>
                                            <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                                              <thead><tr style={{ background: "var(--s-sunken)" }}>
                                                <th style={{ ...thS, padding: "3px 5px", fontSize: 11 }}>品名</th>
                                                <th style={{ ...thS, padding: "3px 5px", fontSize: 11 }}>件数</th>
                                                <th style={{ ...thS, padding: "3px 5px", fontSize: 11 }}>方数</th>
                                                <th style={{ ...thS, padding: "3px 5px", fontSize: 11 }}>类型</th>
                                                <th style={{ ...thS, padding: "3px 5px", fontSize: 11 }}>材质</th>
                                                <th style={{ ...thS, padding: "3px 5px", fontSize: 11 }}>货值</th>
                                                <th style={{ ...thS, padding: "3px 5px", fontSize: 11 }}>图片</th>
                                                <th style={{ ...thS, padding: "3px 5px", fontSize: 11 }}>操作</th>
                                              </tr></thead>
                                              <tbody>
                                                {pa.items.map((it: any) => (
                                                  <tr key={it.id}>
                                                    <td style={{ ...tdS, padding: "3px 5px", fontSize: 11 }}>{it.productName}</td>
                                                    <td style={{ ...tdS, padding: "3px 5px", fontSize: 11 }}>{it.packageCount}</td>
                                                    <td style={{ ...tdS, padding: "3px 5px", fontSize: 11 }}>{it.volumeM3 != null ? it.volumeM3.toFixed(3) : "-"}</td>
                                                    <td style={{ ...tdS, padding: "3px 5px", fontSize: 11 }}>
                                                      {canEditItems(pa.status) ? (
                                                        <select
                                                          value={it.cargoType || "normal"}
                                                          disabled={itemBusyId === it.id}
                                                          onClick={(e) => e.stopPropagation()}
                                                          onChange={(e) => { e.stopPropagation(); handleChangeItemCargoType(it.id, e.target.value); }}
                                                          style={{ fontSize: 11, padding: "1px 2px" }}
                                                        >
                                                          <option value="normal">普货</option>
                                                          <option value="inspection">商检货</option>
                                                          <option value="sensitive">敏感货</option>
                                                        </select>
                                                      ) : (
                                                        it.cargoType === "inspection" ? "商检货" : it.cargoType === "sensitive" ? "敏感货" : "普货"
                                                      )}
                                                    </td>
                                                    <td style={{ ...tdS, padding: "3px 5px", fontSize: 11 }}>{it.material}</td>
                                                    <td style={{ ...tdS, padding: "3px 5px", fontSize: 11 }}>{it.cargoValue}</td>
                                                    <td style={{ ...tdS, padding: "3px 5px", fontSize: 11 }}>
                                                      {it.productImageBase64 ? (
                                                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                                          <img src={it.productImageBase64} alt="产品图片" style={{ width: 36, height: 36, objectFit: "cover", borderRadius: 4, border: "1px solid var(--l-soft)", cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); setPreviewImage(it.productImageBase64); }} />
                                                          <button onClick={(e) => { e.stopPropagation(); setPreviewImage(it.productImageBase64); }} style={{ ...btnCancel, padding: "2px 6px", fontSize: 10 }}>查看</button>
                                                        </div>
                                                      ) : <span style={{ color: "var(--l-strong)" }}>暂无图片</span>}
                                                    </td>
                                                    <td style={{ ...tdS, padding: "3px 5px", fontSize: 11 }}>
                                                      {canEditItems(pa.status) && pa.items.length > 1 ? (
                                                        <button
                                                          onClick={(e) => { e.stopPropagation(); setDeleteItemTarget({ item: it, trackingNo: pa.trackingNo }); }}
                                                          style={{ ...btnCancel, padding: "2px 6px", fontSize: 10, color: "var(--c-red)" }}
                                                        >删除</button>
                                                      ) : <span style={{ color: "var(--l-strong)" }}>-</span>}
                                                    </td>
                                                  </tr>
                                                ))}
                                              </tbody>
                                            </table>
                                          </div>
                                        )}
                                        {pa.items.length === 0 && <div style={{ color: "var(--t-faint)", padding: "4px 0" }}>暂无货品</div>}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}

                          {/* 客户状态时间线（由该客户所有预报单的日志聚合而来） */}
                          {(() => {
                            const logs = aggregateCustomerLogs(c.prealerts);
                            if (logs.length === 0) return null;
                            return (
                              <div>
                                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--t-body)", marginBottom: 6 }}>状态时间线</div>
                                {logs.map((sl) => (
                                  <div key={sl.id} style={{ fontSize: 12, color: "var(--t-muted)", marginBottom: 6, paddingLeft: 10, borderLeft: "2px solid var(--l-soft)" }}>
                                    <strong style={{ color: "var(--c-blue)", marginRight: 6 }}>{sl.trackingNo}</strong>
                                    <strong style={{ color: "var(--t-body)" }}>{PREALERT_STATUS_ZH[sl.fromStatus] ?? sl.fromStatus}</strong> → <strong style={{ color: "var(--t-body)" }}>{PREALERT_STATUS_ZH[sl.toStatus] ?? sl.toStatus}</strong>
                                    &nbsp;· {sl.operatorName} · {formatBeijingTime(sl.createdAt)}
                                    {sl.remark && <div style={{ color: "var(--t-faint)", marginTop: 2 }}>{sl.remark}</div>}
                                  </div>
                                ))}
                              </div>
                            );
                          })()}
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </>
        )}

        {/* ================================================================ */}
        {/* 弹窗：审核付款（预报单级别） */}
        {/* ================================================================ */}
        {reviewTarget && (
          <Modal wide onClose={() => { setReviewTarget(null); setShowReject(false); }}>
            {showReject ? (
              <>
                <h3 style={{ marginTop: 0 }}>审核不通过</h3>
                <p style={{ fontSize: 13, color: "var(--t-muted)" }}>预报单：{reviewTarget.prealert.trackingNo} · {reviewTarget.prealert.mark}</p>
                <div style={{ marginTop: 10 }}>
                  <label style={fl}>拒绝原因 *</label>
                  <textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)} placeholder="请填写拒绝原因" style={{ ...fi, minHeight: 80 }} />
                </div>
                {/* 拒绝时不顺带改单价：要改价在柜详情点「改单价」（2026-09-18 起那个入口回来了） */}
                <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
                  <button onClick={handleReject} disabled={reviewSubmitting} style={btnConfirm}>{reviewSubmitting ? "提交中..." : "确认拒绝"}</button>
                  <button onClick={() => { setShowReject(false); setRejectReason(""); }} style={btnCancel}>取消</button>
                </div>
              </>
            ) : (
              <>
                <h3 style={{ marginTop: 0 }}>审核付款</h3>
                <div style={{ fontSize: 13 }}>
                  <p style={{ margin: "4px 0" }}>预报单：{reviewTarget.prealert.trackingNo} · 唛头：{reviewTarget.prealert.mark || "-"}</p>
                  {/* 货品明细 */}
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
                  {/* 费用及其算式 */}
                  {reviewTarget.prealert.totalFee != null && (
                    <p style={{ margin: "8px 0 6px", fontSize: 16, fontWeight: 700, color: "var(--c-green)" }}>应付金额：{money(reviewTarget.prealert.totalFee)}</p>
                  )}
                  <FeeBreakdownPanel bd={reviewTarget.prealert.feeBreakdown} title="费用是这样算出来的" />
                  {/* 付款截图 */}
                  {(() => {
                    const proofs = reviewTarget.prealert.paymentProofs;
                    if (!proofs || proofs.length === 0) return null;
                    return (
                      <div style={{ marginTop: 8 }}>
                        <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 12 }}>付款截图（{proofs.length}张）</div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {proofs.map((p: any, i: number) => {
                            const imgSrc = toImageSrc(p.base64Path || p.base64, p.mime);
                            return imgSrc ? <img key={i} src={imgSrc} alt={`付款截图 ${i + 1}`} onClick={() => setPreviewImage(imgSrc)} style={{ width: 100, height: 100, objectFit: "cover", borderRadius: 6, border: "1px solid var(--l-soft)", cursor: "pointer" }} /> : null;
                          })}
                        </div>
                      </div>
                    );
                  })()}
                </div>
                <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
                  <button onClick={handleApprove} disabled={reviewSubmitting} style={btnConfirm}>{reviewSubmitting ? "..." : "审核通过"}</button>
                  <button onClick={() => { setShowReject(true); setRejectReason(""); }} style={btnCancel}>审核不通过</button>
                </div>
              </>
            )}
          </Modal>
        )}

        {/* ================================================================ */}
        {/* 弹窗：取消资格（预报单级别） */}
        {/* ================================================================ */}
        {cancelTarget && (
          <Modal onClose={() => { setCancelTarget(null); setCancelReason(""); }}>
            <h3 style={{ marginTop: 0 }}>取消预报单</h3>
            <p style={{ fontSize: 13, color: "var(--t-muted)", marginBottom: 6 }}>预报单：{cancelTarget.prealert.trackingNo} · {cancelTarget.prealert.mark}</p>
            <p style={{ fontSize: 14, color: "var(--t-muted)", marginBottom: 10 }}>此操作不可恢复，将取消该预报单并释放已占用方数。</p>
            <div>
              <label style={fl}>取消原因 *</label>
              <textarea value={cancelReason} onChange={e => setCancelReason(e.target.value)} placeholder="请填写取消原因" style={{ ...fi, minHeight: 80 }} />
            </div>
            <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
              <button onClick={handleCancel} disabled={cancelSubmitting} style={btnDanger}>{cancelSubmitting ? "提交中..." : "确认取消"}</button>
              <button onClick={() => { setCancelTarget(null); setCancelReason(""); }} style={btnCancel}>返回</button>
            </div>
          </Modal>
        )}

        {/* ================================================================ */}
        {/* 弹窗：删除单件货物（2026-08-15） */}
        {/* ================================================================ */}
        {deleteItemTarget && (
          <Modal onClose={() => setDeleteItemTarget(null)}>
            <h3 style={{ marginTop: 0 }}>删除这件货物</h3>
            <p style={{ fontSize: 13, color: "var(--t-muted)", marginBottom: 6 }}>
              预报单：{deleteItemTarget.trackingNo}
            </p>
            <p style={{ fontSize: 14, marginBottom: 10 }}>
              要删除：<b>{deleteItemTarget.item.productName}</b>
              （{deleteItemTarget.item.packageCount} 件
              {deleteItemTarget.item.volumeM3 != null ? ` · ${Number(deleteItemTarget.item.volumeM3).toFixed(3)} 方` : ""}）
            </p>
            <div style={{ fontSize: 13, color: "var(--t-muted)", lineHeight: 1.8, marginBottom: 12 }}>
              删除之后会发生：
              <div>· 这件货从预报单里消失，<b>删了不能恢复</b></div>
              <div>· 该客户的总方数、总件数跟着变小</div>
              <div>· 客户还没付款的，<b style={{ color: "var(--c-red)" }}>这张单的应付金额按剩下的货自动重算</b>（已付款的单删不了货）</div>
              <div>· 客户在自己的流转记录里<b>会看到这条删除记录</b></div>
            </div>
            <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
              <button onClick={handleDeleteItem} disabled={deleteItemSubmitting} style={btnDanger}>{deleteItemSubmitting ? "删除中..." : "确认删除"}</button>
              <button onClick={() => setDeleteItemTarget(null)} style={btnCancel}>返回</button>
            </div>
          </Modal>
        )}

        {/* ================================================================ */}
        {/* 弹窗：替客户填泰国收货地址（2026-09-16，确认单 3.12）              */}
        {/* ================================================================ */}
        {addressTarget && selectedPlanId && (
          <Modal onClose={() => setAddressTarget(null)}>
            <h3 style={{ marginTop: 0 }}>{addressTarget.deliveryAddress?.trim() ? "改" : "填"}泰国收货地址 - {addressTarget.clientName}</h3>
            <p style={{ fontSize: 13, color: "var(--t-muted)", margin: "0 0 8px", lineHeight: 1.7 }}>
              替客户填这个柜的泰国收货地址，跟客户自己在「集货拼柜（仓库版）」里填的是同一个，客户那边马上能看到。
              这位客户在本柜有货发运之后就不能再改。
            </p>
            <textarea value={addressValue} onChange={e => setAddressValue(e.target.value)} maxLength={500} placeholder="收件人、电话、详细地址" style={{ ...fi, minHeight: 90 }} />
            <div style={{ fontSize: 12, color: "var(--t-faint)", textAlign: "right" }}>{addressValue.trim().length} / 500</div>
            <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
              <button onClick={handleSaveAddress} disabled={addressSubmitting} style={btnConfirm}>{addressSubmitting ? "保存中..." : "保存"}</button>
              <button onClick={() => setAddressTarget(null)} style={btnCancel}>取消</button>
            </div>
          </Modal>
        )}

        {/* ================================================================ */}
        {/* 弹窗：改单价（2026-09-18 恢复）                                    */}
        {/* ================================================================ */}
        {priceTarget && selectedPlanId && (
          <Modal onClose={() => { setPriceTarget(null); setModalError(""); }}>
            <h3 style={{ marginTop: 0 }}>改单价 - {priceTarget.clientName}</h3>
            <div style={{ fontSize: 13, color: "var(--t-muted)", marginBottom: 10 }}>
              只改这一柜给他的价。改完他<b>没付款</b>的单会按新价重算；已经付过款的单金额不动。留空的那一档不改。
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 10 }}>
              <div>
                <label style={fl}>普货单价 (元/方)</label>
                <input type="number" min="0" step="0.01" value={editPriceNormal} onChange={e => setEditPriceNormal(e.target.value)} style={fi} />
              </div>
              <div>
                <label style={fl}>商检货单价 (元/方)</label>
                <input type="number" min="0" step="0.01" value={editPriceInspection} onChange={e => setEditPriceInspection(e.target.value)} style={fi} />
              </div>
              <div>
                <label style={fl}>敏感货单价 (元/方)</label>
                <input type="number" min="0" step="0.01" value={editPriceSensitive} onChange={e => setEditPriceSensitive(e.target.value)} style={fi} />
              </div>
            </div>
            {modalError && (
              <div style={{ margin: "10px 0", padding: "10px 12px", background: "var(--c-red-bg)", color: "var(--c-red-deep)", borderRadius: 8, fontSize: 13, whiteSpace: "pre-wrap" }}>{modalError}</div>
            )}
            <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
              <button onClick={handleUpdatePrice} disabled={priceSubmitting} style={btnConfirm}>{priceSubmitting ? "保存中..." : "保存"}</button>
              <button onClick={() => { setPriceTarget(null); setModalError(""); }} style={btnCancel}>取消</button>
            </div>
          </Modal>
        )}

        {/* ================================================================ */}
        {/* 弹窗：新增参与客户（2026-08-07）                                   */}
        {/* ================================================================ */}
        {showAddCustomer && selectedPlanId && planDetail && (() => {
          // 已经在本计划里的客户不再出现在候选里，避免重复添加被后端打回
          const joined = new Set(planDetail.customers.map(c => c.clientId));
          const q = addSearch.trim().toLowerCase();
          const options = clients.filter(cl => !joined.has(cl.id)).filter(cl =>
            !q || (cl.name ?? "").toLowerCase().includes(q)
              || (cl.phone ?? "").toLowerCase().includes(q)
              || (cl.companyName ?? "").toLowerCase().includes(q));
          return (
            <Modal onClose={() => { setShowAddCustomer(false); setModalError(""); }}>
              <h3 style={{ marginTop: 0 }}>新增参与客户 - {planDetail.planNo}</h3>
              <div style={{ marginTop: 10 }}>
                <label style={fl}>选择客户</label>
                <input value={addSearch} onChange={e => setAddSearch(e.target.value)} placeholder="搜索客户名 / 电话 / 公司" style={fi} />
                <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--l-soft)", borderRadius: 6, marginTop: 6 }}>
                  {clientsLoading ? (
                    <div style={{ padding: "10px 12px", fontSize: 13, color: "var(--t-faint)" }}>加载客户列表中…</div>
                  ) : options.length === 0 ? (
                    <div style={{ padding: "10px 12px", fontSize: 13, color: "var(--t-faint)" }}>
                      没有可选客户{joined.size > 0 ? "（已在本计划里的客户不会重复出现）" : ""}
                    </div>
                  ) : options.map(cl => (
                    <label key={cl.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", cursor: "pointer", borderBottom: "1px solid var(--s-sunken)", fontSize: 13 }}>
                      <input type="radio" name="add-whr-client" checked={addClientId === cl.id} onChange={() => setAddClientId(cl.id)} />
                      <span style={{ fontWeight: 600 }}>{cl.name}</span>
                      <span style={{ color: "var(--t-muted)", fontSize: 12 }}>{cl.phone}{cl.companyName ? ` · ${cl.companyName}` : ""}</span>
                      {/* 超管页可以标代理名（员工页不标，确认单 4.6） */}
                      {cl.agentName && <span style={{ fontSize: 11, padding: "1px 6px", borderRadius: 4, background: "var(--c-blue-bg-2)", color: "var(--c-blue-deep)" }}>代理：{cl.agentName}</span>}
                    </label>
                  ))}
                </div>
                <div style={{ fontSize: 12, color: "var(--t-muted)", marginTop: 4 }}>共 {options.length} 位可选</div>
              </div>
              {/* 2026-09-18 老板拍板：加客户也当场填这一柜的三档单价 */}
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
              {modalError && (
                <div style={{ margin: "10px 0", padding: "10px 12px", background: "var(--c-red-bg)", color: "var(--c-red-deep)", borderRadius: 8, fontSize: 13, whiteSpace: "pre-wrap" }}>{modalError}</div>
              )}
              <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
                <button onClick={handleAddCustomer} disabled={addSubmitting} style={btnConfirm}>{addSubmitting ? "添加中..." : "确认新增"}</button>
                <button onClick={() => { setShowAddCustomer(false); setModalError(""); }} style={btnCancel}>取消</button>
              </div>
            </Modal>
          );
        })()}

        {/* ================================================================ */}
        {/* 弹窗：新建计划 */}
        {/* ================================================================ */}
        {showCreate && (
          <Modal wide onClose={() => { setShowCreate(false); setModalError(""); }}>
            <h3 style={{ marginTop: 0 }}>新建拼柜计划</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div>
                <label style={fl}>发货仓库</label>
                <select value={newWarehouse} onChange={e => setNewWarehouse(e.target.value)} style={fi}>
                  <option value="义乌">义乌</option>
                  <option value="深圳">深圳</option>
                  <option value="广州">广州</option>
                </select>
              </div>
              <div>
                <label style={fl}>柜型</label>
                <select value={newContainerType} onChange={e => setNewContainerType(e.target.value)} style={fi}>
                  <option value="40HQ">40HQ</option>
                  <option value="40GP">40GP</option>
                  <option value="20GP">20GP</option>
                </select>
              </div>
              <div>
                <label style={fl}>目的地</label>
                <input value={newDestinationTh} onChange={e => setNewDestinationTh(e.target.value)} placeholder="如 曼谷" style={fi} />
              </div>
              <div>
                <label style={fl}>总方数</label>
                <input type="number" value={newTotalVolume} onChange={e => setNewTotalVolume(e.target.value)} style={fi} />
              </div>
            </div>

            <div style={{ marginTop: 14 }}>
              <label style={fl}>选择客户</label>
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <input value={clientSearch} onChange={e => setClientSearch(e.target.value)} placeholder="按姓名 / 电话 / 公司搜索" style={{ ...fi, flex: 1 }} />
                <button onClick={() => loadClients()} style={btnCancel} disabled={clientsLoading}>{clientsLoading ? "刷新中..." : "刷新列表"}</button>
              </div>
              <div style={{ maxHeight: 200, overflowY: "auto", border: "1px solid var(--l-soft)", borderRadius: 6 }}>
                <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead><tr style={{ background: "var(--s-sunken)" }}>
                    <th style={{ ...thS, padding: "4px 8px", width: 40 }}></th>
                    <th style={{ ...thS, padding: "4px 8px" }}>客户名</th>
                    <th style={{ ...thS, padding: "4px 8px" }}>电话</th>
                    <th style={{ ...thS, padding: "4px 8px" }}>公司</th>
                    <th style={{ ...thS, padding: "4px 8px" }}>所属代理</th>
                  </tr></thead>
                  <tbody>
                    {filteredClients.length === 0 && (
                      <tr><td colSpan={5} style={{ ...tdS, padding: "10px 8px", color: "var(--t-faint)" }}>没有匹配的客户</td></tr>
                    )}
                    {filteredClients.map(cl => {
                      const isChecked = selectedCustomers.some(sc => sc.clientId === cl.id);
                      return (
                        <tr key={cl.id} style={{ cursor: "pointer", background: isChecked ? "var(--c-blue-bg)" : "white" }}>
                          <td style={{ ...tdS, padding: "4px 8px", textAlign: "center" }}>
                            <input type="checkbox" checked={isChecked} onChange={() => {
                              if (isChecked) setSelectedCustomers(selectedCustomers.filter(sc => sc.clientId !== cl.id));
                              else setSelectedCustomers([...selectedCustomers, { clientId: cl.id, unitPriceNormal: "", unitPriceInspection: "", unitPriceSensitive: "" }]);
                            }} />
                          </td>
                          <td style={{ ...tdS, padding: "4px 8px" }}>{cl.name}</td>
                          <td style={{ ...tdS, padding: "4px 8px" }}>{cl.phone}</td>
                          <td style={{ ...tdS, padding: "4px 8px" }}>{cl.companyName ?? "-"}</td>
                          <td style={{ ...tdS, padding: "4px 8px" }}>{cl.agentName ?? "-"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {selectedCustomers.length > 0 && (
              <div style={{ marginTop: 12 }}>
                {/* 2026-09-18 老板拍板：每个柜当场填价（每次柜价格都不一样） */}
                <label style={fl}>这一柜的单价（已选 {selectedCustomers.length} 位客户，元/方，必填）</label>
                {selectedCustomers.map((sc, idx) => {
                  const client = clients.find(cl => cl.id === sc.clientId);
                  const setPrice = (field: keyof CreateCustomerForm, value: string) => {
                    const next = [...selectedCustomers];
                    next[idx] = { ...next[idx], [field]: value };
                    setSelectedCustomers(next);
                  };
                  return (
                    <div key={sc.clientId} style={{ border: "1px solid var(--l-soft)", borderRadius: 6, padding: "8px 12px", marginBottom: 6, fontSize: 13, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                      <span style={{ fontWeight: 600, minWidth: 90 }}>{client?.name ?? sc.clientId}</span>
                      {([["普货", "unitPriceNormal"], ["商检货", "unitPriceInspection"], ["敏感货", "unitPriceSensitive"]] as Array<[string, keyof CreateCustomerForm]>).map(([label, field]) => (
                        <label key={field} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          <span style={{ color: "var(--t-muted)" }}>{label}</span>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={String(sc[field] ?? "")}
                            onChange={(e) => setPrice(field, e.target.value)}
                            style={{ ...fi, width: 90, padding: "4px 8px" }}
                          />
                        </label>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}

            {modalError && (
              <div style={{ margin: "10px 0", padding: "10px 12px", background: "var(--c-red-bg)", color: "var(--c-red-deep)", borderRadius: 8, fontSize: 13, whiteSpace: "pre-wrap" }}>{modalError}</div>
            )}
            <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
              <button onClick={handleCreate} disabled={createSubmitting} style={btnConfirm}>{createSubmitting ? "创建中..." : "确认创建"}</button>
              <button onClick={() => { setShowCreate(false); setModalError(""); }} style={btnCancel}>取消</button>
            </div>
          </Modal>
        )}

        {/* ================================================================ */}
        {/* 弹窗：图片预览 */}
        {/* ================================================================ */}
        {previewImage && (
          <div onClick={() => setPreviewImage(null)} style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <img src={previewImage} alt="预览" style={{ maxWidth: "90vw", maxHeight: "90vh", borderRadius: 8 }} />
          </div>
        )}

        {/* ======== 弹窗：删除集货计划（2026-08-07 新增）======== */}
        {deletePlanId && (
          <Modal onClose={() => setDeletePlanId(null)}>
            <p style={{ marginTop: 0, fontWeight: 600 }}>删除这个集货计划？</p>
            {deletePlanPreview?.hardBlocked ? (
              /* 发运红线：已经发出去的柜不给密码框、不给确认按钮，只说清为什么删不了 */
              <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 6, padding: 10, marginBottom: 12, fontSize: 13, color: "var(--c-red-deep)" }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>这个柜不能删</div>
                <div>{deletePlanPreview.hardBlockReason || "这个柜已经发运，已发出去的柜谁都不能删，输管理员密码也不行"}</div>
              </div>
            ) : deletePlanPreview ? (
              <>
                <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--t-body)" }}>会连带删掉：</p>
                <ul style={{ margin: "0 0 12px", paddingLeft: 20, fontSize: 13, color: "var(--t-body)" }}>
                  {Object.entries(deletePlanPreview.willDelete).map(([k, v]) => (
                    <li key={k}>{k}：{v} 条</li>
                  ))}
                </ul>
                {(deletePlanPreview.refundTotal ?? 0) > 0 && (
                  <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 6, padding: 10, marginBottom: 12, fontSize: 13, color: "var(--c-green-dark)" }}>
                    删除时会把已付的 <b>¥{(deletePlanPreview.refundTotal ?? 0).toFixed(2)}</b>
                    {" "}退回给 {deletePlanPreview.refundCount} 位客户的集货余额。
                  </div>
                )}
                {deletePlanPreview.blockers.length > 0 && (
                  <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 6, padding: 10, marginBottom: 12 }}>
                    <div style={{ fontSize: 13, color: "var(--c-red-deep)", fontWeight: 600, marginBottom: 4 }}>这个计划已经开始走流程了：</div>
                    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "var(--c-red-deep)" }}>
                      {deletePlanPreview.blockers.map((b, i) => <li key={i}>{b}</li>)}
                    </ul>
                    <div style={{ fontSize: 12, color: "#B02A25", marginTop: 6 }}>确实要删，请输入你的管理员密码：</div>
                    <input
                      type="password"
                      value={deletePlanPassword}
                      onChange={(e) => setDeletePlanPassword(e.target.value)}
                      placeholder="管理员密码"
                      style={{ marginTop: 6, width: "100%", border: "1px solid var(--l-strong)", borderRadius: 6, padding: "6px 10px", fontSize: 13 }}
                    />
                  </div>
                )}
                <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--t-muted)" }}>删了找不回来。</p>
              </>
            ) : (
              <p style={{ fontSize: 13, color: "var(--t-muted)" }}>正在查这个计划下面有多少东西…</p>
            )}
            {deletePlanError && <p style={{ color: "var(--c-red-deep)", fontSize: 13, margin: "0 0 10px" }}>{deletePlanError}</p>}
            <div style={{ display: "flex", gap: 8 }}>
              {!deletePlanPreview?.hardBlocked && (
                <button onClick={handleDeletePlan} disabled={deletePlanSubmitting || !deletePlanPreview}
                  style={{ padding: "8px 16px", background: deletePlanPreview ? "var(--c-red)" : "var(--l-strong)", color: "var(--white)", border: "none", borderRadius: 6, cursor: deletePlanPreview ? "pointer" : "not-allowed" }}>
                  {deletePlanSubmitting ? "删除中..." : "确认删除"}
                </button>
              )}
              <button onClick={() => setDeletePlanId(null)}
                style={{ padding: "8px 16px", border: "1px solid var(--l-strong)", background: "var(--white)", color: "var(--t-muted)", borderRadius: 6, cursor: "pointer" }}>{deletePlanPreview?.hardBlocked ? "知道了" : "取消"}</button>
            </div>
          </Modal>
        )}
      </div>
    </>
  );
}

// ============================================================================
// Modal 组件
// ============================================================================
function Modal({ children, onClose, wide }: { children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "var(--white)", borderRadius: 12, padding: 24, maxWidth: wide ? 700 : 520, width: "90vw", maxHeight: "85vh", overflowY: "auto", boxShadow: "0 8px 30px rgba(0,0,0,0.15)" }}>
        {children}
      </div>
    </div>
  );
}
