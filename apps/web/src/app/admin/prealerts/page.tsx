"use client";

import { useEffect, useMemo, useState } from "react";
import PrealertSearch from "../../../modules/shipment/PrealertSearch";
import EmptyStateCard from "../../../modules/layout/EmptyStateCard";
import RoleShell from "../../../modules/layout/RoleShell";
import Toast from "../../../modules/layout/Toast";
import {
  approveStaffPrealert,
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
  receivableAmountCny: number;
  receivableCurrency: "CNY" | "THB";
  domesticTrackingNo: string;
  transportMode: "sea" | "land";
  shipDate: string;
};

const prealertEditInputStyle: React.CSSProperties = {
  border: "1px solid #d1d5db",
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
    receivableAmountCny: item.receivableAmountCny ?? 0,
    receivableCurrency: (item.receivableCurrency as "CNY" | "THB") ?? "CNY",
    domesticTrackingNo: firstProduct?.domesticTrackingNo || item.domesticTrackingNo ?? "",
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
    clientName: "",
    domesticTrackingNo: "",
    warehouseId: "",
    transportMode: "",
  });
  const [prealertEditDrafts, setPrealertEditDrafts] = useState<Record<string, PrealertEditDraft>>({});
  const [prealertConfirmedDrafts, setPrealertConfirmedDrafts] = useState<Record<string, PrealertEditDraft>>({});
  const [editingPrealertId, setEditingPrealertId] = useState<string | null>(null);

  const loadPrealerts = async () => {
    setLoading(true);
    try {
      const items = await fetchStaffPrealerts();
      setPrealerts(items);
      setMessage("");
    } catch (err) {
      setMessage(`加载失败：${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadPrealerts(); }, []);

  const filteredPrealerts = useMemo(() => {
    return prealerts.filter((item) => {
      if (prealertSearch.clientName) {
        const cn = `${item.clientName ?? ""} ${item.clientId ?? ""}`.toLowerCase();
        if (!cn.includes(prealertSearch.clientName.toLowerCase())) return false;
      }
      if (prealertSearch.domesticTrackingNo && !(item.domesticTrackingNo ?? "").toLowerCase().includes(prealertSearch.domesticTrackingNo.toLowerCase())) return false;
      if (prealertSearch.warehouseId && item.warehouseId !== prealertSearch.warehouseId) return false;
      if (prealertSearch.transportMode && item.transportMode !== prealertSearch.transportMode) return false;
      return true;
    });
  }, [prealerts, prealertSearch]);

  const handleApprove = async (item: OrderItem) => {
    const draft = prealertConfirmedDrafts[item.id] ?? buildPrealertDraft(item);
    if (!draft.warehouseId) { setMessage("请选择仓库"); return; }
    if (!draft.itemName.trim()) { setMessage("请输入品名"); return; }
    if (!draft.packageCount || draft.packageCount < 1) { setMessage("请输入箱数"); return; }
    if (!draft.receivableAmountCny || draft.receivableAmountCny < 0) { setMessage("请输入应收金额"); return; }
    setLoading(true);
    try {
      await approveStaffPrealert({
        orderId: item.id,
        batchNo: `BATCH_${Date.now()}`,
        warehouseId: draft.warehouseId,
        itemName: draft.itemName.trim(),
        packageCount: draft.packageCount,
        packageUnit: draft.packageUnit,
        productQuantity: draft.productQuantity,
        weightKg: draft.weightKg || undefined,
        volumeM3: draft.volumeM3 || undefined,
        receivableAmountCny: draft.receivableAmountCny,
        receivableCurrency: draft.receivableCurrency,
        domesticTrackingNo: draft.domesticTrackingNo.trim() || undefined,
        transportMode: draft.transportMode,
        shipDate: draft.shipDate || undefined,
      });
      setToast("审核通过，已生成运单");
      setEditingPrealertId(null);
      await loadPrealerts();
    } catch (err) {
      setMessage(`审核失败：${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <RoleShell role="admin">
      <Toast message={toast} />
      <div style={{ maxWidth: 1400, margin: "0 auto", padding: "24px 16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "#111827" }}>预报单审核</h1>
          <button onClick={loadPrealerts} disabled={loading} style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "6px 12px", background: "#fff", cursor: "pointer", color: "#000" }}>刷新</button>
        </div>
        {message ? <div style={{ marginBottom: 12, padding: 10, background: "#fef2f2", borderRadius: 8, color: "#b91c1c", fontSize: 13 }}>{message}</div> : null}
        <PrealertSearch
          value={prealertSearch}
          onChange={(key, val) => setPrealertSearch((prev) => ({ ...prev, [key]: val }))}
          onSearch={() => {}}
          warehouseOptions={warehouseOptions}
          inputStyle={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 10px", fontSize: 13, width: "100%" }}
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
                  <div key={item.id} style={{ border: "1px solid #e5e7eb", borderRadius: 6, padding: 12, background: "#fff" }}>
                    <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6, color: "#000" }}>
                      <span style={{ fontFamily: "monospace" }}>{item.orderNo || item.id}</span>
                      {" · "}{item.clientName ?? item.clientId ?? "-"}
                      {" · "}{item.createdAt.slice(0, 10)}
                    </div>
                    {(item.products?.length ?? 0) > 1 && (
                      <div style={{ fontSize: 11, color: "#000", marginBottom: 6, background: "#fefce8", borderRadius: 4, padding: "3px 6px" }}>
                        {item.products!.map((p) => `${p.itemName}×${p.packageCount}箱`).join(" | ")}
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
                          <input type="number" value={String(draft.packageCount)} onChange={(e) => setPrealertEditDrafts((prev) => ({ ...prev, [item.id]: { ...(prev[item.id] ?? buildPrealertDraft(item)), packageCount: Number(e.target.value || 0) } }))} placeholder="箱数" style={prealertEditInputStyle} />
                          <select value={draft.packageUnit} onChange={(e) => setPrealertEditDrafts((prev) => ({ ...prev, [item.id]: { ...(prev[item.id] ?? buildPrealertDraft(item)), packageUnit: e.target.value as "bag" | "box" } }))} style={prealertEditInputStyle}>
                            <option value="box">箱</option><option value="bag">袋</option>
                          </select>
                          <input type="number" value={String(draft.productQuantity)} onChange={(e) => setPrealertEditDrafts((prev) => ({ ...prev, [item.id]: { ...(prev[item.id] ?? buildPrealertDraft(item)), productQuantity: Number(e.target.value || 0) } }))} placeholder="产品数量" style={prealertEditInputStyle} />
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <input type="number" step="0.01" value={String(draft.weightKg)} onChange={(e) => setPrealertEditDrafts((prev) => ({ ...prev, [item.id]: { ...(prev[item.id] ?? buildPrealertDraft(item)), weightKg: Number(e.target.value || 0) } }))} placeholder="重量" style={{ ...prealertEditInputStyle, marginBottom: 0 }} /><span style={{ fontSize: 12 }}>kg</span>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <input type="number" step="0.001" value={String(draft.volumeM3)} onChange={(e) => setPrealertEditDrafts((prev) => ({ ...prev, [item.id]: { ...(prev[item.id] ?? buildPrealertDraft(item)), volumeM3: Number(e.target.value || 0) } }))} placeholder="体积" style={{ ...prealertEditInputStyle, marginBottom: 0 }} /><span style={{ fontSize: 12 }}>m³</span>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <input type="number" step="0.01" value={String(draft.receivableAmountCny)} onChange={(e) => setPrealertEditDrafts((prev) => ({ ...prev, [item.id]: { ...(prev[item.id] ?? buildPrealertDraft(item)), receivableAmountCny: Number(e.target.value || 0) } }))} placeholder="应收金额" style={{ ...prealertEditInputStyle, marginBottom: 0 }} />
                            <select value={draft.receivableCurrency} onChange={(e) => setPrealertEditDrafts((prev) => ({ ...prev, [item.id]: { ...(prev[item.id] ?? buildPrealertDraft(item)), receivableCurrency: e.target.value as "CNY" | "THB" } }))} style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 4px", fontSize: 12 }}><option value="CNY">CNY</option><option value="THB">THB</option></select>
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
                          <span>应收：<strong>{displayDraft.receivableAmountCny ? `${displayDraft.receivableAmountCny} ${displayDraft.receivableCurrency}` : "—"}</strong></span>
                          <span>运输：<strong>{displayDraft.transportMode === "sea" ? "海运" : "陆运"}</strong></span>
                          <span>国内单号：<strong>{displayDraft.domesticTrackingNo || "—"}</strong></span>
                          <span>发货日：<strong>{displayDraft.shipDate || "—"}</strong></span>
                        </>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      {isEditing ? (
                        <>
                          <button onClick={() => {
                            setPrealertConfirmedDrafts((prev) => ({ ...prev, [item.id]: draft }));
                            setEditingPrealertId(null);
                          }} style={{ border: "1px solid #059669", borderRadius: 6, padding: "4px 12px", background: "#f0fdf4", color: "#059669", cursor: "pointer", fontSize: 12 }}>确认修改</button>
                          <button onClick={() => { setEditingPrealertId(null); }} style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "4px 12px", background: "#fff", cursor: "pointer", fontSize: 12, color: "#000" }}>取消</button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => setEditingPrealertId(item.id)} style={{ border: "1px solid #2563eb", borderRadius: 6, padding: "4px 12px", background: "#eff6ff", color: "#2563eb", cursor: "pointer", fontSize: 12 }}>编辑</button>
                          <button disabled={loading} onClick={() => handleApprove(item)} style={{ border: "none", borderRadius: 6, padding: "4px 12px", background: "#16a34a", color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>审核通过</button>
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
    </RoleShell>
  );
}
