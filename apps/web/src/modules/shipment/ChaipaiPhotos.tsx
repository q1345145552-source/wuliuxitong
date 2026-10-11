"use client";

import { useEffect, useState } from "react";
import { authHeaders, apiBaseUrl, parseApiResponse, fetchWithSession as fetch } from "../../services/core-api";
import { formatTime } from "./track-time";

/**
 * 「派送照片」（2026-10-12 对接拆派仓）：拆派仓这票的全部照片 —— 员工到仓拍的、转交时传的、司机签收拍的混在一起
 * （拆派仓不分种类）。老板第 256 条：只给员工看，所以轨迹弹窗只在员工 / 管理员打开时挂这一块；
 * 客户看的签收单是「派送信息」里那张（自动登记尾端派送单时放进去的）。
 *
 * 没经过拆派仓的票（后端回 none / disabled）整块不显示；拆派仓暂时连不上只写一行灰字，不影响弹窗别的内容。
 */

type ListState = "loading" | "ok" | "none" | "disabled" | "unavailable";
interface PhotoRef { id: string; createdAt: string }
type Thumb = { src: string } | { error: string };

/** 同时最多取 2 张（单张最大 10MB，别一下子把带宽占满） */
const PARALLEL = 2;
/** 一次只自动取这么多张原图，多的点「再显示」才取（10-12 Codex 审查：一票照片多时别一打开就全下） */
const PAGE = 12;

export function ChaipaiPhotos({ trackingNo, onZoom }: { trackingNo: string; onZoom: (src: string) => void }) {
  const [state, setState] = useState<ListState>("loading");
  const [items, setItems] = useState<PhotoRef[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [thumbs, setThumbs] = useState<Record<string, Thumb>>({});
  const [limit, setLimit] = useState(PAGE);

  useEffect(() => {
    let alive = true;
    setState("loading");
    setItems([]);
    setThumbs({});
    setLimit(PAGE);
    void (async () => {
      try {
        const res = await fetch(`${apiBaseUrl()}/staff/shipments/chaipai-photos?trackingNo=${encodeURIComponent(trackingNo)}`, {
          headers: { ...authHeaders() },
        });
        const body = await parseApiResponse<{ state: ListState; items: PhotoRef[]; truncated: boolean }>(res);
        if (!alive) return;
        setItems(body.items ?? []);
        setTruncated(!!body.truncated);
        setState(body.state);
      } catch {
        if (alive) setState("unavailable");
      }
    })();
    return () => { alive = false; };
  }, [trackingNo]);

  // 取前 limit 张的原图（已经取过的不再取）
  const wanted = items.slice(0, limit);
  const wantedKey = wanted.map((p) => p.id).join(",");
  useEffect(() => {
    if (wanted.length === 0) return;
    let alive = true;
    const todo = wanted.filter((p) => !thumbs[p.id]);
    let next = 0;
    const worker = async () => {
      while (alive && next < todo.length) {
        const photo = todo[next++];
        let thumb: Thumb;
        try {
          const res = await fetch(
            `${apiBaseUrl()}/staff/shipments/chaipai-photo?trackingNo=${encodeURIComponent(trackingNo)}&photoId=${encodeURIComponent(photo.id)}`,
            { headers: { ...authHeaders() } },
          );
          if (res.status === 410) thumb = { error: "照片已过保留期" };
          else if (res.status === 404) thumb = { error: "照片已不存在" };
          else {
            const body = await parseApiResponse<{ contentType: string; dataBase64: string }>(res);
            thumb = { src: `data:${body.contentType};base64,${body.dataBase64}` };
          }
        } catch {
          thumb = { error: "暂时取不到" };
        }
        if (!alive) return;
        setThumbs((prev) => ({ ...prev, [photo.id]: thumb }));
      }
    };
    void Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, worker));
    return () => { alive = false; };
    // 只在要取的那批变了时重跑（thumbs 变化不触发，避免取完一张又从头扫）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackingNo, wantedKey]);

  if (state === "loading" || state === "none" || state === "disabled") return null;

  return (
    <div style={{ marginBottom: 14, fontSize: 13, color: "var(--t-muted)" }}>
      <div style={{ fontWeight: 600, color: "var(--t-body)", marginBottom: 4 }}>
        派送照片<span style={{ fontWeight: 400, fontSize: 12, color: "var(--t-faint)", marginLeft: 6 }}>只有员工看得到</span>
      </div>
      {state === "unavailable" ? (
        <div style={{ fontSize: 12, color: "var(--t-faint)" }}>暂时取不到照片</div>
      ) : (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {wanted.map((photo) => {
              const thumb = thumbs[photo.id];
              return (
                <div key={photo.id} style={{ width: 96 }}>
                  {thumb && "src" in thumb ? (
                    <img
                      src={thumb.src}
                      alt="派送照片"
                      title="点击查看大图"
                      onClick={() => onZoom(thumb.src)}
                      style={{ width: 96, height: 96, objectFit: "cover", borderRadius: 6, border: "1px solid var(--l-soft)", cursor: "zoom-in", display: "block" }}
                    />
                  ) : (
                    <div style={{ width: 96, height: 96, borderRadius: 6, border: "1px dashed var(--l-soft)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "var(--t-faint)", textAlign: "center", padding: 4, boxSizing: "border-box" }}>
                      {thumb && "error" in thumb ? thumb.error : "加载中…"}
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: "var(--t-faint)", marginTop: 2 }}>{formatTime(photo.createdAt)}</div>
                </div>
              );
            })}
          </div>
          {items.length > limit ? (
            <button
              type="button"
              onClick={() => setLimit((n) => n + PAGE)}
              style={{ marginTop: 6, fontSize: 12, padding: "4px 10px", borderRadius: 6, border: "1px solid var(--l-soft)", background: "var(--white)", color: "var(--t-body)", cursor: "pointer" }}
            >
              再显示 {Math.min(PAGE, items.length - limit)} 张（还有 {items.length - limit} 张）
            </button>
          ) : null}
          {truncated ? <div style={{ fontSize: 12, color: "var(--t-faint)", marginTop: 4 }}>照片太多，只列出了前 {items.length} 张</div> : null}
        </>
      )}
    </div>
  );
}
