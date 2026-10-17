/**
 * 封禁的唛头不进「挂单」的下拉（2026-10-17 老板问「为什么客户账号已经封禁了，还是能加进去运单？」，选 A）。
 *
 * 后端那几条挂单的路已经拦了（apps/api/src/modules/core/client-ban.ts）；这里是让员工 / 超管在下拉里就看不到封禁的唛头，
 * 打全了也提示一句为什么不能选。只用在挂单的下拉：员工「创建订单」、超管「创建订单」、超管「运单管理」改唛头、到货通知。
 * 搜索、筛选用的唛头框不用它（查老单还得能按封禁的唛头搜）。
 */
import type { MarkOption } from "../layout/mark-options";

/** 封禁了没有：跟后端同一个口径（不是 active 就算）。没带 status 的（上线那一刻还开着的老页面 / 老接口）当没封，不误伤 */
export function isBannedClient(c: { status?: string | null }): boolean {
  return typeof c.status === "string" && c.status !== "active";
}

/** 挂单下拉的选项：去掉封禁的，只留唛头（下拉只显示唛头，2026-09-19） */
export function activeMarkOptions(list: Array<{ id: string; status?: string | null }>): MarkOption[] {
  return list.filter((c) => !isBannedClient(c)).map((c) => ({ id: c.id }));
}

/** 封禁的唛头有哪些（判断框里打的是不是封禁的那个） */
export function bannedClientIds(list: Array<{ id: string; status?: string | null }>): Set<string> {
  return new Set(list.filter(isBannedClient).map((c) => c.id));
}

/** 框里打的正好是封禁的唛头时，框下面那句提示：老板 2026-10-17 定的「提示说账号已封禁」，跟后端拦下时那句一字不差（core/client-ban.ts 的 BANNED_CLIENT_MESSAGE） */
export const BANNED_MARK_HINT = "账号已封禁";

/**
 * 框里的唛头要不要出上面那句提示：是封禁的、而且跟原来的不一样（新建时原来的传空）才提示 —— 原来就挂在它名下的单照常改，不吓人。
 * 去掉首尾空格再认：超管那两个框提交时会去首尾空格，不去的话打「 XHH6698 」不提示、交上去才被拦（Codex 审查）。
 */
export function bannedChangeHint(value: string, original: string | null | undefined, banned: ReadonlySet<string>): string | null {
  const v = value.trim();
  if (!v || v === (original ?? "").trim() || !banned.has(v)) return null;
  return BANNED_MARK_HINT;
}

/**
 * 原来就挂在封禁唛头名下的单：这个唛头照样留在下拉里（排第一个）。
 * 不留的话框里的值不在选项里，一点开下拉就是「匹配 0 个」，看不到别的唛头，得先点 × 清空（dsh 审查）。别的封禁唛头照旧不列。
 */
export function withCurrentMark(options: MarkOption[], current: string | null | undefined): MarkOption[] {
  /* 加进去的是原文（不去空格）：框里的值就是原文，去了空格两边对不上，点开又是「匹配 0 个」，选了还会换成别的唛头
     （MarkPicker 一字不差才算选中；dsh 第 2 轮）。只有判断「是不是空的」时去空格 */
  if (!current || !current.trim() || options.some((o) => o.id === current)) return options;
  return [{ id: current }, ...options];
}
