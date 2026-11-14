/**
 * 「这个账号在系统里留没留下过东西」要核的列（2026-11-14 员工号改客户号用）。
 *
 * 老板：员工在「员工管理」误把客户建成了员工号（XHH-6669 那次）→「a」：管理员能在系统里直接改成客户号，
 * 但只许改「还什么都没做过」的员工号 —— 经手过单子、留下过记录的真员工改了，那些记录就挂到一个客户名下了。
 *
 * 列名是数据库里的真名（有 @map 的用 map 后的名字，client_wallet_accounts 那一列没 map、就是驼峰的 clientId，CLAUDE.md 第 26 条）。
 * scripts/test-staff-to-client-source.ts 会从 schema.prisma 推一份「记账号的列」跟这里逐条对：以后新加了记账号的列没加进来就红。
 *
 * 三份清单（scripts/test-staff-to-client-source.ts 的 T1 逐条对 schema）：
 *  - USER_REFERENCE_COLUMNS：这一列的值 = 账号（等于就算用过）
 *  - USER_REFERENCE_TEXT_COLUMNS：一大段文字 / JSON 里出现过带引号的这个号就算（审计记录里存着被删掉的轨迹，恢复时 operatorId 会原样回来，dsh 第 1 轮）
 *  - USER_REFERENCE_EXCLUDED：名字像、或者是大段文字 / JSON，但不记账号的（每条写明理由）
 *
 * ⚠️ 只能保证「查的那一刻」这个号没留下东西：员工正在提交的请求（已经过了登录检查）写不锁账号那一行的表（比如轨迹），
 *    可能在改号那一瞬间之后才落库。要硬挡得让所有员工写入都核角色，那就不止「员工管理」了（dsh 第 1 轮，老板要的是改误建、没人用的号）。
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
  ["agent_applications", "reviewed_by_id"],
  ["agent_applications", "approved_login_id"],
];

/** 大段文字 / JSON 里出现过 "号"（带双引号，跟 JSON.stringify 一样）就算用过 */
export const USER_REFERENCE_TEXT_COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
  ["audit_logs", "before_json"], // 删轨迹 / 撤销整柜时整条存进来，带 operatorId，能恢复
  ["audit_logs", "after_json"],
];

