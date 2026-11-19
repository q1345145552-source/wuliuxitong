import { prisma } from "../../db/prisma";
import { logger } from "../core/logger";
import { postHoldEvent, type CallResult, type HoldEvent } from "./client";
import { finance2HoldsConfig, type Finance2Remote } from "./config";
import { STATE_ID } from "./store";

/**
 * 物流 → 财务：扣货上报（约定第 11 节；老板 2026-11-19 答「放货拦截 2、6」：这两件事要在财务系统老板首页报警）。
 *   11.1 releasedWhileHeld    拆派仓把扣货名单上的货派出去了（照收，拦不住）
 *   11.2 holdListUnavailable  拿不到扣货名单（401 / 403、连续 1 小时取不到）；holdListRecovered 又取到了
 *
 * 规矩（约定 11.3）：
 *   - 报不进去（连不上、超时、5xx）不丢，下一轮（15 分钟）接着报，直到财务回 200 或 4xx；4xx 打 error 日志、这一条不再报。
 *   - 上报不跟回传、取名单的事务走：报不进去也不影响拆派仓回传、不影响取名单。这里的函数一律不抛异常。
 *   - 开关 off 什么都不报；开关开着（observe 也算：货确实出去了）才报。连财务的配置有问题时报不了，只打日志，
 *     「扣着的货被放出去了」留着 pending，配好以后 15 分钟那一轮补报（最近 7 天的）。
 *
 * 「扣着的货被放出去了」记在 finance2_hold_logs（kind = chaipai）的 report_status 上：pending → sent / rejected。
 * 「拿不到名单」记在 finance2_hold_state.unavailable_report 上：一串失败里报成一次就不再报；又取到名单时报一次「恢复了」。
 */

/** 补报看多久以内的（更早的不再补：财务那边警报早就过时了） */
export const REPORT_RETRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** 一轮最多补报这么多条 */
const REPORT_BATCH = 100;
/** 约定 11.1：entry 1～50 字；11.2：reason 1～200 字 */
const ENTRY_MAX = 50;
const REASON_MAX = 200;

const errText = (error: unknown) => (error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200));

/** reason 里不许带密钥（约定 11.2）：保险起见把密钥原文换掉，再截到 200 字 */
export function safeReason(reason: string, secret: string): string {
  const cleaned = (secret ? reason.split(secret).join("***") : reason).trim();
  return (cleaned || "取不到扣货名单").slice(0, REASON_MAX);
}

interface ChaipaiLogRow {
  id: string;
  customerMark: string | null;
  waybillNo: string | null;
  trackingNo: string | null;
  entry: string | null;
  listGeneratedAt: Date | null;
  createdAt: Date;
}

const ROW_SELECT = { id: true, customerMark: true, waybillNo: true, trackingNo: true, entry: true, listGeneratedAt: true, createdAt: true } as const;

/** 日志行 → 约定 11.1 的请求体。occurredAt 用记日志的时间（回传事务刚提交，就是货出去被我们知道的那一刻） */
export function releasedEventOf(row: ChaipaiLogRow): HoldEvent {
  return {
    kind: "releasedWhileHeld",
    occurredAt: row.createdAt.toISOString(),
    customerMark: row.customerMark ?? "",
    waybillNo: row.waybillNo ?? "",
    trackingNo: row.trackingNo ?? row.waybillNo ?? "",
    entry: (row.entry || "拆派仓回传派送中").slice(0, ENTRY_MAX),
    listGeneratedAt: row.listGeneratedAt ? row.listGeneratedAt.toISOString() : null,
  };
}

type SendOutcome = "sent" | "rejected" | "pending";

/** 报一条，按结果改这一行（只改还是 pending 的：同一条同时被「马上报」和「补报」碰到时，先落定的说了算） */
async function sendReleased(remote: Finance2Remote, row: ChaipaiLogRow): Promise<SendOutcome> {
  const r: CallResult<true> = await postHoldEvent(remote, releasedEventOf(row));
  const now = new Date();
  const where = { id: row.id, reportStatus: "pending" };
  if (r.kind === "ok") {
    await prisma.finance2HoldLog.updateMany({ where, data: { reportStatus: "sent", reportedAt: now, reportError: null } });
    return "sent";
  }
  const reason = safeReason(r.reason, remote.secret);
  if (!r.retryable) {
    await prisma.finance2HoldLog.updateMany({ where, data: { reportStatus: "rejected", reportedAt: now, reportError: reason } });
    logger.error("扣货上报：财务系统2 不收「扣着的货被放出去了」，这一条不再报", { 运单: row.trackingNo, 唛头: row.customerMark, 原因: reason });
    return "rejected";
  }
  await prisma.finance2HoldLog.updateMany({ where, data: { reportError: reason } });
  logger.warn("扣货上报：「扣着的货被放出去了」这一次没报进去，15 分钟后那一轮接着报", { 运单: row.trackingNo, 原因: reason });
  return "pending";
}

/**
 * 拆派仓回传后马上报一次（刚记下的几条 chaipai 日志）。没报进去的留着 pending，15 分钟那一轮补报。
 */
export async function reportReleasedNow(logIds: string[]): Promise<void> {
  if (logIds.length === 0) return;
  try {
    const cfg = finance2HoldsConfig();
    if (!cfg) return;
    if (!cfg.remote) {
      logger.error("扣货上报：连财务系统2 的配置有问题，「扣着的货被放出去了」报不了；配好以后 15 分钟那一轮补报", { 原因: cfg.problem });
      return;
    }
    const rows = await prisma.finance2HoldLog.findMany({ where: { id: { in: logIds }, reportStatus: "pending" }, select: ROW_SELECT, orderBy: { createdAt: "asc" } });
    for (const row of rows) {
      if ((await sendReleased(cfg.remote, row)) === "pending") break; // 财务那边连不上，剩下的也别一条条等超时了
    }
  } catch (error) {
    logger.error("扣货上报出错（不影响拆派仓回传，15 分钟那一轮再报）", { 原因: errText(error) });
  }
}

