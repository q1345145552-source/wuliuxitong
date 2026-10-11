import type { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail } from "../core/http-utils";
import { logger } from "../core/logger";
import { nextSequenceValue } from "../core/number-sequence";
import { realtimeHub } from "../realtime/hub";
import { syncParentStatusFromChildren } from "../shipments/parent-status";
import { bearerMatches, chaipaiConfig, type ChaipaiConfig } from "./config";
import {
  LOADED_REMARK,
  RETURN_REMARK,
  arrivedRemark,
  bangkokDate,
  departRemark,
  eventHashOf,
  parseChaipaiEvent,
  pickSignPhoto,
  planForEvent,
  signedRemark,
  unsignRemark,
  type ChaipaiEvent,
} from "./events";
import { fetchChaipaiDetail, fetchChaipaiPhoto, type ChaipaiDetail } from "./read-client";

import { EVENTS_PATH } from "./paths";

/** 轨迹上的操作人：只有超级管理员看得到（hideOperatorIdentity），备注里不出现「拆派仓」（第 255 条） */
const OPERATOR = { operatorId: "chaipai", operatorRole: "system", operatorName: "拆派仓" } as const;

/** 只读接口暂时取不到 / 派送单刚被别人动过：回 503，拆派仓过一会儿重发（同一 eventId 没写过任何东西） */
class RetryLaterError extends Error {}
/**
 * 系统分不清该动哪张派送单（这票签收过不止一张）：不自动处理，回 503 并记错误日志，等人工理顺后在拆派仓「补发」。
 * 同员工那边「撤销误签收」的第四道闸（admin-ops/routes.ts：派了两趟都签收的撤不了，找技术处理）。
 */
class NeedsManualError extends Error {}

type EventResult = "APPLIED" | "DUPLICATE" | "IGNORED_OLDER";

/** 派送中 / 已签收要用的拆派仓资料（事务外先取好，事务里不发网络请求） */
interface LastmileInfo {
  /** 只读接口查到了这票（404 = 没查到，司机车牌转交都不知道，不拿来判断换没换车） */
  found: boolean;
  route: ChaipaiDetail["route"];
  handover: ChaipaiDetail["handover"];
  /** 签收图（base64，不带 data: 前缀，跟员工手工签收存的一样） */
  signImageBase64: string | null;
}

const rand4 = (): string => Math.random().toString(36).slice(2, 6);

/**
 * 派送中 / 已签收：先去拆派仓只读接口取司机、车牌、转交、签收照片。
 * 取不到（网络、5xx、超时）抛 RetryLaterError；拆派仓说没这票（404）就照常办、司机车牌留空。
 */
/** 去拆派仓取资料的总时间（详情 + 照片一起算）：拆派仓等回复 10 秒，留点余量给写库 */
const READ_BUDGET_MS = 8500;

async function prepareLastmileInfo(cfg: ChaipaiConfig, ev: ChaipaiEvent): Promise<LastmileInfo> {
  const deadline = Date.now() + READ_BUDGET_MS;
  // 派送中只要司机车牌（第一页就有）；签收要挑最新的照片，得翻完全部（每页 20 张，最多 50 页）
  const detail = await fetchChaipaiDetail(cfg, ev.sourceShipmentId, { maxPages: ev.status === "DELIVERED" ? 50 : 1, timeoutMs: READ_BUDGET_MS });
  if (detail.kind === "notFound") {
    logger.warn("拆派仓回传：只读接口查不到这票，派送单不填司机车牌", { eventId: ev.eventId, sourceShipmentId: ev.sourceShipmentId });
    return { found: false, route: null, handover: null, signImageBase64: null };
  }
  if (detail.kind !== "ok") throw new RetryLaterError(`取司机车牌失败：${detail.kind === "error" ? detail.reason : detail.kind}`);
  /* 派送中在拆派仓一定挂着一趟车或一个转交；查到这票却两样都没有 = 这条「派送中」已经过时（货已经回仓了，
     后面那条消息还没到）。不拿它登记一张认不出是哪一趟的单，等后面的消息先到（10-12 Codex 第 3 轮） */
  if (ev.status === "OUT_FOR_DELIVERY" && !detail.value.route && !detail.value.handover) {
    throw new RetryLaterError("拆派仓这票现在不在车上也没转交，这条派送中已经过时");
  }
  let signImageBase64: string | null = null;
  if (ev.status === "DELIVERED") {
    // 照片列表没翻完就挑不准「最新一张」，宁可等会儿重发也不拿旧图当签收单
    if (detail.value.truncated) throw new RetryLaterError("照片超过 1000 张没翻完");
    const photoId = pickSignPhoto(detail.value.photos, ev.occurredAt);
    if (photoId) {
      // 照片用剩下的时间（10-12 两家审查：原来详情 6 秒 + 照片 8 秒，最坏 14 秒，超过拆派仓的 10 秒）
      const left = deadline - Date.now();
      if (left < 500) throw new RetryLaterError("取签收照片没时间了");
      const photo = await fetchChaipaiPhoto(cfg, ev.sourceShipmentId, photoId, { timeoutMs: left });
      if (photo.kind === "ok") signImageBase64 = photo.value.bytes.toString("base64");
      else if (photo.kind === "error") throw new RetryLaterError(`取签收照片失败：${photo.reason}`);
      else logger.warn("拆派仓回传：签收照片已不在（404/410），签收不放图", { eventId: ev.eventId, photoId });
    }
  }
  return { found: true, route: detail.value.route, handover: detail.value.handover, signImageBase64 };
}

