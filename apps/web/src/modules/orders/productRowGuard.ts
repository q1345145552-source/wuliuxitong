/**
 * 建单/改单时产品行的校验 —— 员工端、管理员端、客户端**共用同一份口径**。
 *
 * 为什么要单独抽出来（2026-08-29）：
 * 复核实测发现同一个规矩在系统里有三套标准 ——
 *   · 批量导入：箱数和「每箱几个」都必须是正整数（batchOrderImport 的 positiveNumber）；
 *   · 建单接口：只检查箱数，「每箱几个」填 0 / -3 / 1.5 全部 200 放行；
 *   · 三个前端页面：发送前一律 `Number(p.packageCount) || 1`，
 *     员工把箱数清空或填 0，**发出去就变成 1 箱**，后端那道正整数闸根本挡不到。
 * 结果就是老板最早报的那个「箱数被系统猜成 1」，改了后端也照样存在。
 *
 * 现在三个前端都先过这一关，拦不住的再由后端同名规则兜底（两道都要有：
 * 前端给的是看得懂的提示，后端挡的是绕过页面直接调接口的）。
 *
 * ⚠️ 箱数是重量、方数、产品数量三个合计的**乘数**，一错全错，
 *    而且错出来的数「看起来很正常」，没人会发现。所以宁可拦住让人补，绝不猜。
 */

export interface ProductRowInput {
  itemName?: string;
  /** 表单里是字符串，接口里是数字，两种都收 */
  packageCount?: string | number | null;
  productQuantity?: string | number | null;
}

/** 把表单里的字符串转成数字；空字符串/null/undefined 一律当「没填」 */
function toNumberOrBlank(raw: string | number | null | undefined): number | null | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "number") return Number.isNaN(raw) ? null : raw;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  return Number.isNaN(n) ? null : n;
}

/** 数据库那几列是 32 位整数，超了到写库才炸成「服务器繁忙」，在页面上就拦住 */
const PG_INT_MAX = 2147483647;

function isPositiveInteger(n: number | null | undefined): n is number {
  return (
    typeof n === "number" &&
    Number.isFinite(n) &&
    Number.isInteger(n) &&
    n > 0 &&
    n <= PG_INT_MAX
  );
}

/**
 * 校验一组产品行。
 * @returns 有问题时返回给人看的中文提示；全部合格返回 null。
 */
export function validateProductRows(rows: ProductRowInput[]): string | null {
  if (rows.length === 0) return null;

  for (let i = 0; i < rows.length; i += 1) {
    const pc = toNumberOrBlank(rows[i].packageCount);
    if (!isPositiveInteger(pc)) {
      return `产品行${i + 1}的箱数必须填正整数（现在是「${rows[i].packageCount ?? ""}」）`;
    }
  }

  // 「每箱几个」要么全填、要么全空 —— 只填几行的话，没填的按 0 参与合计，
  // 总数偏小而且没人知道。跟批量导入、跟后端同一个规矩。
  const qtys = rows.map((r) => toNumberOrBlank(r.productQuantity));
  const filledIdx = qtys.map((q, i) => (q === undefined ? -1 : i)).filter((i) => i >= 0);
  if (filledIdx.length > 0 && filledIdx.length < rows.length) {
    return "同一张单的「每箱几个」需要全部填写或全部留空";
  }
  for (const i of filledIdx) {
    if (!isPositiveInteger(qtys[i])) {
      return `产品行${i + 1}的「每箱几个」必须填正整数（现在是「${rows[i].productQuantity ?? ""}」）`;
    }
  }

  return null;
}

/**
 * 填了箱数 / 尺寸 / 重量等、却没填品名的产品行（2026-09-30 Codex 第三轮）。
 *
 * 三个建单入口（客户预报单、员工建单、超管创建订单）提交时都按「有品名」过滤产品行，
 * 可页面上的总体积 / 总重量 / 箱数是把所有行都算进去的 —— 客户看到并确认的是 10kg，
 * 没品名那行被悄悄丢掉，系统存的是 1kg。宁可拦住让人补，不许悄悄丢。
 * 完全空白的行（刚点「添加产品」还没填）不算，照旧忽略。
 */
export function unnamedFilledRowIssue(rows: Array<Record<string, unknown> & { itemName?: string }>): string | null {
  const filledKeys = ["packageCount", "lengthCm", "widthCm", "heightCm", "weightKg", "productQuantity", "domesticTrackingNo"];
  for (let i = 0; i < rows.length; i += 1) {
    if (String(rows[i].itemName ?? "").trim()) continue;
    if (filledKeys.some((k) => String(rows[i][k] ?? "").trim() !== "")) {
      return `产品行${i + 1}填了数据但没填品名：请补上品名，或者把这一行删掉`;
    }
  }
  return null;
}

/**
 * 发送给接口前把箱数转成数字。
 * ⚠️ **不许兜底成 1** —— 这里原来是 `Number(p.packageCount) || 1`，
 * 就是它把「没填」和「填 0」悄悄变成 1 箱的。调用前请先过 validateProductRows。
 */
export function packageCountForPayload(raw: string | number | null | undefined): number {
  const n = toNumberOrBlank(raw);
  return typeof n === "number" ? n : NaN;
}
