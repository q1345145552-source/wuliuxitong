import type { MinimalHttpApp } from "../../server";
import { requireAgent } from "../core/agent-scope";
import { fail, ok } from "../core/http-utils";
import { logger } from "../core/logger";
import { getFinance2Json } from "../finance2-holds/client";
import { readFinance2Remote } from "../finance2-holds/config";
import { parseBalance, parseLedger, parseWithdrawals } from "./views";

/**
 * 代理端「我的钱包」（2026-11-19，财务系统2 第 13 期；约定第 10 节，ADR 0130）。只读，钱的账在财务系统2。
 *   GET /agent/finance-wallet                         余额（待结算 / 可用 / 已提现）
 *   GET /agent/finance-wallet/ledger?cursor=…          流水（最新的在上，一页 100 条）
 *   GET /agent/finance-wallet/withdrawals?cursor=…     提现记录
 *
 * ⚠️ 只看自己的：代理编号**一律用登录的这个代理**（session-guard 每次从库里现读的 agentId），不收页面传上来的编号（约定 10.0）。
 * ⚠️ 密钥只在后台用，不下发浏览器；代理的浏览器不直接调财务系统。
 * 回给页面的统一是 200 + state，页面按 state 给好懂的话，不弹报错：
 *   notConfigured 物流这边还没配财务系统的地址 / 密钥
 *   notFound      财务那边还没有这个代理（还没同步建档）—— 「还没有钱包记录」
 *   unreachable   超时 / 连不上 / 财务回 5xx / 回的格式不对 / 密钥不对
 *   ok            正常
 */

export const FINANCE2_WALLET_PATHS = {
  balance: "/agent/finance-wallet",
  ledger: "/agent/finance-wallet/ledger",
  withdrawals: "/agent/finance-wallet/withdrawals",
} as const;

/** 约定 10.0：超时建议 10 秒 */
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 4 * 1024 * 1024;
const PAGE_LIMIT = 100;

type Fetched<T> = { state: "notConfigured" } | { state: "notFound" } | { state: "unreachable" } | { state: "ok"; value: T };

async function callWallet<T>(
  path: string,
  agentId: string,
  extra: Record<string, string>,
  parse: (body: unknown, agentId: string) => T | string,
): Promise<Fetched<T>> {
  const { remote, problem } = readFinance2Remote();
  if (!remote) {
    if (process.env.FINANCE2_API_BASE || process.env.FINANCE2_HOLDS_SECRET) logger.warn("代理钱包：财务系统2 配置不对，页面显示「还没开通」", { 原因: problem });
    return { state: "notConfigured" };
  }
  const qs = new URLSearchParams({ agentId, ...extra });
  const r = await getFinance2Json(remote, `${remote.apiBase}${path}?${qs.toString()}`, TIMEOUT_MS, MAX_BYTES);
  if (r.kind !== "ok") {
    if (r.status === 404) return { state: "notFound" };
    logger.warn("代理钱包：没取到财务系统的数据", { 接口: path, 原因: r.reason });
    return { state: "unreachable" };
  }
  const parsed = parse(r.value, agentId);
  if (typeof parsed === "string") {
    logger.error("代理钱包：财务系统返回的格式不对", { 接口: path, 原因: parsed });
    return { state: "unreachable" };
  }
  return { state: "ok", value: parsed };
}

/** 游标原样转给财务（不透明字符串）；空就是第一页。太长 / 有控制字符的当坏请求 */
function readCursor(raw: string | undefined): string | null | false {
  if (raw === undefined || raw === "") return null;
  if (raw.length > 512 || /[\x00-\x1f\x7f]/.test(raw)) return false;
  return raw;
}

export function registerFinance2WalletRoutes(app: MinimalHttpApp): void {
  app.get(FINANCE2_WALLET_PATHS.balance, async (req, res) => {
    const auth = requireAgent(req, res);
    if (!auth) return;
    const r = await callWallet("/agent-wallet", auth.agentId, {}, parseBalance);
    ok(res, r.state === "ok" ? { state: "ok", balance: r.value } : { state: r.state });
  });

  for (const [path, upstream, parse] of [
    [FINANCE2_WALLET_PATHS.ledger, "/agent-wallet/ledger", parseLedger],
    [FINANCE2_WALLET_PATHS.withdrawals, "/agent-wallet/withdrawals", parseWithdrawals],
  ] as const) {
    app.get(path, async (req, res) => {
      const auth = requireAgent(req, res);
      if (!auth) return;
      const cursor = readCursor(req.query.cursor);
      if (cursor === false) { fail(res, 400, "BAD_REQUEST", "翻页参数不对，请刷新页面"); return; }
      const r = await callWallet(upstream, auth.agentId, { limit: String(PAGE_LIMIT), ...(cursor ? { cursor } : {}) }, parse as (b: unknown, a: string) => unknown);
      ok(res, r.state === "ok" ? { state: "ok", page: r.value } : { state: r.state });
    });
  }
}
