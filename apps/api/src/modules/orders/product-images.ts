// B-3 ~ B-7: 已从 node:sqlite 迁移到 Prisma + PostgreSQL（2026-05-18）
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import { BusinessError } from "../core/business-error";
import type { ErrorCode } from "../core/http-utils";
import type { UserRole } from "../../../../../packages/shared-types/role";

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
 * 等锁超时 / 连接池等满 / 撞上死锁：同一张单正好有同事在处理，让人稍后再传（2026-10-24 dsh 第 2～4 轮）。
 * P2028 事务超时或开不了事务、P2024 等连接超时、P2034 写冲突或死锁；PostgreSQL 40P01 死锁、40001 串行化失败。
 * 没认出来的错误按 PostgreSQL 的原话认（不按 40001 这种裸数字认 —— 唯一键的值里也可能有这串数字，dsh 第 4 轮）
 */
export function isOrderBusyError(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === "P2028" || e.code === "P2024" || e.code === "P2034") return true;
    const pg = String((e.meta as { code?: unknown } | undefined)?.code ?? "");
    if (pg === "40P01" || pg === "40001") return true;
  } else if (!(e instanceof Prisma.PrismaClientUnknownRequestError)) {
    return false;
  }
  // 原话或引擎写的结构化代码（code: "40P01"），不认裸数字
  return /deadlock detected|could not serialize access|code: "(?:40P01|40001)"/i.test(String(e.message ?? ""));
}

/** 上传记库失败以后：文件留不留、回什么话。客户的话不说「再传一次」（客户页面没有重传入口，页面自己会接一句「联系客服补上」） */
export type FailedUploadAction = {
  keepFile: boolean;
  respond: { kind: "ok" } | { kind: "fail"; status: number; code: ErrorCode; message: string };
};
const failWith = (status: number, code: ErrorCode, message: string): FailedUploadAction["respond"] => ({ kind: "fail", status, code, message });

/** 照片没存上（服务器出错）的提示；写磁盘失败那条也用它（Codex 第 5 轮：原来那条对客户也说「再传一次」） */
export function saveFailedMessage(role: UserRole): string {
  return role === "client" ? "图片没存上（服务器出错）" : "图片没存上（服务器出错），请稍后再传一次；反复出现请联系技术";
}

/**
 * 上传订单照片：文件已经写到磁盘、记库那一步抛错以后怎么收尾（2026-10-24 Codex 第 3～5 轮 / dsh 第 4 轮）。
 * 按「出错时那一行插进去没有」（insertedBeforeError，事务里 create 成功后才置 true）分，不按错误种类猜：
 *   还没插进去：提交根本不会发出去，肯定没存上 —— 删文件；同事在处理回 409，业务原因照原因回，其余 500
 *   已经插进去：错是在提交那一下出的（连接断了、P2028 提交超时……Prisma 5.22 把提交也算在事务期限里，Codex 第 5 轮），拿不准 ——
 *           回库里查这一行（lookupSaved）：查得到说明其实存上了，按成功回、文件留着；
 *           查不到或连查都失败，文件也留着（可能提交还没看得见，删了就是裂图；宁可多一个没人用的文件），回「确认不了，请刷新看看」
 */
export async function failedUploadAction(err: unknown, role: UserRole, insertedBeforeError: boolean, lookupSaved: () => Promise<boolean>): Promise<FailedUploadAction> {
  const client = role === "client";
  if (err instanceof BusinessError) return { keepFile: false, respond: failWith(err.httpStatus, err.code, err.message) };
  if (!insertedBeforeError) {
    if (isOrderBusyError(err)) {
      return { keepFile: false, respond: failWith(409, "VALIDATION_ERROR", client ? "这张单刚好有同事在处理，照片没存上" : "这张单刚好有同事在处理，照片没存上，请稍后再传一次") };
    }
    return { keepFile: false, respond: failWith(500, "INTERNAL_ERROR", saveFailedMessage(role)) };
  }
  const unsure = failWith(500, "INTERNAL_ERROR", client ? "这张照片存没存上暂时确认不了，请刷新页面看一下" : "这张照片存没存上暂时确认不了，请刷新页面看一下，没有的话再传一次");
  try {
    return (await lookupSaved()) ? { keepFile: true, respond: { kind: "ok" } } : { keepFile: true, respond: unsure };
  } catch {
    return { keepFile: true, respond: unsure };
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
