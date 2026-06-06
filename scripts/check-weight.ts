const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  const ship = await p.shipment.findFirst({ where: { trackingNo: "YW0001248" } });
  if (!ship) { console.log("没找到 YW0001248"); return; }
  const prods = await p.orderProduct.findMany({ where: { orderId: ship.orderId } });
  console.log("运单 YW0001248, 共", prods.length, "个产品行");
  for (const pr of prods) {
    const w = (pr.weightKg || 0) * pr.packageCount;
    console.log(" ", pr.itemName, "| 单箱重:", pr.weightKg, "| x", pr.packageCount, "箱 | =", w, "kg");
  }
  const tw = prods.reduce((s, pr) => s + (pr.weightKg || 0) * pr.packageCount, 0);
  console.log("重算总重量:", tw, "kg");
  const order = await p.order.findUnique({ where: { id: ship.orderId } });
  console.log("DB存:", order.weightKg, "kg");
  await p.$disconnect();
})();
