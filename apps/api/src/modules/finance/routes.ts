import { prisma } from "../../db/prisma";
import { Prisma } from "@prisma/client";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";

function decToNumber(v: Prisma.Decimal | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return Number(v.toString());
}

/**
 * 注册财务结算接口。
 */
export function registerFinanceRoutes(app: MinimalHttpApp): void {
  // 财务汇总
  app.get("/admin/finance/summary", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const orders = await prisma.order.findMany({
      where: { companyId: auth.companyId },
      orderBy: { createdAt: "desc" },
      include: {
        client: { select: { name: true } },
        shipments: { select: { id: true, currentStatus: true, weightKg: true, volumeM3: true } },
      },
    });
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    let totalOrders = 0;
    let totalWeight = 0;
    let totalVolume = 0;
    let monthOrders = 0;
    const rows = orders.map((o) => {
      totalOrders++;
      const w = decToNumber(o.weightKg);
      const v = decToNumber(o.volumeM3);
      totalWeight += w;
      totalVolume += v;
      if (o.createdAt >= monthStart) monthOrders++;
      return {
        id: o.id,
        orderNo: o.orderNo ?? o.id,
        clientName: o.client?.name ?? "—",
        transportMode: o.transportMode ?? "—",
        warehouse: o.warehouseId ?? "—",
        weightKg: w,
        volumeM3: v,
        paymentStatus: o.paymentStatus ?? "unpaid",
        createdAt: o.createdAt.toISOString(),
      };
    });
    ok(res, { totalOrders, totalWeight, totalVolume, monthOrders, rows });
  });
}
