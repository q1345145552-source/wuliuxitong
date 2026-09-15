"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import type { AuthRole } from "../../auth/auth-session";
import RoleShell from "./RoleShell";

/**
 * 工作台外壳挂在根布局上（2026-09-16 导航根治）。
 *
 * 老板反映「切换导航栏白屏闪一下」：原来每个页面自己包 <RoleShell>，侧边栏是普通 <a>，
 * 跨页面整页重开，新页面先画一屏没有侧边栏的骨架。现在外壳只在这里套一次，
 * 左边菜单换页不卸载，只换右边的 children。
 *
 * 路径第一段精确是 admin / staff / client / agent 才套外壳；登录、注册、403 等原样渲染。
 * ⚠️ 新增工作台页面：页面里别再自己包 RoleShell，在下面 PAGE_TITLES 补一行标题即可。
 */

// 放模块级常量：每次渲染拿到的是同一个数组，RoleShell 里的 effect 不会因为引用变化白跑
const SHELL_ROLES: Record<string, AuthRole[]> = {
  admin: ["admin"],
  staff: ["staff", "admin"],
  client: ["client"],
  agent: ["agent"],
};

/** 顶栏标题，照抄各页面原来传给 RoleShell 的 title */
const PAGE_TITLES: Record<string, string> = {
  "/admin": "管理员工作台",
  "/admin/prealerts": "预报单收货确认",
  "/admin/consolidation": "集货拼柜管理",
  "/admin/whr-consolidation": "集货拼柜（仓库版）",
  "/admin/finance": "财务报表",
  "/admin/settlement": "柜子收款",
  "/admin/lmp": "渠道与价格管理（LMP）",
  "/admin/customs": "关务监控",
  "/admin/agents": "代理管理",
  "/staff": "员工工作台",
  "/staff/consolidation": "集货拼柜管理",
  "/staff/whr-consolidation": "集货拼柜（仓库版）",
  "/staff/container-loading": "装柜管理",
  "/client": "客户端工作台",
  "/client/imports": "客户端批量下单",
  "/client/consolidation": "集货拼柜",
  "/client/whr-consolidation": "集货拼柜（仓库版）",
  "/client/track": "查国内快递",
  "/client/wallet": "集货余额",
  "/client/address-book": "常用地址库",
  "/agent": "代理工作台",
};

export function resolveWorkbench(pathname: string): { allowedRole: AuthRole[]; title: string } | null {
  const segments = pathname.split("/").filter(Boolean);
  const allowedRole = segments[0] ? SHELL_ROLES[segments[0]] : undefined;
  if (!allowedRole) return null;
  const normalized = `/${segments.join("/")}`;
  // 查不到（例如打错地址落到 404）就拿最后一段兜底，外壳照样在
  const title = PAGE_TITLES[normalized] ?? segments[segments.length - 1];
  return { allowedRole, title };
}

export default function WorkbenchFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "";
  const workbench = resolveWorkbench(pathname);
  if (!workbench) return <>{children}</>;
  return (
    <RoleShell allowedRole={workbench.allowedRole} title={workbench.title} variant="a3">
      {children}
    </RoleShell>
  );
}
