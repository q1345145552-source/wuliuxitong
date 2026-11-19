/* ==========================================================================
   给财务系统2 的只读接口：查库（2026-11-19）
   --------------------------------------------------------------------------
   ⚠️ 只读：每个接口都在 readOnlySnapshot 里跑 —— 数据库层面开一个 READ ONLY + REPEATABLE READ 的事务，
      写一个字数据库都会报错；一页里的运单、产品、轨迹、装柜都出自同一个快照，不会半新半旧。
   ⚠️ 只看 FINANCE2_COMPANY_ID 那一家公司。
   ⚠️ 手写 SQL 里的表名列名都核过库（CLAUDE.md #26）：改动记录表是这次新加的下划线列；
      时间列是不带时区的 TIMESTAMP(3)、存的是 UTC —— 传进去用 `::timestamptz AT TIME ZONE 'UTC'`、
      读出来用 to_char 拼成带 Z 的字符串，不受连接时区设置影响。
   ========================================================================== */

import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import {
  buildWaybill,
  deletedWaybill,
  type Finance2Waybill,
  type SourceContainerItem,
  type SourceLog,
  type SourceShipment,
} from "./views";

export type Tx = Prisma.TransactionClient;

/** 一个只读快照事务。超时给 25 秒（财务那边等 30 秒） */
export async function readOnlySnapshot<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      return fn(tx);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5_000, timeout: 25_000 },
  );
}

