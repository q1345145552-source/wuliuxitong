import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail } from "../core/http-utils";
import { logger } from "../core/logger";
import { loadedWeightKg } from "../shipments/split-metrics";
import { productNamesLabel } from "../../../../../packages/shared-types/product-names";
import { bearerMatches, chaipaiConfig } from "./config";
import {
  buildEnvelope,
  containerKey,
  contentHashOf,
  envelopeProblem,
  planBatches,
  validContainerNoInput,
  type ManifestSourceRow,
  type PlannedBatch,
} from "./manifest";

export const MANIFEST_PATH = "/integrations/chaipai/v2/container-manifest";

/**
 * 记住每票清单的版本时间（老板 10-11「4:同意加」清单版本表）。
 *
 * 拆派仓的规则：版本时间一样、内容不一样 → VERSION_CONFLICT（永远改不过来）；版本更新了、货已到仓 → 不覆盖并列成问题。
 * 直接用 Shipment.updatedAt 不行（改装柜件数不动它；回传每写一次状态又会动它），所以这里自己记：
 * 内容摘要没变就沿用原来的版本时间，变了就取 max(现在, 原值 + 1 毫秒)。
 * 一条语句做完、不进事务、不碰运单行锁（这张表故意没有外键）。
 */
async function stableVersions(companyId: string, entries: Array<{ shipmentId: string; hash: string }>): Promise<Map<string, string>> {
  const ids = entries.map((e) => e.shipmentId);
  const hashes = entries.map((e) => e.hash);
  const want = new Map(entries.map((e) => [e.shipmentId, e.hash]));
  for (let attempt = 0; attempt < 2; attempt++) {
    const nowIso = new Date().toISOString();
    await prisma.$executeRaw`
      INSERT INTO chaipai_manifest_versions (shipment_id, company_id, content_hash, version_at, updated_at)
      SELECT t.id, ${companyId}, t.hash, ${nowIso}::timestamp(3), ${nowIso}::timestamp(3)
      FROM unnest(${ids}::text[], ${hashes}::text[]) AS t(id, hash)
      ON CONFLICT (shipment_id) DO UPDATE SET
        company_id = EXCLUDED.company_id,
        content_hash = EXCLUDED.content_hash,
        version_at = GREATEST(EXCLUDED.version_at, chaipai_manifest_versions.version_at + interval '1 millisecond'),
        updated_at = EXCLUDED.updated_at
      WHERE chaipai_manifest_versions.content_hash <> EXCLUDED.content_hash
    `;
    const rows = await prisma.$queryRaw<Array<{ shipment_id: string; content_hash: string; version_at: Date }>>`
      SELECT shipment_id, content_hash, version_at FROM chaipai_manifest_versions WHERE shipment_id = ANY(${ids}::text[])
    `;
    // 读回来的摘要跟自己算的不一样 = 同一时刻有人用不同内容拉了一次，再写一遍（这次的内容版本更新）
    if (rows.length === ids.length && rows.every((r) => want.get(r.shipment_id) === r.content_hash)) {
      return new Map(rows.map((r) => [r.shipment_id, r.version_at.toISOString()]));
    }
  }
  throw new Error("清单版本表两次读回都对不上（同一柜有人在同时拉）");
}

/**
 * GET /integrations/chaipai/v2/container-manifest?containerNo=<柜号>（2026-10-12）
 *
 * 拆派仓到货扫码台来拉一柜的运单资料。不是用户登录，用 CHAIPAI_PULL_SECRET 核对。
 * 回 200 裸 JSON（不套 {code,data} 外壳）；404 没这个柜（整柜也当没有，老板「整柜的是不会走拆派仓的」）；
 * 401 密钥不对；503 开关没开 / 配置不合格。拆派仓只认 200 / 404 / 401，别的都显示「连不上湘泰物流系统」。
 * 只读业务数据，只写对接用的清单版本表。
 */
