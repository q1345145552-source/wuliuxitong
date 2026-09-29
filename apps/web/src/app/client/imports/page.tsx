"use client";

import { useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { createRequestGate } from "../../../modules/shared/request-gate";
import { createClientPrealert, type ClientPrealertPayload } from "../../../services/business-api";
import { CARGO_TYPE_ZH } from "../../../../../../packages/shared-types/cargo-type";
import { WAREHOUSE_ZH, isRowBad, normalizeRows, type ImportRow } from "../../../modules/client-import/import-rows";

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
      "货型（普货/商检货/敏感货，默认普货）": "",
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

  // 标红（仓库 / 货型认不出来）的行不算有效（2026-09-28：认不出来的行现在留在预览里，不再悄悄丢掉）
  const validCount = useMemo(() => rows.filter((r) => !isRowBad(r)).length, [rows]);

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
    /* 一换文件就先把上一份预览清掉（2026-09-29 Codex 全系统检查）：原来新文件解析失败时，
       上一份的预览还留着、「一键提交」还能点 —— 客户以为提交的是新文件，其实是把上一份又下了一遍单。 */
    previewRef.current = [];
    setRows([]);
    setDone(false);
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
      const badCount = normalized.filter(isRowBad).length;
      setMessage(normalized.length === 0
        ? "这个文件里没有读到数据（表格是空的），请填好模板再上传"
        : badCount > 0
          ? `已读取 ${normalized.length} 条，其中 ${badCount} 条标红的要改（看最右边「要改的地方」），改好再上传`
          : `已读取 ${normalized.length} 条有效数据`);
    } catch {
      // 2026-09-02 终审整改：失败分支同样验号，旧解析的报错不许盖到新解析的提示上
      if (!parseGate.isCurrent(ticket)) return;
      setMessage("文件解析失败，请确认使用提供的模板格式");
    } finally {
      // 2026-09-02 终审整改：收尾也验号——只有最新一次解析才有资格解锁提交
      if (parseGate.isCurrent(ticket)) setParsing(false);
    }
  };

  /** 填了认不出来的货型的行（提交前要拦住，不能静默当普货）；仓库没填 / 认不出来的也一起拦 */
  const badCargoRows = rows
    .map((row, index) => ({ row, index }))
    .filter((entry) => isRowBad(entry.row));

  const handleSubmit = async () => {
    // 2026-09-02 终审整改：解析中/提交中/没数据一律拒绝（按钮已 disabled，这里再兜一层）——
    // 解析期间提交的会是上一份旧预览，等新文件解析完打断循环就只写进半批
    if (loading || parsing || rows.length === 0) return;
    // 有标红的行整批不交（按钮已 disabled，这里再兜一层）—— 不许「好的先交、坏的悄悄跳过」
    if (rows.some(isRowBad)) return;
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
          // 上面已经拦掉没填 / 认不出来的仓库
          warehouseId: row.warehouseId ?? "",
          itemName: row.itemName,
          packageCount: row.packageCount,
          packageUnit: row.packageUnit,
          weightKg: row.weightKg,
          volumeM3: row.volumeM3,
          shipDate: row.shipDate,
          domesticTrackingNo: row.domesticTrackingNo,
          // 上面已经拦掉没填 / 认不出来的运输方式
          transportMode: row.transportMode ?? "sea",
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
        errs.push(`表格第${row.rowNo}行(${row.itemName}): ${text}`);
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
    <>
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
                  <th style={th}>仓库</th>
                  <th style={th}>品名</th>
                  <th style={th}>箱数</th>
                  <th style={th}>运输</th>
                  <th style={th}>货型</th>
                  <th style={th}>要改的地方</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, idx) => (
                  <tr key={`${row.itemName}-${idx}`} style={{ borderBottom: "1px solid var(--s-cool-2)" }}>
                    <td style={td} title={`表格第 ${row.rowNo} 行`}>第{row.rowNo}行</td>
                    <td style={{ ...td, color: row.warehouseId === null ? "var(--c-red-deep)" : undefined }}>
                      {row.warehouseId === null
                        ? (row.warehouseRaw ? `「${row.warehouseRaw}」认不出来` : "没填")
                        : WAREHOUSE_ZH[row.warehouseId]}
                    </td>
                    <td style={{ ...td, color: row.itemName ? undefined : "var(--c-red-deep)" }}>{row.itemName || "没填"}</td>
                    <td style={td}>{row.issues.some((s) => s.startsWith("箱数")) ? (row.packageCountRaw || "—") : `${row.packageCount} ${row.packageUnit === "bag" ? "袋" : "箱"}`}</td>
                    <td style={{ ...td, color: row.transportMode === null ? "var(--c-red-deep)" : undefined }}>
                      {row.transportMode === null
                        ? (row.transportModeRaw ? `「${row.transportModeRaw}」认不出来` : "没填")
                        : row.transportMode === "sea" ? "海运" : "陆运"}
                    </td>
                    <td style={{ ...td, color: row.cargoType === null ? "var(--c-red-deep)" : undefined }}>
                      {row.cargoType === null ? `「${row.cargoTypeRaw}」认不出来` : CARGO_TYPE_ZH[row.cargoType]}
                    </td>
                    <td style={{ ...td, color: "var(--c-red-deep)" }}>{row.issues.join("；")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </>
  );
}