export type RetryOutcome = { kind: "off" } | { kind: "noRemote" } | { kind: "busy" } | { kind: "done"; tried: number; sent: number; rejected: number; pending: number };

let sweeping: Promise<RetryOutcome> | null = null;

async function retryOnce(now: Date): Promise<RetryOutcome> {
  const cfg = finance2HoldsConfig();
  if (!cfg) return { kind: "off" };
  if (!cfg.remote) return { kind: "noRemote" }; // 配置问题取名单那边已经打过 error 日志了
  const rows = await prisma.finance2HoldLog.findMany({
    where: { kind: "chaipai", reportStatus: "pending", createdAt: { gte: new Date(now.getTime() - REPORT_RETRY_WINDOW_MS) } },
    select: ROW_SELECT,
    orderBy: { createdAt: "asc" },
    take: REPORT_BATCH,
  });
  const out = { kind: "done" as const, tried: 0, sent: 0, rejected: 0, pending: 0 };
  for (const row of rows) {
    out.tried++;
    const r = await sendReleased(cfg.remote, row);
    out[r]++;
    if (r === "pending") break; // 连不上就这一轮到此为止，下一轮再来
  }
  return out;
}

/** 15 分钟那一轮：把最近 7 天还没报成的「扣着的货被放出去了」补报。同一时间只跑一个；不抛异常 */
export function retryPendingReports(now: Date = new Date()): Promise<RetryOutcome> {
  if (sweeping) return Promise.resolve({ kind: "busy" });
  sweeping = retryOnce(now)
    .catch((error): RetryOutcome => {
      logger.error("扣货上报：补报出错（下一轮再来）", { 原因: errText(error) });
      return { kind: "done", tried: 0, sent: 0, rejected: 0, pending: 0 };
    })
    .finally(() => { sweeping = null; });
  return sweeping;
}

/* ───────────── 11.2 拿不到扣货名单 / 恢复了 ───────────── */

async function readUnavailableReport(): Promise<string | null> {
  const row = await prisma.finance2HoldState.findUnique({ where: { id: STATE_ID }, select: { unavailableReport: true } });
  return row?.unavailableReport ?? null;
}

async function setUnavailableReport(value: string | null): Promise<void> {
  await prisma.finance2HoldState.updateMany({ where: { id: STATE_ID }, data: { unavailableReport: value } });
}

/**
 * 取名单这一轮报了警（401 / 403、连续 1 小时取不到）：同时报给财务。一串失败里报成（200）一次就不再报；
 * 财务回 4xx 也不再报（打 error 日志）；没报进去（连不上 / 5xx）下一轮失败时再报。不抛异常、不影响取名单。
 */
export async function reportHoldListUnavailable(
  remote: Finance2Remote,
  info: { reason: string; failingSince: Date; lastFetchedAt: Date | null },
  now: Date = new Date(),
): Promise<void> {
  try {
    const current = await readUnavailableReport();
    if (current === "sent" || current === "rejected") return;
    const r = await postHoldEvent(remote, {
      kind: "holdListUnavailable",
      occurredAt: now.toISOString(),
      reason: safeReason(info.reason, remote.secret),
      failingSince: info.failingSince.toISOString(),
      lastFetchedAt: info.lastFetchedAt ? info.lastFetchedAt.toISOString() : null,
    });
    if (r.kind === "ok") {
      await setUnavailableReport("sent");
    } else if (!r.retryable) {
      await setUnavailableReport("rejected");
      logger.error("扣货上报：财务系统2 不收「拿不到扣货名单」，这一串失败里不再报", { 原因: safeReason(r.reason, remote.secret) });
    } else {
      await setUnavailableReport("pending");
      logger.warn("扣货上报：「拿不到扣货名单」没报进去，下一轮再报", { 原因: safeReason(r.reason, remote.secret) });
    }
  } catch (error) {
    logger.error("扣货上报：报「拿不到扣货名单」出错（不影响取名单）", { 原因: errText(error) });
  }
}

/**
 * 又取到名单了：之前报过「拿不到」（报成了，或者报了没收到回话、财务可能已经收下）→ 报一次「恢复了」。
 * 财务回 200 或 4xx 就清掉记号（4xx 打 error 日志）；没报进去留着，下一次取到名单时再报。之前被财务拒收的直接清掉、不报。
 */
export async function reportHoldListRecovered(remote: Finance2Remote, now: Date = new Date()): Promise<void> {
  try {
    const current = await readUnavailableReport();
    if (current === null) return;
    if (current === "rejected") {
      await setUnavailableReport(null);
      return;
    }
    const r = await postHoldEvent(remote, { kind: "holdListRecovered", occurredAt: now.toISOString() });
    if (r.kind === "ok") {
      await setUnavailableReport(null);
    } else if (!r.retryable) {
      await setUnavailableReport(null);
      logger.error("扣货上报：财务系统2 不收「扣货名单恢复了」，不再报", { 原因: safeReason(r.reason, remote.secret) });
    } else {
      logger.warn("扣货上报：「扣货名单恢复了」没报进去，下一次取到名单时再报", { 原因: safeReason(r.reason, remote.secret) });
    }
  } catch (error) {
    logger.error("扣货上报：报「扣货名单恢复了」出错（不影响取名单）", { 原因: errText(error) });
  }
}
