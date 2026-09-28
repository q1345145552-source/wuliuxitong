import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { requireDecimal } from "../core/decimal-guard";
import { parseNumericStrict } from "../core/int-guard";
import { DEFAULT_SHIPPING_PRICES, INSPECTION_SURCHARGE, SENSITIVE_SURCHARGE } from "../../../../../packages/shared-types/constants";

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
const { sea, land } = DEFAULT_SHIPPING_PRICES;
const DEFAULT_PRICES: Array<{ transportMode: string; cargoType: string; unitPriceCny: number }> = [
  { transportMode: "sea", cargoType: "normal", unitPriceCny: sea },
  { transportMode: "sea", cargoType: "inspection", unitPriceCny: sea + INSPECTION_SURCHARGE },
  { transportMode: "sea", cargoType: "sensitive", unitPriceCny: sea + SENSITIVE_SURCHARGE },
  { transportMode: "land", cargoType: "normal", unitPriceCny: land },
  { transportMode: "land", cargoType: "inspection", unitPriceCny: land + INSPECTION_SURCHARGE },
  { transportMode: "land", cargoType: "sensitive", unitPriceCny: land + SENSITIVE_SURCHARGE },
];

export function registerShippingConfigRoutes(app: MinimalHttpApp): void {
  // 获取计费配置（低消）
  // 2026-08-31：去掉 client——低消是计费规则的一部分，按「价格不让客户看」的既定规矩
  // 收回客户权限（运费单价接口 2026-08-07 已收回，这个当时漏了）。客户端没有调用方，不影响页面。
  app.get("/admin/shipping/config", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "staff"]);
    if (!auth) return;
    const config = await getConfig();
    ok(res, config);
  });

  // 更新计费配置（仅管理员）
  app.post("/admin/shipping/config", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      sea_min_volume?: unknown;
      land_min_volume?: unknown;
    };
    /* 低消先两个都校验完再存（2026-09-28 审查报告第 22 条）：原来什么都收，
       清空也能存成空的 —— 员工导出算「计费体积」时 Number("") 是 0，等于低消悄悄没了。
       必须是数字、不小于 0（0 = 不设低消）、最多 3 位小数。有一个不对就一个都不存，免得只存了一半。 */
    const toSave: Array<[string, string]> = [];
    for (const [key, label] of [["sea_min_volume", "海运低消"], ["land_min_volume", "陆运低消"]] as const) {
      const raw = body[key];
      if (raw === undefined) continue;
      const text = raw === null ? "" : String(raw).trim();
      if (text === "") { fail(res, 400, "VALIDATION_ERROR", `${label}不能空着（不设低消就填 0）`); return; }
      const issue = requireDecimal(parseNumericStrict(text), label, { precision: 10, scale: 3, min: 0 });
      if (issue) { fail(res, 400, "VALIDATION_ERROR", issue); return; }
      toSave.push([key, text]);
    }
    for (const [key, text] of toSave) await saveConfig(key, text);
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
      items: rows
        .filter((r) => Number(r.unitPriceCny.toString()) > 0) // 过滤占位记录
        .map((r) => ({
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
    /**
     * ⚠️ 光判 `typeof === "number"` 不够（2026-08-27 补）：
     * `NaN` 和 `Infinity` 也是 number，会一路走到数据库那里才炸，
     * 用户看到的是「服务器错误」而不是「单价填得不对」；负数则会存进一个负价格。
     */
    if (!Number.isFinite(body.unitPriceCny) || body.unitPriceCny < 0) {
      fail(res, 400, "BAD_REQUEST", "单价必须是 0 或正数");
      return;
    }
    if (body.unitPriceCny > 10_000_000) {
      fail(res, 400, "BAD_REQUEST", "单价超出合理范围，请核对后重填");
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

  // 获取单个客户的专属配置（价格 + 低消）
  app.get("/admin/shipping/client-config", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const clientId = req.query.clientId?.trim();
    if (!clientId) { fail(res, 400, "BAD_REQUEST", "clientId required"); return; }
    const rows = await prisma.pricingRule.findMany({
      where: { companyId: auth.companyId, customerId: clientId },
    });
    const prices: Record<string, number> = {};
    let disableMinVolume = false;
    for (const r of rows) {
      const price = Number(r.unitPriceCny.toString());
      if (price <= 0) continue; // 跳过占位记录
      const key = `${r.transportMode}|${r.cargoType}`;
      prices[key] = price;
      if (r.disableMinVolume) disableMinVolume = true;
    }
    // 检查是否有专门的 disableMinVolume 占位记录
    if (!disableMinVolume) {
      disableMinVolume = rows.some((r) => r.disableMinVolume && Number(r.unitPriceCny.toString()) <= 0);
    }
    ok(res, { clientId, prices, disableMinVolume });
  });

  // 批量保存客户专属价格
  app.post("/admin/shipping/client-config", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      clientId?: string;
      prices?: Record<string, number>;
      disableMinVolume?: boolean;
    };
    const clientId = body.clientId?.trim();
    if (!clientId) { fail(res, 400, "BAD_REQUEST", "clientId required"); return; }

    // 删除该客户现有所有配置
    await prisma.pricingRule.deleteMany({
      where: { companyId: auth.companyId, customerId: clientId },
    });

    // 保存新价格
    const prices = body.prices ?? {};
    const entries = Object.entries(prices).filter(([, v]) => typeof v === "number" && v > 0);
    for (const [key, price] of entries) {
      const [transportMode, cargoType] = key.split("|");
      if (!transportMode || !cargoType) continue;
      await prisma.pricingRule.create({
        data: {
          companyId: auth.companyId,
          transportMode,
          cargoType,
          customerId: clientId,
          unitPriceCny: price,
          disableMinVolume: body.disableMinVolume ?? false,
          effectiveFrom: new Date(),
        },
      });
    }
    // 仅设置低消 flag 但没有价格时：创建占位记录
    if (body.disableMinVolume && entries.length === 0) {
      await prisma.pricingRule.create({
        data: {
          companyId: auth.companyId,
          transportMode: "sea",
          cargoType: "normal",
          customerId: clientId,
          unitPriceCny: 0,
          disableMinVolume: true,
          effectiveFrom: new Date(),
        },
      });
    }

    ok(res, { saved: true });
  });

  // 客户端获取有效价格
  /**
   * 查客户的运费单价。
   *
   * 2026-08-07：客户角色已被移出白名单 —— 用户要求「价格不要让客户看到」。
   * 客户端那块「运费计算器」（唯一的客户侧消费方）同日整块下线，
   * 所以这里收回客户权限不会让任何界面报错。
   * 路径里的 /client/ 是历史命名，别据此以为客户能调。
   */
  app.get("/client/shipping/prices", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
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
    let clientMinDisabled = false;
    for (const r of rows) {
      const price = Number(r.unitPriceCny.toString());
      if (r.customerId === clientId) {
        if (r.disableMinVolume) clientMinDisabled = true;
        if (price <= 0) continue; // 跳过占位记录
        const key = `${r.transportMode}|${r.cargoType}`;
        priceMap.set(key, { unitPriceCny: price, disableMinVolume: r.disableMinVolume });
      } else if (r.customerId === null && !priceMap.has(`${r.transportMode}|${r.cargoType}`)) {
        priceMap.set(`${r.transportMode}|${r.cargoType}`, { unitPriceCny: price, disableMinVolume: false });
      }
    }

    const result: Record<string, { unitPriceCny: number; disableMinVolume: boolean }> = {};
    for (const d of DEFAULT_PRICES) {
      const key = `${d.transportMode}|${d.cargoType}`;
      const entry = priceMap.get(key) ?? { unitPriceCny: d.unitPriceCny, disableMinVolume: false };
      result[key] = { unitPriceCny: entry.unitPriceCny, disableMinVolume: entry.disableMinVolume || clientMinDisabled };
    }

    ok(res, result);
  });
}
