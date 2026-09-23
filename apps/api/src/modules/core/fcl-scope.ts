/**
 * 整柜跟普通运单的隔离（2026-09-23 老板定）。
 * ============================================================================
 *
 * 老板原话：「不想混在一起，整柜的不要出现在普通运单列表，而是一个单独的板块」；
 * 追问尾端派送时他答「排除，整柜的尾端单独在页面里弄」。
 *
 * 整柜在库里就是一张普通运单 + 一个打了 `isFcl` 标记的柜子（见 modules/fcl-containers）。
 * 所以凡是「列普通运单」的地方，都要把它排掉 —— 一共这么几条路，**改一处就要想到全部**
 * （CLAUDE.md 第 8b / 8c / 12 条：三端列表条件必须对齐；一个接口往往喂好几个页面）：
 *
 *   · 超管「运单管理」       /admin/orders
 *   · 员工「运单管理」       /staff/shipments        ← 同一个接口还喂着**装柜管理的候选**和**尾端派送的候选**
 *   · 客户「我的运单」       /client/orders
 *   · 客户「运单查询」       /client/shipments/search
 *   · 代理端运单列表         /agent/shipments
 *   · 各端的导出（跟着上面的列表走）
 *   · 首页 / 看板的统计数字
 *
 * ⚠️ 用「顺着柜子上的标记反查」而不是给运单再加一列：
 * 加列会出现「标记说是整柜、实际柜子不是」的对不上；反查永远跟柜子一致。
 */
import type { Prisma } from "@prisma/client";

/**
 * 运单层：这张运单**没有**装在任何一个整柜里。
 * 用法：`where: { ...EXCLUDE_FCL_SHIPMENT, companyId, ... }`
 */
export const EXCLUDE_FCL_SHIPMENT = {
  containerItems: { none: { container: { isFcl: true } } },
} satisfies Prisma.ShipmentWhereInput;

/**
 * 订单层：这个订单底下**没有**任何一张单装在整柜里。
 * 用法：`where: { ...EXCLUDE_FCL_ORDER, companyId, ... }`
 */
export const EXCLUDE_FCL_ORDER = {
  shipments: { none: { containerItems: { some: { container: { isFcl: true } } } } },
} satisfies Prisma.OrderWhereInput;

/**
 * 反过来：只要整柜的。给整柜自己那几个页面用。
 */
export const ONLY_FCL_SHIPMENT = {
  containerItems: { some: { container: { isFcl: true } } },
} satisfies Prisma.ShipmentWhereInput;

/**
 * 一张运单是不是整柜的（拿到实体之后判断用，比如装柜 / 卸柜 / 删单前的拦截）。
 * 传进来的运单要带上 `containerItems: { include: { container: true } }`。
 */
export function isFclShipment(shipment: {
  containerItems?: Array<{ container?: { isFcl?: boolean } | null }> | null;
}): boolean {
  return (shipment.containerItems ?? []).some((it) => it.container?.isFcl === true);
}

/** 拦下来时给人看的话 —— 三处（装柜 / 卸柜 / 删单）用同一句，免得各写各的 */
export const FCL_BLOCKED_MESSAGE = "这是整柜的运单，请到「整柜管理」里处理，普通装柜流程不动它";
