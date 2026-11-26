/**
 * 财务系统2 客户余额接口的路径（2026-11-27，ADR 0191；约定：财务系统2 docs/物流系统接口约定.md 第 12 节）。
 *
 * 这是两个系统之间第一组会动钱的接口，跟第 2 节那组只读接口（modules/finance2，/integrations/finance2/v1）分开放：
 * 那一组的规矩是只读（有测试查「调用前后每张表一字不变」），这一组会写钱包，另开模块、另一把密钥。
 *
 * 财务系统2 带的 Bearer 是专用密钥、不是登录令牌，接口自己核对：server.ts 只对**这四条精确路径**跳过登录解析，
 * 不按 /integrations/ 前缀整段放（约定 1.1）。
 */
export const FINANCE2_BALANCE_PREFIX = "/integrations/finance2-balance/v1";
/** 12.1 查余额 GET */
export const FINANCE2_BALANCE_BALANCES_PATH = `${FINANCE2_BALANCE_PREFIX}/balances`;
/** 12.2 扣款 POST */
export const FINANCE2_BALANCE_CHARGES_PATH = `${FINANCE2_BALANCE_PREFIX}/charges`;
/** 12.3 退回 POST */
export const FINANCE2_BALANCE_REFUNDS_PATH = `${FINANCE2_BALANCE_PREFIX}/refunds`;
/** 12.4 流水（增量）GET */
export const FINANCE2_BALANCE_LEDGER_PATH = `${FINANCE2_BALANCE_PREFIX}/ledger`;

export const FINANCE2_BALANCE_PATHS: ReadonlySet<string> = new Set([
  FINANCE2_BALANCE_BALANCES_PATH,
  FINANCE2_BALANCE_CHARGES_PATH,
  FINANCE2_BALANCE_REFUNDS_PATH,
  FINANCE2_BALANCE_LEDGER_PATH,
]);

/** 这条路径是不是客户余额接口（server.ts 拿它决定不解析登录令牌）。只认精确路径 */
export function isFinance2BalancePath(path: string): boolean {
  return FINANCE2_BALANCE_PATHS.has(path);
}
