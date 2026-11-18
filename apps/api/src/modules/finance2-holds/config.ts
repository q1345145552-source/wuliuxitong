import { logger } from "../core/logger";
import { isSafeSecret } from "../chaipai/config";

/**
 * 放货时查财务系统2 的扣货名单（2026-11-19，第 9 期）。三个环境变量，不进前端、不进 Git：
 *   FINANCE2_HOLDS_MODE     开关，默认 off（什么都不做：不取名单、不拦、不提示）
 *                           observe = 取名单、页面上提示、该拦的只记日志不拦（上线后先看几天对不对）
 *                           enforce = 真拦
 *   FINANCE2_API_BASE       财务系统2 的根地址（例如 https://caiwu.example.com），后面自己拼 /integrations/logistics/v1/…
 *   FINANCE2_HOLDS_SECRET   「物流拉财务」那把密钥（财务系统2 发给我们的，跟「财务拉物流」那把不是同一把）
 *
 * 配置不合格时**不让进程退出、不抛异常**：记一次原因（不打密钥）然后按 off 处理 —— 放货照常、不拦。
 * （跟拆派仓、海外仓财务对接一样的做法。开关打开却配错，宁可不拦也不能把所有放货卡死。）
 */
export type HoldMode = "off" | "observe" | "enforce";

export interface Finance2HoldsConfig {
  mode: Exclude<HoldMode, "off">;
  /** 去掉了结尾的 /，已拼好 /integrations/logistics/v1 */
  apiBase: string;
  secret: string;
}

export type Finance2HoldsConfigResult = { ok: true; cfg: Finance2HoldsConfig } | { ok: false; off: boolean; reason: string };

export const FINANCE2_LOGISTICS_PREFIX = "/integrations/logistics/v1";

/** 只放行 https；开发环境另外放行本机 http（本机假接口、本机财务系统联调） */
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

export function readFinance2HoldsConfig(env: NodeJS.ProcessEnv = process.env): Finance2HoldsConfigResult {
  const rawMode = (env.FINANCE2_HOLDS_MODE ?? "").trim();
  if (rawMode === "" || rawMode === "off") return { ok: false, off: true, reason: "开关没开（FINANCE2_HOLDS_MODE 是 off 或没填）" };
  if (rawMode !== "observe" && rawMode !== "enforce") {
    return { ok: false, off: false, reason: "FINANCE2_HOLDS_MODE 只认 off / observe / enforce" };
  }
  if (!isSafeSecret(env.FINANCE2_HOLDS_SECRET)) {
    return { ok: false, off: false, reason: "FINANCE2_HOLDS_SECRET 不合格（至少 32 位随机字符、不能有空白、不能是占位词）" };
  }
  const base = normalizeApiBase(env.FINANCE2_API_BASE, env.NODE_ENV === "production");
  if (!base) return { ok: false, off: false, reason: "FINANCE2_API_BASE 不对（生产只认 https，不许带用户名密码、? 和 #）" };
  return { ok: true, cfg: { mode: rawMode, apiBase: base + FINANCE2_LOGISTICS_PREFIX, secret: env.FINANCE2_HOLDS_SECRET! } };
}

let lastLoggedReason: string | null = null;

/** 每次现读环境变量（测试能直接改 process.env）；不合格的原因同一句只记一次日志 */
export function finance2HoldsConfig(): Finance2HoldsConfig | null {
  const result = readFinance2HoldsConfig();
  if (result.ok) {
    lastLoggedReason = null;
    return result.cfg;
  }
  if (!result.off && result.reason !== lastLoggedReason) {
    lastLoggedReason = result.reason;
    logger.error("财务系统2 扣货名单配置不合格，按关闭处理（不取名单、不拦）", { 原因: result.reason });
  }
  return null;
}
