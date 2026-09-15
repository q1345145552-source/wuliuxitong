"use client";

/**
 * 代理：名下客户的运单（3.2）、物流轨迹（3.2 / 3.5）、导出 Excel（3.8）。
 *
 * ⚠️ 导出的表跟管理端「运单管理 → 导出 Excel」同一套列，**去掉了「柜号」一列**（3.11 代理看柜号暂缓，
 *    后端 /agent/shipments/export-data 本来就不发柜号）。「客户」列是唛头。
 * ⚠️ 轨迹弹窗走 /agent/shipments/track（代理令牌打 /client/* 会被服务端 403）。
 */
import { useMemo, useRef, useState } from "react";
import EmptyStateCard from "../../modules/layout/EmptyStateCard";
import ShipmentExportPanel from "../../modules/shipment/ShipmentExportPanel";
import { openShipmentTrack } from "../../modules/shipment/ShipmentTrackModal";
import { shipmentStatusZh, transportModeLabel } from "../../modules/staff/utils";
import { CLIENT_STATUS_GROUP_ZH, type ClientStatusGroup } from "../../../../../packages/shared-types/shipment-status";
import { cargoTypeLabel } from "../../../../../packages/shared-types/cargo-type";
import {
  fetchAgentShipmentExportData,
  fetchAgentShipments,
  type AgentShipmentItem,
  type AgentShipmentQuery,
} from "../../services/agent-api";
import { LoadState, Pager, SectionHeader, TableWrap, btn, btnPrimary, fmtM3, input, mono, td, tdNum, th, useAgentLoad } from "./agent-ui";

const GROUPS: Array<{ value: string; label: string }> = [
  { value: "all", label: "全部" },
  { value: "pending", label: CLIENT_STATUS_GROUP_ZH.pending },
  { value: "transit", label: CLIENT_STATUS_GROUP_ZH.transit },
  { value: "arrived", label: CLIENT_STATUS_GROUP_ZH.arrived },
  { value: "delivered", label: CLIENT_STATUS_GROUP_ZH.delivered },
  { value: "closed", label: CLIENT_STATUS_GROUP_ZH.closed },
  { value: "attention", label: "异常" },
];
const PAGE_SIZE = 50;

const APPROVAL_ZH: Record<string, string> = { pending: "待审核", approved: "已审核", shipped: "已发货" };

/** 一行运单 → Excel 一行。列名、顺序照管理端 exportOrdersToExcel，去掉柜号 */
function toExcelRow(o: AgentShipmentItem) {
  return {
    运单号: o.trackingNo ?? "-",
    客户: o.clientId ?? "-",
    品名: o.productNames || o.itemName || "-",
    货型: cargoTypeLabel(o.products.map((p) => p.cargoType), o.cargoType),
    运输方式: o.transportMode,
    国内单号: o.domesticTrackingNo ?? "-",
    审批状态: APPROVAL_ZH[o.approvalStatus] ?? o.approvalStatus,
    产品数量: o.productQuantity ?? "-",
    包裹数量: o.packageCount ?? "-",
    重量: o.weightKg ?? "-",
    体积: o.volumeM3 ?? "-",
    长cm: o.lengthCm ?? "-",
    宽cm: o.widthCm ?? "-",
    高cm: o.heightCm ?? "-",
    到仓日期: o.shipDate ?? "-",
    状态组: CLIENT_STATUS_GROUP_ZH[o.statusGroup as ClientStatusGroup] ?? o.statusGroup ?? "-",
    创建时间: o.createdAt ?? "-",
    更新时间: o.updatedAt ?? "-",
  };
}

