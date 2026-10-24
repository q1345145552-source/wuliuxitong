// B-3 ~ B-7: 已从 node:sqlite 迁移到 Prisma + PostgreSQL（2026-05-18）
import { Prisma } from "@prisma/client";
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

/**
 * 等锁超时 / 连接池等满 / 撞上死锁：同一张单正好有同事在处理，让人稍后再传（2026-10-24 dsh 第 2、3 轮）。
 * P2028 事务超时、P2024 等连接超时、P2034 写冲突或死锁；PostgreSQL 40P01 死锁、40001 串行化失败（有时包在没认出来的错误里，按原文认）
 */
export function isOrderBusyError(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === "P2028" || e.code === "P2024" || e.code === "P2034") return true;
    const pg = String((e.meta as { code?: unknown } | undefined)?.code ?? "");
    if (pg === "40P01" || pg === "40001") return true;
  }
  if (e instanceof Prisma.PrismaClientKnownRequestError || e instanceof Prisma.PrismaClientUnknownRequestError) {
    return /40P01|40001|deadlock detected/.test(String((e as Error).message ?? ""));
  }
  return false;
}

/**
 * 上传记库那一步抛错以后怎么收尾（2026-10-24 Codex 第 3 轮）：
 *   business —— 业务原因挡下（没存）：删文件、照原因回
 *   saved    —— 回库里查得到这一行：提交其实成功了，只是回话路上出错，按成功回、文件留着
 *   absent   —— 明确查不到：删文件、按出错回
 *   unknown  —— 连「查一下」都失败了：不知道存没存上，文件留着（删了万一库里有，就成了裂图），回「确认不了」
 */
export type FailedUploadOutcome = "business" | "saved" | "absent" | "unknown";
export async function failedUploadOutcome(isBusinessError: boolean, lookupSaved: () => Promise<boolean>): Promise<FailedUploadOutcome> {
  if (isBusinessError) return "business";
  try {
    return (await lookupSaved()) ? "saved" : "absent";
  } catch {
    return "unknown";
  }
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
