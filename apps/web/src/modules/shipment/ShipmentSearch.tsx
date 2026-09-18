"use client";

import { useId, useState, type KeyboardEvent, type ReactNode } from "react";

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
  onReset?: () => void;
  variant?: "default" | "workbench";
  warehouseOptions: { id: string; label: string }[];
  logisticsStatusOptions: readonly string[];
  inputStyle: Record<string, string | number>;
}

type SearchField = keyof ShipmentSearchProps["value"];

const FILTER_LABELS: Record<SearchField, string> = {
  trackingNo: "运单号",
  domesticTrackingNo: "国内单号",
  // 这一格按唛头和客户名字都能搜（admin/staff 页面里拼的是「名字 + 唛头」）
  clientName: "唛头 / 客户名",
  warehouseId: "仓库",
  batchNo: "批次号",
  itemName: "品名",
  packageCount: "包裹数量",
  productQuantity: "产品数量",
  weightKg: "重量",
  volumeM3: "体积",
  arrivedAtFrom: "到仓开始日期",
  arrivedAtTo: "到仓结束日期",
  logisticsStatus: "物流状态",
  containerNo: "柜号",
  transportMode: "运输方式",
  receiverAddress: "收货地址",
  shipDateFrom: "发货开始日期",
  shipDateTo: "发货结束日期",
  receivableAmount: "加收金额",
  statusRaw: "状态关键词",
};

const BASIC_FILTER_FIELDS = new Set<SearchField>(["trackingNo", "domesticTrackingNo", "clientName", "warehouseId"]);

