import type { ChaipaiConfig } from "./config";
import { fetchWithDeadline, readBodyWithDeadline } from "../core/fetch-deadline";

/**
 * 湘泰后台去拆派仓只读接口取资料（2026-10-12）。密钥只在后台用，不下发浏览器。
 *
 * 照拆派仓 integrations/domestic/domestic-read.{controller,service}.ts：
 *   详情 GET {base}/integrations/domestic/v2/shipments/{id}[?afterPhoto=<游标>]
 *     → 200 {code:"OK", data:{ route:{id,driverName,plateNo,departedAt}|null, handover:{carrierName,trackingNo}|null,
 *                              photos:{items:[{id,createdAt}], nextCursor} }}
 *     照片按 id 升序（不是按时间），每页最多 20，nextCursor 不为空就接着翻；没照片是 200 + 空列表；
 *     404 = 拆派仓没这票或不在只读范围（代理的票、清单外登记的票……）
 *   单张 GET …/photos/{photoId} → 200 图片本身（只会是 jpeg / png，最大 10MiB）；404 没这张；410 过了保留期或已清理
 * 一律不跟随跳转、带超时；拆派仓生产环境所有 5xx 文案都一样，分不清原因，统一当「暂时取不到」。
 */

export type ReadResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "notFound" }
  | { kind: "gone" }
  | { kind: "error"; reason: string };

export interface ChaipaiPhotoRef { id: string; createdAt: string }

export interface ChaipaiDetail {
  route: { id: string; driverName: string; plateNo: string; departedAt: string | null } | null;
  handover: { carrierName: string; trackingNo: string | null } | null;
  photos: ChaipaiPhotoRef[];
  /** 照片太多没翻完（超过调用方给的页数）；签收挑图见到它必须当失败 */
  truncated: boolean;
}

export const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
/** 详情一页 JSON 的上限（20 张照片的 id + 时间，正常几 KB） */
const DETAIL_MAX_BYTES = 1024 * 1024;

function str(v: unknown, max = 200): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}

/** 认得出来的时间才要（拆派仓正常给 ISO；认不出就当没有，别让后面算日期时炸掉） */
function timeText(v: unknown): string | null {
  const t = str(v, 64);
  return t && Number.isFinite(Date.parse(t)) ? t : null;
}

function shipmentUrl(cfg: ChaipaiConfig, sourceShipmentId: string): string {
  return `${cfg.apiBase}/integrations/domestic/v2/shipments/${encodeURIComponent(sourceShipmentId)}`;
}

/**
 * 取一票的详情（司机、车牌、转交、照片列表）。
 * ⚠️ 整个调用（翻的每一页、连同读响应体）共用一个截止时间：拆派仓先回头再迟迟不发完内容，也会按时断开
 *（10-12 Codex 审查：原来计时器在 fetch 返回后就清了，读 JSON 那一步不受控）。
 * ⚠️ 等头、读 body 都走 core/fetch-deadline.ts（跟我们自己的 signal 赛跑）：Node 22 的 fetch 带 redirect:"error" 时，
 *   读 body 中途碰上一次垃圾回收，abort() 就不再收尾响应体，直接 await reader.read() 会挂到 300 秒（10-12 CI 的 V9，10-14 查清）。
 * maxPages：最多翻几页（每页 20 张）；翻不完 truncated=true，签收挑图的调用方见到 truncated 必须当失败。
 */
