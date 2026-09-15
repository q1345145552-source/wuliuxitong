import { DECIMAL_10_2, DECIMAL_10_6, requireDecimal, requireDerivedWithinDecimal } from "../core/decimal-guard";
import { parseNumericStrict, requirePositiveInt, requireProductWithinInt } from "../core/int-guard";
import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { InsufficientBalanceError, PaymentConflictError, chargeForConsolidation } from "../wallet/consolidation-balance";
import { lockPlanAliveById, lockPlanAliveByPrealert, lockPrealertExpecting, PlanCancelledError, PlanMissingError } from "./plan-guard";
import { saveImageToDisk, deleteImageFile } from "../orders/image-storage";
import { BusinessError } from "../core/business-error";
import { hideOperatorInRemark } from "../core/operator-visibility";
import {
  ACTIVE_PREALERT_WHERE,
  EDITABLE_PREALERT_STATUS,
  buildFeeBreakdown,
  buildPaidSnapshot,
  calcItemVolumeM3,
  deriveLatestStatus,
  mergeFeeBreakdowns,
  recalcCustomerTotals,
  recalcPrealertFee,
  round3,
  sumPlanUsedVolume,
  toNum,
} from "./utils";

/** 单张图片 base64 上限（约 8MB 原图），整个请求体上限由 server.ts 控制在 20MB */
const MAX_IMAGE_BASE64_LENGTH = 8 * 1024 * 1024;
/** 一张预报单最多的货品行数，防止误操作打爆事务 */
const MAX_ITEMS_PER_PREALERT = 200;
/** 一次最多上传的付款凭证张数 */
const MAX_PAYMENT_PROOFS = 10;

function isValidBase64(s: unknown): s is string {
  return typeof s === "string" && s.trim().length > 0 && /^[A-Za-z0-9+/=\s]+$/.test(s.trim());
}

