"use client";

import { useEffect, useState, useCallback } from "react";
import RoleShell from "../../../modules/layout/RoleShell";
import { authHeaders, apiBaseUrl, parseApiResponse } from "../../../services/core-api";
import { formatBeijingTime } from "../../../modules/staff/utils";

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
const CUSTOMER_STATUS_ZH: Record<string, string> = {
  filling: "填货中",
  received_pending_payment: "待付款",
  paid: "已付款",
  loading: "装柜中",
  shipped: "已发运",
  thailand_received: "泰国已签收",
  cancelled: "已取消",
};
const TAG: Record<string, { bg: string; color: string }> = {
  planning: { bg: "#e0e7ff", color: "#3730a3" },
  collecting: { bg: "#dbeafe", color: "#1e40af" },
  loading: { bg: "#ede9fe", color: "#5b21b6" },
  shipped: { bg: "#e0e7ff", color: "#3730a3" },
  completed: { bg: "#d1fae5", color: "#065f46" },
  cancelled: { bg: "#fee2e2", color: "#991b1b" },
  filling: { bg: "#dbeafe", color: "#1e40af" },
  received_pending_payment: { bg: "#fef3c7", color: "#92400e" },
  paid: { bg: "#d1fae5", color: "#065f46" },
  thailand_received: { bg: "#d1fae5", color: "#065f46" },
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
  deliveryAddress: string | null;
  status: string;
  signedAt: string | null;
  warehouseReceiptFileName: string | null;
  warehouseReceiptBase64: string | null;
  paymentProofs: { fileName: string; mime: string; base64Path: string; uploadedAt: string }[];
  paymentProofUploadedAt: string | null;
  paymentReviewedAt: string | null;
  paymentReviewedBy: string | null;
  paymentRejectReason: string | null;
  thailandReceiptFileName: string | null;
  thailandReceiptBase64: string | null;
  thailandReceivedAt: string | null;
  cancelReason: string | null;
  cancelledAt: string | null;
  totalPrealerts: number;
  totalPackages: number;
  totalItems: number;
  prealerts: PrealertItem[];
  statusLogs: {
    id: string;
    operatorName: string;
    operatorRole: string;
    fromStatus: string;
    toStatus: string;
    remark: string | null;
    createdAt: string;
  }[];
}

interface PlanDetail {
  id: string;
  planNo: string;
  warehouse: string;
  containerType: string;
  destinationTh: string;
  totalVolumeM3: number;
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
}

interface CreateCustomerForm {
  clientId: string;
  unitPriceNormal: string;
  unitPriceInspection: string;
  unitPriceSensitive: string;
}

