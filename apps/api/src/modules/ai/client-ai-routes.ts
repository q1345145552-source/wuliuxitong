// B-8: 已从 node:sqlite 迁移到 Prisma + PostgreSQL（2026-05-20）
import type {
  AiChatRequest,
  AiSuggestionResponse,
} from "../../../../../packages/shared-types/common-response";
import type { ApiResponse } from "../../../../../packages/shared-types/common-response";
import type { Shipment, StatusLabelConfig } from "../../../../../packages/shared-types/entities";
import { prisma } from "../../db/prisma";
import {
  PrismaAiAuditStore,
  PrismaAiKnowledgeGapStore,
  PrismaAiKnowledgeStore,
  PrismaAiSessionMemoryStore,
  PrismaStatusLabelStore,
} from "./ai-prisma-store";
import { ClientAiService, CHINA_OFFSET_MS } from "./ai-service";
import { HttpDeepSeekClient } from "./deepseek-client";
import type { AiOrder, AuthContext, QueryDataSource, QueryScope } from "./ai-types";
import type { HttpRequest, HttpResponse, MinimalHttpApp } from "../../server";
import { checkRateLimit, rateLimitKey } from "../core/rate-limit";
import { logger } from "../core/logger";
import { EXCLUDE_FCL_ORDER, EXCLUDE_FCL_SHIPMENT } from "../core/fcl-scope";

/**
 * AI 聊天的四道闸（2026-08-28 加，数值经用户确认）：
 * 每分钟 10 条 → 每天 200 条 → 单条 500 字 → sessionId 100 字。
 *
 * 🚨 `/client/ai/chat` 是全系统**唯一会直接花钱**的接口：
 * 每收到一条客户消息，代码固定调两次 DeepSeek —— 一次猜意图（ai-service.ts 的
 * parseIntentWithModel）、一次润色答复（refineAnswerWithModel），
 * 客户只说一句「你好」也照样两次。
 * 而在这之前它**一次限流都没有**，消息长度也不校验，请求体上限还是 20MB（server.ts）。
 * 登录接口 2026-08 就有限流了（每 IP 每分钟 10 次），真正花钱的这个反而一直裸着 ——
 * 任何一个客户账号写个循环，一晚上就能刷出巨额 DeepSeek 账单，没有任何东西拦得住。
 *
 * ⚠️ 限流按**账号**计数，不按 IP。这里的攻击者是已经登录进来的客户，
 * 按 IP 计数换个代理就绕过去了（登录接口那条 IP 限流正吃这个亏，见待办 B1）。
 * 改密码接口用的也是账号维度（auth/routes.ts 的 rateLimitKey(auth.userId, ...)）。
 */

/**
 * 数值都能用环境变量临时改，不用改代码重新发版；
 * 填了不合法的值（负数、写错字）就退回默认值并打一条日志，不会把闸门关死或敞开。
 */
function readLimit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    logger.warn(`[ai] 环境变量 ${name} 不是正整数，改用默认值`, { raw, fallback });
    return fallback;
  }
  return value;
}

const AI_CHAT_MAX_PER_MINUTE = readLimit("AI_CHAT_MAX_PER_MINUTE", 10);
/**
 * 每分钟 10 条挡得住「一秒刷一万次」，挡不住**慢慢刷**（一天 14400 条 × 2 次调用）。
 * 所以再加一条日上限。正常客户一天问不到 20 句，200 已经很宽。
 * 按**北京日历日**分桶（跟 AI 统计口径一致），到北京 0 点自动换新桶。
 *
 * ⚠️ 计数存在内存里（core/rate-limit.ts）：**API 一重启就清零**，
 * 多进程部署时也是各算各的。现在是单进程，够用；哪天上多实例要换成 Redis。
 */
const AI_CHAT_MAX_PER_DAY = readLimit("AI_CHAT_MAX_PER_DAY", 200);
/** ⚠️ 改这个值要同步改前端输入框的 maxLength（AiChatWidget.tsx），那边是写死的 500 */
const AI_CHAT_MAX_MESSAGE_CHARS = readLimit("AI_CHAT_MAX_MESSAGE_CHARS", 500);
/** sessionId 是客户端自己传的，会被当成 key 写进会话记忆表，必须卡长度 */
const AI_CHAT_MAX_SESSION_ID_CHARS = 100;

