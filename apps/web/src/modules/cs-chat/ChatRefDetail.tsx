"use client";

import { useEffect, useState } from "react";
import DetailModal from "../layout/DetailModal";
import ShipmentDetailBody, { type ShipmentDetailData, type ShipmentDetailImage } from "../shipment/ShipmentDetailBody";
import { openShipmentTrack } from "../shipment/ShipmentTrackModal";
import { fetchClientOrderByTrackingNo, fetchShipmentImages, fetchStaffShipmentById } from "../../services/business-api";
import type { ChatRef } from "../../services/cs-chat-api";

/**
 * 客服对话里点运单卡片弹的「运单详情」（老板 2026-10-06：「客户点一下就会展示出运单详情」，拍板「1A，2 要」）。
 * - 内容跟「运单查询」里点开的一样（共用 ShipmentDetailBody），上面一个「物流轨迹」按钮；
 * - 客户那头按单号查自己的单（跟「运单查询」同一个接口，柜号之类不给客户看的后端已经处理）；
 * - 员工 / 超管那头按运单 id 查（跟「运单管理」同一个接口），基本信息前面多一格唛头。
 * 只读：要改去「运单管理」。
 */

type Loaded = { item: ShipmentDetailData; images: ShipmentDetailImage[]; mark?: string };
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

  useEffect(() => {
    let cancelled = false;
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
