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
import { useCallback, useEffect, useRef, useState } from "react";
import { amount2 } from "../../../modules/shared/money-format";
import {
  fetchMyFclContainers,
  fetchMyFclContainerDetail,
  type FclContainerRow,
  type FclContainerDetail,
} from "../../../services/business-api";
import { shipmentStatusZh, CLIENT_STATUS_ZH_OVERRIDES } from "../../../modules/shipment/shipment-status";
import { formatBeijingTime } from "../../../modules/staff/utils";
import EmptyStateCard from "../../../modules/layout/EmptyStateCard";
import { beijingDate } from "../../../modules/shared/beijing-date";
import { useLiveRefresh } from "../../../modules/realtime/useRealtime";

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

  /** silent：有变化时悄悄重拉（2026-10-05 实时推送）——不开「加载中」、失败不弹提示 */
  const load = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    if (!silent) setLoading(true);
    try {
      const r = await fetchMyFclContainers();
      setRows(r.items ?? []);
      setListNote(r.truncated ? (r.note ?? "只显示最近 500 个整柜") : "");
    } catch (e) {
      if (!silent) setToast(`加载失败：${e instanceof Error ? e.message : "请稍后重试"}`);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /* 认主人（2026-09-29 Codex 全系统检查）：点开 A、没等回来就返回再点 B，
     B 先回来、A 后回来 —— 原来 A 会把 B 盖掉，客户选的是 B 看到的是 A 的货和金额。
     每次点开领一个号，回来时号不是最新的就整个丢掉（报错也不提示、不清掉新的选择）。 */
  const detailSeqRef = useRef(0);
  const openDetail = async (containerId: string) => {
    const seq = ++detailSeqRef.current;
    setSelectedId(containerId);
    setDetail(null);
    try {
      const d = await fetchMyFclContainerDetail(containerId);
      if (seq !== detailSeqRef.current) return;
      setDetail(d);
    } catch (e) {
      if (seq !== detailSeqRef.current) return;
      setToast(`加载失败：${e instanceof Error ? e.message : "请稍后重试"}`);
      setSelectedId(null);
    }
  };

  /* 实时更新（2026-10-05 老板：「不能有延迟」）：整柜状态、派送、签收有变化，服务器马上推过来，
     列表和正开着的详情悄悄重拉 —— 详情不清空（清空会闪「正在加载」），领号认主人跟 openDetail 同一套。 */
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const detailRef = useRef(detail);
  detailRef.current = detail;
  useLiveRefresh({
    topics: ["fcl", "shipping"],
    refresh: async () => {
      const openId = selectedIdRef.current;
      const detailTask = (async () => {
        // 详情还没出来 = openDetail 正在拉：别领号把它作废（作废了它、自己又认不上主人，就会一直「正在加载」）
        if (!openId || !detailRef.current) return;
        const seq = ++detailSeqRef.current;
        try {
          const d = await fetchMyFclContainerDetail(openId);
          if (seq === detailSeqRef.current && selectedIdRef.current === openId) setDetail(d);
        } catch { /* 悄悄重拉失败：接着显示手上的 */ }
      })();
      await Promise.all([load({ silent: true }), detailTask]);
    },
  });

  if (selectedId) {
    return (
      <div style={{ maxWidth: "100%", padding: "20px 24px" }}>
        <button type="button" className="workbench-button" onClick={() => { detailSeqRef.current += 1; setSelectedId(null); setDetail(null); }} style={{ marginBottom: 12 }}>← 返回</button>
        {!detail ? <EmptyStateCard title="正在加载" description="正在读这个整柜的货物清单和轨迹。" /> : (
          <>
            <div style={card}>
              <h2 style={{ fontSize: 20, margin: "0 0 12px 0", fontFamily: "monospace" }}>{detail.trackingNo ?? "—"}</h2>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 12 }}>
                {/* ⚠️ 这里没有「柜号」这一项，客户不能看柜号 */}
                <div><span style={fl}>柜型</span><div>{detail.containerType}</div></div>
                <div><span style={fl}>运输方式</span><div>{detail.transportMode === "land" ? "陆运" : "海运"}</div></div>
                <div><span style={fl}>装柜日期</span><div>{detail.loadingDate ? beijingDate(detail.loadingDate) : "—"}</div></div>
                <div><span style={fl}>总箱数</span><div>{detail.packageCount ?? "—"}</div></div>
                <div><span style={fl}>总体积 (m³)</span><div>{detail.volumeM3 ?? "—"}</div></div>
                <div><span style={fl}>总重 (kg)</span><div>{detail.weightKg ?? "—"}</div></div>
                <div><span style={fl}>金额 (¥)</span><div style={{ fontWeight: 600 }}>{amount2(detail.amountCny)}</div></div>
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
                    <td style={td}>{amount2(r.amountCny)}</td>
                    <td style={td}>{r.loadingDate ? beijingDate(r.loadingDate) : "—"}</td>
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