export async function fetchChaipaiDetail(
  cfg: ChaipaiConfig,
  sourceShipmentId: string,
  opts: { maxPages: number; timeoutMs?: number },
): Promise<ReadResult<ChaipaiDetail>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 6000);
  try {
    const photos: ChaipaiPhotoRef[] = [];
    let first: Record<string, unknown> | null = null;
    let cursor: string | null = null;
    let truncated = false;
    for (let page = 0; ; page++) {
      if (page >= opts.maxPages) { truncated = true; break; }
      const url = shipmentUrl(cfg, sourceShipmentId) + (cursor ? `?afterPhoto=${encodeURIComponent(cursor)}` : "");
      let body: Buffer | null;
      try {
        const response = await fetchWithDeadline(url, {
          headers: { Authorization: `Bearer ${cfg.readSecret}`, Accept: "application/json" },
          redirect: "error",
          signal: controller.signal,
        });
        if (response.status === 404) { await response.body?.cancel().catch(() => undefined); return { kind: "notFound" }; }
        if (response.status !== 200) { await response.body?.cancel().catch(() => undefined); return { kind: "error", reason: `HTTP ${response.status}` }; }
        body = await readBodyWithDeadline(response, controller.signal, DETAIL_MAX_BYTES);
      } catch (error) {
        return { kind: "error", reason: controller.signal.aborted ? "超时" : error instanceof Error ? error.name : "network" };
      }
      if (!body) return { kind: "error", reason: "详情太大" };
      let parsed: unknown;
      try { parsed = JSON.parse(body.toString("utf8")); } catch { return { kind: "error", reason: "详情不是 JSON" }; }
      const data = (parsed as { data?: unknown } | null)?.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) return { kind: "error", reason: "详情格式不对" };
      const d = data as Record<string, unknown>;
      if (!first) first = d;
      const list = (d.photos as { items?: unknown; nextCursor?: unknown } | undefined) ?? {};
      if (!Array.isArray(list.items)) return { kind: "error", reason: "照片列表格式不对" };
      for (const raw of list.items) {
        const id = str((raw as { id?: unknown })?.id, 128);
        const createdAt = timeText((raw as { createdAt?: unknown })?.createdAt);
        if (id && createdAt) photos.push({ id, createdAt });
      }
      cursor = str(list.nextCursor, 128);
      if (!cursor) break;
    }
    const r = (first?.route ?? null) as Record<string, unknown> | null;
    const h = (first?.handover ?? null) as Record<string, unknown> | null;
    const routeId = r ? str(r.id, 128) : null;
    const carrierName = h ? str(h.carrierName, 100) : null;
    return {
      kind: "ok",
      value: {
        route: routeId
          ? { id: routeId, driverName: str(r!.driverName, 100) ?? "", plateNo: str(r!.plateNo, 50) ?? "", departedAt: timeText(r!.departedAt) }
          : null,
        handover: carrierName ? { carrierName, trackingNo: str(h!.trackingNo, 100) } : null,
        photos,
        truncated,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 取一张照片的原图（边读边数字节，超过 10MiB 就断） */
export async function fetchChaipaiPhoto(
  cfg: ChaipaiConfig,
  sourceShipmentId: string,
  photoId: string,
  opts: { timeoutMs?: number } = {},
): Promise<ReadResult<{ contentType: "image/jpeg" | "image/png"; bytes: Buffer }>> {
  const url = `${shipmentUrl(cfg, sourceShipmentId)}/photos/${encodeURIComponent(photoId)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
  try {
    let response: Response;
    try {
      response = await fetchWithDeadline(url, {
        headers: { Authorization: `Bearer ${cfg.readSecret}`, Accept: "image/*" },
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      return { kind: "error", reason: controller.signal.aborted ? "超时" : error instanceof Error ? error.name : "network" };
    }
    if (response.status === 404) { await response.body?.cancel().catch(() => undefined); return { kind: "notFound" }; }
    if (response.status === 410) { await response.body?.cancel().catch(() => undefined); return { kind: "gone" }; }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: "error", reason: `HTTP ${response.status}` };
    }
    const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (type !== "image/jpeg" && type !== "image/png") {
      await response.body.cancel().catch(() => undefined);
      return { kind: "error", reason: "照片类型不对" };
    }
    let bytes: Buffer | null;
    try {
      bytes = await readBodyWithDeadline(response, controller.signal, PHOTO_MAX_BYTES);
    } catch {
      return { kind: "error", reason: controller.signal.aborted ? "超时" : "读取中断" };
    }
    if (!bytes) return { kind: "error", reason: "照片超过 10MiB" };
    if (bytes.length === 0) return { kind: "error", reason: "照片是空的" };
    return { kind: "ok", value: { contentType: type, bytes } };
  } finally {
    clearTimeout(timer);
  }
}
