"use client";

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import {
  fetchAdminConsolidationTasks,
  fetchStaffConsolidationTaskDetail,
  deleteAdminConsolidationTask,
  adminForceEditConsolidationPrealert,
  adminDeleteConsolidationPrealert,
  adminDeleteConsolidationProduct,
  reviewConsolidationPayment,
  rejectConsolidationPayment,
  revokeConsolidationPayment,
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
// 产品表单行
// ============================================================================
interface ProductFormRow {
  key: number;
  /** 已有产品行的编号；新加的行为空，后端据此判断是改还是新增 */
  id?: string;
  productName: string;
  packageCount: string;
  quantityPerBox: string;
  unitWeightKg: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  material: string;
  cargoValue: string;
  cargoType: string;
  productImage?: { fileName?: string; mime?: string; base64?: string };
}

function emptyProductRow(key: number): ProductFormRow {
  return { key, productName: "", packageCount: "", quantityPerBox: "1", unitWeightKg: "", lengthCm: "", widthCm: "", heightCm: "", material: "", cargoValue: "", cargoType: "normal" };
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

  // 管理员删单件货物（2026-08-15）
  const [deleteProductTarget, setDeleteProductTarget] = useState<{ product: ConsolidationPrealertItem["products"][number]; trackingNo: string } | null>(null);
  const [deleteProductSubmitting, setDeleteProductSubmitting] = useState(false);

  // 展开
  const [expandedPrealerts, setExpandedPrealerts] = useState<Set<string>>(new Set());
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  // ======== 数据 ========
  // 2026-09-01 竞态全扫：快速切状态筛选时，先回来的旧响应不许盖掉新筛选的列表
  const tasksGate = useRef(createRequestGate()).current;
  const loadTasks = useCallback(async () => {
    const ticket = tasksGate.begin();
    setLoading(true);
    try {
      const data = await fetchAdminConsolidationTasks(statusFilter || undefined);
      if (!tasksGate.isCurrent(ticket)) return; // 号作废：旧筛选的数据不许上屏
      setTasks(data);
    } catch (e: any) {
      if (!tasksGate.isCurrent(ticket)) return; // 旧请求的报错也不许乱入
      setToast(e.message);
    } finally {
      if (tasksGate.isCurrent(ticket)) setLoading(false); // 旧请求不许提前掐掉新请求的加载态
    }
  }, [statusFilter, tasksGate]);

  // 2026-09-01 竞态全扫：详情要认主人——响应回来时核对还是不是当前选中的那个任务
  const selectedTaskIdRef = useRef<string | null>(null);

  /** 2026-09-02 终审整改：换选中任务必须在用户点击处**同步**赋值 ref，useEffect 里那句只作兜底。
      只靠 useEffect 的话，点击到 effect 跑起来之间有间隙，旧任务的晚响应在间隙里核对的还是旧 ref，
      会照样落地盖到错的任务上。所有改选中任务的入口一律走这里。 */
  const selectTask = (id: string | null) => {
    selectedTaskIdRef.current = id; // 点击处同步认主人，晚到的旧响应立刻失效
    setTaskDetail(null);            // 旧任务的详情内容不许在新任务名下多留一帧
    setSelectedTaskId(id);
  };

  const loadDetail = useCallback(async (taskId: string) => {
    try {
      const data = await fetchStaffConsolidationTaskDetail(taskId);
      if (selectedTaskIdRef.current !== taskId) return; // 已切走/已返回列表：A 的详情不许挂在 B 名下
      setTaskDetail(data);
    } catch (e: any) {
      if (selectedTaskIdRef.current !== taskId) return;
      setToast(e.message);
    }
  }, []);

  useEffect(() => { loadTasks(); }, [loadTasks]);
  useEffect(() => {
    selectedTaskIdRef.current = selectedTaskId; // 认主人用：始终指向最新选中的任务
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

  // ======== 删除任务（2026-08-07 重做）========
  // 原来这里直接调删除，而且调的接口后端根本不存在（DELETE /admin/consolidation/tasks），
  // 点了必然失败。现在改成：打开弹窗先预检，把「会连带删掉什么」摆出来；
  // 后端拦住时（已收货 / 已开始走流程）再要求输管理员密码强删。
  const [deletePreview, setDeletePreview] = useState<{ willDelete: Record<string, number>; blockers: string[]; refundTotal?: number; refundCount?: number } | null>(null);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteError, setDeleteError] = useState("");
  /* 2026-09-01 竞态全扫：删除预检要认主人。
     - deleteTaskIdRef：当前删除弹窗对着哪个任务（预检响应回来先核对，不是他就丢弃）
     - deletePreviewForRef：deletePreview 里这份预检结果属于哪个任务
       （确认删除前必须和要删的任务一致——展示与执行必须同一个 id，不一致拒绝） */
  const deleteTaskIdRef = useRef<string | null>(null);
  const deletePreviewForRef = useRef<string | null>(null);
  useEffect(() => { deleteTaskIdRef.current = deleteTaskId; }, [deleteTaskId]); // 弹窗在别处被关掉时 ref 也跟上

  /** 打开删除弹窗时先问后端：这个任务删了会带走什么、有没有被拦 */
  const openDeleteTask = async (tid: string) => {
    setDeleteTaskId(tid);
    deleteTaskIdRef.current = tid; // 不等重渲染，立刻指向新任务
    setDeletePreview(null);
    deletePreviewForRef.current = null;
    setDeletePassword("");
    setDeleteError("");
    try {
      const r = await deleteAdminConsolidationTask(tid, { dryRun: true });
      // 2026-09-01 竞态全扫·认主人：回来时弹窗已换成别的任务（或已关闭），A 的预检不许挂到 B 的弹窗里
      if (deleteTaskIdRef.current !== tid) return;
      setDeletePreview({ willDelete: r.willDelete, blockers: r.blockers, refundTotal: r.refundTotal, refundCount: r.refundCount });
      deletePreviewForRef.current = tid;
    } catch (e: any) {
      if (deleteTaskIdRef.current !== tid) return; // 旧预检的报错也不许乱入
      setDeleteError(e?.message ?? "预检失败");
    }
  };

  const handleDeleteTask = async () => {
    const tid = deleteTaskId;
    if (!tid) return;
    // 2026-09-01 竞态全扫：确认删除前核对「屏幕上这份预检」和「要删的任务」是同一个 id。
    // 对不上说明预检数据是别的任务的（或还没回来），拒绝执行，防止看着 A 的清单删了 B。
    if (deletePreviewForRef.current !== tid) {
      setDeleteError("预检数据和当前任务对不上，请关闭弹窗后重新点删除");
      return;
    }
    setDeleteTaskSubmitting(true);
    setDeleteError("");
    try {
      await deleteAdminConsolidationTask(tid, deletePassword.trim() ? { confirmPassword: deletePassword.trim() } : undefined);
      setToast("任务已删除");
      setDeleteTaskId(null);
      setDeletePassword("");
      if (selectedTaskId === tid) selectTask(null); // 2026-09-02 终审整改：走统一入口，同步认主人
      await loadTasks();
    } catch (e: any) {
      setDeleteError(e?.message ?? "删除失败");
      // 失败也要刷新（2026-08-27 补）：后端现在会说「刚刚被别人改过，请刷新后再看」，
      // 页面不刷新的话用户看到的还是旧数字，容易照着旧数字再操作一次。
      await loadTasks();
    } finally { setDeleteTaskSubmitting(false); }
  };

  // 撤销付款（2026-08-07）
  const [revoking, setRevoking] = useState(false);

  /**
   * 撤销这笔集货付款：钱退回客户的集货余额，任务回到「未付款」。
   * 退多少由后端按流水里实际扣过的钱算。
   */
  const handleRevokePayment = async () => {
    if (!selectedTaskId) return;
    const reason = prompt("撤销这笔付款？\n\n钱会退回客户的集货余额，任务回到「未付款」。\n请填写撤销原因（会记进流水和日志）：");
    if (reason == null) return;
    setRevoking(true);
    try {
      const r = await revokeConsolidationPayment({ taskId: selectedTaskId, reason: reason.trim() || undefined });
      setToast(r?.message ?? "已撤销并退款");
      await loadDetail(selectedTaskId);
      await loadTasks();
    } catch (e: any) {
      setToast(e?.message ?? "撤销失败");
      // 失败也要刷新（2026-08-27 补）：后端现在会说「刚刚被别人改过，请刷新后再看」，
      // 页面不刷新的话用户看到的还是旧数字，容易照着旧数字再操作一次。
      await loadDetail(selectedTaskId);
      await loadTasks();
    }
    finally { setRevoking(false); }
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
    } catch (e: any) {
      setToast(e.message);
      // 失败也要刷新（2026-08-27 补）：后端现在会说「刚刚被别人改过，请刷新后再看」，
      // 页面不刷新的话用户看到的还是旧数字，容易照着旧数字再操作一次。
      if (selectedTaskId) await loadDetail(selectedTaskId);
      await loadTasks();
    }
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
    } catch (e: any) {
      setToast(e.message);
      // 失败也要刷新（2026-08-27 补）：后端现在会说「刚刚被别人改过，请刷新后再看」，
      // 页面不刷新的话用户看到的还是旧数字，容易照着旧数字再操作一次。
      if (selectedTaskId) await loadDetail(selectedTaskId);
      await loadTasks();
    }
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
        id: p.id,
        productName: p.productName,
        packageCount: String(p.packageCount),
        quantityPerBox: String(p.quantityPerBox),
        unitWeightKg: String(p.unitWeight ?? ""),
        lengthCm: String(p.length ?? ""),
        widthCm: String(p.width ?? ""),
        heightCm: String(p.height ?? ""),
        material: p.material,
        cargoValue: p.cargoValue,
        cargoType: p.cargoType || "normal",
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
        id: r.id,
        productName: r.productName.trim(),
        packageCount: parseInt(r.packageCount),
        quantityPerBox: parseInt(r.quantityPerBox),
        unitWeightKg: parseFloat(r.unitWeightKg),
        lengthCm: parseFloat(r.lengthCm),
        widthCm: parseFloat(r.widthCm),
        heightCm: parseFloat(r.heightCm),
        material: r.material.trim(),
        cargoValue: r.cargoValue.trim(),
        cargoType: r.cargoType || "normal",
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
    } catch (e: any) {
      setToast(e.message);
      // 失败也要刷新（2026-08-27 补）：后端现在会说「刚刚被别人改过，请刷新后再看」，
      // 页面不刷新的话用户看到的还是旧数字，容易照着旧数字再操作一次。
      if (selectedTaskId) await loadDetail(selectedTaskId);
      await loadTasks();
    } finally { setDeletePrealertSubmitting(false); }
  };

  // ======== 管理员删单件货物（2026-08-15）========
  // 界线：客户还没交钱、任务还没进装柜，跟后端同一条。
  // 状态这里用黑名单（只锁已装柜及以后），跟后端 TASK_LOCKED_FOR_PRODUCT_DELETE 一致；
  // 用白名单会漏掉 full_confirmed / quoted 这两档还没付款的。
  const canDeleteProducts = !!taskDetail
    && taskDetail.paymentStatus === "unpaid"
    && !["loading", "in_transit", "customs", "delivering", "completed", "cancelled"].includes(taskDetail.status);

  const handleAdminDeleteProduct = async () => {
    if (!deleteProductTarget) return;
    setDeleteProductSubmitting(true);
    try {
      await adminDeleteConsolidationProduct(deleteProductTarget.product.id);
      setDeleteProductTarget(null);
      setToast("货物已删除，请自行核对任务总价");
      if (selectedTaskId) await loadDetail(selectedTaskId);
      await loadTasks();
    } catch (e: any) {
      setToast(e.message);
      // 失败也要刷新（2026-08-27 补）：后端现在会说「刚刚被别人改过，请刷新后再看」，
      // 页面不刷新的话用户看到的还是旧数字，容易照着旧数字再操作一次。
      if (selectedTaskId) await loadDetail(selectedTaskId);
      await loadTasks();
    } finally { setDeleteProductSubmitting(false); }
  };

  const pendingPrealerts = useMemo(() => taskDetail?.prealerts?.filter((p) => p.status === "pending") ?? [], [taskDetail]);
  const receivedPrealerts = useMemo(() => taskDetail?.prealerts?.filter((p) => p.status === "received") ?? [], [taskDetail]);

  const showProgress = taskDetail && !["loading", "in_transit", "customs", "delivering", "completed", "cancelled"].includes(taskDetail.status);

  // ======== 渲染 ========
  return (
    <>
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
                    <th style={thS}></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTasks.map((t) => (
                    <tr key={t.id} style={{ borderBottom: "1px solid var(--l-soft)", cursor: "pointer" }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--s-alt)"; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ""; }}>
                      <td onClick={() => selectTask(t.id)} style={{ ...tdS, fontWeight: 600, whiteSpace: "nowrap", minWidth: 140 }}>{t.taskNo}</td>
                      <td onClick={() => selectTask(t.id)} style={{ ...tdS, minWidth: 80 }}>{t.clientName || "-"}</td>
                      <td onClick={() => selectTask(t.id)} style={{ ...tdS, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.destinationTh}</td>
                      <td onClick={() => selectTask(t.id)} style={tdS}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <div style={{ flex: 1, height: 6, background: "var(--l-soft)", borderRadius: 3, overflow: "hidden", maxWidth: 120 }}>
                            <div style={{ height: "100%", width: `${Math.min(t.volumePercent, 100)}%`, background: t.volumePercent >= 85 ? (t.volumePercent >= 100 ? "var(--c-green-2)" : "var(--c-amber)") : "#1e3a8a", borderRadius: 3 }} />
                          </div>
                          <span style={{ fontSize: 11, color: "var(--t-muted)", whiteSpace: "nowrap" }}>{t.totalVolumeM3}/{t.maxVolumeM3}</span>
                        </div>
                      </td>
                      <td onClick={() => selectTask(t.id)} style={tdS}>
                        <span style={{ fontSize: 11, padding: "2px 6px", borderRadius: 4, background: t.status === "completed" ? "var(--c-green-bg)" : t.status === "cancelled" ? "var(--c-red-bg)" : "var(--c-blue-bg-2)", color: t.status === "completed" ? "var(--c-green-deep)" : t.status === "cancelled" ? "var(--c-red-dark)" : "var(--c-blue-deep)", whiteSpace: "nowrap" }}>
                          {STATUS_ZH[t.status] || t.status}
                        </span>
                      </td>
                      <td onClick={() => selectTask(t.id)} style={{ ...tdS, whiteSpace: "nowrap", minWidth: 100 }}>{formatBeijingTime(t.createdAt)}</td>
                      <td style={{ ...tdS, textAlign: "right" }}>
                        <button onClick={(e) => { e.stopPropagation(); void openDeleteTask(t.id); }} style={{ padding: "3px 10px", border: "1px solid var(--c-red)", color: "var(--c-red)", background: "var(--white)", borderRadius: 4, cursor: "pointer", fontSize: 11 }}>删除</button>
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
            <button onClick={() => { selectTask(null); setPreviewImage(null); setExpandedPrealerts(new Set()); setEditPrealert(null); setEditMark(""); setEditExpressNo(""); setEditProductRows([]); setEditSubmitting(false); setDeletePrealertId(null); setDeleteTaskId(null); setReviewSubmitting(false); setShowRejectDialog(false); setRejectReason(""); setToast(""); loadTasks(); }} style={{ padding: "6px 14px", border: "1px solid var(--l-strong)", background: "var(--white)", color: "var(--t-muted)", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>← 返回</button>
            <h2 style={{ fontSize: 20, margin: 0 }}>{taskDetail.taskNo}</h2>
            <div style={{ fontSize: 12, color: "var(--t-muted)", marginBottom: 8 }}>创建时间：{formatBeijingTime(taskDetail.createdAt)}</div>
            <span style={{ color: "var(--t-muted)", fontSize: 13 }}>{taskDetail.clientName}</span>
            <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, background: "var(--c-blue-bg-2)", color: "var(--c-blue-deep)" }}>{STATUS_ZH[taskDetail.status] || taskDetail.status}</span>
            <div style={{ flex: 1 }} />
            <button onClick={() => { if (taskDetail) { void openDeleteTask(taskDetail.id); selectTask(null); } }} style={{ padding: "6px 14px", border: "1px solid var(--c-red)", color: "var(--c-red)", background: "var(--white)", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>删除任务</button>
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

          {/* 已付款：撤销并退款（2026-08-07）
              客户改成用集货余额付款、当场扣钱不可撤销，这里是唯一的后手 */}
          {taskDetail.paymentStatus === "paid" && (
            <div style={{ marginBottom: 20, padding: "12px 16px", border: "1px solid var(--l-soft)", borderRadius: 8 }}>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>已付款</div>
              <div style={{ fontSize: 13, color: "var(--t-muted)", marginBottom: 10 }}>
                客户用集货余额支付。客户点错了可以在这里撤销：钱退回他的集货余额，任务回到「未付款」。
              </div>
              <button onClick={handleRevokePayment} disabled={revoking} style={{ padding: "8px 16px", border: "1px solid #fecaca", color: "var(--c-red-deep)", background: "var(--white)", borderRadius: 6, cursor: revoking ? "not-allowed" : "pointer", fontWeight: 600 }}>
                {revoking ? "退款中..." : "撤销付款并退款"}
              </button>
            </div>
          )}

          {/* 付款审核区域 */}
          {taskDetail.paymentStatus === "pending_review" && (
            <div style={{ marginBottom: 20, padding: "16px", background: "var(--c-amber-bg)", borderRadius: 8, border: "1px solid var(--c-amber)" }}>
              <div style={{ fontWeight: 700, color: "var(--c-amber-deep)", fontSize: 15, marginBottom: 8 }}>💳 待审核付款</div>
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
                <label style={{ display: "block", fontSize: 13, color: "var(--t-body)", fontWeight: 500, marginBottom: 3 }}>拒绝原因 *</label>
                <textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="请填写拒绝原因，客户可见" style={{ width: "100%", padding: "7px 10px", border: "1px solid var(--l-strong)", borderRadius: 6, fontSize: 13, minHeight: 80, boxSizing: "border-box" }} />
              </div>
              <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
                <button onClick={handleRejectPayment} disabled={reviewSubmitting} style={{ padding: "8px 18px", background: "var(--c-blue)", color: "var(--white)", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}>
                  {reviewSubmitting ? "提交中..." : "确认拒绝"}
                </button>
                <button onClick={() => { setShowRejectDialog(false); setRejectReason(""); }} style={{ padding: "8px 18px", border: "1px solid var(--l-strong)", background: "var(--white)", color: "var(--t-muted)", borderRadius: 6, cursor: "pointer" }}>取消</button>
              </div>
            </Modal>
          )}

          {/* 预报单 */}
          <h3 style={{ fontSize: 16, marginBottom: 12 }}>预报单</h3>

          {pendingPrealerts.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <h4 style={{ fontSize: 14, color: "var(--c-amber)", marginBottom: 8 }}>待签收 ({pendingPrealerts.length})</h4>
              {pendingPrealerts.map((pa) => (
                <AdminPrealertRow key={pa.id} pa={pa} expanded={expandedPrealerts} setExpanded={setExpandedPrealerts}
                  setPreviewImage={setPreviewImage}
                  onDelete={() => setDeletePrealertId(pa.id)}
                  onDeleteProduct={canDeleteProducts ? (p) => setDeleteProductTarget({ product: p, trackingNo: pa.trackingNo }) : undefined}
                  onEdit={pa.status === "received" ? () => openAdminEdit(pa) : undefined} />
              ))}
            </div>
          )}

          {receivedPrealerts.length > 0 && (
            <div>
              <h4 style={{ fontSize: 14, color: "var(--c-green-2)", marginBottom: 8 }}>已签收 ({receivedPrealerts.length})</h4>
              {receivedPrealerts.map((pa) => (
                <AdminPrealertRow key={pa.id} pa={pa} expanded={expandedPrealerts} setExpanded={setExpandedPrealerts}
                  setPreviewImage={setPreviewImage}
                  onEdit={() => openAdminEdit(pa)}
                  onDeleteProduct={canDeleteProducts ? (p) => setDeleteProductTarget({ product: p, trackingNo: pa.trackingNo }) : undefined}
                  onDelete={() => setDeletePrealertId(pa.id)} />
              ))}
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

      {/* ======== 弹窗：删除任务确认 ======== */}
      {deleteTaskId && (
        <Modal onClose={() => setDeleteTaskId(null)}>
          <p style={{ marginTop: 0, fontWeight: 600 }}>删除这个集货任务？</p>
          {deletePreview ? (
            <>
              <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--t-body)" }}>会连带删掉：</p>
              <ul style={{ margin: "0 0 12px", paddingLeft: 20, fontSize: 13, color: "var(--t-body)" }}>
                {Object.entries(deletePreview.willDelete).map(([k, v]) => (
                  <li key={k}>{k}：{v} 条</li>
                ))}
              </ul>
              {(deletePreview.refundTotal ?? 0) > 0 && (
                <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 6, padding: 10, marginBottom: 12, fontSize: 13, color: "var(--c-green-dark)" }}>
                  删除时会把已付的 <b>¥{(deletePreview.refundTotal ?? 0).toFixed(2)}</b>
                  {" "}退回给 {deletePreview.refundCount} 位客户的集货余额。
                </div>
              )}
              {deletePreview.blockers.length > 0 && (
                <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 6, padding: 10, marginBottom: 12 }}>
                  <div style={{ fontSize: 13, color: "var(--c-red-deep)", fontWeight: 600, marginBottom: 4 }}>这个任务已经开始走流程了：</div>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "var(--c-red-deep)" }}>
                    {deletePreview.blockers.map((b, i) => <li key={i}>{b}</li>)}
                  </ul>
                  <div style={{ fontSize: 12, color: "#B02A25", marginTop: 6 }}>确实要删，请输入你的管理员密码：</div>
                  <input
                    type="password"
                    value={deletePassword}
                    onChange={(e) => setDeletePassword(e.target.value)}
                    placeholder="管理员密码"
                    style={{ marginTop: 6, width: "100%", border: "1px solid var(--l-strong)", borderRadius: 6, padding: "6px 10px", fontSize: 13 }}
                  />
                </div>
              )}
              <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--t-muted)" }}>删了找不回来。</p>
            </>
          ) : (
            <p style={{ fontSize: 13, color: "var(--t-muted)" }}>正在查这个任务下面有多少东西…</p>
          )}
          {deleteError && <p style={{ color: "var(--c-red-deep)", fontSize: 13, margin: "0 0 10px" }}>{deleteError}</p>}
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={handleDeleteTask} disabled={deleteTaskSubmitting || !deletePreview} style={{ padding: "8px 16px", background: deletePreview ? "var(--c-red)" : "var(--l-strong)", color: "var(--white)", border: "none", borderRadius: 6, cursor: deletePreview ? "pointer" : "not-allowed" }}>{deleteTaskSubmitting ? "删除中..." : "确认删除"}</button>
            <button onClick={() => setDeleteTaskId(null)} style={{ padding: "8px 16px", border: "1px solid var(--l-strong)", background: "var(--white)", color: "var(--t-muted)", borderRadius: 6, cursor: "pointer" }}>取消</button>
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
            <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "var(--s-sunken)" }}>
                  <th style={thS}>产品名称</th>
                  <th style={thS}>件数</th>
                  <th style={thS}>每箱几个</th>
                  <th style={thS}>单件重(kg)</th>
                  <th style={thS}>长(cm)</th>
                  <th style={thS}>宽(cm)</th>
                  <th style={thS}>高(cm)</th>
                  <th style={thS}>材质</th>
                  <th style={thS}>货值</th>
                  <th style={thS}>货型</th>
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
                    <tr key={r.key} style={{ borderBottom: "1px solid var(--l-soft)" }}>
                      <td style={tdS}><input value={r.productName} onChange={(e) => { const next = [...editProductRows]; next[i] = { ...next[i], productName: e.target.value }; setEditProductRows(next); }} style={miniInput} /></td>
                      <td style={tdS}><input value={r.packageCount} onChange={(e) => { const next = [...editProductRows]; next[i] = { ...next[i], packageCount: e.target.value }; setEditProductRows(next); }} style={{ ...miniInput, width: 50 }} /></td>
                      <td style={tdS}><input value={r.quantityPerBox} onChange={(e) => { const next = [...editProductRows]; next[i] = { ...next[i], quantityPerBox: e.target.value }; setEditProductRows(next); }} style={{ ...miniInput, width: 50 }} /></td>
                      <td style={tdS}><input value={r.unitWeightKg} onChange={(e) => { const next = [...editProductRows]; next[i] = { ...next[i], unitWeightKg: e.target.value }; setEditProductRows(next); }} style={{ ...miniInput, width: 60 }} /></td>
                      <td style={tdS}><input value={r.lengthCm} onChange={(e) => { const next = [...editProductRows]; next[i] = { ...next[i], lengthCm: e.target.value }; setEditProductRows(next); }} style={{ ...miniInput, width: 50 }} /></td>
                      <td style={tdS}><input value={r.widthCm} onChange={(e) => { const next = [...editProductRows]; next[i] = { ...next[i], widthCm: e.target.value }; setEditProductRows(next); }} style={{ ...miniInput, width: 50 }} /></td>
                      <td style={tdS}><input value={r.heightCm} onChange={(e) => { const next = [...editProductRows]; next[i] = { ...next[i], heightCm: e.target.value }; setEditProductRows(next); }} style={{ ...miniInput, width: 50 }} /></td>
                      <td style={tdS}><input value={r.material} onChange={(e) => { const next = [...editProductRows]; next[i] = { ...next[i], material: e.target.value }; setEditProductRows(next); }} style={miniInput} /></td>
                      <td style={tdS}><input value={r.cargoValue} onChange={(e) => { const next = [...editProductRows]; next[i] = { ...next[i], cargoValue: e.target.value }; setEditProductRows(next); }} style={miniInput} /></td>
                      <td style={tdS}>
                        <select value={r.cargoType} onChange={(e) => { const next = [...editProductRows]; next[i] = { ...next[i], cargoType: e.target.value }; setEditProductRows(next); }} style={{ ...miniInput, width: 70 }}>
                          <option value="normal">普货</option>
                          <option value="inspection">商检货</option>
                          <option value="sensitive">敏感货</option>
                        </select>
                      </td>
                      <td style={{ ...tdS, color: "var(--t-muted)" }}>{totalQty || "-"}</td>
                      <td style={{ ...tdS, color: "var(--t-muted)" }}>{totalW || "-"}</td>
                      <td style={{ ...tdS, color: "var(--t-muted)" }}>{vol || "-"}</td>
                      <td style={tdS}><button onClick={() => { if (editProductRows.length > 1) setEditProductRows(editProductRows.filter((_, j) => j !== i)); }} style={{ border: "none", background: "none", color: "var(--c-red)", cursor: "pointer", fontSize: 16 }}>×</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <button onClick={() => setEditProductRows([...editProductRows, emptyProductRow(Date.now())])} style={{ marginTop: 10, padding: "4px 14px", border: "1px dashed var(--c-blue)", color: "var(--c-blue)", background: "none", borderRadius: 4, cursor: "pointer", fontSize: 12 }}>
            + 添加产品行
          </button>

          <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
            <button onClick={handleAdminEditSubmit} disabled={editSubmitting} style={{ padding: "8px 20px", background: "var(--c-blue)", color: "var(--white)", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}>
              {editSubmitting ? "提交中..." : "保存修改"}
            </button>
            <button onClick={() => setEditPrealert(null)} style={{ padding: "8px 20px", border: "1px solid var(--l-strong)", background: "var(--white)", color: "var(--t-muted)", borderRadius: 6, cursor: "pointer" }}>取消</button>
          </div>
        </Modal>
      )}

      {/* ======== 弹窗：删除单件货物确认（2026-08-15）======== */}
      {deleteProductTarget && (
        <Modal onClose={() => setDeleteProductTarget(null)}>
          <h3 style={{ marginTop: 0, fontSize: 16 }}>删除这件货物</h3>
          <p style={{ fontSize: 13, color: "var(--t-muted)", marginBottom: 6 }}>预报单：{deleteProductTarget.trackingNo}</p>
          <p style={{ fontSize: 14, marginBottom: 10 }}>
            要删除：<b>{deleteProductTarget.product.productName}</b>
            （{deleteProductTarget.product.packageCount} 件
            {deleteProductTarget.product.volume != null ? ` · ${deleteProductTarget.product.volume.toFixed(3)} 方` : ""}）
          </p>
          <div style={{ fontSize: 13, color: "var(--t-muted)", lineHeight: 1.8, marginBottom: 12 }}>
            删除之后会发生：
            <div>· 这件货从预报单里消失，<b>删了不能恢复</b></div>
            <div>· 任务的总件数、已收体积跟着变小</div>
            <div>· <b style={{ color: "var(--c-red)" }}>任务总价不会自动改</b>（普通版的价是手填的），删完请自己回去核对报价</div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={handleAdminDeleteProduct} disabled={deleteProductSubmitting} style={{ padding: "8px 16px", background: "var(--c-red)", color: "var(--white)", border: "none", borderRadius: 6, cursor: "pointer" }}>{deleteProductSubmitting ? "删除中..." : "确认删除"}</button>
            <button onClick={() => setDeleteProductTarget(null)} style={{ padding: "8px 16px", border: "1px solid var(--l-strong)", background: "var(--white)", color: "var(--t-muted)", borderRadius: 6, cursor: "pointer" }}>取消</button>
          </div>
        </Modal>
      )}

      {/* ======== 弹窗：删除预报单确认 ======== */}
      {deletePrealertId && (
        <Modal onClose={() => setDeletePrealertId(null)}>
          <p style={{ marginTop: 0 }}>确定要删除该预报单吗？</p>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={handleAdminDeletePrealert} disabled={deletePrealertSubmitting} style={{ padding: "8px 16px", background: "var(--c-red)", color: "var(--white)", border: "none", borderRadius: 6, cursor: "pointer" }}>{deletePrealertSubmitting ? "删除中..." : "确认删除"}</button>
            <button onClick={() => setDeletePrealertId(null)} style={{ padding: "8px 16px", border: "1px solid var(--l-strong)", background: "var(--white)", color: "var(--t-muted)", borderRadius: 6, cursor: "pointer" }}>取消</button>
          </div>
        </Modal>
      )}
    </>
  );
}

