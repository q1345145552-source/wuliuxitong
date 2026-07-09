"use client";

import { useMemo, useState } from "react";
import * as XLSX from "xlsx";
import RoleShell from "../../../modules/layout/RoleShell";
import { createClientPrealert, type ClientPrealertPayload } from "../../../services/business-api";

interface ImportRow {
  warehouseId: string;
  itemName: string;
  packageCount: number;
  packageUnit: "bag" | "box";
  weightKg?: number;
  volumeM3?: number;
  shipDate?: string;
  domesticTrackingNo?: string;
  transportMode: "sea" | "land";
}

function downloadTemplate(): void {
  const worksheet = XLSX.utils.json_to_sheet([
    {
      "仓库 *": "",
      "品名 *": "",
      "箱数 *": "",
      "包装类型（箱/袋，默认箱）": "",
      "长cm（数字）": "",
      "宽cm（数字）": "",
      "高cm（数字）": "",
      "单箱重量kg（数字）": "",
      "发货日期（YYYY-MM-DD）": "",
      "国内单号（选填）": "",
      "运输方式 *（海运/陆运）": "",
    },
  ]);
  worksheet["!cols"] = [
    { wch: 14 },  // 仓库
    { wch: 12 },  // 品名
    { wch: 10 },  // 箱数
    { wch: 32 },  // 包装类型
    { wch: 12 },  // 长cm
    { wch: 12 },  // 宽cm
    { wch: 12 },  // 高cm
    { wch: 22 },  // 单箱重量kg
    { wch: 26 },  // 发货日期
    { wch: 20 },  // 国内单号
    { wch: 12 },  // 运输方式
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "客户端批量下单模板");
  XLSX.writeFile(workbook, "客户端批量下单模板.xlsx");
}

function normalizeRows(rows: Record<string, unknown>[]): ImportRow[] {
  function findCol(row: Record<string, unknown>, keywords: string[]): string {
    const keys = Object.keys(row);
    for (const kw of keywords) {
      const found = keys.find((k) => k.includes(kw));
      if (found) return String(row[found] ?? "").trim();
    }
    return "";
  }
  function cleanNum(v: unknown): number | undefined {
    if (v === undefined || v === "") return undefined;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    const cleaned = String(v).replace(/[^0-9.\-]/g, "");
    if (!cleaned) return undefined;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : undefined;
  }
  function findNum(row: Record<string, unknown>, keywords: string[]): number | undefined {
    const keys = Object.keys(row);
    for (const kw of keywords) {
      const found = keys.find((k) => k.includes(kw));
      if (found) return cleanNum(row[found]);
    }
    return undefined;
  }
  return rows
    .map((row) => {
      const transportModeRaw = findCol(row, ["运输方式"]).toLowerCase().replace("海运", "sea").replace("陆运", "land");
      const packageUnitRaw = findCol(row, ["包装类型"]).toLowerCase().replace("箱", "box").replace("袋", "bag");
      const warehouseNameMap: Record<string, string> = {
        "义乌仓": "wh_yiwu_01", "广州仓": "wh_guangzhou_01", "东莞仓": "wh_dongguan_01", "深圳仓": "wh_shenzhen_01",
      };
      const rawWarehouse = findCol(row, ["仓库"]);
      const warehouseId = warehouseNameMap[rawWarehouse] || rawWarehouse;
      const packageCount = findNum(row, ["箱数"]) ?? 0;
      const perBoxWeight = findNum(row, ["单箱重量"]);
      const weightKg = perBoxWeight != null && packageCount > 0 ? perBoxWeight * packageCount : perBoxWeight;
      const lengthCm = findNum(row, ["长cm", "长"]);
      const widthCm = findNum(row, ["宽cm", "宽"]);
      const heightCm = findNum(row, ["高cm", "高"]);
      let volumeM3: number | undefined;
      if (lengthCm && widthCm && heightCm && lengthCm > 0 && widthCm > 0 && heightCm > 0) {
        volumeM3 = (lengthCm * widthCm * heightCm) / 1_000_000;
      }
      let shipDate = findCol(row, ["发货日期"]);
      if (/^\d{5}$/.test(shipDate)) {
        const d = new Date((Number(shipDate) - 25569) * 86400000);
        shipDate = d.toISOString().slice(0, 10);
      }
      return {
        warehouseId,
        itemName: findCol(row, ["品名"]),
        packageCount,
        packageUnit: (packageUnitRaw.includes("bag") ? "bag" : "box") as "bag" | "box",
        weightKg,
        volumeM3,
        shipDate: shipDate || undefined,
        domesticTrackingNo: findCol(row, ["国内单号"]) || undefined,
        transportMode: (transportModeRaw.includes("land") ? "land" : "sea") as "sea" | "land",
      };
    })
    .filter((item) => item.warehouseId && item.itemName && Number.isFinite(item.packageCount) && item.packageCount > 0);
}

const th: React.CSSProperties = { textAlign: "left", padding: "6px 4px", whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "6px 4px" };

