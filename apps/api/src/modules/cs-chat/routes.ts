/**
 * 客服对话（2026-09-28 老板拍板）
 *
 * 老板原话：
 *   「接个对话的功能。可以跟后台的客服对话，也就是员工账号」
 *   「是直接类似微信的对话功能」
 *   「只要文字信息就行了，然后也可以发图片啥的」
 *   「不是自己挑人聊，而是全部客服都能回」
 *   「代理的不开这个功能」
 *
 * 做法：
 *   · 一个客户一条对话（cs_conversations，company_id + client_id 唯一）。员工和超管共用一个收件箱，谁都能回。
 *   · 客户那边，员工 / 超管发的消息一律显示「客服」。员工那边看客户只显示唛头（2026-09-19「唛头=账号」）。
 *   · 只有湘泰自己的客户能用：代理名下的客户碰 /client/chat/* 在 server.ts 那道统一闸就被挡
 *     （core/agent-scope.ts 的 AGENT_CLIENT_BLOCKED_PREFIXES），这里每个客户接口再挡一次；
 *     员工也不能给代理名下的客户发。代理本人（role=agent）本来就碰不到 /client、/staff。
 *   · 消息「秒到」靠页面轮询（聊天窗口开着 2~3 秒一次）。生产是 nginx → Next 转发 → 接口，
 *     Next 的 rewrites 转不了 WebSocket，所以不做推送。
 *   · 轮询按时间取「比我手里最新那条还新的」，**往前多取 5 秒**、前端按 id 去重：
 *     两个人同一瞬间发、提交先后跟时间先后不一致时，不会漏掉那一条。
 *   · 未读用时间点记（*_read_at），不用计数器：读到哪条就把自己那一侧推到那条的时间，只往前推不往回退。
 *
 * 2026-10-02 老板加的几样（「这几个都可以做」+「可以选择是哪个运单…整柜的也可以」）：
 *   · 待回复：员工收件箱能只看「客户说了话、我们还没回」的对话（cs_conversations.last_sender_role
 *     = 最新一条**还在的**消息是谁发的，发消息 / 撤回时在对话锁里维护）；
 *   · 员工之间看得到是哪个同事回的（原来只有超管看得到，见 toWireMessage）；客户那边照旧只看到「客服」；
 *   · 撤回：自己发的、2 分钟内（同微信）。撤回后文字、图片、关联的单一起清掉，两边都只看到「撤回了一条消息」；
 *   · 发消息限频（每个账号每分钟 / 图片另有每天的上限）；
 *   · 关联运单 / 整柜：发消息时可以带上一张单（客户和客服都能发起），气泡里显示单号、品名、现在的状态；
 *   · 浏览器系统通知（push.ts）：客户没开系统页面也能收到新消息提醒。
 *
 * ⚠️ 接口路径比页面路径深一层（页面 /client/chat、/staff/chat；接口 /client/chat/xxx）——
 *    next.config.ts 的 rewrite 是「页面匹配不上才转发给接口」，同名会被页面吃掉（CLAUDE.md 第 5 条）。
 */
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import type { HttpRequest, HttpResponse, MinimalHttpApp } from "../../server";
import { BusinessError } from "../core/business-error";
import { fail, ok, requireRole } from "../core/http-utils";
import { AGENT_CLIENT_BLOCKED_MESSAGE } from "../core/agent-scope";
import { EXCLUDE_FCL_SHIPMENT } from "../core/fcl-scope";
import { checkRateLimit, rateLimitKey } from "../core/rate-limit";
import { deleteImageFile, saveImageToDisk } from "../orders/image-storage";
import { passwordFingerprint } from "../auth/token";
import { currentPushConfig, notifyChatMessage, parsePushSubscription } from "./push";

/** 一条文字最多多少字（微信单条上限是几千字；聊天用不到这么长，卡一下防误贴整本文档） */
export const CS_MAX_TEXT = 2000;
/** 单张图片（base64 长度）上限，跟收货凭证那几处一样 8MB；前端发之前会先压到 600KB 左右 */
export const CS_MAX_IMAGE_BASE64_LENGTH = 8 * 1024 * 1024;
export const CS_IMAGE_MIMES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
/** 打开窗口 / 往上翻一次取多少条 */
const PAGE_SIZE = 50;
/** 轮询往前多取的时间（见文件头） */
const POLL_OVERLAP_MS = 5000;
/** 客户那边看到的对方名字 */
export const CS_LABEL = "客服";
/** 员工收件箱一次最多列多少个对话（按最新消息排）；到顶了页面会写明，更早的用唛头搜 */
const CONVERSATION_LIST_LIMIT = 500;
/** 撤回时限（2026-10-02 老板选「2 分钟，同微信」）。前端 ChatThread 的 RECALL_WINDOW_MS 跟这里一致 */
export const CS_RECALL_WINDOW_MS = 2 * 60 * 1000;
/**
 * 发消息限频（2026-10-02）：按账号算，所有对话加在一起。
 * 页面发图前会压到 600KB 左右，但手拼请求一张能到 6MB —— 不限的话一个账号就能把服务器磁盘塞满。
 * 正常聊天碰不到：一分钟 30 条 = 两秒一条；一天 200 张图。
 */
export const CS_SEND_PER_MINUTE = 30;
export const CS_IMAGE_PER_MINUTE = 10;
export const CS_IMAGE_PER_DAY = 200;
/** 选单子时一次列多少张（运单、整柜各自）；更早的靠搜单号 / 品名，到顶了页面会写明（CLAUDE.md 第 21 条） */
const REF_LIST_LIMIT = 30;
/** 撤回之后对话列表那一行显示的字（这条对话里一条还在的都没有时） */
const RECALLED_PREVIEW = "[撤回了一条消息]";

type Auth = NonNullable<HttpRequest["auth"]>;

/** 消息能带的单子：普通运单（父单）/ 整柜 */
export type ChatRefType = "shipment" | "fcl";
const CHAT_REF_TYPES: readonly string[] = ["shipment", "fcl"];

type MessageRow = {
  id: string;
  senderId: string;
  senderRole: string;
  senderName: string | null;
  content: string | null;
  imagePath: string | null;
  createdAt: Date;
  recalledAt: Date | null;
  refType: string | null;
  refId: string | null;
  refNo: string | null;
  refTitle: string | null;
};

/** 气泡里那张单：单号、品名是发送时记下的；status 是现在的状态（取消息时现查） */
export type WireRef = {
  type: ChatRefType;
  id: string;
  /** 运单号 / 整柜的提单号（⚠️ 绝不是柜号） */
  no: string;
  title: string | null;
  /** 现在的状态码（前端翻中文）；查不到是 null */
  status: string | null;
  /** 这张单已经删掉了、或者不在这个客户名下了：只显示发送时记下的单号 */
  gone: boolean;
};

