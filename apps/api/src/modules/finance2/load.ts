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
 * since 之后改过的运单号（按 changedAt、再按运单号排，运单号按字节序比，跟游标一致）。
 * 每票的 changedAt = 它在改动记录表里最新那一笔；deletedAt = 最新一笔「删掉」的时间（还在不在由调用方看运单表）。
 * 先用 (company_id, changed_at) 索引找出候选，再按 (company_id, waybill_no, changed_at) 索引取每票最新一笔。
 */
export async function listChanges(tx: Tx, companyId: string, since: Date, cursor: { t: Date; w: string } | null, limit: number): Promise<ChangeRow[]> {
  const lower = cursor && cursor.t > since ? cursor.t : since;
  const rows = await tx.$queryRaw<Array<{ waybill_no: string; changed_at: string; deleted_at: string | null }>>`
    WITH cand AS (
      SELECT DISTINCT waybill_no FROM finance2_waybill_changes
      WHERE company_id = ${companyId} AND changed_at >= (${lower.toISOString()}::timestamptz AT TIME ZONE 'UTC')
    ), latest AS (
      SELECT c.waybill_no, max(c.changed_at) AS changed_at, max(c.changed_at) FILTER (WHERE c.deleted) AS deleted_at
      FROM finance2_waybill_changes c JOIN cand ON cand.waybill_no = c.waybill_no
      WHERE c.company_id = ${companyId}
      GROUP BY c.waybill_no
    )
    SELECT waybill_no,
           to_char(changed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS changed_at,
           to_char(deleted_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS deleted_at
    FROM latest
    WHERE changed_at > (${since.toISOString()}::timestamptz AT TIME ZONE 'UTC')
      AND (${cursor === null}
           OR (changed_at, waybill_no COLLATE "C") > ((${(cursor?.t ?? since).toISOString()}::timestamptz AT TIME ZONE 'UTC'), ${cursor?.w ?? ""} COLLATE "C"))
    ORDER BY changed_at, waybill_no COLLATE "C"
    LIMIT ${limit}
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
