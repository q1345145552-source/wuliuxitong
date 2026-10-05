/**
 * 网站在湘泰 app 里打开时（安卓外壳，仓库 mobile/ 目录，2026-10-05 老板「做安卓app」），
 * 补上网页在 app 里做不到的几件事。在电脑 / 手机浏览器里打开时一行都不执行。
 *
 * 1. 存文件：导出 Excel、下载模板这类「下载」，app 里没反应 → 改成先存一份到手机「Documents / 湘泰物流」，
 *    再弹出手机的「分享」菜单（发微信、用 WPS 打开……）。
 * 2. 开新窗口：打印标签、看付款凭证都是 window.open 一个空白窗口再往里写内容 → app 里没有新窗口，
 *    改成在 app 里盖一层全屏，顶上有「关闭」。
 * 3. 打印：上面那层里的 window.print() → 交给安卓自带的打印（mobile/…/XtPrintPlugin.java：选打印机或存 PDF）。
 * 4. 手机返回键：先关盖着的那层 / 打开的弹窗 / 左边菜单，再退回上一页；已经在最前面就把 app 收到后台（不退出登录）。
 * 5. 键盘弹起来时收起底部那排常用入口，打字的地方大一点。
 * 6. 打开 app 时已经登录过就直接进工作台（浏览器里登录页照旧不自动进）。
 *
 * 跟原生那边打交道只走 window.Capacitor（外壳自己注进来的），网站不装 Capacitor 的包。
 */

import { getOptionalSession } from "../../auth/auth-session";
import { ROLE_HOME_PATH } from "../branding/role-home";

interface CapacitorPluginProxy {
  [method: string]: ((options?: unknown) => Promise<unknown>) | undefined;
}
interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  Plugins?: Record<string, CapacitorPluginProxy & {
    addListener?: (event: string, handler: (data: { canGoBack?: boolean }) => void) => Promise<unknown> | unknown;
  }>;
  nativePromise?: (plugin: string, method: string, options?: unknown) => Promise<unknown>;
}

function capacitor(): CapacitorGlobal | null {
  if (typeof window === "undefined") return null;
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  return cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform() ? cap : null;
}

/** 现在是不是在湘泰 app 里 */
export function isNativeApp(): boolean {
  return capacitor() !== null;
}

function callNative<T = unknown>(plugin: string, method: string, options?: unknown): Promise<T> {
  const cap = capacitor();
  if (!cap) return Promise.reject(new Error("不在 app 里"));
  const fn = cap.Plugins?.[plugin]?.[method];
  if (typeof fn === "function") return fn.call(cap.Plugins![plugin], options) as Promise<T>;
  if (typeof cap.nativePromise === "function") return cap.nativePromise(plugin, method, options) as Promise<T>;
  return Promise.reject(new Error(`app 里没有 ${plugin}.${method}`));
}

/* ---------------- 1. 存文件 ---------------- */

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("读文件失败"));
    reader.readAsDataURL(blob);
  });
}

/** 文件名里手机存不了的字符换掉 */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned || "下载的文件";
}

/** app 里底部一闪而过的小提示（样式跟手机上「已复制单号」那条一样） */
function showToast(text: string): void {
  const toast = document.createElement("div");
  toast.setAttribute("role", "status");
  toast.textContent = text;
  toast.style.cssText = "position:fixed;inset:auto 16px 76px 16px;width:auto;height:auto;margin:0;border:0;overflow:visible;z-index:2147483001;padding:10px 14px;border-radius:6px;background:#1f2420;color:#fff;font-size:13px;line-height:1.5;text-align:center;pointer-events:none;transition:opacity .3s;";
  // 用浏览器的「顶层」显示：导出那个弹窗是 <dialog>.showModal()，也在顶层，z-index 再大也压不过它
  toast.setAttribute("popover", "manual");
  document.body.appendChild(toast);
  try { toast.showPopover(); } catch { /* 老 WebView 不认 popover：照普通 fixed 显示 */ }
  window.setTimeout(() => { toast.style.opacity = "0"; }, 3200);
  window.setTimeout(() => toast.remove(), 3600);
}

/** 存到手机里的位置（手机「文件管理」能翻到） */
const SAVE_FOLDER = "湘泰物流";

/**
 * 把一份文件交给手机：先存一份到手机的「Documents / 湘泰物流」（文件管理里翻得到），
 * 再弹出系统「分享」菜单（发微信 / 用 WPS 打开……）。安卓 10 及更早存不进公共文件夹，就只存 app 自己的缓存再分享。
 */
