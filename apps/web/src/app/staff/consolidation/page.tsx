"use client";

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import RoleShell from "../../../modules/layout/RoleShell";
import {
  fetchStaffConsolidationTasks,
  fetchStaffConsolidationTaskDetail,
  receiveConsolidationPrealert,
  confirmConsolidationTaskFull,
  quoteConsolidationTask,
  advanceConsolidationTaskStatus,
  loadingConsolidationTask,
  cancelConsolidationTask,
  exportConsolidationTask,
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
// 主页面
// ============================================================================
export default function StaffConsolidationPage() {
  const [tasks, setTasks] = useState<ConsolidationTaskItem[]>([]);
  const [taskDetail, setTaskDetail] = useState<ConsolidationTaskItem | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // 搜索 / 筛选
  const [statusFilter, setStatusFilter] = useState("");
  const [searchText, setSearchText] = useState("");

  // 弹窗
  const [toast, setToast] = useState("");
  const [showReceive, setShowReceive] = useState<ConsolidationPrealertItem | null>(null);
  const [receiveProofBase64, setReceiveProofBase64] = useState("");
  const [receiveProofFileName, setReceiveProofFileName] = useState("");
  const [receiveProofMime, setReceiveProofMime] = useState("");
  const [receiveSubmitting, setReceiveSubmitting] = useState(false);

  const [showQuote, setShowQuote] = useState(false);
  const [quoteBooking, setQuoteBooking] = useState("");
  const [quoteCustoms, setQuoteCustoms] = useState("");
  const [quoteLoading, setQuoteLoading] = useState("");
  const [quoteSubmitting, setQuoteSubmitting] = useState(false);

  const [cancelStep, setCancelStep] = useState<0 | 1>(0);
  const [cancelSubmitting, setCancelSubmitting] = useState(false);

  const [showLoadingForm, setShowLoadingForm] = useState(false);
  const [loadingContainerNo, setLoadingContainerNo] = useState("");
  const [loadingDate, setLoadingDate] = useState("");
  const [loadingSubmitting, setLoadingSubmitting] = useState(false);

  const [advancing, setAdvancing] = useState(false);
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [showRejectDialog, setShowRejectDialog] = useState(false);

  // 展开
  const [expandedPrealerts, setExpandedPrealerts] = useState<Set<string>>(new Set());
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ======== 数据 ========
  const loadTasks = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchStaffConsolidationTasks(statusFilter || undefined);
      setTasks(data);
    } catch (e: any) {
      setToast(e.message);
    } finally { setLoading(false); }
  }, [statusFilter]);

  const loadDetail = useCallback(async (taskId: string) => {
    try {
      const data = await fetchStaffConsolidationTaskDetail(taskId);
      setTaskDetail(data);
      // 预填报价
      if (data.bookingFee != null) setQuoteBooking(String(data.bookingFee));
      if (data.customsFee != null) setQuoteCustoms(String(data.customsFee));
      if (data.loadingFee != null) setQuoteLoading(String(data.loadingFee));
    } catch (e: any) {
      setToast(e.message);
    }
  }, []);

  useEffect(() => { loadTasks(); }, [loadTasks]);
  useEffect(() => {
    if (selectedTaskId) loadDetail(selectedTaskId);
    else { setTaskDetail(null); setCancelStep(0); }
  }, [selectedTaskId, loadDetail]);

  // ======== 过滤 ========
  const filteredTasks = useMemo(() => {
    let list = tasks;
    if (searchText) {
      const s = searchText.trim().toLowerCase();
      list = list.filter((t) => t.taskNo.toLowerCase().includes(s) || (t.clientName ?? "").toLowerCase().includes(s));
    }
    return list;
  }, [tasks, searchText]);

  // ======== 签收 ========
  const handleReceive = async () => {
    if (!showReceive) return;
    if (!receiveProofBase64) { setToast("请上传签收照片"); return; }
    setReceiveSubmitting(true);
    try {
      await receiveConsolidationPrealert({
        prealertId: showReceive.id,
        proofBase64: receiveProofBase64,
        proofFileName: receiveProofFileName,
        proofMime: receiveProofMime,
      });
      setShowReceive(null);
      setReceiveProofBase64("");
      setReceiveProofFileName("");
      setReceiveProofMime("");
      setToast("签收成功");
      if (selectedTaskId) await loadDetail(selectedTaskId);
      await loadTasks();
    } catch (e: any) {
      setToast(e.message);
    } finally { setReceiveSubmitting(false); }
  };

  // ======== 确认满柜 ========
  const handleConfirmFull = async () => {
    const tid = selectedTaskId;
    if (!tid) return;
    try {
      await confirmConsolidationTaskFull(tid);
      setToast("已确认满柜");
      await loadDetail(tid);
      await loadTasks();
    } catch (e: any) {
      setToast(e.message);
    }
  };

  // ======== 报价 ========
  const handleQuote = async () => {
    const tid = selectedTaskId;
    if (!tid) return;
    const b = parseFloat(quoteBooking);
    const c = parseFloat(quoteCustoms);
    const l = parseFloat(quoteLoading);
    if (isNaN(b) || isNaN(c) || isNaN(l)) { setToast("三个费用都必须填数字"); return; }
    setQuoteSubmitting(true);
    try {
      await quoteConsolidationTask({ taskId: tid, bookingFee: b, customsFee: c, loadingFee: l });
      setShowQuote(false);
      setToast("报价已保存");
      await loadDetail(tid);
      await loadTasks();
    } catch (e: any) {
      setToast(e.message);
    } finally { setQuoteSubmitting(false); }
  };

  // ======== 取消 ========
  const handleCancel = async () => {
    const tid = selectedTaskId;
    if (!tid) return;
    if (cancelStep === 0) { setCancelStep(1); return; }
    setCancelSubmitting(true);
    try {
      await cancelConsolidationTask(tid);
      setToast("任务已取消");
      setSelectedTaskId(null);
      setCancelStep(0);
      await loadTasks();
    } catch (e: any) {
      setToast(e.message);
    } finally { setCancelSubmitting(false); }
  };

  // ======== 付款审核 ========
  const handleApprovePayment = async () => {
    const tid = selectedTaskId;
    if (!tid) return;
    setReviewSubmitting(true);
    try {
      await reviewConsolidationPayment(tid);
      setToast("付款审核通过");
      await loadDetail(tid);
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
      await loadDetail(tid);
      await loadTasks();
    } catch (e: any) { setToast(e.message); }
    finally { setReviewSubmitting(false); }
  };

  // ======== 状态推进 ========
  const handleAdvance = async (toStatus: string) => {
    const tid = selectedTaskId;
    if (!tid) return;
    setAdvancing(true);
    try {
      await advanceConsolidationTaskStatus({ taskId: tid, toStatus });
      setToast("状态已更新");
      await loadDetail(tid);
      await loadTasks();
    } catch (e: any) {
      setToast(e.message);
    } finally { setAdvancing(false); }
  };

  // ======== 装柜 ========
  const handleLoading = async () => {
    const tid = selectedTaskId;
    if (!tid) return;
    setLoadingSubmitting(true);
    try {
      await loadingConsolidationTask({ taskId: tid, containerNo: loadingContainerNo.trim() || undefined, loadingDate: loadingDate || undefined });
      setShowLoadingForm(false);
      setLoadingContainerNo("");
      setLoadingDate("");
      setToast("装柜完成");
      await loadDetail(tid);
      await loadTasks();
    } catch (e: any) {
      setToast(e.message);
    } finally { setLoadingSubmitting(false); }
  };

  // ======== 导出 ========
  const handleExport = async () => {
    const tid = selectedTaskId;
    if (!tid) return;
    try {
      const data = await exportConsolidationTask(tid);
      console.log("[导出] taskNo=" + data.taskNo + " taskId=" + tid + " totalRows=" + data.totalRows);
      if (data.rows.length === 0) { setToast("无已签收数据可导出"); return; }
      setToast(`正在导出 ${data.taskNo}（${data.totalRows} 行数据，含图片）...`);
      
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("集货清单");
      
      const headers = ["唛头", "运单号", "产品名称", "件数", "装箱数量", "总数量", "单件重量", "总重量", "长(cm)", "宽(cm)", "高(cm)", "体积(m³)", "材质", "货值", "产品图片"];
      const headerRow = ws.addRow(headers);
      headerRow.font = { bold: true };
      headerRow.alignment = { vertical: "middle", horizontal: "center" };
      
      ws.columns = headers.map(() => ({ width: 14 }));
      ws.getColumn(1).width = 12;  // 唛头
      ws.getColumn(2).width = 18;  // 运单号
      ws.getColumn(headers.length).width = 30; // 产品图片
      
      const imgCol = headers.length - 1;
      
      // 第一遍：创建所有数据行（不能在 addRow 之间调 ws.addImage，否则跳行）
      const dataRows: Array<{ row: any; rowNum: number; b64: string | null; ext: "jpeg" | "png" | "gif"; mark: string }> = [];
      for (let i = 0; i < data.rows.length; i++) {
        const r = data.rows[i];
        const row = ws.addRow([
          r.mark ?? "", r.trackingNo ?? "", r.productName ?? "",
          r.packageCount ?? "", r.quantityPerBox ?? "", r.totalQuantity ?? "",
          r.unitWeight ?? "", r.totalWeight ?? "", r.lengthCm ?? "",
          r.widthCm ?? "", r.heightCm ?? "", r.volumeM3 ?? "",
          r.material ?? "", r.cargoValue ?? "", ""
        ]);
        const rowNum = row.number; // addRow 后立即捕获行号，防止后续 addImage 改值
        row.alignment = { vertical: "middle" };
        
        let imgB64: string | null = null;
        let imgExt: "jpeg" | "png" | "gif" = "jpeg";
        if (r.productImageBase64) {
          row.height = 120;
          const b64 = r.productImageBase64;
          const extMatch = b64.match(/^data:image\/(\w+);base64,/);
          const pureB64 = extMatch ? b64.substring(b64.indexOf(",") + 1) : b64;
          imgExt = (extMatch ? extMatch[1].toLowerCase() : "jpeg") as "jpeg" | "png" | "gif";
          if (pureB64 && pureB64.length >= 10) {
            imgB64 = pureB64;
          }
        }
        dataRows.push({ row, rowNum, b64: imgB64, ext: imgExt, mark: r.mark ?? "" });
      }
      
      // 第二遍：所有行建完后统一嵌入图片（避免 ws.addImage 导致跳行）
      let imagesEmbedded = 0;
      let imagesFailed = 0;
      for (const dr of dataRows) {
        if (dr.b64) {
          try {
            const imageId = wb.addImage({ base64: dr.b64, extension: dr.ext });
            // twoCellAnchor + editAs 锁定图片在单元格内，Excel 全版本对齐
            ws.addImage(imageId, {
              tl: { col: imgCol, row: dr.rowNum - 1 },
              br: { col: imgCol + 1, row: dr.rowNum - 0.1 },
              editAs: "oneCell",
            } as any);
            console.log("[导出] 行" + dr.rowNum + " 嵌入图片 (col=" + imgCol + ") mark=" + dr.mark);
            imagesEmbedded++;
          } catch (imgErr: any) {
            console.error("[导出] 行" + dr.rowNum + " 图片嵌入失败:", imgErr?.message || imgErr);
            dr.row.getCell(headers.length).value = "[图片]";
            imagesFailed++;
          }
        } else if (dr.mark) {
          // 有预报单但图片 base64 为空/太短
          dr.row.getCell(headers.length).value = "[图片缺失]";
        }
      }
      if (imagesEmbedded > 0) {
        setToast(`导出完成，已嵌入 ${imagesEmbedded} 张图片` + (imagesFailed > 0 ? `，${imagesFailed} 张失败` : ""));
      }
      
      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `集货清单_${data.taskNo || selectedTaskId.slice(0, 8)}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setToast(e.message || "导出失败");
    }
  };

  // ======== 计算 ========
  const pendingPrealerts = useMemo(() => taskDetail?.prealerts?.filter((p) => p.status === "pending") ?? [], [taskDetail]);
  const receivedPrealerts = useMemo(() => taskDetail?.prealerts?.filter((p) => p.status === "received") ?? [], [taskDetail]);

  const totalFee = (parseFloat(quoteBooking) || 0) + (parseFloat(quoteCustoms) || 0) + (parseFloat(quoteLoading) || 0);

  const showProgress = taskDetail && !["loading", "in_transit", "customs", "delivering", "completed", "cancelled"].includes(taskDetail.status);
  const isFull = taskDetail && taskDetail.totalVolumeM3 >= taskDetail.maxVolumeM3;

  // ======== 状态按钮 ========
  const actionButtons = useMemo(() => {
    if (!taskDetail) return null;
    const btns: Array<{ label: string; toStatus: string; color?: string }> = [];
    switch (taskDetail.status) {
      case "paid":
        btns.push({ label: "装柜", toStatus: "loading" });
        break;
      case "loading":
        btns.push({ label: "发运", toStatus: "in_transit" });
        break;
      case "in_transit":
        btns.push({ label: "到港", toStatus: "customs" });
        break;
      case "customs":
        btns.push({ label: "清关完成", toStatus: "delivering" });
        break;
      case "delivering":
        btns.push({ label: "派送完成", toStatus: "completed" });
        break;
    }
    return btns;
  }, [taskDetail]);

  // ======== 渲染 ========
  return (
    <RoleShell allowedRole={["staff", "admin"]} title="集货拼柜管理">
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
                  </tr>
                </thead>
                <tbody>
                  {filteredTasks.map((t) => (
                    <tr key={t.id} onClick={() => setSelectedTaskId(t.id)} style={{ borderBottom: "1px solid #e5e7eb", cursor: "pointer", transition: "background 0.15s" }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#f9fafb"; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ""; }}>
                      <td style={{ ...tdS, fontWeight: 600, whiteSpace: "nowrap", minWidth: 140 }}>{t.taskNo}</td>
                      <td style={{ ...tdS, minWidth: 80 }}>{t.clientName || "-"}</td>
                      <td style={{ ...tdS, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.destinationTh}</td>
                      <td style={tdS}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <div style={{ flex: 1, height: 6, background: "#e5e7eb", borderRadius: 3, overflow: "hidden", maxWidth: 120 }}>
                            <div style={{ height: "100%", width: `${Math.min(t.volumePercent, 100)}%`, background: t.volumePercent >= 85 ? (t.volumePercent >= 100 ? "#10b981" : "#f59e0b") : "#3b82f6", borderRadius: 3 }} />
                          </div>
                          <span style={{ fontSize: 11, color: "#6b7280", whiteSpace: "nowrap" }}>{t.totalVolumeM3}/{t.maxVolumeM3}</span>
                        </div>
                      </td>
                      <td style={tdS}><span style={{ fontSize: 11, padding: "2px 6px", borderRadius: 4, background: t.status === "completed" ? "#d1fae5" : t.status === "cancelled" ? "#fee2e2" : "#dbeafe", color: t.status === "completed" ? "#065f46" : t.status === "cancelled" ? "#991b1b" : "#1e40af", whiteSpace: "nowrap" }}>{STATUS_ZH[t.status] || t.status}</span></td>
                      <td style={{ ...tdS, whiteSpace: "nowrap", minWidth: 100 }}>{formatBeijingTime(t.createdAt)}</td>
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
            <button onClick={() => { setSelectedTaskId(null); setPreviewImage(null); setShowReceive(null); setShowQuote(false); setShowLoadingForm(false); setCancelStep(0); setExpandedPrealerts(new Set()); setReviewSubmitting(false); setShowRejectDialog(false); setRejectReason(""); setToast(""); loadTasks(); }} style={{ padding: "6px 14px", border: "1px solid #d1d5db", background: "#fff", color: "#6b7280", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>← 返回</button>
            <h2 style={{ fontSize: 20, margin: 0 }}>{taskDetail.taskNo}</h2>
            <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>创建时间：{formatBeijingTime(taskDetail.createdAt)}</div>
            <span style={{ color: "#6b7280", fontSize: 13 }}>{taskDetail.clientName}</span>
            <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, background: "#dbeafe", color: "#1e40af" }}>{STATUS_ZH[taskDetail.status] || taskDetail.status}</span>
            <div style={{ flex: 1 }} />
            <button onClick={handleExport} style={{ padding: "6px 14px", background: "#059669", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>导出 Excel</button>
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

          {/* 满柜确认 */}
          {isFull && taskDetail.status === "collecting" && (
            <div style={{ marginBottom: 16, padding: "12px 16px", background: "#fffbeb", borderRadius: 8, border: "1px solid #fde68a", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontWeight: 600, color: "#92400e", fontSize: 14 }}>⚠️ 已到 {taskDetail.maxVolumeM3} 方，请确认满柜</span>
              <button onClick={handleConfirmFull} style={{ padding: "6px 16px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600, fontSize: 13 }}>确认满柜</button>
            </div>
          )}

          {/* 操作区 */}
          <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
            {/* 报价 */}
            {(taskDetail.status === "full_confirmed" || taskDetail.status === "quoted") && (
              <button onClick={() => setShowQuote(true)} style={actionBtn("#2563eb")}>
                {taskDetail.status === "quoted" ? "修改报价" : "录入报价"}
              </button>
            )}

            {/* 状态推进按钮 */}
            {actionButtons?.map((b) => (
              b.toStatus === "loading" ? (
                <button key={b.toStatus} onClick={() => setShowLoadingForm(true)} style={actionBtn("#2563eb")} disabled={advancing}>{b.label}</button>
              ) : (
                <button key={b.toStatus} onClick={() => handleAdvance(b.toStatus)} style={actionBtn("#2563eb")} disabled={advancing}>{advancing ? "处理中..." : b.label}</button>
              )
            ))}

            {/* 取消 */}
            {["collecting", "full_confirmed", "quoted"].includes(taskDetail.status) && (
              <button onClick={handleCancel} style={actionBtn("#ef4444")} disabled={cancelSubmitting}>
                {cancelSubmitting ? "取消中..." : cancelStep === 1 ? "确认取消" : "取消任务"}
              </button>
            )}
            {cancelStep === 1 && (
              <button onClick={() => setCancelStep(0)} style={{ ...actionBtnBase, border: "1px solid #d1d5db", color: "#6b7280", background: "#fff" }}>返回</button>
            )}
          </div>

          {/* 付款审核区域 */}
          {taskDetail.paymentStatus === "pending_review" && (
            <div style={{ marginBottom: 16, padding: "16px", background: "#fef3c7", borderRadius: 8, border: "1px solid #f59e0b" }}>
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
                <label style={fl}>拒绝原因 *</label>
                <textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="请填写拒绝原因，客户可见" style={{ ...fi, minHeight: 80 }} />
              </div>
              <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
                <button onClick={handleRejectPayment} disabled={reviewSubmitting} style={{ padding: "8px 18px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}>
                  {reviewSubmitting ? "提交中..." : "确认拒绝"}
                </button>
                <button onClick={() => { setShowRejectDialog(false); setRejectReason(""); }} style={{ padding: "8px 18px", border: "1px solid #d1d5db", background: "#fff", color: "#6b7280", borderRadius: 6, cursor: "pointer" }}>取消</button>
              </div>
            </Modal>
          )}

          {/* 报价弹窗 */}
          {showQuote && (
            <Modal onClose={() => setShowQuote(false)}>
              <h3 style={{ marginTop: 0 }}>录入报价</h3>
              <div style={{ display: "grid", gap: 10 }}>
                <div><label style={fl}>订舱费 (¥)</label><input type="number" value={quoteBooking} onChange={(e) => setQuoteBooking(e.target.value)} style={fi} /></div>
                <div><label style={fl}>清关费 (¥)</label><input type="number" value={quoteCustoms} onChange={(e) => setQuoteCustoms(e.target.value)} style={fi} /></div>
                <div><label style={fl}>装柜费 (¥)</label><input type="number" value={quoteLoading} onChange={(e) => setQuoteLoading(e.target.value)} style={fi} /></div>
                <div style={{ borderTop: "2px solid #10b981", paddingTop: 8, fontSize: 20, fontWeight: 700, color: "#10b981" }}>总价：¥{totalFee.toLocaleString()}</div>
              </div>
              <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
                <button onClick={handleQuote} disabled={quoteSubmitting} style={{ padding: "8px 18px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}>{quoteSubmitting ? "保存中..." : "保存报价"}</button>
                <button onClick={() => setShowQuote(false)} style={{ padding: "8px 18px", border: "1px solid #d1d5db", background: "#fff", color: "#6b7280", borderRadius: 6, cursor: "pointer" }}>取消</button>
              </div>
            </Modal>
          )}

          {/* 装柜弹窗 */}
          {showLoadingForm && (
            <Modal onClose={() => setShowLoadingForm(false)}>
              <h3 style={{ marginTop: 0 }}>录入装柜信息</h3>
              <div style={{ display: "grid", gap: 10 }}>
                <div><label style={fl}>柜号</label><input value={loadingContainerNo} onChange={(e) => setLoadingContainerNo(e.target.value)} placeholder="如 CICU1234567" style={fi} /></div>
                <div><label style={fl}>装柜日期</label><input type="date" value={loadingDate} onChange={(e) => setLoadingDate(e.target.value)} style={fi} /></div>
              </div>
              <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
                <button onClick={handleLoading} disabled={loadingSubmitting} style={{ padding: "8px 18px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}>{loadingSubmitting ? "提交中..." : "确认装柜"}</button>
                <button onClick={() => setShowLoadingForm(false)} style={{ padding: "8px 18px", border: "1px solid #d1d5db", background: "#fff", color: "#6b7280", borderRadius: 6, cursor: "pointer" }}>取消</button>
              </div>
            </Modal>
          )}

          {/* 预报单 */}  
          <h3 style={{ fontSize: 16, marginBottom: 12 }}>预报单</h3>

          {pendingPrealerts.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <h4 style={{ fontSize: 14, color: "#f59e0b", marginBottom: 8 }}>待签收 ({pendingPrealerts.length})</h4>
              {pendingPrealerts.map((pa) => <StaffPrealertRow key={pa.id} pa={pa} taskStatus={taskDetail.status} expanded={expandedPrealerts} setExpanded={setExpandedPrealerts} onReceive={() => setShowReceive(pa)} setPreviewImage={setPreviewImage} />)}
            </div>
          )}

          {receivedPrealerts.length > 0 && (
            <div>
              <h4 style={{ fontSize: 14, color: "#10b981", marginBottom: 8 }}>已签收 ({receivedPrealerts.length})</h4>
              {receivedPrealerts.map((pa) => <StaffPrealertRow key={pa.id} pa={pa} taskStatus={taskDetail.status} expanded={expandedPrealerts} setExpanded={setExpandedPrealerts} setPreviewImage={setPreviewImage} />)}
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

      {/* ======== 签收弹窗 ======== */}
      {showReceive && (
        <Modal onClose={() => { setShowReceive(null); setReceiveProofBase64(""); }} wide>
          <h3 style={{ marginTop: 0 }}>签收预报单 {showReceive.trackingNo}</h3>
          <div style={{ marginBottom: 12, fontSize: 13 }}>
            <span style={{ color: "#6b7280" }}>唛头：</span>{showReceive.mark}
            {showReceive.expressNo && <><span style={{ color: "#6b7280", marginLeft: 16 }}>快递单号：</span>{showReceive.expressNo}</>}
          </div>
          <div style={{ overflowX: "auto", marginBottom: 16 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "#f9fafb" }}>
                  <th style={{ ...thS, minWidth: 100, whiteSpace: "nowrap" }}>唛头</th>
                  <th style={{ ...thS, minWidth: 160, whiteSpace: "nowrap" }}>运单号</th>
                  <th style={{ ...thS, minWidth: 80, whiteSpace: "nowrap" }}>产品名称</th>
                  <th style={thS}>件数</th>
                  <th style={thS}>装箱数量</th>
                  <th style={thS}>总数量</th>
                  <th style={thS}>长</th>
                  <th style={thS}>宽</th>
                  <th style={thS}>高</th>
                  <th style={thS}>体积</th>
                  <th style={thS}>材质</th>
                  <th style={thS}>货值</th>
                </tr>
              </thead>
              <tbody>
                {showReceive.products.map((p, i) => (
                  <tr key={p.id} style={{ borderBottom: "1px solid #e5e7eb" }}>
                    {i === 0 && <td rowSpan={showReceive.products.length} style={{ ...tdS, minWidth: 100, whiteSpace: "nowrap", verticalAlign: "middle" , textAlign: "center" }}>{showReceive.mark}</td>}
                    {i === 0 && <td rowSpan={showReceive.products.length} style={{ ...tdS, minWidth: 160, whiteSpace: "nowrap", verticalAlign: "middle" , textAlign: "center" }}>{showReceive.trackingNo}</td>}
                    <td style={{ ...tdS, minWidth: 80, whiteSpace: "nowrap" }}>{p.productName}</td>
                    <td style={tdS}>{p.packageCount}</td>
                    <td style={tdS}>{p.quantityPerBox}</td>
                    <td style={tdS}>{p.totalQuantity}</td>
                    <td style={tdS}>{p.length}</td>
                    <td style={tdS}>{p.width}</td>
                    <td style={tdS}>{p.height}</td>
                    <td style={tdS}>{p.volume?.toFixed(4)}</td>
                    <td style={tdS}>{p.material}</td>
                    <td style={tdS}>{p.cargoValue}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ borderTop: "1px solid #e5e7eb", paddingTop: 12 }}>
            <label style={fl}>签收照片 *（必填）</label>
            <input ref={fileInputRef} type="file" accept="image/*" onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const b64 = await new Promise<string>((r) => { const rd = new FileReader(); rd.onload = () => r((rd.result as string).split(",")[1]); rd.readAsDataURL(file); });
              setReceiveProofFileName(file.name);
              setReceiveProofMime(file.type);
              setReceiveProofBase64(b64);
            }} style={{ marginTop: 4 }} />
            {receiveProofBase64 && (
              <div style={{ marginTop: 8 }}>
                <img src={`data:${receiveProofMime || "image/png"};base64,${receiveProofBase64}`} alt="签收照片预览" style={{ maxWidth: 200, maxHeight: 150, borderRadius: 6, border: "1px solid #e5e7eb" }} />
              </div>
            )}
          </div>
          <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
            <button onClick={handleReceive} disabled={receiveSubmitting || !receiveProofBase64} style={{ padding: "8px 20px", background: !receiveProofBase64 ? "#9ca3af" : "#2563eb", color: "#fff", border: "none", borderRadius: 6, cursor: receiveProofBase64 ? "pointer" : "not-allowed", fontWeight: 600 }}>{receiveSubmitting ? "签收中..." : !receiveProofBase64 ? "请上传签收照片" : "确认签收"}</button>
            <button onClick={() => { setShowReceive(null); setReceiveProofBase64(""); setReceiveProofFileName(""); setReceiveProofMime(""); }} style={{ padding: "8px 20px", border: "1px solid #d1d5db", background: "#fff", borderRadius: 6, cursor: "pointer", color: "#6b7280" }}>取消</button>
          </div>
        </Modal>
      )}
    </RoleShell>
  );
}

// ============================================================================
// 子组件：预报单行
// ============================================================================
function StaffPrealertRow({
  pa, taskStatus, expanded, setExpanded, onReceive, setPreviewImage,
}: {
  pa: ConsolidationPrealertItem;
  taskStatus: string;
  expanded: Set<string>;
  setExpanded: React.Dispatch<React.SetStateAction<Set<string>>>;
  onReceive?: () => void;
  setPreviewImage: (url: string | null) => void;
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
          {pa.status === "pending" && onReceive && (
            <button onClick={(e) => { e.stopPropagation(); onReceive(); }} style={{ padding: "3px 10px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 11, fontWeight: 600 }}>签收</button>
          )}
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

// ============================================================================
// 样式
// ============================================================================
const thS: React.CSSProperties = { textAlign: "left", padding: "6px 10px", fontSize: 12, color: "#6b7280", fontWeight: 600, borderBottom: "2px solid #e5e7eb" };
const tdS: React.CSSProperties = { padding: "7px 10px", fontSize: 12 };
const fl: React.CSSProperties = { display: "block", fontSize: 13, color: "#374151", fontWeight: 500, marginBottom: 3 };
const fi: React.CSSProperties = { width: "100%", padding: "7px 10px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13, boxSizing: "border-box" };
const actionBtn = (bg: string): React.CSSProperties => ({ padding: "6px 16px", background: bg, color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 });
const actionBtnBase: React.CSSProperties = { padding: "6px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
