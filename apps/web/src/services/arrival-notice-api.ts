/**
 * 到货通知（2026-10-06）的接口。后端在 apps/api/src/modules/arrival-notices/routes.ts，规矩写在那边开头。
 * ⚠️ 网址都比页面 /staff/arrival-notices 多一段（/list、/save…）：Next 先匹配页面再转发接口，
 *    GET /staff/arrival-notices 会被页面接走。
 */
import { apiBaseUrl, apiRequest } from "./core-api";
import type { UploadImage } from "../modules/shared/image-compress";
import type { CargoType } from "../../../../packages/shared-types/cargo-type";

export type ArrivalNoticeTab = "todo" | "notified" | "inbound" | "formal" | "all";

export interface ArrivalNoticeImage {
  id: string;
  fileName: string;
  /** /images/xxx.jpg（原图：点开大图、复制、保存用这个） */
  imageUrl: string;
  /** 小图（G03，卡片 / 修改弹窗的小方块用）。没有小图时后端给的就是 imageUrl；老后端不回 = undefined，用 `thumbUrl ?? imageUrl` */
  thumbUrl?: string;
}

/**
 * 同一个国内快递单号，客户报过的预报单（F01，2026-10-08）。
 * 有预报单的货该在「预报单审核」点「确认收货」，在到货通知里再转就是第二张运单 —— 卡片上提醒，转运单要在确认框里点确定。
 */
export interface PrealertMatch {
  /** 订单 id：转运单确认时回传给后端（acknowledgedPrealertIds） */
  orderId: string;
  /** 预报单的运单号（YWYB…）；老数据没有运单时是订单号 */
  trackingNo: string | null;
  /** 预报单的唛头（可能跟这条到货通知的不一样） */
  clientId: string;
  /** 撞上的那个国内单号（已大写） */
  domesticTrackingNo: string;
  /** true = 那张预报单已经在「预报单审核」确认收货了 */
  received: boolean;
}

export interface ArrivalNotice {
  id: string;
  clientId: string | null;
  /** 转过单、运单还在：运单**现在**的号（「运单管理」里可能改过，F06）；没转 / 运单被删了：登记的号 */
  trackingNo: string | null;
  itemName: string | null;
  packageCount: number | null;
  weightKg: number | null;
  volumeM3: number | null;
  transportMode: string | null;
  /** 货型（F11）：null = 普货；只会是 "inspection" | "sensitive" | null。老后端不回 = undefined，按普货显示 */
  cargoType?: string | null;
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
  /** 撞上的客户预报单（F01）；空数组 = 没撞上。老后端不回 = undefined，读的时候一律 `?? []` */
  prealertMatches?: PrealertMatch[];
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
  /** 货型（F11）：新登记默认普货 */
  cargoType: CargoType;
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
    // 普货也明着传 "normal"（后端存成 null）：不传这个键后端会当成老页面、沿用库里的货型
    cargoType: d.cargoType,
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

/**
 * clientId（G01）：标「已通知」时带上页面上看到的唛头（可以是 null）。后端核一下库里的还是不是它 ——
 * 同事刚把唛头改了的话，不标、回 409（不然「已通知」记在新客户头上，其实通知的是旧客户）。改回未通知不带。
 */
export function setArrivalNoticeNotified(id: string, notified: boolean, clientId?: string | null): Promise<{ item: ArrivalNotice }> {
  return post("/staff/arrival-notices/notify", notified && clientId !== undefined ? { id, notified, clientId } : { id, notified });
}

/**
 * acknowledgedPrealertIds（F01）：员工在确认框里看过、确认是两票不同的货的那几张预报单（prealertMatches[].orderId）。
 * 后端在锁里重查，有一张没被确认就 409、什么都不建。
 */
export function convertArrivalNotice(id: string, to: "formal" | "inbound", acknowledgedPrealertIds?: string[]): Promise<{ item: ArrivalNotice }> {
  return post("/staff/arrival-notices/convert", { id, to, ...(acknowledgedPrealertIds?.length ? { acknowledgedPrealertIds } : {}) });
}

export function deleteArrivalNotice(id: string): Promise<{ deleted: boolean; id: string }> {
  return post("/staff/arrival-notices/delete", { id });
}

/** thumb（G03）：浏览器画好的小图（photo-thumb.ts）；画不出来就不带，列表退回用原图 */
export function uploadArrivalNoticeImage(noticeId: string, image: UploadImage, thumb?: { mime: string; base64: string } | null): Promise<{ item: ArrivalNotice }> {
  return post("/staff/arrival-notices/images", {
    noticeId, fileName: image.fileName, mime: image.mime, contentBase64: image.base64,
    ...(thumb ? { thumbBase64: thumb.base64, thumbMime: thumb.mime } : {}),
  });
}

export function deleteArrivalNoticeImage(imageId: string): Promise<{ item: ArrivalNotice }> {
  return post("/staff/arrival-notices/images/delete", { id: imageId });
}
