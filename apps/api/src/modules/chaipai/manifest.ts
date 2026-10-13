import { createHash } from "node:crypto";

/**
 * 给拆派仓的柜子清单（纯函数，不碰库，方便不连库测试）。2026-10-12。
 *
 * 拆派仓到货扫码台填柜号点「从湘泰物流系统拉清单」，来 GET /integrations/chaipai/v2/container-manifest。
 * 格式和上限照拆派仓源码（xtpull-20261011）核过：
 *   domestic-pull.service.ts  信封：protocolVersion 2、companyId 一字不差、柜号去空白转大写后一致、份数 ≤50、合计 ≤5000
 *   manifest-v2.validation.ts 每份 1～500 票；每票文本非空 ≤128、不含控制字符；件数 / 方数 / 重量 > 0，方数 ≤3 位小数、重量 ≤2 位
 *   domestic-pull.transport.ts 整个响应 ≤5MB
 * 逐票不合规（运单号带空格、重量没填……）拆派仓只退那一票、在拉取结果里列出来，所以原样发；
 * 会让**整次**拒收的（份数、票数、大小、柜号）湘泰自己先查。
 */

export const MANIFEST_MAX_PER_BATCH = 500;
export const MANIFEST_MAX_BATCHES = 50;
export const MANIFEST_MAX_SHIPMENTS = 5000;
export const MANIFEST_MAX_BYTES = 5 * 1024 * 1024;
/** 批次号为空的统一用这个（同一柜同一批次 batchKey 必须永远一样） */
export const NO_BATCH = "NO-BATCH";

/** 柜号比对口径，跟拆派仓 domestic-pull.service.ts 的 containerKey 一字不差：去掉全部空白、转大写 */
export function containerKey(value: string): string {
  return value.replace(/\s/g, "").toUpperCase();
}

/** 员工填的柜号（拆派仓已去首尾空格）：1～64 字、不含控制字符（同拆派仓 domestic-pull.service.ts:48） */
export function validContainerNoInput(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v || v.length > 64 || /[\x00-\x1f\x7f-\x9f]/.test(raw)) return null;
  return v;
}

/**
 * 拆派仓扫到的湘泰运单号（10-13 按运单号取一票）：去首尾空格后 1～128 字（拆派仓运单号上限），原文不含控制字符。
 * 只去首尾空格、不改大小写 —— 湘泰运单号区分大小写，比对用原文精确匹配。返回比对用的号；不合格返回 null。
 */
export function validWaybillNoInput(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v || raw.length > 128 || /[\x00-\x1f\x7f-\x9f]/.test(raw)) return null;
  return v;
}

/** 选填文本：控制字符换空格、连续空白合一、去首尾、截长度；清完是空的返回 null（不放这个键） */
export function cleanOptionalText(value: string | null | undefined, max: number): string | null {
  if (value == null) return null;
  const v = value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  if (!v) return null;
  return v.length > max ? v.slice(0, max).trimEnd() : v;
}

/**
 * 发给拆派仓的批次号：合拆派仓规矩（≤128 字、没有控制字符）就发湘泰原文（修改清单：batchNo = Shipment.batchNo）；
 * 不合规矩才清洗截断 —— 原样发会让拆派仓**整次**拒收（manifest-v2.validation 的 text()），整柜拉不下来。空的用 NO-BATCH。
 * 分组和 batchKey 一律按原文（见 batchKeyOf），清洗后同名的两批不会被并成一批。
 */
export function normalizeBatchNo(raw: string | null | undefined): string {
  if (raw == null || !raw.trim()) return NO_BATCH;
  if (raw.length <= 128 && !/[\x00-\x1f\x7f]/.test(raw)) return raw;
  return cleanOptionalText(raw, 128) ?? NO_BATCH;
}

/**
 * batchKey = "xt-c1-" + sha256(JSON[公司编号, 柜子 id, 批次号原文])，同一柜同一批次永远一样（同 9-20 旧适配器）。
 * ⚠️ 用湘泰里的**原文**算（空的是 null），不用清洗截断后的显示值 —— 两个不同批次清洗后可能一样，会被拆派仓并成一批（10-12 Codex 审查）。
 */
