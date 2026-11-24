/**
 * 运单货型的校验（2026-11-24 从 orders/routes.ts 挪出来：那边顶上引了 prisma，测试隔离加载会去连库；这里是纯函数，测试直接调）。
 */
import { CARGO_TYPES, CARGO_TYPE_HINT, mixedCargoTypeIssue, type CargoType } from "../../../../../packages/shared-types/cargo-type";

/**
 * 货型只认 `normal` / `inspection` / `sensitive`（2026-09-11 加）。
 *
 * 原来四个写入口全是 `body.cargoType?.trim() || "normal"` —— **传什么存什么**。
 * 传个「商检」进来会原样存进库，而三端显示用的 `cargoTypeLabelOf` 认不出来就
 * 一律显示「普货」：单子上白写了一个错货型，而且没人会发现。
 *
 * 空着按普货（跟数据库默认值一致）；填了认不出来的就 400，不静默兜底。
 */
class CargoTypeError extends Error {}
function readCargoType(raw: unknown, where: string): CargoType {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return "normal";
  const value = String(raw).trim().toLowerCase();
  if (typeof raw === "string" && (CARGO_TYPES as readonly string[]).includes(value)) return value as CargoType;
  throw new CargoTypeError(`${where}的货型「${String(raw).trim()}」不合法，只能是 ${CARGO_TYPES.join(" / ")}。${CARGO_TYPE_HINT}`);
}

/** 整票 + 每条产品行一起校验；有问题返回那句话，没问题返回校验过的值 */
export function readCargoTypes(
  orderRaw: unknown,
  products: ReadonlyArray<{ cargoType?: string }> | undefined,
): { order: CargoType; products: CargoType[] } | { error: string } {
  /* 产品行本身不是对象（null、字符串）：下面读 .cargoType 会当场抛错成 500。超管改单这条路先走这里、
     后走 validateProductRows，那道中文提示轮不到（dsh 第三轮 2026-09-30）—— 在这里就用同一句话挡住 */
  // products 整个不是数组（字符串 / 对象 / 数字）：下面 findIndex 就抛错成 500（dsh 第四轮，改前也是 500）
  if (products !== undefined && products !== null && !Array.isArray(products)) return { error: "产品行的数据格式不对" };
  const badRow = (products ?? []).findIndex((product) => !product || typeof product !== "object");
  if (badRow >= 0) return { error: `产品行${badRow + 1}的数据格式不对` };
  try {
    return {
      order: readCargoType(orderRaw, "整票"),
      products: (products ?? []).map((product, index) => readCargoType(product.cargoType, `第 ${index + 1} 条产品`)),
    };
  } catch (error) {
    if (error instanceof CargoTypeError) return { error: error.message };
    throw error;
  }
}

/**
 * 一票一个货型（2026-11-24 老板：「一票只会有一个货型，不能单独产品选择货型」，规矩见 cargo-type.ts 那一段）。
 *
 * 这一票存哪个货型：
 *   · 产品行里**填了**货型的不止一种 → 报错，不取最严、不猜（没刷新的老页面还能逐行选；导入表格同一票几行填得不一样）；
 *   · 产品行填了（只有一种）→ 就是它。整票那一格不看 —— 老页面整票那格一直发默认的 normal、产品行才是真选的
 *     （原来有产品行时也是只看产品行），新页面两边发的是同一个；
 *   · 产品行都没填、整票填了 → 整票那个；
 *   · 都没填 → explicit=false，由调用方定（新建按普货；改单沿用这票原来的）。
 * 存的时候每条产品行都写成这一个。
 */
export function readOneCargoType(
  orderRaw: unknown,
  products: ReadonlyArray<{ cargoType?: string }> | undefined,
): { order: CargoType; explicit: boolean } | { error: string } {
  const cargo = readCargoTypes(orderRaw, products);
  if ("error" in cargo) return cargo;
  const blank = (raw: unknown) => raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "");
  const filled = (products ?? []).flatMap((p, i) => (blank(p.cargoType) ? [] : [cargo.products[i]]));
  const mixed = mixedCargoTypeIssue(filled);
  if (mixed) return { error: `${mixed}，这次没有保存。请刷新页面，在整票的「货型」里选一个` };
  if (filled.length > 0) return { order: filled[0], explicit: true };
  if (!blank(orderRaw)) return { order: cargo.order, explicit: true };
  return { order: "normal", explicit: false };
}
