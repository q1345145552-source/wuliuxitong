/**
 * ⚠️ DEPRECATED — 此文件已不再使用（2026-05-20）
 * 已被 ai-prisma-store.ts 取代。保留 1 个月作回滚缓冲，预计 2026-06-20 后删除。
 * 不要在任何地方 import 此文件。
 */
import type { DatabaseSync } from "node:sqlite";
import type { AiSessionMemoryRecord, AiSessionMemoryStore } from "./ai-types";

export class SqliteAiSessionMemoryStore implements AiSessionMemoryStore {
  constructor(private readonly db: DatabaseSync) {}

  private mapRow(
    row: {
      key: string;
      company_id: string;
      user_id: string;
      session_id: string;
      intent: "tracking" | "summary" | null;
      item_name: string | null;
      status_scope: "all" | "inTransit" | "completed" | "unfinished" | "exception" | null;
      time_hint: string | null;
      metric: "count" | "volume" | "weight" | "mixed" | null;
      updated_at: string;
    },
  ): AiSessionMemoryRecord {
    return {
      key: row.key,
      companyId: row.company_id,
      userId: row.user_id,
      sessionId: row.session_id,
      intent: row.intent ?? undefined,
      itemName: row.item_name ?? undefined,
      statusScope: row.status_scope ?? undefined,
      timeHint: row.time_hint ?? undefined,
      metric: row.metric ?? undefined,
      updatedAt: row.updated_at,
    };
  }

  async get(key: string): Promise<AiSessionMemoryRecord | undefined> {
    const row = this.db
      .prepare(`
        SELECT
          key, company_id, user_id, session_id, intent, item_name, status_scope, time_hint, metric, updated_at
        FROM ai_session_memory
        WHERE key = ?
      `)
      .get(key) as
      | {
          key: string;
          company_id: string;
          user_id: string;
          session_id: string;
          intent: "tracking" | "summary" | null;
          item_name: string | null;
          status_scope: "all" | "inTransit" | "completed" | "unfinished" | "exception" | null;
          time_hint: string | null;
          metric: "count" | "volume" | "weight" | "mixed" | null;
          updated_at: string;
        }
      | undefined;

    if (!row) return undefined;
    return this.mapRow(row);
  }

  async set(record: AiSessionMemoryRecord): Promise<void> {
    this.db
      .prepare(`
        INSERT INTO ai_session_memory (
          key, company_id, user_id, session_id, intent, item_name, status_scope, time_hint, metric, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          intent=excluded.intent,
          item_name=excluded.item_name,
          status_scope=excluded.status_scope,
          time_hint=excluded.time_hint,
          metric=excluded.metric,
          updated_at=excluded.updated_at
      `)
      .run(
        record.key,
        record.companyId,
        record.userId,
        record.sessionId,
        record.intent ?? null,
        record.itemName ?? null,
        record.statusScope ?? null,
        record.timeHint ?? null,
        record.metric ?? null,
        record.updatedAt,
      );
  }

  async cleanupOlderThan(iso: string): Promise<void> {
    this.db.prepare("DELETE FROM ai_session_memory WHERE updated_at < ?").run(iso);
  }

  async listByCompany(companyId: string): Promise<AiSessionMemoryRecord[]> {
    const rows = this.db
      .prepare(`
        SELECT
          key, company_id, user_id, session_id, intent, item_name, status_scope, time_hint, metric, updated_at
        FROM ai_session_memory
        WHERE company_id = ?
        ORDER BY updated_at DESC
      `)
      .all(companyId) as Array<{
      key: string;
      company_id: string;
      user_id: string;
      session_id: string;
      intent: "tracking" | "summary" | null;
      item_name: string | null;
      status_scope: "all" | "inTransit" | "completed" | "unfinished" | "exception" | null;
      time_hint: string | null;
      metric: "count" | "volume" | "weight" | "mixed" | null;
      updated_at: string;
    }>;
    return rows.map((row) => this.mapRow(row));
  }

  async removeByFilter(input: { companyId: string; sessionId?: string; userId?: string }): Promise<number> {
    if (input.sessionId && input.userId) {
      const result = this.db
        .prepare("DELETE FROM ai_session_memory WHERE company_id = ? AND session_id = ? AND user_id = ?")
        .run(input.companyId, input.sessionId, input.userId);
      return result.changes;
    }
    if (input.sessionId) {
      const result = this.db
        .prepare("DELETE FROM ai_session_memory WHERE company_id = ? AND session_id = ?")
        .run(input.companyId, input.sessionId);
      return result.changes;
    }
    if (input.userId) {
      const result = this.db
        .prepare("DELETE FROM ai_session_memory WHERE company_id = ? AND user_id = ?")
        .run(input.companyId, input.userId);
      return result.changes;
    }
    const result = this.db.prepare("DELETE FROM ai_session_memory WHERE company_id = ?").run(input.companyId);
    return result.changes;
  }
}
