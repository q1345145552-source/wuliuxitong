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
}