/** 下发给页面的一条消息（逐字段列出来，不整行展开 —— CLAUDE.md 第 31 条） */
export type WireMessage = {
  id: string;
  /** client = 客户发的；cs = 员工 / 超管发的 */
  side: "client" | "cs";
  /** 是不是看的这个人自己发的（气泡放右边） */
  mine: boolean;
  /** 气泡上方显示的名字 */
  senderLabel: string;
  content: string | null;
  imageUrl: string | null;
  createdAt: string;
  /** 撤回了：内容、图片、单子都是空的，页面只写「xx 撤回了一条消息」 */
  recalled: boolean;
  ref: WireRef | null;
};

/** 单子现在的状态：键 = `${type}:${id}`；不在表里 = 查不到（删了 / 不是这个客户的了） */
/** no：运单现在的单号（发出后员工改过单号的话，卡片跟着显示新单号；点开看详情也按它查，2026-10-06） */
type RefLive = Map<string, { status: string | null; no?: string }>;

export function toWireMessage(m: MessageRow, viewer: Pick<Auth, "userId" | "role">, live?: RefLive): WireMessage {
  const side: "client" | "cs" = m.senderRole === "client" ? "client" : "cs";
  const mine = m.senderId === viewer.userId;
  let senderLabel: string;
  if (mine) senderLabel = "我";
  else if (side === "client") senderLabel = m.senderId; // 唛头
  /* 客服发的：客户那边一律「客服」；员工 / 超管那边写是哪个同事（2026-10-02 老板拍板「这几个都可以做」：
     原来按 2026-09-15「操作人身份只给超管看」，员工之间也只看到「客服」，结果看不出哪个同事回过，
     容易两个人重复回、或者都以为对方回了。这一处只放开给内部员工看，客户那边照旧拿不到任何员工名字） */
  else if (viewer.role === "client") senderLabel = CS_LABEL;
  else senderLabel = m.senderName ? `${CS_LABEL}·${m.senderName}` : CS_LABEL;
  const recalled = m.recalledAt !== null;
  let ref: WireRef | null = null;
  if (!recalled && m.refId && m.refNo && (m.refType === "shipment" || m.refType === "fcl")) {
    const now = live?.get(`${m.refType}:${m.refId}`);
    ref = { type: m.refType, id: m.refId, no: now?.no ?? m.refNo, title: m.refTitle, status: now?.status ?? null, gone: live ? !now : false };
  }
  return {
    id: m.id,
    side,
    mine,
    senderLabel,
    content: recalled ? null : m.content,
    imageUrl: recalled ? null : m.imagePath,
    createdAt: m.createdAt.toISOString(),
    recalled,
    ref,
  };
}

const MESSAGE_SELECT = {
  id: true, senderId: true, senderRole: true, senderName: true, content: true, imagePath: true, createdAt: true,
  recalledAt: true, refType: true, refId: true, refNo: true, refTitle: true,
} as const;

/** 单子在摘要里怎么叫：[运单 XT123] / [整柜 BL456] */
function refTag(ref: { type: string; no: string }): string {
  return `[${ref.type === "fcl" ? "整柜" : "运单"} ${ref.no}]`;
}

/** 列表里那一行的摘要：文字取前 60 个字，只有图片就写 [图片]；带了单子在前面加 [运单 xxx] */
export function previewOf(content: string | null, hasImage: boolean, ref: { type: string; no: string } | null = null): string {
  const text = (content ?? "").replace(/\s+/g, " ").trim();
  /* 按「字」截，不按 UTF-16 截（2026-09-28 分支审查）：表情是两个 UTF-16 单位，正好落在第 60 位时
     slice(0, 60) 会把它劈成半个，数据库不收这种半个字符，整条消息 500、怎么重发都发不出去。 */
  const chars = Array.from(text);
  const body = chars.length ? (chars.length > 60 ? `${chars.slice(0, 60).join("")}…` : text) : hasImage ? "[图片]" : "";
  const tag = ref ? refTag(ref) : "";
  return tag && body ? `${tag} ${body}` : tag || body;
}

