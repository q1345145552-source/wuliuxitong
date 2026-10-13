/**
 * 拆派仓对接的对外接口（2026-10-12；10-13 加按运单号取一票）。不是用户登录，各自用对接密钥核对。
 * server.ts 只对**这几条**跳过登录解析（精确路径，不按 /integrations/ 前缀整段放 —— 10-12 两家审查都提了）。
 */
export const MANIFEST_PATH = "/integrations/chaipai/v2/container-manifest";
/** 拆派仓扫到不认识的湘泰运单号时来取这一票（10-13；老板「不是全部的货都走拆派仓」，按柜拉的按钮拆派仓已关） */
export const WAYBILL_MANIFEST_PATH = "/integrations/chaipai/v2/waybill-manifest";
export const EVENTS_PATH = "/integrations/chaipai/v2/events";
export const INTEGRATION_PATHS: ReadonlySet<string> = new Set([MANIFEST_PATH, WAYBILL_MANIFEST_PATH, EVENTS_PATH]);
