import { unloadItemFully } from "../shipments/unload-item";
import { prisma } from "../../db/prisma";
import { syncParentStatusFromChildren } from "../shipments/parent-status";
import { metricByPieceShare, reconcileFamilyMetric } from "../shipments/split-metrics";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { BusinessError } from "../core/business-error";
import { requirePositiveInt } from "../core/int-guard";
import { loadOrderProductDims } from "../orders/routes";
import { productNamesLabel } from "../../../../../packages/shared-types/product-names";
// 柜子状态流程只在 containers/status-flow.ts 定义一处，本文件不再自己抄
import {
  CONTAINER_STATUS_LABEL,
  nextStopOf,
  CONTAINER_TO_SHIPMENT_STATUS,
  flowOf,
  neverGuessOf,
} from "../containers/status-flow";

/**
 * 生成装柜单号：CN-TH-YYYYMMDDNNN。
 */
async function issueManifestNo(now: Date): Promise<string> {
  const dateKey = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const prefix = `CN-TH-${dateKey}`;
  const list = await prisma.container.findMany({
    where: { containerNo: { startsWith: prefix } },
    select: { containerNo: true },
  });
  let max = 0;
  for (const item of list) {
    const n = Number.parseInt(item.containerNo.slice(prefix.length), 10);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}

/**
 * 注册装柜管理接口。
 */
export function registerLoadingManifestRoutes(app: MinimalHttpApp): void {
  // 装柜任务列表
  app.get("/staff/loading-manifests", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const keyword = (req.query.query ?? "").trim();
    const trackingNo = (req.query.trackingNo ?? "").trim();
    const status = (req.query.status ?? "").trim();
    const transportMode = (req.query.transportMode ?? "").trim();
    const where: any = { companyId: auth.companyId };
    if (keyword) where.containerNo = { contains: keyword, mode: "insensitive" };
    if (status && status !== "ALL") where.currentStatus = status;
    // 运输方式筛选。"none" = 只看还没标运输方式的老柜子（方便员工把 9 个判不出来的补齐）
    if (transportMode === "sea" || transportMode === "land") where.transportMode = transportMode;
    else if (transportMode === "none") where.transportMode = null;
    // 按运单号过滤：查找包含该运单号的柜子
    if (trackingNo) {
      const matchingItems = await prisma.shipmentContainerItem.findMany({
        where: { shipment: { trackingNo: { contains: trackingNo, mode: "insensitive" } } },
        select: { containerId: true },
      });
      where.id = { in: [...new Set(matchingItems.map(i => i.containerId))] };
    }
    const list = await prisma.container.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: { items: { select: { id: true } } },
    });
    ok(res, {
      items: list.map((c) => ({
        id: c.id,
        manifestNo: c.containerNo,
        warehouse: c.warehouseId ?? "未知",
        status: c.currentStatus ?? "LOADING",
        transportMode: c.transportMode ?? null,
        carrierInfo: c.carrierName ?? null,
        sealedAt: c.sealedAt?.toISOString() ?? null,
        totalBills: c.items.length,
        createdAt: c.createdAt.toISOString(),
      })),
    });
  });

  // 新建装柜任务
  app.post("/staff/loading-manifests", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as { warehouse?: string; carrierInfo?: string; containerNo?: string; transportMode?: string };
    if (!body.warehouse) { fail(res, 400, "BAD_REQUEST", "仓库参数无效"); return; }
    // 2026-08-05：新建时必须说清楚这是海运柜还是陆运柜。
    // 老柜子允许为空（迁移里判不出来的留了 null），但新建的不再放行。
    const transportMode = typeof body.transportMode === "string" ? body.transportMode.trim() : "";
    if (transportMode !== "sea" && transportMode !== "land") {
      fail(res, 400, "BAD_REQUEST", "请选择运输方式：海运或陆运");
      return;
    }
    const containerNo = body.containerNo?.trim() || await issueManifestNo(new Date());
    // 查重
    const existed = await prisma.container.findUnique({ where: { containerNo }, select: { id: true } });
    if (existed) { fail(res, 409, "VALIDATION_ERROR", `柜号 ${containerNo} 已存在`); return; }
    const container = await prisma.container.create({
      data: {
        id: `ctr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        companyId: auth.companyId,
        containerNo,
        containerType: body.warehouse === "wh_dongguan_01" ? "40HQ" : "20GP",
        warehouseId: body.warehouse,
        transportMode,
        currentStatus: "LOADING",
        carrierName: body.carrierInfo?.trim() || null,
      },
    });
    ok(res, { message: "装柜任务已创建", manifest: { id: container.id, manifestNo: container.containerNo } });
  });

  /**
   * 改柜子的运输方式（2026-08-06）。
   *
   * 为什么要有这个：运输方式原来只能在新建时选，线上还有 9 个老柜子是「未标注」
   * （5 个海陆混装 + 4 个空柜，迁移时判不出来故意留空的），界面上没地方补。
   * 而状态流程是按运输方式分的 —— 不补上运输方式，这些柜子就只能按海运走。
   *
   * ⚠️ 只有当柜子**当前的状态在目标流程里也存在**时才允许改，
   * 否则会出现「柜子停在『已到港』却被改成陆运」这种走不下去的死局（陆运没有到港）。
   */
  app.post("/staff/loading-manifests/transport-mode", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as { id?: string; transportMode?: string };
    const id = body.id?.trim();
    const mode = typeof body.transportMode === "string" ? body.transportMode.trim() : "";
    if (!id) { fail(res, 400, "BAD_REQUEST", "id is required"); return; }
    if (mode !== "sea" && mode !== "land") {
      fail(res, 400, "BAD_REQUEST", "请选择运输方式：海运或陆运");
      return;
    }
    const container = await prisma.container.findFirst({
      where: { id, companyId: auth.companyId },
      select: { id: true, containerNo: true, currentStatus: true, transportMode: true },
    });
    if (!container) { fail(res, 404, "NOT_FOUND", "柜子不存在"); return; }
    // 没改（选的跟现在一样）：什么都不做。线上有陆运老柜子的货轨迹里带着早年按海运推的「已开船」，
    // 下面「走过对方流程独有步骤」那道闸会把这种原样保存也拦掉
    if (container.transportMode === mode) {
      ok(res, { id: container.id, containerNo: container.containerNo, transportMode: mode });
      return;
    }

    // 两条流程共有的状态才允许切换；陆运/海运专属状态上不许改
    // ⚠️ 2026-08-13 跟着流程改了两处归属：
    //    CUSTOMS（清关中）陆运也有了 → 从 SEA_ONLY 拿掉
    //    EXPORT_CLEARED（出口已放行）海运也有了 → 从 LAND_ONLY 拿掉
    //    CUSTOMS_INSPECT_CN / INSPECT_CLEARED_CN 两条流程都有 → 两边都不放
    const SEA_ONLY = [
      "HOLD_LOADING", "DELAY_DEPARTED", "ETA_UPDATED", "PORT_CLOSED", "BERTHED",
      "IN_TRANSIT", "DELAY_IN_TRANSIT", "ARRIVED",
      "CUSTOMS_INSPECT_TH", "INSPECT_CLEARED_TH", "DELIVERY_BOOKED",
    ];
    const LAND_ONLY = ["AT_PORT_CN", "IN_VIETNAM", "LAOS_CLEARED", "BORDER_DELAY", "CUSTOMS_INSPECT"];
    const blocked = mode === "land" ? SEA_ONLY : LAND_ONLY;
    if (blocked.includes(container.currentStatus)) {
      fail(
        res,
        400,
        "VALIDATION_ERROR",
        `这个柜子已经走到「${CONTAINER_STATUS_LABEL[container.currentStatus] ?? container.currentStatus}」了，` +
        `${mode === "land" ? "陆运" : "海运"}流程里没有这一步，不能改。要改就得先把柜子退回装柜中重来。`,
      );
      return;
    }

    /**
     * ⚠️ 上面那道「这个状态不许改运输方式」是**事务外**读的（2026-08-29 补）。
     * 另一个人正好在这一刻把柜推到「已开船」，这边照样把它改成陆运 ——
     * 柜子就落在一个陆运流程里根本不存在的状态上，后面推进和撤销全乱。
     * 现在跟推进柜子状态走同一把锁（containers 那一行），锁完拿新状态再判一次。
     */
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM containers WHERE id = ${container.id} FOR UPDATE`;
      const fresh = await tx.container.findUnique({
        where: { id: container.id },
        select: { currentStatus: true, statusDates: true, departureDate: true, ata: true },
      });
      if (!fresh) throw new BusinessError("装柜任务不存在", 404, "NOT_FOUND");
      if (blocked.includes(fresh.currentStatus)) {
        throw new BusinessError(
          `这个柜刚刚被推到「${CONTAINER_STATUS_LABEL[fresh.currentStatus] ?? fresh.currentStatus}」了，` +
            `${mode === "land" ? "陆运" : "海运"}流程里没有这一步，运输方式没有改，请刷新后再看`,
        );
      }
      /**
       * 2026-09-17（Codex 第三批 P1-1）：光看当前状态不够，还要看柜子**走过的**步骤。
       * 海运柜走过「运输中」「已到港」、停在两边都有的「清关中」时改成陆运，撤销会把柜子退回陆运流程里没有的「已到港」，
       * 后装进来的货按陆运补轨迹、却按推进账本里的海运步骤跟着退，货的状态和客户看到的轨迹就对不上了。
       * 走过的步骤看两处：时间表（真推过的步骤，撤销会删掉）和推进账本每一笔的前后状态。撤回到这些步骤之前就能改。
       */
      let walkedDates: Record<string, string> = {};
      try { walkedDates = fresh.statusDates ? JSON.parse(fresh.statusDates) : {}; } catch { walkedDates = {}; }
      const batches = await tx.containerPushBatch.findMany({
        where: { containerId: container.id, companyId: auth.companyId },
        select: { fromContainerStatus: true, toContainerStatus: true },
      });
      const walked = new Set<string>([
        ...Object.keys(walkedDates),
        ...batches.flatMap((b: { fromContainerStatus: string; toContainerStatus: string }) => [b.fromContainerStatus, b.toContainerStatus]),
      ]);
      /**
       * 上线前推的老柜子没有时间表、也没有账本（Codex 第三批第 2 轮 P1），再看两样老证据：
       *   · 开船 / 到港日期：只有推「运输中」「已到港」时才写（新建柜子的接口页面没在用）；
       *   · 柜里货的柜子推进轨迹（sl_ctn_）：老路子撤销就是按它把货退回去的，里面有对方流程独有的状态，改了以后柜子和货会退进两条不同的流程。
       * 这里「对方流程独有」按两条真流程算，不用上面手抄的名单。
       */
      if (fresh.departureDate) walked.add("IN_TRANSIT");
      if (fresh.ata) walked.add("ARRIVED");
      const targetFlow = flowOf(mode);
      const otherOnly = flowOf(mode === "land" ? "sea" : "land").filter((st) => !targetFlow.includes(st));
      const sourcesOf = new Map<string, string[]>();
      for (const [cs, ss] of Object.entries(CONTAINER_TO_SHIPMENT_STATUS)) sourcesOf.set(ss, [...(sourcesOf.get(ss) ?? []), cs]);
      const otherOnlyShipStatuses = [...sourcesOf].filter(([, css]) => css.every((cs) => otherOnly.includes(cs))).map(([ss]) => ss);
      const boxItems = await tx.shipmentContainerItem.findMany({ where: { containerId: container.id }, select: { shipmentId: true, createdAt: true } });
      const loadedAtOf = new Map(boxItems.map((it: { shipmentId: string; createdAt: Date }) => [it.shipmentId, it.createdAt.getTime()]));
      if (boxItems.length > 0 && otherOnlyShipStatuses.length > 0) {
        const pushLogs = await tx.statusLog.findMany({
          where: {
            companyId: auth.companyId,
            shipmentId: { in: [...loadedAtOf.keys()] },
            id: { startsWith: "sl_ctn_" },
            OR: [{ toStatus: { in: otherOnlyShipStatuses } }, { fromStatus: { in: otherOnlyShipStatuses } }],
          },
          select: { id: true, shipmentId: true, fromStatus: true, toStatus: true },
        });
        for (const l of pushLogs) {
          // 推进记录上没记是哪个柜推的：只认装进这个柜以后写的（Codex 第三批第 3 轮 P2 —— 遗留整票用同一个运单从别的柜挪进来，
          // 带着别的柜的「运输中」，不能算这个柜走过）。先后按记录 id 里的真实写入时间戳比，不按可以回填的 changedAt；
          // 放宽 10 分钟，防应用服务器和数据库时钟不一致。id 里读不出时间戳的老记录照样算（线上没有这种）
          const m = /^sl_ctn_(\d{13})_/.exec(l.id);
          const loadedAt = loadedAtOf.get(l.shipmentId);
          if (m && loadedAt !== undefined && Number(m[1]) < loadedAt - 10 * 60_000) continue;
          for (const ss of [l.fromStatus, l.toStatus]) for (const cs of sourcesOf.get(ss) ?? []) if (otherOnly.includes(cs)) walked.add(cs);
        }
      }
      const walkedBlocked = [...new Set([...blocked, ...otherOnly])].filter((st) => walked.has(st));
      if (walkedBlocked.length > 0) {
        throw new BusinessError(
          `这个柜子走过${walkedBlocked.map((st) => `「${CONTAINER_STATUS_LABEL[st] ?? st}」`).join("")}，` +
            `${mode === "land" ? "陆运" : "海运"}流程里没有这些步骤，改了以后撤销会退到对不上的状态，运输方式没有改。` +
            `要改请先在装柜管理把柜子撤销回这些步骤之前。`,
        );
      }
      await tx.container.update({ where: { id: container.id }, data: { transportMode: mode } });
    });
    ok(res, { id: container.id, containerNo: container.containerNo, transportMode: mode });
  });

  // 装柜详情
  app.get("/staff/loading-manifests/detail", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const id = req.query.id?.trim();
    if (!id) { fail(res, 400, "BAD_REQUEST", "id is required"); return; }
    const container = await prisma.container.findFirst({
      where: { id, companyId: auth.companyId },
      include: {
        items: {
          orderBy: { createdAt: "asc" },
          include: {
            shipment: {
              select: {
                id: true, trackingNo: true, batchNo: true, currentStatus: true, parentTrackingNo: true,
                weightKg: true, volumeM3: true, packageCount: true, packageUnit: true,
                transportMode: true, domesticTrackingNo: true,
                order: {
                  select: {
                    itemName: true, clientId: true, productQuantity: true, cargoType: true,
                    // 柜内货物那一行的品名要把全部产品名带出来（2026-09-10 老板点的）；order.itemName 只存了第一个
                    products: { orderBy: { sortOrder: "asc" }, select: { itemName: true, sortOrder: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!container) { fail(res, 404, "NOT_FOUND", "装柜任务不存在"); return; }
    ok(res, {
      id: container.id,
      manifestNo: container.containerNo,
      warehouse: container.warehouseId,
      status: container.currentStatus ?? "LOADING",
      transportMode: container.transportMode ?? null,
      carrierInfo: container.carrierName ?? null,
      sealedAt: container.sealedAt?.toISOString() ?? null,
      bills: container.items.map((item) => ({
        id: item.id,
        shipmentId: item.shipmentId,
        trackingNo: item.shipment?.trackingNo ?? null,
        batchNo: item.shipment?.batchNo ?? null,
        itemName: productNamesLabel(item.shipment?.order?.products, item.shipment?.order?.itemName) || null,
        clientId: item.shipment?.order?.clientId ?? null,
        productQuantity: item.shipment?.order?.productQuantity ?? null,
        cargoType: item.shipment?.order?.cargoType ?? null,
        packageCount: item.shipment?.packageCount ?? null,
        transportMode: item.shipment?.transportMode ?? null,
        currentStatus: item.shipment?.currentStatus ?? null,
        parentTrackingNo: item.shipment?.parentTrackingNo ?? null,
        loadedPieces: item.loadedPieceCount,
        loadedVolume: Number(item.loadedVolumeM3),
      })),
    });
  });

  /**
   * 给尾端拆柜仓的整柜派送清单数据。
   *
   * 入口放在装柜管理，所以唯一主键就是 Container.id：不生成 WD，也不读取司机/车辆。
   * 一票装柜记录输出一行，严格使用该柜实际装入的件数和方数，避免分柜子单被按原订单重复计算。
   */
  app.get("/staff/loading-manifests/export-data", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const id = req.query.id?.trim();
    if (!id) { fail(res, 400, "BAD_REQUEST", "id is required"); return; }

    const container = await prisma.container.findFirst({
      where: { id, companyId: auth.companyId },
      include: {
        items: {
          orderBy: { createdAt: "asc" },
          include: {
            shipment: {
              select: {
                id: true,
                trackingNo: true,
                parentTrackingNo: true,
                itemName: true,
                packageCount: true,
                packageUnit: true,
                weightKg: true,
                remark: true,
                currentStatus: true,
                order: {
                  select: {
                    // 取订单 id 是为了查它的产品行长宽高（2026-08-27 加）
                    id: true,
                    clientId: true,
                    itemName: true,
                    packageCount: true,
                    weightKg: true,
                    volumeM3: true,
                    receiverNameTh: true,
                    receiverPhoneTh: true,
                    receiverAddressTh: true,
                    client: {
                      select: {
                        name: true,
                        phone: true,
                        addresses: {
                          orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
                          take: 1,
                          select: { contactName: true, contactPhone: true, addressDetail: true, label: true },
                        },
                      },
                    },
                    shipments: {
                      select: {
                        trackingNo: true,
                        parentTrackingNo: true,
                        packageCount: true,
                        weightKg: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!container) { fail(res, 404, "NOT_FOUND", "装柜任务不存在"); return; }
    if (container.items.length === 0) { fail(res, 400, "VALIDATION_ERROR", "空柜没有可导出的货物"); return; }

    /**
     * 先把柜里这些货所属订单的长宽高一次性查出来（2026-08-27 加）。
     * 长宽高记在「产品行」上，运单本身没有；导出要用，所以这里批量取，
     * 不在循环里一条条查（那样有多少票货就查多少次）。
     */
    const dimsByOrderId = await loadOrderProductDims(
      auth.companyId,
      container.items.map((it) => it.shipment.order?.id).filter((v): v is string => Boolean(v)),
    );

    const customerMap = new Map<string, {
      clientId: string;
      clientName: string;
      contactName: string;
      contactPhone: string;
      address: string;
      addressLabel: string;
      shipments: Array<Record<string, unknown>>;
    }>();

    for (const item of container.items) {
      const shipment = item.shipment;
      const order = shipment.order;
      const clientId = order?.clientId ?? "未关联客户";
      const defaultAddress = order?.client?.addresses?.[0];
      let customer = customerMap.get(clientId);
      if (!customer) {
        customer = {
          clientId,
          clientName: order?.client?.name ?? clientId,
          contactName: order?.receiverNameTh?.trim() || defaultAddress?.contactName || order?.client?.name || "",
          contactPhone: order?.receiverPhoneTh?.trim() || defaultAddress?.contactPhone || order?.client?.phone || "",
          address: order?.receiverAddressTh?.trim() || defaultAddress?.addressDetail || "",
          addressLabel: defaultAddress?.label || "",
          shipments: [],
        };
        customerMap.set(clientId, customer);
      }
      const receiverName = order?.receiverNameTh?.trim() || customer.contactName;
      const receiverPhone = order?.receiverPhoneTh?.trim() || customer.contactPhone;
      const receiverAddress = order?.receiverAddressTh?.trim() || customer.address;
      const shipmentPackageCount = shipment.packageCount
        ?? (shipment.parentTrackingNo ? item.loadedPieceCount : (order?.packageCount ?? 0));
      const familyKey = shipment.parentTrackingNo ?? shipment.trackingNo;
      const familyRows = (order?.shipments ?? [])
        .filter((part) => (part.parentTrackingNo ?? part.trackingNo) === familyKey)
        .map((part) => ({ ...part, key: part.trackingNo, isParent: !part.parentTrackingNo }));
      if (!familyRows.some((part) => part.key === shipment.trackingNo)) {
        familyRows.push({
          trackingNo: shipment.trackingNo,
          parentTrackingNo: shipment.parentTrackingNo,
          packageCount: shipmentPackageCount,
          weightKg: shipment.weightKg,
          key: shipment.trackingNo,
          isParent: !shipment.parentTrackingNo,
        });
      }
      const familyHasChildren = familyRows.some((part) => !!part.parentTrackingNo);
      const weightFamily = reconcileFamilyMetric(
        order?.weightKg,
        order?.packageCount,
        familyRows.map((part) => ({ ...part, pieceCount: part.packageCount, value: part.weightKg })),
        2,
      );
      // 整柜重量必须和客户单使用同一票货口径，同时再按本柜实际装入件数缩放。
      // 历史缺重量的分柜家族从订单总量按“实际装入件数/订单件数”计算；
      // 新子单已有分配重量时，则按“实际装入件数/子单件数”计算。
      const orderShareWeight = metricByPieceShare(
        order?.weightKg,
        item.loadedPieceCount,
        order?.packageCount,
        2,
      );
      const shipmentFamilyWeight = familyHasChildren
        ? weightFamily[shipment.trackingNo]
        : (shipment.weightKg == null
          ? metricByPieceShare(order?.weightKg, shipmentPackageCount, order?.packageCount, 2)
          : Number(shipment.weightKg));
      const loadedWeight = shipmentFamilyWeight == null
        ? orderShareWeight
        : (metricByPieceShare(
          shipmentFamilyWeight,
          item.loadedPieceCount,
          shipmentPackageCount,
          2,
        ) ?? orderShareWeight);
      customer.shipments.push({
        lastmileOrderId: item.id,
        trackingNo: shipment.trackingNo,
        parentTrackingNo: shipment.parentTrackingNo ?? "",
        // 清单一行一票、products 故意不展开（见下），所以品名这一格必须把全部产品名带上；
        // 运单的 itemName 只存了第一个产品名（2026-09-10，老板反馈「品类不全」）
        itemName: (order?.id ? dimsByOrderId.get(order.id)?.names : undefined) || shipment.itemName || order?.itemName || "",
        packageCount: item.loadedPieceCount,
        packageUnit: shipment.packageUnit || "",
        // ⚠️ 同 admin-ops：没填就是没填，不要变成 0（2026-08-26 修）
        weightKg: loadedWeight ?? null,
        volumeM3: Number(item.loadedVolumeM3),
        // 长宽高（2026-08-27 加）：来自订单的产品行；
        // 同一票有多个不同尺寸时是 "60/50" 这样的字符串，没填就是 null
        lengthCm: (order?.id ? dimsByOrderId.get(order.id)?.lengthCm : undefined) ?? null,
        widthCm: (order?.id ? dimsByOrderId.get(order.id)?.widthCm : undefined) ?? null,
        heightCm: (order?.id ? dimsByOrderId.get(order.id)?.heightCm : undefined) ?? null,
        remark: shipment.remark || "",
        status: shipment.currentStatus,
        containerNos: [container.containerNo],
        receiverName,
        receiverPhone,
        receiverAddress,
        // 柜内通常是分柜后的子运单，产品行属于原订单，直接展开会把件数重复算回整票。
        products: [],
      });
    }

    const customers = [...customerMap.values()];
    const shipments = customers.flatMap((customer) => customer.shipments) as Array<Record<string, any>>;
    const warehouseName: Record<string, string> = {
      wh_yiwu_01: "义乌",
      wh_guangzhou_01: "广州",
      wh_dongguan_01: "东莞",
      wh_shenzhen_01: "深圳",
    };
    ok(res, {
      containerId: container.id,
      containerNo: container.containerNo,
      containerType: container.containerType,
      origin: warehouseName[container.warehouseId ?? ""] ?? (container.warehouseId || ""),
      destination: container.transportMode === "land"
        ? "泰国仓库"
        : (container.transportMode === "sea" ? "林查班" : ""),
      carrierInfo: container.carrierName ?? "",
      deliveryNo: "",
      scope: "container",
      carrierName: "",
      driverName: "",
      licensePlate: "",
      phoneNumber: "",
      deliveryDate: "",
      status: container.currentStatus,
      customerCount: customers.length,
      shipmentCount: shipments.length,
      signedCount: 0,
      totalPackageCount: shipments.reduce((sum, shipment) => sum + Number(shipment.packageCount || 0), 0),
      totalVolumeM3: Number(shipments.reduce((sum, shipment) => sum + Number(shipment.volumeM3 || 0), 0).toFixed(3)),
      totalWeightKg: Number(shipments.reduce((sum, shipment) => sum + Number(shipment.weightKg || 0), 0).toFixed(2)),
      containerNos: [container.containerNo],
      customers,
      generatedAt: new Date().toISOString(),
    });
  });

  // 封柜
  app.post("/staff/loading-manifests/seal", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const id = req.query.id?.trim();
    if (!id) { fail(res, 400, "BAD_REQUEST", "id is required"); return; }
    const container = await prisma.container.findFirst({ where: { id, companyId: auth.companyId } });
    if (!container) { fail(res, 404, "NOT_FOUND", "装柜任务不存在"); return; }
    /**
     * ⚠️ 2026-08-28 补：封柜原来**没有事务、没有锁** ——
     * 上面那道「已封柜/已运输/已到达就拦住」读的是事务外的快照，
     * 另一个人正好在这一刻把柜推到「已开船」，这边照样把它改回 SEALED，
     * 柜子状态直接倒退，而轨迹里已经写了开船。
     * 现在跟推进柜子状态走同一把锁（containers 那一行），先锁再重查。
     */
    const updated = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM containers WHERE id = ${id} FOR UPDATE`;
      const fresh = await tx.container.findUnique({ where: { id }, select: { currentStatus: true } });
      if (!fresh) throw new BusinessError("装柜任务不存在", 404, "NOT_FOUND");
      /**
       * ⚠️ 用**白名单**：只有还在装柜中的柜子能封（2026-08-29 修）。
       * 上一版是黑名单，只拦 SEALED / IN_TRANSIT / ARRIVED ——
       * 已经到「清关放行」「入泰仓」「已签收」的柜子照样能被写回 SEALED，
       * 状态直接倒退，而轨迹里早就写了后面那些环节。
       * 柜子的状态流程有十几档，黑名单永远补不全；白名单只有一档，加新状态也不会漏。
       */
      if (fresh.currentStatus !== "LOADING") {
        throw new BusinessError(
          `这个柜现在是「${CONTAINER_STATUS_LABEL[fresh.currentStatus] ?? fresh.currentStatus}」，只有装柜中的柜子能封柜，本次操作没有执行`,
        );
      }
      return tx.container.update({
        where: { id },
        data: { currentStatus: "SEALED", sealedAt: new Date() },
      });
    });
    ok(res, { message: "封柜成功", manifest: { id: updated.id, status: updated.currentStatus } });
  });

  // 添加运单到装柜（通过运单号 trackingNo，可选 pieceCount 按件数分装）
  app.post("/staff/loading-manifests/add-shipment", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const containerId = req.query.id?.trim();
    if (!containerId) { fail(res, 400, "BAD_REQUEST", "container id is required"); return; }
    const body = (req.body ?? {}) as { trackingNo?: string; pieceCount?: number };
    if (!body.trackingNo?.trim()) { fail(res, 400, "BAD_REQUEST", "运单号不能为空"); return; }
    /**
     * 装柜件数必须是正整数（2026-08-31 收尾补）。
     * 原来只判 typeof === "number" && > 0，填 2.5 能一路穿进事务：
     * 子单 packageCount 和柜内 loadedPieceCount 在 schema 里都是 Int，
     * 写库那一刻才炸 500，员工只看到「服务器繁忙」——正是 int-guard 点名要拦的那类。
     * pieceCount 可以不填（不填走整票），所以 undefined 要先放过。
     */
    if (body.pieceCount !== undefined) {
      const pieceErr = requirePositiveInt(body.pieceCount, "装柜件数");
      if (pieceErr) { fail(res, 400, "VALIDATION_ERROR", pieceErr); return; }
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
      /**
       * ⚠️⚠️ **锁序必须是【柜 → 运单】，而且柜子要锁完再读**（2026-08-28 补）。
       *
       * 「推进柜子状态」（containers/routes.ts ~426）是先锁柜再动运单；
       * 这条路原来只锁运单、柜子只读不锁，两边方向相反会死锁。
       *
       * 更要紧的是**读的时机**：柜子信息（当前状态、运输方式、statusDates）
       * 下面要拿来给这票新货**补历史轨迹**。锁之前读的话，
       * 「推进柜子状态」可以在读完之后提交 —— 这票货就按柜子的**旧状态**补轨迹、
       * 补出来的历史还少一截，而推进那条已经走完不会回头补，**永远是错的**。
       * 所以：先锁，再读，读到的才是被锁保护住的那份。
       */
      await tx.$queryRaw`SELECT id FROM containers WHERE id = ${containerId} FOR UPDATE`;
      const container = await tx.container.findFirst({ where: { id: containerId, companyId: auth.companyId } });
      if (!container) throw new Error("装柜任务不存在");

      // 先锁再读，防并发 TOCTOU
      const shipment = await tx.shipment.findFirst({
        where: { trackingNo: body.trackingNo!.trim(), companyId: auth.companyId },
      });
      if (!shipment) throw new Error("未找到该运单号");

      await tx.$queryRaw`SELECT id FROM shipments WHERE id = ${shipment.id} FOR UPDATE`;
      const locked = await tx.shipment.findUnique({
        where: { id: shipment.id },
        select: { currentStatus: true, packageCount: true, volumeM3: true, parentTrackingNo: true, orderId: true, batchNo: true, packageUnit: true, weightKg: true, transportMode: true, domesticTrackingNo: true, warehouseId: true, itemName: true },
      });
      if (!locked) throw new Error("未找到该运单号");
      if (locked.parentTrackingNo) throw new Error("子运单不能再次装柜，请使用父运单号");
      /**
       * ⚠️ 终态运单不许再装柜（2026-08-31 补）。
       * 员工批量粘贴运单号时手滑输错一个（比如输成上个月已签收的单），
       * 原来这里照单全收：切出子单塞进柜子，客户看到的状态从「已签收」
       * 倒退回「已装柜」，已取消的废货也被算进柜子的件数方数。
       * 管理员端老装柜接口（containers/routes.ts ~857）早就有这道拦截，
       * 名单和它保持一致；用锁内重读的 currentStatus 判断（CLAUDE.md 第 28 条）。
       */
      const TERMINAL_ZH: Record<string, string> = { delivered: "已签收", returned: "已退回", cancelled: "已取消", exception: "异常" };
      if (TERMINAL_ZH[locked.currentStatus]) {
        throw new Error(`这张单已经「${TERMINAL_ZH[locked.currentStatus]}」，已完结的运单不能再装柜`);
      }
      const totalPkg = locked?.packageCount ?? 0;
      const reqPieces = typeof body.pieceCount === "number" && body.pieceCount > 0 ? body.pieceCount : totalPkg;
      if (reqPieces > totalPkg) throw new Error(`装柜件数(${reqPieces})超过运单总件数(${totalPkg})`);

      /**
       * ⚠️⚠️ 这里的 vol / weight 必须是**父单当前剩下的**，不是原始总量。
       *
       * 2026-08-22 修复的 bug：分柜时件数会从父单扣掉（`packageCount - reqPieces`），
       * **但体积和重量以前从来不扣**。于是第二次分柜时算式变成
       *   childVolume = 原始总体积 × 本次件数 ÷ 剩余件数
       * 剩余件数已经变小、分子却还是整票的体积 —— 分母减了分子不减。
       *
       * 生产实测样本 GZ260801300（客户报 233 件、每件 45×43×32 = 0.06192 方）：
       *   第一次拆 212 件 → 14.427 × 212/233 = 13.127 方 ✅ 对
       *   第二次拆  21 件 → 14.427 ×  21/ 21 = 14.427 方 ❌ 应为 1.300 方
       * 21 件货被记成了整票 233 件的体积，这个数还写进了柜子的已装体积。
       * 全库核查：36 张运单多算、累计 166.474 方、涉及 20 个柜子
       *（最严重的 FFAU7779699 系统认为装 38.38 方，实际只有 9.19 方）。
       *
       * 重量同理：以前直接 `weightKg: shipment.weightKg` 把整票重量复制给每个子单。
       *
       * 修法：拆的时候父单同步扣减体积和重量，下一次分柜自然按剩余的算。
       */
      const vol = locked?.volumeM3 ? Number(locked.volumeM3) : 0;
      const weight = locked?.weightKg != null ? Number(locked.weightKg) : null;
      if (reqPieces === 0) throw new Error("装柜件数不能为0");

      let loadShipmentId = shipment.id;
      let loadTrackingNo = shipment.trackingNo;
      // 这一票实际装进柜子的体积 —— 由下面切分子单时算出，装柜记录直接复用同一个数
      let childVolumeForItem = 0;

      // 全部走子运单，不再区分部分装/全部装
      {
        const children = await tx.shipment.findMany({
          where: { parentTrackingNo: shipment.trackingNo, companyId: auth.companyId },
          select: { trackingNo: true },
          orderBy: { trackingNo: "asc" },
        });
        let nextSeq = 1;
        for (const c of children) {
          const match = c.trackingNo.match(/-(\d+)$/);
          if (match) { const n = parseInt(match[1]); if (n >= nextSeq) nextSeq = n + 1; }
        }
        const childTrackingNo = `${shipment.trackingNo}-${nextSeq}`;
        // 子单 id 补随机后缀（2026-08-31）：只用毫秒时间戳的话，两个员工同一毫秒
        // 各自装柜会撞出一模一样的 id，后写的整单回滚报数据库错。
        // 写法对齐同文件的 sci_ / 运单模块拆单的 s_（shipments/routes.ts 的手工分柜路由（2026-08-31 已删，见该文件注释）当年的同款写法）。
        const childId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        // 按「父单当前剩余」的比例切分；全部拆完时直接给剩余量，避免除法留下零头
        const childVolume: number = reqPieces === totalPkg
          ? Number(vol.toFixed(3))
          : Number(((vol * reqPieces) / totalPkg).toFixed(3));
        const childWeight = weight == null
          ? null
          : (reqPieces === totalPkg ? Number(weight.toFixed(2)) : Number(((weight * reqPieces) / totalPkg).toFixed(2)));

        await tx.shipment.create({
          data: {
            id: childId, companyId: auth.companyId, orderId: shipment.orderId,
            trackingNo: childTrackingNo, parentTrackingNo: shipment.trackingNo,
            batchNo: shipment.batchNo, currentStatus: "loaded",
            packageCount: reqPieces, packageUnit: shipment.packageUnit,
            weightKg: childWeight, volumeM3: childVolume,
            transportMode: shipment.transportMode, domesticTrackingNo: shipment.domesticTrackingNo,
            warehouseId: shipment.warehouseId, itemName: shipment.itemName,
          },
        });

        // 父单同步扣减：件数、体积、重量三样一起减，缺一样下次分柜就会算错
        await tx.shipment.update({
          where: { id: shipment.id },
          data: {
            packageCount: totalPkg - reqPieces,
            volumeM3: Number((vol - childVolume).toFixed(3)),
            ...(weight == null || childWeight == null
              ? {}
              : { weightKg: Number((weight - childWeight).toFixed(2)) }),
            updatedAt: new Date(),
          },
        });

        loadShipmentId = childId;
        loadTrackingNo = childTrackingNo;
        childVolumeForItem = childVolume;
      }

      // 装柜
      const existing = await tx.shipmentContainerItem.findFirst({
        where: { containerId, shipmentId: loadShipmentId },
      });
      if (existing) throw new Error("该运单已在本柜中");

      const loadPieces = reqPieces;
      // 装柜体积直接用上面切好的子单体积 —— 同一个数不要再算第二遍，
      // 以前这里重复了一次同样的错误算式（分母是剩余件数、分子是原始体积）
      const loadVolume = childVolumeForItem;
      const itemId = `sci_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      try {
        await tx.shipmentContainerItem.create({
          data: { id: itemId, containerId, shipmentId: loadShipmentId, loadedVolumeM3: loadVolume, loadedPieceCount: loadPieces },
        });
      } catch (e: any) {
        if (e?.code === "P2002") throw new Error("该运单已在本柜中");
        throw e;
      }

      // ===== 状态同步 + 随柜补记轨迹（2026-08-06）=====
      //
      // 为什么要补记：柜子经常是**事后补建**的 —— 货已经到泰国仓了，员工才在系统里
      // 建柜、把运单装进去。原来这里只写一条「当前状态」的轨迹，前面的装柜、发车、
      // 过口岸、清关在系统里对这票货从未存在过。
      // 生产实测：有轨迹的 515 票里 242 票（47%）轨迹是从半路开始的，
      // 其中 74 票直接从「泰国已到仓」起步，中国段整段空白。
      //
      // 现在：把柜子**已经走过的每一个环节**都给这票货补一条轨迹，
      // 时间尽量用柜子自己记的真实日期（封柜/开船/到港/清关放行），
      // 没有对应日期的环节在前后两个已知时间之间按比例推算，备注标明是补记。
      const now = new Date();
      const flow = flowOf(container.transportMode);
      const curIdx = flow.indexOf(container.currentStatus);

      // ⚠️ 只补**柜子真的走过**的环节，不能把流程里排在前面的都补上。
      // 实测踩过：柜子从「老挝边境已放行」直接推到「清关已放行」，跳过了「海关查验」，
      // 但补记时按流程顺序把「海关查验」也补了 —— 等于给客户编造了没发生过的事。
      // statusDates 记录的就是「真的推过的那几步」（2026-08-06 起有）。
      let recordedDates: Record<string, string> = {};
      try { recordedDates = container.statusDates ? JSON.parse(container.statusDates) : {}; } catch { recordedDates = {}; }
      const recordedSteps = flow.filter((cs) => recordedDates[cs]);

      // 「滞留 / 查验 / 延迟」这类是意外情况，没记录就绝不能凭空补
      // 名单挪到 containers/status-flow.ts 了（2026-08-10），撤销状态那边也要用同一份
      // 2026-08-13：名单改成按运输方式取，海运陆运各一份（见 status-flow.ts 的 neverGuessOf）
      const NEVER_GUESS = neverGuessOf(container.transportMode);
      const passed = recordedSteps.length > 0
        ? recordedSteps
        // 老柜子没有 statusDates（这个功能之前建的），只能按流程尽力补，但跳过意外状态
        : (curIdx >= 0 ? flow.slice(0, curIdx + 1).filter((cs) => !NEVER_GUESS.has(cs)) : ["LOADING"]);

      // 柜子身上真实记录过日期的节点，拿来当锚点。
      // statusDates 是每次推进状态时记下的实际日期（2026-08-06 加的），最准；
      // 另外几个老字段（封柜/开船/到港/清关放行）作为兜底。
      const anchor: Record<string, Date | null> = {
        LOADING: container.createdAt ?? null,
        SEALED: container.sealedAt ?? container.loadingDate ?? null,
        IN_TRANSIT: container.departureDate ?? null,
        ARRIVED: container.ata ?? null,
        CUSTOMS_CLEARED: container.customsClearedAt ?? null,
      };
      for (const [st, iso] of Object.entries(recordedDates)) {
        const d = new Date(iso);
        if (!Number.isNaN(d.getTime())) anchor[st] = d;
      }

      type Step = { containerStatus: string; shipmentStatus: string; at: Date | null };
      const steps: Step[] = passed
        .map((cs: string) => ({ containerStatus: cs, shipmentStatus: CONTAINER_TO_SHIPMENT_STATUS[cs] ?? "", at: anchor[cs] ?? null }))
        // LOADING 不对应运单状态，跳过（2026-08-13 起 UNLOADING 已经有了，会被补记）
        .filter((s: Step) => s.shipmentStatus);
      // 柜子还在装柜中：至少给一条「已装柜」，否则这票货的轨迹会完全没有起点
      if (steps.length === 0) steps.push({ containerStatus: "SEALED", shipmentStatus: "loaded", at: container.createdAt ?? now });

      // 没有真实日期的环节：在前后两个已知时间之间按比例推算；最后一步用当前时间兜底
      const firstAt = steps.find((s) => s.at)?.at ?? container.createdAt ?? now;
      if (!steps[0]!.at) steps[0]!.at = firstAt;
      if (!steps[steps.length - 1]!.at) steps[steps.length - 1]!.at = now;
      for (let i = 0; i < steps.length; i++) {
        if (steps[i]!.at) continue;
        let prev = i - 1; while (prev >= 0 && !steps[prev]!.at) prev--;
        let next = i + 1; while (next < steps.length && !steps[next]!.at) next++;
        const a = steps[prev]?.at ?? firstAt;
        const b = steps[next]?.at ?? now;
        const span = b.getTime() - a.getTime();
        steps[i]!.at = new Date(a.getTime() + Math.round((span * (i - prev)) / (next - prev)));
      }
      // 保证严格递增，免得同一秒的几条在界面上乱序
      for (let i = 1; i < steps.length; i++) {
        if (steps[i]!.at!.getTime() <= steps[i - 1]!.at!.getTime()) {
          steps[i]!.at = new Date(steps[i - 1]!.at!.getTime() + 1000);
        }
      }

      const finalStatus = steps[steps.length - 1]!.shipmentStatus;
      await tx.shipment.update({ where: { id: loadShipmentId }, data: { currentStatus: finalStatus, updatedAt: now } });

      const partial = reqPieces < totalPkg ? `（分装 ${reqPieces}件）` : "";
      const writtenMnf: Array<{ id: string; toStatus: string }> = [];
      // 柜子已经不在装柜中、而且有推进账本（2026-09-17）：先单独写一条「装入柜子」（已装柜），后面每一步都是随柜补记、挂进账本。
      // 原来最后一步那条同时当「装入柜子」，撤销那一步时它会跟着删，撤到底这票货一条「已装柜」都不剩（对抗测试 I/J 报的）。
      // 没有账本的老柜子（上线前推的）照原来的写法：老路子撤销不删随柜补记，单独多写的补记会撤不掉、留在轨迹里跟柜子对不上。
      const pushBatches = await tx.containerPushBatch.findMany({
        where: { containerId, companyId: auth.companyId },
        orderBy: { seq: "asc" },
        select: { id: true, fromContainerStatus: true, toContainerStatus: true },
      });
      const boxAlreadyMoved = container.currentStatus !== "LOADING" && pushBatches.length > 0;
      if (boxAlreadyMoved) {
        await tx.statusLog.create({
          data: {
            id: `sl_mnf_${Date.now()}_load_${Math.random().toString(36).slice(2, 6)}`,
            companyId: auth.companyId, shipmentId: loadShipmentId,
            operatorId: auth.userId, operatorRole: auth.role, operatorName: auth.name ?? "",
            fromStatus: "loaded", toStatus: "loaded",
            remark: `装入柜子 ${container.containerNo}${partial}`,
            nextStop: nextStopOf("SEALED", container.transportMode),
            changedAt: new Date(firstAt.getTime() - 1000),
          },
        });
      }
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i]!;
        const isLast = i === steps.length - 1 && !boxAlreadyMoved;
        const mnfLogId = `sl_mnf_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`;
        if (boxAlreadyMoved) writtenMnf.push({ id: mnfLogId, toStatus: s.shipmentStatus });
        await tx.statusLog.create({
          data: {
            id: mnfLogId,
            companyId: auth.companyId, shipmentId: loadShipmentId,
            operatorId: auth.userId, operatorRole: auth.role, operatorName: auth.name ?? "",
            fromStatus: i === 0 ? "loaded" : steps[i - 1]!.shipmentStatus,
            toStatus: s.shipmentStatus,
            // 最后一条是真的「刚装进柜子」，前面几条是随柜补上的，要标清楚别让人以为是实时记录
            remark: isLast
              ? `装入柜子 ${container.containerNo}${partial}`
              : `${CONTAINER_STATUS_LABEL[s.containerStatus] ?? s.containerStatus}（随柜 ${container.containerNo} 补记）`,
            // 默认下一站要按柜子的运输方式取，否则海运柜补出来的轨迹会写成
            // 陆运的「广西凭祥出口」（2026-08-10 修，同一个病根三处都有）
            nextStop: nextStopOf(s.containerStatus, container.transportMode),
            changedAt: s.at!,
          },
        });
      }
      const syncStatus = finalStatus;

      /**
       * 2026-09-17（推进账本）：柜子已经推过的，把这票后装进来的货记进每一笔推进账本，撤销时它也跟着退。
       * 状态从「第一笔账之前柜子的状态」开始按每一笔柜子状态顺下去；每一步的随柜补记挂上，撤销那一步时一起删。
       * 「装入柜子」单独一条（上面 boxAlreadyMoved 那段），不挂任何一笔 —— 撤到底它也留着，货确实装进过这个柜。
       */
      {
        const batches = pushBatches;
        if (batches.length > 0) {
          const used = new Set<string>();
          // 起点：第一笔账之前柜子是什么状态，货就是什么状态（上线前已经在路上的柜子不能一律当「已装柜」）
          let prevSt = CONTAINER_TO_SHIPMENT_STATUS[batches[0]!.fromContainerStatus] ?? "loaded";
          const entryRows: Array<Record<string, unknown>> = [];
          const stamp = Date.now();
          for (const b of batches) {
            const to = CONTAINER_TO_SHIPMENT_STATUS[b.toContainerStatus] ?? prevSt;
            const rec = writtenMnf.find((w) => w.toStatus === to && !used.has(w.id));
            if (rec) used.add(rec.id);
            const attach = rec ? rec.id : null;
            entryRows.push({
              id: `cpe_${stamp}_${String(entryRows.length).padStart(5, "0")}_${Math.random().toString(36).slice(2, 6)}`,
              companyId: auth.companyId,
              batchId: b.id,
              shipmentId: loadShipmentId,
              fromStatus: prevSt,
              toStatus: to,
              statusLogId: attach,
              kind: "late_add",
            });
            prevSt = to;
          }
          await tx.containerPushEntry.createMany({ data: entryRows as any });
        }
      }

      // 同步父运单状态（2026-08-22 改成统一推算）
      //
      // ⚠️ 原来这里是「把父单直接写成本次子单的状态」，不看其它子单走到哪 ——
      // 分柜后另一票子货还在更早的环节时，父单会被推快。
      // 现在交给 syncParentStatusFromChildren：父单自己还有货就不动它，
      // 货全在子单上时按**最慢的子单**推算。
      if (loadShipmentId !== shipment.id) {
        await syncParentStatusFromChildren(tx, shipment.trackingNo, auth.companyId);
      }

      // 2026-08-05：柜子和运单的运输方式对不上时给个提醒，**但不拦**。
      // 线上真实存在 5 个海陆混装的柜（大概率是故意拼柜），硬拦会让员工干不了活。
      // 柜子没标运输方式的（老柜子）不提醒，免得刷屏。
      const modeMismatch =
        container.transportMode && locked.transportMode && container.transportMode !== locked.transportMode
          ? { containerMode: container.transportMode, shipmentMode: locked.transportMode }
          : null;

      return { loadTrackingNo, isPartial: reqPieces < totalPkg, parentTrackingNo: shipment.trackingNo, modeMismatch };
    });

    const ZH: Record<string, string> = { sea: "海运", land: "陆运" };
    ok(res, {
      message: "运单已添加到装柜",
      trackingNo: result.loadTrackingNo,
      isPartial: result.isPartial,
      parentTrackingNo: result.parentTrackingNo,
      warning: result.modeMismatch
        ? `这是${ZH[result.modeMismatch.containerMode] ?? result.modeMismatch.containerMode}柜，装进来的是${ZH[result.modeMismatch.shipmentMode] ?? result.modeMismatch.shipmentMode}的货`
        : null,
    });
    } catch (e: any) {
      fail(res, 400, "BAD_REQUEST", e.message ?? "装柜失败");
    }
  });

  // 从装柜卸下运单（可选 pieceCount 部分卸柜）
  app.post("/staff/loading-manifests/remove-shipment", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as { itemId?: string; pieceCount?: number };
    if (!body.itemId) { fail(res, 400, "BAD_REQUEST", "itemId required"); return; }
    /**
     * 卸柜件数也必须是正整数（2026-08-31 收尾补，跟装柜那条 ~515 同一批）。
     * 原来只靠下面 typeof === "number" && > 0 那句：填 2.5 能一路穿进事务，
     * 算出 newLoaded=7.5 这种小数，写 Int 字段（loadedPieceCount / packageCount）
     * 时 Prisma 才炸，员工看到的是英文报错。
     * pieceCount 可以不填（不填走全量卸柜），所以 undefined 要先放过。
     */
    if (body.pieceCount !== undefined) {
      const pieceErr = requirePositiveInt(body.pieceCount, "卸柜件数");
      if (pieceErr) { fail(res, 400, "VALIDATION_ERROR", pieceErr); return; }
    }

    try {
      await prisma.$transaction(async (tx) => {
      /**
       * ⚠️ 锁序【柜 → 柜内记录 → 运单】（2026-08-29 补）。
       * 上一版这条只锁了柜内记录，不碰柜子那把锁 —— 推进柜子状态那条握着柜锁、
       * 正在按锁后的清单推进时，这边可以同时把一条记录删掉，
       * 推进那边就会对着一条已经不存在的记录写状态和轨迹。
       * 先锁柜之后，卸柜和推进必须排队。
       */
      const lockTarget = await tx.shipmentContainerItem.findFirst({
        where: { id: body.itemId, container: { companyId: auth.companyId } },
        select: { containerId: true, shipmentId: true, shipment: { select: { parentTrackingNo: true } } },
      });
      if (!lockTarget) throw new Error("装柜记录不存在");
      /**
       * ⚠️⚠️ **锁序必须是【柜 → 运单 → 柜内记录】**（2026-08-29 第七轮复核之后改的）。
       *
       * 原来这里是【柜 → 柜内记录 → 运单】，跟装柜那条路（同文件 ~521/531 行，
       * 【柜 → 运单 → 柜内记录】）**方向相反**。复核在本地库开两个连接实测，
       * PostgreSQL 直接报 `deadlock detected`。
       *
       * 真实场景：一个人卸柜 item(C,S)，另一个人同时把 S 装进 C ——
       *   卸柜：拿着 item(C,S) 这一行，去要运单 S
       *   装柜：拿着运单 S，去 insert item(C,S) —— 撞上唯一索引
       *         `(container_id, shipment_id)`，于是要等卸柜手里那一行
       * 两边互等。**装柜那边只是 create，不代表它不拿柜内记录的锁** ——
       * 唯一索引冲突照样要等对方那一行，这是我上一轮漏掉的一环。
       *
       * 为什么统一到「运单在前」而不是「柜内记录在前」：
       * 装柜插的是**一行还不存在的记录**，没法提前锁它，所以只能让另一边让步。
       *
       * ⚠️ 先锁再读：`lockTarget` 是锁之前读的，只拿它做「锁哪几行」的依据；
       * 真正干活用的 `item` 必须是锁完之后重查的那一份（CLAUDE.md 第 28 条）。
       */
      await tx.$queryRaw`SELECT id FROM containers WHERE id = ${lockTarget.containerId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM shipments WHERE id = ${lockTarget.shipmentId} FOR UPDATE`;
      /**
       * ⚠️ 父单的锁也要在**柜内记录之前**拿。
       * 装柜那条路锁的就是父单（同文件 ~531，子运单不许再装柜），顺序是
       * 【柜 → 父单 → 柜内记录】；这边原来把父单留到最后
       * （下面 syncParentStatusFromChildren 里才锁），又是一对反向。
       * 下面那两处 syncParentStatusFromChildren 仍然会再锁一次 ——
       * 同一个事务里重复锁同一行是免费的，不用去删。
       */
      if (lockTarget.shipment?.parentTrackingNo) {
        await tx.$queryRaw`SELECT id FROM shipments WHERE tracking_no = ${lockTarget.shipment.parentTrackingNo} AND company_id = ${auth.companyId} FOR UPDATE`;
      }
      await tx.$queryRaw`SELECT id FROM shipment_container_items WHERE id = ${body.itemId} FOR UPDATE`;
      const item = await tx.shipmentContainerItem.findFirst({
        where: { id: body.itemId, container: { companyId: auth.companyId } },
        // ⚠️ weightKg 必须一起查：2026-08-22 分柜改成从父单扣体积和重量之后，
        // 卸柜就必须把这两样也还回去，否则一装一卸这票货的体积重量会凭空变小。
        include: { shipment: { select: { id: true, parentTrackingNo: true, packageCount: true, volumeM3: true, weightKg: true } } },
      });
      if (!item) throw new Error("装柜记录不存在");

      // 运单的锁已经在上面按【柜 → 运单 → 柜内记录】的顺序拿过了

      const totalLoaded = item.loadedPieceCount;
      const reqPieces = typeof body.pieceCount === "number" && body.pieceCount > 0 && body.pieceCount < totalLoaded ? body.pieceCount : totalLoaded;
      const childPkg = item.shipment.packageCount ?? 0;
      const childVol = item.shipment.volumeM3 ? Number(item.shipment.volumeM3) : 0;
      const childWt = item.shipment.weightKg != null ? Number(item.shipment.weightKg) : null;

      // 部分卸柜：减装柜件数；有父单的再减子运单本身、把卸掉的还给父运单
      if (reqPieces < totalLoaded) {
        const newLoaded = totalLoaded - reqPieces;
        /**
         * ⚠️ 装柜记录的「已装体积」按**记录自己的已装量**等比缩（2026-08-31 修）。
         * 原来这里写的是按运单总体积重算出来的数 —— 对管理员端「只装了
         * 一部分体积」的整票记录来说，loadedVolumeM3 本来就比运单总体积小，
         * 一次部分卸柜就把它覆盖成按总体积算的错数。
         */
        const itemVol = Number(item.loadedVolumeM3);
        const newItemVol = Number((totalLoaded > 0 ? (itemVol * newLoaded) / totalLoaded : 0).toFixed(3));
        await tx.shipmentContainerItem.update({
          where: { id: body.itemId },
          data: { loadedPieceCount: newLoaded, loadedVolumeM3: newItemVol },
        });

        /**
         * ⚠️ 没有父单 = 整票直接装柜的记录（老数据有，管理员端今天还能造）——
         * 只减装柜记录，**不许动运单自己的件数/体积/重量**（2026-08-31 修）。
         * 原来不分这两种：先把运单本身砍小，又因为没父单跳过「还回去」那步，
         * 砍掉的货在系统里凭空消失。全量卸柜（shipments/unload-item.ts ~47）
         * 早就这么区分了，这里照着补齐。
         */
        if (item.shipment.parentTrackingNo) {
          const newPkg = childPkg - reqPieces;
          const newVol = Number((newPkg > 0 && childPkg > 0 ? (childVol * newPkg) / childPkg : 0).toFixed(3));
          // 卸下这部分对应的体积/重量 —— 要原样加回父单，不能凭空消失
          const backVol = Number((childVol - newVol).toFixed(3));
          const newWt = childWt == null ? null
            : Number((newPkg > 0 && childPkg > 0 ? (childWt * newPkg) / childPkg : 0).toFixed(2));
          const backWt = childWt == null || newWt == null ? null : Number((childWt - newWt).toFixed(2));

          await tx.shipment.update({
            where: { id: item.shipment.id },
            data: {
              packageCount: newPkg,
              volumeM3: newVol as any,
              ...(newWt == null ? {} : { weightKg: newWt as any }),
              updatedAt: new Date(),
            },
          });
          // 恢复父运单（把卸下来的件数/体积/重量还回去）
          await tx.$queryRaw`SELECT id FROM shipments WHERE tracking_no = ${item.shipment.parentTrackingNo} FOR UPDATE`;
          const parent = await tx.shipment.findFirst({
            where: { trackingNo: item.shipment.parentTrackingNo, companyId: auth.companyId },
            select: { id: true, packageCount: true, volumeM3: true, weightKg: true, currentStatus: true },
          });
          if (parent) {
            const pv = parent.volumeM3 != null ? Number(parent.volumeM3) : 0;
            const pw = parent.weightKg != null ? Number(parent.weightKg) : null;
            const parentNewPkg = (parent.packageCount ?? 0) + reqPieces;
            /**
             * ⚠️ 状态也要退回来（2026-08-31 补，抄的是全量卸柜 unload-item.ts 的口径）。
             * 装柜时父单件数被扣到 0，状态跟着子单走；这里把货还回去之后
             * 父单又「自己有货」了，syncParentStatusFromChildren 就不再接管它 ——
             * 不退的话状态永远冻在还货前那一刻（比如已发运），货其实躺在仓库。
             * 同样只在父单确实拿回了货、且状态确实往前走过时才退。
             * 2026-09-02：退回目标从「已创建」改成「已入库」（inWarehouseCN）——
             * 货卸下来就在国内仓里；created / inWarehouseCN 都不再退（跟那边同一口径）。
             */
            const 要退状态 =
              parentNewPkg > 0 &&
              parent.currentStatus !== "created" &&
              parent.currentStatus !== "inWarehouseCN";
            await tx.shipment.update({
              where: { id: parent.id },
              data: {
                packageCount: parentNewPkg,
                volumeM3: Number((pv + backVol).toFixed(3)) as any,
                ...(pw == null || backWt == null ? {} : { weightKg: Number((pw + backWt).toFixed(2)) as any }),
                ...(要退状态 ? { currentStatus: "inWarehouseCN" } : {}),
                updatedAt: new Date(),
              },
            });
            if (要退状态) {
              // 写一条轨迹，让客户看得懂「货为什么退回去了」，措辞跟全量卸柜一致
              await tx.statusLog.create({
                data: {
                  id: `sl_unld_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                  companyId: auth.companyId,
                  shipmentId: parent.id,
                  // 记点「卸柜」的人，不写死「系统」（老板 2026-09-17）；只有超级管理员看得到，见 core/operator-visibility.ts
                  operatorId: auth.userId,
                  operatorRole: auth.role,
                  operatorName: auth.name ?? "",
                  fromStatus: parent.currentStatus,
                  toStatus: "inWarehouseCN",
                  remark: "已从柜子卸下，退回国内仓等待重新装柜",
                  changedAt: new Date(),
                },
              });
            }
          }
        }
      } else {
        /**
         * 全量卸柜 —— 走共用实现（2026-08-29 抽出去了）。
         * 「删除柜子」那条路以前完全没做这件事，子单变孤儿、父单数字回不来；
         * 现在两处同一份代码，改一处不会漏另一处。
         * 状态退回「已入库」（2026-09-02 起）+ 写轨迹也在那个函数里，见 shipments/unload-item.ts。
         */
        await unloadItemFully(
          tx,
          {
            id: body.itemId!,
            shipment: {
              id: item.shipment.id,
              parentTrackingNo: item.shipment.parentTrackingNo,
              packageCount: item.shipment.packageCount,
              volumeM3: item.shipment.volumeM3,
              weightKg: item.shipment.weightKg,
            },
          },
          auth.companyId,
          { userId: auth.userId, role: auth.role, name: auth.name },
        );
      }
    });

    ok(res, { message: "运单已从装柜卸下" });
    } catch (e: any) {
      fail(res, 400, "BAD_REQUEST", e.message ?? "卸柜失败");
    }
  });
}
