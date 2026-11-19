import { logger } from "../core/logger";
import { finance2HoldsConfig } from "./config";
import { fetchHoldList } from "./client";
import { reportHoldListRecovered, reportHoldListUnavailable, retryPendingReports, type RetryOutcome } from "./reports";
import { readHoldState, recordFetchFailure, replaceHoldList, writeHoldLogs } from "./store";

/**
 * 每 15 分钟去财务系统2 取一次整份扣货名单（约定 5.1、5.3 第 1 条）。
 * 失败重试：等 5 秒、30 秒、2 分钟，三次都不行就这一轮放弃、保留上一份，等下一轮（约定 1.3）。
 * 4xx、格式不对不重试（重试也一样）；429 按 Retry-After 等（最多等 2 分钟）。
 * 开关 off 时什么都不做。同一时间只跑一轮。
 * 报警（约定 1.3、11.2；老板 2026-11-19 答「放货拦截 6」）：401 / 403、配置有问题、连续 1 小时取不到 → 打 error 日志，
 * 并且（有 remote 时）报给财务系统2 老板首页 holdListUnavailable；之后又取到了报一次 holdListRecovered。报的成败不影响取名单。
 */

export const SYNC_INTERVAL_MS = 15 * 60 * 1000;
export const DEFAULT_RETRY_DELAYS_MS = [5_000, 30_000, 120_000];

export type SyncOutcome =
  | { kind: "off" }
  | { kind: "busy" }
  | { kind: "ok"; replaced: boolean; holds?: number; released?: number; note?: string }
  | { kind: "failed"; reason: string };

let running: Promise<SyncOutcome> | null = null;

export function isSyncRunning(): boolean {
  return running !== null;
}

/** 连续这么久没取到就打 error 日志（约定 1.3：连续 1 小时拉不到报警） */
const ALERT_AFTER_MS = 60 * 60 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function syncOnce(retryDelaysMs: number[]): Promise<SyncOutcome> {
  const cfg = finance2HoldsConfig();
  if (!cfg) return { kind: "off" };
  let lastReason = "";
  // 开关开着、连财务的配置却不对：这一轮直接算失败（照本地名单拦，页面上有提示），不去瞎连
  const attempts = cfg.remote ? retryDelaysMs.length : -1;
  if (!cfg.remote) lastReason = `配置有问题，没去取：${cfg.problem}`;
  for (let attempt = 0; attempt <= attempts; attempt++) {
    const r = await fetchHoldList(cfg.remote!);
    if (r.kind === "ok") {
      try {
        const outcome = await replaceHoldList(r.value);
        if (!outcome.replaced) {
          await writeHoldLogs([{ kind: "fetch_fail", result: outcome.reason, listGeneratedAt: r.value.generatedAt }]);
          logger.error("扣货名单：拿到的比本地的还旧，没替换", { 拿到的名单时间: r.value.generatedAt.toISOString() });
          return { kind: "ok", replaced: false, note: outcome.reason };
        }
        await writeHoldLogs([{
          kind: "fetch_ok",
          result: `取到名单：扣 ${outcome.holds} 家、单票放行 ${outcome.released} 票`,
          listGeneratedAt: r.value.generatedAt,
        }]);
        // 之前报过「拿不到名单」：报一次「恢复了」（没报过什么都不发）
        await reportHoldListRecovered(cfg.remote!);
        return { kind: "ok", replaced: true, holds: outcome.holds, released: outcome.released };
      } catch (error) {
        lastReason = `存名单失败：${error instanceof Error ? error.message.slice(0, 200) : String(error)}`;
        break;
      }
    }
    lastReason = r.reason;
    if (!r.retryable || attempt === retryDelaysMs.length) break;
    const wait = r.retryAfterSec !== undefined ? Math.min(r.retryAfterSec * 1000, 120_000) : retryDelaysMs[attempt];
    await sleep(wait);
  }
  let failingSince: Date | null = null;
  try {
    failingSince = await recordFetchFailure(lastReason);
  } catch (error) {
    logger.error("扣货名单：记录取名单失败也没记上", { 原因: error instanceof Error ? error.message : String(error) });
  }
  await writeHoldLogs([{ kind: "fetch_fail", result: "没取到名单，保留上一份", detail: lastReason }]);
  // 约定 1.3：401 / 403（密钥不对）、配置不对、连续 1 小时取不到 → 报警：打 error 日志，同时报给财务系统2 老板首页（约定 11.2）。
  // 「连续」从这一串失败的第一次算起，从来没取到过名单的也算（Codex 审查第 9 条）。
  // 配置有问题（没有 remote）时连不上财务，报不了，只打日志。这一轮只报一次（这里每轮只走到一次）
  const state = await readHoldState().catch(() => null);
  const longDown = !!failingSince && Date.now() - failingSince.getTime() > ALERT_AFTER_MS;
  if (/HTTP 40[13]|配置有问题/.test(lastReason) || longDown) {
    logger.error("扣货名单取不到了，请检查财务系统2 和密钥（照上一份名单拦）", {
      原因: lastReason, 最后取到: state?.fetchedAt?.toISOString() ?? "从来没有", 连续失败起点: failingSince?.toISOString() ?? null,
    });
    if (cfg.remote) {
      await reportHoldListUnavailable(cfg.remote, { reason: lastReason, failingSince: failingSince ?? new Date(), lastFetchedAt: state?.fetchedAt ?? null });
    }
  } else {
    logger.warn("扣货名单这一轮没取到，保留上一份", { 原因: lastReason });
  }
  return { kind: "failed", reason: lastReason };
}

/** 去取一次（定时任务和「立即更新」按钮共用）。正在取的话直接等那一轮的结果，不另起一轮 */
export function syncHoldList(opts: { retryDelaysMs?: number[] } = {}): Promise<SyncOutcome> {
  if (running) return running;
  running = syncOnce(opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS).finally(() => { running = null; });
  return running;
}

/**
 * 定时任务的一轮：先取名单，再把最近 7 天没报进去的「扣着的货被放出去了」补报（约定 11.3）。
 * 两件事互不影响：取名单失败照样补报，补报失败不影响取名单。
 */
export async function runHoldRound(opts: { retryDelaysMs?: number[] } = {}): Promise<{ sync: SyncOutcome; reports: RetryOutcome }> {
  const sync = await syncHoldList(opts).catch((error): SyncOutcome => {
    logger.error("扣货名单定时任务出错", { 原因: error instanceof Error ? error.message : String(error) });
    return { kind: "failed", reason: "定时任务出错" };
  });
  const reports = await retryPendingReports();
  return { sync, reports };
}

/** 启动时先取一次，之后每 15 分钟一次。FINANCE2_HOLDS_SCHEDULER=off 时不启动（测试用） */
export function startFinance2HoldScheduler(): void {
  if (process.env.FINANCE2_HOLDS_SCHEDULER === "off") return;
  const run = () => {
    runHoldRound().catch((error) => logger.error("扣货名单定时任务出错", { 原因: error instanceof Error ? error.message : String(error) }));
  };
  setTimeout(run, 10_000).unref();
  setInterval(run, SYNC_INTERVAL_MS).unref();
}
