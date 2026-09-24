import { partialAheadStatus } from "../../../../../packages/shared-types/shipment-status";
import { deleteBlockedReasonOf, isCurrentStatusLog, isManagedLastmileLog } from "../shipments/managed-lastmile-log";
import { findDeletedLogAudits } from "../shipments/deleted-log-audits";
import { STATUS_FLOW as SHIP_FLOW, STATUS_FLOW_LAND as SHIP_FLOW_LAND } from "../shipments/status-flow";
import { DEFAULT_STATUS_LABELS } from "../ai/ai-config-store";
// 任务 #10: Container & 拆柜 API（2026-05-20）
// 实现湘泰物流 P0 阶段最核心的"出柜追踪"业务能力
//
// 数据模型：
//   Container（柜子）─┬─< ShipmentContainerItem（拆柜关系）>─┬─ Shipment（运单）
//                    │   loadedVolumeM3 + loadedPieceCount  │
// 一票货可拆到多个柜子（N:N）；柜子的状态自成一套状态机
//
// 柜子状态：LOADING → SEALED → DELAY_DEPARTED → IN_TRANSIT → DELAY_IN_TRANSIT
//           → ARRIVED → CUSTOMS → DELIVERING → SIGNED
//   两个「延迟」是可跳过的中间态：正常走就是 SEALED → IN_TRANSIT → ARRIVED

import { unloadAllItemsOfContainer } from "../shipments/unload-item";
import { lockAndSyncParents, lockShipmentsChildrenFirst } from "../shipments/lock-shipments";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import { FCL_BLOCKED_MESSAGE } from "../core/fcl-scope";
import { syncParentStatusFromChildren } from "../shipments/parent-status";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { sanitizeRemarkForClient } from "../core/client-privacy";
import { hideOperatorIdentity, operatorNameForDisplay } from "../core/operator-visibility";
import { productNamesLabel } from "../../../../../packages/shared-types/product-names";
import { logger } from "../core/logger";
import { canTransitLoose } from "../shipments/routes";
import { BusinessError } from "../core/business-error";
// 柜子状态流程的唯一定义处，别在本文件里再抄一份
import {
  CONTAINER_STATUS_FLOW,
  CONTAINER_STATUS_FLOW_LAND,
  CONTAINER_STATUS_LABEL,
  nextStopOf,
  CONTAINER_TO_SHIPMENT_STATUS,
  flowOf,
  neverGuessOf,
} from "./status-flow";

/**
 * 判断状态切换是否合法（只能往前推进，不能倒退；可同状态续写）。
 * 2026-08-06：加了 transportMode 参数 —— 陆运柜按陆运流程判断，
 * 不传（老调用方）时行为与以前完全一致，仍按海运流程。
 */
function canContainerTransit(from: string, to: string, transportMode?: string | null): boolean {
  if (from === to) return true;
  const flow = flowOf(transportMode);
  const fromIdx = flow.indexOf(from);
  const toIdx = flow.indexOf(to);
  if (fromIdx < 0 || toIdx < 0) return false;
  return toIdx > fromIdx;
}

/**
 * 整柜撤销后，货退回的那一步如果轨迹里一条记录都没有了（员工之前删过，比如 9-15 那种「装入柜子」），
 * 从删除存底（audit_logs）里把最近删掉的「装入柜子 <本柜号>」原样放回来，并记一条「撤销柜子时自动恢复」。
 * 这样员工可以放心删排在上面看着乱的「装入柜子」，撤销退回来以后客户顶上的状态照样有对应的一条。
 * 能被撤销退回、又能被删的记录实际上只有「已装柜」这一步（推进记录、改状态的补记不许删），所以只认装入柜子。
 * 2026-09-17 对抗测试：随便放回最近删的那条，会把员工故意删掉的写错记录、推进记录「已封柜」放回去（已修）。
 */
async function autoRestoreDeletedLogs(
  tx: any,
  companyId: string,
  actor: { userId: string; role: string },
  targets: Array<{ id: string; trackingNo: string; status: string }>,
  containerNo: string,
): Promise<number> {
  let restored = 0;
  for (const t of targets) {
    const has = await tx.statusLog.count({ where: { shipmentId: t.id, toStatus: t.status } });
    if (has > 0) continue;
    // 按运单 id 找存底（改过运单号也找得到，Codex 第三批 P2-1）
    const audits = await findDeletedLogAudits(tx, companyId, [t.id]);
    for (const a of audits) {
      let before: any;
      try { before = JSON.parse(a.beforeJson ?? "{}"); } catch { continue; }
      if (before.shipmentId !== t.id || before.toStatus !== t.status) continue;
      // 只放回「装入柜子 <这个柜号>」（柜号整号对上，后面只允许跟「（分装…）」）：
      // 员工删掉的写错的记录（柜号对不上）、推进记录（已封柜等）一律不放回。
      // 线上有一对柜号一个是另一个的开头（2026-09-17 只读查），所以不能只比开头。
      const rmk = String(before.remark ?? "");
      const loadRemark = `装入柜子 ${containerNo}`;
      if (!String(before.id ?? "").startsWith("sl_mnf_") || !(rmk === loadRemark || rmk.startsWith(`${loadRemark}（`))) continue;
      const exists = await tx.statusLog.findUnique({ where: { id: before.id }, select: { id: true } });
      if (exists) continue;
      await tx.statusLog.create({ data: {
        id: before.id, companyId: before.companyId, shipmentId: before.shipmentId,
        operatorId: before.operatorId, operatorRole: before.operatorRole, operatorName: before.operatorName ?? "",
        fromStatus: before.fromStatus, toStatus: before.toStatus, remark: before.remark ?? null, nextStop: before.nextStop ?? null,
        changedAt: new Date(before.changedAt),
      } });
      await tx.auditLog.create({ data: {
        companyId, actorId: actor.userId, actorRole: actor.role, action: "RESTORE", resourceType: "StatusLog",
        resourceId: before.id, afterJson: a.beforeJson, remark: `撤销柜子时自动恢复 ${t.trackingNo}`,
      } });
      restored++;
      break;
    }
  }
  return restored;
}

/** 只认「柜子推进状态」自己写的那批轨迹（说明见 legacyUndoPlan 里的注释） */
const PUSH_LOG_PREFIX = "sl_ctn_";

/**
 * 没有推进账本的老柜子（2026-09-17 上线前推的步骤）：这次推进发生在什么时候、上一步是什么。
 * 整柜撤销和撤销预览共用这一份，两边口径不会走散。
 */
async function legacyUndoPlan(
  container: { currentStatus: string; transportMode: string | null; items: Array<{ shipmentId: string }> },
  dates: Record<string, string>,
  companyId: string,
): Promise<{ shipmentIds: string[]; shipmentStatusOfThisPush: string | null; prevStatus: string | null; changedAt: Date | null }> {
  const shipmentIds = container.items.map((it) => it.shipmentId);
  const shipmentStatusOfThisPush: string | null = CONTAINER_TO_SHIPMENT_STATUS[container.currentStatus] ?? null;

  /* ==================================================================
     2026-08-10 修：撤销在生产上基本全废了。
     106 个柜子里 102 个点「撤销」都报「这是第一个状态，没有上一步可以退」——
     而它们明明是「运输中」「已到仓」这种中间状态。

     原因：这里完全依赖柜子身上那张「状态时间表」(statusDates)。那张表是
     2026-08-06 才加的，**加之前推过的状态一条都没补记**，所以老柜子要么整张表
     是空的（68 个），要么只有当前这一条（34 个）→ 找不到上一步 → 报了那句错话。
     而且那句话本身是错的：不是「第一个状态」，是「前面的没记录」。

     现在两级兜底：
       ① 这次推进是什么时候发生的：先看时间表；没有就去柜内运单的轨迹里，
          找「最后一次推到这个状态」的那条 —— 那条就是这次推进留下的痕迹。
       ② 上一步是哪个状态：先看时间表；没有就按流程往回退一格，
          但**跳过没记录推过的「意外状态」**（滞留/查验/延迟），
          否则等于把柜子退回一个它从来没到过的状态。
     ================================================================== */

  /* ⚠️ 只认「柜子推进状态」自己写的那批轨迹。
     轨迹按来源分好几种，id 前缀不一样（生产实测 2311 条）：
       sl_ctn_  柜子推进状态   1516 条  ← 只有这种是本次撤销该动的
       sl_lm_   尾端派送        619 条
       sl_mnf_  装柜时随柜补记  113 条
       sl_new_ / sl_fix_ 等老数据
     不加这个限制的后果（我拿生产数据算过）：68 个「时间表整张空」的柜子里，
     有 6 个会去删**别人写的**轨迹 —— 1 个删到尾端派送的、3 个删到装柜补记的、
     2 个删到老数据。那不是撤销，那是破坏。
     加了之后这 6 个找不到自己的推进记录，就只退柜子状态、不动运单，宁可少做。 */

  // ① 这次推进发生的时间
  let currentTs: string | null = dates[container.currentStatus] ?? null;
  if (!currentTs && shipmentStatusOfThisPush && shipmentIds.length > 0) {
    const lastLog = await prisma.statusLog.findFirst({
      where: {
        companyId: companyId,
        shipmentId: { in: shipmentIds },
        toStatus: shipmentStatusOfThisPush,
        id: { startsWith: PUSH_LOG_PREFIX },
      },
      orderBy: { changedAt: "desc" },
      select: { changedAt: true },
    });
    if (lastLog) currentTs = lastLog.changedAt.toISOString();
  }

  // ② 上一步是哪个状态
  // 2026-09-17：上一步按流程顺序找（柜子只能往前推，流程顺序就是推的顺序），不再按日期猜；
  // 改过运输方式、时间表里混着两条流程状态的老柜子才退回按日期找
  let prevStatus: string | null = null;
  {
    const flowNow = flowOf(container.transportMode);
    const curIdx = flowNow.indexOf(container.currentStatus);
    const mixedModes = Object.keys(dates).some((st) => flowNow.indexOf(st) < 0);
    if (!mixedModes) {
      const recorded = Object.keys(dates)
        .filter((st) => st !== container.currentStatus && flowNow.indexOf(st) >= 0 && flowNow.indexOf(st) < curIdx)
        .sort((a, b) => flowNow.indexOf(b) - flowNow.indexOf(a));
      if (curIdx >= 0 && recorded.length > 0) prevStatus = recorded[0]!;
    } else if (currentTs) {
      // 改过运输方式的老柜子：两条流程的状态混在时间表里，只能按日期找（原来的做法）
      const prevEntry = Object.entries(dates)
        .filter(([status, ts]) => status !== container.currentStatus && new Date(ts).getTime() <= new Date(currentTs!).getTime())
        .sort((a, b) => new Date(b[1]).getTime() - new Date(a[1]).getTime())[0];
      if (prevEntry) prevStatus = prevEntry[0];
    }
  }
  if (!prevStatus) {
    // 先按柜子自己的运输方式找；找不到再按另一条流程找 ——
    // 有柜子中途改过运输方式，当前状态可能压根不在现在这条流程里
    // （实测：一个标着「陆运」的柜子停在「运输中」，那是海运才有的环节）。
    const flows = [flowOf(container.transportMode), flowOf(container.transportMode === "land" ? "sea" : "land")];
    for (const flow of flows) {
      const idx = flow.indexOf(container.currentStatus);
      if (idx < 0) continue;
      for (let i = idx - 1; i >= 0; i--) {
        const candidate = flow[i]!;
        // 没记录推过的意外状态，绝不能退到那里去
        // ⚠️ 名单按运输方式取 —— 海运柜不能退进「出口已放行」，
        //    陆运柜不能退进「清关中」，两边的「少数柜才走」不是同一批。
        if (neverGuessOf(container.transportMode).has(candidate) && !dates[candidate]) continue;
        prevStatus = candidate;
        break;
      }
      if (prevStatus) break;
    }
  }
  return { shipmentIds, shipmentStatusOfThisPush, prevStatus, changedAt: currentTs ? new Date(currentTs) : null };
}

