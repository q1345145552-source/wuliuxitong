export type ShipmentStatus =
  | "loaded"
  | "created"
  // ↓ 2026-09-02 进主流程：货到国内仓（中文「已入库」）。老板拍板：员工建单=货已到仓，
  //   起始状态就是它；客户预报单仍从 created 起，仓库确认收货后推到这里。
  //   ⚠️ 这个状态名不是新造的 —— 老数据轨迹里早就有 inWarehouseCN（确认收货那条路
  //   2026-08-06 起只写轨迹不改 currentStatus），现在把它转正进流程表。
  | "inWarehouseCN"
  | "delayDeparted"
  | "departed"
  | "delayInTransit"
  | "arrivedPort"
  | "customsTH"
  | "customsCleared"
  | "inWarehouseTH"
  | "outForDelivery"
  | "delivered"
  | "exception"
  | "returned"
  | "cancelled"
  // ↓ 2026-08-06 新增：陆运专属环节（凭祥口岸 → 越南 → 老挝 → 泰国）。
  | "atPortCn"
  | "inVietnam"
  | "laosCleared"
  | "borderDelay"
  // 越南口岸抽查（2026-08-13 确认口径）
  | "customsInspect"
  // ↓ 2026-08-13 新增。⚠️ exportCleared 从「陆运专属」变成**海运陆运都有**
  //   （用户：少数海运柜也走报关放行节点）。
  | "exportCleared"
  | "customsInspectCn"
  | "inspectClearedCn"
  // ↓ 海运专属
  | "holdLoading"
  | "etaUpdated"
  | "portClosed"
  | "berthed"
  | "customsInspectTh"
  | "inspectClearedTh"
  | "deliveryBooked"
  // 2026-08-13：柜子到泰国仓卸货。原来这一步不写客户轨迹，客户看到的是
  // 「清关已放行」直接跳「已到仓」，中间几天一片空白。海运陆运都有。
  | "unloading";

/**
 * 海运流程（2026-09-02 起 23 步）。
 * inWarehouseCN（已入库）排在 created 之后、holdLoading 之前 ——
 * holdLoading 的语义是「货在仓里暂缓装柜」，货得先入库才谈得上暂缓。
 */
export const SHIPMENT_STATUS_FLOW: ShipmentStatus[] = [
  "created",
  "inWarehouseCN",
  "holdLoading",
  "loaded",
  "customsInspectCn",
  "inspectClearedCn",
  "exportCleared",
  "delayDeparted",
  "etaUpdated",
  "portClosed",
  "berthed",
  "departed",
  "delayInTransit",
  "arrivedPort",
  "customsInspectTh",
  "inspectClearedTh",
  "customsTH",
  "customsCleared",
  "unloading",
  "inWarehouseTH",
  "deliveryBooked",
  "outForDelivery",
  "delivered",
];

/**
 * 陆运流程（2026-08-06 新增）。走陆路口岸，没有「开船」「到港」这两步。
 * 环节照用户提供的实际轨迹：
 *   已装柜 → 到达凭祥口岸 → 出口已放行 → 过境越南 → 老挝边境已放行
 *        → 清关已放行 → 已到仓 → 派送中 → 已签收
 */
export const SHIPMENT_STATUS_FLOW_LAND: ShipmentStatus[] = [
  "created",
  // 2026-09-02 进主流程：货到国内仓（已入库），海运陆运都有
  "inWarehouseCN",
  "loaded",
  "customsInspectCn",
  "inspectClearedCn",
  "atPortCn",
  "borderDelay",
  "exportCleared",
  "inVietnam",
  "customsInspect",
  "laosCleared",
  "customsTH",
  "customsCleared",
  "unloading",
  "inWarehouseTH",
  "outForDelivery",
  "delivered",
];

/**
 * 只有陆运才会出现的状态，用来判断一票货该按哪条流程显示。
 *
 * ⚠️ 2026-08-13：exportCleared 从这份名单里**拿掉了** —— 海运少数柜也走出口已放行，
 *    留着会把走了这一步的海运货误判成陆运。
 */
export const LAND_ONLY_STATUSES: ShipmentStatus[] = [
  "atPortCn",
  "inVietnam",
  "laosCleared",
  "borderDelay",
  "customsInspect",
];

export const SHIPMENT_EXCEPTION_STATUSES: ShipmentStatus[] = [
  "exception",
  "returned",
  "cancelled",
];
export const COMPLETED_STATUSES: ShipmentStatus[] = [
  "delivered",
  "returned",
  "cancelled",
];
/**
 * 「已到仓」= 货进了泰国仓之后、客户签收之前的整段（2026-09-03 老板拍板）。
 *
 * 老板原话：到仓的不算在途；派送不单独分格，签收了才走「已签收」。
 * 这一份是**全系统唯一的「已到仓」清单** —— 客户端分组按钮、运单列表顶部数字、
 * 管理员看板 KPI、管理员状态分布图、AI 问答，全都必须从这里取，不许再自己写一份。
 *
 * ⚠️ 为什么单独抽出来：2026-09-03 老板拍板后曾经**只改了客户端两处**，
 * 而下面 IN_TRANSIT_STATUSES 仍把这三个状态算成「在途」，结果同一个管理员后台里
 * 看板 KPI 和运单列表的「在途」差了整整一格「已到仓」，AI 回答客户的数也跟着错。
 */
