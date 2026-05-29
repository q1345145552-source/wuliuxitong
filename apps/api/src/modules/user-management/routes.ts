import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { hashPassword } from "../auth/crypto-utils";

/**
 * 注册管理员账号管理接口。
 */
export function registerUserManagementRoutes(app: MinimalHttpApp): void {
  // 用户列表（员工 + 客户）
  app.get("/admin/users", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const users = await prisma.user.findMany({
      where: { companyId: auth.companyId, role: { in: ["staff", "client"] } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, username: true, role: true, realName: true,
        isBanned: true, createdAt: true, warehouseIds: true,
      },
    });
    ok(res, {
      items: users.map((u) => ({
        id: u.id,
        username: u.username,
        role: u.role,
        realName: u.realName ?? null,
        isBanned: u.isBanned ?? false,
        warehouseIds: u.warehouseIds ?? "[]",
        createdAt: u.createdAt.toISOString(),
      })),
    });
  });

  // 创建用户
  app.post("/admin/users", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      username?: string; password?: string; role?: string; realName?: string;
    };
    if (!body.username?.trim() || !body.password?.trim() || !body.role?.trim()) {
      fail(res, 400, "BAD_REQUEST", "账号、密码和角色为必填"); return;
    }
    if (!["staff", "client"].includes(body.role)) {
      fail(res, 400, "BAD_REQUEST", "角色只能是 staff 或 client"); return;
    }
    const existing = await prisma.user.findFirst({
      where: { username: body.username.trim(), companyId: auth.companyId },
    });
    if (existing) { fail(res, 409, "CONFLICT", "账号已存在"); return; }
    const passwordHash = await hashPassword(body.password.trim());
    const user = await prisma.user.create({
      data: {
        id: `usr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        companyId: auth.companyId,
        username: body.username.trim(),
        passwordHash,
        role: body.role as any,
        realName: body.realName?.trim() || null,
      },
      select: { id: true, username: true, role: true, createdAt: true },
    });
    ok(res, { message: "账号创建成功", user });
  });

  // 修改密码
  app.post("/admin/users/:id/reset-password", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const id = req.query.id as string;
    const body = (req.body ?? {}) as { newPassword?: string };
    if (!body.newPassword?.trim() || body.newPassword.trim().length < 6) {
      fail(res, 400, "BAD_REQUEST", "新密码至少 6 位"); return;
    }
    const user = await prisma.user.findFirst({ where: { id, companyId: auth.companyId } });
    if (!user) { fail(res, 404, "NOT_FOUND", "用户不存在"); return; }
    const passwordHash = await hashPassword(body.newPassword.trim());
    await prisma.user.update({ where: { id }, data: { passwordHash } });
    ok(res, { message: "密码修改成功" });
  });

  // 封禁/解封
  app.post("/admin/users/:id/toggle-ban", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const id = req.query.id as string;
    const user = await prisma.user.findFirst({ where: { id, companyId: auth.companyId } });
    if (!user) { fail(res, 404, "NOT_FOUND", "用户不存在"); return; }
    const newBanState = !(user.isBanned ?? false);
    await prisma.user.update({ where: { id }, data: { isBanned: newBanState } });
    ok(res, { message: newBanState ? "已封禁" : "已解封", isBanned: newBanState });
  });
}
