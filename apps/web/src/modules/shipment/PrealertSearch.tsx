"use client";

interface PrealertSearchProps {
  /** 预报警搜索值 */
  value: {
    keyword: string;      // 单号（预报单号/订单号）搜索
    warehouseId: string;  // 仓库筛选
    itemName: string;     // 品名
    domesticTrackingNo: string; // 国内单号
  };
  onChange: (key: string, val: string) => void;
  onSearch: () => void;
  warehouseOptions: { id: string; label: string }[];
  inputStyle: Record<string, string | number>;
}

const compactStyle: Record<string, string | number> = {
  border: "1px solid #d1d5db",
  borderRadius: 6,
  padding: "5px 8px",
  fontSize: 12,
  width: "140px",
};

export default function PrealertSearch({
  value,
  onChange,
  onSearch,
  warehouseOptions,
}: PrealertSearchProps) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <input
          value={value.keyword}
          onChange={(e) => onChange("keyword", e.target.value)}
          placeholder="单号"
          style={compactStyle}
        />
        <select
          value={value.warehouseId}
          onChange={(e) => onChange("warehouseId", e.target.value)}
          style={compactStyle}
        >
          <option value="">全部仓库</option>
          {warehouseOptions.map((w) => (
            <option key={w.id} value={w.id}>
              {w.label}
            </option>
          ))}
        </select>
        <input
          value={value.itemName}
          onChange={(e) => onChange("itemName", e.target.value)}
          placeholder="品名"
          style={compactStyle}
        />
        <input
          value={value.domesticTrackingNo}
          onChange={(e) => onChange("domesticTrackingNo", e.target.value)}
          placeholder="国内单号"
          style={compactStyle}
        />
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button
            type="button"
            onClick={onSearch}
            style={{
              border: "none",
              borderRadius: 6,
              padding: "6px 12px",
              background: "#2563eb",
              color: "#fff",
              fontWeight: 500,
              fontSize: 12,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            搜索
          </button>
        </div>
      </div>
    </div>
  );
}
