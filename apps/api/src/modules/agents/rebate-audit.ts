/**
 * 返现单「已返 / 撤回已返」的操作流水（2026-09-18 老板拍板：**能撤回，但要看得到记录**）。
 *
 * 存在**已有的** `audit_logs` 表里，不加新表（所以这次改动不用动数据库结构）：
 *   action = STATUS_CHANGE，resourceType = AgentRebateStatement，resourceId = 返现单 id
 *   beforeJson / afterJson = 改之前 / 改之后的「状态 + 已返时间 + 操作人」，afterJson 另带月份、代理、金额（出单后不变，存下来省得回查）
 *   remark = 撤回原因（点「已返」没有原因，存空）
 * 读的时候靠 `@@index([resourceType, resourceId])`，再按 companyId 过滤（CLAUDE.md #27：每次查询各自带公司）。
 *
 * ⚠️ 动作是从 before/after 的状态推出来的，不另存一个「动作」字段 —— 免得两处对不上。
 */

import type { Prisma, PrismaClient } from "@prisma/client";

/** 事务里（tx）和事务外（prisma）都能传；写成这个类型是为了让列名、关系名受 tsc 检查（不是 any） */
type Db = Prisma.TransactionClient | PrismaClient;

export const REBATE_AUDIT_RESOURCE = "AgentRebateStatement";
/** 撤回原因：必填，去掉两头空格后 1~200 字 */
export const REBATE_UNDO_REASON_MAX = 200;

export type RebateStatusSnapshot = { status: string; paidAt: Date | null; paidBy: string | null };
export type RebateAuditAction = "paid" | "undoPaid" | "other";

/**
 * 写一条流水。**只在状态真的改了以后调**（重复点「已返」、重复撤回都不写，免得流水里全是没发生的事）。
 * 跟着调用方的事务走：传进来的 db 就是 tx。
 */
export async function writeRebateStatusAudit(
  db: Db,
  input: {
    companyId: string;
    actorId: string;
    actorRole: string;
    statementId: string;
    before: RebateStatusSnapshot;
    after: RebateStatusSnapshot;
    month: string;
    agentId: string;
    totalRebate: number;
    reason?: string;
  },
): Promise<void> {
  await db.auditLog.create({
    data: {
      companyId: input.companyId,
      actorId: input.actorId,
      actorRole: input.actorRole,
      action: "STATUS_CHANGE",
      resourceType: REBATE_AUDIT_RESOURCE,
      resourceId: input.statementId,
      beforeJson: JSON.stringify(snapshotJson(input.before)),
      afterJson: JSON.stringify({
        ...snapshotJson(input.after),
        month: input.month,
        agentId: input.agentId,
        totalRebate: input.totalRebate,
      }),
      remark: input.reason ?? "",
    },
  });
}

function snapshotJson(s: RebateStatusSnapshot): { status: string; paidAt: string | null; paidBy: string | null } {
  return { status: s.status, paidAt: s.paidAt ? new Date(s.paidAt).toISOString() : null, paidBy: s.paidBy ?? null };
}

/** 从 before/after 推这条流水是「点了已返」还是「撤回了已返」 */
export function rebateAuditAction(beforeJson: string | null, afterJson: string | null): RebateAuditAction {
  const before = parse(beforeJson)?.status;
  const after = parse(afterJson)?.status;
  if (before === "unpaid" && after === "paid") return "paid";
  if (before === "paid" && after === "unpaid") return "undoPaid";
  return "other";
}

function parse(json: string | null): Record<string, any> | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/**
 * 一张返现单的操作流水，最近的在最前面（给超管的明细弹窗用）。
 * 操作人名字只在这里给 —— 这个接口本来就只有超管能进（operator-visibility.ts 的规矩：操作人身份只给超管）。
 */
export async function loadRebateStatusHistory(
  db: Db,
  companyId: string,
  statementId: string,
  take = 50,
): Promise<Array<{ at: string; actorName: string; actorRole: string; action: RebateAuditAction; reason: string; amount: number | null; undonePaidAt: string | null }>> {
  const rows = await db.auditLog.findMany({
    where: { companyId, action: "STATUS_CHANGE", resourceType: REBATE_AUDIT_RESOURCE, resourceId: statementId },
    orderBy: { createdAt: "desc" },
    take,
    select: {
      actorRole: true,
      beforeJson: true,
      afterJson: true,
      remark: true,
      createdAt: true,
      actor: { select: { name: true } },
    },
  });
  return rows.map((r) => {
    const after = parse(r.afterJson);
    const before = parse(r.beforeJson);
    const amount = typeof after?.totalRebate === "number" ? after.totalRebate : null;
    const action = rebateAuditAction(r.beforeJson, r.afterJson);
    // 撤回把 paid_at / paid_by 清空了，「撤掉的是哪一次已返」只剩在这条流水的 before 里 ——
    // 一起下发，不然上线前点过已返的老单撤回后就彻底看不到原来是什么时候标的（DeepSeek 复核 2026-09-18 第 1 条）
    const undonePaidAt = action === "undoPaid" && typeof before?.paidAt === "string" ? before.paidAt : null;
    return {
      at: new Date(r.createdAt).toISOString(),
      actorName: r.actor?.name ?? "",
      actorRole: r.actorRole,
      action,
      reason: r.remark ?? "",
      amount,
      undonePaidAt,
    };
  });
}
