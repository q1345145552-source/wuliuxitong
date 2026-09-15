import { AUTH_SESSION_STORAGE_KEY, WORKBENCH_BRAND_CACHE_KEY } from "../../auth/auth-session";
import { BRAND_LOGO_PATH_RE, TAB_ICON_ORIGINAL_HREF_ATTR, TAB_ICON_SELECTOR } from "./brand-core";

/* ==========================================================================
   整页打开 / 刷新工作台时，标签页标题和图标从第一帧起就是代理的（5.2，2026-09-16 第 1 轮后加固）
   --------------------------------------------------------------------------
   问题：服务器给的 HTML 里 <title> 是根布局的「湘泰物流网站」、图标是 app/icon.png、favicon.ico（文件约定，
   metadata 盖不掉，见 document-brand.ts），要等页面脚本下载完、水合、外壳读到会话才换成代理的
   —— 实测标题有 1 帧是湘泰的，浏览器还会先按湘泰的图标地址请求一次。
   做法：根布局 <head> 里放一段**同步内联脚本**（本文件导出的字符串），浏览器解析 HTML 时就跑，早于第一次绘制：
   · 只有「路径是 /client、/agent（或其子路径）且 登录会话有效且是客户/代理 且 按账号的品牌缓存 userId 对得上 且 品牌有名字」
     才动手，其余情况（湘泰账号、没登录、登录页、代理前缀登录页、缓存没有）一行不改，跟以前一模一样；
   · 盯着 <head>：<title>、图标 <link> 被解析出来 / 被 React 水合时写回湘泰的，当场改成代理的；
   · React 那边（useWorkbenchBrand → applyDocumentBrand）读到会话后接管：先调 window.__xtEarlyTabBrand.stop() 停掉这里，
     再按接口 / 缓存的结论写（结论是湘泰的就按这里记下的原值还原）。两个观察者不会同时在跑，不会互相抢着改。
   · 离开工作台路径（理论上都是整页跳转，保险起见）→ 还原并停下。
   为什么是字符串、不是写个函数再 .toString()：
   · 生产构建会压缩 / 改写服务端代码，测试脚本（tsx）又是另一套编译，.toString() 出来的东西两边不一样，测的不是真上线的那份；
   · 字符串就是浏览器实际执行的那几个字节，scripts/test-agent-branding.ts 直接拿这个字符串编译来测判定和改 DOM 的结果，
     并跟 document-brand.ts 在同一份假 DOM 上比对，保证两边口径一致。
   ⚠️ 只用 ES5 写法、整个包 try/catch：任何异常都静默，最坏就是退回「闪一帧」的老样子，不能影响页面。
   ⚠️ 本文件不能加 "use client"：根布局是服务端组件，要直接拿到这个字符串。
   ========================================================================== */

/** 内联脚本挂在 window 上的交接把手名字（document-brand.ts 用它停掉内联脚本） */
export const EARLY_TAB_BRAND_HANDLE = "__xtEarlyTabBrand";

/** 工作台路径：段精确匹配，/clientx、/agents 不算（跟 WorkbenchFrame 的判断一致） */
const WORKBENCH_PATH_RE = /^\/(client|agent)(\/|$)/;

/**
 * 判定：纯函数的源码（ES5）。入参是 location.pathname 和 localStorage 里两个键的原始字符串。
 * 返回 { title, iconHref } 或 null（不动）。iconHref 为 null = 旧缓存没存图标地址 / 地址不合规，只改标题。
 * 口径对齐：
 * · 会话有效 = getOptionalSession 的条件（role / userId / companyId / token 都得有）；
 * · 只认客户 / 代理（useWorkbenchBrand 的 peek 只给这两种角色读缓存）；
 * · 品牌有效 = parseSessionBrand 的条件（brand 是对象、name 去空格后非空）；标题 = 去空格后的名字；
 * · 图标地址只在跟 brandIconHref 的选法对得上时才用：logo 合规 → 必须等于 logo；logo 没有或不合规 → 必须是首字图标 data 地址。
 */