// ============================================================================
// 子组件：管理员预报单行
// ============================================================================
function AdminPrealertRow({
  pa, expanded, setExpanded, setPreviewImage, onEdit, onDelete, onDeleteProduct,
}: {
  pa: ConsolidationPrealertItem;
  expanded: Set<string>;
  setExpanded: React.Dispatch<React.SetStateAction<Set<string>>>;
  setPreviewImage: (url: string | null) => void;
  onEdit?: () => void;
  onDelete?: () => void;
  /** 传了才显示单件货物的「删除」按钮；由外层按任务付款状态决定给不给 */
  onDeleteProduct?: (product: ConsolidationPrealertItem["products"][number]) => void;
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
          {onEdit && <button onClick={(e) => { e.stopPropagation(); onEdit(); }} style={{ padding: "3px 10px", border: "1px solid var(--c-blue)", color: "var(--c-blue)", background: "var(--white)", borderRadius: 4, cursor: "pointer", fontSize: 11 }}>编辑</button>}
          {onDelete && <button onClick={(e) => { e.stopPropagation(); onDelete(); }} style={{ padding: "3px 10px", border: "1px solid var(--c-red)", color: "var(--c-red)", background: "var(--white)", borderRadius: 4, cursor: "pointer", fontSize: 11 }}>删除</button>}
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
                {onDeleteProduct && <th style={thS}>操作</th>}
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
                  {onDeleteProduct && (
                    <td style={{ ...tdS, textAlign: "center" }}>
                      {pa.products.length > 1 ? (
                        <button
                          onClick={(e) => { e.stopPropagation(); onDeleteProduct(p); }}
                          style={{ padding: "3px 10px", border: "1px solid var(--c-red)", color: "var(--c-red)", background: "var(--white)", borderRadius: 4, cursor: "pointer", fontSize: 12 }}
                        >删除</button>
                      ) : (
                        <span style={{ color: "var(--t-faint)", fontSize: 12 }}>-</span>
                      )}
                    </td>
                  )}
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

const thS: React.CSSProperties = { textAlign: "left", padding: "6px 10px", fontSize: 12, color: "var(--t-muted)", fontWeight: 600, borderBottom: "2px solid var(--l-soft)" };
const tdS: React.CSSProperties = { padding: "7px 10px", fontSize: 12 };
const fl: React.CSSProperties = { display: "block", fontSize: 13, color: "var(--t-body)", fontWeight: 500, marginBottom: 3 };
const fi: React.CSSProperties = { width: "100%", padding: "7px 10px", border: "1px solid var(--l-strong)", borderRadius: 6, fontSize: 13, boxSizing: "border-box" };
const miniInput: React.CSSProperties = { width: "100%", padding: "2px 4px", border: "1px solid var(--l-strong)", borderRadius: 3, fontSize: 11, boxSizing: "border-box" };
