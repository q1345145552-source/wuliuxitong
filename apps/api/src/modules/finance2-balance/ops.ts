/* ==========================================================================
   财务系统2 客户余额：扣款 / 退回（2026-11-27，约定 12.0、12.2、12.3）
   --------------------------------------------------------------------------
   一个请求编号只动一次钱。做法（「查有没有这个编号」和「动钱 + 记下这个编号」在同一个事务里）：
     ① 事务第一句：拿「这个请求编号」的排队锁（咨询锁 83092 + 编号的哈希，lockFinance2BalanceRequest）。
        两个一模一样的请求同时到，后一个卡在这里，等前一个提交完才往下走；
     ② 锁里查这个编号登记过没有：登记过 → 不动钱，内容一样原样回第一次的结果（duplicate），不一样 409；
     ③ 没登记过 → 核客户 / 找原来那次扣款 → 动钱（wallet/consolidation-balance.ts，那里锁钱包）→ 把编号和结果写进 finance2_balance_requests。
   兜底：finance2_balance_requests 的主键就是请求编号。万一排队锁没起作用、两个都走到 ③，后写的撞主键（P2002），
         整个事务回滚（钱也跟着回滚），调用方（routes.ts）再按 ② 查一遍回结果。
   锁序：请求编号的排队锁（相当于「单据」）→ 钱包行，跟集货「单据 → 钱包」同向。
   不认识的客户 / 扣款、退超了：什么都不写（编号不登记），财务那边不会拿同一个编号重试。
   ========================================================================== */
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import { chargeBillUpTo, OverRefundError, refundBillCharge } from "../wallet/consolidation-balance";
import { chargeFingerprint, refundFingerprint, type ChargeRequest, type RefundRequest } from "./views";

export type Tx = Prisma.TransactionClient;

/** 咨询锁的号段：接着 finance2-holds/store.ts 的 83091 */
const REQUEST_LOCK_KEY = 83092;

/**
 * 同一个请求编号排队（事务结束自动放）。必须是事务第一句、手里还没有别的锁。
 * scripts/test-lock-order.ts 的 LOCK_HELPERS 登记了它（advisory_finance2_balance_request），第 10 项会来核锁真的在。
 */
export async function lockFinance2BalanceRequest(tx: Tx, requestId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REQUEST_LOCK_KEY}::int, hashtext(${requestId}))`;
}

/** 登记过的那一行（回第一次结果要用的几样） */
export interface StoredRequest {
  requestId: string;
  kind: string;
  fingerprint: string;
  clientId: string;
  chargeRequestId: string | null;
  resultAmount: Prisma.Decimal;
  balanceAfter: Prisma.Decimal;
  ledgerId: string | null;
}

const STORED_SELECT = {
  requestId: true,
  kind: true,
  fingerprint: true,
  clientId: true,
  chargeRequestId: true,
  resultAmount: true,
  balanceAfter: true,
  ledgerId: true,
} satisfies Prisma.Finance2BalanceRequestSelect;

export async function findStoredRequest(db: Tx | typeof prisma, requestId: string): Promise<StoredRequest | null> {
  return db.finance2BalanceRequest.findUnique({ where: { requestId }, select: STORED_SELECT });
}

/** 事务的时限：财务那边等 10 秒（约定 12.0），这里 8 秒内一定给回话（超了回 500，财务拿原样的请求再发，不会多扣） */
const TX_OPTIONS = { maxWait: 3_000, timeout: 8_000 } as const;

export type ChargeOutcome =
  | { kind: "done"; duplicate: boolean; stored: StoredRequest }
  | { kind: "conflict" }
  | { kind: "unknownCustomer" };

/** 12.2 扣款 */
export async function runCharge(companyId: string, req: ChargeRequest): Promise<ChargeOutcome> {
  const fingerprint = chargeFingerprint(req);
  return prisma.$transaction(async (tx) => {
    await lockFinance2BalanceRequest(tx, req.requestId);
    const seen = await findStoredRequest(tx, req.requestId);
    if (seen) return seen.fingerprint === fingerprint ? { kind: "done" as const, duplicate: true, stored: seen } : { kind: "conflict" as const };

    // 客户：必须是这家公司的客户角色（约定 12.0）。封禁的照样算客户（余额还是他的）
    const customer = await tx.user.findFirst({
      where: { id: req.customerMark, companyId, role: "client" },
      select: { id: true },
    });
    if (!customer) return { kind: "unknownCustomer" as const };

    const moved = await chargeBillUpTo(tx, {
      companyId,
      clientId: customer.id,
      maxAmount: req.maxAmount,
      requestId: req.requestId,
      billNo: req.billNo,
    });
    const stored = await tx.finance2BalanceRequest.create({
      data: {
        requestId: req.requestId,
        kind: "charge",
        fingerprint,
        companyId,
        clientId: customer.id,
        billNo: req.billNo,
        billKind: req.billKind,
        amount: req.maxAmount,
        resultAmount: moved.amount,
        balanceAfter: moved.balanceAfter,
        ledgerId: moved.ledgerId,
      },
      select: STORED_SELECT,
    });
    return { kind: "done" as const, duplicate: false, stored };
  }, TX_OPTIONS);
}

export type RefundOutcome =
  | { kind: "done"; duplicate: boolean; stored: StoredRequest }
  | { kind: "conflict" }
  | { kind: "unknownCharge" }
  | { kind: "overRefund" };

/** 12.3 退回 */
export async function runRefund(companyId: string, req: RefundRequest): Promise<RefundOutcome> {
  const fingerprint = refundFingerprint(req);
  try {
    return await prisma.$transaction(async (tx) => {
      await lockFinance2BalanceRequest(tx, req.requestId);
      const seen = await findStoredRequest(tx, req.requestId);
      if (seen) return seen.fingerprint === fingerprint ? { kind: "done" as const, duplicate: true, stored: seen } : { kind: "conflict" as const };

      // 原来那次扣款：必须是这家公司登记过的「扣款」。客户和账单号以它为准（退回请求里不带）
      const charge = await tx.finance2BalanceRequest.findFirst({
        where: { requestId: req.chargeRequestId, companyId, kind: "charge" },
        select: { clientId: true, billNo: true },
      });
      if (!charge) return { kind: "unknownCharge" as const };

      const moved = await refundBillCharge(tx, {
        companyId,
        clientId: charge.clientId,
        amount: req.amount,
        chargeRequestId: req.chargeRequestId,
        billNo: charge.billNo,
      });
      const stored = await tx.finance2BalanceRequest.create({
        data: {
          requestId: req.requestId,
          kind: "refund",
          fingerprint,
          companyId,
          clientId: charge.clientId,
          billNo: charge.billNo,
          amount: req.amount,
          chargeRequestId: req.chargeRequestId,
          reason: req.reason,
          resultAmount: moved.amount,
          balanceAfter: moved.balanceAfter,
          ledgerId: moved.ledgerId,
        },
        select: STORED_SELECT,
      });
      return { kind: "done" as const, duplicate: false, stored };
    }, TX_OPTIONS);
  } catch (error) {
    // 退超了：钱包那边抛的，事务已经整个回滚（一分没动、编号没登记）
    if (error instanceof OverRefundError) return { kind: "overRefund" };
    throw error;
  }
}

/** 撞的是不是请求编号的主键（排队锁没起作用时的兜底，见文件头） */
export function isRequestIdCollision(error: unknown): boolean {
  const e = error as { code?: string; meta?: { target?: unknown } } | null;
  if (e?.code !== "P2002") return false;
  return /request_id|requestId|finance2_balance_requests_pkey/.test(JSON.stringify(e.meta?.target ?? ""));
}
