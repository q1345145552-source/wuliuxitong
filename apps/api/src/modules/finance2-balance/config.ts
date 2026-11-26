import { logger } from "../core/logger";
import { readKeyFingerprints } from "../finance2/api-key";
import { FINANCE2_KEY_ENV_NAMES } from "../finance2/config";

/**
 * 财务系统2 客户余额接口的配置（2026-11-27，约定 12.0）。四个环境变量，不进前端、不进 Git：
 *   FINANCE2_BALANCE_ENABLED            总开关，只认字符串 "true"，默认关。关着四个接口一律 503 disabled
 *   FINANCE2_COMPANY_ID                 哪一家公司（跟只读接口同一个；库里还有测试用的假公司）
 *   FINANCE2_BALANCE_KEY_SHA256         财务系统2 带的那把密钥（它那边叫 LOGISTICS_BALANCE_API_KEY）的 sha256 指纹，64 位小写十六进制
 *   FINANCE2_BALANCE_KEY_SHA256_PREV    换密钥期间上一把的指纹，平时空着
 *
 * 约定 12.0：这一组用**单独一把**密钥，不跟只读接口（FINANCE2_API_KEY_SHA256 / _PREV）共用。
 * 配成同一把（指纹一样）按没配齐处理 —— 宁可关着，也不让「能读运单的那把」顺手就能动钱。
 *
 * 开关开着但别的没配齐 = 关着：也回 503，不让进程退出、不抛异常；原因同一句只记一次日志（不打密钥和指纹）。
 */
export interface Finance2BalanceConfig {
  companyId: string;
  fingerprints: Buffer[];
}

export const FINANCE2_BALANCE_KEY_ENV_NAMES = ["FINANCE2_BALANCE_KEY_SHA256", "FINANCE2_BALANCE_KEY_SHA256_PREV"] as const;

export function readFinance2BalanceConfig(
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; cfg: Finance2BalanceConfig } | { ok: false; reason: string; enabled: boolean } {
  if (env.FINANCE2_BALANCE_ENABLED !== "true") return { ok: false, reason: "总开关没开（FINANCE2_BALANCE_ENABLED 不是 true）", enabled: false };
  const companyId = env.FINANCE2_COMPANY_ID ?? "";
  if (!companyId || companyId !== companyId.trim() || companyId.length > 128 || /[\x00-\x1f\x7f]/.test(companyId)) {
    return { ok: false, reason: "FINANCE2_COMPANY_ID 没填或格式不对", enabled: true };
  }
  const keys = readKeyFingerprints(env, FINANCE2_BALANCE_KEY_ENV_NAMES);
  if (!keys.ok) return { ok: false, reason: keys.reason, enabled: true };
  // 跟只读接口那两把比：一样就不认（约定 12.0「单独一把」）
  const readKeys = FINANCE2_KEY_ENV_NAMES.map((n) => env[n]?.trim().toLowerCase()).filter((v): v is string => typeof v === "string" && v !== "");
  if (keys.fingerprints.some((fp) => readKeys.includes(fp.toString("hex")))) {
    return { ok: false, reason: "客户余额那把密钥跟只读接口那把是同一把（约定 12.0 要单独一把）", enabled: true };
  }
  return { ok: true, cfg: { companyId, fingerprints: keys.fingerprints } };
}

let lastLoggedReason: string | null = null;

/** 每次请求现读（改 .env 重启生效；测试直接改 process.env）。关着 / 没配齐给 null */
export function finance2BalanceConfig(): Finance2BalanceConfig | null {
  const result = readFinance2BalanceConfig();
  if (result.ok) {
    lastLoggedReason = null;
    return result.cfg;
  }
  // 开关本来就关着不吵；开了却没配齐才记（同一句只记一次）
  if (result.enabled && result.reason !== lastLoggedReason) {
    lastLoggedReason = result.reason;
    logger.error("财务系统2 客户余额接口：开关开着但配置不合格，按关闭处理", { 原因: result.reason });
  }
  return null;
}
