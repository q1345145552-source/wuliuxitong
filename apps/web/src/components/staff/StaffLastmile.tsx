"use client";

import { useRef, useState } from "react";
import { apiBaseUrl, authHeaders } from "../../services/core-api";

type LmShipment = { id: string; trackingNo: string; clientId: string; itemName: string; packageCount: number; containerNo?: string };
type LmOrderItem = { id: string; deliveryNo: string; shipmentId: string; trackingNo?: string; driverName?: string; licensePlate?: string; phoneNumber?: string; deliveryDate?: string; clientId?: string; status: string; signImageBase64?: string | null };

export type StaffLastmileProps = {
  visible: boolean;
  lmShipments: LmShipment[];
  lmOrderList: LmOrderItem[];
  onToast: (msg: string) => void;
  onReloadOrders: () => void;
  onLoadShipments: () => void;
};

export default function StaffLastmile(props: StaffLastmileProps) {
  const [lmSelected, setLmSelected] = useState<Set<string>>(new Set());
  const [lmShipSearch, setLmShipSearch] = useState("");
  const [lmBatchInput, setLmBatchInput] = useState("");
  const [lmDriverName, setLmDriverName] = useState("");
  const [lmLicensePlate, setLmLicensePlate] = useState("");
  const [lmPhoneNumber, setLmPhoneNumber] = useState("");
  const [lmDeliveryDate, setLmDeliveryDate] = useState("");
  const [lmSignData, setLmSignData] = useState<{ id: string; action: string } | null>(null);
  const [previewImg, setPreviewImg] = useState<string | null>(null);
  const [lmOrderSearch, setLmOrderSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const lmSignFileRef = useRef<HTMLInputElement>(null);

  if (!props.visible) return null;

  const createLastmile = async () => {
    const ids = Array.from(lmSelected);
    if (ids.length === 0) return;
    setBusy(true);
    try {
      const r = await fetch(apiBaseUrl() + "/admin/lastmile/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ shipmentIds: ids, driverName: lmDriverName.trim(), licensePlate: lmLicensePlate.trim(), phoneNumber: lmPhoneNumber.trim(), deliveryDate: lmDeliveryDate }),
      });
      const d = await r.json();
      if (d.code !== "OK") throw new Error(d.message || "创建失败");
      props.onToast(`派送单 ${d.data.deliveryNo} 已创建（${d.data.count}个运单）`);
      setLmSelected(new Set());
      setLmDriverName("");
      setLmLicensePlate("");
      setLmPhoneNumber("");
      setLmDeliveryDate("");
      props.onReloadOrders();
    } catch (e: any) {
      props.onToast(e.message || "创建失败");
    } finally {
      setBusy(false);
    }
  };

  const handleSign = (file: File) => {
    if (!lmSignData) return;
    const rdr = new FileReader();
    rdr.onload = async () => {
      const b64 = (rdr.result as string).split(",")[1] || "";
      try {
        const res = await fetch(apiBaseUrl() + "/admin/lastmile/status", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ id: lmSignData.id, status: lmSignData.action === "sign" ? "SIGNED" : undefined, signImageBase64: b64 }),
        });
        if (!res.ok) {
          const text = await res.text();
          let msg = "失败";
          try { const d = JSON.parse(text); msg = d.message || msg; } catch {}
          throw new Error(msg);
        }
        props.onToast(lmSignData.action === "sign" ? "已签收" : "图片已上传");
        props.onReloadOrders();
      } catch (e: any) {
        props.onToast(e.message || "失败");
      } finally {
        setLmSignData(null);
      }
    };
    rdr.readAsDataURL(file);
  };

  const deleteOrder = async (id: string) => {
    if (!confirm("确定删除？")) return;
    try {
      await fetch(apiBaseUrl() + "/admin/lastmile/orders?id=" + id, { method: "DELETE", headers: authHeaders() });
      props.onToast("已删除");
      props.onReloadOrders();
    } catch (e: any) {
      props.onToast(e.message || "失败");
    }
  };

  const filteredOrders = props.lmOrderList.filter(o =>
    !lmOrderSearch || (o.deliveryNo || "").includes(lmOrderSearch) || (o.trackingNo || "").includes(lmOrderSearch) || (o.clientId || "").includes(lmOrderSearch)
  );

  const groups: Record<string, typeof filteredOrders> = {};
  for (const o of filteredOrders) {
    if (!groups[o.deliveryNo]) groups[o.deliveryNo] = [];
    groups[o.deliveryNo].push(o);
  }

  return (
    <section id="staff-lastmile" style={{ display: "block", border: "1px solid #e5e7eb", borderLeft: "4px solid #d1d5db", borderRadius: 12, padding: 16, marginBottom: 18, background: "#fcfcfd", boxShadow: "0 1px 3px rgba(15,23,42,0.06)" }}>
      <h2 style={{ marginTop: 0, fontSize: 18, color: "#111827", marginBottom: 12 }}>尾端派送</h2>

      <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 12, marginBottom: 16, background: "#f8fafc" }}>
        <h4 style={{ margin: "0 0 8px", fontSize: 14 }}>创建派送单（一车多单，逗号分隔）</h4>
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ border: "1px solid #e5e7eb", borderRadius: 6, padding: 8, background: "#fff" }}>
            <div style={{ display: "flex", gap: 4, marginBottom: 4 }}>
              {[...new Set(props.lmShipments.map(s => s.clientId).filter(Boolean))].slice(0, 10).map(m => (
                <button key={m} onClick={() => { setLmShipSearch(m); const found = new Set<string>(); props.lmShipments.filter(s => s.clientId === m).forEach(s => found.add(s.id)); const n = new Set(lmSelected); found.forEach(id => n.add(id)); setLmSelected(n); }} style={{ border: "1px solid #6b21a8", borderRadius: 4, padding: "1px 6px", fontSize: 10, background: lmShipSearch === m ? "#6b21a8" : "#fff", color: lmShipSearch === m ? "#fff" : "#6b21a8", cursor: "pointer" }}>{m}</button>
              ))}
            </div>
            <input value={lmBatchInput} onChange={e => setLmBatchInput(e.target.value)} onBlur={() => {
              const nums = lmBatchInput.split(/[,\s\n]+/).map(s => s.trim()).filter(Boolean);
              if (nums.length > 0) {
                const found = new Set<string>();
                props.lmShipments.forEach(s => { if (nums.includes(s.trackingNo)) found.add(s.id); });
                if (found.size > 0) { const n = new Set(lmSelected); found.forEach(id => n.add(id)); setLmSelected(n); }
                setLmBatchInput(nums.join(", "));
              }
            }} placeholder="粘贴运单号批量勾选..." style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "4px 8px", fontSize: 11, width: "100%", marginBottom: 4, color: "#6b21a8" }} />
            <input value={lmShipSearch} onChange={e => setLmShipSearch(e.target.value)} onFocus={props.onLoadShipments} placeholder="搜索运单号/唛头/品名..." style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 8px", fontSize: 12, width: "100%", marginBottom: 4 }} />
            <div style={{ maxHeight: 180, overflow: "auto" }}>
              {props.lmShipments
                .filter(s => !lmShipSearch || (s.trackingNo||"").includes(lmShipSearch) || (s.clientId||"").includes(lmShipSearch) || (s.itemName||"").includes(lmShipSearch))
                .slice(0, 50)
                .map(s => (
                <label key={s.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 0", fontSize: 12, cursor: "pointer" }}>
                  <input type="checkbox" checked={lmSelected.has(s.id)} onChange={() => { const n = new Set(lmSelected); n.has(s.id) ? n.delete(s.id) : n.add(s.id); setLmSelected(n); }} />
                  <span style={{ fontFamily: "monospace", color: "#1e3a8a", minWidth: 150 }}>{s.trackingNo}</span>
                  <span style={{ color: "#6b21a8", minWidth: 70, fontWeight: 600 }}>{s.clientId}</span>
                  <span style={{ color: "#374151", flex: 1 }}>{s.itemName}</span>
                  <span style={{ color: "#6b7280", minWidth: 40, textAlign: "right" }}>{s.packageCount}件</span>
                </label>
              ))}
            </div>
            <div style={{ fontSize: 11, color: "#6b7280", marginTop: 4 }}>已选 {lmSelected.size} 个运单</div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input value={lmDriverName} onChange={e => setLmDriverName(e.target.value)} placeholder="司机姓名" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 8px", fontSize: 12, flex: 1 }} />
            <input value={lmLicensePlate} onChange={e => setLmLicensePlate(e.target.value)} placeholder="车牌号" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 8px", fontSize: 12, flex: 1 }} />
            <input value={lmPhoneNumber} onChange={e => setLmPhoneNumber(e.target.value)} placeholder="电话" style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 8px", fontSize: 12, flex: 1 }} />
            <input type="date" value={lmDeliveryDate} onChange={e => setLmDeliveryDate(e.target.value)} style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 8px", fontSize: 12 }} />
          </div>
          <button disabled={busy || lmSelected.size === 0} onClick={createLastmile} style={{ border: "none", borderRadius: 6, padding: "6px 14px", background: "#2563eb", color: "#fff", cursor: "pointer", fontSize: 12, justifySelf: "start" }}>创建派送单</button>
        </div>
      </div>

      {props.lmOrderList.length === 0 ? (
        <p style={{ color: "#9ca3af", fontSize: 13 }}>暂无派送单</p>
      ) : (
        <div style={{ marginBottom: 12 }}>
          <input value={lmOrderSearch} onChange={e => setLmOrderSearch(e.target.value)} placeholder="搜索派送单号/运单号/唛头..." style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 8px", fontSize: 12, width: "100%" }} />
        </div>
      )}
      {Object.entries(groups).map(([dn, items]) => {
        const signed = items.filter(o => o.status === "SIGNED").length;
        const total = items.length;
        const done = signed === total;
        return (
          <div key={dn} style={{ marginBottom: 16, border: "1px solid #e5e7eb", borderRadius: 8, padding: 12, background: done ? "#f0fdf4" : "#fff" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                <span style={{ fontFamily: "monospace", color: "#1e3a8a" }}>{dn}</span>
                <span style={{ color: done ? "#16a34a" : "#6b7280", marginLeft: 8 }}>{signed}/{total} 签收 {done ? "派送完成" : " 派送中"}</span>
              </div>
              {!done && (
                <button onClick={async () => {
                  const ids = Array.from(lmSelected);
                  if (ids.length === 0) { props.onToast("请先勾选运单"); return; }
                  try {
                    const r = await fetch(apiBaseUrl() + "/admin/lastmile/orders", { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify({ shipmentIds: ids, deliveryNo: dn }) });
                    const d = await r.json();
                    if (d.code !== "OK") throw new Error(d.message || "追加失败");
                    props.onToast("已追加 " + d.data.count + " 个运单");
                    setLmSelected(new Set());
                    props.onReloadOrders();
                  } catch (e: any) { props.onToast(e.message || "追加失败"); }
                }} style={{ border: "1px solid #ca8a04", borderRadius: 4, padding: "2px 8px", fontSize: 11, background: "#fefce8", color: "#ca8a04", cursor: "pointer" }}>追加运单</button>
              )}
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead><tr style={{ borderBottom: "2px solid #e2e8f0", textAlign: "left" }}>
                <th style={{ padding: "4px 6px" }}>唛头</th><th style={{ padding: "4px 6px" }}>运单号</th><th style={{ padding: "4px 6px" }}>司机</th><th style={{ padding: "4px 6px" }}>车牌</th><th style={{ padding: "4px 6px" }}>电话</th><th style={{ padding: "4px 6px" }}>日期</th><th style={{ padding: "4px 6px" }}>状态</th><th style={{ padding: "4px 6px" }}>操作</th>
              </tr></thead>
              <tbody>
                {items.map(o => (
                  <tr key={o.id} style={{ borderBottom: "1px solid #e5e7eb" }}>
                    <td style={{ padding: "4px 6px", fontFamily: "monospace" }}>{o.clientId || "-"}</td>
                    <td style={{ padding: "4px 6px", fontFamily: "monospace" }}>{o.trackingNo || o.shipmentId}</td>
                    <td style={{ padding: "4px 6px" }}>{o.driverName ?? "-"}</td>
                    <td style={{ padding: "4px 6px" }}>{o.licensePlate ?? "-"}</td>
                    <td style={{ padding: "4px 6px" }}>{o.phoneNumber ?? "-"}</td>
                    <td style={{ padding: "4px 6px" }}>{o.deliveryDate || "-"}</td>
                    <td style={{ padding: "4px 6px" }}>
                      {o.status === "SIGNED" ? <span>已签收{o.signImageBase64 ? <img src={"data:image/jpeg;base64,"+o.signImageBase64} alt="签收凭证" onClick={() => setPreviewImg("data:image/jpeg;base64,"+o.signImageBase64!)} style={{ maxWidth:40, maxHeight:40, borderRadius:4, marginLeft:4, cursor:"pointer", border:"1px solid #e5e7eb" }} /> : null}</span> : " 派送中"}
                    </td>
                    <td style={{ padding: "4px 6px" }}>
                      {o.status !== "SIGNED" && (
                        <button disabled={busy} onClick={() => { setLmSignData({ id: o.id, action: "sign" }); lmSignFileRef.current?.click(); }} style={{ border: "1px solid #16a34a", borderRadius: 4, padding: "2px 6px", fontSize: 11, background: "#fff", color: "#16a34a", cursor: "pointer" }}>签收</button>
                      )}
                      <button onClick={() => deleteOrder(o.id)} style={{ border: "1px solid #fca5a5", borderRadius: 4, padding: "2px 4px", fontSize: 11, background: "#fff", color: "#dc2626", cursor: "pointer", marginLeft: 4 }}>删除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}

      <input ref={lmSignFileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e: any) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) handleSign(f); }} />

      {/* 签收图片放大预览 */}
      {previewImg && (
        <div onClick={() => setPreviewImg(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
          <img src={previewImg} alt="签收凭证" onClick={e => e.stopPropagation()} style={{ maxWidth: "90vw", maxHeight: "90vh", borderRadius: 8 }} />
        </div>
      )}
    </section>
  );
}
