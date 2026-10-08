/** 唛头下拉的选项和筛选（MarkPicker 用；单独放 .ts 方便测试直接 import） */
/** 只有唛头：显示唛头时旁边不带客户名字（老板 2026-09-19「显示唛头就行了」，test:mark-display 管着） */
export type MarkOption = { id: string };

/** 空查询 = 全部（不截断，F15 / 教训 21）；否则唛头包含查询词（不分大小写、去掉两头空格） */
export function filterMarkOptions(options: MarkOption[], query: string): MarkOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter((o) => o.id.toLowerCase().includes(q));
}
