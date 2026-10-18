/**
 * 客户批量下单：「发出去了、还没确认建没建好」的那几行的请求编号，按文件内容记在本标签页里（2026-10-18 dsh 审查第 3 轮建议 2）。
 *
 * 为什么要记：每行的请求编号原来只在页面内存里。断网 / 超时以后客户刷新页面、再传同一个文件，所有行都换了新编号，
 * 服务器认不出「上次其实已经建好了」那几行，又建一遍 —— 重复下单。
 *
 * 为什么不是所有行都一直记着：客户可能每次都用一模一样的表下新单（同样的货、同样的箱数）。要是所有行都沿用编号，
 * 第二次下的新单会被当成上一次那张、不再建 —— 比重复下单更糟。所以只管「没收尾干净的那一批」：
 *   - 发出去之前先记下这一行的编号（发到一半刷新页面也算「没确认」）；
 *   - 回来明确建好了：从「没确认」挪到「已建好」（markDone，连这一行的内容一起记）；后端明确拒了（4xx，肯定没建）：直接删（clearPending）；
 *   - 断网 / 超时 / 服务器出错（结果不确定）的留在「没确认」里；
 *   - 这一批跑完（finishBatch）：一行不落全建好了 = 收尾干净，整条删掉 —— 以后拿同一份表下新单照旧全是新单；
 *     有没下成的（不管是不确定还是明确失败）就整条留着（连同「已建好」那几行）。
 * 同一个文件再传（刷新了页面、或者没刷新直接再传）：「已建好」的行不再交（页面说清是哪几行），「没确认」的用回原来的编号
 * （上次其实建好了的，后端认得出来、不再建），其余行新编号。
 * 换了文件（把失败那行改好、另存了）再传：内容变了、指纹变了，对不上号 —— 那就按每一行的内容比：跟这个客户没收尾那几批里
 * 「已建好」的某一行一模一样的，页面标出来、提交前再问一次（不自动跳过：真要再下一单的也有）。
 * 第一版只记「没确认」的：同一批里已经确认建好的行，刷新后再传会再建一张（10-18 浏览器实测发现）；
 * 审查第 1 轮：有明确失败的那一批收尾时整条删了，改了文件再传也认不出（dsh）；不同客户在同一个标签页里共用记号（dsh）。
 * 记号的键前面带客户唛头（文件键 = 唛头|指纹），别的客户看不到。
 * 只放 sessionStorage（关掉这个标签页就没了），放一天就过期。存取都可能被浏览器拦（隐私模式等），一律当没有。
 */

