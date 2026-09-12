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
import { createRequestGate } from "../../../modules/shared/request-gate";

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
  // 有已签收预报单的任务，后端会拦下取消并要管理员密码（2026-08-31）。
  // 这里存后端那句提示，非空就弹密码框；交互照管理员端删除任务那套。
  const [cancelPwdPrompt, setCancelPwdPrompt] = useState("");
  const [cancelPassword, setCancelPassword] = useState("");
  // 2026-08-31 Codex 复核补：还要填管理员账号，后端只验这一个账号，不再挨个试全公司管理员
  const [cancelAdminAccount, setCancelAdminAccount] = useState("");

  // 签收成功但后端带回了提醒（付款后才签收，2026-08-31）——
  // 要让员工读完再关，不能只闪一下角落的 Toast
  const [receiveWarning, setReceiveWarning] = useState("");

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
  /** 2026-09-01 竞态全扫：状态筛选快速连切会连发请求，旧筛选的响应后到会盖掉新筛选的列表。
      每次出发领号，回来验号——数据、报错、loading 三个分支都只认最新一次请求。 */
  const tasksGate = useRef(createRequestGate()).current;
  const loadTasks = useCallback(async () => {
    const ticket = tasksGate.begin();
    setLoading(true);
    try {
      const data = await fetchStaffConsolidationTasks(statusFilter || undefined);
      if (!tasksGate.isCurrent(ticket)) return; // 旧筛选的响应后到，丢弃
      setTasks(data);
    } catch (e: any) {
      if (!tasksGate.isCurrent(ticket)) return; // 旧请求的报错也不弹，别盖住新请求
      setToast(e.message);
    } finally {
      if (tasksGate.isCurrent(ticket)) setLoading(false); // 旧请求不许掐掉新请求的加载态
    }
  }, [statusFilter, tasksGate]);

  /** 2026-09-02 终审整改（P1）：详情加载配门闩 + 认主人。
      病根：详情是异步取的，旧任务的响应后到会盖掉新任务的详情——页面显示 A，
      操作函数却拿当前选中的 B，操作会落错任务。
      两道防线：① 领号验号，只认最新一次详情请求；② 响应落地时核对
      「当前选中的任务」还是不是出发时那张（selectedTaskIdRef，点击处同步赋值），
      不是就整段丢弃，报错也不许弹。 */
  const detailGate = useRef(createRequestGate()).current;
  // 认主人的 ref：必须在用户点击处**同步**赋值，不许等 useEffect——
  // useEffect 晚一拍，异步响应插在中间就核不住（2026-09-02 终审整改）
  const selectedTaskIdRef = useRef<string | null>(null);
  const loadDetail = useCallback(async (taskId: string) => {
    const ticket = detailGate.begin(); // 出发时领号
    try {
      const data = await fetchStaffConsolidationTaskDetail(taskId);
      if (!detailGate.isCurrent(ticket)) return; // 验号：已有更新的详情请求出发，旧响应丢弃
      if (selectedTaskIdRef.current !== taskId) return; // 认主人：用户已切走/返回列表
      setTaskDetail(data);
      // 预填报价
      if (data.bookingFee != null) setQuoteBooking(String(data.bookingFee));
      if (data.customsFee != null) setQuoteCustoms(String(data.customsFee));
      if (data.loadingFee != null) setQuoteLoading(String(data.loadingFee));
    } catch (e: any) {
      if (!detailGate.isCurrent(ticket)) return; // 旧请求的报错也不许弹
      if (selectedTaskIdRef.current !== taskId) return;
      setToast(e.message);
    }
  }, [detailGate]);

  /** 2026-09-02 终审整改（P1）：所有会写库的操作动手前，核对
      「当前展示详情的任务 id」===「即将操作的任务 id」。
      详情和选中项在极端时序下可能对不上（旧详情还挂在页面上），
      对不上就拒绝操作，绝不让操作落到另一张任务头上。 */
  const guardDetailOwner = (tid: string): boolean => {
    if (!taskDetail || taskDetail.id !== tid) {
      setToast("页面刚切换过任务，请重新打开再操作");
      return false;
    }
    return true;
  };

  useEffect(() => { loadTasks(); }, [loadTasks]);
  useEffect(() => {
    if (selectedTaskId) loadDetail(selectedTaskId);
    else { setTaskDetail(null); setCancelStep(0); setCancelPwdPrompt(""); setCancelPassword(""); }
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
    // 2026-09-02 终审整改：签收会写库，先核对展示详情的任务就是当前选中的任务
    if (!selectedTaskId || !guardDetailOwner(selectedTaskId)) return;
    if (!receiveProofBase64) { setToast("请上传签收照片"); return; }
    setReceiveSubmitting(true);
    try {
      const r = await receiveConsolidationPrealert({
        prealertId: showReceive.id,
        proofBase64: receiveProofBase64,
        proofFileName: receiveProofFileName,
        proofMime: receiveProofMime,
      });
      setShowReceive(null);
      setReceiveProofBase64("");
      setReceiveProofFileName("");
      setReceiveProofMime("");
      if (r.warning) {
        // 付款后才签收的提醒（2026-08-31）：弹窗摆出来让员工读完，Toast 一闪就过了
        setReceiveWarning(r.warning);
      } else {
        setToast("签收成功");
      }
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
    if (!guardDetailOwner(tid)) return; // 2026-09-02 终审整改：防止操作落错任务
    try {
      await confirmConsolidationTaskFull(tid);
      setToast("已确认满柜");
      await loadDetail(tid);
      await loadTasks();
    } catch (e: any) {
      setToast(e.message);
      // 失败也要刷新（2026-08-27 补）：后端现在会说「刚刚被别人改过，请刷新后再看」，
      // 页面不刷新的话用户看到的还是旧数字，容易照着旧数字再操作一次。
      await loadDetail(tid);
      await loadTasks();
    }
  };

  // ======== 报价 ========
  const handleQuote = async () => {
    const tid = selectedTaskId;
    if (!tid) return;
    if (!guardDetailOwner(tid)) return; // 2026-09-02 终审整改：防止报价落错任务
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
      // 失败也要刷新（2026-08-27 补）：后端现在会说「刚刚被别人改过，请刷新后再看」，
      // 页面不刷新的话用户看到的还是旧数字，容易照着旧数字再操作一次。
      await loadDetail(tid);
      await loadTasks();
    } finally { setQuoteSubmitting(false); }
  };

  // ======== 取消 ========
  // 普通任务照旧：第一下变「确认取消」、第二下真取消。
  // 有已签收预报单的任务，后端会拦（409，提示语里带「管理员密码」，2026-08-31）——
  // 这时弹密码框，输入管理员账号+密码后一起重试（2026-08-31 Codex 复核：后端只验指名的那个账号）。
  const handleCancel = async (confirmPassword?: string, adminAccount?: string) => {
    const tid = selectedTaskId;
    if (!tid) return;
    // 2026-09-02 终审整改：防止取消落错任务。放在两步确认最前面，
    // 管理员密码弹窗流程（09-01 加的）不受影响——弹窗期间详情和选中项本来就一致
    if (!guardDetailOwner(tid)) return;
    if (cancelStep === 0) { setCancelStep(1); return; }
    setCancelSubmitting(true);
    try {
      await cancelConsolidationTask(tid, confirmPassword ? { confirmPassword, adminAccount } : undefined);
      setToast("任务已取消");
      selectedTaskIdRef.current = null; // 2026-09-02 终审整改：取消成功退回列表，同步改主人 ref
      setSelectedTaskId(null);
      setCancelStep(0);
      setCancelPwdPrompt("");
      setCancelPassword("");
      setCancelAdminAccount("");
      await loadTasks();
    } catch (e: any) {
      const msg: string = e?.message ?? "取消任务失败";
      if (msg.includes("管理员密码")) {
        // 被拦（或账号/密码不对）：把后端原话摆在密码框上方，别塞进角落的 Toast
        setCancelPwdPrompt(msg);
      } else {
        setCancelPwdPrompt("");
        setCancelPassword("");
        setCancelAdminAccount("");
        setToast(msg);
      }
      // 失败也要刷新（2026-08-27 补）：后端现在会说「刚刚被别人改过，请刷新后再看」，
      // 页面不刷新的话用户看到的还是旧数字，容易照着旧数字再操作一次。
      await loadTasks();
    } finally { setCancelSubmitting(false); }
  };

  // ======== 付款审核 ========
  const handleApprovePayment = async () => {
    const tid = selectedTaskId;
    if (!tid) return;
    if (!guardDetailOwner(tid)) return; // 2026-09-02 终审整改：防止审核落错任务
    setReviewSubmitting(true);
    try {
      await reviewConsolidationPayment(tid);
      setToast("付款审核通过");
      await loadDetail(tid);
      await loadTasks();
    } catch (e: any) {
      setToast(e.message);
      // 失败也要刷新（2026-08-27 补）：后端现在会说「刚刚被别人改过，请刷新后再看」，
      // 页面不刷新的话用户看到的还是旧数字，容易照着旧数字再操作一次。
      await loadDetail(tid);
      await loadTasks();
    }
    finally { setReviewSubmitting(false); }
  };

  const handleRejectPayment = async () => {
    const tid = selectedTaskId;
    if (!tid) return;
    if (!guardDetailOwner(tid)) return; // 2026-09-02 终审整改：防止退回付款落错任务
    if (!rejectReason.trim()) { setToast("请填写拒绝原因"); return; }
    setReviewSubmitting(true);
    try {
      await rejectConsolidationPayment(tid, rejectReason.trim());
      setShowRejectDialog(false);
      setRejectReason("");
      setToast("已退回付款");
      await loadDetail(tid);
      await loadTasks();
    } catch (e: any) {
      setToast(e.message);
      // 失败也要刷新（2026-08-27 补）：后端现在会说「刚刚被别人改过，请刷新后再看」，
      // 页面不刷新的话用户看到的还是旧数字，容易照着旧数字再操作一次。
      await loadDetail(tid);
      await loadTasks();
    }
    finally { setReviewSubmitting(false); }
  };

  // ======== 状态推进 ========
  const handleAdvance = async (toStatus: string) => {
    const tid = selectedTaskId;
    if (!tid) return;
    if (!guardDetailOwner(tid)) return; // 2026-09-02 终审整改：防止状态推进落错任务
    setAdvancing(true);
    try {
      await advanceConsolidationTaskStatus({ taskId: tid, toStatus });
      setToast("状态已更新");
      await loadDetail(tid);
      await loadTasks();
    } catch (e: any) {
      setToast(e.message);
      // 失败也要刷新（2026-08-27 补）：后端现在会说「刚刚被别人改过，请刷新后再看」，
      // 页面不刷新的话用户看到的还是旧数字，容易照着旧数字再操作一次。
      await loadDetail(tid);
      await loadTasks();
    } finally { setAdvancing(false); }
  };

  // ======== 装柜 ========
  const handleLoading = async () => {
    const tid = selectedTaskId;
    if (!tid) return;
    if (!guardDetailOwner(tid)) return; // 2026-09-02 终审整改：防止装柜落错任务
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
      
      // ⚠️ 这份表头和下面 addRow 的取值顺序必须一一对应，改一处就要改另一处。
      //    「产品图片」必须留在最后一列：下面用 headers.length 定位图片列。
      const headers = ["唛头", "运单号", "产品名称", "件数", "装箱数量", "总数量", "单件重量", "总重量", "长(cm)", "宽(cm)", "高(cm)", "体积(m³)", "材质", "货值", "货型", "产品图片"];
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
          r.material ?? "", r.cargoValue ?? "", r.cargoType ?? "",
          "" // 产品图片列：先占位，图片在第二遍统一嵌入
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
    <RoleShell allowedRole={["staff", "admin"]} title="集货拼柜管理" variant="a3">
      {toast && (
        <div onClick={() => setToast("")} style={{ position: "fixed", top: 20, right: 20, zIndex: 9999, background: "#14171D", color: "var(--white)", padding: "10px 20px", borderRadius: 8, boxShadow: "0 4px 12px rgba(0,0,0,0.3)", cursor: "pointer" }}>
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
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ padding: "6px 10px", border: "1px solid var(--l-strong)", borderRadius: 6, fontSize: 13 }}>
              <option value="">全部状态</option>
              {ALL_STATUSES.map((s) => <option key={s} value={s}>{STATUS_ZH[s]}</option>)}
            </select>
            <input placeholder="搜索任务编号 / 客户名" value={searchText} onChange={(e) => setSearchText(e.target.value)} style={{ padding: "6px 12px", border: "1px solid var(--l-strong)", borderRadius: 6, fontSize: 13, width: 220 }} />
          </div>

          {loading ? <p style={{ color: "var(--t-muted)" }}>加载中...</p> : filteredTasks.length === 0 ? <p style={{ color: "var(--t-faint)", textAlign: "center", padding: 40 }}>暂无任务</p> : (
            <div style={{ overflowX: "auto" }}>
              <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "var(--s-sunken)" }}>
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
                    <tr key={t.id} onClick={() => { selectedTaskIdRef.current = t.id; /* 2026-09-02 终审整改：认主人 ref 在点击处同步赋值，不等 useEffect */ setSelectedTaskId(t.id); }} style={{ borderBottom: "1px solid var(--l-soft)", cursor: "pointer", transition: "background 0.15s" }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--s-alt)"; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ""; }}>
                      <td style={{ ...tdS, fontWeight: 600, whiteSpace: "nowrap", minWidth: 140 }}>{t.taskNo}</td>
                      <td style={{ ...tdS, minWidth: 80 }}>{t.clientName || "-"}</td>
                      <td style={{ ...tdS, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.destinationTh}</td>
                      <td style={tdS}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <div style={{ flex: 1, height: 6, background: "var(--l-soft)", borderRadius: 3, overflow: "hidden", maxWidth: 120 }}>
                            <div style={{ height: "100%", width: `${Math.min(t.volumePercent, 100)}%`, background: t.volumePercent >= 85 ? (t.volumePercent >= 100 ? "var(--c-green-2)" : "var(--c-amber)") : "#1e3a8a", borderRadius: 3 }} />
                          </div>
                          <span style={{ fontSize: 11, color: "var(--t-muted)", whiteSpace: "nowrap" }}>{t.totalVolumeM3}/{t.maxVolumeM3}</span>
                        </div>
                      </td>
                      <td style={tdS}><span style={{ fontSize: 11, padding: "2px 6px", borderRadius: 4, background: t.status === "completed" ? "var(--c-green-bg)" : t.status === "cancelled" ? "var(--c-red-bg)" : "var(--c-blue-bg-2)", color: t.status === "completed" ? "var(--c-green-deep)" : t.status === "cancelled" ? "var(--c-red-dark)" : "var(--c-blue-deep)", whiteSpace: "nowrap" }}>{STATUS_ZH[t.status] || t.status}</span></td>
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
            <button onClick={() => { selectedTaskIdRef.current = null; /* 2026-09-02 终审整改：返回列表也要同步改主人 ref，在途的详情响应才拦得住 */ setSelectedTaskId(null); setPreviewImage(null); setShowReceive(null); setShowQuote(false); setShowLoadingForm(false); setCancelStep(0); setCancelPwdPrompt(""); setCancelPassword(""); setExpandedPrealerts(new Set()); setReviewSubmitting(false); setShowRejectDialog(false); setRejectReason(""); setToast(""); loadTasks(); }} style={{ padding: "6px 14px", border: "1px solid var(--l-strong)", background: "var(--white)", color: "var(--t-muted)", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>← 返回</button>
            <h2 style={{ fontSize: 20, margin: 0 }}>{taskDetail.taskNo}</h2>
            <div style={{ fontSize: 12, color: "var(--t-muted)", marginBottom: 8 }}>创建时间：{formatBeijingTime(taskDetail.createdAt)}</div>
            <span style={{ color: "var(--t-muted)", fontSize: 13 }}>{taskDetail.clientName}</span>
            <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, background: "var(--c-blue-bg-2)", color: "var(--c-blue-deep)" }}>{STATUS_ZH[taskDetail.status] || taskDetail.status}</span>
            <div style={{ flex: 1 }} />
            <button onClick={handleExport} style={{ padding: "6px 14px", background: "var(--c-green)", color: "var(--white)", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>导出 Excel</button>
          </div>

          {/* 进度条 */}
          {showProgress && (
            <div style={{ marginBottom: 20, padding: 16, background: "var(--s-alt)", borderRadius: 10, border: "1px solid var(--l-soft)" }}>
              <div style={{ height: 20, background: "var(--l-soft)", borderRadius: 10, overflow: "hidden", position: "relative" }}>
                <div style={{ height: "100%", width: `${Math.min(taskDetail.volumePercent, 100)}%`, background: taskDetail.volumePercent >= 85 ? (taskDetail.volumePercent >= 100 ? "var(--c-green-2)" : "var(--c-amber)") : "#1e3a8a", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {taskDetail.volumePercent > 15 && <span style={{ fontSize: 11, color: "var(--white)", fontWeight: 600 }}>{taskDetail.totalVolumeM3} m³ ({taskDetail.volumePercent}%)</span>}
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--t-faint)", marginTop: 2 }}>
                <span>0</span><span>{taskDetail.maxVolumeM3} m³</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8, marginTop: 10, textAlign: "center" }}>
                <div><div style={{ fontSize: 18, fontWeight: 700 }}>{taskDetail.totalPrealerts}</div><div style={{ fontSize: 11, color: "var(--t-muted)" }}>预报单</div></div>
                <div><div style={{ fontSize: 18, fontWeight: 700 }}>{taskDetail.totalPackages}</div><div style={{ fontSize: 11, color: "var(--t-muted)" }}>总件数</div></div>
                <div><div style={{ fontSize: 18, fontWeight: 700 }}>{taskDetail.totalVolumeM3}</div><div style={{ fontSize: 11, color: "var(--t-muted)" }}>已收体积</div></div>
                <div><div style={{ fontSize: 18, fontWeight: 700 }}>{Math.max(0, taskDetail.maxVolumeM3 - taskDetail.totalVolumeM3).toFixed(1)}</div><div style={{ fontSize: 11, color: "var(--t-muted)" }}>剩余空间</div></div>
              </div>
            </div>
          )}

          {/* 装柜后信息 */}
          {!showProgress && (
            <div style={{ marginBottom: 20, padding: 16, background: "var(--c-blue-bg)", borderRadius: 10, border: "1px solid #E4E6EC" }}>
              <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
                {taskDetail.containerNo && <div><span style={{ fontSize: 12, color: "var(--t-muted)" }}>柜号</span><div style={{ fontWeight: 600 }}>{taskDetail.containerNo}</div></div>}
                {taskDetail.loadingDate && <div><span style={{ fontSize: 12, color: "var(--t-muted)" }}>装柜日期</span><div style={{ fontWeight: 600 }}>{taskDetail.loadingDate}</div></div>}
                <div><span style={{ fontSize: 12, color: "var(--t-muted)" }}>物流状态</span><div style={{ fontWeight: 600 }}>{STATUS_ZH[taskDetail.status]}</div></div>
              </div>
            </div>
          )}

          {/* 满柜确认 */}
          {isFull && taskDetail.status === "collecting" && (
            <div style={{ marginBottom: 16, padding: "12px 16px", background: "#fffbeb", borderRadius: 8, border: "1px solid #fde68a", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontWeight: 600, color: "var(--c-amber-deep)", fontSize: 14 }}>已到 {taskDetail.maxVolumeM3} 方，请确认满柜</span>
              <button onClick={handleConfirmFull} style={{ padding: "6px 16px", background: "var(--c-blue)", color: "var(--white)", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600, fontSize: 13 }}>确认满柜</button>
            </div>
          )}

          {/* 操作区 */}
          <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
            {/* 报价 */}
            {(taskDetail.status === "full_confirmed" || taskDetail.status === "quoted") && (
              <button onClick={() => setShowQuote(true)} style={actionBtn("var(--c-blue)")}>
                {taskDetail.status === "quoted" ? "修改报价" : "录入报价"}
              </button>
            )}

            {/* 状态推进按钮 */}
            {actionButtons?.map((b) => (
              b.toStatus === "loading" ? (
                <button key={b.toStatus} onClick={() => setShowLoadingForm(true)} style={actionBtn("var(--c-blue)")} disabled={advancing}>{b.label}</button>
              ) : (
                <button key={b.toStatus} onClick={() => handleAdvance(b.toStatus)} style={actionBtn("var(--c-blue)")} disabled={advancing}>{advancing ? "处理中..." : b.label}</button>
              )
            ))}

            {/* 取消。⚠️ 不能写 onClick={handleCancel}：它现在带可选密码参数，直接传会把点击事件当密码 */}
            {["collecting", "full_confirmed", "quoted"].includes(taskDetail.status) && (
              <button onClick={() => handleCancel()} style={actionBtn("var(--c-red)")} disabled={cancelSubmitting}>
                {cancelSubmitting ? "取消中..." : cancelStep === 1 ? "确认取消" : "取消任务"}
              </button>
            )}
            {cancelStep === 1 && (
              <button onClick={() => setCancelStep(0)} style={{ ...actionBtnBase, border: "1px solid var(--l-strong)", color: "var(--t-muted)", background: "var(--white)" }}>返回</button>
            )}
          </div>

          {/* 付款审核区域 */}
          {taskDetail.paymentStatus === "pending_review" && (
            <div style={{ marginBottom: 16, padding: "16px", background: "var(--c-amber-bg)", borderRadius: 8, border: "1px solid var(--c-amber)" }}>
              <div style={{ fontWeight: 700, color: "var(--c-amber-deep)", fontSize: 15, marginBottom: 8 }}>待审核付款</div>
              {taskDetail.paymentProofBase64 && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 12, color: "var(--t-muted)", marginBottom: 4 }}>付款截图</div>
                  <img src={taskDetail.paymentProofBase64} alt="付款凭证" style={{ maxWidth: "100%", maxHeight: 300, borderRadius: 6, cursor: "pointer", border: "1px solid var(--l-soft)" }}
                    onClick={() => setPreviewImage(taskDetail.paymentProofBase64!)} />
                </div>
              )}
              <div style={{ fontSize: 13, color: "var(--c-amber-deep)", marginBottom: 10 }}>
                上传时间：{taskDetail.paymentProofUploadedAt ? formatBeijingTime(taskDetail.paymentProofUploadedAt) : "-"}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={handleApprovePayment} disabled={reviewSubmitting} style={{ padding: "8px 20px", background: "var(--c-blue)", color: "var(--white)", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}>
                  {reviewSubmitting ? "处理中..." : "✓ 审核通过"}
                </button>
                <button onClick={() => setShowRejectDialog(true)} disabled={reviewSubmitting} style={{ padding: "8px 20px", border: "1px solid var(--l-strong)", color: "var(--t-muted)", background: "var(--white)", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}>
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
                <button onClick={handleRejectPayment} disabled={reviewSubmitting} style={{ padding: "8px 18px", background: "var(--c-blue)", color: "var(--white)", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}>
                  {reviewSubmitting ? "提交中..." : "确认拒绝"}
                </button>
                <button onClick={() => { setShowRejectDialog(false); setRejectReason(""); }} style={{ padding: "8px 18px", border: "1px solid var(--l-strong)", background: "var(--white)", color: "var(--t-muted)", borderRadius: 6, cursor: "pointer" }}>取消</button>
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
                <div style={{ borderTop: "2px solid var(--c-green-2)", paddingTop: 8, fontSize: 20, fontWeight: 700, color: "var(--c-green-2)" }}>总价：¥{totalFee.toLocaleString()}</div>
              </div>
              <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
                <button onClick={handleQuote} disabled={quoteSubmitting} style={{ padding: "8px 18px", background: "var(--c-blue)", color: "var(--white)", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}>{quoteSubmitting ? "保存中..." : "保存报价"}</button>
                <button onClick={() => setShowQuote(false)} style={{ padding: "8px 18px", border: "1px solid var(--l-strong)", background: "var(--white)", color: "var(--t-muted)", borderRadius: 6, cursor: "pointer" }}>取消</button>
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
                <button onClick={handleLoading} disabled={loadingSubmitting} style={{ padding: "8px 18px", background: "var(--c-blue)", color: "var(--white)", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}>{loadingSubmitting ? "提交中..." : "确认装柜"}</button>
                <button onClick={() => setShowLoadingForm(false)} style={{ padding: "8px 18px", border: "1px solid var(--l-strong)", background: "var(--white)", color: "var(--t-muted)", borderRadius: 6, cursor: "pointer" }}>取消</button>
              </div>
            </Modal>
          )}

          {/* 预报单 */}  
          <h3 style={{ fontSize: 16, marginBottom: 12 }}>预报单</h3>

          {pendingPrealerts.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <h4 style={{ fontSize: 14, color: "var(--c-amber)", marginBottom: 8 }}>待签收 ({pendingPrealerts.length})</h4>
              {pendingPrealerts.map((pa) => <StaffPrealertRow key={pa.id} pa={pa} taskStatus={taskDetail.status} expanded={expandedPrealerts} setExpanded={setExpandedPrealerts} onReceive={() => setShowReceive(pa)} setPreviewImage={setPreviewImage} />)}
            </div>
          )}

          {receivedPrealerts.length > 0 && (
            <div>
              <h4 style={{ fontSize: 14, color: "var(--c-green-2)", marginBottom: 8 }}>已签收 ({receivedPrealerts.length})</h4>
              {receivedPrealerts.map((pa) => <StaffPrealertRow key={pa.id} pa={pa} taskStatus={taskDetail.status} expanded={expandedPrealerts} setExpanded={setExpandedPrealerts} setPreviewImage={setPreviewImage} />)}
            </div>
          )}

          {pendingPrealerts.length === 0 && receivedPrealerts.length === 0 && (
            <p style={{ color: "var(--t-faint)", textAlign: "center", padding: 20 }}>暂无预报单</p>
          )}

          {/* 状态时间线 */}
          {taskDetail.statusLogs && taskDetail.statusLogs.length > 0 && (
            <div style={{ marginTop: 28 }}>
              <h3 style={{ fontSize: 16, marginBottom: 12 }}>状态记录</h3>
              <div style={{ position: "relative", paddingLeft: 24, borderLeft: "2px solid var(--l-soft)", marginLeft: 8 }}>
                {taskDetail.statusLogs.map((log: any, i: number) => (
                  <div key={log.id || i} style={{ marginBottom: 14, position: "relative" }}>
                    <div style={{ position: "absolute", left: -30, top: 4, width: 12, height: 12, borderRadius: "50%", background: "#1e3a8a", border: "2px solid var(--white)" }} />
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{STATUS_ZH[log.fromStatus] || log.fromStatus} → {STATUS_ZH[log.toStatus] || log.toStatus}</div>
                    <div style={{ fontSize: 12, color: "var(--t-muted)" }}>{log.operatorName} · {formatBeijingTime(log.createdAt)}</div>
                    {log.remark && <div style={{ fontSize: 12, color: "var(--t-faint)", marginTop: 2 }}>{log.remark}</div>}
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
            <span style={{ color: "var(--t-muted)" }}>唛头：</span>{showReceive.mark}
            {showReceive.expressNo && <><span style={{ color: "var(--t-muted)", marginLeft: 16 }}>快递单号：</span>{showReceive.expressNo}</>}
          </div>
          <div style={{ overflowX: "auto", marginBottom: 16 }}>
            <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "var(--s-alt)" }}>
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
                  <th style={thS}>货型</th>
                </tr>
              </thead>
              <tbody>
                {showReceive.products.map((p, i) => (
                  <tr key={p.id} style={{ borderBottom: "1px solid var(--l-soft)" }}>
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
                    <td style={tdS}>{p.cargoType === "inspection" ? "商检货" : p.cargoType === "sensitive" ? "敏感货" : "普货"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ borderTop: "1px solid var(--l-soft)", paddingTop: 12 }}>
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
                <img src={`data:${receiveProofMime || "image/png"};base64,${receiveProofBase64}`} alt="签收照片预览" style={{ maxWidth: 200, maxHeight: 150, borderRadius: 6, border: "1px solid var(--l-soft)" }} />
              </div>
            )}
          </div>
          <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
            <button onClick={handleReceive} disabled={receiveSubmitting || !receiveProofBase64} style={{ padding: "8px 20px", background: !receiveProofBase64 ? "var(--t-faint)" : "var(--c-blue)", color: "var(--white)", border: "none", borderRadius: 6, cursor: receiveProofBase64 ? "pointer" : "not-allowed", fontWeight: 600 }}>{receiveSubmitting ? "签收中..." : !receiveProofBase64 ? "请上传签收照片" : "确认签收"}</button>
            <button onClick={() => { setShowReceive(null); setReceiveProofBase64(""); setReceiveProofFileName(""); setReceiveProofMime(""); }} style={{ padding: "8px 20px", border: "1px solid var(--l-strong)", background: "var(--white)", borderRadius: 6, cursor: "pointer", color: "var(--t-muted)" }}>取消</button>
          </div>
        </Modal>
      )}

      {/* ======== 取消任务要管理员密码（2026-08-31，交互照管理员端删除任务那套）======== */}
      {cancelPwdPrompt && (
        <Modal onClose={() => { setCancelPwdPrompt(""); setCancelPassword(""); setCancelAdminAccount(""); setCancelStep(0); }}>
          <p style={{ marginTop: 0, fontWeight: 600 }}>取消这个集货任务需要管理员账号和管理员密码</p>
          <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 6, padding: 10, marginBottom: 12, fontSize: 13, color: "var(--c-red-deep)", lineHeight: 1.7 }}>
            {cancelPwdPrompt}
          </div>
          {/* 2026-08-31 Codex 复核补：要写清是哪个管理员拍的板，后端只验这一个账号的密码 */}
          <input
            type="text"
            value={cancelAdminAccount}
            onChange={(e) => setCancelAdminAccount(e.target.value)}
            placeholder="管理员账号"
            style={{ width: "100%", border: "1px solid var(--l-strong)", borderRadius: 6, padding: "6px 10px", fontSize: 13, boxSizing: "border-box", marginBottom: 8 }}
          />
          <input
            type="password"
            value={cancelPassword}
            onChange={(e) => setCancelPassword(e.target.value)}
            placeholder="管理员密码"
            style={{ width: "100%", border: "1px solid var(--l-strong)", borderRadius: 6, padding: "6px 10px", fontSize: 13, boxSizing: "border-box" }}
          />
          <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
            <button onClick={() => handleCancel(cancelPassword.trim(), cancelAdminAccount.trim())} disabled={cancelSubmitting || !cancelPassword.trim() || !cancelAdminAccount.trim()} style={{ padding: "8px 16px", background: cancelPassword.trim() && cancelAdminAccount.trim() ? "var(--c-red)" : "var(--l-strong)", color: "var(--white)", border: "none", borderRadius: 6, cursor: cancelPassword.trim() && cancelAdminAccount.trim() ? "pointer" : "not-allowed", fontWeight: 600 }}>{cancelSubmitting ? "取消中..." : "确认取消任务"}</button>
            <button onClick={() => { setCancelPwdPrompt(""); setCancelPassword(""); setCancelAdminAccount(""); setCancelStep(0); }} style={{ padding: "8px 16px", border: "1px solid var(--l-strong)", background: "var(--white)", color: "var(--t-muted)", borderRadius: 6, cursor: "pointer" }}>返回</button>
          </div>
        </Modal>
      )}

      {/* ======== 签收成功但要留意的提醒（2026-08-31：付款后才签收）======== */}
      {receiveWarning && (
        <Modal onClose={() => setReceiveWarning("")}>
          <h3 style={{ marginTop: 0 }}>签收成功，但有一件事要留意</h3>
          <div style={{ background: "var(--c-amber-bg)", border: "1px solid var(--c-amber)", borderRadius: 6, padding: 12, fontSize: 13, color: "var(--c-amber-deep)", lineHeight: 1.7 }}>
            {receiveWarning}
          </div>
          <div style={{ marginTop: 14 }}>
            <button onClick={() => setReceiveWarning("")} style={{ padding: "8px 20px", background: "var(--c-blue)", color: "var(--white)", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}>知道了</button>
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
    <div style={{ border: "1px solid var(--l-soft)", borderRadius: 8, padding: 12, marginBottom: 8, background: "var(--white)", cursor: "pointer" }} onClick={toggle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flex: 1 }}>
          <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", minWidth: 160 }}>{pa.trackingNo}</span>
          <span style={{ fontSize: 13, whiteSpace: "nowrap", minWidth: 100 }}>{pa.mark}</span>
          {pa.expressNo && <span style={{ fontSize: 11, color: "var(--t-faint)" }}>快递: {pa.expressNo}</span>}
          <span style={{ fontSize: 11, color: "var(--t-faint)" }}>{formatBeijingTime(pa.createdAt)}</span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "var(--t-muted)", whiteSpace: "nowrap" }}>{totalPkg}件 / {totalVol.toFixed(3)}m³</span>
          <span style={{ fontSize: 11, padding: "2px 6px", borderRadius: 4, background: pa.status === "received" ? "var(--c-green-bg)" : "var(--c-amber-bg)", color: pa.status === "received" ? "var(--c-green-deep)" : "var(--c-amber-deep)", whiteSpace: "nowrap" }}>{STATUS_ZH[pa.status]}</span>
          {pa.status === "pending" && onReceive && (
            <button onClick={(e) => { e.stopPropagation(); onReceive(); }} style={{ padding: "3px 10px", background: "var(--c-blue)", color: "var(--white)", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 11, fontWeight: 600 }}>签收</button>
          )}
        </div>
      </div>

      {open && (
        <div style={{ marginTop: 10 }} onClick={(e) => e.stopPropagation()}>
          {pa.status === "received" && pa.signedAt && (
            <div style={{ fontSize: 12, color: "var(--t-muted)", marginBottom: 8 }}>
              签收时间：{formatBeijingTime(pa.signedAt)}
              {pa.receivedProofBase64 && (
                <div style={{ marginTop: 6 }}>
                  <img src={pa.receivedProofBase64} alt="签收照片" style={{ maxWidth: 160, maxHeight: 120, borderRadius: 6, border: "1px solid var(--l-soft)", cursor: "pointer", verticalAlign: "middle" }}
                    onClick={(e) => { e.stopPropagation(); setPreviewImage(pa.receivedProofBase64!); }} />
                </div>
              )}
            </div>
          )}
          <div style={{ overflowX: "auto" }}>
          <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ background: "var(--s-alt)" }}>
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
                <th style={thS}>货型</th>
                <th style={thS}>图片</th>
              </tr>
            </thead>
            <tbody>
              {pa.products.map((p, i) => (
                <tr key={p.id} style={{ borderBottom: "1px solid var(--l-soft)" }}>
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
                  <td style={tdS}>{p.cargoType === "inspection" ? "商检货" : p.cargoType === "sensitive" ? "敏感货" : "普货"}</td>
                  <td style={{ ...tdS, textAlign: "center" }}>
                    {p.productImageBase64 ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); setPreviewImage(p.productImageBase64); }}
                        style={{ padding: "3px 10px", border: "1px solid var(--c-blue)", color: "var(--c-blue)", background: "var(--white)", borderRadius: 4, cursor: "pointer", fontSize: 12 }}
                      >查看图片</button>
                    ) : (
                      <span style={{ color: "var(--t-faint)", fontSize: 12 }}>暂无图片</span>
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
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--white)", borderRadius: 12, padding: 24, maxWidth: wide ? 1100 : 460, width: "90%", maxHeight: "85vh", overflowY: "auto", boxShadow: "0 8px 32px rgba(0,0,0,0.2)" }}>
        {children}
      </div>
    </div>
  );
}

// ============================================================================
// 样式
// ============================================================================
const thS: React.CSSProperties = { textAlign: "left", padding: "6px 10px", fontSize: 12, color: "var(--t-muted)", fontWeight: 600, borderBottom: "2px solid var(--l-soft)" };
const tdS: React.CSSProperties = { padding: "7px 10px", fontSize: 12 };
const fl: React.CSSProperties = { display: "block", fontSize: 13, color: "var(--t-body)", fontWeight: 500, marginBottom: 3 };
const fi: React.CSSProperties = { width: "100%", padding: "7px 10px", border: "1px solid var(--l-strong)", borderRadius: 6, fontSize: 13, boxSizing: "border-box" };
const actionBtn = (bg: string): React.CSSProperties => ({ padding: "6px 16px", background: bg, color: "var(--white)", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 });
const actionBtnBase: React.CSSProperties = { padding: "6px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