/**
 * 收一条回传、改湘泰（一个事务）。
 *
 * ⚠️ 锁序跟员工手工那几条路一样（admin-ops/routes.ts：建派送单「2901 → 派送单行 → 运单 → 父单」、
 * 签收 / 撤销签收 / 删单「派送单行 → 运单 → 父单」）：
 *   ① 派送中 / 已签收先拿派送单号的排队锁 2901（可能要发新 WD 号；全库只有发 WD 号的路拿它）
 *   ② 这票的全部派送单行（按 id 排序）
 *   ③ 运单（之后由 syncParentStatusFromChildren 锁父单）
 * 锁完重读再判断（CLAUDE.md 第 28 条）；锁运单之前有人给这票新加了派送单 → 不倒过来拿锁，回 503 让拆派仓重发。
 */
async function applyEvent(
  ev: ChaipaiEvent,
  hash: string,
  payload: unknown,
  companyId: string,
  info: LastmileInfo | null,
): Promise<{ result: EventResult; changed: boolean; clientId: string | null }> {
  const occurredAt = new Date(ev.occurredAt);
  const now = new Date();
  const sid = ev.sourceShipmentId;
  const needsNumberLock = ev.status === "OUT_FOR_DELIVERY" || ev.status === "DELIVERED";
  return prisma.$transaction(async (tx) => {
    if (needsNumberLock) {
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(2901)");
    }
    const rowIdsBefore = (await tx.adminLastmileOrder.findMany({
      where: { shipmentId: sid, companyId },
      select: { id: true },
    })).map((r) => r.id);
    for (const rowId of [...rowIdsBefore].sort()) {
      await tx.$queryRaw`SELECT id FROM admin_lastmile_orders WHERE id = ${rowId} FOR UPDATE`;
    }
    const lockedShipment = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM shipments WHERE id = ${sid} AND company_id = ${companyId} FOR UPDATE`;

    // 去重：同一编号再来回 DUPLICATE；编号一样内容不一样是对方出错，回 409
    const seen = await tx.chaipaiCallbackEvent.findUnique({ where: { eventId: ev.eventId }, select: { payloadHash: true } });
    if (seen) {
      if (seen.payloadHash !== hash) throw new EventIdReusedError();
      return { result: "DUPLICATE" as const, changed: false, clientId: null };
    }
    const ledger = (result: "APPLIED" | "IGNORED_OLDER") => tx.chaipaiCallbackEvent.create({
      data: {
        eventId: ev.eventId, companyId, sourceCompanyId: ev.companyId, shipmentId: sid, sequence: ev.sequence,
        status: ev.status, occurredAt, payloadHash: hash, payload: payload as Prisma.InputJsonValue, result,
      },
    });
    // 等锁的工夫这票被删了：照样记下再回 IGNORED_OLDER（回了「收到」就得留底，10-12 Codex 审查）
    if (lockedShipment.length === 0) {
      await ledger("IGNORED_OLDER");
      return { result: "IGNORED_OLDER" as const, changed: false, clientId: null };
    }
    const state = await tx.chaipaiShipmentState.findUnique({ where: { shipmentId: sid } });
    // 判新旧：序号只认比存过的大（会跳号，不要求连号）
    if (state && ev.sequence <= state.lastSequence) {
      await ledger("IGNORED_OLDER");
      return { result: "IGNORED_OLDER" as const, changed: false, clientId: null };
    }

    const shipment = await tx.shipment.findUnique({
      where: { id: sid },
      select: { id: true, trackingNo: true, currentStatus: true, parentTrackingNo: true, order: { select: { clientId: true } } },
    });
    if (!shipment) return { result: "IGNORED_OLDER" as const, changed: false, clientId: null };
    const rows = await tx.adminLastmileOrder.findMany({
      where: { shipmentId: sid, companyId },
      orderBy: { updatedAt: "desc" },
      select: { id: true, deliveryNo: true, status: true },
    });
    const locked = new Set(rowIdsBefore);
    if (rows.some((r) => !locked.has(r.id))) {
      throw new RetryLaterError("这票的派送单刚被员工改过");
    }

    const fromStatus = shipment.currentStatus;
    const plan = planForEvent(ev.status, fromStatus);
    const coarseChanged = !state || state.thaiStatus !== ev.status;
    let status = fromStatus;
    let logSeq = 0;
    // 同一条回传可能写两条轨迹（撤销签收 + 回仓），时间往后错 1 毫秒保证先后
    const writeLog = async (prefix: string, toStatus: string, remark: string) => {
      await tx.statusLog.create({
        data: {
          id: `${prefix}${Date.now()}_${rand4()}`, companyId, shipmentId: sid, ...OPERATOR,
          fromStatus: status, toStatus, remark, changedAt: new Date(occurredAt.getTime() + logSeq++),
        },
      });
      status = toStatus;
    };
    let routeId = state?.routeId ?? null;
    let deliveryNo = state?.deliveryNo ?? null;
    let lastmileOrderId = state?.lastmileOrderId ?? null;
    let handoverCarrier = state?.handoverCarrier ?? null;
    let handoverTrackingNo = state?.handoverTrackingNo ?? null;
    /** 自动登记的派送单 id 带 lm_cp_ 前缀：只有这种才由回传更新司机车牌、换车时撤掉；员工手工登记的只接手状态，资料不动 */
    const isAuto = (id: string) => id.startsWith("lm_cp_");
    /**
     * 这是哪一趟：拆派仓自己的车按 route.id 认，转交给别的物流算「转交」那一趟。
     * 自动登记的单碰上趟次变了（中间那条「回仓」没收到：换车、自营↔转交、派送中那条丢了直接签收），
     * 旧单照「改派」撤掉、按新的一趟登记，别让两趟共用一个 WD（10-12 两家审查）。只读接口没查到这票时不判断。
     */
    const tripOf = (route: string | null | undefined, carrier: string | null | undefined) => route ? `route:${route}` : carrier ? "handover" : null;
    const prevTrip = tripOf(state?.routeId, state?.handoverCarrier);
    const newTrip = info?.found ? tripOf(info.route?.id, info.handover?.carrierName) : null;
    const tripChanged = (row: { id: string }) => isAuto(row.id) && !!prevTrip && !!newTrip && prevTrip !== newTrip;
    /** 一票同时挂着两张以上派送中的单（老数据）：分不清是哪一趟，交人工 */
    const assertSingleDelivering = () => {
      const delivering = live.filter((r) => r.status === "DELIVERING");
      if (delivering.length > 1) {
        throw new NeedsManualError(`这票同时有 ${delivering.length} 张派送中的派送单（${delivering.map((r) => r.deliveryNo).join("、")}），分不清是哪一趟`);
      }
    };
    let live = rows;
    const removeRow = async (id: string) => {
      await tx.adminLastmileOrder.delete({ where: { id } });
      live = live.filter((r) => r.id !== id);
    };

    /**
     * 已签收的那张退回派送中（照「撤销误签收」：签收图不删）。
     * 签收过不止一张（派了两趟都签收）分不清撤哪张 —— 不猜，交人工（同手工撤销签收第四道闸）。
     */
    const unsignSigned = async () => {
      const signed = live.filter((r) => r.status === "SIGNED");
      if (signed.length === 0) return;
      if (signed.length > 1) throw new NeedsManualError(`这票有 ${signed.length} 张已签收的派送单（${signed.map((r) => r.deliveryNo).join("、")}），分不清撤哪张`);
      await tx.adminLastmileOrder.update({ where: { id: signed[0].id }, data: { status: "DELIVERING" } });
      signed[0].status = "DELIVERING";
      await writeLog("sl_lmunsign_cp_", "outForDelivery", unsignRemark(signed[0].deliveryNo));
    };

    /** 同一趟车用同一个 WD 号：先找这趟车登记过的号，没有就照手工建单那条发新号（号只往上加） */
    const deliveryNoForRoute = async (): Promise<string> => {
      if (info?.route) {
        // 只认自动登记的单（lm_cp_）：接手的员工手工单是员工自己的号，别把同车别的票并进去（10-12 测试抓到）
        const sameRoute = await tx.chaipaiShipmentState.findFirst({
          where: { companyId, routeId: info.route.id, deliveryNo: { not: null }, lastmileOrderId: { startsWith: "lm_cp_" } },
          orderBy: { updatedAt: "desc" },
          select: { deliveryNo: true },
        });
        if (sameRoute?.deliveryNo) return sameRoute.deliveryNo;
      }
      const last = await tx.adminLastmileOrder.findFirst({
        where: { deliveryNo: { startsWith: "WD" } },
        orderBy: { deliveryNo: "desc" },
        select: { deliveryNo: true },
      });
      const num = last ? parseInt(last.deliveryNo.replace("WD", ""), 10) || 0 : 0;
      return `WD${String(await nextSequenceValue(tx, "WD", num)).padStart(6, "0")}`;
    };

    /** 拆派仓给的资料（自动登记 / 更新自动单时写） */
    const infoFields = () => ({
      carrierName: info?.handover?.carrierName ?? "自营",
      externalTrackingNo: info?.handover?.trackingNo ?? "",
      driverName: info?.route?.driverName ?? "",
      licensePlate: info?.route?.plateNo ?? "",
    });

    /** 新登记一张自动派送单（派送中，或签收时还没有派送单就直接已签收） */
    const createRow = async (rowStatus: "DELIVERING" | "SIGNED"): Promise<{ id: string; deliveryNo: string }> => {
      const no = await deliveryNoForRoute();
      const fields = {
        ...infoFields(),
        phoneNumber: "",
        deliveryDate: bangkokDate(info?.route?.departedAt, ev.occurredAt),
        status: rowStatus,
        ...(rowStatus === "SIGNED" && info?.signImageBase64 ? { signImageBase64: info.signImageBase64 } : {}),
      };
      // 同一张单里同一票只能一行（@@unique）：这趟车以前登记过这票就改那一行
      const existing = live.find((r) => r.deliveryNo === no);
      if (existing) {
        await tx.adminLastmileOrder.update({ where: { id: existing.id }, data: fields });
        return { id: existing.id, deliveryNo: no };
      }
      const id = `lm_cp_${Date.now()}_${rand4()}`;
      await tx.adminLastmileOrder.create({ data: { id, companyId, deliveryNo: no, shipmentId: sid, ...fields } });
      return { id, deliveryNo: no };
    };

    if (plan.isReturn) {
      // 送不成拉回仓：还挂着已签收的单就先照「撤销误签收」退回派送中（货回了仓，那张签收不成立），
      // 再把派送中的单全撤掉（照「改派」删旧行）。不看运单现在是派送中还是已签收 —— 员工签过一趟又派一趟也是这样（10-12 dsh 审查）
      await unsignSigned();
      const delivering = live.filter((r) => r.status === "DELIVERING");
      for (const r of delivering) await removeRow(r.id);
      await writeLog(delivering.length > 0 ? "sl_lmdel_cp_" : "sl_cp_", "inWarehouseTH", RETURN_REMARK);
      routeId = null;
      deliveryNo = null;
      lastmileOrderId = null;
      handoverCarrier = null;
      handoverTrackingNo = null;
    } else if (ev.status === "ARRIVED") {
      if (coarseChanged || plan.targetStatus !== fromStatus) {
        await writeLog("sl_cp_", plan.targetStatus, arrivedRemark(ev.actualBoxCount, ev.shortage));
      }
    } else if (ev.status === "LOADED") {
      if (coarseChanged || plan.targetStatus !== fromStatus) {
        await writeLog("sl_cp_", plan.targetStatus, LOADED_REMARK);
      }
    } else if (ev.status === "OUT_FOR_DELIVERY") {
      if (fromStatus === "delivered") await unsignSigned();
      assertSingleDelivering();
      const newCarrier = info?.handover?.carrierName ?? null;
      const newHandoverNo = newCarrier ? (info?.handover?.trackingNo ?? null) : null;
      const handoverChanged = !!info?.found && (newCarrier !== handoverCarrier || newHandoverNo !== handoverTrackingNo);
      const remarkFor = (no: string) => departRemark({
        driverName: info?.route?.driverName ?? "", deliveryNo: no, handoverCarrier: newCarrier, handoverTrackingNo: newHandoverNo,
      });
      const current = live.find((r) => r.status === "DELIVERING" && r.id === lastmileOrderId)
        ?? live.find((r) => r.status === "DELIVERING");
      if (current && tripChanged(current)) {
        const oldNo = current.deliveryNo;
        await removeRow(current.id);
        const created = await createRow("DELIVERING");
        lastmileOrderId = created.id;
        deliveryNo = created.deliveryNo;
        await writeLog("sl_lm_cp_", "outForDelivery", `改派：从 ${oldNo} 转到 ${created.deliveryNo}，${remarkFor(created.deliveryNo)}`);
      } else if (current) {
        // 已经有派送中的单：不新建。自动登记的那张跟着拆派仓更新司机车牌 / 转交；员工手工登记的资料不动
        if (isAuto(current.id) && info) {
          // 这一趟是什么就写什么：转交那一趟没有司机车牌，也要清掉（10-12 dsh 第 3 轮）
          await tx.adminLastmileOrder.update({ where: { id: current.id }, data: infoFields() });
        }
        lastmileOrderId = current.id;
        deliveryNo = current.deliveryNo;
        // 员工手工登记时已经写过「正在派送」，接手时不再重复写；自动单转交信息变了补一条
        if (status !== "outForDelivery" || (isAuto(current.id) && (coarseChanged || handoverChanged))) {
          await writeLog("sl_lm_cp_", "outForDelivery", remarkFor(current.deliveryNo));
        }
      } else {
        const created = await createRow("DELIVERING");
        lastmileOrderId = created.id;
        deliveryNo = created.deliveryNo;
        await writeLog("sl_lm_cp_", "outForDelivery", remarkFor(created.deliveryNo));
      }
      // 记着这趟车只为「同车同号」和「换车」用，所以只有自动登记的单才记；接手员工手工单时不记。
      // 只读接口没查到这票（404）就不知道这趟是什么，照旧
      if (!(lastmileOrderId && isAuto(lastmileOrderId))) routeId = null;
      else if (info?.found) routeId = info.route?.id ?? null;
      if (info?.found) {
        handoverCarrier = newCarrier;
        handoverTrackingNo = newHandoverNo;
      }
    } else {
      // DELIVERED：签当前这趟 —— 先找派送中的（跟踪的那张优先），没有才找跟踪的 / 最近一张已签收的（员工先手工签了），
      // 都没有就直接建一张已签收的。签收图一律换成拆派仓这票最新一张（老板：签收单放拆派仓的照片）
      assertSingleDelivering();
      let target = live.find((r) => r.status === "DELIVERING" && r.id === lastmileOrderId)
        ?? live.find((r) => r.status === "DELIVERING")
        ?? live.find((r) => r.id === lastmileOrderId)
        ?? live.find((r) => r.status === "SIGNED");
      // 派送中那条没收到、签收时已经是另一趟了：自动登记的旧单（不管员工有没有先手工签过）撤掉，按这一趟直接登记已签收
      if (target && tripChanged(target)) {
        await removeRow(target.id);
        target = undefined;
      }
      let signedNo: string;
      if (target) {
        await tx.adminLastmileOrder.update({
          where: { id: target.id },
          data: { status: "SIGNED", ...(info?.signImageBase64 ? { signImageBase64: info.signImageBase64 } : {}) },
        });
        lastmileOrderId = target.id;
        signedNo = target.deliveryNo;
      } else {
        const created = await createRow("SIGNED");
        lastmileOrderId = created.id;
        signedNo = created.deliveryNo;
        routeId = info?.route?.id ?? null;
        handoverCarrier = info?.handover?.carrierName ?? null;
        handoverTrackingNo = handoverCarrier ? (info?.handover?.trackingNo ?? null) : null;
      }
      deliveryNo = signedNo;
      if (status !== "delivered" || coarseChanged) {
        await writeLog("sl_lm_cp_", "delivered", signedRemark(signedNo));
      }
    }

    const changed = status !== fromStatus;
    if (changed) {
      await tx.shipment.update({ where: { id: sid }, data: { currentStatus: status, updatedAt: now } });
    }
    const stateData = {
      companyId, lastSequence: ev.sequence, lastEventId: ev.eventId, thaiStatus: ev.status, occurredAt,
      ...(ev.status === "ARRIVED" && ev.actualBoxCount != null ? { actualBoxCount: ev.actualBoxCount, shortage: ev.shortage } : {}),
      routeId, deliveryNo, lastmileOrderId, handoverCarrier, handoverTrackingNo,
    };
    await tx.chaipaiShipmentState.upsert({
      where: { shipmentId: sid },
      create: { shipmentId: sid, ...stateData },
      update: stateData,
    });
    await ledger("APPLIED");
    // 父单按全部子单重新推算（全部子单签了父单才签；父单自己还有货就不动）
    if (changed && shipment.parentTrackingNo) {
      await syncParentStatusFromChildren(tx, shipment.parentTrackingNo, companyId);
    }
    return { result: "APPLIED" as const, changed: changed || logSeq > 0, clientId: shipment.order?.clientId ?? null };
  /* 跟员工手工建派送单那个事务一样放宽（10-12 dsh 审查）：两边抢同一把 2901 号锁，手工建一大车时可能握好几秒；
     超过拆派仓 10 秒等不到回复也没关系 —— 它重发时这边已经记下了，回 DUPLICATE */
  }, { timeout: 30000, maxWait: 10000 });
}

class EventIdReusedError extends Error {}

/**
 * POST /integrations/chaipai/v2/events（2026-10-12）
 *
 * 拆派仓回传状态。不是用户登录，用 CHAIPAI_CALLBACK_SECRET 核对。
 * 回 200 + 裸 JSON {eventId, result}（APPLIED / DUPLICATE / IGNORED_OLDER）；只有这样拆派仓才当收到，
 * 别的（401 / 409 / 503 / 500）它都会过一会儿重发，第 10 次失败标 FAILED（大约 4 小时）。
 * 找不到这票：记日志回 IGNORED_OLDER（修改清单定的；拆派仓就不再重发了）。
 */
export function registerChaipaiEventRoutes(app: MinimalHttpApp): void {
  app.post(EVENTS_PATH, async (req, res) => {
    const started = Date.now();
    const cfg = chaipaiConfig();
    if (!cfg) { fail(res, 503, "INTERNAL_ERROR", "拆派仓对接没有开"); return; }
    if (!bearerMatches(req.headers.authorization, cfg.callbackSecret)) {
      logger.warn("拆派仓回传：密钥不对");
      fail(res, 401, "UNAUTHORIZED", "密钥不对");
      return;
    }
    const parsed = parseChaipaiEvent(req.body, cfg.companyId);
    if (!parsed.ok) {
      logger.warn("拆派仓回传：格式不对", { 原因: parsed.message });
      fail(res, parsed.status, "VALIDATION_ERROR", parsed.message);
      return;
    }
    const ev = parsed.event;
    const hash = eventHashOf(ev);
    const reply = (result: EventResult) => {
      logger.info("拆派仓回传", { eventId: ev.eventId, sourceShipmentId: ev.sourceShipmentId, status: ev.status, result, 耗时ms: Date.now() - started });
      res.status(200).json({ eventId: ev.eventId, result });
    };

    // 事务外先挡掉重发的和旧的，省得为它们去拆派仓取资料（事务里锁住以后还会再查一遍，那一遍说了算）
    const seen = await prisma.chaipaiCallbackEvent.findUnique({ where: { eventId: ev.eventId }, select: { payloadHash: true } });
    if (seen) {
      if (seen.payloadHash !== hash) { fail(res, 409, "VALIDATION_ERROR", "这个 eventId 已经用来发过别的内容"); return; }
      reply("DUPLICATE");
      return;
    }
    const shipment = await prisma.shipment.findUnique({
      where: { id: ev.sourceShipmentId },
      select: { companyId: true, chaipaiState: { select: { lastSequence: true } } },
    });
    if (!shipment) {
      logger.warn("拆派仓回传：湘泰没有这票，当旧消息收下", { eventId: ev.eventId, sourceShipmentId: ev.sourceShipmentId, waybillNo: ev.waybillNo });
      // 回了「收到」就得留底（同一编号再来能认出来；10-12 Codex 审查）；湘泰没这票，公司编号空着
      try {
        await prisma.chaipaiCallbackEvent.create({
          data: {
            eventId: ev.eventId, companyId: null, sourceCompanyId: ev.companyId, shipmentId: ev.sourceShipmentId, sequence: ev.sequence,
            status: ev.status, occurredAt: new Date(ev.occurredAt), payloadHash: hash, payload: req.body as Prisma.InputJsonValue, result: "IGNORED_OLDER",
          },
        });
      } catch (error) {
        if ((error as { code?: string })?.code !== "P2002") throw error;
        const again = await prisma.chaipaiCallbackEvent.findUnique({ where: { eventId: ev.eventId }, select: { payloadHash: true } });
        if (again?.payloadHash !== hash) { fail(res, 409, "VALIDATION_ERROR", "这个 eventId 已经用来发过别的内容"); return; }
        reply("DUPLICATE");
        return;
      }
      reply("IGNORED_OLDER");
      return;
    }
    const isOlder = !!shipment.chaipaiState && ev.sequence <= shipment.chaipaiState.lastSequence;

    try {
      const info = !isOlder && (ev.status === "OUT_FOR_DELIVERY" || ev.status === "DELIVERED")
        ? await prepareLastmileInfo(cfg, ev)
        : null;
      const out = await applyEvent(ev, hash, req.body, shipment.companyId, info);
      if (out.changed) {
        // 回传不是登录用户，publishAfterWrite 不推；这里自己告诉在线页面「运单变了」
        realtimeHub.publish({
          companyId: shipment.companyId,
          topic: "shipping",
          actor: { userId: OPERATOR.operatorId, role: "staff", agentId: null },
          ...(out.clientId ? { clientIds: [out.clientId] } : {}),
        });
      }
      reply(out.result);
    } catch (error) {
      if (error instanceof NeedsManualError) {
        logger.error("拆派仓回传：要人工处理，先不办（理顺后请拆派仓补发这条）", { eventId: ev.eventId, sourceShipmentId: ev.sourceShipmentId, 原因: error.message });
        fail(res, 503, "INTERNAL_ERROR", "这票要人工处理，请稍后重发");
        return;
      }
      if (error instanceof RetryLaterError) {
        logger.warn("拆派仓回传：暂时办不了，让拆派仓过一会儿重发", { eventId: ev.eventId, 原因: error.message });
        fail(res, 503, "INTERNAL_ERROR", "暂时办不了，请稍后重发");
        return;
      }
      // 两条不同内容的回传同时用了同一个 eventId（消息记录主键撞了）；别的唯一约束冲突照常当 500，让拆派仓重发
      const p2002OnEvent = (error as { code?: string; meta?: { target?: unknown } })?.code === "P2002"
        && JSON.stringify((error as { meta?: { target?: unknown } }).meta?.target ?? "").match(/event_id|eventId|chaipai_callback_events/) !== null;
      if (error instanceof EventIdReusedError || p2002OnEvent) {
        fail(res, 409, "VALIDATION_ERROR", "这个 eventId 已经用来发过别的内容");
        return;
      }
      throw error;
    }
  });
}
