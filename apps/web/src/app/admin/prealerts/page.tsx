"use client";

import { optionalIntegerForReceive, optionalNumberForReceive, validateReceiveDraft } from "../../../modules/staff/utils";
import { useEffect, useMemo, useState } from "react";
import PrealertSearch from "../../../modules/shipment/PrealertSearch";
import EmptyStateCard from "../../../modules/layout/EmptyStateCard";
import Toast from "../../../modules/layout/Toast";
import {
  receiveStaffPrealert,
  fetchStaffPrealerts,
  type OrderItem,
} from "../../../services/business-api";

type PrealertEditDraft = {
  warehouseId: string;
  itemName: string;
  packageCount: number;
  packageUnit: "bag" | "box";
  productQuantity: number;
  weightKg: number;
  volumeM3: number;
  domesticTrackingNo: string;
  transportMode: "sea" | "land";
  shipDate: string;
};

const prealertEditInputStyle: React.CSSProperties = {
  border: "1px solid var(--l-strong)",
  borderRadius: 6,
  padding: "6px 8px",
  fontSize: 12,
  width: "100%",
};

const warehouseOptions = [
  { id: "wh_yiwu_01", label: "义乌仓" },
  { id: "wh_guangzhou_01", label: "广州仓" },
  { id: "wh_dongguan_01", label: "东莞仓" },
  { id: "wh_shenzhen_01", label: "深圳仓" },
];

function buildPrealertDraft(item: OrderItem): PrealertEditDraft {
  const firstProduct = item.products?.[0];
  return {
    warehouseId: item.warehouseId ?? "",
    itemName: item.itemName ?? "",
    packageCount: item.packageCount ?? 0,
    packageUnit: (item.packageUnit as "bag" | "box") ?? "box",
    productQuantity: item.productQuantity ?? 0,
    weightKg: item.weightKg ?? 0,
    volumeM3: item.volumeM3 ?? 0,
    domesticTrackingNo: (firstProduct?.domesticTrackingNo || item.domesticTrackingNo) ?? "",
    transportMode: (item.transportMode as "sea" | "land") ?? "sea",
    shipDate: item.shipDate?.slice(0, 10) ?? "",
  };
}

