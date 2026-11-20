import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../../db/prisma";
import { logger } from "../core/logger";
import type { HoldList } from "./client";

/**
 * 本地存的那份扣货名单（约定 5.3 第 1、5、6 条）。
 * - 取到就整份替换；取不到保留上一份（只记失败原因和时间）。
 * - 晚到的旧名单（generatedAt 比已存的还早）不许盖掉新的。
 * - 「重新核对」记下的可放（finance2_hold_clears）：新名单的 generatedAt 晚于核对时间才作废 ——
 *   比核对还早生成的名单没把这次核对算进去，照它又把人拦回去就不对了。
 */

export const STATE_ID = "current";
/** 名单超过这么久没更新就在放货页提示（老板 2026-11-19 定：超过 1 天） */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
/** 整份替换时排队用的咨询锁编号（83090 已被代理申请用了） */
const REPLACE_LOCK_KEY = 83091;

type Db = PrismaClient | Prisma.TransactionClient;

export interface HoldState {
  generatedAt: Date | null;
  fetchedAt: Date | null;
  lastAttemptAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  failingSince: Date | null;
}

export async function readHoldState(db: Db = prisma): Promise<HoldState> {
  const row = await db.finance2HoldState.findUnique({ where: { id: STATE_ID } });
  return {
    generatedAt: row?.generatedAt ?? null,
    fetchedAt: row?.fetchedAt ?? null,
    lastAttemptAt: row?.lastAttemptAt ?? null,
    lastError: row?.lastError ?? null,
    lastErrorAt: row?.lastErrorAt ?? null,
    failingSince: row?.failingSince ?? null,
  };
}

export type ReplaceOutcome = { replaced: true; holds: number; released: number } | { replaced: false; reason: string };

/** 整份替换排队：定时任务和「立即更新名单」同时来时一个一个换（事务第一句、手里没有行锁，只碰 finance2_hold* 几张表） */
async function lockHoldListReplace(tx: { $executeRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> }): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REPLACE_LOCK_KEY})`;
}

/** 整份替换。返回替换了没有（晚到的旧名单不替换） */
export async function replaceHoldList(list: HoldList, now: Date = new Date()): Promise<ReplaceOutcome> {
  return prisma.$transaction(async (tx) => {
    await lockHoldListReplace(tx);
    const state = await tx.finance2HoldState.findUnique({ where: { id: STATE_ID } });
    if (state?.generatedAt && list.generatedAt < state.generatedAt) {
      // 旧名单不盖新的。不算「取成功」：财务那边的名单时间要是往回跳了（改钟、恢复备份），以后每次都会走到这里，
      // 记成失败页面上才看得到「最近没取到」，不会看着正常、实际一直进不来新名单
      const reason = "拿到的名单比本地的还旧（财务系统的名单时间往回跳了？），没替换";
      await tx.finance2HoldState.update({
        where: { id: STATE_ID },
        data: { lastAttemptAt: now, lastError: reason, lastErrorAt: now, failingSince: state.failingSince ?? now },
      });
      return { replaced: false as const, reason };
    }
    await tx.finance2Hold.deleteMany({});
    await tx.finance2HoldRelease.deleteMany({});
    const CHUNK = 1000;
    for (let i = 0; i < list.holds.length; i += CHUNK) {
      await tx.finance2Hold.createMany({ data: list.holds.slice(i, i + CHUNK) });
    }
    for (let i = 0; i < list.releasedWaybills.length; i += CHUNK) {
      await tx.finance2HoldRelease.createMany({ data: list.releasedWaybills.slice(i, i + CHUNK) });
    }
    // 名单生成时间晚于核对时间：财务那边已经把这次核对算进新名单了，本地记的「可放」作废
    await tx.finance2HoldClear.deleteMany({ where: { clearedAt: { lte: list.generatedAt } } });
    const data = { generatedAt: list.generatedAt, fetchedAt: now, lastAttemptAt: now, lastError: null, lastErrorAt: null, failingSince: null };
    await tx.finance2HoldState.upsert({ where: { id: STATE_ID }, create: { id: STATE_ID, ...data }, update: data });
    return { replaced: true as const, holds: list.holds.length, released: list.releasedWaybills.length };
  }, { timeout: 60_000 });
}

/** 取名单失败：保留上一份不动，只记原因和时间；返回这一串连续失败从什么时候开始 */
export async function recordFetchFailure(reason: string, now: Date = new Date()): Promise<Date> {
  const data = { lastAttemptAt: now, lastError: reason.slice(0, 500), lastErrorAt: now };
  await prisma.finance2HoldState.upsert({ where: { id: STATE_ID }, create: { id: STATE_ID, ...data, failingSince: now }, update: data });
  // 只在还没记过的时候填，带条件更新（两个同时失败也不会把起点往后挪）
  await prisma.finance2HoldState.updateMany({ where: { id: STATE_ID, failingSince: null }, data: { failingSince: now } });
  const row = await prisma.finance2HoldState.findUnique({ where: { id: STATE_ID }, select: { failingSince: true } });
  return row?.failingSince ?? now;
}

export interface HoldLogInput {
  kind: "fetch_ok" | "fetch_fail" | "block" | "observe" | "recheck" | "passive" | "chaipai";
  result: string;
  customerMark?: string | null;
  waybillNo?: string | null;
  trackingNo?: string | null;
  entry?: string | null;
  listGeneratedAt?: Date | null;
  detail?: string | null;
  operatorId?: string | null;
}

function logRow(i: HoldLogInput) {
  return {
    kind: i.kind,
    result: i.result.slice(0, 200),
    customerMark: i.customerMark ?? null,
    waybillNo: i.waybillNo ?? null,
    trackingNo: i.trackingNo ?? null,
    entry: i.entry ?? null,
    listGeneratedAt: i.listGeneratedAt ?? null,
    detail: i.detail ? i.detail.slice(0, 1000) : null,
    operatorId: i.operatorId ?? null,
  };
}

/**
 * 记日志。**记失败只打日志，不让原操作失败**（拦截本身已经决定好了，日志只是给人查的）。
 * ⚠️ 不收 tx：在事务里写失败会把整个事务弄坏（PostgreSQL 25P02），原操作跟着失败。调用方在事务提交 / 撤销之后再调。
 */
export async function writeHoldLogs(rows: HoldLogInput[]): Promise<void> {
  if (rows.length === 0) return;
  try {
    await prisma.finance2HoldLog.createMany({ data: rows.map(logRow) });
  } catch (error) {
    logger.error("扣货日志没记上（不影响操作）", { 条数: rows.length, 原因: error instanceof Error ? error.message : String(error) });
  }
}
