"use client";

import { useEffect, useState, useCallback } from "react";
import RoleShell from "../../../modules/layout/RoleShell";
import { authHeaders, apiBaseUrl, parseApiResponse } from "../../../services/core-api";
import { formatBeijingTime } from "../../../modules/staff/utils";

// ============================================================================
// 状态中文
// ============================================================================
const STATUS_ZH: Record<string, string> = {
  filling: "填货中",
  received_pending_payment: "待付款",
  paid: "已付款",
  loading: "装柜中",
  shipped: "已发运",
  thailand_received: "泰国已签收",
  cancelled: "已取消",
  pending: "待签收",
  received: "已签收",
};
const ST_TAG: Record<string, { bg: string; color: string }> = {
  filling: { bg: "#dbeafe", color: "#1e40af" },
  received_pending_payment: { bg: "#fef3c7", color: "#92400e" },
  paid: { bg: "#d1fae5", color: "#065f46" },
  loading: { bg: "#ede9fe", color: "#5b21b6" },
  shipped: { bg: "#e0e7ff", color: "#3730a3" },
  thailand_received: { bg: "#d1fae5", color: "#065f46" },
  cancelled: { bg: "#fee2e2", color: "#991b1b" },
};

// ============================================================================
// 类型
// ============================================================================
interface MyPlan {
  planId: string; planNo: string; warehouse: string; containerType: string; destinationTh: string;
  totalVolumeM3: number; usedVolumeM3: number; myStatus: string;
  myTotalVolumeM3: number; myTotalFee: number | null;
  myUnitPriceNormal: number; myUnitPriceInspection: number; myUnitPriceSensitive: number;
  mySignedAt: string | null; myPaymentProofBase64: string | null;
  myPaymentProofUploadedAt: string | null; myPaymentReviewedAt: string | null;
  myPaymentRejectReason: string | null;
  myThailandReceiptFileName: string | null; myThailandReceiptBase64: string | null;
  myThailandReceivedAt: string | null; myCancelReason: string | null;
  createdAt: string;
}

interface ItemRow {
  id: string; productName: string; packageCount: number; quantityPerBox: number;
  totalQuantity: number; unitWeightKg: number | null; totalWeightKg: number | null;
  lengthCm: number | null; widthCm: number | null; heightCm: number | null;
  volumeM3: number | null; material: string; cargoValue: string; cargoType: string;
  productImageFileName: string | null; productImageBase64: string | null; sortOrder: number;
}
interface PrealertRow {
  id: string; trackingNo: string; expressNo: string | null; mark: string;
  status: string; receivedAt: string | null; createdAt: string; items: ItemRow[];
}
interface MyDetail {
  customerId: string; status: string;
  unitPriceNormal: number; unitPriceInspection: number; unitPriceSensitive: number;
  totalVolumeM3: number; totalFee: number | null; signedAt: string | null;
  deliveryAddress: string | null;
  paymentProofs: { fileName: string; mime: string; base64Path: string; uploadedAt: string }[];
  paymentProofUploadedAt: string | null;
  paymentReviewedAt: string | null; paymentRejectReason: string | null;
  thailandReceiptFileName: string | null; thailandReceiptBase64: string | null;
  thailandReceivedAt: string | null; cancelReason: string | null;
  totalPrealerts: number; totalPackages: number;
  prealerts: PrealertRow[];
  statusLogs: { id: string; operatorName: string; operatorRole: string; fromStatus: string; toStatus: string; remark: string | null; createdAt: string }[];
}

// 货品表单行
interface ProductFormRow {
  productName: string; packageCount: string; quantityPerBox: string;
  lengthCm: string; widthCm: string; heightCm: string; unitWeightKg: string;
  material: string; cargoValue: string; cargoType: string;
  imageFile?: { fileName: string; mime: string; base64: string };
  existingImageBase64?: string;
}

