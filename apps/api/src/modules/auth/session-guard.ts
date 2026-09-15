import { prisma } from "../../db/prisma";
import type { UserRole } from "../../../../../packages/shared-types/role";
import { passwordFingerprint, type AuthTokenPayload } from "./token";

export type SessionCheckResult =
  | { ok: true; agentId: string | null }
  | { ok: false; reason: string };

/**
 * 令牌签名对、还没过期，**不代表这个人现在还能用系统**（2026-08-25 新增）。
 *
 * ## 原来的问题
 *
 * 认证只验签名和过期时间，一次都不回头看这个账号现在什么样。于是：
 * - 管理员把一个账号**封禁**了，那人手上的令牌照样能用，**最长 7 天**。
 *   而封禁是这个系统停用账号的**唯一手段**（删除账号已经关掉了），
 *   等于「封了但没真封住」。
 * - 客户怀疑账号被盗、**改了密码**，小偷手上的旧令牌一样还能用 7 天。
 *
 * ## 现在怎么做
 *
 * 每个请求多查一次这个用户的 status、密码哈希、角色、所属代理：
 * - `status` 不是 active → 直接当没登录
 * - 令牌里的密码指纹跟现在的密码对不上 → 直接当没登录
 * - **库里的角色跟令牌里的不一样 → 直接当没登录**（2026-09-16 加）
 *   令牌里的 role 是登录那一刻的；角色被改过（比如 client 改成 agent）以后，
 *   旧令牌不许再拿旧角色的权限用满 7 天。
 * - 顺手把 `agentId` 带回去放进 req.auth（2026-09-16 加）：
 *   代理停用、客户改归属都**当场生效**，不用等令牌过期；
 *   「代理的客户不许用普通版集货 / AI」那道统一闸也靠它。
 *
 * ⚠️ 只查四个字段、按主键查，代价很小；这套系统账号很少、并发很低。
 * ⚠️ 用户查不到也拒掉 —— 账号真被删了就不该还能用。
 * ⚠️ **老令牌里没有 pv 字段的一律放行**：这次上线时所有人手上的都是老令牌，
 *    不放行就等于全站当场强制重新登录。它们最多 7 天后自己过期，
 *    之后签发的就都带指纹了。
 */
export async function isSessionStillValid(payload: AuthTokenPayload): Promise<SessionCheckResult> {
  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { status: true, passwordHash: true, role: true, agentId: true },
  });
  if (!user) return { ok: false, reason: "账号不存在（可能已被删除）" };
  if (user.status !== "active") return { ok: false, reason: "账号已被封禁" };
  if (payload.pv && payload.pv !== passwordFingerprint(user.passwordHash)) {
    return { ok: false, reason: "密码已修改，旧登录状态失效" };
  }
  if ((user.role as UserRole | string) !== payload.role) {
    return { ok: false, reason: "账号角色已变更，旧登录状态失效" };
  }
  return { ok: true, agentId: user.agentId ?? null };
}
