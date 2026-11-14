/**
 * 「这个账号在系统里留没留下过东西」要核的列（2026-11-14 员工号改客户号用）。
 *
 * 老板：员工在「员工管理」误把客户建成了员工号（XHH-6669 那次）→「a」：管理员能在系统里直接改成客户号，
 * 但只许改「还什么都没做过」的员工号 —— 经手过单子、留下过记录的真员工改了，那些记录就挂到一个客户名下了。
 *
 * 列名是数据库里的真名（有 @map 的用 map 后的名字，client_wallet_accounts 那一列没 map、就是驼峰的 clientId，CLAUDE.md 第 26 条）。
 * scripts/test-staff-to-client-source.ts 会从 schema.prisma 推一份「记账号的列」跟这里逐条对：以后新加了记账号的列没加进来就红。
 *
 * 不算的（EXCLUDED）：
 *  - cs_push_subscriptions.user_id：浏览器通知订阅，发之前按账号现在的角色再核，对不上自己删（cs-chat/push.ts），不算「做过事」
 *  - audit_logs.user_agent、finance_link_*.warehouse_ref：名字里碰巧带 user / ref，不是账号
 */
import type { Prisma } from "@prisma/client";

export const USER_REFERENCE_COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
  ["orders", "client_id"],
  ["orders", "paid_by"],
  ["container_push_batches", "operator_id"],
  ["status_logs", "operator_id"],
  ["ai_session_memory", "user_id"],
  ["ai_knowledge_items", "created_by"],
  ["ai_audit_logs", "user_id"],
  ["ai_knowledge_gaps", "user_id"],
  ["ai_knowledge_gaps", "resolved_by"],
  ["client_addresses", "client_id"],
  ["client_documents", "client_id"],
  ["client_wallet_accounts", "clientId"],
  ["wallet_recharges", "client_id"],
  ["wallet_recharges", "reviewed_by"],
  ["consolidation_balance_ledger", "client_id"],
  ["consolidation_balance_ledger", "operator_id"],
  ["staff_inbound_photos", "operator_id"],
  ["order_product_images", "uploaded_by"],
  ["pricing_rules", "customer_id"],
  ["invoices", "customer_id"],
  ["payments", "recorded_by"],
  ["customer_credit", "customer_id"],
  ["credit_histories", "customer_id"],
  ["audit_logs", "actor_id"],
  ["client_notes", "client_id"],
  ["cs_conversations", "client_id"],
  ["cs_messages", "sender_id"],
  ["fcl_inquiries", "client_id"],
  ["fcl_inquiries", "created_by"],
  ["fcl_inquiries", "quoted_by"],
  ["fcl_inquiries", "converted_by"],
  ["consolidation_tasks", "client_id"],
  ["consolidation_tasks", "payment_reviewed_by"],
  ["consolidation_prealerts", "client_id"],
  ["consolidation_status_logs", "operator_id"],
  ["whr_consolidation_plans", "created_by"],
  ["whr_consolidation_plan_customers", "client_id"],
  ["whr_consolidation_prealerts", "customer_id"],
  ["whr_consolidation_prealerts", "payment_reviewed_by"],
  ["whr_consolidation_status_logs", "operator_id"],
  ["client_whr_prices", "client_id"],
  ["client_whr_prices", "updated_by"],
  ["agent_rebate_statements", "paid_by"],
  ["agent_rebate_lines", "client_id"],
  ["arrival_notices", "client_id"],
  ["arrival_notices", "notified_by"],
  ["arrival_notices", "created_by"],
  ["arrival_notice_images", "uploaded_by"],
  ["arrival_notice_snapshots", "converted_by_id"],
  ["finance_link_requests", "user_id"],
  ["finance_link_authorizations", "user_id"],
  ["agent_applications", "login_id"],
  ["agent_applications", "reviewed_by_id"],
  ["agent_applications", "approved_login_id"],
];

/** 故意不算的列（理由见文件头） */
export const USER_REFERENCE_EXCLUDED: ReadonlyArray<readonly [table: string, column: string]> = [
  ["cs_push_subscriptions", "user_id"],
  ["audit_logs", "user_agent"],
  ["finance_link_requests", "warehouse_ref"],
  ["finance_link_authorizations", "warehouse_ref"],
];

const ident = (name: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`bad identifier: ${name}`);
  return `"${name}"`;
};

/** 这个账号在哪些列里出现过（一条 SQL 查完；返回 "表.列"，没出现过就是空数组） */
export async function findUserReferences(tx: Prisma.TransactionClient, userId: string): Promise<string[]> {
  const sql = `SELECT ${USER_REFERENCE_COLUMNS.map(([t, c], i) => `EXISTS (SELECT 1 FROM ${ident(t)} WHERE ${ident(c)} = $1) AS c${i}`).join(", ")}`;
  const rows = await tx.$queryRawUnsafe<Array<Record<string, boolean>>>(sql, userId);
  const row = rows[0] ?? {};
  return USER_REFERENCE_COLUMNS.filter((_, i) => row[`c${i}`] === true).map(([t, c]) => `${t}.${c}`);
}
