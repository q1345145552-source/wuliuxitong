/* ==========================================================================
   代理返现怎么算（2026-09-16，确认单 4.10 / 4.14 / 4.20）
   --------------------------------------------------------------------------
   返现 = Σ 该货型方数 ×（该货型客户价 − 该货型给代理的价），按货型分三档算，四舍五入到分。

   ⚠️ 纯函数，不碰数据库。付款写快照（B1）、返现单明细（B2）都调它，口径只有一份。
   ⚠️ 用整数（BigInt）算，不用浮点：方数库里是 6 位小数、价是 2 位小数，
      浮点乘完再四舍五入会在 .005 这种边上差一分钱，返现单是要对账转钱的。
   ⚠️ 货型认不出来（空 / 老数据）按普货算 —— 跟 utils.ts 的 calcFeeFromItems 同一个口径，
      否则同一票货「收客户的钱」和「算返现」会按不同档位算。
   ⚠️ 客户价低于代理价时返现是负数，这里**照实算不截断**：
      正常情况下存价时就拦住了（long-term-price.ts），真出现负数说明数据有问题，该让人看见。
   ⚠️ 这个文件是 B 阶段共享只读的：要改写进报告由编排者改。
   ========================================================================== */

export type CargoBucket = "normal" | "inspection" | "sensitive";

/** 三档价：number / 数字字符串 / Prisma Decimal 都行 */
export type PriceTripleLike = Record<CargoBucket, unknown>;

export interface RebateItem {
  cargoType: string | null | undefined;
  /** 方数：number / 数字字符串 / Prisma Decimal / null（没量尺寸按 0） */
  volumeM3: unknown;
}

export interface RebateResult {
  /** 返现金额，元，已四舍五入到分 */
  rebateAmount: number;
  /** 三档方数，已四舍五入到 3 位（返现单明细列是 Decimal(12,3)） */
  volumes: Record<CargoBucket, number>;
}

const VOLUME_SCALE = 6; // 方数按 6 位小数算（库里 Decimal(10,6)）
const PRICE_SCALE = 2;

function bucketOf(cargoType: string | null | undefined): CargoBucket {
  return cargoType === "inspection" || cargoType === "sensitive" ? cargoType : "normal";
}

/** 四舍五入的整除（远离 0 进位），n / d */
function roundDiv(n: bigint, d: bigint): bigint {
  const negative = n < 0n;
  const abs = negative ? -n : n;
  let q = abs / d;
  if ((abs % d) * 2n >= d) q += 1n;
  return negative ? -q : q;
}

/**
 * 把一个数变成「乘以 10^scale 之后的整数」，多出来的小数位四舍五入。
 * 认不出来的值直接抛错 —— 算钱的地方不许把脏数据悄悄当 0。
 */
export function toScaledInt(value: unknown, scale: number, label = "数值"): bigint {
  if (value === null || value === undefined || value === "") return 0n;
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${label}不是有效数字：${value}`);
    text = value.toFixed(12);
  } else if (typeof value === "string" || typeof value === "bigint" || typeof (value as { toString?: unknown }).toString === "function") {
    text = String(value).trim();
  } else {
    throw new TypeError(`${label}不是有效数字：${String(value)}`);
  }
  // Prisma Decimal 很小的数会写成 1e-7 这种科学计数法
  if (/e/i.test(text)) {
    const n = Number(text);
    if (!Number.isFinite(n)) throw new TypeError(`${label}不是有效数字：${text}`);
    text = n.toFixed(12);
  }
  const m = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(text);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) throw new TypeError(`${label}不是有效数字：${text}`);
  const negative = m[1] === "-";
  const intPart = m[2] || "0";
  const fracRaw = m[3] ?? "";
  // 先多保留一位，再四舍五入到 scale 位
  const frac = (fracRaw + "0".repeat(scale + 1)).slice(0, scale + 1);
  const raw = BigInt(intPart + frac); // 放大了 10^(scale+1)
  const rounded = roundDiv(raw, 10n);
  return negative ? -rounded : rounded;
}

/**
 * 算一票货的返现。
 * @param items 这票货的货品行（货型 + 方数）
 * @param clientPrices 付款那一刻的客户三档价
 * @param agentPrices 付款那一刻给代理的三档价
 */
export function computeRebate(
  items: readonly RebateItem[],
  clientPrices: PriceTripleLike,
  agentPrices: PriceTripleLike,
): RebateResult {
  const vol: Record<CargoBucket, bigint> = { normal: 0n, inspection: 0n, sensitive: 0n };
  for (const it of items) {
    vol[bucketOf(it.cargoType)] += toScaledInt(it.volumeM3, VOLUME_SCALE, "方数");
  }

  let total = 0n; // 单位 10^-(6+2) 元
  for (const bucket of ["normal", "inspection", "sensitive"] as const) {
    if (vol[bucket] === 0n) continue;
    const diff =
      toScaledInt(clientPrices[bucket], PRICE_SCALE, "客户价") - toScaledInt(agentPrices[bucket], PRICE_SCALE, "代理价");
    total += vol[bucket] * diff;
  }

  // 10^-8 元 → 分（10^-2 元）
  const cents = roundDiv(total, 10n ** BigInt(VOLUME_SCALE));
  const toM3 = (v: bigint): number => Number(roundDiv(v, 1000n)) / 1000;

  return {
    rebateAmount: Number(cents) / 100,
    volumes: { normal: toM3(vol.normal), inspection: toM3(vol.inspection), sensitive: toM3(vol.sensitive) },
  };
}
