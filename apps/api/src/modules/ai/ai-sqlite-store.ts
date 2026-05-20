/**
 * ⚠️ DEPRECATED — 此文件已不再使用（2026-05-20）
 * 已被 ai-prisma-store.ts 取代。保留 1 个月作回滚缓冲，预计 2026-06-20 后删除。
 * 不要在任何地方 import 此文件。
 */
import type { DatabaseSync } from "node:sqlite";
import type {
  AiKnowledgeItem,
  AiQueryAuditLog,
  StatusLabelConfig,
} from "../../../../../packages/shared-types/entities";
import type { ShipmentStatus } from "../../../../../packages/shared-types/shipment-status";
import { DEFAULT_STATUS_LABELS } from "./ai-config-store";
import type {
  AiKnowledgeGapRecord,
  AiKnowledgeGapStore,
  AiKnowledgeStore,
  AuditStore,
  StatusLabelStore,
} from "./ai-types";

export class SqliteStatusLabelStore implements StatusLabelStore {
  private initialized = false;

  constructor(private readonly db: DatabaseSync) {}

  private ensureDefaults(): void {
    if (this.initialized) return;
    const row = this.db
      .prepare("SELECT COUNT(1) as count FROM ai_status_labels")
      .get() as { count: number };
    if (row.count === 0) {
      const now = new Date().toISOString();
      const stmt = this.db.prepare(
        "INSERT INTO ai_status_labels (status, label_zh, updated_at) VALUES (?, ?, ?)",
      );
      DEFAULT_STATUS_LABELS.forEach((item) => stmt.run(item.status, item.labelZh, now));
    }
    this.initialized = true;
  }

  async list(): Promise<StatusLabelConfig[]> {
    this.ensureDefaults();
    const rows = this.db
      .prepare("SELECT status, label_zh FROM ai_status_labels ORDER BY status ASC")
      .all() as Array<{ status: ShipmentStatus; label_zh: string }>;
    return rows.map((row) => ({ status: row.status, labelZh: row.label_zh }));
  }

  async getLabel(status: ShipmentStatus): Promise<string | undefined> {
    this.ensureDefaults();
    const row = this.db
      .prepare("SELECT label_zh FROM ai_status_labels WHERE status = ?")
      .get(status) as { label_zh: string } | undefined;
    return row?.label_zh;
  }

  async upsert(items: StatusLabelConfig[]): Promise<void> {
    this.ensureDefaults();
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO ai_status_labels (status, label_zh, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(status) DO UPDATE SET label_zh = excluded.label_zh, updated_at = excluded.updated_at
    `);
    items.forEach((item) => stmt.run(item.status, item.labelZh, now));
  }

  async resetDefaults(): Promise<void> {
    this.db.prepare("DELETE FROM ai_status_labels").run();
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      "INSERT INTO ai_status_labels (status, label_zh, updated_at) VALUES (?, ?, ?)",
    );
    DEFAULT_STATUS_LABELS.forEach((item) => stmt.run(item.status, item.labelZh, now));
    this.initialized = true;
  }
}

export class SqliteAiKnowledgeStore implements AiKnowledgeStore {
  constructor(private readonly db: DatabaseSync) {}

  async list(companyId: string): Promise<AiKnowledgeItem[]> {
    const rows = this.db
      .prepare(`
        SELECT id, company_id, title, content, created_by, created_at
        FROM ai_knowledge_items
        WHERE company_id = ?
        ORDER BY created_at DESC
      `)
      .all(companyId) as Array<{
      id: string;
      company_id: string;
      title: string;
      content: string;
      created_by: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      companyId: row.company_id,
      title: row.title,
      content: row.content,
      createdBy: row.created_by,
      createdAt: row.created_at,
    }));
  }

  async add(item: Omit<AiKnowledgeItem, "id" | "createdAt">): Promise<AiKnowledgeItem> {
    const created: AiKnowledgeItem = {
      ...item,
      id: `kn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(`
        INSERT INTO ai_knowledge_items (id, company_id, title, content, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        created.id,
        created.companyId,
        created.title,
        created.content,
        created.createdBy,
        created.createdAt,
      );
    return created;
  }

  async remove(companyId: string, id: string): Promise<boolean> {
    const result = this.db
      .prepare("DELETE FROM ai_knowledge_items WHERE company_id = ? AND id = ?")
      .run(companyId, id);
    return result.changes > 0;
  }
}

export class SqliteAiAuditStore implements AuditStore {
  constructor(private readonly db: DatabaseSync) {}

  async add(log: AiQueryAuditLog): Promise<void> {
    this.db
      .prepare(`
        INSERT INTO ai_audit_logs (
          id, user_id, company_id, session_id, question, answer_summary,
          referenced_order_ids, referenced_shipment_ids, queried_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        log.id,
        log.userId,
        log.companyId,
        log.sessionId ?? null,
        log.question,
        log.answerSummary,
        JSON.stringify(log.referencedOrderIds ?? []),
        JSON.stringify(log.referencedShipmentIds ?? []),
        log.queriedAt,
      );
  }

  async listByCompany(companyId: string): Promise<AiQueryAuditLog[]> {
    const rows = this.db
      .prepare(`
        SELECT
          id, user_id, company_id, session_id, question, answer_summary,
          referenced_order_ids, referenced_shipment_ids, queried_at
        FROM ai_audit_logs
        WHERE company_id = ?
        ORDER BY queried_at DESC
      `)
      .all(companyId) as Array<{
      id: string;
      user_id: string;
      company_id: string;
      session_id: string | null;
      question: string;
      answer_summary: string;
      referenced_order_ids: string | null;
      referenced_shipment_ids: string | null;
      queried_at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      companyId: row.company_id,
      sessionId: row.session_id ?? undefined,
      question: row.question,
      answerSummary: row.answer_summary,
      referencedOrderIds: this.parseJsonArray(row.referenced_order_ids),
      referencedShipmentIds: this.parseJsonArray(row.referenced_shipment_ids),
      queriedAt: row.queried_at,
    }));
  }