export default function ClientImportsPage() {
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [current, setCurrent] = useState(0);
  const [successCount, setSuccessCount] = useState(0);
  const [failCount, setFailCount] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const [message, setMessage] = useState("");

  const validCount = useMemo(() => rows.length, [rows]);

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });
      const normalized = normalizeRows(raw);
      setRows(normalized);
      setCurrent(0);
      setSuccessCount(0);
      setFailCount(0);
      setErrors([]);
      setDone(false);
      setMessage(`已读取 ${normalized.length} 条有效数据`);
    } catch {
      setMessage("文件解析失败，请确认使用提供的模板格式");
    }
    event.target.value = "";
  };

  const handleSubmit = async () => {
    setLoading(true);
    setCurrent(0);
    setSuccessCount(0);
    setFailCount(0);
    setErrors([]);
    setDone(false);
    setMessage("");

    let success = 0;
    const errs: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      setCurrent(i + 1);
      const row = rows[i];
      try {
        const payload: ClientPrealertPayload = {
          warehouseId: row.warehouseId,
          itemName: row.itemName,
          packageCount: row.packageCount,
          packageUnit: row.packageUnit,
          weightKg: row.weightKg,
          volumeM3: row.volumeM3,
          shipDate: row.shipDate,
          domesticTrackingNo: row.domesticTrackingNo,
          transportMode: row.transportMode,

        };
        await createClientPrealert(payload);
        success++;
        setSuccessCount(success);
      } catch (error) {
        const text = error instanceof Error ? error.message : "提交失败";
        errs.push(`第${i + 1}行(${row.itemName}): ${text}`);
        setFailCount(errs.length);
        setErrors([...errs]);
      }
    }

    setErrors(errs);
    setDone(true);
    setLoading(false);
  };

  return (
    <RoleShell allowedRole="client" title="客户端批量下单">
      <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#fff" }}>
        <h2 style={{ marginTop: 0 }}>智能下单系统（批量导入）</h2>
        <p style={{ color: "#000000", marginTop: 0 }}>
          支持 Excel 批量导入预报单。建议先下载模板，按字段填好后上传。
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
          <button
            type="button"
            onClick={downloadTemplate}
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 12px", background: "#fff", color: "#000000", cursor: "pointer" }}
          >
            下载模板
          </button>
          <label
            style={{
              border: "1px solid #2563eb",
              borderRadius: 8,
              padding: "8px 12px",
              background: "#eff6ff",
              color: "#1d4ed8",
              cursor: "pointer",
            }}
          >
            上传 Excel
            <input type="file" accept=".xlsx,.xls" style={{ display: "none" }} onChange={handleUpload} />
          </label>
          <button
            type="button"
            disabled={loading || rows.length === 0}
            onClick={handleSubmit}
            style={{
              border: "none",
              borderRadius: 8,
              padding: "8px 12px",
              background: loading || rows.length === 0 ? "#9ca3af" : "#2563eb",
              color: "#fff",
              cursor: loading || rows.length === 0 ? "not-allowed" : "pointer",
            }}
          >
            {loading ? `提交中 ${current}/${rows.length}...` : "一键提交批量下单"}
          </button>
        </div>

        {/* 进度条 */}
        {loading && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
              <span>正在提交第 {current}/{rows.length} 条…</span>
              <span>
                <span style={{ color: "#16a34a" }}>{successCount}</span>
                {" / "}
                <span style={{ color: failCount > 0 ? "#dc2626" : "#6b7280" }}>{failCount}</span>
              </span>
            </div>
            <div style={{ height: 8, background: "#e5e7eb", borderRadius: 4, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${(current / rows.length) * 100}%`, background: "#2563eb", borderRadius: 4, transition: "width 0.3s" }} />
            </div>
          </div>
        )}

        {/* 完成汇总 */}
        {done && (
          <div style={{ marginBottom: 12, padding: 12, borderRadius: 8, background: failCount > 0 ? "#fef2f2" : "#f0fdf4", border: `1px solid ${failCount > 0 ? "#fecaca" : "#bbf7d0"}` }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
              批量下单完成：成功 {successCount} 条 / 失败 {failCount} 条
            </div>
            {errors.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: "#b91c1c" }}>
                {errors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            )}
          </div>
        )}

        {/* 单条消息 */}
        {message && !done && <p style={{ marginBottom: 10, color: "#166534", fontSize: 13 }}>{message}</p>}

        {/* 预览表格 */}
        {rows.length > 0 && (
          <div style={{ marginBottom: 10, fontSize: 13, color: "#000000" }}>当前有效行：{validCount}</div>
        )}
        {rows.length > 0 ? (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #e2e8f0" }}>
                  <th style={th}>#</th>
                  <th style={th}>仓库ID</th>
                  <th style={th}>品名</th>
                  <th style={th}>箱数</th>
                  <th style={th}>运输</th>

                </tr>
              </thead>
              <tbody>
                {rows.map((row, idx) => (
                  <tr key={`${row.itemName}-${idx}`} style={{ borderBottom: "1px solid #f1f5f9" }}>
                    <td style={td}>{idx + 1}</td>
                    <td style={td}>{row.warehouseId}</td>
                    <td style={td}>{row.itemName}</td>
                    <td style={td}>{row.packageCount} {row.packageUnit}</td>
                    <td style={td}>{row.transportMode === "sea" ? "海运" : "陆运"}</td>

                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </RoleShell>
  );
}
