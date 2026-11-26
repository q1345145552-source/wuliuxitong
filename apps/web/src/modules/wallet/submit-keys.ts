/**
 * 管理员加 / 减 / 冲掉余额的「一次性提交编号」怎么选（2026-11-27 审查第 1 条：网断以后别把同一笔加两次）。
 *
 * 后端按提交编号去重：同一个编号再来，不再动钱、原样回第一次的结果。所以要防的是「已经办成了、页面却换了新编号再交」：
 *   管理员点确认 → 后端已经提交、回话在路上丢了（手机网络、网关超时）→ 页面不知道办没办成 →
 *   管理员返回修改 / 关掉重开（原来每次都换新编号）再交一次 → 加了两笔。
 *
 * 规矩：
 *   1. 编号跟「这一次填的内容」绑在一起（种类 + 客户 + 金额 + 备注 / 原因 + 水单；冲掉是 那一笔 + 客户 + 原因），内容的「钥匙」见 contentKeyOf。
 *   2. 交出去以后**不知道办没办成**（网断、超时、5xx、回话看不懂）→ 记下「这个内容 → 这个编号」。之后只要内容一样，
 *      不管是原样重试、返回修改没改内容、还是关掉弹窗重开填同一个数，**都用回这个编号**：后端认得出是同一笔，办成过就原样回、
 *      没办成就这次办 —— 怎么都只有一笔。记在浏览器里（刷新页面也还在），24 小时后作废。
 *   3. 后端回了明确的结果 → 把这条记录清掉：
 *      · 成功（包括「这一笔刚才已经办过了」的重复回话）—— 之后同样的内容就是一笔**新的**，换新编号。
 *        出路：网断后看流水已经有了、真想再加一笔同样的数 → 再交一次会拿到「刚才那一笔已经办过了，这次没有再加」，记录清掉，
 *        再交一次就是新的一笔（页面会把这句话写清楚）。
 *      · 后端明确说没办（4xx，带原因）—— 照原因改，改完再交就是新的。
 *   4. 内容改了（金额、备注、客户任何一样）→ 当成另一笔，换新编号（这是有意的：改了内容就是另一个决定）。
 *
 * 纯逻辑、不碰 React，scripts/test-wallet-adjust-source.ts 直接跑。
 */

export type AdjustContent =
  | { kind: "topup" | "deduct"; clientId: string; amount: string; text: string; proof: string }
  | { kind: "reverse"; adjustmentId: string; clientId: string; text: string };

/** 一次性提交编号：32 位十六进制。不用 crypto.randomUUID（不是 https 的局域网地址上没有它） */
export function newSubmitKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 金额统一成两位小数再比（「100」和「100.00」是同一个数）；不是数就原样 */
function normAmount(raw: string): string {
  const t = raw.trim();
  return /^\d+(\.\d{1,2})?$/.test(t) ? Number(t).toFixed(2) : t;
}

/** 字符串的短指纹（水单是一大段 base64，不往浏览器存储里放原文） */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${s.length}:${h.toString(16)}`;
}

/** 这一次填的内容的「钥匙」：一样 ⇔ 是同一笔 */
export function contentKeyOf(c: AdjustContent): string {
  if (c.kind === "reverse") return JSON.stringify(["reverse", c.adjustmentId, c.clientId, c.text.trim()]);
  return JSON.stringify([c.kind, c.clientId, normAmount(c.amount), c.text.trim(), c.proof ? shortHash(c.proof) : ""]);
}

export interface UncertainStore {
  /** 这个内容之前「不知道办没办成」时用的编号 */
  get(contentKey: string): string | undefined;
  /** 记下：这个内容交出去了、不知道办没办成 */
  remember(contentKey: string, submitKey: string): void;
  /** 后端回了明确的结果：清掉 */
  forget(contentKey: string): void;
}

const STORAGE_KEY = "xt.walletAdjust.uncertain.v1";
const TTL_MS = 24 * 60 * 60 * 1000;

type Saved = Record<string, { k: string; t: number }>;

/** 记在浏览器里（拿不到存储就只记在内存里，刷新页面会丢 —— 那就退回「只在这一页里认」） */
export function createUncertainStore(storage: Pick<Storage, "getItem" | "setItem"> | null, now: () => number = Date.now): UncertainStore {
  let memory: Saved = {};
  const load = (): Saved => {
    try {
      const raw = storage?.getItem(STORAGE_KEY);
      if (raw) memory = JSON.parse(raw) as Saved;
    } catch { /* 读不出来就用内存里的 */ }
    const fresh: Saved = {};
    for (const [ck, v] of Object.entries(memory)) if (v && typeof v.k === "string" && now() - v.t < TTL_MS) fresh[ck] = v;
    memory = fresh;
    return memory;
  };
  const save = (next: Saved) => {
    memory = next;
    try { storage?.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* 存不进去就只记在内存里 */ }
  };
  return {
    get: (ck) => load()[ck]?.k,
    remember: (ck, key) => save({ ...load(), [ck]: { k: key, t: now() } }),
    forget: (ck) => {
      const next = { ...load() };
      delete next[ck];
      save(next);
    },
  };
}

/** 这一次交用哪个编号：这个内容之前不知道办没办成 → 用回那个；否则用弹窗这一次的新编号 */
export function pickSubmitKey(store: UncertainStore, contentKey: string, freshKey: string): string {
  return store.get(contentKey) ?? freshKey;
}

/** 交出去以后不知道办没办成（网断、超时、5xx、回话看不懂）。后端明确拒绝（4xx）不是这个 */
export class SubmitOutcomeUnknownError extends Error {
  constructor(detail: string) {
    super(`不确定办成没有（${detail}）：请先看下面的流水，已经有这一笔就不要再点；没有的话原样再点一次（同一笔不会办两遍）`);
  }
}
