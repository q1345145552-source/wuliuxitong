"use client";

/**
 * 整柜管理（2026-09-23 老板拍板新增）—— 员工端和超管端**共用这一个组件**。
 *
 * ⚠️ 为什么共用：尾端派送当年是「管理员端和员工端各写一套界面」，
 * 结果修了员工那套、管理员那套还写死只显示 20 条，用户打开发现没数据
 * （CLAUDE.md 第 20 条）。集货拼柜现在也是两套各写各的。整柜不再走那条路。
 *
 * 老板定的规格见后端 modules/fcl-containers/routes.ts 头部注释。
 * 这一页能干的事：建整柜（手工填 / 传表格）、看列表、看详情（货物清单 + 轨迹）。
 * 推状态不在这里做 —— 整柜建完就是普通柜子，走现成的「装柜管理」改状态。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createFclContainer,
  fetchFclContainers,
  fetchFclContainerDetail,
  fetchFclOverview,
  fetchFclLastmileShipments,
  fetchFclLastmileOrders,
  type FclContainerRow,
  type FclContainerDetail,
  type FclProductInput,
  type FclOverview,
} from "../../services/business-api";
import LastmileDispatchWorkspace from "../../modules/lastmile/LastmileDispatchWorkspace";
import type { LastmileOrderItem, LastmileShipmentOption } from "../../modules/lastmile/types";
import { shipmentStatusZh } from "../../modules/shipment/shipment-status";
import { formatBeijingTime } from "../../modules/staff/utils";
import EmptyStateCard from "../../modules/layout/EmptyStateCard";
import { FCL_TEMPLATE_HEADERS, fclRowFromSheet, missingFclHeaders } from "../../modules/fcl/template";

/** 仓库选项，跟运单那边一致 */
const WAREHOUSES = [
  { id: "wh_yiwu_01", label: "义乌仓" },
  { id: "wh_guangzhou_01", label: "广州仓" },
  { id: "wh_dongguan_01", label: "东莞仓" },
  { id: "wh_shenzhen_01", label: "深圳仓" },
];

const CARGO_TYPE_ZH: Record<string, string> = { normal: "普货", inspection: "商检货", sensitive: "敏感货" };

/** 柜子状态中文（跟「装柜管理」同一套说法） */
const CONTAINER_STATUS_ZH: Record<string, string> = {
  LOADING: "装柜中", HOLD_LOADING: "暂缓柜", SEALED: "已封柜", DELAY_DEPARTED: "延迟开船",
  ETA_UPDATED: "到港时间更新", PORT_CLOSED: "港口封港", BERTHED: "已靠泊", IN_TRANSIT: "已开船",
  DELAY_IN_TRANSIT: "延迟运输", ARRIVED: "已到港", AT_PORT_CN: "到达凭祥口岸", BORDER_DELAY: "口岸滞留",
  EXPORT_CLEARED: "出口已放行", IN_VIETNAM: "过境越南", CUSTOMS_INSPECT: "越南海关查验",
  LAOS_CLEARED: "老挝边境已放行", CUSTOMS_INSPECT_CN: "国内海关查验", INSPECT_CLEARED_CN: "国内查验放行",
  CUSTOMS_INSPECT_TH: "泰国海关查验", INSPECT_CLEARED_TH: "泰国查验放行", CUSTOMS: "清关中",
  CUSTOMS_CLEARED: "清关已放行", UNLOADING: "正在卸柜", IN_WAREHOUSE_TH: "已到仓",
  DELIVERY_BOOKED: "预约派送", OUT_FOR_DELIVERY: "派送中", SIGNED: "已签收",
};

/** 空的一行（手工录入时用） */
const emptyRow = (): FclProductInput => ({
  itemName: "", packageCount: "", quantityPerBox: "", lengthCm: "", widthCm: "", heightCm: "",
  unitWeightKg: "", domesticTrackingNo: "", cargoType: "normal",
});

/** 前端先算一遍体积和总重，让员工录的时候就能看到数（真正说了算的是后端那一份） */
function previewRow(r: FclProductInput): { volumeM3: number; weightKg: number } {
  const n = (v: unknown) => {
    const x = Number(String(v ?? "").trim());
    return Number.isFinite(x) ? x : 0;
  };
  const pkg = n(r.packageCount);
  const vol = (n(r.lengthCm) * n(r.widthCm) * n(r.heightCm)) / 1_000_000 * pkg;
  return { volumeM3: Number(vol.toFixed(6)), weightKg: Number((n(r.unitWeightKg) * pkg).toFixed(2)) };
}

