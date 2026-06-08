/**
 * 重算所有订单的应收金额（按产品行分别计价求和）
 * 运行：npx tsx scripts/recalc-receivable.ts
 */
const { PrismaClient } = require("@prisma/client");

const p = new PrismaClient();

const MIN_VOLUME_M3 = 1;

const DEFAULT_UNIT_PRICES = {
  "sea|NORMAL": 550, "sea|INSPECTION": 700, "sea|SENSITIVE": 800,
  "land|NORMAL": 1070, "land|INSPECTION": 1250, "land|SENSITIVE": 1350,
};

async function calcByProducts(companyId, transportMode, products) {
  let total = 0;
  let hasAny = false;
  for (const prod of products) {
    const vol = (prod.lengthCm && prod.widthCm && prod.heightCm)
      ? (prod.lengthCm * prod.widthCm * prod.heightCm * prod.packageCount) / 1_000_000
      : 0;
    if (vol <= 0) continue;
    hasAny = true;
    const ct = prod.cargoType || "NORMAL";
    const key = `${transportMode}|${ct}`;
    const rule = companyId ? await p.pricingRule.findFirst({
      where: { companyId, transportMode, cargoType: ct, customerId: null },
      select: { unitPriceCny: true },
    }) : null;
    const unitPrice = rule ? Number(rule.unitPriceCny.toString()) : (DEFAULT_UNIT_PRICES[key] || 550);
    const billable = Math.max(vol, MIN_VOLUME_M3);
    total += billable * unitPrice;
  }
  return hasAny ? Math.round(total * 100) / 100 : null;
}

async function main() {
  const orders = await p.order.findMany({
    select: { id: true, itemName: true, transportMode: true, companyId: true },
  });

  let fixed = 0;
  for (const order of orders) {
    const products = await p.orderProduct.findMany({
      where: { orderId: order.id },
      select: { packageCount: true, lengthCm: true, widthCm: true, heightCm: true, cargoType: true },
    });
    if (products.length === 0) continue;

    const amount = await calcByProducts(order.companyId, order.transportMode || "sea", products);
    if (amount !== null) {
      await p.order.update({
        where: { id: order.id },
        data: { receivableAmountCny: amount },
      });
      fixed++;
      if (fixed % 20 === 0) console.log(`  ${fixed}/${orders.length} done`);
    }
  }

  console.log(`Done. Recalculated ${fixed} orders.`);
  await p.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
