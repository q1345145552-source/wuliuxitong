import type { ChaipaiConfig } from "./config";

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
  /** 照片太多没翻完（超过 MAX_PHOTO_PAGES 页） */
  truncated: boolean;
}

export const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const MAX_PHOTO_PAGES = 10;

function str(v: unknown, max = 200): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}

async function getWithTimeout(url: string, secret: string, timeoutMs: number, accept: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: { Authorization: `Bearer ${secret}`, Accept: accept },
      redirect: "error",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function shipmentUrl(cfg: ChaipaiConfig, sourceShipmentId: string): string {
  return `${cfg.apiBase}/integrations/domestic/v2/shipments/${encodeURIComponent(sourceShipmentId)}`;
}

/** 取一票的详情（司机、车牌、转交、照片列表）。allPhotos=false 只看第一页 */
export async function fetchChaipaiDetail(
  cfg: ChaipaiConfig,
  sourceShipmentId: string,
  opts: { allPhotos: boolean; timeoutMs?: number },
): Promise<ReadResult<ChaipaiDetail>> {
  const timeoutMs = opts.timeoutMs ?? 4000;
  const photos: ChaipaiPhotoRef[] = [];
  let first: Record<string, unknown> | null = null;
  let cursor: string | null = null;
  let truncated = false;
  for (let page = 0; ; page++) {
    if (page >= MAX_PHOTO_PAGES) { truncated = true; break; }
    const url = shipmentUrl(cfg, sourceShipmentId) + (cursor ? `?afterPhoto=${encodeURIComponent(cursor)}` : "");
    let response: Response;
    try {
      response = await getWithTimeout(url, cfg.readSecret, timeoutMs, "application/json");
    } catch (error) {
      return { kind: "error", reason: error instanceof Error ? error.name : "network" };
    }
    if (response.status === 404) { await response.body?.cancel().catch(() => undefined); return { kind: "notFound" }; }
    if (response.status !== 200) { await response.body?.cancel().catch(() => undefined); return { kind: "error", reason: `HTTP ${response.status}` }; }
    let body: unknown;
    try { body = await response.json(); } catch { return { kind: "error", reason: "详情不是 JSON" }; }
    const data = (body as { data?: unknown } | null)?.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return { kind: "error", reason: "详情格式不对" };
    const d = data as Record<string, unknown>;
    if (!first) first = d;
    const list = (d.photos as { items?: unknown; nextCursor?: unknown } | undefined) ?? {};
    if (!Array.isArray(list.items)) return { kind: "error", reason: "照片列表格式不对" };
    for (const raw of list.items) {
      const id = str((raw as { id?: unknown })?.id, 128);
      const createdAt = str((raw as { createdAt?: unknown })?.createdAt, 64);
      if (id && createdAt) photos.push({ id, createdAt });
    }
    cursor = str(list.nextCursor, 128);
    if (!cursor || !opts.allPhotos) { truncated = !!cursor && opts.allPhotos; break; }
  }
  const r = (first?.route ?? null) as Record<string, unknown> | null;
  const h = (first?.handover ?? null) as Record<string, unknown> | null;
  const routeId = r ? str(r.id, 128) : null;
  const carrierName = h ? str(h.carrierName, 100) : null;
  return {
    kind: "ok",
    value: {
      route: routeId
        ? { id: routeId, driverName: str(r!.driverName, 100) ?? "", plateNo: str(r!.plateNo, 50) ?? "", departedAt: str(r!.departedAt, 64) }
        : null,
      handover: carrierName ? { carrierName, trackingNo: str(h!.trackingNo, 100) } : null,
      photos,
      truncated,
    },
  };
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
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${cfg.readSecret}`, Accept: "image/*" },
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      return { kind: "error", reason: error instanceof Error ? error.name : "network" };
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
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > PHOTO_MAX_BYTES) {
          controller.abort();
          await reader.cancel().catch(() => undefined);
          return { kind: "error", reason: "照片超过 10MiB" };
        }
        chunks.push(value);
      }
    } catch (error) {
      return { kind: "error", reason: error instanceof Error ? error.name : "读取中断" };
    } finally {
      reader.releaseLock();
    }
    if (size === 0) return { kind: "error", reason: "照片是空的" };
    return { kind: "ok", value: { contentType: type, bytes: Buffer.concat(chunks, size) } };
  } finally {
    clearTimeout(timer);
  }
}
