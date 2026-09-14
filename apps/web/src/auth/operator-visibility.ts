import { getOptionalSession } from "./auth-session";

/**
 * 页面上要不要显示「是哪个员工 / 管理员账号操作的」（2026-09-15 老板拍板）。
 *
 * 只有超级管理员（role=admin）显示；员工、客户一律不显示。
 * ⚠️ 真正的闸在后端 apps/api/src/modules/core/operator-visibility.ts ——
 *    非管理员的接口返回里本来就没有这些字段，这里只是让员工页、共用组件在
 *    管理员也会打开的地方（/staff、/staff/whr-consolidation 等）按角色决定画不画那一格。
 */
export function viewerCanSeeOperator(): boolean {
  return getOptionalSession()?.role === "admin";
}
