import type { Prisma, PrismaClient } from "@prisma/client";
import { BusinessError } from "../core/business-error";
import { logger } from "../core/logger";
import { prisma } from "../../db/prisma";
import { finance2HoldsConfig, type HoldMode } from "./config";
import { STALE_AFTER_MS, writeHoldLogs, type HoldLogInput } from "./store";

/**
 * 放货前查扣货名单（约定 5.3 第 2、5 条）。只管「判断」，各个放货入口自己决定拦了以后怎么办：
 *   - 单票的入口（尾端派送单……）：有被扣的就整个操作不做，回 409（assertReleasable）。
 *   - 柜子整柜推进：被扣的那几票不推、其余照推、单独列出来（接口⑦ 老板还没定，先这么做，见 routes 里的 heldBack）。
 *
 * 判断规矩：
 *   - 开关 off：什么都不查。
 *   - 从来没取到过名单：不拦，提示「现在没有扣货名单」（老板 2026-11-19 定）。
 *   - 唛头（orders.client_id）在名单上，并且
 *       这票的母运单号不在单票放行里、也没被「重新核对」放过（整个唛头或这一票）→ 被扣。
 *   - 名单超过 1 天没更新：照拦，另外提示（老板 2026-11-19 定）。
 *   - observe 模式：该拦的只记日志不拦，提示照出。
 */

type Db = PrismaClient | Prisma.TransactionClient;

export interface ReleaseCandidate {
  shipmentId: string;
  trackingNo: string;
  parentTrackingNo: string | null;
  /** 唛头 = orders.client_id */
  customerMark: string | null;
}

export interface HeldItem {
  trackingNo: string;
  /** 母运单号（单票放行、重新核对都按它） */
  motherTrackingNo: string;
  customerMark: string;
}

export interface GateResult {
  mode: HoldMode;
  /** true = 真拦（enforce）；false = 不拦（off / observe / 没名单） */
  enforce: boolean;
  listGeneratedAt: Date | null;
  /** 放货页要提示的话（没有名单 / 名单太旧）；没有就是 null */
  notice: string | null;
  /** 在名单上、没放行的（observe 模式下是「本来会拦的」） */
  held: HeldItem[];
}

