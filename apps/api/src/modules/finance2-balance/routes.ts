/* ==========================================================================
   财务系统2 客户余额接口（2026-11-27，ADR 0191；约定：财务系统2 docs/物流系统接口约定.md 第 12 节）
   --------------------------------------------------------------------------
   老板定：客户的余额只有一本账，就是集货余额那一本。财务系统2 的账单发给客户时来扣（扣完为止），
   作废时来退；另外来读余额和流水。**这是两个系统之间第一组会动钱的接口。**

   铁规矩（改这个文件前逐条看）：
   1. 开关 FINANCE2_BALANCE_ENABLED 不是 "true"、或者没配齐 → 四个接口一律 503 disabled（先看开关，再看密钥）。
   2. 密钥只认指纹（finance2/api-key.ts），单独一把（不跟只读接口共用），不打日志；不对一律 401，不说是哪一种不对。
   3. 只看 FINANCE2_COMPANY_ID 那一家；客户必须是这家的客户角色（customerMark = users.id），别的当不认识。
   4. 一个请求编号只动一次钱（ops.ts）：同号同内容原样回第一次的结果 + duplicate: true；同号不同内容 409 request_conflict。
   5. 返回的字段逐个列，不许 `...row`；金额是两位小数的字符串，时间带 Z，null 不省略。
      响应不走 ok() 那层 `{code, data}` 外壳，照约定是裸 JSON + serverTime；出错 `{serverTime, error, message}`
      （跟只读接口 modules/finance2 一样；server.ts 只给带 code 的响应体盖章，这里的不受影响）。
   6. 对接请求没有登录身份，server.ts 的 publishAfterWrite 不推：扣 / 退真动了钱，这里自己告诉那个客户开着的余额页刷新。
   ========================================================================== */
import type { HttpRequest, HttpResponse, MinimalHttpApp } from "../../server";
import { logger } from "../core/logger";
import { realtimeHub } from "../realtime/hub";
import { bearerKeyMatchesAny } from "../finance2/api-key";
import { finance2BalanceConfig, type Finance2BalanceConfig } from "./config";
import { listLedger, loadBalances, readOnlySnapshot } from "./ledger";
import { prisma } from "../../db/prisma";
import { findStoredRequest, isBusyError, isRequestIdCollision, runCharge, runRefund, type ChargeOutcome, type RefundOutcome, type StoredRequest } from "./ops";
import {
  FINANCE2_BALANCE_BALANCES_PATH,
  FINANCE2_BALANCE_CHARGES_PATH,
  FINANCE2_BALANCE_LEDGER_PATH,
  FINANCE2_BALANCE_REFUNDS_PATH,
} from "./paths";
import {
  chargeFingerprint,
  decodeLedgerCursor,
  encodeLedgerCursor,
  isMarkShaped,
  LEDGER_START,
  mapLedgerRow,
  money,
  parseChargeBody,
  parseRefundBody,
  refundFingerprint,
  type LedgerCursor,
} from "./views";

const MARKS_MAX = 200;
const LIMIT_DEFAULT = 200;
const LIMIT_MAX = 500;

function sendError(res: HttpResponse, status: number, error: string, message: string): void {
  res.status(status).json({ serverTime: new Date().toISOString(), error, message });
}

/** 开关（配齐没有）→ 密钥。都过才给配置 */
function requireBalanceApi(req: HttpRequest, res: HttpResponse): Finance2BalanceConfig | null {
  const cfg = finance2BalanceConfig();
  if (!cfg) { sendError(res, 503, "disabled", "客户余额接口没有打开"); return null; }
  if (!bearerKeyMatchesAny(req.headers.authorization, cfg.fingerprints)) {
    // 只记路径，不记请求头
    logger.warn("财务系统2 客户余额接口：密钥不对", { path: req.path });
    sendError(res, 401, "unauthorized", "密钥不对");
    return null;
  }
  return cfg;
}

