/**
 * 仓库版集货的单价校验（建柜 / 加客户 / 改单价三处共用）。
 *
 * ⚠️ 这份必须跟后端 `apps/api/src/modules/core/decimal-guard.ts` 的
 * `requireUnitPrice`（`Decimal(10,2)`）**判得一模一样**：
 *   · 取值：跟后端 `parseNumericStrict` 一样 —— 先 `trim` 再 `Number()`，
 *     所以 `".5"`、`"5e2"`、`" 500 "`、`"+500"` 后端收，这里也得收。
 *     上一版这里用正则 `/^\d+(\.\d{1,2})?$/`，把这些**前端拒、后端收**（复核 2026-09-18 第 5 条）。
 *     ⚠️ 实测补一句（2026-09-18 在真浏览器里试过）：超管端 / 员工端那几个框是 `type="number"`，
 *     浏览器自己会把「不是合法浮点数」的值清成空串 —— 在**那两个页面上** `" 500 "`、`"+500"`
 *     根本到不了这个函数（手打进去空格会被吃掉变成 `"500"`）；真正被老正则冤枉的是 `".5"`、`"5e2"` 这种。
 *     但代理端 `components/agent/AgentClients.tsx` 用的是普通 `<input inputMode="decimal">`，
 *     `" 500 "`、`"+500"`、`"0x10"` 都进得来（后端 `Number()` 同样收，所以两边仍然一致）。
 *     所以这份对齐的意义是「两边规则只有一套」，不是「页面上救回了带空格的粘贴」。
 *   · 下限 0.01：再小 `Decimal(10,2)` 存成 0.00，这一柜白送。
 *   · 上限 1 亿：整数部分最多 8 位。
 *   · 小数最多 2 位，且**舍入算法照抄后端**（`Math.round((n + EPSILON) * 100) / 100`），
 *     两边用两套算法，闸不是松就是紧。
 * 后端那几个数字改了，这里必须跟着改。
 */

/** 跟后端 decimal-guard.ts 的 roundToScale(n, 2) 同一套算法 */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * 把输入框里的字符串换成**发给后端的那个数**。
 *
 * ⚠️ 页面发出去的值必须走这个函数，不许各处再写一遍 `Number(String(x).trim())`：
 * 「校验用一份、发出去的值用另一份」以后后端改了取值方式，页面这边没人跟（复核 2026-09-18 第 3 条）。
 * ⚠️ 只收字符串（输入框给的就是字符串）。后端 `parseNumericStrict` 对布尔 / 数组一律 NaN，
 * 这里不做那层——别拿非字符串来调它。
 */
export function parseUnitPrice(raw: string): number {
  const text = String(raw ?? "").trim();
  if (text === "") return Number.NaN;
  return Number(text);
}

/** 有问题返回给人看的中文提示，合格返回 null */
export function unitPriceIssue(label: string, raw: string): string | null {
  const text = String(raw ?? "").trim();
  if (!text) return `${label}单价为必填`;
  const value = Number(text);
  if (!Number.isFinite(value)) return `${label}单价只能填数字`;
  if (value < 0.01) return `${label}单价不能小于 0.01（再小会被系统存成 0，这一笔就白算了）`;
  if (value >= 100000000) return `${label}单价太大了（最多 8 位整数）`;
  if (round2(value) !== value) return `${label}单价最多只能有 2 位小数`;
  return null;
}
