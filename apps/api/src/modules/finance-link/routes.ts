/* ==========================================================================
   对接海外仓财务系统（2026-11-04）：长期只读授权 + 运单状态
   --------------------------------------------------------------------------
   修改清单：刘雨江的项目/海外仓财务系统/docs/物流运单对接修改清单.md 第五、六节。

   铁规矩（改这个文件前逐条看）：
   1. 总开关 FINANCE_LINK_ENABLED 默认关；配置不合格按关闭处理（503 LINK_DISABLED）。
   2. 密码、长期授权、一次性码都不写日志；长期授权和一次性码数据库只存哈希。
   3. 运单范围只用代理端现成的 listScopedOrderIds / loadShipmentRows / loadAgentClients / readShipmentFilters，
      这里不另写一份规则（整柜、没审过的单、筛选条件都在那几个函数里）。
   4. 给出去的字段都在 views.ts 逐个列，不许 `...row`（CLAUDE.md #31）。
   5. 每次查运单都按账号现在的状态核对，不合格当场撤销（CLAUDE.md #38）。
   6. 客户名字不出物流系统（2026-11-04 老板选全部填唛头）：name、clientName 字段名沿用约定，值一律是唛头，这里压根不查 users.name。
   ========================================================================== */

import type { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import type { HttpRequest, HttpResponse, MinimalHttpApp } from "../../server";
import { listScopedOrderIds, loadAgentClients, loadShipmentRows, readShipmentFilters } from "../agent-portal/routes";
import { parsePageParam } from "../agent-portal/views";
import { verifyPassword } from "../auth/crypto-utils";
import { passwordFingerprint } from "../auth/token";
import type { AgentAuth } from "../core/agent-scope";
import { companyContainerNosForMasking } from "../core/container-nos";
import { fail } from "../core/http-utils";
import { logger } from "../core/logger";
import {
  checkRateLimit,
  clearLoginFailures,
  getClientIp,
  loginRetryAfterMs,
  rateLimitKey,
  recordLoginFailure,
} from "../core/rate-limit";
import {
  authorizeUrlOf,
  canAuthorize,
  codeHashOf,
  linkProblem,
  newAuthorizationId,
  newOpaqueValue,
  sha256Hex,
  shouldTouchLastUsed,
  type RevokedReason,
} from "./authorization";
import { bearerMatches, financeLinkConfig, type FinanceLinkConfig } from "./config";
import { ORDER_MONTH_INVALID, parseOrderMonth, type OrderMonthRange } from "./order-month";
import {
  AUTHORIZE_INFO_PATH,
  AUTHORIZE_SUBMIT_PATH,
  LINK_REQUESTS_PATH,
  LINK_TOKENS_PATH,
  LINK_TOKENS_REVOKE_PATH,
  WAYBILLS_PATH,
  WAYBILL_TRACK_PATH,
} from "./paths";
import { waybillStatusZh } from "./status-zh";
import { mapTrackChild, mapTrackLog, mapWaybillRow } from "./views";

const REQUEST_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 5 * 60_000;
const PAGE_SIZE_MAX = 100;
/** 同一个账号 + 同一个仓换授权时排队（号段接着 core/client-ban.ts 的 83070） */
const REAUTHORIZE_LOCK = 83080;
const NOT_FOUND = "运单不存在或不在这个账号范围内";
/** 跟财务系统约定账号不超过 100 位，超过的不让授权 */
const ACCOUNT_MAX_LEN = 100;
/** 授权页提交的字段上限：公网接口，超长的不查库、不算密码。比真实的值长得多（开客户账号没限密码长度，不能卡得比登录严） */
const AUTHORIZE_FIELD_MAX_LEN = 200;
const AUTHORIZE_PASSWORD_MAX_LEN = 1024;
const REQUEST_INVALID = "这个授权链接已失效，请回财务系统重新发起";

/** 错误响应：code、reason 放最外层，财务系统按它们判断（修改清单 5.7）。requestId、timestamp 由 server.ts 盖章 */
function linkError(res: HttpResponse, status: number, code: string, message: string, reason?: RevokedReason): void {
  res.status(status).json(reason ? { code, reason, message } : { code, message });
}

function disabled(res: HttpResponse): void {
  linkError(res, 503, "LINK_DISABLED", "财务系统对接没有打开");
}

function bodyOf(req: HttpRequest): Record<string, unknown> {
  const body = req.body;
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/** 字符串去首尾空格；不是字符串、空的、太长的、带控制字符的都当没有 */
function cleanText(value: unknown, maxLen: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > maxLen || /[\x00-\x1f\x7f]/.test(text)) return null;
  return text;
}

/** 开关 + 对接密钥。两样都过才放行 */
function requireFinanceSecret(req: HttpRequest, res: HttpResponse): FinanceLinkConfig | null {
  const cfg = financeLinkConfig();
  if (!cfg) { disabled(res); return null; }
  if (!bearerMatches(req.headers.authorization, cfg.secret)) {
    linkError(res, 401, "LINK_SECRET_INVALID", "对接密钥不对");
    return null;
  }
  return cfg;
}

function linkTokenOf(req: HttpRequest): string | null {
  const raw = req.headers["x-link-token"];
  return cleanText(Array.isArray(raw) ? raw[0] : raw, 200);
}

interface LinkedAccount {
  authorizationId: string;
  userId: string;
  companyId: string;
  role: "client" | "agent";
  agentId: string | null;
}

/** 写成已撤销并记下原因。只改还没撤销的：并发时原因以先写的为准 */
async function markRevoked(authorizationId: string, reason: RevokedReason): Promise<void> {
  await prisma.financeLinkAuthorization.updateMany({
    where: { id: authorizationId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}

/** 查运单的入口：开关 → 密钥 → 授权 → 账号现在的状态，全过才拿到账号 */
async function requireLink(req: HttpRequest, res: HttpResponse): Promise<LinkedAccount | null> {
  if (!requireFinanceSecret(req, res)) return null;
  const revoked = (reason: RevokedReason) => {
    linkError(res, 401, "LINK_REVOKED", "授权已失效，请重新登录物流账号", reason);
    return null;
  };
  const token = linkTokenOf(req);
  if (!token) return revoked("REVOKED");
  const authorization = await prisma.financeLinkAuthorization.findUnique({
    where: { tokenHash: sha256Hex(token) },
    select: { id: true, companyId: true, userId: true, role: true, passwordFingerprint: true, lastUsedAt: true, revokedAt: true, revokedReason: true },
  });
  if (!authorization) return revoked("REVOKED");
  if (authorization.revokedAt) return revoked((authorization.revokedReason as RevokedReason | null) ?? "REVOKED");

  const user = await prisma.user.findUnique({
    where: { id: authorization.userId },
    select: { companyId: true, role: true, status: true, passwordHash: true, agentId: true },
  });
  const problem = linkProblem(authorization, user);
  if (problem || !user) {
    await markRevoked(authorization.id, problem ?? "ACCOUNT_DISABLED");
    return revoked(problem ?? "ACCOUNT_DISABLED");
  }
  if (!canAuthorize(user.role)) return revoked("ROLE_CHANGED");

  const now = new Date();
  if (shouldTouchLastUsed(authorization.lastUsedAt, now)) {
    // 记不上不影响查运单
    await prisma.financeLinkAuthorization.update({ where: { id: authorization.id }, data: { lastUsedAt: now } }).catch((error: unknown) => {
      logger.warn("财务系统授权没记上最后使用时间", { 授权: authorization.id, 错误: error instanceof Error ? error.message.slice(0, 200) : String(error) });
    });
  }
  return {
    authorizationId: authorization.id,
    userId: authorization.userId,
    companyId: user.companyId,
    role: user.role,
    agentId: user.agentId ?? null,
  };
}

/**
 * 这个账号能看到谁的运单。代理 = 名下客户（现查，客户改归属当场生效）；普通客户 = 只有自己。
 * listScopedOrderIds / loadShipmentRows 只读 auth.companyId，loadAgentClients 另外读 agentId，
 * 所以普通客户也能用同一套函数（测试里钉着「只读这两个字段」）；agentId 为空时 loadAgentClients 回空，不会放大范围。
 */
async function loadLinkScope(link: LinkedAccount) {
  // 普通客户的 agentId 留空：客户可能归某个代理，这几个函数以后要是读了 agentId，也不会变成看那个代理名下全部客户
  const agentId = link.role === "agent" ? link.agentId ?? "" : "";
  const auth: AgentAuth = { userId: link.userId, companyId: link.companyId, role: "agent", name: "", agentId };
  const clientIds = link.role === "agent" ? (await loadAgentClients(auth)).map((c) => c.id) : [link.userId];
  // loadShipmentRows 要一张「唛头 → 显示名」，这里显示名也填唛头
  return { auth, clientIds, marksById: new Map(clientIds.map((id) => [id, id])) };
}

/** 一次 IN 列表最多放多少个订单 id，名下单子再多也不会把查询撑爆 */
const MONTH_FILTER_CHUNK = 5000;

/**
 * 范围内的订单再按下单时间（订单 createdAt）筛一遍月份，留下的照 listScopedOrderIds 原来的顺序（建单时间倒序）。
 * 不复用代理端的 dateFrom / dateTo：那组筛的是到仓日期 shipDate，不是下单时间。
 * chunk 只给连库测试用（拿小批数验证分批不丢、不重复、不乱序），接口里一律用默认值。
 */
export async function keepOrderMonth(companyId: string, orderIds: string[], range: OrderMonthRange, chunk = MONTH_FILTER_CHUNK): Promise<string[]> {
  if (!Number.isSafeInteger(chunk) || chunk < 1) throw new Error(`每批个数要是正整数：${String(chunk)}`); // 传 0 或负数循环不往前走
  const hit = new Set<string>();
  for (let i = 0; i < orderIds.length; i += chunk) {
    const rows = await prisma.order.findMany({
      where: { id: { in: orderIds.slice(i, i + chunk) }, companyId, createdAt: { gte: range.from, lt: range.to } },
      select: { id: true },
    });
    for (const row of rows) hit.add(row.id);
  }
  return orderIds.filter((id) => hit.has(id));
}

const TRACK_LOG_SELECT = {
  orderBy: { changedAt: "asc" },
  // ⚠️ 不选 operatorId / operatorName / operatorRole
  select: { toStatus: true, remark: true, nextStop: true, changedAt: true },
} satisfies Prisma.Shipment$statusLogsArgs;

/** 柜号只用来抹备注，不下发 */
const TRACK_CONTAINER_SELECT = {
  select: { container: { select: { containerNo: true } } },
} satisfies Prisma.Shipment$containerItemsArgs;

export function registerFinanceLinkRoutes(app: MinimalHttpApp): void {
  /* ===== 5.1 建授权请求（财务后端调） ===== */
  app.post(LINK_REQUESTS_PATH, async (req, res) => {
    if (!requireFinanceSecret(req, res)) return;
    const body = bodyOf(req);
    const warehouseRef = cleanText(body.warehouseRef, 128);
    const warehouseName = cleanText(body.warehouseName, 200);
    if (!warehouseRef || !warehouseName) { fail(res, 400, "BAD_REQUEST", "仓库编号和仓库名称必须填"); return; }

    const id = newOpaqueValue();
    const authorizeUrl = authorizeUrlOf(req.headers, id);
    if (!authorizeUrl) { fail(res, 400, "BAD_REQUEST", "请求的域名不对"); return; }

    const now = new Date();
    // 顺手删掉已过期的旧请求。请求过期了、但 5 分钟的码还没到点的先留着，不然用户刚登录完换授权会失败
    await prisma.financeLinkRequest.deleteMany({
      where: { expiresAt: { lt: now }, OR: [{ codeExpiresAt: null }, { codeExpiresAt: { lt: now } }] },
    });
    const expiresAt = new Date(now.getTime() + REQUEST_TTL_MS);
    await prisma.financeLinkRequest.create({ data: { id, warehouseRef, warehouseName, expiresAt } });
    res.status(201).json({ requestId: id, authorizeUrl, expiresAt: expiresAt.toISOString() });
  });

  /* ===== 5.2 授权页取信息（用户浏览器）。仓名只从数据库取，不从网址取 ===== */
  app.get(AUTHORIZE_INFO_PATH, async (req, res) => {
    if (!financeLinkConfig()) { disabled(res); return; }
    if (checkRateLimit(rateLimitKey(getClientIp(req.headers), "finance-link-request"), 60, 60_000)) {
      fail(res, 429, "BAD_REQUEST", "请求太频繁了，请 1 分钟后再试。");
      return;
    }
    const requestId = cleanText(req.query.request, 200);
    const row = requestId
      ? await prisma.financeLinkRequest.findUnique({ where: { id: requestId }, select: { warehouseName: true, expiresAt: true, userId: true } })
      : null;
    // 没有这个请求、过期、已经授权过：页面都只能让他回财务系统重来，说法一样
    if (!row || row.userId || row.expiresAt <= new Date()) {
      res.status(200).json({ warehouseName: null, expired: true });
      return;
    }
    res.status(200).json({ warehouseName: row.warehouseName, expired: false });
  });

  /* ===== 5.2 授权页提交（用户浏览器）。不签登录令牌，不留登录状态 ===== */
  app.post(AUTHORIZE_SUBMIT_PATH, async (req, res) => {
    const cfg = financeLinkConfig();
    if (!cfg) { disabled(res); return; }

    // 限流、失败计数、失败提示都跟 /auth/login 同一份（键也一样）：两边换着猜密码也是同一个计数
    const ip = getClientIp(req.headers);
    if (checkRateLimit(rateLimitKey(ip, "login"), 10, 60_000)) {
      fail(res, 429, "BAD_REQUEST", "登录尝试次数过多，请 1 分钟后再试。");
      return;
    }
    const raw = bodyOf(req);
    const asStr = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
    const requestId = asStr(raw.requestId);
    const account = asStr(raw.account);
    const password = asStr(raw.password);
    if (!account) { fail(res, 400, "BAD_REQUEST", "account is required"); return; }

    // 链接先核：拿不到有效链接的人，这里试不了密码，也探不出账号有没有被锁
    const pending = requestId && requestId.length <= AUTHORIZE_FIELD_MAX_LEN
      ? await prisma.financeLinkRequest.findUnique({ where: { id: requestId }, select: { id: true, expiresAt: true, userId: true } })
      : null;
    if (!pending || pending.userId || pending.expiresAt <= new Date()) {
      linkError(res, 400, "LINK_REQUEST_INVALID", REQUEST_INVALID);
      return;
    }
    if (account.length > AUTHORIZE_FIELD_MAX_LEN || password.length > AUTHORIZE_PASSWORD_MAX_LEN) {
      fail(res, 401, "UNAUTHORIZED", "invalid credentials");
      return;
    }
    const waitMs = loginRetryAfterMs(account);
    if (waitMs > 0) {
      const waitMin = Math.max(1, Math.ceil(waitMs / 60_000));
      fail(res, 429, "BAD_REQUEST", `这个账号密码错太多次了，请 ${waitMin} 分钟后再试。着急的话联系管理员重置密码。`);
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: account },
      select: { id: true, companyId: true, role: true, status: true, passwordHash: true },
    });
    if (!user || user.status !== "active" || !verifyPassword(password, user.passwordHash)) {
      recordLoginFailure(account);
      fail(res, 401, "UNAUTHORIZED", "invalid credentials");
      return;
    }
    clearLoginFailures(account);
    if (!canAuthorize(user.role) || user.id.length > ACCOUNT_MAX_LEN) {
      fail(res, 403, "FORBIDDEN", "这个账号不能授权");
      return;
    }

    const code = newOpaqueValue();
    // 只有还没人授权过、还没过期的请求能写上（并发两次只有一次成功）
    const claimed = await prisma.financeLinkRequest.updateMany({
      where: { id: pending.id, userId: null, expiresAt: { gt: new Date() } },
      data: { userId: user.id, codeHash: codeHashOf(code, user), codeExpiresAt: new Date(Date.now() + CODE_TTL_MS) },
    });
    if (claimed.count !== 1) {
      linkError(res, 400, "LINK_REQUEST_INVALID", REQUEST_INVALID);
      return;
    }
    // 跳回地址只读环境变量；两个参数放 # 后面，不进服务器日志和来源地址
    res.status(200).json({
      redirectUrl: `${cfg.returnUrl}#request=${encodeURIComponent(pending.id)}&code=${encodeURIComponent(code)}`,
    });
  });

  /* ===== 5.3 换长期授权（财务后端调） ===== */
  app.post(LINK_TOKENS_PATH, async (req, res) => {
    if (!requireFinanceSecret(req, res)) return;
    const invalid = () => linkError(res, 400, "LINK_CODE_INVALID", "一次性码已用过或已过期，请重新授权");
    const body = bodyOf(req);
    const requestId = cleanText(body.requestId, 200);
    const code = cleanText(body.code, 200);
    if (!requestId || !code) { invalid(); return; }

    const token = newOpaqueValue();
    const authorizationId = newAuthorizationId();
    const account = await prisma.$transaction(async (tx) => {
      // 锁排在写之前，账号在锁后读（CLAUDE.md #28：锁完重读，test:lock-order 钉着）。
      // 先按「账号 + 仓」排队（保证最后只有一条授权还有效），再给账号行加共享锁（这期间改密码、封禁要等这里提交，
      // 不会发出一个一用就失效的授权）。别的事务不碰排队那把锁，没有反着等的路，不会死锁。
      // 请求行不用锁：账号授权后就不再变，用掉一次性码靠下面的原子更新。
      const request = await tx.financeLinkRequest.findUnique({
        where: { id: requestId },
        select: { id: true, userId: true, warehouseRef: true, warehouseName: true },
      });
      if (!request?.userId) return null;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REAUTHORIZE_LOCK}::int, hashtext(${`${request.userId}:${request.warehouseRef}`}))`;
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${request.userId} FOR SHARE`;
      const user = await tx.user.findUnique({
        where: { id: request.userId },
        select: { id: true, companyId: true, role: true, status: true, passwordHash: true },
      });
      if (!user || user.status !== "active" || !canAuthorize(user.role)) return null;
      // 用掉一次性码：数据库原子更新，并发两次只有一次成功；后面出错整个回滚，码不算用掉
      const now = new Date();
      const used = await tx.financeLinkRequest.updateMany({
        where: { id: request.id, codeHash: codeHashOf(code, user), codeUsedAt: null, codeExpiresAt: { gt: now } },
        data: { codeUsedAt: now },
      });
      if (used.count !== 1) return null;
      // 再次授权：撤销旧的，发新的
      await tx.financeLinkAuthorization.updateMany({
        where: { userId: user.id, warehouseRef: request.warehouseRef, revokedAt: null },
        data: { revokedAt: now, revokedReason: "REVOKED" },
      });
      await tx.financeLinkAuthorization.create({
        data: {
          id: authorizationId,
          companyId: user.companyId,
          userId: user.id,
          warehouseRef: request.warehouseRef,
          warehouseName: request.warehouseName,
          tokenHash: sha256Hex(token),
          passwordFingerprint: passwordFingerprint(user.passwordHash),
          role: user.role,
        },
      });
      return { account: user.id, name: user.id, role: user.role };
    });
    if (!account) { invalid(); return; }
    res.status(200).json({ token, authorizationId, account });
  });

  /* ===== 5.6 撤销（财务后端调）。重复调用也是 200 ===== */
  app.post(LINK_TOKENS_REVOKE_PATH, async (req, res) => {
    if (!requireFinanceSecret(req, res)) return;
    const token = linkTokenOf(req);
    if (!token) { fail(res, 400, "BAD_REQUEST", "缺少 X-Link-Token"); return; }
    await prisma.financeLinkAuthorization.updateMany({
      where: { tokenHash: sha256Hex(token), revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: "REVOKED" },
    });
    res.status(200).json({ ok: true });
  });

  /* ===== 5.4 运单列表（财务后端调）。筛选规则沿用代理端运单列表 ===== */
  app.get(WAYBILLS_PATH, async (req, res) => {
    const link = await requireLink(req, res);
    if (!link) return;
    const page = parsePageParam(req.query.page, 1);
    if (page === null) { fail(res, 400, "BAD_REQUEST", "页码不合法"); return; }
    const pageSizeRaw = parsePageParam(req.query.pageSize, 50);
    if (pageSizeRaw === null) { fail(res, 400, "BAD_REQUEST", "每页条数不合法"); return; }
    const pageSize = Math.min(pageSizeRaw, PAGE_SIZE_MAX);
    const parsed = readShipmentFilters(req);
    if (typeof parsed === "string") { fail(res, 400, "BAD_REQUEST", parsed); return; }
    // 约定只有这四个筛选。日期不接：代理端那边 2026-99-99 这种写法过得了格式检查、算第二天时报错
    const filters = { trackingNo: parsed.trackingNo, clientId: parsed.clientId, statusGroup: parsed.statusGroup, keyword: parsed.keyword };
    // 下单月份另算（2026-11-07 代理利润第 1 轮，规则在 order-month.ts）：没传不筛；传了格式不对 400，不许 500
    const orderMonth = parseOrderMonth(req.query.orderMonth);
    if (orderMonth === null) { fail(res, 400, "BAD_REQUEST", ORDER_MONTH_INVALID); return; }

    const scope = await loadLinkScope(link);
    const scopedIds = await listScopedOrderIds(scope.auth, scope.clientIds, filters);
    // total 和分页都按筛完月份以后的算
    const allIds = orderMonth ? await keepOrderMonth(link.companyId, scopedIds, orderMonth) : scopedIds;
    const pageIds = allIds.slice((page - 1) * pageSize, page * pageSize);
    const rows = await loadShipmentRows(scope.auth, pageIds, scope.marksById);
    const isAgent = link.role === "agent";
    res.status(200).json({
      account: { account: link.userId, role: link.role },
      page,
      pageSize,
      total: allIds.length,
      clients: isAgent ? scope.clientIds.map((id) => ({ clientId: id, name: id })) : [],
      items: rows.map((row) => mapWaybillRow(row, isAgent)),
    });
  });

  /* ===== 5.5 单票轨迹（财务后端调）。不在范围、不存在、整柜都回同一个 404 ===== */
  app.get(WAYBILL_TRACK_PATH, async (req, res) => {
    const link = await requireLink(req, res);
    if (!link) return;
    const trackingNo = cleanText(req.query.trackingNo, 100);
    if (!trackingNo) { fail(res, 400, "BAD_REQUEST", "trackingNo is required"); return; }

    const scope = await loadLinkScope(link);
    // 范围跟列表同一个函数：列表里看不到的单（整柜、没审过的、不在名下的），轨迹也查不到
    const orderIds = await listScopedOrderIds(scope.auth, scope.clientIds, { trackingNo });
    if (orderIds.length === 0) { fail(res, 404, "NOT_FOUND", NOT_FOUND); return; }
    const shipment = await prisma.shipment.findFirst({
      where: { trackingNo, companyId: link.companyId, orderId: { in: orderIds } },
      select: {
        orderId: true,
        trackingNo: true,
        parentTrackingNo: true,
        currentStatus: true,
        statusLogs: TRACK_LOG_SELECT,
        containerItems: TRACK_CONTAINER_SELECT,
      },
    });
    if (!shipment) { fail(res, 404, "NOT_FOUND", NOT_FOUND); return; }

    const children = shipment.parentTrackingNo
      ? []
      : await prisma.shipment.findMany({
          // 子单只认同一张订单的（正常拆单就是同一张）：脏数据里挂在别家订单、没审过的单、整柜上的子单都不带出来。
          // 父单的订单上面已经过了范围函数，这里不用再判客户和审核
          where: {
            parentTrackingNo: shipment.trackingNo,
            companyId: link.companyId,
            orderId: shipment.orderId,
          },
          orderBy: { trackingNo: "asc" },
          select: { trackingNo: true, currentStatus: true, statusLogs: TRACK_LOG_SELECT, containerItems: TRACK_CONTAINER_SELECT },
        });
    // 这票货真实装过的柜号 + 本公司全部柜号；看的人自己的运单号不抹（规则在 core/container-nos.ts）
    const containerNos = await companyContainerNosForMasking(link.companyId, scope.clientIds, [
      ...shipment.containerItems.map((it) => it.container.containerNo),
      ...children.flatMap((child) => child.containerItems.map((it) => it.container.containerNo)),
    ]);
    // 父单轨迹 = 自己 + 全部子单，按时间合并（口径同 /client/shipments/track）
    const logs = [...shipment.statusLogs, ...children.flatMap((child) => child.statusLogs)]
      .sort((a, b) => a.changedAt.getTime() - b.changedAt.getTime())
      .map((log) => mapTrackLog(log, containerNos));
    res.status(200).json({
      trackingNo: shipment.trackingNo,
      currentStatus: shipment.currentStatus,
      statusZh: waybillStatusZh(shipment.currentStatus),
      logs,
      children: children.map(mapTrackChild),
    });
  });
}