export function batchKeyOf(companyId: string, containerId: string, rawBatchNo: string | null): string {
  return "xt-c1-" + createHash("sha256").update(JSON.stringify([companyId, containerId, rawBatchNo])).digest("hex");
}

/** 分组用的批次原文：空白当没有（null） */
function rawBatchOf(raw: string | null | undefined): string | null {
  return raw == null || !raw.trim() ? null : raw;
}

const TRANSPORT_MODE_ZH: Record<string, string> = { sea: "海运", land: "陆运" };

/** 一票在柜里的资料（路由查库、算好重量后交进来） */
export interface ManifestSourceRow {
  shipmentId: string;
  trackingNo: string;
  parentTrackingNo: string | null;
  batchNo: string | null;
  /** 唛头 = Order.clientId */
  clientId: string;
  loadedPieceCount: number;
  loadedVolumeM3: number;
  /** 这票在本柜的重量（loadedWeightKg 算的）；没填是 null */
  weightKg: number | null;
  transportMode: string | null;
  itemName: string | null;
  remark: string | null;
}

/** 每票发给拆派仓的字段（不含版本时间） */
export interface ManifestItemBody {
  sourceShipmentId: string;
  waybillNo: string;
  parentWaybillNo: string;
  customerCode: string;
  boxCount: number;
  volumeM3: number;
  weightKg: number;
  transportMode?: string;
  itemName?: string;
  remark?: string;
}

export interface ManifestItem extends ManifestItemBody {
  sourceUpdatedAt: string;
}

export interface PlannedBatch {
  batchKey: string;
  batchNo: string;
  items: ManifestItemBody[];
}

export function itemBodyOf(row: ManifestSourceRow): ManifestItemBody {
  const body: ManifestItemBody = {
    sourceShipmentId: row.shipmentId,
    // 运单号、父单号、唛头原文发，不改大小写不去空格 —— 不合规的拆派仓逐票退回、员工看得到是哪票
    waybillNo: row.trackingNo,
    parentWaybillNo: row.parentTrackingNo ?? row.trackingNo,
    customerCode: row.clientId,
    boxCount: row.loadedPieceCount,
    // Decimal 一定要转成数字（字符串整票会被判不合规）
    volumeM3: Math.round(row.loadedVolumeM3 * 1000) / 1000,
    // 没填重量发 0，拆派仓会把这票退回「必须为正数」
    weightKg: row.weightKg == null ? 0 : Math.round(row.weightKg * 100) / 100,
  };
  const mode = row.transportMode ? (TRANSPORT_MODE_ZH[row.transportMode] ?? row.transportMode) : null;
  const transportMode = cleanOptionalText(mode, 200);
  const itemName = cleanOptionalText(row.itemName, 200);
  const remark = cleanOptionalText(row.remark, 2000);
  if (transportMode) body.transportMode = transportMode;
  if (itemName) body.itemName = itemName;
  if (remark) body.remark = remark;
  return body;
}

/** 内容摘要：这些字段有一个变了，版本时间就要变大 */
export function contentHashOf(batchKey: string, batchNo: string, item: ManifestItemBody): string {
  return createHash("sha256").update(JSON.stringify([
    batchKey, batchNo, item.waybillNo, item.parentWaybillNo, item.customerCode,
    item.boxCount, item.volumeM3, item.weightKg,
    item.transportMode ?? null, item.itemName ?? null, item.remark ?? null,
  ])).digest("hex");
}

/**
 * 按批次号分份：份按批次号排，份内按运单 id 排；每 500 票切一份，切出来的几份 batchKey、batchNo 相同。
 */
