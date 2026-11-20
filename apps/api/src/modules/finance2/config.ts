import { logger } from "../core/logger";
import { readKeyFingerprints } from "./api-key";

/**
 * 给财务系统2 的只读接口的配置（2026-11-19）。三个环境变量，不进前端、不进 Git：
 *   FINANCE2_COMPANY_ID          看哪一家公司的单（湘泰那家的 company_id）。约定说「看全公司的单」，库里还有测试用的假公司，所以要写明
 *   FINANCE2_API_KEY_SHA256      财务系统2 带的那把密钥的 sha256 指纹（64 位小写十六进制）
 *   FINANCE2_API_KEY_SHA256_PREV 换密钥期间上一把的指纹，平时空着
 *
 * 没配齐 = 关着：所有接口回 503，不让进程退出、不抛异常；原因同一句只记一次日志（不打密钥和指纹）。
 */
export interface Finance2Config {
  companyId: string;
  fingerprints: Buffer[];
}

export const FINANCE2_KEY_ENV_NAMES = ["FINANCE2_API_KEY_SHA256", "FINANCE2_API_KEY_SHA256_PREV"] as const;

export function readFinance2Config(env: NodeJS.ProcessEnv = process.env): { ok: true; cfg: Finance2Config } | { ok: false; reason: string } {
  const companyId = env.FINANCE2_COMPANY_ID ?? "";
  if (!companyId || companyId !== companyId.trim() || companyId.length > 128 || /[\x00-\x1f\x7f]/.test(companyId)) {
    return { ok: false, reason: "FINANCE2_COMPANY_ID 没填或格式不对" };
  }
  const keys = readKeyFingerprints(env, FINANCE2_KEY_ENV_NAMES);
  if (!keys.ok) return { ok: false, reason: keys.reason };
  return { ok: true, cfg: { companyId, fingerprints: keys.fingerprints } };
}

let lastLoggedReason: string | null = null;

/** 每次请求现读（改 .env 重启生效；测试直接改 process.env） */
export function finance2Config(): Finance2Config | null {
  const result = readFinance2Config();
  if (result.ok) {
    lastLoggedReason = null;
    return result.cfg;
  }
  if (result.reason !== lastLoggedReason) {
    lastLoggedReason = result.reason;
    logger.warn("财务系统2 只读接口没配齐，按关闭处理", { 原因: result.reason });
  }
  return null;
}
