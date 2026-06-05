import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("🔍 查找 [测试] 订单...");

  const orders = await prisma.order.findMany({
    where: { itemName: { startsWith: "[测试]" } },
    select: {
      id: true,
      itemName: true,
      shipments: { select: { id: true } },
    },
  });

  if (orders.length === 0) {
    console.log("没有找到 [测试] 订单，无需删除。");
    return;
  }

  console.log(`找到 ${orders.length} 条 [测试] 订单，开始删除...\n`);

  for (const order of orders) {
    try {
      // 先删运单关联的状态日志
      for (const s of order.shipments) {
        await prisma.statusLog.deleteMany({ where: { shipmentId: s.id } });
        await prisma.shipment.delete({ where: { id: s.id } });
      }
      // 再删产品图和产品行
      await prisma.orderProductImage.deleteMany({ where: { orderId: order.id } });
      await prisma.orderProduct.deleteMany({ where: { orderId: order.id } });
      // 最后删订单
      await prisma.order.delete({ where: { id: order.id } });
      console.log(`  ✅ 已删除: ${order.itemName} (${order.id})`);
    } catch (e: any) {
      console.log(`  ❌ 删除失败: ${order.itemName} → ${e.message}`);
    }
  }

  const remaining = await prisma.order.count({
    where: { itemName: { startsWith: "[测试]" } },
  });
  console.log(`\n✅ 完成! 剩余 [测试] 订单: ${remaining}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
