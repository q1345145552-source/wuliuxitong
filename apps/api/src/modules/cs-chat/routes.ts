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
 *   · 客户那边，员工 / 超管发的消息一律显示「客服」；员工名字只给超管看（2026-09-15「操作人身份只给超管看」）。
 *     员工那边看客户只显示唛头（2026-09-19「唛头=账号」）。
 *   · 只有湘泰自己的客户能用：代理名下的客户碰 /client/chat/* 在 server.ts 那道统一闸就被挡
 *     （core/agent-scope.ts 的 AGENT_CLIENT_BLOCKED_PREFIXES），这里每个客户接口再挡一次；
 *     员工也不能给代理名下的客户发。代理本人（role=agent）本来就碰不到 /client、/staff。
 *   · 消息「秒到」靠页面轮询（聊天窗口开着 2~3 秒一次）。生产是 nginx → Next 转发 → 接口，
 *     Next 的 rewrites 转不了 WebSocket，所以不做推送。
 *   · 轮询按时间取「比我手里最新那条还新的」，**往前多取 5 秒**、前端按 id 去重：
 *     两个人同一瞬间发、提交先后跟时间先后不一致时，不会漏掉那一条。
 *   · 未读用时间点记（*_read_at），不用计数器：读到哪条就把自己那一侧推到那条的时间，只往前推不往回退。
 *
 * ⚠️ 接口路径比页面路径深一层（页面 /client/chat、/staff/chat；接口 /client/chat/xxx）——
 *    next.config.ts 的 rewrite 是「页面匹配不上才转发给接口」，同名会被页面吃掉（CLAUDE.md 第 5 条）。
 */
