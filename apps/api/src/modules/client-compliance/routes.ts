// B-4b: 已从 node:sqlite 迁移到 Prisma + PostgreSQL（2026-05-20）
import type { DatabaseSync } from "node:sqlite";
import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { refreshCnyThbRateIfStale } from "../exchange-rate/rate-sync";

/**
 * 注册多币种账户接口。
 */
export function registerClientComplianceRoutes(app: MinimalHttpApp, _db: DatabaseSync): void {
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

  // 获取所有客户备注
  app.get("/staff/lastmile/notes", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const rows = await prisma.clientNote.findMany({
      where: { companyId: auth.companyId },
      select: { clientId: true, content: true, updatedAt: true },
    });
    const map: Record<string, { content: string; updatedAt: string }> = {};
    for (const r of rows) {
      map[r.clientId] = { content: r.content, updatedAt: r.updatedAt.toISOString() };
    }
    ok(res, map);
  });

  // 保存客户备注（仅管理员）
  app.post("/admin/shipping/notes", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as { clientId?: string; content?: string };
    const clientId = body.clientId?.trim();
    if (!clientId) { fail(res, 400, "BAD_REQUEST", "clientId required"); return; }
    await prisma.clientNote.upsert({
      where: { clientId },
      create: { companyId: auth.companyId, clientId, content: body.content ?? "" },
      update: { content: body.content ?? "" },
    });
    ok(res, { saved: true });
  });
  // 员工端创建客户地址
  app.post("/staff/client-addresses", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      clientId?: string;
      contactName?: string;
      contactPhone?: string;
      addressDetail?: string;
      label?: string;
    };
    const clientId = body.clientId?.trim();
    if (!clientId) { fail(res, 400, "BAD_REQUEST", "clientId required"); return; }
    if (!body.contactName?.trim()) { fail(res, 400, "BAD_REQUEST", "contactName required"); return; }
    if (!body.contactPhone?.trim()) { fail(res, 400, "BAD_REQUEST", "contactPhone required"); return; }
    if (!body.addressDetail?.trim()) { fail(res, 400, "BAD_REQUEST", "addressDetail required"); return; }
    const addr = await prisma.clientAddress.create({
      data: {
        id: `addr_${Date.now()}`,
        companyId: auth.companyId,
        clientId,
        contactName: body.contactName.trim(),
        contactPhone: body.contactPhone.trim(),
        addressDetail: body.addressDetail.trim(),
        label: body.label?.trim() || null,
      },
    });
    ok(res, { id: addr.id, created: true });
  });
}