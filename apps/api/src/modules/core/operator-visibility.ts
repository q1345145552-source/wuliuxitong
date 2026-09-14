/**
 * 「是谁操作的」只给超级管理员看。**唯一定义处。**
 *
 * 老板 2026-09-15 拍板：客户端、员工端都不能看到是哪个员工 / 管理员账号操作的，
 * 只有超级管理员（role=admin）能看。数据库照旧记操作人，只改「谁能看到」。
 *
 * ⚠️ 前端不显示 ≠ 看不到（CLAUDE.md 第 31 条）：接口返回里带着就算泄漏，
 *    F12 一开就能看。所以给非管理员的返回要在后端**明确摘掉**，别靠前端藏。
 *
 * 用法：
 *   · 整行展开（`...row`）的地方 → `hideOperatorIdentity(row, auth.role)`，把下面这张表里的字段全删掉；
 *   · 逐个字段列出来的地方     → `canSeeOperatorIdentity(auth.role) ? 值 : undefined`；
 *   · 代码自己拼进备注里的「管理员…」→ `hideOperatorInRemark(remark, auth.role)`。
 *
 * ⚠️ 司机姓名电话（尾端派送 driverName / phoneNumber）不是员工账号，不在这张表里，别加进来。
 */

/** 各表里记「谁操作的」的字段（schema.prisma 逐个核过，2026-09-15）。表里加了新的就补到这里 */
export const OPERATOR_IDENTITY_FIELDS = [
  // StatusLog / ConsolidationStatusLog / WhrConsolidationStatusLog / ConsolidationBalanceLedger / StaffInboundPhoto
  "operatorId",
  "operatorName",
  "operatorRole",
  // WhrConsolidationPlan、FclInquiry、AiKnowledgeItem
  "createdBy",
  "createdByRole",
  "creatorName",
  // ConsolidationTask / WhrConsolidationPrealert 审核付款的人；WalletRecharge 审核充值的人
  "paymentReviewedBy",
  "reviewedBy",
  "reviewerName",
  // OrderProductImage、Payment、AiKnowledgeGap、AuditLog
  "uploadedBy",
  "recordedBy",
  "resolvedBy",
  "actorId",
  "actorRole",
  /**
   * Order.paidBy：现在没有代码写它，但 2026-06-29 的付款功能（提交 820af10）写过
   * `管理员审核(${auth.name})` —— 老数据里可能躺着管理员的名字。
   */
  "paidBy",
] as const;

export type OperatorIdentityField = (typeof OPERATOR_IDENTITY_FIELDS)[number];

/** 摘掉操作人字段之后的类型：这些字段变成可选（管理员拿得到，其他人拿不到） */
export type WithoutOperatorIdentity<T> = Omit<T, OperatorIdentityField> &
  Partial<Pick<T, Extract<keyof T, OperatorIdentityField>>>;

/** 只有超级管理员能看到操作人身份 */
export function canSeeOperatorIdentity(viewerRole: string | null | undefined): boolean {
  return viewerRole === "admin";
}

/**
 * 给非管理员的数据：把上面那张表里的字段**整个删掉**（不是清成空串）。
 * 管理员原样返回。不改传进来的对象。
 */
export function hideOperatorIdentity<T extends object>(
  row: T,
  viewerRole: string | null | undefined,
): WithoutOperatorIdentity<T> {
  if (canSeeOperatorIdentity(viewerRole)) return row as unknown as WithoutOperatorIdentity<T>;
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const key of OPERATOR_IDENTITY_FIELDS) delete out[key];
  return out as WithoutOperatorIdentity<T>;
}

/**
 * 代码自己拼进备注正文里的身份词。
 *
 * 系统里有 8 处模板把「管理员」写在备注开头（生产库 2026-09-15 只读实查：目前 0 行）：
 *   普通版集货 consolidation/routes.ts   「管理员撤销付款…」「管理员删除集货任务 …，退回已付款项」
 *   仓库版集货 whr-consolidation/routes.ts「管理员撤销付款…」「管理员把「品名」的货型由…改为…」
 *                                        「管理员删除了货物「品名」（N件）」「管理员删除集货计划 …」
 * 生产只有 1 个管理员账号，「管理员」三个字就等于点了名，跟 operatorRole 是同一个信息，
 * 所以给非管理员时把开头这个词去掉，只留「做了什么」。数据库里的原文不动。
 *
 * 只认**这 8 个模板的开头**（「管理员」后面紧跟 撤销付款 / 把「 / 删除了货物「 / 删除集货计划 / 删除集货任务）。
 * 2026-09-15 复核补：原来只要备注以「管理员」开头就去掉，员工手填的「管理员已确认明天装」
 * 会被改成「已确认明天装」，意思变了。现在手填的一律原样。模板改了措辞要同步改这里（测试盯着）。
 * 员工手填备注里写人名这种事，代码没法可靠识别，不在这里处理（生产库目前 0 行）。
 */
const CODE_WRITTEN_ADMIN_REMARK = /^(\s*)管理员(?=撤销付款|把「|删除了货物「|删除集货计划 |删除集货任务 )/;
export function hideOperatorInRemark(remark: string, viewerRole: string | null | undefined): string;
export function hideOperatorInRemark(remark: string | null, viewerRole: string | null | undefined): string | null;
export function hideOperatorInRemark(remark: string | null, viewerRole: string | null | undefined): string | null {
  if (remark == null || canSeeOperatorIdentity(viewerRole)) return remark;
  return remark.replace(CODE_WRITTEN_ADMIN_REMARK, "$1");
}