export function registerWhrConsolidationClientRoutes(app: MinimalHttpApp): void {
  // =======================================================================
  // 1. 查看我被选中的拼柜计划（预报单级别汇总）
  // =======================================================================
  app.get("/client/whr-consolidation/plans", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const myCustomers = await prisma.whrConsolidationPlanCustomer.findMany({
      where: { clientId: auth.userId, companyId: auth.companyId },
      include: {
        plan: true,
        prealerts: { select: { status: true, totalFee: true }, orderBy: { createdAt: "desc" } },
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    });

    /**
     * 有没有长期价（2026-09-16，确认单 4.5 / 4.19）：没有就在页顶提示「暂未配对价格，请联系管理员」。
     * 只回一个布尔，价格本身不从这里给（柜里那一行的单价照旧在 items 里）。
     */
    const priceRow = await prisma.clientWhrPrice.findFirst({
      where: { clientId: auth.userId, companyId: auth.companyId },
      select: { clientId: true },
    });
    const hasLongTermPrice = priceRow !== null;

    if (myCustomers.length === 0) {
      ok(res, { items: [], hasLongTermPrice });
      return;
    }

    // 计划已用方数：汇总同计划下所有客户，且排除已取消的预报单
    const planIds = Array.from(new Set(myCustomers.map((c) => c.planId)));
    const volumeMap = new Map<string, number>();
    for (const planId of planIds) {
      volumeMap.set(planId, await sumPlanUsedVolume(planId));
    }

    ok(res, {
      hasLongTermPrice,
      items: myCustomers.map((c) => {
        const activePrealerts = c.prealerts.filter((pa) => pa.status !== "cancelled");
        // 我的费用：只统计未取消的预报单
        const myTotalFee = activePrealerts.reduce((s, pa) => s + toNum(pa.totalFee), 0);
        return {
          planId: c.planId,
          planNo: c.plan.planNo,
          warehouse: c.plan.warehouse,
          containerType: c.plan.containerType,
          destinationTh: c.plan.destinationTh,
          totalVolumeM3: toNum(c.plan.totalVolumeM3),
          usedVolumeM3: volumeMap.get(c.planId) ?? 0,
          myTotalVolumeM3: toNum(c.totalVolumeM3),
          myTotalFee: activePrealerts.length > 0 ? Math.round(myTotalFee * 100) / 100 : null,
          myUnitPriceNormal: toNum(c.unitPriceNormal),
          myUnitPriceInspection: toNum(c.unitPriceInspection),
          myUnitPriceSensitive: toNum(c.unitPriceSensitive),
          prealertCount: activePrealerts.length,
          cancelledCount: c.prealerts.length - activePrealerts.length,
          latestStatus: deriveLatestStatus(c.prealerts.map((pa) => pa.status)),
          deliveryAddress: c.deliveryAddress,
          createdAt: c.plan.createdAt.toISOString(),
        };
      }),
    });
  });

  // =======================================================================
  // 2. 创建预报单
  // =======================================================================
  app.post("/client/whr-consolidation/prealerts", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { planId?: string; expressNo?: string; mark?: string };
    if (!body.planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }
    if (!body.mark?.trim()) {
      fail(res, 400, "BAD_REQUEST", "唛头为必填");
      return;
    }

    const customer = await prisma.whrConsolidationPlanCustomer.findFirst({
      where: { planId: body.planId, clientId: auth.userId, companyId: auth.companyId },
      include: { plan: { select: { status: true } } },
    });
    if (!customer) {
      fail(res, 403, "FORBIDDEN", "您不在该拼柜计划中");
      return;
    }
    if (customer.plan.status === "completed" || customer.plan.status === "cancelled") {
      fail(res, 400, "BAD_REQUEST", "该拼柜计划已结束，无法创建预报单");
      return;
    }
    // 收货地址必填：尾端拆派要用，没有地址的货到了泰国没法派送
    if (!customer.deliveryAddress?.trim()) {
      fail(res, 400, "BAD_REQUEST", "请先填写泰国收货地址，再创建预报单");
      return;
    }

    const prealert = await prisma.$transaction(async (tx) => {
      /**
       * ⚠️ 先锁住这个柜，确认它还活着（2026-08-27 补）。
       * 上面「计划已结束就拦」在事务外面：管理员正好在这一刻取消/结束了这个柜，
       * 客户这张新单还是会建进去 —— 建进一个已经作废的柜里，
       * 之后既收不了钱也发不了货，还会被管理员删柜时连带清掉。
       * 锁序照旧【计划 → 预报单 → 钱包】，所以这句必须排在最前面。
       */
      await lockPlanAliveById(tx, customer.planId);
      const planNow = await tx.whrConsolidationPlan.findUnique({
        where: { id: customer.planId },
        select: { status: true },
      });
      if (planNow?.status === "completed") {
        throw new BusinessError("该拼柜计划已结束，无法创建预报单");
      }
      // 锁住计划之后再确认自己还在这个柜里（2026-09-15，Codex 审查 O1 配套）：管理员「移除客户」也先锁计划，
      // 他那边先删掉的话，这里不许再往一条已经没了的客户记录上挂单（不查就撞外键，客户看到「服务器繁忙」）
      const stillIn = await tx.whrConsolidationPlanCustomer.findFirst({
        where: { id: customer.id, planId: customer.planId, companyId: auth.companyId },
        select: { id: true },
      });
      if (!stillIn) {
        throw new BusinessError("您已不在该拼柜计划中，请刷新页面后再看", 403, "FORBIDDEN");
      }

      // 咨询锁 + 插入必须在同一个事务里，锁才真正护住「取最大值 → 插入」这段
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(83011)`;
      // 按数值取最大，避免字符串排序在位数变化后算错（"WHRP10000" < "WHRP9999"）
      const rows = await tx.$queryRaw<{ maxno: bigint | number | null }[]>`
        SELECT MAX(CAST(SUBSTRING(tracking_no FROM 5) AS BIGINT)) AS maxno
        FROM whr_consolidation_prealerts
        WHERE tracking_no ~ '^WHRP[0-9]+$'
      `;
      const nextNum = Number(rows?.[0]?.maxno ?? 0) + 1;
      const trackingNo = `WHRP${String(nextNum).padStart(4, "0")}`;

      const created = await tx.whrConsolidationPrealert.create({
        data: {
          customerId: customer.id,
          companyId: auth.companyId,
          trackingNo,
          expressNo: body.expressNo?.trim() || null,
          mark: body.mark!.trim(),
          status: "pending",
        },
      });
      // totalPrealerts 交给统一重算，避免只增不减
      await recalcCustomerTotals(customer.id, tx);
      return created;
    });

    ok(res, {
      id: prealert.id,
      trackingNo: prealert.trackingNo,
      mark: prealert.mark,
      status: prealert.status,
    });
  });

  // =======================================================================
  // 3. 编辑货品（覆盖式更新 + 重算方数/费用）
  // =======================================================================
  app.post("/client/whr-consolidation/prealerts/items", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      prealertId?: string;
      items?: {
        productName?: string;
        packageCount?: number;
        quantityPerBox?: number;
        lengthCm?: number;
        widthCm?: number;
        heightCm?: number;
        unitWeightKg?: number;
        material?: string;
        cargoValue?: string;
        cargoType?: string;
        imageFileName?: string;
        imageMime?: string;
        imageBase64?: string;
        /** 保留原有图片：把详情接口返回的 productImageBase64（其实是 /images/xxx 路径）原样回传 */
        existingImagePath?: string;
      }[];
    };

    if (!body.prealertId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "prealertId 为必填");
      return;
    }
    // items 允许为空数组 —— 代表「清空该预报单的货品」（删掉最后一件时会走到这里）
    const items = Array.isArray(body.items) ? body.items : null;
    if (!items) {
      fail(res, 400, "BAD_REQUEST", "items 必须是数组");
      return;
    }
    if (items.length > MAX_ITEMS_PER_PREALERT) {
      fail(res, 400, "BAD_REQUEST", `货品行数不能超过 ${MAX_ITEMS_PER_PREALERT} 行`);
      return;
    }

    // 注意：Prisma 不允许同一层同时写 select 和 include，这里统一用 include
    const prealert = await prisma.whrConsolidationPrealert.findFirst({
      where: { id: body.prealertId, companyId: auth.companyId },
      include: {
        items: { select: { id: true, productImageBase64: true } },
        planCustomer: {
          include: {
            plan: { select: { id: true, status: true, totalVolumeM3: true } },
          },
        },
      },
    });

    if (!prealert || prealert.planCustomer.clientId !== auth.userId) {
      fail(res, 403, "FORBIDDEN", "无权操作该预报单");
      return;
    }
    // 状态校验：只有待签收的预报单客户才能改货品
    if (prealert.status !== EDITABLE_PREALERT_STATUS) {
      fail(res, 400, "BAD_REQUEST", "该预报单已签收，货品不可再修改，如需变更请联系客服");
      return;
    }
    const plan = prealert.planCustomer.plan;
    if (plan.status === "completed" || plan.status === "cancelled") {
      fail(res, 400, "BAD_REQUEST", "该拼柜计划已结束，无法修改货品");
      return;
    }

    // ---- 逐行校验 ----
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const row = i + 1;
      if (!it.productName?.trim()) {
        fail(res, 400, "BAD_REQUEST", `第 ${row} 行品名为必填`);
        return;
      }
      /**
       * ⚠️ 原来这里只判「是有限数字且 > 0」（2026-08-29 第八轮收紧）。
       * 复核实测 **2.5 箱 / 每箱 2.5 个 / 超过 32 位上限**全都能穿过去。
       * 这三个字段在 schema 里都是 `Int`：
       *   WhrConsolidationPrealertItem.packageCount / quantityPerBox / totalQuantity
       * 而且这条路的方数要拿去按「**方数 × 单价**」收费 ——
       * 小数不会报错，只会让方数和金额悄悄算错，比报 500 更难发现。
       */
      // ⚠️ parseNumericStrict 而不是 Number（2026-08-29 第十轮补）：
      //    Number(true) 是 1、Number([5]) 是 5 —— 复核实测传
      //    {packageCount: true, quantityPerBox: [5], unitWeightKg: true}
      //    这个接口返回 200，准备写「1 件 / 每箱 5 个 / 单重 1kg」。
      //    这些数字要参与方数和收费，所以 Number() 这一步就是钱的漏口。
      const pkg = parseNumericStrict(it.packageCount);
      const pkgIssue = requirePositiveInt(pkg, `第 ${row} 行件数`);
      if (pkgIssue) {
        fail(res, 400, "BAD_REQUEST", pkgIssue);
        return;
      }
      const qpb = it.quantityPerBox == null ? 1 : parseNumericStrict(it.quantityPerBox);
      const qpbIssue = requirePositiveInt(qpb, `第 ${row} 行每箱数量`);
      if (qpbIssue) {
        fail(res, 400, "BAD_REQUEST", qpbIssue);
        return;
      }
      // totalQuantity = 件数 × 每箱数量，也是 Int，两个因子各自合法乘起来照样能爆
      const totalIssue = requireProductWithinInt(pkg, qpb, `第 ${row} 行总数量`);
      if (totalIssue) {
        fail(res, 400, "BAD_REQUEST", totalIssue);
        return;
      }
      // 长宽高必填：缺了方数算不出来，签收时会按 0 方计费
      const dims: Array<[string, unknown]> = [
        ["长", it.lengthCm],
        ["宽", it.widthCm],
        ["高", it.heightCm],
      ];
      /**
       * ⚠️ 长宽高（2026-08-29 收紧）：原来只判「大于 0」，**不限小数位**。
       * 库里是 `Decimal(10,2)` —— 客户填 12.345，**存进去变成 12.35**，
       * 而页面是按 12.345 算的方数。两个数对不上，
       * 客户拿计算器照着单据上的尺寸算方数永远算不出单据上的方数。
       * 复核实测：¥850/方 的柜子上这个差价是 **¥5.10**。
       * 这条路按「方数 × 单价」收费，所以它是钱的问题，不是显示问题。
       */
      for (const [label, val] of dims) {
        const dimIssue = requireDecimal(val, `第 ${row} 行${label}(cm)`, DECIMAL_10_2);
        if (dimIssue) {
          fail(res, 400, "BAD_REQUEST", dimIssue);
          return;
        }
      }

      /**
       * 单件重量（可以不填）—— 填了就得是合法的 `Decimal(10,2)`。
       * 复核实测 `unitWeightKg: true` 会被 Number() 变成 1kg 存进去。
       */
      if (it.unitWeightKg !== undefined && it.unitWeightKg !== null) {
        const wIssue = requireDecimal(it.unitWeightKg, `第 ${row} 行单件重量(kg)`, DECIMAL_10_2);
        if (wIssue) {
          fail(res, 400, "BAD_REQUEST", wIssue);
          return;
        }
      }

      /**
       * ⚠️⚠️ **算出来的字段也要卡**（2026-08-29 第十轮补）。
       * 每个输入都合法、算出来的数爆掉，是最隐蔽的一类：
       *   · 单重 99999999.99 × 数量 2 → totalWeightKg 是 Decimal(10,2)，
       *     数据库实测 `numeric field overflow`
       *   · 1000×1000×1000cm × 10 件 = 10000 m³ → volumeM3 是 Decimal(10,6)，
       *     最大只能存 9999.999999 → 裸 500
       * ⚠️ 这里的算式必须跟下面真正写库那几行**一模一样**。
       */
      {
        const unitW = it.unitWeightKg == null ? null : parseNumericStrict(it.unitWeightKg);
        if (unitW !== null) {
          const tw = requireDerivedWithinDecimal(unitW * pkg * qpb, `第 ${row} 行总重量(kg)`, DECIMAL_10_2);
          if (tw) { fail(res, 400, "BAD_REQUEST", tw); return; }
        }
        const vol =
          (parseNumericStrict(it.lengthCm) * parseNumericStrict(it.widthCm) * parseNumericStrict(it.heightCm) / 1_000_000) * pkg;
        const tv = requireDerivedWithinDecimal(vol, `第 ${row} 行方数(m³)`, DECIMAL_10_6);
        if (tv) { fail(res, 400, "BAD_REQUEST", tv); return; }
      }
      if (!it.material?.trim()) {
        fail(res, 400, "BAD_REQUEST", `第 ${row} 行材质为必填`);
        return;
      }
      if (!it.cargoValue?.trim()) {
        fail(res, 400, "BAD_REQUEST", `第 ${row} 行货值为必填`);
        return;
      }
      if (it.cargoType && !["normal", "inspection", "sensitive"].includes(it.cargoType)) {
        fail(res, 400, "BAD_REQUEST", `第 ${row} 行货物类型不合法`);
        return;
      }
      if (it.imageBase64 != null && it.imageBase64 !== "") {
        if (!isValidBase64(it.imageBase64)) {
          fail(res, 400, "BAD_REQUEST", `第 ${row} 行图片格式不正确`);
          return;
        }
        if (it.imageBase64.length > MAX_IMAGE_BASE64_LENGTH) {
          fail(res, 400, "BAD_REQUEST", `第 ${row} 行图片过大，请压缩后再上传`);
          return;
        }
      }
    }

    // ---- 容量校验：拿整个计划的已用方数来比，而不是单个客户 ----
    const myNewVolume = round3(
      items.reduce((sum, it) => {
        const v = calcItemVolumeM3(
          Number(it.lengthCm),
          Number(it.widthCm),
          Number(it.heightCm),
          Number(it.packageCount) || 1,
        );
        return sum + (v ?? 0);
      }, 0),
    );
    // 该客户其它预报单（未取消、且不是当前这张）已占的方数
    const myOtherPrealerts = await prisma.whrConsolidationPrealert.findMany({
      where: {
        customerId: prealert.customerId,
        id: { not: prealert.id },
        ...ACTIVE_PREALERT_WHERE,
      },
      select: { items: { select: { volumeM3: true } } },
    });
    let myOtherVolume = 0;
    for (const pa of myOtherPrealerts) {
      for (const it of pa.items) myOtherVolume += toNum(it.volumeM3);
    }
    const otherCustomersVolume = await sumPlanUsedVolume(plan.id, prisma, prealert.customerId);
    const planTotal = toNum(plan.totalVolumeM3);
    const planUsedAfter = round3(otherCustomersVolume + myOtherVolume + myNewVolume);

    if (planTotal > 0 && planUsedAfter > planTotal) {
      // 用 fail() 返回 400，而不是 throw —— throw 在生产环境会被兜底 catch 换成 "Internal server error"
      fail(
        res,
        400,
        "BAD_REQUEST",
        `本柜已用 ${round3(otherCustomersVolume + myOtherVolume)} 方，` +
          `本次再报 ${myNewVolume} 方将达到 ${planUsedAfter} 方，超过计划上限 ${planTotal} 方`,
      );
      return;
    }

    // ---- 组装货品数据 ----
    // 已有图片路径白名单，防止客户端回传任意路径
    const existingPaths = new Set(
      prealert.items.map((it) => it.productImageBase64).filter((p): p is string => !!p),
    );

    const itemData: any[] = items.map((it, idx) => {
      const pkg = Number(it.packageCount) || 1;
      const qpb = Number(it.quantityPerBox) || 1;
      const unitWeightRaw = it.unitWeightKg == null ? null : Number(it.unitWeightKg);
      const unitWeight =
        unitWeightRaw != null && Number.isFinite(unitWeightRaw) && unitWeightRaw > 0 ? unitWeightRaw : null;
      const keepPath =
        !it.imageBase64 && it.existingImagePath && existingPaths.has(it.existingImagePath)
          ? it.existingImagePath
          : null;
      return {
        productName: it.productName!.trim(),
        packageCount: pkg,
        quantityPerBox: qpb,
        totalQuantity: pkg * qpb,
        lengthCm: Number(it.lengthCm),
        widthCm: Number(it.widthCm),
        heightCm: Number(it.heightCm),
        unitWeightKg: unitWeight,
        totalWeightKg: unitWeight == null ? null : Math.round(unitWeight * pkg * qpb * 100) / 100,
        volumeM3: calcItemVolumeM3(Number(it.lengthCm), Number(it.widthCm), Number(it.heightCm), pkg),
        material: it.material!.trim(),
        cargoValue: it.cargoValue!.trim(),
        cargoType: it.cargoType || "normal",
        sortOrder: idx,
        productImageFileName: null as string | null,
        productImageMime: null as string | null,
        productImageBase64: keepPath as string | null,
      };
    });
    // 保留原图时，文件名/mime 也要跟着保留
    const oldItemMeta = new Map<string, { fileName: string | null; mime: string | null }>();
    {
      const fullOld = await prisma.whrConsolidationPrealertItem.findMany({
        where: { prealertId: prealert.id },
        select: { productImageBase64: true, productImageFileName: true, productImageMime: true },
      });
      for (const o of fullOld) {
        if (o.productImageBase64) {
          oldItemMeta.set(o.productImageBase64, {
            fileName: o.productImageFileName,
            mime: o.productImageMime,
          });
        }
      }
    }
    for (const d of itemData) {
      if (d.productImageBase64 && oldItemMeta.has(d.productImageBase64)) {
        const meta = oldItemMeta.get(d.productImageBase64)!;
        d.productImageFileName = meta.fileName;
        d.productImageMime = meta.mime;
      }
    }

    // ---- 先写盘再开事务：文件 IO 不该待在事务里，事务回滚也回滚不了磁盘 ----
    const newlyWrittenPaths: string[] = [];
    const cleanupNew = () => {
      for (const p of newlyWrittenPaths) {
        try {
          deleteImageFile(p);
        } catch {
          /* ignore */
        }
      }
    };
    try {
      for (const [i, it] of items.entries()) {
        if (!it.imageBase64?.trim()) continue;
        const imgPath = saveImageToDisk(
          `whr_item_${prealert.id}_${i}_${Date.now()}`,
          it.imageMime || "image/png",
          it.imageBase64.trim(),
        );
        newlyWrittenPaths.push(imgPath);
        itemData[i].productImageFileName = it.imageFileName || imgPath.split("/").pop() || "";
        itemData[i].productImageMime = it.imageMime || "image/png";
        itemData[i].productImageBase64 = imgPath;
      }
    } catch {
      cleanupNew();
      fail(res, 400, "BAD_REQUEST", "产品图片保存失败，请重试或更换图片");
      return;
    }

    let result: { totalVolumeM3: number; totalPackages: number };
    /**
     * 锁内算出来的「本柜已用方数」。返回给前端的必须是这个，
     * 不能用事务外那份 planUsedAfter —— 那是进门时的快照，
     * 别的客户在这中间提交过的话，页面上显示的方数就是旧的，
     * 客户会以为还有空间（复核 2026-08-28 指出）。
     */
    let lockedPlanUsedVolume: number | null = null;
    try {
      result = await prisma.$transaction(async (tx) => {
        /**
         * ⚠️ 2026-08-28 补：这条路原来是仓库版里**唯一一条一把锁都没加**的写路径。
         *
         * 上面那几道检查（预报单还没签收 / 计划没结束 / 方数没超上限）全在事务
         * **外面**、拿进门时那份快照做的，而事务里直接把货品**全删了重建**、
         * 再调 recalcPrealertFee 覆写 totalFee —— 而那个函数是**无条件覆写**的
         * （「已结清不改价」的保护在 recalcUnpaidPrealertFees 里，不在它里面）。
         *
         * 于是仓库正好在这一刻签收、把账单定死时，客户这边的提交照样能过：
         * 货品被换掉，签收单上写的和系统里存的对不上，**账单还被改小甚至改成 0**。
         * 方数上限那道同理：两个客户同时提交，各自都拿旧数字算，双双通过，柜子超装。
         *
         * 现在照同模块 routes.ts:1188 那套：
         * 【锁计划 → 锁预报单】（跟取消整柜、删货物、签收走同一个锁序，不会死锁）
         * → 重查状态 → 用重查的值判断 → 再动手。
         */
        await lockPlanAliveByPrealert(tx, prealert.id);
        await lockPrealertExpecting(tx, prealert.id, EDITABLE_PREALERT_STATUS, "货品修改");

        /**
         * ⚠️ 「保留原有图片」的白名单要在**锁里**再核一遍（2026-08-29 补）。
         * 上面那份 existingPaths 是进门时读的。两个人先后改同一张预报单时，
         * 后一个人可能回传一个**前一个人刚刚拿掉**的图片路径 ——
         * 于是这张单又引用上了它，而前一个人的清理正准备把那个文件删掉，
         * 结果是数据库记着路径、磁盘上文件没了，客户看到裂图且找不回。
         * 锁后重查一遍当前还挂着哪些图，回传的路径必须在里面。
         */
        const lockedItems = await tx.whrConsolidationPrealertItem.findMany({
          where: { prealertId: prealert.id },
          select: { productImageBase64: true },
        });
        const lockedPaths = new Set(
          lockedItems
            .map((it: { productImageBase64: string | null }) => it.productImageBase64)
            .filter((v: string | null): v is string => Boolean(v)),
        );
        for (const it of itemData) {
          const keep = it.productImageBase64;
          // 本次新存的图不在 lockedPaths 里（它还没写进库），只校验「声称要保留的旧图」
          if (keep && existingPaths.has(keep) && !lockedPaths.has(keep)) {
            throw new BusinessError(
              "这张预报单的图片刚刚被改过，你保留的那张已经不在了，本次修改没有保存，请刷新后重试",
              409,
              "VALIDATION_ERROR",
            );
          }
        }

        /**
         * 方数在锁里**无条件重算一遍**：上面那次是拿事务外的快照算的。
         *
         * ⚠️ 2026-08-29 改：原来这一整段包在 `if (planTotal > 0)` 里 ——
         * 本柜没设上限时锁内不算，返回给前端的 planUsedVolumeM3 就退回
         * **事务外那份旧快照**。别人在这几毫秒里报了货，客户看到的已用方数就是旧的。
         * 生产 185 个柜里没设上限的占多数，所以这条其实是常态路径。
         * 「拦不拦」和「返回的数准不准」是两件事：拦只在设了上限时拦，
         * 但返回的数任何时候都得是锁里算出来的那个。
         */
        const freshOthers = await tx.whrConsolidationPrealert.findMany({
          where: {
            customerId: prealert.customerId,
            id: { not: prealert.id },
            ...ACTIVE_PREALERT_WHERE,
          },
          select: { items: { select: { volumeM3: true } } },
        });
        let freshMyOther = 0;
        for (const pa of freshOthers) {
          for (const it of pa.items) freshMyOther += toNum(it.volumeM3);
        }
        const freshOtherCustomers = await sumPlanUsedVolume(plan.id, tx, prealert.customerId);
        const freshUsedAfter = round3(freshOtherCustomers + freshMyOther + myNewVolume);
        lockedPlanUsedVolume = freshUsedAfter;
        // 只有本柜设了上限（planTotal > 0）才拦，跟事务外那道口径一致
        if (planTotal > 0 && freshUsedAfter > planTotal) {
          throw new BusinessError(
            `本柜已用 ${round3(freshOtherCustomers + freshMyOther)} 方，` +
              `本次再报 ${myNewVolume} 方将达到 ${freshUsedAfter} 方，超过计划上限 ${planTotal} 方`,
          );
        }

        await tx.whrConsolidationPrealertItem.deleteMany({ where: { prealertId: prealert.id } });
        if (itemData.length > 0) {
          await tx.whrConsolidationPrealertItem.createMany({
            data: itemData.map((it) => ({
              ...it,
              prealertId: prealert.id,
              companyId: auth.companyId,
            })),
          });
        }
        // 货品变了，费用和客户汇总一起重算
        await recalcPrealertFee(prealert.id, tx);
        return recalcCustomerTotals(prealert.customerId, tx);
      });
    } catch (e) {
      cleanupNew();
      throw e;
    }

    /**
     * ---- 事务成功后清理不再被引用的旧图片，避免磁盘越堆越多 ----
     *
     * ⚠️ 删之前必须**再去数据库确认一遍没人引用了**（2026-08-28 补）。
     * `keptPaths` 是本次提交要保留的清单，而清理跑在事务**外面**、锁已经放掉了：
     * 两个人先后改同一张预报单时，前一个人的清理会拿着自己那份旧清单，
     * 把后一个人刚刚重新引用上的图片文件**删掉** ——
     * 数据库里还记着这个路径，磁盘上的文件却没了，客户点开就是一张裂图，
     * 而且**找不回来**。
     *
     * 现在每删一个之前查一次「全表还有没有人引用它」，没人引用才删。
     * 查的范围是整张表、不限这一张预报单：同一个路径理论上不会被别的单引用，
     * 但真被引用了就更不能删。
     */
    const keptPaths = new Set(
      itemData.map((it) => it.productImageBase64).filter((p): p is string => !!p),
    );
    for (const oldPath of existingPaths) {
      if (keptPaths.has(oldPath)) continue;
      try {
        const stillUsed = await prisma.whrConsolidationPrealertItem.count({
          where: { productImageBase64: oldPath },
        });
        if (stillUsed > 0) continue;
        deleteImageFile(oldPath);
      } catch {
        /* 清理失败不影响主流程；宁可留个没人用的文件，也不能删掉还在用的 */
      }
    }

    ok(res, {
      prealertId: prealert.id,
      totalVolumeM3: result.totalVolumeM3,
      totalPackages: result.totalPackages,
      itemCount: itemData.length,
      // 锁内一定算过了（2026-08-29 起不再只在有上限时算），?? 只是兜底
      planUsedVolumeM3: lockedPlanUsedVolume ?? planUsedAfter,
      planTotalVolumeM3: planTotal,
    });
  });

  // =======================================================================
  // 4. 上传付款凭证（预报单级别）
  // =======================================================================
  // ==========================================================================
  // 客户付款：用集货余额直接扣（2026-08-07 改）
  // 原来是上传付款凭证 → 等管理员审核。现在改成余额支付：当场扣钱、当场完成，
  // 不用传水单、不用审核。水单只在充值那一步传一次。
  // 误操作由管理员端「撤销付款」兜底（退钱 + 单子回到待付款）。
  // ==========================================================================
  app.post("/client/whr-consolidation/pay", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { planId?: string; prealertId?: string };
    if (!body.planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }
    if (!body.prealertId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "prealertId 为必填");
      return;
    }

    const prealert = await prisma.whrConsolidationPrealert.findFirst({
      where: {
        id: body.prealertId,
        companyId: auth.companyId,
        planCustomer: { planId: body.planId, clientId: auth.userId, companyId: auth.companyId },
      },
      include: { planCustomer: { select: { deliveryAddress: true } } },
    });
    if (!prealert) {
      fail(res, 403, "FORBIDDEN", "无权操作该预报单");
      return;
    }
    if (prealert.status !== "received_pending_payment") {
      fail(res, 400, "BAD_REQUEST", "当前状态不可付款，仅待付款状态可操作");
      return;
    }
    if (!prealert.planCustomer.deliveryAddress?.trim()) {
      fail(res, 400, "BAD_REQUEST", "请先填写泰国收货地址，再付款");
      return;
    }

    const amount = prealert.totalFee == null ? 0 : Number(prealert.totalFee);
    if (!(amount > 0)) {
      fail(res, 400, "BAD_REQUEST", "这张预报单还没有计费金额，请联系客服核对后再付款");
      return;
    }

    try {
      const paid = await prisma.$transaction(async (tx) => {
        /**
         * ⚠️⚠️ 事务里必须**重新读一遍并锁住这张预报单**（2026-08-25 新增）。
         *
         * 上面那几道 `if` 是在事务**外面**查的。客户手抖点两下「付款」，
         * 两个请求会同时通过检查、各自开事务、各扣一次钱 —— 单子一张，钱扣两遍。
         * 前端禁用按钮挡不住（抓包重放、网络重试都能绕过）。
         *
         * FOR UPDATE 之后第二个请求会等第一个提交完，读到状态已是 paid，
         * 直接报「已付款」退出，一分钱不扣。
         *
         * ⚠️ 金额也要用事务里读出来的：仓库版是签收那一刻按方数×单价自动算的，
         * 管理员改单价会重算 totalFee，用事务外那个旧金额会扣错数。
         */
        // ⚠️ 锁序固定为【计划 → 预报单 → 钱包】，四条碰钱的路都按这个顺序拿锁，
        // 反着拿会死锁。所以先锁柜、再锁单，别调换。
        await lockPlanAliveByPrealert(tx, prealert.id);
        await tx.$queryRaw`SELECT id FROM whr_consolidation_prealerts WHERE id = ${prealert.id} FOR UPDATE`;
        const fresh = await tx.whrConsolidationPrealert.findUnique({
          where: { id: prealert.id },
          select: { status: true, totalFee: true },
        });
        if (!fresh || fresh.status !== "received_pending_payment") {
          throw new PaymentConflictError(
            fresh?.status === "paid"
              ? "这张预报单已付款，不用重复付"
              : "这张预报单的状态刚刚变了，请刷新页面后再试",
          );
        }
        const amount = fresh.totalFee == null ? 0 : Number(fresh.totalFee);
        if (!(amount > 0)) {
          throw new PaymentConflictError("这张预报单还没有计费金额，请联系客服核对后再付款");
        }

        /**
         * 付款那一刻的价格快照（2026-09-16，确认单 4.14）：客户价、所属代理、代理价、这票返现一起记在单上，
         * 之后谁改价，已付款的单金额和返现都不变。放在扣钱之前 —— 锁序【计划 → 预报单 → 钱包】，
         * 快照只读计划客户行 / 货品 / 用户 / 代理，不加新锁（原因见 buildPaidSnapshot 注释）。
         */
        // 把这次要扣的钱交进去核对「扣的钱 = 方数 × 快照单价」，代理客户的单对不上就不扣（2026-09-15，Codex 审查 P1-1）
        const snapshot = await buildPaidSnapshot(prealert.id, tx, amount);

        // 扣钱和改状态必须在同一个事务里，不能出现「钱扣了单子没付上」
        const after = await chargeForConsolidation(tx as any, {
          companyId: auth.companyId,
          clientId: auth.userId,
          amount,
          refType: "whr",
          refId: prealert.id,
          refNo: prealert.trackingNo,
          remark: "仓库版集货付款",
          operatorId: auth.userId,
          operatorName: auth.name || auth.userId,
        });
        await tx.whrConsolidationPrealert.update({
          where: { id: prealert.id },
          data: {
            status: "paid",
            paymentReviewedAt: new Date(),
            paymentReviewedBy: null,
            paymentRejectReason: null,
            ...snapshot,
          } as any,
        });
        await tx.whrConsolidationStatusLog.create({
          data: {
            prealertId: prealert.id,
            companyId: auth.companyId,
            operatorId: auth.userId,
            operatorRole: "client",
            operatorName: auth.name || auth.userId,
            fromStatus: "received_pending_payment",
            toStatus: "paid",
            remark: `客户用集货余额付款 ¥${amount.toFixed(2)}`,
          },
        });
        return { balanceAfter: after, amount };
      });

      ok(res, {
        prealertId: prealert.id,
        status: "paid",
        paidAmount: paid.amount,
        balanceAfter: paid.balanceAfter,
        message: `付款成功，已扣 ¥${paid.amount.toFixed(2)}，集货余额剩余 ¥${paid.balanceAfter.toFixed(2)}`,
      });
    } catch (e) {
      if (e instanceof PlanCancelledError || e instanceof PlanMissingError) {
        fail(res, 400, "BAD_REQUEST", e.message);
        return;
      }
      if (e instanceof InsufficientBalanceError || e instanceof PaymentConflictError) {
        fail(res, 400, "BAD_REQUEST", e.message);
        return;
      }
      throw e;
    }
  });

  // =======================================================================
  // 4b. 保存收货地址
  // =======================================================================
  app.post("/client/whr-consolidation/address", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { planId?: string; deliveryAddress?: string };
    if (!body.planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }
    if (!body.deliveryAddress?.trim()) {
      fail(res, 400, "BAD_REQUEST", "收货地址为必填");
      return;
    }
    if (body.deliveryAddress.trim().length > 500) {
      fail(res, 400, "BAD_REQUEST", "收货地址过长");
      return;
    }

    const customer = await prisma.whrConsolidationPlanCustomer.findFirst({
      where: { planId: body.planId, clientId: auth.userId, companyId: auth.companyId },
      include: { prealerts: { select: { status: true } } },
    });
    if (!customer) {
      fail(res, 403, "FORBIDDEN", "您不在该拼柜计划中");
      return;
    }
    // 已发运之后地址已经用于尾端派送，不能再改
    if (customer.prealerts.some((pa) => pa.status === "shipped" || pa.status === "thailand_received")) {
      fail(res, 400, "BAD_REQUEST", "已有货物发运，收货地址不可再修改，如需变更请联系客服");
      return;
    }

    const deliveryAddress = body.deliveryAddress.trim();
    /**
     * ⚠️ 上面两道检查在事务外面，只配早点给个好看的提示（2026-09-15，Codex 第二轮 O1-R1，改动前就有的缝）。
     * 原来查完直接改：查完那一刻员工正好把这位客户移出了柜，这一改撞上「这一行没了」就成了服务器错误（500）；
     * 查完那一刻刚发运，地址也照样被改。现在跟超管填地址、移除客户、发运确认一样先锁计划行排队，
     * 锁住之后重查自己还在不在柜里、有没有货已发运，说了算的是锁里这一次。
     */
    const saved = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM whr_consolidation_plans WHERE id = ${customer.planId} FOR UPDATE`;
      const current = await tx.whrConsolidationPlanCustomer.findFirst({
        where: { id: customer.id, planId: customer.planId, clientId: auth.userId, companyId: auth.companyId },
        select: { id: true },
      });
      if (!current) {
        throw new BusinessError("您已不在该拼柜计划中（可能刚被移出），请刷新后再看", 403, "FORBIDDEN");
      }
      const shipped = await tx.whrConsolidationPrealert.count({
        where: { customerId: current.id, status: { in: ["shipped", "thailand_received"] } },
      });
      if (shipped > 0) {
        throw new BusinessError("已有货物发运，收货地址不可再修改，如需变更请联系客服");
      }
      await tx.whrConsolidationPlanCustomer.update({
        where: { id: current.id },
        data: { deliveryAddress },
      });
      return { customerId: current.id, deliveryAddress };
    });
    ok(res, saved);
  });

  // =======================================================================
  // 5. 查看我的详情（预报单级别）
  // =======================================================================
  app.get("/client/whr-consolidation/my-detail", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const planId = (req.query as any)?.planId as string | undefined;
    if (!planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }

    const customer = await prisma.whrConsolidationPlanCustomer.findFirst({
      where: { planId, clientId: auth.userId, companyId: auth.companyId },
      include: {
        client: { select: { name: true, phone: true } },
        prealerts: {
          orderBy: { createdAt: "asc" },
          take: 500,
          include: {
            items: { orderBy: { sortOrder: "asc" } },
            statusLogs: { orderBy: { createdAt: "desc" }, take: 50 },
          },
        },
      },
    });
    if (!customer) {
      fail(res, 403, "FORBIDDEN", "您不在该拼柜计划中");
      return;
    }

    // 费用明细：让客户看得见「总费用是怎么算出来的」
    const prices = {
      unitPriceNormal: customer.unitPriceNormal,
      unitPriceInspection: customer.unitPriceInspection,
      unitPriceSensitive: customer.unitPriceSensitive,
    };
    const breakdownByPrealert = new Map<string, ReturnType<typeof buildFeeBreakdown>>();
    for (const pa of customer.prealerts) {
      breakdownByPrealert.set(pa.id, buildFeeBreakdown(pa.items, prices, pa.totalFee));
    }
    // 客户级明细只汇总未取消的单
    const customerBreakdown = mergeFeeBreakdowns(
      customer.prealerts
        .filter((pa) => pa.status !== "cancelled")
        .map((pa) => breakdownByPrealert.get(pa.id)!),
    );

    // 时间线在这里聚合一次即可，不再逐单重复下发一份（原来同一批日志会传两遍）
    const allLogs = customer.prealerts
      .flatMap((pa) => pa.statusLogs.map((sl) => ({ ...sl, trackingNo: pa.trackingNo })))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 200);

    ok(res, {
      customerId: customer.id,
      customerName: customer.client.name,
      customerPhone: customer.client.phone,
      unitPriceNormal: toNum(customer.unitPriceNormal),
      unitPriceInspection: toNum(customer.unitPriceInspection),
      unitPriceSensitive: toNum(customer.unitPriceSensitive),
      totalVolumeM3: toNum(customer.totalVolumeM3),
      totalFee: customer.totalFee == null ? null : toNum(customer.totalFee),
      feeBreakdown: customerBreakdown,
      deliveryAddress: customer.deliveryAddress,
      totalPrealerts: customer.totalPrealerts,
      totalPackages: customer.totalPackages,
      prealerts: customer.prealerts.map((pa) => ({
        id: pa.id,
        trackingNo: pa.trackingNo,
        expressNo: pa.expressNo,
        mark: pa.mark,
        status: pa.status,
        receivedAt: pa.receivedAt?.toISOString() ?? null,
        signedAt: pa.signedAt?.toISOString() ?? null,
        warehouseReceiptProofs: pa.warehouseReceiptProofs ?? [],
        totalFee: pa.totalFee == null ? null : toNum(pa.totalFee),
        feeBreakdown: breakdownByPrealert.get(pa.id) ?? null,
        paymentProofs: pa.paymentProofs ?? [],
        paymentProofUploadedAt: pa.paymentProofUploadedAt?.toISOString() ?? null,
        paymentReviewedAt: pa.paymentReviewedAt?.toISOString() ?? null,
        paymentRejectReason: pa.paymentRejectReason,
        thailandReceiptProofs: pa.thailandReceiptProofs ?? [],
        thailandReceivedAt: pa.thailandReceivedAt?.toISOString() ?? null,
        cancelReason: pa.cancelReason,
        cancelledAt: pa.cancelledAt?.toISOString() ?? null,
        createdAt: pa.createdAt.toISOString(),
        items: pa.items.map((it: any) => ({
          id: it.id,
          productName: it.productName,
          packageCount: it.packageCount,
          quantityPerBox: it.quantityPerBox,
          totalQuantity: it.totalQuantity,
          lengthCm: it.lengthCm == null ? null : toNum(it.lengthCm),
          widthCm: it.widthCm == null ? null : toNum(it.widthCm),
          heightCm: it.heightCm == null ? null : toNum(it.heightCm),
          unitWeightKg: it.unitWeightKg == null ? null : toNum(it.unitWeightKg),
          totalWeightKg: it.totalWeightKg == null ? null : toNum(it.totalWeightKg),
          volumeM3: it.volumeM3 == null ? null : toNum(it.volumeM3),
          material: it.material,
          cargoValue: it.cargoValue,
          cargoType: it.cargoType,
          productImageFileName: it.productImageFileName,
          productImageBase64: it.productImageBase64,
          sortOrder: it.sortOrder,
        })),
      })),
      statusLogs: allLogs.map((sl) => ({
        id: sl.id,
        trackingNo: sl.trackingNo,
        // 2026-09-15：不再下发 operatorName / operatorRole —— 操作人身份只有超级管理员能看。
        // 这里只列要给的字段（上面 `...sl` 带进来的整行不会漏出去）
        fromStatus: sl.fromStatus,
        toStatus: sl.toStatus,
        remark: hideOperatorInRemark(sl.remark, "client"),
        createdAt: sl.createdAt.toISOString(),
      })),
    });
  });
}
