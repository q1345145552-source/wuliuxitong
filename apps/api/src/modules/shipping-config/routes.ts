import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";

const DEFAULT_CONFIG = {
  sea_min_volume: "0.5",
  land_min_volume: "0.2",
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

export function registerShippingConfigRoutes(app: MinimalHttpApp): void {
  // 获取配置
  app.get("/admin/shipping/config", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "staff", "client"]);
    if (!auth) return;
    const config = await getConfig();
    ok(res, config);
  });

  // 更新配置（仅管理员）
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
}
