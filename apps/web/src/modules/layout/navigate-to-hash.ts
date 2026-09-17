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

/**
 * 把地址栏的 # **换成**另一个（不新增历史记录；会补发一次 hashchange，见下面第二段）。
 *
 * ⚠️ 「旧链接被退回」这种场景必须用它，不能用 navigateToHash（2026-09-18 复核）：
 * `/agent#whr` 这种已经关掉的分区会被退回 `#home`，如果用 pushState，历史记录就成了
 * 「#whr → #home」，用户按一次「后退」回到 #whr，页面又把他推回 #home —— **后退永远出不去**。
 * replaceState 是把那条记录改掉，后退直接回到进来之前的页面。
 *
 * ⚠️ 改完地址**要补发一次 hashchange**（2026-09-18 第三轮复核第 13 条）：
 * `replaceState` 本身不发事件，而左边菜单的高亮是外壳（RoleShell）自己监听 hashchange /
 * popstate 记的。上一版不发事件，菜单能对上纯靠「页面里的 effect 比外壳先注册」这个巧合 ——
 * 谁动一下依赖或把逻辑挪进外壳，高亮就停在已经关掉的那一格（一个都不高亮）。
 * 调用方自己那段逻辑会因此空跑一遍（地址已经是目标值，它什么都不会再做），这个代价可以接受。
 */
export function replaceHash(href: string): void {
  if (typeof window === "undefined") return;
  const oldURL = window.location.href;
  const target = new URL(href, oldURL);
  if (target.href === oldURL) return;
  window.history.replaceState(window.history.state, "", target.href);
  window.dispatchEvent(new HashChangeEvent("hashchange", { oldURL, newURL: window.location.href }));
}

/** 这个链接是不是「只在当前页面里换 #」（路径、查询串都一样），是的话应当走 navigateToHash。 */
export function isSamePageHashLink(href: string): boolean {
  if (typeof window === "undefined") return false;
  const current = new URL(window.location.href);
  const target = new URL(href, current.href);
  return target.origin === current.origin && target.pathname === current.pathname && target.search === current.search;
}