/** 北京日历日，形如 2026-08-28 —— 用来给日上限分桶 */
function beijingDayKey(): string {
  return new Date(Date.now() + CHINA_OFFSET_MS).toISOString().slice(0, 10);
}

class PrismaClientScopedDataSource implements QueryDataSource {
  async listOrders(scope: QueryScope): Promise<AiOrder[]> {
    const rows = await prisma.order.findMany({
      /* 整柜不算（老板 2026-09-23：整柜单独一块）。不排的话，客户在首页问
         「我有几票货在途」，AI 说 1 票、下面「我的运单」是 0 条，自己跟自己打架。 */
      where: { ...EXCLUDE_FCL_ORDER, companyId: scope.companyId, clientId: scope.clientId },
      orderBy: { createdAt: "desc" },
      // 品名统计要看**全部**货品行，不能只看 order.itemName（那只是第一个货品）。
      // 只取 itemName 一列，不会把整张货品行拉回来。
      // ⚠️ 嵌套查询也要带 companyId：order_products 的索引是
      // (company_id, order_id, sort_order)，只按 order_id 走用不上前导列。
      include: {
        products: {
          where: { companyId: scope.companyId },
          select: { itemName: true },
          orderBy: { sortOrder: "asc" },
        },
      },
    });

    return rows.map((r) => ({
      id: r.id,
      companyId: r.companyId,
      clientId: r.clientId,
      pickupAddressCn: "",
      deliveryAddressTh: "",
      receiverName: r.receiverNameTh ?? "",
      receiverPhone: r.receiverPhoneTh ?? "",
      serviceType: "standard",
      itemName: r.itemName,
      productQuantity: r.productQuantity ?? 0,
      packageCount: r.packageCount ?? 0,
      packageUnit: (r.packageUnit as "bag" | "box" | null) ?? "box",
      domesticTrackingNo: r.domesticTrackingNo ?? undefined,
      orderNo: r.orderNo ?? undefined,
      transportMode: (r.transportMode as "sea" | "land" | null) ?? undefined,
      warehouseId: r.warehouseId ?? undefined,
      batchNo: r.batchNo ?? undefined,
      weightKg: r.weightKg !== null ? Number(r.weightKg.toString()) : undefined,
      volumeM3: r.volumeM3 !== null ? Number(r.volumeM3.toString()) : undefined,
      receiverNameTh: r.receiverNameTh ?? undefined,
      receiverPhoneTh: r.receiverPhoneTh ?? undefined,
      receiverAddressTh: r.receiverAddressTh ?? undefined,
      statusGroup: (r.statusGroup as "unfinished" | "completed" | null) ?? undefined,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      productNames: r.products.map((p) => p.itemName),
    }));
  }