async function shareFile(base64: Promise<string>, fileName: string): Promise<void> {
  try {
    const name = safeFileName(fileName);
    const data = await base64;
    let uri: string;
    let saved = false;
    try {
      const written = await callNative<{ uri: string }>("Filesystem", "writeFile", { path: `${SAVE_FOLDER}/${name}`, data, directory: "DOCUMENTS", recursive: true });
      uri = written.uri;
      saved = true;
    } catch {
      uri = (await callNative<{ uri: string }>("Filesystem", "writeFile", { path: name, data, directory: "CACHE" })).uri;
    }
    try {
      await callNative("Share", "share", { title: name, files: [uri], dialogTitle: "发送或用别的软件打开" });
    } finally {
      // 分享菜单关了（发出去了或点了取消）再提示存在哪：菜单开着的时候提示被它盖住，人看不到
      if (saved) showToast(`已存到手机：文件管理 → Documents → ${SAVE_FOLDER} → ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 人在分享菜单里点了取消，不算出错
    if (/cancel/i.test(message)) return;
    window.alert(`文件没存成：${message}`);
  }
}

/**
 * 页面造出来的文件（blob:）按网址记下原件。不能事后 fetch(blob:…) 去读：网站的安全规则（next.config.ts 的 CSP，
 * connect-src 只放行本站和 https）会拦，而且不少地方 click 完马上 revokeObjectURL。
 * 收回网址后再留一分钟，够分享那几步用完。
 */
const blobsByUrl = new Map<string, Blob>();

/** 下载链接的内容 → base64；认不出的返回 null（交回给原来的点击） */
export function fileContentOf(href: string): Promise<string> | null {
  if (href.startsWith("blob:")) {
    const blob = blobsByUrl.get(href);
    return blob ? blobToBase64(blob) : null;
  }
  const match = /^data:([^,]*),(.*)$/s.exec(href);
  if (!match) return null;
  if (/;base64$/i.test(match[1])) return Promise.resolve(match[2]);
  const bytes = new TextEncoder().encode(decodeURIComponent(match[2]));
  let binary = "";
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return Promise.resolve(btoa(binary));
}

function installDownloads(): void {
  const originalCreate = URL.createObjectURL.bind(URL);
  const originalRevoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (obj: Blob | MediaSource) => {
    const url = originalCreate(obj);
    if (obj instanceof Blob) blobsByUrl.set(url, obj);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    originalRevoke(url);
    window.setTimeout(() => blobsByUrl.delete(url), 60_000);
  };

  // 导出 Excel（SheetJS 的 XLSX.writeFile）和各页手写的「建一个 <a download> 再 click()」都走这里
  const originalClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function patchedClick(this: HTMLAnchorElement) {
    const content = this.hasAttribute("download") ? fileContentOf(this.href) : null;
    if (content) {
      void shareFile(content, this.download || "下载的文件");
      return;
    }
    return originalClick.call(this);
  };
  // 人手点的 <a download href="data:…">（整柜询价的认证文件）
  document.addEventListener("click", (event) => {
    const link = (event.target as Element | null)?.closest?.("a[download]") as HTMLAnchorElement | null;
    const content = link ? fileContentOf(link.href) : null;
    if (!link || !content) return;
    event.preventDefault();
    void shareFile(content, link.download || "下载的文件");
  }, true);
}

/* ---------------- 2 / 3. 新窗口 → app 里盖一层；里面的打印 → 安卓打印 ---------------- */

let overlay: HTMLDivElement | null = null;

function closeOverlay(): boolean {
  if (!overlay) return false;
  overlay.remove();
  overlay = null;
  return true;
}

function printHtml(html: string): void {
  callNative("XtPrint", "printHtml", { html, jobName: "湘泰物流" }).catch((error) => {
    window.alert(`打印没打开：${error instanceof Error ? error.message : String(error)}`);
  });
}

/** 代替 window.open("")：返回盖在 app 上那层里的 iframe 窗口，调用方照旧往里写内容 */
function openOverlayWindow(): Window | null {
  closeOverlay();
  const wrap = document.createElement("div");
  wrap.className = "xt-app-overlay";
  wrap.setAttribute("role", "dialog");
  wrap.setAttribute("aria-modal", "true");
  wrap.style.cssText = "position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;background:#fff;";

  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;justify-content:flex-end;gap:8px;padding:8px 12px;border-bottom:1px solid #e3e4df;background:#fafaf8;";
  const makeButton = (label: string, onClick: () => void) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    // 行内样式写全：全局 button 默认是赭红底白字，这里要普通白底
    button.style.cssText = "min-height:40px;padding:0 16px;border:1px solid #e3e4df;border-radius:6px;background:#fff;color:#1f2420;font:inherit;font-size:15px;";
    button.addEventListener("click", onClick);
    return button;
  };

  const frame = document.createElement("iframe");
  frame.title = "预览";
  frame.style.cssText = "flex:1;width:100%;border:0;background:#fff;";

  const printButton = makeButton("打印", () => {
    const doc = frame.contentDocument;
    if (doc) printHtml(doc.documentElement.outerHTML);
  });
  printButton.hidden = true; // 内容自己要打印（标签）才露出来，方便再打一次
  bar.append(printButton, makeButton("关闭", closeOverlay));
  wrap.append(bar, frame);
  document.body.appendChild(wrap);
  overlay = wrap;

  const win = frame.contentWindow;
  if (!win) return null;
  // 标签页面末尾那句 window.print()：交给安卓打印。document.write 不会换掉这个窗口对象，覆盖一直有效
  win.print = () => {
    printButton.hidden = false;
    printHtml(win.document.documentElement.outerHTML);
  };
  return win;
}

function installWindowOpen(): void {
  const originalOpen = window.open.bind(window);
  window.open = ((url?: string | URL, target?: string, features?: string) => {
    const href = url == null ? "" : String(url);
    if (href === "" || href === "about:blank") return openOverlayWindow();
    // 外面的网址（快递100 之类）：外壳会交给手机自带的浏览器打开
    return originalOpen(url as string, target, features);
  }) as typeof window.open;
}

/* ---------------- 4. 手机返回键 ---------------- */

function isShown(element: Element): boolean {
  return element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
}

/** 有打开的弹窗 / 左边菜单 / 底部弹出那一小块就先关掉，关了返回 true */
function closeTopLayer(): boolean {
  // 浏览器自带的弹窗（导出 Excel 那个 <dialog>）：直接关；发 Esc 关不掉它（只有真按键才会）
  const nativeDialogs = Array.from(document.querySelectorAll("dialog[open]"));
  if (nativeDialogs.length > 0) {
    (nativeDialogs[nativeDialogs.length - 1] as HTMLDialogElement).close();
    return true;
  }
  const drawer = document.querySelector(".dashboard-sidebar.open");
  if (drawer) {
    (document.querySelector(".sidebar-overlay.open") as HTMLElement | null)?.click();
    return true;
  }
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], .detail-overlay')).filter(isShown);
  if (dialogs.length === 0) return false;
  // 系统里的弹窗都认 Esc（详情弹窗、底部弹出那一小块……）；发到 body 上，往上冒到 document / window 的监听都收得到
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
  return true;
}

function installBackButton(): void {
  const app = capacitor()?.Plugins?.App;
  if (!app?.addListener) return; // 没装就用外壳默认的：能后退就后退，不能就退出
  void app.addListener("backButton", ({ canGoBack }) => {
    if (closeOverlay()) return;
    if (closeTopLayer()) return;
    if (canGoBack) {
      window.history.back();
      return;
    }
    void callNative("App", "minimizeApp").catch(() => undefined);
  });
}

/* ---------------- 5. 键盘弹起来时收起底部那排 ---------------- */

/**
 * app 里键盘弹起来，外壳会把整个网页压到键盘上面（变矮）；这时底部那排常用入口还占着一行，打字的地方就小了。
 * 网页高度比最高时矮了一大截就当键盘开着，给 <html> 挂 xt-keyboard-open（样式在 globals.css 手机那段）。
 */
function installKeyboardWatch(): void {
  let tallest = window.innerHeight;
  const update = () => {
    tallest = Math.max(tallest, window.innerHeight);
    document.documentElement.classList.toggle("xt-keyboard-open", window.innerHeight < tallest - 150);
  };
  window.addEventListener("resize", update);
  // 横竖屏一换，「最高」要重新算
  window.addEventListener("orientationchange", () => { tallest = 0; window.setTimeout(update, 300); });
}

/* ---------------- 6. 打开 app 时已经登录过就直接进工作台 ---------------- */

/**
 * app 每次打开都从网站首页进，首页一律转登录页；登录页「有会话不清、也不自动进」（9-06 起浏览器上就是这样，老板没定要不要自动进）。
 * 浏览器里不动；app 里每次打开都要重新输密码就太别扭了 —— 手里有会话就直接进他那个工作台。
 * 会话其实已经失效的：工作台第一个请求就会 401，照常退回登录页并清掉会话，不会来回跳。
 */
function enterWorkbenchIfLoggedIn(): void {
  if (window.location.pathname !== "/login") return;
  const session = getOptionalSession();
  const home = session ? ROLE_HOME_PATH[session.role] : undefined;
  if (home) window.location.replace(home);
}

let installed = false;

/** 根布局里调一次。不在 app 里直接返回 */
export function installNativeApp(): void {
  if (installed || !isNativeApp()) return;
  installed = true;
  document.documentElement.classList.add("xt-native-app");
  installDownloads();
  installWindowOpen();
  installBackButton();
  installKeyboardWatch();
  enterWorkbenchIfLoggedIn();
}
