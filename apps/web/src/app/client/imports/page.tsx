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

/**
 * 生成批量导入模板。
 */
function downloadTemplate(): void {
  const worksheet = XLSX.utils.json_to_sheet([
    {
      warehouseId: "wh_yiwu_01",
      itemName: "手机壳",
      packageCount: 12,
      packageUnit: "box",
      weightKg: 120.5,
      volumeM3: 1.28,
      shipDate: "2026-03-24",
      domesticTrackingNo: "SF12345678",
      transportMode: "sea",
    },
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "批量下单模板");
  XLSX.writeFile(workbook, "客户端批量下单模板.xlsx");
}

/**
 * 解析并校验导入行。
 */
function normalizeRows(rows: Record<string, unknown>[]): ImportRow[] {
  return rows
    .map((row) => {
      const transportModeRaw = String(row.transportMode ?? "").trim().toLowerCase();
      const packageUnitRaw = String(row.packageUnit ?? "").trim().toLowerCase();
      const parsed: ImportRow = {
        warehouseId: String(row.warehouseId ?? "").trim(),
        itemName: String(row.itemName ?? "").trim(),
        packageCount: Number(row.packageCount ?? 0),
        packageUnit: packageUnitRaw === "bag" ? "bag" : "box",
        weightKg: row.weightKg === undefined || row.weightKg === "" ? undefined : Number(row.weightKg),
        volumeM3: row.volumeM3 === undefined || row.volumeM3 === "" ? undefined : Number(row.volumeM3),
        shipDate: String(row.shipDate ?? "").trim() || undefined,
        domesticTrackingNo: String(row.domesticTrackingNo ?? "").trim() || undefined,
        transportMode: transportModeRaw === "sea" ? "sea" : "land",
      };
      return parsed;
    })
    .filter((item) => item.warehouseId && item.itemName && Number.isFinite(item.packageCount) && item.packageCount > 0);
}

/**
 * 客户端批量导入下单页面。
 */
export default function ClientImportsPage() {
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  const validCount = useMemo(() => rows.length, [rows]);

  return (
    <RoleShell allowedRole="client" title="客户端批量下单">
      <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#fff" }}>
        <h2 style={{ marginTop: 0 }}>智能下单系统（批量导入）</h2>
        <p style={{ color: "#000000", marginTop: 0 }}>
          支持 Excel 批量导入预报单。建议先下载模板，按字段填好后上传。
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
          <button
            type="button"
            onClick={downloadTemplate}
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 12px", background: "#fff", color: "#000000" }}
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
            <input
              type="file"
              accept=".xlsx,.xls"
              style={{ display: "none" }}
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                const buffer = await file.arrayBuffer();
                const wb = XLSX.read(buffer, { type: "array" });
                const ws = wb.Sheets[wb.SheetNames[0]];
                const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });
                const normalized = normalizeRows(raw);
                setRows(normalized);
                setMessage(`已读取 ${normalized.length} 条有效数据`);
              }}
            />
          </label>
          <button
            type="button"
            disabled={loading || rows.length === 0}
            onClick={async () => {
              setLoading(true);
              setMessage("");
              try {
                for (const row of rows) {
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
                }
                setMessage(`批量下单完成：成功提交 ${rows.length} 条`);
              } catch (error) {
                const text = error instanceof Error ? error.message : "提交失败";
                setMessage(`提交失败：${text}`);
              } finally {
                setLoading(false);
              }
            }}
            style={{
              border: "none",
              borderRadius: 8,
              padding: "8px 12px",
              background: rows.length === 0 ? "#000000" : "#2563eb",
              color: "#fff",
            }}
          >
            {loading ? "提交中..." : "一键提交批量下单"}
          </button>
        </div>
        <div style={{ marginBottom: 10, color: "#000000", fontSize: 13 }}>当前有效行：{validCount}</div>
        {rows.length > 0 ? (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #e2e8f0" }}>
                  <th style={{ textAlign: "left", padding: "6px 4px" }}>仓库</th>
                  <th style={{ textAlign: "left", padding: "6px 4px" }}>品名</th>
                  <th style={{ textAlign: "left", padding: "6px 4px" }}>箱数</th>
                  <th style={{ textAlign: "left", padding: "6px 4px" }}>运输方式</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, idx) => (
                  <tr key={`${row.itemName}-${idx}`} style={{ borderBottom: "1px solid #f1f5f9" }}>
                    <td style={{ padding: "6px 4px" }}>{row.warehouseId}</td>
                    <td style={{ padding: "6px 4px" }}>{row.itemName}</td>
                    <td style={{ padding: "6px 4px" }}>
                      {row.packageCount} {row.packageUnit}
                    </td>
                    <td style={{ padding: "6px 4px" }}>{row.transportMode === "sea" ? "海运" : "陆运"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {message ? <p style={{ marginTop: 10, color: message.includes("失败") ? "#b91c1c" : "#166534" }}>{message}</p> : null}
      </section>
    </RoleShell>
  );
}