export default function ShipmentSearch({
  value,
  onChange,
  onSearch,
  onReset,
  variant = "default",
  warehouseOptions,
  logisticsStatusOptions,
  inputStyle,
}: ShipmentSearchProps) {
  const [collapsed, setCollapsed] = useState(true);
  const searchId = useId();
  const workbench = variant === "workbench";
  const advancedId = `${searchId}-advanced`;
  const controlStyle = workbench ? { ...inputStyle, marginBottom: 0, minWidth: 0, width: "100%" } : inputStyle;
  // The staff list already filters on every change. This is a view of the
  // supplied values, not a second draft/applied-filter state or a new query.
  const activeFilters = workbench
    ? (Object.keys(FILTER_LABELS) as SearchField[]).filter((key) => value[key].trim() !== "")
    : [];
  const advancedCount = activeFilters.filter((key) => !BASIC_FILTER_FIELDS.has(key)).length;

  const fieldId = (key: SearchField) => workbench ? `${searchId}-${key}` : undefined;
  const field = (key: SearchField, control: ReactNode) => workbench ? (
    <label className="shipment-search-field" htmlFor={fieldId(key)}>
      <span className="shipment-search-label">{FILTER_LABELS[key]}</span>
      {control}
    </label>
  ) : control;
  const textField = (key: SearchField) => field(key, (
    <input
      id={fieldId(key)}
      value={value[key]}
      onChange={(e) => onChange(key, e.target.value)}
      placeholder={FILTER_LABELS[key]}
      style={controlStyle}
    />
  ));
  const dateRange = (label: string, from: SearchField, to: SearchField) => (
    <div
      className={workbench ? "shipment-search-date-range" : undefined}
      role={workbench ? "group" : undefined}
      aria-labelledby={workbench ? `${searchId}-${from}-label` : undefined}
      style={workbench ? undefined : { display: "flex", flexDirection: "column", gap: 2, gridColumn: "span 2" }}
    >
      <span id={workbench ? `${searchId}-${from}-label` : undefined} className={workbench ? "shipment-search-label" : undefined} style={workbench ? undefined : { fontSize: 11, color: "var(--t-strong)" }}>{label}</span>
      <div className={workbench ? "shipment-search-date-pair" : undefined} style={workbench ? undefined : { display: "flex", gap: 4, alignItems: "center" }}>
        {field(from, <input id={fieldId(from)} type="date" value={value[from]} onChange={(e) => onChange(from, e.target.value)} style={{ ...controlStyle, flex: 1 }} />)}
        {!workbench && <span style={{ fontSize: 11 }}>~</span>}
        {field(to, <input id={fieldId(to)} type="date" value={value[to]} onChange={(e) => onChange(to, e.target.value)} style={{ ...controlStyle, flex: 1 }} />)}
      </div>
    </div>
  );
  const filterDisplayValue = (key: SearchField) => {
    const current = value[key].trim();
    if (key === "warehouseId") return warehouseOptions.find((option) => option.id === current)?.label ?? current;
    if (key === "transportMode") return current === "sea" ? "海运" : current === "land" ? "陆运" : current;
    return current;
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Do not turn IME confirmation, select navigation, or a button's native
    // Enter click into a second search. Safari IME can report keyCode 229.
    if (event.key !== "Enter" || event.defaultPrevented || event.repeat || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || (event.target as HTMLElement).tagName !== "INPUT") return;
    event.preventDefault();
    onSearch();
  };

  return (
    <div
      className={workbench ? "shipment-search" : undefined}
      role={workbench ? "search" : undefined}
      aria-label={workbench ? "运单筛选" : undefined}
      onKeyDown={workbench ? handleKeyDown : undefined}
      style={workbench ? undefined : { marginBottom: 10 }}
    >
      <div className={workbench ? "shipment-search-basic" : undefined} style={workbench ? undefined : { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8, marginBottom: 10 }}>
        {textField("trackingNo")}
        {textField("domesticTrackingNo")}
        {textField("clientName")}
        {field("warehouseId", (
          <select id={fieldId("warehouseId")} value={value.warehouseId} onChange={(e) => onChange("warehouseId", e.target.value)} style={controlStyle}>
            <option value="">全部仓库</option>
            {warehouseOptions.map((w) => (<option key={w.id} value={w.id}>{w.label}</option>))}
          </select>
        ))}
        <div className={workbench ? "shipment-search-actions" : undefined} style={workbench ? undefined : { display: "flex", gap: 6, alignItems: "center" }}>
          <button type="button" className={workbench ? "ship-search-btn shipment-search-submit" : "ship-search-btn"} onClick={onSearch} style={workbench ? undefined : { border: "none", borderRadius: 6, padding: "8px 16px", background: "var(--c-blue)", color: "var(--white)", fontWeight: 500, fontSize: 13, cursor: "pointer" }}>搜索</button>
          {workbench && onReset && (
            <button type="button" className="shipment-search-reset" onClick={onReset} disabled={activeFilters.length === 0}>清空条件</button>
          )}
          <button
            type="button"
            className={workbench ? "shipment-search-toggle" : undefined}
            onClick={() => setCollapsed((v) => !v)}
            aria-expanded={workbench ? !collapsed : undefined}
            aria-controls={workbench ? advancedId : undefined}
            style={workbench ? undefined : { border: "1px solid var(--l-strong)", borderRadius: 4, padding: "6px 10px", fontSize: 12, background: "var(--white)", cursor: "pointer", color: "var(--t-strong)" }}
          >
            {collapsed ? "展开更多条件" : "收起条件"}{workbench && advancedCount > 0 ? `（${advancedCount} 项已选）` : ""}
          </button>
        </div>
      </div>
      {(!collapsed || workbench) && (
        <div
          id={workbench ? advancedId : undefined}
          className={workbench ? "shipment-search-advanced" : undefined}
          role={workbench ? "group" : undefined}
          aria-label={workbench ? "更多筛选条件" : undefined}
          hidden={workbench ? collapsed : undefined}
          style={workbench ? (collapsed ? { display: "none" } : undefined) : { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8, marginBottom: 10, padding: 10, border: "1px dashed var(--l-soft)", borderRadius: 8 }}
        >
          {textField("batchNo")}
          {textField("itemName")}
          {textField("packageCount")}
          {textField("productQuantity")}
          {dateRange("到仓日期", "arrivedAtFrom", "arrivedAtTo")}
          {field("logisticsStatus", (
            <select id={fieldId("logisticsStatus")} value={value.logisticsStatus} onChange={(e) => onChange("logisticsStatus", e.target.value)} style={controlStyle}>
              <option value="">全部状态</option>
              {logisticsStatusOptions.map((s) => (<option key={s} value={s}>{s}</option>))}
            </select>
          ))}
          {textField("containerNo")}
          {field("transportMode", (
            <select id={fieldId("transportMode")} value={value.transportMode} onChange={(e) => onChange("transportMode", e.target.value)} style={controlStyle}>
              <option value="">运输方式</option>
              <option value="sea">海运</option>
              <option value="land">陆运</option>
            </select>
          ))}
          {textField("receiverAddress")}
          {dateRange("发货日期", "shipDateFrom", "shipDateTo")}
          {textField("receivableAmount")}
        </div>
      )}
      {workbench && (
        <div className="shipment-search-summary" hidden={activeFilters.length === 0}>
          <div className="shipment-search-summary-heading">
            <span className="shipment-search-summary-count">{activeFilters.length > 0 ? `当前筛选 · ${activeFilters.length} 项` : "未设置筛选条件"}</span>
            <span className="shipment-search-hint">输入即筛选，回车定位结果</span>
          </div>
          {activeFilters.length > 0 && (
            <ul className="shipment-search-filter-list" aria-label="当前筛选条件">
              {activeFilters.map((key) => (
                <li className="shipment-search-filter" key={key}>
                  <span className="shipment-search-filter-label">{FILTER_LABELS[key]}：</span>
                  <span className="shipment-search-filter-value">{filterDisplayValue(key)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