const card: React.CSSProperties = { background: "var(--white)", border: "1px solid var(--l-soft)", borderRadius: 10, padding: 16, marginBottom: 16 };
const fl: React.CSSProperties = { display: "block", fontSize: 12, color: "var(--t-muted)", marginBottom: 4 };
const fi: React.CSSProperties = { width: "100%", padding: "7px 10px", border: "1px solid var(--l-strong)", borderRadius: 6, fontSize: 13 };
const th: React.CSSProperties = { padding: "6px 8px", textAlign: "left", fontSize: 12, whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "5px 8px", fontSize: 12, borderTop: "1px solid var(--l-soft)" };

export default function FclContainerWorkbench({ canUnsign = false }: { canUnsign?: boolean }) {
  /* 两个页签：柜子列表 / 尾端派送（老板 2026-09-23：「整柜的尾端单独在页面里弄」）。
     尾端那块直接用普通尾端派送那个共用组件 —— 建单、签收、撤销、导客户签收单
     全是同一套，员工不用学第二遍；两边分开靠的是各看各的列表（scope=fcl）。 */
  const [tab, setTab] = useState<"containers" | "lastmile">("containers");
  const [overview, setOverview] = useState<FclOverview | null>(null);
  const [lmShipments, setLmShipments] = useState<LastmileShipmentOption[]>([]);
  const [lmOrders, setLmOrders] = useState<LastmileOrderItem[]>([]);
  const [lmLoading, setLmLoading] = useState(false);
  const [lmError, setLmError] = useState("");
  const [rows, setRows] = useState<FclContainerRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState("");
  const [listNote, setListNote] = useState("");
  const [search, setSearch] = useState({ clientId: "", containerNo: "", trackingNo: "" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<FclContainerDetail | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  // ---- 新建整柜的表单 ----
  const [form, setForm] = useState({
    clientId: "", trackingNo: "", containerNo: "", containerType: "40HQ",
    transportMode: "sea", warehouseId: WAREHOUSES[0].id, loadingDate: "", amountCny: "", remark: "",
  });
  const [products, setProducts] = useState<FclProductInput[]>([emptyRow()]);
  const [parsing, setParsing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submitInFlight = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetchFclContainers(search);
      setRows(r.items ?? []);
      // 到顶了要说出来，不能静默截断（CLAUDE.md 第 21 条：看不到的数据，用户得有办法知道它存在）
      setListNote(r.truncated ? (r.note ?? "只显示最近 500 个整柜，请用上面的条件缩小范围") : "");
    } catch (e) {
      setToast(`加载整柜列表失败：${e instanceof Error ? e.message : "请稍后重试"}`);
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => { void loadList(); }, [loadList]);

  // 顶上那排数字（整柜自己的看板；普通看板已经把整柜扣掉了）
  const loadOverview = useCallback(async () => {
    try { setOverview(await fetchFclOverview()); }
    catch (e) { console.error(e); }   // 数字加载失败不挡着用，列表照常
  }, []);
  useEffect(() => { void loadOverview(); }, [loadOverview]);

  const loadLmOrders = useCallback(async () => {
    setLmError("");
    try { setLmOrders((await fetchFclLastmileOrders()) as unknown as LastmileOrderItem[]); }
    catch (e) { setLmError(e instanceof Error ? e.message : "加载派送单失败"); }
  }, []);
  const loadLmShipments = useCallback(async () => {
    setLmLoading(true);
    setLmError("");
    try { setLmShipments((await fetchFclLastmileShipments()) as unknown as LastmileShipmentOption[]); }
    catch (e) { setLmError(e instanceof Error ? e.message : "加载可派送整柜失败"); }
    finally { setLmLoading(false); }
  }, []);
  useEffect(() => {
    if (tab !== "lastmile") return;
    void loadLmOrders();
    void loadLmShipments();
  }, [tab, loadLmOrders, loadLmShipments]);

  const openDetail = async (containerId: string) => {
    setSelectedId(containerId);
    setDetail(null);
    try {
      setDetail(await fetchFclContainerDetail(containerId));
    } catch (e) {
      setToast(`加载详情失败：${e instanceof Error ? e.message : "请稍后重试"}`);
      setSelectedId(null);
    }
  };

  /** 下载模板：一个表格 = 一个柜，所以柜号、柜型这些不放表格里 */
  const downloadTemplate = async () => {
    const XLSX = await import("xlsx");
    const blank: Record<string, string> = {};
    for (const h of FCL_TEMPLATE_HEADERS) blank[h] = "";
    const ws = XLSX.utils.json_to_sheet([blank]);
    ws["!cols"] = FCL_TEMPLATE_HEADERS.map((h) => ({ wch: Math.max(12, h.length + 4) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "整柜货物清单模板");
    XLSX.writeFile(wb, "整柜货物清单模板.xlsx");
  };

  /** 传表格：表头精确匹配，解析完直接填进下面的表格，员工能再改 */
  const onPickFile = async (file: File) => {
    setParsing(true);
    setToast("");
    try {
      const XLSX = await import("xlsx");
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      if (!sheet) { setToast("这个表格里没有工作表，请确认用的是整柜货物清单模板"); return; }
      const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
      /* 只有表头、一行数据都没填的空模板：单独说一句，别报「少了全部 9 列」把人带偏
         （2026-09-24 上线前自审发现）。 */
      if (json.length === 0) {
        setToast("这个表格里一行货都没填，请把货物填进模板再传。");
        return;
      }
      /* 先核表头：少一列就明说少哪一列。不核的话，「货型」表头改个字整张表静默变普货、
         「单箱重量」改个字总重静默变 0，员工根本看不出来（2026-09-23 复核抓到）。 */
      const missing = missingFclHeaders(json[0]);
      if (missing.length > 0) {
        setToast(`这个表格不是我们的模板，少了这些列：${missing.join("、")}。请点「下载模板」重新填，表头一个字都不能改。`);
        return;
      }
      const all = json.map(fclRowFromSheet);
      /* 「整行都空」的是表格尾巴上的空行，直接跳过；
         「填了箱数/尺寸但没填品名」的必须报出来 —— 静默丢掉就等于少运货（CLAUDE.md 第 19 条）。 */
      const isBlank = (r: any) => [
        // ⚠️ 这张清单要把**所有**能填的格子都列上（2026-09-23 第 2 轮复核抓到）：
        // 漏了「每箱数量」的话，只动过那一格的行会被当成空行静默丢掉。
        "itemName", "packageCount", "quantityPerBox", "lengthCm", "widthCm", "heightCm",
        "unitWeightKg", "domesticTrackingNo",
      ]
        .every((k) => String(r[k] ?? "").trim() === "")
        // 货型有默认值 normal，按「动过没有」算：改成商检/敏感就说明这一行不是空的
        && String(r.cargoType ?? "normal") === "normal";
      const noName: number[] = [];
      const parsed = all.filter((r, i) => {
        if (isBlank(r)) return false;
        if (String(r.itemName ?? "").trim() === "") { noName.push(i + 2); return false; }  // +2：表头占第 1 行
        return true;
      });
      if (noName.length > 0) {
        setToast(`表格第 ${noName.join("、")} 行填了数量尺寸但没写品名，这几行没读进来。补上品名再传一次。`);
        return;
      }
      if (parsed.length === 0) {
        setToast("没读到有效的货物行。请用「下载模板」那个表格填，表头不能改。");
        return;
      }
      setProducts(parsed);
      setToast(`表格读到 ${parsed.length} 行货，已填进下面，核对后再提交`);
    } catch (e) {
      setToast(`表格读不了：${e instanceof Error ? e.message : "请确认是 .xlsx 文件"}`);
    } finally {
      setParsing(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const totals = useMemo(() => {
    const t = products.reduce(
      (acc, r) => {
        const p = previewRow(r);
        const pkg = Number(String(r.packageCount ?? "").trim()) || 0;
        return { packageCount: acc.packageCount + pkg, volumeM3: acc.volumeM3 + p.volumeM3, weightKg: acc.weightKg + p.weightKg };
      },
      { packageCount: 0, volumeM3: 0, weightKg: 0 },
    );
    return { ...t, volumeM3: Number(t.volumeM3.toFixed(3)), weightKg: Number(t.weightKg.toFixed(2)) };
  }, [products]);

  const resetCreate = () => {
    setForm({ clientId: "", trackingNo: "", containerNo: "", containerType: "40HQ", transportMode: "sea", warehouseId: WAREHOUSES[0].id, loadingDate: "", amountCny: "", remark: "" });
    setProducts([emptyRow()]);
  };

  const submitCreate = async () => {
    if (submitInFlight.current) return;
    /* 「整行都空」的是刚加出来还没填的行，跳过；
       「填了别的但没填品名」的要拦住 —— 静默丢掉等于少运货（2026-09-23 复核抓到）。 */
    const isBlank = (r: FclProductInput) => [
        // ⚠️ 这张清单要把**所有**能填的格子都列上（2026-09-23 第 2 轮复核抓到）：
        // 漏了「每箱数量」的话，只动过那一格的行会被当成空行静默丢掉。
        "itemName", "packageCount", "quantityPerBox", "lengthCm", "widthCm", "heightCm",
        "unitWeightKg", "domesticTrackingNo",
      ]
      .every((k) => String((r as any)[k] ?? "").trim() === "")
      // 货型有默认值 normal，按「动过没有」算
      && String(r.cargoType ?? "normal") === "normal";
    const noName = products
      .map((r, i) => ({ r, no: i + 1 }))
      .filter(({ r }) => !isBlank(r) && String(r.itemName ?? "").trim() === "")
      .map(({ no }) => no);
    if (noName.length > 0) { setToast(`第 ${noName.join("、")} 行没填品名，补上再提交`); return; }
    const filled = products.filter((r) => !isBlank(r));
    if (filled.length === 0) { setToast("货物清单至少要填一行（品名必填）"); return; }
    submitInFlight.current = true;
    setSubmitting(true);
    setToast("");
    try {
      const r = await createFclContainer({
        ...form,
        amountCny: form.amountCny.trim() === "" ? undefined : form.amountCny.trim(),
        loadingDate: form.loadingDate.trim() || undefined,
        remark: form.remark.trim() || undefined,
        products: filled,
      });
      setToast(`整柜已建好：柜号 ${r.containerNo}，提单号 ${r.trackingNo}，${r.rowCount} 行货、${r.packageCount} 箱、${r.volumeM3} 方`);
      setShowCreate(false);
      resetCreate();
      await loadList();
    } catch (e) {
      // 失败也留在弹窗里，员工改一处就能重提，不用全部重填
      setToast(`建整柜失败：${e instanceof Error ? e.message : "请稍后重试"}`);
    } finally {
      submitInFlight.current = false;
      setSubmitting(false);
    }
  };

  // ======================= 详情页 =======================
  if (selectedId) {
    return (
      <div>
        <button type="button" className="workbench-button" onClick={() => { setSelectedId(null); setDetail(null); }} style={{ marginBottom: 12 }}>← 返回整柜列表</button>
        {!detail ? <EmptyStateCard title="正在加载" description="正在读这个整柜的货物清单和轨迹。" /> : (
          <>
            <div style={card}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <h2 style={{ fontSize: 20, margin: 0 }}>{detail.containerNo}</h2>
                <span style={{ padding: "4px 12px", background: "var(--s-cool)", borderRadius: 999, fontSize: 13, fontWeight: 600 }}>{CONTAINER_STATUS_ZH[detail.containerStatus ?? ""] ?? detail.containerStatus}</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12 }}>
                <div><span style={fl}>客户唛头</span><div style={{ fontWeight: 600, fontFamily: "monospace" }}>{detail.clientId ?? "—"}</div></div>
                <div><span style={fl}>提单号</span><div style={{ fontWeight: 600, fontFamily: "monospace" }}>{detail.trackingNo ?? "—"}</div></div>
                <div><span style={fl}>柜型</span><div>{detail.containerType}</div></div>
                <div><span style={fl}>运输方式</span><div>{detail.transportMode === "land" ? "陆运" : "海运"}</div></div>
                <div><span style={fl}>仓库</span><div>{WAREHOUSES.find((w) => w.id === detail.warehouseId)?.label ?? detail.warehouseId ?? "—"}</div></div>
                <div><span style={fl}>装柜日期</span><div>{detail.loadingDate ? detail.loadingDate.slice(0, 10) : "—"}</div></div>
                <div><span style={fl}>总箱数</span><div>{detail.packageCount ?? "—"}</div></div>
                <div><span style={fl}>总体积 (m³)</span><div>{detail.volumeM3 ?? "—"}</div></div>
                <div><span style={fl}>总重 (kg)</span><div>{detail.weightKg ?? "—"}</div></div>
                <div><span style={fl}>金额 (¥)</span><div style={{ fontWeight: 600 }}>{detail.amountCny == null ? "—" : detail.amountCny.toLocaleString()}</div></div>
              </div>
              {detail.remark && <div style={{ marginTop: 12, fontSize: 13, color: "var(--t-muted)" }}>备注：{detail.remark}</div>}
            </div>

            <div style={card}>
              <h3 style={{ fontSize: 16, marginTop: 0, marginBottom: 10 }}>货物清单（{detail.products.length} 行）</h3>
              <div style={{ overflowX: "auto" }}>
                <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr style={{ background: "var(--s-sunken)" }}>
                    <th style={th}>品名</th><th style={th}>箱数</th><th style={th}>每箱数量</th>
                    <th style={th}>长cm</th><th style={th}>宽cm</th><th style={th}>高cm</th>
                    <th style={th}>单箱重kg</th><th style={th}>国内单号</th><th style={th}>货型</th>
                  </tr></thead>
                  <tbody>
                    {detail.products.map((p) => (
                      <tr key={p.id}>
                        <td style={td}>{p.itemName}</td><td style={td}>{p.packageCount}</td><td style={td}>{p.productQuantity ?? "—"}</td>
                        <td style={td}>{p.lengthCm ?? "—"}</td><td style={td}>{p.widthCm ?? "—"}</td><td style={td}>{p.heightCm ?? "—"}</td>
                        <td style={td}>{p.weightKg ?? "—"}</td><td style={td}>{p.domesticTrackingNo ?? "—"}</td>
                        <td style={td}>{CARGO_TYPE_ZH[p.cargoType] ?? p.cargoType}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div style={card}>
              <h3 style={{ fontSize: 16, marginTop: 0, marginBottom: 10 }}>物流轨迹</h3>
              {detail.timeline.length === 0 ? <div style={{ fontSize: 13, color: "var(--t-muted)" }}>还没有轨迹</div> : (
                <ol style={{ listStyle: "none", padding: 0, margin: 0 }}>
                  {[...detail.timeline].reverse().map((t) => (
                    <li key={t.id} style={{ padding: "8px 0", borderTop: "1px solid var(--l-soft)" }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{shipmentStatusZh(t.toStatus)}</div>
                      <div style={{ fontSize: 12, color: "var(--t-muted)" }}>
                        {formatBeijingTime(t.changedAt)}
                        {t.nextStop ? ` · 下一站：${t.nextStop}` : ""}
                        {/* 操作人只有超管拿得到（后端按角色摘的），这里有就显示 */}
                        {t.operatorName ? ` · 操作人：${t.operatorName}` : ""}
                      </div>
                      {t.remark && <div style={{ fontSize: 12, marginTop: 2 }}>{t.remark}</div>}
                    </li>
                  ))}
                </ol>
              )}
              <p style={{ fontSize: 12, color: "var(--t-muted)", marginBottom: 0 }}>
                往前推状态在「装柜管理」里做 —— 整柜建完就是一个普通柜子，推一步系统自动给客户写一条轨迹。
              </p>
            </div>
          </>
        )}
        <p role="status" aria-live="polite" style={{ fontSize: 13 }}>{toast}</p>
      </div>
    );
  }

  // ======================= 列表页 =======================
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <h2 style={{ fontSize: 22, margin: 0 }}>整柜管理</h2>
        {tab === "containers" && (
          <button type="button" className="workbench-button workbench-button--primary" onClick={() => { setShowCreate(true); setToast(""); }}>+ 新建整柜</button>
        )}
      </div>

      {/* 整柜自己的看板（老板 2026-09-23：「运营看板再单独在整柜里面加一个」）。
          普通运营看板已经把整柜扣掉了，两边各看各的、不重复计。 */}
      {overview && (
        <div style={{ ...card, display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(110px,1fr))", gap: 12 }}>
          {[
            ["整柜总数", String(overview.total), ""],
            ["在路上", String(overview.onTheWay), `${overview.onTheWayVolumeM3} m³`],
            ["已到仓", String(overview.atWarehouse), ""],
            ["已签收", String(overview.signed), ""],
            ["本月新增", String(overview.thisMonth), ""],
            ["总方数", String(overview.volumeM3), "m³"],
            ["总箱数", String(overview.packageCount), ""],
            ["金额合计", overview.amountCny.toLocaleString(), "¥"],
          ].map(([label, value, unit]) => (
            <div key={label}>
              <span style={fl}>{label}</span>
              <div style={{ fontSize: 20, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                {value}{unit && <span style={{ fontSize: 12, fontWeight: 400, color: "var(--t-muted)", marginLeft: 3 }}>{unit}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 两个页签 */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        {([["containers", "柜子列表"], ["lastmile", "尾端派送"]] as const).map(([key, label]) => (
          <button key={key} type="button" className="workbench-button"
            aria-pressed={tab === key}
            style={tab === key ? { background: "var(--c-blue)", color: "var(--white)", borderColor: "var(--c-blue)" } : undefined}
            onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>

      {tab === "lastmile" && (
        <div style={card}>
          <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--t-muted)" }}>
            这里只管<strong>整柜</strong>的派送：可选的货是已经到泰国仓的整柜，建单、签收、导客户签收单跟普通尾端派送一模一样。
            拼柜的派送在左边菜单「尾端派送」里，两边各看各的。
          </p>
          <LastmileDispatchWorkspace
            id="fcl-lastmile"
            surface="embedded"
            lmShipments={lmShipments}
            lmOrderList={lmOrders}
            shipmentsLoading={lmLoading}
            shipmentsError={lmError}
            ordersError={lmError}
            onToast={setToast}
            onReloadOrders={loadLmOrders}
            onLoadShipments={loadLmShipments}
            canUnsign={canUnsign}
          />
          <p role="status" aria-live="polite" style={{ fontSize: 13 }}>{toast}</p>
        </div>
      )}

      {tab === "containers" && (<>

      <div style={{ ...card, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div><label style={fl}>客户唛头</label><input style={{ ...fi, width: 150 }} value={search.clientId} onChange={(e) => setSearch((v) => ({ ...v, clientId: e.target.value }))} /></div>
        <div><label style={fl}>柜号</label><input style={{ ...fi, width: 150 }} value={search.containerNo} onChange={(e) => setSearch((v) => ({ ...v, containerNo: e.target.value }))} /></div>
        <div><label style={fl}>提单号</label><input style={{ ...fi, width: 150 }} value={search.trackingNo} onChange={(e) => setSearch((v) => ({ ...v, trackingNo: e.target.value }))} /></div>
        <button type="button" className="workbench-button" onClick={() => void loadList()} disabled={loading}>{loading ? "查询中…" : "查询"}</button>
        <button type="button" className="workbench-button" onClick={() => setSearch({ clientId: "", containerNo: "", trackingNo: "" })}>清空条件</button>
      </div>

      {rows.length === 0 ? (
        <EmptyStateCard title="还没有整柜" description="点右上角「新建整柜」，选客户、填柜号，再把客户那份货物清单传进来。" />
      ) : (
        <div style={card}>
          <div style={{ fontSize: 13, color: "var(--t-muted)", marginBottom: 8 }}>
            共 {rows.length} 个整柜
            {listNote && <span style={{ color: "var(--c-amber-deep)", marginLeft: 8 }}>· {listNote}</span>}
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr style={{ background: "var(--s-sunken)" }}>
                <th style={th}>柜号</th><th style={th}>客户唛头</th><th style={th}>提单号</th><th style={th}>柜型</th>
                <th style={th}>运输</th><th style={th}>当前状态</th><th style={th}>箱数</th><th style={th}>体积m³</th>
                <th style={th}>金额¥</th><th style={th}>建柜时间</th><th style={th}></th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.containerId}>
                    <td style={{ ...td, fontFamily: "monospace" }}>{r.containerNo}</td>
                    <td style={{ ...td, fontFamily: "monospace" }}>{r.clientId ?? "—"}</td>
                    <td style={{ ...td, fontFamily: "monospace" }}>{r.trackingNo ?? "—"}</td>
                    <td style={td}>{r.containerType}</td>
                    <td style={td}>{r.transportMode === "land" ? "陆运" : "海运"}</td>
                    <td style={td}>{CONTAINER_STATUS_ZH[r.containerStatus ?? ""] ?? r.containerStatus}</td>
                    <td style={td}>{r.packageCount ?? "—"}</td>
                    <td style={td}>{r.volumeM3 ?? "—"}</td>
                    <td style={td}>{r.amountCny == null ? "—" : r.amountCny.toLocaleString()}</td>
                    <td style={td}>{formatBeijingTime(r.createdAt)}</td>
                    <td style={td}><button type="button" className="workbench-button" onClick={() => void openDetail(r.containerId)}>详情</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p role="status" aria-live="polite" style={{ fontSize: 13 }}>{toast}</p>
      </>)}

      {/* ======================= 新建整柜 ======================= */}
      {showCreate && (
        <div role="dialog" aria-modal="true" aria-label="新建整柜"
          onClick={() => setShowCreate(false)}
          style={{ position: "fixed", inset: 0, zIndex: 9000, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ background: "var(--white)", borderRadius: 12, padding: 24, maxWidth: 1100, width: "94%", maxHeight: "88vh", overflowY: "auto", boxShadow: "0 8px 32px rgba(0,0,0,0.2)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <h3 style={{ margin: 0 }}>新建整柜</h3>
              <button type="button" className="workbench-button" onClick={() => setShowCreate(false)}>关闭</button>
            </div>
            {/* 跟「装柜管理」那边的提示成对：走错入口事后不能互转（老板 2026-09-24 要的） */}
            <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--c-amber-deep)", background: "var(--c-amber-bg)", padding: "6px 10px", borderRadius: 6 }}>
              这里建的是<strong>整柜</strong>（一个客户包一整柜）。好几个客户拼一个柜的，请到「<strong>装柜管理</strong>」里建 —— 建完不能互转。
            </p>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 10, marginBottom: 14 }}>
              <div><label style={fl}>客户唛头 *</label><input style={fi} value={form.clientId} onChange={(e) => setForm((v) => ({ ...v, clientId: e.target.value }))} placeholder="如 XHH6700" /></div>
              <div><label style={fl}>提单号 *（手填）</label><input style={fi} value={form.trackingNo} onChange={(e) => setForm((v) => ({ ...v, trackingNo: e.target.value }))} /></div>
              <div><label style={fl}>柜号 *</label><input style={fi} value={form.containerNo} onChange={(e) => setForm((v) => ({ ...v, containerNo: e.target.value }))} /></div>
              <div><label style={fl}>柜型 *</label>
                <select style={fi} value={form.containerType} onChange={(e) => setForm((v) => ({ ...v, containerType: e.target.value }))}>
                  <option value="40HQ">40HQ</option><option value="20GP">20GP</option>
                </select>
              </div>
              <div><label style={fl}>运输方式 *</label>
                <select style={fi} value={form.transportMode} onChange={(e) => setForm((v) => ({ ...v, transportMode: e.target.value }))}>
                  <option value="sea">海运</option><option value="land">陆运</option>
                </select>
              </div>
              <div><label style={fl}>仓库 *</label>
                <select style={fi} value={form.warehouseId} onChange={(e) => setForm((v) => ({ ...v, warehouseId: e.target.value }))}>
                  {WAREHOUSES.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
                </select>
              </div>
              <div><label style={fl}>装柜日期</label><input type="date" style={fi} value={form.loadingDate} onChange={(e) => setForm((v) => ({ ...v, loadingDate: e.target.value }))} /></div>
              <div><label style={fl}>金额 ¥（手填，客户能看到）</label><input style={fi} value={form.amountCny} onChange={(e) => setForm((v) => ({ ...v, amountCny: e.target.value }))} placeholder="不填就空着" /></div>
              <div style={{ gridColumn: "1 / -1" }}><label style={fl}>备注</label><input style={fi} value={form.remark} onChange={(e) => setForm((v) => ({ ...v, remark: e.target.value }))} /></div>
            </div>

            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
              <h4 style={{ fontSize: 14, margin: 0, flex: 1 }}>货物清单（{products.length} 行 · 合计 {totals.packageCount} 箱 / {totals.volumeM3} m³ / {totals.weightKg} kg）</h4>
              <button type="button" className="workbench-button" onClick={() => void downloadTemplate()}>下载模板</button>
              <button type="button" className="workbench-button" onClick={() => fileRef.current?.click()} disabled={parsing}>{parsing ? "读取中…" : "传表格"}</button>
              <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: "none" }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void onPickFile(f); }} />
              <button type="button" className="workbench-button" onClick={() => setProducts((p) => [...p, emptyRow()])}>+ 加一行</button>
            </div>
            <p style={{ fontSize: 12, color: "var(--t-muted)", marginTop: 0 }}>
              客户发来的表格必须用上面这个模板填，表头不能改 —— 每家写法不一样的表格系统读不了，那种要员工照模板抄一遍。
            </p>

            <div style={{ overflowX: "auto", marginBottom: 12 }}>
              <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr style={{ background: "var(--s-sunken)" }}>
                  <th style={th}>品名 *</th><th style={th}>箱数 *</th><th style={th}>每箱数量</th>
                  <th style={th}>长cm *</th><th style={th}>宽cm *</th><th style={th}>高cm *</th>
                  <th style={th}>单箱重kg</th><th style={th}>国内单号</th><th style={th}>货型</th>
                  <th style={th}>体积m³</th><th style={th}></th>
                </tr></thead>
                <tbody>
                  {products.map((r, i) => {
                    const pv = previewRow(r);
                    const setCell = (k: keyof FclProductInput, val: string) =>
                      setProducts((list) => list.map((x, idx) => (idx === i ? { ...x, [k]: val } : x)));
                    return (
                      <tr key={i}>
                        <td style={td}><input style={{ ...fi, minWidth: 110 }} value={String(r.itemName ?? "")} onChange={(e) => setCell("itemName", e.target.value)} /></td>
                        <td style={td}><input style={{ ...fi, width: 70 }} value={String(r.packageCount ?? "")} onChange={(e) => setCell("packageCount", e.target.value)} /></td>
                        <td style={td}><input style={{ ...fi, width: 70 }} value={String(r.quantityPerBox ?? "")} onChange={(e) => setCell("quantityPerBox", e.target.value)} /></td>
                        <td style={td}><input style={{ ...fi, width: 70 }} value={String(r.lengthCm ?? "")} onChange={(e) => setCell("lengthCm", e.target.value)} /></td>
                        <td style={td}><input style={{ ...fi, width: 70 }} value={String(r.widthCm ?? "")} onChange={(e) => setCell("widthCm", e.target.value)} /></td>
                        <td style={td}><input style={{ ...fi, width: 70 }} value={String(r.heightCm ?? "")} onChange={(e) => setCell("heightCm", e.target.value)} /></td>
                        <td style={td}><input style={{ ...fi, width: 80 }} value={String(r.unitWeightKg ?? "")} onChange={(e) => setCell("unitWeightKg", e.target.value)} /></td>
                        <td style={td}><input style={{ ...fi, width: 110 }} value={String(r.domesticTrackingNo ?? "")} onChange={(e) => setCell("domesticTrackingNo", e.target.value)} /></td>
                        <td style={td}>
                          <select style={{ ...fi, width: 95 }} value={String(r.cargoType ?? "normal")} onChange={(e) => setCell("cargoType", e.target.value)}>
                            <option value="normal">普货</option><option value="inspection">商检货</option><option value="sensitive">敏感货</option>
                          </select>
                        </td>
                        <td style={td}>{pv.volumeM3 || "—"}</td>
                        <td style={td}>
                          <button type="button" className="workbench-button"
                            onClick={() => setProducts((list) => (list.length === 1 ? [emptyRow()] : list.filter((_, idx) => idx !== i)))}>删</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <button type="button" className="workbench-button workbench-button--primary" onClick={() => void submitCreate()} disabled={submitting}>
                {submitting ? "提交中…" : "建整柜"}
              </button>
              <span style={{ fontSize: 12, color: "var(--t-muted)" }}>
                建完这个柜就是一个普通柜子，轨迹从「已装柜」起步；往后推状态去「装柜管理」。
              </span>
            </div>
            <p role="status" aria-live="polite" style={{ fontSize: 13 }}>{toast}</p>
          </div>
        </div>
      )}
    </div>
  );
}