/** 解析 ISO 时间参数；空 = undefined，乱写 = null（调用处 400） */
function parseTimeParam(raw: unknown): Date | undefined | null {
  if (raw === undefined || raw === null || String(raw).trim() === "") return undefined;
  const d = new Date(String(raw).trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

type SendBody = {
  content?: unknown;
  image?: { fileName?: unknown; mime?: unknown; base64?: unknown } | null;
  /** 2026-10-02：这条消息说的是哪张单 */
  ref?: { type?: unknown; id?: unknown } | null;
};

/** 文件头对不对得上声明的图片类型（jpg FF D8 FF / png 89 50 4E 47 / gif "GIF8" / webp "RIFF....WEBP"） */
function looksLikeImage(base64: string, mime: string): boolean {
  const head = Buffer.from(base64.slice(0, 24), "base64");
  const at = (i: number) => head[i];
  if (mime === "image/jpeg" || mime === "image/jpg") return at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff;
  if (mime === "image/png") return at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47;
  if (mime === "image/gif") return head.subarray(0, 4).toString("latin1") === "GIF8";
  if (mime === "image/webp") return head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP";
  return false;
}

/** 校验要发的内容；通过就返回整理好的文字 + 图片 + 单子 */
export function parseSendBody(body: SendBody): { error: string } | {
  content: string | null;
  image: { mime: string; base64: string } | null;
  ref: { type: ChatRefType; id: string } | null;
} {
  const content = typeof body.content === "string" ? body.content.replace(/\r\n/g, "\n").trim() : "";
  if (body.content !== undefined && body.content !== null && typeof body.content !== "string") return { error: "消息内容不对" };
  if (content.length > CS_MAX_TEXT) return { error: `一条最多 ${CS_MAX_TEXT} 个字，请分几条发` };
  let image: { mime: string; base64: string } | null = null;
  if (body.image) {
    const mime = String(body.image.mime ?? "").trim().toLowerCase();
    const base64 = String(body.image.base64 ?? "").trim();
    if (!CS_IMAGE_MIMES.includes(mime)) return { error: "只能发 jpg / png / gif / webp 图片" };
    if (!base64) return { error: "图片是空的" };
    if (base64.length > CS_MAX_IMAGE_BASE64_LENGTH) return { error: "图片太大了（压缩后仍超过 8MB），请换一张" };
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return { error: "图片内容不对，请重新选一张" };
    // 看文件头，不只看声明的类型（2026-09-29 实跑发现：一段文字说自己是 image/png 也能发出去）。页面发图会先在浏览器里重新压成图，只有手拼请求才会这样
    if (!looksLikeImage(base64, mime)) return { error: "图片内容不对，请重新选一张" };
    image = { mime, base64 };
  }
  let ref: { type: ChatRefType; id: string } | null = null;
  if (body.ref) {
    const type = String(body.ref.type ?? "").trim();
    const id = typeof body.ref.id === "string" ? body.ref.id.trim() : "";
    if (!CHAT_REF_TYPES.includes(type) || !id || id.length > 100) return { error: "选的运单不对，请重新选" };
    ref = { type: type as ChatRefType, id };
  }
  if (!content && !image && !ref) return { error: "不能发空消息" };
  return { content: content || null, image, ref };
}

/** 发消息限频（见 CS_SEND_PER_MINUTE）：超了返回给人看的话，没超返回 null */
function sendRateLimited(userId: string, hasImage: boolean): string | null {
  if (checkRateLimit(rateLimitKey(userId, "cs-chat-send"), CS_SEND_PER_MINUTE, 60_000)) {
    return `发得太快了，请稍等一会儿再发（每分钟最多 ${CS_SEND_PER_MINUTE} 条）`;
  }
  if (hasImage) {
    if (checkRateLimit(rateLimitKey(userId, "cs-chat-image"), CS_IMAGE_PER_MINUTE, 60_000)) {
      return `图片发得太快了，请稍等一会儿再发（每分钟最多 ${CS_IMAGE_PER_MINUTE} 张）`;
    }
    if (checkRateLimit(rateLimitKey(userId, "cs-chat-image-day"), CS_IMAGE_PER_DAY, 24 * 60 * 60_000)) {
      return `今天发的图片太多了（24 小时内最多 ${CS_IMAGE_PER_DAY} 张），请改用文字说明，或者明天再发`;
    }
  }
  return null;
}

/**
 * 同一个客户的对话排队写（咨询锁 83040 + 按「公司:唛头」哈希）。
 * 为什么要锁：两个人同一瞬间发，谁先拿到时间、谁先提交可能不一致；排队以后「时间先后 = 写进去的先后」，
 * 轮询按时间取就不会漏；第一条同时发时也不会同时去建对话。只锁这一个客户，别的客户不受影响。
 * 撤回也排同一个队（2026-10-02）：要按「最新一条还在的消息」重算对话摘要，不能跟发消息交叉。
 * 登记在 scripts/test-lock-order.ts 的 LOCK_HELPERS（那边会去函数体里核实锁真的在）。
 */
async function lockCsConversation(
  tx: { $executeRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> },
  companyId: string,
  clientId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(83040, hashtext(${`${companyId}:${clientId}`}))`;
}

type Tx = Prisma.TransactionClient;
type ResolvedRef = { refType: ChatRefType; refId: string; refNo: string; refTitle: string | null };

/**
 * 发消息时带的单子：必须是**这个客户自己的**（2026-10-02）。
 *   · 运单：父单（子单是分柜拆出来的，客户列表里看不到）、不是整柜的单 —— 跟客户「运单查询」同一个口径；
 *   · 整柜：柜里那张单的归属客户是他 —— 跟客户「我的整柜」同一个口径（那边也是查完再核一遍第一张单）。
 * 记下的单号：运单号 / 整柜的提单号。⚠️ 整柜**绝不记柜号**（老板 2026-08-07「客户不能看到柜号」）。
 * 在发消息的事务里查（锁之后）：改运单客户那几条路正好在这一刻把单子划走，就按划走以后的判。
 */
async function resolveChatRef(tx: Tx, companyId: string, clientId: string, ref: { type: ChatRefType; id: string }): Promise<ResolvedRef> {
  if (ref.type === "shipment") {
    const s = await tx.shipment.findFirst({
      where: { ...EXCLUDE_FCL_SHIPMENT, id: ref.id, companyId, parentTrackingNo: null, order: { clientId } },
      select: { id: true, trackingNo: true, itemName: true, order: { select: { itemName: true } } },
    });
    if (!s) throw new BusinessError("没找到这张运单（可能已经删了，或者不是这个客户的），请重新选", 404, "NOT_FOUND");
    return { refType: "shipment", refId: s.id, refNo: s.trackingNo, refTitle: s.order?.itemName ?? s.itemName ?? null };
  }
  const c = await tx.container.findFirst({
    where: { id: ref.id, companyId, isFcl: true },
    select: {
      id: true,
      items: {
        orderBy: { createdAt: "asc" },
        take: 1,
        select: { shipment: { select: { trackingNo: true, itemName: true, order: { select: { clientId: true, itemName: true } } } } },
      },
    },
  });
  const ship = c?.items[0]?.shipment;
  if (!c || !ship || ship.order?.clientId !== clientId) {
    throw new BusinessError("没找到这个整柜（可能已经删了，或者不是这个客户的），请重新选", 404, "NOT_FOUND");
  }
  return { refType: "fcl", refId: c.id, refNo: ship.trackingNo, refTitle: ship.order?.itemName ?? ship.itemName ?? null };
}

/**
 * 气泡里那几张单现在的状态（取消息时一起查）。还是按「这个客户的」查：
 * 单子后来改归别的客户了，就当查不到（gone），不能把别人的单现在到哪了带给这个客户看。
 */
async function loadRefLive(companyId: string, clientId: string, rows: MessageRow[]): Promise<RefLive> {
  const live: RefLive = new Map();
  const ids = (type: ChatRefType) => [...new Set(rows.filter((m) => !m.recalledAt && m.refType === type && m.refId).map((m) => m.refId!))];
  const shipmentIds = ids("shipment");
  const fclIds = ids("fcl");
  const [ships, conts] = await Promise.all([
    shipmentIds.length === 0 ? [] : prisma.shipment.findMany({
      where: { ...EXCLUDE_FCL_SHIPMENT, id: { in: shipmentIds }, companyId, parentTrackingNo: null, order: { clientId } },
      select: { id: true, currentStatus: true, trackingNo: true },
    }),
    fclIds.length === 0 ? [] : prisma.container.findMany({
      where: { id: { in: fclIds }, companyId, isFcl: true },
      select: {
        id: true,
        items: { orderBy: { createdAt: "asc" }, take: 1, select: { shipment: { select: { currentStatus: true, order: { select: { clientId: true } } } } } },
      },
    }),
  ]);
  for (const s of ships) live.set(`shipment:${s.id}`, { status: s.currentStatus, no: s.trackingNo });
  for (const c of conts) {
    const ship = c.items[0]?.shipment;
    if (ship && ship.order?.clientId === clientId) live.set(`fcl:${c.id}`, { status: ship.currentStatus });
  }
  return live;
}

/**
 * 对话列表那一行（摘要、最后是谁说的）按「最新一条**还在的**消息」重算（撤回之后调，2026-10-02）。
 * last_sender_role 同时决定「待回复」：最新一条还在的是客户发的 = 等着我们回。
 * 撤回了最新那条：列表显示它前面那条；一条还在的都没有：写「[撤回了一条消息]」，也不算待回复。
 * last_message_at 不动（列表还按最近有动静排）。
 */
async function refreshConversationSummary(tx: Tx, conversationId: string): Promise<void> {
  const latest = await tx.csMessage.findFirst({
    where: { conversationId, recalledAt: null },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { senderRole: true, content: true, imagePath: true, refType: true, refNo: true },
  });
  await tx.csConversation.update({
    where: { id: conversationId },
    data: latest
      ? {
        lastMessagePreview: previewOf(latest.content, latest.imagePath !== null, latest.refType && latest.refNo ? { type: latest.refType, no: latest.refNo } : null),
        lastSenderRole: latest.senderRole,
      }
      : { lastMessagePreview: RECALLED_PREVIEW, lastSenderRole: null },
  });
}

/**
 * 发一条（客户、员工、超管共用）。对话不存在就建。
 * 图片先写盘再开事务（事务里不做文件 IO），事务失败把图删掉。
 * 已经按客户排队（lockCsConversation），建对话时再加一道 INSERT … ON CONFLICT DO NOTHING 兜底：
 * 万一哪天锁被拿掉，同时建也不会撞唯一约束把事务弄挂。列名是本次迁移自己建的；
 * 时间按 UTC 写（Prisma 自己写的也是 UTC），不管库的时区设成什么都一样。
 */
async function sendMessage(opts: {
  companyId: string;
  clientId: string;
  sender: Pick<Auth, "userId" | "role">;
  /** 员工 / 超管发的才传名字（内部看得到是哪个同事）；客户发的传 null —— 客户那条显示唛头就够了 */
  staffName: string | null;
  content: string | null;
  image: { mime: string; base64: string } | null;
  ref: { type: ChatRefType; id: string } | null;
}): Promise<{ msg: MessageRow; preview: string }> {
  const imagePath = opts.image ? saveImageToDisk(`cs_${opts.clientId}`, opts.image.mime, opts.image.base64) : null;
  try {
    return await prisma.$transaction(async (tx) => {
      await lockCsConversation(tx, opts.companyId, opts.clientId);
      /* 锁里再核一次这个客户还是不是湘泰直属的（2026-09-28 Codex 复核第 4 条）：
         请求进门时查的归属到这里可能已经变了 —— 超管正好在这一刻把他划给了代理。
         FOR SHARE：超管改归属那个事务没提交就等它，提交了按新的判。列名已对 schema 核过（users.agent_id / company_id）。 */
      const owner = await tx.$queryRaw<Array<{ agent_id: string | null }>>`
        SELECT agent_id FROM users WHERE id = ${opts.clientId} AND company_id = ${opts.companyId} AND role = 'client' FOR SHARE`;
      if (!owner[0]) throw new BusinessError("没有这个客户唛头", 404, "NOT_FOUND");
      if (owner[0].agent_id) throw new BusinessError("这个客户是代理名下的，没有开对话功能", 403, "FORBIDDEN");
      const ref = opts.ref ? await resolveChatRef(tx, opts.companyId, opts.clientId, opts.ref) : null;
      const preview = previewOf(opts.content, imagePath !== null, ref ? { type: ref.refType, no: ref.refNo } : null);
      // 时间在拿到锁之后取：排在后面的那条时间一定更晚
      const now = new Date();
      const key = { companyId_clientId: { companyId: opts.companyId, clientId: opts.clientId } };
      let conv = await tx.csConversation.findUnique({ where: key, select: { id: true } });
      if (!conv) {
        await tx.$executeRaw`
          INSERT INTO cs_conversations (id, company_id, client_id, created_at, updated_at)
          VALUES (${`csc_${randomUUID()}`}, ${opts.companyId}, ${opts.clientId}, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC'))
          ON CONFLICT (company_id, client_id) DO NOTHING`;
        conv = await tx.csConversation.findUnique({ where: key, select: { id: true } });
        if (!conv) throw new Error("建对话失败");
      }
      const msg = await tx.csMessage.create({
        data: {
          companyId: opts.companyId,
          conversationId: conv.id,
          senderId: opts.sender.userId,
          senderRole: opts.sender.role,
          senderName: opts.staffName,
          content: opts.content,
          imagePath,
          createdAt: now,
          refType: ref?.refType ?? null,
          refId: ref?.refId ?? null,
          refNo: ref?.refNo ?? null,
          refTitle: ref?.refTitle ?? null,
        },
        select: MESSAGE_SELECT,
      });
      // 新发的这条一定是最新的、还在的：直接记它（撤回那边按「最新一条还在的」重算）
      await tx.csConversation.update({
        where: { id: conv.id },
        data: { lastMessageAt: now, lastMessagePreview: preview, lastSenderRole: opts.sender.role },
      });
      return { msg, preview };
    /* 事务时限放宽（2026-09-29 实跑发现）：同一个客户的消息按咨询锁排队，排队等锁的时间也算在 Prisma
       默认的 5 秒里 —— 测试库上同时发 20 条（再开着轮询），排在后面的 1~8 条直接 500、没发出去。
       仓库里别的要排队的事务都是这个写法（admin / agents 那几处）。 */
    }, { timeout: 30000, maxWait: 10000 });
  } catch (e) {
    if (imagePath) {
      try { deleteImageFile(imagePath); } catch { /* 删不掉就算了，不影响报错 */ }
    }
    throw e;
  }
}

/**
 * 撤回（2026-10-02 老板：发错的 2 分钟内能撤回，同微信）。只能撤回自己发的。
 * 判断全在对话锁里做（CLAUDE.md 第 28 条：先检查后动手中间不能隔着别人）。
 * 撤回后文字、图片、关联的单一起清掉（图片文件在事务提交后删）；同一条点两下第二次原样返回。
 * 撤回的是这个对话最新的一条（这次真撤回的，不是点第二下）：顺手把对方通知栏里那条原文换掉（push.ts 的 recall）。
 */
async function recallMessage(opts: { companyId: string; clientId: string; viewer: Pick<Auth, "userId">; messageId: string }): Promise<MessageRow> {
  const { msg, imagePath, wasLatest } = await prisma.$transaction(async (tx) => {
    await lockCsConversation(tx, opts.companyId, opts.clientId);
    const conv = await tx.csConversation.findUnique({
      where: { companyId_clientId: { companyId: opts.companyId, clientId: opts.clientId } },
      select: { id: true },
    });
    const m = conv ? await tx.csMessage.findFirst({ where: { id: opts.messageId, conversationId: conv.id }, select: MESSAGE_SELECT }) : null;
    if (!conv || !m) throw new BusinessError("没有这条消息", 404, "NOT_FOUND");
    if (m.senderId !== opts.viewer.userId) throw new BusinessError("只能撤回自己发的消息", 403, "FORBIDDEN");
    if (m.recalledAt) return { msg: m, imagePath: null, wasLatest: false };
    const now = new Date();
    if (now.getTime() - m.createdAt.getTime() > CS_RECALL_WINDOW_MS) {
      throw new BusinessError(`发出超过 ${CS_RECALL_WINDOW_MS / 60_000} 分钟了，不能撤回`, 400, "VALIDATION_ERROR");
    }
    /* 「最新」按同一边算（2026-10-02 复核）：对方通知栏里那个 tag 只会被**同一边**后来发的消息替换 ——
       客户发错一句、员工秒回一个「？」、客户再撤回：员工的回复不推给员工，员工通知栏里躺着的还是客户那句原文。
       原来按两边一起数，有了员工那句就当「不是最新」，不换通知，原文一直留着 */
    const sameSide = m.senderRole === "client" ? { senderRole: "client" } : { senderRole: { not: "client" } };
    const newer = await tx.csMessage.count({
      where: { conversationId: conv.id, ...sameSide, OR: [{ createdAt: { gt: m.createdAt } }, { createdAt: m.createdAt, id: { gt: m.id } }] },
    });
    const updated = await tx.csMessage.update({
      where: { id: m.id },
      data: { recalledAt: now, content: null, imagePath: null, refType: null, refId: null, refNo: null, refTitle: null },
      select: MESSAGE_SELECT,
    });
    await refreshConversationSummary(tx, conv.id);
    return { msg: updated, imagePath: m.imagePath, wasLatest: newer === 0 };
  }, { timeout: 30000, maxWait: 10000 });
  if (imagePath) {
    try { deleteImageFile(imagePath); } catch { /* 文件删不掉不影响撤回（页面已经拿不到这张图的地址了） */ }
  }
  if (wasLatest) notifyChatMessage({ companyId: opts.companyId, clientId: opts.clientId, fromRole: msg.senderRole, preview: "", recall: true });
  return msg;
}

/**
 * 取消息：since（轮询取新的，带 5 秒重叠）/ before（往上翻更早的）/ 都不传（最近 50 条）。
 * since 那一路连「这段时间里被撤回的」一起带回来（2026-10-02）：前端按 id 换掉手里那条，
 * 对方撤回了 3 秒内这边就变成「撤回了一条消息」。
 */
async function loadMessages(
  conv: { id: string; companyId: string; clientId: string },
  query: HttpRequest["query"],
  res: HttpResponse,
  viewer: Auth,
): Promise<{ messages: WireMessage[]; hasMore: boolean } | null> {
  const since = parseTimeParam(query.since);
  const before = parseTimeParam(query.before);
  if (since === null || before === null) { fail(res, 400, "BAD_REQUEST", "时间参数不对"); return null; }
  let rows: MessageRow[];
  let hasMore = false;
  if (since) {
    const from = new Date(since.getTime() - POLL_OVERLAP_MS);
    /* 撤回只能在发出后 2 分钟内，所以「这段时间里被撤回的」一定是 from 往前 2 分钟以内发的：
       先按发送时间圈一个下限，查询还能走 (conversation_id, created_at) 索引（2026-10-02 复核：
       原来 OR 上 recalled_at 没有索引，每 3 秒一次把这个对话的全部消息扫一遍） */
    const recallFloor = new Date(from.getTime() - CS_RECALL_WINDOW_MS - POLL_OVERLAP_MS);
    rows = await prisma.csMessage.findMany({
      where: { conversationId: conv.id, createdAt: { gte: recallFloor }, OR: [{ createdAt: { gte: from } }, { recalledAt: { gte: from } }] },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 500,
      select: MESSAGE_SELECT,
    });
  } else {
    const desc = await prisma.csMessage.findMany({
      where: { conversationId: conv.id, ...(before ? { createdAt: { lt: before } } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: PAGE_SIZE + 1,
      select: MESSAGE_SELECT,
    });
    hasMore = desc.length > PAGE_SIZE;
    rows = desc.slice(0, PAGE_SIZE).reverse();
  }
  const live = await loadRefLive(conv.companyId, conv.clientId, rows);
  return { messages: rows.map((m) => toWireMessage(m, viewer, live)), hasMore };
}

/** 已读只往前推：upTo 不传 = 读到现在；传了取 min(upTo, 现在)。比库里已有的早就不动 */
async function markRead(conversationId: string, side: "client" | "staff", upToRaw: unknown): Promise<string | null> {
  const upTo = parseTimeParam(upToRaw);
  if (upTo === null) return "时间参数不对";
  const now = new Date();
  const at = upTo && upTo.getTime() < now.getTime() ? upTo : now;
  if (side === "client") {
    await prisma.csConversation.updateMany({
      where: { id: conversationId, OR: [{ clientReadAt: null }, { clientReadAt: { lt: at } }] },
      data: { clientReadAt: at },
    });
  } else {
    await prisma.csConversation.updateMany({
      where: { id: conversationId, OR: [{ staffReadAt: null }, { staffReadAt: { lt: at } }] },
      data: { staffReadAt: at },
    });
  }
  return null;
}

/**
 * 客服这一侧每条对话的未读数（客户发的、晚于 staff_read_at 的、没撤回的条数）。列名是迁移自己建的，已核。
 * latest = 这条对话里最新一条未读的时间：菜单那边拿它判断「有没有新来的」，来了就响提示音（2026-10-02）
 */
async function staffUnreadByConversation(companyId: string): Promise<Map<string, { count: number; latest: Date | null; clientId: string }>> {
  const rows = await prisma.$queryRaw<Array<{ id: string; unread: number; latest: Date | null; client_id: string }>>`
    SELECT c.id, c.client_id, COUNT(m.id)::int AS unread, MAX(m.created_at) AS latest
    FROM cs_conversations c
    JOIN cs_messages m ON m.conversation_id = c.id
      AND m.sender_role = 'client'
      AND m.recalled_at IS NULL
      AND (c.staff_read_at IS NULL OR m.created_at > c.staff_read_at)
    WHERE c.company_id = ${companyId}
      -- 先把「最后一条都不晚于已读」的对话筛掉（有未读的对话，最后一条一定晚于已读，结果不变）：
      -- 菜单未读现在网页在后台也照样问，别每次都把全公司每条对话的消息扫一遍（dsh 复查 2026-10-02）
      AND (c.staff_read_at IS NULL OR c.last_message_at > c.staff_read_at)
    GROUP BY c.id, c.client_id`;
  return new Map(rows.map((r) => [r.id, { count: Number(r.unread), latest: r.latest ?? null, clientId: r.client_id }]));
}

/**
 * 待回复的对话从什么时候开始等的：我们最后一条还在的回复之后，客户发的第一条还在的消息的时间（2026-10-02）。
 * 只查传进来的这几条对话（列表这一页里待回复的）。列名是迁移自己建的，已核（cs_messages.conversation_id / sender_role / recalled_at / created_at）。
 */
async function pendingSinceByConversation(conversationIds: string[]): Promise<Map<string, Date>> {
  if (conversationIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<Array<{ id: string; since: Date }>>`
    WITH last_cs AS (
      SELECT conversation_id, MAX(created_at) AS at FROM cs_messages
      WHERE conversation_id = ANY(${conversationIds}) AND sender_role <> 'client' AND recalled_at IS NULL
      GROUP BY conversation_id
    )
    SELECT m.conversation_id AS id, MIN(m.created_at) AS since
    FROM cs_messages m
    LEFT JOIN last_cs l ON l.conversation_id = m.conversation_id
    WHERE m.conversation_id = ANY(${conversationIds})
      AND m.sender_role = 'client' AND m.recalled_at IS NULL
      AND (l.at IS NULL OR m.created_at > l.at)
    GROUP BY m.conversation_id`;
  return new Map(rows.map((r) => [r.id, r.since]));
}

/** 客户接口的门：role=client 且不是代理名下的（server.ts 那道闸之外再挡一次） */
function requireDirectClient(req: HttpRequest, res: HttpResponse): Auth | null {
  const auth = requireRole(req, res, ["client"]);
  if (!auth) return null;
  if (auth.agentId) { fail(res, 403, "FORBIDDEN", AGENT_CLIENT_BLOCKED_MESSAGE); return null; }
  return auth;
}

/** 员工给谁发 / 看谁：必须是本公司的客户，而且不是代理名下的 */
async function findChatClient(companyId: string, clientIdRaw: unknown): Promise<{ error: string; status: number } | { clientId: string }> {
  const clientId = String(clientIdRaw ?? "").trim();
  if (!clientId) return { error: "请选择客户唛头", status: 400 };
  const client = await prisma.user.findFirst({
    where: { id: clientId, companyId, role: "client" },
    select: { id: true, agentId: true },
  });
  if (!client) return { error: "没有这个客户唛头", status: 404 };
  if (client.agentId) return { error: "这个客户是代理名下的，没有开对话功能", status: 400 };
  return { clientId: client.id };
}

/**
 * 发消息时能选的单子（2026-10-02）：这个客户的普通运单（父单）+ 整柜，各列最近 REF_LIST_LIMIT 张。
 * 搜索写进 where（CLAUDE.md 第 19 条：不拉一页回来在内存里筛）：运单号 / 国内快递单号（含产品行的）/ 品名；整柜按提单号 / 品名。
 * ⚠️ 整柜只给提单号，不给柜号，也不按柜号搜（客户不能看到柜号；员工这边也一样列，同一份接口口径）。
 */
async function listChatRefs(companyId: string, clientId: string, qRaw: unknown) {
  const q = String(qRaw ?? "").trim().slice(0, 50);
  const like = { contains: q, mode: "insensitive" as const };
  const [ships, conts] = await Promise.all([
    prisma.shipment.findMany({
      where: {
        ...EXCLUDE_FCL_SHIPMENT,
        companyId,
        parentTrackingNo: null,
        order: { clientId },
        ...(q ? {
          OR: [
            { trackingNo: like },
            { domesticTrackingNo: like },
            { order: { itemName: like } },
            { order: { products: { some: { domesticTrackingNo: like } } } },
          ],
        } : {}),
      },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: REF_LIST_LIMIT + 1,
      select: { id: true, trackingNo: true, currentStatus: true, packageCount: true, packageUnit: true, itemName: true, order: { select: { itemName: true } } },
    }),
    prisma.container.findMany({
      where: {
        companyId,
        isFcl: true,
        AND: [
          { items: { some: { shipment: { order: { clientId } } } } },
          ...(q ? [{ items: { some: { shipment: { OR: [{ trackingNo: like }, { order: { itemName: like } }] } } } }] : []),
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: REF_LIST_LIMIT + 1,
      select: {
        id: true,
        items: {
          orderBy: { createdAt: "asc" },
          take: 1,
          select: { shipment: { select: { trackingNo: true, currentStatus: true, packageCount: true, packageUnit: true, itemName: true, order: { select: { clientId: true, itemName: true } } } } },
        },
      },
    }),
  ]);
  const fcl = conts
    // 再兜一道：柜里第一张单确实是这个客户的（跟客户「我的整柜」同一个口径）
    .filter((c) => c.items[0]?.shipment?.order?.clientId === clientId)
    .slice(0, REF_LIST_LIMIT)
    .map((c) => {
      const s = c.items[0]!.shipment;
      return { id: c.id, no: s.trackingNo, title: s.order?.itemName ?? s.itemName ?? null, status: s.currentStatus, packageCount: s.packageCount, packageUnit: s.packageUnit };
    });
  return {
    shipments: ships.slice(0, REF_LIST_LIMIT).map((s) => ({
      id: s.id, no: s.trackingNo, title: s.order?.itemName ?? s.itemName ?? null, status: s.currentStatus, packageCount: s.packageCount, packageUnit: s.packageUnit,
    })),
    fcl,
    /** 到顶了（只列了最近 REF_LIST_LIMIT 张）：页面要写出来，更早的靠搜 */
    shipmentsTruncated: ships.length > REF_LIST_LIMIT,
    fclTruncated: conts.length > REF_LIST_LIMIT,
  };
}

/** 一个账号最多留几个浏览器的通知订阅（换电脑、清缓存会留下旧的；多了按最近更新的留） */
const PUSH_SUBSCRIPTIONS_PER_USER = 10;

/** 开通知：存这个浏览器的订阅。同一个浏览器（endpoint）再订一次 = 改归现在登录的人 */
async function savePushSubscription(auth: Auth, body: unknown, res: HttpResponse): Promise<void> {
  if (!currentPushConfig()) { fail(res, 400, "BAD_REQUEST", "服务器还没开通系统通知，请联系管理员"); return; }
  const parsed = parsePushSubscription(body);
  if ("error" in parsed) { fail(res, 400, "VALIDATION_ERROR", parsed.error); return; }
  // 记下这个账号现在的密码指纹：以后改了密码，这条订阅就作废（发的时候核，见 push.ts 的 filterLiveSubscriptions）
  const me = await prisma.user.findUnique({ where: { id: auth.userId }, select: { passwordHash: true } });
  if (!me) { fail(res, 404, "NOT_FOUND", "账号不存在"); return; }
  const fp = passwordFingerprint(me.passwordHash);
  // 列名是本次迁移自己建的（20261002_cs_chat_recall_ref_push），已核；时间按 UTC 写（跟上面建对话一样）
  await prisma.$executeRaw`
    INSERT INTO cs_push_subscriptions (id, company_id, user_id, role, endpoint, p256dh, auth, password_fp, created_at, updated_at)
    VALUES (${`csp_${randomUUID()}`}, ${auth.companyId}, ${auth.userId}, ${auth.role}, ${parsed.endpoint}, ${parsed.p256dh}, ${parsed.auth}, ${fp},
            (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC'))
    ON CONFLICT (endpoint) DO UPDATE SET
      company_id = EXCLUDED.company_id, user_id = EXCLUDED.user_id, role = EXCLUDED.role,
      p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, password_fp = EXCLUDED.password_fp, updated_at = EXCLUDED.updated_at`;
  const extra = await prisma.csPushSubscription.findMany({
    where: { companyId: auth.companyId, userId: auth.userId },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    skip: PUSH_SUBSCRIPTIONS_PER_USER,
    select: { id: true },
  });
  if (extra.length > 0) await prisma.csPushSubscription.deleteMany({ where: { id: { in: extra.map((x) => x.id) } } });
  ok(res, { ok: true });
}

/** 关通知 / 退出登录：删掉这个浏览器的订阅（只删自己名下的） */
async function deletePushSubscription(auth: Auth, body: unknown, res: HttpResponse): Promise<void> {
  const endpoint = typeof (body as { endpoint?: unknown } | null)?.endpoint === "string" ? (body as { endpoint: string }).endpoint.trim() : "";
  if (!endpoint) { fail(res, 400, "BAD_REQUEST", "缺少通知地址"); return; }
  await prisma.csPushSubscription.deleteMany({ where: { endpoint, userId: auth.userId, companyId: auth.companyId } });
  ok(res, { ok: true });
}

function pushKeyResponse(res: HttpResponse): void {
  const cfg = currentPushConfig();
  // 公钥本来就是公开的（浏览器订阅时要用）；私钥永远不出服务器
  ok(res, { enabled: cfg !== null, publicKey: cfg?.publicKey ?? null });
}

export function registerCsChatRoutes(app: MinimalHttpApp): void {
  // ======================================================================
  // 客户
  // ======================================================================
  app.get("/client/chat/messages", async (req, res) => {
    const auth = requireDirectClient(req, res);
    if (!auth) return;
    const conv = await prisma.csConversation.findUnique({
      where: { companyId_clientId: { companyId: auth.companyId, clientId: auth.userId } },
      select: { id: true, staffReadAt: true },
    });
    if (!conv) { ok(res, { messages: [], hasMore: false, serverTime: new Date().toISOString(), peerReadAt: null }); return; }
    const data = await loadMessages({ id: conv.id, companyId: auth.companyId, clientId: auth.userId }, req.query, res, auth);
    if (!data) return;
    /* peerReadAt = 客服这边看到了哪一刻（任何一个员工 / 超管看过就算）：客户自己发的、不晚于它的显示「已读」
       （2026-10-02 老板：「直接显示已读，每条信息都显示，类似 LINE 那种」） */
    ok(res, { ...data, serverTime: new Date().toISOString(), peerReadAt: conv.staffReadAt?.toISOString() ?? null });
  });

  app.post("/client/chat/send", async (req, res) => {
    const auth = requireDirectClient(req, res);
    if (!auth) return;
    const parsed = parseSendBody((req.body ?? {}) as SendBody);
    if ("error" in parsed) { fail(res, 400, "VALIDATION_ERROR", parsed.error); return; }
    const limited = sendRateLimited(auth.userId, parsed.image !== null);
    if (limited) { fail(res, 429, "BAD_REQUEST", limited); return; }
    const { msg, preview } = await sendMessage({ companyId: auth.companyId, clientId: auth.userId, sender: auth, staffName: null, ...parsed });
    notifyChatMessage({ companyId: auth.companyId, clientId: auth.userId, fromRole: "client", preview });
    const live = await loadRefLive(auth.companyId, auth.userId, [msg]);
    ok(res, { message: toWireMessage(msg, auth, live) });
  });

  app.post("/client/chat/recall", async (req, res) => {
    const auth = requireDirectClient(req, res);
    if (!auth) return;
    const messageId = String((req.body as { messageId?: unknown } | undefined)?.messageId ?? "").trim();
    if (!messageId) { fail(res, 400, "BAD_REQUEST", "请选择要撤回的消息"); return; }
    const msg = await recallMessage({ companyId: auth.companyId, clientId: auth.userId, viewer: auth, messageId });
    ok(res, { message: toWireMessage(msg, auth) });
  });

  app.post("/client/chat/read", async (req, res) => {
    const auth = requireDirectClient(req, res);
    if (!auth) return;
    const conv = await prisma.csConversation.findUnique({
      where: { companyId_clientId: { companyId: auth.companyId, clientId: auth.userId } },
      select: { id: true },
    });
    if (!conv) { ok(res, { ok: true }); return; }
    const issue = await markRead(conv.id, "client", (req.body as { upTo?: unknown } | undefined)?.upTo);
    if (issue) { fail(res, 400, "BAD_REQUEST", issue); return; }
    ok(res, { ok: true });
  });

  app.get("/client/chat/unread", async (req, res) => {
    const auth = requireDirectClient(req, res);
    if (!auth) return;
    const conv = await prisma.csConversation.findUnique({
      where: { companyId_clientId: { companyId: auth.companyId, clientId: auth.userId } },
      select: { id: true, clientReadAt: true },
    });
    if (!conv) { ok(res, { count: 0, latestAt: null, serverTime: new Date().toISOString() }); return; }
    const agg = await prisma.csMessage.aggregate({
      where: {
        conversationId: conv.id,
        senderRole: { not: "client" },
        // 撤回了的不算未读（2026-10-02）
        recalledAt: null,
        ...(conv.clientReadAt ? { createdAt: { gt: conv.clientReadAt } } : {}),
      },
      _count: { _all: true },
      _max: { createdAt: true },
    });
    // latestAt：最新一条没看的客服消息是什么时候发的 —— 菜单拿它判断「有新来的」就响提示音（2026-10-02）
    // serverTime：前端拿它划「打开网页时的线」（第一次取回来时，这条线往前 10 秒内到的照样响，Codex 第二轮复查）
    ok(res, { count: agg._count._all, latestAt: agg._max.createdAt?.toISOString() ?? null, serverTime: new Date().toISOString() });
  });

  /** 发消息时选单子：只列客户自己的 */
  app.get("/client/chat/refs", async (req, res) => {
    const auth = requireDirectClient(req, res);
    if (!auth) return;
    ok(res, await listChatRefs(auth.companyId, auth.userId, req.query.q));
  });

  app.get("/client/chat/push/key", async (req, res) => {
    if (!requireDirectClient(req, res)) return;
    pushKeyResponse(res);
  });
  app.post("/client/chat/push/subscribe", async (req, res) => {
    const auth = requireDirectClient(req, res);
    if (!auth) return;
    await savePushSubscription(auth, req.body, res);
  });
  app.post("/client/chat/push/unsubscribe", async (req, res) => {
    const auth = requireDirectClient(req, res);
    if (!auth) return;
    await deletePushSubscription(auth, req.body, res);
  });

  // ======================================================================
  // 员工 / 超管（共用一个收件箱）
  // ======================================================================
  app.get("/staff/chat/conversations", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const q = String(req.query.q ?? "").trim();
    /* filter=pending：只看待回复的（2026-10-02 老板：已读不回容易漏）。
       待回复 = 最新一条还在的消息是客户发的；划给代理的客户回不了，不算 */
    const pendingOnly = String(req.query.filter ?? "").trim() === "pending";
    const pendingWhere = { lastSenderRole: "client", client: { agentId: null } };
    const [convs, unread, pendingCount] = await Promise.all([
      prisma.csConversation.findMany({
        where: {
          companyId: auth.companyId,
          ...(q ? { clientId: { contains: q, mode: "insensitive" } } : {}),
          ...(pendingOnly ? pendingWhere : {}),
        },
        orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { id: "asc" }],
        // 多取一条判断到没到顶（CLAUDE.md 第 21 条：截断要说出来）
        take: CONVERSATION_LIST_LIMIT + 1,
        select: {
          id: true, clientId: true, lastMessageAt: true, lastMessagePreview: true, lastSenderRole: true,
          client: { select: { agentId: true } },
        },
      }),
      staffUnreadByConversation(auth.companyId),
      // 页签上的数字：全公司待回复几个（不跟着搜索走）
      prisma.csConversation.count({ where: { companyId: auth.companyId, ...pendingWhere } }),
    ]);
    const page = convs.slice(0, CONVERSATION_LIST_LIMIT);
    const pendingIds = page.filter((c) => c.lastSenderRole === "client" && c.client.agentId === null).map((c) => c.id);
    const since = await pendingSinceByConversation(pendingIds);
    ok(res, {
      /** 到顶了（只列最近这么多个对话）：页面要写出来，更早的用唛头搜 */
      truncated: convs.length > CONVERSATION_LIST_LIMIT,
      pendingCount,
      items: page.map((c) => {
        // 后来被划到代理名下的客户：记录留着能看，但不能再发
        const closed = c.client.agentId !== null;
        const pendingReply = c.lastSenderRole === "client" && !closed;
        return {
          clientId: c.clientId,
          lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
          lastMessagePreview: c.lastMessagePreview ?? "",
          /** 最新一条还在的是我们（员工 / 超管）发的：列表摘要前面写「我方：」 */
          lastFromUs: c.lastSenderRole !== null && c.lastSenderRole !== "client",
          unreadCount: unread.get(c.id)?.count ?? 0,
          closed,
          /** 客户说了话、我们还没回（看过也算没回） */
          pendingReply,
          /** 从什么时候开始等的（客户在我们最后一次回复之后发的第一条） */
          pendingSince: pendingReply ? since.get(c.id)?.toISOString() ?? null : null,
        };
      }),
    });
  });

  app.get("/staff/chat/messages", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const clientId = String(req.query.clientId ?? "").trim();
    if (!clientId) { fail(res, 400, "BAD_REQUEST", "请选择客户唛头"); return; }
    const conv = await prisma.csConversation.findUnique({
      where: { companyId_clientId: { companyId: auth.companyId, clientId } },
      select: { id: true, clientReadAt: true },
    });
    if (!conv) {
      // 还没聊过：确认唛头对不对，对就给个空窗口（员工可以先发第一条）
      const found = await findChatClient(auth.companyId, clientId);
      if ("error" in found) { fail(res, found.status, found.status === 404 ? "NOT_FOUND" : "BAD_REQUEST", found.error); return; }
      ok(res, { messages: [], hasMore: false, serverTime: new Date().toISOString(), peerReadAt: null });
      return;
    }
    const data = await loadMessages({ id: conv.id, companyId: auth.companyId, clientId }, req.query, res, auth);
    if (!data) return;
    // peerReadAt = 客户看到了哪一刻：客服这边发的（不管哪个员工发的）、不晚于它的显示「已读」（2026-10-02）
    ok(res, { ...data, serverTime: new Date().toISOString(), peerReadAt: conv.clientReadAt?.toISOString() ?? null });
  });

  app.post("/staff/chat/send", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as SendBody & { clientId?: unknown };
    const found = await findChatClient(auth.companyId, body.clientId);
    if ("error" in found) { fail(res, found.status, found.status === 404 ? "NOT_FOUND" : "VALIDATION_ERROR", found.error); return; }
    const parsed = parseSendBody(body);
    if ("error" in parsed) { fail(res, 400, "VALIDATION_ERROR", parsed.error); return; }
    const limited = sendRateLimited(auth.userId, parsed.image !== null);
    if (limited) { fail(res, 429, "BAD_REQUEST", limited); return; }
    const { msg, preview } = await sendMessage({ companyId: auth.companyId, clientId: found.clientId, sender: auth, staffName: auth.name || null, ...parsed });
    notifyChatMessage({ companyId: auth.companyId, clientId: found.clientId, fromRole: auth.role, preview });
    const live = await loadRefLive(auth.companyId, found.clientId, [msg]);
    ok(res, { message: toWireMessage(msg, auth, live) });
  });

  app.post("/staff/chat/recall", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as { clientId?: unknown; messageId?: unknown };
    const clientId = String(body.clientId ?? "").trim();
    const messageId = String(body.messageId ?? "").trim();
    if (!clientId || !messageId) { fail(res, 400, "BAD_REQUEST", "请选择要撤回的消息"); return; }
    const msg = await recallMessage({ companyId: auth.companyId, clientId, viewer: auth, messageId });
    ok(res, { message: toWireMessage(msg, auth) });
  });

  app.post("/staff/chat/read", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as { clientId?: unknown; upTo?: unknown };
    const clientId = String(body.clientId ?? "").trim();
    if (!clientId) { fail(res, 400, "BAD_REQUEST", "请选择客户唛头"); return; }
    const conv = await prisma.csConversation.findUnique({
      where: { companyId_clientId: { companyId: auth.companyId, clientId } },
      select: { id: true },
    });
    if (!conv) { ok(res, { ok: true }); return; }
    const issue = await markRead(conv.id, "staff", body.upTo);
    if (issue) { fail(res, 400, "BAD_REQUEST", issue); return; }
    ok(res, { ok: true });
  });

  app.get("/staff/chat/unread", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const unread = await staffUnreadByConversation(auth.companyId);
    let count = 0;
    let latest: Date | null = null;
    for (const u of unread.values()) {
      count += u.count;
      if (u.latest && (!latest || u.latest > latest)) latest = u.latest;
    }
    /* latestByClient：有未读的客户，各自最新一条没人看的是什么时候 —— 菜单按客户分开判断「有没有新来的」
       （dsh 第二轮复查 2026-10-02：原来只给一个全局最新时间，客户甲刚响过，客户乙稍早那条就再也不响了）。
       只给最近的 50 个（dsh 第三轮复查：这个接口 30 秒问一次、后台也问，几百个未读全带上一次要 20KB）——
       刚来的那条一定是最新的，排得进前 50；前端只拿它判断「有没有比记下的新」，更早的用不上。
       用没有原型的对象装：唛头是管理员自己填的，叫 __proto__ 这种名字的放进普通对象会被吞掉 */
    const latestByClient: Record<string, string> = Object.create(null);
    const recent = [...unread.values()]
      .filter((u) => u.latest && u.count > 0)
      .sort((a, b) => b.latest!.getTime() - a.latest!.getTime())
      .slice(0, 50);
    for (const u of recent) latestByClient[u.clientId] = u.latest!.toISOString();
    // latestAt：所有客户里最新一条没人看的消息是什么时候发的（2026-10-02）
    ok(res, { count, conversations: [...unread.values()].filter((u) => u.count > 0).length, latestAt: latest?.toISOString() ?? null, latestByClient, serverTime: new Date().toISOString() });
  });

  /** 发消息时选单子：只列这个客户的（代理名下的客户不开对话，也不列） */
  app.get("/staff/chat/refs", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const found = await findChatClient(auth.companyId, req.query.clientId);
    if ("error" in found) { fail(res, found.status, found.status === 404 ? "NOT_FOUND" : "BAD_REQUEST", found.error); return; }
    ok(res, await listChatRefs(auth.companyId, found.clientId, req.query.q));
  });

  app.get("/staff/chat/push/key", async (req, res) => {
    if (!requireRole(req, res, ["staff", "admin"])) return;
    pushKeyResponse(res);
  });
  app.post("/staff/chat/push/subscribe", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    await savePushSubscription(auth, req.body, res);
  });
  app.post("/staff/chat/push/unsubscribe", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    await deletePushSubscription(auth, req.body, res);
  });
}
