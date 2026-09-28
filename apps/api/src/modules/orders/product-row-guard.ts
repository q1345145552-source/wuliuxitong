import { PG_INT_MAX, requireSumWithinInt } from "../core/int-guard";
import { DECIMAL_10_2, requireDecimal, requireSumWithinDecimal } from "../core/decimal-guard";

/**
 * 建单时产品行的校验（纯函数，方便单测）。
 *
 * 2026-08-29 复核实测：这些全都能 200 存进去 ——
 *   · 每箱 0 个 + 订单级总数 999  → 存成 999，跟明细完全对不上
 *   · 每箱 -3 个                 → 放行，总数是负数
 *   · 每箱 1.5 个 × 2 箱          → 存成 3（「个」不可分，1.5 本身不成立）
 * 根因是这里原来只检查「全填或全空」，不检查填的是什么，
 * 而批量导入那条路一直要求正整数 —— 同一个业务口径两条路两个标准。
 *
 * 前端有一份同名规则（apps/web/src/modules/orders/productRowGuard.ts），
 * 那是给人看提示用的；这一份挡的是绕过页面直接调接口的。两道都要有。
 */

export interface ProductRowForGuard {
  itemName?: unknown;
  packageCount?: unknown;
  productQuantity?: unknown;
  weightKg?: unknown;
}

function isPositiveInteger(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isFinite(v) &&
    Number.isInteger(v) &&
    v > 0 &&
    v <= PG_INT_MAX
  );
}

/**
 * @returns 有问题时返回给人看的中文提示；全部合格返回 null。
 */
export function validateProductRows(rows: ProductRowForGuard[]): string | null {
  if (rows.length === 0) return null;

  /**
   * ⚠️ 箱数不许兜底成 1（2026-08-28 起）。没填或填 0 会被悄悄当成 1 箱，
   * 而箱数是重量、方数、产品数量三个合计的乘数，一错全错，
   * 客户拿到的是一个「看起来很正常」的错数。宁可拦住让他补，也不能猜。
   */
  for (let i = 0; i < rows.length; i += 1) {
    // 品名不是文字（数字、null、没带）：三个入口后面都直接 .trim()，原来当场 500（2026-09-29 实跑发现）
    if (typeof rows[i].itemName !== "string") {
      return `产品行${i + 1}的品名不对`;
    }
    if (!isPositiveInteger(rows[i].packageCount)) {
      return `产品行${i + 1}的箱数必须是正整数`;
    }
  }

  // 「每箱几个」要么全填、要么全空 —— 只填几行的话，没填的按 0 参与合计，
  // 总数偏小而且没人知道。
  const qtys = rows.map((r) => r.productQuantity);
  const filled = qtys.filter((q) => q !== undefined && q !== null).length;
  if (filled > 0 && filled < qtys.length) {
    return "同一张单的「每箱几个」需要全部填写或全部留空";
  }
  for (let i = 0; i < rows.length; i += 1) {
    const q = rows[i].productQuantity;
    if (q === undefined || q === null) continue;
    if (!isPositiveInteger(q)) {
      return `产品行${i + 1}的「每箱几个」必须是正整数`;
    }
  }

  /* 2026-08-31（复查第 7 条）：单箱重量填了就要过精度闸。
     这一列是 Decimal(10,2)，原来完全不校验 —— 客户直调接口传 99999999999
     或者 NaN，要到写库那步才炸，看到的是「服务器繁忙」而不是哪里填错了。
     跟本模块确认收货那条路的规矩对齐：参数不合法要在碰数据库之前拦、给中文提示。
     没填（undefined/null）跳过 —— 重量本来就是选填的。 */
  for (let i = 0; i < rows.length; i += 1) {
    const w = rows[i].weightKg;
    if (w === undefined || w === null) continue;
    const issue = requireDecimal(w, `产品行${i + 1}的单箱重量(kg)`, DECIMAL_10_2);
    if (issue) return issue;
  }

  /**
   * ⚠️ **合计也要卡**（2026-08-29 第八轮补）。
   * 单行都合法不代表合计合法：两行各 15 亿箱，每行都 < 21 亿，
   * 合计 30 亿写进 Order.packageCount（Int）就爆了 —— 复核实测返回 200。
   */
  const pkgSum = requireSumWithinInt(
    rows.map((r) => (typeof r.packageCount === "number" ? r.packageCount : 0)),
    "箱数",
  );
  if (pkgSum) return pkgSum;
  const qtySum = requireSumWithinInt(
    rows.map((r) =>
      typeof r.packageCount === "number" && typeof r.productQuantity === "number"
        ? r.packageCount * r.productQuantity
        : 0,
    ),
    "产品数量",
  );
  if (qtySum) return qtySum;
  // 总重同理：单行各自合法，乘上箱数加起来才超 Decimal(10,2) 的要在门口拦，
  // 不然到写 Order.weightKg 那步才溢出，又是一句「服务器繁忙」（2026-08-31 复查第 7 条）
  const wtSum = requireSumWithinDecimal(
    rows.map((r) =>
      typeof r.packageCount === "number" && typeof r.weightKg === "number"
        ? r.weightKg * r.packageCount
        : 0,
    ),
    "总重量(kg)",
    DECIMAL_10_2,
  );
  if (wtSum) return wtSum;

  return null;
}

/**
 * 订单级的「产品数量」（没有产品行时用的那个总数）。
 * 0 是允许的 —— 表示没填。
 */
export function validateOrderLevelQuantity(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
    return "「产品数量」必须是不小于 0 的整数";
  }
  if (v > PG_INT_MAX) {
    // 同上：数据库是 32 位整数，超了要在门口拦，别到写库才炸成「服务器繁忙」
    return `「产品数量」不能超过 ${PG_INT_MAX}`;
  }
  return null;
}
