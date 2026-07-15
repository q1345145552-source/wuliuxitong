import type { MinimalHttpApp } from "../../server";
import { prisma } from "../../db/prisma";
import { fail, ok } from "../core/http-utils";
import { checkRateLimit, getClientIp, rateLimitKey } from "../core/rate-limit";
import { signAuthToken } from "./token";
import { hashPassword, verifyPassword } from "./crypto-utils";

/**
 * 注册鉴权路由（登录 + 注册）
 *
 * ⚠️ B-2 改造：内部已完全切换到 Prisma + PostgreSQL。
 * 第二个参数 `_db` 保留只是为了兼容 main.ts 的调用签名，不再使用。
 * 等所有模块迁移完成后会从签名中移除。
 */
export function registerAuthRoutes(app: MinimalHttpApp): void {
  app.post("/auth/login", async (req, res) => {
    // 速率限制：每个 IP 每分钟最多 10 次登录尝试
    const ip = getClientIp(req.headers);
    if (checkRateLimit(rateLimitKey(ip, "login"), 10, 60_000)) {
      fail(res, 429, "BAD_REQUEST", "too many login attempts, please try again later");
      return;
    }
    const body = (req.body ?? {}) as { account?: string; password?: string; role?: string };
    if (!body.account?.trim()) {
      fail(res, 400, "BAD_REQUEST", "account is required");
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: body.account.trim() },
      select: {
        id: true,
        companyId: true,
        role: true,
        name: true,
        status: true,
        passwordHash: true,
      },
    });

    if (!user || user.status !== "active") {
      fail(res, 401, "UNAUTHORIZED", "invalid credentials");
      return;
    }
    if (body.role?.trim() && body.role.trim() !== user.role) {
      fail(res, 401, "UNAUTHORIZED", "invalid credentials");
      return;
    }
    if (!verifyPassword(body.password ?? "", user.passwordHash)) {
      fail(res, 401, "UNAUTHORIZED", "invalid credentials");
      return;
    }

    const token = signAuthToken({
      userId: user.id,
      companyId: user.companyId,
      role: user.role as "admin" | "staff" | "client",
      userName: user.name,
    });

    ok(res, {
      token,
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
        companyId: user.companyId,
      },
    });
  });

  app.post("/auth/register", async (req, res) => {
    fail(res, 403, "FORBIDDEN", "自助注册已关闭，请联系管理员");
  });
}
