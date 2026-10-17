/**
 * 多产品运单的「品名」怎么显示（2026-09-10，老板反馈派送单「品类不全」）。
 *
 * 病根：员工建单 / 客户预报单在有产品行时，订单和运单上的 itemName 只存了
 * **第一个产品的名字**（orders/routes.ts 里 `products[0].itemName`），
 * 而尾端派送卡片、客户签收单、整柜拆柜派送清单又都拿这个字段当整票的品名 ——
 * 一票「鞋 + 包 + 帽」的货，单子上只印「鞋」。
 *
 * 这里不改存的数据，只在显示的地方把**全部产品名**按录入顺序拼出来：
 *   鞋 / 包 / 帽
 * 分隔符跟批量导入（batchOrderImport.ts）拼多品名的写法一致，
 * 同名产品（比如三行都是「鞋」、只是尺寸不同）只出现一次。
 * 没有产品行的老运单退回原来的 itemName，显示口径和改版前一致。
 */
export function productNamesLabel(
  products: ReadonlyArray<{ itemName?: string | null; sortOrder?: number | null }> | null | undefined,
  fallback?: string | null,
): string {
  const sorted = [...(products ?? [])].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const names: string[] = [];
  for (const product of sorted) {
    const name = (product.itemName ?? "").trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names.length > 0 ? names.join(" / ") : (fallback ?? "").trim();
}

/** 产品行没填国内单号时存的占位（后端建单 / 改单写的默认值，同 arrival-notices 的 BLANK_DOMESTIC_PLACEHOLDER） */
const DOMESTIC_PLACEHOLDER = "货拉拉";

/**
 * 一票的「国内单号」怎么导出（2026-10-18 全系统审查第一档第 1 条，老板选 B）。
 *
 * 病根：一票多款产品时，每款产品有自己的国内快递单号（存在产品行上），订单 / 运单上那个整票的号常常是空的、
 * 或者是「货拉拉」占位、或者只是其中一个号。员工 / 超管 / 客户三端导出和代理端列表原来只拿整票那个号 ——
 * 线上 317 张多款订单导出时会漏掉产品行上的号（页面列表和搜索是认产品行号的）。
 *
 * 口径：
 *   - 分了产品行的：按产品行顺序（sortOrder）拼产品行的号，去重，用「、」隔开 —— 跟员工端运单卡片「国内单号：」那行一样
 *     （没填号的产品行存的是「货拉拉」，照样列出来）；整票上另有一个**真单号**（不是空、不是「货拉拉」）、产品行里又没有的，补在最后
 *     （线上 254 张是这样，只认产品行会把它丢掉；整票是「货拉拉」占位的 626 张不补，免得每行都多一个「货拉拉」）。
 *   - 没有产品行的老单：用整票的号。
 * 都没有返回空串，调用方自己写「-」。
 */
export function domesticNosLabel(
  products: ReadonlyArray<{ domesticTrackingNo?: string | null; sortOrder?: number | null }> | null | undefined,
  orderLevel?: string | null,
): string {
  const top = (orderLevel ?? "").trim();
  if (!products || products.length === 0) return top;
  const sorted = [...products].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const nos: string[] = [];
  for (const product of sorted) {
    const no = (product.domesticTrackingNo ?? "").trim() || DOMESTIC_PLACEHOLDER;
    if (!nos.includes(no)) nos.push(no);
  }
  if (top && top !== DOMESTIC_PLACEHOLDER && !nos.includes(top)) nos.push(top);
  return nos.join("、");
}
