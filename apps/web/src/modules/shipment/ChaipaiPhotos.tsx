"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

  /*
   * 取原图走一条共用的队：全程最多 PARALLEL 张同时下，排过队 / 下着的不再排（10-12 Codex 审查：
   * 原来每点一次「再显示」就新起一批，连点几下会同时下好几张、还重复下同一张）。
   * 这个组件按运单号挂 key（换页签就是新组件），所以队不用跟着运单号清。
   */
  const mounted = useRef(true);
  /** 正在下的请求：关掉弹窗 / 切到别的页签时全部取消，别让旧的跟新的叠在一起（10-12 两家第 3 轮） */
  const inflight = useRef(new Set<AbortController>());
  // 开发模式（StrictMode）会挂上 → 卸下 → 再挂上一次，所以挂上时要设回 true
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const c of inflight.current) c.abort();
      inflight.current.clear();
    };
  }, []);
  const queue = useRef<string[]>([]);
  const queued = useRef(new Set<string>());
  const active = useRef(0);
  const pump = useCallback(() => {
    while (active.current < PARALLEL && queue.current.length > 0) {
      const photoId = queue.current.shift()!;
      active.current += 1;
      void (async () => {
        let thumb: Thumb;
        const controller = new AbortController();
        inflight.current.add(controller);
        try {
          const res = await fetch(
            `${apiBaseUrl()}/staff/shipments/chaipai-photo?trackingNo=${encodeURIComponent(trackingNo)}&photoId=${encodeURIComponent(photoId)}`,
            { headers: { ...authHeaders() }, signal: controller.signal },
          );
          if (res.status === 410) thumb = { error: "照片已过保留期" };
          else if (res.status === 404) thumb = { error: "照片已不存在" };
          else {
            const body = await parseApiResponse<{ contentType: string; dataBase64: string }>(res);
            thumb = { src: `data:${body.contentType};base64,${body.dataBase64}` };
          }
        } catch {
          thumb = { error: "暂时取不到" };
        } finally {
          inflight.current.delete(controller);
        }
        active.current -= 1;
        if (!mounted.current) return;
        setThumbs((prev) => ({ ...prev, [photoId]: thumb }));
        pump();
      })();
    }
  }, [trackingNo]);

  // 前 limit 张排进队（已经排过的跳过）
  const wanted = items.slice(0, limit);
  const wantedKey = wanted.map((p) => p.id).join(",");
  useEffect(() => {
    for (const p of wanted) {
      if (queued.current.has(p.id)) continue;
      queued.current.add(p.id);
      queue.current.push(p.id);
    }
    pump();
    // 只在要取的那批变了时排队
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedKey, pump]);
  /** 这一批还没下完时不给点「再显示」 */
  const batchLoading = wanted.some((p) => !thumbs[p.id]);

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
              disabled={batchLoading}
              onClick={() => setLimit((n) => n + PAGE)}
              style={{ marginTop: 6, fontSize: 12, padding: "4px 10px", borderRadius: 6, border: "1px solid var(--l-soft)", background: "var(--white)", color: "var(--t-body)", cursor: batchLoading ? "default" : "pointer", opacity: batchLoading ? 0.6 : 1 }}
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
