import type { MinimalHttpApp } from "../../server";
import { prisma } from "../../db/prisma";
import { fail, ok } from "../core/http-utils";
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
    const body = (req.body ?? {}) as {
      account?: string;
      password?: string;
      name?: string;
      phone?: string;
      companyId?: string;
      companyName?: string;
      email?: string;
    };
    const account = body.account?.trim();
    const password = body.password?.trim();
    const name = body.name?.trim();
    const phone = body.phone?.trim();
    const companyId = process.env.AUTH_DEFAULT_COMPANY_ID?.trim() || "c_001";
    const companyName = body.companyName?.trim() || null;
    const email = body.email?.trim() || null;

    if (!account || !password || !name || !phone) {
      fail(res, 400, "BAD_REQUEST", "account, password, name and phone are required");
      return;
    }
    if (password.length < 6) {
      fail(res, 400, "BAD_REQUEST", "password must be at least 6 characters");
      return;
    }

    const existedById = await prisma.user.findUnique({
      where: { id: account },
      select: { id: true },
    });
    if (existedById) {
      fail(res, 409, "CONFLICT", "account already exists");
      return;
    }

    const existedByPhone = await prisma.user.findFirst({
      where: { phone, role: "client" },
      select: { id: true },
    });
    if (existedByPhone) {
      fail(res, 409, "CONFLICT", "phone already exists");
      return;
    }

    const passwordHash = hashPassword(password);
    await prisma.user.create({
      data: {
        id: account,
        companyId,
        role: "client",
        name,
        phone,
        status: "active",
        warehouseIds: "[]",
        passwordHash,
        companyName,
        email,
      },
    });

    const token = signAuthToken({
      userId: account,
      companyId,
      role: "client",
    });

    ok(res, {
      token,
      user: {
        id: account,
        name,
        role: "client",
        companyId,
      },
    });
  });
}