/** 撤销预览、撤销结果、推柜子跳过提示里给员工看的货状态中文名（名单唯一来源在 ai-config-store） */
const SHIPMENT_STATUS_ZH: Record<string, string> = Object.fromEntries(DEFAULT_STATUS_LABELS.map((i) => [i.status, i.labelZh]));
const shipmentStatusZh = (status: string): string => SHIPMENT_STATUS_ZH[status] ?? status;

/**
 * 「派送中 / 已签收」不是装柜页推的，是尾端派送那边推的。
 * 在装柜页撤销会把客户已经签收的单子悄悄退回去，还会删掉尾端派送写的轨迹，必须挡住（撤销和撤销预览共用）。
 */
const LASTMILE_ONLY_CONTAINER_STATUSES = new Set(["OUT_FOR_DELIVERY", "SIGNED", "DELIVERING"]);

/**
 * 撤销会不会把柜子和柜里的货退进两条不同的运输流程（2026-09-17，Codex 第三批第 4 轮）。
 *
 * 改运输方式只看柜子自己身上的证据（时间表、推进账本、开船/到港日期）。上线前推的老柜子只剩货的推进记录（sl_ctn_）时，
 * 那种记录上没记是哪个柜推的，改运输方式那边判不准，会放行；在撤销这一刻核对：柜子要退到的状态、柜里货要退回的状态，
 * 有一个是「另一种运输方式才有」的就不撤，提示先把运输方式改回去（整柜撤销、撤销预览都用这一份）。
 * 柜子现在的状态本身就不在自己运输方式的流程里（改运输方式功能出现之前留下的乱数据），照原来的做法不拦。
 */
function crossFlowUndoMessage(
  container: { transportMode: string | null; currentStatus: string },
  prevContainerStatus: string | null,
  shipmentBacks: Array<{ trackingNo: string; back: string }>,
): string | null {
  const ownFlow = flowOf(container.transportMode);
  if (!ownFlow.includes(container.currentStatus)) return null;
  const nowZh = container.transportMode === "land" ? "陆运" : container.transportMode === "sea" ? "海运" : "未标注运输方式（按海运走）";
  const otherZh = container.transportMode === "land" ? "海运" : "陆运";
  const tail = `这个柜子现在是${nowZh}，撤了柜子和货会对不上，没有撤销。要撤请先把运输方式改回${otherZh}。`;
  if (prevContainerStatus && !ownFlow.includes(prevContainerStatus)) {
    return `柜子要退回的「${CONTAINER_STATUS_LABEL[prevContainerStatus] ?? prevContainerStatus}」是${otherZh}才有的步骤，${tail}`;
  }
  const ownShip: readonly string[] = container.transportMode === "land" ? SHIP_FLOW_LAND : SHIP_FLOW;
  const otherShip: readonly string[] = container.transportMode === "land" ? SHIP_FLOW : SHIP_FLOW_LAND;
  const bad = shipmentBacks.filter((b) => otherShip.includes(b.back) && !ownShip.includes(b.back));
  if (bad.length === 0) return null;
  const sample = bad.slice(0, 3).map((b) => `${b.trackingNo}「${shipmentStatusZh(b.back)}」`).join("、");
  return `柜里 ${bad.length} 票货要退回的状态是${otherZh}才有的（${sample}${bad.length > 3 ? " 等" : ""}），${tail}`;
}

type LedgerEntry = { id: string; shipmentId: string; fromStatus: string; toStatus: string; statusLogId: string | null };
type LedgerShip = { id: string; trackingNo: string; currentStatus: string; parentTrackingNo: string | null };

/**
 * 按推进账本撤最近一笔时，哪些货跟着退、哪些不动（整柜撤销和撤销预览共用，口径不会走散）。
 *   · 同一票货在这一笔里有多条（卸下又装回），以最后写的那条为准；
 *   · 还在这个柜里、还停在这一步的跟着退，回到账本记的推之前的状态；
 *   · 已不在柜里、已经走到别的状态（比如尾端派送签收了）的不动，它们这一步的轨迹也不删。
 */