const UTC_TEXT = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** 数据库现在的时间（UTC，毫秒）。改动记录的时间也是数据库时钟，两边对得上 */
export async function dbNow(tx: Tx): Promise<Date> {
  const rows = await tx.$queryRawUnsafe<Array<{ now: string }>>(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', ${UTC_TEXT}) AS now`);
  return new Date(rows[0].now);
}

export interface ChangeRow { waybillNo: string; changedAt: Date; deletedAt: Date | null }

/**
 * 「稳定线」：早于它的改动都已经提交完了，以后不会再冒出更早的改动。
 *
 * 为什么要它（Codex 第二次审查第 1 条）：改动记录的时间是「改的那一刻」，不是「提交的那一刻」。
 * 同一票事务 A 先改（t1）、事务 B 后改（t2）但先提交，财务这时拉到「B 的内容 + changedAt=t2」；
 * A 再提交，内容变了，最新一笔还是 t2 —— 约定第 4 节「changedAt 不比已存的新就跳过」，A 的改动就丢了。
 *
 * 做法：看数据库里还开着、已经写过东西的事务（pg_stat_activity 里有 backend_xid 的），取最早开始的那个时间。
 * 它们以后提交的改动，时间一定不早于各自开始的时间，也就不早于稳定线。
 *   · changes 只给最新一笔早于稳定线的运单；晚于的这一轮先不给，下一轮（往回多拉 10 分钟）再给，那时内容已经齐了；
 *   · 取一票、对账清单给出的 changedAt 不超过稳定线（超过的报成稳定线前 1 毫秒），以后真正稳定下来的版本一定比它新。
 * 有事务一直不提交（卡住了）时，稳定线最多往回压 9 分钟，不让增量整个停掉 —— 比财务往回多拉的 10 分钟短，压住的那些下一轮照样拉得到。
 * 本连接自己是只读事务，没有 backend_xid，不算。
 */
const HORIZON_MAX_LAG = "9 minutes";

export async function stableHorizon(tx: Tx): Promise<Date> {
  const rows = await tx.$queryRawUnsafe<Array<{ h: string }>>(`
    SELECT to_char(GREATEST(
             COALESCE((SELECT min(xact_start) FROM pg_stat_activity
                        WHERE datname = current_database() AND backend_xid IS NOT NULL AND pid <> pg_backend_pid()),
                      clock_timestamp()),
             clock_timestamp() - interval '${HORIZON_MAX_LAG}'
           ) AT TIME ZONE 'UTC', ${UTC_TEXT}) AS h`);
  return new Date(rows[0].h);
}

/** 给出去的 changedAt 不超过稳定线（见 stableHorizon） */
export function capToHorizon(changedAt: Date, horizon: Date): Date {
  return changedAt < horizon ? changedAt : new Date(horizon.getTime() - 1);
}

/**
 * since 之后改过、并且最新一笔早于稳定线的运单号（按 changedAt、再按运单号排，运单号按字节序比，跟游标一致）。
 * 每票的 changedAt = 它在改动记录表里最新那一笔；deletedAt = 最新一笔「删掉」的时间（还在不在由调用方看运单表）。
 * 只聚合 changed_at ≥ 下限的那些行（(company_id, changed_at) 索引）：一票只要有一笔在下限之后，它的最新一笔也就在这些行里，
 * 不用再去翻它的全部历史（Codex 第二次审查第 7 条）。删除时间只给这一页的几票单独查。
 */
export async function listChanges(tx: Tx, companyId: string, since: Date, cursor: { t: Date; w: string } | null, limit: number, horizon: Date): Promise<ChangeRow[]> {
  const lower = cursor && cursor.t > since ? cursor.t : since;
  const rows = await tx.$queryRaw<Array<{ waybill_no: string; changed_at: string; deleted_at: string | null }>>`
    WITH latest AS (
      SELECT waybill_no, max(changed_at) AS changed_at
      FROM finance2_waybill_changes
      WHERE company_id = ${companyId} AND changed_at >= (${lower.toISOString()}::timestamptz AT TIME ZONE 'UTC')
      GROUP BY waybill_no
    ), page AS (
      SELECT waybill_no, changed_at FROM latest
      WHERE changed_at > (${since.toISOString()}::timestamptz AT TIME ZONE 'UTC')
        AND changed_at < (${horizon.toISOString()}::timestamptz AT TIME ZONE 'UTC')
        AND (${cursor === null}
             OR (changed_at, waybill_no COLLATE "C") > ((${(cursor?.t ?? since).toISOString()}::timestamptz AT TIME ZONE 'UTC'), ${cursor?.w ?? ""} COLLATE "C"))
      ORDER BY changed_at, waybill_no COLLATE "C"
      LIMIT ${limit}
    )
    SELECT p.waybill_no,
           to_char(p.changed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS changed_at,
           (SELECT to_char(max(d.changed_at), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM finance2_waybill_changes d
             WHERE d.company_id = ${companyId} AND d.waybill_no = p.waybill_no AND d.deleted) AS deleted_at
    FROM page p
    ORDER BY p.changed_at, p.waybill_no COLLATE "C"
  `;
  return rows.map((r) => ({ waybillNo: r.waybill_no, changedAt: new Date(r.changed_at), deletedAt: r.deleted_at ? new Date(r.deleted_at) : null }));
}

/** 一票在改动记录表里的最新一笔（取一票时用）；从来没记过给 null */
export async function latestChangeOf(tx: Tx, companyId: string, waybillNo: string): Promise<ChangeRow | null> {
  const rows = await tx.$queryRaw<Array<{ changed_at: string | null; deleted_at: string | null }>>`
    SELECT to_char(max(changed_at), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS changed_at,
           to_char(max(changed_at) FILTER (WHERE deleted), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS deleted_at
    FROM finance2_waybill_changes WHERE company_id = ${companyId} AND waybill_no = ${waybillNo}
  `;
  const r = rows[0];
  if (!r?.changed_at) return null;
  return { waybillNo, changedAt: new Date(r.changed_at), deletedAt: r.deleted_at ? new Date(r.deleted_at) : null };
}

const SHIPMENT_SELECT = {
  id: true,
  trackingNo: true,
  parentTrackingNo: true,
  currentStatus: true,
  volumeM3: true,
  weightKg: true,
  packageCount: true,
} satisfies Prisma.ShipmentSelect;

/**
 * 按母运单号拼出一页运单。changes 里的顺序原样保留；母运单已经不在的给删除记录。
 * 母运单还在、却从没进过改动记录表（理论上上线补过一遍就不会有）：changedAt 退到订单 / 运单的 updated_at 里晚的那个。
 */
export async function loadWaybills(tx: Tx, companyId: string, rows: ReadonlyArray<{ waybillNo: string; changedAt: Date | null; deletedAt: Date | null }>): Promise<Finance2Waybill[]> {
  const nos = [...new Set(rows.map((r) => r.waybillNo))];
  const mothers = nos.length === 0 ? [] : await tx.shipment.findMany({
    where: { companyId, trackingNo: { in: nos }, parentTrackingNo: null },
    select: {
      ...SHIPMENT_SELECT,
      orderId: true,
      updatedAt: true,
      order: {
        select: {
          clientId: true, warehouseId: true, transportMode: true, cargoType: true, volumeM3: true, weightKg: true,
          packageCount: true, approvalStatus: true, receivableAmountCny: true, createdAt: true, updatedAt: true,
          client: { select: { agentId: true } },
        },
      },
    },
  });
  const motherByNo = new Map(mothers.map((m) => [m.trackingNo, m]));
  const orderIds = [...new Set(mothers.map((m) => m.orderId))];

  // 子运单只认同一张订单的（正常拆单就是同一张；跟原来那条财务接口查子单一个口径）
  const children = mothers.length === 0 ? [] : await tx.shipment.findMany({
    where: { companyId, parentTrackingNo: { in: mothers.map((m) => m.trackingNo) }, orderId: { in: orderIds } },
    orderBy: { trackingNo: "asc" },
    select: { ...SHIPMENT_SELECT, orderId: true },
  });
  const childrenByParent = new Map<string, SourceShipment[]>();
  for (const c of children) {
    const mother = motherByNo.get(c.parentTrackingNo ?? "");
    if (!mother || mother.orderId !== c.orderId) continue;
    const list = childrenByParent.get(mother.trackingNo) ?? [];
    list.push(c);
    childrenByParent.set(mother.trackingNo, list);
  }

  const products = orderIds.length === 0 ? [] : await tx.orderProduct.findMany({
    where: { companyId, orderId: { in: orderIds } },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true, orderId: true, cargoType: true, itemName: true, lengthCm: true, widthCm: true, heightCm: true, packageCount: true },
  });

  const familyIds = [...mothers.map((m) => m.id), ...children.map((c) => c.id)];
  const logs = familyIds.length === 0 ? [] : await tx.statusLog.findMany({
    where: { shipmentId: { in: familyIds } },
    orderBy: [{ changedAt: "asc" }, { id: "asc" }],
    // ⚠️ 只要状态和时间，操作人、备注一概不取
    select: { shipmentId: true, toStatus: true, changedAt: true },
  });
  const logsByShipmentId = new Map<string, SourceLog[]>();
  for (const log of logs) {
    const list = logsByShipmentId.get(log.shipmentId) ?? [];
    list.push({ toStatus: log.toStatus, changedAt: log.changedAt });
    logsByShipmentId.set(log.shipmentId, list);
  }

  const items = familyIds.length === 0 ? [] : await tx.shipmentContainerItem.findMany({
    where: { shipmentId: { in: familyIds } },
    select: {
      shipmentId: true, loadedVolumeM3: true, loadedPieceCount: true, createdAt: true,
      container: { select: { containerNo: true, containerType: true, loadingDate: true, isFcl: true } },
    },
  });
  const trackingNoById = new Map<string, string>([...mothers, ...children].map((s) => [s.id, s.trackingNo]));
  const familyNoById = new Map<string, string>([
    ...mothers.map((m) => [m.id, m.trackingNo] as const),
    ...children.map((c) => [c.id, c.parentTrackingNo ?? ""] as const),
  ]);
  const itemsByMother = new Map<string, SourceContainerItem[]>();
  for (const it of items) {
    const motherNo = familyNoById.get(it.shipmentId);
    const trackingNo = trackingNoById.get(it.shipmentId);
    if (!motherNo || !trackingNo) continue;
    const list = itemsByMother.get(motherNo) ?? [];
    list.push({ trackingNo, loadedVolumeM3: it.loadedVolumeM3, loadedPieceCount: it.loadedPieceCount, createdAt: it.createdAt, container: it.container });
    itemsByMother.set(motherNo, list);
  }

  return rows.map((row) => {
    const mother = motherByNo.get(row.waybillNo);
    if (!mother) {
      const changedAt = row.changedAt ?? new Date();
      return deletedWaybill(row.waybillNo, row.deletedAt ?? changedAt, changedAt);
    }
    const order = mother.order;
    const fallback = order.updatedAt > mother.updatedAt ? order.updatedAt : mother.updatedAt;
    return buildWaybill({
      order,
      agentId: order.client.agentId ?? null,
      mother,
      children: childrenByParent.get(mother.trackingNo) ?? [],
      products: products.filter((p) => p.orderId === mother.orderId),
      logsByShipmentId,
      containerItems: itemsByMother.get(mother.trackingNo) ?? [],
      changedAt: row.changedAt ?? fallback,
    });
  });
}

