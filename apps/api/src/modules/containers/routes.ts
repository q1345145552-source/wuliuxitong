import { isManagedLastmileLog } from "../shipments/managed-lastmile-log";
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
import { syncParentStatusFromChildren } from "../shipments/parent-status";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { sanitizeRemarkForClient } from "../core/client-privacy";
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

    if (shipmentNextStatus && shipmentIds.length > 0) {
      // 早点给个好看的提示：真正说了算的那次判断在事务里（见下面 badNow）
      const shipments = await prisma.shipment.findMany({
        where: { id: { in: shipmentIds }, companyId: auth.companyId },
        select: { id: true, currentStatus: true },
      });
      const invalidShipments = shipments.filter(
        (s) => !canTransitLoose(s.currentStatus, shipmentNextStatus!),
      );
      if (invalidShipments.length > 0) {
        const ids = invalidShipments.map((s) => `${s.id}(${s.currentStatus})`).join(", ");
        fail(res, 400, "VALIDATION_ERROR", `以下运单不允许从当前状态流转到 ${shipmentNextStatus}：${ids}`);
        return;
      }
    }

    /**
     * 柜子 + 子单 + 轨迹 + 父单，**一个事务全做完**（2026-08-25 合并）。
     *
     * 之前是分两个事务：前一个批量写柜子/子单/轨迹，后一个重算父单。
     * 中间断掉就留下「柜子和子单推进了、父单没推」的半截数据。
     *
     * ⚠️ 超时给到 30 秒：一个柜子里可能装着几十票货，父单也可能有好几个，
     * 默认 5 秒在网络慢的时候不够。maxWait 是「等空闲连接」的时间，跟执行时长无关。
     */
    await prisma.$transaction(
      async (tx) => {
        /**
         * ⚠️ 锁住柜子再复查一遍当前状态（2026-08-27 补）。
         * 上面 canContainerTransit 那道检查是在事务外面做的：两个员工同时推进同一个柜，
         * 两边都是从同一个旧状态出发算「能不能推」，结果**两批轨迹都写进去了**，
         * 状态还可能跳过中间那一步 —— 客户轨迹里就会多出重复或错序的记录。
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
            `这个柜刚刚被别人推到了「${CONTAINER_STATUS_LABEL[nowStatus] ?? nowStatus}」，本次推进没有执行，请刷新后再看`,
          );
        }
        /**
         * ⚠️ 运输方式也要锁后复查（2026-08-31 补）。
         * 「属不属于这条流程」「能不能这样推」「下一站默认值」都是进门时按当时的
         * 运输方式算的。改运输方式那个接口（loading-manifests/transport-mode）在
         * 「已封柜」这类两条流程共有的状态上是放行的，它自己锁后重查了状态，
         * 推进这边原来没有对称的一道 —— 两人同一瞬间一个推「运输中」一个改成陆运，
         * 改方式先落地时，陆运柜会被推进海运才有的「运输中」，柜里运单全被写上
         * 「已开船」轨迹、下一站还是海运的「泰国港口」，海陆就串了。
         * 这里一拦，进门时算好的 flow / canContainerTransit / nextStop 就都还作数
         * （运输方式没变，按它算的结果就没过时），不用在锁里再算一遍。
         */
        if (freshContainer.transportMode !== container.transportMode) {
          throw new BusinessError(
            "这个柜刚刚被别人改了运输方式，本次推进没有执行，请刷新后再推",
          );
        }

        /**
         * ⚠️⚠️ **锁住之后，柜里装了什么必须重新查一遍**（2026-08-28 补）。
         *
         * 上面那份 `shipmentIds` 和各运单状态都是**事务外**读的。
         * 锁只保证「不同时」，不保证「数据没变」——
         * 从那次读到拿到锁之间，员工完全可以往这个柜里再装一票货。
         * 用旧清单推进的话，**新装进来的那票不会被推、也不会写轨迹**，
         * 而推进这条路已经走完不会回头补，那票货就永远停在旧状态。
         *
         * 复核实测报的就是这条。现在锁后重查装柜清单和运单状态，
         * 用重查的结果决定推谁、写哪些轨迹。
         */
        const freshItems = await tx.shipmentContainerItem.findMany({
          where: { containerId: container.id },
          select: { shipmentId: true },
        });
        const freshShipmentIds = [...new Set(freshItems.map((it: { shipmentId: string }) => it.shipmentId))];

        await tx.container.update({ where: { id: container.id }, data: updateData });

        if (shipmentNextStatus && freshShipmentIds.length > 0) {
          /**
           * ⚠️ 运单也要锁（2026-08-29 补）。
           * 上一版只锁了柜子，运单是普通 findMany 读出来的 ——
           * 别的路径（装柜同步状态、卸柜、泰国签收）可以在读完之后改掉运单状态，
           * 这边随后把它覆盖回去，那次改动连同它写的轨迹就对不上了。
           *
           * ⚠️ **按 id 排序再锁**：两个柜子同时推进、又正好涉及同几张运单时，
           * 加锁顺序相反会被 PostgreSQL 判定死锁掐掉一个。
           * 下面锁父单那里用的也是这个办法（按单号排序）。
           */
          // 走共用函数：柜子里可能同时装着父单和它的子单
          // （老的 /admin/containers/load 不检查父子关系，接口 2026-08-31 已删，
          //   但它以前装进去的数据还在），不能一锅端着排
          await lockShipmentsChildrenFirst(tx, freshShipmentIds, auth.companyId);
          const freshShipments = await tx.shipment.findMany({
            where: { id: { in: freshShipmentIds }, companyId: auth.companyId },
            select: { id: true, currentStatus: true, parentTrackingNo: true },
          });
          // 状态流转合法性也要用**锁后**的状态判断：事务外那次只是早点给个提示
          const badNow = freshShipments.filter(
            (sp: { currentStatus: string }) => !canTransitLoose(sp.currentStatus, shipmentNextStatus!),
          );
          if (badNow.length > 0) {
            const ids = badNow
              .map((sp: { id: string; currentStatus: string }) => `${sp.id}(${sp.currentStatus})`)
              .join(", ");
            throw new BusinessError(
              `以下运单刚刚变了状态，本次推进没有执行，请刷新后再看：${ids}`,
              400,
              "VALIDATION_ERROR",
            );
          }
          const freshStatusMap = new Map(
            freshShipments.map((sp: { id: string; currentStatus: string }) => [sp.id, sp.currentStatus]),
          );

          await tx.shipment.updateMany({
            where: { id: { in: freshShipmentIds }, companyId: auth.companyId },
            data: { currentStatus: shipmentNextStatus, updatedAt: now },
          });

          // 轨迹按**锁后**的清单和**锁后**的起始状态写；
          // id 前缀必须保持 sl_ctn_，撤销柜子状态靠它认出「哪些轨迹是柜子推进写的」（红线 2.10）
          const stamp = Date.now();
          await tx.statusLog.createMany({
            data: freshShipmentIds.map((sid: string, i: number) => ({
              id: `sl_ctn_${stamp}_${i}_${Math.random().toString(36).slice(2, 6)}`,
              companyId: auth.companyId,
              shipmentId: sid,
              operatorId: auth.userId,
              operatorRole: auth.role,
              operatorName: auth.name,
              fromStatus: freshStatusMap.get(sid) ?? "loaded",
              toStatus: shipmentNextStatus,
              remark: body.remark?.trim() || `${CONTAINER_STATUS_LABEL[toStatus] ?? toStatus}`,
              nextStop,
              changedAt: now,
            })),
          });

          parentNosToSync = [
            ...new Set(
              freshShipments
                .filter((sp: { parentTrackingNo: string | null }) => sp.parentTrackingNo)
                .map((sp: { parentTrackingNo: string | null }) => sp.parentTrackingNo!),
            ),
          ];
          affectedShipmentCount = freshShipmentIds.length;
        }

        // ⚠️ 排序后再逐个锁父单：两个柜子同时推进、又正好涉及同几张父单时，
        // 加锁顺序相反会被 PostgreSQL 判定死锁掐掉一个。固定顺序就不会打架。
        /**
         * ⚠️ 先按 **id** 把这批父单一次性锁完，再逐个同步（2026-08-29 补）。
         * 不能直接 `for (const no of [...nos].sort())` —— 那是按**运单号**排，
         * 而 lockShipmentsChildrenFirst 的父单层按 **id** 排，两把钥匙不一样，
         * 同一对父单从不同路径进来会锁反。测试库里 id 顺序和运单号顺序
         * 相反的父单对有 41 对。
         * 下面循环里 syncParentStatusFromChildren 内部还会再锁一次，
         * 同一事务重锁是免费的，不用去删。
         */
        await lockAndSyncParents(tx, parentNosToSync, auth.companyId, syncParentStatusFromChildren);
      },
      { timeout: 30000, maxWait: 10000 },
    );

    ok(res, {
      id: container.id,
      containerNo: container.containerNo,
      fromStatus: container.currentStatus,
      toStatus,
      // 回给前端的是**真的推了多少票**，不是事务外那份可能过时的清单条数
      affectedShipmentCount,
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

    /* ⚠️ 「派送中 / 已签收」不是装柜页推的，是尾端派送那边推的。
       在这里撤销会把客户已经签收的单子悄悄退回去，还会删掉尾端派送写的轨迹。
       2026-08-10 之前这两个状态因为没有时间表记录本来就撤不了，等于被 bug 挡着；
       现在按流程往回推能算出上一步了，必须显式挡住，否则是「修好一个、放出一个更大的」。
       生产上现在有 3 个柜子停在「已签收」。 */
    const LASTMILE_ONLY = new Set(["OUT_FOR_DELIVERY", "SIGNED", "DELIVERING"]);
    if (LASTMILE_ONLY.has(container.currentStatus)) {
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
    const PUSH_LOG_PREFIX = "sl_ctn_";

    // ① 这次推进发生的时间
    let currentTs: string | null = dates[container.currentStatus] ?? null;
    if (!currentTs && shipmentStatusOfThisPush && shipmentIds.length > 0) {
      const lastLog = await prisma.statusLog.findFirst({
        where: {
          companyId: auth.companyId,
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
    let prevStatus: string | null = null;
    if (currentTs) {
      const prevEntry = Object.entries(dates)
        .filter(([status, ts]) => status !== container.currentStatus && new Date(ts).getTime() <= new Date(currentTs!).getTime())
        .sort((a, b) => new Date(b[1]).getTime() - new Date(a[1]).getTime())[0];
      if (prevEntry) prevStatus = prevEntry[0];
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
    const changedAt: Date | null = currentTs ? new Date(currentTs) : null;

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

      let deletedLogs = 0;
      let affectedShipments = 0;

      if (changedAt && shipmentStatusOfThisPush && shipmentIds.length > 0) {
        /**
         * ⚠️⚠️ **先按 id 排序把这批运单全锁住，再动它们**（2026-08-29 补）。
         *
         * 原来这里一把运单锁都没有，直接 deleteMany 轨迹 + updateMany 运单 ——
         * updateMany 的行锁是 Postgres **按扫描顺序**取的，方向不固定，
         * 而「推进柜子状态」那条路是 `[...ids].sort()` 逐个锁的（本文件 ~429 行）。
         * 一边有序、一边随机，两个柜共用同一批运单（分柜后很常见）时会反向等待。
         *
         * 排序之外还有一个理由：下面「按剩下的最后一条轨迹重算状态」是**先读后写**，
         * 不锁的话，读完到写之间别人插一条轨迹，这里就会拿旧的算、把新的盖掉。
         */
        // 走共用函数，理由同上（推进那条）
        await lockShipmentsChildrenFirst(tx, shipmentIds, auth.companyId);
        const del = await tx.statusLog.deleteMany({
          where: {
            companyId: auth.companyId,
            shipmentId: { in: shipmentIds },
            changedAt,
            toStatus: shipmentStatusOfThisPush,
            // 同上：只删柜子推进自己写的那条，别人写的一律不碰
            id: { startsWith: PUSH_LOG_PREFIX },
          },
        });
        deletedLogs = del.count;

        // 每张运单按「剩下的最后一条轨迹」重算当前状态；一条不剩的保持不动
        const remaining = await tx.statusLog.findMany({
          where: { shipmentId: { in: shipmentIds } },
          orderBy: { changedAt: "asc" },
          select: { shipmentId: true, toStatus: true },
        });
        const latestByShipment = new Map<string, string>();
        for (const row of remaining) latestByShipment.set(row.shipmentId, row.toStatus);

        // 按状态分组批量更新，避免几十张运单发几十条 update
        const idsByStatus = new Map<string, string[]>();
        for (const [sid, status] of latestByShipment) {
          const list = idsByStatus.get(status) ?? [];
          list.push(sid);
          idsByStatus.set(status, list);
        }
        for (const [status, ids] of idsByStatus) {
          await tx.shipment.updateMany({
            where: { id: { in: ids }, companyId: auth.companyId },
            data: { currentStatus: status, updatedAt: new Date() },
          });
          affectedShipments += ids.length;
        }

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
        currentStatus: prevStatus,
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
      select: { id: true, currentStatus: true },
    });
    if (!container) {
      fail(res, 404, "NOT_FOUND", "container not found");
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
      await unloadAllItemsOfContainer(tx, id, auth.companyId);
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

    const mapLog = (
      log: { id: string; fromStatus: string; toStatus: string; remark: string | null; nextStop?: string | null; changedAt: Date; operatorRole: string; operatorName: string | null },
      trackingNo: string,
    ) => ({
      trackingNo,
      // 员工/管理员删「写错的一条」时要靠它定位；跟操作人一样，客户端不下发
      id: isClient ? "" : log.id,
      canDelete: !isClient && !isManagedLastmileLog(log),
      fromStatus: log.fromStatus,
      toStatus: log.toStatus,
      remark: sanitizeRemark(log.remark ?? ""),
      // 「下一站【泰国边境】」，客户看得到货接下来去哪；老轨迹没有这个字段就不显示
      nextStop: log.nextStop ?? "",
      changedAt: log.changedAt.toISOString(),
      // 操作人是内部信息，客户端连数据都不下发（不只是前端不显示）
      operatorRole: isClient ? "" : log.operatorRole,
      operatorName: isClient ? "" : (log.operatorName ?? ""),
    });

    // 父运单的轨迹 = 自己的记录 + 所有子运单的记录，按时间升序合并。
    // 拆柜后的操作只会记在子单上（同步父单状态时并不写日志），不合并的话
    // 父单标签会出现「当前状态：已签收 / 暂无物流轨迹」这种自相矛盾的显示。
    // 每条都带上来源单号，前端据此标注是哪一件货。
    const mergedTimeline = [
      ...shipment.statusLogs.map((log) => mapLog(log, shipment.trackingNo)),
      ...childShipments.flatMap((cs) => cs.statusLogs.map((log) => mapLog(log, cs.trackingNo))),
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
            timeline: cs.statusLogs.map((log) => mapLog(log, cs.trackingNo)),
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
