import type { Prisma } from "@prisma/client";

/**
 * 员工新建一票货时要写进库的四样东西：订单、运单、第一条轨迹、产品行。
 *
 * 2026-10-06 从 POST /staff/orders（员工端「创建订单」）里抽出来：「到货通知」转运单也走这一份
 * （老板拍板：转正式运单的标准跟「创建订单」一样），两条路写出来的订单 / 运单 / 轨迹一个样，
 * 以后改一处两边一起变，不会出现「到货通知转的单少一个字段」。
 *
 * 这里只管「按已经校验好的值拼出要写的数据」，不碰数据库、不做校验 ——
 * 校验各走各的（创建订单那边全必填；到货通知转待入库时只有唛头 + 运单号是必填）。
 */

export interface NewOrderProductRow {
  itemName: string;
  packageCount: number;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  productQuantity: number | null;
  cargoType: string;
  domesticTrackingNo: string;
  weightKg: number | null;
  sortOrder: number;
}

export interface NewOrderInput {
  companyId: string;
  operator: { userId: string; role: string; name: string };
  orderId: string;
  shipmentId: string;
  clientId: string;
  warehouseId: string;
  trackingNo: string;
  transportMode: string;
  /** 订单上的品名（有产品行时通常是第一行的品名） */
  itemName: string;
  productQuantity: number;
  packageCount: number;
  packageUnit: string;
  /** 已经按产品行汇总 / 取员工填的那个，最后要写进库的值 */
  weightKg: number | null;
  volumeM3: number | null;
  /** 到仓日期原文 YYYY-MM-DD（订单 ship_date 一直存的就是它） */
  shipDate: string | null;
  domesticTrackingNo: string | null;
  cargoType: string;
  batchNo: string | null;
  remark: string | null;
  products: NewOrderProductRow[];
  /**
   * 运单起始状态：
   *   inWarehouseCN 已入库 —— 员工「创建订单」、到货通知「转正式运单」；
   *   pendingInbound 待入库 —— 到货通知「转待入库」（货到了、资料没补全，2026-10-06）。
   */
  initialStatus: "inWarehouseCN" | "pendingInbound";
  /** 轨迹时间（一般就是现在） */
  now: Date;
}

export interface NewOrderRows {
  order: Prisma.OrderUncheckedCreateInput;
  shipment: Prisma.ShipmentUncheckedCreateInput;
  statusLog: Prisma.StatusLogUncheckedCreateInput;
  products: Prisma.OrderProductCreateManyInput[];
}

/** 第一条轨迹说的话：按起始状态分两种 */
const FIRST_TRACK: Record<NewOrderInput["initialStatus"], { remark: string; nextStop: string }> = {
  /* 2026-09-02 老板拍板落地：员工建单=货已到仓，运单直接从「已入库」起步，
     首条轨迹写 created → inWarehouseCN，客户一眼看到货已进仓。
     录单那一刻货已经在仓里，下一站是「装柜」（跟确认收货那条轨迹同一口径）。
     ⚠️ 客户报预报单那条路（remark「等待国内仓收货」那处）仍是 created → created、
     下一站「国内仓」—— 那时货还在路上，是对的，别顺手改。 */
  inWarehouseCN: { remark: "货已到国内仓，等待装柜", nextStop: "装柜" },
  /* 2026-10-06 到货通知「转待入库」：货已经在仓里，只是资料还没补全；客户在轨迹里看得到这一条（老板选 3B） */
  pendingInbound: { remark: "货已到国内仓，资料待补全", nextStop: "入库" },
};

export function buildNewOrderRows(input: NewOrderInput): NewOrderRows {
  const track = FIRST_TRACK[input.initialStatus];
  const weight = input.weightKg as unknown as Prisma.Decimal | null;
  const volume = input.volumeM3 as unknown as Prisma.Decimal | null;
  return {
    order: {
      id: input.orderId,
      companyId: input.companyId,
      clientId: input.clientId,
      warehouseId: input.warehouseId,
      batchNo: input.batchNo,
      orderNo: null,
      approvalStatus: "approved",
      itemName: input.itemName,
      productQuantity: input.productQuantity,
      packageCount: input.packageCount,
      packageUnit: input.packageUnit,
      weightKg: weight,
      volumeM3: volume,
      receivableCurrency: "CNY",
      shipDate: input.shipDate,
      domesticTrackingNo: input.domesticTrackingNo,
      transportMode: input.transportMode,
      cargoType: input.cargoType,
      receiverNameTh: "",
      receiverPhoneTh: "",
      receiverAddressTh: "",
      statusGroup: "unfinished",
    },
    shipment: {
      id: input.shipmentId,
      companyId: input.companyId,
      orderId: input.orderId,
      trackingNo: input.trackingNo,
      batchNo: input.batchNo,
      /* 2026-09-02 老板拍板：录单就是货到了仓库才录单 ——
         员工建单的运单起始状态直接是「已入库」，不是「已创建」。
         （客户预报那条路不一样：报单时货还在路上，仍从 created 起。）
         2026-10-06：到货通知转待入库的从「待入库」起。 */
      currentStatus: input.initialStatus,
      currentLocation: null,
      weightKg: weight,
      volumeM3: volume,
      packageCount: input.packageCount,
      packageUnit: input.packageUnit,
      transportMode: input.transportMode,
      domesticTrackingNo: input.domesticTrackingNo,
      warehouseId: input.warehouseId,
      remark: input.remark,
    },
    // 2026-08-06：轨迹起点。员工直接建单的这条路原来也不写轨迹，
    // 和客户预报那条路一样，客户查件最早只能看到「已装柜」。
    statusLog: {
      id: `sl_new_${input.now.getTime()}_${Math.random().toString(36).slice(2, 6)}`,
      companyId: input.companyId,
      shipmentId: input.shipmentId,
      operatorId: input.operator.userId,
      operatorRole: input.operator.role,
      operatorName: input.operator.name,
      fromStatus: "created",
      toStatus: input.initialStatus,
      remark: track.remark,
      nextStop: track.nextStop,
      changedAt: input.now,
    },
    products: input.products.map((p) => ({
      companyId: input.companyId,
      orderId: input.orderId,
      itemName: p.itemName,
      packageCount: p.packageCount,
      lengthCm: p.lengthCm,
      widthCm: p.widthCm,
      heightCm: p.heightCm,
      productQuantity: p.productQuantity,
      cargoType: p.cargoType,
      domesticTrackingNo: p.domesticTrackingNo,
      weightKg: p.weightKg,
      sortOrder: p.sortOrder,
    })),
  };
}