// ============================================================================
// 共用样式
// ============================================================================
const thS: React.CSSProperties = { padding: "6px 10px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "#374151", borderBottom: "2px solid #e5e7eb", whiteSpace: "nowrap" };
const tdS: React.CSSProperties = { padding: "7px 10px", fontSize: 13, borderBottom: "1px solid #f3f4f6", verticalAlign: "middle" };
const btnConfirm: React.CSSProperties = { padding: "8px 18px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600, fontSize: 13 };
const btnCancel: React.CSSProperties = { padding: "8px 18px", border: "1px solid #d1d5db", color: "#6b7280", background: "#fff", borderRadius: 6, cursor: "pointer", fontSize: 13 };
const btnDanger: React.CSSProperties = { padding: "8px 18px", background: "#ef4444", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600, fontSize: 13 };
const fl: React.CSSProperties = { display: "block", fontSize: 13, color: "#374151", fontWeight: 500, marginBottom: 3 };
const fi: React.CSSProperties = { width: "100%", padding: "7px 10px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13, boxSizing: "border-box" };

// ============================================================================
// 主页面
// ============================================================================
export default function AdminWhrConsolidationPage() {
  // --- 列表 ---
  const [plans, setPlans] = useState<PlanItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState("");

  // --- 详情 ---
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [planDetail, setPlanDetail] = useState<PlanDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
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

  // --- 审核 ---
  const [reviewTarget, setReviewTarget] = useState<{ planId: string; customer: CustomerDetail } | null>(null);
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectPriceNormal, setRejectPriceNormal] = useState("");
  const [rejectPriceInspection, setRejectPriceInspection] = useState("");
  const [rejectPriceSensitive, setRejectPriceSensitive] = useState("");

  // --- 取消 ---
  const [cancelTarget, setCancelTarget] = useState<{ planId: string; customer: CustomerDetail } | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelSubmitting, setCancelSubmitting] = useState(false);

  // --- 改单价 ---
  const [priceTarget, setPriceTarget] = useState<CustomerDetail | null>(null);
  const [editPriceNormal, setEditPriceNormal] = useState("");
  const [editPriceInspection, setEditPriceInspection] = useState("");
  const [editPriceSensitive, setEditPriceSensitive] = useState("");
  const [priceSubmitting, setPriceSubmitting] = useState(false);

  // ==========================================================================
  // 数据加载
  // ==========================================================================
  const loadPlans = useCallback(async () => {
    setLoading(true);
    try {
      const data = await parseApiResponse<{ items: PlanItem[] }>(
        await fetch(`${apiBaseUrl()}/admin/whr-consolidation/plans`, { headers: authHeaders() })
      );
      setPlans(data.items ?? []);
    } catch (e: any) {
      setToast(e?.message ?? "加载计划列表失败");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (planId: string) => {
    setDetailLoading(true);
    try {
      const data = await parseApiResponse<PlanDetail>(
        await fetch(`${apiBaseUrl()}/admin/whr-consolidation/plans/detail?planId=${encodeURIComponent(planId)}`, { headers: authHeaders() })
      );
      setPlanDetail(data);
    } catch (e: any) {
      setToast(e?.message ?? "加载详情失败");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const loadClients = useCallback(async (search?: string) => {
    setClientsLoading(true);
    try {
      let url = `${apiBaseUrl()}/admin/users?role=client&pageSize=500`;
      if (search?.trim()) url += `&search=${encodeURIComponent(search.trim())}`;
      const data = await parseApiResponse<{ items: ClientOption[] }>(
        await fetch(url, { headers: authHeaders() })
      );
      setClients(data.items ?? []);
    } catch (e: any) {
      setToast(e?.message ?? "加载客户列表失败");
    } finally {
      setClientsLoading(false);
    }
  }, []);

  useEffect(() => { loadPlans(); }, [loadPlans]);

  // ==========================================================================
  // 操作函数
  // ==========================================================================
  const handleCreate = async () => {
    if (!newDestinationTh.trim()) { setToast("请输入目的地"); return; }
    if (selectedCustomers.length === 0) { setToast("请至少选择一位客户"); return; }
    for (let i = 0; i < selectedCustomers.length; i++) {
      const c = selectedCustomers[i];
      if (!c.unitPriceNormal || Number(c.unitPriceNormal) <= 0) { setToast(`第${i + 1}位客户普货单价必须大于0`); return; }
      if (!c.unitPriceInspection || Number(c.unitPriceInspection) <= 0) { setToast(`第${i + 1}位客户商检单价必须大于0`); return; }
      if (!c.unitPriceSensitive || Number(c.unitPriceSensitive) <= 0) { setToast(`第${i + 1}位客户敏感货单价必须大于0`); return; }
    }
    setCreateSubmitting(true);
    try {
      await parseApiResponse<any>(
        await fetch(`${apiBaseUrl()}/admin/whr-consolidation/plans`, {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            warehouse: newWarehouse,
            containerType: newContainerType,
            destinationTh: newDestinationTh.trim(),
            totalVolumeM3: Number(newTotalVolume) || 68,
            customers: selectedCustomers.map(c => ({
              clientId: c.clientId,
              unitPriceNormal: Number(c.unitPriceNormal),
              unitPriceInspection: Number(c.unitPriceInspection),
              unitPriceSensitive: Number(c.unitPriceSensitive),
            })),
          }),
        })
      );
      setToast("计划创建成功");
      setShowCreate(false);
      setNewDestinationTh("");
      setNewWarehouse("义乌");
      setNewContainerType("40HQ");
      setNewTotalVolume("68");
      setSelectedCustomers([]);
      loadPlans();
    } catch (e: any) { setToast(e?.message ?? "创建失败"); }
    finally { setCreateSubmitting(false); }
  };

  const handleApprove = async () => {
    if (!reviewTarget) return;
    setReviewSubmitting(true);
    try {
      await parseApiResponse<any>(
        await fetch(`${apiBaseUrl()}/admin/whr-consolidation/customers/review`, {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ planId: reviewTarget.planId, customerId: reviewTarget.customer.id, action: "approve" }),
        })
      );
      setToast("审核通过");
      setReviewTarget(null);
      if (selectedPlanId) loadDetail(selectedPlanId);
      loadPlans();
    } catch (e: any) { setToast(e?.message ?? "审核失败"); }
    finally { setReviewSubmitting(false); }
  };

  const handleReject = async () => {
    if (!reviewTarget || !rejectReason.trim()) { setToast("请填写拒绝原因"); return; }
    setReviewSubmitting(true);
    try {
      await parseApiResponse<any>(
        await fetch(`${apiBaseUrl()}/admin/whr-consolidation/customers/review`, {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            planId: reviewTarget.planId,
            customerId: reviewTarget.customer.id,
            action: "reject",
            rejectReason: rejectReason.trim(),
            unitPriceNormal: rejectPriceNormal ? Number(rejectPriceNormal) : undefined,
            unitPriceInspection: rejectPriceInspection ? Number(rejectPriceInspection) : undefined,
            unitPriceSensitive: rejectPriceSensitive ? Number(rejectPriceSensitive) : undefined,
          }),
        })
      );
      setToast("已拒绝");
      setShowReject(false); setReviewTarget(null); setRejectReason(""); setRejectPriceNormal(""); setRejectPriceInspection(""); setRejectPriceSensitive("");
      if (selectedPlanId) loadDetail(selectedPlanId);
      loadPlans();
    } catch (e: any) { setToast(e?.message ?? "操作失败"); }
    finally { setReviewSubmitting(false); }
  };

  const handleCancel = async () => {
    if (!cancelTarget || !cancelReason.trim()) { setToast("请填写取消原因"); return; }
    setCancelSubmitting(true);
    try {
      await parseApiResponse<any>(
        await fetch(`${apiBaseUrl()}/admin/whr-consolidation/customers/cancel`, {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ planId: cancelTarget.planId, customerId: cancelTarget.customer.id, cancelReason: cancelReason.trim() }),
        })
      );
      setToast("已取消");
      setCancelTarget(null); setCancelReason("");
      if (selectedPlanId) loadDetail(selectedPlanId);
      loadPlans();
    } catch (e: any) { setToast(e?.message ?? "取消失败"); }
    finally { setCancelSubmitting(false); }
  };

  const handleUpdatePrice = async () => {
    if (!priceTarget || !selectedPlanId) return;
    setPriceSubmitting(true);
    try {
      await parseApiResponse<any>(
        await fetch(`${apiBaseUrl()}/admin/whr-consolidation/customers/price`, {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            planId: selectedPlanId,
            customerId: priceTarget.id,
            unitPriceNormal: editPriceNormal ? Number(editPriceNormal) : undefined,
            unitPriceInspection: editPriceInspection ? Number(editPriceInspection) : undefined,
            unitPriceSensitive: editPriceSensitive ? Number(editPriceSensitive) : undefined,
          }),
        })
      );
      setToast("单价已更新");
      setPriceTarget(null);
      loadDetail(selectedPlanId);
    } catch (e: any) { setToast(e?.message ?? "更新失败"); }
    finally { setPriceSubmitting(false); }
  };

  // ==========================================================================
  // 渲染
  // ==========================================================================
  return (
    <RoleShell allowedRole="admin" title="集货拼柜（仓库版）">
      <div style={{ maxWidth: "100%", padding: "20px 24px" }}>
        {/* Toast */}
        {toast && (
          <div onClick={() => setToast("")} style={{ cursor: "pointer", marginBottom: 16, padding: "10px 16px", background: "#fef3c7", color: "#92400e", borderRadius: 8, fontSize: 14 }}>
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
              <button onClick={() => { setShowCreate(true); loadClients(); }} style={btnConfirm}>+ 新建计划</button>
            </div>

            {loading ? (
              <p style={{ color: "#9ca3af", fontSize: 14 }}>加载中...</p>
            ) : plans.length === 0 ? (
              <p style={{ color: "#9ca3af", fontSize: 14 }}>暂无计划</p>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "#f9fafb" }}>
                    <th style={thS}>计划编号</th>
                    <th style={thS}>仓库</th>
                    <th style={thS}>柜型</th>
                    <th style={thS}>目的地</th>
                    <th style={thS}>总方数</th>
                    <th style={thS}>客户数</th>
                    <th style={thS}>状态</th>
                    <th style={thS}>创建人</th>
                    <th style={thS}>创建时间</th>
                  </tr>
                </thead>
                <tbody>
                  {plans.map(p => (
                    <tr key={p.id} onClick={() => { setSelectedPlanId(p.id); loadDetail(p.id); }} style={{ cursor: "pointer", background: "white" }}
                      onMouseEnter={e => (e.currentTarget.style.background = "#f9fafb")}
                      onMouseLeave={e => (e.currentTarget.style.background = "white")}>
                      <td style={{ ...tdS, fontWeight: 600, minWidth: 120, whiteSpace: "nowrap" }}>{p.planNo}</td>
                      <td style={tdS}>{p.warehouse}</td>
                      <td style={tdS}>{p.containerType}</td>
                      <td style={tdS}>{p.destinationTh}</td>
                      <td style={tdS}>{p.totalVolumeM3} 方</td>
                      <td style={tdS}>{p.customerCount}</td>
                      <td style={tdS}>
                        <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 4, background: TAG[p.status]?.bg ?? "#e5e7eb", color: TAG[p.status]?.color ?? "#374151" }}>
                          {PLAN_STATUS_ZH[p.status] ?? p.status}
                        </span>
                      </td>
                      <td style={tdS}>{p.creatorName}</td>
                      <td style={tdS}>{formatBeijingTime(p.createdAt)}</td>
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
            <button onClick={() => { setSelectedPlanId(null); setPlanDetail(null); setExpandedCustomer(null); }} style={{ ...btnCancel, marginBottom: 16 }}>
              ← 返回列表
            </button>

            {detailLoading ? (
              <p style={{ color: "#9ca3af", fontSize: 14 }}>加载中...</p>
            ) : !planDetail ? (
              <p style={{ color: "#9ca3af", fontSize: 14 }}>计划不存在</p>
            ) : (
              <>
                {/* 基本信息卡片 */}
                <div style={{ background: "#f9fafb", borderRadius: 10, padding: "16px 20px", marginBottom: 20 }}>
                  <h3 style={{ margin: "0 0 10px", fontSize: 18 }}>{planDetail.planNo}</h3>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "8px 24px", fontSize: 13 }}>
                    <div><span style={{ color: "#6b7280" }}>仓库：</span>{planDetail.warehouse}</div>
                    <div><span style={{ color: "#6b7280" }}>柜型：</span>{planDetail.containerType}</div>
                    <div><span style={{ color: "#6b7280" }}>目的地：</span>{planDetail.destinationTh}</div>
                    <div><span style={{ color: "#6b7280" }}>总方数：</span>{planDetail.totalVolumeM3} 方</div>
                    <div><span style={{ color: "#6b7280" }}>状态：</span>
                      <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 4, background: TAG[planDetail.status]?.bg ?? "#e5e7eb", color: TAG[planDetail.status]?.color ?? "#374151" }}>
                        {PLAN_STATUS_ZH[planDetail.status] ?? planDetail.status}
                      </span>
                    </div>
                    <div><span style={{ color: "#6b7280" }}>创建人：</span>{planDetail.creatorName}</div>
                    <div><span style={{ color: "#6b7280" }}>创建时间：</span>{formatBeijingTime(planDetail.createdAt)}</div>
                  </div>
                </div>

                {/* 客户卡片列表 */}
                <h3 style={{ fontSize: 16, marginBottom: 12 }}>参与客户（{planDetail.customers.length}）</h3>
                {planDetail.customers.map(c => {
                  const isExpanded = expandedCustomer === c.id;
                  return (
                    <div key={c.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, marginBottom: 12, overflow: "hidden" }}>
                      {/* 客户卡片头 */}
                      <div onClick={() => setExpandedCustomer(isExpanded ? null : c.id)} style={{ cursor: "pointer", padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", background: isExpanded ? "#f9fafb" : "white" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                          <span style={{ fontWeight: 600, fontSize: 15 }}>{c.clientName}</span>
                          <span style={{ fontSize: 12, color: "#6b7280" }}>{c.clientPhone} · {c.clientCompany}</span>
                          <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 4, background: TAG[c.status]?.bg ?? "#e5e7eb", color: TAG[c.status]?.color ?? "#374151" }}>
                            {CUSTOMER_STATUS_ZH[c.status] ?? c.status}
                          </span>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                          <span style={{ fontSize: 13, color: "#6b7280" }}>
                            {c.totalVolumeM3} 方
                            {c.totalFee != null ? ` · ¥${c.totalFee.toLocaleString()}` : ""}
                          </span>
                          <span style={{ fontSize: 12, color: "#9ca3af" }}>{isExpanded ? "▲" : "▼"}</span>
                        </div>
                      </div>

                      {/* 客户卡片展开体 */}
                      {isExpanded && (
                        <div style={{ padding: "12px 16px", borderTop: "1px solid #e5e7eb", background: "#fafafa" }}>
                          {/* 价格信息 */}
                          <div style={{ display: "flex", gap: 20, fontSize: 13, marginBottom: 12, color: "#374151" }}>
                            <span>普货：{c.unitPriceNormal} 元/方</span>
                            <span>商检：{c.unitPriceInspection} 元/方</span>
                            <span>敏感：{c.unitPriceSensitive} 元/方</span>
                            {c.totalFee != null && <span style={{ fontWeight: 600 }}>总费用：¥{c.totalFee.toLocaleString()}</span>}
                            <button onClick={(e) => { e.stopPropagation(); setPriceTarget(c); setEditPriceNormal(String(c.unitPriceNormal)); setEditPriceInspection(String(c.unitPriceInspection)); setEditPriceSensitive(String(c.unitPriceSensitive)); }} style={{ ...btnCancel, padding: "4px 12px", fontSize: 12 }}>改单价</button>
                          </div>
                          {c.deliveryAddress && <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 10 }}>收货地址：{c.deliveryAddress}</div>}

                          {/* 收货凭证 */}
                          {c.warehouseReceiptBase64 && (
                            <div style={{ marginBottom: 10 }}>
                              <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 4 }}>收货凭证</div>
                              <img src={c.warehouseReceiptBase64} alt="收货凭证" onClick={() => setPreviewImage(c.warehouseReceiptBase64!)} style={{ maxWidth: "100%", maxHeight: 200, borderRadius: 6, border: "1px solid #e5e7eb", cursor: "pointer" }} />
                            </div>
                          )}

                          {/* 预报单列表 */}
                          {c.prealerts.length > 0 && (
                            <div style={{ marginBottom: 10 }}>
                              <div style={{ fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 6 }}>预报单（{c.prealerts.length}）</div>
                              {c.prealerts.map(pa => {
                                const paPkg = pa.items.reduce((s: number, it: any) => s + it.packageCount, 0);
                                const paVol = pa.items.reduce((s: number, it: any) => s + (it.volumeM3 ?? 0), 0);
                                return (
                                  <div key={pa.id} style={{ marginBottom: 6, border: "1px solid #e5e7eb", borderRadius: 6, overflow: "hidden" }}>
                                    <div style={{ padding: "6px 12px", background: "#f9fafb", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
                                      <span><strong>{pa.trackingNo}</strong> · {pa.mark}</span>
                                      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                        <span style={{ fontSize: 11, padding: "1px 6px", borderRadius: 3, background: pa.status === "received" ? "#d1fae5" : "#fef3c7", color: pa.status === "received" ? "#065f46" : "#92400e" }}>
                                          {pa.status === "received" ? "已签收" : "待签收"}
                                        </span>
                                        <span style={{ color: "#6b7280" }}>{paPkg}件 · {paVol.toFixed(3)}方</span>
                                      </span>
                                    </div>
                                    {pa.items.length > 0 && (
                                      <div style={{ overflowX: "auto", padding: "4px 8px" }}>
                                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                                          <thead><tr style={{ background: "#f3f4f6" }}>
                                            <th style={{ ...thS, padding: "3px 5px", fontSize: 11 }}>品名</th>
                                            <th style={{ ...thS, padding: "3px 5px", fontSize: 11 }}>件数</th>
                                            <th style={{ ...thS, padding: "3px 5px", fontSize: 11 }}>方数</th>
                                            <th style={{ ...thS, padding: "3px 5px", fontSize: 11 }}>类型</th>
                                            <th style={{ ...thS, padding: "3px 5px", fontSize: 11 }}>材质</th>
                                            <th style={{ ...thS, padding: "3px 5px", fontSize: 11 }}>货值</th>
                                            <th style={{ ...thS, padding: "3px 5px", fontSize: 11 }}>图片</th>
                                          </tr></thead>
                                          <tbody>
                                            {pa.items.map((it: any) => (
                                              <tr key={it.id}>
                                                <td style={{ ...tdS, padding: "3px 5px", fontSize: 11 }}>{it.productName}</td>
                                                <td style={{ ...tdS, padding: "3px 5px", fontSize: 11 }}>{it.packageCount}</td>
                                                <td style={{ ...tdS, padding: "3px 5px", fontSize: 11 }}>{it.volumeM3 != null ? it.volumeM3.toFixed(6) : "-"}</td>
                                                <td style={{ ...tdS, padding: "3px 5px", fontSize: 11 }}>{it.cargoType === "inspection" ? "商检" : it.cargoType === "sensitive" ? "敏感" : "普货"}</td>
                                                <td style={{ ...tdS, padding: "3px 5px", fontSize: 11 }}>{it.material}</td>
                                                <td style={{ ...tdS, padding: "3px 5px", fontSize: 11 }}>{it.cargoValue}</td>
                                                <td style={{ ...tdS, padding: "3px 5px", fontSize: 11 }}>
                                                  {it.productImageBase64 ? (
                                                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                                      <img src={it.productImageBase64} alt="产品图片" style={{ width: 36, height: 36, objectFit: "cover", borderRadius: 4, border: "1px solid #e5e7eb", cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); setPreviewImage(it.productImageBase64); }} />
                                                      <button onClick={(e) => { e.stopPropagation(); setPreviewImage(it.productImageBase64); }} style={{ ...btnCancel, padding: "2px 6px", fontSize: 10 }}>查看</button>
                                                    </div>
                                                  ) : <span style={{ color: "#d1d5db" }}>暂无图片</span>}
                                                </td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}

                          {/* 付款截图 */}
                          {(c.paymentProofs?.length ?? 0) > 0 && (
                            <div style={{ marginBottom: 10 }}>
                              <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 4 }}>付款截图（{c.paymentProofs.length} 张）</div>
                              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                {c.paymentProofs.map((p, i) => (
                                  <img key={i} src={p.base64Path} alt={`凭证 ${i + 1}`} onClick={() => setPreviewImage(p.base64Path)} style={{ width: 80, height: 80, objectFit: "cover", borderRadius: 4, border: "1px solid #e5e7eb", cursor: "pointer" }} />
                                ))}
                              </div>
                            </div>
                          )}

                          {/* 拒绝原因 */}
                          {c.paymentRejectReason && (
                            <div style={{ fontSize: 12, color: "#ef4444", marginBottom: 10 }}>拒绝原因：{c.paymentRejectReason}</div>
                          )}

                          {/* 操作按钮 */}
                          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                            {c.status === "received_pending_payment" && (
                              <>
                                <button onClick={() => setReviewTarget({ planId: selectedPlanId!, customer: c })} style={btnConfirm}>审核付款</button>
                                <button onClick={() => setCancelTarget({ planId: selectedPlanId!, customer: c })} style={btnDanger}>取消资格</button>
                              </>
                            )}
                          </div>

                          {/* 状态时间线 */}
                          {c.statusLogs.length > 0 && (
                            <div>
                              <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 6 }}>状态时间线</div>
                              {c.statusLogs.map(sl => (
                                <div key={sl.id} style={{ fontSize: 12, color: "#6b7280", marginBottom: 4, paddingLeft: 8, borderLeft: "2px solid #e5e7eb" }}>
                                  <strong>{CUSTOMER_STATUS_ZH[sl.fromStatus] ?? sl.fromStatus}</strong> → <strong>{CUSTOMER_STATUS_ZH[sl.toStatus] ?? sl.toStatus}</strong>
                                  &nbsp;· {sl.operatorName} · {formatBeijingTime(sl.createdAt)}
                                  {sl.remark && <div style={{ color: "#9ca3af" }}>{sl.remark}</div>}
                                </div>
                              ))}
                            </div>
                          )}
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
        {/* 弹窗：新建计划 */}
        {/* ================================================================ */}
        {showCreate && (
          <Modal wide onClose={() => { setShowCreate(false); setSelectedCustomers([]); setClientSearch(""); }}>
            <h3 style={{ marginTop: 0 }}>新建拼柜计划</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
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
                <label style={fl}>目的地 *</label>
                <input value={newDestinationTh} onChange={e => setNewDestinationTh(e.target.value)} placeholder="如：曼谷" style={fi} />
              </div>
              <div>
                <label style={fl}>总方数</label>
                <input type="number" value={newTotalVolume} onChange={e => setNewTotalVolume(e.target.value)} style={fi} />
              </div>
            </div>

            {/* 选客户 */}
            <label style={fl}>选择客户 *</label>
            <input placeholder="搜索客户姓名..." value={clientSearch} onChange={e => { setClientSearch(e.target.value); loadClients(e.target.value); }} style={{ ...fi, marginBottom: 8 }} />
            {clientsLoading ? <p style={{ fontSize: 12, color: "#9ca3af" }}>加载中...</p> : (
              <div style={{ maxHeight: 160, overflowY: "auto", border: "1px solid #e5e7eb", borderRadius: 6, marginBottom: 8 }}>
                {clients.filter(c => !selectedCustomers.some(s => s.clientId === c.id)).map(c => (
                  <div key={c.id} onClick={() => setSelectedCustomers([...selectedCustomers, { clientId: c.id, unitPriceNormal: "", unitPriceInspection: "", unitPriceSensitive: "" }])}
                    style={{ cursor: "pointer", padding: "6px 10px", fontSize: 13, borderBottom: "1px solid #f3f4f6" }}>
                    + {c.name} · {c.phone} {c.companyName ? `· ${c.companyName}` : ""}
                  </div>
                ))}
                {clients.filter(c => !selectedCustomers.some(s => s.clientId === c.id)).length === 0 && !clientsLoading && (
                  <div style={{ padding: "6px 10px", fontSize: 13, color: "#9ca3af" }}>无更多客户</div>
                )}
              </div>
            )}

            {/* 已选客户填价格 */}
            {selectedCustomers.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>已选客户（{selectedCustomers.length}）</div>
                {selectedCustomers.map((sc, idx) => {
                  const c = clients.find(x => x.id === sc.clientId);
                  return (
                    <div key={sc.clientId} style={{ padding: "8px 10px", border: "1px solid #e5e7eb", borderRadius: 6, marginBottom: 6, background: "#f9fafb", fontSize: 13 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                        <span><strong>{c?.name ?? sc.clientId}</strong> {c?.phone}</span>
                        <button onClick={() => setSelectedCustomers(selectedCustomers.filter(x => x.clientId !== sc.clientId))} style={{ ...btnCancel, padding: "2px 8px", fontSize: 11 }}>移除</button>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
                        <div>
                          <label style={{ fontSize: 11, color: "#6b7280" }}>普货单价 *</label>
                          <input type="number" placeholder="元/方" value={sc.unitPriceNormal} onChange={e => {
                            const copy = [...selectedCustomers]; copy[idx] = { ...copy[idx], unitPriceNormal: e.target.value }; setSelectedCustomers(copy);
                          }} style={{ ...fi, padding: "4px 6px", fontSize: 12 }} />
                        </div>
                        <div>
                          <label style={{ fontSize: 11, color: "#6b7280" }}>商检单价 *</label>
                          <input type="number" placeholder="元/方" value={sc.unitPriceInspection} onChange={e => {
                            const copy = [...selectedCustomers]; copy[idx] = { ...copy[idx], unitPriceInspection: e.target.value }; setSelectedCustomers(copy);
                          }} style={{ ...fi, padding: "4px 6px", fontSize: 12 }} />
                        </div>
                        <div>
                          <label style={{ fontSize: 11, color: "#6b7280" }}>敏感单价 *</label>
                          <input type="number" placeholder="元/方" value={sc.unitPriceSensitive} onChange={e => {
                            const copy = [...selectedCustomers]; copy[idx] = { ...copy[idx], unitPriceSensitive: e.target.value }; setSelectedCustomers(copy);
                          }} style={{ ...fi, padding: "4px 6px", fontSize: 12 }} />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={handleCreate} disabled={createSubmitting} style={btnConfirm}>{createSubmitting ? "创建中..." : "确认创建"}</button>
              <button onClick={() => { setShowCreate(false); setSelectedCustomers([]); setClientSearch(""); }} style={btnCancel}>取消</button>
            </div>
          </Modal>
        )}

        {/* ================================================================ */}
        {/* 弹窗：审核付款 */}
        {/* ================================================================ */}
        {reviewTarget && !showReject && (
          <Modal onClose={() => setReviewTarget(null)}>
            <h3 style={{ marginTop: 0 }}>审核付款 - {reviewTarget.customer.clientName}</h3>
            {/* 费用明细：按货物类型分组 */}
            {(() => {
              const allItems = reviewTarget.customer.prealerts.flatMap((pa: any) => pa.items ?? []);
              const volNormal = allItems.filter((it: any) => it.cargoType !== "inspection" && it.cargoType !== "sensitive").reduce((s: number, it: any) => s + (it.volumeM3 ?? 0), 0);
              const volInspection = allItems.filter((it: any) => it.cargoType === "inspection").reduce((s: number, it: any) => s + (it.volumeM3 ?? 0), 0);
              const volSensitive = allItems.filter((it: any) => it.cargoType === "sensitive").reduce((s: number, it: any) => s + (it.volumeM3 ?? 0), 0);
              const feeNormal = Math.round(volNormal * reviewTarget.customer.unitPriceNormal * 100) / 100;
              const feeInspection = Math.round(volInspection * reviewTarget.customer.unitPriceInspection * 100) / 100;
              const feeSensitive = Math.round(volSensitive * reviewTarget.customer.unitPriceSensitive * 100) / 100;
              return (
                <div style={{ fontSize: 13, marginBottom: 10, color: "#374151" }}>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>费用明细</div>
                  {volNormal > 0 && <div style={{ marginBottom: 3 }}>普货：{volNormal.toFixed(3)} 方 × {reviewTarget.customer.unitPriceNormal} 元/方 = <strong>¥{feeNormal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong></div>}
                  {volInspection > 0 && <div style={{ marginBottom: 3 }}>商检：{volInspection.toFixed(3)} 方 × {reviewTarget.customer.unitPriceInspection} 元/方 = <strong>¥{feeInspection.toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong></div>}
                  {volSensitive > 0 && <div style={{ marginBottom: 3 }}>敏感：{volSensitive.toFixed(3)} 方 × {reviewTarget.customer.unitPriceSensitive} 元/方 = <strong>¥{feeSensitive.toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong></div>}
                  <div style={{ borderTop: "1px solid #d1d5db", marginTop: 6, paddingTop: 6 }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: "#2563eb" }}>合计：¥{reviewTarget.customer.totalFee?.toLocaleString() ?? "—"}</div>
                  </div>
                </div>
              );
            })()}
            {/* 预报单+货品预览 */}
            {reviewTarget.customer.prealerts.map(pa => (
              <div key={pa.id} style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 4 }}>{pa.trackingNo} · {pa.mark} · {pa.items.reduce((s, it) => s + it.packageCount, 0)}件</div>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, marginBottom: 4 }}>
                  <thead><tr style={{ background: "#f9fafb" }}>
                    <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>品名</th>
                    <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>件数</th>
                    <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>方数</th>
                    <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>类型</th>
                  </tr></thead>
                  <tbody>{pa.items.map(it => (
                    <tr key={it.id}>
                      <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.productName}</td>
                      <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.packageCount}</td>
                      <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.volumeM3 != null ? it.volumeM3.toFixed(6) : "-"}</td>
                      <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.cargoType === "inspection" ? "商检" : it.cargoType === "sensitive" ? "敏感" : "普货"}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            ))}
            {/* 付款截图 */}
            {(reviewTarget.customer.paymentProofs?.length ?? 0) > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 4 }}>付款截图（{reviewTarget.customer.paymentProofs.length} 张）</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {reviewTarget.customer.paymentProofs.map((p: any, i: number) => (
                    <img key={i} src={p.base64Path} alt={`凭证 ${i + 1}`} onClick={() => setPreviewImage(p.base64Path)} style={{ width: 100, height: 100, objectFit: "cover", borderRadius: 4, border: "1px solid #e5e7eb", cursor: "pointer" }} />
                  ))}
                </div>
              </div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={handleApprove} disabled={reviewSubmitting} style={btnConfirm}>{reviewSubmitting ? "处理中..." : "✓ 审核通过"}</button>
              <button onClick={() => setShowReject(true)} disabled={reviewSubmitting} style={btnCancel}>✗ 审核不通过</button>
            </div>
          </Modal>
        )}

        {/* ================================================================ */}
        {/* 弹窗：拒绝理由 */}
        {/* ================================================================ */}
        {showReject && reviewTarget && (
          <Modal onClose={() => { setShowReject(false); setRejectReason(""); }}>
            <h3 style={{ marginTop: 0 }}>审核不通过</h3>
            <div style={{ display: "grid", gap: 10 }}>
              <div>
                <label style={fl}>拒绝原因 *</label>
                <textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)} placeholder="请填写拒绝原因，客户可见" style={{ ...fi, minHeight: 80 }} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                <div>
                  <label style={fl}>修改普货单价</label>
                  <input type="number" value={rejectPriceNormal} onChange={e => setRejectPriceNormal(e.target.value)} placeholder="留空不修改" style={fi} />
                </div>
                <div>
                  <label style={fl}>修改商检单价</label>
                  <input type="number" value={rejectPriceInspection} onChange={e => setRejectPriceInspection(e.target.value)} placeholder="留空不修改" style={fi} />
                </div>
                <div>
                  <label style={fl}>修改敏感单价</label>
                  <input type="number" value={rejectPriceSensitive} onChange={e => setRejectPriceSensitive(e.target.value)} placeholder="留空不修改" style={fi} />
                </div>
              </div>
            </div>
            <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
              <button onClick={handleReject} disabled={reviewSubmitting} style={btnConfirm}>{reviewSubmitting ? "提交中..." : "确认拒绝"}</button>
              <button onClick={() => { setShowReject(false); setRejectReason(""); }} style={btnCancel}>取消</button>
            </div>
          </Modal>
        )}

        {/* ================================================================ */}
        {/* 弹窗：取消资格 */}
        {/* ================================================================ */}
        {cancelTarget && (
          <Modal onClose={() => { setCancelTarget(null); setCancelReason(""); }}>
            <h3 style={{ marginTop: 0 }}>取消客户资格</h3>
            <p style={{ fontSize: 14, color: "#6b7280", marginBottom: 10 }}>此操作不可恢复，将取消客户在此计划中的参与资格。</p>
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
        {/* 弹窗：改单价 */}
        {/* ================================================================ */}
        {priceTarget && selectedPlanId && (
          <Modal onClose={() => setPriceTarget(null)}>
            <h3 style={{ marginTop: 0 }}>修改单价 - {priceTarget.clientName}</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 10 }}>
              <div>
                <label style={fl}>普货单价 (元/方)</label>
                <input type="number" value={editPriceNormal} onChange={e => setEditPriceNormal(e.target.value)} style={fi} />
              </div>
              <div>
                <label style={fl}>商检单价 (元/方)</label>
                <input type="number" value={editPriceInspection} onChange={e => setEditPriceInspection(e.target.value)} style={fi} />
              </div>
              <div>
                <label style={fl}>敏感单价 (元/方)</label>
                <input type="number" value={editPriceSensitive} onChange={e => setEditPriceSensitive(e.target.value)} style={fi} />
              </div>
            </div>
            <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
              <button onClick={handleUpdatePrice} disabled={priceSubmitting} style={btnConfirm}>{priceSubmitting ? "保存中..." : "保存"}</button>
              <button onClick={() => setPriceTarget(null)} style={btnCancel}>取消</button>
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
      </div>
    </RoleShell>
  );
}

// ============================================================================
// Modal 组件
// ============================================================================
function Modal({ children, onClose, wide }: { children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, padding: 24, maxWidth: wide ? 700 : 520, width: "90vw", maxHeight: "85vh", overflowY: "auto", boxShadow: "0 8px 30px rgba(0,0,0,0.15)" }}>
        {children}
      </div>
    </div>
  );
}
