"use client";

import { useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { createRequestGate } from "../../../modules/shared/request-gate";
import { createClientPrealert, type ClientPrealertPayload } from "../../../services/business-api";
import { CARGO_TYPE_ZH } from "../../../../../../packages/shared-types/cargo-type";
import { WAREHOUSE_ZH, isRowBad, normalizeRows, type ImportRow } from "../../../modules/client-import/import-rows";
import { clearPending, fileFingerprint, finishBatch, markDone, markPending, pendingStorage, readDoneRows, readPendingIds } from "../../../modules/client-import/pending-requests";

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
      "货型（普货/商检货/敏感货/特货，默认普货）": "",
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

/** 一行的请求编号：32 位随机字母数字（只要随机、够长；后端只认字母数字和「-」、16～64 位） */
function newRequestId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID().replace(/-/g, "");
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

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
  /** 这一轮里「不确定建没建成」的行数（断网 / 超时 / 网关出错，2026-10-18 审查第 3 轮）：提示客户直接重交、别改了重新上传 */
  const [unknownCount, setUnknownCount] = useState(0);
  const [message, setMessage] = useState("");

  // 标红（仓库 / 货型认不出来）的行不算有效（2026-09-28：认不出来的行现在留在预览里，不再悄悄丢掉）
  const validCount = useMemo(() => rows.filter((r) => !isRowBad(r)).length, [rows]);

  /* 2026-09-01 竞态全扫：记住「当前预览是哪一份」（request-gate 用法二·认主人的快照版）。
     handleSubmit 的循环拿的是点击那一刻的 rows；万一提交期间预览被换成另一份文件，
     旧批次的进度/结果就不许再往新预览上写。主防线是提交期间禁用上传入口（见下），
     这个快照是第二道保险。 */
  const previewRef = useRef<ImportRow[]>([]);
  /** 当前预览是哪个文件（按内容算的指纹）：没确认的行按它记编号（2026-10-18，见 pending-requests.ts） */
  const fileKeyRef = useRef("");

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
      /* 每一行一个请求编号（2026-10-18）：重试这一行时原样带上，服务器已经建好的就不再建（回话丢了也不会重复下单）。
         同一个文件上一批没收尾干净（断网 / 超时后刷新了页面再传）：那一批已经建好的行不再交，「发出去了、没确认」的行用回上次的编号，
         其余行新编号（pending-requests.ts） */
      const fileKey = await fileFingerprint(buffer, file);
      const pendingIds = readPendingIds(pendingStorage(), fileKey);
      const doneRows = new Set(readDoneRows(pendingStorage(), fileKey));
      const allRows = normalizeRows(raw);
      const skippedRowNos = allRows.filter((row) => doneRows.has(String(row.rowNo))).map((row) => row.rowNo);
      const normalized = allRows
        .filter((row) => !doneRows.has(String(row.rowNo)))
        .map((row) => ({ ...row, requestId: pendingIds[String(row.rowNo)] ?? newRequestId() }));
      const resumedRowNos = normalized.filter((row) => pendingIds[String(row.rowNo)] === row.requestId).map((row) => row.rowNo);
      // 2026-09-02 终审整改：成功分支验号——解析期间又选了新文件的话，这份旧结果整体作废
      if (!parseGate.isCurrent(ticket)) return;
      // 2026-09-01 竞态全扫：预览换主人，快照同步更新
      fileKeyRef.current = fileKey;
      previewRef.current = normalized;
      setRows(normalized);
      setCurrent(0);
      setSuccessCount(0);
      setFailCount(0);
      setErrors([]);
      setDone(false);
      const badCount = normalized.filter(isRowBad).length;
      const skippedNote = skippedRowNos.length > 0 ? `表格第 ${skippedRowNos.join("、")} 行上次已经建好了（「预报单」里能看到），这次不再交` : "";
      const resumedNote = resumedRowNos.length > 0
        ? `表格第 ${resumedRowNos.join("、")} 行上次发出去了、没确认建没建好：再交时上次要是其实已经建好，系统会认出来、不会重复下单`
        : "";
      const notes = [skippedNote, resumedNote].filter(Boolean).join("。");
      setMessage(normalized.length === 0
        ? (skippedRowNos.length > 0 ? `这个文件上次已经全部建好了（「预报单」里能看到），不用再交。${skippedNote}` : "这个文件里没有读到数据（表格是空的），请填好模板再上传")
        : badCount > 0
          ? `已读取 ${normalized.length} 条，其中 ${badCount} 条标红的要改（看最右边「要改的地方」），改好再上传${notes ? `。${notes}` : ""}`
          : `已读取 ${normalized.length} 条有效数据${notes ? `。${notes}` : ""}`);
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
    const batchFileKey = fileKeyRef.current;
    const store = pendingStorage();
    setLoading(true);
    setCurrent(0);
    setSuccessCount(0);
    setFailCount(0);
    setErrors([]);
    setDone(false);
    setMessage("");

    let success = 0;
    const errs: string[] = [];
    /** 这一轮没下成的行（2026-10-18 全系统审查第一档第 5 条）：跑完预览里只留它们 —— 原来跑完按钮还亮着、预览还是整批，
     *  再点一次（或者部分失败后点「重试」）会把已经成功的行再下一遍单（后端每次都新建订单，没有去重） */
    const failedRows: ImportRow[] = [];
    let unknown = 0;

    for (let i = 0; i < batch.length; i++) {
      // 2026-09-01 竞态全扫：预览已不是出发时那份（理论上入口已禁用走不到这，兜底），
      // 旧批次立即停手，不再提交、也不再往新预览上写任何进度和结果
      if (previewRef.current !== batch) break;
      setCurrent(i + 1);
      const row = batch[i];
      try {
        const payload: ClientPrealertPayload = {
          requestId: row.requestId,
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
        // 发出去之前先记下「没确认」（发到一半刷新页面也算），建好了挪到「已建好」（pending-requests.ts）
        if (row.requestId) markPending(store, batchFileKey, row.rowNo, row.requestId);
        await createClientPrealert(payload);
        markDone(store, batchFileKey, row.rowNo);
        success++;
        // 2026-09-01 竞态全扫：响应回来先认主人，预览换了就不写计数
        if (previewRef.current !== batch) break;
        setSuccessCount(success);
      } catch (error) {
        const text = error instanceof Error ? error.message : "提交失败";
        errs.push(`表格第${row.rowNo}行(${row.itemName}): ${text}`);
        failedRows.push(row);
        // 结果不确定的留着「没确认」的记号（再传同一个文件能认出来）；后端明确拒了的（肯定没建）删掉
        if ((error as { resultUnknown?: boolean } | null)?.resultUnknown) unknown++;
        else clearPending(store, batchFileKey, row.rowNo);
        // 2026-09-01 竞态全扫：失败分支同样认主人，旧批次的报错不许混进新预览
        if (previewRef.current !== batch) break;
        setFailCount(errs.length);
        setErrors([...errs]);
      }
    }

    // 这一批收尾：没有「没确认」的了就整条清掉（以后同一份表照旧当新单）；还有就留着，再传同一个文件时用（pending-requests.ts）
    finishBatch(store, batchFileKey);
    // 2026-09-01 竞态全扫：只有预览还是出发时那份，才展示这批的完成汇总
    if (previewRef.current === batch) {
      setErrors(errs);
      setUnknownCount(unknown);
      setDone(true);
      // 成功的行从预览里拿掉，只留没下成的：全成功了预览清空、按钮变灰；有失败的再点只重试这几行
      previewRef.current = failedRows;
      setRows(failedRows);
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
            {/* 成功的已经下单了（2026-10-18 全系统审查第一档第 5 条）：下面预览只剩没下成的，别再上传同一个文件，不然成功的会再下一遍 */}
            <div style={{ marginTop: 6, fontSize: 13, color: "var(--t-strong)" }}>
              {successCount > 0 ? `成功的 ${successCount} 条已经下单，不用再交，也不要再上传同一个文件（会重复下单）。` : ""}
              {rows.length > 0 ? `下面还剩 ${rows.length} 条没确认下成：再点「一键提交」只重交这几条（其中已经建好的系统会认出来，不会重复下单）。` : ""}
              {unknownCount > 0
                ? `其中 ${unknownCount} 条是网络或服务器没给准信、不确定有没有建好：请直接再点「一键提交」，不要把这几行改了重新上传（重新上传会当成新单）。`
                : ""}
              {/* 明确失败的行照旧按各自的原因处理（填错的改好另存再传，「过几秒再点」的再点）；跟不确定的混在一起时，先把不确定的点「一键提交」确认了再换文件（dsh 第 4、5 轮） */}
              {rows.length > unknownCount
                ? unknownCount > 0
                  ? `其余 ${rows.length - unknownCount} 条按上面各自写的原因处理：要改内容的改好另存一张表再上传（先把不确定的那几条点「一键提交」确认了，再换文件）。`
                  : "按上面每行写的原因处理：要改内容的，请只把这几行改好另存一张表再上传。"
                : ""}
            </div>
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
