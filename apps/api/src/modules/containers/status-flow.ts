// 柜子状态流程的**唯一定义处**（2026-08-06 从 containers/routes.ts 抽出来）。
//
// 为什么抽出来：装柜、改运输方式、随柜补记轨迹这几处都要用同一套流程和中文，
// 原来各文件各抄一份，今天就已经抄出两份柜子状态中文了 —— CLAUDE.md 第 20 条讲的就是这个坑。
// 以后加状态**只改这个文件**，前端 staff/container-loading/page.tsx 里那两份要跟着改。

/**
 * 海运流程。
 *
 * 2026-08-13：按用户给的实际业务重排，一次加进 8 个环节（★）。
 * 用户明确要求：**这些都进主流程，一格一格按顺序排**，不是「事件」。
 *
 *   装柜中 → ★暂缓柜 → 已封柜 → ★国内海关查验 → ★国内查验放行 → ★出口已放行
 *        → 延迟开船 → ★到港时间更新 → ★港口封港暂停作业 → 运输中 → 延迟运输
 *        → 已到港 → ★泰国海关查验 → ★泰国查验放行 → 清关中 → 清关已放行
 *        → 正在卸柜 → 已到仓 → ★预约派送 → 派送中 → 已签收
 *
 * ⚠️ EXPORT_CLEARED（出口已放行）原来只在陆运，用户说少数海运柜也走报关放行节点，
 *    所以两条流程都有。它**不再是陆运专属**，改 loading-manifests 的 LAND_ONLY 时要注意。
 * ⚠️ 查验放行拆成国内 / 泰国两个状态 —— 主流程是一条线，同一个状态不能出现两次。
 */
export const CONTAINER_STATUS_FLOW = [
  "LOADING",
  // 仓库里暂时不装这个柜（等货、等船期、客户要求押后）
  "HOLD_LOADING",
  "SEALED",
  "CUSTOMS_INSPECT_CN",
  "INSPECT_CLEARED_CN",
  "EXPORT_CLEARED",
  // DELAY_DEPARTED（延迟开船）原来排在 IN_TRANSIT 后面，位置是错的 ——
  // 「没准点开船」只可能发生在开船之前。2026-08-01 挪到 SEALED 和 IN_TRANSIT 中间。
  "DELAY_DEPARTED",
  // 船期变了，重新给客户一个预计到港时间
  "ETA_UPDATED",
  // 台风等原因整个港口停止作业。放在开船之前 = 装货港封港（用户 08-13 确认）
  "PORT_CLOSED",
  // 港口拥堵 / 泊位排队，船靠上码头。位置按用户最早发的那份顺序：已靠泊 → 运输中。
  "BERTHED",
  "IN_TRANSIT",
  // 已经在海上了但延误、还没到港。和 DELAY_DEPARTED 是一对。
  "DELAY_IN_TRANSIT",
  "ARRIVED",
  "CUSTOMS_INSPECT_TH",
  "INSPECT_CLEARED_TH",
  "CUSTOMS",
  "CUSTOMS_CLEARED",
  "UNLOADING",
  "IN_WAREHOUSE_TH",
  // 跟客户约好上门时间，还没发车
  "DELIVERY_BOOKED",
  "OUT_FOR_DELIVERY",
  "SIGNED",
] as const;

/**
 * 陆运流程（2026-08-06 新增）。
 *
 * 陆运走陆路口岸，**没有「开船」「到港」**，原来只有一条海运流程，陆运的货只能在
 * 「已开船」「已到港」上硬爬过去 —— 客户在轨迹里看到自己的陆运货「已开船」是错的，
 * 而且装柜到清关中间十几天一片空白。
 *
 * 环节照用户给的实际轨迹来（2026-08-06 他发的截图）：
 *   已装柜 → 到达凭祥口岸 → 出口已放行 → 过境越南 → 老挝边境已放行
 *        → 清关已放行 → 正在卸柜 → 已到仓 → 派送中 → 已签收
 *
 * ⚠️ 走哪条流程看柜子的 transportMode（2026-08-05 加的字段）。老柜子没标运输方式的
 *    一律按海运处理 —— 那是原来的行为，不会把已有的柜子带偏。
 */
