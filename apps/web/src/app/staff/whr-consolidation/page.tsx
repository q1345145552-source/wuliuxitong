"use client";

import { useEffect, useState, useCallback } from "react";
import RoleShell from "../../../modules/layout/RoleShell";
import { authHeaders, apiBaseUrl, parseApiResponse } from "../../../services/core-api";
import { formatBeijingTime } from "../../../modules/staff/utils";

// ============================================================================
// 状态中文
// ============================================================================
const PLAN_ST_ZH: Record<string, string> = {
  planning: "计划中", collecting: "集货中", loading: "装柜中", shipped: "已发运", completed: "已完成", cancelled: "已取消",
};
const CUSTOMER_ST_ZH: Record<string, string> = {
  filling: "填货中", received_pending_payment: "待付款", paid: "已付款",
  loading: "装柜中", shipped: "已发运", thailand_received: "泰国已签收", cancelled: "已取消",
};
const TAG: Record<string, { bg: string; color: string }> = {
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
interface DispatchCustomerItem {
  id: string; productName: string; packageCount: number; quantityPerBox: number;
  totalQuantity: number; lengthCm: number | null; widthCm: number | null; heightCm: number | null;
  unitWeightKg: number | null; totalWeightKg: number | null; volumeM3: number | null;
  material: string; cargoValue: string; cargoType: string;
  productImageFileName: string | null; productImageBase64: string | null; sortOrder: number;
}
interface DispatchCustomer {
  id: string; clientId: string; clientName: string; clientPhone: string; clientCompany: string;
  status: string; unitPriceNormal: number; unitPriceInspection: number; unitPriceSensitive: number;
  totalVolumeM3: number; totalFee: number | null; deliveryAddress: string | null;
  totalItems: number; totalPackages: number; createdAt: string;
  prealerts?: { id: string; trackingNo: string; mark: string; expressNo: string | null; status: string; items: DispatchCustomerItem[] }[];
}
interface DispatchPlan {
  planId: string; planNo: string; warehouse: string; containerType: string; destinationTh: string;
  totalVolumeM3: number; planStatus: string; customers: DispatchCustomer[]; createdAt: string;
}

// Operations Tab
interface OpCustomer {
  id: string; planId: string; planNo: string; clientId: string; clientName: string; clientPhone: string;
  clientCompany: string; status: string; totalVolumeM3: number; totalFee: number | null; createdAt: string;
}

interface PlanItem {
  id: string; planNo: string; warehouse: string; containerType: string; destinationTh: string;
  totalVolumeM3: number; status: string; creatorName: string; customerCount: number; createdAt: string;
}
interface PlanDetail { id: string; planNo: string; warehouse: string; containerType: string; destinationTh: string;
  totalVolumeM3: number; status: string; creatorName: string; createdAt: string; updatedAt: string;
  customers: any[];
}

// ============================================================================
// 共用样式
// ============================================================================
const thS: React.CSSProperties = { padding: "6px 10px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "#374151", borderBottom: "2px solid #e5e7eb", whiteSpace: "nowrap" };
const tdS: React.CSSProperties = { padding: "7px 10px", fontSize: 13, borderBottom: "1px solid #f3f4f6", verticalAlign: "middle" };
const btnBlue: React.CSSProperties = { padding: "8px 18px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600, fontSize: 13 };
const btnGray: React.CSSProperties = { padding: "8px 18px", border: "1px solid #d1d5db", color: "#6b7280", background: "#fff", borderRadius: 6, cursor: "pointer", fontSize: 13 };
const btnGreen: React.CSSProperties = { padding: "8px 18px", background: "#059669", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600, fontSize: 13 };
const fl: React.CSSProperties = { display: "block", fontSize: 13, color: "#374151", fontWeight: 500, marginBottom: 3 };
const fi: React.CSSProperties = { width: "100%", padding: "7px 10px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13, boxSizing: "border-box" };

// ============================================================================
// 主页面
// ============================================================================
export default function StaffWhrConsolidationPage() {
  const [activeTab, setActiveTab] = useState<"dispatch" | "operations" | "plans">("dispatch");
  const [toast, setToast] = useState("");

  // ---- 尾端拆派 ----
  const [dispatchData, setDispatchData] = useState<DispatchPlan[]>([]);
  const [dispatchLoading, setDispatchLoading] = useState(false);
  const [expandedPlan, setExpandedPlan] = useState<string | null>(null);
  const [expandedCustomer, setExpandedCustomer] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // ---- 操作区 ----
  const [opsLoading, setOpsLoading] = useState(false);
  const [opsData, setOpsData] = useState<{ filling: OpCustomer[]; pendingPayment: OpCustomer[]; paid: OpCustomer[]; loading: OpCustomer[]; shipped: OpCustomer[] }>({ filling: [], pendingPayment: [], paid: [], loading: [], shipped: [] });
  const [opSubmitting, setOpSubmitting] = useState<Record<string, boolean>>({});

  // ---- 泰国签收 ----
  const [thailandTarget, setThailandTarget] = useState<OpCustomer | null>(null);
  const [thailandFile, setThailandFile] = useState<{ base64: string; fileName: string; mime: string } | null>(null);
  const [thailandSubmitting, setThailandSubmitting] = useState(false);

  // ---- 仓库签收弹窗 ----
  const [signTarget, setSignTarget] = useState<OpCustomer | null>(null);
  const [signFile, setSignFile] = useState<{ base64: string; fileName: string; mime: string } | null>(null);
  const [signSubmitting, setSignSubmitting] = useState(false);

  // ---- 审核付款 ----
  const [reviewTarget, setReviewTarget] = useState<any>(null);
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectPriceNormal, setRejectPriceNormal] = useState("");
  const [rejectPriceInspection, setRejectPriceInspection] = useState("");
  const [rejectPriceSensitive, setRejectPriceSensitive] = useState("");
  const [reviewDetailLoading, setReviewDetailLoading] = useState(false);

  // ---- 拼柜计划 ----
  const [planList, setPlanList] = useState<PlanItem[]>([]);
  const [planDetail, setPlanDetail] = useState<PlanDetail | null>(null);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);

  // ---- 图片预览 ----
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  // ================================================================
  // 数据加载
  // ================================================================
  const loadDispatch = useCallback(async () => {
    setDispatchLoading(true);
    try {
      const data = await parseApiResponse<{ items: DispatchPlan[] }>(
        await fetch(`${apiBaseUrl()}/staff/whr-consolidation/dispatch-view`, { headers: authHeaders() })
      );
      setDispatchData(data.items ?? []);
    } catch (e: any) { setToast(e?.message ?? "加载拆派视图失败"); }
    finally { setDispatchLoading(false); }
  }, []);

  const loadOperations = useCallback(async () => {
    setOpsLoading(true);
    try {
      // 加载所有计划详情，提取各状态客户
      const plansData = await parseApiResponse<{ items: PlanItem[] }>(
        await fetch(`${apiBaseUrl()}/admin/whr-consolidation/plans`, { headers: authHeaders() })
      );
      const allPlans = plansData.items ?? [];
      const filling: OpCustomer[] = []; const pendingPayment: OpCustomer[] = []; const paid: OpCustomer[] = [];
      const loading: OpCustomer[] = []; const shipped: OpCustomer[] = [];

      for (const p of allPlans) {
        try {
          const detail = await parseApiResponse<PlanDetail>(
            await fetch(`${apiBaseUrl()}/admin/whr-consolidation/plans/detail?planId=${encodeURIComponent(p.id)}`, { headers: authHeaders() })
          );
          for (const c of detail.customers ?? []) {
            const row: OpCustomer = { id: c.id, planId: p.id, planNo: p.planNo, clientId: c.clientId, clientName: c.clientName, clientPhone: c.clientPhone, clientCompany: c.clientCompany, status: c.status, totalVolumeM3: c.totalVolumeM3, totalFee: c.totalFee, createdAt: c.createdAt };
            if (c.status === "filling") filling.push(row);
            else if (c.status === "received_pending_payment") pendingPayment.push(row);
            else if (c.status === "paid") paid.push(row);
            else if (c.status === "loading") loading.push(row);
            else if (c.status === "shipped") shipped.push(row);
          }
        } catch { /* skip failed plan detail */ }
      }
      setOpsData({ filling, pendingPayment, paid, loading, shipped });
    } catch (e: any) { setToast(e?.message ?? "加载操作数据失败"); }
    finally { setOpsLoading(false); }
  }, []);

  const loadPlans = useCallback(async () => {
    setPlanLoading(true);
    try {
      const data = await parseApiResponse<{ items: PlanItem[] }>(
        await fetch(`${apiBaseUrl()}/admin/whr-consolidation/plans`, { headers: authHeaders() })
      );
      setPlanList(data.items ?? []);
    } catch (e: any) { setToast(e?.message ?? "加载计划列表失败"); }
    finally { setPlanLoading(false); }
  }, []);

  const loadPlanDetail = useCallback(async (planId: string) => {
    setDetailLoading(true);
    try {
      const data = await parseApiResponse<PlanDetail>(
        await fetch(`${apiBaseUrl()}/admin/whr-consolidation/plans/detail?planId=${encodeURIComponent(planId)}`, { headers: authHeaders() })
      );
      setPlanDetail(data);
    } catch (e: any) { setToast(e?.message ?? "加载详情失败"); }
    finally { setDetailLoading(false); }
  }, []);

  useEffect(() => {
    if (activeTab === "dispatch") loadDispatch();
    else if (activeTab === "operations") loadOperations();
    else if (activeTab === "plans") loadPlans();
  }, [activeTab, loadDispatch, loadOperations, loadPlans]);

  // ================================================================
  // 操作函数
  // ================================================================
  const doOpAction = async (url: string, planId: string, customerId: string, key: string) => {
    setOpSubmitting(p => ({ ...p, [key]: true }));
    try {
      await parseApiResponse<any>(
        await fetch(`${apiBaseUrl()}${url}`, {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ planId, customerId }),
        })
      );
      setToast("操作成功");
      loadOperations();
      if (activeTab === "dispatch") loadDispatch();
    } catch (e: any) { setToast(e?.message ?? "操作失败"); }
    finally { setOpSubmitting(p => ({ ...p, [key]: false })); }
  };


  const handleReviewApprove = async () => {
    if (!reviewTarget) return;
    setReviewSubmitting(true);
    try {
      await parseApiResponse<any>(
        await fetch(`${apiBaseUrl()}/admin/whr-consolidation/customers/review`, {
          method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ planId: reviewTarget.planId, customerId: reviewTarget.customer.id, action: "approve" }),
        })
      );
      setToast("审核通过");
      setReviewTarget(null);
      loadOperations();
      if (activeTab === "dispatch") loadDispatch();
    } catch (e: any) { setToast(e?.message ?? "审核失败"); }
    finally { setReviewSubmitting(false); }
  };

  const handleReviewReject = async () => {
    if (!reviewTarget || !rejectReason.trim()) { setToast("请填写拒绝原因"); return; }
    setReviewSubmitting(true);
    try {
      await parseApiResponse<any>(
        await fetch(`${apiBaseUrl()}/admin/whr-consolidation/customers/review`, {
          method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            planId: reviewTarget.planId, customerId: reviewTarget.customer.id,
            action: "reject", rejectReason: rejectReason.trim(),
            unitPriceNormal: rejectPriceNormal ? Number(rejectPriceNormal) : undefined,
            unitPriceInspection: rejectPriceInspection ? Number(rejectPriceInspection) : undefined,
            unitPriceSensitive: rejectPriceSensitive ? Number(rejectPriceSensitive) : undefined,
          }),
        })
      );
      setToast("已拒绝");
      setShowReject(false); setReviewTarget(null); setRejectReason(""); setRejectPriceNormal(""); setRejectPriceInspection(""); setRejectPriceSensitive("");
      loadOperations();
      if (activeTab === "dispatch") loadDispatch();
    } catch (e: any) { setToast(e?.message ?? "操作失败"); }
    finally { setReviewSubmitting(false); }
  };

  const handleLoadReviewDetail = async (c: OpCustomer) => {
    setReviewDetailLoading(true);
    try {
      const detail = await parseApiResponse<PlanDetail>(
        await fetch(`${apiBaseUrl()}/admin/whr-consolidation/plans/detail?planId=${encodeURIComponent(c.planId)}`, { headers: authHeaders() })
      );
      const customer = (detail.customers ?? []).find((x: any) => x.id === c.id);
      setReviewTarget({ planId: c.planId, customer });
    } catch (e: any) { setToast(e?.message ?? "加载客户详情失败"); }
    finally { setReviewDetailLoading(false); }
  };


  const handleWarehouseSign = async () => {
    if (!signTarget || !signFile) { setToast("请上传收货凭证照片"); return; }
    setSignSubmitting(true);
    try {
      await parseApiResponse<any>(
        await fetch(`${apiBaseUrl()}/staff/whr-consolidation/warehouse-sign`, {
          method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            planId: signTarget.planId, customerId: signTarget.id,
            receiptFileName: signFile.fileName, receiptMime: signFile.mime, receiptBase64: signFile.base64,
          }),
        })
      );
      setToast("签收成功");
      setSignTarget(null); setSignFile(null);
      loadOperations();
      if (activeTab === "dispatch") loadDispatch();
    } catch (e: any) { setToast(e?.message ?? "签收失败"); }
    finally { setSignSubmitting(false); }
  };

  const handleThailandSign = async () => {
    if (!thailandTarget || !thailandFile) { setToast("请选择签收单文件"); return; }
    setThailandSubmitting(true);
    try {
      await parseApiResponse<any>(
        await fetch(`${apiBaseUrl()}/staff/whr-consolidation/thailand-sign`, {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ planId: thailandTarget.planId, customerId: thailandTarget.id, fileName: thailandFile.fileName, mime: thailandFile.mime, base64: thailandFile.base64 }),
        })
      );
      setToast("泰国签收成功");
      setThailandTarget(null); setThailandFile(null);
      loadOperations(); loadDispatch();
    } catch (e: any) { setToast(e?.message ?? "签收失败"); }
    finally { setThailandSubmitting(false); }
  };

  // ================================================================
  // Excel 导出
  // ================================================================
  const handleExport = async () => {
    setExporting(true);
    try {
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("尾端拆派");

      const headers = ["计划编号", "仓库", "柜型", "目的地", "客户名", "预报单号", "唛头", "品名", "件数", "方数(m³)", "重量(kg)", "收货地址", "状态"];
      const colCount = headers.length;

      // 表头样式
      const headerRow = ws.addRow(headers);
      headerRow.eachCell((cell) => {
        cell.font = { bold: true, size: 11 };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE5E7EB" } };
        cell.alignment = { horizontal: "center", vertical: "middle" };
      });

      // 计划分组标题样式
      const planHeaderStyle = {
        font: { bold: true, size: 12, color: { argb: "FFFFFFFF" } },
        fill: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FF2563EB" } },
        alignment: { horizontal: "left" as const, vertical: "middle" as const },
      };

      // 汇总行样式
      const subtotalStyle = {
        font: { bold: true, size: 11, color: { argb: "FF059669" } },
        fill: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFF0FDF4" } },
      };

      let currentRow = 2; // 表头占第1行

      for (const p of dispatchData) {
        // ====== 计划分组标题行 ======
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
            ws.addRow([p.planNo, p.warehouse, p.containerType, p.destinationTh, c.clientName, "", "", "", "", "", "", c.deliveryAddress ?? "", CUSTOMER_ST_ZH[c.status] ?? c.status]);
            currentRow++;
          } else {
            for (const pa of prealerts) {
              const items = pa.items ?? [];
              let isFirst = true;

              if (items.length === 0) {
                ws.addRow([p.planNo, p.warehouse, p.containerType, p.destinationTh, c.clientName, pa.trackingNo, pa.mark, "", "", "", "", c.deliveryAddress ?? "", CUSTOMER_ST_ZH[c.status] ?? c.status]);
                currentRow++;
              } else {
                for (const it of items) {
                  const vol = it.volumeM3 ?? 0;
                  customerTotalVol += vol;
                  planTotalVol += vol;

                  ws.addRow([
                    p.planNo, p.warehouse, p.containerType, p.destinationTh, c.clientName,
                    isFirst ? pa.trackingNo : "",       // 预报单号只在第一行显示
                    isFirst ? pa.mark : "",
                    it.productName, it.packageCount, vol, it.totalWeightKg ?? 0,
                    c.deliveryAddress ?? "", CUSTOMER_ST_ZH[c.status] ?? c.status,
                  ]);
                  isFirst = false;
                  currentRow++;
                }
              }
            }
          }

          // ====== 客户小计行 ======
          if (customerTotalVol > 0) {
            const subRow = ws.addRow(["", "", "", "", `${c.clientName} 小计`, "", "", "", "", customerTotalVol.toFixed(3), "", "", "", ""]);
            subRow.eachCell((cell, colIdx) => {
              if (colIdx === 10) cell.font = subtotalStyle.font; // 方数列
              cell.fill = subtotalStyle.fill;
            });
            currentRow++;
          }
        }

        // ====== 计划汇总行 ======
        if (planTotalVol > 0) {
          const totalRow = ws.addRow(["", "", "", "", `${p.planNo} 合计`, "", "", "", "", planTotalVol.toFixed(3), "", "", "", ""]);
          totalRow.eachCell((cell, colIdx) => {
            if (colIdx === 10) cell.font = { bold: true, size: 12, color: { argb: "FF059669" } };
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFECFDF5" } };
          });
          totalRow.height = 22;
          currentRow++;
        }

        // 计划间空一行
        currentRow++;
      }

      // 列宽
      ws.columns = headers.map((_, i) => {
        if (i === 0 || i === 4 || i === 5 || i === 11) return { width: 16 }; // planNo, 客户名, 预报单号, 地址
        if (i === 7) return { width: 18 }; // 品名
        return { width: 12 };
      });

      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `尾端拆派_${new Date().toISOString().slice(0, 10)}.xlsx`; a.click();
      URL.revokeObjectURL(url);
      setToast("导出成功");
    } catch (e: any) { setToast(e?.message ?? "导出失败"); }
    finally { setExporting(false); }
  };

  // ================================================================
  // 渲染
  // ================================================================
  const tabBtnStyle = (tab: string): React.CSSProperties => ({
    padding: "10px 24px", border: "none", background: activeTab === tab ? "#2563eb" : "#f3f4f6",
    color: activeTab === tab ? "#fff" : "#374151", borderRadius: "8px 8px 0 0", cursor: "pointer", fontWeight: 600, fontSize: 14,
  });

  return (
    <RoleShell allowedRole={["staff", "admin"]} title="集货拼柜（仓库版）">
      <div style={{ maxWidth: "100%", padding: "20px 24px" }}>
        {/* Toast */}
        {toast && (
          <div onClick={() => setToast("")} style={{ cursor: "pointer", marginBottom: 16, padding: "10px 16px", background: "#fef3c7", color: "#92400e", borderRadius: 8, fontSize: 14 }}>{toast}</div>
        )}

        {/* Tab 切换 */}
        <div style={{ display: "flex", gap: 4, marginBottom: 20, borderBottom: "2px solid #2563eb" }}>
          <button onClick={() => { setActiveTab("dispatch"); setExpandedPlan(null); setExpandedCustomer(null); }} style={tabBtnStyle("dispatch")}>尾端拆派</button>
          <button onClick={() => setActiveTab("operations")} style={tabBtnStyle("operations")}>操作区</button>
          <button onClick={() => { setActiveTab("plans"); setSelectedPlanId(null); setPlanDetail(null); }} style={tabBtnStyle("plans")}>拼柜计划</button>
        </div>

        {/* ================================================================ */}
        {/* TAB 1: 尾端拆派 */}
        {/* ================================================================ */}
        {activeTab === "dispatch" && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <h3 style={{ margin: 0, fontSize: 17 }}>尾端拆派视图</h3>
              <button onClick={handleExport} disabled={exporting} style={btnGreen}>{exporting ? "导出中..." : "📥 导出 Excel"}</button>
            </div>
            {dispatchLoading ? <p style={{ color: "#9ca3af" }}>加载中...</p> :
             dispatchData.length === 0 ? <p style={{ color: "#9ca3af" }}>暂无数据</p> :
              dispatchData.map(p => {
                const planExpanded = expandedPlan === p.planId;
                return (
                  <div key={p.planId} style={{ border: "1px solid #e5e7eb", borderRadius: 10, marginBottom: 12, overflow: "hidden" }}>
                    <div onClick={() => setExpandedPlan(planExpanded ? null : p.planId)} style={{ cursor: "pointer", padding: "10px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", background: planExpanded ? "#f9fafb" : "white" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <strong style={{ fontSize: 15 }}>{p.planNo}</strong>
                        <span style={{ fontSize: 13, color: "#6b7280" }}>{p.warehouse} · {p.containerType} · {p.destinationTh} · {p.totalVolumeM3}方</span>
                      </div>
                      <span style={{ fontSize: 12, color: "#9ca3af" }}>{p.customers.length} 个客户 {planExpanded ? "▲" : "▼"}</span>
                    </div>
                    {planExpanded && p.customers.map(c => {
                      const cExpanded = expandedCustomer === c.id;
                      const flatItems = (c.prealerts ?? []).flatMap(pa => (pa.items ?? []).map(it => ({ ...it, prealertTrackingNo: pa.trackingNo, prealertMark: pa.mark })));
                      return (
                        <div key={c.id} style={{ borderTop: "1px solid #e5e7eb" }}>
                          <div onClick={() => setExpandedCustomer(cExpanded ? null : c.id)} style={{ cursor: "pointer", padding: "8px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", background: cExpanded ? "#fafafa" : "white" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                              <strong style={{ fontSize: 14 }}>{c.clientName}</strong>
                              <span style={{ fontSize: 12, color: "#6b7280" }}>{c.clientPhone} · {c.clientCompany}</span>
                              <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 4, background: TAG[c.status]?.bg ?? "#e5e7eb", color: TAG[c.status]?.color ?? "#374151" }}>{CUSTOMER_ST_ZH[c.status] ?? c.status}</span>
                              {c.warehouseReceiptBase64 && (
                                <img src={c.warehouseReceiptBase64} alt="收货凭证" onClick={(e) => { e.stopPropagation(); setPreviewImage(c.warehouseReceiptBase64!); }} style={{ width: 32, height: 32, objectFit: "cover", borderRadius: 4, border: "1px solid #e5e7eb", cursor: "pointer" }} title="收货凭证" />
                              )}
                              {c.thailandReceiptBase64 && (
                                <img src={c.thailandReceiptBase64} alt="泰国签收单" onClick={(e) => { e.stopPropagation(); setPreviewImage(c.thailandReceiptBase64!); }} style={{ width: 32, height: 32, objectFit: "cover", borderRadius: 4, border: "1px solid #10b981", cursor: "pointer" }} title="泰国签收单" />
                              )}
                            </div>
                            <span style={{ fontSize: 12, color: "#9ca3af" }}>{c.totalVolumeM3}方 · {c.totalPackages}件 {cExpanded ? "▲" : "▼"}</span>
                          </div>
                          {cExpanded && flatItems.length > 0 && (
                            <div style={{ padding: "8px 16px", background: "#fafafa", overflowX: "auto" }}>
                              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                                <thead><tr style={{ background: "#f3f4f6" }}>
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
                                    <td style={{ ...tdS, padding: "4px 8px", fontSize: 11 }}>{it.cargoType === "inspection" ? "商检" : it.cargoType === "sensitive" ? "敏感" : "普货"}</td>
                                  </tr>
                                ))}</tbody>
                              </table>
                            </div>
                          )}
                          {c.deliveryAddress && cExpanded && <div style={{ padding: "4px 16px 8px", fontSize: 12, color: "#6b7280" }}>收货地址：{c.deliveryAddress}</div>}
                        </div>
                      );
                    })}
                  </div>
                );
              })
            }
          </>
        )}

        {/* ================================================================ */}
        {/* TAB 2: 操作区 */}
        {/* ================================================================ */}
        {activeTab === "operations" && (
          <>
            <h3 style={{ fontSize: 17, marginBottom: 16 }}>操作区</h3>
            {opsLoading ? <p style={{ color: "#9ca3af" }}>加载中...</p> : (
              <>
                {/* 仓库签收 */}
                <Section title="仓库签收" count={opsData.filling.length} emptyMsg="无待签收客户">
                  {opsData.filling.map(c => (
                    <div key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid #f3f4f6", fontSize: 13 }}>
                      <div><strong>{c.clientName}</strong> · <span style={{ color: "#6b7280" }}>{c.planNo} · {c.totalVolumeM3}方{ c.clientCompany ? ` · ${c.clientCompany}` : ""}</span></div>
                      <button onClick={() => setSignTarget(c)} style={btnBlue}>签收</button>
                    </div>
                  ))}
                </Section>


                {/* 审核付款 */}
                <Section title="审核付款" count={opsData.pendingPayment.length} emptyMsg="无待审核客户">
                  {opsData.pendingPayment.map(c => (
                    <div key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid #f3f4f6", fontSize: 13 }}>
                      <div><strong>{c.clientName}</strong> · <span style={{ color: "#6b7280" }}>{c.planNo} · {c.totalVolumeM3}方 · ¥{c.totalFee?.toLocaleString() ?? "—"}{ c.clientCompany ? ` · ${c.clientCompany}` : ""}</span></div>
                      <button onClick={() => handleLoadReviewDetail(c)} disabled={reviewDetailLoading} style={btnBlue}>
                        {reviewDetailLoading ? "加载中..." : "审核"}
                      </button>
                    </div>
                  ))}
                </Section>

                {/* 装柜确认 */}
                <Section title="装柜确认" count={opsData.paid.length} emptyMsg="无待装柜客户">
                  {opsData.paid.map(c => (
                    <div key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid #f3f4f6", fontSize: 13 }}>
                      <div><strong>{c.clientName}</strong> · <span style={{ color: "#6b7280" }}>{c.planNo} · {c.totalVolumeM3}方 · ¥{c.totalFee?.toLocaleString() ?? "—"}{ c.clientCompany ? ` · ${c.clientCompany}` : ""}</span></div>
                      <button onClick={() => doOpAction("/staff/whr-consolidation/loading-confirm", c.planId, c.id, `load-${c.id}`)} disabled={opSubmitting[`load-${c.id}`]} style={btnBlue}>
                        {opSubmitting[`load-${c.id}`] ? "处理中..." : "确认装柜"}
                      </button>
                    </div>
                  ))}
                </Section>

                {/* 发运确认 */}
                <Section title="发运确认" count={opsData.loading.length} emptyMsg="无待发运客户">
                  {opsData.loading.map(c => (
                    <div key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid #f3f4f6", fontSize: 13 }}>
                      <div><strong>{c.clientName}</strong> · <span style={{ color: "#6b7280" }}>{c.planNo} · {c.totalVolumeM3}方{ c.clientCompany ? ` · ${c.clientCompany}` : ""}</span></div>
                      <button onClick={() => doOpAction("/staff/whr-consolidation/ship-confirm", c.planId, c.id, `ship-${c.id}`)} disabled={opSubmitting[`ship-${c.id}`]} style={btnBlue}>
                        {opSubmitting[`ship-${c.id}`] ? "处理中..." : "确认发运"}
                      </button>
                    </div>
                  ))}
                </Section>

                {/* 泰国签收 */}
                <Section title="泰国签收" count={opsData.shipped.length} emptyMsg="无待泰国签收客户">
                  {opsData.shipped.map(c => (
                    <div key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid #f3f4f6", fontSize: 13 }}>
                      <div><strong>{c.clientName}</strong> · <span style={{ color: "#6b7280" }}>{c.planNo} · {c.totalVolumeM3}方{ c.clientCompany ? ` · ${c.clientCompany}` : ""}</span></div>
                      <button onClick={() => setThailandTarget(c)} style={btnBlue}>上传签收单</button>
                    </div>
                  ))}
                </Section>
              </>
            )}
          </>
        )}

        {/* ================================================================ */}
        {/* TAB 3: 拼柜计划 */}
        {/* ================================================================ */}
        {activeTab === "plans" && (
          <>
            {!selectedPlanId ? (
              <>
                <h3 style={{ fontSize: 17, marginBottom: 16 }}>拼柜计划概览</h3>
                {planLoading ? <p style={{ color: "#9ca3af" }}>加载中...</p> :
                 planList.length === 0 ? <p style={{ color: "#9ca3af" }}>暂无计划</p> :
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead><tr style={{ background: "#f9fafb" }}>
                      {["计划编号","仓库","柜型","目的地","总方数","客户数","状态","创建人","创建时间"].map(h => <th key={h} style={thS}>{h}</th>)}
                    </tr></thead>
                    <tbody>{planList.map(p => (
                      <tr key={p.id} onClick={() => { setSelectedPlanId(p.id); loadPlanDetail(p.id); }} style={{ cursor: "pointer", background: "white" }}
                        onMouseEnter={e => (e.currentTarget.style.background = "#f9fafb")}
                        onMouseLeave={e => (e.currentTarget.style.background = "white")}>
                        <td style={{ ...tdS, fontWeight: 600, minWidth: 120, whiteSpace: "nowrap" }}>{p.planNo}</td>
                        <td style={tdS}>{p.warehouse}</td>
                        <td style={tdS}>{p.containerType}</td>
                        <td style={tdS}>{p.destinationTh}</td>
                        <td style={tdS}>{p.totalVolumeM3}方</td>
                        <td style={tdS}>{p.customerCount}</td>
                        <td style={tdS}><span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 4, background: TAG[p.status]?.bg ?? "#e5e7eb", color: TAG[p.status]?.color ?? "#374151" }}>{PLAN_ST_ZH[p.status] ?? p.status}</span></td>
                        <td style={tdS}>{p.creatorName}</td>
                        <td style={tdS}>{formatBeijingTime(p.createdAt)}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                }
              </>
            ) : (
              <>
                <button onClick={() => { setSelectedPlanId(null); setPlanDetail(null); }} style={{ ...btnGray, marginBottom: 16 }}>← 返回列表</button>
                {detailLoading ? <p style={{ color: "#9ca3af" }}>加载中...</p> :
                 !planDetail ? <p style={{ color: "#9ca3af" }}>计划不存在</p> :
                  <div>
                    <div style={{ background: "#f9fafb", borderRadius: 10, padding: "14px 18px", marginBottom: 20 }}>
                      <h3 style={{ margin: "0 0 8px", fontSize: 17 }}>{planDetail.planNo}</h3>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 20px", fontSize: 13, color: "#374151" }}>
                        <span>仓库：{planDetail.warehouse}</span><span>柜型：{planDetail.containerType}</span><span>目的地：{planDetail.destinationTh}</span><span>总方数：{planDetail.totalVolumeM3}方</span>
                        <span>状态：<span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 4, background: TAG[planDetail.status]?.bg ?? "#e5e7eb", color: TAG[planDetail.status]?.color ?? "#374151" }}>{PLAN_ST_ZH[planDetail.status] ?? planDetail.status}</span></span>
                        <span>创建人：{planDetail.creatorName}</span><span>创建时间：{formatBeijingTime(planDetail.createdAt)}</span>
                      </div>
                    </div>
                    {planDetail.customers.map((c: any) => (
                      <div key={c.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, marginBottom: 10, padding: "12px 16px" }}>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", fontSize: 13 }}>
                          <strong>{c.clientName}</strong>
                          <span style={{ color: "#6b7280" }}>{c.clientPhone} · {c.clientCompany}</span>
                          <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 4, background: TAG[c.status]?.bg ?? "#e5e7eb", color: TAG[c.status]?.color ?? "#374151" }}>{CUSTOMER_ST_ZH[c.status] ?? c.status}</span>
                          <span style={{ color: "#6b7280" }}>{c.totalVolumeM3}方 · {c.unitPriceNormal}/{c.unitPriceInspection}/{c.unitPriceSensitive} 元/方 · ¥{c.totalFee?.toLocaleString() ?? "—"}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                }
              </>
            )}
          </>
        )}


        {/* ================================================================ */}
        {/* 弹窗：审核付款 */}
        {/* ================================================================ */}
        {reviewTarget && !showReject && (
          <Modal onClose={() => setReviewTarget(null)}>
            <h3 style={{ marginTop: 0 }}>审核付款 - {reviewTarget.customer.clientName}</h3>
            {/* 费用明细 */}
            {(() => {
              const allItems = (reviewTarget.customer.prealerts ?? []).flatMap((pa: any) => pa.items ?? []);
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
            {(reviewTarget.customer.prealerts ?? []).map((pa: any) => (
              <div key={pa.id} style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 4 }}>{pa.trackingNo} · {pa.mark} · {pa.items.reduce((s: number, it: any) => s + it.packageCount, 0)}件</div>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, marginBottom: 4 }}>
                  <thead><tr style={{ background: "#f9fafb" }}>
                    <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>品名</th>
                    <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>件数</th>
                    <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>方数</th>
                    <th style={{ ...thS, padding: "3px 6px", fontSize: 11 }}>类型</th>
                  </tr></thead>
                  <tbody>{pa.items.map((it: any) => (
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
                    <img key={i} src={p.base64Path} alt={`凭证 ${i + 1}`} onClick={() => setPreviewImage(p.base64Path)} style={{ width: 80, height: 80, objectFit: "cover", borderRadius: 4, border: "1px solid #e5e7eb", cursor: "pointer" }} />
                  ))}
                </div>
              </div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={handleReviewApprove} disabled={reviewSubmitting} style={btnBlue}>{reviewSubmitting ? "处理中..." : "✓ 审核通过"}</button>
              <button onClick={() => setShowReject(true)} disabled={reviewSubmitting} style={btnGray}>✗ 审核不通过</button>
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
                <div><label style={fl}>修改普货单价</label><input type="number" value={rejectPriceNormal} onChange={e => setRejectPriceNormal(e.target.value)} placeholder="留空不修改" style={fi} /></div>
                <div><label style={fl}>修改商检单价</label><input type="number" value={rejectPriceInspection} onChange={e => setRejectPriceInspection(e.target.value)} placeholder="留空不修改" style={fi} /></div>
                <div><label style={fl}>修改敏感单价</label><input type="number" value={rejectPriceSensitive} onChange={e => setRejectPriceSensitive(e.target.value)} placeholder="留空不修改" style={fi} /></div>
              </div>
            </div>
            <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
              <button onClick={handleReviewReject} disabled={reviewSubmitting} style={btnBlue}>{reviewSubmitting ? "提交中..." : "确认拒绝"}</button>
              <button onClick={() => { setShowReject(false); setRejectReason(""); }} style={btnGray}>取消</button>
            </div>
          </Modal>
        )}

        {/* ================================================================ */}
        {/* 弹窗：仓库签收 */}
        {/* ================================================================ */}
        {signTarget && (
          <Modal onClose={() => { setSignTarget(null); setSignFile(null); }}>
            <h3 style={{ marginTop: 0 }}>仓库签收 - {signTarget.clientName}</h3>
            <p style={{ fontSize: 13, color: "#6b7280" }}>{signTarget.planNo} · {signTarget.totalVolumeM3} 方</p>
            <div style={{ marginTop: 14 }}>
              <label style={fl}>收货凭证照片 *</label>
              <input type="file" accept="image/*" onChange={async e => {
                const file = e.target.files?.[0]; if (!file) return;
                const base64 = await new Promise<string>(r => { const fr = new FileReader(); fr.onload = () => r((fr.result as string).split(",")[1]); fr.readAsDataURL(file); });
                setSignFile({ base64, fileName: file.name, mime: file.type });
              }} style={{ marginTop: 4 }} />
              {signFile && <div style={{ fontSize: 12, color: "#10b981", marginTop: 4 }}>已选择: {signFile.fileName}</div>}
            </div>
            <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
              <button onClick={handleWarehouseSign} disabled={signSubmitting || !signFile} style={{ ...btnBlue, opacity: !signFile ? 0.5 : 1, cursor: !signFile ? "not-allowed" : "pointer" }}>
                {signSubmitting ? "提交中..." : "确认签收"}
              </button>
              <button onClick={() => { setSignTarget(null); setSignFile(null); }} style={btnGray}>取消</button>
            </div>
          </Modal>
        )}

        {/* ================================================================ */}
        {/* 弹窗：泰国签收 */}
        {/* ================================================================ */}
        {thailandTarget && (
          <Modal onClose={() => { setThailandTarget(null); setThailandFile(null); }}>
            <h3 style={{ marginTop: 0 }}>泰国签收 - {thailandTarget.clientName}</h3>
            <p style={{ fontSize: 13, color: "#6b7280" }}>{thailandTarget.planNo} · {thailandTarget.totalVolumeM3} 方</p>
            <div style={{ marginTop: 14 }}>
              <label style={fl}>签收单文件 *</label>
              <input type="file" accept="image/*" onChange={async e => {
                const file = e.target.files?.[0]; if (!file) return;
                const base64 = await new Promise<string>(r => { const fr = new FileReader(); fr.onload = () => r((fr.result as string).split(",")[1]); fr.readAsDataURL(file); });
                setThailandFile({ base64, fileName: file.name, mime: file.type });
              }} style={{ marginTop: 4 }} />
              {thailandFile && <div style={{ fontSize: 12, color: "#10b981", marginTop: 4 }}>已选择: {thailandFile.fileName}</div>}
            </div>
            <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
              <button onClick={handleThailandSign} disabled={thailandSubmitting || !thailandFile} style={{ ...btnBlue, opacity: !thailandFile ? 0.5 : 1, cursor: !thailandFile ? "not-allowed" : "pointer" }}>
                {thailandSubmitting ? "提交中..." : "确认签收"}
              </button>
              <button onClick={() => { setThailandTarget(null); setThailandFile(null); }} style={btnGray}>取消</button>
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
// Section 组件
// ============================================================================
function Section({ title, count, emptyMsg, children }: { title: string; count: number; emptyMsg: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <h4 style={{ fontSize: 15, margin: "0 0 10px", color: "#374151" }}>{title} ({count})</h4>
      {count === 0 ? <p style={{ fontSize: 14, color: "#9ca3af", padding: "12px 0" }}>{emptyMsg}</p> : children}
    </div>
  );
}

// ============================================================================
// Modal 组件
// ============================================================================
function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, padding: 24, maxWidth: 520, width: "90vw", maxHeight: "85vh", overflowY: "auto", boxShadow: "0 8px 30px rgba(0,0,0,0.15)" }}>
        {children}
      </div>
    </div>
  );
}
