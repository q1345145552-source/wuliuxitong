"use client";

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import RoleShell from "../../../modules/layout/RoleShell";
import {
  fetchClientConsolidationTasks,
  fetchClientConsolidationTaskDetail,
  createConsolidationTask,
  createConsolidationPrealert,
  updateConsolidationPrealert,
  deleteConsolidationPrealert,
  payConsolidationTask,
  type ConsolidationTaskItem,
  type ConsolidationPrealertItem,
  type ConsolidationProductItem,
  fetchClientWalletOverview,} from "../../../services/business-api";
import { formatBeijingTime } from "../../../modules/staff/utils";
import { createRequestGate } from "../../../modules/shared/request-gate";

// ============================================================================
// 状态中文映射
// ============================================================================
const STATUS_ZH: Record<string, string> = {
  collecting: "收集中",
  full_confirmed: "已满待报价",
  quoted: "已报价待付款",
  paid: "已付款",
  loading: "装柜中",
  in_transit: "运输中",
  customs: "清关中",
  delivering: "派送中",
  completed: "已完成",
  cancelled: "已取消",
  pending: "待签收",
  received: "已签收",
};

const PAYMENT_STATUS_ZH: Record<string, string> = {
  unpaid: "未付款",
  pending_review: "待审核",
  paid: "已付款",
};

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
// 主页面组件
// ============================================================================
export default function ClientConsolidationPage() {
  const [tasks, setTasks] = useState<ConsolidationTaskItem[]>([]);
  const [taskDetail, setTaskDetail] = useState<ConsolidationTaskItem | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"active" | "completed">("active");
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  // 2026-09-02 终审整改：详情加载失败要明说并给重试入口，不许留着上一个任务的内容冒充当前任务
  const [detailError, setDetailError] = useState("");

  // 搜索
  const [searchTaskNo, setSearchTaskNo] = useState("");
  const [searchDateFrom, setSearchDateFrom] = useState("");
  const [searchDateTo, setSearchDateTo] = useState("");

  // 弹窗
  const [showCreateTask, setShowCreateTask] = useState(false);
  const [newDest, setNewDest] = useState("");
  const [createTaskLoading, setCreateTaskLoading] = useState(false);

  const [showCreatePrealert, setShowCreatePrealert] = useState(false);
  const [editPrealertId, setEditPrealertId] = useState<string | null>(null);
  const [prealertMark, setPrealertMark] = useState("");
  const [prealertExpressNo, setPrealertExpressNo] = useState("");
  const [productRows, setProductRows] = useState<ProductFormRow[]>([emptyProductRow(Date.now())]);
  const [prealertSubmitting, setPrealertSubmitting] = useState(false);

  const [showPay, setShowPay] = useState(false);
  // 集货余额（2026-08-07）：付款直接扣这里的钱
  const [balance, setBalance] = useState(0);
  const [payProofFileName, setPayProofFileName] = useState("");
  const [payProofMime, setPayProofMime] = useState("");
  const [payLoading, setPayLoading] = useState(false);

  const [toast, setToast] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // 预报单展开
  const [expandedPrealerts, setExpandedPrealerts] = useState<Set<string>>(new Set());
  // 品名表格展开
  const [showAllProducts, setShowAllProducts] = useState(false);

  // ---- 数据加载 ----
  /** 读集货余额。付款弹窗用它判断够不够，付完刷新。 */
  const loadBalance = useCallback(async () => {
    try {
      const r = await fetchClientWalletOverview();
      setBalance(typeof (r as any).balance === "number" ? (r as any).balance : (r.accounts?.find(a => a.currency === "CNY")?.balance ?? 0));
    } catch { setBalance(0); }
  }, []);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchClientConsolidationTasks();
      setTasks(data);
    } catch (e: any) {
      setToast(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // 2026-09-01 竞态全扫：详情数据要认主人——快速点 A 又点 B（或点了返回）时，
  // A 的晚响应不许把 B 的详情盖掉。ref 里永远存「当前选中的任务 id」，
  // 响应落地前先核对；再叠加详情自己的门闩，防同一任务的新旧两次刷新互盖。
  const selectedTaskIdRef = useRef<string | null>(null);
  const detailGate = useRef(createRequestGate()).current;

  /** 2026-09-02 终审整改：换选中任务必须在用户点击处**同步**赋值 ref，useEffect 里那句只作兜底。
      只靠 useEffect 的话，点击到 effect 跑起来之间有间隙，旧任务的晚响应在间隙里核对的还是旧 ref，
      会照样落地盖到错的任务上。所有改选中任务的入口一律走这里。 */
  const selectTask = (id: string | null) => {
    selectedTaskIdRef.current = id; // 点击处同步认主人，晚到的旧响应立刻失效
    setTaskDetail(null);            // 旧任务的详情内容不许在新任务名下多留一帧
    setDetailError("");
    setSelectedTaskId(id);
  };

  const loadDetail = useCallback(async (taskId: string) => {
    // 2026-09-02 三审整改：进门第一件事先认主人——过期上下文的刷新连号都不许领。
    // 场景：任务 A 的操作（付款/删预报单等）完成后回调拿着 A 来刷新，但用户已切到 B：
    // 若此处照常领号，会把 B 还在路上的请求作废；而 A 自己的响应又过不了主人核对被丢弃，
    // B 页面就空白且没有任何重试提示。所以不是当前选中的任务直接整段 return——
    // 不领号、不开 loading、不清数据，旧上下文的刷新对新上下文零影响。
    if (taskId !== selectedTaskIdRef.current) return;
    const ticket = detailGate.begin(); // 2026-09-01 竞态全扫：出发时领号
    setDetailLoading(true);
    try {
      const data = await fetchClientConsolidationTaskDetail(taskId);
      // 2026-09-01 竞态全扫：号作废或主人换了（用户切了任务/回了列表），整段丢弃
      if (!detailGate.isCurrent(ticket) || selectedTaskIdRef.current !== taskId) return;
      setTaskDetail(data);
      setDetailError(""); // 2026-09-02 终审整改：加载成功要把上一次的失败提示清掉
    } catch (e: any) {
      // 2026-09-01 竞态全扫：旧请求的报错不许安到新请求头上
      if (!detailGate.isCurrent(ticket) || selectedTaskIdRef.current !== taskId) return;
      // 2026-09-02 终审整改（Codex 点名）：B 加载失败时不许留着 A 的详情冒充 B——
      // 清空详情并明示「加载失败，点击重试」
      setTaskDetail(null);
      setDetailError(e?.message || "加载失败");
    } finally {
      // 2026-09-02 复核整改：finally 只认票号，不再叠加「主人核对」。
      // 之前多了 selectedTaskIdRef.current === taskId 这个条件，最新一票在途时用户切任务/回列表，
      // 主人一换，最新票的 finally 也拒清 loading；若之后没有新请求（回列表就不再发），转圈永远停不下来。
      // 票号本身已足够：被作废的旧票在此不碰 loading（不许掐掉新请求的加载态），
      // 而最新票收尾时必须把 loading 收掉——即便主人换了，新主人的请求自己会再置 true。
      if (detailGate.isCurrent(ticket)) setDetailLoading(false);
    }
  }, [detailGate]);

  useEffect(() => { loadTasks(); }, [loadTasks]);
  useEffect(() => { loadBalance(); }, [loadBalance]);

  useEffect(() => {
    selectedTaskIdRef.current = selectedTaskId; // 2026-09-01 竞态全扫：先记下当前主人再取数
    if (selectedTaskId) {
      loadDetail(selectedTaskId);
    } else {
      setTaskDetail(null);
    }
  }, [selectedTaskId, loadDetail]);

  // ---- 过滤 ----
  const filteredTasks = useMemo(() => {
    let list = tasks;
    if (activeTab === "active") {
      list = list.filter((t) => t.status !== "completed" && t.status !== "cancelled");
    } else {
      list = list.filter((t) => t.status === "completed");
      if (searchTaskNo) list = list.filter((t) => t.taskNo.includes(searchTaskNo.trim()));
      if (searchDateFrom) list = list.filter((t) => t.createdAt >= searchDateFrom);
      if (searchDateTo) list = list.filter((t) => t.createdAt <= searchDateTo + "T23:59:59");
    }
    return list;
  }, [tasks, activeTab, searchTaskNo, searchDateFrom, searchDateTo]);

  // ---- 创建任务 ----
  const handleCreateTask = async () => {
    if (!newDest.trim()) { setToast("请输入目的地地址"); return; }
    setCreateTaskLoading(true);
    try {
      const t = await createConsolidationTask(newDest.trim());
      await loadTasks();
      setShowCreateTask(false);
      setNewDest("");
      selectTask(t.id); // 2026-09-02 终审整改：走统一入口，点击处同步认主人
    } catch (e: any) {
      setToast(e.message);
    } finally {
      setCreateTaskLoading(false);
    }
  };

  // ---- 创建/编辑预报单 ----
  const openPrealertForm = (prealert?: ConsolidationPrealertItem) => {
    if (prealert) {
      setEditPrealertId(prealert.id);
      setPrealertMark(prealert.mark);
      setPrealertExpressNo(prealert.expressNo || "");
      setProductRows(
        prealert.products.map((p, i) => ({
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
    } else {
      setEditPrealertId(null);
      setPrealertMark("");
      setPrealertExpressNo("");
      setProductRows([emptyProductRow(Date.now())]);
    }
    setShowCreatePrealert(true);
  };

  const handleSubmitPrealert = async () => {
    if (!prealertMark.trim()) { setToast("请输入唛头"); return; }
    for (let i = 0; i < productRows.length; i++) {
      const r = productRows[i];
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

    // 2026-09-02 三审整改：操作回调里的刷新一律传「本次操作发生时」的明确任务 id。
    // 用户中途切走时，loadDetail 进门认主人会直接拒收这次刷新，不会作废新任务的在途请求。
    const opTaskId = selectedTaskId;
    setPrealertSubmitting(true);
    try {
      const products = productRows.map((r) => ({
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

      if (editPrealertId) {
        await updateConsolidationPrealert({ prealertId: editPrealertId, mark: prealertMark.trim(), expressNo: prealertExpressNo.trim() || undefined, products });
      } else {
        await createConsolidationPrealert({ taskId: opTaskId!, mark: prealertMark.trim(), expressNo: prealertExpressNo.trim() || undefined, products });
      }
      setShowCreatePrealert(false);
      setToast(editPrealertId ? "预报单已更新" : "预报单已创建");
      if (opTaskId) await loadDetail(opTaskId); // 2026-09-02 三审整改：刷新传明确的操作任务 id
      await loadTasks();
    } catch (e: any) {
      setToast(e.message);
    } finally {
      setPrealertSubmitting(false);
    }
  };

  // ---- 删除预报单 ----
  const handleDeletePrealert = async (prealertId: string) => {
    // 2026-09-02 三审整改：操作回调里的刷新一律传「本次操作发生时」的明确任务 id。
    // 用户中途切走时，loadDetail 进门认主人会直接拒收这次刷新，不会作废新任务的在途请求。
    const opTaskId = selectedTaskId;
    try {
      await deleteConsolidationPrealert(prealertId);
      setDeleteConfirm(null);
      setToast("预报单已删除");
      if (opTaskId) await loadDetail(opTaskId);
      await loadTasks();
    } catch (e: any) {
      setToast(e.message);
      // 失败也要刷新（2026-08-27 补）：后端现在会说「刚刚被别人改过，请刷新后再看」，
      // 页面不刷新的话用户看到的还是旧数字，容易照着旧数字再操作一次。
      if (opTaskId) await loadDetail(opTaskId);
      await loadTasks();
    }
  };

  // ---- 付款：用集货余额直接扣（2026-08-07 改）----
  // 原来是上传付款凭证等审核，现在当场扣余额、当场付清。
  // 不可撤销，所以先弹一道确认；点错了只能找客服在管理员端撤销。
  const handlePay = async () => {
    const fee = taskDetail?.totalFee ?? 0;
    if (!(fee > 0)) { setToast("这个任务还没有报价金额，请联系客服"); return; }
    if (balance < fee) { setToast(`集货余额不足，还差 ¥${(fee - balance).toFixed(2)}，请先去「集货余额」充值`); return; }
    if (!confirm(`确认用集货余额支付 ¥${fee.toFixed(2)}？\n\n此次付款不可撤销，误操作请联系客服。`)) return;
    // 2026-09-02 三审整改：操作回调里的刷新一律传「本次操作发生时」的明确任务 id。
    // 用户中途切走时，loadDetail 进门认主人会直接拒收这次刷新，不会作废新任务的在途请求。
    const opTaskId = selectedTaskId;
    setPayLoading(true);
    try {
      const r = await payConsolidationTask({ taskId: opTaskId! });
      setShowPay(false);
      setToast(r?.message ?? "付款成功");
      await loadBalance();
      if (opTaskId) await loadDetail(opTaskId);
      await loadTasks();
    } catch (e: any) {
      setToast(e.message);
      // 失败也要刷新（2026-08-27 补）：后端现在会说「刚刚被别人改过，请刷新后再看」，
      // 页面不刷新的话用户看到的还是旧数字，容易照着旧数字再操作一次。
      await loadBalance();
      if (opTaskId) await loadDetail(opTaskId);
      await loadTasks();
    } finally {
      setPayLoading(false);
    }
  };

  // ---- 品名汇总 ----
  const productSummary = useMemo(() => {
    if (!taskDetail?.prealerts) return [];
    const map = new Map<string, { name: string; count: number; vol: number }>();
    for (const pa of taskDetail.prealerts) {
      if (pa.status !== "received") continue;
      for (const p of pa.products) {
        const key = p.productName;
        const existing = map.get(key);
        if (existing) {
          existing.count += p.packageCount;
          existing.vol += p.volume ?? 0;
        } else {
          map.set(key, { name: key, count: p.packageCount, vol: p.volume ?? 0 });
        }
      }
    }
    const arr = Array.from(map.values()).sort((a, b) => b.vol - a.vol);
    const maxVol = arr[0]?.vol ?? 1;
    return arr.map((x) => ({ ...x, percent: maxVol > 0 ? (x.vol / maxVol) * 100 : 0 }));
  }, [taskDetail]);

  const displayedSummary = showAllProducts ? productSummary : productSummary.slice(0, 10);

  // ---- 分离已签收/待签收 ----
  const pendingPrealerts = useMemo(
    () => taskDetail?.prealerts?.filter((p) => p.status === "pending") ?? [],
    [taskDetail],
  );
  const receivedPrealerts = useMemo(
    () => taskDetail?.prealerts?.filter((p) => p.status === "received") ?? [],
    [taskDetail],
  );

  const showProgress = taskDetail && !["loading", "in_transit", "customs", "delivering", "completed", "cancelled"].includes(taskDetail.status);

  // ---- 图片预览 ----
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  // ---- 渲染 ----
  return (
    <RoleShell allowedRole="client" title="集货拼柜" variant="a3">
      {toast && (
        <div style={{ position: "fixed", top: 20, right: 20, zIndex: 9999, background: "#14171D", color: "var(--white)", padding: "10px 20px", borderRadius: 8, boxShadow: "0 4px 12px rgba(0,0,0,0.3)", cursor: "pointer" }} onClick={() => setToast("")}>
          {toast}
        </div>
      )}

      {previewImage && (
        <div onClick={() => setPreviewImage(null)} style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.8)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <img src={previewImage} style={{ maxWidth: "90vw", maxHeight: "90vh", borderRadius: 8 }} alt="预览" />
        </div>
      )}

      {/* ======== 列表视图 ======== */}
      {!selectedTaskId && (
        <div style={{ padding: 24 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <h2 style={{ fontSize: 22, margin: 0 }}>集货拼柜</h2>
            <button onClick={() => setShowCreateTask(true)} style={{ padding: "8px 20px", background: "var(--c-blue)", color: "var(--white)", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 14, fontWeight: 600 }}>
              + 创建任务
            </button>
          </div>

          {/* Tabs */}
          <div style={{ display: "flex", gap: 0, marginBottom: 16, borderBottom: "2px solid var(--l-soft)" }}>
            {(["active", "completed"] as const).map((tab) => (
              <button key={tab} onClick={() => setActiveTab(tab)}
                style={{ padding: "10px 24px", border: "none", background: "none", cursor: "pointer", fontSize: 14, fontWeight: 600, color: activeTab === tab ? "var(--c-blue)" : "var(--t-muted)", borderBottom: activeTab === tab ? "2px solid var(--c-blue)" : "2px solid transparent", marginBottom: -2 }}>
                {tab === "active" ? "进行中" : "已完成"}
              </button>
            ))}
          </div>

          {/* 已完成搜索 */}
          {activeTab === "completed" && (
            <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
              <input placeholder="任务编号" value={searchTaskNo} onChange={(e) => setSearchTaskNo(e.target.value)} style={{ padding: "6px 10px", border: "1px solid var(--l-strong)", borderRadius: 6, fontSize: 13, width: 160 }} />
              <input type="date" value={searchDateFrom} onChange={(e) => setSearchDateFrom(e.target.value)} style={{ padding: "6px 10px", border: "1px solid var(--l-strong)", borderRadius: 6, fontSize: 13, width: 140 }} />
              <span style={{ fontSize: 13, color: "var(--t-muted)", alignSelf: "center" }}>至</span>
              <input type="date" value={searchDateTo} onChange={(e) => setSearchDateTo(e.target.value)} style={{ padding: "6px 10px", border: "1px solid var(--l-strong)", borderRadius: 6, fontSize: 13, width: 140 }} />
            </div>
          )}

          {/* 任务卡片列表 */}
          {loading ? (
            <p style={{ color: "var(--t-muted)", fontSize: 14 }}>加载中...</p>
          ) : filteredTasks.length === 0 ? (
            <p style={{ color: "var(--t-faint)", fontSize: 14, padding: 40, textAlign: "center" }}>暂无任务</p>
          ) : (
            <div style={{ display: "grid", gap: 12 }}>
              {filteredTasks.map((t) => (
                <div key={t.id} style={{ border: "1px solid var(--l-soft)", borderRadius: 10, padding: 16, background: "var(--white)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 6 }}>
                      <strong style={{ fontSize: 15 }}>{t.taskNo}</strong>
                      <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 4, background: t.status === "completed" ? "var(--c-green-bg)" : t.status === "cancelled" ? "var(--c-red-bg)" : "var(--c-blue-bg-2)", color: t.status === "completed" ? "var(--c-green-deep)" : t.status === "cancelled" ? "var(--c-red-dark)" : "var(--c-blue-deep)" }}>
                        {STATUS_ZH[t.status] || t.status}
                      </span>
                    </div>
                    <div style={{ fontSize: 13, color: "var(--t-muted)", marginBottom: 8 }}>{t.destinationTh} · {formatBeijingTime(t.createdAt)}</div>
                    {/* 进度条 */}
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ flex: 1, height: 8, background: "var(--l-soft)", borderRadius: 4, overflow: "hidden", maxWidth: 300 }}>
                        <div style={{ height: "100%", width: `${Math.min(t.volumePercent, 100)}%`, background: t.volumePercent >= 85 ? (t.volumePercent >= 100 ? "var(--c-green-2)" : "var(--c-amber)") : "#1e3a8a", borderRadius: 4, transition: "width 0.3s" }} />
                      </div>
                      <span style={{ fontSize: 12, color: "var(--t-muted)", whiteSpace: "nowrap" }}>{t.totalVolumeM3} / {t.maxVolumeM3} m³</span>
                    </div>
                  </div>
                  <button onClick={() => selectTask(t.id)} style={{ padding: "6px 16px", border: "1px solid var(--c-blue)", color: "var(--c-blue)", background: "var(--white)", borderRadius: 6, cursor: "pointer", fontSize: 13, whiteSpace: "nowrap" }}>
                    查看详情
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 2026-09-02 终审整改（Codex 点名）：详情还没拿到（加载中/加载失败）时，
          明示状态并给重试入口，不许空白、更不许拿上一个任务的内容顶着 */}
      {selectedTaskId && !taskDetail && (
        <div style={{ padding: 24 }}>
          <button onClick={() => { selectTask(null); loadTasks(); }} style={{ marginBottom: 16, padding: "6px 14px", border: "1px solid var(--l-strong)", background: "var(--white)", color: "var(--t-muted)", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>
            ← 返回列表
          </button>
          {detailLoading ? (
            <p>加载中...</p>
          ) : detailError ? (
            <div>
              <p style={{ color: "var(--c-red)", fontSize: 14 }}>详情加载失败：{detailError}</p>
              <button onClick={() => { if (selectedTaskId) loadDetail(selectedTaskId); }} style={{ padding: "6px 16px", border: "1px solid var(--c-blue)", color: "var(--c-blue)", background: "var(--white)", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>
                点击重试
              </button>
            </div>
          ) : null}
        </div>
      )}

      {/* ======== 详情视图 ======== */}
      {selectedTaskId && taskDetail && (
        <div style={{ padding: 24 }}>
          {/* 返回按钮 */}
          <button onClick={() => { selectTask(null); setPreviewImage(null); setShowAllProducts(false); setExpandedPrealerts(new Set()); setEditPrealertId(null); setShowCreatePrealert(false); setPrealertMark(""); setPrealertExpressNo(""); setProductRows([emptyProductRow(Date.now())]); setPrealertSubmitting(false); setDeleteConfirm(null); setShowPay(false); setToast(""); loadTasks(); }} style={{ marginBottom: 16, padding: "6px 14px", border: "1px solid var(--l-strong)", background: "var(--white)", color: "var(--t-muted)", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>
            ← 返回列表
          </button>

          {detailLoading ? (
            <p>加载中...</p>
          ) : (
            <>
              {/* 标题行 */}
              <div style={{ marginBottom: 20 }}>
                <h2 style={{ fontSize: 22, margin: "0 0 2px 0" }}>{taskDetail.taskNo}</h2>
                <div style={{ fontSize: 12, color: "var(--t-muted)", marginBottom: 12 }}>创建时间：{formatBeijingTime(taskDetail.createdAt)}</div>
                <p style={{ margin: 0, color: "var(--t-muted)", fontSize: 14 }}>{taskDetail.destinationTh}</p>
                <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 4, background: "var(--c-blue-bg-2)", color: "var(--c-blue-deep)", display: "inline-block", marginTop: 6 }}>
                  {STATUS_ZH[taskDetail.status] || taskDetail.status}
                </span>
              </div>

              {/* 进度条区域 */}
              {showProgress && (
                <div style={{ marginBottom: 24, padding: 20, background: "var(--s-alt)", borderRadius: 12, border: "1px solid var(--l-soft)" }}>
                  <div style={{ height: 24, background: "var(--l-soft)", borderRadius: 12, overflow: "hidden", position: "relative", marginBottom: 8 }}>
                    <div style={{ height: "100%", width: `${Math.min(taskDetail.volumePercent, 100)}%`, background: taskDetail.volumePercent >= 85 ? (taskDetail.volumePercent >= 100 ? "var(--c-green-2)" : "var(--c-amber)") : "#1e3a8a", borderRadius: 12, transition: "width 0.3s", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {taskDetail.volumePercent > 15 && (
                        <span style={{ fontSize: 12, color: "var(--white)", fontWeight: 600 }}>{taskDetail.totalVolumeM3} m³ ({taskDetail.volumePercent}%)</span>
                      )}
                    </div>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--t-faint)" }}>
                    <span>0 m³</span>
                    <span>{taskDetail.maxVolumeM3} m³</span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginTop: 12, textAlign: "center" }}>
                    <div><div style={{ fontSize: 20, fontWeight: 700 }}>{taskDetail.totalPrealerts}</div><div style={{ fontSize: 11, color: "var(--t-muted)" }}>预报单</div></div>
                    <div><div style={{ fontSize: 20, fontWeight: 700 }}>{taskDetail.totalPackages}</div><div style={{ fontSize: 11, color: "var(--t-muted)" }}>总件数</div></div>
                    <div><div style={{ fontSize: 20, fontWeight: 700 }}>{taskDetail.totalVolumeM3}</div><div style={{ fontSize: 11, color: "var(--t-muted)" }}>已收体积 m³</div></div>
                    <div><div style={{ fontSize: 20, fontWeight: 700 }}>{Math.max(0, taskDetail.maxVolumeM3 - taskDetail.totalVolumeM3).toFixed(1)}</div><div style={{ fontSize: 11, color: "var(--t-muted)" }}>剩余空间 m³</div></div>
                  </div>
                </div>
              )}

              {/* 装柜后信息 */}
              {!showProgress && (
                <div style={{ marginBottom: 20, padding: 16, background: "var(--c-blue-bg)", borderRadius: 10, border: "1px solid #E4E6EC" }}>
                  <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
                    {/* 柜号对客户屏蔽（用户 2026-08-07 定的规矩，运单那边一直是这样，
                        集货这页当初是照抄员工页面来的，把这条漏掉了）。
                        管理员端和员工端照常显示，只有客户端不给看。 */}
                    {taskDetail.loadingDate && <div><span style={{ fontSize: 12, color: "var(--t-muted)" }}>装柜日期</span><div style={{ fontWeight: 600 }}>{taskDetail.loadingDate}</div></div>}
                    {taskDetail.loadingDate && <div><span style={{ fontSize: 12, color: "var(--t-muted)" }}>装柜时间</span><div style={{ fontWeight: 600 }}>{formatBeijingTime(taskDetail.loadingDate)}</div></div>}
                    <div><span style={{ fontSize: 12, color: "var(--t-muted)" }}>物流状态</span><div style={{ fontWeight: 600 }}>{STATUS_ZH[taskDetail.status]}</div></div>
                    {taskDetail.paidAt && <div><span style={{ fontSize: 12, color: "var(--t-muted)" }}>付款时间</span><div style={{ fontWeight: 600 }}>{formatBeijingTime(taskDetail.paidAt)}</div></div>}
                  </div>
                </div>
              )}

              {/* 品名汇总表 */}
              {productSummary.length > 0 && (
                <div style={{ marginBottom: 24 }}>
                  <h3 style={{ fontSize: 16, marginBottom: 10 }}>品名汇总</h3>
                  <div style={{ overflowX: "auto" }}>
                    <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                      <thead>
                        <tr style={{ background: "var(--s-sunken)" }}>
                          <th style={thStyle}>品名</th>
                          <th style={thStyle}>件数</th>
                          <th style={thStyle}>体积(m³)</th>
                          <th style={thStyle}>占比</th>
                        </tr>
                      </thead>
                      <tbody>
                        {displayedSummary.map((s) => (
                          <tr key={s.name} style={{ borderBottom: "1px solid var(--l-soft)" }}>
                            <td style={tdStyle}>{s.name}</td>
                            <td style={tdStyle}>{s.count}</td>
                            <td style={tdStyle}>{s.vol.toFixed(3)}</td>
                            <td style={tdStyle}>
                              <div style={{ height: 6, borderRadius: 3, background: s.percent > 66 ? "#1e3a8a" : s.percent > 33 ? "#EEF2FB" : "var(--l-soft)", width: `${s.percent}%`, minWidth: s.percent > 0 ? 4 : 0 }} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {productSummary.length > 10 && (
                    <button onClick={() => setShowAllProducts(!showAllProducts)} style={{ marginTop: 8, padding: "4px 12px", border: "1px solid var(--l-strong)", background: "var(--white)", borderRadius: 4, cursor: "pointer", fontSize: 12, color: "var(--c-blue)" }}>
                      {showAllProducts ? "收起" : `展开全部 (${productSummary.length} 种)`}
                    </button>
                  )}
                </div>
              )}

              {/* 预报单列表 */}
              <div style={{ marginBottom: 24 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <h3 style={{ fontSize: 16, margin: 0 }}>预报单</h3>
                  {taskDetail.status === "collecting" && (
                    <button onClick={() => openPrealertForm()} style={{ padding: "6px 14px", background: "var(--c-blue)", color: "var(--white)", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>+ 创建预报单</button>
                  )}
                </div>

                {/* 待签收 */}
                {pendingPrealerts.length > 0 && (
                  <div style={{ marginBottom: 16 }}>
                    <h4 style={{ fontSize: 14, color: "var(--c-amber)", marginBottom: 8 }}>待签收 ({pendingPrealerts.length})</h4>
                    {pendingPrealerts.map((pa) => <PrealertCard key={pa.id} pa={pa} expanded={expandedPrealerts} setExpanded={setExpandedPrealerts} taskStatus={taskDetail.status} onEdit={() => openPrealertForm(pa)} onDelete={() => setDeleteConfirm(pa.id)} setPreviewImage={setPreviewImage} />)}
                  </div>
                )}

                {/* 已签收 */}
                {receivedPrealerts.length > 0 && (
                  <div>
                    <h4 style={{ fontSize: 14, color: "var(--c-green-2)", marginBottom: 8 }}>已签收 ({receivedPrealerts.length})</h4>
                    {receivedPrealerts.map((pa) => <PrealertCard key={pa.id} pa={pa} expanded={expandedPrealerts} setExpanded={setExpandedPrealerts} taskStatus={taskDetail.status} setPreviewImage={setPreviewImage} />)}
                  </div>
                )}

                {pendingPrealerts.length === 0 && receivedPrealerts.length === 0 && (
                  <p style={{ color: "var(--t-faint)", fontSize: 13, textAlign: "center", padding: 20 }}>暂无预报单</p>
                )}
              </div>

              {/* 报价区域 */}
              {(taskDetail.status === "quoted" || taskDetail.status === "paid") && taskDetail.totalFee != null && (
                <div style={{ marginBottom: 24, padding: 20, background: "#f0fdf4", borderRadius: 12, border: "1px solid #bbf7d0" }}>
                  <h3 style={{ fontSize: 16, marginBottom: 12 }}>费用明细</h3>
                  <table style={{ width: "100%", maxWidth: 400, fontSize: 14 }}>
                    <tbody>
                      <tr><td style={{ padding: "4px 0", color: "var(--t-muted)" }}>订舱费</td><td style={{ textAlign: "right" }}>¥{taskDetail.bookingFee?.toLocaleString() ?? 0}</td></tr>
                      <tr><td style={{ padding: "4px 0", color: "var(--t-muted)" }}>清关费</td><td style={{ textAlign: "right" }}>¥{taskDetail.customsFee?.toLocaleString() ?? 0}</td></tr>
                      <tr><td style={{ padding: "4px 0", color: "var(--t-muted)" }}>装柜费</td><td style={{ textAlign: "right" }}>¥{taskDetail.loadingFee?.toLocaleString() ?? 0}</td></tr>
                      <tr style={{ borderTop: "2px solid var(--c-green-2)" }}><td style={{ padding: "8px 0", fontWeight: 700 }}>总价</td><td style={{ textAlign: "right", fontSize: 22, fontWeight: 700, color: "var(--c-green-2)" }}>¥{taskDetail.totalFee.toLocaleString()}</td></tr>
                    </tbody>
                  </table>
                </div>
              )}

              {/* 付款区域 */}
              {taskDetail.status === "quoted" && (
                <div style={{ marginBottom: 24 }}>
                  {/* 未付款 → 去付款按钮 */}
                  {taskDetail.paymentStatus === "unpaid" && (
                    <button onClick={() => setShowPay(true)} style={{ padding: "10px 28px", background: "var(--c-blue)", color: "var(--white)", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 15, fontWeight: 600 }}>
                      去付款 ¥{taskDetail.totalFee?.toLocaleString()}
                    </button>
                  )}
                  {/* 待审核 → 提示 */}
                  {taskDetail.paymentStatus === "pending_review" && (
                    <div style={{ padding: "12px 16px", background: "var(--c-amber-bg)", borderRadius: 8, border: "1px solid var(--c-amber)", color: "var(--c-amber-deep)" }}>
                      付款凭证已提交，等待审核中
                    </div>
                  )}
                  {/* 已付款 → 显示已付 */}
                  {taskDetail.paymentStatus === "paid" && (
                    <div style={{ padding: "12px 16px", background: "var(--c-green-bg)", borderRadius: 8, border: "1px solid var(--c-green-2)", color: "var(--c-green-deep)" }}>
                      已付款 {taskDetail.paidAt ? formatBeijingTime(taskDetail.paidAt) : ""}
                    </div>
                  )}
                  {/* 审核拒绝 → 显示拒绝原因 + 重新提交按钮 */}
                  {taskDetail.paymentStatus === "unpaid" && taskDetail.paymentRejectReason && (
                    <div style={{ marginTop: 8, padding: "12px 16px", background: "var(--c-red-bg)", borderRadius: 8, border: "1px solid var(--c-red)" }}>
                      <div style={{ color: "var(--c-red-dark)", fontWeight: 600, marginBottom: 4 }}>付款审核不通过</div>
                      <div style={{ color: "#B02A25", fontSize: 13, marginBottom: 8 }}>{taskDetail.paymentRejectReason}</div>
                      <button onClick={() => setShowPay(true)} style={{ padding: "6px 16px", background: "var(--c-blue)", color: "var(--white)", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>去付款</button>
                    </div>
                  )}
                </div>
              )}

              {/* 状态时间线 */}
              {taskDetail.statusLogs && taskDetail.statusLogs.length > 0 && (
                <div>
                  <h3 style={{ fontSize: 16, marginBottom: 12 }}>状态记录</h3>
                  <div style={{ position: "relative", paddingLeft: 24, borderLeft: "2px solid var(--l-soft)", marginLeft: 8 }}>
                    {taskDetail.statusLogs.map((log: any, i: number) => (
                      <div key={log.id || i} style={{ marginBottom: 16, position: "relative" }}>
                        <div style={{ position: "absolute", left: -30, top: 4, width: 12, height: 12, borderRadius: "50%", background: "#1e3a8a", border: "2px solid var(--white)" }} />
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{STATUS_ZH[log.fromStatus] || log.fromStatus} → {STATUS_ZH[log.toStatus] || log.toStatus}</div>
                        {/* 2026-09-15：不显示操作人，只显示时间（后端也不再下发操作人） */}
                        <div style={{ fontSize: 12, color: "var(--t-muted)" }}>{formatBeijingTime(log.createdAt)}</div>
                        {log.remark && <div style={{ fontSize: 12, color: "var(--t-faint)", marginTop: 2 }}>{log.remark}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ======== 弹窗：创建任务 ======== */}
      {showCreateTask && (
        <Modal onClose={() => setShowCreateTask(false)}>
          <h3 style={{ marginTop: 0 }}>创建集货任务</h3>
          <label style={{ fontSize: 13, color: "var(--t-muted)" }}>目的地地址 *</label>
          <input value={newDest} onChange={(e) => setNewDest(e.target.value)} placeholder="泰国派送地址" style={{ width: "100%", padding: "8px 12px", border: "1px solid var(--l-strong)", borderRadius: 6, marginTop: 4, marginBottom: 12 }} />
          <button onClick={handleCreateTask} disabled={createTaskLoading} style={{ padding: "8px 20px", background: "var(--c-blue)", color: "var(--white)", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}>
            {createTaskLoading ? "创建中..." : "确认创建"}
          </button>
        </Modal>
      )}

      {/* ======== 弹窗：创建/编辑预报单 ======== */}
      {showCreatePrealert && (
        <Modal onClose={() => setShowCreatePrealert(false)} wide>
          <h3 style={{ marginTop: 0 }}>{editPrealertId ? "编辑预报单" : "创建预报单"}</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
            <div>
              <label style={formLabel}>唛头 *</label>
              <input value={prealertMark} onChange={(e) => setPrealertMark(e.target.value)} style={formInput} />
            </div>
            <div>
              <label style={formLabel}>快递单号（可选）</label>
              <input value={prealertExpressNo} onChange={(e) => setPrealertExpressNo(e.target.value)} style={formInput} />
            </div>
          </div>

          <h4 style={{ fontSize: 14, marginBottom: 8 }}>产品明细</h4>
          <div style={{ overflowX: "auto" }}>
            <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "var(--s-sunken)" }}>
                  <th style={thStyle}>产品名称</th>
                  <th style={thStyle}>件数</th>
                  <th style={thStyle}>每箱几个</th>
                  <th style={thStyle}>单件重(kg)</th>
                  <th style={thStyle}>长(cm)</th>
                  <th style={thStyle}>宽(cm)</th>
                  <th style={thStyle}>高(cm)</th>
                  <th style={thStyle}>材质</th>
                  <th style={thStyle}>货值</th>
                  <th style={thStyle}>货型</th>
                  <th style={thStyle}>总数量</th>
                  <th style={thStyle}>总重(kg)</th>
                  <th style={thStyle}>体积(m³)</th>
                  <th style={thStyle}></th>
                </tr>
              </thead>
              <tbody>
                {productRows.map((r, i) => {
                  const { totalQty, totalW, vol } = calcProductRow(r);
                  return (
                    <tr key={r.key} style={{ borderBottom: "1px solid var(--l-soft)" }}>
                      <td style={tdStyle}><input value={r.productName} onChange={(e) => { const next = [...productRows]; next[i] = { ...next[i], productName: e.target.value }; setProductRows(next); }} style={miniInput} /></td>
                      <td style={tdStyle}><input value={r.packageCount} onChange={(e) => { const next = [...productRows]; next[i] = { ...next[i], packageCount: e.target.value }; setProductRows(next); }} style={{ ...miniInput, width: 50 }} /></td>
                      <td style={tdStyle}><input value={r.quantityPerBox} onChange={(e) => { const next = [...productRows]; next[i] = { ...next[i], quantityPerBox: e.target.value }; setProductRows(next); }} style={{ ...miniInput, width: 50 }} /></td>
                      <td style={tdStyle}><input value={r.unitWeightKg} onChange={(e) => { const next = [...productRows]; next[i] = { ...next[i], unitWeightKg: e.target.value }; setProductRows(next); }} style={{ ...miniInput, width: 60 }} /></td>
                      <td style={tdStyle}><input value={r.lengthCm} onChange={(e) => { const next = [...productRows]; next[i] = { ...next[i], lengthCm: e.target.value }; setProductRows(next); }} style={{ ...miniInput, width: 50 }} /></td>
                      <td style={tdStyle}><input value={r.widthCm} onChange={(e) => { const next = [...productRows]; next[i] = { ...next[i], widthCm: e.target.value }; setProductRows(next); }} style={{ ...miniInput, width: 50 }} /></td>
                      <td style={tdStyle}><input value={r.heightCm} onChange={(e) => { const next = [...productRows]; next[i] = { ...next[i], heightCm: e.target.value }; setProductRows(next); }} style={{ ...miniInput, width: 50 }} /></td>
                      <td style={tdStyle}><input value={r.material} onChange={(e) => { const next = [...productRows]; next[i] = { ...next[i], material: e.target.value }; setProductRows(next); }} style={miniInput} /></td>
                      <td style={tdStyle}><input value={r.cargoValue} onChange={(e) => { const next = [...productRows]; next[i] = { ...next[i], cargoValue: e.target.value }; setProductRows(next); }} style={miniInput} /></td>
                      <td style={tdStyle}>
                        <select value={r.cargoType} onChange={(e) => { const next = [...productRows]; next[i] = { ...next[i], cargoType: e.target.value }; setProductRows(next); }} style={{ ...miniInput, width: 70 }}>
                          <option value="normal">普货</option>
                          <option value="inspection">商检货</option>
                          <option value="sensitive">敏感货</option>
                        </select>
                      </td>
                      <td style={{ ...tdStyle, color: "var(--t-muted)" }}>{totalQty || "-"}</td>
                      <td style={{ ...tdStyle, color: "var(--t-muted)" }}>{totalW || "-"}</td>
                      <td style={{ ...tdStyle, color: "var(--t-muted)" }}>{vol || "-"}</td>
                      <td style={tdStyle}><button onClick={() => { if (productRows.length > 1) setProductRows(productRows.filter((_, j) => j !== i)); }} style={{ border: "none", background: "none", color: "var(--c-red)", cursor: "pointer", fontSize: 16 }}>×</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <button onClick={() => setProductRows([...productRows, emptyProductRow(Date.now())])} style={{ marginTop: 10, padding: "4px 14px", border: "1px dashed var(--c-blue)", color: "var(--c-blue)", background: "none", borderRadius: 4, cursor: "pointer", fontSize: 12 }}>
            + 添加产品行
          </button>

          {/* 产品图片上传 */}
          <div style={{ marginTop: 14 }}>
            <label style={formLabel}>产品图片（可选，每行一个）</label>
            {productRows.map((r, i) => (
              <div key={r.key} style={{ marginBottom: 4, fontSize: 12 }}>
                <span>行{i + 1}：</span>
                <input type="file" accept="image/*" onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const rowKey = r.key; // 2026-09-01 竞态全扫：记住出发时是哪一行（key 稳定，序号 i 会变）
                  const base64 = await new Promise<string>((resolve) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve((reader.result as string).split(",")[1]);
                    reader.readAsDataURL(file);
                  });
                  // 2026-09-01 竞态全扫：读图期间用户可能删行/改别的行。
                  // 不能把出发时抄的旧数组整个写回去（会复活已删的行、抹掉新改的字），
                  // 改用函数式更新拿最新数组，按 key 找回那一行；行没了就把图丢弃。
                  setProductRows((rows) => {
                    const idx = rows.findIndex((row) => row.key === rowKey);
                    if (idx < 0) return rows; // 这一行已被删，图片作废，别的行一概不碰
                    const next = [...rows];
                    next[idx] = { ...next[idx], productImage: { fileName: file.name, mime: file.type, base64 } };
                    return next;
                  });
                }} style={{ fontSize: 11 }} />
              </div>
            ))}
          </div>

          <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
            <button onClick={handleSubmitPrealert} disabled={prealertSubmitting} style={{ padding: "8px 20px", background: "var(--c-blue)", color: "var(--white)", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}>
              {prealertSubmitting ? "提交中..." : (editPrealertId ? "保存修改" : "确认创建")}
            </button>
            <button onClick={() => setShowCreatePrealert(false)} style={{ padding: "8px 20px", border: "1px solid var(--l-strong)", background: "var(--white)", borderRadius: 6, cursor: "pointer", color: "var(--t-muted)" }}>取消</button>
          </div>
        </Modal>
      )}

      {/* ======== 弹窗：付款 ======== */}
      {showPay && (
        <Modal onClose={() => setShowPay(false)}>
          {(() => {
            const fee = taskDetail?.totalFee ?? 0;
            const enough = balance >= fee && fee > 0;
            return (
              <>
                <h3 style={{ marginTop: 0 }}>用集货余额付款</h3>
                <p style={{ fontSize: 24, fontWeight: 700, color: "var(--c-navy)", margin: "12px 0" }}>¥{fee.toLocaleString()}</p>
                <div style={{ padding: "10px 12px", border: "1px solid var(--l-soft)", borderRadius: 6, marginBottom: 12 }}>
                  <div style={{ fontSize: 13 }}>当前集货余额：<strong>¥{balance.toFixed(2)}</strong></div>
                  {fee > 0 && (
                    enough
                      ? <div style={{ fontSize: 13, color: "var(--t-body)", marginTop: 4 }}>付款后剩余：¥{(balance - fee).toFixed(2)}</div>
                      : <div style={{ fontSize: 13, color: "var(--c-red-deep)", marginTop: 4 }}>余额不足，还差 ¥{(fee - balance).toFixed(2)}，请先去「集货余额」充值</div>
                  )}
                </div>
                {/* 不可撤销必须写清楚 —— 扣款是当场生效的 */}
                <p style={{ fontSize: 13, color: "var(--c-red-deep)", marginBottom: 14, fontWeight: 600 }}>
                  此次付款不可撤销，误操作请联系客服
                </p>
                <button onClick={handlePay} disabled={payLoading || !enough} style={{ padding: "10px 28px", background: enough ? "var(--c-navy)" : "var(--t-faint)", color: "var(--white)", border: "none", borderRadius: 8, cursor: enough ? "pointer" : "not-allowed", fontWeight: 600, fontSize: 15 }}>
                  {payLoading ? "付款中..." : "确认付款"}
                </button>
              </>
            );
          })()}
        </Modal>
      )}

      {/* ======== 弹窗：删除确认 ======== */}
      {deleteConfirm && (
        <Modal onClose={() => setDeleteConfirm(null)}>
          <p style={{ marginTop: 0 }}>确定删除该预报单吗？已签收的预报单无法删除。</p>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => handleDeletePrealert(deleteConfirm)} style={{ padding: "8px 16px", background: "var(--c-red)", color: "var(--white)", border: "none", borderRadius: 6, cursor: "pointer" }}>确认删除</button>
            <button onClick={() => setDeleteConfirm(null)} style={{ padding: "8px 16px", border: "1px solid var(--l-strong)", background: "var(--white)", borderRadius: 6, cursor: "pointer", color: "var(--t-muted)" }}>取消</button>
          </div>
        </Modal>
      )}
    </RoleShell>
  );
}

// ============================================================================
// 子组件：预报单卡片
// ============================================================================
function PrealertCard({
  pa, expanded, setExpanded, taskStatus, onEdit, onDelete, setPreviewImage,
}: {
  pa: ConsolidationPrealertItem;
  expanded: Set<string>;
  setExpanded: React.Dispatch<React.SetStateAction<Set<string>>>;
  taskStatus: string;
  onEdit?: () => void;
  onDelete?: () => void;
  setPreviewImage: (url: string | null) => void;
}) {
  const isExpanded = expanded.has(pa.id);
  const toggle = () => setExpanded((prev) => { const next = new Set(prev); if (next.has(pa.id)) next.delete(pa.id); else next.add(pa.id); return next; });

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
          <span style={{ fontSize: 11, padding: "2px 6px", borderRadius: 4, background: pa.status === "received" ? "var(--c-green-bg)" : "var(--c-amber-bg)", color: pa.status === "received" ? "var(--c-green-deep)" : "var(--c-amber-deep)", whiteSpace: "nowrap" }}>
            {STATUS_ZH[pa.status]}
          </span>
          {pa.status === "pending" && taskStatus === "collecting" && (
            <>
              {onEdit && <button onClick={(e) => { e.stopPropagation(); onEdit(); }} style={{ border: "1px solid var(--c-blue)", background: "var(--white)", color: "var(--c-blue)", borderRadius: 4, padding: "2px 8px", fontSize: 11, cursor: "pointer" }}>编辑</button>}
              {onDelete && <button onClick={(e) => { e.stopPropagation(); onDelete(); }} style={{ border: "1px solid var(--c-red)", background: "var(--white)", color: "var(--c-red)", borderRadius: 4, padding: "2px 8px", fontSize: 11, cursor: "pointer" }}>删除</button>}
            </>
          )}
        </div>
      </div>

      {isExpanded && (
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
                <th style={{ ...thStyle, minWidth: 100, whiteSpace: "nowrap" }}>唛头</th>
                <th style={{ ...thStyle, minWidth: 160, whiteSpace: "nowrap" }}>运单号</th>
                <th style={{ ...thStyle, minWidth: 80, whiteSpace: "nowrap" }}>产品名称</th>
                <th style={thStyle}>件数</th>
                <th style={thStyle}>装箱数量</th>
                <th style={thStyle}>总数量</th>
                <th style={thStyle}>单件重量</th>
                <th style={thStyle}>总重量</th>
                <th style={thStyle}>长</th>
                <th style={thStyle}>宽</th>
                <th style={thStyle}>高</th>
                <th style={thStyle}>体积</th>
                <th style={thStyle}>材质</th>
                <th style={thStyle}>货值</th>
                <th style={thStyle}>货型</th>
                <th style={thStyle}>图片</th>
              </tr>
            </thead>
            <tbody>
              {pa.products.map((p, i) => (
                <tr key={p.id} style={{ borderBottom: "1px solid var(--l-soft)" }}>
                  {i === 0 && <td rowSpan={pa.products.length} style={{ ...tdStyle, minWidth: 100, whiteSpace: "nowrap", verticalAlign: "middle" , textAlign: "center" }}>{pa.mark}</td>}
                  {i === 0 && <td rowSpan={pa.products.length} style={{ ...tdStyle, minWidth: 160, whiteSpace: "nowrap", verticalAlign: "middle" , textAlign: "center" }}>{pa.trackingNo}</td>}
                  <td style={{ ...tdStyle, minWidth: 80, whiteSpace: "nowrap" }}>{p.productName}</td>
                  <td style={tdStyle}>{p.packageCount}</td>
                  <td style={tdStyle}>{p.quantityPerBox}</td>
                  <td style={tdStyle}>{p.totalQuantity}</td>
                  <td style={tdStyle}>{p.unitWeight}</td>
                  <td style={tdStyle}>{p.totalWeight}</td>
                  <td style={tdStyle}>{p.length}</td>
                  <td style={tdStyle}>{p.width}</td>
                  <td style={tdStyle}>{p.height}</td>
                  <td style={tdStyle}>{p.volume?.toFixed(4)}</td>
                  <td style={tdStyle}>{p.material}</td>
                  <td style={tdStyle}>{p.cargoValue}</td>
                  <td style={tdStyle}>{p.cargoType === "inspection" ? "商检货" : p.cargoType === "sensitive" ? "敏感货" : "普货"}</td>
                  <td style={{ ...tdStyle, textAlign: "center" }}>
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
// Modal 组件
// ============================================================================
function Modal({ children, onClose, wide }: { children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 9000, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--white)", borderRadius: 12, padding: 24, maxWidth: wide ? 1100 : 480, width: "90%", maxHeight: "85vh", overflowY: "auto", boxShadow: "0 8px 32px rgba(0,0,0,0.2)" }}>
        {children}
      </div>
    </div>
  );
}

// ============================================================================
// 公共样式
// ============================================================================
const thStyle: React.CSSProperties = { textAlign: "left", padding: "6px 8px", fontSize: 12, color: "var(--t-muted)", fontWeight: 600, borderBottom: "2px solid var(--l-soft)" };
const tdStyle: React.CSSProperties = { padding: "5px 8px", fontSize: 12 };
const formLabel: React.CSSProperties = { display: "block", fontSize: 13, color: "var(--t-body)", fontWeight: 500, marginBottom: 2 };
const formInput: React.CSSProperties = { width: "100%", padding: "6px 10px", border: "1px solid var(--l-strong)", borderRadius: 6, fontSize: 13, boxSizing: "border-box" };
const miniInput: React.CSSProperties = { width: "100%", padding: "2px 4px", border: "1px solid var(--l-strong)", borderRadius: 3, fontSize: 11, boxSizing: "border-box" };
