"use client";

import { useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import RoleShell from "../../../modules/layout/RoleShell";
import { createRequestGate } from "../../../modules/shared/request-gate";
import { createClientPrealert, type ClientPrealertPayload } from "../../../services/business-api";
import { CARGO_TYPE_HINT, CARGO_TYPE_ZH, parseCargoType, type CargoType } from "../../../../../../packages/shared-types/cargo-type";

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
  /** 货型（2026-09-11）。null = 这一格填了认不出来的字，下面会拦住不让提交 */
  cargoType: CargoType | null;
  /** 填错时原样回显给客户看 */
  cargoTypeRaw: string;
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
      // 货型加在最后一列（2026-09-11）：中间插列会让按老列序粘数据的文件整体错位
      "货型（普货/商检/敏感，默认普货）": "",
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
    { wch: 30 },  // 货型
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
      const cargoTypeRaw = findCol(row, ["货型"]);
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
        // 货型（2026-09-11）：留空按普货；认不出来的先留 null，预览里标红并禁掉提交，
        // **不许**静默当普货 —— 商检货按普货走，清关要的单据是另一套
        cargoType: parseCargoType(cargoTypeRaw)?.value ?? null,
        cargoTypeRaw,
      };
    })
    .filter((item) => item.warehouseId && item.itemName && Number.isFinite(item.packageCount) && item.packageCount > 0);
}

const th: React.CSSProperties = { textAlign: "left", padding: "6px 4px", whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "6px 4px" };

