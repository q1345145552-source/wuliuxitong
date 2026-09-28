import { prisma } from "../../db/prisma";
import { COMPLETED_STATUSES } from "./status-flow";
import { AT_WAREHOUSE_STATUSES, ATTENTION_STATUSES } from "../../../../../packages/shared-types/shipment-status";

/* ==========================================================================
   运单列表顶部那排数字 —— 全系统唯一一份「在途 / 已到仓」计数口径
   --------------------------------------------------------------------------
   2026-09-03 从 shipments/routes.ts 抽出来共用。原因：管理员看板 KPI「在途运单」
   当时自己用 IN_TRANSIT_STATUSES 白名单数，跟这里的减法口径**对不上**——
   白名单只认流程表里的状态，老数据里的 pickedUp / customsPending / inTransit
   一张都数不到（测试库实测 KPI 14、顶部 17，差的就是这三张）。
   ⚠️ 别再在别处写第二份「在途」的算法：要这个数就 import 这个函数。
   ========================================================================== */

/**
 * 顶部那排数字的统计（2026-08-09，A3 方案 §3.2）。
 * 2026-08-10 三端共用：员工端/管理员端数全公司，客户端只数自己的，
 * 差别只有传进来的 where —— 口径必须一模一样，否则三个端对不上数。
 *
 * ⚠️ 「在途」用**减法**算，不要列举状态名。理由见下面 /staff 那条注释。
 */
/** 本月已签收（见 countShipmentOverview 里那段说明）。where 跟其余几格同一份，公司、客户、排整柜都照它 */
async function countSignedThisMonth(where: Record<string, unknown>, startOfMonth: Date): Promise<number> {
  const companyId = typeof where.companyId === "string" ? where.companyId : undefined;
  const logs = await prisma.statusLog.findMany({
    where: { toStatus: "delivered", changedAt: { gte: startOfMonth }, ...(companyId ? { companyId } : {}) },
    select: { shipment: { select: { trackingNo: true, parentTrackingNo: true } } },
  });
  const familyNos = [...new Set(logs.map((l) => l.shipment.parentTrackingNo ?? l.shipment.trackingNo))];
  if (familyNos.length === 0) return 0;
  return prisma.shipment.count({ where: { ...where, currentStatus: "delivered", trackingNo: { in: familyNos } } });
}

export async function countShipmentOverview(where: Record<string, unknown>) {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  /* 延迟 / 需要盯的。2026-09-03 改用共享清单 ATTENTION_STATUSES ——
     原来手写的那份漏掉了国内海关查验、泰国海关查验、港口封港三个，
     被扣在国内查验的货一直不进这一格，而那正是最该提醒的一种。
     查验类现在从流程表推导（customsInspect 开头的全算），以后加环节会自己跟上。 */

  const [total, created, atWarehouse, delivering, done, attention, signedThisMonth, exceptionCount] =
    await Promise.all([
      prisma.shipment.count({ where }),
      // 「未发出」：已创建 + 已入库 + 暂缓装柜（2026-09-02 复核对齐：客户端四分类的
      // pending 就是这三个，暂缓装柜的货同样躺在国内仓，不能掉进减法算出的「在途」。
      // 货都还在国内仓，绝不能掉进下面减法算出的「在途」里）
      prisma.shipment.count({ where: { ...where, currentStatus: { in: ["created", "inWarehouseCN", "holdLoading"] } } }),
      /* 2026-09-03 老板拍板：「已到仓」= 进了泰国仓之后、客户签收之前的**整段**，
         含预约派送和尾端派送中 —— 跟客户端分组按钮的 arrived 一字不差。
         原来这格只数 inWarehouseTH，顶部显示 119、点按钮出来 159，同一批货两个数。
         ⚠️ 改这里必须同时改下面 inTransit 的减法（派送中已经在这格里了，不能再减一次）
            和 ShipmentOverviewStrip.tsx 的标签，三处一起动。 */
      prisma.shipment.count({ where: { ...where, currentStatus: { in: AT_WAREHOUSE_STATUSES } } }),
      prisma.shipment.count({ where: { ...where, currentStatus: "outForDelivery" } }),
      prisma.shipment.count({ where: { ...where, currentStatus: { in: [...COMPLETED_STATUSES] } } }),
      prisma.shipment.count({ where: { ...where, currentStatus: { in: ATTENTION_STATUSES } } }),
      /* 本月已签收：按「真签收」那条轨迹的时间算（2026-09-28 审查报告第 21 条）。
         原来按 updatedAt（最后修改时间）：改一下三个月前签收的老单的备注，它就算成「本月签收」——
         生产只读核过：按修改时间 805 张，按真签收时间 688 张，多算 117 张。
         签收轨迹大多记在**子单**上（1411 张已签收父单里 1372 张父单自己没有签收记录），
         所以先找本月的签收轨迹，换成它所属的那票货（有父单记父单号，没有记自己），再数这些父单。 */
      countSignedThisMonth(where, startOfMonth),
      // 2026-09-02 终审整改（P2）：异常单单独数出来，从下面「在途」的减法里扣掉
      prisma.shipment.count({ where: { ...where, currentStatus: "exception" } }),
    ]);

  /**
   * 剩下的全算「在途」——任何没被上面几类认领的状态都不会凭空消失。
   * 2026-09-02 终审整改（P2）：exception 原来没从减法里扣，异常单被同时数进
   * 「在途」和「延迟/查验」两格。口径写清楚：
   *   · returned / cancelled 在 COMPLETED_STATUSES（done）里，减法早就扣过了；
   *   · 延迟/查验类（delayDeparted / delayInTransit / borderDelay / customsInspect）
   *     货确实还在路上，保留在「在途」里、同时出现在「延迟/查验」是有意为之；
   *   · exception 是「货不在正常途中」的异常态，只出现在「延迟/查验」那格；
   *   · 「正在卸柜 unloading」没被任何一格认领，兜底进「在途」——这正是老板要的
   *     （柜子还在卸、货还没进仓算在途），跟客户端 classifyClientStatusGroup 一致。
   * 对账等式（2026-09-03 起）：total = 未发出 + 已到仓（含预约派送/派送中）+ 已完成 + 异常 + 在途。
   */
  /* ⚠️ 2026-09-03 起不再单独减 delivering —— 派送中已经被上面的 atWarehouse 数进去了，
     两个都减会把这批货减两次，「在途」凭空少一截。deliveringCount 仍然返回（对账用）。 */
  const inTransit = total - created - atWarehouse - done - exceptionCount;

  return {
    inTransitCount: Math.max(0, inTransit),
    attentionCount: attention,
    atWarehouseCount: atWarehouse,
    signedThisMonthCount: signedThisMonth,
    // 下面这几个是给「四段相加等于总数」对账用的，界面上不显示
    totalCount: total,
    // ⚠️ 名字叫 createdCount，实际是「未发出」= 已创建 + 已入库（2026-09-02 起）。
    //    字段名不改 —— 前端 business-api.ts 的接口是逐字对齐的，改名要两边一起。
    createdCount: created,
    deliveringCount: delivering,
    doneCount: done,
    // 2026-09-02 终审整改：异常单数（对账用，界面不显示）——
    // 2026-09-03 起等式少一项（派送中并进了到仓）：
    // 未发出 + 已到仓 + 已完成 + 异常 + 在途 = total
    exceptionCount,
  };
}