export const AT_WAREHOUSE_STATUSES: ShipmentStatus[] = [
  "inWarehouseTH",
  "deliveryBooked",
  "outForDelivery",
];

/**
 * 「在途」= 从国内仓发出、还没进泰国仓的全部状态（2026-08-21 新增）。
 *
 * ⚠️ **从两条流程表自动推导，不要手写清单。**
 * 之前有两处各写了一份写死的名单，两份都出过错：
 *   ① 管理员看板数的是 `currentStatus === "inTransit"` —— 系统里**根本没有这个状态**，
 *      所以「在途订单」这个数字从上线起就一直是 0（生产实测：显示 0，实际 366 张）。
 *   ② AI 模块的 IN_TRANSIT_STATUSES 只列了海运，**漏掉全部 5 个陆运状态**
 *      （过境越南、老挝边境已放行等），问「在途多少」会少报陆运的货。
 * 自动推导之后，以后往流程里加环节这里会自己跟上。
 *
 * 口径按用户的业务说法（交接文档 1.5）：**装柜了 = 发走了**，所以从 loaded 起算；
 * 「已创建」「暂缓柜」「已入库」还没发走不算在途，已签收/退回/取消也不算。
 *
 * 2026-09-03 老板二次拍板收窄：**到了泰国仓就不算在途了**，
 * 所以 AT_WAREHOUSE_STATUSES 那三个也从这里排除。
 * ⚠️「正在卸柜 unloading」**留在在途里**——柜子还在卸、货还没进仓，这是老板明确要的。
 */
/**
 * 「未发出」= 货还在国内仓、还没装柜发走（2026-09-03 抽出来）。
 * 已入库 = 货到了国内仓，口径同「已创建/暂缓柜」，都还没上路。
 */
export const PENDING_STATUSES: ShipmentStatus[] = [
  "created",
  "inWarehouseCN",
  "holdLoading",
];

const NOT_IN_TRANSIT: ShipmentStatus[] = [
  ...PENDING_STATUSES,
  ...COMPLETED_STATUSES,
  ...SHIPMENT_EXCEPTION_STATUSES,
  // 2026-09-03：到了泰国仓（含预约派送、派送中）不再算在途
  ...AT_WAREHOUSE_STATUSES,
];

export const IN_TRANSIT_STATUSES: ShipmentStatus[] = Array.from(
  new Set([...SHIPMENT_STATUS_FLOW, ...SHIPMENT_STATUS_FLOW_LAND]),
).filter((s) => !NOT_IN_TRANSIT.includes(s));

/**
 * 「这个状态算不算在途」—— **排除法**版，判断单张运单时用这个，别用上面那个数组。
 *
 * ⚠️ 差别很要命：上面 IN_TRANSIT_STATUSES 是从两条流程表推导的**白名单**，
 * 流程表里没有的老状态（pickedUp / customsPending / receivedCN / inTransit 这些
 * 只在历史数据里出现的值）一个都不认，用 `.includes()` 判断会把它们判成「不在途」，
 * 那批货就从「在途」里凭空消失了（测试库实测：白名单数 14、减法数 17，差的就是这三张）。
 * 运单列表顶部数字和客户端分组按钮走的都是排除法（剩下的一律算在途），
 * 所以判断单张运单必须用这个函数，四处口径才真的是一份。
 */
export function isInTransitStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return !NOT_IN_TRANSIT.includes(status as ShipmentStatus);
}

/**
 * 顶部「延迟 / 查验」那格 —— 需要有人动手盯的运单（2026-09-03 抽出来并补齐）。
 *
 * ⚠️ 原来手写成 [delayDeparted, delayInTransit, borderDelay, customsInspect, exception]，
 * **漏掉了国内海关查验、泰国海关查验、港口封港**。
 * 「国内海关查验」是 2026-08-13 加进流程的，加的时候没人回来补这份名单，
 * 生产上被扣在国内查验的货因此一直不进这一格 —— 正是这份名单该提醒的那种货。
 *
 * 查验类**从流程表推导**（凡是 customsInspect 开头的都算），以后再加
 * 别国的查验环节会自己跟上，不用记得回来改这里。
 */
const INSPECT_STATUSES: ShipmentStatus[] = Array.from(
  new Set([...SHIPMENT_STATUS_FLOW, ...SHIPMENT_STATUS_FLOW_LAND]),
).filter((s) => s.startsWith("customsInspect"));