export const CONTAINER_STATUS_FLOW_LAND = [
  "LOADING",
  "SEALED",
  // 2026-08-13 新增：国内装柜后被海关拉去查验，海运陆运都可能
  "CUSTOMS_INSPECT_CN",
  "INSPECT_CLEARED_CN",
  "AT_PORT_CN",
  // 堵在口岸出不去
  "BORDER_DELAY",
  "EXPORT_CLEARED",
  "IN_VIETNAM",
  // 2026-08-13 挪位：CUSTOMS_INSPECT 指的是**越南口岸抽查**（用户 08-13 说明），
  // 原来排在 LAOS_CLEARED 后面，位置不对，挪到「过境越南」后面。
  "CUSTOMS_INSPECT",
  "LAOS_CLEARED",
  // 2026-08-13 新增：泰国侧清关，少数陆运柜会走。原来只有海运有。
  "CUSTOMS",
  "CUSTOMS_CLEARED",
  "UNLOADING",
  "IN_WAREHOUSE_TH",
  "OUT_FOR_DELIVERY",
  "SIGNED",
] as const;

export const CONTAINER_STATUS_LABEL: Record<string, string> = {
  LOADING: "装柜中",
  SEALED: "已封柜",
  DELAY_DEPARTED: "延迟开船",
  IN_TRANSIT: "运输中",
  DELAY_IN_TRANSIT: "延迟运输",
  ARRIVED: "已到港",
  CUSTOMS: "清关中",
  CUSTOMS_CLEARED: "清关已放行",
  UNLOADING: "正在卸柜",
  IN_WAREHOUSE_TH: "已到仓",
  OUT_FOR_DELIVERY: "派送中",
  DELIVERING: "派送中", // 派送中的老名字，流程里已经不用；提示里别露英文（2026-10-23 Codex 第 4 轮）
  SIGNED: "已签收",
  // 陆运专属
  AT_PORT_CN: "到达凭祥口岸",
  IN_VIETNAM: "过境越南",
  LAOS_CLEARED: "老挝边境已放行",
  BORDER_DELAY: "口岸滞留",
  CUSTOMS_INSPECT: "海关查验",
  // 海运陆运都有（2026-08-13：出口已放行原来只在陆运，海运少数柜也走）
  EXPORT_CLEARED: "出口已放行",
  CUSTOMS_INSPECT_CN: "国内海关查验",
  INSPECT_CLEARED_CN: "国内查验放行",
  // 海运专属（2026-08-13 新增）
  HOLD_LOADING: "暂缓柜",
  ETA_UPDATED: "到港时间更新",
  PORT_CLOSED: "港口封港暂停作业",
  BERTHED: "已靠泊",
  CUSTOMS_INSPECT_TH: "泰国海关查验",
  INSPECT_CLEARED_TH: "泰国查验放行",
  DELIVERY_BOOKED: "预约派送",
};

/**
 * 每个状态默认的「下一站」，客户在轨迹里能看到货接下来去哪。
 * 员工推进状态时可以手动改（改了以这次填的为准），不填就用这里的默认值。
 *
 * 口径：下一站写的是**下一个环节所在的地方**。
 *   陆运 已封柜 → 下一步是「到达凭祥口岸」→ 所以下一站是「广西凭祥出口」
 *   海运 运输中 → 下一步是「已到港」    → 所以下一站是「泰国港口」
 *
 * ⚠️ 2026-08-10 修：原来这里只有一张表、只按状态查，**没分海运陆运**。
 *    「已封柜」两条流程都有，而表里填的是陆运的走法，结果**海运柜推到已封柜，
 *    客户轨迹里被写成「下一站：广西凭祥出口」** —— 海运不走凭祥口岸。
 *    生产上实测已经写坏 12 个海运柜、67 条轨迹、35 张运单、14 个客户。
 *    所以拆成两张表，跟 CONTAINER_STATUS_FLOW / _LAND 一一对应。
 *    加新状态时**两张表都要想一遍这个状态属于哪条流程**。
 */
