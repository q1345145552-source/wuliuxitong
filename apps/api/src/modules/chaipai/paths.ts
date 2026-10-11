/**
 * 拆派仓对接的两个对外接口（2026-10-12）。不是用户登录，各自用对接密钥核对。
 * server.ts 只对**这两条**跳过登录解析（精确路径，不按 /integrations/ 前缀整段放 —— 10-12 两家审查都提了）。
 */
export const MANIFEST_PATH = "/integrations/chaipai/v2/container-manifest";
export const EVENTS_PATH = "/integrations/chaipai/v2/events";
export const INTEGRATION_PATHS: ReadonlySet<string> = new Set([MANIFEST_PATH, EVENTS_PATH]);