/** 页面上一律写泰国时间（财务系统2 那边也按泰国时间） */
export function formatListTime(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

export function listLabel(d: Date): string {
  return `按 ${formatListTime(d)}（泰国时间）的名单`;
}

export const NO_LIST_NOTICE = "现在没有扣货名单（还没从财务系统取到过），放货不拦。放货前请自己跟财务核对一下。";

export function staleNotice(generatedAt: Date): string {
  return `扣货名单超过 1 天没更新了（${listLabel(generatedAt)}），可能连不上财务系统。照这份旧名单拦，放货前请跟财务核对一下。`;
}

export function noticeFor(generatedAt: Date | null, now: Date): string | null {
  if (!generatedAt) return NO_LIST_NOTICE;
  if (now.getTime() - generatedAt.getTime() > STALE_AFTER_MS) return staleNotice(generatedAt);
  return null;
}

/** 按运单 id 取判断要用的东西（运单号、母运单号、唛头） */
export async function loadCandidates(db: Db, shipmentIds: string[]): Promise<ReleaseCandidate[]> {
  if (shipmentIds.length === 0) return [];
  const rows = await db.shipment.findMany({
    where: { id: { in: [...new Set(shipmentIds)] } },
    select: { id: true, trackingNo: true, parentTrackingNo: true, order: { select: { clientId: true } } },
  });
  return rows.map((r) => ({ shipmentId: r.id, trackingNo: r.trackingNo, parentTrackingNo: r.parentTrackingNo, customerMark: r.order?.clientId ?? null }));
}

export function motherOf(c: { trackingNo: string; parentTrackingNo: string | null }): string {
  return c.parentTrackingNo || c.trackingNo;
}

interface VerdictRow {
  generated_at: Date | null;
  no: string | null;
  mark: string | null;
  mother: string | null;
  on_list: boolean | null;
  released: boolean | null;
  mark_decision: boolean | null;
  ticket_decision: boolean | null;
}

/**
 * 判断这几票该不该扣（纯规则，测试直接调）：
 *   整家扣不扣 = 「重新核对」问整家的最新答案；没问过就看在不在名单上
 *   这一票扣不扣（整家扣的前提下）= 问这一票的最新答案；没问过就看名单上是不是单票放行了（唛头 + 母运单号都要对上）
 */
export function heldByRules(r: { onList: boolean; released: boolean; markDecision: boolean | null; ticketDecision: boolean | null }): boolean {
  const markBlocked = r.markDecision ?? r.onList;
  if (!markBlocked) return false;
  return r.ticketDecision ?? !r.released;
}

/**
 * 只判断，不拦、不记日志。
 * ⚠️ 名单抬头、扣货名单、单票放行、核对结果**一条 SQL 读完**（2026-11-19 Codex 审查第 3 条）：分几次查的话，整份替换正好
 * 夹在中间提交，会读到「旧名单的扣 + 新名单的放行」拼出来的结果。PostgreSQL 一条语句里看到的是同一个快照。
 * ⚠️ 单票放行按「唛头 + 母运单号」对（第 4 条）：运单号改过 / 删了重建时，旧号可能落到别的客户头上。
 */
export async function evaluateRelease(db: Db, candidates: ReleaseCandidate[], now: Date = new Date()): Promise<GateResult> {
  const cfg = finance2HoldsConfig();
  if (!cfg) return { mode: "off", enforce: false, listGeneratedAt: null, notice: null, held: [] };
  const withMark = candidates.filter((c): c is ReleaseCandidate & { customerMark: string } => !!c.customerMark);
  const nos = withMark.map((c) => c.trackingNo);
  const marks = withMark.map((c) => c.customerMark);
  const mothers = withMark.map(motherOf);
  const rows = await db.$queryRaw<VerdictRow[]>`
    WITH st AS (SELECT generated_at FROM finance2_hold_state WHERE id = 'current'),
         c AS (SELECT * FROM unnest(${nos}::text[], ${marks}::text[], ${mothers}::text[]) AS t(no, mark, mother))
    SELECT (SELECT generated_at FROM st) AS generated_at, c.no, c.mark, c.mother,
      EXISTS (SELECT 1 FROM finance2_holds h WHERE h.customer_mark = c.mark) AS on_list,
      EXISTS (SELECT 1 FROM finance2_hold_releases r WHERE r.waybill_no = c.mother AND r.customer_mark = c.mark) AS released,
      (SELECT d.blocked FROM finance2_hold_clears d
        WHERE d.customer_mark = c.mark AND d.waybill_no IS NULL AND d.cleared_at > (SELECT generated_at FROM st)
        ORDER BY d.cleared_at DESC, d.blocked DESC LIMIT 1) AS mark_decision,
      (SELECT d.blocked FROM finance2_hold_clears d
        WHERE d.customer_mark = c.mark AND d.waybill_no = c.mother AND d.cleared_at > (SELECT generated_at FROM st)
        ORDER BY d.cleared_at DESC, d.blocked DESC LIMIT 1) AS ticket_decision
    FROM (SELECT 1) AS one LEFT JOIN c ON true`;
  const generatedAt = rows[0]?.generated_at ?? null;
  const notice = [cfg.problem ? `扣货名单的配置有问题，取不到新名单、「重新核对」问不了，请找管理员（${cfg.problem}）。` : null, noticeFor(generatedAt, now)]
    .filter(Boolean).join(" ") || null;
  if (!generatedAt) return { mode: cfg.mode, enforce: false, listGeneratedAt: null, notice, held: [] };
  const held: HeldItem[] = rows
    .filter((r) => r.no && r.mark && r.mother && heldByRules({
      onList: !!r.on_list, released: !!r.released, markDecision: r.mark_decision, ticketDecision: r.ticket_decision,
    }))
    .map((r) => ({ trackingNo: r.no!, motherTrackingNo: r.mother!, customerMark: r.mark! }));
  return { mode: cfg.mode, enforce: cfg.mode === "enforce", listGeneratedAt: generatedAt, notice, held };
}

/** 前端认这个开头，弹出「扣货名单」那一块（重新核对按钮在那里） */
export const HOLD_MESSAGE_MARK = "【扣货】";

export function heldMessage(held: HeldItem[], generatedAt: Date, verb = "不能放货"): string {
  const byMark = new Map<string, string[]>();
  for (const h of held) {
    const list = byMark.get(h.customerMark) ?? [];
    if (!list.includes(h.trackingNo)) list.push(h.trackingNo);
    byMark.set(h.customerMark, list);
  }
  const who = [...byMark].map(([mark, nos]) => `${mark}（${nos.join("、")}）`).join("；");
  const lead = byMark.size > 1 ? "这几家客户有欠款" : "这家客户有欠款";
  return `${HOLD_MESSAGE_MARK}${lead}，放货前请联系财务：${who}，${verb}。${listLabel(generatedAt)}。钱已经付了的，可以在「扣货名单」那里点「重新核对」。`;
}

export class HoldBlockedError extends BusinessError {
  constructor(public readonly result: GateResult) {
    super(heldMessage(result.held, result.listGeneratedAt!), 409);
  }
}

/** 日志不跟事务走、不等它写完（写不上只打日志）；测试用 flushHoldLogs 等它写完 */
const pending = new Set<Promise<void>>();
function logLater(rows: HoldLogInput[]): void {
  if (rows.length === 0) return;
  const p = writeHoldLogs(rows).finally(() => pending.delete(p));
  pending.add(p);
}
export async function flushHoldLogs(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}

export function logHeld(result: GateResult, ctx: { entry: string; operatorId?: string | null }, kind: "block" | "observe" | "passive" | "chaipai", outcome: string): void {
  logLater(result.held.map((h) => ({
    kind,
    result: outcome,
    customerMark: h.customerMark,
    waybillNo: h.motherTrackingNo,
    trackingNo: h.trackingNo,
    entry: ctx.entry,
    listGeneratedAt: result.listGeneratedAt,
    operatorId: ctx.operatorId ?? null,
  })));
}

/** 整批推进的事务提交以后记日志：enforce 记「拦了」，observe 记「本来会拦」 */
export function logHeldAfterCommit(result: GateResult, ctx: { entry: string; operatorId?: string | null }, outcome: string): void {
  if (result.held.length === 0) return;
  if (result.enforce) logHeld(result, ctx, "block", outcome);
  else logHeld(result, ctx, "observe", "试运行：本来会拦，没拦");
}

/**
 * 单票入口用：判断，被扣的就抛 HoldBlockedError（整个操作不做，事务一起撤）。
 * observe 模式只记日志不拦。返回判断结果（调用方可以把 notice 带给前端）。
 */
export async function assertReleasable(db: Db, candidates: ReleaseCandidate[], ctx: { entry: string; operatorId?: string | null }): Promise<GateResult> {
  const result = await evaluateRelease(db, candidates);
  if (result.held.length === 0) return result;
  if (result.enforce) {
    logHeld(result, ctx, "block", "拦了");
    throw new HoldBlockedError(result);
  }
  logHeld(result, ctx, "observe", "试运行：本来会拦，没拦");
  return result;
}

/** 「往外放」的两步：运单推到这两个状态时查扣货名单（约定 5.3 第 2 条） */
export const RELEASE_STATUSES: ReadonlySet<string> = new Set(["deliveryBooked", "outForDelivery"]);

/** 已经带着 order.clientId 查出来的运单行 → 判断用的候选 */
export function toCandidate(row: { id: string; trackingNo: string; parentTrackingNo: string | null; order?: { clientId: string | null } | null }): ReleaseCandidate {
  return { shipmentId: row.id, trackingNo: row.trackingNo, parentTrackingNo: row.parentTrackingNo, customerMark: row.order?.clientId ?? null };
}

/**
 * 整批推进用（柜子推到预约派送）：被扣的那几票挑出来不推，其余照推（接口⑦ 老板还没定，先这么做）。
 * 返回要扣下的运单 id；observe 模式一票都不扣。**不记日志**：调用方等事务提交后调 logHeldAfterCommit。
 */
export async function splitHeldForBatch(db: Db, candidates: ReleaseCandidate[]): Promise<{ heldIds: Set<string>; result: GateResult }> {
  const result = await evaluateRelease(db, candidates);
  if (result.held.length === 0 || !result.enforce) return { heldIds: new Set(), result };
  const heldNos = new Set(result.held.map((h) => h.trackingNo));
  return { heldIds: new Set(candidates.filter((c) => heldNos.has(c.trackingNo)).map((c) => c.shipmentId)), result };
}

/**
 * 拆派仓回传「派送中」（接口⑧ 老板还没定，先这么做）：货已经在外面了，照收；名单上的记一条日志、打警告。
 * 在回传事务提交之后调，不等它；出错只打日志。
 */
export async function noteChaipaiRelease(shipmentId: string): Promise<void> {
  try {
    if (!finance2HoldsConfig()) return;
    const result = await evaluateRelease(prisma, await loadCandidates(prisma, [shipmentId]));
    if (result.held.length === 0) return;
    logHeld(result, { entry: "拆派仓回传派送中", operatorId: null }, "chaipai", "货已经由拆派仓派出去了，拦不住，照收");
    logger.warn("扣货名单上的货被拆派仓派出去了（照收，请通知财务）", {
      运单: result.held.map((h) => h.trackingNo), 唛头: [...new Set(result.held.map((h) => h.customerMark))],
    });
  } catch (error) {
    logger.error("拆派仓回传后查扣货名单出错（回传照常）", { 原因: error instanceof Error ? error.message : String(error) });
  }
}
