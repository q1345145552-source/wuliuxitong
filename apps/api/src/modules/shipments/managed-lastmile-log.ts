/** 派送业务同时维护 WD、运单和父单，日志不应脱离业务单独回退。 */
export function isManagedLastmileLog(log: { id: string }): boolean {
  return /^sl_lm(?:_|unsign_|del_)/.test(log.id);
}

export const MANAGED_LASTMILE_LOG_MESSAGE =
  "派送业务轨迹请在尾端派送中处理；误签收请由管理员使用「撤销签收」，保留原始业务记录。";
