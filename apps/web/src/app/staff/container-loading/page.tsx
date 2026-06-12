"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import RoleShell from "../../../modules/layout/RoleShell";
import Toast from "../../../modules/layout/Toast";
import {
  fetchLoadingManifests,
  createLoadingManifest,
  fetchLoadingManifestDetail,
  sealLoadingManifest,
  addShipmentToManifest,
  removeShipmentFromManifest,
  fetchStaffShipments,
  deleteContainer,
  updateContainerStatus,
  type LoadingManifestItem,
  type LoadingManifestDetail,
  type ShipmentItem,
} from "../../../services/business-api";

const STATUS_LABEL: Record<string, string> = {
  LOADING: "装柜中",
  SEALED: "已封柜",
  IN_TRANSIT: "运输中",
  DELAY_DEPARTED: "延迟开船",
  ARRIVED: "已到港",
  CUSTOMS: "清关中",
  CUSTOMS_CLEARED: "清关已放行",
  IN_WAREHOUSE_TH: "已到仓",
};

const STATUS_FLOW = ["LOADING", "SEALED", "IN_TRANSIT", "DELAY_DEPARTED", "ARRIVED", "CUSTOMS", "CUSTOMS_CLEARED", "IN_WAREHOUSE_TH"] as const;

const WAREHOUSE_ZH: Record<string, string> = {
  wh_yiwu_01: "义乌仓",
  wh_guangzhou_01: "广州仓",
  wh_dongguan_01: "东莞仓",
  wh_shenzhen_01: "深圳仓",
};

const SHIPMENT_STATUS_ZH: Record<string, string> = {
  created: "已创建", pickedup: "已揽收", inwarehousecn: "国内仓已收货", receivedcn: "国内仓已收货",
  customspending: "报关中", loaded: "已装柜", delayDeparted: "延迟开船", delaydeparted: "延迟开船",
  departed: "已开船", arrivedPort: "已到港", arrivedport: "已到港", intransit: "运输中",
  customsTH: "清关中", customsth: "清关中", customsCleared: "清关已放行", customscleared: "清关已放行",
  inWarehouseTH: "已到仓", inwarehouseth: "已到仓", outfordelivery: "派送中", delivered: "派送完成",
  exception: "异常", returned: "已退回", cancelled: "已取消",
};

const STATUS_COLOR: Record<string, string> = {
  LOADING: "#d97706",
  SEALED: "#16a34a",
  IN_TRANSIT: "#2563eb",
  ARRIVED: "#000000",
};