/** limit：没传给默认；传了必须是 1～500 的整数，否则 400 */
function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined) return LIMIT_DEFAULT;
  if (!/^\d{1,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= LIMIT_MAX ? n : null;
}

/** 扣 / 退真动了钱：告诉这个客户开着的余额页（订了「wallet」那一类的）自己去重拉；员工 / 管理员那边本来就收全公司的 */
function notifyWalletChanged(companyId: string, clientId: string): void {
  realtimeHub.publish({
    companyId,
    topic: "wallet",
    // 不是哪个人点的：用一个系统身份。只推给这一个客户（clientIds），别的客户、代理收不到
    actor: { userId: "system:finance2-balance", role: "staff", agentId: null },
    clientIds: [clientId],
  });
}

function chargeReply(stored: StoredRequest, duplicate: boolean) {
  return {
    serverTime: new Date().toISOString(),
    requestId: stored.requestId,
    customerMark: stored.clientId,
    charged: money(stored.resultAmount),
    balanceAfter: money(stored.balanceAfter),
    ledgerId: stored.ledgerId,
    duplicate,
  };
}

function refundReply(stored: StoredRequest, duplicate: boolean) {
  return {
    serverTime: new Date().toISOString(),
    requestId: stored.requestId,
    chargeRequestId: stored.chargeRequestId,
    refunded: money(stored.resultAmount),
    balanceAfter: money(stored.balanceAfter),
    ledgerId: stored.ledgerId,
    duplicate,
  };
}

export function registerFinance2BalanceRoutes(app: MinimalHttpApp): void {
  /* ===== 12.1 查余额 ===== */
  app.get(FINANCE2_BALANCE_BALANCES_PATH, async (req, res) => {
    const cfg = requireBalanceApi(req, res);
    if (!cfg) return;
    const raw = req.query.marks;
    if (raw === undefined || raw === "") { sendError(res, 400, "bad_request", "要带 marks（逗号分隔的唛头）"); return; }
    const marks = raw.split(",");
    if (marks.length > MARKS_MAX) { sendError(res, 400, "bad_request", `marks 最多 ${MARKS_MAX} 个`); return; }
    if (!marks.every(isMarkShaped)) { sendError(res, 400, "bad_request", "marks 里有空的或格式不对的唛头"); return; }
    const rows = await readOnlySnapshot((tx) => loadBalances(tx, cfg.companyId, marks));
    res.status(200).json({
      serverTime: new Date().toISOString(),
      items: rows.map((r) => ({
        customerMark: r.customerMark,
        balance: money(r.balance),
        updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
      })),
    });
  });

  /* ===== 12.2 扣款（扣完为止） ===== */
  app.post(FINANCE2_BALANCE_CHARGES_PATH, async (req, res) => {
    const cfg = requireBalanceApi(req, res);
    if (!cfg) return;
    const parsed = parseChargeBody(req.body);
    if (!parsed.ok) { sendError(res, 400, "bad_request", parsed.message); return; }
    const body = parsed.value;
    let outcome: ChargeOutcome;
    try {
      outcome = await runCharge(cfg.companyId, body);
    } catch (error) {
      // 等锁 / 语句超时：事务已整个回滚（钱没动、编号没记）。回 503，财务原样重发（约定 12.0）
      if (isBusyError(error)) { sendError(res, 503, "busy", "系统忙，这一次没有办，请原样重发"); return; }
      if (!isRequestIdCollision(error)) throw error;
      // 兜底（见 ops.ts 文件头）：同号的另一个请求先写进去了，这一个已整个回滚，按它的结果回
      const seen = await findStoredRequest(prisma, body.requestId);
      outcome = seen && seen.fingerprint === chargeFingerprint(body) ? { kind: "done" as const, duplicate: true, stored: seen } : { kind: "conflict" as const };
    }
    if (outcome.kind === "conflict") { sendError(res, 409, "request_conflict", "这个 requestId 已经用来发过别的内容"); return; }
    if (outcome.kind === "unknownCustomer") { sendError(res, 404, "unknown_customer", "不认识这个客户"); return; }
    const { stored, duplicate } = outcome;
    logger.info("财务系统2 扣客户余额", {
      requestId: stored.requestId, 客户: stored.clientId, 账单号: body.billNo, 上限: body.maxAmount,
      实扣: money(stored.resultAmount), 余额: money(stored.balanceAfter), 重复: duplicate,
    });
    if (!duplicate && stored.ledgerId) notifyWalletChanged(cfg.companyId, stored.clientId);
    res.status(200).json(chargeReply(stored, duplicate));
  });

  /* ===== 12.3 退回 ===== */
  app.post(FINANCE2_BALANCE_REFUNDS_PATH, async (req, res) => {
    const cfg = requireBalanceApi(req, res);
    if (!cfg) return;
    const parsed = parseRefundBody(req.body);
    if (!parsed.ok) { sendError(res, 400, "bad_request", parsed.message); return; }
    const body = parsed.value;
    let outcome: RefundOutcome;
    try {
      outcome = await runRefund(cfg.companyId, body);
    } catch (error) {
      // 等锁 / 语句超时：事务已整个回滚（钱没动、编号没记）。回 503，财务原样重发（约定 12.0）
      if (isBusyError(error)) { sendError(res, 503, "busy", "系统忙，这一次没有办，请原样重发"); return; }
      if (!isRequestIdCollision(error)) throw error;
      const seen = await findStoredRequest(prisma, body.requestId);
      outcome = seen && seen.fingerprint === refundFingerprint(body) ? { kind: "done" as const, duplicate: true, stored: seen } : { kind: "conflict" as const };
    }
    if (outcome.kind === "conflict") { sendError(res, 409, "request_conflict", "这个 requestId 已经用来发过别的内容"); return; }
    if (outcome.kind === "unknownCharge") { sendError(res, 404, "unknown_charge", "没有这次扣款"); return; }
    if (outcome.kind === "overRefund") { sendError(res, 409, "over_refund", "退的加起来超过这次扣款扣的了"); return; }
    const { stored, duplicate } = outcome;
    logger.info("财务系统2 退回客户余额", {
      requestId: stored.requestId, 扣款: stored.chargeRequestId, 客户: stored.clientId, 原因: body.reason,
      实退: money(stored.resultAmount), 余额: money(stored.balanceAfter), 重复: duplicate,
    });
    if (!duplicate) notifyWalletChanged(cfg.companyId, stored.clientId);
    res.status(200).json(refundReply(stored, duplicate));
  });

  /* ===== 12.4 流水（增量，从旧到新；可以重复给、不许漏 —— 做法见 ledger.ts 文件头） ===== */
  app.get(FINANCE2_BALANCE_LEDGER_PATH, async (req, res) => {
    const cfg = requireBalanceApi(req, res);
    if (!cfg) return;
    const limit = parseLimit(req.query.limit);
    if (limit === null) { sendError(res, 400, "bad_request", `limit 要是 1～${LIMIT_MAX} 的整数`); return; }
    let after: LedgerCursor = LEDGER_START;
    if (req.query.cursor !== undefined) {
      const c = decodeLedgerCursor(req.query.cursor);
      if (!c) { sendError(res, 400, "bad_request", "cursor 不对，请原样带回上一页给的 nextCursor"); return; }
      after = c;
    }
    const rows = await readOnlySnapshot((tx) => listLedger(tx, cfg.companyId, after, limit + 1));
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    // 到头了也给 nextCursor（约定 12.4）：这一页一条都没有就把来的那个原样给回去（没带的给「从头」）
    const next: LedgerCursor = last ? { x: last.tx_id, t: last.created_at, i: last.id } : after;
    res.status(200).json({
      serverTime: new Date().toISOString(),
      items: page.map(mapLedgerRow),
      nextCursor: encodeLedgerCursor(next),
      hasMore,
    });
  });
}