export function planBatches(companyId: string, containerId: string, rows: ManifestSourceRow[]): PlannedBatch[] {
  // 按批次原文分组（JSON 化当键，null 和字符串 "null" 分得开）
  const groups = new Map<string, { raw: string | null; rows: ManifestSourceRow[] }>();
  for (const row of rows) {
    const raw = rawBatchOf(row.batchNo);
    const key = JSON.stringify(raw);
    const g = groups.get(key) ?? { raw, rows: [] };
    g.rows.push(row);
    groups.set(key, g);
  }
  const ordered = [...groups.values()].sort((a, b) => {
    const la = normalizeBatchNo(a.raw), lb = normalizeBatchNo(b.raw);
    return la < lb ? -1 : la > lb ? 1 : JSON.stringify(a.raw) < JSON.stringify(b.raw) ? -1 : 1;
  });
  const out: PlannedBatch[] = [];
  for (const g of ordered) {
    const batchNo = normalizeBatchNo(g.raw);
    const batchKey = batchKeyOf(companyId, containerId, g.raw);
    const items = g.rows
      .sort((a, b) => (a.shipmentId < b.shipmentId ? -1 : a.shipmentId > b.shipmentId ? 1 : 0))
      .map(itemBodyOf);
    for (let i = 0; i < items.length; i += MANIFEST_MAX_PER_BATCH) {
      out.push({ batchKey, batchNo, items: items.slice(i, i + MANIFEST_MAX_PER_BATCH) });
    }
  }
  return out;
}

export interface ManifestPart {
  companyId: string;
  batchKey: string;
  batchNo: string;
  containerNo: string;
  shipments: ManifestItem[];
}

export interface ManifestEnvelope {
  protocolVersion: 2;
  companyId: string;
  containerNo: string;
  manifests: ManifestPart[];
}

/** 按运单号取一票的信封（10-13）：跟按柜拉的一样，只是顶层的 containerNo 换成 waybillNo（原样回拆派仓扫的号）；每份各带自己的柜号 */
export interface WaybillManifestEnvelope {
  protocolVersion: 2;
  companyId: string;
  waybillNo: string;
  manifests: ManifestPart[];
}

/** 一个柜的几份清单填上版本时间（按柜拉、按运单号取共用） */
export function manifestParts(
  companyId: string,
  containerNo: string,
  batches: PlannedBatch[],
  versionOf: (shipmentId: string) => string,
): ManifestPart[] {
  return batches.map((b) => ({
    companyId,
    batchKey: b.batchKey,
    batchNo: b.batchNo,
    containerNo,
    shipments: b.items.map((item) => ({ ...item, sourceUpdatedAt: versionOf(item.sourceShipmentId) })),
  }));
}

/** 填上版本时间，拼成整个响应 */
export function buildEnvelope(
  companyId: string,
  containerNo: string,
  batches: PlannedBatch[],
  versionOf: (shipmentId: string) => string,
): ManifestEnvelope {
  return { protocolVersion: 2, companyId, containerNo, manifests: manifestParts(companyId, containerNo, batches, versionOf) };
}

/** 会让拆派仓整次拒收的情况，湘泰先挡住；没问题返回 null */
export function envelopeProblem(envelope: ManifestEnvelope | WaybillManifestEnvelope): string | null {
  const total = envelope.manifests.reduce((sum, m) => sum + m.shipments.length, 0);
  if (envelope.manifests.length > MANIFEST_MAX_BATCHES) return `批次份数 ${envelope.manifests.length} 超过 ${MANIFEST_MAX_BATCHES}`;
  if (total > MANIFEST_MAX_SHIPMENTS) return `合计 ${total} 票超过 ${MANIFEST_MAX_SHIPMENTS}`;
  // 跟拆派仓 manifest-v2.validation 的 text() 同一套：去空白后不能空、≤128 字、没有控制字符；有一处不合整次就会被拒
  const badText = (v: string) => !v.trim() || v.length > 128 || /[\x00-\x1f\x7f]/.test(v);
  if ("containerNo" in envelope ? badText(envelope.containerNo) : badText(envelope.waybillNo)) {
    return "containerNo" in envelope ? "柜号含控制字符或超过 128 字" : "运单号含控制字符或超过 128 字";
  }
  // 按运单号取时每份的柜号来自湘泰的柜子（按柜拉时等于顶层柜号，上面已查）
  const badContainer = envelope.manifests.find((m) => badText(m.containerNo));
  if (badContainer) return `柜号不合规：${JSON.stringify(badContainer.containerNo).slice(0, 60)}`;
  const badBatch = envelope.manifests.find((m) => badText(m.batchNo));
  if (badBatch) return `批次号不合规：${JSON.stringify(badBatch.batchNo).slice(0, 60)}`;
  const bytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");
  if (bytes > MANIFEST_MAX_BYTES) return `清单 ${bytes} 字节超过 5MB`;
  return null;
}