export default function AdminPrealertsPage() {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [toast, setToast] = useState("");
  const [prealerts, setPrealerts] = useState<OrderItem[]>([]);
  const [prealertSearch, setPrealertSearch] = useState({
    keyword: "",
    warehouseId: "",
    itemName: "",
    domesticTrackingNo: "",
  });
  const [prealertEditDrafts, setPrealertEditDrafts] = useState<Record<string, PrealertEditDraft>>({});
  const [prealertConfirmedDrafts, setPrealertConfirmedDrafts] = useState<Record<string, PrealertEditDraft>>({});
  const [editingPrealertId, setEditingPrealertId] = useState<string | null>(null);
  /* 柜号草稿（收货时可选录入）。应收金额录入 2026-08-31 深夜按老板拍板拆除——
     钱只在集货里，普通运单不录钱。 */
  const [prealertBatchDrafts, setPrealertBatchDrafts] = useState<Record<string, string>>({});

  const loadPrealerts = async (cancelled?: { current: boolean }) => {
    setLoading(true);
    try {
      const items = await fetchStaffPrealerts();
      if (cancelled?.current) return;
      setPrealerts(items);
      setMessage("");
    } catch (err) {
      if (cancelled?.current) return;
      setMessage(`加载失败：${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      if (!cancelled?.current) setLoading(false);
    }
  };

  useEffect(() => { const c = { current: false }; loadPrealerts(c); return () => { c.current = true; }; }, []);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(""), 2200);
    return () => window.clearTimeout(t);
  }, [toast]);

  const filteredPrealerts = useMemo(() => {
    const kw = prealertSearch.keyword.trim().toLowerCase();
    const domesticKw = prealertSearch.domesticTrackingNo.trim().toLowerCase();
    const itemKw = prealertSearch.itemName.trim().toLowerCase();
    return prealerts
      .filter((item) => {
        if (!kw) return true;
        const searchText = `${item.trackingNo ?? ""} ${item.orderNo ?? ""} ${item.clientId ?? ""} ${item.clientName ?? ""}`.toLowerCase();
        return searchText.includes(kw);
      })
      .filter((item) => {
        if (!domesticKw) return true;
        return (item.domesticTrackingNo ?? "").toLowerCase().includes(domesticKw);
      })
      .filter((item) => {
        if (!itemKw) return true;
        return (item.itemName ?? "").toLowerCase().includes(itemKw);
      })
      .filter((item) => !prealertSearch.warehouseId || item.warehouseId === prealertSearch.warehouseId);
  }, [prealerts, prealertSearch]);

  const handleReceive = async (item: OrderItem) => {
    const draft = prealertConfirmedDrafts[item.id] ?? buildPrealertDraft(item);
    if (!draft.warehouseId) { setMessage("请选择仓库"); return; }
    if (!draft.itemName.trim()) { setMessage("请输入品名"); return; }
    /**
     * ⚠️ 换成共用校验（2026-08-29）：原来是 `< 1`，**2.5 箱能过**，
     * 而库里是 Int。员工端那个弹窗以前一道校验都没有，现在两边走同一份。
     */
    const batchNo = (prealertBatchDrafts[item.id] ?? "").trim();
    {
      // 同上：传原值，识别「清空了原有的数」
      const issue = validateReceiveDraft(draft, {
        weightKg: (item as any).weightKg,
        volumeM3: (item as any).volumeM3,
      });
      if (issue) { setMessage(issue); return; }
    }
    setLoading(true);
    try {
      await receiveStaffPrealert({
        orderId: item.id,
        itemName: draft.itemName.trim(),
        packageCount: draft.packageCount,
        packageUnit: draft.packageUnit,
        // 空着或 0 → 不发（后端要求正整数，发 0 会被 400 打回来）
        productQuantity: optionalIntegerForReceive(draft.productQuantity),
        // 空着或 0 → 不发这个字段（后端语义是「没传 = 不改」）
        weightKg: optionalNumberForReceive(draft.weightKg),
        volumeM3: optionalNumberForReceive(draft.volumeM3),
        domesticTrackingNo: draft.domesticTrackingNo.trim() || undefined,
        transportMode: draft.transportMode,
        /* 2026-08-31 条目30 → 深夜老板重申「钱只在集货里」：应收金额录入拆除，柜号保留。 */
        batchNo: batchNo || undefined,
      });
      setToast("已确认收货");
      setEditingPrealertId(null);
      await loadPrealerts();
    } catch (err) {
      setMessage(`确认收货失败：${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Toast open={toast.length > 0} message={toast} />
      <div style={{ maxWidth: 1400, margin: "0 auto", padding: "24px 16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "var(--t-heading)" }}>预报单收货确认</h1>
          <button onClick={() => loadPrealerts()} disabled={loading} style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "6px 12px", background: "var(--white)", cursor: "pointer", color: "var(--t-strong)" }}>刷新</button>
        </div>
        {message ? <div style={{ marginBottom: 12, padding: 10, background: "#fef2f2", borderRadius: 8, color: "var(--c-red-deep)", fontSize: 13 }}>{message}</div> : null}
        <PrealertSearch
          value={prealertSearch}
          onChange={(key, val) => setPrealertSearch((prev) => ({ ...prev, [key]: val }))}
          onSearch={() => {}}
          warehouseOptions={warehouseOptions}
          inputStyle={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "8px 10px", fontSize: 13, width: "100%" }}
        />
        <div style={{ marginTop: 16 }}>
          {prealerts.length === 0 ? (
            <EmptyStateCard title="暂无待审核预报单" description="客户提交预报单后会在这里显示" />
          ) : filteredPrealerts.length === 0 ? (
            <EmptyStateCard title="未找到匹配预报单" description="调整筛选条件" />
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              {filteredPrealerts.map((item) => {
                const draft = prealertEditDrafts[item.id] ?? buildPrealertDraft(item);
                const isEditing = editingPrealertId === item.id;
                const confirmedDraft = prealertConfirmedDrafts[item.id] ?? buildPrealertDraft(item);
                const displayDraft = isEditing ? draft : confirmedDraft;
                return (
                  <div key={item.id} style={{ border: "1px solid var(--l-soft)", borderRadius: 6, padding: 12, background: "var(--white)" }}>
                    <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6, color: "var(--t-strong)" }}>
                      <span style={{ fontFamily: "monospace" }}>{item.trackingNo || item.orderNo || "—"}</span>
                      {" · "}{item.clientId ?? "-"}
                      {" · "}{item.createdAt.slice(0, 10)}
                    </div>
                    {(item.products?.length ?? 0) > 1 && (
                      <div style={{ fontSize: 11, color: "var(--t-strong)", marginBottom: 6, background: "#fefce8", borderRadius: 4, padding: "3px 6px" }}>
                        {(item.products ?? []).map((p) => `${p.itemName}×${p.packageCount}箱`).join(" | ")}
                      </div>
                    )}
                    <div style={{ marginBottom: 8, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 4 }}>
                      {isEditing ? (
                        <>
                          <select value={draft.warehouseId} onChange={(e) => setPrealertEditDrafts((prev) => ({ ...prev, [item.id]: { ...(prev[item.id] ?? buildPrealertDraft(item)), warehouseId: e.target.value } }))} style={prealertEditInputStyle}>
                            <option value="">选择仓库</option>
                            {warehouseOptions.map((w) => (<option key={w.id} value={w.id}>{w.label}</option>))}
                          </select>
                          <input value={draft.itemName} onChange={(e) => setPrealertEditDrafts((prev) => ({ ...prev, [item.id]: { ...(prev[item.id] ?? buildPrealertDraft(item)), itemName: e.target.value } }))} placeholder="品名" style={prealertEditInputStyle} />
                          <input type="number" value={draft.packageCount ? String(draft.packageCount) : ""} onChange={(e) => setPrealertEditDrafts((prev) => ({ ...prev, [item.id]: { ...(prev[item.id] ?? buildPrealertDraft(item)), packageCount: Number(e.target.value || 0) } }))} placeholder="箱数" style={prealertEditInputStyle} />
                          <select value={draft.packageUnit} onChange={(e) => setPrealertEditDrafts((prev) => ({ ...prev, [item.id]: { ...(prev[item.id] ?? buildPrealertDraft(item)), packageUnit: e.target.value as "bag" | "box" } }))} style={prealertEditInputStyle}>
                            <option value="box">箱</option><option value="bag">袋</option>
                          </select>
                          <input type="number" value={draft.productQuantity ? String(draft.productQuantity) : ""} onChange={(e) => setPrealertEditDrafts((prev) => ({ ...prev, [item.id]: { ...(prev[item.id] ?? buildPrealertDraft(item)), productQuantity: Number(e.target.value || 0) } }))} placeholder="产品数量" style={prealertEditInputStyle} />
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <input type="number" step="0.01" value={draft.weightKg ? String(draft.weightKg) : ""} onChange={(e) => setPrealertEditDrafts((prev) => ({ ...prev, [item.id]: { ...(prev[item.id] ?? buildPrealertDraft(item)), weightKg: Number(e.target.value || 0) } }))} placeholder="重量" style={{ ...prealertEditInputStyle, marginBottom: 0 }} /><span style={{ fontSize: 12 }}>kg</span>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <input type="number" step="0.001" value={draft.volumeM3 ? String(draft.volumeM3) : ""} onChange={(e) => setPrealertEditDrafts((prev) => ({ ...prev, [item.id]: { ...(prev[item.id] ?? buildPrealertDraft(item)), volumeM3: Number(e.target.value || 0) } }))} placeholder="体积" style={{ ...prealertEditInputStyle, marginBottom: 0 }} /><span style={{ fontSize: 12 }}>m³</span>
                          </div>
                          <select value={draft.transportMode} onChange={(e) => setPrealertEditDrafts((prev) => ({ ...prev, [item.id]: { ...(prev[item.id] ?? buildPrealertDraft(item)), transportMode: e.target.value as "sea" | "land" } }))} style={prealertEditInputStyle}><option value="sea">海运</option><option value="land">陆运</option></select>
                          <input value={draft.domesticTrackingNo} onChange={(e) => setPrealertEditDrafts((prev) => ({ ...prev, [item.id]: { ...(prev[item.id] ?? buildPrealertDraft(item)), domesticTrackingNo: e.target.value } }))} placeholder="货拉拉" style={prealertEditInputStyle} />
                          <input type="date" value={draft.shipDate} onChange={(e) => setPrealertEditDrafts((prev) => ({ ...prev, [item.id]: { ...(prev[item.id] ?? buildPrealertDraft(item)), shipDate: e.target.value } }))} style={prealertEditInputStyle} />
                        </>
                      ) : (
                        <>
                          <span>仓库：<strong>{warehouseOptions.find(w => w.id === displayDraft.warehouseId)?.label ?? "—"}</strong></span>
                          <span>品名：<strong>{displayDraft.itemName || "—"}</strong></span>
                          <span>箱数：<strong>{displayDraft.packageCount}</strong></span>
                          <span>包装：<strong>{displayDraft.packageUnit === "bag" ? "袋" : "箱"}</strong></span>
                          <span>产品数量：<strong>{displayDraft.productQuantity || "—"}</strong></span>
                          <span>重量：<strong>{displayDraft.weightKg ? `${displayDraft.weightKg}kg` : "—"}</strong></span>
                          <span>体积：<strong>{displayDraft.volumeM3 ? `${displayDraft.volumeM3}m³` : "—"}</strong></span>
                          <span>运输：<strong>{displayDraft.transportMode === "sea" ? "海运" : "陆运"}</strong></span>
                          <span>国内单号：<strong>{displayDraft.domesticTrackingNo || "—"}</strong></span>
                          <span>发货日：<strong>{displayDraft.shipDate || "—"}</strong></span>
                        </>
                      )}
                    </div>
                    {!isEditing && (
                      /* 2026-08-31 条目30 → 深夜老板重申「钱只在集货里」：
                         应收金额输入框已拆除，收货只录柜号（选填）。 */
                      <div style={{ display: "flex", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
                        <div style={{ flex: 1, minWidth: 160 }}>
                          <div style={{ fontSize: 12, color: "var(--t-strong)", marginBottom: 4 }}>柜号（可选）</div>
                          <input value={prealertBatchDrafts[item.id] ?? ""}
                            onChange={(e) => setPrealertBatchDrafts((prev) => ({ ...prev, [item.id]: e.target.value }))}
                            placeholder="柜号（装柜时填写）" style={prealertEditInputStyle} />
                        </div>
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      {isEditing ? (
                        <>
                          <button onClick={() => {
                            setPrealertConfirmedDrafts((prev) => ({ ...prev, [item.id]: draft }));
                            setEditingPrealertId(null);
                          }} style={{ border: "1px solid var(--c-green)", borderRadius: 6, padding: "4px 12px", background: "#f0fdf4", color: "var(--c-green)", cursor: "pointer", fontSize: 12 }}>确认修改</button>
                          <button onClick={() => { setEditingPrealertId(null); }} style={{ border: "1px solid var(--l-strong)", borderRadius: 6, padding: "4px 12px", background: "var(--white)", cursor: "pointer", fontSize: 12, color: "var(--t-strong)" }}>取消</button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => setEditingPrealertId(item.id)} style={{ border: "1px solid var(--c-blue)", borderRadius: 6, padding: "4px 12px", background: "var(--c-blue-bg)", color: "var(--c-blue)", cursor: "pointer", fontSize: 12 }}>编辑</button>
                          <button disabled={loading} onClick={() => handleReceive(item)} style={{ border: "none", borderRadius: 6, padding: "4px 12px", background: "var(--c-green-3)", color: "var(--white)", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>确认收货</button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
