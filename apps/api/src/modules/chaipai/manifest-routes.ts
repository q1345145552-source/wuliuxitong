import { Prisma } from "@prisma/client";
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
  manifestParts,
  planBatches,
  validContainerNoInput,
  validWaybillNoInput,
  WAYBILL_MAX_SHIPMENTS,
  type ManifestPart,
  type ManifestSourceRow,
  type PlannedBatch,
  type WaybillManifestEnvelope,
} from "./manifest";

import { MANIFEST_PATH, WAYBILL_MANIFEST_PATH } from "./paths";

/**
 * 拉清单要读的一票资料。按柜拉、按运单号取两条路**共用这一份**（字段、重量算法、品名口径一模一样），
 * 这样同一个柜的票不管哪条路取的，在拆派仓里都进同一个批次、版本也一样（10-13）。
 */
const MANIFEST_SHIPMENT_SELECT = {
  id: true, trackingNo: true, parentTrackingNo: true, batchNo: true, packageCount: true,
  weightKg: true, itemName: true, transportMode: true, remark: true,
  _count: { select: { containerItems: true } },
  order: {
    select: {
      clientId: true, itemName: true, packageCount: true, weightKg: true, transportMode: true,
      // 排序写死（sortOrder 可能重复）：产品名拼串前后两次读必须一样，不然提交前那道比对会误报「正忙」（dsh 10-13 第 3 轮）
      products: { select: { itemName: true, sortOrder: true }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }] as Prisma.OrderProductOrderByWithRelationInput[] },
      shipments: { select: { trackingNo: true, parentTrackingNo: true, packageCount: true, weightKg: true } },
    },
  },
} as const;

/** 一条装柜明细 → 发给拆派仓的一票（件数 / 方数是本柜的） */
function sourceRowOf(item: { loadedPieceCount: number; loadedVolumeM3: { toString(): string }; shipment: any }): ManifestSourceRow {
  const s = item.shipment;
  return {
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
  };
}

/** 一批票的版本时间（按公司分开记；清单版本表的 company_id 是湘泰内部的公司） */
async function versionsFor(
  tx: any,
  groups: Array<{ companyId: string; entries: Array<{ shipmentId: string; hash: string }> }>,
  guard?: () => Promise<void>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const byCompany = new Map<string, Array<{ shipmentId: string; hash: string }>>();
  for (const g of groups) byCompany.set(g.companyId, [...(byCompany.get(g.companyId) ?? []), ...g.entries]);
  for (const [companyId, entries] of byCompany) {
    if (entries.length === 0) continue;
    for (const [id, v] of await stableVersions(tx, companyId, entries, guard)) out.set(id, v);
  }
  return out;
}

/**
 * 同一个柜的拉清单排队（咨询锁 83060 + 柜子 id）：读清单和发版本放在同一个事务里、一个一个来。
 * 不排队的话：A 先读到旧方数、员工改了、B 读到新方数先写了版本 T，A 后写拿到 T+1 —— 拆派仓按版本收下 A，
 * 新方数被旧的盖回去（10-12 Codex 审查）。
 */