const STORAGE_KEY = "xt.clientImport.pending.v1";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** ids：没确认的行 → 请求编号；done：这一批里已经确认建好的行（表格第几行 + 这一行的内容） */
type DoneRow = { row: string; sig: string };
type PendingEntry = { at: number; ids: Record<string, string>; done: DoneRow[] };
type PendingStore = Record<string, PendingEntry>;
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
    const parsed = raw ? (JSON.parse(raw) as Record<string, any>) : {};
    const fresh: PendingStore = {};
    for (const [key, entry] of Object.entries(parsed ?? {})) {
      if (!entry || typeof entry.at !== "number" || now - entry.at >= MAX_AGE_MS || !entry.ids || typeof entry.ids !== "object") continue;
      const done: DoneRow[] = Array.isArray(entry.done)
        ? entry.done.map((d: any) => (d && typeof d === "object" ? { row: String(d.row), sig: String(d.sig ?? "") } : { row: String(d), sig: "" }))
        : [];
      fresh[key] = { at: entry.at, ids: entry.ids, done };
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

/** 这个文件这一批里已经确认建好的行（表格第几行）：再传同一个文件时这几行不再交 */
export function readDoneRows(storage: PendingStorage | null, fileKey: string, now = Date.now()): string[] {
  if (!fileKey) return [];
  return (load(storage, now)[fileKey]?.done ?? []).map((d) => d.row);
}

/** 同一个客户（键前缀「唛头|」）别的文件没收尾那几批里，已经建好的那些行的内容：换了文件再传时拿来比 */
export function readDoneSignatures(storage: PendingStorage | null, ownerPrefix: string, exceptFileKey: string, now = Date.now()): string[] {
  if (!ownerPrefix) return [];
  const out: string[] = [];
  for (const [key, entry] of Object.entries(load(storage, now))) {
    if (key === exceptFileKey || !key.startsWith(ownerPrefix)) continue;
    for (const d of entry.done) if (d.sig) out.push(d.sig);
  }
  return out;
}

/** 发出去之前记下（发到一半刷新也算没确认） */
export function markPending(storage: PendingStorage | null, fileKey: string, rowNo: number | string, requestId: string, now = Date.now()): void {
  if (!fileKey || !requestId) return;
  const store = load(storage, now);
  const entry = store[fileKey] ?? { at: now, ids: {}, done: [] };
  entry.ids[String(rowNo)] = requestId;
  entry.at = now;
  store[fileKey] = entry;
  save(storage, store);
}

/** 后端明确拒了（肯定没建）就删掉这一行；这个文件什么都不剩了就整条删 */
export function clearPending(storage: PendingStorage | null, fileKey: string, rowNo: number | string, now = Date.now()): void {
  if (!fileKey) return;
  const store = load(storage, now);
  const entry = store[fileKey];
  if (!entry) return;
  delete entry.ids[String(rowNo)];
  if (Object.keys(entry.ids).length === 0 && entry.done.length === 0) delete store[fileKey];
  save(storage, store);
}

/** 确认建好了：从「没确认」挪到「已建好」，连这一行的内容（rowSignature）一起记 */
export function markDone(storage: PendingStorage | null, fileKey: string, rowNo: number | string, sig: string, now = Date.now()): void {
  if (!fileKey) return;
  const store = load(storage, now);
  const entry = store[fileKey] ?? { at: now, ids: {}, done: [] };
  delete entry.ids[String(rowNo)];
  if (!entry.done.some((d) => d.row === String(rowNo))) entry.done.push({ row: String(rowNo), sig });
  entry.at = now;
  store[fileKey] = entry;
  save(storage, store);
}

/** 一批跑完：hadFailures = 这一批有没下成的（不确定的、明确失败的都算）。一行不落全建好了就整条删；有没下成的就留着 */
export function finishBatch(storage: PendingStorage | null, fileKey: string, hadFailures: boolean, now = Date.now()): void {
  if (!fileKey || hadFailures) return;
  const store = load(storage, now);
  const entry = store[fileKey];
  if (!entry || Object.keys(entry.ids).length > 0) return;
  delete store[fileKey];
  save(storage, store);
}

/** 一行货的内容（换了文件再传时拿来比「是不是上次已经建好的那一行」）：只看会交给后端的那几格，行号、编号不算 */
export function rowSignature(row: {
  warehouseId?: string | null; itemName?: string; packageCount?: number; packageUnit?: string; weightKg?: number; volumeM3?: number;
  shipDate?: string; domesticTrackingNo?: string; transportMode?: string | null; cargoType?: string | null;
}): string {
  return JSON.stringify([
    row.warehouseId ?? "", (row.itemName ?? "").trim(), row.packageCount ?? null, row.packageUnit ?? "", row.weightKg ?? null, row.volumeM3 ?? null,
    row.shipDate ?? "", (row.domesticTrackingNo ?? "").trim(), row.transportMode ?? "", row.cargoType ?? "",
  ]);
}

/** 浏览器不给算摘要时（不是 https 等）的兜底：按文件内容逐字节算两路 32 位 FNV-1a，再带上长度 —— 仍然是「内容」指纹，不看文件名 */
function fallbackContentHash(bytes: Uint8Array): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < bytes.length; i++) {
    a = Math.imul(a ^ bytes[i], 0x01000193) >>> 0;
    b = Math.imul(b ^ bytes[bytes.length - 1 - i], 0x01000193) >>> 0;
  }
  return `fnv:${bytes.length}:${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

/**
 * 文件内容的指纹：同一份内容（哪怕重新下载、改了文件名）认成同一个。
 * 浏览器不给算 SHA-256（不是 https 等）就自己按内容算一个（审查第 1 轮：原来退到「文件名 + 大小 + 修改时间」，内容不同也可能撞上）。
 */
export async function fileFingerprint(buffer: ArrayBuffer): Promise<string> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
      const digest = await subtle.digest("SHA-256", buffer);
      return `sha256:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
    }
  } catch {
    // 落到下面
  }
  return fallbackContentHash(new Uint8Array(buffer));
}
