import type { Finance2Remote } from "./config";
import { fetchWithDeadline, readBodyWithDeadline } from "../core/fetch-deadline";

/**
 * 去财务系统2 取扣货名单 / 实时核对（约定第 5 节）。密钥只在后台用，不下发浏览器、不打日志。
 *   GET {base}/holds                                   → { serverTime, generatedAt, holds:[{customerMark, heldSince}], releasedWaybills:[{waybillNo, customerMark, releasedAt}] }
 *   GET {base}/holds/check?customerMark=…[&waybillNo=…] → { serverTime, customerMark, waybillNo, blocked, checkedAt }
 * 超时：名单 10 秒、核对 5 秒（约定 1.3）。一律不跟随跳转；等头、读 body 都走 core/fetch-deadline.ts（CLAUDE.md 第 44 条）。
 * 格式不对（缺字段、时间不带时区、blocked 不是布尔……）一律当失败，**不猜**：名单失败就留着上一份，核对失败就按本地名单拦。
 */

export type CallResult<T> =
  | { kind: "ok"; value: T }
  /** retryable：5xx / 超时 / 连不上 / 429，下一次可以再试；4xx 和格式错不重试 */
  | { kind: "error"; reason: string; retryable: boolean; retryAfterSec?: number; /** 对方回的 HTTP 状态码（连不上 / 超时没有） */ status?: number };

export interface HoldList {
  generatedAt: Date;
  holds: Array<{ customerMark: string; heldSince: Date }>;
  releasedWaybills: Array<{ waybillNo: string; customerMark: string; releasedAt: Date }>;
}

export interface HoldCheck {
  customerMark: string;
  waybillNo: string | null;
  blocked: boolean;
  /** 财务那边核对的时间（没给 checkedAt 就用它的 serverTime，两个都没有 / 不带时区 = 格式错）。
   *  记核对结果用它，不用物流服务器的钟：要跟财务名单的 generatedAt 比先后，两台服务器的钟对不齐会误放 / 误拦 */
  checkedAt: Date;
}

/** 名单最大 8 MiB（一万个唛头也就几百 KB） */
const LIST_MAX_BYTES = 8 * 1024 * 1024;
const CHECK_MAX_BYTES = 64 * 1024;
export const LIST_TIMEOUT_MS = 10_000;
export const CHECK_TIMEOUT_MS = 5_000;

/** 唛头、运单号：去不掉的空白和控制字符不要；长度跟物流系统自己的号对得上 */
function code(v: unknown, max: number): string | null {
  if (typeof v !== "string" || v.length === 0 || v.length > max) return null;
  if (v !== v.trim() || /[\x00-\x1f\x7f]/.test(v)) return null;
  return v;
}

/** 约定 1.2：时间一律带时区（Z 或 ±hh:mm），不带的按格式错 */
export function zonedTime(v: unknown): Date | null {
  if (typeof v !== "string" || v.length > 40) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/.test(v)) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t) : null;
}

export function parseHoldList(body: unknown): HoldList | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "名单不是 JSON 对象";
  const b = body as Record<string, unknown>;
  const generatedAt = zonedTime(b.generatedAt);
  if (!generatedAt) return "generatedAt 缺失或不带时区";
  if (!Array.isArray(b.holds)) return "holds 不是数组";
  if (!Array.isArray(b.releasedWaybills)) return "releasedWaybills 不是数组";
  const holds = new Map<string, Date>();
  for (const [i, raw] of b.holds.entries()) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const mark = code(r.customerMark, 128);
    const heldSince = zonedTime(r.heldSince);
    if (!mark || !heldSince) return `holds 第 ${i + 1} 条格式不对`;
    const prev = holds.get(mark);
    if (!prev || heldSince < prev) holds.set(mark, heldSince);
  }
  const released = new Map<string, { waybillNo: string; customerMark: string; releasedAt: Date }>();
  for (const [i, raw] of b.releasedWaybills.entries()) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const waybillNo = code(r.waybillNo, 128);
    const mark = code(r.customerMark, 128);
    const releasedAt = zonedTime(r.releasedAt);
    if (!waybillNo || !mark || !releasedAt) return `releasedWaybills 第 ${i + 1} 条格式不对`;
    released.set(waybillNo, { waybillNo, customerMark: mark, releasedAt });
  }
  return {
    generatedAt,
    holds: [...holds].map(([customerMark, heldSince]) => ({ customerMark, heldSince })),
    releasedWaybills: [...released.values()],
  };
}

