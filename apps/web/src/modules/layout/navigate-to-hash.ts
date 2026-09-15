/**
 * 同一个页面里只换 #（例如 /admin#orders → /admin#clients）时用这个，不要再写 `window.location.hash = x`。
 *
 * ⚠️ 为什么（2026-09-16 导航根治）：侧边栏改成 next/link 以后，跨页面跳转的历史记录都带着 Next 的
 * `__NA` 标记；而 `location.hash = x` 产生的记录 state 是 null。Next 16 的后退处理
 * （next/dist/client/components/app-router.js 里的 onPopState）遇到 state 为 null 的记录**直接不管**，
 * 两种记录一混用，后退就会出现「地址变了、页面没变」。
 *
 * 做法：`history.pushState(null, "", href)` —— Next 已经给 pushState 打了补丁，会自动带上 `__NA`
 * 并同步 usePathname —— 然后手动补发一次 hashchange（pushState 本身不发），让页面和菜单切分区。
 * 不滚动。
 */
export function navigateToHash(href: string): void {
  if (typeof window === "undefined") return;
  const oldURL = window.location.href;
  const target = new URL(href, oldURL);
  // 点的就是当前这一格：原生 <a> 也不会新增历史记录、不发 hashchange，这里保持一致
  if (target.href === oldURL) return;
  window.history.pushState(null, "", target.href);
  window.dispatchEvent(new HashChangeEvent("hashchange", { oldURL, newURL: window.location.href }));
}

/** 这个链接是不是「只在当前页面里换 #」（路径、查询串都一样），是的话应当走 navigateToHash。 */
export function isSamePageHashLink(href: string): boolean {
  if (typeof window === "undefined") return false;
  const current = new URL(window.location.href);
  const target = new URL(href, current.href);
  return target.origin === current.origin && target.pathname === current.pathname && target.search === current.search;
}