  private parseJsonArray(raw: string | null): string[] {
    if (!raw) return [];
    try {
      const value = JSON.parse(raw);
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  }
}

export class SqliteAiKnowledgeGapStore implements AiKnowledgeGapStore {
  constructor(private readonly db: DatabaseSync) {}

  async add(record: AiKnowledgeGapRecord): Promise<void> {
    this.db
      .prepare(`
        INSERT INTO ai_knowledge_gaps (
          id, company_id, user_id, session_id, question, answer_summary,
          knowledge_count_at_ask, status, created_at, resolved_at, resolved_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.id,
        record.companyId,
        record.userId,
        record.sessionId ?? null,
        record.question,
        record.answerSummary,
        record.knowledgeCountAtAsk,
        record.status,
        record.createdAt,
        record.resolvedAt ?? null,
        record.resolvedBy ?? null,
      );
  }

  async listByCompany(companyId: string, status?: "open" | "resolved"): Promise<AiKnowledgeGapRecord[]> {
    const rows = status
      ? (this.db
          .prepare(`
            SELECT
              id, company_id, user_id, session_id, question, answer_summary,
              knowledge_count_at_ask, status, created_at, resolved_at, resolved_by
            FROM ai_knowledge_gaps
            WHERE company_id = ? AND status = ?
            ORDER BY created_at DESC
          `)
          .all(companyId, status) as Array<{
          id: string;
          company_id: string;
          user_id: string;
          session_id: string | null;
          question: string;
          answer_summary: string;
          knowledge_count_at_ask: number;
          status: "open" | "resolved";
          created_at: string;
          resolved_at: string | null;
          resolved_by: string | null;
        }>)
      : (this.db
          .prepare(`
            SELECT
              id, company_id, user_id, session_id, question, answer_summary,
              knowledge_count_at_ask, status, created_at, resolved_at, resolved_by
            FROM ai_knowledge_gaps
            WHERE company_id = ?
            ORDER BY created_at DESC
          `)
          .all(companyId) as Array<{
          id: string;
          company_id: string;
          user_id: string;
          session_id: string | null;
          question: string;
          answer_summary: string;
          knowledge_count_at_ask: number;
          status: "open" | "resolved";
          created_at: string;
          resolved_at: string | null;
          resolved_by: string | null;
        }>);

    return rows.map((row) => ({
      id: row.id,
      companyId: row.company_id,
      userId: row.user_id,
      sessionId: row.session_id ?? undefined,
      question: row.question,
      answerSummary: row.answer_summary,
      knowledgeCountAtAsk: row.knowledge_count_at_ask,
      status: row.status,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at ?? undefined,
      resolvedBy: row.resolved_by ?? undefined,
    }));
  }

  async resolve(input: { companyId: string; id: string; resolvedBy: string }): Promise<boolean> {
    const result = this.db
      .prepare(`
        UPDATE ai_knowledge_gaps
        SET status = 'resolved', resolved_at = ?, resolved_by = ?
        WHERE company_id = ? AND id = ? AND status = 'open'
      `)
      .run(new Date().toISOString(), input.resolvedBy, input.companyId, input.id);
    return result.changes > 0;
  }
}