function classifyLedgerUndo(
  entries: LedgerEntry[],
  inBox: ReadonlySet<string>,
  ships: ReadonlyMap<string, LedgerShip>,
  trackingNoOf: ReadonlyMap<string, string>,
) {
  const byShipment = new Map<string, LedgerEntry>();
  for (const e of [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) byShipment.set(e.shipmentId, e);
  const reverted: Array<{ id: string; trackingNo: string; parentTrackingNo: string | null; from: string; current: string; logId: string | null }> = [];
  const skipped: Array<{ trackingNo: string; reason: string }> = [];
  for (const [sid, e] of byShipment) {
    const s = ships.get(sid);
    if (!inBox.has(sid) || !s) {
      // 已经卸下删掉的子单没有单号可给，不列
      if (trackingNoOf.has(sid)) skipped.push({ trackingNo: trackingNoOf.get(sid)!, reason: "已不在这个柜里" });
      continue;
    }
    if (s.currentStatus !== e.toStatus) {
      skipped.push({ trackingNo: s.trackingNo, reason: `已经是「${shipmentStatusZh(s.currentStatus)}」，不跟着退` });
      continue;
    }
    reverted.push({ id: s.id, trackingNo: s.trackingNo, parentTrackingNo: s.parentTrackingNo, from: e.fromStatus, current: s.currentStatus, logId: e.statusLogId });
  }
  return { reverted, skipped };
}

function decToNumber(value: Prisma.Decimal | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Number(value.toString());
}

export function registerContainerRoutes(app: MinimalHttpApp): void {
  // ============ 柜子列表 ============
  app.get("/admin/containers", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "staff"]);
    if (!auth) return;

    const statusFilter = req.query.status?.trim();
    const where: Prisma.ContainerWhereInput = { companyId: auth.companyId };
    if (statusFilter) where.currentStatus = statusFilter;

    const containers = await prisma.container.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { items: true } },
        items: { select: { loadedVolumeM3: true, loadedPieceCount: true } },
      },
    });

    const items = containers.map((c) => {
      const totalVolume = c.items.reduce((sum, it) => sum + decToNumber(it.loadedVolumeM3), 0);
      const totalPieces = c.items.reduce((sum, it) => sum + it.loadedPieceCount, 0);
      return {
        id: c.id,
        containerNo: c.containerNo,
        containerType: c.containerType,
        carrierName: c.carrierName ?? null,
        loadingDate: c.loadingDate?.toISOString() ?? null,
        departureDate: c.departureDate?.toISOString() ?? null,
        eta: c.eta?.toISOString() ?? null,
        ata: c.ata?.toISOString() ?? null,
        customsClearedAt: c.customsClearedAt?.toISOString() ?? null,
        currentStatus: c.currentStatus,
        currentStatusLabel: CONTAINER_STATUS_LABEL[c.currentStatus] ?? c.currentStatus,
        shipmentCount: c._count.items,
        totalLoadedVolumeM3: Number(totalVolume.toFixed(3)),
        totalLoadedPieceCount: totalPieces,
        remark: c.remark ?? undefined,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      };
    });

    ok(res, { items, total: items.length });
  });

  // ============ 柜子详情（含装载的所有运单）============
  app.get("/admin/containers/detail", async (req, res) => {
    /**
     * ⚠️ 客户角色不许进这个接口（2026-08-31 修）。
     * 前端从来没有任何页面让客户调它（grep 全仓库确认过），但接口原来对 client 开着：
     *   ① 内部备注 remark 会原文下发给客户 —— 别的敏感字段都屏蔽了，唯独它漏了；
     *   ② 「柜号真的回 403、假的回 404」能被拿来一个个试探柜号 ——
     *      正撞「客户不能看到柜号」这条红线（2026-08-07 定的）。
     * 干脆把 client 从名单里拿掉。下面的 isClient 分支保留当第二道保险：
     * 万一将来有人把 client 加回来，敏感字段照样不下发。
     */
    const auth = requireRole(req, res, ["admin", "staff"]);
    if (!auth) return;

    const id = req.query.id?.trim();
    const containerNo = req.query.containerNo?.trim();
    if (!id && !containerNo) {
      fail(res, 400, "BAD_REQUEST", "id or containerNo is required");
      return;
    }

    const container = await prisma.container.findFirst({
      where: id ? { id, companyId: auth.companyId } : { containerNo, companyId: auth.companyId },
      include: {
        items: {
          include: {
            shipment: {
              include: {
                order: {
                  select: {
                    id: true,
                    orderNo: true,
                    itemName: true,
                    clientId: true,
                    receiverNameTh: true,
                    receiverAddressTh: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!container) {
      fail(res, 404, "NOT_FOUND", "container not found");
      return;
    }

    // 客户角色：只能看到含自己货的柜子
    if (auth.role === "client") {
      const isOwn = container.items.some((it) => it.shipment.order?.clientId === auth.userId);
      if (!isOwn) {
        fail(res, 403, "FORBIDDEN", "you have no shipment in this container");
        return;
      }
    }

    const totalVolume = container.items.reduce((sum, it) => sum + decToNumber(it.loadedVolumeM3), 0);
    const totalPieces = container.items.reduce((sum, it) => sum + it.loadedPieceCount, 0);

    // 客户端不允许查看柜号、船期等装柜敏感信息
    const isClient = auth.role === "client";
    ok(res, {
      id: container.id,
      containerNo: isClient ? undefined : container.containerNo,
      containerType: isClient ? undefined : container.containerType,
      carrierName: isClient ? undefined : (container.carrierName ?? null),
      loadingDate: isClient ? undefined : (container.loadingDate?.toISOString() ?? null),
      departureDate: isClient ? undefined : (container.departureDate?.toISOString() ?? null),
      eta: isClient ? undefined : (container.eta?.toISOString() ?? null),
      ata: isClient ? undefined : (container.ata?.toISOString() ?? null),
      customsClearedAt: isClient ? undefined : (container.customsClearedAt?.toISOString() ?? null),
      currentStatus: container.currentStatus,
      currentStatusLabel: isClient ? undefined : (CONTAINER_STATUS_LABEL[container.currentStatus] ?? container.currentStatus),
      // 内部备注是员工写给自己人看的，客户不下发（2026-08-31 补；现在 client 已进不来，这是第二道保险）
      remark: isClient ? undefined : (container.remark ?? undefined),
      totalLoadedVolumeM3: isClient ? undefined : Number(totalVolume.toFixed(3)),
      totalLoadedPieceCount: isClient ? undefined : totalPieces,
      shipments: container.items
        .filter((it) => !isClient || it.shipment.order?.clientId === auth.userId)
        .map((it) => ({
          shipmentId: it.shipmentId,
          trackingNo: it.shipment.trackingNo,
          orderId: it.shipment.order?.id ?? null,
          orderNo: it.shipment.order?.orderNo ?? null,
          itemName: it.shipment.order?.itemName ?? null,
          receiverNameTh: it.shipment.order?.receiverNameTh ?? null,
          receiverAddressTh: it.shipment.order?.receiverAddressTh ?? null,
          loadedVolumeM3: isClient ? undefined : decToNumber(it.loadedVolumeM3),
          loadedPieceCount: isClient ? undefined : it.loadedPieceCount,
          shipmentTotalVolumeM3: isClient ? undefined : (it.shipment.volumeM3 ? decToNumber(it.shipment.volumeM3) : null),
          isSplit: isClient ? undefined : (
            it.shipment.volumeM3 !== null &&
            decToNumber(it.loadedVolumeM3) < decToNumber(it.shipment.volumeM3) - 0.001
          ),
          currentStatus: it.shipment.currentStatus,
        })),
      createdAt: container.createdAt.toISOString(),
      updatedAt: container.updatedAt.toISOString(),
    });
  });

  // ============ 新建柜子 ============
  app.post("/admin/containers", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      containerNo?: string;
      containerType?: "20GP" | "40HQ" | string;
      carrierName?: string;
      loadingDate?: string;
      departureDate?: string;
      eta?: string;
      remark?: string;
      transportMode?: string;
    };
    const containerNo = body.containerNo?.trim();
    const containerType = body.containerType?.trim();
    if (!containerNo || !containerType) {
      fail(res, 400, "BAD_REQUEST", "containerNo and containerType are required");
      return;
    }

    const existed = await prisma.container.findUnique({
      where: { containerNo },
      select: { id: true },
    });
    if (existed) {
      fail(res, 409, "VALIDATION_ERROR", "柜号已存在，请换一个");
      return;
    }

    /**
     * ⚠️ 运输方式必填（2026-08-27 补）。
     * 这个字段可以为空，而 flowOf(null) 会**默认按海运**走 ——
     * 于是从这个接口建出来的陆运柜，推「过境越南」会被拒（说不属于海运流程），
     * 「下一站」也会被填成海运的默认值。装柜页那个正式入口一直是强制选的，
     * 只有这条老路漏了（前端目前没人调它，但接口开着就可能被用到）。
     */
    const transportMode = body.transportMode?.trim();
    if (transportMode !== "sea" && transportMode !== "land") {
      fail(res, 400, "BAD_REQUEST", "请选择运输方式：海运或陆运");
      return;
    }

    const created = await prisma.container.create({
      data: {
        companyId: auth.companyId,
        containerNo,
        containerType,
        carrierName: body.carrierName?.trim() || null,
        loadingDate: body.loadingDate ? new Date(body.loadingDate) : null,
        departureDate: body.departureDate ? new Date(body.departureDate) : null,
        eta: body.eta ? new Date(body.eta) : null,
        currentStatus: "LOADING",
        transportMode,
        remark: body.remark?.trim() || null,
      },
    });

    ok(res, {
      id: created.id,
      containerNo: created.containerNo,
      currentStatus: created.currentStatus,
      createdAt: created.createdAt.toISOString(),
    });
  });

  // ============ 变更柜子状态（含自动连带）============
  // - IN_TRANSIT 时记录 departureDate（若未填）
  // - ARRIVED 时记录 ata（实际到港）
  // - CUSTOMS 完成 → 自动写 customsClearedAt
  // - DELIVERING 时把柜内所有运单的 currentStatus 推进到 outForDelivery
  // - SIGNED 时把柜内所有运单的 currentStatus 推进到 delivered
  app.post("/admin/containers/status", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "staff"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { id?: string; toStatus?: string; remark?: string; date?: string; nextStop?: string };
    const id = body.id?.trim();
    const toStatus = body.toStatus?.trim();
    if (!id || !toStatus) {
      fail(res, 400, "BAD_REQUEST", "id and toStatus are required");
      return;
    }

    const container = await prisma.container.findFirst({
      where: { id, companyId: auth.companyId },
      include: { items: { select: { shipmentId: true } } },
    });
    if (!container) {
      fail(res, 404, "NOT_FOUND", "container not found");
      return;
    }

    // 2026-08-06：合法状态与推进规则都改为按柜子的运输方式判断。
    // 陆运柜不能推到「已开船/已到港」，海运柜也不能推到「过境越南」这类陆运环节。
    const flow = flowOf(container.transportMode);
    if (!flow.includes(toStatus)) {
      const isLand = container.transportMode === "land";
      fail(
        res,
        400,
        "VALIDATION_ERROR",
        `「${CONTAINER_STATUS_LABEL[toStatus] ?? toStatus}」不属于${isLand ? "陆运" : "海运"}流程`,
      );
      return;
    }

    if (!canContainerTransit(container.currentStatus, toStatus, container.transportMode)) {
      fail(
        res,
        400,
        "VALIDATION_ERROR",
        `不能从「${CONTAINER_STATUS_LABEL[container.currentStatus] ?? container.currentStatus}」退回或跳到「${CONTAINER_STATUS_LABEL[toStatus] ?? toStatus}」`,
      );
      return;
    }

    // 下一站：员工填了就用他填的，没填就用这个状态的默认值（可能没有，那就不写）
    // ⚠️ 默认值必须按柜子的运输方式取。原来这里不看运输方式，海运柜推到「已封柜」
    //    也会被填成陆运的「广西凭祥出口」，而且**前端把框清空也照样补上**。
    const nextStop = typeof body.nextStop === "string" && body.nextStop.trim()
      ? body.nextStop.trim().slice(0, 50)
      : nextStopOf(toStatus, container.transportMode);

    const customDate = typeof body.date === "string" && body.date.trim()
      ? new Date(body.date.trim() + "T00:00:00")
      : null;
    const now = customDate && !Number.isNaN(customDate.getTime()) ? customDate : new Date();
    const updateData: Prisma.ContainerUpdateInput = {
      currentStatus: toStatus,
      updatedAt: now,
    };
    if (toStatus === "IN_TRANSIT" && !container.departureDate) updateData.departureDate = now;
    if (toStatus === "ARRIVED" && !container.ata) updateData.ata = now;
    // 2026-08-06：把这一步实际发生的日期记进柜子（员工填了日期就用他填的）。
    // 后面「货到了才建柜、再把运单装进去」时，要靠这些真实日期给运单补记轨迹，
    // 没有它补出来的时间只能瞎摊 —— 实测会把 9 条轨迹全摊在同一分钟。
    {
      let dates: Record<string, string> = {};
      try { dates = container.statusDates ? JSON.parse(container.statusDates) : {}; } catch { dates = {}; }
      dates[toStatus] = now.toISOString();
      updateData.statusDates = JSON.stringify(dates);
    }
    const shipmentIds = container.items.map((it) => it.shipmentId);
    // 这批子单涉及的父单号，等主体事务提交后统一重算父单状态
    let parentNosToSync: string[] = [];

    /**
     * ⚠️ 事务外这一段**只做校验、不再组装写操作**（2026-08-28 改）。
     *
     * 历史：2026-08-25 曾把写操作攒成一个 `ops` 函数数组、拿到事务后再逐个执行，
     * 为的是把「柜子 + 子单 + 轨迹 + 父单」合进一个事务（分两个事务会留下
     * 「柜子和子单推进了、父单没推」的半截数据，重跑还会多写一批轨迹）。
     * 那个目的仍然成立，但攒 ops 的时机不对 —— 攒的时候还没拿到柜锁，
     * 用的是可能已经过时的装柜清单。现在直接在事务里写，不再攒。
     * 真正写什么、推哪几票货，全部在下面的事务里、拿到柜锁之后重新查过再决定 ——
     * 否则用的是事务外那份可能已经过时的装柜清单。
     */
    const shipmentNextStatus: string | null = CONTAINER_TO_SHIPMENT_STATUS[toStatus] ?? null;
    let affectedShipmentCount = 0;
    let skippedShipments: Array<{ trackingNo: string; status: string }> = [];

    /**
     * 2026-09-17（推进账本）：退回/取消的货、比这一步靠后的派送/签收货，推柜子时跳过，不再挡住整柜。
     * 原来整柜报「不允许流转」，撤销过的柜子（柜里有已签收的货）从此推不回去。
     */
    // 派送三步单独排先后，不按运输流程比：陆运流程里没有「预约派送」，按流程下标比会查不到、不跳过、整柜报错（Codex 第三批 P2-2）
    const LASTMILE_RANK: Record<string, number> = { deliveryBooked: 1, outForDelivery: 2, delivered: 3 };
    const skipOnPush = (status: string): boolean => {
      // 退回/取消一律跳过；预约派送/派送中/已签收只在比这一步靠后时跳过（推到派送中、已签收时照样跟着推）
      if (status === "returned" || status === "cancelled") return true;
      const rank = LASTMILE_RANK[status];
      if (!rank || !shipmentNextStatus) return false;
      const targetRank = LASTMILE_RANK[shipmentNextStatus];
      // 这一步不是派送三步（装柜、运输、清关、入仓…）：派送的货一定比它靠后
      return !targetRank || rank > targetRank;
    };

    if (shipmentNextStatus && shipmentIds.length > 0) {
      const shipments = await prisma.shipment.findMany({
        where: { id: { in: shipmentIds }, companyId: auth.companyId },
        select: { id: true, trackingNo: true, currentStatus: true },
      });
      const invalidShipments = shipments.filter(
        (s) => !skipOnPush(s.currentStatus) && !canTransitLoose(s.currentStatus, shipmentNextStatus!),
      );
      if (invalidShipments.length > 0) {
        const ids = invalidShipments.map((s) => `${s.trackingNo}(${s.currentStatus})`).join(", ");
        fail(res, 400, "VALIDATION_ERROR", `以下运单不允许从当前状态流转到 ${shipmentNextStatus}：${ids}`);
        return;
      }
    }

    await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM containers WHERE id = ${container.id} FOR UPDATE`;
        const freshContainer = await tx.container.findUnique({
          where: { id: container.id },
          select: { currentStatus: true, transportMode: true, statusDates: true, departureDate: true, ata: true },
        });
        if (freshContainer == null) throw new BusinessError("柜子不存在", 404, "NOT_FOUND");
        const nowStatus = freshContainer.currentStatus;
        if (nowStatus !== container.currentStatus) {
          throw new BusinessError(
            `这个柜刚刚被别人推到了「${CONTAINER_STATUS_LABEL[nowStatus] ?? nowStatus}」，本次推进没有执行，请刷新后再看`,
          );
        }
        if (freshContainer.transportMode !== container.transportMode) {
          throw new BusinessError("这个柜刚刚被别人改了运输方式，本次推进没有执行，请刷新后再推");
        }

        const freshItems = await tx.shipmentContainerItem.findMany({
          where: { containerId: container.id },
          select: { shipmentId: true },
        });
        const freshShipmentIds = [...new Set(freshItems.map((it: { shipmentId: string }) => it.shipmentId))];

        /* ⚠️ 状态时间表要**在锁里按最新那份重拼**（2026-09-24 复核抓到，Codex 和 Opus 两家都报了）。
           上面那份 `updateData.statusDates` 是在**事务外**拿 `container.statusDates` 拼的。
           2026-09-24 「改整柜」上线之后，改装柜日期也会写这张表 ——
           于是「员工推一步状态」和「员工改装柜日期」同时发生时，
           推进这边会拿进门时那份旧 JSON 整张盖回去，把刚改好的「已封柜」那一格又写回旧日期
           （实测 4 次并发有 3 次中招）。锁后已经重读了 freshContainer，就按它重拼一遍。 */
        {
          let freshDates: Record<string, string> = {};
          try { freshDates = freshContainer.statusDates ? JSON.parse(freshContainer.statusDates) : {}; }
          catch { freshDates = {}; }
          freshDates[toStatus] = now.toISOString();
          updateData.statusDates = JSON.stringify(freshDates);
        }

        await tx.container.update({ where: { id: container.id }, data: updateData });

        // 推进账本：记下这一笔，撤销时原样倒回去
        const lastBatch = await tx.containerPushBatch.findFirst({
          where: { containerId: container.id, companyId: auth.companyId },
          orderBy: { seq: "desc" },
          select: { seq: true },
        });
        const rand = () => Math.random().toString(36).slice(2, 6);
        const batchId = `cpb_${Date.now()}_${rand()}`;
        await tx.containerPushBatch.create({
          data: {
            id: batchId,
            companyId: auth.companyId,
            containerId: container.id,
            seq: (lastBatch?.seq ?? 0) + 1,
            fromContainerStatus: freshContainer.currentStatus,
            toContainerStatus: toStatus,
            changedAt: now,
            prevStatusDates: freshContainer.statusDates,
            prevDepartureDate: freshContainer.departureDate,
            prevAta: freshContainer.ata,
            operatorId: auth.userId,
          },
        });

        if (shipmentNextStatus && freshShipmentIds.length > 0) {
          await lockShipmentsChildrenFirst(tx, freshShipmentIds, auth.companyId);
          const freshShipments = await tx.shipment.findMany({
            where: { id: { in: freshShipmentIds }, companyId: auth.companyId },
            select: { id: true, trackingNo: true, currentStatus: true, parentTrackingNo: true },
          });
          const moving = freshShipments.filter((sp: { currentStatus: string }) => !skipOnPush(sp.currentStatus));
          skippedShipments = freshShipments
            .filter((sp: { currentStatus: string }) => skipOnPush(sp.currentStatus))
            .map((sp: { trackingNo: string; currentStatus: string }) => ({ trackingNo: sp.trackingNo, status: sp.currentStatus }));
          const badNow = moving.filter(
            (sp: { currentStatus: string }) => !canTransitLoose(sp.currentStatus, shipmentNextStatus!),
          );
          if (badNow.length > 0) {
            const ids = badNow
              .map((sp: { trackingNo: string; currentStatus: string }) => `${sp.trackingNo}(${sp.currentStatus})`)
              .join(", ");
            throw new BusinessError(`以下运单刚刚变了状态，本次推进没有执行，请刷新后再看：${ids}`, 400, "VALIDATION_ERROR");
          }
          if (moving.length > 0) {
            const movingIds = moving.map((sp: { id: string }) => sp.id);
            await tx.shipment.updateMany({
              where: { id: { in: movingIds }, companyId: auth.companyId },
              data: { currentStatus: shipmentNextStatus, updatedAt: now },
            });
            const stamp = Date.now();
            const rows = moving.map((sp: { id: string; currentStatus: string }, i: number) => ({
              logId: `sl_ctn_${stamp}_${i}_${rand()}`,
              sp,
              i,
            }));
            await tx.statusLog.createMany({
              data: rows.map(({ logId, sp }: { logId: string; sp: { id: string; currentStatus: string } }) => ({
                id: logId,
                companyId: auth.companyId,
                shipmentId: sp.id,
                operatorId: auth.userId,
                operatorRole: auth.role,
                operatorName: auth.name,
                fromStatus: sp.currentStatus,
                toStatus: shipmentNextStatus,
                remark: body.remark?.trim() || `${CONTAINER_STATUS_LABEL[toStatus] ?? toStatus}`,
                nextStop,
                changedAt: now,
              })),
            });
            await tx.containerPushEntry.createMany({
              data: rows.map(({ logId, sp, i }: { logId: string; sp: { id: string; currentStatus: string }; i: number }) => ({
                id: `cpe_${stamp}_${String(i).padStart(5, "0")}_${rand()}`,
                companyId: auth.companyId,
                batchId,
                shipmentId: sp.id,
                fromStatus: sp.currentStatus,
                toStatus: shipmentNextStatus!,
                statusLogId: logId,
                kind: "push",
              })),
            });
            parentNosToSync = [
              ...new Set(
                moving
                  .filter((sp: { parentTrackingNo: string | null }) => sp.parentTrackingNo)
                  .map((sp: { parentTrackingNo: string | null }) => sp.parentTrackingNo!),
              ),
            ];
          }
          affectedShipmentCount = moving.length;
        }

        await lockAndSyncParents(tx, parentNosToSync, auth.companyId, syncParentStatusFromChildren);
      },
      { timeout: 30000, maxWait: 10000 },
    );

    ok(res, {
      id: container.id,
      containerNo: container.containerNo,
      fromStatus: container.currentStatus,
      toStatus,
      affectedShipmentCount,
      skippedShipments,
      updatedAt: now.toISOString(),
    });
  });

  /**
   * 撤销这个柜子「上一次状态推进」（员工和管理员都能用）。
   *
   * 2026-08-07 加的。柜子状态原来只能往前推，推错了回不去 ——
   * 真实案例：柜子已开船之后被误推成「延迟运输」，柜里每张运单都被写了一条
   * 「延迟运输」的轨迹，客户看到的就是「运输中」突然变「延迟运输」。
   * 一张张删要开几十次弹窗，所以在柜子这里一次撤掉整批。
   *
   * 怎么认出「上一次那批」：推进时整批日志用的是同一个时间戳（代码里的 now），
   * 并且柜子的 statusDates 里记着每个状态是什么时候推的。
   * 所以「柜里的运单 + changedAt 等于当前状态的时间戳 + toStatus 对得上」就是那一批。
   *
   * 撤完：
   * - 柜子退回上一个状态（按 statusDates 里时间仅次于当前的那个）
   * - 每张运单的当前状态按它自己剩下的最后一条轨迹重算；一条不剩就保持不动
   * - 这次推进顺手写进柜子的开船日期/到港日期，如果就是这次写的，也一并撤掉
   */
  /**
   * 撤销预览（2026-09-17）：点「撤销」之前告诉员工 —— 柜子会退到哪一步、多少票货跟着退、哪几票不动为什么。
   * 跟真撤销用同一份判断（classifyLedgerUndo / legacyUndoPlan），只读不写。
   */
  app.get("/admin/containers/status/undo-preview", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "staff"]);
    if (!auth) return;
    const id = req.query.id?.trim();
    if (!id) {
      fail(res, 400, "BAD_REQUEST", "id is required");
      return;
    }
    const container = await prisma.container.findFirst({
      where: { id, companyId: auth.companyId },
      include: { items: { select: { shipmentId: true } } },
    });
    if (!container) {
      fail(res, 404, "NOT_FOUND", "找不到这个柜子");
      return;
    }
    /* 整柜：**只拦没有推进账本的那一步**（2026-09-24 复核调整）。
       整柜的起点「已封柜」是建柜时直接写进去的、没有账本，撤销它会掉进 legacy 分支
       （那条路只删 sl_ctn_ 前缀的轨迹，而整柜起点那条是 sl_fcl_，一条都删不掉）
       → 柜子退回「装柜中」、货还停在「已装柜」，内部和客户看到的对不上。
       但后面那些状态是正常推出来的、**有账本**，撤销走账本路径是安全的 ——
       上一版一刀切全拦，员工推错「已到港」就再也纠正不了了，太狠。 */
    if (container.isFcl) {
      const hasLedger = await prisma.containerPushBatch.findFirst({
        where: { containerId: container.id, companyId: auth.companyId },
        select: { id: true },
      });
      if (!hasLedger) {
        fail(res, 400, "VALIDATION_ERROR",
          "整柜的「已封柜」是建柜时就定下的，不能在这里撤销；柜子建错了请在「整柜管理」里处理");
        return;
      }
    }
    if (LASTMILE_ONLY_CONTAINER_STATUSES.has(container.currentStatus)) {
      fail(res, 400, "VALIDATION_ERROR", `「${CONTAINER_STATUS_LABEL[container.currentStatus] ?? container.currentStatus}」是尾端派送那边推的，不能在装柜页撤销。要退请到「尾端派送」里操作。`);
      return;
    }
    const inBox = new Set(container.items.map((it) => it.shipmentId));
    const latestBatch = await prisma.containerPushBatch.findFirst({
      where: { containerId: container.id, companyId: auth.companyId },
      orderBy: { seq: "desc" },
      include: { entries: true },
    });
    if (latestBatch) {
      if (latestBatch.toContainerStatus !== container.currentStatus) {
        fail(res, 409, "VALIDATION_ERROR", "柜子现在的状态跟推进账本对不上，没法撤销，请联系技术处理");
        return;
      }
      const entryShipmentIds = [...new Set(latestBatch.entries.map((e) => e.shipmentId))];
      const ships = await prisma.shipment.findMany({
        where: { id: { in: entryShipmentIds }, companyId: auth.companyId },
        select: { id: true, trackingNo: true, currentStatus: true, parentTrackingNo: true },
      });
      const { reverted, skipped } = classifyLedgerUndo(
        latestBatch.entries,
        inBox,
        new Map(ships.map((s) => [s.id, s])),
        new Map(ships.map((s) => [s.id, s.trackingNo])),
      );
      const crossLedgerPreview = crossFlowUndoMessage(container, latestBatch.fromContainerStatus, reverted.map((r) => ({ trackingNo: r.trackingNo, back: r.from })));
      if (crossLedgerPreview) {
        fail(res, 409, "VALIDATION_ERROR", crossLedgerPreview);
        return;
      }
      ok(res, {
        mode: "ledger",
        currentStatus: container.currentStatus,
        prevStatus: latestBatch.fromContainerStatus,
        revertCount: reverted.filter((r) => r.from !== r.current).length,
        keep: skipped,
      });
      return;
    }
    // 没有账本的老柜子（上线前推的步骤）
    let dates: Record<string, string> = {};
    try { dates = container.statusDates ? JSON.parse(container.statusDates) : {}; } catch { dates = {}; }
    const plan = await legacyUndoPlan(container, dates, auth.companyId);
    if (!plan.prevStatus) {
      fail(res, 400, "VALIDATION_ERROR", `「${CONTAINER_STATUS_LABEL[container.currentStatus] ?? container.currentStatus}」已经是这个柜子流程里的第一步，没有上一步可以退。`);
      return;
    }
    let revertCount = 0;
    const keep: Array<{ trackingNo: string; reason: string }> = [];
    const legacyBacks: Array<{ trackingNo: string; back: string }> = [];
    if (plan.changedAt && plan.shipmentStatusOfThisPush && plan.shipmentIds.length > 0) {
      const pushLogs = await prisma.statusLog.findMany({
        where: {
          companyId: auth.companyId,
          shipmentId: { in: plan.shipmentIds },
          changedAt: plan.changedAt,
          toStatus: plan.shipmentStatusOfThisPush,
          id: { startsWith: PUSH_LOG_PREFIX },
        },
        orderBy: { id: "asc" },
        select: { shipmentId: true, fromStatus: true },
      });
      const before = new Map<string, string>();
      for (const row of pushLogs) if (!before.has(row.shipmentId)) before.set(row.shipmentId, row.fromStatus);
      const ships = await prisma.shipment.findMany({
        where: { id: { in: plan.shipmentIds }, companyId: auth.companyId },
        select: { id: true, trackingNo: true, currentStatus: true },
      });
      for (const s of ships) {
        if (s.currentStatus !== plan.shipmentStatusOfThisPush) keep.push({ trackingNo: s.trackingNo, reason: `已经是「${shipmentStatusZh(s.currentStatus)}」，不跟着退` });
        else if (!before.has(s.id)) keep.push({ trackingNo: s.trackingNo, reason: "上线前后装进柜的货，没有这一步的推进记录，不跟着退" });
        else {
          legacyBacks.push({ trackingNo: s.trackingNo, back: before.get(s.id)! });
          if (before.get(s.id) !== s.currentStatus) revertCount++;
        }
      }
    }
    const crossLegacyPreview = crossFlowUndoMessage(container, plan.prevStatus, legacyBacks);
    if (crossLegacyPreview) {
      fail(res, 409, "VALIDATION_ERROR", crossLegacyPreview);
      return;
    }
    ok(res, { mode: "legacy", currentStatus: container.currentStatus, prevStatus: plan.prevStatus, revertCount, keep });
  });

  app.post("/admin/containers/status/undo", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "staff"]);
    if (!auth) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) {
      fail(res, 400, "BAD_REQUEST", "id is required");
      return;
    }

    const container = await prisma.container.findFirst({
      where: { id, companyId: auth.companyId },
      include: { items: { select: { shipmentId: true } } },
    });
    if (!container) {
      fail(res, 404, "NOT_FOUND", "找不到这个柜子");
      return;
    }
    /* 整柜：**只拦没有推进账本的那一步**（2026-09-24 复核调整）。
       整柜的起点「已封柜」是建柜时直接写进去的、没有账本，撤销它会掉进 legacy 分支
       （那条路只删 sl_ctn_ 前缀的轨迹，而整柜起点那条是 sl_fcl_，一条都删不掉）
       → 柜子退回「装柜中」、货还停在「已装柜」，内部和客户看到的对不上。
       但后面那些状态是正常推出来的、**有账本**，撤销走账本路径是安全的 ——
       上一版一刀切全拦，员工推错「已到港」就再也纠正不了了，太狠。 */
    if (container.isFcl) {
      const hasLedger = await prisma.containerPushBatch.findFirst({
        where: { containerId: container.id, companyId: auth.companyId },
        select: { id: true },
      });
      if (!hasLedger) {
        fail(res, 400, "VALIDATION_ERROR",
          "整柜的「已封柜」是建柜时就定下的，不能在这里撤销；柜子建错了请在「整柜管理」里处理");
        return;
      }
    }

    // 「派送中 / 已签收」归尾端派送推，装柜页不能撤（生产上有柜子停在「已签收」，见 LASTMILE_ONLY_CONTAINER_STATUSES）
    if (LASTMILE_ONLY_CONTAINER_STATUSES.has(container.currentStatus)) {
      fail(
        res,
        400,
        "VALIDATION_ERROR",
        `「${CONTAINER_STATUS_LABEL[container.currentStatus] ?? container.currentStatus}」是尾端派送那边推的，不能在装柜页撤销。要退请到「尾端派送」里操作。`,
      );
      return;
    }

    let dates: Record<string, string> = {};
    try { dates = container.statusDates ? JSON.parse(container.statusDates) : {}; } catch { dates = {}; }

    // 2026-09-17：页面带上它看到的柜子状态，对不上就不撤（页面没刷新连点两次不会多撤一步）
    const expectStatus = typeof body.expectStatus === "string" ? body.expectStatus.trim() : "";
    if (expectStatus && expectStatus !== container.currentStatus) {
      fail(res, 409, "VALIDATION_ERROR", `这个柜子现在是「${CONTAINER_STATUS_LABEL[container.currentStatus] ?? container.currentStatus}」，跟你页面上看到的不一样，可能刚被别人改过。请刷新后再撤销`);
      return;
    }

    /**
     * 2026-09-17（推进账本）：有账本就按账本撤 —— 撤掉最近一笔：
     *   · 柜子回到这一笔记下的「推之前的状态」，时间表、开船/到港日期恢复成推之前的样子；
     *   · 这一笔里的货，**还在这个柜里、还停在这一步**的，回到各自记下的状态，只删这些货这一步的轨迹；
     *   · 已经不在柜里、或已经走到别的状态的货不动，它们的轨迹也不删（那是真实发生过的事）。
     * 不再看日期、不再看轨迹记录，所以同一天推几步、日期填倒了、员工删过记录，都不会退错。
     */
    const latestBatch = await prisma.containerPushBatch.findFirst({
      where: { containerId: container.id, companyId: auth.companyId },
      orderBy: { seq: "desc" },
    });
    if (latestBatch) {
      const batchResult = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM containers WHERE id = ${container.id} FOR UPDATE`;
        const fresh = await tx.container.findUnique({ where: { id: container.id }, select: { currentStatus: true, transportMode: true } });
        const freshBatch = await tx.containerPushBatch.findFirst({
          where: { containerId: container.id, companyId: auth.companyId },
          orderBy: { seq: "desc" },
          include: { entries: true },
        });
        if (!fresh || !freshBatch || freshBatch.id !== latestBatch.id || fresh.currentStatus !== container.currentStatus) {
          throw new BusinessError("这个柜刚刚被别人改过，撤销没有执行，请刷新后再看");
        }
        if (freshBatch.toContainerStatus !== fresh.currentStatus) {
          throw new BusinessError("柜子现在的状态跟推进账本对不上，没有撤销，请联系技术处理", 409, "VALIDATION_ERROR");
        }
        const items = await tx.shipmentContainerItem.findMany({ where: { containerId: container.id }, select: { shipmentId: true } });
        const inBox = new Set(items.map((it: { shipmentId: string }) => it.shipmentId));
        const entryShipmentIds = [...new Set(freshBatch.entries.map((e) => e.shipmentId))];
        const candidateIds = entryShipmentIds.filter((sid) => inBox.has(sid));
        // 空数组时函数内部直接返回；不写成「同一行 if + 锁」，那种写法 test-lock-order 第 7 项不认
        await lockShipmentsChildrenFirst(tx, candidateIds, auth.companyId);
        const ships = candidateIds.length > 0
          ? await tx.shipment.findMany({
              where: { id: { in: candidateIds }, companyId: auth.companyId },
              select: { id: true, trackingNo: true, currentStatus: true, parentTrackingNo: true },
            })
          : [];
        const trackingNoOf = new Map(
          (await tx.shipment.findMany({ where: { id: { in: entryShipmentIds }, companyId: auth.companyId }, select: { id: true, trackingNo: true } }))
            .map((s: { id: string; trackingNo: string }) => [s.id, s.trackingNo]),
        );
        const { reverted, skipped } = classifyLedgerUndo(
          freshBatch.entries,
          inBox,
          new Map(ships.map((s: LedgerShip) => [s.id, s])),
          trackingNoOf,
        );
        const crossLedger = crossFlowUndoMessage(
          { transportMode: fresh.transportMode, currentStatus: fresh.currentStatus },
          freshBatch.fromContainerStatus,
          reverted.map((r) => ({ trackingNo: r.trackingNo, back: r.from })),
        );
        if (crossLedger) throw new BusinessError(crossLedger, 409, "VALIDATION_ERROR");
        const idsByStatus = new Map<string, string[]>();
        for (const r of reverted) {
          if (r.from === r.current) continue;
          const list = idsByStatus.get(r.from) ?? [];
          list.push(r.id);
          idsByStatus.set(r.from, list);
        }
        let changed = 0;
        for (const [status, ids] of idsByStatus) {
          await tx.shipment.updateMany({ where: { id: { in: ids }, companyId: auth.companyId }, data: { currentStatus: status, updatedAt: new Date() } });
          changed += ids.length;
        }
        const logIds = reverted.map((r) => r.logId).filter((v): v is string => !!v);
        const deletedSnap = logIds.length > 0 ? await tx.statusLog.findMany({ where: { id: { in: logIds } } }) : [];
        const del = logIds.length > 0
          ? await tx.statusLog.deleteMany({ where: { id: { in: logIds }, companyId: auth.companyId } })
          : { count: 0 };
        const autoRestored = await autoRestoreDeletedLogs(tx, auth.companyId, { userId: auth.userId, role: auth.role },
          reverted.map((r) => ({ id: r.id, trackingNo: r.trackingNo, status: r.from })), container.containerNo);
        await tx.auditLog.create({
          data: {
            companyId: auth.companyId, actorId: auth.userId, actorRole: auth.role,
            action: "UNDO", resourceType: "Container", resourceId: container.id,
            // undoneLogIds：这一步撤掉的全部记录 id（含员工之前删掉、已经不在的），管理员恢复删过的记录时靠它挡住（restore-log）
            beforeJson: JSON.stringify({ batch: { ...freshBatch, entries: undefined }, entries: freshBatch.entries, deletedLogs: deletedSnap, undoneLogIds: logIds }),
            remark: `撤销柜子 ${container.containerNo} 的「${CONTAINER_STATUS_LABEL[container.currentStatus] ?? container.currentStatus}」`,
          },
        });
        await tx.container.update({
          where: { id: container.id },
          data: {
            currentStatus: freshBatch.fromContainerStatus,
            statusDates: freshBatch.prevStatusDates,
            departureDate: freshBatch.prevDepartureDate,
            ata: freshBatch.prevAta,
            updatedAt: new Date(),
          },
        });
        await tx.containerPushBatch.delete({ where: { id: freshBatch.id } });
        // 柜里这批货的父单都按子单重算一遍（跟老柜子那条路一样）：不只退回的，也包括单独往前走了的 ——
        // 父单是存库的，别处改子单漏了同步时，撤销顺手对齐，不会比原来差
        const parentNos = [...new Set(ships.map((s: LedgerShip) => s.parentTrackingNo).filter((v): v is string => !!v))];
        await lockAndSyncParents(tx, parentNos, auth.companyId, syncParentStatusFromChildren);
        return { prevStatus: freshBatch.fromContainerStatus, deletedLogs: del.count, changed, skipped, restoredLogs: autoRestored };
      });
      logger.warn("撤销柜子状态推进（账本）", {
        操作人: auth.userId, 角色: auth.role, 柜号: container.containerNo,
        撤掉的状态: container.currentStatus, 退回到: batchResult.prevStatus,
        删掉轨迹条数: batchResult.deletedLogs, 退回运单数: batchResult.changed, 没跟着退: batchResult.skipped.length,
      });
      ok(res, {
        id: container.id,
        containerNo: container.containerNo,
        undoneStatus: container.currentStatus,
        currentStatus: batchResult.prevStatus,
        deletedLogs: batchResult.deletedLogs,
        affectedShipmentCount: batchResult.changed,
        skippedShipments: batchResult.skipped,
        restoredLogs: batchResult.restoredLogs,
      });
      return;
    }

    const { shipmentIds, shipmentStatusOfThisPush, prevStatus, changedAt } = await legacyUndoPlan(container, dates, auth.companyId);
    if (!prevStatus) {
      fail(
        res,
        400,
        "VALIDATION_ERROR",
        `「${CONTAINER_STATUS_LABEL[container.currentStatus] ?? container.currentStatus}」已经是这个柜子流程里的第一步，没有上一步可以退。`,
      );
      return;
    }

    // 找不到推进时间时（老柜子、且运单那边也没留下轨迹）：这次推进没在运单上留下任何痕迹，
    // 所以只退柜子状态，不去删轨迹、不动运单 —— 见下面 changedAt 为 null 的分支。

    const result = await prisma.$transaction(async (tx) => {
      /**
       * ⚠️ 锁住再复查一遍状态（2026-08-27 补）。
       * 上面「上一步是哪个状态、要删哪批轨迹」全是按事务外面读到的那个 currentStatus 算的。
       * 两个人同时点「撤销」，两边都从同一个状态往回退，就会连退两格并删掉两批轨迹；
       * 一个人撤销、一个人推进撞上，删的还可能是别人刚写的那批。
       */
      await tx.$queryRaw`SELECT id FROM containers WHERE id = ${container.id} FOR UPDATE`;
      const freshContainer = await tx.container.findUnique({
        where: { id: container.id },
        select: { currentStatus: true, transportMode: true },
      });
      if (freshContainer == null) throw new BusinessError("柜子不存在", 404, "NOT_FOUND");
      const nowStatus = freshContainer.currentStatus;
      if (nowStatus !== container.currentStatus) {
        throw new BusinessError(
          `这个柜刚刚被别人改成了「${CONTAINER_STATUS_LABEL[nowStatus] ?? nowStatus}」，撤销没有执行，请刷新后再看`,
        );
      }
      /**
       * ⚠️ 运输方式也要锁后复查（2026-08-31 补，跟「推进」那条对称）。
       * 上面「退到哪一格」是按事务外读到的运输方式算的：flowOf 按它选流程、
       * neverGuessOf 按它取「不许猜」名单。撤销和改运输方式撞车时，
       * prevStatus 可能是按旧运输方式的名单算出来的。
       * 影响比推进那边小（撤销本来就会两条流程都找、statusDates 命中时不看运输方式），
       * 但同一类口子按 CLAUDE.md 第 29 条要一起堵上。
       */
      if (freshContainer.transportMode !== container.transportMode) {
        throw new BusinessError(
          "这个柜刚刚被别人改了运输方式，撤销没有执行，请刷新后再试",
        );
      }

      {
        const crossBox = crossFlowUndoMessage({ transportMode: freshContainer.transportMode, currentStatus: nowStatus }, prevStatus, []);
        if (crossBox) throw new BusinessError(crossBox, 409, "VALIDATION_ERROR");
      }
      let deletedLogs = 0;
      let affectedShipments = 0;
      const undoneLogIds: string[] = [];

      if (changedAt && shipmentStatusOfThisPush && shipmentIds.length > 0) {
        /**
         * ⚠️⚠️ **先按 id 排序把这批运单全锁住，再动它们**（2026-08-29 补）。
         *
         * 原来这里一把运单锁都没有，直接 deleteMany 轨迹 + updateMany 运单 ——
         * updateMany 的行锁是 Postgres **按扫描顺序**取的，方向不固定，
         * 而「推进柜子状态」那条路是 `[...ids].sort()` 逐个锁的（本文件 ~429 行）。
         * 一边有序、一边随机，两个柜共用同一批运单（分柜后很常见）时会反向等待。
         *
         * 排序之外还有一个理由：下面「读这次推进记录里的来路和运单现在的状态、再改状态」是**先读后写**，
         * 不锁的话，读完到写之间别人插一条轨迹，这里就会拿旧的算、把新的盖掉。
         */
        // 走共用函数，理由同上（推进那条）
        await lockShipmentsChildrenFirst(tx, shipmentIds, auth.companyId);
        /**
         * ⚠️⚠️ 每张运单退回「这次推进之前的状态」= 这次推进写的那条轨迹里的 fromStatus（2026-09-17 改）。
         *
         * 原来是删完轨迹后「按剩下的最后一条（按显示时间）重算」。但记录时间很多是补的：
         * 9-15 那种「卸柜后重新装柜、再按过去的日期补推状态」的柜子，「装入柜子」那条是真实时间，
         * 比补推的「已到港 9-13」「清关中 9-14」都晚 —— 撤一步「清关中」，柜子退到已到港，
         * 运单却被算成「已装柜」（测试库按 9-15 操作实测复现）。推进时写的那条轨迹本来就记着
         * 推进前的状态（fromStatus，锁后读的），直接用它，不用去猜哪条是「最后一条」。
         *
         * ⚠️ 只退**现在还停在这次推进状态**的运单（锁内重读，CLAUDE.md 第 28 条）：
         *   · 推进之后单独往前走了的（比如尾端派送、签收）不跟着退，原来按「最后一条」算也是不退；
         *   · 没有这次推进记录的（后来才装进柜的，状态是装柜时按柜子补的）不动，跟原来一样。
         * 同一票有多条匹配（同一天同一状态推过两次）取最早写的那条 —— 那才是第一次推进之前的状态。
         */
        const pushLogWhere = {
          companyId: auth.companyId,
          shipmentId: { in: shipmentIds },
          changedAt,
          toStatus: shipmentStatusOfThisPush,
          // 同上：只删柜子推进自己写的那条，别人写的一条都不碰
          id: { startsWith: PUSH_LOG_PREFIX },
        };
        const pushLogs = await tx.statusLog.findMany({
          where: pushLogWhere,
          orderBy: { id: "asc" },
          select: { id: true, shipmentId: true, fromStatus: true },
        });
        const del = await tx.statusLog.deleteMany({ where: pushLogWhere });
        deletedLogs = del.count;
        undoneLogIds.push(...pushLogs.map((l) => l.id));
        // 员工之前删掉的、本来也是这次推进写的记录（比如重复的「已封柜」）也算撤掉了，记进撤销日志（跟账本那条路一样）
        {
          const idSet = new Set(shipmentIds);
          const deletedAudits = (await findDeletedLogAudits(tx, auth.companyId, shipmentIds))
            .filter((a) => a.resourceId.startsWith(PUSH_LOG_PREFIX));
          for (const a of deletedAudits) {
            let b: any;
            try { b = JSON.parse(a.beforeJson ?? "{}"); } catch { continue; }
            if (idSet.has(b.shipmentId) && String(b.id ?? "").startsWith(PUSH_LOG_PREFIX) && b.toStatus === shipmentStatusOfThisPush && new Date(b.changedAt).getTime() === changedAt.getTime()) {
              undoneLogIds.push(String(b.id));
            }
          }
        }

        const beforeThisPush = new Map<string, string>();
        for (const row of pushLogs) {
          if (!beforeThisPush.has(row.shipmentId)) beforeThisPush.set(row.shipmentId, row.fromStatus);
        }
        const lockedShipments = await tx.shipment.findMany({
          where: { id: { in: [...beforeThisPush.keys()] }, companyId: auth.companyId },
          select: { id: true, trackingNo: true, currentStatus: true },
        });
        const legacyReverted: Array<{ id: string; trackingNo: string; status: string }> = [];

        // 按状态分组批量更新，避免几十张运单发几十条 update
        const idsByStatus = new Map<string, string[]>();
        for (const s of lockedShipments) {
          if (s.currentStatus !== shipmentStatusOfThisPush) continue;
          const back = beforeThisPush.get(s.id)!;
          legacyReverted.push({ id: s.id, trackingNo: s.trackingNo, status: back });
          if (back === s.currentStatus) continue; // 推之前就是这个状态（比如已装柜→已封柜），不算退回
          const list = idsByStatus.get(back) ?? [];
          list.push(s.id);
          idsByStatus.set(back, list);
        }
        // 还没改任何货：对不上就整个撤销回滚（上面删掉的推进记录也跟着回来）
        const crossShips = crossFlowUndoMessage(
          { transportMode: freshContainer.transportMode, currentStatus: nowStatus },
          null,
          legacyReverted.map((r) => ({ trackingNo: r.trackingNo, back: r.status })),
        );
        if (crossShips) throw new BusinessError(crossShips, 409, "VALIDATION_ERROR");
        for (const [status, ids] of idsByStatus) {
          await tx.shipment.updateMany({
            where: { id: { in: ids }, companyId: auth.companyId },
            data: { currentStatus: status, updatedAt: new Date() },
          });
          affectedShipments += ids.length;
        }
        await autoRestoreDeletedLogs(tx, auth.companyId, { userId: auth.userId, role: auth.role }, legacyReverted, container.containerNo);

        // 父运单当初是跟着一起改的，这里也要跟着退（2026-08-22 改成统一推算）
        //
        // ⚠️ 原来是拿一个 Map<父单号, 状态> 收集，同一个父单下有多个子单时，
        //    **循环里后一个子单会覆盖前一个**，最后把「最后那个子单的状态」写给父单 ——
        //    典型的「最后写入者赢」，父单可能被退到一个跟实际不符的状态。
        //    现在只收集父单号，逐个按**全部子单**重算。
        const kids = await tx.shipment.findMany({
          where: { id: { in: shipmentIds }, companyId: auth.companyId },
          select: { id: true, parentTrackingNo: true },
        });
        /**
         * ⚠️ **必须排序**（2026-08-29 补）—— 「推进柜子状态」那条路是
         * `[...parentNosToSync].sort()`（本文件 ~490 行），这里原来没排。
         * 两个柜子同时撤销、且涉及同一批父单时，一边 A→B、一边 B→A，
         * 反向等待就是死锁。同一个规矩两处写法必须一样。
         */
        const parentNos = [...new Set(kids.map((k) => k.parentTrackingNo).filter((v): v is string => !!v))];
        /**
         * ⚠️ 先按 **id** 把这批父单一次性锁完，再逐个同步（2026-08-29 补）。
         * 不能直接 `for (const no of [...nos].sort())` —— 那是按**运单号**排，
         * 而 lockShipmentsChildrenFirst 的父单层按 **id** 排，两把钥匙不一样，
         * 同一对父单从不同路径进来会锁反。测试库里 id 顺序和运单号顺序
         * 相反的父单对有 41 对。
         * 下面循环里 syncParentStatusFromChildren 内部还会再锁一次，
         * 同一事务重锁是免费的，不用去删。
         */
        await lockAndSyncParents(tx, parentNos, auth.companyId, syncParentStatusFromChildren);
      }

      delete dates[container.currentStatus];
      const containerUpdate: Prisma.ContainerUpdateInput = {
        currentStatus: prevStatus!,
        statusDates: JSON.stringify(dates),
        updatedAt: new Date(),
      };
      // 开船/到港日期如果就是这次推进写进去的，一并撤掉
      // （changedAt 为 null 表示找不到这次推进的时间，那就不敢认这个日期是它写的，不动）
      if (changedAt && container.currentStatus === "IN_TRANSIT" && container.departureDate
          && container.departureDate.getTime() === changedAt.getTime()) {
        containerUpdate.departureDate = null;
      }
      if (changedAt && container.currentStatus === "ARRIVED" && container.ata
          && container.ata.getTime() === changedAt.getTime()) {
        containerUpdate.ata = null;
      }
      await tx.container.update({ where: { id: container.id }, data: containerUpdate });
      await tx.auditLog.create({
        data: {
          companyId: auth.companyId, actorId: auth.userId, actorRole: auth.role,
          action: "UNDO", resourceType: "Container", resourceId: container.id,
          beforeJson: JSON.stringify({ legacy: true, from: container.currentStatus, to: prevStatus, deletedLogs, undoneLogIds }),
          remark: `撤销柜子 ${container.containerNo} 的「${CONTAINER_STATUS_LABEL[container.currentStatus] ?? container.currentStatus}」（没有推进账本的老柜子）`,
        },
      });

      return { deletedLogs, affectedShipments };
    });

    logger.warn("撤销柜子状态推进", {
      操作人: auth.userId,
      角色: auth.role,
      柜号: container.containerNo,
      撤掉的状态: container.currentStatus,
      退回到: prevStatus,
      删掉轨迹条数: result.deletedLogs,
      涉及运单数: result.affectedShipments,
    });

    ok(res, {
      id: container.id,
      containerNo: container.containerNo,
      undoneStatus: container.currentStatus,
      currentStatus: prevStatus,
      deletedLogs: result.deletedLogs,
      affectedShipmentCount: result.affectedShipments,
    });
  });

  /**
   * ⚠️ 这里原来还有两条管理员装柜/卸柜接口（POST / DELETE /admin/containers/load），
   * 2026-08-31 删掉了。它们是装柜页改走 /staff/loading-manifests 之前留下的老路，
   * 前端早就没有任何地方调它们（grep 全仓库确认过）：
   *   · 装的那条不认父子单关系 —— 正规流程禁止把子单再装柜，它不管；
   *   · 卸的那条直接把装柜记录一删了事：不把件数/方数/重量还给父单、
   *     不把子单退回原状态 —— 正是「删除柜子」2026-08-29 刚修过的那个
   *     「子单变孤儿、父单数字永远回不来」的病，这里还留着一个没修的入口。
   * 按 CLAUDE.md 第 35 条「给旧代码打补丁前，先问它该不该活着」：该下线的直接下线。
   * 以后要卸柜，走 shipments/unload-item.ts 那份统一实现（unloadItemFully 一家）。
   */

  // ============ 管理员删除柜子 ============
  app.delete("/admin/containers", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const id = req.query.id?.trim();
    if (!id) {
      fail(res, 400, "BAD_REQUEST", "id is required");
      return;
    }

    const container = await prisma.container.findFirst({
      where: { id, companyId: auth.companyId },
      select: { id: true, currentStatus: true, isFcl: true },
    });
    if (!container) {
      fail(res, 404, "NOT_FOUND", "container not found");
      return;
    }
    /* 整柜不许从这里删（2026-09-23 第 2 轮复核抓到）：删柜会把柜内的货全卸下来，
       整柜那张单被写成「已入库」+ 一条「退回国内仓」的假轨迹；柜内记录一删，
       这张单就不再算整柜，转头冒进客户「我的运单」和预报单里，
       跟老板「整柜的货不走仓库收货流程」正面冲突。 */
    if (container.isFcl) {
      fail(res, 400, "VALIDATION_ERROR", FCL_BLOCKED_MESSAGE);
      return;
    }
    if (container.currentStatus !== "LOADING") {
      fail(res, 400, "VALIDATION_ERROR", "只能删除装柜中状态的柜子");
      return;
    }

    await prisma.$transaction(async (tx) => {
      /**
       * ⚠️ 锁住再复查一遍状态（2026-08-27 补）。上面那道「只能删装柜中的柜」在事务外面：
       * 另一个人正好在这一刻把柜封了/发运了，这边照样把整个柜连同装柜记录删掉 ——
       * 已经在路上的柜凭空消失，运单也从柜里掉出来了。
       */
      await tx.$queryRaw`SELECT id FROM containers WHERE id = ${id} FOR UPDATE`;
      const nowStatus = (
        await tx.container.findUnique({ where: { id }, select: { currentStatus: true } })
      )?.currentStatus;
      if (nowStatus == null) throw new BusinessError("柜子不存在", 404, "NOT_FOUND");
      if (nowStatus !== "LOADING") {
        throw new BusinessError(
          `这个柜刚刚被推到了「${CONTAINER_STATUS_LABEL[nowStatus] ?? nowStatus}」，已经不能删了，请刷新后再看`,
        );
      }

      /**
       * ⚠️⚠️ **删柜子之前必须把柜里的货一条条卸下来**（2026-08-29 补）。
       *
       * 原来这里只是 `deleteMany` 柜内记录 —— **子单原样留着**：
       *   · 子单变成孤儿：状态还写着「已装柜」，却不属于任何柜子
       *   · 父单被扣走的件数/方数/重量**永远回不来**（父单永远 0 件 0 方 0 公斤）
       * 而「建错柜子删掉重来」是员工很日常的动作，删除按钮就在卸柜按钮旁边，
       * 确认框还只说「此操作不可恢复」，根本没提会把货的数字弄没。
       *
       * 现在走跟「卸柜」同一份实现（shipments/unload-item.ts），
       * 一份代码两处调用 —— 这个项目里「N 个入口只修了 M 个」已经犯过五六次。
       */
      await unloadAllItemsOfContainer(tx, id, auth.companyId, { userId: auth.userId, role: auth.role, name: auth.name });
      await tx.container.delete({ where: { id } });
    });

    ok(res, { deleted: true, id });
  });

  // ============ 客户追踪：根据运单 ID 查看完整的"出柜"信息 ============
  // 返回：运单基础信息 + 所属的所有柜子 + 状态时间线
  app.get("/client/shipments/track", async (req, res) => {
    const auth = requireRole(req, res, ["client", "staff", "admin"]);
    if (!auth) return;

    const shipmentId = req.query.shipmentId?.trim();
    const trackingNo = req.query.trackingNo?.trim();
    if (!shipmentId && !trackingNo) {
      fail(res, 400, "BAD_REQUEST", "shipmentId or trackingNo is required");
      return;
    }

    const shipment = await prisma.shipment.findFirst({
      where: shipmentId
        ? { id: shipmentId, companyId: auth.companyId }
        : { trackingNo, companyId: auth.companyId },
      include: {
        order: {
          select: {
            id: true,
            orderNo: true,
            itemName: true,
            clientId: true,
            receiverNameTh: true,
            receiverAddressTh: true,
            cargoType: true,
            transportMode: true,
            products: {
              select: { itemName: true, packageCount: true },
              orderBy: { sortOrder: "asc" },
            },
          },
        },
        containerItems: {
          include: {
            container: true,
          },
        },
        statusLogs: {
          orderBy: { changedAt: "asc" },
        },
      },
    });

    if (!shipment) {
      fail(res, 404, "NOT_FOUND", "shipment not found");
      return;
    }

    // 客户角色：只能看自己的货
    if (auth.role === "client" && shipment.order?.clientId !== auth.userId) {
      fail(res, 403, "FORBIDDEN", "this shipment does not belong to you");
      return;
    }

    const totalVolume = shipment.volumeM3 ? decToNumber(shipment.volumeM3) : 0;
    const totalLoaded = shipment.containerItems.reduce(
      (sum, it) => sum + decToNumber(it.loadedVolumeM3),
      0,
    );
    const isSplit = shipment.containerItems.length > 1;

    const lastmileOrder = await prisma.adminLastmileOrder.findFirst({
      where: { shipmentId: shipment.id },
      orderBy: { updatedAt: "desc" },
    });

    const childShipments = shipment.parentTrackingNo
      ? []
      : await prisma.shipment.findMany({
          where: { parentTrackingNo: shipment.trackingNo, companyId: auth.companyId },
          include: {
            statusLogs: { orderBy: { changedAt: "asc" } },
          },
          orderBy: { trackingNo: "asc" },
        });

    const isClient = auth.role === "client";

    /**
     * 装柜时写的日志内容是「装入柜子 <柜号>（分装 N件）」，柜号就藏在正文里。
     * 客户端本来就不允许看柜号（containers、batchNo 都对客户屏蔽过），
     * 所以这里要把正文里的柜号一并抹掉，只保留「已装柜」和分装件数。
     *
     * 2026-08-11：抽到 core/client-privacy.ts，免登录查轨迹那边共用同一份，
     * 别再各写各的（CLAUDE.md 第 20 条）。
     */
    const sanitizeRemark = (remark: string): string =>
      sanitizeRemarkForClient(remark, isClient);

    type TrackLog = { id: string; fromStatus: string; toStatus: string; remark: string | null; nextStop?: string | null; changedAt: Date; operatorId: string; operatorRole: string; operatorName: string | null };
    /**
     * 显示当前状态的最后一条不给删（2026-09-17 老板拍板，删除只删记录不改状态）。
     * 按每票货自己的当前状态、自己的记录算 —— 父单页签里混着子单的记录，子单那条看子单的状态。
     * 跟删除接口共用 deleteBlockedReasonOf（managed-lastmile-log.ts），两边口径必须一样。
     */
    const sameStatusCountOf = (logs: TrackLog[], currentStatus: string): number =>
      logs.filter((l) => l.toStatus === currentStatus).length;
    const mapLog = (
      log: TrackLog,
      trackingNo: string,
      owner: { currentStatus: string; sameStatusCount: number },
    ) => {
      // 派送业务的记录本来就不给删，而且推错了要去尾端派送撤，不能提示去装柜管理 —— 不标
      const managed = isManagedLastmileLog(log);
      const isCurrentStatus = !managed && isCurrentStatusLog(log, owner.currentStatus, owner.sameStatusCount);
      // 为什么不能删（2026-09-17）：lastmile 派送记录 / containerPush 柜子推进改了状态的记录 / currentStatus 当前状态最后一条
      const deleteBlockedReason = deleteBlockedReasonOf(log, owner.currentStatus, owner.sameStatusCount);
      return hideOperatorIdentity({
        trackingNo,
        // 员工/管理员删「写错的一条」时要靠它定位；跟操作人一样，客户端不下发
        id: isClient ? "" : log.id,
        canDelete: !isClient && deleteBlockedReason === null,
        // 员工/管理员的弹窗在不能删的那条上写原因（当前状态 / 柜子推进记录 / 派送记录）；客户不下发
        ...(isClient ? {} : { isCurrentStatus, deleteBlockedReason }),
        fromStatus: log.fromStatus,
        toStatus: log.toStatus,
        remark: sanitizeRemark(log.remark ?? ""),
        // 「下一站【泰国边境】」，客户看得到货接下来去哪；老轨迹没有这个字段就不显示
        nextStop: log.nextStop ?? "",
        changedAt: log.changedAt.toISOString(),
        /**
         * 操作人是内部信息：只有超级管理员拿得到（2026-09-15 老板拍板，员工也不行）。
         * 原来只对客户清空，员工照样拿到名字、轨迹弹窗也显示。
         * 现在非管理员连这两个字段都不下发（hideOperatorIdentity 整个删掉，不是清成空串）。
         * ⚠️ 上面的 id / canDelete / isCurrentStatus 不是操作人身份，员工删「写错的一条」要靠它，别一起摘。
         */
        operatorRole: log.operatorRole,
        // 客户自己操作的那步（下预报单）显示唛头，不显示客户名字（2026-09-19）
        operatorName: operatorNameForDisplay(log),
      }, auth.role);
    };
    const ownerOf = (s: { currentStatus: string; statusLogs: TrackLog[] }) => ({
      currentStatus: s.currentStatus,
      sameStatusCount: sameStatusCountOf(s.statusLogs, s.currentStatus),
    });
    const parentOwner = ownerOf(shipment);

    // 父运单的轨迹 = 自己的记录 + 所有子运单的记录，按时间升序合并。
    // 拆柜后的操作只会记在子单上（同步父单状态时并不写日志），不合并的话
    // 父单标签会出现「当前状态：已签收 / 暂无物流轨迹」这种自相矛盾的显示。
    // 每条都带上来源单号，前端据此标注是哪一件货。
    const mergedTimeline = [
      ...shipment.statusLogs.map((log) => mapLog(log, shipment.trackingNo, parentOwner)),
      ...childShipments.flatMap((cs) => {
        const owner = ownerOf(cs);
        return cs.statusLogs.map((log) => mapLog(log, cs.trackingNo, owner));
      }),
    ].sort((a, b) => a.changedAt.localeCompare(b.changedAt));

    ok(res, {
      /** 前端据此决定要不要显示操作人等内部信息 */
      viewerRole: auth.role,
      trackingNo: shipment.trackingNo,
      orderId: shipment.order?.id ?? null,
      orderNo: shipment.order?.orderNo ?? null,
      itemName: shipment.order?.itemName ?? null,
      products: shipment.order?.products?.map(p => ({ itemName: p.itemName, packageCount: p.packageCount })) ?? [],
      cargoType: shipment.order?.cargoType ?? null,
      currentStatus: shipment.currentStatus,
      // 子单进度不一样时，弹窗头部也补一句「（部分已放行）」——跟三端列表同一份算法（2026-09-16）
      partialAhead: partialAheadStatus(
        shipment.currentStatus,
        childShipments.map((cs) => cs.currentStatus),
        shipment.packageCount,
        // 老数据运单自己没填运输方式时按订单的（跟四个列表同口径，Codex 第二批复核 P2-1）
        shipment.transportMode ?? shipment.order?.transportMode,
      ) ?? undefined,
      currentLocation: shipment.currentLocation ?? undefined,
      receiverNameTh: shipment.order?.receiverNameTh ?? null,
      receiverAddressTh: shipment.order?.receiverAddressTh ?? null,
      totalVolumeM3: totalVolume,
      totalLoadedM3: Number(totalLoaded.toFixed(3)),
      isSplit,
      splitCount: shipment.containerItems.length,
      // 所属的所有柜子（拆柜情况下会有多个）— 客户端隐藏
      containers: auth.role === "client"
        ? shipment.containerItems.map((it) => ({
            loadingDate: it.container.loadingDate?.toISOString() ?? null,
            departureDate: it.container.departureDate?.toISOString() ?? null,
            ata: it.container.ata?.toISOString() ?? null,
            customsClearedAt: it.container.customsClearedAt?.toISOString() ?? null,
            containerStatus: it.container.currentStatus,
          }))
        : shipment.containerItems
        .sort((a, b) => a.container.createdAt.getTime() - b.container.createdAt.getTime())
        .map((it) => ({
          containerId: it.containerId,
          containerNo: it.container.containerNo,
          containerType: it.container.containerType,
          carrierName: it.container.carrierName ?? null,
          loadedVolumeM3: decToNumber(it.loadedVolumeM3),
          loadedPieceCount: it.loadedPieceCount,
          containerStatus: it.container.currentStatus,
          containerStatusLabel:
            CONTAINER_STATUS_LABEL[it.container.currentStatus] ?? it.container.currentStatus,
          loadingDate: it.container.loadingDate?.toISOString() ?? null,
          departureDate: it.container.departureDate?.toISOString() ?? null,
          eta: it.container.eta?.toISOString() ?? null,
          ata: it.container.ata?.toISOString() ?? null,
          customsClearedAt: it.container.customsClearedAt?.toISOString() ?? null,
        })),
      // 状态时间线（父单为合并后的完整链路，子单为自身记录）
      timeline: mergedTimeline,
      // 子单信息（分柜后运单才有）
      // 子单信息
      children: childShipments.length > 0
        ? childShipments.map((cs) => ({
            trackingNo: cs.trackingNo,
            batchNo: auth.role === "client" ? null : cs.batchNo,
            // 子单和父单是同一张订单的货，品名把订单全部产品名带上（2026-09-10 Codex 复核 P1：
            // 子单自己的 itemName 要么只有第一个产品名、要么是空的，轨迹弹窗子单页签会显示「鞋」或「—」）
            itemName: productNamesLabel(shipment.order?.products, cs.itemName) || null,
            packageCount: cs.packageCount,
            currentStatus: cs.currentStatus,
            timeline: (() => {
              const owner = ownerOf(cs);
              return cs.statusLogs.map((log) => mapLog(log, cs.trackingNo, owner));
            })(),
          }))
        : undefined,
      createdAt: shipment.createdAt.toISOString(),
      updatedAt: shipment.updatedAt.toISOString(),
      lastmile: lastmileOrder ? {
        carrierName: lastmileOrder.carrierName,
        driverName: lastmileOrder.driverName,
        licensePlate: lastmileOrder.licensePlate,
        phoneNumber: lastmileOrder.phoneNumber,
        signImageBase64: lastmileOrder.signImageBase64 ? `data:image/jpeg;base64,${lastmileOrder.signImageBase64}` : null,
        status: lastmileOrder.status,
      } : null,
    });
  });
}
