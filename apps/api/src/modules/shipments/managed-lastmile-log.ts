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
 * @param sameStatusCount 这票货身上 toStatus 等于当前状态的记录条数（含这条）
 */
export function isCurrentStatusLog(
  log: { toStatus: string },
  currentStatus: string,
  sameStatusCount: number,
): boolean {
  return log.toStatus === currentStatus && sameStatusCount <= 1;
}

/**
 * 柜子推进（sl_ctn_）/ 随柜补记（sl_mnf_）里**真正改了状态**的记录，不许单删（2026-09-17 老板定「推进账本」做法）。
 *
 * 这些是柜子真实走过的步骤。推错了用「装柜管理」的撤销 —— 撤销按推进账本把这一步连同记录一起撤掉；
 * 单删只会让轨迹少一步，还会跟柜子分叉（Codex 第二批复核 P1：删中间「已开船」再连撤两次，
 * 柜子退到已封柜、货还挂在已开船）。
 * 状态没变的（「装入柜子」loaded→loaded、重复的「已封柜」）照样能删 —— 线上员工删过的就是这类。
 */
export function isContainerPushTransitionLog(log: { id: string; fromStatus: string; toStatus: string }): boolean {
  /* ⚠️ `sl_fcl_` 也算（2026-09-24 复核抓到，Codex 报的）：
     那是**建整柜时写的那条「已装柜」**，是整柜轨迹的第一步、跟柜子的 SEALED 成对。
     原来不在名单里，柜子往前推过之后它就不再是「当前状态」，三道闸一条都拦不住，能被单删。
     删掉之后：客户轨迹少了第一步；「改整柜」里靠它同步装柜日期和做时间顺序检查的两段
     会因为找不到它而整段跳过（`startLog` 为 null），于是改日期既不报错也不生效。
     跟 sl_ctn_ 一个性质 —— 推错了去「装柜管理」撤销，不许单删。 */
  return (log.id.startsWith("sl_ctn_") || log.id.startsWith("sl_mnf_") || log.id.startsWith("sl_fcl_"))
    && log.fromStatus !== log.toStatus;
}

export const CONTAINER_PUSH_LOG_MESSAGE =
  "这条是柜子推进时改了状态的记录，不能单删。推错了请到「装柜管理」点「撤销」。";

export const CURRENT_STATUS_LOG_MESSAGE =
  "这条显示的是这票货现在的状态，不能删。状态推错了请到「装柜管理」点「撤销」。";

export type DeleteBlockedReason = "lastmile" | "containerPush" | "currentStatus";

/**
 * 这条为什么不能删；能删返回 null。
 * 轨迹弹窗（containers/routes.ts 的 GET /client/shipments/track，给员工看原因）和删除接口
 *（shipments/routes.ts 的 POST /staff/shipments/track/delete-log）共用这一份、判断顺序一样，别各写各的。
 */
export function deleteBlockedReasonOf(
  log: { id: string; fromStatus: string; toStatus: string },
  currentStatus: string,
  sameStatusCount: number,
): DeleteBlockedReason | null {
  if (isManagedLastmileLog(log)) return "lastmile";
  if (isContainerPushTransitionLog(log)) return "containerPush";
  if (isCurrentStatusLog(log, currentStatus, sameStatusCount)) return "currentStatus";
  return null;
}
