// B-3 ~ B-7: 已从 node:sqlite 迁移到 Prisma + PostgreSQL（2026-05-18）
import { prisma } from "../../db/prisma";

/** 单个订单最多保存的产品详情图数量。 */
export const MAX_ORDER_PRODUCT_IMAGES = 999;

export type OrderProductImagePayload = {
  id: string;
  fileName: string;
  mime: string;
  contentBase64: string;
  filePath?: string | null;
  imageUrl?: string;
  createdAt: string;
};

/**
 * 批量读取订单关联的产品详情图（每单最多 5 张，按创建时间升序）。
 */
export async function loadProductImagesForOrders(
  companyId: string,
  orderIds: string[],
): Promise<Map<string, OrderProductImagePayload[]>> {
  if (orderIds.length === 0) return new Map();
  const uniq = [...new Set(orderIds)];
  const rows = await prisma.orderProductImage.findMany({
    where: {
      companyId,
      orderId: { in: uniq },
    },
    orderBy: [{ orderId: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      orderId: true,
      fileName: true,
      mime: true,
      filePath: true,
      createdAt: true,
    },
  });
  const map = new Map<string, OrderProductImagePayload[]>();
  for (const row of rows) {
    const list = map.get(row.orderId) ?? [];
    if (list.length >= MAX_ORDER_PRODUCT_IMAGES) continue;
    list.push({
      id: row.id,
      fileName: row.fileName,
      mime: row.mime,
      contentBase64: "",
      filePath: row.filePath,
      imageUrl: row.filePath || undefined,
      createdAt: row.createdAt.toISOString(),
    });
    map.set(row.orderId, list);
  }
  return map;
}