export const CONTAINER_NEXT_STOP_SEA: Record<string, string> = {
  // 已封柜之后就是开船，所以下一站是装船
  SEALED: "装船开船",
  IN_TRANSIT: "泰国港口",
  ARRIVED: "泰国清关",
  CUSTOMS_CLEARED: "泰国仓库",
};

export const CONTAINER_NEXT_STOP_LAND: Record<string, string> = {
  SEALED: "广西凭祥出口",
  AT_PORT_CN: "排队出关口",
  EXPORT_CLEARED: "过境越南",
  IN_VIETNAM: "老挝",
  LAOS_CLEARED: "泰国边境",
  BORDER_DELAY: "排队出关口",
  // 海关查验指**越南口岸抽查**（2026-08-13 已挪到「过境越南」后面），下一步是老挝 ——
  // 原来还写着挪位置之前的「泰国仓库」，客户看到的下一站隔了两个国家（2026-08-31 修）。
  // 口径跟上面 IN_VIETNAM 那行一致：下一站写下一个环节所在的地方。
  CUSTOMS_INSPECT: "老挝",
  CUSTOMS_CLEARED: "泰国仓库",
};

/**
 * 这个柜子推到某个状态时，默认的下一站是什么。
 * 走哪张表和 flowOf 一个口径：陆运走陆运，其余（含没标运输方式的老柜子）走海运。
 */
export function nextStopOf(
  toStatus: string,
  transportMode: string | null | undefined,
): string | null {
  const table = transportMode === "land" ? CONTAINER_NEXT_STOP_LAND : CONTAINER_NEXT_STOP_SEA;
  return table[toStatus] ?? null;
}

/** 这个柜子该按哪条流程走：陆运走陆运，其余（含没标运输方式的老柜子）走海运 */
export function flowOf(transportMode: string | null | undefined): readonly string[] {
  return transportMode === "land" ? CONTAINER_STATUS_FLOW_LAND : CONTAINER_STATUS_FLOW;
}

/**
 * 「意外情况」类状态：滞留、查验、延迟。
 *
 * 这四个不是每票货都会经过的，**没有明确记录推过就绝不能假设它发生过** ——
 * 补记轨迹时凭空补一条「海关查验」，等于给客户编造了没发生过的事（2026-08-06 踩过）；
 * 撤销状态时往回退到这里，等于把柜子退回一个它从没到过的状态。
 *
 * 2026-08-10：原来这份名单抄在 loading-manifests/routes.ts 里，撤销那边要用第二份，
 * 所以挪到这个「唯一定义处」，两边共用。加新的意外状态只改这里。
 */
export const NEVER_GUESS_STATUSES: ReadonlySet<string> = new Set([
  "BORDER_DELAY",
  "CUSTOMS_INSPECT",
  "DELAY_DEPARTED",
  "DELAY_IN_TRANSIT",
  // 2026-08-13 新增的 8 个环节全部进这份名单。
  // ⚠️ 这**不是**「往前推可以跳过」（用户明确不要那个），管的是**回退方向**：
  //    柜子从没查验过，回退时就不能退进「泰国海关查验」——那是它从没到过的状态。
  //    用户 08-13：「回退这个功能还是要的，怕弄错了」，这条正是让回退不出错的保护。
  "HOLD_LOADING",
  "CUSTOMS_INSPECT_CN",
  "INSPECT_CLEARED_CN",
  "ETA_UPDATED",
  "PORT_CLOSED",
  "CUSTOMS_INSPECT_TH",
  "INSPECT_CLEARED_TH",
  "DELIVERY_BOOKED",
  "BERTHED",
]);