export default function ClientImportsPage() {
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [loading, setLoading] = useState(false);
  // 2026-09-02 终审整改：解析门闩——文件解析是异步的（arrayBuffer + XLSX），大文件要读好几秒。
  // 解析期间「选文件」和「提交」都锁死，解析回调验号后才落地，防止旧预览被提交到一半。
  const [parsing, setParsing] = useState(false);
  const parseGate = useRef(createRequestGate()).current;
  const [current, setCurrent] = useState(0);
  const [successCount, setSuccessCount] = useState(0);
  const [failCount, setFailCount] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const [message, setMessage] = useState("");

  const validCount = useMemo(() => rows.length, [rows]);

  /* 2026-09-01 竞态全扫：记住「当前预览是哪一份」（request-gate 用法二·认主人的快照版）。
     handleSubmit 的循环拿的是点击那一刻的 rows；万一提交期间预览被换成另一份文件，
     旧批次的进度/结果就不许再往新预览上写。主防线是提交期间禁用上传入口（见下），
     这个快照是第二道保险。 */
  const previewRef = useRef<ImportRow[]>([]);

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    // 2026-09-01 竞态全扫 + 2026-09-02 终审整改：提交中/解析中都不接受新文件（入口已 disabled，这里再兜一层）
    if (loading || parsing) return;
    // 2026-09-02 终审整改：领号必须在用户动作处同步完成（任何 await 之前）——
    // 一领号，旧解析立即作废；同时立刻挂上 parsing，把「提交」按钮锁死到解析落地为止
    const ticket = parseGate.begin();
    setParsing(true);
    setMessage("正在解析文件…");
    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });
      const normalized = normalizeRows(raw);
      // 2026-09-02 终审整改：成功分支验号——解析期间又选了新文件的话，这份旧结果整体作废
      if (!parseGate.isCurrent(ticket)) return;
      // 2026-09-01 竞态全扫：预览换主人，快照同步更新
      previewRef.current = normalized;
      setRows(normalized);
      setCurrent(0);
      setSuccessCount(0);
      setFailCount(0);
      setErrors([]);
      setDone(false);
      setMessage(`已读取 ${normalized.length} 条有效数据`);
    } catch {
      // 2026-09-02 终审整改：失败分支同样验号，旧解析的报错不许盖到新解析的提示上
      if (!parseGate.isCurrent(ticket)) return;
      setMessage("文件解析失败，请确认使用提供的模板格式");
    } finally {
      // 2026-09-02 终审整改：收尾也验号——只有最新一次解析才有资格解锁提交
      if (parseGate.isCurrent(ticket)) setParsing(false);
    }
  };

  /** 填了认不出来的货型的行（提交前要拦住，不能静默当普货） */
  const badCargoRows = rows
    .map((row, index) => ({ row, index }))
    .filter((entry) => entry.row.cargoType === null);

  const handleSubmit = async () => {
    // 2026-09-02 终审整改：解析中/提交中/没数据一律拒绝（按钮已 disabled，这里再兜一层）——
    // 解析期间提交的会是上一份旧预览，等新文件解析完打断循环就只写进半批
    if (loading || parsing || rows.length === 0) return;
    // 2026-09-01 竞态全扫：记下这次提交的是哪一份预览（点击那一刻的 rows 快照）
    const batch = rows;
    setLoading(true);
    setCurrent(0);
    setSuccessCount(0);
    setFailCount(0);
    setErrors([]);
    setDone(false);
    setMessage("");

    let success = 0;
    const errs: string[] = [];

    for (let i = 0; i < batch.length; i++) {
      // 2026-09-01 竞态全扫：预览已不是出发时那份（理论上入口已禁用走不到这，兜底），
      // 旧批次立即停手，不再提交、也不再往新预览上写任何进度和结果
      if (previewRef.current !== batch) break;
      setCurrent(i + 1);
      const row = batch[i];
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
          // 货型（2026-09-11）：上面已经拦掉认不出来的，这里一定是那三个值之一
          cargoType: row.cargoType ?? "normal",
        };
        await createClientPrealert(payload);
        success++;
        // 2026-09-01 竞态全扫：响应回来先认主人，预览换了就不写计数
        if (previewRef.current !== batch) break;
        setSuccessCount(success);
      } catch (error) {
        const text = error instanceof Error ? error.message : "提交失败";
        errs.push(`第${i + 1}行(${row.itemName}): ${text}`);
        // 2026-09-01 竞态全扫：失败分支同样认主人，旧批次的报错不许混进新预览
        if (previewRef.current !== batch) break;
        setFailCount(errs.length);
        setErrors([...errs]);
      }
    }

    // 2026-09-01 竞态全扫：只有预览还是出发时那份，才展示这批的完成汇总
    if (previewRef.current === batch) {
      setErrors(errs);
      setDone(true);
    }
    setLoading(false);
  };

  return (
    <RoleShell allowedRole="client" title="客户端批量下单" variant="a3">
      <section style={{ border: "1px solid var(--l-soft)", borderRadius: 12, padding: 16, background: "var(--white)" }}>
        <h2 style={{ marginTop: 0 }}>智能下单系统（批量导入）</h2>
        <p style={{ color: "var(--t-strong)", marginTop: 0 }}>
          支持 Excel 批量导入预报单。建议先下载模板，按字段填好后上传。
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
          <button
            type="button"
            onClick={downloadTemplate}
            style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 12px", background: "var(--white)", color: "var(--t-strong)", cursor: "pointer" }}
          >
            下载模板
          </button>
          {/* 2026-09-01 竞态全扫：提交期间禁用上传入口——提交中换文件会让 A 批次的
              后台创建结果和统计混进 B 的预览（复用现成的 loading 态）
              2026-09-02 终审整改：解析期间同样禁用——两把锁互锁：提交中不许换文件，解析中不许提交也不许再换文件 */}
          <label
            style={{
              border: loading || parsing ? "1px solid var(--l-strong)" : "1px solid var(--c-blue)",
              borderRadius: 8,
              padding: "8px 12px",
              background: loading || parsing ? "var(--s-sunken)" : "var(--c-blue-bg)",
              color: loading || parsing ? "var(--t-faint)" : "#1e3a8a",
              cursor: loading || parsing ? "not-allowed" : "pointer",
            }}
          >
            {parsing ? "解析中…" : "上传 Excel"}
            <input type="file" accept=".xlsx,.xls" disabled={loading || parsing} style={{ display: "none" }} onChange={handleUpload} />
          </label>
          <button
            type="button"
            disabled={loading || parsing || rows.length === 0 || badCargoRows.length > 0}
            onClick={handleSubmit}
            style={{
              border: "none",
              borderRadius: 8,
              padding: "8px 12px",
              background: loading || parsing || rows.length === 0 || badCargoRows.length > 0 ? "var(--t-faint)" : "var(--c-blue)",
              color: "var(--white)",
              cursor: loading || parsing || rows.length === 0 || badCargoRows.length > 0 ? "not-allowed" : "pointer",
            }}
          >
            {loading ? `提交中 ${current}/${rows.length}...` : "一键提交批量下单"}
          </button>
        </div>

        {/* 进度：只用文字报数，不放进度条动画 */}
        {loading && (
          <div style={{ marginBottom: 12, display: "flex", justifyContent: "space-between", fontSize: 13, color: "var(--t-strong)" }}>
            <span>正在提交第 {current}/{rows.length} 条…</span>
            <span>
              成功 {successCount} 条
              {failCount > 0 ? <span style={{ color: "var(--c-red-deep)" }}>　失败 {failCount} 条</span> : null}
            </span>
          </div>
        )}

        {/* 完成汇总 */}
        {done && (
          <div style={{ marginBottom: 12, padding: 12, border: "1px solid var(--l-soft)", background: "var(--white)" }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4, color: "var(--t-strong)" }}>
              批量下单完成：成功 {successCount} 条 / 失败 {failCount} 条
            </div>
            {errors.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: "var(--c-red-deep)" }}>
                {errors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            )}
          </div>
        )}

        {/* 单条消息 */}
        {message && !done && <p style={{ marginBottom: 10, color: "var(--t-strong)", fontSize: 13 }}>{message}</p>}

        {/* 预览表格 */}
        {rows.length > 0 && (
          <div style={{ marginBottom: 10, fontSize: 13, color: "var(--t-strong)" }}>当前有效行：{validCount}</div>
        )}
        {rows.length > 0 ? (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--l-cool)" }}>
                  <th style={th}>#</th>
                  <th style={th}>仓库ID</th>
                  <th style={th}>品名</th>
                  <th style={th}>箱数</th>
                  <th style={th}>运输</th>
                  <th style={th}>货型</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, idx) => (
                  <tr key={`${row.itemName}-${idx}`} style={{ borderBottom: "1px solid var(--s-cool-2)" }}>
                    <td style={td}>{idx + 1}</td>
                    <td style={td}>{row.warehouseId}</td>
                    <td style={td}>{row.itemName}</td>
                    <td style={td}>{row.packageCount} {row.packageUnit}</td>
                    <td style={td}>{row.transportMode === "sea" ? "海运" : "陆运"}</td>
                    <td style={{ ...td, color: row.cargoType === null ? "var(--c-red-deep)" : undefined }}>
                      {row.cargoType === null ? `「${row.cargoTypeRaw}」认不出来` : CARGO_TYPE_ZH[row.cargoType]}
                    </td>
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
