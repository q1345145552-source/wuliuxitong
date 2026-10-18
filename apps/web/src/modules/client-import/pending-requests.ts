/**
 * 客户批量下单：「发出去了、还没确认建没建好」的那几行的请求编号，按文件内容记在本标签页里（2026-10-18 dsh 审查第 3 轮建议 2）。
 *
 * 为什么要记：每行的请求编号原来只在页面内存里。断网 / 超时以后客户刷新页面、再传同一个文件，所有行都换了新编号，
 * 服务器认不出「上次其实已经建好了」那几行，又建一遍 —— 重复下单。
 *
 * 为什么不是所有行都一直记着：客户可能每次都用一模一样的表下新单（同样的货、同样的箱数）。要是所有行都沿用编号，
 * 第二次下的新单会被当成上一次那张、不再建 —— 比重复下单更糟。所以只管「没收尾干净的那一批」：
 *   - 发出去之前先记下这一行的编号（发到一半刷新页面也算「没确认」）；
 *   - 回来明确建好了：从「没确认」挪到「已建好」（markDone）；后端明确拒了（4xx，肯定没建）：直接删（clearPending）；
 *   - 断网 / 超时 / 服务器出错（结果不确定）的留在「没确认」里；
 *   - 这一批跑完（finishBatch）：没有「没确认」的了 = 收尾干净，整条删掉 —— 以后拿同一份表下新单照旧全是新单；
 *     还有「没确认」的就整条留着（连同「已建好」那几行）。
 * 同一个文件再传（刷新了页面、或者没刷新直接再传）：「已建好」的行不再交（页面说清是哪几行），「没确认」的用回原来的编号
 * （上次其实建好了的，后端认得出来、不再建），其余行新编号。原来只记「没确认」的：同一批里已经确认建好的行，刷新后再传会再建一张；
 * 叫客户删掉建好的行再传，又会让文件指纹变掉、连「没确认」那几行也认不出来（10-18 浏览器实测发现）。
 * 只放 sessionStorage（关掉这个标签页就没了），放一天就过期。存取都可能被浏览器拦（隐私模式等），一律当没有。
 */

const STORAGE_KEY = "xt.clientImport.pending.v1";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** ids：没确认的行 → 请求编号；done：这一批里已经确认建好的行（表格第几行） */
type PendingStore = Record<string, { at: number; ids: Record<string, string>; done?: string[] }>;
/** 只用到 getItem / setItem 的那一点（测试里换成假的） */
export type PendingStorage = Pick<Storage, "getItem" | "setItem">;

/** 本标签页的 sessionStorage；拿不到（隐私模式、被禁用）就是 null */
export function pendingStorage(): PendingStorage | null {
  try {
    return typeof window !== "undefined" && window.sessionStorage ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

function load(storage: PendingStorage | null, now: number): PendingStore {
  if (!storage) return {};
  try {
    const raw = storage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as PendingStore) : {};
    const fresh: PendingStore = {};
    for (const [key, entry] of Object.entries(parsed ?? {})) {
      if (entry && typeof entry.at === "number" && now - entry.at < MAX_AGE_MS && entry.ids && typeof entry.ids === "object") {
        fresh[key] = { at: entry.at, ids: entry.ids, done: Array.isArray(entry.done) ? entry.done.map(String) : [] };
      }
    }
    return fresh;
  } catch {
    return {};
  }
}

function save(storage: PendingStorage | null, store: PendingStore): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // 存不下就算了：最多回到原来的样子（刷新后重传换编号）
  }
}

/** 这个文件上次「没确认」的那几行：表格第几行 → 请求编号 */
export function readPendingIds(storage: PendingStorage | null, fileKey: string, now = Date.now()): Record<string, string> {
  if (!fileKey) return {};
  return { ...(load(storage, now)[fileKey]?.ids ?? {}) };
}

/** 发出去之前记下（发到一半刷新也算没确认） */
export function markPending(storage: PendingStorage | null, fileKey: string, rowNo: number | string, requestId: string, now = Date.now()): void {
  if (!fileKey || !requestId) return;
  const store = load(storage, now);
  const entry = store[fileKey] ?? { at: now, ids: {} };
  entry.ids[String(rowNo)] = requestId;
  entry.at = now;
  store[fileKey] = entry;
  save(storage, store);
}

/** 这个文件这一批里已经确认建好的行（表格第几行）：再传同一个文件时这几行不再交 */
export function readDoneRows(storage: PendingStorage | null, fileKey: string, now = Date.now()): string[] {
  if (!fileKey) return [];
  return [...(load(storage, now)[fileKey]?.done ?? [])];
}

/** 后端明确拒了（肯定没建）就删掉这一行；这个文件什么都不剩了就整条删 */
export function clearPending(storage: PendingStorage | null, fileKey: string, rowNo: number | string, now = Date.now()): void {
  if (!fileKey) return;
  const store = load(storage, now);
  const entry = store[fileKey];
  if (!entry) return;
  delete entry.ids[String(rowNo)];
  if (Object.keys(entry.ids).length === 0 && !(entry.done ?? []).length) delete store[fileKey];
  save(storage, store);
}

/** 确认建好了：从「没确认」挪到「已建好」（这一批没收尾干净时，再传同一个文件不再交这一行） */
export function markDone(storage: PendingStorage | null, fileKey: string, rowNo: number | string, now = Date.now()): void {
  if (!fileKey) return;
  const store = load(storage, now);
  const entry = store[fileKey] ?? { at: now, ids: {}, done: [] };
  delete entry.ids[String(rowNo)];
  const done = entry.done ?? [];
  if (!done.includes(String(rowNo))) done.push(String(rowNo));
  entry.done = done;
  entry.at = now;
  store[fileKey] = entry;
  save(storage, store);
}

/** 一批跑完：没有「没确认」的了就整条删（收尾干净，以后同一份表照旧当新单）；还有就留着 */
export function finishBatch(storage: PendingStorage | null, fileKey: string, now = Date.now()): void {
  if (!fileKey) return;
  const store = load(storage, now);
  const entry = store[fileKey];
  if (!entry || Object.keys(entry.ids).length > 0) return;
  delete store[fileKey];
  save(storage, store);
}

/**
 * 文件内容的指纹：同一份内容（哪怕重新下载、改了文件名）认成同一个。
 * 浏览器不给算（不是 https 等）就退到「文件名 + 大小 + 修改时间」。
 */
export async function fileFingerprint(buffer: ArrayBuffer, file: { name: string; size: number; lastModified?: number }): Promise<string> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
      const digest = await subtle.digest("SHA-256", buffer);
      return `sha256:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
    }
  } catch {
    // 落到下面
  }
  return `file:${file.name}:${file.size}:${file.lastModified ?? 0}`;
}