export default function AgentShipments() {
  const [trackingDraft, setTrackingDraft] = useState("");
  const [keywordDraft, setKeywordDraft] = useState("");
  const [query, setQuery] = useState<AgentShipmentQuery>({ page: 1, pageSize: PAGE_SIZE, statusGroup: "all" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportFeedback, setExportFeedback] = useState("");
  const exportInFlight = useRef(false);

  const { data, loading, error, reload } = useAgentLoad(() => fetchAgentShipments(query), [query]);
  const items = data?.items ?? [];
  const dateInvalid = Boolean(dateFrom && dateTo && dateFrom > dateTo);

  const updateQuery = (patch: Partial<AgentShipmentQuery>) => {
    setSelected(new Set());
    setQuery((q) => ({ ...q, page: 1, ...patch }));
  };

  const allOnPageSelected = items.length > 0 && items.every((o) => selected.has(o.id));
  const togglePage = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) items.forEach((o) => next.delete(o.id));
      else items.forEach((o) => next.add(o.id));
      return next;
    });
  };

  const filtersForExport = useMemo(() => {
    const { page: _p, pageSize: _s, ...rest } = query;
    return rest;
  }, [query]);

  const handleExport = async () => {
    if (exportInFlight.current || dateInvalid) return;
    exportInFlight.current = true;
    setExporting(true);
    setExportFeedback("");
    try {
      const result = await fetchAgentShipmentExportData({
        ...filtersForExport,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        orderIds: selected.size > 0 ? [...selected] : undefined,
      });
      if (result.items.length === 0) {
        setExportFeedback(dateFrom || dateTo ? "所选日期范围内没有运单。" : "当前没有可导出的运单。");
        return;
      }
      const XLSX = await import("xlsx");
      const ws = XLSX.utils.json_to_sheet(result.items.map(toExcelRow));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "订单列表");
      XLSX.writeFile(wb, `运单数据_${new Date().toISOString().slice(0, 10)}.xlsx`);
      setExportFeedback(`已导出 ${result.items.length} 条`);
    } catch (e) {
      setExportFeedback(`导出失败：${e instanceof Error ? e.message : "请稍后重试"}`);
    } finally {
      exportInFlight.current = false;
      setExporting(false);
    }
  };

  return (
    <section aria-labelledby="agent-shipments-title">
      <SectionHeader title="运单" desc="名下客户的运单和物流进度。点「轨迹」看物流记录、派送司机和签收照片。" />

      <form
        onSubmit={(e) => { e.preventDefault(); updateQuery({ trackingNo: trackingDraft.trim() || undefined, keyword: keywordDraft.trim() || undefined }); }}
        style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}
      >
        <label style={{ fontSize: 13 }}>
          <span className="workbench-sr-only">运单号</span>
          <input style={{ ...input, width: 180 }} placeholder="运单号（精确）" value={trackingDraft} onChange={(e) => setTrackingDraft(e.target.value)} />
        </label>
        <label style={{ fontSize: 13 }}>
          <span className="workbench-sr-only">品名或国内单号</span>
          <input style={{ ...input, width: 180 }} placeholder="品名 / 国内单号" value={keywordDraft} onChange={(e) => setKeywordDraft(e.target.value)} />
        </label>
        <label style={{ fontSize: 13 }}>
          <span className="workbench-sr-only">客户</span>
          <select style={input} value={query.clientId ?? ""} onChange={(e) => updateQuery({ clientId: e.target.value || undefined })}>
            <option value="">全部客户</option>
            {(data?.clients ?? []).map((c) => <option key={c.clientId} value={c.clientId}>{c.clientId}{c.name && c.name !== c.clientId ? `（${c.name}）` : ""}</option>)}
          </select>
        </label>
        <button type="submit" style={btnPrimary}>查询</button>
        <button type="button" style={btn} onClick={() => { setTrackingDraft(""); setKeywordDraft(""); updateQuery({ trackingNo: undefined, keyword: undefined, clientId: undefined, statusGroup: "all" }); }}>清空条件</button>
      </form>

      <div role="group" aria-label="按状态分组" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {GROUPS.map((g) => (
          <button key={g.value} type="button" aria-pressed={query.statusGroup === g.value} style={query.statusGroup === g.value ? btnPrimary : btn} onClick={() => updateQuery({ statusGroup: g.value })}>{g.label}</button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        <ShipmentExportPanel onOpen={() => setExportFeedback("")}>
          <div role="group" aria-label="导出 Excel" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ fontSize: 13 }}>起 <input type="date" style={input} value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} /></label>
            <label style={{ fontSize: 13 }}>止 <input type="date" style={input} value={dateTo} onChange={(e) => setDateTo(e.target.value)} /></label>
            <button type="button" style={btnPrimary} disabled={exporting || dateInvalid || (data?.total ?? 0) === 0} onClick={() => void handleExport()}>{exporting ? "导出中…" : "导出 Excel"}</button>
            <span style={{ fontSize: 12, color: "var(--t-muted)" }}>{selected.size > 0 ? `只导出已勾选的 ${selected.size} 条，再按到仓日期筛选` : "未勾选时导出全部筛选结果，再按到仓日期筛选"}</span>
          </div>
          {dateInvalid ? <p role="alert" style={{ color: "var(--c-red-dark)", fontSize: 13 }}>起始日期晚于截止日期，请调整。</p> : null}
          <p role="status" aria-live="polite" style={{ margin: exportFeedback ? "12px 0 0" : 0, fontSize: 13 }}>{exportFeedback}</p>
        </ShipmentExportPanel>
        {selected.size > 0 ? <span style={{ fontSize: 13, color: "var(--t-muted)" }}>已勾选 {selected.size} 条 <button type="button" style={{ ...btn, padding: "2px 8px" }} onClick={() => setSelected(new Set())}>清除勾选</button></span> : null}
      </div>

      <LoadState loading={loading} error={error} onRetry={reload} />
      {data && !loading && items.length === 0 ? (
        <EmptyStateCard title="没有运单" description={query.trackingNo || query.keyword || query.clientId || query.statusGroup !== "all" ? "请调整查询条件。" : "名下客户还没有运单。"} />
      ) : null}
      {items.length > 0 ? (
        <>
          <TableWrap label="运单列表，可横向滚动">
            <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", minWidth: 1100 }}>
              <thead>
                <tr>
                  <th scope="col" style={th}><input type="checkbox" aria-label="勾选本页全部" checked={allOnPageSelected} onChange={togglePage} /></th>
                  <th scope="col" style={th}>客户</th>
                  <th scope="col" style={th}>运单号</th>
                  <th scope="col" style={th}>物流状态</th>
                  <th scope="col" style={th}>到仓日期</th>
                  <th scope="col" style={th}>品名</th>
                  <th scope="col" style={th}>货型</th>
                  <th scope="col" style={{ ...th, textAlign: "right" }}>箱数</th>
                  <th scope="col" style={{ ...th, textAlign: "right" }}>体积 (m³)</th>
                  <th scope="col" style={{ ...th, textAlign: "right" }}>重量 (kg)</th>
                  <th scope="col" style={th}>运输方式</th>
                  <th scope="col" style={th}>国内单号</th>
                  <th scope="col" style={th}>泰国收货</th>
                  <th scope="col" style={th}>操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((o) => (
                  <tr key={o.id}>
                    <td style={td}><input type="checkbox" aria-label={`勾选 ${o.trackingNo ?? o.id}`} checked={selected.has(o.id)} onChange={() => setSelected((prev) => { const next = new Set(prev); if (next.has(o.id)) next.delete(o.id); else next.add(o.id); return next; })} /></td>
                    <td style={{ ...td, whiteSpace: "nowrap" }}>{o.clientId}{o.clientName && o.clientName !== o.clientId ? <div style={{ fontSize: 12, color: "var(--t-faint)" }}>{o.clientName}</div> : null}</td>
                    <td style={{ ...td, ...mono }}>{o.trackingNo ?? "—"}</td>
                    <td style={{ ...td, whiteSpace: "nowrap" }}>{o.currentStatus ? shipmentStatusZh(o.currentStatus) : "—"}</td>
                    <td style={{ ...td, whiteSpace: "nowrap" }}>{o.shipDate ?? "—"}</td>
                    <td style={{ ...td, minWidth: 140 }}>{o.productNames || o.itemName}</td>
                    <td style={{ ...td, whiteSpace: "nowrap" }}>{cargoTypeLabel(o.products.map((p) => p.cargoType), o.cargoType)}</td>
                    <td style={tdNum}>{o.packageCount}</td>
                    <td style={tdNum}>{fmtM3(o.totalVolumeM3 ?? o.volumeM3)}</td>
                    <td style={tdNum}>{o.totalWeightKg ?? o.weightKg ?? "—"}</td>
                    <td style={{ ...td, whiteSpace: "nowrap" }}>{transportModeLabel(o.transportMode)}</td>
                    <td style={td}>{o.domesticTrackingNo ?? "—"}</td>
                    <td style={{ ...td, minWidth: 180 }}>{o.receiverNameTh}{o.receiverPhoneTh ? ` ${o.receiverPhoneTh}` : ""}<div style={{ fontSize: 12, color: "var(--t-muted)" }}>{o.receiverAddressTh}</div></td>
                    <td style={td}>
                      {o.shipmentId ? (
                        <button type="button" style={btn} onClick={() => openShipmentTrack({ shipmentId: o.shipmentId! }, { endpoint: "/agent/shipments/track" })}>轨迹</button>
                      ) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <Pager page={data?.page ?? 1} pageSize={data?.pageSize ?? PAGE_SIZE} total={data?.total ?? 0} onPage={(p) => setQuery((q) => ({ ...q, page: p }))} />
        </>
      ) : null}
    </section>
  );
}