/* 「借到另一条流程去」的那两个，只在**借去的那一条**里算意外情况。
   一份全局名单顾不过来 —— 复审实测：
     · 出口已放行是陆运的正常一步，却成了海运柜撤销时的落脚点
       （海运柜停在「运输中」点撤销 → 退到「出口已放行」，柜子根本没走过）
     · 反过来，清关中是海运的正常一步，陆运柜撤销「清关已放行」会退进它
   所以按运输方式各给一份，别互相误伤。 */
const NEVER_GUESS_SEA: ReadonlySet<string> = new Set([
  ...NEVER_GUESS_STATUSES,
  // 海运只有少数柜走报关放行节点
  "EXPORT_CLEARED",
]);

const NEVER_GUESS_LAND: ReadonlySet<string> = new Set([
  ...NEVER_GUESS_STATUSES,
  // 陆运只有少数柜走泰国侧清关
  "CUSTOMS",
]);

/**
 * 这个柜子撤销 / 补记轨迹时，哪些环节「没记录就不能假设它发生过」。
 * 走哪份和 flowOf 一个口径：陆运走陆运，其余（含没标运输方式的老柜子）走海运。
 */
export function neverGuessOf(transportMode: string | null | undefined): ReadonlySet<string> {
  return transportMode === "land" ? NEVER_GUESS_LAND : NEVER_GUESS_SEA;
}

/**
 * 「派送中 / 已签收」不是装柜页推的，是尾端派送那边按票推的（DELIVERING 是老名字）。
 * 用到的地方（2026-10-23 安全审查 S3 复核后挪到这里共用）：
 *   · 装柜页撤销 / 撤销预览：撤了会把客户已经签收的单子悄悄退回去，还会删掉尾端派送写的轨迹（containers/routes.ts）
 *   · 推柜子不许推到这两步：不然整柜货一下变已送达 / 派送中，没有派送单也没有签收照片（同上）
 *   · 停在这两步的柜子不许再装货：新货会按柜子状态补轨迹、直接变已送达（loading-manifests/routes.ts 加货那条）
 */
export const LASTMILE_ONLY_CONTAINER_STATUSES: ReadonlySet<string> = new Set(["OUT_FOR_DELIVERY", "SIGNED", "DELIVERING"]);

/** 柜子状态推进时，对应推运单到什么状态 */
export const CONTAINER_TO_SHIPMENT_STATUS: Record<string, string> = {
  // 陆运专属
  AT_PORT_CN: "atPortCn",
  IN_VIETNAM: "inVietnam",
  LAOS_CLEARED: "laosCleared",
  BORDER_DELAY: "borderDelay",
  CUSTOMS_INSPECT: "customsInspect",
  // 海运陆运都有
  EXPORT_CLEARED: "exportCleared",
  CUSTOMS_INSPECT_CN: "customsInspectCn",
  INSPECT_CLEARED_CN: "inspectClearedCn",
  // 2026-08-13 新增的海运环节
  HOLD_LOADING: "holdLoading",
  ETA_UPDATED: "etaUpdated",
  PORT_CLOSED: "portClosed",
  BERTHED: "berthed",
  CUSTOMS_INSPECT_TH: "customsInspectTh",
  INSPECT_CLEARED_TH: "inspectClearedTh",
  DELIVERY_BOOKED: "deliveryBooked",
  SEALED: "loaded",
  DELAY_DEPARTED: "delayDeparted",
  IN_TRANSIT: "departed",
  DELAY_IN_TRANSIT: "delayInTransit",
  ARRIVED: "arrivedPort",
  CUSTOMS: "customsTH",
  CUSTOMS_CLEARED: "customsCleared",
  // 2026-08-13：原来「正在卸柜」是唯一一个不写客户轨迹的中间步骤，
  // 客户看到「清关已放行」直接跳「已到仓」，中间几天一片空白。现在补上。
  UNLOADING: "unloading",
  IN_WAREHOUSE_TH: "inWarehouseTH",
  OUT_FOR_DELIVERY: "outForDelivery",
  SIGNED: "delivered",
};
