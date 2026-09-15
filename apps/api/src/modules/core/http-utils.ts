import type { ApiResponse } from "../../../../../packages/shared-types/common-response";
import type { UserRole } from "../../../../../packages/shared-types/role";
import type { HttpRequest, HttpResponse } from "../../server";
import { isAuthHeaderRevoked } from "./token-blacklist";

export type ErrorCode = Exclude<ApiResponse<unknown>["code"], "OK">;

/**
 * ⚠️ 成功和失败的响应体**只在这两个函数里拼**（2026-08-28 定死）。
 * 别的地方自己 `res.json({ code, message })` 就会漏字段 ——
 * server.ts 的全局异常处理、404 分支原来都是自己拼的，
 * 少了契约（docs/api-contract.md 第 2、3 节）要求的 errors / requestId / timestamp，
 * 同一个系统里两种错误格式，前端要写两套解析、客户报错也没编号可查。
 */
export function ok<T>(res: HttpResponse, data: T): void {
  res.status(200).json({
    code: "OK",
    message: "success",
    data,
    requestId: res.requestId,
    timestamp: new Date().toISOString(),
  });
}

export function fail(res: HttpResponse, status: number, code: ErrorCode, message: string): void {
  res.status(status).json({
    code,
    message,
    errors: [{ reason: message }],
    requestId: res.requestId,
    timestamp: new Date().toISOString(),
  });
}

export function requireAuth(req: HttpRequest, res: HttpResponse): NonNullable<HttpRequest["auth"]> | null {
  if (!req.auth) {
    fail(res, 401, "UNAUTHORIZED", "missing auth context");
    return null;
  }
  /**
   * 退出登录的令牌不能再用（2026-08-31，排查报告第 58 条）。
   * 签名对、没过期、账号也正常，但这张令牌已经通过 /auth/logout 主动作废了。
   * ⚠️ server.ts 的 parseAuth 里**已经有同样一道**（同一个摘要口径），拉黑令牌
   *    在那边就被拦成 undefined 了，正常情况下走不到这里 —— 这里是双保险，
   *    兜「请求进行中另一个标签页刚好退出」那种毫秒级竞态，别删（2026-08-31 复查确认）。
   */
  if (isAuthHeaderRevoked(req.headers.authorization)) {
    fail(res, 401, "UNAUTHORIZED", "登录已退出，请重新登录");
    return null;
  }
  return req.auth;
}

export function requireRole(
  req: HttpRequest,
  res: HttpResponse,
  roles: UserRole[],
): NonNullable<HttpRequest["auth"]> | null {
  const auth = requireAuth(req, res);
  if (!auth) return null;
  if (!roles.includes(auth.role)) {
    fail(res, 403, "FORBIDDEN", "permission denied");
    return null;
  }
  return auth;
}
