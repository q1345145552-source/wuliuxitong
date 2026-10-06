/**
 * 到货通知（2026-10-06）的接口。后端在 apps/api/src/modules/arrival-notices/routes.ts，规矩写在那边开头。
 * ⚠️ 网址都比页面 /staff/arrival-notices 多一段（/list、/save…）：Next 先匹配页面再转发接口，
 *    GET /staff/arrival-notices 会被页面接走。
 */
import { apiBaseUrl, apiRequest } from "./core-api";
import type { UploadImage } from "../modules/shared/image-compress";

export type ArrivalNoticeTab = "todo" | "notified" | "inbound" | "formal" | "all";

export interface ArrivalNoticeImage {
  id: string;
  fileName: string;
  /** /images/xxx.jpg */
  imageUrl: string;
}

export interface ArrivalNotice {
  id: string;
  clientId: string | null;
  trackingNo: string | null;
  itemName: string | null;
  packageCount: number | null;
  weightKg: number | null;
  volumeM3: number | null;
  transportMode: string | null;
  domesticTrackingNo: string | null;
  warehouseId: string | null;
  /** YYYY-MM-DD */
  arrivedAt: string | null;
  remark: string | null;
  notifiedAt: string | null;
  notifiedByName: string | null;
  /** 空 = 还没转；inbound = 待入库；formal = 正式运单 */
  convertedTo: "inbound" | "formal" | null;
  shipmentId: string | null;
  /** 转出去那张运单现在的状态（pendingInbound / inWarehouseCN / 后面的…） */
  shipmentStatus: string | null;
  /** 转过、但那张运单已经在「运单管理」里被删了（可以重新转） */
  shipmentGone: boolean;
  convertedAt: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  images: ArrivalNoticeImage[];
}

export interface ArrivalNoticePage {
  items: ArrivalNotice[];
  total: number;
  page: number;
  pageSize: number;
  counts: Record<ArrivalNoticeTab, number>;
}

/** 登记 / 修改时填的那几项（空串 = 没填） */
export interface ArrivalNoticeDraft {
  clientId: string;
  trackingNo: string;
  itemName: string;
  packageCount: string;
  weightKg: string;
  volumeM3: string;
  transportMode: "" | "sea" | "land";
  domesticTrackingNo: string;
  warehouseId: string;
  arrivedAt: string;
  remark: string;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

function post<T>(path: string, body: unknown): Promise<T> {
  return apiRequest<T>(`${apiBaseUrl()}${path}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
}

export function fetchArrivalNotices(opts: { tab: ArrivalNoticeTab; keyword?: string; page?: number; pageSize?: number }): Promise<ArrivalNoticePage> {
  const q = new URLSearchParams({ tab: opts.tab });
  if (opts.keyword?.trim()) q.set("keyword", opts.keyword.trim());
  if (opts.page) q.set("page", String(opts.page));
  if (opts.pageSize) q.set("pageSize", String(opts.pageSize));
  return apiRequest<ArrivalNoticePage>(`${apiBaseUrl()}/staff/arrival-notices/list?${q.toString()}`);
}

/** 草稿 → 接口要的样子：空串当没填（null），数字框原样传文字，后端严格校验 */
export function draftToBody(d: ArrivalNoticeDraft): Record<string, string | null> {
  const v = (s: string) => (s.trim() === "" ? null : s.trim());
  return {
    // 唛头不去空格：有「XPP-0015 XHH-6698」这种带空格的账号（同「创建订单」的唛头框）
    clientId: d.clientId.trim() === "" ? null : d.clientId,
    trackingNo: v(d.trackingNo),
    itemName: v(d.itemName),
    packageCount: v(d.packageCount),
    weightKg: v(d.weightKg),
    volumeM3: v(d.volumeM3),
    transportMode: d.transportMode || null,
    domesticTrackingNo: v(d.domesticTrackingNo),
    warehouseId: d.warehouseId || null,
    arrivedAt: v(d.arrivedAt),
    remark: v(d.remark),
  };
}

/**
 * base = 打开「修改」弹窗那一刻看到的资料（新登记不传）。后端拿它跟库里现在的比，
 * 有人在这期间改过就不存、告诉他重开（防两个人同时改、后存的把先存的盖掉）。
 */
export function saveArrivalNotice(id: string | null, draft: ArrivalNoticeDraft, base?: ArrivalNoticeDraft | null): Promise<{ item: ArrivalNotice }> {
  return post("/staff/arrival-notices/save", { ...(id ? { id } : {}), ...draftToBody(draft), ...(id && base ? { base: draftToBody(base) } : {}) });
}

export function setArrivalNoticeNotified(id: string, notified: boolean): Promise<{ item: ArrivalNotice }> {
  return post("/staff/arrival-notices/notify", { id, notified });
}

export function convertArrivalNotice(id: string, to: "formal" | "inbound"): Promise<{ item: ArrivalNotice }> {
  return post("/staff/arrival-notices/convert", { id, to });
}

export function deleteArrivalNotice(id: string): Promise<{ deleted: boolean; id: string }> {
  return post("/staff/arrival-notices/delete", { id });
}

export function uploadArrivalNoticeImage(noticeId: string, image: UploadImage): Promise<{ item: ArrivalNotice }> {
  return post("/staff/arrival-notices/images", { noticeId, fileName: image.fileName, mime: image.mime, contentBase64: image.base64 });
}

export function deleteArrivalNoticeImage(imageId: string): Promise<{ item: ArrivalNotice }> {
  return post("/staff/arrival-notices/images/delete", { id: imageId });
}
