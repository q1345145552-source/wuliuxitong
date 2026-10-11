import { timingSafeEqual } from "node:crypto";
import { logger } from "../core/logger";

/**
 * 对接拆派仓的配置（2026-10-12）。六个环境变量，不进前端、不进 Git：
 *   CHAIPAI_ENABLED          总开关，只认字符串 "true"，默认关
 *   CHAIPAI_COMPANY_ID       两边约定的公司编号（xiangtai），跟清单 / 回传里的 companyId 一字不差
 *   CHAIPAI_PULL_SECRET      核对「拉清单」请求（拆派仓 DOMESTIC_PULL_SECRET）
 *   CHAIPAI_CALLBACK_SECRET  核对「状态回传」请求（拆派仓 DOMESTIC_V2_CALLBACK_SECRET）
 *   CHAIPAI_READ_SECRET      湘泰去拆派仓取照片 / 司机车牌时带（拆派仓 DOMESTIC_READ_SECRET）
 *   CHAIPAI_API_BASE         拆派仓接口根地址，生产 https://xtchaipai.top/api
 *
 * 配置不合格时**不让进程退出、不抛异常**：记一次原因（不打密钥）然后按「关」处理 ——
 * 两个对外接口回 503（拆派仓会过一会儿重发），轨迹弹窗不去取照片。
 * 湘泰自己的公司编号不用配：柜号、运单 id 全库唯一，从查到的柜子 / 运单上取。
 */
export interface ChaipaiConfig {
  companyId: string;
  pullSecret: string;
  callbackSecret: string;
  readSecret: string;
  /** 去掉了结尾的 / */
  apiBase: string;
}

export type ChaipaiConfigResult = { ok: true; cfg: ChaipaiConfig } | { ok: false; reason: string };

/** 密钥门槛照拆派仓 security/production-safety.ts 的 isSafeProductionSecret，两边一样严 */
export function isSafeSecret(value: string | undefined): boolean {
  return !!value && value === value.trim() && value.length >= 32
    && !/[\s\x00-\x1f\x7f]/.test(value) && new Set(value).size >= 8
    && !/dev-only|change[-_ ]?me|replace[-_ ]?me|your[-_ ]?secret/i.test(value);
}

/** 只放行 https；开发环境另外放行本机 http（联调用本机拆派仓） */
function normalizeApiBase(raw: string | undefined, production: boolean): string | null {
  if (!raw || raw !== raw.trim() || /[\s\x00-\x1f\x7f?#\\]/.test(raw)) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.username || url.password) return null;
  if (url.protocol !== "https:") {
    if (production || url.protocol !== "http:") return null;
    if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i.test(raw)) return null;
  }
  return raw.replace(/\/+$/, "");
}

export function readChaipaiConfig(env: NodeJS.ProcessEnv = process.env): ChaipaiConfigResult {
  if (env.CHAIPAI_ENABLED !== "true") return { ok: false, reason: "总开关没开（CHAIPAI_ENABLED 不是 true）" };
  const companyId = env.CHAIPAI_COMPANY_ID ?? "";
  if (!companyId || companyId !== companyId.trim() || companyId.length > 128 || /[\x00-\x1f\x7f]/.test(companyId)) {
    return { ok: false, reason: "CHAIPAI_COMPANY_ID 没填或格式不对" };
  }
  const secrets = {
    CHAIPAI_PULL_SECRET: env.CHAIPAI_PULL_SECRET,
    CHAIPAI_CALLBACK_SECRET: env.CHAIPAI_CALLBACK_SECRET,
    CHAIPAI_READ_SECRET: env.CHAIPAI_READ_SECRET,
  };
  for (const [name, value] of Object.entries(secrets)) {
    if (!isSafeSecret(value)) return { ok: false, reason: `${name} 不合格（至少 32 位随机字符、不能有空白、不能是占位词）` };
  }
  const values = Object.values(secrets);
  if (new Set(values).size !== values.length) return { ok: false, reason: "三把 CHAIPAI_*_SECRET 不能有相同的" };
  const apiBase = normalizeApiBase(env.CHAIPAI_API_BASE, env.NODE_ENV === "production");
  if (!apiBase) return { ok: false, reason: "CHAIPAI_API_BASE 不对（生产只认 https，不许带用户名密码、? 和 #）" };
  return {
    ok: true,
    cfg: {
      companyId,
      pullSecret: secrets.CHAIPAI_PULL_SECRET!,
      callbackSecret: secrets.CHAIPAI_CALLBACK_SECRET!,
      readSecret: secrets.CHAIPAI_READ_SECRET!,
      apiBase,
    },
  };
}

let lastLoggedReason: string | null = null;

/**
 * 每次请求现读环境变量（改 .env 重启后就生效，测试也能直接改 process.env）。
 * 不合格的原因同一句只记一次日志，免得拆派仓每次重发都刷一行。
 */
export function chaipaiConfig(): ChaipaiConfig | null {
  const result = readChaipaiConfig();
  if (result.ok) {
    lastLoggedReason = null;
    return result.cfg;
  }
  if (process.env.CHAIPAI_ENABLED === "true" && result.reason !== lastLoggedReason) {
    lastLoggedReason = result.reason;
    logger.error("拆派仓对接配置不合格，按关闭处理", { 原因: result.reason });
  }
  return null;
}

/** 核对 `Authorization: Bearer <密钥>`：先比长度，再定长比较（不让人按响应快慢猜密钥） */
export function bearerMatches(header: unknown, secret: string): boolean {
  if (typeof header !== "string") return false;
  const m = /^Bearer ([^\s]+)$/.exec(header.trim());
  if (!m) return false;
  const given = Buffer.from(m[1], "utf8");
  const expected = Buffer.from(secret, "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