const inputStyle = { border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 12px", fontSize: 13, background: "#fff" } as const;

export default function StaffContainerLoadingPage() {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [list, setList] = useState<LoadingManifestItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ warehouse: "wh_yiwu_01", voyage: "", vesselName: "", containerNo: "" });
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<LoadingManifestDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [adding, setAdding] = useState(false);
  const [statusRemark, setStatusRemark] = useState("");
  const [statusDate, setStatusDate] = useState("");
  const [targetStatus, setTargetStatus] = useState("");
    
  // 运单列表搜索
  const [allShipments, setAllShipments] = useState<ShipmentItem[]>([]);
  const [shipSearch, setShipSearch] = useState({ trackingNo: "", clientId: "", transportMode: "" });
  const [selectedShipments, setSelectedShipments] = useState<Record<string, number>>({});
  const [bulkPieceDialog, setBulkPieceDialog] = useState<string | null>(null);
  const [bulkPieceCount, setBulkPieceCount] = useState("");
  // 已装柜运单映射：shipmentId → container manifestNo
  const [loadedShipments, setLoadedShipments] = useState<Record<string, string>>({});

  // 加载运单列表 + 已装柜信息
  useEffect(() => {
    Promise.all([
      fetchStaffShipments(),
      fetchLoadingManifests({ query: "", status: "ALL" }),
    ]).then(([shipments, manifests]) => {
      setAllShipments(shipments);
      // 获取所有柜子的已装运单
      const mapping: Record<string, string> = {};
      Promise.all(manifests.map((m) =>
        fetchLoadingManifestDetail(m.id).then((d) => {
          d.bills.forEach((b) => { mapping[b.shipmentId] = m.manifestNo; });
        }).catch(() => {})
      )).then(() => setLoadedShipments(mapping));
    }).catch(() => {});
  }, []);

  // 筛选运单
  const filteredShipments = useMemo(() => {
    return allShipments.filter((s) => {
      if (shipSearch.trackingNo && !(s.trackingNo ?? "").toLowerCase().includes(shipSearch.trackingNo.toLowerCase())) return false;
      if (shipSearch.clientId && !(s.clientId ?? "").toLowerCase().includes(shipSearch.clientId.toLowerCase())) return false;
      if (shipSearch.transportMode && s.transportMode !== shipSearch.transportMode) return false;
      return true;
    });
  }, [allShipments, shipSearch]);

  // 已在本柜中的运单 ID 集合
  const existingShipmentIds = useMemo(() => {
    const set = new Set<string>();
    if (detail) detail.bills.forEach((b) => set.add(b.shipmentId));
    return set;
  }, [detail]);

  const loadList = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const items = await fetchLoadingManifests({ query: query.trim(), status: statusFilter });
      setList(items);
      if (!selectedId && items.length > 0) setSelectedId(items[0].id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
      setList([]);
    } finally {
      setLoading(false);
    }
  }, [query, statusFilter, selectedId]);

  useEffect(() => { void loadList(); }, []);

  const loadDetail = useCallback(async (id: string) => {
    if (!id) return;
    setStatusRemark("");
    setLoadingDetail(true);
    try {
      const d = await fetchLoadingManifestDetail(id);
      setDetail(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "详情加载失败");
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  useEffect(() => { if (selectedId) void loadDetail(selectedId); }, [selectedId, loadDetail]);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const result = await createLoadingManifest({
        warehouse: createForm.warehouse,
        containerNo: createForm.containerNo,
        carrierInfo: [createForm.voyage, createForm.vesselName].filter(Boolean).join(" / ") || undefined,
      });
      setToast(`装柜任务已创建: ${result.manifestNo}`);
      setShowCreate(false);
      setCreateForm({ warehouse: "wh_yiwu_01", voyage: "", vesselName: "", containerNo: "" });
      await loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败");
    } finally {
      setCreating(false);
    }
  };

  const handlePushStatus = async (toStatus: string) => {
    if (!selectedId || !detail) return;
    try {
      const result = await updateContainerStatus({ id: selectedId, toStatus, remark: statusRemark.trim() || undefined, date: statusDate || undefined });
      setStatusRemark("");
      setStatusDate("");
      setToast(`柜子「${result.containerNo}」已推进至 ${STATUS_LABEL[toStatus] ?? toStatus}（影响 ${result.affectedShipmentCount} 个运单）`);
      await loadList();
      await loadDetail(selectedId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "状态更新失败");
    }
  };

  const handleSeal = async () => {
    if (!selectedId) return;
    try {
      await sealLoadingManifest(selectedId);
      setToast("封柜成功");
      await loadList();
      await loadDetail(selectedId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "封柜失败");
    }
  };

  const handleDelete = async () => {
    if (!selectedId || !detail) return;
    if (!confirm(`确定删除柜子 ${detail.manifestNo}？\n\n此操作不可撤销。`)) return;
    try {
      await deleteContainer(selectedId);
      setToast("柜子已删除");
      setSelectedId("");
      setDetail(null);
      await loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    }
  };

  const handleBulkAdd = async () => {
    const entries = Object.entries(selectedShipments);
    if (!selectedId || entries.length === 0) return;
    setAdding(true);
    let success = 0;
    const errors: string[] = [];
    for (const [trackingNo, pieceCount] of entries) {
      if (!trackingNo) { errors.push("空运单号"); continue; }
      try {
        await addShipmentToManifest(selectedId, trackingNo, pieceCount > 0 ? pieceCount : undefined);
        success++;
      } catch (e: any) {
        errors.push(`${trackingNo}: ${e.message ?? "失败"}`);
      }
    }
    setToast(`成功添加 ${success} 个运单到装柜${errors.length > 0 ? `，失败 ${errors.length} 个：${errors.join("；")}` : ""}`);
    setSelectedShipments({});
    await loadDetail(selectedId);
    setAdding(false);
  };

  const handleRemoveShipment = async (itemId: string) => {
    if (!selectedId) return;
    try {
      await removeShipmentFromManifest(selectedId, itemId);
      setToast("运单已从装柜删除");
      await loadDetail(selectedId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    }
  };



  return (
    <RoleShell allowedRole={["staff", "admin"]} title="装柜管理">
      <h1 style={{ fontSize: 22, fontWeight: 700, color: "#0f172a", margin: "0 0 16px" }}>装柜管理</h1>

      {/* 搜索 & 新建 */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索柜号…" style={{ ...inputStyle, minWidth: 200 }} />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={inputStyle}>
          <option value="ALL">全部状态</option>
          <option value="LOADING">装柜中</option>
          <option value="SEALED">已封柜</option>
          <option value="IN_TRANSIT">运输中</option>
          <option value="DELAY_DEPARTED">延迟开船</option>
          <option value="ARRIVED">已到港</option>
          <option value="CUSTOMS">清关中</option>
          <option value="CUSTOMS_CLEARED">清关已放行</option>
          <option value="IN_WAREHOUSE_TH">已到仓</option>
        </select>
        <button onClick={() => void loadList()} style={{ border: "none", borderRadius: 6, padding: "8px 16px", background: "#2563eb", color: "#fff", fontWeight: 500, fontSize: 13, cursor: "pointer" }}>搜索</button>
        <button onClick={() => setShowCreate(!showCreate)} style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 16px", background: "#fff", fontSize: 13, cursor: "pointer", color: "#000000" }}>
          {showCreate ? "收起" : "+ 新建装柜"}
        </button>
      </div>

      {/* 新建表单 */}
      {showCreate && (
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 16, background: "#f8fafc", marginBottom: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input value={createForm.containerNo} onChange={(e) => setCreateForm((v) => ({ ...v, containerNo: e.target.value }))} placeholder="柜号" style={{ ...inputStyle, minWidth: 150 }} />
          <input value={createForm.voyage} onChange={(e) => setCreateForm((v) => ({ ...v, voyage: e.target.value }))} placeholder="船次" style={{ ...inputStyle, minWidth: 130 }} />
          <input value={createForm.vesselName} onChange={(e) => setCreateForm((v) => ({ ...v, vesselName: e.target.value }))} placeholder="船名" style={{ ...inputStyle, minWidth: 150 }} />
          <select value={createForm.warehouse} onChange={(e) => setCreateForm((v) => ({ ...v, warehouse: e.target.value }))} style={inputStyle}>
            <option value="wh_yiwu_01">义乌仓</option>
            <option value="wh_guangzhou_01">广州仓</option>
            <option value="wh_dongguan_01">东莞仓</option>
            <option value="wh_shenzhen_01">深圳仓</option>
          </select>
          <button disabled={creating} onClick={handleCreate} style={{ border: "none", borderRadius: 6, padding: "8px 16px", background: "#2563eb", color: "#fff", fontWeight: 500, fontSize: 13, cursor: creating ? "not-allowed" : "pointer" }}>
            {creating ? "创建中…" : "创建"}
          </button>
        </div>
      )}

      {error && <p style={{ color: "#b91c1c", fontSize: 13, marginBottom: 8 }}>{error}</p>}

      <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 16, alignItems: "start" }}>
        {/* 左侧柜列表 */}
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, overflow: "hidden", background: "#fff" }}>
          {loading ? <p style={{ padding: 20, color: "#000000", fontSize: 13 }}>加载中…</p> : list.length === 0 ? (
            <p style={{ padding: 20, color: "#000000", fontSize: 13, textAlign: "center" }}>暂无装柜任务，请先创建装柜</p>
          ) : (
            list.map((item) => (
              <div key={item.id} onClick={() => setSelectedId(item.id)} style={{ padding: "12px 16px", cursor: "pointer", borderBottom: "1px solid #f1f5f9", background: selectedId === item.id ? "#eff6ff" : "transparent" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: 600, fontSize: 14, color: "#0f172a" }}>{item.manifestNo}</span>
                  <span style={{ fontSize: 11, fontWeight: 500, color: STATUS_COLOR[item.status] ?? "#000000" }}>{STATUS_LABEL[item.status] ?? item.status}</span>
                </div>
                <div style={{ fontSize: 12, color: "#000000", marginTop: 4 }}>
                  {WAREHOUSE_ZH[item.warehouse] ?? item.warehouse} · {item.totalBills} 票 · {item.createdAt.slice(0, 10)}
                </div>
              </div>
            ))
          )}
        </div>

        {/* 右侧详情 + 运单列表 */}
        <div>
          {/* 柜子详情 */}
          <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 16, background: "#fff", marginBottom: 12 }}>
            {loadingDetail ? <p style={{ color: "#000000", fontSize: 13 }}>加载中…</p> : !detail ? (
              <p style={{ color: "#000000", fontSize: 13 }}>选择左侧装柜任务查看详情</p>
            ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <div>
                    <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#0f172a" }}>{detail.manifestNo}</h2>
                    <div style={{ fontSize: 13, color: "#000000", marginTop: 4 }}>
                      仓库: {WAREHOUSE_ZH[detail.warehouse] ?? detail.warehouse} · 状态: {STATUS_LABEL[detail.status] ?? detail.status}
                      {detail.carrierInfo ? ` · 船次/船名: ${detail.carrierInfo}` : ""}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <input value={statusRemark} onChange={(e) => setStatusRemark(e.target.value)} placeholder="备注（选填）" style={{ ...inputStyle, minWidth: 200, flex: 1 }} />
                    <input type="date" value={statusDate} onChange={(e) => setStatusDate(e.target.value)} style={{ ...inputStyle, maxWidth: 150 }} title="选择日期（不选则为当天）" />
                    {(() => {
                      const currentIdx = STATUS_FLOW.indexOf(detail.status as typeof STATUS_FLOW[number]);
                      if (currentIdx < 0 || currentIdx >= STATUS_FLOW.length - 1) return null;
                      const options = STATUS_FLOW.slice(currentIdx + 1);
                      return (
                        <>
                          <select value={targetStatus} onChange={(e) => setTargetStatus(e.target.value)} style={inputStyle}>
                            <option value="">选择目标状态</option>
                            {options.map((s) => (
                              <option key={s} value={s}>{STATUS_LABEL[s] ?? s}</option>
                            ))}
                          </select>
                          <button
                            disabled={!targetStatus}
                            onClick={() => { if (targetStatus) handlePushStatus(targetStatus); setTargetStatus(""); }}
                            style={{ border: "none", borderRadius: 6, padding: "8px 16px", background: targetStatus ? "#2563eb" : "#94a3b8", color: "#fff", fontWeight: 500, fontSize: 13, cursor: targetStatus ? "pointer" : "not-allowed", whiteSpace: "nowrap" }}
                          >
                            确认推进
                          </button>
                        </>
                      );
                    })()}
                    {detail.status === "LOADING" && (
                      <button onClick={handleDelete} style={{ border: "1px solid #fecaca", borderRadius: 6, padding: "8px 16px", background: "#fef2f2", color: "#dc2626", fontWeight: 500, fontSize: 13, cursor: "pointer" }}>删除柜子</button>
                    )}
                  </div>
                </div>

                {/* 已装运单列表 */}
                <div style={{ fontSize: 13, fontWeight: 500, color: "#000000", marginBottom: 8 }}>已装运单（{detail.bills.length}）</div>
                {detail.bills.length === 0 ? (
                  <p style={{ color: "#000000", fontSize: 13, marginBottom: 12 }}>暂无运单，从下方选择运单添加到本柜</p>
                ) : (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 0.6fr 0.7fr 0.5fr 0.4fr auto", gap: 4, padding: "4px 10px", fontSize: 11, color: "#6b7280", fontWeight: 600, borderBottom: "1px solid #e5e7eb" }}>
                      <span>运单号 / 父运单</span>
                      <span>唛头</span>
                      <span>产品/件数</span>
                      <span>运输</span>
                      <span>状态</span>
                      <span>操作</span>
                    </div>
                    {detail.bills.map((b) => (
                      <div key={b.id} style={{ display: "grid", gridTemplateColumns: "1fr 0.6fr 0.7fr 0.5fr 0.4fr auto", gap: 4, padding: "6px 10px", borderBottom: "1px solid #f1f5f9", alignItems: "center", background: "#fff", fontSize: 12 }}>
                        <div>
                          <span style={{ fontWeight: 600, fontFamily: "monospace", color: "#1e3a8a" }}>{b.trackingNo ?? "—"}</span>
                          {b.parentTrackingNo ? <span style={{ display: "block", fontSize: 10, color: "#9333ea" }}>← {b.parentTrackingNo}</span> : null}
                          {b.itemName ? <span style={{ display: "block", color: "#374151", marginTop: 1 }}>{b.itemName}</span> : null}
                        </div>
                        <span style={{ color: "#6b21a8", fontWeight: 500 }}>{b.clientId ?? "—"}</span>
                        <span style={{ color: "#374151" }}>{b.loadedPieces}件{b.packageCount != null ? ` / 共${b.packageCount}件` : ""}</span>
                        <span style={{ color: "#374151" }}>{b.transportMode === "sea" ? "海运" : b.transportMode === "land" ? "陆运" : "—"}</span>
                        <span style={{ color: STATUS_COLOR[b.currentStatus ?? ""] ?? "#000000", fontWeight: 500 }}>{SHIPMENT_STATUS_ZH[b.currentStatus ?? ""] ?? b.currentStatus ?? "—"}</span>
                        <div style={{ display: "flex", gap: 4 }}>
                          <button onClick={() => handleRemoveShipment(b.id)} style={{ border: "1px solid #fca5a5", borderRadius: 4, padding: "2px 6px", fontSize: 11, background: "#fff", color: "#dc2626", cursor: "pointer" }}>卸柜</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* 运单列表（可添加到装柜） */}
          {detail && (
            <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 16, background: "#fff" }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: "#0f172a", marginBottom: 8 }}>选择运单添加到本柜</div>
              <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
                <input value={shipSearch.trackingNo} onChange={(e) => setShipSearch((v) => ({ ...v, trackingNo: e.target.value }))} placeholder="运单号" style={{ ...inputStyle, flex: 1, minWidth: 120 }} />
                <input value={shipSearch.clientId} onChange={(e) => setShipSearch((v) => ({ ...v, clientId: e.target.value }))} placeholder="唛头" style={{ ...inputStyle, flex: 1, minWidth: 120 }} />
                <select value={shipSearch.transportMode} onChange={(e) => setShipSearch((v) => ({ ...v, transportMode: e.target.value }))} style={inputStyle}>
                  <option value="">全部运输方式</option>
                  <option value="sea">海运</option>
                  <option value="land">陆运</option>
                </select>
                <button disabled={adding || Object.keys(selectedShipments).length === 0} onClick={handleBulkAdd} style={{ border: "none", borderRadius: 6, padding: "6px 14px", fontSize: 12, background: Object.keys(selectedShipments).length === 0 ? "#000000" : "#2563eb", color: "#fff", cursor: Object.keys(selectedShipments).length === 0 ? "not-allowed" : "pointer", fontWeight: 600 }}>
                  {adding ? "添加中…" : `添加选中（${Object.keys(selectedShipments).length}）`}
                </button>
              </div>
              {/* 选择件数弹窗 */}
              {bulkPieceDialog && (
                <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.3)" }} onClick={() => { setBulkPieceDialog(null); setBulkPieceCount(""); }}>
                  <div style={{ background: "#fff", borderRadius: 10, padding: 20, boxShadow: "0 8px 40px rgba(0,0,0,0.2)", minWidth: 300 }} onClick={e => e.stopPropagation()}>
                    <h4 style={{ margin: "0 0 10px", fontSize: 15 }}>装柜件数 — {bulkPieceDialog}</h4>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <input type="number" value={bulkPieceCount} onChange={e => setBulkPieceCount(e.target.value)} style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 12px", fontSize: 14, width: "100%" }} min="1" autoFocus />
                    </div>
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
                      <button onClick={() => { setBulkPieceDialog(null); setBulkPieceCount(""); }} style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 14px", background: "#fff", cursor: "pointer", fontSize: 13 }}>取消</button>
                      <button onClick={() => {
                        const n = parseInt(bulkPieceCount) || 0;
                        if (n > 0 && bulkPieceDialog) {
                          setSelectedShipments(p => ({ ...p, [bulkPieceDialog]: n }));
                        }
                        setBulkPieceDialog(null); setBulkPieceCount("");
                      }} style={{ border: "none", borderRadius: 6, padding: "6px 14px", background: "#2563eb", color: "#fff", cursor: "pointer", fontSize: 13 }}>确认</button>
                    </div>
                  </div>
                </div>
              )}

              <div style={{ maxHeight: 300, overflow: "auto", border: "1px solid #f1f5f9", borderRadius: 6 }}>
                {filteredShipments.length === 0 ? (
                  <p style={{ padding: 16, color: "#000000", fontSize: 13, textAlign: "center" }}>暂无匹配运单</p>
                ) : filteredShipments.map((s) => {
                    const alreadyIn = existingShipmentIds.has(s.id);
                    const loadedContainer = loadedShipments[s.id];
                    const isSelected = s.trackingNo in selectedShipments;
                    const totalPkg = s.packageCount ?? 0;
                    return (
                      <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderBottom: "1px solid #f1f5f9", opacity: (alreadyIn || loadedContainer) ? 0.5 : 1, background: isSelected ? "#eff6ff" : "transparent" }}>
                        <input type="checkbox" checked={isSelected || alreadyIn || !!loadedContainer} disabled={alreadyIn || !!loadedContainer} onChange={() => {
                          if (alreadyIn || loadedContainer) return;
                          if (isSelected) {
                            const n = { ...selectedShipments };
                            delete n[s.trackingNo];
                            setSelectedShipments(n);
                          } else {
                            setBulkPieceDialog(s.trackingNo);
                            setBulkPieceCount(String(totalPkg));
                          }
                        }} />
                        <span style={{ fontSize: 12, fontWeight: 500, color: "#1e3a8a", fontFamily: "monospace", minWidth: 150 }}>{s.trackingNo}</span>
                        <span style={{ fontSize: 12, color: "#6b21a8", minWidth: 80 }}>{s.clientId ?? "—"}</span>
                        <span style={{ fontSize: 12, color: "#000000", minWidth: 60 }}>{totalPkg}件</span>
                        {isSelected && <span style={{ fontSize: 11, color: "#2563eb" }}>装{selectedShipments[s.trackingNo]}件</span>}
                        <span style={{ fontSize: 12, color: "#000000", minWidth: 50 }}>{s.transportMode === "sea" ? "海运" : "陆运"}</span>
                        <span style={{ fontSize: 12, color: loadedContainer ? "#d97706" : alreadyIn ? "#16a34a" : "#000000" }}>{loadedContainer ? `已装柜(${loadedContainer})` : alreadyIn ? "已在本柜" : SHIPMENT_STATUS_ZH[s.currentStatus ?? ""] ?? s.currentStatus ?? ""}</span>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}
        </div>
      </div>

      
      <Toast open={toast.length > 0} message={toast} />
    </RoleShell>
  );
}