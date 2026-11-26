/* ==========================================================================
   财务系统2 客户余额：查余额、拉流水（2026-11-27，约定 12.1、12.4）。只读。
   --------------------------------------------------------------------------
   都在数据库只读事务里跑（READ ONLY + REPEATABLE READ）：写一个字数据库都会报错，一页里的东西出自同一个快照。

   ## 流水「可以重复给、不许漏」怎么做到的（约定 12.4 让物流定，写进约定）

   流水按（事务号 tx_id，时间 created_at，编号 id）从小到大排，游标就是上一页最后一条的这三样。
   tx_id 是写这一笔的那个数据库事务的号（迁移 20261127_finance2_balance：库自己填 pg_current_xact_id()，
   64 位、不回绕；上线前的老流水是 0）。

   漏的情况是这样来的：事务 A 先开始写、B 后开始写，B 先提交。这时候来拉，只看得见 B；
   要是游标走过了 B，A 后来提交了，它排在游标前面，就永远拉不到了。
   防法：每一页只给 **tx_id 小于「这一刻还没结束的最老那个事务的号」**（pg_snapshot_xmin(pg_current_snapshot())）的流水。
     · 比这个号小的事务都已经结束了（提交了的这次都看得见，回滚了的永远不会有），以后不会再冒出 tx_id 更小的流水；
     · 新开的事务拿到的号一定不比它小。
   所以游标只会走过「已经定下来」的流水，后提交的那笔一定排在游标后面，下一轮拉得到。
   代价：某个写库事务一直不结束，它之后的流水都先压着不给（hasMore = false），等它结束了一起给。
   接口的事务都有时限（几秒到十几秒），正常压不了多久；真有卡住的连接，财务那边看到的是「流水晚到」，不会漏。

   顺序：「从旧到新」指的是按写入的事务先后。同一个事务里的几笔按时间、编号排。老流水（tx_id 都是 0）按时间排。
   ========================================================================== */
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import { CONSOLIDATION_CURRENCY } from "../wallet/consolidation-balance";
import { type LedgerCursor, type LedgerSqlRow } from "./views";

type Tx = Prisma.TransactionClient;

/**
 * 只读快照事务。财务那边等 10 秒：等连接最多 1.5 秒 + 事务 6 秒，单条语句数据库自己最多 5 秒（2026-11-27 审查第 4 条），
 * 7.5 秒内一定回话（到点回 5xx，财务下一轮再拉）
 */
export async function readOnlySnapshot<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'");
      return fn(tx);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 1_500, timeout: 6_000 },
  );
}

export interface BalanceRow {
  customerMark: string;
  balance: Prisma.Decimal;
  updatedAt: Date | null;
}

/**
 * 12.1：这几个唛头的余额。不是这家公司的客户角色的不出现；从没有过钱包行的给 0、updatedAt 空。
 * 按传进来的顺序给（重复的只给一次）。
 */
export async function loadBalances(tx: Tx, companyId: string, marks: readonly string[]): Promise<BalanceRow[]> {
  const unique = [...new Set(marks)];
  if (unique.length === 0) return [];
  const customers = await tx.user.findMany({
    where: { id: { in: unique }, companyId, role: "client" },
    select: { id: true },
  });
  const known = new Set(customers.map((c) => c.id));
  const accounts = known.size === 0 ? [] : await tx.clientWalletAccount.findMany({
    where: { clientId: { in: [...known] }, companyId, currency: CONSOLIDATION_CURRENCY },
    select: { clientId: true, balance: true, updatedAt: true },
  });
  const byClient = new Map(accounts.map((a) => [a.clientId, a]));
  return unique.filter((m) => known.has(m)).map((m) => {
    const a = byClient.get(m);
    return { customerMark: m, balance: a ? a.balance : new Prisma.Decimal(0), updatedAt: a ? a.updatedAt : null };
  });
}

/**
 * 12.4：游标之后、已经定下来的流水（见文件头），多取一条看有没有下一页。
 * 手写 SQL 的列名都核过库（CLAUDE.md 第 26 条）：consolidation_balance_ledger 这张表的列全是下划线的（client_id 有 @map）。
 * created_at 是不带时区的 TIMESTAMP(3)、存的是 UTC：读出来用 to_char 拼成带 Z 的，比较时把游标的时间按 UTC 换回去。
 */
export async function listLedger(tx: Tx, companyId: string, after: LedgerCursor, take: number): Promise<LedgerSqlRow[]> {
  return tx.$queryRaw<LedgerSqlRow[]>`
    SELECT l.id,
           l.client_id,
           l.type,
           l.amount::text AS amount,
           l.balance_after::text AS balance_after,
           l.ref_type,
           l.ref_id,
           l.ref_no,
           l.remark,
           l.operator_id,
           l.operator_name,
           to_char(l.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
           l.tx_id::text AS tx_id
    FROM consolidation_balance_ledger l
    WHERE l.company_id = ${companyId}
      AND l.tx_id < (pg_snapshot_xmin(pg_current_snapshot())::text)::bigint
      AND (l.tx_id, l.created_at, l.id COLLATE "C")
          > (${after.x}::bigint, (${after.t}::timestamptz AT TIME ZONE 'UTC'), ${after.i}::text COLLATE "C")
    ORDER BY l.tx_id, l.created_at, l.id COLLATE "C"
    LIMIT ${take}
  `;
}
