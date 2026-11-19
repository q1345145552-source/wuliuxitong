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
 * ⚠️ 开关和「连财务的配置」分开看（2026-11-19 Codex 审查第 1 条）：
 *   - 开关是 off（或没填）：什么都不做 —— 这是唯一「全放」的情况。
 *   - 开关开着，但密钥 / 地址配错了：**照本地存的名单拦**，只是取不到新名单、「重新核对」问不了，页面上提示配置有问题。
 *     原来配错一律按 off，换密钥漏配一项，欠款客户的货就全放出去了、页面也不提示。
 *   - 开关写了个不认识的词：当成 enforce（填了就是想开；宁可多拦，日志里报错）。
 * 都不让进程退出、不抛异常。
 */
export type HoldMode = "off" | "observe" | "enforce";

export interface Finance2Remote {
  /** 去掉了结尾的 /，已拼好 /integrations/logistics/v1 */
  apiBase: string;
  secret: string;
}

export interface Finance2HoldsConfig {
  mode: Exclude<HoldMode, "off">;
  /** 连财务系统2 的配置；配错了是 null（照本地名单拦，取不到新名单） */
  remote: Finance2Remote | null;
  /** 配置哪里不对（给页面和日志看，不含密钥）；没问题是 null */
  problem: string | null;
}

export type Finance2HoldsConfigResult = { ok: true; cfg: Finance2HoldsConfig } | { ok: false; off: true; reason: string };

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
  const problems: string[] = [];
  let mode: "observe" | "enforce";
  if (rawMode === "observe" || rawMode === "enforce") mode = rawMode;
  else {
    mode = "enforce";
    problems.push("FINANCE2_HOLDS_MODE 只认 off / observe / enforce，填了别的按 enforce（真拦）处理");
  }
  const { remote, problem } = readFinance2Remote(env);
  if (problem) problems.push(problem);
  return { ok: true, cfg: { mode, remote, problem: problems.length > 0 ? problems.join("；") : null } };
}

/**
 * 连财务系统2 的地址和密钥（不看扣货开关）。「物流拉财务」只有这一把密钥（约定 1.1、10.0），
 * 扣货名单和代理钱包（第 13 期）共用；变量名沿用 FINANCE2_HOLDS_SECRET，免得上线时多配一个。
 */
export function readFinance2Remote(env: NodeJS.ProcessEnv = process.env): { remote: Finance2Remote | null; problem: string | null } {
  const base = normalizeApiBase(env.FINANCE2_API_BASE, env.NODE_ENV === "production");
  if (!isSafeSecret(env.FINANCE2_HOLDS_SECRET)) {
    return { remote: null, problem: "FINANCE2_HOLDS_SECRET 不合格（至少 32 位随机字符、不能有空白、不能是占位词）" };
  }
  if (!base) return { remote: null, problem: "FINANCE2_API_BASE 不对（生产只认 https，不许带用户名密码、? 和 #）" };
  return { remote: { apiBase: base + FINANCE2_LOGISTICS_PREFIX, secret: env.FINANCE2_HOLDS_SECRET! }, problem: null };
}

let lastLoggedProblem: string | null = null;

/** 开关 off 时是 null；开着时返回模式 + 连财务的配置（可能配错）。每次现读环境变量；配置问题同一句只记一次日志 */
export function finance2HoldsConfig(): Finance2HoldsConfig | null {
  const result = readFinance2HoldsConfig();
  if (!result.ok) {
    lastLoggedProblem = null;
    return null;
  }
  const problem = result.cfg.problem;
  if (problem && problem !== lastLoggedProblem) {
    logger.error("财务系统2 扣货名单配置有问题：照本地存的名单拦，取不到新名单、重新核对问不了", { 原因: problem });
  }
  lastLoggedProblem = problem;
  return result.cfg;
}
