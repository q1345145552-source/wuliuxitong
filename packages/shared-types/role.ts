/**
 * 登录角色。2026-09-16 加 agent（代理账号）。
 * ⚠️ 代理能用的接口全部走 /agent/* 前缀；现有 requireRole 名单一个都不加 agent（默认 403）。
 */
export type UserRole = "admin" | "staff" | "client" | "agent";

export const USER_ROLES: UserRole[] = ["admin", "staff", "client", "agent"];

/** 运行时校验：库里读出来的 role 字符串是不是认得的角色（别再用 `as` 硬转） */
export function isUserRole(value: unknown): value is UserRole {
  return typeof value === "string" && (USER_ROLES as string[]).includes(value);
}

export type WarehouseScope = "global" | "warehouse_limited";