  async listShipments(scope: QueryScope): Promise<Shipment[]> {
    // Shipment 上没有 clientId，通过所属订单收窄到该客户
    const rows = await prisma.shipment.findMany({
      // 整柜不算（同上）
      where: { ...EXCLUDE_FCL_SHIPMENT, companyId: scope.companyId, order: { clientId: scope.clientId } },
      orderBy: { updatedAt: "desc" },
    });

    return rows.map((r) => ({
      id: r.id,
      companyId: r.companyId,
      orderId: r.orderId,
      trackingNo: r.trackingNo,
      parentTrackingNo: r.parentTrackingNo ?? undefined,
      currentStatus: r.currentStatus as Shipment["currentStatus"],
      currentLocation: r.currentLocation ?? undefined,
      weightKg: r.weightKg !== null ? Number(r.weightKg.toString()) : undefined,
      volumeM3: r.volumeM3 !== null ? Number(r.volumeM3.toString()) : undefined,
      packageCount: r.packageCount ?? undefined,
      packageUnit: (r.packageUnit as "bag" | "box" | null) ?? undefined,
      transportMode: (r.transportMode as "sea" | "land" | null) ?? undefined,
      domesticTrackingNo: r.domesticTrackingNo ?? undefined,
      warehouseId: r.warehouseId ?? undefined,
      batchNo: r.batchNo ?? undefined,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }
}

function jsonOk<T>(data: T): ApiResponse<T> {
  return {
    code: "OK",
    message: "success",
    data,
    timestamp: new Date().toISOString(),
  };
}

function jsonError(code: Exclude<ApiResponse<unknown>["code"], "OK">, message: string) {
  return {
    code,
    message,
    errors: [{ reason: message }],
    timestamp: new Date().toISOString(),
  };
}

export function registerClientAiRoutes(app: MinimalHttpApp): void {
  const auditStore = new PrismaAiAuditStore();
  const knowledgeGapStore = new PrismaAiKnowledgeGapStore();
  const statusLabelStore = new PrismaStatusLabelStore();
  const knowledgeStore = new PrismaAiKnowledgeStore();
  const memoryStore = new PrismaAiSessionMemoryStore();
  const service = new ClientAiService({
    dataSource: new PrismaClientScopedDataSource(),
    auditStore,
    knowledgeGapStore,
    llmClient: new HttpDeepSeekClient(),
    statusLabelStore,
    knowledgeStore,
    memoryStore,
  });

  app.post("/client/ai/chat", async (req, res) => {
    try {
      const auth = req.auth;
      if (!auth) {
        res.status(401).json(jsonError("UNAUTHORIZED", "missing auth context"));
        return;
      }

      // 先限流再干别的：这一步之后的任何一条路都可能触发两次 DeepSeek 调用。
      // ⚠️ 前端 apiRequest 遇到 429 会自动重试 2 次（core-api.ts），
      // 重试也会走到这里 +1，但不会再往后走、不花钱，窗口也不会被延长。
      if (checkRateLimit(rateLimitKey(auth.userId, "ai-chat"), AI_CHAT_MAX_PER_MINUTE, 60_000)) {
        logger.warn("[ai] 聊天限流触发", { userId: auth.userId, companyId: auth.companyId });
        res
          .status(429)
          .json(
            jsonError(
              "BAD_REQUEST",
              `问得有点快，请稍等一会儿再问（每分钟最多 ${AI_CHAT_MAX_PER_MINUTE} 条）`,
            ),
          );
        return;
      }
      if (
        checkRateLimit(
          rateLimitKey(auth.userId, `ai-chat-day-${beijingDayKey()}`),
          AI_CHAT_MAX_PER_DAY,
          24 * 60 * 60_000,
        )
      ) {
        logger.warn("[ai] 聊天日上限触发", { userId: auth.userId, companyId: auth.companyId });
        res
          .status(429)
          .json(
            jsonError(
              "BAD_REQUEST",
              `今天问得比较多了（每天最多 ${AI_CHAT_MAX_PER_DAY} 条），明天再来，或者直接联系客服。`,
            ),
          );
        return;
      }

      // 只挑出接口真正要用的两个字段，不把整个 body 原样往下传
      const rawBody = (req.body ?? {}) as Record<string, unknown>;
      const message = typeof rawBody.message === "string" ? rawBody.message : "";
      if (message.length > AI_CHAT_MAX_MESSAGE_CHARS) {
        res
          .status(400)
          .json(
            jsonError(
              "BAD_REQUEST",
              `一次最多问 ${AI_CHAT_MAX_MESSAGE_CHARS} 个字，请把问题说得短一些`,
            ),
          );
        return;
      }
      const sessionId = typeof rawBody.sessionId === "string" ? rawBody.sessionId : undefined;
      if (sessionId && sessionId.length > AI_CHAT_MAX_SESSION_ID_CHARS) {
        res.status(400).json(jsonError("BAD_REQUEST", "会话标识不合法，请刷新页面后重试"));
        return;
      }

      // Company scope is enforced by service-level query filtering.
      const response = await service.chat({
        auth,
        body: { message, sessionId } satisfies AiChatRequest,
      });
      res.status(200).json(jsonOk(response));
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      if (message.startsWith("BAD_REQUEST:")) {
        res.status(400).json(jsonError("BAD_REQUEST", message.replace("BAD_REQUEST:", "").trim()));
        return;
      }
      if (message === "FORBIDDEN_ROLE") {
        res.status(403).json(jsonError("FORBIDDEN", "only client role can use ai chat"));
        return;
      }
      // 2026-08-31：这里以前把程序内部的英文报错原文直接发到客户聊天框
      //（可能带表名等内部细节）。真实报错只进服务器日志，给客户一句固定中文。
      logger.error("[ai] 聊天接口内部错误", {
        userId: req.auth?.userId,
        companyId: req.auth?.companyId,
        error: message,
        stack: error instanceof Error ? error.stack : undefined,
      });
      res.status(500).json(jsonError("INTERNAL_ERROR", "系统开小差了，请稍后再试"));
    }
  });

  app.get("/client/ai/suggestions", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json(jsonError("UNAUTHORIZED", "missing auth context"));
      return;
    }
    if (auth.role !== "client") {
      res.status(403).json(jsonError("FORBIDDEN", "only client role can use ai suggestions"));
      return;
    }
    const data: AiSuggestionResponse = service.getSuggestions();
    res.status(200).json(jsonOk(data));
  });

  app.get("/admin/ai/audit-logs", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json(jsonError("UNAUTHORIZED", "missing auth context"));
      return;
    }
    if (auth.role !== "admin") {
      res.status(403).json(jsonError("FORBIDDEN", "only admin can read ai audit logs"));
      return;
    }

    const companyId = auth.companyId;
    const logs = await auditStore.listByCompany(companyId);
    res.status(200).json(jsonOk(logs));
  });

  app.get("/admin/ai/knowledge-gaps", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json(jsonError("UNAUTHORIZED", "missing auth context"));
      return;
    }
    if (auth.role !== "admin") {
      res.status(403).json(jsonError("FORBIDDEN", "only admin can read ai knowledge gaps"));
      return;
    }
    const companyId = auth.companyId;
    const statusRaw = req.query?.status?.trim();
    const status = statusRaw === "open" || statusRaw === "resolved" ? statusRaw : undefined;
    const list = await knowledgeGapStore.listByCompany(companyId, status);
    res.status(200).json(jsonOk({ items: list, total: list.length, status: status ?? "all" }));
  });

  app.post("/admin/ai/knowledge-gaps/resolve", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json(jsonError("UNAUTHORIZED", "missing auth context"));
      return;
    }
    if (auth.role !== "admin") {
      res.status(403).json(jsonError("FORBIDDEN", "only admin can resolve ai knowledge gaps"));
      return;
    }
    const payload = (req.body ?? {}) as { id?: string; companyId?: string };
    const id = payload.id?.trim();
    if (!id) {
      res.status(400).json(jsonError("BAD_REQUEST", "id is required"));
      return;
    }
    const companyId = auth.companyId;
    const okResolved = await knowledgeGapStore.resolve({
      companyId,
      id,
      resolvedBy: auth.userId,
    });
    if (!okResolved) {
      res.status(404).json(jsonError("NOT_FOUND", "knowledge gap not found or already resolved"));
      return;
    }
    res.status(200).json(jsonOk({ resolved: true, id }));
  });

  app.get("/admin/ai/session-memory", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json(jsonError("UNAUTHORIZED", "missing auth context"));
      return;
    }
    if (auth.role !== "admin") {
      res.status(403).json(jsonError("FORBIDDEN", "only admin can read ai session memory"));
      return;
    }
    const companyId = auth.companyId;
    const limitRaw = req.query?.limit?.trim();
    const limit = limitRaw ? Number(limitRaw) : 200;
    const safeLimit = Number.isNaN(limit) ? 200 : Math.max(1, Math.min(limit, 1000));
    const list = await memoryStore.listByCompany(companyId);
    res.status(200).json(jsonOk({ items: list.slice(0, safeLimit), total: list.length, limit: safeLimit }));
  });

  app.delete("/admin/ai/session-memory", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json(jsonError("UNAUTHORIZED", "missing auth context"));
      return;
    }
    if (auth.role !== "admin") {
      res.status(403).json(jsonError("FORBIDDEN", "only admin can clear ai session memory"));
      return;
    }
    const companyId = auth.companyId;
    const sessionId = req.query?.sessionId?.trim() || undefined;
    const userId = req.query?.userId?.trim() || undefined;
    const removed = await memoryStore.removeByFilter({ companyId, sessionId, userId });
    res.status(200).json(
      jsonOk({
        removed,
        companyId,
        sessionId: sessionId ?? null,
        userId: userId ?? null,
      }),
    );
  });

  app.get("/admin/system/status-labels", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json(jsonError("UNAUTHORIZED", "missing auth context"));
      return;
    }
    if (auth.role !== "admin") {
      res.status(403).json(jsonError("FORBIDDEN", "only admin can manage status labels"));
      return;
    }
    const items = await statusLabelStore.list();
    res.status(200).json(jsonOk(items));
  });

  app.post("/admin/system/status-labels", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json(jsonError("UNAUTHORIZED", "missing auth context"));
      return;
    }
    if (auth.role !== "admin") {
      res.status(403).json(jsonError("FORBIDDEN", "only admin can manage status labels"));
      return;
    }
    const payload = (req.body ?? {}) as { items?: StatusLabelConfig[] };
    const items = payload.items ?? [];
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json(jsonError("BAD_REQUEST", "items is required"));
      return;
    }
    await statusLabelStore.upsert(items);
    res.status(200).json(jsonOk({ updated: items.length }));
  });

  app.post("/admin/system/status-labels/reset", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json(jsonError("UNAUTHORIZED", "missing auth context"));
      return;
    }
    if (auth.role !== "admin") {
      res.status(403).json(jsonError("FORBIDDEN", "only admin can manage status labels"));
      return;
    }
    await statusLabelStore.resetDefaults();
    const items = await statusLabelStore.list();
    res.status(200).json(jsonOk({ reset: true, total: items.length }));
  });

  app.get("/admin/ai/knowledge", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json(jsonError("UNAUTHORIZED", "missing auth context"));
      return;
    }
    if (auth.role !== "admin") {
      res.status(403).json(jsonError("FORBIDDEN", "only admin can read ai knowledge"));
      return;
    }
    const companyId = auth.companyId;
    const items = await knowledgeStore.list(companyId);
    res.status(200).json(jsonOk(items));
  });

  app.post("/admin/ai/knowledge", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json(jsonError("UNAUTHORIZED", "missing auth context"));
      return;
    }
    if (auth.role !== "admin") {
      res.status(403).json(jsonError("FORBIDDEN", "only admin can feed ai knowledge"));
      return;
    }
    const payload = (req.body ?? {}) as { title?: string; content?: string; companyId?: string };
    if (!payload.title?.trim() || !payload.content?.trim()) {
      res.status(400).json(jsonError("BAD_REQUEST", "title and content are required"));
      return;
    }
    const companyId = auth.companyId;
    const created = await knowledgeStore.add({
      companyId,
      title: payload.title.trim(),
      content: payload.content.trim(),
      createdBy: auth.userId,
    });
    res.status(200).json(jsonOk(created));
  });

  app.delete("/admin/ai/knowledge", async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json(jsonError("UNAUTHORIZED", "missing auth context"));
      return;
    }
    if (auth.role !== "admin") {
      res.status(403).json(jsonError("FORBIDDEN", "only admin can delete ai knowledge"));
      return;
    }
    const id = req.query?.id?.trim();
    if (!id) {
      res.status(400).json(jsonError("BAD_REQUEST", "id is required"));
      return;
    }
    const companyId = auth.companyId;
    const deleted = await knowledgeStore.remove(companyId, id);
    if (!deleted) {
      res.status(404).json(jsonError("NOT_FOUND", "knowledge item not found"));
      return;
    }
    res.status(200).json(jsonOk({ deleted: true, id }));
  });
}
