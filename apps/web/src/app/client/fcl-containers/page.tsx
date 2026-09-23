"use client";

/**
 * 客户端「我的整柜」（2026-09-23）。
 *
 * 老板定的：客户**只能看**，不能建（整柜是我们跟客户谈好之后在内部端建的）。
 * ⚠️ 这一页**不许出现柜号** —— 后端那两个 /client/fcl-containers 接口就没返回它
 *    （客户不能看到柜号，2026-08-07 定，2026-09-23 复述过）。
 * 金额是老板 2026-09-23 定的：钱线下走，但这个手填的数客户能看到（只在这一页，
 * 普通运单那边照旧不显示）。
 */
import { useCallback, useEffect, useState } from "react";
import {
  fetchMyFclContainers,
  fetchMyFclContainerDetail,
  type FclContainerRow,
  type FclContainerDetail,
} from "../../../services/business-api";
import { shipmentStatusZh, CLIENT_STATUS_ZH_OVERRIDES } from "../../../modules/shipment/shipment-status";
import { formatBeijingTime } from "../../../modules/staff/utils";
import EmptyStateCard from "../../../modules/layout/EmptyStateCard";

const CARGO_TYPE_ZH: Record<string, string> = { normal: "普货", inspection: "商检货", sensitive: "敏感货" };

const card: React.CSSProperties = { background: "var(--white)", border: "1px solid var(--l-soft)", borderRadius: 10, padding: 16, marginBottom: 16 };
const fl: React.CSSProperties = { display: "block", fontSize: 12, color: "var(--t-muted)", marginBottom: 4 };
const th: React.CSSProperties = { padding: "6px 8px", textAlign: "left", fontSize: 12, whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "5px 8px", fontSize: 12, borderTop: "1px solid var(--l-soft)" };

export default function ClientFclContainersPage() {
  const [rows, setRows] = useState<FclContainerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState("");
  const [listNote, setListNote] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<FclContainerDetail | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetchMyFclContainers();
      setRows(r.items ?? []);
      setListNote(r.truncated ? (r.note ?? "只显示最近 500 个整柜") : "");
    } catch (e) {
      setToast(`加载失败：${e instanceof Error ? e.message : "请稍后重试"}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openDetail = async (containerId: string) => {
    setSelectedId(containerId);
    setDetail(null);
    try {
      setDetail(await fetchMyFclContainerDetail(containerId));
    } catch (e) {
      setToast(`加载失败：${e instanceof Error ? e.message : "请稍后重试"}`);
      setSelectedId(null);
    }
  };

  if (selectedId) {
    return (
      <div style={{ maxWidth: "100%", padding: "20px 24px" }}>
        <button type="button" className="workbench-button" onClick={() => { setSelectedId(null); setDetail(null); }} style={{ marginBottom: 12 }}>← 返回</button>
        {!detail ? <EmptyStateCard title="正在加载" description="正在读这个整柜的货物清单和轨迹。" /> : (
          <>
            <div style={card}>
              <h2 style={{ fontSize: 20, margin: "0 0 12px 0", fontFamily: "monospace" }}>{detail.trackingNo ?? "—"}</h2>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 12 }}>
                {/* ⚠️ 这里没有「柜号」这一项，客户不能看柜号 */}
                <div><span style={fl}>柜型</span><div>{detail.containerType}</div></div>
                <div><span style={fl}>运输方式</span><div>{detail.transportMode === "land" ? "陆运" : "海运"}</div></div>
                <div><span style={fl}>装柜日期</span><div>{detail.loadingDate ? detail.loadingDate.slice(0, 10) : "—"}</div></div>
                <div><span style={fl}>总箱数</span><div>{detail.packageCount ?? "—"}</div></div>
                <div><span style={fl}>总体积 (m³)</span><div>{detail.volumeM3 ?? "—"}</div></div>
                <div><span style={fl}>总重 (kg)</span><div>{detail.weightKg ?? "—"}</div></div>
                <div><span style={fl}>金额 (¥)</span><div style={{ fontWeight: 600 }}>{detail.amountCny == null ? "—" : detail.amountCny.toLocaleString()}</div></div>
                <div><span style={fl}>当前状态</span><div style={{ fontWeight: 600 }}>{shipmentStatusZh(detail.shipmentStatus ?? undefined, CLIENT_STATUS_ZH_OVERRIDES)}</div></div>
              </div>
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
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{shipmentStatusZh(t.toStatus, CLIENT_STATUS_ZH_OVERRIDES)}</div>
                      <div style={{ fontSize: 12, color: "var(--t-muted)" }}>
                        {formatBeijingTime(t.changedAt)}{t.nextStop ? ` · 下一站：${t.nextStop}` : ""}
                      </div>
                      {t.remark && <div style={{ fontSize: 12, marginTop: 2 }}>{t.remark}</div>}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </>
        )}
        <p role="status" aria-live="polite" style={{ fontSize: 13 }}>{toast}</p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: "100%", padding: "20px 24px" }}>
      <h2 style={{ fontSize: 22, margin: "0 0 16px 0" }}>我的整柜</h2>
      {loading ? (
        <EmptyStateCard title="正在加载" description="正在读你的整柜。" />
      ) : rows.length === 0 ? (
        <EmptyStateCard title="还没有整柜" description="整柜由我们这边录入，录好之后你在这里就能看到货物清单和全程轨迹。" />
      ) : (
        <div style={card}>
          <div style={{ fontSize: 13, color: "var(--t-muted)", marginBottom: 8 }}>
            共 {rows.length} 个整柜
            {listNote && <span style={{ color: "var(--c-amber-deep)", marginLeft: 8 }}>· {listNote}</span>}
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr style={{ background: "var(--s-sunken)" }}>
                {/* ⚠️ 没有「柜号」这一列 */}
                <th style={th}>提单号</th><th style={th}>柜型</th><th style={th}>运输</th>
                <th style={th}>当前状态</th><th style={th}>箱数</th><th style={th}>体积m³</th>
                <th style={th}>金额¥</th><th style={th}>装柜日期</th><th style={th}></th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.containerId}>
                    <td style={{ ...td, fontFamily: "monospace" }}>{r.trackingNo ?? "—"}</td>
                    <td style={td}>{r.containerType}</td>
                    <td style={td}>{r.transportMode === "land" ? "陆运" : "海运"}</td>
                    <td style={td}>{shipmentStatusZh(r.shipmentStatus ?? undefined, CLIENT_STATUS_ZH_OVERRIDES)}</td>
                    <td style={td}>{r.packageCount ?? "—"}</td>
                    <td style={td}>{r.volumeM3 ?? "—"}</td>
                    <td style={td}>{r.amountCny == null ? "—" : r.amountCny.toLocaleString()}</td>
                    <td style={td}>{r.loadingDate ? r.loadingDate.slice(0, 10) : "—"}</td>
                    <td style={td}><button type="button" className="workbench-button" onClick={() => void openDetail(r.containerId)}>详情</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <p role="status" aria-live="polite" style={{ fontSize: 13 }}>{toast}</p>
    </div>
  );
}
