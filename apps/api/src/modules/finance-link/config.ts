import { logger } from "../core/logger";
import { bearerMatches, isSafeSecret } from "../chaipai/config";

export { bearerMatches };

/**
 * 对接海外仓财务系统的配置（2026-11-04）。三个环境变量，不进前端、不进 Git：
 *   FINANCE_LINK_ENABLED      总开关，只认字符串 "true"，默认关
 *   FINANCE_LINK_SECRET       财务后端调接口时带的密钥（财务那边 LOGISTICS_LINK_SECRET，同一个值）
 *   FINANCE_LINK_RETURN_URL   授权成功后跳回财务系统的地址（生产只认 https）。只读这里，不收请求里传的地址
 *
 * 配置不合格时**不让进程退出、不抛异常**：记一次原因（不打密钥）然后按「关」处理，所有接口回 503 LINK_DISABLED。
 */
export interface FinanceLinkConfig {
  secret: string;
  returnUrl: string;
}

export type FinanceLinkConfigResult = { ok: true; cfg: FinanceLinkConfig } | { ok: false; reason: string };

/**
 * 跳回地址原样用（后面只拼 #request=…&code=…），所以不许带 ? 和 #、不许带用户名密码。
 * 只放行 https；开发环境另外放行本机 http（联调用本机财务系统）。
 */
function normalizeReturnUrl(raw: string | undefined, production: boolean): string | null {
  if (!raw || raw !== raw.trim() || /[\s\x00-\x1f\x7f?#\\]/.test(raw)) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.username || url.password) return null;
  if (url.protocol !== "https:") {
    if (production || url.protocol !== "http:") return null;
    if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i.test(raw)) return null;
  }
  return raw;
}

export function readFinanceLinkConfig(env: NodeJS.ProcessEnv = process.env): FinanceLinkConfigResult {
  if (env.FINANCE_LINK_ENABLED !== "true") return { ok: false, reason: "总开关没开（FINANCE_LINK_ENABLED 不是 true）" };
  if (!isSafeSecret(env.FINANCE_LINK_SECRET)) {
    return { ok: false, reason: "FINANCE_LINK_SECRET 不合格（至少 32 位随机字符、不能有空白、不能是占位词）" };
  }
  const returnUrl = normalizeReturnUrl(env.FINANCE_LINK_RETURN_URL, env.NODE_ENV === "production");
  if (!returnUrl) return { ok: false, reason: "FINANCE_LINK_RETURN_URL 不对（生产只认 https，不许带用户名密码、? 和 #）" };
  return { ok: true, cfg: { secret: env.FINANCE_LINK_SECRET!, returnUrl } };
}

let lastLoggedReason: string | null = null;

/**
 * 每次请求现读环境变量（改 .env 重启后就生效，测试也能直接改 process.env）。
 * 不合格的原因同一句只记一次日志，免得财务系统每次调都刷一行。
 */
export function financeLinkConfig(): FinanceLinkConfig | null {
  const result = readFinanceLinkConfig();
  if (result.ok) {
    lastLoggedReason = null;
    return result.cfg;
  }
  if (process.env.FINANCE_LINK_ENABLED === "true" && result.reason !== lastLoggedReason) {
    lastLoggedReason = result.reason;
    logger.error("财务系统对接配置不合格，按关闭处理", { 原因: result.reason });
  }
  return null;
}