import { randomUUID } from "node:crypto";
import { prisma } from "../../db/prisma";
import type { HttpRequest, HttpResponse, MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { AGENT_CLIENT_BLOCKED_MESSAGE } from "../core/agent-scope";
import { canSeeOperatorIdentity } from "../core/operator-visibility";
import { deleteImageFile, saveImageToDisk } from "../orders/image-storage";

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

type Auth = NonNullable<HttpRequest["auth"]>;

type MessageRow = {
  id: string;
  senderId: string;
  senderRole: string;
  senderName: string | null;
  content: string | null;
  imagePath: string | null;
  createdAt: Date;
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
};

export function toWireMessage(m: MessageRow, viewer: Pick<Auth, "userId" | "role">): WireMessage {
  const side: "client" | "cs" = m.senderRole === "client" ? "client" : "cs";
  const mine = m.senderId === viewer.userId;
  let senderLabel: string;
  if (mine) senderLabel = "我";
  else if (side === "client") senderLabel = m.senderId; // 唛头
  else if (canSeeOperatorIdentity(viewer.role)) senderLabel = m.senderName ? `${CS_LABEL}·${m.senderName}` : CS_LABEL;
  else senderLabel = CS_LABEL;
  return {
    id: m.id,
    side,
    mine,
    senderLabel,
    content: m.content,
    imageUrl: m.imagePath,
    createdAt: m.createdAt.toISOString(),
  };
}

const MESSAGE_SELECT = {
  id: true, senderId: true, senderRole: true, senderName: true, content: true, imagePath: true, createdAt: true,
} as const;

/** 列表里那一行的摘要：文字取前 60 个字，只有图片就写 [图片] */
export function previewOf(content: string | null, hasImage: boolean): string {
  const text = (content ?? "").replace(/\s+/g, " ").trim();
  if (text) return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  return hasImage ? "[图片]" : "";
}

/** 解析 ISO 时间参数；空 = undefined，乱写 = null（调用处 400） */
function parseTimeParam(raw: unknown): Date | undefined | null {
  if (raw === undefined || raw === null || String(raw).trim() === "") return undefined;
  const d = new Date(String(raw).trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

type SendBody = { content?: unknown; image?: { fileName?: unknown; mime?: unknown; base64?: unknown } | null };

/** 校验要发的内容；通过就返回整理好的文字 + 图片 */
export function parseSendBody(body: SendBody): { error: string } | { content: string | null; image: { mime: string; base64: string } | null } {
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
    image = { mime, base64 };
  }
  if (!content && !image) return { error: "不能发空消息" };
  return { content: content || null, image };
}

/**
 * 同一个客户的对话排队写（咨询锁 83040 + 按「公司:唛头」哈希）。
 * 为什么要锁：两个人同一瞬间发，谁先拿到时间、谁先提交可能不一致；排队以后「时间先后 = 写进去的先后」，
 * 轮询按时间取就不会漏；第一条同时发时也不会同时去建对话。只锁这一个客户，别的客户不受影响。
 * 登记在 scripts/test-lock-order.ts 的 LOCK_HELPERS（那边会去函数体里核实锁真的在）。
 */
async function lockCsConversation(
  tx: { $executeRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> },
  companyId: string,
  clientId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(83040, hashtext(${`${companyId}:${clientId}`}))`;
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
  /** 员工 / 超管发的才传名字（只给超管看）；客户发的传 null —— 客户那条显示唛头就够了 */
  staffName: string | null;
  content: string | null;
  image: { mime: string; base64: string } | null;
}): Promise<MessageRow> {
  const imagePath = opts.image ? saveImageToDisk(`cs_${opts.clientId}`, opts.image.mime, opts.image.base64) : null;
  const preview = previewOf(opts.content, imagePath !== null);
  try {
    return await prisma.$transaction(async (tx) => {
      await lockCsConversation(tx, opts.companyId, opts.clientId);
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
        },
        select: MESSAGE_SELECT,
      });
      await tx.csConversation.update({
        where: { id: conv.id },
        data: { lastMessageAt: now, lastMessagePreview: preview, lastSenderRole: opts.sender.role },
      });
      return msg;
    });
  } catch (e) {
    if (imagePath) {
      try { deleteImageFile(imagePath); } catch { /* 删不掉就算了，不影响报错 */ }
    }
    throw e;
  }
}

/** 取消息：since（轮询取新的，带 5 秒重叠）/ before（往上翻更早的）/ 都不传（最近 50 条） */
async function loadMessages(conversationId: string, query: HttpRequest["query"], res: HttpResponse, viewer: Auth): Promise<{ messages: WireMessage[]; hasMore: boolean } | null> {
  const since = parseTimeParam(query.since);
  const before = parseTimeParam(query.before);
  if (since === null || before === null) { fail(res, 400, "BAD_REQUEST", "时间参数不对"); return null; }
  if (since) {
    const rows = await prisma.csMessage.findMany({
      where: { conversationId, createdAt: { gte: new Date(since.getTime() - POLL_OVERLAP_MS) } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 500,
      select: MESSAGE_SELECT,
    });
    return { messages: rows.map((m) => toWireMessage(m, viewer)), hasMore: false };
  }
  const rows = await prisma.csMessage.findMany({
    where: { conversationId, ...(before ? { createdAt: { lt: before } } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: PAGE_SIZE + 1,
    select: MESSAGE_SELECT,
  });
  const hasMore = rows.length > PAGE_SIZE;
  const page = rows.slice(0, PAGE_SIZE).reverse();
  return { messages: page.map((m) => toWireMessage(m, viewer)), hasMore };
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

/** 客服这一侧每条对话的未读数（客户发的、晚于 staff_read_at 的条数）。列名是本次迁移自己建的，已核 */
async function staffUnreadByConversation(companyId: string): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<Array<{ id: string; unread: number }>>`
    SELECT c.id, COUNT(m.id)::int AS unread
    FROM cs_conversations c
    JOIN cs_messages m ON m.conversation_id = c.id
      AND m.sender_role = 'client'
      AND (c.staff_read_at IS NULL OR m.created_at > c.staff_read_at)
    WHERE c.company_id = ${companyId}
    GROUP BY c.id`;
  return new Map(rows.map((r) => [r.id, Number(r.unread)]));
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

export function registerCsChatRoutes(app: MinimalHttpApp): void {
  // ======================================================================
  // 客户
  // ======================================================================
  app.get("/client/chat/messages", async (req, res) => {
    const auth = requireDirectClient(req, res);
    if (!auth) return;
    const conv = await prisma.csConversation.findUnique({
      where: { companyId_clientId: { companyId: auth.companyId, clientId: auth.userId } },
      select: { id: true },
    });
    if (!conv) { ok(res, { messages: [], hasMore: false, serverTime: new Date().toISOString() }); return; }
    const data = await loadMessages(conv.id, req.query, res, auth);
    if (!data) return;
    ok(res, { ...data, serverTime: new Date().toISOString() });
  });

  app.post("/client/chat/send", async (req, res) => {
    const auth = requireDirectClient(req, res);
    if (!auth) return;
    const parsed = parseSendBody((req.body ?? {}) as SendBody);
    if ("error" in parsed) { fail(res, 400, "VALIDATION_ERROR", parsed.error); return; }
    const msg = await sendMessage({ companyId: auth.companyId, clientId: auth.userId, sender: auth, staffName: null, ...parsed });
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
    if (!conv) { ok(res, { count: 0 }); return; }
    const count = await prisma.csMessage.count({
      where: {
        conversationId: conv.id,
        senderRole: { not: "client" },
        ...(conv.clientReadAt ? { createdAt: { gt: conv.clientReadAt } } : {}),
      },
    });
    ok(res, { count });
  });

  // ======================================================================
  // 员工 / 超管（共用一个收件箱）
  // ======================================================================
  app.get("/staff/chat/conversations", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const q = String(req.query.q ?? "").trim();
    const [convs, unread] = await Promise.all([
      prisma.csConversation.findMany({
        where: { companyId: auth.companyId, ...(q ? { clientId: { contains: q, mode: "insensitive" } } : {}) },
        orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { id: "asc" }],
        take: 500,
        select: {
          id: true, clientId: true, lastMessageAt: true, lastMessagePreview: true, lastSenderRole: true,
          client: { select: { agentId: true } },
        },
      }),
      staffUnreadByConversation(auth.companyId),
    ]);
    ok(res, {
      items: convs.map((c) => ({
        clientId: c.clientId,
        lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
        lastMessagePreview: c.lastMessagePreview ?? "",
        lastFromClient: c.lastSenderRole === "client",
        unreadCount: unread.get(c.id) ?? 0,
        // 后来被划到代理名下的客户：记录留着能看，但不能再发
        closed: c.client.agentId !== null,
      })),
    });
  });

  app.get("/staff/chat/messages", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const clientId = String(req.query.clientId ?? "").trim();
    if (!clientId) { fail(res, 400, "BAD_REQUEST", "请选择客户唛头"); return; }
    const conv = await prisma.csConversation.findUnique({
      where: { companyId_clientId: { companyId: auth.companyId, clientId } },
      select: { id: true },
    });
    if (!conv) {
      // 还没聊过：确认唛头对不对，对就给个空窗口（员工可以先发第一条）
      const found = await findChatClient(auth.companyId, clientId);
      if ("error" in found) { fail(res, found.status, found.status === 404 ? "NOT_FOUND" : "BAD_REQUEST", found.error); return; }
      ok(res, { messages: [], hasMore: false, serverTime: new Date().toISOString() });
      return;
    }
    const data = await loadMessages(conv.id, req.query, res, auth);
    if (!data) return;
    ok(res, { ...data, serverTime: new Date().toISOString() });
  });

  app.post("/staff/chat/send", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as SendBody & { clientId?: unknown };
    const found = await findChatClient(auth.companyId, body.clientId);
    if ("error" in found) { fail(res, found.status, found.status === 404 ? "NOT_FOUND" : "VALIDATION_ERROR", found.error); return; }
    const parsed = parseSendBody(body);
    if ("error" in parsed) { fail(res, 400, "VALIDATION_ERROR", parsed.error); return; }
    const msg = await sendMessage({ companyId: auth.companyId, clientId: found.clientId, sender: auth, staffName: auth.name || null, ...parsed });
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
    for (const n of unread.values()) count += n;
    ok(res, { count, conversations: [...unread.values()].filter((n) => n > 0).length });
  });
}
