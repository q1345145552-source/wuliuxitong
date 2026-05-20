// B-4c: 已从 node:sqlite 迁移到 Prisma + PostgreSQL（2026-05-20）
import type { DatabaseSync } from "node:sqlite";
import { prisma } from "../../db/prisma";
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
export function registerClientAddressRoutes(app: MinimalHttpApp, _db: DatabaseSync): void {
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
    const id = `addr_${Date.now()}`;
    const isDefault = body.isDefault ? 1 : 0;

    // 事务：若设为默认地址，先把同一客户的所有地址 isDefault 置 0，再插入新地址
    const created = await prisma.$transaction(async (tx) => {
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
    await prisma.$transaction([
      prisma.clientAddress.updateMany({
        where: { companyId: auth.companyId, clientId: auth.userId },
        data: { isDefault: 0 },
      }),
      prisma.clientAddress.update({
        where: { id },
        data: { isDefault: 1, updatedAt },
      }),
    ]);
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
