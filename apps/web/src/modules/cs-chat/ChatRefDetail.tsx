"use client";

import { useEffect, useState } from "react";
import DetailModal from "../layout/DetailModal";
import ShipmentDetailBody, { type ShipmentDetailData, type ShipmentDetailImage } from "../shipment/ShipmentDetailBody";
import { openShipmentTrack } from "../shipment/ShipmentTrackModal";
import { CLIENT_STATUS_ZH_OVERRIDES, shipmentStatusZh } from "../shipment/shipment-status";
import { formatTime } from "../shipment/track-time";
import { fetchClientOrderByTrackingNo, fetchShipmentImages, fetchShipmentTrackBrief, fetchStaffShipmentById, type ShipmentTrackBrief } from "../../services/business-api";
import type { ChatRef } from "../../services/cs-chat-api";

/**
 * 客服对话里点运单卡片弹的「运单详情」（老板 2026-10-06：「客户点一下就会展示出运单详情」，拍板「1A，2 要」）。
 * - 最上面写「当前状态 + 最新一条动态（什么时候、到哪、下一站）」（老板 2026-10-06「状态没有吗？或货物到哪了？」→「加」），
 *   数据跟「物流轨迹」弹窗同一个接口，两处说法一致；想看完整过程点「查看物流轨迹」；
 * - 下面内容跟「运单查询」里点开的一样（共用 ShipmentDetailBody）；
 * - 客户那头按单号查自己的单（跟「运单查询」同一个接口，柜号之类不给客户看的后端已经处理）；
 * - 员工 / 超管那头按运单 id 查（跟「运单管理」同一个接口），基本信息前面多一格唛头。
 * 只读：要改去「运单管理」。
 */

type Loaded = { item: ShipmentDetailData & { currentStatus?: string | null }; images: ShipmentDetailImage[]; mark?: string };
type State =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "error"; text: string }
  | { kind: "ok"; data: Loaded };

export default function ChatRefDetail({ chatRef, forClient, onClose }: {
  chatRef: ChatRef;
  /** 客户那头（true）还是员工 / 超管那头 */
  forClient: boolean;
  onClose: () => void;
}) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [preview, setPreview] = useState<{ src: string; alt: string } | null>(null);
  /** 「当前状态 + 最新动态」：跟详情分开取，没取到不挡详情（只是少了最新动态那一句，状态退回用运单自己的） */
  const [track, setTrack] = useState<ShipmentTrackBrief | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTrack(null);
    void fetchShipmentTrackBrief(chatRef.no)
      .then((brief) => { if (!cancelled) setTrack(brief); })
      .catch(() => undefined);
    setState({ kind: "loading" });
    void (async () => {
      try {
        if (forClient) {
          const item = await fetchClientOrderByTrackingNo(chatRef.no);
          if (!item) { if (!cancelled) setState({ kind: "missing" }); return; }
          // 产品图跟「运单查询」一样单独取；图没取到不挡详情
          const images = await fetchShipmentImages(item.id).catch(() => []);
          if (!cancelled) setState({ kind: "ok", data: { item, images } });
        } else {
          const item = await fetchStaffShipmentById(chatRef.id);
          if (!item) { if (!cancelled) setState({ kind: "missing" }); return; }
          const images = item.orderId ? await fetchShipmentImages(item.orderId).catch(() => []) : [];
          if (!cancelled) setState({ kind: "ok", data: { item, images, mark: item.clientId } });
        }
      } catch (error) {
        if (!cancelled) setState({ kind: "error", text: error instanceof Error ? error.message : "请稍后再试" });
      }
    })();
    return () => { cancelled = true; };
  }, [chatRef.id, chatRef.no, forClient, attempt]);

  const trackingNo = state.kind === "ok" ? state.data.item.trackingNo : null;
  // 客户那头叫法跟客户别的页面一样（delivered 叫「已签收」），跟气泡里那张卡片同一套
  const zh = (status: string) => shipmentStatusZh(status, forClient ? CLIENT_STATUS_ZH_OVERRIDES : undefined);
  const nowStatus = track?.currentStatus || (state.kind === "ok" ? state.data.item.currentStatus : null) || null;
  const latest = track && track.timeline.length > 0 ? track.timeline[track.timeline.length - 1] : null;
  // 备注跟状态说的是同一件事就只写状态（跟物流轨迹弹窗一个规矩）
  const latestText = latest ? (latest.remark && latest.remark !== zh(latest.toStatus) ? latest.remark : zh(latest.toStatus)) : "";

  return (
    <>
      <DetailModal title="运单详情" subtitle={chatRef.no} onClose={onClose}>
        {state.kind === "loading" ? <p style={{ margin: 0, color: "var(--t-muted)", fontSize: 13 }}>正在取这票货的详情…</p> : null}
        {state.kind === "missing" ? (
          <p style={{ margin: 0, color: "var(--t-muted)", fontSize: 13 }}>没找到这票货：可能已经删了，或者已经不在这个账号名下。</p>
        ) : null}
        {state.kind === "error" ? (
          <p role="alert" style={{ margin: 0, color: "var(--c-red-deep)", fontSize: 13 }}>
            详情没取到：{state.text}{" "}
            <button type="button" className="chat-ref-detail-retry" onClick={() => setAttempt((n) => n + 1)}>重试</button>
          </p>
        ) : null}
        {state.kind === "ok" ? (
          <>
            {nowStatus ? (
              <div className="chat-ref-detail-now" style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12, color: "var(--t-faint)", marginBottom: 2 }}>当前状态</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: "var(--t-heading)" }}>
                  {zh(nowStatus)}
                  {track?.partialAhead ? <span style={{ fontSize: 13, fontWeight: 500, color: "var(--t-muted)" }}>（部分{zh(track.partialAhead)}）</span> : null}
                </div>
                {latest ? (
                  <div className="chat-ref-detail-latest" style={{ marginTop: 4, fontSize: 13, color: "var(--t-body)", lineHeight: 1.6 }}>
                    最新动态：{formatTime(latest.changedAt)}　{latestText}{latest.nextStop ? `　下一站【${latest.nextStop}】` : ""}
                  </div>
                ) : null}
              </div>
            ) : null}
            {trackingNo ? (
              <div style={{ marginBottom: 14 }}>
                <button type="button" className="chat-ref-detail-track" onClick={() => openShipmentTrack({ trackingNo })}>查看物流轨迹</button>
              </div>
            ) : null}
            <ShipmentDetailBody
              item={state.data.item}
              images={state.data.images}
              onPreview={(src, alt) => setPreview({ src, alt })}
              extraFields={forClient ? [] : [{ label: "唛头", value: state.data.mark || "—" }]}
            />
          </>
        ) : null}
      </DetailModal>
      {preview ? (
        <div role="dialog" aria-label="产品大图" onClick={() => setPreview(null)}
          style={{ position: "fixed", inset: 0, zIndex: 10001, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "rgba(0,0,0,0.75)", cursor: "zoom-out" }}>
          <img src={preview.src} alt={preview.alt} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
        </div>
      ) : null}
    </>
  );
}