export function parseHoldCheck(body: unknown, askedMark: string, askedWaybill: string | null): HoldCheck | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "核对结果不是 JSON 对象";
  const b = body as Record<string, unknown>;
  if (typeof b.blocked !== "boolean") return "blocked 不是 true / false";
  // 回的不是问的那个唛头 / 那票：当失败（宁可按本地名单拦，也不拿别人的结果放货）
  if (b.customerMark !== askedMark) return "回的唛头跟问的不一样";
  if (askedWaybill && b.waybillNo !== askedWaybill) return "回的运单号跟问的不一样";
  // 只问唛头时，回的必须也是「整家」的答案：带了某张运单号回来，可能是单票的结果，不能当成整家放（Codex 审查第 6 条）
  if (!askedWaybill && b.waybillNo !== undefined && b.waybillNo !== null) return "只问了唛头，回的却带着运单号";
  // 时间要么不给、要么带时区；checkedAt 给了却认不出来也算格式错，不往下找 serverTime 凑
  if (b.checkedAt !== undefined && b.checkedAt !== null && !zonedTime(b.checkedAt)) return "checkedAt 不带时区或认不出来";
  const checkedAt = zonedTime(b.checkedAt) ?? zonedTime(b.serverTime);
  if (!checkedAt) return "没有核对时间（checkedAt / serverTime 都没有或不带时区）";
  return { customerMark: askedMark, waybillNo: askedWaybill, blocked: b.blocked, checkedAt };
}

function retryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const n = Number(header);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** 带密钥 GET 一个财务系统2 的只读接口、读出 JSON（扣货名单和代理钱包共用） */
export async function getFinance2Json(cfg: Finance2Remote, url: string, timeoutMs: number, maxBytes: number): Promise<CallResult<unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let body: Buffer | null;
    try {
      const response = await fetchWithDeadline(url, {
        headers: { Authorization: `Bearer ${cfg.secret}`, Accept: "application/json" },
        redirect: "error",
        signal: controller.signal,
      });
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        const s = response.status;
        return {
          kind: "error",
          reason: s === 401 || s === 403 ? `HTTP ${s}（密钥不对或不许调）` : `HTTP ${s}`,
          retryable: s >= 500 || s === 429,
          retryAfterSec: s === 429 ? retryAfter(response.headers.get("retry-after")) : undefined,
          status: s,
        };
      }
      body = await readBodyWithDeadline(response, controller.signal, maxBytes);
    } catch (error) {
      return { kind: "error", reason: controller.signal.aborted ? "超时" : "连不上", retryable: true };
    }
    if (!body) return { kind: "error", reason: "返回内容太大", retryable: false };
    try {
      return { kind: "ok", value: JSON.parse(body.toString("utf8")) };
    } catch {
      return { kind: "error", reason: "返回的不是 JSON", retryable: false };
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchHoldList(cfg: Finance2Remote, timeoutMs = LIST_TIMEOUT_MS): Promise<CallResult<HoldList>> {
  const r = await getFinance2Json(cfg, `${cfg.apiBase}/holds`, timeoutMs, LIST_MAX_BYTES);
  if (r.kind !== "ok") return r;
  const parsed = parseHoldList(r.value);
  return typeof parsed === "string" ? { kind: "error", reason: `名单格式不对：${parsed}`, retryable: false } : { kind: "ok", value: parsed };
}

export async function checkHold(
  cfg: Finance2Remote,
  customerMark: string,
  waybillNo: string | null,
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<CallResult<HoldCheck>> {
  const qs = new URLSearchParams({ customerMark });
  if (waybillNo) qs.set("waybillNo", waybillNo);
  const r = await getFinance2Json(cfg, `${cfg.apiBase}/holds/check?${qs.toString()}`, timeoutMs, CHECK_MAX_BYTES);
  if (r.kind !== "ok") return r;
  const parsed = parseHoldCheck(r.value, customerMark, waybillNo);
  return typeof parsed === "string" ? { kind: "error", reason: `核对结果格式不对：${parsed}`, retryable: false } : { kind: "ok", value: parsed };
}

/* ───────────── 物流 → 财务：扣货上报（约定第 11.2 节，老板 2026-11-19 答「放货拦截 6」） ─────────────
   只报「拿不到名单 / 恢复了」。约定 11.1 releasedWhileHeld（拆派仓把扣着的货派出去了）物流不报：
   财务拉运单时自己认出来、自己报警（财务系统2 ADR 0142）。 */

/** 上报一件事等多久（约定没单写，跟取名单一样 10 秒） */
export const EVENT_TIMEOUT_MS = 10_000;
/** 约定 11：请求体不超过 8 KB */
const EVENT_MAX_BYTES = 8 * 1024;
const EVENT_REPLY_MAX_BYTES = 64 * 1024;

/** 约定 11.2：拿不到扣货名单 */
export interface HoldListUnavailableEvent {
  kind: "holdListUnavailable";
  occurredAt: string;
  reason: string;
  failingSince: string;
  lastFetchedAt: string | null;
}
/** 约定 11.2：又取到了 */
export interface HoldListRecoveredEvent {
  kind: "holdListRecovered";
  occurredAt: string;
}
export type HoldEvent = HoldListUnavailableEvent | HoldListRecoveredEvent;

/**
 * POST {base}/hold-events 报一件事（约定 11）。一次报一件；同一件事重报财务那边只算一条，所以失败了放心重发。
 * 结果：ok = 财务回 200；error 里 retryable = 连不上、超时、5xx、429、别的不是 200 的（下一轮接着报），
 * 不是 retryable = 4xx（调用方打 error 日志、这一条不再报）。
 * 密钥只在请求头；reason 由调用方保证不带密钥。一律不跟随跳转；等头、读 body 都走 core/fetch-deadline.ts。
 */
export async function postHoldEvent(cfg: Finance2Remote, event: HoldEvent, timeoutMs = EVENT_TIMEOUT_MS): Promise<CallResult<true>> {
  const payload = JSON.stringify(event);
  if (Buffer.byteLength(payload, "utf8") > EVENT_MAX_BYTES) return { kind: "error", reason: "上报内容超过 8 KB", retryable: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchWithDeadline(`${cfg.apiBase}/hold-events`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.secret}`, Accept: "application/json", "Content-Type": "application/json; charset=utf-8" },
        body: payload,
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      return { kind: "error", reason: controller.signal.aborted ? "超时" : "连不上", retryable: true };
    }
    const s = response.status;
    // 回话只看状态码；4xx 时带上财务回的 message（截短，方便查是哪个字段不对）
    let message = "";
    try {
      const body = await readBodyWithDeadline(response, controller.signal, EVENT_REPLY_MAX_BYTES);
      if (body && s >= 400 && s < 500) {
        const parsed = JSON.parse(body.toString("utf8")) as { message?: unknown } | null;
        if (typeof parsed?.message === "string") message = parsed.message.slice(0, 200);
      }
    } catch { /* 回话读不出来不影响结果 */ }
    if (s === 200) return { kind: "ok", value: true };
    const rejected = s >= 400 && s < 500 && s !== 429;
    return {
      kind: "error",
      reason: (s === 401 || s === 403 ? `HTTP ${s}（密钥不对或不许调）` : `HTTP ${s}`) + (message ? `：${message}` : ""),
      retryable: !rejected,
      status: s,
    };
  } finally {
    clearTimeout(timer);
  }
}
