// B-3 ~ B-7: 已从 node:sqlite 迁移到 Prisma + PostgreSQL（2026-05-18）
import { prisma } from "../../db/prisma";

/** 单个订单最多保存的产品详情图数量。 */
export const MAX_ORDER_PRODUCT_IMAGES = 999;

/**
 * 客户只能在「下预报单那一下」附照片（2026-10-24 老板：不给客户任何编辑订单照片的权限）。
 * 页面是建完单马上一张张传，30 分钟够慢网络把十来张大图传完；过了就算「改」，要补找客服。
 */
export const CLIENT_PREALERT_PHOTO_WINDOW_MS = 30 * 60 * 1000;
export const CLIENT_PHOTO_LOCKED_MESSAGE = "预报单提交以后，照片就不能再加了；要补照片请联系客服";

export type OrderProductImagePayload = {
  id: string;
  fileName: string;
  mime: string;
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
      imageUrl: row.filePath || undefined,
      createdAt: row.createdAt.toISOString(),
    });
    map.set(row.orderId, list);
  }
  return map;
}
