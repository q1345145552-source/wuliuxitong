// B-4c: 已从 node:sqlite 迁移到 Prisma + PostgreSQL（2026-05-20）
import { prisma } from "../../db/prisma";
import { BusinessError } from "../core/business-error";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";

type ClientAddressRow = {
  id: string;
  companyId: string;
  clientId: string;
  contactName: string;
  contactPhone: string;
  addressDetail: string;
  lat: { toString(): string } | null;
  lng: { toString(): string } | null;
  label: string | null;
  isDefault: number;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * 将数据库行映射为前端需要的地址对象。
 */
function toAddressPayload(row: ClientAddressRow) {
  return {
    id: row.id,
    companyId: row.companyId,
    clientId: row.clientId,
    contactName: row.contactName,
    contactPhone: row.contactPhone,
    addressDetail: row.addressDetail,
    lat: row.lat !== null ? Number(row.lat.toString()) : undefined,
    lng: row.lng !== null ? Number(row.lng.toString()) : undefined,
    label: row.label ?? undefined,
    isDefault: row.isDefault === 1,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * 校验并标准化经纬度输入。
 */
function normalizeCoord(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

/**
 * 注册客户端地址簿相关接口。
 */
export function registerClientAddressRoutes(app: MinimalHttpApp): void {
  app.get("/client/addresses", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    const rows = await prisma.clientAddress.findMany({
      where: { companyId: auth.companyId, clientId: auth.userId },
      orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
    });
    ok(res, { items: rows.map(toAddressPayload) });
  });

  app.post("/client/addresses", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      contactName?: string;
      contactPhone?: string;
      addressDetail?: string;
      lat?: unknown;
      lng?: unknown;
      label?: string;
      isDefault?: boolean;
    };
    const contactName = body.contactName?.trim();
    const contactPhone = body.contactPhone?.trim();
    const addressDetail = body.addressDetail?.trim();
    if (!contactName || !contactPhone || !addressDetail) {
      fail(res, 400, "BAD_REQUEST", "contactName, contactPhone and addressDetail are required");
      return;
    }
    const lat = normalizeCoord(body.lat);
    const lng = normalizeCoord(body.lng);
    // 2026-08-31：加随机后缀防止同一毫秒两条地址撞号（与员工端建地址的写法保持一致）
    const id = `addr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const isDefault = body.isDefault ? 1 : 0;

    // 事务：若设为默认地址，先把同一客户的所有地址 isDefault 置 0，再插入新地址
    const created = await prisma.$transaction(async (tx) => {
      /* 先锁这个客户（用户那一行），同一个客户改默认地址的请求排队（2026-09-29 Codex 全系统检查）：
         原来一个地址都没有时，两个「新增并设为默认」同时进来，各自「把别的清成非默认」都清了个空，
         然后各插一条默认 —— 地址簿里两个「默认」。 */
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${auth.userId} AND company_id = ${auth.companyId} FOR UPDATE`;
      if (isDefault === 1) {
        await tx.clientAddress.updateMany({
          where: { companyId: auth.companyId, clientId: auth.userId },
          data: { isDefault: 0 },
        });
      }
      return tx.clientAddress.create({
        data: {
          id,
          companyId: auth.companyId,
          clientId: auth.userId,
          contactName,
          contactPhone,
          addressDetail,
          lat,
          lng,
          label: body.label?.trim() || null,
          isDefault,
        },
      });
    });

    ok(res, toAddressPayload(created));
  });

  app.post("/client/addresses/set-default", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    const body = (req.body ?? {}) as { id?: string };
    const id = body.id?.trim();
    if (!id) {
      fail(res, 400, "BAD_REQUEST", "id is required");
      return;
    }
    const existed = await prisma.clientAddress.findFirst({
      where: { id, companyId: auth.companyId, clientId: auth.userId },
      select: { id: true },
    });
    if (!existed) {
      fail(res, 404, "NOT_FOUND", "address not found");
      return;
    }
    const updatedAt = new Date();
    await prisma.$transaction(async (tx) => {
      // 跟新增地址那条同一把锁（先锁这个客户），两边排队（2026-09-29）
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${auth.userId} AND company_id = ${auth.companyId} FOR UPDATE`;
      await tx.clientAddress.updateMany({
        where: { companyId: auth.companyId, clientId: auth.userId },
        data: { isDefault: 0 },
      });
      const set = await tx.clientAddress.updateMany({
        where: { id, companyId: auth.companyId, clientId: auth.userId },
        data: { isDefault: 1, updatedAt },
      });
      // 这条地址刚被删了：整次回滚（别把别的地址都清成「非默认」却没有新默认）
      if (set.count === 0) throw new BusinessError("这个地址刚刚已经被删掉了，请刷新后再看", 404, "NOT_FOUND");
    });
    ok(res, { id, isDefault: true, updatedAt: updatedAt.toISOString() });
  });

  app.delete("/client/addresses", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    const id = req.query.id?.trim();
    if (!id) {
      fail(res, 400, "BAD_REQUEST", "id is required");
      return;
    }
    const result = await prisma.clientAddress.deleteMany({
      where: { id, companyId: auth.companyId, clientId: auth.userId },
    });
    ok(res, { deleted: result.count > 0, id });
  });
}