/** 延迟类：船没准点开、海上误点、堵在口岸、港口封港停作业 */
const DELAY_STATUSES: ShipmentStatus[] = [
  "delayDeparted",
  "delayInTransit",
  "borderDelay",
  "portClosed",
];

export const ATTENTION_STATUSES: ShipmentStatus[] = Array.from(
  new Set([...DELAY_STATUSES, ...INSPECT_STATUSES, ...SHIPMENT_EXCEPTION_STATUSES.filter((s) => s === "exception")]),
);

/** 客户看到的五个分组 */
export type ClientStatusGroup = "pending" | "transit" | "arrived" | "delivered" | "closed";

/**
 * 状态 → 客户端五分组（2026-09-03 抽到共享文件，全系统唯一一份）。
 *
 * ⚠️ 没被前四类认领的一律 transit（兜底）。**别改成白名单** ——
 * 老数据里流程表查不到的状态（pickedUp / customsPending / inTransit）会整单消失。
 */
export function classifyStatusGroup(status: string | null | undefined): ClientStatusGroup {
  if (!status || PENDING_STATUSES.includes(status as ShipmentStatus)) return "pending";
  if (status === "delivered") return "delivered";
  if (SHIPMENT_EXCEPTION_STATUSES.includes(status as ShipmentStatus)) return "closed";
  if (AT_WAREHOUSE_STATUSES.includes(status as ShipmentStatus)) return "arrived";
  return "transit";
}

/** 五个分组的中文名（导出 Excel、给客户看都用这个，别再漏英文出去） */
export const CLIENT_STATUS_GROUP_ZH: Record<ClientStatusGroup, string> = {
  pending: "未发出",
  transit: "在途",
  arrived: "已到仓",
  delivered: "已签收",
  closed: "退回/取消/异常",
};

/** 异常是关注维度，不改在途/到仓阶段；历史关闭状态仍可在全部订单中查看。 */
export type ShipmentListFilter = "all" | Exclude<ClientStatusGroup, "closed"> | "attention";

export function matchesShipmentListFilter(
  status: string | null | undefined,
  filter: ShipmentListFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "attention") return ATTENTION_STATUSES.includes(status as ShipmentStatus);
  return classifyStatusGroup(status) === filter;
}

/**
 * 一票货拆了子单、子单进度不一样时，列表要补的那句「（部分已放行）」。
 *
 * 老板 2026-09-16 拍板：**主状态一个字不动**（仍是最慢的那批货，见 parent-status.ts），
 * 分组、筛选、顶部四个数的口径也全部不变 —— 一票货只进一个页签，不重复出现。
 * 这里只负责算出「最快的那批走到哪了」，给显示层补一句话，把话说全。
 *
 * ⚠️ 海运 23 步、陆运 17 步是两套流程，必须按这票货自己的 transportMode 取对应那条线比快慢，
 *    否则陆运的「已到国内港口」会拿海运的序号去比，比出来的是假的。
 * ⚠️ 流程表里查不到的老状态（pickedUp / customsPending 这类）一律不参与比较 —— 猜不出它在哪一步，
 *    宁可不补话，也不能补错。
 * ⚠️ 子单比父单**慢**的时候不补话：那是父子状态本来就没同步好的老数据（2026-09-16 线上有 10 票），
 *    补一句「部分已到仓」只会让客户更糊涂，等状态修好它自然就对了。
 */
export function partialAheadStatus(
  parentStatus: string | null | undefined,
  childStatuses: readonly (string | null | undefined)[],
  parentPieceCount: number | null | undefined,
  transportMode: string | null | undefined,
): ShipmentStatus | null {
  if (!parentStatus || childStatuses.length === 0) return null;
  // 异常永远要让人看见：它不在流程表里，比不出快慢，但正是最该提醒的一种。
  if (childStatuses.some((s) => s === "exception")) return "exception";

  const flow = transportMode === "land" ? SHIPMENT_STATUS_FLOW_LAND : SHIPMENT_STATUS_FLOW;
  const parentIdx = flow.indexOf(parentStatus as ShipmentStatus);
  if (parentIdx < 0) return null;

  let bestIdx = parentIdx;
  let best: ShipmentStatus | null = null;
  for (const status of childStatuses) {
    // 退回 / 取消的货不会再往前走，拿它比快慢没有意义（跟 pickSlowestStatus 同一条规矩）
    if (!status || status === "returned" || status === "cancelled") continue;
    const idx = flow.indexOf(status as ShipmentStatus);
    if (idx > bestIdx) {
      bestIdx = idx;
      best = status as ShipmentStatus;
    }
  }
  // parentPieceCount 只是说明这一句为什么会出现：父单自己还留着货时主状态是它自己那批，
  // 子单跑到前面去了照样要补话。两种情况算法一样，留着参数是为了调用方看得懂。
  void parentPieceCount;
  return best;
}
