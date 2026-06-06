/**
 * 强制重算所有订单的体积和重量（用 raw SQL 确保覆盖）。
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // 直接用 SQL 从产品行重算并强制覆盖
  await prisma.$executeRawUnsafe(`
    UPDATE orders o SET
      weight_kg = COALESCE((
        SELECT SUM(op.weight_kg * op.package_count)
        FROM order_products op
        WHERE op.order_id = o.id
      ), null),
      volume_m3 = COALESCE((
        SELECT SUM(op.length_cm * op.width_cm * op.height_cm * op.package_count) / 1000000.0
        FROM order_products op
        WHERE op.order_id = o.id
          AND op.length_cm IS NOT NULL
          AND op.width_cm IS NOT NULL
          AND op.height_cm IS NOT NULL
      ), null),
      package_count = COALESCE((
        SELECT SUM(op.package_count)
        FROM order_products op
        WHERE op.order_id = o.id
      ), 0)
  `);

  // 同步到运单
  await prisma.$executeRawUnsafe(`
    UPDATE shipments s SET
      weight_kg = o.weight_kg,
      volume_m3 = o.volume_m3,
      package_count = o.package_count
    FROM orders o
    WHERE s.order_id = o.id
  `);

  const count = await prisma.order.count();
  console.log(`Done. Updated all ${count} orders and their shipments.`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