// ============================================================================
// 样式
// ============================================================================
const btnBlue: React.CSSProperties = { padding: "8px 18px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600, fontSize: 13 };
const btnGray: React.CSSProperties = { padding: "8px 18px", border: "1px solid #d1d5db", color: "#6b7280", background: "#fff", borderRadius: 6, cursor: "pointer", fontSize: 13 };
const btnDanger: React.CSSProperties = { padding: "8px 18px", background: "#ef4444", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600, fontSize: 13 };
const fl: React.CSSProperties = { display: "block", fontSize: 13, color: "#374151", fontWeight: 500, marginBottom: 3 };
const fi: React.CSSProperties = { width: "100%", padding: "7px 10px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13, boxSizing: "border-box" };
const thS: React.CSSProperties = { padding: "6px 8px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "#374151", borderBottom: "2px solid #e5e7eb", whiteSpace: "nowrap" };
const tdS: React.CSSProperties = { padding: "6px 8px", fontSize: 12, borderBottom: "1px solid #f3f4f6", verticalAlign: "middle" };

function emptyItemForm(): ProductFormRow {
  return { productName: "", packageCount: "1", quantityPerBox: "1", lengthCm: "", widthCm: "", heightCm: "", unitWeightKg: "", material: "", cargoValue: "", cargoType: "normal" };
}

function calcItem(item: ProductFormRow) {
  const pkg = Number(item.packageCount) || 1;
  const qpb = Number(item.quantityPerBox) || 1;
  const totalQty = pkg * qpb;
  const uWeight = Number(item.unitWeightKg) || 0;
  const totalWeight = uWeight * totalQty;
  const len = Number(item.lengthCm) || 0;
  const wid = Number(item.widthCm) || 0;
  const hgt = Number(item.heightCm) || 0;
  const vol = len > 0 && wid > 0 && hgt > 0 ? (len * wid * hgt) / 1000000 * pkg : 0;
  return { totalQty, totalWeight, vol };
}

// ============================================================================
// 主页面
// ============================================================================
export default function ClientWhrConsolidationPage() {
  const [plans, setPlans] = useState<MyPlan[]>([]);
  const [detail, setDetail] = useState<MyDetail | null>(null);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [toast, setToast] = useState("");

  // 预览
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  // 预报单展开
  const [expandedPrealert, setExpandedPrealert] = useState<string | null>(null);

  // 创建预报单
  const [showCreatePrealert, setShowCreatePrealert] = useState(false);
  const [newMark, setNewMark] = useState("");
  const [newExpressNo, setNewExpressNo] = useState("");
  const [createPSubmitting, setCreatePSubmitting] = useState(false);

  // 货品编辑弹窗（多行模式）
  const [showItemForm, setShowItemForm] = useState(false);
  const [itemForms, setItemForms] = useState<ProductFormRow[]>([emptyItemForm()]);
  const [itemSubmitting, setItemSubmitting] = useState(false);

  // 删除确认
  const [deleteTarget, setDeleteTarget] = useState<{ prealertId: string; itemIdx: number } | null>(null);

  // 地址编辑
  const [editAddress, setEditAddress] = useState(false);
  const [addressVal, setAddressVal] = useState("");
  const [addressSaving, setAddressSaving] = useState(false);

  // 付款上传
  const [showPay, setShowPay] = useState(false);
  const [payProofs, setPayProofs] = useState<{ fileName: string; mime: string; base64: string }[]>([]);
  const [paySubmitting, setPaySubmitting] = useState(false);

  // ==========================================================================
  // 数据加载
  // ==========================================================================
  const loadPlans = useCallback(async () => {
    setLoading(true);
    try {
      const data = await parseApiResponse<{ items: MyPlan[] }>(
        await fetch(`${apiBaseUrl()}/client/whr-consolidation/plans`, { headers: authHeaders() })
      );
      setPlans(data.items ?? []);
    } catch (e: any) { setToast(e?.message ?? "加载计划列表失败"); }
    finally { setLoading(false); }
  }, []);

  const loadDetail = useCallback(async (planId: string) => {
    setDetailLoading(true);
    try {
      const data = await parseApiResponse<MyDetail>(
        await fetch(`${apiBaseUrl()}/client/whr-consolidation/my-detail?planId=${encodeURIComponent(planId)}`, { headers: authHeaders() })
      );
      setDetail(data);
    } catch (e: any) { setToast(e?.message ?? "加载详情失败"); }
    finally { setDetailLoading(false); }
  }, []);

  useEffect(() => { loadPlans(); }, [loadPlans]);

  // ==========================================================================
  // 操作：创建预报单
  // ==========================================================================
  const handleCreatePrealert = async () => {
    if (!selectedPlanId || !newMark.trim()) { setToast("请填写唛头"); return; }
    setCreatePSubmitting(true);
    try {
      const newPrealert = await parseApiResponse<{ id: string; trackingNo: string }>(
        await fetch(`${apiBaseUrl()}/client/whr-consolidation/prealerts`, {
          method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ planId: selectedPlanId, mark: newMark.trim(), expressNo: newExpressNo.trim() || undefined }),
        })
      );
      setToast(`预报单 ${newPrealert.trackingNo} 创建成功`);
      setShowCreatePrealert(false); setNewMark(""); setNewExpressNo("");
      // 先设 expandedPrealert，再 loadDetail，保证刷新后自动展开
      const newId = newPrealert.id;
      setExpandedPrealert(newId);
      loadDetail(selectedPlanId); loadPlans();
    } catch (e: any) { setToast(e?.message ?? "创建失败"); }
    finally { setCreatePSubmitting(false); }
  };

  // ==========================================================================
  // 操作：保存货品（覆盖式）
  // ==========================================================================
  const handleSaveItems = async (prealertId: string, rows: ProductFormRow[]) => {
    if (!selectedPlanId) return;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r.productName.trim()) { setToast(`第${i + 1}行品名为必填`); return; }
      if (!r.packageCount || Number(r.packageCount) <= 0) { setToast(`第${i + 1}行件数必须大于0`); return; }
      if (!r.material.trim()) { setToast(`第${i + 1}行材质为必填`); return; }
      if (!r.cargoValue.trim()) { setToast(`第${i + 1}行货值为必填`); return; }
    }
    setItemSubmitting(true);
    try {
      await parseApiResponse<any>(
        await fetch(`${apiBaseUrl()}/client/whr-consolidation/prealerts/items`, {
          method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            planId: selectedPlanId, prealertId,
            items: rows.map(r => ({
              productName: r.productName.trim(), packageCount: Number(r.packageCount),
              quantityPerBox: Number(r.quantityPerBox) || 1,
              lengthCm: r.lengthCm ? Number(r.lengthCm) : undefined,
              widthCm: r.widthCm ? Number(r.widthCm) : undefined,
              heightCm: r.heightCm ? Number(r.heightCm) : undefined,
              unitWeightKg: r.unitWeightKg ? Number(r.unitWeightKg) : undefined,
              material: r.material.trim(), cargoValue: r.cargoValue.trim(),
              cargoType: r.cargoType || "normal",
              imageFileName: r.imageFile?.fileName, imageMime: r.imageFile?.mime, imageBase64: r.imageFile?.base64,
            })),
          }),
        })
      );
      setToast("货品保存成功");
      setShowItemForm(false); setItemForms([emptyItemForm()]);
      loadDetail(selectedPlanId); loadPlans();
    } catch (e: any) { setToast(e?.message ?? "保存失败"); }
    finally { setItemSubmitting(false); }
  };

  // ==========================================================================
  // 操作：保存收货地址
  // ==========================================================================
  const handleSaveAddress = async () => {
    if (!selectedPlanId || !detail) return;
    setAddressSaving(true);
    try {
      await parseApiResponse<any>(
        await fetch(`${apiBaseUrl()}/client/whr-consolidation/address`, {
          method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ planId: selectedPlanId, deliveryAddress: addressVal.trim() }),
        })
      );
      setToast("地址已保存");
      setEditAddress(false);
      loadDetail(selectedPlanId);
    } catch (e: any) { setToast(e?.message ?? "保存失败"); }
    finally { setAddressSaving(false); }
  };

  // ==========================================================================
  // 操作：上传付款
  // ==========================================================================
  const handlePay = async () => {
    if (!selectedPlanId || payProofs.length === 0) { setToast("请选择付款凭证"); return; }
    setPaySubmitting(true);
    try {
      await parseApiResponse<any>(
        await fetch(`${apiBaseUrl()}/client/whr-consolidation/pay`, {
          method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ planId: selectedPlanId, proofs: payProofs }),
        })
      );
      setToast("付款凭证已提交，等待审核");
      setShowPay(false); setPayProofs([]);
      loadDetail(selectedPlanId); loadPlans();
    } catch (e: any) { setToast(e?.message ?? "提交失败"); }
    finally { setPaySubmitting(false); }
  };

  // ==========================================================================
  // 渲染
  // ==========================================================================
  return (
    <RoleShell allowedRole="client" title="集货拼柜（仓库版）">
      <div style={{ maxWidth: "100%", padding: "20px 24px" }}>
        {/* Toast */}
        {toast && (
          <div onClick={() => setToast("")} style={{ cursor: "pointer", marginBottom: 16, padding: "10px 16px", background: "#fef3c7", color: "#92400e", borderRadius: 8, fontSize: 14 }}>{toast}</div>
        )}

        {/* ================================================================ */}
        {/* 计划列表 */}
        {/* ================================================================ */}
        <h3 style={{ fontSize: 17, marginBottom: 16 }}>我的拼柜计划</h3>
        {loading ? <p style={{ color: "#9ca3af", fontSize: 14 }}>加载中...</p> :
         plans.length === 0 ? <p style={{ color: "#9ca3af", fontSize: 14 }}>暂无参与的拼柜计划</p> :
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginBottom: 20 }}>
            <thead><tr style={{ background: "#f9fafb" }}>
              <th style={thS}>计划编号</th><th style={thS}>仓库</th><th style={thS}>柜型</th><th style={thS}>目的地</th>
              <th style={thS}>方数 (已用/总)</th><th style={thS}>状态</th><th style={thS}>单价</th>
            </tr></thead>
            <tbody>
              {plans.map(p => {
                const isSelected = selectedPlanId === p.planId;
                const usedPct = p.totalVolumeM3 > 0 ? Math.round((p.usedVolumeM3 / p.totalVolumeM3) * 100) : 0;
                const barColor = usedPct >= 100 ? "#10b981" : usedPct >= 85 ? "#f59e0b" : "#2563eb";
                return (
                  <tr key={p.planId} onClick={() => {
                    if (isSelected) { setSelectedPlanId(null); setDetail(null); }
                    else { setSelectedPlanId(p.planId); loadDetail(p.planId); }
                  }} style={{ cursor: "pointer", background: isSelected ? "#eff6ff" : "white" }}
                    onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = "#f9fafb"; }}
                    onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = "white"; }}>
                    <td style={{ ...tdS, fontWeight: 600, minWidth: 120, whiteSpace: "nowrap" }}>{p.planNo}</td>
                    <td style={tdS}>{p.warehouse}</td>
                    <td style={tdS}>{p.containerType}</td>
                    <td style={tdS}>{p.destinationTh}</td>
                    <td style={tdS}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <div style={{ flex: 1, height: 8, background: "#e5e7eb", borderRadius: 4, overflow: "hidden", minWidth: 80 }}>
                          <div style={{ height: "100%", width: `${Math.min(usedPct, 100)}%`, background: barColor, borderRadius: 4, transition: "width 0.3s" }} />
                        </div>
                        <span style={{ fontSize: 12, whiteSpace: "nowrap" }}>{p.usedVolumeM3} / {p.totalVolumeM3} 方</span>
                      </div>
                    </td>
                    <td style={tdS}>
                      <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 4, background: ST_TAG[p.myStatus]?.bg ?? "#e5e7eb", color: ST_TAG[p.myStatus]?.color ?? "#374151" }}>
                        {STATUS_ZH[p.myStatus] ?? p.myStatus}
                      </span>
                      {p.myCancelReason && <div style={{ fontSize: 11, color: "#ef4444", marginTop: 2 }}>{p.myCancelReason}</div>}
                    </td>
                    <td style={tdS}>普:{p.myUnitPriceNormal} 商:{p.myUnitPriceInspection} 敏:{p.myUnitPriceSensitive}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        }

        {/* ================================================================ */}
        {/* 详情区域 */}
        {/* ================================================================ */}
        {selectedPlanId && (
          detailLoading ? <p style={{ color: "#9ca3af", fontSize: 14 }}>加载中...</p> :
          !detail ? <p style={{ color: "#9ca3af", fontSize: 14 }}>加载失败</p> :
          <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: "20px 24px", background: "#f9fafb" }}>
            {/* 大号费用（待付款及之后） */}
            {detail.status !== "filling" && detail.status !== "cancelled" && detail.totalFee != null && (() => {
              const allItems = detail.prealerts.flatMap(pa => pa.items);
              const volNormal = allItems.filter(it => it.cargoType !== "inspection" && it.cargoType !== "sensitive").reduce((s, it) => s + (it.volumeM3 ?? 0), 0);
              const volInspection = allItems.filter(it => it.cargoType === "inspection").reduce((s, it) => s + (it.volumeM3 ?? 0), 0);
              const volSensitive = allItems.filter(it => it.cargoType === "sensitive").reduce((s, it) => s + (it.volumeM3 ?? 0), 0);
              const feeNormal = Math.round(volNormal * detail.unitPriceNormal * 100) / 100;
              const feeInspection = Math.round(volInspection * detail.unitPriceInspection * 100) / 100;
              const feeSensitive = Math.round(volSensitive * detail.unitPriceSensitive * 100) / 100;
              return (
                <div style={{ textAlign: "left", padding: "16px 0", marginBottom: 16, borderBottom: "1px solid #e5e7eb" }}>
                  <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 8 }}>应付费用明细</div>
                  {volNormal > 0 && <div style={{ fontSize: 13, color: "#374151", marginBottom: 4 }}>普货：{volNormal.toFixed(3)} 方 × {detail.unitPriceNormal} 元/方 = <strong>¥{feeNormal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong></div>}
                  {volInspection > 0 && <div style={{ fontSize: 13, color: "#374151", marginBottom: 4 }}>商检：{volInspection.toFixed(3)} 方 × {detail.unitPriceInspection} 元/方 = <strong>¥{feeInspection.toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong></div>}
                  {volSensitive > 0 && <div style={{ fontSize: 13, color: "#374151", marginBottom: 4 }}>敏感：{volSensitive.toFixed(3)} 方 × {detail.unitPriceSensitive} 元/方 = <strong>¥{feeSensitive.toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong></div>}
                  <div style={{ borderTop: "1px solid #d1d5db", marginTop: 8, paddingTop: 8 }}>
                    <div style={{ fontSize: 20, fontWeight: 700, color: "#059669" }}>合计：¥{detail.totalFee.toLocaleString()}</div>
                  </div>
                </div>
              );
            })()}

            {/* 已取消 */}
            {detail.status === "cancelled" && (
              <div style={{ textAlign: "center", padding: "16px 0", marginBottom: 16, background: "#fee2e2", borderRadius: 8, color: "#991b1b", fontSize: 14, fontWeight: 600 }}>
                该计划已被取消
                {detail.cancelReason && <div style={{ fontSize: 12, fontWeight: 400, marginTop: 4 }}>{detail.cancelReason}</div>}
              </div>
            )}

            {/* ====== 泰国收货地址 ====== */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>泰国收货地址</span>
                {(detail.status === "filling" || detail.status === "received_pending_payment") && !editAddress && (
                  <button onClick={() => { setAddressVal(detail.deliveryAddress ?? ""); setEditAddress(true); }} style={{ ...btnGray, padding: "3px 10px", fontSize: 12 }}>编辑</button>
                )}
              </div>
              {editAddress ? (
                <div style={{ display: "flex", gap: 8 }}>
                  <input value={addressVal} onChange={e => setAddressVal(e.target.value)} placeholder="请输入泰国收货地址" style={{ ...fi, flex: 1 }} />
                  <button onClick={handleSaveAddress} disabled={addressSaving} style={btnBlue}>{addressSaving ? "保存中" : "保存"}</button>
                  <button onClick={() => setEditAddress(false)} style={btnGray}>取消</button>
                </div>
              ) : (
                <p style={{ fontSize: 13, color: detail.deliveryAddress ? "#374151" : "#9ca3af", margin: 0 }}>
                  {detail.deliveryAddress || "未填写"}
                </p>
              )}
            </div>

            {/* ====== 预报单 + 货品 ====== */}
            {(detail.status === "filling" || detail.status === "received_pending_payment") && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>预报单（{detail.totalPrealerts}）</span>
                  <button onClick={() => { setShowCreatePrealert(true); }} style={btnBlue}>+ 新建预报单</button>
                </div>
              </div>
            )}

            {/* 预报单列表（所有状态都展示） */}
            {detail.prealerts.length === 0 && detail.status === "filling" && (
              <p style={{ color: "#9ca3af", fontSize: 13, marginBottom: 16 }}>暂无预报单，请新建</p>
            )}
            {detail.prealerts.length === 0 && detail.status !== "filling" && (
              <p style={{ color: "#9ca3af", fontSize: 13, marginBottom: 16 }}>无预报单</p>
            )}

            {detail.prealerts.map(pa => {
              const paItems = pa.items ?? [];
              const paPkg = paItems.reduce((s: number, it: any) => s + it.packageCount, 0);
              const paVol = paItems.reduce((s: number, it: any) => s + (it.volumeM3 ?? 0), 0);
              const isEditing = detail.status === "filling" || detail.status === "received_pending_payment";
              return (
                <div key={pa.id} style={{ border: "1px solid #e5e7eb", borderRadius: 8, marginBottom: 10, overflow: "hidden", background: "white" }}>
                  {/* 预报单信息栏 */}
                  <div style={{ padding: "8px 14px", background: "#f9fafb", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <strong style={{ fontSize: 14, minWidth: 100, whiteSpace: "nowrap" }}>{pa.trackingNo}</strong>
                      <span style={{ fontSize: 13, color: "#374151" }}>{pa.mark}</span>
                      {pa.expressNo && <span style={{ fontSize: 12, color: "#9ca3af" }}>快递: {pa.expressNo}</span>}
                      <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 4, background: pa.status === "received" ? "#d1fae5" : "#fef3c7", color: pa.status === "received" ? "#065f46" : "#92400e" }}>
                        {STATUS_ZH[pa.status] ?? pa.status}
                      </span>
                    </div>
                    <span style={{ fontSize: 12, color: "#6b7280" }}>{paPkg}件 · {paVol.toFixed(3)}方</span>
                  </div>
                  {/* 货品横排表格 */}
                  {paItems.length > 0 ? (
                    <div style={{ overflowX: "auto", padding: "6px 14px 10px" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                        <thead><tr style={{ background: "#f3f4f6" }}>
                          <th style={{ ...thS, padding: "3px 6px", fontSize: 11, minWidth: 70 }}>品名</th>
                          <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>件数</th>
                          <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>每箱</th>
                          <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>总数</th>
                          <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>单重</th>
                          <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>总重</th>
                          <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>长</th>
                          <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>宽</th>
                          <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>高</th>
                          <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>方数</th>
                          <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>材质</th>
                          <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>货值</th>
                          <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>类型</th>
                          <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>图片</th>
                          {isEditing && <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>操作</th>}
                        </tr></thead>
                        <tbody>
                          {paItems.map((it: any, i: number) => (
                            <tr key={it.id ?? i}>
                              <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.productName}</td>
                              <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.packageCount}</td>
                              <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.quantityPerBox}</td>
                              <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.totalQuantity}</td>
                              <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.unitWeightKg ?? "-"}</td>
                              <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.totalWeightKg ?? "-"}</td>
                              <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.lengthCm ?? "-"}</td>
                              <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.widthCm ?? "-"}</td>
                              <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.heightCm ?? "-"}</td>
                              <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.volumeM3 != null ? it.volumeM3.toFixed(4) : "-"}</td>
                              <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.material}</td>
                              <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.cargoValue}</td>
                              <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>{it.cargoType === "inspection" ? "商检" : it.cargoType === "sensitive" ? "敏感" : "普货"}</td>
                              <td style={{ ...tdS, padding: "3px 6px", fontSize: 11 }}>
                                {it.productImageBase64
                                  ? <button onClick={() => setPreviewImage(it.productImageBase64)} style={{ ...btnGray, padding: "2px 8px", fontSize: 11 }}>查看图片</button>
                                  : <span style={{ color: "#d1d5db" }}>—</span>}
                              </td>
                              {isEditing && (
                                <td style={{ ...tdS, padding: "3px 6px", fontSize: 11, whiteSpace: "nowrap" }}>
                                  <button onClick={() => {
                                    const allRows: ProductFormRow[] = paItems.map((it2: any) => ({
                                      productName: it2.productName, packageCount: String(it2.packageCount),
                                      quantityPerBox: String(it2.quantityPerBox), lengthCm: String(it2.lengthCm ?? ""),
                                      widthCm: String(it2.widthCm ?? ""), heightCm: String(it2.heightCm ?? ""),
                                      unitWeightKg: String(it2.unitWeightKg ?? ""), material: it2.material,
                                      cargoValue: it2.cargoValue, cargoType: it2.cargoType,
                                      existingImageBase64: it2.productImageBase64 || undefined,
                                    }));
                                    setItemForms(allRows);
                                    setShowItemForm(true);
                                  }} style={{ ...btnGray, padding: "2px 8px", fontSize: 11, marginRight: 4 }}>编辑</button>
                                  <button onClick={() => setDeleteTarget({ prealertId: pa.id, itemIdx: i })} style={{ ...btnDanger, padding: "2px 8px", fontSize: 11 }}>删除</button>
                                </td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div style={{ padding: "10px 14px" }}>
                      <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>暂无货品</p>
                    </div>
                  )}
                  {/* 添加货品按钮 */}
                  {isEditing && (
                    <div style={{ padding: "6px 14px 10px" }}>
                      <button onClick={() => { setItemForms([emptyItemForm()]); setShowItemForm(true); }} style={btnBlue}>+ 添加货品</button>
                    </div>
                  )}
                </div>
              );
            })}

            {/* ====== 付款凭证上传 ====== */}
            {detail.status === "received_pending_payment" && (
              <div style={{ marginTop: 16, padding: "14px 16px", background: "#fef3c7", borderRadius: 8 }}>
                {(detail.paymentProofs?.length ?? 0) > 0 ? (
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#92400e", marginBottom: 6 }}>已提交 {detail.paymentProofs.length} 张付款凭证，等待审核</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {detail.paymentProofs.map((p, i) => (
                        <img key={i} src={p.base64Path} alt={`付款凭证 ${i + 1}`} onClick={() => setPreviewImage(p.base64Path)} style={{ width: 100, height: 100, objectFit: "cover", borderRadius: 6, border: "1px solid #e5e7eb", cursor: "pointer" }} />
                      ))}
                    </div>
                    {detail.paymentRejectReason && (
                      <div style={{ fontSize: 12, color: "#ef4444", marginTop: 6 }}>拒绝原因：{detail.paymentRejectReason}<br />请重新上传。</div>
                    )}
                    <button onClick={() => setShowPay(true)} style={{ ...btnBlue, marginTop: 8 }}>重新上传</button>
                  </div>
                ) : (
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 13, color: "#92400e", marginBottom: 8 }}>请上传付款凭证以完成付款</div>
                    <button onClick={() => setShowPay(true)} style={btnBlue}>上传付款凭证</button>
                  </div>
                )}
              </div>
            )}

            {/* ====== 泰国签收单 ====== */}
            {detail.status === "thailand_received" && detail.thailandReceiptBase64 && (
              <div style={{ marginTop: 16, padding: "14px 16px", background: "#d1fae5", borderRadius: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#065f46", marginBottom: 6 }}>泰国已签收</div>
                <img src={detail.thailandReceiptBase64} alt="泰国签收单" style={{ maxWidth: "100%", maxHeight: 250, borderRadius: 6, border: "1px solid #e5e7eb", cursor: "pointer" }} onClick={() => setPreviewImage(detail.thailandReceiptBase64)} />
                {detail.thailandReceiptFileName && <div style={{ fontSize: 12, color: "#065f46", marginTop: 4 }}>{detail.thailandReceiptFileName}</div>}
                <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>签收时间：{formatBeijingTime(detail.thailandReceivedAt)}</div>
              </div>
            )}

            {/* ====== 状态时间线 ====== */}
            {detail.statusLogs.length > 0 && (
              <div style={{ marginTop: 20 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#374151", marginBottom: 10 }}>状态时间线</div>
                {detail.statusLogs.map(sl => (
                  <div key={sl.id} style={{ fontSize: 12, color: "#6b7280", marginBottom: 6, paddingLeft: 10, borderLeft: "2px solid #e5e7eb" }}>
                    <strong style={{ color: "#374151" }}>{STATUS_ZH[sl.fromStatus] ?? sl.fromStatus}</strong> → <strong style={{ color: "#374151" }}>{STATUS_ZH[sl.toStatus] ?? sl.toStatus}</strong>
                    &nbsp;· {sl.operatorName} · {formatBeijingTime(sl.createdAt)}
                    {sl.remark && <div style={{ color: "#9ca3af", marginTop: 2 }}>{sl.remark}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ================================================================ */}
        {/* 弹窗：新建预报单 */}
        {/* ================================================================ */}
        {showCreatePrealert && (
          <Modal onClose={() => setShowCreatePrealert(false)}>
            <h3 style={{ marginTop: 0 }}>新建预报单</h3>
            <div style={{ display: "grid", gap: 10 }}>
              <div><label style={fl}>唛头 *</label><input value={newMark} onChange={e => setNewMark(e.target.value)} placeholder="必填" style={fi} /></div>
              <div><label style={fl}>快递单号（可选）</label><input value={newExpressNo} onChange={e => setNewExpressNo(e.target.value)} placeholder="可选" style={fi} /></div>
            </div>
            <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
              <button onClick={handleCreatePrealert} disabled={createPSubmitting} style={btnBlue}>{createPSubmitting ? "创建中..." : "确认创建"}</button>
              <button onClick={() => setShowCreatePrealert(false)} style={btnGray}>取消</button>
            </div>
          </Modal>
        )}

        {/* ================================================================ */}
        {/* 弹窗：货品表单（多行）
        {/* ================================================================ */}
        {showItemForm && expandedPrealert && (() => {
          const prealertItems = detail?.prealerts.find(p => p.id === expandedPrealert)?.items ?? [];
          return (
          <Modal wide onClose={() => { setShowItemForm(false); setItemForms([emptyItemForm()]); }}>
            <h3 style={{ marginTop: 0 }}>编辑货品</h3>
            <div style={{ overflowX: "auto", maxHeight: "50vh", overflowY: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                <thead><tr style={{ background: "#f3f4f6", position: "sticky", top: 0 }}>
                  <th style={{ ...thS, padding: "4px 6px", fontSize: 11, minWidth: 70 }}>品名 *</th>
                  <th style={{ ...thS, padding: "4px 6px", fontSize: 11, minWidth: 50 }}>件数 *</th>
                  <th style={{ ...thS, padding: "4px 6px", fontSize: 11, minWidth: 50 }}>每箱数量</th>
                  <th style={{ ...thS, padding: "4px 6px", fontSize: 11, minWidth: 50 }}>单件重</th>
                  <th style={{ ...thS, padding: "4px 6px", fontSize: 11, minWidth: 50 }}>长cm</th>
                  <th style={{ ...thS, padding: "4px 6px", fontSize: 11, minWidth: 50 }}>宽cm</th>
                  <th style={{ ...thS, padding: "4px 6px", fontSize: 11, minWidth: 50 }}>高cm</th>
                  <th style={{ ...thS, padding: "4px 6px", fontSize: 11, minWidth: 60 }}>材质 *</th>
                  <th style={{ ...thS, padding: "4px 6px", fontSize: 11, minWidth: 60 }}>货值 *</th>
                  <th style={{ ...thS, padding: "4px 6px", fontSize: 11, minWidth: 55 }}>类型</th>
                  <th style={{ ...thS, padding: "4px 6px", fontSize: 11, minWidth: 60 }}>图片</th>
                  <th style={{ ...thS, padding: "4px 6px", fontSize: 11, minWidth: 65 }}>自动算</th>
                  <th style={{ ...thS, padding: "4px 6px", fontSize: 11, minWidth: 40 }}>删</th>
                </tr></thead>
                <tbody>
                  {itemForms.map((rf, i) => {
                    const c = calcItem(rf);
                    return (
                      <tr key={i}>
                        <td style={{ ...tdS, padding: "3px 4px" }}><input value={rf.productName} onChange={e => { const copy = [...itemForms]; copy[i] = { ...copy[i], productName: e.target.value }; setItemForms(copy); }} style={{ ...fi, padding: "3px 5px", fontSize: 11 }} placeholder="品名" /></td>
                        <td style={{ ...tdS, padding: "3px 4px" }}><input type="number" value={rf.packageCount} onChange={e => { const copy = [...itemForms]; copy[i] = { ...copy[i], packageCount: e.target.value }; setItemForms(copy); }} style={{ ...fi, padding: "3px 5px", fontSize: 11, width: 52 }} /></td>
                        <td style={{ ...tdS, padding: "3px 4px" }}><input type="number" value={rf.quantityPerBox} onChange={e => { const copy = [...itemForms]; copy[i] = { ...copy[i], quantityPerBox: e.target.value }; setItemForms(copy); }} style={{ ...fi, padding: "3px 5px", fontSize: 11, width: 52 }} /></td>
                        <td style={{ ...tdS, padding: "3px 4px" }}><input type="number" value={rf.unitWeightKg} onChange={e => { const copy = [...itemForms]; copy[i] = { ...copy[i], unitWeightKg: e.target.value }; setItemForms(copy); }} style={{ ...fi, padding: "3px 5px", fontSize: 11, width: 52 }} /></td>
                        <td style={{ ...tdS, padding: "3px 4px" }}><input type="number" value={rf.lengthCm} onChange={e => { const copy = [...itemForms]; copy[i] = { ...copy[i], lengthCm: e.target.value }; setItemForms(copy); }} style={{ ...fi, padding: "3px 5px", fontSize: 11, width: 48 }} /></td>
                        <td style={{ ...tdS, padding: "3px 4px" }}><input type="number" value={rf.widthCm} onChange={e => { const copy = [...itemForms]; copy[i] = { ...copy[i], widthCm: e.target.value }; setItemForms(copy); }} style={{ ...fi, padding: "3px 5px", fontSize: 11, width: 48 }} /></td>
                        <td style={{ ...tdS, padding: "3px 4px" }}><input type="number" value={rf.heightCm} onChange={e => { const copy = [...itemForms]; copy[i] = { ...copy[i], heightCm: e.target.value }; setItemForms(copy); }} style={{ ...fi, padding: "3px 5px", fontSize: 11, width: 48 }} /></td>
                        <td style={{ ...tdS, padding: "3px 4px" }}><input value={rf.material} onChange={e => { const copy = [...itemForms]; copy[i] = { ...copy[i], material: e.target.value }; setItemForms(copy); }} style={{ ...fi, padding: "3px 5px", fontSize: 11, width: 56 }} placeholder="材质" /></td>
                        <td style={{ ...tdS, padding: "3px 4px" }}><input value={rf.cargoValue} onChange={e => { const copy = [...itemForms]; copy[i] = { ...copy[i], cargoValue: e.target.value }; setItemForms(copy); }} style={{ ...fi, padding: "3px 5px", fontSize: 11, width: 56 }} placeholder="货值" /></td>
                        <td style={{ ...tdS, padding: "3px 4px" }}>
                          <select value={rf.cargoType} onChange={e => { const copy = [...itemForms]; copy[i] = { ...copy[i], cargoType: e.target.value }; setItemForms(copy); }} style={{ ...fi, padding: "3px 5px", fontSize: 10, width: 56 }}>
                            <option value="normal">普货</option><option value="inspection">商检</option><option value="sensitive">敏感</option>
                          </select>
                        </td>
                        <td style={{ ...tdS, padding: "3px 4px" }}>
                          {rf.imageFile ? (
                            <span style={{ fontSize: 10, color: "#10b981" }}>✓</span>
                          ) : rf.existingImageBase64 ? (
                            <img src={rf.existingImageBase64} alt="产品图片" style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 4, border: "1px solid #e5e7eb", cursor: "pointer" }} onClick={() => setPreviewImage(rf.existingImageBase64!)} />
                          ) : null}
                          <input type="file" accept="image/*" onChange={async e => {
                            const file = e.target.files?.[0]; if (!file) return;
                            const base64 = await new Promise<string>(r => { const fr = new FileReader(); fr.onload = () => r((fr.result as string).split(",")[1]); fr.readAsDataURL(file); });
                            const copy = [...itemForms]; copy[i] = { ...copy[i], imageFile: { fileName: file.name, mime: file.type, base64 }, existingImageBase64: undefined }; setItemForms(copy);
                          }} style={{ fontSize: 10, width: 60 }} />
                        </td>
                        <td style={{ ...tdS, padding: "3px 4px", fontSize: 10, color: "#059669" }}>
                          总{c.totalQty}件{c.totalWeight > 0 ? ` ${c.totalWeight.toFixed(1)}kg` : ""}{c.vol > 0 ? ` ${c.vol.toFixed(3)}m³` : ""}
                        </td>
                        <td style={{ ...tdS, padding: "3px 4px" }}>
                          <button onClick={() => { setItemForms(itemForms.filter((_, j) => j !== i)); }} style={{ ...btnDanger, padding: "2px 6px", fontSize: 10 }}>×</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <button onClick={() => setItemForms([...itemForms, emptyItemForm()])} style={{ ...btnBlue, marginTop: 8, padding: "5px 14px", fontSize: 12 }}>+ 添加一行</button>
            <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
              <button onClick={() => handleSaveItems(expandedPrealert!, itemForms)} disabled={itemSubmitting} style={btnBlue}>{itemSubmitting ? "保存中..." : "确认保存"}</button>
              <button onClick={() => { setShowItemForm(false); setItemForms([emptyItemForm()]); }} style={btnGray}>取消</button>
            </div>
          </Modal>
        );
        })()}

        {/* ================================================================ */}
        {/* 弹窗：付款上传 */}
        {/* ================================================================ */}
        {showPay && (
          <Modal onClose={() => { setShowPay(false); setPayProofs([]); }}>
            <h3 style={{ marginTop: 0 }}>上传付款凭证</h3>
            {detail?.totalFee != null && <div style={{ fontSize: 18, fontWeight: 700, color: "#059669", marginBottom: 10 }}>¥{detail.totalFee.toLocaleString()}</div>}
            <div style={{ marginBottom: 10 }}>
              <label style={fl}>添加付款截图</label>
              <input type="file" accept="image/*" multiple onChange={async e => {
                const files = Array.from(e.target.files || []);
                if (!files.length) return;
                const newProofs = await Promise.all(files.map(async file => {
                  const base64 = await new Promise<string>(r => { const fr = new FileReader(); fr.onload = () => r((fr.result as string).split(",")[1]); fr.readAsDataURL(file); });
                  return { fileName: file.name, mime: file.type, base64 };
                }));
                setPayProofs([...payProofs, ...newProofs]);
              }} />
            </div>
            {payProofs.length > 0 && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10, maxHeight: 160, overflowY: "auto" }}>
                {payProofs.map((p, i) => (
                  <div key={i} style={{ position: "relative", width: 80, height: 80, flexShrink: 0 }}>
                    <img src={`data:image/png;base64,${p.base64}`} alt={`凭证 ${i + 1}`} style={{ width: 80, height: 80, objectFit: "cover", borderRadius: 4, border: "1px solid #e5e7eb" }} />
                    <button onClick={() => setPayProofs(payProofs.filter((_, j) => j !== i))} style={{ position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: "50%", background: "#ef4444", color: "#fff", border: "none", cursor: "pointer", fontSize: 12, lineHeight: "20px", textAlign: "center", padding: 0 }}>×</button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 10 }}>{payProofs.length} 张图片已选</div>
            <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
              <button onClick={handlePay} disabled={paySubmitting || payProofs.length === 0} style={{ ...btnBlue, opacity: payProofs.length === 0 ? 0.5 : 1, cursor: payProofs.length === 0 ? "not-allowed" : "pointer" }}>
                {paySubmitting ? "提交中..." : "确认提交"}
              </button>
              <button onClick={() => { setShowPay(false); setPayProofs([]); }} style={btnGray}>取消</button>
            </div>
          </Modal>
        )}

        {/* ================================================================ */}
        {/* 弹窗：删除确认 */}
        {/* ================================================================ */}
        {deleteTarget && expandedPrealert && (
          <Modal onClose={() => setDeleteTarget(null)}>
            <p style={{ marginTop: 0 }}>确定删除该货品吗？</p>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => {
                const items = detail?.prealerts.find(p => p.id === expandedPrealert)?.items ?? [];
                const filtered = items.filter((_, i) => i !== deleteTarget.itemIdx).map(it => ({
                  productName: it.productName, packageCount: String(it.packageCount), quantityPerBox: String(it.quantityPerBox), lengthCm: String(it.lengthCm ?? ""), widthCm: String(it.widthCm ?? ""), heightCm: String(it.heightCm ?? ""), unitWeightKg: String(it.unitWeightKg ?? ""), material: it.material, cargoValue: it.cargoValue, cargoType: it.cargoType,
                }));
                setDeleteTarget(null);
                handleSaveItems(expandedPrealert!, filtered);
              }} style={btnDanger}>确认删除</button>
              <button onClick={() => setDeleteTarget(null)} style={btnGray}>取消</button>
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
      <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, padding: 24, maxWidth: wide ? 700 : 480, width: "90vw", maxHeight: "85vh", overflowY: "auto", boxShadow: "0 8px 30px rgba(0,0,0,0.15)" }}>
        {children}
      </div>
    </div>
  );
}
