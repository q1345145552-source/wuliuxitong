// B-7: 已从 node:sqlite 迁移到 Prisma + PostgreSQL（2026-05-20）
import { ShipmentsNotFoundError, lockAndSyncParents, lockShipmentsChildrenFirst } from "../shipments/lock-shipments";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import { syncParentStatusFromChildren } from "../shipments/parent-status";
import { whrBucket, taskBucket, isDead } from "../finance/money-rules";
import { metricByPieceShare, reconcileFamilyMetric } from "../shipments/split-metrics";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { sanitizeRemarkForClient } from "../core/client-privacy";
import { productNamesLabel } from "../../../../../packages/shared-types/product-names";

/** 同一票货重复进派送单时抛这个，调用方转成 400 而不是 500 */
class LastmileConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LastmileConflictError";
  }
}

/** 选中的运单不存在或不属于当前公司；整车事务必须一起回滚 */
class LastmileShipmentNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LastmileShipmentNotFoundError";
  }
}

/** Decimal | null → number */
function decToNumber(value: Prisma.Decimal | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Number(value.toString());
}

/**
 * 注册管理员运营侧（LMP/关务/末端/结算）接口。
 */
export function registerAdminOpsRoutes(app: MinimalHttpApp): void {
  app.get("/admin/lmp/rates", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const rows = await prisma.adminLmpRate.findMany({
      where: { companyId: auth.companyId },
      orderBy: { updatedAt: "desc" },
    });
    ok(res, {
      items: rows.map((item) => ({
        id: item.id,
        routeCode: item.routeCode,
        supplierName: item.supplierName,
        transportMode: item.transportMode,
        seasonTag: item.seasonTag,
        supplierCost: decToNumber(item.supplierCost),
        quotePrice: decToNumber(item.quotePrice),
        currency: item.currency,
        effectiveFrom: item.effectiveFrom,
        effectiveTo: item.effectiveTo ?? undefined,
        updatedAt: item.updatedAt.toISOString(),
      })),
    });
  });

  app.post("/admin/lmp/rates", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      routeCode?: string;
      supplierName?: string;
      transportMode?: string;
      seasonTag?: string;
      supplierCost?: number;
      quotePrice?: number;
      currency?: string;
      effectiveFrom?: string;
      effectiveTo?: string;
    };
    const routeCode = body.routeCode?.trim();
    const supplierName = body.supplierName?.trim();
    const transportMode = body.transportMode?.trim();
    const seasonTag = body.seasonTag?.trim();
    const supplierCost = Number(body.supplierCost);
    const quotePrice = Number(body.quotePrice);
    if (!routeCode || !supplierName || !transportMode || !seasonTag || !Number.isFinite(supplierCost) || !Number.isFinite(quotePrice)) {
      fail(res, 400, "BAD_REQUEST", "invalid lmp rate payload");
      return;
    }
    const id = `lmp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const created = await prisma.adminLmpRate.create({
      data: {
        id,
        companyId: auth.companyId,
        routeCode,
        supplierName,
        transportMode,
        seasonTag,
        supplierCost,
        quotePrice,
        currency: body.currency?.trim() || "CNY",
        effectiveFrom: body.effectiveFrom?.trim() || new Date().toISOString().slice(0, 10),
        effectiveTo: body.effectiveTo?.trim() || null,
      },
      select: { id: true, updatedAt: true },
    });
    ok(res, { id: created.id, updatedAt: created.updatedAt.toISOString() });
  });

  app.get("/admin/customs/cases", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const rows = await prisma.adminCustomsCase.findMany({
      where: { companyId: auth.companyId },
      orderBy: { updatedAt: "desc" },
    });
    const shipmentIds = [...new Set(rows.map((r) => r.shipmentId).filter((v): v is string => Boolean(v)))];
    const shipments = await prisma.shipment.findMany({
      // 顺带带上公司（2026-08-27）：这些 id 本来就是从本公司的案件里取的，
      // 现在是安全的，但明着写一道，免得以后谁改了上游就漏了
      where: { id: { in: shipmentIds }, companyId: auth.companyId },
      select: { id: true, trackingNo: true },
    });
    const tnMap = new Map(shipments.map((s) => [s.id, s.trackingNo]));
    ok(res, {
      items: rows.map((item) => ({
        id: item.id,
        shipmentId: item.shipmentId ?? undefined,
        shipmentTrackingNo: item.shipmentId ? (tnMap.get(item.shipmentId) ?? null) : null,
        orderId: item.orderId ?? undefined,
        status: item.status,
        remark: item.remark ?? undefined,
        updatedAt: item.updatedAt.toISOString(),
      })),
    });
  });

  app.post("/admin/customs/cases", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as { shipmentId?: string; orderId?: string; status?: string; remark?: string };
    const status = body.status?.trim();
    if (!status) {
      fail(res, 400, "BAD_REQUEST", "status is required");
      return;
    }
    const VALID_CUSTOMS_STATUSES = ["pending", "inspection", "cleared", "rejected"];
    if (!VALID_CUSTOMS_STATUSES.includes(status)) {
      fail(res, 400, "BAD_REQUEST", `status must be one of: ${VALID_CUSTOMS_STATUSES.join(", ")}`);
      return;
    }
    const id = `cus_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const created = await prisma.adminCustomsCase.create({
      data: {
        id,
        companyId: auth.companyId,
        shipmentId: body.shipmentId?.trim() || null,
        orderId: body.orderId?.trim() || null,
        status,
        remark: body.remark?.trim() || null,
      },
      select: { id: true, updatedAt: true },
    });
    ok(res, { id: created.id, updatedAt: created.updatedAt.toISOString() });
  });

  app.get("/admin/lastmile/orders", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    /**
     * ⚠️⚠️ 这里必须用 select 一个个点名要字段，**绝不能用 include 或不写 select**。
     *
     * 2026-08-22 实测：原来这里是 include（等于把所有标量字段都查出来），
     * 而这张表里 `signImageBase64`（数据库列 sign_product_image_base64）存的是签收凭证 base64 原图 ——
     * 570 条派送单里 553 条带图，**光图片就 181 MB，最大单张 4.9 MB**。
     * nginx 日志实测：这个接口**平均每次返回 113 MB**，118 次调用烧掉 13.4 GB 流量。
     *
     * 后果是三重的：
     *   ① 后端每被调一次就吞 100 多 MB 内存 —— 线上 API 因此**每 6 天被 V8 堆撑爆一次**
     *      （日志原话：FATAL ERROR: JavaScript heap out of memory，崩时已跑 144 小时）
     *   ② 员工每打开一次「尾端派送」就要下 113 MB，页面自然慢（用户原话：「每次都加载很慢」）
     *   ③ 白烧流量
     *
     * 而页面上那些图**只显示成 40×40 的缩略图** —— 为了一个指甲盖大的图下载 113 MB。
     *
     * 现在列表只回一个「有没有图」的布尔值；真要看图时走
     * `/admin/lastmile/sign-image?id=xxx` 单张取。
     * （CLAUDE.md 第 3 条早就写了「大数据量字段不要随列表返回」，这里是同一个错换了个地方。）
     */
    const rows = await prisma.adminLastmileOrder.findMany({
      where: { companyId: auth.companyId },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        deliveryNo: true,
        shipmentId: true,
        deliveryDate: true,
        carrierName: true,
        externalTrackingNo: true,
        driverName: true,
        licensePlate: true,
        phoneNumber: true,
        status: true,
        updatedAt: true,
        // signImageBase64（数据库列 sign_product_image_base64）故意不查 —— 见上面那段
        shipment: {
          select: {
            trackingNo: true,
            itemName: true,
            packageCount: true,
            packageUnit: true,
            order: {
              select: {
                clientId: true,
                receiverNameTh: true,
                receiverPhoneTh: true,
                receiverAddressTh: true,
                // 卡片上的品名要把全部产品名带出来（2026-09-10，老板反馈「品类不全」）；
                // shipment.itemName 只存了第一个产品名，见 packages/shared-types/product-names.ts
                products: { orderBy: { sortOrder: "asc" }, select: { itemName: true, sortOrder: true } },
                client: {
                  select: {
                    name: true,
                    phone: true,
                    addresses: {
                      orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
                      take: 1,
                      select: {
                        contactName: true,
                        contactPhone: true,
                        addressDetail: true,
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

    // 「这条有没有签收图」单独用一次轻量查询算出来：只取 id，不碰图片内容。
    // 用 `not: null` + `not: ""` 是因为历史数据里两种空值都有。
    const withImageIds = new Set(
      (await prisma.adminLastmileOrder.findMany({
        where: {
          companyId: auth.companyId,
          AND: [{ signImageBase64: { not: null } }, { signImageBase64: { not: "" } }],
        },
        select: { id: true },
      })).map((r) => r.id),
    );
    ok(res, {
      items: rows.map((item) => {
        const order = item.shipment?.order;
        const defaultAddress = order?.client?.addresses[0];
        return {
          id: item.id,
          deliveryNo: item.deliveryNo,
          shipmentId: item.shipmentId,
          trackingNo: item.shipment?.trackingNo ?? item.shipmentId,
          clientId: order?.clientId ?? null,
          clientName: order?.client?.name ?? null,
          receiverName: order?.receiverNameTh || defaultAddress?.contactName || order?.client?.name || null,
          receiverPhone: order?.receiverPhoneTh || defaultAddress?.contactPhone || order?.client?.phone || null,
          receiverAddress: order?.receiverAddressTh || defaultAddress?.addressDetail || null,
          itemName: productNamesLabel(order?.products, item.shipment?.itemName) || null,
          packageCount: item.shipment?.packageCount ?? null,
          packageUnit: item.shipment?.packageUnit ?? null,
          deliveryDate: item.deliveryDate,
          carrierName: item.carrierName,
          externalTrackingNo: item.externalTrackingNo,
          driverName: item.driverName,
          licensePlate: item.licensePlate,
          phoneNumber: item.phoneNumber,
          // 只告诉前端「有没有图」，图本身走 /admin/lastmile/sign-image 单张取
          hasSignImage: withImageIds.has(item.id),
          status: item.status,
          updatedAt: item.updatedAt.toISOString(),
        };
      }),
    });
  });

  /**
   * WD 创建后，按客户导出客户签收单。
   *
   * 必须显式传 clientId；同一辆车可有多个客户和地址，服务端先收窄范围，
   * 返回结构也不查询柜号，防止客户模板误带其它客户或内部柜号。
   */
  app.get("/admin/lastmile/customer-export-data", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const deliveryNo = req.query.deliveryNo?.trim() ?? "";
    const clientId = req.query.clientId?.trim() ?? "";
    if (!deliveryNo || !clientId) {
      fail(res, 400, "BAD_REQUEST", "deliveryNo 和 clientId 为必填");
      return;
    }

    const rows = await prisma.adminLastmileOrder.findMany({
      where: { companyId: auth.companyId, deliveryNo },
      orderBy: { updatedAt: "asc" },
      select: {
        id: true,
        carrierName: true,
        driverName: true,
        licensePlate: true,
        phoneNumber: true,
        deliveryDate: true,
        status: true,
        shipment: {
          select: {
            trackingNo: true,
            parentTrackingNo: true,
            itemName: true,
            packageCount: true,
            packageUnit: true,
            weightKg: true,
            volumeM3: true,
            remark: true,
            order: {
              select: {
                clientId: true,
                itemName: true,
                packageCount: true,
                packageUnit: true,
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
                products: {
                  orderBy: { sortOrder: "asc" },
                  select: {
                    itemName: true,
                    packageCount: true,
                    lengthCm: true,
                    widthCm: true,
                    heightCm: true,
                    weightKg: true,
                  },
                },
                // 取订单完整父子家族；不能只看当前 WD，子单可能在其它 WD。
                shipments: {
                  select: {
                    trackingNo: true,
                    parentTrackingNo: true,
                    packageCount: true,
                    weightKg: true,
                    volumeM3: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    if (rows.length === 0) {
      fail(res, 404, "NOT_FOUND", "派送单不存在");
      return;
    }
    const selectedRows = rows.filter((row) => row.shipment.order?.clientId === clientId);
    if (selectedRows.length === 0) {
      fail(res, 404, "NOT_FOUND", "这张派送单里没有该客户");
      return;
    }

    const firstOrder = selectedRows[0].shipment.order;
    const defaultAddress = firstOrder?.client?.addresses?.[0];
    const contactName = firstOrder?.receiverNameTh?.trim() || defaultAddress?.contactName || firstOrder?.client?.name || "";
    const contactPhone = firstOrder?.receiverPhoneTh?.trim() || defaultAddress?.contactPhone || firstOrder?.client?.phone || "";
    const address = firstOrder?.receiverAddressTh?.trim() || defaultAddress?.addressDetail || "";
    const splitParentTrackingNos = new Set<string>();
    const splitParentsWithMissingWeight = new Set<string>();
    const splitParentsWithMissingVolume = new Set<string>();
    for (const row of selectedRows) {
      if (row.shipment.parentTrackingNo) {
        splitParentTrackingNos.add(row.shipment.parentTrackingNo);
        if (row.shipment.weightKg == null) splitParentsWithMissingWeight.add(row.shipment.parentTrackingNo);
        if (row.shipment.volumeM3 == null) splitParentsWithMissingVolume.add(row.shipment.parentTrackingNo);
      }
      for (const child of row.shipment.order?.shipments ?? []) {
        if (!child.parentTrackingNo) continue;
        splitParentTrackingNos.add(child.parentTrackingNo);
        if (child.weightKg == null) splitParentsWithMissingWeight.add(child.parentTrackingNo);
        if (child.volumeM3 == null) splitParentsWithMissingVolume.add(child.parentTrackingNo);
      }
    }
    const shipments = selectedRows.map((row) => {
      const shipment = row.shipment;
      const order = shipment.order;
      // 子单缺件数时宁可输出 0，也不能再回退成订单整票件数。
      const packageCount = shipment.packageCount
        ?? (shipment.parentTrackingNo ? 0 : (order?.packageCount ?? 0));
      const isSplitParent = !shipment.parentTrackingNo && splitParentTrackingNos.has(shipment.trackingNo);
      const familyKey = shipment.parentTrackingNo ?? shipment.trackingNo;
      const familyRows = (order?.shipments ?? [])
        .filter((part) => (part.parentTrackingNo ?? part.trackingNo) === familyKey)
        .map((part) => ({ ...part, key: part.trackingNo, isParent: !part.parentTrackingNo }));
      if (!familyRows.some((part) => part.key === shipment.trackingNo)) {
        familyRows.push({
          trackingNo: shipment.trackingNo,
          parentTrackingNo: shipment.parentTrackingNo,
          packageCount,
          weightKg: shipment.weightKg,
          volumeM3: shipment.volumeM3,
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
      const volumeFamily = reconcileFamilyMetric(
        order?.volumeM3,
        order?.packageCount,
        familyRows.map((part) => ({ ...part, pieceCount: part.packageCount, value: part.volumeM3 })),
        3,
      );
      // 历史手工分柜只扣了父单件数，子单重量/体积为空、父单仍留着整票总量。
      // 空子单按件数补算，父单吸收舍入余数或不守恒差额。
      const weightKg = familyHasChildren && weightFamily[shipment.trackingNo] != null
        ? weightFamily[shipment.trackingNo]
        : (isSplitParent && splitParentsWithMissingWeight.has(shipment.trackingNo)
        ? metricByPieceShare(order?.weightKg, packageCount, order?.packageCount, 2)
        : (shipment.weightKg == null
          ? metricByPieceShare(order?.weightKg, packageCount, order?.packageCount, 2)
          : decToNumber(shipment.weightKg)));
      const volumeM3 = familyHasChildren && volumeFamily[shipment.trackingNo] != null
        ? volumeFamily[shipment.trackingNo]
        : (isSplitParent && splitParentsWithMissingVolume.has(shipment.trackingNo)
        ? metricByPieceShare(order?.volumeM3, packageCount, order?.packageCount, 3)
        : (shipment.volumeM3 == null
          ? metricByPieceShare(order?.volumeM3, packageCount, order?.packageCount, 3)
          : decToNumber(shipment.volumeM3)));
      return {
        lastmileOrderId: row.id,
        trackingNo: shipment.trackingNo,
        parentTrackingNo: shipment.parentTrackingNo ?? "",
        // 分柜的子单 / 父单下面 products 故意不展开（会把件数重复算回整票），
        // 那种情况整票只有一行，品名必须把全部产品名带上，不能只印第一个（2026-09-10）
        itemName: productNamesLabel(order?.products, shipment.itemName || order?.itemName || ""),
        packageCount,
        packageUnit: shipment.packageUnit || order?.packageUnit || "",
        // ⚠️ 这里**必须原样下发 null**，不能 `?? 0`（2026-08-26 修）。
        // 上面那一大段已经会在「订单也没填」时正确返回 null，
        // 结果被这一句抹成 0，导出的客户签收单上就印成「0 m³ / 0 kg」——
        // 那是给客户签字的纸质单据，等于白纸黑字说这箱货没有重量。
        // 生成器早就会把 null 写成空格子了，问题一直卡在这一句。
        weightKg: weightKg ?? null,
        volumeM3: volumeM3 ?? null,
        remark: sanitizeRemarkForClient(shipment.remark || "", true),
        status: row.status,
        containerNos: [],
        receiverName: order?.receiverNameTh?.trim() || contactName,
        receiverPhone: order?.receiverPhoneTh?.trim() || contactPhone,
        receiverAddress: order?.receiverAddressTh?.trim() || address,
        products: (shipment.parentTrackingNo || isSplitParent ? [] : (order?.products ?? [])).map((product) => ({
          itemName: product.itemName,
          packageCount: product.packageCount,
          lengthCm: product.lengthCm,
          widthCm: product.widthCm,
          heightCm: product.heightCm,
          weightKg: product.weightKg,
        })),
      };
    });
    const first = selectedRows[0];
    ok(res, {
      containerId: "",
      containerNo: "",
      containerType: "",
      origin: "",
      destination: "",
      carrierInfo: "",
      deliveryNo,
      scope: "customer",
      carrierName: first.carrierName,
      driverName: first.driverName ?? "",
      licensePlate: first.licensePlate ?? "",
      phoneNumber: first.phoneNumber ?? "",
      deliveryDate: first.deliveryDate ?? "",
      status: selectedRows.every((row) => row.status === "SIGNED") ? "SIGNED" : "DELIVERING",
      customerCount: 1,
      shipmentCount: shipments.length,
      signedCount: shipments.filter((shipment) => shipment.status === "SIGNED").length,
      totalPackageCount: shipments.reduce((sum, shipment) => sum + Number(shipment.packageCount || 0), 0),
      totalVolumeM3: Number(shipments.reduce((sum, shipment) => sum + Number(shipment.volumeM3 || 0), 0).toFixed(3)),
      totalWeightKg: Number(shipments.reduce((sum, shipment) => sum + Number(shipment.weightKg || 0), 0).toFixed(2)),
      containerNos: [],
      customers: [{
        clientId,
        clientName: firstOrder?.client?.name ?? clientId,
        contactName,
        contactPhone,
        address,
        addressLabel: defaultAddress?.label || "",
        shipments,
      }],
      generatedAt: new Date().toISOString(),
    });
  });

  /**
   * 单独取一张签收凭证（2026-08-22 新增）。
   *
   * 配合上面列表接口的瘦身：列表只回 hasSignImage，用户点「看凭证」时才来这里取那一张。
   * 一次只查一条、只取图片一个字段，最大 4.9 MB —— 而原来是一次 113 MB。
   *
   * ⚠️ 必须带 companyId 查，别只按 id 查（同文件里创建派送单那处就是漏了公司条件的反面教材）。
   */
  app.get("/admin/lastmile/sign-image", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const id = typeof req.query?.id === "string" ? req.query.id.trim() : "";
    if (!id) {
      fail(res, 400, "BAD_REQUEST", "id 为必填");
      return;
    }
    const row = await prisma.adminLastmileOrder.findFirst({
      where: { id, companyId: auth.companyId },
      select: { signImageBase64: true },
    });
    if (!row) {
      fail(res, 404, "NOT_FOUND", "派送单不存在");
      return;
    }
    ok(res, { signImageBase64: row.signImageBase64 || null });
  });

  app.post("/admin/lastmile/orders", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as { shipmentIds?: string[]; driverName?: string; licensePlate?: string; phoneNumber?: string; status?: string; deliveryNo?: string; deliveryDate?: string; moveFromDelivering?: boolean };
    const shipmentIds = [...new Set((body.shipmentIds ?? []).map(s => s.trim()).filter(Boolean))];
    const moveFromDelivering = body.moveFromDelivering === true;
    if (body.moveFromDelivering !== undefined && typeof body.moveFromDelivering !== "boolean") {
      fail(res, 400, "VALIDATION_ERROR", "改派标志必须是布尔值");
      return;
    }
    let driverName = body.driverName?.trim() || "";
    let licensePlate = body.licensePlate?.trim() || "";
    let phoneNumber = body.phoneNumber?.trim() || "";
    let deliveryDate = body.deliveryDate?.trim() || "";
    const status = body.status?.trim() || "DELIVERING";
    const existingDeliveryNo = body.deliveryNo?.trim();
    if (shipmentIds.length === 0) {
      fail(res, 400, "BAD_REQUEST", "at least one shipmentId is required");
      return;
    }
    // 2026-08-31（排查 #33）：状态只认 DELIVERING / SIGNED 两个值。
    // 原来传什么存什么，乱码状态会让签收单导出和「不能重复派送」的判断失灵。
    // 页面不传 status（默认 DELIVERING），这里只挡直接调接口的。
    // 2026-08-31（Codex 复核）：再收紧 —— 新建只许 DELIVERING。传 SIGNED 建单时，
    // 下面照样把运单写成 outForDelivery、轨迹写「正在派送」，还没有签收照片，
    // 单子说签收了、运单说在派送，两边对不上。签收只能走 /admin/lastmile/status。
    // 前端建单从不传 status（LastmileDispatchWorkspace 的 body 里没这个字段；
    // business-api 里带 status 的 createAdminLastmileOrder 无人调用），只挡直接调接口的。
    if (status === "SIGNED") {
      fail(res, 400, "VALIDATION_ERROR", "新建派送单不能直接是已签收，签收请走签收操作");
      return;
    }
    if (status !== "DELIVERING") {
      fail(res, 400, "VALIDATION_ERROR", `状态不合法：${status}。新建派送单只允许 DELIVERING（派送中）`);
      return;
    }
    // 2026-08-06：派送日期在库里是纯文本，原来填什么存什么 ——
    // 生产上真出现过 WD000199 的日期是「20206-08-06」（年份多打一个 0）。
    // 前端那个 <input type="date"> 拦不住五位数年份，只能在这里卡。
    if (deliveryDate) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(deliveryDate);
      const d = m ? new Date(`${deliveryDate}T00:00:00Z`) : null;
      const year = m ? Number(m[1]) : 0;
      const validCalendarDate = !!d && !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === deliveryDate;
      // 上下界放宽到 2020～当年+2，够用又能挡住手滑（2 月 30 号这种也会被上面那句挡掉）
      const thisYear = new Date().getUTCFullYear();
      if (!validCalendarDate || year < 2020 || year > thisYear + 2) {
        fail(res, 400, "VALIDATION_ERROR", `派送日期不对：${deliveryDate}。正确格式是 2026-08-06 这样的年-月-日`);
        return;
      }
    }
    // 复用已有派送单号（追加模式）；新号在下面写单的事务里再算
    let deliveryNo = existingDeliveryNo ?? "";
    if (existingDeliveryNo) {
      // 追加到已有派送单，继承司机信息
      const exist = await prisma.adminLastmileOrder.findFirst({ where: { deliveryNo: existingDeliveryNo, companyId: auth.companyId }, select: { deliveryNo: true, driverName: true, licensePlate: true, phoneNumber: true, deliveryDate: true } });
      if (!exist) { fail(res, 404, "NOT_FOUND", "deliveryNo not found"); return; }
      // 追加时不传司机信息则继承已有值
      if (!driverName) driverName = exist.driverName ?? "";
      if (!licensePlate) licensePlate = exist.licensePlate ?? "";
      if (!phoneNumber) phoneNumber = exist.phoneNumber ?? "";
      if (!deliveryDate) deliveryDate = exist.deliveryDate ?? "";
    }

    // 2026-08-06：原来是「一个运单一个事务」，循环里第 N 个失败时，前 N-1 个已经提交了 ——
    // 运单状态被改成「派送中」、派送单却没建成，留下查不到派送单的孤儿运单（生产实测 3 张）。
    // 现在整车放进**同一个事务**：要么全部成功，要么一条都不写。
    // 2026-08-06：出车这条轨迹带上司机姓名和电话，客户看到的是
    // 「司机【张三 - 0993176818】正在为您派送，请注意查收」。
    // ⚠️ 司机信息不是必填 —— 没填就退回原来的写法，别弄出「司机【】」这种东西。
    const driverLabel = [driverName, phoneNumber].filter(Boolean).join(" - ");

    const results: Array<{ id: string; shipmentId: string }> = [];
    let moved = 0;
    const skipped: string[] = [];
    try {
      await prisma.$transaction(async (tx) => {
        if (!existingDeliveryNo) {
          /**
           * ⚠️ 算号必须和写单在**同一个事务**里（2026-08-31 改，排查 #13）。
           *
           * 原来是先开一个小事务专门算号：advisory 锁跟着那个小事务一提交就放了，
           * 可这时记录还没写进库 —— 第二个员工紧跟着进来算号，看到的最大号
           * 和第一个人一样，两张派送单拿到同一个 WD 号，两车货混成一车。
           * 现在锁拿到手后算号、写单、一起提交，锁到提交才放，
           * 第二个人必须等第一张单真正落库之后才能算号。
           *
           * ⚠️ 锁序：advisory 锁 2901 放在锁运单之前拿，固定成「2901 → 旧派送单行锁 → 运单行锁」，
           * 全库只有这一处拿 2901，不会跟别的路径成环。
           */
          await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(2901)');
          const last = await tx.adminLastmileOrder.findFirst({
            where: { deliveryNo: { startsWith: "WD" } },
            orderBy: { deliveryNo: "desc" },
            select: { deliveryNo: true },
          });
          const num = last ? parseInt(last.deliveryNo.replace("WD", ""), 10) || 0 : 0;
          deliveryNo = `WD${String(num + 1).padStart(6, "0")}`;
        }
        const deliveringRows = await tx.adminLastmileOrder.findMany({
          where: { shipmentId: { in: shipmentIds }, companyId: auth.companyId, status: "DELIVERING" },
          select: { id: true, shipmentId: true, deliveryNo: true },
        });
        const conflicts = deliveringRows.filter((row) => row.deliveryNo !== deliveryNo);
        if (!moveFromDelivering && conflicts.length > 0) {
          const shipments = await tx.shipment.findMany({
            where: { id: { in: shipmentIds }, companyId: auth.companyId },
            select: { id: true, trackingNo: true },
          });
          const numbers = new Map(shipments.map((row) => [row.id, row.trackingNo]));
          throw new LastmileConflictError("下面运单还在别的派送单里派送中：\n" +
            conflicts.map((row) => `${numbers.get(row.shipmentId) ?? row.shipmentId}（${row.deliveryNo}）`).join("\n") +
            "\n请确认改派后重试，未送达的货不要点签收。");
        }
        // 与签收/删除一致：旧派送单（id 有序）先于运单；锁后重读，保留已签收历史。
        const oldIds = moveFromDelivering ? conflicts.map((row) => row.id) : [];
        for (const oldId of [...oldIds].sort()) {
          await tx.$queryRaw`SELECT id FROM admin_lastmile_orders WHERE id = ${oldId} AND company_id = ${auth.companyId} FOR UPDATE`;
        }
        const movableRows = oldIds.length > 0 ? await tx.adminLastmileOrder.findMany({
          where: { id: { in: oldIds }, companyId: auth.companyId, status: "DELIVERING" },
          select: { id: true, shipmentId: true, deliveryNo: true },
        }) : [];
        const departRemark = driverLabel
          ? `司机【${driverLabel}】正在为您派送，请注意查收`
          : `正在为您派送，请注意查收（${deliveryNo}）`;
        /**
         * ⚠️⚠️ **锁序：先把这批运单按 id 排序全部锁完，再逐个干活**（2026-08-29 改）。
         *
         * 原来是在循环里「锁子单 → 干活 → 锁父单 → 下一个子单」，两个毛病：
         *   ① shipmentIds 是前端传什么顺序就什么顺序，两个员工同时给
         *      同一批货建派送单、顺序相反，就是最经典的反向等待死锁；
         *   ② 父单锁夹在两个子单锁中间 —— 本事务拿着父单 P 去要子单 S2，
         *      「推进柜子状态」那条路（containers/routes.ts ~429）却是
         *      先锁完所有子单（有序）再锁父单，它拿着 S2 来要 P。**成环。**
         *
         * 现在统一成跟柜子那条路一样的【全部子单（有序）→ 全部父单（有序）】。
         */
        /**
         * ⚠️ 走共用函数（2026-08-29 第八轮改）。
         * 原来是 `[...shipmentIds].sort()` 一锅端 —— 而尾端页面取候选运单走的是
         * `/staff/shipments?all=1`，后端 `all=1` **明确不过滤父子**
         * （shipments/routes.ts:427-429），父单和子单都能被勾进同一张派送单。
         * 复核在测试库查到 5 组父子单同时可派送，双连接实测出真死锁。
         */
        // 混选留货父单与另一家子单时，把后者的祖先也放进同一父单排序层，避免 P→Q / Q→P。
        const selectedRows = await tx.shipment.findMany({
          where: { id: { in: shipmentIds }, companyId: auth.companyId },
          select: { parentTrackingNo: true },
        });
        const ancestorNos = [...new Set(selectedRows.flatMap((row) => row.parentTrackingNo ? [row.parentTrackingNo] : []))];
        const ancestors = ancestorNos.length > 0 ? await tx.shipment.findMany({
          where: { trackingNo: { in: ancestorNos }, companyId: auth.companyId },
          select: { id: true },
        }) : [];
        const lockedIds = await lockShipmentsChildrenFirst(tx, [...new Set([...shipmentIds, ...ancestors.map((row) => row.id)])], auth.companyId);
        const selectedIds = new Set(shipmentIds);
        const orderedIds = lockedIds.filter((id) => selectedIds.has(id)); // 祖先只锁不派。
        /** 父单留到最后统一同步，别夹在子单锁中间（见上面 ②） */
        const parentNosToSync = new Set<string>();
        for (const sid of orderedIds) {
          /**
           * ⚠️ 一票货不能同时在两张「还没签收」的派送单里（2026-08-25 新增）。
           *
           * 数据库的唯一约束只管住了「同一张派送单里不能重复放同一票货」
           * （@@unique([deliveryNo, shipmentId])），**管不住跨派送单**。
           * 生产实测 4 票货进了两张单、5 行状态互相打架，比如：
           *   SZ260702524-1  WD000326 显示「派送中」，WD000379 显示「已签收」
           * 更麻烦的是删单：删掉其中一张会把运单退回「已到仓」，
           * 另一张明明还在派送中，货就从流程里消失了。
           *
           * ⚠️ 只挡「派送中」，**不挡已签收** —— 「删单重派 / 真的派两趟」是正常业务
           * （2026-08-14 用户拍板：数据忠实记录，不算毛病）。签收完再派一趟要放行。
           *
           * ⚠️ 先给运单行上锁再查：两个员工同时把同一票货加进各自的派送单时，
           * 不锁的话两边都查到「没有在途派送单」，双双放行。
           * ⚠️ 锁已经在上面按 id 排序一次性拿完了（2026-08-29 挪的），这里只管读。
           */
          const ownShipment = await tx.shipment.findFirst({
            where: { id: sid, companyId: auth.companyId },
            select: { id: true, trackingNo: true, currentStatus: true, parentTrackingNo: true, packageCount: true },
          });
          if (!ownShipment) {
            throw new LastmileShipmentNotFoundError(`运单 ${sid} 不存在或不属于当前公司`);
          }
          // 件数为空也按 0 算（跟前端候选过滤 `(packageCount ?? 0)` 同一口径）
          if (ownShipment.parentTrackingNo == null && (ownShipment.packageCount ?? 0) === 0) {
            const child = await tx.shipment.findFirst({
              where: { parentTrackingNo: ownShipment.trackingNo, companyId: auth.companyId },
              select: { id: true },
            });
            if (child) throw new LastmileConflictError(`运单 ${ownShipment.trackingNo} 已分柜、货都在子单上，请勾选它的子单`);
          }
          const inTarget = await tx.adminLastmileOrder.findFirst({
            where: { shipmentId: sid, companyId: auth.companyId, deliveryNo },
            select: { id: true },
          });
          if (inTarget) {
            skipped.push(ownShipment.trackingNo);
            continue;
          }
          const toMove = movableRows.filter((row) => row.shipmentId === sid);
          const busy = await tx.adminLastmileOrder.findFirst({
            where: {
              shipmentId: sid, companyId: auth.companyId, status: "DELIVERING",
              id: { notIn: toMove.map((row) => row.id) },
            },
            select: { deliveryNo: true },
          });
          if (busy) {
            // 新出现的冲突行没有预先锁定；此时不倒过来拿派送单锁，整车回滚后重新确认。
            throw new LastmileConflictError(
              `运单 ${ownShipment.trackingNo} 正在 ${busy.deliveryNo} 派送中，派送信息已变化，请重新确认改派。`,
            );
          }
          for (const old of toMove) {
            await tx.adminLastmileOrder.delete({ where: { id: old.id } });
          }
          if (toMove.length > 0) moved += 1;
          const shipmentRemark = toMove.length > 0
            ? `改派：从 ${[...new Set(toMove.map((row) => row.deliveryNo))].join("、")} 转到 ${deliveryNo}，${departRemark}`
            : departRemark;

          const id = `lm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const now = new Date();
          await tx.adminLastmileOrder.create({
            data: { id, companyId: auth.companyId, deliveryNo, shipmentId: sid, carrierName: "自营", driverName, licensePlate, phoneNumber, deliveryDate, externalTrackingNo: "", status },
          });
          // 同步运单状态 + 日志
          await tx.shipment.update({ where: { id: ownShipment.id }, data: { currentStatus: "outForDelivery", updatedAt: now } });
          await tx.statusLog.create({
            data: { id: `sl_lm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, companyId: auth.companyId, shipmentId: ownShipment.id, operatorId: auth.userId, operatorRole: auth.role, operatorName: auth.name ?? "", fromStatus: ownShipment.currentStatus, toStatus: "outForDelivery", remark: shipmentRemark, changedAt: now },
          });
          if (ownShipment.parentTrackingNo) {
            // ⚠️ 不能直接把父单写成 outForDelivery：分柜后可能只有一个子单出去派送，
            // 其余还在仓库。按全部子单重新推算（2026-08-22）。
            // ⚠️ 但**不在这里同步** —— 见上面锁序那段 ②，父单锁不能夹在子单锁中间。
            parentNosToSync.add(ownShipment.parentTrackingNo);
          }
          results.push({ id, shipmentId: sid });
        }
        // 子单全部处理完之后，父单按单号排序统一同步（跟柜子那条路同一个顺序）
        /**
         * ⚠️ 先按 **id** 把这批父单一次性锁完，再逐个同步（2026-08-29 补）。
         * 不能直接 `for (const no of [...nos].sort())` —— 那是按**运单号**排，
         * 而 lockShipmentsChildrenFirst 的父单层按 **id** 排，两把钥匙不一样，
         * 同一对父单从不同路径进来会锁反。测试库里 id 顺序和运单号顺序
         * 相反的父单对有 41 对。
         * 下面循环里 syncParentStatusFromChildren 内部还会再锁一次，
         * 同一事务重锁是免费的，不用去删。
         */
        await lockAndSyncParents(tx, [...parentNosToSync], auth.companyId, syncParentStatusFromChildren);
      },
      /**
       * ⚠️ 超时放宽到 30 秒（2026-08-31 复查 #17）。
       * 算号挪进这个事务后，2901 那把号码锁要握到整车运单全写完才放；
       * 第二个员工同时建单时，等锁的时间算在他自己事务的预算里 ——
       * Prisma 默认只给 5 秒，第一车票数多就会等超时报「服务器繁忙」。
       * 数值跟 containers/routes.ts 推进柜子状态那个事务保持一致。
       */
      { timeout: 30000, maxWait: 10000 });
    } catch (e: any) {
      /**
       * ⚠️ 共用的批量锁函数查不到运单时抛的是 ShipmentsNotFoundError，
       * 也要翻成 404（2026-08-29 补）—— 不翻的话会掉进下面的 500
       * 「服务器繁忙」，员工根本不知道是哪一票单号不对。
       */
      if (e instanceof ShipmentsNotFoundError) {
        fail(res, 404, "NOT_FOUND", e.message);
        return;
      }
      if (e instanceof LastmileShipmentNotFoundError) {
        fail(res, 404, "NOT_FOUND", e.message);
        return;
      }
      // 重复装同一票货（(delivery_no, shipment_id) 唯一）说人话，别把 Prisma 原文抛给员工
      // 注意：ApiCode 里没有 CONFLICT（只有 BAD_REQUEST/UNAUTHORIZED/FORBIDDEN/
      // NOT_FOUND/VALIDATION_ERROR/INTERNAL_ERROR），别顺手写 "CONFLICT" ——
      // 项目里已经有两处那么写、常年挂在 tsc 基线错误里了，不要再添一处
      if (e instanceof LastmileConflictError) {
        fail(res, 409, "VALIDATION_ERROR", e.message);
        return;
      }
      if (e?.code === "P2002") {
        fail(res, 409, "VALIDATION_ERROR", "选中的运单里有已经在这张派送单里的，请去掉后重试");
        return;
      }
      throw e;
    }
    ok(res, { deliveryNo, count: results.length, moved, skipped });
  });

  // 尾程派送状态更新
  app.post("/admin/lastmile/status", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "staff"]);
    if (!auth) return;
    const body = (req.body ?? {}) as { id?: string; status?: string; signImageBase64?: string };
    if (!body.id || !body.status) { fail(res, 400, "BAD_REQUEST", "id and status required"); return; }
    // 2026-08-31（排查 #33）：状态只认 DELIVERING / SIGNED 两个值。
    // 原来收到什么存什么，存进乱码状态会让签收单导出的状态判断失灵。
    // 页面只发 SIGNED，这里只挡直接调接口的。
    if (body.status !== "DELIVERING" && body.status !== "SIGNED") {
      fail(res, 400, "VALIDATION_ERROR", `状态不合法：${body.status}。只允许 DELIVERING（派送中）或 SIGNED（已签收）`);
      return;
    }
    const updateData: any = { status: body.status };
    if (body.signImageBase64) updateData.signImageBase64 = body.signImageBase64;
    const now = new Date();

    /**
     * ⚠️ 整个签收动作必须在**同一个事务**里（2026-08-25 改）。
     *
     * 原来是两段：先单独 `update` 派送单（状态 + 签收图立刻提交），
     * 再另开一个事务改运单、写轨迹、算父单。第二段失败就留下
     * **「派送单显示已签收、还有签收凭证，但运单还停在派送中」** ——
     * 员工看到货签收了，客户看到货还在路上，两边对不上而且没人会发现。
     *
     * 合成一个事务之后：要么全部生效，要么一个字都不写，派送单也不会单独变成已签收。
     *
     * ⚠️ 顺带补上 companyId 过滤 —— 原来只按 id 查，等于别家公司的派送单也能改。
     * 目前生产只有一家公司，暂时没影响，但接第二家之前必须是现在这样。
     */
    let updated: { id: string; status: string } | null = null;
    try {
      updated = await prisma.$transaction(async (tx) => {
      const own = await tx.adminLastmileOrder.findFirst({
        where: { id: body.id, companyId: auth.companyId },
        select: { id: true },
      });
      if (!own) return null;

      /**
       * ⚠️⚠️ **锁住派送单这一行，再复查一遍它现在是什么状态**（2026-08-29 补）。
       *
       * 原来这条路一把锁都没有。两个人同时点「签收」同一票货：
       * 第二个人的 UPDATE 会等第一个人提交，等到之后**照样往下走** ——
       * 因为它拿的是事务外那份「还没签收」的判断，结果
       *   · 客户轨迹里多出**两条一模一样的「已签收」**；
       *   · 后一张签收图**盖掉**前一张（司机拍的凭证就这么没了）。
       * 「锁只保证不同时，不保证数据没变」—— 所以锁完必须重查（CLAUDE.md 第 28 条）。
       *
       * 锁序统一成【派送单 → 运单 → 父单】，删除派送单那条路（下面）也是这个顺序。
       */
      await tx.$queryRaw`SELECT id FROM admin_lastmile_orders WHERE id = ${own.id} FOR UPDATE`;
      const fresh = await tx.adminLastmileOrder.findUnique({
        where: { id: own.id },
        select: { status: true },
      });
      if (!fresh) return null;
      // 拿**锁后**的状态判断，不是事务外那份
      const alreadySigned = fresh.status === "SIGNED";

      /**
       * ⚠️ 已签收的单不许改回派送中（2026-08-31 补，排查 #33）。
       *
       * 改回去的话：运单还停在「已到手」，两边对不上；而且这票货会被
       * 「不能重复派送」的检查当成正在派送，想再派一趟反而派不了。
       * 真要再派一趟是正常业务 —— 走「重新建派送单」那条路，不走这里。
       * 判断用的是锁后重读的状态（CLAUDE.md 第 28 条）。
       */
      if (alreadySigned && body.status === "DELIVERING") {
        throw new LastmileConflictError("这张派送单已经签收，不能改回派送中。要再派一趟请重新建一张派送单。");
      }

      const row = await tx.adminLastmileOrder.update({ where: { id: own.id }, data: updateData });
      if (body.status !== "SIGNED") return row;
      /**
       * 已经签收过了就到此为止：派送单本身该改的（比如重新上传一张更清楚的签收图）
       * 上面那句 update 已经改完，但**运单状态和轨迹一个字都不再动** ——
       * 再走一遍就是那条重复的「已签收」。
       */
      if (alreadySigned) return row;

      {
        const updated = row;
        // 锁住运单再读，不然读到的 currentStatus 可能是别人正在改的旧值，
        // 写进轨迹的 fromStatus 就是错的
        await tx.$queryRaw`SELECT id FROM shipments WHERE id = ${updated.shipmentId} FOR UPDATE`;
        const shipment = await tx.shipment.findUnique({ where: { id: updated.shipmentId }, select: { id: true, currentStatus: true, parentTrackingNo: true } });
        if (shipment) {
          await tx.shipment.update({ where: { id: shipment.id }, data: { currentStatus: "delivered", updatedAt: now } });
          await tx.statusLog.create({
            data: {
              id: `sl_lm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              companyId: auth.companyId, shipmentId: shipment.id,
              operatorId: auth.userId, operatorRole: auth.role, operatorName: auth.name ?? "",
              fromStatus: shipment.currentStatus, toStatus: "delivered",
              remark: `尾程派送已签收（${updated.deliveryNo ?? updated.id}）`,
              changedAt: now,
            },
          });
          // 同步父运单
          if (shipment.parentTrackingNo) {
            // ⚠️⚠️ 这里原来是「任何一个子单签收 → 父单直接写成已签收」。
            // 生产实测造成 7 张父单显示「已签收」，子单却还在「已到仓」——
            // 客户订单列表看到已签收、点开轨迹却看到货在仓库。改成按全部子单推算：
            // **全部子单都签收了，父单才签收**（2026-08-22）。
            await syncParentStatusFromChildren(tx, shipment.parentTrackingNo, auth.companyId);
          }
        }
      }
      return row;
      });
    } catch (e) {
      // 事务里抛出来的「已签收不能改回」要说人话，别掉进 500「服务器繁忙」
      // （ApiCode 里没有 CONFLICT，同建单接口一样用 VALIDATION_ERROR，2026-08-31）
      if (e instanceof LastmileConflictError) {
        fail(res, 409, "VALIDATION_ERROR", e.message);
        return;
      }
      throw e;
    }

    if (!updated) { fail(res, 404, "NOT_FOUND", "派送单不存在"); return; }
    ok(res, { id: updated.id, status: updated.status });
  });

  // 删除派送单
  app.delete("/admin/lastmile/orders", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const id = req.query.id as string;
    if (!id) { fail(res, 400, "BAD_REQUEST", "id required"); return; }

    // 2026-08-06：原来只 deleteMany 一行就完事，**运单状态留在「派送中」没人管** ——
    // 派送单没了、运单却还显示派送中，尾端派送列表里也挑不到它（那个列表只看已到仓/派送中/已签收
    // 里能对上派送单的），等于这票货从流程里消失。生产实测 YW0001244 就是这么卡了将近一个月。
    // 现在：删记录的同时把运单退回「已到仓」，并写一条状态轨迹说明原因。
    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      /**
       * ⚠️ 锁序【派送单 → 运单 → 父单】，跟上面「签收」那条路一致（2026-08-29 补）。
       * 原来这条路也是一把锁都没有：删单和签收同时点，
       * 删这边读到的运单状态可能是签收之前的旧值，于是把已经签收的货
       * 退回「已到仓」—— 那是把对的改错。
       */
      await tx.$queryRaw`SELECT id FROM admin_lastmile_orders WHERE id = ${id} AND company_id = ${auth.companyId} FOR UPDATE`;
      const row = await tx.adminLastmileOrder.findFirst({
        where: { id, companyId: auth.companyId },
        select: { id: true, shipmentId: true, deliveryNo: true },
      });
      if (!row) return { deleted: false, reverted: false };

      await tx.adminLastmileOrder.delete({ where: { id: row.id } });

      await tx.$queryRaw`SELECT id FROM shipments WHERE id = ${row.shipmentId} FOR UPDATE`;
      const ship = await tx.shipment.findUnique({
        where: { id: row.shipmentId },
        select: { id: true, currentStatus: true, parentTrackingNo: true },
      });
      // 只在「还在派送中」时退回。已经签收的不动 —— 货都签收了，不该因为删一张单就变回没送。
      if (!ship || ship.currentStatus !== "outForDelivery") return { deleted: true, reverted: false };

      /**
       * ⚠️ 这票货可能还在**别的**派送单里派着（2026-08-25 新增）。
       *
       * 历史数据里有 4 票货同时进了两张派送单。删掉其中一张就把运单退回「已到仓」，
       * 可另一张还在「派送中」—— 员工看着车已经出去了，系统却说货在仓库。
       * 上面新加的拦截能防止以后再出现，但**存量数据还在**，所以删除这边也得防一手。
       */
      const stillOut = await tx.adminLastmileOrder.findFirst({
        where: { shipmentId: ship.id, companyId: auth.companyId, status: "DELIVERING" },
        select: { deliveryNo: true },
      });
      if (stillOut) return { deleted: true, reverted: false, stillIn: stillOut.deliveryNo };

      await tx.shipment.update({ where: { id: ship.id }, data: { currentStatus: "inWarehouseTH", updatedAt: now } });
      await tx.statusLog.create({
        data: {
          id: `sl_lmdel_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          companyId: auth.companyId, shipmentId: ship.id,
          operatorId: auth.userId, operatorRole: auth.role, operatorName: auth.name ?? "",
          fromStatus: "outForDelivery", toStatus: "inWarehouseTH",
          remark: `删除派送单（${row.deliveryNo}），退回已到仓`, changedAt: now,
        },
      });

      // 父单按全部子单重新推算（2026-08-22 统一成 syncParentStatusFromChildren）。
      //
      // 这里原来自己写了一套「名下没有其他派送中/已签收的子单才退回」的判断 ——
      // 方向是对的（比另外两处强），但只处理 outForDelivery → inWarehouseTH 这一种情形，
      // 其余情形照样会把父单留在错误状态上。四个改父单状态的地方共用同一个函数，
      // 才不会下次又有人只改其中一处。
      if (ship.parentTrackingNo) {
        await syncParentStatusFromChildren(tx, ship.parentTrackingNo, auth.companyId);
      }
      return { deleted: true, reverted: true };
    });

    if (!result.deleted) { fail(res, 404, "NOT_FOUND", "派送单不存在"); return; }
    ok(res, {
      deleted: true,
      reverted: result.reverted,
      // 这票货还在别的派送单里，所以没退回「已到仓」—— 说清楚，别让员工以为没生效
      message: (result as any).stillIn
        ? `已删除。这票货还在派送单 ${(result as any).stillIn} 里派送中，所以运单状态保持「派送中」。`
        : undefined,
    });
  });

  /**
   * 「一个柜收了客户多少钱」（2026-08-27 重做）。
   *
   * 这个接口以前是「结算与利润」：管理员手工填客户应收 − 供应商应付 − 税费 = 利润。
   * 生产实测：1063 张订单里 0 张录过应收、结算表 0 行 —— 从上线到现在完全没人用，
   * 因为它是按「每张运单算钱」设计的，而老板的口径是**运单跟钱无关**。
   *
   * 老板 2026-08-27 定的新口径：**不用算利润，就是这条柜收客户多少钱。**
   *
   * 「一个柜」在两个集货版本里分别是：
   *   - 普通版：一个 ConsolidationTask（JH…），一个任务一个客户，默认 68 方
   *   - 仓库版：一个 WhrConsolidationPlan（WHR…），一个计划一个柜，底下挂多个客户，
   *             每个客户挂多张预报单，钱按 预报单 → 客户 → 柜 逐层汇总
   *
   * ⚠️ 已取消的单不计入任何金额（黑名单判断，见 CLAUDE.md 第 13 条）。
   */
  app.get("/admin/settlement/by-container", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const num = (v: any) => (v == null ? 0 : Number(v.toString()));

    const [plans, tasks] = await Promise.all([
      prisma.whrConsolidationPlan.findMany({
        where: { companyId: auth.companyId },
        select: {
          planNo: true, containerType: true, status: true, createdAt: true,
          customers: {
            select: {
              clientId: true,
              client: { select: { name: true } },
              prealerts: { select: { trackingNo: true, mark: true, status: true, totalFee: true } },
            },
          },
        },
      }),
      prisma.consolidationTask.findMany({
        where: { companyId: auth.companyId },
        select: {
          taskNo: true, status: true, paymentStatus: true, totalFee: true,
          containerNo: true, createdAt: true,
          // ⚠️ 单数不能写死 1：生产实测 JH0000001 底下有 2 张预报单
          _count: { select: { prealerts: true } },
          client: { select: { id: true, name: true } },
        },
      }),
    ]);

    /**
     * ⚠️ `quotedCount` 和 `orderCount` 不是一回事（2026-08-27 修）：
     *   orderCount  = 名下有几张单
     *   quotedCount = 其中**真报过价**的有几张（totalFee 不为 null）
     * 只看 orderCount 会把「有单但一张都没报价」显示成 ¥0.00，
     * 跟「报价就是 0 元」混在一起 —— 那是两回事。
     */
    type Customer = { name: string; received: number; receivable: number; notYet: number; orderCount: number; quotedCount: number };
    type Row = {
      kind: "normal" | "warehouse";
      kindLabel: string;
      no: string;
      containerType: string;
      status: string;
      customerCount: number;
      orderCount: number;
      /** 名下真报过价的单数；0 = 一张都没报价，金额要显示「—」不是「¥0.00」 */
      quotedCount: number;
      received: number;
      receivable: number;
      notYet: number;
      total: number;
      createdAt: string;
      customers: Customer[];
    };

    const rows: Row[] = [];

    for (const pl of plans) {
      // ⚠️ 已取消的柜整个跳过：不进柜子数，也不进任何金额
      if (isDead(pl.status)) continue;
      const customers: Customer[] = [];
      let received = 0, receivable = 0, notYet = 0, orderCount = 0, quotedTotal = 0;
      for (const c of pl.customers) {
        let cr = 0, cv = 0, cn0 = 0, cn = 0, quoted = 0;
        for (const pa of c.prealerts) {
          const b = whrBucket(pa.status);
          if (b === "dead") continue;
          const amt = num(pa.totalFee);
          cn++;
          if (pa.totalFee != null) quoted++;
          // ⚠️「等收货」的钱不算待收 —— 货还没到仓，报的价只是预估，不该去催
          if (b === "received") cr += amt;
          else if (b === "receivable") cv += amt;
          else cn0 += amt;
        }
        received += cr; receivable += cv; notYet += cn0; orderCount += cn; quotedTotal += quoted;
        customers.push({
          name: c.client?.name || c.clientId,
          received: Math.round(cr * 100) / 100,
          receivable: Math.round(cv * 100) / 100,
          notYet: Math.round(cn0 * 100) / 100,
          orderCount: cn,
          quotedCount: quoted,
        });
      }
      rows.push({
        kind: "warehouse", kindLabel: "仓库版", no: pl.planNo,
        containerType: pl.containerType, status: pl.status,
        customerCount: pl.customers.length, orderCount, quotedCount: quotedTotal,
        received: Math.round(received * 100) / 100,
        receivable: Math.round(receivable * 100) / 100,
        notYet: Math.round(notYet * 100) / 100,
        total: Math.round((received + receivable + notYet) * 100) / 100,
        createdAt: pl.createdAt.toISOString(),
        customers,
      });
    }

    for (const t of tasks) {
      const b = taskBucket(t.status, t.paymentStatus, t.totalFee != null);
      if (b === "dead") continue;
      const amt = num(t.totalFee);
      const name = t.client?.name || t.client?.id || "—";
      const quoted = t.totalFee != null ? 1 : 0;
      const one = {
        name,
        received: b === "received" ? amt : 0,
        receivable: b === "receivable" ? amt : 0,
        notYet: b === "notYet" ? amt : 0,
        orderCount: t._count.prealerts,
        quotedCount: quoted,
      };
      rows.push({
        kind: "normal", kindLabel: "普通版", no: t.taskNo,
        // 普通版没有柜型字段；柜号是员工可选手填的
        containerType: t.containerNo || "—",
        status: t.status,
        // 普通版一个任务就是一个客户；单数用真实的预报单条数，不能写死 1
        customerCount: 1, orderCount: t._count.prealerts, quotedCount: quoted,
        received: one.received, receivable: one.receivable, notYet: one.notYet,
        total: amt,
        createdAt: t.createdAt.toISOString(),
        customers: [one],
      });
    }

    rows.sort((a, b) => b.total - a.total || b.createdAt.localeCompare(a.createdAt));

    ok(res, {
      totalReceived: Math.round(rows.reduce((s, r) => s + r.received, 0) * 100) / 100,
      totalReceivable: Math.round(rows.reduce((s, r) => s + r.receivable, 0) * 100) / 100,
      totalNotYet: Math.round(rows.reduce((s, r) => s + r.notYet, 0) * 100) / 100,
      containerCount: rows.length,
      rows,
    });
  });

  /* 2026-08-31 Codex 二轮：这里原来还有三条「按运单结算」的遗留接口，整块删掉：
       GET  /admin/settlement/entries   查每张运单的应收/应付/税费
       POST /admin/settlement/entries   给任意 orderId 写应收/应付/税费
       GET  /admin/settlement/profit    按运单算利润
     删的原因三条：
       ① POST 不校验 orderId 属于本公司，还能给普通运单写钱 —— 直接违反
          「钱只在两个集货功能里」的口径（老板 2026-08-27 拍板，见上面 by-container 的注释）
       ② 前端三个包装函数（fetchAdminSettlementEntries / createAdminSettlementEntry /
          fetchAdminProfitAnalysis）已确认零调用，另一路一并删掉了
       ③ 结算表生产上 0 行，从上线到现在没人用过
     结算表本身（admin_settlement_entries）没动；要恢复走 git 历史。 */

  app.get("/admin/ops/overview", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    /* 2026-08-27：这里原来每次都查结算表算「总收入/总成本/总利润/毛利率」和最近 7 条利润趋势，
       整块删掉。原因三条：
         ① 管理员首页那块「毛利率趋势」UI 已经删了，**前端一个字段都不消费**
         ② 老板口径：运单跟钱无关，钱只在集货那两个功能里 —— 按运单算利润这套方向就不对
         ③ 首页每 10 秒轮询一次这个接口，等于每 10 秒白查一遍结算表
       结算表本身（admin_settlement_entries）没动，生产上也是 0 行。 */

    const customsRows = await prisma.adminCustomsCase.findMany({
      where: { companyId: auth.companyId, status: { in: ["inspection", "pending"] } },
      orderBy: { updatedAt: "desc" },
      take: 20,
    });

    const lmpRows = await prisma.adminLmpRate.findMany({
      where: { companyId: auth.companyId },
      orderBy: [{ routeCode: "asc" }, { supplierName: "asc" }, { updatedAt: "desc" }],
    });
    type RateSnapshot = {
      routeCode: string;
      supplierName: string;
      transportMode: string;
      seasonTag: string;
      currency: string;
      quotePrice: number;
      updatedAt: string;
    };
    const latestByKey = new Map<string, RateSnapshot>();
    const previousByKey = new Map<string, RateSnapshot>();
    lmpRows.forEach((item) => {
      // 同一路线和供应商也可能同时有海/陆运、不同季节和不同币种报价；
      // 这些维度不相同时不能互相比较，否则会制造假涨价/假降价提醒。
      const key = JSON.stringify([
        item.routeCode,
        item.supplierName,
        item.transportMode,
        item.seasonTag,
        item.currency,
      ]);
      const snapshot: RateSnapshot = {
        routeCode: item.routeCode,
        supplierName: item.supplierName,
        transportMode: item.transportMode,
        seasonTag: item.seasonTag,
        currency: item.currency,
        quotePrice: decToNumber(item.quotePrice),
        updatedAt: item.updatedAt.toISOString(),
      };
      if (!latestByKey.has(key)) {
        latestByKey.set(key, snapshot);
      } else if (!previousByKey.has(key)) {
        previousByKey.set(key, snapshot);
      }
    });
    const supplierPriceAlerts = Array.from(latestByKey.entries())
      .map(([key, latest]) => {
        const previous = previousByKey.get(key);
        if (!previous) return null;
        const delta = Number((latest.quotePrice - previous.quotePrice).toFixed(2));
        if (Math.abs(delta) < 0.01) return null;
        return {
          routeCode: latest.routeCode,
          supplierName: latest.supplierName,
          transportMode: latest.transportMode,
          seasonTag: latest.seasonTag,
          currency: latest.currency,
          previousQuotePrice: previous.quotePrice,
          latestQuotePrice: latest.quotePrice,
          delta,
          updatedAt: latest.updatedAt,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .slice(0, 10);

    const customsShipmentIds = [...new Set(customsRows.map((r) => r.shipmentId).filter((v): v is string => Boolean(v)))];
    const customsOrders = await prisma.shipment.findMany({ where: { id: { in: customsShipmentIds }, companyId: auth.companyId }, select: { id: true, trackingNo: true, orderId: true } });
    const trackingNoByShipmentId = new Map(customsOrders.map((s) => [s.id, s.trackingNo]));

    ok(res, {
      customsAlerts: customsRows.map((item) => ({
        id: item.id,
        shipmentId: item.shipmentId ?? undefined,
        shipmentTrackingNo: item.shipmentId ? (trackingNoByShipmentId.get(item.shipmentId) ?? null) : null,
        orderId: item.orderId ?? undefined,
        status: item.status,
        remark: item.remark ?? undefined,
        updatedAt: item.updatedAt.toISOString(),
      })),
      supplierPriceAlerts,
    });
  });
}