/** 故意不算的列：[表, 列, 理由] */
export const USER_REFERENCE_EXCLUDED: ReadonlyArray<readonly [table: string, column: string, reason: string]> = [
  ["cs_push_subscriptions", "user_id", "浏览器通知订阅：发之前按账号现在的角色再核，对不上自己删（cs-chat/push.ts），不算做过事"],
  ["audit_logs", "user_agent", "浏览器标识，名字里碰巧带 user"],
  ["finance_link_requests", "warehouse_ref", "仓库编号，名字里碰巧带 user（wareHOUSERef）"],
  ["finance_link_authorizations", "warehouse_ref", "仓库编号，名字里碰巧带 user（wareHOUSERef）"],
  ["whr_consolidation_prealerts", "customer_id", "指向 whr_consolidation_plan_customers.id（那张表的 client_id 已在清单里），不是账号"],
  ["agent_applications", "login_id", "代理申请时想要的登录名，交申请时不查有没有人用（finance-link/agent-applications.ts），不是已有账号；开出来的号记在 approved_login_id"],
  ["credit_histories", "evaluator", "全仓库没有写入方；格式是「ADMIN:号」，记的是超管"],
  // 大段文字 / JSON / 图片：不记员工号
  ["orders", "payment_proof_base64", "付款截图"],
  ["orders", "payment_proofs", "付款截图列表"],
  ["ai_knowledge_items", "content", "AI 知识正文"],
  ["ai_audit_logs", "question", "提问原文（谁问的记在 user_id）"],
  ["ai_audit_logs", "answer_summary", "回答摘要"],
  ["ai_knowledge_gaps", "question", "提问原文（谁问的记在 user_id）"],
  ["ai_knowledge_gaps", "answer_summary", "回答摘要"],
  ["client_documents", "content_base64", "客户资料文件"],
  ["wallet_recharges", "proof_image", "充值截图"],
  ["staff_inbound_photos", "content_base64", "入库照片（谁拍的记在 operator_id）"],
  ["order_product_images", "content_base64", "产品图（谁传的记在 uploaded_by）"],
  ["admin_lastmile_orders", "sign_product_image_base64", "签收图"],
  ["credit_histories", "reason", "信用评估说明"],
  ["credit_histories", "metrics", "信用评估指标"],
  ["cs_messages", "content", "聊天内容（谁发的记在 sender_id）"],
  ["fcl_inquiries", "product_name", "品名"],
  ["fcl_inquiries", "address", "地址"],
  ["fcl_inquiries", "cert_file_base64", "认证文件"],
  ["fcl_inquiries", "product_images", "产品图"],
  ["fcl_inquiries", "quote_note", "报价备注"],
  ["consolidation_tasks", "destination_th", "泰国地址"],
  ["consolidation_tasks", "payment_proof_base64", "付款截图"],
  ["consolidation_tasks", "payment_reject_reason", "驳回原因"],
  ["consolidation_prealerts", "received_proof_base64", "签收截图"],
  ["consolidation_prealert_products", "product_image_base64", "产品图"],
  ["whr_consolidation_plans", "destination_th", "泰国地址"],
  ["whr_consolidation_plan_customers", "delivery_address", "送货地址"],
  ["whr_consolidation_prealerts", "warehouse_receipt_proofs", "入库截图"],
  ["whr_consolidation_prealerts", "payment_proofs", "付款截图"],
  ["whr_consolidation_prealerts", "payment_reject_reason", "驳回原因"],
  ["whr_consolidation_prealerts", "thailand_receipt_proofs", "泰国签收截图"],
  ["whr_consolidation_prealerts", "cancel_reason", "取消原因"],
  ["whr_consolidation_prealert_items", "product_image_base64", "产品图"],
  ["agent_rebate_lines", "product_names", "品名"],
  ["arrival_notice_snapshots", "data", "转正式那一刻的到货通知原样（里面的唛头是客户；原样跟着到货通知一起删，到货通知本身的 client_id / created_by 已在清单里）"],
  ["chaipai_callback_events", "payload", "拆派仓回传原文（运单 / 柜子 / 照片，不记湘泰账号）"],
  ["chaipai_shipment_states", "released_routes", "拆派仓放行的路线"],
];

const ident = (name: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`bad identifier: ${name}`);
  return `"${name}"`;
};

/** 这个账号在哪些列里出现过（一条 SQL 查完；返回 "表.列"，没出现过就是空数组） */
export async function findUserReferences(tx: Prisma.TransactionClient, userId: string): Promise<string[]> {
  const all = [
    ...USER_REFERENCE_COLUMNS.map(([t, c]) => ({ key: `${t}.${c}`, sql: `EXISTS (SELECT 1 FROM ${ident(t)} WHERE ${ident(c)} = $1)` })),
    // strpos 不认通配符（号里有 _ % 也不会误中）；带引号找，「XHH-66」不会被「XHH-6669」带上
    ...USER_REFERENCE_TEXT_COLUMNS.map(([t, c]) => ({ key: `${t}.${c}`, sql: `EXISTS (SELECT 1 FROM ${ident(t)} WHERE strpos(${ident(c)}, $2) > 0)` })),
  ];
  const sql = `SELECT ${all.map((x, i) => `${x.sql} AS c${i}`).join(", ")}`;
  const rows = await tx.$queryRawUnsafe<Array<Record<string, boolean>>>(sql, userId, JSON.stringify(userId));
  const row = rows[0] ?? {};
  return all.filter((_, i) => row[`c${i}`] === true).map((x) => x.key);
}
