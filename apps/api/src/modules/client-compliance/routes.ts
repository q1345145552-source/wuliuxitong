// B-4b: 已从 node:sqlite 迁移到 Prisma + PostgreSQL（2026-05-20）
import type { DatabaseSync } from "node:sqlite";
import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { refreshCnyThbRateIfStale } from "../exchange-rate/rate-sync";

/**
 * 注册客户端合规与多币种账户接口。
 */
export function registerClientComplianceRoutes(app: MinimalHttpApp, _db: DatabaseSync): void {
  app.get("/client/documents", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    const rows = await prisma.clientDocument.findMany({
      where: { companyId: auth.companyId, clientId: auth.userId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        docType: true,
        fileName: true,
        mime: true,
        contentBase64: true,
        createdAt: true,
      },
    });
    ok(res, {
      items: rows.map((item) => ({
        id: item.id,
        docType: item.docType,
        fileName: item.fileName,
        mime: item.mime,
        contentBase64: item.contentBase64,
        createdAt: item.createdAt.toISOString(),
      })),
    });
  });

  app.post("/client/documents", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      docType?: string;
      fileName?: string;
      mime?: string;
      contentBase64?: string;
    };
    const docType = body.docType?.trim();
    const fileName = body.fileName?.trim();
    const mime = body.mime?.trim();
    const contentBase64 = body.contentBase64?.trim();
    if (!docType || !fileName || !mime || !contentBase64) {
      fail(res, 400, "BAD_REQUEST", "docType, fileName, mime and contentBase64 are required");
      return;
    }
    if (contentBase64.length > 4_000_000) {
      fail(res, 400, "BAD_REQUEST", "file too large (max 4MB base64)");
      return;
    }
    const id = `doc_${Date.now()}`;
    const created = await prisma.clientDocument.create({
      data: {
        id,
        companyId: auth.companyId,
        clientId: auth.userId,
        docType,
        fileName,
        mime,
        contentBase64,
      },
      select: { id: true, docType: true, fileName: true, mime: true, createdAt: true },
    });
    ok(res, {
      id: created.id,
      docType: created.docType,
      fileName: created.fileName,
      mime: created.mime,
      createdAt: created.createdAt.toISOString(),
    });
  });

  app.delete("/client/documents", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    const id = req.query.id?.trim();
    if (!id) {
      fail(res, 400, "BAD_REQUEST", "id is required");
      return;
    }
    const result = await prisma.clientDocument.deleteMany({
      where: { id, companyId: auth.companyId, clientId: auth.userId },
    });
    ok(res, { deleted: result.count > 0, id });
  });

  app.get("/client/wallet/overview", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    const rateSnapshot = await refreshCnyThbRateIfStale();
    const accountRows = await prisma.clientWalletAccount.findMany({
      where: { companyId: auth.companyId, clientId: auth.userId },
      orderBy: { currency: "asc" },
      select: { currency: true, balance: true, updatedAt: true },
    });
    ok(res, {
      accounts: accountRows.map((item) => ({
        currency: item.currency,
        balance: Number(item.balance.toString()),
        updatedAt: item.updatedAt.toISOString(),
      })),
      exchangeRate: {
        pair: "CNY/THB",
        rate: rateSnapshot.rate,
        updatedAt: rateSnapshot.updatedAt,
      },
    });
  });
}
