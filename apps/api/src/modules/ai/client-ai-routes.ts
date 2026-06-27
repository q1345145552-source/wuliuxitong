// B-8: 已从 node:sqlite 迁移到 Prisma + PostgreSQL（2026-05-20）
import type {
  AiChatRequest,
  AiSuggestionResponse,
} from "../../../../../packages/shared-types/common-response";
import type { ApiResponse } from "../../../../../packages/shared-types/common-response";
import type { Order, Shipment, StatusLabelConfig } from "../../../../../packages/shared-types/entities";
import { prisma } from "../../db/prisma";
import {
  PrismaAiAuditStore,
  PrismaAiKnowledgeGapStore,
  PrismaAiKnowledgeStore,
  PrismaAiSessionMemoryStore,
  PrismaStatusLabelStore,
} from "./ai-prisma-store";
import { ClientAiService } from "./ai-service";
import { HttpDeepSeekClient } from "./deepseek-client";
import type { AuthContext, QueryDataSource } from "./ai-types";
import type { HttpRequest, HttpResponse, MinimalHttpApp } from "../../server";



class PrismaCompanyScopedDataSource implements QueryDataSource {
  async listOrders(scope: { companyId: string }): Promise<Order[]> {
    const rows = await prisma.order.findMany({
      where: { companyId: scope.companyId },
      orderBy: { createdAt: "desc" },
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
    }));
  }

  async listShipments(scope: { companyId: string }): Promise<Shipment[]> {
    const rows = await prisma.shipment.findMany({
      where: { companyId: scope.companyId },
      orderBy: { updatedAt: "desc" },
    });

    return rows.map((r) => ({
      id: r.id,
      companyId: r.companyId,
      orderId: r.orderId,
      trackingNo: r.trackingNo,
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
    dataSource: new PrismaCompanyScopedDataSource(),
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

      // Company scope is enforced by service-level query filtering.
      const response = await service.chat({
        auth,
        body: (req.body ?? {}) as AiChatRequest,
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
      res.status(500).json(jsonError("INTERNAL_ERROR", message));
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
