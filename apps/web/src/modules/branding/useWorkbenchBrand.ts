"use client";

import type { AuthSession } from "../../auth/auth-session";

/**
 * 工作台外壳（RoleShell）左上角的品牌 + 菜单微调。
 * - name / caption：左上角大字和小字（湘泰自己是「湘泰物流 / XIANGTAI」）
 * - logoUrl：左上角 logo，可空
 * - hiddenMenuIds：要藏掉的菜单项 id（menu-config.ts 里的 id）
 * - labelOverrides：菜单项 id → 改成的名字
 */
export interface WorkbenchBrand {
  name: string;
  caption?: string;
  logoUrl?: string;
  hiddenMenuIds: string[];
  labelOverrides: Record<string, string>;
}

/**
 * 占位（A1）：先一律返回 null = 湘泰自己的样子，外壳照旧。
 * B4 在这里接 `GET /client/brand`：代理的客户 → 代理名字/logo、藏普通版集货、「主页与AI」改名「主页」；
 * 代理本人 → 代理名字；湘泰账号一律 null。
 */
export function useWorkbenchBrand(session: AuthSession | null): WorkbenchBrand | null {
  void session;
  return null;
}