/** 传进来的号是子运单号时，换成它的母运单号；不是本公司的号给 null */
export async function motherNoOf(tx: Tx, companyId: string, trackingNo: string): Promise<string | null> {
  const s = await tx.shipment.findFirst({ where: { companyId, trackingNo }, select: { trackingNo: true, parentTrackingNo: true } });
  if (!s) return null;
  return s.parentTrackingNo ?? s.trackingNo;
}

export interface NumberRow { waybillNo: string; createdAt: Date; changedAt: Date }

/** 按建单时间（订单 created_at）列母运单号，对账用 */
export async function listNumbers(tx: Tx, companyId: string, from: Date, to: Date | null, cursor: { c: Date; w: string } | null, limit: number): Promise<NumberRow[]> {
  const rows = await tx.$queryRaw<Array<{ waybill_no: string; created_at: string; changed_at: string | null; fallback_at: string }>>`
    SELECT s.tracking_no AS waybill_no,
           to_char(o.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
           (SELECT to_char(max(c.changed_at), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM finance2_waybill_changes c
             WHERE c.company_id = s.company_id AND c.waybill_no = s.tracking_no) AS changed_at,
           to_char(GREATEST(s.updated_at, o.updated_at), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS fallback_at
    FROM shipments s JOIN orders o ON o.id = s.order_id
    WHERE s.company_id = ${companyId} AND s.parent_tracking_no IS NULL
      AND o.created_at >= (${from.toISOString()}::timestamptz AT TIME ZONE 'UTC')
      AND (${to === null} OR o.created_at < (${(to ?? from).toISOString()}::timestamptz AT TIME ZONE 'UTC'))
      AND (${cursor === null}
           OR (o.created_at, s.tracking_no COLLATE "C") > ((${(cursor?.c ?? from).toISOString()}::timestamptz AT TIME ZONE 'UTC'), ${cursor?.w ?? ""} COLLATE "C"))
    ORDER BY o.created_at, s.tracking_no COLLATE "C"
    LIMIT ${limit}
  `;
  return rows.map((r) => ({ waybillNo: r.waybill_no, createdAt: new Date(r.created_at), changedAt: new Date(r.changed_at ?? r.fallback_at) }));
}
