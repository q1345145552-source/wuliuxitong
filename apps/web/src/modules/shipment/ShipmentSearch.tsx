"use client";

import { useState } from "react";

interface ShipmentSearchProps {
  value: {
    trackingNo: string;
    domesticTrackingNo: string;
    clientName: string;
    warehouseId: string;
    batchNo: string;
    itemName: string;
    packageCount: string;
    productQuantity: string;
    weightKg: string;
    volumeM3: string;
    arrivedAtFrom: string;
    arrivedAtTo: string;
    logisticsStatus: string;
    containerNo: string;
    transportMode: string;
    receiverAddress: string;
    shipDateFrom: string;
    shipDateTo: string;
    receivableAmount: string;
    statusRaw: string;
  };
  onChange: (key: string, val: string) => void;
  onSearch: () => void;
  warehouseOptions: { id: string; label: string }[];
  logisticsStatusOptions: readonly string[];
  inputStyle: Record<string, string | number>;
}

export default function ShipmentSearch({
  value,
  onChange,
  onSearch,
  warehouseOptions,
  logisticsStatusOptions,
  inputStyle,
}: ShipmentSearchProps) {
  const [collapsed, setCollapsed] = useState(true);

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8, marginBottom: 10 }}>
        <input value={value.trackingNo} onChange={(e) => onChange("trackingNo", e.target.value)} placeholder="运单号" style={inputStyle} />
        <input value={value.domesticTrackingNo} onChange={(e) => onChange("domesticTrackingNo", e.target.value)} placeholder="国内单号" style={inputStyle} />
        <input value={value.clientName} onChange={(e) => onChange("clientName", e.target.value)} placeholder="客户名" style={inputStyle} />
        <select value={value.warehouseId} onChange={(e) => onChange("warehouseId", e.target.value)} style={inputStyle}>
          <option value="">全部仓库</option>
          {warehouseOptions.map((w) => (<option key={w.id} value={w.id}>{w.label}</option>))}
        </select>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button type="button" onClick={onSearch} style={{ border: "none", borderRadius: 6, padding: "8px 16px", background: "#2563eb", color: "#fff", fontWeight: 500, fontSize: 13, cursor: "pointer" }}>搜索</button>
          <button type="button" onClick={() => setCollapsed((v) => !v)} style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "6px 10px", fontSize: 12, background: "#fff", cursor: "pointer", color: "#000000" }}>{collapsed ? "展开更多条件" : "收起条件"}</button>
        </div>
      </div>
      {!collapsed && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8, marginBottom: 10, padding: 10, border: "1px dashed #e5e7eb", borderRadius: 8 }}>
          <input value={value.batchNo} onChange={(e) => onChange("batchNo", e.target.value)} placeholder="批次号" style={inputStyle} />
          <input value={value.itemName} onChange={(e) => onChange("itemName", e.target.value)} placeholder="品名" style={inputStyle} />
          <input value={value.packageCount} onChange={(e) => onChange("packageCount", e.target.value)} placeholder="包裹数量" style={inputStyle} />
          <input value={value.productQuantity} onChange={(e) => onChange("productQuantity", e.target.value)} placeholder="产品数量" style={inputStyle} />
          <div style={{ display: "flex", flexDirection: "column", gap: 2, gridColumn: "span 2" }}>
            <span style={{ fontSize: 11, color: "#000000" }}>到仓日期</span>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <input type="date" value={value.arrivedAtFrom} onChange={(e) => onChange("arrivedAtFrom", e.target.value)} style={{ ...inputStyle, flex: 1 }} />
              <span style={{ fontSize: 11 }}>~</span>
              <input type="date" value={value.arrivedAtTo} onChange={(e) => onChange("arrivedAtTo", e.target.value)} style={{ ...inputStyle, flex: 1 }} />
            </div>
          </div>
          <select value={value.logisticsStatus} onChange={(e) => onChange("logisticsStatus", e.target.value)} style={inputStyle}>
            <option value="">全部状态</option>
            {logisticsStatusOptions.map((s) => (<option key={s} value={s}>{s}</option>))}
          </select>
          <input value={value.containerNo} onChange={(e) => onChange("containerNo", e.target.value)} placeholder="柜号" style={inputStyle} />
          <select value={value.transportMode} onChange={(e) => onChange("transportMode", e.target.value)} style={inputStyle}>
            <option value="">运输方式</option>
            <option value="sea">海运</option>
            <option value="land">陆运</option>
          </select>
          <input value={value.receiverAddress} onChange={(e) => onChange("receiverAddress", e.target.value)} placeholder="收货地址" style={inputStyle} />
          <div style={{ display: "flex", flexDirection: "column", gap: 2, gridColumn: "span 2" }}>
            <span style={{ fontSize: 11, color: "#000000" }}>发货日期</span>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <input type="date" value={value.shipDateFrom} onChange={(e) => onChange("shipDateFrom", e.target.value)} style={{ ...inputStyle, flex: 1 }} />
              <span style={{ fontSize: 11 }}>~</span>
              <input type="date" value={value.shipDateTo} onChange={(e) => onChange("shipDateTo", e.target.value)} style={{ ...inputStyle, flex: 1 }} />
            </div>
          </div>
          <input value={value.receivableAmount} onChange={(e) => onChange("receivableAmount", e.target.value)} placeholder="加收金额" style={inputStyle} />
        </div>
      )}
    </div>
  );
}
