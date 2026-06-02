import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";

const DEFAULT_CONFIG = {
  sea_min_volume: "0.5",
  land_min_volume: "0.3",
};

/**
 * 获取计费配置（最低计费体积）。
 */
async function getConfig(): Promise<Record<string, string>> {
  const rows = await prisma.aiStatusLabel.findMany({
    where: { status: { startsWith: "min_volume_" } },
    select: { status: true, labelZh: true },
  });
  const config: Record<string, string> = {};
  for (const row of rows) {
    const key = row.status.replace("min_volume_", "");
    config[key] = row.labelZh;
  }
  return { ...DEFAULT_CONFIG, ...config };
}

/**
 * 保存计费配置。
 */
async function saveConfig(key: string, value: string): Promise<void> {
  const dbKey = `min_volume_${key}`;
  await prisma.aiStatusLabel.upsert({
    where: { status: dbKey },
    create: { status: dbKey, labelZh: value },
    update: { labelZh: value },
  });
}

// ── Default price seeds ──
const DEFAULT_PRICES: Array<{ transportMode: string; cargoType: string; unitPriceCny: number }> = [
  { transportMode: "sea", cargoType: "normal", unitPriceCny: 550 },
  { transportMode: "sea", cargoType: "inspection", unitPriceCny: 700 },
  { transportMode: "sea", cargoType: "sensitive", unitPriceCny: 800 },
  { transportMode: "land", cargoType: "normal", unitPriceCny: 1070 },
  { transportMode: "land", cargoType: "inspection", unitPriceCny: 1250 },
  { transportMode: "land", cargoType: "sensitive", unitPriceCny: 1350 },
];

export function registerShippingConfigRoutes(app: MinimalHttpApp): void {
  // 获取计费配置（低消）
  app.get("/admin/shipping/config", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "staff", "client"]);
    if (!auth) return;
    const config = await getConfig();
    ok(res, config);
  });

  // 更新计费配置（仅管理员）
  app.post("/admin/shipping/config", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      sea_min_volume?: string;
      land_min_volume?: string;
    };
    if (body.sea_min_volume !== undefined) {
      await saveConfig("sea_min_volume", body.sea_min_volume);
    }
    if (body.land_min_volume !== undefined) {
      await saveConfig("land_min_volume", body.land_min_volume);
    }
    const config = await getConfig();
    ok(res, config);
  });

  // ── 运费价格管理 ──

  // 获取所有价格（默认 + 各客户专属）
  app.get("/admin/shipping/rates", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const rows = await prisma.pricingRule.findMany({
      where: { companyId: auth.companyId },
      orderBy: [{ customerId: "asc" }, { transportMode: "asc" }, { cargoType: "asc" }],
    });
    ok(res, {
      items: rows.map((r) => ({
        id: r.id,
        transportMode: r.transportMode,
        cargoType: r.cargoType,
        customerId: r.customerId,
        customerName: null as string | null,
        unitPriceCny: Number(r.unitPriceCny.toString()),
        disableMinVolume: r.disableMinVolume,
      })),
      defaults: DEFAULT_PRICES,
    });
  });

  // 保存/更新价格
  app.post("/admin/shipping/rates", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      id?: string;
      transportMode?: string;
      cargoType?: string;
      customerId?: string | null;
      unitPriceCny?: number;
      disableMinVolume?: boolean;
    };
    const tm = body.transportMode;
    const ct = body.cargoType;
    if (!tm || !ct || typeof body.unitPriceCny !== "number") {
      fail(res, 400, "BAD_REQUEST", "transportMode, cargoType, unitPriceCny required");
      return;
    }
    if (!["sea", "land"].includes(tm)) { fail(res, 400, "BAD_REQUEST", "invalid transportMode"); return; }
    if (!["normal", "inspection", "sensitive"].includes(ct)) { fail(res, 400, "BAD_REQUEST", "invalid cargoType"); return; }

    const data = {
      companyId: auth.companyId,
      transportMode: tm,
      cargoType: ct,
      customerId: body.customerId ?? null,
      unitPriceCny: body.unitPriceCny,
      disableMinVolume: body.disableMinVolume ?? false,
      effectiveFrom: new Date(),
    };

    if (body.id) {
      await prisma.pricingRule.updateMany({
        where: { id: body.id, companyId: auth.companyId },
        data,
      });
    } else {
      await prisma.pricingRule.create({ data });
    }
    ok(res, { saved: true });
  });

  // 删除价格
  app.delete("/admin/shipping/rates", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const id = req.query.id?.trim();
    if (!id) { fail(res, 400, "BAD_REQUEST", "id required"); return; }
    await prisma.pricingRule.deleteMany({
      where: { id, companyId: auth.companyId },
    });
    ok(res, { deleted: true });
  });

  // 客户端获取有效价格
  app.get("/client/shipping/prices", async (req, res) => {
    const auth = requireRole(req, res, ["client", "staff", "admin"]);
    if (!auth) return;
    const clientId = (req.query.clientId?.trim() || auth.userId);

    const rows = await prisma.pricingRule.findMany({
      where: {
        companyId: auth.companyId,
        OR: [
          { customerId: null },
          { customerId: clientId },
        ],
      },
    });

    // Merge: client overrides take priority
    const priceMap = new Map<string, { unitPriceCny: number; disableMinVolume: boolean }>();
    for (const r of rows) {
      const key = `${r.transportMode}|${r.cargoType}`;
      if (r.customerId === clientId) {
        priceMap.set(key, { unitPriceCny: Number(r.unitPriceCny.toString()), disableMinVolume: r.disableMinVolume });
      } else if (r.customerId === null && !priceMap.has(key)) {
        priceMap.set(key, { unitPriceCny: Number(r.unitPriceCny.toString()), disableMinVolume: false });
      }
    }

    const result: Record<string, { unitPriceCny: number; disableMinVolume: boolean }> = {};
    for (const d of DEFAULT_PRICES) {
      const key = `${d.transportMode}|${d.cargoType}`;
      result[key] = priceMap.get(key) ?? { unitPriceCny: d.unitPriceCny, disableMinVolume: false };
    }

    ok(res, result);
  });
}
