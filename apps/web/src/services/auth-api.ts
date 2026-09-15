import { apiBaseUrl, apiRequest } from "./core-api";

/**
 * 登录。成功时后端顺带回这个账号的品牌（apps/api/src/modules/auth/routes.ts，2026-09-16）：
 * brand 对象 = 代理的客户 / 代理本人；null = 湘泰的；**没有这个字段** = 服务端查品牌出错，当不知道。
 * ⚠️ 类型是手写的（CLAUDE.md #22），用之前过 brand-core.ts 的 readLoginBrand 逐字段核。
 */
export function login(payload: { account: string; password: string; role?: "admin" | "staff" | "client" | "agent" }) {
  return apiRequest<{
    token: string;
    user: { id: string; name: string; role: "admin" | "staff" | "client" | "agent"; companyId: string };
    brand?: { name: string; logoUrl: string | null; loginPath: string | null } | null;
  }>(
    `${apiBaseUrl()}/auth/login`, { method: "POST", body: JSON.stringify(payload) }
  );
}

/**
 * 改自己的密码（三端通用）。
 *
 * ⚠️ 2026-08-25 起，改完密码**后端会立刻作废这张令牌**（也包括这个人在别的设备上
 * 登着的所有旧令牌）。前端本来就是改完清会话跳登录页，所以流程没变 ——
 * 但别再依赖「旧令牌还能用一会儿」这个假设去做任何事。
 */
export function changeOwnPassword(payload: { oldPassword: string; newPassword: string }) {
  return apiRequest<{ changed: boolean }>(
    `${apiBaseUrl()}/auth/change-password`, { method: "POST", body: JSON.stringify(payload), headers: { "Content-Type": "application/json" } }
  );
}

// registerClient() 已删除（2026-08-04）。
// 后端 /auth/register 是硬拒绝的，注册页也改成了开户说明页，此函数已无调用方。
// 账号只能由管理员在后台创建：/admin/users、/admin/users/client。
