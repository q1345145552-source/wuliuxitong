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
