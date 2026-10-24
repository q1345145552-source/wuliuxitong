// B-3 ~ B-7: 已从 node:sqlite 迁移到 Prisma + PostgreSQL（2026-05-18）
import { prisma } from "../../db/prisma";

/** 单个订单最多保存的产品详情图数量。 */
export const MAX_ORDER_PRODUCT_IMAGES = 999;

/**
 * 客户只能在「下预报单那一下」附照片（2026-10-24 老板：不给客户任何编辑订单照片的权限）。
 * 页面是建完单马上一张张传原图（不压缩、不限张数），给 1 小时让慢网络把一批大图传完（Codex / dsh 10-24 提过 30 分钟可能不够）；
 * 过了就算「改」，要补找客服。
 */
export const CLIENT_PREALERT_PHOTO_WINDOW_MS = 60 * 60 * 1000;
export const CLIENT_PHOTO_LOCKED_MESSAGE = "预报单提交以后，照片就不能再加了；要补照片请联系客服";

/**
 * 客户能不能往这张单上传照片：客户自己报的预报单（approvalStatus=shipped，只有 /client/prealerts 会写出来；
 * 员工建的单、到货通知转的单是 approved，仓库确认收货变 received）、建好不到 1 小时。归属另外判。
 */
export function clientMayAddOrderPhoto(order: { approvalStatus: string; createdAt: Date }, nowMs: number): boolean {
  return order.approvalStatus === "shipped" && nowMs - order.createdAt.getTime() <= CLIENT_PREALERT_PHOTO_WINDOW_MS;
}

export type OrderProductImagePayload = {
  id: string;
  fileName: string;
  mime: string;
  imageUrl?: string;
  createdAt: string;
};

/**
 * 批量读取订单关联的产品详情图（每单最多 MAX_ORDER_PRODUCT_IMAGES 张，按创建时间升序）。
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
