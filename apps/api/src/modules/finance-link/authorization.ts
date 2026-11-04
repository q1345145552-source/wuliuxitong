import { createHash, randomBytes } from "node:crypto";
import { passwordFingerprint } from "../auth/token";

/**
 * 授权的纯逻辑（2026-11-04）：随机串、哈希、账号还合不合格。不碰数据库，测试直接测。
 * ⚠️ 这些值（长期授权、一次性码、密码指纹）一律不写日志。
 */

/** 只有客户和代理能授权；员工、管理员不行 */
export function canAuthorize(role: string | null | undefined): role is "client" | "agent" {
  return role === "client" || role === "agent";
}

/** 至少 32 字节的随机串（requestId、一次性码、长期授权都用它） */
export function newOpaqueValue(): string {
  return randomBytes(32).toString("base64url");
}

export function newAuthorizationId(): string {
  return `fla_${randomBytes(16).toString("hex")}`;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

interface CodeOwner {
  id: string;
  companyId: string;
  role: string;
  passwordHash: string | null;
}

/**
 * 一次性码的哈希把「登录那一刻的账号、公司、角色、密码」也算进去：
 * 登录后、换授权前（最多 5 分钟）这些变了，这个码就对不上了，
 * 不会拿改之前那次登录换出一个带新密码指纹、一直有效的授权（老板定的「改密码后失效」）。
 */
export function codeHashOf(code: string, user: CodeOwner): string {
  return sha256Hex(`${code}:${user.id}:${user.companyId}:${user.role}:${passwordFingerprint(user.passwordHash)}`);
}

export type RevokedReason = "PASSWORD_CHANGED" | "ACCOUNT_DISABLED" | "ROLE_CHANGED" | "REVOKED";

/**
 * 每次查运单都核对（CLAUDE.md #38：存下来反复用的凭证，用的时候按账号现在的状态再核一遍）。
 * @returns 不合格的原因；还合格返回 null
 */
export function linkProblem(
  authorization: { companyId: string; role: string; passwordFingerprint: string },
  user: { companyId: string; role: string; status: string; passwordHash: string | null } | null,
): RevokedReason | null {
  if (!user || user.status !== "active" || user.companyId !== authorization.companyId) return "ACCOUNT_DISABLED";
  if (user.role !== authorization.role) return "ROLE_CHANGED";
  if (passwordFingerprint(user.passwordHash) !== authorization.passwordFingerprint) return "PASSWORD_CHANGED";
  return null;
}

/** last_used_at 最多一小时写一次 */
export const LAST_USED_WRITE_INTERVAL_MS = 60 * 60_000;

export function shouldTouchLastUsed(lastUsedAt: Date | null, now: Date): boolean {
  return !lastUsedAt || now.getTime() - lastUsedAt.getTime() >= LAST_USED_WRITE_INTERVAL_MS;
}

/** 财务后端调进来时带的是哪个域名（不认识的写法返回 null） */
function requestHostOf(headers: NodeJS.Dict<string | string[]>): string | null {
  const raw = headers["x-forwarded-host"] ?? headers.host;
  const first = (Array.isArray(raw) ? raw[0] : raw)?.split(",")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9.-]+(:\d+)?$/.test(first) ? first : null;
}

/**
 * 授权页在物流前端，这个地址从请求进来的域名算（只有带对接密钥的请求才走到这里）：
 * 线上 xianlianth.com 走 Next 转发；api.xianlianth.com 直连后台，页面在主域名，只有这一个域名要换
 * （代理的专属域名可能就叫 api.xxx.com，不能见 api. 就去掉）。
 * 线上一律 https（nginx 后面到 Next 这段是 http，不能看 x-forwarded-proto）。
 */
export function authorizeUrlOf(
  headers: NodeJS.Dict<string | string[]>,
  requestId: string,
  production: boolean = process.env.NODE_ENV === "production",
): string | null {
  const seen = requestHostOf(headers);
  if (!seen) return null;
  const host = seen === "api.xianlianth.com" ? "xianlianth.com" : seen;
  const proto = production ? "https" : "http";
  return `${proto}://${host}/login/authorize?request=${encodeURIComponent(requestId)}`;
}