export const EARLY_TAB_BRAND_DECIDE_SOURCE = `function (pathname, sessionRaw, cacheRaw) {
  try {
    if (typeof pathname !== "string" || !${WORKBENCH_PATH_RE}.test(pathname)) return null;
    if (typeof sessionRaw !== "string" || typeof cacheRaw !== "string") return null;
    var s = JSON.parse(sessionRaw);
    if (!s || typeof s !== "object" || !s.role || !s.userId || !s.companyId || !s.token) return null;
    if (s.role !== "client" && s.role !== "agent") return null;
    var c = JSON.parse(cacheRaw);
    if (!c || typeof c !== "object" || c.userId !== s.userId) return null;
    var b = c.brand;
    if (!b || typeof b !== "object") return null;
    var name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name) return null;
    var logo = typeof b.logoUrl === "string" && ${BRAND_LOGO_PATH_RE}.test(b.logoUrl) ? b.logoUrl : null;
    var icon = c.iconHref;
    var iconHref = null;
    if (typeof icon === "string" && (logo ? icon === logo : icon.indexOf("data:image/svg+xml,") === 0)) iconHref = icon;
    return { title: name, iconHref: iconHref };
  } catch (e) {
    return null;
  }
}`;

/**
 * 放进根布局 <head> 的整段脚本。改 DOM 的规则逐条照 document-brand.ts 的 writeOnce：
 * 标题不同才写；图标 link 先记原地址（只记一次）、地址不同才改、换成非 /images/ 的地址时去掉 type。
 * ⚠️ 没有 <title> 元素时不写 document.title（写了浏览器会自己造一个 <title>，跟 React 的那个成了两个）；等解析出来再改。
 */
export const EARLY_TAB_BRAND_SCRIPT = `(function () {
  try {
    var decide = ${EARLY_TAB_BRAND_DECIDE_SOURCE};
    var store = window.localStorage;
    var d = decide(window.location.pathname, store.getItem(${JSON.stringify(AUTH_SESSION_STORAGE_KEY)}), store.getItem(${JSON.stringify(WORKBENCH_BRAND_CACHE_KEY)}));
    if (!d) return;
    var SEL = ${JSON.stringify(TAB_ICON_SELECTOR)};
    var ATTR = ${JSON.stringify(TAB_ICON_ORIGINAL_HREF_ATTR)};
    var HANDLE = ${JSON.stringify(EARLY_TAB_BRAND_HANDLE)};
    var observer = null;
    var handle = { title: d.title, iconHref: d.iconHref, originalTitle: null, stop: stop };
    function stop() {
      if (observer) observer.disconnect();
      observer = null;
      if (window[HANDLE] === handle) window[HANDLE] = undefined;
    }
    function restore() {
      if (handle.originalTitle !== null && document.getElementsByTagName("title").length) document.title = handle.originalTitle;
      var links = document.querySelectorAll(SEL);
      for (var i = 0; i < links.length; i++) {
        var original = links[i].getAttribute(ATTR);
        if (original !== null) links[i].setAttribute("href", original);
      }
    }
    function write() {
      if (!${WORKBENCH_PATH_RE}.test(window.location.pathname)) {
        stop();
        restore();
        return;
      }
      if (document.getElementsByTagName("title").length && document.title !== d.title) {
        if (handle.originalTitle === null) handle.originalTitle = document.title;
        document.title = d.title;
      }
      if (!d.iconHref) return;
      var links = document.querySelectorAll(SEL);
      for (var i = 0; i < links.length; i++) {
        var link = links[i];
        if (!link.hasAttribute(ATTR)) link.setAttribute(ATTR, link.getAttribute("href") || "");
        if (link.getAttribute("href") !== d.iconHref) link.setAttribute("href", d.iconHref);
        if (link.getAttribute("type") && d.iconHref.indexOf("/images/") !== 0) link.removeAttribute("type");
      }
    }
    window[HANDLE] = handle;
    write();
    if (typeof MutationObserver === "function" && document.head) {
      observer = new MutationObserver(function () {
        try { write(); } catch (e) { /* 静默 */ }
      });
      observer.observe(document.head, { childList: true, subtree: true, attributes: true, characterData: true, attributeFilter: ["href"] });
    }
  } catch (e) {
    /* 任何异常都静默：最坏退回「闪一帧再换」的老样子 */
  }
})();`;
