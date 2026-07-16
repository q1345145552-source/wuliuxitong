"use client";

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import RoleShell from "../../../modules/layout/RoleShell";
import {
  fetchAdminConsolidationTasks,
  fetchStaffConsolidationTaskDetail,
  deleteAdminConsolidationTask,
  adminForceEditConsolidationPrealert,
  adminDeleteConsolidationPrealert,
  reviewConsolidationPayment,
  rejectConsolidationPayment,
  type ConsolidationTaskItem,
  type ConsolidationPrealertItem,
  type ConsolidationProductItem,
} from "../../../services/business-api";
import { formatBeijingTime } from "../../../modules/staff/utils";

// ============================================================================
// 状态中文
// ============================================================================
const STATUS_ZH: Record<string, string> = {
  collecting: "收集中",
  full_confirmed: "已满待报价",
  quoted: "已报价待付款",
  paid: "已付款",
  pending_review: "待审核",
  loading: "装柜中",
  in_transit: "运输中",
  customs: "清关中",
  delivering: "派送中",
  completed: "已完成",
  cancelled: "已取消",
  pending: "待签收",
  received: "已签收",
};

const ALL_STATUSES = ["collecting", "full_confirmed", "quoted", "paid", "loading", "in_transit", "customs", "delivering", "completed", "cancelled"];

// ============================================================================
// 产品表单行
// ============================================================================
interface ProductFormRow {
  key: number;
  productName: string;
  packageCount: string;
  quantityPerBox: string;
  unitWeightKg: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  material: string;
  cargoValue: string;
  productImage?: { fileName?: string; mime?: string; base64?: string };
}

function emptyProductRow(key: number): ProductFormRow {
  return { key, productName: "", packageCount: "", quantityPerBox: "1", unitWeightKg: "", lengthCm: "", widthCm: "", heightCm: "", material: "", cargoValue: "" };
}

function calcProductRow(r: ProductFormRow) {
  const pkg = parseInt(r.packageCount) || 0;
  const qpb = parseInt(r.quantityPerBox) || 0;
  const totalQty = pkg * qpb;
  const uw = parseFloat(r.unitWeightKg) || 0;
  const totalW = parseFloat((uw * totalQty).toFixed(2));
  const l = parseFloat(r.lengthCm) || 0;
  const w = parseFloat(r.widthCm) || 0;
  const h = parseFloat(r.heightCm) || 0;
  const vol = parseFloat(((l * w * h) / 1_000_000 * pkg).toFixed(6));
  return { totalQty, totalW, vol };
}

