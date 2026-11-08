/**
 * 对接海外仓财务系统的接口路径（2026-11-04）。
 * 财务后端调的这几条不是用户登录，带的 Bearer 是对接密钥，接口自己核对：
 * server.ts 只对**这几条**跳过登录解析（精确路径，不按 /integrations/ 前缀整段放）。
 */
export const LINK_REQUESTS_PATH = "/integrations/finance/v1/link-requests";
export const LINK_TOKENS_PATH = "/integrations/finance/v1/link-tokens";
export const LINK_TOKENS_REVOKE_PATH = "/integrations/finance/v1/link-tokens/revoke";
export const WAYBILLS_PATH = "/integrations/finance/v1/waybills";
export const WAYBILL_TRACK_PATH = "/integrations/finance/v1/waybills/track";
/** 代理申请（2026-11-08）：POST 交申请、GET 按仓查，同一个路径 */
export const AGENT_APPLICATIONS_PATH = "/integrations/finance/v1/agent-applications";
export const FINANCE_LINK_PATHS: ReadonlySet<string> = new Set([
  LINK_REQUESTS_PATH,
  LINK_TOKENS_PATH,
  LINK_TOKENS_REVOKE_PATH,
  WAYBILLS_PATH,
  WAYBILL_TRACK_PATH,
  AGENT_APPLICATIONS_PATH,
]);

/** 授权页（用户浏览器）用的两条：不带登录令牌、也不签登录令牌 */
export const AUTHORIZE_INFO_PATH = "/auth/finance-link/request";
export const AUTHORIZE_SUBMIT_PATH = "/auth/finance-link/authorize";
