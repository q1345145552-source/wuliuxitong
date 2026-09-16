/** 派送业务同时维护 WD、运单和父单，日志不应脱离业务单独回退。 */
export function isManagedLastmileLog(log: { id: string }): boolean {
  return /^sl_lm(?:_|unsign_|del_)/.test(log.id);
}

export const MANAGED_LASTMILE_LOG_MESSAGE =
  "派送业务轨迹请在尾端派送中处理；误签收请由管理员使用「撤销签收」，保留原始业务记录。";

/**
 * 这条是不是「显示当前状态的最后一条」（2026-09-17 老板拍板：这条不许删）。
 *
 * 轨迹删除只删记录、不改状态，所以要保证顶上的当前状态在轨迹里总有一条对得上 ——
 * 记录的状态等于这票货现在的状态，且这票货只剩这一条是这个状态，就不给删。
 * 同一状态有两条（比如「装入柜子」+「已封柜」都是已装柜）时可以删掉其中一条。
 *
 * 轨迹弹窗（containers/routes.ts 的 GET /client/shipments/track）和删除接口
 *（shipments/routes.ts 的 POST /staff/shipments/track/delete-log）共用这一份判断，别各写各的。
 *
 * @param sameStatusCount 这票货身上 toStatus 等于当前状态的记录条数（含这条）
 */
export function isCurrentStatusLog(
  log: { toStatus: string },
  currentStatus: string,
  sameStatusCount: number,
): boolean {
  return log.toStatus === currentStatus && sameStatusCount <= 1;
}

export const CURRENT_STATUS_LOG_MESSAGE =
  "这条显示的是这票货现在的状态，不能删。状态推错了请到「装柜管理」点「撤销」。";