async function lockChaipaiManifest(tx: any, containerId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(83060, hashtext(${containerId}))`;
}

/**
 * 记住每票清单的版本时间（老板 10-11「4:同意加」清单版本表）。
 *
 * 拆派仓的规则：版本时间一样、内容不一样 → VERSION_CONFLICT（永远改不过来）；版本更新了、货已到仓 → 不覆盖并列成问题。
 * 直接用 Shipment.updatedAt 不行（改装柜件数不动它；回传每写一次状态又会动它），所以这里自己记：
 * 内容摘要没变就沿用原来的版本时间，变了就取 max(现在, 原值 + 1 毫秒)。
 * 在拿着柜子排队锁的事务里调；这张表故意没有外键，不碰运单行锁。
 */
async function stableVersions(
  tx: any,
  companyId: string,
  entries: Array<{ shipmentId: string; hash: string }>,
  /** 按运单号取票传进来：每句之前把数据库时限改成离截止还剩多少（按柜拉不传） */
  guard?: () => Promise<void>,
): Promise<Map<string, string>> {
  const ids = entries.map((e) => e.shipmentId);
  const hashes = entries.map((e) => e.hash);
  const want = new Map(entries.map((e) => [e.shipmentId, e.hash]));
  const nowIso = new Date().toISOString();
  await guard?.();
  await tx.$executeRaw`
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
  await guard?.();
  const rows: Array<{ shipment_id: string; content_hash: string; version_at: Date }> = await tx.$queryRaw`
    SELECT shipment_id, content_hash, version_at FROM chaipai_manifest_versions WHERE shipment_id = ANY(${ids}::text[])
  `;
  if (rows.length !== ids.length || rows.some((r) => want.get(r.shipment_id) !== r.content_hash)) {
    throw new Error("清单版本表读回对不上");
  }
  return new Map(rows.map((r) => [r.shipment_id, r.version_at.toISOString()]));
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
    // 先在全部柜子里对（含整柜）：对上不止一个就报错，别把整柜号对到同名的拼柜上去（10-12 Codex 审查）
    const matched = all.filter((c) => containerKey(c.containerNo) === key);
    if (matched.length > 1) {
      logger.error("拆派仓拉清单：柜号同时对上几个柜（只差大小写或空格）", { containerNo, 柜子: matched.map((c) => c.id) });
      fail(res, 409, "VALIDATION_ERROR", "这个柜号在湘泰物流系统里对上了不止一个柜，请联系湘泰改柜号");
      return;
    }
    // 整柜（客户自己包的柜）不给拆派仓：按「没有这个柜号」回 404（第 251 条）
    if (matched.length === 0 || matched[0].isFcl) { fail(res, 404, "NOT_FOUND", "没有这个柜号"); return; }
    const container = matched[0];

    // 读清单和发版本在同一个事务里、同一个柜排队（见 lockChaipaiManifest）
    const { batches, versions, skipped, entries } = await prisma.$transaction(async (tx) => {
      await lockChaipaiManifest(tx, container.id);
      // 实际装柜明细（ShipmentContainerItem），不用早已作废的 Shipment.containerNo
      const items = await tx.shipmentContainerItem.findMany({
        where: { containerId: container.id },
        orderBy: { shipmentId: "asc" },
        select: { loadedPieceCount: true, loadedVolumeM3: true, shipment: { select: MANIFEST_SHIPMENT_SELECT } },
      });

      const rows: ManifestSourceRow[] = [];
      const skipped: Array<{ trackingNo: string; reason: string }> = [];
      for (const item of items) {
        const s = item.shipment;
        // 0 件的汇总父单（货都在子单上）不放
        if (item.loadedPieceCount <= 0) { skipped.push({ trackingNo: s.trackingNo, reason: "本柜 0 件" }); continue; }
        // 一票挂两个柜的老数据（生产 10-12 查过 0 票）：在拆派仓会被两柜来回覆盖，不发，员工按清单外登记
        if (s._count.containerItems > 1) { skipped.push({ trackingNo: s.trackingNo, reason: "挂在不止一个柜里" }); continue; }
        rows.push(sourceRowOf(item));
      }
      if (skipped.length > 0) logger.info("拆派仓拉清单：这些票没放进清单", { containerNo: container.containerNo, 剔除: skipped });

      const batches: PlannedBatch[] = planBatches(cfg.companyId, container.id, rows);
      const entries = batches.flatMap((b) => b.items.map((item) => ({
        shipmentId: item.sourceShipmentId,
        hash: contentHashOf(b.batchKey, b.batchNo, item),
      })));
      const versions = entries.length > 0 ? await stableVersions(tx, container.companyId, entries) : new Map<string, string>();
      return { batches, versions, skipped, entries };
    }, { timeout: 20000, maxWait: 10000 });
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

  /**
   * GET /integrations/chaipai/v2/waybill-manifest?waybillNo=<运单号>（2026-10-13）
   *
   * 老板 10-13：「不是全部物流系统的货都会走我们自己的拆派仓」，按柜拉的按钮拆派仓已关；改成拆派仓扫到不认识的湘泰运单号，
   * 拿这个号来取这一票，建上以后状态、照片照原来的办法回湘泰。密钥跟按柜拉同一把（CHAIPAI_PULL_SECRET）。
   *
   * 找票（按生产 10-13 的数据定的）：
   *   - 运单号原文精确匹配（只去首尾空格，不改大小写），**再加上**以它为父单号的子票 ——
   *     父单号在湘泰本身也是一票（0 件汇总，货都在 -1、-2 子单上），只认运单号的话扫父单号永远取不到货；
   *     扫子单号就只回那一张子单。生产里父单自己有件数又有子单的 0 票。
   *   - 每票放进**最近装的那个柜**（装柜明细按装柜时间取最新；生产一票挂两个柜的 0 票）。
   *   - 没装过柜的不给（还在国内仓，到不了拆派仓）；最近那个柜是整柜的不给（老板：整柜不走拆派仓）；本柜 0 件的汇总父单不放。
   *     一票都不剩回 404。
   *   - 一个父单的子单分在不同柜（生产 50 单）：每个柜各一份，各带自己的柜号，拆派仓自己按柜分开。
   * 每份的 batchKey / batchNo / 每票的字段、版本时间跟按柜拉**同一套代码**（sourceRowOf、planBatches、contentHashOf、清单版本表）。
   * 拆派仓扫码时最多等 8 秒左右：等连接 0.5 秒 + 事务 5.5 秒，柜子排队等不到就回 503（拆派仓提示员工稍后再扫）。
   * 提交前发现票被挪了柜也回 503；提交后那几毫秒里才挪的，这次发的是旧柜的内容，下一次取版本会更大、自己纠正过来。
   */
  app.get(WAYBILL_MANIFEST_PATH, async (req, res) => {
    const cfg = chaipaiConfig();
    if (!cfg) { fail(res, 503, "INTERNAL_ERROR", "拆派仓对接没有开"); return; }
    if (!bearerMatches(req.headers.authorization, cfg.pullSecret)) {
      logger.warn("拆派仓按运单号取票：密钥不对");
      fail(res, 401, "UNAUTHORIZED", "密钥不对");
      return;
    }
    const rawNo = req.query.waybillNo;
    const waybillNo = validWaybillNoInput(rawNo);
    if (!waybillNo) { fail(res, 400, "BAD_REQUEST", "运单号要填，1～128 字，不能有控制字符"); return; }

    // 最多取到「拆派仓上限 + 2」张（父单本身 + 200 张 + 1 张用来判断超了）：IN 列表有界，Prisma 不会再把查询拆成更多句，
    // 下面按句数分时间才算数（Codex 10-13 第 5 轮；线上一个父单最多 4 张子单）
    const CANDIDATE_CAP = WAYBILL_MAX_SHIPMENTS + 2;
    const findCandidates = (db: any) => db.shipment.findMany({
      take: CANDIDATE_CAP,
      orderBy: { id: "asc" },
      where: { OR: [{ trackingNo: waybillNo }, { parentTrackingNo: waybillNo }] },
      select: { id: true, trackingNo: true, containerItems: { select: { containerId: true } } },
    });
    type Candidate = { id: string; trackingNo: string; containerItems: Array<{ containerId: string }> };
    type Picked = { containerId: string; containerNo: string; companyId: string; row: ManifestSourceRow };
    type Part = { containerNo: string; companyId: string; batches: PlannedBatch[] };
    type Snapshot = {
      picked: Picked[];
      skipped: Array<{ trackingNo: string; reason: string }>;
      parts: Part[];
      groups: Array<{ companyId: string; entries: Array<{ shipmentId: string; hash: string }> }>;
      /** 这几票挂在哪些柜 + 每票要发的内容摘要；前后两次一比，中间有人挪柜 / 改货就看得出来 */
      signature: string;
    };
    /**
     * 时限：guard(n) 在一次 Prisma 调用之前把数据库的 statement_timeout / lock_timeout 设成「剩余时间 ÷ n」——
     * Prisma 一次带关系的查询会按表拆成好几句顺序发出去，每句各算各的时限，按句数平分才不会加起来超（Codex 10-13 第 4 轮）；
     * 已经到点就不再发，直接 503。check() 在每次调用回来以后看一眼是不是已经过了截止。
     */
    // ⚠️ 传进去的句数必须 ≥ Prisma 这次实际会发的句数（硬依赖：少报了，同一次调用里的几句就会各拿一大份、加起来超时）；
    //    第二遍读快照时剩余时间已经少了，每句分到的比第一遍更紧 —— 要加余量只许把总截止往后挪（仍要 < 拆派仓的 8 秒），不许把句数报小（dsh 10-13 第 5 轮）
    type Budget = { guard: (statements?: number) => Promise<void>; check: () => void };
    /**
     * 拿着锁读一遍：重读候选票、取装柜明细、挑最近的柜、按柜排批次、算内容摘要。
     * 排队期间票被挪进没排队的柜（重读时、取明细时各核一次，10-13 dsh 审查）就让拆派仓再扫。
     */
    const readSnapshot = async (tx: any, lockIds: string[], budget: Budget): Promise<Snapshot> => {
      await budget.guard(2); // 运单 + 装柜明细，Prisma 发 2 句
      const fresh: Candidate[] = await findCandidates(tx);
      budget.check();
      if (fresh.some((c) => c.containerItems.some((i) => !lockIds.includes(i.containerId)))) throw new ScanAgainError();
      await budget.guard(8); // Prisma 按关系逐表发：明细、柜、运单、订单、产品、同订单运单，10-13 实测 6 句（_count 在运单那句里），按 8 句分时间留余量
      const items = await tx.shipmentContainerItem.findMany({
        where: { shipmentId: { in: fresh.map((c) => c.id) } },
        orderBy: [{ shipmentId: "asc" }, { createdAt: "desc" }, { containerId: "desc" }],
        select: {
          loadedPieceCount: true, loadedVolumeM3: true, containerId: true,
          container: { select: { containerNo: true, companyId: true, isFcl: true } },
          shipment: { select: MANIFEST_SHIPMENT_SELECT },
        },
      });
      budget.check();
      if (items.some((it: { containerId: string }) => !lockIds.includes(it.containerId))) throw new ScanAgainError();
      const picked: Picked[] = [];
      const skipped: Array<{ trackingNo: string; reason: string }> = [];
      const seen = new Set<string>();
      for (const item of items) {
        // 同一票按装柜时间倒排，第一条就是最近装的柜
        if (seen.has(item.shipment.id)) continue;
        seen.add(item.shipment.id);
        if (item.container.isFcl) { skipped.push({ trackingNo: item.shipment.trackingNo, reason: "整柜" }); continue; }
        if (item.loadedPieceCount <= 0) { skipped.push({ trackingNo: item.shipment.trackingNo, reason: "本柜 0 件" }); continue; }
        picked.push({ containerId: item.containerId, containerNo: item.container.containerNo, companyId: item.container.companyId, row: sourceRowOf(item) });
      }
      for (const c of fresh) if (!seen.has(c.id)) skipped.push({ trackingNo: c.trackingNo, reason: "没装过柜" });

      // 按柜分开排批次（同按柜拉：batchKey 只跟柜子 id 和批次号原文有关），柜子按柜号排
      const byContainer = new Map<string, { containerNo: string; companyId: string; rows: ManifestSourceRow[] }>();
      for (const p of picked) {
        const g = byContainer.get(p.containerId) ?? { containerNo: p.containerNo, companyId: p.companyId, rows: [] };
        g.rows.push(p.row);
        byContainer.set(p.containerId, g);
      }
      const parts = [...byContainer.entries()]
        .sort((a, b) => (a[1].containerNo < b[1].containerNo ? -1 : a[1].containerNo > b[1].containerNo ? 1 : a[0] < b[0] ? -1 : 1))
        .map(([containerId, g]) => ({ containerNo: g.containerNo, companyId: g.companyId, batches: planBatches(cfg.companyId, containerId, g.rows) }));
      const groups = parts.map((p) => ({
        companyId: p.companyId,
        entries: p.batches.flatMap((b) => b.items.map((item) => ({ shipmentId: item.sourceShipmentId, hash: contentHashOf(b.batchKey, b.batchNo, item) }))),
      }));
      const placement = items.map((it: { shipment: { id: string }; containerId: string }) => `${it.shipment.id}:${it.containerId}`).sort().join(",");
      const hashes = groups.flatMap((g) => g.entries.map((e) => `${e.shipmentId}:${e.hash}`)).sort().join(",");
      budget.check();
      return { picked, skipped, parts, groups, signature: `${placement}|${hashes}` };
    };

    type Found = { picked: Picked[]; skipped: Array<{ trackingNo: string; reason: string }>; versions: Map<string, string>; parts: Part[] };
    let result: Found | { notFound: string } | { tooMany: number };
    try {
      // 整个过程（连最开始找票那一句）都在这一个事务里：等连接最多 0.5 秒；事务里每次查询都按「总截止 4.5 秒」分好时间由数据库掐断，
      // Prisma 的 5.5 秒只是兜底 —— 最坏 5 秒多一点有回复，给拆派仓约 8 秒的等待留出传输时间（10-13 Codex / dsh 三轮审查）。
      // 隔离级别写死「读已提交」：每一句都看得到别人刚提交的改动，下面「前后读两遍比一比」才成立，不靠数据库默认设置（Codex 10-13 第 2 轮）
      result = await prisma.$transaction(async (tx): Promise<Found | { notFound: string } | { tooMany: number }> => {
        // 总截止时间（Codex 10-13 第 3 轮）：数据库的 lock_timeout / statement_timeout 都是「这一句」自己计时，
        // 等完柜锁再等版本行锁会各等一遍；Prisma 的事务时限又管不住卡在数据库里的那一句（10-13 实测别人占锁 9 秒就陪等 9 秒）。
        // 所以每一句会碰数据库的语句之前，都把两个时限改成「离截止还剩多少」，到点由数据库自己掐断（55P03 / 57014）→ 503
        const deadline = performance.now() + 4500; // 单调时钟，不受改系统时间影响
        const budget: Budget = {
          guard: async (statements = 1) => {
            // 设时限这一句本身也花时间：设完再看一次钟，花得超过 SLACK 就按新的剩余重设 ——
            // 这样后面那几句最晚在「截止 + SLACK」结束，不会拿着过期的时限跑（Codex 10-13 第 5 轮）
            for (;;) {
              const before = performance.now();
              const left = deadline - before;
              if (left <= 0) throw new DeadlineError();
              const ms = String(Math.max(1, Math.floor(left / statements)));
              await tx.$executeRaw`SELECT set_config('statement_timeout', ${ms}, true), set_config('lock_timeout', ${ms}, true)`;
              if (performance.now() - before <= GUARD_SLACK_MS) return;
            }
          },
          check: () => { if (performance.now() >= deadline) throw new DeadlineError(); },
        };
        await budget.guard(2);
        const candidates: Candidate[] = await findCandidates(tx);
        budget.check();
        if (candidates.length === 0) return { notFound: "没有这个运单号" };
        if (candidates.length >= CANDIDATE_CAP) return { tooMany: candidates.length };
        // 按这几票挂过的全部柜子排队（按 id 排好、一个一个拿，跟按柜拉同一把锁、不会互相卡死）
        const lockIds = [...new Set(candidates.flatMap((c) => c.containerItems.map((i) => i.containerId)))].sort();
        if (lockIds.length === 0) return { notFound: "这票还没装柜" };
        for (const id of [...lockIds].sort()) {
          await budget.guard();
          await lockChaipaiManifest(tx, id);
          budget.check();
        }
        const snap = await readSnapshot(tx, lockIds, budget);
        // 超过拆派仓一次能收的票数：不写版本、不发（拆派仓收到也会整次拒收）
        budget.check();
        if (snap.picked.length > WAYBILL_MAX_SHIPMENTS) return { tooMany: snap.picked.length };
        const versions = await versionsFor(tx, snap.groups, () => budget.guard());
        budget.check();
        // 版本写下以后、提交以前原样再读一遍：中间票被挪了柜（哪怕挪走又挪回）或内容被改了，这次发的就是旧内容，
        // 写下的版本却可能比别处拉到的新内容还大（拆派仓按版本收，旧的盖掉新的）—— 整次撤回、让拆派仓再扫（10-13 Codex 两轮审查）
        if ((await readSnapshot(tx, lockIds, budget)).signature !== snap.signature) throw new ScanAgainError();
        budget.check();
        return { picked: snap.picked, skipped: snap.skipped, versions, parts: snap.parts };
      }, { timeout: 5500, maxWait: 500, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (error) {
      const code = (error as { code?: string })?.code;
      // P2028 等不到连接 / 事务超时，P2034 写冲突或死锁，P2024 连接池等超时：都让拆派仓稍后再扫；别的照常 500
      if (error instanceof ScanAgainError || error instanceof DeadlineError || (error as { name?: string })?.name === "DeadlineError" || code === "P2028" || code === "P2034" || code === "P2024" || isDbTimeout(error)) {
        const why = error instanceof ScanAgainError ? "票刚被挪柜或改过" : error instanceof DeadlineError ? "超过时限" : isDbTimeout(error) ? "数据库限时到了" : code;
        logger.warn("拆派仓按运单号取票：正忙，让拆派仓再扫一次", { waybillNo, 原因: why });
        fail(res, 503, "INTERNAL_ERROR", "正忙，请稍后再扫一次");
        return;
      }
      throw error;
    }
    if ("notFound" in result) { fail(res, 404, "NOT_FOUND", result.notFound); return; }
    if ("tooMany" in result) {
      logger.error("拆派仓按运单号取票：票数超出拆派仓一次能收的上限，没发", { waybillNo, 票数: result.tooMany });
      fail(res, 422, "VALIDATION_ERROR", `这个号下面有 ${result.tooMany} 票，超过拆派仓一次能收的 ${WAYBILL_MAX_SHIPMENTS} 票`);
      return;
    }

    if (result.skipped.length > 0) logger.info("拆派仓按运单号取票：这些票没给", { waybillNo, 剔除: result.skipped });
    if (result.picked.length === 0) {
      const reasons = new Set(result.skipped.map((s) => s.reason));
      // 扫父单号时父单自己（0 件汇总、没装柜）总在剔除里，所以只看有没有「整柜」
      fail(res, 404, "NOT_FOUND", reasons.has("整柜") ? "整柜的货不走拆派仓" : "这票还没装柜");
      return;
    }
    const manifests: ManifestPart[] = result.parts.flatMap((p) => manifestParts(cfg.companyId, p.containerNo, p.batches, (id) => result.versions.get(id)!));
    // 顶层运单号原样回拆派仓扫的那个号（没去空格）
    const envelope: WaybillManifestEnvelope = { protocolVersion: 2, companyId: cfg.companyId, waybillNo: rawNo as string, manifests };
    const problem = envelopeProblem(envelope);
    if (problem) {
      logger.error("拆派仓按运单号取票：超出拆派仓的整次上限，没发", { waybillNo, 原因: problem });
      fail(res, 422, "VALIDATION_ERROR", `这票的清单超出拆派仓的上限：${problem}`);
      return;
    }
    logger.info("拆派仓按运单号取票", { waybillNo, 票数: result.picked.length, 柜数: result.parts.length, 剔除: result.skipped.length });
    res.status(200).json(envelope);
  });
}

/** 排队期间票被挪到别的柜：不硬取，让拆派仓再扫一次 */
class ScanAgainError extends Error {}

/** 按运单号取票：设时限那一句允许花的时间（超过就重设），也就是总截止最多被超出多少毫秒 */
const GUARD_SLACK_MS = 25;

/** 这次取票的总时限到了（拆派仓约 8 秒就不等了）：不再发新的语句，回 503 让拆派仓稍后再扫 */
class DeadlineError extends Error {
  // 万一 Prisma 以后把回调里抛的错包一层、instanceof 认不出来，还能按名字认（dsh 10-13 第 5 轮）
  override name = "DeadlineError";
}

/**
 * 数据库按时限掐断了这一句：等锁超时（SQLSTATE 55P03，lock_timeout）或整句超时（57014，statement_timeout）。
 * 裸 SQL 出错时 Prisma 包成 P2010、原因放在 meta 里；普通查询的原因在 message 里。
 */
function isDbTimeout(error: unknown): boolean {
  const e = error as { code?: string; message?: string; meta?: unknown };
  const text = `${e?.message ?? ""} ${JSON.stringify(e?.meta ?? "")}`;
  return /55P03|57014|lock timeout|statement timeout/i.test(text);
}