export function registerChaipaiManifestRoutes(app: MinimalHttpApp): void {
  app.get(MANIFEST_PATH, async (req, res) => {
    const cfg = chaipaiConfig();
    if (!cfg) { fail(res, 503, "INTERNAL_ERROR", "拆派仓对接没有开"); return; }
    if (!bearerMatches(req.headers.authorization, cfg.pullSecret)) {
      logger.warn("拆派仓拉清单：密钥不对");
      fail(res, 401, "UNAUTHORIZED", "密钥不对");
      return;
    }
    const containerNo = validContainerNoInput(req.query.containerNo);
    if (!containerNo) { fail(res, 400, "BAD_REQUEST", "柜号要填，1～64 字，不能有控制字符"); return; }

    // 柜号全库唯一但区分大小写、可能带空格；按拆派仓同一口径（去空白转大写）在 JS 里比，
    // 不用 SQL 的 regexp_replace（它对全角空格这类 Unicode 空白的认法跟 JS 的 \s 不一定一样）
    const key = containerKey(containerNo);
    const all = await prisma.container.findMany({ select: { id: true, containerNo: true, companyId: true, isFcl: true } });
    // 整柜（客户自己包的柜）不给拆派仓：按「没有这个柜号」回 404（第 251 条）
    const matched = all.filter((c) => !c.isFcl && containerKey(c.containerNo) === key);
    if (matched.length === 0) { fail(res, 404, "NOT_FOUND", "没有这个柜号"); return; }
    if (matched.length > 1) {
      logger.error("拆派仓拉清单：柜号同时对上几个柜（只差大小写或空格）", { containerNo, 柜子: matched.map((c) => c.id) });
      fail(res, 409, "VALIDATION_ERROR", "这个柜号在湘泰物流系统里对上了不止一个柜，请联系湘泰改柜号");
      return;
    }
    const container = matched[0];

    // 实际装柜明细（ShipmentContainerItem），不用早已作废的 Shipment.containerNo
    const items = await prisma.shipmentContainerItem.findMany({
      where: { containerId: container.id },
      orderBy: { shipmentId: "asc" },
      select: {
        loadedPieceCount: true,
        loadedVolumeM3: true,
        shipment: {
          select: {
            id: true, trackingNo: true, parentTrackingNo: true, batchNo: true, packageCount: true,
            weightKg: true, itemName: true, transportMode: true, remark: true,
            _count: { select: { containerItems: true } },
            order: {
              select: {
                clientId: true, itemName: true, packageCount: true, weightKg: true, transportMode: true,
                products: { select: { itemName: true, sortOrder: true } },
                shipments: { select: { trackingNo: true, parentTrackingNo: true, packageCount: true, weightKg: true } },
              },
            },
          },
        },
      },
    });

    const rows: ManifestSourceRow[] = [];
    const skipped: Array<{ trackingNo: string; reason: string }> = [];
    for (const item of items) {
      const s = item.shipment;
      // 0 件的汇总父单（货都在子单上）不放
      if (item.loadedPieceCount <= 0) { skipped.push({ trackingNo: s.trackingNo, reason: "本柜 0 件" }); continue; }
      // 一票挂两个柜的老数据（生产 10-12 查过 0 票）：在拆派仓会被两柜来回覆盖，不发，员工按清单外登记
      if (s._count.containerItems > 1) { skipped.push({ trackingNo: s.trackingNo, reason: "挂在不止一个柜里" }); continue; }
      rows.push({
        shipmentId: s.id,
        trackingNo: s.trackingNo,
        parentTrackingNo: s.parentTrackingNo,
        batchNo: s.batchNo,
        clientId: s.order?.clientId ?? "",
        loadedPieceCount: item.loadedPieceCount,
        loadedVolumeM3: Number(item.loadedVolumeM3.toString()),
        // 跟装柜清单导出同一个口径（split-metrics.ts 的 loadedWeightKg）
        weightKg: loadedWeightKg({ shipment: s, order: s.order, loadedPieceCount: item.loadedPieceCount }),
        transportMode: s.transportMode ?? s.order?.transportMode ?? null,
        // 品名把订单全部产品名带上（运单的 itemName 只存了第一个，同装柜清单导出）
        itemName: productNamesLabel(s.order?.products) || s.itemName || s.order?.itemName || null,
        remark: s.remark,
      });
    }
    if (skipped.length > 0) logger.info("拆派仓拉清单：这些票没放进清单", { containerNo: container.containerNo, 剔除: skipped });

    const batches: PlannedBatch[] = planBatches(cfg.companyId, container.id, rows);
    const entries = batches.flatMap((b) => b.items.map((item) => ({
      shipmentId: item.sourceShipmentId,
      hash: contentHashOf(b.batchKey, b.batchNo, item),
    })));
    const versions = entries.length > 0 ? await stableVersions(container.companyId, entries) : new Map<string, string>();
    const envelope = buildEnvelope(cfg.companyId, container.containerNo, batches, (id) => versions.get(id)!);
    const problem = envelopeProblem(envelope);
    if (problem) {
      logger.error("拆派仓拉清单：超出拆派仓的整次上限，没发", { containerNo: container.containerNo, 原因: problem });
      fail(res, 422, "VALIDATION_ERROR", `这个柜的清单超出拆派仓的上限：${problem}`);
      return;
    }
    logger.info("拆派仓拉清单", {
      containerNo: container.containerNo, 票数: entries.length, 份数: envelope.manifests.length, 剔除: skipped.length,
    });
    // 裸 JSON：没有 code 字段，server.ts 不盖章、原样发出
    res.status(200).json(envelope);
  });
}
