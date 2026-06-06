/**
 * 重算所有订单的体积和重量（从产品行重新计算，修复之前翻倍的 bug）。
 * 运行：npx tsx scripts/recalc-order-volumes.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const orders = await prisma.order.findMany({
    select: { id: true, itemName: true },
  });

  let fixed = 0;
  for (const order of orders) {
    const products = await prisma.orderProduct.findMany({
      where: { orderId: order.id },
      select: { packageCount: true, lengthCm: true, widthCm: true, heightCm: true, weightKg: true },
    });

    if (products.length === 0) continue;

    const totalPkg = products.reduce((s, p) => s + p.packageCount, 0);
    const totalWeight = products.reduce((s, p) => s + (p.weightKg ?? 0) * p.packageCount, 0);
    const totalVol = products.reduce((s, p) => {
      if (p.lengthCm && p.widthCm && p.heightCm) return s + (p.lengthCm * p.widthCm * p.heightCm * p.packageCount) / 1_000_000;
      return s;
    }, 0);

    await prisma.order.update({
      where: { id: order.id },
      data: {
        packageCount: totalPkg,
        weightKg: totalWeight > 0 ? totalWeight : undefined,
        volumeM3: totalVol > 0 ? totalVol : undefined,
      },
    });

    // Also update linked shipments
    await prisma.shipment.updateMany({
      where: { orderId: order.id },
      data: {
        packageCount: totalPkg,
        weightKg: totalWeight > 0 ? totalWeight : undefined,
        volumeM3: totalVol > 0 ? totalVol : undefined,
      },
    });

    fixed++;
    if (fixed % 50 === 0) console.log(`  ${fixed}/${orders.length} done`);
  }

  console.log(`Done. Recalculated ${fixed} orders.`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
