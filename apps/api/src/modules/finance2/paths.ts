/**
 * 给财务系统2 的只读接口路径（2026-11-19，第 7 期物流这一边）。
 * 约定：财务系统2 项目 docs/物流系统接口约定.md 第 2 节；本仓库的核对见 docs/finance2-对接-核对.md。
 *
 * 财务系统2 带的 Bearer 是专用密钥、不是登录令牌，接口自己核对（api-key.ts）：
 * server.ts 只对**这几条精确路径**（外加「取一票」那一种 /waybills/<运单号>）跳过登录解析，不按 /integrations/ 前缀整段放。
 * 原来给海外仓财务系统的 /integrations/finance/v1/… 在 finance-link/paths.ts，跟这里互不相干。
 */
export const FINANCE2_PREFIX = "/integrations/finance2/v1";
export const FINANCE2_CHANGES_PATH = `${FINANCE2_PREFIX}/waybills/changes`;
export const FINANCE2_NUMBERS_PATH = `${FINANCE2_PREFIX}/waybills/numbers`;
export const FINANCE2_CUSTOMERS_PATH = `${FINANCE2_PREFIX}/customers`;
/** 约定以外多给的一条：客户换代理的记录（物流系统原来不记日子，2026-11-19 起由触发器记） */
export const FINANCE2_AGENT_CHANGES_PATH = `${FINANCE2_PREFIX}/customers/agent-changes`;
export const FINANCE2_AGENTS_PATH = `${FINANCE2_PREFIX}/agents`;
/**
 * 「取一票」：/waybills/<运单号>。路由表只认精确路径，所以注册在这个占位键下，
 * server.ts 认出这种路径后去取这个键的处理函数（见 finance2WaybillNoFromPath）。
 */
export const FINANCE2_WAYBILL_ITEM_ROUTE = `${FINANCE2_PREFIX}/waybills/:waybillNo`;

const EXACT_PATHS: ReadonlySet<string> = new Set([
  FINANCE2_CHANGES_PATH,
  FINANCE2_NUMBERS_PATH,
  FINANCE2_CUSTOMERS_PATH,
  FINANCE2_AGENT_CHANGES_PATH,
  FINANCE2_AGENTS_PATH,
]);

const ITEM_PREFIX = `${FINANCE2_PREFIX}/waybills/`;
/** 运单号最长多少（库里没限，按跟海外仓财务那边的 100 位） */
export const WAYBILL_NO_MAX_LEN = 100;

/**
 * 「取一票」那种路径里的运单号；不是这种路径给 null。
 * 只认一段（不许再带 /）、URL 解码后不能带控制字符、不能超长；changes / numbers 是别的接口，不当运单号。
 */
export function finance2WaybillNoFromPath(path: string): string | null {
  if (!path.startsWith(ITEM_PREFIX)) return null;
  const raw = path.slice(ITEM_PREFIX.length);
  if (!raw || raw.includes("/")) return null;
  let no: string;
  try { no = decodeURIComponent(raw); } catch { return null; }
  if (!no || no === "changes" || no === "numbers") return null;
  if (no.length > WAYBILL_NO_MAX_LEN || /[\x00-\x1f\x7f/]/.test(no)) return null;
  return no;
}

/** 这条路径是不是财务系统2 的接口（server.ts 拿它决定不解析登录令牌） */
export function isFinance2Path(path: string): boolean {
  return EXACT_PATHS.has(path) || finance2WaybillNoFromPath(path) !== null;
}
