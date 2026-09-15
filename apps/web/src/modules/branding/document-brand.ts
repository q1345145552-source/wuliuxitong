"use client";

import { brandIconHref, TAB_ICON_ORIGINAL_HREF_ATTR, TAB_ICON_SELECTOR, type PublicBrandInfo } from "./brand-core";
import { EARLY_TAB_BRAND_HANDLE } from "./early-tab-brand";

/* ==========================================================================
   标签页标题 + 图标换成代理的（5.2）。只在浏览器里跑。
   --------------------------------------------------------------------------
   为什么不用 Next 的 metadata 直接换：
   · app/icon.png、favicon.ico 是「文件约定」图标，官方文档写明它的优先级高于 metadata / generateMetadata，
     在 generateMetadata 里给 icons 盖不掉湘泰的图标；
   · 工作台页面都是客户端页面，登录后才知道是谁，服务端渲染时根本不知道该用谁的名字。
   所以登录后在浏览器里改 <title> 和 <link rel=icon> 的 href。
   ⚠️ 只改属性、不删节点：<head> 里那几个节点归 React 管，删了它下次对账会报错。
   ⚠️ Next 换页时可能把 <title> 写回「湘泰物流网站」，所以盯着 <head> 变化再写一遍（值一样就不写，不会死循环）。
   ⚠️ 整页打开时 <head> 里的内联脚本（early-tab-brand.ts）已经先按缓存换过了：本文件第一次被调用时先把它停掉、接管，
      改 DOM 的规则两边逐条一致（scripts/test-agent-branding.ts 在同一份假 DOM 上比对）。
   ========================================================================== */

const ICON_SELECTOR = TAB_ICON_SELECTOR;
const ORIGINAL_HREF_ATTR = TAB_ICON_ORIGINAL_HREF_ATTR;

/** 内联脚本挂在 window 上的把手（见 early-tab-brand.ts） */
interface EarlyTabBrandHandle {
  originalTitle: string | null;
  stop: () => void;
}

/** 停掉首帧内联脚本并拿回它记下的原标题；没跑过（湘泰账号、登录页、没缓存）返回 null */
function takeOverEarlyScript(): EarlyTabBrandHandle | null {
  try {
    const early = (window as unknown as Record<string, EarlyTabBrandHandle | undefined>)[EARLY_TAB_BRAND_HANDLE];
    if (!early || typeof early.stop !== "function") return null;
    early.stop();
    return early;
  } catch {
    return null;
  }
}

let observer: MutationObserver | null = null;
let current: PublicBrandInfo | null = null;
let originalTitle: string | null = null;

function writeOnce(): void {
  if (!current) return;
  if (document.title !== current.name) document.title = current.name;
  const href = brandIconHref(current);
  document.querySelectorAll<HTMLLinkElement>(ICON_SELECTOR).forEach((link) => {
    if (!link.hasAttribute(ORIGINAL_HREF_ATTR)) link.setAttribute(ORIGINAL_HREF_ATTR, link.getAttribute("href") ?? "");
    if (link.getAttribute("href") !== href) link.setAttribute("href", href);
    // 湘泰的图标带 sizes / type（png、ico），换成 svg 首字图标时 type 对不上浏览器会不认
    if (link.getAttribute("type") && !href.startsWith("/images/")) link.removeAttribute("type");
  });
}

/** 换成代理的；传 null 还原成湘泰的（一般用不到：换账号会整页重载） */
export function applyDocumentBrand(brand: PublicBrandInfo | null): void {
  if (typeof document === "undefined") return;
  // 内联脚本换过的话，document.title 现在已是代理名字，原标题得从它那儿拿
  const early = takeOverEarlyScript();
  if (brand) {
    if (originalTitle === null && !current) originalTitle = early ? early.originalTitle : document.title;
    current = brand;
    writeOnce();
    if (!observer) {
      observer = new MutationObserver(() => writeOnce());
      observer.observe(document.head, { childList: true, subtree: true, attributes: true, characterData: true, attributeFilter: ["href"] });
    }
    return;
  }
  // 结论是湘泰的：React 自己没换过、内联脚本也没换过 → 什么都不动（湘泰账号一直走这里）
  if (!current && !early) return;
  if (!current && early) originalTitle = early.originalTitle;
  current = null;
  observer?.disconnect();
  observer = null;
  if (originalTitle !== null) document.title = originalTitle;
  originalTitle = null;
  document.querySelectorAll<HTMLLinkElement>(ICON_SELECTOR).forEach((link) => {
    const original = link.getAttribute(ORIGINAL_HREF_ATTR);
    if (original !== null) link.setAttribute("href", original);
  });
}
