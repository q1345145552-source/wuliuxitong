// B-4a: 已从 node:sqlite 迁移到 Prisma + PostgreSQL（2026-05-20）
import { prisma } from "../../db/prisma";

interface OpenErApiResponse {
  result?: string;
  rates?: Record<string, number>;
  time_last_update_utc?: string;
}

const DEFAULT_EXCHANGE_RATE_API = "https://open.er-api.com/v6/latest/CNY";
const REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1000;

let syncingPromise: Promise<void> | null = null;

/**
 * 读取当前已存储的 CNY/THB 汇率记录。
 */
export async function getCurrentCnyThbRate(): Promise<{ rate: number; updatedAt: string } | null> {
  const row = await prisma.clientExchangeRate.findUnique({
    where: { baseCurrency_quoteCurrency: { baseCurrency: "CNY", quoteCurrency: "THB" } },
    select: { rate: true, updatedAt: true },
  });
  if (!row) return null;
  return { rate: Number(row.rate.toString()), updatedAt: row.updatedAt.toISOString() };
}

/**
 * 将最新 CNY/THB 汇率写入数据库。
 */
export async function upsertCnyThbRate(input: { rate: number; updatedAt?: string }): Promise<void> {
  const updatedAt = input.updatedAt ? new Date(input.updatedAt) : new Date();
  await prisma.clientExchangeRate.upsert({
    where: { baseCurrency_quoteCurrency: { baseCurrency: "CNY", quoteCurrency: "THB" } },
    update: { rate: input.rate, updatedAt },
    create: { baseCurrency: "CNY", quoteCurrency: "THB", rate: input.rate, updatedAt },
  });
}

/**
 * 从外部行情服务获取 CNY/THB 实时汇率。
 */
export async function fetchLiveCnyThbRate(): Promise<{ rate: number; updatedAt: string }> {
  const endpoint = process.env.EXCHANGE_RATE_API_URL?.trim() || DEFAULT_EXCHANGE_RATE_API;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(endpoint, { method: "GET", signal: controller.signal });
  if (!response.ok) {
    throw new Error(`exchange api http ${response.status}`);
  }
  const data = (await response.json()) as OpenErApiResponse;
  const rate = data?.rates?.THB;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
    throw new Error("invalid THB rate from exchange api");
  }
  const updatedAt = new Date(data.time_last_update_utc ?? Date.now()).toISOString();
  return { rate, updatedAt };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 判断汇率记录是否超过刷新间隔。
 */
function isRateStale(updatedAt: string, nowIso: string): boolean {
  const updatedMs = Date.parse(updatedAt);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(updatedMs) || !Number.isFinite(nowMs)) return true;
  return nowMs - updatedMs >= REFRESH_INTERVAL_MS;
}

/**
 * 如汇率已过刷新间隔，则拉取外部行情并更新数据库；否则复用缓存。
 */
export async function refreshCnyThbRateIfStale(): Promise<{
  rate: number;
  updatedAt: string;
  refreshed: boolean;
}> {
  const nowIso = new Date().toISOString();
  const current = await getCurrentCnyThbRate();
  if (current && !isRateStale(current.updatedAt, nowIso)) {
    return { rate: current.rate, updatedAt: current.updatedAt, refreshed: false };
  }

  if (!syncingPromise) {
    syncingPromise = (async () => {
      const live = await fetchLiveCnyThbRate();
      await upsertCnyThbRate({ rate: live.rate, updatedAt: live.updatedAt });
    })()
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.error("[exchange-rate] refresh failed:", error);
      })
      .finally(() => {
        syncingPromise = null;
      });
  }
  await syncingPromise;

  const latest = await getCurrentCnyThbRate();
  if (latest) {
    return { rate: latest.rate, updatedAt: latest.updatedAt, refreshed: true };
  }

  // Try EXCHANGE_RATE_FALLBACK env var first, then last-resort fallback
  const envRate = Number(process.env.EXCHANGE_RATE_FALLBACK?.trim());
  if (Number.isFinite(envRate) && envRate > 0) {
    console.warn(`[exchange-rate] using EXCHANGE_RATE_FALLBACK: ${envRate}`);
    return { rate: envRate, updatedAt: nowIso, refreshed: false };
  }
  return { rate: 5.06, updatedAt: nowIso, refreshed: false };
}

/**
 * 启动汇率自动刷新任务（每天 0 点执行一次，启动时先执行一次）。
 */
export function startDailyExchangeRateScheduler(): void {
  const run = async () => {
    const result = await refreshCnyThbRateIfStale();
    // eslint-disable-next-line no-console
    console.log(
      `[exchange-rate] CNY/THB=${result.rate.toFixed(4)} updatedAt=${result.updatedAt} refreshed=${result.refreshed}`,
    );
  };

  // 启动时立即执行一次
  void run();

  // 计算距离下一个 0 点（UTC+8 北京时间）的毫秒数
  const scheduleMidnight = () => {
    const now = new Date();
    // 使用 UTC+8 计算
    const utc8 = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const midnight = new Date(
      Date.UTC(utc8.getUTCFullYear(), utc8.getUTCMonth(), utc8.getUTCDate() + 1, 0, 0, 0),
    );
    const delayMs = midnight.getTime() - now.getTime();
    return delayMs;
  };

  const scheduleNext = () => {
    const delay = scheduleMidnight();
    setTimeout(() => {
      void run();
      // 之后每 24 小时执行
      setInterval(() => {
        void run();
      }, 24 * 60 * 60 * 1000);
    }, delay);
  };

  scheduleNext();
}
