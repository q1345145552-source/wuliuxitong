import { prisma } from "../../db/prisma";
import { logger } from "../core/logger";
import { postHoldEvent } from "./client";
import type { Finance2Remote } from "./config";
import { STATE_ID } from "./store";

/**
 * 物流 → 财务：扣货上报（约定第 11.2 节；老板 2026-11-19 答「放货拦截 6」：拿不到名单也要在财务系统老板首页报警）。
 *   holdListUnavailable  拿不到扣货名单（401 / 403、连续 1 小时取不到）
 *   holdListRecovered    又取到了
 *
 * ⚠️ 「扣着的货被拆派仓派出去了」（约定 11.1 releasedWhileHeld）**物流不报**：财务拉运单时自己认出来、自己报警
 *   （财务系统2 ADR 0142，警报 holds.releasedWhileHeld），两边都报就重复了。物流这边只记 chaipai 日志、打 warn（gate.ts）。
 *
 * 规矩（约定 11.3）：报不进去（连不上、超时、5xx）下一轮接着报；4xx 打 error 日志、不再报；报的成败不影响取名单，这里的函数一律不抛异常。
 * 「报到哪一步了」记在 finance2_hold_state.unavailable_report：一串失败里报成一次就不再报；又取到名单时报一次「恢复了」。
 */

/** 约定 11.2：reason 1～200 字 */
const REASON_MAX = 200;

const errText = (error: unknown) => (error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200));

/** reason 里不许带密钥（约定 11.2）：保险起见把密钥原文换掉，再截到 200 字 */
export function safeReason(reason: string, secret: string): string {
  const cleaned = (secret ? reason.split(secret).join("***") : reason).trim();
  return (cleaned || "取不到扣货名单").slice(0, REASON_MAX);
}

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
