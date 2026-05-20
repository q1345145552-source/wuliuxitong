// B-8: 已从 node:sqlite 迁移到 Prisma + PostgreSQL（2026-05-20）
// 把原 SqliteXxxStore 系列重写为 Prisma 版本，保持接口契约完全不变。
import type {
  AiKnowledgeItem,
  AiQueryAuditLog,
  StatusLabelConfig,
} from "../../../../../packages/shared-types/entities";
import type { ShipmentStatus } from "../../../../../packages/shared-types/shipment-status";
import { prisma } from "../../db/prisma";
import { DEFAULT_STATUS_LABELS } from "./ai-config-store";
import type {
  AiKnowledgeGapRecord,
  AiKnowledgeGapStore,
  AiKnowledgeStore,
  AiSessionMemoryRecord,
  AiSessionMemoryStore,
  AuditStore,
  StatusLabelStore,
} from "./ai-types";

function safeJsonParse(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

// ============ 状态标签 ============
export class PrismaStatusLabelStore implements StatusLabelStore {
  private initialized = false;

  private async ensureDefaults(): Promise<void> {
    if (this.initialized) return;
    const count = await prisma.aiStatusLabel.count();
    if (count === 0) {
      await prisma.aiStatusLabel.createMany({
        data: DEFAULT_STATUS_LABELS.map((item) => ({
          status: item.status,
          labelZh: item.labelZh,
        })),
      });
    }
    this.initialized = true;
  }

  async list(): Promise<StatusLabelConfig[]> {
    await this.ensureDefaults();
    const rows = await prisma.aiStatusLabel.findMany({
      orderBy: { status: "asc" },
    });
    return rows.map((row) => ({ status: row.status as ShipmentStatus, labelZh: row.labelZh }));
  }

  async getLabel(status: ShipmentStatus): Promise<string | undefined> {
    await this.ensureDefaults();
    const row = await prisma.aiStatusLabel.findUnique({ where: { status } });
    return row?.labelZh;
  }

  async upsert(items: StatusLabelConfig[]): Promise<void> {
    await this.ensureDefaults();
    await Promise.all(
      items.map((item) =>
        prisma.aiStatusLabel.upsert({
          where: { status: item.status },
          update: { labelZh: item.labelZh },
          create: { status: item.status, labelZh: item.labelZh },
        }),
      ),
    );
  }

  async resetDefaults(): Promise<void> {
    await prisma.$transaction([
      prisma.aiStatusLabel.deleteMany(),
      prisma.aiStatusLabel.createMany({
        data: DEFAULT_STATUS_LABELS.map((item) => ({
          status: item.status,
          labelZh: item.labelZh,
        })),
      }),
    ]);
    this.initialized = true;
  }
}

// ============ 知识库 ============
export class PrismaAiKnowledgeStore implements AiKnowledgeStore {
  async list(companyId: string): Promise<AiKnowledgeItem[]> {
    const rows = await prisma.aiKnowledgeItem.findMany({
      where: { companyId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((row) => ({
      id: row.id,
      companyId: row.companyId,
      title: row.title,
      content: row.content,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async add(item: Omit<AiKnowledgeItem, "id" | "createdAt">): Promise<AiKnowledgeItem> {
    const id = `kn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const created = await prisma.aiKnowledgeItem.create({
      data: {
        id,
        companyId: item.companyId,
        title: item.title,
        content: item.content,
        createdBy: item.createdBy,
      },
    });
    return {
      id: created.id,
      companyId: created.companyId,
      title: created.title,
      content: created.content,
      createdBy: created.createdBy,
      createdAt: created.createdAt.toISOString(),
    };
  }

  async remove(companyId: string, id: string): Promise<boolean> {
    const result = await prisma.aiKnowledgeItem.deleteMany({
      where: { companyId, id },
    });
    return result.count > 0;
  }
}

// ============ 审计日志 ============
export class PrismaAiAuditStore implements AuditStore {
  async add(log: AiQueryAuditLog): Promise<void> {
    await prisma.aiAuditLog.create({
      data: {
        id: log.id,
        userId: log.userId,
        companyId: log.companyId,
        sessionId: log.sessionId ?? null,
        question: log.question,
        answerSummary: log.answerSummary,
        referencedOrderIds: JSON.stringify(log.referencedOrderIds ?? []),
        referencedShipmentIds: JSON.stringify(log.referencedShipmentIds ?? []),
        queriedAt: new Date(log.queriedAt),
      },
    });
  }

  async listByCompany(companyId: string): Promise<AiQueryAuditLog[]> {
    const rows = await prisma.aiAuditLog.findMany({
      where: { companyId },
      orderBy: { queriedAt: "desc" },
    });
    return rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      companyId: row.companyId,
      sessionId: row.sessionId ?? undefined,
      question: row.question,
      answerSummary: row.answerSummary,
      referencedOrderIds: safeJsonParse(row.referencedOrderIds),
      referencedShipmentIds: safeJsonParse(row.referencedShipmentIds),
      queriedAt: row.queriedAt.toISOString(),
    }));
  }
}

// ============ 知识缺口（gaps）============
export class PrismaAiKnowledgeGapStore implements AiKnowledgeGapStore {
  async add(record: AiKnowledgeGapRecord): Promise<void> {
    await prisma.aiKnowledgeGap.create({
      data: {
        id: record.id,
        companyId: record.companyId,
        userId: record.userId,
        sessionId: record.sessionId ?? null,
        question: record.question,
        answerSummary: record.answerSummary,
        knowledgeCountAtAsk: record.knowledgeCountAtAsk,
        status: record.status,
        createdAt: new Date(record.createdAt),
        resolvedAt: record.resolvedAt ? new Date(record.resolvedAt) : null,
        resolvedBy: record.resolvedBy ?? null,
      },
    });
  }

  async listByCompany(companyId: string, status?: "open" | "resolved"): Promise<AiKnowledgeGapRecord[]> {
    const rows = await prisma.aiKnowledgeGap.findMany({
      where: status ? { companyId, status } : { companyId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((row) => ({
      id: row.id,
      companyId: row.companyId,
      userId: row.userId,
      sessionId: row.sessionId ?? undefined,
      question: row.question,
      answerSummary: row.answerSummary,
      knowledgeCountAtAsk: row.knowledgeCountAtAsk,
      status: row.status as "open" | "resolved",
      createdAt: row.createdAt.toISOString(),
      resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : undefined,
      resolvedBy: row.resolvedBy ?? undefined,
    }));
  }

  async resolve(input: { companyId: string; id: string; resolvedBy: string }): Promise<boolean> {
    const result = await prisma.aiKnowledgeGap.updateMany({
      where: { companyId: input.companyId, id: input.id, status: "open" },
      data: { status: "resolved", resolvedAt: new Date(), resolvedBy: input.resolvedBy },
    });
    return result.count > 0;
  }
}

// ============ 会话记忆 ============
export class PrismaAiSessionMemoryStore implements AiSessionMemoryStore {
  async get(key: string): Promise<AiSessionMemoryRecord | undefined> {
    const row = await prisma.aiSessionMemory.findUnique({ where: { key } });
    if (!row) return undefined;
    return {
      key: row.key,
      companyId: row.companyId,
      userId: row.userId,
      sessionId: row.sessionId,
      intent: (row.intent as "tracking" | "summary" | null) ?? undefined,
      itemName: row.itemName ?? undefined,
      statusScope:
        (row.statusScope as "all" | "inTransit" | "completed" | "unfinished" | "exception" | null) ??
        undefined,
      timeHint: row.timeHint ?? undefined,
      metric: (row.metric as "count" | "volume" | "weight" | "mixed" | null) ?? undefined,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async set(record: AiSessionMemoryRecord): Promise<void> {
    await prisma.aiSessionMemory.upsert({
      where: { key: record.key },
      update: {
        intent: record.intent ?? null,
        itemName: record.itemName ?? null,
        statusScope: record.statusScope ?? null,
        timeHint: record.timeHint ?? null,
        metric: record.metric ?? null,
      },
      create: {
        key: record.key,
        companyId: record.companyId,
        userId: record.userId,
        sessionId: record.sessionId,
        intent: record.intent ?? null,
        itemName: record.itemName ?? null,
        statusScope: record.statusScope ?? null,
        timeHint: record.timeHint ?? null,
        metric: record.metric ?? null,
      },
    });
  }

  async cleanupOlderThan(iso: string): Promise<void> {
    await prisma.aiSessionMemory.deleteMany({
      where: { updatedAt: { lt: new Date(iso) } },
    });
  }

  async listByCompany(companyId: string): Promise<AiSessionMemoryRecord[]> {
    const rows = await prisma.aiSessionMemory.findMany({
      where: { companyId },
      orderBy: { updatedAt: "desc" },
    });
    return rows.map((row) => ({
      key: row.key,
      companyId: row.companyId,
      userId: row.userId,
      sessionId: row.sessionId,
      intent: (row.intent as "tracking" | "summary" | null) ?? undefined,
      itemName: row.itemName ?? undefined,
      statusScope:
        (row.statusScope as "all" | "inTransit" | "completed" | "unfinished" | "exception" | null) ??
        undefined,
      timeHint: row.timeHint ?? undefined,
      metric: (row.metric as "count" | "volume" | "weight" | "mixed" | null) ?? undefined,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async removeByFilter(input: { companyId: string; sessionId?: string; userId?: string }): Promise<number> {
    const where: { companyId: string; sessionId?: string; userId?: string } = {
      companyId: input.companyId,
    };
    if (input.sessionId) where.sessionId = input.sessionId;
    if (input.userId) where.userId = input.userId;
    const result = await prisma.aiSessionMemory.deleteMany({ where });
    return result.count;
  }
}