// ============================================================================
// 主页面
// ============================================================================
export default function AdminConsolidationPage() {
  const [tasks, setTasks] = useState<ConsolidationTaskItem[]>([]);
  const [taskDetail, setTaskDetail] = useState<ConsolidationTaskItem | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [statusFilter, setStatusFilter] = useState("");
  const [searchText, setSearchText] = useState("");

  const [toast, setToast] = useState("");
  const [deleteTaskId, setDeleteTaskId] = useState<string | null>(null);
  const [deleteTaskSubmitting, setDeleteTaskSubmitting] = useState(false);
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [showRejectDialog, setShowRejectDialog] = useState(false);

  // 管理员编辑预报单
  const [editPrealert, setEditPrealert] = useState<ConsolidationPrealertItem | null>(null);
  const [editMark, setEditMark] = useState("");
  const [editExpressNo, setEditExpressNo] = useState("");
  const [editProductRows, setEditProductRows] = useState<ProductFormRow[]>([]);
  const [editSubmitting, setEditSubmitting] = useState(false);

  // 管理员删除预报单
  const [deletePrealertId, setDeletePrealertId] = useState<string | null>(null);
  const [deletePrealertSubmitting, setDeletePrealertSubmitting] = useState(false);

  // 展开
  const [expandedPrealerts, setExpandedPrealerts] = useState<Set<string>>(new Set());
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  // ======== 数据 ========
  const loadTasks = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchAdminConsolidationTasks(statusFilter || undefined);
      setTasks(data);
    } catch (e: any) { setToast(e.message); } finally { setLoading(false); }
  }, [statusFilter]);

  const loadDetail = useCallback(async (taskId: string) => {
    try {
      const data = await fetchStaffConsolidationTaskDetail(taskId);
      setTaskDetail(data);
    } catch (e: any) { setToast(e.message); }
  }, []);

  useEffect(() => { loadTasks(); }, [loadTasks]);
  useEffect(() => {
    if (selectedTaskId) loadDetail(selectedTaskId);
    else setTaskDetail(null);
  }, [selectedTaskId, loadDetail]);

  const filteredTasks = useMemo(() => {
    let list = tasks;
    if (searchText) {
      const s = searchText.trim().toLowerCase();
      list = list.filter((t) => t.taskNo.toLowerCase().includes(s) || (t.clientName ?? "").toLowerCase().includes(s));
    }
    return list;
  }, [tasks, searchText]);

  // ======== 删除任务 ========
  const handleDeleteTask = async () => {
    const tid = deleteTaskId;
    if (!tid) return;
    setDeleteTaskSubmitting(true);
    try {
      await deleteAdminConsolidationTask(tid);
      setToast("任务已删除");
      setDeleteTaskId(null);
      if (selectedTaskId === tid) setSelectedTaskId(null);
      await loadTasks();
    } catch (e: any) { setToast(e.message); } finally { setDeleteTaskSubmitting(false); }
  };

  const handleApprovePayment = async () => {
    const tid = selectedTaskId;
    if (!tid) return;
    setReviewSubmitting(true);
    try {
      await reviewConsolidationPayment(tid);
      setToast("付款审核通过");
      if (selectedTaskId) await loadDetail(selectedTaskId);
      await loadTasks();
    } catch (e: any) { setToast(e.message); }
    finally { setReviewSubmitting(false); }
  };

  const handleRejectPayment = async () => {
    const tid = selectedTaskId;
    if (!tid) return;
    if (!rejectReason.trim()) { setToast("请填写拒绝原因"); return; }
    setReviewSubmitting(true);
    try {
      await rejectConsolidationPayment(tid, rejectReason.trim());
      setShowRejectDialog(false);
      setRejectReason("");
      setToast("已退回付款");
      if (selectedTaskId) await loadDetail(selectedTaskId);
      await loadTasks();
    } catch (e: any) { setToast(e.message); }
    finally { setReviewSubmitting(false); }
  };

  // ======== 管理员编辑预报单 ========
  const openAdminEdit = (pa: ConsolidationPrealertItem) => {
    setEditPrealert(pa);
    setEditMark(pa.mark);
    setEditExpressNo(pa.expressNo || "");
    setEditProductRows(
      pa.products.map((p, i) => ({
        key: Date.now() + i,
        productName: p.productName,
        packageCount: String(p.packageCount),
        quantityPerBox: String(p.quantityPerBox),
        unitWeightKg: String(p.unitWeight ?? ""),
        lengthCm: String(p.length ?? ""),
        widthCm: String(p.width ?? ""),
        heightCm: String(p.height ?? ""),
        material: p.material,
        cargoValue: p.cargoValue,
      })),
    );
  };

  const handleAdminEditSubmit = async () => {
    if (!editPrealert) return;
    if (!editMark.trim()) { setToast("请输入唛头"); return; }
    for (let i = 0; i < editProductRows.length; i++) {
      const r = editProductRows[i];
      if (!r.productName.trim()) { setToast(`产品行${i + 1}：产品名称为必填`); return; }
      if (!r.packageCount || parseInt(r.packageCount) < 1) { setToast(`产品行${i + 1}：件数必须大于0`); return; }
      if (!r.quantityPerBox || parseInt(r.quantityPerBox) < 1) { setToast(`产品行${i + 1}：装箱数量必须大于0`); return; }
      if (!r.unitWeightKg) { setToast(`产品行${i + 1}：单件重量为必填`); return; }
      if (!r.lengthCm) { setToast(`产品行${i + 1}：长为必填`); return; }
      if (!r.widthCm) { setToast(`产品行${i + 1}：宽为必填`); return; }
      if (!r.heightCm) { setToast(`产品行${i + 1}：高为必填`); return; }
      if (!r.material.trim()) { setToast(`产品行${i + 1}：材质为必填`); return; }
      if (!r.cargoValue.trim()) { setToast(`产品行${i + 1}：货值为必填`); return; }
    }
    setEditSubmitting(true);
    try {
      const products = editProductRows.map((r) => ({
        productName: r.productName.trim(),
        packageCount: parseInt(r.packageCount),
        quantityPerBox: parseInt(r.quantityPerBox),
        unitWeightKg: parseFloat(r.unitWeightKg),
        lengthCm: parseFloat(r.lengthCm),
        widthCm: parseFloat(r.widthCm),
        heightCm: parseFloat(r.heightCm),
        material: r.material.trim(),
        cargoValue: r.cargoValue.trim(),
        productImage: r.productImage,
      }));
      await adminForceEditConsolidationPrealert({ prealertId: editPrealert.id, mark: editMark.trim(), expressNo: editExpressNo.trim() || undefined, products });
      setEditPrealert(null);
      setToast("预报单已更新");
      if (selectedTaskId) await loadDetail(selectedTaskId);
      await loadTasks();
    } catch (e: any) { setToast(e.message); } finally { setEditSubmitting(false); }
  };

  // ======== 管理员删除预报单 ========
  const handleAdminDeletePrealert = async () => {
    const pid = deletePrealertId;
    if (!pid) return;
    setDeletePrealertSubmitting(true);
    try {
      await adminDeleteConsolidationPrealert(pid);
      setDeletePrealertId(null);
      setToast("预报单已删除");
      if (selectedTaskId) await loadDetail(selectedTaskId);
      await loadTasks();
    } catch (e: any) { setToast(e.message); } finally { setDeletePrealertSubmitting(false); }
  };

  const pendingPrealerts = useMemo(() => taskDetail?.prealerts?.filter((p) => p.status === "pending") ?? [], [taskDetail]);
  const receivedPrealerts = useMemo(() => taskDetail?.prealerts?.filter((p) => p.status === "received") ?? [], [taskDetail]);

  const showProgress = taskDetail && !["loading", "in_transit", "customs", "delivering", "completed", "cancelled"].includes(taskDetail.status);

  // ======== 渲染 ========
  return (
    <RoleShell allowedRole="admin" title="集货拼柜管理">
      {toast && (
        <div onClick={() => setToast("")} style={{ position: "fixed", top: 20, right: 20, zIndex: 9999, background: "#1f2937", color: "#fff", padding: "10px 20px", borderRadius: 8, boxShadow: "0 4px 12px rgba(0,0,0,0.3)", cursor: "pointer" }}>
          {toast}
        </div>
      )}
      {previewImage && (
        <div onClick={() => setPreviewImage(null)} style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.8)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <img src={previewImage} style={{ maxWidth: "90vw", maxHeight: "90vh", borderRadius: 8 }} alt="预览" />
        </div>
      )}

      {/* ======== 列表 ======== */}
      {!selectedTaskId && (
        <div style={{ padding: 24 }}>
          <h2 style={{ fontSize: 22, margin: "0 0 16px 0" }}>集货拼柜管理</h2>
          <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13 }}>
              <option value="">全部状态</option>
              {ALL_STATUSES.map((s) => <option key={s} value={s}>{STATUS_ZH[s]}</option>)}
            </select>
            <input placeholder="搜索任务编号 / 客户名" value={searchText} onChange={(e) => setSearchText(e.target.value)} style={{ padding: "6px 12px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13, width: 220 }} />
          </div>
          {loading ? <p style={{ color: "#6b7280" }}>加载中...</p> : filteredTasks.length === 0 ? <p style={{ color: "#9ca3af", textAlign: "center", padding: 40 }}>暂无任务</p> : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "#f3f4f6" }}>
                    <th style={thS}>任务编号</th>
                    <th style={thS}>客户</th>
                    <th style={thS}>目的地</th>
                    <th style={thS}>进度</th>
                    <th style={thS}>状态</th>
                    <th style={thS}>创建时间</th>
                    <th style={thS}></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTasks.map((t) => (
                    <tr key={t.id} style={{ borderBottom: "1px solid #e5e7eb", cursor: "pointer" }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#f9fafb"; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ""; }}>
                      <td onClick={() => setSelectedTaskId(t.id)} style={{ ...tdS, fontWeight: 600, whiteSpace: "nowrap", minWidth: 140 }}>{t.taskNo}</td>
                      <td onClick={() => setSelectedTaskId(t.id)} style={{ ...tdS, minWidth: 80 }}>{t.clientName || "-"}</td>
                      <td onClick={() => setSelectedTaskId(t.id)} style={{ ...tdS, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.destinationTh}</td>
                      <td onClick={() => setSelectedTaskId(t.id)} style={tdS}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <div style={{ flex: 1, height: 6, background: "#e5e7eb", borderRadius: 3, overflow: "hidden", maxWidth: 120 }}>
                            <div style={{ height: "100%", width: `${Math.min(t.volumePercent, 100)}%`, background: t.volumePercent >= 85 ? (t.volumePercent >= 100 ? "#10b981" : "#f59e0b") : "#3b82f6", borderRadius: 3 }} />
                          </div>
                          <span style={{ fontSize: 11, color: "#6b7280", whiteSpace: "nowrap" }}>{t.totalVolumeM3}/{t.maxVolumeM3}</span>
                        </div>
                      </td>
                      <td onClick={() => setSelectedTaskId(t.id)} style={tdS}>
                        <span style={{ fontSize: 11, padding: "2px 6px", borderRadius: 4, background: t.status === "completed" ? "#d1fae5" : t.status === "cancelled" ? "#fee2e2" : "#dbeafe", color: t.status === "completed" ? "#065f46" : t.status === "cancelled" ? "#991b1b" : "#1e40af", whiteSpace: "nowrap" }}>
                          {STATUS_ZH[t.status] || t.status}
                        </span>
                      </td>
                      <td onClick={() => setSelectedTaskId(t.id)} style={{ ...tdS, whiteSpace: "nowrap", minWidth: 100 }}>{formatBeijingTime(t.createdAt)}</td>
                      <td style={{ ...tdS, textAlign: "right" }}>
                        <button onClick={(e) => { e.stopPropagation(); setDeleteTaskId(t.id); }} style={{ padding: "3px 10px", border: "1px solid #ef4444", color: "#ef4444", background: "#fff", borderRadius: 4, cursor: "pointer", fontSize: 11 }}>删除</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ======== 详情 ======== */}
      {selectedTaskId && taskDetail && (
        <div style={{ padding: 24 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
            <button onClick={() => { setSelectedTaskId(null); setPreviewImage(null); setExpandedPrealerts(new Set()); setEditPrealert(null); setEditMark(""); setEditExpressNo(""); setEditProductRows([]); setEditSubmitting(false); setDeletePrealertId(null); setDeleteTaskId(null); setReviewSubmitting(false); setShowRejectDialog(false); setRejectReason(""); setToast(""); loadTasks(); }} style={{ padding: "6px 14px", border: "1px solid #d1d5db", background: "#fff", color: "#6b7280", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>← 返回</button>
            <h2 style={{ fontSize: 20, margin: 0 }}>{taskDetail.taskNo}</h2>
            <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>创建时间：{formatBeijingTime(taskDetail.createdAt)}</div>
            <span style={{ color: "#6b7280", fontSize: 13 }}>{taskDetail.clientName}</span>
            <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, background: "#dbeafe", color: "#1e40af" }}>{STATUS_ZH[taskDetail.status] || taskDetail.status}</span>
            <div style={{ flex: 1 }} />
            <button onClick={() => { if (taskDetail) { setDeleteTaskId(taskDetail.id); setSelectedTaskId(null); } }} style={{ padding: "6px 14px", border: "1px solid #ef4444", color: "#ef4444", background: "#fff", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>删除任务</button>
          </div>

          {/* 进度条 */}
          {showProgress && (
            <div style={{ marginBottom: 20, padding: 16, background: "#f9fafb", borderRadius: 10, border: "1px solid #e5e7eb" }}>
              <div style={{ height: 20, background: "#e5e7eb", borderRadius: 10, overflow: "hidden", position: "relative" }}>
                <div style={{ height: "100%", width: `${Math.min(taskDetail.volumePercent, 100)}%`, background: taskDetail.volumePercent >= 85 ? (taskDetail.volumePercent >= 100 ? "#10b981" : "#f59e0b") : "#1d4ed8", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {taskDetail.volumePercent > 15 && <span style={{ fontSize: 11, color: "#fff", fontWeight: 600 }}>{taskDetail.totalVolumeM3} m³ ({taskDetail.volumePercent}%)</span>}
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#9ca3af", marginTop: 2 }}>
                <span>0</span><span>{taskDetail.maxVolumeM3} m³</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8, marginTop: 10, textAlign: "center" }}>
                <div><div style={{ fontSize: 18, fontWeight: 700 }}>{taskDetail.totalPrealerts}</div><div style={{ fontSize: 11, color: "#6b7280" }}>预报单</div></div>
                <div><div style={{ fontSize: 18, fontWeight: 700 }}>{taskDetail.totalPackages}</div><div style={{ fontSize: 11, color: "#6b7280" }}>总件数</div></div>
                <div><div style={{ fontSize: 18, fontWeight: 700 }}>{taskDetail.totalVolumeM3}</div><div style={{ fontSize: 11, color: "#6b7280" }}>已收体积</div></div>
                <div><div style={{ fontSize: 18, fontWeight: 700 }}>{Math.max(0, taskDetail.maxVolumeM3 - taskDetail.totalVolumeM3).toFixed(1)}</div><div style={{ fontSize: 11, color: "#6b7280" }}>剩余空间</div></div>
              </div>
            </div>
          )}

          {/* 装柜后信息 */}
          {!showProgress && (
            <div style={{ marginBottom: 20, padding: 16, background: "#eff6ff", borderRadius: 10, border: "1px solid #bfdbfe" }}>
              <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
                {taskDetail.containerNo && <div><span style={{ fontSize: 12, color: "#6b7280" }}>柜号</span><div style={{ fontWeight: 600 }}>{taskDetail.containerNo}</div></div>}
                {taskDetail.loadingDate && <div><span style={{ fontSize: 12, color: "#6b7280" }}>装柜日期</span><div style={{ fontWeight: 600 }}>{taskDetail.loadingDate}</div></div>}
                <div><span style={{ fontSize: 12, color: "#6b7280" }}>物流状态</span><div style={{ fontWeight: 600 }}>{STATUS_ZH[taskDetail.status]}</div></div>
              </div>
            </div>
          )}

          {/* 付款审核区域 */}
          {taskDetail.paymentStatus === "pending_review" && (
            <div style={{ marginBottom: 20, padding: "16px", background: "#fef3c7", borderRadius: 8, border: "1px solid #f59e0b" }}>
              <div style={{ fontWeight: 700, color: "#92400e", fontSize: 15, marginBottom: 8 }}>💳 待审核付款</div>
              {taskDetail.paymentProofBase64 && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 4 }}>付款截图</div>
                  <img src={taskDetail.paymentProofBase64} alt="付款凭证" style={{ maxWidth: "100%", maxHeight: 300, borderRadius: 6, cursor: "pointer", border: "1px solid #e5e7eb" }}
                    onClick={() => setPreviewImage(taskDetail.paymentProofBase64!)} />
                </div>
              )}
              <div style={{ fontSize: 13, color: "#92400e", marginBottom: 10 }}>
                上传时间：{taskDetail.paymentProofUploadedAt ? formatBeijingTime(taskDetail.paymentProofUploadedAt) : "-"}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={handleApprovePayment} disabled={reviewSubmitting} style={{ padding: "8px 20px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}>
                  {reviewSubmitting ? "处理中..." : "✓ 审核通过"}
                </button>
                <button onClick={() => setShowRejectDialog(true)} disabled={reviewSubmitting} style={{ padding: "8px 20px", border: "1px solid #d1d5db", color: "#6b7280", background: "#fff", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}>
                  ✗ 审核不通过
                </button>
              </div>
            </div>
          )}

          {/* 审核拒绝弹窗 */}
          {showRejectDialog && (
            <Modal onClose={() => { setShowRejectDialog(false); setRejectReason(""); }}>
              <h3 style={{ marginTop: 0 }}>审核不通过</h3>
              <div>
                <label style={{ display: "block", fontSize: 13, color: "#374151", fontWeight: 500, marginBottom: 3 }}>拒绝原因 *</label>
                <textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="请填写拒绝原因，客户可见" style={{ width: "100%", padding: "7px 10px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13, minHeight: 80, boxSizing: "border-box" }} />
              </div>
              <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
                <button onClick={handleRejectPayment} disabled={reviewSubmitting} style={{ padding: "8px 18px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}>
                  {reviewSubmitting ? "提交中..." : "确认拒绝"}
                </button>
                <button onClick={() => { setShowRejectDialog(false); setRejectReason(""); }} style={{ padding: "8px 18px", border: "1px solid #d1d5db", background: "#fff", color: "#6b7280", borderRadius: 6, cursor: "pointer" }}>取消</button>
              </div>
            </Modal>
          )}

          {/* 预报单 */}
          <h3 style={{ fontSize: 16, marginBottom: 12 }}>预报单</h3>

          {pendingPrealerts.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <h4 style={{ fontSize: 14, color: "#f59e0b", marginBottom: 8 }}>待签收 ({pendingPrealerts.length})</h4>
              {pendingPrealerts.map((pa) => (
                <AdminPrealertRow key={pa.id} pa={pa} expanded={expandedPrealerts} setExpanded={setExpandedPrealerts}
                  setPreviewImage={setPreviewImage}
                  onDelete={() => setDeletePrealertId(pa.id)}
                  onEdit={pa.status === "received" ? () => openAdminEdit(pa) : undefined} />
              ))}
            </div>
          )}

          {receivedPrealerts.length > 0 && (
            <div>
              <h4 style={{ fontSize: 14, color: "#10b981", marginBottom: 8 }}>已签收 ({receivedPrealerts.length})</h4>
              {receivedPrealerts.map((pa) => (
                <AdminPrealertRow key={pa.id} pa={pa} expanded={expandedPrealerts} setExpanded={setExpandedPrealerts}
                  setPreviewImage={setPreviewImage}
                  onEdit={() => openAdminEdit(pa)}
                  onDelete={() => setDeletePrealertId(pa.id)} />
              ))}
            </div>
          )}

          {pendingPrealerts.length === 0 && receivedPrealerts.length === 0 && (
            <p style={{ color: "#9ca3af", textAlign: "center", padding: 20 }}>暂无预报单</p>
          )}

          {/* 状态时间线 */}
          {taskDetail.statusLogs && taskDetail.statusLogs.length > 0 && (
            <div style={{ marginTop: 28 }}>
              <h3 style={{ fontSize: 16, marginBottom: 12 }}>状态记录</h3>
              <div style={{ position: "relative", paddingLeft: 24, borderLeft: "2px solid #e5e7eb", marginLeft: 8 }}>
                {taskDetail.statusLogs.map((log: any, i: number) => (
                  <div key={log.id || i} style={{ marginBottom: 14, position: "relative" }}>
                    <div style={{ position: "absolute", left: -30, top: 4, width: 12, height: 12, borderRadius: "50%", background: "#3b82f6", border: "2px solid #fff" }} />
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{STATUS_ZH[log.fromStatus] || log.fromStatus} → {STATUS_ZH[log.toStatus] || log.toStatus}</div>
                    <div style={{ fontSize: 12, color: "#6b7280" }}>{log.operatorName} · {formatBeijingTime(log.createdAt)}</div>
                    {log.remark && <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 2 }}>{log.remark}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ======== 弹窗：删除任务确认 ======== */}
      {deleteTaskId && (
        <Modal onClose={() => setDeleteTaskId(null)}>
          <p style={{ marginTop: 0 }}>确定要删除该任务吗？将级联删除任务下所有预报单、产品数据，不可恢复。</p>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={handleDeleteTask} disabled={deleteTaskSubmitting} style={{ padding: "8px 16px", background: "#ef4444", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer" }}>{deleteTaskSubmitting ? "删除中..." : "确认删除"}</button>
            <button onClick={() => setDeleteTaskId(null)} style={{ padding: "8px 16px", border: "1px solid #d1d5db", background: "#fff", color: "#6b7280", borderRadius: 6, cursor: "pointer" }}>取消</button>
          </div>
        </Modal>
      )}

      {/* ======== 弹窗：管理员编辑预报单 ======== */}
      {editPrealert && (
        <Modal onClose={() => setEditPrealert(null)} wide>
          <h3 style={{ marginTop: 0 }}>编辑预报单 {editPrealert.trackingNo}</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
            <div>
              <label style={fl}>唛头 *</label>
              <input value={editMark} onChange={(e) => setEditMark(e.target.value)} style={fi} />
            </div>
            <div>
              <label style={fl}>快递单号（可选）</label>
              <input value={editExpressNo} onChange={(e) => setEditExpressNo(e.target.value)} style={fi} />
            </div>
          </div>

          <h4 style={{ fontSize: 14, marginBottom: 8 }}>产品明细</h4>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "#f3f4f6" }}>
                  <th style={thS}>产品名称</th>
                  <th style={thS}>件数</th>
                  <th style={thS}>每箱几个</th>
                  <th style={thS}>单件重(kg)</th>
                  <th style={thS}>长(cm)</th>
                  <th style={thS}>宽(cm)</th>
                  <th style={thS}>高(cm)</th>
                  <th style={thS}>材质</th>
                  <th style={thS}>货值</th>
                  <th style={thS}>总数量</th>
                  <th style={thS}>总重(kg)</th>
                  <th style={thS}>体积(m³)</th>
                  <th style={thS}></th>
                </tr>
              </thead>
              <tbody>
                {editProductRows.map((r, i) => {
                  const { totalQty, totalW, vol } = calcProductRow(r);
                  return (
                    <tr key={r.key} style={{ borderBottom: "1px solid #e5e7eb" }}>
                      <td style={tdS}><input value={r.productName} onChange={(e) => { const next = [...editProductRows]; next[i] = { ...next[i], productName: e.target.value }; setEditProductRows(next); }} style={miniInput} /></td>
                      <td style={tdS}><input value={r.packageCount} onChange={(e) => { const next = [...editProductRows]; next[i] = { ...next[i], packageCount: e.target.value }; setEditProductRows(next); }} style={{ ...miniInput, width: 50 }} /></td>
                      <td style={tdS}><input value={r.quantityPerBox} onChange={(e) => { const next = [...editProductRows]; next[i] = { ...next[i], quantityPerBox: e.target.value }; setEditProductRows(next); }} style={{ ...miniInput, width: 50 }} /></td>
                      <td style={tdS}><input value={r.unitWeightKg} onChange={(e) => { const next = [...editProductRows]; next[i] = { ...next[i], unitWeightKg: e.target.value }; setEditProductRows(next); }} style={{ ...miniInput, width: 60 }} /></td>
                      <td style={tdS}><input value={r.lengthCm} onChange={(e) => { const next = [...editProductRows]; next[i] = { ...next[i], lengthCm: e.target.value }; setEditProductRows(next); }} style={{ ...miniInput, width: 50 }} /></td>
                      <td style={tdS}><input value={r.widthCm} onChange={(e) => { const next = [...editProductRows]; next[i] = { ...next[i], widthCm: e.target.value }; setEditProductRows(next); }} style={{ ...miniInput, width: 50 }} /></td>
                      <td style={tdS}><input value={r.heightCm} onChange={(e) => { const next = [...editProductRows]; next[i] = { ...next[i], heightCm: e.target.value }; setEditProductRows(next); }} style={{ ...miniInput, width: 50 }} /></td>
                      <td style={tdS}><input value={r.material} onChange={(e) => { const next = [...editProductRows]; next[i] = { ...next[i], material: e.target.value }; setEditProductRows(next); }} style={miniInput} /></td>
                      <td style={tdS}><input value={r.cargoValue} onChange={(e) => { const next = [...editProductRows]; next[i] = { ...next[i], cargoValue: e.target.value }; setEditProductRows(next); }} style={miniInput} /></td>
                      <td style={{ ...tdS, color: "#6b7280" }}>{totalQty || "-"}</td>
                      <td style={{ ...tdS, color: "#6b7280" }}>{totalW || "-"}</td>
                      <td style={{ ...tdS, color: "#6b7280" }}>{vol || "-"}</td>
                      <td style={tdS}><button onClick={() => { if (editProductRows.length > 1) setEditProductRows(editProductRows.filter((_, j) => j !== i)); }} style={{ border: "none", background: "none", color: "#ef4444", cursor: "pointer", fontSize: 16 }}>×</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <button onClick={() => setEditProductRows([...editProductRows, emptyProductRow(Date.now())])} style={{ marginTop: 10, padding: "4px 14px", border: "1px dashed #2563eb", color: "#2563eb", background: "none", borderRadius: 4, cursor: "pointer", fontSize: 12 }}>
            + 添加产品行
          </button>

          <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
            <button onClick={handleAdminEditSubmit} disabled={editSubmitting} style={{ padding: "8px 20px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}>
              {editSubmitting ? "提交中..." : "保存修改"}
            </button>
            <button onClick={() => setEditPrealert(null)} style={{ padding: "8px 20px", border: "1px solid #d1d5db", background: "#fff", color: "#6b7280", borderRadius: 6, cursor: "pointer" }}>取消</button>
          </div>
        </Modal>
      )}

      {/* ======== 弹窗：删除预报单确认 ======== */}
      {deletePrealertId && (
        <Modal onClose={() => setDeletePrealertId(null)}>
          <p style={{ marginTop: 0 }}>确定要删除该预报单吗？</p>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={handleAdminDeletePrealert} disabled={deletePrealertSubmitting} style={{ padding: "8px 16px", background: "#ef4444", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer" }}>{deletePrealertSubmitting ? "删除中..." : "确认删除"}</button>
            <button onClick={() => setDeletePrealertId(null)} style={{ padding: "8px 16px", border: "1px solid #d1d5db", background: "#fff", color: "#6b7280", borderRadius: 6, cursor: "pointer" }}>取消</button>
          </div>
        </Modal>
      )}
    </RoleShell>
  );
}

// ============================================================================
// 子组件：管理员预报单行
// ============================================================================
function AdminPrealertRow({
  pa, expanded, setExpanded, setPreviewImage, onEdit, onDelete,
}: {
  pa: ConsolidationPrealertItem;
  expanded: Set<string>;
  setExpanded: React.Dispatch<React.SetStateAction<Set<string>>>;
  setPreviewImage: (url: string | null) => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const open = expanded.has(pa.id);
  const toggle = () => setExpanded((prev) => { const n = new Set(prev); if (n.has(pa.id)) n.delete(pa.id); else n.add(pa.id); return n; });
  const totalPkg = pa.products.reduce((s, p) => s + p.packageCount, 0);
  const totalVol = pa.products.reduce((s, p) => s + (p.volume ?? 0), 0);

  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 12, marginBottom: 8, background: "#fff", cursor: "pointer" }} onClick={toggle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flex: 1 }}>
          <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", minWidth: 160 }}>{pa.trackingNo}</span>
          <span style={{ fontSize: 13, whiteSpace: "nowrap", minWidth: 100 }}>{pa.mark}</span>
          {pa.expressNo && <span style={{ fontSize: 11, color: "#9ca3af" }}>快递: {pa.expressNo}</span>}
          <span style={{ fontSize: 11, color: "#9ca3af" }}>{formatBeijingTime(pa.createdAt)}</span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "#6b7280", whiteSpace: "nowrap" }}>{totalPkg}件 / {totalVol.toFixed(3)}m³</span>
          <span style={{ fontSize: 11, padding: "2px 6px", borderRadius: 4, background: pa.status === "received" ? "#d1fae5" : "#fef3c7", color: pa.status === "received" ? "#065f46" : "#92400e", whiteSpace: "nowrap" }}>{STATUS_ZH[pa.status]}</span>
          {onEdit && <button onClick={(e) => { e.stopPropagation(); onEdit(); }} style={{ padding: "3px 10px", border: "1px solid #2563eb", color: "#2563eb", background: "#fff", borderRadius: 4, cursor: "pointer", fontSize: 11 }}>编辑</button>}
          {onDelete && <button onClick={(e) => { e.stopPropagation(); onDelete(); }} style={{ padding: "3px 10px", border: "1px solid #ef4444", color: "#ef4444", background: "#fff", borderRadius: 4, cursor: "pointer", fontSize: 11 }}>删除</button>}
        </div>
      </div>

      {open && (
        <div style={{ marginTop: 10 }} onClick={(e) => e.stopPropagation()}>
          {pa.status === "received" && pa.signedAt && (
            <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>
              签收时间：{formatBeijingTime(pa.signedAt)}
              {pa.receivedProofBase64 && (
                <div style={{ marginTop: 6 }}>
                  <img src={pa.receivedProofBase64} alt="签收照片" style={{ maxWidth: 160, maxHeight: 120, borderRadius: 6, border: "1px solid #e5e7eb", cursor: "pointer", verticalAlign: "middle" }}
                    onClick={(e) => { e.stopPropagation(); setPreviewImage(pa.receivedProofBase64!); }} />
                </div>
              )}
            </div>
          )}
          <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ background: "#f9fafb" }}>
                <th style={{ ...thS, minWidth: 100, whiteSpace: "nowrap" }}>唛头</th>
                <th style={{ ...thS, minWidth: 160, whiteSpace: "nowrap" }}>运单号</th>
                <th style={{ ...thS, minWidth: 80, whiteSpace: "nowrap" }}>产品名称</th>
                <th style={thS}>件数</th>
                <th style={thS}>装箱数量</th>
                <th style={thS}>总数量</th>
                <th style={thS}>单件重量</th>
                <th style={thS}>总重量</th>
                <th style={thS}>长</th>
                <th style={thS}>宽</th>
                <th style={thS}>高</th>
                <th style={thS}>体积</th>
                <th style={thS}>材质</th>
                <th style={thS}>货值</th>
                <th style={thS}>图片</th>
              </tr>
            </thead>
            <tbody>
              {pa.products.map((p, i) => (
                <tr key={p.id} style={{ borderBottom: "1px solid #e5e7eb" }}>
                  {i === 0 && <td rowSpan={pa.products.length} style={{ ...tdS, minWidth: 100, whiteSpace: "nowrap", verticalAlign: "middle" , textAlign: "center" }}>{pa.mark}</td>}
                  {i === 0 && <td rowSpan={pa.products.length} style={{ ...tdS, minWidth: 160, whiteSpace: "nowrap", verticalAlign: "middle" , textAlign: "center" }}>{pa.trackingNo}</td>}
                  <td style={{ ...tdS, minWidth: 80, whiteSpace: "nowrap" }}>{p.productName}</td>
                  <td style={tdS}>{p.packageCount}</td>
                  <td style={tdS}>{p.quantityPerBox}</td>
                  <td style={tdS}>{p.totalQuantity}</td>
                  <td style={tdS}>{p.unitWeight}</td>
                  <td style={tdS}>{p.totalWeight}</td>
                  <td style={tdS}>{p.length}</td>
                  <td style={tdS}>{p.width}</td>
                  <td style={tdS}>{p.height}</td>
                  <td style={tdS}>{p.volume?.toFixed(4)}</td>
                  <td style={tdS}>{p.material}</td>
                  <td style={tdS}>{p.cargoValue}</td>
                  <td style={{ ...tdS, textAlign: "center" }}>
                    {p.productImageBase64 ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); setPreviewImage(p.productImageBase64); }}
                        style={{ padding: "3px 10px", border: "1px solid #2563eb", color: "#2563eb", background: "#fff", borderRadius: 4, cursor: "pointer", fontSize: 12 }}
                      >查看图片</button>
                    ) : (
                      <span style={{ color: "#9ca3af", fontSize: 12 }}>暂无图片</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Modal
// ============================================================================
function Modal({ children, onClose, wide }: { children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 9000, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, padding: 24, maxWidth: wide ? 1100 : 460, width: "90%", maxHeight: "85vh", overflowY: "auto", boxShadow: "0 8px 32px rgba(0,0,0,0.2)" }}>
        {children}
      </div>
    </div>
  );
}

const thS: React.CSSProperties = { textAlign: "left", padding: "6px 10px", fontSize: 12, color: "#6b7280", fontWeight: 600, borderBottom: "2px solid #e5e7eb" };
const tdS: React.CSSProperties = { padding: "7px 10px", fontSize: 12 };
const fl: React.CSSProperties = { display: "block", fontSize: 13, color: "#374151", fontWeight: 500, marginBottom: 3 };
const fi: React.CSSProperties = { width: "100%", padding: "7px 10px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13, boxSizing: "border-box" };
const miniInput: React.CSSProperties = { width: "100%", padding: "2px 4px", border: "1px solid #d1d5db", borderRadius: 3, fontSize: 11, boxSizing: "border-box" };
